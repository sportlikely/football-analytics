// fix263: small reads never wait behind big ones (28 Oct: one-row reads 1.2–1.5 s queued behind MB state parts; slug
// lookups 9–14 s asked of a busy worker; guides read the record on the web thread; /api/nfl/home "Loading" after a
// deploy; the iPhone loader gave up on a slow connection). (1) two reader pools, requests before background loads;
// (2) the worker's whole page list in the web's memory (no page time read from the disk); (3) slug ↔ id for every
// match / player of every season from the web's index, past seasons flagged; (4) guides / news / basketball config /
// the live list as stored strings; (5) every per-sport home / standings key warm; (6) the loader on a slow phone
// network (Chromium; skipped without the frontend build). (dist build) Run: npm run test:fix263
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
const run = (code, env = {}, timeout = 120000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env: { ...process.env, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...env }, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1000)}`);
  return JSON.parse(line.slice(7));
};
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `fix263-${name}-`));
const src = f => fs.readFileSync(path.join(here, '..', 'src', f), 'utf8');
const requireCjs = createRequire(import.meta.url);

/* ---------- (1) two reader pools ---------- */

test('(1) reader pools: a small read never waits behind big ones; a request goes before queued background loads', () => {
  const r = run(`
    const R = require(${JSON.stringify(DIST)} + '/services/pageReader.js');
    (async () => {
      await R.readSql('SELECT 1 AS one'); await R.readSql('SELECT 1 AS one');
      await R.readSql('SELECT 1 AS one', [], false, 'big'); await R.readSql('SELECT 1 AS one', [], false, 'big');
      const slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2500000) SELECT COUNT(*) AS n FROM c";
      const order = [];
      const t0 = Date.now();
      const bg = [1, 2, 3, 4].map(i => R.readSql(slow, [], false, 'big', 'bg').then(() => order.push('bg' + i)));
      const req = R.readSql('SELECT 2 AS two', [], false, 'big', 'req').then(() => order.push('req'));
      // the small pool while both big threads are busy
      const s0 = Date.now();
      for (let i = 0; i < 20; i++) await R.readSql('SELECT ? AS v', [i]);
      const smallMs = Date.now() - s0;
      await Promise.all([...bg, req]);
      // a small-pool read that returned 64 KB or more is counted (it belongs in big)
      await R.readSql("SELECT hex(zeroblob(70000)) AS h");
      console.log('RESULT ' + JSON.stringify({ order, smallMs, totalMs: Date.now() - t0, st: R.pageReaderStatus() }));
      process.exit(0);
    })();
  `);
  console.log(`  small pool: 20 reads in ${r.smallMs} ms while the big pool ran 4 slow reads (${r.totalMs} ms); order ${r.order.join(' → ')}`);
  assert.ok(r.smallMs < r.totalMs / 3, `small reads waited behind the big pool: ${r.smallMs} ms of ${r.totalMs} ms`);
  assert.ok(r.order.indexOf('req') < r.order.indexOf('bg3'), `the request went before the queued background loads: ${r.order}`);
  assert.equal(r.st.pools.small.size, 2);
  assert.equal(r.st.pools.big.size, 2);
  assert.equal(r.st.pools.big.threads, 2);
  assert.ok(r.st.pools.big.maxWaitMs > 0, 'the queue wait is measured');
  assert.ok(r.st.smallOver64 >= 1, 'a 64 KB+ read in the small pool is counted');
  assert.equal(r.st.size, 2, 'the top-level fields stay the small pool (READER_THREADS)');
});

test('(1) wiring: state loads are the big pool\'s background reads; page times the small pool; views by their size', () => {
  const sh = src('services/shared.ts');
  assert.match(sh, /readSql<\{ data: Uint8Array \} \| null>\(PART_SQL, \[key, i, ver\], false, 'big', 'bg'\)/);
  assert.match(sh, /readSql\(ROW_SQL, \[key\], false, 'big', 'bg'\)/);
  const pc = src('services/pageCache.ts');
  assert.match(pc, /readStored\(`\$\{key\}#\$\{v\}`, m\.builtAt, poolForBytes\(viewBytes\(key, v, m\.builtAt\)\)\)/);
  assert.match(src('services/workerRoutes.ts'), /readSql\(COPY_SQL, \[k\], false, poolForBytes\(sizes\.get\(k\)\)\)/);
  assert.match(src('workers/pageReader.ts'), /tuneDb\(db, 'readerSmall', workerData\.readers\)/);
  const { cacheMbFor } = requireCjs(path.join(DIST, 'utils/dbTune.js'));
  assert.equal(cacheMbFor('readerSmall', null), 512); // fix269 (was 64)
  assert.ok(cacheMbFor('reader', 4096, 4) < 1024, 'four reader threads fit the container: scaled');
});

/* ---------- (2) the page list in the web's memory ---------- */

test('(2) the worker sends every stored key (time, view sizes, ETags); the web then reads no page time from the disk', () => {
  const dir = tmp('pages');
  const D = JSON.stringify(DIST);
  // the worker: a few stored pages, then its list (process.send captured)
  const w = run(`
    const sent = [];
    process.send = m => { sent.push(m); return true; };
    Object.defineProperty(process, 'connected', { value: true });
    const { db } = require(${D} + '/db/index.js');
    const P = require(${D} + '/services/pageCache.js');
    db.exec('CREATE INDEX IF NOT EXISTS idx_page_cache_meta ON page_cache(key, built_at, ms, kb)');
    P.definePage({ name: 'p263', freshMs: 3600000, build: q => ({ n: Number(q.n || 0), big: 'x'.repeat(q.n === '2' ? 200000 : 10) }), variants: { full: b => JSON.stringify(b) } });
    (async () => {
      await P.storePage('p263'); await P.storePage('p263', { n: 2 });
      // a key from before this worker (no ETag known here)
      db.prepare("INSERT INTO page_cache (key, json, built_at, ms, etag, kb) VALUES ('p263?n=9', '{}', 1000, 0, NULL, 0)").run();
      sent.length = 0;
      const n = await P.sendPageList();
      console.log('RESULT ' + JSON.stringify({ n, sent: sent.filter(m => m.t === 'page-meta-all') }));
      process.exit(0);
    })();
  `, { DATA_DIR: dir, SL_ROLE: 'worker', PAGE_LIST_DELAY_MS: '999999' });
  assert.equal(w.n, 3, 'three stored keys (views are not keys)');
  const rows = w.sent.flatMap(m => m.rows);
  const byKey = Object.fromEntries(rows.map(r => [r[0], r]));
  assert.deepEqual(Object.keys(byKey).sort(), ['p263', 'p263?n=2', 'p263?n=9']);
  assert.ok(byKey['p263?n=2'][2].full >= 190, `the view's size in KB: ${JSON.stringify(byKey['p263?n=2'][2])}`);
  assert.ok(byKey['p263'][3]?.full, 'the ETag of a build of this worker goes with it');
  assert.equal(byKey['p263?n=9'][3] ?? null, null, 'an ETag the worker does not hold is not read');
  assert.ok(w.sent[w.sent.length - 1].last);
  // the web: the list arrives (a fake worker channel), then pages are read with no time / ETag read
  const r = run(`
    const { EventEmitter } = require('node:events');
    const ipc = require(${D} + '/services/ipc.js');
    const child = new EventEmitter(); child.connected = true; child.send = () => true;
    ipc.attachWorker(child);
    const P = require(${D} + '/services/pageCache.js');
    const R = require(${D} + '/services/pageReader.js');
    P.definePage({ name: 'p263', freshMs: 3600000, build: () => ({}), variants: { full: b => JSON.stringify(b) } });
    (async () => {
      await R.readSql('SELECT 1 AS one'); // the threads up
      const before = P.pageHotStatus().complete;
      for (const m of ${JSON.stringify(w.sent)}) child.emit('message', m);
      const reads0 = R.pageReaderStatus().reads;
      const a = await P.getPage('p263', {}, { views: ['full'], waitMs: 1 });
      const b = await P.getPage('p263', { n: 2 }, { views: ['full'], waitMs: 1 });
      const pools = R.pageReaderStatus().pools;
      const t0 = Date.now();
      const none = await P.getPage('p263', { n: 77 }, { waitMs: 1 });
      const noneMs = Date.now() - t0;
      const reads = R.pageReaderStatus().reads - reads0;
      console.log('RESULT ' + JSON.stringify({ before, hot: P.pageHotStatus(), a: a && a.view('full').text.length, b: b && b.view('full').text.length, none: !!none, noneMs, reads, pools, slow: R.pageReaderStatus().slowLog }));
      process.exit(0);
    })();
  `, { DATA_DIR: dir, SL_ROLE: 'web' });
  assert.equal(r.before, false);
  assert.equal(r.hot.complete, true, `the list is in: ${JSON.stringify(r.hot)}`);
  assert.ok(r.a > 0 && r.b > 190000, 'both views sent');
  assert.equal(r.none, false, 'a key not in the list has no copy');
  assert.ok(r.hot.absent >= 1, 'answered from memory');
  assert.equal(r.reads, 2, `only the two views were read (no built_at / ETag read): ${r.reads}`);
  assert.equal(r.pools.small.reads >= 1 && r.pools.big.reads >= 1, true, `the small view in the small pool, the 200 KB one in the big pool: ${JSON.stringify(r.pools)}`);
});

/* ---------- (3) slugs from the web's index ---------- */

test('(3) slug ↔ id for every season from the web\'s index: out-of-window matches, past seasons 410, unknown ids 404 at once', () => {
  const dir = tmp('slugs');
  const D = JSON.stringify(DIST);
  const env = { DATA_DIR: dir, CANONICAL_HOST: '', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', SITE_PASSWORD: '', BB_GRID: '', THREAD_JOBS: '0' };
  const w = run(`
    const { db } = require(${D} + '/db/index.js');
    for (const m of ['basketball', 'nfl', 'tennis']) require(${D} + '/services/' + m + '.js');
    const slugs = require(${D} + '/services/slugs.js');
    const now = Date.now(), DAY = 86400000, iso = t => new Date(t).toISOString();
    const ins = (sql, ...a) => db.prepare(sql).run(...a);
    // last season (past) and this season, both outside the web's 60-day window
    for (let i = 0; i < 40; i++) {
      const past = i < 20;
      ins("INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (?, 'NBA', 12, ?, ?, 'FT', ?, ?, ?, ?, ?)",
        400000 + i, past ? '2024-2025' : '2025-2026', iso(now - (past ? 400 : 90) * DAY - i * DAY), 800 + i, 'Club' + i + ' Hawks', 900 + i, 'Club' + i + ' Bulls', iso(now));
    }
    slugs.buildSlugs({ full: true }).then(() => {
      // a renamed match: its old slug stays an alias (301 to the new one)
      ins("INSERT INTO slugs (sport, kind, slug, id, is_primary, base, at) VALUES ('basketball', 'match', 'old-hawks-vs-old-bulls-2025-08-01', '400033', 0, NULL, ?)", iso(now));
      return slugs.buildSlugs({ full: true, sports: ['basketball'] });
    }).then(() => {
      const ms = id => db.prepare("SELECT slug FROM slugs WHERE sport = 'basketball' AND kind = 'match' AND id = ? AND is_primary = 1").get(String(id))?.slug;
      console.log('RESULT ' + JSON.stringify({ past: ms(400003), cur: ms(400033), team: db.prepare("SELECT slug FROM slugs WHERE sport = 'basketball' AND kind = 'team' LIMIT 1").get()?.slug }));
      process.exit(0);
    });
  `, { ...env, SL_ROLE: 'worker' }, 180000);
  assert.ok(w.past && w.cur && w.team, JSON.stringify(w));
  const r = run(`
    const { app } = require(${D} + '/app.js');
    const shared = require(${D} + '/services/shared.js');
    const readiness = require(${D} + '/services/readiness.js');
    const slugs = require(${D} + '/services/slugs.js');
    (async () => {
      readiness.markReady({ loadMs: 0, states: 0 });
      await shared.loadNewerStates(true);
      const s = app.listen(0, '127.0.0.1');
      await new Promise(r => s.once('listening', r));
      const base = 'http://127.0.0.1:' + s.address().port;
      const open = async url => { const t0 = performance.now(); const r = await fetch(base + url, { redirect: 'manual' }); const text = await r.text(); return { status: r.status, ms: Math.round(performance.now() - t0), body: text.slice(0, 300) }; };
      for (let i = 0; i < 3; i++) await open('/api/slug/basketball/match/${w.cur}'); // warm-up
      const out = {
        cur: await open('/api/slug/basketball/match/${w.cur}'),
        past: await open('/api/slug/basketball/match/${w.past}'),
        ofCur: await open('/api/slug-of/basketball/match/400033'),
        ofLeague: await open('/api/slug-of/football/league/AF143'),
        ofTeam: await open('/api/slug-of/basketball/team/123456789'),
        unknownTeam: await open('/api/slug/basketball/team/no-such-team-here'),
        alias: await open('/api/slug/basketball/match/old-hawks-vs-old-bulls-2025-08-01'),
        unknownMatch: await open('/api/slug/basketball/match/no-such-game-2026-01-01'),
        pastFlag: slugs.pastMatch('basketball', '400003'), curFlag: slugs.pastMatch('basketball', '400033'),
        knows: [slugs.webKnowsAll('basketball', 'league', 'NBA'), slugs.webKnowsAll('football', 'team', '86'), slugs.webKnowsSlug('basketball', 'match')]
      };
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `, { ...env, SL_ROLE: 'web', SL_STRICT_WEB: '1', PAGE_WAIT_MS: '1' });
  // the web has no worker here: an answer that needed it would be 503 / 202
  assert.equal(r.cur.status, 200, JSON.stringify(r.cur));
  assert.match(r.cur.body, /"id":"400033"/);
  assert.equal(r.past.status, 410, `a past season's match: ${JSON.stringify(r.past)}`);
  assert.equal(r.ofCur.status, 200);
  assert.equal(r.alias.status, 200, `a renamed match's old slug: ${JSON.stringify(r.alias)}`);
  assert.match(r.alias.body, new RegExp(`"id":"400033","slug":"${w.cur}"`), 'the alias answers the id and the new slug');
  assert.equal(r.ofLeague.status, 404, `a league with no slug: answered by the web (${JSON.stringify(r.ofLeague)})`);
  assert.equal(r.ofTeam.status, 404);
  assert.equal(r.unknownTeam.status, 404);
  assert.match(r.unknownTeam.body, /"search":"\/search\?q=no%20such%20team%20here"/);
  assert.notEqual(r.unknownMatch.status, 200, 'a match slug never given still asks the worker (no worker here: not found / waiting)');
  for (const k of ['cur', 'past', 'ofCur', 'ofLeague', 'ofTeam', 'unknownTeam']) assert.ok(r[k].ms < 50, `${k}: ${r[k].ms} ms (target < 20 ms on the server)`);
  assert.equal(r.pastFlag, true);
  assert.equal(r.curFlag, false);
  assert.deepEqual(r.knows, [true, false, true], 'an old Football-Data.org team id still asks the worker (it matches the name)');
  console.log(`  slug answers: ${['cur', 'past', 'ofCur', 'ofLeague', 'ofTeam', 'unknownTeam'].map(k => `${k} ${r[k].status} ${r[k].ms} ms`).join(' · ')}`);
});

test('(3) pastSeasonIds follows isPastSeasonMatch (football AF + FD, basketball, NFL, tennis)', () => {
  const dir = tmp('past');
  const r = run(`
    const D = ${JSON.stringify(DIST)};
    const { db } = require(D + '/db/index.js');
    for (const m of ['basketball', 'nfl', 'tennis', 'afMatches', 'tracking']) { try { require(D + '/services/' + m + '.js'); } catch {} }
    const P = require(D + '/services/pastSeason.js');
    const ins = (sql, ...a) => { try { db.prepare(sql).run(...a); return true; } catch (e) { return String(e.message); } };
    ins("INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (1, 'NBA', 12, '2024-2025', '2025-01-01', 'FT', 1, 'a', 2, 'b', 'x'), (2, 'NBA', 12, '2025-2026', '2025-11-01', 'FT', 1, 'a', 2, 'b', 'x'), (3, 'BSN', 9, '2026', '2026-05-01', 'FT', 1, 'a', 2, 'b', 'x')");
    ins("INSERT INTO nfl_games (game_id, season, week, kickoff, home_id, home_name, away_id, away_name, status, league, updated_at) VALUES (10, 2024, '1', '2024-09-08', 1, 'a', 2, 'b', 'FT', 1, 'x'), (11, 2025, '1', '2025-09-08', 1, 'a', 2, 'b', 'FT', 1, 'x')");
    ins("INSERT INTO tennis_matches (id, tournament, tour, tier, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (20, 'x', 'atp', 't', '2025-03-01', 'finished', 1, 'a', 2, 'b', 'live', 'x'), (21, 'x', 'atp', 't', '2026-03-01', 'finished', 1, 'a', 2, 'b', 'live', 'x')");
    const out = {};
    for (const sp of ['basketball', 'american-football', 'tennis', 'football']) {
      const set = P.pastSeasonIds(sp);
      const ids = sp === 'basketball' ? [1, 2, 3] : sp === 'american-football' ? [10, 11] : sp === 'tennis' ? [20, 21] : [];
      out[sp] = ids.map(id => [id, set.has(id), P.isPastSeasonMatch(sp, id)]);
    }
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);
  `, { DATA_DIR: dir, SL_ROLE: 'worker' });
  for (const [sp, rows] of Object.entries(r)) for (const [id, bulk, one] of rows) assert.equal(bulk, one, `${sp} ${id}: bulk ${bulk}, one by one ${one}`);
  assert.deepEqual(r.basketball.map(x => x[1]), [true, false, false]);
  assert.deepEqual(r['american-football'].map(x => x[1]), [true, false]);
  assert.deepEqual(r.tennis.map(x => x[1]), [true, false]);
});

/* ---------- (4) stored strings ---------- */

test('(4) guides, news, the basketball config and the live list are stored strings the web only sends', () => {
  const a = src('app.ts');
  for (const name of ['guides', 'guide', 'news', 'bb-config']) assert.match(a, new RegExp(`definePage\\(\\{\\s*name: '${name}'`), `${name} is a stored page`);
  assert.match(a, /await sendStored\(req, res, 'guide', \{ slug \}, 'full'\)/);
  assert.match(a, /await sendStored\(req, res, 'bb-config', \{\}, req\.access === 'admin' \? 'admin' : 'full'\)/);
  assert.match(a, /const STORED_OR_WORKER = new Set\(\['guides', 'guide', 'news', 'bb-config'\]\)/);
  assert.doesNotMatch(a.slice(a.indexOf("app.get('/api/guides/:slug'"), a.indexOf("app.get('/api/guides/:slug'") + 600), /getGuide\(/, 'the web never renders a guide');
  const D = JSON.stringify(DIST);
  const r = run(`
    const { EventEmitter } = require('node:events');
    const ipc = require(${D} + '/services/ipc.js');
    const child = new EventEmitter(); child.connected = true; child.send = () => true;
    ipc.attachWorker(child);
    const L = require(${D} + '/services/liveState.js');
    const W = require(${D} + '/services/workerRoutes.js');
    child.emit('message', { t: 'live', sport: 'football', ids: [7, 5], changed: [5, 7], gone: [], rows: [[5, '{"id":5,"s":"1-0"}'], [7, '{"id":7,"s":"0-0"}']] });
    const first = L.liveListText('football');
    child.emit('message', { t: 'live', sport: 'football', ids: [5], changed: [], gone: [7], rows: [] });
    const second = L.liveListText('football');
    const q = (query) => ({ path: '/api/news', query });
    console.log('RESULT ' + JSON.stringify({ first, second, list: L.liveList('football'), news: [W.newsIsStored(q({ sport: 'basketball', limit: '10' })), W.newsIsStored(q({ league: 'PL', limit: '12' })), W.newsIsStored(q({ team: 'Arsenal' })), W.newsIsStored(q({ teamId: '3' }))] }));
    process.exit(0);
  `, { DATA_DIR: tmp('live'), SL_ROLE: 'web' });
  assert.match(r.first, /^\{"data":\[\{"id":7,"s":"0-0"\},\{"id":5,"s":"1-0"\}\],"count":2,"timestamp":"/, 'the worker\'s order, its own JSON');
  assert.match(r.second, /^\{"data":\[\{"id":5,"s":"1-0"\}\],"count":1,/);
  assert.equal(r.list.length, 1);
  assert.deepEqual(r.news, [true, true, false, false], 'a team\'s news stays a worker route');
});

/* ---------- (5) the warm set ---------- */

test('(5) every per-sport home / standings key is warm; a key never stored stands in with the nearest one', () => {
  const r = run(`
    const P = require(${JSON.stringify(DIST)} + '/services/pageCache.js');
    require(${JSON.stringify(DIST)} + '/app.js');
    const { BB_LEAGUES } = require(${JSON.stringify(DIST)} + '/services/basketball.js');
    console.log('RESULT ' + JSON.stringify({ warm: P._warmKeys ? P._warmKeys() : null, bb: BB_LEAGUES.map(l => l.code), nflFb: P.fallbackQuery('nfl-home', { league: '2', full: 1 }), tnFb: P.fallbackQuery('tennis-home', { tour: 'wta', full: 0 }), newsFb: P.fallbackQuery('news', { sport: 'football', league: 'PL', limit: 12 }) }));
    process.exit(0);
  `, { DATA_DIR: tmp('warm'), SL_ROLE: 'worker', TENNIS_PUBLIC: '1', PAGE_LIST_DELAY_MS: '999999' });
  const w = new Set(r.warm);
  for (const k of ['nfl-home?full=0', 'nfl-home?full=1', 'nfl-home?full=0&league=1', 'nfl-home?full=1&league=1', 'nfl-home?full=0&league=2', 'nfl-home?full=1&league=2']) assert.ok(w.has(k), `${k} warm`);
  for (const c of r.bb) assert.ok(w.has(`bb-standings?code=${c}`), `bb-standings ${c} warm`);
  for (const t of ['all', 'atp', 'wta', 'challenger']) assert.ok(w.has(`tennis-home?full=0&tour=${t}`), `tennis-home ${t} warm`);
  for (const k of ['guides', 'bb-config', 'news?limit=10&sport=football', 'news?league=NCAA&limit=10&sport=american-football']) assert.ok(w.has(k), `${k} warm`);
  assert.deepEqual(r.nflFb, { full: 1 });
  assert.deepEqual(r.tnFb, { tour: 'all', full: 0 });
  assert.deepEqual(r.newsFb, { sport: 'football', limit: 10 });
});

/* ---------- (6) the loader on a slow phone network ---------- */

const distIndex = path.join(here, '../../frontend/dist/index.html');
test('(6) the loader on a slow phone network (40 KB/s, 600 ms): the shell first, the app on screen, no reload, no card', { skip: !fs.existsSync(distIndex) && 'no frontend build' }, async () => {
  const html = fs.readFileSync(distIndex, 'utf8');
  assert.match(html, /<div id="sl-shell"/, 'the shell is in the page');
  assert.doesNotMatch(html, /setTimeout\(function \(\) \{ fail\('app file not started after 6 s'\); \}, 6000\)/, 'no 6-s cap');
  const { runSlowLoader } = await import('./slow-loader.mjs');
  let r;
  try { r = await runSlowLoader(); } catch (e) {
    if (/Executable doesn't exist|browserType\.launch/.test(String(e?.message))) return void console.log('  (no browser here: skipped)');
    throw e;
  }
  console.log(`  ${r.browser}: shell at ${r.shellMs} ms, app on screen at ${r.mountedMs} ms, page loads ${r.pageLoads}, card ${r.card}, reports ${r.reports.length}`);
  assert.ok(r.pass, JSON.stringify(r));
});

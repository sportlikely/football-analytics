// fix210: the web process never builds a page. Run: npm run test:fix210 (after tsc)
//  - every public GET route (PUBLIC_ROUTES in services/workerRoutes.ts, kept complete by `npm run parity`) and the
//    crawler pages of every sport and language are opened in a real web-role process (no worker) with SL_STRICT_WEB=1:
//    a page builder called there throws, and every database statement is timed
//  - fails when a builder ran, a handler took over 50 ms (second request, so module loading is not counted), or a
//    worker route was answered by the web process instead of being passed on (no worker here: 503)
//  - uses a copy of the newest database snapshot in backend/data (sportlikely-*.sqlite) when there is one, else an
//    empty database
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const DATA = path.join(here, '../data');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const LIMIT_MS = 50;

/**
 * fix210b: real old ids from the copy (an early finished basketball game, the most-used football player, an NFL game,
 * a tennis player / match …) for the crawler pages in every language; fixed ids when the copy has no such table
 */
function realIds(dir) {
  const ids = { bbGame: 1, bbTeam: 1, bbPlayer: 1, fbPlayer: 276, fbTeam: 33, fbMatch: 1, nflGame: 1, nflTeam: 1, tnPlayer: 1, tnMatch: 1 };
  const f = path.join(dir, 'bet-to-beat.sqlite');
  if (!fs.existsSync(f)) return ids;
  const db = new DatabaseSync(f, { readOnly: true });
  const one = (sql, k) => { try { const r = db.prepare(sql).get(); if (r && r.v != null) ids[k] = r.v; } catch { /* table missing */ } };
  one(`SELECT game_id AS v FROM bb_games WHERE status IN ('FT','AOT') ORDER BY kickoff LIMIT 1 OFFSET 200`, 'bbGame');
  one(`SELECT home_id AS v FROM bb_games WHERE status IN ('FT','AOT') ORDER BY kickoff LIMIT 1 OFFSET 200`, 'bbTeam');
  one(`SELECT player_id AS v FROM bb_player_stats LIMIT 1 OFFSET 500`, 'bbPlayer');
  one(`SELECT player_id AS v FROM af_player_season ORDER BY apps DESC LIMIT 1`, 'fbPlayer');
  one(`SELECT match_id AS v FROM predictions WHERE settled = 1 ORDER BY utc_date LIMIT 1 OFFSET 100`, 'fbMatch');
  one(`SELECT home_team_id AS v FROM predictions WHERE settled = 1 AND home_team_id IS NOT NULL ORDER BY utc_date LIMIT 1 OFFSET 100`, 'fbTeam');
  one(`SELECT game_id AS v FROM nfl_games WHERE status IN ('FT','AOT') ORDER BY kickoff LIMIT 1 OFFSET 50`, 'nflGame');
  one(`SELECT team_id AS v FROM nfl_teams LIMIT 1`, 'nflTeam');
  one(`SELECT id AS v FROM tennis_players LIMIT 1 OFFSET 100`, 'tnPlayer');
  one(`SELECT id AS v FROM tennis_matches LIMIT 1 OFFSET 1000`, 'tnMatch');
  db.close();
  return ids;
}
const LANG_PREFIX = ['', '/es', '/pt', '/de', '/fr', '/it', '/tr'];
const crawlerUrls = ids => [
  ...LANG_PREFIX.map(l => `${l}/basketball/game/${ids.bbGame}`),
  ...LANG_PREFIX.map(l => `${l}/player/${ids.fbPlayer}`),
  ...LANG_PREFIX.map(l => `${l}/match/${ids.fbMatch}`),
  `/team/${ids.fbTeam}`, `/fr/team/${ids.fbTeam}`, `/basketball/team/${ids.bbTeam}`, `/de/basketball/player/${ids.bbPlayer}`,
  `/american-football/game/${ids.nflGame}`, `/american-football/team/${ids.nflTeam}`,
  `/tennis/player/${ids.tnPlayer}`, `/it/tennis/player/${ids.tnPlayer}`, `/tennis/match/${ids.tnMatch}`
];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix210-'));
  const snap = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(f => /^sportlikely-.*\.sqlite$/.test(f)).sort().pop() : null;
  if (snap) fs.copyFileSync(path.join(DATA, snap), path.join(dir, 'bet-to-beat.sqlite'));
  const stat = path.join(dir, 'static');
  fs.mkdirSync(stat);
  fs.writeFileSync(path.join(stat, 'index.html'), '<!doctype html><html lang="en"><head><title>SportLikely</title></head><body><div id="root"></div></body></html>');
  return { dir, stat, snap };
}

// the child: the whole app as the web process, every sample twice, the second one timed
const CHILD = `
const D = ${JSON.stringify(DIST)};
const { db } = require(D + '/db/index.js');
// the database timer: every statement's run / get / all, added to the request in flight
let dbMs = 0;
const prep = db.prepare.bind(db);
db.prepare = sql => {
  const st = prep(sql);
  const wrap = f => (...a) => { const t = process.hrtime.bigint(); try { return f(...a); } finally { dbMs += Number(process.hrtime.bigint() - t) / 1e6; } };
  return { run: wrap(st.run.bind(st)), get: wrap(st.get.bind(st)), all: wrap(st.all.bind(st)), iterate: st.iterate && st.iterate.bind(st) };
};
const { app } = require(D + '/app.js');
// fix214: the web process answers 503 until its shared state is loaded (fix212b): without this every URL was a 503
require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
const { webBuilds } = require(D + '/services/builders.js');
const { PUBLIC_ROUTES, PAGE_SAMPLES, workerRouteOf } = require(D + '/services/workerRoutes.js');
const role = require(D + '/services/role.js');
const server = app.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const builds = () => Object.values(webBuilds()).reduce((n, c) => n + c.n, 0);
  const open = async url => {
    const b0 = builds(); dbMs = 0;
    const t0 = process.hrtime.bigint();
    const r = await fetch(base + url, { headers: { 'User-Agent': 'Mozilla/5.0 (fix210 test)', Accept: 'application/json,text/html' } });
    await r.arrayBuffer();
    return { status: r.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), dbMs: Math.round(dbMs), built: builds() - b0 };
  };
  const out = [];
  const extra = JSON.parse(process.env.EXTRA_URLS || '[]');
  const samples = [...PUBLIC_ROUTES.map(r => ({ url: r.sample, by: r.by, sport: r.sport })), ...[...PAGE_SAMPLES, ...extra].map(url => ({ url, by: 'page', sport: 'all' }))];
  for (const s of samples) {
    const first = await open(s.url);
    const second = await open(s.url);
    out.push({ ...s, onWorker: !!workerRouteOf(s.url.split('?')[0]), first, second });
  }
  console.log(JSON.stringify({ isWeb: role.isWeb, builds: webBuilds(), out }));
  process.exit(0);
});
`;

test('the web process builds nothing: every public route and crawler page', () => {
  const { dir, stat, snap } = scratch();
  const env = { ...process.env, EXTRA_URLS: JSON.stringify(crawlerUrls(realIds(dir))), DATA_DIR: dir, STATIC_DIR: stat, SL_ROLE: 'web', SL_STRICT_WEB: '1', PAGE_WAIT_MS: '1', SEO_WAIT_MS: '1', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1' };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['-e', CHILD], { env, encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  const res = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(res.isWeb, true, 'the child is not a web process');
  const bad = [];
  for (const x of res.out) {
    if (x.first.built || x.second.built) bad.push(`${x.url}: a page builder ran in the web process`);
    if (x.second.ms > LIMIT_MS) bad.push(`${x.url}: ${x.second.ms} ms (database ${x.second.dbMs} ms) — over ${LIMIT_MS} ms`);
    if (x.by === 'worker' && x.second.status !== 503) bad.push(`${x.url}: answered ${x.second.status} by the web process (a worker route: it must be passed on)`);
    if (x.by !== 'worker' && x.onWorker) bad.push(`${x.url}: listed as ${x.by} but matched by WORKER_ROUTES`);
  }
  const slowest = [...res.out].sort((a, b) => b.second.ms - a.second.ms).slice(0, 5).map(x => `${x.url} ${x.second.ms} ms`);
  console.log(`no-web-compute: ${res.out.length} URLs on ${snap ? `a copy of ${snap}` : 'an empty database'}; slowest: ${slowest.join(', ')}`);
  assert.deepEqual(bad, [], `\n${bad.join('\n')}\nbuilders called: ${JSON.stringify(res.builds)}`);
  assert.deepEqual(res.builds, {});
});

test('basketball game pages: the worker stores one data build per game, the web process writes every language from it', () => {
  const { dir, stat } = scratch();
  const ids = realIds(dir);
  const base = { ...process.env, DATA_DIR: dir, STATIC_DIR: stat, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', BASKETBALL_PUBLIC: '1' };
  for (const k of KEYS) base[k] = '';
  // the worker: the prebuild job (every finished game of the two latest seasons) — here only this game, then the job itself
  const w = spawnSync(process.execPath, ['-e', `
    const D = ${JSON.stringify(DIST)};
    require(D + '/app.js');
    const pc = require(D + '/services/pageCache.js');
    pc.storePage('bb-game-facts', { id: ${ids.bbGame} }).then(() => { console.log(JSON.stringify({ at: pc.storedAt('bb-game-facts', { id: ${ids.bbGame} }) })); process.exit(0); });`], { env: { ...base, SL_ROLE: 'worker' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(w.status, 0, w.stderr);
  assert.ok(JSON.parse(w.stdout.trim().split('\n').pop()).at > 0, 'the facts were not stored');
  const r = spawnSync(process.execPath, ['-e', `
    const D = ${JSON.stringify(DIST)};
    const { app } = require(D + '/app.js');
    require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
    const { webBuilds } = require(D + '/services/builders.js');
    const s = app.listen(0, '127.0.0.1', async () => {
      const out = [];
      for (const l of ${JSON.stringify(LANG_PREFIX)}) {
        const url = 'http://127.0.0.1:' + s.address().port + l + '/basketball/game/${ids.bbGame}';
        await fetch(url).then(x => x.text());
        const t0 = Date.now(); const html = await fetch(url).then(x => x.text());
        out.push({ l, ms: Date.now() - t0, vs: html.includes('<h1>') && html.includes(' vs '), lang: (html.match(new RegExp('<html lang="([a-z]+)"')) || [])[1] });
      }
      console.log(JSON.stringify({ out, builds: webBuilds() })); process.exit(0);
    });`], { env: { ...base, SL_ROLE: 'web', SL_STRICT_WEB: '1', SEO_WAIT_MS: '1' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(res.builds, {});
  for (const x of res.out) {
    assert.ok(x.vs, `${x.l || '/'}: no game heading (the stored facts were not used)`);
    assert.equal(x.lang, x.l ? x.l.slice(1) : 'en');
    assert.ok(x.ms < 50, `${x.l || '/'}: ${x.ms} ms`);
  }
});

// fix214: the web stalls named "/match/* + /basketball/* + /team/* + /<lang>/*": the crawler pages as production serves
// them — a stored copy exists (the worker built it), the web process reads it and only fills index.html. Real ids,
// every language; the first open reads the stored row (not this process's memory), the second the memory copy.
test('crawler pages with a stored copy: served from page_cache, no build, under 50 ms, real HTML', () => {
  const { dir, stat } = scratch();
  const ids = realIds(dir);
  const urls = [
    ...LANG_PREFIX.map(l => `${l}/match/${ids.fbMatch}`), ...LANG_PREFIX.map(l => `${l}/basketball/game/${ids.bbGame}`),
    `/team/${ids.fbTeam}`, `/fr/team/${ids.fbTeam}`, `/pt/team/${ids.fbTeam}`, `/basketball/team/${ids.bbTeam}`, `/es/basketball/team/${ids.bbTeam}`,
    `/de/basketball/player/${ids.bbPlayer}`, `/player/${ids.fbPlayer}`, `/american-football/game/${ids.nflGame}`, `/tennis/player/${ids.tnPlayer}`
  ];
  const base = { ...process.env, DATA_DIR: dir, STATIC_DIR: stat, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1' };
  for (const k of KEYS) base[k] = '';
  const w = spawnSync(process.execPath, ['-e', `
    const D = ${JSON.stringify(DIST)};
    require(D + '/app.js');
    const pc = require(D + '/services/pageCache.js');
    (async () => {
      for (const u of ${JSON.stringify(urls)}) {
        const bb = /^(?:\\/[a-z]{2})?\\/basketball\\/game\\/(\\d+)$/.exec(u);
        if (bb) await pc.storePage('bb-game-facts', { id: Number(bb[1]) }); else await pc.storePage('seo-page', { path: u });
      }
      process.exit(0);
    })();`], { env: { ...base, SL_ROLE: 'worker' }, encoding: 'utf8', timeout: 180000 });
  assert.equal(w.status, 0, w.stderr);
  const r = spawnSync(process.execPath, ['-e', `
    const D = ${JSON.stringify(DIST)};
    const { app } = require(D + '/app.js');
    require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
    const { webBuilds } = require(D + '/services/builders.js');
    const s = app.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + s.address().port, out = [];
      const open = async u => { const t0 = process.hrtime.bigint(); const x = await fetch(base + u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } }); const html = await x.text(); return { status: x.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, h1: html.includes('<h1>'), lang: (html.match(/<html lang="([a-z]+)"/) || [])[1] }; };
      for (const u of ${JSON.stringify(urls)}) out.push({ u, first: await open(u), second: await open(u) });
      console.log(JSON.stringify({ out, builds: webBuilds() })); process.exit(0);
    });`], { env: { ...base, SL_ROLE: 'web', SL_STRICT_WEB: '1', SEO_WAIT_MS: '1', PAGE_WAIT_MS: '1' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(res.builds, {}, 'a page builder ran in the web process');
  const bad = [];
  for (const x of res.out) {
    const lang = (/^\/(es|pt|de|fr|it|tr)\//.exec(x.u) || [])[1] || 'en';
    for (const k of ['first', 'second']) {
      if (x[k].status !== 200) bad.push(`${x.u} (${k}): ${x[k].status}`);
      if (x[k].ms > LIMIT_MS) bad.push(`${x.u} (${k}): ${x[k].ms} ms — over ${LIMIT_MS} ms`);
    }
    // (an NFL / tennis id the copy has no such game / player for falls back to the generic page)
    if (!x.second.h1 && !(/american-football|tennis/.test(x.u) && /\/1$/.test(x.u))) bad.push(`${x.u}: no <h1> (the stored copy was not used)`);
    if (x.second.lang !== lang) bad.push(`${x.u}: <html lang="${x.second.lang}">, not ${lang}`);
  }
  console.log(`stored crawler pages: ${res.out.length} URLs, slowest ${[...res.out].sort((a, b) => b.first.ms - a.first.ms).slice(0, 3).map(x => `${x.u} ${x.first.ms} ms`).join(', ')}`);
  assert.deepEqual(bad, [], `\n${bad.join('\n')}`);
});

test('the real pair: a worker route is answered by the worker, then served from the signed-out copy; a worker crash is recorded', async () => {
  const port = 41000 + Math.floor(Math.random() * 500);
  const { dir } = scratch();
  const env = { ...process.env, DATA_DIR: dir, PORT: String(port), WORKER_PORT: String(port + 1), API_READ_TOKEN: 'fix210-test', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', CANONICAL_HOST: '', WORKER: '', SL_STRICT_WEB: '1' };
  for (const k of KEYS) env[k] = '';
  delete env.SL_ROLE;
  const { spawn } = await import('node:child_process');
  const web = spawn(process.execPath, [path.join(here, '../dist/index.js')], { env, stdio: 'ignore' });
  const get = async p => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, copy: r.headers.get('x-sl-copy'), text: await r.text() }; } catch { return { status: 0, copy: null, text: '' }; } };
  const until = async (fn, ms) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 250)); } };
  const perf = async () => JSON.parse((await get('/api/perf?token=fix210-test')).text).data;
  try {
    assert.ok(await until(async () => (await get('/api/health')).status === 200, 20000), 'the web process never answered');
    assert.ok(await until(async () => (await perf()).worker.on, 30000), 'the worker never started');
    // first request: built by the worker (passed on), kept; second: the kept copy, from the web process
    const first = await until(async () => { const r = await get('/api/how-it-works/football'); return r.status === 200 ? r : null; }, 60000);
    assert.ok(first, 'the worker never answered the worker route');
    assert.equal(first.copy, 'new');
    const second = await get('/api/how-it-works/football');
    assert.equal(second.status, 200);
    assert.equal(second.copy, 'fresh');
    assert.equal(second.text, first.text);
    const p = await perf();
    assert.deepEqual(p.webBuilds, {}, 'the web process built a page');
    assert.ok(p.workerRoutes.forwarded >= 1 && p.workerRoutes.served >= 1);
    assert.ok(p.memory.worker.heapMb > 0 && Array.isArray(p.hours));
    // the worker dies: the exit is recorded with a reason and it comes back after 5 s
    const pid = p.worker.pid;
    process.kill(pid, 'SIGKILL');
    // (the exit row is written by the new worker: the web process queues its writes, fix210b)
    const back = await until(async () => { const q = await perf(); return q.worker.on && q.worker.pid !== pid && q.worker.restarts24h === 1 ? q : null; }, 30000);
    assert.ok(back, 'the worker did not come back');
    assert.equal(back.worker.restarts, 1);
    assert.equal(back.worker.restarts24h, 1);
    assert.ok(back.worker.lastExit?.reason, 'no exit reason');
    assert.ok(Array.isArray(back.worker.lastExit.stderr));
  } finally {
    web.kill('SIGKILL');
  }
});

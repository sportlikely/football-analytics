// fix243: (1) past seasons' match pages are admin-only — 410 + noindex for everyone else (every sport, any language
// prefix, the page, its tabs, the game APIs and the slug lookup), out of the sitemaps and the search-engine HTML, and
// the app's season list for its links; (2) a bot's page render takes a slot (at most 4 at a time, 16 waiting, then
// 503) and never a browser's; (3) a stored page's time and ETag come from the covering index (never the page's text),
// and the views a request sends are read in the reader thread, not on the web thread. (dist build) Run: npm run test:fix243
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const baseEnv = () => {
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fix243-')), NODE_ENV: 'production', LOG_LEVEL: 'error', THREAD_JOBS: '0' };
  for (const k of KEYS) delete env[k];
  return env;
};
const run = (code, env, timeout = 120000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1500)}`);
  return JSON.parse(line.slice(7));
};

/* data: two seasons of every sport (ids 501 = past, 502 = this season) */
const SEED = `
  const { db } = require('${DIST}/db/index.js');
  const now = new Date(), iso = d => new Date(d).toISOString();
  const thisYear = now.getUTCFullYear();
  const ins = (sql, ...a) => db.prepare(sql).run(...a);
  // basketball: NBA 2024-2025 (past) and 2026-2027
  ins(\`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (501, 'NBA', 12, '2024-2025', ?, 'FT', 1, 'Old Home', 2, 'Old Away', 100, 90, ?)\`, iso(now.getTime() - 400 * 864e5), iso(now));
  ins(\`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (502, 'NBA', 12, '2026-2027', ?, 'FT', 1, 'Old Home', 3, 'New Away', 101, 99, ?)\`, iso(now.getTime() - 2 * 864e5), iso(now));
  // BSN (calendar season) 2026 alone: still its latest season — current
  ins(\`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (503, 'BSN', 99, '2026', ?, 'FT', 7, 'Bsn A', 8, 'Bsn B', 80, 70, ?)\`, iso(now.getTime() - 120 * 864e5), iso(now));
  // football (API-Football ids = 1e9 + fixture): league 39 seasons 2025 (past) and 2026
  const af = (id, season, d) => ins(\`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status) VALUES (?, 39, ?, 'E', 'E0', ?, ?, 10, 11, 'Fb Home', 'Fb Away', 'FT')\`, id, season, iso(d), iso(d).slice(0, 10));
  af(501, 2025, now.getTime() - 300 * 864e5); af(502, 2026, now.getTime() - 3 * 864e5);
  // NFL: seasons 2025 (past) and 2026
  const nfl = (id, season, d) => ins(\`INSERT INTO nfl_games (game_id, season, kickoff, home_id, home_name, away_id, away_name, status, updated_at, league) VALUES (?, ?, ?, 20, 'Nfl Home', 21, 'Nfl Away', 'FT', ?, 1)\`, id, season, iso(d), iso(now));
  nfl(501, 2025, now.getTime() - 330 * 864e5); nfl(502, thisYear, now.getTime() - 5 * 864e5);
  // tennis: last year (past) and this year
  const tn = (id, d) => ins(\`INSERT INTO tennis_matches (id, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (?, ?, 'finished', 30, 'Tn One', 31, 'Tn Two', 'test', ?)\`, id, iso(d), iso(now));
  tn(501, Date.UTC(thisYear - 1, 5, 1)); tn(502, now.getTime() - 864e5);
  // slugs
  for (const [sport, id, slug] of [['basketball', 501, 'old-home-vs-old-away-2025-09-01'], ['basketball', 502, 'old-home-vs-new-away-2026-10-24'], ['basketball', 503, 'bsn-a-vs-bsn-b-2026-06-28'],
    ['football', 1000000501, 'fb-home-vs-fb-away-2025-12-30'], ['football', 1000000502, 'fb-home-vs-fb-away-2026-10-23'],
    ['american-football', 501, 'nfl-home-vs-nfl-away-2025-12-01'], ['american-football', 502, 'nfl-home-vs-nfl-away-2026-10-21'],
    ['tennis', 501, 'tn-one-vs-tn-two-2025-06-01'], ['tennis', 502, 'tn-one-vs-tn-two-2026-10-25']])
    ins(\`INSERT OR REPLACE INTO slugs (sport, kind, slug, id, is_primary, at) VALUES (?, 'match', ?, ?, 1, ?)\`, sport, slug, String(id), iso(now));
`;

test('past seasons: the rule per sport, the app\'s season list, sitemaps and crawler HTML without them', () => {
  const env = baseEnv();
  const r = run(`
    require('${DIST}/services/basketball.js'); require('${DIST}/services/apiFootball.js'); require('${DIST}/services/nfl.js'); require('${DIST}/services/tennis.js'); require('${DIST}/services/slugs.js');
    ${SEED}
    const P = require('${DIST}/services/pastSeason.js');
    const seo = require('${DIST}/services/seo.js');
    const out = {};
    for (const [sport, a, b] of [['basketball', 501, 502], ['football', 1000000501, 1000000502], ['american-football', 501, 502], ['tennis', 501, 502]])
      out[sport] = [P.isPastSeasonMatch(sport, a), P.isPastSeasonMatch(sport, b), P.isPastSeasonMatch(sport, 999999)];
    out.bsn = P.isPastSeasonMatch('basketball', 503);
    out.seasons = { bb: P.seasonStarts('basketball'), tn: P.seasonStarts('tennis'), fb: P.seasonStarts('football') };
    out.html = seo.unlinkPast('<p><a href="/basketball/game/501">old</a> · <a href="/es/basketball/game/502">new</a> · <a href="/match/1000000501">fb old</a> · <a href="/team/5">team</a></p>');
    console.log('RESULT ' + JSON.stringify(out));
    process.exit(0);
  `, env);
  for (const s of ['basketball', 'football', 'american-football', 'tennis']) assert.deepEqual(r[s], [true, false, false], `${s}: past / this season / unknown`);
  assert.equal(r.bsn, false, 'a calendar-season league (BSN 2026) is current until its next season starts');
  // the app's list: per team the day its current season began; the latest of them = d
  const bb = r.seasons.bb;
  assert.equal(bb.v, 1);
  const startOf = id => Object.entries(bb.s).find(([, ids]) => ids.split(',').includes(String(id)))?.[0];
  assert.ok(startOf(1) && startOf(3) && startOf(7), 'teams of the latest seasons are listed');
  assert.equal(startOf(2), undefined, 'a team only in a past season has no current start');
  assert.ok(bb.d >= startOf(1), 'd is the latest start');
  assert.ok(r.seasons.tn.d.endsWith('-01-01') && Object.keys(r.seasons.tn.s).length === 0, 'tennis: the year');
  assert.ok(Object.keys(r.seasons.fb.s).length >= 1);
  // crawler HTML: the past game's link becomes text, the current one stays, other links untouched
  assert.equal(r.html, '<p>old · <a href="/es/basketball/game/502">new</a> · fb old · <a href="/team/5">team</a></p>');
});

test('past seasons: 410 + noindex for visitors and crawlers (every language, tabs, game APIs, slug lookup), admins see the page', () => {
  const env = { ...baseEnv(), BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', API_READ_TOKEN: 'fix243-read' };
  const st = fs.mkdtempSync(path.join(os.tmpdir(), 'fix243-static-'));
  fs.mkdirSync(path.join(st, 'assets'));
  fs.writeFileSync(path.join(st, 'index.html'), '<!doctype html><html lang="en"><head><title>SportLikely</title><script type="module" src="/assets/index-abc.js"></script></head><body><div id="root"></div></body></html>');
  env.STATIC_DIR = st;
  const r = run(`
    const { app } = require('${DIST}/app.js');
    ${SEED}
    const srv = app.listen(0, async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      const get = async (p, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1') => {
        const res = await fetch(base + p, { redirect: 'manual', headers: { 'user-agent': ua } });
        return { s: res.status, robots: res.headers.get('x-robots-tag'), body: (await res.text()).slice(0, 4000) };
      };
      const out = {};
      for (const p of ['/basketball/match/old-home-vs-old-away-2025-09-01', '/es/basketball/match/old-home-vs-old-away-2025-09-01', '/tr/basketball/match/old-home-vs-old-away-2025-09-01/stats',
        '/football/match/fb-home-vs-fb-away-2025-12-30', '/pt/american-football/match/nfl-home-vs-nfl-away-2025-12-01', '/it/tennis/match/tn-one-vs-tn-two-2025-06-01'])
        out[p] = await get(p);
      out.bot = await get('/de/basketball/match/old-home-vs-old-away-2025-09-01', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
      out.current = await get('/basketball/match/old-home-vs-new-away-2026-10-24');
      out.admin = await get('/basketball/match/old-home-vs-old-away-2025-09-01?token=fix243-read');
      out.api = await get('/api/basketball/game/501');
      out.apiCur = await get('/api/basketball/game/502');
      out.apiFb = await get('/api/matches/1000000501/details');
      out.apiTn = await get('/api/tennis/match/501');
      out.slug = await get('/api/slug/basketball/match/old-home-vs-old-away-2025-09-01');
      out.slugCur = await get('/api/slug/basketball/match/old-home-vs-new-away-2026-10-24');
      out.slugAdmin = await get('/api/slug/basketball/match/old-home-vs-old-away-2025-09-01?token=fix243-read');
      for (const k of Object.keys(out)) if (!k.startsWith('/')) out[k].body = out[k].body.slice(0, 300);
      console.log('RESULT ' + JSON.stringify(out));
      process.exit(0);
    });
  `, env);
  for (const p of Object.keys(r).filter(k => k.startsWith('/'))) {
    assert.equal(r[p].s, 410, `${p}: 410`);
    assert.equal(r[p].robots, 'noindex', `${p}: X-Robots-Tag noindex`);
    assert.match(r[p].body, /<meta name="robots" content="noindex">/, `${p}: robots meta`);
    assert.match(r[p].body, /past season/, `${p}: says why`);
  }
  assert.match(r['/es/basketball/match/old-home-vs-old-away-2025-09-01'].body, /href="\/es\/basketball"/, 'the link home keeps the language');
  assert.equal(r.bot.s, 410, 'a crawler too');
  assert.notEqual(r.current.s, 410, 'a current-season finished game stays public');
  assert.notEqual(r.admin.s, 410, 'admins see past seasons');
  assert.equal(r.api.s, 410); assert.equal(r.api.robots, 'noindex');
  assert.notEqual(r.apiCur.s, 410);
  assert.equal(r.apiFb.s, 410); assert.equal(r.apiTn.s, 410);
  assert.equal(r.slug.s, 410, "the app's slug lookup: 410 (the page shows: from a past season)");
  assert.equal(r.slugCur.s, 200); assert.equal(r.slugAdmin.s, 200);
});

test('bot gate: 4 renders at a time, 16 waiting, the rest 503 at once; a slot handed over is never shared', async () => {
  const { BotGate, isBotUa } = await import(`${DIST}/services/botGate.js`);
  assert.ok(isBotUa('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'));
  assert.ok(isBotUa('python-requests/2.31')); assert.ok(isBotUa('')); assert.ok(isBotUa(undefined));
  assert.ok(!isBotUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'));
  assert.ok(!isBotUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'));
  const g = new BotGate(4, 16, 200);
  const held = await Promise.all(Array.from({ length: 4 }, () => g.enter()));
  assert.ok(held.every(Boolean));
  const waiting = Array.from({ length: 16 }, () => g.enter());
  assert.equal(await g.enter(), null, 'over 4 + 16: refused at once');
  assert.equal(g.status().waiting, 16);
  held[0](); held[0](); // twice: counted once
  const first = await waiting[0];
  assert.ok(first); assert.equal(g.status().running, 4, 'the slot went to the first in line (never 5 at once)');
  for (const h of held.slice(1)) h();
  first();
  const rest = await Promise.all(waiting.slice(1));
  assert.ok(rest.filter(Boolean).length >= 4);
  assert.ok(g.status().running <= 4 && g.status().maxRunning <= 4);
  for (const x of rest) x && x();
  // a wait over the limit ends in null (the caller sends 503 + Retry-After)
  const g2 = new BotGate(1, 4, 30);
  const a = await g2.enter();
  assert.equal(await g2.enter(), null, 'waited 30 ms: refused');
  a();
  assert.equal(g2.status().running, 0);
});

test('stored pages on the web: time and ETag from the covering index, views read in the reader thread', () => {
  const env = baseEnv();
  // the worker side: the indexes (dbIndexes thread) and an 8 MB page with its views, as buildNow stores them
  run(`
    const { db } = require('${DIST}/db/index.js');
    require('${DIST}/services/pageCache.js');
    // the two page_cache indexes as dbIndexes.ts builds them (its other tables are not in this empty database)
    const src = require('fs').readFileSync('${DIST}/services/dbIndexes.js', 'utf8');
    for (const m of src.matchAll(/CREATE INDEX IF NOT EXISTS idx_page_cache_\\w+ ON page_cache\\([^)]+\\)/g)) db.exec(m[0]);
    Promise.resolve().then(() => {
      const big = JSON.stringify({ data: Array.from({ length: 40000 }, (_, i) => ({ id: i, name: 'x'.repeat(180) })) });
      const ins = db.prepare('INSERT OR REPLACE INTO page_cache (key, json, built_at, ms, etag, gz, kb) VALUES (?, ?, ?, 0, ?, NULL, ?)');
      ins.run('big243', big, 1000, null, Math.round(big.length / 1024));
      ins.run('big243#anon', big, 1000, '"anon-etag"', Math.round(big.length / 1024));
      console.log('RESULT ' + JSON.stringify({ kb: Math.round(big.length / 1024) }));
      process.exit(0);
    });
  `, { ...env, SL_ROLE: 'worker' });
  const r = run(`
    const { db } = require('${DIST}/db/index.js');
    const pc = require('${DIST}/services/pageCache.js');
    const { pageReaderStatus } = require('${DIST}/services/pageReader.js');
    pc.definePage({ name: 'big243', freshMs: 3600e3, build: () => ({}) });
    const plan = sql => db.prepare('EXPLAIN QUERY PLAN ' + sql).all('big243', 1000).map(x => x.detail).join(' | ');
    (async () => {
      let maxLag = 0, last = Date.now();
      const tick = setInterval(() => { const n = Date.now(); maxLag = Math.max(maxLag, n - last - 5); last = n; }, 5);
      let text = 0, etag = null;
      for (let i = 0; i < 10; i++) {
        pc._forgetPageMemory();
        const s = await pc.getPage('big243', {}, { views: ['anon'] });
        const v = s.view('anon');
        text = v.text.length; etag = s.etagOf('anon');
        await new Promise(r => setTimeout(r, 10));
      }
      clearInterval(tick);
      console.log('RESULT ' + JSON.stringify({ text, etag, reader: pageReaderStatus(), maxLag,
        planAt: plan('SELECT built_at FROM page_cache INDEXED BY idx_page_cache_meta WHERE key = ? AND ? > 0') }));
      process.exit(0);
    })();
  `, { ...env, SL_ROLE: 'web' });
  assert.ok(r.text > 7_000_000, `the 8 MB view was sent (${r.text})`);
  assert.equal(r.etag, '"anon-etag"');
  assert.equal(r.reader.on, true, 'the reader thread runs in the web process');
  assert.ok(r.reader.reads >= 10, `every view read in the thread (${r.reader.reads})`);
  assert.match(r.planAt, /COVERING INDEX idx_page_cache_meta/);
  console.log(`  web thread: longest block while reading 10 × 8 MB views ${r.maxLag} ms (reader max ${r.reader.maxMs} ms)`);
});

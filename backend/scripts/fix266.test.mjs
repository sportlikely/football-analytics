// fix266: admins get the same speed as visitors. Run: npm run test:fix266 (after tsc)
//  - a worker process stores the football upcoming list (2,000 games), the basketball games, the record, More
//    predictions' record (admin copy) and the NFL config (admin copy) through their real page definitions; each list
//    keeps an 'admin' view (bookmaker data kept, shadow models and sponsor names cleaned as res.json did)
//  - a web-role process (SL_STRICT_WEB=1, no worker connected) answers an admin session: every list 200 from the
//    stored copy in under 50 ms (nothing forwarded), with the odds the admin sees; a copy built before the admin view
//    existed gets the paid copy at once (X-SL-Copy: full) instead of the worker
//  - stringifyAsync with a replacer = JSON.stringify with it; the first round after a restart builds stale lists first;
//    a request the 1-s guard cut counts until its handler ended; signed-in and admin requests are counted apart and
//    data health "Slow requests (admin)" reports them
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY', 'RESEND_API_KEY'];
const envOf = (dir, extra = {}) => {
  const e = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', CANONICAL_HOST: '', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', ADMIN_EMAILS: 'boss@example.com', THREAD_JOBS: '0', ...extra };
  for (const k of KEYS) e[k] = '';
  return e;
};
const run = (code, env, timeout = 180000) => {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  assert.ok(line, `no result (status ${r.status}):\n${(r.stderr || '').slice(-3000)}\n${(r.stdout || '').slice(-1500)}`);
  return JSON.parse(line.slice(7));
};

const WORKER = `
const D = ${JSON.stringify(DIST)};
require(D + '/app.js');
const pc = require(D + '/services/pageCache.js');
const { db } = require(D + '/db/index.js');
const auth = require(D + '/services/auth.js');
(async () => {
  const at = i => new Date(Date.now() + 3600e3 + i * 60e3).toISOString();
  const match = i => ({
    id: 1000 + i, utcDate: at(i), status: 'TIMED', competition: { code: 'PL', name: 'Premier League' },
    homeTeam: { id: 10 + i, name: 'Home team ' + i }, awayTeam: { id: 20 + i, name: 'Away team ' + i },
    prediction: { model: 'grid-v3', pick: 'HOME', home: 0.47, draw: 0.27, away: 0.26, odds: { home: 2.1, draw: 3.4, away: 3.9 } },
    predictions: [{ model: 'grid-v3', home: 0.47, draw: 0.27, away: 0.26 }, { model: 'feat-v1', home: 0.4, draw: 0.3, away: 0.3 }]
  });
  const up = pc._pageDef('upcoming');
  pc.definePage({ ...up, build: () => ({ data: Array.from({ length: 2000 }, (_, i) => match(i)), count: 2000, timestamp: new Date().toISOString() }) });
  await pc.storePage('upcoming', { days: 30 });
  const game = i => ({ id: 5000 + i, league: { code: 'NBA', name: 'NBA' }, kickoff: at(i), state: 'upcoming', home: { id: 1, name: 'Home ' + i }, away: { id: 2, name: 'Away ' + i },
    prediction: { model: 'bb-v3', pick: 'home', pHome: 61.2, pAway: 38.8 }, market: { home: 1.6, away: 2.4 } });
  const bb = pc._pageDef('bb-games');
  pc.definePage({ ...bb, build: () => ({ data: Array.from({ length: 400 }, (_, i) => game(i)), timestamp: new Date().toISOString() }) });
  await pc.storePage('bb-games', { days: 7, full: 1 });
  await pc.storePage('bb-games', { days: 7, full: 0 });
  const rec = pc._pageDef('record');
  pc.definePage({ ...rec, build: () => ({ data: { total: 10, right: 7, byCompetition: [{ code: 'PL', n: 10 }], clv: { odds: 1.9 } }, timestamp: new Date().toISOString() }) });
  await pc.storePage('record', { days: 30 });
  await pc.storePage('more-record', { sport: 'football', admin: 1 });
  await pc.storePage('nfl-config', { league: 1, admin: 1 });
  // a copy stored before fix266 (no admin view): the summary page without its '#admin' row
  await pc.storePage('summary', {});
  db.prepare("DELETE FROM page_cache WHERE key = 'summary#admin'").run();
  const uid = Number(db.prepare("INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES ('boss@example.com', 'x', 'free', ?, 1)").run(new Date().toISOString()).lastInsertRowid);
  const { token } = auth.createSession(uid, 'fix266 test', true);
  const views = k => db.prepare("SELECT key FROM page_cache WHERE key LIKE ? AND key NOT LIKE '%~%' ORDER BY key").all(k + '#%').map(r => r.key.split('#')[1]);
  console.log('RESULT ' + JSON.stringify({ token, upViews: views('upcoming?days=30'), bb1: views('bb-games?days=7&full=1'), bb0: views('bb-games?days=7&full=0') }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
`;

const WEB = `
const D = ${JSON.stringify(DIST)};
const { app } = require(D + '/app.js');
require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
const { webBuilds } = require(D + '/services/builders.js');
const s = app.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + s.address().port;
  const cookie = 'b2b_session=' + process.env.TOKEN;
  const open = async (url, headers = {}) => {
    const t0 = process.hrtime.bigint();
    const r = await fetch(base + url, { headers: { 'User-Agent': 'Mozilla/5.0 (fix266 test)', Cookie: cookie, ...headers } });
    const text = await r.text();
    return { status: r.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, copy: r.headers.get('x-sl-copy'), text };
  };
  const cases = [
    ['upcoming', '/api/matches/upcoming?days=30'], ['bb games', '/api/basketball/games?days=7'], ['record', '/api/public/record?days=30'],
    ['more record', '/api/more/football/record'], ['nfl config', '/api/nfl/config?league=1'], ['summary (old copy)', '/api/public/summary']
  ];
  for (const [, u] of cases) await open(u);
  const out = {}, body = {};
  for (const [k, u] of cases) { const x = await open(u); try { body[k] = JSON.parse(x.text); } catch { body[k] = null; } out[k] = { status: x.status, ms: x.ms, copy: x.copy, head: x.text.slice(0, 200) }; }
  const up = body.upcoming;
  const seen = {
    upCount: up?.data?.length, upOdds: up?.data?.[1]?.prediction?.odds, upModels: up?.data?.[1]?.predictions?.map(p => p.model),
    bbMarket: body['bb games']?.data?.[0]?.market, recByComp: body.record?.data?.byCompetition?.length
  };
  const me = await open('/api/auth/me');
  console.log('RESULT ' + JSON.stringify({ out, seen, me: me.text.slice(0, 400), builds: webBuilds() }));
  setTimeout(() => process.exit(0), 200);
});
`;

test('admins: every list from its stored admin view, never the worker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix266-'));
  const made = run(WORKER, envOf(dir, { SL_ROLE: 'worker' }));
  assert.ok(made.upViews.includes('admin') && made.upViews.includes('anon') && made.upViews.includes('full'), `upcoming views: ${made.upViews}`);
  assert.ok(made.bb1.includes('admin'), `bb full=1 views: ${made.bb1}`);
  assert.ok(!made.bb0.includes('admin'), 'no admin view on the locked basketball copy (admins read full=1)');
  const r = run(WEB, envOf(dir, { SL_ROLE: 'web', SL_STRICT_WEB: '1', PAGE_WAIT_MS: '1', TOKEN: made.token }), 120000);
  assert.match(r.me, /"admin"/, `signed in as admin: ${r.me}`);
  assert.deepEqual(r.builds, {}, 'a page builder ran in the web process');
  for (const [k, x] of Object.entries(r.out)) {
    assert.equal(x.status, 200, `${k}: ${x.status} ${x.head}`);
    assert.ok(x.ms <= 50, `${k}: ${x.ms} ms`);
  }
  console.log(`fix266 admin: ${Object.entries(r.out).map(([k, x]) => `${k} ${x.status} ${x.ms} ms${x.copy ? ` (${x.copy})` : ''}`).join(', ')}`);
  const { seen } = r;
  assert.equal(seen.upCount, 2000);
  assert.deepEqual(seen.upOdds, { home: 2.1, draw: 3.4, away: 3.9 }, 'admins see the bookmaker data (admin only)');
  assert.deepEqual(seen.upModels, ['grid-v3'], 'shadow models stay hidden, as res.json did');
  assert.equal(r.out.upcoming.copy, null);
  assert.deepEqual(seen.bbMarket, { home: 1.6, away: 2.4 });
  assert.equal(seen.recByComp, 1, 'admins keep the per-competition table');
  assert.equal(r.out['summary (old copy)'].copy, 'full', 'a copy without the admin view: the paid copy at once');
});

test('stringifyAsync with a replacer, first-round order, the slow-request counter by who asked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix266b-'));
  const r = run(`
    const D = ${JSON.stringify(DIST)};
    const { stringifyAsync } = require(D + '/utils/jsonAsync.js');
    require(D + '/app.js'); // (the page definitions)
    const pc = require(D + '/services/pageCache.js');
    const Dl = require(D + '/services/deadline.js');
    const { db } = require(D + '/db/index.js');
    const express = require('express');
    (async () => {
      const rep = (k, v) => (k === 'name' && typeof v === 'string' ? v.replace(' Bet', '') : k === 'predictions' && Array.isArray(v) ? v.filter(p => p.model !== 'x') : v);
      const big = { data: Array.from({ length: 1200 }, (_, i) => ({ id: i, name: 'Club Bet ' + i, predictions: [{ model: 'a' }, { model: 'x' }] })), name: 'Top Bet', predictions: [{ model: 'x' }], n: 1 };
      const same = (await stringifyAsync(big, rep)) === JSON.stringify(big, rep);
      const order = pc._firstOrder(['nfl-config?league=1', 'bb-standings?code=NBA', 'upcoming?days=30', 'summary', 'bb-games?days=7&full=1'], k => !k.startsWith('bb-games') && !k.startsWith('nfl-config'));
      const app = express();
      app.use(Dl.deadlineStart({ isApi: p => p.startsWith('/api/public'), isTimedApi: p => p.startsWith('/api/'), sendAppPage: null, label: req => 'http GET ' + req.path, crawler: () => false }));
      app.use((req, _res, next) => { const w = req.get('x-who'); if (w === 'admin') req.access = 'admin'; else if (w === 'user') { req.user = { id: 3 }; req.access = 'free'; } next(); });
      app.use(Dl.lateCopy);
      app.get('/api/public/slow', (req, res) => setTimeout(() => res.json({ ok: 1 }), 1300));
      app.get('/api/admin/tool', (req, res) => setTimeout(() => res.json({ ok: 1 }), 1200));
      const srv = app.listen(0, async () => {
        const base = 'http://127.0.0.1:' + srv.address().port;
        const get = (p, who) => fetch(base + p, { headers: { 'x-who': who || '' } }).then(x => x.status);
        const st = [await get('/api/public/slow?a=1'), await get('/api/public/slow?a=2', 'user'), await get('/api/public/slow?a=3', 'admin'), await get('/api/admin/tool', 'admin')];
        await new Promise(r => setTimeout(r, 700));
        console.log('RESULT ' + JSON.stringify({ same, order, st, slow: Dl.slowRequests().lastHour }));
        process.exit(0);
      });
    })().catch(e => { console.error(e); process.exit(1); });
  `, envOf(dir, { SL_ROLE: 'web' }));
  // the health checks read slow_requests (written by the worker; a process that runs jobs makes the table)
  const h = run(`
    const D = ${JSON.stringify(DIST)};
    const Dl = require(D + '/services/deadline.js');
    const { db } = require(D + '/db/index.js');
    const m = Math.floor(Date.now() / 60000);
    const okAdmin = Dl.slowAdminRequestsHealth();
    const ins = db.prepare('INSERT INTO slow_requests (minute, route, n, max_ms, crawler, admin, signed) VALUES (?, ?, ?, ?, ?, ?, ?)');
    ins.run(m - 3, 'http GET /api/admin/backtest', 2, 1500, 0, 2, 0);
    const toolsOnly = Dl.slowAdminRequestsHealth();
    ins.run(m - 4, 'http GET /api/admin/tune', 1, 4500, 0, 1, 0);
    const toolsSlow = Dl.slowAdminRequestsHealth();
    ins.run(m - 2, 'http GET /api/matches/upcoming', 4, 3300, 0, 3, 1);
    console.log('RESULT ' + JSON.stringify({ okAdmin, toolsOnly, toolsSlow, admin: Dl.slowAdminRequestsHealth(), pub: Dl.slowRequestsHealth() }));
    process.exit(0);
  `, envOf(dir, { SL_ROLE: 'worker' }));
  assert.equal(r.same, true, 'stringifyAsync(x, replacer) = JSON.stringify(x, replacer)');
  assert.deepEqual(r.order.slice(0, 2), ['upcoming?days=30', 'summary'], `stale lists first: ${r.order}`);
  assert.equal(r.order[r.order.length - 1], 'nfl-config?league=1', `fresh non-lists last: ${r.order}`);
  assert.equal(r.order.indexOf('bb-games?days=7&full=1'), 3, `a fresh list after the stale pages: ${r.order}`);
  assert.deepEqual(r.st, [202, 202, 202, 200], 'public reads cut at 900 ms, the admin tool waits');
  const by = Object.fromEntries(r.slow.map(x => [x.route, x]));
  assert.equal(by['http GET /api/public/slow']?.n, 3, `cut requests count until their handler ended: ${JSON.stringify(r.slow)}`);
  assert.equal(by['http GET /api/public/slow']?.admin, 1);
  assert.equal(by['http GET /api/public/slow']?.signed, 1);
  assert.equal(by['http GET /api/admin/tool']?.admin, 1, 'admin tools timed too');
  assert.equal(h.okAdmin.level, 'ok');
  assert.equal(h.toolsOnly.level, 'ok', 'admin tools under 3 s: not a warning');
  assert.equal(h.toolsSlow.level, 'warn', 'an admin tool over 3 s: yellow');
  assert.equal(h.admin.level, 'fail', 'an admin list over 1 s: red');
  assert.match(h.admin.detail, /^3 admin request/);
  assert.equal(h.pub.level, 'warn', 'fix276: 1–5 public requests over 1 s = yellow, red over 5');
  assert.match(h.pub.detail, /^1 public request.*1 of them signed in/);
});

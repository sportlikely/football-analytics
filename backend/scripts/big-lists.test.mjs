// fix221: the list APIs at real size are only strings for the web process. Run: npm run test:fix221 (after tsc)
//  - a worker process stores the football upcoming list (2,000 games, ~5 MB) and a basketball games list (400 games)
//    through their real page definitions (only the builder is swapped for real-size data), and the NFL config page
//  - a web-role process (SL_STRICT_WEB=1: a page builder there throws) answers a signed-out visitor, a Free member
//    with unlocked games (cookie session) and a 304 revalidation; every JSON.parse it makes is measured
//  - fails when a request takes over 50 ms, the web process parses more than 64 KB of JSON, the event loop stalls over
//    100 ms, the gzip / ETag copies are missing, or a member sees a locked game in full (or an unlocked one locked)
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

const WORKER = `
const D = ${JSON.stringify(DIST)};
require(D + '/app.js');
const pc = require(D + '/services/pageCache.js');
const { db } = require(D + '/db/index.js');
const auth = require(D + '/services/auth.js');
(async () => {
  const at = i => new Date(Date.now() + 3600e3 + i * 60e3).toISOString();
  const factors = Array.from({ length: 24 }, (_, k) => ({ key: 'f' + k, label: 'Factor number ' + k, home: k * 1.5, away: k * 0.5, points: k }));
  const match = i => ({
    id: 1000 + i, utcDate: at(i), status: i % 10 === 0 ? 'FINISHED' : 'TIMED', matchday: 9,
    competition: { code: 'PL', name: 'Premier League', emblem: 'https://crests.example/pl.png' },
    homeTeam: { id: 10 + i, name: 'Home team ' + i, shortName: 'Home ' + i, crest: 'https://crests.example/' + i + '.png' },
    awayTeam: { id: 20 + i, name: 'Away team ' + i, shortName: 'Away ' + i, crest: 'https://crests.example/a' + i + '.png' },
    score: { fullTime: i % 10 === 0 ? { home: 2, away: 1 } : { home: null, away: null } },
    prediction: { model: 'grid-v3', pick: 'HOME', dc: '1X', home: 0.47, draw: 0.27, away: 0.26, confidence: 74, strong: false, odds: { home: 2.1, draw: 3.4, away: 3.9 }, factors },
    predictions: [{ model: 'grid-v3', home: 0.47, draw: 0.27, away: 0.26 }]
  });
  const up = pc._pageDef('upcoming');
  pc.definePage({ ...up, build: () => ({ data: Array.from({ length: 2000 }, (_, i) => match(i)), count: 2000, days: 30, cacheAgeMs: 0, timestamp: new Date().toISOString() }) });
  await pc.storePage('upcoming', { days: 30 });
  const game = i => ({
    id: 5000 + i, league: { code: 'NBA', name: 'NBA' }, season: '2026-2027', kickoff: at(i), status: i % 5 ? 'NS' : 'FT', state: i % 5 ? 'upcoming' : 'done',
    home: { id: 1, name: 'Home ' + i, logo: 'https://logos.example/h.png' }, away: { id: 2, name: 'Away ' + i, logo: 'https://logos.example/a.png' },
    quarters: null, prediction: i % 5 ? { model: 'bb-v3', locked: true } : { model: 'bb-v3', pick: 'home', locked: false, pHome: 61.2, pAway: 38.8, spread: 4.5, total: 221.5 }, notes: 'n'.repeat(1200)
  });
  const bb = pc._pageDef('bb-games');
  pc.definePage({ ...bb, build: () => ({ data: Array.from({ length: 400 }, (_, i) => game(i)), timestamp: new Date().toISOString() }) });
  await pc.storePage('bb-games', { days: 7, full: 0 });
  await pc.storePage('nfl-config', { league: 1 });
  const uid = Number(db.prepare("INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES ('member@example.com', 'x', 'free', ?, 1)").run(new Date().toISOString()).lastInsertRowid);
  for (const id of [1001, 1002, 1003, -5001]) db.prepare('INSERT INTO match_unlocks (user_id, match_id, at) VALUES (?, ?, ?)').run(uid, id, new Date().toISOString());
  const { token } = auth.createSession(uid, 'fix221 test');
  const kb = k => Math.round((db.prepare('SELECT length(json) AS n FROM page_cache WHERE key = ?').get(k) || { n: 0 }).n / 1024);
  const gz = k => Math.round((db.prepare('SELECT length(gz) AS n FROM page_cache WHERE key = ?').get(k) || { n: 0 }).n / 1024);
  console.log(JSON.stringify({ token, upKb: kb('upcoming?days=30'), upGzKb: gz('upcoming?days=30#anon'), bbKb: kb('bb-games?days=7&full=0') }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
`;

const WEB = `
const D = ${JSON.stringify(DIST)};
const { app } = require(D + '/app.js');
require(D + '/services/readiness.js').markReady({ loadMs: 0, states: 0 });
const { webBuilds } = require(D + '/services/builders.js');
const { monitorEventLoopDelay } = require('node:perf_hooks');
let maxParse = 0, counting = false;
const parse = JSON.parse;
JSON.parse = function (s, r) { if (counting && typeof s === 'string' && s.length > maxParse) maxParse = s.length; return parse.call(this, s, r); };
const s = app.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + s.address().port;
  const cookie = 'b2b_session=' + process.env.TOKEN;
  const open = async (url, headers = {}) => {
    const t0 = process.hrtime.bigint();
    const r = await fetch(base + url, { headers: { 'User-Agent': 'Mozilla/5.0 (fix221 test)', 'Accept-Encoding': 'gzip', ...headers } });
    const text = await r.text();
    return { status: r.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, enc: r.headers.get('content-encoding'), etag: r.headers.get('etag'), len: text.length, text: r.status === 200 && process.env.KEEP_BODY.includes(url) ? text : '' };
  };
  const cases = [
    ['anon upcoming', '/api/matches/upcoming?days=30', {}],
    ['member upcoming', '/api/matches/upcoming?days=30', { Cookie: cookie }],
    ['anon bb games', '/api/basketball/games?days=7', {}],
    ['member bb games', '/api/basketball/games?days=7', { Cookie: cookie }],
    ['nfl config', '/api/nfl/config?league=1', {}]
  ];
  // (fetch adds Cache-Control: no-cache to a conditional request unless one is given: a browser revalidating sends max-age=0)
  // warm-up (module loading, prepared statements), then the timed pass
  for (const [, u, h] of cases) await open(u, h);
  counting = true;
  const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
  const out = {};
  for (const [k, u, h] of cases) out[k] = await open(u, h);
  out['anon upcoming 304'] = await open('/api/matches/upcoming?days=30', { 'If-None-Match': out['anon upcoming'].etag, 'Cache-Control': 'max-age=0' });
  out['member upcoming 304'] = await open('/api/matches/upcoming?days=30', { Cookie: cookie, 'If-None-Match': out['member upcoming'].etag, 'Cache-Control': 'max-age=0' });
  loop.disable();
  console.log(JSON.stringify({ out, maxParse, loopMaxMs: Math.round(loop.max / 1e6), builds: webBuilds() }));
  process.exit(0);
});
`;

test('list APIs at real size: the web process sends stored strings only (gzip, ETag, member rows joined)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix221-'));
  const base = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', CANONICAL_HOST: '', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1' };
  for (const k of KEYS) base[k] = '';
  const w = spawnSync(process.execPath, ['-e', WORKER], { env: { ...base, SL_ROLE: 'worker' }, encoding: 'utf8', timeout: 180000 });
  assert.equal(w.status, 0, w.stderr || w.stdout);
  const made = JSON.parse(w.stdout.trim().split('\n').pop());
  assert.ok(made.upKb > 3000, `the upcoming list is ${made.upKb} KB (real size: several MB)`);
  assert.ok(made.upGzKb > 0 && made.upGzKb < made.upKb / 3, `gzip copy ${made.upGzKb} KB`);
  const keep = ['/api/matches/upcoming?days=30'];
  const r = spawnSync(process.execPath, ['-e', WEB], { env: { ...base, SL_ROLE: 'web', SL_STRICT_WEB: '1', PAGE_WAIT_MS: '1', TOKEN: made.token, KEEP_BODY: JSON.stringify(keep) }, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.trim().split('\n').pop());
  const { out } = res;
  console.log(`big lists: upcoming ${made.upKb} KB (gzip ${made.upGzKb} KB), bb ${made.bbKb} KB; ${Object.entries(out).map(([k, x]) => `${k} ${x.status} ${x.ms} ms`).join(', ')}; web JSON.parse max ${Math.round(res.maxParse / 1024)} KB, loop max ${res.loopMaxMs} ms`);
  assert.deepEqual(res.builds, {}, 'a page builder ran in the web process');
  for (const k of ['anon upcoming', 'member upcoming', 'anon bb games', 'member bb games', 'nfl config']) {
    assert.equal(out[k].status, 200, `${k}: ${out[k].status}`);
    assert.ok(out[k].ms <= 50, `${k}: ${out[k].ms} ms`);
  }
  assert.equal(out['anon upcoming'].enc, 'gzip', 'the signed-out list is sent from its gzip copy');
  assert.ok(out['anon upcoming'].etag, 'ETag');
  assert.equal(out['anon upcoming 304'].status, 304);
  assert.equal(out['member upcoming 304'].status, 304);
  assert.ok(res.maxParse < 64 * 1024, `the web process parsed ${Math.round(res.maxParse / 1024)} KB of JSON`);
  assert.ok(res.loopMaxMs < 100, `event loop stalled ${res.loopMaxMs} ms`);
  // what each reader sees
  const anon = JSON.parse(out['anon upcoming'].text), member = JSON.parse(out['member upcoming'].text);
  for (const [who, body] of [['anon', anon], ['member', member]]) {
    assert.equal(body.data.length, 2000, who);
    assert.equal(body.count, 2000);
    assert.ok(!JSON.stringify(body).includes('"odds"'), `${who}: bookmaker data in the list`);
  }
  const shown = (b, id) => b.data.find(m => m.id === id).prediction;
  assert.deepEqual(shown(anon, 1001), { model: 'grid-v3', locked: true }, 'signed out: locked');
  assert.equal(shown(anon, 1000).pick, 'HOME', 'a finished game is open for everyone');
  for (const id of [1001, 1002, 1003]) assert.equal(shown(member, id).pick, 'HOME', `member: unlocked ${id} in full`);
  assert.deepEqual(shown(member, 1004), { model: 'grid-v3', locked: true }, 'member: a game not unlocked stays locked');
  assert.deepEqual(member.data.find(m => m.id === 1001).predictions, [{ model: 'grid-v3', home: 0.47, draw: 0.27, away: 0.26 }]);
});

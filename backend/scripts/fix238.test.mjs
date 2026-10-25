// fix238: (1) bb-v4 rows out of range — the 3 sd rule, the test-season fallback check, every live rating held inside the
// established players' range, the projected rotation fills 240 minutes, a game with a row out of range (or a short
// rotation) is handed to bb-v3; (2) old links: every match / player id of a sport in a prebuilt index the web process
// answers from (200 old basketball / NFL / tennis game ids → 301 in under 20 ms each, never a page build or a worker
// round trip); (3) /api/matches/upcoming only reads the two stored copies; (4) start-up: no 503 "Starting up" for the
// API (a kept copy at once, else the request waits for the state). (dist build) Run: npm run test:fix238
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix238-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
process.env.THREAD_JOBS = '0';
process.env.BB_GRID = 'on';
const require = createRequire(import.meta.url);
const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../dist');
const M = require('../dist/utils/bbGridMath.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/nbaV4.js');
const G = require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');
const S = require('../dist/services/slugs.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

test('the range rules: 3 sd (flags never judged), the fallback check, the cap, a full rotation', () => {
  const stats = { mean: new Array(M.N_ROWS).fill(0), sd: new Array(M.N_ROWS).fill(5) };
  const it = (d0, d5 = 0) => { const hv = new Array(M.N_ROWS).fill(0), av = new Array(M.N_ROWS).fill(0); hv[0] = d0; hv[5] = d5; return { hv, av }; };
  assert.deepEqual(M.rowsOutOfRange(it(14.9), stats), []);
  assert.deepEqual(M.rowsOutOfRange(it(19.38), stats), [0], 'Thunder – Clippers #1 19.38 against sd 5: out');
  assert.deepEqual(M.rowsOutOfRange(it(0, 40), stats), [], '#6 rest is a flag: never judged');
  assert.match(M.rangeLabels(it(19.38), stats)[0], /^#1 Player impact of the expected rotation 19\.38 \(train 0 ± 5\)$/);
  // fallback: bb-v3 better on the out-of-range games → on; bb-v4 better (20+ games) → off; under 20 games → on
  const p = { ...M.GRID_START, w: M.GRID_ROWS.map((_, i) => (i === 0 ? 0.3 : 0)) };
  const mk = (n, y, v3) => Array.from({ length: n }, (_, k) => ({ ...it(20), id: k, code: 'NBA', season: '2025-2026', year: 2025, gp: 30, y, v3, sig: 12, oracle: null }));
  const v3better = M.fallbackCheck([...mk(30, 1, 0.9), ...mk(10, 0, 0.6)], stats, () => p);
  assert.equal(v3better.games, 40); assert.ok(v3better.v3 < v3better.v4); assert.equal(v3better.on, true);
  const v4better = M.fallbackCheck(mk(30, 1, 0.55), stats, () => p);
  assert.ok(v4better.v4 < v4better.v3); assert.equal(v4better.on, false);
  assert.equal(M.fallbackCheck(mk(5, 1, 0.55), stats, () => p).on, true, 'too few games: the safe side');
  assert.equal(M.capTo(19, [-10, 16.5]), 16.5); assert.equal(M.capTo(-12, [-10, 16.5]), -10); assert.equal(M.capTo(3, null), 3);
  assert.ok(M.rotationOk(240.4, 48)); assert.ok(!M.rotationOk(210, 48)); assert.ok(M.rotationOk(200, 40));
});

test('the replay: every live rating inside the established range, rotations of 240 minutes; out of range → bb-v3', async () => {
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at, stats) VALUES (?, 'NBA', 12, ?, NULL, ?, 'FT', ?, ?, ?, ?, ?, ?, ?, 1)`);
  const insP = db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes, pts, fgm, fga, tpm, tpa, ftm, fta, reb, ast) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insT = db.prepare(`INSERT INTO bb_team_stats (game_id, team_id, fgm, fga, tpm, tpa, ftm, fta, reb, oreb, dreb, ast, stl, blk, tov, pf) VALUES (?, ?, 38, 85, 12, 34, 16, 21, 44, 10, 34, 25, 7, 5, 13, 19)`);
  const r = rng(7);
  const quality = id => ((id * 7919) % 11) / 5 - 1;
  const mins = [36, 34, 32, 30, 28, 24, 20, 18, 18];
  const base = new Map();
  let id = 1;
  for (const [season, y] of [['2023-2024', 2023], ['2024-2025', 2024]]) {
    for (let d = 0; d < 70; d++) {
      const day = Date.UTC(y, 10, 1) + d * 2 * 86400000;
      for (let k = 0; k < 3; k++) {
        const h = 1 + ((d + k) % 6), a = 1 + ((d + k + 1 + (d % 4)) % 6);
        if (h === a) continue;
        // player 699 is a fringe player: 1–3 minutes a game with a huge box score (the few-minutes outlier)
        const side = t => [...mins.map((m, j) => [t * 100 + j + 1, Math.max(4, m + gauss(r) * 2)]), ...(t === 6 ? [[699, 1 + 2 * r()]] : [])];
        const hs = side(h), as = side(a);
        const s = l => l.reduce((acc, [p, m]) => acc + quality(p) * m / 48, 0);
        const margin = Math.round(2 + s(hs) - s(as) + gauss(r) * 10) || 1;
        ins.run(id, season, new Date(day + k * 3600000).toISOString(), h, `Team ${h}`, a, `Team ${a}`, 105 + Math.max(0, margin), 105 + Math.max(0, -margin), new Date().toISOString());
        for (const [t, list] of [[h, hs], [a, as]]) {
          insT.run(id, t);
          for (const [p, m] of list) {
            const big = p === 699;
            const pts = big ? 12 : Math.max(0, Math.round((11 + quality(p)) * m / 34 + gauss(r) * 3)), fga = big ? 5 : Math.max(1, Math.round(10 * m / 34));
            insP.run(id, t, p, `Player ${p}`, Math.round(m * 10) / 10, pts, Math.round(fga * 0.5), fga, big ? 3 : 1, big ? 4 : 3, 2, 3, big ? 5 : Math.round(5 * m / 34), big ? 4 : Math.round(3 * m / 34));
          }
        }
        base.set(id, { p: 0.5 + margin / 100, m1: 0, netH: 0, netA: 0, hca: 2, haH: 0, haA: 0, b2bH: false, b2bA: false, sig: 12 });
        id++;
      }
    }
  }
  const res = await G.replayLeague('NBA', base, G.storedBox());
  const snap = res.snap;
  assert.ok(snap.cap && snap.cap.B && snap.cap.A && snap.cap.C, `ranges ${JSON.stringify(snap.cap)}`);
  for (const t of snap.teams.values()) {
    assert.ok(t.rot && M.rotationOk(t.rot[1], 48), `rotation ${JSON.stringify(t.rot)}`);
    for (const p of t.pl) {
      assert.ok(p[1] >= snap.cap.C[0] - 1e-6 && p[1] <= snap.cap.C[1] + 1e-6, `on/off ${p[1]} outside ${snap.cap.C}`);
      assert.ok(p[4] >= snap.cap.A[0] - 1e-6 && p[4] <= snap.cap.A[1] + 1e-6, `A ${p[4]} outside ${snap.cap.A}`);
      assert.ok(p[5] >= snap.cap.B[0] - 1e-6 && p[5] <= snap.cap.B[1] + 1e-6, `B ${p[5]} outside ${snap.cap.B}`);
    }
  }
  const fringe = snap.teams.get(6).pl.find(p => p[0] === 699);
  assert.ok(fringe, 'the fringe player is in the snapshot');
  assert.ok(snap.cap.ids.includes(699), `the few-minutes outlier is held (held: ${snap.cap.ids})`);
  // the state and a live game
  G.storeRows('NBA', res.items);
  G.publishSnap(snap);
  const gs = T.publishGridState();
  assert.ok(gs.fallback && gs.fallback.NBA, 'a fallback check per group');
  const g = { code: 'NBA', game_id: 1, home_id: 1, away_id: 2, kickoff: new Date(Date.now() + 86400000).toISOString(), season: '2024-2025', week: null };
  const x = { p: 0.6, hca: 2, haH: 0, haA: 0, b2bHome: false, b2bAway: false };
  const ok = T.gridPredict(g, x, 12);
  assert.ok(ok && !ok.off, `a normal game stays with bb-v4 (${ok?.off})`);
  // a short rotation → handed to bb-v3
  const t1 = snap.teams.get(1);
  snap.teams.set(1, { ...t1, rot: [4, 168] });
  G.publishSnap(snap);
  assert.match(T.gridPredict(g, x, 12).off.join(' '), /home rotation 4 players, 168 minutes \(not 240\)/);
  // #1 far out of its range → handed to bb-v3 (unless the group's test season said bb-v4 is better there)
  snap.teams.set(1, { ...t1, imp: t1.imp + 20 * gs.stats.sd[0], nv: undefined });
  G.publishSnap(snap);
  const far = T.gridPredict(g, x, 12);
  if (T.fallbackOn('NBA')) assert.match(far.off.join(' '), /^#1 Player impact/);
  else assert.equal(far.off, undefined);
  process.env.BB_RANGE_FALLBACK = 'off';
  assert.equal(T.gridPredict(g, x, 12).off, undefined, 'BB_RANGE_FALLBACK=off: bb-v4 stays');
  delete process.env.BB_RANGE_FALLBACK;
  snap.teams.set(1, t1); G.publishSnap(snap);
});

test('the id index: sorted chunks, binary search, negative / big ids, kinds apart', () => {
  const pairs = Array.from({ length: 10000 }, (_, i) => [i * 3 - 5000, `game-${i}`]);
  pairs.push([1_000_000_000 + 1234567, 'af-game']);
  const ix = { sport: 'tennis', builtAt: Date.now(), entries: pairs.length, chunks: [...S.idChunks('match', [...pairs].reverse()), ...S.idChunks('player', [[7, 'a-player']])] };
  assert.ok(ix.chunks.length >= 3);
  assert.equal(S.indexedSlug(ix, 'match', '-5000'), 'game-0');
  assert.equal(S.indexedSlug(ix, 'match', String(9999 * 3 - 5000)), 'game-9999');
  assert.equal(S.indexedSlug(ix, 'match', '1001234567'), 'af-game');
  assert.equal(S.indexedSlug(ix, 'match', '-4999'), null);
  assert.equal(S.indexedSlug(ix, 'player', '7'), 'a-player');
  assert.equal(S.indexedSlug(ix, 'player', '-5000'), null, 'kinds apart');
  assert.equal(S.indexedSlug(ix, 'match', 'abc'), null);
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < 10000; k++) S.indexedSlug(ix, 'match', String((k % 9999) * 3 - 5000));
  const us = Number(process.hrtime.bigint() - t0) / 1e3 / 10000;
  assert.ok(us < 50, `${us.toFixed(2)} µs a lookup`);
});

// two processes on one database: the worker builds the slugs (old games, outside the 60-day window) and a kept copy;
// the web process answers the old links from the index and the API during its start-up
const WORKER = `
const D = ${JSON.stringify(DIST)};
const { db } = require(D + '/db/index.js');
for (const m of ['basketball', 'nfl', 'tennis']) require(D + '/services/' + m + '.js');
const slugs = require(D + '/services/slugs.js');
require(D + '/services/workerRoutes.js');
const now = Date.now(), DAY = 86400000, iso = t => new Date(t).toISOString();
const ins = (sql, ...a) => db.prepare(sql).run(...a);
const N = 200;
for (let i = 0; i < N; i++) {
  const t = iso(now - (300 + i) * DAY); // a past season: never in the web's 60-day window
  ins("INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (?, 'NBA', 12, '2025-2026', ?, 'FT', ?, ?, ?, ?, ?)", 300000 + i, t, 800 + (i % 30), 'Club' + (i % 30) + ' Hawks', 900 + (i % 30), 'Club' + (i % 30) + ' Bulls', iso(now));
  ins("INSERT INTO nfl_games (game_id, season, week, kickoff, home_id, home_name, away_id, away_name, status, league, updated_at) VALUES (?, 2025, '7', ?, ?, ?, ?, ?, 'FT', 1, ?)", 20000 + i, t, 3000 + (i % 32), 'Town' + (i % 32) + ' Rams', 3100 + (i % 32), 'Town' + (i % 32) + ' Jets', iso(now));
  ins("INSERT INTO tennis_matches (id, tournament, tour, tier, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (?, 'Paris Masters', 'atp', 'masters', ?, 'finished', ?, ?, ?, ?, 'live', ?)", 700000 + i, t, 50000 + (i % 40), 'Ana Server' + (i % 40), 51000 + (i % 40), 'Bea Volley' + (i % 40), iso(now));
}
// a signed-out copy of a worker route (what the web keeps while the worker answers)
db.prepare("INSERT OR REPLACE INTO route_cache (key, at, status, type, cache, body) VALUES (?, ?, 200, 'application/json; charset=utf-8', NULL, ?)").run('/api/basketball/game/300001?|', Date.now(), Buffer.from('{"copy":true}'));
slugs.buildSlugs({ full: true }).then(() => {
  const out = {};
  for (const [sport, kind, id] of [['basketball', 'match', 300007], ['american-football', 'match', 20007], ['tennis', 'match', 700007]]) out[sport] = slugs.slugOf(sport, kind, id);
  console.log(JSON.stringify({ status: slugs.slugStatus(), out }));
  process.exit(0);
});
`;
const WEB = `
const D = ${JSON.stringify(DIST)};
const { app } = require(D + '/app.js');
const shared = require(D + '/services/shared.js');
const readiness = require(D + '/services/readiness.js');
(async () => {
  const s = app.listen(0, '127.0.0.1');
  await new Promise(r => s.once('listening', r));
  const base = 'http://127.0.0.1:' + s.address().port;
  const open = async (url, headers = {}) => {
    const t0 = process.hrtime.bigint();
    const r = await fetch(base + url, { redirect: 'manual', headers: { 'User-Agent': 'Googlebot/2.1 (fix238 test)', ...headers } });
    const text = await r.text();
    return { status: r.status, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10, to: r.headers.get('location'), copy: r.headers.get('x-sl-copy'), text: text.slice(0, 200) };
  };
  // start-up: before the state is loaded
  const early = {};
  early.copy = await open('/api/basketball/game/300001');
  const waiting = open('/api/auth/config');
  setTimeout(() => readiness.markReady({ loadMs: 0, states: 0 }), 400);
  early.health = null;
  early.waited = await waiting;
  await shared.loadNewerStates();
  // old links: 200 per sport (any language), then one unknown id
  const ids = n => Array.from({ length: 200 }, (_, i) => n + i);
  const paths = [...ids(300000).map((id, i) => (i % 2 ? '/de' : '') + '/basketball/game/' + id), ...ids(20000).map(id => '/american-football/game/' + id), ...ids(700000).map((id, i) => (i % 3 ? '' : '/es') + '/tennis/match/' + id)];
  for (const p of paths.slice(0, 5)) await open(p); // warm-up (prepared statements, the module's first run)
  const res = [];
  for (const p of paths) res.push([p, await open(p)]);
  const unknown = await open('/basketball/game/999999');
  console.log(JSON.stringify({ early, res: res.map(([p, r]) => [p, r.status, r.ms, r.to]), unknown: { status: unknown.status, ms: unknown.ms } }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
`;

test('old links: 200 old basketball / NFL / tennis game ids each → 301 in under 20 ms, from the web process\'s index; start-up answers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix238-links-'));
  const env = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', CANONICAL_HOST: '', BASKETBALL_PUBLIC: '1', NFL_PUBLIC: '1', TENNIS_PUBLIC: '1', SITE_PASSWORD: '', BB_GRID: '' };
  const w = spawnSync(process.execPath, ['-e', WORKER], { env: { ...env, SL_ROLE: 'worker' }, encoding: 'utf8', timeout: 180000 });
  assert.equal(w.status, 0, w.stderr || w.stdout);
  const made = JSON.parse(w.stdout.trim().split('\n').pop());
  for (const sp of ['basketball', 'american-football', 'tennis']) {
    assert.ok(made.status[sp]?.idIndex?.entries >= 200, `${sp} index: ${JSON.stringify(made.status[sp]?.idIndex)}`);
    assert.ok(made.out[sp], `${sp}: a slug for the old game`);
  }
  const r = spawnSync(process.execPath, ['-e', WEB], { env: { ...env, SL_ROLE: 'web', SL_STRICT_WEB: '1', PAGE_WAIT_MS: '1' }, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  // start-up
  assert.equal(out.early.copy.status, 200, `the kept copy during start-up: ${JSON.stringify(out.early.copy)}`);
  assert.equal(out.early.copy.copy, 'startup');
  assert.notEqual(out.early.waited.status, 503, `an API call during start-up waited for the state: ${JSON.stringify(out.early.waited)}`);
  // old links
  const slow = out.res.filter(x => x[2] >= 20), bad = out.res.filter(x => x[1] !== 301);
  const max = Math.max(...out.res.map(x => x[2]));
  console.log(`fix238 old links: ${out.res.length} redirects, max ${max} ms, unknown id ${out.unknown.status} in ${out.unknown.ms} ms`);
  assert.deepEqual(bad.slice(0, 5), [], 'every old game id answers 301');
  assert.deepEqual(slow.slice(0, 5), [], 'every redirect under 20 ms');
  for (const [p, , , to] of out.res) {
    const lang = /^\/(de|es)\//.exec(p)?.[1];
    const sport = p.includes('/basketball/') ? 'basketball' : p.includes('/american-football/') ? 'american-football' : 'tennis';
    assert.match(to, new RegExp(`^${lang ? `/${lang}` : ''}/${sport}/match/[a-z0-9-]+$`), `${p} → ${to}`);
  }
  assert.ok(out.unknown.ms < 200, `an unknown old id answers at once (${out.unknown.ms} ms): no page build, no worker round trip`);
});

test('/api/matches/upcoming reads only the two stored copies (14 / 30 days)', () => {
  const src = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8');
  assert.match(src, /\|\| 30\) <= 14 \? 14 : 30/, 'days snapped to the stored copies');
});

// fix228: basketball row #4 (missing players) fitted on "who actually played" — the oracle maths (star factor, inputs as
// live has them), the oracle fit recovers the true weight while the proxy gets a smaller one, the frozen weight survives
// a re-tune (shared tune, league offsets, league settings), no 2025-26 / 2026-27 game in any train set, the gate, the
// NBA's live #4 never the "missed the last games" proxy. (dist build) Run: npm run test:fix228
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix228-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const M = require('../dist/utils/bbGridMath.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/nbaV4.js');
const G = require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const W0 = [0, 0, 1, 0.3, 0, 0, 0.5, 0, 0, 0, 0, 0, 0];
const START = { ...M.GRID_START, w: W0, version: 'test', fittedAt: 'x' };

/**
 * Games whose result follows the team row (#3) and the REAL lost impact (`trueW` × oracle); the stored #4 is the proxy
 * (a noisy, shrunk view of it: what "missed the last 2 games" knows).
 */
function games(code, n, seed, trueW, years = [2022, 2023, 2024, 2025, 2026], id0 = 0) {
  const r = rng(seed), out = [];
  for (let k = 0; k < n; k++) {
    const hv = new Array(M.N_ROWS).fill(0), av = new Array(M.N_ROWS).fill(0);
    hv[2] = gauss(r) * 3; av[2] = -hv[2];
    hv[6] = 2; av[6] = 0;
    const lostH = r() < 0.35 ? -Math.abs(gauss(r)) * 3 : 0, lostA = r() < 0.35 ? -Math.abs(gauss(r)) * 3 : 0;
    const oracle = lostH - lostA;
    hv[3] = Math.round((0.4 * lostH + gauss(r) * 0.8) * 1000) / 1000; av[3] = Math.round((0.4 * lostA + gauss(r) * 0.8) * 1000) / 1000;
    const year = years[k % years.length];
    const mg = hv[2] - av[2] + 2 * 0.5 + trueW * oracle + gauss(r) * 11;
    out.push({ id: id0 + k + 1, code, season: `${year}-${year + 1}`, year, gp: 30, sig: 12, hv, av, oracle: Math.round(oracle * 1000) / 1000, v3: 0.5, y: mg > 0 ? 1 : 0, mg });
  }
  return out;
}

test('oracle maths: the star factor, the frozen weights per league, the inputs as live has them', () => {
  const p = { ...START, miss: { w: 2, star: 0.1, proxy: 0.5, fittedAt: 'x', train: [2022], test: 2025 } };
  const it = { hv: [0, 0, 1, -3, 0, 0, 0, 0, 0, 0, 0, 0, 0], av: [0, 0, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0], sig: 12 };
  const nba = M.gridEval(p, 'NBA', it), el = M.gridEval(p, 'EL', it);
  // d = −2: NBA 2 × −2 × (1 + 0.1 × 2) = −4.8; EL (proxy, no star) 0.5 × −2 = −1
  assert.equal(Math.round(nba.parts[3] * 1e6) / 1e6, -4.8);
  assert.equal(Math.round(el.parts[3] * 1e6) / 1e6, -1);
  assert.equal(M.starOf(-2, 0.1), -2.4);
  assert.equal(M.starOf(2, 0.1), 2.4);
  assert.equal(Math.round(nba.margin * 1e6) / 1e6, Math.round((2 - 4.8) * 1e6) / 1e6);
  // log loss = −log Φ(margin / sigma) for a home win, by hand
  const q = M.gridEval(p, 'NBA', it).pHome;
  assert.ok(Math.abs(M.logLoss(p, [{ ...it, code: 'NBA', y: 1 }]) + Math.log(q)) < 1e-12);
  // frozen: no offset or league setting moves #4
  const p2 = { ...p, offsets: { NBA: [0, 0, 0, 0.7, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, league: { EL: { src: 'own', group: null, home: 0, str: 1, sig: 1, off: [0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0], n: 1 } } };
  assert.equal(M.weightsFor(p2, 'NBA')[3], 2);
  assert.equal(M.weightsFor(p2, 'EL')[3], 0.5);
  assert.equal(p.w[3], W0[3], 'the shared array is never written');
  // inputs: NBA oracle (unknown → 0) / blind 0, other leagues the stored proxy; the stored items untouched
  const items = [{ code: 'NBA', hv: [0, 0, 0, -1], av: [0, 0, 0, -2], oracle: -3 }, { code: 'NBA', hv: [0, 0, 0, -1], av: [0, 0, 0, 0], oracle: null }, { code: 'EL', hv: [0, 0, 0, -1], av: [0, 0, 0, -2], oracle: -3 }];
  const o = M.missInputs(items, 'oracle'), b = M.missInputs(items, 'blind');
  assert.deepEqual([o[0].hv[3], o[0].av[3], o[1].hv[3], o[2].hv[3], o[2].av[3]], [-3, 0, 0, -1, -2]);
  assert.deepEqual([b[0].hv[3], b[0].av[3], b[2].hv[3]], [0, 0, -1]);
  assert.equal(items[0].hv[3], -1);
});

test('the oracle fit finds the real weight; the proxy gets its own smaller one; the gate', async () => {
  const nba = games('NBA', 6000, 11, 1.2);
  const tr = M.missSplit(M.missInputs(nba, 'oracle'), [2022, 2023, 2024], 2025);
  const om = await M.fitMiss(tr.train, START, { rounds: 40 });
  assert.ok(om.w > 0.9 && om.w < 1.5, `oracle weight ${om.w} (true 1.2)`);
  assert.ok(om.trainLL < om.startLL);
  // the test season (never fitted) agrees: the fit beats the weight from history (0.3) with who played known
  assert.ok(M.logLoss(om.params, tr.test) < M.logLoss(START, tr.test));
  // other leagues: the proxy fitted on its own rows — positive, under the oracle weight
  const el = M.missSplit(games('EL', 6000, 12, 1.2), [2022, 2023, 2024], 2025);
  const miss = { w: om.w, star: om.star, proxy: 0.3, fittedAt: 'x', train: [2022, 2023, 2024], test: 2025 };
  const px = await M.fitProxy(el.train, { ...START, miss }, { rounds: 30 });
  assert.ok(px.proxy > 0 && px.proxy <= om.w, `proxy weight ${px.proxy} (oracle ${om.w})`);
  // gate: the frozen fit against the settings live now on the inputs live has
  const next = { ...om.params, miss: { ...miss, proxy: px.proxy } };
  const testAll = [...tr.test, ...el.test];
  const g = M.missGate(testAll, next, START);
  assert.equal(g.pass, true, g.reason);
  assert.ok(g.oracle.next < g.oracle.cur && g.whole.next <= g.whole.cur);
  // a worse #4 (weight 0) fails the oracle part
  const bad = M.missGate(testAll, { ...next, miss: { ...next.miss, w: 0 } }, START);
  assert.equal(bad.pass, false);
});

test('never trained on 2025-26 (test) or 2026-27+ (live)', () => {
  const items = games('NBA', 500, 3, 1);
  assert.throws(() => M.missSplit(items, [2026], 2025));
  assert.throws(() => M.missSplit(items, [2024, 2025], 2025));
  assert.throws(() => M.missSplit(items, [], 2025));
  const s = M.missSplit(items, [2022, 2023, 2024], 2025);
  assert.ok(s.train.length > 0 && s.train.every(x => [2022, 2023, 2024].includes(x.year)));
  assert.ok(s.test.every(x => x.year === 2025));
});

test('the frozen weight survives a re-tune (fitGrid, league offsets, league settings)', async () => {
  const items = M.missInputs([...games('NBA', 3000, 21, 1.2, [2022, 2023, 2024]), ...games('EL', 1600, 22, 1.2, [2022, 2023, 2024], 10000)], 'oracle');
  const miss = { w: 1.15, star: 0.04, proxy: 0.35, fittedAt: 'x', train: [2022, 2023, 2024], test: 2025 };
  const f = await M.fitGrid(items, { ...START, miss }, { rounds: 20, minOffsetGames: 1500 });
  assert.deepEqual(f.params.miss, miss);
  assert.equal(f.params.w[3], 1.15);
  for (const off of Object.values(f.params.offsets)) assert.equal(off[3], 0);
  assert.equal(M.weightsFor(f.params, 'NBA')[3], 1.15);
  assert.equal(M.weightsFor(f.params, 'EL')[3], 0.35);
  const set = await M.fitLeagueSet(items.filter(x => x.code === 'EL'), f.params, { r: 1 }, 'own', null, { rounds: 10 });
  assert.equal(set.off[3], 0);
});

test('end to end: the #4 fit stored through its gate, then the monthly re-tune keeps it', async () => {
  const all = [...games('NBA', 4000, 31, 1.2), ...games('EL', 2500, 32, 1.2, undefined, 20000)];
  const up = db.prepare(`INSERT OR REPLACE INTO bb_grid_rows (game_id, code, season, ms, gp, y, v3, sig, hv, av, oracle) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`);
  for (const it of all) up.run(it.id, it.code, it.season, it.gp, it.y, it.v3, it.sig, JSON.stringify(it.hv), JSON.stringify(it.av), it.oracle);
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, NULL, ?)`).run(JSON.stringify({ ...START, version: 'history (proxy) tune' }), new Date().toISOString());
  assert.equal(T.missFitDue(), 'first #4 fit on who actually played');
  const r = await T.runMissFit({ apply: 'gate', rounds: 15, auto: 'test' });
  assert.equal(r.gate.pass, true, r.gate.reason);
  assert.equal(r.applied, true);
  assert.ok(r.miss.w > r.before.nba, `NBA #4 ${r.before.nba} → ${r.miss.w}`);
  assert.ok(r.miss.proxy <= r.miss.w);
  assert.ok(r.split.nba.after[3] > r.split.nba.before[3], `split ${r.split.nba.before[3]} → ${r.split.nba.after[3]}`);
  assert.equal(r.split.nba.after.reduce((a, b) => a + b, 0), 1000);
  assert.equal(T.missFitDue(), null);
  const stored = T.sharedParams();
  assert.deepEqual(stored.miss, r.miss);
  // the monthly re-tune: the other rows move, #4 stays where the oracle fit put it
  const t = await T.runTune({ apply: true, rounds: 10 });
  assert.deepEqual(t.params.miss, r.miss);
  assert.equal(M.weightsFor(T.sharedParams(), 'NBA')[3], r.miss.w);
  assert.equal(M.weightsFor(T.sharedParams(), 'EL')[3], r.miss.proxy);
  // data health and the admin card
  const h = T.missingRowHealth();
  assert.equal(h[0].id, 'bb-missing-row');
  assert.equal(h[0].level, 'ok');
  assert.match(h[0].detail, /NBA [\d.]+ pts per point of lost impact/);
  const info = T.missInfo();
  assert.equal(info.live.nba, Math.round(r.miss.w * 1e4) / 1e4);
  assert.ok(Array.isArray(info.examples));
});

test('live: the NBA\'s #4 is never the "missed the last games" proxy; other leagues keep it', () => {
  const snapTeam = miss => ({ imp: 1, miss, stay: 0, net: 0, ff: [0.5, 0.14, 0.27, 0.2, 0.38], ffAg: [0.5, 0.14, 0.27, 0.2, 0.38], form: 0, wins: 5, gp: 10, season: '2026-2027' });
  for (const code of ['NBA', 'EL']) {
    G.publishSnap({ code, gameMin: code === 'NBA' ? 48 : 40, lg: [0.5, 0.14, 0.27, 0.2, 0.38], pace: 75, seasonLen: 82, h2h: new Map(), builtAt: new Date().toISOString(), teams: new Map([[1, snapTeam(-3)], [2, snapTeam(0)]]) });
  }
  const g = code => ({ code, game_id: 1, home_id: 1, away_id: 2, kickoff: new Date(Date.now() + 86400000).toISOString(), season: '2026-2027', week: '5' });
  const base = { p: 0.6, sig: 12, hca: 2, haH: 0, haA: 0, b2bH: false, b2bA: false };
  assert.equal(G.liveRows(g('NBA'), base).hv[3], 0, 'no injury report: nothing');
  assert.equal(G.liveRows(g('NBA'), base, { home: -2, away: 0 }).hv[3], -2, 'the injury report / line-up');
  assert.equal(G.liveRows(g('EL'), base).hv[3], -3, 'other leagues: missed the last 2 games');
});

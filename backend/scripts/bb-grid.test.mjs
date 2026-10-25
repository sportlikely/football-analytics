// fix219: bb-v4 grid — the tuner reproduces a known optimum on synthetic data, no live-period (2026+) game is ever
// trained on, the 1,000-point split adds up, the gate, FIBA 40-minute rotations (200 minutes, injuries moved on), and a
// league replay on a scratch database (13 rows per game, nothing from after tip-off). (dist build)
// Run: npm run test:fix219
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix219-grid-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const M = require('../dist/utils/bbGridMath.js');
const I = require('../dist/utils/nbaImpact.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
const G = require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** synthetic games: 13 row differences, the result drawn from Φ(Σ w*·d / 12) */
function synthetic(wTrue, n, seed, code = 'XX') {
  const r = rng(seed), out = [];
  for (let k = 0; k < n; k++) {
    const hv = [], av = [];
    for (let i = 0; i < M.N_ROWS; i++) { const s = i === M.VOL ? 0.03 : i === 5 || i === 10 ? 0.5 : 4; hv.push(gauss(r) * s); av.push(gauss(r) * s); }
    const it = { id: k + 1, code, season: '2023-2024', year: 2023, gp: k % 40, sig: 12, hv, av, oracle: null, v3: 0.5 };
    const p = M.gridEval({ ...M.GRID_START, w: wTrue }, code, it).pHome;
    out.push({ ...it, y: r() < p ? 1 : 0 });
  }
  return out;
}

test('tuner: pattern search reproduces a known optimum on synthetic data', async () => {
  const wTrue = M.GRID_ROWS.map((_, i) => [0.4, 0, 0.9, 1, 0, 1.5, 0.8, 0, 0, 0.2, 0, 0, 0][i]);
  const items = synthetic(wTrue, 6000, 3);
  const llTrue = M.logLoss({ ...M.GRID_START, w: wTrue }, items);
  const fit = await M.fitGrid(items, M.GRID_START, { minOffsetGames: 1e9 });
  // the fit is at least as good as the truth on its own data, and the large weights come back
  assert.ok(fit.trainLL <= llTrue + 1e-4, `${fit.trainLL} vs true ${llTrue}`);
  assert.ok(fit.trainLL < fit.startLL);
  for (const i of [0, 2, 3, 6]) assert.ok(Math.abs(fit.params.w[i] - wTrue[i]) < 0.2, `row ${i}: ${fit.params.w[i]} vs ${wTrue[i]}`);
  for (const i of [1, 4, 7, 8]) assert.ok(Math.abs(fit.params.w[i]) < 0.15, `row ${i} should stay near 0: ${fit.params.w[i]}`);
  // and on fresh games from the same truth it is within a hair of the true weights
  const fresh = synthetic(wTrue, 4000, 99);
  assert.ok(M.logLoss(fit.params, fresh) - M.logLoss({ ...M.GRID_START, w: wTrue }, fresh) < 0.005);
});

test('never tuned on the live period: 2026+ refused, train before test', async () => {
  assert.throws(() => M.assertTrainYears([2026], 2027));
  assert.throws(() => M.assertTrainYears([2022, 2023, 2024, 2025], 2025));
  assert.throws(() => M.assertTrainYears([], 2025));
  assert.doesNotThrow(() => M.assertTrainYears([2022, 2023, 2024], 2025));
  assert.ok(M.GRID_TRAIN.every(y => y < M.GRID_TEST && y < M.GRID_LIVE_FROM));
  assert.ok((M.GRID_DEFAULT.train || []).every(y => y < M.GRID_LIVE_FROM));
  await assert.rejects(() => T.runTune({ train: [2026], test: 2027 }), /live period/);
  // the tuner only ever sees the train years
  db.exec(`DELETE FROM bb_grid_rows`);
  const ins = db.prepare(`INSERT INTO bb_grid_rows (game_id, code, season, ms, gp, y, v3, sig, hv, av, oracle) VALUES (?, ?, ?, 0, ?, ?, ?, 12, ?, ?, NULL)`);
  const live = synthetic(M.GRID_DEFAULT.w, 300, 5, 'NBA').map(x => ({ ...x, season: '2026-2027' }));
  const train = synthetic(M.GRID_DEFAULT.w, 900, 6, 'NBA');
  db.exec('BEGIN');
  for (const x of [...train, ...live.map(x => ({ ...x, id: x.id + 10000, y: 1 - x.y }))]) ins.run(x.id, x.code, x.season, x.gp, x.y, x.v3, JSON.stringify(x.hv), JSON.stringify(x.av));
  db.exec('COMMIT');
  const rep = await T.runTune({ train: [2023], test: 2025, rounds: 3 });
  assert.equal(rep.trainGames, 900); // the 300 live games (results flipped) never reach the fit
  assert.deepEqual(rep.params.train, [2023]);
  db.exec(`DELETE FROM bb_grid_rows`);
});

test('1,000 points split: edges add up to home − 500, weight-0 rows listed apart, volatility widens sigma', () => {
  const p = { ...M.GRID_START, w: M.GRID_ROWS.map((_, i) => (i === 1 || i === 8 ? 0 : i === M.VOL ? 1 : 0.5)) };
  const it = { hv: M.GRID_ROWS.map((_, i) => (i === M.VOL ? 0.05 : i + 1)), av: M.GRID_ROWS.map((_, i) => (i === M.VOL ? 0.05 : 0.5)), sig: 12 };
  const v = M.split1000(p, 'NBA', it, M.GRID_ROWS.map(() => 2));
  assert.equal(v.points.home + v.points.away, 1000);
  assert.equal(v.rows.reduce((s, r) => s + r.edge, 0), v.points.home - 500);
  assert.deepEqual(v.unused.sort(), ['matchup', 'net100']);
  assert.ok(!v.rows.some(r => r.key === 'volatility' || r.key === 'net100'));
  assert.equal(M.fittedSplit(p.w, M.GRID_ROWS.map(() => 2)).reduce((a, b) => a + b, 0), 1000);
  const calm = M.gridEval(p, 'NBA', { ...it, hv: it.hv.map((x, i) => (i === M.VOL ? 0 : x)), av: it.av.map((x, i) => (i === M.VOL ? 0 : x)) });
  const wild = M.gridEval(p, 'NBA', it);
  assert.ok(wild.sigma > calm.sigma && Math.abs(wild.pHome - 0.5) < Math.abs(calm.pHome - 0.5));
});

test('gate: bb-v4 must beat bb-v3 on the whole test season AND games 1–25, per group', () => {
  const w = M.GRID_START.w.map((_, i) => (i === 0 ? 1 : 0));
  const p = { ...M.GRID_START, w };
  const base = synthetic(w, 3000, 8, 'NBA').map(x => ({ ...x, year: 2025, season: '2025-2026' }));
  const good = base.map(x => ({ ...x, v3: 0.5 })); // bb-v3 knows nothing → v4 better
  const g1 = T.gridGate(good, p);
  assert.equal(g1.NBA.pass, true);
  const bad = base.map(x => ({ ...x, v3: x.y ? 0.9 : 0.1 })); // bb-v3 near perfect → v4 loses
  const g2 = T.gridGate(bad, p);
  assert.equal(g2.NBA.pass, false);
  assert.match(g2.NBA.reason, /bb-v3 stays/);
  assert.equal(M.groupOf('EL'), 'Europe'); assert.equal(M.groupOf('NBA'), 'NBA'); assert.equal(M.groupOf('JBL'), 'Rest of the world');
});

test('FIBA rotations: 200 minutes, cap 35, an injured starter\'s minutes go to the next men', () => {
  const pl = Array.from({ length: 12 }, (_, k) => ({ id: k + 1, min: [32, 30, 28, 26, 24, 20, 16, 12, 8, 6, 4, 2][k], rating: k === 0 ? 5 : 0 }));
  const sum = r => r.reduce((s, p) => s + p.proj, 0);
  const base = I.rotation(pl, new Map(), 40), hurt = I.rotation(pl, new Map([[1, 0]]), 40);
  assert.ok(Math.abs(sum(base) - 200) < 1e-6 && Math.abs(sum(hurt) - 200) < 1e-6);
  assert.ok(base.every(p => p.proj <= 35 + 1e-9));
  assert.ok(hurt.some(p => p.id === 11) && !hurt.some(p => p.id === 1));
  assert.ok(I.strength(hurt, 40) < I.strength(base, 40));
  assert.equal(G.gameMinOf('NBA'), 48); assert.equal(G.gameMinOf('CBA'), 48); assert.equal(G.gameMinOf('ACB'), 40);
  assert.equal(G.isRegular(null), true); assert.equal(G.isRegular('12'), true); assert.equal(G.isRegular('ACB - Semi-finals'), false);
  assert.equal(G.isNeutral('EL', 'Euroleague - Final'), true); assert.equal(G.isNeutral('ACB', 'ACB - Final'), false);
});

test('league replay on a scratch database: 13 rows a game, nothing from after tip-off', async () => {
  const r = rng(21);
  const teams = Array.from({ length: 6 }, (_, t) => ({ id: 500 + t, name: `Club T${t}`, players: Array.from({ length: 10 }, (_, k) => ({ id: 9000 + t * 10 + k, rating: gauss(r) * 2, min: [32, 30, 28, 26, 24, 20, 16, 12, 8, 4][k] })) }));
  const now = new Date().toISOString();
  const insG = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, stats, updated_at) VALUES (?, 'ACB', 117, ?, ?, ?, 'FT', ?, ?, ?, ?, ?, ?, 1, ?)`);
  const insL = db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes) VALUES (?, ?, ?, ?, 0, ?)`);
  const insT = db.prepare(`INSERT INTO bb_team_stats (game_id, team_id, fgm, fga, tpm, tpa, ftm, fta, reb, oreb, dreb, ast, stl, blk, tov, pf) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, ?, 0)`);
  const base = new Map();
  let id = 70000, ms = Date.parse('2023-10-01T18:00:00Z');
  db.exec('BEGIN');
  for (const season of ['2023-2024', '2024-2025']) {
    if (season === '2024-2025') ms = Date.parse('2024-10-01T18:00:00Z');
    for (let rep = 0; rep < 8; rep++) for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      if (i === j || (rep + i + j) % 2) continue;
      const h = teams[i], a = teams[j], m = Math.round(h.players.reduce((s, p) => s + p.rating * p.min / 40, 0) - a.players.reduce((s, p) => s + p.rating * p.min / 40, 0) + 3 + gauss(r) * 8) || 1;
      insG.run(id, season, String(rep + 1), new Date(ms).toISOString(), h.id, h.name, a.id, a.name, 80 + Math.max(m, 0), 80 - Math.min(m, 0), now);
      for (const tm of [h, a]) {
        for (const p of tm.players) if (r() > 0.1) insL.run(id, tm.id, p.id, `Zed ${p.id}`, p.min);
        insT.run(id, tm.id, 28, 62, 9, 26, 14, 19, 9, 25, 12);
      }
      base.set(id, { p: 0.5 + m / 100, m1: 2, netH: 0, netA: 0, hca: 3, haH: 0, haA: 0, b2bH: false, b2bA: false, sig: 11 });
      id++; ms += 20 * 3600 * 1000;
    }
  }
  db.exec('COMMIT');
  const a = await G.replayLeague('ACB', base);
  assert.ok(a.items.length > 100);
  assert.ok(a.items.every(x => x.hv.length === M.N_ROWS && x.av.length === M.N_ROWS && x.hv.every(Number.isFinite)));
  assert.ok(a.items.every(x => x.year === 2023 || x.year === 2024));
  assert.ok(a.snap.teams.size === 6 && [...a.snap.teams.values()].some(t => t.imp !== 0));
  // look-ahead: a later game's result changes → every row before it is the same (cached impact parts cleared first)
  const k = a.items[Math.floor(a.items.length * 0.6)];
  db.exec(`DELETE FROM bb_grid_imp`);
  db.prepare(`UPDATE bb_games SET hs = 40, as_ = 140 WHERE game_id = ?`).run(k.id);
  const b = await G.replayLeague('ACB', base);
  const ia = a.items.findIndex(x => x.id === k.id);
  for (let i = 0; i <= ia; i++) assert.deepEqual(b.items[i].hv.slice(0, 11), a.items[i].hv.slice(0, 11), `row ${i}`);
  // the stored rows come back for the tuner
  G.storeRows('ACB', b.items);
  assert.equal(G.loadRows(['ACB']).length, b.items.length);
});

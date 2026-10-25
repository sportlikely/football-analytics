// fix236: the basketball gate judges each group the way it runs live — the NBA with #4 from who actually played (the
// injury report + starters live), the other leagues with their news / rest proxy; a failing group is checked again
// without its leagues' own settings (may go live) and with #4's proxy changed (diagnosis only); the engine per group
// with its "since"; fix225's games 1–25 check within 0.002; no 2026-27 game in any gate or fit. (dist build)
// Run: npm run test:fix236
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix236-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
delete process.env.BB_GRID;
const require = createRequire(import.meta.url);
const M = require('../dist/utils/bbGridMath.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/nbaV4.js');
const G = require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)); }
const W = [0, 0, 1, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0];
const MISS = { w: 1.2, star: 0, proxy: 0.3, fittedAt: '2026-10-20T00:00:00Z', train: [2022, 2023, 2024], test: 2025 };
const P = { ...M.GRID_START, w: W, version: 'test', fittedAt: 'x', miss: MISS };

/**
 * Games whose result follows the team row (#3), the home edge and the REAL lost impact (1.2 × oracle). bb-v3 = the
 * exact chance from the team row + home edge (no injury information); the stored NBA #4 = a weak proxy.
 */
function games(code, n, seed, { years = [2022, 2023, 2024, 2025, 2026], id0 = 0, lose = 0 } = {}) {
  const r = rng(seed), out = [];
  for (let k = 0; k < n; k++) {
    const hv = new Array(M.N_ROWS).fill(0), av = new Array(M.N_ROWS).fill(0);
    hv[2] = gauss(r) * 3; av[2] = -hv[2];
    hv[6] = 2; av[6] = 0;
    const lostH = r() < 0.4 ? -Math.abs(gauss(r)) * 4 : 0, lostA = r() < 0.4 ? -Math.abs(gauss(r)) * 4 : 0;
    const oracle = Math.round((lostH - lostA) * 1000) / 1000;
    hv[3] = Math.round((0.3 * lostH + gauss(r) * 1) * 1000) / 1000; av[3] = Math.round((0.3 * lostA + gauss(r) * 1) * 1000) / 1000;
    const year = years[k % years.length];
    const base = hv[2] - av[2] + 1;
    const mg = base + (code === 'NBA' ? 1.2 * oracle : 0.3 * (hv[3] - av[3])) + gauss(r) * 12;
    const v3 = Math.min(0.995, Math.max(0.005, phi((base - lose) / 12.3)));
    out.push({ id: id0 + k + 1, code, season: `${year}-${year + 1}`, year, gp: k % 82, sig: 12, hv, av, oracle, v3, y: mg > 0 ? 1 : 0, mg });
  }
  return out;
}

test('the NBA is judged with #4 from who actually played (as live), not blind', () => {
  const nba = games('NBA', 6000, 7);
  const live = T.gateInputs(nba, P), blind = T.inputsFor(nba, P, 'blind');
  // the inputs: NBA #4 = the oracle (home − away on the home side), never the stored proxy
  const k = nba.findIndex(x => x.oracle !== 0);
  assert.equal(live[k].hv[3], nba[k].oracle);
  assert.equal(live[k].av[3], 0);
  assert.equal(blind[k].hv[3], 0);
  const g = T.gridGate(live, P).NBA, b = T.gridGate(blind, P).NBA;
  assert.equal(g.pass, true, g.reason);
  assert.equal(b.pass, false, `blind: ${b.reason}`);
  assert.match(g.basis, /who actually played/);
  assert.equal(g.variant, 'full');
  assert.ok(g.whole.v4.logLoss < g.whole.v3.logLoss && g.first25.v4.logLoss < g.first25.v3.logLoss);
  // only the test season (2025-26): no 2026-27 game in the gate
  assert.equal(g.whole.v4.games, nba.filter(x => x.year === M.GRID_TEST).length);
  // the other leagues keep their proxy in the gate's inputs
  const el = games('EL', 50, 3);
  assert.deepEqual(T.gateInputs(el, P).map(x => x.hv[3]), el.map(x => x.hv[3]));
  assert.match(T.gateBasis('Europe'), /proxy/);
});

test("a group that fails with its leagues' own settings runs the shared ones when those pass; #4 proxy checks are diagnosis only", () => {
  const nbl = games('NBL', 4000, 21, { lose: 0.4 });
  const bad = { src: 'own', group: null, home: -4, str: 1, sig: 1, off: new Array(M.N_ROWS).fill(0), n: 900 };
  const p = { ...P, league: { NBL: bad, ACB: bad } };
  const gate = T.gridGate(T.gateInputs(nbl, p), p, { proxyBefore: 0.45 });
  const g = gate['Rest of the world'];
  assert.equal(g.pass, true, g.reason);
  assert.equal(g.variant, 'shared');
  assert.match(g.reason, /leagues' own settings dropped/);
  assert.ok(g.checks.some(c => c.live && c.pass && /NBL/.test(c.name)));
  assert.ok(g.checks.some(c => !c.live && /before the fix228 fit/.test(c.name)));
  assert.ok(g.checks.some(c => !c.live && /proxy off/.test(c.name)));
  // the settings the league runs live: its own dropped, other leagues' kept
  const q = T.groupParams(p, gate, 'NBL');
  assert.equal(q.league.NBL, undefined);
  assert.ok(q.league.ACB);
  // a group failing either way stays on bb-v3 and says what was checked
  const worse = games('NBL', 4000, 22, { lose: -0.6 });
  const w = T.gridGate(T.gateInputs(worse, p), p)['Rest of the world'];
  assert.equal(w.pass, false);
  assert.match(w.reason, /^bb-v3 stays: .* · checked: /);
  assert.equal(T.groupParams(p, { 'Rest of the world': w }, 'NBL'), p);
});

test('fix225 gate: games 1–25 counts as worse only beyond 0.002 when the whole season and who-played-known improve', () => {
  assert.equal(M.FIRST25_TOL, 0.002);
  const items = T.gateInputs(games('NBA', 6000, 31), P);
  const cur = { ...P, miss: { ...MISS, w: 0.9 } }, next = { ...P, miss: { ...MISS, w: 1.2 } };
  const base = M.impactGate(items, items, cur, next, M.GRID_TEST);
  assert.equal(base.pass, true, base.reason);
  // the same with games 1–25 made a bit worse for "next" (a row only those games have)
  const bump = (d) => items.map(x => (x.gp < 25 ? { ...x, hv: x.hv.map((v, i) => (i === 7 ? d * (x.y ? -1 : 1) : v)) } : x));
  const n2 = { ...next, w: next.w.map((v, i) => (i === 7 ? 1 : v)) };
  const at = d => M.impactGate(items, bump(d), cur, n2, M.GRID_TEST);
  const gap = g => { const c = g.checks.find(c => c.name === 'NBA games 1–25'); return c.next - c.cur; };
  let small = null, big = null;
  for (let d = 0; d <= 3 && !big; d += 0.005) { const g = at(d), x = gap(g); if (!small && x > 0.0005 && x <= 0.0019) small = g; if (x > 0.004) big = g; }
  assert.ok(small && big, 'a bump inside and one beyond the tolerance');
  const c1 = small.checks.find(c => c.name === 'NBA games 1–25'), c2 = big.checks.find(c => c.name === 'NBA games 1–25');
  assert.ok(c1.next > c1.cur && c1.next - c1.cur <= 0.002, `small ${c1.cur} → ${c1.next}`);
  assert.equal(small.pass, true, small.reason);
  assert.match(small.reason, /within 0\.002/);
  assert.ok(c2.next - c2.cur > 0.002, `big ${c2.cur} → ${c2.next}`);
  assert.equal(big.pass, false);
  assert.match(big.reason, /NBA games 1–25 .*\(worse\)/);
});

test('the engine per group: published gate, since kept while it stays, data health warns when the NBA runs bb-v3', () => {
  G.storeRows('NBA', games('NBA', 3000, 41));
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, NULL, ?)`).run(JSON.stringify(P), new Date().toISOString());
  const s = T.publishGridState();
  assert.equal(s.gate.NBA.pass, true, s.gate.NBA.reason);
  assert.equal(T.gridLive('NBA'), true, 'the grid shows on NBA game pages');
  const e1 = T.engineInfo().groups.find(g => g.group === 'NBA');
  assert.equal(e1.engine, 'bb-v4');
  assert.ok(e1.since);
  assert.equal(T.engineHealth()[0].level, 'ok');
  T.publishGridState();
  assert.equal(T.engineInfo().groups.find(g => g.group === 'NBA').since, e1.since, 'since kept while the engine stays');
  // the NBA losing the gate (bb-v3 knows better): warn, and a new "since"
  G.storeRows('NBA', games('NBA', 3000, 42).map(x => ({ ...x, v3: x.y ? 0.97 : 0.03 })));
  T.publishGridState();
  assert.equal(T.gridLive('NBA'), false);
  const h = T.engineHealth()[0];
  assert.equal(h.level, 'warn');
  assert.match(h.detail, /NBA runs bb-v3/);
  assert.notEqual(T.engineLog().NBA.since, e1.since);
  assert.equal(T.tunedInfo().engine.groups[0].group, 'NBA');
});

test('no 2026-27 (live period) in any fit', () => {
  assert.throws(() => M.assertTrainYears([2022, 2026], 2025));
  assert.throws(() => M.assertTrainYears([2025], 2025));
  assert.equal(M.GRID_TEST < M.GRID_LIVE_FROM, true);
});

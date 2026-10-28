// fix270: calibration layers that actually refit — fit on every settled game except the last 30 days (walk-forward
// test on those 30), 200 games at least, Platt / isotonic shrunk toward "no change"; a young sport (basketball / tennis:
// raw chances saved only from 25 Oct) is tested out of fold on every settled game; basketball joins the nightly refit on
// its saved p_raw; data health names the layer in use and its fit date. Run: npm run test:fix270 (compiles first: dist/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const require = createRequire(import.meta.url);
const dist = (f: string) => require(path.join(here, '..', 'dist', f));
const DAY = 86400000;

const { mulberry32, DAILY_RULES } = dist('utils/dailyRules.js');
const { fitIso, fitPlattTop, layerValue, calibrate2, fitLayer, decideRecent, crossFit, judgeTest, MIN_FIT, MIN_TEST, TEST_DAYS, SHRINK, PLATT_SHRINK } = dist('utils/recentCalib.js');

const NOW = Date.parse('2026-10-28T05:00:00Z');
const DAY0 = Math.floor(NOW / DAY) * DAY;

/** 2-way rows (basketball / tennis) over `days` days back from today: the model says `top`, the pick is right `truth(top)` of the time */
function rows2(n: number, days: number, truth: (top: number) => number, seed = 7, endDaysAgo = 0) {
  const r = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const top = 0.5 + 0.38 * r(), home = r() < 0.5;
    const hit = r() < truth(top);
    const p = home ? top : 1 - top;
    const t = DAY0 - endDaysAgo * DAY - Math.floor(((i + 0.5) / n) * days * DAY);
    return { p: [p, 0, 1 - p], y: hit === home ? 0 : 2, t };
  });
}
const over = (top: number) => 0.5 + (top - 0.5) * 0.45; // said 65% → happened ~57%: over-confident like basketball on 28 Oct
const honest = (top: number) => top;

/* ---------- shrinkage ---------- */

test('Platt shrinks toward no change: 20 games barely move it, thousands find the truth', () => {
  const r = mulberry32(1);
  const mk = (n: number) => Array.from({ length: n }, () => ({ top: 0.8, hit: r() < 0.55 ? 1 : 0 })); // says 80, happens 55
  const at = (n: number) => layerValue({ x: [], y: [], kind: 'platt', ...fitPlattTop(mk(n)) }, 0.8);
  const v20 = at(20), v200 = at(200), v5000 = at(5000);
  assert.ok(Math.abs(v20 - 0.8) < 0.06, `20 games: 0.8 → ${v20}`);
  assert.ok(v200 < v20 && v200 > v5000, `more games, closer to the truth: ${v20} → ${v200} → ${v5000}`);
  assert.ok(Math.abs(v5000 - 0.55) < 0.04, `5,000 games: 0.8 → ${v5000}`);
  assert.equal(PLATT_SHRINK, 100);
});

test('Platt on an honest model stays (almost) the identity; no rows = the identity', () => {
  const r = mulberry32(2);
  const rows = Array.from({ length: 3000 }, () => { const top = 0.5 + 0.4 * r(); return { top, hit: r() < top ? 1 : 0 }; });
  const f = fitPlattTop(rows);
  for (const t of [0.55, 0.65, 0.75, 0.85]) assert.ok(Math.abs(layerValue({ x: [], y: [], kind: 'platt', ...f }, t) - t) < 0.025, `${t} → ${layerValue({ x: [], y: [], kind: 'platt', ...f }, t)}`);
  assert.deepEqual(fitPlattTop([]), { a: 1, b: 0 });
});

test('isotonic shrinks each block toward its own chance (SHRINK games’ worth)', () => {
  const f = fitIso(Array.from({ length: 10 }, () => ({ top: 0.7, hit: 0 })));
  const want = (10 * 0 + SHRINK * 0.7) / (10 + SHRINK);
  assert.ok(Math.abs(f.y[0] - want) < 1e-3, `10 misses at 70%: ${f.y[0]} (shrunk to ${want.toFixed(3)}, not 0)`);
});

test('the layer never flips the favourite and keeps a 2-way chance on its side', () => {
  const L = { x: [], y: [], kind: 'platt', a: 0.05, b: -3 }; // would push every pick far down
  const p = calibrate2(L, 0.7);
  assert.ok(p >= 0.5, `0.7 → ${p}`);
  assert.ok(calibrate2(L, 0.3) <= 0.5);
});

/* ---------- the minimum ---------- */

test(`the minimum: ${MIN_FIT} settled games to fit — 199 keep, 200 fit`, () => {
  assert.equal(MIN_FIT, 200);
  const few = decideRecent(rows2(199, 10, over), null, null, null, NOW);
  assert.equal(few.decision, 'keep');
  assert.equal(few.candidate, null);
  assert.match(few.reason, /199 settled games \(200 needed to fit\)/);
  const enough = decideRecent(rows2(200, 10, over), null, null, null, NOW);
  assert.ok(enough.candidate, 'fitted at 200');
  assert.equal(enough.candidate.n, 200);
  // and fitLayer itself
  assert.equal(fitLayer(rows2(199, 10, over), 0, DAY0), null);
  assert.ok(fitLayer(rows2(200, 10, over), 0, DAY0));
});

test(`the test needs ${MIN_TEST} games: fewer is no promotion, whatever the gain`, () => {
  const W = { s: { n: MIN_TEST - 1, diff: -0.05, hitC: 60, hitB: 60 }, d: Array(MIN_TEST - 1).fill(-0.05) };
  const v = judgeTest(W);
  assert.equal(v.pass, false);
  assert.match(v.why, /\(< 100\)/);
  const ok = judgeTest({ s: { n: MIN_TEST, diff: -0.05, hitC: 60, hitB: 60 }, d: Array(MIN_TEST).fill(-0.05) });
  assert.equal(ok.pass, true, ok.why);
});

/* ---------- walk-forward (enough history) ---------- */

test('walk-forward: fit on everything before the last 30 days, tested on the 30 days; the candidate never sees them', () => {
  const old = rows2(600, 150, over, 3, TEST_DAYS + 1), recent = rows2(400, TEST_DAYS - 1, over, 4);
  const rows = [...old, ...recent];
  const d = decideRecent(rows, null, null, null, NOW);
  assert.equal(d.mode, 'walk-forward');
  assert.equal(d.fit.n, 600);
  assert.equal(d.fit.to, new Date(DAY0 - TEST_DAYS * DAY).toISOString().slice(0, 10));
  assert.equal(d.test.n, 400);
  assert.equal(d.decision, 'promote', d.reason);
  assert.equal(d.live, d.candidate, 'the layer that passed is the one that goes live');
  // flip every result inside the test days: the candidate must not change
  const flipped = rows.map(r => (r.t >= DAY0 - TEST_DAYS * DAY ? { ...r, y: r.y === 0 ? 2 : 0 } : r));
  const e = decideRecent(flipped, null, null, null, NOW);
  assert.deepEqual({ ...e.candidate }, { ...d.candidate });
  assert.notEqual(e.test.diff, d.test.diff, 'only its score on the test days changes');
});

test('walk-forward: an honest model gets no layer', () => {
  const rows = [...rows2(600, 150, honest, 5, TEST_DAYS + 1), ...rows2(400, TEST_DAYS - 1, honest, 6)];
  const d = decideRecent(rows, null, null, null, NOW);
  assert.notEqual(d.decision, 'promote', d.reason);
});

/* ---------- a young sport: every settled game, out of fold ---------- */

test('young sport (all games in the last days): cross-fit, promoted, every band moves toward what happened', () => {
  const rows = rows2(500, 4, over, 8);
  const d = decideRecent(rows, null, null, null, NOW);
  assert.equal(d.mode, 'cross-fit');
  assert.equal(d.decision, 'promote', d.reason);
  assert.equal(d.live.kind, 'platt');
  assert.equal(d.live.n, 500, 'the live layer is fitted on every settled game');
  assert.ok(d.live.a < 1, `over-confident → a < 1 (a ${d.live.a})`);
  for (const b of d.bands.filter((x: any) => x.n >= 40 && x.lo < 80)) {
    assert.ok(Math.abs(b.cal - b.happened) < Math.abs(b.said - b.happened), `band ${b.lo}: said ${b.said} → ${b.cal}, happened ${b.happened}`);
  }
});

test('cross-fit: each game is scored by a fit that never saw it', () => {
  const rows = rows2(300, 4, over, 9);
  const a = crossFit(rows);
  // change the results of the first block only: the first block's own numbers must not move
  const s = rows.slice().sort((x, y) => x.t - y.t);
  const first = new Set(s.slice(0, 60));
  const changed = rows.map(r => (first.has(r) ? { ...r, y: r.y === 0 ? 2 : 0 } : r));
  const b = crossFit(changed);
  rows.forEach((r, i) => { if (first.has(r)) assert.deepEqual(b.get(changed[i]), a.get(r)); });
});

test('the "before" is what was shown: a champion already honest (basketball: the season layer) is not beaten', () => {
  // raw over-confident, but what was shown (cur) was already calibrated
  const rows = rows2(500, 4, over, 10).map(r => { const raw = r.p[0], top = Math.max(raw, 1 - raw); const fix = over(top); const s = raw >= 0.5 ? fix : 1 - fix; return { ...r, cur: [s, 0, 1 - s] }; });
  const d = decideRecent(rows, null, null, null, NOW);
  assert.notEqual(d.decision, 'promote', d.reason);
  const b = d.bands.find((x: any) => x.n > 50);
  assert.ok(Math.abs(b.said - b.happened) < 5, 'bands are by the chance shown');
});

test('rollback as the champion rule: a live layer worse than none since it went live goes, never held', () => {
  const bad = { x: [], y: [], kind: 'platt', a: 3, b: 0, n: 500, from: '2026-09-01', to: '2026-10-01' };
  const d = decideRecent(rows2(500, 20, honest, 11), bad, '2026-10-05', '2026-10-27', NOW);
  assert.equal(d.decision, 'rollback', d.reason);
  assert.equal(d.live, null);
  assert.equal(DAILY_RULES.guardWorse, 0.005);
});

/* ---------- wiring ---------- */

test('wiring: basketball in the nightly refit on p_raw, its shown chance through the layer, a new rule reruns today', () => {
  const rc = read('src/services/recentCalib.ts');
  assert.match(rc, /RECENT_SPORTS: RecentSport\[\] = \['football', 'basketball', 'tennis'\]/);
  assert.match(rc, /p\.p_raw IS NOT NULL/);
  assert.match(rc, /JSON\.parse\(r\.report \|\| 'null'\)\?\.v === RECENT_RULE/);
  assert.match(rc, /recordBbPredictions/);
  const sc = read('src/services/sportCalibration.ts');
  assert.match(sc, /const r = calibrateBasketball\(p\);\s+if \(r != null\) return r;/);
  assert.match(sc, /recentState\('basketball'\)\?\.at/, 'cached predictions are redone when the layer changes');
  assert.match(read('src/services/perf.ts'), /'basketball calibration'/);
});

test('wiring: data health keeps 5 points and names the layer in use and its fit date', () => {
  const ch = read('src/services/calibrationHealth.ts');
  assert.match(ch, /5 allowed/);
  assert.match(ch, /layerInUse\(sport\)/);
  assert.match(read('src/utils/afCalib.ts'), /minBand = 50, maxGap = 5\)/);
  const rc = read('src/services/recentCalib.ts');
  assert.match(rc, /Layer in use: recent \$\{kindName\(st\.layer\.kind\)\} layer, fitted \$\{st\.layer\.fitted/);
});

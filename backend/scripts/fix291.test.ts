// fix291: the football model lab — six candidates for a surer double-chance pick, tested walk-forward and promoted only
// by fix251's bootstrap rule. Run: npm run test:fix291 (compiles first: the tests use dist/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, '..', f), 'utf8');
const require = createRequire(import.meta.url);
const L = require(path.join(here, '..', 'dist', 'utils', 'footballLab.js'));
const SEASONS = ['2324', '2425', '2526', '2627'];

/* ---------- maths ---------- */

test('Poisson 1X2 sums to 1, is symmetric, and rho moves the draw', () => {
  const p = L.poisson1x2(1.4, 1.1);
  assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-9);
  const q = L.poisson1x2(1.2, 1.2);
  assert.ok(Math.abs(q[0] - q[2]) < 1e-9);
  assert.ok(L.poisson1x2(1.2, 1.2, -0.1)[1] > q[1]);
  assert.ok(p[0] > p[2]);
});

test('double chance: the two most likely results, right unless the left-out one happens', () => {
  assert.deepEqual(L.dcOf([0.5, 0.3, 0.2]).out, 2);
  assert.ok(Math.abs(L.dcOf([0.5, 0.3, 0.2]).p - 0.8) < 1e-9);
  assert.equal(L.dcOf([0.2, 0.3, 0.5]).out, 0);
  assert.equal(L.dcOf([0.45, 0.1, 0.45]).out, 1);
  assert.equal(L.dcHit([0.5, 0.3, 0.2], 1), true);
  assert.equal(L.dcHit([0.5, 0.3, 0.2], 2), false);
});

test('scores: log loss, Brier, DC hit rate, bands and the market on the same games', () => {
  const games = [{ y: 0, mkt: [0.6, 0.25, 0.15] }, { y: 2, mkt: null }, { y: 1, mkt: [0.3, 0.3, 0.4] }];
  const probs = [[0.7, 0.2, 0.1], [0.5, 0.3, 0.2], [0.3, 0.4, 0.3]];
  const s = L.scoreOf(games, probs);
  assert.equal(s.n, 3);
  assert.equal(s.dcHit, 66.7); // game 2: 1X left out the away win that happened
  assert.equal(s.hit, 66.7);
  assert.equal(s.hit60.n, 1);
  assert.equal(s.market.n, 2);
  assert.equal(s.bands.reduce((a: number, b: any) => a + b.n, 0), 3);
  assert.ok(Math.abs(s.logLoss - (-(Math.log(0.7) + Math.log(0.2) + Math.log(0.4)) / 3)) < 1e-3);
});

/* ---------- walk-forward ---------- */

test('windows: every season after the first, the last two judged; fitting games are only earlier ones', () => {
  const games = L.syntheticGames({ seasons: SEASONS, teams: 16, leagues: 8 });
  const w = L.seasonWindows(games, SEASONS);
  assert.deepEqual(w.map((x: any) => x.key), ['2324', '2425', '2526', '2627']);
  assert.match(w[0].label, /from/); // the first season has no earlier games: it starts after minTrain games
  assert.deepEqual(w.map((x: any) => x.judge), [false, false, true, true]);
  for (const x of w) {
    const train = L.trainFor(games, x), tst = L.testFor(games, x);
    assert.ok(train.every((g: any) => g.t < x.from));
    assert.ok(tst.every((g: any) => g.t >= x.from && g.t < x.to));
    assert.ok(train.length >= L.LAB_RULES.minTrain);
  }
});

test('no leakage: changing the results of a window does not change what was fitted for it', () => {
  const games = L.syntheticGames({ seasons: SEASONS, teams: 16, leagues: 8, seed: 5 });
  const w = L.seasonWindows(games, SEASONS);
  const target = w[2];
  const flipped = games.map((g: any) => (g.t >= target.from && g.t < target.to ? { ...g, y: (g.y + 1) % 3 } : g));
  for (const c of ['anchor', 'goals', 'draw']) {
    const a = L.run(L.fitCand(c, L.trainFor(games, target)));
    const b = L.run(L.fitCand(c, L.trainFor(flipped, target)));
    assert.deepEqual(a, b, c);
  }
});

test('lab features are taken before the game is learnt (walk-forward)', () => {
  const st = L.newLabState();
  const m = { div: 'X', home: 'a', away: 'b', hg: 3, ag: 3 };
  for (let i = 0; i < 4; i++) { L.labFeatures(st, m, null); L.labLearn(st, m); }
  const before = L.labFeatures(st, m, null);
  L.labLearn(st, { ...m, hg: 0, ag: 0 });
  const after = L.labFeatures(st, m, null);
  assert.ok(before[L.F.drawH] > 0.26 && Number.isFinite(before[L.F.gH]));
  assert.ok(after[L.F.gH] < before[L.F.gH]); // the 0–0 is only in the next game's features
  assert.ok(Number.isNaN(before[L.F.xH])); // no xG known yet
  const fx = new Float64Array(18); fx[12] = 0.4; fx[13] = 1; fx[0] = 1.5;
  const f = L.labFeatures(st, m, fx);
  assert.equal(f[L.F.xiVal], 0.4); assert.equal(f[L.F.elo], 1.5);
});

/* ---------- candidates ---------- */

test('market anchor: a weight toward a better market; none when the market adds nothing', () => {
  const good = L.syntheticGames({ seasons: SEASONS.slice(0, 2), teams: 12, leagues: 4, marketEdge: 0.7, drawSignal: 0 });
  const a = L.run(L.fitAnchor(good));
  assert.ok(a.all >= 0.3, `weight ${a.all}`);
  const perfect = L.syntheticGames({ seasons: SEASONS.slice(0, 2), teams: 12, leagues: 4, champSd: 0, drawSignal: 0, marketEdge: 0 });
  assert.ok(L.run(L.fitAnchor(perfect)).all <= 0.1);
  assert.equal(L.run(L.fitAnchor(good.slice(0, 50))), null); // < 80 priced games
  // no price on a game → unchanged
  assert.deepEqual(L.applyAnchor([0.5, 0.3, 0.2], null, 'big', { all: 0.5, big: 0.5, rest: 0.5, n: 100 }), [0.5, 0.3, 0.2]);
});

test('draw model: learns draw-prone teams; a layer without inputs leaves the numbers alone', () => {
  const games = L.syntheticGames({ seasons: SEASONS.slice(0, 3), teams: 12, leagues: 6, drawSignal: 0.25, champSd: 0.2 });
  const P = L.run(L.fitShift(games, 'draw'));
  assert.ok(P.c[2] > 0, `habit weight ${P.c[2]}`);
  const lineup = L.run(L.fitShift(games, 'lineup'));
  assert.equal(lineup, null); // no line-up inputs in made-up games
  const q = L.applyShift([0.5, 0.3, 0.2], { f: null, group: 'rest' }, { kind: 'lineup', mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1], b: [1, 1, 1, 1, 1, 1], c: [0, 0, 0, 0, 0, 0] });
  assert.ok(Math.abs(q[0] - 0.5) < 1e-9);
  // the draw shift keeps the home : away ratio
  const d = L.applyShift([0.5, 0.25, 0.25], { f: null, group: 'big' }, { kind: 'draw', mean: [0, 0, 0, 0, 0, 0], sd: [0, 0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0, 0], c: [0.3, 0, 0, 0, 0, 0] });
  assert.ok(d[1] > 0.25 && Math.abs(d[0] / d[2] - 2) < 1e-9);
});

test('boosted trees: fit from the champion, unknown inputs go left, deterministic', () => {
  const games = L.syntheticGames({ seasons: SEASONS.slice(0, 2), teams: 16, leagues: 8 });
  const a = L.run(L.fitGbm(games, 0, [])), b = L.run(L.fitGbm(games, 0, []));
  assert.deepEqual(a, b);
  assert.equal(a.t.length, L.LAB_RULES.gbm.rounds);
  const x = L.gbmX({ p: [0.5, 0.3, 0.2], mkt: null, f: null, rows: null }, 0);
  const p = L.applyTrees([0.5, 0.3, 0.2], x, a);
  assert.ok(Math.abs(p[0] + p[1] + p[2] - 1) < 1e-9);
});

/* ---------- the verdict ---------- */

test('verdict: fix251 rule — 300 games each, better in both, 90% of resamples; the combiner needs 0.003', () => {
  const W = (n: number, diff: number) => ({ s: { key: 'w', n, diff, hitC: 50, hitB: 50 }, d: Array.from({ length: n }, (_, i) => diff + (i % 2 ? 0.05 : -0.05)) });
  assert.equal(L.judge('draw', W(200, -0.01), W(400, -0.01), null).pass, false);
  assert.match(L.judge('draw', W(400, 0.001), W(400, -0.01), null).why, /not better last season/);
  assert.match(L.judge('draw', W(400, -0.01), W(400, -0.0002), null).why, /gain too small/);
  assert.equal(L.judge('draw', W(400, -0.01), W(400, -0.01), null).pass, true);
  assert.match(L.judge('gbm', W(400, -0.002), W(400, -0.002), null).why, /combiner needs/);
  assert.equal(L.judge('gbm', W(400, -0.004), W(400, -0.004), null).pass, true);
  // the public record's 60 days must not be worse
  assert.match(L.judge('draw', W(400, -0.01), W(400, -0.01), { key: 'record', n: 400, diff: 0.002, hitC: 0, hitB: 0 }).why, /public record/);
  // noise around 0 fails the bootstrap even when both means are a hair below 0
  const noisy = (n: number, m: number, seed: number) => { let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647); return { s: { key: 'w', n, diff: m, hitC: 50, hitB: 50 }, d: Array.from({ length: n }, () => m + (r() - 0.5) * 2) }; };
  const v = L.judge('draw', noisy(400, -0.0006, 3), noisy(400, -0.0006, 7), null);
  assert.equal(v.pass, false);
});

test('a whole lab run: a better market and draw-prone teams are found and promoted', () => {
  const games = L.syntheticGames({ seasons: SEASONS, teams: 14, leagues: 6, drawSignal: 0.2, marketEdge: 0.6 });
  const r = L.runLab(games, L.seasonWindows(games, SEASONS));
  const by = (c: string) => r.cands.find((x: any) => x.cand === c);
  assert.equal(by('anchor').verdict.pass, true, by('anchor').verdict.why);
  assert.equal(by('draw').verdict.pass, true, by('draw').verdict.why);
  assert.equal(by('lineup').verdict.pass, false);
  assert.ok(r.winner && r.live && r.live.cand === r.winner);
  for (const c of r.cands) for (const w of c.windows) assert.equal(w.score.n, r.champion.find((x: any) => x.key === w.key).score.n);
  // pick rule: thresholds per league, fewer and surer picks
  const pr = r.pickRule[r.pickRule.length - 1].rule;
  assert.ok(pr.shown.n <= pr.all.n && pr.shown.hit >= pr.all.hit - 0.5);
  assert.ok(pr.pooled.every((p: any, i: number, a: any[]) => i === 0 || p.n <= a[i - 1].n));

});

test('a perfect champion is left alone (three made-up worlds where nothing can beat it)', () => {
  // the rule lets a lucky candidate through ~10% of the time per candidate (fix251's 90%); over these seeds none does
  for (const seed of [1, 2, 3]) {
    const perfect = L.syntheticGames({ seasons: SEASONS, teams: 14, leagues: 6, drawSignal: 0, champSd: 0, marketEdge: 0, seed });
    const r = L.runLab(perfect, L.seasonWindows(perfect, SEASONS), { cands: ['anchor', 'goals', 'lineup', 'draw'] });
    assert.equal(r.winner, null, `seed ${seed}: ${r.winnerWhy}`);
    assert.equal(r.live, null);
  }
});

/* ---------- wiring ---------- */

test('wiring: route, job, live layer before the league layer, pre-layer numbers off the payload, admin card', () => {
  const app = read('src/app.ts'), jobs = read('src/jobs.ts'), lf = read('src/services/leagueFixLive.ts'), tr = read('src/services/tracking.ts');
  const live = read('src/services/footballLabLive.ts'), svc = read('src/services/footballLab.ts');
  assert.match(app, /app\.get\('\/api\/admin\/football-lab'/);
  assert.doesNotMatch(app.slice(app.indexOf('const OPEN_API'), app.indexOf('const OPEN_API') + 4000), /football-lab/);
  assert.match(jobs, /footballLabDue\(\)/);
  assert.match(lf, /applyLab\(match, predsIn\)/);
  assert.match(tr, /lab_raw/);
  assert.match(tr, /labRawFor\(m\.id, p\.model\)/);
  assert.doesNotMatch(live, /lab: \{ cand: L\.cand, raw/); // the numbers before the layer never ride on the prediction
  assert.match(svc, /promotionWait/);
  assert.match(svc, /guardWorse/);
  const tabs = fs.readFileSync(path.join(here, '..', '..', 'frontend', 'src', 'lib', 'adminTabs.ts'), 'utf8');
  const admin = fs.readFileSync(path.join(here, '..', '..', 'frontend', 'src', 'pages', 'Admin.tsx'), 'utf8');
  assert.match(tabs, /id: 'football-lab', tab: 'models', title: 'Football lab'/);
  assert.match(admin, /<FootballLabCard \/>/);
  // the public name stays until a promotion
  assert.match(read('src/utils/modelNames.ts'), /football: \{ name: 'SL Football', version: '3\.0'/);
});

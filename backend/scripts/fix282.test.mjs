// fix282: "Why we think so" — every factor, ranked, from the model's own numbers (Yarin, 29 Oct: "I don't like when the
// model writes Barça will win because they have a better squad value, there are many other things"). (dist build)
// Run: npm run test:fix282
//  1. shares sum to 100% and come from the model's points (football rows, basketball grid / bb-v3, NFL Elo, tennis logit)
//  2. sorted by share; a factor with zero points is listed as "no effect" with its reason
//  3. the side named as having the edge has the better number (Barça–Villa, 3 Nov CL: form 5.1 vs 8.9 "edge Barça",
//     goals xG 2.75 vs 1.64 "edge Villa"): the cup / national fits keep "more is better" weights ≥ 0, the shown 0–10
//     score is strictly increasing (no "10.0 vs 10.0" with an edge)
//  4. every sport renders the panel (football PredictionStory, basketball / NFL / tennis WinnerPrediction)
//  5. no market price on a public route: the market anchor is a share of the edge, never a price or a line
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const W = require('../dist/utils/whyFactors.js');
const K = require('../dist/utils/marketKeys.js');
const SRC = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
const FRONT = f => fs.readFileSync(path.join(here, '../../frontend/src', f), 'utf8');

const sum = xs => xs.reduce((s, x) => s + x, 0);

/** a football grid like grid-v3 sends it (Barça–Villa style: big edges, a few rows with no effect) */
const GRID = {
  homeEdge: 34.5,
  rows: [
    { id: '#1', name: 'Squad value', rel: 4, home: 9.8, away: 7.1, edge: 10.8, note: 'top-15 value €1050m vs €560m' },
    { id: '#1e', name: 'Overall strength', rel: 5, home: 9.1, away: 7.4, edge: 8.5 },
    { id: '#12', name: 'Confirmed lineups', rel: 2, home: 5.5, away: 5.5, edge: 0, note: 'XI not published yet' },
    { id: '#13', name: 'Missing players', rel: 2, home: 5.5, away: 5.5, edge: 0, note: 'out: none | none' },
    { id: '#19', name: 'Attack', rel: 3, home: 8.8, away: 7.0, edge: 5.4 },
    { id: '#14', name: 'Defence', rel: 3, home: 7.2, away: 7.6, edge: -1.2 },
    { id: '#10', name: 'Rest and fixture load', rel: 1, home: 6, away: 6, edge: 0, note: '1 vs 1 games in the last 8 days' },
    { id: '#7', name: 'Head-to-head', rel: 2, home: 5, away: 5, edge: 0, note: 'only 2 meetings in the data — not enough to count' },
    { id: '#21', name: 'Form, last 6', rel: 3, home: 5.1, away: 8.9, edge: -11.4, note: 'last 6: 8 vs 15 pts' },
    { id: '#15', name: 'Draw-prone teams', rel: 2, home: 5, away: 5, edge: 0 },
    { id: '#30', name: 'League draw rate', rel: 1, home: 5, away: 5, edge: 0 },
    { id: '#1p', name: 'Player quality', rel: 0, home: 5.5, away: 5.5, edge: 0 }
  ]
};

/* ---------- 1–2. shares, order, no effect ---------- */

test('shares: whole percents that sum to exactly 100, each = |points| / Σ|points| of the model', () => {
  for (const pts of [[10.8, 8.5, 5.4, -1.2, -11.4, 34.5], [1, 1, 1], [0.3, 99.7], [5], [2, -2, 2, -2, 1e-3]]) {
    const s = W.sharesOf(pts);
    assert.equal(sum(s), 100, `${pts} → ${s}`);
    const tot = sum(pts.map(Math.abs));
    pts.forEach((p, i) => assert.ok(Math.abs(s[i] - (100 * Math.abs(p)) / tot) < 1, `share ${s[i]} vs ${(100 * Math.abs(p)) / tot}`));
  }
  assert.deepEqual(W.sharesOf([0, 0]), [0, 0], 'nothing moves → no shares');
});

test('football: the panel is the grid rows + the home term, sorted by share, zero rows listed as no effect with the reason', () => {
  const v = W.whyView(W.footballFactors(GRID), 'H');
  assert.equal(sum(v.rows.map(r => r.share)), 100);
  const tot = 34.5 + 10.8 + 8.5 + 5.4 + 1.2 + 11.4;
  for (const r of v.rows) assert.ok(Math.abs(r.share - (100 * Math.abs(r.pts)) / tot) < 1, `${r.k} ${r.share}`);
  assert.deepEqual(v.rows.map(r => r.k), ['home', '#21', '#1', '#1e', '#19', '#14'], 'biggest share first');
  for (let i = 1; i < v.rows.length; i++) assert.ok(v.rows[i - 1].share >= v.rows[i].share);
  // the draw rows and a row with no weight are not factors of the edge
  assert.ok(!v.rows.concat(v.idle).some(r => ['#15', '#30', '#1p'].includes(r.k)));
  const idle = Object.fromEntries(v.idle.map(i => [i.k, i.idle]));
  assert.deepEqual(idle, { '#12': 'lineups', '#13': 'missing', '#10': 'level', '#7': 'meetings' });
  assert.equal(v.n, 10, 'N = the factors the model used (6 moving + 4 with no effect)');
  // closing line: the top factors for the favourite, the strongest against (form helps Villa)
  assert.deepEqual(v.lead.map(r => r.k), ['home', '#1', '#1e']);
  assert.equal(v.against.k, '#21');
  assert.equal(v.against.side, 'A');
});

test('a factor with zero points is "no effect", never a row with a share', () => {
  const v = W.whyView([{ k: 'a', pts: 3 }, { k: 'b', pts: 0, idle: 'missing' }, { k: 'c', pts: 0 }]);
  assert.deepEqual(v.rows.map(r => [r.k, r.share]), [['a', 100]]);
  assert.deepEqual(v.idle, [{ k: 'b', idle: 'missing' }, { k: 'c', idle: 'level' }]);
  assert.equal(v.n, 3);
});

/* ---------- 3. the edge side and the two numbers agree ---------- */

test('Barça–Villa (3 Nov, CL): the two rows as published contradicted their numbers — the check catches both', () => {
  // as the page showed them: "Form, last 6 · Barça · small edge" with 5.1 / 8.9; "Goals · Aston Villa" with xG 2.75 / 1.64
  const form = { home: 5.1, away: 8.9, edge: 2.1 };
  const goals = { home: 2.75, away: 1.64, edge: -1.8 };
  assert.equal(W.edgeAgrees(form), false);
  assert.equal(W.edgeAgrees(goals), false);
});

test('the cause: a negative fitted weight — kept ≥ 0 now, so edge = weight × (home − away) always names the better side', () => {
  // elo-euro's rows: edge = w × feature difference, scores = the same feature scaled; a fitted w_form −0.35 flipped it
  const rowsOf = w => [
    { home: 5.1, away: 8.9, edge: Math.round(w.w_form * (5.1 - 8.9) * 250) / 10 },
    { home: 2.75, away: 1.64, edge: Math.round(w.w_goals * Math.log(2.75 / 1.64) * 250) / 10 }
  ];
  const fitted = { w_form: -0.35, w_goals: -0.2 };
  assert.ok(rowsOf(fitted).every(r => !W.edgeAgrees(r)), 'the published weights reproduce the bug');
  const kept = Object.fromEntries(Object.entries(fitted).map(([k, v]) => [k, W.keepSign(k, v)]));
  assert.ok(rowsOf(kept).every(r => W.edgeAgrees(r)));
  // any positive weight: the edge goes to the higher number (random cases)
  for (let i = 0; i < 500; i++) {
    const h = Math.random() * 12 - 1, a = Math.random() * 12 - 1, w = W.keepSign('w_form', Math.random() * 2 - 1);
    assert.ok(W.edgeAgrees({ home: h, away: a, edge: Math.round(w * (h - a) * 250) / 10 }));
  }
  assert.equal(W.keepSign('c_cl', -0.4), -0.4, 'a constant is not a "more is better" weight');
  // both fits use it (and a weight of 0 shows Rel. 0: the model did not use the row)
  for (const f of ['src/services/clubElo.ts', 'src/services/nationalElo.ts']) {
    const s = SRC(f);
    assert.match(s, /w\[k\] = keepSign\(k, old \+ dir \* step\)/, `${f}: the fit step keeps the sign`);
    assert.match(s, /keepSign\(k, v as number\)/, `${f}: the start keeps the sign`);
    assert.match(s, /const relOf = \(x: number\) => \(Math\.abs\(x\) < 1e-9 \? 0/, `${f}: weight 0 = Rel. 0`);
  }
});

test('the shown 0–10 score is strictly increasing: the edge side always shows the higher score, never above 10', () => {
  let prev = -1;
  for (let x = -3; x <= 15; x += 0.05) {
    const s = W.shownScore(x);
    assert.ok(s > prev && s >= 0 && s < 10, `${x} → ${s}`);
    prev = s;
  }
  assert.ok(W.shownScore(12.4) > W.shownScore(11.1), 'two strong teams are not both 10.0');
  assert.equal(W.shownScore(5.1), 5.1, 'the usual range is unchanged');
  // grid-v3 rows: edge = rel × (home − away), so any row agrees with its values and the shown scores
  for (const r of GRID.rows) {
    assert.ok(W.edgeAgrees(r), r.name);
    assert.ok(W.edgeAgrees({ home: W.shownScore(r.home), away: W.shownScore(r.away), edge: r.edge }), `${r.name} (shown)`);
  }
  assert.match(FRONT('lib/predict.ts'), /export const score10 = shownScore/);
});

/* ---------- 4. every sport ---------- */

test('basketball bb-v4: grid rows + the anchor move in the same 1,000 points; bb-v3 terms otherwise', () => {
  const grid = { rows: [{ key: 'team', edge: 90 }, { key: 'impact', edge: 25 }, { key: 'home', edge: 30 }, { key: 'missing', edge: -15 }, { key: 'h2h', edge: 0 }] };
  const v = W.whyView(W.bbGridFactors(grid, { pModel: 0.63, pHome: 0.655 }), 'H');
  assert.equal(sum(v.rows.map(r => r.share)), 100);
  const m = v.rows.find(r => r.k === 'market');
  assert.equal(m.pts, 25, 'the anchor = 1,000 × (shown − model) chance: a move, not the market chance');
  assert.deepEqual(v.idle, [{ k: 'bb.h2h', idle: 'meetings' }]);
  assert.ok(!v.lead.some(r => r.k === 'market') && v.against?.k === 'bb.missing', 'the market is never named as a reason');
  const v3 = W.whyView(W.bbV3Factors([{ kind: 'strength', side: 'A', points: 4.2 }, { kind: 'attack', side: 'A', points: 3 }, { kind: 'home', side: 'H', points: 2.5 }, { kind: 'b2b', side: 'H', points: 1.1 }]), 'A');
  assert.deepEqual(v3.rows.map(r => [r.k, r.pts]), [['bb.team', -4.2], ['bb.home', 2.5], ['bb.rest', 1.1]], 'attack is part of strength, not counted twice');
  assert.ok(v3.idle.some(i => i.k === 'bb.missing' && i.idle === 'missing'));
});

test('American football: the Elo terms of the margin (rating, home field, rest, quarterbacks) + the anchor in Elo points', () => {
  const why = { eloGap: 60, homeField: 48, neutral: false, restAdj: [0, -25], qb: [null, { adj: -40 }] };
  const v = W.whyView(W.nflFactors(why, { pModel: 0.7, pHome: 0.7 }), 'H');
  assert.deepEqual(v.rows.map(r => [r.k, r.pts]), [['nfl.rating', 60], ['nfl.home', 48], ['nfl.qb', 40], ['nfl.rest', 25]]);
  assert.equal(sum(v.rows.map(r => r.share)), 100);
  assert.ok(!v.rows.some(r => r.k === 'market'), 'no anchor move → no market row');
  const neutral = W.whyView(W.nflFactors({ ...why, neutral: true, restAdj: [0, 0], qb: [null, null] }), 'H');
  assert.deepEqual(neutral.idle, [{ k: 'nfl.home', idle: 'neutral' }, { k: 'nfl.rest', idle: 'rest' }, { k: 'nfl.qb', idle: 'missing' }]);
});

test('tennis: the model\'s logit terms, fatigue parts grouped', () => {
  const v = W.whyView(W.tennisFactors({ elo: 0.62, point: 0.21, m3: -0.05, m7: -0.03, home: 0, rankTrend: 0.04 }), 'H');
  assert.deepEqual(v.rows.map(r => r.k), ['tn.rating', 'tn.serve', 'tn.fatigue', 'tn.rank']);
  assert.equal(sum(v.rows.map(r => r.share)), 100);
  assert.deepEqual(v.idle, [{ k: 'tn.home', idle: 'level' }]);
});

test('every sport renders the panel; admins keep Factor by factor / How it adds up', () => {
  assert.equal(FRONT('lib/whyFactors.ts'), SRC('src/utils/whyFactors.ts'), 'the two copies of whyFactors are identical');
  const story = FRONT('components/PredictionStory.tsx');
  assert.match(story, /<WhyPanel factors=\{footballFactors\(g\)\}/);
  assert.match(story, /\{admin && moving\.length > 0 && \(/, 'Factor by factor: admins only');
  assert.match(story, /\{admin && <Block title=\{tt\("How it adds up"\)\}>/, 'How it adds up: admins only');
  assert.ok(!/ex\.forPick\.map/.test(story), 'the single "+ reason" lines are gone');
  const wp = FRONT('components/sport/game/WinnerPrediction.tsx');
  assert.match(wp, /<WhyPanel factors=\{x\.factors\}/, 'fix281: the panel opens from the "Why we think so" button');
  assert.match(wp, /\(!x\.factors\?\.length \|\| admin\)/, 'the old why lines: admins only once the panel is there');
  for (const f of ['pages/bb/BbGame.tsx', 'pages/nfl/NflGame.tsx', 'pages/tennis/TennisMatch.tsx']) assert.match(FRONT(f), /factors=\{/, f);
  assert.match(SRC('src/services/bbSite.ts'), /factors: \(full \|\| game\.state === 'done'\) \? bbFactorsOf\(g, pr, why\) : null/);
  assert.match(SRC('src/services/nflModel.ts'), /factors: why \? nflFactors\(why/);
  assert.match(SRC('src/services/tennisSite.ts'), /factors: s\.why\?\.terms \? tennisFactors\(s\.why\.terms\) : null/);
  assert.match(SRC('src/services/gridModel.ts'), /homeEdge: Math\.round\(\(CONV\.homeGap/);
  // the panel names every factor key it can get, and says what the market row is
  const panel = FRONT('components/sport/game/WhyPanel.tsx');
  for (const k of ['#1', '#1e', '#12', '#13', '#19', '#14', 'goals', '#10', 'rest', '#23', 'home', '#7', '#21', ...Object.values(W.TENNIS_GROUP),
    ...['impact', 'net100', 'team', 'missing', 'fourFactors', 'rest', 'home', 'carry', 'matchup', 'form', 'motivation', 'h2h', 'talent'].map(x => `bb.${x}`), 'nfl.rating', 'nfl.home', 'nfl.rest', 'nfl.qb'])
    assert.ok(panel.includes(`case '${k}':`), `WhyPanel names ${k}`);
  assert.match(panel, /Where the market stands — used inside the model only/);
});

/* ---------- 5. never a price ---------- */

test('no market price on a public route: factors are {k, pts, idle} only and pass stripMarket untouched', () => {
  const lists = [
    W.bbGridFactors({ rows: [{ key: 'team', edge: 80 }] }, { pModel: 0.6, pHome: 0.64 }),
    W.bbV3Factors([{ kind: 'strength', side: 'H', points: 3 }], { pModel: 0.6, pHome: 0.64, sigma: 12 }),
    W.nflFactors({ eloGap: 30, homeField: 48, neutral: false, restAdj: [0, 0], qb: [null, null] }, { pModel: 0.6, pHome: 0.66 }),
    W.footballFactors(GRID), W.tennisFactors({ elo: 0.4 })
  ];
  for (const f of lists) {
    for (const x of f) assert.deepEqual(Object.keys(x).filter(k => !['k', 'pts', 'idle'].includes(k)), [], JSON.stringify(x));
    const body = { game: { factors: f } };
    assert.deepEqual(K.stripMarket(body), body, 'nothing in factors is a market field');
  }
  const m = lists[0].find(x => x.k === 'market');
  assert.equal(m.pts, 40, 'a move of the chance (64 − 60 = 4 points of 100 = 40 of 1,000), not the market\'s 64%');
  assert.ok(lists[2].find(x => x.k === 'market').pts < 60, 'NFL: an Elo move, not a price');
});

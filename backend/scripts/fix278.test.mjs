// fix278: close to the market on every market (Yarin, 29 Oct: "there is no chance we give a basketball game 215+ while
// the market gives 225+"). (dist build) Run: npm run test:fix278
//  1. stripMarket keeps every new market field off public routes (market lines, closing lines, gaps, the anchor's market).
//  2. The consensus line of several books (median of the books' main lines, snapped to an offered line).
//  3. The anchor weight is picked out of sample (walk-forward: a game's weight only from the games before it) and kept
//     only when it beats the model alone and the market alone.
//  4. The gate refuses a calibrated output that sits 5 points from the market.
//  5. A game with no market line uses the model only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const SRC = f => fs.readFileSync(path.join(here, '..', f), 'utf8');
const require = createRequire(import.meta.url);
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];
const M = require(DIST + '/utils/marketLines.js');
const K = require(DIST + '/utils/marketKeys.js');

/** a child process (one process, every role) on an empty database */
function child(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix278-'));
  const env = { ...process.env, DATA_DIR: dir, SL_ROLE: 'all', THREAD_JOBS: '0', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', MARKET_LINES: 'off' };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', `const D = ${JSON.stringify(DIST)};\n(async () => {\n${code}\n})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });`], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* ---------- 1. stripMarket ---------- */

test('stripMarket: every market-lines field is dropped, bet-type strings stay', () => {
  const body = {
    data: {
      game: { id: 1, total: 233.8, margin: -1.1, anchored: true, market: 'double chance' },
      marketLine: 238, marketLines: [{ market: 'total', line: 238 }], closingLine: 237.5, closing: { total: 237.5 }, consensus: { line: 238 },
      marketGap: -4.2, gapToMarket: -4.2, marketTotal: 238, marketSpread: -1.5, marketChance: 0.55, anchorMarket: 238, marketGaps: [1],
      odds: { home: 1.9 }, books: 7, bookmakers: ['x'], price: 1.9,
      nested: [{ market: { line: 238 }, rows: [{ marketLine: 1, ok: 2 }] }]
    }
  };
  const out = K.stripMarket(body);
  const text = JSON.stringify(out);
  for (const k of ['marketLine', 'marketLines', 'closingLine', '"closing"', 'consensus', 'marketGap', 'gapToMarket', 'marketTotal', 'marketSpread', 'marketChance', 'anchorMarket', 'marketGaps', 'odds', 'books', 'bookmakers', 'price'])
    assert.ok(!text.includes(k), `${k} left in a public answer`);
  assert.equal(out.data.game.market, 'double chance', 'a bet-type string stays');
  assert.equal(out.data.game.total, 233.8);
  assert.equal(out.data.game.anchored, true);
  assert.deepEqual(out.data.nested, [{ rows: [{ ok: 2 }] }]);
});

test('stripMarket: app.ts uses the shared one, the report route is admin-only, the extras never carry a market number', () => {
  const app = SRC('src/app.ts');
  assert.match(app, /import \{ stripMarket \} from '\.\/utils\/marketKeys'/);
  assert.ok(!/function stripMarket/.test(app), 'one stripMarket (utils/marketKeys.ts)');
  assert.match(app, /app\.get\('\/api\/admin\/market-gap'/);
  const open = app.slice(app.indexOf('OPEN_API'), app.indexOf('OPEN_API') + 20000);
  assert.ok(!/market-gap|market-lines/.test(open.slice(0, open.indexOf(']') + 1)), 'not in OPEN_API');
  // the anchored payloads carry the blended number and `anchored`, never the market's own line
  const anchor = SRC('src/services/marketAnchor.ts');
  assert.ok(!/info: \{[^}]*market/.test(anchor), 'no market number in the extras info');
  const ml = SRC('src/services/marketLines.ts');
  assert.match(ml, /admin-only/);
});

/* ---------- 2. consensus ---------- */

const book = (name, bets) => ({ name, bets });
test('consensus: the median of three books\' main totals, snapped to an offered line; spread keyed by the home handicap', () => {
  const books = [
    book('A', [{ name: 'Over/Under', values: [{ value: 'Over 224.5', odd: '1.90' }, { value: 'Under 224.5', odd: '1.90' }, { value: 'Over 230.5', odd: '2.60' }, { value: 'Under 230.5', odd: '1.45' }] },
      { name: 'Asian Handicap', values: [{ value: 'Home -5.5', odd: '1.91' }, { value: 'Away +5.5', odd: '1.89' }, { value: 'Home -3.5', odd: '1.60' }, { value: 'Away +3.5', odd: '2.30' }] },
      { name: 'Home/Away', values: [{ value: 'Home', odd: '1.40' }, { value: 'Away', odd: '3.00' }] }]),
    book('B', [{ name: 'Over/Under', values: [{ value: 'Over 225.5', odd: '1.87' }, { value: 'Under 225.5', odd: '1.93' }] },
      { name: 'Asian Handicap', values: [{ value: 'Home -6.5', odd: '1.95' }, { value: 'Away +6.5', odd: '1.85' }] },
      { name: 'Home/Away', values: [{ value: 'Home', odd: '1.38' }, { value: 'Away', odd: '3.10' }] }]),
    book('C', [{ name: 'Over/Under', values: [{ value: 'Over 226.5', odd: '1.95' }, { value: 'Under 226.5', odd: '1.85' }, { value: 'Over 225.5', odd: '1.80' }, { value: 'Under 225.5', odd: '2.00' }] },
      { name: 'Asian Handicap', values: [{ value: 'Home -5.5', odd: '1.88' }, { value: 'Away +5.5', odd: '1.92' }] },
      { name: 'Home/Away', values: [{ value: 'Home', odd: '1.42' }, { value: 'Away', odd: '2.90' }] }])
  ];
  const c = Object.fromEntries(M.gameConsensus('basketball', books).map(x => [x.market, x]));
  assert.equal(c.total.line, 225.5, 'median of 224.5 / 225.5 / 226.5');
  assert.equal(c.total.books, 2, 'two books price 225.5');
  assert.equal(c.total.prices.over, 1.84);
  assert.equal(M.marketTotal(c.total), 225.5);
  assert.equal(c.spread.line, -5.5, 'median of −5.5 / −6.5 / −5.5');
  assert.equal(M.marketMargin(c.spread), 5.5, 'home by 5.5');
  assert.equal(c.ml.prices.Home, 1.4);
  assert.ok(Math.abs(c.ml.p.Home + c.ml.p.Away - 1) < 0.002, 'margin-free');
  assert.ok(c.ml.p.Home > 0.67 && c.ml.p.Home < 0.69);
});

test('consensus: football over / under 1.5 / 2.5 / 3.5 as their own markets, BTTS, a swapped twin', () => {
  const ou = vs => ({ name: 'Goals Over/Under', values: vs });
  const books = [
    book('A', [ou([{ value: 'Over 2.5', odd: '1.80' }, { value: 'Under 2.5', odd: '2.00' }, { value: 'Over 1.5', odd: '1.25' }, { value: 'Under 1.5', odd: '3.80' }]),
      { name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.70' }, { value: 'No', odd: '2.10' }] },
      { name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: '1.95' }, { value: 'Away +0.5', odd: '1.90' }] }]),
    book('B', [ou([{ value: 'Over 2.5', odd: '1.85' }, { value: 'Under 2.5', odd: '1.95' }, { value: 'Over 3.5', odd: '3.10' }, { value: 'Under 3.5', odd: '1.35' }]),
      { name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.75' }, { value: 'No', odd: '2.05' }] }])
  ];
  const list = M.gameConsensus('football', books);
  const c = Object.fromEntries(list.map(x => [x.market, x]));
  assert.deepEqual(Object.keys(c).sort(), ['ah', 'btts', 'ou1.5', 'ou2.5', 'ou3.5']);
  assert.equal(c['ou2.5'].line, 2.5);
  assert.equal(c['ou2.5'].books, 2);
  assert.ok(c['ou2.5'].p.over > 0.5 && c['ou2.5'].p.over < 0.53);
  assert.ok(c.btts.p.Yes > 0.54 && c.btts.p.Yes < 0.56);
  const sw = Object.fromEntries(M.swapConsensus(list).map(x => [x.market, x]));
  assert.equal(sw.ah.line, 0.5, 'handicap seen from the other side');
  assert.equal(sw['ou2.5'].line, 2.5, 'totals unchanged');
});

/* ---------- 3. the anchor weight, out of sample ---------- */

/** seeded noise */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
function rows(n, seed, { bias = -4, mNoise = 4, kNoise = 8, aNoise = 12 } = {}) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const truth = 225 + 10 * gauss(r), actual = truth + aNoise * gauss(r);
    out.push({ t: i, model: truth + bias + kNoise * gauss(r), market: truth + mNoise * gauss(r), actual });
  }
  return out;
}

test('anchor: each test game\'s weight comes only from the games before it', () => {
  const a = rows(600, 7), b = a.map((x, i) => (i >= 400 ? { ...x, actual: x.actual + 500, market: x.market - 300 } : x));
  const wa = M.walkWeights('line', a), wb = M.walkWeights('line', b);
  // weights of test games 101 … 400 use games 1 … 400 only: changing games 401+ cannot move them
  assert.deepEqual(wa.slice(0, 300), wb.slice(0, 300));
  assert.equal(wa.length, 500);
});

test('anchor: a model 4 points low with a sharper market → a weight is kept, out of sample better than both', () => {
  const f = M.fitAnchor('line', rows(800, 11));
  assert.equal(f.kept, true, f.why);
  assert.ok(f.w > 0 && f.w < 1, `w ${f.w}`);
  assert.ok(f.oos.blend < f.oos.model && f.oos.blend < f.oos.market, JSON.stringify(f.oos));
  assert.equal(f.tested, 700, 'the first 100 games only train');
});

test('anchor: under 300 games, or a blend not better than the market alone → model only', () => {
  const few = M.fitAnchor('line', rows(250, 3));
  assert.equal(few.kept, false); assert.equal(few.w, 0);
  assert.match(few.why, /250 of 300 games/);
  // the market is the truth itself: blending can only tie it at w = 1, never beat it
  const exact = rows(600, 5).map(x => ({ ...x, market: x.actual }));
  const f = M.fitAnchor('line', exact);
  assert.equal(f.kept, false, f.why);
  assert.equal(f.w, 0);
  // a useless market (pure noise around a far-off level) is never blended in
  const bad = rows(600, 9).map(x => ({ ...x, market: 150 + 40 * Math.sin(x.t) }));
  assert.equal(M.fitAnchor('line', bad).kept, false);
});

test('anchor: chances (log loss) and per-group fits at 300+ games', () => {
  const r = rng(21), rs = [];
  for (let i = 0; i < 900; i++) {
    const p = 0.2 + 0.6 * r(), won = r() < p ? 1 : 0;
    // two views of the same chance with their own (equal) errors: the blend beats each one
    rs.push({ t: i, model: Math.min(0.95, Math.max(0.05, p + 0.3 * (r() - 0.5))), market: Math.min(0.95, Math.max(0.05, p + 0.3 * (r() - 0.5))), actual: won, group: i % 3 === 0 ? 'NBA' : 'Europe' });
  }
  const fits = M.fitAnchorGroups('chance', rs);
  assert.ok(fits.all && fits.NBA && fits.Europe, 'NBA has 300 games: its own fit');
  assert.ok(fits.all.kept, fits.all.why);
  assert.equal(M.anchorWeightOf(fits, 'Rest of the world'), fits.all.w, 'a group without 300 games uses the sport\'s');
});

test('level: the season\'s points per game so far, shrunk by games played; kept only when better walk-forward', () => {
  assert.equal(M.levelShift([], 40), 0);
  assert.equal(M.levelShift(Array.from({ length: 40 }, () => ({ predicted: 220, actual: 226 })), 40), 3, '40 games of +6 at k 40 → +3');
  const r = rng(4), lr = [];
  for (let i = 0; i < 600; i++) lr.push({ t: i, league: i % 2 ? 'NBA' : 'EL', season: '2026', predicted: 220, actual: 225 + 10 * gauss(r) });
  const t = M.levelTest(lr, 40);
  assert.equal(t.kept, true, t.why);
  assert.ok(t.maeShift < t.maeModel);
  // a hot start that does not last (20 games 20 points over, then exactly as predicted): the shift only hurts → not applied
  const fade = Array.from({ length: 600 }, (_, i) => ({ t: i, league: 'NBA', season: '2026', predicted: 220, actual: i < 20 ? 240 : 220 }));
  assert.equal(M.levelTest(fade, 40).kept, false, M.levelTest(fade, 40).why);
});

/* ---------- 4. the gate ---------- */

test('gate rule: a calibrated output 5 points from the market is refused, within the limit passes, collecting = admin-only', () => {
  assert.equal(M.marketGateWhy('basketball', 'total', { n: 400, medianAbs: 5, feed: true }), '5 points from the market on totals (limit 3)');
  assert.equal(M.marketGateWhy('basketball', 'total', { n: 400, medianAbs: 2.5, feed: true }), null);
  assert.equal(M.marketGateWhy('basketball', 'margin', { n: 400, medianAbs: 2.4, feed: true }), '2.4 points from the market on the spread (limit 2)');
  assert.equal(M.marketGateWhy('nfl', 'total', { n: 400, medianAbs: 2.6, feed: true }), '2.6 points from the market on totals (limit 2.5)');
  assert.match(M.marketGateWhy('football', 'goals', { n: 400, medianAbs: 5.5, feed: true }), /chance on over \/ under 2\.5 \(limit 5\)/);
  assert.match(M.marketGateWhy('basketball', 'total', { n: 120, medianAbs: 1, feed: true }), /collecting market lines: 120 of 300/);
  assert.equal(M.marketGateWhy('tennis', 'games', { n: 0, medianAbs: null, feed: false }), null, 'not in the feed: calibration only');
  assert.equal(M.marketGateWhy('basketball', 'ot', { n: 400, medianAbs: 9, feed: true }), null, 'no market for overtime');
});

test('gate: a calibrated basketball total 5 points under the closing line on 320 settled games goes admin-only with the reason', () => {
  const out = child(`
    const { db } = require(D + '/db');
    const MP = require(D + '/services/morePredictions.js');
    const A = require(D + '/services/marketAnchor.js');
    const ins = db.prepare("INSERT INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, settled, result) VALUES ('basketball', ?, 'bb-v4', ?, ?, ?, 1, '{}')");
    const t0 = Date.now() - 40 * 86400000;
    for (let i = 1; i <= 320; i++) {
      const k = new Date(t0 + i * 3600000).toISOString();
      ins.run(i, k, k, JSON.stringify({ sport: 'basketball', v: 1, sets: {}, info: { expected: [110, 110] } }));
      A.storeLines('basketball', i, k, 'NBA', [{ market: 'total', line: 225, prices: { over: 1.9, under: 1.9 }, p: { over: 0.5, under: 0.5 }, books: 5 }, { market: 'spread', line: 0, prices: { home: 1.9, away: 1.9 }, p: { home: 0.5, away: 0.5 }, books: 5 }], true);
    }
    // the stored backtest: total and margin calibrated (public by calibration)
    const gate = { public: true, why: null, base: { public: true, why: null } };
    db.prepare("INSERT OR REPLACE INTO more_pred_backtest (sport, report, at) VALUES ('basketball', ?, ?)").run(JSON.stringify({ outputs: { total: { games: 9000, gate }, margin: { games: 9000, gate }, ot: { games: 9000, gate } } }), new Date().toISOString());
    for (const o of ['total', 'margin', 'ot']) db.prepare("INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES ('basketball', ?, 1, 9000, 1.2, NULL, ?)").run(o, new Date().toISOString());
    const changed = MP.applyMarketGates();
    const rows = Object.fromEntries(db.prepare("SELECT output, public, why FROM more_pred_gate WHERE sport = 'basketball'").all().map(r => [r.output, { public: r.public, why: r.why }]));
    const gap = A.gateGap('basketball', 'total');
    console.log(JSON.stringify({ changed, rows, gap, keys: MP.publicKeys('basketball', false) }));
  `);
  assert.equal(out.gap.n, 320);
  assert.equal(out.gap.medianAbs, 5);
  assert.equal(out.rows.total.public, 0);
  assert.equal(out.rows.total.why, '5 points from the market on totals (limit 3)');
  assert.equal(out.rows.margin.public, 1, 'the spread is on the market: stays public');
  assert.equal(out.rows.ot.public, 1, 'overtime has no market limit');
  assert.ok(!out.keys.includes('total') && out.keys.includes('margin'));
});

/* ---------- 5. no market line → the model alone ---------- */

test('anchor applied: with a kept weight, a game without a market line keeps the model; with one it is blended', () => {
  const out = child(`
    const A = require(D + '/services/marketAnchor.js');
    const fit = w => ({ all: { n: 900, tested: 800, w, kept: true, why: 'test', oos: null } });
    A.storeAnchor('basketball', 'total', fit(0.5));
    A.storeAnchor('basketball', 'spread', fit(0.5));
    A.storeAnchor('basketball', 'ml', { all: { n: 0, tested: 0, w: 0, kept: false, why: 'test', oos: null } });
    A.storeAnchor('football', 'ou2.5', fit(0.5));
    const base = { pHome: 0.52, margin: 1.1, total: 228.8 };
    const none = A.anchorPoints('basketball', 1, 'NBA', base);
    A.storeLines('basketball', 2, new Date(Date.now() + 3600000).toISOString(), 'NBA', [{ market: 'total', line: 234, prices: {}, p: {}, books: 4 }, { market: 'spread', line: 7.5, prices: {}, p: {}, books: 4 }], false);
    const with_ = A.anchorPoints('basketball', 2, 'NBA', base);
    const x = { sport: 'football', v: 1, sets: { goals: { labels: ['0', '1', '2', '3', '4+'], p: [0.1, 0.2, 0.3, 0.25, 0.15] } }, info: {} };
    const fNone = A.anchorFootballGoals(9, 'E0', x);
    A.storeLines('football', 10, null, 'E0', [{ market: 'ou2.5', line: 2.5, prices: {}, p: { over: 0.6, under: 0.4 }, books: 6 }], true);
    const fWith = A.anchorFootballGoals(10, 'E0', x);
    console.log(JSON.stringify({ none, with_, fNone, fWith }));
  `);
  assert.equal(out.none.total, 228.8, 'no market line: the model');
  assert.equal(out.none.margin, 1.1);
  assert.equal(out.none.anchored, false);
  assert.equal(out.with_.total, 231.4, 'half way to 234');
  assert.equal(out.with_.margin, (1.1 + -7.5) / 2, 'home handicap +7.5 = away by 7.5');
  assert.equal(out.with_.pHome, 0.52, 'money-line weight 0: the chance unchanged');
  assert.equal(out.with_.anchored, true);
  assert.equal(out.with_.home + out.with_.away, out.with_.total);
  assert.deepEqual(out.fNone.sets.goals.p, [0.1, 0.2, 0.3, 0.25, 0.15], 'football: no line, unchanged');
  const over = out.fWith.sets.goals.p[3] + out.fWith.sets.goals.p[4];
  assert.ok(over > 0.4 && over < 0.6, `blended over 2.5 ${over}`);
  assert.equal(out.fWith.info.anchor.ou25, 0.4);
  assert.ok(Math.abs(out.fWith.sets.goals.p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('wiring: basketball / NFL predictions are anchored where they are made; extras and football goals too; jobs and health', () => {
  const bb = SRC('src/services/bbModel.ts'), nfl = SRC('src/services/nflModel.ts'), more = SRC('src/services/morePredictions.ts');
  assert.match(bb, /withAnchor\(g, predictGame\(g, ph, pa\)\)/);
  assert.match(bb, /\|m\$\{marketVer\(\)\}/, 'the cache follows new lines');
  assert.match(nfl, /anchorPoints\('nfl'/);
  assert.match(more, /pointsMarketFor\('basketball'/);
  assert.match(more, /anchorFootballGoals\(r\.match_id/);
  assert.match(more, /marketGateWhy\(sport, k/);
  const jobs = SRC('src/jobs.ts');
  assert.match(jobs, /every\('market lines'/);
  assert.match(jobs, /heavy\('market anchor'/);
  assert.match(SRC('src/services/dataHealth.ts'), /marketHealth\(/);
  // quota checked before every call
  const ml = SRC('src/services/marketLines.ts');
  assert.equal((ml.match(/await callOdds\(/g) || []).length, (ml.match(/if \(!quotaOk\(sport\)\)/g) || []).length);
});

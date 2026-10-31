// fix293: tennis — the percentages and the model (Yarin, 31 Oct). (dist build) Run: npm run test:fix293
//  1. tennis_prices reach fix278's anchor: the mid → a margin-free chance, the fit per tour × surface (walk-forward,
//     kept only when better than the model and the market), the shown chance blended only with a price and a weight,
//     the gap report and "Close to the market (tennis)" count the settled matches with a price.
//  2. The calibration refit: every settled match since the launch counts (also those saved before p_raw), tested out of
//     fold, live when better on all of them; once (refitDue), not waiting for 04:30.
//  3. The lab: picks on 2024 only, promotes only when better on the 2025–26 test in both years, runs after the
//     predictions, and what it promotes is what the report / live model use (no market price ever reaches a public route).
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
const SRC = f => fs.readFileSync(path.join(here, '..', f), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY', 'API_BASKETBALL_KEY'];

function child(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix293-'));
  const env = { ...process.env, DATA_DIR: dir, SL_ROLE: 'all', THREAD_JOBS: '0', LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', MARKET_LINES: 'off', TENNIS_WORKER: '0' };
  for (const k of KEYS) env[k] = '';
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', `const D = ${JSON.stringify(DIST)};\n(async () => {\n${code}\n})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });`], { env, encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, `child failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/* ---------- 1. the price → chance, the blend ---------- */

test('a tennis mid becomes a margin-free chance (probability quotes and decimal odds)', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix293-u-'));
  process.env.LOG_LEVEL = 'error';
  const A = require(DIST + '/services/tennisAnchor.js');
  assert.equal(A.midToProb(0.6), 0.6);
  assert.equal(A.midToProb(2), 0.5);
  assert.ok(Math.abs(A.priceP1(1.5, 2.8) - (1 / 1.5) / (1 / 1.5 + 1 / 2.8)) < 1e-9, 'decimal odds, the margin taken out');
  assert.ok(Math.abs(A.priceP1(0.62, 0.40) - 0.62 / 1.02) < 1e-9, 'probability quotes normalised');
  assert.equal(A.priceP1(null, 2), null);
  assert.equal(A.priceP1(0, 0.5), null);
  assert.equal(A.segmentOf('wta', 'Clay'), 'wta·clay');
  assert.equal(A.segmentOf('atp', 'indoor hard'), 'atp·hard');
  // no fit / weight 0 → the model; a kept weight with a price → the log-odds blend; the tour × surface fit first, else 'all'
  const fits = { all: { kept: true, w: 0.5, n: 400 }, 'wta·clay': { kept: false, w: 0, n: 300 } };
  assert.deepEqual(A.anchorTennis(1, 'atp·hard', 0.6, null), { p: 0.6, anchored: false, w: 0 });
  assert.deepEqual(A.anchorTennis(1, 'wta·clay', 0.6, fits), { p: 0.6, anchored: false, w: 0 }, 'its own fit says model only');
  const M = require(DIST + '/utils/marketLines.js');
  assert.ok(Math.abs(M.blendChance(0.6, 0.7, 0.5) - 1 / (1 + Math.exp(-(0.5 * Math.log(0.6 / 0.4) + 0.5 * Math.log(0.7 / 0.3))))) < 1e-12);
});

test('tennis_prices reach the anchor: fit per tour × surface, the shown chance, the gap report, Close to the market', () => {
  const out = child(`
    const { db } = require(D + '/db/index.js');
    require(D + '/services/tennis.js');
    require(D + '/services/tennisModel.js');
    require(D + '/services/marketAnchor.js');
    require(D + '/services/bbModel.js'); require(D + '/services/nflModel.js'); require(D + '/services/morePredictions.js');
    const ML = require(D + '/services/marketLines.js');
    const A = require(D + '/services/tennisAnchor.js');
    const RC = require(D + '/services/recentCalib.js');
    let seed = 293; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const now = Date.now(), DAY = 86400000;
    const im = db.prepare("INSERT INTO tennis_matches (id, tour, tier, surface, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, winner, outcome, source, updated_at) VALUES (?, 'atp', 'atp250', ?, ?, ?, ?, 'A', ?, 'B', ?, ?, 'live', ?)");
    const ip = db.prepare("INSERT INTO tennis_predictions (match_id, model, scheduled_at, cat, p1, made_at, first_p1, first_at) VALUES (?, 'tennis-v1', ?, 'atp', ?, ?, ?, ?)");
    const ipr = db.prepare("INSERT INTO tennis_prices (match_id, p1_mid, p2_mid, at, fetched_at) VALUES (?, ?, ?, ?, ?)");
    // 420 settled matches: the market knows the true chance, our model is too modest (shrunk to 50 / 50) → the anchor helps
    for (let k = 0; k < 420; k++) {
      const t = new Date(now - (250 - k * 0.55) * DAY).toISOString(), made = new Date(Date.parse(t) - 3600000).toISOString();
      const lg = x => Math.log(x / (1 - x)), sg = z => 1 / (1 + Math.exp(-z)), nz = () => (rnd() + rnd() + rnd() - 1.5) * 0.9;
      const pt = 0.15 + 0.7 * rnd(), won = rnd() < pt ? 1 : 2;
      // each side sees the truth with its own noise; ours is also too modest
      const ours = sg(0.7 * (lg(pt) + nz())), mkt = sg(lg(pt) + nz());
      im.run(1000 + k, k % 5 ? 'hard' : 'clay', t, 'completed', 1, 2, won, null, t);
      ip.run(1000 + k, t, ours, made, ours, made);
      ipr.run(1000 + k, 1 / mkt, 1 / (1 - mkt), made, made);
    }
    // one upcoming match with a price, one without
    const up = new Date(now + 3600000).toISOString();
    im.run(5000, 'hard', up, 'upcoming', 1, 2, null, null, up); ip.run(5000, up, 0.55, new Date(now).toISOString(), 0.55, new Date(now).toISOString());
    ipr.run(5000, 0.7, 0.3, new Date(now).toISOString(), new Date(now).toISOString());
    const rows = A.tennisAnchorRows(now);
    const fits = await ML.runMarketFits(now);
    const stored = A.tennisAnchorFits();
    const shown = A.anchorTennis(5000, 'atp·clay', 0.55); // clay: under 300 matches → the all-tours fit
    const none = A.anchorTennis(5001, 'atp·hard', 0.55);
    const rep = ML.marketGapReport(now, true);
    const tn = rep.sports.find(s => s.sport === 'tennis');
    const health = ML.marketHealth(() => false, now).find(r => r.id === 'market-close-tennis');
    const due = ML.marketFitDue(now);
    const trows = RC.tennisRows(now + DAY);
    console.log(JSON.stringify({ rows: rows.length, groups: [...new Set(rows.map(r => r.group))].sort(), fits: fits['tennis ml'], stored, shown, none,
      ml: tn.markets.find(m => m.market === 'ml').windows.d90.settled, health, due, trows: trows.length, refitDue: RC.refitDue('tennis') }));
  `);
  assert.equal(out.rows, 420, 'every settled match with a price is a fit row');
  assert.deepEqual(out.groups, ['atp·clay', 'atp·hard'], 'grouped by tour × surface');
  assert.ok(out.stored?.all?.kept && out.stored.all.w > 0, `the anchor is kept on unseen matches: ${JSON.stringify(out.stored?.all)}`);
  assert.ok(out.stored['atp·hard'], 'a tour × surface with 300+ matches gets its own fit');
  assert.ok(out.stored['atp·hard'] && !out.stored['atp·clay'], 'own fit with 300+ matches (hard), the sport\'s fit below (clay)');
  assert.equal(out.shown.anchored, true);
  assert.ok(out.shown.p > 0.55 && out.shown.p < 0.7, `shown moves toward the market: ${out.shown.p}`);
  assert.deepEqual(out.none, { p: 0.55, anchored: false, w: out.none.w }, 'no price: the model');
  assert.ok(out.ml.n >= 100, `the gap report counts the settled matches with a price (${out.ml.n})`);
  assert.ok(out.ml.closer && out.ml.closer.marketLogLoss != null && out.ml.closer.oursLogLoss != null, 'who was closer to the result');
  assert.match(out.health.items[0], /^winner chance: \d+ settled matches with a closing price/);
  assert.match(out.health.items[0], /weight 0\.\d|weight 1/);
  assert.equal(out.due, false, 'fitted: not due again before 20 h');
  assert.equal(out.trows, 420, 'the calibration rows include matches saved without p_raw (every settled match)');
  assert.equal(out.refitDue, true, 'the one-time refit is due');
});

/* ---------- 2. the calibration refit ---------- */

test('the refit: tested out of fold on every settled match, live when better, without the nightly bar', () => {
  const rc = require(DIST + '/utils/recentCalib.js');
  const NOW = Date.parse('2026-10-31T12:00:00Z'), DAY = 86400000;
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  // 653 matches since 19 Oct: said 50–80%, happened more often (the 60–70% band said ~65, happened ~73)
  const rows = [];
  for (let k = 0; k < 653; k++) {
    const p = 0.5 + 0.3 * rnd(), truth = Math.min(0.97, 0.5 + (p - 0.5) * 1.6);
    const fav1 = rnd() < 0.5, y = rnd() < truth ? (fav1 ? 0 : 2) : (fav1 ? 2 : 0);
    rows.push({ p: fav1 ? [p, 0, 1 - p] : [1 - p, 0, p], y, t: NOW - 12 * DAY + (k / 653) * 11.5 * DAY });
  }
  const d = rc.decideRecent(rows, null, null, null, NOW, undefined, 293, [50, 60, 70, 80], { young: true, refit: true });
  assert.equal(d.mode, 'young');
  assert.equal(d.decision, 'promote', d.reason);
  assert.match(d.reason, /fix293 refit/);
  const b = d.bands.find(x => x.lo === 60);
  assert.ok(b.cal > b.said, `60–70%: the refit says more (${b.said} → ${b.cal}, happened ${b.happened})`);
  assert.ok(d.live && d.live.n === 653, 'fitted on every settled match');
  // already calibrated (happened = said): the refit finds nothing better out of fold and changes nothing
  const flat = rows.map(r => { const k = r.p[0] >= r.p[2] ? 0 : 2; return { ...r, y: rnd() < Math.max(r.p[0], r.p[2]) ? k : 2 - k }; });
  const d2 = rc.decideRecent(flat, null, null, null, NOW, undefined, 293, [50, 60, 70, 80], { young: true, refit: true });
  assert.notEqual(d2.decision, 'promote', d2.reason);
});

test('the refit runs once, at the first tick after the deploy (src)', () => {
  const s = SRC('src/services/recentCalib.ts');
  assert.match(s, /export const REFIT_RULE = 'fix293'/);
  assert.match(s, /const refit = refitDue\(sport\);\n\s+if \(!refit && \(early \|\| doneToday\(sport, today\)\)\) continue;/);
  assert.match(s, /refit: !!opts\.refit/);
  assert.doesNotMatch(s.slice(s.indexOf('export function tennisRows'), s.indexOf('export function basketballRows')), /p_raw IS NOT NULL/, 'every settled match, not only those with p_raw');
});

/* ---------- 3. the lab ---------- */

test('the lab: picks on 2024, promotes on 2025–26 in both years, after the predictions; promoted = live (src)', () => {
  const s = SRC('src/services/tennisModel.ts');
  const lab = s.slice(s.indexOf('export async function runTennisLab'), s.indexOf('function labDue'));
  assert.match(lab, /const keep = bestC\.sc\.val < cur\.val - 0\.0003;/, 'kept on the 2024 validation only');
  assert.match(lab, /if \(!bestC \|\| sc\.val < bestC\.sc\.val\) bestC/, 'the setting is picked on 2024');
  assert.match(lab, /const promote = changed && dTest <= -0\.0005 && yrsBetter && hitDrop <= 0\.5;/);
  assert.match(lab, /\['2025', '2026'\]\.every/);
  assert.match(lab, /fitAnchor\('chance', mRows\)/, 'the market anchor walk-forward');
  for (const f of ['elo-bleed', 'elo-mov', 'elo-decay', 'elo-tourK', 'point-recent', 'point-surface', 'tiebreak', 'clutch', 'rest', 'travel', 'h2h', 'style'])
    assert.ok(lab.includes(`family: '${f}'`), `${f} tried`);
  // the report starts from the promoted stack and keeps its groups; rebuilt once when it changes
  assert.match(s, /let curA = \{ \.\.\.A_DEFAULT, \.\.\.\(promo\?\.a \|\| \{\}\) \}, curB = \{ \.\.\.B_DEFAULT, \.\.\.\(promo\?\.b \|\| \{\}\) \};/);
  assert.match(s, /const labMoved = !!report && \(report\.lab \?\? 'none'\) !== labKey\(labPromoted\(\)\);/);
  // after the predictions are saved, never before
  const tick = s.slice(s.indexOf('async function tickHere'), s.indexOf('export async function tennisResultsHook'));
  assert.ok(tick.indexOf('saveTennisPredictions()') < tick.indexOf('runTennisLab'), 'the lab runs after the predictions');
  // every variant is off by default (the live model unchanged until promoted)
  assert.match(s, /const mov = this\.P\.mov \|\| 0;/);
  assert.match(s, /const dk = this\.P\.decay \|\| 0;/);
  assert.match(s, /bleed = this\.P\.bleed \|\| 0;/);
  assert.match(s, /\(R\.gen\[i\] \? this\.P\.kW \?\? 1 : 1\)/);
  assert.match(s, /this\.mf = P\.nm > 1 \? 1 - 1 \/ P\.nm : 1;/);
  // the anchor is the last step of the shown chance and the chance before it is saved
  const pr = s.slice(s.indexOf('function predictRow'), s.indexOf('/** "Why" lines'));
  assert.ok(pr.indexOf('calibrateTennis(p)') < pr.indexOf('anchorTennis('), 'anchor after the calibration layers');
  assert.match(s, /p_anchor_pre = excluded\.p_anchor_pre/);
});

test('no market number reaches a public route: the lab and the anchor are admin-only', () => {
  const app = SRC('src/app.ts');
  assert.match(app, /app\.get\('\/api\/admin\/tennis-lab'/);
  const open = app.slice(app.indexOf('OPEN_API'), app.indexOf('OPEN_API') + 6000);
  assert.doesNotMatch(open, /tennis-lab/);
  const site = SRC('src/services/tennisSite.ts');
  assert.doesNotMatch(site, /tennisAnchor|FROM tennis_prices|JOIN tennis_prices/, 'the public tennis pages never read prices');
});

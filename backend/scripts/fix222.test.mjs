// fix222: (1) the calibration layer of basketball and tennis (utils/sportCalib.ts): an over-confident league is pulled
// onto the line on its test season, a calibrated league keeps its raw chances, the layer is monotone, the live season is
// never fitted, tennis is symmetric; (2) bb-v4 tuned on the live database by the worker: stored, applied only through
// the gate, due again after 30 days; the basketball layer built from the stored rows (strong line per league);
// (3) a big shared state is stored in parts and the web process loads it one part per turn (event loop < 60 ms) with the
// same value; (4) start-up stalls stay out of the hourly count, a request waiting on the worker is not named in a stall.
// Run: npm run test:fix222 (dist build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix222-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const C = require('../dist/utils/sportCalib.js');
const M = require('../dist/utils/bbGridMath.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/bbGrid.js');
const T = require('../dist/services/bbTuner.js');
const SC = require('../dist/services/sportCalibration.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sig = x => 1 / (1 + Math.exp(-x));
const logit = p => Math.log(p / (1 - p));
/** games whose true chance is q; the model says sigma(stretch · logit q) (stretch > 1 = over-confident) */
function rows(n, seed, league, season, stretch, shift = 0) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const q = sig((r() - 0.5) * 3 + shift);
    out.push({ p: sig(stretch * logit(q)), y: r() < q ? 1 : 0, season, league });
  }
  return out;
}

test('layer: an over-confident league is pulled onto the line, a calibrated one keeps its raw chances', () => {
  const all = [];
  for (const s of [2022, 2023, 2024, 2025]) all.push(...rows(5000, s, 'OVER', s, 1.6), ...rows(5000, s + 50, 'FAIR', s, 1));
  const r = C.buildLayer(all, { first: 2022, test: 2025, last: 2025, symmetric: false, strongDefault: 0.7 });
  const over = r.perLeague.find(x => x.league === 'OVER'), fair = r.perLeague.find(x => x.league === 'FAIR');
  assert.ok(over.kept, `OVER: ${over.why}`);
  assert.ok(over.cal.logLoss < over.raw.logLoss - 0.005, `OVER log loss ${over.raw.logLoss} → ${over.cal.logLoss}`);
  for (const b of over.calBands.filter(b => b.n >= 300)) assert.ok(Math.abs(b.gap) <= 4, `OVER band ${b.lo}%: said ${b.said}, happened ${b.happened}`);
  assert.ok(over.rawBands.some(b => b.n >= 100 && b.gap > 5), 'the fixture is over-confident before the layer');
  // the calibrated league: its layer is dropped unless it really helps (within a hair of raw either way)
  assert.ok(!fair.kept || Math.abs(fair.cal.logLoss - fair.raw.logLoss) < 0.002, `FAIR: ${fair.why}`);
  // monotone: a bigger chance stays bigger in every league
  for (const lg of ['OVER', 'FAIR']) {
    let prev = -1;
    for (let p = 0.02; p < 0.99; p += 0.02) { const q = C.applyLayer(r.layer, lg, p); assert.ok(q >= prev, `${lg} not monotone at ${p}`); prev = q; }
  }
  // strong line per league from the calibrated test season
  assert.ok(r.strong.OVER >= 0.6 && r.strong.OVER <= 0.9);
});

test('layer: never fitted on the live season (2026 results flipped change nothing), fits outside the seasons refused', () => {
  const past = [];
  for (const s of [2022, 2023, 2024, 2025]) past.push(...rows(1200, s, 'L', s, 1.5));
  const live = rows(1500, 7, 'L', 2026, 1.5);
  const a = C.buildLayer([...past, ...live], { first: 2022, test: 2025, last: 2025, symmetric: false, strongDefault: 0.7 });
  const b = C.buildLayer([...past, ...live.map(x => ({ ...x, y: 1 - x.y }))], { first: 2022, test: 2025, last: 2025, symmetric: false, strongDefault: 0.7 });
  assert.deepEqual(a.layer, b.layer);
  assert.deepEqual(a.layer.seasons, [2022, 2023, 2024, 2025]);
  assert.equal(a.live.games, 1500);
  assert.ok(a.live.cal.logLoss < a.live.raw.logLoss, 'the live season (same truth) is better calibrated');
  assert.throws(() => C.fitLayer(live, 2022, 2025, false), /not allowed/);
  assert.throws(() => C.assertSeasons([2021], 2022, 2025), /not allowed/);
});

test('tennis: the symmetric layer (b = 0) gives p1 and p2 the same treatment', () => {
  const all = [];
  for (const s of [2024, 2025]) for (const lg of ['atp', 'wta', 'challenger']) all.push(...rows(2000, s * 7 + lg.length, lg, s, 1.4, 0.4));
  const r = C.buildLayer(all, { first: 2024, test: 2025, last: 2025, symmetric: true, strongDefault: 0.75 });
  assert.ok(r.layer, 'kept');
  for (const lg of ['atp', 'wta', 'challenger']) {
    const f = r.layer.leagues[lg] || r.layer.sport;
    assert.equal(f.b, 0, `${lg}: an intercept would favour whoever is listed first`);
    for (const p of [0.2, 0.35, 0.6, 0.83]) assert.ok(Math.abs(C.applyLayer(r.layer, lg, p) + C.applyLayer(r.layer, lg, 1 - p) - 1) < 1e-9);
  }
});

/** stored bb-v4 rows for a scratch database: the grid's truth = GRID_DEFAULT (bb-v3 = a noisier copy); liveFlat < 1 = the
 * live season (2026) less sure than the model says, with its games in bb_games (kickoffs over 40 days) */
function storeGrid(seed, liveFlat = 1) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  db.exec(`DELETE FROM bb_grid_rows`); db.exec(`DELETE FROM bb_games`);
  const gm = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (?, ?, 1, ?, ?, 'FT', 1, 'H', 2, 'A', ?)`);
  const ins = db.prepare(`INSERT INTO bb_grid_rows (game_id, code, season, ms, gp, y, v3, sig, hv, av, oracle) VALUES (?, ?, ?, 0, ?, ?, ?, 12, ?, ?, NULL)`);
  db.exec('BEGIN');
  let id = 1;
  for (const year of [2022, 2023, 2024, 2025, 2026]) for (const code of ['NBA', 'ACB', 'EL']) for (let k = 0; k < 420; k++) {
    const hv = [], av = [];
    for (let i = 0; i < M.N_ROWS; i++) { const s = i === M.VOL ? 0.03 : i === 5 || i === 10 ? 0.5 : 4; hv.push(gauss() * s); av.push(gauss() * s); }
    const it = { hv, av, sig: 12 };
    const p = M.gridEval(M.GRID_DEFAULT, code, it).pHome;
    const v3 = sig(logit(p) * 0.6 + gauss() * 0.5);
    const truth = year === 2026 ? sig(logit(p) * liveFlat) : p;
    if (year === 2026) gm.run(id, code, `${year}-${year + 1}`, new Date(Date.UTC(2026, 9, 1) + Math.floor(k / 10.5) * 86400000).toISOString(), new Date().toISOString());
    ins.run(id++, code, `${year}-${year + 1}`, k % 40, r() < truth ? 1 : 0, v3, JSON.stringify(hv), JSON.stringify(av));
  }
  db.exec('COMMIT');
}

test('bb-v4 tuned on the live database: stored, applied through the gate, due again after 30 days', async () => {
  storeGrid(11);
  db.exec(`DELETE FROM bb_tuned`);
  assert.match(T.autoTuneDue(), /first tune/);
  const rep = await T.runTune({ auto: 'first tune on the live database', rounds: 4 });
  assert.ok(rep.auto, 'the automatic run is reported');
  assert.deepEqual(rep.auto.train, M.GRID_TRAIN);
  assert.equal(rep.auto.test, M.GRID_TEST);
  const live = db.prepare(`SELECT report FROM bb_tuned WHERE id = 'live'`).get();
  if (rep.auto.applied) {
    assert.ok(rep.auto.passing.length > 0);
    assert.ok(live, 'applied = stored as the live settings');
    assert.equal(JSON.parse(live.report).source, 'live database (worker)');
  } else assert.ok(!live, `not applied (${rep.auto.reason}) = nothing stored as live`);
  assert.equal(T.autoTuneDue(), null, 'not due again right after a run');
  assert.match(T.autoTuneLine(), /tune on the live database/);
  const auto = JSON.parse(db.prepare(`SELECT report FROM bb_tuned WHERE id = 'auto'`).get().report);
  db.prepare(`UPDATE bb_tuned SET report = ? WHERE id = 'auto'`).run(JSON.stringify({ ...auto, at: new Date(Date.now() - 31 * 86400000).toISOString() }));
  assert.match(T.autoTuneDue(), /monthly re-tune/);
  // a fit that loses to bb-v3 everywhere is never applied: bb-v3 = the truth here
  db.exec(`UPDATE bb_grid_rows SET v3 = 0.999 WHERE y = 1`); db.exec(`UPDATE bb_grid_rows SET v3 = 0.001 WHERE y = 0`);
  db.exec(`DELETE FROM bb_tuned`);
  const bad = await T.runTune({ auto: 'test', rounds: 2 });
  assert.equal(bad.auto.applied, false, bad.auto.reason);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM bb_tuned WHERE id = 'live'`).get().n, 0);
});

test('basketball layer from the stored rows: stored, published, strong line per league', async () => {
  storeGrid(12);
  db.exec(`DELETE FROM bb_tuned`);
  const r = await SC.buildBbCalibrationHere('test');
  assert.ok(r, 'built');
  const rep = SC.calibReport('basketball');
  assert.equal(rep.test.season, 2025);
  assert.deepEqual(rep.test.fitOn, [2022, 2023, 2024]);
  assert.ok(rep.live.games > 0, 'the live season is reported');
  for (const code of ['NBA', 'ACB', 'EL']) { const s = SC.bbStrongLine(code); assert.ok(s >= 0.6 && s <= 0.9, `${code} strong ${s}`); }
  const st = SC.bbCalibState();
  assert.equal(st.version, SC.BB_CALIB_VERSION);
  if (st.layer) assert.deepEqual(st.layer.seasons, [2022, 2023, 2024, 2025]);
});

const PUBLISH = `
const D = ${JSON.stringify(DIST)};
const sh = require(D + '/services/shared.js');
const v8 = require('node:v8');
const rows = Array.from({ length: 60000 }, (_, i) => ({ id: i, utcDate: new Date(1.7e12 + i * 6e4).toISOString(), home: { id: i, name: 'Home team ' + i, crest: 'https://crests.example/' + i + '.png' }, away: { id: -i, name: 'Away team ' + i }, prediction: { home: 0.4, draw: 0.3, away: 0.3, factors: Array.from({ length: 12 }, (_, k) => ({ key: 'f' + k, home: k, away: -k })) } }));
const value = { windowMatches: rows, windowAt: 123, leagueMeta: new Map(Array.from({ length: 3000 }, (_, i) => [i, { name: 'League ' + i, season: 2026 }])), standings: new Map([['PL', { rows: [1, 2, 3] }]]) };
const t0 = performance.now(); const whole = v8.serialize(value); v8.deserialize(whole); const wholeMs = performance.now() - t0;
sh.publishState('af:window', value);
const { db } = require(D + '/db/index.js');
console.log(JSON.stringify({ parts: db.prepare("SELECT COUNT(*) AS n FROM shared_parts WHERE key = 'af:window'").get().n, mb: Math.round(whole.length / 1048576), wholeMs: Math.round(wholeMs) }));
`;
const LOAD = `
const D = ${JSON.stringify(DIST)};
const sh = require(D + '/services/shared.js');
let got = null;
sh.onState('af:window', (_k, v) => { got = v; });
const { monitorEventLoopDelay } = require('node:perf_hooks');
const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
sh.loadNewerStates().then(() => {
  loop.disable();
  console.log(JSON.stringify({ n: got && got.windowMatches.length, last: got && got.windowMatches[59999].home.name, meta: got && got.leagueMeta.size, at: got && got.windowAt, st: got && got.standings.get('PL').rows.length, loopMaxMs: Math.round(loop.max / 1e6) }));
  process.exit(0);
});
`;

test('a big shared state is stored in parts and loaded one part per turn by the web process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix222-state-'));
  const env = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production' };
  const w = spawnSync(process.execPath, ['-e', PUBLISH], { env: { ...env, SL_ROLE: 'worker' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(w.status, 0, w.stderr);
  const made = JSON.parse(w.stdout.trim().split('\n').pop());
  assert.ok(made.parts >= 20, `${made.parts} parts for a ${made.mb} MB state`);
  const r = spawnSync(process.execPath, ['-e', LOAD], { env: { ...env, SL_ROLE: 'web' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim().split('\n').pop());
  console.log(`shared parts: ${made.mb} MB in ${made.parts} parts; one-block deserialize ${made.wholeMs} ms, web loop max ${got.loopMaxMs} ms`);
  assert.equal(got.n, 60000);
  assert.equal(got.last, 'Home team 59999');
  assert.equal(got.meta, 3000);
  assert.equal(got.at, 123);
  assert.equal(got.st, 3);
  assert.ok(got.loopMaxMs < Math.max(60, made.wholeMs / 4), `web event loop blocked ${got.loopMaxMs} ms (one block: ${made.wholeMs} ms)`);
});

test('perf: start-up stalls are listed apart, a request waiting on the worker is not named', async () => {
  const P = require('../dist/services/perf.js');
  P.markListening(6500);
  const st = P.perfStatus();
  P.markStartupDone();
  assert.ok(JSON.stringify(st).includes('module load before listen'), 'the module load is a start-up entry');
  assert.ok(!P.hourBuckets().some(b => b.top.some(t => /module load|scheduler start/.test(t.job || ''))), 'not in the hourly count');
  const d = P.track('http GET /api/basketball/game/:id');
  d.wait();
  const t0 = Date.now(); while (Date.now() - t0 < 1100) { /* a stall caused by something else */ }
  await new Promise(r => setTimeout(r, 1200));
  d();
  const last = P.perfStatus().recentStalls.find(s => s.ms > 300);
  assert.ok(last, 'the stall was seen');
  assert.ok(!String(last.job || '').includes('/api/basketball/game'), `named: ${last.job}`);
});

// fix222b: the in-season layer (basketball, behind a switch)
function liveRows(n, days, stretch, seed) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const q = sig((r() - 0.5) * 3);
    out.push({ p: sig(stretch * logit(q)), y: r() < q ? 1 : 0, league: i % 3 ? 'NBA' : 'EL', t: Date.UTC(2026, 9, 1) + Math.floor((i * days) / n) * 86400000 + 3600000 });
  }
  return out;
}

test('in-season layer: kept for an over-confident live season, walk-forward by day, not kept when already calibrated', () => {
  const over = liveRows(3000, 40, 1.6, 21);
  const a = C.inSeasonLayer(over, { keep: true });
  assert.ok(a.kept, a.why);
  assert.ok(a.test.cal.logLoss < a.test.base.logLoss, `${a.test.base.logLoss} → ${a.test.cal.logLoss}`);
  assert.ok(a.tested < over.length && a.tested >= 2000, 'the first games only fit');
  // walk-forward: flipping the last day's results changes no earlier day's calibrated chance
  const lastDay = Math.max(...over.map(x => Math.floor(x.t / 86400000)));
  const b = C.inSeasonLayer(over.map(x => (Math.floor(x.t / 86400000) === lastDay ? { ...x, y: 1 - x.y } : x)), { keep: true });
  const before = rows => rows.evaluated.filter(e => Math.floor(e.t / 86400000) < lastDay).map(e => e.p);
  assert.deepEqual(before(b), before(a));
  // calibrated already: no gain → not kept; too few games → not kept
  const fair = C.inSeasonLayer(liveRows(3000, 40, 1, 22));
  assert.equal(fair.kept, false, fair.why);
  const few = C.inSeasonLayer(liveRows(350, 10, 1.6, 23));
  assert.equal(few.kept, false);
  assert.match(few.why, /needed/);
});

test('in-season switch: off = the season layer only; on = used once it passed its test', async () => {
  storeGrid(31, 0.55);
  db.exec(`DELETE FROM bb_tuned`);
  SC.setInSeasonMode('off');
  await SC.buildBbCalibrationHere('test off');
  const rep = SC.calibReport('basketball');
  assert.ok(rep.inSeason.kept, rep.inSeason.why);
  assert.equal(rep.inSeason.used, false);
  const st = SC.bbCalibState();
  const seasonOnly = C.applyLayer(st.layer, 'NBA', 0.8);
  assert.equal(SC.bbCalibrated('NBA', 0.8), seasonOnly, 'switch off: the season layer only');
  SC.setInSeasonMode('on');
  assert.equal(SC.inSeasonMode(), 'on');
  await SC.buildBbCalibrationHere('test on');
  assert.equal(SC.calibReport('basketball').inSeason.used, true);
  assert.ok(SC.bbCalibrated('NBA', 0.8) < seasonOnly - 0.01, 'switch on: the live season is less sure → the chance comes down');
  process.env.BB_INSEASON = 'off';
  assert.equal(SC.bbCalibrated('NBA', 0.8), seasonOnly, 'BB_INSEASON=off overrides the stored switch');
  delete process.env.BB_INSEASON;
  SC.setInSeasonMode('off');
});

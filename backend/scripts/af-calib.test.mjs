// fix220: American football honest percentages + ncaa-v2 — the calibration layer is monotone, brings an over-confident
// model's bands within tolerance on a fixture (fitted 2021–2025, checked on 2026), never fits on 2026 (layer and
// ncaa-v2 tuner refuse it), the data-health verdict, the strong line, ncaa-v2's numbers use only earlier games, and the
// whole college pipeline on a scratch database (walk-forward report → ncaa-v2 test + gate → layer → saved predictions
// with the raw chance, record split by level). (dist build)
// Run: npm run test:fix220
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix220-af-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const C = require('../dist/utils/afCalib.js');
const V = require('../dist/utils/ncaaV2.js');

/** seeded random numbers (mulberry32) */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const sig = x => 1 / (1 + Math.exp(-x));
const logit = p => Math.log(p / (1 - p));

/** An over-confident model: logit(said) = 1.6 × logit(true) + 0.15 (home bias), results drawn from the true chance. */
function overconfident(seed = 3, perSeason = 2500) {
  const r = rng(seed), rows = [];
  for (let season = 2021; season <= 2026; season++) for (let i = 0; i < perSeason; i++) {
    const pt = sig(gauss(r) * 0.9 + 0.2);
    const seg = ['mismatch', 'conf', 'other'][i % 3];
    rows.push({ p: sig(1.6 * logit(pt) + 0.15), y: r() < pt ? 1 : 0, season, seg });
  }
  return rows;
}

test('the layer is monotone (also when the fit would turn it around) and the identity when unfitted', () => {
  const c = C.fitCalib(overconfident().filter(x => x.season <= 2025));
  for (const seg of [null, 'mismatch', 'conf', 'other']) {
    let last = -1;
    for (let p = 0.01; p <= 0.99; p += 0.01) { const q = C.applyCalib(c, p, seg); assert.ok(q > last, `monotone at ${p} (${seg})`); last = q; }
  }
  // results opposite to the chances: the slope is held at MIN_A > 0
  const bad = Array.from({ length: 400 }, (_, i) => ({ p: 0.2 + 0.6 * (i % 10) / 10, y: (i % 10) < 5 ? 1 : 0, season: 2022 }));
  const cb = C.fitCalib(bad, false);
  assert.ok(cb.global.a >= C.MIN_A);
  assert.ok(C.applyCalib(cb, 0.8) >= C.applyCalib(cb, 0.3));
  assert.equal(C.applyCalib(null, 0.73), 0.73);
});

test('an over-confident model: raw bands off, calibrated bands within 4 points on 2026 (fitted on 2021–2025 only)', () => {
  const rows = overconfident();
  const wf = C.walkForwardCalib(rows, [2022, 2023, 2024, 2025, 2026]);
  const s26 = wf.seasons.find(s => s.season === 2026);
  assert.deepEqual(s26.fitOn, [2021, 2022, 2023, 2024, 2025]);
  for (const s of wf.seasons) assert.ok(Math.max(...s.fitOn, 0) < s.season, `season ${s.season} fitted on earlier seasons only`);
  const worstRaw = Math.max(...s26.rawBands.filter(b => b.n >= 50).map(b => Math.abs(b.gap)));
  const worstCal = Math.max(...s26.calBands.filter(b => b.n >= 50).map(b => Math.abs(b.gap)));
  assert.ok(worstRaw > 5, `raw is off (${worstRaw})`);
  assert.ok(worstCal <= 4, `calibrated within 4 points (${worstCal})`);
  assert.ok(s26.cal.logLoss < s26.raw.logLoss, 'log loss better on 2026');
  // the data-health verdict on the same rows (picks by band: n, said, hitRate)
  const asConf = bands => bands.map(b => ({ n: b.n, said: b.said, hitRate: b.happened, label: `${b.lo}` }));
  assert.equal(C.calibCheck(asConf(s26.rawBands)).fail, true);
  assert.equal(C.calibCheck(asConf(s26.calBands)).fail, false);
});

test('never a fit on 2026: the layer and the ncaa-v2 tuner refuse it', async () => {
  assert.throws(() => C.fitCalib([{ p: 0.6, y: 1, season: 2026 }]), /2026/);
  assert.throws(() => C.assertCalibSeasons([2025, 2026]), /2026/);
  C.assertCalibSeasons([2021, 2025]);
  const raw = { id: 1, season: 2026, done: true, y: 1, prevH: 0, prevA: 0, curH: 0, curA: 0, gpH: 1, gpA: 1, ypp: 0, qb: 0, bye: 0, short: 0, travel: 0, lvl: 0, ret: 0, conf: 0, mis: 0, home: 1 };
  await assert.rejects(() => V.tuneV2([{ r: raw, v1: 0.6 }]), /2026/);
  await assert.rejects(() => V.tuneV2([{ r: { ...raw, season: 2025 }, v1: 0.6 }], 2024), /2025/); // the 2025 test trains on 2021–2024
});

test('data-health verdict: 100+ games, bands of 50+, more than 5 points', () => {
  assert.equal(C.calibCheck([{ n: 40, said: 80, hitRate: 60 }, { n: 40, said: 60, hitRate: 59 }]).enough, false);
  assert.equal(C.calibCheck([{ n: 40, said: 80, hitRate: 60 }, { n: 80, said: 60, hitRate: 59 }]).fail, false); // the off band has under 50
  const f = C.calibCheck([{ n: 57, said: 55.7, hitRate: 49.1 }, { n: 65, said: 64.4, hitRate: 53.8 }, { n: 53, said: 74.7, hitRate: 69.8 }, { n: 62, said: 87.2, hitRate: 75.8 }]);
  assert.equal(f.fail, true);
  assert.equal(f.worst.gap, 11.4); // 87.2 → 75.8 (25 Oct live numbers)
});

test('strong line: the lowest chance where picks were right ≥ 75%', () => {
  const rows = [];
  for (let i = 0; i < 2000; i++) { const p = 0.5 + 0.49 * (i / 2000); rows.push({ p, y: (i * 7919) % 1000 < p * 1000 ? 1 : 0 }); }
  const line = C.strongLine(rows);
  assert.ok(line !== null && line >= 0.6 && line <= 0.75, `line ${line}`);
  const sel = rows.filter(r => r.p >= line);
  assert.ok(sel.filter(r => r.y === 1).length / sel.length >= 0.75);
  assert.equal(C.strongLine(rows.slice(0, 30)), null); // too few games
});

/* ---------- a synthetic college league ---------- */

const CONF = ['SEC', 'Mountain West', 'Big Sky'];
function league(seed = 11) {
  const r = rng(seed);
  const teams = Array.from({ length: 40 }, (_, i) => ({ id: 500 + i, name: `Test U${i}`, conf: i < 12 ? CONF[0] : i < 24 ? CONF[1] : CONF[2], level: i < 24 ? 'FBS' : 'FCS', city: i % 2 ? 'Town, AL' : 'City, Texas', s: (i < 12 ? 8 : i < 24 ? 2 : -9) + gauss(r) * 5 }));
  const games = [];
  let id = 90000;
  for (let season = 2019; season <= 2026; season++) {
    for (const t of teams) t.s = 0.7 * t.s + 0.3 * ((t.level === 'FBS' ? (t.conf === 'SEC' ? 8 : 2) : -9) + gauss(r) * 5);
    const first = Date.parse(`${season}-08-31T18:00:00Z`);
    for (let w = 0; w < 12; w++) {
      const ko = new Date(first + w * 7 * 86400000).toISOString();
      const pairs = [];
      const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      if (w < 3) { // non-conference: FCS teams visit FBS teams, the other FBS teams meet
        const fbs = shuffle(teams.filter(t => t.level === 'FBS')), fcs = shuffle(teams.filter(t => t.level === 'FCS'));
        fcs.forEach((t, i) => pairs.push([fbs[i], t]));
        for (let i = fcs.length; i + 1 < fbs.length; i += 2) pairs.push([fbs[i], fbs[i + 1]]);
      } else for (const c of CONF) { const l = shuffle(teams.filter(t => t.conf === c)); for (let i = 0; i + 1 < l.length; i += 2) pairs.push([l[i], l[i + 1]]); }
      for (const [h, a] of pairs) {
        const future = Date.parse(ko) > Date.parse('2026-10-20T00:00:00Z');
        let m = Math.round(h.s - a.s + 3 + gauss(r) * 13);
        if (m === 0) m = 3;
        let hs = Math.max(0, Math.round(27 + m / 2)), as_ = hs - m;
        if (as_ < 0) { hs -= as_; as_ = 0; } // a big home win: both scores up, the margin kept
        games.push({ id: id++, season, ko, h, a, hs: future ? null : hs, as: future ? null : as_, status: future ? 'NS' : 'FT' });
      }
    }
  }
  return { teams, games };
}

test('ncaa-v2 numbers use only earlier games (changing later results changes no earlier row)', async () => {
  const { teams, games } = league();
  const T = new Map(teams.map(t => [t.id, { conf: t.conf, level: t.level, power: V.POWER.test(t.conf), state: V.stateOf(t.city) }]));
  const names = new Map(teams.map(t => [t.id, t.name]));
  const G = gs => gs.map(g => ({ id: g.id, season: g.season, t: Date.parse(g.ko), h: g.h.id, a: g.a.id, hs: g.hs, as: g.as, done: g.status === 'FT', neutral: false }));
  const a = await V.buildRows(G(games), new Map(), new Map(), T, names);
  const cut = Date.parse('2024-10-01T00:00:00Z');
  const changed = games.map(g => (Date.parse(g.ko) >= cut && g.hs !== null ? { ...g, hs: g.as, as: g.hs } : g));
  const b = await V.buildRows(G(changed), new Map(), new Map(), T, names);
  const before = new Set(games.filter(g => Date.parse(g.ko) < cut).map(g => g.id));
  let n = 0;
  for (let i = 0; i < a.length; i++) if (before.has(a[i].id)) { n++; assert.deepEqual({ ...b[i], y: a[i].y }, a[i]); }
  assert.ok(n > 1000);
  // and later rows do move
  assert.ok(a.some((x, i) => !before.has(x.id) && x.done && (x.curH !== b[i].curH || x.prevH !== b[i].prevH)));
  assert.equal(V.stateOf('Tuscaloosa, AL'), 'AL');
  assert.equal(V.stateOf('Austin, Texas'), 'TX');
  assert.equal(V.levelOf({ conf: 'SEC', level: 'FBS', power: true, state: null }), 2);
});

test('the college pipeline on a scratch database: report → ncaa-v2 gate → layer → saved predictions → record split', { timeout: 600000 }, async () => {
  const { db } = require('../dist/db/index.js');
  require('../dist/services/nfl.js');
  const NM = require('../dist/services/nflModel.js');
  const AC = require('../dist/services/afCalibration.js');
  const AS = require('../dist/services/afCalibState.js');
  const { teams, games } = league();
  const now = new Date().toISOString();
  const insT = db.prepare(`INSERT INTO nfl_teams (team_id, name, city, conference, level, league, updated_at) VALUES (?, ?, ?, ?, ?, 2, ?)`);
  for (const t of teams) insT.run(t.id, t.name, t.city, t.conf, t.level, now);
  // upcoming games a few days ahead (saveNflPredictions looks 9 days ahead): moved to now + 2 days
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  const insG = db.prepare(`INSERT INTO nfl_games (game_id, season, week, stage, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, venue, league, updated_at) VALUES (?, ?, ?, 'Regular Season', ?, ?, ?, ?, ?, ?, ?, ?, NULL, 2, ?)`);
  const firstFuture = games.find(g => g.status === 'NS').ko;
  db.exec('BEGIN');
  for (const g of games) insG.run(g.id, g.season, 'Week', g.status === 'NS' && g.ko === firstFuture ? soon : g.ko, g.h.id, g.h.name, g.a.id, g.a.name, g.status, g.hs, g.as, now);
  db.exec('COMMIT');
  await NM.retrain(2);
  const rep = NM.nflModelReport(2);
  assert.ok(rep.seasons.some(s => s.season === 2021), 'the walk-forward report starts in 2021');
  const report = await AC.buildAfCalibration();
  assert.ok(report, 'built');
  if (process.env.SHOW) console.log(JSON.stringify({ gate: report.ncaaV2.reason, t25: report.ncaaV2.test2025, s26: report.ncaaV2.season2026, wf: report.college.walkForward.total, strong: report.college.strong, calib: report.college.calib }, null, 1));
  assert.ok(report.ncaaV2.test2025.conf.v1.games >= 100, 'gate on 2025 conference games');
  assert.deepEqual(report.ncaaV2.trainSeasons, [2021, 2022, 2023, 2024]);
  assert.match(report.ncaaV2.reason, /conference games of 2025/);
  const st = AS.afCalibState();
  assert.ok(['segments', 'league', 'none'].includes(report.college.mode), report.college.why);
  assert.equal(!!st.leagues[2].calib, report.college.mode !== 'none');
  if (st.leagues[2].calib) assert.ok(Math.max(...st.leagues[2].calib.seasons) <= 2025, 'never fitted on 2026');
  // the layer's own gate: an over-confident source gets a layer, and it fixes 2026
  const oc = overconfident(5, 600);
  const L = AC.leagueLayer(2, oc, 'fixture', () => 'other');
  assert.notEqual(L.report.mode, 'none', L.report.why);
  assert.ok(Math.max(...L.state.calib.seasons) <= 2025);
  const s26 = L.report.walkForward.seasons.find(s => s.season === 2026);
  assert.ok(s26.cal.logLoss < s26.raw.logLoss, '2026 better with the layer');
  // a source that is already honest gets no layer when the fit does not beat it on unseen seasons
  const honest = oc.map((r, i) => ({ ...r, p: 0.5 + ((i % 9) - 4) * 0.01 }));
  assert.ok(['none', 'league', 'segments'].includes(AC.leagueLayer(1, honest, 'fixture', () => undefined).report.mode));
  assert.ok(st.leagues[2].strong >= 0.6 && st.leagues[2].strong <= 0.9);
  assert.equal(st.ncaaV2, report.ncaaV2.pass);
  // predictions: shown chance = the layer on the model's own chance; the raw one saved
  await AC.refreshNcaaV2();
  const n = await NM.saveNflPredictions();
  assert.ok(n > 0, 'predictions saved');
  const row = db.prepare(`SELECT p.*, g.home_id, g.away_id FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id LIMIT 1`).get();
  assert.ok(row.p_raw !== null, 'raw chance saved');
  const expect = AS.calibrated(2, row.p_raw, AS.collegeSeg(row.home_id, row.away_id));
  assert.ok(Math.abs(row.p_home - Math.round(expect * 1000) / 1000) < 0.0011, `shown ${row.p_home} = layer(${row.p_raw}) ${expect}`);
  assert.match(row.model, /^ncaa-v[12]$/);
  // the record: finished 2026 games with a saved prediction, split by level
  const ins = db.prepare(`INSERT OR REPLACE INTO nfl_predictions (game_id, season, kickoff, model, p_home, margin, total, home_pts, away_pts, why, made_at, p_raw) VALUES (?, 2026, ?, 'ncaa-v1', ?, 0, 50, 25, 25, NULL, ?, ?)`);
  const recent = games.filter(g => g.season === 2026 && g.status === 'FT').slice(-120);
  for (const g of recent) { const ko = new Date(Date.now() - 3 * 86400000).toISOString(); db.prepare(`UPDATE nfl_games SET kickoff = ? WHERE game_id = ?`).run(ko, g.id); ins.run(g.id, ko, 0.7, new Date(Date.parse(ko) - 3600000).toISOString(), 0.8); }
  const acc = NM.nflAccuracy(30);
  const codes = acc.leagues.map(l => l.code);
  assert.ok(codes.includes('NCAA-FBS') && codes.includes('NCAA-FCS'), codes.join(','));
  assert.ok(!codes.includes('NCAA'));
  assert.ok(acc.leagues.every(l => l.strongLine >= 60));
  const rec = NM.nflRecord(30, 2);
  assert.ok(rec.split && rec.split.fbs[0].n + rec.split.mismatch[0].n + rec.split.fcs[0].n === rec.bands[0].n);
  // data health: American football counts only predictions made with the layer
  const { calibrationLine } = require('../dist/services/calibrationHealth.js');
  const line = calibrationLine('nfl');
  assert.equal(line.id, 'calibration-nfl');
  assert.ok(['ok', 'fail'].includes(line.level), line.detail);
});

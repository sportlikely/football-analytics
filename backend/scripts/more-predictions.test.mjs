// fix204: More predictions — every derived set sums to 100%, the tennis set scores match a direct simulation, the
// settle job marks hits for every output type, and the game-page block is locked like the prediction (scratch database,
// dist build). Run: npm run test:fix204
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix204-more-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/tracking.js');
require('../dist/services/basketball.js');
require('../dist/services/nfl.js');
require('../dist/services/tennis.js');
const M = require('../dist/utils/moreMath.js');
const tm = require('../dist/services/tennisModel.js');
const mp = require('../dist/services/morePredictions.js');

const sum = a => a.reduce((s, x) => s + x, 0);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('football: every set derived from the score grid sums to 100%', () => {
  for (const [h, a, s] of [[1.4, 1.1, 0.45], [2.9, 0.6, 0.42], [0.3, 3.4, 0.5], [1.5, 1.2, 0.45]]) {
    for (const shrink of [null, { k: 0.8, mh: 1.5, ma: 1.25 }]) {
      const x = M.footballExtras(h, a, s, shrink);
      for (const [k, set] of Object.entries(x.sets)) {
        close(sum(set.p), 1, 1e-9, `${k} (${h}-${a})`);
        assert.equal(set.p.length, set.labels.length, k);
        assert.ok(set.p.every(q => q >= 0), `${k} negative`);
      }
      // the 6×6 grid and the exact scores agree; HT/FT's half-time part equals the half-time set
      const ht = x.sets.ht.p, htft = x.sets.htft.p;
      for (let r = 0; r < 3; r++) close(htft[3 * r] + htft[3 * r + 1] + htft[3 * r + 2], ht[r], 1e-9, `HT/FT row ${r}`);
    }
  }
  // no shrink: the full-time result of HT/FT equals the grid's own 1X2
  const x = M.footballExtras(1.7, 0.9, 0.45);
  const g = x.sets.score; let H = 0;
  g.labels.forEach((l, i) => { if (l !== 'other') { const [a, b] = l.split('-').map(Number); if (a > b) H += g.p[i]; } });
  const ftH = x.sets.htft.p[0] + x.sets.htft.p[3] + x.sets.htft.p[6];
  assert.ok(ftH >= H - 1e-9 && ftH - H < 0.02, `FT home ${ftH} vs grid ≥ ${H}`);
});

test('basketball / NFL: normal-curve bands sum to 100% and the winner side keeps our win chance', () => {
  const fit = { share: 0.49, kHalf: 1.1, kOt: 0.95, meanTotal: 224, sigma: 12.5, sigmaT: 18, games: 900 };
  for (const [pHome, margin, total] of [[0.72, 6.5, 228], [0.31, -5, 215], [0.5, 0.1, 230], [0.95, 19, 240]]) {
    const x = M.normalExtras({ sport: 'basketball', pHome, margin, total, homePts: (total + margin) / 2, awayPts: (total - margin) / 2, fit });
    for (const [k, set] of Object.entries(x.sets)) close(sum(set.p), 1, 1e-9, `${k} sums`);
    const win = 1 - x.sets.margin.p[0];
    close(win, Math.max(pHome, 1 - pHome), 0.002, 'winner bands = our win chance');
  }
  const nfl = M.normalExtras({ sport: 'nfl', pHome: 0.64, margin: 3.5, total: 44, homePts: 23.75, awayPts: 20.25, fit: { share: 0.5, kHalf: 1.6, kOt: 1.3, meanTotal: 45, sigma: 13.5, sigmaT: 13, games: 500 } });
  for (const [k, set] of Object.entries(nfl.sets)) close(sum(set.p), 1, 1e-9, `nfl ${k} sums`);
  assert.deepEqual(nfl.sets.margin.labels, ['loser', '1–3', '4–7', '8–14', '15+']);
});

/** a direct simulation of a best-of-3 match (7-point tiebreak at 6-6), point by point */
function simulate(pa, pb, n, seed = 7) {
  let s = seed;
  // mulberry32 (exact 32-bit integer steps)
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = { '2-0': 0, '2-1': 0, '1-2': 0, '0-2': 0 };
  let first = 0, tb = 0;
  for (let k = 0; k < n; k++) {
    let aServes = rnd() < 0.5, sa = 0, sb = 0, anyTb = false, setNo = 0;
    while (sa < 2 && sb < 2) {
      let ga = 0, gb = 0;
      for (;;) {
        if (ga === 6 && gb === 6) {
          anyTb = true;
          let ta = 0, tbp = 0, pt = 0, srvA = aServes;
          while (!((ta >= 7 || tbp >= 7) && Math.abs(ta - tbp) >= 2)) {
            const p = srvA ? pa : 1 - pb;
            if (rnd() < p) ta++; else tbp++;
            pt++;
            if (pt % 2 === 1) srvA = !srvA;
          }
          if (ta > tbp) ga++; else gb++;
          aServes = !aServes; // 13 games: the other player starts the next set
          break;
        }
        let x = 0, y = 0;
        const p = aServes ? pa : 1 - pb;
        while (!((x >= 4 || y >= 4) && Math.abs(x - y) >= 2)) { if (rnd() < p) x++; else y++; }
        if (x > y) ga++; else gb++;
        aServes = !aServes;
        if ((ga >= 6 || gb >= 6) && Math.abs(ga - gb) >= 2) break;
        if (ga === 7 || gb === 7) break;
      }
      if (ga > gb) { sa++; if (setNo === 0) first++; } else sb++;
      setNo++;
    }
    out[`${sa}-${sb}`]++;
    if (anyTb) tb++;
  }
  return { sets: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v / n])), first: first / n, tb: tb / n };
}

test('tennis: the chain\'s set scores, first set and tie-break chance match a direct simulation within 0.5 points', () => {
  for (const [pa, pb] of [[0.66, 0.62], [0.6, 0.68]]) {
    const d = tm.tennisExtrasDist(pa, pb, 3, 0);
    const x = M.tennisExtras(d, 3);
    for (const [k, set] of Object.entries(x.sets)) close(sum(set.p), 1, 1e-9, `tennis ${k} sums`);
    const sim = simulate(pa, pb, 200000);
    for (const k of ['2-0', '2-1', '1-2', '0-2']) close(100 * d.sets[k], 100 * sim.sets[k], 0.5, `set score ${k} (${pa}/${pb})`);
    close(100 * d.first, 100 * sim.first, 0.5, 'first set');
    close(100 * (1 - d.noTb), 100 * sim.tb, 0.5, 'at least one tie-break');
  }
});

test('checks: actual results map to the right label for every output type', () => {
  const fb = M.footballExtras(1.6, 1.0, 0.45);
  const r = mp.checkExtras(fb, mp.footballActual(2, 1, [0, 1]));
  assert.equal(fb.sets.score.labels[r.checks.score.i], '2-1');
  assert.equal(fb.sets.goals.labels[r.checks.goals.i], '3');
  assert.equal(fb.sets.homeGoals.labels[r.checks.homeGoals.i], '2');
  assert.equal(fb.sets.cleanHome.labels[r.checks.cleanHome.i], 'no');
  assert.equal(fb.sets.win2Home.labels[r.checks.win2Home.i], 'no');
  assert.equal(fb.sets.ht.labels[r.checks.ht.i], 'A');
  assert.equal(fb.sets.htft.labels[r.checks.htft.i], 'A/H');
  assert.equal(fb.sets.score.labels[mp.checkExtras(fb, mp.footballActual(7, 0, null)).checks.score.i], 'other');
  assert.equal(mp.checkExtras(fb, mp.footballActual(1, 0, null)).checks.ht, undefined, 'no half-time score: not checked');
  // hit = our top label happened
  const top = M.topIndex(fb.sets.cleanAway);
  assert.equal(mp.checkExtras(fb, mp.footballActual(1, 0, null)).checks.cleanAway.hit, fb.sets.cleanAway.labels[top] === 'no');

  const fit = { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 220, sigma: 12, sigmaT: 17, games: 500 };
  const bb = M.normalExtras({ sport: 'basketball', pHome: 0.3, margin: -6, total: 220, homePts: 107, awayPts: 113, fit });
  const b = mp.checkExtras(bb, mp.pointsActual(bb, 100, 112, { h: [25, 25, 25, 25, null], a: [30, 30, 26, 26, null] }, false));
  assert.equal(bb.sets.margin.labels[b.checks.margin.i], '11–15', 'away by 12 (away = our side)');
  assert.equal(bb.sets.half.labels[b.checks.half.i], 'A');
  assert.equal(bb.sets.ot.labels[b.checks.ot.i], 'no');
  assert.equal(b.checks.total.i, M.actualIndex(bb.sets.total, 212));

  const tx = M.tennisExtras(tm.tennisExtrasDist(0.65, 0.6, 3, 0), 3);
  const t = mp.checkExtras(tx, mp.tennisActual([[6, 6, 7], [4, 7, 5]], 0));
  assert.equal(tx.sets.sets.labels[t.checks.sets.i], '2-1');
  assert.equal(tx.sets.first.labels[t.checks.first.i], '1');
  assert.equal(tx.sets.tb.labels[t.checks.tb.i], 'yes');
  assert.equal(tx.sets.games.labels[t.checks.games.i], '26+', '35 games');
});

test('settle job: football, basketball, NFL and tennis rows are checked and marked', () => {
  const ko = '2026-10-01T18:00:00.000Z', made = '2026-10-01T12:00:00.000Z', now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, source_at) VALUES (?, ?, 'm', ?, ?, ?, ?)`);
  const fb = M.footballExtras(1.5, 1.1, 0.45);
  ins.run('football', 901, ko, made, JSON.stringify(fb), made);
  db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at, ht_home, ht_away) VALUES (901, 'FINISHED', 1, 1, 'D', ?, 1, 0)`).run(now);
  ins.run('football', 902, ko, made, JSON.stringify(fb), made);
  db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (902, 'CANCELLED', NULL, NULL, 'VOID', ?)`).run(now);
  const bb = M.normalExtras({ sport: 'basketball', pHome: 0.6, margin: 3, total: 220, homePts: 111.5, awayPts: 108.5, fit: { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 220, sigma: 12, sigmaT: 17, games: 0 } });
  ins.run('basketball', 903, ko, made, JSON.stringify(bb), made);
  db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, quarters, updated_at) VALUES (903, 'NBA', 12, '2026-2027', ?, 'AOT', 1, 'A', 2, 'B', 120, 115, ?, ?)`)
    .run(ko, JSON.stringify({ home: [25, 30, 25, 25, 15], away: [30, 20, 25, 30, 10] }), now);
  const nf = M.normalExtras({ sport: 'nfl', pHome: 0.4, margin: -2, total: 44, homePts: 21, awayPts: 23, fit: { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 45, sigma: 13.5, sigmaT: 13, games: 0 } });
  ins.run('nfl', 904, ko, made, JSON.stringify(nf), made);
  db.prepare(`INSERT INTO nfl_games (game_id, season, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, quarters, updated_at) VALUES (904, 2026, ?, 1, 'A', 2, 'B', 'FT', 17, 24, ?, ?)`)
    .run(ko, JSON.stringify([[7, 3, 0, 7, null], [0, 10, 7, 7, null]]), now);
  const tx = M.tennisExtras(tm.tennisExtrasDist(0.64, 0.62, 3, 0), 3);
  ins.run('tennis', 905, ko, made, JSON.stringify(tx), made);
  ins.run('tennis', 906, ko, made, JSON.stringify(tx), made);
  const tIns = db.prepare(`INSERT INTO tennis_matches (id, tournament, tour, tier, best_of, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, games, winner, outcome, source, updated_at) VALUES (?, 'T', 'atp', '250', 3, ?, 'completed', 1, 'P1', 2, 'P2', ?, ?, ?, 'test', ?)`);
  tIns.run(905, ko, JSON.stringify([[3, 6, 4], [6, 3, 6]]), 2, 'finished', now);
  tIns.run(906, ko, JSON.stringify([[3, 2], [6, 0]]), 2, 'retired', now);

  const out = mp.settleExtras();
  assert.deepEqual(out, { football: 2, basketball: 1, nfl: 1, tennis: 2 });
  const row = id => db.prepare(`SELECT settled, result FROM prediction_extras WHERE game_id = ?`).get(id);
  const res = id => JSON.parse(row(id).result);
  assert.equal(res(901).actual.htft, 'H/D');
  assert.equal(res(901).checks.score.hit, M.topIndex(fb.sets.score) === fb.sets.score.labels.indexOf('1-1'));
  assert.equal(row(902).settled, 2, 'void');
  assert.equal(res(903).actual.ot, 'yes');
  assert.equal(res(903).actual.half, 'H');
  assert.equal(res(904).actual.margin, 7, 'NFL: our side (away) by 7');
  assert.equal(res(904).actual.half, 'D');
  assert.equal(res(905).actual.sets, '1-2');
  assert.equal(res(905).actual.first, '2');
  assert.equal(row(906).settled, 2, 'retirement: void');
  assert.equal(mp.settleExtras().football, 0, 'nothing twice');
});

test('locking: free users get no numbers before the end; paid users and finished games get them', () => {
  db.prepare(`INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES ('football', 'score', 1, 1000, 1, NULL, ?), ('football', 'ht', 1, 1000, 1, NULL, ?), ('football', 'htft', 0, 1000, 8, 'off', ?)`)
    .run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const ko = new Date(Date.now() + 3 * 3600e3).toISOString();
  db.prepare(`INSERT INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, source_at) VALUES ('football', 950, 'grid-v3', ?, ?, ?, ?)`)
    .run(ko, new Date().toISOString(), JSON.stringify(M.footballExtras(1.4, 1.2, 0.45)), 'x');
  const free = mp.moreForGame('football', 950, { full: false, admin: false });
  assert.equal(free.prediction.locked, true);
  assert.equal(free.prediction.sets, undefined, 'no numbers');
  assert.deepEqual(Object.keys(free.prediction).sort(), ['locked', 'model']);
  assert.deepEqual(free.keys, ['score', 'ht'], 'only public outputs listed');
  const paid = mp.moreForGame('football', 950, { full: true, admin: false });
  assert.equal(paid.prediction.locked, false);
  assert.deepEqual(Object.keys(paid.prediction.sets), ['score', 'ht'], 'admin-only output hidden');
  const admin = mp.moreForGame('football', 950, { full: false, admin: true });
  assert.ok(admin.prediction.sets.htft && admin.prediction.adminOnly.includes('htft'));
  // finished (settled result): open for everyone, with what happened
  const done = mp.moreForGame('football', 901, { full: false, admin: false });
  assert.equal(done.state, 'done');
  assert.equal(done.prediction.locked, false);
  assert.ok(done.prediction.result && done.prediction.result.actual.score === '1-1');
});

// ---------- fix204b ----------

test('fix204b: before any stored fit the goal shrink uses k = 0.83, never no correction', () => {
  db.prepare(`DELETE FROM more_pred_fit WHERE sport = 'football' AND league = 'shrink'`).run();
  const k = mp.goalShrink();
  assert.equal(k.k, 0.83);
  assert.deepEqual(k, M.DEFAULT_GOAL_SHRINK);
  // a big game (expected goals 2.6 – 1.9): the shrink lowers "4+ goals" against the raw grid
  const raw = M.footballExtras(2.6, 1.9, 0.45, null), sh = M.footballExtras(2.6, 1.9, 0.45, k);
  assert.ok(sh.sets.goals.p[4] < raw.sets.goals.p[4] - 0.05, `4+ ${sh.sets.goals.p[4]} vs ${raw.sets.goals.p[4]}`);
  assert.equal(sh.info.shrink, 0.83);
});

test('fix204b: NBA bands are centred on the league\'s own scoring (~225), not a European default', () => {
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, 'NBA', 12, '2025-2026', ?, 'FT', 1, 'A', 2, 'B', ?, ?, ?)`);
  const now = new Date().toISOString();
  for (let i = 0; i < 60; i++) ins.run(70000 + i, new Date(Date.now() - (i + 2) * 86400e3).toISOString(), 110 + (i % 7), 108 + (i % 9), now);
  const fit = mp.bbFit('NBA');
  assert.ok(Math.abs(fit.meanTotal - 225) < 5, `NBA mean total ${fit.meanTotal}`);
  const x = M.normalExtras({ sport: 'basketball', pHome: 0.62, margin: 4, total: 228, homePts: 116, awayPts: 112, fit });
  for (const k of ['total', 'homePts', 'awayPts']) assert.ok(Math.max(...x.sets[k].p) < M.BAND_MAX, `${k}: ${x.sets[k].labels} ${x.sets[k].p}`);
  const lo = Number(x.sets.total.labels[0].slice(1));
  assert.ok(lo > 200 && lo < 225, `lowest total band ${x.sets.total.labels[0]}`);
  assert.equal(M.bandAlarm(x), null);
});

test('fix204b: the sanity check flags a band set with 100% in one band and hides that game from visitors', async () => {
  // the 23 Oct bug: an NBA game with bands around 160 → everything in "175+"
  const bad = M.normalExtras({ sport: 'basketball', pHome: 0.6, margin: 3, total: 228, homePts: 115.5, awayPts: 112.5, fit: { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 160, sigma: 12, sigmaT: 17, games: 0 } });
  assert.match(M.bandAlarm(bad) || '', /^total 175\+ (99\.\d|100)%/);
  // saved through the job: admin-only, with the reason
  const ko = new Date(Date.now() + 24 * 3600e3).toISOString(), now = new Date().toISOString();
  db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (519551, 'ZZ', 99, '2026-2027', ?, 'NS', 1, 'A', 2, 'B', ?)`).run(ko, now);
  db.prepare(`INSERT INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at) VALUES (519551, 'ZZ', ?, 'bb-v3', 0.6, 3, 228, 115.5, 112.5, ?)`).run(ko, now);
  db.prepare(`INSERT OR REPLACE INTO more_pred_fit (sport, league, json, at) VALUES ('basketball', 'ZZ', ?, ?)`).run(JSON.stringify({ share: 0.5, kHalf: 1, kOt: 1, meanTotal: 160, sigma: 12, sigmaT: 17, games: 0 }), now);
  await mp.saveExtras('basketball');
  const row = db.prepare(`SELECT admin_only, flag, calc FROM prediction_extras WHERE sport = 'basketball' AND game_id = 519551`).get();
  assert.equal(row.admin_only, 1);
  assert.match(row.flag, /175\+/);
  assert.equal(row.calc, mp.MORE_CALC);
  db.prepare(`INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES ('basketball', 'ot', 1, 1000, 1, NULL, ?)`).run(now);
  assert.equal(mp.moreForGame('basketball', 519551, { full: true, admin: false }), null, 'visitors: nothing');
  const adm = mp.moreForGame('basketball', 519551, { full: true, admin: true });
  assert.ok(adm.prediction.flag && adm.prediction.adminOnly.includes('ot'));
  assert.equal(mp.lastSave('basketball').flagged, 1);
});

test('fix204b: NFL and tennis extras are saved for a game 24 h ahead, under the game id or the unlock id', async () => {
  const ko = new Date(Date.now() + 24 * 3600e3).toISOString(), now = new Date().toISOString();
  db.prepare(`INSERT INTO nfl_games (game_id, league, season, kickoff, home_id, home_name, away_id, away_name, status, updated_at) VALUES (24733, 1, 2026, ?, 1, 'A', 2, 'B', 'NS', ?)`).run(ko, now);
  // the prediction table's copy of the time lags behind (the game was moved): the game's own time counts
  db.prepare(`INSERT INTO nfl_predictions (game_id, season, kickoff, model, p_home, margin, total, home_pts, away_pts, why, made_at) VALUES (24733, 2026, ?, 'nfl-v1', 0.64, 3.5, 44, 23.75, 20.25, '{}', ?)`)
    .run(new Date(Date.now() + 20 * 3600e3).toISOString(), now);
  db.prepare(`INSERT INTO tennis_matches (id, tournament, tour, tier, best_of, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (208177, 'T', 'atp', '250', 3, ?, 'not_started', 1, 'P1', 2, 'P2', 'test', ?)`).run(ko, now);
  db.prepare(`INSERT INTO tennis_predictions (match_id, model, scheduled_at, p1, why, made_at) VALUES (208177, 'tennis-v1', ?, 0.58, ?, ?)`).run(ko, JSON.stringify({ numbers: { servePoint: [64, 62] } }), now);
  const saved = await mp.saveExtras();
  assert.equal(saved.nfl, 1);
  assert.equal(saved.tennis, 1);
  const n = db.prepare(`SELECT kickoff FROM prediction_extras WHERE sport = 'nfl' AND game_id = 24733`).get();
  assert.equal(n.kickoff, ko, 'NFL row under the game\'s own kick-off');
  assert.equal(mp.gameIdOf('nfl', -(2e9 + 24733)), 24733);
  assert.equal(mp.gameIdOf('tennis', -(4e9 + 208177)), 208177);
  assert.equal(mp.gameIdOf('basketball', -519551), 519551);
  assert.equal(mp.gameIdOf('nfl', 24733), 24733);
  const nfl = mp.moreForGame('nfl', mp.gameIdOf('nfl', -(2e9 + 24733)), { full: false, admin: true });
  assert.ok(nfl && nfl.prediction.sets.margin, 'NFL block');
  assert.ok(mp.moreForGame('tennis', 208177, { full: false, admin: true }).prediction.sets.sets, 'tennis block');
  // data health: the real counts
  const h = Object.fromEntries(mp.moreHealth().map(x => [x.sport, x]));
  assert.equal(h.nfl.predicted, 1); assert.equal(h.nfl.saved, 1); assert.equal(h.nfl.missing, 0);
  assert.equal(h.tennis.predicted, 1); assert.equal(h.tennis.saved, 1);
  assert.ok(h.nfl.lastSave && h.nfl.lastSave.saved === 1, 'last save recorded');
  // nothing new: the next tick leaves them alone
  assert.equal((await mp.saveExtras('nfl')).nfl, 0);
  // a game the job has not reached: saved on demand
  db.prepare(`DELETE FROM prediction_extras WHERE sport = 'tennis' AND game_id = 208177`).run();
  assert.equal(mp.hasExtras('tennis', 208177), false);
  assert.equal(await mp.saveOne('tennis', 208177), true);
  assert.equal(mp.hasExtras('tennis', 208177), true);
});

test('fix204b: rows made with older maths are made again before the start', async () => {
  db.prepare(`UPDATE prediction_extras SET calc = NULL WHERE sport = 'nfl' AND game_id = 24733`).run();
  assert.equal((await mp.saveExtras('nfl')).nfl, 1);
  assert.equal(db.prepare(`SELECT calc FROM prediction_extras WHERE sport = 'nfl' AND game_id = 24733`).get().calc, mp.MORE_CALC);
});

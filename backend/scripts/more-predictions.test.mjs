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

// ---------- fix204c ----------
const C = require('../dist/utils/moreCalib.js');
/** deterministic draws (mulberry32 + Box–Muller) */
function rng(seed) {
  let s = seed;
  const u = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { u, n: () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u()) };
}

test('fix204c: bias removal moves the NBA mean predicted total to the league average (fixture set)', () => {
  // the model says 8 points too many and is too far from the league's usual score (slope 0.8)
  const r = rng(11), fit = { share: 0.49, kHalf: 1, kOt: 1, meanTotal: 225, sigma: 12, sigmaT: 18, games: 900 };
  const games = [];
  for (let i = 0; i < 1200; i++) {
    const truth = 225 + 10 * r.n(), margin = 6 * r.n(), actual = Math.round(truth + 14 * r.n()), hs = Math.round((actual + margin) / 2);
    const total = 225 + 8 + (truth - 225) / 0.8;
    games.push({ g: { league: 'NBA', pHome: 0.5 + margin / 40, margin, total, home: (total + margin) / 2, away: (total - margin) / 2, fit }, hs, as: actual - hs });
  }
  const src = mp.fitPointsSource(games.map(x => ({ league: 'NBA', row: { league: 'NBA', total: x.g.total, home: x.g.home, away: x.g.away, hs: x.hs, as: x.as, sdT: 18, sdTeam: 10 } })));
  const nba = src.leagues.NBA;
  close(nba.bT, 8, 1.2, 'fitted total bias');
  close(nba.kT, 0.8, 0.08, 'fitted slope');
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const actualMean = mean(games.map(x => x.hs + x.as));
  const raw = mean(games.map(x => x.g.total));
  const after = mean(games.map(x => { const e = mp.pointsMake('basketball', x.g, src); return e.info.expected[0] + e.info.expected[1]; }));
  assert.ok(raw - actualMean > 6, `raw mean ${raw} vs ${actualMean}`);
  close(after, actualMean, 1.5, 'corrected mean total = league average');
  // the margin bands and the win chance are not touched
  const x0 = games[0].g, a = mp.pointsMake('basketball', x0, src), b = M.normalExtras({ sport: 'basketball', pHome: x0.pHome, margin: x0.margin, total: x0.total, homePts: x0.home, awayPts: x0.away, fit });
  assert.deepEqual(a.sets.margin.p, b.sets.margin.p);
  for (const k of ['total', 'homePts', 'awayPts']) close(sum(a.sets[k].p), 1, 1e-9, `${k} sums`);
});

test('fix204c: isotonic / Platt maps are monotone and calibrated sets sum to 100%', () => {
  const r = rng(5);
  // an over-confident output: said p, happened 0.5 + 0.7·(p − 0.5)
  const pairs = Array.from({ length: 5000 }, () => { const p = r.u(); return { x: p, y: r.u() < 0.5 + 0.7 * (p - 0.5) ? 1 : 0 }; });
  const iso = C.fitIsotonic(pairs);
  assert.equal(iso.kind, 'iso');
  assert.ok(C.monotone(iso), 'isotonic map non-decreasing');
  const pl = C.fitPlatt(pairs);
  assert.equal(pl.kind, 'platt');
  assert.ok(C.monotone(pl) && pl.a < 1, `Platt a ${pl.a} < 1 (pulls toward 50%)`);
  for (let p = 0; p <= 0.95; p += 0.05) assert.ok(C.applyMap(iso, p) <= C.applyMap(iso, p + 0.05) + 1e-12);
  // multi-label: per-label and pooled maps, each set renormalised
  const labels = ['loser', '1–5', '6–10', '11–15', '16+'];
  const items = Array.from({ length: 4000 }, () => {
    const w = labels.map(() => r.u() + 0.1), s = sum(w), p = w.map(x => x / s);
    let c = r.u(), i = 0;
    while (i < 4 && c > p[i]) { c -= p[i]; i++; }
    return { p, i, labels };
  });
  for (const fixed of [[], ['loser']]) {
    const oc = C.fitOutputCalib(items, fixed);
    assert.ok(oc.perLabel || oc.pooled);
    for (const m of Object.values(oc.perLabel || { all: oc.pooled })) assert.ok(C.monotone(m));
    for (const it of items.slice(0, 200)) {
      const out = C.calibrateSet({ labels, p: it.p }, oc);
      close(sum(out.p), 1, 1e-9, 'calibrated set sums to 1');
      assert.ok(out.p.every(q => q >= 0));
      if (fixed.length) close(out.p[0], it.p[0], 1e-12, "'the other side wins' keeps its chance");
    }
  }
  const pooled = C.fitOutputCalib(items.slice(0, 900));
  assert.ok(pooled.pooled && C.monotone(pooled.pooled), 'under 1,000 forecasts: one pooled map');
  // two outcomes
  const two = C.calibrateSet({ labels: ['yes', 'no'], p: [0.8, 0.2] }, { n: 5000, pooled: pl });
  close(sum(two.p), 1, 1e-12, 'yes/no sums to 1');
  assert.ok(two.p[0] < 0.8, 'pulled toward 50%');
});

test('fix204c: the Dixon–Coles grid sums to 1 (Poisson and negative binomial), football sets still sum to 100%', () => {
  for (const [lh, la, rho, sh, sa] of [[1.4, 1.1, -0.08, null, null], [2.6, 1.9, -0.05, null, null], [0.4, 3.1, 0.05, 8, 12], [1.5, 1.2, -0.12, 20, null]]) {
    const g = C.dcGrid(lh, la, rho, sh, sa);
    close(g.reduce((s, row) => s + sum(row), 0), 1, 1e-9, `grid ${lh}-${la}`);
    assert.ok(g.every(row => row.every(q => q >= 0)));
    const x = M.footballExtras(lh, la, 0.45, { k: 0.8, mh: 1.5, ma: 1.2, kT: 0.6, kD: 0.92 }, { rho, sizeH: sh, sizeA: sa });
    for (const [k, set] of Object.entries(x.sets)) close(sum(set.p), 1, 1e-9, `${k} sums`);
    const ht = x.sets.ht.p, htft = x.sets.htft.p;
    for (let r = 0; r < 3; r++) close(htft[3 * r] + htft[3 * r + 1] + htft[3 * r + 2], ht[r], 1e-9, `HT/FT row ${r}`);
  }
  // ρ < 0 raises 0-0 and 1-1 against independent Poisson
  const p0 = C.dcGrid(1.3, 1.1, 0), p1 = C.dcGrid(1.3, 1.1, -0.1);
  assert.ok(p1[0][0] > p0[0][0] && p1[1][1] > p0[1][1] && p1[1][0] < p0[1][0]);
  // the negative binomial keeps the mean and widens the spread
  const v = C.countVec(1.6, 5), m = v.reduce((s, q, k) => s + k * q, 0), varr = v.reduce((s, q, k) => s + q * (k - m) ** 2, 0);
  close(m, 1.6, 0.03, 'NB mean');
  assert.ok(varr > 1.6 + 0.2, `NB variance ${varr}`);
  // the total and difference shrink pulls a 4.5-goal game harder than the per-side one
  const per = M.shrinkPair(2.6, 1.9, { k: 0.8, mh: 1.5, ma: 1.2 }), td = M.shrinkPair(2.6, 1.9, { k: 0.8, mh: 1.5, ma: 1.2, kT: 0.6, kD: 0.92 });
  assert.ok(td[0] + td[1] < per[0] + per[1]);
});

test('fix204c: the NFL backtest produces gates from the stored walk-forward games, with before → after and the fits', async () => {
  const r = rng(3), now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO nfl_games (game_id, league, season, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, updated_at) VALUES (?, 1, ?, ?, ?, 'H', ?, 'A', 'FT', ?, ?, ?)`);
  const wf = [];
  let id = 600000;
  db.exec('BEGIN');
  for (const season of [2023, 2024, 2025]) {
    for (let k = 0; k < 330; k++) {
      const ko = new Date(Date.UTC(season, 8, 5) + k * 4 * 3600e3).toISOString();
      const edge = 6 * r.n(), total = 44 + 4 * r.n();
      const hs = Math.max(0, Math.round((total + edge) / 2 + 7 * r.n())), as = Math.max(0, Math.round((total - edge) / 2 + 7 * r.n()));
      ins.run(++id, season, ko, 1 + (k % 32), 1 + ((k + 7) % 32), hs, as, now);
      const pHome = 1 / (1 + Math.exp(-edge / 6));
      wf.push([id, Math.round(pHome * 1e4) / 1e4, Math.round(edge * 10) / 10, Math.round((total + 3) * 10) / 10]); // says 3 points too many
    }
  }
  db.exec('COMMIT');
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('more-wf-1', ?, ?)`).run(now, JSON.stringify(wf));
  const out = await mp.runBacktests('nfl');
  assert.ok(out.nfl && out.nfl.games > 300, JSON.stringify(out));
  const gates = db.prepare(`SELECT output, public, games FROM more_pred_gate WHERE sport = 'nfl'`).all();
  assert.deepEqual(gates.map(g => g.output).sort(), [...mp.MORE_KEYS.nfl].sort());
  assert.ok(gates.filter(g => g.output !== 'half').every(g => g.games > 300), 'every output but the first half (no quarter scores here)');
  const rep = mp.backtestReports().find(x => x.sport === 'nfl');
  assert.ok(rep.before && rep.before.total && rep.diag && rep.diag.leagues['1'], 'before → after and the cause stored');
  close(rep.diag.leagues['1'].bT, 3, 1, 'the cause: 3 points too many');
  const src = db.prepare(`SELECT json FROM more_pred_fit WHERE sport = 'nfl' AND league = 'source'`).get();
  assert.ok(src && JSON.parse(src.json).leagues['1'], 'live fit stored');
  assert.match(mp.backtestMarkdown(), /American football[\s\S]*Worst step \(300\+\) before → after/);
});

test("fix204c: an expected total outside the league's range ± 3 SD is flagged", () => {
  const range = { mean: 225, sd: 18 };
  assert.equal(mp.rangeAlarm(232, range), null);
  assert.match(mp.rangeAlarm(160, range) || '', /outside 171–279/);
  assert.equal(mp.rangeAlarm(160, null), null);
});

test('fix204c: tennis total games — the group bias moves the chain\x27s games distribution, the sets stay at 100%', () => {
  const dist = tm.tennisExtrasDist(0.64, 0.6, 3, 0);
  const rows = Array.from({ length: 400 }, (_, i) => ({ group: 'atp|bo3|clay', tour: 'atp', pred: C.meanOf(dist.games), actual: C.meanOf(dist.games) - 1.5 + (i % 3) - 1 }));
  const src = mp.fitTennisSource(rows);
  close(src.groups['atp|bo3|clay'].bias, 1.5, 0.01, 'group bias');
  const raw = mp.tennisMake({ group: 'atp|bo3|clay', tour: 'atp', dist, bo: 3 }, null), fixed = mp.tennisMake({ group: 'atp|bo3|clay', tour: 'atp', dist, bo: 3 }, src);
  close(C.meanOf(C.shiftGames(dist.games, 1.5)), C.meanOf(dist.games) - 1.5, 0.05, 'mean moved by the bias');
  assert.ok(fixed.sets.games.p[0] > raw.sets.games.p[0], 'fewer games: more weight in the lowest band');
  for (const [k, set] of Object.entries(fixed.sets)) close(sum(set.p), 1, 1e-9, `${k} sums`);
  assert.deepEqual(fixed.sets.sets.p, raw.sets.sets.p, 'set score untouched by the games bias');
  // a group with few matches falls back to its tour
  close(mp.tennisMake({ group: 'atp|bo3|grass', tour: 'atp', dist, bo: 3 }, src).info.gamesBias, 1.5, 0.01, 'tour fallback');
  assert.equal(mp.tennisGroup('wta', 3, 'Hard (indoor)'), 'wta|bo3|hard');
});

// ---------- fix204d ----------
const bbm = require('../dist/services/bbModel.js');

test('fix204d: likely scores come from the independent-Poisson grid (fix204b method), the other outputs from the grid the backtest chose', () => {
  const shrinkTD = { k: 0.8, mh: 1.5, ma: 1.2, kT: 0.45, kD: 0.92 }, per = { k: 0.79, mh: 1.5, ma: 1.2 };
  const src = {
    shrink: shrinkTD, leagues: {}, all: { rho: -0.08, sizeH: null, sizeA: null }, poisson: { shrink: per },
    use: { score: 'poisson', goals: 'dc', homeGoals: 'dc', awayGoals: 'dc', cleanHome: 'dc', cleanAway: 'dc', win2Home: 'poisson', win2Away: 'poisson', ht: 'dc', htft: 'dc' }
  };
  const g = { league: null, xh: 2.6, xa: 1.9, share: 0.45 };
  const x = mp.footballMake(g, src);
  const po = M.footballExtras(2.6, 1.9, 0.45, per), dc = M.footballExtras(2.6, 1.9, 0.45, shrinkTD, src.all);
  assert.deepEqual(x.sets.score.p, po.sets.score.p, 'likely scores = Poisson grid with the per-side shrink');
  assert.deepEqual(x.info.grid6, po.info.grid6, 'the 6×6 grid comes with the likely scores');
  assert.deepEqual(x.sets.goals.p, dc.sets.goals.p, 'total goals = Dixon–Coles grid');
  assert.deepEqual(x.sets.win2Home.p, po.sets.win2Home.p);
  for (const [k, set] of Object.entries(x.sets)) close(sum(set.p), 1, 1e-9, `${k} sums`);
  // no choice stored yet: likely scores still Poisson
  const y = mp.footballMake(g, { ...src, use: undefined });
  assert.deepEqual(y.sets.score.p, po.sets.score.p);
});

test('fix204d: a new fit re-saves the stored extras of upcoming games (new calc stamp, new numbers)', async () => {
  const ko = new Date(Date.now() + 30 * 3600e3).toISOString(), now = new Date().toISOString();
  db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (777001, 'ZY', 98, '2026-2027', ?, 'NS', 1, 'A', 2, 'B', ?)`).run(ko, now);
  db.prepare(`INSERT INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at) VALUES (777001, 'ZY', ?, 'bb-v3', 0.62, 4, 240, 122, 118, ?)`).run(ko, now);
  db.prepare(`INSERT OR REPLACE INTO more_pred_fit (sport, league, json, at) VALUES ('basketball', 'ZY', ?, ?)`).run(JSON.stringify({ share: 0.5, kHalf: 1, kOt: 1, meanTotal: 226, sigma: 12, sigmaT: 18, games: 0 }), now);
  await mp.saveExtras('basketball');
  const row = () => db.prepare(`SELECT calc, json, made_at FROM prediction_extras WHERE sport = 'basketball' AND game_id = 777001`).get();
  const a = row();
  assert.ok(a && a.calc.startsWith(mp.MORE_CALC), 'saved with the current maths');
  // the backtest stores a fit: the model said 12 points too many in this league
  await new Promise(r => setTimeout(r, 5));
  mp.storeSourceFit('basketball', { leagues: { ZY: { n: 900, bT: 12, bH: 6, bA: 6, rT: 1, rH: 1, rA: 1, mT: 240, mH: 121, mA: 119, kT: 1, kH: 1, kA: 1 } }, all: null });
  const out = await mp.saveExtras('basketball');
  assert.ok(out.basketball >= 1, 'saved again');
  const b = row();
  assert.notEqual(b.calc, a.calc, 'new calc stamp');
  const ea = JSON.parse(a.json).info.expected, eb = JSON.parse(b.json).info.expected;
  close(ea[0] + ea[1], 240, 1, 'before: the model total');
  close(eb[0] + eb[1], 228, 1, 'after: 12 points less');
  const st = mp.calcStatus().find(s => s.sport === 'basketball');
  assert.ok(st.fitAt && st.current >= 1 && st.calc === mp.MORE_CALC, JSON.stringify(st));
});

test('fix204d: the gate decides on steps with 300+ forecasts only, and never lets the log loss get worse than the last public version', () => {
  const bins = [{ from: 10, n: 5000, said: 15, happened: 15.5 }, { from: 20, n: 900, said: 25, happened: 23.4 }, { from: 50, n: 200, said: 55, happened: 63 }];
  assert.deepEqual(M.calibrationOk(bins), { ok: true, worst: 1.6 }, 'the 200-forecast step is reported, not deciding');
  assert.equal(M.calibrationOk(bins, 100).ok, false, 'the old rule would have failed it');
  const s = { games: 6000, worst: 1.6, public: true, logLoss: 1.2950 };
  assert.deepEqual(mp.gateOf(s, null), { public: true, why: null }, 'no public version yet');
  assert.equal(mp.gateOf(s, 1.2946).public, true, 'within the tolerance');
  const worse = mp.gateOf({ ...s, logLoss: 1.2990 }, 1.2946);
  assert.equal(worse.public, false);
  assert.match(worse.why, /log loss 1.299 worse than its last public version/);
  assert.equal(mp.gateOf({ ...s, public: false, worst: 4.4 }, null).public, false);
});

test('fix204d: bb-v3 totals stay on the league mean when box scores lose the rebound split (fixture set ± 2 points)', async () => {
  const r = rng(21), now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, 'NBX', 97, ?, ?, ?, ?, 'H', ?, 'A', ?, ?, ?)`);
  const box = db.prepare(`INSERT INTO bb_team_stats (game_id, team_id, fgm, fga, tpm, tpa, ftm, fta, reb, oreb, dreb, ast, stl, blk, tov, pf) VALUES (?, ?, ?, ?, 12, 34, ?, ?, ?, ?, ?, 25, 7, 5, ?, 20)`);
  let id = 880000, sumAct = 0, nAct = 0;
  db.exec('BEGIN');
  for (const [season, year] of [['2023-2024', 2023], ['2024-2025', 2024], ['2025-2026', 2025]]) {
    for (let k = 0; k < 900; k++) {
      const ko = new Date(Date.UTC(year, 10, 1) + k * 4 * 3600e3).toISOString();
      const h = 1 + (k % 30), a = 1 + ((k * 7 + 3) % 30) === h ? 1 + ((h + 1) % 30) : 1 + ((k * 7 + 3) % 30);
      const hs = Math.round(116 + 6 * r.n()), as = Math.round(112 + 6 * r.n());
      ins.run(++id, season, ko, 'FT', h, a, hs, as, now);
      if (season === '2025-2026') { sumAct += hs + as; nAct++; }
      // the provider's split is gone in the last season (the real case since Jan 2026); one box score doubled
      const split = season !== '2025-2026';
      for (const [tid, pts] of [[h, hs], [a, as]]) {
        const fga = 88 + Math.round(4 * r.n()), fgm = Math.round(fga * 0.47), fta = 22, oreb = 10 + Math.round(2 * r.n());
        const dbl = k === 450 && season === '2025-2026' ? 2 : 1;
        box.run(id, tid, fgm * dbl, fga * dbl, 17 * dbl, fta * dbl, 44 * dbl, split ? oreb : null, split ? 34 : null, 14 * dbl);
        void pts;
      }
    }
  }
  for (let k = 0; k < 40; k++) ins.run(++id, '2026-2027', new Date(Date.now() + (k + 2) * 3600e3).toISOString(), 'NS', 1 + (k % 30), 1 + ((k + 11) % 30), null, null, now);
  db.exec('COMMIT');
  const m = await bbm.buildLeague('NBX', { retune: true });
  assert.ok(m, 'league built');
  const up = db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week FROM bb_games WHERE code = 'NBX' AND status = 'NS'`).all();
  const tot = up.map(g => bbm.predictGame(g).total), mean = tot.reduce((s, x) => s + x, 0) / tot.length;
  const chk = bbm.leagueTotalsCheck('NBX');
  close(mean, sumAct / nAct, 2, `predicted total = the league mean ± 2 (${JSON.stringify(chk)})`);
  assert.ok(chk && chk.upcoming === 40 && Math.abs(chk.upcomingTotal - sumAct / nAct) < 2, JSON.stringify(chk));
});

// fix215: season forecast on a scratch database — a Premier League season half played (af_fixtures + a settled result
// the fixture feed hasn't caught yet), an NBA-like basketball league, the NFL: inputs built, run in-process, stored;
// the Free view keeps the top three / bottom three + favourites; "what this game means"; data health. (dist build)
// Run: npm run test:fix215
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix215-season-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/tracking.js');
require('../dist/services/apiFootball.js');
require('../dist/services/basketball.js');
require('../dist/services/nfl.js');
const F = require('../dist/services/seasonForecast.js');
const { AF_OFFSET } = require('../dist/services/afMatches.js');

const DAY = 86400000;
const iso = t => new Date(t).toISOString();

function roundRobin(n) {
  const ids = Array.from({ length: n }, (_, i) => i), rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const rd = [];
    for (let k = 0; k < n / 2; k++) rd.push(r % 2 ? [ids[k], ids[n - 1 - k]] : [ids[n - 1 - k], ids[k]]);
    rounds.push(rd); ids.splice(1, 0, ids.pop());
  }
  return [...rounds, ...rounds.map(rd => rd.map(([a, b]) => [b, a]))];
}

test('football: inputs from af_fixtures + settled results, run, stored, Free view, what a game means', async () => {
  const insF = db.prepare(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status, hg, ag) VALUES (?, 39, 2026, 'E', 'E0', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const t0 = Date.now() - 100 * DAY;
  let fid = 1, settledFid = null;
  roundRobin(20).forEach((rd, r) => rd.forEach(([h, a]) => {
    const ko = iso(t0 + r * 7 * DAY + 3600000), past = Date.parse(ko) < Date.now() - DAY;
    const strong = h < a;
    // the last played round is "NS" in the fixture feed but settled in results
    const late = r === 13;
    insF.run(fid, ko, ko.slice(0, 10), 100 + h, 100 + a, `Club ${h}`, `Club ${a}`, past && !late ? 'FT' : 'NS', past && !late ? (strong ? 2 : 0) : null, past && !late ? (strong ? 0 : 1) : null);
    if (late && past) { db.prepare(`INSERT OR REPLACE INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', 3, 3, 'D', ?)`).run(AF_OFFSET + fid, iso(Date.now())); settledFid = fid; }
    fid++;
  }));
  assert.ok(settledFid);
  const n = await F.runSeasonForecast([{ sport: 'football', code: 'PL' }], 'test');
  assert.equal(n, 1, JSON.stringify(db.prepare('SELECT * FROM season_forecast_skips').all()));
  const lg = F.leagueForecast('football', 'PL');
  assert.equal(lg.teams.length, 20);
  assert.equal(lg.runs, 20000);
  assert.deepEqual(lg.zones, ['title', 'cl', 'europe', 'relegation']);
  // the settled 3–3 draws counted: every team played every past round
  const pastRounds = roundRobin(20).filter((_, r) => t0 + r * 7 * DAY + 3600000 < Date.now() - DAY).length;
  for (const t of lg.teams) assert.equal(t.now.played, pastRounds, `${t.name} played`);
  assert.ok(lg.teams.some(t => t.now.d > 0), 'the settled draws are in the table');
  // fix218: every stored row adds up to exactly 100 % after rounding (largest remainder), 4 decimals each
  for (const t of lg.teams) { assert.equal(Math.round(t.pos.reduce((a, b) => a + b, 0) * 1e6), 1e6, `${t.name} row sum`); for (const p of t.pos) assert.equal(p, Math.round(p * 1e4) / 1e4); }
  // team ids: no FD twin map here → API-Football + offset
  assert.ok(lg.teams.some(t => t.id === String(AF_OFFSET + 100)));
  // Free: top three, bottom three, + a favourite; the rest locked, in today's order
  const fav = String(AF_OFFSET + 110);
  const free = F.leagueView(lg, false, new Set([fav]));
  const open = free.teams.filter(t => !t.locked);
  assert.equal(open.length, 7);
  assert.ok(open.some(t => t.id === fav));
  assert.equal(free.locked, 13);
  assert.ok(free.teams.filter(t => t.locked).every(t => t.pos === undefined && t.zones === undefined));
  const pro = F.leagueView(lg, true, new Set());
  assert.equal(pro.teams.filter(t => !t.locked).length, 20);
  // history row today, team index
  assert.equal(F.teamForecastCodes('football', fav)[0], 'PL');
  assert.equal(F.teamHistory('football', 'PL', lg.season, fav).length, 1);
  // what this game means: next round's games are watched
  const g = db.prepare(`SELECT game_id FROM season_forecast_games WHERE sport = 'football' LIMIT 1`).get();
  assert.ok(g, 'watched games stored');
  const m = F.gameMeaning('football', g.game_id);
  if (m) {
    assert.deepEqual(m.results, ['H', 'D', 'A']);
    for (const side of [m.home, m.away]) for (const l of side.lines) {
      const v = l.byResult.filter(x => x != null);
      assert.ok(Math.max(...v) - Math.min(...v) >= 0.02, 'only moves of 2 points or more');
    }
  }
  // data health: fresh, rules known for PL, sums ok
  const checks = F.seasonForecastChecks();
  assert.equal(checks.find(c => c.id === 'season-forecast-fresh').level, 'ok');
  assert.equal(checks.find(c => c.id === 'season-forecast-sums').level, 'ok');
  // a new finished game the stored run hasn't seen → due again (dirty) and late after 30 min
  assert.ok(F.lastFinals().get('football|PL'));
});

test('basketball: regular season only, our predictions or ratings, playoff zones', async () => {
  db.prepare(`INSERT OR REPLACE INTO bb_leagues (code, league_id, name, country, seasons) VALUES ('ACB', 117, 'Liga ACB', 'Spain', '["2025-2026","2026-2027"]')`).run();
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, 'ACB', 117, '2026-2027', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-01')`);
  const t0 = Date.now() - 60 * DAY;
  let id = 5000;
  roundRobin(18).forEach((rd, r) => rd.forEach(([h, a]) => {
    const ko = iso(t0 + r * 4 * DAY), past = Date.parse(ko) < Date.now() - DAY;
    ins.run(id++, 'Regular Season', ko, past ? 'FT' : 'NS', 200 + h, `BC ${h}`, 200 + a, `BC ${a}`, past ? 80 + (h < a ? 10 : 0) : null, past ? 80 + (h < a ? 0 : 10) : null);
  }));
  ins.run(id++, 'Play Offs', iso(Date.now() + 200 * DAY), 'NS', 200, 'BC 0', 201, 'BC 1', null, null);
  const n = await F.runSeasonForecast([{ sport: 'basketball', code: 'ACB' }], 'test');
  assert.equal(n, 1, JSON.stringify(db.prepare('SELECT * FROM season_forecast_skips').all()));
  const lg = F.leagueForecast('basketball', 'ACB');
  assert.equal(lg.teams.length, 18);
  assert.deepEqual(lg.zones, ['title', 'final', 'playoffs', 'relegation']);
  const sum = k => lg.teams.reduce((s, t) => s + (t.zones[k] || 0), 0);
  assert.ok(Math.abs(sum('playoffs') - 8) < 0.01 && Math.abs(sum('title') - 1) < 0.01 && Math.abs(sum('relegation') - 2) < 0.01);
});

test('NFL: divisions from nfl_teams, 14 play-off teams, Elo for games without a saved prediction', async () => {
  const insT = db.prepare(`INSERT OR REPLACE INTO nfl_teams (team_id, name, conference, division, league, level, updated_at) VALUES (?, ?, ?, ?, 1, NULL, '2026-10-01')`);
  for (let i = 0; i < 32; i++) insT.run(i + 1, `Team ${i + 1}`, i < 16 ? 'AFC' : 'NFC', `${i < 16 ? 'AFC' : 'NFC'} ${['East', 'North', 'South', 'West'][Math.floor((i % 16) / 4)]}`);
  const ins = db.prepare(`INSERT INTO nfl_games (game_id, season, week, stage, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, league, updated_at) VALUES (?, 2026, ?, 'Regular Season', ?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-10-01')`);
  const t0 = Date.now() - 50 * DAY;
  let id = 9000;
  roundRobin(32).slice(0, 17).forEach((rd, r) => rd.forEach(([h, a]) => {
    const ko = iso(t0 + r * 7 * DAY), past = Date.parse(ko) < Date.now() - DAY;
    ins.run(id++, `Week ${r + 1}`, ko, h + 1, `Team ${h + 1}`, a + 1, `Team ${a + 1}`, past ? 'FT' : 'NS', past ? 24 : null, past ? 17 : null);
  }));
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('current', ?, '2026')`).run(iso(Date.now()));
  const n = await F.runSeasonForecast([{ sport: 'nfl', code: 'NFL' }], 'test');
  assert.equal(n, 1, JSON.stringify(db.prepare('SELECT * FROM season_forecast_skips').all()));
  const lg = F.leagueForecast('nfl', 'NFL');
  const sum = k => lg.teams.reduce((s, t) => s + (t.zones[k] || 0), 0);
  assert.ok(Math.abs(sum('playoffs') - 14) < 0.01, `playoffs ${sum('playoffs')}`);
  assert.ok(Math.abs(sum('div_title') - 8) < 0.01);
  assert.ok(Math.abs(sum('title') - 1) < 0.01);
  assert.deepEqual(lg.groups, ['AFC', 'NFC']);
});

test('fix218: largest-remainder rounding, the noise fit on a replayed season, the ">99%" calibration flag', async () => {
  // rows that used to add up to 100.2 %
  const row = F.roundRow([0.33335, 0.33335, 0.3333]);
  assert.equal(Math.round(row.reduce((a, b) => a + b, 0) * 1e4), 1e4);
  assert.deepEqual(F.roundRow([0.5, 0.25, 0.25]), [0.5, 0.25, 0.25]);
  assert.equal(Math.round(F.roundRow(Array.from({ length: 12 }, () => 1 / 12)).reduce((a, b) => a + b, 0) * 1e4), 1e4);
  // before the replay: base noise, no drift, extremes capped
  assert.deepEqual(F.noiseFor('football'), { noise: 0.1, walk: 0, fitted: false });
  assert.deepEqual(F.extremesFor('football'), { hi: false, lo: false });
  // a past season to replay: the fit tries the grid at matchweeks 5 / 10 / 20 and stores one pair per sport
  const { fitNoiseHere, replayHere } = require('../dist/utils/seasonFit.js');
  const { rulesFor } = require('../dist/utils/seasonRules.js');
  const teams = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `Club ${i}` }));
  const start = Date.parse('2025-08-10T14:00:00Z');
  const games = [];
  let r = 0;
  for (let round = 0; round < 38; round++) for (let k = 0; k < 10; k++) {
    const h = (round + k) % 20, a = (round * 3 + 19 - k) % 20; if (h === a) continue;
    const str = i => 1.5 - i * 0.06;
    games.push({ home: `t${h}`, away: `t${a}`, hg: Math.round(Math.max(0, str(h) + 0.2 + ((r * 7) % 5 - 2) * 0.4)), ag: Math.round(Math.max(0, str(a) + ((r * 11) % 5 - 2) * 0.4)), kickoff: new Date(start + round * 7 * DAY + k * 3600e3).toISOString() }); r++;
  }
  const L = { sport: 'football', code: 'PL', name: 'PL', season: '2025', rules: rulesFor('football', 'PL'), teams, games, preds: [], base: { runs: 400, seed: 7, home: 0.2, drawBand: 0.33, sigma: 1, noise: 0.1, goalsH: 1.5, goalsA: 1.2 } };
  const fit = fitNoiseHere(L);
  assert.equal(fit.tried.length, 20, 'every (noise, walk) pair of the grid tried');
  assert.ok(Number.isFinite(fit.brier) && fit.noise > 0);
  const rep = replayHere({ ...L, base: { ...L.base, noise: fit.noise, walk: fit.walk } });
  assert.ok(rep.steps > 20 && rep.extremes && typeof rep.extremes.hi.n === 'number');
  // stored like the job does → used by the next forecast, and the flag answers from the bins
  db.prepare(`INSERT OR REPLACE INTO season_forecast_params (sport, noise, walk, json, at) VALUES ('football', ?, ?, '[]', ?)`).run(fit.noise, fit.walk, new Date().toISOString());
  assert.deepEqual(F.noiseFor('football'), { noise: fit.noise, walk: fit.walk, fitted: true });
  db.prepare(`INSERT OR REPLACE INTO season_forecast_accuracy (sport, code, season, json, at) VALUES ('football', 'PL', '2025', ?, ?)`).run(JSON.stringify({ ...rep, extremes: { hi: { n: 40, hits: 40 }, lo: { n: 40, hits: 3 } } }), new Date().toISOString());
  assert.deepEqual(F.extremesFor('football'), { hi: true, lo: false });
  assert.equal(F.leagueView(F.leagueForecast('football', 'PL'), true, new Set()).extremes.hi, true);
});

// fix203: a competition "in testing" counts in the overall record like every other (football and basketball), on a
// scratch database (dist build). Run: npm run test:fix203
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix203-record-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
// the old switches must have no effect any more
process.env.TRIAL_COMPETITIONS = 'AF79,AF999';
process.env.BB_TRIAL_LEAGUES = 'BSN,BB999';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const tracking = require('../dist/services/tracking.js');
const bb = require('../dist/services/bbModel.js');
require('../dist/services/leagueConfig.js');
require('../dist/services/bbLeagueConfig.js');
require('../dist/services/basketball.js');
require('../dist/services/bbResults.js');

const DAY = 86400000;
const iso = t => new Date(t).toISOString();
const ago = d => iso(Date.now() - d * DAY);

// football: a top league, a default "in testing" league (AF79) and one added from the admin panel, still in testing
db.prepare(`INSERT INTO af_extra_leagues (league_id, name, country, calendar, trial, enabled, added_at) VALUES (999, 'Test League', 'Testland', 0, 1, 1, ?)`).run(ago(5));
const fb = (id, code, name, d, outcome) => {
  db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at)
    VALUES (?, 'grid-v3', ?, ?, ?, 'Home', 'Away', 60, 25, 15, 1, 1, ?, ?)`).run(id, code, name, ago(d), ago(d + 1), ago(d));
  db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', ?, ?, ?, ?)`)
    .run(id, outcome === 'A' ? 0 : 1, outcome === 'H' ? 0 : 1, outcome, ago(d));
};
fb(1, 'PL', 'Premier League', 2, 'H');
fb(2, 'AF79', '2. Bundesliga', 3, 'D');
fb(3, 'AF999', 'Test League', 4, 'A');

// basketball: NBA (regular season), BSN (old default "in testing"), a league added from the admin panel, an NBA pre-season game
db.prepare(`INSERT INTO bb_extra_leagues (league_id, name, country, flag, trial, enabled, added_at) VALUES (999, 'Test BB', 'Testland', NULL, 1, 1, ?)`).run(ago(5));
let gid = 100;
const bbGame = (code, kickoff, homeWon) => {
  const id = ++gid;
  db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at)
    VALUES (?, ?, 1, '2026-2027', ?, 'FT', ?, 'Home', ?, 'Away', ?, ?, ?)`).run(id, code, kickoff, id * 10, id * 10 + 1, homeWon ? 100 : 90, homeWon ? 90 : 100, kickoff);
  db.prepare(`INSERT INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at)
    VALUES (?, ?, ?, 'bb-v3', 0.75, 6, 190, 98, 92, ?)`).run(id, code, kickoff, iso(Date.parse(kickoff) - DAY));
};
bbGame('NBA', ago(1), true);
bbGame('BSN', ago(2), true);
bbGame('BB999', ago(3), false);
const year = new Date().getUTCFullYear();
const pre = `${year}-10-10T00:00:00.000Z`;
if (Date.parse(pre) < Date.now() && Date.now() - Date.parse(pre) < 300 * DAY) bbGame('NBA', pre, true);

test('football: games of competitions in testing count in the overall record', () => {
  const rec = tracking.publicRecord(30);
  assert.equal(rec.doubleChance.n, 3, 'all three competitions counted');
  assert.equal(rec.doubleChance.v3Hits, 2, 'H and D inside 1X, A outside');
  assert.deepEqual(rec.byCompetition.length, 0, 'per-competition table: under 5 games each');
  const acc = tracking.accuracy(30, undefined, 'main');
  assert.equal(acc.settled, 3);
});

test('basketball: leagues in testing count in totals, bands, calibration and lists; pre-season stays out', () => {
  const rec = bb.bbRecord(30);
  assert.equal(rec.total.n, 3);
  assert.equal(rec.total.hits, 2);
  assert.equal(rec.total.strongN, 3, '75% picks are strong');
  assert.equal(rec.bands.find(b => b.min === 0).n, 3);
  assert.equal(rec.calibration.reduce((s, b) => s + b.n, 0), 6, 'both sides of each of the 3 games');
  assert.equal(rec.byConfidence.reduce((s, b) => s + b.n, 0), 3);
  assert.deepEqual(rec.leagues.map(l => l.code).sort(), ['BB999', 'BSN', 'NBA']);
  assert.ok(rec.leagues.every(l => !('trial' in l)), 'no "in testing" flag on public rows');
  assert.equal(rec.recent.length, 3);
  assert.equal(rec.scores.scoreN, 3);
});

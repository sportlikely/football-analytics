// fix234: what the checks found after 225–231 — football results filled from our own finals (the file's row replaces
// them), the tennis stale / duplicate rules, admin jobs that answer at once, the season forecast rules version.
// (dist build) Run: npm run test:fix234
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix234-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/apiFootball.js');
require('../dist/services/afMatches.js');
const H = require('../dist/services/history.js');
const T = require('../dist/services/tennis.js');
const J = require('../dist/services/adminJobs.js');

const DAY = 86400000, HOUR = 3600000, NOW = Date.now();
const iso = t => new Date(t).toISOString();
const day = t => iso(t).slice(0, 10);

test('football: a finished game missing from the file is filled from our final, then replaced by the file row', () => {
  const d = day(NOW - 2 * DAY);
  db.prepare(`INSERT INTO af_teams (grp, team_id, name, fd_name) VALUES ('E', 1, 'Arsenal FC', 'Arsenal'), ('E', 2, 'Chelsea FC', 'Chelsea'), ('E', 3, 'Spurs', NULL), ('E', 4, 'Everton FC', 'Everton')`).run();
  const fx = db.prepare(`INSERT INTO af_fixtures (fixture_id, league_id, season, grp, division, kickoff, date, home_id, away_id, home_name, away_name, status, hg, ag) VALUES (?, 39, 2026, 'E', 'E0', ?, ?, ?, ?, 'x', 'y', ?, ?, ?)`);
  fx.run(101, iso(NOW - 2 * DAY), d, 1, 2, 'FT', 2, 1);      // final at API-Football
  fx.run(102, iso(NOW - 2 * DAY), d, 3, 1, 'FT', 0, 0);      // a team without a file name: skipped
  fx.run(103, iso(NOW - DAY), day(NOW - DAY), 4, 2, 'NS', null, null); // API-Football not final yet, FD settled it
  db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (9001, 'FINISHED', 1, 3, 'A', ?)`).run(iso(NOW - DAY));
  db.prepare(`INSERT INTO fd_af_links (fd_id, af_id, swapped, at) VALUES (9001, 103, 1, ?)`).run(iso(NOW));
  const f = H.fillFromFinals(NOW);
  assert.equal(f.added, 2);
  assert.equal(f.unmapped, 1);
  const rows = db.prepare(`SELECT home, away, hg, ag, provisional FROM history_matches WHERE division = 'E0' ORDER BY home`).all();
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { home: 'Arsenal', away: 'Chelsea', hg: 2, ag: 1, provisional: 1 },
    { home: 'Everton', away: 'Chelsea', hg: 3, ag: 1, provisional: 1 } // the link was swapped: FD's away goals are the AF home's
  ]);
  assert.equal(H.fillFromFinals(NOW).added, 0, 'run twice: nothing new');
  // the file's row arrives a day later in local time: the filled row goes, the file's stays
  db.prepare(`INSERT INTO history_matches (division, season, date, home, away, hg, ag, sh_h) VALUES ('E0', '2627', ?, 'Arsenal', 'Chelsea', 2, 1, 14)`).run(day(NOW - DAY));
  const g = H.fillFromFinals(NOW);
  assert.equal(g.replaced, 1);
  const ars = db.prepare(`SELECT provisional, sh_h FROM history_matches WHERE division = 'E0' AND home = 'Arsenal'`).all();
  assert.equal(ars.length, 1);
  assert.equal(ars[0].sh_h, 14);
});

test('tennis: live with no point for 4 h or upcoming 6 h after the start is stale; a recent point is not', () => {
  const start = iso(NOW - 12 * HOUR);
  assert.match(T.tennisStaleReason({ status: 'live', scheduled_at: start, point_at: iso(NOW - 5 * HOUR) }, NOW), /no point for 5 h/);
  assert.equal(T.tennisStaleReason({ status: 'live', scheduled_at: start, point_at: iso(NOW - 10 * 60000) }, NOW), null);
  assert.match(T.tennisStaleReason({ status: 'live', scheduled_at: start, point_at: null }, NOW), /no point for 12 h/);
  assert.equal(T.tennisStaleReason({ status: 'upcoming', scheduled_at: iso(NOW - 5 * HOUR) }, NOW), null);
  assert.match(T.tennisStaleReason({ status: 'upcoming', scheduled_at: iso(NOW - 7 * HOUR) }, NOW), /still upcoming 7 h/);
  assert.equal(T.tennisStaleReason({ status: 'completed', scheduled_at: start }, NOW), null);
});

test('tennis: one duplicate rule — same players, same tournament, within a day', () => {
  const r = (id, t, tournament, p1 = 10, p2 = 20) => ({ id, p1_id: p1, p2_id: p2, scheduled_at: iso(NOW + t * HOUR), tournament });
  const groups = T.duplicateGroups([
    r(209382, 0, 'M15 Sharm El Sheikh'), r(209413, 2, 'M15 Sharm El Sheikh', 20, 10), // the 25 Oct pair (order swapped)
    r(1, 3, 'M15 Sharm El Sheikh 2026'), // the same tournament by its key
    r(2, 5, 'W35 Cairo'),                // other tournament: not the same match
    r(3, 30, 'M15 Sharm El Sheikh'),     // over a day later
    r(4, 1, null, 30, 40), r(5, 2, 'M25 Rome', 30, 40) // a row without a tournament matches any
  ]);
  assert.deepEqual(groups.map(g => g.map(x => x.id)).sort(), [[209382, 209413, 1], [4, 5]].sort());
});

test('tennis: a live row we marked unknown is not revived by the live list with the same score; a new score brings it back', () => {
  const m = (score, status = 'live') => ({ id: 777001, tournament: 'M15 Sharm El Sheikh', tour: 'itf', status, scheduled_time: iso(NOW - 13 * HOUR), players: { p1: { id: 1, name: 'Alpha One' }, p2: { id: 2, name: 'Beta Two' } }, score });
  T.storeMatch(m({ sets: [[1, 0]], games: [[6, 3]] }), 'live');
  const p0 = db.prepare(`SELECT point_at FROM tennis_matches WHERE id = 777001`).get().point_at;
  assert.ok(p0);
  db.prepare(`UPDATE tennis_matches SET status = 'unknown' WHERE id = 777001`).run();
  T.storeMatch(m({ sets: [[1, 0]], games: [[6, 3]] }), 'live');
  assert.equal(db.prepare(`SELECT status FROM tennis_matches WHERE id = 777001`).get().status, 'unknown');
  T.storeMatch(m({ sets: [[1, 0]], games: [[6, 3], [1, 0]] }), 'live');
  assert.equal(db.prepare(`SELECT status FROM tennis_matches WHERE id = 777001`).get().status, 'live');
  db.prepare(`UPDATE tennis_matches SET status = 'void' WHERE id = 777001`).run();
  T.storeMatch(m({ sets: [[2, 0]], games: [[6, 3], [6, 0]] }, 'completed'), 'history');
  assert.equal(db.prepare(`SELECT status FROM tennis_matches WHERE id = 777001`).get().status, 'void', 'a voided match stays void');
});

test('admin jobs answer at once: queued / running, then the result; one run at a time', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const j = J.startAdminJob('test fit', { apply: 'gate' }, async () => { await gate; return { gate: { reason: 'ok' }, params: { big: 1 } }; });
  assert.ok(['queued', 'running'].includes(j.state));
  assert.equal(J.startAdminJob('test fit', {}, () => 1), j, 'a second start while running is the same job');
  const a = J.adminJobAnswer('test fit', { old: true });
  assert.equal(a.job.running, true);
  assert.equal(a.result, null);
  assert.deepEqual(a.stored, { old: true });
  release();
  await new Promise(r => setTimeout(r, 50));
  const b = J.adminJobAnswer('test fit', null, r => ({ ...r, params: undefined }));
  assert.equal(b.job.state, 'done');
  assert.equal(b.result.gate.reason, 'ok');
  assert.equal(b.result.params, undefined);
});

test('season forecast: the rules version is stable and changes with the rules', () => {
  const S = require('../dist/services/seasonForecast.js');
  const R = require('../dist/utils/seasonRules.js');
  const v = S.rulesVersion();
  assert.equal(S.rulesVersion(), v);
  R.FOOTBALL_SKIP.TEST = 'x';
  assert.notEqual(S.rulesVersion(), v);
  delete R.FOOTBALL_SKIP.TEST;
  assert.equal(S.rulesVersion(), v);
});

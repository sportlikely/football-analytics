// fix200: games past kick-off + 48 h — looked up by id, then by the two teams, and settled / moved / voided on a scratch
// database (dist build). Run: npm run test:fix200
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix200-unsettled-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const u = require('../dist/services/unsettled.js');

const AF = 1_000_000_000, H = 3600000, DAY = 24 * H;
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const iso = t => new Date(t).toISOString();
const add = (id, ko, home, away, homeId, awayId) => db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team,
  p_home, p_draw, p_away, locked, settled, created_at, updated_at) VALUES (?, 'grid-v3', 'AF307', 'Pro League (Saudi Arabia)', ?, ?, ?, ?, ?, 0.4, 0.3, 0.3, 1, 0, ?, ?)`)
  .run(id, ko, homeId, home, awayId, away, iso(NOW), iso(NOW));
const fx = (id, date, status, home, away, gh = null, ga = null) => ({ fixture: { id, date, status: { short: status } }, teams: { home: { id: home }, away: { id: away } }, goals: { home: gh, away: ga }, score: { fulltime: { home: gh, away: ga } } });

// A: the fixture id is a phantom; the real game (same teams, next day, another id) finished 2–1
add(AF + 1, iso(NOW - 4 * DAY), 'Al-Ahli', 'Al-Nassr', AF + 10, AF + 11);
// B: postponed, no new date
add(AF + 2, iso(NOW - 3 * DAY), 'Al Riyadh', 'Al-Hilal', AF + 12, AF + 13);
// C: not found anywhere (Abha – Al Kholood: Abha is not in the league)
add(AF + 3, iso(NOW - 3 * DAY), 'Abha', 'Al Kholood', AF + 14, AF + 15);
// D: Football-Data.org game moved to next week
add(555, iso(NOW - 3 * DAY), 'Atromitos', 'AEK', 70, 71);
// E: only 30 h ago: not touched
add(AF + 5, iso(NOW - 30 * H), 'Al-Ittihad', 'Al Shabab', AF + 16, AF + 17);

const calls = { ids: 0, teams: 0, fd: 0 };
const providers = {
  afByIds: async ids => { calls.ids++; return ids.includes(2) ? [fx(2, iso(NOW - 3 * DAY), 'PST', 12, 13)] : []; },
  afByTeams: async (home, away) => { calls.teams++; return home === 10 && away === 11 ? [fx(77, iso(NOW - 3 * DAY), 'FT', 10, 11, 2, 1), fx(78, iso(NOW - 30 * DAY), 'FT', 11, 10, 0, 0)] : []; },
  fdRange: async () => { calls.fd++; return [{ id: 555, status: 'POSTPONED', utcDate: iso(NOW + 6 * DAY), homeTeam: { id: 70, name: 'Atromitos' }, awayTeam: { id: 71, name: 'AEK Athens' }, score: {} }]; }
};
const result = id => db.prepare(`SELECT outcome, home_goals, away_goals, reason FROM results WHERE match_id = ?`).get(id);
const pred = id => db.prepare(`SELECT settled, locked, utc_date FROM predictions WHERE match_id = ?`).get(id);

test('first run: final found by the two teams, postponed without a date, not found, moved', async () => {
  const r = await u.resolveUnsettled(providers, { now: NOW });
  assert.equal(r.checked, 4, 'E (30 h) is not looked at');
  assert.deepEqual([r.settled, r.voided, r.retry, r.moved], [1, 1, 1, 1]);
  // A settled with the real game's score
  assert.equal(result(AF + 1).outcome, 'H');
  assert.equal(result(AF + 1).home_goals, 2);
  assert.equal(pred(AF + 1).settled, 1);
  // B void, with the reason, never counted
  assert.equal(result(AF + 2).outcome, 'VOID');
  assert.match(result(AF + 2).reason, /postponed/);
  // C waits for its next attempt
  assert.equal(result(AF + 3), undefined);
  assert.equal(db.prepare(`SELECT attempts FROM settle_lookups WHERE match_id = ?`).get(AF + 3).attempts, 1);
  // D moved to the new date, unlocked, not settled
  assert.equal(pred(555).utc_date, iso(NOW + 6 * DAY));
  assert.equal(pred(555).locked, 0);
  assert.equal(result(555), undefined);
  // E untouched
  assert.equal(pred(AF + 5).settled, 0);
});

test('not found: one attempt per day, void on the third day', async () => {
  await u.resolveUnsettled(providers, { now: NOW + 2 * H }); // same day: still 1
  assert.equal(db.prepare(`SELECT attempts FROM settle_lookups WHERE match_id = ?`).get(AF + 3).attempts, 1);
  await u.resolveUnsettled(providers, { now: NOW + DAY });
  assert.equal(db.prepare(`SELECT attempts FROM settle_lookups WHERE match_id = ?`).get(AF + 3).attempts, 2);
  const r = await u.resolveUnsettled(providers, { now: NOW + 2 * DAY });
  assert.ok(r.voided >= 1);
  assert.equal(result(AF + 3).outcome, 'VOID');
  assert.match(result(AF + 3).reason, /not found/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM settle_lookups WHERE match_id = ?`).get(AF + 3).n, 0);
});

test('admin list and the data-health note; voids are out of the accuracy rows', () => {
  const v = u.voidedGames(3650);
  assert.deepEqual(v.map(x => x.id).sort(), [AF + 2, AF + 3].sort());
  assert.ok(v.every(x => x.reason));
  assert.equal(u.voidedThisMonth(NOW + 3 * DAY), 2);
  // every accuracy query reads outcome IN ('H','D','A') only
  const counted = db.prepare(`SELECT COUNT(*) AS n FROM predictions p JOIN results r ON r.match_id = p.match_id WHERE p.settled = 1 AND r.outcome IN ('H','D','A')`).get().n;
  assert.equal(counted, 1);
});

test('a provider outage is not an attempt', async () => {
  add(AF + 9, iso(NOW - 3 * DAY), 'Al-Fateh', 'Al-Taawoun', AF + 20, AF + 21);
  const down = { ...providers, afByIds: async () => { throw new Error('HTTP 500'); } };
  const r = await u.resolveUnsettled(down, { now: NOW + 3 * DAY });
  assert.equal(r.checked, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM settle_lookups WHERE match_id = ?`).get(AF + 9).n, 0);
});

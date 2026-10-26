// fix200: games past kick-off + 48 h — looked up by id, then by the two teams, and settled / moved / voided on a scratch
// database (dist build). fix240: looked up from 24 h (the other provider's twin too); no final at 48 h → Needs you
// (Enter result / Void) instead of an automatic void. Run: npm run test:fix200
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
// E: 30 h ago, no final yet: looked again (fix240), not in Needs you
add(AF + 5, iso(NOW - 30 * H), 'Al-Ittihad', 'Al Shabab', AF + 16, AF + 17);
// F: 20 h ago: not touched (the normal settle job has it)
add(AF + 6, iso(NOW - 20 * H), 'Al-Fateh', 'Damac', AF + 18, AF + 19);
// G (fix240): a Football-Data game with no final at Football-Data; its API-Football twin finished 0–3
add(556, iso(NOW - 28 * H), 'Morton', 'Ayr', 72, 73);

const calls = { ids: 0, teams: 0, fd: 0 };
const providers = {
  afByIds: async ids => {
    calls.ids++;
    const out = [];
    if (ids.includes(2)) out.push(fx(2, iso(NOW - 3 * DAY), 'PST', 12, 13));
    if (ids.includes(5)) out.push(fx(5, iso(NOW - 30 * H), 'NS', 16, 17));
    if (ids.includes(900)) out.push(fx(900, iso(NOW - 28 * H), 'FT', 80, 81, 0, 3));
    return out;
  },
  afByTeams: async (home, away) => { calls.teams++; return home === 10 && away === 11 ? [fx(77, iso(NOW - 3 * DAY), 'FT', 10, 11, 2, 1), fx(78, iso(NOW - 30 * DAY), 'FT', 11, 10, 0, 0)] : []; },
  fdRange: async () => {
    calls.fd++;
    return [
      { id: 555, status: 'POSTPONED', utcDate: iso(NOW + 6 * DAY), homeTeam: { id: 70, name: 'Atromitos' }, awayTeam: { id: 71, name: 'AEK Athens' }, score: {} },
      { id: 556, status: 'TIMED', utcDate: iso(NOW - 28 * H), homeTeam: { id: 72, name: 'Morton' }, awayTeam: { id: 73, name: 'Ayr' }, score: {} }
    ];
  },
  twinOf: id => (id === 556 ? AF + 900 : null)
};
const result = id => db.prepare(`SELECT outcome, home_goals, away_goals, reason FROM results WHERE match_id = ?`).get(id);
const pred = id => db.prepare(`SELECT settled, locked, utc_date FROM predictions WHERE match_id = ?`).get(id);
const review = id => db.prepare(`SELECT * FROM settle_review WHERE match_id = ?`).get(id);

test('first run: by the two teams, postponed, not found → Needs you, moved, looked again, the twin', async () => {
  const r = await u.resolveUnsettled(providers, { now: NOW });
  assert.equal(r.checked, 6, 'F (20 h) is not looked at');
  assert.deepEqual([r.settled, r.voided, r.review, r.moved, r.retry], [2, 1, 1, 1, 1]);
  // A settled with the real game's score
  assert.equal(result(AF + 1).outcome, 'H');
  assert.equal(result(AF + 1).home_goals, 2);
  assert.equal(pred(AF + 1).settled, 1);
  // B void, with the reason, never counted
  assert.equal(result(AF + 2).outcome, 'VOID');
  assert.match(result(AF + 2).reason, /postponed/);
  // C: no result, in Needs you (not voided)
  assert.equal(result(AF + 3), undefined);
  assert.ok(review(AF + 3) && !review(AF + 3).resolved_at);
  // D moved to the new date, unlocked, not settled
  assert.equal(pred(555).utc_date, iso(NOW + 6 * DAY));
  assert.equal(pred(555).locked, 0);
  assert.equal(result(555), undefined);
  // E looked again (30 h), not in Needs you yet
  assert.equal(pred(AF + 5).settled, 0);
  assert.equal(review(AF + 5), undefined);
  assert.match(db.prepare(`SELECT note FROM settle_lookups WHERE match_id = ?`).get(AF + 5).note, /still NS/);
  // F untouched
  assert.equal(pred(AF + 6).settled, 0);
  // G settled from the API-Football twin's final (Football-Data still had it TIMED)
  assert.equal(result(556).outcome, 'A');
  assert.equal(result(556).away_goals, 3);
});

test('Needs you: listed once; a later run keeps it; E reaches it at 48 h', async () => {
  const list = u.openSettleReviews();
  assert.deepEqual(list.map(x => x.id), [AF + 3]);
  assert.equal(list[0].home, 'Abha');
  await u.resolveUnsettled(providers, { now: NOW + 20 * H });
  assert.ok(!review(AF + 3).resolved_at);
  assert.ok(review(AF + 5) && !review(AF + 5).resolved_at, 'E is 50 h old now');
  assert.equal(u.openSettleReviews().length, 2);
});

test('Enter result / Void (Admin → Needs you, the email button)', () => {
  const m = u.decideSettle(AF + 3, 'result', { home: 1, away: 1 }, 'admin@test');
  assert.match(m.message, /1–1/);
  assert.equal(result(AF + 3).outcome, 'D');
  assert.match(result(AF + 3).reason, /entered by an admin/);
  assert.equal(pred(AF + 3).settled, 1);
  assert.equal(review(AF + 3).resolution, 'result 1-1');
  assert.throws(() => u.decideSettle(AF + 5, 'result', { home: -1, away: 2 }, 'admin@test'), /0–30/);
  u.decideSettle(AF + 5, 'void', null, 'admin@test');
  assert.equal(result(AF + 5).outcome, 'VOID');
  assert.equal(review(AF + 5).resolution, 'void');
  assert.match(u.decideSettle(AF + 5, 'void', null, 'admin@test').message, /Already settled/);
  assert.equal(u.openSettleReviews().length, 0);
});

test('a final that shows up later settles the game and closes its Needs-you item', async () => {
  add(AF + 7, iso(NOW - 3 * DAY), 'Al-Okhdood', 'Al-Wehda', AF + 22, AF + 23);
  await u.resolveUnsettled(providers, { now: NOW + DAY });
  assert.ok(review(AF + 7) && !review(AF + 7).resolved_at);
  const later = { ...providers, afByIds: async ids => (ids.includes(7) ? [fx(7, iso(NOW - 3 * DAY), 'FT', 22, 23, 0, 1)] : providers.afByIds(ids)) };
  await u.resolveUnsettled(later, { now: NOW + DAY + 2 * H });
  assert.equal(result(AF + 7).outcome, 'A');
  assert.match(review(AF + 7).resolution, /settled automatically/);
});

test('admin list and the data-health note; voids are out of the accuracy rows', () => {
  const v = u.voidedGames(3650);
  assert.deepEqual(v.map(x => x.id).sort(), [AF + 2, AF + 5].sort());
  assert.ok(v.every(x => x.reason));
  assert.equal(u.voidedThisMonth(NOW + 3 * DAY), 2);
  // every accuracy query reads outcome IN ('H','D','A') only
  const counted = db.prepare(`SELECT COUNT(*) AS n FROM predictions p JOIN results r ON r.match_id = p.match_id WHERE p.settled = 1 AND r.outcome IN ('H','D','A')`).get().n;
  assert.equal(counted, 4);
});

test('a provider outage is not an attempt', async () => {
  add(AF + 9, iso(NOW - 3 * DAY), 'Al-Fateh', 'Al-Taawoun', AF + 20, AF + 21);
  const down = { ...providers, afByIds: async () => { throw new Error('HTTP 500'); } };
  const r = await u.resolveUnsettled(down, { now: NOW + 3 * DAY });
  assert.equal(r.checked, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM settle_lookups WHERE match_id = ?`).get(AF + 9).n, 0);
});

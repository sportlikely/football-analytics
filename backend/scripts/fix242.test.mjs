// fix242: the upset watch — favourite / underdog named from the win %, never from home / away (26 Oct 2026: "Norwich is
// the favourite, but our model gives Watford about a 1 in 5 chance" with Watford 58%), favourite 50%+ / underdog 25%+
// with a reason on every game, at most 10 shown per week, the record of the last 30 days, the list grouped by day in the
// visitor's time zone (frontend/src/lib/upsetDays.ts). (dist build) Run: npm run test:fix242
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix242-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { db } = require('../dist/db/index.js');
const U = require('../dist/utils/upsetWatch.js');
const { upsetWatchReport } = require('../dist/services/upsetAlerts.js');
const { groupByDay, dayKey } = await import(pathToFileURL(path.join(here, '../../frontend/src/lib/upsetDays.ts')).href);
try { db.exec('ALTER TABLE predictions ADD COLUMN payload TEXT'); } catch { /* already there */ }

const NOW = Date.parse('2026-10-26T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
/** grid rows: the away side misses two starters (#12 favours home by 9), form 4 vs 9 pts */
const rowsAwayMissing = [
  { id: '#1e', edge: -10, home: 4, away: 7 },
  { id: '#12', edge: 9, home: 4, away: 2.8, note: 'usual starters out: none | J. Rowe, E. Kayembe' },
  { id: '#21', edge: 0, note: 'last 6: 4 vs 9 pts' }
];
const rowsNoReason = [{ id: '#1e', edge: -10, home: 4, away: 7 }, { id: '#21', edge: 0, note: 'last 6: 5 vs 9 pts' }];
let nextId = 1;
function pred({ home, away, ph, pd, pa, at, code = 'ELC', rows = rowsAwayMissing, result = null }) {
  const id = nextId++;
  db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at, payload)
    VALUES (?, 'grid-v3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(id, code, code === 'PL' ? 'Premier League' : 'Championship', at, 1000 + id, home, 2000 + id, away, ph, pd, pa, result ? 1 : 0, iso(NOW), iso(NOW), JSON.stringify({ grid: { rows } }));
  if (result) db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', ?, ?, ?, ?)`).run(id, result[0], result[1], result[0] > result[1] ? 'H' : result[0] < result[1] ? 'A' : 'D', iso(NOW));
  return id;
}

/* ---------- the swap bug ---------- */

test('fix242: away favourite — Norwich 20% v Watford 58%: Watford is the favourite, Norwich the underdog', () => {
  const s = U.sidesOf('Norwich', 'Watford', 20, 58);
  assert.equal(s.favourite.name, 'Watford'); assert.equal(s.favourite.side, 'A'); assert.equal(s.favourite.p, 58);
  assert.equal(s.underdog.name, 'Norwich'); assert.equal(s.underdog.side, 'H'); assert.equal(s.underdog.p, 20);
  // and the home favourite the other way round
  const h = U.sidesOf('Watford', 'Norwich', 58, 20);
  assert.equal(h.favourite.name, 'Watford'); assert.equal(h.underdog.name, 'Norwich');
});

test('fix242: the report names the away favourite from its %, with a reason that names its missing player', () => {
  const id = pred({ home: 'Plymouth', away: 'Reading', ph: 26, pd: 22, pa: 52, at: iso(NOW + 2 * 86400000) });
  const x = upsetWatchReport(NOW).upcoming.find(w => w.matchId === id);
  assert.ok(x, 'on the watch');
  assert.equal(x.favourite.name, 'Reading'); assert.equal(x.favourite.p, 52);
  assert.equal(x.underdog.name, 'Plymouth'); assert.equal(x.underdog.p, 26);
  assert.equal(x.reason.key, 'keyOut'); assert.equal(x.reason.player, 'J. Rowe');
  assert.ok(U.textMatchesNumbers(x));
  // the data-health check catches the 26 Oct text
  assert.equal(U.textMatchesNumbers({ ...x, favourite: x.underdog, underdog: x.favourite }), false);
});

/* ---------- what counts ---------- */

test('fix242: below the cut or without a reason → not on the watch', () => {
  const low = pred({ home: 'Rodez', away: 'Dunkerque', ph: 22, pd: 24, pa: 54, at: iso(NOW + 86400000) }); // underdog 22% < 25%
  const flip = pred({ home: 'Yokohama', away: 'Kawasaki', ph: 40, pd: 25, pa: 35, at: iso(NOW + 86400000) }); // favourite 40% < 50%
  const none = pred({ home: 'Cracovia', away: 'Motor Lublin', ph: 28, pd: 20, pa: 52, at: iso(NOW + 86400000), rows: rowsNoReason }); // no reason
  const ids = new Set(upsetWatchReport(NOW).upcoming.map(w => w.matchId));
  for (const id of [low, flip, none]) assert.ok(!ids.has(id), `game ${id} should not be listed`);
  assert.equal(U.passesCut(50, 25), true); assert.equal(U.passesCut(49.9, 30), false); assert.equal(U.passesCut(60, 24.9), false);
});

test('fix242: at most 10 shown per week, top competitions first, a reason on every game, the rest counted', () => {
  for (let i = 0; i < 14; i++) pred({ home: `Home ${i}`, away: `Away ${i}`, ph: 25 + i * 0.5, pd: 20, pa: 55 - i * 0.5, at: iso(NOW + (1 + (i % 6)) * 86400000 + i * 3600000), code: i < 3 ? 'PL' : 'ELC' });
  const r = upsetWatchReport(NOW);
  const top = r.upcoming.filter(w => w.top);
  assert.equal(top.length, 10);
  assert.ok(r.total > 10 && r.total === r.upcoming.length);
  assert.deepEqual(r.upcoming.slice(0, 3).map(w => w.league), ['Premier League', 'Premier League', 'Premier League']);
  for (const w of r.upcoming) { assert.ok(w.reason && w.reason.key, 'reason'); assert.ok(w.favourite.p >= 50 && w.underdog.p >= 25); assert.ok(U.textMatchesNumbers(w)); }
});

test('fix242: record of the last 30 days — flagged, how often the underdog won, what we said', () => {
  pred({ home: 'Atletico San Luis', away: 'Atlas', ph: 30, pd: 20, pa: 50, at: iso(NOW - 3 * 86400000), result: [2, 1] }); // upset
  pred({ home: 'Norwich', away: 'Watford', ph: 20, pd: 22, pa: 58, at: iso(NOW - 4 * 86400000), result: [0, 2] }); // underdog 20%: not flagged
  pred({ home: 'A FC', away: 'B FC', ph: 28, pd: 22, pa: 50, at: iso(NOW - 5 * 86400000), result: [0, 1] }); // favourite won
  pred({ home: 'Old FC', away: 'Older FC', ph: 30, pd: 20, pa: 50, at: iso(NOW - 40 * 86400000), result: [3, 0] }); // too old
  const rec = upsetWatchReport(NOW).record;
  assert.equal(rec.n, 2); assert.equal(rec.upsets, 1); assert.equal(rec.upsetRate, 50); assert.equal(rec.said, 29);
  assert.deepEqual(rec.recent.map(x => x.result), ['upset', 'favourite']);
  assert.equal(rec.recent[0].favourite.name, 'Atlas');
});

/* ---------- winner sports: reasons from past games ---------- */

test('fix242: winner sports — a tired away favourite with a poor away record gets a reason', () => {
  const ko = '2026-10-27T00:00:00Z', d = n => new Date(Date.parse(ko) - n * 86400000).toISOString();
  const favGames = [{ date: d(0.9), home: false, won: false, opp: 9 }, ...[2, 4, 6, 8, 10, 12].map((n, i) => ({ date: d(n), home: i % 2 === 0, won: i % 3 === 0, opp: 9 }))];
  const dogGames = [3, 5, 7, 9, 11, 13].map(n => ({ date: d(n), home: true, won: true, opp: 8 }));
  const s = U.historySignals({ kickoff: ko, fav: 'A', games: { H: dogGames, A: favGames }, ids: { H: 1, A: 2 } });
  const keys = s.map(x => x.key);
  assert.ok(keys.includes('rest') && keys.includes('form'), keys.join(','));
  assert.ok(s.every(x => x.helps === 'H'));
  assert.ok(U.pickReason(s, 'H'));
  assert.equal(U.pickReason(s, 'A'), null); // nothing helps the favourite's side as an upset reason
});

/* ---------- grouped by day in the visitor's time zone ---------- */

test('fix242: grouping by day follows the time zone', () => {
  const items = [{ date: '2026-10-31T01:00:00Z', n: 1 }, { date: '2026-10-30T20:00:00Z', n: 2 }, { date: '2026-10-31T15:00:00Z', n: 3 }];
  assert.equal(dayKey('2026-10-31T01:00:00Z', 'America/New_York'), '2026-10-30');
  assert.deepEqual(groupByDay(items, 'America/New_York').map(g => [g.day, g.items.map(x => x.n)]), [['2026-10-30', [2, 1]], ['2026-10-31', [3]]]);
  assert.deepEqual(groupByDay(items, 'Asia/Jerusalem').map(g => [g.day, g.items.map(x => x.n)]), [['2026-10-30', [2]], ['2026-10-31', [1, 3]]]);
});

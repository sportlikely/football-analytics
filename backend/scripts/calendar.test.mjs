// fix205: calendar subscription (.ics) on a scratch database (dist build): RFC 5545 shape (CRLF, folding at 75 octets,
// escaping), locking (free / premium / unlocked / pro), cancelled and finished games, UTC times, words per language,
// SEQUENCE when the kick-off moves, an empty calendar, and reset revoking the old link. Run: npm run test:fix205
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix205-cal-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.BASKETBALL_PUBLIC = '1';
process.env.ADMIN_EMAILS = 'boss@example.com';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const auth = require('../dist/services/auth.js');
require('../dist/services/billing.js');
require('../dist/services/basketball.js');
require('../dist/services/bbModel.js');
const { addFavorites } = require('../dist/services/favorites.js');
const cal = require('../dist/services/calendar.js');

const DAY = 86400000, H = 3600000;
const SITE = 'https://sportlikely.com';
const now = Date.now();
const iso = t => new Date(t).toISOString();
const kick = Math.floor((now + DAY) / H) * H; // tomorrow, on the hour

let uid = 0;
const user = (plan, email) => {
  const id = Number(db.prepare(`INSERT INTO users (email, pass_hash, plan, created_at, email_verified) VALUES (?, 'x', ?, ?, 1)`).run(email || `u${++uid}@example.com`, plan, iso(now)).lastInsertRowid);
  return id;
};
const fb = (id, t, home, away, p, result, ids = [57, 62], comp = ['PL', 'Premier League']) => {
  db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, locked, settled, created_at, updated_at)
    VALUES (?, 'grid-v3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(id, comp[0], comp[1], iso(t), ids[0], home, ids[1], away, p[0], p[1], p[2], iso(now), iso(now));
  if (result) db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, result.status, result.h ?? null, result.a ?? null, result.o, iso(now));
};
fb(101, kick, 'Arsenal', 'Everton', [61, 22, 17]);
fb(102, now - 2 * DAY, 'Arsenal', 'Everton, Reserves; B', [50, 30, 20], { status: 'FINISHED', h: 2, a: 1, o: 'H' });
fb(103, now + 3 * DAY, 'Chelsea', 'Arsenal', [40, 30, 30], { status: 'VOID', o: 'VOID' });
fb(104, now + 40 * DAY, 'Arsenal', 'Spurs', [50, 25, 25]); // outside the 30 days
db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (900, 'NBA', 12, '2026-2027', ?, 'NS', 145, 'Los Angeles Lakers', 133, 'Boston Celtics', ?)`).run(iso(kick + 2 * H), iso(now));
db.prepare(`INSERT INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at) VALUES (900, 'NBA', ?, 'bb-v3', 0.64, 4, 220, 112, 108, ?)`).run(iso(kick + 2 * H), iso(now));

const FAVS = [
  { kind: 'team', ref: 'arsenal', name: 'Arsenal', ids: [57] },
  { kind: 'bb-team', ref: '145', name: 'Los Angeles Lakers', ids: [145] }
];
const free = user('free'), premium = user('premium'), pro = user('pro'), empty = user('free'), boss = user('free', 'boss@example.com');
for (const u of [free, premium, pro, boss]) addFavorites(u, FAVS);
db.prepare(`INSERT INTO match_unlocks (user_id, match_id, at) VALUES (?, 101, ?)`).run(free, iso(now));
const ics = (id, lang = 'en') => cal.calendarFor(auth.userById(id), lang, SITE, now);
const unfold = s => s.replace(/\r\n /g, '');
const events = s => unfold(s).split('BEGIN:VEVENT').slice(1).map(e => e.split('END:VEVENT')[0]);
const ev = (s, n) => events(s).find(e => e.includes(`UID:sl-${n}@sportlikely.com`));

test('RFC 5545: CRLF line ends, 75-octet folding, escaping', () => {
  const s = ics(pro);
  assert.ok(s.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(s.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(s), 'no bare LF');
  for (const line of s.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line over 75 octets: ${line}`);
  assert.ok(s.includes('REFRESH-INTERVAL;VALUE=DURATION:PT6H') && s.includes('X-PUBLISHED-TTL:PT6H'));
  assert.match(unfold(s), /SUMMARY:Arsenal – Everton\\, Reserves\\; B · Premier League/);
  assert.equal(cal.icsEscape('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  // folding never cuts a UTF-8 character and unfolds back to the same text
  const long = `DESCRIPTION:${'é–·'.repeat(60)}`;
  const f = cal.foldLine(long);
  for (const l of f.split('\r\n')) assert.ok(Buffer.byteLength(l, 'utf8') <= 75);
  assert.equal(f.replace(/\r\n /g, ''), long);
  assert.equal(events(s).length, 4, 'three football games in the window + one basketball game');
});

test('UTC times and durations; UID stable per game', () => {
  const e = ev(ics(pro), 'fb-101');
  const z = new Date(kick).toISOString().replace(/[-:]/g, '').replace('.000', '');
  assert.ok(e.includes(`DTSTART:${z}`));
  assert.ok(e.includes(`DTEND:${new Date(kick + 2 * H).toISOString().replace(/[-:]/g, '').replace('.000', '')}`));
  const b = ev(ics(pro), 'bb-900');
  assert.ok(b.includes(`DTEND:${new Date(kick + 4.5 * H).toISOString().replace(/[-:]/g, '').replace('.000', '')}`), 'basketball 2.5 h');
  assert.ok(e.includes('URL:https://sportlikely.com/match/101'));
});

test('locking follows the site: free sees links, unlocked and Pro see the numbers', () => {
  const pr = ev(ics(pro), 'fb-101');
  assert.match(pr, /SL Football 3\.0: Arsenal 61% · draw 22% · Everton 17%/);
  assert.match(pr, /Our pick: Arsenal or draw · 83%/);
  // Premium: football only what they unlocked (like the site), basketball in full
  const pm = ics(premium);
  assert.match(ev(pm, 'fb-101'), /See our prediction: https:\/\/sportlikely\.com\/match\/101/);
  assert.doesNotMatch(ev(pm, 'fb-101'), /61%/);
  assert.match(ev(pm, 'bb-900'), /SL Basketball 3\.0: Los Angeles Lakers 64% · Boston Celtics 36%/);
  // Free with this game unlocked: the numbers; the basketball game (not unlocked): the link
  const fr = ics(free);
  assert.match(ev(fr, 'fb-101'), /Arsenal 61%/);
  assert.match(ev(fr, 'bb-900'), /See our prediction: https:\/\/sportlikely\.com\/basketball\/game\/900/);
  assert.doesNotMatch(fr, /odds|bet|wager/i);
});

test('finished game: score and our pick ✓ / ✗; cancelled game: STATUS:CANCELLED', () => {
  const s = ics(free);
  const done = ev(s, 'fb-102');
  assert.match(done, /Final score: Arsenal 2–1 Everton\\, Reserves\\; B/);
  assert.match(done, /SL Football 3\.0: Arsenal 50% · draw 30% · Everton\\, Reserves\\; B 20%/, 'free user: the whole pick once the game is over');
  assert.match(done, /Our pick: Arsenal or draw · 80% ✓/);
  const off = ev(s, 'fb-103');
  assert.ok(off.includes('STATUS:CANCELLED'));
  assert.match(off, /Postponed or cancelled/);
  assert.ok(ev(s, 'fb-101').includes('STATUS:CONFIRMED'));
  assert.ok(!ev(s, 'fb-104'), 'games beyond 30 days are left out');
});

test('words follow the language, links carry its prefix', () => {
  const de = ics(pro, 'de');
  assert.match(unfold(de), /Unentschieden 22%/);
  assert.ok(unfold(de).includes('URL:https://sportlikely.com/de/match/101'));
  assert.ok(unfold(de).includes('X-WR-CALNAME:SportLikely · meine Spiele'));
});

test('SEQUENCE and LAST-MODIFIED move when the kick-off changes', () => {
  const before = ev(ics(pro), 'fb-101');
  assert.match(before, /SEQUENCE:0/);
  db.prepare(`UPDATE predictions SET utc_date = ? WHERE match_id = 101`).run(iso(kick + H));
  const after = ev(cal.calendarFor(auth.userById(pro), 'en', SITE, now + 60000), 'fb-101');
  assert.match(after, /SEQUENCE:1/);
  assert.notEqual(before.match(/LAST-MODIFIED:\S+/)[0], after.match(/LAST-MODIFIED:\S+/)[0]);
});

test('no favorites: a valid calendar with one all-day event', () => {
  const s = ics(empty);
  const es = events(s);
  assert.equal(es.length, 1);
  assert.match(es[0], /DTSTART;VALUE=DATE:\d{8}\r\n/);
  assert.match(unfold(s), /Add favourite teams on SportLikely to see their games here/);
});

test('token: hashed in the database, served by link, reset revokes the old link', () => {
  const a = cal.calendarToken(pro, 'en');
  assert.equal(a.created, true);
  assert.match(a.token, /^[A-Za-z0-9_-]{32}$/);
  const row = db.prepare(`SELECT * FROM calendar_tokens WHERE user_id = ?`).get(pro);
  assert.notEqual(row.token_hash, a.token);
  assert.ok(!JSON.stringify(row).includes(a.token), 'the plain token is never stored');
  assert.equal(cal.calendarToken(pro).token, a.token, 'the same link the next time');
  assert.equal(cal.calendarToken(pro).created, false);
  assert.ok(cal.calendarIcs(a.token, SITE)?.includes('BEGIN:VCALENDAR'));
  const b = cal.resetCalendarToken(pro);
  assert.notEqual(b, a.token);
  assert.equal(cal.calendarIcs(a.token, SITE), null, 'old link refused (cache dropped too)');
  assert.ok(cal.calendarIcs(b, SITE)?.includes('BEGIN:VCALENDAR'));
  assert.equal(cal.calendarIcs('not-a-token', SITE), null);
  assert.equal(cal.tokenHint(b), `${b.slice(0, 6)}…`);
  cal.deleteCalendarFor(pro);
  assert.equal(cal.calendarIcs(b, SITE), null, 'gone with the account');
});

test('fix205b: admins see the full pick before the start, like Pro', () => {
  const s = ics(boss);
  assert.match(ev(s, 'fb-101'), /SL Football 3\.0: Arsenal 61%/);
  assert.match(ev(s, 'bb-900'), /Los Angeles Lakers 64%/);
});

test("fix205b: two clubs with one name — only the favourite's ids count (FC Barcelona, not Barcelona SC)", () => {
  // the team page's link tables: Football-Data.org id 81 = API-Football 529 in the Spanish group
  db.exec(`CREATE TABLE IF NOT EXISTS team_map (grp TEXT NOT NULL, team_id INTEGER NOT NULL, fd_name TEXT NOT NULL, api_name TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (grp, team_id));
    CREATE TABLE IF NOT EXISTS af_teams (grp TEXT NOT NULL, team_id INTEGER NOT NULL, name TEXT NOT NULL, fd_name TEXT, score REAL, PRIMARY KEY (grp, team_id))`);
  db.prepare(`INSERT OR REPLACE INTO team_map (grp, team_id, fd_name, api_name, score) VALUES ('SP', 81, 'Barcelona', 'FC Barcelona', 1)`).run();
  db.prepare(`INSERT OR REPLACE INTO af_teams (grp, team_id, name, fd_name, score) VALUES ('SP', 529, 'Barcelona', 'Barcelona', 1)`).run();
  fb(201, now + 2 * DAY, 'FC Barcelona', 'Sevilla FC', [60, 25, 15], null, [81, 559], ['PD', 'Primera Division']); // Football-Data.org ids
  fb(202, now + 4 * DAY, 'Girona', 'Barcelona', [30, 25, 45], null, [1000000547, 1000000529], ['AF140', 'La Liga']); // API-Football ids
  fb(203, now + 2 * DAY, 'Barcelona', 'Emelec', [55, 25, 20], null, [1000001157, 1000001150], ['AF242', 'Liga Pro']); // Barcelona SC, Ecuador
  const fan = user('pro');
  addFavorites(fan, [{ kind: 'team', ref: 'barcelona', name: 'Barcelona', ids: [1000000529] }]);
  const s = ics(fan);
  assert.ok(ev(s, 'fb-201'), 'FC Barcelona (Football-Data.org ids) listed');
  assert.ok(ev(s, 'fb-202'), 'FC Barcelona (API-Football ids) listed');
  assert.ok(!ev(s, 'fb-203'), 'Barcelona SC (same name, Ecuador) not listed');
  assert.equal(events(s).length, 2);
  assert.ok(!cal.footballTeamIds([1000000529]).has(1000001157));
});

test('fix205b: a favourite saved without ids is never matched by name', () => {
  const fan = user('pro');
  addFavorites(fan, [{ kind: 'team', ref: 'arsenal', name: 'Arsenal', ids: [] }]);
  const s = ics(fan);
  assert.ok(s.startsWith('BEGIN:VCALENDAR'));
  const stored = JSON.parse(db.prepare(`SELECT data FROM user_favorites WHERE user_id = ?`).get(fan).data);
  // no team index on this scratch database: the lookup finds nothing, so the favourite is skipped, not matched by name
  assert.deepEqual(stored.ids, []);
  for (const n of ['fb-101', 'fb-102', 'fb-103']) assert.ok(!ev(s, n), `${n} not listed by name`);
});

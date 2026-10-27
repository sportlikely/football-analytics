// fix224: key players — the card on a fixture game (top 5, statuses, reasons), the star-rest reduction maths (NBA
// back-to-backs, EuroLeague double weeks, injuries are not rest), the news parser on 22 sentences (negatives too),
// news → "reported out" → row #4 and back after a dismiss. (dist build) Run: npm run test:fix224
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix224-kp-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const K = require('../dist/utils/keyPlayers.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
const G = require('../dist/services/bbGrid.js');
const S = require('../dist/services/keyPlayers.js');

const DAY = 86400000;

/* ---------- the news parser ---------- */

const SENTENCES = [
  ['Nikola Mirotic is out for three weeks with a calf injury.', { status: 'out', days: 21, injury: 'calf' }],
  ['Real Madrid: Edy Tavares will miss 4-6 weeks after knee surgery', { status: 'out', days: 42, injury: 'knee' }],
  ['Facundo Campazzo sidelined with an ankle sprain, out two to three weeks', { status: 'out', days: 21, injury: 'ankle' }],
  ['Vezenkov ruled out for the rest of the season with a torn ACL', { status: 'out', days: 150, injury: null, season: true }], // fix253: until = the season's end
  ["Shane Larkin is doubtful for Friday's game with a hamstring strain", { status: 'doubtful', days: 3, injury: 'hamstring', unclear: true }],
  ['Mike James to miss 10 days with a back injury', { status: 'out', days: 10, injury: 'back' }],
  ['Wade Baldwin out indefinitely after a shoulder injury', { status: 'out', days: 60, injury: 'shoulder' }],
  ['Kevin Punter will miss the next two games with a groin problem', { status: 'out', days: 7, injury: 'groin' }],
  ["Partizan's Jabari Parker had surgery on his foot and will be out for a month", { status: 'out', days: 30, injury: 'foot' }],
  ['Sasha Vezenkov is questionable with an illness', { status: 'doubtful', days: 3, injury: 'illness', unclear: true }],
  ['Nick Calathes suffered a fractured finger and is sidelined for several weeks', { status: 'out', days: 28, injury: 'finger' }],
  ['Injured Hezonja misses the Clasico', { status: 'out', days: 7, injury: null }],
  ['Olympiacos reveal details on Lessort surgery amid Panathinaikos dispute', null], // surgery alone, no time out
  // negatives: back, fine, something else, no injury
  ['Tavares returns from injury and leads Real Madrid to a win', null],
  ['Campazzo is back in training after his ankle sprain', null],
  ['Mirotic was cleared to play on Friday after a knee scare', null],
  ['Barcelona sign a forward to replace injured Laprovittola', null],
  ["Larkin scored 25 points in Efes' win", null],
  ['Rumours of a knee injury to Micic are false, the club says', null],
  ['Punter will play despite ankle soreness and a sprained finger', null],
  ['The coach said nobody is out for Sunday', null],
  ['Monaco miss the playoffs after a loss in Paris', null]
];

test('news parser: 22 sentences (12 injuries with status / length / body part, 10 negatives)', () => {
  for (const [s, want] of SENTENCES) assert.deepEqual(K.parseInjury(s), want, s);
});

test('news names: full name in any order, or a unique surname when the story names the club', () => {
  const roster = [{ id: 1, name: 'Tavares Walter' }, { id: 2, name: 'Musa Dzanan' }, { id: 3, name: 'Hezonja Mario' }, { id: 4, name: 'Garuba Usman' }];
  assert.deepEqual(K.namedPlayers("Real Madrid's Walter Tavares out for 3 weeks", roster, false), [1]);
  assert.deepEqual(K.namedPlayers('Tavares out for 3 weeks', roster, false), []); // surname only: the club must be named
  assert.deepEqual(K.namedPlayers('Tavares out for 3 weeks', roster, true, ['Real Madrid']), [1]);
  assert.deepEqual(K.namedPlayers('Madrid out for 3 weeks', [{ id: 9, name: 'Madrid Jose' }], true, ['Real Madrid']), []); // a club word is never a surname
  const hits = K.scanStory('Real Madrid blow: Tavares and Hezonja injured', 'Walter Tavares will miss three weeks with a knee injury. Mario Hezonja is doubtful with an ankle sprain. Musa scored 20.', roster, ['Real Madrid']);
  assert.deepEqual(hits.map(h => [h.playerId, h.inj.status, h.inj.days]).sort(), [[1, 'out', 21], [3, 'doubtful', 3]]);
});

/* ---------- star rest maths ---------- */

/** a team's games from day offsets and minutes per player ({ id: minutes } per game) */
const games = (rows, code = 'NBA', t0 = Date.parse('2025-11-01T00:00:00Z')) => rows.map(([d, min, c], i) => ({ id: i + 1, ms: t0 + d * DAY, code: c || code, min: new Map(Object.entries(min).map(([k, v]) => [Number(k), v])) }));

test('NBA back-to-backs: rested nights count, an injury (sat the next game too) does not, 3-in-4 apart', () => {
  // every 2 days, plus 5 back-to-backs (second night = d+1). Star 1 sits 3 of the 5 second nights, plays the game after.
  // Player 2 sits one second night and the game after (an injury): not a chance.
  const rows = [];
  let d = 0, b2b = 0;
  for (let i = 0; i < 30; i++) {
    rows.push([d, { 1: 34, 2: 30, 3: 25 }]);
    if (i % 5 === 4 && b2b < 5) {
      b2b++;
      const sit1 = b2b <= 3, sit2 = b2b === 4;
      rows.push([d + 1, { ...(sit1 ? {} : { 1: 33 }), ...(sit2 ? {} : { 2: 29 }), 3: 24 }]);
      if (sit2) { rows.push([d + 3, { 1: 34, 3: 25 }]); d += 2; } // player 2 misses the next game too
      d += 1;
    }
    d += 2;
  }
  const c = K.nbaRestCounts(games(rows));
  assert.deepEqual(c.get(1).b2b, { sat: 3, chances: 5 });
  assert.equal(c.get(2).b2b.chances, 4); // the injury night is left out
  assert.equal(c.get(2).b2b.sat, 0);
  assert.equal(K.restKeep('b2b', c.get(1).b2b), 0.63); // minutes × (1 − 3/(5 + 3))
  assert.equal(K.restKeep('b2b', c.get(2).b2b), 1);
  assert.equal(K.restKeep('b2b', { sat: 2, chances: 3 }), 1); // too few chances
  assert.equal(K.restKeep('b2b', { sat: 1, chances: 10 }), 1); // rare (1/13 is under 15%)
  assert.equal(K.nbaSpot(Date.parse('2025-11-03T00:00:00Z'), [Date.parse('2025-11-02T01:00:00Z')]), 'b2b');
  assert.equal(K.nbaSpot(Date.parse('2025-11-04T00:00:00Z'), [Date.parse('2025-11-02T00:00:00Z'), Date.parse('2025-11-01T00:00:00Z')]), '3in4');
  assert.equal(K.nbaSpot(Date.parse('2025-11-05T00:00:00Z'), [Date.parse('2025-11-03T00:00:00Z'), Date.parse('2025-11-01T00:00:00Z')]), null);
});

test('EuroLeague double weeks: domestic games in a week with two EuroLeague games', () => {
  // Mondays from 2025-11-03: double weeks (Tue + Thu EL, Sun league) and single weeks (Thu EL, Sun league)
  const rows = [];
  const sits = [true, false, true, false];
  for (let w = 0; w < 8; w++) {
    const b = w * 7, double = w % 2 === 0;
    if (double) rows.push([b + 1, { 7: 28, 8: 22 }, 'EL']);
    rows.push([b + 3, { 7: 30, 8: 20 }, 'EL']);
    const sat = double && sits[w / 2];
    rows.push([b + 6, { ...(sat ? {} : { 7: 27 }), 8: 25 }, 'ACB']);
  }
  const c = K.elRestCounts(games(rows, 'ACB', Date.parse('2025-11-03T18:00:00Z')));
  assert.deepEqual(c.get(7)['el-double'], { sat: 2, chances: 4 });
  assert.equal(K.restKeep('el-double', c.get(7)['el-double']), 0.71); // 1 − 2/(4 + 3)
  assert.equal(K.restKeep('b2b', { sat: 4, chances: 4 }), 0.43); // never certain to sit
  assert.deepEqual(c.get(8)['el-double'], { sat: 0, chances: 4 });
});

test('key list: top 5 by impact × minutes, "without him" re-fills the rotation, cost only for a missing player', () => {
  const pl = [[1, 8, 34], [2, 3, 30], [3, 1, 28], [4, 0, 26], [5, -1, 24], [6, -1, 20], [7, -2, 18], [8, -2, 10], [9, -3, 6]].map(([id, rating, proj]) => ({ id, rating, proj }));
  const out = K.keyList(pl, new Map([[1, 0]]), 40, 1.5);
  assert.deepEqual(out.map(p => p.id), [1, 2, 3, 4, 9]); // −3 × 6 min ranks above −1 × 20
  assert.equal(out[0].perGame, Math.round((8 * 34 / 40) * 10) / 10);
  assert.ok(out[0].without < out[1].without && out[0].without < -3, `star without ${out[0].without}`);
  assert.equal(out[0].cost, out[0].without); // he is the only one missing: his cost = the team without him
  assert.equal(out[1].cost, 0);
  // row #4 (missOf) is the same loss in strength points: his 200-minute share goes to the (worse) bench, so it is more than his own
  const miss = K.missOf(pl, new Map([[1, 0]]), 40);
  assert.equal(Math.round(miss * 1.5 * 10) / 10, out[0].without);
  assert.ok(miss < -(8 * 34) / 40, `miss ${miss}`);
});

/* ---------- the card on a fixture game, news → row #4 ---------- */

const iso = ms => new Date(ms).toISOString();
const now = Date.now();
const day0 = Math.floor(now / DAY) * DAY;
// the game: next Saturday 18:00 UTC; EuroLeague Tuesday + Thursday of that week (week = Monday-based)
const sat = day0 + ((6 - new Date(day0).getUTCDay() + 7) % 7 || 7) * DAY + 18 * 3600 * 1000;
const monday = sat - 5 * DAY - 18 * 3600 * 1000;
const H = 101, A = 102;
const NAMES = { 11: 'Tavares Walter', 12: 'Campazzo Facundo', 13: 'Hezonja Mario', 14: 'Musa Dzanan', 15: 'Garuba Usman', 16: 'Llull Sergio', 17: 'Deck Gabriel',
  21: 'Vesely Jan', 22: 'Punter Kevin', 23: 'Parra Joel', 24: 'Satoransky Tomas', 25: 'Laprovittola Nicolas', 26: 'Brizuela Dario' };
const pl = ids => ids.map(([id, r, m, since]) => [id, r, m, since]);
const team = (p) => ({ imp: 0, miss: 0, stay: 0, net: 0, ff: [0.5, 0.14, 0.27, 0.2, 0.38], ffAg: [0.5, 0.14, 0.27, 0.2, 0.38], form: 0, wins: 5, gp: 10, season: '2026-2027', pl: p });

test('fixture game: card for both teams, statuses, news "reported out" → reasons + row #4, dismiss → gone', async () => {
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, ?, 117, '2026-2027', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run(900, 'ACB', '8', iso(sat), 'NS', H, 'Real Madrid', A, 'Barcelona', null, null, iso(now));
  ins.run(901, 'EL', '9', iso(monday + DAY + 19 * 3600 * 1000), 'FT', H, 'Real Madrid', 103, 'Olympiacos', 80, 70, iso(now));
  ins.run(902, 'EL', '9', iso(monday + 3 * DAY + 19 * 3600 * 1000), 'NS', 104, 'Fenerbahce', H, 'Real Madrid', null, null, iso(now));
  // box-score names (and box-score history for both teams)
  ins.run(899, 'ACB', '7', iso(day0 - 7 * DAY), 'FT', A, 'Barcelona', H, 'Real Madrid', 75, 82, iso(now));
  db.prepare(`UPDATE bb_games SET stats = 1 WHERE game_id = 899`).run();
  const ps = db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, minutes) VALUES (899, ?, ?, ?, 20)`);
  for (const [id, name] of Object.entries(NAMES)) ps.run(Number(id) < 20 ? H : A, Number(id), name);
  // a EuroLeague double-week rest pattern for Llull (sits half of those league games)
  db.prepare(`INSERT INTO bb_rest_rates (player_id, team_id, kind, sat, chances, keep, at) VALUES (16, ${H}, 'el-double', 3, 6, 0.5, ?)`).run(iso(now));
  G.publishSnap({
    code: 'ACB', gameMin: 40, lg: [0.5, 0.14, 0.27, 0.2, 0.38], pace: 72, seasonLen: 34, h2h: new Map(), builtAt: iso(now),
    teams: new Map([
      [H, team(pl([[11, 6, 30, 0], [12, 3, 28, 0], [13, 2.5, 26, 1], [14, 1, 24, 0], [15, 0, 20, 0], [16, 2, 22, 0], [17, -1, 18, 3]]))],
      [A, team(pl([[21, 4, 30, 0], [22, 3.5, 28, 0], [23, 0.5, 24, 0], [24, 2, 26, 0], [25, 0, 22, 0], [26, -0.5, 20, 0]]))]
    ])
  });
  const g = { game_id: 900, code: 'ACB', kickoff: iso(sat), home_id: H, away_id: A, home_name: 'Real Madrid', away_name: 'Barcelona', season: '2026-2027', week: '8' };

  let k = S.keyPlayersFor(g, true);
  assert.equal(k.home.players.length, 5);
  assert.equal(k.away.players.length, 5);
  assert.deepEqual(k.home.players.map(p => p.id), [11, 12, 13, 16, 14]); // rating × minutes
  assert.equal(k.home.players[0].name, 'Tavares Walter');
  assert.equal(k.home.players[0].status, 'playing');
  assert.equal(k.home.players[2].status, 'rested'); // missed the last game only
  const llull = k.home.players.find(p => p.id === 16);
  assert.equal(llull.status, 'may-rest');
  assert.equal(llull.noteKind, 'el-double');
  assert.ok(k.home.players[0].without < -2, `team without Tavares ${k.home.players[0].without}`);
  assert.equal(k.reasons.length, 0); // Llull's half game costs under 1.5 points

  // row #4 with the rest pattern only
  const base = { p: 0.6, sig: 12, hca: 2, haH: 0, haA: 0, b2bH: false, b2bA: false };
  const rRest = G.liveRows(g, base);
  assert.ok(rRest.hv[3] < 0 && rRest.av[3] === 0, `row #4 with rest ${rRest.hv[3]}`);

  // the news story → "reported out"
  db.prepare(`INSERT INTO news_items (link, title, source, published, summary, leagues, seen_at, sport) VALUES (?, ?, ?, ?, ?, ',ACB,', ?, 'basketball')`)
    .run('https://example.test/tavares', 'Real Madrid blow before the Clasico', 'Eurohoops', // fix253: a trusted source (others = doubtful)
       iso(now - 3600 * 1000), 'Walter Tavares will miss three weeks with a knee injury, the club said. Musa scored 20 in the win.', iso(now - 3000 * 1000));
  const scan = await S.scanNewsInjuries();
  assert.equal(scan.found, 1);
  k = S.keyPlayersFor(g, true);
  const tav = k.home.players.find(p => p.id === 11);
  assert.equal(tav.status, 'reported-out');
  assert.equal(tav.note, 'knee');
  assert.equal(tav.link, 'https://example.test/tavares');
  assert.equal(k.reasons[0]?.id, 11);
  assert.ok(k.reasons[0].points <= -1.5);
  assert.equal(S.keyPlayersFor(g, false).reasons.length, 0); // reasons only with the full prediction
  const rNews = G.liveRows(g, base);
  assert.ok(rNews.hv[3] < rRest.hv[3] - 1, `row #4 with Tavares out ${rNews.hv[3]} vs ${rRest.hv[3]}`);

  // a second scan of the same story adds nothing; a dismissed item is never applied again
  assert.equal((await S.scanNewsInjuries()).found, 0);
  const item = S.newsInjuryList().find(x => x.playerId === 11);
  assert.ok(S.reviewNewsInjury(item.id, 'dismiss'));
  db.prepare(`DELETE FROM bb_kp_meta`).run(); // scan everything again
  assert.equal((await S.scanNewsInjuries()).found, 0);
  assert.equal(S.keyPlayersFor(g, true).home.players.find(p => p.id === 11).status, 'playing');
  assert.equal(G.liveRows(g, base).hv[3], rRest.hv[3]);

  // logged per game, data health lines
  assert.ok(S.logApplied(sat - DAY) >= 1); // games of the next 36 h from the day before
  const logged = db.prepare(`SELECT * FROM bb_rest_log WHERE game_id = 900`).all();
  assert.deepEqual(logged.map(r => [r.player_id, r.kind, r.keep]), [[16, 'el-double', 0.5]]);
  const checks = S.keyPlayersHealth();
  assert.deepEqual(checks.map(c => c.id), ['bb-key-players', 'bb-star-rest', 'bb-news-injuries']);
  assert.equal(checks[0].level, 'ok');
  assert.match(checks[0].detail, /All [1-9][0-9]* upcoming/);
});

test('NBA: the rest pattern applies on the second night until the injury report confirms', () => {
  const T = 201;
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, 'NBA', 12, '2026-2027', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const ko = day0 + 3 * DAY + 0.5 * 3600 * 1000;
  ins.run(950, iso(ko - DAY), 'NS', T, 'Denver Nuggets', 202, 'Utah Jazz', null, null, iso(now));
  ins.run(951, iso(ko), 'NS', 203, 'Phoenix Suns', T, 'Denver Nuggets', null, null, iso(now));
  db.prepare(`INSERT INTO bb_rest_rates (player_id, team_id, kind, sat, chances, keep, at) VALUES (31, ${T}, 'b2b', 3, 5, 0.4, ?)`).run(iso(now));
  S.reviewNewsInjury(-1, 'ok'); // reload the tables
  assert.deepEqual([...S.nbaRestKeep(951, T, iso(ko))], [[31, { keep: 0.4, kind: 'b2b' }]]);
  assert.equal(S.nbaRestKeep(950, T, iso(ko - DAY)).size, 0); // first night: no pattern
  assert.equal(S.restConfirmed(iso(ko)), false); // no injury report fetched in this test
});

// fix231: game-page extras — the trend generator says only true things (checked against the fixture games one by one),
// at most 4 a game, never under 6 games; indoors = no weather card (basketball, domed NFL stadium, indoor tennis) while an
// outdoor game gets the forecast at its start hour; referee shrinkage; difficulty colours. (dist build) Run: npm run test:fix231
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix231-ex-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const U = require('../dist/utils/gameExtras.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
require('../dist/services/bbModel.js');
require('../dist/services/nfl.js');
require('../dist/services/nflModel.js');
require('../dist/services/tennis.js');
require('../dist/services/tennisModel.js');
const S = require('../dist/services/gameExtras.js');

const DAY = 86400000, HOUR = 3600000;
const NOW = Date.now();
const iso = t => new Date(t).toISOString();

/* ---------- pure parts ---------- */

test('weather: a reasons line only for wind ≥ 30 km/h, heavy rain, 30 °C+', () => {
  assert.deepEqual(U.weatherNotes({ tempC: 18, rainPct: 20, rainMm: 0.2, windKmh: 12 }), []);
  assert.deepEqual(U.weatherNotes({ tempC: 18, rainPct: 20, rainMm: 0.2, windKmh: 30 }), ['wind']);
  assert.deepEqual(U.weatherNotes({ tempC: 31, rainPct: 80, rainMm: 3, windKmh: 10 }), ['rain', 'heat']);
  assert.deepEqual(U.weatherNotes({ tempC: 12, rainPct: 30, rainMm: 3, windKmh: 10 }), []); // 3 mm at a 30% chance: not heavy
  assert.deepEqual(U.weatherNotes({ tempC: 12, rainPct: 30, rainMm: 5, windKmh: 10 }), ['rain']);
  assert.deepEqual(U.weatherNotes(null), []);
});

test('indoor: basketball always, domed NFL / college stadiums, indoor tennis; football never', () => {
  assert.equal(U.isIndoor('basketball', 'Madison Square Garden'), true);
  assert.equal(U.isIndoor('nfl', 'Ford Field'), true);
  assert.equal(U.isIndoor('nfl', 'Caesars Superdome'), true);
  assert.equal(U.isIndoor('nfl', 'Lambeau Field'), false);
  assert.equal(U.isIndoor('nfl', 'Arrowhead Stadium'), false);
  assert.equal(U.isIndoor('tennis', 'Vienna, Austria', true), true);
  assert.equal(U.isIndoor('tennis', 'Paris, France', false), false);
  assert.equal(U.isIndoor('football', 'Anfield'), false);
});

test('referee: shrunk toward the league (10 games of weight), rates only from 10 games', () => {
  const league = { homeWin: 0.45, cards: 4, pens: 0.25 };
  const nine = Array.from({ length: 9 }, () => ({ homeWin: true, cards: 8, pens: 1 }));
  const s9 = U.refereeStats(nine, league);
  assert.equal(s9.games, 9);
  assert.equal(s9.show, false);
  assert.equal(s9.homeWin, null);
  assert.equal(s9.cards, null);
  const twelve = [...Array.from({ length: 9 }, () => ({ homeWin: true, cards: 6, pens: 0 })), ...Array.from({ length: 3 }, () => ({ homeWin: false, cards: 2, pens: 1 }))];
  const s = U.refereeStats(twelve, league);
  assert.equal(s.show, true);
  // home wins: (9 + 10 × 0.45) / (12 + 10) = 13.5 / 22
  assert.equal(s.homeWin, Math.round((13.5 / 22) * 100) / 100);
  assert.ok(s.homeWin < 9 / 12 && s.homeWin > 0.45, 'between his raw rate and the league');
  // cards: (9×6 + 3×2 + 10×4) / 22 = 100 / 22
  assert.equal(s.cards, Math.round((100 / 22) * 100) / 100);
  assert.equal(s.pens, Math.round(((3 + 2.5) / 22) * 100) / 100);
  assert.equal(U.shrink(0, 0, 0.45), 0.45, 'no games = the league');
  assert.equal(U.refName('Michael Oliver, England'), 'Michael Oliver');
  assert.equal(U.refName(null), null);
});

test('fixture difficulty colours: football (three results) and two-result sports', () => {
  assert.equal(U.difficultyBand(0.55, true), 'easy');
  assert.equal(U.difficultyBand(0.5, true), 'easy');
  assert.equal(U.difficultyBand(0.4, true), 'medium');
  assert.equal(U.difficultyBand(0.29, true), 'hard');
  assert.equal(U.difficultyBand(0.6, false), 'easy');
  assert.equal(U.difficultyBand(0.5, false), 'medium');
  assert.equal(U.difficultyBand(0.39, false), 'hard');
  assert.equal(U.difficultyBand(null, false), 'unknown');
});

test('binomial tail', () => {
  assert.ok(Math.abs(U.binomTail(8, 8, 0.5) - 1 / 256) < 1e-12);
  assert.ok(Math.abs(U.binomTail(0, 8, 0.5) - 1) < 1e-12);
  assert.ok(Math.abs(U.binomTail(7, 8, 0.46) - (8 * 0.46 ** 7 * 0.54 + 0.46 ** 8)) < 1e-12);
});

/* ---------- trends on a fixture (football through the service: tracked results) ---------- */

// a league of 12 teams, ~22 rounds: team 1 wins nearly every home game, team 2 never keeps a clean sheet away
const insP = db.prepare(`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, settled, created_at, updated_at)
  VALUES (?, 'grid-v3', 'TST', 'Test League', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insR = db.prepare(`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', ?, ?, ?, ?)`);
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const name = id => `Team ${id}`;
let mid = 1;
const fixture = [];
for (let round = 0; round < 22; round++) {
  const t = NOW - (23 - round) * 7 * DAY;
  const ids = Array.from({ length: 12 }, (_, i) => i + 1).sort(() => rnd() - 0.5);
  for (let k = 0; k < 6; k++) {
    let h = ids[2 * k], a = ids[2 * k + 1];
    let hg = Math.floor(rnd() * 3), ag = Math.floor(rnd() * 3);
    if (h === 1) { hg = 2 + Math.floor(rnd() * 2); ag = rnd() < 0.15 ? 3 : Math.floor(rnd() * 2); }
    if (a === 2) ag = 0, hg = Math.max(1, hg);
    fixture.push({ id: mid, date: iso(t + k * HOUR), h, a, hg, ag });
    insP.run(mid, iso(t + k * HOUR), h, name(h), a, name(a), 40, 30, 30, 1, iso(t), iso(t));
    insR.run(mid, hg, ag, hg > ag ? 'H' : hg < ag ? 'A' : 'D', iso(t + 3 * HOUR));
    mid++;
  }
}
// the game we look at: team 1 at home to team 2, in 2 days; and each side's next games (difficulty)
const GAME = 9000;
insP.run(GAME, iso(NOW + 2 * DAY), 1, name(1), 2, name(2), 70, 18, 12, 0, iso(NOW), iso(NOW));
insP.run(9001, iso(NOW + 9 * DAY), 3, name(3), 1, name(1), 20, 25, 55, 0, iso(NOW), iso(NOW));
insP.run(9002, iso(NOW + 16 * DAY), 1, name(1), 4, name(4), 35, 30, 35, 0, iso(NOW), iso(NOW));
insP.run(9003, iso(NOW + 9 * DAY), 2, name(2), 5, name(5), 20, 30, 50, 0, iso(NOW), iso(NOW));

/** independent re-count of a trend from the fixture rows (not the generator's own code) */
function recount(tr, teamId, before) {
  const games = fixture.filter(f => (f.h === teamId || f.a === teamId) && f.date < before).sort((x, y) => (x.date < y.date ? 1 : -1))
    .map(f => f.h === teamId ? { home: true, gf: f.hg, ga: f.ag } : { home: false, gf: f.ag, ga: f.hg })
    .filter(g => tr.split === 'all' || (tr.split === 'home' ? g.home : !g.home)).slice(0, tr.n);
  const ok = {
    win: g => g.gf > g.ga, loss: g => g.gf < g.ga, unbeaten: g => g.gf >= g.ga, winless: g => g.gf <= g.ga,
    over: g => g.gf + g.ga > 2.5, under: g => g.gf + g.ga < 2.5, btts: g => g.gf > 0 && g.ga > 0, cleanSheet: g => g.ga === 0, noGoal: g => g.gf === 0
  }[tr.pattern];
  return { n: games.length, k: games.filter(ok).length };
}

test('trends: only true statements, at most 4, none under 6 games, rarest first', () => {
  const x = S.gameExtras('football', GAME, NOW);
  assert.ok(x, 'the game is found');
  assert.ok(x.trends.length >= 1, 'the fixture has strong trends');
  assert.ok(x.trends.length <= 4);
  const before = iso(NOW + 2 * DAY);
  for (const tr of x.trends) {
    const teamId = tr.side === 'home' ? 1 : 2;
    assert.ok(tr.n >= 6 && tr.n <= 10, `window ${tr.n}`);
    assert.ok(tr.split === 'all' || tr.split === tr.side, 'home team: home games, away team: away games');
    const c = recount(tr, teamId, before);
    assert.equal(c.n, tr.n, `${tr.team} ${tr.pattern} ${tr.split}: ${tr.n} games exist`);
    assert.equal(c.k, tr.k, `${tr.team} ${tr.pattern} ${tr.split}: ${tr.k} of ${tr.n} is true`);
    assert.ok(tr.k >= Math.ceil(0.7 * tr.n));
  }
  for (let i = 1; i < x.trends.length; i++) assert.ok(x.trends[i - 1].p <= x.trends[i].p, 'rarest first');
  // the planted facts are found
  assert.ok(x.trends.some(t => t.side === 'home' && (t.pattern === 'win' || t.pattern === 'unbeaten')), 'team 1 wins at home');
  assert.ok(x.trends.some(t => t.side === 'away' && t.pattern === 'noGoal'), 'team 2 never scores away');
});

test('trends: a team with fewer than 6 games gets none', () => {
  const t = U.teamTrends('football', 'home', 'New', [1, 2, 3, 4, 5].map(i => ({ date: `2026-0${i}-01`, home: true, gf: 3, ga: 0 })), new Map([['win|all', 0.4], ['win|home', 0.45]]), 2.5);
  assert.deepEqual(t, []);
});

test('trends: the generator never states a false count (random leagues, every trend re-counted)', () => {
  for (let run = 0; run < 40; run++) {
    const games = Array.from({ length: 14 }, (_, i) => ({ date: iso(NOW - i * DAY), home: rnd() < 0.5, gf: Math.floor(rnd() * 4), ga: Math.floor(rnd() * 3) }));
    const rates = U.leagueRates('football', Array.from({ length: 400 }, () => { const h = Math.floor(rnd() * 3), a = Math.floor(rnd() * 3); return [{ date: '', home: true, gf: h, ga: a }, { date: '', home: false, gf: a, ga: h }]; }).flat(), 2.5);
    for (const tr of U.teamTrends('football', 'home', 'X', games, rates, 2.5)) assert.equal(U.trendIsTrue(tr, games), true);
  }
});

test('difficulty on the game page: each side’s next games after this one, coloured by our win chance', () => {
  const x = S.gameExtras('football', GAME, NOW);
  assert.deepEqual(x.difficulty.home.next.map(n => [n.id, n.band]), [[9001, 'easy'], [9002, 'medium']]);
  assert.deepEqual(x.difficulty.away.next.map(n => [n.id, n.band]), [[9003, 'hard']]);
  assert.ok(!x.difficulty.home.next.some(n => n.id === GAME), 'not the game itself');
  const team = S.teamExtras('football', 1, NOW);
  assert.deepEqual(team.next.map(n => n.id), [GAME, 9001, 9002]);
  assert.equal(team.next[0].band, 'easy');
});

/* ---------- indoor = no weather; outdoor = the forecast at the start hour (fake Open-Meteo) ---------- */

test('weather: outdoor NFL game and outdoor tennis get the forecast, domed stadium / indoor tennis / basketball none', async () => {
  const k1 = iso(Math.floor((NOW + 30 * HOUR) / HOUR) * HOUR);
  const nflIns = db.prepare(`INSERT INTO nfl_games (game_id, season, week, stage, kickoff, home_id, home_name, away_id, away_name, status, venue, updated_at, league) VALUES (?, 2026, 'Week 8', 'Regular Season', ?, ?, ?, ?, ?, 'NS', ?, ?, 1)`);
  nflIns.run(501, k1, 11, 'Green Bay Packers', 12, 'Chicago Bears', 'Lambeau Field, Green Bay', iso(NOW));
  nflIns.run(502, k1, 13, 'Detroit Lions', 14, 'Minnesota Vikings', 'Ford Field, Detroit', iso(NOW));
  db.prepare(`INSERT INTO tennis_tournaments (id, name, tour, surface, indoor, city, country, updated_at) VALUES ('t1', 'Paris Masters', 'atp', 'hard', 1, 'Paris', 'France', ?), ('t2', 'Open Outdoor', 'atp', 'clay', 0, 'Madrid', 'Spain', ?)`).run(iso(NOW), iso(NOW));
  const tIns = db.prepare(`INSERT INTO tennis_matches (id, tournament_id, tournament, tour, surface, indoor, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (?, ?, ?, 'atp', ?, ?, ?, 'upcoming', 1, 'A', 2, 'B', 'live', ?)`);
  tIns.run(701, 't1', 'Paris Masters', 'hard', 1, k1, iso(NOW));
  tIns.run(702, 't2', 'Open Outdoor', 'clay', 0, k1, iso(NOW));
  db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (801, 'NBA', 12, '2026-2027', ?, 'NS', 21, 'Lakers', 22, 'Celtics', ?)`).run(k1, iso(NOW));

  const asked = [];
  S.setExtrasFetcher(async url => {
    asked.push(url);
    if (url.includes('geocoding')) {
      const q = decodeURIComponent(new URL(url).searchParams.get('name'));
      const at = { 'Green Bay': [44.5, -88.0, 'United States'], Detroit: [42.3, -83.0, 'United States'], Madrid: [40.4, -3.7, 'Spain'], Paris: [48.9, 2.35, 'France'] }[q];
      return { results: at ? [{ name: q, latitude: at[0], longitude: at[1], country: at[2], population: 1000 }] : [] };
    }
    const lats = new URL(url).searchParams.get('latitude').split(',');
    const time = Array.from({ length: 96 }, (_, i) => new Date(Math.floor(NOW / DAY) * DAY + i * HOUR).toISOString().slice(0, 16));
    const one = () => ({ hourly: { time, temperature_2m: time.map(() => 7), precipitation_probability: time.map(() => 80), precipitation: time.map(() => 5), wind_speed_10m: time.map(() => 34) } });
    return lats.length === 1 ? one() : lats.map(one);
  });
  await S.extrasTick(NOW, { football: false });

  const green = S.gameExtras('nfl', 501, NOW), dome = S.gameExtras('nfl', 502, NOW);
  assert.equal(green.indoor, false);
  assert.ok(green.weather, 'outdoor stadium: weather');
  assert.deepEqual([green.weather.tempC, green.weather.rainPct, green.weather.rainMm, green.weather.windKmh], [7, 80, 5, 34]);
  assert.deepEqual(green.weather.notes, ['wind', 'rain']);
  assert.equal(dome.indoor, true);
  assert.equal(dome.weather, null, 'domed stadium: no weather card');
  assert.equal(S.gameExtras('tennis', 701, NOW).weather, null, 'indoor tennis: no weather card');
  assert.ok(S.gameExtras('tennis', 702, NOW).weather, 'outdoor tennis: weather');
  const bb = S.gameExtras('basketball', 801, NOW);
  assert.equal(bb.indoor, true);
  assert.equal(bb.weather, null, 'basketball: no weather card');
  assert.equal(bb.referee, null, 'no referee card outside football');
  assert.ok(!asked.some(u => u.includes('Detroit')), 'the dome was never looked up');
  // coverage for admin / data health
  const a = S.gameExtrasAdmin();
  assert.equal(a.coverage.sports.nfl.weatherShould, 1);
  assert.equal(a.coverage.sports.nfl.weatherHave, 1);
  assert.equal(a.coverage.sports.basketball.indoor, 1);
  // the football game in 48 h has no weather (football was not collected here): 2 of 3 outdoor games = under 80% → warn
  const h = S.gameExtrasHealth(NOW);
  assert.equal(h[0].id, 'game-extras');
  assert.equal(h[0].level, 'warn');
  assert.match(h[0].detail, /67% of the next 48 h's outdoor games/);
  assert.ok(h[0].items.some(i => i.startsWith('football 9000')), 'the game without its card is listed');
});

test('referee card from stored fixtures (football): league average and his shrunk numbers', () => {
  const put = db.prepare(`INSERT INTO extras_ref_fixtures (fixture_id, league, season, date, referee, hg, ag, cards, pens, detail_at) VALUES (?, 39, 2026, '2026-09-01', ?, ?, ?, ?, ?, 'x')`);
  let id = 1;
  for (let i = 0; i < 40; i++) put.run(id++, 'Other Ref', i % 2 ? 1 : 0, 0, 4, i % 4 === 0 ? 1 : 0);
  for (let i = 0; i < 12; i++) put.run(id++, 'Strict Ref', i < 10 ? 2 : 0, 1, 7, 1);
  const c = S.refereeCard('Strict Ref', 39, 2026);
  assert.equal(c.games, 12);
  assert.equal(c.show, true);
  const lgHome = (20 + 10) / 52; // 20 of the 40 others and 10 of his 12
  assert.equal(c.leagueHomeWin, Math.round(lgHome * 100) / 100);
  assert.equal(c.homeWin, Math.round(((10 + 10 * lgHome) / 22) * 100) / 100);
  assert.ok(c.cards > 4 && c.cards < 7);
  assert.equal(S.refereeCard('New Ref', 39, 2026).show, false);
  assert.deepEqual(S.cardsAndPens([{ type: 'Card', detail: 'Yellow Card' }, { type: 'Goal', detail: 'Penalty', time: { elapsed: 50 } }, { type: 'Goal', detail: 'Penalty', comments: 'Penalty Shootout', time: { elapsed: 120 } }]), { cards: 1, pens: 1 });
});

// fix267: the whole career on every player page, every sport. One player per sport end to end — through the real
// provider clients with fetch answered by provider-shaped fixtures (no network): an NBA veteran (balldontlie, regular
// season + playoffs, a trade season), a European player (API-Basketball, two leagues + "other games", the current season
// from our box scores), an NFL quarterback whose career starts before the provider's history (the partial flag), a top-10
// tennis player (1968–2014 archive by name, the stored 2015–2022 archive, our feed, Grand Slam results, year-end rank);
// then the monthly refresh, the weekly current season, the page queue and the data-health check. (dist build)
// Run: npm run test:fix267
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix267-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'error';
// fake keys: every call below is answered by the fixtures (fetch is replaced), nothing leaves the test
process.env.BALLDONTLIE_KEY = 'test'; process.env.API_BASKETBALL_KEY = 'test'; process.env.API_NFL_KEY = 'test'; process.env.TENNIS_API_KEY = 'test';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
const C = require('../dist/utils/careers.js');
const PC = require('../dist/services/playerCareers.js');
const { nflBoxSeasons } = require('../dist/services/nflSite.js');
const DAY = 86400000;
const NOW_BB = PC.bbCurrentOrder(); // 2026 in Oct 2026
const iso = (d) => new Date(d).toISOString();

/* ---------- the providers (fixtures) ---------- */

const calls = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-requests-remaining': '5000', 'x-ratelimit-requests-limit': '7500' } });
// balldontlie — LeBron James (bdl 237, drafted 2003): Cleveland 2003–09, Miami 2010–13, Cleveland 2014–17, Lakers 2018 →;
// 2025-26 season traded mid-season to test the two-team row; no playoffs in 2019 and 2021-22
const BRON = { id: 237, draft: 2003 };
const bronTeam = (s) => (s <= 2009 ? 'Cleveland Cavaliers' : s <= 2013 ? 'Miami Heat' : s <= 2017 ? 'Cleveland Cavaliers' : 'Los Angeles Lakers');
const bronAvg = (s, kind) => {
  if (s > 2025 || s < 2003) return null;
  if (kind === 'playoffs' && [2018, 2021, 2024].includes(s)) return null;
  const pts = s === 2005 ? 31.4 : 27 - (s - 2003) * 0.1;
  return { gp: kind === 'playoffs' ? 14 : s === 2018 ? 55 : 71, min: '37.2', pts, reb: 7.4, ast: 7.3, stl: 1.5, blk: 0.7, fg_pct: 0.505, fg3_pct: 0.348, ft_pct: 0.735, fgm: 9.9, fga: 19.6, fg3m: 1.6, fg3a: 4.6, ftm: 5.7, fta: 7.8 };
};
function bdl(u) {
  const season = Number(u.searchParams.get('season') || u.searchParams.get('seasons[]'));
  if (u.pathname === '/v1/season_averages/general') {
    const st = bronAvg(season, u.searchParams.get('season_type'));
    return json({ data: st ? [{ player: { id: BRON.id }, season, season_type: u.searchParams.get('season_type'), stats: st }] : [], meta: {} });
  }
  if (u.pathname === '/v1/stats') {
    const rows = [{ min: '36', team: { id: 14, full_name: bronTeam(season) }, game: { date: `${season}-11-02` } }];
    if (season === 2025) rows.push({ min: '33', team: { id: 6, full_name: 'Cleveland Cavaliers' }, game: { date: '2026-02-20' } });
    return json({ data: rows, meta: {} });
  }
  return json({ data: [], meta: {} }); // contracts and the rest
}
// API-Basketball — a European player (id 5001): Olympiacos 2023-24 (EuroLeague + Greek league games we don't follow) and
// 2024-25, Real Madrid 2025-26 (ACB, one playoff game), Real Madrid this season (our box scores fill it); nothing before 2023
const EURO = 5001;
const g = (game, team, min, pts, fg = [6, 12], tp = [2, 5], ft = [3, 4], reb = 5, ast = 2) =>
  ({ game: { id: game }, team: { id: team }, player: { id: EURO, name: 'Vezenko S.' }, type: 'starters', minutes: min, field_goals: { total: fg[0], attempts: fg[1] }, threepoint_goals: { total: tp[0], attempts: tp[1] }, freethrows_goals: { total: ft[0], attempts: ft[1] }, rebounds: { total: reb }, assists: ast, points: pts });
const EURO_SEASONS = {
  '2023-2024': [g(9101, 300, '30:10', 20), g(9102, 300, '28:00', 16), g(9901, 300, '25:00', 12), g(9103, 300, '0:00', 0)],
  '2024-2025': [g(9201, 300, '31:00', 22), g(9202, 300, '29:30', 18)],
  '2025-2026': [g(9301, 33, '27:00', 15), g(9302, 33, '24:00', 11), g(9303, 33, '26:00', 14)],
  '2026-2027': [g(9401, 33, '25:00', 30)]
};
function apiBb(u) {
  if (u.pathname === '/games/statistics/players') return json({ response: Number(u.searchParams.get('player')) === EURO ? EURO_SEASONS[u.searchParams.get('season')] || [] : [] });
  if (u.pathname === '/teams') return json({ response: [{ id: Number(u.searchParams.get('id')), name: 'Olympiacos', logo: 'https://media.api-sports.io/basketball/teams/300.png' }] });
  return json({ response: [] });
}
// API-American-Football — a quarterback (id 777) with 21 NFL seasons (started 2005): the provider has 2010 → 2026
const QB = 777;
function apiNfl(u) {
  if (u.pathname === '/leagues') return json({ response: [{ seasons: Array.from({ length: 17 }, (_, i) => ({ year: 2010 + i, current: 2010 + i === 2026 })) }] });
  if (u.pathname === '/players/statistics') {
    const s = Number(u.searchParams.get('season'));
    if (Number(u.searchParams.get('id')) !== QB || s > 2025) return json({ response: [] });
    const team = s <= 2022 ? { id: 10, name: 'Green Bay Packers', logo: 'gb.png' } : { id: 20, name: 'New York Jets', logo: 'nyj.png' };
    return json({ response: [{ player: { id: QB, name: 'A. Rodgers' }, teams: [{ team, groups: [
      { name: 'Passing', statistics: [{ name: 'completions', value: '350' }, { name: 'passing attempts', value: '520' }, { name: 'yards', value: s === 2011 ? '4,643' : '3,900' }, { name: 'passing touchdowns', value: s === 2011 ? '45' : '28' }, { name: 'interceptions', value: '6' }, { name: 'quaterback rating', value: '105.2' }] },
      { name: 'Rushing', statistics: [{ name: 'rushing attempts', value: '40' }, { name: 'yards', value: '180' }, { name: 'rushing touchdowns', value: '2' }] }
    ] }] }] });
  }
  return json({ response: [] });
}
// Live Tennis API — a top-10 player (id 9001, "Novak Djokovic", born 1987): the 1968–2014 archive by name (his 2005–2014
// matches + another player's match the name filter also returns)
const TN = 9001;
const arch = (id, date, tournament, level, surface, round, won, rank, other = 'Rafael Nadal') => ({ id, tour: 'atp', level, tournament, surface, event_date: date, round, best_of: 5,
  winner: won ? { player_id: 1, name: 'Novak Djokovic', rank } : { player_id: 2, name: other, rank: 2 }, loser: won ? { player_id: 2, name: other, rank: 2 } : { player_id: 1, name: 'Novak Djokovic', rank }, score: '6-4 6-4 6-4', outcome: 'completed' });
const ARCHIVE = [
  arch(1, '2008-01-14', 'Australian Open', 'G', 'Hard', 'F', true, 3, 'Jo-Wilfried Tsonga'),
  arch(2, '2008-01-14', 'Australian Open', 'G', 'Hard', 'SF', true, 3, 'Roger Federer'),
  arch(3, '2008-05-25', 'Roland Garros', 'G', 'Clay', 'SF', false, 3),
  arch(4, '2008-03-10', 'Indian Wells Masters', 'M', 'Hard', 'F', true, 3, 'Mardy Fish'),
  arch(5, '2008-07-14', 'Challenger Somewhere', 'C', 'Clay', 'F', true, 3, 'Someone Else'), // Challenger: left out
  arch(6, '2011-06-20', 'Wimbledon', 'G', 'Grass', 'F', true, 2),
  arch(7, '2011-11-20', 'Tour Finals', 'F', 'Hard', 'RR', false, 1, 'Tomas Berdych'),
  { ...arch(8, '2011-04-01', 'Monte Carlo Masters', 'M', 'Clay', 'R32', true, 1, 'Gael Monfils'), winner: { player_id: 77, name: 'Novak Djokovic Jr', rank: 900 } } // another name
];
function tennis(u) {
  if (u.pathname.endsWith('/history/archive/matches')) {
    assert.equal(u.searchParams.get('name'), 'Novak Djokovic');
    return json({ data: ARCHIVE, meta: { has_more: false } });
  }
  if (u.pathname.endsWith('/usage')) return json({});
  return json({ data: [], meta: {} });
}
globalThis.fetch = async (input) => {
  const u = new URL(String(input));
  calls.push(`${u.host}${u.pathname}?${u.searchParams}`);
  if (u.host.includes('balldontlie')) return bdl(u);
  if (u.host.includes('basketball.api-sports')) return apiBb(u);
  if (u.host.includes('american-football.api-sports')) return apiNfl(u);
  if (u.host.includes('livetennisapi')) return tennis(u);
  throw new Error(`unexpected call ${u}`);
};

/* ---------- our own data ---------- */

const insGame = db.prepare(`INSERT OR REPLACE INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, home_logo, away_id, away_name, away_logo, hs, as_, updated_at)
  VALUES (?, ?, 1, ?, ?, ?, 'FT', ?, ?, ?, ?, ?, ?, 80, 75, '2026-10-28')`);
// NBA teams (the career rows link to them)
insGame.run(1, 'NBA', '2025-2026', 'NBA - Regular Season', '2026-03-01T00:00:00Z', 145, 'Los Angeles Lakers', 'lal.png', 146, 'Miami Heat', 'mia.png');
insGame.run(2, 'NBA', '2025-2026', 'NBA - Regular Season', '2026-03-02T00:00:00Z', 147, 'Cleveland Cavaliers', 'cle.png', 145, 'Los Angeles Lakers', 'lal.png');
// the European player's games we follow: EuroLeague 2023-24 / 2024-25 (Olympiacos 300), ACB 2025-26 (Real Madrid 33, one playoff game)
insGame.run(9101, 'EL', '2023', 'Regular Season', '2023-10-10T19:00:00Z', 300, 'Olympiacos', 'oly.png', 301, 'Fenerbahce', 'fen.png');
insGame.run(9102, 'EL', '2023', 'Regular Season', '2023-11-10T19:00:00Z', 302, 'Monaco', 'mon.png', 300, 'Olympiacos', 'oly.png');
insGame.run(9103, 'EL', '2023', 'Regular Season', '2023-12-10T19:00:00Z', 300, 'Olympiacos', 'oly.png', 303, 'Baskonia', 'bas.png');
insGame.run(9201, 'EL', '2024', 'Regular Season', '2024-10-10T19:00:00Z', 300, 'Olympiacos', 'oly.png', 301, 'Fenerbahce', 'fen.png');
insGame.run(9202, 'EL', '2024', 'Regular Season', '2024-11-10T19:00:00Z', 300, 'Olympiacos', 'oly.png', 302, 'Monaco', 'mon.png');
insGame.run(9301, 'ACB', '2025-2026', 'Regular Season', '2025-10-10T19:00:00Z', 33, 'Real Madrid', 'rm.png', 34, 'Barcelona', 'fcb.png');
insGame.run(9302, 'ACB', '2025-2026', 'Regular Season', '2026-01-10T19:00:00Z', 34, 'Barcelona', 'fcb.png', 33, 'Real Madrid', 'rm.png');
insGame.run(9303, 'ACB', '2025-2026', 'Play Offs', '2026-06-10T19:00:00Z', 33, 'Real Madrid', 'rm.png', 34, 'Barcelona', 'fcb.png');
insGame.run(9401, 'ACB', '2026-2027', 'Regular Season', '2026-10-12T19:00:00Z', 33, 'Real Madrid', 'rm.png', 35, 'Valencia', 'val.png');
insGame.run(9402, 'ACB', '2026-2027', 'Regular Season', '2026-10-19T19:00:00Z', 36, 'Unicaja', 'uni.png', 33, 'Real Madrid', 'rm.png');
const insBox = db.prepare(`INSERT OR REPLACE INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes, pts, fgm, fga, tpm, tpa, ftm, fta, reb, ast) VALUES (?, ?, ?, ?, 1, ?, ?, 6, 12, 2, 5, 3, 4, 5, 2)`);
insBox.run(9401, 33, EURO, 'Vezenko S.', 25, 30); // our box scores: two games this season (the provider has one so far)
insBox.run(9402, 33, EURO, 'Vezenko S.', 27, 18);
// LeBron in our data (an NBA box line) + balldontlie's player row and today's season averages (bdl_season, synced daily)
const LBJ = 265;
insBox.run(1, 145, LBJ, 'LeBron James', 35, 25);
db.prepare(`INSERT OR REPLACE INTO bdl_players (id, first, last, name_key, position, draft_year, team_id, active, updated_at) VALUES (?, 'LeBron', 'James', 'james lebron', 'F', ?, 14, 1, ?)`).run(BRON.id, BRON.draft, iso(Date.now()));
db.prepare(`INSERT OR REPLACE INTO bdl_season (player_id, season, kind, stats, updated_at) VALUES (?, ?, 'base', ?, ?)`).run(BRON.id, NOW_BB, JSON.stringify({ gp: 4, min: '34.0', pts: 24.5, reb: 8, ast: 9, stl: 1, blk: 0.5, fg_pct: 0.52, fg3_pct: 0.4, ft_pct: 0.75, fgm: 9.5, fga: 18.3, fg3m: 2, fg3a: 5, ftm: 3.5, fta: 4.7 }), iso(Date.now()));

/* ---------- basketball ---------- */

test('basketball, NBA veteran: every season balldontlie has since his draft (2003-04 → 2025-26), playoffs apart, a trade season, this season from balldontlie daily', async () => {
  const before = calls.length;
  const r = await PC.buildCareer('basketball', LBJ);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.nba.seasons, 23); // 2003-04 … 2025-26
  const v = PC.careerFor('basketball', LBJ, { live: [PC.nbaCurrentLine(BRON.id, { id: 145, name: 'Los Angeles Lakers', logo: 'lal.png' })], liveFrom: NOW_BB });
  assert.equal(v.partial, false);
  assert.deepEqual(v.parts, ['regular', 'playoffs']);
  const reg = v.rows.filter(x => x.kind === 'regular' && x.league?.code === 'NBA');
  assert.equal(reg.length, 24); // + this season
  assert.equal(v.from, '2003-04');
  assert.equal(reg[0].season, '2026-27'); assert.equal(reg[0].source, 'balldontlie'); assert.equal(reg[0].gp, 4);
  const trade = reg.find(x => x.season === '2025-26');
  assert.equal(trade.team.name, 'Cleveland Cavaliers'); assert.equal(trade.team.id, 147); assert.equal(trade.also[0].name, 'Los Angeles Lakers');
  assert.equal(reg.find(x => x.season === '2010-11').team.name, 'Miami Heat'); assert.equal(reg.find(x => x.season === '2010-11').team.id, 146);
  assert.equal(v.rows.filter(x => x.kind === 'playoffs').length, 20); // 23 seasons − 3 without playoffs
  assert.equal(reg.find(x => x.season === '2014-15').stats.fgPct, 50.5);
  // totals: per-game weighted by games; percentages from made / attempted; best season 2005-06 (31.4)
  assert.equal(v.totals.regular.gp, 22 * 71 + 55 + 4);
  assert.equal(v.highs.find(h => h.key === 'pts').season, '2005-06');
  assert.equal(v.highs.find(h => h.key === 'pts').value, 31.4);
  assert.ok(v.totals.regular.stats.fgPct > 50 && v.totals.regular.stats.fgPct < 51.2);
  assert.ok(v.sources.includes('balldontlie'));
  console.log(`  NBA veteran: balldontlie gave ${r.info.nba.seasons} seasons (${calls.length - before} calls)`);
});

test('basketball, European player: API-Basketball seasons per team and league, "other games", playoffs apart, pre-season and bench games out, this season from our box scores', async () => {
  const r = await PC.buildCareer('basketball', EURO);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.nba, null);
  assert.equal(r.info.apiBasketball, 4); // 2023-24 … 2026-27
  const live = PC.bbLiveLines([{ code: 'ACB', league: 'Liga ACB', season: '2026-2027', team: { id: 33, name: 'Real Madrid', logo: 'rm.png' }, gp: 2, min: 26, pts: 24, reb: 5, ast: 2, fgPct: 50, tpPct: 40, ftPct: 75 }]);
  const v = PC.careerFor('basketball', EURO, { live, liveFrom: NOW_BB });
  const s2324 = v.rows.filter(x => x.season === '2023-24');
  const el = s2324.find(x => x.league?.code === 'EL');
  assert.equal(el.gp, 2); // the 0-minute game is not a game played
  assert.equal(el.stats.pts, 18); assert.equal(el.team.name, 'Olympiacos');
  assert.ok(s2324.some(x => x.league === null && x.gp === 1)); // a Greek league game we don't follow: "other games"
  const acb = v.rows.filter(x => x.season === '2025-26');
  assert.equal(acb.find(x => x.kind === 'regular').gp, 2); assert.equal(acb.find(x => x.kind === 'playoffs').gp, 1);
  const now = v.rows.find(x => x.season === '2026-27');
  assert.equal(now.source, 'our box scores'); assert.equal(now.gp, 2); // ours (2 games) over the provider's one
  assert.equal(v.seasons, 4); assert.equal(v.from, '2023-24');
  assert.deepEqual(v.sources.sort(), ['API-Basketball', 'our box scores']);
  console.log(`  European player: API-Basketball gave ${r.info.apiBasketball} seasons`);
});

/* ---------- American football ---------- */

test('American football, QB: every season the plan has (2010 → 2025), QB columns, partial — his career starts before the provider\'s history', async () => {
  db.prepare(`INSERT OR REPLACE INTO nfl_players (player_id, team_id, name, position, experience, updated_at) VALUES (?, 20, 'Aaron Rodgers', 'QB', 21, '2026-10-28')`).run(QB);
  db.prepare(`INSERT OR REPLACE INTO nfl_teams (team_id, name, logo, league, updated_at) VALUES (20, 'New York Jets', 'nyj.png', 1, '2026-10-28')`).run();
  const r = await PC.buildCareer('american-football', QB);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.seasons, 16); // 2010 … 2025
  assert.equal(r.partial, 'provider-start:2010');
  const v = PC.careerFor('american-football', QB, { live: [], group: PC.nflGroup('QB') });
  assert.equal(v.group, 'qb');
  assert.deepEqual(v.columns.map(c => c.key), ['cmp', 'att', 'cmpPct', 'passYds', 'passTd', 'int', 'rate', 'rushYds', 'rushTd']);
  assert.equal(v.partial, true); assert.equal(v.partialWhy, 'provider-start:2010');
  const y2011 = v.rows.find(x => x.season === '2011');
  assert.equal(y2011.stats.passYds, 4643); assert.equal(y2011.stats.passTd, 45); assert.equal(y2011.stats.cmpPct, 67.3); assert.equal(y2011.team.name, 'Green Bay Packers');
  assert.equal(v.highs.find(h => h.key === 'passTd').season, '2011');
  assert.equal(v.totals.regular.stats.passYds, 4643 + 15 * 3900);
  assert.equal(v.totals.regular.stats.rate, C.passerRating(16 * 350, 16 * 520, 4643 + 15 * 3900, 45 + 15 * 28, 96));
  console.log(`  NFL QB: API-American-Football gave ${r.seasons} seasons (partial: provider's history starts in 2010)`);
});

test('American football: this season from our box scores (the provider\'s names, summed, rating from the totals)', () => {
  db.prepare(`INSERT OR REPLACE INTO nfl_games (game_id, league, season, stage, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (5, 1, 2026, 'Regular Season', '2026-09-10T00:00:00Z', 'FT', 20, 'New York Jets', 21, 'Buffalo Bills', '2026-10-28')`).run();
  db.prepare(`INSERT OR REPLACE INTO nfl_games (game_id, league, season, stage, kickoff, status, home_id, home_name, away_id, away_name, updated_at) VALUES (6, 1, 2026, 'Regular Season', '2026-09-17T00:00:00Z', 'FT', 22, 'Miami Dolphins', 20, 'New York Jets', '2026-10-28')`).run();
  const box = (cmpAtt, yds, td) => JSON.stringify([{ name: 'Passing', players: [{ player: { id: QB, name: 'A. Rodgers' }, statistics: [{ name: 'comp att', value: cmpAtt }, { name: 'yards', value: yds }, { name: 'passing touch downs', value: td }, { name: 'interceptions', value: '1' }, { name: 'rating', value: '99.0' }] }] }]);
  for (const [gid, j] of [[5, box('20/30', '250', '2')], [6, box('25/35', '310', '3')]]) {
    db.prepare(`INSERT OR REPLACE INTO nfl_player_stats (game_id, team_id, json) VALUES (?, 20, ?)`).run(gid, j);
    db.prepare(`INSERT OR REPLACE INTO nfl_player_games (player_id, game_id, team_id) VALUES (?, ?, 20)`).run(QB, gid);
  }
  const live = PC.nflLiveLines(nflBoxSeasons(QB, 2026));
  const v = PC.careerFor('american-football', QB, { live, liveFrom: 2026, group: 'qb' });
  const cur = v.rows.find(x => x.season === '2026');
  assert.equal(cur.source, 'our box scores'); assert.equal(cur.gp, 2);
  assert.equal(cur.stats.cmp, 45); assert.equal(cur.stats.att, 65); assert.equal(cur.stats.passYds, 560); assert.equal(cur.stats.passTd, 5);
  assert.equal(cur.stats.rate, C.passerRating(45, 65, 560, 5, 2));
  assert.equal(v.seasons, 17);
});

/* ---------- tennis ---------- */

test('tennis, top-10 player: year by year — 1968–2014 archive by name, stored 2015–2022 archive, our feed; titles, finals, surfaces, Grand Slams, year-end rank', async () => {
  db.prepare(`INSERT OR REPLACE INTO tennis_players (id, name, country, tour, dob, ranking, seen_at) VALUES (?, 'Novak Djokovic', 'SRB', 'atp', '1987-05-22', 4, ?)`).run(TN, iso(Date.now()));
  for (let y = 2015; y <= 2022; y++) db.prepare(`INSERT OR REPLACE INTO tennis_meta (k, v) VALUES (?, '{}')`).run(`arch:${y}`);
  const up = db.prepare(`INSERT OR REPLACE INTO tennis_matches (id, tournament, tour, tier, surface, draw, round, round_code, is_qualifying, scheduled_at, status, p1_id, p1_name, p2_id, p2_name, winner, outcome, extra, source, updated_at)
    VALUES (?, ?, ?, ?, ?, 'singles', ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`);
  // stored archive 2015–2022 (ids < 0, archive person ids, p1 = winner)
  up.run(-101, 'Wimbledon', 'atp', 'G', 'grass', 'F', 'F', 0, '2015-06-29T00:00:00Z', 1, 'Novak Djokovic', 2, 'Roger Federer', 1, JSON.stringify({ winner: { rank: 1 }, loser: { rank: 2 } }), 'archive', iso(Date.now()));
  up.run(-102, 'Roland Garros', 'atp', 'G', 'clay', 'F', 'F', 0, '2015-05-25T00:00:00Z', 3, 'Stan Wawrinka', 1, 'Novak Djokovic', 1, JSON.stringify({ winner: { rank: 9 }, loser: { rank: 1 } }), 'archive', iso(Date.now()));
  // our feed (2023 →, live ids)
  up.run(501, 'Australian Open', 'atp', 'grand_slam', 'hard', 'Final', 'F', 0, '2023-01-29T08:00:00Z', TN, 'Novak Djokovic', 8000, 'Stefanos Tsitsipas', 1, null, 'history', iso(Date.now()));
  up.run(502, 'ATP Paris', 'atp', 'atp_1000', 'hard', 'Quarterfinals', 'QF', 0, '2023-11-03T12:00:00Z', 8001, 'Holger Rune', TN, 'Novak Djokovic', 2, null, 'history', iso(Date.now()));
  up.run(503, 'ATP Shanghai', 'atp', 'atp_1000', 'hard', 'Qualification', 'Q1', 1, '2026-10-01T12:00:00Z', TN, 'Novak Djokovic', 8002, 'Q Player', 1, null, 'history', iso(Date.now())); // qualifying: left out
  up.run(504, 'ATP Shanghai', 'atp', 'atp_1000', 'hard', 'Semifinals', 'SF', 0, '2026-10-11T12:00:00Z', TN, 'Novak Djokovic', 8003, 'Jannik Sinner', 2, null, 'history', iso(Date.now()));
  db.prepare(`INSERT OR REPLACE INTO tennis_rankings (tour, date, rank, player_id, player_name, points) VALUES ('atp', '2023-12-25', 1, ?, 'Novak Djokovic', 11000)`).run(TN);
  const r = await PC.buildCareer('tennis', TN);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.archiveRowsBefore2015, 7); // his 7 archive matches; "Novak Djokovic Jr" is someone else
  const v = PC.careerFor('tennis', TN, { live: PC.tennisLiveLines(TN), liveFrom: 2026 });
  assert.equal(r.seasons, 5); // 2008, 2011, 2015, 2023, 2026
  const y = (yr) => v.rows.find(x => x.season === String(yr)).stats;
  assert.deepEqual([y(2008).w, y(2008).l, y(2008).titles, y(2008).finals], [3, 1, 2, 2]); // the Challenger final is not counted
  assert.equal(y(2008).slams, 'AO W · RG SF'); assert.equal(y(2008).hard, '3–0'); assert.equal(y(2008).clay, '0–1');
  assert.equal(y(2011).slams, 'W W'); assert.equal(y(2011).grass, '1–0'); assert.equal(y(2011).rank, 1);
  assert.equal(y(2015).slams, 'RG F · W W');
  assert.equal(y(2023).rank, 1); // the stored year-end ranking
  assert.equal(y(2023).slams, 'AO W');
  assert.deepEqual([y(2026).w, y(2026).l], [0, 1]); // the qualifying match is not counted
  assert.equal(y(2026).rank, 4); // this year: his current rank
  assert.equal(v.totals.regular.stats.titles, 5); // AO 08, Indian Wells 08, Wimbledon 11, Wimbledon 15, AO 23
  assert.equal(v.totals.regular.stats.slams, 'AO ×2 · W ×2');
  assert.equal(v.highs.find(h => h.key === 'rank').value, 1);
  assert.equal(v.partial, false);
  assert.deepEqual(v.sources.sort(), ['Live Tennis API results archive', 'our data (Live Tennis API)']);
  console.log(`  tennis top-10: ${r.seasons} years with tour-level matches (fixture), ${r.info.archiveRowsBefore2015} archive matches before 2015`);
});

test('tennis: a player born in 1999 or later never asks the 1968–2014 archive', async () => {
  db.prepare(`INSERT OR REPLACE INTO tennis_players (id, name, tour, dob, ranking, seen_at) VALUES (9002, 'Young Player', 'atp', '2003-01-01', 20, ?)`).run(iso(Date.now()));
  const before = calls.filter(c => c.includes('archive')).length;
  const r = await PC.buildCareer('tennis', 9002);
  assert.equal(r.ok, true);
  assert.equal(calls.filter(c => c.includes('archive')).length, before);
});

/* ---------- refresh, queue, partial, health ---------- */

test('monthly refresh: a career a month old is built again; a week-old current season is refreshed alone (past seasons kept)', async () => {
  const old = iso(Date.now() - 31 * DAY);
  db.prepare(`UPDATE player_careers SET built_at = ?, current_at = ?, tried_at = NULL WHERE sport = 'american-football' AND player_id = ?`).run(old, old, QB);
  db.prepare(`UPDATE player_careers SET built_at = ?, current_at = ?, tried_at = NULL WHERE sport = 'basketball' AND player_id = ?`).run(iso(Date.now() - 10 * DAY), iso(Date.now() - 8 * DAY), EURO);
  db.prepare(`UPDATE player_seasons SET pts = -1 WHERE sport = 'basketball' AND player_id = ? AND ord = 2023`).run(EURO); // marks a past season
  db.exec(`DELETE FROM career_queue`);
  const nflBefore = calls.filter(c => c.includes('/players/statistics')).length;
  const euroBefore = calls.filter(c => c.includes(`player=${EURO}`)).length;
  await PC.careerTick(20);
  const m = PC.careerMeta('american-football', QB);
  assert.ok(Date.parse(m.built_at) > Date.now() - 60000, 'rebuilt');
  assert.ok(calls.filter(c => c.includes('/players/statistics')).length - nflBefore >= 16, 'every season asked again');
  // the European player: only this season asked (one call), the 2023-24 row untouched
  assert.equal(calls.filter(c => c.includes(`player=${EURO}`)).length - euroBefore, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM player_seasons WHERE sport = 'basketball' AND player_id = ? AND ord = 2023 AND pts = -1`).get(EURO).n, 2);
  const e = PC.careerMeta('basketball', EURO);
  assert.ok(Date.parse(e.current_at) > Date.now() - 60000 && Date.parse(e.built_at) < Date.now() - 9 * DAY);
});

test('page queue: a player without a career is queued once, shown as loading, built by the job', async () => {
  const v = PC.careerFor('basketball', 4242);
  assert.equal(v.partialWhy, 'loading'); assert.equal(v.rows.length, 0);
  PC.careerFor('basketball', 4242);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM career_queue WHERE sport = 'basketball' AND player_id = 4242`).get().n, 1);
  await PC.careerTick(1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM career_queue WHERE player_id = 4242`).get().n, 0);
  assert.ok(PC.careerMeta('basketball', 4242).built_at); // built (an empty career: the provider has nothing)
});

test('a failed build keeps the stored career, is retried after 6 h, and shows in data health', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  const before = PC.storedLines('american-football', QB).length;
  db.prepare(`UPDATE player_careers SET tried_at = NULL WHERE sport = 'american-football' AND player_id = ?`).run(QB);
  const r = await PC.buildCareer('american-football', QB);
  globalThis.fetch = saved;
  assert.equal(r.ok, false);
  assert.equal(PC.storedLines('american-football', QB).length, before);
  const h = PC.careerHealth();
  assert.equal(h.id, 'player-careers');
  assert.match(h.detail, /basketball \d+ % of \d+/);
  assert.match(h.detail, /american-football 100 % of 1 \(1 start before the provider's history\)/);
});

/* ---------- the pure parts ---------- */

test('pure: NFL stat names of the season endpoint and of box scores, position groups, passer rating', () => {
  const s = C.nflStatsOf([{ name: 'Passing', statistics: [{ name: 'comp att', value: '21/32' }, { name: 'yards', value: '1,234' }, { name: 'passing touch downs', value: '3' }] },
    { name: 'Defensive', statistics: [{ name: 'tackles', value: '7' }, { name: 'sacks', value: '1.5' }, { name: 'passes defended', value: '2' }] },
    { name: 'Kicking', statistics: [{ name: 'field goals', value: '2/3' }, { name: 'extra point', value: '3/3' }, { name: 'points', value: '9' }] }]);
  assert.deepEqual(s, { cmp: 21, att: 32, passYds: 1234, passTd: 3, tackles: 7, sacks: 1.5, pd: 2, fgm: 2, fga: 3, xpm: 3, xpa: 3, kPts: 9 });
  assert.equal(C.nflGroupOf('QB'), 'qb'); assert.equal(C.nflGroupOf('WR'), 'wr'); assert.equal(C.nflGroupOf('TE'), 'wr'); assert.equal(C.nflGroupOf('CB'), 'def');
  assert.equal(C.nflGroupOf('PK'), 'k'); assert.equal(C.nflGroupOf('P'), 'p'); assert.equal(C.nflGroupOf('OT'), 'other');
  assert.equal(C.passerRating(20, 20, 400, 5, 0), 158.3); // the maximum
});

test('pure: the Grand Slam result of a year keeps the deepest round', () => {
  const m = (d, t, round, won) => ({ date: d, tournament: t, surface: 'hard', level: 0, round, won, rank: null });
  const [y] = C.tennisYears([m('2020-01-20', 'Australian Open', 'R32', true), m('2020-01-22', 'Australian Open', 'R16', false)], () => 'x');
  assert.equal(y.stats.slams, 'AO R16');
});


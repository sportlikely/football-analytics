// fix201: basketball standings grouped one table per (stage, group) (src/utils/bbStandingsGroups.ts). Run: npm run test:fix201
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupStandings, standingsIssues } from '../src/utils/bbStandingsGroups.ts';

const row = (stage: string, group: string, id: number, won: number, lost: number, pf = 1000, pa = 1000, position = 1) => ({
  position, stage, group: { name: group }, team: { id, name: `Team ${id}`, logo: null },
  games: { played: won + lost, win: { total: won, percentage: null }, lose: { total: lost } }, points: { for: pf, against: pa }, form: null
});

/** NBA-shaped answer: conferences + divisions in one array per conference, plus a pre-season stage */
function nba(regularPlayed: boolean) {
  const east: any[] = [], west: any[] = [];
  const divs = ['Atlantic', 'Central', 'Southeast', 'Northwest', 'Pacific', 'Southwest'];
  for (let i = 0; i < 30; i++) {
    const id = 100 + i, conf = i < 15 ? 'Eastern Conference' : 'Western Conference';
    const won = regularPlayed ? (i * 7) % 5 : 0, lost = regularPlayed ? 4 - won : 0;
    const list = i < 15 ? east : west;
    list.push(row('NBA - Regular Season', conf, id, won, lost, 1000 + i, 1000));
    list.push(row('NBA - Regular Season', divs[Math.floor(i / 5)] + ' Division', id, won, lost, 1000 + i, 1000));
  }
  const pre = Array.from({ length: 30 }, (_, i) => row('Pre Season', 'Western Conference', 100 + i, 2, 1));
  return [pre, west, east];
}

test('NBA: two conference tables of 15 and six divisions of 5, no pre-season once the season has a played game', () => {
  const g = groupStandings(nba(true));
  const conf = g.filter(x => x.level === 'conference'), div = g.filter(x => x.level === 'division');
  assert.equal(conf.length, 2);
  assert.ok(conf.every(x => x.rows.length === 15));
  assert.equal(div.length, 6);
  assert.ok(div.every(x => x.rows.length === 5));
  assert.ok(g.every(x => x.kind === 'regular'), 'no pre-season table');
  assert.equal(new Set(g.map(x => x.name)).size, g.length, 'no heading twice');
  assert.deepEqual(g.slice(0, 2).map(x => x.level), ['conference', 'conference'], 'conferences first');
  assert.deepEqual(standingsIssues(g), []);
});

test('NBA: rows ranked inside their own table by win %, then wins, then point difference', () => {
  const west = groupStandings(nba(true)).find(x => x.name === 'Western Conference')!;
  assert.deepEqual(west.rows.map(r => r.position), Array.from({ length: 15 }, (_, i) => i + 1));
  for (let i = 1; i < west.rows.length; i++) {
    const a = west.rows[i - 1], b = west.rows[i];
    assert.ok(a.won / a.played >= b.won / b.played);
  }
  assert.ok(west.rows.every(r => r.team.id >= 115), 'only western teams');
});

test('before the first regular-season game: the pre-season table with games, not both', () => {
  const g = groupStandings(nba(false));
  assert.ok(g.length >= 1);
  assert.ok(g.every(x => x.kind === 'pre'));
  assert.equal(g.filter(x => x.name === 'Western Conference').length, 1);
});

test('play-off table with games shows above the regular season, its heading not repeated', () => {
  const r = nba(true);
  r.push(Array.from({ length: 8 }, (_, i) => row('Playoffs', 'Western Conference', 115 + i, 1, 0)));
  const g = groupStandings(r);
  assert.equal(g[0].kind, 'post');
  assert.equal(g[0].name, 'Playoffs · Western Conference');
  assert.equal(new Set(g.map(x => x.name)).size, g.length);
});

test('one-group league: one table as before', () => {
  const rows = Array.from({ length: 18 }, (_, i) => row('Regular Season', 'EuroLeague', 500 + i, i % 6, 5 - (i % 6), 900, 900, 18 - i));
  const g = groupStandings([rows]);
  assert.equal(g.length, 1);
  assert.equal(g[0].rows.length, 18);
  assert.equal(g[0].level, 'group');
});

test('groups A / B: one table per group, even when the provider sends them in one array', () => {
  const a = Array.from({ length: 6 }, (_, i) => row('Regular Season', 'Group A', 600 + i, i, 5 - i));
  const b = Array.from({ length: 6 }, (_, i) => row('Regular Season', 'Group B', 700 + i, i, 5 - i));
  const g = groupStandings([[...a, ...b]]);
  assert.deepEqual(g.map(x => [x.name, x.rows.length]), [['Group A', 6], ['Group B', 6]]);
  assert.equal(g[0].rows[0].team.id, 605, 'best record first');
});

test('data health: a team in two conferences is flagged', () => {
  const g = groupStandings(nba(true));
  const east = g.find(x => x.name === 'Eastern Conference')!, west = g.find(x => x.name === 'Western Conference')!;
  west.rows.push({ ...east.rows[0] });
  assert.equal(standingsIssues(g).length, 1);
});

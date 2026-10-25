// fix230: season forecast formats — MLS (two conferences, wild cards 8 v 9, best-of-three round one, MLS Cup), Liga MX
// (Apertura / Clausura apart, the Liguilla: top 8, two legs, re-seeded), Argentina (two zones from the schedule, the
// crossed play-offs, relegation on the annual table), a Belgian-style split (points halved, rounded up, the rounded
// team below on a tie), A-League byes, basketball group leagues; every position row sums to 100 %; new rules stay
// "position chances only" until last season's replay passes. Engine = dist build; service part on a scratch database.
// Run: npm run test:fix230
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix230-season-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
delete process.env.API_FOOTBALL_KEY;
const require = createRequire(import.meta.url);
const S = require('../dist/utils/seasonSim.js');
const Fit = require('../dist/utils/seasonFit.js');
const { rulesFor, FOOTBALL_RULES, BASKETBALL_RULES, SIM_PARAMS } = require('../dist/utils/seasonRules.js');

const sum = a => a.reduce((s, x) => s + x, 0);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const params = (sport, runs = 3000, seed = 11) => ({ runs, seed, ...SIM_PARAMS[sport] });
const DAY = 86400000;

function roundRobin(n) {
  const ids = Array.from({ length: n }, (_, i) => i), rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const rd = [];
    for (let k = 0; k < n / 2; k++) rd.push(r % 2 ? [ids[k], ids[n - 1 - k]] : [ids[n - 1 - k], ids[k]]);
    rounds.push(rd); ids.splice(1, 0, ids.pop());
  }
  return rounds;
}
const team = (id, rating, extra = {}) => ({ id, name: id, pts: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, played: 0, rating, ...extra });
function play(teams, played, h, a, hg, ag) {
  const H = teams.find(t => t.id === h), A = teams.find(t => t.id === a);
  H.played++; A.played++; H.gf += hg; H.ga += ag; A.gf += ag; A.ga += hg;
  if (hg > ag) { H.w++; A.l++; H.pts += 3; } else if (hg < ag) { A.w++; H.l++; A.pts += 3; } else { H.d++; A.d++; H.pts++; A.pts++; }
  played.push({ home: h, away: a, hg, ag });
}
function checkSums(out, msg) {
  for (const t of out.teams) close(sum(t.pos), 1, 1e-9, `${msg} ${t.id} position chances`);
  const by = new Map();
  for (const t of out.teams) { const g = t.group || ''; if (!by.has(g)) by.set(g, []); by.get(g).push(t); }
  for (const [g, ts] of by) for (let k = 0; k < ts.length; k++) close(sum(ts.map(t => t.pos[k] || 0)), 1, 1e-9, `${msg} group ${g} position ${k + 1}`);
}
const known = r => ({ ...r, known: true });

test('MLS: two conferences of 15, 7 straight in + the 8 v 9 wild card, one MLS Cup, one Supporters\' Shield', () => {
  const teams = [];
  for (let c = 0; c < 2; c++) for (let i = 0; i < 15; i++) teams.push(team(`${c ? 'W' : 'E'}${i}`, 0.5 - i / 14, { group: c ? 'Western Conference' : 'Eastern Conference' }));
  // the rest of the season: every team against every other team once (conference and cross-conference)
  const games = [];
  for (let x = 0; x < 30; x++) for (let y = x + 1; y < 30; y++) games.push({ id: `${x}-${y}`, home: teams[x].id, away: teams[y].id });
  const out = S.simulateSeason(known(rulesFor('football', 'AF253')), teams, [], games, params('football'));
  checkSums(out, 'MLS');
  assert.deepEqual(out.zones, ['title', 'final', 'shield', 'conf_title', 'playoffs', 'playin']);
  for (const conf of ['Eastern Conference', 'Western Conference']) {
    const ts = out.teams.filter(t => t.group === conf);
    assert.equal(ts[0].pos.length, 15, 'positions per conference');
    close(sum(ts.map(t => t.zones.playoffs)), 8, 1e-9, `${conf}: 8 play-off teams after the wild card`);
    close(sum(ts.map(t => t.zones.playin)), 2, 1e-9, `${conf}: two wild-card teams (8th and 9th)`);
    close(sum(ts.map(t => t.zones.conf_title)), 1, 1e-9, `${conf}: one conference champion`);
    close(sum(ts.map(t => t.zones.final)), 1, 1e-9, `${conf}: one MLS Cup finalist`);
    // the wild card is only ever 8th or 9th, and a 10th-placed team never makes it
    for (const t of ts) {
      const inWild = t.pos[7] + t.pos[8], top7 = sum(t.pos.slice(0, 7));
      close(t.zones.playin, inWild, 1e-9, `${t.id} wild card = 8th or 9th`);
      assert.ok(t.zones.playoffs <= top7 + inWild + 1e-9 && t.zones.playoffs >= top7 - 1e-9, `${t.id} play-offs between the top 7 and the top 9`);
    }
  }
  close(sum(out.teams.map(t => t.zones.title)), 1, 1e-9, 'one MLS Cup winner');
  close(sum(out.teams.map(t => t.zones.shield)), 1, 1e-9, 'one Supporters\' Shield');
  // the best two teams of the league (E0, W0) are the favourites for the Shield and the Cup
  const by = id => out.teams.find(t => t.id === id);
  assert.ok(by('E0').zones.shield > by('E7').zones.shield && by('W0').zones.title > by('W12').zones.title);
});

test('Liga MX: one tournament table of 18, the Liguilla top 8 in two legs, re-seeded; level → the better seed', () => {
  const teams = Array.from({ length: 18 }, (_, i) => team(`m${i}`, 0.45 - i * 0.9 / 17));
  const games = [];
  roundRobin(18).forEach((rd, r) => rd.forEach(([h, a], k) => games.push({ id: `${r}-${k}`, home: teams[h].id, away: teams[a].id })));
  const rules = known(rulesFor('football', 'AF262'));
  assert.equal(rules.post.kind, 'bracket'); assert.equal(rules.post.playIn, undefined, 'no play-in from the Apertura 2026');
  const out = S.simulateSeason(rules, teams, [], games, params('football'));
  checkSums(out, 'Liga MX');
  assert.deepEqual(out.zones, ['title', 'final', 'playoffs']);
  close(sum(out.teams.map(t => t.zones.playoffs)), 8, 1e-9, 'eight in the Liguilla');
  close(sum(out.teams.map(t => t.zones.final)), 2, 1e-9, 'two finalists');
  close(sum(out.teams.map(t => t.zones.title)), 1, 1e-9, 'one champion');
  for (const t of out.teams) close(t.zones.playoffs, sum(t.pos.slice(0, 8)), 1e-9, `${t.id}: Liguilla = top 8`);
  // the Liguilla bracket alone: eight equal teams, the table decides — level on aggregate the better seed goes
  // through, so the 1st seed wins it more often than the 8th
  const eq = Array.from({ length: 8 }, (_, i) => team(`q${i}`, 0, { pts: 30 - i, played: 17, w: 8, d: 6 - i % 3, l: 3 }));
  const lig = S.simulateSeason(rules, eq, [], [], params('football', 8000, 5));
  const t1 = lig.teams.find(t => t.id === 'q0').zones.title, t8 = lig.teams.find(t => t.id === 'q7').zones.title;
  assert.ok(t1 > t8 * 1.3, `the better seed's edge on a level aggregate: 1st ${t1} vs 8th ${t8}`);
  close(sum(lig.teams.map(t => t.zones.title)), 1, 1e-9, 'one champion');
});

test('Argentina: zones from the schedule, top 8 of each crossed, relegation on the annual table', () => {
  const A = Array.from({ length: 15 }, (_, i) => `a${i}`), B = Array.from({ length: 15 }, (_, i) => `b${i}`);
  // the tournament: everyone in its zone once + one interzonal game (a_i v b_i)
  const sched = [];
  for (const Z of [A, B]) for (let x = 0; x < 15; x++) for (let y = x + 1; y < 15; y++) sched.push({ home: Z[x], away: Z[y] });
  for (let i = 0; i < 15; i++) sched.push({ home: A[i], away: B[i] });
  const groups = Fit.inferGroups([...A, ...B], sched);
  assert.ok(groups, 'groups found');
  assert.equal(new Set(A.map(i => groups.get(i))).size, 1, 'zone A together');
  assert.equal(new Set(B.map(i => groups.get(i))).size, 1, 'zone B together');
  assert.notEqual(groups.get('a0'), groups.get('b0'), 'the interzonal game does not join the zones');
  // a league without groups in its schedule (everyone plays everyone): no groups
  const all = []; for (let x = 0; x < 10; x++) for (let y = x + 1; y < 10; y++) all.push({ home: `t${x}`, away: `t${y}` });
  assert.equal(Fit.inferGroups(Array.from({ length: 10 }, (_, i) => `t${i}`), all), null);

  // a29-like weak team with a terrible Apertura: last on the annual table far more often than an equal team that had a good one
  const teams = [...A, ...B].map((id, k) => team(id, id.endsWith('14') ? -0.3 : 0.4 - (k % 15) * 0.05, {
    group: groups.get(id), annual: { pts: id === 'a14' ? 5 : id === 'b14' ? 30 : 22, gd: 0, gf: 15 }
  }));
  const games = sched.map((g, k) => ({ id: `g${k}`, ...g }));
  const out = S.simulateSeason(known(rulesFor('football', 'AF128')), teams, [], games, params('football'));
  checkSums(out, 'Argentina');
  assert.deepEqual(out.zones, ['title', 'final', 'shield', 'playoffs', 'relegation']);
  for (const g of new Set(groups.values())) {
    const ts = out.teams.filter(t => t.group === g);
    assert.equal(ts[0].pos.length, 15, 'positions within the zone');
    close(sum(ts.map(t => t.zones.playoffs)), 8, 1e-9, `${g}: top 8 into the play-offs`);
    for (const t of ts) close(t.zones.playoffs, sum(t.pos.slice(0, 8)), 1e-9, `${t.id}: play-offs = top 8 of the zone`);
  }
  close(sum(out.teams.map(t => t.zones.relegation)), 1, 1e-9, 'one down on the annual table');
  close(sum(out.teams.map(t => t.zones.shield)), 1, 1e-9, 'one annual-table leader');
  close(sum(out.teams.map(t => t.zones.final)), 2, 1e-9, 'two finalists');
  close(sum(out.teams.map(t => t.zones.title)), 1, 1e-9, 'one champion');
  const z = id => out.teams.find(t => t.id === id).zones;
  assert.ok(z('a14').relegation > 0.5 && z('a14').relegation > z('b14').relegation * 3, `annual table: a14 ${z('a14').relegation} vs b14 ${z('b14').relegation}`);
});

test('Belgian-style split: points halved and rounded up, the rounded team ranks below on a tie; applySplit after the split', () => {
  // the 2025-26 Belgian format (the 2026-27 season is one table of 18 again): 30 games, then three groups, halved up
  const rules = { sport: 'football', known: true, tiebreaks: ['pts', 'rounded', 'wins', 'gd', 'gf'], zones: [{ key: 'cl', from: 1, to: 1 }, { key: 'top_group', from: 1, to: 6 }, { key: 'relegation', from: 16, to: 16 }],
    split: { after: 30, halve: 'up', groups: [{ from: 1, to: 6, rounds: 2 }, { from: 7, to: 12, rounds: 2 }, { from: 13, to: 16, rounds: 2 }] } };
  const teams = Array.from({ length: 16 }, (_, i) => team(`t${i}`, 0.6 - i * 0.08));
  const played = [];
  const rr = roundRobin(16), legs = [...rr, ...rr.map(rd => rd.map(([a, b]) => [b, a]))];
  legs.forEach(rd => rd.forEach(([h, a]) => { const d = teams[h].rating - teams[a].rating; play(teams, played, teams[h].id, teams[a].id, d > 0.2 ? 2 : 1, d < -0.2 ? 2 : 1); }));
  assert.ok(teams.every(t => t.played === 30));
  const out = S.simulateSeason(rules, teams, played, [], params('football', 2000));
  checkSums(out, 'split');
  for (const t of out.teams) {
    const src = teams.find(x => x.id === t.id), half = Math.ceil(src.pts / 2);
    // 10 games in the top two groups, 6 in the bottom one, 0–3 points each
    assert.ok(t.avgPts >= half - 1e-9 && t.avgPts <= half + 30 + 1e-9, `${t.id}: ${t.avgPts} from ${src.pts} halved up = ${half}`);
  }
  // groups stay apart: top six only 1–6, the bottom four only 13–16
  for (const t of out.teams.slice(0, 6)) close(sum(t.pos.slice(0, 6)), 1, 1e-9, `${t.id} in the top group`);
  for (const t of out.teams.slice(12)) close(sum(t.pos.slice(12)), 1, 1e-9, `${t.id} in the bottom group`);
  close(sum(out.teams.map(t => t.zones.top_group)), 6, 1e-9, 'six in the top group');

  // applySplit (a split already played): the groups from the table after 30 games, the halving, the rounded flag
  const split2 = { ...rules, split: { after: 30, halve: 'up', groups: [{ from: 1, to: 1, rounds: 2 }, { from: 2, to: 2, rounds: 2 }] } };
  // x: 9 wins + 2 draws + 19 losses = 29 before the split (odd → 15, rounded); y: 19 wins + 2 draws = 59 → 30
  const pre = [...Array.from({ length: 9 }, () => ({ home: 'x', away: 'y', hg: 1, ag: 0 })), ...Array.from({ length: 2 }, () => ({ home: 'x', away: 'y', hg: 1, ag: 1 })), ...Array.from({ length: 19 }, () => ({ home: 'x', away: 'y', hg: 0, ag: 1 }))];
  const xy = Fit.applySplit([team('x', 0, { pts: 29 + 3, played: 31 }), team('y', 0, { pts: 59, played: 31 })], [...pre, { home: 'x', away: 'y', hg: 1, ag: 0 }], split2);
  assert.deepEqual(xy.map(t => [t.id, t.pts, t.rounded, t.splitGroup]), [['x', 15 + 3, 1, 1], ['y', 30, 1, 0]]);
  // the tie rule: level on points after the halving, the team that was rounded up ranks below
  const tied = [team('odd', 0, { pts: 16, played: 31, splitGroup: 0, rounded: 1 }), team('even', 0, { pts: 16, played: 31, splitGroup: 0, rounded: 0 })];
  const tie = S.simulateSeason({ ...rules, zones: [], split: { after: 30, halve: 'up', groups: [{ from: 1, to: 2, rounds: 2 }] } }, tied, [], [], params('football', 50));
  assert.equal(tie.teams.find(t => t.id === 'even').pos[0], 1, 'the unrounded team first on a tie');
  // Austria's rounding down is the mirror: the team that lost the half point ranks above
  const down = S.simulateSeason({ ...rules, zones: [], split: { after: 22, halve: 'down', groups: [{ from: 1, to: 2, rounds: 2 }] } }, tied.map(t => ({ ...t })), [], [], params('football', 50));
  assert.equal(down.teams.find(t => t.id === 'odd').pos[0], 1, 'rounded down: the rounded team first on a tie');
});

test('A-League: top two wait out the elimination finals; NBL play-in 3–6; basketball group leagues without a title', () => {
  const teams = Array.from({ length: 12 }, (_, i) => team(`f${i}`, 0.4 - i * 0.07));
  const games = [];
  [...roundRobin(12), ...roundRobin(12)].forEach((rd, r) => rd.forEach(([h, a], k) => games.push({ id: `${r}-${k}`, home: teams[h].id, away: teams[a].id })));
  const out = S.simulateSeason(known(rulesFor('football', 'AF188')), teams, [], games, params('football'));
  checkSums(out, 'A-League');
  close(sum(out.teams.map(t => t.zones.playoffs)), 6, 1e-9, 'six in the finals');
  close(sum(out.teams.map(t => t.zones.final)), 2, 1e-9, 'two in the grand final');
  close(sum(out.teams.map(t => t.zones.title)), 1, 1e-9, 'one champion');
  close(sum(out.teams.map(t => t.zones.shield)), 1, 1e-9, 'one premier');
  // 1st and 2nd are in the semi-finals for sure: their grand-final chance beats 3rd–6th's at equal strength? the top
  // team at least reaches the final more often than the 6th
  assert.ok(out.teams[0].zones.final > out.teams[5].zones.final);

  const bteams = Array.from({ length: 10 }, (_, i) => team(`n${i}`, 6 - i * 1.3));
  const bgames = [];
  [...roundRobin(10), ...roundRobin(10)].forEach((rd, r) => rd.forEach(([h, a], k) => bgames.push({ id: `${r}-${k}`, home: bteams[h].id, away: bteams[a].id })));
  const nbl = S.simulateSeason(known(rulesFor('basketball', 'NBL')), bteams, [], bgames, params('basketball'));
  checkSums(nbl, 'NBL');
  close(sum(nbl.teams.map(t => t.zones.playoffs)), 4, 1e-9, 'four semi-finalists');
  close(sum(nbl.teams.map(t => t.zones.playin)), 4, 1e-9, 'four in the play-in (3rd–6th)');
  for (const t of nbl.teams) close(t.zones.playin, sum(t.pos.slice(2, 6)), 1e-9, `${t.id}: play-in = 3rd–6th`);

  // BCL: eight groups of four, the winner through, 2nd–3rd the play-ins, no title column
  const g4 = Array.from({ length: 32 }, (_, i) => team(`c${i}`, 4 - (i % 4) * 2, { group: `Group ${String.fromCharCode(65 + Math.floor(i / 4))}` }));
  const g4games = [];
  for (let g = 0; g < 8; g++) for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) if (x !== y) g4games.push({ id: `${g}${x}${y}`, home: g4[g * 4 + x].id, away: g4[g * 4 + y].id });
  const bcl = S.simulateSeason(known(rulesFor('basketball', 'BCL')), g4, [], g4games, params('basketball', 1000));
  checkSums(bcl, 'BCL');
  assert.deepEqual(bcl.zones, ['playoffs', 'playin']);
  close(sum(bcl.teams.map(t => t.zones.playoffs)), 8, 1e-9, 'eight group winners');
  close(sum(bcl.teams.map(t => t.zones.playin)), 16, 1e-9, 'sixteen in the play-ins');
  // relative places: BSL's last two go down whatever the size of the league
  const bsl = S.simulateSeason(known(rulesFor('basketball', 'BSL')), bteams, [], bgames, params('basketball', 1000));
  close(sum(bsl.teams.map(t => t.zones.relegation)), 2, 1e-9, 'the last two go down');
  for (const t of bsl.teams) close(t.zones.relegation, t.pos[8] + t.pos[9], 1e-9, `${t.id}: relegation = 9th–10th of 10`);
});

test('every new rule names its source and season; the new ones are gated; Belgium 2026-27 is one table again', () => {
  for (const [code, r] of [...Object.entries(FOOTBALL_RULES), ...Object.entries(BASKETBALL_RULES)]) {
    if (!r.gate) continue;
    assert.ok(r.source && r.season, `${code}: source and season`);
  }
  for (const code of ['AF253', 'AF262', 'AF128', 'AF197', 'AF72', 'AF99', 'AF292', 'AF188', 'AF255', 'AF183', 'AF184']) assert.ok(FOOTBALL_RULES[code]?.gate, `${code} gated`);
  for (const code of ['EC', 'BCL', 'BSL', 'GBL', 'LNB', 'ABA', 'LKL', 'NBL', 'CBA', 'NBB']) assert.ok(BASKETBALL_RULES[code]?.gate, `${code} gated`);
  assert.equal(FOOTBALL_RULES.AF144.split, undefined, 'Belgium: no split from 2026-27');
  // the replay scores a post-season league on its places, never on a drawn title
  assert.ok(!Fit.scoredZones(FOOTBALL_RULES.AF253).includes('title'));
  assert.ok(Fit.scoredZones(FOOTBALL_RULES.AF253).includes('playoffs'));
  assert.ok(!Fit.scoredZones(FOOTBALL_RULES.AF128).includes('relegation'), 'the annual table is not decided by one tournament');
});

/* ---------- service: Liga MX from our own fixture copy, the tournament split, the replay gate ---------- */

test('service: Liga MX — only the current tournament, position chances until the replay passes, then the zones', async () => {
  const { db } = require('../dist/db/index.js');
  require('../dist/services/tracking.js');
  require('../dist/services/apiFootball.js');
  require('../dist/services/basketball.js');
  require('../dist/services/nfl.js');
  const F = require('../dist/services/seasonForecast.js');
  const ins = db.prepare(`INSERT INTO sf_fixtures (fixture_id, league_id, season, round, kickoff, status, home_id, away_id, home_name, away_name, hg, ag, at) VALUES (?, 262, 2026, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = Date.now(), at = new Date().toISOString();
  let fid = 1;
  // the Clausura (Jan–May): played, a different table; then the Apertura (Jul–Dec): 10 of 17 rounds played
  roundRobin(18).forEach((rd, r) => rd.forEach(([h, a]) => {
    const ko = new Date(now - (250 - r * 7) * DAY).toISOString();
    ins.run(fid++, `Clausura - ${r + 1}`, ko, 'FT', 500 + h, 500 + a, `Club ${h}`, `Club ${a}`, 0, 3, at); // the away side always wins
  }));
  ins.run(fid++, 'Clausura - Quarter-finals', new Date(now - 120 * DAY).toISOString(), 'FT', 501, 502, 'Club 1', 'Club 2', 1, 0, at);
  roundRobin(18).forEach((rd, r) => rd.forEach(([h, a]) => {
    const ko = new Date(now + (r - 10) * 7 * DAY).toISOString(), past = r < 10;
    ins.run(fid++, `Apertura - ${r + 1}`, ko, past ? 'FT' : 'NS', 500 + h, 500 + a, `Club ${h}`, `Club ${a}`, past ? (h < a ? 2 : 0) : null, past ? (h < a ? 0 : 1) : null, at);
  }));
  assert.equal(await F.runSeasonForecast([{ sport: 'football', code: 'AF262' }], 'test'), 1, JSON.stringify(db.prepare('SELECT * FROM season_forecast_skips').all()));
  let lg = F.leagueForecast('football', 'AF262');
  assert.equal(lg.teams.length, 18);
  assert.equal(lg.season, '2026 Apertura');
  for (const t of lg.teams) assert.equal(t.now.played, 10, `${t.name}: Apertura games only`);
  assert.equal(lg.known, false, 'gated: no replay yet');
  assert.equal(lg.pending, 'replay');
  assert.deepEqual(lg.zones, []);
  const rules = F.seasonForecastChecks().find(c => c.id === 'season-forecast-rules');
  assert.ok(rules.items.some(x => /AF262.*format added, zones waiting/.test(x)), JSON.stringify(rules.items));
  // a replay that fails the check keeps it hidden; one that beats the table order opens the zones
  const put = (sim, base) => db.prepare(`INSERT OR REPLACE INTO season_forecast_accuracy (sport, code, season, json, at) VALUES ('football', 'AF262', '2025', ?, ?)`).run(JSON.stringify({ steps: 10, n: 200, sim: {}, base: {}, simAll: sim, baseAll: base, extremes: { hi: { n: 0, hits: 0 }, lo: { n: 0, hits: 0 } } }), at);
  put(0.2, 0.15);
  await F.runSeasonForecast([{ sport: 'football', code: 'AF262' }], 'test');
  assert.equal(F.leagueForecast('football', 'AF262').known, false);
  put(0.1, 0.15);
  await F.runSeasonForecast([{ sport: 'football', code: 'AF262' }], 'test');
  lg = F.leagueForecast('football', 'AF262');
  assert.equal(lg.known, true);
  assert.deepEqual(lg.zones, ['title', 'final', 'playoffs']);
  close(sum(lg.teams.map(t => t.zones.playoffs)), 8, 1e-3, 'eight in the Liguilla');
  for (const t of lg.teams) close(sum(t.pos), 1, 1e-3, `${t.name} positions`);
  // the favourite is one of the teams that won all ten games so far, not one that won the Clausura's away games
  assert.ok(lg.teams[0].now.pts === 30 && lg.teams[0].zones.title > 0.1, JSON.stringify(lg.teams[0]));
});

test('replay: the new formats replay a finished season (scored on places, beats the table order on a clear season)', () => {
  // a seeded "real" season: results from fixed strengths
  const rng = new S.Rng(99);
  const mk = (ids, pairs, start) => pairs.map(([h, a], k) => {
    const d = (strength.get(h) - strength.get(a)) + 0.2 + rng.normal();
    return { home: h, away: a, hg: d > 0.35 ? 2 : d < -0.35 ? 0 : 1, ag: d > 0.35 ? 0 : d < -0.35 ? 2 : 1, kickoff: new Date(start + Math.floor(k / (ids.length / 2)) * 7 * DAY).toISOString() };
  });
  const strength = new Map();
  // Liga MX: 18 teams, 17 rounds
  const mx = Array.from({ length: 18 }, (_, i) => `m${i}`); mx.forEach((id, i) => strength.set(id, 0.8 - i * 0.09));
  const mxPairs = roundRobin(18).flat().map(([h, a]) => [mx[h], mx[a]]);
  const base = { runs: 300, seed: 3, ...SIM_PARAMS.football };
  const mxOut = Fit.replayHere({ sport: 'football', code: 'AF262', name: 'Liga MX', season: '2025', rules: FOOTBALL_RULES.AF262, teams: mx.map(id => ({ id, name: id })), games: mk(mx, mxPairs, Date.parse('2026-01-10')), preds: [], base });
  assert.ok(mxOut.steps > 5 && mxOut.n > 0, JSON.stringify(mxOut));
  assert.deepEqual(Object.keys(mxOut.sim), ['playoffs']);
  // MLS: two conferences, a double round robin in each
  const E = Array.from({ length: 15 }, (_, i) => `e${i}`), W = Array.from({ length: 15 }, (_, i) => `w${i}`);
  [...E, ...W].forEach((id, k) => strength.set(id, 0.8 - (k % 15) * 0.1));
  const conf = Z => { const r = roundRobin(16).map(rd => rd.filter(([h, a]) => h < 15 && a < 15)); return [...r, ...r.map(rd => rd.map(([a, b]) => [b, a]))].flat().map(([h, a]) => [Z[h], Z[a]]); };
  const ep = conf(E), wp = conf(W), pairs = ep.flatMap((p, k) => [p, wp[k]]).filter(Boolean);
  const mlsOut = Fit.replayHere({ sport: 'football', code: 'AF253', name: 'MLS', season: '2025', rules: FOOTBALL_RULES.AF253,
    teams: [...E.map(id => ({ id, name: id, group: 'East' })), ...W.map(id => ({ id, name: id, group: 'West' }))], games: mk([...E, ...W], pairs, Date.parse('2025-03-01')), preds: [], base });
  assert.ok(mlsOut.steps > 10 && mlsOut.n > 0, JSON.stringify(mlsOut));
  assert.deepEqual(Object.keys(mlsOut.sim).sort(), ['playoffs', 'shield']);
  assert.ok(mlsOut.simAll < mlsOut.baseAll, `MLS replay: Brier ${mlsOut.simAll} vs table order ${mlsOut.baseAll}`);
});

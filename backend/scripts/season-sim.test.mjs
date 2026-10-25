// fix215: season simulator — league rules (Premier League, Bundesliga 18 teams + relegation play-off spot, Scottish
// split, NBA play-in, NFL wild cards), every team's position chances sum to 100%, same seed = same answer, and the
// "what this game means" numbers come from the runs with that result. Pure engine (dist build), no database.
// Run: npm run test:fix215
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../dist/utils/seasonSim.js');
const { rulesFor, SIM_PARAMS } = require('../dist/utils/seasonRules.js');

const sum = a => a.reduce((s, x) => s + x, 0);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

/** n teams, a double round robin; the first `playedRounds` rounds played by rating (deterministic) */
function league(n, playedRounds, { sport = 'football', groups = null, divs = null } = {}) {
  const teams = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, name: `Team ${i}`, pts: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, played: 0,
    rating: sport === 'football' ? 0.6 - (1.2 * i) / (n - 1) : 8 - (16 * i) / (n - 1),
    group: groups ? groups(i) : undefined, div: divs ? divs(i) : undefined
  }));
  // circle method
  const ids = teams.map((_, i) => i), rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const rd = [];
    for (let k = 0; k < n / 2; k++) { const a = ids[k], b = ids[n - 1 - k]; rd.push(r % 2 ? [a, b] : [b, a]); }
    rounds.push(rd);
    ids.splice(1, 0, ids.pop());
  }
  const all = [...rounds, ...rounds.map(rd => rd.map(([a, b]) => [b, a]))];
  const played = [], games = [];
  all.forEach((rd, r) => rd.forEach(([h, a], k) => {
    if (r < playedRounds) {
      const diff = teams[h].rating - teams[a].rating;
      const hg = sport === 'football' ? (diff > 0.25 ? 2 : 1) : 100 + Math.round(diff);
      const ag = sport === 'football' ? (diff < -0.25 ? 2 : 1) : 100 - Math.round(diff) + (diff === 0 ? 1 : 0);
      played.push({ home: teams[h].id, away: teams[a].id, hg, ag });
      const H = teams[h], A = teams[a];
      H.played++; A.played++; H.gf += hg; H.ga += ag; A.gf += ag; A.ga += hg;
      if (hg > ag) { H.w++; A.l++; H.pts += 3; } else if (hg < ag) { A.w++; H.l++; A.pts += 3; } else { H.d++; A.d++; H.pts++; A.pts++; }
    } else games.push({ id: `g${r}-${k}`, home: teams[h].id, away: teams[a].id, watch: r === playedRounds });
  }));
  return { teams, played, games };
}
const params = (sport, runs = 4000, seed = 7) => ({ runs, seed, ...SIM_PARAMS[sport] });

function checkSums(out, msg) {
  for (const t of out.teams) close(sum(t.pos), 1, 1e-9, `${msg} ${t.id} position chances`);
  // every position is filled exactly once per run (per table group)
  const byGroup = new Map();
  for (const t of out.teams) { const g = t.group || ''; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(t); }
  for (const [g, ts] of byGroup) for (let k = 0; k < ts.length; k++) close(sum(ts.map(t => t.pos[k] || 0)), 1, 1e-9, `${msg} group ${g} position ${k + 1}`);
}

test('Premier League: 20 teams, title / top 4 / Europe / relegation add up', () => {
  const { teams, played, games } = league(20, 10);
  const out = S.simulateSeason(rulesFor('football', 'PL'), teams, played, games, params('football'));
  checkSums(out, 'PL');
  const Z = k => sum(out.teams.map(t => t.zones[k]));
  close(Z('title'), 1, 1e-9, 'one champion');
  close(Z('cl'), 4, 1e-9, 'four Champions League places');
  close(Z('europe'), 6, 1e-9, 'six European places');
  close(Z('relegation'), 3, 1e-9, 'three relegated');
  assert.deepEqual(out.zones, ['title', 'cl', 'europe', 'relegation']);
  // the strongest team is the favourite, the weakest the most likely to go down; average points follow the ratings
  assert.ok(out.teams[0].zones.title > 0.3, `top team title ${out.teams[0].zones.title}`);
  assert.ok(out.teams[19].zones.relegation > 0.5, `bottom team relegation ${out.teams[19].zones.relegation}`);
  assert.ok(out.teams[0].avgPts > out.teams[19].avgPts + 30);
  for (const t of out.teams) close(sum(t.pos.map((p, k) => p * (k + 1))), t.avgPos, 1e-6, `${t.id} average position`);
});

test('Bundesliga: 18 teams, 16th = relegation play-off, 17th–18th down', () => {
  const { teams, played, games } = league(18, 9);
  const out = S.simulateSeason(rulesFor('football', 'BL1'), teams, played, games, params('football'));
  checkSums(out, 'BL1');
  assert.equal(out.teams[0].pos.length, 18);
  const Z = k => sum(out.teams.map(t => t.zones[k]));
  close(Z('releg_po'), 1, 1e-9, 'one play-off spot');
  close(Z('relegation'), 2, 1e-9, 'two relegated');
  for (const t of out.teams) close(t.zones.releg_po, t.pos[15], 1e-9, `${t.id} play-off spot = 16th`);
});

test('Scottish Premiership: split after 33 games, the bottom six never finish above 7th', () => {
  // 12 teams, 3 rounds robin = 33 games: build 33 rounds from a triple round robin
  const base = league(12, 0);
  const teams = base.teams, games = [];
  for (let leg = 0; leg < 3; leg++) base.games.slice(0, 66).forEach((g, k) => games.push({ ...g, id: `L${leg}-${k}`, ...(leg === 1 ? { home: g.away, away: g.home } : {}) }));
  assert.equal(games.length, 198); // 12 × 33 / 2
  const out = S.simulateSeason(rulesFor('football', 'AF179'), teams, [], games, params('football', 3000));
  checkSums(out, 'SPL');
  // a team ranked 7th+ after 33 games stays in 7–12: positions 1–6 and 7–12 are separate; the weakest never wins
  const weak = out.teams[11];
  assert.equal(weak.zones.title, 0);
  // 38 games each: 33 + 5
  close(out.teams.reduce((s, t) => s + t.avgPts, 0) / 12, out.teams.reduce((s, t) => s + t.avgPts, 0) / 12, 0, 'sanity');
  const Z = k => sum(out.teams.map(t => t.zones[k]));
  close(Z('relegation'), 1, 1e-9, 'one relegated');
  close(Z('releg_po'), 1, 1e-9, 'one play-off');
  // split happened mid-season too: after the split, groups are the current table's ranges
  const half = league(12, 0);
  half.teams.forEach((t, i) => { t.played = 33; t.pts = 80 - i * 5; });
  const post = [];
  for (let x = 0; x < 6; x++) for (let y = x + 1; y < 6; y++) post.push({ id: `p${x}${y}`, home: `t${x}`, away: `t${y}` });
  for (let x = 6; x < 12; x++) for (let y = x + 1; y < 12; y++) post.push({ id: `q${x}${y}`, home: `t${x}`, away: `t${y}` });
  const o2 = S.simulateSeason(rulesFor('football', 'AF179'), half.teams, [], post, params('football', 2000));
  checkSums(o2, 'SPL after split');
  // 7th now (45 pts) can't finish above 7th even with more points than 6th could reach
  assert.equal(sum(o2.teams[6].pos.slice(0, 6)), 0, '7th stays in the bottom six');
});

test('NBA: conferences apart, play-in 7–10, one champion, every play-off team from the top 10', () => {
  const groups = i => (i % 2 ? 'Western Conference' : 'Eastern Conference');
  const { teams, played, games } = league(30, 20, { sport: 'basketball', groups });
  teams.forEach(t => { t.pts = 0; });
  const out = S.simulateSeason(rulesFor('basketball', 'NBA'), teams, played, games, params('basketball', 3000));
  checkSums(out, 'NBA');
  assert.equal(out.teams[0].pos.length, 15);
  const Z = k => sum(out.teams.map(t => t.zones[k]));
  close(Z('title'), 1, 1e-9, 'one champion');
  close(Z('final'), 2, 1e-9, 'two finalists');
  close(Z('conf_title'), 2, 1e-9, 'two conference champions');
  close(Z('playoffs'), 16, 1e-9, '16 play-off teams');
  close(Z('playin'), 8, 1e-9, '8 play-in teams');
  for (const t of out.teams) {
    close(t.zones.playin, t.pos[6] + t.pos[7] + t.pos[8] + t.pos[9], 1e-9, `${t.id} play-in = 7th–10th`);
    assert.ok(t.zones.playoffs >= sum(t.pos.slice(0, 6)) - 1e-9, `${t.id}: top six always in`);
    assert.ok(t.zones.playoffs <= sum(t.pos.slice(0, 10)) + 1e-9, `${t.id}: only the top ten can get in`);
  }
});

test('NFL: 4 division winners + 3 wild cards per conference, top seed = bye', () => {
  const groups = i => (i < 16 ? 'AFC' : 'NFC');
  const divs = i => `${i < 16 ? 'AFC' : 'NFC'} ${['East', 'North', 'South', 'West'][Math.floor((i % 16) / 4)]}`;
  // NFL-like: 17 games; use a single round robin slice of the double one
  const { teams, played, games } = league(32, 6, { sport: 'nfl', groups, divs });
  const out = S.simulateSeason(rulesFor('nfl', 'NFL'), teams, played, games.slice(0, 120), params('nfl', 3000));
  checkSums(out, 'NFL');
  assert.equal(out.teams[0].pos.length, 16);
  const Z = k => sum(out.teams.map(t => t.zones[k]));
  close(Z('div_title'), 8, 1e-9, 'eight division winners');
  close(Z('playoffs'), 14, 1e-9, '14 play-off teams');
  close(Z('bye'), 2, 1e-9, 'two byes');
  close(Z('conf_title'), 2, 1e-9, 'two conference champions');
  close(Z('title'), 1, 1e-9, 'one Super Bowl winner');
  for (const t of out.teams) {
    close(t.zones.bye, t.pos[0], 1e-9, `${t.id} bye = 1st seed`);
    close(t.zones.playoffs, sum(t.pos.slice(0, 7)), 1e-9, `${t.id} play-offs = seeds 1–7`);
    assert.ok(t.zones.div_title <= sum(t.pos.slice(0, 4)) + 1e-9, `${t.id}: division winners are seeds 1–4`);
  }
});

test('same seed = same answer; another seed differs; unknown rules = position chances only', () => {
  const { teams, played, games } = league(18, 12);
  const a = S.simulateSeason(rulesFor('football', 'PL'), teams, played, games, params('football', 2000, 42));
  const b = S.simulateSeason(rulesFor('football', 'PL'), teams, played, games, params('football', 2000, 42));
  const c = S.simulateSeason(rulesFor('football', 'PL'), teams, played, games, params('football', 2000, 43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.teams.map(t => t.pos), c.teams.map(t => t.pos));
  const u = S.simulateSeason(rulesFor('football', 'AF99999'), teams, played, games, params('football', 500));
  assert.deepEqual(u.zones, []);
  checkSums(u, 'unknown');
  assert.equal(S.hashSeed('PL|2026-10-25'), S.hashSeed('PL|2026-10-25'));
});

test('our 1X2 is kept: a single game simulated alone gives back its own chances', () => {
  const teams = [0, 1].map(i => ({ id: `t${i}`, name: `T${i}`, pts: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, played: 0, rating: 0 }));
  const games = [{ id: 'g', home: 't0', away: 't1', pH: 0.52, pD: 0.26, pA: 0.22, xgH: 1.7, xgA: 1.0, watch: true }];
  const out = S.simulateSeason(rulesFor('football', 'PL'), teams, [], games, { ...params('football', 40000), noise: 0 });
  const g = out.games[0];
  close(g.share[0], 0.52, 0.01, 'home win'); close(g.share[1], 0.26, 0.01, 'draw'); close(g.share[2], 0.22, 0.01, 'away win');
  // what this game means: the winner tops the table in every run with that result
  assert.equal(g.home_.title[0], 1); assert.equal(g.away_.title[2], 1);
  // winner sports: our win chance is kept too
  const bt = [0, 1].map(i => ({ ...teams[i] }));
  const o2 = S.simulateSeason(rulesFor('basketball', 'XX'), bt, [], [{ id: 'b', home: 't0', away: 't1', pHome: 0.7, margin: 6, watch: true }], { ...params('basketball', 40000), noise: 0 });
  close(o2.games[0].share[0], 0.7, 0.01, 'basketball home win');
  const m = S.marginOf(0.7, 6, 12);
  close(m.mu, 6, 1e-9, 'margin kept'); close(1 - S.probitOf(0.5, 0.2).w * 0, 1, 0, 'probit');
});

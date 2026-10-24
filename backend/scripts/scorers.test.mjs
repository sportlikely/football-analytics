// fix209: scorers under the score — the rules and the "Scorers shown" guard (dist build, scratch databases, made-up
// provider answers). Run: npm run test:fix209
//  - which side a goal counts for (own goals in both provider conventions, the running score), named goals per side
//  - Football-Data.org's goal list replaced by API-Football's only when that one names more of the score
//  - football: a game whose score has more goals than named events is listed after 10 min (not before), its events
//    are fetched again and kept, the match page gets them laid over (overlay), and the line clears when they match
//  - basketball: a box score without a team's top scorer is listed after 10 min and queued for a new box score
//  - NFL: a side with points and no scoring play is listed after 10 min and its plays are fetched again
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '../dist').replace(/\\/g, '/');
const KEYS = ['FOOTBALL_DATA_API_KEY', 'ODDS_API_KEY', 'API_FOOTBALL_KEY', 'API_NFL_KEY', 'API_BASKETBALL_KEY', 'TENNIS_API_KEY', 'BALLDONTLIE_KEY', 'YOUTUBE_API_KEY', 'ANTHROPIC_API_KEY'];
const PRELUDE = `const D = ${JSON.stringify(DIST)};
const done = x => { console.log(JSON.stringify(x === undefined ? null : x)); process.exit(0); };
const calls = [];
let FAKE = () => ({ response: [] });
globalThis.fetch = async url => {
  const u = new URL(String(url));
  calls.push(u.pathname + u.search);
  const body = FAKE(u);
  return { ok: true, status: 200, headers: { get: h => (h === 'x-ratelimit-requests-remaining' ? '5000' : h === 'x-ratelimit-requests-limit' ? '7500' : null) }, json: async () => body };
};
const iso = ms => new Date(ms).toISOString();
const MIN = 60e3;
`;

function child(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix209-'));
  const e = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...env };
  for (const k of KEYS) if (!(k in env)) e[k] = '';
  delete e.SL_ROLE;
  const r = spawnSync(process.execPath, ['-e', PRELUDE + code], { env: e, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('rules: goal sides, own goals both ways, running score, better goal list', () => {
  const r = child(`
    const s = require(D + '/utils/scorers.js');
    const g = (minute, type, team, name, score) => ({ minute, type, team: { id: team }, scorer: { id: minute, name }, ...(score ? { score } : {}) });
    const m = (goals, h, a) => ({ homeTeam: { id: 1 }, awayTeam: { id: 2 }, score: { fullTime: { home: h, away: a } }, goals });
    done({
      plain: s.goalSides([g(5, 'REGULAR', 1, 'A'), g(9, 'REGULAR', 2, 'B')], 1, 2, { home: 1, away: 1 }),
      ogPlayersTeam: s.goalSides([g(5, 'REGULAR', 1, 'A'), g(70, 'OWN', 1, 'D')], 1, 2, { home: 1, away: 1 }),
      ogBeneficiary: s.goalSides([g(5, 'REGULAR', 1, 'A'), g(70, 'OWN', 2, 'D')], 1, 2, { home: 1, away: 1 }),
      running: s.goalSides([g(5, 'OWN', 1, 'X', { home: 0, away: 1 }), g(9, 'REGULAR', 1, 'Y', { home: 1, away: 1 })], 1, 2, { home: 1, away: 1 }),
      gapShort: s.footballGap(m([g(6, 'REGULAR', 1, 'Jackson'), g(52, 'REGULAR', 2, 'Haaland')], 2, 1)),
      gapUnnamed: s.footballGap(m([g(6, 'REGULAR', 1, 'Jackson'), g(60, 'REGULAR', 1, '?'), g(52, 'REGULAR', 2, 'Haaland')], 2, 1)),
      gapOk: s.footballGap(m([g(6, 'REGULAR', 1, 'Jackson'), g(60, 'REGULAR', 1, 'Jackson'), g(52, 'REGULAR', 2, 'Haaland')], 2, 1)),
      better: s.betterGoals(m([g(6, 'REGULAR', 1, 'Jackson')], 2, 1), [g(6, 'REGULAR', 1, 'Jackson'), g(60, 'REGULAR', 1, 'Jackson'), g(52, 'REGULAR', 2, 'Haaland')]).length,
      notWorse: s.betterGoals(m([g(6, 'REGULAR', 1, 'Jackson'), g(60, 'REGULAR', 1, 'Jackson'), g(52, 'REGULAR', 2, 'Haaland')], 2, 1), [g(6, 'REGULAR', 1, 'Jackson')]).length,
      bb: s.bbTopGap([{ team_id: 10, name: 'Haliburton', pts: 28 }, { team_id: 20, name: '', pts: 30 }], 10, 20),
      bbNone: s.bbTopGap([], 10, 20),
      nfl: s.nflPlaysGap([{ team: 1 }], { home: 7, away: 3 }, 1, 2),
      nflZero: s.nflPlaysGap([], { home: 0, away: 0 }, 1, 2)
    });`);
  assert.deepEqual(r.plain, ['home', 'away']);
  assert.deepEqual(r.ogPlayersTeam, ['home', 'away'], 'own goal by a home player (team = his team) counts for the away side');
  assert.deepEqual(r.ogBeneficiary, ['home', 'away'], 'own goal listed under the team that got it');
  assert.deepEqual(r.running, ['away', 'home']);
  assert.deepEqual(r.gapShort, { score: { home: 2, away: 1 }, named: { home: 1, away: 1 }, ok: false });
  assert.equal(r.gapUnnamed.ok, false, 'a goal without a name ("?") is not a named goal');
  assert.equal(r.gapOk.ok, true);
  assert.equal(r.better, 3);
  assert.equal(r.notWorse, 3, 'a shorter list never replaces a complete one');
  assert.deepEqual(r.bb, ['away']);
  assert.deepEqual(r.bbNone, [], 'no box score yet: nothing to show, nothing listed');
  assert.deepEqual(r.nfl, ['away']);
  assert.deepEqual(r.nflZero, []);
});

test('football: listed after 10 min, fetched again, laid over the match page, cleared when the names come in', () => {
  const r = child(`
    const { db } = require(D + '/db/index.js');
    const sc = require(D + '/services/scorersCheck.js');
    const { AF_OFFSET } = require(D + '/services/afMatches.js');
    const now = Date.now();
    const id = AF_OFFSET + 777;
    db.prepare(\`INSERT INTO predictions (match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team, p_home, p_draw, p_away, created_at, updated_at)
      VALUES (?, 'grid-v3', 'AF39', 'Premier League', ?, ?, 'Aston Villa', ?, 'Man City', 40, 25, 35, ?, ?)\`).run(id, iso(now - 3 * 3600e3), AF_OFFSET + 66, AF_OFFSET + 50, iso(now), iso(now));
    db.prepare(\`INSERT INTO results (match_id, status, home_goals, away_goals, outcome, settled_at) VALUES (?, 'FINISHED', 2, 1, 'H', ?)\`).run(id, iso(now));
    const ev = (min, team, name, detail = 'Normal Goal') => ({ time: { elapsed: min, extra: null }, team: { id: team, name: '' }, player: { id: min, name }, assist: {}, type: 'Goal', detail });
    let events = [ev(6, 66, 'N. Jackson'), ev(52, 50, 'E. Haaland', 'Penalty')]; // the 60' goal not named yet
    FAKE = u => u.pathname.endsWith('/fixtures') && u.searchParams.get('ids') ? { response: [{ fixture: { id: 777, date: iso(now - 3 * 3600e3), status: { short: 'FT', elapsed: 90 } }, league: { id: 39, name: 'Premier League', season: 2026, round: 'Regular Season - 9' },
      teams: { home: { id: 66, name: 'Aston Villa' }, away: { id: 50, name: 'Man City' } }, goals: { home: 2, away: 1 }, score: { halftime: { home: 1, away: 0 } }, events }] } : { response: [] };
    (async () => {
      await sc.scorersCheckTick(now);
      const first = sc.scorersHealth(now);
      await sc.scorersCheckTick(now + 11 * MIN);
      const late = sc.scorersHealth(now + 11 * MIN);
      const fetches = calls.filter(c => c.includes('ids=777')).length;
      // the provider names the goal: the next run clears the line, and the page gets the full list laid over it
      events = [...events, ev(60, 66, 'N. Jackson')];
      await sc.scorersCheckTick(now + 16 * MIN);
      const fixed = sc.scorersHealth(now + 16 * MIN);
      const page = sc.goalEventsOverlay({ id, homeTeam: { id: AF_OFFSET + 66 }, awayTeam: { id: AF_OFFSET + 50 }, score: { fullTime: { home: 2, away: 1 } }, goals: [] });
      // and a finished game already checked fine is not fetched again
      const before = calls.length;
      await sc.scorersCheckTick(now + 21 * MIN);
      done({ first, late, fetches, fixed, overlay: page.goals.map(g => g.scorer.name + ' ' + g.minute), again: calls.length - before, complete: sc.scorersComplete({ ...page }) });
    })();`, { API_FOOTBALL_KEY: 'test' });
  assert.equal(r.first.checked, 1);
  assert.deepEqual(r.first.late, [], 'a fresh mismatch is not listed (the provider names scorers a minute or two late)');
  assert.equal(r.late.late.length, 1);
  assert.match(r.late.late[0], /^Football Aston Villa – Man City \(1000000777\) · score 2-1 · named 1-1 · 11 min · fetched again$/);
  assert.ok(r.fetches >= 2, 'the events were fetched again');
  assert.deepEqual(r.fixed.late, []);
  assert.deepEqual(r.overlay, ['N. Jackson 6', 'E. Haaland 52', 'N. Jackson 60']);
  assert.equal(r.again, 0);
  assert.equal(r.complete, true);
});

test('basketball and NFL: a missing top scorer / scoring play is listed after 10 min and fetched again', () => {
  const r = child(`
    const { db } = require(D + '/db/index.js');
    require(D + '/services/basketball.js');
    require(D + '/services/nfl.js');
    const sc = require(D + '/services/scorersCheck.js');
    const now = Date.now();
    db.prepare(\`INSERT INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, stats, updated_at)
      VALUES (1, 'NBA', 12, '2026-2027', ?, 'FT', 10, 'Pacers', 20, 'Mavericks', 112, 108, 1, ?)\`).run(iso(now - 4 * 3600e3), iso(now));
    const put = db.prepare(\`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes, pts) VALUES (1, ?, ?, ?, 1, 30, ?)\`);
    put.run(10, 101, 'Tyrese Haliburton', 28); put.run(20, 201, '', 0); // the away side came without names / points
    db.prepare(\`INSERT INTO nfl_games (game_id, season, kickoff, home_id, home_name, away_id, away_name, status, home_pts, away_pts, league, updated_at)
      VALUES (5, 2026, ?, 1, 'Chiefs', 2, 'Bills', 'FT', 24, 20, 1, ?)\`).run(iso(now - 5 * 3600e3), iso(now));
    FAKE = u => u.pathname.endsWith('/games/events') ? { response: [{ quarter: 'Q2', minute: '12', team: { id: 1, name: 'Chiefs' }, player: { id: 21, name: 'Travis Kelce' }, type: 'Touchdown', score: { home: 7, away: 0 } }, { quarter: 'Q3', minute: '03', team: { id: 2, name: 'Bills' }, player: { id: 22, name: 'Tyler Bass' }, type: 'Field Goal', score: { home: 7, away: 3 } }] } : { response: [] };
    (async () => {
      await sc.scorersCheckTick(now);
      const first = sc.scorersHealth(now);
      await sc.scorersCheckTick(now + 11 * MIN);
      const late = sc.scorersHealth(now + 11 * MIN);
      const bbQueued = db.prepare('SELECT stats FROM bb_games WHERE game_id = 1').get().stats;
      const nflFetched = calls.filter(c => c.includes('/games/events')).length;
      db.prepare("UPDATE bb_player_stats SET name = 'Luka Doncic', pts = 31 WHERE player_id = 201").run();
      await sc.scorersCheckTick(now + 16 * MIN);
      done({ first, late, bbQueued, nflFetched, fixed: sc.scorersHealth(now + 16 * MIN) });
    })();`, { API_NFL_KEY: 'test' });
  assert.equal(r.first.late.length, 0);
  assert.equal(r.late.late.length, 2);
  assert.ok(r.late.late.some(x => /^Basketball NBA Pacers – Mavericks \(1\) · score 112-108 · missing: away · 11 min/.test(x)), r.late.late.join('\n'));
  assert.ok(r.late.late.some(x => /^American football NFL Chiefs – Bills \(5\) · score 24-20 · missing: home, away · 11 min · fetched again/.test(x)), r.late.late.join('\n'));
  assert.equal(r.bbQueued, 0, 'the box score is queued again (stats = 0)');
  assert.equal(r.nflFetched, 1);
  assert.deepEqual(r.fixed.late, []);
});

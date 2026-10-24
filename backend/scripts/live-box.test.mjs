// fix208: live box scores (dist build, scratch databases, made-up provider answers). Run: npm run test:fix208
//  - which games are fetched (watched 60 s, NBA / EuroLeague / NFL 3 min, other leagues only while watched), budget
//  - live rows replaced by the final rows, nothing counted twice; a missing final keeps the live rows
//  - the "box" message: once per stored game; a tick with nothing due sends none and makes no call
//  - a tick is skipped when the day's quota is near its reserve
//  - NFL: live player lines, replaced by the final box score
//  - data health: a big-league live game without a box-score update in 5 min is listed
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
// every child gets D (dist), done(x), and a fake provider: fetch answers from FAKE(url) and counts the calls
const PRELUDE = `const D = ${JSON.stringify(DIST)};
const done = x => { console.log(JSON.stringify(x === undefined ? null : x)); process.exit(0); };
const calls = [];
let REMAINING = '5000';
let FAKE = () => ({ response: [] });
globalThis.fetch = async url => {
  const u = new URL(String(url));
  calls.push(u.pathname + u.search);
  const body = FAKE(u);
  return { ok: true, status: 200, headers: { get: h => (h === 'x-ratelimit-requests-remaining' ? REMAINING : h === 'x-ratelimit-requests-limit' ? '7500' : null) }, json: async () => body };
};
const iso = ms => new Date(ms).toISOString();
`;

function child(code, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix208-'));
  const e = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', ...env };
  for (const k of KEYS) if (!(k in env)) e[k] = '';
  delete e.SL_ROLE; // one process: the job and the listeners in place
  const r = spawnSync(process.execPath, ['-e', PRELUDE + code], { env: e, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

// a basketball game row and the provider's box-score answers for it
const BB_SETUP = `
const { db } = require(D + '/db/index.js');
const bb = require(D + '/services/basketball.js');
const views = require(D + '/services/gameViews.js');
const addGame = (id, code, status, kickoffMs, hs = 50, as_ = 48) => db.prepare(\`INSERT OR REPLACE INTO bb_games (game_id, code, league_id, season, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at)
  VALUES (?, ?, 1, '2026-2027', ?, ?, 10, 'Pacers', 20, 'Mavericks', ?, ?, ?)\`).run(id, code, iso(kickoffMs), status, hs, as_, iso(Date.now()));
const teamRow = (gid, tid) => ({ game: { id: gid }, team: { id: tid }, field_goals: { total: 20, attempts: 40 }, threepoint_goals: { total: 3, attempts: 9 }, freethrows_goals: { total: 1, attempts: 2 }, rebounds: { total: 22 }, assists: 11 });
const playerRow = (gid, tid, pid, name, pts, min, starter) => ({ game: { id: gid }, team: { id: tid }, player: { id: pid, name }, type: starter ? 'starters' : 'bench', minutes: min, points: pts, field_goals: { total: 5, attempts: 9 }, threepoint_goals: { total: 1, attempts: 3 }, freethrows_goals: { total: 2, attempts: 2 }, rebounds: { total: 4 }, assists: 3 });
const box = (gids, players) => u => {
  const ids = (u.searchParams.get('ids') || '').split('-').map(Number).filter(id => gids.includes(id));
  if (u.pathname.endsWith('/teams')) return { response: ids.flatMap(g => [teamRow(g, 10), teamRow(g, 20)]) };
  if (u.pathname.endsWith('/players')) return { response: ids.flatMap(g => players(g)) };
  return { response: [] };
};
const count = (table, gid) => db.prepare(\`SELECT COUNT(*) AS n FROM \${table} WHERE game_id = ?\`).get(gid).n;
const sent = [];
views.onBox((sport, id) => sent.push(sport + ':' + id));
`;

test('which games are due: watched 60 s, big leagues 3 min, others only while watched; the quota reserve', () => {
  const r = child(`
    const lb = require(D + '/utils/liveBox.js');
    const now = 10_000_000;
    const games = [
      { id: 1, major: true, lastAt: null },             // NBA, never fetched: due
      { id: 2, major: true, lastAt: now - 60_000 },     // NBA, 1 min ago, not watched: not yet (3 min)
      { id: 3, major: false, lastAt: null },            // other league, nobody watching: never
      { id: 4, major: false, lastAt: now - 58_000 },    // other league, watched, 58 s ago: due (5 s slack)
      { id: 5, major: true, lastAt: now - 3 * 60_000 }  // NBA, 3 min ago: due
    ];
    const views = new Map([[4, now - 30_000], [3, now - 6 * 60_000]]); // game 3 was watched 6 min ago: too long
    done({
      due: lb.dueGames(games, views, now),
      okUnknown: lb.budgetAllows(null, null, 10), ok: lb.budgetAllows(5000, 7500, 2), low: lb.budgetAllows(301, 7500, 2), bigPlan: lb.budgetAllows(10000, 150000, 2),
      order: lb.boxOrder([{ name: 'A', starter: false, minutes: 0, points: 0 }, { name: 'B', starter: true, minutes: 20, points: 8 }, { name: 'C', starter: false, minutes: 12, points: 14 }, { name: 'D', starter: true, minutes: 22, points: 18 }]),
      top: lb.topScorer([{ name: 'B', points: 8 }, { name: 'D', points: 18 }]).name, none: lb.topScorer([{ name: 'X', points: 0 }])
    });`);
  assert.deepEqual(r.due, [4, 1, 5]); // watched first
  assert.equal(r.okUnknown, true);
  assert.equal(r.ok, true);
  assert.equal(r.low, false, '301 left of 7,500: the 300 reserve stays for the live scores');
  assert.equal(r.bigPlan, false, '10% of a 150,000 plan is the reserve');
  assert.deepEqual(r.order.played.map(p => p.name), ['D', 'B', 'C']);
  assert.deepEqual(r.order.bench.map(p => p.name), ['A']);
  assert.equal(r.top, 'D');
  assert.equal(r.none, null);
});

test('basketball: live rows replaced by the final rows, no duplicates; a missing final keeps the live rows', () => {
  const r = child(BB_SETUP + `
    const now = Date.now();
    addGame(1, 'NBA', 'Q3', now - 3600e3);
    const p = g => [playerRow(g, 10, 101, 'Tyrese Haliburton', 18, '24:10', true), playerRow(g, 10, 102, 'Pascal Siakam', 12, '22:00', true), playerRow(g, 20, 201, 'Luka Doncic', 25, '25:00', true)];
    bb.storeBoxRows([1], [teamRow(1, 10), teamRow(1, 20)], p(1), true);
    // second fetch: a player the provider dropped must go
    bb.storeBoxRows([1], [teamRow(1, 10), teamRow(1, 20)], p(1).slice(0, 2).concat([playerRow(1, 20, 201, 'Luka Doncic', 27, '27:00', true)]), true);
    const live = { players: count('bb_player_stats_live', 1), teams: count('bb_team_stats_live', 1), luka: db.prepare('SELECT pts FROM bb_player_stats_live WHERE player_id = 201').get().pts };
    // the final whistle, but the provider has nothing yet: the live rows stay (the 30-minute pass asks again)
    db.prepare("UPDATE bb_games SET status = 'FT' WHERE game_id = 1").run();
    bb.storeBoxRows([1], [], [], false, { markMissing: false });
    const waiting = { live: count('bb_player_stats_live', 1), stats: db.prepare('SELECT stats FROM bb_games WHERE game_id = 1').get().stats };
    bb.storeBoxRows([1], [teamRow(1, 10), teamRow(1, 20)], p(1), false);
    done({ live, waiting,
      final: { players: count('bb_player_stats', 1), teams: count('bb_team_stats', 1), live: count('bb_player_stats_live', 1), liveTeams: count('bb_team_stats_live', 1), stats: db.prepare('SELECT stats FROM bb_games WHERE game_id = 1').get().stats } });`);
  assert.deepEqual(r.live, { players: 3, teams: 2, luka: 27 });
  assert.deepEqual(r.waiting, { live: 3, stats: 0 });
  assert.deepEqual(r.final, { players: 3, teams: 2, live: 0, liveTeams: 0, stats: 1 });
});

test('basketball job: one box message per stored game, none when nothing is due; the final fetch after the buzzer', () => {
  const r = child(BB_SETUP + `
    (async () => {
      const now = Date.now();
      addGame(1, 'NBA', 'Q2', now - 1800e3);   // big league: every 3 min
      addGame(2, 'ACB', 'Q2', now - 1800e3);   // other league, watched: every 60 s
      addGame(3, 'ACB', 'Q2', now - 1800e3);   // other league, nobody watching: never
      views.noteGameView('bb', 2);
      const players = g => [playerRow(g, 10, g * 100 + 1, 'Home Star', 20, '20:00', true), playerRow(g, 20, g * 100 + 2, 'Away Star', 15, '20:00', true)];
      FAKE = box([1, 2, 3], players);
      const first = await bb.bbLiveBoxTick();
      const afterFirst = { sent: [...sent], calls: calls.length, asked: calls.map(c => decodeURIComponent(c)) };
      const second = await bb.bbLiveBoxTick(); // nothing due yet
      const afterSecond = { sent: sent.length, calls: calls.length };
      // game 1 ends: the next tick fetches its final box score (and game 2 is due again 65 s later)
      db.prepare("UPDATE bb_games SET status = 'FT' WHERE game_id = 1").run();
      await bb.bbLiveBoxTick(Date.now() + 65e3);
      done({ first, afterFirst, second, afterSecond, third: sent.slice(afterSecond.sent), final: { players: count('bb_player_stats', 1), live: count('bb_player_stats_live', 1) }, untouched: count('bb_player_stats_live', 3), status: bb.bbLiveBoxStatus() });
    })();`, { API_BASKETBALL_KEY: 'test' });
  assert.equal(r.first, 2);
  assert.deepEqual(r.afterFirst.sent.sort(), ['bb:1', 'bb:2']);
  assert.equal(r.afterFirst.calls, 2, 'one teams + one players request for both games');
  assert.ok(r.afterFirst.asked.every(c => /ids=2-1|ids=1-2/.test(c)), r.afterFirst.asked.join(' '));
  assert.equal(r.second, 0);
  assert.deepEqual(r.afterSecond, { sent: 2, calls: 2 }, 'nothing due: no call, no message');
  assert.deepEqual(r.third.sort(), ['bb:1', 'bb:2']);
  assert.deepEqual(r.final, { players: 2, live: 0 });
  assert.equal(r.untouched, 0, 'an unwatched game of another league is never fetched');
});

test('basketball job: skipped when the quota left is near the reserve', () => {
  const r = child(BB_SETUP + `
    (async () => {
      addGame(1, 'NBA', 'Q1', Date.now() - 600e3);
      FAKE = box([1], g => [playerRow(g, 10, 1, 'A B', 2, '3:00', true)]);
      REMAINING = '305'; // the first answer tells us 305 are left
      await bb.bbLiveBoxTick();
      const n = calls.length;
      db.prepare('UPDATE bb_player_stats_live SET updated_at = ?').run(Date.now() - 10 * 60e3); // due again
      const again = await bb.bbLiveBoxTick();
      done({ n, after: calls.length, again, skipped: bb.bbLiveBoxStatus().skippedBudget, sent: sent.length });
    })();`, { API_BASKETBALL_KEY: 'test' });
  assert.equal(r.n, 2);
  assert.equal(r.after, 2, 'no call once the quota left is under the reserve');
  assert.equal(r.again, 0);
  assert.equal(r.skipped, 1);
  assert.equal(r.sent, 1);
});

test('NFL: live player lines every tick they are due, replaced by the final box score', () => {
  const r = child(`
    const { db } = require(D + '/db/index.js');
    const nfl = require(D + '/services/nfl.js');
    const views = require(D + '/services/gameViews.js');
    const sent = [];
    views.onBox((sport, id) => sent.push(sport + ':' + id));
    const now = Date.now();
    const add = (id, league) => db.prepare(\`INSERT INTO nfl_games (game_id, season, kickoff, home_id, home_name, away_id, away_name, status, updated_at, league) VALUES (?, 2026, ?, 1, 'Chiefs', 2, 'Bills', 'Q2', ?, ?)\`).run(id, iso(now - 3600e3), iso(now), league);
    add(7, 1); add(8, 2); // NFL (every 3 min) and a college game nobody watches (never)
    const groups = [{ name: 'Passing', players: [{ player: { id: 55, name: 'Patrick Mahomes' }, statistics: [{ name: 'yards', value: '180' }] }] }];
    FAKE = u => (u.pathname.endsWith('/games/statistics/players') ? { response: [{ team: { id: 1 }, groups }, { team: { id: 2 }, groups: [] }] } : u.pathname.endsWith('/games/statistics/teams') ? { response: [{ team: { id: 1 }, statistics: {} }, { team: { id: 2 }, statistics: {} }] } : { response: [] });
    (async () => {
      const n = await nfl.nflLiveBoxTick();
      const live = db.prepare('SELECT COUNT(*) AS n FROM nfl_player_stats_live WHERE game_id = 7').get().n;
      const college = db.prepare('SELECT COUNT(*) AS n FROM nfl_player_stats_live WHERE game_id = 8').get().n;
      const asked = calls.length;
      db.prepare("UPDATE nfl_games SET status = 'FT' WHERE game_id = 7").run();
      await nfl.syncBoxScore(7);
      done({ n, live, college, asked, sent, final: db.prepare('SELECT COUNT(*) AS n FROM nfl_player_stats WHERE game_id = 7').get().n, after: db.prepare('SELECT COUNT(*) AS n FROM nfl_player_stats_live WHERE game_id = 7').get().n });
    })();`, { API_NFL_KEY: 'test' });
  assert.equal(r.n, 1);
  assert.equal(r.live, 2);
  assert.equal(r.college, 0);
  assert.equal(r.asked, 1, 'one call per due game');
  assert.deepEqual(r.sent, ['nfl:7']);
  assert.equal(r.final, 2);
  assert.equal(r.after, 0, 'the final box score replaced the live lines');
});

test('web + worker: a page view reaches the worker, its box message reaches the web process once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix208-ipc-'));
  const workerFile = path.join(dir, 'worker.cjs');
  // the worker: once it hears that game 5 is open, it stores "a box score" for it (one message)
  fs.writeFileSync(workerFile, `const D = ${JSON.stringify(DIST)};
const views = require(D + '/services/gameViews.js');
const iv = setInterval(() => { if (views.gameViews('bb').has(5)) { clearInterval(iv); views.boxUpdated('bb', 5); } }, 20);
process.on('disconnect', () => process.exit(0));`);
  const e = { ...process.env, DATA_DIR: dir, LOG_LEVEL: 'error', NODE_ENV: 'production', GEO_OFF: '1', SL_ROLE: 'web' };
  for (const k of KEYS) e[k] = '';
  const code = `const D = ${JSON.stringify(DIST)};
const { fork } = require('node:child_process');
const ipc = require(D + '/services/ipc.js');
const views = require(D + '/services/gameViews.js');
const got = [];
views.onBox((sport, id) => got.push(sport + ':' + id));
const w = fork(${JSON.stringify(workerFile)}, [], { env: { ...process.env, SL_ROLE: 'worker' } });
ipc.attachWorker(w);
w.on('spawn', () => { views.noteGameView('bb', 5); views.noteGameView('bb', 5); }); // twice: sent once (30 s throttle)
setTimeout(() => { console.log(JSON.stringify(got)); w.kill(); process.exit(0); }, 1500);`;
  const r = spawnSync(process.execPath, ['-e', code], { env: e, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['bb:5']);
});

test('data health: a big-league live game without a box-score update in 5 minutes is listed', () => {
  const r = child(BB_SETUP + `
    const dh = require(D + '/services/dataHealth.js');
    const now = Date.now();
    addGame(1, 'NBA', 'Q2', now - 30 * 60e3);
    addGame(2, 'ACB', 'Q2', now - 30 * 60e3); // other leagues are not tracked
    addGame(3, 'EL', 'Q1', now - 3 * 60e3);   // just started: not late yet
    const before = dh.liveBoxCheck(now);
    bb.storeBoxRows([1], [teamRow(1, 10)], [playerRow(1, 10, 1, 'A B', 2, '3:00', true)], true, { now: now - 60e3 });
    const after = dh.liveBoxCheck(now);
    const stale = dh.liveBoxCheck(now + 6 * 60e3);
    done({ before, after, stale });`);
  assert.equal(r.before.tracked, 1);
  assert.equal(r.before.late.length, 1);
  assert.match(r.before.late[0], /NBA Pacers – Mavericks \(1\): no box score yet/);
  assert.deepEqual(r.after, { tracked: 1, late: [] });
  // 6 minutes on: the NBA game's update is 7 min old, and the EuroLeague game has now run 9 min without one
  assert.equal(r.stale.tracked, 2);
  assert.match(r.stale.late.find(x => x.startsWith('NBA')), /last update 7 min ago/);
  assert.match(r.stale.late.find(x => x.startsWith('EL')), /no box score yet/);
});

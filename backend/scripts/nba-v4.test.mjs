// fix217: NBA model v4 — ridge fit on a fixture (true player ratings recovered), the injury reallocation keeps 240
// minutes, the re-pricing checkpoints (90 / 30 / 10 min), no tuning on 2025-26 / 2026-27, no look-ahead in the replay,
// and the live path on a scratch database (an injured starter is removed and moves the prediction). (dist build)
// Run: npm run test:fix217
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix217-nba-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
process.env.THREAD_JOBS = '0';
const require = createRequire(import.meta.url);
const I = require('../dist/utils/nbaImpact.js');
const { db } = require('../dist/db/index.js');
require('../dist/services/basketball.js');
const V = require('../dist/services/nbaV4.js');
const { nbaKey } = require('../dist/services/bbInjuries.js');

/** seeded random numbers (mulberry32) */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** a letters-only name per player id (name keys keep letters only) */
const nm = id => String(id).split('').map(d => 'abcdefghij'[+d]).join('');
const gauss = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

/** The fixture: 8 teams × 10 players with true ratings, 2 seasons of round-robin games, margins = Σ rating × min/48 + 2 home + noise. */
function fixture(seed = 7) {
  const r = rng(seed);
  const teams = Array.from({ length: 8 }, (_, t) => ({ id: 100 + t, name: `Test City T${t}`, players: Array.from({ length: 10 }, (_, k) => ({ id: 1000 + t * 10 + k, rating: Math.round(gauss(r) * 30) / 10, min: [36, 34, 32, 30, 28, 22, 20, 16, 12, 10][k] })) }));
  const games = [], lines = [];
  let id = 1, day = Date.parse('2024-10-22T23:00:00Z');
  for (const season of ['2024-2025', '2025-2026']) {
    if (season === '2025-2026') day = Date.parse('2025-10-21T23:00:00Z');
    for (let rep = 0; rep < 6; rep++) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      if (i === j || (rep + i + j) % 2) continue;
      const h = teams[i], a = teams[j];
      const side = tm => tm.players.reduce((s, p) => s + (p.rating * p.min) / 48, 0);
      const margin = Math.round(side(h) - side(a) + 2 + gauss(r) * 6);
      const hs = 110 + Math.max(margin, 0) + (margin === 0 ? 1 : 0), as_ = 110 - Math.min(margin, 0);
      games.push({ id, season, ms: day, home: h.id, away: a.id, hs, as_, finished: true, pre: false, rs: true });
      // players rest now and then and their minutes move (else only team totals could be told apart)
      const played = tm => tm.players.filter(() => r() > 0.12).map(p => ({ ...p, m: Math.max(4, p.min + gauss(r) * 5) }));
      const ph = played(h), pa = played(a);
      const sideOf = l => { const tot = l.reduce((s, p) => s + p.m, 0); return l.reduce((s, p) => s + (p.rating * p.m * 240) / tot / 48, 0); };
      const mg = Math.round(sideOf(ph) - sideOf(pa) + 2 + gauss(r) * 6);
      const hs2 = 110 + Math.max(mg, 0) + (mg === 0 ? 1 : 0), as2 = 110 - Math.min(mg, 0);
      games[games.length - 1].hs = hs2; games[games.length - 1].as_ = as2;
      for (const [tm, l] of [[h, ph], [a, pa]]) { const tot = l.reduce((s, p) => s + p.m, 0); for (const p of l) lines.push([id, tm.id, p.id, Math.round((p.m * 2400) / tot) / 10]); }
      id++; day += 3 * 3600 * 1000;
    }
  }
  return { teams, games, lines };
}

test('ridge fit recovers the fixture players (and Cholesky solves a small system)', () => {
  const A = new Float64Array([4, 2, 2, 3]), b = new Float64Array([2, 1]);
  const x = I.choleskySolve(A, b, 2);
  assert.ok(Math.abs(x[0] - 0.5) < 1e-9 && Math.abs(x[1]) < 1e-9);
  const { teams, games, lines } = fixture();
  const by = new Map();
  for (const l of lines) { if (!by.has(l[0])) by.set(l[0], []); by.get(l[0]).push(l); }
  const fit = I.ridgeFit(games.map(g => ({ home: by.get(g.id).filter(l => l[1] === g.home).map(l => [l[2], l[3]]), away: by.get(g.id).filter(l => l[1] === g.away).map(l => [l[2], l[3]]), margin: g.hs - g.as_, w: 1 })), 1);
  assert.equal(fit.players, 80);
  assert.ok(Math.abs(fit.home - 2) < 1, `home term ${fit.home}`);
  // team strengths (what the model uses) come back close, measured from the league average (margins only tell teams
  // apart, not the overall level): within 2 points for every team, correlation above 0.95
  const tr = teams.map(t => t.players.reduce((s, p) => s + (p.rating * p.min) / 48, 0)), gt = teams.map(t => t.players.reduce((s, p) => s + (fit.ratings.get(p.id) * p.min) / 48, 0));
  const c = x => { const m = x.reduce((s, v) => s + v, 0) / x.length; return x.map(v => v - m); };
  const ct = c(tr), cg = c(gt);
  ct.forEach((v, i) => assert.ok(Math.abs(v - cg[i]) < 2, `team ${teams[i].id}: ${v.toFixed(2)} vs ${cg[i].toFixed(2)}`));
  const corr = ct.reduce((s, v, i) => s + v * cg[i], 0) / Math.sqrt(ct.reduce((s, v) => s + v * v, 0) * cg.reduce((s, v) => s + v * v, 0));
  assert.ok(corr > 0.95, `correlation ${corr}`);
  // a bigger penalty pulls every rating toward 0
  const tight = I.ridgeFit(games.map(g => ({ home: by.get(g.id).filter(l => l[1] === g.home).map(l => [l[2], l[3]]), away: by.get(g.id).filter(l => l[1] === g.away).map(l => [l[2], l[3]]), margin: g.hs - g.as_, w: 1 })), 500);
  const spread = f => Math.sqrt([...f.ratings.values()].reduce((s, v) => s + v * v, 0) / f.ratings.size);
  assert.ok(spread(tight) < spread(fit));
});

test('injury reallocation: the rotation always has 240 minutes, nobody above 42, Out = 0', () => {
  const players = Array.from({ length: 13 }, (_, k) => ({ id: k + 1, min: [35, 34, 33, 30, 28, 24, 20, 18, 14, 10, 8, 5, 3][k], rating: 1 }));
  const sum = rot => rot.reduce((s, p) => s + p.proj, 0);
  const base = I.rotation(players);
  assert.equal(base.length, 10);
  assert.ok(Math.abs(sum(base) - 240) < 1e-6, `sum ${sum(base)}`);
  // two starters out, one questionable: still 240, the 11th and 12th men come in, the questionable one keeps 60%
  const keep = new Map([[1, I.statusKeep('Out')], [2, I.statusKeep('Out')], [3, I.statusKeep('Questionable')]]);
  const hurt = I.rotation(players, keep);
  assert.ok(Math.abs(sum(hurt) - 240) < 1e-6);
  assert.ok(!hurt.some(p => p.id === 1 || p.id === 2));
  assert.ok(hurt.some(p => p.id === 11) && hurt.some(p => p.id === 12));
  assert.ok(hurt.every(p => p.proj <= 42 + 1e-9));
  // only 6 healthy players: everyone at the cap is still under 240, never above
  const few = I.rotation(players.slice(0, 6));
  assert.ok(few.every(p => p.proj <= 42 + 1e-9) && sum(few) <= 252 && sum(few) >= 240 - 1e-6);
  assert.equal(I.statusKeep('Doubtful'), 0.25);
  assert.equal(I.statusKeep('Questionable'), 0.6);
  assert.equal(I.statusKeep('Out'), 0);
  assert.equal(I.statusKeep('Probable'), 1);
  // a better player out lowers the team's strength
  const rated = players.map(p => ({ ...p, rating: p.id === 1 ? 6 : 0 }));
  assert.ok(I.strength(I.rotation(rated, new Map([[1, 0]]))) < I.strength(I.rotation(rated)));
});

test('re-pricing checkpoints: 90, 30 and 10 minutes before tip-off, the latest due one, never after', () => {
  const ko = Date.parse('2026-11-01T00:00:00Z'), m = 60000;
  assert.equal(V.dueCheckpoint(ko, ko - 120 * m, new Set()), null);
  assert.equal(V.dueCheckpoint(ko, ko - 90 * m, new Set()), '90');
  assert.equal(V.dueCheckpoint(ko, ko - 60 * m, new Set(['90'])), null);
  assert.equal(V.dueCheckpoint(ko, ko - 30 * m, new Set(['90'])), '30');
  // a late start (deploy at −20 min): the 30-minute one, once
  assert.equal(V.dueCheckpoint(ko, ko - 20 * m, new Set()), '30');
  assert.equal(V.dueCheckpoint(ko, ko - 9 * m, new Set(['90', '30'])), '10');
  assert.equal(V.dueCheckpoint(ko, ko - 5 * m, new Set(['90', '30', '10'])), null);
  assert.equal(V.dueCheckpoint(ko, ko, new Set()), null);
  assert.equal(V.dueCheckpoint(ko, ko + m, new Set()), null);
  assert.deepEqual(V.CHECKPOINTS, [90, 30, 10]);
});

test('no tuning on 2025-26 or 2026-27; the replay never looks ahead', async () => {
  assert.throws(() => I.assertTuneSeasons(['2026-2027']));
  assert.throws(() => I.assertTuneSeasons(['2025-2026']));
  assert.doesNotThrow(() => I.assertTuneSeasons(['2022-2023', '2023-2024', '2024-2025']));
  assert.ok(!I.V4_TUNE_DEFAULT.includes('2025-2026') && !I.V4_TUNE_DEFAULT.includes('2026-2027'));
  assert.throws(() => I.tuneV4([], I.V4_TUNED, ['2026-2027']));
  // look-ahead: change one game's result and box score → its own row (and every earlier one) stays the same
  const { games, lines } = fixture();
  const base = new Map(games.map(g => [g.id, { nm: 0, b2bH: false, b2bA: false, p: 0.6 }]));
  const a = await I.replayV4(games, lines, base, I.V4_TUNED);
  const k = games.findIndex(g => g.season === '2025-2026') + 20;
  const g2 = games.map((g, i) => (i === k ? { ...g, hs: g.as_ - 30 } : g));
  const l2 = lines.map(l => (l[0] === games[k].id && l[1] === games[k].home ? [l[0], l[1], l[2], l[3] * 0.5] : l));
  const b = await I.replayV4(g2, l2, base, I.V4_TUNED);
  const ia = a.rows.findIndex(r => r.id === games[k].id);
  assert.ok(ia > 0);
  for (let i = 0; i <= ia; i++) { assert.equal(a.rows[i].impactMargin, b.rows[i].impactMargin); assert.equal(a.rows[i].teamMargin, b.rows[i].teamMargin); }
  // refits happen (every 14 days + season start): more than one distinct fit date over two seasons
  assert.ok(a.state.fitAt && a.state.fitPlayers === 80);
});

test('live path on a scratch database: an injured starter is removed, minutes stay 240, the chance moves', async () => {
  const { teams, games, lines } = fixture(11);
  const ins = db.prepare(`INSERT INTO bb_games (game_id, code, league_id, season, stage, kickoff, status, home_id, home_name, away_id, away_name, hs, as_, updated_at) VALUES (?, 'NBA', 12, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const name = id => teams.find(t => t.id === id).name;
  const now = new Date().toISOString();
  db.exec('BEGIN');
  for (const g of games) ins.run(g.id, g.season, new Date(g.ms).toISOString(), 'FT', g.home, name(g.home), g.away, name(g.away), g.hs, g.as_, now);
  const insL = db.prepare(`INSERT INTO bb_player_stats (game_id, team_id, player_id, name, starter, minutes) VALUES (?, ?, ?, ?, 0, ?)`);
  for (const l of lines) insL.run(l[0], l[1], l[2], `Zed ${nm(l[2])}`, l[3]);
  db.exec('COMMIT');
  const base = new Map(games.map(g => [g.id, { nm: 0, b2bH: false, b2bA: false, p: 0.55 }]));
  const r = await V.buildNbaV4(base);
  assert.ok(r && r.rows > 100);
  const up = { game_id: 99999, season: '2025-2026', home_id: teams[0].id, away_id: teams[1].id, home_name: teams[0].name, away_name: teams[1].name };
  process.env.NBA_V4 = 'full';
  const before = V.nbaV4Adjust(up, 0.55, false, false);
  assert.equal(before.model, 'bb-v4');
  assert.equal(before.home.removed.length, 0);
  // the home team's best-rated regular is out (injury list names are "First Last", box scores "Last First")
  const st = V.nbaV4Check();
  assert.ok(st.best.length > 0);
  const star = teams[0].players.slice(0, 6).sort((x, y) => y.rating - x.rating)[0];
  db.prepare(`INSERT INTO bb_injuries (team, player, status, comment, reported, updated_at) VALUES (?, ?, 'Out', NULL, NULL, ?)`).run(nbaKey(teams[0].name), `${nm(star.id)} Zed`, now);
  const after = V.nbaV4Adjust(up, 0.55, false, false);
  assert.deepEqual(after.home.removed.map(p => p.id), [star.id]);
  assert.ok(after.sameDay < 0 && after.pHome < before.pHome, `${before.pHome} → ${after.pHome}`);
  assert.ok(after.points.home > 0);
  // re-pricing only: bb-v3's chance moved by the same-day part alone
  process.env.NBA_V4 = 'reprice';
  const rp = V.nbaV4Adjust(up, 0.55, false, false);
  assert.equal(rp.model, 'bb-v3');
  assert.ok(rp.pHome < 0.55);
  process.env.NBA_V4 = 'off';
  assert.equal(V.nbaV4Adjust(up, 0.55, false, false), null);
  delete process.env.NBA_V4;
  // the gate never passes on a fixture this small (needs the 2025-26 season and 20 live games)
  assert.equal(V.nbaV4Mode(), 'reprice');
  // shadow + side by side
  V.saveShadow([{ game_id: games[games.length - 1].id, kickoff: new Date(games[games.length - 1].ms).toISOString(), mode: 'reprice', p_v3: 0.5, p_v4: 0.6 }]);
  assert.equal(V.sideBySide().games, 1);
  assert.ok(V.nbaV4ReportLines().length === 3);
});

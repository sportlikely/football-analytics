// fix200: the tennis ratings built in the worker thread (read-only connection) equal the in-process run, on a made-up
// fixture set (scratch database, dist build). Run: npm run test:fix200
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fix200-tennis-'));
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'warn';
const require = createRequire(import.meta.url);
const { db } = require('../dist/db/index.js');
require('../dist/services/tennis.js');
const tm = require('../dist/services/tennisModel.js');

// a seeded random source: the same fixture set every run
let seed = 20026;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const DAY = 86400000;
const now = new Date().toISOString();
const insP = db.prepare(`INSERT INTO tennis_players (id, name, country, tour, ranking, seen_at) VALUES (?, ?, ?, ?, ?, ?)`);
const insM = db.prepare(`INSERT INTO tennis_matches (id, tournament_id, tournament, tour, tier, surface, indoor, draw, round, round_code, is_qualifying, best_of, scheduled_at,
  status, p1_id, p1_name, p2_id, p2_name, games, winner, outcome, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'singles', ?, ?, 0, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, 'finished', 'test', ?)`);
const insS = db.prepare(`INSERT INTO tennis_match_stats (match_id, player, player_id, svc_pts, svc_won, source, complete) VALUES (?, ?, ?, ?, ?, 'test', 1)`);
const insR = db.prepare(`INSERT INTO tennis_rankings (tour, date, rank, player_id, player_name, points) VALUES (?, ?, ?, ?, ?, 0)`);
const SURF = ['hard', 'clay', 'grass'], ROUNDS = ['R32', 'R16', 'QF', 'SF', 'F'];
db.exec('BEGIN');
const players = [];
for (let i = 1; i <= 48; i++) {
  const women = i > 30, id = women ? 1000 + i : i;
  players.push({ id, women, skill: rnd() * 400 });
  insP.run(id, `Player ${id}`, ['esp', 'usa', 'fra', 'ita'][i % 4], women ? 'wta' : 'atp', i, now);
  insR.run(women ? 'wta' : 'atp', '2026-10-19', i, id, `Player ${id}`);
}
let mid = 1;
const start = Date.parse('2025-01-06T10:00:00Z');
for (let k = 0; k < 900; k++) {
  const pool = players.filter(p => p.women === (k % 3 === 0));
  const a = pool[Math.floor(rnd() * pool.length)];
  let b = pool[Math.floor(rnd() * pool.length)];
  if (a === b) b = pool[(pool.indexOf(a) + 1) % pool.length];
  const pa = 1 / (1 + Math.pow(10, (b.skill - a.skill) / 400));
  const w = rnd() < pa ? 1 : 2;
  const t = start + k * 0.7 * DAY + Math.floor(rnd() * 8) * 3600000;
  const s = SURF[Math.floor(k / 60) % 3];
  const games = w === 1 ? [[6, 7], [3, 5]] : [[3, 5], [6, 7]];
  insM.run(mid, `t${Math.floor(k / 30)}`, `Test Open ${Math.floor(k / 30)}`, a.women ? 'wta' : 'atp', a.women ? 'wta_250' : 'atp_250', s, ROUNDS[k % 5], ROUNDS[k % 5], 3,
    new Date(t).toISOString(), a.id, `Player ${a.id}`, b.id, `Player ${b.id}`, JSON.stringify(games), w, now);
  const ap = 50 + Math.floor(rnd() * 30), bp = 50 + Math.floor(rnd() * 30);
  insS.run(mid, 1, a.id, ap, Math.round(ap * (0.55 + rnd() * 0.2)));
  insS.run(mid, 2, b.id, bp, Math.round(bp * (0.55 + rnd() * 0.2)));
  mid++;
}
const I = tm.tennisModelInternals;
db.prepare(`INSERT OR REPLACE INTO tennis_model_store (k, v, at) VALUES ('settings', ?, ?)`)
  .run(JSON.stringify({ a: I.A_DEFAULT, b: I.B_DEFAULT, rm: I.RM_DEFAULT, mode: 'elo', blend: null, strong: {}, at: '2026-10-20T00:00:00.000Z', matches: 900 }), now);
db.exec('COMMIT');

after(() => tm.tennisModelTest.stop());

const FIELDS = ['pid', 'eO', 'nO', 'last', 'eS', 'nS', 'devS', 'devR', 'formWon', 'formPlayed', 'mu', 'men', 'women'];
test('worker thread ratings = in-process ratings (same fixture set, read at the same time)', async () => {
  const t = Date.parse('2026-10-23T12:00:00Z');
  const here = await tm.tennisModelTest.inProcess(t);
  const there = await tm.tennisModelTest.inWorker(t);
  assert.ok(here && there, 'both built');
  assert.equal(here.pid.length, 48, 'every player rated');
  for (const f of FIELDS) assert.deepStrictEqual(Array.from(there[f]), Array.from(here[f]), f);
  assert.equal(there.lastT, here.lastT);
  // what a player page shows, from each snapshot
  const show = S => { tm.tennisModelTest.useSnap(S); return [1, 7, 1031, 1040].map(id => tm.tennisModelTest.playerModel(id, id > 1000)); };
  const a = show(here), b = show(there);
  assert.ok(a.every(Boolean));
  assert.deepStrictEqual(b, a);
});

test('the worker wrote nothing itself (read-only connection)', () => {
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tennis_predictions`).get().n, 0);
});

test('a full tick in the worker: predictions computed there, written back here in one transaction', async () => {
  // ready (backfill mark), a report of the last full month and fresh settings: the tick only replays and predicts
  const d = new Date(); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  db.prepare(`INSERT OR REPLACE INTO tennis_meta (k, v) VALUES ('pkg:2023-01', '1')`).run();
  db.prepare(`INSERT OR REPLACE INTO tennis_model_store (k, v, at) VALUES ('report', ?, ?)`).run(JSON.stringify({ test: { to: last }, context: { kept: [] }, mode: 'elo', strong: {} }), now);
  db.prepare(`UPDATE tennis_model_store SET v = json_set(v, '$.at', ?) WHERE k = 'settings'`).run(now);
  // fix222: the calibration layer of this version is stored too (none kept), so the tick does not rebuild the report
  db.prepare(`INSERT OR REPLACE INTO tennis_model_store (k, v, at) VALUES ('calib', ?, ?)`).run(JSON.stringify({ at: now, version: tm.TENNIS_CALIB_VERSION, layer: null, strong: {}, strongSport: 0.75 }), now);
  const soon = t => new Date(Date.now() + t * 3600000).toISOString();
  const up = db.prepare(`INSERT INTO tennis_matches (id, tournament_id, tournament, tour, tier, surface, indoor, draw, round, round_code, is_qualifying, best_of, scheduled_at,
    status, p1_id, p1_name, p2_id, p2_name, source, updated_at) VALUES (?, 't99', 'Test Open 99', 'atp', 'atp_250', 'hard', 0, 'singles', 'R32', 'R32', 0, 3, ?, 'upcoming', ?, ?, ?, ?, 'test', ?)`);
  up.run(5001, soon(5), 1, 'Player 1', 2, 'Player 2', now);
  up.run(5002, soon(9), 3, 'Player 3', 4, 'Player 4', now);
  up.run(5003, soon(20), 5, 'Player 5', 6, 'Player 6', now);
  await tm.tennisModelTick();
  const rows = db.prepare(`SELECT match_id, p1, made_at FROM tennis_predictions ORDER BY match_id`).all();
  assert.deepEqual(rows.map(r => r.match_id), [5001, 5002, 5003]);
  assert.ok(rows.every(r => r.p1 > 0 && r.p1 < 1));
  const rep = tm.tennisModelReport();
  assert.equal(rep.worker.on, true, 'ran in the worker thread');
  assert.equal(rep.worker.lastWriteBack.writes, 3);
  assert.match(rep.lastTick.info, /3 predictions saved .*· worker thread/);
});

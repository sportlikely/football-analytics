/**
 * fix175: indexes on big tables are built in a worker thread with its own connection — CREATE INDEX on the
 * predictions table takes seconds and would freeze the server if it ran on the main connection at boot. The main
 * connection sees a new index on its next query (SQLite re-prepares statements after a schema change).
 */
import { Worker } from 'worker_threads';
import { db, DB_FILE } from '../db';
import logger from '../utils/logger';

const INDEXES: { name: string; sql: string }[] = [
  // crawler pages and match previews: a team's last / next games and head-to-head (18 Oct: /it/match/… blocked 3.7 s)
  { name: 'idx_predictions_home_date', sql: 'CREATE INDEX IF NOT EXISTS idx_predictions_home_date ON predictions(home_team_id, utc_date)' },
  { name: 'idx_predictions_away_date', sql: 'CREATE INDEX IF NOT EXISTS idx_predictions_away_date ON predictions(away_team_id, utc_date)' },
  // fix193: tennis pages — a player's matches (form, schedule & rest, head-to-head) and a tournament's matches (draw)
  { name: 'idx_tennis_matches_p1', sql: 'CREATE INDEX IF NOT EXISTS idx_tennis_matches_p1 ON tennis_matches(p1_id, scheduled_at)' },
  { name: 'idx_tennis_matches_p2', sql: 'CREATE INDEX IF NOT EXISTS idx_tennis_matches_p2 ON tennis_matches(p2_id, scheduled_at)' },
  { name: 'idx_tennis_stats_player', sql: 'CREATE INDEX IF NOT EXISTS idx_tennis_stats_player ON tennis_match_stats(player_id)' }
];

export function ensureIndexes(): Promise<void> {
  const have = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as any[]).map(r => r.name));
  const todo = INDEXES.filter(i => !have.has(i.name));
  if (!todo.length) return Promise.resolve();
  const code = `
    const { workerData, parentPort } = require('worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.file);
    try {
      db.exec('PRAGMA busy_timeout = 30000');
      for (const sql of workerData.sql) db.exec(sql);
    } finally { db.close(); }
    parentPort.postMessage('ok');`;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { file: DB_FILE, sql: todo.map(i => i.sql) } });
    let done = false;
    w.once('message', () => { done = true; logger.info(`db indexes built in ${Date.now() - t0} ms: ${todo.map(i => i.name).join(', ')}`); resolve(); });
    w.once('error', e => { done = true; reject(e); });
    w.once('exit', c => { if (!done) reject(new Error(`index worker stopped (${c})`)); });
  });
}

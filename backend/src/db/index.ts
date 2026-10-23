/**
 * Local database (SQLite via Node's built-in node:sqlite, Node >= 22.13 / 24).
 * Single file at backend/data/bet-to-beat.sqlite — no server, no install.
 * Schema is plain SQL so a later move to Postgres is a swap of this file.
 */
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

// Minimal typing for node:sqlite (not in @types/node 20). Loaded via require so
// the compiler doesn't need a module declaration for it.
export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}
export interface Statement {
  run(...params: any[]): RunResult;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sqlite = require('node:sqlite') as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => Database };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const threads = require('node:worker_threads') as typeof import('worker_threads');
/**
 * fix200: a worker thread (the tennis model, services/tennisModel.ts) opens its own connection in read mode; the main
 * thread writes what it computed. The schema statements below are no-ops there (the main thread made every table).
 */
export const DB_READ_ONLY = !threads.isMainThread && !!threads.workerData?.readOnlyDb;

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'bet-to-beat.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db: Database = DB_READ_ONLY ? new sqlite.DatabaseSync(DB_FILE, { readOnly: true }) : new sqlite.DatabaseSync(DB_FILE);
if (!DB_READ_ONLY) db.exec('PRAGMA journal_mode = WAL');
// fix202: the web process and the worker process write the same file: a writer waits up to 5 s for the other's lock
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS predictions (
    match_id          INTEGER NOT NULL,
    model             TEXT    NOT NULL,
    competition_code  TEXT,
    competition_name  TEXT,
    utc_date          TEXT    NOT NULL,
    home_team_id      INTEGER,
    home_team         TEXT,
    away_team_id      INTEGER,
    away_team         TEXT,
    p_home            REAL    NOT NULL,
    p_draw            REAL    NOT NULL,
    p_away            REAL    NOT NULL,
    xg_home           REAL,
    xg_away           REAL,
    over25            REAL,
    btts              REAL,
    confidence        TEXT,
    games_home        INTEGER,
    games_away        INTEGER,
    odds_home         REAL,
    odds_draw         REAL,
    odds_away         REAL,
    locked            INTEGER NOT NULL DEFAULT 0,
    locked_at         TEXT,
    settled           INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    PRIMARY KEY (match_id, model)
  );
  CREATE INDEX IF NOT EXISTS idx_predictions_date ON predictions(utc_date);
  CREATE INDEX IF NOT EXISTS idx_predictions_pending ON predictions(settled, locked, utc_date);

  CREATE TABLE IF NOT EXISTS results (
    match_id      INTEGER PRIMARY KEY,
    status        TEXT    NOT NULL,
    home_goals    INTEGER,
    away_goals    INTEGER,
    outcome       TEXT,            -- 'H' | 'D' | 'A' | 'VOID'
    settled_at    TEXT    NOT NULL
  );
`);

logger.info(`SQLite ready: ${DB_FILE}`);

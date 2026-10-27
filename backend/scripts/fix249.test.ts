// fix249: database growth — retention (logs 14 days, slices, nothing the record needs), the disk verdict, the
// covering index for the state list, and the upkeep thread giving space back. Run: npm run test:fix249
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { RULES, PROTECTED, LOG_DAYS, runRetention, cutoffOf, sliceSql } from '../src/utils/retention.ts';
import { diskVerdict, growthPerDay, DISK_RULES } from '../src/utils/diskRules.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f: string) => fs.readFileSync(path.join(here, '../src', f), 'utf8');
const NOW = Date.parse('2026-10-27T12:00:00Z');
const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);
const tmpDb = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix249-'));
  return { dir, file: path.join(dir, 'bet-to-beat.sqlite') };
};

/* ---------- the rules ---------- */

test('no retention rule touches a table the record, predictions, accounts or money need', () => {
  for (const r of RULES) assert.ok(!PROTECTED.has(r.table), `${r.table} is protected`);
  for (const t of ['predictions', 'results', 'bb_predictions', 'nfl_predictions', 'tennis_predictions', 'prediction_extras', 'user_picks', 'users', 'plan_events', 'credit_events', 'security_log', 'diff_view_flags'])
    assert.ok(PROTECTED.has(t), `${t} must be protected`);
});

test('logs keep 14 days; route copies 2 days; security log is not a rule (90 days, CLAUDE.md)', () => {
  assert.equal(LOG_DAYS, 14);
  for (const r of RULES) assert.ok(r.keepDays <= 14 && r.keepDays >= 2, `${r.table}: ${r.keepDays} days`);
  assert.equal(RULES.find(r => r.table === 'route_cache')?.keepDays, 2);
  assert.ok(!RULES.some(r => r.table === 'security_log'));
  // a slice is a bounded delete by rowid
  for (const r of RULES) assert.match(sliceSql(r, 500), /^DELETE FROM \w+ WHERE rowid IN \(SELECT rowid FROM \w+ WHERE .+ LIMIT 500\)$/);
});

test('cutoffs per kind', () => {
  const r = { table: 'x', col: 'c', keepDays: 14, why: '' };
  assert.equal(cutoffOf({ ...r, kind: 'day' }, NOW), '2026-10-13');
  assert.equal(cutoffOf({ ...r, kind: 'iso' }, NOW), '2026-10-13T12:00:00.000Z');
  assert.equal(cutoffOf({ ...r, kind: 'ms' }, NOW), NOW - 14 * DAY);
  assert.equal(cutoffOf({ ...r, kind: 'minute' }, NOW), Math.floor((NOW - 14 * DAY) / 60000));
});

/* ---------- the run on a real file ---------- */

function seed(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE predictions (match_id INTEGER, model TEXT, utc_date TEXT, settled INTEGER);
    CREATE TABLE results (match_id INTEGER PRIMARY KEY, settled_at TEXT);
    CREATE TABLE security_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT);
    CREATE TABLE visits (day TEXT NOT NULL, vid TEXT NOT NULL, human INTEGER NOT NULL DEFAULT 0, signed_in INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, vid));
    CREATE TABLE league_visits (day TEXT NOT NULL, sport TEXT NOT NULL, code TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, sport, code, vid));
    CREATE TABLE crawler_day (day TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE client_errors (id INTEGER PRIMARY KEY, last_at TEXT NOT NULL);
    CREATE TABLE worker_exits (at INTEGER NOT NULL, reason TEXT);
    CREATE TABLE data_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE admin_auto_fixes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, title TEXT, summary_day TEXT);
    CREATE TABLE route_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, body BLOB NOT NULL);
  `);
  const old = NOW - 40 * DAY, fresh = NOW - 2 * DAY;
  db.exec('BEGIN');
  const p = db.prepare(`INSERT INTO predictions VALUES (?, 'grid-v3', ?, 1)`);
  const r = db.prepare(`INSERT INTO results VALUES (?, ?)`);
  for (let i = 0; i < 300; i++) { p.run(i, iso(old)); r.run(i, iso(old)); }
  db.prepare(`INSERT INTO security_log (at, event) VALUES (?, 'login')`).run(iso(NOW - 60 * DAY));
  const v = db.prepare(`INSERT INTO visits VALUES (?, ?, ?, ?)`), lv = db.prepare(`INSERT INTO league_visits VALUES (?, 'football', 'PL', ?)`);
  for (let i = 0; i < 5000; i++) { v.run(day(old), `bot${i}`, 0, 0); lv.run(day(old), `bot${i}`); }
  for (let i = 0; i < 50; i++) { v.run(day(old), `p${i}`, 1, 0); lv.run(day(old), `p${i}`); v.run(day(fresh), `bot${i}`, 0, 0); }
  v.run(day(old), 'member', 0, 1);
  db.prepare(`INSERT INTO crawler_day VALUES (?, '{}')`).run(day(old));
  db.prepare(`INSERT INTO crawler_day VALUES (?, '{}')`).run(day(fresh));
  db.prepare(`INSERT INTO client_errors (last_at) VALUES (?)`).run(iso(old));
  db.prepare(`INSERT INTO worker_exits VALUES (?, 'x'), (?, 'y')`).run(old, fresh);
  // data audit: only old runs — the newest is kept whatever its age
  db.prepare(`INSERT INTO data_audit (at, json) VALUES (?, '{}'), (?, '{}')`).run(iso(old - DAY), iso(old));
  db.prepare(`INSERT INTO admin_auto_fixes (at, title, summary_day) VALUES (?, 'sent', '2026-09-17'), (?, 'not yet in a summary', NULL)`).run(iso(old), iso(old));
  const rc = db.prepare(`INSERT INTO route_cache VALUES (?, ?, ?)`);
  for (let i = 0; i < 100; i++) rc.run(`/old/${i}`, NOW - 3 * DAY, Buffer.alloc(1000));
  rc.run('/new', NOW - 3600_000, Buffer.alloc(10));
  db.exec('COMMIT');
}

test('retention deletes old log rows in slices and nothing else', async () => {
  const { dir, file } = tmpDb();
  const db = new DatabaseSync(file);
  seed(db);
  let pauses = 0;
  const res = await runRetention(db, { now: NOW, slice: 1000, pause: async () => { pauses++; } });
  const n = (sql: string) => Number((db.prepare(sql).get() as any).n);
  // the record and the security log untouched
  assert.equal(n(`SELECT COUNT(*) AS n FROM predictions`), 300);
  assert.equal(n(`SELECT COUNT(*) AS n FROM results`), 300);
  assert.equal(n(`SELECT COUNT(*) AS n FROM security_log`), 1);
  // old bot visits gone, people and members kept, fresh bots kept
  assert.equal(n(`SELECT COUNT(*) AS n FROM visits WHERE human = 0 AND signed_in = 0 AND day < '2026-10-13'`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM visits WHERE human = 1`), 50);
  assert.equal(n(`SELECT COUNT(*) AS n FROM visits WHERE signed_in = 1`), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM visits WHERE day >= '2026-10-13'`), 50);
  // league opens: the people's kept (the 30-day league numbers), the bots' gone
  assert.equal(n(`SELECT COUNT(*) AS n FROM league_visits`), 50);
  assert.equal(n(`SELECT COUNT(*) AS n FROM league_visits WHERE vid LIKE 'bot%'`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM crawler_day`), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM client_errors`), 0);
  assert.equal(n(`SELECT COUNT(*) AS n FROM worker_exits`), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM data_audit`), 1, 'the last audit run is kept');
  assert.equal(n(`SELECT COUNT(*) AS n FROM admin_auto_fixes`), 1, 'a note not yet in a summary is kept');
  assert.equal(n(`SELECT COUNT(*) AS n FROM route_cache`), 1);
  // 5,000 bot visits in slices of 1,000: several statements with a pause between
  assert.equal(res.find(r => r.table === 'visits')?.deleted, 5000);
  assert.ok(pauses >= 5, `${pauses} pauses`);
  // tables that do not exist are skipped, no errors
  assert.ok(res.every(r => !r.error), JSON.stringify(res.filter(r => r.error)));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retention stops at its time budget and carries on next run', async () => {
  const { dir, file } = tmpDb();
  const db = new DatabaseSync(file);
  seed(db);
  const rules = RULES.filter(r => r.table === 'visits');
  const first = await runRetention(db, { now: NOW, slice: 100, budgetMs: 0, rules, pause: async () => { } });
  assert.equal(first[0].deleted, 100);
  assert.equal(first[0].done, false);
  for (let i = 0; i < 100 && Number((db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE human = 0 AND signed_in = 0 AND day < '2026-10-13'`).get() as any).n); i++)
    await runRetention(db, { now: NOW, slice: 1000, rules, pause: async () => { } });
  assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE human = 0 AND signed_in = 0 AND day < '2026-10-13'`).get() as any).n), 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rule naming a protected table is refused', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE predictions (utc_date TEXT)`);
  await assert.rejects(runRetention(db, { rules: [{ table: 'predictions', col: 'utc_date', kind: 'iso', keepDays: 14, why: 'no' }] }), /protected/);
});

/* ---------- disk verdict ---------- */

test('disk: growth per day over the last 7 days of the size history', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ day: day(NOW - (9 - i) * DAY), bytes: 1e9 + i * 300e6 }));
  assert.equal(growthPerDay(rows, day(NOW)), 300e6);
  assert.equal(growthPerDay(rows.slice(-1), day(NOW)), null);
  assert.equal(growthPerDay([], day(NOW)), null);
});

test('disk: warn when the growth fills the volume within 30 days, fail within 7 / under 10% free', () => {
  const G = 1073741824;
  assert.equal(diskVerdict({ volFree: 40 * G, volTotal: 50 * G, dbBytes: 2 * G, walBytes: 0, growth7d: 0.1 * G }).level, 'ok');
  // 300 MB a day, 6 GB free → 20 days
  const w = diskVerdict({ volFree: 6 * G, volTotal: 20 * G, dbBytes: 2.6 * G, walBytes: 0, growth7d: 7 * 0.3 * G });
  assert.equal(w.level, 'warn');
  assert.equal(Math.floor(w.daysToFull!), 20);
  assert.equal(diskVerdict({ volFree: 1.5 * G, volTotal: 20 * G, dbBytes: 2.6 * G, walBytes: 0, growth7d: 7 * 0.3 * G }).level, 'fail');
  assert.equal(diskVerdict({ volFree: 1 * G, volTotal: 50 * G, dbBytes: 2 * G, walBytes: 0, growth7d: 0 }).level, 'fail');
  // shrinking: never full
  assert.equal(diskVerdict({ volFree: 40 * G, volTotal: 50 * G, dbBytes: 2 * G, walBytes: 0, growth7d: -G }).daysToFull, null);
  // a big WAL is a warning of its own
  assert.equal(diskVerdict({ volFree: 40 * G, volTotal: 50 * G, dbBytes: 2 * G, walBytes: DISK_RULES.walWarnBytes + 1, growth7d: 0 }).level, 'warn');
});

/* ---------- the slow reads ---------- */

test('the state version list reads a covering index (no row of the states themselves)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE shared_state (key TEXT PRIMARY KEY, ver INTEGER NOT NULL, at TEXT NOT NULL, bytes INTEGER NOT NULL, ms INTEGER NOT NULL, data BLOB NOT NULL)`);
  const s = src('services/shared.ts');
  const idx = s.match(/CREATE INDEX IF NOT EXISTS \$\{VERS_IDX\} ON shared_state\(key, ver\)/);
  assert.ok(idx, 'shared.ts creates the (key, ver) index');
  db.exec(`CREATE INDEX idx_shared_state_ver ON shared_state(key, ver)`);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT key, ver FROM shared_state INDEXED BY idx_shared_state_ver ORDER BY key`).all() as any[]).map(r => r.detail).join(' | ');
  assert.match(plan, /COVERING INDEX idx_shared_state_ver/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  assert.match(s, /INDEXED BY \$\{VERS_IDX\} ORDER BY key/);
});

test('the web process never pages squad values or club value history', () => {
  assert.match(src('services/squadValues.ts'), /if \(!isWeb\) loadCache\(\);/);
  assert.doesNotMatch(src('services/squadValues.ts'), /if \(isWeb\) void loadCacheAsync/);
  assert.match(src('services/squadHistory.ts'), /if \(!isWeb\) \{ load\(\); onState\('squad:history'/);
  assert.doesNotMatch(src('services/squadHistory.ts'), /if \(isWeb\) void loadAsync/);
});

/* ---------- the upkeep thread: WAL truncate, size report, vacuum ---------- */

function thread(file: string) {
  const w = new Worker(path.join(here, '../src/workers/dbMaint.ts'), { workerData: { file } });
  let id = 0;
  const ask = (msg: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const my = ++id;
    const on = (m: any) => { if (m.id !== my) return; w.off('message', on); m.error ? reject(new Error(m.error)) : resolve(m.out); };
    w.on('message', on);
    w.postMessage({ id: my, ...msg });
  });
  return { ask, end: () => w.terminate() };
}

test('upkeep thread: report, WAL truncated, full vacuum once, then incremental slices shrink the file', async () => {
  const { dir, file } = tmpDb();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE route_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, body BLOB NOT NULL)`);
  db.exec(`CREATE TABLE predictions (match_id INTEGER, utc_date TEXT)`);
  db.prepare(`INSERT INTO predictions VALUES (1, '2026-01-01')`).run();
  const ins = db.prepare(`INSERT INTO route_cache VALUES (?, ?, ?)`);
  db.exec('BEGIN');
  for (let i = 0; i < 3000; i++) ins.run(`/k/${i}`, NOW - 3 * DAY, Buffer.alloc(8000, 1));
  db.exec('COMMIT');
  const t = thread(file);
  try {
    const rep = await t.ask({ op: 'report' });
    const rc = rep.rows.find((r: any) => r.name === 'route_cache');
    assert.ok(rc.bytes > 20e6, `route_cache ${rc.bytes} bytes`);
    assert.equal(Number(rc.cells), 3000);
    assert.equal(rep.autoVacuum, 0);
    // retention empties it: the pages go to the free list, the file stays as big
    await runRetention(db, { now: NOW, rules: RULES.filter(r => r.table === 'route_cache'), pause: async () => { } });
    const c1 = await t.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300 });
    assert.equal(c1.busy, 0);
    assert.equal(fs.statSync(`${file}-wal`).size, 0, 'WAL truncated');
    const before = fs.statSync(file).size;
    let p = await t.ask({ op: 'pragmas' });
    assert.ok(p.freePages * p.pageSize > 20e6, `free pages ${p.freePages}`);
    // the one full vacuum (auto_vacuum → incremental) gives the space back at once
    p = await t.ask({ op: 'convert' });
    assert.equal(p.autoVacuum, 2);
    await t.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300 });
    const afterFull = fs.statSync(file).size;
    assert.ok(afterFull < before / 5, `${before} → ${afterFull}`);
    // later deletes: incremental slices
    db.exec('BEGIN');
    for (let i = 0; i < 1500; i++) ins.run(`/m/${i}`, NOW - 3 * DAY, Buffer.alloc(8000, 2));
    db.exec('COMMIT');
    await t.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300 });
    const grown = fs.statSync(file).size;
    db.exec(`DELETE FROM route_cache`);
    for (let i = 0; i < 20; i++) { p = await t.ask({ op: 'incremental', pages: 512 }); if (!p.freePages) break; }
    assert.equal(p.freePages, 0);
    await t.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300 });
    assert.ok(fs.statSync(file).size < grown / 3, `${grown} → ${fs.statSync(file).size}`);
    // the record row is still there
    assert.equal(Number((db.prepare(`SELECT COUNT(*) AS n FROM predictions`).get() as any).n), 1);
  } finally {
    await t.end();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reader on an old snapshot: TRUNCATE reports busy within its short wait (writers are not held long)', async () => {
  const { dir, file } = tmpDb();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE x (a)`);
  db.prepare(`INSERT INTO x VALUES (1)`).run();
  const reader = new DatabaseSync(file, { readOnly: true });
  reader.exec('BEGIN');
  reader.prepare(`SELECT * FROM x`).all();
  db.prepare(`INSERT INTO x VALUES (2)`).run();
  const t = thread(file);
  try {
    const t0 = Date.now();
    const c = await t.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300 });
    assert.equal(c.busy, 1);
    assert.ok(Date.now() - t0 < 2000);
    reader.exec('COMMIT');
    assert.equal((await t.ask({ op: 'checkpoint', mode: 'TRUNCATE', busyMs: 300 })).busy, 0);
  } finally {
    await t.end();
    reader.close(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wired: worker schedule, data health, admin route, retention replaces the old route_cache delete', () => {
  assert.match(src('jobs.ts'), /startDbSpaceScheduler\(\);/);
  assert.match(src('services/dataHealth.ts'), /diskHealth\(\)/);
  assert.match(src('app.ts'), /app\.get\('\/api\/admin\/db-space'/);
  assert.doesNotMatch(src('services/workerRoutes.ts'), /DELETE FROM route_cache WHERE at < \?/);
  assert.match(src('db/index.ts'), /journal_size_limit/);
});

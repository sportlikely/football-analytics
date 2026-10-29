/**
 * fix249: database size and upkeep (the worker). Overnight 27 Oct the "database" was 2.6 GB (1.1 GB on 18 Oct,
 * 250–350 MB a day) and reads in the web's reader threads took up to 9.8 s. Here:
 *  - checkpoints from a thread of its own (workers/dbMaint.ts): PASSIVE every 5 min, TRUNCATE every 30 min with a
 *    300 ms wait — the size the admin page showed is file + WAL (backup.ts) and the WAL only ever grew;
 *    journal_size_limit (db/index.ts) cuts it back whenever it starts over
 *  - retention (utils/retention.ts): logs 14 days, deleted SLICE rows at a time with a yield between, hourly
 *  - space back: incremental vacuum in slices (1,024 pages, a pause between, ≤ 45 s a run, every 10 min) once the file
 *    is in auto_vacuum = INCREMENTAL; the one full VACUUM that switches it on runs by itself between 01:00 and 02:30 UTC
 *    (before the 02:40 backup) when ≥ 256 MB / 15% of the file is free pages and the disks have room (DB_VACUUM=0: never)
 *  - the size report (dbstat: bytes and rows per table / index, daily + Admin), the size history (db_size_days) and
 *    the data-health checks "Disk" and "Slow reads (3 h)"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { db, DB_FILE } from '../db';
import logger from '../utils/logger';
import { runsJobs } from './role';
import { every, after, heavy } from './perf';
import { runRetention, type RetentionResult } from '../utils/retention';
import { diskVerdict, growthPerDay, growthOver, truncatePlan, reportDue } from '../utils/diskRules';
import { readerHourRows, perfHours } from './perfHistory';
import type { Check } from './dataHealth';
import { volumeLatency, volumeLine, volumeTick, volumeHealth } from './volumeProbe';
import { cachePlan } from '../utils/dbTune';
import { longReadsNow, onLongReadsEnded } from './longReads';

if (runsJobs) {
  db.exec(`CREATE TABLE IF NOT EXISTS db_size_days (day TEXT PRIMARY KEY, db_bytes INTEGER NOT NULL, wal_bytes INTEGER NOT NULL,
    free_bytes INTEGER, vol_free INTEGER, vol_total INTEGER, at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS db_space_tables (day TEXT NOT NULL, name TEXT NOT NULL, tbl TEXT, type TEXT, bytes INTEGER NOT NULL,
    rows INTEGER NOT NULL, PRIMARY KEY (day, name))`);
  db.exec(`CREATE TABLE IF NOT EXISTS db_space_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  // fix272: the size every 10 minutes (72 h kept): the 6-hour growth (a day's peak row hid 5 GB in 5 h, 28–29 Oct)
  db.exec(`CREATE TABLE IF NOT EXISTS db_size_hours (at TEXT PRIMARY KEY, db_bytes INTEGER NOT NULL, wal_bytes INTEGER NOT NULL, vol_free INTEGER)`);
}

const MB = (n: number) => `${(n / 1048576).toLocaleString('en-US', { maximumFractionDigits: n < 10 * 1048576 ? 1 : 0 })} MB`;
const GB = (n: number) => (Math.abs(n) >= 1e9 ? `${(n / 1073741824).toFixed(2)} GB` : MB(n));
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const size = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
const meta = (k: string): string | null => { try { return (db.prepare(`SELECT v FROM db_space_meta WHERE k = ?`).get(k) as any)?.v ?? null; } catch { return null; } };
const setMeta = (k: string, v: string) => db.prepare(`INSERT OR REPLACE INTO db_space_meta (k, v) VALUES (?, ?)`).run(k, v);

export function files() {
  return { db: size(DB_FILE), wal: size(`${DB_FILE}-wal`), shm: size(`${DB_FILE}-shm`) };
}
function volume(dir = path.dirname(DB_FILE)): { free: number; total: number } | null {
  try { const st = (fs as any).statfsSync(dir); return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) }; } catch { return null; }
}

/* ---------- the upkeep thread ---------- */

let thread: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
function threadFile(): { file: string; execArgv?: string[] } | null {
  const js = path.join(__dirname, '../workers/dbMaint.js');
  if (fs.existsSync(js)) return { file: js };
  const ts = path.join(__dirname, '../workers/dbMaint.ts');
  if (fs.existsSync(ts)) return { file: ts, execArgv: ['-r', 'ts-node/register/transpile-only'] };
  return null;
}
function maint<T = any>(msg: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  if (!thread) {
    const f = threadFile();
    if (!f) return Promise.reject(new Error('no db upkeep thread file'));
    const t = new Worker(f.file, { workerData: { file: DB_FILE }, execArgv: f.execArgv, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    t.unref();
    t.on('message', (m: any) => {
      const p = waiting.get(m?.id);
      if (!p) return;
      waiting.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve({ ...m.out, ms: Math.round(m.ms) });
    });
    const down = (e: Error) => { if (thread === t) { thread = null; autoCheckpoint(true); } for (const [id, p] of waiting) { clearTimeout(p.timer); waiting.delete(id); p.reject(e); } };
    t.on('error', e => { logger.warn(`db upkeep thread: ${e.message}`); down(e); });
    t.on('exit', c => down(new Error(`db upkeep thread stopped (${c})`)));
    thread = t;
    autoCheckpoint(false);
  }
  const t = thread, id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { if (waiting.delete(id)) reject(new Error(`db upkeep: ${String(msg.op)} took over ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
    timer.unref();
    waiting.set(id, { resolve, reject, timer });
    t.ref();
    t.postMessage({ id, ...msg });
  }).finally(() => { if (!waiting.size) t.unref(); });
}

/* ---------- checkpoints ---------- */

/*
 * fix269: only the upkeep thread writes the WAL back. While it is up this process's own connection never checkpoints
 * (wal_autocheckpoint 0: a commit past 1,000 WAL pages ran a checkpoint + fsync on the worker's thread); without the
 * thread SQLite's own (1,000 pages) is back, so the WAL can never grow without end.
 */
let autoCkpt: number | null = null;
function autoCheckpoint(on: boolean) {
  const pages = on ? 1000 : 0;
  if (autoCkpt === pages) return;
  try { db.exec(`PRAGMA wal_autocheckpoint = ${pages}`); autoCkpt = pages; } catch { /* read-only */ }
}
export const autoCheckpointPages = () => autoCkpt;

type Ckpt = { at: string; mode: string; busy: number; log: number; checkpointed: number; left?: number; truncated?: boolean; busyMs?: number; ms: number; walBefore?: number; walAfter: number; passes?: number; readers?: ReturnType<typeof longReadsNow> };
const ckpt: { last: Ckpt | null; lastTruncate: Ckpt | null; lastDone: Ckpt | null; busyStreak: number; errors: number } = { last: null, lastTruncate: null, lastDone: null, busyStreak: 0, errors: 0 };
let ckptRunning = false;
export async function checkpoint(mode: 'PASSIVE' | 'TRUNCATE'): Promise<Ckpt | null> {
  if (ckptRunning) return null; // (a long write-back on a slow volume: the next tick waits for it, never queues behind it)
  ckptRunning = true;
  try {
    const walBefore = files().wal;
    // fix272: the bigger the WAL / the longer it could not start over, the longer TRUNCATE waits for old readers
    const plan = truncatePlan(walBefore, ckpt.busyStreak);
    const r = await maint<{ busy: number; log: number; checkpointed: number; left: number; truncated: boolean; ms: number }>(
      { op: 'checkpoint', mode, busyMs: mode === 'TRUNCATE' ? plan.busyMs : 0, catchUp: plan.catchUp }, 10 * 60 * 1000);
    const c: Ckpt = { at: new Date().toISOString(), mode, ...r, busyMs: mode === 'TRUNCATE' ? plan.busyMs : 0, walBefore, walAfter: files().wal };
    // fix273: who was reading when it could not start over (the backup, a job thread …: services/longReads.ts)
    if (mode === 'TRUNCATE' && c.busy) c.readers = longReadsNow();
    ckpt.last = c;
    if (mode === 'TRUNCATE') {
      ckpt.lastTruncate = c;
      if (!c.busy) ckpt.lastDone = c;
      // busy = a reader on an old snapshot (or a writer) kept the WAL from starting over
      ckpt.busyStreak = c.busy ? ckpt.busyStreak + 1 : 0;
      if (ckpt.busyStreak === 3 || ckpt.busyStreak === 12) logger.warn(`db checkpoint: TRUNCATE busy ${ckpt.busyStreak} times in a row, ${c.left ?? '?'} frames left after ${c.passes ?? 1} PASSIVE pass(es)${c.readers?.length ? `; reading: ${c.readers.map(x => `${x.name} for ${x.forMin} min`).join(', ')}` : '; no long read open in the worker'}`);
      if (ckpt.busyStreak === 12) logger.warn(`db checkpoint: TRUNCATE busy 12 times in a row (1 h), WAL ${MB(c.walAfter)}, ${c.checkpointed}/${c.log} frames written back`);
      if (!c.busy && walBefore > 256 * 1048576) logger.info(`db checkpoint: WAL ${GB(walBefore)} → ${MB(c.walAfter)} (TRUNCATE, ${c.ms} ms, waited up to ${plan.busyMs} ms for readers)`);
    }
    return c;
  } catch (e: any) { ckpt.errors++; logger.warn(`db checkpoint ${mode}: ${e?.message || e}`); return null; } finally { ckptRunning = false; }
}
/** fix273: how long since the WAL last started over (null in the first hour after a start: not known yet) */
export function truncateAge(now = Date.now()): number | null {
  if (ckpt.lastDone) return now - Date.parse(ckpt.lastDone.at);
  return process.uptime() > 3600 ? process.uptime() * 1000 : null;
}
/** fix272 (every 5 min): TRUNCATE when the WAL is over its 64 MB limit or the last one is 30 min old; else PASSIVE */
async function checkpointTick() {
  const due = files().wal > 64 * 1048576 || !ckpt.lastDone || Date.now() - Date.parse(ckpt.lastDone.at) > 30 * 60 * 1000;
  return checkpoint(due ? 'TRUNCATE' : 'PASSIVE');
}

/* ---------- retention ---------- */

let lastRetention: { at: string; ms: number; deleted: number; results: RetentionResult[] } | null = null;
export async function retentionTick(now = Date.now()) {
  const t0 = Date.now();
  const results = await runRetention(db as any, { now, budgetMs: 30_000, pause: () => new Promise<void>(r => setTimeout(r, 20)) });
  const deleted = results.reduce((s, r) => s + r.deleted, 0);
  lastRetention = { at: new Date(t0).toISOString(), ms: Date.now() - t0, deleted, results: results.filter(r => r.deleted || r.error) };
  for (const r of results) if (r.error) logger.warn(`db retention ${r.table}: ${r.error}`);
  if (deleted) logger.info(`db retention: ${deleted.toLocaleString('en-US')} rows in ${Date.now() - t0} ms (${results.filter(r => r.deleted).map(r => `${r.table} ${r.deleted}`).join(', ')})`);
  return lastRetention;
}

/* ---------- space back ---------- */

const VAC = { slicePages: 1024, pauseMs: 250, budgetMs: 45_000, minFreeBytes: 256 * 1048576, minFreeShare: 0.15, windowUtc: [60, 150] as [number, number] };
let lastVacuum: { at: string; ms: number; freedPages: number; freeLeft: number; pageSize: number; fileBefore: number; fileAfter: number } | null = null;
let converting = false;
type Pragmas = { pageSize: number; pages: number; freePages: number; autoVacuum: number };
export const pragmasNow = () => maint<Pragmas>({ op: 'pragmas' });

/** one run of incremental vacuum slices (auto_vacuum = 2 only), then a TRUNCATE checkpoint so the file shrinks */
export async function vacuumSlices(budgetMs = VAC.budgetMs): Promise<typeof lastVacuum> {
  let p = await pragmasNow();
  if (p.autoVacuum !== 2 || p.freePages < VAC.slicePages / 4) return lastVacuum;
  const t0 = Date.now(), first = p.freePages, fileBefore = files().db + files().wal;
  while (p.freePages > 0 && Date.now() - t0 < budgetMs) {
    p = await maint<Pragmas>({ op: 'incremental', pages: VAC.slicePages });
    await new Promise(r => setTimeout(r, VAC.pauseMs));
  }
  await checkpoint('TRUNCATE');
  lastVacuum = { at: new Date(t0).toISOString(), ms: Date.now() - t0, freedPages: first - p.freePages, freeLeft: p.freePages, pageSize: p.pageSize, fileBefore, fileAfter: files().db + files().wal };
  logger.info(`db vacuum: ${(first - p.freePages).toLocaleString('en-US')} pages freed in ${lastVacuum.ms} ms, ${p.freePages} free pages left, file ${GB(fileBefore)} → ${GB(lastVacuum.fileAfter)}`);
  return lastVacuum;
}

/** may the one full VACUUM (auto_vacuum → INCREMENTAL) run now? (null = yes, else why not) */
export function convertBlocker(p: Pragmas, now = Date.now(), force = false): string | null {
  if (p.autoVacuum === 2) return 'already incremental';
  if (process.env.DB_VACUUM === '0') return 'DB_VACUUM=0';
  if (converting) return 'running';
  const free = p.freePages * p.pageSize, file = p.pages * p.pageSize;
  if (!force && free < Math.max(VAC.minFreeBytes, file * VAC.minFreeShare)) return `only ${MB(free)} of free pages`;
  const d = new Date(now), min = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (!force && (min < VAC.windowUtc[0] || min > VAC.windowUtc[1])) return 'outside 01:00–02:30 UTC';
  const last = Number(meta('convert_at') || 0);
  if (!force && now - last < 20 * 3600 * 1000) return 'tried in the last 20 h';
  // the copy is built in the temp folder and written back through the WAL: both need about the file's size left
  const need = (file - free) * 1.2 + 200 * 1048576;
  const vol = volume(), tmp = volume(os.tmpdir());
  if (vol && vol.free < need) return `volume ${GB(vol.free)} free, needs ${GB(need)}`;
  if (tmp && tmp.free < need) return `temp disk ${GB(tmp.free)} free, needs ${GB(need)}`;
  return null;
}
export async function convertToIncremental(force = false): Promise<string> {
  const p = await pragmasNow();
  const why = convertBlocker(p, Date.now(), force);
  if (why) return why;
  converting = true;
  setMeta('convert_at', String(Date.now()));
  const t0 = Date.now(), before = files().db + files().wal;
  try {
    await checkpoint('TRUNCATE');
    logger.info(`db vacuum: one full VACUUM to turn on incremental vacuum (file ${GB(before)}, ${MB(p.freePages * p.pageSize)} free pages) — writes wait meanwhile`);
    const r = await maint<Pragmas>({ op: 'convert' }, 30 * 60 * 1000);
    await checkpoint('TRUNCATE');
    const msg = `VACUUM done in ${Math.round((Date.now() - t0) / 1000)} s: auto_vacuum ${r.autoVacuum}, file ${GB(before)} → ${GB(files().db + files().wal)}`;
    setMeta('convert_result', JSON.stringify({ at: new Date().toISOString(), ok: true, msg }));
    logger.info(`db vacuum: ${msg}`);
    return msg;
  } catch (e: any) {
    const msg = `VACUUM failed after ${Math.round((Date.now() - t0) / 1000)} s: ${e?.message || e}`;
    setMeta('convert_result', JSON.stringify({ at: new Date().toISOString(), ok: false, msg }));
    logger.warn(`db vacuum: ${msg}`);
    return msg;
  } finally { converting = false; }
}
async function vacuumTick() {
  const p = await pragmasNow();
  if (p.autoVacuum === 2) { await vacuumSlices(); return; }
  if (!convertBlocker(p)) await heavy('db vacuum', () => convertToIncremental());
}

/* ---------- size report + history ---------- */

export type TableRow = { name: string; tbl: string | null; type: string | null; bytes: number; rows: number };
export async function sizeReport(): Promise<{ at: string; ms: number; rows: TableRow[]; pageSize: number; pages: number; freePages: number; autoVacuum: number; wal?: number; file?: number }> {
  const r = await maint<any>({ op: 'report' }, 15 * 60 * 1000);
  const rows: TableRow[] = (r.rows as any[]).map(x => ({ name: x.name, tbl: x.tbl ?? null, type: x.type ?? (x.name === 'sqlite_schema' ? 'table' : null), bytes: Number(x.bytes), rows: Number(x.cells) }));
  const day = today();
  db.exec('BEGIN');
  try {
    const ins = db.prepare(`INSERT OR REPLACE INTO db_space_tables (day, name, tbl, type, bytes, rows) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const x of rows) ins.run(day, x.name, x.tbl, x.type, x.bytes, x.rows);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const f = files();
  const out = { at: new Date().toISOString(), ms: r.ms, rows, pageSize: r.pageSize, pages: r.pages, freePages: r.freePages, autoVacuum: r.autoVacuum, wal: f.wal, file: f.db };
  // fix272: the report before this one (name → bytes), so Disk shows each table's growth since then (hours, not a week)
  const prev = storedReport();
  if (prev) setMeta('report_prev', JSON.stringify({ at: prev.at, wal: prev.wal ?? null, file: prev.file ?? null, freePages: prev.freePages, pageSize: prev.pageSize, bytes: Object.fromEntries(prev.rows.map(x => [x.name, x.bytes])) }));
  setMeta('report', JSON.stringify(out));
  logger.info(`db size report (${r.ms} ms): ${rows.slice(0, 5).map(x => `${x.name} ${GB(x.bytes)}`).join(', ')}; free pages ${MB(r.freePages * r.pageSize)}`);
  return out;
}
export function storedReport(): Awaited<ReturnType<typeof sizeReport>> | null {
  try { return JSON.parse(meta('report') || 'null'); } catch { return null; }
}
type PrevReport = { at: string; wal: number | null; file: number | null; freePages: number; pageSize: number; bytes: Record<string, number> };
function prevReport(): PrevReport | null {
  try { return JSON.parse(meta('report_prev') || 'null'); } catch { return null; }
}
/** fix272: the size every 10 minutes (file + WAL, 72 h kept) */
function recordSizeRow(now = Date.now()) {
  const f = files(), v = volume();
  db.prepare(`INSERT OR REPLACE INTO db_size_hours (at, db_bytes, wal_bytes, vol_free) VALUES (?, ?, ?, ?)`).run(new Date(now).toISOString().slice(0, 16), f.db, f.wal, v?.free ?? null);
  db.prepare(`DELETE FROM db_size_hours WHERE at < ?`).run(new Date(now - 72 * 3600 * 1000).toISOString().slice(0, 16));
}
/** fix272: file + WAL growth over the last 6 hours (from the 10-minute rows) */
export function growth6h(now = Date.now()) {
  try {
    const rows = (db.prepare(`SELECT at, db_bytes + wal_bytes AS bytes FROM db_size_hours WHERE at >= ?`).all(new Date(now - 6 * 3600 * 1000 - 60_000).toISOString().slice(0, 16)) as any[])
      .map(r => ({ at: `${r.at}:00.000Z`, bytes: Number(r.bytes) }));
    const f = files();
    return growthOver(rows, { at: new Date(now).toISOString(), bytes: f.db + f.wal }, 6);
  } catch { return null; }
}
let reportRunning = false;
/** fix272: ≥ 1 GB in 6 h → the size report again (at most every 6 h), so Disk names the tables that grew */
async function growthAlarm(now = Date.now()) {
  const g = growth6h(now), rep = storedReport();
  if (reportRunning || !reportDue(g?.bytes ?? null, rep ? Date.parse(rep.at) : null, now)) return;
  reportRunning = true;
  logger.warn(`db size: +${GB(g!.bytes)} in ${g!.hours.toFixed(1)} h (file ${GB(files().db)}, WAL ${GB(files().wal)}) — size report now`);
  try { await heavy('db size report', () => sizeReport().then(() => undefined)); } finally { reportRunning = false; }
}
/** today's size row (the largest of the day is kept: the growth is measured on the peaks) */
export async function recordSize(now = Date.now()) {
  const f = files(), v = volume();
  let free: number | null = null;
  try { const p = await pragmasNow(); free = p.freePages * p.pageSize; } catch { /* thread down */ }
  db.prepare(`INSERT INTO db_size_days (day, db_bytes, wal_bytes, free_bytes, vol_free, vol_total, at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET db_bytes = excluded.db_bytes, wal_bytes = excluded.wal_bytes, free_bytes = excluded.free_bytes,
      vol_free = excluded.vol_free, vol_total = excluded.vol_total, at = excluded.at`).run(today(now), f.db, f.wal, free, v?.free ?? null, v?.total ?? null, new Date(now).toISOString());
  db.prepare(`DELETE FROM db_size_days WHERE day < ?`).run(today(now - 120 * 86400000));
  db.prepare(`DELETE FROM db_space_tables WHERE day < ?`).run(today(now - 14 * 86400000));
}
const sizeDays = (days = 30) => (db.prepare(`SELECT day, db_bytes, wal_bytes, free_bytes, vol_free, vol_total FROM db_size_days WHERE day >= ? ORDER BY day`).all(today(Date.now() - days * 86400000)) as any[]);
/** per table / index: bytes now vs the report 7 days before (or the oldest within) */
function tableGrowth(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const days = (db.prepare(`SELECT DISTINCT day FROM db_space_tables ORDER BY day`).all() as any[]).map(r => r.day as string);
    if (days.length < 2) return out;
    const last = days[days.length - 1], from = days.find(d => d >= today(Date.parse(`${last}T00:00:00Z`) - 7 * 86400000)) || days[0];
    if (from === last) return out;
    const a = new Map((db.prepare(`SELECT name, bytes FROM db_space_tables WHERE day = ?`).all(from) as any[]).map(r => [r.name, r.bytes]));
    for (const r of db.prepare(`SELECT name, bytes FROM db_space_tables WHERE day = ?`).all(last) as any[]) out.set(r.name, r.bytes - (a.get(r.name) ?? 0));
  } catch { /* no reports yet */ }
  return out;
}

/* ---------- admin + data health ---------- */

export function dbSpaceStatus() {
  const f = files(), v = volume(), rep = storedReport(), grow = tableGrowth();
  const hist = sizeDays(30).map(r => ({ day: r.day, bytes: r.db_bytes + r.wal_bytes, db: r.db_bytes, wal: r.wal_bytes, free: r.free_bytes }));
  const perDay = growthPerDay(hist.map(h => ({ day: h.day, bytes: h.bytes })), today());
  const g6 = growth6h(), prev = prevReport();
  let convert: any = null;
  try { convert = JSON.parse(meta('convert_result') || 'null'); } catch { /* none */ }
  return {
    files: f, volume: v, perDay, growth7d: perDay != null ? perDay * 7 : null, growth6h: g6,
    verdict: diskVerdict({ volFree: v?.free ?? null, volTotal: v?.total ?? null, dbBytes: f.db, walBytes: f.wal, growth7d: perDay != null ? perDay * 7 : null, perDay6h: g6?.perDay ?? null, truncateAgeMs: truncateAge() }),
    report: rep ? {
      at: rep.at, ms: rep.ms, pageSize: rep.pageSize, pages: rep.pages, freePages: rep.freePages, autoVacuum: rep.autoVacuum, wal: rep.wal ?? null, file: rep.file ?? null,
      prev: prev ? { at: prev.at, wal: prev.wal, file: prev.file, freePages: prev.freePages } : null,
      top: rep.rows.slice(0, 15).map(x => ({ ...x, growth7d: grow.get(x.name) ?? null, sincePrev: prev ? x.bytes - (prev.bytes[x.name] ?? 0) : null }))
    } : null,
    history: hist, checkpoint: ckpt, retention: lastRetention, vacuum: lastVacuum, convert, volumeLatency: volumeLatency()
  };
}

export function diskHealth(): Check[] {
  const s = dbSpaceStatus();
  const v = s.verdict;
  const vol = s.volume;
  const items: string[] = [];
  items.push(`Database file ${GB(s.files.db)} + WAL ${MB(s.files.wal)}${s.report ? ` · free pages ${MB(s.report.freePages * s.report.pageSize)} · incremental vacuum ${s.report.autoVacuum === 2 ? 'on' : 'off'}` : ''}`);
  if (s.checkpoint.lastTruncate) {
    const t = s.checkpoint.lastTruncate;
    items.push(`Last WAL truncate ${t.at.slice(11, 16)} UTC: ${t.busy ? `blocked by a reader (${s.checkpoint.busyStreak} in a row${t.left ? `, ${t.left.toLocaleString('en-US')} frames left` : ''})` : 'done'}, WAL ${MB(t.walAfter)}${t.busyMs ? ` · waited up to ${t.busyMs} ms` : ''}`);
    if (t.busy && s.checkpoint.lastDone) items.push(`Last WAL start-over that worked: ${s.checkpoint.lastDone.at.slice(0, 16).replace('T', ' ')} UTC`);
    // fix273: who held it, and how far the PASSIVE passes got
    if (t.busy) items.push(`Blocked truncate: ${t.passes ?? 1} PASSIVE pass(es) first; reading then: ${t.readers?.length ? t.readers.map(x => `${x.name} (since ${x.since.slice(11, 16)} UTC, ${x.forMin} min)`).join(', ') : 'no long read in the worker (the web\'s reader threads: see "Slow reads (3 h)")'}`);
  }
  if (s.growth6h) items.push(`Last ${s.growth6h.hours.toFixed(1)} h: ${s.growth6h.bytes >= 0 ? '+' : ''}${GB(s.growth6h.bytes)} (${s.growth6h.perDay >= 0 ? '+' : ''}${GB(s.growth6h.perDay)} a day at that rate)${v.daysToFull6h != null ? ` · volume full in ${v.daysToFull6h < 1 ? `${Math.max(1, Math.floor(v.daysToFull6h * 24))} h` : `${Math.floor(v.daysToFull6h)} days`} at that rate` : ''}`);
  // fix273: the WAL an hour after the start (the reply after a deploy)
  try { const w = JSON.parse(meta('wal_1h') || 'null'); if (w) items.push(`WAL 1 h after the start of ${String(w.start).slice(0, 16).replace('T', ' ')} UTC: ${MB(w.wal)} (${w.at.slice(11, 16)} UTC)${w.done ? `, last start-over ${String(w.done).slice(11, 16)} UTC` : ''}`); } catch { /* none */ }
  items.push(volumeLine()); // fix254
  if (s.retention) items.push(`Retention ${s.retention.at.slice(11, 16)} UTC: ${s.retention.deleted.toLocaleString('en-US')} old rows deleted${s.retention.results.length ? ` (${s.retention.results.map(r => `${r.table} ${r.deleted}${r.error ? ' error' : ''}`).join(', ')})` : ''}`);
  if (s.vacuum) items.push(`Vacuum ${s.vacuum.at.slice(11, 16)} UTC: ${MB(s.vacuum.freedPages * s.vacuum.pageSize)} given back, file ${GB(s.vacuum.fileBefore)} → ${GB(s.vacuum.fileAfter)}`);
  if (s.convert) items.push(`Full vacuum ${String(s.convert.at).slice(0, 16).replace('T', ' ')} UTC: ${s.convert.msg}`);
  if (s.report) {
    const p = s.report.prev, since = p ? `since ${p.at.slice(5, 16).replace('T', ' ')} UTC` : '';
    items.push(`Biggest tables and indexes (${s.report.at.slice(0, 16).replace('T', ' ')} UTC${s.report.wal != null ? ` · WAL then ${GB(s.report.wal)}` : ''} · free pages ${MB(s.report.freePages * s.report.pageSize)}${p ? `; growth ${since}` : ''}):`);
    const sign = (n: number) => `${n > 0 ? '+' : ''}${GB(n)}`;
    for (const t of s.report.top) items.push(`${t.name}${t.type === 'index' ? ` (index of ${t.tbl})` : ''}: ${GB(t.bytes)}, ${t.rows.toLocaleString('en-US')} rows${t.sincePrev ? ` · ${sign(t.sincePrev)} ${since}` : ''}${t.growth7d ? ` · ${sign(t.growth7d)} in 7 days` : ''}`);
  }
  const checks: Check[] = [{
    id: 'disk', label: 'Disk',
    level: v.level,
    detail: `${vol ? `Volume ${v.freePct!.toFixed(0)}% free (${GB(vol.free)} of ${GB(vol.total)})` : 'Volume size unknown'} · database ${GB(s.files.db + s.files.wal)}`
      + `${s.growth6h ? ` · last 6 h ${s.growth6h.bytes >= 0 ? '+' : ''}${GB(s.growth6h.bytes)}` : ''}`
      + ` · 7-day growth ${s.growth7d != null ? `${s.growth7d >= 0 ? '+' : ''}${GB(s.growth7d)}` : 'not known yet (needs 2 days)'}`
      + `${v.daysToFull != null ? ` · full in ${Math.floor(v.daysToFull)} days at this rate` : ''}${v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''}`,
    items
  }];
  // fix269: the volume's own latency, by hour, + what the connections run with
  checks.push(volumeHealth(Date.now(), undefined, volumeNotes()));
  // the proof for fix249: no reader-thread read over 500 ms and no slow public request for 3 hours
  const hours = readerHourRows(3);
  let slow = 0;
  try {
    const since = Math.floor(Date.now() / 60_000) - 180;
    slow = Number((db.prepare(`SELECT COALESCE(SUM(n - crawler), 0) AS n FROM slow_requests WHERE minute >= ?`).get(since) as any)?.n || 0);
  } catch { /* no table yet */ }
  const over = hours.reduce((t, h) => t + h.over500, 0), max = Math.max(0, ...hours.map(h => h.maxMs));
  // fix254: + the web thread's longest stall (target: none over 500 ms)
  let stallMs = 0;
  try { stallMs = Math.max(0, ...perfHours('web', 3).map(h => h.worstMs)); } catch { /* no rows */ }
  const worst = hours.slice().sort((a, b) => b.maxMs - a.maxMs)[0];
  checks.push({
    id: 'slow-reads', label: 'Slow reads (3 h)',
    level: !hours.length ? 'ok' : over || slow || stallMs > 500 ? 'warn' : 'ok',
    detail: !hours.length ? 'No numbers yet' : `${over} read(s) over 500 ms in the last 3 h, longest ${max.toLocaleString('en-US')} ms; ${slow} public request(s) over 1 s; longest web stall ${stallMs.toLocaleString('en-US')} ms (target: none of these)`,
    items: [volumeLine(), ...hours.map(h => `${h.hour.slice(11)}:00 UTC: ${h.reads.toLocaleString('en-US')} reads, ${h.over500} over 500 ms, longest ${h.maxMs} ms`), ...(worst?.top && worst.maxMs > 500 ? [`Longest: ${worst.top}`] : [])]
  });
  return checks;
}

/** fix269: how the connections are set up against a slow volume (data health "Volume latency") */
function volumeNotes(): string[] {
  const p = cachePlan();
  let sync = '?';
  try { sync = ['OFF', 'NORMAL', 'FULL', 'EXTRA'][Number(Object.values(db.prepare('PRAGMA synchronous').get() as any)[0])] || '?'; } catch { /* ignore */ }
  const ac = autoCheckpointPages();
  return [
    `Reader threads' page cache: big pool ${p.readers.big} × ${p.bigMb} MB, small pool ${p.readers.small} × ${p.smallMb} MB (${p.readersTotalMb.toLocaleString('en-US')} MB at most, filled by pages read) · worker ${p.workerMb} MB · web ${p.webMb} MB · file mapped up to ${p.mmapMb.toLocaleString('en-US')} MB · container limit ${p.limitMb != null ? `${p.limitMb.toLocaleString('en-US')} MB` : 'not set'}`,
    `Writes: synchronous ${sync} (no fsync per commit) · WAL written back by the upkeep thread only${ac === 0 ? '' : ac == null ? ' (thread not started yet)' : ' — upkeep thread down: SQLite checkpoints itself'}`
  ];
}

/* ---------- schedule (jobs.ts) ---------- */

export function startDbSpaceScheduler() {
  // fix272: PASSIVE every minute (a few seconds of frames each time, so TRUNCATE finds it caught up), TRUNCATE every
  // 5 min while the WAL is over 64 MB (else every 30 min)
  every('db checkpoint', () => checkpoint('PASSIVE'), 60 * 1000).unref();
  after('db checkpoint', () => checkpoint('TRUNCATE'), 2 * 60 * 1000).unref();
  every('db checkpoint', () => checkpointTick(), 5 * 60 * 1000).unref();
  // fix273: the WAL starts over as soon as a long read (the backup, a job thread) ends
  onLongReadsEnded(() => { setTimeout(() => { void checkpoint('TRUNCATE'); }, 5000).unref(); });
  // fix273: the WAL size 1 h after the start, kept for the reply / data health
  after('db wal 1h', () => { try { setMeta('wal_1h', JSON.stringify({ at: new Date().toISOString(), start: new Date(Date.now() - process.uptime() * 1000).toISOString(), wal: files().wal, done: ckpt.lastDone?.at ?? null })); logger.info(`db: WAL 1 h after the start ${MB(files().wal)}`); } catch { /* read-only */ } }, 3600 * 1000).unref();
  after('db size', () => recordSize(), 3 * 60 * 1000).unref();
  every('db size', () => recordSize(), 3600 * 1000).unref();
  // fix272: the size every 10 minutes (6-hour growth) and a size report of its own when 1 GB+ grew in 6 h
  after('db size', () => recordSizeRow(), 60 * 1000).unref();
  every('db size', () => { recordSizeRow(); return growthAlarm(); }, 10 * 60 * 1000).unref();
  after('db retention', () => retentionTick(), 6 * 60 * 1000).unref();
  every('db retention', () => retentionTick(), 3600 * 1000).unref();
  every('db vacuum', () => vacuumTick(), 10 * 60 * 1000).unref();
  // fix254: the volume's read / fsync latency
  after('volume latency', () => volumeTick(), 2 * 60 * 1000).unref();
  every('volume latency', () => volumeTick(), 10 * 60 * 1000).unref(); // fix269: was 15 min
  // the size report: once a day at 01:10 UTC (dbstat reads every page), and 30 min after a start when the last is old
  const report = () => heavy('db size report', () => sizeReport().then(() => undefined));
  after('db size report', () => { const r = storedReport(); if (!r || Date.now() - Date.parse(r.at) > 20 * 3600 * 1000) return report(); }, 30 * 60 * 1000).unref();
  every('db size report', () => { const d = new Date(); if (d.getUTCHours() === 1 && d.getUTCMinutes() >= 10 && d.getUTCMinutes() < 20) return report(); }, 10 * 60 * 1000).unref();
}

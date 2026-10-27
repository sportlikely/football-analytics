/**
 * fix210: the event-loop and memory history of both processes, kept in the database so it survives restarts and
 * either process can read the other's (data health runs in the worker, /api/perf in the web process).
 * - perf_hours: per process and hour — stalls over 300 ms, the worst, the highest heap and rss (perf.ts buckets,
 *   written every minute by each process; 48 hours kept)
 * - worker_exits: every time the worker process ended (written by the web process): code, signal, the reason read
 *   from its last stderr lines ("heap limit", "killed (container memory)" …) and those lines (30 days kept)
 */
import { db } from '../db';
import logger from '../utils/logger';
import { hourBuckets } from './perf';
import { isWeb } from './role';
import { deferred } from './deferredWrites';
import { readerHours } from './pageReader';

db.exec(`CREATE TABLE IF NOT EXISTS perf_hours (proc TEXT NOT NULL, hour TEXT NOT NULL, stalls INTEGER NOT NULL, worst_ms INTEGER NOT NULL,
  heap_max_mb INTEGER NOT NULL, rss_max_mb INTEGER NOT NULL, top_json TEXT, PRIMARY KEY (proc, hour))`);
db.exec(`CREATE TABLE IF NOT EXISTS worker_exits (at INTEGER NOT NULL, code INTEGER, signal TEXT, reason TEXT NOT NULL, ran_min INTEGER NOT NULL,
  heap_limit_mb INTEGER, stderr TEXT)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_worker_exits_at ON worker_exits(at)`);
// fix249: the web's reader threads per hour (reads, over 500 ms, the longest and what it was; 14 days: utils/retention.ts)
db.exec(`CREATE TABLE IF NOT EXISTS reader_hours (hour TEXT PRIMARY KEY, reads INTEGER NOT NULL, over500 INTEGER NOT NULL, max_ms INTEGER NOT NULL, top TEXT)`);

export type Proc = 'web' | 'worker';

/** write this process's last two hourly buckets (the current hour and the one that just ended) */
export function saveHours(proc: Proc) {
  try {
    // (a restart within the hour starts a new bucket: the larger numbers are kept)
    // fix210b: the web process's rows are written by the worker (services/deferredWrites.ts)
    const up = deferred(`INSERT INTO perf_hours (proc, hour, stalls, worst_ms, heap_max_mb, rss_max_mb, top_json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proc, hour) DO UPDATE SET stalls = MAX(stalls, excluded.stalls), worst_ms = MAX(worst_ms, excluded.worst_ms),
        heap_max_mb = MAX(heap_max_mb, excluded.heap_max_mb), rss_max_mb = MAX(rss_max_mb, excluded.rss_max_mb),
        top_json = CASE WHEN excluded.worst_ms >= worst_ms THEN excluded.top_json ELSE top_json END`);
    for (const b of hourBuckets().slice(-2)) up.run(proc, b.hour, b.stalls, b.worstMs, b.heapMaxMb, b.rssMaxMb, JSON.stringify(b.top));
    // fix249: the reader threads' hours (the web process only; a restart within the hour keeps the larger numbers)
    if (proc === 'web') {
      const rh = deferred(`INSERT INTO reader_hours (hour, reads, over500, max_ms, top) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(hour) DO UPDATE SET reads = MAX(reads, excluded.reads), over500 = MAX(over500, excluded.over500),
          top = CASE WHEN excluded.max_ms >= max_ms THEN excluded.top ELSE top END, max_ms = MAX(max_ms, excluded.max_ms)`);
      for (const h of readerHours().slice(-2)) rh.run(h.hour, h.reads, h.over500, h.maxMs, h.top);
    }
    if (!isWeb) db.prepare(`DELETE FROM perf_hours WHERE hour < ?`).run(new Date(Date.now() - 48 * 3600 * 1000).toISOString().slice(0, 13));
  } catch (e: any) { logger.warn(`perf hours: ${e?.message || e}`); }
}
/** every minute (each process calls it once at start) */
export function startPerfHistory(proc: Proc) {
  setInterval(() => saveHours(proc), 60 * 1000).unref();
}

/** fix249: the reader threads' last `hours` hours, oldest first */
export function readerHourRows(hours = 3): { hour: string; reads: number; over500: number; maxMs: number; top: string | null }[] {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 13);
  try {
    return (db.prepare(`SELECT hour, reads, over500, max_ms, top FROM reader_hours WHERE hour >= ? ORDER BY hour`).all(since) as any[])
      .map(r => ({ hour: r.hour, reads: r.reads, over500: r.over500, maxMs: r.max_ms, top: r.top }));
  } catch { return []; }
}

export type HourRow = { hour: string; stalls: number; worstMs: number; heapMaxMb: number; rssMaxMb: number; top: { ms: number; job: string | null }[] };
/** the last `hours` hourly rows of a process, oldest first */
export function perfHours(proc: Proc, hours = 24): HourRow[] {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString().slice(0, 13);
  return (db.prepare(`SELECT hour, stalls, worst_ms, heap_max_mb, rss_max_mb, top_json FROM perf_hours WHERE proc = ? AND hour >= ? ORDER BY hour`).all(proc, since) as any[])
    .map(r => ({ hour: r.hour, stalls: r.stalls, worstMs: r.worst_ms, heapMaxMb: r.heap_max_mb, rssMaxMb: r.rss_max_mb, top: (() => { try { return JSON.parse(r.top_json || '[]'); } catch { return []; } })() }));
}

/** what the worker's last stderr lines and its exit say about why it ended */
export function exitReason(code: number | null, signal: string | null, stderr: string[]): string {
  const text = stderr.join('\n');
  if (/Reached heap limit|JavaScript heap out of memory|Allocation failed/i.test(text)) return 'out of memory: heap limit';
  if (signal === 'SIGKILL') return 'killed (SIGKILL: the container ran out of memory, or a deploy)';
  if (signal === 'SIGABRT') return 'aborted (SIGABRT: usually the heap limit; no message on stderr)';
  if (signal === 'SIGTERM') return 'stopped (SIGTERM)';
  if (/Error|exception/i.test(text)) return `crashed: ${(text.split('\n').reverse().find(l => /Error|exception/i.test(l)) || '').trim().slice(0, 160)}`;
  return code === 0 ? 'exited normally' : `exited with code ${code}${signal ? ` (${signal})` : ''}`;
}

export function saveWorkerExit(x: { code: number | null; signal: string | null; reason: string; ranMin: number; heapLimitMb: number | null; stderr: string[] }) {
  try {
    // (from the web process: written by the next worker, as soon as it is up)
    deferred(`INSERT INTO worker_exits (at, code, signal, reason, ran_min, heap_limit_mb, stderr) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), x.code, x.signal, x.reason, x.ranMin, x.heapLimitMb, x.stderr.join('\n').slice(-8000));
    if (!isWeb) db.prepare(`DELETE FROM worker_exits WHERE at < ?`).run(Date.now() - 30 * 86400000);
  } catch (e: any) { logger.warn(`worker exits: ${e?.message || e}`); }
}

export type WorkerExit = { at: string; code: number | null; signal: string | null; reason: string; ranMin: number; heapLimitMb: number | null; stderr: string[] };
/** worker exits since `ms` ago (newest first), without the planned stops (deploys) */
export function workerExits(ms = 24 * 3600 * 1000): WorkerExit[] {
  return (db.prepare(`SELECT * FROM worker_exits WHERE at >= ? ORDER BY at DESC LIMIT 50`).all(Date.now() - ms) as any[])
    .filter(r => r.reason !== 'stopped (SIGTERM)')
    .map(r => ({ at: new Date(r.at).toISOString(), code: r.code, signal: r.signal, reason: r.reason, ranMin: r.ran_min, heapLimitMb: r.heap_limit_mb, stderr: String(r.stderr || '').split('\n').slice(-50) }));
}

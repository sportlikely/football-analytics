/**
 * fix243: stored views read off the web thread (workers/pageReader.ts: its own read-only connection; fix248c: a pool).
 * getPage(…, { views }) asks for the views a request will send before it returns, so the request path only sends
 * strings already in memory. Without the thread (tests, PAGE_READER=0, the thread failed) the read is the old
 * synchronous one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import logger from '../utils/logger';
import { DB_FILE } from '../db';
import { cachePlan } from '../utils/dbTune';

export type ReadRow = { text: string; etag: string | null; gz: Buffer | null };

function threadFile(): { file: string; execArgv?: string[] } | null {
  const js = path.join(__dirname, '../workers/pageReader.js');
  if (fs.existsSync(js)) return { file: js };
  const ts = path.join(__dirname, '../workers/pageReader.ts');
  if (fs.existsSync(ts)) return { file: ts, execArgv: ['-r', 'ts-node/register/transpile-only'] };
  return null;
}

/*
 * fix248c: a pool of reader threads (PAGE_READERS, default 2), each with its own read-only connection; a read goes to
 * the thread with the fewest reads in flight. With one thread a slow read (1,755 ms live, 27 Oct) held every read
 * queued behind it.
 *
 * fix263: two pools. Live 28 Oct: "SELECT built_at FROM page_cache …" 1.2–1.3 s for one row and a 9 KB state row
 * 1.47 s with the volume answering in 31.7 ms (p95) — small reads queued behind 5.7 MB state parts and multi-MB views
 * in the same threads. Now:
 *  - "small" (READER_THREADS / READER_SMALL, default 2): one-row lookups and rows known to be under 64 KB — what a
 *    request reads (a stored page's time / ETag, a small view, a kept route copy under 64 KB);
 *  - "big" (READER_BIG, default 2): shared states and their parts, views and copies of 64 KB or more (or of unknown
 *    size), paged table reads.
 * Each thread runs one read at a time; the rest wait in the pool's queue, where a request's read ('req') always goes
 * before a background load ('bg': state loads), so a request waits for at most the read already running. A read over
 * 500 ms is logged with its pool, its wait in the queue and its time in the thread; a "small" read that returned
 * 64 KB or more is counted (smallOver64) and logged once an hour per statement (it belongs in "big").
 */
export type Pool = 'small' | 'big';
export type Prio = 'req' | 'bg';
export const SMALL_BYTES = 64 * 1024;
const envN = (v: string | undefined, d: number) => Math.max(1, Math.min(8, Number(v) || d));
const SIZES: Record<Pool, number> = {
  small: envN(process.env.READER_SMALL || process.env.READER_THREADS || process.env.PAGE_READERS, 2), // fix250: READER_THREADS
  big: envN(process.env.READER_BIG, 2)
};
const SIZE = SIZES.small;
type Job = { id: number; msg: Record<string, unknown>; queuedAt: number };
type Slot = { pool: Pool; w: Worker | null; failedAt: number; inflight: number; job: Job | null };
const slots: Record<Pool, Slot[]> = {
  small: Array.from({ length: SIZES.small }, () => ({ pool: 'small' as Pool, w: null, failedAt: 0, inflight: 0, job: null })),
  big: Array.from({ length: SIZES.big }, () => ({ pool: 'big' as Pool, w: null, failedAt: 0, inflight: 0, job: null }))
};
const queues: Record<Pool, Record<Prio, Job[]>> = { small: { req: [], bg: [] }, big: { req: [], bg: [] } };
let seq = 0;
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; slot: Slot | null; pool: Pool; prio: Prio }>();
const stats = { reads: 0, errors: 0, maxMs: 0, restarts: 0, over500: 0, smallOver64: 0 };
const poolStats: Record<Pool, { reads: number; over500: number; maxMs: number; maxWaitMs: number; queuedMax: number }> = {
  small: { reads: 0, over500: 0, maxMs: 0, maxWaitMs: 0, queuedMax: 0 },
  big: { reads: 0, over500: 0, maxMs: 0, maxWaitMs: 0, queuedMax: 0 }
};
// the slowest reads (what they were), for /api/perf
// fix250: every read over 500 ms is logged with its SQL (or stored key), the time in the thread and the bytes it returned
// ("slow read 812 ms (thread 790 ms, 3,412 KB): SELECT …"; one line per statement a minute), the last 20 in /api/perf
// fix263: + its pool and its wait in the queue ("slow read 812 ms [small, waited 20 ms] (thread 790 ms, 3 KB): …")
type SlowRead = { ms: number; what: string; at: string; threadMs?: number; kb?: number; pool?: Pool; waitMs?: number };
const slowest: SlowRead[] = [];
const slowLog: { at: string; ms: number; threadMs: number | null; kb: number | null; what: string; pool: Pool; waitMs: number }[] = [];
const loggedAt = new Map<string, number>();
const noteSlow = (ms: number, what: string, threadMs: number | undefined, bytes: number | undefined, pool: Pool, waitMs: number) => {
  if (ms > 500) {
    stats.over500++; poolStats[pool].over500++;
    const kb = bytes != null ? Math.round(bytes / 1024) : null, tms = threadMs != null ? Math.round(threadMs) : null;
    slowLog.push({ at: new Date().toISOString(), ms, threadMs: tms, kb, what: what.slice(0, 300), pool, waitMs });
    if (slowLog.length > 20) slowLog.shift();
    const k = what.slice(0, 120);
    if (Date.now() - (loggedAt.get(k) || 0) > 60_000) {
      loggedAt.set(k, Date.now()); if (loggedAt.size > 500) loggedAt.clear();
      logger.warn(`slow read ${ms} ms [${pool}, waited ${waitMs} ms] (thread ${tms ?? "?"} ms, ${kb ?? "?"} KB): ${what.slice(0, 300)}`);
    }
  }
  if (slowest.length >= 5 && ms <= slowest[slowest.length - 1].ms) return;
  slowest.push({ ms, what: what.slice(0, 160), at: new Date().toISOString(), threadMs: threadMs != null ? Math.round(threadMs) : undefined, kb: bytes != null ? Math.round(bytes / 1024) : undefined, pool, waitMs });
  slowest.sort((a, b) => b.ms - a.ms);
  slowest.length = Math.min(5, slowest.length);
};
// fix263: a "small" read that came back with 64 KB or more (logged once an hour per statement: route it to "big")
const bigInSmall = new Map<string, number>();
function noteSmallSize(what: string, bytes: number | undefined) {
  if (bytes == null || bytes < SMALL_BYTES) return;
  stats.smallOver64++;
  const k = what.slice(0, 120);
  if (Date.now() - (bigInSmall.get(k) || 0) < 3600_000) return;
  bigInSmall.set(k, Date.now()); if (bigInSmall.size > 200) bigInSmall.clear();
  logger.warn(`reader: ${Math.round(bytes / 1024)} KB read in the small pool (belongs in big): ${what.slice(0, 200)}`);
}
/*
 * fix249: the same per hour (reads, over 500 ms, the longest and what it was), written to reader_hours every minute
 * (perfHistory.saveHours) — the data-health proof "no read over 500 ms for 3 h" reads it in the worker
 */
export type ReaderHour = { hour: string; reads: number; over500: number; maxMs: number; top: string | null };
const hours: ReaderHour[] = [];
function noteHour(ms: number, what: string) {
  const hour = new Date().toISOString().slice(0, 13);
  let h = hours[hours.length - 1];
  if (!h || h.hour !== hour) { h = { hour, reads: 0, over500: 0, maxMs: 0, top: null }; hours.push(h); if (hours.length > 4) hours.shift(); }
  h.reads++;
  if (ms > 500) h.over500++;
  if (ms > h.maxMs) { h.maxMs = ms; h.top = what.slice(0, 200); }
}
export const readerHours = (): ReaderHour[] => hours.map(h => ({ ...h }));
/*
 * fix269: the proof that the hot set is in memory — the same statement + arguments (or stored key) read again within
 * the hour: its time in the thread (the disk part) should be near 0 the second time. first = a read not seen in the
 * last hour; repeat = seen before. A repeat over 50 ms in the thread was not in that thread's cache (or the map).
 */
const seenAt = new Map<string, number>();
type ReadClass = { reads: number; over50: number; over500: number; maxThreadMs: number; sumThreadMs: number };
const repeatStats: Record<'first' | 'repeat', ReadClass> = {
  first: { reads: 0, over50: 0, over500: 0, maxThreadMs: 0, sumThreadMs: 0 },
  repeat: { reads: 0, over50: 0, over500: 0, maxThreadMs: 0, sumThreadMs: 0 }
};
function noteRepeat(what: string, threadMs: number | undefined) {
  if (threadMs == null) return;
  const now = Date.now(), k = what.slice(0, 240), seen = seenAt.get(k);
  const c = repeatStats[seen && now - seen < 3600_000 ? 'repeat' : 'first'];
  c.reads++; c.sumThreadMs += threadMs; c.maxThreadMs = Math.max(c.maxThreadMs, Math.round(threadMs));
  if (threadMs > 50) c.over50++;
  if (threadMs > 500) c.over500++;
  seenAt.delete(k); seenAt.set(k, now);
  if (seenAt.size > 20_000) seenAt.delete(seenAt.keys().next().value as string);
}
const classOut = (c: ReadClass) => ({ reads: c.reads, over50: c.over50, over500: c.over500, maxThreadMs: c.maxThreadMs, avgThreadMs: c.reads ? Math.round((c.sumThreadMs / c.reads) * 10) / 10 : 0 });
export const repeatReads = () => ({ first: classOut(repeatStats.first), repeat: classOut(repeatStats.repeat) });
const poolStatus = (p: Pool) => ({ size: SIZES[p], threads: slots[p].filter(x => !!x.w).length, busy: slots[p].filter(x => !!x.job).length, queued: queues[p].req.length + queues[p].bg.length, ...poolStats[p] });
/** /api/perf: the reader threads (top-level fields = the small pool, as before; `pools` = both) */
export const pageReaderStatus = () => ({
  on: slots.small.some(x => !!x.w), threads: slots.small.filter(x => !!x.w).length, size: SIZE, pending: pending.size,
  inflight: slots.small.map(x => x.inflight), ...stats, pools: { small: poolStatus('small'), big: poolStatus('big') }, slowest, slowLog: slowLog.slice().reverse(),
  cache: cachePlan({ small: SIZES.small, big: SIZES.big }), repeatReads: repeatReads() // fix269
});

function failSlot(slot: Slot, e: Error) {
  for (const [id, p] of pending) if (p.slot === slot) { clearTimeout(p.timer); pending.delete(id); p.reject(e); }
  slot.inflight = 0; slot.job = null;
  dispatch(slot.pool);
}
function start(slot: Slot): Worker | null {
  if (slot.w) return slot.w;
  if (process.env.PAGE_READER === '0' || !isMainThread || Date.now() - slot.failedAt < 60_000) return null;
  const f = threadFile();
  if (!f) return null;
  try {
    const t = new Worker(f.file, { workerData: { file: DB_FILE, pool: slot.pool, readers: { small: SIZES.small, big: SIZES.big } }, execArgv: f.execArgv, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    t.unref();
    t.on('message', (m: any) => {
      if (slot.job?.id === m?.id) { slot.job = null; slot.inflight = 0; }
      const p = pending.get(m?.id);
      if (p) {
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) { stats.errors++; p.reject(new Error(m.error)); } else p.resolve(m);
      }
      if (!slot.job) t.unref();
      dispatch(slot.pool);
    });
    const down = (e: Error) => { if (slot.w === t) { slot.w = null; slot.failedAt = Date.now(); stats.restarts++; } failSlot(slot, e); };
    t.on('error', e => { logger.warn(`page reader: ${e.message}`); down(e); });
    t.on('exit', c => down(new Error(`page reader stopped (${c})`)));
    slot.w = t;
  } catch (e: any) { logger.warn(`page reader: ${e?.message || e}`); slot.failedAt = Date.now(); return null; }
  return slot.w;
}
/** the pool's threads that are up (started on first use) */
const upSlots = (pool: Pool) => slots[pool].filter(s => !!start(s));
/** is a thread there (else the caller reads synchronously) */
export const pageReaderOn = () => upSlots('small').length > 0;
/** hand queued reads to the pool's free threads: requests first, then background loads */
function dispatch(pool: Pool) {
  const q = queues[pool];
  for (const slot of slots[pool]) {
    if (slot.job || !start(slot)) continue;
    let job: Job | undefined, p: ReturnType<typeof pending.get>;
    do { job = q.req.shift() || q.bg.shift(); p = job && pending.get(job.id); } while (job && !p); // (timed out while queued)
    if (!job || !p) return;
    p.slot = slot; slot.job = job; slot.inflight = 1;
    (job.msg as any).waitMs = Date.now() - job.queuedAt;
    slot.w!.ref(); // a read in flight keeps the thread (unref'd again when idle)
    slot.w!.postMessage({ id: job.id, ...job.msg });
  }
}
/** the pool a stored row of this size goes to (unknown size: big) */
export const poolForBytes = (bytes: number | null | undefined): Pool => (bytes != null && bytes < SMALL_BYTES ? 'small' : 'big');

/**
 * one stored row (key + built_at) read in the thread; rejects when the thread is not there or does not answer in 10 s.
 * fix263: `pool` — the caller knows the view's size from the worker's list (pageCache hot meta): under 64 KB "small",
 * else (or unknown) "big"; a request's read either way ('req': before any background load).
 */
export function readStored(key: string, builtAt: number, pool: Pool = 'big', prio: Prio = 'req'): Promise<ReadRow | null> {
  // fix269: prio 'bg' = the web refreshing a copy it holds (pageCache.ts): every request's read goes first
  return ask({ key, builtAt }, pool, prio).then(async m => {
    const r = m.row;
    if (!r) return null;
    // fix250: a view over 2 MB is stored in parts (pageCache.ts): each part read on its own, spread over the threads
    const n = partsCount(r.text);
    const text = n ? (await Promise.all(Array.from({ length: n }, (_, i) => ask({ key: partKey(key, i), builtAt }, 'big', prio).then(p => { if (!p.row) throw new Error(`${key}: part ${i} missing`); return p.row.text as string; })))).join("") : r.text;
    return { text, etag: r.etag, gz: r.gz ? asBuffer(r.gz) : null };
  });
}
/** fix250: a stored view over SPLIT_CHARS is kept as a marker row + parts (no single read is slow) */
export const SPLIT_CHARS = 2 * 1024 * 1024;
const PARTS_MARK = '\u0003parts:'; // never at the start of a JSON / HTML text
export const partKey = (key: string, i: number) => `${key}~${i}`;
export const partsMarker = (n: number) => `${PARTS_MARK}${n}`;
export const partsCount = (text: string) => (text.startsWith(PARTS_MARK) ? Number(text.slice(PARTS_MARK.length)) || 0 : 0);
/** a Uint8Array from the thread as a Buffer (no copy) */
export const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
/**
 * fix248: one read-only statement run in the thread (`all` = every row, else the first or null). Rejects when the
 * thread is not there (the caller reads synchronously then) or does not answer in 10 s. BLOBs come back as Uint8Array.
 * fix263: `pool` "small" (default: one-row lookups) or "big" (states, parts, paged reads); `prio` 'bg' for loads no
 * request waits on (they go after every request's read in that pool).
 */
export function readSql<T = any>(sql: string, args: (string | number | null)[] = [], all = false, pool: Pool = 'small', prio: Prio = 'req'): Promise<T> {
  return ask({ sql, args, all }, pool, prio).then(m => m.out as T);
}
function ask(msg: { sql?: string; key?: string; [k: string]: unknown }, pool: Pool, prio: Prio): Promise<any> {
  if (!upSlots(pool).length) {
    // a pool that cannot start its threads lends the other one's (the caller reads synchronously only when neither runs)
    const other: Pool = pool === 'small' ? 'big' : 'small';
    if (!upSlots(other).length) return Promise.reject(new Error('no page reader'));
    pool = other;
  }
  const id = ++seq, t0 = Date.now();
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id); stats.errors++;
      // still queued: out of the queue (a running read is left to finish; its answer is dropped)
      for (const q of [queues[pool].req, queues[pool].bg]) { const i = q.findIndex(j => j.id === id); if (i >= 0) q.splice(i, 1); }
      reject(new Error('page reader timeout'));
    }, 10_000);
    timer.unref();
    pending.set(id, {
      resolve: r => {
        const ms = Date.now() - t0, what = msg.sql ? `${msg.sql} [${JSON.stringify((msg as any).args || []).slice(0, 120)}]` : `page ${msg.key}`;
        const waitMs = Math.max(0, ms - Math.round(r?.ms ?? 0));
        const ps = poolStats[pool];
        stats.reads++; stats.maxMs = Math.max(stats.maxMs, ms); ps.reads++; ps.maxMs = Math.max(ps.maxMs, ms); ps.maxWaitMs = Math.max(ps.maxWaitMs, waitMs);
        if (pool === 'small') noteSmallSize(what, r?.bytes);
        noteSlow(ms, what, r?.ms, r?.bytes, pool, waitMs);
        noteRepeat(what, r?.ms);
        noteHour(ms, `${pool} · ${r?.ms != null ? `thread ${Math.round(r.ms)} ms · ` : ''}${what}`);
        resolve(r);
      },
      reject, timer, slot: null, pool, prio
    });
    const q = queues[pool];
    q[prio].push({ id, msg, queuedAt: t0 });
    poolStats[pool].queuedMax = Math.max(poolStats[pool].queuedMax, q.req.length + q.bg.length);
    dispatch(pool);
  });
}

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
 */
const SIZE = Math.max(1, Math.min(8, Number(process.env.READER_THREADS || process.env.PAGE_READERS) || 2)); // fix250: READER_THREADS
type Slot = { w: Worker | null; failedAt: number; inflight: number };
const slots: Slot[] = Array.from({ length: SIZE }, () => ({ w: null, failedAt: 0, inflight: 0 }));
let seq = 0;
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; slot: Slot }>();
const stats = { reads: 0, errors: 0, maxMs: 0, restarts: 0, over500: 0 };
// the slowest reads (what they were), for /api/perf
// fix250: every read over 500 ms is logged with its SQL (or stored key), the time in the thread and the bytes it returned
// ("slow read 812 ms (thread 790 ms, 3,412 KB): SELECT …"; one line per statement a minute), the last 20 in /api/perf
const slowest: { ms: number; what: string; at: string; threadMs?: number; kb?: number }[] = [];
const slowLog: { at: string; ms: number; threadMs: number | null; kb: number | null; what: string }[] = [];
const loggedAt = new Map<string, number>();
const noteSlow = (ms: number, what: string, threadMs?: number, bytes?: number) => {
  if (ms > 500) {
    stats.over500++;
    const kb = bytes != null ? Math.round(bytes / 1024) : null, tms = threadMs != null ? Math.round(threadMs) : null;
    slowLog.push({ at: new Date().toISOString(), ms, threadMs: tms, kb, what: what.slice(0, 300) });
    if (slowLog.length > 20) slowLog.shift();
    const k = what.slice(0, 120);
    if (Date.now() - (loggedAt.get(k) || 0) > 60_000) {
      loggedAt.set(k, Date.now()); if (loggedAt.size > 500) loggedAt.clear();
      logger.warn(`slow read ${ms} ms (thread ${tms ?? "?"} ms, ${kb ?? "?"} KB): ${what.slice(0, 300)}`);
    }
  }
  if (slowest.length >= 5 && ms <= slowest[slowest.length - 1].ms) return;
  slowest.push({ ms, what: what.slice(0, 160), at: new Date().toISOString(), threadMs: threadMs != null ? Math.round(threadMs) : undefined, kb: bytes != null ? Math.round(bytes / 1024) : undefined });
  slowest.sort((a, b) => b.ms - a.ms);
  slowest.length = Math.min(5, slowest.length);
};
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
/** /api/perf: the reader threads */
export const pageReaderStatus = () => ({ on: slots.some(x => !!x.w), threads: slots.filter(x => !!x.w).length, size: SIZE, pending: pending.size, inflight: slots.map(x => x.inflight), ...stats, slowest, slowLog: slowLog.slice().reverse() });

function failSlot(slot: Slot, e: Error) {
  for (const [id, p] of pending) if (p.slot === slot) { clearTimeout(p.timer); pending.delete(id); p.reject(e); }
  slot.inflight = 0;
}
function start(slot: Slot): Worker | null {
  if (slot.w) return slot.w;
  if (process.env.PAGE_READER === '0' || !isMainThread || Date.now() - slot.failedAt < 60_000) return null;
  const f = threadFile();
  if (!f) return null;
  try {
    const t = new Worker(f.file, { workerData: { file: DB_FILE }, execArgv: f.execArgv, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    t.unref();
    t.on('message', (m: any) => {
      const p = pending.get(m?.id);
      if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) { stats.errors++; p.reject(new Error(m.error)); return; }
      p.resolve(m);
    });
    const down = (e: Error) => { if (slot.w === t) { slot.w = null; slot.failedAt = Date.now(); stats.restarts++; } failSlot(slot, e); };
    t.on('error', e => { logger.warn(`page reader: ${e.message}`); down(e); });
    t.on('exit', c => down(new Error(`page reader stopped (${c})`)));
    slot.w = t;
  } catch (e: any) { logger.warn(`page reader: ${e?.message || e}`); slot.failedAt = Date.now(); return null; }
  return slot.w;
}
/** the least busy thread that is up (started on first use) */
function pick(): Slot | null {
  let best: Slot | null = null;
  for (const slot of slots) if (start(slot) && (!best || slot.inflight < best.inflight)) best = slot;
  return best;
}
/** is a thread there (else the caller reads synchronously) */
export const pageReaderOn = () => !!pick();

/** one stored row (key + built_at) read in the thread; rejects when the thread is not there or does not answer in 10 s */
export function readStored(key: string, builtAt: number): Promise<ReadRow | null> {
  return ask({ key, builtAt }).then(async m => {
    const r = m.row;
    if (!r) return null;
    // fix250: a view over 2 MB is stored in parts (pageCache.ts): each part read on its own, spread over the threads
    const n = partsCount(r.text);
    const text = n ? (await Promise.all(Array.from({ length: n }, (_, i) => ask({ key: partKey(key, i), builtAt }).then(p => { if (!p.row) throw new Error(`${key}: part ${i} missing`); return p.row.text as string; })))).join("") : r.text;
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
 */
export function readSql<T = any>(sql: string, args: (string | number | null)[] = [], all = false): Promise<T> {
  return ask({ sql, args, all }).then(m => m.out as T);
}
function ask(msg: { sql?: string; key?: string; [k: string]: unknown }): Promise<any> {
  const slot = pick();
  const t = slot?.w;
  if (!slot || !t) return Promise.reject(new Error('no page reader'));
  const id = ++seq, t0 = Date.now();
  slot.inflight++;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.delete(id)) { stats.errors++; reject(new Error('page reader timeout')); } }, 10_000);
    timer.unref();
    pending.set(id, {
      resolve: r => {
        const ms = Date.now() - t0, what = msg.sql ? `${msg.sql} [${JSON.stringify((msg as any).args || []).slice(0, 120)}]` : `page ${msg.key}`;
        stats.reads++; stats.maxMs = Math.max(stats.maxMs, ms); noteSlow(ms, what, r?.ms, r?.bytes); noteHour(ms, r?.ms != null ? `thread ${Math.round(r.ms)} ms · ${what}` : what); resolve(r);
      },
      reject, timer, slot
    });
    t.ref(); // a read in flight keeps the thread (unref'd again when idle)
    t.postMessage({ id, ...msg });
  }).finally(() => { slot.inflight = Math.max(0, slot.inflight - 1); if (!slot.inflight) slot.w?.unref(); });
}

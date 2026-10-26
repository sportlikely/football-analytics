/**
 * fix243: stored views read off the web thread (workers/pageReader.ts: one thread, its own read-only connection).
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

let w: Worker | null = null;
let failedAt = 0;
let seq = 0;
const pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const stats = { reads: 0, errors: 0, maxMs: 0, restarts: 0 };
/** /api/perf: the reader thread */
export const pageReaderStatus = () => ({ on: !!w, pending: pending.size, ...stats });

function failAll(e: Error) {
  for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.reject(e); }
}
function thread(): Worker | null {
  if (w) return w;
  if (process.env.PAGE_READER === '0' || !isMainThread || Date.now() - failedAt < 60_000) return null;
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
    const down = (e: Error) => { if (w === t) { w = null; failedAt = Date.now(); stats.restarts++; } failAll(e); };
    t.on('error', e => { logger.warn(`page reader: ${e.message}`); down(e); });
    t.on('exit', c => down(new Error(`page reader stopped (${c})`)));
    w = t;
  } catch (e: any) { logger.warn(`page reader: ${e?.message || e}`); failedAt = Date.now(); return null; }
  return w;
}
/** is the thread there (else the caller reads synchronously) */
export const pageReaderOn = () => !!thread();

/** one stored row (key + built_at) read in the thread; rejects when the thread is not there or does not answer in 10 s */
export function readStored(key: string, builtAt: number): Promise<ReadRow | null> {
  return ask({ key, builtAt }).then(m => {
    const r = m.row;
    return r ? { text: r.text, etag: r.etag, gz: r.gz ? asBuffer(r.gz) : null } : null;
  });
}
/** a Uint8Array from the thread as a Buffer (no copy) */
export const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
/**
 * fix248: one read-only statement run in the thread (`all` = every row, else the first or null). Rejects when the
 * thread is not there (the caller reads synchronously then) or does not answer in 10 s. BLOBs come back as Uint8Array.
 */
export function readSql<T = any>(sql: string, args: (string | number | null)[] = [], all = false): Promise<T> {
  return ask({ sql, args, all }).then(m => m.out as T);
}
function ask(msg: object): Promise<any> {
  const t = thread();
  if (!t) return Promise.reject(new Error('no page reader'));
  const id = ++seq, t0 = Date.now();
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); stats.errors++; reject(new Error('page reader timeout')); }, 10_000);
    timer.unref();
    pending.set(id, {
      resolve: r => { stats.reads++; stats.maxMs = Math.max(stats.maxMs, Date.now() - t0); resolve(r); },
      reject, timer
    });
    t.ref(); // a read in flight keeps the thread (unref'd again when idle)
    t.postMessage({ id, ...msg });
  }).finally(() => { if (!pending.size) w?.unref(); });
}

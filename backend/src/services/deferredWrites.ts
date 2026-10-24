/**
 * fix210b: the web process writes nothing to the database itself (sign-in and account actions excepted). A write waits
 * synchronously for the other process's lock (busy_timeout 5 s), so a web write next to a worker transaction froze
 * every visitor: "AF usage flush" took 880 ms on 24 Oct and caused a 1.7 s stall. Counters, visit rows, security-log
 * lines, the signed-out page copies and the hourly perf rows are written through `deferred(sql)` instead:
 * - web process: the write is queued and sent to the worker once a second (IPC; kept while the worker restarts, at
 *   most 50,000 writes), which runs them in transactions of 500 with a yield between
 * - worker / one process: written at once, as before
 */
import { db, type Statement } from '../db';
import logger from '../utils/logger';
import { isWeb, isWorker } from './role';
import { onIpc, sendIpc } from './ipc';
import { timed, yieldLoop } from './perf';

type Write = { sql: string; params: unknown[] };
const queue: Write[] = [];
const MAX_QUEUED = 50_000;
let dropped = 0;
const stmts = new Map<string, Statement>();
const stmt = (sql: string) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };

/** a write statement: \`.run(...params)\` writes now (worker) or later in the worker (web process) */
export function deferred(sql: string): { run: (...params: unknown[]) => void } {
  return {
    run: (...params: unknown[]) => {
      if (!isWeb) { stmt(sql).run(...params); return; }
      queue.push({ sql, params });
      if (queue.length > MAX_QUEUED) { queue.shift(); dropped++; }
    }
  };
}

if (isWeb) setInterval(() => {
  if (!queue.length) return;
  const items = queue.splice(0, 5000);
  if (!sendIpc({ t: 'db:writes', items })) queue.unshift(...items); // the worker is restarting: next second
}, 1000).unref();

// worker: the web process's writes. fix212b: transactions of at most 200 rows and ~1 MB of parameters (a signed-out page
// copy can be hundreds of KB: 500 of them in one transaction was the "web writes" half of the 9–10 s worker stalls),
// a yield between batches, each batch timed on its own — never one long synchronous write
export const WRITE_BATCH = 200;
export const WRITE_BATCH_BYTES = 1_000_000;
const sizeOf = (w: Write) => w.params.reduce<number>((n, p) => n + (typeof p === 'string' ? p.length : Buffer.isBuffer(p) ? p.length : 8), 0);
/** cut a list of writes into batches of ≤ WRITE_BATCH rows and ≤ WRITE_BATCH_BYTES of parameters */
export function writeBatches(items: Write[], maxRows = WRITE_BATCH, maxBytes = WRITE_BATCH_BYTES): Write[][] {
  const out: Write[][] = [];
  let cur: Write[] = [], bytes = 0;
  for (const w of items) {
    const b = sizeOf(w);
    if (cur.length && (cur.length >= maxRows || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(w); bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}
let chain: Promise<void> = Promise.resolve();
if (isWorker) onIpc('db:writes', m => {
  const items = (m.items as Write[]) || [];
  chain = chain.then(async () => {
    for (const batch of writeBatches(items)) {
      await timed('web writes', async () => {
        db.exec('BEGIN');
        try {
          for (const w of batch) { try { stmt(w.sql).run(...(w.params as any[])); } catch (e: any) { logger.warn(`web write: ${e?.message || e}`); } }
          db.exec('COMMIT');
        } catch (e: any) { try { db.exec('ROLLBACK'); } catch { /* none open */ } logger.warn(`web writes: ${e?.message || e}`); }
      });
      await yieldLoop();
    }
  }).catch(() => undefined);
});

/** /api/perf: writes waiting in the web process */
export const deferredStatus = () => ({ queued: queue.length, dropped });

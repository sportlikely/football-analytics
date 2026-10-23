/**
 * fix202: the two processes. web.ts (the web process: answers visitors, never runs a job) starts worker.ts as a child
 * process; the worker runs index.ts — every scheduled job, the models and every route — on an internal port that only
 * the web process calls. They share the SQLite file (WAL) and talk over the child-process channel:
 *   worker → web: ready, built (a stored page was rebuilt), live (live rows changed), stats, answer
 *   web → worker: hits (pages visitors asked for), ask (e.g. the web process's perf numbers for /api/perf)
 * WORKER=0 runs everything in one process as before fix202 (role 'all').
 */
export type Role = 'all' | 'worker';
export const ROLE: Role = process.env.SL_ROLE === 'worker' && typeof process.send === 'function' ? 'worker' : 'all';
export const isWorker = ROLE === 'worker';
/** random per start, from the web process: marks the worker's own page builds (never accepted without it) */
export const INTERNAL_SECRET = process.env.SL_INTERNAL_SECRET || '';
export const WORKER_PORT = parseInt(process.env.WORKER_PORT || '3901', 10);

export type Msg = { type: string; [k: string]: any };
const handlers = new Map<string, (m: Msg) => void>();
const pending = new Map<number, (data: any) => void>();
let seq = 0;

/** worker → web (no-op when there is no web process: role 'all') */
export function toWeb(m: Msg) {
  if (!isWorker || !process.connected) return;
  try { process.send!(m); } catch { /* the web process is going away */ }
}
export function onWeb(type: string, fn: (m: Msg) => void) { handlers.set(type, fn); }
/** ask the web process for something (null when it does not answer in time) */
export function askWeb<T = any>(what: string, timeoutMs = 1500): Promise<T | null> {
  if (!isWorker) return Promise.resolve(null);
  const id = ++seq;
  return new Promise<T | null>(resolve => {
    const t = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, data => { clearTimeout(t); resolve(data as T); });
    toWeb({ type: 'ask', id, what });
  });
}
if (isWorker) {
  process.on('message', (m: Msg) => {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'answer') { pending.get(m.id)?.(m.data); pending.delete(m.id); return; }
    try { handlers.get(m.type)?.(m); } catch { /* a bad message never stops the worker */ }
  });
  // the web process is gone (crash or deploy): nothing left to serve, stop too
  process.on('disconnect', () => process.exit(0));
}

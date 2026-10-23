/**
 * fix202: which process this is.
 * - 'web'    answers requests and reads the database (index.ts, worker on). No scheduled job runs here; model state
 *            comes from the worker (services/shared.ts), stored pages from page_cache (services/pageCache.ts).
 * - 'worker' runs every scheduled job (worker.ts, a child process of the web process, same SQLite file).
 * - 'all'    both in one process: WORKER=0 (the fallback), tests and scripts.
 * Set by the entry file through SL_ROLE before any service is loaded (index.ts, worker.ts). A worker thread inside a
 * process (tennis model, index builds) is neither the web nor the worker side: it never publishes or listens.
 */
import { isMainThread } from 'node:worker_threads';

export type Role = 'web' | 'worker' | 'all';

export const ROLE: Role = process.env.SL_ROLE === 'web' ? 'web' : process.env.SL_ROLE === 'worker' ? 'worker' : 'all';
/** the web process of a split pair (the worker does the background work) */
export const isWeb = ROLE === 'web' && isMainThread;
/** the worker process of a split pair */
export const isWorker = ROLE === 'worker' && isMainThread;
/** this process runs the scheduled jobs and builds model state (worker, or everything in one process) */
export const runsJobs = ROLE !== 'web';

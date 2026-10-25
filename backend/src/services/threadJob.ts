/**
 * fix210: CPU-heavy model builds in a worker thread (like the tennis model, fix200): the basketball model (talent pass +
 * the 60-fit re-tune per league) and the national-team Elo (parameter fits). The worker process's event loop stays free
 * for the live ticks and the admin requests, and the build's memory is the thread's own: the thread is started for one
 * build and ended after it, so whatever it loaded (every box-score line, every international) is freed at once, and a
 * build that runs out of its heap (THREAD_HEAP_MB, capped at 12% of the container: utils/memLimit.ts) ends the thread
 * with an error instead of the worker process.
 *
 * The thread opens its own database connection, loads the module and runs the build; what the build publishes
 * (publishState) is sent back one state at a time and applied here by the same code the web process uses (onState),
 * then published to the web process as before. THREAD_JOBS=0 = the old in-process builds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import logger from '../utils/logger';
import { heapShareMb } from '../utils/memLimit';
import { isWeb } from './role';
import { applyState } from './shared';
import { yieldLoop, track } from './perf';

export type ThreadJob = 'bb model' | 'bb tune' | 'national elo' | 'more backtest' | 'sitemap' | 'photo crop' | 'season sim';

function threadFile(): { file: string; execArgv?: string[] } | null {
  const js = path.join(__dirname, '../workers/jobThread.js');
  if (fs.existsSync(js)) return { file: js };
  // ts-node-dev (npm run dev): the TypeScript source through ts-node
  const ts = path.join(__dirname, '../workers/jobThread.ts');
  if (fs.existsSync(ts)) return { file: ts, execArgv: ['-r', 'ts-node/register/transpile-only'] };
  return null;
}

/** builds go to a thread (worker process or one process, main thread, the file is there, THREAD_JOBS not 0) */
export const threadJobsOn = () => process.env.THREAD_JOBS !== '0' && isMainThread && !isWeb && !!threadFile();

const last = new Map<ThreadJob, { at: string; ms: number; ok: boolean; error?: string; states: number }>();
/** /api/perf: the last run of each thread job */
export const threadJobStatus = () => Object.fromEntries(last);

/** run `job` in a new thread; resolves with its result once every state it published was applied here */
export function inThread<T>(job: ThreadJob, args: unknown[] = []): Promise<T> {
  const f = threadFile();
  if (!f) return Promise.reject(new Error('no job thread file'));
  const t0 = Date.now();
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(f.file, {
      workerData: { jobThread: true, job, args },
      execArgv: f.execArgv,
      resourceLimits: { maxOldGenerationSizeMb: heapShareMb('thread').heapMb }
    });
    let settled = false, states = 0, done = false;
    // one state a message, applied one per turn (a big state is one synchronous deserialize + apply)
    let chain: Promise<void> = Promise.resolve();
    const finish = (err: Error | null, result?: T) => {
      if (settled) return;
      settled = true;
      last.set(job, { at: new Date().toISOString(), ms: Date.now() - t0, ok: !err, error: err?.message, states });
      void w.terminate();
      if (err) reject(err); else resolve(result as T);
    };
    w.on('message', (m: any) => {
      if (m?.t === 'state') {
        states++;
        chain = chain.then(async () => { await yieldLoop(); const done = track(`${job} thread: apply ${String(m.key).split(':').slice(0, 2).join(':')}`); try { applyState(m.key, m.value); } finally { done(); } }).catch(e => { logger.warn(`${job} thread: state ${m.key}: ${e?.message || e}`); });
      } else if (m?.t === 'done') { done = true; void chain.then(() => finish(null, m.result)); }
      else if (m?.t === 'error') finish(new Error(m.error || 'thread job failed'));
    });
    w.on('error', e => finish(e));
    // (a thread that ends by itself after "done": its last states are still being applied)
    w.on('exit', code => { if (!done) finish(new Error(`thread ended (${code})`)); });
  });
}

/**
 * fix234 — admin model endpoints answer at once. On 25 Oct /api/bb/impact-fit (fix225) held the request until the fit
 * was done (minutes, behind the heavy-job queue) and the admin page gave up after 20 s. Now a request with ?run=1 puts
 * the job in the heavy queue and answers straight away; every request (with or without run) answers with the job's
 * state ("queued", "running, started <time>", "done", "failed") and its result when done, next to the stored one.
 * One run per job at a time; the result of the last run stays here until the process restarts (the stored reports
 * are in the database).
 */
import logger from '../utils/logger';
import { heavy } from './perf';

export interface AdminJob {
  key: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  opt: unknown;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  result: unknown;
}

const jobs = new Map<string, AdminJob>();
const now = () => new Date().toISOString();

/** start `run` as the heavy job `key` (not when it is queued or running already); returns the job at once */
export function startAdminJob(key: string, opt: unknown, run: () => unknown): AdminJob {
  const cur = jobs.get(key);
  if (cur && (cur.state === 'queued' || cur.state === 'running')) return cur;
  const j: AdminJob = { key, state: 'queued', opt, queuedAt: now(), startedAt: null, endedAt: null, error: null, result: null };
  jobs.set(key, j);
  heavy(key, async () => { j.state = 'running'; j.startedAt = now(); return run(); })
    .then(r => {
      // heavy() drops a label that is already waiting or running (the worker's own scheduled run of the same job)
      if (j.state === 'queued') { j.state = 'failed'; j.error = 'the same job was already queued or running (the worker’s own run): its stored result shows once it ends'; }
      else { j.state = 'done'; j.result = r; }
    })
    .catch(e => { j.state = 'failed'; j.error = e?.message || String(e); logger.warn(`admin job ${key}: ${j.error}`); })
    .finally(() => { j.endedAt = now(); });
  return j;
}

/** the job's state now (null = never started in this process) */
export const adminJob = (key: string): AdminJob | null => jobs.get(key) || null;

/** the answer of an admin job endpoint: the job (without its result), the result when done, the stored one */
export function adminJobAnswer(key: string, stored: unknown, shape: (r: any) => unknown = r => r) {
  const j = adminJob(key);
  return {
    job: j ? { ...j, result: undefined, running: j.state === 'queued' || j.state === 'running' } : null,
    result: j?.state === 'done' && j.result != null ? shape(j.result) : null,
    stored: stored ?? null
  };
}

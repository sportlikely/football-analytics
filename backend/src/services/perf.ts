/**
 * Event-loop health (Oct 2026): the server runs on one thread, so a long synchronous job (rebuilding model state,
 * fitting, feature rebuilds) makes every visitor wait. This records stalls and how long the heavy jobs take,
 * for /api/perf (admin).
 *
 * fix155: every running job is tracked (several can be in flight at once), a stall names all of them, each job keeps
 * the worst stall seen while it ran, and the live jobs (30 s / 60 s ticks) get an hourly "live ticks: max X ms" line.
 */
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';
import logger from '../utils/logger';
import { isWorker } from './role';

/*
 * fix167: a fully synchronous job finishes BEFORE the stall it caused is noticed (the timer below only runs once the
 * job has given the thread back), so it was no longer "running" and the stall had no label ("Event loop blocked
 * 3090 ms" on 17 Oct). Jobs and requests that ran 50 ms or more are remembered for a few seconds, and garbage-collection
 * pauses too (perf_hooks 'gc'): a stall names everything that ran during it, with how long ("gc major 812 ms").
 */
const recent: { label: string; start: number; end: number; detail?: string }[] = [];
const noteRun = (label: string, start: number, end: number, detail?: string) => {
  if (end - start < 50) return;
  recent.push({ label, start, end, detail });
  if (recent.length > 64) recent.shift();
};
try {
  const kinds: Record<number, string> = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weak callbacks' };
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      const start = performance.timeOrigin + e.startTime;
      noteRun(`gc ${kinds[(e as any).detail?.kind ?? (e as any).kind] || ''}`.trim(), start, start + e.duration);
    }
  }).observe({ entryTypes: ['gc'] });
} catch { /* gc entries not available */ }

const STEP = 500;
const stalls: { at: string; ms: number; job: string | null }[] = [];
const jobs = new Map<string, { runs: number; lastMs: number; maxMs: number; totalMs: number; lastAt: string; maxStallMs: number }>();
/** jobs in flight (a label can run more than once at a time) */
const active = new Map<string, number>();
let manual: string | null = null;
let last = Date.now();
let maxLag = 0;

/** the 30 s / 60 s live jobs: a stall over 500 ms while one runs is logged, and they get the hourly line */
export const LIVE_JOBS = new Set(['nfl live', 'nfl live predictions', 'bb live', 'football live', 'AF live', 'live push']);
const liveHour = new Map<string, number>();

const runningLabel = () => {
  const names = [...active.keys()];
  if (manual) names.push(manual);
  return names.length ? names.join(' + ') : null;
};

// fix200: the main thread only (a worker thread's own loop is meant to be busy: the tennis model)
if (isMainThread) setInterval(() => {
  const now = Date.now();
  const lag = now - last - STEP;
  const since = last;
  last = now;
  if (lag > maxLag) maxLag = lag;
  // what ran (and ended) since the last tick: the synchronous jobs, requests and gc pauses behind this stall
  const ended = lag > 50 ? recent.filter(r => r.end >= since && !active.has(r.label)).sort((a, b) => (b.end - b.start) - (a.end - a.start)) : [];
  if (lag > 50) for (const label of new Set([...active.keys(), ...ended.map(r => r.label)])) {
    const j = jobs.get(label);
    if (j && lag > j.maxStallMs) j.maxStallMs = lag;
    if (LIVE_JOBS.has(label)) liveHour.set(label, Math.max(liveHour.get(label) || 0, lag));
  }
  if (lag > 300) {
    const running = runningLabel();
    // fix175: a request carries its full path (ids kept, only the c / n query values) — "http GET /it/* [/it/team/86] 3773 ms"
    const done = ended.slice(0, 4).map(r => `${r.label}${r.detail ? ` [${r.detail}]` : ''} ${Math.round(r.end - r.start)} ms`).join(' + ');
    const job = [running, done].filter(Boolean).join(' + ') || null;
    stalls.push({ at: new Date(now).toISOString(), ms: lag, job });
    if (stalls.length > 100) stalls.shift();
    // fix167: the target is no stall over 500 ms (boot included), so every one over 500 ms is logged
    // fix202: the worker's own loop is allowed to be busy (no visitor waits for it): its stalls are logged from 2 s
    if (lag > (isWorker ? 2000 : 500)) logger.warn(`${isWorker ? 'Worker: event' : 'Event'} loop blocked ${lag} ms${job ? ` (${job})` : ''}`);
  }
}, STEP).unref();

// once an hour: the worst event-loop stall while each live job was running (the goal: under 500 ms)
if (isMainThread) setInterval(() => {
  for (const l of LIVE_JOBS) if (jobs.get(l)?.lastAt && Date.now() - Date.parse(jobs.get(l)!.lastAt) < 3600 * 1000 && !liveHour.has(l)) liveHour.set(l, 0);
  if (!liveHour.size) return;
  const max = Math.max(...liveHour.values());
  logger.info(`live ticks: max ${max} ms (${[...liveHour.entries()].sort((a, b) => b[1] - a[1]).map(([l, ms]) => `${l} ${ms}`).join(', ')})`);
  liveHour.clear();
}, 3600 * 1000).unref();

export const yieldLoop = () => new Promise<void>(r => setImmediate(r));
/** fix187: was the event loop blocked longer than `minLag` ms within the last `windowMs`? (background jobs back off) */
export const stalledWithin = (windowMs: number, minLag = 500) => stalls.some(s => s.ms > minLag && Date.parse(s.at) >= Date.now() - windowMs);

/** fix169: cut a long loop into ~30 ms slices: `const slice = slicer(); for (…) { …; await slice(); }` */
export function slicer(ms = 30) {
  let t = Date.now();
  return async () => { if (Date.now() - t >= ms) { await yieldLoop(); t = Date.now(); } };
}
/*
 * fix196: background jobs step aside for the live ticks (live poll and the live jobs, every 20–60 s): a heavy job's
 * slices wait while one runs (at most 3 s, so a stuck live poll never stops them).
 */
const LIVE_TICKS = new Set([...LIVE_JOBS, 'live poll']);
export const liveRunning = () => { for (const l of active.keys()) if (LIVE_TICKS.has(l)) return true; return false; };
export async function afterLive(maxMs = 3000) {
  const t = Date.now();
  while (liveRunning() && Date.now() - t < maxMs) await new Promise(r => setTimeout(r, 25));
}
/** fix196: slicer() for heavy background jobs: gives the thread back every ~30 ms and waits while a live tick runs. */
export function heavySlicer(ms = 30) {
  let t = Date.now();
  return async () => { if (Date.now() - t >= ms) { await yieldLoop(); await afterLive(); t = Date.now(); } };
}
/** fix169: `fn` over the items in batches of `size`, yielding whenever ~30 ms have passed (fix159 style). */
export async function inBatches<T, R>(items: T[], size: number, fn: (batch: T[]) => R[], opts: { live?: boolean } = {}): Promise<R[]> {
  const out: R[] = [];
  const slice = opts.live ? heavySlicer() : slicer();
  for (let i = 0; i < items.length; i += size) { out.push(...fn(items.slice(i, i + size))); await slice(); }
  return out;
}
/**
 * fix200: live ticks — at most `size` games (20) per turn, then the rest continues on the next macrotask (setImmediate),
 * so a busy Saturday (100+ live games) never holds the thread for the whole list.
 */
export async function perGames<T>(items: T[], fn: (chunk: T[]) => unknown | Promise<unknown>, size = 20): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    if (i) await yieldLoop();
    await fn(items.slice(i, i + size));
  }
}
/** fix200: perGames() that keeps what each chunk returns (in order). */
export async function mapGames<T, R>(items: T[], fn: (chunk: T[]) => R[], size = 20): Promise<R[]> {
  const out: R[] = [];
  await perGames(items, c => { out.push(...fn(c)); }, size);
  return out;
}
/**
 * fix167: a loop over cached work never gives the thread back (each await on a ready value only runs microtasks), so
 * hundreds of items run as one block. `const step = yielder(50)` … `await step()` in the loop yields once 50 ms have
 * passed since the last yield.
 */
/**
 * fix167: a heavy computation written as a generator (`yield` at safe points) runs to the end at once (runSteps, for
 * callers that need the answer now) or in slices of `budgetMs`, giving the thread back between them (runStepsAsync).
 */
export function runSteps<T>(g: Generator<unknown, T>): T {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}
export async function runStepsAsync<T>(g: Generator<unknown, T>, budgetMs = 40, opts: { live?: boolean } = {}): Promise<T> {
  let t = Date.now();
  let r = g.next();
  while (!r.done) {
    if (Date.now() - t >= budgetMs) { await yieldLoop(); if (opts.live) await afterLive(); t = Date.now(); }
    r = g.next();
  }
  return r.value;
}
export function yielder(budgetMs = 50) {
  let since = Date.now();
  return async () => {
    if (Date.now() - since < budgetMs) return;
    await yieldLoop();
    since = Date.now();
  };
}

/** Time a job (sync or async); the label shows up next to any stall it causes. */
export async function timed<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  active.set(label, (active.get(label) || 0) + 1);
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    const j = jobs.get(label) || { runs: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastAt: '', maxStallMs: 0 };
    j.runs++; j.lastMs = ms; j.maxMs = Math.max(j.maxMs, ms); j.totalMs += ms; j.lastAt = new Date().toISOString();
    jobs.set(label, j);
    const n = (active.get(label) || 1) - 1;
    if (n > 0) active.set(label, n); else active.delete(label);
    noteRun(label, t0, t0 + ms);
  }
}
let manualAt = 0;
export const setJob = (label: string | null) => {
  if (manual) noteRun(manual, manualAt, Date.now());
  manual = label; manualAt = Date.now();
};

/**
 * fix158: an API request in flight counts as a running job ("http GET /api/nfl/games"), so a freeze inside a request
 * handler is named too. Ids in the path become ":id" (one label per route). Returns the "done" call.
 */
export function track(label: string, detail?: string): () => void {
  active.set(label, (active.get(label) || 0) + 1);
  const t0 = Date.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const ms = Date.now() - t0;
    const j = jobs.get(label) || { runs: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastAt: '', maxStallMs: 0 };
    j.runs++; j.lastMs = ms; j.maxMs = Math.max(j.maxMs, ms); j.totalMs += ms; j.lastAt = new Date().toISOString();
    jobs.set(label, j);
    if (jobs.size > 400) for (const k of [...jobs.keys()].filter(k => k.startsWith('http ')).slice(0, 100)) jobs.delete(k);
    const n = (active.get(label) || 1) - 1;
    if (n > 0) active.set(label, n); else active.delete(label);
    noteRun(label, t0, t0 + ms, detail);
  };
}
/** fix175: the path of a request for the slow-request log: ids stay, query values only for c and n (team page). */
export function requestDetail(path: string, query: Record<string, unknown>): string {
  const q = ['c', 'n'].filter(k => typeof query[k] === 'string' && query[k]).map(k => `${k}=${String(query[k]).slice(0, 40)}`).join('&');
  return `${path.slice(0, 160)}${q ? `?${q}` : ''}`;
}
/** fix167: pages outside /api (search-engine HTML, sitemaps, files) go by their first part: "http GET /team/*" */
export const routeLabel = (method: string, path: string) => path.startsWith('/api/')
  ? `http ${method} ${path.replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 80)}`
  : `http ${method} ${path.replace(/^(\/[^/]*)(\/.+)?$/, (_m, a: string, b?: string) => (b ? `${a}/*` : a)).slice(0, 80)}`;

/** fix165: setTimeout with a name (start-up jobs), so no freeze is unlabelled. */
export function after(label: string, fn: () => unknown, ms: number): NodeJS.Timeout {
  return setTimeout(() => { timed(label, fn).catch(e => logger.warn(`${label}: ${e?.message || e}`)); }, ms);
}

/** fix158: setInterval with a name — every repeating job runs inside timed(), so no freeze is unlabelled. */
export function every(label: string, fn: () => unknown, ms: number): NodeJS.Timeout {
  return setInterval(() => { timed(label, fn).catch(e => logger.warn(`${label}: ${e?.message || e}`)); }, ms);
}

/*
 * fix194: one heavy background job at a time (model daily, player pages warm, the tennis jobs). On 20 Oct the 04:04 UTC
 * daily job, the player-page warm-up and the tennis jobs ran together and the slices of all three added up to 1–2 s
 * stalls. A job asks for its turn with heavy(label, fn); a label already running or waiting is not queued twice (the
 * next tick of its timer comes soon enough). Never call heavy() from inside a heavy job: it would wait for itself.
 */
const heavyQueue: { label: string; run: () => void }[] = [];
const heavyWaiting = new Set<string>();
let heavyNow: string | null = null;
let heavySince = 0;
let heavyTurn = 0;
const heavyNext = () => {
  if (heavyNow) return;
  const next = heavyQueue.shift();
  if (next) next.run();
};
// a job that never ends (a hung download) must not stop the others for ever: after 45 min the queue moves on
const HEAVY_MAX_MS = 45 * 60 * 1000;
setInterval(() => {
  if (!heavyNow || Date.now() - heavySince < HEAVY_MAX_MS) return;
  logger.warn(`heavy job "${heavyNow}" still running after ${Math.round((Date.now() - heavySince) / 60000)} min: the queue moves on`);
  heavyNow = null;
  heavyTurn++;
  heavyNext();
}, 60 * 1000).unref();
export function heavy<T>(label: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  if (heavyWaiting.has(label) || heavyNow === label) return Promise.resolve(undefined);
  heavyWaiting.add(label);
  return new Promise<T | undefined>((resolve, reject) => {
    heavyQueue.push({
      label,
      run: () => {
        heavyWaiting.delete(label);
        heavyNow = label;
        heavySince = Date.now();
        const turn = ++heavyTurn;
        // fix196: never starts during a live tick
        afterLive().then(fn).then(resolve, reject).finally(() => {
          if (turn !== heavyTurn) return; // released by the 45-min watchdog: the queue already moved on
          heavyNow = null;
          setImmediate(heavyNext);
        });
      }
    });
    heavyNext();
  });
}
/** the heavy job running now and the ones waiting (for /api/perf) */
export const heavyStatus = () => ({ running: heavyNow, forMs: heavyNow ? Date.now() - heavySince : 0, waiting: heavyQueue.map(q => q.label) });
/** every() for a heavy job: timed only while it runs (the wait in the queue is not counted as running) */
export function everyHeavy(label: string, fn: () => unknown, ms: number): NodeJS.Timeout {
  return setInterval(() => { heavy(label, () => timed(label, fn)).catch(e => logger.warn(`${label}: ${e?.message || e}`)); }, ms);
}
export function afterHeavy(label: string, fn: () => unknown, ms: number): NodeJS.Timeout {
  return setTimeout(() => { heavy(label, () => timed(label, fn)).catch(e => logger.warn(`${label}: ${e?.message || e}`)); }, ms);
}

export function perfStatus() {
  const since = Date.now() - 3600 * 1000;
  const recent = stalls.filter(s => new Date(s.at).getTime() >= since);
  return {
    maxLagMs: maxLag,
    stallsLastHour: recent.length,
    worstLastHour: recent.reduce((m, s) => Math.max(m, s.ms), 0),
    running: runningLabel(),
    heavy: heavyStatus(),
    liveThisHour: Object.fromEntries(liveHour),
    recentStalls: stalls.slice(-25).reverse(),
    // maxMs = longest run (waits for the data providers included); maxStallMs = worst event-loop freeze while it ran
    jobs: Object.fromEntries([...jobs.entries()].sort((a, b) => b[1].maxStallMs - a[1].maxStallMs || b[1].maxMs - a[1].maxMs)),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    uptimeMin: Math.round(process.uptime() / 60)
  };
}

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
import { AsyncLocalStorage } from 'node:async_hooks';
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

/*
 * fix214: stdout / stderr writes are timed. On Linux a write to a pipe is synchronous: when the host's log collector
 * reads slowly (a crawler burst = a line per request), the write blocks the whole loop and the stall was named after
 * the pages in flight ("GET /match/* + GET /basketball/*", 2.7 s). A stall now says "log writes N ms (k lines)".
 */
let logMs = 0, logLines = 0;
if (isMainThread) for (const s of [process.stdout, process.stderr]) {
  const write = s.write.bind(s) as (...a: any[]) => boolean;
  (s as any).write = (...a: any[]) => {
    const t0 = performance.now();
    try { return write(...a); } finally { logMs += performance.now() - t0; logLines++; }
  };
}

const STEP = 500;
const stalls: { at: string; ms: number; job: string | null; startup?: true }[] = [];
// fix210: heapDeltaMb = heap after − before the last run; maxHeapDeltaMb = the worst run; peakHeapMb = highest heap seen while it ran
type JobStat = { runs: number; lastMs: number; maxMs: number; totalMs: number; lastAt: string; maxStallMs: number; heapDeltaMb?: number; maxHeapDeltaMb?: number; peakHeapMb?: number };
const jobs = new Map<string, JobStat>();
const newStat = (): JobStat => ({ runs: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastAt: '', maxStallMs: 0 });
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
  const logs = logMs >= 50 ? `log writes ${Math.round(logMs)} ms (${logLines} lines)` : null;
  logMs = 0; logLines = 0;
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
    const job = [logs, running, done].filter(Boolean).join(' + ') || null;
    stalls.push({ at: new Date(now).toISOString(), ms: lag, job, startup: !startupDone || undefined });
    noteHour(lag, job);
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

/*
 * fix210: the last 24 hours in hourly buckets (stalls over 300 ms, the worst one, the highest heap / rss seen), so a
 * trend is visible in /api/perf and data health (services/perfHistory.ts keeps them in perf_hours).
 */
export type HourBucket = { hour: string; stalls: number; worstMs: number; heapMaxMb: number; rssMaxMb: number; top: { ms: number; job: string | null }[] };
const hours: HourBucket[] = [];
function bucket(): HourBucket {
  const hour = new Date().toISOString().slice(0, 13);
  let b = hours[hours.length - 1];
  if (!b || b.hour !== hour) { hours.push((b = { hour, stalls: 0, worstMs: 0, heapMaxMb: 0, rssMaxMb: 0, top: [] })); if (hours.length > 25) hours.shift(); }
  return b;
}
function noteHour(lag: number, job: string | null) {
  const b = bucket();
  b.stalls++;
  if (lag > b.worstMs) b.worstMs = lag;
  // the hour's 5 worst, with what ran during them (data health lists them)
  if (b.top.length < 5 || lag > b.top[b.top.length - 1].ms) { b.top.push({ ms: lag, job: job ? job.slice(0, 200) : null }); b.top.sort((x, y) => y.ms - x.ms); b.top.length = Math.min(5, b.top.length); }
}
/** this process's hourly buckets, oldest first (the current hour last) */
export const hourBuckets = (): HourBucket[] => { bucket(); return hours.map(b => ({ ...b, top: [...b.top] })); };
/**
 * fix210: every 10 s — heap and rss into this hour's bucket, and the heap into each running job's peak (so the job
 * running while the heap grew is named: /api/perf → worker.memByJob).
 */
export function sampleHeap() {
  const m = process.memoryUsage();
  const heap = Math.round(m.heapUsed / 1048576), rss = Math.round(m.rss / 1048576);
  const b = bucket();
  if (heap > b.heapMaxMb) b.heapMaxMb = heap;
  if (rss > b.rssMaxMb) b.rssMaxMb = rss;
  for (const label of active.keys()) { const j = jobs.get(label); if (j && heap > (j.peakHeapMb || 0)) j.peakHeapMb = heap; }
  return { heapMb: heap, rssMb: rss, running: [...active.keys()] };
}
if (isMainThread) setInterval(sampleHeap, 10 * 1000).unref();
/** fix210: the jobs whose runs grew the heap most (worst run: heap after − before) and the highest heap while they ran */
export function memByJob(n = 5) {
  return [...jobs.entries()].filter(([k, j]) => !k.startsWith('http ') && (j.maxHeapDeltaMb || j.peakHeapMb))
    .sort((a, b) => (b[1].maxHeapDeltaMb || 0) - (a[1].maxHeapDeltaMb || 0) || (b[1].peakHeapMb || 0) - (a[1].peakHeapMb || 0)).slice(0, n)
    .map(([job, j]) => ({ job, maxHeapDeltaMb: j.maxHeapDeltaMb || 0, lastHeapDeltaMb: j.heapDeltaMb || 0, peakHeapMb: j.peakHeapMb || 0, runs: j.runs }));
}

const heapMbNow = () => Math.round(process.memoryUsage().heapUsed / 1048576);

export const yieldLoop = () => new Promise<void>(r => setImmediate(r));
/**
 * fix210: the one rule for heavy loops — give the thread back every `n` items or `ms` milliseconds, whichever comes
 * first: `const step = yieldEvery(); for (…) { …; await step(); }`. `live` also waits while a live tick runs.
 */
export function yieldEvery(n = 50, ms = 100, opts: { live?: boolean } = {}) {
  let i = 0, t = Date.now();
  return async () => {
    if (++i < n && Date.now() - t < ms) return;
    i = 0;
    await yieldLoop();
    if (opts.live) await afterLive();
    t = Date.now();
  };
}
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
  const h0 = process.memoryUsage().heapUsed;
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    const j = jobs.get(label) || newStat();
    j.runs++; j.lastMs = ms; j.maxMs = Math.max(j.maxMs, ms); j.totalMs += ms; j.lastAt = new Date().toISOString();
    // fix210: heap before / after the run
    const h1 = process.memoryUsage().heapUsed;
    j.heapDeltaMb = Math.round((h1 - h0) / 1048576);
    j.maxHeapDeltaMb = Math.max(j.maxHeapDeltaMb || 0, j.heapDeltaMb);
    j.peakHeapMb = Math.max(j.peakHeapMb || 0, Math.round(h1 / 1048576));
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
    const j = jobs.get(label) || newStat();
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
 * next tick of its timer comes soon enough).
 *
 * fix210: the worker's big jobs (AF matches, bb sync / bb model, stored pages, national elo, search index, page
 * upcoming …) are all in this queue, so they nest: heavy() called while a heavy job runs (in its async context) runs
 * inside that job at once instead of waiting for itself. heavyLater() queues from anywhere without waiting (a heavy job
 * that asks for a page rebuild gets it after it ends).
 */
const heavyCtx = new AsyncLocalStorage<{ label: string; done: boolean }>();
/** fix210: inside a running heavy job (its async context)? */
export const inHeavyJob = () => { const c = heavyCtx.getStore(); return !!c && !c.done; };
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
  // fix210: part of the heavy job that is running (its own context): run now, never wait for itself
  if (inHeavyJob()) return Promise.resolve().then(fn);
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
        const ctx = { label, done: false };
        // fix196: never starts during a live tick
        afterLive().then(() => heavyCtx.run(ctx, fn)).then(resolve, reject).finally(() => {
          ctx.done = true; // timers the job left behind no longer count as "inside" it
          if (turn !== heavyTurn) return; // released by the 45-min watchdog: the queue already moved on
          heavyNow = null;
          setImmediate(heavyNext);
        });
      }
    });
    heavyNext();
  });
}
/** fix210: heavy() queued as its own turn even when called from inside a heavy job (never inline, never nested) */
export function heavyQueued<T>(label: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  return heavyCtx.exit(() => heavy(label, fn));
}
/** fix210: queue a heavy job without waiting for it — from a heavy job too (it runs after the current one) */
export function heavyLater(label: string, fn: () => unknown): void {
  heavyQueued(label, () => timed(label, fn)).catch(e => logger.warn(`${label}: ${e?.message || e}`));
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

/** fix212b: the start-up load (before the process answers anything) is not a stall anyone waited for: listed apart */
let startupDone = false;
export const markStartupDone = () => { startupDone = true; };
export const stallsSinceReady = () => stalls.filter(s => !s.startup && s.ms > 500).length;
/** fix218: requests that took over 500 ms since the process was ready (http entries of the recent list) */
export const slowSinceReady = () => recent.filter(r => r.label.startsWith('http ') && r.end - r.start > 500 && !(r as any).startup).length;
export function perfStatus() {
  const since = Date.now() - 3600 * 1000;
  const recent = stalls.filter(s => new Date(s.at).getTime() >= since && !s.startup);
  const startup = stalls.filter(s => s.startup);
  return {
    maxLagMs: maxLag,
    stallsLastHour: recent.length,
    worstLastHour: recent.reduce((m, s) => Math.max(m, s.ms), 0),
    running: runningLabel(),
    heavy: heavyStatus(),
    liveThisHour: Object.fromEntries(liveHour),
    recentStalls: stalls.filter(s => !s.startup).slice(-25).reverse(),
    // fix212b: the start-up load's own stalls (before listen; nobody waited)
    startupStalls: startup.slice(-5).map(s => ({ at: s.at, ms: s.ms, job: s.job })),
    // fix210: the worst stalls of the last hour (what to fix first)
    topStalls: [...recent].sort((a, b) => b.ms - a.ms).slice(0, 10),
    // maxMs = longest run (waits for the data providers included); maxStallMs = worst event-loop freeze while it ran
    jobs: Object.fromEntries([...jobs.entries()].sort((a, b) => b[1].maxStallMs - a[1].maxStallMs || b[1].maxMs - a[1].maxMs)),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    heapMb: heapMbNow(),
    // fix210: the top heap growers and the last 24 h by the hour
    memByJob: memByJob(),
    hours: hourBuckets(),
    uptimeMin: Math.round(process.uptime() / 60)
  };
}

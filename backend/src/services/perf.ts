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
import { profileWindow, cpuTop, cpuProfileStatus, type CpuResult } from './cpuProfile';

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
type Stall = { at: string; ms: number; job: string | null; startup?: true; diag?: true; cpu?: CpuResult };
const stalls: Stall[] = [];
/*
 * fix232: a stall while only an admin diagnostic ran (/api/perf, /api/admin/* answered here) is not a stall a visitor
 * waited for: it is kept apart (diagStalls) and not counted in the hour (data health "Web stalls"). On 25 Oct the 5 MB
 * /api/perf froze the web 4.8–18.6 s each time it was opened: the top 4 web stalls of the hour were "http GET /api/perf".
 */
const DIAG = /^http GET \/api\/(perf|admin\/)/;
export const isDiagLabel = (label: string) => DIAG.test(label);
const onlyDiag = (labels: string[]) => labels.some(isDiagLabel) && labels.every(l => isDiagLabel(l) || /^gc\b/.test(l));
// fix210: heapDeltaMb = heap after − before the last run; maxHeapDeltaMb = the worst run; peakHeapMb = highest heap seen while it ran
type JobStat = { runs: number; lastMs: number; maxMs: number; totalMs: number; lastAt: string; maxStallMs: number; heapDeltaMb?: number; maxHeapDeltaMb?: number; peakHeapMb?: number };
const jobs = new Map<string, JobStat>();
const newStat = (): JobStat => ({ runs: 0, lastMs: 0, maxMs: 0, totalMs: 0, lastAt: '', maxStallMs: 0 });
/** jobs in flight (a label can run more than once at a time) */
const active = new Map<string, number>();
let manual: string | null = null;
let last = Date.now();
let lastNs = process.hrtime.bigint();
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
  const sinceNs = lastNs;
  last = now;
  lastNs = process.hrtime.bigint();
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
    const diag = !logs && onlyDiag([...active.keys(), ...(manual ? [manual] : []), ...ended.map(r => r.label)]);
    const stall: Stall = { at: new Date(now).toISOString(), ms: lag, job, startup: !startupDone || undefined, diag: diag || undefined };
    stalls.push(stall);
    profileStall(stall, sinceNs, lastNs);
    // fix222: the hourly count (data health "Web stalls") is what visitors could wait for: start-up stalls are listed apart
    // fix232: so are the stalls of an admin diagnostic (/api/perf)
    if (startupDone && !diag) noteHour(lag, job);
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
export type Done = (() => void) & { wait: () => void };
export function track(label: string, detail?: string): Done {
  active.set(label, (active.get(label) || 0) + 1);
  const t0 = Date.now();
  let ended = false, waiting = false;
  const off = () => { const n = (active.get(label) || 1) - 1; if (n > 0) active.set(label, n); else active.delete(label); };
  const done = (() => {
    if (ended) return;
    ended = true;
    const ms = Date.now() - t0;
    const j = jobs.get(label) || newStat();
    j.runs++; j.lastMs = ms; j.maxMs = Math.max(j.maxMs, ms); j.totalMs += ms; j.lastAt = new Date().toISOString();
    jobs.set(label, j);
    if (jobs.size > 400) for (const k of [...jobs.keys()].filter(k => k.startsWith('http ')).slice(0, 100)) jobs.delete(k);
    if (!waiting) { off(); noteRun(label, t0, t0 + ms, detail); }
  }) as Done;
  /*
   * fix222: a request passed on to the worker only waits from here on (the worker answers it): it is no longer named in
   * a stall ("/api/basketball/game/:id" was named beside the real cause on 25 Oct while it waited for the worker)
   */
  done.wait = () => { if (!ended && !waiting) { waiting = true; off(); } };
  return done;
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
const heavyCtx = new AsyncLocalStorage<{ label: string; done: boolean; page?: boolean }>();
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
  // fix232: a page build (its own lane) runs a heavy job it asks for inline, as before — unless that job runs or waits already
  if (inHeavyJob()) return heavyCtx.getStore()?.page && (heavyWaiting.has(label) || heavyNow === label) ? Promise.resolve(undefined) : Promise.resolve().then(fn);
  if (heavyWaiting.has(label) || heavyNow === label) return Promise.resolve(undefined);
  heavyWaiting.add(label);
  return new Promise<T | undefined>((resolve, reject) => {
    const enqueue = () => {
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
    };
    // fix232: a model rebuild / fit waits until the stored pages were rebuilt once after the start
    if (isModelJob(label) && !pagesFirstDone()) void pagesFirst().then(enqueue); else enqueue();
  });
}

/*
 * fix232: the stored pages first, then the models. On 25 Oct (fix225 deploy) the worker's first "bb model" build took
 * ~12 min and every page build waited behind it in the heavy queue: /api/basketball/games answered 503 "Loading" for
 * 12 min. Now (1) the model rebuilds and fits (MODEL_JOBS, every sport) start only after the first round of page builds
 * (or PAGES_FIRST_MAX_MS), and (2) page builds have their own lane (pageLane): one page at a time, never queued behind
 * a heavy job — a model build running in a job thread or in slices no longer holds the lists back.
 * frontend/scripts/web-routes-check.ts (npm run parity) checks every sport has its model jobs listed here.
 */
export const MODEL_JOBS: Record<'football' | 'basketball' | 'nfl' | 'tennis', string[]> = {
  football: ['model daily job', 'feature state', 'more predictions backtest', 'more predictions first backtest', 'season forecast accuracy'],
  basketball: ['bb model', 'bb tune', 'bb miss fit', 'bb impact fit', 'bb impact regate', 'bb league tune', 'bb calibration'],
  nfl: ['nfl ratings', 'nfl model', 'af calibration'],
  tennis: ['tennis model', 'tennis benchmark']
};
const MODEL_LABELS = new Set(Object.values(MODEL_JOBS).flat());
export const isModelJob = (label: string) => MODEL_LABELS.has(label);
const PAGES_FIRST_MAX_MS = Number(process.env.PAGES_FIRST_MAX_MS) || 10 * 60 * 1000;
let pagesExpected = false, pagesDoneAt = 0;
let pagesResolve: (() => void) | null = null;
const pagesPromise = new Promise<void>(r => { pagesResolve = r; });
/** fix232 (worker / one process): the page warmer will run — model jobs wait for its first round (at most 10 min) */
export function expectPagesFirst() {
  if (pagesExpected) return;
  pagesExpected = true;
  setTimeout(() => { if (!pagesDoneAt) { logger.warn(`stored pages: first round not done after ${Math.round(PAGES_FIRST_MAX_MS / 60000)} min — the model jobs start anyway`); markPagesFirstDone(); } }, PAGES_FIRST_MAX_MS).unref();
}
/** fix232: the first round of page builds is done (pageCache.startPageWarmer) */
export function markPagesFirstDone() { if (!pagesDoneAt) { pagesDoneAt = Date.now(); pagesResolve?.(); } }
export const pagesFirstDone = () => !pagesExpected || !!pagesDoneAt;
/** fix232: resolves once the stored pages were rebuilt once (at once when no warmer runs: tests, the web process) */
export const pagesFirst = (): Promise<void> => (pagesFirstDone() ? Promise.resolve() : pagesPromise);

// fix232: the page lane — one page build at a time, beside the heavy queue (never behind a model build)
const pageQueue: { label: string; run: () => void }[] = [];
const pageWaiting = new Set<string>();
let pageNow: string | null = null, pageSince = 0, pageTurn = 0, pagesBuilt = 0;
const pageNext = () => { if (pageNow) return; const next = pageQueue.shift(); if (next) next.run(); };
const PAGE_MAX_MS = 5 * 60 * 1000;
setInterval(() => {
  if (!pageNow || Date.now() - pageSince < PAGE_MAX_MS) return;
  logger.warn(`page build "${pageNow}" still running after ${Math.round((Date.now() - pageSince) / 60000)} min: the page lane moves on`);
  pageNow = null;
  pageTurn++;
  pageNext();
}, 60 * 1000).unref();
export function pageLane<T>(label: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  if (pageWaiting.has(label) || pageNow === label) return Promise.resolve(undefined);
  pageWaiting.add(label);
  return new Promise<T | undefined>((resolve, reject) => {
    pageQueue.push({
      label,
      run: () => {
        pageWaiting.delete(label);
        pageNow = label;
        pageSince = Date.now();
        const turn = ++pageTurn;
        // its own heavy context: a heavy job the build asks for runs inside it (as when pages were heavy jobs)
        const ctx = { label, done: false, page: true };
        afterLive().then(() => heavyCtx.run(ctx, fn)).then(resolve, reject).finally(() => {
          ctx.done = true;
          pagesBuilt++;
          if (turn !== pageTurn) return;
          pageNow = null;
          setImmediate(pageNext);
        });
      }
    });
    heavyCtx.exit(pageNext);
  });
}
export const pageLaneStatus = () => ({ running: pageNow, forMs: pageNow ? Date.now() - pageSince : 0, waiting: pageQueue.length, built: pagesBuilt, firstRoundDone: pagesFirstDone(), firstRoundAt: pagesDoneAt ? new Date(pagesDoneAt).toISOString() : null });
/** fix210: heavy() queued as its own turn even when called from inside a heavy job (never inline, never nested) */
export function heavyQueued<T>(label: string, fn: () => T | Promise<T>): Promise<T | undefined> {
  return heavyCtx.exit(() => heavy(label, fn));
}
/** fix210: queue a heavy job without waiting for it — from a heavy job too (it runs after the current one) */
export function heavyLater(label: string, fn: () => unknown): void {
  heavyQueued(label, () => timed(label, fn)).catch(e => logger.warn(`${label}: ${e?.message || e}`));
}
/** the heavy job running now and the ones waiting (for /api/perf) */
export const heavyStatus = () => ({ running: heavyNow, forMs: heavyNow ? Date.now() - heavySince : 0, waiting: heavyQueue.map(q => q.label), pages: pageLaneStatus() });
/** every() for a heavy job: timed only while it runs (the wait in the queue is not counted as running) */
export function everyHeavy(label: string, fn: () => unknown, ms: number): NodeJS.Timeout {
  return setInterval(() => { heavy(label, () => timed(label, fn)).catch(e => logger.warn(`${label}: ${e?.message || e}`)); }, ms);
}
export function afterHeavy(label: string, fn: () => unknown, ms: number): NodeJS.Timeout {
  return setTimeout(() => { heavy(label, () => timed(label, fn)).catch(e => logger.warn(`${label}: ${e?.message || e}`)); }, ms);
}

/*
 * fix248: what code ran during the stall (services/cpuProfile.ts: the web process's rolling CPU profile). The answer
 * comes a moment later (the profile is read in its own thread) and is kept on the stall; one over 500 ms is logged with
 * its top 3 functions.
 */
function profileStall(stall: Stall, fromNs: bigint, toNs: bigint) {
  void profileWindow(fromNs, toNs).then(r => {
    if (!r) return;
    stall.cpu = r;
    if (stall.ms > 500 && r.top.length) logger.warn(`Stall ${stall.ms} ms CPU: ${r.top.slice(0, 3).map(f => `${f.fn} ${f.at} ${f.ms} ms`).join(' · ')}${r.covered ? '' : ' (window partly outside the profile)'}`);
  });
}

/** fix212b: the start-up load (before the process answers anything) is not a stall anyone waited for: listed apart */
let startupDone = false;
/**
 * fix222: called when the server listens. The event-loop clock starts here: the module loading before listen (imports,
 * table checks: ~6.5 s on Railway) was reported as the first stall, named after the label set in the listen callback
 * ("boot (scheduler start)", 22 Oct–25 Oct on the web process, which starts no scheduler). It is kept as its own
 * start-up entry instead ("module load before listen").
 */
export function markListening(loadMs: number) {
  last = Date.now();
  lastNs = process.hrtime.bigint();
  if (loadMs > 300) {
    const stall: Stall = { at: new Date().toISOString(), ms: Math.round(loadMs), job: 'module load before listen', startup: true };
    stalls.push(stall);
    profileStall(stall, lastNs - BigInt(Math.round(loadMs * 1e6)), lastNs);
  }
}
export const markStartupDone = () => { startupDone = true; };
export const stallsSinceReady = () => stalls.filter(s => !s.startup && !s.diag && s.ms > 500).length;
/** fix218: requests that took over 500 ms since the process was ready (http entries of the recent list) */
export const slowSinceReady = () => recent.filter(r => r.label.startsWith('http ') && !isDiagLabel(r.label) && r.end - r.start > 500 && !(r as any).startup).length;
export function perfStatus() {
  const since = Date.now() - 3600 * 1000;
  const recent = stalls.filter(s => new Date(s.at).getTime() >= since && !s.startup && !s.diag);
  const startup = stalls.filter(s => s.startup);
  return {
    maxLagMs: maxLag,
    stallsLastHour: recent.length,
    worstLastHour: recent.reduce((m, s) => Math.max(m, s.ms), 0),
    running: runningLabel(),
    heavy: heavyStatus(),
    liveThisHour: Object.fromEntries(liveHour),
    recentStalls: stalls.filter(s => !s.startup && !s.diag).slice(-25).reverse(),
    // fix212b: the start-up load's own stalls (before listen; nobody waited)
    startupStalls: startup.slice(-5).map(s => ({ at: s.at, ms: s.ms, job: s.job })),
    // fix232: stalls while only an admin diagnostic ran (not counted above); fix248: renamed from diagStalls
    adminStalls: stalls.filter(s => s.diag).slice(-5).map(s => ({ at: s.at, ms: s.ms, job: s.job })),
    // fix248: the stalls with what code ran (top 15 functions by self-time in the window), newest first
    diagStalls: stalls.filter(s => s.cpu).slice(-25).reverse(),
    cpuTop: cpuTop(), cpuProfile: cpuProfileStatus(),
    // fix210: the worst stalls of the last hour (what to fix first); fix232: 20
    topStalls: [...recent].sort((a, b) => b.ms - a.ms).slice(0, 20),
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

/** fix232: the jobs that took the most time in all (/api/perf summary: top 30), small rows */
export function jobsTop(n = 30) {
  return [...jobs.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, n)
    .map(([job, j]) => ({ job, runs: j.runs, totalMs: j.totalMs, maxMs: j.maxMs, lastMs: j.lastMs, lastAt: j.lastAt, maxStallMs: j.maxStallMs }));
}
/** fix232: /api/perf summary — this process's totals, the 20 worst stalls of the hour, jobs top 30, memory by job top 10 */
export function perfSummary() {
  const p = perfStatus();
  return {
    uptimeMin: p.uptimeMin, maxLagMs: p.maxLagMs, stallsLastHour: p.stallsLastHour, worstLastHour: p.worstLastHour,
    running: p.running, heavy: { ...p.heavy, waiting: p.heavy.waiting.slice(0, 20) }, memoryMb: p.memoryMb, heapMb: p.heapMb,
    topStalls: p.topStalls.map(s => ({ at: s.at, ms: s.ms, job: s.job ? s.job.slice(0, 300) : null, cpu: s.cpu?.top.slice(0, 3).map(f => `${f.fn} ${f.at} ${f.ms} ms`) })),
    startupStalls: p.startupStalls, adminStalls: p.adminStalls,
    // fix248: the 8 newest profiled stalls (top 15 functions each) and the functions summed over every profiled stall
    diagStalls: p.diagStalls.slice(0, 8).map(s => ({ ...s, job: s.job ? s.job.slice(0, 200) : null })), cpuTop: p.cpuTop, cpuProfile: p.cpuProfile,
    jobs: jobsTop(30), memByJob: memByJob(10),
    // the last 24 h by the hour, each with its 2 worst stalls
    hours: p.hours.slice(-24).map(h => ({ ...h, top: h.top.slice(0, 2).map(t => ({ ms: t.ms, job: t.job ? t.job.slice(0, 120) : null })) }))
  };
}

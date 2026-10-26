/**
 * fix250: nothing ever waits — the one-second rule for every public GET (web process).
 *
 * Live 27 Oct 00:40 the web thread was free (0 stalls, reader queue empty) and still the game routes took 5–12 s
 * (/api/extras/…/game 7.1 s, /api/season-forecast/…/game 6.8 s, /api/matches/:id/details 7.2 s, HTML 6–9 s): requests
 * waiting for the worker (busy with its jobs), a first build or a provider call — and the app showed a blank page.
 *
 * - `deadlineStart` (early, every request): a public GET that has not answered after DEADLINE_MS (900 ms) gets
 *   { pending: true } (202, X-SL-Pending) — a page gets the plain app page — and the work goes on in the background:
 *   its answer is kept (`late` copies, memory, per visitor: the signed-in person's own id) and the next request for it
 *   gets that copy at once. Verified search engines are left out (they wait for the full HTML on purpose, fix245).
 * - `lateCopy` (after sign-in / proxy checks): a kept answer is sent at once; one older than LATE_FRESH_MS is sent with
 *   X-SL-Stale and the handler runs again in the background (one run per address at a time) to refresh it.
 * - Every public GET over 1,000 ms is counted by route (`slowRequests`, /api/perf) and written each minute to
 *   slow_requests (through the worker): data health "Slow requests" fails on any in the last hour.
 */
import type express from 'express';
import { db } from '../db';
import { deferred } from './deferredWrites';
import { isWeb, runsJobs } from './role';

export const DEADLINE_MS = Number(process.env.DEADLINE_MS) || 900;
const SLOW_MS = 1000;
const LATE_FRESH_MS = Number(process.env.LATE_FRESH_MS) || 15_000;
const LATE_KEEP_MS = 30 * 60_000;
const LATE_MAX_BYTES = (Number(process.env.LATE_MEM_MAX_MB) || 32) * 1048576;
// personal / account routes: small web reads, never kept (a sign-in or a change answers them differently at once)
const NOT_KEPT = /^\/api\/(auth|picks|favorites|unlocks|email|push|billing|testers|unsubscribe|visit|health)(\/|$)/;

/* ---------- the late copies ---------- */

type Late = { at: number; status: number; headers: [string, string | number | string[]][]; body: Buffer };
const late = new Map<string, Late>();
let lateBytes = 0;
const refreshing = new Set<string>();
const lateDel = (k: string) => { const e = late.get(k); if (e) { lateBytes -= e.body.length; late.delete(k); } };
function lateSet(k: string, e: Late) {
  lateDel(k);
  late.set(k, e);
  lateBytes += e.body.length;
  for (const key of late.keys()) { if (lateBytes <= LATE_MAX_BYTES && late.size <= 4000) break; if (key !== k) lateDel(key); }
}
/** a signed-in person changed something (an unlock, a pick, a plan): their kept answers go */
export function dropLateOf(userId: number) {
  const p = `u${userId}|`;
  for (const k of [...late.keys()]) if (k.startsWith(p)) lateDel(k);
}
const SKIP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'date', 'set-cookie', 'keep-alive', 'x-sl-copy', 'x-sl-stale', 'x-sl-pending']);

/* ---------- the slow-request counter ---------- */

type Slow = { n: number; maxMs: number; crawler: number };
const minutes = new Map<number, Map<string, Slow>>(); // minute → route → counts (this process, last 60 minutes)
const slowStats = { total: 0, pendingSent: 0, appPageSent: 0, lateServed: 0, lateStale: 0, lateKept: 0, lateRefreshed: 0 };
function noteSlow(route: string, ms: number, crawler: boolean) {
  const m = Math.floor(Date.now() / 60_000);
  let b = minutes.get(m);
  if (!b) { minutes.set(m, (b = new Map())); for (const k of minutes.keys()) if (k < m - 60) minutes.delete(k); }
  const e = b.get(route) || { n: 0, maxMs: 0, crawler: 0 };
  e.n++; e.maxMs = Math.max(e.maxMs, Math.round(ms)); if (crawler) e.crawler++;
  if (b.size < 200 || b.has(route)) b.set(route, e);
  slowStats.total++;
}
if (runsJobs) {
  db.exec(`CREATE TABLE IF NOT EXISTS slow_requests (minute INTEGER NOT NULL, route TEXT NOT NULL, n INTEGER NOT NULL, max_ms INTEGER NOT NULL, crawler INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (minute, route))`);
  setInterval(() => { try { db.prepare(`DELETE FROM slow_requests WHERE minute < ?`).run(Math.floor(Date.now() / 60_000) - 7 * 1440); } catch { /* next hour */ } }, 3600_000).unref();
}
// each finished minute goes to slow_requests (written by the worker: the web process writes nothing itself)
const saveSlow = deferred(`INSERT OR REPLACE INTO slow_requests (minute, route, n, max_ms, crawler) VALUES (?, ?, ?, ?, ?)`);
const savedUpTo = { m: Math.floor(Date.now() / 60_000) - 1 };
if (isWeb || runsJobs) setInterval(() => {
  const now = Math.floor(Date.now() / 60_000);
  for (const [m, b] of minutes) if (m > savedUpTo.m && m < now) for (const [route, e] of b) { try { saveSlow.run(m, route, e.n, e.maxMs, e.crawler); } catch { /* next minute */ } }
  savedUpTo.m = now - 1;
}, 60_000).unref();

/** /api/perf: requests over 1 s in the last hour by route, what the deadline answered, the kept copies */
export function slowRequests() {
  const since = Math.floor(Date.now() / 60_000) - 60;
  const by = new Map<string, Slow>();
  for (const [m, b] of minutes) if (m >= since) for (const [r, e] of b) {
    const x = by.get(r) || { n: 0, maxMs: 0, crawler: 0 };
    x.n += e.n; x.maxMs = Math.max(x.maxMs, e.maxMs); x.crawler += e.crawler;
    by.set(r, x);
  }
  return { deadlineMs: DEADLINE_MS, ...slowStats, lastHour: [...by].sort((a, b) => b[1].n - a[1].n).slice(0, 20).map(([route, e]) => ({ route, ...e })), late: { copies: late.size, mb: Math.round(lateBytes / 1048576) } };
}

/* ---------- capture: a handler's answer after the visitor got theirs ---------- */

/**
 * From now on everything the handlers write to `res` is collected instead of sent (the visitor already has an answer);
 * `done` gets it when the handler ends. sendFile is dropped (a page: nothing to keep).
 */
function capture(res: express.Response, done: (status: number, headers: Map<string, any>, body: Buffer) => void) {
  const r: any = res;
  const headers = new Map<string, any>();
  const chunks: Buffer[] = [];
  let status = 0, ended = false;
  r.statusCode = 200;
  const add = (c: any, enc?: any) => { if (c != null && c !== '') chunks.push(Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(String(c), (typeof enc === 'string' ? enc : 'utf8') as BufferEncoding)); };
  r.setHeader = (n: string, v: any) => { headers.set(String(n).toLowerCase(), v); return res; };
  r.getHeader = (n: string) => headers.get(String(n).toLowerCase());
  r.getHeaders = () => Object.fromEntries(headers);
  r.getHeaderNames = () => [...headers.keys()];
  r.hasHeader = (n: string) => headers.has(String(n).toLowerCase());
  r.removeHeader = (n: string) => { headers.delete(String(n).toLowerCase()); };
  r.flushHeaders = () => undefined;
  r.writeHead = (code: number, a?: any, b?: any) => {
    status = code;
    const h = typeof a === 'string' ? b : a;
    if (h && !Array.isArray(h)) for (const [k, v] of Object.entries(h)) if (v !== undefined) headers.set(k.toLowerCase(), v);
    return res;
  };
  r.write = (c: any, enc?: any, cb?: any) => { add(c, enc); (typeof enc === 'function' ? enc : cb)?.(); return true; };
  r.end = (c?: any, enc?: any, cb?: any) => {
    if (typeof c === 'function') { cb = c; c = undefined; } else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (!ended) {
      ended = true;
      add(c, enc);
      try { done(status || r.statusCode || 200, headers, Buffer.concat(chunks)); } catch { /* nothing kept */ }
    }
    cb?.();
    return res;
  };
  r.sendFile = () => undefined;
}

/* ---------- the middlewares ---------- */

export interface DeadlineOpts {
  /** a public API GET (the guard answers { pending: true }) */
  isApi: (path: string) => boolean;
  /** an app page (the guard answers the plain app page); null = pages are not guarded */
  sendAppPage: ((res: express.Response) => boolean) | null;
  /** route label for the counter (perf.routeLabel) */
  label: (req: express.Request) => string;
  /** a verified search engine (never cut short) */
  crawler: (req: express.Request) => boolean;
}
type Loc = { slT0: number; slKey?: string | null; slNoLate?: boolean; slTimer?: NodeJS.Timeout; slCut?: boolean };
const loc = (res: express.Response) => res.locals as Loc;
const isPage = (req: express.Request) => !req.path.startsWith('/api/') && !req.path.startsWith('/socket.io') && !req.path.startsWith('/assets/')
  && !/\.[a-z0-9]{2,12}$/i.test(req.path) && /text\/html|\*\/\*/.test(String(req.get('accept') || 'text/html'));

/** a request's late-copy key: who asks (their id when signed in) + what changes the answer + the address */
export function lateKey(req: express.Request): string | null {
  const p = req.path;
  if (NOT_KEPT.test(p)) return null;
  const who = req.user ? `u${(req.user as any).id}` : req.access === 'admin' ? 'admin' : 'anon';
  const flags = [(req as any).proxyAnon ? 'proxy' : '', /\bgzip\b/.test(String(req.get('accept-encoding') || '')) ? 'gz' : ''].join(',');
  return `${who}|${flags}|${req.originalUrl}`;
}

/** early (every request): the clock, the counter and the guard */
export function deadlineStart(opts: DeadlineOpts) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!isWeb || (req.method !== 'GET' && req.method !== 'HEAD')) return next();
    const api = opts.isApi(req.path);
    const page = !api && !!opts.sendAppPage && isPage(req);
    if (!api && !page) return next();
    const l = loc(res);
    l.slT0 = performance.now();
    const crawler = opts.crawler(req);
    res.once('finish', () => {
      clearTimeout(l.slTimer);
      const ms = performance.now() - l.slT0;
      if (ms > SLOW_MS) noteSlow(opts.label(req), ms, crawler);
    });
    res.once('close', () => clearTimeout(l.slTimer));
    if (!crawler) {
      l.slTimer = setTimeout(() => {
        if (res.headersSent || res.writableEnded || req.destroyed) return;
        l.slCut = true;
        if (api) {
          slowStats.pendingSent++;
          res.status(202).set({ 'Cache-Control': 'no-store', 'X-SL-Pending': '1', 'Content-Type': 'application/json; charset=utf-8' }).end('{"pending":true,"data":null}');
          const k = l.slKey;
          capture(res, (status, headers, body) => {
            if (!k || l.slNoLate || status !== 200 || headers.has('set-cookie') || !body.length) return;
            slowStats.lateKept++;
            lateSet(k, { at: Date.now(), status, headers: [...headers].filter(([h]) => !SKIP_HEADERS.has(h)), body });
          });
        } else if (opts.sendAppPage!(res)) { slowStats.appPageSent++; capture(res, () => undefined); }
      }, DEADLINE_MS);
      l.slTimer.unref?.();
    }
    next();
  };
}

/** after the sign-in / proxy checks: a kept answer at once (stale ones refreshed in the background) */
export function lateCopy(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isWeb) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') { if (req.user) dropLateOf((req.user as any).id); return next(); }
  const l = loc(res);
  if (l.slT0 === undefined) return next(); // not a guarded request
  const k = lateKey(req);
  l.slKey = k;
  const e = k ? late.get(k) : undefined;
  if (!k || !e) return next();
  const age = Date.now() - e.at;
  if (age > LATE_KEEP_MS) { lateDel(k); return next(); }
  const stale = age > LATE_FRESH_MS;
  slowStats.lateServed++;
  if (stale) slowStats.lateStale++;
  res.status(e.status);
  for (const [h, v] of e.headers) res.setHeader(h, v);
  res.setHeader('X-SL-Copy', 'late');
  if (stale) res.setHeader('X-SL-Stale', String(Math.round(age / 1000)));
  res.end(req.method === 'HEAD' ? undefined : e.body);
  if (!stale || refreshing.has(k)) return;
  // the handler runs again for the next visitor's copy; what it writes is kept, not sent
  refreshing.add(k);
  clearTimeout(l.slTimer);
  capture(res, (status, headers, body) => {
    refreshing.delete(k);
    if (status !== 200 || l.slNoLate || headers.has('set-cookie') || !body.length) return;
    slowStats.lateRefreshed++;
    lateSet(k, { at: Date.now(), status, headers: [...headers].filter(([h]) => !SKIP_HEADERS.has(h)), body });
  });
  setTimeout(() => refreshing.delete(k), 60_000).unref();
  next();
}

/** a route that keeps its own copies (workerRoutes.ts): what it answers late is not kept here too */
export const keepsOwnCopies = (res: express.Response) => { loc(res).slNoLate = true; };
/** the guard already answered (a handler that still runs is working for the next visitor) */
export const wasCut = (res: express.Response) => !!loc(res).slCut;

type Check = { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items?: string[] };
/** data health (worker): public GETs over 1 s in the last hour (search engines apart: they wait on purpose) */
export function slowRequestsHealth(): Check {
  const since = Math.floor(Date.now() / 60_000) - 60;
  let rows: any[] = [];
  try { rows = db.prepare(`SELECT route, SUM(n) AS n, MAX(max_ms) AS max_ms, SUM(crawler) AS crawler FROM slow_requests WHERE minute >= ? GROUP BY route ORDER BY n DESC`).all(since) as any[]; } catch { /* no table yet */ }
  const people = rows.map(r => ({ ...r, people: r.n - r.crawler })).filter(r => r.people > 0);
  const crawlers = rows.reduce((t, r) => t + r.crawler, 0);
  const total = people.reduce((t, r) => t + r.people, 0);
  return {
    id: 'slow-requests', label: 'Slow requests',
    level: total ? 'fail' : 'ok',
    detail: total ? `${total} public request(s) took over 1 s in the last hour (target 0)` : `No public request over 1 s in the last hour${crawlers ? ` (search engines waiting for a first page build: ${crawlers})` : ''}`,
    items: people.slice(0, 15).map(r => `${r.route}: ${r.people} × over 1 s, longest ${(r.max_ms / 1000).toFixed(1)} s`)
  };
}

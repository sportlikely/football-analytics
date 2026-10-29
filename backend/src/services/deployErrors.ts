/**
 * fix227: "Errors during the last deploy". The web process counts every 5xx it answers in its first 5 minutes (a
 * process start = a deploy or a restart), by kind: the app's files (/assets, sw.js, icons), pages (index.html and the
 * crawler HTML), the API — and apart from them the 503s of /health (Railway's check while the state loads: expected).
 * After 5 minutes one row goes to deploy_errors (through the worker: deferred). Data health shows the last start;
 * target 0 for files and pages. The 502s Railway's proxy answers while no process listens never reach us: the
 * visitor's side of those is the inline loader in index.html (retries, then "Updating SportLikely…").
 * fix232: + every 503 "Loading" a stored list answered (no copy of it yet) in the first 30 minutes, apart from the
 * first 60 s — on 25 Oct /api/basketball/games answered it for ~12 min after the deploy. Target 0 after the first 60 s.
 * fix276: + the warm-up (the first 10 minutes after ready, readiness.ts): the search engines' 503 "Starting up", the public
 * requests over 1 s and the reads over 500 ms in it — counted here, not in "Search engines verified" / "Slow requests" /
 * "Slow reads (3 h)". Record only.
 */
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { deferred } from './deferredWrites';
import { isWeb, runsJobs } from './role';
import { readiness, WARM_UP_MS } from './readiness';

const WINDOW_MS = 5 * 60 * 1000;
const startedAt = Math.round(Date.now() - process.uptime() * 1000); // the process start (boot.ts listens before this module loads)
type Kind = 'files' | 'pages' | 'api' | 'health';
const counts: Record<Kind, number> = { files: 0, pages: 0, api: 0, health: 0 };
const statuses: Record<string, number> = {};
let requests = 0;
let saved = false;
const LOADING_WINDOW_MS = 30 * 60 * 1000, LOADING_GRACE_MS = 60 * 1000;
const loading = { early: 0, late: 0, paths: {} as Record<string, number> };
let crawlerStartup = 0;
/** fix276: a search engine got 503 "Starting up" in the warm-up (crawlerIps.ts) */
export function noteCrawlerStartup() { crawlerStartup++; }

if (runsJobs) db.exec(`CREATE TABLE IF NOT EXISTS deploy_errors (started_at TEXT PRIMARY KEY, requests INTEGER NOT NULL,
  files INTEGER NOT NULL, pages INTEGER NOT NULL, api INTEGER NOT NULL, health INTEGER NOT NULL, statuses TEXT NOT NULL)`);
if (runsJobs) for (const col of ['loading INTEGER', 'loading_late INTEGER', 'loading_paths TEXT', 'crawler_503 INTEGER', 'ready_at TEXT']) { try { db.exec(`ALTER TABLE deploy_errors ADD COLUMN ${col}`); } catch { /* there already */ } }

export function kindOf(p: string): Kind {
  if (p === '/health' || p === '/api/health') return 'health';
  if (p.startsWith('/api/') || p.startsWith('/socket.io/')) return 'api';
  if (p.startsWith('/assets/') || /\.[a-z0-9]{2,12}$/i.test(p)) return 'files';
  return 'pages';
}

export const deployErrors = () => ({ startedAt: new Date(startedAt).toISOString(), requests, ...counts, statuses: { ...statuses }, loading: loading.early + loading.late, loadingLate: loading.late, loadingPaths: { ...loading.paths }, crawlerStartup, readyAt: readiness().readyAt });

/** fix232: a stored list answered 503 "Loading" (app.ts sendStored: no copy of it yet) */
export function noteLoading(path: string) {
  const age = Date.now() - startedAt;
  if (age > LOADING_WINDOW_MS) return;
  if (age > LOADING_GRACE_MS) loading.late++; else loading.early++;
  if (Object.keys(loading.paths).length < 20 || loading.paths[path]) loading.paths[path] = (loading.paths[path] || 0) + 1;
}

function save() {
  saved = true;
  const d = deployErrors();
  deferred(`INSERT OR REPLACE INTO deploy_errors (started_at, requests, files, pages, api, health, statuses, loading, loading_late, loading_paths, crawler_503, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.startedAt, d.requests, d.files, d.pages, d.api, d.health, JSON.stringify(d.statuses), d.loading, d.loadingLate, JSON.stringify(d.loadingPaths), d.crawlerStartup, d.readyAt);
}
// the 5-minute row, then again at 30 minutes with the "Loading" answers of the whole half hour
if (isWeb) { setTimeout(save, WINDOW_MS + 1000).unref(); setTimeout(save, LOADING_WINDOW_MS + 1000).unref(); }

export function deployErrorsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (Date.now() - startedAt > WINDOW_MS) return next();
  requests++;
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    counts[kindOf(req.path)]++;
    statuses[res.statusCode] = (statuses[res.statusCode] || 0) + 1;
  });
  next();
}

type Check = { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items?: string[] };
/** data health (worker): the last start's 5 minutes, and the last 10 starts */
export function deployErrorsHealth(): Check[] {
  const rows = db.prepare(`SELECT * FROM deploy_errors ORDER BY started_at DESC LIMIT 10`).all() as any[];
  if (!rows.length) return [{ id: 'deploy-errors', label: 'Errors during the last deploy', level: 'ok', detail: 'No start recorded yet (written 5 minutes after the web process starts)' }];
  const r = rows[0];
  const bad = r.files + r.pages;
  const late = r.loading_late || 0;
  const line = (x: any) => `${x.started_at.slice(0, 16).replace('T', ' ')} UTC: ${x.requests} requests — files ${x.files}, pages ${x.pages}, API ${x.api}, /health ${x.health} (expected while loading) · ${x.statuses}`
    + (x.loading ? ` · lists "Loading" ${x.loading} (${x.loading_late || 0} after 60 s: ${x.loading_paths || '{}'})` : '');
  return [{
    id: 'deploy-errors', label: 'Errors during the last deploy',
    level: bad || late ? 'fail' : r.api ? 'warn' : 'ok',
    detail: bad ? `${bad} file / page request(s) got a 5xx in the 5 minutes after the start (target 0)`
      : late ? `${late} list request(s) got 503 "Loading" more than 60 s after the start (no stored copy; target 0): ${r.loading_paths || ''}`
      : r.api ? `${r.api} API request(s) got a 5xx in the 5 minutes after the start (the app retries "Starting up" answers; target 0)`
      : `No 5xx for files, pages or the API in the 5 minutes after the start (${r.requests} requests)`,
    items: [warmUpLine(r), ...rows.map(line)]
  }];
}

/** fix276: what the last start's warm-up held (the first 10 minutes after ready) — counted here, not in the hour's checks */
export function warmUpLine(r: { started_at: string; ready_at?: string | null; crawler_503?: number | null }): string {
  const from = Date.parse(r.started_at), ready = r.ready_at ? Date.parse(r.ready_at) : from, to = ready + WARM_UP_MS;
  let slow = 0, reads = 0;
  try { slow = Number((db.prepare(`SELECT COALESCE(SUM(warm), 0) AS n FROM slow_requests WHERE minute >= ? AND minute <= ?`).get(Math.floor(from / 60_000), Math.floor(to / 60_000)) as any)?.n || 0); } catch { /* no table yet */ }
  try { reads = Number((db.prepare(`SELECT COALESCE(SUM(warm500), 0) AS n FROM reader_hours WHERE hour >= ? AND hour <= ?`).get(new Date(from).toISOString().slice(0, 13), new Date(to).toISOString().slice(0, 13)) as any)?.n || 0); } catch { /* no column yet */ }
  const hm = (t: number) => new Date(t).toISOString().slice(11, 16);
  return `Warm-up ${hm(from)}–${hm(to)} UTC (ready ${r.ready_at ? hm(ready) : 'not recorded'} + 10 min): ${slow} public request(s) over 1 s, ${reads} read(s) over 500 ms, ${r.crawler_503 || 0} search-engine 503 "Starting up" — not counted in "Slow requests", "Slow reads (3 h)" or "Search engines verified"`;
}

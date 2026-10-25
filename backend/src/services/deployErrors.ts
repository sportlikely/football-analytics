/**
 * fix227: "Errors during the last deploy". The web process counts every 5xx it answers in its first 5 minutes (a
 * process start = a deploy or a restart), by kind: the app's files (/assets, sw.js, icons), pages (index.html and the
 * crawler HTML), the API — and apart from them the 503s of /health (Railway's check while the state loads: expected).
 * After 5 minutes one row goes to deploy_errors (through the worker: deferred). Data health shows the last start;
 * target 0 for files and pages. The 502s Railway's proxy answers while no process listens never reach us: the
 * visitor's side of those is the inline loader in index.html (retries, then "Updating SportLikely…").
 */
import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { deferred } from './deferredWrites';
import { isWeb, runsJobs } from './role';

const WINDOW_MS = 5 * 60 * 1000;
const startedAt = Math.round(Date.now() - process.uptime() * 1000); // the process start (boot.ts listens before this module loads)
type Kind = 'files' | 'pages' | 'api' | 'health';
const counts: Record<Kind, number> = { files: 0, pages: 0, api: 0, health: 0 };
const statuses: Record<string, number> = {};
let requests = 0;
let saved = false;

if (runsJobs) db.exec(`CREATE TABLE IF NOT EXISTS deploy_errors (started_at TEXT PRIMARY KEY, requests INTEGER NOT NULL,
  files INTEGER NOT NULL, pages INTEGER NOT NULL, api INTEGER NOT NULL, health INTEGER NOT NULL, statuses TEXT NOT NULL)`);

export function kindOf(p: string): Kind {
  if (p === '/health' || p === '/api/health') return 'health';
  if (p.startsWith('/api/') || p.startsWith('/socket.io/')) return 'api';
  if (p.startsWith('/assets/') || /\.[a-z0-9]{2,12}$/i.test(p)) return 'files';
  return 'pages';
}

export const deployErrors = () => ({ startedAt: new Date(startedAt).toISOString(), requests, ...counts, statuses: { ...statuses } });

function save() {
  if (saved) return;
  saved = true;
  const d = deployErrors();
  deferred(`INSERT OR REPLACE INTO deploy_errors (started_at, requests, files, pages, api, health, statuses) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(d.startedAt, d.requests, d.files, d.pages, d.api, d.health, JSON.stringify(d.statuses));
}
if (isWeb) setTimeout(save, WINDOW_MS + 1000).unref();

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
  const line = (x: any) => `${x.started_at.slice(0, 16).replace('T', ' ')} UTC: ${x.requests} requests — files ${x.files}, pages ${x.pages}, API ${x.api}, /health ${x.health} (expected while loading) · ${x.statuses}`;
  return [{
    id: 'deploy-errors', label: 'Errors during the last deploy',
    level: bad ? 'fail' : r.api ? 'warn' : 'ok',
    detail: bad ? `${bad} file / page request(s) got a 5xx in the 5 minutes after the start (target 0)`
      : r.api ? `${r.api} API request(s) got a 5xx in the 5 minutes after the start (the app retries "Starting up" answers; target 0)`
      : `No 5xx for files, pages or the API in the 5 minutes after the start (${r.requests} requests)`,
    items: rows.map(line)
  }];
}

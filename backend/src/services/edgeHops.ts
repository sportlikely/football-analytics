/**
 * fix262: req.ip for every request = the hop just left of Railway's edge (utils/clientIp.ts clientOfRequest). The
 * web process learns the edge ranges from the traffic (EdgeLearner) and keeps them in edge_ranges (written through
 * deferred(); loaded at start, so a restart doesn't begin cold); the worker reads the table for data health.
 * Addresses of visitors are never stored: only the edge ranges (Railway's own servers) and network names with counts.
 */
import type express from 'express';
import logger from '../utils/logger';
import { db } from '../db';
import { isWeb, isWorker } from './role';
import { deferred } from './deferredWrites';
import { every } from './perf';
import { networkOf } from './asn';
import { INTERNAL_HEADER } from './forward';
import { EdgeLearner, EdgeRange, clientOfRequest, hasEdgeHeader } from '../utils/clientIp';
import { noteClientNetwork } from './crawlerIps';

db.exec(`CREATE TABLE IF NOT EXISTS edge_ranges (range TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL, lefts INTEGER NOT NULL, share REAL NOT NULL)`);
const asnOf = (ip: string) => networkOf(ip)?.asn ?? null;
export const edgeLearner = new EdgeLearner(asnOf);
function loadRanges() {
  try {
    for (const r of db.prepare(`SELECT range, first_at, last_at, lefts, share FROM edge_ranges`).all() as any[])
      edgeLearner.load(r.range, Date.parse(r.first_at), Date.parse(r.last_at), r.lefts, r.share);
  } catch { /* none yet */ }
}
loadRanges();
const save = deferred(`INSERT OR REPLACE INTO edge_ranges (range, first_at, last_at, lefts, share) VALUES (?, ?, ?, ?, ?)`);
const saveRow = (r: EdgeRange) => save.run(r.range, r.first, r.last, r.lefts, r.share);
edgeLearner.onLearn = r => { logger.info(`fix262: Railway edge range learned ${r.range} (last hop for ${r.lefts}+ addresses, ${Math.round(r.share * 100)}% of edge requests)`); saveRow(r); };
// last-seen kept fresh (a range unseen for 7 days is dropped at the next start)
if (isWeb || !isWorker) every('edge ranges save', () => { for (const r of edgeLearner.ranges()) saveRow(r); }, 10 * 60 * 1000).unref();

/** Express middleware (first of all): req.ip = the client, never Railway's edge */
export function clientIpMiddleware(req: express.Request, _res: express.Response, next: express.NextFunction) {
  try {
    const socket = req.socket?.remoteAddress || '';
    const xff = req.headers['x-forwarded-for'] as string | undefined;
    // the worker's copy gets the client from the web process (one hop, forward.ts): nothing to learn there
    if (!req.headers[INTERNAL_HEADER]) edgeLearner.note(socket, xff, req.headers);
    const ip = clientOfRequest(socket, xff, req.headers, asnOf, edgeLearner);
    Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true, writable: true });
    if (!req.headers[INTERNAL_HEADER]) noteClientNetwork(networkOf(ip)?.name ?? null, hasEdgeHeader(req.headers));
  } catch { /* Express's own req.ip stays */ }
  next();
}

/** data health / reply: the learned edge ranges (worker: from the table) */
export function edgeStatus() {
  if (isWorker && !isWeb) { loadRanges(); }
  return edgeLearner.status();
}

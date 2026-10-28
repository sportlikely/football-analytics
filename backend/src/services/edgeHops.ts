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
import { EdgeLearner, EdgeRange, explainClient, hasEdgeHeader } from '../utils/clientIp';
import { noteClientNetwork } from './crawlerIps';

db.exec(`CREATE TABLE IF NOT EXISTS edge_ranges (range TEXT PRIMARY KEY, first_at TEXT NOT NULL, last_at TEXT NOT NULL, lefts INTEGER NOT NULL, share REAL NOT NULL)`);
// fix262b: the network (AS) of each range — a hop in that network is an edge hop too
try { db.exec(`ALTER TABLE edge_ranges ADD COLUMN asn INTEGER`); } catch { /* there */ }
const asnOf = (ip: string) => networkOf(ip)?.asn ?? null;
export const edgeLearner = new EdgeLearner(asnOf);
function loadRanges() {
  try {
    for (const r of db.prepare(`SELECT range, first_at, last_at, lefts, share, asn FROM edge_ranges`).all() as any[])
      edgeLearner.load(r.range, Date.parse(r.first_at), Date.parse(r.last_at), r.lefts, r.share, r.asn ?? null);
  } catch { /* none yet */ }
}
loadRanges();
const save = deferred(`INSERT OR REPLACE INTO edge_ranges (range, first_at, last_at, lefts, share, asn) VALUES (?, ?, ?, ?, ?, ?)`);
const saveRow = (r: EdgeRange) => save.run(r.range, r.first, r.last, r.lefts, r.share, r.asn);
edgeLearner.onLearn = r => { logger.info(`fix262: Railway edge range learned ${r.range} (${r.asn ? `AS${r.asn}, ` : ''}last hop for ${r.lefts}+ addresses, ${Math.round(r.share * 100)}% of edge requests)`); saveRow(r); };
// last-seen kept fresh (a range unseen for 30 days is dropped at the next start, fix262b)
if (isWeb || !isWorker) every('edge ranges save', () => { for (const r of edgeLearner.ranges()) saveRow(r); }, 10 * 60 * 1000).unref();

/** Express middleware (first of all): req.ip = the client, never Railway's edge */
export function clientIpMiddleware(req: express.Request, _res: express.Response, next: express.NextFunction) {
  try {
    const socket = req.socket?.remoteAddress || '';
    const xff = req.headers['x-forwarded-for'] as string | undefined;
    // the worker's copy gets the client from the web process (one hop, forward.ts): nothing to learn there
    if (!req.headers[INTERNAL_HEADER]) edgeLearner.note(socket, xff, req.headers);
    const x = explainClient(socket, xff, req.headers, asnOf, edgeLearner);
    const ip = x.ip;
    Object.defineProperty(req, 'ip', { value: ip, configurable: true, enumerable: true, writable: true });
    // fix262b: the hop list for the Googlebot-UA log; a hop skipped only by its network = never a verified search engine
    (req as any).slHops = x;
    if (x.edgeAsnSkip) (req as any).slEdgeAsnSkip = true;
    if (!req.headers[INTERNAL_HEADER]) noteClientNetwork(networkOf(ip)?.name ?? null, hasEdgeHeader(req.headers), x.edgeAsnSkip, x.allProxy);
  } catch { /* Express's own req.ip stays */ }
  next();
}

/** data health / reply: the learned edge ranges (worker: from the table) */
export function edgeStatus() {
  if (isWorker && !isWeb) { loadRanges(); }
  return edgeLearner.status();
}

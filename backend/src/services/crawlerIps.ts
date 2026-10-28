/**
 * fix245: search engines verified by their published address lists (rules in utils/crawlerRanges.ts), and what they got.
 *  - the worker downloads Google's (googlebot, special crawlers, user-triggered fetchers), Bing's and Apple's lists
 *    daily (DATA_DIR/geo/crawler-ranges.json, publishState 'crawler-ranges'); the web process reads the file at start
 *    (the ready gate needs it before the state loads), then takes the worker's copy. A list that fails to download keeps
 *    its last copy; before any download the seed ranges (Googlebot 66.249.64.0/19 …) apply.
 *  - every request with a Google / Bing / Apple user-agent is counted in the web process (requests, verified by list /
 *    DNS, refused = answered 429 or 503) and so is every request from Google's own ranges that got a 429 / 503 — data
 *    health "Search engines verified" fails on any of those. Written by the worker (crawler_day, one row a day).
 *  - one DNS sample a day for a Google crawl address (the PTR names or the error, the system and a public resolver):
 *    Admin → Visitors → "Search engines". The addresses are Google's published crawl addresses, not visitors'.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import logger from '../utils/logger';
import { db } from '../db';
import { isWeb, isWorker } from './role';
import { deferred } from './deferredWrites';
import { every, after } from './perf';
import { onState, publishState } from './shared';
import { networkOf } from './asn';
import { clientOf, hasEdgeHeader, hopLine } from '../utils/clientIp';
import { CrawlerRanges, RANGE_SOURCES, SEED_RANGES, parseRangeFile, listedCrawler, engineOfUa, Engine } from '../utils/crawlerRanges';

const FILE = path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), 'geo', 'crawler-ranges.json');
type Saved = { at: string; lists: Record<string, { engine: Engine; at: string; prefixes: string[] }> };

let saved: Saved | null = null;
let ranges = new CrawlerRanges(SEED_RANGES);
let status = 'seed ranges only (not downloaded yet)';

function use(d: Saved) {
  saved = d;
  const by: Partial<Record<Engine, string[]>> = { google: [...SEED_RANGES.google], bing: [...SEED_RANGES.bing], apple: [...SEED_RANGES.apple] };
  for (const l of Object.values(d.lists || {})) (by[l.engine] ||= []).push(...l.prefixes);
  ranges = new CrawlerRanges(by);
  status = Object.entries(d.lists || {}).map(([n, l]) => `${n} ${l.prefixes.length} (${l.at.slice(0, 10)})`).join(' · ') || 'seed ranges only';
}
try { use(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* none yet: the seed */ }
onState('crawler-ranges', (_k, v: any) => { if (v?.lists) use(v); });

function getJson(url: string, redirects = 3): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'SportLikely/1.0 (crawler verification)', accept: 'application/json' }, timeout: 30000 }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return getJson(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`answered ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 5e6) res.destroy(new Error('too big')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('timeout', function (this: any) { this.destroy(new Error('timeout')); }).on('error', reject);
  });
}

/** worker: download every list (a failed one keeps its last copy), save, publish */
export async function refreshCrawlerRanges(fetchJson: (url: string) => Promise<unknown> = getJson): Promise<string[]> {
  const lists = { ...(saved?.lists || {}) };
  const failed: string[] = [];
  for (const s of RANGE_SOURCES) {
    try {
      const prefixes = parseRangeFile(await fetchJson(s.url));
      if (!prefixes.length) throw new Error('no prefixes');
      lists[s.name] = { engine: s.engine, at: new Date().toISOString(), prefixes };
    } catch (e: any) { failed.push(`${s.name}: ${e?.message || e}`); }
  }
  const d: Saved = { at: new Date().toISOString(), lists };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.part', JSON.stringify(d));
    fs.renameSync(FILE + '.part', FILE);
  } catch (e: any) { logger.warn(`crawler ranges: not saved: ${e.message}`); }
  use(d);
  publishState('crawler-ranges', d);
  logger.info(`crawler ranges: ${status}${failed.length ? ` — kept the last copy of ${failed.join('; ')}` : ''}`);
  return failed;
}
export function startCrawlerRanges() {
  const run = () => refreshCrawlerRanges().catch(e => logger.warn(`crawler ranges: ${e?.message || e}`));
  after('crawler ranges', run, 60 * 1000).unref();
  every('crawler ranges', run, 24 * 3600 * 1000).unref();
}
/** test hook: use these lists now */
export const useCrawlerRanges = (d: Saved) => use(d);

/** The engine when this user-agent + address is a crawler in its engine's published list (verified even when DNS fails). */
export const crawlerByList = (ua: string | undefined | null, ip: string | undefined | null) => listedCrawler(ranges, ua, ip);
/** The address is in one of Google's published lists (any user-agent). */
export const inGoogleRanges = (ip: string | undefined | null) => ranges.engineOf(ip) === 'google';
export const crawlerRangesStatus = () => ({ status, ranges: ranges.size, at: saved?.at || null });

/* ---------- what the search engines got (web process counts, the worker writes) ---------- */

type EngineDay = { requests: number; verified: number; byList: number; byDns: number; refused: number; s429: number; s503: number; api: number };
export type DnsSample = { at: string; ip: string; system: string; publicDns: string; forward: string; ok: boolean };
/** fix254: one Googlebot-UA request as it reached us — every hop of the address chain, to see who the client really is */
export type UaSample = { at: string; path: string; socket: string; xff: string; realIp: string; reqIp: string; client: string; asn: string; inGoogle: boolean; googleHop: string | null; edge?: boolean; oldRule?: string; hops?: string; why?: string };
type Counts = { engines: Record<Engine, EngineDay>; googleRanges: { requests: number; refused: number; s429: number; s503: number } };
/** fix262: `since` = when the counts start on the fixed client address; the day's counts before it are in `before262`
 *  (they were taken on Railway's edge address); `networks` = the clients' listed networks (names + counts, no address) */
type Day = Counts & { day: string; refusedRecent: string[]; sample: DnsSample | null; uaLog?: UaSample[]; since?: string; before262?: Counts; networks?: Record<string, number>; edgeRequests?: number; requestsAll?: number;
  /** fix262b: requests where a hop was skipped only by its network (edge AS), where every hop was a proxy; fake crawlers */
  edgeAsnSkips?: number; allProxy?: number; fakes?: { requests: number; byNetwork: Record<string, number> } };
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): EngineDay => ({ requests: 0, verified: 0, byList: 0, byDns: 0, refused: 0, s429: 0, s503: 0, api: 0 });
const fresh = (): Day => ({ day: today(), engines: { google: blank(), bing: blank(), apple: blank() }, googleRanges: { requests: 0, refused: 0, s429: 0, s503: 0 }, refusedRecent: [], sample: null, since: new Date().toISOString() });

db.exec(`CREATE TABLE IF NOT EXISTS crawler_day (day TEXT PRIMARY KEY, data TEXT NOT NULL)`);
let cur: Day = fresh();
let dirty0 = false;
// a restart keeps the day's numbers
try {
  const r = db.prepare(`SELECT data FROM crawler_day WHERE day = ?`).get(cur.day) as any;
  if (r?.data) {
    const old = JSON.parse(r.data);
    // fix262: the counts taken before the fix (on the edge address) move aside; today's restart on the right address
    if (old.since) cur = { ...fresh(), ...old };
    else if (isWeb || !isWorker) { const f = fresh(); cur = { ...f, ...old, engines: f.engines, googleRanges: f.googleRanges, refusedRecent: [], since: f.since, before262: { engines: old.engines, googleRanges: old.googleRanges } }; dirty0 = true; }
    else cur = { ...fresh(), ...old };
  }
} catch { /* none */ }
let dirty = dirty0;
const up = deferred(`INSERT OR REPLACE INTO crawler_day (day, data) VALUES (?, ?)`);
function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    up.run(cur.day, JSON.stringify(cur));
    if (!isWeb) {
      db.prepare(`DELETE FROM crawler_day WHERE day < ?`).run(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
      // fix254: the Googlebot-UA log holds addresses (privacy: only the security log keeps addresses longer) — 3 days
      dropOldUaLogs();
    }
  } catch (e: any) { logger.warn(`crawler day flush: ${e.message}`); }
}
function roll() { if (cur.day !== today()) { flush(); cur = fresh(); } }
if (isWeb || !isWorker) every('crawler day flush', flush, 60 * 1000).unref();

/**
 * fix262b: a search-engine user-agent from a data-centre network (Azure, AWS …) that is not in the engine's own list
 * and not verified — a fake (often with a forged Google address in X-Forwarded-For). Counted as "fake crawler", not as
 * the engine; still refused by the proxy rules.
 */
export function isFakeCrawler(ua: string, ip: string | undefined, how: 'list' | 'dns' | null): string | null {
  if (how || !engineOfUa(ua) || !ip) return null;
  if (listedCrawler(ranges, ua, ip) || inGoogleRanges(ip)) return null;
  return networkOf(ip)?.name ?? null;
}
/** web: one answered request (`how` = how it was verified, null = not verified) */
export function noteCrawlerResponse(ua: string, ip: string | undefined, how: 'list' | 'dns' | null, status: number, reqPath: string) {
  try {
    const google = inGoogleRanges(ip);
    let e = engineOfUa(ua);
    if (!e && !google) return;
    roll();
    const fake = isFakeCrawler(ua, ip, how);
    if (fake) {
      const f = (cur.fakes ||= { requests: 0, byNetwork: {} });
      f.requests++;
      if (f.byNetwork[fake] !== undefined || Object.keys(f.byNetwork).length < 30) f.byNetwork[fake] = (f.byNetwork[fake] || 0) + 1;
      dirty = true;
      e = null;
      if (!google) return;
    }
    const bad = status === 429 || status === 503;
    if (e) {
      const d = cur.engines[e];
      d.requests++;
      if (reqPath.startsWith('/api/')) d.api++;
      if (how) { d.verified++; if (how === 'list') d.byList++; else d.byDns++; }
      if (bad) { d.refused++; if (status === 429) d.s429++; else d.s503++; }
    }
    if (google) {
      cur.googleRanges.requests++;
      if (bad) {
        cur.googleRanges.refused++;
        if (status === 429) cur.googleRanges.s429++; else cur.googleRanges.s503++;
        if (cur.refusedRecent.length >= 20) cur.refusedRecent.shift();
        cur.refusedRecent.push(`${new Date().toISOString().slice(11, 19)} ${status} ${reqPath.slice(0, 120)} (${ua.slice(0, 60)})`);
      }
    }
    dirty = true;
  } catch { /* counting never breaks a request */ }
}
/** fix254: Googlebot-UA log — 20 a day, one per 72-minute slot (spread over the day), each with the whole chain */
export const UA_LOG_MAX = 20;
const SLOT_MS = 86400000 / UA_LOG_MAX;
const lastSlot = { day: '', slot: -1 };
export function noteGooglebotSample(req: { ip?: string; path?: string; socket?: { remoteAddress?: string }; headers: Record<string, any> }, now = Date.now()) {
  try {
    roll();
    const slot = Math.floor((now % 86400000) / SLOT_MS);
    if (lastSlot.day === cur.day && lastSlot.slot === slot) return;
    const log = (cur.uaLog ||= []);
    if (log.length >= UA_LOG_MAX) return;
    lastSlot.day = cur.day; lastSlot.slot = slot;
    const socket = req.socket?.remoteAddress || '';
    const xff = String(req.headers['x-forwarded-for'] || '');
    const asnOf = (ip: string) => networkOf(ip)?.asn ?? null;
    const reqIp = req.ip || '';
    const nw = reqIp ? networkOf(reqIp) : null;
    const hops = [...xff.split(',').map(x => x.trim()).filter(Boolean), socket];
    log.push({
      at: new Date(now).toISOString(), path: String(req.path || '').slice(0, 100), socket, xff: xff.slice(0, 300),
      realIp: String(req.headers['x-real-ip'] || '').slice(0, 60), reqIp, client: reqIp,
      asn: nw ? `AS${nw.asn} ${nw.name}` : 'not a listed network', inGoogle: inGoogleRanges(reqIp),
      googleHop: hops.find(h => inGoogleRanges(h)) || null,
      // fix262: did the edge headers come, and what fix254's rule (rightmost non-private hop) would have taken
      edge: hasEdgeHeader(req.headers), oldRule: clientOf(socket, xff, asnOf),
      // fix262b: every hop from the left, which one was taken and why
      ...((req as any).slHops ? { hops: hopLine((req as any).slHops).slice(0, 400), why: (req as any).slEdgeAsnSkip ? 'a hop skipped by its network only: never verified as a search engine' : undefined } : {})
    });
    dirty = true;
  } catch { /* logging never breaks a request */ }
}
/** keep the address log 3 days (the day counts stay 30) */
function dropOldUaLogs() {
  const cut = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT day, data FROM crawler_day WHERE day < ? AND data LIKE '%"uaLog"%'`).all(cut) as { day: string; data: string }[];
  for (const r of rows) { const d = JSON.parse(r.data); delete d.uaLog; db.prepare(`UPDATE crawler_day SET data = ? WHERE day = ?`).run(JSON.stringify(d), r.day); }
}
/** fix254: what the log says, in one line (data health + the reply): is req.ip the client, and is any hop Google's? */
export function uaLogSummary(d: Day | null): string {
  const l = d?.uaLog || [];
  if (!l.length) return 'no Googlebot-UA request logged yet';
  const google = l.filter(x => x.inGoogle).length, anyHop = l.filter(x => x.googleHop).length;
  const xffHops = Math.max(...l.map(x => x.xff ? x.xff.split(',').length : 0));
  // fix262: the samples taken since the fix carry `oldRule`; req.ip ≠ fix254's rule = the edge hop was skipped
  const fixed = l.filter(x => x.oldRule !== undefined), skipped = fixed.filter(x => x.oldRule !== x.reqIp).length, edge = fixed.filter(x => x.edge).length;
  return `${l.length} logged: req.ip in Google's list ${google} (any hop ${anyHop}), up to ${xffHops} X-Forwarded-For hop(s)` +
    (fixed.length ? ` · since fix262: ${fixed.length} with the edge headers on ${edge}, Railway's edge hop skipped in ${skipped}` : '');
}

/** web: the day's DNS sample for a Google crawl address is still to take */
export const wantsDnsSample = (ip: string) => { roll(); return !cur.sample && (ip.startsWith('66.249.') || inGoogleRanges(ip)); };
export function noteDnsSample(s: DnsSample) { roll(); if (!cur.sample) { cur.sample = s; dirty = true; } }

/** today's numbers (worker: the row the web process wrote; one process: memory) */
export function crawlerDay(day = today()): Day | null {
  if (!isWorker && day === cur.day) { roll(); return cur; }
  try { const r = db.prepare(`SELECT data FROM crawler_day WHERE day = ?`).get(day) as any; return r?.data ? { ...fresh(), ...JSON.parse(r.data), day } : null; } catch { return null; }
}

/** Admin → Visitors "Search engines": today and yesterday, the lists, the DNS sample */
export function crawlerReport() {
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  return { today: crawlerDay(), yesterday: crawlerDay(y), lists: crawlerRangesStatus() };
}

/** fix262 (web): every request's client network (a listed data-centre / proxy network name, or none) — counts only */
export function noteClientNetwork(name: string | null, viaEdge: boolean, edgeAsnSkip = false, allProxy = false) {
  try {
    roll();
    cur.requestsAll = (cur.requestsAll || 0) + 1;
    if (viaEdge) cur.edgeRequests = (cur.edgeRequests || 0) + 1;
    if (edgeAsnSkip) cur.edgeAsnSkips = (cur.edgeAsnSkips || 0) + 1;
    if (allProxy) cur.allProxy = (cur.allProxy || 0) + 1;
    dirty = true;
    if (!name) return;
    const n = (cur.networks ||= {});
    if (n[name] !== undefined || Object.keys(n).length < 50) n[name] = (n[name] || 0) + 1;
  } catch { /* counting never breaks a request */ }
}
/** fix262: the networks line (data health + the reply) */
export function networksLine(d: Day | null): string {
  if (!d?.requestsAll) return 'client networks: none counted yet';
  const top = Object.entries(d.networks || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
  return `client networks since ${(d.since || '').slice(11, 16)} UTC: ${d.requestsAll} requests (${d.edgeRequests || 0} via Railway's edge headers, ${d.edgeAsnSkips || 0} with an edge-network hop skipped, ${d.allProxy || 0} with no client hop at all), from listed data-centre / proxy networks: ${top || 'none'}`;
}

/** data health "Search engines verified": fail when any request from Google's own ranges got a 429 or 503 today */
export function crawlerHealth(edge?: { ranges: { range: string; lefts: number; share: number }[]; windowRequests: number }) {
  const d = crawlerDay() || fresh();
  const g = d.engines.google, gr = d.googleRanges;
  const level: 'ok' | 'warn' | 'fail' = gr.refused > 0 ? 'fail' : g.requests >= 20 && g.verified * 2 < g.requests ? 'warn' : 'ok';
  const items = [...d.refusedRecent.slice(-10)];
  items.push(`Googlebot-UA log: ${uaLogSummary(d)}`);
  if (edge) items.push(`Railway edge ranges (fix262, learned): ${edge.ranges.map(r => `${r.range} (${r.lefts}+ clients, ${Math.round(r.share * 100)}%)`).join(', ') || 'none yet'}`);
  items.push(networksLine(d));
  if (d.fakes?.requests) items.push(`fake crawlers (search-engine user-agent from a data-centre network, not verified; refused, not counted as the engine): ${d.fakes.requests} — ${Object.entries(d.fakes.byNetwork).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  // fix262b: the newest samples with every hop (which one was taken and why)
  for (const x of (d.uaLog || []).filter(x => x.hops).slice(-5)) items.push(`sample ${x.at.slice(11, 16)} ${x.path}: ${x.hops}${x.why ? ` — ${x.why}` : ''}`);
  if (d.before262) { const b = d.before262.engines.google; items.push(`before the fix262 deploy today (counted on the edge address): Googlebot ${b.requests} requests, ${b.verified} verified, ${b.refused} refused; from Google's ranges ${d.before262.googleRanges.requests}`); }
  if (d.sample) items.push(`DNS sample ${d.sample.at.slice(11, 16)} ${d.sample.ip}: system ${d.sample.system} · public ${d.sample.publicDns} · forward ${d.sample.forward}`);
  return [{
    id: 'crawlers-verified', label: 'Search engines verified', level,
    detail: `Googlebot ${d.before262 ? `since ${(d.since || '').slice(11, 16)} UTC` : 'today'}: ${g.requests} requests, ${g.verified} verified (${g.byList} by Google's list, ${g.byDns} by DNS), ${g.refused} refused · from Google's ranges: ${gr.refused} got 429 / 503 (${gr.s429} / ${gr.s503}) · Bing ${d.engines.bing.verified}/${d.engines.bing.requests}, Apple ${d.engines.apple.verified}/${d.engines.apple.requests} verified · lists: ${status}`,
    ...(items.length ? { items } : {})
  }];
}

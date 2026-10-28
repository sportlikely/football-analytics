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
import { clientOf } from '../utils/clientIp';
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
export type UaSample = { at: string; path: string; socket: string; xff: string; realIp: string; reqIp: string; client: string; asn: string; inGoogle: boolean; googleHop: string | null };
type Day = { day: string; engines: Record<Engine, EngineDay>; googleRanges: { requests: number; refused: number; s429: number; s503: number }; refusedRecent: string[]; sample: DnsSample | null; uaLog?: UaSample[] };
const today = () => new Date().toISOString().slice(0, 10);
const blank = (): EngineDay => ({ requests: 0, verified: 0, byList: 0, byDns: 0, refused: 0, s429: 0, s503: 0, api: 0 });
const fresh = (): Day => ({ day: today(), engines: { google: blank(), bing: blank(), apple: blank() }, googleRanges: { requests: 0, refused: 0, s429: 0, s503: 0 }, refusedRecent: [], sample: null });

db.exec(`CREATE TABLE IF NOT EXISTS crawler_day (day TEXT PRIMARY KEY, data TEXT NOT NULL)`);
let cur: Day = fresh();
// a restart keeps the day's numbers
try { const r = db.prepare(`SELECT data FROM crawler_day WHERE day = ?`).get(cur.day) as any; if (r?.data) cur = { ...fresh(), ...JSON.parse(r.data) }; } catch { /* none */ }
let dirty = false;
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

/** web: one answered request (`how` = how it was verified, null = not verified) */
export function noteCrawlerResponse(ua: string, ip: string | undefined, how: 'list' | 'dns' | null, status: number, reqPath: string) {
  try {
    const e = engineOfUa(ua), google = inGoogleRanges(ip);
    if (!e && !google) return;
    roll();
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
      realIp: String(req.headers['x-real-ip'] || '').slice(0, 60), reqIp, client: clientOf(socket, xff, asnOf),
      asn: nw ? `AS${nw.asn} ${nw.name}` : 'not a listed network', inGoogle: inGoogleRanges(reqIp),
      googleHop: hops.find(h => inGoogleRanges(h)) || null
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
  const same = l.filter(x => x.reqIp === x.client).length, google = l.filter(x => x.inGoogle).length, anyHop = l.filter(x => x.googleHop).length;
  const xffHops = Math.max(...l.map(x => x.xff ? x.xff.split(',').length : 0));
  return `${l.length} logged: req.ip = rightmost non-proxy hop in ${same}, in Google's list ${google} (any hop ${anyHop}), up to ${xffHops} X-Forwarded-For hop(s)`;
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

/** data health "Search engines verified": fail when any request from Google's own ranges got a 429 or 503 today */
export function crawlerHealth() {
  const d = crawlerDay() || fresh();
  const g = d.engines.google, gr = d.googleRanges;
  const level: 'ok' | 'warn' | 'fail' = gr.refused > 0 ? 'fail' : g.requests >= 20 && g.verified * 2 < g.requests ? 'warn' : 'ok';
  const items = [...d.refusedRecent.slice(-10)];
  items.push(`Googlebot-UA log: ${uaLogSummary(d)}`);
  if (d.sample) items.push(`DNS sample ${d.sample.at.slice(11, 16)} ${d.sample.ip}: system ${d.sample.system} · public ${d.sample.publicDns} · forward ${d.sample.forward}`);
  return [{
    id: 'crawlers-verified', label: 'Search engines verified', level,
    detail: `Googlebot today: ${g.requests} requests, ${g.verified} verified (${g.byList} by Google's list, ${g.byDns} by DNS), ${g.refused} refused · from Google's ranges: ${gr.refused} got 429 / 503 (${gr.s429} / ${gr.s503}) · Bing ${d.engines.bing.verified}/${d.engines.bing.requests}, Apple ${d.engines.apple.verified}/${d.engines.apple.requests} verified · lists: ${status}`,
    ...(items.length ? { items } : {})
  }];
}

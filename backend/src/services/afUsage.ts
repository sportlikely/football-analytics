/**
 * API-Football usage by source (fix140, 16 Oct 2026). The daily quota ran out at ~10:30 UTC on 16 Oct because a bot
 * (ShapBot, ~17 pages a minute on /team + /player) made every team / player page build fresh. Now:
 *  - every API-Football call is counted as scheduler, page (a visitor's request) or admin;
 *  - calls made while answering a visitor's request share a small budget of their own (600 an hour, 8,000 a day by
 *    default; AF_PAGE_PER_HOUR / AF_PAGE_PER_DAY) — over it the page shows what we have stored ("More details soon")
 *    and the schedulers keep the rest of the quota;
 *  - user-agents of page requests are counted per day (top list on the admin overview). No IPs anywhere.
 * The source travels with the request through AsyncLocalStorage (set in index.ts for every /api request).
 *
 * fix166: search-engine crawlers (the ones robots.txt lets in) are marked on the request. Team and player pages never
 * make a provider call for them (stored copy at any age, else built from our database only — `noProviderCalls`), and
 * the admin card splits page calls and requests into visitors / crawlers.
 *
 * fix173: scrapers. One user-agent (a copy of Googlebot-smartphone's device string without the "Googlebot" token) made
 * 17,596 provider calls in a day, 6 requests a minute — under every per-minute limit. Now:
 *  - provider calls are counted per day per visitor: the salted IP hash, a hash of the user-agent, and (paid members)
 *    the account. Over 150 a day for an IP, 600 for a user-agent or 600 for a paid account, every further request of
 *    that visitor runs with no provider call (stored data only) until midnight UTC. Admins are never capped.
 *  - a user-agent that looks like a search-engine crawler (its name or Googlebot's device string) is only trusted after
 *    a reverse-DNS check of the address (and a forward lookup back to it); until then, and when it fails, the request
 *    makes no provider call and counts as a visitor for every limit.
 * Only salted hashes are kept in memory; the address itself is written only to the security log (90 days).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as dns } from 'node:dns';
import { db } from '../db';
import { isWeb } from './role';
import { deferred } from './deferredWrites';
import { every } from './perf';
import { createHash, randomBytes } from 'node:crypto';
import logger from '../utils/logger';
import { crawlerByList, wantsDnsSample, noteDnsSample } from './crawlerIps';
import { plainIp, engineOfUa } from '../utils/crawlerRanges';

/** fix173: keys = the visitor's salted hashes (IP, user-agent) and, for a paid member, the account (provider-cost caps). */
export type VisitorKeys = { ip: string; ua: string; user?: string | null };
export type AfSource = { kind: 'page' | 'admin'; ua: string; crawler?: boolean; offline?: boolean; keys?: VisitorKeys };
export const afSource = new AsyncLocalStorage<AfSource>();

/** Search-engine crawlers we let in (robots.txt: everyone except the blocked bots); the same list for every sport. */
export const CRAWLERS = /Googlebot|GoogleOther|bingbot|Applebot|DuckDuckBot|YandexBot/i;
export const isCrawlerUa = (ua: string | undefined) => CRAWLERS.test(String(ua || ''));

/* ---------- fix173: crawler verification (reverse DNS, then forward DNS back to the same address) ---------- */

/** User-agents that claim to be (or copy the device of) a crawler we can verify by DNS. */
const VERIFIABLE = /Googlebot|GoogleOther|Google-InspectionTool|bingbot|BingPreview|Applebot|YandexBot|Nexus 5X Build\/MMB29P/i;
/** The hosts each crawler's addresses resolve to (published by Google, Microsoft, Apple, Yandex). */
const CRAWLER_HOSTS = /\.(googlebot\.com|google\.com|search\.msn\.com|applebot\.apple\.com|yandex\.(ru|net|com))$/i;
// fix245: + every Google / Bing / Apple crawler or fetcher name in the engines' published lists (utils/crawlerRanges.ts)
export const claimsCrawler = (ua: string | undefined) => VERIFIABLE.test(String(ua || '')) || isCrawlerUa(ua) || !!engineOfUa(ua);
/** key = salted IP hash → verdict (kept 24 h, at most 5,000) */
const verified = new Map<string, { ok: boolean; at: number }>();
const verifying = new Set<string>();
let fakeToday = 0;
const VERIFY_SALT = randomBytes(16).toString('hex');
const ipHashOf = (ip: string) => createHash('sha256').update(VERIFY_SALT + ip).digest('hex').slice(0, 20);
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('dns timeout')), ms).unref())]);
// fix245: when the host's resolver gives no answer (Railway: 0 verified of 369 Googlebot requests on 21 Oct), a public one
const publicDns = new dns.Resolver({ timeout: 3000, tries: 1 });
try { publicDns.setServers((process.env.CRAWLER_DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',')); } catch { /* no network */ }
type Step = { names: string[]; error?: string };
async function ptr(ip: string, viaPublic: boolean): Promise<Step> {
  try { return { names: (await withTimeout(viaPublic ? publicDns.reverse(ip) : dns.reverse(ip), 5000)).map(n => n.replace(/\.$/, '')) }; }
  catch (e: any) { return { names: [], error: String(e?.code || e?.message || e) }; }
}
async function forwardHas(name: string, ip: string, viaPublic: boolean): Promise<boolean> {
  try {
    if (!viaPublic) return (await withTimeout(dns.lookup(name, { all: true }), 5000)).some(a => plainIp(a.address) === ip);
    const addrs = await withTimeout(ip.includes(':') ? publicDns.resolve6(name) : publicDns.resolve4(name), 5000);
    return addrs.some(a => plainIp(a) === ip);
  } catch { return false; }
}
/** fix173 + fix245: reverse DNS to a crawler host, forward back to the address (system resolver, then a public one) */
async function verifyByDns(ip: string): Promise<boolean> {
  const sample = wantsDnsSample(ip);
  const sys = await ptr(ip, false);
  // the public resolver when the host's gave no crawler name, and always for the day's sample
  const pub = sample || !sys.names.some(n => CRAWLER_HOSTS.test(n)) ? await ptr(ip, true) : null;
  let ok = false, fwd = 'no crawler host name';
  for (const [step, viaPublic] of [[sys, false], [pub, true]] as const) {
    if (ok || !step) continue;
    for (const name of step.names.filter(n => CRAWLER_HOSTS.test(n))) {
      if (await forwardHas(name, ip, viaPublic)) { ok = true; fwd = `${name} points back (${viaPublic ? 'public' : 'system'} resolver)`; break; }
      fwd = `${name} does not point back`;
    }
  }
  if (sample) {
    const fmt = (s: Step | null) => (!s ? 'not asked' : s.names.length ? s.names.join(', ') : `error ${s.error || 'no names'}`);
    noteDnsSample({ at: new Date().toISOString(), ip, system: fmt(sys), publicDns: fmt(pub), forward: fwd, ok });
    logger.info(`crawler DNS sample ${ip}: system ${fmt(sys)} · public ${fmt(pub)} · ${fwd} → ${ok ? 'verified' : 'not verified'}`);
  }
  return ok;
}
/**
 * fix173: is this crawler-looking request really the search engine? true / false once checked (24 h), null while the
 * check runs (it is started here; the caller treats null like false: no provider call, visitor limits).
 * fix245: an address in the engine's published list (services/crawlerIps.ts) is verified at once, even when DNS fails
 * (how = 'list'); else the DNS check above (how = 'dns').
 */
export function crawlerCheck(ipIn: string | undefined, ua: string | undefined): { ok: boolean | null; how: 'list' | 'dns' | null } {
  const ip = plainIp(ipIn);
  if (!ip) return { ok: false, how: null };
  if (crawlerByList(ua, ip)) return { ok: true, how: 'list' };
  const key = ipHashOf(ip);
  const v = verified.get(key);
  if (v && Date.now() - v.at < 86400000) return { ok: v.ok, how: v.ok ? 'dns' : null };
  if (!verifying.has(key)) {
    verifying.add(key);
    void verifyByDns(ip).catch(() => false).then(ok => {
      if (verified.size >= 5000) verified.delete(verified.keys().next().value as string);
      verified.set(key, { ok, at: Date.now() });
      if (!ok) fakeToday++;
    }).finally(() => verifying.delete(key));
  }
  return { ok: null, how: null };
}
export const crawlerVerdict = (ip: string | undefined, ua: string | undefined): boolean | null => crawlerCheck(ip, ua).ok;
/** This request comes from a search-engine crawler. */
export const isCrawlerRequest = () => !!afSource.getStore()?.crawler;

/** Thrown by the provider clients inside `noProviderCalls` (the caller falls back to what is stored). */
export class NoProviderCallError extends Error {
  code = 'NO_PROVIDER_CALL';
  constructor() { super('No provider call for this request (crawler: stored data only)'); }
}
/** Provider clients (API-Football, API-Basketball, balldontlie) call this first: refused inside `noProviderCalls`. */
export function assertProviderCallAllowed() {
  if (afSource.getStore()?.offline) throw new NoProviderCallError();
}
/** Run fn with every provider call refused: our database only. */
export function noProviderCalls<T>(fn: () => T): T {
  const s = afSource.getStore();
  return afSource.run({ kind: s?.kind || 'page', ua: s?.ua || '(none)', crawler: s?.crawler, offline: true, keys: s?.keys }, fn);
}
/** Run fn outside any request (background work a request starts is not that request's page call). */
export const outsideRequest = <T>(fn: () => T): T => afSource.exit(fn);

const PER_HOUR = parseInt(process.env.AF_PAGE_PER_HOUR || '600', 10);
const PER_DAY = parseInt(process.env.AF_PAGE_PER_DAY || '8000', 10);

db.exec(`CREATE TABLE IF NOT EXISTS af_usage (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind))`);
db.exec(`CREATE TABLE IF NOT EXISTS af_usage_ua (day TEXT NOT NULL, ua TEXT NOT NULL, requests INTEGER NOT NULL, af_calls INTEGER NOT NULL, blocked INTEGER NOT NULL, PRIMARY KEY (day, ua))`);

const today = () => new Date().toISOString().slice(0, 10);
const hourNow = () => Math.floor(Date.now() / 3600000);

type UaRow = { requests: number; afCalls: number; blocked: number };
let day = today();
let counts: Record<string, number> = {};
let agents = new Map<string, UaRow>();
let pageHour = { h: hourNow(), n: 0 };
let refusedToday = 0;
let dirty = false;

/* ---------- fix173: provider-cost caps per visitor and day ---------- */
const CAP = {
  ip: parseInt(process.env.AF_CAP_IP || '150', 10),
  ua: parseInt(process.env.AF_CAP_UA || '600', 10),
  user: parseInt(process.env.AF_CAP_USER || '600', 10)
};
/** 'ip:<hash>' / 'ua:<hash>' / 'user:<id>' → provider calls today (memory only; a restart starts again at 0) */
let visitorCalls = new Map<string, number>();
/** keys that went over their cap today, and whether that was logged yet */
let capped = new Map<string, boolean>();
const capKeys = (k: VisitorKeys) => (k.user ? [`user:${k.user}`] : [`ip:${k.ip}`, `ua:${k.ua}`]);
const capOf = (key: string) => (key.startsWith('ip:') ? CAP.ip : key.startsWith('ua:') ? CAP.ua : CAP.user);
/**
 * The visitor's key that is over its daily provider-call cap (the request then runs with no provider call), or null.
 * `firstTime` is true once per key and day (log it then).
 */
export function costCapped(k: VisitorKeys): { key: string; calls: number; cap: number; firstTime: boolean } | null {
  roll();
  for (const key of capKeys(k)) {
    if (!capped.has(key)) continue;
    const firstTime = capped.get(key) === false;
    if (firstTime) capped.set(key, true);
    return { key: key.split(':')[0], calls: visitorCalls.get(key) || 0, cap: capOf(key), firstTime };
  }
  return null;
}
function countVisitorCall(k: VisitorKeys) {
  for (const key of capKeys(k)) {
    const n = (visitorCalls.get(key) || 0) + 1;
    visitorCalls.set(key, n);
    if (n >= capOf(key) && !capped.has(key)) capped.set(key, false);
  }
  if (visitorCalls.size > 50000) { // a flood of one-off visitors: keep the ones near a cap
    for (const [key, n] of visitorCalls) if (n < 20 && !capped.has(key)) visitorCalls.delete(key);
  }
}

// a restart keeps the day's numbers
for (const r of db.prepare(`SELECT kind, n FROM af_usage WHERE day = ?`).all(day) as any[]) counts[r.kind] = r.n;
for (const r of db.prepare(`SELECT ua, requests, af_calls, blocked FROM af_usage_ua WHERE day = ?`).all(day) as any[])
  agents.set(r.ua, { requests: r.requests, afCalls: r.af_calls, blocked: r.blocked });
// fix202: the web process and the worker both count: each adds what it counted since its last write (never overwrites)
let flushedCounts: Record<string, number> = { ...counts };
let flushedAgents = new Map<string, UaRow>([...agents].map(([ua, a]) => [ua, { ...a }]));

function roll() {
  const d = today();
  if (d !== day) { flush(); day = d; counts = {}; agents = new Map(); flushedCounts = {}; flushedAgents = new Map(); refusedToday = 0; visitorCalls = new Map(); capped = new Map(); fakeToday = 0; }
  const h = hourNow();
  if (pageHour.h !== h) pageHour = { h, n: 0 };
}

/** A user-agent as we keep it: trimmed, at most 160 characters (no IPs, no cookies). */
export const uaKey = (ua: string | undefined) => (String(ua || '').trim() || '(none)').slice(0, 160);

function agent(ua: string): UaRow {
  let a = agents.get(ua);
  if (!a) {
    if (agents.size >= 500) { // keep the busiest only
      const min = [...agents.entries()].sort((x, y) => x[1].requests + x[1].blocked - (y[1].requests + y[1].blocked))[0];
      if (min) agents.delete(min[0]);
    }
    a = { requests: 0, afCalls: 0, blocked: 0 };
    agents.set(ua, a);
  }
  return a;
}

/** A visitor's /api request (counted per user-agent, and as visitor / crawler). */
export function notePageRequest(ua: string, crawler = false) {
  roll();
  agent(ua).requests++;
  const k = crawler ? 'req_crawler' : 'req_visitor';
  counts[k] = (counts[k] || 0) + 1;
  dirty = true;
}
/** A request refused because the user-agent is a blocked bot. */
export function noteBlocked(ua: string) { roll(); agent(ua).blocked++; dirty = true; }

/** Page budget error: the page should show what is stored instead ("More details soon"). */
export class PageBudgetError extends Error {
  code = 'PAGE_BUDGET';
  constructor() { super('More details soon (page data budget reached)'); }
}

/**
 * Called by the API-Football client before a call; counts it. Throws PageBudgetError when a visitor's request would go over the
 * page budget; schedulers and admins are never stopped here (the daily quota check stays in the client).
 */
export function beforeAfCall() {
  roll();
  assertProviderCallAllowed();
  const s = afSource.getStore();
  const kind = s?.kind || 'scheduler';
  if (kind === 'page' && (pageHour.n >= PER_HOUR || (counts.page || 0) >= PER_DAY)) { refusedToday++; throw new PageBudgetError(); }
  // counted when allowed (not when answered), so calls started together can't all slip under the budget
  counts[kind] = (counts[kind] || 0) + 1;
  if (kind === 'page') {
    pageHour.n++;
    agent(s!.ua).afCalls++;
    if (s!.keys) countVisitorCall(s!.keys); // fix173
    const k = s!.crawler ? 'page_crawler' : 'page_visitor';
    counts[k] = (counts[k] || 0) + 1;
  }
  dirty = true;
}
/** Page calls still allowed this hour (for background warm-ups that should give way first). */
export const pageBudgetLeft = () => { roll(); return Math.max(0, Math.min(PER_HOUR - pageHour.n, PER_DAY - (counts.page || 0))); };

// fix210b: the web process's counts go to the worker, which writes them (services/deferredWrites.ts): a web write
// waited for the worker's lock ("AF usage flush" 880 ms → a 1.7 s stall on 24 Oct)
const up = deferred(`INSERT INTO af_usage (day, kind, n) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + excluded.n`);
const upUa = deferred(`INSERT INTO af_usage_ua (day, ua, requests, af_calls, blocked) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(day, ua) DO UPDATE SET requests = requests + excluded.requests, af_calls = af_calls + excluded.af_calls, blocked = blocked + excluded.blocked`);
function flush() {
  if (!dirty) return;
  dirty = false;
  const tx = !isWeb;
  if (tx) db.exec('BEGIN');
  try {
    for (const [k, n] of Object.entries(counts)) { const dn = n - (flushedCounts[k] || 0); if (dn) up.run(day, k, dn); flushedCounts[k] = n; }
    for (const [ua, a] of agents) {
      const f = flushedAgents.get(ua) || { requests: 0, afCalls: 0, blocked: 0 };
      if (a.requests !== f.requests || a.afCalls !== f.afCalls || a.blocked !== f.blocked) upUa.run(day, ua, a.requests - f.requests, a.afCalls - f.afCalls, a.blocked - f.blocked);
      flushedAgents.set(ua, { ...a });
    }
    if (tx) db.prepare(`DELETE FROM af_usage_ua WHERE day < ?`).run(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
    if (tx) db.exec('COMMIT');
  } catch { if (tx) db.exec('ROLLBACK'); }
}
every('AF usage flush', flush, 60 * 1000).unref();

/** Admin overview card "API-Football today". */
export function afUsageToday() {
  roll();
  // fix202: both processes' numbers (this one's written first)
  dirty = true;
  flush();
  const counts: Record<string, number> = {};
  for (const r of db.prepare(`SELECT kind, n FROM af_usage WHERE day = ?`).all(day) as any[]) counts[r.kind] = r.n;
  const top = (db.prepare(`SELECT ua, requests, af_calls AS afCalls, blocked FROM af_usage_ua WHERE day = ? ORDER BY af_calls DESC, requests + blocked DESC LIMIT 12`).all(day) as any[])
    .map(r => ({ ua: r.ua, requests: r.requests, afCalls: r.afCalls, blocked: r.blocked }));
  return {
    day,
    calls: { scheduler: counts.scheduler || 0, pages: counts.page || 0, admin: counts.admin || 0 },
    // fix166: page calls and requests split into visitors / crawlers (split counted from fix166 on)
    pages: {
      visitors: { calls: (counts.page || 0) - (counts.page_crawler || 0), requests: counts.req_visitor || 0 },
      crawlers: { calls: counts.page_crawler || 0, requests: counts.req_crawler || 0 }
    },
    pageBudget: { perHour: PER_HOUR, perDay: PER_DAY, thisHour: pageHour.n, refused: refusedToday },
    // fix173: visitors over their daily provider-call cap (by kind of key) and crawler-looking visitors that failed the DNS check
    caps: { ...CAP, capped: { ip: [...capped.keys()].filter(k => k.startsWith('ip:')).length, ua: [...capped.keys()].filter(k => k.startsWith('ua:')).length, user: [...capped.keys()].filter(k => k.startsWith('user:')).length } },
    fakeCrawlers: fakeToday,
    topAgents: top
  };
}

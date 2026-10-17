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
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db';
import { every } from './perf';

export type AfSource = { kind: 'page' | 'admin'; ua: string; crawler?: boolean; offline?: boolean };
export const afSource = new AsyncLocalStorage<AfSource>();

/** Search-engine crawlers we let in (robots.txt: everyone except the blocked bots); the same list for every sport. */
export const CRAWLERS = /Googlebot|GoogleOther|bingbot|Applebot|DuckDuckBot|YandexBot/i;
export const isCrawlerUa = (ua: string | undefined) => CRAWLERS.test(String(ua || ''));
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
  return afSource.run({ kind: s?.kind || 'page', ua: s?.ua || '(none)', crawler: s?.crawler, offline: true }, fn);
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

// a restart keeps the day's numbers
for (const r of db.prepare(`SELECT kind, n FROM af_usage WHERE day = ?`).all(day) as any[]) counts[r.kind] = r.n;
for (const r of db.prepare(`SELECT ua, requests, af_calls, blocked FROM af_usage_ua WHERE day = ?`).all(day) as any[])
  agents.set(r.ua, { requests: r.requests, afCalls: r.af_calls, blocked: r.blocked });

function roll() {
  const d = today();
  if (d !== day) { flush(); day = d; counts = {}; agents = new Map(); refusedToday = 0; }
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
    const k = s!.crawler ? 'page_crawler' : 'page_visitor';
    counts[k] = (counts[k] || 0) + 1;
  }
  dirty = true;
}
/** Page calls still allowed this hour (for background warm-ups that should give way first). */
export const pageBudgetLeft = () => { roll(); return Math.max(0, Math.min(PER_HOUR - pageHour.n, PER_DAY - (counts.page || 0))); };

function flush() {
  if (!dirty) return;
  dirty = false;
  const up = db.prepare(`INSERT OR REPLACE INTO af_usage (day, kind, n) VALUES (?, ?, ?)`);
  const upUa = db.prepare(`INSERT OR REPLACE INTO af_usage_ua (day, ua, requests, af_calls, blocked) VALUES (?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const [k, n] of Object.entries(counts)) up.run(day, k, n);
    for (const [ua, a] of agents) upUa.run(day, ua, a.requests, a.afCalls, a.blocked);
    db.prepare(`DELETE FROM af_usage_ua WHERE day < ?`).run(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
    db.exec('COMMIT');
  } catch { db.exec('ROLLBACK'); }
}
every('AF usage flush', flush, 60 * 1000).unref();

/** Admin overview card "API-Football today". */
export function afUsageToday() {
  roll();
  const top = [...agents.entries()]
    .map(([ua, a]) => ({ ua, ...a }))
    .sort((x, y) => y.afCalls - x.afCalls || y.requests + y.blocked - (x.requests + x.blocked))
    .slice(0, 12);
  return {
    day,
    calls: { scheduler: counts.scheduler || 0, pages: counts.page || 0, admin: counts.admin || 0 },
    // fix166: page calls and requests split into visitors / crawlers (split counted from fix166 on)
    pages: {
      visitors: { calls: (counts.page || 0) - (counts.page_crawler || 0), requests: counts.req_visitor || 0 },
      crawlers: { calls: counts.page_crawler || 0, requests: counts.req_crawler || 0 }
    },
    pageBudget: { perHour: PER_HOUR, perDay: PER_DAY, thisHour: pageHour.n, refused: refusedToday },
    topAgents: top
  };
}

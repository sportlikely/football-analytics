/**
 * fix199: proxy / data-centre scrapers — the server side of proxyGuard.ts (the rules live there).
 *  - every request from a data-centre / proxy network (asn.ts) is counted per network and day; the network gets ONE
 *    Security-log line once it looks like a scraper (an address refused by a limit, at the provider-cost cap, a fake
 *    crawler, or 300+ requests in the day), updated in place every minute with the counts; its addresses (IP, requests,
 *    refused) go to security_log_ips (90 days, the security log's own rule);
 *  - logger.warn('scraper: …') once per network and day;
 *  - who is calling today (admin Visitors → "Who"): the top user-agents and networks with request counts and a mark.
 * Memory holds salted address hashes only; the IP is written straight from the request to the security log.
 */
import { db } from '../db';
import { isWeb } from './role';
import { deferred } from './deferredWrites';
import logger from '../utils/logger';
import { every } from './perf';
import { countryOf } from './geo';
import { securityLogGroup, securityLogIp } from './securityLog';
import { networkLine, whoMark, browserUa, PROXY_LIMITS, WhoMark } from './proxyGuard';

type Net = {
  asn: number; name: string; cc: string | null; addrs: Set<string>; addrBase: number;
  requests: number; refused: number; capped: Set<string>; capBase: number; fakeCrawler: number; browser: number; verified: number; exempt: number;
  uas: Map<string, number>; logged: boolean; dirty: boolean;
};
type Addr = { pendingReq: number; pendingRefused: number; lastWrite: number };
type Ua = { requests: number; verified: number; dc: number };

const LOG_AT = PROXY_LIMITS.addressDay; // requests in a day that make a network's line on their own
const today = () => new Date().toISOString().slice(0, 10);
let day = today();
let nets = new Map<number, Net>();
let addrs = new Map<string, Addr>(); // `${asn}|${address hash}` → what is not in security_log_ips yet
let uas = new Map<string, Ua>();
let otherRequests = 0; // requests from every other network (homes, mobiles)

db.exec(`CREATE TABLE IF NOT EXISTS scraper_networks (
  grp TEXT PRIMARY KEY, day TEXT NOT NULL, asn INTEGER NOT NULL, name TEXT, cc TEXT, addresses INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, capped INTEGER NOT NULL DEFAULT 0,
  fake_crawler INTEGER NOT NULL DEFAULT 0, browser INTEGER NOT NULL DEFAULT 0
)`);
db.exec(`CREATE TABLE IF NOT EXISTS who_day (day TEXT PRIMARY KEY, data TEXT NOT NULL)`);

const grpOf = (asn: number, d = day) => `AS${asn}:${d}`;

function roll() {
  const d = today();
  if (d === day) return;
  flush();
  day = d; nets = new Map(); addrs = new Map(); uas = new Map(); otherRequests = 0;
}

function net(asn: number, name: string, ip: string): Net {
  let n = nets.get(asn);
  if (!n) {
    // a restart keeps the day's line (its numbers go on from what was written)
    const r = db.prepare(`SELECT * FROM scraper_networks WHERE grp = ?`).get(grpOf(asn)) as any;
    n = {
      asn, name: r?.name || name, cc: r?.cc || countryOf(ip), addrs: new Set(), addrBase: r?.addresses || 0,
      requests: r?.requests || 0, refused: r?.refused || 0, capped: new Set(), capBase: r?.capped || 0, fakeCrawler: r?.fake_crawler || 0,
      browser: r?.browser || 0, verified: 0, exempt: 0, uas: new Map(), logged: !!r, dirty: false
    };
    nets.set(asn, n);
  }
  return n;
}
const topUa = (n: Net) => [...n.uas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
const lineOf = (n: Net) => networkLine({ name: n.name, asn: n.asn, cc: n.cc, addresses: n.addrBase + n.addrs.size, requests: n.requests, refused: n.refused, capped: n.capBase + n.capped.size, fakeCrawler: n.fakeCrawler, browser: n.browser });

function startLine(n: Net, why: string) {
  if (n.logged) return;
  n.logged = true; n.dirty = true;
  securityLogGroup(grpOf(n.asn), 'scraper', lineOf(n), topUa(n));
  logger.warn(`scraper: ${lineOf(n)} — ${why}`);
}

/** verified = a search engine that passed the DNS check; exempt = a signed-in, email-verified account (not counted as a scraper) */
export type ProxyEvent = { refused?: string | null; capped?: boolean; fakeCrawler?: boolean; verified?: boolean; exempt?: boolean };

/**
 * One request from a data-centre / proxy network. `addrKey` = the salted address hash; `ip` is only passed on to the
 * security log once the network has a line.
 */
export function noteNetworkRequest(nw: { asn: number; name: string }, addrKey: string, ip: string, ua: string, ev: ProxyEvent = {}) {
  try {
    roll();
    const n = net(nw.asn, nw.name, ip);
    n.addrs.add(addrKey);
    n.requests++; n.dirty = true;
    if (browserUa(ua)) n.browser++;
    if (ev.verified) n.verified++;
    if (ev.exempt) n.exempt++;
    if (ev.refused) n.refused++;
    if (ev.capped) n.capped.add(addrKey);
    if (ev.fakeCrawler) n.fakeCrawler++;
    if (n.uas.size < 50 || n.uas.has(ua)) n.uas.set(ua, (n.uas.get(ua) || 0) + 1);
    if (!ev.verified && !ev.exempt) {
      if (ev.refused) startLine(n, `address refused (${ev.refused})`);
      else if (ev.capped) startLine(n, 'an address reached the provider-cost cap');
      else if (ev.fakeCrawler) startLine(n, 'crawler user-agent that failed the DNS check');
      else if (n.requests - n.verified - n.exempt >= LOG_AT) startLine(n, `${LOG_AT}+ requests today`);
    }
    if (!n.logged || ev.verified || ev.exempt) return; // search engines and accounts are not in the scraper line's addresses
    const k = `${nw.asn}|${addrKey}`;
    let a = addrs.get(k);
    if (!a) { a = { pendingReq: 0, pendingRefused: 0, lastWrite: 0 }; addrs.set(k, a); }
    a.pendingReq++; if (ev.refused) a.pendingRefused++;
    const now = Date.now();
    if (a.lastWrite < now - 30000) {
      securityLogIp(grpOf(nw.asn), ip, ua, a.pendingReq, a.pendingRefused);
      a.pendingReq = 0; a.pendingRefused = 0; a.lastWrite = now;
    }
  } catch { /* counting never breaks a request */ }
}

/** Every non-admin /api request, for the "Who" card. */
export function noteWho(ua: string, dc: boolean, verified: boolean) {
  roll();
  let u = uas.get(ua);
  if (!u) {
    if (uas.size >= 1000) { // keep the busiest
      const min = [...uas.entries()].sort((x, y) => x[1].requests - y[1].requests)[0];
      if (min) uas.delete(min[0]);
    }
    u = { requests: 0, verified: 0, dc: 0 };
    uas.set(ua, u);
  }
  u.requests++; if (verified) u.verified++; if (dc) u.dc++;
  if (!dc) otherRequests++;
}

// fix210b: from the web process these go to the worker (services/deferredWrites.ts)
const upNet = deferred(`INSERT OR REPLACE INTO scraper_networks (grp, day, asn, name, cc, addresses, requests, refused, capped, fake_crawler, browser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const upWho = deferred(`INSERT OR REPLACE INTO who_day (day, data) VALUES (?, ?)`);
function flush() {
  const up = upNet;
  try {
    for (const n of nets.values()) {
      if (!n.logged || !n.dirty) continue;
      n.dirty = false;
      up.run(grpOf(n.asn), day, n.asn, n.name, n.cc, n.addrBase + n.addrs.size, n.requests, n.refused, n.capBase + n.capped.size, n.fakeCrawler, n.browser);
      securityLogGroup(grpOf(n.asn), 'scraper', lineOf(n), topUa(n));
    }
    upWho.run(day, JSON.stringify(whoToday()));
    if (!isWeb) {
      db.prepare(`DELETE FROM who_day WHERE day < ?`).run(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10));
      db.prepare(`DELETE FROM scraper_networks WHERE day < ?`).run(new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10));
    }
  } catch (e: any) { logger.warn(`proxy scrapers flush: ${e.message}`); }
}
every('proxy scrapers flush', flush, 60 * 1000).unref();

// a restart keeps the day's "Who" numbers
try {
  const r = db.prepare(`SELECT data FROM who_day WHERE day = ?`).get(day) as any;
  if (r?.data) {
    const d = JSON.parse(r.data);
    for (const x of d.agents || []) uas.set(x.ua, { requests: x.requests, verified: x.verified || 0, dc: x.dc || 0 });
    otherRequests = d.otherRequests || 0;
  }
} catch { /* none */ }

export type WhoRow = { name: string; requests: number; mark: WhoMark; addresses?: number; refused?: number; verified?: number; dc?: number; ua?: string };

/** Admin Visitors → "Who": the top 20 user-agents and networks today (requests, mark). */
export function whoToday() {
  roll();
  const agents = [...uas.entries()]
    .sort((a, b) => b[1].requests - a[1].requests).slice(0, 20)
    .map(([ua, s]) => ({ ua, requests: s.requests, verified: s.verified, dc: s.dc, mark: whoMark(ua, s) }));
  const networks = [...nets.values()]
    .sort((a, b) => b.requests - a.requests).slice(0, 20)
    .map(n => {
      // a network on the data-centre list: search engine (verified by DNS), SEO tool, or data-centre
      const mark = whoMark(topUa(n) || '', { requests: n.requests, verified: n.verified, dc: n.requests });
      return { name: n.name, asn: n.asn, cc: n.cc, requests: n.requests, addresses: n.addrBase + n.addrs.size, refused: n.refused, logged: n.logged, mark };
    });
  return { day, agents, networks, otherRequests, limits: PROXY_LIMITS };
}

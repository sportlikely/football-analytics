/**
 * fix199: proxy / data-centre scrapers — the rules, no imports but node:crypto (unit-tested by scripts/proxy-guard.test.ts).
 * On 20–21 Oct one script pulled thousands of pages through ~25 addresses of Datacamp Ltd (AS60068, resold to VPN /
 * proxy services), each with a fake browser user-agent. For an address in a data-centre / proxy network (asn.ts), when
 * the caller is not an admin, not a search engine verified by DNS (fix173) and not a signed-in, email-verified account:
 *  - stored data only from the first request (no provider call);
 *  - 60 page / API reads an hour and 300 a day per address, 600 an hour per network (all its addresses); over it 429;
 *  - signed out: no prediction at all (every prediction is { model, locked }, finished games too), so the game pages
 *    show the "Create a free account" prompt (UnlockPrompt) for every game.
 * Sign-in, sign-up and the rest of the account routes are never counted: people on a VPN can always get in.
 * fix244 (26 Oct: a scraper on Datacamp used up the network cap, every person on that VPN was refused on the first page):
 *  - the address limits count page views, not API calls: the app sends one view id per page (X-SL-View) and a view's
 *    first `viewCalls` calls count once; the HTML of a page load counts once and the app's first view after it is free
 *    (a page load and its API calls = 1). Calls without a view id count one each (scripts gain nothing);
 *  - a browser that passed the Quick check (Cloudflare Turnstile) carries a signed pass (cookie, 24 h, tied to its
 *    user-agent): no address or network limit, only `passHour` views an hour per pass (a person never gets there).
 *    Stored data only and locked predictions when signed out stay as they are.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const PROXY_LIMITS = { addressHour: 60, addressDay: 300, networkHour: 600, viewCalls: 15, passHour: 300 };
export type ProxyLimits = typeof PROXY_LIMITS;

/** Do the proxy rules apply to this request? (`network` = the address is in a data-centre / proxy network) */
export function proxyApplies(r: { network: boolean; admin: boolean; verifiedCrawler: boolean; verifiedAccount: boolean }): boolean {
  return r.network && !r.admin && !r.verifiedCrawler && !r.verifiedAccount;
}

/** Requests that count as page / API reads (account, sign-in, beacons and billing never do). */
const NOT_COUNTED = /^\/api\/(health$|visit\/seen$|client-error$|auth\/|billing\/|unlocks(\/|$)|feedback$|contact$|waitlist$|unsubscribe$|testers\/)/;
export const countedRead = (method: string, path: string) => method === 'GET' && path.startsWith('/api/') && !NOT_COUNTED.test(path);

export type ProxyRefusal = { scope: 'address-hour' | 'address-day' | 'network-hour' | 'pass-hour'; retryAfter: number };
/** view = the app's page-view id (X-SL-View); page = the HTML of a page load; pass = a valid Quick-check pass id */
export type HitOpts = { view?: string | null; page?: boolean; pass?: string | null };

/** The X-SL-View header as a view id (letters, digits, dashes; at most 40), else null. */
export const viewIdOf = (h: unknown) => (typeof h === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(h) ? h : null);

/** Fixed windows (clock hour, UTC day), in memory. Keys: the salted address hash and the AS number. */
export class ProxyLimiter {
  private addr = new Map<string, { h: number; hn: number; d: number; dn: number; pageAt: number }>();
  private net = new Map<number, { h: number; n: number }>();
  private views = new Map<string, { h: number; n: number }>(); // `${address or pass}|${view id}` → its calls this hour
  private passes = new Map<string, { h: number; n: number }>();
  private lim: ProxyLimits;
  private now: () => number;
  constructor(lim: ProxyLimits = PROXY_LIMITS, now: () => number = () => Date.now()) { this.lim = lim; this.now = now; }

  /** Count one read; null = allowed, else the refusal (the read is then not counted for the network). */
  hit(addrKey: string, asn: number, o: HitOpts = {}): ProxyRefusal | null {
    const t = this.now(), h = Math.floor(t / 3600000), d = Math.floor(t / 86400000);
    const toHour = Math.max(1, Math.ceil(((h + 1) * 3600000 - t) / 1000)), toDay = Math.max(1, Math.ceil(((d + 1) * 86400000 - t) / 1000));
    // a call of a view already counted (its first `viewCalls` calls) is not a new page view
    const vk = o.view ? `${o.pass ? `p:${o.pass}` : addrKey}|${o.view}` : null;
    const v = vk ? this.views.get(vk) : undefined;
    const sameView = !!v && v.h === h && v.n < this.lim.viewCalls;
    const markView = () => { if (!vk) return; if (sameView) v!.n++; else this.views.set(vk, { h, n: 1 }); };
    // a passed browser: its own hourly views only, no address or network limit
    if (o.pass) {
      if (sameView) { markView(); return null; }
      let p = this.passes.get(o.pass);
      if (!p || p.h !== h) { p = { h, n: 0 }; this.passes.set(o.pass, p); }
      if (p.n >= this.lim.passHour) return { scope: 'pass-hour', retryAfter: toHour };
      p.n++; markView();
      return null;
    }
    let a = this.addr.get(addrKey);
    if (!a) { a = { h, hn: 0, d, dn: 0, pageAt: 0 }; this.addr.set(addrKey, a); }
    if (a.h !== h) { a.h = h; a.hn = 0; }
    if (a.d !== d) { a.d = d; a.dn = 0; }
    // the app's first view after the page's HTML (counted there) is the same page load
    const loadView = !sameView && !!o.view && o.view.startsWith('L') && a.pageAt > t - 60000;
    const counts = !sameView && !loadView;
    if (counts && a.dn >= this.lim.addressDay) return { scope: 'address-day', retryAfter: toDay };
    if (counts && a.hn >= this.lim.addressHour) return { scope: 'address-hour', retryAfter: toHour };
    let n = this.net.get(asn);
    if (!n || n.h !== h) { n = { h, n: 0 }; this.net.set(asn, n); }
    if (n.n >= this.lim.networkHour) return { scope: 'network-hour', retryAfter: toHour };
    n.n++;
    if (counts) { a.hn++; a.dn++; }
    if (loadView) a.pageAt = 0;
    if (o.page) a.pageAt = t;
    markView();
    return null;
  }

  /** Drop windows that ended (called every few minutes). */
  prune() {
    const t = this.now(), h = Math.floor(t / 3600000), d = Math.floor(t / 86400000);
    for (const [k, a] of this.addr) if (a.d !== d) this.addr.delete(k); else if (a.h !== h) a.hn = 0;
    for (const [k, n] of this.net) if (n.h !== h) this.net.delete(k);
    for (const [k, v] of this.views) if (v.h !== h) this.views.delete(k);
    for (const [k, p] of this.passes) if (p.h !== h) this.passes.delete(k);
  }
}

/* ---------- fix244: the Quick-check pass (cookie sl_pass) ---------- */

export const PASS_COOKIE = 'sl_pass';
export const PASS_MS = 24 * 3600000;
const uaTag = (ua: string) => createHash('sha256').update(`ua|${ua}`).digest('base64url').slice(0, 16);
const passSig = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('base64url').slice(0, 32);

/** A signed pass for this browser: `v1.<expiry>.<id>.<user-agent tag>.<sig>`. */
export function makePass(key: Buffer, ua: string, now: number, id: string): string {
  const body = `v1.${(now + PASS_MS).toString(36)}.${id}.${uaTag(ua)}`;
  return `${body}.${passSig(key, body)}`;
}
/**
 * The pass in a cookie: null = none or not ours (forged); { id, ok } = ours, ok = not expired and sent by the same
 * user-agent (a cookie copied to another user-agent is not ok: the normal limits apply).
 */
export function readPass(key: Buffer, token: unknown, ua: string, now: number): { id: string; ok: boolean } | null {
  const m = /^v1\.([0-9a-z]{1,12})\.([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const body = `v1.${m[1]}.${m[2]}.${m[3]}`;
  if (!timingSafeEqual(Buffer.from(m[4]), Buffer.from(passSig(key, body)))) return null;
  return { id: m[2], ok: parseInt(m[1], 36) > now && m[3] === uaTag(ua) };
}

/** Every prediction in a payload locked ({ model, locked }), finished games included (signed-out proxy callers). */
export function lockAllPredictions(value: any, depth = 0): any {
  if (depth > 10 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => lockAllPredictions(v, depth + 1));
  if (value instanceof Date) return value;
  const lock = (p: any) => (p && typeof p === 'object' ? { model: p.model, locked: true } : p);
  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'prediction') out[k] = lock(v);
    else if (k === 'predictions' && Array.isArray(v)) out[k] = v.map(lock);
    else out[k] = lockAllPredictions(v, depth + 1);
  }
  return out;
}

/* ---------- who is calling (admin Visitors → "Who" card) ---------- */

export type WhoMark = 'search-engine' | 'seo-tool' | 'data-centre' | 'script' | 'browser';
const SEO_TOOLS = /AhrefsBot|SemrushBot|MJ12bot|DotBot|BLEXBot|DataForSeoBot|serpstatbot|Screaming Frog|Sitebulb|SEOkicks|SeznamBot|rogerbot|Barkrowler|PetalBot|Bytespider|Amazonbot|GPTBot|ClaudeBot|CCBot|ImagesiftBot|Applebot-Extended/i;
const SCRIPT = /bot|crawl|spider|slurp|python|curl|wget|axios|node-fetch|go-http|java\/|okhttp|libwww|httpclient|scrapy|headless|phantom|puppeteer|playwright|^\(none\)$/i;
/** A browser user-agent (what people send, and what the 20–21 Oct script copied). */
export const browserUa = (ua: string) => /^Mozilla\/5\.0 \(/.test(ua) && /(Safari|Chrome|Firefox)\//.test(ua) && !SCRIPT.test(ua) && !SEO_TOOLS.test(ua);
/** What a user-agent (or a network) is, from its requests today. */
export function whoMark(ua: string, s: { requests: number; verified: number; dc: number }): WhoMark {
  if (s.verified * 2 > s.requests) return 'search-engine';
  if (SEO_TOOLS.test(ua)) return 'seo-tool';
  if (s.dc * 2 > s.requests) return 'data-centre';
  if (!browserUa(ua)) return 'script';
  return 'browser';
}

/** The Security log line of a network ("Datacamp Ltd (AS60068, NL) · 25 addresses · 4,100 requests · fake browser UA"). */
export function networkLine(n: { name: string; asn: number; cc: string | null; addresses: number; requests: number; refused: number; capped: number; fakeCrawler: number; browser: number }): string {
  const f = (x: number) => x.toLocaleString('en-US');
  const parts = [`${n.name} (AS${n.asn}${n.cc ? `, ${n.cc}` : ''})`, `${f(n.addresses)} address${n.addresses === 1 ? '' : 'es'}`, `${f(n.requests)} requests`];
  if (n.refused) parts.push(`${f(n.refused)} refused (limits)`);
  if (n.capped) parts.push(`${f(n.capped)} at the cost cap`);
  if (n.fakeCrawler) parts.push(`${f(n.fakeCrawler)} fake crawler`);
  if (n.browser * 2 > n.requests) parts.push('fake browser UA');
  return parts.join(' · ');
}

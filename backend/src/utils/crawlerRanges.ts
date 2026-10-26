/**
 * fix245: search-engine crawlers verified by the engines' own published address lists (pure, no imports but node:net;
 * unit-tested by scripts/fix245.test.ts). 7–21 Oct: Search Console showed 15 % 4XX and 5 % 5XX on 210k Google requests
 * and Admin → Visitors 369 Googlebot requests, verified 0: fix173's DNS check never passed on Railway, so Google (AS15169
 * is on the data-centre list) got the proxy rules — 60 reads an hour, 429, locked predictions. An address in one of
 * these lists is the search engine even when DNS fails:
 *  - Google: googlebot.json, special-crawlers.json, user-triggered-fetchers.json (+ -google.json)
 *  - Bing: bingbot.json · Apple: applebot.json
 * Every file is { prefixes: [{ ipv4Prefix: "66.249.64.0/27" } | { ipv6Prefix: "2001:4860:4801:10::/64" }] }.
 */
import net from 'node:net';

export type Engine = 'google' | 'bing' | 'apple';
export const RANGE_SOURCES: { engine: Engine; name: string; url: string }[] = [
  { engine: 'google', name: 'googlebot', url: 'https://developers.google.com/static/search/apis/ipranges/googlebot.json' },
  { engine: 'google', name: 'special-crawlers', url: 'https://developers.google.com/static/search/apis/ipranges/special-crawlers.json' },
  { engine: 'google', name: 'user-triggered-fetchers', url: 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json' },
  { engine: 'google', name: 'user-triggered-fetchers-google', url: 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json' },
  { engine: 'bing', name: 'bingbot', url: 'https://www.bing.com/toolbox/bingbot.json' },
  { engine: 'apple', name: 'applebot', url: 'https://search.developer.apple.com/applebot.json' }
];
/** Until the first download: the crawl ranges every engine has used for years (Googlebot 66.249.64.0/19, Apple 17/8). */
export const SEED_RANGES: Record<Engine, string[]> = {
  google: ['66.249.64.0/19', '2001:4860:4801::/48'],
  bing: ['157.55.39.0/24', '207.46.13.0/24', '40.77.167.0/24', '13.66.139.0/24', '52.167.144.0/24'],
  apple: ['17.0.0.0/8']
};

/** The prefixes of one published list file (anything else in it is ignored). */
export function parseRangeFile(json: unknown): string[] {
  const out: string[] = [];
  const list = (json as any)?.prefixes;
  if (!Array.isArray(list)) return out;
  for (const p of list) {
    const s = typeof p?.ipv4Prefix === 'string' ? p.ipv4Prefix : typeof p?.ipv6Prefix === 'string' ? p.ipv6Prefix : null;
    if (s && cidrOf(s)) out.push(s);
  }
  return out;
}

/** "::ffff:66.249.66.1" → "66.249.66.1"; trimmed; '' when not an address */
export function plainIp(ip: string | undefined | null): string {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return net.isIP(s) ? s : '';
}

const v4num = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + (parseInt(p, 10) & 255), 0) >>> 0;
function v6num(ip: string): bigint {
  let s = ip;
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  if (s.includes('.')) { const i = s.lastIndexOf(':'); const n = v4num(s.slice(i + 1)); s = `${s.slice(0, i + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [h, t] = s.split('::');
  const head = h ? h.split(':') : [], tail = t !== undefined ? (t ? t.split(':') : []) : [];
  const g = t !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 16n) | BigInt(parseInt(g[i] || '0', 16) & 0xffff);
  return v;
}
type Cidr = { v6: false; start: number; end: number } | { v6: true; start: bigint; end: bigint };
function cidrOf(s: string): Cidr | null {
  const [ip, bitsS] = s.trim().split('/');
  const bits = Number(bitsS);
  if (net.isIPv4(ip) && Number.isInteger(bits) && bits >= 0 && bits <= 32) {
    const size = 2 ** (32 - bits), start = Math.floor(v4num(ip) / size) * size;
    return { v6: false, start, end: start + size - 1 };
  }
  if (net.isIPv6(ip) && Number.isInteger(bits) && bits >= 0 && bits <= 128) {
    const host = (1n << BigInt(128 - bits)) - 1n, start = v6num(ip) & ~host & ((1n << 128n) - 1n);
    return { v6: true, start, end: start | host };
  }
  return null;
}

/** The published ranges of every engine, looked up by address. */
export class CrawlerRanges {
  private v4: { start: number; end: number; engine: Engine }[] = [];
  private v6: { start: bigint; end: bigint; engine: Engine }[] = [];
  constructor(lists: Partial<Record<Engine, string[]>>) {
    for (const [engine, prefixes] of Object.entries(lists) as [Engine, string[]][]) {
      for (const p of prefixes || []) {
        const c = cidrOf(p);
        if (!c) continue;
        if (c.v6) this.v6.push({ start: c.start, end: c.end, engine }); else this.v4.push({ start: c.start, end: c.end, engine });
      }
    }
    this.v4.sort((a, b) => a.start - b.start);
    this.v6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }
  get size() { return this.v4.length + this.v6.length; }
  /** the engine whose published list holds this address, or null */
  engineOf(ipIn: string | undefined | null): Engine | null {
    const ip = plainIp(ipIn);
    if (!ip) return null;
    // ranges may nest (17/8 seed + Apple's own /24s): any range holding the address counts
    if (net.isIPv4(ip)) { const x = v4num(ip); for (const r of this.v4) { if (r.start > x) break; if (x <= r.end) return r.engine; } return null; }
    const x = v6num(ip);
    for (const r of this.v6) { if (r.start > x) break; if (x <= r.end) return r.engine; }
    return null;
  }
}

/** Which engine a crawler user-agent claims to be (null = none we have a list for). */
export function engineOfUa(ua: string | undefined | null): Engine | null {
  const s = String(ua || '');
  if (/Googlebot|GoogleOther|Google-InspectionTool|Google-Extended|Storebot-Google|Google-Site-Verification|AdsBot-Google|Mediapartners-Google|FeedFetcher-Google|Google-Read-Aloud|APIs-Google|Nexus 5X Build\/MMB29P/i.test(s)) return 'google';
  if (/bingbot|BingPreview|msnbot|adidxbot/i.test(s)) return 'bing';
  if (/Applebot/i.test(s)) return 'apple';
  return null;
}

/**
 * Verified by the list: the user-agent claims a crawler and the address is in a published list. An engine's list
 * verifies its own crawler names; Google's lists also hold the user-triggered fetchers (any Google user-agent).
 */
export function listedCrawler(r: CrawlerRanges, ua: string | undefined | null, ip: string | undefined | null): Engine | null {
  const claim = engineOfUa(ua);
  if (!claim) return null;
  const e = r.engineOf(ip);
  return e === claim ? e : null;
}

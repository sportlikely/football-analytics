/**
 * fix254: who is the client behind Railway's edge. Express walks X-Forwarded-For from the right and stops at the first
 * address it does not trust; with `trust proxy = 1` it trusted only the socket, so an extra edge hop (a private / CGNAT
 * address or Railway's own network appended after the client) became req.ip. Trusted here: the socket itself (Railway's
 * proxy, or the web process when it forwards to the worker), loopback, private (10/8, 172.16/12, 192.168/16), CGNAT
 * (100.64/10), link-local and IPv6 unique-local addresses, and Railway's network (AS400940) when the ASN list knows it.
 * The client = the rightmost hop that is none of those.
 */
import net from 'net';

const v4 = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + (parseInt(p, 10) & 255), 0) >>> 0;
const inV4 = (n: number, base: string, bits: number) => bits === 0 || ((n ^ v4(base)) >>> (32 - bits)) === 0;
const V4_TRUSTED: [string, number][] = [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16]];

export const plainIp = (ip: string | undefined | null) => {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return s;
};

/** a proxy hop, not a visitor: loopback / private / CGNAT / link-local / IPv6 ULA */
export function isInternalHop(ipIn: string | undefined | null): boolean {
  const ip = plainIp(ipIn);
  if (net.isIPv4(ip)) { const n = v4(ip); return V4_TRUSTED.some(([b, m]) => inV4(n, b, m)); }
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb'); }
  return false;
}

export const RAILWAY_ASN = 400940;

/** Express `trust proxy` function: i = 0 is the socket (always a proxy here), then the X-Forwarded-For hops from the right. */
export function makeTrustProxy(asnOf: (ip: string) => number | null = () => null) {
  return (addr: string, i: number) => i === 0 || isInternalHop(addr) || asnOf(plainIp(addr)) === RAILWAY_ASN;
}

/** The same choice on a raw chain (for the log and the tests): rightmost untrusted hop of [...XFF, socket]. */
export function clientOf(socket: string, xff: string | undefined | null, asnOf: (ip: string) => number | null = () => null): string {
  const trust = makeTrustProxy(asnOf);
  const hops = [...String(xff || '').split(',').map(s => s.trim()).filter(Boolean), socket];
  for (let i = 0; i < hops.length; i++) {
    const addr = hops[hops.length - 1 - i];
    if (!trust(addr, i)) return plainIp(addr);
  }
  return plainIp(hops[0]);
}

/*
 * fix262: Railway's new edge (Hikari: requests carry x-railway-edge / x-hikari-trace) appends its own public address
 * to X-Forwarded-For ("66.249.66.1, <edge>"); that address is neither private nor in Railway's AS list, so fix254 took
 * the edge as the client (Googlebot refused all day, 28 Oct). The edge hops are now learned from the traffic, not from
 * a list that goes stale: on requests that carry the edge headers, the LAST X-Forwarded-For hop (the one Railway's own
 * proxy wrote — a client can't put an address there) is an edge when its range (/24, IPv6 /48) is the last hop for
 * many different addresses (EDGE_MIN_LEFTS) and a real share of the traffic (EDGE_MIN_SHARE). The client = the hop
 * just left of the trusted edge / proxy hops, counted from the right — never the leftmost hop (spoofable).
 */
export const EDGE_HEADERS = ['x-railway-edge', 'x-hikari-trace'] as const;
export const EDGE_MIN_LEFTS = 10; // fix262b: 20 → 10 (learned faster)
export const EDGE_KEEP_DAYS = 30; // fix262b: 7 → 30
export const EDGE_MIN_SHARE = 0.005;
export const EDGE_MIN_REQUESTS = 100;
const EDGE_WINDOW_MS = 6 * 3600000;
const LEFTS_CAP = 64;

export const hasEdgeHeader = (h: Record<string, unknown> | undefined | null) =>
  !!h && EDGE_HEADERS.some(k => { const v = h[k]; return v != null && String(v) !== ''; });

/** the range an edge address belongs to: IPv4 /24, IPv6 /48 */
export function rangeOf(ipIn: string): string | null {
  const ip = plainIp(ipIn);
  if (net.isIPv4(ip)) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.isIPv6(ip)) {
    const [h, t] = ip.toLowerCase().split('::');
    const head = h ? h.split(':') : [], tail = t !== undefined ? (t ? t.split(':') : []) : [];
    const g = t !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
    return `${g.slice(0, 3).map(x => parseInt(x || '0', 16).toString(16)).join(':')}::/48`;
  }
  return null;
}

const hopsOf = (socket: string, xff: string | undefined | null) => [...String(xff || '').split(',').map(s => s.trim()).filter(Boolean), socket];

type RangeSeen = { lefts: Set<string>; n: number; first: number; last: number; asn: number | null };
export type EdgeRange = { range: string; lefts: number; share: number; first: string; last: string; asn: number | null };
type Known = { first: number; last: number; lefts: number; share: number; asn: number | null };

/**
 * fix262: the Railway edge ranges seen in the traffic (per process; the web process keeps them in the database).
 * fix262b: the edge can be more than one hop ("client, edge2, edge1"): learning walks past the hops already known to be
 * edges, so the next one is learned too — but a hop that is not the last X-Forwarded-For entry is learned only when it
 * is in the same network (AS) as a learned edge range (Railway's Hikari edge runs on Datacamp, AS60068 / AS212238).
 */
export class EdgeLearner {
  private cur = new Map<string, RangeSeen>();
  private total = 0;
  private winStart: number;
  /** ranges proven edges (in this window, the last one, or loaded from the database) */
  private known = new Map<string, Known>();
  onLearn: ((r: EdgeRange) => void) | null = null;
  constructor(private asnOf: (ip: string) => number | null = () => null, now = Date.now()) { this.winStart = now; }

  /** one request: only those with the edge headers and a hop left of the candidate teach anything */
  note(socket: string, xff: string | undefined | null, headers: Record<string, unknown> | undefined | null, now = Date.now()) {
    if (!hasEdgeHeader(headers)) return;
    if (now - this.winStart > EDGE_WINDOW_MS) { this.cur.clear(); this.total = 0; this.winStart = now; }
    this.total++;
    const hops = hopsOf(socket, xff);
    let j = hops.length - 1;
    while (j >= 0 && (j === hops.length - 1 || isInternalHop(hops[j]) || this.asnOf(plainIp(hops[j])) === RAILWAY_ASN)) j--;
    // past the edge hops already known: the next hop is the candidate (only the first one may be outside the edge's AS)
    let deeper = false;
    while (j >= 1 && this.isEdgeRange(hops[j])) { j--; deeper = true; }
    if (j < 1) return;
    const cand = plainIp(hops[j]);
    const asn = this.asnOf(cand);
    if (deeper && !(asn != null && this.edgeAsns().has(asn))) return;
    const r = rangeOf(cand);
    if (!r) return;
    // the client behind it: past the hops in the candidate's own network (an edge hop in front of an edge hop)
    let li = j - 1;
    while (li > 0 && asn != null && this.asnOf(plainIp(hops[li])) === asn) li--;
    const left = plainIp(hops[li]);
    let s = this.cur.get(r);
    if (!s) { if (this.cur.size >= 2000) return; s = { lefts: new Set(), n: 0, first: now, last: now, asn }; this.cur.set(r, s); }
    s.n++; s.last = now;
    if (s.lefts.size < LEFTS_CAP) s.lefts.add(left);
    const share = s.n / this.total;
    if (s.lefts.size >= EDGE_MIN_LEFTS && this.total >= EDGE_MIN_REQUESTS && share >= EDGE_MIN_SHARE) {
      const k = this.known.get(r);
      this.known.set(r, { first: k?.first ?? s.first, last: now, lefts: Math.max(k?.lefts ?? 0, s.lefts.size), share: Math.max(k?.share ?? 0, share), asn: s.asn ?? k?.asn ?? null });
      if (!k && this.onLearn) this.onLearn(this.rowOf(r));
    } else if (this.known.has(r)) this.known.get(r)!.last = now;
  }
  /** a range kept from before (database) — still an edge until 30 days unseen */
  load(range: string, first: number, last: number, lefts = EDGE_MIN_LEFTS, share = EDGE_MIN_SHARE, asn: number | null = null) {
    if (Date.now() - last < EDGE_KEEP_DAYS * 86400000) this.known.set(range, { first, last, lefts, share, asn });
  }
  private isEdgeRange(ip: string) { const r = rangeOf(ip); return !!r && this.known.has(r); }
  /** the range of a learned edge, or null */
  edgeRangeOf(ip: string): string | null { const r = rangeOf(ip); return r && this.known.has(r) ? r : null; }
  isEdge(ip: string): boolean { return this.isEdgeRange(ip); }
  /** the networks (AS) the learned edge ranges are in */
  edgeAsns(): Set<number> {
    const out = new Set<number>();
    // a range loaded before the network list was ready gets its AS now (its first address)
    for (const [r, k] of this.known) { if (k.asn == null) k.asn = this.asnOf(r.replace(/0\/24$/, '1').replace(/::\/48$/, '::1')); if (k.asn != null) out.add(k.asn); }
    return out;
  }
  /** an address in the network of a learned edge range (not in a learned range itself) */
  edgeAsnOf(ip: string): number | null { const a = this.asnOf(plainIp(ip)); return a != null && this.edgeAsns().has(a) ? a : null; }
  private rowOf(r: string): EdgeRange {
    const k = this.known.get(r)!;
    return { range: r, lefts: k.lefts, share: Math.round(k.share * 1000) / 1000, first: new Date(k.first).toISOString(), last: new Date(k.last).toISOString(), asn: k.asn };
  }
  ranges(): EdgeRange[] { return [...this.known.keys()].map(r => this.rowOf(r)); }
  status() { return { ranges: this.ranges(), windowRequests: this.total, candidates: this.cur.size }; }
}

export type HopWhy = 'socket' | 'internal' | 'railway-as' | 'edge-range' | 'edge-as' | 'client' | 'left of the client';
export type ClientExplain = { ip: string; hops: { ip: string; why: HopWhy; note?: string }[]; edgeAsnSkip: boolean; allProxy: boolean };
type EdgeView = { isEdge: (ip: string) => boolean; edgeRangeOf?: (ip: string) => string | null; edgeAsnOf?: (ip: string) => number | null };

/**
 * fix262: the client of one request. From the right: the socket, our own internal / Railway-AS hops, then — only on a
 * request carrying the edge headers — every consecutive learned edge hop; the first hop that is none of those is the
 * client. fix262b: a hop in the same network (AS) as a learned edge range counts as an edge hop too (edgeAsnSkip: such
 * a request is never verified as a search engine — a scraper on that network could write a Google address in front).
 */
export function explainClient(socket: string, xff: string | undefined | null, headers: Record<string, unknown> | undefined | null,
  asnOf: (ip: string) => number | null = () => null, edge: EdgeView | null = null): ClientExplain {
  const trust = makeTrustProxy(asnOf);
  const viaEdge = !!edge && hasEdgeHeader(headers);
  const hops = hopsOf(socket, xff);
  const out: ClientExplain['hops'] = [];
  let edgeAsnSkip = false;
  for (let i = 0; i < hops.length; i++) {
    const addr = plainIp(hops[hops.length - 1 - i]);
    if (i === 0) { out.push({ ip: addr, why: 'socket' }); continue; }
    if (isInternalHop(addr)) { out.push({ ip: addr, why: 'internal' }); continue; }
    if (trust(addr, i)) { out.push({ ip: addr, why: 'railway-as' }); continue; }
    if (viaEdge) {
      const r = edge!.edgeRangeOf ? edge!.edgeRangeOf(addr) : edge!.isEdge(addr) ? rangeOf(addr) : null;
      if (r) { out.push({ ip: addr, why: 'edge-range', note: r }); continue; }
      const a = edge!.edgeAsnOf?.(addr) ?? null;
      if (a != null && i < hops.length - 1) { out.push({ ip: addr, why: 'edge-as', note: `AS${a}` }); edgeAsnSkip = true; continue; }
    }
    out.push({ ip: addr, why: 'client' });
    for (let k = hops.length - 2 - i; k >= 0; k--) out.push({ ip: plainIp(hops[k]), why: 'left of the client' });
    return { ip: addr, hops: out.reverse(), edgeAsnSkip, allProxy: false };
  }
  return { ip: plainIp(hops[0]), hops: out.reverse(), edgeAsnSkip, allProxy: true };
}
export const clientOfRequest = (socket: string, xff: string | undefined | null, headers: Record<string, unknown> | undefined | null,
  asnOf: (ip: string) => number | null = () => null, edge: EdgeView | null = null): string => explainClient(socket, xff, headers, asnOf, edge).ip;

/** fix262b: one line per sample: the hop list from the left, which hop was taken and why */
export function hopLine(x: ClientExplain): string {
  const W: Record<HopWhy, string> = { socket: 'socket', internal: 'internal', 'railway-as': "Railway's AS", 'edge-range': 'edge', 'edge-as': 'edge network', client: 'TAKEN', 'left of the client': 'ignored' };
  return x.hops.map(h => `${h.ip} [${W[h.why]}${h.note ? ` ${h.note}` : ''}]`).join(' → ') + (x.allProxy ? ' (every hop a proxy: the leftmost taken)' : '');
}

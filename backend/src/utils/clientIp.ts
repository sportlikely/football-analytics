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

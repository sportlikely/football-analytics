/**
 * fix183: is an address in a data-centre network (cloud servers, hosting)? Requests from there are scripts, not
 * people, so the visitor counter never counts them. Offline, like the country lookup (geo.ts): the public-domain
 * ip2asn data from iptoasn.com is downloaded by the server (every ~35 days) and only the ranges of the networks below
 * are kept (DATA_DIR/geo/dc-ranges.json, a few hundred kB). The IP is looked up in memory and never stored.
 * GEO_OFF=1 switches it off.
 * fix199: proxy networks resold to VPN / scraping services (Datacamp, M247 …) are on the list too, the registry name of
 * each network is kept (Security log: "Datacamp Ltd (AS60068, NL)"), and the file is downloaded again when the list
 * changes.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import https from 'https';
import net from 'net';
import readline from 'readline';
import logger from '../utils/logger';
import { every, after } from './perf';

const DIR = path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), 'geo');
const FILE = path.join(DIR, 'dc-ranges.json');
const MAX_AGE = 35 * 86400000;

/** Data-centre networks (AS numbers): AWS, Google Cloud, Azure, DigitalOcean, OVH, Hetzner, Linode, Oracle, Alibaba,
 *  Tencent, Contabo, Railway, plus Vultr, Scaleway, Leaseweb (not VPN or Cloudflare WARP networks: people use those). */
export const DC_ASNS: Record<number, string> = {
  16509: 'Amazon AWS', 14618: 'Amazon AWS', 8987: 'Amazon AWS', 39111: 'Amazon AWS',
  396982: 'Google Cloud', 15169: 'Google', 19527: 'Google Cloud', 36492: 'Google',
  8075: 'Microsoft Azure', 8068: 'Microsoft Azure', 8069: 'Microsoft Azure',
  14061: 'DigitalOcean', 16276: 'OVH', 35540: 'OVH', 24940: 'Hetzner', 213230: 'Hetzner', 212317: 'Hetzner',
  63949: 'Linode / Akamai', 31898: 'Oracle Cloud', 45102: 'Alibaba Cloud', 37963: 'Alibaba Cloud', 134963: 'Alibaba Cloud',
  132203: 'Tencent Cloud', 45090: 'Tencent Cloud', 139341: 'Tencent Cloud', 51167: 'Contabo', 40021: 'Contabo',
  400940: 'Railway', 20473: 'Vultr', 12876: 'Scaleway', 60781: 'Leaseweb', 28753: 'Leaseweb',
  // fix199: proxy / VPN-resale hosting (20–21 Oct: one script through ~25 Datacamp addresses)
  60068: 'Datacamp Ltd', 212238: 'Datacamp Ltd', 9009: 'M247', 62240: 'Clouvider', 147049: 'PacketHub', 207137: 'PacketHub',
  21859: 'Zenlayer', 203020: 'HostRoyale', 137409: 'GSL Networks'
};
/** fix199: a new network on the list → the ranges are downloaded again (the file keeps only listed networks). */
const LIST_SIG = Object.keys(DC_ASNS).sort().join(',');
/** The same networks by their registry name (when a network has more numbers than the list holds). */
const DC_NAME = /^(AMAZON-|AMAZON |GOOGLE-CLOUD|MICROSOFT-CORP-MSN|DIGITALOCEAN|OVH|HETZNER|LINODE|AKAMAI-LINODE|ORACLE-BMC|ALIBABA|TENCENT|CONTABO|RAILWAY|VULTR|AS-CHOOPA|SCALEWAY|LEASEWEB|DATACAMP|CDN77|M247|CLOUVIDER|PACKETHUB|ZENLAYER|HOSTROYALE)/i;

let v4s: Uint32Array | null = null, v4e: Uint32Array | null = null, v4a: Uint32Array | null = null;
let v6s: BigUint64Array | null = null, v6e: BigUint64Array | null = null, v6a: Uint32Array | null = null;
let names: Record<string, string> = {};
let status = 'not loaded';

const v4num = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + (parseInt(p, 10) & 255), 0) >>> 0;
function v6hi(ip: string): bigint {
  let s = ip;
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  if (s.includes('.')) { const i = s.lastIndexOf(':'); const n = v4num(s.slice(i + 1)); s = `${s.slice(0, i + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [h, t] = s.split('::');
  const head = h ? h.split(':') : [], tail = t !== undefined ? (t ? t.split(':') : []) : [];
  const g = t !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  let v = 0n;
  for (let i = 0; i < 4; i++) v = (v << 16n) | BigInt(parseInt(g[i] || '0', 16) & 0xffff);
  return v;
}
function find<T extends number | bigint>(starts: ArrayLike<T>, ends: ArrayLike<T>, x: T): number {
  let lo = 0, hi = starts.length - 1, best = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= x) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return best >= 0 && x <= ends[best] ? best : -1;
}

/** fix199: the data-centre / proxy network of an address ({ asn: 60068, name: 'Datacamp Ltd' }), or null. */
export function networkOf(ipIn: string): { asn: number; name: string } | null {
  try {
    let ip = String(ipIn || '').trim();
    if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
    let asn = 0;
    if (net.isIPv4(ip) && v4s) { const i = find(v4s, v4e!, v4num(ip)); if (i >= 0) asn = v4a![i]; }
    else if (net.isIPv6(ip) && v6s) { const i = find(v6s, v6e!, v6hi(ip)); if (i >= 0) asn = v6a![i]; }
    if (asn) return { asn, name: DC_ASNS[asn] || names[asn] || `AS${asn}` };
  } catch { /* unknown */ }
  return null;
}
/** The data-centre network of an address ("Amazon AWS"), or null. */
export const dataCentreOf = (ip: string): string | null => networkOf(ip)?.name ?? null;
export const asnStatus = () => ({ loaded: !!v4s, status });

type Saved = { at: string; v4: [string, string, number][]; v6: [string, string, number][]; list?: string; names?: Record<string, string> };
function use(d: Saved) {
  const a4 = d.v4.sort((x, y) => v4num(x[0]) - v4num(y[0])), a6 = d.v6.sort((x, y) => (v6hi(x[0]) < v6hi(y[0]) ? -1 : 1));
  v4s = Uint32Array.from(a4.map(r => v4num(r[0]))); v4e = Uint32Array.from(a4.map(r => v4num(r[1]))); v4a = Uint32Array.from(a4.map(r => r[2]));
  v6s = BigUint64Array.from(a6.map(r => v6hi(r[0]))); v6e = BigUint64Array.from(a6.map(r => v6hi(r[1]))); v6a = Uint32Array.from(a6.map(r => r[2]));
  names = d.names || {};
  status = `${a4.length} IPv4 + ${a6.length} IPv6 data-centre ranges (iptoasn.com, ${d.at.slice(0, 10)})`;
}

function download(url: string, redirects = 3): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'SportLikely/1.0 (visitor counts)' }, timeout: 120000 }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return download(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download answered ${res.statusCode}`)); }
      resolve(res.pipe(zlib.createGunzip()));
    }).on('timeout', function (this: any) { this.destroy(new Error('download timeout')); }).on('error', reject);
  });
}
/** ip2asn TSV: range_start range_end AS_number country_code AS_description — only data-centre rows kept (and, fix199,
 *  each network's registry name). */
async function readRanges(url: string, nameOut: Record<string, string>): Promise<[string, string, number][]> {
  const out: [string, string, number][] = [];
  const rl = readline.createInterface({ input: await download(url), crlfDelay: Infinity });
  for await (const line of rl) {
    const [s, e, asn, , desc] = line.split('\t');
    const n = Number(asn);
    if (n && (DC_ASNS[n] || DC_NAME.test(desc || ''))) {
      out.push([s, e, n]);
      if (!nameOut[n] && desc) nameOut[n] = desc.trim().slice(0, 60);
    }
  }
  return out;
}
async function refresh() {
  const nm: Record<string, string> = {};
  const v4 = await readRanges('https://iptoasn.com/data/ip2asn-v4.tsv.gz', nm);
  if (v4.length < 1000) throw new Error(`only ${v4.length} IPv4 ranges read`);
  let v6: [string, string, number][] = [];
  try { v6 = await readRanges('https://iptoasn.com/data/ip2asn-v6.tsv.gz', nm); } catch (e: any) { logger.warn(`asn: IPv6 not loaded: ${e.message}`); }
  const d: Saved = { at: new Date().toISOString(), v4, v6, list: LIST_SIG, names: nm };
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.part', JSON.stringify(d));
  fs.renameSync(FILE + '.part', FILE);
  use(d);
  logger.info(`asn: ${status}`);
}

/** fix202: the web process reads the ranges the worker downloaded (no download of its own) */
export function loadAsnFile(): boolean {
  if (process.env.GEO_OFF === '1') return false;
  try { const saved: Saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (saved) { use(saved); return true; } } catch { /* none yet */ }
  return false;
}

export function startAsn() {
  if (process.env.GEO_OFF === '1') { status = 'off (GEO_OFF=1)'; return; }
  let saved: Saved | null = null;
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (saved) use(saved); } catch { /* none yet */ }
  const run = () => {
    const age = saved ? Date.now() - Date.parse(saved.at) : Infinity;
    if (v4s && age < MAX_AGE && saved?.list === LIST_SIG) return;
    refresh().then(() => { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); }).catch(e => { status = `not loaded: ${e.message}`; logger.warn(`asn: ${e.message}`); });
  };
  after('asn', run, 90 * 1000).unref();
  every('asn', run, 24 * 3600 * 1000).unref();
}

/**
 * Country from an IP address, offline (Oct 2026) — for the visitor counts only. The IP is looked up in memory at the
 * moment of the visit; only the 2-letter country code is kept (next to the hashed visitor id). No IP is stored.
 *
 * Data: "IP to Country Lite" by DB-IP (https://db-ip.com), licence CC BY 4.0 — attribution on the privacy page and the
 * admin card. The server downloads the monthly file itself (DATA_DIR/geo, a few MB) and refreshes it every ~35 days.
 * Oct 2026 (fix116): DB-IP sometimes answers the server with a web page; every download is checked (gzip / text / page)
 * and read before it replaces the saved data, with fallbacks: the same DB-IP data on jsDelivr, then iptoasn.com's
 * public-domain ip2country. The source in use is in DATA_DIR/geo/source.txt.
 * IPv6 ranges are matched on their first 64 bits (country data is never finer than that).
 * GEO_OFF=1 switches it off.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import https from 'https';
import net from 'net';
import readline from 'readline';
import logger from '../utils/logger';
import { every, after } from './perf';
import { onState, publishState } from './shared';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const DIR = path.join(DATA_DIR, 'geo');
const FILE = path.join(DIR, 'dbip-country-lite.csv.gz'); // IPv4 (DB-IP: IPv4 + IPv6), whatever the source
const FILE6 = path.join(DIR, 'country-ipv6.csv');           // IPv6 when the source has a separate file
const SOURCE_FILE = path.join(DIR, 'source.txt');
const MAX_AGE = 35 * 86400000;
const savedFiles = () => [FILE, ...(fs.existsSync(FILE6) ? [FILE6] : [])];
const savedSource = () => { try { return fs.readFileSync(SOURCE_FILE, 'utf8').trim(); } catch { return ''; } };

let v4s: Uint32Array | null = null, v4e: Uint32Array | null = null, v4c: Uint16Array | null = null;
let v6s: BigUint64Array | null = null, v6e: BigUint64Array | null = null, v6c: Uint16Array | null = null;
let codes: string[] = [];
let loadedAt: string | null = null;
let status = 'not loaded';
// fix202: the worker loads / downloads the data; the web process (which counts the visitors) takes the finished arrays
onState('geo', (_k, v) => { ({ v4s, v4e, v4c, v6s, v6e, v6c, codes, loadedAt, status } = v); });

const v4num = (ip: string) => ip.split('.').reduce((a, p) => a * 256 + (parseInt(p, 10) & 255), 0) >>> 0;
/** first 64 bits of an IPv6 address */
function v6hi(ip: string): bigint {
  let s = ip;
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  if (s.includes('.')) { // embedded IPv4 at the end
    const i = s.lastIndexOf(':'); const n = v4num(s.slice(i + 1));
    s = `${s.slice(0, i + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [h, t] = s.split('::');
  const head = h ? h.split(':') : [];
  const tail = t !== undefined ? (t ? t.split(':') : []) : [];
  const groups = t !== undefined ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
  let v = 0n;
  for (let i = 0; i < 4; i++) v = (v << 16n) | BigInt(parseInt(groups[i] || '0', 16) & 0xffff);
  return v;
}

type Kind = 'gzip' | 'text';
/** What a downloaded / saved file really is: gzip, plain text, or a web page (a blocked download) → error. */
function kindOf(file: string): Kind {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    if (n >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
    const head = buf.subarray(0, n).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (head.startsWith('<')) throw new Error('got a web page instead of the data file (download blocked?)');
    return 'text';
  } finally {
    fs.closeSync(fd);
  }
}

/** Every line of a file (gzip or text). A broken gzip stream rejects instead of ending the read early. */
async function readLines(file: string, onLine: (line: string) => void) {
  const kind = kindOf(file);
  const src = fs.createReadStream(file);
  const input = kind === 'gzip' ? src.pipe(zlib.createGunzip()) : src;
  const failed = new Promise<never>((_, reject) => {
    src.on('error', reject);
    if (input !== src) input.on('error', reject);
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const loop = (async () => { for await (const line of rl) onLine(line); })();
  loop.catch(() => undefined); failed.catch(() => undefined); // the race below reports the first error
  try {
    await Promise.race([loop, failed]);
  } finally {
    rl.close();
    src.destroy();
  }
}

/** Load country ranges: "start,end,CC" (DB-IP, jsDelivr) or tab-separated (iptoasn), from one or more files. */
export async function loadGeo(files: string | string[] = savedFiles(), minV4 = 1000) {
  const list = Array.isArray(files) ? files : [files];
  const s4: number[] = [], e4: number[] = [], c4: number[] = [];
  const s6: bigint[] = [], e6: bigint[] = [], c6: number[] = [];
  const idx = new Map<string, number>();
  const ci = (cc: string) => { let i = idx.get(cc); if (i === undefined) { i = idx.size; idx.set(cc, i); } return i; };
  for (const file of list) {
    await readLines(file, line => {
      const parts = line.replace(/"/g, '').split(/[,\t]/);
      if (parts.length < 3) return;
      const a = parts[0].trim(), b = parts[1].trim();
      const code = parts[2].trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ' || code === 'XX') return;
      if (net.isIPv4(a) && net.isIPv4(b)) { s4.push(v4num(a)); e4.push(v4num(b)); c4.push(ci(code)); }
      else if (net.isIPv6(a) && net.isIPv6(b)) { s6.push(v6hi(a)); e6.push(v6hi(b)); c6.push(ci(code)); }
    });
  }
  if (s4.length < minV4) throw new Error(`only ${s4.length} IPv4 ranges — file looks broken`);
  // binary search needs the ranges in start order (files from different sources are not always sorted)
  const o4 = Array.from({ length: s4.length }, (_, i) => i).sort((x, y) => s4[x] - s4[y]);
  const o6 = Array.from({ length: s6.length }, (_, i) => i).sort((x, y) => (s6[x] < s6[y] ? -1 : s6[x] > s6[y] ? 1 : 0));
  v4s = Uint32Array.from(o4, i => s4[i]); v4e = Uint32Array.from(o4, i => e4[i]); v4c = Uint16Array.from(o4, i => c4[i]);
  v6s = BigUint64Array.from(o6, i => s6[i]); v6e = BigUint64Array.from(o6, i => e6[i]); v6c = Uint16Array.from(o6, i => c6[i]);
  codes = [...idx.keys()];
  loadedAt = new Date().toISOString();
  status = `${s4.length} IPv4 + ${s6.length} IPv6 ranges`;
  publishState('geo', { v4s, v4e, v4c, v6s, v6e, v6c, codes, loadedAt, status });
  return { v4: s4.length, v6: s6.length };
}

function find<T extends number | bigint>(starts: ArrayLike<T>, ends: ArrayLike<T>, x: T): number {
  let lo = 0, hi = starts.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= x) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 && x <= ends[best] ? best : -1;
}

/** 2-letter country code, or null (unknown, private address, data not loaded). */
export function countryOf(ipIn: string): string | null {
  try {
    let ip = ipIn.trim();
    if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
    if (net.isIPv4(ip) && v4s) { const i = find(v4s, v4e!, v4num(ip)); return i >= 0 ? codes[v4c![i]] : null; }
    if (net.isIPv6(ip) && v6s) { const i = find(v6s, v6e!, v6hi(ip)); return i >= 0 ? codes[v6c![i]] : null; }
  } catch { /* unknown */ }
  return null;
}

/** The country data in use, for the credit on the privacy page and the admin card. */
export function geoCredit() {
  return /^iptoasn/.test(savedSource())
    ? { name: 'ip2country by iptoasn.com', url: 'https://iptoasn.com', licence: 'public domain' }
    : { name: 'IP Geolocation by DB-IP', url: 'https://db-ip.com', licence: 'CC BY 4.0' };
}
export const geoStatus = () => ({
  loaded: !!v4s, loadedAt, status,
  source: /^iptoasn/.test(savedSource()) ? 'ip2country by iptoasn.com (public domain)' : 'IP to Country Lite by DB-IP (db-ip.com), CC BY 4.0'
});

function download(url: string, dst: string, redirects = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'SportLikely/1.0 (visitor countries)' }, timeout: 120000 }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); return download(new URL(res.headers.location, url).toString(), dst, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download answered ${res.statusCode}`)); }
      const out = fs.createWriteStream(dst);
      res.pipe(out);
      out.on('finish', () => resolve());
      out.on('error', reject);
      res.on('error', reject);
    }).on('timeout', function (this: any) { this.destroy(new Error('download timeout')); }).on('error', reject);
  });
}

interface Source { name: string; v4: string; v6?: string }
function sources(): Source[] {
  const now = new Date();
  const ym = (back: number) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  return [
    // the new month's file appears at the start of the month: this month, then the previous one
    ...[0, 1].map(b => ({ name: `DB-IP ${ym(b)}`, v4: `https://download.db-ip.com/free/dbip-country-lite-${ym(b)}.csv.gz` })),
    { name: 'DB-IP via jsDelivr', v4: 'https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/dbip-country-ipv4.csv', v6: 'https://cdn.jsdelivr.net/npm/@ip-location-db/dbip-country/dbip-country-ipv6.csv' },
    { name: 'iptoasn ip2country', v4: 'https://iptoasn.com/data/ip2country-v4.tsv.gz', v6: 'https://iptoasn.com/data/ip2country-v6.tsv.gz' }
  ];
}

/** Try every source in order; a download replaces the saved data only once it has been read successfully. */
async function refresh() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const src of sources()) {
    const t4 = FILE + '.part', t6 = FILE6 + '.part';
    try {
      await download(src.v4, t4);
      if (src.v6) await download(src.v6, t6);
      await loadGeo(src.v6 ? [t4, t6] : [t4]); // check it parses before replacing the old data
      fs.renameSync(t4, FILE);
      if (src.v6) fs.renameSync(t6, FILE6); else fs.rmSync(FILE6, { force: true });
      fs.writeFileSync(SOURCE_FILE, src.name);
      logger.info(`geo: country data from ${src.name} loaded (${status})`);
      return;
    } catch (e: any) {
      logger.warn(`geo: ${src.name} not loaded: ${e.message}`);
    } finally {
      fs.rmSync(t4, { force: true });
      fs.rmSync(t6, { force: true });
    }
  }
  throw new Error('no country data could be downloaded');
}

/**
 * At start-up: load the saved files, download new data when missing or older than ~35 days. Then every hour while
 * nothing is loaded, and once a day after that.
 */
export function startGeo() {
  if (process.env.GEO_OFF === '1') { status = 'off (GEO_OFF=1)'; return; }
  let lastRun = 0, running = false;
  const run = async () => {
    if (running) return;
    running = true;
    lastRun = Date.now();
    try {
      const fresh = fs.existsSync(FILE) && Date.now() - fs.statSync(FILE).mtimeMs < MAX_AGE;
      if (fs.existsSync(FILE) && !v4s) await loadGeo().catch(e => { status = `saved file unreadable: ${e.message}`; });
      if (!fresh || !v4s) await refresh();
    } catch (e: any) {
      status = v4s ? status : `not loaded: ${e.message}`;
      logger.warn(`geo: ${e.message}`);
    } finally {
      running = false;
    }
  };
  after('geo', () => { run(); }, 30000).unref();
  every('geo', () => { if (!v4s || Date.now() - lastRun > 24 * 3600000) run(); }, 3600000).unref();
}

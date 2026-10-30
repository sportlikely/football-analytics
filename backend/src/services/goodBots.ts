/**
 * fix285: link previews and AI crawlers that name themselves — the server side of utils/goodBots.ts (the rules live there).
 *  - every request whose user-agent names one of them is checked once here (web process, before the swarm / proxy rules):
 *    its published ranges (seed + the lists the worker downloads daily: DATA_DIR/geo/good-bot-ranges.json, state
 *    'good-bot-ranges') or reverse DNS → forward DNS (24 h per address, salted hash keys);
 *  - verified previews and trusted AI bots are treated like verified search engines (req.verifiedCrawler: stored pages,
 *    no provider calls, never a swarm / proxy / Quick-check challenge); `card` previews get the Open Graph card only;
 *    an AI bot on Challenge gets the Quick check on every read;
 *  - the AI bots' switches (Trust / Challenge) are Yarin's: Admin → Visitors → Swarms (table good_bot_modes, answered by
 *    the worker, published at once as 'goodbots:modes');
 *  - today's counts per bot live in the web process's memory (Admin → Visitors reads them live): requests, addresses,
 *    verified, fakes, challenged — no address is kept (salted hashes, a new salt at every start).
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import dns from 'node:dns';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../db';
import logger from '../utils/logger';
import { every, after } from './perf';
import { onState, publishState, applyState } from './shared';
import { parseRangeFile, parseCidrText, plainIp, type CrawlerRanges } from '../utils/crawlerRanges';
import {
  GOOD_BOTS, goodBotOfUa, goodBotById, seedRanges, rangesOf, botStatus, botAct, modeOf,
  type GoodBot, type BotMode, type BotStatus, type BotAct
} from '../utils/goodBots';

const FILE = path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), 'geo', 'good-bot-ranges.json');
type Saved = { at: string; lists: Record<string, { at: string; prefixes: string[] }> };
let saved: Saved | null = null;
let ranges: CrawlerRanges<string> = rangesOf(seedRanges());
function use(d: Saved) {
  saved = d;
  const by = seedRanges();
  for (const [id, l] of Object.entries(d.lists || {})) (by[id] ||= []).push(...(l.prefixes || []));
  ranges = rangesOf(by);
}
try { use(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* none yet: the seed */ }
onState('good-bot-ranges', (_k, v: any) => { if (v?.lists) use(v); });
/** test hook: these lists now */
export const useGoodBotRanges = (d: Saved) => use(d);

function getText(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'SportLikely/1.0 (bot verification)' }, timeout: 30000 }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return getText(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`answered ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 5e6) res.destroy(new Error('too big')); });
      res.on('end', () => resolve(body));
    }).on('timeout', function (this: any) { this.destroy(new Error('timeout')); }).on('error', reject);
  });
}
/** worker: download every published list (a failed one keeps its last copy), save, publish */
export async function refreshGoodBotRanges(fetchText: (url: string) => Promise<string> = getText): Promise<string[]> {
  const lists = { ...(saved?.lists || {}) };
  const failed: string[] = [];
  for (const b of GOOD_BOTS) {
    if (!b.lists?.length) continue;
    const prefixes: string[] = [];
    let err: string | null = null;
    for (const l of b.lists) {
      try {
        const text = await fetchText(l.url);
        prefixes.push(...(l.format === 'json' ? parseRangeFile(JSON.parse(text)) : parseCidrText(text)));
      } catch (e: any) { err = `${b.id}: ${e?.message || e}`; }
    }
    if (prefixes.length) lists[b.id] = { at: new Date().toISOString(), prefixes };
    else failed.push(err || `${b.id}: no prefixes`);
  }
  const d: Saved = { at: new Date().toISOString(), lists };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.part', JSON.stringify(d));
    fs.renameSync(FILE + '.part', FILE);
  } catch (e: any) { logger.warn(`good-bot ranges: not saved: ${e.message}`); }
  use(d);
  publishState('good-bot-ranges', d);
  logger.info(`good-bot ranges: ${Object.entries(lists).map(([k, l]) => `${k} ${l.prefixes.length}`).join(' · ') || 'seed only'}${failed.length ? ` — kept the last copy of ${failed.join('; ')}` : ''}`);
  return failed;
}
export function startGoodBotRanges() {
  const run = () => refreshGoodBotRanges().catch(e => logger.warn(`good-bot ranges: ${e?.message || e}`));
  after('good-bot ranges', run, 90 * 1000).unref();
  every('good-bot ranges', run, 24 * 3600 * 1000).unref();
}

// ---------- reverse DNS (Pinterest, Amazonbot): PTR to the bot's host, forward back to the address ----------
const SALT = randomBytes(16).toString('hex');
const hashOf = (s: string) => createHash('sha256').update(SALT + s).digest('hex').slice(0, 20);
const dnsDone = new Map<string, { ok: boolean; at: number }>();
const dnsRunning = new Set<string>();
const publicDns = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
try { publicDns.setServers((process.env.CRAWLER_DNS_SERVERS || '8.8.8.8,1.1.1.1').split(',')); } catch { /* no network */ }
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);
async function dnsVerify(ip: string, host: RegExp): Promise<boolean> {
  for (const viaPublic of [false, true]) {
    try {
      const names = (await within(viaPublic ? publicDns.reverse(ip) : dns.promises.reverse(ip), 5000)).map(n => n.replace(/\.$/, '')).filter(n => host.test(n));
      for (const name of names) {
        const addrs = viaPublic ? await within(ip.includes(':') ? publicDns.resolve6(name) : publicDns.resolve4(name), 5000)
          : (await within(dns.promises.lookup(name, { all: true }), 5000)).map(a => a.address);
        if (addrs.some(a => plainIp(a) === ip)) return true;
      }
    } catch { /* the next resolver */ }
  }
  return false;
}
/** true / false once checked (24 h), null while the check runs (started here) */
function dnsOf(b: GoodBot, ipIn: string | undefined): boolean | null {
  const ip = plainIp(ipIn);
  if (!b.dns || !ip) return false;
  const key = hashOf(`${b.id}|${ip}`);
  const v = dnsDone.get(key);
  if (v && Date.now() - v.at < 86400000) return v.ok;
  if (!dnsRunning.has(key)) {
    dnsRunning.add(key);
    void dnsVerify(ip, b.dns).catch(() => false).then(ok => {
      if (dnsDone.size >= 5000) dnsDone.delete(dnsDone.keys().next().value as string);
      dnsDone.set(key, { ok, at: Date.now() });
    }).finally(() => dnsRunning.delete(key));
  }
  return null;
}

// ---------- the switches (worker writes, the web applies) ----------
db.exec(`CREATE TABLE IF NOT EXISTS good_bot_modes (id TEXT PRIMARY KEY, mode TEXT NOT NULL, by TEXT, at TEXT NOT NULL)`);
const MODES_KEY = 'goodbots:modes';
type ModeRow = { id: string; mode: BotMode; by: string | null; at: string };
const loadModes = (): ModeRow[] => { try { return db.prepare(`SELECT id, mode, by, at FROM good_bot_modes`).all() as ModeRow[]; } catch { return []; } };
let modes: Record<string, BotMode> = {};
let modeRows: ModeRow[] = [];
const useModes = (list: ModeRow[]) => { modeRows = list; modes = Object.fromEntries(list.filter(r => r.mode === 'trust' || r.mode === 'challenge').map(r => [r.id, r.mode])); };
useModes(loadModes());
onState(MODES_KEY, (_k, v) => { if (Array.isArray(v)) useModes(v as ModeRow[]); });
/** Admin → Visitors → Swarms: Trust / Challenge one AI bot (applied in the web process at once) */
export function setGoodBotMode(id: string, mode: BotMode, by: string | null): ModeRow[] {
  const b = goodBotById(id);
  if (!b || b.kind !== 'ai') throw new Error('unknown AI bot');
  if (mode !== 'trust' && mode !== 'challenge') throw new Error('bad mode');
  db.prepare(`INSERT OR REPLACE INTO good_bot_modes (id, mode, by, at) VALUES (?, ?, ?, ?)`).run(id, mode, by, new Date().toISOString());
  const list = loadModes();
  applyState(MODES_KEY, list); // this process + the web process (IPC)
  return list;
}

// ---------- one request ----------
export type GoodBotCheck = { bot: GoodBot; status: BotStatus; act: BotAct; mode: BotMode };
/** the bot this request names and what it gets (null = no bot we know) */
export function goodBotCheck(ip: string | undefined, ua: string | undefined): GoodBotCheck | null {
  try {
    const bot = goodBotOfUa(ua);
    if (!bot) return null;
    const status = botStatus(bot, ip, ranges, bot.dns ? dnsOf(bot, ip) : null);
    const mode = modeOf(bot.id, modes);
    return { bot, status, act: botAct(bot, status, mode), mode };
  } catch { return null; }
}
/** the visits.bot reason of a checked request (null = a fake: counted like any other caller) */
export const visitReasonOf = (c: GoodBotCheck | null): string | null =>
  !c ? null : c.act === 'challenge' ? 'ai-blocked' : c.act === 'normal' ? null : c.bot.kind === 'preview' ? 'preview' : 'ai-trusted';

// ---------- today's counts (web memory) ----------
type Day = { day: string; by: Map<string, { requests: number; pages: number; verified: number; card: number; fake: number; challenged: number; addrs: Set<string> }> };
let cur: Day = { day: '', by: new Map() };
/** web: one request of a named bot (page = an HTML page) */
export function noteGoodBot(c: GoodBotCheck | null, ip: string | undefined, page: boolean) {
  if (!c) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (cur.day !== day) cur = { day, by: new Map() };
    let e = cur.by.get(c.bot.id);
    if (!e) cur.by.set(c.bot.id, (e = { requests: 0, pages: 0, verified: 0, card: 0, fake: 0, challenged: 0, addrs: new Set() }));
    e.requests++;
    if (page) e.pages++;
    if (c.status === 'verified') e.verified++;
    else if (c.status === 'card') e.card++;
    else if (c.status === 'fake' || c.status === 'pending') e.fake++;
    if (c.act === 'challenge') e.challenged++;
    if (ip && e.addrs.size < 20000) e.addrs.add(hashOf(ip));
  } catch { /* counting never breaks a request */ }
}
export type GoodBotRow = {
  id: string; name: string; kind: 'preview' | 'ai'; owner: string; checked: 'ranges' | 'dns' | 'card' | 'name'; mode: BotMode | null; modeBy: string | null;
  requests: number; pages: number; addresses: number; verified: number; card: number; fake: number; challenged: number
};
/** Admin → Visitors → Swarms: every AI bot (with its switch) and every preview bot, today's counts */
export function goodBotRows(): GoodBotRow[] {
  const day = new Date().toISOString().slice(0, 10);
  return GOOD_BOTS.map(b => {
    const e = cur.day === day ? cur.by.get(b.id) : undefined;
    const set = modeRows.find(r => r.id === b.id);
    return {
      id: b.id, name: b.name, kind: b.kind, owner: b.owner,
      checked: b.ranges?.length || b.lists?.length ? 'ranges' : b.dns ? 'dns' : b.card ? 'card' : 'name',
      mode: b.kind === 'ai' ? modeOf(b.id, modes) : null, modeBy: set?.by ?? null,
      requests: e?.requests || 0, pages: e?.pages || 0, addresses: e?.addrs.size || 0, verified: e?.verified || 0, card: e?.card || 0, fake: e?.fake || 0, challenged: e?.challenged || 0
    } as GoodBotRow;
  });
}
export const goodBotModes = () => modeRows;
export const goodBotRangesStatus = () => ({ at: saved?.at || null, lists: Object.fromEntries(Object.entries(saved?.lists || {}).map(([k, l]) => [k, l.prefixes.length])) });

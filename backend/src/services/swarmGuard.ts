/**
 * fix277: scraper swarms — the server side of utils/swarmRules.ts (the rules live there).
 *  - the web process counts every non-admin page / API read and every seen beacon per group (user-agent + country +
 *    network) in memory; verified search engines and admins are never counted;
 *  - never challenged: admins, verified search engines, signed-in email-verified accounts and Quick-check pass holders
 *    (their addresses count as human signs: people on one network protect it), and the account / sign-in / sign-up /
 *    billing / beacon routes (proxyGuard countedRead);
 *  - a swarm member signed out: every page / API read answers 429 + the Quick check (fix244, Turnstile; a pass clears
 *    it, then only the pass's own hourly limit), no prediction, stored data only, no crawler HTML, never a visit
 *    (visits.bot = 'swarm');
 *  - every minute the web writes the admin rows (swarm_days) and the holds (swarm_live: hashed keys only, a restart
 *    keeps them); the worker answers Admin → Visitors → "Always challenge" / "Trust" (swarm_overrides, published at
 *    once as 'swarm:overrides'), data health "Scraper swarms" and the 07:00 summary line.
 */
import { createHash } from 'node:crypto';
import { db } from '../db';
import { isWeb, isWorker } from './role';
import { deferred } from './deferredWrites';
import { every } from './perf';
import { countryOf } from './geo';
import { networkOf } from './asn';
import { onState, applyState } from './shared';
import { addSummaryLine, adminUrl } from './adminMail';
import logger from '../utils/logger';
import { SwarmTracker, netOf, swarmSummaryLine, type SwarmHit, type SwarmOverride, type SwarmRow, type SwarmVerdict } from '../utils/swarmRules';

db.exec(`CREATE TABLE IF NOT EXISTS swarm_days (day TEXT NOT NULL, ua TEXT NOT NULL, text TEXT, state TEXT NOT NULL, refused INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (day, ua))`);
db.exec(`CREATE TABLE IF NOT EXISTS swarm_live (k TEXT PRIMARY KEY, data TEXT NOT NULL, at TEXT NOT NULL)`);
db.exec(`CREATE TABLE IF NOT EXISTS swarm_overrides (ua TEXT PRIMARY KEY, mode TEXT NOT NULL, text TEXT, by TEXT, at TEXT NOT NULL)`);

export const swarms = new SwarmTracker();
const OVERRIDES_KEY = 'swarm:overrides';
type OverrideRow = { ua: string; mode: SwarmOverride; text: string | null; by: string | null; at: string };
const loadOverrides = (): OverrideRow[] => {
  try { return db.prepare(`SELECT ua, mode, text, by, at FROM swarm_overrides`).all() as OverrideRow[]; } catch { return []; }
};
swarms.setOverrides(loadOverrides());
onState(OVERRIDES_KEY, (_k, v) => { if (Array.isArray(v)) swarms.setOverrides(v as OverrideRow[]); });
try {
  const r = db.prepare(`SELECT data FROM swarm_live WHERE k = 'holds'`).get() as any;
  if (r?.data) swarms.loadHolds(JSON.parse(r.data));
} catch { /* none yet */ }

// salted address hashes (a new salt at every start; the holds are kept by group / user-agent, never by address)
const SALT = createHash('sha256').update(`swarm|${process.pid}|${Date.now()}|${Math.random()}`).digest('hex');
const addrOf = (ip: string) => createHash('sha256').update(SALT + ip).digest('hex').slice(0, 20);

/**
 * the group of this request — null without an address, for this machine itself, and for the documentation ranges
 * (2001:db8::/32, 192.0.2/24 …: never routed on the internet; the site gate's visitors, scripts/site-test.mjs)
 */
const NOT_ROUTED = /^(127\.|::1$|::ffff:127\.|2001:db8:|(::ffff:)?(192\.0\.2|198\.51\.100|203\.0\.113)\.)/i;
export function swarmHitOf(ip: string | undefined, ua: string): SwarmHit | null {
  if (!ip || NOT_ROUTED.test(ip)) return null;
  const nw = networkOf(ip);
  return { ua, country: countryOf(ip), net: netOf(ip, nw?.asn), netName: nw ? `${nw.name} (AS${nw.asn})` : null, addr: addrOf(ip) };
}

export type SwarmAct = 'challenge' | 'member' | 'pass' | null;
export type SwarmWho = { admin: boolean; verifiedCrawler: boolean; verifiedAccount: boolean; signedIn: boolean; pass: boolean; counted: boolean; page?: boolean };
/**
 * one page / API request in the web process: 'challenge' = answer 429 + the Quick check; 'member' = a swarm's request
 * that is not refused (a route never counted, a signed-in account without a confirmed email): stored data, locked
 * predictions, not a visit; 'pass' = a pass holder in a swarm (its own hourly limit only); null = not a swarm.
 */
export function swarmCheck(hit: SwarmHit | null, w: SwarmWho): { act: SwarmAct; v: SwarmVerdict | null } {
  if (!hit || w.admin || w.verifiedCrawler) return { act: null, v: null };
  try {
    const exempt = w.verifiedAccount || w.pass;
    const v = swarms.note(hit, { request: w.counted, view: !!w.page });
    if (exempt) swarms.note(hit, { human: true }); // after the verdict: a pass holder in a swarm keeps its own limit
    if (!v.swarm) return { act: null, v };
    if (w.pass) return { act: 'pass', v };
    if (exempt) return { act: null, v };
    if (!w.counted || w.signedIn) return { act: 'member', v };
    return { act: 'challenge', v };
  } catch { return { act: null, v: null }; } // counting never breaks a request
}

/** the challenge was sent; `wrong` = a second look says it should not have been (trusted, or a listed search engine) */
export function swarmRefused(hit: SwarmHit, wrong: boolean) {
  try {
    swarms.refused(hit, wrong);
    if (wrong) logger.warn(`swarm: a trusted user-agent or a verified search engine got the challenge (${hit.ua.slice(0, 120)})`);
  } catch { /* never breaks a request */ }
}
/** this group is a swarm now (the Quick check page names the reason) */
export const swarmVerdictOf = (hit: SwarmHit) => { try { return swarms.verdict(hit).swarm; } catch { return false; } };
export const swarmTrusted = (ua: string) => swarms.verdict({ ua, country: null, net: '-', addr: '-' }).trusted;

/**
 * the seen beacon: human = visible 5+ s and used, not headless, and the address's first page of the hour 4+ s before
 * (a beacon sent straight away by a script does not count); headless = webdriver or no languages
 */
export function swarmSeen(hit: SwarmHit | null, b: { visibleMs?: unknown; interacted?: unknown; webdriver?: unknown; languages?: unknown }, skip: boolean): SwarmVerdict | null {
  if (!hit || skip) return null;
  try {
    const headless = !!b.webdriver || !Number(b.languages);
    const human = !headless && Number(b.visibleMs) >= 5000 && !!b.interacted && swarms.seenFor(hit, 4000);
    return swarms.note(hit, { human, headless });
  } catch { return null; }
}
/** a browser of this group passed the Quick check: a human sign for its address */
export function swarmPassed(hit: SwarmHit | null) {
  if (hit) try { swarms.note(hit, { human: true }); } catch { /* never breaks a request */ }
}

/** Admin → Visitors → Swarms (live, from the web process's memory) */
export const swarmRows = (): SwarmRow[] => { try { return swarms.rows(); } catch { return []; } };

// ---------- every minute: the rows and holds to the database (web → worker) ----------
const upDay = deferred(`INSERT OR REPLACE INTO swarm_days (day, ua, text, state, refused, wrong, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const upLive = deferred(`INSERT OR REPLACE INTO swarm_live (k, data, at) VALUES (?, ?, ?)`);
function flush() {
  try {
    const at = new Date().toISOString(), day = at.slice(0, 10);
    for (const r of swarms.rows(50)) upDay.run(day, r.ua, r.text, r.state, r.refused, r.wrong, JSON.stringify(r), at);
    upLive.run('holds', JSON.stringify(swarms.holds()), at);
    swarms.prune();
    if (!isWeb) db.prepare(`DELETE FROM swarm_days WHERE day < ?`).run(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  } catch (e: any) { logger.warn(`swarm flush: ${e?.message || e}`); }
}
if (!isWorker) every('swarm flush', flush, 60 * 1000).unref();

// ---------- worker: overrides, data health, the 07:00 line ----------

/** "Always challenge" / "Trust" / back to the rules (mode null) for one user-agent; applied in the web process at once */
export function setSwarmOverride(ua: string, mode: SwarmOverride | null, by: string | null): OverrideRow[] {
  if (!/^[0-9a-f]{16}$/.test(ua)) throw new Error('bad user-agent key');
  if (mode === null) db.prepare(`DELETE FROM swarm_overrides WHERE ua = ?`).run(ua);
  else {
    const text = (db.prepare(`SELECT text FROM swarm_days WHERE ua = ? ORDER BY day DESC LIMIT 1`).get(ua) as any)?.text ?? null;
    db.prepare(`INSERT OR REPLACE INTO swarm_overrides (ua, mode, text, by, at) VALUES (?, ?, ?, ?, ?)`).run(ua, mode, text, by, new Date().toISOString());
  }
  const list = loadOverrides();
  applyState(OVERRIDES_KEY, list); // this process + the web process (IPC)
  return list;
}
export const swarmOverrides = loadOverrides;

/** the rows the web wrote in the last `minutes` (today's), parsed */
function recentRows(minutes: number): (SwarmRow & { at: string })[] {
  try {
    const since = new Date(Date.now() - minutes * 60000).toISOString();
    return (db.prepare(`SELECT data, at FROM swarm_days WHERE at >= ? ORDER BY at DESC`).all(since) as any[])
      .map(r => ({ ...JSON.parse(r.data), at: r.at }));
  } catch { return []; }
}

/** data health "Scraper swarms": yellow while one is challenged (the biggest named), red if a trusted group or a verified engine got it (7 days) */
export function swarmHealth(): { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items?: string[] } {
  const label = 'Scraper swarms';
  try {
    const wrong = (db.prepare(`SELECT COALESCE(SUM(wrong), 0) n FROM swarm_days WHERE day >= ?`).get(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)) as any).n as number;
    const seen = new Set<string>();
    const rows = recentRows(15).filter(r => !seen.has(r.ua) && seen.add(r.ua));
    const on = rows.filter(r => r.state === 'challenged').sort((a, b) => b.addresses - a.addresses);
    const line = (r: SwarmRow) => `${r.text.slice(0, 90)} · ${r.countries.map(c => c.cc).slice(0, 3).join(', ') || '??'} · ${r.addresses.toLocaleString('en-US')} addresses, ${r.requests.toLocaleString('en-US')} requests today · ${r.humanShare}% human · ${r.refused.toLocaleString('en-US')} challenged`;
    if (wrong > 0) return { id: 'scraper-swarms', label, level: 'fail', detail: `${wrong} request(s) from a trusted user-agent or a verified search engine got the swarm challenge in the last 7 days`, items: on.slice(0, 5).map(line) };
    if (on.length) return { id: 'scraper-swarms', label, level: 'warn', detail: `${on.length} swarm${on.length === 1 ? '' : 's'} challenged now — the biggest: ${line(on[0])}`, items: on.slice(1, 6).map(line) };
    return { id: 'scraper-swarms', label, level: 'ok', detail: rows.length ? `No swarm challenged; ${rows.length} user-agent(s) watched` : 'No swarm challenged' };
  } catch (e: any) { return { id: 'scraper-swarms', label, level: 'warn', detail: `Check failed: ${e?.message || e}` }; }
}

/** the 07:00 summary's line: groups challenged and requests refused in the last 24 hours */
export function swarmSummary(): string | null {
  const latest = new Map<string, { refused24h: number }>();
  for (const r of recentRows(24 * 60)) if (!latest.has(r.ua)) latest.set(r.ua, r);
  return swarmSummaryLine([...latest.values()]);
}
addSummaryLine(() => { const t = swarmSummary(); return t ? { area: 'Scraper swarms', title: t, href: adminUrl('users') } : null; });

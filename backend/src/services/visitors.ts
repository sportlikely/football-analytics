import crypto from 'crypto';
import type express from 'express';
import { db } from '../db';
import { isWeb } from './role';
import { deferred } from './deferredWrites';
import { countryOf, geoStatus } from './geo';
import { dataCentreOf, asnStatus } from './asn';
import { every } from './perf';
import { isFakeCrawler } from './crawlerIps';
import { onState, publishState } from './shared';
import { inThread, threadJobsOn } from './threadJob';
import { visitorDbSummary } from './visitorSummary';

/**
 * Visitor counts for the admin page (Oct 2026): who is on the site now, and unique visitors per day / 7 / 30 days.
 * A visitor is one IP address. IPs are never stored: only a salted hash and the visitor's country (services/geo.ts),
 * and rows older than 90 days are deleted.
 * Admins, maintenance tokens and bots are not counted.
 *
 * fix183: people only. Every API caller is still recorded (the old number, "all API callers", kept for a week to
 * compare), but a visitor counts as a person only when the browser sends the "seen" beacon (POST /api/visit/seen: the
 * page was visible 5+ s and there was a scroll, click, key or touch) or is signed in. Never people: user-agents that
 * say they are bots, search-engine crawlers (verified or fake: fix173's DNS check), data-centre networks (asn.ts) and
 * headless browsers (navigator.webdriver, no languages). The reason a caller was not counted is kept per day.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    day TEXT NOT NULL, vid TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, signed_in INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (day, vid)
  );
  CREATE TABLE IF NOT EXISTS visit_salt (id INTEGER PRIMARY KEY CHECK (id = 1), salt TEXT NOT NULL);
`);
// Oct 2026: visitor country (2-letter code from services/geo.ts; the IP itself is never stored)
// fix183: human = 1 once the browser beacon (or a sign-in) shows a person; bot = why it is not one ('ua', 'crawler',
// 'fake-crawler', 'datacentre', 'headless'); ua_bot = 1 for a bot user-agent (left out of the old "all callers" number)
{
  const cols = new Set((db.prepare('PRAGMA table_info(visits)').all() as any[]).map(c => c.name));
  if (!cols.has('country')) db.exec('ALTER TABLE visits ADD COLUMN country TEXT');
  if (!cols.has('human')) db.exec('ALTER TABLE visits ADD COLUMN human INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('bot')) db.exec('ALTER TABLE visits ADD COLUMN bot TEXT');
  if (!cols.has('ua_bot')) db.exec('ALTER TABLE visits ADD COLUMN ua_bot INTEGER NOT NULL DEFAULT 0');
}
db.exec(`CREATE TABLE IF NOT EXISTS visit_meta (k TEXT PRIMARY KEY, v TEXT)`);
// fix230: which league pages a visitor opened (the hashed visitor id, as in visits; 90 days): data health orders the
// leagues still missing season-forecast rules by their visitors
db.exec(`CREATE TABLE IF NOT EXISTS league_visits (day TEXT NOT NULL, sport TEXT NOT NULL, code TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, sport, code, vid))`);
db.prepare(`INSERT OR IGNORE INTO visit_meta (k, v) VALUES ('people_since', ?)`).run(new Date().toISOString().slice(0, 10));

function salt(): string {
  const row = db.prepare('SELECT salt FROM visit_salt WHERE id = 1').get();
  if (row?.salt) return row.salt;
  const s = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT OR IGNORE INTO visit_salt (id, salt) VALUES (1, ?)').run(s);
  return db.prepare('SELECT salt FROM visit_salt WHERE id = 1').get().salt;
}
const SALT = process.env.VISITOR_SALT || salt();
const hash = (ip: string) => crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 32);

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|curl|wget|python|axios|node-fetch|headless|lighthouse/i;
const ONLINE_MS = 5 * 60000;
/** everyone calling the API in the last minutes; human = shown to be a person (beacon or signed in) */
const online = new Map<string, { at: number; signedIn: boolean; human: boolean }>();
const written = new Map<string, number>(); // vid|day → last DB write (at most once a minute per visitor)

// fix210b: written by the worker (the web process queues them: services/deferredWrites.ts)
const upsert = deferred(`
  INSERT INTO visits (day, vid, hits, signed_in, first_seen, last_seen, country, human, bot, ua_bot) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(day, vid) DO UPDATE SET hits = hits + 1, signed_in = MAX(signed_in, excluded.signed_in), last_seen = excluded.last_seen,
    country = COALESCE(excluded.country, country), human = MAX(human, excluded.human), bot = COALESCE(bot, excluded.bot),
    ua_bot = MAX(ua_bot, excluded.ua_bot)
`);
const markHuman = deferred(`UPDATE visits SET human = 1, bot = NULL WHERE day = ? AND vid = ?`);
const markBot = deferred(`UPDATE visits SET bot = ? WHERE day = ? AND vid = ? AND human = 0`);
const leagueHit = deferred(`INSERT OR IGNORE INTO league_visits (day, sport, code, vid) VALUES (?, ?, ?, ?)`);
const leagueSeen = new Map<string, number>(); // vid|day|sport|code → written
/** fix230: the API call every league page makes (its table) → the league */
function leaguePageOf(path: string): { sport: string; code: string } | null {
  let m = /^\/leagues\/([A-Za-z0-9]{1,12})\/standings$/.exec(path);
  if (m) return { sport: 'football', code: m[1] };
  m = /^\/basketball\/standings\/([A-Za-z0-9]{2,8})$/.exec(path);
  if (m) return { sport: 'basketball', code: m[1] };
  if (path === '/nfl/standings') return { sport: 'nfl', code: 'NFL' };
  return null;
}

/** Express middleware: counts every caller of the API (the site calls it on every page); people are told apart later. */
export function trackVisit(req: express.Request, _res: express.Response, next: express.NextFunction) {
  try {
    const ua = req.get('user-agent') || '';
    if (req.access === 'admin' || req.query.token || req.path.startsWith('/admin') || req.path === '/visit/seen') return next();
    const ip = req.ip || '';
    if (!ip) return next();
    const uaBot = !ua || BOT.test(ua);
    const vid = hash(ip);
    const now = Date.now();
    // fix183 rule 4: signed-in visitors are always people
    const signedIn = !!req.user && !uaBot;
    const prev = online.get(vid);
    online.set(vid, { at: now, signedIn: signedIn || !!prev?.signedIn, human: signedIn || !!prev?.human });
    const day = new Date(now).toISOString().slice(0, 10);
    const k = `${vid}|${day}`;
    if ((written.get(k) || 0) < now - 60000) {
      written.set(k, now);
      const iso = new Date(now).toISOString();
      const dc = uaBot ? null : dataCentreOf(ip);
      // fix262b: a search-engine user-agent from a data-centre network, not verified = a fake crawler (not Google)
      const sl = (req as any).slCrawler;
      const fake = isFakeCrawler(ua, ip, sl?.ok ? sl.how : null);
      upsert.run(day, vid, signedIn ? 1 : 0, iso, iso, countryOf(ip), signedIn ? 1 : 0, fake ? 'fake-crawler' : uaBot ? 'ua' : dc ? 'datacentre' : null, uaBot ? 1 : 0);
    }
    const lp = uaBot ? null : leaguePageOf(req.path);
    if (lp) {
      const lk = `${k}|${lp.sport}|${lp.code}`;
      if (!leagueSeen.has(lk)) { leagueSeen.set(lk, now); leagueHit.run(day, lp.sport, lp.code, vid); }
    }
  } catch { /* counting never breaks a request */ }
  next();
}

/**
 * fix183: the browser's "seen" beacon — counted as a person only when nothing says otherwise. `crawler`: the request's
 * crawler verdict from index.ts (fix173: true = verified search engine, false = fake crawler, null = not a crawler UA).
 */
export function visitSeen(req: express.Request, crawler: boolean | null): { counted: boolean; reason?: string } {
  const ip = req.ip || '';
  const ua = req.get('user-agent') || '';
  if (!ip || req.access === 'admin') return { counted: false, reason: 'not counted' };
  const b = (req.body || {}) as { token?: string; visibleMs?: number; interacted?: boolean; webdriver?: boolean; languages?: number; plugins?: number };
  if (typeof b.token !== 'string' || !/^[a-z0-9]{12,40}$/i.test(b.token)) return { counted: false, reason: 'no token' };
  const vid = hash(ip);
  const day = new Date().toISOString().slice(0, 10);
  const reason = !ua || BOT.test(ua) ? 'ua'
    : crawler === true ? 'crawler'
    : crawler === false ? 'fake-crawler'
    : dataCentreOf(ip) ? 'datacentre'
    : b.webdriver || !Number(b.languages) ? 'headless'
    : !(Number(b.visibleMs) >= 5000) || !b.interacted ? 'no-signs'
    : null;
  try {
    if (reason) {
      if (reason !== 'no-signs') markBot.run(reason, day, vid);
      return { counted: false, reason };
    }
    const now = Date.now(), iso = new Date(now).toISOString();
    // a row exists when the page called the API first (it always does); else one is made
    upsert.run(day, vid, req.user ? 1 : 0, iso, iso, countryOf(ip), 1, null, 0);
    markHuman.run(day, vid);
    const prev = online.get(vid);
    online.set(vid, { at: now, signedIn: !!req.user || !!prev?.signedIn, human: true });
  } catch { return { counted: false, reason: 'error' }; }
  return { counted: true };
}

every('visitors flush', () => {
  const now = Date.now();
  for (const [k, v] of online) if (v.at < now - ONLINE_MS) online.delete(k);
  for (const [k, t] of written) if (t < now - 2 * 86400000) written.delete(k);
  for (const [k, t] of leagueSeen) if (t < now - 2 * 86400000) leagueSeen.delete(k);
}, 60000).unref();
if (!isWeb) every('visitors cleanup', () => {
  try { db.prepare("DELETE FROM visits WHERE day < date('now', '-90 days')").run(); } catch { /* ignore */ }
  try { db.prepare("DELETE FROM league_visits WHERE day < date('now', '-90 days')").run(); } catch { /* ignore */ }
}, 6 * 3600000).unref();

const since = (days: number) => new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

/*
 * fix273: Admin → Visitors is a stored string. The worker builds the database part every 5 min in a job thread
 * (services/visitorSummary.ts) with the day's "Who" and search-engine numbers (the rows the web process writes every
 * minute), publishes it ('visitors:summary'), and the web process only sends it with its own live numbers spliced in
 * (who is online now: the web's memory; the country / network lists it loaded). It ran on the web thread on every
 * poll: 13–23 s a call on 29 Oct 04:38–05:21 UTC, the whole site frozen while an admin tab was open.
 */
type Summary = { text: string; at: string; ms: number };
let summary: Summary | null = null;
export const SUMMARY_KEY = 'visitors:summary';
onState(SUMMARY_KEY, (_k, v) => { summary = v as Summary; });
/** worker: the summary now (job thread when there is one), stored + published */
export async function refreshVisitorSummary(): Promise<Summary> {
  const t0 = Date.now();
  const base = threadJobsOn()
    ? await inThread<ReturnType<typeof visitorDbSummary>>('visitors summary', [], 5 * 60 * 1000)
    : visitorDbSummary();
  const { whoOfDay } = await import('./proxyScrapers');
  const { crawlerReport } = await import('./crawlerIps');
  const body = { ...base, who: whoOfDay(), crawlers: crawlerReport(), builtAt: new Date().toISOString() };
  summary = { text: JSON.stringify(body), at: body.builtAt, ms: Date.now() - t0 };
  publishState(SUMMARY_KEY, summary);
  return summary;
}
/** web: GET /api/admin/visitors — the stored string + the live part (online now, the lists loaded here); no query here */
export function visitorsAnswer(): string {
  const now = Date.now();
  let onlineNow = 0, onlineSignedIn = 0, onlineAll = 0;
  for (const v of online.values()) if (v.at >= now - ONLINE_MS) { onlineAll++; if (v.human) onlineNow++; if (v.signedIn) onlineSignedIn++; }
  const live = JSON.stringify({ onlineNow, onlineSignedIn, onlineAll, onlineWindowMin: ONLINE_MS / 60000, datacentre: asnStatus(), geo: geoStatus() });
  if (!summary?.text?.startsWith('{')) return `{"data":${live.slice(0, -1)},"pending":true}}`;
  return `{"data":${live.slice(0, -1)},${summary.text.slice(1)}}`;
}

/** fix230: people (beacon or signed in) who opened each league's page in the last `days` days: 'sport|code' → count */
export function leagueVisitors(days = 30): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const r of db.prepare(`SELECT lv.sport, lv.code, COUNT(DISTINCT lv.vid) n FROM league_visits lv JOIN visits v ON v.day = lv.day AND v.vid = lv.vid AND v.human = 1
      WHERE lv.day >= ? GROUP BY lv.sport, lv.code`).all(since(days)) as any[]) out.set(`${r.sport}|${r.code}`, r.n);
  } catch { /* not there yet */ }
  return out;
}

import crypto from 'crypto';
import type express from 'express';
import { db } from '../db';
import { isWeb } from './role';
import { deferred } from './deferredWrites';
import { countryOf, geoStatus } from './geo';
import { dataCentreOf, asnStatus } from './asn';
import { every } from './perf';

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
db.prepare(`INSERT OR IGNORE INTO visit_meta (k, v) VALUES ('people_since', ?)`).run(new Date().toISOString().slice(0, 10));
const peopleSince = (): string => (db.prepare(`SELECT v FROM visit_meta WHERE k = 'people_since'`).get() as any)?.v || '';

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
      upsert.run(day, vid, signedIn ? 1 : 0, iso, iso, countryOf(ip), signedIn ? 1 : 0, uaBot ? 'ua' : dc ? 'datacentre' : null, uaBot ? 1 : 0);
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
}, 60000).unref();
if (!isWeb) every('visitors cleanup', () => {
  try { db.prepare("DELETE FROM visits WHERE day < date('now', '-90 days')").run(); } catch { /* ignore */ }
}, 6 * 3600000).unref();

const since = (days: number) => new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
// people: shown by the beacon or signed in; all callers (the old number): every caller without a bot user-agent
const PEOPLE = `(human = 1 OR signed_in = 1)`;

export function visitorStats() {
  const now = Date.now();
  let onlineNow = 0, onlineSignedIn = 0, onlineAll = 0;
  for (const v of online.values()) if (v.at >= now - ONLINE_MS) { onlineAll++; if (v.human) onlineNow++; if (v.signedIn) onlineSignedIn++; }
  const count = (days: number, where: string) => db.prepare(`SELECT COUNT(DISTINCT vid) AS n FROM visits WHERE day >= ? AND ${where}`).get(since(days)).n as number;
  const uniq = (days: number) => count(days, PEOPLE);
  const all = (days: number) => count(days, 'ua_bot = 0');
  const daily = db.prepare(`
    SELECT day, SUM(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS visitors, SUM(signed_in) AS signedIn, SUM(hits) AS hits,
      SUM(CASE WHEN ${PEOPLE} THEN 0 ELSE 1 END) AS bots, SUM(CASE WHEN ua_bot = 0 THEN 1 ELSE 0 END) AS allCallers
    FROM visits WHERE day >= ? GROUP BY day ORDER BY day
  `).all(since(30)) as { day: string; visitors: number; signedIn: number; hits: number; bots: number; allCallers: number }[];
  const returning = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT vid FROM visits WHERE day >= ? AND ${PEOPLE} GROUP BY vid HAVING COUNT(*) > 1)`).get(since(30)).n as number;
  const first = db.prepare('SELECT MIN(day) AS d FROM visits').get()?.d || null;
  const botReasons = db.prepare(`SELECT COALESCE(bot, 'no-signs') AS reason, COUNT(*) AS n FROM visits WHERE day = ? AND NOT ${PEOPLE} GROUP BY COALESCE(bot, 'no-signs') ORDER BY n DESC`).all(since(1)) as { reason: string; n: number }[];
  // visitors by country (one row per visitor: the country of their latest day); people and filtered callers apart
  const byCountry = (days: number) => db.prepare(`
    SELECT COALESCE(country, '??') AS country, SUM(person) AS visitors, SUM(signed) AS signedIn, SUM(1 - person) AS bots FROM (
      SELECT vid, MAX(signed_in) AS signed, MAX(CASE WHEN ${PEOPLE} THEN 1 ELSE 0 END) AS person,
        (SELECT v2.country FROM visits v2 WHERE v2.vid = v.vid AND v2.day >= ? AND v2.country IS NOT NULL ORDER BY v2.day DESC LIMIT 1) AS country
      FROM visits v WHERE day >= ? AND ua_bot = 0 GROUP BY vid
    ) GROUP BY COALESCE(country, '??') ORDER BY visitors DESC, bots DESC`).all(since(days), since(days)) as { country: string; visitors: number; signedIn: number; bots: number }[];
  const countriesSince = db.prepare('SELECT MIN(day) AS d FROM visits WHERE country IS NOT NULL').get()?.d || null;
  return {
    onlineNow, onlineSignedIn, onlineAll, onlineWindowMin: ONLINE_MS / 60000,
    today: uniq(1), last7: uniq(7), last30: uniq(30), returning30: returning,
    // fix183: what was filtered today and the old number (every API caller without a bot user-agent), for a week
    todayBots: count(1, `NOT ${PEOPLE}`), todayAll: all(1), last7All: all(7), last30All: all(30), botReasons,
    peopleSince: peopleSince(), datacentre: asnStatus(),
    daily, countingSince: first,
    countries: { last7: byCountry(7), last30: byCountry(30), since: countriesSince, geo: geoStatus() }
  };
}

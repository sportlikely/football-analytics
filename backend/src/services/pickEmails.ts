/**
 * fix216: the daily picks email and the weekly digest — opt-in only, every sport, 7 languages, sent with Resend.
 *
 * Consent (Account → Emails, or the sign-up checkbox): two switches, "Daily picks" and "Weekly digest", off unless the
 * person turns them on; each change is stored with its time and source (email_prefs + email_consent_log). Settings:
 * sports, send hour in the person's own time zone (from the browser, editable), language = the site language.
 * One-click unsubscribe: List-Unsubscribe + List-Unsubscribe-Post headers, a signed footer link (no login) and a
 * "manage emails" link. Unsubscribed = both switches off; nothing is sent until the person turns one back on.
 *
 * Daily (picksEmailTick, worker job every 5 min, never the web process): at the person's send hour, the games of the
 * next 24 h in their sports — up to 5 strong picks (highest first), then their favourite teams' games, 10 rows at most;
 * nothing worth sending (no strong pick, no favourite playing) = no email, a "skipped" row with the reason. A line on
 * top: "Yesterday: 7 of 9 picks right" from the public record's own rows (same numbers as the site).
 * Weekly (Monday, same hour): last week's record per sport, the best call, the week's 5 biggest games, the favourite
 * teams' next games. Free and Premium see the 3 strongest picks (plus games they unlocked), Pro everything; a hidden
 * pick is never in the email (not even blurred text) — the row says "Unlock with Pro".
 *
 * Sending: batches of 50 with a pause, ~1.6 a second (Resend's limit is 2), retries on 429 / 5xx. Every send is logged
 * (user, kind, day, status, provider id) — never the body. Resend webhooks (svix-signed, RESEND_WEBHOOK_SECRET):
 * bounces and complaints stop the address (email_suppressed), opens and clicks are counted. No odds, no bookmakers,
 * no betting words; the footer carries the site's 18+ / responsible-use line. Words: locales/email/<lang>.json.
 */
import { alertOncePerDay, adminUrl, israelTime } from './adminMail';
import crypto from 'crypto';
import { pubPath } from './slugs';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { db } from '../db';
import logger from '../utils/logger';
import { sendMail, emailEnabled, esc, SITE } from './email';
import { userById, accessOf, canSeeFull, type User, type Access } from './auth';
import { unlockedIds } from './billing';
import { listFavorites } from './favorites';
import { footballTeamIds, mainModelRank } from './calendar';
import { publicRecord } from './tracking';
import { bbRecord, isPreseason } from './bbModel';
import { nflAccuracy, nflRecord } from './nflModel';
import { strongLineOf } from './afCalibState';
import { bbStrongLine } from './sportCalibration';
import { bbPublic } from './bbSite';
import { nflPublic } from './nflSite';
import { doubleChance, DC_STRONG, type DC } from '../utils/doubleChance';
import { heavy, yieldLoop } from './perf';
import { deferred } from './deferredWrites';
import type { Check } from './dataHealth';
import de from '../locales/email/de.json';
import es from '../locales/email/es.json';
import fr from '../locales/email/fr.json';
import it from '../locales/email/it.json';
import pt from '../locales/email/pt.json';
import trLang from '../locales/email/tr.json';
import idLang from '../locales/email/id.json';
import hiLang from '../locales/email/hi.json';
import plLang from '../locales/email/pl.json';
import elLang from '../locales/email/el.json';
import ruLang from '../locales/email/ru.json';
import ar from '../locales/email/ar.json';
import he from '../locales/email/he.json';
import { LANG_LOCALE, isRtl } from '../utils/langs';

db.exec(`
  CREATE TABLE IF NOT EXISTS email_prefs (
    user_id       INTEGER PRIMARY KEY,
    news          INTEGER NOT NULL DEFAULT 0,
    news_at       TEXT,
    news_source   TEXT,
    daily         INTEGER NOT NULL DEFAULT 0,
    daily_at      TEXT,
    daily_source  TEXT,
    weekly        INTEGER NOT NULL DEFAULT 0,
    weekly_at     TEXT,
    weekly_source TEXT,
    sports        TEXT NOT NULL DEFAULT 'football,basketball,american-football,tennis',
    send_hour     INTEGER NOT NULL DEFAULT 8,
    tz            TEXT NOT NULL DEFAULT 'UTC',
    lang          TEXT NOT NULL DEFAULT 'en',
    updated_at    TEXT NOT NULL
  );
  -- every consent change: which switch, on / off, when, from where (signup, account, unsubscribe link, one-click, complaint)
  CREATE TABLE IF NOT EXISTS email_consent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, on_ INTEGER NOT NULL, source TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_consent_user ON email_consent_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_email_consent_at ON email_consent_log(at);
  -- one row per person, kind and local day: sent / failed / skipped (with the reason). No email body is stored.
  CREATE TABLE IF NOT EXISTS email_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL,
    status TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 1, provider_id TEXT,
    opened_at TEXT, clicked_at TEXT, bounced INTEGER NOT NULL DEFAULT 0, complained INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, kind, day)
  );
  CREATE INDEX IF NOT EXISTS idx_email_sends_at ON email_sends(at);
  CREATE INDEX IF NOT EXISTS idx_email_sends_provider ON email_sends(provider_id);
  -- addresses that bounced (hard) or complained: never sent a picks email again
  CREATE TABLE IF NOT EXISTS email_suppressed (email TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
  -- webhook events per UTC day (delivered, bounced, complained, opened, clicked)
  CREATE TABLE IF NOT EXISTS email_events (day TEXT NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, type));
`);

const DAY = 86400000, H = 3600000, MIN = 60000;
const nowIso = () => new Date().toISOString();

/* ---------- words ---------- */

export const EMAIL_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'tr', 'id', 'hi', 'pl', 'el', 'ru', 'ar', 'he'] as const;
export type EmailLang = (typeof EMAIL_LANGS)[number];
export const asEmailLang = (x: unknown): EmailLang => ((EMAIL_LANGS as readonly string[]).includes(String(x)) ? (x as EmailLang) : 'en');
export const EMAIL_PACKS: Record<EmailLang, Record<string, string>> = { en: {}, de, es, fr, it, pt, tr: trLang, id: idLang, hi: hiLang, pl: plLang, el: elLang, ru: ruLang, ar, he };
const LOCALES: Record<EmailLang, string> = LANG_LOCALE;
/** `tx(key, a, b)`: the language's words for an English key, {0}, {1} filled (English is the key, like the site) */
export function words(lang: EmailLang) {
  const pack = EMAIL_PACKS[lang];
  return (key: string, ...a: (string | number)[]) => a.reduce<string>((s, v, i) => s.split(`{${i}}`).join(String(v)), pack[key] ?? key);
}

/* ---------- sports ---------- */

export const EMAIL_SPORTS = ['football', 'basketball', 'american-football', 'tennis'] as const;
export type ESport = (typeof EMAIL_SPORTS)[number];
const tennisSite = (): typeof import('./tennisSite') => require('./tennisSite'); // the tennis pages pull in the tennis model: loaded when needed
/** a sport is in the emails once its site is open (admins get every sport, like the pages) */
export const sportOpen = (s: ESport, admin = false) =>
  s === 'football' || admin || (s === 'basketball' ? bbPublic() : s === 'american-football' ? nflPublic() : tennisSite().tennisPublic());
export const SPORT_NAME: Record<ESport, string> = { football: 'Football', basketball: 'Basketball', 'american-football': 'American football', tennis: 'Tennis' };

/* ---------- preferences and consent ---------- */

export interface EmailPrefs {
  daily: boolean; weekly: boolean; sports: ESport[]; sendHour: number; tz: string; lang: EmailLang
  dailyAt: string | null; dailySource: string | null; weeklyAt: string | null; weeklySource: string | null
  /** fix218: "Product news" — new features and Premium news, a few times a year (off by default) */
  news: boolean; newsAt: string | null; newsSource: string | null
}
export const validTz = (tz: unknown): tz is string => {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
};
const asSports = (x: unknown): ESport[] => {
  const list = (Array.isArray(x) ? x : String(x || '').split(',')).map(s => String(s).trim()).filter((s): s is ESport => (EMAIL_SPORTS as readonly string[]).includes(s));
  return [...new Set(list)];
};
const DEFAULTS = { daily: 0, weekly: 0, news: 0, sports: EMAIL_SPORTS.join(','), send_hour: 8, tz: 'UTC', lang: 'en' };
const rowToPrefs = (r: any): EmailPrefs => ({
  daily: !!r.daily, weekly: !!r.weekly, sports: asSports(r.sports), sendHour: Number(r.send_hour) || 0, tz: validTz(r.tz) ? r.tz : 'UTC', lang: asEmailLang(r.lang),
  dailyAt: r.daily_at || null, dailySource: r.daily_source || null, weeklyAt: r.weekly_at || null, weeklySource: r.weekly_source || null,
  news: !!r.news, newsAt: r.news_at || null, newsSource: r.news_source || null
});
// fix218: the column on a database made before this version; then the old "Email updates" switch (users.marketing_opt_in,
// "new features, Premium news and weekly picks") folds into these: whoever had it on keeps the weekly digest on (that was
// the consent given), once; the "product news" part is a new switch, off for everyone until turned on
try { if (!(db.prepare(`PRAGMA table_info(email_prefs)`).all() as any[]).some(c => c.name === 'news')) db.exec(`ALTER TABLE email_prefs ADD COLUMN news INTEGER NOT NULL DEFAULT 0; ALTER TABLE email_prefs ADD COLUMN news_at TEXT; ALTER TABLE email_prefs ADD COLUMN news_source TEXT`); } catch { /* read-only copy */ }
export function migrateMarketingOptIn(): number {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    if (db.prepare(`SELECT 1 FROM app_secrets WHERE name = 'fix218-email-updates'`).get()) return 0;
    const users = db.prepare(`SELECT id, marketing_opt_in_at FROM users WHERE marketing_opt_in = 1`).all() as any[];
    let n = 0;
    for (const u of users) {
      const cur = db.prepare(`SELECT weekly, weekly_source FROM email_prefs WHERE user_id = ?`).get(u.id) as any;
      if (cur && (cur.weekly || cur.weekly_source === 'account' || cur.weekly_source === 'unsubscribe-link' || cur.weekly_source === 'one-click' || cur.weekly_source === 'complaint')) continue; // chose already, or turned it off themselves
      saveEmailPrefs(u.id, { weekly: true }, 'migrated');
      n++;
    }
    db.prepare(`INSERT OR REPLACE INTO app_secrets (name, value) VALUES ('fix218-email-updates', ?)`).run(`${n} at ${nowIso()}`);
    if (n) logger.info(`emails: ${n} account(s) with the old "Email updates" switch on now have the weekly digest on`);
    return n;
  } catch (e: any) { logger.warn(`emails: marketing opt-in migration: ${e?.message || e}`); return 0; }
}
export function emailPrefs(userId: number): EmailPrefs {
  return rowToPrefs(db.prepare(`SELECT * FROM email_prefs WHERE user_id = ?`).get(userId) || DEFAULTS);
}

export class EmailPrefsError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export type ConsentSource = 'signup' | 'account' | 'unsubscribe-link' | 'one-click' | 'complaint' | 'admin' | 'migrated';

/**
 * Save the settings. Only the fields given change; a switch that changes is logged with its time and source.
 * Returns the saved settings.
 */
export function saveEmailPrefs(userId: number, input: Partial<{ daily: unknown; weekly: unknown; news: unknown; sports: unknown; sendHour: unknown; tz: unknown; lang: unknown }>, source: ConsentSource): EmailPrefs {
  const cur = emailPrefs(userId);
  const at = nowIso();
  const next = { ...cur };
  if (input.daily !== undefined) next.daily = input.daily === true;
  if (input.weekly !== undefined) next.weekly = input.weekly === true;
  if (input.news !== undefined) next.news = input.news === true;
  if (input.sports !== undefined) {
    const s = asSports(input.sports);
    if (!s.length) throw new EmailPrefsError(400, 'Choose at least one sport.');
    next.sports = s;
  }
  if (input.sendHour !== undefined) {
    const h = Number(input.sendHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new EmailPrefsError(400, 'Choose a send time between 00:00 and 23:00.');
    next.sendHour = h;
  }
  if (input.tz !== undefined) {
    if (!validTz(input.tz)) throw new EmailPrefsError(400, 'Unknown time zone.');
    next.tz = input.tz as string;
  }
  if (input.lang !== undefined) next.lang = asEmailLang(input.lang);
  const log = db.prepare(`INSERT INTO email_consent_log (user_id, at, kind, on_, source) VALUES (?, ?, ?, ?, ?)`);
  const exists = !!db.prepare(`SELECT 1 FROM email_prefs WHERE user_id = ?`).get(userId);
  // a switch that changes (or is turned on in a new row, e.g. at sign-up) is stored with its time and source
  if (next.daily !== cur.daily || (!exists && next.daily)) { next.dailyAt = at; next.dailySource = source; log.run(userId, at, 'daily', next.daily ? 1 : 0, source); }
  if (next.weekly !== cur.weekly || (!exists && next.weekly)) { next.weeklyAt = at; next.weeklySource = source; log.run(userId, at, 'weekly', next.weekly ? 1 : 0, source); }
  if (next.news !== cur.news || (!exists && next.news)) { next.newsAt = at; next.newsSource = source; log.run(userId, at, 'news', next.news ? 1 : 0, source); }
  db.prepare(`INSERT INTO email_prefs (user_id, daily, daily_at, daily_source, weekly, weekly_at, weekly_source, news, news_at, news_source, sports, send_hour, tz, lang, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET daily = excluded.daily, daily_at = excluded.daily_at, daily_source = excluded.daily_source,
      weekly = excluded.weekly, weekly_at = excluded.weekly_at, weekly_source = excluded.weekly_source, news = excluded.news, news_at = excluded.news_at, news_source = excluded.news_source, sports = excluded.sports,
      send_hour = excluded.send_hour, tz = excluded.tz, lang = excluded.lang, updated_at = excluded.updated_at`)
    .run(userId, next.daily ? 1 : 0, next.dailyAt, next.dailySource, next.weekly ? 1 : 0, next.weeklyAt, next.weeklySource, next.news ? 1 : 0, next.newsAt, next.newsSource, next.sports.join(','), next.sendHour, next.tz, next.lang, at);
  return emailPrefs(userId);
}

/** Sign-up: the time zone and language are kept; both switches follow the (unchecked by default) opt-in box. */
export function initEmailPrefs(userId: number, o: { optIn: boolean; tz: unknown; lang: unknown }) {
  saveEmailPrefs(userId, { daily: o.optIn, weekly: o.optIn, tz: validTz(o.tz) ? o.tz : 'UTC', lang: o.lang }, 'signup');
}

/** What the account page shows (the switches, the choices, which sports are open). */
export function emailSettings(user: User) {
  const p = emailPrefs(user.id);
  const sup = db.prepare(`SELECT reason FROM email_suppressed WHERE email = ?`).get(String(user.email).toLowerCase()) as any;
  return {
    daily: p.daily, weekly: p.weekly, news: p.news, sports: p.sports, sendHour: p.sendHour, tz: p.tz, lang: p.lang,
    sportsOpen: EMAIL_SPORTS.filter(s => sportOpen(s, !!user.isAdmin)),
    emailConfirmed: user.emailVerified, enabled: emailEnabled, stopped: sup ? String(sup.reason) : null
  };
}

/** Account deletion / data export helpers (auth.ts calls these through tableExists, no import cycle). */
export function deleteEmailData(userId: number) {
  for (const t of ['email_prefs', 'email_consent_log', 'email_sends']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
}

/* ---------- unsubscribe links (HMAC of the user id, key kept in the database) ---------- */

let UK: Buffer | null = null;
function unsubKey(): Buffer {
  db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  let row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'picks_unsub_key'`).get() as any;
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('picks_unsub_key', ?)`).run(crypto.randomBytes(32).toString('hex'));
    row = db.prepare(`SELECT value FROM app_secrets WHERE name = 'picks_unsub_key'`).get();
  }
  return Buffer.from(row.value, 'hex');
}
export const unsubSig = (userId: number) => crypto.createHmac('sha256', (UK ||= unsubKey())).update(`picks-unsub:${userId}`).digest('base64url').slice(0, 32);
export const picksUnsubUrl = (userId: number) => `${SITE}/api/email/unsubscribe?u=${userId}&t=${unsubSig(userId)}`;
/** The user id a link was signed for, or null. */
export function checkUnsub(u: unknown, t: unknown): number | null {
  const id = parseInt(String(u ?? ''), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const want = unsubSig(id), got = String(t ?? '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
  return id;
}
/** Both switches off (never sent again until the person turns one back on). */
export function unsubscribePicks(u: unknown, t: unknown, source: ConsentSource): boolean {
  const id = checkUnsub(u, t);
  if (!id || !db.prepare(`SELECT 1 FROM users WHERE id = ?`).get(id)) return false;
  saveEmailPrefs(id, { daily: false, weekly: false }, source);
  return true;
}

/* ---------- time zones ---------- */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(tz: string, t: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    if (fmtCache.size > 500) fmtCache.clear();
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}
/** The local day, hour and weekday (0 = Monday) of an instant in a time zone. */
export function localTime(tz: string, t: number) {
  const p = partsIn(tz, t);
  return { day: `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`, hour: p.hour, minute: p.minute, weekday: p.weekday };
}
/** The instant of a local wall-clock time (day YYYY-MM-DD, hour) in a time zone (DST-safe). */
export function zonedTime(tz: string, day: string, hour = 0): number {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(tz, t);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
    const diff = shown - wall;
    if (!diff) break;
    t -= diff;
  }
  return t;
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Which emails are due for these settings now: the send hour has come (and is under 3 hours old), weekly on Monday. */
export function dueKinds(p: Pick<EmailPrefs, 'daily' | 'weekly' | 'sendHour' | 'tz'>, now: number): { day: string; kinds: ('daily' | 'weekly')[] } {
  const lt = localTime(p.tz, now);
  const sendAt = zonedTime(p.tz, lt.day, p.sendHour);
  const kinds: ('daily' | 'weekly')[] = [];
  if (now >= sendAt && now < sendAt + 3 * H) {
    if (p.daily) kinds.push('daily');
    if (p.weekly && lt.weekday === 0) kinds.push('weekly');
  }
  return { day: lt.day, kinds };
}

/* ---------- games with our pick (the next 24 h / 7 days), every sport ---------- */

export interface Cand {
  sport: ESport; id: number; rid: number; start: string; league: string; home: string; away: string
  homeImg: string | null; awayImg: string | null; path: string
  /** football: the double chance; other sports: the winner */
  pick: { k: DC } | { side: 'H' | 'A' }; pct: number; strong: boolean
  teamIds: number[]; size: number
}
const AF_OFFSET = 1_000_000_000;
const tableExists = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
const footballCrest = (id?: number | null) =>
  !id ? null : id >= AF_OFFSET ? `https://media.api-sports.io/football/teams/${id - AF_OFFSET}.png` : `https://crests.football-data.org/${id}.png`;
const FB_OFF = new Set(['PST', 'CANC', 'ABD', 'SUSP', 'INT', 'WO', 'POSTPONED', 'CANCELLED', 'SUSPENDED', 'VOID', 'FINISHED', 'FT', 'AET', 'PEN', 'AWARDED']);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** How big a team is (keep in step with frontend/src/lib/fame.ts): 10 = the biggest clubs and nations, 1 = everyone else. */
const FAME: [RegExp, number][] = [
  [/real madrid|barcelona|manchester united|liverpool|manchester city|bayern|paris saint|juventus|chelsea|arsenal/i, 10],
  [/\bac milan|internazionale|atl[ée]tico de madrid|borussia dortmund|tottenham/i, 9],
  [/napoli|as roma|ajax|benfica|fc porto|sporting clube de portugal|sevilla|leverkusen|marseille|lyonnais|newcastle|aston villa|lazio|atalanta/i, 7],
  [/villarreal|real sociedad|athletic club|leipzig|psv|feyenoord|west ham|everton|monaco|lille|fiorentina|real betis|valencia|eintracht frankfurt|m[öo]nchengladbach|leeds|nottingham|bologna|stuttgart|braga/i, 5],
  [/^(brazil|argentina|france|england|spain|germany|portugal|italy|netherlands)$/i, 10],
  [/^(belgium|croatia|uruguay|colombia|usa|united states|mexico|morocco|japan|denmark|switzerland)$/i, 7],
  [/^(poland|austria|sweden|norway|turkey|t[üu]rkiye|senegal|nigeria|egypt|ukraine|serbia|scotland|wales|czechia|czech republic|korea republic|south korea|ecuador|chile|israel)$/i, 5]
];
const fame = (name: string) => { for (const [re, s] of FAME) if (re.test(name)) return s; return 1; };
const BIG_COMP: Record<string, number> = { CL: 4, WC: 5, EC: 5, PL: 3, PD: 3, BL1: 2, SA: 2, FL1: 2 };

function footballCands(from: string, to: string): Cand[] {
  const rows = db.prepare(`SELECT p.match_id, p.model, p.competition_code, p.competition_name, p.utc_date, p.home_team_id, p.home_team, p.away_team_id, p.away_team,
      p.p_home, p.p_draw, p.p_away, r.status AS rstatus, r.outcome
    FROM predictions p LEFT JOIN results r ON r.match_id = p.match_id WHERE p.utc_date >= ? AND p.utc_date < ? AND p.settled = 0`).all(from, to) as any[];
  const best = new Map<number, any>();
  for (const r of rows) {
    const rank = mainModelRank(r.model, r.utc_date);
    if (rank >= 99) continue; // shadow models are never shown
    const cur = best.get(r.match_id);
    if (!cur || rank < cur.rank) best.set(r.match_id, { ...r, rank });
  }
  const out: Cand[] = [];
  for (const r of best.values()) {
    if (r.outcome || FB_OFF.has(String(r.rstatus || '').toUpperCase())) continue;
    const pc = (v: number) => (v <= 1 ? v * 100 : v);
    const dc = doubleChance(pc(r.p_home), pc(r.p_draw), pc(r.p_away));
    if (!dc) continue;
    const size = Math.max(fame(r.home_team), fame(r.away_team)) + 0.4 * Math.min(fame(r.home_team), fame(r.away_team)) + (BIG_COMP[r.competition_code] || 0);
    out.push({
      sport: 'football', id: r.match_id, rid: r.match_id, start: r.utc_date, league: r.competition_name || r.competition_code || '', home: r.home_team, away: r.away_team,
      homeImg: footballCrest(r.home_team_id), awayImg: footballCrest(r.away_team_id), path: `/match/${r.match_id}`,
      pick: { k: dc.k }, pct: r1(dc.p), strong: dc.p >= DC_STRONG, teamIds: [r.home_team_id, r.away_team_id].filter(Boolean), size
    });
  }
  return out;
}

function basketballCands(from: string, to: string): Cand[] {
  if (!tableExists('bb_games') || !tableExists('bb_predictions')) return [];
  const names = tableExists('bb_leagues') ? new Map((db.prepare(`SELECT code, name FROM bb_leagues`).all() as any[]).map(l => [l.code, l.name])) : new Map();
  const rows = db.prepare(`SELECT g.game_id, g.code, g.kickoff, g.status, g.home_id, g.home_name, g.home_logo, g.away_id, g.away_name, g.away_logo, p.p_home
    FROM bb_games g JOIN bb_predictions p ON p.game_id = g.game_id
    WHERE g.kickoff >= ? AND g.kickoff < ? AND (g.status IS NULL OR g.status = 'NS')`).all(from, to) as any[];
  return rows.filter(r => !isPreseason({ code: r.code, kickoff: r.kickoff })).map(r => {
    const p = Math.max(r.p_home, 1 - r.p_home);
    return {
      sport: 'basketball' as const, id: r.game_id, rid: -r.game_id, start: r.kickoff, league: names.get(r.code) || r.code, home: r.home_name, away: r.away_name,
      homeImg: r.home_logo || null, awayImg: r.away_logo || null, path: `/basketball/game/${r.game_id}`,
      pick: { side: (r.p_home >= 0.5 ? 'H' : 'A') as 'H' | 'A' }, pct: r1(100 * p), strong: p >= bbStrongLine(r.code), // fix222: the league's calibrated line
      teamIds: [r.home_id, r.away_id], size: (r.code === 'NBA' ? 6 : r.code === 'EL' || /euroleague/i.test(names.get(r.code) || '') ? 4 : 1)
    };
  });
}

function nflCands(from: string, to: string): Cand[] {
  if (!tableExists('nfl_games') || !tableExists('nfl_predictions')) return [];
  const other = tableExists('nfl_teams') ? `AND g.home_id NOT IN (SELECT team_id FROM nfl_teams WHERE level = 'other') AND g.away_id NOT IN (SELECT team_id FROM nfl_teams WHERE level = 'other')` : '';
  const rows = db.prepare(`SELECT g.game_id, g.league, g.kickoff, g.home_id, g.home_name, g.home_logo, g.away_id, g.away_name, g.away_logo, p.p_home
    FROM nfl_games g JOIN nfl_predictions p ON p.game_id = g.game_id
    WHERE g.kickoff >= ? AND g.kickoff < ? AND (g.status IS NULL OR g.status = 'NS') AND (g.stage IS NULL OR g.stage NOT LIKE 'Pre%') ${other}`).all(from, to) as any[];
  return rows.map(r => {
    const p = Math.max(r.p_home, 1 - r.p_home);
    const lg = r.league === 2 ? 2 : 1;
    return {
      sport: 'american-football' as const, id: r.game_id, rid: -(2e9 + r.game_id), start: r.kickoff, league: lg === 2 ? 'College football' : 'NFL',
      home: r.home_name || 'TBD', away: r.away_name || 'TBD', homeImg: r.home_logo || null, awayImg: r.away_logo || null, path: `/american-football/game/${r.game_id}`,
      pick: { side: (r.p_home >= 0.5 ? 'H' : 'A') as 'H' | 'A' }, pct: r1(100 * p), strong: p >= strongLineOf(lg as 1 | 2),
      teamIds: [r.home_id, r.away_id], size: lg === 1 ? 6 : 2
    };
  });
}

function tennisCands(from: string, to: string): Cand[] {
  if (!tableExists('tennis_matches')) return [];
  const ts = tennisSite();
  const list = ts.tennisMatchesBetween(from, to, null, false).filter(m => m.tour !== 'itf' && m.state === 'upcoming');
  const abs = (u: string | null) => (u && u.startsWith('/') ? `${SITE}${u}` : u);
  const out: Cand[] = [];
  for (const m of ts.withTennisPredictions(list, true)) {
    const p: any = m.prediction;
    if (!p || p.locked || !Number.isFinite(p.pHome)) continue;
    const top = Math.max(p.pHome, p.pAway);
    const rankBonus = [m.home.rank, m.away.rank].some(x => x && x <= 10) ? 2 : 0;
    out.push({
      sport: 'tennis', id: m.id, rid: m.rid, start: m.start, league: [m.tournament.name, m.round].filter(Boolean).join(' · '), home: m.home.name, away: m.away.name,
      homeImg: abs(m.home.logo), awayImg: abs(m.away.logo), path: `/tennis/match/${m.id}`,
      pick: { side: p.pHome >= p.pAway ? 'H' : 'A' }, pct: r1(top), strong: !!p.strong,
      teamIds: [m.home.id, m.away.id].filter((x): x is number => !!x), size: Math.max(0, 6 - ts.levelRank(m.tournament.tier, m.tour, m.tournament.name)) + rankBonus
    });
  }
  return out;
}

/** Every game of [from, to) with a pick, in the open sports (admin = every sport). */
export function candidates(from: number, to: number, admin = false): Cand[] {
  const f = new Date(from).toISOString(), t = new Date(to).toISOString();
  const out: Cand[] = [];
  const load: Record<ESport, () => Cand[]> = { football: () => footballCands(f, t), basketball: () => basketballCands(f, t), 'american-football': () => nflCands(f, t), tennis: () => tennisCands(f, t) };
  for (const s of EMAIL_SPORTS) {
    if (!sportOpen(s, admin)) continue;
    try { out.push(...load[s]()); } catch (e: any) { logger.warn(`picks emails: ${s} games failed: ${e?.message || e}`); }
  }
  return out;
}

/* ---------- our record (the public record's own rows) ---------- */

export interface RecRow { sport: ESport; at: string; hit: boolean; pct: number; home: string; away: string; pick: Cand['pick']; path: string; league: string }
/** The settled picks of the last `days` days, from the same functions the site's record uses. */
export function recordRows(sport: ESport, days: number): RecRow[] {
  if (sport === 'football') {
    return (publicRecord(days, undefined, 1_000_000).recent as any[]).map(r => ({
      sport, at: r.date, hit: !!r.dc.hit, pct: Number(r.dc.p), home: r.home, away: r.away, pick: { k: r.dc.pick as DC }, path: `/match/${r.matchId}`, league: r.competition || ''
    }));
  }
  if (sport === 'basketball') {
    if (!tableExists('bb_predictions')) return [];
    return (bbRecord(days, undefined, 1_000_000).recent as any[]).map(r => ({
      sport, at: r.kickoff, hit: !!r.hit, pct: r1(100 * Math.max(r.pHome, 1 - r.pHome)), home: r.home, away: r.away, pick: { side: r.pick }, path: `/basketball/game/${r.gameId}`, league: r.code
    }));
  }
  if (sport === 'american-football') {
    if (!tableExists('nfl_predictions')) return [];
    return (nflAccuracy(days, 1_000_000).recent as any[]).map(r => ({
      sport, at: r.kickoff, hit: !!r.hit, pct: r1(100 * Math.max(r.pHome, 1 - r.pHome)), home: r.home, away: r.away, pick: { side: r.pick }, path: `/american-football/game/${r.gameId}`, league: r.code
    }));
  }
  if (!tableExists('tennis_predictions')) return [];
  return tennisSite().tennisRecordRows(days, 'all').map(x => ({
    sport, at: x.m.start, hit: (x.r.p1 >= 0.5) === (x.m.winner === 1), pct: r1(100 * Math.max(x.r.p1, 1 - x.r.p1)), home: x.m.home.name, away: x.m.away.name,
    pick: { side: (x.r.p1 >= 0.5 ? 'H' : 'A') as 'H' | 'A' }, path: `/tennis/match/${x.m.id}`, league: x.m.tournament.name
  }));
}
/** The site's own totals for the last `days` days (data health compares them with recordRows). */
export function siteRecord(sport: ESport, days: number): { n: number; hits: number } {
  if (sport === 'football') { const d = publicRecord(days).doubleChance; return { n: d.n, hits: d.v3Hits }; }
  if (sport === 'basketball') { const t = bbRecord(days).total; return { n: t.n, hits: t.hits }; }
  if (sport === 'american-football') { const b = nflRecord(days).bands[0]; return { n: b.n, hits: b.hits }; }
  const b = tennisSite().tennisRecord(days, 'all').bands[0];
  return { n: b.n, hits: b.hits };
}

/* ---------- one run's shared data ---------- */

export interface Ctx { now: number; next24: Cand[]; next7: Cand[]; rec: Map<ESport, RecRow[]>; admin: { next24: Cand[]; next7: Cand[]; rec: Map<ESport, RecRow[]> } | null }
const REC_DAYS = 9; // covers yesterday and last week in every time zone
export function buildCtx(now = Date.now(), withAdmin = false): Ctx {
  const rec = (admin: boolean) => {
    const m = new Map<ESport, RecRow[]>();
    for (const s of EMAIL_SPORTS) {
      if (!sportOpen(s, admin)) continue;
      try { m.set(s, recordRows(s, REC_DAYS)); } catch (e: any) { logger.warn(`picks emails: ${s} record failed: ${e?.message || e}`); }
    }
    return m;
  };
  const pub = { next24: candidates(now, now + DAY), next7: candidates(now, now + 7 * DAY), rec: rec(false) };
  return { now, ...pub, admin: withAdmin ? { next24: candidates(now, now + DAY, true), next7: candidates(now, now + 7 * DAY, true), rec: rec(true) } : null };
}
const view = (ctx: Ctx, admin: boolean) => (admin && ctx.admin ? ctx.admin : ctx);

/* ---------- what one person gets ---------- */

export interface Row extends Cand { shown: boolean; fav: boolean }
export interface Person { user: User; prefs: EmailPrefs; access: Access; unlocked: Set<number>; fav: Record<ESport, Set<number>> }

export function personOf(user: User, prefs = emailPrefs(user.id)): Person {
  const access = accessOf(user);
  const favs = listFavorites(user.id);
  const ids = (kind: string) => new Set(favs.filter(f => f.kind === kind).flatMap(f => (f.ids?.length ? f.ids : [Number(f.ref)])).filter(n => Number.isInteger(n) && n > 0));
  const fbIds = favs.filter(f => f.kind === 'team').flatMap(f => f.ids || []);
  return {
    user, prefs, access, unlocked: canSeeFull(access) ? new Set<number>() : unlockedIds(user.id),
    fav: { football: fbIds.length ? footballTeamIds(fbIds) : new Set<number>(), basketball: ids('bb-team'), 'american-football': ids('nfl-team'), tennis: ids('tennis-player') }
  };
}
const isFav = (p: Person, c: Cand) => c.teamIds.some(id => p.fav[c.sport].has(id));

/** Pro (and admins) see every pick; everyone else the 3 strongest of the email plus the games they unlocked. */
export function lockRows(p: Person, list: (Cand & { fav?: boolean })[]): Row[] {
  const full = canSeeFull(p.access);
  const top = new Set([...list].sort((a, b) => b.pct - a.pct).slice(0, 3));
  return list.map(c => ({ ...c, fav: !!c.fav, shown: full || top.has(c) || p.unlocked.has(c.rid) }));
}

export interface Daily { kind: 'daily'; rows: Row[]; strongN: number; favN: number; yesterday: { n: number; hits: number } }
/** The daily email's rows, or the reason there is nothing to send. */
export function dailyFor(p: Person, ctx: Ctx): Daily | { skip: string } {
  const v = view(ctx, !!p.user.isAdmin);
  const mine = v.next24.filter(c => p.prefs.sports.includes(c.sport));
  const strong = mine.filter(c => c.strong).sort((a, b) => b.pct - a.pct || a.start.localeCompare(b.start)).slice(0, 5);
  const favs = mine.filter(c => !strong.includes(c) && isFav(p, c)).sort((a, b) => a.start.localeCompare(b.start)).map(c => ({ ...c, fav: true }));
  if (!strong.length && !favs.length) return { skip: 'no strong pick and no favourite playing in the next 24 h' };
  const rows = lockRows(p, [...strong.map(c => ({ ...c, fav: isFav(p, c) })), ...favs].slice(0, 10));
  const lt = localTime(p.prefs.tz, ctx.now);
  const from = zonedTime(p.prefs.tz, addDays(lt.day, -1)), to = zonedTime(p.prefs.tz, lt.day);
  return { kind: 'daily', rows, strongN: strong.length, favN: favs.length, yesterday: tally(v.rec, p.prefs.sports, from, to) };
}
function tally(rec: Map<ESport, RecRow[]>, sports: ESport[], from: number, to: number) {
  let n = 0, hits = 0;
  for (const s of sports) for (const r of rec.get(s) || []) {
    const t = Date.parse(r.at);
    if (t >= from && t < to) { n++; if (r.hit) hits++; }
  }
  return { n, hits };
}

export interface Weekly {
  kind: 'weekly'; record: { sport: ESport; n: number; hits: number; pct: number | null }[]
  best: RecRow | null; big: Row[]; favs: Row[]
}
/** Best call of the week: the right pick we were least sure of (football 60%+, the winner sports 55%+): a close call that came in. */
const BEST_MIN: Record<ESport, number> = { football: 60, basketball: 55, 'american-football': 55, tennis: 55 };
export function weeklyFor(p: Person, ctx: Ctx): Weekly | { skip: string } {
  const v = view(ctx, !!p.user.isAdmin);
  const lt = localTime(p.prefs.tz, ctx.now);
  const back = (lt.weekday + 7) % 7; // days since Monday
  const thisMonday = addDays(lt.day, -back);
  const from = zonedTime(p.prefs.tz, addDays(thisMonday, -7)), to = zonedTime(p.prefs.tz, thisMonday);
  const record = p.prefs.sports.filter(s => v.rec.has(s)).map(s => {
    const t = tally(v.rec, [s], from, to);
    return { sport: s, ...t, pct: t.n ? r1((100 * t.hits) / t.n) : null };
  });
  let best: RecRow | null = null;
  for (const s of p.prefs.sports) for (const r of v.rec.get(s) || []) {
    const t = Date.parse(r.at);
    if (t < from || t >= to || !r.hit || r.pct < BEST_MIN[s]) continue;
    if (!best || r.pct < best.pct || (r.pct === best.pct && r.at > best.at)) best = r;
  }
  const mine = v.next7.filter(c => p.prefs.sports.includes(c.sport));
  const big = [...mine].sort((a, b) => b.size - a.size || b.pct - a.pct || a.start.localeCompare(b.start)).slice(0, 5);
  const favs = mine.filter(c => !big.includes(c) && isFav(p, c)).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 5).map(c => ({ ...c, fav: true }));
  if (!record.some(r => r.n) && !big.length && !favs.length) return { skip: 'no finished picks last week and no games this week' };
  const rows = lockRows(p, [...big.map(c => ({ ...c, fav: isFav(p, c) })), ...favs]);
  return { kind: 'weekly', record, best, big: rows.slice(0, big.length), favs: rows.slice(big.length) };
}

/* ---------- crests and logos: served from our domain ---------- */

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
export const CREST_DIR = path.join(DATA_DIR, 'email-crests');
const CREST_HOSTS = /^https:\/\/(media\.api-sports\.io|crests\.football-data\.org)\//;
const crestName = (src: string) => crypto.createHash('sha1').update(src).digest('hex').slice(0, 24);
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const crestKnown = new Map<string, string | null>(); // source URL → file name (null = could not be fetched)
function crestFileOf(src: string): string | null {
  if (crestKnown.has(src)) return crestKnown.get(src)!;
  const base = crestName(src);
  for (const e of Object.values(EXT)) if (fs.existsSync(path.join(CREST_DIR, `${base}.${e}`))) { crestKnown.set(src, `${base}.${e}`); return `${base}.${e}`; }
  return null;
}
/** The image as a URL on our domain: provider crests once they are stored here (fix241: never a /media/players/ photo). */
export function imgUrl(src: string | null): string | null {
  if (!src || src.includes('/media/players/')) return null;
  if (src.startsWith(`${SITE}/`)) return src;
  if (!CREST_HOSTS.test(src)) return null;
  const f = crestFileOf(src);
  return f ? `${SITE}/media/crests/${f}` : null;
}
/** Store the crests a run needs (at most 150 new ones per run, PNG / JPEG / WebP / GIF up to 300 KB). */
export async function storeCrests(srcs: (string | null)[]) {
  const todo = [...new Set(srcs.filter((s): s is string => !!s && CREST_HOSTS.test(s) && !crestKnown.has(s) && !crestFileOf(s)))].slice(0, 150);
  if (!todo.length) return;
  fs.mkdirSync(CREST_DIR, { recursive: true });
  for (const src of todo) {
    try {
      const r = await axios.get(src, { responseType: 'arraybuffer', timeout: 10000, maxContentLength: 300_000, validateStatus: s => s === 200 });
      const ext = EXT[String(r.headers['content-type'] || '').split(';')[0].trim()];
      if (!ext) { crestKnown.set(src, null); continue; }
      const name = `${crestName(src)}.${ext}`;
      fs.writeFileSync(path.join(CREST_DIR, name), Buffer.from(r.data));
      crestKnown.set(src, name);
    } catch { crestKnown.set(src, null); }
    await yieldLoop();
  }
  if (crestKnown.size > 20000) crestKnown.clear();
}
/** /media/crests/:file → the stored file, or null */
export function crestPath(file: string): string | null {
  if (!/^[0-9a-f]{24}\.(png|jpg|webp|gif)$/.test(file)) return null;
  const f = path.join(CREST_DIR, file);
  return fs.existsSync(f) ? f : null;
}

/* ---------- the emails ---------- */

const LIME = '#c6f432', INK = '#0b0e13', TEXT = '#111419', MUTED = '#5d6573', LINE = '#e3e6eb', SOFT = '#f3f5f7';
export const FOOTER_LINE = 'SportLikely · predictions are probabilities, not promises. Information only, not betting advice. 18+. If gambling stops being fun, stop and';
const HELP_URL = 'https://www.begambleaware.org';

/** fix257: ar / he are written right to left — dir="rtl" on <html> and the outer table, left / right swapped (English unchanged). */
const dirAttr = (lang: EmailLang) => (isRtl(lang) ? ' dir="rtl"' : '');
const side = (lang: EmailLang, s: 'left' | 'right') => (isRtl(lang) ? (s === 'left' ? 'right' : 'left') : s);

/** The page link with the language prefix and UTM tags. */
const linkTo = (lang: EmailLang, p: string, campaign: string) => {
  const [path0, hash] = p.split('#');
  const pathPart = pubPath(path0); // fix229: the item's slug address

  return `${SITE}${lang === 'en' ? '' : `/${lang}`}${pathPart}${pathPart.includes('?') ? '&' : '?'}utm_source=email&utm_medium=email&utm_campaign=${campaign}${hash ? `#${hash}` : ''}`;
};

function pickText(tx: ReturnType<typeof words>, c: { pick: Cand['pick']; home: string; away: string }) {
  if ('k' in c.pick) return c.pick.k === '1X' ? tx('{0} or draw', c.home) : c.pick.k === 'X2' ? tx('{0} or draw', c.away) : tx('{0} or {1}', c.home, c.away);
  return tx('{0} to win', c.pick.side === 'H' ? c.home : c.away);
}

function timeLabel(lang: EmailLang, tz: string, iso: string, withDay: boolean) {
  const o: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', minute: '2-digit', ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}) };
  try { return new Intl.DateTimeFormat(LOCALES[lang], o).format(new Date(iso)); } catch { return iso.slice(11, 16); }
}

interface Built { subject: string; html: string; text: string }
interface Frame { lang: EmailLang; userId: number; label: string; preheader: string; body: string; cta: { text: string; href: string }; campaign: string }

const crestImg = (src: string | null) => {
  const u = imgUrl(src);
  return u ? `<img src="${esc(u)}" width="22" height="22" alt="" style="display:block;width:22px;height:22px;border:0;object-fit:contain">` : `<span style="display:inline-block;width:22px"></span>`;
};

function rowHtml(tx: ReturnType<typeof words>, lang: EmailLang, tz: string, r: Row, campaign: string, withDay: boolean) {
  const href = linkTo(lang, r.path, campaign);
  const meta = `${esc(tx(SPORT_NAME[r.sport]))} · ${esc(r.league)} · ${esc(timeLabel(lang, tz, r.start, withDay))}${r.fav ? ` · <span style="color:${MUTED}">★ ${esc(tx('Your team'))}</span>` : ''}`;
  const pick = r.shown
    ? `<span style="color:${MUTED}">${esc(tx('Our pick'))} ·</span> <b>${esc(pickText(tx, r))}</b> · <b>${r.pct.toFixed(0)}%</b>${r.strong ? ` <span class="sl-pill" style="display:inline-block;background:${LIME};color:${INK};font-size:11px;font-weight:800;padding:2px 7px;border-radius:999px;margin-${side(lang, 'left')}:4px">${esc(tx('Strong pick'))}</span>` : ''}`
    : `<a href="${esc(linkTo(lang, '/premium', campaign))}" style="color:${TEXT};text-decoration:none"><span style="display:inline-block;background:${SOFT};border:1px solid ${LINE};color:${MUTED};font-weight:700;padding:3px 9px;border-radius:8px">🔒 ${esc(tx('Unlock with Pro'))}</span></a>`;
  return `<tr><td class="sl-row" style="padding:12px 24px;border-top:1px solid ${LINE}">
    <div class="sl-muted" style="font-size:12px;color:${MUTED};margin-bottom:6px">${meta}</div>
    <a href="${esc(href)}" style="color:${TEXT};text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <td style="padding-${side(lang, 'right')}:8px">${crestImg(r.homeImg)}</td><td class="sl-text" style="font-size:15px;font-weight:700;color:${TEXT}">${esc(r.home)}</td>
      <td style="padding:0 8px;color:${MUTED}">–</td>
      <td class="sl-text" style="font-size:15px;font-weight:700;color:${TEXT}">${esc(r.away)}</td><td style="padding-${side(lang, 'left')}:8px">${crestImg(r.awayImg)}</td>
    </tr></table></a>
    <div class="sl-text" style="font-size:14px;color:${TEXT};margin-top:6px">${pick}</div>
  </td></tr>`;
}
const rowText = (tx: ReturnType<typeof words>, lang: EmailLang, tz: string, r: Row, campaign: string, withDay: boolean) =>
  `${tx(SPORT_NAME[r.sport])} · ${r.league} · ${timeLabel(lang, tz, r.start, withDay)}${r.fav ? ` · ★ ${tx('Your team')}` : ''}\n${r.home} – ${r.away}\n` +
  (r.shown ? `${tx('Our pick')} · ${pickText(tx, r)} · ${r.pct.toFixed(0)}%${r.strong ? ` (${tx('Strong pick')})` : ''}` : `🔒 ${tx('Unlock with Pro')}: ${linkTo(lang, '/premium', campaign)}`) +
  `\n${linkTo(lang, r.path, campaign)}`;

const sectionHtml = (title: string) =>
  `<tr><td style="padding:22px 24px 8px"><div class="sl-muted" style="font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:${MUTED}">${esc(title)}</div></td></tr>`;

/** The shared frame: dark header with the logo, white card, lime accent, footer with the 18+ line and the links. */
function frame(f: Frame): string {
  const tx = words(f.lang);
  const unsub = picksUnsubUrl(f.userId);
  const manage = linkTo(f.lang, '/account/emails', f.campaign);
  return `<!doctype html><html lang="${f.lang}"${dirAttr(f.lang)}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>SportLikely</title>
<style>
@media (prefers-color-scheme: dark) {
  .sl-bg { background:#0b0e13 !important } .sl-card { background:#151a21 !important; border-color:#262d37 !important }
  .sl-text { color:#e8eaee !important } .sl-muted { color:#9aa1ad !important } .sl-row { border-color:#262d37 !important }
}
@media (max-width: 620px) { .sl-row { padding-left:16px !important; padding-right:16px !important } }
</style></head>
<body class="sl-bg" style="margin:0;padding:0;background:${SOFT};font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:${TEXT};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(f.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="sl-bg"${dirAttr(f.lang)} style="background:${SOFT}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" class="sl-card" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
  <tr><td style="background:${INK};padding:18px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><a href="${esc(linkTo(f.lang, '/', f.campaign))}" style="text-decoration:none"><img src="${SITE}/logo-mark.png" width="26" height="26" alt="" style="vertical-align:middle;border:0;border-radius:6px">
        <span style="vertical-align:middle;font-weight:800;font-size:19px;color:#ffffff;margin-${side(f.lang, 'left')}:6px">Sport<span style="color:${LIME}">Likely</span></span></a></td>
      <td align="${side(f.lang, 'right')}" style="font-size:12px;font-weight:700;color:${LIME}">${esc(f.label)}</td>
    </tr></table>
  </td></tr>
  ${f.body}
  <tr><td style="padding:20px 24px 26px;border-top:1px solid ${LINE}" class="sl-row">
    <a href="${esc(f.cta.href)}" style="display:inline-block;background:${LIME};color:${INK};font-weight:800;font-size:14px;text-decoration:none;padding:12px 20px;border-radius:10px">${esc(f.cta.text)}</a>
  </td></tr>
</table>
<p class="sl-muted" style="max-width:560px;font-size:11px;line-height:1.55;color:${MUTED};margin:16px auto 0;text-align:${side(f.lang, 'left')}">
  ${esc(tx(FOOTER_LINE))} <a href="${HELP_URL}" style="color:${MUTED}">${esc(tx('get help'))}</a>.<br>
  ${esc(tx('You get this email because you turned it on in your SportLikely account.'))}
  <a href="${esc(manage)}" style="color:${MUTED}">${esc(tx('Manage emails'))}</a> · <a href="${esc(unsub)}" style="color:${MUTED}">${esc(tx('Unsubscribe'))}</a><br>
  SportLikely · <a href="${SITE}" style="color:${MUTED}">sportlikely.com</a>
</p>
</td></tr></table></body></html>`;
}
function footerText(lang: EmailLang, userId: number, campaign: string) {
  const tx = words(lang);
  return `\n—\n${tx(FOOTER_LINE)} ${tx('get help')}: ${HELP_URL}\n${tx('You get this email because you turned it on in your SportLikely account.')}\n` +
    `${tx('Manage emails')}: ${linkTo(lang, '/account/emails', campaign)}\n${tx('Unsubscribe')}: ${picksUnsubUrl(userId)}\n`;
}

export function renderDaily(p: Person, d: Daily, now: number): Built {
  const { lang, tz } = p.prefs;
  const tx = words(lang), campaign = 'daily_picks';
  const dayName = new Intl.DateTimeFormat(LOCALES[lang], { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
  const strong = d.rows.slice(0, d.strongN), favs = d.rows.slice(d.strongN);
  const yest = d.yesterday.n ? tx('Yesterday: {0} of {1} picks right', d.yesterday.hits, d.yesterday.n) : '';
  let body = `<tr><td style="padding:22px 24px 4px"><div class="sl-text" style="font-size:22px;font-weight:800;color:${TEXT}">${esc(tx("Today's picks"))}</div>
    <div class="sl-muted" style="font-size:13px;color:${MUTED};margin-top:2px">${esc(dayName)}</div>
    ${yest ? `<div style="margin-top:12px;display:inline-block;background:${INK};color:#ffffff;font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px">✓ ${esc(yest)}</div>` : ''}
  </td></tr>`;
  const text: string[] = [tx("Today's picks"), dayName, ...(yest ? [yest] : []), ''];
  if (strong.length) {
    body += sectionHtml(tx('Strong picks')) + strong.map(r => rowHtml(tx, lang, tz, r, campaign, false)).join('');
    text.push(tx('Strong picks').toUpperCase(), ...strong.map(r => rowText(tx, lang, tz, r, campaign, false) + '\n'));
  }
  if (favs.length) {
    body += sectionHtml(tx('Your teams')) + favs.map(r => rowHtml(tx, lang, tz, r, campaign, false)).join('');
    text.push(tx('Your teams').toUpperCase(), ...favs.map(r => rowText(tx, lang, tz, r, campaign, false) + '\n'));
  }
  const tzNote = tx('Times are in {0}.', tz);
  body += `<tr><td class="sl-muted" style="padding:6px 24px 0;font-size:12px;color:${MUTED}">${esc(tzNote)} ${esc(tx('Probabilities, not promises.'))}</td></tr>`;
  const cta = { text: tx("See all of today's games"), href: linkTo(lang, '/predictions/today', campaign) };
  const first = d.rows.find(r => r.shown && r.strong);
  const subject = first ? tx("Today's picks: {0} · {1}%", pickText(tx, first), first.pct.toFixed(0)) : tx("Today's picks for your teams");
  const preheader = [yest, tx('{0} strong picks · {1} games of your teams', d.strongN, d.favN)].filter(Boolean).join(' · ');
  return {
    subject,
    html: frame({ lang, userId: p.user.id, label: tx('Daily picks'), preheader, body, cta, campaign }),
    text: `${text.join('\n')}\n${tzNote} ${tx('Probabilities, not promises.')}\n${cta.text}: ${cta.href}\n${footerText(lang, p.user.id, campaign)}`
  };
}

export function renderWeekly(p: Person, w: Weekly, now: number): Built {
  const { lang, tz } = p.prefs;
  const tx = words(lang), campaign = 'weekly_digest';
  const dayName = new Intl.DateTimeFormat(LOCALES[lang], { timeZone: tz, day: 'numeric', month: 'long' }).format(new Date(now));
  let body = `<tr><td style="padding:22px 24px 4px"><div class="sl-text" style="font-size:22px;font-weight:800;color:${TEXT}">${esc(tx('Your week on SportLikely'))}</div>
    <div class="sl-muted" style="font-size:13px;color:${MUTED};margin-top:2px">${esc(tx('Week of {0}', dayName))}</div></td></tr>`;
  const text: string[] = [tx('Your week on SportLikely'), tx('Week of {0}', dayName), ''];
  body += sectionHtml(tx('Last week'));
  text.push(tx('Last week').toUpperCase());
  const recLines = w.record.map(r => r.n
    ? tx('{0}: {1} of {2} picks right ({3}%)', tx(SPORT_NAME[r.sport]), r.hits, r.n, (r.pct ?? 0).toFixed(0))
    : tx('{0}: no finished picks', tx(SPORT_NAME[r.sport])));
  body += `<tr><td class="sl-row" style="padding:4px 24px 8px">${recLines.map(l => `<div class="sl-text" style="font-size:14px;color:${TEXT};padding:3px 0">${esc(l)}</div>`).join('')}</td></tr>`;
  text.push(...recLines, '');
  if (w.best) {
    const b = w.best;
    const line = tx('{0} – {1}: we said {2} · {3}%', b.home, b.away, pickText(tx, b), b.pct.toFixed(0));
    body += sectionHtml(tx('Best call of the week')) +
      `<tr><td class="sl-row" style="padding:4px 24px 8px"><a href="${esc(linkTo(lang, b.path, campaign))}" class="sl-text" style="font-size:14px;color:${TEXT};text-decoration:none">✓ <b>${esc(line)}</b></a>
      <div class="sl-muted" style="font-size:12px;color:${MUTED}">${esc(tx(SPORT_NAME[b.sport]))} · ${esc(b.league)}</div></td></tr>`;
    text.push(tx('Best call of the week').toUpperCase(), `✓ ${line}`, linkTo(lang, b.path, campaign), '');
  }
  if (w.big.length) {
    body += sectionHtml(tx("This week's big games")) + w.big.map(r => rowHtml(tx, lang, tz, r, campaign, true)).join('');
    text.push(tx("This week's big games").toUpperCase(), ...w.big.map(r => rowText(tx, lang, tz, r, campaign, true) + '\n'));
  }
  if (w.favs.length) {
    body += sectionHtml(tx("Your teams' next games")) + w.favs.map(r => rowHtml(tx, lang, tz, r, campaign, true)).join('');
    text.push(tx("Your teams' next games").toUpperCase(), ...w.favs.map(r => rowText(tx, lang, tz, r, campaign, true) + '\n'));
  }
  // fix215 (season forecasts) adds its block here once it is live
  const tzNote = tx('Times are in {0}.', tz);
  body += `<tr><td class="sl-muted" style="padding:6px 24px 0;font-size:12px;color:${MUTED}">${esc(tzNote)} ${esc(tx('Probabilities, not promises.'))}</td></tr>`;
  const cta = { text: tx("See this week's games"), href: linkTo(lang, '/matches', campaign) };
  const tot = w.record.reduce((a, r) => ({ n: a.n + r.n, hits: a.hits + r.hits }), { n: 0, hits: 0 });
  const subject = tot.n ? tx('Your week: {0} of {1} picks right', tot.hits, tot.n) : tx('Your week on SportLikely');
  return {
    subject,
    html: frame({ lang, userId: p.user.id, label: tx('Weekly digest'), preheader: recLines.join(' · '), body, cta, campaign }),
    text: `${text.join('\n')}\n${tzNote} ${tx('Probabilities, not promises.')}\n${cta.text}: ${cta.href}\n${footerText(lang, p.user.id, campaign)}`
  };
}

/** The email (or the reason it is not sent) for one person and kind. */
export function composeFor(p: Person, kind: 'daily' | 'weekly', ctx: Ctx): Built | { skip: string } {
  const d = kind === 'daily' ? dailyFor(p, ctx) : weeklyFor(p, ctx);
  if ('skip' in d) return d;
  return d.kind === 'daily' ? renderDaily(p, d, ctx.now) : renderWeekly(p, d, ctx.now);
}
export const imagesOf = (ctx: Ctx) => [...ctx.next24, ...ctx.next7, ...(ctx.admin ? [...ctx.admin.next24, ...ctx.admin.next7] : [])].flatMap(c => [c.homeImg, c.awayImg]);

/* ---------- sending ---------- */

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
export const SEND_GAP_MS = 600, BATCH = 50, BATCH_PAUSE_MS = 5000;
/** One email with retries: 429 (waits Retry-After) and 5xx / network errors, 4 tries; other errors at once. */
export async function sendWithRetry(o: Parameters<typeof sendMail>[0], tries = 4, wait = pause): Promise<string | null> {
  for (let i = 1; ; i++) {
    try { return await sendMail({ ...o, quiet: true }); } catch (e: any) {
      const st = Number(e?.response?.status) || 0;
      const retry = st === 429 || st >= 500 || !st;
      if (!retry || i >= tries) throw e;
      const ra = Number(e?.response?.headers?.['retry-after']);
      await wait(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * 2 ** i);
    }
  }
}

const logSend = (userId: number, kind: string, day: string, status: 'sent' | 'failed' | 'skipped', reason: string | null, providerId: string | null) =>
  db.prepare(`INSERT INTO email_sends (user_id, kind, day, at, status, reason, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind, day) DO UPDATE SET at = excluded.at, status = excluded.status, reason = excluded.reason, provider_id = excluded.provider_id, attempts = email_sends.attempts + 1`)
    .run(userId, kind, day, nowIso(), status, reason, providerId);

/** Everyone with an email due now (confirmed address, not stopped, not sent yet today; a failed one is tried 3 times). */
export function dueList(now = Date.now()): { user: User; prefs: EmailPrefs; day: string; kinds: ('daily' | 'weekly')[] }[] {
  const rows = db.prepare(`SELECT e.*, u.email FROM email_prefs e JOIN users u ON u.id = e.user_id
    WHERE (e.daily = 1 OR e.weekly = 1) AND u.email_verified = 1 AND lower(u.email) NOT IN (SELECT email FROM email_suppressed)`).all() as any[];
  const done = db.prepare(`SELECT status, attempts, at FROM email_sends WHERE user_id = ? AND kind = ? AND day = ?`);
  const out: ReturnType<typeof dueList> = [];
  for (const r of rows) {
    const prefs = rowToPrefs(r);
    const due = dueKinds(prefs, now);
    const kinds = due.kinds.filter(k => {
      const s = done.get(r.user_id, k, due.day) as any;
      return !s || (s.status === 'failed' && s.attempts < 3 && Date.parse(s.at) < now - 10 * MIN);
    });
    if (!kinds.length) continue;
    const user = userById(r.user_id);
    if (user) out.push({ user, prefs, day: due.day, kinds });
  }
  return out;
}

let running = false;
const lastRun = { at: null as string | null, sent: 0, skipped: 0, failed: 0 };
/** The worker job (every 5 min): build the shared data once, then send in batches of 50. */
export async function picksEmailTick(now = Date.now(), opts: { wait?: (ms: number) => Promise<unknown> } = {}) {
  if (running || !emailEnabled) return lastRun;
  running = true;
  const wait = opts.wait || pause;
  try {
    const due = dueList(now);
    if (!due.length) return lastRun;
    const ctx = await heavy('picks emails build', async () => {
      const c = buildCtx(now, due.some(d => d.user.isAdmin));
      await storeCrests(imagesOf(c));
      return c;
    });
    if (!ctx) return lastRun;
    let sent = 0, skipped = 0, failed = 0, n = 0;
    for (const d of due) {
      const p = personOf(d.user, d.prefs);
      for (const kind of d.kinds) {
        // re-check: the person may have switched off while the run was going
        const still = emailPrefs(d.user.id);
        if (!still[kind]) continue;
        let built: Built | { skip: string };
        try { built = composeFor(p, kind, ctx); } catch (e: any) { built = { skip: `build failed: ${e?.message || e}` }; }
        if ('skip' in built) { logSend(d.user.id, kind, d.day, 'skipped', built.skip, null); skipped++; continue; }
        const url = picksUnsubUrl(d.user.id);
        try {
          const id = await sendWithRetry({ to: d.user.email, subject: built.subject, html: built.html, text: built.text,
            headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }, 4, wait as any);
          logSend(d.user.id, kind, d.day, 'sent', null, id);
          sent++;
        } catch (e: any) {
          logSend(d.user.id, kind, d.day, 'failed', `${e?.response?.status || ''} ${e?.response?.data?.message || e?.message || e}`.trim().slice(0, 200), null);
          failed++;
        }
        n++;
        await wait(n % BATCH === 0 ? BATCH_PAUSE_MS : SEND_GAP_MS);
      }
    }
    Object.assign(lastRun, { at: new Date(now).toISOString(), sent, skipped, failed });
    if (sent || failed || skipped) logger.info(`picks emails: ${sent} sent, ${skipped} skipped (nothing to send), ${failed} failed`);
    // fix239: a delivery problem (3+ failed and at least a fifth of the run) → one admin email a day
    if (failed >= 3 && failed * 5 >= sent + failed) void alertOncePerDay('picks-email-failed', `Site problem: ${failed} picks emails failed`, {
      label: 'Emails', tone: 'fail', title: `${failed} of ${sent + failed} picks emails failed to send`,
      what: `The email provider refused ${failed} daily / weekly picks emails in the run of ${israelTime(now)}; the reasons are in Admin → Emails & alerts.`,
      todo: 'Check the email provider’s dashboard (sending domain, quota); tell Claude if it fails again tomorrow.',
      buttons: [{ text: 'Open emails in Admin', href: adminUrl('messages') }]
    }, now);
    return lastRun;
  } finally { running = false; }
}

/* ---------- admin: test, preview, numbers ---------- */

/** "Send me a test": today's email of that kind to the admin's own address (the switches are not needed). */
export async function sendTestEmail(admin: User, kind: 'daily' | 'weekly') {
  if (!emailEnabled) throw new EmailPrefsError(503, 'Email is not configured on the server.');
  const ctx = buildCtx(Date.now(), true);
  await storeCrests(imagesOf(ctx));
  const prefs = { ...emailPrefs(admin.id), [kind]: true };
  const built = composeFor(personOf(admin, prefs), kind, ctx);
  if ('skip' in built) return { sent: false, reason: built.skip };
  await sendMail({ to: admin.email, subject: `[TEST] ${built.subject}`, html: built.html, text: built.text, quiet: true });
  return { sent: true, to: admin.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2') };
}
/** Today's email for any user id, as HTML (what they would get at their send hour; not sent, not logged). */
export function previewEmail(userId: number, kind: 'daily' | 'weekly'): { html: string } | { skip: string } {
  const user = userById(userId);
  if (!user) return { skip: 'No such user.' };
  const prefs = { ...emailPrefs(userId), [kind]: true };
  const built = composeFor(personOf(user, prefs), kind, buildCtx(Date.now(), !!user.isAdmin));
  return 'skip' in built ? built : { html: built.html };
}

export function emailAdminStats(days = 14) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  const byDay = new Map<string, Record<string, number>>();
  const add = (day: string, k: string, n: number) => { const r = byDay.get(day) || {}; r[k] = (r[k] || 0) + n; byDay.set(day, r); };
  for (const r of db.prepare(`SELECT substr(at, 1, 10) AS day, status, COUNT(*) AS n FROM email_sends WHERE at >= ? GROUP BY 1, 2`).all(since) as any[]) add(r.day, r.status, r.n);
  for (const r of db.prepare(`SELECT day, type, n FROM email_events WHERE day >= ?`).all(since.slice(0, 10)) as any[]) add(r.day, r.type, r.n);
  for (const r of db.prepare(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM email_consent_log WHERE on_ = 0 AND at >= ? GROUP BY 1`).all(since) as any[]) add(r.day, 'unsubscribed', r.n);
  const perDay = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, r]) => ({
    day, sent: r.sent || 0, skipped: r.skipped || 0, failed: r.failed || 0, delivered: r.delivered || 0, opened: r.opened || 0, clicked: r.clicked || 0,
    bounced: r.bounced || 0, complained: r.complained || 0, unsubscribed: r.unsubscribed || 0
  }));
  const opted = db.prepare(`SELECT SUM(daily) AS daily, SUM(weekly) AS weekly FROM email_prefs`).get() as any;
  return {
    enabled: emailEnabled, webhook: !!WEBHOOK_SECRET, lastRun: { ...lastRun },
    optedIn: { daily: opted?.daily || 0, weekly: opted?.weekly || 0 },
    suppressed: (db.prepare(`SELECT COUNT(*) AS n FROM email_suppressed`).get() as any).n,
    perDay,
    recent: db.prepare(`SELECT user_id AS userId, kind, day, at, status, reason, opened_at AS openedAt, clicked_at AS clickedAt FROM email_sends ORDER BY id DESC LIMIT 40`).all()
  };
}

/* ---------- Resend webhooks (svix signatures) ---------- */

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || '';
/** svix: base64 HMAC-SHA256 of "<id>.<timestamp>.<raw body>" with the secret (after "whsec_"), timestamps within 5 min. */
export function verifyWebhook(raw: Buffer | string, h: { id?: unknown; timestamp?: unknown; signature?: unknown }, secret = WEBHOOK_SECRET, now = Date.now()): boolean {
  if (!secret || !raw || typeof h.id !== 'string' || typeof h.timestamp !== 'string' || typeof h.signature !== 'string') return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const want = crypto.createHmac('sha256', key).update(`${h.id}.${h.timestamp}.${raw.toString()}`).digest('base64');
  return h.signature.split(' ').some(part => {
    const sig = part.split(',')[1] || '';
    return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  });
}

const W = {
  event: deferred(`INSERT INTO email_events (day, type, n) VALUES (?, ?, 1) ON CONFLICT (day, type) DO UPDATE SET n = n + 1`),
  suppress: deferred(`INSERT OR IGNORE INTO email_suppressed (email, reason, at) VALUES (?, ?, ?)`),
  opened: deferred(`UPDATE email_sends SET opened_at = COALESCE(opened_at, ?) WHERE provider_id = ?`),
  clicked: deferred(`UPDATE email_sends SET clicked_at = COALESCE(clicked_at, ?), opened_at = COALESCE(opened_at, ?) WHERE provider_id = ?`),
  bounced: deferred(`UPDATE email_sends SET bounced = 1 WHERE provider_id = ?`),
  complained: deferred(`UPDATE email_sends SET complained = 1 WHERE provider_id = ?`),
  off: deferred(`UPDATE email_prefs SET daily = 0, weekly = 0, daily_at = ?, daily_source = 'complaint', weekly_at = ?, weekly_source = 'complaint', updated_at = ? WHERE user_id IN (SELECT id FROM users WHERE lower(email) = ?)`),
  offLog: deferred(`INSERT INTO email_consent_log (user_id, at, kind, on_, source) SELECT id, ?, 'all', 0, 'complaint' FROM users WHERE lower(email) = ?`)
};
/** One webhook event (written by the worker: the web process only queues the writes). Returns what was done. */
export function handleWebhookEvent(ev: any): string {
  const type = String(ev?.type || ''), data = ev?.data || {};
  const at = String(ev?.created_at || nowIso());
  const day = at.slice(0, 10), id = data.email_id ? String(data.email_id) : null;
  const to: string[] = (Array.isArray(data.to) ? data.to : [data.to]).filter(Boolean).map((x: any) => String(x).toLowerCase());
  const short = type.replace(/^email\./, '');
  if (!['delivered', 'bounced', 'complained', 'opened', 'clicked'].includes(short)) return 'ignored';
  W.event.run(day, short);
  if (short === 'opened' && id) W.opened.run(at, id);
  if (short === 'clicked' && id) W.clicked.run(at, at, id);
  if (short === 'bounced') {
    if (id) W.bounced.run(id);
    if (String(data.bounce?.type || '').toLowerCase() === 'transient') return 'soft bounce';
    for (const e of to) W.suppress.run(e, 'bounce', at);
  }
  if (short === 'complained') {
    if (id) W.complained.run(id);
    for (const e of to) { W.suppress.run(e, 'complaint', at); W.off.run(at, at, at, e); W.offLog.run(at, e); }
  }
  return short;
}

/* ---------- data health ---------- */

export function emailHealth(now = Date.now()): Check[] {
  const checks: Check[] = [];
  if (!emailEnabled) return [{ id: 'email-daily', label: 'Daily email sent', level: 'ok', detail: 'Email is not configured on this server' }];
  // 1. every person due today (send time 45+ min ago, switched on before it) got the email or a skip reason
  const rows = db.prepare(`SELECT e.*, u.email FROM email_prefs e JOIN users u ON u.id = e.user_id
    WHERE e.daily = 1 AND u.email_verified = 1 AND lower(u.email) NOT IN (SELECT email FROM email_suppressed)`).all() as any[];
  const got = db.prepare(`SELECT status, reason FROM email_sends WHERE user_id = ? AND kind = 'daily' AND day = ?`);
  let due = 0, ok = 0;
  const missing: string[] = [];
  for (const r of rows) {
    const p = rowToPrefs(r);
    const day = localTime(p.tz, now).day, at = zonedTime(p.tz, day, p.sendHour);
    if (now < at + 45 * MIN || (p.dailyAt && Date.parse(p.dailyAt) > at)) continue;
    due++;
    const s = got.get(r.user_id, day) as any;
    if (s && s.status !== 'failed') ok++;
    else missing.push(`user ${r.user_id} (${p.tz}, ${String(p.sendHour).padStart(2, '0')}:00): ${s ? `failed — ${s.reason || '?'}` : 'nothing logged'}`);
  }
  checks.push({
    id: 'email-daily', label: 'Daily email sent', level: missing.length ? 'warn' : 'ok',
    detail: !due ? 'Nobody is due yet today' : missing.length ? `${missing.length} of ${due} people due today got no daily email and no skip reason` : `All ${due} people due today got it (or a skip reason)`,
    items: missing.slice(0, 20)
  });
  // 2. bounces over the last 7 days
  const since = new Date(now - 7 * DAY).toISOString();
  const b = db.prepare(`SELECT COUNT(*) AS sent, SUM(bounced) AS bounced, SUM(complained) AS complained FROM email_sends WHERE status = 'sent' AND at >= ?`).get(since) as any;
  const sent = b?.sent || 0, bounced = b?.bounced || 0, rate = sent ? (100 * bounced) / sent : 0;
  checks.push({
    id: 'email-bounces', label: 'Email bounces', level: rate > 2 ? 'warn' : 'ok',
    detail: sent ? `${bounced} of ${sent} picks emails bounced in 7 days (${rate.toFixed(1)}%), ${b?.complained || 0} complaint(s)${WEBHOOK_SECRET ? '' : ' — RESEND_WEBHOOK_SECRET not set: bounces are not reported'}` : 'No picks emails sent in 7 days'
  });
  // 3. the record lines use the site's numbers
  const off: string[] = [];
  for (const s of EMAIL_SPORTS) {
    if (!sportOpen(s)) continue;
    try {
      const mine = recordRows(s, 7), site = siteRecord(s, 7);
      const hits = mine.filter(r => r.hit).length;
      if (mine.length !== site.n || hits !== site.hits) off.push(`${SPORT_NAME[s]}: email ${hits} of ${mine.length}, site ${site.hits} of ${site.n}`);
    } catch (e: any) { off.push(`${SPORT_NAME[s]}: check failed — ${e?.message || e}`); }
  }
  checks.push({
    id: 'email-record', label: 'Email record numbers match the site', level: off.length ? 'warn' : 'ok',
    detail: off.length ? `${off.length} sport(s) count differently from the public record (last 7 days)` : 'Yesterday / last-week lines use the public record (last 7 days checked)', items: off
  });
  return checks;
}

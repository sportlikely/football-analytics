/**
 * fix226: web push alerts — "Game starting", "Score", "Final score" (+ our pick right / wrong) and "Upset watch" (Pro)
 * for the person's favourite teams and players (fix105 favourites) and, if they choose, the games they picked (fix105
 * picks), in every sport. Opt-in only: the browser's permission + the switch in Account → Alerts (off by default);
 * each switch change is stored with its time and source (push_prefs + push_consent_log), each device with the time it
 * was added (push_subs). No odds, no bookmakers, no betting words.
 *
 * Settings and devices are account actions (written by the web process). Everything else runs in the worker:
 * pushAlertsTick (jobs.ts, every 20 s, with the live loop) reads every sport's games of the last hours through one
 * snapshot shape, compares them with the last reading (push_game_state) and stores each event once (push_events,
 * unique per game and event: utils/pushRules.ts says which); the people it concerns get one row each (push_sends,
 * unique per person and event = no event twice). The sender keeps at most 1 push a minute per person (older score
 * updates of the same game are merged into the newest, a stale one expires), quiet hours per person (default 00:00–07:00
 * local: nothing is sent, the "Final score" waits until the morning). Devices that answer 404 / 410 are removed.
 *
 * Keys: VAPID_PUBLIC / VAPID_PRIVATE (Railway variables, base64url; never logged or printed). Without them nothing is
 * sent and the account page says alerts are not switched on yet.
 */
import { alertOncePerDay, adminUrl, israelTime } from './adminMail';
import crypto from 'crypto';
import { pubPath } from './slugs';
import axios from 'axios';
import { db } from '../db';
import logger from '../utils/logger';
import { runsJobs } from './role';
import { userById, accessOf, canSeeFull, type User, type Access } from './auth';
import { unlockedIds } from './billing';
import { listFavorites } from './favorites';
import { footballTeamIds, mainModelRank } from './calendar';
import { liveList } from './liveState';
import { sportOpen } from './pickEmails';
import { isPreseason } from './bbModel';
import { clockMinutes } from './nflLive';
import { yieldEvery } from './perf';
import type { Check } from './dataHealth';
import { vapidAuth, encryptPayload, pushEndpointOk, vapidKeysValid } from '../utils/webPush';
import { eventsOf, withLead, noteOf, inQuiet, quietEnd, validTz, PUSH_SPORTS, type PSport, type PKind, type Snap, type PEvent, type Tx } from '../utils/pushRules';
import de from '../locales/push/de.json';
import es from '../locales/push/es.json';
import fr from '../locales/push/fr.json';
import it from '../locales/push/it.json';
import pt from '../locales/push/pt.json';
import trLang from '../locales/push/tr.json';
import idLang from '../locales/push/id.json';
import hiLang from '../locales/push/hi.json';
import plLang from '../locales/push/pl.json';
import elLang from '../locales/push/el.json';
import ruLang from '../locales/push/ru.json';

db.exec(`
  CREATE TABLE IF NOT EXISTS push_prefs (
    user_id INTEGER PRIMARY KEY, on_ INTEGER NOT NULL DEFAULT 0, on_at TEXT, on_source TEXT,
    starting INTEGER NOT NULL DEFAULT 1, score INTEGER NOT NULL DEFAULT 1, final INTEGER NOT NULL DEFAULT 1, upset INTEGER NOT NULL DEFAULT 1,
    my_picks INTEGER NOT NULL DEFAULT 0, quiet_from INTEGER NOT NULL DEFAULT 0, quiet_to INTEGER NOT NULL DEFAULT 7,
    tz TEXT NOT NULL DEFAULT 'UTC', lang TEXT NOT NULL DEFAULT 'en', updated_at TEXT NOT NULL
  );
  -- every switch change: which one, on / off, when, from where (account, device-gone, admin)
  CREATE TABLE IF NOT EXISTS push_consent_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, on_ INTEGER NOT NULL, source TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_push_consent_user ON push_consent_log(user_id);
  -- one row per browser / device (the endpoint the browser gave, its two keys, when the person allowed it)
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    device TEXT, consent_at TEXT NOT NULL, last_ok_at TEXT, fails INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs(user_id);
  -- the last reading of each game (what changed since)
  CREATE TABLE IF NOT EXISTS push_game_state (sport TEXT NOT NULL, id INTEGER NOT NULL, json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (sport, id));
  -- each event once (sport, game, key)
  CREATE TABLE IF NOT EXISTS push_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, game_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL,
    snap TEXT NOT NULL, side TEXT, UNIQUE (sport, game_id, key)
  );
  CREATE INDEX IF NOT EXISTS idx_push_events_at ON push_events(at);
  -- one row per person and event: queued / sent / failed / quiet / merged / expired / dropped. No notification text is kept.
  CREATE TABLE IF NOT EXISTS push_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, event_id INTEGER NOT NULL, kind TEXT NOT NULL,
    created_at TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL, sent_at TEXT, ok_n INTEGER NOT NULL DEFAULT 0,
    fail_n INTEGER NOT NULL DEFAULT 0, gone_n INTEGER NOT NULL DEFAULT 0, reason TEXT, UNIQUE (user_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_push_sends_queue ON push_sends(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_push_sends_at ON push_sends(created_at);
  CREATE INDEX IF NOT EXISTS idx_push_sends_user ON push_sends(user_id, sent_at);
`);

const MIN = 60000, H = 3600000, DAY = 86400000;
const nowIso = () => new Date().toISOString();
const iso = (t: number) => new Date(t).toISOString();

/* ---------- keys ---------- */

const VAPID = { publicKey: process.env.VAPID_PUBLIC || '', privateKey: process.env.VAPID_PRIVATE || '', subject: process.env.VAPID_SUBJECT || 'mailto:support@sportlikely.com' };
export const pushEnabled = !!VAPID.publicKey && !!VAPID.privateKey && vapidKeysValid(VAPID.publicKey, VAPID.privateKey);
if (VAPID.publicKey && !pushEnabled && runsJobs) logger.warn('push alerts: VAPID_PUBLIC / VAPID_PRIVATE are set but are not a valid P-256 key pair — no alerts are sent');
/** The public key the browser subscribes with (public by design), null when push is off. */
export const pushPublicKey = () => (pushEnabled ? VAPID.publicKey : null);

/* ---------- words ---------- */

export const PUSH_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'tr', 'id', 'hi', 'pl', 'el', 'ru'] as const;
export type PushLang = (typeof PUSH_LANGS)[number];
export const asPushLang = (x: unknown): PushLang => ((PUSH_LANGS as readonly string[]).includes(String(x)) ? (x as PushLang) : 'en');
export const PUSH_PACKS: Record<PushLang, Record<string, string>> = { en: {}, de, es, fr, it, pt, tr: trLang, id: idLang, hi: hiLang, pl: plLang, el: elLang, ru: ruLang };
export function pushWords(lang: PushLang): Tx {
  const pack = PUSH_PACKS[lang];
  return (key, ...a) => a.reduce<string>((s, v, i) => s.split(`{${i}}`).join(String(v)), pack[key] ?? key);
}

/* ---------- settings and consent ---------- */

export interface PushPrefs {
  on: boolean; onAt: string | null; onSource: string | null
  starting: boolean; score: boolean; final: boolean; upset: boolean; myPicks: boolean
  quietFrom: number; quietTo: number; tz: string; lang: PushLang
}
const DEFAULTS = { on_: 0, starting: 1, score: 1, final: 1, upset: 1, my_picks: 0, quiet_from: 0, quiet_to: 7, tz: 'UTC', lang: 'en' };
const rowToPrefs = (r: any): PushPrefs => ({
  on: !!r.on_, onAt: r.on_at || null, onSource: r.on_source || null,
  starting: !!r.starting, score: !!r.score, final: !!r.final, upset: !!r.upset, myPicks: !!r.my_picks,
  quietFrom: Number(r.quiet_from) || 0, quietTo: Number(r.quiet_to) || 0, tz: validTz(r.tz) ? r.tz : 'UTC', lang: asPushLang(r.lang)
});
export function pushPrefs(userId: number): PushPrefs {
  return rowToPrefs(db.prepare(`SELECT * FROM push_prefs WHERE user_id = ?`).get(userId) || DEFAULTS);
}
/** which switch a kind of event needs */
const SWITCH: Record<PKind, 'starting' | 'score' | 'final' | 'upset'> = { start: 'starting', score: 'score', final: 'final', upset: 'upset' };

export class PushError extends Error { constructor(public status: number, msg: string) { super(msg); } }
export type PushSource = 'account' | 'admin' | 'device-gone';
type PrefsIn = Partial<Record<'on' | 'starting' | 'score' | 'final' | 'upset' | 'myPicks' | 'quietFrom' | 'quietTo' | 'tz' | 'lang', unknown>>;

/** Save the settings (only the fields given). Every switch that changes is logged with its time and source. */
export function savePushPrefs(userId: number, input: PrefsIn, source: PushSource): PushPrefs {
  const cur = pushPrefs(userId);
  const next = { ...cur };
  const at = nowIso();
  const flags = ['on', 'starting', 'score', 'final', 'upset', 'myPicks'] as const;
  for (const f of flags) if (input[f] !== undefined) next[f] = input[f] === true;
  for (const f of ['quietFrom', 'quietTo'] as const) if (input[f] !== undefined) {
    const h = Number(input[f]);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new PushError(400, 'Choose quiet hours between 00:00 and 23:00.');
    next[f] = h;
  }
  if (input.tz !== undefined) {
    if (!validTz(input.tz)) throw new PushError(400, 'Unknown time zone.');
    next.tz = input.tz as string;
  }
  if (input.lang !== undefined) next.lang = asPushLang(input.lang);
  const log = db.prepare(`INSERT INTO push_consent_log (user_id, at, kind, on_, source) VALUES (?, ?, ?, ?, ?)`);
  for (const f of flags) if (next[f] !== cur[f]) log.run(userId, at, f, next[f] ? 1 : 0, source);
  if (next.on !== cur.on) { next.onAt = at; next.onSource = source; }
  db.prepare(`INSERT INTO push_prefs (user_id, on_, on_at, on_source, starting, score, final, upset, my_picks, quiet_from, quiet_to, tz, lang, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET on_ = excluded.on_, on_at = excluded.on_at, on_source = excluded.on_source, starting = excluded.starting,
      score = excluded.score, final = excluded.final, upset = excluded.upset, my_picks = excluded.my_picks, quiet_from = excluded.quiet_from,
      quiet_to = excluded.quiet_to, tz = excluded.tz, lang = excluded.lang, updated_at = excluded.updated_at`)
    .run(userId, next.on ? 1 : 0, next.onAt, next.onSource, next.starting ? 1 : 0, next.score ? 1 : 0, next.final ? 1 : 0, next.upset ? 1 : 0,
      next.myPicks ? 1 : 0, next.quietFrom, next.quietTo, next.tz, next.lang, at);
  return pushPrefs(userId);
}

/** A short device label from the browser's user agent (the agent itself is not stored). */
export function deviceLabel(ua: unknown): string {
  const s = String(ua || '');
  const os = /iPhone|iPad/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'device';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'browser';
  return `${br} on ${os}`;
}

/** This browser's subscription (the endpoint and keys from PushManager.subscribe), stored with the consent time. */
export function addPushSub(userId: number, sub: any, ua: unknown): number {
  const endpoint = sub?.endpoint, p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
  if (!pushEndpointOk(endpoint)) throw new PushError(400, 'This browser\'s push service is not supported.');
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100 || !/^[A-Za-z0-9_-]+=*$/.test(p256dh) || !/^[A-Za-z0-9_-]+=*$/.test(auth)) throw new PushError(400, 'Bad subscription.');
  if ((db.prepare(`SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?`).get(userId) as any).n >= 10 && !db.prepare(`SELECT 1 FROM push_subs WHERE endpoint = ?`).get(endpoint))
    throw new PushError(400, 'Alerts are on for 10 devices already. Turn them off on one first.');
  // an endpoint belongs to one browser: a new sign-in on it moves it to that account
  db.prepare(`INSERT INTO push_subs (user_id, endpoint, p256dh, auth, device, consent_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device,
      consent_at = CASE WHEN push_subs.user_id = excluded.user_id THEN push_subs.consent_at ELSE excluded.consent_at END, fails = 0`)
    .run(userId, endpoint, p256dh, auth, deviceLabel(ua), nowIso());
  return devicesOf(userId);
}
export function removePushSub(userId: number, endpoint: unknown): number {
  if (typeof endpoint === 'string') db.prepare(`DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?`).run(userId, endpoint);
  return devicesOf(userId);
}
const devicesOf = (userId: number) => (db.prepare(`SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?`).get(userId) as any).n as number;

/** The short id a device is listed under (the page hashes its own endpoint the same way to find itself). */
export const deviceIdOf = (endpoint: string) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);
/** What Account → Alerts shows (devices by label and short id: the endpoints never leave the server). */
export function pushSettings(user: User) {
  const p = pushPrefs(user.id);
  const devices = (db.prepare(`SELECT endpoint, device, consent_at AS since FROM push_subs WHERE user_id = ? ORDER BY id`).all(user.id) as any[])
    .map(d => ({ id: deviceIdOf(d.endpoint), device: d.device, since: d.since }));
  return {
    on: p.on, starting: p.starting, score: p.score, final: p.final, upset: p.upset, myPicks: p.myPicks,
    quietFrom: p.quietFrom, quietTo: p.quietTo, tz: p.tz, lang: p.lang,
    devices, pro: canSeeFull(accessOf(user)), enabled: pushEnabled, publicKey: pushPublicKey()
  };
}

/** Account deletion / data export (auth.ts calls through tableExists, no import cycle). */
export function deletePushData(userId: number) {
  for (const t of ['push_prefs', 'push_consent_log', 'push_subs', 'push_sends']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId);
}

/* ---------- the games of every sport, one shape ---------- */

const AF_OFFSET = 1_000_000_000;
const tableExists = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
const pc = (v: number) => (v <= 1 ? v * 100 : v);
const FB_OFF = new Set(['PST', 'CANC', 'ABD', 'SUSP', 'INT', 'WO', 'POSTPONED', 'CANCELLED', 'SUSPENDED', 'VOID']);
const FB_DONE = new Set(['FINISHED', 'FT', 'AET', 'PEN', 'AWARDED']);
const base = (o: Partial<Snap> & Pick<Snap, 'sport' | 'id' | 'rid' | 'state' | 'start' | 'league' | 'home' | 'away' | 'teamIds' | 'path'>): Snap =>
  ({ hs: null, as: null, period: null, brk: false, minute: null, late: false, sets: null, lastSet: null, pre: null, winner: null, lastLead: null, ...o });
/** the winner sports' pre-game chances (home win 0..1) in % */
const twoWay = (p: number | null | undefined) => (p == null || !Number.isFinite(p) ? null : { ph: 100 * p, pd: 0, pa: 100 * (1 - p) });

/** Football: the games around now (predictions), the live list of the worker's live loop on top, finals from results. */
export function footballSnaps(now: number): Snap[] {
  const rows = db.prepare(`SELECT p.match_id, p.model, p.competition_name, p.competition_code, p.utc_date, p.home_team_id, p.home_team, p.away_team_id, p.away_team,
      p.p_home, p.p_draw, p.p_away, r.status AS rstatus, r.home_goals, r.away_goals, r.outcome
    FROM predictions p LEFT JOIN results r ON r.match_id = p.match_id WHERE p.utc_date >= ? AND p.utc_date < ?`).all(iso(now - 5 * H), iso(now + 20 * MIN)) as any[];
  const best = new Map<number, any>();
  for (const r of rows) {
    const rank = mainModelRank(r.model, r.utc_date);
    if (rank >= 99) continue; // shadow models are never shown
    const cur = best.get(r.match_id);
    if (!cur || rank < cur.rank) best.set(r.match_id, { ...r, rank });
  }
  const live = new Map<number, any>(liveList('football').map(g => [Number(g.id), g]));
  const out: Snap[] = [];
  for (const r of best.values()) {
    const g = live.get(r.match_id);
    const s = base({
      sport: 'football', id: r.match_id, rid: r.match_id, state: 'pre', start: r.utc_date, league: r.competition_name || r.competition_code || '',
      home: r.home_team, away: r.away_team, teamIds: [r.home_team_id, r.away_team_id].filter(Boolean), path: pubPath(`/match/${r.match_id}`),
      pre: { ph: pc(r.p_home), pd: pc(r.p_draw), pa: pc(r.p_away) }
    });
    const st = String(g?.status || '').toUpperCase();
    if (r.outcome === 'H' || r.outcome === 'D' || r.outcome === 'A') Object.assign(s, { state: 'done', hs: r.home_goals, as: r.away_goals, winner: r.outcome });
    else if (r.outcome === 'VOID' || FB_OFF.has(String(r.rstatus || '').toUpperCase()) || FB_OFF.has(st)) s.state = 'off';
    else if (g) {
      const hs = Number(g.score?.fullTime?.home ?? 0) || 0, as = Number(g.score?.fullTime?.away ?? 0) || 0;
      const minute = Number.isFinite(Number(g.minute)) && g.minute !== null ? Number(g.minute) : null;
      if (FB_DONE.has(st)) Object.assign(s, { state: 'done', hs, as, winner: hs > as ? 'H' : hs < as ? 'A' : 'D' });
      else if (st === 'TIMED' || st === 'SCHEDULED' || st === 'NS') { if (now >= Date.parse(r.utc_date)) continue; }
      else Object.assign(s, { state: 'live', hs, as, minute, late: (minute ?? 0) >= 70 });
    } else if (now >= Date.parse(r.utc_date)) continue; // kicked off, not in the live list yet and no result: no reading
    out.push(s);
  }
  return out;
}

const BB_LIVE: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, OT: 5 };
const BB_DONE = new Set(['FT', 'AOT']), BB_OFF = new Set(['POST', 'CANC', 'ABD', 'AWD', 'SUSP', 'PST']);
export function basketballSnaps(now: number): Snap[] {
  if (!tableExists('bb_games')) return [];
  const pred = tableExists('bb_predictions'), lg = tableExists('bb_leagues');
  const rows = db.prepare(`SELECT g.game_id, g.code, g.kickoff, g.status, g.home_id, g.home_name, g.away_id, g.away_name, g.hs, g.as_, g.timer,
      ${pred ? 'p.p_home' : 'NULL AS p_home'}, ${lg ? 'l.name' : 'NULL'} AS league
    FROM bb_games g ${pred ? 'LEFT JOIN bb_predictions p ON p.game_id = g.game_id' : ''} ${lg ? 'LEFT JOIN bb_leagues l ON l.code = g.code' : ''}
    WHERE g.kickoff >= ? AND g.kickoff < ?`).all(iso(now - 6 * H), iso(now + 20 * MIN)) as any[];
  const out: Snap[] = [];
  for (const r of rows) {
    if (isPreseason({ code: r.code, kickoff: r.kickoff })) continue;
    const st = String(r.status || 'NS').toUpperCase();
    const s = base({
      sport: 'basketball', id: r.game_id, rid: -r.game_id, state: 'pre', start: r.kickoff, league: r.league || r.code, home: r.home_name, away: r.away_name,
      teamIds: [r.home_id, r.away_id], path: pubPath(`/basketball/game/${r.game_id}`), pre: twoWay(r.p_home), hs: r.hs, as: r.as_
    });
    if (st === 'NS') { if (now >= Date.parse(r.kickoff) + 2 * MIN) continue; }
    else if (BB_DONE.has(st)) Object.assign(s, { state: 'done', winner: (r.hs ?? 0) > (r.as_ ?? 0) ? 'H' : 'A' });
    else if (BB_OFF.has(st)) s.state = 'off';
    else if (st in BB_LIVE || st === 'HT' || st === 'BT') {
      const period = BB_LIVE[st] ?? (st === 'HT' ? 2 : null);
      const qlen = period === 5 ? 5 : r.code === 'NBA' ? 12 : 10;
      const left = period && r.timer != null && Number.isFinite(Number(r.timer)) ? Math.max(0, qlen - Number(r.timer)) : null;
      Object.assign(s, { state: 'live', period, brk: st === 'HT' || st === 'BT', minute: left, late: !!period && period >= 4 && left !== null && left <= 3 && !(st === 'HT' || st === 'BT') });
    } else continue; // a status we don't know: no reading
    out.push(s);
  }
  return out;
}

const NFL_LIVE: Record<string, number> = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, OT: 5 };
export function nflSnaps(now: number): Snap[] {
  if (!tableExists('nfl_games')) return [];
  const pred = tableExists('nfl_predictions');
  const other = tableExists('nfl_teams') ? `AND COALESCE(g.home_id, 0) NOT IN (SELECT team_id FROM nfl_teams WHERE level = 'other') AND COALESCE(g.away_id, 0) NOT IN (SELECT team_id FROM nfl_teams WHERE level = 'other')` : '';
  const rows = db.prepare(`SELECT g.game_id, g.league, g.kickoff, g.status, g.clock, g.home_id, g.home_name, g.away_id, g.away_name, g.home_pts, g.away_pts,
      ${pred ? 'p.p_home' : 'NULL AS p_home'}
    FROM nfl_games g ${pred ? 'LEFT JOIN nfl_predictions p ON p.game_id = g.game_id' : ''}
    WHERE g.kickoff >= ? AND g.kickoff < ? AND (g.stage IS NULL OR g.stage NOT LIKE 'Pre%') ${other}`).all(iso(now - 6 * H), iso(now + 20 * MIN)) as any[];
  const out: Snap[] = [];
  for (const r of rows) {
    const st = String(r.status || 'NS').toUpperCase();
    const s = base({
      sport: 'american-football', id: r.game_id, rid: -(2e9 + r.game_id), state: 'pre', start: r.kickoff, league: r.league === 2 ? 'College football' : 'NFL',
      home: r.home_name || 'TBD', away: r.away_name || 'TBD', teamIds: [r.home_id, r.away_id].filter(Boolean), path: pubPath(`/american-football/game/${r.game_id}`),
      pre: twoWay(r.p_home), hs: r.home_pts, as: r.away_pts
    });
    if (st === 'NS') { if (now >= Date.parse(r.kickoff) + 2 * MIN) continue; }
    else if (st === 'FT' || st === 'AOT') Object.assign(s, { state: 'done', winner: (r.home_pts ?? 0) > (r.away_pts ?? 0) ? 'H' : (r.home_pts ?? 0) < (r.away_pts ?? 0) ? 'A' : 'D' });
    else if (st === 'CANC' || st === 'PST' || st === 'SUSP') s.state = 'off';
    else if (st in NFL_LIVE || st === 'HT') {
      const period = NFL_LIVE[st] ?? 2;
      const left = st === 'HT' ? null : clockMinutes(r.clock);
      Object.assign(s, { state: 'live', period, brk: st === 'HT', minute: left === null ? null : Math.round(left), late: period >= 4 && left !== null && left <= 3 });
    } else continue;
    out.push(s);
  }
  return out;
}

const tennisSite = (): typeof import('./tennisSite') => require('./tennisSite'); // the tennis pages pull in the tennis model: loaded when needed
const setOver = (a: number, b: number) => (Math.max(a, b) >= 6 && Math.abs(a - b) >= 2) || Math.max(a, b) === 7 || (Math.max(a, b) >= 10 && Math.abs(a - b) >= 2);
export function tennisSnaps(now: number): Snap[] {
  if (!tableExists('tennis_matches')) return [];
  const ts = tennisSite();
  const list = ts.tennisMatchesBetween(iso(now - 6 * H), iso(now + 20 * MIN), null, false, 2000).filter(m => m.tour !== 'itf');
  const out: Snap[] = [];
  for (const m of ts.withTennisPredictions(list, true)) {
    const p: any = m.prediction;
    const pre = p && Number.isFinite(p.pHome) && Number.isFinite(p.pAway) ? { ph: Number(p.pHome), pd: 0, pa: Number(p.pAway) } : null;
    const done = m.score?.sets.filter(([a, b]) => setOver(a, b)) || [];
    const s = base({
      sport: 'tennis', id: m.id, rid: m.rid, state: m.state === 'upcoming' ? 'pre' : m.state, start: m.start,
      league: [m.tournament.name, m.round].filter(Boolean).join(' · '), home: m.home.name, away: m.away.name,
      teamIds: [m.home.id, m.away.id].filter((x): x is number => !!x), path: pubPath(`/tennis/match/${m.id}`), pre,
      sets: m.score ? [m.score.won[0], m.score.won[1]] : null, lastSet: done.length ? done[done.length - 1] : null,
      winner: m.winner === 1 ? 'H' : m.winner === 2 ? 'A' : null
    });
    if (s.state === 'pre' && now >= Date.parse(m.start) + 2 * MIN) continue; // late start: wait for the live reading
    const toWin = m.bestOf === 5 ? 3 : 2;
    s.late = s.state === 'live' && !!s.sets && Math.max(...s.sets) >= toWin - 1;
    out.push(s);
  }
  return out;
}

const READERS: Record<PSport, (now: number) => Snap[]> = { football: footballSnaps, basketball: basketballSnaps, 'american-football': nflSnaps, tennis: tennisSnaps };

/* ---------- who gets what ---------- */

export interface Person {
  user: User; prefs: PushPrefs; access: Access; unlocked: Set<number>
  fav: Record<PSport, Set<number>>; picks: Record<PSport, Set<number>>
}
export function personOf(user: User, prefs = pushPrefs(user.id)): Person {
  const access = accessOf(user);
  const favs = listFavorites(user.id);
  const ids = (kinds: string[]) => new Set(favs.filter(f => kinds.includes(f.kind)).flatMap(f => (f.kind.endsWith('player') && f.kind !== 'tennis-player' ? f.teamIds || [] : f.ids?.length ? f.ids : [Number(f.ref)])).filter(n => Number.isInteger(n) && n > 0));
  const fbIds = [...ids(['team', 'player'])];
  const picks: Record<PSport, Set<number>> = { football: new Set(), basketball: new Set(), 'american-football': new Set(), tennis: new Set() };
  if (prefs.myPicks && tableExists('user_picks')) {
    const map: Record<string, PSport> = { fb: 'football', bb: 'basketball', nfl: 'american-football' };
    for (const r of db.prepare(`SELECT DISTINCT sport, game_id FROM user_picks WHERE user_id = ? AND kickoff >= ?`).all(user.id, iso(Date.now() - 2 * DAY)) as any[]) if (map[r.sport]) picks[map[r.sport]].add(Number(r.game_id));
  }
  return {
    user, prefs, access, unlocked: canSeeFull(access) ? new Set<number>() : unlockedIds(user.id), picks,
    fav: { football: fbIds.length ? footballTeamIds(fbIds) : new Set<number>(), basketball: ids(['bb-team', 'bb-player']), 'american-football': ids(['nfl-team', 'nfl-player']), tennis: ids(['tennis-player']) }
  };
}
/** Does this event go to this person? Their switch, the sport open for them, a favourite (or their own pick), Pro for upsets. */
export function wants(p: Person, e: Pick<PEvent, 'sport' | 'kind' | 'gameId'> & { snap: Pick<Snap, 'teamIds'> }): boolean {
  if (!p.prefs.on || !p.prefs[SWITCH[e.kind]]) return false;
  if (!sportOpen(e.sport, !!p.user.isAdmin)) return false;
  if (e.kind === 'upset' && !canSeeFull(p.access)) return false;
  return e.snap.teamIds.some(id => p.fav[e.sport].has(id)) || (p.prefs.myPicks && p.picks[e.sport].has(e.gameId));
}
/** May the pick be in a "starting" alert? Pro / admins, or a game the person unlocked. */
export const showPickFor = (p: Person, s: Pick<Snap, 'rid'>) => canSeeFull(p.access) || p.unlocked.has(s.rid);

const linkTo = (lang: PushLang, path: string) => `${lang === 'en' ? '' : `/${lang}`}${path}?utm_source=push&utm_medium=push&utm_campaign=alerts`;
/** The notification payload for one person (the service worker shows it). */
export function payloadFor(p: Person, e: PEvent): { title: string; body: string; url: string; tag: string; kind: PKind } {
  const n = noteOf(e, { tx: pushWords(p.prefs.lang), lang: p.prefs.lang, tz: p.prefs.tz, showPick: showPickFor(p, e.snap) });
  return { ...n, url: linkTo(p.prefs.lang, e.snap.path), tag: `${e.sport}-${e.gameId}`, kind: e.kind };
}

/* ---------- the tick (worker) ---------- */

const st = {
  ticks: 0, lastAt: null as string | null, lastMs: 0, games: 0, events: 0, queued: 0, sent: 0, failed: 0, lastError: null as string | null,
  bySport: {} as Record<string, number>
};
let busy = false;

/** Read every sport, store the new events, queue them for the people they concern. Returns the new events. */
export async function detectEvents(now = Date.now()): Promise<PEvent[]> {
  const step = yieldEvery(50, 100, { live: true });
  const prevRows = db.prepare(`SELECT sport, id, json FROM push_game_state`).all() as any[];
  const prev = new Map<string, Snap>();
  for (const r of prevRows) { try { prev.set(`${r.sport}:${r.id}`, JSON.parse(r.json)); } catch { /* skipped */ } }
  const save = db.prepare(`INSERT INTO push_game_state (sport, id, json, at) VALUES (?, ?, ?, ?) ON CONFLICT (sport, id) DO UPDATE SET json = excluded.json, at = excluded.at`);
  const addEv = db.prepare(`INSERT OR IGNORE INTO push_events (sport, game_id, kind, key, at, snap, side) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const fresh: (PEvent & { eventId: number })[] = [];
  for (const sport of PUSH_SPORTS) {
    let snaps: Snap[] = [];
    try { snaps = READERS[sport](now); } catch (e: any) { st.lastError = `${sport}: ${e?.message || e}`; logger.warn(`push alerts: ${sport} games: ${e?.message || e}`); continue; }
    st.bySport[sport] = snaps.length;
    db.exec('BEGIN');
    try {
      for (const s of snaps) {
        const before = prev.get(`${sport}:${s.id}`) || null;
        for (const e of eventsOf(before, s, now)) {
          const r = addEv.run(sport, s.id, e.kind, e.key, iso(now), JSON.stringify(e.snap), e.side || null);
          if (r.changes) fresh.push({ ...e, eventId: Number(r.lastInsertRowid) });
        }
        save.run(sport, s.id, JSON.stringify(withLead(s, before)), now);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    await step();
  }
  db.prepare(`DELETE FROM push_game_state WHERE at < ?`).run(now - 2 * DAY);
  st.games = Object.values(st.bySport).reduce((a, b) => a + b, 0);
  if (fresh.length) queueEvents(fresh, now);
  st.events += fresh.length;
  return fresh;
}

/** The people with alerts on and at least one device. */
export function audience(): Person[] {
  const rows = db.prepare(`SELECT p.* FROM push_prefs p WHERE p.on_ = 1 AND EXISTS (SELECT 1 FROM push_subs s WHERE s.user_id = p.user_id)`).all() as any[];
  const out: Person[] = [];
  for (const r of rows) { const u = userById(r.user_id); if (u) out.push(personOf(u, rowToPrefs(r))); }
  return out;
}

/** One row per person and event: queued (a final in quiet hours is due when they end; anything else is not sent). */
export function queueEvents(events: (PEvent & { eventId: number })[], now = Date.now(), people = audience()): number {
  const ins = db.prepare(`INSERT OR IGNORE INTO push_sends (user_id, event_id, kind, created_at, due_at, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const e of events) for (const p of people) {
    if (!wants(p, e)) continue;
    const q = { from: p.prefs.quietFrom, to: p.prefs.quietTo, tz: p.prefs.tz };
    const quiet = inQuiet(q, now);
    const due = quiet && e.kind === 'final' ? quietEnd(q, now) : now;
    if (ins.run(p.user.id, e.eventId, e.kind, iso(now), iso(due), quiet && e.kind !== 'final' ? 'quiet' : 'queued', quiet ? 'quiet hours' : null).changes) n++;
  }
  st.queued += n;
  return n;
}

const EXPIRE: Record<PKind, number> = { start: 20 * MIN, score: 10 * MIN, upset: 15 * MIN, final: 18 * H };
const TTL: Record<PKind, number> = { start: 900, score: 600, upset: 900, final: 12 * 3600 };

export type Poster = (url: string, body: Buffer, headers: Record<string, string>) => Promise<{ status: number }>;
const realPost: Poster = (url, body, headers) => axios.post(url, body, { headers, timeout: 10000, validateStatus: () => true, maxRedirects: 0 }).then(r => ({ status: r.status }));

/** Send one payload to every device of a person. 201 = delivered to the push service; 404 / 410 = the device is gone. */
export async function sendToDevices(userId: number, payload: object, o: { kind: PKind; topic?: string }, post: Poster = realPost): Promise<{ ok: number; fail: number; gone: number }> {
  const subs = db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?`).all(userId) as any[];
  let ok = 0, fail = 0, gone = 0;
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      const headers: Record<string, string> = {
        Authorization: vapidAuth(s.endpoint, VAPID), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        TTL: String(TTL[o.kind]), Urgency: o.kind === 'final' ? 'normal' : 'high', ...(o.topic ? { Topic: o.topic } : {})
      };
      const r = await post(s.endpoint, encryptPayload(body, s), headers);
      if (r.status >= 200 && r.status < 300) { ok++; db.prepare(`UPDATE push_subs SET last_ok_at = ?, fails = 0 WHERE id = ?`).run(nowIso(), s.id); }
      else if (r.status === 404 || r.status === 410) { gone++; db.prepare(`DELETE FROM push_subs WHERE id = ?`).run(s.id); }
      else { fail++; db.prepare(`UPDATE push_subs SET fails = fails + 1 WHERE id = ?`).run(s.id); }
    } catch (e: any) { fail++; db.prepare(`UPDATE push_subs SET fails = fails + 1 WHERE id = ?`).run(s.id); st.lastError = `send: ${e?.message || e}`; }
  }
  // a device that failed 30 times in a row is dropped (it would never come back)
  db.prepare(`DELETE FROM push_subs WHERE user_id = ? AND fails >= 30`).run(userId);
  return { ok, fail, gone };
}

/**
 * Send what is due: per person at most one push a minute (the oldest due first; older score updates of the same game
 * are merged into the newest; a stale one expires), quiet hours checked again, the switch checked again.
 */
export async function sendDue(now = Date.now(), post: Poster = realPost): Promise<{ sent: number; failed: number }> {
  const rows = db.prepare(`SELECT s.id, s.user_id, s.event_id, s.kind, s.created_at, s.due_at, e.sport, e.game_id, e.key, e.snap, e.side
    FROM push_sends s JOIN push_events e ON e.id = s.event_id WHERE s.status = 'queued' AND s.due_at <= ? ORDER BY s.due_at, s.id`).all(iso(now)) as any[];
  if (!rows.length) return { sent: 0, failed: 0 };
  const mark = db.prepare(`UPDATE push_sends SET status = ?, reason = ?, sent_at = ?, ok_n = ?, fail_n = ?, gone_n = ? WHERE id = ?`);
  const later = db.prepare(`UPDATE push_sends SET due_at = ?, reason = 'quiet hours' WHERE id = ?`);
  const lastSent = db.prepare(`SELECT MAX(sent_at) AS at FROM push_sends WHERE user_id = ? AND status IN ('sent', 'failed')`);
  const byUser = new Map<number, any[]>();
  for (const r of rows) { const l = byUser.get(r.user_id) || []; l.push(r); byUser.set(r.user_id, l); }
  let sent = 0, failed = 0;
  for (const [userId, list] of byUser) {
    // stale ones expire, older score updates of a game give way to the newest
    const live: any[] = [];
    const newestScore = new Map<string, number>();
    for (const r of list) if (r.kind === 'score') newestScore.set(`${r.sport}:${r.game_id}`, r.id);
    for (const r of list) {
      if (now - Date.parse(r.created_at) > EXPIRE[r.kind as PKind]) { mark.run('expired', 'too old', null, 0, 0, 0, r.id); continue; }
      if (r.kind === 'score' && newestScore.get(`${r.sport}:${r.game_id}`) !== r.id) { mark.run('merged', 'a newer score of the game', null, 0, 0, 0, r.id); continue; }
      live.push(r);
    }
    if (!live.length) continue;
    const last = (lastSent.get(userId) as any)?.at;
    if (last && now - Date.parse(last) < MIN) continue; // 1 push a minute
    const user = userById(userId);
    if (!user) { for (const r of live) mark.run('dropped', 'no account', null, 0, 0, 0, r.id); continue; }
    const p = personOf(user);
    const r = live[0];
    const e: PEvent = { sport: r.sport, gameId: r.game_id, kind: r.kind, key: r.key, snap: JSON.parse(r.snap), ...(r.side ? { side: r.side } : {}) };
    if (!p.prefs.on || !p.prefs[SWITCH[e.kind]]) { mark.run('dropped', 'switched off', null, 0, 0, 0, r.id); continue; }
    const q = { from: p.prefs.quietFrom, to: p.prefs.quietTo, tz: p.prefs.tz };
    if (inQuiet(q, now)) {
      if (e.kind === 'final') later.run(iso(quietEnd(q, now)), r.id); else mark.run('quiet', 'quiet hours', null, 0, 0, 0, r.id);
      continue;
    }
    const res = await sendToDevices(userId, payloadFor(p, e), { kind: e.kind, topic: e.kind === 'score' ? `${e.sport.slice(0, 2)}${e.gameId}`.replace(/[^A-Za-z0-9_-]/g, '') : undefined }, post);
    const okAny = res.ok > 0;
    mark.run(okAny ? 'sent' : res.fail ? 'failed' : 'dropped', okAny ? null : res.fail ? 'push service error' : 'no device', iso(now), res.ok, res.fail, res.gone, r.id);
    if (okAny) sent++; else if (res.fail) failed++;
  }
  st.sent += sent; st.failed += failed;
  // fix239: a delivery problem (10+ people's alerts failed in one run, most of the run) → one admin email a day
  if (failed >= 10 && failed * 2 >= sent + failed) void alertOncePerDay('push-failed', `Site problem: ${failed} push alerts failed`, {
    label: 'Push alerts', tone: 'fail', title: `${failed} of ${sent + failed} push alerts failed`,
    what: `The push services refused alerts for ${failed} people in one run (${israelTime(now)}); the reasons are in Admin → Emails & alerts.`,
    todo: 'Tell Claude — usually the VAPID keys or a push service outage (never change the keys yourself).',
    buttons: [{ text: 'Open alerts in Admin', href: adminUrl('messages') }]
  }, now);
  return { sent, failed };
}

/** The worker job (every 20 s, with the live loop): read, detect, queue, send. Never the web process. */
export async function pushAlertsTick(now = Date.now(), post: Poster = realPost) {
  if (!runsJobs || busy) return null;
  busy = true;
  const t0 = Date.now();
  try {
    await detectEvents(now);
    if (pushEnabled || post !== realPost) await sendDue(now, post);
    // keep 60 days of events / sends (the admin numbers)
    if (st.ticks % 180 === 0) {
      db.prepare(`DELETE FROM push_sends WHERE created_at < ?`).run(iso(now - 60 * DAY));
      db.prepare(`DELETE FROM push_events WHERE at < ? AND id NOT IN (SELECT event_id FROM push_sends)`).run(iso(now - 60 * DAY));
    }
    st.ticks++;
    st.lastAt = iso(now);
    st.lastMs = Date.now() - t0;
    return st;
  } catch (e: any) {
    st.lastError = e?.message || String(e);
    throw e;
  } finally { busy = false; }
}

/* ---------- admin ---------- */

/** "Send me a test": a test alert to the admin's own devices (worker; the switches are not needed). */
export async function sendTestPush(admin: User, post: Poster = realPost) {
  if (!pushEnabled && post === realPost) throw new PushError(503, 'Push alerts are not configured on the server (VAPID_PUBLIC / VAPID_PRIVATE).');
  const lang = pushPrefs(admin.id).lang;
  const tx = pushWords(lang);
  return sendToDevices(admin.id, { title: tx('Test alert'), body: tx('Alerts are working on this device.'), url: linkTo(lang, '/account/alerts'), tag: 'test', kind: 'start' }, { kind: 'start' }, post);
}

export function pushAdminStats(days = 14) {
  const since = iso(Date.now() - days * DAY);
  const perDay = db.prepare(`SELECT substr(created_at, 1, 10) AS day, kind, status, COUNT(*) AS n, SUM(ok_n) AS ok, SUM(fail_n) AS fail, SUM(gone_n) AS gone
    FROM push_sends WHERE created_at >= ? GROUP BY 1, 2, 3 ORDER BY 1 DESC`).all(since) as any[];
  const days_ = new Map<string, any>();
  for (const r of perDay) {
    const d = days_.get(r.day) || { day: r.day, sent: 0, failed: 0, quiet: 0, merged: 0, expired: 0, dropped: 0, queued: 0, devicesOk: 0, devicesFailed: 0, devicesGone: 0, byKind: {} as Record<string, number> };
    d[r.status] = (d[r.status] || 0) + r.n;
    if (r.status === 'sent') d.byKind[r.kind] = (d.byKind[r.kind] || 0) + r.n;
    d.devicesOk += r.ok || 0; d.devicesFailed += r.fail || 0; d.devicesGone += r.gone || 0;
    days_.set(r.day, d);
  }
  const opted = db.prepare(`SELECT COUNT(*) AS n, SUM(starting) AS starting, SUM(score) AS score, SUM(final) AS final, SUM(upset) AS upset, SUM(my_picks) AS myPicks FROM push_prefs WHERE on_ = 1`).get() as any;
  return {
    enabled: pushEnabled, tick: { ...st, bySport: { ...st.bySport } },
    optedIn: { people: opted?.n || 0, starting: opted?.starting || 0, score: opted?.score || 0, final: opted?.final || 0, upset: opted?.upset || 0, myPicks: opted?.myPicks || 0 },
    devices: (db.prepare(`SELECT COUNT(*) AS n FROM push_subs`).get() as any).n,
    perDay: [...days_.values()].sort((a, b) => b.day.localeCompare(a.day)),
    failures: db.prepare(`SELECT s.user_id AS userId, s.kind, s.created_at AS at, s.status, s.reason, s.fail_n AS failed FROM push_sends s WHERE s.status = 'failed' OR s.fail_n > 0 ORDER BY s.id DESC LIMIT 30`).all(),
    recentEvents: db.prepare(`SELECT sport, game_id AS gameId, kind, key, at FROM push_events ORDER BY id DESC LIMIT 30`).all()
  };
}

/* ---------- data health ---------- */

export function pushHealth(now = Date.now()): Check[] {
  if (!pushEnabled) return [{ id: 'push-delivery', label: 'Push delivery', level: 'ok', detail: 'Push alerts are not configured on this server (VAPID_PUBLIC / VAPID_PRIVATE)' }];
  const since = iso(now - 7 * DAY);
  const d = db.prepare(`SELECT SUM(ok_n) AS ok, SUM(fail_n) AS fail, SUM(gone_n) AS gone FROM push_sends WHERE created_at >= ?`).get(since) as any;
  const ok = d?.ok || 0, fail = d?.fail || 0, tries = ok + fail, rate = tries ? (100 * fail) / tries : 0;
  const checks: Check[] = [{
    id: 'push-delivery', label: 'Push delivery', level: rate > 5 ? 'warn' : 'ok',
    detail: tries ? `${fail} of ${tries} device sends failed in 7 days (${rate.toFixed(1)}%), ${d?.gone || 0} device(s) gone and removed` : 'No alerts sent in 7 days'
  }];
  // no event reaches a person twice: one row per person and event (UNIQUE), one event per game and key (UNIQUE) —
  // checked on the rows themselves, and the same notification (game + key) never sent twice to one person
  const dup = db.prepare(`SELECT s.user_id, e.sport, e.game_id, e.key, COUNT(*) AS n FROM push_sends s JOIN push_events e ON e.id = s.event_id
    WHERE s.status = 'sent' AND s.created_at >= ? GROUP BY 1, 2, 3, 4 HAVING COUNT(*) > 1 LIMIT 20`).all(since) as any[];
  checks.push({
    id: 'push-dedupe', label: 'Push dedupe', level: dup.length ? 'warn' : 'ok',
    detail: dup.length ? `${dup.length} alert(s) reached the same person twice in 7 days` : 'No alert sent twice to anyone (7 days)',
    items: dup.map(r => `user ${r.user_id}: ${r.sport} ${r.game_id} ${r.key} × ${r.n}`)
  });
  return checks;
}

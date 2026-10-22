/**
 * fix200: games past kick-off + 48 h with no final score ("phantom" fixtures: Abha – Al-Faisaly 11 Oct, Atromitos – AEK
 * 17 Oct … stayed unsettled for a week and data health failed every run). The rules are in utils/voidRules.ts; this
 * asks the provider (by fixture id, then by the two teams within ±3 days) and applies the answer:
 *   final → settled normally · postponed / cancelled with a later date → the new kick-off · else void (with the reason)
 *   · not found → one attempt a day, void after 3 days.
 * Void = results.outcome 'VOID' + results.reason: every accuracy query reads outcome IN ('H','D','A') only, the results
 * pages too, and My picks leaves void games out; admins see them at /api/admin/voided.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { decide, kindOfStatus, sameDay, sameTeamName, Lookup, Decision, TEAM_WINDOW_DAYS, VOID_AFTER_MS } from '../utils/voidRules';

const AF_OFFSET = 1_000_000_000;
const DAY = 86400000;

db.exec(`CREATE TABLE IF NOT EXISTS settle_lookups (match_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, last_day TEXT, note TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settle_meta (k TEXT PRIMARY KEY, v TEXT, at TEXT NOT NULL)`);
if (!(db.prepare(`PRAGMA table_info(results)`).all() as any[]).some(c => c.name === 'reason')) db.exec(`ALTER TABLE results ADD COLUMN reason TEXT`);

/** The provider calls, injected (index.ts wires API-Football / Football-Data.org; tests pass fakes). */
export interface Providers {
  /** API-Football fixtures by id (ids without the offset), up to 20 */
  afByIds(ids: number[]): Promise<any[]>;
  /** API-Football fixtures between two teams (ids without the offset), dates YYYY-MM-DD */
  afByTeams(home: number, away: number, from: string, to: string): Promise<any[]>;
  /** Football-Data.org matches between two dates (YYYY-MM-DD) */
  fdRange(from: string, to: string): Promise<any[]>;
}

interface Pending { match_id: number; utc_date: string; home_id: number | null; away_id: number | null; home: string | null; away: string | null; comp: string | null }

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** API-Football fixture → lookup */
function afLookup(f: any, via: 'id' | 'teams'): Lookup {
  const raw = String(f?.fixture?.status?.short || '');
  const kind = kindOfStatus(raw);
  const id = f?.fixture?.id ? AF_OFFSET + f.fixture.id : undefined;
  if (kind === 'final') {
    const h = f.score?.fulltime?.home ?? f.goals?.home, a = f.score?.fulltime?.away ?? f.goals?.away;
    if (h == null || a == null) return { kind: 'open', raw, date: f?.fixture?.date || null, via, id };
    return { kind, home: h, away: a, raw, via, id };
  }
  return { kind, raw, date: f?.fixture?.date || null, via, id };
}
/** Football-Data.org match → lookup (1X2 on the 90-minute score, as the settle job) */
function fdLookup(m: any, via: 'id' | 'teams'): Lookup {
  const raw = String(m?.status || '');
  const kind = kindOfStatus(raw);
  if (kind === 'final') {
    const s = m.score?.duration && m.score.duration !== 'REGULAR' && m.score.regularTime ? m.score.regularTime : m.score?.fullTime;
    if (s?.home == null || s?.away == null) return { kind: 'open', raw, date: m.utcDate || null, via, id: m.id };
    return { kind, home: s.home, away: s.away, raw, via, id: m.id };
  }
  return { kind, raw, date: m.utcDate || null, via, id: m.id };
}
const rank = (l: Lookup) => (!l ? 9 : l.kind === 'final' ? 0 : l.kind === 'off' ? 1 : 2);
/** of several candidates: a final first, then the nearest date to our kick-off */
function best(cands: { l: Lookup; date: string | null }[], kickoff: string): Lookup {
  const ko = Date.parse(kickoff);
  return cands.sort((a, b) => rank(a.l) - rank(b.l) || Math.abs(Date.parse(a.date || '') - ko) - Math.abs(Date.parse(b.date || '') - ko))[0]?.l ?? null;
}

/** What the provider says about one game (rule 1: by id; nothing or another date → by the two teams). */
export async function lookupGame(p: Providers, g: Pending, byId: any | null, fdList?: any[]): Promise<Lookup> {
  const ko = Date.parse(g.utc_date);
  const from = day(ko - TEAM_WINDOW_DAYS * DAY), to = day(ko + TEAM_WINDOW_DAYS * DAY);
  const af = g.match_id >= AF_OFFSET;
  const idL: Lookup = byId ? (af ? afLookup(byId, 'id') : fdLookup(byId, 'id')) : null;
  const idDate = byId ? (af ? byId?.fixture?.date : byId?.utcDate) : null;
  // by id on our day is the answer (final, postponed, or still open → another attempt); a final on another day too
  if (idL && (sameDay(idDate, g.utc_date) || idL.kind === 'final')) return idL;
  // a provider error throws: the caller skips the game this run (an outage is not an attempt)
  let teams: Lookup = null;
  if (af) {
    if (g.home_id && g.away_id && g.home_id >= AF_OFFSET && g.away_id >= AF_OFFSET) {
      const list = await p.afByTeams(g.home_id - AF_OFFSET, g.away_id - AF_OFFSET, from, to);
      // the same home side (a return leg the other way round is another game)
      const mine = list.filter(f => f?.teams?.home?.id === g.home_id! - AF_OFFSET && f?.teams?.away?.id === g.away_id! - AF_OFFSET);
      teams = best(mine.map(f => ({ l: afLookup(f, 'teams'), date: f?.fixture?.date || null })), g.utc_date);
    }
  } else {
    const list = fdList ?? await p.fdRange(from, to);
    const mine = list.filter(m => (g.home_id && m.homeTeam?.id === g.home_id && m.awayTeam?.id === g.away_id)
      || (sameTeamName(m.homeTeam?.name ?? m.homeTeam?.shortName, g.home) && sameTeamName(m.awayTeam?.name ?? m.awayTeam?.shortName, g.away)));
    teams = best(mine.map(m => ({ l: fdLookup(m, m.id === g.match_id ? 'id' : 'teams'), date: m.utcDate || null })), g.utc_date);
  }
  if (teams && (teams.kind !== 'open' || !idL)) return teams;
  return idL || teams;
}

const insertResult = db.prepare(`INSERT OR REPLACE INTO results (match_id, status, home_goals, away_goals, outcome, settled_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const markSettled = db.prepare(`UPDATE predictions SET settled = 1, locked = 1, updated_at = ? WHERE match_id = ?`);
const moveStmt = db.prepare(`UPDATE predictions SET utc_date = ?, locked = 0, updated_at = ? WHERE match_id = ? AND settled = 0`);
const getTry = db.prepare(`SELECT attempts, last_day FROM settle_lookups WHERE match_id = ?`);
const putTry = db.prepare(`INSERT OR REPLACE INTO settle_lookups (match_id, attempts, last_day, note, updated_at) VALUES (?, ?, ?, ?, ?)`);
const dropTry = db.prepare(`DELETE FROM settle_lookups WHERE match_id = ?`);

/** Apply one decision (one short transaction per game). */
export function applyDecision(matchId: number, d: Decision, now: number): void {
  const at = new Date(now).toISOString();
  db.exec('BEGIN');
  try {
    if (d.action === 'settle') {
      insertResult.run(matchId, d.raw, d.home, d.away, d.home > d.away ? 'H' : d.home < d.away ? 'A' : 'D', at, null);
      markSettled.run(at, matchId);
      dropTry.run(matchId);
    } else if (d.action === 'void') {
      insertResult.run(matchId, 'VOID', null, null, 'VOID', at, d.reason);
      markSettled.run(at, matchId);
      dropTry.run(matchId);
    } else if (d.action === 'move') {
      moveStmt.run(d.date, at, matchId);
      dropTry.run(matchId);
    } else if (d.action === 'retry') {
      putTry.run(matchId, d.attempts, day(now), d.note, at);
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
}

/** Games past kick-off + 48 h, not settled (one row per match). */
export function overdueGames(now = Date.now()): Pending[] {
  return db.prepare(`SELECT match_id, MAX(utc_date) AS utc_date, MAX(home_team_id) AS home_id, MAX(away_team_id) AS away_id, MAX(home_team) AS home,
      MAX(away_team) AS away, MAX(competition_name) AS comp FROM predictions WHERE settled = 0 GROUP BY match_id HAVING MAX(utc_date) < ? ORDER BY utc_date`)
    .all(new Date(now - VOID_AFTER_MS).toISOString()) as Pending[];
}

let running = false;
/**
 * Every game past kick-off + 48 h without a final: look it up and settle / move / void / retry. Returns one line per
 * game ("Abha – Al-Faisaly (Pro League, 2026-10-11): void — not found …"), logged when `log`.
 */
export async function resolveUnsettled(p: Providers, opts: { now?: number; log?: boolean; tag?: string; max?: number } = {}) {
  const out = { checked: 0, settled: 0, moved: 0, voided: 0, retry: 0, lines: [] as string[] };
  if (running) return out;
  running = true;
  try {
    const now = opts.now ?? Date.now();
    const games = overdueGames(now).slice(0, opts.max ?? 60);
    if (!games.length) return out;
    // fixture ids first, 20 per call (API-Football); Football-Data.org by date range per game
    const byId = new Map<number, any>();
    let afDown = false;
    const af = games.filter(g => g.match_id >= AF_OFFSET).map(g => g.match_id - AF_OFFSET);
    for (let i = 0; i < af.length; i += 20) {
      try { for (const f of await p.afByIds(af.slice(i, i + 20))) if (f?.fixture?.id) byId.set(AF_OFFSET + f.fixture.id, f); }
      catch (e: any) { afDown = true; logger.warn(`unsettled: fixtures by id failed: ${e.message}`); break; }
    }
    for (const g of games) {
      // a provider error skips the game this run: an outage is not an attempt
      if (afDown && g.match_id >= AF_OFFSET) continue;
      let id = byId.get(g.match_id) ?? null;
      let fdList: any[] | undefined;
      if (g.match_id < AF_OFFSET) {
        // Football-Data.org: one range call (±3 days) answers both the id and the two teams
        const ko = Date.parse(g.utc_date);
        try { fdList = await p.fdRange(day(ko - TEAM_WINDOW_DAYS * DAY), day(ko + TEAM_WINDOW_DAYS * DAY)); id = fdList.find(m => m.id === g.match_id) ?? null; }
        catch (e: any) { logger.warn(`unsettled ${g.match_id}: ${e.message}`); continue; }
      }
      let found: Lookup;
      try { found = await lookupGame(p, g, id, fdList); } catch (e: any) { logger.warn(`unsettled ${g.match_id}: team search failed: ${e.message}`); continue; }
      out.checked++;
      const t = getTry.get(g.match_id) as any;
      const d = decide(found, { kickoff: g.utc_date, attempts: t?.attempts || 0, lastDay: t?.last_day || null, now });
      if (d.action === 'wait') continue;
      applyDecision(g.match_id, d, now);
      if (d.action === 'settle') out.settled++; else if (d.action === 'move') out.moved++; else if (d.action === 'void') out.voided++; else out.retry++;
      const what = d.action === 'settle' ? `settled — ${d.note}` : d.action === 'move' ? `kick-off moved — ${d.note}` : d.action === 'void' ? `void — ${d.reason}` : `retry — ${d.note}`;
      const line = `${g.home} – ${g.away} (${g.comp || '?'}, ${String(g.utc_date).slice(0, 10)}, id ${g.match_id}): ${what}`;
      out.lines.push(line);
      if (opts.log) logger.info(`${opts.tag || 'unsettled'}: ${line}`);
    }
    return out;
  } finally { running = false; }
}

/** fix200: once per database, right after the deploy — the six games stuck since 11–19 Oct, each logged. */
export async function resolveUnsettledOnce(p: Providers) {
  if (db.prepare(`SELECT 1 FROM settle_meta WHERE k = 'fix200_once'`).get()) return null;
  const r = await resolveUnsettled(p, { log: true, tag: 'fix200 one-time' });
  db.prepare(`INSERT OR REPLACE INTO settle_meta (k, v, at) VALUES ('fix200_once', ?, ?)`).run(JSON.stringify(r), new Date().toISOString());
  logger.info(`fix200 one-time: ${r.checked} checked · ${r.settled} settled · ${r.moved} moved · ${r.voided} void · ${r.retry} to retry`);
  return r;
}

/** Admin: voided games (newest first) with the reason. */
export function voidedGames(days = 90) {
  return db.prepare(`SELECT r.match_id AS id, r.status, r.reason, r.settled_at AS voidedAt, MAX(p.utc_date) AS kickoff, MAX(p.home_team) AS home, MAX(p.away_team) AS away,
      MAX(p.competition_name) AS competition FROM results r JOIN predictions p ON p.match_id = r.match_id
    WHERE r.outcome = 'VOID' AND r.settled_at >= ? GROUP BY r.match_id ORDER BY r.settled_at DESC LIMIT 500`).all(new Date(Date.now() - days * DAY).toISOString()) as any[];
}
/** Admin: games waiting for another lookup (attempts so far). */
export function pendingLookups() {
  return db.prepare(`SELECT match_id AS id, attempts, last_day AS lastDay, note, updated_at AS at FROM settle_lookups ORDER BY updated_at DESC LIMIT 200`).all() as any[];
}
/** Data health: games voided since the 1st of this month (UTC). */
export function voidedThisMonth(now = Date.now()): number {
  const d = new Date(now);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
  return (db.prepare(`SELECT COUNT(*) AS n FROM results WHERE outcome = 'VOID' AND settled_at >= ?`).get(first) as any).n;
}

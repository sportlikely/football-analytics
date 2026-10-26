/**
 * fix200: games past kick-off + 48 h with no final score ("phantom" fixtures: Abha – Al-Faisaly 11 Oct, Atromitos – AEK
 * 17 Oct … stayed unsettled for a week and data health failed every run). The rules are in utils/voidRules.ts; this
 * asks the provider (by fixture id, then by the two teams within ±3 days) and applies the answer:
 *   final → settled normally · postponed / cancelled with a later date → the new kick-off · else void (with the reason)
 * Void = results.outcome 'VOID' + results.reason: every accuracy query reads outcome IN ('H','D','A') only, the results
 * pages too, and My picks leaves void games out; admins see them at /api/admin/voided.
 *
 * fix240 (Slovan Liberec – Baník Ostrava and Morton – Ayr, 24 Oct: no final from API-Football by fixture id, nothing
 * looked again before 48 h, data health red at 48 h): the lookups start at kick-off + 24 h and ask both providers — the
 * game's own provider by id and by the two teams, and the other provider's twin (fd_af_links) when there is one. Still
 * nothing at 48 h → settle_review: Admin → Needs you lists the game with "Enter result" / "Void" (and one email with a
 * Void button); the lookups go on, and a final that shows up later settles the game and closes the item.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { decide, kindOfStatus, sameDay, sameTeamName, Lookup, Decision, TEAM_WINDOW_DAYS, REFETCH_AFTER_MS } from '../utils/voidRules';
import { actionLink, adminUrl, israelTime, onEmailAction, sendAdminMail, siteUrl, type AdminMail } from './adminMail';

const AF_OFFSET = 1_000_000_000;
const DAY = 86400000;

db.exec(`CREATE TABLE IF NOT EXISTS settle_lookups (match_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, last_day TEXT, note TEXT, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settle_meta (k TEXT PRIMARY KEY, v TEXT, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settle_review (match_id INTEGER PRIMARY KEY, note TEXT, found_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT, by_user TEXT)`);
if (!(db.prepare(`PRAGMA table_info(results)`).all() as any[]).some(c => c.name === 'reason')) db.exec(`ALTER TABLE results ADD COLUMN reason TEXT`);

/** The provider calls, injected (jobs.ts wires API-Football / Football-Data.org; tests pass fakes). */
export interface Providers {
  /** API-Football fixtures by id (ids without the offset), up to 20 */
  afByIds(ids: number[]): Promise<any[]>;
  /** API-Football fixtures between two teams (ids without the offset), dates YYYY-MM-DD */
  afByTeams(home: number, away: number, from: string, to: string): Promise<any[]>;
  /** Football-Data.org matches between two dates (YYYY-MM-DD) */
  fdRange(from: string, to: string): Promise<any[]>;
  /** fix240: the same game at the other provider (FD id ↔ API-Football id with the offset), from the stored links */
  twinOf?(matchId: number): number | null;
}

interface Pending { match_id: number; utc_date: string; home_id: number | null; away_id: number | null; home: string | null; away: string | null; comp: string | null }

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** API-Football fixture → lookup */
function afLookup(f: any, via: 'id' | 'teams' | 'twin'): Lookup {
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
function fdLookup(m: any, via: 'id' | 'teams' | 'twin'): Lookup {
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

/**
 * What the providers say about one game (rule 1: by id; nothing or another date → by the two teams).
 * fix240: `twin` = the same game at the other provider (an API-Football fixture for a Football-Data game, a Football-Data
 * match for an API-Football game); its final settles the game when the game's own provider has none.
 */
export async function lookupGame(p: Providers, g: Pending, byId: any | null, fdList?: any[], twin?: any | null): Promise<Lookup> {
  const own = await ownLookup(p, g, byId, fdList);
  if (own?.kind === 'final' || !twin) return own;
  const t = g.match_id >= AF_OFFSET ? fdLookup(twin, 'twin') : afLookup(twin, 'twin');
  const tDate = g.match_id >= AF_OFFSET ? twin?.utcDate : twin?.fixture?.date;
  // the twin's final on our day settles it; its postponement / new date only when our own provider has nothing
  if (t?.kind === 'final' && (sameDay(tDate, g.utc_date) || Math.abs(Date.parse(tDate || '') - Date.parse(g.utc_date)) < TEAM_WINDOW_DAYS * DAY)) return t;
  return own || t;
}

async function ownLookup(p: Providers, g: Pending, byId: any | null, fdList?: any[]): Promise<Lookup> {
  const ko = Date.parse(g.utc_date);
  const from = day(ko - TEAM_WINDOW_DAYS * DAY), to = day(ko + TEAM_WINDOW_DAYS * DAY);
  const af = g.match_id >= AF_OFFSET;
  const idL: Lookup = byId ? (af ? afLookup(byId, 'id') : fdLookup(byId, 'id')) : null;
  const idDate = byId ? (af ? byId?.fixture?.date : byId?.utcDate) : null;
  // by id on our day is the answer when final or off; still open → the two teams too (fix240: a fixture the provider
  // left at NS while the game was played under another id); a final on another day too
  if (idL && (idL.kind === 'final' || (sameDay(idDate, g.utc_date) && idL.kind === 'off'))) return idL;
  // a provider error throws: the caller skips the game this run (an outage is not an attempt)
  let teams: Lookup = null;
  if (af) {
    if (g.home_id && g.away_id && g.home_id >= AF_OFFSET && g.away_id >= AF_OFFSET) {
      const list = await p.afByTeams(g.home_id - AF_OFFSET, g.away_id - AF_OFFSET, from, to);
      // the same home side (a return leg the other way round is another game)
      const mine = list.filter(f => f?.teams?.home?.id === g.home_id! - AF_OFFSET && f?.teams?.away?.id === g.away_id! - AF_OFFSET);
      teams = best(mine.map(f => ({ l: afLookup(f, f?.fixture?.id === g.match_id - AF_OFFSET ? 'id' : 'teams'), date: f?.fixture?.date || null })), g.utc_date);
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
const openReview = db.prepare(`INSERT INTO settle_review (match_id, note, found_at) VALUES (?, ?, ?)
  ON CONFLICT(match_id) DO UPDATE SET note = excluded.note WHERE settle_review.resolved_at IS NULL`);
const closeReview = db.prepare(`UPDATE settle_review SET resolved_at = ?, resolution = ?, by_user = ? WHERE match_id = ? AND resolved_at IS NULL`);
const reviewRow = db.prepare(`SELECT match_id, resolved_at FROM settle_review WHERE match_id = ?`);

/** Apply one decision (one short transaction per game). Returns true when a new Needs-you item was opened. */
export function applyDecision(matchId: number, d: Decision, now: number): boolean {
  const at = new Date(now).toISOString();
  let opened = false;
  db.exec('BEGIN');
  try {
    if (d.action === 'settle') {
      insertResult.run(matchId, d.raw, d.home, d.away, d.home > d.away ? 'H' : d.home < d.away ? 'A' : 'D', at, null);
      markSettled.run(at, matchId);
      dropTry.run(matchId);
      closeReview.run(at, `settled automatically: ${d.note}`, null, matchId);
    } else if (d.action === 'void') {
      insertResult.run(matchId, 'VOID', null, null, 'VOID', at, d.reason);
      markSettled.run(at, matchId);
      dropTry.run(matchId);
      closeReview.run(at, `void automatically: ${d.reason}`, null, matchId);
    } else if (d.action === 'move') {
      moveStmt.run(d.date, at, matchId);
      dropTry.run(matchId);
      closeReview.run(at, `kick-off moved: ${d.note}`, null, matchId);
    } else if (d.action === 'retry' || d.action === 'review') {
      putTry.run(matchId, d.attempts, day(now), d.note, at);
      if (d.action === 'review') {
        const had = reviewRow.get(matchId) as any;
        if (!had || !had.resolved_at) { openReview.run(matchId, d.note, at); opened = !had; }
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  return opened;
}

/** Games past kick-off + `afterMs` (fix240: 24 h), not settled (one row per match), newest first (games waiting in Needs you
 *  for days never crowd a new one out of the run's 60). */
export function overdueGames(now = Date.now(), afterMs = REFETCH_AFTER_MS): Pending[] {
  return db.prepare(`SELECT match_id, MAX(utc_date) AS utc_date, MAX(home_team_id) AS home_id, MAX(away_team_id) AS away_id, MAX(home_team) AS home,
      MAX(away_team) AS away, MAX(competition_name) AS comp FROM predictions WHERE settled = 0 GROUP BY match_id HAVING MAX(utc_date) < ? ORDER BY utc_date DESC`)
    .all(new Date(now - afterMs).toISOString()) as Pending[];
}

let running = false;
/**
 * Every game past kick-off + 24 h without a final: look it up at both providers and settle / move / void / retry, or
 * (48 h) put it in Needs you. Returns one line per game ("Abha – Al-Faisaly (Pro League, 2026-10-11): void — …"),
 * logged when `log`.
 */
export async function resolveUnsettled(p: Providers, opts: { now?: number; log?: boolean; tag?: string; max?: number } = {}) {
  const out = { checked: 0, settled: 0, moved: 0, voided: 0, retry: 0, review: 0, lines: [] as string[] };
  if (running) return out;
  running = true;
  try {
    const now = opts.now ?? Date.now();
    const games = overdueGames(now).slice(0, opts.max ?? 60);
    if (!games.length) return out;
    // fix240: the other provider's twin of each game (FD game → its API-Football fixture, API-Football game → its FD match)
    const twinId = new Map<number, number>();
    if (p.twinOf) for (const g of games) { const t = p.twinOf(g.match_id); if (t) twinId.set(g.match_id, t); }
    // fixture ids first, 20 per call (API-Football): our own API-Football games and the FD games' twins
    const byId = new Map<number, any>();
    let afDown = false;
    const af = [...new Set([
      ...games.filter(g => g.match_id >= AF_OFFSET).map(g => g.match_id - AF_OFFSET),
      ...[...twinId.values()].filter(t => t >= AF_OFFSET).map(t => t - AF_OFFSET)
    ])];
    for (let i = 0; i < af.length; i += 20) {
      try { for (const f of await p.afByIds(af.slice(i, i + 20))) if (f?.fixture?.id) byId.set(AF_OFFSET + f.fixture.id, f); }
      catch (e: any) { afDown = true; logger.warn(`unsettled: fixtures by id failed: ${e.message}`); break; }
    }
    const fresh: { g: Pending; note: string }[] = [];
    for (const g of games) {
      // a provider error skips the game this run: an outage is not an attempt
      if (afDown && g.match_id >= AF_OFFSET) continue;
      let id = byId.get(g.match_id) ?? null;
      let fdList: any[] | undefined;
      let twin: any = null;
      const tid = twinId.get(g.match_id);
      const ko = Date.parse(g.utc_date);
      if (g.match_id < AF_OFFSET || (tid && tid < AF_OFFSET)) {
        // Football-Data.org: one range call (±3 days) answers the id, the two teams and an API-Football game's FD twin
        try { fdList = await p.fdRange(day(ko - TEAM_WINDOW_DAYS * DAY), day(ko + TEAM_WINDOW_DAYS * DAY)); }
        catch (e: any) { logger.warn(`unsettled ${g.match_id}: ${e.message}`); if (g.match_id < AF_OFFSET) continue; }
        if (g.match_id < AF_OFFSET) id = fdList!.find(m => m.id === g.match_id) ?? null;
        else twin = fdList?.find(m => m.id === tid) ?? null;
      }
      if (tid && tid >= AF_OFFSET) twin = byId.get(tid) ?? null;
      let found: Lookup;
      try { found = await lookupGame(p, g, id, g.match_id < AF_OFFSET ? fdList : undefined, twin); } catch (e: any) { logger.warn(`unsettled ${g.match_id}: team search failed: ${e.message}`); continue; }
      out.checked++;
      const t = getTry.get(g.match_id) as any;
      const d = decide(found, { kickoff: g.utc_date, attempts: t?.attempts || 0, lastDay: t?.last_day || null, now });
      if (d.action === 'wait') continue;
      const opened = applyDecision(g.match_id, d, now);
      if (d.action === 'settle') out.settled++; else if (d.action === 'move') out.moved++; else if (d.action === 'void') out.voided++; else if (d.action === 'review') out.review++; else out.retry++;
      if (opened && d.action === 'review') fresh.push({ g, note: d.note });
      const what = d.action === 'settle' ? `settled — ${d.note}` : d.action === 'move' ? `kick-off moved — ${d.note}` : d.action === 'void' ? `void — ${d.reason}`
        : d.action === 'review' ? `Needs you — ${d.note}` : `looked again — ${d.note}`;
      const line = `${g.home} – ${g.away} (${g.comp || '?'}, ${String(g.utc_date).slice(0, 10)}, id ${g.match_id}): ${what}`;
      out.lines.push(line);
      if (opts.log && (d.action !== 'review' || opened)) logger.info(`${opts.tag || 'unsettled'}: ${line}`);
    }
    if (fresh.length) {
      const { subject, mail } = reviewMail(fresh, now);
      await sendAdminMail(subject, mail).catch(e => logger.warn(`unsettled: Needs you email failed: ${e?.message || e}`));
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

/* ---------- fix240: Needs you — Enter result / Void ---------- */

const matchPath = (id: number) => `/match/${id}`;
const gameOf = (id: number) => db.prepare(`SELECT match_id, MAX(utc_date) AS utc_date, MAX(home_team) AS home, MAX(away_team) AS away, MAX(competition_name) AS comp,
  MAX(settled) AS settled FROM predictions WHERE match_id = ? GROUP BY match_id`).get(id) as any;

function reviewMail(list: { g: Pending; note: string }[], now: number): { subject: string; mail: AdminMail } {
  const n = list.length, what = `football result${n === 1 ? '' : 's'}`;
  return {
    subject: `Needs you: ${n} ${what}`,
    mail: {
      label: 'Football results', tone: 'warn',
      title: `${n} ${what} missing 48 h after kick-off`,
      what: n === 1
        ? `Neither data provider has a final score for ${list[0].g.home} – ${list[0].g.away} 48 hours after kick-off, so it is not in the record yet.`
        : `Neither data provider has a final score for ${n} games 48 hours after kick-off, so they are not in the record yet.`,
      todo: 'Check the league’s own site. Played → "Enter result" in Admin (home and away goals after 90 minutes). Abandoned, postponed or never played → "Void".',
      rows: list.map(({ g, note }) => ({
        when: `${g.comp || 'Football'} · ${israelTime(g.utc_date)}`, title: `${g.home} – ${g.away}`, titleHref: siteUrl(matchPath(g.match_id)), detail: note,
        buttons: [
          { text: 'Enter result', href: adminUrl('needs-you') },
          { text: 'Void', href: actionLink('settle-review', { id: g.match_id, act: 'void' }, `Void ${g.home} – ${g.away}`, now), kind: 'secondary' as const },
          { text: 'Open game', href: siteUrl(matchPath(g.match_id)), kind: 'secondary' as const }
        ]
      })),
      buttons: [{ text: 'Open in Admin', href: adminUrl('needs-you') }],
      footer: 'We keep looking: a final that shows up later at either provider settles the game by itself.'
    }
  };
}

/** Admin → Needs you: football games with no final 48 h after kick-off (newest first). */
export function openSettleReviews() {
  return (db.prepare(`SELECT r.match_id AS id, r.note, r.found_at, MAX(p.utc_date) AS kickoff, MAX(p.home_team) AS home, MAX(p.away_team) AS away,
      MAX(p.competition_name) AS competition FROM settle_review r JOIN predictions p ON p.match_id = r.match_id
    WHERE r.resolved_at IS NULL GROUP BY r.match_id ORDER BY MAX(p.utc_date) DESC LIMIT 50`).all() as any[]);
}

export class SettleError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** "Enter result" (home / away goals after 90 minutes) or "Void", from Admin → Needs you or the email button. */
export function decideSettle(matchId: number, act: string, body: any, by: string, now = Date.now()): { message: string } {
  const g = gameOf(matchId);
  if (!g) throw new SettleError(404, 'Game not found.');
  const r = reviewRow.get(matchId) as any;
  if (g.settled) {
    if (r && !r.resolved_at) closeReview.run(new Date(now).toISOString(), 'already settled', by, matchId);
    const res = db.prepare(`SELECT outcome, home_goals, away_goals FROM results WHERE match_id = ?`).get(matchId) as any;
    return { message: `Already settled (${res?.outcome === 'VOID' ? 'void' : `${res?.home_goals ?? '?'}–${res?.away_goals ?? '?'}`}).` };
  }
  const at = new Date(now).toISOString();
  if (act === 'void') {
    closeReview.run(at, 'void', by, matchId); // the admin's decision (applyDecision would close it as automatic)
    applyDecision(matchId, { action: 'void', reason: `voided by an admin (no final from the providers)` }, now);
    return { message: `${g.home} – ${g.away} is void: out of the record.` };
  }
  if (act !== 'result') throw new SettleError(400, 'Unknown action.');
  const h = Number(body?.home), a = Number(body?.away);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > 30 || a > 30) throw new SettleError(400, 'Enter both scores (0–30).');
  db.exec('BEGIN');
  try {
    insertResult.run(matchId, 'FINISHED', h, a, h > a ? 'H' : h < a ? 'A' : 'D', at, `entered by an admin (no final from the providers)`);
    markSettled.run(at, matchId);
    dropTry.run(matchId);
    closeReview.run(at, `result ${h}-${a}`, by, matchId);
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  return { message: `${g.home} ${h}–${a} ${g.away} settled and counted in the record.` };
}

onEmailAction('settle-review', (p: { id: number; act: string }, by) => ({ ...decideSettle(p.id, p.act, null, by), open: matchPath(p.id) }));

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

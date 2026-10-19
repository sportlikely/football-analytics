/**
 * Tennis data (fix184) — admin only: no pages, no public routes, no model yet. Singles only (doubles skipped everywhere).
 * Live Tennis API, Pro plan: https://api.livetennisapi.com/api/public/v1, header X-API-Key = TENNIS_API_KEY (never logged
 * or returned). Spec: https://docs.livetennisapi.com/openapi.json — unknown fields ignored, missing fields null. Lists
 * return { data, meta }, limit ≤ 200, offset paging. Scores are player-major ("games": [[6,3],[4,6]] = 6-4, 3-6).
 *
 * Quota (Pro: 10,000 calls a day, 300 a minute): every call is counted per UTC day in tennis_calls, GET /usage (free of
 * quota) is read every 30 min. A reserve (TENNIS_RESERVE, default 1500) is kept for live play and fixtures: backfill
 * and the bulk jobs stop when they would go under it. 429 → 60 s pause; 401 / 403 upgrade_required → logged once and
 * that endpoint is not called again until restart.
 *
 * Jobs: fixtures 15 min · live matches every 60 s while anything is live, else 10 min · finished matches
 * (/history/matches from the last sync) every 30 min, then each match's point tape → tennis_match_stats · players on
 * first sight and weekly · rankings daily · tournaments daily · stoppages of players playing in the next 48 h every 6 h ·
 * the market price of upcoming singles matches once, ~1 h before the start (admin benchmark: tennis_prices never goes
 * to a public route). Backfill (slow, under the reserve): monthly tape packages Jan 2023 → last full month (one line
 * per match, stream-parsed; matches + computed stats stored, not the points), and the 2015–2022 results archive for
 * ATP and WTA (yearly archive packages, or the paged listing when the plan refuses them).
 */
import { Readable } from 'stream';
import zlib from 'zlib';
import readline from 'readline';
import { db } from '../db';
import logger from '../utils/logger';
import { every, after, slicer, stalledWithin } from './perf';

const BASE = 'https://api.livetennisapi.com/api/public/v1';
const KEY = () => process.env.TENNIS_API_KEY || '';
export const TENNIS_DAY_LIMIT = 10_000;
const RESERVE = () => Math.max(0, Number(process.env.TENNIS_RESERVE || 1500) || 1500);
const MIN_GAP_MS = 220; // ≤ ~270 calls a minute (the plan allows 300)

/* ------------------------------------------------------------------ */
/* Tables                                                               */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS tennis_tournaments (
    id TEXT PRIMARY KEY, name TEXT, tour TEXT, tier TEXT, category TEXT, surface TEXT, indoor INTEGER, city TEXT, country TEXT,
    start_date TEXT, end_date TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tennis_players (
    id INTEGER PRIMARY KEY, name TEXT, country TEXT, tour TEXT, hand TEXT, dob TEXT, height INTEGER, ranking INTEGER, ranking_points INTEGER,
    stats TEXT, updated_at TEXT, seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tennis_matches (
    id INTEGER PRIMARY KEY, tournament_id TEXT, tournament TEXT, tour TEXT, tier TEXT, surface TEXT, indoor INTEGER, draw TEXT,
    round TEXT, round_code TEXT, is_qualifying INTEGER, best_of INTEGER, scheduled_at TEXT, status TEXT, event_status TEXT,
    p1_id INTEGER, p1_name TEXT, p2_id INTEGER, p2_name TEXT, sets TEXT, games TEXT, winner INTEGER, outcome TEXT, retired INTEGER NOT NULL DEFAULT 0,
    extra TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tennis_matches_time ON tennis_matches(scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_tennis_matches_status ON tennis_matches(status);
  CREATE TABLE IF NOT EXISTS tennis_match_stats (
    match_id INTEGER NOT NULL, player INTEGER NOT NULL, player_id INTEGER,
    svc_pts INTEGER, svc_won INTEGER, ret_pts INTEGER, ret_won INTEGER, svc_games INTEGER, svc_held INTEGER,
    bp_faced INTEGER, bp_saved INTEGER, bp_had INTEGER, bp_conv INTEGER, tb_played INTEGER, tb_won INTEGER, games INTEGER,
    duration_s INTEGER, source TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, gaps INTEGER, PRIMARY KEY (match_id, player)
  );
  CREATE TABLE IF NOT EXISTS tennis_rankings (
    tour TEXT NOT NULL, date TEXT NOT NULL, rank INTEGER NOT NULL, player_id INTEGER, player_name TEXT, points INTEGER,
    PRIMARY KEY (tour, date, rank)
  );
  CREATE TABLE IF NOT EXISTS tennis_stoppages (
    player_id INTEGER NOT NULL, match_id INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, duration_s INTEGER,
    PRIMARY KEY (player_id, match_id, kind, at)
  );
  CREATE TABLE IF NOT EXISTS tennis_prices (
    match_id INTEGER PRIMARY KEY, p1_mid REAL, p2_mid REAL, p1_bid REAL, p1_ask REAL, p2_bid REAL, p2_ask REAL, at TEXT, fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tennis_calls (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tennis_meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE INDEX IF NOT EXISTS idx_tennis_matches_tour ON tennis_matches(tour, status);
  CREATE INDEX IF NOT EXISTS idx_tennis_rankings_player ON tennis_rankings(player_id, date);
`);
/**
 * fix189: a player's rank for match rows — the latest tennis_rankings table of their tour (singles) first, the
 * /players/{id} rank (tennis_players.ranking) only as fallback. `p` = the tennis_players alias.
 */
const rankSql = (p: string) => `(SELECT r.rank FROM tennis_rankings r WHERE r.player_id = ${p}.id
  AND r.date = (SELECT MAX(r2.date) FROM tennis_rankings r2 WHERE r2.tour = r.tour) LIMIT 1)`;
// fix187: the player's ranking movement (from /players/{id}; the rankings fallback)
try { db.exec(`ALTER TABLE tennis_players ADD COLUMN ranking_movement INTEGER`); } catch { /* column exists */ }
const meta = {
  get: (k: string): string | null => (db.prepare(`SELECT v FROM tennis_meta WHERE k = ?`).get(k) as any)?.v ?? null,
  set: (k: string, v: string) => db.prepare(`INSERT OR REPLACE INTO tennis_meta (k, v) VALUES (?, ?)`).run(k, v)
};

/* ------------------------------------------------------------------ */
/* Client + quota guard                                                 */
/* ------------------------------------------------------------------ */

const today = () => new Date().toISOString().slice(0, 10);
const countCall = db.prepare(`INSERT INTO tennis_calls (day, calls, errors) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors`);
const callsToday = () => ((db.prepare(`SELECT calls FROM tennis_calls WHERE day = ?`).get(today()) as any)?.calls as number) || 0;
let usage: { calls: number; remaining: number | null; tier: string | null; perDay: number | null; at: number; day: string; oursAt: number } | null = null;
let backoffUntil = 0;
let lastCall = 0;
const blocked = new Map<string, string>(); // endpoint template → why (401 / upgrade_required): not called again until restart
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** "/players/123/stoppages" → "/players/{id}/stoppages" (one entry per endpoint, not per id) */
const templateOf = (path: string) => path.replace(/\/\d+(?=\/|$)/g, '/{id}').replace(/\/\d{4}(-\d{2})?$/, '/{period}');

/** Calls used today: our own count, or the provider's (from /usage) plus ours since then, whichever is higher. */
export function usedToday(): number {
  const ours = callsToday();
  if (usage && usage.day === today()) return Math.max(ours, usage.calls + (ours - usage.oursAt));
  return ours;
}
const dayLimit = () => usage?.perDay || TENNIS_DAY_LIMIT;
/** May a job of this kind spend `n` more calls? Core (live, fixtures) keeps 50 back; everything else keeps the reserve. */
export function canSpend(kind: 'core' | 'bulk', n = 1): boolean {
  return dayLimit() - usedToday() - n >= (kind === 'core' ? 50 : RESERVE());
}

export class TennisError extends Error { constructor(msg: string, public status = 0, public plan = false) { super(msg); } }

type Opts = { kind?: 'core' | 'bulk'; raw?: boolean; timeoutMs?: number };
/** One API call. `raw` returns the Response (bulk files, streamed). Throws TennisError; 404 → null. */
async function tn(path: string, params: Record<string, string | number | boolean | undefined> = {}, o: Opts = {}): Promise<any> {
  if (!KEY()) throw new TennisError('TENNIS_API_KEY is not set');
  const tpl = templateOf(path);
  if (blocked.has(tpl)) throw new TennisError(`${tpl}: ${blocked.get(tpl)} (not called again until restart)`, 403, true);
  if (Date.now() < backoffUntil) throw new TennisError('rate limited: pausing 60 s', 429);
  if (!canSpend(o.kind || 'bulk')) throw new TennisError(`daily budget: ${usedToday()} of ${dayLimit()} used, reserve ${RESERVE()} kept`, 0);
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'X-API-Key': KEY(), Accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs || 30_000) });
  } catch (e: any) {
    throw new TennisError(`${tpl}: ${e?.name === 'TimeoutError' ? 'timeout' : e?.message || 'network error'}`);
  }
  countCall.run(today(), res.ok || res.status === 404 ? 0 : 1);
  if (res.status === 429) { backoffUntil = Date.now() + 60_000; throw new TennisError(`${tpl}: rate limited (429), pausing 60 s`, 429); }
  if (res.status === 401 || res.status === 403) {
    let why = `HTTP ${res.status}`;
    try { const j: any = await res.json(); why = j?.error || why; } catch { /* no body */ }
    if (res.status === 401 || why === 'upgrade_required') {
      if (!blocked.has(tpl)) logger.warn(`tennis: ${tpl} answered ${res.status} ${why} — not called again until restart`);
      blocked.set(tpl, why);
    }
    throw new TennisError(`${tpl}: ${why}`, res.status, why === 'upgrade_required');
  }
  if (res.status === 404) { try { await res.body?.cancel(); } catch { /* none */ } return null; }
  if (!res.ok) throw new TennisError(`${tpl}: HTTP ${res.status}`, res.status);
  return o.raw ? res : res.json();
}

/** Every page of a list endpoint (limit 200, offset paging), up to `maxPages`. */
async function pages(path: string, params: Record<string, any>, maxPages: number, kind: 'core' | 'bulk', onPage: (rows: any[]) => void | Promise<void>): Promise<number> {
  let offset = 0, n = 0;
  for (let p = 0; p < maxPages; p++) {
    if (!canSpend(kind)) break;
    const j = await tn(path, { ...params, limit: 200, offset }, { kind });
    const rows: any[] = Array.isArray(j?.data) ? j.data : [];
    await onPage(rows);
    n += rows.length;
    if (!j?.meta?.has_more || !rows.length) break;
    offset += rows.length;
  }
  return n;
}

/** GET /usage (quota-exempt): the provider's count for today, the plan and its limits. */
async function readUsage() {
  if (!KEY()) return;
  const res = await fetch(`${BASE}/usage`, { headers: { 'X-API-Key': KEY() }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new TennisError(`/usage: HTTP ${res.status}`, res.status);
  const j: any = await res.json();
  usage = {
    calls: Number(j?.today?.calls) || 0, remaining: j?.today?.remaining_day ?? null, tier: j?.tier ?? null,
    perDay: Number(j?.limits?.per_day) || null, at: Date.now(), day: today(), oursAt: callsToday()
  };
}

/* ------------------------------------------------------------------ */
/* Storing                                                               */
/* ------------------------------------------------------------------ */

const num = (x: any): number | null => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const str = (x: any): string | null => (x === null || x === undefined || x === '' ? null : String(x));
const isDoubles = (m: any) => !!m?.is_doubles || m?.draw === 'doubles' || !!m?.players?.p1?.is_doubles_team;
const bestOf = (f: any) => (f === 'BO5' ? 5 : f === 'BO3' ? 3 : null);
const nowIso = () => new Date().toISOString();

const upMatch = db.prepare(`
  INSERT INTO tennis_matches (id, tournament_id, tournament, tour, tier, surface, indoor, draw, round, round_code, is_qualifying, best_of,
    scheduled_at, status, event_status, p1_id, p1_name, p2_id, p2_name, sets, games, winner, outcome, retired, extra, source, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET tournament_id = COALESCE(excluded.tournament_id, tournament_id), tournament = COALESCE(excluded.tournament, tournament),
    tour = COALESCE(excluded.tour, tour), tier = COALESCE(excluded.tier, tier), surface = COALESCE(excluded.surface, surface), indoor = COALESCE(excluded.indoor, indoor),
    draw = COALESCE(excluded.draw, draw), round = COALESCE(excluded.round, round), round_code = COALESCE(excluded.round_code, round_code),
    is_qualifying = COALESCE(excluded.is_qualifying, is_qualifying), best_of = COALESCE(excluded.best_of, best_of),
    scheduled_at = COALESCE(excluded.scheduled_at, scheduled_at), status = COALESCE(excluded.status, status), event_status = COALESCE(excluded.event_status, event_status),
    p1_id = COALESCE(excluded.p1_id, p1_id), p1_name = COALESCE(excluded.p1_name, p1_name), p2_id = COALESCE(excluded.p2_id, p2_id), p2_name = COALESCE(excluded.p2_name, p2_name),
    sets = COALESCE(excluded.sets, sets), games = COALESCE(excluded.games, games), winner = COALESCE(excluded.winner, winner), outcome = COALESCE(excluded.outcome, outcome),
    retired = MAX(retired, excluded.retired), extra = COALESCE(excluded.extra, extra),
    source = CASE WHEN source = 'history' AND excluded.source IN ('live', 'fixture') THEN source ELSE excluded.source END, updated_at = excluded.updated_at`);
const seePlayer = db.prepare(`INSERT INTO tennis_players (id, name, country, tour, ranking, ranking_points, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name), country = COALESCE(excluded.country, country), tour = COALESCE(excluded.tour, tour),
    ranking = COALESCE(excluded.ranking, ranking), ranking_points = COALESCE(excluded.ranking_points, ranking_points), seen_at = excluded.seen_at`);

/** A Match object (/matches, /history/matches, a tape's `match`) → tennis_matches. Doubles are skipped. */
export function storeMatch(m: any, source: 'fixture' | 'live' | 'history'): boolean {
  if (!m || num(m.id) === null || isDoubles(m)) return false;
  const p1 = m.players?.p1 || {}, p2 = m.players?.p2 || {};
  const outcome = str(m.outcome);
  const sc = m.score || null;
  upMatch.run(num(m.id), str(m.tournament_id), str(m.tournament), str(m.tour), str(m.tier), str(m.surface), m.indoor == null ? null : m.indoor ? 1 : 0,
    str(m.draw) || 'singles', str(m.round), str(m.round_code), m.is_qualifying == null ? null : m.is_qualifying ? 1 : 0, bestOf(m.format),
    str(m.scheduled_time) || str(m.live_at), str(m.status), str(m.event_status), num(p1.id), str(p1.name), num(p2.id), str(p2.name),
    sc?.sets ? JSON.stringify(sc.sets) : null, sc?.games ? JSON.stringify(sc.games) : null, num(m.winner), outcome,
    outcome && /retired|walkover|default/.test(outcome) ? 1 : 0, null, source, nowIso());
  for (const p of [p1, p2]) if (num(p.id) !== null) seePlayer.run(num(p.id), str(p.name), str(p.country), str(p.tour), num(p.ranking), num(p.ranking_points), nowIso());
  return true;
}
/** A /fixtures row (its own flat shape) → tennis_matches as 'fixture' (a known match keeps its richer data). */
function storeFixture(f: any): boolean {
  if (!f || num(f.id) === null) return false;
  const at = str(f.start_time) || (f.event_date ? `${f.event_date}T00:00:00Z` : null);
  upMatch.run(num(f.id), null, str(f.tournament), str(f.tour), null, str(f.surface), null, 'singles', str(f.round), str(f.round_code), null, null,
    at, str(f.status) || 'upcoming', null, num(f.player1_id), str(f.player1_name), num(f.player2_id), str(f.player2_name), null, null, null, null, 0, null, 'fixture', nowIso());
  for (const [id, name] of [[f.player1_id, f.player1_name], [f.player2_id, f.player2_name]]) if (num(id) !== null) seePlayer.run(num(id), str(name), null, str(f.tour), null, null, nowIso());
  return true;
}

/* ------------------------------------------------------------------ */
/* Statistics from the point tape                                      */
/* ------------------------------------------------------------------ */

export interface SideStats { svc_pts: number; svc_won: number; ret_pts: number; ret_won: number; svc_games: number; svc_held: number; bp_faced: number; bp_saved: number; bp_had: number; bp_conv: number; tb_played: number; tb_won: number; games: number }
const PT: Record<string, number> = { '0': 0, '15': 1, '30': 2, '40': 3, A: 4, AD: 4, Ad: 4 };
const sum = (a: any) => (Array.isArray(a) ? a.reduce((s: number, x: any) => s + (Number(x) || 0), 0) : 0);
/**
 * Per-player statistics from a tape (the score after every point): service / return points, service games held, break
 * points, tiebreaks, games, duration. The point winner is the row's own `point_winner` when given, else read from the
 * score change; a jump of more than one point is counted as a gap (stats then marked incomplete).
 */
export function statsFromTape(tape: any[], match?: any): { sides: [SideStats, SideStats]; gaps: number; points: number; duration: number | null } | null {
  if (!Array.isArray(tape) || tape.length < 8) return null;
  const S = (): SideStats => ({ svc_pts: 0, svc_won: 0, ret_pts: 0, ret_won: 0, svc_games: 0, svc_held: 0, bp_faced: 0, bp_saved: 0, bp_had: 0, bp_conv: 0, tb_played: 0, tb_won: 0, games: 0 });
  const st: [SideStats, SideStats] = [S(), S()];
  let gaps = 0, points = 0;
  const games = (r: any): [number, number] => [sum(r?.games?.[0]), sum(r?.games?.[1])];
  const sets = (r: any) => sum(r?.sets);
  const pv = (r: any, i: number) => { const x = r?.points?.[i]; if (x == null) return 0; if (r?.is_tiebreak) return Number(x) || 0; return PT[String(x)] ?? (Number(x) || 0); };
  for (let i = 1; i < tape.length; i++) {
    const a = tape[i - 1], b = tape[i];
    const ga = games(a), gb = games(b);
    const dg1 = gb[0] - ga[0], dg2 = gb[1] - ga[1];
    const sa = sets(a), sb = sets(b);
    const tbA = !!a?.is_tiebreak;
    // a 10-point match tiebreak keeps is_tiebreak for the whole set and counts its points in `games`
    const matchTb = tbA && !!b?.is_tiebreak && sa === sb;
    let w: 1 | 2 | null = b?.point_winner === 1 || b?.point_winner === 2 ? b.point_winner : null;
    let gameEnd = false;
    if (!matchTb && dg1 + dg2 === 1 && dg1 >= 0 && dg2 >= 0) { gameEnd = true; w = w || (dg1 ? 1 : 2); }
    else if (matchTb && dg1 + dg2 === 1 && dg1 >= 0 && dg2 >= 0) { w = w || (dg1 ? 1 : 2); }
    else if (dg1 === 0 && dg2 === 0 && sa === sb) {
      const p1a = pv(a, 0), p2a = pv(a, 1), p1b = pv(b, 0), p2b = pv(b, 1);
      if (p1a === p1b && p2a === p2b) continue; // the same state again
      if (!w) {
        if (p1b === p1a + 1 && p2b === p2a) w = 1;
        else if (p2b === p2a + 1 && p1b === p1a) w = 2;
        else if (!tbA && p1a === 4 && p1b === 3 && p2b === 3) w = 2; // advantage lost
        else if (!tbA && p2a === 4 && p2b === 3 && p1b === 3) w = 1;
      }
      if (!w) { gaps++; continue; }
    } else { gaps++; continue; }
    if (!w) { gaps++; continue; }
    const srv: 1 | 2 | null = a?.server === 1 || a?.server === 2 ? a.server : b?.server === 1 || b?.server === 2 ? b.server : null;
    points++;
    if (!srv) { gaps++; continue; }
    const s = st[srv - 1], r = st[2 - srv];
    s.svc_pts++; r.ret_pts++;
    if (w === srv) s.svc_won++; else r.ret_won++;
    if (!tbA) {
      // break point: the receiver one point from the game
      const sv = pv(a, srv - 1), rv = pv(a, 2 - srv);
      if (rv === 4 || (rv === 3 && sv <= 2)) { s.bp_faced++; r.bp_had++; if (w === srv) s.bp_saved++; else r.bp_conv++; }
    }
    if (gameEnd) {
      if (tbA) { st[0].tb_played++; st[1].tb_played++; st[w - 1].tb_won++; }
      else { s.svc_games++; if (w === srv) s.svc_held++; }
    } else if (matchTb && sb !== sa) { st[0].tb_played++; st[1].tb_played++; st[w - 1].tb_won++; }
  }
  // a match tiebreak ends with the set (sets change while is_tiebreak was on)
  for (let i = 1; i < tape.length; i++) {
    const a = tape[i - 1], b = tape[i];
    if (a?.is_tiebreak && b?.is_tiebreak === false && sets(b) > sets(a) && games(b)[0] + games(b)[1] === games(a)[0] + games(a)[1]) {
      const w = (b.sets?.[0] || 0) > (a.sets?.[0] || 0) ? 0 : 1;
      st[0].tb_played++; st[1].tb_played++; st[w].tb_won++;
    }
  }
  const fin = match?.score?.games || tape[tape.length - 1]?.games;
  st[0].games = sum(fin?.[0]); st[1].games = sum(fin?.[1]);
  const times = tape.map(r => Date.parse(r?.timestamp || '')).filter(t => Number.isFinite(t));
  const span = times.length >= 2 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : null;
  return { sides: st, gaps, points, duration: span && span > 600 && span < 8 * 3600 ? span : null };
}

const upStats = db.prepare(`INSERT OR REPLACE INTO tennis_match_stats (match_id, player, player_id, svc_pts, svc_won, ret_pts, ret_won, svc_games, svc_held,
  bp_faced, bp_saved, bp_had, bp_conv, tb_played, tb_won, games, duration_s, source, complete, gaps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
/** A HistoryTape object ({ match, tape, meta }) → match + stats rows. */
export function storeTape(obj: any): boolean {
  const m = obj?.match;
  if (!m || isDoubles(m) || num(m.id) === null) return false;
  storeMatch(m, 'history');
  const s = statsFromTape(obj.tape, m);
  if (!s) return true;
  const complete = s.gaps === 0 && (obj?.meta?.points?.complete !== false) && (obj?.meta?.points?.starts_at_love !== false) ? 1 : 0;
  const ids = [num(m.players?.p1?.id), num(m.players?.p2?.id)];
  s.sides.forEach((x, i) => upStats.run(num(m.id), i + 1, ids[i], x.svc_pts, x.svc_won, x.ret_pts, x.ret_won, x.svc_games, x.svc_held,
    x.bp_faced, x.bp_saved, x.bp_had, x.bp_conv, x.tb_played, x.tb_won, x.games, s.duration, 'tape', complete, s.gaps));
  return true;
}

/** An archive result (ArchiveMatch: winner / loser shaped) → tennis_matches (id = −archive id: its own id space), p1 = winner. */
export function storeArchive(a: any): boolean {
  if (num(a?.id) === null) return false;
  const id = -Number(a.id);
  const w = a.winner || {}, l = a.loser || {};
  const sets = typeof a.score === 'string' ? a.score.trim().split(/\s+/).filter((x: string) => /^\d+-\d+/.test(x)) : [];
  const g1 = sets.map((x: string) => Number(x.split('-')[0])), g2 = sets.map((x: string) => Number(x.split('-')[1].replace(/\(.*/, '')));
  const extra = { level: str(a.level), draw_size: num(a.draw_size), minutes: num(a.minutes), score: str(a.score), source_id: str(a.source_id),
    winner: { rank: num(w.rank), seed: num(w.seed), entry: str(w.entry), age: num(w.age), hand: str(w.hand), height_cm: num(w.height_cm) },
    loser: { rank: num(l.rank), seed: num(l.seed), entry: str(l.entry), age: num(l.age), hand: str(l.hand), height_cm: num(l.height_cm) } };
  const outcome = str(a.outcome) || 'completed';
  upMatch.run(id, null, str(a.tournament), str(a.tour), str(a.level), str(a.surface)?.toLowerCase() ?? null, null, 'singles', str(a.round), str(a.round), null, num(a.best_of),
    str(a.event_date) ? `${String(a.event_date).slice(0, 10)}T00:00:00Z` : null, 'completed', null, num(w.player_id), str(w.name), num(l.player_id), str(l.name),
    JSON.stringify([g1.filter((x: number, i: number) => x > g2[i]).length, g2.filter((x: number, i: number) => x > g1[i]).length]), JSON.stringify([g1, g2]), 1, outcome,
    /retired|walkover|default/.test(outcome) ? 1 : 0, JSON.stringify(extra), 'archive', nowIso());
  // serve statistics where the era recorded them (from 1991): winner = 1, loser = 2
  const sw = a.stats?.winner, sl = a.stats?.loser;
  if (sw && sl && num(sw.serve_points) !== null && num(sl.serve_points) !== null) {
    const won = (x: any) => (num(x.first_won) ?? 0) + (num(x.second_won) ?? 0);
    const side = (me: any, op: any) => ({ svc_pts: num(me.serve_points)!, svc_won: won(me), ret_pts: num(op.serve_points)!, ret_won: num(op.serve_points)! - won(op),
      svc_games: num(me.serve_games), svc_held: num(me.serve_games) !== null && num(me.bp_faced) !== null && num(me.bp_saved) !== null ? num(me.serve_games)! - (num(me.bp_faced)! - num(me.bp_saved)!) : null,
      bp_faced: num(me.bp_faced), bp_saved: num(me.bp_saved), bp_had: num(op.bp_faced), bp_conv: num(op.bp_faced) !== null && num(op.bp_saved) !== null ? num(op.bp_faced)! - num(op.bp_saved)! : null });
    [side(sw, sl), side(sl, sw)].forEach((x, i) => upStats.run(id, i + 1, i ? num(l.player_id) : num(w.player_id), x.svc_pts, x.svc_won, x.ret_pts, x.ret_won, x.svc_games, x.svc_held,
      x.bp_faced, x.bp_saved, x.bp_had, x.bp_conv, null, null, sum(i ? g2 : g1), num(a.minutes) ? num(a.minutes)! * 60 : null, 'archive', 1, 0));
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                 */
/* ------------------------------------------------------------------ */

const jobs = new Map<string, { lastRun: string | null; lastOk: string | null; lastError: string | null; info: string | null; running: boolean }>();
/** Runs a job once at a time, recording its last run / success / error for the status route. */
async function job(name: string, fn: () => Promise<string | void>) {
  const j = jobs.get(name) || { lastRun: null, lastOk: null, lastError: null, info: null, running: false };
  jobs.set(name, j);
  if (j.running || !KEY()) return;
  j.running = true;
  j.lastRun = nowIso();
  try { const info = await fn(); j.lastOk = nowIso(); j.lastError = null; if (info) j.info = info; }
  catch (e: any) { j.lastError = e?.message || String(e); if (!(e instanceof TennisError && (e.status === 429 || e.plan || /^daily budget/.test(e.message)))) logger.warn(`tennis ${name}: ${j.lastError}`); }
  finally { j.running = false; }
}
/** fix187: a job that did not run this time says why (status route). */
function note(name: string, info: string) {
  const j = jobs.get(name) || { lastRun: null, lastOk: null, lastError: null, info: null, running: false };
  j.info = `${info} (${nowIso()})`;
  jobs.set(name, j);
}
const tx = <T>(fn: () => T): T => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

async function syncFixtures() {
  // fix187: /matches?status=upcoming carries tier, format, tournament_id and the players; /fixtures (no tier) only when
  // that listing fails
  let n = 0, via = 'matches?status=upcoming';
  try {
    await pages('/matches', { status: 'upcoming', draw: 'singles' }, 25, 'core', rows => { tx(() => { for (const m of rows) if (storeMatch(m, 'fixture')) n++; }); });
  } catch (e: any) {
    if (n) throw e;
    via = `fixtures (matches?status=upcoming failed: ${e.message})`;
    await pages('/fixtures', { draw: 'singles' }, 25, 'core', rows => { tx(() => { for (const f of rows) if (storeFixture(f)) n++; }); });
  }
  const filled = fillTiers();
  return `${n} upcoming via ${via}${filled ? `, ${filled} tiers filled (catalogue + history)` : ''}`;
}

/**
 * fix187: matches without a tier (fixture rows, older rows) take tier / surface / indoor from tennis_tournaments — by
 * tournament_id, else by the same name on the same tour (exact, case-insensitive).
 */
function fillTiers(): number {
  const a = db.prepare(`UPDATE tennis_matches SET
      tier = COALESCE(NULLIF(tier, 'unknown'), (SELECT t.tier FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id)),
      surface = COALESCE(surface, (SELECT t.surface FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id)),
      indoor = COALESCE(indoor, (SELECT t.indoor FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id))
    WHERE (tier IS NULL OR tier = 'unknown') AND tournament_id IS NOT NULL AND EXISTS (SELECT 1 FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id AND t.tier IS NOT NULL)`).run();
  const b = db.prepare(`UPDATE tennis_matches SET
      tournament_id = COALESCE(tournament_id, (SELECT t.id FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1)),
      tier = (SELECT t.tier FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1),
      surface = COALESCE(surface, (SELECT t.surface FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1)),
      indoor = COALESCE(indoor, (SELECT t.indoor FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1))
    WHERE (tier IS NULL OR tier = 'unknown') AND tournament IS NOT NULL AND EXISTS (SELECT 1 FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour AND t.tier IS NOT NULL)`).run();
  return Number(a.changes) + Number(b.changes) + fillTiersFromHistory();
}

/** fix189: a tournament name without qualifying / country / year parts ("Almaty Open - Qualification (Kazakhstan) 2025" → "almaty open"). */
const QUALI_RE = /\b(qualification|qualifying|qualifiers?|quali)\b/i;
export function tournamentKey(name: string): string {
  return name.toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s[-–—:]\s*(qualification|qualifying|qualifiers?|quali)\b.*$/, ' ')
    .replace(new RegExp(QUALI_RE.source, 'gi'), ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * fix189: upcoming matches still without a tier take it from our own history — the same tournament (tournamentKey) on
 * the same tour with a tier, the most recent main draw first (catalogue rows after match rows). Qualifying rows get
 * is_qualifying = 1 and the main draw's tier. Still nothing → tier 'unknown' (listed in tennis/status; refilled as soon
 * as the API, the catalogue or the history has a tier).
 */
function fillTiersFromHistory(): number {
  const todo = db.prepare(`SELECT id, tournament, tour FROM tennis_matches
    WHERE status = 'upcoming' AND (tier IS NULL OR tier = 'unknown') AND tournament IS NOT NULL`).all() as any[];
  if (!todo.length) return 0;
  const known = new Map<string, { tier: string; surface: string | null; indoor: number | null }>();
  const add = (tour: string | null, name: string | null, tier: string, surface: string | null, indoor: number | null) => {
    if (!tour || !name) return;
    const k = `${tour}|${tournamentKey(name)}`;
    if (!known.has(k)) known.set(k, { tier, surface, indoor });
  };
  // main draws before qualifying, most recent first
  for (const r of db.prepare(`SELECT tour, tournament, tier, MAX(surface) AS surface, MAX(indoor) AS indoor FROM tennis_matches
      WHERE tier IS NOT NULL AND tier <> 'unknown' AND tournament IS NOT NULL AND tour IS NOT NULL
      GROUP BY tour, tournament, tier ORDER BY MAX(COALESCE(is_qualifying, 0)), MAX(scheduled_at) DESC`).all() as any[]) {
    add(r.tour, r.tournament, r.tier, r.surface, r.indoor);
  }
  for (const r of db.prepare(`SELECT tour, name, tier, surface, indoor FROM tennis_tournaments WHERE tier IS NOT NULL ORDER BY start_date DESC`).all() as any[]) {
    add(r.tour, r.name, r.tier, r.surface, r.indoor);
  }
  const set = db.prepare(`UPDATE tennis_matches SET tier = ?, surface = COALESCE(surface, ?), indoor = COALESCE(indoor, ?),
    is_qualifying = CASE WHEN ? = 1 THEN 1 ELSE is_qualifying END WHERE id = ?`);
  const none = db.prepare(`UPDATE tennis_matches SET tier = 'unknown', is_qualifying = CASE WHEN ? = 1 THEN 1 ELSE is_qualifying END WHERE id = ?`);
  let n = 0;
  tx(() => {
    for (const r of todo) {
      const quali = QUALI_RE.test(r.tournament) ? 1 : 0;
      const hit = known.get(`${r.tour}|${tournamentKey(r.tournament)}`);
      if (hit) { set.run(hit.tier, hit.surface, hit.indoor, quali, r.id); n++; } else none.run(quali, r.id);
    }
  });
  return n;
}

let liveCount = 0, lastLiveRun = 0;
async function syncLive() {
  let n = 0;
  await pages('/matches', { status: 'live', draw: 'singles' }, 10, 'core', rows => { tx(() => { for (const m of rows) if (storeMatch(m, 'live')) n++; }); });
  liveCount = n;
  lastLiveRun = Date.now();
  return `${n} live`;
}

/** Finished matches since the last sync, then their tapes → statistics (tour-level first; a capped number per run). */
async function syncHistory() {
  const from = meta.get('history_from') || new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const startedAt = nowIso();
  let n = 0;
  await pages('/history/matches', { from, draw: 'singles' }, 60, 'bulk', rows => { tx(() => { for (const m of rows) if (storeMatch(m, 'history')) n++; }); });
  // the next sync starts a day back (late results and restatements)
  meta.set('history_from', new Date(Date.parse(startedAt) - 86400000).toISOString().slice(0, 10));
  const tapes = await fetchTapes(150);
  return `${n} finished, ${tapes} tapes`;
}
async function fetchTapes(max: number): Promise<number> {
  const todo = db.prepare(`
    SELECT m.id FROM tennis_matches m WHERE m.id > 0 AND m.status = 'completed' AND m.scheduled_at >= '2023-01-01'
      AND NOT EXISTS (SELECT 1 FROM tennis_match_stats s WHERE s.match_id = m.id) AND COALESCE(m.outcome, '') NOT IN ('walkover')
      AND m.id NOT IN (SELECT CAST(substr(k, 7) AS INTEGER) FROM tennis_meta WHERE k LIKE 'notape%')
    ORDER BY CASE WHEN m.tour IN ('atp', 'wta') THEN 0 WHEN m.tour = 'challenger' THEN 1 ELSE 2 END, m.scheduled_at DESC LIMIT ?`).all(max) as any[];
  const slice = slicer();
  let n = 0;
  for (const r of todo) {
    if (!canSpend('bulk')) break;
    const obj = await tn(`/history/matches/${r.id}`, {}, { kind: 'bulk' });
    if (obj && storeTape(obj) && db.prepare(`SELECT 1 FROM tennis_match_stats WHERE match_id = ?`).get(r.id)) n++;
    else meta.set(`notape${r.id}`, nowIso()); // no usable tape: not asked again
    await slice();
  }
  return n;
}

/** Players on first sight (no bio yet) and weekly; at most `max` per run. */
const upPlayer = db.prepare(`UPDATE tennis_players SET name = COALESCE(?, name), country = COALESCE(?, country), tour = COALESCE(?, tour), hand = ?, dob = ?, height = ?,
  ranking = ?, ranking_points = ?, stats = ?, updated_at = ? WHERE id = ?`);
async function syncPlayers(max = 120) {
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  const todo = db.prepare(`SELECT id FROM tennis_players WHERE updated_at IS NULL OR updated_at < ? ORDER BY updated_at IS NOT NULL, COALESCE(ranking, 9999) LIMIT ?`).all(week, max) as any[];
  const slice = slicer();
  let n = 0;
  for (const r of todo) {
    if (!canSpend('bulk')) break;
    const p = await tn(`/players/${r.id}`, {}, { kind: 'bulk' });
    if (!p) { upPlayer.run(null, null, null, null, null, null, null, null, null, nowIso(), r.id); continue; }
    if (p.is_doubles_team) { db.prepare(`DELETE FROM tennis_players WHERE id = ?`).run(r.id); continue; }
    upPlayer.run(str(p.name), str(p.country), str(p.tour), str(p.hand), str(p.birthday), num(p.height_cm ?? p.height), num(p.ranking), num(p.ranking_points),
      p.stats ? JSON.stringify(p.stats) : null, nowIso(), r.id);
    if (num(p.ranking_movement) !== null) db.prepare(`UPDATE tennis_players SET ranking_movement = ? WHERE id = ?`).run(num(p.ranking_movement), r.id);
    n++;
    await slice();
  }
  return `${n} players`;
}

async function syncRankings() {
  const date = today();
  let n = 0;
  const ins = db.prepare(`INSERT OR REPLACE INTO tennis_rankings (tour, date, rank, player_id, player_name, points) VALUES (?, ?, ?, ?, ?, ?)`);
  // fix187: the rank-ordered listing (PRO) takes exactly one `system` (atp | wta) and no `player`; `tour` is only for elo
  try {
    for (const tour of ['atp', 'wta']) await rankingListing(tour, ins, date, c => { n += c; });
    meta.set('rankings_mode', JSON.stringify({ mode: 'listing', at: nowIso() }));
    return `${n} ranking rows (listing)`;
  } catch (e: any) {
    if (!(e instanceof TennisError) || !(e.status === 400 || e.plan || e.status === 403)) throw e;
    // the listing refused: today's table from the players' own ranking (GET /players/{id}, refreshed weekly)
    const rows = db.prepare(`SELECT id, name, tour, ranking, ranking_points FROM tennis_players WHERE ranking IS NOT NULL AND tour IN ('atp', 'wta') ORDER BY tour, ranking`).all() as any[];
    tx(() => { for (const r of rows) ins.run(r.tour, date, r.ranking, r.id, r.name, r.ranking_points); });
    meta.set('rankings_mode', JSON.stringify({ mode: 'players', at: nowIso(), why: e.message, rows: rows.length }));
    return `listing refused (${e.message}): ${rows.length} rows from /players/{id}`;
  }
}
async function rankingListing(tour: string, ins: ReturnType<typeof db.prepare>, date: string, done: (n: number) => void) {
  let n = 0;
  await pages('/rankings', { system: tour }, 8, 'bulk', rows => {
    tx(() => {
      for (const r of rows) {
        if (num(r.rank) === null || (r.system && !['atp', 'wta'].includes(r.system))) continue;
        ins.run(tour, str(r.effective_date)?.slice(0, 10) || date, num(r.rank), num(r.player_id), str(r.player_name), num(r.points));
        if (num(r.player_id) !== null) seePlayer.run(num(r.player_id), str(r.player_name), null, tour, num(r.rank), num(r.points), nowIso());
        n++;
      }
    });
  });
  done(n);
}

async function syncTournaments() {
  const up = db.prepare(`INSERT INTO tennis_tournaments (id, name, tour, tier, category, surface, indoor, city, country, start_date, end_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, tour = excluded.tour, tier = COALESCE(excluded.tier, tier), category = COALESCE(excluded.category, category),
      surface = COALESCE(excluded.surface, surface), indoor = excluded.indoor, city = COALESCE(excluded.city, city), country = COALESCE(excluded.country, country),
      start_date = COALESCE(excluded.start_date, start_date), end_date = COALESCE(excluded.end_date, end_date), updated_at = excluded.updated_at`);
  let n = 0;
  await pages('/tournaments', { draw: 'singles' }, 60, 'bulk', rows => {
    tx(() => {
      for (const t of rows) {
        if (!str(t.id)) continue;
        up.run(str(t.id), str(t.name), str(t.tour), str(t.tier), str(t.category), str(t.surface), t.indoor == null ? null : t.indoor ? 1 : 0, str(t.city), str(t.country),
          str(t.start_date), str(t.end_date), nowIso());
        n++;
      }
    });
  });
  const filled = fillTiers();
  return `${n} tournaments${filled ? `, ${filled} match tiers filled` : ''}`;
}

/** Stoppages (medical timeouts, retirements …) of the players in singles fixtures of the next 48 h — tour level and Challenger. */
async function syncStoppages(max = 150) {
  const ids = (db.prepare(`SELECT DISTINCT pid FROM (SELECT p1_id AS pid, tour FROM tennis_matches WHERE scheduled_at BETWEEN ? AND ? AND status = 'upcoming'
      UNION SELECT p2_id, tour FROM tennis_matches WHERE scheduled_at BETWEEN ? AND ? AND status = 'upcoming') WHERE pid IS NOT NULL AND COALESCE(tour, '') IN ('atp', 'wta', 'challenger') LIMIT ?`)
    .all(nowIso(), new Date(Date.now() + 48 * 3600000).toISOString(), nowIso(), new Date(Date.now() + 48 * 3600000).toISOString(), max) as any[]).map(r => r.pid);
  const ins = db.prepare(`INSERT OR REPLACE INTO tennis_stoppages (player_id, match_id, kind, at, duration_s) VALUES (?, ?, ?, ?, ?)`);
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const slice = slicer();
  let n = 0;
  for (const id of ids) {
    if (!canSpend('bulk')) break;
    const j = await tn(`/players/${id}/stoppages`, { since, limit: 200 }, { kind: 'bulk' });
    tx(() => { for (const s of j?.data || []) if (num(s.match_id) !== null && str(s.kind) && str(s.at)) { ins.run(id, num(s.match_id), str(s.kind), str(s.at), num(s.duration_seconds)); n++; } });
    await slice();
  }
  return `${ids.length} players, ${n} stoppages`;
}

/** Admin benchmark: the match-winner market of singles matches starting in 45–75 min, once each (the last pre-match price). */
async function syncPrices() {
  const todo = db.prepare(`SELECT m.id FROM tennis_matches m WHERE m.status = 'upcoming' AND m.id > 0 AND m.scheduled_at BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM tennis_prices p WHERE p.match_id = m.id) LIMIT 120`).all(new Date(Date.now() + 45 * 60000).toISOString(), new Date(Date.now() + 75 * 60000).toISOString()) as any[];
  const up = db.prepare(`INSERT OR REPLACE INTO tennis_prices (match_id, p1_mid, p2_mid, p1_bid, p1_ask, p2_bid, p2_ask, at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (const r of todo) {
    if (!canSpend('bulk')) break;
    const j = await tn('/markets', { match_id: r.id }, { kind: 'bulk' });
    const mk = (j?.data || [])[0];
    const side = (k: number) => (mk?.prices || []).find((p: any) => p?.side === k) || {};
    const a = side(1), b = side(2);
    up.run(r.id, num(a.mid), num(b.mid), num(a.bid), num(a.ask), num(b.bid), num(b.ask), str(a.timestamp) || str(b.timestamp), nowIso());
    if (mk) n++;
  }
  return `${todo.length} matches, ${n} with a market`;
}

/* ------------------------------------------------------------------ */
/* Backfill                                                             */
/* ------------------------------------------------------------------ */

/** A bulk file (NDJSON, maybe gzipped) read line by line; `onLine` gets each parsed object. */
async function streamFile(path: string, params: Record<string, any>, onLine: (o: any) => void): Promise<number> {
  const res: Response | null = await tn(path, params, { kind: 'bulk', raw: true, timeoutMs: 20 * 60_000 });
  if (!res || !res.body) return 0;
  const body = Readable.fromWeb(res.body as any);
  const gz = /gzip/.test(res.headers.get('content-type') || '') || /\.gz/.test(res.headers.get('content-disposition') || '');
  const input = gz ? body.pipe(zlib.createGunzip()) : body;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const slice = slicer();
  let n = 0, batch: any[] = [];
  const flush = () => { if (batch.length) { const b = batch; batch = []; tx(() => { for (const o of b) onLine(o); }); } };
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { batch.push(JSON.parse(line)); n++; } catch { /* a broken line is skipped */ }
    if (batch.length >= 200) { flush(); await slice(); }
  }
  flush();
  return n;
}

/** Months Jan 2023 → last full month, one per run: the month's tape package (one match per line). */
async function backfillPackages() {
  if (!canSpend('bulk', 5)) return 'waiting for quota';
  const last = new Date(); last.setUTCDate(1); last.setUTCMonth(last.getUTCMonth() - 1);
  const lastFull = last.toISOString().slice(0, 7);
  const months: string[] = [];
  for (let d = new Date(Date.UTC(2023, 0, 1)); d.toISOString().slice(0, 7) <= lastFull; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(d.toISOString().slice(0, 7));
  const done = new Set((db.prepare(`SELECT k FROM tennis_meta WHERE k LIKE 'pkg:%'`).all() as any[]).map(r => r.k.slice(4)));
  const next = months.reverse().find(m => !done.has(m)); // newest first: the model needs recent seasons most
  if (!next) return 'all months done';
  const man = await tn(`/history/packages/${next}`, {}, { kind: 'bulk' });
  if (!man) { meta.set(`pkg:${next}`, 'not built'); return `${next}: not built`; }
  let matches = 0;
  const lines = await streamFile(`/history/packages/${next}`, { format: 'jsonl' }, o => { if (storeTape(o)) matches++; });
  meta.set(`pkg:${next}`, JSON.stringify({ at: nowIso(), lines, singles: matches, schema: man.schema_version ?? null }));
  return `${next}: ${matches} singles matches of ${lines}`;
}

/** The 2015–2022 results archive (ATP + WTA): yearly archive packages, or the paged listing when the plan refuses them. */
async function backfillArchive() {
  if (!canSpend('bulk', 5)) return 'waiting for quota';
  for (let y = 2022; y >= 2015; y--) {
    if (meta.get(`arch:${y}`)) continue;
    if (meta.get('arch_mode') !== 'listing') {
      try {
        const n = await streamFile(`/history/packages/${y}`, { kind: 'archive', format: 'jsonl' }, o => { if (['atp', 'wta'].includes(String(o?.tour))) storeArchive(o); });
        if (n) { meta.set(`arch:${y}`, JSON.stringify({ at: nowIso(), rows: n, via: 'package' })); return `${y}: ${n} archive rows (package)`; }
      } catch (e: any) {
        if (!(e instanceof TennisError && (e.plan || e.status === 404))) throw e;
      }
      meta.set('arch_mode', 'listing');
    }
    // listing: resumable offset per tour and year, at most 40 pages a run
    let total = 0;
    for (const tour of ['atp', 'wta']) {
      const k = `arch_off:${y}:${tour}`;
      if (meta.get(k) === 'done') continue;
      let offset = Number(meta.get(k) || 0);
      for (let p = 0; p < 20; p++) {
        if (!canSpend('bulk')) return `${y} ${tour}: paused at ${offset} (quota)`;
        const j = await tn('/history/archive/matches', { tour, from: `${y}-01-01`, to: `${y}-12-31`, limit: 200, offset }, { kind: 'bulk' });
        const rows: any[] = j?.data || [];
        tx(() => { for (const r of rows) storeArchive(r); });
        total += rows.length;
        offset += rows.length;
        meta.set(k, String(offset));
        if (!j?.meta?.has_more || !rows.length) { meta.set(k, 'done'); break; }
      }
      if (meta.get(k) !== 'done') return `${y} ${tour}: ${offset} rows so far`;
    }
    meta.set(`arch:${y}`, JSON.stringify({ at: nowIso(), via: 'listing' }));
    return `${y}: done (${total} rows this run)`;
  }
  return 'archive 2015–2022 done';
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                            */
/* ------------------------------------------------------------------ */

let started = false;
export function startTennisScheduler() {
  if (started) return;
  started = true;
  if (!KEY()) { logger.info('tennis: TENNIS_API_KEY not set — tennis jobs off'); return; }
  const runUsage = () => readUsage().catch(e => { const j = jobs.get('usage') || { lastRun: null, lastOk: null, lastError: null, info: null, running: false }; j.lastError = e.message; jobs.set('usage', j); });
  after('tennis start', async () => {
    await runUsage();
    await job('fixtures', syncFixtures);
    await job('live', syncLive);
    await job('tournaments', syncTournaments);
  }, 60 * 1000).unref();
  every('tennis usage', runUsage, 30 * 60 * 1000).unref();
  every('tennis fixtures', () => job('fixtures', syncFixtures), 15 * 60 * 1000).unref();
  // live: every minute while something is live, else every 10 minutes
  every('tennis live', () => (liveCount > 0 || Date.now() - lastLiveRun >= 10 * 60 * 1000 ? job('live', syncLive) : undefined), 60 * 1000).unref();
  every('tennis history', () => job('history', syncHistory), 30 * 60 * 1000).unref();
  every('tennis players', () => job('players', () => syncPlayers()), 20 * 60 * 1000).unref();
  every('tennis rankings', () => job('rankings', syncRankings), 24 * 3600 * 1000).unref();
  after('tennis rankings first', () => job('rankings', syncRankings), 5 * 60 * 1000).unref();
  every('tennis tournaments', () => job('tournaments', syncTournaments), 24 * 3600 * 1000).unref();
  every('tennis stoppages', () => job('stoppages', () => syncStoppages()), 6 * 3600 * 1000).unref();
  every('tennis prices', () => job('prices', syncPrices), 10 * 60 * 1000).unref();
  // backfill: one month / one archive step every 5 min (fix187; ~25 s each), always under the reserve; skipped while a
  // live sync runs or when the event loop was blocked > 500 ms in the last minute
  const calm = (name: string, fn: () => Promise<string | void>) => () => {
    if (jobs.get('live')?.running) { note(name, 'skipped: live sync running'); return; }
    if (stalledWithin(60 * 1000, 500)) { note(name, 'skipped: event loop blocked > 500 ms in the last minute'); return; }
    return job(name, fn);
  };
  every('tennis backfill packages', calm('backfill packages', backfillPackages), 5 * 60 * 1000).unref();
  every('tennis backfill archive', calm('backfill archive', backfillArchive), 5 * 60 * 1000).unref();
  after('tennis backfill first', async () => { await job('backfill packages', backfillPackages); await job('backfill archive', backfillArchive); }, 8 * 60 * 1000).unref();
}

/* ------------------------------------------------------------------ */
/* Admin                                                                */
/* ------------------------------------------------------------------ */

/** Key names of an object (and of its first list row), and one trimmed sample row — never the key, never long strings. */
function shapeOf(j: any) {
  const trim = (v: any, d = 0): any => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v;
    if (Array.isArray(v)) return d > 2 ? `[${v.length}]` : v.slice(0, 3).map(x => trim(x, d + 1)).concat(v.length > 3 ? [`… ${v.length - 3} more`] : []);
    if (d > 3) return '{…}';
    return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, trim(x, d + 1)]));
  };
  const row = Array.isArray(j?.data) ? j.data[0] : Array.isArray(j?.tape) ? j.tape[0] : j;
  return { keys: j && typeof j === 'object' ? Object.keys(j) : [], rowKeys: row && typeof row === 'object' ? Object.keys(row) : [], sample: trim(row), meta: j?.meta ? trim(j.meta) : undefined };
}

/** One live call per endpoint we use: HTTP status, plan error, key names and one trimmed sample row. */
export async function tennisProbe() {
  if (!KEY()) return { configured: false };
  const out: any[] = [];
  const call = async (label: string, path: string, params: Record<string, any> = {}) => {
    try {
      const j = await tn(path, params, { kind: 'core' });
      out.push({ endpoint: label, status: j === null ? 404 : 200, ...(j === null ? {} : shapeOf(j)) });
      return j;
    } catch (e: any) {
      out.push({ endpoint: label, status: e instanceof TennisError ? e.status || null : null, planError: e instanceof TennisError && e.plan ? 'upgrade_required' : undefined, error: e.message });
      return null;
    }
  };
  try { await readUsage(); out.push({ endpoint: '/usage', status: 200, tier: usage?.tier, callsToday: usage?.calls, perDay: usage?.perDay }); } catch (e: any) { out.push({ endpoint: '/usage', error: e.message }); }
  const fx = await call('/fixtures', '/fixtures', { draw: 'singles', limit: 2 });
  await call('/matches?status=live', '/matches', { status: 'live', draw: 'singles', limit: 2 });
  const hist = await call('/history/matches', '/history/matches', { draw: 'singles', limit: 2 });
  const mid = hist?.data?.[0]?.id;
  if (mid) await call('/history/matches/{id}', `/history/matches/${mid}`);
  const pid = fx?.data?.[0]?.player1_id || hist?.data?.[0]?.players?.p1?.id;
  if (pid) { await call('/players/{id}', `/players/${pid}`); await call('/players/{id}/stoppages', `/players/${pid}/stoppages`, { limit: 2 }); }
  await call('/rankings?system=atp', '/rankings', { system: 'atp', limit: 2 });
  await call('/matches?status=upcoming', '/matches', { status: 'upcoming', draw: 'singles', limit: 2 });
  await call('/tournaments', '/tournaments', { draw: 'singles', limit: 2 });
  const up = fx?.data?.[0]?.id;
  if (up) await call('/markets', '/markets', { match_id: up });
  const pk = await call('/history/packages', '/history/packages', {});
  const period = pk?.data?.[0]?.period;
  if (period) await call('/history/packages/{period}', `/history/packages/${period}`);
  await call('/history/packages?kind=archive', '/history/packages', { kind: 'archive' });
  await call('/history/archive/matches', '/history/archive/matches', { tour: 'atp', from: '2019-01-01', to: '2019-12-31', limit: 2 });
  return { configured: true, base: BASE, calls: out.length, results: out };
}

/**
 * fix187: a sample to compare with the real ATP / WTA schedule: start (UTC), tournament, tier, surface, round, both players
 * with their ranks, score and winner.
 */
export function tennisSample(o: { tour?: string; status?: string; limit?: number }) {
  const tour = ['atp', 'wta', 'challenger', 'itf'].includes(String(o.tour)) ? String(o.tour) : 'atp';
  const status = ['upcoming', 'live', 'completed'].includes(String(o.status)) ? String(o.status) : 'upcoming';
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 30));
  const where = status === 'upcoming' ? `AND m.scheduled_at >= ?` : status === 'completed' ? `AND m.scheduled_at <= ?` : `AND ? IS NOT NULL`;
  const rows = db.prepare(`SELECT m.*, ${rankSql('p1')} AS p1_trank, p1.ranking AS p1_prank, ${rankSql('p2')} AS p2_trank, p2.ranking AS p2_prank FROM tennis_matches m
      LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id
    WHERE m.tour = ? AND m.status = ? ${where} ORDER BY m.scheduled_at ${status === 'completed' ? 'DESC' : 'ASC'} LIMIT ?`)
    .all(tour, status, new Date(Date.now() - 3 * 3600 * 1000).toISOString(), limit) as any[];
  const score = (r: any) => {
    try {
      const g = JSON.parse(r.games || 'null');
      if (Array.isArray(g) && Array.isArray(g[0]) && Array.isArray(g[1])) return g[0].map((x: any, i: number) => `${x}-${g[1][i] ?? ''}`).join(' ');
    } catch { /* none */ }
    return null;
  };
  // fix189: rank from the latest rankings table first, /players/{id} as fallback; rankSource says which
  const rank = (t: number | null, p: number | null) => (t != null ? { rank: t, rankSource: 'rankings' } : p != null ? { rank: p, rankSource: 'players' } : { rank: null, rankSource: null });
  const rankingsMode = (() => { try { return JSON.parse(meta.get('rankings_mode') || 'null')?.mode ?? null; } catch { return null; } })();
  return {
    tour, status, count: rows.length, rankingsMode,
    rows: rows.map(r => ({
      startUtc: r.scheduled_at, tournament: r.tournament, tier: r.tier, qualifying: r.is_qualifying == null ? null : !!r.is_qualifying, surface: r.surface,
      indoor: r.indoor == null ? null : !!r.indoor, round: r.round || r.round_code,
      bestOf: r.best_of, p1: { name: r.p1_name, ...rank(r.p1_trank, r.p1_prank) }, p2: { name: r.p2_name, ...rank(r.p2_trank, r.p2_prank) },
      score: score(r), winner: r.winner === 1 ? r.p1_name : r.winner === 2 ? r.p2_name : null, outcome: r.outcome, source: r.source, id: r.id
    }))
  };
}

/** Admin status: rows, coverage, backfill progress, quota, jobs. */
export function tennisStatus() {
  const cnt = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number;
  const byTour = db.prepare(`SELECT COALESCE(tour, '?') AS tour, COALESCE(tier, '?') AS tier, substr(COALESCE(scheduled_at, ''), 1, 4) AS year, COUNT(*) AS n
    FROM tennis_matches GROUP BY 1, 2, 3 ORDER BY 3 DESC, 1, 2`).all();
  const recent: any = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM tennis_match_stats s WHERE s.match_id = m.id) THEN 1 ELSE 0 END) AS withStats,
    SUM(CASE WHEN EXISTS (SELECT 1 FROM tennis_match_stats s WHERE s.match_id = m.id AND s.complete = 1) THEN 1 ELSE 0 END) AS complete
    FROM tennis_matches m WHERE m.id > 0 AND m.status = 'completed' AND m.scheduled_at >= '2023-01-01'`).get();
  const pkgs = (db.prepare(`SELECT k, v FROM tennis_meta WHERE k LIKE 'pkg:%' ORDER BY k DESC`).all() as any[]).map(r => ({ month: r.k.slice(4), ...(() => { try { return JSON.parse(r.v); } catch { return { note: r.v }; } })() }));
  const now = new Date(); const monthsTotal = (now.getUTCFullYear() - 2023) * 12 + now.getUTCMonth();
  const arch = (db.prepare(`SELECT k, v FROM tennis_meta WHERE k LIKE 'arch%' ORDER BY k DESC`).all() as any[]).map(r => ({ key: r.k, value: r.v }));
  // fix187: per month (2023+), how many completed matches have a tape and how many of those tapes are complete
  const tapeByMonth = (db.prepare(`SELECT substr(m.scheduled_at, 1, 7) AS month, COUNT(*) AS completed,
      SUM(CASE WHEN s.match_id IS NOT NULL THEN 1 ELSE 0 END) AS withStats, SUM(CASE WHEN s.complete = 1 THEN 1 ELSE 0 END) AS completeStats
    FROM tennis_matches m LEFT JOIN tennis_match_stats s ON s.match_id = m.id AND s.player = 1
    WHERE m.id > 0 AND m.status = 'completed' AND m.scheduled_at >= '2023-01-01' GROUP BY 1 ORDER BY 1 DESC`).all() as any[])
    .map(r => ({ ...r, pctWithStats: r.completed ? Math.round((1000 * r.withStats) / r.completed) / 10 : null, pctCompleteOfStats: r.withStats ? Math.round((1000 * r.completeStats) / r.withStats) / 10 : null, partial: r.withStats - r.completeStats }));
  return {
    configured: !!KEY(),
    rows: Object.fromEntries(['tennis_matches', 'tennis_players', 'tennis_tournaments', 'tennis_match_stats', 'tennis_rankings', 'tennis_stoppages', 'tennis_prices'].map(t => [t, cnt(t)])),
    matchesBySource: db.prepare(`SELECT source, COUNT(*) AS n FROM tennis_matches GROUP BY source`).all(),
    matchesByTourTierYear: byTour,
    since2023: { completed: recent.n || 0, withStats: recent.withStats || 0, completeStats: recent.complete || 0, pctWithStats: recent.n ? Math.round((1000 * (recent.withStats || 0)) / recent.n) / 10 : null },
    tapeByMonth,
    rankings: { mode: (() => { try { return JSON.parse(meta.get('rankings_mode') || 'null'); } catch { return null; } })(), byTour: db.prepare(`SELECT tour, MAX(date) AS date, COUNT(*) AS n FROM tennis_rankings GROUP BY tour`).all() },
    upcomingWithoutTier: (db.prepare(`SELECT COUNT(*) AS n FROM tennis_matches WHERE status = 'upcoming' AND (tier IS NULL OR tier = 'unknown')`).get() as any).n,
    // fix189: tournaments still at tier 'unknown' after the catalogue and history fills — to map by hand
    unknownTierTournaments: db.prepare(`SELECT tour, tournament, COUNT(*) AS matches, MIN(scheduled_at) AS firstMatch FROM tennis_matches
      WHERE status = 'upcoming' AND (tier IS NULL OR tier = 'unknown') GROUP BY tour, tournament ORDER BY tour, tournament`).all(),
    backfill: { packages: { done: pkgs.length, of: monthsTotal, months: pkgs.slice(0, 40) }, archive: arch },
    quota: { callsToday: usedToday(), ourCountToday: callsToday(), limit: dayLimit(), reserve: RESERVE(), usage: usage ? { tier: usage.tier, calls: usage.calls, remaining: usage.remaining, readAt: new Date(usage.at).toISOString() } : null, backoffUntil: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null, blockedEndpoints: Object.fromEntries(blocked) },
    callsByDay: db.prepare(`SELECT day, calls, errors FROM tennis_calls ORDER BY day DESC LIMIT 14`).all(),
    live: { count: liveCount, lastRun: lastLiveRun ? new Date(lastLiveRun).toISOString() : null },
    jobs: Object.fromEntries([...jobs].map(([k, v]) => [k, { lastRun: v.lastRun, lastOk: v.lastOk, lastError: v.lastError, info: v.info, running: v.running }]))
  };
}

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
import { every, after, slicer, stalledWithin, yieldLoop, everyHeavy, afterHeavy, heavy } from './perf';
import { isAbbreviated, fullName } from '../utils/tennisNames';
import { ROUND_ORDER, normRound, roundFromName, nextRound } from '../utils/tennisRounds';

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
// fix194: a player the provider removed (HTTP 410) is marked gone and not asked for again; the refresh list reads an index
try { db.exec(`ALTER TABLE tennis_players ADD COLUMN gone INTEGER`); } catch { /* column exists */ }
db.exec(`CREATE INDEX IF NOT EXISTS idx_tennis_players_updated ON tennis_players(updated_at)`);
// fix195: the profile's first / last name (surname-first provider names, the short name in tight rows); old fixture ids
// merged into their match (/tennis/match/<old id> redirects there)
try { db.exec(`ALTER TABLE tennis_players ADD COLUMN first_name TEXT`); } catch { /* column exists */ }
try { db.exec(`ALTER TABLE tennis_players ADD COLUMN last_name TEXT`); } catch { /* column exists */ }
db.exec(`CREATE TABLE IF NOT EXISTS tennis_id_moves (old_id INTEGER PRIMARY KEY, new_id INTEGER NOT NULL, at TEXT NOT NULL)`);
/** fix195: the match id a merged (old fixture) id now lives under, or null */
export function tennisMovedId(id: number): number | null {
  const r = db.prepare(`SELECT new_id FROM tennis_id_moves WHERE old_id = ?`).get(id) as any;
  return r ? Number(r.new_id) : null;
}
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
  countCall.run(today(), res.ok || res.status === 404 || res.status === 410 ? 0 : 1);
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
  // fix194: 410 Gone = the provider removed this player / match: the caller marks it and stops asking
  if (res.status === 410) { try { await res.body?.cancel(); } catch { /* none */ } throw new TennisError(`${tpl}: gone (410)`, 410); }
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
const seeFull = db.prepare(`INSERT INTO tennis_players (id, name, country, tour, ranking, ranking_points, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, name), country = COALESCE(excluded.country, country), tour = COALESCE(excluded.tour, tour),
    ranking = COALESCE(excluded.ranking, ranking), ranking_points = COALESCE(excluded.ranking_points, ranking_points), seen_at = excluded.seen_at`);
// fix195: a short name ("D. E. Galan", from /fixtures) never replaces a full one
const seeShort = db.prepare(`INSERT INTO tennis_players (id, name, country, tour, ranking, ranking_points, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name = COALESCE(name, excluded.name), country = COALESCE(excluded.country, country), tour = COALESCE(tour, excluded.tour),
    ranking = COALESCE(excluded.ranking, ranking), ranking_points = COALESCE(excluded.ranking_points, ranking_points), seen_at = excluded.seen_at`);
const seePlayer = { run: (id: number | null, name: string | null, country: string | null, tour: string | null, rank: number | null, pts: number | null, at: string) =>
  (isAbbreviated(name) ? seeShort : seeFull).run(id, name, country, tour, rank, pts, at) };
/** fix195: the full name we hold for a player (null when we only have initials) */
const fullNameOf = db.prepare(`SELECT name, first_name, last_name FROM tennis_players WHERE id = ?`);
const knownName = (id: number | null, fallback: string | null): string | null => {
  if (id === null) return fallback;
  const r = fullNameOf.get(id) as any;
  const n = r ? fullName(r.name, r.first_name, r.last_name) : '';
  return n && !isAbbreviated(n) ? n : fallback;
};

/**
 * fix195: the tour of a fixture from its tournament, never 'atp' by default: ITF names (M15 … W100) → itf, "Challenger"
 * → challenger, else the fixture's tour, women's events (gender / a "W" ITF name) → wta. The ITF tier carries the
 * gender (itf_m25 / itf_w35) so the model and the pages read it.
 */
export const ITF_NAME = /^(?:ITF\s+)?([MW])(15|25|35|40|50|60|75|80|100)\b/i;
export function tourOfFixture(f: any): { tour: string | null; tier: string | null; women: boolean | null } {
  const name = String(f?.tournament || f?.tournament_name || '').trim();
  const g = String(f?.gender ?? f?.sex ?? f?.category ?? '').toLowerCase();
  const women = /^(f|w|women|female|ladies|wta)/.test(g) ? true : /^(m|men|male|atp)/.test(g) ? false : null;
  const itf = name.match(ITF_NAME);
  if (itf) return { tour: 'itf', tier: `itf_${itf[1].toLowerCase()}${itf[2]}`, women: itf[1].toUpperCase() === 'W' };
  if (/\bITF\b/i.test(name)) return { tour: 'itf', tier: null, women };
  if (/challenger/i.test(name)) return { tour: 'challenger', tier: null, women: false };
  const t = str(f?.tour)?.toLowerCase() ?? null;
  if (t === 'atp' && women) return { tour: 'wta', tier: null, women };
  if (t === 'wta' && women === false) return { tour: 'atp', tier: null, women };
  if (t) return { tour: t, tier: null, women };
  return { tour: women === true ? 'wta' : women === false ? 'atp' : null, tier: null, women };
}

/* ------------------------------------------------------------------ */
/* fix197: a match's event is always of its players' gender            */
/* ------------------------------------------------------------------ */

type Gen = 'm' | 'w';
/** The gender of an event from its tour / tier / name (ITF "M25 …" / "W35 …" by the name; as classify() in tennisModel); null = unknown */
export function eventGender(tour: string | null, tier: string | null, name: string | null): Gen | null {
  const tr = String(tour || '').toLowerCase(), ti = String(tier || '').toLowerCase();
  const itf = String(name || '').trim().match(ITF_NAME);
  if (itf) return itf[1].toUpperCase() === 'W' ? 'w' : 'm';
  if (tr === 'wta' || /^(wta|itf_w|bjk)/.test(ti)) return 'w';
  if (tr === 'atp' || tr === 'challenger' || /^(atp|challenger|itf_m)/.test(ti)) return 'm';
  return null;
}
/**
 * fix197b: the gender of each part of an event (ITF name, tour, tier): 'x' when they disagree (a "challenger" row with
 * the WTA 125 tier, a "wta" row with a Challenger tier — eventGender reads those by the first part only), else the
 * gender or null. A row counts as right only when no part is of the other gender.
 */
export function eventGenderStrict(tour: string | null, tier: string | null, name: string | null): Gen | 'x' | null {
  const tr = String(tour || '').toLowerCase(), ti = String(tier || '').toLowerCase();
  const itf = String(name || '').trim().match(ITF_NAME);
  const parts = [
    itf ? (itf[1].toUpperCase() === 'W' ? 'w' : 'm') : null,
    tr === 'wta' ? 'w' : tr === 'atp' || tr === 'challenger' ? 'm' : null,
    /^(wta|itf_w|bjk)/.test(ti) ? 'w' : /^(atp|challenger|itf_m)/.test(ti) ? 'm' : null
  ].filter((g): g is Gen => !!g);
  if (!parts.length) return null;
  return parts.every(g => g === parts[0]) ? parts[0] : 'x';
}
/** fix197b: what is wrong with a row's event, in words ("men stored under a WTA event: tour wta, tier wta_125, id wta-cali") */
function mismatchText(r: any, pg: Gen): string {
  const ev = eventGenderStrict(r.tour, r.tier, r.tournament);
  const label = (g: Gen) => (g === 'w' ? 'WTA / women\'s' : 'ATP / Challenger / men\'s');
  const what = ev === 'x' ? `a mixed event (tour and tier of different genders)` : `a ${label(ev === 'w' ? 'w' : 'm')} event`;
  return `${pg === 'm' ? 'men' : 'women'} stored under ${what}: tour ${r.tour ?? '—'}, tier ${r.tier ?? '—'}, id ${r.tournament_id ?? '—'}`;
}
/** SQL twin of eventGender (tour / tier only) for a table alias */
const genSql = (a: string) => `(CASE WHEN lower(COALESCE(${a}.tour, '')) = 'wta' OR lower(COALESCE(${a}.tier, '')) LIKE 'wta%' OR lower(COALESCE(${a}.tier, '')) LIKE 'itf_w%' THEN 'w'
  WHEN lower(COALESCE(${a}.tour, '')) IN ('atp', 'challenger') OR lower(COALESCE(${a}.tier, '')) LIKE 'atp%' OR lower(COALESCE(${a}.tier, '')) LIKE 'challenger%' OR lower(COALESCE(${a}.tier, '')) LIKE 'itf_m%' THEN 'm' END)`;
/** The place words of an event name, without tour / level / gender words: "WTA Cali" and "Cali Challenger" → "cali" */
export function placeKey(name: string | null | undefined): string {
  return tournamentKey(String(name || '')).replace(/\b(wta|atp|itf|challenger|men|women|ladies|s|open|[mw]?\d+)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
const rankTourQ = db.prepare(`SELECT tour FROM tennis_rankings WHERE player_id = ? ORDER BY date DESC LIMIT 1`);
const profTourQ = db.prepare(`SELECT tour FROM tennis_players WHERE id = ?`);
const genCache = new Map<string, Gen | null>();
const tourGen = (t: any): Gen | null => (t === 'wta' ? 'w' : t === 'atp' || t === 'challenger' ? 'm' : null);
function playerGen(id: number | null, how: 'rank' | 'profile'): Gen | null {
  if (id === null || id === undefined) return null;
  const k = `${how}${id}`;
  if (genCache.has(k)) return genCache.get(k)!;
  const g = tourGen(((how === 'rank' ? rankTourQ : profTourQ).get(id) as any)?.tour);
  if (genCache.size > 30_000) genCache.clear(); // fix210b: lower (was 100,000)
  // fix197b: "not known" is not kept (a new player's profile / ranking arrives later in the same sync)
  if (g) genCache.set(k, g);
  return g;
}
/**
 * The players' gender: the rankings first (either player; two ranked players must agree), else both profiles agreeing
 * (a profile's tour can come from a mislabelled match, so one profile alone is not enough); null = not sure.
 */
export function playersGender(id1: number | null, id2: number | null): Gen | null {
  const r1 = playerGen(id1, 'rank'), r2 = playerGen(id2, 'rank');
  if (r1 || r2) return r1 && r2 && r1 !== r2 ? null : r1 || r2;
  const p1 = playerGen(id1, 'profile'), p2 = playerGen(id2, 'profile');
  return p1 && p2 && p1 === p2 ? p1 : null;
}

type Ev = { id: string | null; name: string; tour: string; tier: string | null };
const DAY_MS = 86400000;
const stripQuali = (name: string) => name.replace(/\s*[-–,]\s*(qualification|qualifying|qualifiers?).*$/i, '').replace(new RegExp(`\\s*\\b${QUALI_RE.source}`, 'gi'), '').trim() || name;
const evCache = new Map<string, { at: number; ev: Ev | null }>();
const siblingQ = db.prepare(`SELECT tournament_id, tournament, tour, tier, is_qualifying, p1_id, p2_id FROM tennis_matches INDEXED BY idx_tennis_matches_time
  WHERE scheduled_at >= ? AND scheduled_at < ? AND source <> 'archive' AND instr(lower(tournament), ?) > 0 LIMIT 3000`);
const catalogueQ = db.prepare(`SELECT id, name, tour, tier, city FROM tennis_tournaments WHERE start_date >= ? AND start_date <= ?`);
/**
 * The event of gender `g` played in the same place the same weeks: our own rows of that gender first (the main draw's
 * name / tour / tier / id; rows whose players are of the other gender don't count), else the tournament catalogue.
 */
function eventFor(name: string, at: string, g: Gen): Ev | null {
  const pk = placeKey(name), T = Date.parse(at);
  if (!pk || !Number.isFinite(T)) return null;
  const ck = `${pk}|${g}|${Math.floor(T / (7 * DAY_MS))}`;
  const c = evCache.get(ck);
  if (c && Date.now() - c.at < 3600e3) return c.ev;
  const other: Gen = g === 'm' ? 'w' : 'm';
  const cands = (siblingQ.all(new Date(T - 12 * DAY_MS).toISOString(), new Date(T + 12 * DAY_MS).toISOString(), pk.split(' ')[0]) as any[])
    .filter(r => placeKey(r.tournament) === pk && eventGenderStrict(r.tour, r.tier, r.tournament) === g && playersGender(r.p1_id, r.p2_id) !== other);
  const mains = cands.filter(r => !r.is_qualifying && !QUALI_RE.test(r.tournament));
  const from = mains.length ? mains : cands;
  const votes = new Map<string, { r: any; n: number }>();
  for (const r of from) { const k = `${r.tournament_id}|${r.tournament}|${r.tour}|${r.tier}`; const v = votes.get(k); if (v) v.n++; else votes.set(k, { r, n: 1 }); }
  const best = [...votes.values()].sort((a, b) => b.n - a.n)[0]?.r;
  const cat = (catalogueQ.all(new Date(T - 21 * DAY_MS).toISOString().slice(0, 10), new Date(T + DAY_MS).toISOString().slice(0, 10)) as any[])
    .filter(t => (placeKey(t.name) === pk || placeKey(t.city) === pk) && eventGenderStrict(t.tour, t.tier, t.name) === g)
    .sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')))[0];
  let ev: Ev | null = null;
  if (best) ev = { id: mains.length ? best.tournament_id : cat?.id ?? null, name: stripQuali(best.tournament), tour: best.tour, tier: best.tier ?? cat?.tier ?? null };
  else if (cat) ev = { id: cat.id, name: cat.name, tour: /^challenger/i.test(String(cat.tier || '')) ? 'challenger' : cat.tour, tier: cat.tier };
  if (evCache.size > 500) evCache.clear(); // fix210b: lower (was 2,000)
  evCache.set(ck, { at: Date.now(), ev });
  return ev;
}
/** No event of the players' gender found: the same event moved to the other gender's family (WTA 125 ↔ Challenger, ITF W ↔ M, a Slam's other tour) */
function crossEvent(r: any, g: Gen): Ev {
  const ti = String(r.tier || '').toLowerCase(), name = String(r.tournament || '');
  const itf = name.match(ITF_NAME);
  if (itf) return { id: null, name: name.replace(/^(ITF\s+)?[MW]/i, `$1${g === 'w' ? 'W' : 'M'}`), tour: 'itf', tier: `itf_${g}${itf[2]}` };
  const clean = (s: string) => s.replace(g === 'm' ? /\b(WTA|women'?s|ladies)\b/gi : /\b(ATP|Challenger|men'?s)\b/gi, ' ').replace(/\s+/g, ' ').trim() || s;
  if (ti === 'grand_slam') return { id: r.tournament_id, name, tour: g === 'w' ? 'wta' : 'atp', tier: 'grand_slam' };
  if (String(r.tour || '').toLowerCase() === 'itf' || /^itf/.test(ti)) return { id: null, name: clean(name), tour: 'itf', tier: `itf_${g}` };
  if (g === 'm') return /125/.test(ti) || !/^wta_(250|500|1000)/.test(ti) ? { id: null, name: clean(name), tour: 'challenger', tier: null } : { id: null, name: clean(name), tour: 'atp', tier: ti.replace('wta', 'atp') };
  return String(r.tour || '').toLowerCase() === 'challenger' || /^challenger/.test(ti) ? { id: null, name: clean(name), tour: 'wta', tier: 'wta_125' } : { id: null, name: clean(name), tour: 'wta', tier: /^atp_/.test(ti) ? ti.replace('atp', 'wta') : null };
}
const rowQ = db.prepare(`SELECT id, tournament_id, tournament, tour, tier, p1_id, p2_id, scheduled_at, source FROM tennis_matches WHERE id = ?`);
const setEvent = db.prepare(`UPDATE tennis_matches SET tournament_id = ?, tournament = ?, tour = ?, tier = ? WHERE id = ?`);
/** fix197b: the players' gender when the row's event (any of its parts) is of another one, else null */
function wrongGender(r: any): Gen | null {
  if (!r || r.source === 'archive' || r.id <= 0 || !r.tournament) return null;
  const eg = eventGenderStrict(r.tour, r.tier, r.tournament);
  const pg = eg ? playersGender(r.p1_id, r.p2_id) : null;
  return eg && pg && eg !== pg ? pg : null;
}
/**
 * fix197 / fix197b: THE place a row's event (tournament_id, tournament, tour, tier) is settled — every write path calls
 * it after its own write (upcoming sync, /fixtures, live, history, tapes, refetch, the tier fills, the duplicate merge),
 * so the provider's tour / tournament never stay on a row of the other gender. A row whose event (tour, tier or ITF
 * name; a "challenger" row with the WTA 125 tier counts as wrong) is of another gender than its players → moved to the
 * players' event. Returns "from → to" or null.
 */
function fixGender(r: any): string | null {
  const pg = r?.scheduled_at ? wrongGender(r) : null;
  if (!pg) return null;
  const ev = eventFor(r.tournament, r.scheduled_at, pg) || crossEvent(r, pg);
  if (eventGenderStrict(ev.tour, ev.tier, ev.name) !== pg) return null;
  setEvent.run(ev.id, ev.name, ev.tour, ev.tier, r.id);
  return `${r.tournament} (${r.tour}${r.tier ? ` ${r.tier}` : ''}) → ${ev.name} (${ev.tour}${ev.tier ? ` ${ev.tier}` : ''})`;
}
/** fix197b: one stored row's event settled by its id (see fixGender) */
const settleEvent = (id: number | null): string | null => (id === null ? null : fixGender(rowQ.get(id)));

/**
 * fix193: a live match's current game (points) and server, when the provider gives them (field names vary by feed: the
 * score's points / game, the match's server / serving) — for the live win chance; null when neither is there.
 */
function liveExtra(m: any): string | null {
  const sc = m?.score || {};
  const pts = sc.points ?? sc.game ?? sc.current_game ?? null;
  const pair = Array.isArray(pts) && pts.length === 2 ? pts.map((x: any) => String(x)) : pts && typeof pts === 'object' && ('p1' in pts || 'player1' in pts) ? [String(pts.p1 ?? pts.player1), String(pts.p2 ?? pts.player2)] : null;
  const srv = num(m?.server ?? m?.serving ?? sc.server ?? sc.serving);
  if (!pair && srv === null) return null;
  return JSON.stringify({ livePoints: pair, server: srv === 1 || srv === 2 ? srv : null, at: nowIso() });
}

/** A Match object (/matches, /history/matches, a tape's `match`) → tennis_matches. Doubles are skipped. */
export function storeMatch(m: any, source: 'fixture' | 'live' | 'history'): boolean {
  if (!m || num(m.id) === null || isDoubles(m)) return false;
  const p1 = m.players?.p1 || {}, p2 = m.players?.p2 || {};
  const outcome = str(m.outcome);
  const sc = m.score || null;
  // fix195: an ITF event by its name (M25 …, W35 …) is ITF whatever the row says; initials never replace a full name
  const itf = ITF_NAME.test(String(m.tournament || '')) ? tourOfFixture(m) : null;
  const nm = (p: any) => (isAbbreviated(p.name) ? knownName(num(p.id), str(p.name)) : str(p.name));
  // fix197: the round code from the provider's code / round text (the pages' mapping), else the end of the tournament name
  const quali = !!m.is_qualifying || QUALI_RE.test(String(m.tournament || ''));
  const rc = normRound(m.round_code, m.round, quali) ?? roundFromName(m.tournament, quali) ?? str(m.round_code) ?? (quali ? 'Q' : null);
  upMatch.run(num(m.id), str(m.tournament_id), str(m.tournament), itf ? 'itf' : str(m.tour), str(m.tier) ?? itf?.tier ?? null, str(m.surface), m.indoor == null ? null : m.indoor ? 1 : 0,
    str(m.draw) || 'singles', str(m.round), rc, m.is_qualifying == null ? null : m.is_qualifying ? 1 : 0, bestOf(m.format),
    str(m.scheduled_time) || str(m.live_at), str(m.status), str(m.event_status), num(p1.id), nm(p1), num(p2.id), nm(p2),
    sc?.sets ? JSON.stringify(sc.sets) : null, sc?.games ? JSON.stringify(sc.games) : null, num(m.winner), outcome,
    outcome && /retired|walkover|default/.test(outcome) ? 1 : 0, source === 'live' ? liveExtra(m) : null, source, nowIso());
  for (const p of [p1, p2]) if (num(p.id) !== null) seePlayer.run(num(p.id), str(p.name), str(p.country), str(p.tour), num(p.ranking), num(p.ranking_points), nowIso());
  // fix197: never under an event of the other gender (the provider put the men's Cali Challenger under the WTA 125 "Cali");
  // fix197b: always the stored row (what the upsert kept + what the provider sent), never the provider's fields alone
  settleEvent(num(m.id));
  touched?.add(num(m.id)!);
  return true;
}
/**
 * A /fixtures row (its own flat shape) → tennis_matches as 'fixture'.
 * fix195: stored under its match_id, so it IS the match row (fixture ids are their own id space: they made a second
 * row next to the match, and could land on an old match with the same number); a fixture without a match_id is not
 * stored. A row we already hold keeps its own data: the fixture only fills what is missing (and the start time while
 * the match has not started). Names: the full name we hold for the player, the fixture's short name only as fallback.
 */
const upFixture = db.prepare(`
  INSERT INTO tennis_matches (id, tournament_id, tournament, tour, tier, surface, indoor, draw, round, round_code, is_qualifying, best_of,
    scheduled_at, status, event_status, p1_id, p1_name, p2_id, p2_name, sets, games, winner, outcome, retired, extra, source, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, NULL, 'singles', ?, ?, ?, NULL, ?, 'upcoming', NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, 'fixture', ?)
  ON CONFLICT(id) DO UPDATE SET tournament_id = COALESCE(tournament_id, excluded.tournament_id), tournament = COALESCE(tournament, excluded.tournament),
    tour = COALESCE(tour, excluded.tour), tier = COALESCE(NULLIF(tier, 'unknown'), excluded.tier, tier), surface = COALESCE(surface, excluded.surface),
    round = COALESCE(round, excluded.round), round_code = COALESCE(round_code, excluded.round_code), is_qualifying = COALESCE(is_qualifying, excluded.is_qualifying),
    scheduled_at = CASE WHEN status = 'upcoming' THEN COALESCE(excluded.scheduled_at, scheduled_at) ELSE scheduled_at END,
    p1_id = COALESCE(p1_id, excluded.p1_id), p1_name = COALESCE(p1_name, excluded.p1_name), p2_id = COALESCE(p2_id, excluded.p2_id), p2_name = COALESCE(p2_name, excluded.p2_name),
    updated_at = CASE WHEN status = 'upcoming' THEN excluded.updated_at ELSE updated_at END`);
let fixturesWithoutMatch = 0;
function storeFixture(f: any): boolean {
  if (!f) return false;
  const mid = num(f.match_id ?? f.match?.id);
  if (mid === null || mid <= 0) { fixturesWithoutMatch++; return false; }
  if (isDoubles(f) || /doubles/i.test(String(f.draw || ''))) return false;
  const at = str(f.start_time) || str(f.scheduled_time) || (f.event_date ? `${f.event_date}T00:00:00Z` : null);
  const tt = tourOfFixture(f);
  const id1 = num(f.player1_id ?? f.players?.p1?.id), id2 = num(f.player2_id ?? f.players?.p2?.id);
  const n1 = str(f.player1_name ?? f.players?.p1?.name), n2 = str(f.player2_name ?? f.players?.p2?.name);
  const quali = QUALI_RE.test(String(f.tournament || '')) || /^Q\d?$/i.test(String(f.round_code || '')) ? 1 : null;
  const rc = normRound(f.round_code, f.round, !!quali) ?? roundFromName(f.tournament, !!quali) ?? str(f.round_code) ?? (quali ? 'Q' : null);
  upFixture.run(mid, str(f.tournament_id), str(f.tournament), tt.tour, tt.tier, str(f.surface)?.toLowerCase() ?? null, str(f.round), rc, quali,
    at, id1, knownName(id1, n1), id2, knownName(id2, n2), nowIso());
  const ptour = tt.women === true || tt.tour === 'wta' ? 'wta' : tt.women === false || tt.tour === 'atp' || tt.tour === 'challenger' ? 'atp' : null;
  for (const [id, name] of [[id1, n1], [id2, n2]] as [number | null, string | null][]) if (id !== null) seePlayer.run(id, name, null, ptour, null, null, nowIso());
  settleEvent(mid); // fix197 (fix197b: after the players are stored)
  touched?.add(mid);
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
  catch (e: any) { j.lastError = e?.message || String(e); if (!(e instanceof TennisError && (e.status === 429 || e.status === 410 || e.plan || /^daily budget/.test(e.message)))) logger.warn(`tennis ${name}: ${j.lastError}`); }
  finally { j.running = false; }
}
/** fix190: the model's tuning waits while the live sync runs */
export const tennisLiveBusy = () => !!jobs.get('live')?.running;
/**
 * fix190: one match's price history (Pro: /history/matches/{id}/prices, first page, ascending) — the admin market
 * benchmark of tennis-v1 only; never a model input, never on a public route.
 */
export async function fetchHistoryPrices(id: number): Promise<any[] | null> {
  const j = await tn(`/history/matches/${id}/prices`, { limit: 200 }, { kind: 'bulk' });
  return j ? (Array.isArray(j.data) ? j.data : []) : null;
}
/** fix187: a job that did not run this time says why (status route). */
function note(name: string, info: string) {
  const j = jobs.get(name) || { lastRun: null, lastOk: null, lastError: null, info: null, running: false };
  j.info = `${info} (${nowIso()})`;
  jobs.set(name, j);
}
const tx = <T>(fn: () => T): T => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

/** fix197b: the ids the running upcoming / fixtures sync stored (settled again after the tier fills and the merge) */
let touched: Set<number> | null = null;
async function syncFixtures() {
  touched = new Set();
  try { return await syncFixturesInner(touched); } finally { touched = null; }
}
async function syncFixturesInner(seen: Set<number>) {
  // fix187: /matches?status=upcoming carries tier, format, tournament_id and the players; /fixtures (no tier) only when
  // that listing fails
  let n = 0, via = 'matches?status=upcoming';
  try {
    await pages('/matches', { status: 'upcoming', draw: 'singles' }, 25, 'core', rows => { tx(() => { for (const m of rows) if (storeMatch(m, 'fixture')) n++; }); });
  } catch (e: any) {
    if (n) throw e;
    via = `fixtures (matches?status=upcoming failed: ${e.message})`;
    fixturesWithoutMatch = 0;
    await pages('/fixtures', { draw: 'singles' }, 25, 'core', rows => { tx(() => { for (const f of rows) if (storeFixture(f)) n++; }); });
    if (fixturesWithoutMatch) via += `, ${fixturesWithoutMatch} fixtures without a match_id skipped`;
  }
  const filled = await fillTiers();
  // fix195: the same match never twice (same two players within a day → one row)
  const merged = await mergeDuplicates(new Date(Date.now() - 3 * 86400000).toISOString(), new Date(Date.now() + 10 * 86400000).toISOString());
  // fix197b: the gender clean-up once more over the rows this sync touched (the tier fills and the merge write after storeMatch)
  const settled = await settleRows(seen);
  return `${n} upcoming via ${via}${filled ? `, ${filled} tiers filled (catalogue + history)` : ''}${merged.merged ? `, ${merged.merged} duplicates merged` : ''}${settled ? `, ${settled} moved to their players' gender` : ''}`;
}

/**
 * fix187: matches without a tier (fixture rows, older rows) take tier / surface / indoor from tennis_tournaments — by
 * tournament_id, else by the same name on the same tour (exact, case-insensitive).
 * fix194: only rows from 14 days back on (the time index; the two UPDATEs scanned the whole table every 15 minutes,
 * ~2 s on 20 Oct). Older rows got their tier when they were stored, or from the finished-match sync.
 */
/** fix197b: fixGender over the given row ids (in slices), moves logged per event; returns how many moved */
async function settleRows(ids: Iterable<number>): Promise<number> {
  const slice = slicer();
  const byEvent: Record<string, number> = {};
  let moved = 0;
  for (const id of ids) {
    const mv = settleEvent(id);
    if (mv) { moved++; byEvent[mv] = (byEvent[mv] || 0) + 1; }
    await slice();
  }
  if (moved) logger.info(`tennis fix197b: ${moved} match(es) moved after the sync: ${movesText(byEvent)}`);
  return moved;
}

async function fillTiers(): Promise<number> {
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  // fix197: first every row to an event of its players' gender, every match a round code (logged per event)
  const rep = await repairTennisRows(new Date(Date.now() - 3 * 86400000).toISOString(), new Date(Date.now() + 14 * 86400000).toISOString());
  if (rep.moved) logger.info(`tennis fix197: ${rep.moved} match(es) moved to their players' gender: ${movesText(rep.byEvent)}`);
  // fix197: the row's own tournament_id first, and only a tournament of the same gender (a WTA id on a men's row gives no tier)
  const a = db.prepare(`UPDATE tennis_matches INDEXED BY idx_tennis_matches_time SET
      tier = COALESCE(NULLIF(tier, 'unknown'), (SELECT t.tier FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id)),
      surface = COALESCE(surface, (SELECT t.surface FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id)),
      indoor = COALESCE(indoor, (SELECT t.indoor FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id))
    WHERE scheduled_at >= ? AND (tier IS NULL OR tier = 'unknown') AND tournament_id IS NOT NULL AND EXISTS (SELECT 1 FROM tennis_tournaments t WHERE t.id = tennis_matches.tournament_id AND t.tier IS NOT NULL
      AND (${genSql('t')} IS NULL OR ${genSql('tennis_matches')} IS NULL OR ${genSql('t')} = ${genSql('tennis_matches')}))`).run(since);
  await yieldLoop();
  const b = db.prepare(`UPDATE tennis_matches INDEXED BY idx_tennis_matches_time SET
      tournament_id = COALESCE(tournament_id, (SELECT t.id FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1)),
      tier = (SELECT t.tier FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1),
      surface = COALESCE(surface, (SELECT t.surface FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1)),
      indoor = COALESCE(indoor, (SELECT t.indoor FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour LIMIT 1))
    WHERE scheduled_at >= ? AND (tier IS NULL OR tier = 'unknown') AND tournament IS NOT NULL AND EXISTS (SELECT 1 FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour AND t.tier IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM tennis_tournaments t WHERE lower(t.name) = lower(tennis_matches.tournament) AND t.tour = tennis_matches.tour AND t.tier IS NOT NULL
        AND ${genSql('t')} IS NOT NULL AND ${genSql('tennis_matches')} IS NOT NULL AND ${genSql('t')} <> ${genSql('tennis_matches')})`).run(since);
  await yieldLoop();
  return Number(a.changes) + Number(b.changes) + await fillTiersFromHistory();
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
 * fix194: the tournament → tier map is built in pages of the primary key with yields (the GROUP BY over every match
 * blocked the server ~2 s every 15 minutes) and kept for 6 hours; then only the rows stored since are added.
 */
type TierHit = { tier: string; surface: string | null; indoor: number | null; quali: number; at: string };
const tierMap = { known: new Map<string, TierHit>(), builtAt: 0, since: '' };
const tierKeep = (tour: string | null, name: string | null, h: TierHit) => {
  if (!tour || !name) return;
  const k = `${tour}|${tournamentKey(name)}`;
  const o = tierMap.known.get(k);
  // main draw before qualifying, then the most recent
  if (!o || h.quali < o.quali || (h.quali === o.quali && h.at > o.at)) tierMap.known.set(k, h);
};
async function tierKnown(): Promise<Map<string, TierHit>> {
  const slice = slicer(25);
  const started = nowIso();
  if (Date.now() - tierMap.builtAt > 6 * 3600 * 1000) {
    tierMap.known = new Map();
    const page = db.prepare(`SELECT id, tour, tournament, tier, surface, indoor, is_qualifying, scheduled_at FROM tennis_matches WHERE id > ? ORDER BY id LIMIT 2000`);
    let after = -Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = page.all(after) as any[];
      if (!rows.length) break;
      for (const r of rows) if (r.tier && r.tier !== 'unknown') tierKeep(r.tour, r.tournament, { tier: r.tier, surface: r.surface, indoor: r.indoor, quali: r.is_qualifying ? 1 : 0, at: r.scheduled_at || '' });
      after = rows[rows.length - 1].id;
      await yieldLoop();
    }
    tierMap.builtAt = Date.now();
  } else {
    // rows stored since the last look (updated_at is not indexed: the time index on the recent weeks is enough)
    const rows = db.prepare(`SELECT tour, tournament, tier, surface, indoor, is_qualifying, scheduled_at FROM tennis_matches INDEXED BY idx_tennis_matches_time
      WHERE scheduled_at >= ? AND updated_at >= ? AND tier IS NOT NULL AND tier <> 'unknown'`).all(new Date(Date.now() - 30 * 86400000).toISOString(), tierMap.since) as any[];
    for (const r of rows) { tierKeep(r.tour, r.tournament, { tier: r.tier, surface: r.surface, indoor: r.indoor, quali: r.is_qualifying ? 1 : 0, at: r.scheduled_at || '' }); await slice(); }
  }
  tierMap.since = started;
  return tierMap.known;
}
async function fillTiersFromHistory(): Promise<number> {
  const todo = db.prepare(`SELECT id, tournament, tour FROM tennis_matches
    WHERE status = 'upcoming' AND (tier IS NULL OR tier = 'unknown') AND tournament IS NOT NULL`).all() as any[];
  if (!todo.length) return 0;
  const fromMatches = await tierKnown();
  // the catalogue comes after match rows (a tournament with match rows keeps its own tier)
  const known = new Map<string, { tier: string; surface: string | null; indoor: number | null }>(fromMatches);
  for (const r of db.prepare(`SELECT tour, name, tier, surface, indoor FROM tennis_tournaments WHERE tier IS NOT NULL ORDER BY start_date DESC`).all() as any[]) {
    if (!r.tour || !r.name) continue;
    const k = `${r.tour}|${tournamentKey(r.name)}`;
    if (!known.has(k)) known.set(k, { tier: r.tier, surface: r.surface, indoor: r.indoor });
  }
  const set = db.prepare(`UPDATE tennis_matches SET tier = ?, surface = COALESCE(surface, ?), indoor = COALESCE(indoor, ?),
    is_qualifying = CASE WHEN ? = 1 THEN 1 ELSE is_qualifying END WHERE id = ?`);
  const none = db.prepare(`UPDATE tennis_matches SET tier = 'unknown', is_qualifying = CASE WHEN ? = 1 THEN 1 ELSE is_qualifying END WHERE id = ?`);
  let n = 0;
  for (let i = 0; i < todo.length; i += 300) {
    tx(() => {
      for (const r of todo.slice(i, i + 300)) {
        const quali = QUALI_RE.test(r.tournament) ? 1 : 0;
        let hit = known.get(`${r.tour}|${tournamentKey(r.tournament)}`);
        // fix197b: never a tier of the other gender (a WTA 125 tier on a "challenger" row made it a WTA match)
        const rg = eventGenderStrict(r.tour, null, r.tournament), hg = hit ? eventGenderStrict(null, hit.tier, null) : null;
        if (hit && rg && hg && rg !== hg) hit = undefined;
        if (hit) { set.run(hit.tier, hit.surface, hit.indoor, quali, r.id); n++; } else none.run(quali, r.id);
      }
    });
    await yieldLoop();
  }
  return n;
}

let liveCount = 0, lastLiveRun = 0;
/** fix193: called after every live poll with the ids seen live (the public site samples the live win chance) */
let liveHook: ((ids: number[]) => void | Promise<void>) | null = null;
export const setTennisLiveHook = (f: (ids: number[]) => void | Promise<void>) => { liveHook = f; };
async function syncLive() {
  let n = 0;
  const ids: number[] = [];
  await pages('/matches', { status: 'live', draw: 'singles' }, 10, 'core', rows => { tx(() => { for (const m of rows) if (storeMatch(m, 'live')) { n++; ids.push(Number(m.id)); } }); });
  liveCount = n;
  lastLiveRun = Date.now();
  if (liveHook && ids.length) { try { await liveHook(ids); } catch (e: any) { logger.warn(`tennis live hook: ${e.message}`); } }
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
  // fix190: the new results into the live tennis-v1 ratings (loaded lazily: the model imports this file)
  // fix194: in slices (it read and replayed up to 8,000 rows in one go)
  let hook: (() => Promise<void>) | null = null;
  try { hook = require('./tennisModel').tennisResultsHook; } catch { /* model not loaded */ }
  if (hook) await hook();
  return `${n} finished, ${tapes} tapes`;
}
async function fetchTapes(max: number): Promise<number> {
  // fix194: the last 45 days only (older months come with the monthly tape packages) on the time index, and the
  // "no tape" marks by key (the query scanned every match since 2023 and every meta row: part of the 2 s stalls)
  const todo = db.prepare(`
    SELECT m.id FROM tennis_matches m INDEXED BY idx_tennis_matches_time WHERE m.scheduled_at >= ? AND m.id > 0 AND m.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM tennis_match_stats s WHERE s.match_id = m.id) AND COALESCE(m.outcome, '') NOT IN ('walkover')
      AND NOT EXISTS (SELECT 1 FROM tennis_meta x WHERE x.k = 'notape' || m.id)
    ORDER BY CASE WHEN m.tour IN ('atp', 'wta') THEN 0 WHEN m.tour = 'challenger' THEN 1 ELSE 2 END, m.scheduled_at DESC LIMIT ?`)
    .all(new Date(Date.now() - 45 * 86400000).toISOString(), max) as any[];
  const hasStats = db.prepare(`SELECT 1 FROM tennis_match_stats WHERE match_id = ?`);
  const slice = slicer();
  let n = 0;
  for (const r of todo) {
    if (!canSpend('bulk')) break;
    let obj: any;
    try { obj = await tn(`/history/matches/${r.id}`, {}, { kind: 'bulk' }); } catch (e: any) { if (e instanceof TennisError && e.status === 410) obj = null; else throw e; }
    if (obj && storeTape(obj) && hasStats.get(r.id)) n++;
    else meta.set(`notape${r.id}`, nowIso()); // no usable tape: not asked again
    await slice();
  }
  return n;
}

/** Players on first sight (no bio yet) and weekly; at most `max` per run. */
const upPlayer = db.prepare(`UPDATE tennis_players SET name = COALESCE(?, name), country = COALESCE(?, country), tour = COALESCE(?, tour), hand = ?, dob = ?, height = ?,
  ranking = ?, ranking_points = ?, stats = ?, updated_at = ? WHERE id = ?`);
// fix195: the profile's first / last name when the API has them (the display name is "first last")
const setNames = db.prepare(`UPDATE tennis_players SET first_name = ?, last_name = ? WHERE id = ?`);
const setGone = db.prepare(`UPDATE tennis_players SET gone = 1, updated_at = ? WHERE id = ?`);
const setMovement = db.prepare(`UPDATE tennis_players SET ranking_movement = ? WHERE id = ?`);
const dropPlayer = db.prepare(`DELETE FROM tennis_players WHERE id = ?`);
async function syncPlayers(max = 120) {
  const week = new Date(Date.now() - 7 * 86400000).toISOString();
  // fix194: new players first (best ranked first), then the oldest refresh — both read the updated_at index; gone players never
  const fresh = db.prepare(`SELECT id FROM tennis_players WHERE updated_at IS NULL AND gone IS NULL ORDER BY COALESCE(ranking, 9999) LIMIT ?`).all(max) as any[];
  const old = fresh.length < max
    ? db.prepare(`SELECT id FROM tennis_players WHERE updated_at < ? AND gone IS NULL ORDER BY updated_at LIMIT ?`).all(week, max - fresh.length) as any[] : [];
  const todo = [...fresh, ...old];
  const slice = slicer();
  let n = 0, gone = 0;
  for (const r of todo) {
    if (!canSpend('bulk')) break;
    let p: any;
    try { p = await tn(`/players/${r.id}`, {}, { kind: 'bulk' }); } catch (e: any) {
      // fix194: 410 = the provider removed the player: marked gone, not asked again (was a warning every 20 min)
      if (e instanceof TennisError && e.status === 410) { setGone.run(nowIso(), r.id); gone++; continue; }
      throw e;
    }
    if (!p) { upPlayer.run(null, null, null, null, null, null, null, null, null, nowIso(), r.id); continue; }
    if (p.is_doubles_team) { dropPlayer.run(r.id); continue; }
    const first = str(p.first_name ?? p.firstname ?? p.given_name), last = str(p.last_name ?? p.lastname ?? p.surname ?? p.family_name);
    const pname = first && last ? `${first} ${last}` : isAbbreviated(p.name) ? null : str(p.name);
    upPlayer.run(pname, str(p.country), str(p.tour), str(p.hand), str(p.birthday), num(p.height_cm ?? p.height), num(p.ranking), num(p.ranking_points),
      p.stats ? JSON.stringify(p.stats) : null, nowIso(), r.id);
    if (first && last) setNames.run(first, last, r.id);
    if (num(p.ranking_movement) !== null) setMovement.run(num(p.ranking_movement), r.id);
    n++;
    await slice();
  }
  return `${n} players${gone ? `, ${gone} gone (410)` : ''}`;
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
  const filled = await fillTiers();
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
    let j: any;
    try { j = await tn(`/players/${id}/stoppages`, { since, limit: 200 }, { kind: 'bulk' }); } catch (e: any) {
      if (e instanceof TennisError && e.status === 410) { setGone.run(nowIso(), id); continue; } // fix194
      throw e;
    }
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
  // fix194: a tape line can be ~100 KB of JSON: lines are parsed and stored in ~25 ms slices (one transaction per slice,
  // never open across an await), not 200 at once (the "backfill packages" stalls of 0.5–2 s on 20 Oct)
  let n = 0, batch: string[] = [];
  const drain = async () => {
    let i = 0;
    while (i < batch.length) {
      const t = Date.now();
      tx(() => {
        while (i < batch.length && Date.now() - t < 25) {
          const line = batch[i++];
          let o: any;
          try { o = JSON.parse(line); } catch { continue; } // a broken line is skipped
          n++;
          onLine(o);
        }
      });
      await yieldLoop();
    }
    batch = [];
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    batch.push(line);
    if (batch.length >= 50) await drain();
  }
  await drain();
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
/* fix195: one row per match, no stale matches                          */
/* ------------------------------------------------------------------ */

/** match ids below this are the /fixtures id space (match ids were ~205,000 on 20 Oct 2026) */
export const FIXTURE_ID_MAX = 100_000;
const ridOf = (id: number) => -(4e9 + id); // tennisSite's reveal / unlock id
const STATUS_RANK: Record<string, number> = { completed: 4, finished: 4, live: 3, in_progress: 3, interrupted: 3, suspended: 3, upcoming: 1 };
const SOURCE_RANK: Record<string, number> = { history: 3, live: 2, fixture: 1 };
/** which of two rows of one match stays: the match id space, then the further status, the richer source, a prediction */
function keeperScore(r: any, hasPred: boolean): number {
  return (r.id >= FIXTURE_ID_MAX ? 1000 : 0) + (STATUS_RANK[String(r.status || '').toLowerCase()] || 0) * 50 + (SOURCE_RANK[r.source] || 0) * 10 + (hasPred ? 5 : 0) + r.id / 1e9;
}
// prepared on first use: tennis_predictions is made by tennisModel.ts, which loads after this file
const hasPredQ = { get: (id: number) => db.prepare(`SELECT 1 FROM tennis_predictions WHERE match_id = ?`).get(id) };
const hasStatsQ = db.prepare(`SELECT 1 FROM tennis_match_stats WHERE match_id = ? LIMIT 1`);
/**
 * Moves everything that points at `old` to `keep` (prediction, unlocks, live samples, price, stoppages) and removes the old
 * row; /tennis/match/<old> then redirects. The prediction moves only when the keeper has none and the two rows list the
 * players in the same order (else it is dropped; the keeper is predicted on its own). An old id that is also an old
 * match of ours (it has a tape: a fixture id landed on it) is not deleted but refreshed from the provider.
 */
function moveMatch(old: any, keep: any): 'deleted' | 'refetch' {
  const swapped = old.p1_id !== keep.p1_id;
  const at = nowIso();
  tx(() => {
    if (!swapped && !hasPredQ.get(keep.id)) db.prepare(`UPDATE tennis_predictions SET match_id = ? WHERE match_id = ?`).run(keep.id, old.id);
    db.prepare(`DELETE FROM tennis_predictions WHERE match_id = ?`).run(old.id);
    db.prepare(`UPDATE OR IGNORE match_unlocks SET match_id = ? WHERE match_id = ?`).run(ridOf(keep.id), ridOf(old.id));
    db.prepare(`DELETE FROM match_unlocks WHERE match_id = ?`).run(ridOf(old.id));
    try {
      if (!swapped) db.prepare(`UPDATE OR IGNORE tennis_live_samples SET match_id = ? WHERE match_id = ?`).run(keep.id, old.id);
      db.prepare(`DELETE FROM tennis_live_samples WHERE match_id = ?`).run(old.id);
    } catch { /* table made by tennisSite: not there yet */ }
    if (!swapped) db.prepare(`UPDATE OR IGNORE tennis_prices SET match_id = ? WHERE match_id = ?`).run(keep.id, old.id);
    db.prepare(`DELETE FROM tennis_prices WHERE match_id = ?`).run(old.id);
    db.prepare(`UPDATE OR IGNORE tennis_stoppages SET match_id = ? WHERE match_id = ?`).run(keep.id, old.id);
    db.prepare(`INSERT OR REPLACE INTO tennis_id_moves (old_id, new_id, at) VALUES (?, ?, ?)`).run(old.id, keep.id, at);
    db.prepare(`UPDATE tennis_id_moves SET new_id = ? WHERE new_id = ?`).run(keep.id, old.id);
  });
  if (old.id > 0 && hasStatsQ.get(old.id)) {
    db.prepare(`UPDATE tennis_matches SET status = 'unknown', updated_at = ? WHERE id = ?`).run(at, old.id);
    meta.set(`refetch${old.id}`, at);
    db.prepare(`DELETE FROM tennis_id_moves WHERE old_id = ?`).run(old.id);
    return 'refetch';
  }
  db.prepare(`DELETE FROM tennis_matches WHERE id = ?`).run(old.id);
  return 'deleted';
}

/** Same two players within a day = the same match: one row stays (keeperScore), the others are moved into it. */
export async function mergeDuplicates(from: string, to: string): Promise<{ groups: number; merged: number; refetch: number }> {
  const rows = db.prepare(`SELECT id, p1_id, p2_id, scheduled_at, status, source FROM tennis_matches INDEXED BY idx_tennis_matches_time
    WHERE scheduled_at >= ? AND scheduled_at < ? AND p1_id IS NOT NULL AND p2_id IS NOT NULL AND id > 0 AND source <> 'archive' AND COALESCE(draw, 'singles') = 'singles'`).all(from, to) as any[];
  const byPair = new Map<string, any[]>();
  for (const r of rows) {
    const k = `${Math.min(r.p1_id, r.p2_id)}-${Math.max(r.p1_id, r.p2_id)}`;
    const l = byPair.get(k); if (l) l.push(r); else byPair.set(k, [r]);
  }
  let groups = 0, merged = 0, refetch = 0;
  const slice = slicer();
  for (const list of byPair.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
    // clusters of rows within 24 h of the cluster's first row
    for (let i = 0; i < list.length;) {
      let j = i + 1;
      while (j < list.length && Date.parse(list[j].scheduled_at) - Date.parse(list[i].scheduled_at) <= 86400000) j++;
      const cl = list.slice(i, j);
      i = j;
      if (cl.length < 2) continue;
      groups++;
      const scored = cl.map(r => ({ r, s: keeperScore(r, !!hasPredQ.get(r.id)) })).sort((a, b) => b.s - a.s);
      const keep = scored[0].r;
      for (const { r } of scored.slice(1)) { if (moveMatch(r, keep) === 'refetch') refetch++; merged++; }
      await slice();
    }
  }
  return { groups, merged, refetch };
}

/**
 * One-time clean-up (20 Oct 2026): rows of the /fixtures id space merged into their match rows, the leftovers removed
 * (the next fixture sync stores them again under their match id); players whose name is only initials are asked
 * for again first.
 */
async function fix195Cleanup(): Promise<string> {
  if (meta.get('fix195_cleanup')) return 'done before';
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const m = await mergeDuplicates(since, new Date(Date.now() + 30 * 86400000).toISOString());
  // the leftovers: fixture-id rows of recent months with no match row next to them
  const left = db.prepare(`SELECT id, p1_id, status FROM tennis_matches WHERE id > 0 AND id < ? AND (source = 'fixture' OR scheduled_at >= ?)`).all(FIXTURE_ID_MAX, since) as any[];
  let removed = 0, refetch = 0;
  for (const r of left) {
    if (hasStatsQ.get(r.id)) {
      // an old match of ours a fixture landed on: refreshed from the provider (its stats prove it was a real match)
      if (!['completed', 'finished'].includes(String(r.status))) { db.prepare(`UPDATE tennis_matches SET status = 'unknown' WHERE id = ?`).run(r.id); meta.set(`refetch${r.id}`, nowIso()); refetch++; }
      continue;
    }
    tx(() => {
      db.prepare(`DELETE FROM tennis_predictions WHERE match_id = ?`).run(r.id);
      db.prepare(`DELETE FROM tennis_matches WHERE id = ?`).run(r.id);
    });
    removed++;
    if (removed % 200 === 0) await yieldLoop();
  }
  const reask = db.prepare(`UPDATE tennis_players SET updated_at = NULL WHERE gone IS NULL AND (name GLOB '[A-Z]. *' OR name GLOB '[A-Z].[A-Z]. *' OR name GLOB '[A-Z]. [A-Z]. *')`).run();
  const info = `${m.merged} merged in ${m.groups} groups, ${removed} fixture rows removed, ${m.refetch + refetch} old matches to refresh, ${reask.changes} short names asked again`;
  meta.set('fix195_cleanup', JSON.stringify({ at: nowIso(), info }));
  return info;
}

/* ------------------------------------------------------------------ */
/* fix197: events of the right gender, a round code on every match      */
/* ------------------------------------------------------------------ */

/** a row's event for the round inference: gender + the name without qualifying / year + qualifying or main draw */
const eventKeyOf = (r: any, quali: boolean) => `${eventGender(r.tour, r.tier, r.tournament) || '?'}|${tournamentKey(String(r.tournament || ''))}|${quali ? 'Q' : 'M'}`;
const isQuali = (r: any) => !!r.is_qualifying || QUALI_RE.test(String(r.tournament || '')) || /^Q\d?$/i.test(String(r.round_code || ''));
/** the round code a row already has (its code / round text / the end of its tournament name), null = none */
export const rowRound = (r: any): string | null => normRound(r.round_code, r.round, isQuali(r)) ?? roundFromName(r.tournament, isQuali(r));
const rankOf = (c: string | null) => (c && c in ROUND_ORDER ? ROUND_ORDER[c] : -1);

/**
 * Rows of [from, to) whose event is of the other gender than their players → moved to the players' event (counted per
 * "from → to"); then rows without a round code get one: a player's previous match in the same event → the next round,
 * else the event's first known round (main draw: R1 when nothing is known; qualifying: Q1). Never on archive rows
 * (their own player ids).
 */
export async function repairTennisRows(from: string, to: string): Promise<{ moved: number; byEvent: Record<string, number>; rounds: number }> {
  const slice = slicer();
  const byEvent: Record<string, number> = {};
  let moved = 0;
  genCache.clear();
  // read a day at a time (the time index), the 10 days before `from` for the earlier rounds
  const dayQ = db.prepare(`SELECT id, tournament_id, tournament, tour, tier, p1_id, p2_id, scheduled_at, source, round, round_code, is_qualifying, status
    FROM tennis_matches INDEXED BY idx_tennis_matches_time WHERE scheduled_at >= ? AND scheduled_at < ? AND id > 0 AND source <> 'archive' ORDER BY scheduled_at, id`);
  const rows: any[] = [];
  const end = Date.parse(to);
  for (let t = Date.parse(from) - 10 * DAY_MS; t < end; t += DAY_MS) {
    for (const r of dayQ.all(new Date(t).toISOString(), new Date(Math.min(t + DAY_MS, end)).toISOString()) as any[]) rows.push(r);
    await yieldLoop();
  }
  for (const r of rows) {
    if (r.scheduled_at < from) continue;
    const mv = fixGender(r);
    if (mv) { moved++; byEvent[mv] = (byEvent[mv] || 0) + 1; Object.assign(r, rowQ.get(r.id)); }
    await slice();
  }
  // rounds, event by event in time order (the 14 days before `from` give the earlier rounds)
  const events = new Map<string, any[]>();
  for (const r of rows) { const k = eventKeyOf(r, isQuali(r)); const l = events.get(k); if (l) l.push(r); else events.set(k, [r]); }
  const setRound = db.prepare(`UPDATE tennis_matches SET round_code = ? WHERE id = ? AND (round_code IS NULL OR round_code = ?)`);
  let rounds = 0;
  for (const [k, list] of events) {
    const q = k.endsWith('|Q');
    const known = list.map(rowRound).filter((c): c is string => !!c && c !== 'Q' && c !== 'RR');
    const first = known.length ? known.reduce((a, b) => (rankOf(b) < rankOf(a) ? b : a)) : q ? 'Q1' : 'R1';
    const last = new Map<number, string>(); // player → the round of their latest match in this event
    const todo: [string, number, string | null][] = [];
    for (const r of list) {
      let c = rowRound(r);
      if (!c || (q && c === 'Q')) {
        const prev = [last.get(r.p1_id), last.get(r.p2_id)].map(x => nextRound(x || null)).filter((x): x is string => !!x);
        c = prev.length ? prev.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a)) : first;
        if (r.scheduled_at >= from && c !== r.round_code) todo.push([c, r.id, r.round_code]);
      }
      for (const p of [r.p1_id, r.p2_id]) if (p) last.set(p, c);
    }
    if (todo.length) tx(() => { for (const [c, id, old] of todo) rounds += Number(setRound.run(c, id, old).changes); });
    await slice();
  }
  return { moved, byEvent, rounds };
}
const movesText = (byEvent: Record<string, number>) => Object.entries(byEvent).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} × ${k}`).join('; ');

/**
 * One-time (21 Oct 2026): every row of our feed (not the archive) checked for the gender of its event, in pages of the
 * primary key; round codes filled for the last 120 days (older rows keep what they had: the model was tested on them).
 * fix197b: run once more under its own key (the first pass read a "challenger" row with the WTA 125 tier as men's).
 */
async function fix197Cleanup(key = 'fix197b_cleanup'): Promise<string> {
  if (meta.get(key)) return 'done before';
  genCache.clear();
  const page = db.prepare(`SELECT id, tournament_id, tournament, tour, tier, p1_id, p2_id, scheduled_at, source FROM tennis_matches WHERE id > ? AND source <> 'archive' ORDER BY id LIMIT 2000`);
  const byEvent: Record<string, number> = {};
  let moved = 0, after = 0;
  for (;;) {
    const rows = page.all(after) as any[];
    if (!rows.length) break;
    tx(() => { for (const r of rows) { const mv = fixGender(r); if (mv) { moved++; byEvent[mv] = (byEvent[mv] || 0) + 1; } } });
    after = rows[rows.length - 1].id;
    await yieldLoop();
  }
  const recent = await repairTennisRows(new Date(Date.now() - 120 * DAY_MS).toISOString(), new Date(Date.now() + 30 * DAY_MS).toISOString());
  for (const [k, n] of Object.entries({ ...byEvent, ...recent.byEvent })) logger.info(`tennis fix197: ${n} match(es) moved: ${k}`);
  const info = `${moved + recent.moved} matches moved to their players' gender (${Object.keys(byEvent).length} events), ${recent.rounds} round codes filled (120 days)`;
  meta.set(key, JSON.stringify({ at: nowIso(), info, moves: byEvent }));
  return info;
}

/**
 * A match still "upcoming" / "live" 6 h after its start with no update is asked for again (/matches/{id}, then the
 * history tape); if the provider has nothing (or still the old start), it becomes 'unknown' and leaves the lists. The
 * rows the fix195 clean-up flagged (refetch<id>) are refreshed the same way.
 */
async function refreshStale(max = 60): Promise<string> {
  const now = Date.now();
  const stale = db.prepare(`SELECT id, status, scheduled_at, updated_at FROM tennis_matches INDEXED BY idx_tennis_matches_time
    WHERE scheduled_at >= ? AND scheduled_at < ? AND status IN ('upcoming', 'live', 'in_progress', 'interrupted', 'suspended') AND id > 0 AND source <> 'archive'
    ORDER BY scheduled_at DESC LIMIT ?`).all(new Date(now - 10 * 86400000).toISOString(), new Date(now - 6 * 3600000).toISOString(), max * 2) as any[];
  // a live match polled in the last 20 minutes is still on (rain, a long fifth set)
  const todo = stale.filter(r => !(r.status !== 'upcoming' && Date.parse(r.updated_at || '') > now - 20 * 60000)).slice(0, max);
  const flagged = (db.prepare(`SELECT k FROM tennis_meta WHERE k LIKE 'refetch%' LIMIT ?`).all(max) as any[]).map(r => ({ id: Number(r.k.slice(7)), flag: r.k }));
  const ids = [...new Map([...todo.map(r => [r.id, null as string | null] as const), ...flagged.map(f => [f.id, f.flag] as const)]).entries()];
  const reread = db.prepare(`SELECT status, scheduled_at FROM tennis_matches WHERE id = ?`);
  const slice = slicer();
  let fixed = 0, unknown = 0;
  for (const [id, flag] of ids) {
    if (!Number.isFinite(id) || !canSpend('bulk')) break;
    let got = false;
    try {
      const j = await tn(`/matches/${id}`, {}, { kind: 'bulk' });
      const m = j?.data && !Array.isArray(j.data) ? j.data : j?.match || j;
      if (m && num(m.id) === id) got = storeMatch(m, /completed|finished/.test(String(m.status)) ? 'history' : 'live');
    } catch (e: any) { if (!(e instanceof TennisError && (e.status === 410 || e.status === 400))) throw e; }
    if (!got || flag) {
      try { const h = await tn(`/history/matches/${id}`, {}, { kind: 'bulk' }); if (h?.match && num(h.match.id) === id) got = storeTape(h) || got; }
      catch (e: any) { if (!(e instanceof TennisError && (e.status === 410 || e.status === 400))) throw e; }
    }
    const r = reread.get(id) as any;
    const stillStale = r && ['upcoming', 'live', 'in_progress', 'interrupted', 'suspended', 'unknown'].includes(String(r.status)) && Date.parse(r.scheduled_at) < now - 6 * 3600000;
    if (r && stillStale) { db.prepare(`UPDATE tennis_matches SET status = 'unknown', updated_at = ? WHERE id = ?`).run(nowIso(), id); unknown++; }
    else if (r && got) fixed++;
    if (flag) db.prepare(`DELETE FROM tennis_meta WHERE k = ?`).run(flag);
    await slice();
  }
  return `${ids.length} checked, ${fixed} refreshed, ${unknown} unknown`;
}

/**
 * fix195: the admin data check (Admin → Data health, /api/admin/tennis/check), target zero everywhere: the same match
 * twice, rows of the fixture id space, ATP / WTA / Challenger matches of the next 48 h without a prediction (with the
 * reason), matches still upcoming / live 6 h after the start, names that are only initials or look surname-first.
 */
export async function tennisDataCheck() {
  const now = Date.now();
  const slice = slicer(); // fix196: in slices (part of the data health job)
  const iso = (ms: number) => new Date(ms).toISOString();
  const name = (r: any) => `${r.p1_name || '?'} v ${r.p2_name || '?'} · ${r.tournament || '?'} · ${String(r.scheduled_at || '').slice(0, 16).replace('T', ' ')} UTC · id ${r.id}`;
  const win = db.prepare(`SELECT id, tournament_id, tournament, tour, tier, p1_id, p1_name, p2_id, p2_name, scheduled_at, status, source, round, round_code, is_qualifying FROM tennis_matches INDEXED BY idx_tennis_matches_time
    WHERE scheduled_at >= ? AND scheduled_at < ? AND id > 0 AND source <> 'archive' AND COALESCE(draw, 'singles') = 'singles'`).all(iso(now - 3 * 86400000), iso(now + 10 * 86400000)) as any[];
  const pairs = new Map<string, any[]>();
  await slice();
  for (const r of win) if (r.p1_id && r.p2_id) { const k = `${Math.min(r.p1_id, r.p2_id)}-${Math.max(r.p1_id, r.p2_id)}`; pairs.set(k, [...(pairs.get(k) || []), r]); }
  const duplicates: string[] = [];
  for (const l of pairs.values()) {
    l.sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
    for (let i = 1; i < l.length; i++) if (Date.parse(l[i].scheduled_at) - Date.parse(l[i - 1].scheduled_at) <= 86400000) duplicates.push(`${name(l[i])} = id ${l[i - 1].id}`);
  }
  const fixtureIds = win.filter(r => r.id < FIXTURE_ID_MAX).map(r => `${name(r)} (fixture id)`);
  let classify: ((tour: string | null, tier: string | null, nm: string | null, src: string) => { cat: number } | null) | null = null;
  try { classify = require('./tennisModel').tennisModelInternals.classify; } catch { /* model not loaded */ }
  const pred = db.prepare(`SELECT 1 FROM tennis_predictions WHERE match_id = ?`);
  const noPrediction: string[] = [];
  await slice();
  for (const r of win) {
    await slice();
    const t = Date.parse(r.scheduled_at);
    if (r.status !== 'upcoming' || t < now || t > now + 48 * 3600000) continue;
    const cls = classify ? classify(r.tour, r.tier, r.tournament, r.source) : { cat: 1 };
    if (!cls || cls.cat > 3 || pred.get(r.id)) continue;
    const why = !r.p1_id || !r.p2_id ? 'a player id is missing' : /^(tbd|tba|qualifier)$/i.test(String(r.p1_name)) || /^(tbd|tba|qualifier)$/i.test(String(r.p2_name)) ? 'a player is not known yet'
      : r.id < FIXTURE_ID_MAX ? 'fixture id (not merged yet)' : 'not predicted yet (the model saves the next 48 h every 30 min)';
    noPrediction.push(`${name(r)} · ${why}`);
  }
  const stale = win.filter(r => ['upcoming', 'live', 'in_progress', 'interrupted', 'suspended'].includes(String(r.status)) && Date.parse(r.scheduled_at) < now - 6 * 3600000)
    .map(r => `${name(r)} · still ${r.status} ${Math.round((now - Date.parse(r.scheduled_at)) / 3600000)} h after the start`);
  // fix197: a match under an event of the other gender than its players; a match with no round code
  genCache.clear();
  const genderMismatch: string[] = [];
  for (const r of win) {
    // fix197b: every part of the event (tour, tier, ITF name), and the message says what is wrong
    const pg = wrongGender(r);
    if (pg) genderMismatch.push(`${name(r)} · ${mismatchText(r, pg)}`);
  }
  await slice();
  const missingRound = win.filter(r => r.status !== 'unknown' && !rowRound(r)).map(r => `${name(r)} · round ${JSON.stringify(r.round)} / code ${JSON.stringify(r.round_code)}`);
  // names: initials only, or the rankings list the same words in another order (surname first in one of them)
  const ids = [...new Set(win.filter(r => Date.parse(r.scheduled_at) >= now - 86400000).flatMap(r => [r.p1_id, r.p2_id]).filter(Boolean))];
  const names: string[] = [];
  const pq = db.prepare(`SELECT p.id, p.name, p.first_name, p.last_name, (SELECT r.player_name FROM tennis_rankings r WHERE r.player_id = p.id ORDER BY r.date DESC LIMIT 1) AS rname FROM tennis_players p WHERE p.id = ?`);
  const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    await slice();
    const p = pq.get(id) as any;
    if (!p?.name) continue;
    if (isAbbreviated(p.name)) { names.push(`${p.name} (id ${p.id}) · initials only`); continue; }
    if (p.first_name && p.last_name) continue;
    if (p.rname && p.rname !== p.name) {
      const a = words(p.name), b = words(p.rname);
      if (a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')) names.push(`${p.name} (id ${p.id}) · rankings say "${p.rname}": surname first?`);
    }
  }
  return {
    at: iso(now),
    total: duplicates.length + fixtureIds.length + noPrediction.length + stale.length + genderMismatch.length + missingRound.length,
    duplicates, fixtureIds, noPrediction, stale, genderMismatch, missingRound, names,
    cleanup: (() => { try { return JSON.parse(meta.get('fix195_cleanup') || 'null'); } catch { return null; } })(),
    cleanup197: (() => { try { return JSON.parse(meta.get('fix197b_cleanup') || meta.get('fix197_cleanup') || 'null'); } catch { return null; } })(),
    moved: (db.prepare(`SELECT COUNT(*) AS n FROM tennis_id_moves`).get() as any).n
  };
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
  // fix194: the jobs that write many rows run in the heavy-job queue (one at a time, never with the daily model job or
  // the player-page warm-up); usage, live and prices are small and stay on their own timers
  after('tennis start', async () => {
    await runUsage();
    await job('live', syncLive);
    // fix195: the one-time clean-up of the fixture id rows runs before the first fixture sync
    void heavy('tennis fix195 clean-up', () => job('fix195 clean-up', fix195Cleanup))
      .then(() => heavy('tennis fix197b clean-up', () => job('fix197b clean-up', fix197Cleanup)))
      .then(() => heavy('tennis fixtures', () => job('fixtures', syncFixtures))).then(() => heavy('tennis tournaments', () => job('tournaments', syncTournaments)));
  }, 60 * 1000).unref();
  // fix195: matches still upcoming / live 6 h after the start → asked again, else 'unknown'
  everyHeavy('tennis stale', () => job('stale', () => refreshStale()), 30 * 60 * 1000).unref();
  // fix195: the data check once a day in the log (the full list: /api/admin/tennis/check, Admin → Data health)
  every('tennis check', async () => {
    const c = await tennisDataCheck();
    if (c.total) logger.warn(`tennis data check: ${c.duplicates.length} duplicates, ${c.fixtureIds.length} fixture ids, ${c.noPrediction.length} without a prediction (48 h), ${c.stale.length} stale, ${c.genderMismatch.length} gender mismatch, ${c.missingRound.length} missing round`);
  }, 24 * 3600 * 1000).unref();
  every('tennis usage', runUsage, 30 * 60 * 1000).unref();
  everyHeavy('tennis fixtures', () => job('fixtures', syncFixtures), 15 * 60 * 1000).unref();
  // live: every minute while something is live, else every 10 minutes
  every('tennis live', () => (liveCount > 0 || Date.now() - lastLiveRun >= 10 * 60 * 1000 ? job('live', syncLive) : undefined), 60 * 1000).unref();
  everyHeavy('tennis history', () => job('history', syncHistory), 30 * 60 * 1000).unref();
  everyHeavy('tennis players', () => job('players', () => syncPlayers()), 20 * 60 * 1000).unref();
  everyHeavy('tennis rankings', () => job('rankings', syncRankings), 24 * 3600 * 1000).unref();
  afterHeavy('tennis rankings', () => job('rankings', syncRankings), 5 * 60 * 1000).unref();
  everyHeavy('tennis tournaments', () => job('tournaments', syncTournaments), 24 * 3600 * 1000).unref();
  everyHeavy('tennis stoppages', () => job('stoppages', () => syncStoppages()), 6 * 3600 * 1000).unref();
  every('tennis prices', () => job('prices', syncPrices), 10 * 60 * 1000).unref();
  // backfill: one month / one archive step every 5 min (fix187; ~25 s each), always under the reserve; skipped while a
  // live sync runs or when the event loop was blocked > 500 ms in the last minute
  const calm = (name: string, fn: () => Promise<string | void>) => () => {
    if (jobs.get('live')?.running) { note(name, 'skipped: live sync running'); return; }
    if (stalledWithin(60 * 1000, 500)) { note(name, 'skipped: event loop blocked > 500 ms in the last minute'); return; }
    return job(name, fn);
  };
  everyHeavy('tennis backfill packages', calm('backfill packages', backfillPackages), 5 * 60 * 1000).unref();
  everyHeavy('tennis backfill archive', calm('backfill archive', backfillArchive), 5 * 60 * 1000).unref();
  afterHeavy('tennis backfill packages', () => job('backfill packages', backfillPackages), 8 * 60 * 1000).unref();
  afterHeavy('tennis backfill archive', () => job('backfill archive', backfillArchive), 9 * 60 * 1000).unref();
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

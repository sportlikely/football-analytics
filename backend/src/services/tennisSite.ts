/**
 * Tennis site (fix193) — the public pages' data, built exactly like basketball's / NFL's: the same game shape (two
 * sides "home" / "away" = player 1 / player 2), the same prediction fields (pHome / pAway / pick 'H' | 'A', locked for
 * free and signed-out viewers until the match is over), the same record bands. Data: services/tennis.ts tables;
 * predictions: services/tennisModel.ts (tennis_predictions, saved until the start). Singles only. Tours shown: ATP,
 * WTA, Challenger, Grand Slams (ITF stays admin-only). Market prices (tennis_prices) never reach this file.
 * Admin-only until TENNIS_PUBLIC=1 (the routes in index.ts check). Every read is indexed or bounded by date.
 */
import { tennisFactors } from '../utils/whyFactors';
import { db } from '../db';
import { pubPath } from './slugs';
import { tennisModelInternals, tennisStrongLine, tennisPlayerModel, tennisLiveChance, tennisServeChances, tennisRecordSince, TENNIS_MODEL } from './tennisModel';
import { tournamentKey, setTennisLiveHook, eventGender } from './tennis';
import { yieldLoop } from './perf';
import { winnerBands, winnerByConfidence, winnerCalibration, winnerBrier } from '../utils/winnerBands';
import { shortName, fullName, isAbbreviated } from '../utils/tennisNames';
import { tournamentPlace, countryName } from '../utils/tennisPlaces';
import { ROUND_ORDER, normRound, roundEn } from '../utils/tennisRounds';
export { ROUND_ORDER, normRound, roundEn };

import { photoUrl } from './playerPhotos';

export const tennisPublic = () => process.env.TENNIS_PUBLIC === '1';
/** Reveal / unlock ids of tennis matches (their own negative range: football > 0, basketball -id, NFL -(2e9 + id)) */
export const tennisRid = (id: number) => -(4e9 + id);
const DAY = 86400000;
const { classify } = tennisModelInternals;

/* ---------- shapes ---------- */

export type TennisTour = 'atp' | 'wta' | 'challenger' | 'itf';
/** fix195: `name` = the full name (tennis_players), `short` = the real surname for tight rows */
export interface TSide { id: number | null; name: string; short: string; country: string | null; rank: number | null; logo: string | null }
export interface TScore { sets: [number, number][]; won: [number, number]; points: [string, string] | null; server: 1 | 2 | null }
export interface TMatch {
  id: number; tour: TennisTour; cat: string; women: boolean
  tournament: { key: string; id: string | null; name: string; tier: string | null; level: string; surface: string | null; indoor: boolean | null; city: string | null; country: string | null }
  round: string | null; roundCode: string | null; qualifying: boolean; bestOf: number
  start: string; status: string; state: 'upcoming' | 'live' | 'done' | 'off'
  home: TSide; away: TSide; score: TScore | null; winner: 1 | 2 | null; outcome: string | null
  /** match id as the reveal / unlock helpers use it */
  rid: number
  prediction?: any
}

const rankSql = (p: string) => `(SELECT r.rank FROM tennis_rankings r WHERE r.player_id = ${p}.id
  AND r.date = (SELECT MAX(r2.date) FROM tennis_rankings r2 WHERE r2.tour = r.tour) LIMIT 1)`;
export const MATCH_COLS = `m.id, m.tournament_id, m.tournament, m.tour, m.tier, m.surface, m.indoor, m.round, m.round_code, m.is_qualifying, m.best_of,
  m.scheduled_at, m.status, m.event_status, m.p1_id, m.p1_name, m.p2_id, m.p2_name, m.sets, m.games, m.winner, m.outcome, m.extra, m.source, m.updated_at,
  p1.name AS n1, p1.first_name AS f1, p1.last_name AS l1, p2.name AS n2, p2.first_name AS f2, p2.last_name AS l2,
  p1.country AS c1, p2.country AS c2, COALESCE(${rankSql('p1')}, p1.ranking) AS r1, COALESCE(${rankSql('p2')}, p2.ranking) AS r2, p1.tour AS t1, p2.tour AS t2,
  t.city AS tcity, t.country AS tcountry, t.indoor AS tindoor`;
export const MATCH_FROM = `FROM tennis_matches m LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id
  LEFT JOIN tennis_tournaments t ON t.id = m.tournament_id`;
/** public rows: singles, our own feed (the archive has other player ids), with both players */
export const MATCH_PUBLIC = `COALESCE(m.draw, 'singles') = 'singles' AND m.source <> 'archive' AND m.p1_name IS NOT NULL AND m.p2_name IS NOT NULL
  AND m.p1_name NOT IN ('TBD', 'TBA', 'Qualifier') AND m.p2_name NOT IN ('TBD', 'TBA', 'Qualifier')`;
/** fix195: the lists (home, matches, draw, search): no match the provider lost track of ('unknown', fix195 stale check;
 *  fix234: 'void' = still no result 48 h after the start) */
export const MATCH_LISTED = `${MATCH_PUBLIC} AND COALESCE(m.status, '') NOT IN ('unknown', 'void')`;

const LEVEL: Record<number, string> = { 0: 'Grand Slam', 1: '1000', 2: '500', 3: '250', 4: 'Challenger', 5: 'ITF' };
/** "atp_500" → "ATP 500", "grand_slam" → "Grand Slam", "challenger_125" → "Challenger 125" */
export function tierLabel(tier: string | null, tour: string | null): string {
  const t = String(tier || '').toLowerCase();
  if (!t || t === 'unknown') return String(tour || '').toLowerCase() === 'challenger' ? 'Challenger' : String(tour || '').toUpperCase();
  if (t === 'grand_slam') return 'Grand Slam';
  return t.split('_').map(w => (/^(atp|wta|itf|utr)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
/** lower = bigger: Grand Slam 0, 1000 1, 500 2, 250 3, Challenger 4, ITF 5 */
export const levelRank = (tier: string | null, tour: string | null, name: string | null) => classify(tour, tier, name, 'live')?.lvl ?? 6;
const stateOf = (status: string | null, outcome: string | null): TMatch['state'] => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed' || s === 'finished') return /walkover|abandoned|unresolved|cancel/.test(String(outcome || '')) ? 'off' : 'done';
  if (s === 'live' || s === 'in_progress' || s === 'interrupted' || s === 'suspended') return 'live';
  if (s === 'upcoming' || s === 'scheduled' || s === 'not_started' || !s) return 'upcoming';
  return 'off';
};
const PT: Record<string, string> = { '0': '0', '15': '15', '30': '30', '40': '40', A: 'AD', AD: 'AD', Ad: 'AD' };
/** A set is over at 6 with a 2-game lead, at 7, or (match tiebreak) at 10+ with a 2-point lead */
const setOver = (a: number, b: number) => (Math.max(a, b) >= 6 && Math.abs(a - b) >= 2) || Math.max(a, b) === 7 || (Math.max(a, b) >= 10 && Math.abs(a - b) >= 2);
function scoreOf(r: any, state: TMatch['state']): TScore | null {
  let g: any = null;
  try { g = r.games ? JSON.parse(r.games) : null; } catch { g = null; }
  if (!Array.isArray(g) || !Array.isArray(g[0]) || !Array.isArray(g[1]) || !g[0].length) return null;
  const sets: [number, number][] = g[0].map((x: any, i: number) => [Number(x) || 0, Number(g[1][i]) || 0])
  const won: [number, number] = [0, 0];
  sets.forEach(([a, b], i) => {
    const last = i === sets.length - 1;
    // the last set of a live match is still being played unless it is over
    if (state === 'live' && last && !setOver(a, b)) return;
    if (a > b) won[0]++; else if (b > a) won[1]++;
  });
  let ex: any = null;
  try { ex = r.extra ? JSON.parse(r.extra) : null; } catch { ex = null; }
  const pts = state === 'live' && Array.isArray(ex?.livePoints) ? ex.livePoints.map((x: string) => PT[x] ?? x) as [string, string] : null;
  return { sets, won, points: pts, server: state === 'live' && (ex?.server === 1 || ex?.server === 2) ? ex.server : null };
}
/* ---------- rounds (fix195; the mapping lives in utils/tennisRounds.ts since fix197: the data jobs store it too) ---------- */

const roundRank = (code: string | null) => (code && code in ROUND_ORDER ? ROUND_ORDER[code] : 4);

/** the tour of a row for its pages and keys (the classified tour, never the row's raw 'atp' default) */
const tourOf = (cls: { cat: number; gen: number }): TennisTour => (cls.cat === 3 ? 'challenger' : cls.cat === 4 ? 'itf' : cls.gen === 1 ? 'wta' : 'atp');
/** a row's tournament page key from its classified tour */
export function slugOf(tour: string | null, tier: string | null, name: string | null, source = 'live'): string {
  const cls = classify(tour, tier, name, source);
  return tournamentSlug(cls ? tourOf(cls) : tour, String(name || ''));
}
/** a side's display name: first + last from the profile, else the profile name, else the match row's (initials last) */
const sideName = (row: string | null, prof: string | null, first: string | null, last: string | null) => {
  const p = fullName(prof, first, last);
  return p && (!isAbbreviated(p) || !row) ? p : row || p;
};

/** a row of MATCH_COLS → TMatch (null = left out: doubles, juniors, team events, exhibitions) */
export function shapeMatch(r: any): TMatch | null {
  const cls = classify(r.tour, r.tier, r.tournament, r.source || 'live');
  if (!cls) return null;
  const tour = tourOf(cls);
  let state = stateOf(r.status, r.outcome);
  // fix195: still "upcoming" 6 h after the start, or "live" with no update for 30 min 6 h after the start: not on the
  // lists until the provider says what happened (services/tennis.ts asks again)
  const t0 = Date.parse(r.scheduled_at), now = Date.now();
  if (state === 'upcoming' && t0 < now - 6 * 3600e3) state = 'off';
  if (state === 'live' && t0 < now - 6 * 3600e3 && !(Date.parse(r.updated_at || '') > now - 30 * 60e3)) state = 'off';
  const name = String(r.tournament || '').trim() || 'Tournament';
  const place = tournamentPlace(r.tcountry, r.tcity, name);
  const n1 = sideName(r.p1_name, r.n1 ?? null, r.f1 ?? null, r.l1 ?? null), n2 = sideName(r.p2_name, r.n2 ?? null, r.f2 ?? null, r.l2 ?? null);
  const quali = !!r.is_qualifying || /\b(qualification|qualifying)\b/i.test(name);
  const code = normRound(r.round_code, r.round, quali);
  return {
    id: r.id, tour, cat: (['slam', 'atp', 'wta', 'challenger', 'itf'] as const)[cls.cat], women: cls.gen === 1,
    tournament: {
      key: tournamentSlug(tour, name), id: r.tournament_id || null, name: name.replace(/\s*[-–]\s*(qualification|qualifying).*$/i, '').replace(/\s+\(\w[^)]*\)\s*$/, '').trim() || name,
      tier: r.tier || null, level: LEVEL[cls.lvl] || '', surface: r.surface ? String(r.surface).toLowerCase() : null,
      indoor: r.indoor == null ? (r.tindoor == null ? null : !!r.tindoor) : !!r.indoor, city: place.city, country: place.country
    },
    round: roundEn(code), roundCode: code, qualifying: quali || (!!code && code.startsWith('Q')), bestOf: r.best_of === 5 ? 5 : 3,
    start: r.scheduled_at, status: r.status || 'upcoming', state,
    home: { id: r.p1_id ?? null, name: n1, short: shortName(n1, r.f1 && r.l1 ? r.l1 : null), country: r.c1 || null, rank: r.r1 ?? null, logo: photoUrl('tennis', r.p1_id) },
    away: { id: r.p2_id ?? null, name: n2, short: shortName(n2, r.f2 && r.l2 ? r.l2 : null), country: r.c2 || null, rank: r.r2 ?? null, logo: photoUrl('tennis', r.p2_id) },
    score: scoreOf(r, state), winner: r.winner === 1 || r.winner === 2 ? r.winner : null, outcome: r.outcome || null, rid: tennisRid(r.id)
  };
}
/** a tournament's page id: tour + its name without qualifying / country / year ("atp-erste-bank-open") */
export function tournamentSlug(tour: string | null, name: string): string {
  const t = String(tour || '').toLowerCase();
  return `${t === 'wta' ? 'wta' : t === 'challenger' ? 'challenger' : t === 'itf' ? 'itf' : 'atp'}-${tournamentKey(name).replace(/\s+/g, '-') || 'tournament'}`;
}
const tourOk = (m: TMatch, tour: string | null, admin: boolean) =>
  (m.tour !== 'itf' || (admin && tour === 'itf')) && (!tour || tour === 'all' || m.tour === tour);

/* ---------- predictions (saved until the start, frozen after) ---------- */

const parse = (x: string | null) => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
interface Saved { p1: number; sets: Record<string, number> | null; games: any; firstSetP1: number | null; why: any; model: string; madeAt: string; at: string; cat: string | null }
function savedFor(ids: number[]): Map<number, Saved> {
  const out = new Map<number, Saved>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    if (!chunk.length) continue;
    for (const r of db.prepare(`SELECT * FROM tennis_predictions WHERE match_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as any[])
      out.set(r.match_id, { p1: r.p1, sets: parse(r.sets), games: parse(r.games), firstSetP1: r.first_set_p1, why: parse(r.why), model: r.model, madeAt: r.made_at, at: r.scheduled_at, cat: r.cat });
  }
  return out;
}
const isVoid = (m: TMatch) => m.state !== 'done' || !(m.winner === 1 || m.winner === 2);
function predOf(m: TMatch, s: Saved, full: boolean) {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const pHome = r1(100 * s.p1), pAway = r1(100 - pHome);
  const strongAt = tennisStrongLine(m.cat);
  const hit = m.state === 'done' && !isVoid(m) && Date.parse(s.madeAt) <= Date.parse(m.start) + 60 * 1000 ? (s.p1 >= 0.5) === (m.winner === 1) : null;
  const base = { locked: false, model: s.model || TENNIS_MODEL, pHome, pAway, pick: (s.p1 >= 0.5 ? 'H' : 'A') as 'H' | 'A', strongAt, strong: Math.max(pHome, pAway) >= strongAt, hit };
  if (!full && m.state !== 'done') return { locked: true, model: s.model || TENNIS_MODEL };
  // finished matches: everyone sees the numbers and the hit (like basketball / NFL), the reasons only with the full view
  const sets = s.sets ? Object.entries(s.sets).map(([k, v]) => ({ score: k, pct: r1(v) })).sort((a, b) => b.pct - a.pct) : []
  const games = s.games && typeof s.games === 'object' ? { mean: s.games.mean ?? null, median: s.games.median ?? null, over: s.games.over || {} } : null;
  return {
    ...base,
    firstSet: s.firstSetP1 == null ? null : { pHome: r1(100 * s.firstSetP1), pAway: r1(100 - 100 * s.firstSetP1) },
    sets, games,
    ...(full ? { why: Array.isArray(s.why?.lines) ? s.why.lines : [], factors: s.why?.terms ? tennisFactors(s.why.terms) : null, numbers: s.why?.numbers ? { eloSurface: s.why.numbers.eloSurface, eloOverall: s.why.numbers.eloOverall, servePoint: s.why.numbers.servePoint } : null } : {})
  };
}
/** Attach the saved prediction (and the live chance on live matches the viewer may see) to a list. `full(id)` = numbers. */
export function withTennisPredictions(list: TMatch[], full: boolean | ((rid: number) => boolean)): TMatch[] {
  const saved = savedFor(list.map(m => m.id));
  return list.map(m => {
    const s = saved.get(m.id);
    if (!s) return { ...m, prediction: null };
    const f = typeof full === 'function' ? full(m.rid) : full;
    const prediction: any = predOf(m, s, f);
    if (m.state === 'live' && !prediction.locked) { const now = liveNow(m, s); if (now) prediction.live = now; }
    return { ...m, prediction };
  });
}

/* ---------- lists ---------- */

const ORDER_START = 'ORDER BY m.scheduled_at, m.id';
export function tennisMatchesBetween(from: string, to: string, tour: string | null, admin: boolean, limit = 1500): TMatch[] {
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.scheduled_at >= ? AND m.scheduled_at < ? AND ${MATCH_LISTED} ${ORDER_START} LIMIT ?`).all(from, to, limit) as any[];
  return rows.map(shapeMatch).filter((m): m is TMatch => !!m && tourOk(m, tour, admin));
}
export function tennisLive(tour: string | null, admin: boolean): TMatch[] {
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.status IN ('live', 'in_progress', 'interrupted', 'suspended') AND m.scheduled_at >= ? AND ${MATCH_LISTED} ${ORDER_START} LIMIT 400`)
    .all(new Date(Date.now() - 2 * DAY).toISOString()) as any[];
  return rows.map(shapeMatch).filter((m): m is TMatch => !!m && m.state === 'live' && tourOk(m, tour, admin));
}
export function tennisRecent(n: number, tour: string | null, admin: boolean): TMatch[] {
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.status = 'completed' AND m.scheduled_at >= ? AND m.scheduled_at <= ? AND ${MATCH_PUBLIC}
    AND EXISTS (SELECT 1 FROM tennis_predictions p WHERE p.match_id = m.id) ORDER BY m.scheduled_at DESC LIMIT ?`)
    .all(new Date(Date.now() - 4 * DAY).toISOString(), new Date().toISOString(), n * 6) as any[];
  return rows.map(shapeMatch).filter((m): m is TMatch => !!m && m.state === 'done' && tourOk(m, tour, admin)).slice(0, n);
}

/* ---------- live win chance + swing chart ---------- */

db.exec(`CREATE TABLE IF NOT EXISTS tennis_live_samples (match_id INTEGER NOT NULL, t REAL NOT NULL, p REAL NOT NULL, s1 INTEGER, s2 INTEGER, PRIMARY KEY (match_id, t))`);
const PT_N: Record<string, number> = { '0': 0, '15': 1, '30': 2, '40': 3, AD: 4 };
function liveNow(m: TMatch, s: Saved) {
  const sc = m.score;
  if (!sc || !sc.sets.length) return null;
  const sp = s.why?.numbers?.servePoint as [number, number] | undefined;
  const { pa, pb } = tennisServeChances(sp, s.p1, m.bestOf);
  const last = sc.sets[sc.sets.length - 1];
  const inPlay = !setOver(last[0], last[1]);
  const games: [number, number] = inPlay ? last : [0, 0];
  const pts = sc.points ? [PT_N[sc.points[0]] ?? null, PT_N[sc.points[1]] ?? null] : null;
  const p = tennisLiveChance({ pa, pb, bo: m.bestOf, sets: sc.won, games, points: pts && pts[0] !== null && pts[1] !== null ? [pts[0]!, pts[1]!] : null, server: sc.server });
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  return { pHome: r1(p), pAway: r1(1 - p), score: { home: sc.won[0], away: sc.won[1] }, total: sc.sets.reduce((a, x) => a + x[0] + x[1], 0) };
}
/** one sample per live poll: t = sets finished + share of the current set (games / 12) */
/**
 * fix194: in slices — the live chance (Markov chain) of every live match was computed in one block and each sample
 * written as its own commit ("tennis live" stalls of 0.6–1 s on 20 Oct); now ~25 ms of matches per slice, the
 * samples of a slice written in one transaction (never open across an await).
 */
async function sampleLive(ids: number[]) {
  if (!ids.length) return;
  const put = db.prepare(`INSERT OR REPLACE INTO tennis_live_samples (match_id, t, p, s1, s2) VALUES (?, ?, ?, ?, ?)`);
  for (let k = 0; k < ids.length; k += 50) {
    const part = ids.slice(k, k + 50);
    const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.id IN (${part.map(() => '?').join(',')})`).all(...part) as any[];
    const saved = savedFor(part);
    let i = 0;
    while (i < rows.length) {
      const t0 = Date.now();
      const out: [number, number, number, number, number][] = [];
      while (i < rows.length && Date.now() - t0 < 25) {
        const r = rows[i++];
        const m = shapeMatch(r), s = saved.get(r.id);
        if (!m || !s || m.state !== 'live' || !m.score) continue;
        const now = liveNow(m, s);
        if (!now) continue;
        const last = m.score.sets[m.score.sets.length - 1];
        const done = m.score.won[0] + m.score.won[1];
        const t = done + (setOver(last[0], last[1]) ? 0 : Math.min(0.99, (last[0] + last[1]) / 12));
        out.push([r.id, Math.round(t * 1000) / 1000, now.pHome, m.score.won[0], m.score.won[1]]);
      }
      if (out.length) {
        db.exec('BEGIN');
        try { for (const o of out) put.run(...o); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
      await yieldLoop();
    }
  }
}
setTennisLiveHook(ids => sampleLive(ids));
/** the swing chart: before the start, every live sample, and the final point once the match is over */
export function tennisLiveCurve(m: TMatch): { t: number; p: number }[] {
  const s = savedFor([m.id]).get(m.id);
  if (!s) return [];
  const rows = db.prepare(`SELECT t, p FROM tennis_live_samples WHERE match_id = ? ORDER BY t`).all(m.id) as any[];
  if (!rows.length) return [];
  const out = [{ t: 0, p: Math.round(s.p1 * 1000) / 10 }, ...rows.map(r => ({ t: r.t, p: r.p }))];
  if (m.state === 'done' && m.winner) out.push({ t: Math.max(m.score ? m.score.won[0] + m.score.won[1] : 0, rows[rows.length - 1].t + 0.001), p: m.winner === 1 ? 99.9 : 0.1 });
  return out;
}

/* ---------- match page ---------- */

interface Agg { matches: number; svc_pts: number; svc_won: number; ret_pts: number; ret_won: number; svc_games: number; svc_held: number; bp_faced: number; bp_saved: number; bp_had: number; bp_conv: number; tb_played: number; tb_won: number }
const emptyAgg = (): Agg => ({ matches: 0, svc_pts: 0, svc_won: 0, ret_pts: 0, ret_won: 0, svc_games: 0, svc_held: 0, bp_faced: 0, bp_saved: 0, bp_had: 0, bp_conv: 0, tb_played: 0, tb_won: 0 });
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
function aggView(a: Agg) {
  return {
    matches: a.matches,
    servicePointsWon: pctOf(a.svc_won, a.svc_pts), returnPointsWon: pctOf(a.ret_won, a.ret_pts), holdPct: pctOf(a.svc_held, a.svc_games),
    bpSaved: pctOf(a.bp_saved, a.bp_faced), bpConverted: pctOf(a.bp_conv, a.bp_had), tiebreaksWon: pctOf(a.tb_won, a.tb_played), tiebreaks: a.tb_played
  };
}
/** serve & return of a player: last 52 weeks before `before`, and on one surface */
export function serveReturn(pid: number | null, before: string, surface: string | null) {
  if (!pid) return null;
  const rows = db.prepare(`SELECT s.svc_pts, s.svc_won, s.ret_pts, s.ret_won, s.svc_games, s.svc_held, s.bp_faced, s.bp_saved, s.bp_had, s.bp_conv, s.tb_played, s.tb_won,
      m.surface, s.complete, s.match_id, m.p1_id, m.p2_id, s.player
    FROM tennis_match_stats s JOIN tennis_matches m ON m.id = s.match_id
    WHERE s.player_id = ? AND m.scheduled_at >= ? AND m.scheduled_at < ? AND m.source <> 'archive' AND s.svc_pts > 0`)
    .all(pid, new Date(Date.parse(before) - 365 * DAY).toISOString(), before) as any[];
  const all = emptyAgg(), surf = emptyAgg();
  // return games: the opponent's service games in the same match (for the break %)
  const oppGames = db.prepare(`SELECT svc_games FROM tennis_match_stats WHERE match_id = ? AND player = ?`);
  let rg = 0, rgS = 0;
  for (const r of rows) {
    const og = (oppGames.get(r.match_id, r.player === 1 ? 2 : 1) as any)?.svc_games || 0;
    for (const [a, on] of [[all, true], [surf, !!surface && String(r.surface || '').toLowerCase() === surface]] as [Agg, boolean][]) {
      if (!on) continue;
      a.matches++;
      for (const k of ['svc_pts', 'svc_won', 'ret_pts', 'ret_won', 'svc_games', 'svc_held', 'bp_faced', 'bp_saved', 'bp_had', 'bp_conv', 'tb_played', 'tb_won'] as const) a[k] += Number(r[k]) || 0;
    }
    rg += og; if (surface && String(r.surface || '').toLowerCase() === surface) rgS += og;
  }
  const v = (a: Agg, games: number) => ({ ...aggView(a), breakPct: pctOf(a.bp_conv, games) });
  return { last52: v(all, rg), surface: surface ? v(surf, rgS) : null };
}
interface Played { id: number; start: string; tournament: string; tkey: string; surface: string | null; round: string | null; roundCode: string | null; opponent: { id: number | null; name: string; short: string; country: string | null }; won: boolean; score: string; sets: number; minutes: number | null; retired: boolean }
/** a player's finished matches before `before`, newest first */
export function playedBefore(pid: number | null, before: string, limit = 10, since?: string): Played[] {
  if (!pid) return [];
  const rows = db.prepare(`SELECT m.id, m.scheduled_at, m.tournament, m.tour, m.tier, m.source, m.surface, m.round, m.round_code, m.is_qualifying, m.p1_id, m.p1_name, m.p2_id, m.p2_name, m.winner, m.games, m.outcome, m.extra,
      p1.country AS c1, p2.country AS c2, p1.name AS n1, p1.first_name AS f1, p1.last_name AS l1, p2.name AS n2, p2.first_name AS f2, p2.last_name AS l2, (SELECT MAX(s.duration_s) FROM tennis_match_stats s WHERE s.match_id = m.id) AS dur
    FROM tennis_matches m LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id
    WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id = ? AND scheduled_at < ? AND scheduled_at >= ? UNION SELECT id FROM tennis_matches WHERE p2_id = ? AND scheduled_at < ? AND scheduled_at >= ?)
      AND m.status = 'completed' AND m.winner IN (1, 2) AND m.source <> 'archive' AND COALESCE(m.draw, 'singles') = 'singles'
    ORDER BY m.scheduled_at DESC LIMIT ?`).all(pid, before, since || '2000-01-01', pid, before, since || '2000-01-01', limit) as any[];
  return rows.map(r => {
    const me = r.p1_id === pid ? 1 : 2;
    let g: any = null; try { g = r.games ? JSON.parse(r.games) : null; } catch { g = null; }
    const sets = Array.isArray(g?.[0]) ? g[0].map((x: any, i: number) => (me === 1 ? `${x}-${g[1][i]}` : `${g[1][i]}-${x}`)) : [];
    const ex = parse(r.extra);
    const code = normRound(r.round_code, r.round, !!r.is_qualifying || /\b(qualification|qualifying)\b/i.test(String(r.tournament || '')));
    const opp = me === 1 ? { id: r.p2_id, name: sideName(r.p2_name, r.n2, r.f2, r.l2), last: r.f2 && r.l2 ? r.l2 : null, country: r.c2 || null }
      : { id: r.p1_id, name: sideName(r.p1_name, r.n1, r.f1, r.l1), last: r.f1 && r.l1 ? r.l1 : null, country: r.c1 || null };
    // fix229: both sides in match order (the match's slug link: /tennis/match/<p1>-vs-<p2>-<day>)
    const p1 = { id: r.p1_id, name: sideName(r.p1_name, r.n1, r.f1, r.l1) }, p2 = { id: r.p2_id, name: sideName(r.p2_name, r.n2, r.f2, r.l2) };
    return {
      id: r.id, start: r.scheduled_at, tournament: r.tournament, tkey: slugOf(r.tour, r.tier, r.tournament || '', r.source || 'live'), surface: r.surface ? String(r.surface).toLowerCase() : null,
      round: roundEn(code), roundCode: code,
      opponent: { id: opp.id, name: opp.name, short: shortName(opp.name, opp.last), country: opp.country },
      won: r.winner === me, score: sets.join(' '), sets: sets.length, minutes: r.dur ? Math.round(r.dur / 60) : ex?.minutes ? Math.round(ex.minutes) : null,
      retired: /retired/.test(String(r.outcome || '')), p1, p2
    };
  });
}
/** schedule & rest before a match: matches / sets / hours in the last 3 / 7 / 14 days, yesterday's match, travel / surface switch, stoppages */
export function scheduleRest(pid: number | null, m: { start: string; tournament: { name: string; surface: string | null; country: string | null } }) {
  if (!pid) return null;
  const T = Date.parse(m.start);
  const list = playedBefore(pid, m.start, 30, new Date(T - 30 * DAY).toISOString());
  const within = (d: number) => list.filter(x => T - Date.parse(x.start) <= d * DAY);
  // hours on court: the recorded length, else ~40 minutes a set (tapes are missing for some matches)
  const hours = (xs: Played[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + (x.minutes || x.sets * 40), 0) / 60) * 10) / 10 : 0);
  const last = list[0] || null;
  const lastGap = last ? (T - Date.parse(last.start)) / 3600000 : null;
  const stops = db.prepare(`SELECT kind, at, match_id FROM tennis_stoppages WHERE player_id = ? AND at >= ? AND at < ? ORDER BY at DESC`).all(pid, new Date(T - 30 * DAY).toISOString(), m.start) as any[];
  const retirements = list.filter(x => x.retired && !x.won).length;
  const prevTournament = last ? last.tournament : null;
  return {
    last3: { matches: within(3).length, sets: within(3).reduce((s, x) => s + x.sets, 0), hours: hours(within(3)) },
    last7: { matches: within(7).length, sets: within(7).reduce((s, x) => s + x.sets, 0), hours: hours(within(7)) },
    last14: { matches: within(14).length, sets: within(14).reduce((s, x) => s + x.sets, 0), hours: hours(within(14)) },
    yesterday: last && lastGap !== null && lastGap <= 36 ? { minutes: last.minutes, sets: last.sets, hoursAgo: Math.round(lastGap) } : null,
    daysSinceLast: lastGap === null ? null : Math.round((lastGap / 24) * 10) / 10,
    newTournament: !!prevTournament && tournamentKey(prevTournament) !== tournamentKey(m.tournament.name),
    surfaceSwitch: !!last && !!last.surface && !!m.tournament.surface && last.surface !== m.tournament.surface ? { from: last.surface, to: m.tournament.surface } : null,
    stoppages: { medical: stops.filter(s => /medical|injur|timeout/i.test(s.kind)).length, other: stops.filter(s => !/medical|injur|timeout/i.test(s.kind)).length, retirements }
  };
}
/** all our meetings of two players (newest first), with who won and the surface */
export function headToHead(a: number | null, b: number | null, before?: string) {
  if (!a || !b) return { list: [] as any[], bySurface: [] as any[], won: [0, 0] as [number, number] };
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM}
    WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id = ? AND p2_id = ? UNION SELECT id FROM tennis_matches WHERE p1_id = ? AND p2_id = ?)
      AND m.status = 'completed' AND m.winner IN (1, 2) AND ${MATCH_PUBLIC} ${before ? 'AND m.scheduled_at < ?' : ''} ORDER BY m.scheduled_at DESC LIMIT 40`)
    .all(...[a, b, b, a, ...(before ? [before] : [])]) as any[];
  const list = rows.map(shapeMatch).filter((m): m is TMatch => !!m && m.state === 'done');
  const winnerId = (m: TMatch) => (m.winner === 1 ? m.home.id : m.away.id);
  const won: [number, number] = [list.filter(m => winnerId(m) === a).length, list.filter(m => winnerId(m) === b).length];
  const surf = new Map<string, [number, number]>();
  for (const m of list) { const k = m.tournament.surface || 'other'; const x = surf.get(k) || [0, 0]; if (winnerId(m) === a) x[0]++; else x[1]++; surf.set(k, x); }
  return { list, won, bySurface: [...surf.entries()].map(([surface, w]) => ({ surface, won: w })) };
}
/**
 * The draw of a tournament edition: its matches grouped by round, from our matches. fix195: one row per match (the same
 * two players in one round once: the further / richer row stays), main draw rounds in order (first round → final),
 * qualifying after the main draw; matches the provider lost track of are left out.
 */
export function tournamentDraw(key: string, around: string) {
  const T = Date.parse(around);
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.scheduled_at >= ? AND m.scheduled_at < ? AND ${MATCH_LISTED} ORDER BY m.scheduled_at LIMIT 3000`)
    .all(new Date(T - 16 * DAY).toISOString(), new Date(T + 16 * DAY).toISOString()) as any[];
  const list = rows.map(shapeMatch).filter((m): m is TMatch => !!m && m.tournament.key === key && !(m.state === 'off' && m.status !== 'completed'));
  const STATE_RANK: Record<string, number> = { done: 3, live: 2, upcoming: 1, off: 0 };
  const seen = new Map<string, TMatch>();
  for (const m of list) {
    const k = `${m.qualifying ? 'Q' : 'M'}|${[m.home.id ?? m.home.name, m.away.id ?? m.away.name].sort().join('-')}`;
    const o = seen.get(k);
    if (!o || STATE_RANK[m.state] > STATE_RANK[o.state] || (STATE_RANK[m.state] === STATE_RANK[o.state] && m.id > o.id)) seen.set(k, m);
  }
  const rounds = new Map<string, TMatch[]>();
  for (const m of [...seen.values()].sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)) {
    const code = m.roundCode || (m.qualifying ? 'Q' : 'R');
    const c = (m.qualifying ? 'Q:' : '') + code;
    rounds.set(c, [...(rounds.get(c) || []), m]);
  }
  return [...rounds.entries()]
    .map(([c, ms]) => { const code = c.replace(/^Q:/, ''); return { code, qualifying: c.startsWith('Q:'), name: roundEn(code) || 'Matches', matches: ms }; })
    .sort((a, b) => Number(a.qualifying) - Number(b.qualifying) || roundRank(a.code) - roundRank(b.code));
}
const isWomen = (m: TMatch) => m.women;

/** Everything the match page shows. `full` = the viewer sees the prediction's numbers. */
export function tennisMatch(id: number, full: boolean, admin: boolean) {
  const r = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.id = ? AND ${MATCH_PUBLIC}`).get(id) as any;
  const m0 = r ? shapeMatch(r) : null;
  if (!m0 || (m0.tour === 'itf' && !admin)) return null;
  const m = withTennisPredictions([m0], full)[0];
  const p = m.prediction;
  const open = !!p && !p.locked;
  const before = m.state === 'upcoming' ? new Date(Date.now() + 60 * 1000).toISOString() : m.start;
  const surface = m.tournament.surface;
  return {
    match: m, prediction: p,
    live: open ? { now: m.state === 'live' ? p.live || null : null, curve: m.state === 'upcoming' ? [] : tennisLiveCurve(m) } : null,
    stats: { home: serveReturn(m.home.id, before, surface), away: serveReturn(m.away.id, before, surface) },
    form: { home: playedBefore(m.home.id, before, 10), away: playedBefore(m.away.id, before, 10) },
    ratings: { home: m.home.id ? tennisPlayerModel(m.home.id, isWomen(m)) : null, away: m.away.id ? tennisPlayerModel(m.away.id, isWomen(m)) : null },
    schedule: { home: scheduleRest(m.home.id, m), away: scheduleRest(m.away.id, m) },
    h2h: headToHead(m.home.id, m.away.id, m.state === 'upcoming' ? undefined : m.start),
    draw: tournamentDraw(m.tournament.key, m.start)
  };
}

/* ---------- record (saved before the start, finished, not void) ---------- */

export function tennisRecordRows(days: number, tour: string | null) {
  const since = new Date(Math.max(Date.now() - days * DAY, Date.parse(`${tennisRecordSince()}T00:00:00Z`))).toISOString();
  const rows = db.prepare(`SELECT p.match_id, p.p1, p.cat, p.made_at, p.scheduled_at, p.sets AS p_sets, p.games AS p_games, ${MATCH_COLS} FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
      LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id LEFT JOIN tennis_tournaments t ON t.id = m.tournament_id
    WHERE m.status = 'completed' AND m.winner IN (1, 2) AND p.made_at <= p.scheduled_at AND p.scheduled_at >= ? AND ${MATCH_PUBLIC} ORDER BY m.scheduled_at DESC`).all(since) as any[];
  return rows.map(r => ({ r, m: shapeMatch(r) })).filter(x => x.m && x.m.state === 'done' && x.m.tour !== 'itf' && (!tour || tour === 'all' || x.m.tour === tour)) as { r: any; m: TMatch }[];
}
export function tennisRecord(days = 30, tour: string | null = null) {
  const rows = tennisRecordRows(days, tour);
  return { days, since: tennisRecordSince(), bands: winnerBands(rows.map(x => ({ p: Math.max(x.r.p1, 1 - x.r.p1), hit: (x.r.p1 >= 0.5) === (x.m.winner === 1) }))) };
}
export { winnerByConfidence };

/* ---------- tournaments (fix193b; the Matches page's tournament panel uses it too) ---------- */

/** names of every tournament we hold by their page key (cached an hour) */
let namesCache: { at: number; byKey: Map<string, Set<string>> } | null = null;
function namesOfKey(key: string): string[] {
  if (!namesCache || Date.now() - namesCache.at > 3600e3) {
    const byKey = new Map<string, Set<string>>();
    // fix195: keyed by the classified tour (an ITF event a fixture called 'atp' is not the ATP event's)
    for (const r of db.prepare(`SELECT DISTINCT tournament, tour, tier, CASE WHEN source = 'archive' THEN 'archive' ELSE 'live' END AS src FROM tennis_matches WHERE tournament IS NOT NULL AND scheduled_at >= ?`).all(new Date(Date.now() - 12 * 365 * DAY).toISOString()) as any[]) {
      const k = slugOf(r.tour, r.tier, r.tournament, r.src);
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k)!.add(r.tournament);
    }
    namesCache = { at: Date.now(), byKey };
  }
  return [...(namesCache.byKey.get(key) || [])];
}
/** Tournament page: the latest edition (header, the draw), past champions, our record in it */
export function tennisTournament(key: string, full: boolean | ((rid: number) => boolean), admin: boolean) {
  const names = namesOfKey(key);
  if (!names.length) return null;
  const q = names.map(() => '?').join(',');
  const now = Date.now();
  // the edition on screen: the one being played (or next); else the most recent
  const near = db.prepare(`SELECT MIN(scheduled_at) AS a FROM tennis_matches WHERE tournament IN (${q}) AND source <> 'archive' AND scheduled_at >= ?`).get(...names, new Date(now - 10 * DAY).toISOString()) as any;
  const last = db.prepare(`SELECT MAX(scheduled_at) AS b FROM tennis_matches WHERE tournament IN (${q}) AND source <> 'archive'`).get(...names) as any;
  const around = near?.a || last?.b;
  if (!around) return null;
  const draw = tournamentDraw(key, around).map(r => ({ ...r, matches: withTennisPredictions(r.matches, full) }));
  const all = draw.flatMap(r => r.matches);
  const first = all[0] || null;
  if (!first || (first.tour === 'itf' && !admin)) return null;
  // the catalogue row: this edition's own tournament id first, else the same name on the same tour
  // fix197: only a catalogue row of the same gender (a men's row that carried the WTA event's id never takes its dates)
  const sameGen = (t: any) => !!t && eventGender(t.tour, t.tier, t.name) !== (first.women ? 'm' : 'w');
  const tid = all.find(m => m.tournament.id)?.tournament.id || null;
  const byId = (tid ? db.prepare(`SELECT * FROM tennis_tournaments WHERE id = ?`).get(tid) : null) as any;
  const meta = (sameGen(byId) ? byId : null)
    || db.prepare(`SELECT * FROM tennis_tournaments WHERE name IN (${q}) ORDER BY start_date DESC LIMIT 20`).all(...names).find((t: any) => slugOf(t.tour, t.tier, t.name) === key) as any;
  const starts = all.map(m => m.start).sort();
  // fix197: the dates cover every match we hold (the catalogue said 18–20 Oct for Cali while matches went on on the 21st)
  const firstDay = starts[0]?.slice(0, 10) || null, lastDay = starts[starts.length - 1]?.slice(0, 10) || null;
  const metaStart = meta?.start_date ? String(meta.start_date).slice(0, 10) : null, metaEnd = meta?.end_date ? String(meta.end_date).slice(0, 10) : null;
  // past champions: the final of each year (our feed and the 2015–2022 archive, matched by name)
  // fix195: only the finals of the same tour, gender and level family (the Cali Challenger never shows the WTA champion)
  const finals = db.prepare(`SELECT tournament, tour, tier, scheduled_at, round, round_code, p1_name, p2_name, p1_id, p2_id, winner, games, source, is_qualifying FROM tennis_matches
    WHERE tournament IN (${q}) AND status = 'completed' AND winner IN (1, 2) AND COALESCE(is_qualifying, 0) = 0 ORDER BY scheduled_at DESC LIMIT 4000`).all(...names) as any[];
  const champions = new Map<string, any>();
  for (const f of finals) {
    if (normRound(f.round_code, f.round, false) !== 'F' && !/^(f|final|the final)$/i.test(String(f.round_code || f.round || '').trim())) continue;
    if (slugOf(f.tour, f.tier, f.tournament, f.source === 'archive' ? 'archive' : 'live') !== key) continue;
    const year = String(f.scheduled_at).slice(0, 4);
    if (champions.has(year)) continue;
    let g: any = null; try { g = f.games ? JSON.parse(f.games) : null; } catch { g = null; }
    const wn = f.winner === 1 ? f.p1_name : f.p2_name, ln = f.winner === 1 ? f.p2_name : f.p1_name;
    const wid = f.source === 'archive' ? null : f.winner === 1 ? f.p1_id : f.p2_id;
    const score = Array.isArray(g?.[0]) ? g[0].map((x: any, i: number) => (f.winner === 1 ? `${x}-${g[1][i]}` : `${g[1][i]}-${x}`)).join(' ') : '';
    champions.set(year, { year: Number(year), winner: { id: wid, name: wn }, runnerUp: ln, score });
  }
  // our record in this tournament (saved before the start, finished)
  const recRows = tennisRecordRows(3650, null).filter(x => x.m.tournament.key === key);
  const hits = recRows.filter(x => (x.r.p1 >= 0.5) === (x.m.winner === 1)).length;
  return {
    key, name: first.tournament.name, tour: first.tour, tier: first.tournament.tier, level: first.tournament.level, women: first.women,
    surface: first.tournament.surface, indoor: first.tournament.indoor,
    // fix195: the country from the catalogue unless it is empty / "World", else from the city or the name (Cali → Colombia)
    ...(() => { const pl = tournamentPlace(meta?.country, meta?.city || first.tournament.city, first.tournament.name); return { city: pl.city, country: pl.country || first.tournament.country || null }; })(),
    start: metaStart && (!firstDay || metaStart <= firstDay) ? metaStart : firstDay, end: metaEnd && (!lastDay || metaEnd >= lastDay) ? metaEnd : lastDay,
    draw, champions: [...champions.values()].slice(0, 12),
    record: { n: recRows.length, right: hits, pct: recRows.length ? Math.round((1000 * hits) / recRows.length) / 10 : null }
  };
}

/* ---------- player page (fix193b) ---------- */

/** a player's tour for the comparisons and the model: the latest rankings table they are in, else their matches */
function womenOf(pid: number): boolean {
  const r = db.prepare(`SELECT tour FROM tennis_rankings WHERE player_id = ? ORDER BY date DESC LIMIT 1`).get(pid) as any;
  if (r?.tour) return r.tour === 'wta';
  const p = db.prepare(`SELECT tour FROM tennis_players WHERE id = ?`).get(pid) as any;
  if (p?.tour === 'wta') return true;
  const w = db.prepare(`SELECT 1 FROM tennis_matches WHERE (p1_id = ? OR p2_id = ?) AND tour = 'wta' LIMIT 1`).get(pid, pid);
  return !!w;
}

/**
 * The 1–10 scores of the player page: serve and return numbers of the last 52 weeks against everyone of the same
 * tour (men / women) with at least 8 matches with stats; 10 = the best tenth. Cached 6 hours (one grouped read).
 */
interface PoolRow { pid: number; w: number; n: number; svc: number | null; ret: number | null; hold: number | null; brk: number | null; bps: number | null; bpc: number | null; tb: number | null; tbn: number; win: number | null; played: number }
let pool: { at: number; rows: Map<number, PoolRow>; sorted: Record<string, [number[], number[]]> } | null = null;
const MEASURES: { id: keyof PoolRow; label: string; min?: (r: PoolRow) => boolean }[] = [
  { id: 'win', label: 'Matches won' },
  { id: 'svc', label: 'Service points won' },
  { id: 'ret', label: 'Return points won' },
  { id: 'hold', label: 'Service games held' },
  { id: 'brk', label: 'Return games broken' },
  { id: 'bps', label: 'Break points saved' },
  { id: 'bpc', label: 'Break points converted' },
  { id: 'tb', label: 'Tiebreaks won', min: r => r.tbn >= 5 }
];
function playerPool() {
  if (pool && Date.now() - pool.at < 6 * 3600e3) return pool;
  const since = new Date(Date.now() - 365 * DAY).toISOString(), now = new Date().toISOString();
  const rows = db.prepare(`SELECT s.player_id AS pid, MAX(CASE WHEN m.tour = 'wta' THEN 1 ELSE 0 END) AS w, COUNT(*) AS n,
      SUM(s.svc_pts) AS sp, SUM(s.svc_won) AS sw, SUM(s.ret_pts) AS rp, SUM(s.ret_won) AS rw, SUM(s.svc_games) AS sg, SUM(s.svc_held) AS sh,
      SUM(s.bp_faced) AS bf, SUM(s.bp_saved) AS bs, SUM(s.bp_had) AS bh, SUM(s.bp_conv) AS bc, SUM(s.tb_played) AS tp, SUM(s.tb_won) AS tw, SUM(o.svc_games) AS og
    FROM tennis_match_stats s JOIN tennis_matches m ON m.id = s.match_id
      LEFT JOIN tennis_match_stats o ON o.match_id = s.match_id AND o.player <> s.player
    WHERE m.scheduled_at >= ? AND m.scheduled_at < ? AND m.source <> 'archive' AND s.svc_pts > 0 AND s.player_id IS NOT NULL
    GROUP BY s.player_id`).all(since, now) as any[];
  // won / played (every finished singles match, with or without stats)
  const wl = new Map<number, [number, number]>();
  for (const r of db.prepare(`SELECT p1_id, p2_id, winner FROM tennis_matches WHERE scheduled_at >= ? AND scheduled_at < ? AND status = 'completed' AND winner IN (1, 2)
      AND source <> 'archive' AND COALESCE(draw, 'singles') = 'singles'`).all(since, now) as any[]) {
    for (const [pid, me] of [[r.p1_id, 1], [r.p2_id, 2]] as [number, number][]) {
      if (!pid) continue;
      const x = wl.get(pid) || [0, 0]; x[1]++; if (r.winner === me) x[0]++; wl.set(pid, x);
    }
  }
  const p = (a: number, b: number) => (b > 0 ? (100 * a) / b : null);
  const out = new Map<number, PoolRow>();
  for (const r of rows) {
    const x = wl.get(r.pid) || [0, 0];
    out.set(r.pid, {
      pid: r.pid, w: r.w, n: r.n, svc: p(r.sw, r.sp), ret: p(r.rw, r.rp), hold: p(r.sh, r.sg), brk: p(r.bc, r.og), bps: p(r.bs, r.bf), bpc: p(r.bc, r.bh),
      tb: p(r.tw, r.tp), tbn: r.tp || 0, win: x[1] >= 8 ? p(x[0], x[1]) : null, played: x[1]
    });
  }
  const sorted: Record<string, [number[], number[]]> = {};
  for (const ms of MEASURES) {
    const lists: [number[], number[]] = [[], []];
    for (const r of out.values()) if (r.n >= 8 && r[ms.id] !== null && (!ms.min || ms.min(r))) lists[r.w ? 1 : 0].push(r[ms.id] as number);
    lists[0].sort((a, b) => a - b); lists[1].sort((a, b) => a - b);
    sorted[ms.id] = lists;
  }
  pool = { at: Date.now(), rows: out, sorted };
  return pool;
}
/** strengths ≥ 8, weaknesses ≤ 3 (1–10 against the same tour); at least 8 matches with stats in 52 weeks */
function playerAnalysis(pid: number, women: boolean) {
  const P = playerPool();
  const me = P.rows.get(pid);
  if (!me || me.n < 8) return null;
  const g = women ? 1 : 0;
  const measures = MEASURES.map(ms => {
    const v = me[ms.id] as number | null;
    const list = P.sorted[ms.id][g];
    if (v === null || (ms.min && !ms.min(me)) || list.length < 20) return { id: ms.id, label: ms.label, value: v === null ? null : Math.round(v * 10) / 10, text: v === null ? null : `${Math.round(v)}%`, rank: null, of: null, score: null };
    let below = 0; for (const x of list) if (x < v) below++; else break;
    let above = 0; for (let i = list.length - 1; i >= 0 && list[i] > v; i--) above++;
    // ties count half (a value everyone shares is a 5, not a 1)
    const share = (below + (list.length - below - above) / 2) / list.length;
    const score = Math.max(1, Math.min(10, Math.ceil(share * 10)));
    return { id: ms.id, label: ms.label, value: Math.round(v * 10) / 10, text: `${Math.round(v)}%`, rank: above + 1, of: list.length, score };
  });
  const scored = measures.filter(m => m.score !== null);
  return {
    matches: me.n, measures,
    strengths: scored.filter(m => m.score! >= 8).sort((a, b) => b.score! - a.score!),
    weaknesses: scored.filter(m => m.score! <= 3).sort((a, b) => a.score! - b.score!)
  };
}
/** our record on a player: predictions saved before the start of their finished matches since the public start */
function playerRecord(pid: number) {
  const since = `${tennisRecordSince()}T00:00:00Z`;
  const rows = db.prepare(`SELECT p.p1, p.cat, m.winner, m.tour, m.tier, m.tournament, m.source, m.outcome, m.status FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
    WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id = ? UNION SELECT id FROM tennis_matches WHERE p2_id = ?)
      AND m.status = 'completed' AND m.winner IN (1, 2) AND p.made_at <= p.scheduled_at AND p.scheduled_at >= ? AND m.source <> 'archive'`).all(pid, pid, since) as any[];
  let games = 0, right = 0, strong = 0, strongRight = 0;
  for (const r of rows) {
    const cls = classify(r.tour, r.tier, r.tournament, r.source || 'live');
    if (!cls || cls.cat === 4 || /walkover|abandoned|unresolved|cancel/.test(String(r.outcome || ''))) continue;
    const hit = (r.p1 >= 0.5) === (r.winner === 1);
    games++; if (hit) right++;
    if (100 * Math.max(r.p1, 1 - r.p1) >= tennisStrongLine((['slam', 'atp', 'wta', 'challenger', 'itf'] as const)[cls.cat])) { strong++; if (hit) strongRight++; }
  }
  return { games, right, strong, strongRight };
}
/** Everything the player page shows. `full` = paid viewer (model tiles, the 1–10 scores, strengths / weaknesses). */
export function tennisPlayer(pid: number, full: boolean | ((rid: number) => boolean), paid: boolean, admin: boolean) {
  const p = db.prepare(`SELECT id, name, first_name, last_name, country, tour, hand, dob, height, ranking, ranking_points FROM tennis_players WHERE id = ?`).get(pid) as any;
  if (!p || !p.name) return null;
  const women = womenOf(pid);
  const now = new Date().toISOString();
  // ranking now and over the last 12 months (one point per table date)
  const trend = (db.prepare(`SELECT date, rank, points, tour FROM tennis_rankings WHERE player_id = ? AND date >= ? ORDER BY date`).all(pid, new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10)) as any[])
    .filter(r => r.tour === 'atp' || r.tour === 'wta');
  const latest = trend[trend.length - 1] || null;
  const rank = latest ? latest.rank : p.ranking ?? null;
  const points = latest ? latest.points : p.ranking_points ?? null;
  const recent = playedBefore(pid, now, 15);
  // matches to come (and live), with our predictions
  const next = (db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id = ? AND scheduled_at >= ? UNION SELECT id FROM tennis_matches WHERE p2_id = ? AND scheduled_at >= ?)
      AND ${MATCH_PUBLIC} ORDER BY m.scheduled_at LIMIT 10`).all(pid, new Date(Date.now() - DAY).toISOString(), pid, new Date(Date.now() - DAY).toISOString()) as any[])
    .map(shapeMatch).filter((m): m is TMatch => !!m && (m.state === 'upcoming' || m.state === 'live') && (m.tour !== 'itf' || admin));
  const upcoming = withTennisPredictions(next.slice(0, 4), full);
  // stoppages of the last 12 months: medical timeouts and the like (tennis_stoppages) + retirements from the results
  const stops = (db.prepare(`SELECT s.kind, s.at, s.match_id, m.tournament FROM tennis_stoppages s LEFT JOIN tennis_matches m ON m.id = s.match_id
      WHERE s.player_id = ? AND s.at >= ? ORDER BY s.at DESC LIMIT 20`).all(pid, new Date(Date.now() - 365 * DAY).toISOString()) as any[])
    .map(s => ({ kind: /medical|injur|timeout/i.test(s.kind) ? 'medical' : /retir/i.test(s.kind) ? 'retired' : 'other', at: s.at, matchId: s.match_id, tournament: s.tournament || null, link: pubPath(`/tennis/match/${s.match_id}`) }));
  const retired = playedBefore(pid, now, 60, new Date(Date.now() - 365 * DAY).toISOString()).filter(x => x.retired && !x.won)
    .map(x => ({ kind: 'retired', at: x.start, matchId: x.id, tournament: x.tournament, link: pubPath(`/tennis/match/${x.id}`) }));
  const seen = new Set(stops.map(s => `${s.matchId}${s.kind}`));
  const stoppages = [...stops, ...retired.filter(r => !seen.has(`${r.matchId}retired`))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  const year = new Date().getUTCFullYear();
  const thisYear = playedBefore(pid, now, 200, `${year}-01-01`);
  const age = p.dob ? Math.floor((Date.now() - Date.parse(p.dob)) / (365.2425 * DAY)) : null;
  const analysis = playerAnalysis(pid, women);
  return {
    player: { id: p.id, name: fullName(p.name, p.first_name, p.last_name), country: p.country || null, countryName: countryName(p.country), hand: p.hand || null, dob: p.dob || null, age: age && age > 10 && age < 60 ? age : null, height: p.height || null, tour: women ? 'wta' : 'atp', women, rank, points,
      // fix211: the photo (Wikidata / Commons) with its credit, or null (initials + flag)
      photo: photoUrl('tennis', p.id) }, // fix241: official photos only, no credit line
    rankTrend: trend.map(r => ({ date: r.date, rank: r.rank })),
    season: { year, won: thisYear.filter(x => x.won).length, lost: thisYear.filter(x => !x.won).length },
    form: recent.slice(0, 10).reverse().map(x => (x.won ? 'W' : 'L')),
    model: paid ? tennisPlayerModel(pid, women) : null, modelLocked: !paid,
    analysis: !analysis ? null : paid ? analysis : { locked: true, matches: analysis.matches, notesCount: analysis.strengths.length + analysis.weaknesses.length, measures: [], strengths: [], weaknesses: [] },
    recent, upcoming, stoppages, record: playerRecord(pid),
    around: rankingAround(pid, women ? 'wta' : 'atp'), titles: titlesOf(pid)
  };
}

/* ---------- rankings (fix193b) ---------- */

/** ATP or WTA singles rankings: the latest table, top 200, with the move against the table a week or more before */
export function tennisRankings(tour: 'atp' | 'wta', n = 200) {
  const d = (db.prepare(`SELECT MAX(date) AS d FROM tennis_rankings WHERE tour = ?`).get(tour) as any)?.d;
  if (!d) return { tour, date: null, previous: null, rows: [] as any[] };
  const prev = (db.prepare(`SELECT MAX(date) AS d FROM tennis_rankings WHERE tour = ? AND date <= ?`).get(tour, new Date(Date.parse(d) - 6 * DAY).toISOString().slice(0, 10)) as any)?.d || null;
  const rows = db.prepare(`SELECT r.rank, r.player_id, r.player_name, r.points, p.country, p.name AS pname,
      ${prev ? `(SELECT o.rank FROM tennis_rankings o WHERE o.tour = r.tour AND o.date = ? AND o.player_id = r.player_id LIMIT 1)` : 'NULL'} AS prev
    FROM tennis_rankings r LEFT JOIN tennis_players p ON p.id = r.player_id WHERE r.tour = ? AND r.date = ? ORDER BY r.rank LIMIT ?`)
    .all(...(prev ? [prev] : []), tour, d, n) as any[];
  return {
    tour, date: d, previous: prev,
    rows: rows.map(r => ({ rank: r.rank, id: r.player_id || null, name: r.pname || r.player_name || '', country: r.country || null, points: r.points ?? null, move: r.prev ? r.prev - r.rank : null, isNew: !!prev && !r.prev, photo: photoUrl('tennis', r.player_id) }))
  };
}

/* ---------- search (fix193b): players, tournaments, coming matches — the same shape as basketball / NFL ---------- */

export function tennisSearch(q: string, admin: boolean) {
  const term = q.replace(/[%_]/g, '').trim();
  if (term.length < 2) return { teams: [], players: [], leagues: [], games: [] };
  const like = `%${term}%`, start = `${term}%`, word = `% ${term}%`;
  const players = (db.prepare(`SELECT p.id, p.name, p.country, COALESCE(${rankSql('p')}, p.ranking) AS rank, p.tour FROM tennis_players p
    WHERE p.name LIKE ? AND COALESCE(p.tour, '') <> 'itf' ORDER BY (p.name LIKE ? OR p.name LIKE ?) DESC, (rank IS NULL), rank, p.name LIMIT 8`).all(like, start, word) as any[])
    .map(p => ({ id: p.id, name: p.name, team: p.country || '', teamLogo: null, photo: photoUrl('tennis', p.id), league: p.tour === 'wta' ? 'WTA' : 'ATP', position: p.rank ? `#${p.rank}` : null }));
  const seen = new Set<string>();
  const leagues: { code: string; name: string; country: string; logo: null }[] = [];
  for (const r of db.prepare(`SELECT tournament, tour, tier, MAX(scheduled_at) AS at FROM tennis_matches WHERE tournament LIKE ? AND source <> 'archive' AND scheduled_at >= ?
      GROUP BY tournament, tour ORDER BY at DESC LIMIT 40`).all(like, new Date(Date.now() - 400 * DAY).toISOString()) as any[]) {
    const cls = classify(r.tour, r.tier, r.tournament, 'live');
    if (!cls || (cls.cat === 4 && !admin)) continue;
    const key = slugOf(r.tour, r.tier, r.tournament);
    if (seen.has(key)) continue;
    seen.add(key);
    leagues.push({ code: key, name: String(r.tournament).replace(/\s*[-–]\s*(qualification|qualifying).*$/i, '').trim(), country: tierLabel(r.tier, r.tour), logo: null });
    if (leagues.length >= 5) break;
  }
  const games = (db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE (m.p1_name LIKE ? OR m.p2_name LIKE ?) AND m.scheduled_at >= ? AND m.scheduled_at < ? AND ${MATCH_LISTED} ORDER BY m.scheduled_at LIMIT 30`)
    .all(like, like, new Date(Date.now() - 5 * 3600e3).toISOString(), new Date(Date.now() + 7 * DAY).toISOString()) as any[])
    .map(shapeMatch).filter((m): m is TMatch => !!m && (m.tour !== 'itf' || admin) && m.state !== 'off').slice(0, 6)
    .map(m => ({ id: m.id, kickoff: m.start, status: m.state === 'live' ? 'LIVE' : 'NS', league: m.tournament.name, home: m.home.name, away: m.away.name }));
  return { teams: [], players, leagues, games };
}

/* ---------- accuracy page (fix193c; admins until TENNIS_PUBLIC=1) ---------- */

/**
 * The shared Accuracy page's winner shape: picks right overall, by tour and by surface (the "leagues" table), strong
 * picks, calibration, by confidence; for tennis's two extra numbers the set score (our most likely one, exact) and
 * how far the median total games was off. Predictions saved before the start, finished matches, from the start day.
 */
export function tennisAccuracy(days = 3650) {
  const rows = tennisRecordRows(days, null);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const hit = (x: { r: any; m: TMatch }) => (x.r.p1 >= 0.5) === (x.m.winner === 1);
  const strong = (x: { r: any; m: TMatch }) => 100 * Math.max(x.r.p1, 1 - x.r.p1) >= tennisStrongLine(x.m.cat);
  const extra = (x: { r: any; m: TMatch }) => {
    // p_sets / p_games: the saved prediction's (m.sets / m.games are the match score)
    const sets = parse(x.r.p_sets) as Record<string, number> | null, games = parse(x.r.p_games);
    const sc = x.m.score;
    // retirements end early: no set score / games check for them
    const full = sc && !/retired/.test(String(x.m.outcome || ''));
    const top = sets ? Object.entries(sets).sort((a, b) => b[1] - a[1])[0]?.[0] : null;
    const setHit = full && top ? top === `${sc!.won[0]}-${sc!.won[1]}` : null;
    const total = full ? sc!.sets.reduce((s, v) => s + v[0] + v[1], 0) : null;
    const gamesOff = total !== null && games && typeof games.median === 'number' ? Math.abs(games.median - total) : null;
    return { setHit, gamesOff };
  };
  const ex = new Map(rows.map(x => [x.m.id, extra(x)]));
  const scoreOf = (list: typeof rows) => {
    const s = list.map(x => ex.get(x.m.id)!).filter(e => e.setHit !== null);
    const g = list.map(x => ex.get(x.m.id)!.gamesOff).filter((v): v is number => v !== null);
    return { marginOff: s.length ? pct(s.filter(e => e.setHit).length, s.length) : null, totalOff: g.length ? r1(g.reduce((a, b) => a + b, 0) / g.length) : null, scoreN: s.length };
  };
  const rec = (list: typeof rows) => {
    const st = list.filter(strong);
    const h = list.filter(hit).length, sh = st.filter(hit).length;
    return { n: list.length, hits: h, hitRate: pct(h, list.length), strongN: st.length, strongHits: sh, strongHitRate: pct(sh, st.length), brier: winnerBrier(list.map(x => ({ pHome: x.r.p1, homeWon: x.m.winner === 1 }))) };
  };
  const groups = new Map<string, typeof rows>();
  const add = (k: string, x: (typeof rows)[number]) => groups.set(k, [...(groups.get(k) || []), x]);
  for (const x of rows) {
    add(x.m.cat === 'slam' ? 'slam' : x.m.tour, x);
    if (x.m.tournament.surface) add(`s:${x.m.tournament.surface}`, x);
  }
  const ORDER = ['slam', 'atp', 'wta', 'challenger', 's:hard', 's:clay', 's:grass'];
  const now = Date.now();
  const pending = withTennisPredictions(tennisMatchesBetween(new Date(now - 5 * 3600e3).toISOString(), new Date(now + 36 * 3600e3).toISOString(), 'all', false, 2000), true)
    .filter(m => m.prediction && !m.prediction.locked && (m.state === 'upcoming' || m.state === 'live')).slice(0, 60)
    .map(m => ({ gameId: m.id, code: m.cat === 'slam' ? 'slam' : m.tour, kickoff: m.start, home: m.home.name, away: m.away.name, homeLogo: null, awayLogo: null, status: m.status,
      live: m.state === 'live', score: m.score ? m.score.won : null, pick: m.prediction.pick, preseason: false }));
  return {
    pending,
    since: rows.length ? rows[rows.length - 1].m.start : null,
    total: rec(rows),
    bands: winnerBands(rows.map(x => ({ p: Math.max(x.r.p1, 1 - x.r.p1), hit: hit(x) }))),
    calibration: winnerCalibration(rows.map(x => ({ pHome: x.r.p1, homeWon: x.m.winner === 1 }))),
    byConfidence: winnerByConfidence(rows.map(x => ({ p: Math.max(x.r.p1, 1 - x.r.p1), hit: hit(x) }))),
    leagues: [...groups.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0])).map(([code, list]) => ({ code, ...rec(list), ...scoreOf(list) })),
    scores: scoreOf(rows),
    recent: rows.slice(0, 50).map(x => ({
      gameId: x.m.id, code: x.m.cat === 'slam' ? 'slam' : x.m.tour, kickoff: x.m.start, home: x.m.home.name, away: x.m.away.name, homeLogo: null, awayLogo: null,
      score: x.m.score ? x.m.score.won : [0, 0], pick: x.r.p1 >= 0.5 ? 'H' : 'A', pHome: x.r.p1, hit: hit(x)
    }))
  };
}

/* ---------- match preview text (fix193c): plain English, no pick, no %, the same text search engines get ---------- */

const SURF_WORD: Record<string, string> = { hard: 'hard court', clay: 'clay', grass: 'grass', carpet: 'carpet' };
/** "the round of 32", "the quarter-final", "qualifying round 2", "round 2" */
const ROUND_PHRASE = (code: string) => {
  const q = /^Q(\d)$/.exec(code), n = /^R(\d)$/.exec(code);
  return q ? `qualifying round ${q[1]}` : code === 'Q' ? 'qualifying' : n ? `round ${n[1]}` : `the ${String(roundEn(code)).toLowerCase()}`;
};
/** "the Brussels Open" (a name that already starts with "The" keeps one) */
const theName = (n: string) => (/^the\s/i.test(n) ? n : `the ${n}`);
export function tennisWriteup(d: NonNullable<ReturnType<typeof tennisMatch>>): string | null {
  const m = d.match;
  if (!m.home.name || !m.away.name) return null;
  const A = m.home.name, B = m.away.name, sa = m.home.short, sb = m.away.short;
  const out: string[] = [];
  const surf = m.tournament.surface ? SURF_WORD[m.tournament.surface] || m.tournament.surface : null;
  // fix195: "… meet in the round of 32 at the Brussels Open (ATP 250, indoor hard)." — the round from its code, never the provider's text
  const inRound = m.roundCode ? ` in ${ROUND_PHRASE(m.roundCode)}` : '';
  const detail = [tierLabel(m.tournament.tier, m.tour), surf ? `${m.tournament.indoor ? 'indoor ' : ''}${surf === 'hard court' ? 'hard' : surf}` : null].filter(Boolean).join(', ');
  out.push(`${A}${m.home.rank ? ` (No. ${m.home.rank})` : ''} and ${B}${m.away.rank ? ` (No. ${m.away.rank})` : ''} meet${inRound} at ${theName(m.tournament.name)}${detail ? ` (${detail})` : ''}, best of ${m.bestOf} sets.`);
  const form = (list: Played[], who: string) => {
    if (list.length < 3) return null;
    const w = list.filter(x => x.won).length;
    return `${who} has won ${w} of ${list.length} recent matches`;
  };
  const fa = form(d.form.home, sa), fb = form(d.form.away, sb);
  if (fa && fb) out.push(`${fa}; ${fb}.`);
  else if (fa || fb) out.push(`${fa || fb}.`);
  if (m.tournament.surface) {
    const on = (list: Played[]) => { const s = list.filter(x => x.surface === m.tournament.surface); return s.length >= 3 ? `${s.filter(x => x.won).length}–${s.length - s.filter(x => x.won).length}` : null; };
    const ha = on(d.form.home), ha2 = on(d.form.away);
    if (ha && ha2) out.push(`On ${surf} in those matches: ${sa} ${ha}, ${sb} ${ha2}.`);
  }
  const sr = (x: any) => x?.last52;
  const s1 = sr(d.stats.home), s2 = sr(d.stats.away);
  if (s1?.holdPct != null && s2?.holdPct != null && s1.matches >= 5 && s2.matches >= 5)
    out.push(`Over the last 52 weeks ${sa} has held serve in ${Math.round(s1.holdPct)} of 100 service games and ${sb} in ${Math.round(s2.holdPct)}.`);
  const h = d.h2h;
  if (h.list.length) {
    const last = h.list[0];
    out.push(`They have met ${h.list.length === 1 ? 'once' : `${h.list.length} times`} in our data (${sa} ${h.won[0]}, ${sb} ${h.won[1]}); the last meeting went to ${last.winner === 1 ? last.home.short : last.away.short} at ${theName(last.tournament.name)}.`);
  } else out.push('It is their first meeting in our data.');
  const rest = (r: any, who: string) => (r?.yesterday && (r.yesterday.sets >= 3 || (r.yesterday.minutes || 0) >= 150) ? `${who} played a long match ${r.yesterday.hoursAgo <= 20 ? 'earlier today' : 'yesterday'}${r.yesterday.minutes ? ` (${r.yesterday.minutes} minutes)` : ''}.` : null);
  for (const x of [rest(d.schedule.home, sa), rest(d.schedule.away, sb)]) if (x) out.push(x);
  return out.join(' ');
}

/* ---------- player page extras (fix193c): the ranking around them, titles in our data ---------- */

export function rankingAround(pid: number, tour: 'atp' | 'wta', span = 3) {
  const d = (db.prepare(`SELECT MAX(date) AS d FROM tennis_rankings WHERE tour = ?`).get(tour) as any)?.d;
  if (!d) return null;
  const me = db.prepare(`SELECT rank FROM tennis_rankings WHERE tour = ? AND date = ? AND player_id = ?`).get(tour, d, pid) as any;
  if (!me) return null;
  const rows = db.prepare(`SELECT r.rank, r.player_id, r.player_name, r.points, p.country, p.name AS pname FROM tennis_rankings r LEFT JOIN tennis_players p ON p.id = r.player_id
    WHERE r.tour = ? AND r.date = ? AND r.rank BETWEEN ? AND ? ORDER BY r.rank`).all(tour, d, Math.max(1, me.rank - span), me.rank + span) as any[];
  return { tour, date: d, rows: rows.map(r => ({ rank: r.rank, id: r.player_id || null, name: r.pname || r.player_name || '', country: r.country || null, points: r.points ?? null, me: r.player_id === pid })) };
}
/** finals won in our data (singles, main draw), newest first */
export function titlesOf(pid: number) {
  const rows = db.prepare(`SELECT m.id, m.scheduled_at, m.tournament, m.tour, m.tier, m.surface, m.round, m.round_code, m.p1_id, m.winner FROM tennis_matches m
    WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id = ? UNION SELECT id FROM tennis_matches WHERE p2_id = ?)
      AND m.status = 'completed' AND m.winner IN (1, 2) AND COALESCE(m.is_qualifying, 0) = 0 AND COALESCE(m.draw, 'singles') = 'singles' AND m.source <> 'archive'
    ORDER BY m.scheduled_at DESC LIMIT 2000`).all(pid, pid) as any[];
  return rows.filter(r => normRound(r.round_code, r.round, false) === 'F' && (r.winner === 1) === (r.p1_id === pid))
    .map(r => ({ matchId: r.id, year: Number(String(r.scheduled_at).slice(0, 4)), tournament: r.tournament, key: slugOf(r.tour, r.tier, r.tournament || ''), tier: tierLabel(r.tier, r.tour), surface: r.surface ? String(r.surface).toLowerCase() : null }))
    .slice(0, 30);
}

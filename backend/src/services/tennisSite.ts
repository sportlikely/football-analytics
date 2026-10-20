/**
 * Tennis site (fix193) — the public pages' data, built exactly like basketball's / NFL's: the same game shape (two
 * sides "home" / "away" = player 1 / player 2), the same prediction fields (pHome / pAway / pick 'H' | 'A', locked for
 * free and signed-out viewers until the match is over), the same record bands. Data: services/tennis.ts tables;
 * predictions: services/tennisModel.ts (tennis_predictions, saved until the start). Singles only. Tours shown: ATP,
 * WTA, Challenger, Grand Slams (ITF stays admin-only). Market prices (tennis_prices) never reach this file.
 * Admin-only until TENNIS_PUBLIC=1 (the routes in index.ts check). Every read is indexed or bounded by date.
 */
import { db } from '../db';
import { tennisModelInternals, tennisStrongLine, tennisPlayerModel, tennisLiveChance, tennisServeChances, tennisRecordSince, TENNIS_MODEL } from './tennisModel';
import { tournamentKey, setTennisLiveHook } from './tennis';
import { winnerBands, winnerByConfidence } from '../utils/winnerBands';

export const tennisPublic = () => process.env.TENNIS_PUBLIC === '1';
/** Reveal / unlock ids of tennis matches (their own negative range: football > 0, basketball -id, NFL -(2e9 + id)) */
export const tennisRid = (id: number) => -(4e9 + id);
const DAY = 86400000;
const { classify } = tennisModelInternals;

/* ---------- shapes ---------- */

export type TennisTour = 'atp' | 'wta' | 'challenger' | 'itf';
export interface TSide { id: number | null; name: string; country: string | null; rank: number | null; logo: null }
export interface TScore { sets: [number, number][]; won: [number, number]; points: [string, string] | null; server: 1 | 2 | null }
export interface TMatch {
  id: number; tour: TennisTour; cat: string; women: boolean
  tournament: { key: string; name: string; tier: string | null; level: string; surface: string | null; indoor: boolean | null; city: string | null; country: string | null }
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
  m.scheduled_at, m.status, m.event_status, m.p1_id, m.p1_name, m.p2_id, m.p2_name, m.sets, m.games, m.winner, m.outcome, m.extra, m.source,
  p1.country AS c1, p2.country AS c2, COALESCE(${rankSql('p1')}, p1.ranking) AS r1, COALESCE(${rankSql('p2')}, p2.ranking) AS r2, p1.tour AS t1, p2.tour AS t2,
  t.city AS tcity, t.country AS tcountry, t.indoor AS tindoor`;
export const MATCH_FROM = `FROM tennis_matches m LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id
  LEFT JOIN tennis_tournaments t ON t.id = m.tournament_id`;
/** public rows: singles, our own feed (the archive has other player ids), with both players */
export const MATCH_PUBLIC = `COALESCE(m.draw, 'singles') = 'singles' AND m.source <> 'archive' AND m.p1_name IS NOT NULL AND m.p2_name IS NOT NULL
  AND m.p1_name NOT IN ('TBD', 'TBA', 'Qualifier') AND m.p2_name NOT IN ('TBD', 'TBA', 'Qualifier')`;

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
/** a row of MATCH_COLS → TMatch (null = left out: doubles, juniors, team events, exhibitions) */
export function shapeMatch(r: any): TMatch | null {
  const cls = classify(r.tour, r.tier, r.tournament, r.source || 'live');
  if (!cls) return null;
  const tour: TennisTour = cls.cat === 3 ? 'challenger' : cls.cat === 4 ? 'itf' : cls.gen === 1 ? 'wta' : 'atp';
  const state = stateOf(r.status, r.outcome);
  const name = String(r.tournament || '').trim() || 'Tournament';
  return {
    id: r.id, tour, cat: (['slam', 'atp', 'wta', 'challenger', 'itf'] as const)[cls.cat], women: cls.gen === 1,
    tournament: {
      key: tournamentSlug(r.tour, name), name: name.replace(/\s*[-–]\s*(qualification|qualifying).*$/i, '').replace(/\s+\(\w[^)]*\)\s*$/, '').trim() || name,
      tier: r.tier || null, level: LEVEL[cls.lvl] || '', surface: r.surface ? String(r.surface).toLowerCase() : null,
      indoor: r.indoor == null ? (r.tindoor == null ? null : !!r.tindoor) : !!r.indoor, city: r.tcity || null, country: r.tcountry || null
    },
    round: r.round || r.round_code || null, roundCode: r.round_code || null, qualifying: !!r.is_qualifying, bestOf: r.best_of === 5 ? 5 : 3,
    start: r.scheduled_at, status: r.status || 'upcoming', state,
    home: { id: r.p1_id ?? null, name: r.p1_name, country: r.c1 || null, rank: r.r1 ?? null, logo: null },
    away: { id: r.p2_id ?? null, name: r.p2_name, country: r.c2 || null, rank: r.r2 ?? null, logo: null },
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
    ...(full ? { why: Array.isArray(s.why?.lines) ? s.why.lines : [], numbers: s.why?.numbers ? { eloSurface: s.why.numbers.eloSurface, eloOverall: s.why.numbers.eloOverall, servePoint: s.why.numbers.servePoint } : null } : {})
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
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.scheduled_at >= ? AND m.scheduled_at < ? AND ${MATCH_PUBLIC} ${ORDER_START} LIMIT ?`).all(from, to, limit) as any[];
  return rows.map(shapeMatch).filter((m): m is TMatch => !!m && tourOk(m, tour, admin));
}
export function tennisLive(tour: string | null, admin: boolean): TMatch[] {
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.status IN ('live', 'in_progress', 'interrupted', 'suspended') AND m.scheduled_at >= ? AND ${MATCH_PUBLIC} ${ORDER_START} LIMIT 400`)
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
function sampleLive(ids: number[]) {
  if (!ids.length) return;
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
  const saved = savedFor(ids);
  const put = db.prepare(`INSERT OR REPLACE INTO tennis_live_samples (match_id, t, p, s1, s2) VALUES (?, ?, ?, ?, ?)`);
  for (const r of rows) {
    const m = shapeMatch(r), s = saved.get(r.id);
    if (!m || !s || m.state !== 'live' || !m.score) continue;
    const now = liveNow(m, s);
    if (!now) continue;
    const last = m.score.sets[m.score.sets.length - 1];
    const done = m.score.won[0] + m.score.won[1];
    const t = done + (setOver(last[0], last[1]) ? 0 : Math.min(0.99, (last[0] + last[1]) / 12));
    put.run(r.id, Math.round(t * 1000) / 1000, now.pHome, m.score.won[0], m.score.won[1]);
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
interface Played { id: number; start: string; tournament: string; surface: string | null; round: string | null; opponent: { id: number | null; name: string; country: string | null }; won: boolean; score: string; sets: number; minutes: number | null; retired: boolean }
/** a player's finished matches before `before`, newest first */
export function playedBefore(pid: number | null, before: string, limit = 10, since?: string): Played[] {
  if (!pid) return [];
  const rows = db.prepare(`SELECT m.id, m.scheduled_at, m.tournament, m.surface, m.round, m.p1_id, m.p1_name, m.p2_id, m.p2_name, m.winner, m.games, m.outcome, m.extra,
      p1.country AS c1, p2.country AS c2, (SELECT MAX(s.duration_s) FROM tennis_match_stats s WHERE s.match_id = m.id) AS dur
    FROM tennis_matches m LEFT JOIN tennis_players p1 ON p1.id = m.p1_id LEFT JOIN tennis_players p2 ON p2.id = m.p2_id
    WHERE m.id IN (SELECT id FROM tennis_matches WHERE p1_id = ? AND scheduled_at < ? AND scheduled_at >= ? UNION SELECT id FROM tennis_matches WHERE p2_id = ? AND scheduled_at < ? AND scheduled_at >= ?)
      AND m.status = 'completed' AND m.winner IN (1, 2) AND m.source <> 'archive' AND COALESCE(m.draw, 'singles') = 'singles'
    ORDER BY m.scheduled_at DESC LIMIT ?`).all(pid, before, since || '2000-01-01', pid, before, since || '2000-01-01', limit) as any[];
  return rows.map(r => {
    const me = r.p1_id === pid ? 1 : 2;
    let g: any = null; try { g = r.games ? JSON.parse(r.games) : null; } catch { g = null; }
    const sets = Array.isArray(g?.[0]) ? g[0].map((x: any, i: number) => (me === 1 ? `${x}-${g[1][i]}` : `${g[1][i]}-${x}`)) : [];
    const ex = parse(r.extra);
    return {
      id: r.id, start: r.scheduled_at, tournament: r.tournament, surface: r.surface ? String(r.surface).toLowerCase() : null, round: r.round,
      opponent: me === 1 ? { id: r.p2_id, name: r.p2_name, country: r.c2 || null } : { id: r.p1_id, name: r.p1_name, country: r.c1 || null },
      won: r.winner === me, score: sets.join(' '), sets: sets.length, minutes: r.dur ? Math.round(r.dur / 60) : ex?.minutes ? Math.round(ex.minutes) : null,
      retired: /retired/.test(String(r.outcome || ''))
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
const ROUND_ORDER: Record<string, number> = { Q1: 0, Q2: 1, Q3: 2, Q4: 3, Q: 3, R128: 5, R64: 6, R32: 7, R16: 8, RR: 8, QF: 9, SF: 10, F: 12 };
const roundCodeOf = (m: TMatch) => {
  const c = String(m.roundCode || '').toUpperCase();
  if (c && c in ROUND_ORDER) return c;
  const r = String(m.round || '').toLowerCase();
  if (/qualif/.test(r)) return (r.match(/\d/) ? `Q${r.match(/\d/)![0]}` : 'Q');
  if (/^final$|^the final$/.test(r)) return 'F';
  if (/semi/.test(r)) return 'SF';
  if (/quarter/.test(r)) return 'QF';
  if (/round robin|group/.test(r)) return 'RR';
  const n = r.match(/(?:round of|r)\s*(\d+)/); if (n) return `R${n[1]}`;
  const k = r.match(/(\d)(?:st|nd|rd|th)\s+round/); if (k) return `ROUND${k[1]}`;
  return c || 'R';
};
const roundRank = (code: string) => (code in ROUND_ORDER ? ROUND_ORDER[code] : /^ROUND(\d)/.test(code) ? 4 + Number(code.slice(5)) : 4);
/** the draw of a tournament edition: its matches grouped by round (main draw last rounds last), from our matches */
export function tournamentDraw(key: string, around: string) {
  const T = Date.parse(around);
  const rows = db.prepare(`SELECT ${MATCH_COLS} ${MATCH_FROM} WHERE m.scheduled_at >= ? AND m.scheduled_at < ? AND ${MATCH_PUBLIC} ORDER BY m.scheduled_at LIMIT 3000`)
    .all(new Date(T - 16 * DAY).toISOString(), new Date(T + 16 * DAY).toISOString()) as any[];
  const list = rows.map(shapeMatch).filter((m): m is TMatch => !!m && m.tournament.key === key);
  const rounds = new Map<string, TMatch[]>();
  for (const m of list) { const c = (m.qualifying ? 'Q:' : '') + roundCodeOf(m); rounds.set(c, [...(rounds.get(c) || []), m]); }
  return [...rounds.entries()]
    .map(([code, ms]) => ({ code: code.replace(/^Q:/, ''), qualifying: code.startsWith('Q:') || /^Q/.test(code.replace(/^Q:/, '')), name: ms[0].round || code, matches: ms }))
    .sort((a, b) => Number(a.qualifying) - Number(b.qualifying) === 0 ? roundRank(a.code) - roundRank(b.code) : Number(b.qualifying) - Number(a.qualifying));
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
  const rows = db.prepare(`SELECT p.match_id, p.p1, p.cat, p.made_at, p.scheduled_at, p.sets, p.games, ${MATCH_COLS} FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
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
    for (const r of db.prepare(`SELECT DISTINCT tournament, tour FROM tennis_matches WHERE tournament IS NOT NULL AND scheduled_at >= ?`).all(new Date(Date.now() - 12 * 365 * DAY).toISOString()) as any[]) {
      const k = tournamentSlug(r.tour, r.tournament);
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
  const meta = db.prepare(`SELECT * FROM tennis_tournaments WHERE name IN (${q}) ORDER BY start_date DESC LIMIT 1`).get(...names) as any;
  const starts = all.map(m => m.start).sort();
  // past champions: the final of each year (our feed and the 2015–2022 archive, matched by name)
  const finals = db.prepare(`SELECT scheduled_at, round, round_code, p1_name, p2_name, p1_id, p2_id, winner, games, source, is_qualifying FROM tennis_matches
    WHERE tournament IN (${q}) AND status = 'completed' AND winner IN (1, 2) AND COALESCE(is_qualifying, 0) = 0 ORDER BY scheduled_at DESC LIMIT 4000`).all(...names) as any[];
  const champions = new Map<string, any>();
  for (const f of finals) {
    if (!/^(f|final|the final)$/i.test(String(f.round_code || f.round || '').trim())) continue;
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
    surface: first.tournament.surface, indoor: first.tournament.indoor, city: meta?.city || first.tournament.city || null, country: meta?.country || first.tournament.country || null,
    start: meta?.start_date || starts[0] || null, end: meta?.end_date || starts[starts.length - 1] || null,
    draw, champions: [...champions.values()].slice(0, 12),
    record: { n: recRows.length, right: hits, pct: recRows.length ? Math.round((1000 * hits) / recRows.length) / 10 : null }
  };
}

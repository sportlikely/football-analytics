/**
 * NFL + college live win chance (fix174): the home team's win chance, a projected final score and the swing chart.
 *
 * From the prediction saved before kick-off and the live state:
 *  - r = share of game time still to play (quarter + clock; overtime counts as one more quarter, 1/4);
 *  - m = current margin (home − away), s = predicted margin (nfl-v1 / nfl-v2 / ncaa-v1);
 *  - p(home) = Φ((m + s·r) / (σ·√r)), σ = 13.5 points in the NFL, 16 in college; at r = 0 the result.
 * Projected final score = current score + the predicted points still to come (predicted total × r), split by each
 * team's share of the predicted points.
 * Swing chart: every live tick (30 s) stores one sample {t = share played, p} per game (table nfl_live_samples, kept
 * for the season), so a finished game shows its whole curve.
 */
import { db } from '../db';
import { setNflStoredHook } from './nfl';
import { savedNflPrediction } from './nflModel';
import { normCdf } from './bbModel';
import logger from '../utils/logger';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_live_samples (game_id INTEGER NOT NULL, t REAL NOT NULL, p REAL NOT NULL, hs INTEGER, as_ INTEGER, PRIMARY KEY (game_id, t))`);

export const NFL_SIGMA: Record<1 | 2, number> = { 1: 13.5, 2: 16 };
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

/** Minutes left in the quarter from the provider's clock ("08:42", "8:42", "8" or a number); null = unknown. */
export function clockMinutes(clock: unknown): number | null {
  if (clock === null || clock === undefined || clock === '') return null;
  const s = String(clock).trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return Math.min(15, Number(m[1]) + Number(m[2]) / 60);
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(15, Math.max(0, n)) : null;
}

/** Share of game time still to play (0..1, OT on top of regulation = 1/4), null when the status is not a live one. */
export function nflShareLeft(status: string | null, clock: unknown): number | null {
  const q = QUARTERS.indexOf(String(status || ''));
  const left = clockMinutes(clock);
  if (q >= 0) return ((3 - q) * 15 + (left ?? 7.5)) / 60;
  if (status === 'HT') return 0.5;
  if (status === 'OT') return (0.25 * (left ?? 7.5)) / 15;
  return null;
}

export interface NflLiveNow { pHome: number; pAway: number; score: { home: number; away: number }; total: number; left: number }

/** The live block from the saved prediction and the score now; r = share left. */
export function nflLiveProbs(pred: { margin: number; homePts: number; awayPts: number }, league: 1 | 2, hs: number, as_: number, r: number): NflLiveNow {
  const rem = Math.min(1, Math.max(0, r));
  const m = hs - as_;
  let p: number;
  if (rem <= 0) p = m > 0 ? 1 : m < 0 ? 0 : 0.5;
  else p = normCdf((m + pred.margin * rem) / (NFL_SIGMA[league] * Math.sqrt(rem)));
  p = Math.min(0.999, Math.max(0.001, p));
  const tot = Math.max(1, (pred.homePts || 0) + (pred.awayPts || 0));
  const restPts = tot * rem, shareH = (pred.homePts || tot / 2) / tot;
  const home = Math.round(hs + restPts * shareH), away = Math.round(as_ + restPts * (1 - shareH));
  const ph = Math.round(p * 1000) / 10;
  return { pHome: ph, pAway: Math.round((100 - ph) * 10) / 10, score: { home, away }, total: home + away, left: Math.round(rem * 1000) / 1000 };
}

interface Row { game_id: number; league: number; status: string | null; clock: string | null; home_pts: number | null; away_pts: number | null }
const rowOf = (id: number): Row | undefined => db.prepare(`SELECT game_id, league, status, clock, home_pts, away_pts FROM nfl_games WHERE game_id = ?`).get(id) as any;

/** Live win chance now (null when the game is not on or has no saved prediction). */
export function nflLiveNow(id: number): NflLiveNow | null {
  const g = rowOf(id);
  if (!g) return null;
  const r = nflShareLeft(g.status, g.clock);
  if (r === null) return null;
  const pred = savedNflPrediction(id);
  if (!pred) return null;
  return nflLiveProbs(pred, g.league === 2 ? 2 : 1, Number(g.home_pts) || 0, Number(g.away_pts) || 0, r);
}

/** The swing chart: kick-off (the saved prediction), every stored sample, the result at the end. t = share played. */
export function nflLiveCurve(id: number): { t: number; p: number; hs: number | null; as: number | null }[] {
  const pred = savedNflPrediction(id);
  if (!pred) return [];
  const rows = db.prepare(`SELECT t, p, hs, as_ FROM nfl_live_samples WHERE game_id = ? ORDER BY t`).all(id) as any[];
  if (!rows.length) return [];
  const out = [{ t: 0, p: pred.pHome, hs: 0, as: 0 }, ...rows.map(r => ({ t: r.t, p: r.p, hs: r.hs, as: r.as_ }))];
  return out;
}

/** One sample per game and live tick (called after every store of NFL games). */
function sample(ids: number[]) {
  const put = db.prepare(`INSERT OR REPLACE INTO nfl_live_samples (game_id, t, p, hs, as_) VALUES (?, ?, ?, ?, ?)`);
  for (const id of ids) {
    const g = rowOf(id);
    if (!g) continue;
    const done = g.status === 'FT' || g.status === 'AOT';
    const r = done ? 0 : nflShareLeft(g.status, g.clock);
    if (r === null) continue;
    // a finished game gets its last point once, and only when it was sampled live (no made-up curves)
    if (done && !(db.prepare(`SELECT 1 FROM nfl_live_samples WHERE game_id = ? LIMIT 1`).get(id))) continue;
    const pred = savedNflPrediction(id);
    if (!pred) continue;
    const now = nflLiveProbs(pred, g.league === 2 ? 2 : 1, Number(g.home_pts) || 0, Number(g.away_pts) || 0, r);
    // t: share of regulation played (OT goes past 1 a little); rounded so a tick at the same moment replaces the last
    const t = done ? Math.max(1, ((db.prepare(`SELECT MAX(t) AS t FROM nfl_live_samples WHERE game_id = ?`).get(id) as any)?.t || 1) + 0.001)
      : g.status === 'OT' ? 1 + (0.25 - r) : 1 - r;
    put.run(id, Math.round(t * 1000) / 1000, now.pHome, g.home_pts, g.away_pts);
  }
}

setNflStoredHook(ids => { try { sample(ids); } catch (e: any) { logger.warn(`nfl live samples: ${e.message}`); } });

/**
 * fix254 — the live recent calibration layer of each sport (utils/recentCalib.ts), read everywhere it is applied:
 * football's shown 1X2 (tracking.freezePredictions), tennis's shown chance (tennisModel.predictRow). Kept in
 * recent_calib (one row per sport), published as 'calib-recent:<sport>' by the nightly job (services/recentCalib.ts).
 * The web takes the published copy; the worker and the job threads (tennis model: read-only connection) read the row,
 * at most once a minute. No import of the model code (tracking.ts imports this file).
 */
import { db } from '../db';
import { isWeb } from './role';
import { onState } from './shared';
import { calibrateP, calibrate2, type IsoLayer } from '../utils/recentCalib';

export type RecentSport = 'football' | 'tennis';
export interface RecentState { at: string; layer: IsoLayer | null; since: string | null; prev: { layer: IsoLayer | null; since: string | null } | null }

try {
  db.exec(`CREATE TABLE IF NOT EXISTS recent_calib (sport TEXT PRIMARY KEY, at TEXT NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recent_calib_log (date TEXT NOT NULL, sport TEXT NOT NULL, ran_at TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, report TEXT, PRIMARY KEY (date, sport))`);
} catch { /* read-only connection: the main thread made them */ }

const cache = new Map<RecentSport, { at: number; v: RecentState | null }>();
onState('calib-recent:', (k, v) => { cache.set(k.slice('calib-recent:'.length) as RecentSport, { at: Date.now(), v: (v as RecentState) || null }); });

export function readRecentState(sport: RecentSport): RecentState | null {
  try { const r = db.prepare(`SELECT state FROM recent_calib WHERE sport = ?`).get(sport) as any; return r ? JSON.parse(r.state) : null; } catch { return null; }
}
/** the live state (web: the published copy only; elsewhere: the row, re-read once a minute) */
export function recentState(sport: RecentSport): RecentState | null {
  const c = cache.get(sport);
  if (isWeb) return c?.v ?? null;
  if (c && Date.now() - c.at < 60_000) return c.v;
  const v = readRecentState(sport);
  cache.set(sport, { at: Date.now(), v });
  return v;
}
/** the worker after a decision: use the new state at once */
export const setRecentCache = (sport: RecentSport, v: RecentState | null) => cache.set(sport, { at: Date.now(), v });
export const recentLayer = (sport: RecentSport) => recentState(sport)?.layer ?? null;

const r1 = (x: number) => Math.round(x * 10) / 10;
/**
 * football: every shown prediction's 1X2 through the layer (feat-v1, a shadow, is left alone). The chances before it
 * ride along as `pre` (saved as predictions.p_pre: the next fit's input).
 */
export function calibrateFootball<T extends { model: string; home: number; draw: number; away: number }>(preds: T[]): T[] {
  const L = recentLayer('football');
  if (!L) return preds;
  return preds.map(p => {
    if (p.model === 'feat-v1' || ![p.home, p.draw, p.away].every(Number.isFinite)) return p;
    const q = calibrateP(L, [p.home, p.draw, p.away]);
    return { ...p, home: r1(q[0]), draw: r1(q[1]), away: r1(q[2]), pre: { home: p.home, draw: p.draw, away: p.away } };
  });
}
/** tennis: the first player's chance (0–1) through the layer */
export const calibrateTennis = (p1: number) => calibrate2(recentLayer('tennis'), p1);

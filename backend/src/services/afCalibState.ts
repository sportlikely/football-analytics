/**
 * fix220 — the calibration layer of American football as every process reads it: the fitted layer per league, the
 * strong-pick line per league ("Strong" = the line where calibrated picks were right ≥ 75% in testing) and the
 * college game segments. Built by the worker (services/afCalibration.ts), stored in nfl_sync and published as the
 * small 'nfl:calib' state. No layer yet = the chances as the model gives them and the old lines (70% / 75%).
 */
import { db } from '../db';
import { onState, publishState } from './shared';
import { applyCalib, segOfTeams, type Calib, type Seg } from '../utils/afCalib';

export type AfLeague = 1 | 2;
export interface AfCalibState {
  at: string; version: string;
  leagues: Record<AfLeague, { calib: Calib | null; strong: number | null; source: string; fitSeasons: number[] }>;
  /** ncaa-v2 passed its gate and is the live college model */
  ncaaV2: boolean;
}
/** The lines before fix220 (and while no layer is fitted). */
export const STRONG_DEFAULT: Record<AfLeague, number> = { 1: 0.7, 2: 0.75 };

let state: AfCalibState | null = null;
let loaded = false;
onState('nfl:calib', (_k, v) => { state = v as AfCalibState; loaded = true; });
function cur(): AfCalibState | null {
  if (!loaded) {
    loaded = true;
    try { const r = db.prepare(`SELECT detail FROM nfl_sync WHERE key = 'calib|state'`).get() as any; if (r) state = JSON.parse(r.detail); } catch { /* table not there yet */ }
  }
  return state;
}
/** Worker: the new layer (stored, published, used here at once). */
export function setAfCalib(v: AfCalibState) {
  state = v; loaded = true;
  db.prepare(`INSERT OR REPLACE INTO nfl_sync (key, at, detail) VALUES ('calib|state', ?, ?)`).run(v.at, JSON.stringify(v));
  publishState('nfl:calib', v);
}
export const afCalibState = () => cur();

/** The calibrated home win chance of a game of `league` (seg: college only). */
export function calibrated(league: AfLeague, p: number, seg?: Seg | null): number {
  const c = cur()?.leagues?.[league]?.calib;
  return c ? applyCalib(c, p, league === 2 ? seg : null) : p;
}
export const strongLineOf = (league: AfLeague): number => cur()?.leagues?.[league]?.strong ?? STRONG_DEFAULT[league];
export const ncaaV2Live = () => !!cur()?.ncaaV2;

/** College teams' conference and level (10-minute copy). */
let teamsAt = 0;
let teams = new Map<number, { conf: string | null; level: string | null }>();
export function collegeTeams() {
  if (Date.now() - teamsAt > 10 * 60 * 1000) {
    teamsAt = Date.now();
    try { teams = new Map((db.prepare(`SELECT team_id, conference, level FROM nfl_teams WHERE league = 2`).all() as any[]).map(r => [r.team_id, { conf: r.conference || null, level: r.level || null }])); } catch { /* not yet */ }
  }
  return teams;
}
export function collegeSeg(home: number, away: number): Seg {
  const t = collegeTeams();
  return segOfTeams(t.get(home), t.get(away));
}

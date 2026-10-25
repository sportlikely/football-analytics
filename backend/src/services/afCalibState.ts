/**
 * fix220 — the calibration layer of American football as every process reads it: the fitted layer per league, the
 * strong-pick line per league ("Strong" = the line where calibrated picks were right ≥ 75% in testing) and the
 * college game segments. Built by the worker (services/afCalibration.ts), stored in nfl_sync and published as the
 * small 'nfl:calib' state. No layer yet = the chances as the model gives them and the old lines (70% / 75%).
 */
import { db } from '../db';
import { onState, publishState } from './shared';
import { applyCalib, segOfTeams, type Calib, type Seg } from '../utils/afCalib';
import { applyUsed, type UsedProbSet } from '../utils/leagueSettings';
import { POWER } from '../utils/ncaaV2';

export type AfLeague = 1 | 2;
export interface AfCalibState {
  at: string; version: string;
  leagues: Record<AfLeague, { calib: Calib | null; strong: number | null; source: string; fitSeasons: number[] }>;
  /** ncaa-v2 passed its gate and is the live college model */
  ncaaV2: boolean;
  /** fix223: per-level settings (NFL / FBS / G5 / FCS: home edge + stretch) that beat the shared model, applied before the layer */
  settings?: Record<string, UsedProbSet>;
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

/**
 * The calibrated home win chance of a game of `league` (seg: college only). fix223: with the game, its level's own
 * settings first (home edge only off a neutral field), then the layer (fitted on the chances with those settings).
 */
export function calibrated(league: AfLeague, p: number, seg?: Seg | null, game?: { h: number; a: number; neutral?: boolean } | null): number {
  const s = cur();
  const q = game && s?.settings ? applyUsed(s.settings, afLevel(league, game.h, game.a), p, !game.neutral) : p;
  const c = s?.leagues?.[league]?.calib;
  return c ? applyCalib(c, q, league === 2 ? seg : null) : q;
}

/** fix223: a game's level for the settings — NFL; FBS = both teams in the power conferences; G5 = other FBS games; FCS = an FCS team plays */
export type AfLevel = 'NFL' | 'FBS' | 'G5' | 'FCS';
export function levelOfTeams(h?: { conf: string | null; level: string | null } | null, a?: { conf: string | null; level: string | null } | null): AfLevel {
  if (!h || !a || h.level !== 'FBS' || a.level !== 'FBS') return 'FCS';
  return POWER.test(h.conf || '') && POWER.test(a.conf || '') ? 'FBS' : 'G5';
}
export const afLevel = (league: AfLeague, home: number, away: number): AfLevel => (league === 1 ? 'NFL' : levelOfTeams(collegeTeams().get(home), collegeTeams().get(away)));
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

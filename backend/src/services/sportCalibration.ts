/**
 * fix222 — honest percentages for basketball (fix220's layer, per league; maths in utils/sportCalib.ts). Tennis has
 * its own build inside the tennis model's report (services/tennisModel.ts), with the same maths.
 *
 *  - Rows: bb-v4's walk-forward rows (bb_grid_rows, services/bbGrid.ts), each game's chance as the live model would
 *    show it: bb-v4 (grid, the stored settings) where its group passes the gate, else bb-v3.
 *  - Fit seasons 2022 → 2025, test 2025 (fit 2022–2024), the live season 2026+ reported, never fitted. A league keeps
 *    its layer only when it beats the raw chances on 2025; the strong line per league = where the calibrated picks were
 *    right ≥ 75% on 2025.
 *  - Built in the worker (a job thread), stored in sport_calib and published as 'calib:bb'; predictGame applies it to
 *    every shown chance (bb_predictions.p_raw keeps the model's own).
 *  - fix222b, the in-season layer (utils/sportCalib.ts inSeasonLayer), behind a switch: on top of the season layer, fitted
 *    on this season's finished games (the live season's rows), tested walk-forward by day, used only when the switch is
 *    on AND it beat the season layer on the later days. Switch: Admin card / /api/admin/calibration?inseason=on|off
 *    (sport_calib 'basketball-inseason'), BB_INSEASON=on|off overrides it. Default off.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { onState, publishState } from './shared';
import { yieldLoop } from './perf';
import { buildLayer, applyLayer, inSeasonLayer, applyInSeason, type LeagueLayer, type LRow, type InSeasonFit } from '../utils/sportCalib';
import { gridEval, groupOf, GRID_TRAIN, GRID_TEST, GRID_LIVE_FROM, type GridParams } from '../utils/bbGridMath';

export const BB_CALIB_VERSION = 'fix222-1';
/** the strong line before fix222 (and while no layer is fitted) */
export const BB_STRONG_DEFAULT = 0.7;

db.exec(`CREATE TABLE IF NOT EXISTS sport_calib (sport TEXT PRIMARY KEY, at TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, report TEXT)`);

export interface CalibState {
  at: string; version: string; layer: LeagueLayer | null; strong: Record<string, number>; strongSport: number; source: string;
  /** fix222b: the in-season layer (null = not kept) and the switch as it was at the build */
  inSeason?: { fit: InSeasonFit | null; mode: 'on' | 'off' } | null;
}
let bb: CalibState | null = null;
let loaded = false;
let ver = 0;
onState('calib:bb', (_k, v) => { bb = v as CalibState; loaded = true; ver++; });
function cur(): CalibState | null {
  if (!loaded) {
    loaded = true;
    try { const r = db.prepare(`SELECT state FROM sport_calib WHERE sport = 'basketball'`).get() as any; if (r) bb = JSON.parse(r.state); } catch { /* not yet */ }
  }
  return bb;
}
export const bbCalibVer = () => ver;
export const bbCalibState = () => cur();
/** fix222b: the in-season switch (stored by the admin; BB_INSEASON=on|off overrides it), off by default */
export function inSeasonMode(): 'on' | 'off' {
  const env = String(process.env.BB_INSEASON || '').toLowerCase();
  if (env === 'on' || env === 'off') return env;
  try { const r = db.prepare(`SELECT state FROM sport_calib WHERE sport = 'basketball-inseason'`).get() as any; return r && JSON.parse(r.state).mode === 'on' ? 'on' : 'off'; } catch { return 'off'; }
}
export function setInSeasonMode(mode: 'on' | 'off') {
  db.prepare(`INSERT OR REPLACE INTO sport_calib (sport, at, version, state, report) VALUES ('basketball-inseason', ?, ?, ?, NULL)`).run(new Date().toISOString(), BB_CALIB_VERSION, JSON.stringify({ mode }));
}
/** the calibrated home win chance of a basketball game of `code` (season layer, then the in-season one when on and kept) */
export function bbCalibrated(code: string, p: number) {
  const s = cur();
  const q = applyLayer(s?.layer, code, p);
  const env = String(process.env.BB_INSEASON || '').toLowerCase();
  const on = env === 'on' || (env !== 'off' && s?.inSeason?.mode === 'on');
  return on ? applyInSeason(s?.inSeason?.fit, code, q) : q;
}
/** the strong-pick line of a league (0–1): calibrated picks right ≥ 75% on the test season; 0.7 without a layer */
export const bbStrongLine = (code: string) => cur()?.strong?.[code] ?? cur()?.strongSport ?? BB_STRONG_DEFAULT;

/** the chance the live model shows for a walk-forward row: bb-v4 where its group passes the gate, else bb-v3 */
function shownRows(items: { id: number; code: string; year: number; y: number; v3: number; sig: number; hv: number[]; av: number[] }[], params: GridParams, pass: Record<string, boolean>, forCode: (code: string) => GridParams = () => params): LRow[] {
  const env = String(process.env.BB_GRID || '').toLowerCase();
  return items.map(x => {
    const v4 = env === 'on' || (env !== 'off' && pass[groupOf(x.code)]);
    return { p: v4 ? gridEval(forCode(x.code), x.code, x).pHome : x.v3, y: x.y, season: x.year, league: x.code };
  });
}

/** the whole build here (job thread, or the worker's main thread with THREAD_JOBS=0) */
export async function buildBbCalibrationHere(why: string) {
  const t0 = Date.now();
  const { loadRows } = await import('./bbGrid');
  const { storedParams, gridGate, gateInputs, groupParams } = await import('./bbTuner');
  const params = storedParams();
  // fix225: the rows as the live impact setting reads them; fix236: and #4 as live has it (NBA: who played)
  const items = gateInputs(loadRows(), params);
  await yieldLoop();
  if (items.length < 1000) { logger.info(`bb calibration: only ${items.length} walk-forward rows (the basketball model builds them first)`); return null; }
  const gate = gridGate(items, params);
  const pass = Object.fromEntries(Object.values(gate).map(g => [g.group, g.pass]));
  const rows = shownRows(items, params, pass, code => groupParams(params, gate, code));
  await yieldLoop();
  const r = buildLayer(rows, { first: GRID_TRAIN[0], test: GRID_TEST, last: GRID_TEST, symmetric: false, strongDefault: BB_STRONG_DEFAULT });
  // fix222b: the in-season layer on this season's finished games (the season layer applied first), walk-forward by day
  const liveYear = Math.max(GRID_LIVE_FROM, ...items.map(x => x.year));
  const tOf = new Map<number, number>();
  for (const g of db.prepare(`SELECT game_id, kickoff FROM bb_games WHERE kickoff >= ?`).all(new Date(Date.now() - 400 * 86400000).toISOString()) as any[]) tOf.set(g.game_id, Date.parse(g.kickoff));
  const liveRows = items.map((x, i) => ({ x, r: rows[i] })).filter(({ x }) => x.year === liveYear && tOf.has(x.id))
    .map(({ x, r: row }) => ({ p: applyLayer(r.layer, row.league, row.p), y: row.y, league: row.league, t: tOf.get(x.id)! }));
  const ins = inSeasonLayer(liveRows);
  await yieldLoop();
  const mode = inSeasonMode();
  const at = new Date().toISOString();
  const source = `bb-v4 walk-forward rows (${params.version}; bb-v4 in ${Object.entries(pass).filter(([, v]) => v).map(([k]) => k).join(', ') || 'no group'}, else bb-v3)`;
  const state: CalibState = { at, version: BB_CALIB_VERSION, layer: r.layer, strong: r.strong, strongSport: r.strongSport, source, inSeason: { fit: ins.fit, mode } };
  const report = { ...r, inSeason: { ...ins, season: liveYear, mode, used: mode === 'on' && ins.kept }, why, source, at, seconds: Math.round((Date.now() - t0) / 1000), rows: rows.length };
  db.prepare(`INSERT OR REPLACE INTO sport_calib (sport, at, version, state, report) VALUES ('basketball', ?, ?, ?, ?)`).run(at, BB_CALIB_VERSION, JSON.stringify(state), JSON.stringify(report));
  bb = state; loaded = true; ver++;
  publishState('calib:bb', state);
  logger.info(`bb calibration (${why}): test ${GRID_TEST} LL raw ${r.test.raw.logLoss} → ${r.test.ownFit.logLoss} (own fits) / ${r.test.sportFit.logLoss} (one fit); layer ${r.layer ? `kept in ${r.perLeague.filter(x => x.kept).map(x => x.league).join(', ')}` : 'not kept'}; live ${r.live.games} games LL ${r.live.raw.logLoss} → ${r.live.cal.logLoss}; in-season layer (switch ${mode}): ${ins.why}; strong line ${Math.round(r.strongSport * 100)}%`);
  return { at, kept: !!r.layer };
}

let building = false;
/** worker: build the layer (in a job thread when they are on), then re-save the next 7 days' predictions */
export async function buildBbCalibration(why: string): Promise<void> {
  if (building) return;
  building = true;
  try {
    const { threadJobsOn, inThread } = await import('./threadJob');
    const r = threadJobsOn() ? await inThread<{ at: string; kept: boolean } | null>('bb calib', [why]) : await buildBbCalibrationHere(why);
    if (r) {
      // the thread published the state; read it here too (this process predicts) and save the upcoming games again
      loaded = false; ver++;
      const { recordBbPredictions } = await import('./bbModel');
      await recordBbPredictions();
    }
  } catch (e: any) { logger.warn(`bb calibration (${why}): ${e?.message || e}`); }
  finally { building = false; }
}

/** admin: the last report (Admin → Basketball model v4 card, /api/admin/calibration?sport=basketball) */
export function calibReport(sport: 'basketball' | 'tennis') {
  const r = db.prepare(`SELECT at, version, report FROM sport_calib WHERE sport = ?`).get(sport) as any;
  if (!r) return null;
  try { return { at: r.at, version: r.version, ...JSON.parse(r.report || '{}') }; } catch { return { at: r.at, version: r.version }; }
}

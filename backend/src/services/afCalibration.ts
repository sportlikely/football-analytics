/**
 * fix220 — American football: honest percentages + ncaa-v2. Worker only (the NFL scheduler's model tick, in the heavy()
 * queue); the layer itself is read through services/afCalibState.ts.
 *
 *  1. ncaa-v2 (utils/ncaaV2.ts): every college game's numbers in one walk-forward pass; season S (2022 → now) predicted
 *     with weights tuned on 2021 … S − 1 only (never past 2025). The official test: train 2021–2024, test 2025 whole
 *     season and conference games only; 2026 reported, never tuned on. Gate: ncaa-v2 goes live only if it beats ncaa-v1
 *     (as it ran in its own walk-forward test) on log loss on 2025 conference games; else ncaa-v1 stays and the report
 *     says why. Live weights: tuned on 2021–2025.
 *  2. The calibration layer per league (utils/afCalib.ts) on the live model's walk-forward predictions: nfl-v2's test rows
 *     when it is adopted (else nfl-v1's), ncaa-v2's when it passed (else ncaa-v1's). Season S calibrated with a fit on
 *     the seasons before it; the live layer fitted on 2021–2025; 2026 = test (walk-forward rows and the predictions we
 *     really saved before kick-off, raw against calibrated). Strong line per league: where the calibrated picks were
 *     right ≥ 75% (2021–2025).
 * GET /api/admin/nfl-model (and /api/nfl-past) show the tables; POST-free: ?calib=1 rebuilds in the background.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { yieldLoop } from './perf';
import { modelInternals as M, nflWalkForward, type NflG as G, type NflCtx, type Params } from './nflModel';
import { setAfCalib, STRONG_DEFAULT, ncaaV2Live, type AfCalibState, type AfLeague } from './afCalibState';
import { walkForwardCalib, fitCalib, applyCalib, scoreRows, pickBands, strongLine, segOfTeams, CALIB_FIRST, CALIB_LAST, type CalRow, type Seg } from '../utils/afCalib';
import { buildRows, tuneV2, v2P, stateOf, POWER, V2_TEST_SEASON, V2_TRAIN_LAST, type V2Raw, type V2Params, type V2Team, type V2Box, type V2Passer } from '../utils/ncaaV2';

export const AF_VERSION = 'fix220-1';
export const NCAA_V2 = 'ncaa-v2';

/* ---------- inputs ---------- */

async function collegeInputs() {
  const games = await M.loadGamesAsync(2), ctx = await M.loadCtxAsync(2);
  const list = db.prepare(`SELECT team_id, name, conference, level, city FROM nfl_teams WHERE league = 2`).all() as any[];
  const teams = new Map<number, V2Team>(list.map(r => [r.team_id, { conf: r.conference || null, level: r.level || null, power: POWER.test(r.conference || ''), state: stateOf(r.city) }]));
  const names = new Map<number, string>(list.map(r => [r.team_id, r.name]));
  const box = new Map<string, V2Box>();
  for (const [k, b] of ctx.box) box.set(k, { plays: b.plays ?? null, ypp: b.ypp });
  return { games, ctx, teams, names, box, qb: ctx.qb as Map<string, V2Passer[]> };
}
/** ncaa-v1's own chance (Elo + QB + rest, no blend) of every finished game with one set of settings. */
function v1Probs(games: G[], ctx: NflCtx, p: Params): Map<number, number> {
  const out = new Map<number, number>();
  M.run(games, p, ctx, pr => { out.set(pr.g.id, pr.p); }, undefined, 2);
  return out;
}
const seasonsOf = (games: G[]) => [...new Set(games.filter(g => g.done).map(g => g.season))].sort((a, b) => a - b);
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const OUT = /out|doubtful|injured reserve|^ir$|reserve/i;

/* ---------- 1. ncaa-v2: walk-forward test and gate ---------- */

async function ncaaV2Test() {
  const { games, ctx, teams, names, box, qb } = await collegeInputs();
  const rows = await buildRows(games, box, qb, teams, names, yieldLoop);
  const seasons = seasonsOf(games).filter(s => rows.filter(r => r.done && r.season === s).length >= 30);
  const v1Report = M.readSync('model2|report');
  const v2wf = new Map<number, number>(), v1run = new Map<number, number>();
  let testParams: V2Params | null = null;
  const tests = seasons.filter(s => s > CALIB_FIRST);
  for (const S of tests) {
    const start = Math.min(...games.filter(g => g.season === S && g.done).map(g => g.t));
    const stored = v1Report?.seasons?.find((x: any) => x.season === S)?.params;
    const p1 = M.fullParams(stored || await M.tune(games, ctx, start, false, 2), 2);
    const v1 = v1Probs(games, ctx, p1);
    const last = Math.min(S - 1, V2_TRAIN_LAST);
    const train = rows.filter(r => r.done && r.season >= CALIB_FIRST && r.season <= last && v1.has(r.id)).map(r => ({ r, v1: v1.get(r.id)! }));
    if (train.length < 300) continue;
    const P = await tuneV2(train, last, yieldLoop);
    if (S === V2_TEST_SEASON) testParams = P;
    for (const r of rows) if (r.done && r.season === S && v1.has(r.id)) { v2wf.set(r.id, v2P(P, r, v1.get(r.id)!)); v1run.set(r.id, v1.get(r.id)!); }
    await yieldLoop();
  }
  // ncaa-v1 as it ran in its own walk-forward test (with its blend when kept); its Elo-only run where that has no row
  const v1wf = new Map(nflWalkForward(2).map(([id, p]) => [id, p] as [number, number]));
  const v1Of = (id: number) => v1wf.get(id) ?? v1run.get(id)!;
  const sel = (season: number, confOnly: boolean) => rows.filter(r => r.done && r.season === season && v2wf.has(r.id) && (!confOnly || r.conf === 1));
  const cmp = (list: V2Raw[]) => ({ v1: scoreRows(list.map(r => ({ p: v1Of(r.id), y: r.y }))), v2: scoreRows(list.map(r => ({ p: v2wf.get(r.id)!, y: r.y }))) });
  const test2025 = { whole: cmp(sel(V2_TEST_SEASON, false)), conf: cmp(sel(V2_TEST_SEASON, true)) };
  const now = seasons.filter(s => s > CALIB_LAST);
  const season2026 = now.length ? { season: now[now.length - 1], whole: cmp(sel(now[now.length - 1], false)), conf: cmp(sel(now[now.length - 1], true)) } : null;
  const seasonOfRow = new Map(rows.map(r => [r.id, r.season]));
  const perSeason = [...new Set([...v2wf.keys()].map(id => seasonOfRow.get(id)!))].sort((a, b) => a - b).map(s => ({ season: s, ...cmp(sel(s, false)), conf: cmp(sel(s, true)) }));
  const c = test2025.conf;
  const pass = c.v1.games >= 100 && c.v2.logLoss !== null && c.v1.logLoss !== null && c.v2.logLoss < c.v1.logLoss;
  const reason = c.v1.games < 100 ? `only ${c.v1.games} conference games of ${V2_TEST_SEASON} to test on (100 needed): ncaa-v1 stays`
    : pass ? `ncaa-v2 LL ${c.v2.logLoss} < ncaa-v1 ${c.v1.logLoss} on ${c.v1.games} conference games of ${V2_TEST_SEASON}: ncaa-v2 live`
      : `ncaa-v2 LL ${c.v2.logLoss} ≥ ncaa-v1 ${c.v1.logLoss} on ${c.v1.games} conference games of ${V2_TEST_SEASON}: ncaa-v1 stays (with the calibration layer)`;
  logger.info(`${NCAA_V2} gate: ${pass ? 'pass' : 'fail'} — ${reason}`);
  // live weights: 2021–2025, ncaa-v1 with its live settings
  let live: { params: V2Params; at: string } | null = null;
  if (pass) {
    const stored = M.readSync('model2|params');
    const v1 = v1Probs(games, ctx, M.fullParams(stored?.params, 2));
    const train = rows.filter(r => r.done && r.season >= CALIB_FIRST && r.season <= V2_TRAIN_LAST && v1.has(r.id)).map(r => ({ r, v1: v1.get(r.id)! }));
    live = { params: await tuneV2(train, V2_TRAIN_LAST, yieldLoop), at: new Date().toISOString() };
  }
  M.sync('ncaa2|live', live);
  const segOf = (g: G): Seg => segOfTeams(teams.get(g.h), teams.get(g.a));
  const byId = new Map(games.map(g => [g.id, g]));
  return {
    pass, reason, live, rows, byId, segOf,
    report: { pass, reason, trainSeasons: range(CALIB_FIRST, V2_TEST_SEASON - 1), testSeason: V2_TEST_SEASON, test2025, season2026, perSeason, testParams, liveParams: live?.params || null },
    v2wf, v1wf
  };
}

/* ---------- 2. the calibration layer per league ---------- */

function savedRows(league: AfLeague, seg: (h: number, a: number) => Seg | undefined) {
  return (db.prepare(`SELECT p.game_id, p.p_home, p.p_raw, p.model, g.home_id, g.away_id, g.home_pts AS hs, g.away_pts AS as_ FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id
    WHERE g.league = ? AND p.season > ? AND p.made_at <= p.kickoff AND g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND g.away_pts IS NOT NULL`).all(league, CALIB_LAST) as any[])
    .map(r => ({ p: r.p_raw ?? r.p_home, y: r.hs > r.as_ ? 1 : r.hs < r.as_ ? 0 : 0.5, season: CALIB_LAST + 1, seg: seg(r.home_id, r.away_id), model: r.model as string }));
}

export function leagueLayer(league: AfLeague, rows: CalRow[], source: string, seg: (h: number, a: number) => Seg | undefined) {
  const seasons = [...new Set(rows.map(r => r.season))].sort((a, b) => a - b).filter(s => s > CALIB_FIRST && rows.filter(r => r.season === s).length >= 30);
  // the layer is kept only when it beats the raw chances on the walk-forward seasons up to 2025 (games it never saw):
  // per segment (college), one league fit, or none
  const fitTests = seasons.filter(s => s <= CALIB_LAST);
  const wfLeague = walkForwardCalib(rows, fitTests, false), wfSeg = league === 2 ? walkForwardCalib(rows, fitTests, true) : null;
  const rawLL = wfLeague.total.raw.logLoss ?? Infinity, leagueLL = wfLeague.total.cal.logLoss ?? Infinity, segLL = wfSeg?.total.cal.logLoss ?? Infinity;
  const mode: 'segments' | 'league' | 'none' = !wfLeague.total.raw.games ? 'none' : segLL < Math.min(leagueLL, rawLL) - 0.0002 ? 'segments' : leagueLL < rawLL - 0.0002 ? 'league' : 'none';
  const why = `walk-forward ${fitTests.join(', ') || '–'}: raw LL ${wfLeague.total.raw.logLoss ?? '–'}, league fit ${wfLeague.total.cal.logLoss ?? '–'}${wfSeg ? `, per segment ${wfSeg.total.cal.logLoss ?? '–'}` : ''} → ${mode === 'none' ? 'no layer (it does not help on games it never saw)' : mode === 'segments' ? 'per segment' : 'one league fit'}`;
  const segments = mode === 'segments';
  const wf = walkForwardCalib(rows, seasons, segments);
  const fitRows = rows.filter(r => r.season >= CALIB_FIRST && r.season <= CALIB_LAST);
  const calib = mode !== 'none' && fitRows.length >= 100 ? fitCalib(fitRows, segments) : null;
  // strong line: on the chances as shown (calibrated walk-forward, or raw without a layer), seasons up to 2025
  const shownRows = calib ? wf.rows : rows.filter(r => wf.seasons.some(s => s.season === r.season));
  const strong = strongLine(shownRows.filter(r => r.season <= CALIB_LAST)) ?? STRONG_DEFAULT[league];
  // the predictions really shown before kick-off this season: as saved (raw) and with the layer
  const saved = savedRows(league, seg);
  const savedCal = saved.map(r => ({ ...r, p: applyCalib(calib, r.p, r.seg) }));
  const bySeg = league === 2 ? Object.fromEntries((['mismatch', 'conf', 'other'] as Seg[]).map(s => {
    const a = saved.filter(r => r.seg === s), b = savedCal.filter(r => r.seg === s);
    return [s, { raw: scoreRows(a), cal: scoreRows(b), rawBands: pickBands(a), calBands: pickBands(b) }];
  })) : null;
  const { rows: _rows, ...wfReport } = wf;
  return {
    state: { calib, strong, source, fitSeasons: calib?.seasons || [] },
    report: {
      source, mode, why, calib, strong, strongDefault: STRONG_DEFAULT[league], walkForward: wfReport,
      saved: { games: saved.length, raw: scoreRows(saved), cal: scoreRows(savedCal), rawBands: pickBands(saved), calBands: pickBands(savedCal), bySeg }
    }
  };
}

let building = false;
/** The whole fix220 build: ncaa-v2 test + gate, both layers, the state and the report. */
export async function buildAfCalibration(): Promise<any> {
  if (building) return null;
  building = true;
  const t0 = Date.now();
  try {
    // college
    const v2 = await ncaaV2Test();
    const segOfId = (h: number, a: number) => v2.segOf({ h, a } as G);
    const collegeRows: CalRow[] = [];
    const src2 = v2.pass ? v2.v2wf : v2.v1wf;
    for (const [id, p] of src2) { const g = v2.byId.get(id); if (g && g.done) collegeRows.push({ p, y: g.hs! > g.as! ? 1 : g.hs! < g.as! ? 0 : 0.5, season: g.season, seg: v2.segOf(g) }); }
    const L2 = leagueLayer(2, collegeRows, v2.pass ? `${NCAA_V2} walk-forward` : 'ncaa-v1 walk-forward', segOfId);
    await yieldLoop();
    // NFL: nfl-v2's test rows when it is adopted, else nfl-v1's
    const nflGames = new Map((await M.loadGamesAsync(1)).map(g => [g.id, g]));
    const expWf = M.readSync('model|v2') ? M.readSync('model|exp-wf') : null;
    const src1: [number, number][] = Array.isArray(expWf) && expWf.length ? expWf : nflWalkForward(1).map(([id, p]) => [id, p]);
    const nflRows: CalRow[] = [];
    for (const [id, p] of src1) { const g = nflGames.get(id); if (g && g.done) nflRows.push({ p, y: g.hs! > g.as! ? 1 : g.hs! < g.as! ? 0 : 0.5, season: g.season }); }
    const L1 = leagueLayer(1, nflRows, Array.isArray(expWf) && expWf.length ? 'nfl-v2 walk-forward (experiments)' : 'nfl-v1 walk-forward', () => undefined);
    // the nfl-v2 re-check on this season: nfl-v1 (E1) and the adopted variant, raw, from the experiments
    const exp = M.readSync('model|exp');
    const seasonRow = (id: string) => exp?.variants?.find((v: any) => v.id === id)?.perSeason?.find((s: any) => s.season > CALIB_LAST) || null;
    const nflV2Check = exp ? { adopted: !!exp.adopted, best: exp.best, e1: seasonRow('E1'), bestRow: seasonRow(exp.best), calibrated2026: L1.report.walkForward.seasons.find((s: any) => s.season > CALIB_LAST) || null } : null;
    const at = new Date().toISOString();
    const state: AfCalibState = { at, version: AF_VERSION, leagues: { 1: L1.state, 2: L2.state }, ncaaV2: v2.pass };
    setAfCalib(state);
    const report = { version: AF_VERSION, at, seconds: Math.round((Date.now() - t0) / 1000), nfl: { ...L1.report, nflV2Check }, college: L2.report, ncaaV2: v2.report };
    M.sync('calib|report', report);
    for (const [name, r] of [['NFL', L1.report], ['college', L2.report]] as [string, any][]) {
      const w = r.walkForward.total;
      logger.info(`af calibration ${name} (${r.source}): walk-forward LL ${w.raw.logLoss} → ${w.cal.logLoss}, strong line ${Math.round(r.strong * 100)}%; this season saved ${r.saved.games} games LL ${r.saved.raw.logLoss} → ${r.saved.cal.logLoss}`);
    }
    liveKey = ''; // the live college numbers again with the new weights
    return report;
  } finally { building = false; }
}
export const afCalibReport = () => M.readSync('calib|report');
export const afCalibStale = () => afCalibReport()?.version !== AF_VERSION;

/* ---------- live ncaa-v2 (upcoming college games) ---------- */

let liveRows: Map<number, V2Raw> | null = null;
let liveParams: V2Params | null = null;
let liveKey = '', liveAt = 0;
/** The upcoming college games' ncaa-v2 numbers (after each finished game, at most every 10 min). */
export async function refreshNcaaV2(): Promise<void> {
  if (!ncaaV2Live()) { liveRows = null; liveParams = null; return; }
  const live = M.readSync('ncaa2|live');
  if (!live?.params) { liveRows = null; return; }
  const { games, teams, names, box, qb } = await collegeInputs();
  const key = `${live.at}|${games.length}|${games.filter(g => g.done).length}`;
  if (key === liveKey && Date.now() - liveAt < 10 * 60 * 1000) return;
  const out = new Set((db.prepare(`SELECT i.player_id, i.status FROM nfl_injuries i JOIN nfl_teams t ON t.team_id = i.team_id WHERE t.league = 2`).all() as any[]).filter(r => OUT.test(String(r.status || ''))).map(r => r.player_id as number));
  const rows = await buildRows(games, box, qb, teams, names, yieldLoop, out);
  liveRows = new Map(rows.filter(r => !r.done).map(r => [r.id, r]));
  liveParams = live.params;
  liveKey = key; liveAt = Date.now();
}
/** ncaa-v2's home win chance of an upcoming game (null = not live / no numbers yet); v1p = ncaa-v1's Elo chance. */
export function ncaaV2Prob(gameId: number, v1p: number): number | null {
  const r = liveRows?.get(gameId);
  if (!r || !liveParams || !ncaaV2Live()) return null;
  const p = v2P(liveParams, r, v1p);
  return Number.isFinite(p) ? p : null;
}

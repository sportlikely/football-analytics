/**
 * fix204 — "More predictions" for every sport, from the models we already have (utils/moreMath.ts does the maths):
 *
 *  B. Saved before the start like the main pick: every few minutes the extras of each game that has not started are
 *     derived from the main prediction we saved (football: the main model's expected goals; basketball / NFL: win
 *     chance, margin, total, points; tennis: the chain's serve chances) into `prediction_extras`. A row is only written
 *     while the game has not started, so it is frozen at kick-off / first serve with the main prediction's last update
 *     (line-up time included).
 *  C. Checked after the game: each output gets what happened, hit / miss of our top pick, Brier and log loss.
 *  E. Record: per sport and output, games, top-pick hit rate, Brier, log loss, and said vs happened once 200+ are in.
 *  F. Public only after the backtest: an output is shown to visitors when its walk-forward calibration is within 3
 *     points in every 10% step with 100+ forecasts (`more_pred_gate`; admins see every output).
 *  G. Data health: games of the next 48 h without extras, finished games without a check after 24 h.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { yieldLoop, heavySlicer, afterLive, after, every, afterHeavy, everyHeavy, heavy } from './perf';
import {
  footballExtras, fitGoalShrink, fitGoalShrinkTD, shrinkPair, type GoalShrink, normalExtras, tennisExtras, checkSet, calibration, calibrationOk, topIndex, pctSet, normCdf,
  DEFAULT_HT_SHARE, DEFAULT_GOAL_SHRINK, bandAlarm, marginSpread, teamSd, type GoalModel, type Extras, type LeagueFit, type MoreSport, type PSet, type SetCheck
} from '../utils/moreMath';
import {
  fitPoints, correctPts, fitRho, fitDispersion, shiftGames, meanOf, calibrateSet, fitOutputCalib, MIN_LEAGUE_GAMES,
  type PointsFit, type PointsRow, type OutputCalib
} from '../utils/moreCalib';
import { GROUPS } from './history';
import { mainRank } from './tracking';
import { leagueModelInfo, bbWalkForward } from './bbModel';
import { nflWalkForward, buildReport as buildNflReport } from './nflModel';
import { tennisExtrasDist, tennisServeChances, tennisRuleFor, tennisExtrasWalkForward } from './tennisModel';

db.exec(`
  CREATE TABLE IF NOT EXISTS prediction_extras (
    sport TEXT NOT NULL, game_id INTEGER NOT NULL, model TEXT NOT NULL, kickoff TEXT NOT NULL, made_at TEXT NOT NULL,
    json TEXT NOT NULL, source_at TEXT, settled INTEGER NOT NULL DEFAULT 0, result TEXT, settled_at TEXT,
    PRIMARY KEY (sport, game_id)
  );
  CREATE INDEX IF NOT EXISTS idx_prediction_extras_open ON prediction_extras(sport, settled, kickoff);
  CREATE TABLE IF NOT EXISTS more_pred_fit (sport TEXT NOT NULL, league TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (sport, league));
  CREATE TABLE IF NOT EXISTS more_pred_gate (sport TEXT NOT NULL, output TEXT NOT NULL, public INTEGER NOT NULL, games INTEGER NOT NULL, worst REAL, why TEXT, at TEXT NOT NULL, PRIMARY KEY (sport, output));
  CREATE TABLE IF NOT EXISTS more_pred_backtest (sport TEXT PRIMARY KEY, report TEXT NOT NULL, at TEXT NOT NULL);
`);
// fix204b: calc = the version of the maths a row was made with (older rows of upcoming games are made again);
// admin_only + flag = the sanity check failed for this game (visitors don't see its extras)
{
  const cols = new Set((db.prepare(`PRAGMA table_info(prediction_extras)`).all() as any[]).map(c => c.name));
  if (!cols.has('calc')) db.exec(`ALTER TABLE prediction_extras ADD COLUMN calc TEXT`);
  if (!cols.has('admin_only')) db.exec(`ALTER TABLE prediction_extras ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has('flag')) db.exec(`ALTER TABLE prediction_extras ADD COLUMN flag TEXT`);
}
/** bump when the maths behind saved rows changes: upcoming games are saved again on the next tick */
export const MORE_CALC = '204c';

export const MORE_SPORTS: MoreSport[] = ['football', 'basketball', 'nfl', 'tennis'];
/** the outputs of each sport, in page order */
export const MORE_KEYS: Record<MoreSport, string[]> = {
  football: ['score', 'goals', 'homeGoals', 'awayGoals', 'cleanHome', 'cleanAway', 'win2Home', 'win2Away', 'ht', 'htft'],
  basketball: ['margin', 'total', 'homePts', 'awayPts', 'half', 'ot'],
  nfl: ['margin', 'total', 'homePts', 'awayPts', 'half', 'ot'],
  tennis: ['sets', 'first', 'games', 'tb']
};
const DAY = 86400000;
const MIN_FIT_GAMES = 200;
/** between two steps of a background job: give the thread back, and wait while a live tick runs */
const afterLiveYield = async () => { await yieldLoop(); await afterLive(); };
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* League fits (first-half share, level-at-half and overtime factors)   */
/* ------------------------------------------------------------------ */

const fitCache = new Map<string, any>();
// fix202: the worker re-fits daily; the web process reads the stored fits again every 30 minutes
function storeFit(sport: string, league: string, v: any) {
  db.prepare(`INSERT OR REPLACE INTO more_pred_fit (sport, league, json, at) VALUES (?, ?, ?, ?)`).run(sport, league, JSON.stringify(v), now());
  fitCache.set(`${sport}|${league}`, v);
}
function readFit(sport: string, league: string): any {
  const k = `${sport}|${league}`;
  if (fitCache.has(k)) return fitCache.get(k);
  const r = db.prepare(`SELECT json FROM more_pred_fit WHERE sport = ? AND league = ?`).get(sport, league) as any;
  let v: any = null;
  try { v = r ? JSON.parse(r.json) : null; } catch { v = null; }
  fitCache.set(k, v);
  return v;
}

/** football: first-half goals ÷ full-time goals per division (stored half-time scores × results), < 200 games → 0.45 */
export function fitFootballShares(): Record<string, { share: number; games: number }> {
  const rows = db.prepare(`SELECT h.division AS d, COUNT(*) AS n, SUM(h.ht_hg + h.ht_ag) AS ht, SUM(m.hg + m.ag) AS ft
    FROM ht_scores h JOIN history_matches m ON m.division = h.division AND m.date = h.date AND m.home = h.home AND m.away = h.away GROUP BY h.division`).all() as any[];
  const out: Record<string, { share: number; games: number }> = {};
  for (const r of rows) out[r.d] = { share: r.n >= MIN_FIT_GAMES && r.ft > 0 ? Math.round((r.ht / r.ft) * 1000) / 1000 : DEFAULT_HT_SHARE, games: r.n };
  storeFit('football', '*', out);
  // the goal-spread shrink from grid-v3's walk-forward test games (all stored seasons)
  const bt = db.prepare(`SELECT b.xg_home AS xh, b.xg_away AS xa, b.hg, b.ag, MAX(b.run_id) FROM backtest_predictions b JOIN backtest_runs r ON r.id = b.run_id AND r.model = 'grid-v3'
    WHERE b.xg_home IS NOT NULL GROUP BY b.division, b.date, b.home, b.away`).all() as any[];
  storeFit('football', 'shrink', fitGoalShrink(bt));
  return out;
}
/** the latest stored fit; before the first one the local backtest's value (fix204b: never "no correction") */
export const goalShrink = (): GoalShrink => readFit('football', 'shrink') || DEFAULT_GOAL_SHRINK;
/** competition code → division (each group lists its competitions in the order of its divisions) */
function divisionOf(code: string | null): string | null {
  if (!code) return null;
  for (const g of Object.values(GROUPS)) { const i = g.competitions.indexOf(code); if (i >= 0) return g.divisions[Math.min(i, g.divisions.length - 1)] || null; }
  return null;
}
export function htShareFor(code: string | null): number {
  const d = divisionOf(code), all = readFit('football', '*') as Record<string, { share: number; games: number }> | null;
  return (d && all?.[d]?.share) || DEFAULT_HT_SHARE;
}

/** the normal curve's chance of a level score (|x| < 0.5) for a list of margins (their own mean and spread) */
function levelChance(xs: number[]) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length, sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
  return normCdf((0.5 - m) / sd) - normCdf((-0.5 - m) / sd);
}
interface QGame { h: (number | null)[]; a: (number | null)[]; hs: number; as: number; status: string | null; kickoff: string }
/** share, level-at-half and overtime factors, typical total from finished games with quarter scores */
export function fitFromQuarters(games: QGame[], defaults: { sigma: number; sigmaT: number; meanTotal: number }): LeagueFit {
  const full = games.filter(g => g.h.slice(0, 4).every(x => x !== null) && g.a.slice(0, 4).every(x => x !== null));
  const sum = (xs: (number | null)[], n: number) => xs.slice(0, n).reduce((s: number, x) => s + (x || 0), 0);
  const recent = games.filter(g => Date.parse(g.kickoff) > Date.now() - 400 * DAY);
  const tot = (recent.length >= 50 ? recent : games).map(g => g.hs + g.as);
  const meanTotal = tot.length ? tot.reduce((a, b) => a + b, 0) / tot.length : defaults.meanTotal;
  if (full.length < MIN_FIT_GAMES) return { share: 0.5, kHalf: 1, kOt: 1, meanTotal: Math.round(meanTotal * 10) / 10, sigma: defaults.sigma, sigmaT: defaults.sigmaT, games: full.length };
  let half = 0, reg = 0, halfLevel = 0, ot = 0;
  const hm: number[] = [], rm: number[] = [];
  for (const g of full) {
    const h2 = sum(g.h, 2), a2 = sum(g.a, 2), h4 = sum(g.h, 4), a4 = sum(g.a, 4);
    half += h2 + a2; reg += h4 + a4;
    hm.push(h2 - a2); rm.push(h4 - a4);
    if (h2 === a2) halfLevel++;
    if (h4 === a4 || g.status === 'AOT' || (g.h[4] || 0) + (g.a[4] || 0) > 0) ot++;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    share: r3(half / Math.max(1, reg)),
    kHalf: r3(halfLevel / full.length / Math.max(1e-4, levelChance(hm))),
    kOt: r3(ot / full.length / Math.max(1e-4, levelChance(rm))),
    meanTotal: Math.round(meanTotal * 10) / 10, sigma: defaults.sigma, sigmaT: defaults.sigmaT, games: full.length
  };
}
const parseQ = (s: string | null): { h: (number | null)[]; a: (number | null)[] } | null => {
  let q: any = null;
  try { q = s ? JSON.parse(s) : null; } catch { q = null; }
  if (Array.isArray(q) && Array.isArray(q[0]) && Array.isArray(q[1])) return { h: q[0], a: q[1] };
  if (q && Array.isArray(q.home) && Array.isArray(q.away)) return { h: q.home, a: q.away };
  return null;
};
function bbGamesOf(code: string, before?: string): QGame[] {
  const rows = db.prepare(`SELECT kickoff, status, hs, as_, quarters FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL ${before ? 'AND kickoff < ?' : ''}`)
    .all(...[code, ...(before ? [before] : [])]) as any[];
  return rows.map(r => { const q = parseQ(r.quarters); return { h: q?.h || [], a: q?.a || [], hs: r.hs, as: r.as_, status: r.status, kickoff: r.kickoff }; });
}
function nflGamesOf(league: number, before?: string): QGame[] {
  const rows = db.prepare(`SELECT kickoff, status, home_pts, away_pts, quarters FROM nfl_games WHERE league = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL ${before ? 'AND kickoff < ?' : ''}`)
    .all(...[league, ...(before ? [before] : [])]) as any[];
  return rows.map(r => { const q = parseQ(r.quarters); return { h: q?.h || [], a: q?.a || [], hs: r.home_pts, as: r.away_pts, status: r.status, kickoff: r.kickoff }; });
}
const NFL_DEFAULT = { 1: { sigma: 13.5, sigmaT: 13, meanTotal: 45 }, 2: { sigma: 16, sigmaT: 17, meanTotal: 55 } } as Record<number, { sigma: number; sigmaT: number; meanTotal: number }>;
/** NFL spreads from the walk-forward test games (how far the margin and the total were off), else the defaults */
function nflSpreads(league: number) {
  const wf = nflWalkForward(league as 1 | 2);
  if (wf.length < 100) return NFL_DEFAULT[league];
  const res = new Map((db.prepare(`SELECT game_id, home_pts, away_pts FROM nfl_games WHERE league = ? AND home_pts IS NOT NULL`).all(league) as any[]).map(r => [r.game_id, r]));
  let m2 = 0, t2 = 0, n = 0;
  for (const [id, , margin, total] of wf) { const r = res.get(id); if (!r) continue; m2 += (r.home_pts - r.away_pts - margin) ** 2; t2 += (r.home_pts + r.away_pts - total) ** 2; n++; }
  return n >= 100 ? { sigma: Math.sqrt(m2 / n), sigmaT: Math.sqrt(t2 / n), meanTotal: NFL_DEFAULT[league].meanTotal } : NFL_DEFAULT[league];
}
export async function refitLeagues() {
  fitFootballShares();
  const codes = (db.prepare(`SELECT DISTINCT code FROM bb_games`).all() as any[]).map(r => r.code as string);
  for (const code of codes) {
    const info = leagueModelInfo(code);
    storeFit('basketball', code, fitFromQuarters(bbGamesOf(code), { sigma: info?.sigma || 12, sigmaT: info?.sigmaTotal || 17, meanTotal: info ? 2 * info.avgPoints : 160 }));
    await afterLiveYield();
  }
  for (const lg of [1, 2]) { storeFit('nfl', String(lg), fitFromQuarters(nflGamesOf(lg), nflSpreads(lg))); await afterLiveYield(); }
}
/** fix204b: a league's average total of its finished games of the last ~13 months (50+ games), else null */
const meanCache = new Map<string, { at: number; v: number | null }>();
function recentMeanTotal(sport: 'basketball' | 'nfl', key: string | number): number | null {
  const k = `${sport}|${key}`, hit = meanCache.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.v;
  const since = new Date(Date.now() - 400 * DAY).toISOString();
  const r = (sport === 'basketball'
    ? db.prepare(`SELECT COUNT(*) AS n, AVG(hs + as_) AS m FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL AND kickoff > ?`).get(String(key), since)
    : db.prepare(`SELECT COUNT(*) AS n, AVG(home_pts + away_pts) AS m FROM nfl_games WHERE league = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL AND kickoff > ?`).get(Number(key), since)) as any;
  const v = r && r.n >= 50 && r.m ? Math.round(r.m * 10) / 10 : null;
  meanCache.set(k, { at: Date.now(), v });
  return v;
}
/**
 * fix204b: the total and team-point bands are centred on the league's own running mean (bb-v3's per-league average
 * points × 2: NBA ≈ 225), never a global default; spreads = the model's current ones (they move as it learns; measured
 * misses tested worse, fix204 doc)
 */
export function bbFit(code: string): LeagueFit {
  const info = leagueModelInfo(code);
  const f: LeagueFit = readFit('basketball', code) || { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 0, sigma: 12, sigmaT: 17, games: 0 };
  const meanTotal = info && info.avgPoints > 0 ? Math.round(2 * info.avgPoints * 10) / 10 : recentMeanTotal('basketball', code) || f.meanTotal || 160;
  return info ? { ...f, meanTotal, sigma: info.sigma, sigmaT: info.sigmaTotal } : { ...f, meanTotal };
}
/** NFL / college: the stored fit (its mean = the league's recent games), else the league's recent games, else the default */
export function nflFit(league: number): LeagueFit {
  const d = NFL_DEFAULT[league] || NFL_DEFAULT[1];
  const f: LeagueFit | null = readFit('nfl', String(league));
  if (f && f.meanTotal > 0) return f;
  return { share: 0.5, kHalf: 1, kOt: 1, ...d, meanTotal: recentMeanTotal('nfl', league) || d.meanTotal, games: 0 };
}

/* ------------------------------------------------------------------ */
/* fix204c: fixes at the source + the calibration layer                 */
/* ------------------------------------------------------------------ */
/*
 * Fitted by the backtests (runBacktests) on every walk-forward game, stored, applied when saving:
 *  - more_pred_fit (sport, 'source'): points bias / spread per league (basketball, NFL / college), football goal model per
 *    division (shrink, Dixon–Coles ρ, negative-binomial size), tennis total-games bias per tour / format / surface;
 *  - more_pred_calib (sport, output): the final calibration map of each output that still missed on the fitting games.
 */
db.exec(`CREATE TABLE IF NOT EXISTS more_pred_calib (sport TEXT NOT NULL, output TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (sport, output))`);

export interface PointsSource { leagues: Record<string, PointsFit>; all: PointsFit | null }
export interface FootballSource { shrink: GoalShrink; leagues: Record<string, GoalModel & { n: number; dispersion: [number, number]; mh?: number; ma?: number }>; all: GoalModel }
/** a league with 300+ games is shrunk toward its own average goals (the pooled average pulled low-scoring Argentina up by 0.3) */
export function shrinkOfLeague(src: FootballSource, league: string | null): GoalShrink {
  const l = league ? src.leagues[league] : undefined;
  return l && l.n >= MIN_LEAGUE_GAMES && l.mh !== undefined && l.ma !== undefined ? { ...src.shrink, mh: l.mh, ma: l.ma } : src.shrink;
}
export interface TennisSource { groups: Record<string, { n: number; bias: number }>; tours: Record<string, { n: number; bias: number }>; all: { n: number; bias: number } | null }
type Calibs = Record<string, OutputCalib>;

const calibCache = new Map<string, Calibs>();
function readCalib(sport: MoreSport): Calibs {
  if (calibCache.has(sport)) return calibCache.get(sport)!;
  const out: Calibs = {};
  for (const r of db.prepare(`SELECT output, json FROM more_pred_calib WHERE sport = ?`).all(sport) as any[]) { try { out[r.output] = JSON.parse(r.json); } catch { /* skip */ } }
  calibCache.set(sport, out);
  return out;
}
function storeCalib(sport: MoreSport, c: Calibs) {
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM more_pred_calib WHERE sport = ?`).run(sport);
    const ins = db.prepare(`INSERT INTO more_pred_calib (sport, output, json, at) VALUES (?, ?, ?, ?)`);
    for (const [k, v] of Object.entries(c)) ins.run(sport, k, JSON.stringify(v), t);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  calibCache.set(sport, c);
}
/** the version a saved row was made with: the maths + when its fits were stored (a new fit re-saves the upcoming games) */
function calcStamp(sport: MoreSport): string {
  const r = db.prepare(`SELECT MAX(at) AS at FROM (SELECT at FROM more_pred_fit WHERE sport = ? AND league = 'source' UNION ALL SELECT at FROM more_pred_calib WHERE sport = ?)`).get(sport, sport) as any;
  return `${MORE_CALC}${r?.at ? `:${r.at}` : ''}`;
}

/** every set of an output with a calibration map goes through it (renormalised to 100%) */
export function applyCalib(x: Extras, c: Calibs | null): Extras {
  if (!c || !Object.keys(c).length) return x;
  const sets: Record<string, PSet> = {};
  for (const [k, s] of Object.entries(x.sets)) sets[k] = c[k] ? calibrateSet(s, c[k]) : s;
  return { ...x, sets, info: { ...x.info, calibrated: Object.keys(c).filter(k => x.sets[k]) } };
}

/* ---------- points (basketball, NFL / college) ---------- */

export interface PtsGame { league: string; pHome: number; margin: number; total: number; home: number; away: number; fit: LeagueFit }
const pointsFitOf = (src: PointsSource | null, league: string): PointsFit | null => {
  const l = src?.leagues[league];
  return l && l.n >= MIN_LEAGUE_GAMES ? l : src?.all || null;
};
/**
 * the bands of one game: the total and each side's points corrected (bias removed, pulled toward the league's mean
 * prediction by the fitted slope), measured spreads; the margin bands and the win chance as they are
 */
export function pointsMake(sport: 'basketball' | 'nfl', g: PtsGame, src: PointsSource | null): Extras {
  const pf = pointsFitOf(src, g.league);
  if (!pf) return normalExtras({ sport, pHome: g.pHome, margin: g.margin, total: g.total, homePts: g.home, awayPts: g.away, fit: g.fit });
  // centre: the league's own mean prediction (its fit, even a small one), else its typical total
  const own = src?.leagues[g.league], mT = own?.mT ?? g.fit.meanTotal, mH = own?.mH ?? g.fit.meanTotal / 2, mA = own?.mA ?? g.fit.meanTotal / 2;
  const { sd } = marginSpread(g.pHome, g.margin, g.fit.sigma), st = teamSd(g.fit.sigmaT, sd);
  const x = normalExtras({
    sport, pHome: g.pHome, margin: g.margin, fit: g.fit,
    total: correctPts(g.total, mT, pf.bT, pf.kT), homePts: correctPts(g.home, mH, pf.bH, pf.kH), awayPts: correctPts(g.away, mA, pf.bA, pf.kA),
    sdT: g.fit.sigmaT * pf.rT, sdHome: st * pf.rH, sdAway: st * pf.rA,
    // the shape of the misses: sport-wide (every league's games)
    shapeT: src?.all?.qT || null, shapeTeam: src?.all?.qTeam || null
  });
  return { ...x, info: { ...x.info, bias: [pf.bT, pf.bH, pf.bA], slope: [pf.kT ?? 1, pf.kH ?? 1, pf.kA ?? 1], spread: [pf.rT, pf.rH, pf.rA] } };
}
const ptsRow = (g: PtsGame, hs: number, as: number): PointsRow => ({
  league: g.league, total: g.total, home: g.home, away: g.away, hs, as, sdT: g.fit.sigmaT, sdTeam: teamSd(g.fit.sigmaT, marginSpread(g.pHome, g.margin, g.fit.sigma).sd)
});
export function fitPointsSource(rows: { league: string; row: PointsRow }[]): PointsSource {
  const by = new Map<string, PointsRow[]>();
  for (const r of rows) { const l = by.get(r.league) || []; l.push(r.row); by.set(r.league, l); }
  const leagues: Record<string, PointsFit> = {};
  for (const [l, rs] of by) { const f = fitPoints(rs); if (f) leagues[l] = f; }
  return { leagues, all: fitPoints(rows.map(r => r.row)) };
}

/* ---------- football ---------- */

export interface FbGame { league: string | null; xh: number; xa: number; share: number }
export function footballMake(g: FbGame, src: FootballSource | null): Extras {
  if (!src) return footballExtras(g.xh, g.xa, g.share, goalShrink());
  const l = g.league ? src.leagues[g.league] : undefined;
  return footballExtras(g.xh, g.xa, g.share, shrinkOfLeague(src, g.league), l && l.n >= MIN_LEAGUE_GAMES ? l : src.all);
}
export function fitFootballSource(rows: { league: string; xh: number; xa: number; hg: number; ag: number }[]): FootballSource {
  const shrink = fitGoalShrinkTD(rows) || DEFAULT_GOAL_SHRINK;
  const model = (rs: typeof rows, fallback: GoalModel | null, s: GoalShrink) => {
    const m = rs.map(r => { const [mh, ma] = shrinkPair(r.xh, r.xa, s); return { mh, ma, hg: r.hg, ag: r.ag }; });
    const dh = fitDispersion(m.map(r => ({ m: r.mh, y: r.hg }))), da = fitDispersion(m.map(r => ({ m: r.ma, y: r.ag })));
    return { n: rs.length, rho: fitRho(m) ?? fallback?.rho ?? -0.1, sizeH: dh.size, sizeA: da.size, dispersion: [dh.dispersion, da.dispersion] as [number, number] };
  };
  const all = model(rows, null, shrink);
  const by = new Map<string, typeof rows>();
  for (const r of rows) { const l = by.get(r.league) || []; l.push(r); by.set(r.league, l); }
  const leagues: FootballSource['leagues'] = {};
  for (const [l, rs] of by) {
    if (rs.length < MIN_LEAGUE_GAMES) continue;
    const mh = Math.round((rs.reduce((a, r) => a + r.hg, 0) / rs.length) * 1000) / 1000, ma = Math.round((rs.reduce((a, r) => a + r.ag, 0) / rs.length) * 1000) / 1000;
    leagues[l] = { ...model(rs, all, { ...shrink, mh, ma }), mh, ma };
  }
  return { shrink, leagues, all: { rho: all.rho, sizeH: all.sizeH, sizeA: all.sizeA } };
}

/* ---------- tennis ---------- */

type TDist = ReturnType<typeof tennisExtrasDist>;
export interface TnGame { group: string; tour: string; dist: TDist; bo: number }
const tennisBiasOf = (src: TennisSource | null, g: { group: string; tour: string }) => {
  const a = src?.groups[g.group];
  if (a && a.n >= MIN_LEAGUE_GAMES) return a.bias;
  const b = src?.tours[g.tour];
  if (b && b.n >= MIN_LEAGUE_GAMES) return b.bias;
  return src?.all?.bias || 0;
};
export function tennisMake(g: TnGame, src: TennisSource | null): Extras {
  const bias = tennisBiasOf(src, g);
  const x = tennisExtras(bias ? { ...g.dist, games: shiftGames(g.dist.games, bias) } : g.dist, g.bo);
  return bias ? { ...x, info: { ...x.info, gamesBias: Math.round(bias * 100) / 100 } } : x;
}
export function fitTennisSource(rows: { group: string; tour: string; pred: number; actual: number }[]): TennisSource {
  const agg = (rs: typeof rows) => ({ n: rs.length, bias: rs.length ? Math.round((rs.reduce((s, r) => s + r.pred - r.actual, 0) / rs.length) * 100) / 100 : 0 });
  const groups: TennisSource['groups'] = {}, tours: TennisSource['tours'] = {};
  const by = (key: (r: (typeof rows)[number]) => string) => { const m = new Map<string, typeof rows>(); for (const r of rows) { const k = key(r); const l = m.get(k) || []; l.push(r); m.set(k, l); } return m; };
  for (const [k, rs] of by(r => r.group)) groups[k] = agg(rs);
  for (const [k, rs] of by(r => r.tour)) tours[k] = agg(rs);
  return { groups, tours, all: rows.length ? agg(rows) : null };
}

/* ---------- the calibration layer ---------- */

/**
 * per output (3,000+ out-of-sample predictions), a map only when it helps on games it was not fitted on: fitted on the
 * first 70% (in time), kept when on the last 30% the worst 10% step gets smaller and the log loss lower (then refitted on
 * all). Margin: 'the other side wins' keeps its chance.
 */
export const MIN_CALIB_GAMES = 3000;
export function fitCalibs(sport: MoreSport, list: Eval[]): Calibs {
  const out: Calibs = {};
  for (const k of MORE_KEYS[sport]) {
    const items: { p: number[]; i: number; labels: string[] }[] = [];
    for (const e of list) { const s = e.x.sets[k]; if (!s) continue; const c = checkSet(s, e.actual[k]); if (c) items.push({ p: s.p, i: c.i, labels: s.labels }); }
    if (items.length < MIN_CALIB_GAMES) continue;
    const fixed = k === 'margin' ? ['loser'] : [];
    const cut = Math.floor(items.length * 0.7), fitPart = items.slice(0, cut), val = items.slice(cut);
    const c0 = fitOutputCalib(fitPart, fixed);
    if (!c0.pooled && !c0.perLabel) continue;
    const score = (xs: { p: number[]; i: number }[]) => ({ worst: calibrationOk(calibration(xs)).worst ?? Infinity, ll: xs.reduce((a, x) => a - Math.log(Math.max(1e-4, x.p[x.i])), 0) / xs.length });
    const was = score(val), now1 = score(val.map(x => ({ p: calibrateSet({ labels: x.labels, p: x.p }, c0).p, i: x.i })));
    if (!(now1.worst < was.worst && now1.ll < was.ll - 0.0002)) continue;
    const c = fitOutputCalib(items, fixed);
    if (c.pooled || c.perLabel) out[k] = { ...c, check: { worst: [r1(was.worst), r1(now1.worst)], logLoss: [r4(was.ll), r4(now1.ll)] } } as OutputCalib;
  }
  return out;
}
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/* ---------- source fits as stored ---------- */

const pointsSource = (sport: 'basketball' | 'nfl'): PointsSource | null => readFit(sport, 'source');
const footballSource = (): FootballSource | null => readFit('football', 'source');
const tennisSource = (): TennisSource | null => readFit('tennis', 'source');

/** sanity rule (fix204c): a league's usual total (finished games of the last ~13 months: mean, SD) */
const rangeCache = new Map<string, { at: number; v: { mean: number; sd: number; n: number } | null }>();
export function leagueRange(sport: 'basketball' | 'nfl', key: string | number) {
  const k = `${sport}|${key}`, hit = rangeCache.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.v;
  const since = new Date(Date.now() - 400 * DAY).toISOString();
  const r = (sport === 'basketball'
    ? db.prepare(`SELECT COUNT(*) AS n, AVG(hs + as_) AS m, AVG((hs + as_) * (hs + as_)) AS m2 FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL AND kickoff > ?`).get(String(key), since)
    : db.prepare(`SELECT COUNT(*) AS n, AVG(home_pts + away_pts) AS m, AVG((home_pts + away_pts) * (home_pts + away_pts)) AS m2 FROM nfl_games WHERE league = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL AND kickoff > ?`).get(Number(key), since)) as any;
  const v = r && r.n >= 50 ? { mean: r.m, sd: Math.sqrt(Math.max(1, r.m2 - r.m * r.m)), n: r.n } : null;
  rangeCache.set(k, { at: Date.now(), v });
  return v;
}
/** an expected total outside the league's usual range ± 3 SD: what is wrong, else null */
export function rangeAlarm(total: number, range: { mean: number; sd: number } | null): string | null {
  if (!range) return null;
  return Math.abs(total - range.mean) > 3 * range.sd ? `expected total ${Math.round(total)} outside ${Math.round(range.mean - 3 * range.sd)}–${Math.round(range.mean + 3 * range.sd)}` : null;
}

/* ------------------------------------------------------------------ */
/* B. Saving before the start                                           */
/* ------------------------------------------------------------------ */

const upsert = db.prepare(`INSERT INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, source_at, calc, admin_only, flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sport, game_id) DO UPDATE SET model = excluded.model, kickoff = excluded.kickoff, made_at = excluded.made_at, json = excluded.json, source_at = excluded.source_at,
    calc = excluded.calc, admin_only = excluded.admin_only, flag = excluded.flag
  WHERE prediction_extras.settled = 0 AND (prediction_extras.kickoff > excluded.made_at OR prediction_extras.kickoff <> excluded.kickoff)`);
const sourceStmt = db.prepare(`SELECT game_id, source_at, model, calc FROM prediction_extras WHERE sport = ? AND kickoff > ?`);

/** fix204b: what the last save of each sport did (data health shows it, so "0 missing" never hides "nothing tried") */
export interface SaveStat { at: string; sources: number; saved: number; unchanged: number; errors: number; flagged: number; lastError: string | null }
const saveStats = new Map<MoreSport, SaveStat>();
export const lastSave = (sport: MoreSport) => saveStats.get(sport) || null;

/** make: the extras (fixes + calibration); check: a sanity rule of its own (fix204c: the expected total in the league's range) */
interface Src { id: number; model: string; kickoff: string; at: string; make: () => Extras | null; check?: (x: Extras) => string | null }
async function save(sport: MoreSport, list: Src[], opts: { log?: boolean } = {}): Promise<number> {
  const t = now();
  const have = new Map((sourceStmt.all(sport, t) as any[]).map(r => [r.game_id as number, `${r.model}|${r.source_at}|${r.calc}`]));
  const slice = heavySlicer(30);
  const stamp = calcStamp(sport);
  const out: [Src, Extras, string | null][] = [];
  const st: SaveStat = { at: t, sources: list.length, saved: 0, unchanged: 0, errors: 0, flagged: 0, lastError: null };
  for (const s of list) {
    if (s.kickoff <= t) continue;
    if (have.get(s.id) === `${s.model}|${s.at}|${stamp}`) { st.unchanged++; continue; }
    try {
      const x = s.make();
      if (!x) continue;
      // sanity check: a band set with > 85% in one band is centred on the wrong league → this game's extras admin-only
      const band = bandAlarm(x), alarm = band ? `${band} in one band` : s.check?.(x) || null;
      if (alarm) { st.flagged++; logger.warn(`more predictions ${sport} ${s.id}: ${alarm} — admin only`); }
      out.push([s, x, alarm]);
    } catch (e: any) { st.errors++; st.lastError = `${s.id}: ${e.message}`; logger.warn(`more predictions ${sport} ${s.id}: ${e.message}`); }
    await slice();
  }
  if (out.length) {
    const at = now();
    db.exec('BEGIN');
    try {
      // a game that started while we were computing keeps what it had
      for (const [s, x, alarm] of out) if (Date.parse(s.kickoff) > Date.now()) { upsert.run(sport, s.id, s.model, s.kickoff, at, JSON.stringify(x), s.at, stamp, alarm ? 1 : 0, alarm); st.saved++; }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (opts.log !== false) saveStats.set(sport, st);
  return out.length;
}

function footballSources(only?: number): Src[] {
  const t = now();
  const rows = db.prepare(`SELECT match_id, model, competition_code, utc_date, xg_home, xg_away, updated_at FROM predictions
    WHERE locked = 0 AND settled = 0 AND utc_date > ? AND utc_date < ? AND xg_home IS NOT NULL AND xg_away IS NOT NULL ${only ? 'AND match_id = ?' : ''}`)
    .all(...[t, new Date(Date.now() + 8 * DAY).toISOString(), ...(only ? [only] : [])]) as any[];
  const best = new Map<number, any>();
  for (const r of rows) {
    if (mainRank(r.model, r.utc_date) >= 99) continue;
    const cur = best.get(r.match_id);
    if (!cur || mainRank(r.model, r.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(r.match_id, r);
  }
  const src = footballSource(), cal = readCalib('football');
  return [...best.values()].map(r => ({
    id: r.match_id, model: r.model, kickoff: r.utc_date, at: r.updated_at,
    make: () => applyCalib(footballMake({ league: divisionOf(r.competition_code), xh: r.xg_home, xa: r.xg_away, share: htShareFor(r.competition_code) }, src), cal)
  }));
}
function basketballSources(only?: number): Src[] {
  const rows = db.prepare(`SELECT game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at FROM bb_predictions WHERE kickoff > ? ${only ? 'AND game_id = ?' : ''}`)
    .all(...[now(), ...(only ? [only] : [])]) as any[];
  const src = pointsSource('basketball'), cal = readCalib('basketball');
  return rows.map(r => ({
    id: r.game_id, model: r.model, kickoff: r.kickoff, at: r.made_at,
    make: () => applyCalib(pointsMake('basketball', { league: r.code, pHome: r.p_home, margin: r.margin, total: r.total, home: r.home_pts, away: r.away_pts, fit: bbFit(r.code) }, src), cal),
    check: x => rangeAlarm(x.info.expected[0] + x.info.expected[1], leagueRange('basketball', r.code))
  }));
}
// NFL / tennis (fix204b): the game's own current start time (a moved game is saved under its new time), any row whose
// game has not started — the prediction table's copy of the time can lag behind the schedule
function nflSources(only?: number): Src[] {
  const rows = db.prepare(`SELECT p.game_id, COALESCE(g.kickoff, p.kickoff) AS kickoff, p.model, p.p_home, p.margin, p.total, p.home_pts, p.away_pts, p.made_at, g.league FROM nfl_predictions p
    JOIN nfl_games g ON g.game_id = p.game_id WHERE COALESCE(g.kickoff, p.kickoff) > ? AND (g.status IS NULL OR g.status = 'NS') ${only ? 'AND p.game_id = ?' : ''}`)
    .all(...[now(), ...(only ? [only] : [])]) as any[];
  const src = pointsSource('nfl'), cal = readCalib('nfl');
  return rows.map(r => ({
    id: r.game_id, model: r.model, kickoff: r.kickoff, at: r.made_at,
    make: () => applyCalib(pointsMake('nfl', { league: String(r.league || 1), pHome: r.p_home, margin: r.margin, total: r.total, home: r.home_pts, away: r.away_pts, fit: nflFit(r.league || 1) }, src), cal),
    check: x => rangeAlarm(x.info.expected[0] + x.info.expected[1], leagueRange('nfl', r.league || 1))
  }));
}
/** the chain behind a saved tennis prediction (its serve chances rescaled to its win chance) */
export function tennisExtrasFor(p1: number, servePoint: [number, number] | null, bo: number, rule: number): Extras {
  const b = bo === 5 ? 5 : 3;
  const { pa, pb } = tennisServeChances(servePoint, p1, b, rule);
  return tennisExtras(tennisExtrasDist(pa, pb, b, rule), b);
}
/** tennis bias groups: tour (slam / atp / wta / challenger) × best of × surface */
export const tennisGroup = (tour: string, bo: number, surface: string | null) => {
  const s = String(surface || '').toLowerCase(), sf = /clay/.test(s) ? 'clay' : /grass/.test(s) ? 'grass' : /hard|carpet|indoor/.test(s) ? 'hard' : 'other';
  return `${tour}|bo${bo}|${sf}`;
};
function tennisSources(only?: number): Src[] {
  const rows = db.prepare(`SELECT p.match_id, p.model, COALESCE(m.scheduled_at, p.scheduled_at) AS scheduled_at, p.p1, p.why, p.made_at, p.cat, m.best_of, m.tier, m.surface FROM tennis_predictions p
    JOIN tennis_matches m ON m.id = p.match_id WHERE COALESCE(m.scheduled_at, p.scheduled_at) > ?
      AND COALESCE(m.status, '') IN ('', 'upcoming', 'scheduled', 'not_started') ${only ? 'AND p.match_id = ?' : ''}`)
    .all(...[now(), ...(only ? [only] : [])]) as any[];
  const src = tennisSource(), cal = readCalib('tennis');
  return rows.map(r => ({
    id: r.match_id, model: r.model, kickoff: r.scheduled_at, at: r.made_at,
    make: () => {
      let why: any = null;
      try { why = r.why ? JSON.parse(r.why) : null; } catch { why = null; }
      const sp = Array.isArray(why?.numbers?.servePoint) ? why.numbers.servePoint as [number, number] : null;
      const bo = r.best_of === 5 ? 5 : 3, rule = tennisRuleFor(r.tier, r.scheduled_at);
      const { pa, pb } = tennisServeChances(sp, r.p1, bo, rule);
      const tour = String(r.cat || 'atp');
      return applyCalib(tennisMake({ group: tennisGroup(tour, bo, r.surface), tour, dist: tennisExtrasDist(pa, pb, bo, rule), bo }, src), cal);
    }
  }));
}
const SOURCES: Record<MoreSport, (only?: number) => Src[]> = { football: footballSources, basketball: basketballSources, nfl: nflSources, tennis: tennisSources };
/** fix204b: one game now (the page asked for a game whose extras the 5-minute job has not saved yet) */
export async function saveOne(sport: MoreSport, id: number): Promise<boolean> {
  try { return (await save(sport, SOURCES[sport](id), { log: false })) > 0; } catch (e: any) { logger.warn(`more predictions ${sport} ${id}: ${e.message}`); return false; }
}
/** the page may pass the unlock id (nflRid / tennisRid / basketball's negative id) instead of the game id: accept both */
export function gameIdOf(sport: MoreSport, id: number): number {
  if (id >= 0) return id;
  if (sport === 'nfl' && id <= -2e9 && id > -4e9) return -id - 2e9;
  if (sport === 'tennis' && id <= -4e9) return -id - 4e9;
  if (sport === 'basketball') return -id;
  return id;
}
export async function saveExtras(sport?: MoreSport): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const s of sport ? [sport] : MORE_SPORTS) {
    try { out[s] = await save(s, SOURCES[s]()); } catch (e: any) { logger.warn(`more predictions save ${s}: ${e.message}`); }
    await yieldLoop();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* C. Checking after the game                                           */
/* ------------------------------------------------------------------ */

type Actual = Record<string, string | number | null>;
const yn = (b: boolean) => (b ? 'yes' : 'no');
const hda = (h: number, a: number) => (h > a ? 'H' : h === a ? 'D' : 'A');
export function footballActual(hg: number, ag: number, ht: [number, number] | null): Actual {
  return {
    score: hg <= 5 && ag <= 5 ? `${hg}-${ag}` : 'other', goals: hg + ag, homeGoals: hg, awayGoals: ag,
    cleanHome: yn(ag === 0), cleanAway: yn(hg === 0), win2Home: yn(hg - ag >= 2), win2Away: yn(ag - hg >= 2),
    ht: ht ? hda(ht[0], ht[1]) : null, htft: ht ? `${hda(ht[0], ht[1])}/${hda(hg, ag)}` : null
  };
}
export function pointsActual(x: Extras, hs: number, as: number, q: { h: (number | null)[]; a: (number | null)[] } | null, overtime: boolean | null): Actual {
  const side = x.info?.side === 'A' ? -1 : 1;
  const halfOk = q && q.h[0] != null && q.h[1] != null && q.a[0] != null && q.a[1] != null;
  const h2 = halfOk ? (q!.h[0] || 0) + (q!.h[1] || 0) : 0, a2 = halfOk ? (q!.a[0] || 0) + (q!.a[1] || 0) : 0;
  return { margin: side * (hs - as), total: hs + as, homePts: hs, awayPts: as, half: halfOk ? hda(h2, a2) : null, ot: overtime === null ? null : yn(overtime) };
}
export function tennisActual(games: [number[], number[]], rule: number): Actual | null {
  const [a, b] = games;
  if (!a?.length || a.length !== b?.length) return null;
  let w1 = 0, w2 = 0, tot = 0, tb = false;
  a.forEach((x, i) => {
    const y = b[i], last = i === a.length - 1;
    if (x > y) w1++; else if (y > x) w2++;
    const matchTb = rule === 2 && last && Math.max(x, y) >= 10;
    tot += matchTb ? 1 : x + y;
    if (matchTb || (Math.max(x, y) === 7 && Math.min(x, y) === 6)) tb = true;
  });
  return { sets: `${w1}-${w2}`, first: a[0] > b[0] ? '1' : '2', games: tot, tb: yn(tb) };
}
export function checkExtras(x: Extras, actual: Actual): { actual: Actual; checks: Record<string, SetCheck> } {
  const checks: Record<string, SetCheck> = {};
  for (const [k, set] of Object.entries(x.sets)) { const c = checkSet(set, actual[k]); if (c) checks[k] = c; }
  return { actual, checks };
}

const markStmt = db.prepare(`UPDATE prediction_extras SET settled = ?, result = ?, settled_at = ? WHERE sport = ? AND game_id = ?`);
const VOID_BB = new Set(['CANC', 'ABD', 'AWD']);
export function settleExtras(): Record<string, number> {
  const out: Record<string, number> = { football: 0, basketball: 0, nfl: 0, tennis: 0 };
  const t = now();
  const mark = (sport: MoreSport, id: number, res: ReturnType<typeof checkExtras> | null) => { markStmt.run(res ? 1 : 2, res ? JSON.stringify(res) : null, t, sport, id); out[sport]++; };
  const parse = (s: string): Extras | null => { try { return JSON.parse(s); } catch { return null; } };
  db.exec('BEGIN');
  try {
    for (const r of db.prepare(`SELECT e.game_id, e.json, r.home_goals, r.away_goals, r.outcome, r.ht_home, r.ht_away FROM prediction_extras e
      JOIN results r ON r.match_id = e.game_id WHERE e.sport = 'football' AND e.settled = 0`).all() as any[]) {
      const x = parse(r.json);
      if (!x || r.outcome === 'VOID' || r.home_goals == null) { mark('football', r.game_id, null); continue; }
      mark('football', r.game_id, checkExtras(x, footballActual(r.home_goals, r.away_goals, r.ht_home != null && r.ht_away != null ? [r.ht_home, r.ht_away] : null)));
    }
    for (const r of db.prepare(`SELECT e.game_id, e.json, g.status, g.hs, g.as_, g.quarters FROM prediction_extras e JOIN bb_games g ON g.game_id = e.game_id
      WHERE e.sport = 'basketball' AND e.settled = 0 AND g.status IN ('FT','AOT','CANC','ABD','AWD')
        AND e.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL)`).all() as any[]) {
      const x = parse(r.json);
      if (!x || VOID_BB.has(r.status) || r.hs == null) { mark('basketball', r.game_id, null); continue; }
      const q = parseQ(r.quarters);
      mark('basketball', r.game_id, checkExtras(x, pointsActual(x, r.hs, r.as_, q, r.status === 'AOT' || (q ? (q.h[4] || 0) + (q.a[4] || 0) > 0 : false))));
    }
    for (const r of db.prepare(`SELECT e.game_id, e.json, g.status, g.home_pts, g.away_pts, g.quarters FROM prediction_extras e JOIN nfl_games g ON g.game_id = e.game_id
      WHERE e.sport = 'nfl' AND e.settled = 0 AND g.status IN ('FT','AOT','CANC','ABD','AWD')`).all() as any[]) {
      const x = parse(r.json);
      if (!x || r.status === 'CANC' || r.status === 'ABD' || r.status === 'AWD' || r.home_pts == null) { mark('nfl', r.game_id, null); continue; }
      const q = parseQ(r.quarters);
      mark('nfl', r.game_id, checkExtras(x, pointsActual(x, r.home_pts, r.away_pts, q, r.status === 'AOT' || (q ? (q.h[4] || 0) + (q.a[4] || 0) > 0 : false))));
    }
    for (const r of db.prepare(`SELECT e.game_id, e.json, m.status, m.winner, m.outcome, m.games, m.tier, m.scheduled_at FROM prediction_extras e JOIN tennis_matches m ON m.id = e.game_id
      WHERE e.sport = 'tennis' AND e.settled = 0 AND m.status IN ('completed','cancelled','canceled','walkover','abandoned')`).all() as any[]) {
      const x = parse(r.json);
      let g: any = null;
      try { g = r.games ? JSON.parse(r.games) : null; } catch { g = null; }
      // retirements, walkovers and abandoned matches end early: no check (void)
      const early = /retired|walkover|default|abandoned|unresolved/.test(String(r.outcome || '')) || r.status !== 'completed' || !(r.winner === 1 || r.winner === 2);
      const act = !early && Array.isArray(g) ? tennisActual(g as [number[], number[]], tennisRuleFor(r.tier, r.scheduled_at)) : null;
      mark('tennis', r.game_id, x && act ? checkExtras(x, act) : null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (Object.values(out).some(Boolean)) { recordCache.clear(); logger.info(`More predictions checked: ${JSON.stringify(out)}`); }
  return out;
}

/* ------------------------------------------------------------------ */
/* F. Public gates (from the backtest)                                 */
/* ------------------------------------------------------------------ */

let gateCache: { at: number; v: Map<string, { public: boolean; games: number; worst: number | null; why: string | null }> } | null = null;
function gates() {
  if (!gateCache || Date.now() - gateCache.at > 60 * 1000) {
    const v = new Map((db.prepare(`SELECT sport, output, public, games, worst, why FROM more_pred_gate`).all() as any[]).map(r => [`${r.sport}|${r.output}`, { public: !!r.public, games: r.games, worst: r.worst, why: r.why }]));
    gateCache = { at: Date.now(), v };
  }
  return gateCache.v;
}
/** the outputs of a sport visitors see (admins: all of them) */
export function publicKeys(sport: MoreSport, admin: boolean): string[] {
  const g = gates();
  return MORE_KEYS[sport].filter(k => admin || g.get(`${sport}|${k}`)?.public);
}
export function gateList() {
  const g = gates();
  return MORE_SPORTS.map(s => ({ sport: s, outputs: MORE_KEYS[s].map(k => ({ output: k, ...(g.get(`${s}|${k}`) || { public: false, games: 0, worst: null, why: 'no backtest yet' }) })) }));
}

interface Eval { x: Extras; actual: Actual }
/** per output: games, top-pick hit rate, Brier, log loss, said vs happened (10% steps), the public rule */
export function summarise(sport: MoreSport, list: Eval[], keys: string[] = MORE_KEYS[sport]) {
  const out: Record<string, any> = {};
  for (const k of keys) {
    const pairs: { p: number[]; i: number }[] = [];
    let hits = 0, brier = 0, ll = 0;
    for (const e of list) {
      const set = e.x.sets[k];
      if (!set) continue;
      const c = checkSet(set, e.actual[k]);
      if (!c) continue;
      pairs.push({ p: set.p, i: c.i });
      if (c.hit) hits++;
      brier += c.brier; ll += c.logLoss;
    }
    const n = pairs.length, bins = calibration(pairs), ok = calibrationOk(bins);
    out[k] = {
      games: n, hitRate: n ? Math.round((1000 * hits) / n) / 10 : null, brier: n ? Math.round((brier / n) * 10000) / 10000 : null,
      logLoss: n ? Math.round((ll / n) * 10000) / 10000 : null, calibration: bins, public: ok.ok, worst: ok.worst
    };
  }
  return out;
}
function writeGates(sport: MoreSport, sum: Record<string, any>, note: string, extra: Record<string, any> = {}) {
  const t = now();
  const up = db.prepare(`INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const k of MORE_KEYS[sport]) {
    const s = sum[k];
    const why = !s || !s.games ? 'no backtest games' : s.worst === null ? 'no 10% step with 100+ forecasts' : s.public ? null : `calibration off by ${s.worst} points in a step with 100+ forecasts`;
    up.run(sport, k, s?.public ? 1 : 0, s?.games || 0, s?.worst ?? null, why, t);
  }
  db.prepare(`INSERT OR REPLACE INTO more_pred_backtest (sport, report, at) VALUES (?, ?, ?)`).run(sport, JSON.stringify({ note, outputs: sum, ...extra }), t);
  gateCache = null;
}

/* ---------- walk-forward backtests (fix204c) ---------- */
/*
 * Every sport: the model's walk-forward pre-game numbers of every stored game (items), in periods (a league's season,
 * a football season, a tennis year). Each period is predicted with the source fits made only on the games before it
 * (out of sample); the calibration maps of a test period are fitted only on those out-of-sample predictions of the
 * games before it. "before" = the fix204b maths on the same test games. The live fits use every game, the live maps
 * every out-of-sample prediction.
 */
interface WItem<G> { t: number; period: string; test: boolean; g: G; base: Extras | null; actual: Actual }
interface Engine<G, S> { fit: (train: WItem<G>[]) => S; make: (g: G, s: S) => Extras }
interface BtResult<S> { before: Eval[]; after: Eval[]; live: S | null; calib: Calibs; periods: number }
/** a period needs this many earlier games for its out-of-sample fits */
const MIN_TRAIN = 300;

async function walkForward<G, S>(sport: MoreSport, items: WItem<G>[], eng: Engine<G, S>): Promise<BtResult<S>> {
  const slice = heavySlicer(30);
  const periods = new Map<string, WItem<G>[]>();
  for (const i of items) { const l = periods.get(i.period) || []; l.push(i); periods.set(i.period, l); }
  // fits by cut-off day (leagues whose seasons start the same day share them)
  const srcByDay = new Map<number, S>();
  const oos = new Map<WItem<G>, Extras>();
  for (const list of periods.values()) {
    const day = Math.floor(Math.min(...list.map(i => i.t)) / DAY), cut = day * DAY;
    if (!srcByDay.has(day)) {
      const train = items.filter(i => i.t < cut);
      if (train.length < MIN_TRAIN) continue;
      srcByDay.set(day, eng.fit(train));
      await slice();
    }
    const src = srcByDay.get(day)!;
    for (const i of list) { oos.set(i, eng.make(i.g, src)); await slice(); }
  }
  const before: Eval[] = [], after: Eval[] = [];
  const calByDay = new Map<number, Calibs>();
  for (const list of periods.values()) {
    if (!list[0].test) continue;
    const day = Math.floor(Math.min(...list.map(i => i.t)) / DAY), cut = day * DAY;
    if (!calByDay.has(day)) {
      const earlier: Eval[] = [];
      for (const i of items) if (i.t < cut && oos.has(i)) earlier.push({ x: oos.get(i)!, actual: i.actual });
      calByDay.set(day, fitCalibs(sport, earlier));
      await slice();
    }
    const cal = calByDay.get(day)!;
    for (const i of list) {
      const x = oos.get(i);
      if (!x || !i.base) continue; // no earlier games to fit on: not testable out of sample
      before.push({ x: i.base, actual: i.actual });
      after.push({ x: applyCalib(x, cal), actual: i.actual });
    }
    await slice();
  }
  if (!items.length) return { before, after, live: null, calib: {}, periods: periods.size };
  const all: Eval[] = [];
  for (const i of items) { const x = oos.get(i); if (x) all.push({ x, actual: i.actual }); }
  return { before, after, live: eng.fit(items), calib: fitCalibs(sport, all), periods: periods.size };
}

/* ---------- points (basketball, NFL / college) ---------- */

type PtsItem = PtsGame & { hs: number; as: number };
export const PTS_WINDOW_DAYS = 400;
const pointsEngine = (sport: 'basketball' | 'nfl'): Engine<PtsItem, PointsSource> => ({
  // the last ~13 months before the cut: the first seasons' walk-forward numbers (cold ratings) are noisier and pulled
  // the slope too far (local test, 2 seasons × 18 leagues: all history total log loss 1.5227, last 400 days 1.5203)
  fit: train => {
    const last = train.length ? train[train.length - 1].t : 0;
    return fitPointsSource(train.filter(i => i.t > last - PTS_WINDOW_DAYS * DAY).map(i => ({ league: i.g.league, row: ptsRow(i.g, i.g.hs, i.g.as) })));
  },
  make: (g, s) => pointsMake(sport, g, s)
});
const r1 = (x: number) => Math.round(x * 10) / 10;
/** cause, per league: bias (predicted − actual) of the total and each side, spread ratio (de-biased misses ÷ the spread used) */
function pointsDiag(items: WItem<PtsItem>[]) {
  const by = new Map<string, WItem<PtsItem>[]>();
  for (const i of items) { const l = by.get(i.g.league) || []; l.push(i); by.set(i.g.league, l); }
  const one = (rs: WItem<PtsItem>[]) => {
    const f = fitPoints(rs.map(i => ptsRow(i.g, i.g.hs, i.g.as)));
    return f ? { ...f, meanPred: r1(rs.reduce((s, i) => s + i.g.total, 0) / rs.length), meanActual: r1(rs.reduce((s, i) => s + i.g.hs + i.g.as, 0) / rs.length), sigmaT: r1(rs.reduce((s, i) => s + i.g.fit.sigmaT, 0) / rs.length) } : { n: rs.length };
  };
  return { leagues: Object.fromEntries([...by].map(([l, rs]) => [l, one(rs)])), all: one(items) };
}
const otOf = (status: string, q: { h: (number | null)[]; a: (number | null)[] } | null) => status === 'AOT' || (q ? (q.h[4] || 0) + (q.a[4] || 0) > 0 : false);

/** basketball: bb-v3's walk-forward predictions of every league; test = each league's last two seasons */
export async function backtestBasketball() {
  const codes = (db.prepare(`SELECT DISTINCT code FROM bb_games`).all() as any[]).map(r => r.code as string);
  const items: WItem<PtsItem>[] = [];
  let leagues = 0;
  for (const code of codes) {
    const wf = bbWalkForward(code).rows, info = leagueModelInfo(code);
    if (!wf.length || !info) continue;
    const games = new Map((db.prepare(`SELECT game_id, season, kickoff, status, hs, as_, quarters FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL`)
      .all(code) as any[]).map(r => [r.game_id, r]));
    const seasons = [...new Set([...games.values()].map(g => g.season as string))].sort();
    const test = new Set(seasons.slice(-2));
    const first = [...games.values()].filter(g => test.has(g.season)).reduce((m, g) => (g.kickoff < m ? g.kickoff : m), '9999');
    // the league's halves / overtime factors and typical total from the seasons before the test seasons
    const f0 = fitFromQuarters(bbGamesOf(code, first), { sigma: info.sigma, sigmaT: info.sigmaTotal, meanTotal: 2 * info.avgPoints });
    const fit: LeagueFit = { ...f0, sigma: info.sigma, sigmaT: info.sigmaTotal };
    for (const [id, pHome, margin, total] of wf) {
      const g = games.get(id);
      if (!g) continue;
      const pg: PtsItem = { league: code, pHome, margin, total, home: (total + margin) / 2, away: (total - margin) / 2, fit, hs: g.hs, as: g.as_ };
      const base = test.has(g.season) ? normalExtras({ sport: 'basketball', pHome, margin, total, homePts: pg.home, awayPts: pg.away, fit }) : null;
      const q = parseQ(g.quarters);
      const x = base || normalExtras({ sport: 'basketball', pHome, margin, total, homePts: pg.home, awayPts: pg.away, fit });
      items.push({ t: Date.parse(g.kickoff), period: `${code}|${g.season}`, test: test.has(g.season), g: pg, base, actual: pointsActual(x, g.hs, g.as_, q, otOf(g.status, q)) });
    }
    leagues++;
    await afterLiveYield();
  }
  items.sort((a, b) => a.t - b.t);
  const r = await walkForward('basketball', items, pointsEngine('basketball'));
  return { ...r, diag: pointsDiag(items), note: `bb-v3 walk-forward predictions of ${leagues} leagues (${items.length} games); test = each league's last two seasons (${r.after.length} games), fits and calibration from the games before each` };
}

/** NFL and college: the walk-forward games of the model report — built now from the stored history when none is stored */
export async function backtestNfl() {
  const items: WItem<PtsItem>[] = [];
  const parts: string[] = [];
  for (const lg of [1, 2] as const) {
    let wf = nflWalkForward(lg);
    if (!wf.length) {
      const done = (db.prepare(`SELECT COUNT(*) AS n FROM nfl_games WHERE league = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL`).get(lg) as any)?.n || 0;
      if (done >= 200) {
        // the same walk-forward as the weekly model report (it stores the test games' pre-game numbers)
        logger.info(`more backtest nfl: building the ${lg === 1 ? 'NFL' : 'college'} walk-forward report now (${done} finished games)`);
        try { await buildNflReport(lg); } catch (e: any) { logger.warn(`more backtest nfl ${lg}: report failed: ${e.message}`); }
        wf = nflWalkForward(lg);
      }
    }
    if (!wf.length) { parts.push(`${lg === 1 ? 'NFL' : 'college'}: no walk-forward games (not enough finished games)`); continue; }
    const rows = new Map((db.prepare(`SELECT game_id, season, kickoff, status, home_pts, away_pts, quarters FROM nfl_games WHERE league = ? AND status IN ('FT','AOT') AND home_pts IS NOT NULL AND away_pts IS NOT NULL`).all(lg) as any[]).map(r => [r.game_id, r]));
    const seasons = [...new Set(wf.map(w => rows.get(w[0])?.season).filter(s => s !== undefined))].sort((a, b) => a - b);
    const test = new Set(seasons.slice(-2));
    const first = wf.filter(w => test.has(rows.get(w[0])?.season)).reduce((m, w) => (rows.get(w[0])!.kickoff < m ? rows.get(w[0])!.kickoff : m), '9999');
    // spreads from the seasons before the test seasons (the test seasons' own misses would be hindsight)
    let m2 = 0, t2 = 0, n = 0;
    for (const [id, , margin, total] of wf) { const r = rows.get(id); if (!r || r.kickoff >= first) continue; m2 += (r.home_pts - r.away_pts - margin) ** 2; t2 += (r.home_pts + r.away_pts - total) ** 2; n++; }
    const spreads = n >= 100 ? { sigma: Math.sqrt(m2 / n), sigmaT: Math.sqrt(t2 / n), meanTotal: NFL_DEFAULT[lg].meanTotal } : NFL_DEFAULT[lg];
    const fit = fitFromQuarters(nflGamesOf(lg, first), spreads);
    let k = 0;
    for (const [id, pHome, margin, total] of wf) {
      const g = rows.get(id);
      if (!g) continue;
      const pg: PtsItem = { league: String(lg), pHome, margin, total, home: (total + margin) / 2, away: (total - margin) / 2, fit, hs: g.home_pts, as: g.away_pts };
      const x = normalExtras({ sport: 'nfl', pHome, margin, total, homePts: pg.home, awayPts: pg.away, fit });
      const q = parseQ(g.quarters);
      items.push({ t: Date.parse(g.kickoff), period: `${lg}|${g.season}`, test: test.has(g.season), g: pg, base: test.has(g.season) ? x : null, actual: pointsActual(x, g.home_pts, g.away_pts, q, otOf(g.status, q)) });
      k++;
    }
    parts.push(`${lg === 1 ? 'NFL' : 'college'}: ${k} walk-forward games, test seasons ${[...test].join(', ')}`);
    await afterLiveYield();
  }
  items.sort((a, b) => a.t - b.t);
  const r = await walkForward('nfl', items, pointsEngine('nfl'));
  return { ...r, diag: pointsDiag(items), note: `nfl-v1 / ncaa-v1 walk-forward games; ${parts.join('; ')}` };
}

/* ---------- football ---------- */

type FbItem = FbGame & { league: string; hg: number; ag: number };
const footballEngine: Engine<FbItem, FootballSource> = {
  fit: train => fitFootballSource(train.map(i => ({ league: i.g.league, xh: i.g.xh, xa: i.g.xa, hg: i.g.hg, ag: i.g.ag }))),
  make: (g, s) => footballMake(g, s)
};
const poisTail4 = (m: number) => { let p = Math.exp(-m), c = p; for (let k = 1; k < 4; k++) { p *= m / k; c += p; } return 1 - c; };
/** cause: total-goals bias and dispersion per division and by expected-goals band; P(4+) said (fix204b) vs after vs happened */
function footballDiag(items: WItem<FbItem>[], live: FootballSource | null) {
  const sh = live?.shrink || DEFAULT_GOAL_SHRINK;
  // what fix204b said: the per-side shrink, independent Poisson
  const old = fitGoalShrink(items.map(i => ({ xh: i.g.xh, xa: i.g.xa, hg: i.g.hg, ag: i.g.ag }))) || DEFAULT_GOAL_SHRINK;
  const one = (rs: WItem<FbItem>[], withAfter: boolean) => {
    const n = rs.length;
    if (!n) return { n };
    let raw = 0, shr = 0, goals = 0, ss = 0, said4 = 0, after4 = 0, hap4 = 0;
    for (const i of rs) {
      const [ph, pa] = shrinkPair(i.g.xh, i.g.xa, live ? shrinkOfLeague(live, i.g.league) : sh), m = ph + pa, y = i.g.hg + i.g.ag;
      raw += i.g.xh + i.g.xa; shr += m; goals += y; ss += (y - m) ** 2;
      const [oh, oa] = shrinkPair(i.g.xh, i.g.xa, old);
      said4 += poisTail4(oh + oa); hap4 += y >= 4 ? 1 : 0;
      if (withAfter && live) after4 += footballMake(i.g, live).sets.goals.p[4];
    }
    return {
      n, expectedRaw: r2(raw / n), expectedShrunk: r2(shr / n), goals: r2(goals / n), biasRaw: r2((raw - goals) / n), biasShrunk: r2((shr - goals) / n),
      dispersion: r2(ss / Math.max(1e-9, shr)), said4: r1((100 * said4) / n), ...(withAfter && live ? { after4: r1((100 * after4) / n) } : {}), happened4: r1((100 * hap4) / n)
    };
  };
  const by = new Map<string, WItem<FbItem>[]>();
  for (const i of items) { const l = by.get(i.g.league) || []; l.push(i); by.set(i.g.league, l); }
  const BANDS: [number, number][] = [[0, 2], [2, 2.5], [2.5, 3], [3, 3.5], [3.5, 4], [4, 99]];
  return {
    shrink: sh, leagues: Object.fromEntries([...by].map(([l, rs]) => [l, { ...one(rs, false), ...(live?.leagues[l] ? { rho: live.leagues[l].rho, nb: [live.leagues[l].sizeH, live.leagues[l].sizeA], dispersionHA: live.leagues[l].dispersion } : {}) }])),
    bands: BANDS.map(([a, b]) => ({ band: b > 50 ? `${a}+` : `${a}–${b}`, ...one(items.filter(i => i.g.xh + i.g.xa >= a && i.g.xh + i.g.xa < b), true) })),
    all: one(items, false)
  };
}
const r2 = (x: number) => Math.round(x * 100) / 100;

/** football: grid-v3's walk-forward predictions of every stored season (backtest tables); test = the last two seasons */
export async function backtestFootball() {
  const seasons = (db.prepare(`SELECT DISTINCT season FROM backtest_runs WHERE model = 'grid-v3' ORDER BY season`).all() as any[]).map(r => r.season as string);
  if (!seasons.length) return { before: [], after: [], live: null, calib: {}, periods: 0, diag: null, note: 'no grid-v3 backtest runs stored' };
  const test = new Set(seasons.slice(-2));
  const rows = db.prepare(`SELECT r.season, b.division, b.date, b.home, b.away, b.hg, b.ag, b.xg_home, b.xg_away, h.ht_hg, h.ht_ag, MAX(b.run_id) AS run
    FROM backtest_predictions b JOIN backtest_runs r ON r.id = b.run_id AND r.model = 'grid-v3'
    LEFT JOIN ht_scores h ON h.division = b.division AND h.date = b.date AND h.home = b.home AND h.away = b.away
    WHERE b.xg_home IS NOT NULL AND b.xg_away IS NOT NULL GROUP BY b.division, b.date, b.home, b.away ORDER BY b.date`).all() as any[];
  // fix204b's shrink of each test season (fitted on the seasons before it): the "before" numbers
  const shrinkOf = new Map([...test].map(s => [s, fitGoalShrink(rows.filter(r => r.season < s).map(r => ({ xh: r.xg_home, xa: r.xg_away, hg: r.hg, ag: r.ag })))]));
  // running first-half share per division from every stored half-time score before the match
  const hist = db.prepare(`SELECT h.division AS d, h.date, h.ht_hg + h.ht_ag AS ht, m.hg + m.ag AS ft FROM ht_scores h
    JOIN history_matches m ON m.division = h.division AND m.date = h.date AND m.home = h.home AND m.away = h.away ORDER BY h.date`).all() as any[];
  const acc = new Map<string, { n: number; ht: number; ft: number }>();
  let k = 0;
  const items: WItem<FbItem>[] = [];
  const slice = heavySlicer(30);
  for (const r of rows) {
    while (k < hist.length && hist[k].date < r.date) { const a = acc.get(hist[k].d) || { n: 0, ht: 0, ft: 0 }; a.n++; a.ht += hist[k].ht; a.ft += hist[k].ft; acc.set(hist[k].d, a); k++; }
    const a = acc.get(r.division), share = a && a.n >= MIN_FIT_GAMES && a.ft > 0 ? a.ht / a.ft : DEFAULT_HT_SHARE;
    const isTest = test.has(r.season);
    items.push({
      t: Date.parse(r.date), period: `${r.division}|${r.season}`, test: isTest, g: { league: r.division, xh: r.xg_home, xa: r.xg_away, share, hg: r.hg, ag: r.ag },
      base: isTest ? footballExtras(r.xg_home, r.xg_away, share, shrinkOf.get(r.season) || null) : null,
      actual: footballActual(r.hg, r.ag, r.ht_hg != null ? [r.ht_hg, r.ht_ag] : null)
    });
    await slice();
  }
  const r = await walkForward('football', items, footballEngine);
  return {
    ...r, diag: footballDiag(items, r.live),
    note: `grid-v3 walk-forward predictions, seasons ${seasons.join(', ')} (${items.length} games); test ${[...test].join(', ')} (${r.after.length} games), goal model and calibration from the seasons before each; before = fix204b (shrink k ${[...test].map(s => `${s}: ${shrinkOf.get(s)?.k ?? 'none'}`).join(', ')}, independent Poisson)`
  };
}

/* ---------- tennis ---------- */

type TnItem = TnGame & { games: number; p1: number };
const tennisEngine: Engine<TnItem, TennisSource> = {
  fit: train => fitTennisSource(train.map(i => ({ group: i.g.group, tour: i.g.tour, pred: meanOf(i.g.dist.games), actual: i.g.games }))),
  make: (g, s) => tennisMake(g, s)
};
/** cause: total-games bias and spread per tour / format / surface; tie-break and straight sets by match-up strength */
function tennisDiag(items: WItem<TnItem>[]) {
  const sdOf = (d: ArrayLike<number>) => { const m = meanOf(d); let v = 0; for (let x = 0; x < d.length; x++) v += d[x] * (x - m) ** 2; return Math.sqrt(v); };
  const by = new Map<string, WItem<TnItem>[]>();
  for (const i of items) { const l = by.get(i.g.group) || []; l.push(i); by.set(i.g.group, l); }
  const groups = Object.fromEntries([...by].map(([gk, rs]) => {
    const n = rs.length, pred = rs.reduce((s, i) => s + meanOf(i.g.dist.games), 0) / n, act = rs.reduce((s, i) => s + i.g.games, 0) / n;
    const miss = Math.sqrt(rs.reduce((s, i) => s + (i.g.games - meanOf(i.g.dist.games) - (pred - act)) ** 2, 0) / n), used = Math.sqrt(rs.reduce((s, i) => s + sdOf(i.g.dist.games) ** 2, 0) / n);
    return [gk, { n, predicted: r1(pred), actual: r1(act), bias: r2(pred - act), spreadRatio: r2(miss / Math.max(1e-9, used)) }];
  }));
  const BUCKETS: [number, number][] = [[0.5, 0.6], [0.6, 0.75], [0.75, 0.9], [0.9, 1.01]];
  const strength = BUCKETS.map(([a, b]) => {
    const rs = items.filter(i => { const f = Math.max(i.g.p1, 1 - i.g.p1); return f >= a && f < b; });
    if (!rs.length) return { favourite: `${a * 100}–${Math.min(100, b * 100)}%`, n: 0 };
    let tbS = 0, tbH = 0, stS = 0, stH = 0;
    for (const i of rs) {
      const x = i.base!, sets = x.sets.sets, need = i.g.bo === 5 ? 3 : 2;
      tbS += x.sets.tb.p[0]; tbH += i.actual.tb === 'yes' ? 1 : 0;
      stS += sets.p[sets.labels.indexOf(`${need}-0`)] + sets.p[sets.labels.indexOf(`0-${need}`)];
      stH += i.actual.sets === `${need}-0` || i.actual.sets === `0-${need}` ? 1 : 0;
    }
    return { favourite: `${a * 100}–${Math.min(100, b * 100)}%`, n: rs.length, tieBreakSaid: r1((100 * tbS) / rs.length), tieBreakHappened: r1((100 * tbH) / rs.length), straightSaid: r1((100 * stS) / rs.length), straightHappened: r1((100 * stH) / rs.length) };
  });
  return { groups, strength };
}
/** tennis: the point model's walk-forward serve chances of every finished tour match since 2023; test = the last two years */
export async function backtestTennis() {
  const wf = await tennisExtrasWalkForward(0);
  if (!wf.length) return { before: [], after: [], live: null, calib: {}, periods: 0, diag: null, note: 'no tennis matches' };
  const st = db.prepare(`SELECT games, surface FROM tennis_matches WHERE id = ?`);
  const years = [...new Set(wf.map(w => new Date(w.t).getUTCFullYear()))].sort((a, b) => a - b), test = new Set(years.slice(-2));
  const items: WItem<TnItem>[] = [];
  const memo = new Map<string, { dist: TDist; x: Extras }>();
  const slice = heavySlicer(30);
  for (const w of wf) {
    const m = st.get(w.id) as any;
    let g: any = null;
    try { g = m?.games ? JSON.parse(m.games) : null; } catch { g = null; }
    const act = Array.isArray(g) ? tennisActual(g as [number[], number[]], w.rule) : null;
    if (!act) continue;
    // serve chances on a 0.005 grid (the chain is the slow part; the error is far below a percentage point)
    const qa = Math.round(w.pa * 200) / 200, qb = Math.round(w.pb * 200) / 200, key = `${qa}|${qb}|${w.bo}|${w.rule}`;
    let d = memo.get(key);
    if (!d) { const dist = tennisExtrasDist(qa, qb, w.bo, w.rule); d = { dist, x: tennisExtras(dist, w.bo) }; memo.set(key, d); }
    const sets = d.x.sets.sets, p1 = sets.labels.reduce((s, l, k) => { const [a, b] = l.split('-').map(Number); return s + (a > b ? sets.p[k] : 0); }, 0);
    const year = new Date(w.t).getUTCFullYear();
    items.push({
      t: w.t, period: String(year), test: test.has(year), g: { group: tennisGroup(w.cat, w.bo, m?.surface), tour: w.cat, dist: d.dist, bo: w.bo, games: Number(act.games), p1 },
      base: d.x, actual: act
    });
    await slice();
  }
  items.sort((a, b) => a.t - b.t);
  const r = await walkForward('tennis', items, tennisEngine);
  return { ...r, diag: tennisDiag(items), note: `tennis-v1 point model (serve and return chain, live settings), walk-forward, ${items.length} tour matches since Jan 2023 (retirements left out); test ${[...test].join(', ')} (${r.after.length} matches), games bias and calibration from the matches before each` };
}

type Bt = { before: Eval[]; after: Eval[]; live: any; calib: Calibs; periods: number; diag: any; note: string };
const BACKTESTS: Record<MoreSport, () => Promise<Bt>> = { football: backtestFootball, basketball: backtestBasketball, nfl: backtestNfl, tennis: backtestTennis };
let backtesting = false;
/** summarise() one output at a time, giving the thread back between them (tennis: 55k matches) */
async function summariseSliced(sport: MoreSport, list: Eval[]) {
  const out: Record<string, any> = {};
  for (const k of MORE_KEYS[sport]) {
    out[k] = summarise(sport, list, [k])[k];
    await afterLiveYield();
  }
  return out;
}
const lastBacktestAt = (s: MoreSport): string | null => (db.prepare(`SELECT at FROM more_pred_backtest WHERE sport = ?`).get(s) as any)?.at || null;
/** a stored report made with the current maths (an older one is redone on start) */
const backtestCurrent = (s: MoreSport): boolean => {
  const r = db.prepare(`SELECT report FROM more_pred_backtest WHERE sport = ?`).get(s) as any;
  try { return !!r && JSON.parse(r.report).calc === MORE_CALC; } catch { return false; }
};
/**
 * the backtests, the gates from them (the fixed and calibrated numbers), and the live fits and maps (stored: the
 * upcoming games are saved again with them). `freshMs`: skip a sport whose stored report is younger (the start-up run
 * and the first daily run don't do the same work twice)
 */
export async function runBacktests(only?: MoreSport, freshMs = 0): Promise<Record<string, any>> {
  if (backtesting) return { skipped: 'already running' };
  backtesting = true;
  const out: Record<string, any> = {};
  try {
    for (const s of only ? [only] : MORE_SPORTS) {
      // tennis replays 55k matches on this thread: once a week unless asked
      const last = lastBacktestAt(s);
      if (!only && s === 'tennis' && last && Date.now() - Date.parse(last) < 7 * DAY) { out[s] = { skipped: 'weekly' }; continue; }
      if (freshMs && last && Date.now() - Date.parse(last) < freshMs) { out[s] = { skipped: 'fresh' }; continue; }
      try {
        const bt = await BACKTESTS[s]();
        if (!bt.after.length) { out[s] = { note: bt.note, games: 0 }; logger.info(`more backtest ${s}: nothing to test yet (${bt.note})`); continue; }
        const sum = await summariseSliced(s, bt.after), was = await summariseSliced(s, bt.before);
        const before = Object.fromEntries(Object.entries(was).map(([k, o]: [string, any]) => [k, { games: o.games, hitRate: o.hitRate, brier: o.brier, logLoss: o.logLoss, worst: o.worst, public: o.public }]));
        if (bt.live) storeFit(s, 'source', bt.live);
        storeCalib(s, bt.calib);
        writeGates(s, sum, bt.note, { calc: MORE_CALC, before, diag: bt.diag, calibrated: Object.keys(bt.calib), live: bt.live });
        const pub = MORE_KEYS[s].filter(k => sum[k]?.public).length;
        out[s] = { note: bt.note, games: bt.after.length, public: pub };
        logger.info(`more backtest ${s}: ${pub} outputs public (of ${MORE_KEYS[s].length}; ${bt.note}); worst step before → after: ${MORE_KEYS[s].map(k => `${k} ${before[k]?.worst ?? '–'} → ${sum[k]?.worst ?? '–'}`).join(', ')}`);
      } catch (e: any) { out[s] = { error: e.message }; logger.warn(`more backtest ${s}: ${e.message}`); }
      await afterLiveYield();
    }
  } finally { backtesting = false; }
  return out;
}
export function backtestReports() {
  return (db.prepare(`SELECT sport, report, at FROM more_pred_backtest`).all() as any[]).map(r => { let rep: any = null; try { rep = JSON.parse(r.report); } catch { rep = null; } return { sport: r.sport, at: r.at, ...rep }; });
}
const OUT_NAME: Record<string, string> = {
  score: 'Likely scores (exact)', goals: 'Total goals 0/1/2/3/4+', homeGoals: 'Home goals 0/1/2/3+', awayGoals: 'Away goals 0/1/2/3+',
  cleanHome: 'Home clean sheet', cleanAway: 'Away clean sheet', win2Home: 'Home win by 2+', win2Away: 'Away win by 2+', ht: 'Half-time result', htft: 'HT/FT (9)',
  margin: 'Winning margin bands', total: 'Total points bands', homePts: 'Home points bands', awayPts: 'Away points bands', half: 'First-half winner', ot: 'Overtime',
  sets: 'Set score', first: 'First set', games: 'Total games bands', tb: 'At least one tie-break'
};
/** the stored reports as the Markdown of docs/notes/more-predictions-backtest.md: before → after, the causes, said vs happened */
export function backtestMarkdown(): string {
  const SPORT: Record<string, string> = { football: 'Football', basketball: 'Basketball', nfl: 'American football (NFL + college)', tennis: 'Tennis' };
  const n = (x: number | null | undefined) => (x === null || x === undefined ? '–' : x.toLocaleString('en-US'));
  const v = (x: any) => (x === null || x === undefined ? '–' : String(x));
  const lines: string[] = [`# Backtest results (walk-forward, ${now().slice(0, 10)})`, ''];
  const reps = new Map(backtestReports().map(r => [r.sport, r]));
  for (const s of MORE_SPORTS) {
    const r = reps.get(s);
    lines.push(`## ${SPORT[s]}`, '');
    if (!r || !r.outputs) { lines.push('No backtest stored yet.', ''); continue; }
    lines.push(`${r.note} (run ${String(r.at).slice(0, 16).replace('T', ' ')} UTC).${r.calibrated?.length ? ` Calibration layer on: ${r.calibrated.join(', ')}.` : ''}`, '',
      '| Output | Games | Worst step before → after | Log loss before → after | Top pick right | Public |', '|---|---:|---:|---:|---:|---|');
    for (const k of MORE_KEYS[s]) {
      const o = r.outputs[k], b = r.before?.[k];
      if (!o) continue;
      lines.push(`| ${OUT_NAME[k] || k} | ${n(o.games)} | ${v(b?.worst)} → ${v(o.worst)} | ${v(b?.logLoss)} → ${v(o.logLoss)} | ${o.hitRate ?? '–'}% | ${o.public ? '**yes**' : 'no (admin only)'} |`);
    }
    const d = r.diag;
    if (d && (s === 'basketball' || s === 'nfl')) {
      lines.push('', 'Cause, per league (all walk-forward games): bias = predicted − actual (points); slope = how much of a prediction\x27s distance from the league\x27s usual score really happens (1 = all of it); spread ratio = corrected misses ÷ the spread the bands used:', '',
        '| League | Games | Predicted total | Actual | Bias total / home / away | Slope total / home / away | Spread ratio total / home / away |', '|---|---:|---:|---:|---:|---:|---:|');
      for (const [l, x] of Object.entries<any>({ ...d.leagues, all: d.all })) if (x.bT !== undefined) lines.push(`| ${l} | ${n(x.n)} | ${x.meanPred} | ${x.meanActual} | ${x.bT} / ${x.bH} / ${x.bA} | ${x.kT} / ${x.kH} / ${x.kA} | ${x.rT} / ${x.rH} / ${x.rA} |`);
    }
    if (d && s === 'football') {
      lines.push('', `Cause (all walk-forward games; live shrink: each side k ${d.shrink?.k}, total kT ${d.shrink?.kT ?? '–'}, difference kD ${d.shrink?.kD ?? '–'}): expected goals raw / shrunk vs goals, dispersion = actual variance ÷ Poisson variance (shrunk means), 4+ goals said (fix204b) vs happened:`, '',
        '| Division | Games | Expected raw → shrunk | Goals | Dispersion | 4+ said → happened | ρ | NB size H / A |', '|---|---:|---:|---:|---:|---:|---:|---:|');
      for (const [l, x] of Object.entries<any>(d.leagues)) lines.push(`| ${l} | ${n(x.n)} | ${x.expectedRaw} → ${x.expectedShrunk} | ${x.goals} | ${x.dispersion} | ${x.said4} → ${x.happened4} | ${v(x.rho)} | ${x.nb ? `${v(x.nb[0])} / ${v(x.nb[1])}` : '–'} |`);
      lines.push('', '| Expected total (raw) | Games | Shrunk | Goals | Dispersion | 4+ said (fix204b) → after → happened |', '|---|---:|---:|---:|---:|---:|');
      for (const x of d.bands) if (x.n) lines.push(`| ${x.band} | ${n(x.n)} | ${x.expectedShrunk} | ${x.goals} | ${x.dispersion} | ${x.said4} → ${v(x.after4)} → ${x.happened4} |`);
    }
    if (d && s === 'tennis') {
      lines.push('', 'Cause: total games per tour / format / surface (bias = predicted − actual; spread ratio = misses ÷ the chain\'s spread):', '',
        '| Group | Matches | Predicted | Actual | Bias | Spread ratio |', '|---|---:|---:|---:|---:|---:|');
      for (const [l, x] of Object.entries<any>(d.groups)) lines.push(`| ${l} | ${n(x.n)} | ${x.predicted} | ${x.actual} | ${x.bias} | ${x.spreadRatio} |`);
      lines.push('', '| Favourite\'s chance | Matches | Tie-break said → happened | Straight sets said → happened |', '|---|---:|---:|---:|');
      for (const x of d.strength) if (x.n) lines.push(`| ${x.favourite} | ${n(x.n)} | ${x.tieBreakSaid} → ${x.tieBreakHappened} | ${x.straightSaid} → ${x.straightHappened} |`);
    }
    lines.push('', 'Said vs happened after the fixes, 10% steps with 100+ forecasts (step: forecasts, said → happened):', '');
    for (const k of MORE_KEYS[s]) {
      const o = r.outputs[k];
      if (!o?.calibration) continue;
      const bins = (o.calibration as any[]).filter(b => b.n >= 100).map(b => `${b.from}%: ${n(b.n)}, ${b.said} → ${b.happened}`).join(' · ');
      if (bins) lines.push(`- ${OUT_NAME[k] || k}: ${bins}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* E. Record                                                            */
/* ------------------------------------------------------------------ */

const recordCache = new Map<string, { at: number; v: any }>();
const RECORD_MIN = 200;
/** a sport's "More predictions" record: every output's games, top-pick hit rate, Brier, log loss, calibration (200+) */
export function moreRecord(sport: MoreSport, admin: boolean) {
  const key = `${sport}|${admin ? 1 : 0}`;
  const hit = recordCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
  const rows = db.prepare(`SELECT json, result, kickoff FROM prediction_extras WHERE sport = ? AND settled = 1 AND made_at <= kickoff ${admin ? '' : 'AND admin_only = 0'} ORDER BY kickoff`).all(sport) as any[];
  const list: Eval[] = [];
  for (const r of rows) { try { const res = JSON.parse(r.result); list.push({ x: JSON.parse(r.json), actual: res.actual }); } catch { /* skip */ } }
  const sum = summarise(sport, list);
  const g = gates();
  const since = (db.prepare(`SELECT MIN(kickoff) AS k FROM prediction_extras WHERE sport = ?`).get(sport) as any)?.k || null;
  const v = {
    sport, since, minGames: RECORD_MIN,
    outputs: publicKeys(sport, admin).map(k => ({
      output: k, games: sum[k].games, hitRate: sum[k].hitRate, brier: sum[k].brier, logLoss: sum[k].logLoss,
      calibration: sum[k].games >= RECORD_MIN ? sum[k].calibration : null,
      ...(admin ? { public: !!g.get(`${sport}|${k}`)?.public } : {})
    }))
  };
  recordCache.set(key, { at: Date.now(), v });
  return v;
}

/* ------------------------------------------------------------------ */
/* D. The game page                                                     */
/* ------------------------------------------------------------------ */

type State = 'upcoming' | 'live' | 'done';
function stateOf(sport: MoreSport, id: number, kickoff: string): State {
  const started = Date.parse(kickoff) <= Date.now();
  if (sport === 'football') {
    const r = db.prepare(`SELECT outcome FROM results WHERE match_id = ?`).get(id) as any;
    return r && r.outcome && r.outcome !== 'VOID' ? 'done' : started ? 'live' : 'upcoming';
  }
  const st = (sport === 'basketball' ? db.prepare(`SELECT status FROM bb_games WHERE game_id = ?`).get(id)
    : sport === 'nfl' ? db.prepare(`SELECT status FROM nfl_games WHERE game_id = ?`).get(id)
      : db.prepare(`SELECT status FROM tennis_matches WHERE id = ?`).get(id)) as any;
  const s = String(st?.status || '');
  if (sport === 'tennis' ? s === 'completed' : s === 'FT' || s === 'AOT') return 'done';
  return started ? 'live' : 'upcoming';
}
/**
 * The block for one game. Locked (free / signed out, not finished): { model, locked } and the list of outputs only — no
 * number and no hint (fix182). Open: every public output in %, our pick in each, and once checked what happened.
 * The payload sits under `prediction`, so the proxy guard locks it like every other prediction.
 */
export const hasExtras = (sport: MoreSport, id: number) => !!db.prepare(`SELECT 1 FROM prediction_extras WHERE sport = ? AND game_id = ?`).get(sport, id);
export function moreForGame(sport: MoreSport, id: number, o: { full: boolean; admin: boolean }) {
  const r = db.prepare(`SELECT model, kickoff, made_at, json, settled, result, admin_only, flag FROM prediction_extras WHERE sport = ? AND game_id = ?`).get(sport, id) as any;
  if (!r) return null;
  // the sanity check flagged this game's bands: admins only
  if (r.admin_only && !o.admin) return null;
  const state = stateOf(sport, id, r.kickoff);
  const keys = publicKeys(sport, o.admin);
  if (!keys.length) return null;
  const open = o.full || o.admin || state === 'done';
  if (!open) return { sport, state, keys, prediction: { model: r.model, locked: true } };
  let x: Extras | null = null, res: any = null;
  try { x = JSON.parse(r.json); res = r.result ? JSON.parse(r.result) : null; } catch { x = null; }
  if (!x) return null;
  const g = gates();
  const sets: Record<string, any> = {};
  for (const k of keys) { const s: PSet | undefined = x.sets[k]; if (s) sets[k] = { ...pctSet(s), top: topIndex(s) }; }
  const info = { ...x.info };
  if (!keys.includes('score')) delete info.grid6;
  return {
    sport, state, keys,
    prediction: {
      model: r.model, locked: false, madeAt: r.made_at, savedBeforeStart: r.made_at <= r.kickoff, sets, info,
      adminOnly: o.admin ? keys.filter(k => r.admin_only || !g.get(`${sport}|${k}`)?.public) : [],
      ...(o.admin && r.flag ? { flag: r.flag } : {}),
      result: r.settled === 1 && res ? { actual: res.actual, hits: Object.fromEntries(Object.entries(res.checks || {}).map(([k, c]: [string, any]) => [k, { hit: c.hit, i: c.i }])) } : null,
      void: r.settled === 2
    }
  };
}

/* ------------------------------------------------------------------ */
/* H. One sentence for the crawler preview                              */
/* ------------------------------------------------------------------ */

type Lang = 'en' | 'es' | 'pt' | 'de' | 'fr' | 'it' | 'tr';
const SENT: Record<'score' | 'expected' | 'sets', Record<Lang, string>> = {
  score: {
    en: 'Most likely score in our prediction: {0} ({1}%).', es: 'Resultado más probable en nuestro pronóstico: {0} ({1}%).',
    pt: 'Resultado mais provável no nosso palpite: {0} ({1}%).', de: 'Wahrscheinlichstes Ergebnis in unserer Prognose: {0} ({1} %).',
    fr: 'Score le plus probable de notre pronostic : {0} ({1} %).', it: 'Risultato più probabile nel nostro pronostico: {0} ({1}%).',
    tr: 'Tahminimizde en olası skor: {0} (%{1}).'
  },
  expected: {
    en: 'Expected score in our prediction: {0}.', es: 'Marcador esperado en nuestro pronóstico: {0}.', pt: 'Resultado esperado no nosso palpite: {0}.',
    de: 'Erwartetes Ergebnis in unserer Prognose: {0}.', fr: 'Score attendu de notre pronostic : {0}.', it: 'Punteggio atteso nel nostro pronostico: {0}.',
    tr: 'Tahminimizde beklenen skor: {0}.'
  },
  sets: {
    en: 'Most likely set score in our prediction: {0} ({1}%).', es: 'Resultado en sets más probable en nuestro pronóstico: {0} ({1}%).',
    pt: 'Resultado em sets mais provável no nosso palpite: {0} ({1}%).', de: 'Wahrscheinlichstes Satzergebnis in unserer Prognose: {0} ({1} %).',
    fr: 'Score en sets le plus probable de notre pronostic : {0} ({1} %).', it: 'Risultato in set più probabile nel nostro pronostico: {0} ({1}%).',
    tr: 'Tahminimizde en olası set skoru: {0} (%{1}).'
  }
};
/** "Most likely score in our prediction: 1–1 (12%)." — only when that output is public */
export function moreSentence(sport: MoreSport, id: number, lang: string): string | null {
  const L = (['en', 'es', 'pt', 'de', 'fr', 'it', 'tr'].includes(lang) ? lang : 'en') as Lang;
  const r = db.prepare(`SELECT json FROM prediction_extras WHERE sport = ? AND game_id = ? AND admin_only = 0`).get(sport, id) as any;
  if (!r) return null;
  let x: Extras | null = null;
  try { x = JSON.parse(r.json); } catch { return null; }
  if (!x) return null;
  const fill = (s: string, a: string, b?: string) => s.replace('{0}', a).replace('{1}', b ?? '');
  const keys = publicKeys(sport, false);
  const top = (k: string) => { const s = x!.sets[k]; if (!s) return null; const i = topIndex(s); return { label: s.labels[i].replace('-', '–'), pct: String(Math.round(s.p[i] * 100)) }; };
  if (sport === 'football' && keys.includes('score')) { const t = top('score'); return t ? fill(SENT.score[L], t.label, t.pct) : null; }
  if (sport === 'tennis' && keys.includes('sets')) { const t = top('sets'); return t ? fill(SENT.sets[L], t.label, t.pct) : null; }
  if ((sport === 'basketball' || sport === 'nfl') && keys.length && Array.isArray(x.info?.expected)) return fill(SENT.expected[L], `${x.info.expected[0]}–${x.info.expected[1]}`);
  return null;
}

/* ------------------------------------------------------------------ */
/* G. Data health                                                       */
/* ------------------------------------------------------------------ */

/**
 * per sport: games of the next 48 h with a main prediction, how many have extras, the ones without; finished 24 h+ ago
 * with no check; flagged by the sanity check; what the last save did (fix204b: real counts, so "0 missing" never hides
 * "nothing tried")
 */
export function moreHealth() {
  const in48 = new Date(Date.now() + 2 * DAY).toISOString(), ago24 = new Date(Date.now() - DAY).toISOString();
  // a game that starts within 10 minutes may be waiting for the next save: not counted
  const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const q = (sql: string, ...p: any[]) => (db.prepare(sql).all(...p) as any[]).map(r => Number(r.id));
  // the games of the window with a main prediction (the game's own current start time, not started)
  const predicted: Record<MoreSport, number[]> = {
    football: q(`SELECT DISTINCT p.match_id AS id FROM predictions p WHERE p.locked = 0 AND p.settled = 0 AND p.utc_date > ? AND p.utc_date < ? AND p.xg_home IS NOT NULL AND p.xg_away IS NOT NULL`, soon, in48),
    basketball: q(`SELECT p.game_id AS id FROM bb_predictions p WHERE p.kickoff > ? AND p.kickoff < ?`, soon, in48),
    nfl: q(`SELECT p.game_id AS id FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE COALESCE(g.kickoff, p.kickoff) > ? AND COALESCE(g.kickoff, p.kickoff) < ?
      AND (g.status IS NULL OR g.status = 'NS')`, soon, in48),
    tennis: q(`SELECT p.match_id AS id FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id WHERE COALESCE(m.scheduled_at, p.scheduled_at) > ? AND COALESCE(m.scheduled_at, p.scheduled_at) < ?
      AND COALESCE(m.status, '') IN ('', 'upcoming', 'scheduled', 'not_started')`, soon, in48)
  };
  const withExtras = (s: MoreSport) => new Set(q(`SELECT game_id AS id FROM prediction_extras WHERE sport = ? AND kickoff > ?`, s, new Date(Date.now() - DAY).toISOString()));
  const flagged = (s: MoreSport) => q(`SELECT game_id AS id FROM prediction_extras WHERE sport = ? AND admin_only = 1 AND kickoff > ? AND kickoff < ?`, s, soon, in48);
  const missing = {} as Record<MoreSport, number[]>;
  for (const s of MORE_SPORTS) { const have = withExtras(s); missing[s] = predicted[s].filter(id => !have.has(id)); }
  const unchecked: Record<MoreSport, number[]> = {
    football: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN results r ON r.match_id = e.game_id WHERE e.sport = 'football' AND e.settled = 0 AND r.settled_at < ?`, ago24),
    basketball: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN bb_games g ON g.game_id = e.game_id WHERE e.sport = 'basketball' AND e.settled = 0 AND g.status IN ('FT','AOT') AND g.kickoff < ?
      AND e.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL)`, new Date(Date.now() - 30 * 3600000).toISOString()),
    nfl: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN nfl_games g ON g.game_id = e.game_id WHERE e.sport = 'nfl' AND e.settled = 0 AND g.status IN ('FT','AOT') AND g.kickoff < ?`, new Date(Date.now() - 30 * 3600000).toISOString()),
    tennis: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN tennis_matches m ON m.id = e.game_id WHERE e.sport = 'tennis' AND e.settled = 0 AND m.status = 'completed' AND m.scheduled_at < ?`, new Date(Date.now() - 30 * 3600000).toISOString())
  };
  return MORE_SPORTS.map(s => {
    const fl = flagged(s);
    return {
      sport: s, predicted: predicted[s].length, saved: predicted[s].length - missing[s].length, missing: missing[s].length, unchecked: unchecked[s].length,
      flagged: fl.length, lastSave: lastSave(s), missingIds: missing[s].slice(0, 10), uncheckedIds: unchecked[s].slice(0, 10), flaggedIds: fl.slice(0, 10)
    };
  });
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                            */
/* ------------------------------------------------------------------ */

let saving = false;
export async function moreTick() {
  if (saving) return;
  saving = true;
  try { await saveExtras(); settleExtras(); } catch (e: any) { logger.warn(`more predictions tick: ${e.message}`); } finally { saving = false; }
}
let dailyDay = '';
/** league fits and the backtests once a day (after the models have been built), the gates from them */
export async function moreDaily(force = false) {
  const d = new Date().toISOString().slice(0, 10);
  if (!force && dailyDay === d) return;
  dailyDay = d;
  try { await refitLeagues(); } catch (e: any) { logger.warn(`more predictions fits: ${e.message}`); }
  // a sport tested in the last 20 h (e.g. by the start-up run) waits for the next day
  await runBacktests(undefined, force ? 0 : 20 * 3600 * 1000);
}
/**
 * fix204b: on start, every sport without a stored backtest report (fix204c: or with one made by older maths) is tested now (in the heavy queue, sliced, never
 * during a live tick), then its gates are set; the league fits first when none are stored. Until then every output
 * stays admin-only ("no backtest yet").
 */
export async function moreFirstRun(): Promise<Record<string, any>> {
  const todo = MORE_SPORTS.filter(s => !backtestCurrent(s));
  if (!todo.length) return {};
  logger.info(`more backtest: first run for ${todo.join(', ')}`);
  if (!(db.prepare(`SELECT 1 FROM more_pred_fit LIMIT 1`).get())) { try { await refitLeagues(); } catch (e: any) { logger.warn(`more predictions fits: ${e.message}`); } }
  const out: Record<string, any> = {};
  for (const s of todo) Object.assign(out, await runBacktests(s));
  return out;
}
/** every 5 minutes: save + check; the first backtests 3 minutes after the start; the fits and backtests daily */
export function startMorePredictionsScheduler() {
  after('more predictions', () => void moreTick(), 60 * 1000);
  every('more predictions', () => void moreTick(), 5 * 60 * 1000).unref();
  afterHeavy('more predictions first backtest', () => moreFirstRun(), 3 * 60 * 1000);
  afterHeavy('more predictions daily', () => moreDaily(), 20 * 60 * 1000);
  everyHeavy('more predictions daily', () => moreDaily(), 3 * 3600 * 1000).unref();
}

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
import { slicer, yieldLoop, after, every, afterHeavy, everyHeavy } from './perf';
import {
  footballExtras, fitGoalShrink, type GoalShrink, normalExtras, tennisExtras, checkSet, calibration, calibrationOk, topIndex, pctSet, normCdf,
  DEFAULT_HT_SHARE, type Extras, type LeagueFit, type MoreSport, type PSet, type SetCheck
} from '../utils/moreMath';
import { GROUPS } from './history';
import { mainRank } from './tracking';
import { leagueModelInfo, bbWalkForward } from './bbModel';
import { nflWalkForward } from './nflModel';
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
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* League fits (first-half share, level-at-half and overtime factors)   */
/* ------------------------------------------------------------------ */

const fitCache = new Map<string, any>();
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
const goalShrink = (): GoalShrink | null => readFit('football', 'shrink');
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
    storeFit('basketball', code, fitFromQuarters(bbGamesOf(code), { sigma: info?.sigma || 12, sigmaT: info?.sigmaTotal || 17, meanTotal: 160 }));
    await yieldLoop();
  }
  for (const lg of [1, 2]) { storeFit('nfl', String(lg), fitFromQuarters(nflGamesOf(lg), nflSpreads(lg))); await yieldLoop(); }
}
function bbFit(code: string): LeagueFit {
  const f: LeagueFit = readFit('basketball', code) || { share: 0.5, kHalf: 1, kOt: 1, meanTotal: 160, sigma: 12, sigmaT: 17, games: 0 };
  const info = leagueModelInfo(code); // the model's current spreads (they move as it learns; measured misses tested worse, fix204 doc)
  return info ? { ...f, sigma: info.sigma, sigmaT: info.sigmaTotal } : f;
}
const nflFit = (league: number): LeagueFit => readFit('nfl', String(league)) || { share: 0.5, kHalf: 1, kOt: 1, ...NFL_DEFAULT[league] || NFL_DEFAULT[1], games: 0 };

/* ------------------------------------------------------------------ */
/* B. Saving before the start                                           */
/* ------------------------------------------------------------------ */

const upsert = db.prepare(`INSERT INTO prediction_extras (sport, game_id, model, kickoff, made_at, json, source_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sport, game_id) DO UPDATE SET model = excluded.model, kickoff = excluded.kickoff, made_at = excluded.made_at, json = excluded.json, source_at = excluded.source_at
  WHERE prediction_extras.settled = 0 AND (prediction_extras.kickoff > excluded.made_at OR prediction_extras.kickoff <> excluded.kickoff)`);
const sourceStmt = db.prepare(`SELECT game_id, source_at, model FROM prediction_extras WHERE sport = ? AND kickoff > ?`);

interface Src { id: number; model: string; kickoff: string; at: string; make: () => Extras | null }
async function save(sport: MoreSport, list: Src[]): Promise<number> {
  const t = now();
  const have = new Map((sourceStmt.all(sport, t) as any[]).map(r => [r.game_id as number, `${r.model}|${r.source_at}`]));
  const slice = slicer(25);
  const out: [Src, Extras][] = [];
  for (const s of list) {
    if (s.kickoff <= t || have.get(s.id) === `${s.model}|${s.at}`) continue;
    try { const x = s.make(); if (x) out.push([s, x]); } catch (e: any) { logger.warn(`more predictions ${sport} ${s.id}: ${e.message}`); }
    await slice();
  }
  if (!out.length) return 0;
  const at = now();
  db.exec('BEGIN');
  try {
    // a game that started while we were computing keeps what it had
    for (const [s, x] of out) if (Date.parse(s.kickoff) > Date.now()) upsert.run(sport, s.id, s.model, s.kickoff, at, JSON.stringify(x), s.at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out.length;
}

function footballSources(): Src[] {
  const t = now();
  const rows = db.prepare(`SELECT match_id, model, competition_code, utc_date, xg_home, xg_away, updated_at FROM predictions
    WHERE locked = 0 AND settled = 0 AND utc_date > ? AND utc_date < ? AND xg_home IS NOT NULL AND xg_away IS NOT NULL`).all(t, new Date(Date.now() + 8 * DAY).toISOString()) as any[];
  const best = new Map<number, any>();
  for (const r of rows) {
    if (mainRank(r.model, r.utc_date) >= 99) continue;
    const cur = best.get(r.match_id);
    if (!cur || mainRank(r.model, r.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(r.match_id, r);
  }
  return [...best.values()].map(r => ({
    id: r.match_id, model: r.model, kickoff: r.utc_date, at: r.updated_at,
    make: () => footballExtras(r.xg_home, r.xg_away, htShareFor(r.competition_code), goalShrink())
  }));
}
function basketballSources(): Src[] {
  const rows = db.prepare(`SELECT game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at FROM bb_predictions WHERE kickoff > ?`).all(now()) as any[];
  return rows.map(r => ({
    id: r.game_id, model: r.model, kickoff: r.kickoff, at: r.made_at,
    make: () => normalExtras({ sport: 'basketball', pHome: r.p_home, margin: r.margin, total: r.total, homePts: r.home_pts, awayPts: r.away_pts, fit: bbFit(r.code) })
  }));
}
function nflSources(): Src[] {
  const rows = db.prepare(`SELECT p.game_id, p.kickoff, p.model, p.p_home, p.margin, p.total, p.home_pts, p.away_pts, p.made_at, g.league FROM nfl_predictions p
    JOIN nfl_games g ON g.game_id = p.game_id WHERE p.kickoff > ?`).all(now()) as any[];
  return rows.map(r => ({
    id: r.game_id, model: r.model, kickoff: r.kickoff, at: r.made_at,
    make: () => normalExtras({ sport: 'nfl', pHome: r.p_home, margin: r.margin, total: r.total, homePts: r.home_pts, awayPts: r.away_pts, fit: nflFit(r.league || 1) })
  }));
}
/** the chain behind a saved tennis prediction (its serve chances rescaled to its win chance) */
export function tennisExtrasFor(p1: number, servePoint: [number, number] | null, bo: number, rule: number): Extras {
  const b = bo === 5 ? 5 : 3;
  const { pa, pb } = tennisServeChances(servePoint, p1, b, rule);
  return tennisExtras(tennisExtrasDist(pa, pb, b, rule), b);
}
function tennisSources(): Src[] {
  const rows = db.prepare(`SELECT p.match_id, p.model, p.scheduled_at, p.p1, p.why, p.made_at, m.best_of, m.tier FROM tennis_predictions p
    JOIN tennis_matches m ON m.id = p.match_id WHERE p.scheduled_at > ?`).all(now()) as any[];
  return rows.map(r => ({
    id: r.match_id, model: r.model, kickoff: r.scheduled_at, at: r.made_at,
    make: () => {
      let why: any = null;
      try { why = r.why ? JSON.parse(r.why) : null; } catch { why = null; }
      const sp = Array.isArray(why?.numbers?.servePoint) ? why.numbers.servePoint as [number, number] : null;
      return tennisExtrasFor(r.p1, sp, r.best_of === 5 ? 5 : 3, tennisRuleFor(r.tier, r.scheduled_at));
    }
  }));
}
const SOURCES: Record<MoreSport, () => Src[]> = { football: footballSources, basketball: basketballSources, nfl: nflSources, tennis: tennisSources };
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
export function summarise(sport: MoreSport, list: Eval[]) {
  const out: Record<string, any> = {};
  for (const k of MORE_KEYS[sport]) {
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
function writeGates(sport: MoreSport, sum: Record<string, any>, note: string) {
  const t = now();
  const up = db.prepare(`INSERT OR REPLACE INTO more_pred_gate (sport, output, public, games, worst, why, at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const k of MORE_KEYS[sport]) {
    const s = sum[k];
    const why = !s || !s.games ? 'no backtest games' : s.worst === null ? 'no 10% step with 100+ forecasts' : s.public ? null : `calibration off by ${s.worst} points in a step with 100+ forecasts`;
    up.run(sport, k, s?.public ? 1 : 0, s?.games || 0, s?.worst ?? null, why, t);
  }
  db.prepare(`INSERT OR REPLACE INTO more_pred_backtest (sport, report, at) VALUES (?, ?, ?)`).run(sport, JSON.stringify({ note, outputs: sum }), t);
  gateCache = null;
}

/* ---------- walk-forward backtests ---------- */

/** football: grid-v3's walk-forward test predictions (backtest tables) of the last two seasons, half-time from ht_scores;
 *  the first-half share of each division from the games before each match (0.45 under 200 games) */
export async function backtestFootball(): Promise<{ list: Eval[]; note: string }> {
  const seasons = (db.prepare(`SELECT DISTINCT season FROM backtest_runs WHERE model = 'grid-v3' ORDER BY season DESC LIMIT 2`).all() as any[]).map(r => r.season as string);
  if (!seasons.length) return { list: [], note: 'no grid-v3 backtest runs stored' };
  // the goal-spread shrink of each test season, fitted on the seasons before it (none before: no shrink)
  const allBt = db.prepare(`SELECT r.season, b.xg_home AS xh, b.xg_away AS xa, b.hg, b.ag, MAX(b.run_id) FROM backtest_predictions b JOIN backtest_runs r ON r.id = b.run_id AND r.model = 'grid-v3'
    WHERE b.xg_home IS NOT NULL GROUP BY b.division, b.date, b.home, b.away`).all() as any[];
  const shrinkOf = new Map(seasons.map(s => [s, fitGoalShrink(allBt.filter(r => r.season < s))]));
  const rows = db.prepare(`SELECT r.season, b.division, b.date, b.home, b.away, b.hg, b.ag, b.xg_home, b.xg_away, h.ht_hg, h.ht_ag, MAX(b.run_id) AS run
    FROM backtest_predictions b JOIN backtest_runs r ON r.id = b.run_id AND r.model = 'grid-v3' AND r.season IN (${seasons.map(() => '?').join(',')})
    LEFT JOIN ht_scores h ON h.division = b.division AND h.date = b.date AND h.home = b.home AND h.away = b.away
    WHERE b.xg_home IS NOT NULL AND b.xg_away IS NOT NULL GROUP BY b.division, b.date, b.home, b.away ORDER BY b.date`).all(...seasons) as any[];
  // running first-half share per division from every stored half-time score before the match
  const hist = db.prepare(`SELECT h.division AS d, h.date, h.ht_hg + h.ht_ag AS ht, m.hg + m.ag AS ft FROM ht_scores h
    JOIN history_matches m ON m.division = h.division AND m.date = h.date AND m.home = h.home AND m.away = h.away ORDER BY h.date`).all() as any[];
  const acc = new Map<string, { n: number; ht: number; ft: number }>();
  let k = 0;
  const list: Eval[] = [];
  const slice = slicer(25);
  for (const r of rows) {
    while (k < hist.length && hist[k].date < r.date) { const a = acc.get(hist[k].d) || { n: 0, ht: 0, ft: 0 }; a.n++; a.ht += hist[k].ht; a.ft += hist[k].ft; acc.set(hist[k].d, a); k++; }
    const a = acc.get(r.division), share = a && a.n >= MIN_FIT_GAMES && a.ft > 0 ? a.ht / a.ft : DEFAULT_HT_SHARE;
    const x = footballExtras(r.xg_home, r.xg_away, share, shrinkOf.get(r.season) || null);
    list.push({ x, actual: footballActual(r.hg, r.ag, r.ht_hg != null ? [r.ht_hg, r.ht_ag] : null) });
    await slice();
  }
  return { list, note: `grid-v3 walk-forward predictions, seasons ${seasons.join(', ')}, ${rows.length} games (half-time scores where stored); goal shrink k ${seasons.map(s => `${s}: ${shrinkOf.get(s)?.k ?? 'none'}`).join(', ')}` };
}
/** basketball: bb-v3's walk-forward predictions (built with the league models) of the last two seasons; the league fit
 *  from the seasons before them; spreads = the league model's current ones */
export async function backtestBasketball(): Promise<{ list: Eval[]; note: string }> {
  const codes = (db.prepare(`SELECT DISTINCT code FROM bb_games`).all() as any[]).map(r => r.code as string);
  const list: Eval[] = [];
  let leagues = 0;
  for (const code of codes) {
    const wf = bbWalkForward(code).rows, info = leagueModelInfo(code);
    if (!wf.length || !info) continue;
    const seasons = [...new Set((db.prepare(`SELECT DISTINCT season FROM bb_games WHERE code = ? AND status IN ('FT','AOT')`).all(code) as any[]).map(r => r.season as string))].sort().slice(-2);
    if (!seasons.length) continue;
    const games = new Map((db.prepare(`SELECT game_id, season, kickoff, status, hs, as_, quarters FROM bb_games WHERE code = ? AND season IN (${seasons.map(() => '?').join(',')}) AND status IN ('FT','AOT')`)
      .all(code, ...seasons) as any[]).map(r => [r.game_id, r]));
    const first = [...games.values()].reduce((m, g) => (g.kickoff < m ? g.kickoff : m), '9999');
    const f0 = fitFromQuarters(bbGamesOf(code, first), { sigma: info.sigma, sigmaT: info.sigmaTotal, meanTotal: 160 });
    const fit: LeagueFit = { ...f0, sigma: info.sigma, sigmaT: info.sigmaTotal };
    for (const [id, pHome, margin, total] of wf) {
      const g = games.get(id);
      if (!g) continue;
      const x = normalExtras({ sport: 'basketball', pHome, margin, total, homePts: (total + margin) / 2, awayPts: (total - margin) / 2, fit });
      const q = parseQ(g.quarters);
      list.push({ x, actual: pointsActual(x, g.hs, g.as_, q, g.status === 'AOT' || (q ? (q.h[4] || 0) + (q.a[4] || 0) > 0 : false)) });
    }
    leagues++;
    await yieldLoop();
  }
  return { list, note: `bb-v3 walk-forward predictions, last two seasons of ${leagues} leagues, ${list.length} games` };
}
/** NFL and college: the walk-forward test games of the last model report (last two seasons), fit from the seasons before */
export async function backtestNfl(): Promise<{ list: Eval[]; note: string }> {
  const list: Eval[] = [];
  const parts: string[] = [];
  for (const lg of [1, 2]) {
    const wf = nflWalkForward(lg as 1 | 2);
    if (!wf.length) { parts.push(`${lg === 1 ? 'NFL' : 'college'}: no walk-forward report stored yet`); continue; }
    const rows = new Map((db.prepare(`SELECT game_id, season, kickoff, status, home_pts, away_pts, quarters FROM nfl_games WHERE league = ? AND status IN ('FT','AOT')`).all(lg) as any[]).map(r => [r.game_id, r]));
    const seasons = [...new Set(wf.map(w => rows.get(w[0])?.season).filter(Boolean))].sort().slice(-2);
    const test = wf.filter(w => seasons.includes(rows.get(w[0])?.season));
    if (!test.length) continue;
    const first = test.reduce((m, w) => (rows.get(w[0])!.kickoff < m ? rows.get(w[0])!.kickoff : m), '9999');
    // spreads from the test seasons' own misses would be hindsight: the seasons before them
    const before = wf.filter(w => (rows.get(w[0])?.kickoff || '9999') < first);
    let m2 = 0, t2 = 0, n = 0;
    for (const [id, , margin, total] of before) { const r = rows.get(id); if (!r) continue; m2 += (r.home_pts - r.away_pts - margin) ** 2; t2 += (r.home_pts + r.away_pts - total) ** 2; n++; }
    const spreads = n >= 100 ? { sigma: Math.sqrt(m2 / n), sigmaT: Math.sqrt(t2 / n), meanTotal: NFL_DEFAULT[lg].meanTotal } : NFL_DEFAULT[lg];
    const fit = fitFromQuarters(nflGamesOf(lg, first), spreads);
    for (const [id, pHome, margin, total] of test) {
      const g = rows.get(id)!;
      const x = normalExtras({ sport: 'nfl', pHome, margin, total, homePts: (total + margin) / 2, awayPts: (total - margin) / 2, fit });
      const q = parseQ(g.quarters);
      list.push({ x, actual: pointsActual(x, g.home_pts, g.away_pts, q, g.status === 'AOT' || (q ? (q.h[4] || 0) + (q.a[4] || 0) > 0 : false)) });
    }
    parts.push(`${lg === 1 ? 'NFL' : 'college'}: seasons ${seasons.join(', ')}, ${test.length} games`);
    await yieldLoop();
  }
  return { list, note: `nfl-v1 / ncaa-v1 walk-forward test games; ${parts.join('; ')}` };
}
/** tennis: the point model's walk-forward serve chances of every finished tour match since 2023 (not retired) */
export async function backtestTennis(): Promise<{ list: Eval[]; note: string }> {
  const wf = await tennisExtrasWalkForward(0);
  if (!wf.length) return { list: [], note: 'no tennis matches' };
  const st = db.prepare(`SELECT id, games FROM tennis_matches WHERE id = ?`);
  const list: Eval[] = [];
  const memo = new Map<string, Extras>();
  const slice = slicer(25);
  for (const w of wf) {
    const g0 = (st.get(w.id) as any)?.games || '';
    let g: any = null;
    try { g = g0 ? JSON.parse(g0) : null; } catch { g = null; }
    const act = Array.isArray(g) ? tennisActual(g as [number[], number[]], w.rule) : null;
    if (!act) continue;
    // serve chances on a 0.005 grid (the chain is the slow part; the error is far below a percentage point)
    const qa = Math.round(w.pa * 200) / 200, qb = Math.round(w.pb * 200) / 200, key = `${qa}|${qb}|${w.bo}|${w.rule}`;
    let x = memo.get(key);
    if (!x) { x = tennisExtras(tennisExtrasDist(qa, qb, w.bo, w.rule), w.bo); memo.set(key, x); }
    list.push({ x, actual: act });
    await slice();
  }
  return { list, note: `tennis-v1 point model (serve and return chain, live settings), walk-forward, ${list.length} tour matches since Jan 2023 (retirements left out)` };
}
const BACKTESTS: Record<MoreSport, () => Promise<{ list: Eval[]; note: string }>> = { football: backtestFootball, basketball: backtestBasketball, nfl: backtestNfl, tennis: backtestTennis };
let backtesting = false;
export async function runBacktests(only?: MoreSport): Promise<Record<string, any>> {
  if (backtesting) return { skipped: 'already running' };
  backtesting = true;
  const out: Record<string, any> = {};
  try {
    for (const s of only ? [only] : MORE_SPORTS) {
      // tennis replays 55k matches on this thread: once a week unless asked
      const last = (db.prepare(`SELECT at FROM more_pred_backtest WHERE sport = ?`).get(s) as any)?.at;
      if (!only && s === 'tennis' && last && Date.now() - Date.parse(last) < 7 * DAY) { out[s] = { skipped: 'weekly' }; continue; }
      try {
        const { list, note } = await BACKTESTS[s]();
        const sum = summarise(s, list);
        // nothing to test yet (e.g. no NFL report stored): keep what is there
        if (list.length) writeGates(s, sum, note);
        out[s] = { note, games: list.length };
        logger.info(`More predictions backtest ${s}: ${note}`);
      } catch (e: any) { out[s] = { error: e.message }; logger.warn(`More predictions backtest ${s}: ${e.message}`); }
      await yieldLoop();
    }
  } finally { backtesting = false; }
  return out;
}
export function backtestReports() {
  return (db.prepare(`SELECT sport, report, at FROM more_pred_backtest`).all() as any[]).map(r => { let rep: any = null; try { rep = JSON.parse(r.report); } catch { rep = null; } return { sport: r.sport, at: r.at, ...rep }; });
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
  const rows = db.prepare(`SELECT json, result, kickoff FROM prediction_extras WHERE sport = ? AND settled = 1 AND made_at <= kickoff ORDER BY kickoff`).all(sport) as any[];
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
export function moreForGame(sport: MoreSport, id: number, o: { full: boolean; admin: boolean }) {
  const r = db.prepare(`SELECT model, kickoff, made_at, json, settled, result FROM prediction_extras WHERE sport = ? AND game_id = ?`).get(sport, id) as any;
  if (!r) return null;
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
      adminOnly: o.admin ? keys.filter(k => !g.get(`${sport}|${k}`)?.public) : [],
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
  const r = db.prepare(`SELECT json FROM prediction_extras WHERE sport = ? AND game_id = ?`).get(sport, id) as any;
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

/** per sport: games of the next 48 h with a saved prediction but no extras; finished 24 h+ ago with no check */
export function moreHealth() {
  const in48 = new Date(Date.now() + 2 * DAY).toISOString(), ago24 = new Date(Date.now() - DAY).toISOString();
  // a game that starts within 10 minutes may be waiting for the next save: not counted
  const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const q = (sql: string, ...p: any[]) => (db.prepare(sql).all(...p) as any[]).map(r => Number(r.id));
  const missing: Record<MoreSport, number[]> = {
    football: q(`SELECT DISTINCT p.match_id AS id FROM predictions p WHERE p.locked = 0 AND p.utc_date > ? AND p.utc_date < ? AND p.xg_home IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM prediction_extras e WHERE e.sport = 'football' AND e.game_id = p.match_id)`, soon, in48),
    basketball: q(`SELECT p.game_id AS id FROM bb_predictions p WHERE p.kickoff > ? AND p.kickoff < ? AND NOT EXISTS (SELECT 1 FROM prediction_extras e WHERE e.sport = 'basketball' AND e.game_id = p.game_id)`, soon, in48),
    nfl: q(`SELECT p.game_id AS id FROM nfl_predictions p WHERE p.kickoff > ? AND p.kickoff < ? AND NOT EXISTS (SELECT 1 FROM prediction_extras e WHERE e.sport = 'nfl' AND e.game_id = p.game_id)`, soon, in48),
    tennis: q(`SELECT p.match_id AS id FROM tennis_predictions p WHERE p.scheduled_at > ? AND p.scheduled_at < ? AND NOT EXISTS (SELECT 1 FROM prediction_extras e WHERE e.sport = 'tennis' AND e.game_id = p.match_id)`, soon, in48)
  };
  const unchecked: Record<MoreSport, number[]> = {
    football: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN results r ON r.match_id = e.game_id WHERE e.sport = 'football' AND e.settled = 0 AND r.settled_at < ?`, ago24),
    basketball: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN bb_games g ON g.game_id = e.game_id WHERE e.sport = 'basketball' AND e.settled = 0 AND g.status IN ('FT','AOT') AND g.kickoff < ?
      AND e.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL)`, new Date(Date.now() - 30 * 3600000).toISOString()),
    nfl: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN nfl_games g ON g.game_id = e.game_id WHERE e.sport = 'nfl' AND e.settled = 0 AND g.status IN ('FT','AOT') AND g.kickoff < ?`, new Date(Date.now() - 30 * 3600000).toISOString()),
    tennis: q(`SELECT e.game_id AS id FROM prediction_extras e JOIN tennis_matches m ON m.id = e.game_id WHERE e.sport = 'tennis' AND e.settled = 0 AND m.status = 'completed' AND m.scheduled_at < ?`, new Date(Date.now() - 30 * 3600000).toISOString())
  };
  return MORE_SPORTS.map(s => ({ sport: s, missing: missing[s].length, unchecked: unchecked[s].length, missingIds: missing[s].slice(0, 10), uncheckedIds: unchecked[s].slice(0, 10) }));
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
  await runBacktests();
}
/** every 5 minutes: save + check; the league fits and backtests 20 minutes after the start (models built), then daily */
export function startMorePredictionsScheduler() {
  after('more predictions', () => void moreTick(), 60 * 1000);
  every('more predictions', () => void moreTick(), 5 * 60 * 1000).unref();
  afterHeavy('more predictions daily', () => moreDaily(), 20 * 60 * 1000);
  everyHeavy('more predictions daily', () => moreDaily(), 3 * 3600 * 1000).unref();
}

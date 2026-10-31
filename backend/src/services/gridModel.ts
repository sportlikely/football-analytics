/**
 * SportLikely – model v3 "grid" (Yarin's scoring system)
 *
 * Every parameter gets two numbers: a VALUE (1–10, the team's standing on it within its
 * league, read against the opponent's tier where it matters) and a RELEVANCE (1–5, how
 * much it matters in this kind of match). Points = value × relevance, summed per team.
 * The two totals, the draw pot (league draw base + draw factors + volatility) and a
 * calibrated gap curve become a 1000-point split: home / draw / away = percentages.
 *
 * Match types (decided from league tiers + context flags):
 *   mismatch  – two or more tiers apart
 *   standard  – adjacent tiers, ordinary round
 *   even      – same tier
 *   big       – derby, or two top-tier teams
 *
 * v3.0 fills the rows that our own data supports (results history, fixtures, tables).
 * Rows that need a richer feed (injuries, xG, PPDA, cards…) sit at neutral (5) until
 * that feed exists — they neither help nor hurt. Relevance and conversion constants are
 * the starting values from the Scoring Grid; the backtest calibrates them.
 */
import { clearPredictionCache } from './predCache';
import { yieldLoop } from './perf';
import { runsJobs } from './role';
import { onState, publishState } from './shared';
import { db } from '../db';
import logger from '../utils/logger';
import { markFresh } from './freshness';
import { GROUPS, groupForCompetition, loadGroupMatches, fdNameFor, HistoryMatch, seasonForDivision, h2hArchiveFor } from './history';
import { Prediction } from './predictionModel';
import { squadValueFor, squadValueAt } from './squadValues';
import { availabilityFor, xgByMatch } from './apiFootball';

export const MODEL_V3 = 'grid-v3';

export type MatchType = 'mismatch' | 'standard' | 'even' | 'big';

/* ------------------------------------------------------------------ */
/* Relevance grid (from the Scoring Grid page) — rows v3.0 can fill    */
/* ------------------------------------------------------------------ */

interface RowDef {
  id: string;
  name: string;
  rel: Record<MatchType, number>;
  /** 'team' rows favour a side; 'draw' rows feed the draw pot */
  kind: 'team' | 'draw';
  /** proxy = stands in for a richer parameter until its feed exists */
  note?: string;
}

const ROWS: RowDef[] = [
  { id: '#1', name: 'Squad value', rel: { mismatch: 10, standard: 10, even: 10, big: 10 }, kind: 'team', note: 'market value of the 15 most valuable players (transfermarkt-datasets snapshot); stands in for lineup value until lineups are priced' },
  { id: '#13', name: 'Missing players (injuries / suspensions)', rel: { mismatch: 3, standard: 4, even: 5, big: 5 }, kind: 'team', note: 'regulars listed out for this match, weighted by how often they started the last 10 (API-Football)' },
  { id: '#12', name: 'Confirmed XI vs usual XI', rel: { mismatch: 4, standard: 5, even: 5, big: 5 }, kind: 'team', note: 'usual starters left out of the confirmed XI (published ~1 h before kick-off)' },
  { id: '#1p', name: 'Player quality', rel: { mismatch: 0, standard: 0, even: 0, big: 0 }, kind: 'team', note: 'how strong the clubs its players played for last season were (minutes-weighted, with match ratings); off until backtested' },
  { id: '#1e', name: 'Strength (Elo)', rel: { mismatch: 5, standard: 5, even: 4, big: 4 }, kind: 'team', note: 'Elo over all results, margin-aware' },
  { id: '#19', name: 'Attack vs opponent tier', rel: { mismatch: 4, standard: 5, even: 5, big: 4 }, kind: 'team' },
  { id: '#14', name: 'Defence vs opponent tier', rel: { mismatch: 4, standard: 4, even: 4, big: 3 }, kind: 'team' },
  { id: '#10', name: 'Freshness (fixture load)', rel: { mismatch: 3, standard: 4, even: 4, big: 3 }, kind: 'team' },
  { id: '#23', name: 'Home / away record, specific', rel: { mismatch: 2, standard: 4, even: 5, big: 5 }, kind: 'team' },
  { id: '#7', name: 'Head-to-head, last 10', rel: { mismatch: 1, standard: 2, even: 3, big: 4 }, kind: 'team' },
  { id: '#21', name: 'Form, last 6', rel: { mismatch: 2, standard: 3, even: 4, big: 3 }, kind: 'team', note: 'stands in for time patterns until minute data exists' },
  { id: '#15', name: 'Draw-prone teams', rel: { mismatch: 1, standard: 3, even: 5, big: 4 }, kind: 'draw' },
  { id: '#30', name: 'League draw rate', rel: { mismatch: 1, standard: 3, even: 5, big: 4 }, kind: 'draw' },
  { id: '#16', name: 'Derby / stakes flag', rel: { mismatch: 4, standard: 3, even: 3, big: 5 }, kind: 'draw' }
];

/** Relevance overrides (sweep only): row id → match type → relevance. null = use ROWS. */
export type RelOverride = Record<string, Partial<Record<MatchType, number>>>;
let REL_OVERRIDE: RelOverride | null = null;
/** Set (or clear with null) a relevance override for a backtest run. */
export function setRelOverride(r: RelOverride | null) { REL_OVERRIDE = r; }

/** Conversion constants — placeholders until calibrated on the backtest. */
export const CONV = {
  // expected-goals scale for the goal markets only (xG shown, over/under, BTTS, scores); the 1X2 split is untouched.
  // Set from the goals calibration test (services/goalsCalibration.ts); GOAL_SCALE on Railway overrides it.
  goalScale: parseFloat(process.env.GOAL_SCALE || '1') || 1,
  drawBase: { mismatch: 190, standard: 270, even: 320, big: 290 } as Record<MatchType, number>, // backtest-calibrated (2025-26)
  drawCap: { mismatch: 260, standard: 380, even: 400, big: 380 } as Record<MatchType, number>,
  kDraw: 1.0, // points per (value−5) × relevance for draw rows (backtest: 1)
  // value scale (state build): 5.5 + spread·z, clamped to [valueLo, valueHi]. The 1–10 clamp flattens outliers
  // such as Bayern / PSG / Barcelona, so the range is a calibration knob.
  valueLo: -2, // open scale: most teams still land in 1–10, superteams can reach 13 (backtest-calibrated)
  valueHi: 13,
  valueSpread: 2.25,
  // gapMode 0: (totH−totA)/(totH+totA) — ratio;  1: (totH−totA)/(11·Σrel) — linear difference (robust to wide value ranges)
  gapMode: 1,
  // drawMode 0: draw pot base by match type (drawBase);  1: base = goals-model draw chance (Poisson + Dixon-Coles) × drawPoisScale
  drawMode: 1,
  drawPoisScale: 1.0,
  // draw spread: the gap report showed v3's draw chance is too flat (too high in mismatches, too low in even games).
  // drawStretch > 1 pushes draw points away from drawCenter; drawGapK removes draw points as the rating gap grows.
  drawStretch: 1.0,
  drawCenter: 260,
  drawGapK: 0,
  // Elo across divisions (the gap report: promoted sides arrived rated on their second-division results,
  // e.g. Hamburg 68% at Gladbach). 1 = a team changing division (or appearing for the first time after
  // the first season) is placed at a percentile of its new division: promoted/newcomer low, relegated high.
  eloDivTransfer: 1, // backtest 2025-26: gap to market 33.7 → 31.6 Brier points
  eloPromoPct: 0.2,
  eloRelegPct: 0.75,
  // a club relegated into its current division (first season after dropping) keeps an expensive squad on paper but
  // plays below it (sales, turmoil): its squad value is multiplied by this before ranking. 1 = off.
  // Tested 10 Oct 2026 on 2025-26 + 2026-27 (6 countries, all divisions): x0.7/0.5/0.3, rank cap 7/5, Elo percentile
  // 0.6/0.5 — none moved the Brier by more than 0.2 points overall (relegated-club games: -1.7 in 25-26, +1.9 in 26-27).
  // Squad value is ranked within the division, so a relegated club stays near the top whatever the multiplier. Left off.
  relegSquadMult: 1,
  relegSquadGames: 0, // 0 = whole first season; N = the discount fades out linearly over the club's first N games in the division
  relegSquadCap: 10, // squad-value rank (1–10) a relegated club may reach in its first season after dropping; 10 = off
  eloK: 20,
  formCurDiv: 0, // 1 = form (last 6) only from games in the team's current division
  // big favourites were too cautious (Porto 60% vs market 67% vs actual 82%): stretch large gaps.
  // effective gap = gap + gapCube · gap³ (0 = off)
  gapCube: 0,
  pitSquad: 1, // point-in-time squad values (squadHistory.ts): honest backtests; live = latest month
  // a team with no squad value (usually a promoted club missing from the Transfermarkt dump) gets the value at this
  // percentile of its division instead of the neutral 5 (= league average, which overrates promoted sides). −1 = neutral.
  squadMissingPct: 0.15, // Oct 2026: with squad value weighted 12, a promoted club without data is placed low in its division, not at the average
  // Transfermarkt only values players while their club is in a league the dataset covers, so a promoted club's
  // value is built from the few players who came from covered clubs (Hull 2026: €24m for the "top 15"). Floor every
  // club at this share of its division's median value (log scale). −1 = off.
  squadFloorRatio: 0.5, // tested 26 Sep 2026: no change in Brier/log loss on 2025-26 and 2026-27, removes impossible values
  useDivHint: 1, // take each team's division from the fixture being predicted (see buildState)
  // fix192: a team with no games in the group (play-off side from the division below, a promoted club before its first
  // game in a one-division group) starts from a "newcomer" profile instead of getting no prediction.
  // 1 = average of the teams promoted into the division over the last 3 seasons (bottom-3 average when fewer than 3),
  // 2 = bottom-3 average, 3 = division average, 0 = off (no prediction, as before).
  // Tested 20 Oct 2026 on the 127 such games of 2024-25 … 2026-27 (all groups, never fitted): log loss bottom-3 1.0584,
  // promoted 1.0625, league average 1.0883, league base rates 1.0704 (closing odds 1.0207) → bottom-3.
  newcomer: 2,
  // availability rows (#13 injuries, #12 confirmed XI): value = 5.5 − k × (starter-equivalents missing)
  injK: 2.0, // backtest 2025-26: 1–4 all help a little, 2 best on hit rate
  xiK: 1.0,
  xgBlend: 0, // attack/defence from goals (0) … expected goals (1) where API-Football has match xG; points/form stay real
  useLineups: 1, // backtest/sweep: 1 = final prediction (with confirmed XI), 0 = provisional (injuries only)
  xiNet: 0, // 1 = the confirmed-XI row uses absent minus replacements (like-for-like rotation ≈ no effect)
  drawClose: 0, // extra draw points when the two totals are level, fading to 0 as |gap| reaches drawCloseSpan
  drawCloseSpan: 0.3,
  gapScale: 0.2, // logistic scale on the relative gap between team totals (backtest-calibrated)
  homeGap: 0.08, // added to the relative gap for the home side: the league-wide home advantage
                 // (row #23 compares the two sides' home/away records but is centred, so it carries no league-level edge)
  floorOutsider: 35,
  floorDraw: 60,
  halfLifeProd: 120, // days, production/form rows
  halfLifeLong: 365, // days, home record / h2h
  useLeagueConv: 1, // 1 = apply the per-league settings (v3_league_conv, fitted by tuneLeaguesV3)
  poisBlend: 0.25, // Oct 2026: 0.25 tested neutral-to-better on 2025-26 / 2026-27; share of the expected-goals (Poisson) 1X2 mixed into the final split (0 = off), see scoreMatch
  poisBlendMode: 0, // 0 = blend H/D/A, 1 = keep the draw, blend only the home/away split
  guardPts: 8, // Oct 2026 on (with ppg + H2H): same record on 2025-26, slightly better on 2026-27; common-sense guard: min. last-10 points gap (with the rows agreeing) before the weaker side can't be favourite; 0 = off
  guardMargin: 20, // how far (in 1000-points) the better side is put ahead when the guard fires
  guardUsePpg: 1, // 1 = the guard also looks at this season's points per game (whichever gap is larger)
  guardH2H: 0.2, // the guard also fires on a one-sided head-to-head: share of points ≤ this (e.g. 0.2) over ≥ 5 meetings; 0 = off
  h2hArchive: 1, // 1 = the head-to-head row also uses older seasons (h2h_archive), not only the model's 3 seasons
  h2hYears: 10 // oldest meeting counted from the archive, in years (0 = no limit)
};

/* ------------------------------------------------------------------ */
/* Per-league settings                                                  */
/* ------------------------------------------------------------------ */
/*
 * Leagues differ (League patterns doc): draw rates from 24% (Ligue 1) to 32% (Serie B), La Liga / Portugal
 * short favourites winning 4–8 more games per 100 than the odds said, close favourites in Greece / Scotland
 * drawing a lot. Each division can carry five small adjustments on top of the shared model, applied in the
 * final split only:
 *   draw    – draw points added (10 points = +1% draw chance)
 *   home    – added to the relative gap for the home side (league-specific home advantage)
 *   stretch – multiplies the effective gap: > 1 = favourites stronger, < 1 = flatter
 *   cube    – extra gap³ term: strengthens only big favourites
 *   close   – extra draw points when the sides are level, fading to 0 at |gap| = drawCloseSpan
 * They are fitted by tuneLeaguesV3 (train one season, keep only if it also wins on the next).
 */
export interface LeagueConv { draw: number; home: number; stretch: number; cube: number; close: number }
const LC0: LeagueConv = { draw: 0, home: 0, stretch: 1, cube: 0, close: 0 };
db.exec(`CREATE TABLE IF NOT EXISTS v3_league_conv (division TEXT PRIMARY KEY, conf TEXT NOT NULL, report TEXT, updated_at TEXT NOT NULL)`);
const LEAGUE_CONV = new Map<string, LeagueConv>();
function loadLeagueConv() {
  LEAGUE_CONV.clear();
  for (const r of db.prepare(`SELECT division, conf FROM v3_league_conv`).all() as any[]) {
    try { LEAGUE_CONV.set(r.division, { ...LC0, ...JSON.parse(r.conf) }); } catch { /* ignore a bad row */ }
  }
}
loadLeagueConv();
export function leagueConvStatus() {
  return (db.prepare(`SELECT division, conf, report, updated_at FROM v3_league_conv ORDER BY division`).all() as any[])
    .map(r => ({ division: r.division, conf: JSON.parse(r.conf), meaning: describeLc(JSON.parse(r.conf)), report: r.report ? JSON.parse(r.report) : null, updatedAt: r.updated_at }));
}
export function clearLeagueConv() {
  db.exec(`DELETE FROM v3_league_conv`);
  loadLeagueConv();
}
function describeLc(lc: LeagueConv) {
  const parts: string[] = [];
  if (lc.draw) parts.push(`draw ${lc.draw > 0 ? '+' : ''}${lc.draw / 10}%`);
  if (lc.close) parts.push(`+${lc.close / 10}% draw in level games`);
  if (lc.home) parts.push(`home advantage ${lc.home > 0 ? 'stronger' : 'weaker'} (${lc.home > 0 ? '+' : ''}${lc.home})`);
  if (lc.stretch !== 1) parts.push(`favourites ${lc.stretch > 1 ? 'stronger' : 'weaker'} (x${lc.stretch})`);
  if (lc.cube) parts.push(`big favourites stronger (cube ${lc.cube})`);
  return parts.join(', ') || 'no change';
}

/*
 * Live predictions always use the calibrated config above. Backtests and sweeps change CONV / REL_OVERRIDE
 * while they run (and yield to the event loop), so live scoring swaps the live config in for its own
 * synchronous call and puts the experiment's config back afterwards.
 */
const LIVE_CONV = JSON.parse(JSON.stringify(CONV)) as typeof CONV;

/*
 * A tuning applied by the full tuner (services/v3Tuner.ts, table v3_tuned) replaces the row weights and the
 * conversion constants above — at start-up, or at once with /api/model/v3/tuned?reload=1.
 */
db.exec(`CREATE TABLE IF NOT EXISTS v3_tuned (id INTEGER PRIMARY KEY CHECK (id = 1), rel TEXT NOT NULL, conv TEXT NOT NULL, report TEXT, updated_at TEXT NOT NULL)`);
const TUNABLE_CONV = ['gapScale', 'homeGap', 'drawPoisScale', 'drawStretch', 'drawGapK', 'drawClose', 'drawCloseSpan', 'gapCube', 'floorOutsider', 'floorDraw', 'drawCap', 'kDraw'];
const CODED_REL = ROWS.map(r => ({ id: r.id, rel: { ...r.rel } }));
const CODED_CONV = JSON.parse(JSON.stringify(CONV)) as typeof CONV;
export function applyStoredTuning(): boolean {
  const r: any = db.prepare(`SELECT rel, conv FROM v3_tuned WHERE id = 1`).get();
  // back to the coded setting first (a cleared tuning, or a new one replacing an old one)
  for (const c of CODED_REL) setRowRel(c.id, c.rel);
  for (const k of TUNABLE_CONV) (CONV as any)[k] = k === 'drawCap' ? { ...CODED_CONV.drawCap } : (CODED_CONV as any)[k];
  let applied = false;
  if (r) {
    try {
      const rel = JSON.parse(r.rel) as Record<string, Record<MatchType, number>>;
      const conv = JSON.parse(r.conv) as Record<string, any>;
      for (const [id, v] of Object.entries(rel)) setRowRel(id, v);
      for (const k of TUNABLE_CONV) if (conv[k] !== undefined) (CONV as any)[k] = k === 'drawCap' ? { ...CONV.drawCap, ...conv[k] } : conv[k];
      applied = true;
    } catch (e: any) {
      logger.warn(`v3 tuning not applied: ${e.message}`);
    }
  }
  Object.assign(LIVE_CONV, JSON.parse(JSON.stringify(CONV)));
  return applied;
}
export function tunedStatus() {
  const r: any = db.prepare(`SELECT rel, conv, report, updated_at FROM v3_tuned WHERE id = 1`).get();
  return { applied: !!r, stored: r ? { rel: JSON.parse(r.rel), conv: JSON.parse(r.conv), report: r.report ? JSON.parse(r.report) : null, updatedAt: r.updated_at } : null, live: { rows: ROWS.map(x => ({ id: x.id, name: x.name, rel: x.rel })), conv: CONV } };
}
export function storeTuning(rel: Record<string, Record<MatchType, number>>, conv: Record<string, any>, report: any) {
  db.prepare(`INSERT OR REPLACE INTO v3_tuned (id, rel, conv, report, updated_at) VALUES (1, ?, ?, ?, ?)`).run(JSON.stringify(rel), JSON.stringify(conv), JSON.stringify(report), new Date().toISOString());
}
export function clearTuning() { db.exec(`DELETE FROM v3_tuned`); applyStoredTuning(); }
if (applyStoredTuning()) logger.info('v3: tuned weights applied from v3_tuned');
export function withLiveConfig<T>(fn: () => T): T {
  const savedConv = JSON.parse(JSON.stringify(CONV));
  const savedRel = REL_OVERRIDE;
  Object.assign(CONV, JSON.parse(JSON.stringify(LIVE_CONV)));
  REL_OVERRIDE = null;
  try {
    return fn();
  } finally {
    Object.assign(CONV, savedConv);
    REL_OVERRIDE = savedRel;
  }
}

/* ------------------------------------------------------------------ */
/* Derbies (football-data.co.uk names)                                  */
/* ------------------------------------------------------------------ */

const DERBIES: [string, string][] = [
  ['Real Madrid', 'Ath Madrid'], ['Barcelona', 'Real Madrid'], ['Barcelona', 'Espanol'], ['Sevilla', 'Betis'],
  ['Ath Bilbao', 'Sociedad'], ['Valencia', 'Levante'], ['Barcelona', 'Ath Madrid'],
  ['Man United', 'Man City'], ['Liverpool', 'Everton'], ['Arsenal', 'Tottenham'], ['Chelsea', 'Tottenham'],
  ['Arsenal', 'Chelsea'], ['Liverpool', 'Man United'], ['West Ham', 'Tottenham'], ['Newcastle', 'Sunderland'],
  ['Aston Villa', 'Birmingham'], ['Sheffield United', 'Sheffield Weds'], ['Nott\'m Forest', 'Derby'],
  ['Inter', 'Milan'], ['Roma', 'Lazio'], ['Juventus', 'Torino'], ['Juventus', 'Inter'], ['Genoa', 'Sampdoria'],
  ['Dortmund', 'Schalke 04'], ['Bayern Munich', 'Dortmund'], ['Hamburg', 'Werder Bremen'], ['Hamburg', 'St Pauli'],
  ['Paris SG', 'Marseille'], ['Lyon', 'St Etienne'], ['Lyon', 'Marseille'], ['Nice', 'Monaco'],
  ['Ajax', 'Feyenoord'], ['Ajax', 'PSV Eindhoven'], ['Feyenoord', 'PSV Eindhoven'],
  ['Benfica', 'Porto'], ['Benfica', 'Sp Lisbon'], ['Porto', 'Sp Lisbon']
];
const derbyKey = (a: string, b: string) => [a, b].sort().join('|');
const DERBY_SET = new Set(DERBIES.map(([a, b]) => derbyKey(a, b)));
export const isDerby = (a: string, b: string) => DERBY_SET.has(derbyKey(a, b));

/* ------------------------------------------------------------------ */
/* Team state from history                                             */
/* ------------------------------------------------------------------ */

interface TeamFeat {
  name: string;
  division: string;
  played: number; // this season, own division
  tier: 1 | 2 | 3 | 4;
  rank: number; // strength rank within division (1 = top)
  ppgSeason: number; // decayed ppg
  elo: number; // Elo rating (all divisions, margin-aware)
  attack: number; // opponent-adjusted goals for / game (decayed)
  defence: number; // opponent-adjusted goals against / game (decayed), lower = better
  formPts: number; // points in last 6 league games
  form10Pts: number; // points in last 10 games (padded with draws), for the common-sense guard
  homePpg: number; // decayed home ppg
  awayPpg: number; // decayed away ppg
  drawRate: number; // decayed share of draws
  gamesLast8: number; // matches in the 8 days before asOf
  lastMatch: string | null;
  squadEur: number | null; // top-15 squad value, EUR (null = unknown)
  squadEst?: boolean; // value raised to the division floor (incomplete Transfermarkt data, usually a promoted club)
  /** fix192: no games in this group yet: the newcomer profile (see newcomerFeat) */
  newcomer?: 'promoted' | 'bottom3' | 'average';
  /** values 1–10 (rank within division) */
  v: Record<string, number>;
}

interface GroupState {
  group: string;
  asOf: string;
  teams: Map<string, TeamFeat>;
  leagueDrawRate: Record<string, number>; // per division
  leagueAvgGoals: Record<string, number>; // per team per game
  homeAdv: Record<string, number>; // home goals / away goals
}

const DAY = 24 * 3600 * 1000;
const days = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / DAY;
const decay = (age: number, halfLife: number) => Math.pow(0.5, age / halfLife);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/* Match xG per group (API-Football), cached — key date|home|away in our history names */
const xgCache = new Map<string, { at: number; map: Map<string, { xh: number; xa: number }> }>();
function xgFor(group: string) {
  const c = xgCache.get(group);
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.map;
  let map = new Map<string, { xh: number; xa: number }>();
  try { map = xgByMatch(group); } catch { /* no API-Football data */ }
  xgCache.set(group, { at: Date.now(), map });
  return map;
}

/* Squad quality from players' previous season (services/playerQuality.ts writes team_player_quality) */
let pqCache: { at: number; map: Map<string, number> } | null = null;
export function clearPlayerQualityCache() { pqCache = null; }
function playerQualityOf(group: string, name: string, seasonCode: string): number | null {
  if (!pqCache || Date.now() - pqCache.at > 10 * 60 * 1000) {
    const map = new Map<string, number>();
    try {
      for (const r of db.prepare(`SELECT season, grp, fd_name, pq FROM team_player_quality WHERE pq IS NOT NULL`).all() as any[]) map.set(`${r.season}|${r.grp}|${r.fd_name}`, r.pq);
    } catch { /* table not built yet */ }
    pqCache = { at: Date.now(), map };
  }
  const v = pqCache.map.get(`${2000 + parseInt(seasonCode.slice(0, 2), 10)}|${group}|${name}`);
  return v === undefined ? null : v;
}

/**
 * 1–10 value within a league from the metric itself (standardised), not just the rank:
 * 5.5 = league average, ±4.5 at two standard deviations. Keeps the size of the gap between
 * teams (rank alone makes #1 vs #2 look the same as #10 vs #11).
 */
function rankValues(items: { name: string; raw: number }[], invert = false): Map<string, number> {
  const out = new Map<string, number>();
  const n = items.length;
  if (!n) return out;
  const mean = items.reduce((s, it) => s + it.raw, 0) / n;
  const sd = Math.sqrt(items.reduce((s, it) => s + (it.raw - mean) ** 2, 0) / Math.max(1, n - 1)) || 1e-9;
  for (const it of items) {
    let z = (it.raw - mean) / sd;
    if (invert) z = -z;
    out.set(it.name, Math.round(clamp(5.5 + CONV.valueSpread * z, CONV.valueLo, CONV.valueHi) * 10) / 10);
  }
  return out;
}

/** Season code (e.g. "2526") for a date. */
function seasonOf(date: string) {
  const d = new Date(date);
  const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(y).slice(2)}${String(y + 1).slice(2)}`;
}

/**
 * Build the state of every team in a group as of a date, from matches strictly before it.
 */
/**
 * divHint: the division each team plays the upcoming matches in (from the fixtures). Before a promoted
 * side's first game, "last division seen" is still the old one, so without the hint it would be rated
 * against second-division teams (Hamburg 68% at Gladbach on matchday 1).
 */
export const weekDivs = (week: HistoryMatch[]) => {
  const m = new Map<string, string>();
  for (const x of week) { m.set(x.home, x.division); m.set(x.away, x.division); }
  return m;
};

export function buildState(group: string, all: HistoryMatch[], asOf: string, divHint?: Map<string, string>): GroupState {
  const past = all.filter(m => m.date < asOf);
  const divisions = GROUPS[group]?.divisions || [];
  // calendar-year leagues (Brazil, MLS, Japan, Nordics …) change season in winter, not in July
  const season = divisions.length ? seasonForDivision(divisions[0], asOf) : seasonOf(asOf);
  const teams = new Map<string, TeamFeat>();

  // --- which division is each team in this season? (last division seen this season, else last ever)
  const divOf = new Map<string, string>();
  for (const m of past) {
    for (const t of [m.home, m.away]) {
      if (m.season === season || !divOf.has(t)) divOf.set(t, m.division);
    }
  }
  if (divHint && CONV.useDivHint) divHint.forEach((d, t) => divOf.set(t, d));
  // clubs in their first season after relegation (division one tier lower than last season's), with games played in it
  const relegNow = new Map<string, number>();
  if (CONV.relegSquadMult !== 1 || CONV.relegSquadCap < 10) {
    const prevSeason = (sn: string) => (sn.length === 4 ? `${String(Number(sn.slice(0, 2)) - 1).padStart(2, '0')}${String(Number(sn.slice(2)) - 1).padStart(2, '0')}` : String(Number(sn) - 1));
    const lastSeasonDiv = new Map<string, string>();
    const played = new Map<string, number>();
    const prev = prevSeason(season);
    for (const m of past) for (const t of [m.home, m.away]) {
      if (m.season === prev) lastSeasonDiv.set(t, m.division);
      if (m.season === season && m.division === divOf.get(t)) played.set(t, (played.get(t) || 0) + 1);
    }
    divOf.forEach((d, t) => {
      const ld = lastSeasonDiv.get(t);
      if (ld && ld !== d && divisions.indexOf(ld) >= 0 && divisions.indexOf(ld) < divisions.indexOf(d)) relegNow.set(t, played.get(t) || 0);
    });
  }
  // teams whose only appearances are in older seasons and not in this one: still keep (early season)
  const ensure = (name: string) => {
    let t = teams.get(name);
    if (!t) {
      t = {
        name, division: divOf.get(name) || divisions[0], played: 0, tier: 3, rank: 10, ppgSeason: 1, elo: 1450, attack: 1.3, defence: 1.3,
        formPts: 6, form10Pts: 10, homePpg: 1.5, awayPpg: 1.1, drawRate: 0.25, gamesLast8: 0, lastMatch: null, squadEur: null, v: {}
      };
      teams.set(name, t);
    }
    return t;
  };

  // --- league-level numbers per division (last two seasons, decayed)
  const leagueDrawRate: Record<string, number> = {};
  const leagueAvgGoals: Record<string, number> = {};
  const homeAdv: Record<string, number> = {};
  for (const div of divisions) {
    let w = 0, draws = 0, goals = 0, hg = 0, ag = 0;
    for (const m of past) {
      if (m.division !== div) continue;
      const k = decay(days(m.date, asOf), 540);
      w += k; draws += k * (m.hg === m.ag ? 1 : 0); goals += k * (m.hg + m.ag); hg += k * m.hg; ag += k * m.ag;
    }
    leagueDrawRate[div] = w ? draws / w : 0.25;
    leagueAvgGoals[div] = w ? goals / w / 2 : 1.35;
    homeAdv[div] = ag ? hg / ag : 1.25;
  }

  // --- Elo over every past match, in order: strength of opposition is built in, second-division
  //     seasons count at their own level, so a promoted side arrives with an honest rating.
  const elo = new Map<string, number>();
  {
    const K = CONV.eloK, HA = 60;
    const sorted = [...past].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    const firstSeason = sorted.length ? sorted[0].season : '';
    const lastDiv = new Map<string, { div: string; season: string }>();
    const divRank = (d: string) => { const i = divisions.indexOf(d); return i < 0 ? 99 : i; };
    const place = (team: string, m: HistoryMatch) => {
      const prev = lastDiv.get(team);
      const moved = prev ? prev.div !== m.division && prev.season !== m.season : m.season !== firstSeason;
      if (CONV.eloDivTransfer && moved) {
        const peers: number[] = [];
        lastDiv.forEach((v, t) => { if (t !== team && v.div === m.division && elo.has(t)) peers.push(elo.get(t)!); });
        if (peers.length >= 8) {
          peers.sort((x, y) => x - y);
          const up = !prev || divRank(m.division) < divRank(prev.div);
          const q = up ? CONV.eloPromoPct : CONV.eloRelegPct;
          elo.set(team, peers[Math.min(peers.length - 1, Math.max(0, Math.round(q * (peers.length - 1))))]);
        }
      }
      lastDiv.set(team, { div: m.division, season: m.season });
    };
    for (const m of sorted) {
      place(m.home, m);
      place(m.away, m);
      const rh = elo.get(m.home) ?? 1500, ra = elo.get(m.away) ?? 1500;
      const exp = 1 / (1 + Math.pow(10, (ra - rh - HA) / 400));
      const res = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
      const gd = Math.abs(m.hg - m.ag);
      const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : 1.75 + (gd - 3) / 8;
      const delta = K * mult * (res - exp);
      elo.set(m.home, rh + delta); elo.set(m.away, ra - delta);
    }
    // teams about to play in a different division than their last one (promoted / relegated, before their first game)
    if (divHint && CONV.useDivHint && CONV.eloDivTransfer) {
      divHint.forEach((d, t) => {
        const prev = lastDiv.get(t);
        if (prev && prev.div === d) return;
        const peers: number[] = [];
        lastDiv.forEach((v, o) => { if (o !== t && v.div === d && elo.has(o)) peers.push(elo.get(o)!); });
        if (peers.length < 8) return;
        peers.sort((x, y) => x - y);
        const up = !prev || divRank(d) < divRank(prev.div);
        const q = up ? CONV.eloPromoPct : CONV.eloRelegPct;
        elo.set(t, peers[Math.min(peers.length - 1, Math.max(0, Math.round(q * (peers.length - 1))))]);
      });
    }
  }

  // --- goals used for attack/defence: real goals, or a blend with expected goals (xG) when the match has it
  const xgMap = CONV.xgBlend > 0 ? xgFor(group) : null;
  const eff = (m: HistoryMatch) => {
    const x = xgMap?.get(`${m.date}|${m.home}|${m.away}`);
    if (!x) return { hg: m.hg, ag: m.ag };
    const w = CONV.xgBlend;
    return { hg: (1 - w) * m.hg + w * x.xh, ag: (1 - w) * m.ag + w * x.xa };
  };

  // --- raw decayed aggregates per team
  interface Agg { w: number; gf: number; ga: number; pts: number; hw: number; hpts: number; aw: number; apts: number; d: number; games: { date: string; pts: number; season: string; division: string }[] }
  const agg = new Map<string, Agg>();
  const A = (n: string) => { let a = agg.get(n); if (!a) { a = { w: 0, gf: 0, ga: 0, pts: 0, hw: 0, hpts: 0, aw: 0, apts: 0, d: 0, games: [] }; agg.set(n, a); } return a; };
  // Only matches played in the team's CURRENT division count toward its ratings: a promoted side's
  // second-division numbers say nothing about the top flight. Few same-division games → shrink to a prior.
  for (const m of past) {
    ensure(m.home); ensure(m.away);
    const age = days(m.date, asOf);
    const kP = decay(age, CONV.halfLifeProd);
    const kL = decay(age, CONV.halfLifeLong);
    const hPts = m.hg > m.ag ? 3 : m.hg === m.ag ? 1 : 0;
    const aPts = m.hg < m.ag ? 3 : m.hg === m.ag ? 1 : 0;
    const h = A(m.home), a = A(m.away);
    h.games.push({ date: m.date, pts: hPts, season: m.season, division: m.division });
    a.games.push({ date: m.date, pts: aPts, season: m.season, division: m.division });
    const e = eff(m);
    if (divOf.get(m.home) === m.division) {
      h.w += kP; h.gf += kP * e.hg; h.ga += kP * e.ag; h.pts += kP * hPts; h.d += kP * (hPts === 1 ? 1 : 0);
      h.hw += kL; h.hpts += kL * hPts;
    }
    if (divOf.get(m.away) === m.division) {
      a.w += kP; a.gf += kP * e.ag; a.ga += kP * e.hg; a.pts += kP * aPts; a.d += kP * (aPts === 1 ? 1 : 0);
      a.aw += kL; a.apts += kL * aPts;
    }
  }

  // --- first pass: unadjusted attack/defence per game
  // Prior for a team with little same-division evidence: a newcomer (promoted / relegated) profile
  const PRIOR_W = 4; // worth ~4 matches of evidence
  const priorFor = (n: string) => { const avg = leagueAvgGoals[divOf.get(n) || divisions[0]] || 1.35; return { att: avg * 0.8, def: avg * 1.2, ppg: 1.0, draw: 0.26 }; };
  const rawAtt = new Map<string, number>(), rawDef = new Map<string, number>();
  agg.forEach((x, n) => {
    const pr = priorFor(n);
    rawAtt.set(n, (x.gf + pr.att * PRIOR_W) / (x.w + PRIOR_W));
    rawDef.set(n, (x.ga + pr.def * PRIOR_W) / (x.w + PRIOR_W));
  });
  // --- second pass: opponent-adjusted (divide by opponent's defence / attack relative to league)
  const adjAtt = new Map<string, number>(rawAtt), adjDef = new Map<string, number>(rawDef);
  for (let iter = 0; iter < 4; iter++) {
    const acc = new Map<string, { w: number; att: number; def: number }>();
    for (const m of past) {
      const k = decay(days(m.date, asOf), CONV.halfLifeProd);
      const avg = leagueAvgGoals[m.division] || 1.35;
      const oppDefH = (adjDef.get(m.away) || avg) / avg; // how leaky the away side is
      const oppAttH = (adjAtt.get(m.away) || avg) / avg;
      const oppDefA = (adjDef.get(m.home) || avg) / avg;
      const oppAttA = (adjAtt.get(m.home) || avg) / avg;
      const e = eff(m);
      if (divOf.get(m.home) === m.division) { const h = acc.get(m.home) || { w: 0, att: 0, def: 0 }; h.w += k; h.att += k * e.hg / Math.max(0.5, oppDefH); h.def += k * e.ag / Math.max(0.5, oppAttH); acc.set(m.home, h); }
      if (divOf.get(m.away) === m.division) { const a = acc.get(m.away) || { w: 0, att: 0, def: 0 }; a.w += k; a.att += k * e.ag / Math.max(0.5, oppDefA); a.def += k * e.hg / Math.max(0.5, oppAttA); acc.set(m.away, a); }
    }
    agg.forEach((_, n) => {
      const x = acc.get(n) || { w: 0, att: 0, def: 0 };
      const pr = priorFor(n);
      adjAtt.set(n, (x.att + pr.att * PRIOR_W) / (x.w + PRIOR_W));
      adjDef.set(n, (x.def + pr.def * PRIOR_W) / (x.w + PRIOR_W));
    });
  }

  // --- per-team features
  teams.forEach(t => {
    const x = agg.get(t.name);
    if (!x) return;
    const thisSeason = x.games.filter(g => g.season === season && g.division === t.division);
    t.played = thisSeason.length;
    t.attack = adjAtt.get(t.name) ?? 1.3;
    t.defence = adjDef.get(t.name) ?? 1.3;
    const pr = priorFor(t.name);
    t.elo = elo.get(t.name) ?? 1450;
    t.ppgSeason = (x.pts + pr.ppg * PRIOR_W) / (x.w + PRIOR_W);
    t.drawRate = (x.d + pr.draw * PRIOR_W) / (x.w + PRIOR_W);
    t.homePpg = (x.hpts + 1.5 * PRIOR_W) / (x.hw + PRIOR_W);
    t.awayPpg = (x.apts + 1.1 * PRIOR_W) / (x.aw + PRIOR_W);
    const recent = [...x.games].filter(g => !CONV.formCurDiv || g.division === t.division).sort((p, q) => (p.date < q.date ? 1 : -1)).slice(0, 6);
    t.formPts = recent.reduce((s, g) => s + g.pts, 0) + (6 - recent.length) * 1; // pad missing games with a draw
    const recent10 = [...x.games].sort((p, q) => (p.date < q.date ? 1 : -1)).slice(0, 10);
    t.form10Pts = recent10.reduce((s, g) => s + g.pts, 0) + (10 - recent10.length) * 1;
    t.gamesLast8 = x.games.filter(g => days(g.date, asOf) <= 8).length;
    t.lastMatch = x.games.length ? x.games.reduce((m, g) => (g.date > m ? g.date : m), x.games[0].date) : null;
  });

  // --- tiers and 1–10 values per division
  for (const div of divisions) {
    const list = Array.from(teams.values()).filter(t => t.division === div);
    if (!list.length) continue;
    // strength = Elo (carries across seasons and divisions; margin-aware)
    const strength = rankValues(list.map(t => ({ name: t.name, raw: t.elo })));
    const sortedStrength = [...list].sort((a, b) => b.elo - a.elo);
    sortedStrength.forEach((t, i) => { t.tier = (Math.min(3, Math.floor((i / sortedStrength.length) * 4)) + 1) as 1 | 2 | 3 | 4; t.rank = i + 1; });
    const att = rankValues(list.map(t => ({ name: t.name, raw: t.attack })));
    const def = rankValues(list.map(t => ({ name: t.name, raw: t.defence })), true);
    const form = rankValues(list.map(t => ({ name: t.name, raw: t.formPts })));
    const home = rankValues(list.map(t => ({ name: t.name, raw: t.homePpg })));
    const away = rankValues(list.map(t => ({ name: t.name, raw: t.awayPpg })));
    const draws = rankValues(list.map(t => ({ name: t.name, raw: t.drawRate })));
    // squad value: log scale (a €900m squad vs €300m is the same step as €300m vs €100m); neutral when unknown
    // pitSquad: squad value as known at the time (monthly history) instead of today's snapshot — no look-ahead in backtests
    const sq = (n: string) => (CONV.pitSquad ? squadValueAt(group, n, asOf) : squadValueFor(group, n)?.top) || 0;
    const relegMult = (n: string) => {
      const g = relegNow.get(n);
      if (g === undefined) return 1;
      const fade = CONV.relegSquadGames > 0 ? Math.min(1, g / CONV.relegSquadGames) : 0;
      return CONV.relegSquadMult + (1 - CONV.relegSquadMult) * fade;
    };
    const withValue = list.map(t => ({ name: t.name, raw: sq(t.name) * relegMult(t.name) })).filter(x => x.raw > 0);
    const floored = new Map<string, number>();
    const logs = withValue.map(x => ({ name: x.name, raw: Math.log(x.raw) }));
    if (CONV.squadFloorRatio > 0 && logs.length >= 8) {
      const sorted = logs.map(x => x.raw).sort((x, y) => x - y);
      const floor = sorted[Math.floor(sorted.length / 2)] + Math.log(CONV.squadFloorRatio);
      for (const x of logs) if (x.raw < floor) { x.raw = floor; floored.set(x.name, Math.exp(floor)); }
    }
    const squad = rankValues(logs);
    // player quality (#1p): rank within the division; unknown = neutral
    const pqRaw = list.map(t => ({ name: t.name, raw: playerQualityOf(group, t.name, season) })).filter(x => x.raw !== null) as { name: string; raw: number }[];
    const pqVals = pqRaw.length >= 6 ? rankValues(pqRaw) : new Map<string, number>();
    let squadMissing = 5;
    if (CONV.squadMissingPct >= 0 && withValue.length >= 6) {
      const vs = [...squad.values()].sort((x, y) => x - y);
      squadMissing = vs[Math.round(CONV.squadMissingPct * (vs.length - 1))];
    }
    for (const t of list) {
      t.squadEur = floored.get(t.name) ?? (sq(t.name) || null);
      t.squadEst = floored.has(t.name);
      t.v = {
        strength: strength.get(t.name)!, attack: att.get(t.name)!, defence: def.get(t.name)!, form: form.get(t.name)!,
        home: home.get(t.name)!, away: away.get(t.name)!, draws: draws.get(t.name)!,
        squad: relegNow.has(t.name) && CONV.relegSquadCap < 10 ? Math.min(CONV.relegSquadCap, squad.get(t.name) ?? squadMissing) : (squad.get(t.name) ?? squadMissing),
        pq: pqVals.get(t.name) ?? 5.5,
        fresh: t.gamesLast8 === 0 ? 8 : t.gamesLast8 === 1 ? 6 : t.gamesLast8 === 2 ? 4 : 2
      };
    }
  }

  return { group, asOf, teams, leagueDrawRate, leagueAvgGoals, homeAdv };
}

/* ------------------------------------------------------------------ */
/* Scoring one match                                                   */
/* ------------------------------------------------------------------ */

function h2hLast10(all: HistoryMatch[], home: string, away: string, asOf: string, group?: string) {
  const pair = (m: HistoryMatch) => (m.home === home && m.away === away) || (m.home === away && m.away === home);
  let meet = all.filter(m => m.date < asOf && pair(m));
  // older seasons (h2h_archive), when switched on: the page shows them, so the model should see them too
  if (CONV.h2hArchive && group) {
    const old = h2hArchiveFor(group).get([home, away].sort().join('|'));
    if (old) meet = meet.concat(old.filter(m => m.date < asOf && (!CONV.h2hYears || (Date.parse(asOf) - Date.parse(m.date)) / (365.25 * 86400000) <= CONV.h2hYears)));
  }
  meet = meet.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
  if (!meet.length) return null;
  let share = 0;
  for (const m of meet) {
    const homeWon = (m.home === home && m.hg > m.ag) || (m.away === home && m.ag > m.hg);
    share += m.hg === m.ag ? 0.5 : homeWon ? 1 : 0;
  }
  return { n: meet.length, share: share / meet.length };
}

export function matchTypeFor(h: TeamFeat, a: TeamFeat, derby: boolean): MatchType {
  if (derby) return 'big';
  const gap = Math.abs(h.tier - a.tier);
  if (gap >= 2) return 'mismatch';
  if (h.rank <= 3 && a.rank <= 3) return 'big'; // top-of-the-table clash
  if (gap === 0) return 'even';
  return 'standard';
}

/** Poisson helpers for the goal-based extras (xG, over 2.5, BTTS, top scores) */
function poisson(l: number, k: number) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

/** Draw probability from two goal rates, with the Dixon-Coles low-score correction (rho = −0.1). */
function poissonDraw(lh: number, la: number) {
  const RHO = -0.1;
  let draw = 0, mass = 0;
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++) {
      let p = poisson(lh, i) * poisson(la, j);
      if (i === 0 && j === 0) p *= 1 - lh * la * RHO;
      else if (i === 0 && j === 1) p *= 1 + lh * RHO;
      else if (i === 1 && j === 0) p *= 1 + la * RHO;
      else if (i === 1 && j === 1) p *= 1 - RHO;
      mass += p;
      if (i === j) draw += p;
    }
  return draw / mass;
}

/** Pre-split numbers of the last scoreMatch call (used by the per-league tuner). */
let LAST_RAW: { gap: number; drawRaw: number; type: MatchType } | null = null;
/** Every row value of the last scoreMatch call (used by the full tuner, services/v3Tuner.ts). */
export interface ScoreDetail {
  div: string; type: MatchType;
  rows: { id: string; vh: number; va: number; counted: boolean }[];
  draws: { id: string; v: number }[];
  poisDraw: number; leagueDraw: number; derby: boolean; evidence: number;
}
export let LAST_DETAIL: ScoreDetail | null = null;
export const TEAM_ROW_IDS = ['#1', '#13', '#12', '#1e', '#19', '#14', '#10', '#23', '#7', '#21'];
export const DRAW_ROW_IDS = ['#15', '#30', '#16'];
export function rowRel(id: string): Record<MatchType, number> | null { const r = ROWS.find(x => x.id === id); return r ? { ...r.rel } : null; }
export function setRowRel(id: string, rel: Record<MatchType, number>) { const r = ROWS.find(x => x.id === id); if (r) r.rel = { ...rel }; }

/** Final step: draw pot + gap → home / draw / away points (unrounded), with optional league settings. */
function splitPoints(gap0: number, drawRaw: number, type: MatchType, lc?: LeagueConv) {
  const L = lc || LC0;
  const gap = gap0 + L.home;
  const close = L.close ? L.close * Math.max(0, 1 - Math.abs(gap) / CONV.drawCloseSpan) : 0;
  const drawPts = clamp(drawRaw + L.draw + close, CONV.floorDraw, CONV.drawCap[type] + Math.max(0, L.draw) + L.close);
  const gEff = (gap + (CONV.gapCube + L.cube) * gap * gap * gap) * L.stretch;
  const pH = 1 / (1 + Math.exp(-gEff / CONV.gapScale));
  const rest = 1000 - drawPts;
  let ptsH = rest * pH, ptsA = rest - ptsH;
  if (ptsA < CONV.floorOutsider) { ptsH -= CONV.floorOutsider - ptsA; ptsA = CONV.floorOutsider; }
  if (ptsH < CONV.floorOutsider) { ptsA -= CONV.floorOutsider - ptsH; ptsH = CONV.floorOutsider; }
  return { ptsH, ptsA, drawPts: 1000 - ptsH - ptsA };
}

const streakMemo = new WeakMap<HistoryMatch[], Map<string, number>>();

/** Home / draw / away chances from two Poisson goal rates. */
function poisson1x2(lh: number, la: number) {
  let H = 0, D = 0, A = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const q = poisson(lh, i) * poisson(la, j); if (i > j) H += q; else if (i === j) D += q; else A += q; }
  const t = H + D + A || 1;
  return { H: H / t, D: D / t, A: A / t };
}

/*
 * fix192: newcomers. A team with no games in the group gets the average profile of the division's bottom 3 (CONV.newcomer
 * 2, the best out of sample), or of the teams that came up into it over the last 3 seasons (1), or the division (3).
 * Memoised per state and mode (the live state is rebuilt every few hours).
 */
const NUM_FIELDS = ['ppgSeason', 'elo', 'attack', 'defence', 'formPts', 'form10Pts', 'homePpg', 'awayPpg', 'drawRate'] as const;
const newcomerMemo = new WeakMap<GroupState, Map<string, { tpl: TeamFeat; basis: NonNullable<TeamFeat['newcomer']> } | null>>();
function newcomerTemplate(state: GroupState, all: HistoryMatch[], div: string) {
  const divisions = GROUPS[state.group]?.divisions || [div];
  const rank = (d: string) => divisions.indexOf(d);
  const inDiv = [...state.teams.values()].filter(t => t.division === div);
  if (inDiv.length < 4) return null;
  let pool: TeamFeat[] = [];
  let basis: NonNullable<TeamFeat['newcomer']> = 'bottom3';
  if (CONV.newcomer === 1) {
    // the division each team played in, per season
    const bySeason = new Map<string, Map<string, string>>();
    for (const m of all) {
      if (m.date >= state.asOf) continue;
      let x = bySeason.get(m.season);
      if (!x) bySeason.set(m.season, (x = new Map()));
      x.set(m.home, m.division); x.set(m.away, m.division);
    }
    const seasons = [...bySeason.keys()].sort();
    const arrivals = new Set<string>();
    for (let i = Math.max(1, seasons.length - 3); i < seasons.length; i++) {
      const cur = bySeason.get(seasons[i])!, prev = bySeason.get(seasons[i - 1])!;
      cur.forEach((d, t) => {
        if (d !== div) return;
        const pd = prev.get(t);
        if (pd === div) return;
        if (pd && rank(pd) >= 0 && rank(pd) < rank(div)) return; // relegated from above: not a newcomer profile
        arrivals.add(t);
      });
    }
    pool = inDiv.filter(t => arrivals.has(t.name));
    if (pool.length >= 3) basis = 'promoted';
  }
  if (CONV.newcomer === 3) { pool = inDiv; basis = 'average'; }
  else if (basis === 'bottom3') pool = [...inDiv].sort((x, y) => x.elo - y.elo).slice(0, 3);
  const avg = (f: (t: TeamFeat) => number) => pool.reduce((s, t) => s + f(t), 0) / pool.length;
  const tpl: TeamFeat = { ...pool[0], division: div, played: 0, gamesLast8: 0, lastMatch: null, squadEur: null, squadEst: false, v: {} };
  for (const k of NUM_FIELDS) tpl[k] = avg(t => t[k]);
  tpl.formPts = Math.round(tpl.formPts); tpl.form10Pts = Math.round(tpl.form10Pts);
  const keys = new Set(pool.flatMap(t => Object.keys(t.v)));
  keys.forEach(k => { tpl.v[k] = Math.round(avg(t => t.v[k] ?? 5) * 10) / 10; });
  tpl.v.fresh = 5; // unknown fixture load: neutral
  tpl.rank = inDiv.filter(t => t.elo > tpl.elo).length + 1;
  tpl.tier = (Math.min(3, Math.floor(((tpl.rank - 1) / inDiv.length) * 4)) + 1) as TeamFeat['tier'];
  return { tpl, basis };
}
function newcomerFeat(state: GroupState, all: HistoryMatch[], name: string, div: string): TeamFeat | null {
  let memo = newcomerMemo.get(state);
  if (!memo) newcomerMemo.set(state, (memo = new Map()));
  const key = `${CONV.newcomer}|${div}`;
  if (!memo.has(key)) memo.set(key, newcomerTemplate(state, all, div));
  const x = memo.get(key);
  return x ? { ...x.tpl, name, v: { ...x.tpl.v }, newcomer: x.basis } : null;
}

export function scoreMatch(state: GroupState, all: HistoryMatch[], home: string, away: string, asOf: string, matchDate?: string): Prediction | null {
  let h = state.teams.get(home), a = state.teams.get(away);
  if ((!h || !a) && CONV.newcomer > 0 && home !== away) {
    // the division of the game: the known side's, else the group's top division
    const div = (h || a)?.division || GROUPS[state.group]?.divisions[0];
    if (div && !h) h = newcomerFeat(state, all, home, div) || undefined;
    if (div && !a) a = newcomerFeat(state, all, away, div) || undefined;
  }
  if (!h || !a) return null;
  const derby = isDerby(home, away);
  const type = matchTypeFor(h, a, derby);
  const div = h.division;
  const leagueDraw = state.leagueDrawRate[div] ?? 0.25;

  const h2h = h2hLast10(all, home, away, asOf, state.group);
  const rows: NonNullable<Prediction['grid']>['rows'] = [];
  let totH = 0, totA = 0, drawFactors = 0, relSum = 0;
  const detRows: ScoreDetail['rows'] = [], detDraws: ScoreDetail['draws'] = [];

  const push = (def: RowDef, vh: number, va: number, note?: string, counted = true) => {
    const rel = REL_OVERRIDE?.[def.id]?.[type] ?? def.rel[type];
    if (rel === 0 && def.id === '#1p') return; // switched off: not shown, no effect
    if (def.kind === 'team') {
      const ph = vh * rel, pa = va * rel;
      totH += ph; totA += pa; if (counted) relSum += rel;
      rows.push({ id: def.id, name: def.name, rel, home: vh, away: va, edge: Math.round((ph - pa) * 10) / 10, note: note || def.note });
      detRows.push({ id: def.id, vh, va, counted });
    } else {
      // draw rows: a single value (how much this pushes toward the draw), stored in both columns
      drawFactors += (vh - 5) * rel * CONV.kDraw;
      rows.push({ id: def.id, name: def.name, rel, home: vh, away: vh, edge: 0, note: note || def.note });
      detDraws.push({ id: def.id, v: vh });
    }
  };
  const R = (id: string) => ROWS.find(r => r.id === id)!;

  const eur = (x: number | null) => (x ? `€${Math.round(x / 1e6)}m` : 'n/a');
  push(R('#1'), h.v.squad, a.v.squad, h.squadEur || a.squadEur
    ? `top-15 value ${h.squadEst ? '~' : ''}${eur(h.squadEur)} vs ${a.squadEst ? '~' : ''}${eur(a.squadEur)}${h.squadEst || a.squadEst ? ' (~ = estimated, incomplete data for a promoted club)' : ''}`
    : 'no squad values loaded — neutral');
  push(R('#1p'), h.v.pq ?? 5.5, a.v.pq ?? 5.5);
  push(R('#1e'), h.v.strength, a.v.strength);
  // availability (API-Football): confirmed XI supersedes the injury list; rows without data are neutral and not counted
  const av = availabilityFor(state.group, home, away, matchDate || asOf);
  // a side without enough lineup history counts as neutral (5.5); the row is used when at least one side is known.
  // Availability rows are pure adjustments: they add their edge but never count in Σrel, so no news = no effect.
  const xiKnown = !!av && (av.home.absent !== null || av.away.absent !== null) && CONV.useLineups === 1;
  const avVal = (x: number | null, k: number) => (x === null ? 5.5 : Math.round(clamp(5.5 - k * x, CONV.valueLo, CONV.valueHi) * 10) / 10);
  const names = (l: string[], known: boolean) => (known ? l.join(', ') || 'none' : 'n/a');
  if (xiKnown) {
    const xiOf = (t: any) => (CONV.xiNet && t.absentNet !== undefined && t.absentNet !== null ? t.absentNet : t.absent);
    push(R('#12'), avVal(xiOf(av!.home), CONV.xiK), avVal(xiOf(av!.away), CONV.xiK),
      `usual starters out: ${names(av!.home.absentNames, av!.home.absent !== null)} | ${names(av!.away.absentNames, av!.away.absent !== null)}`, false);
    push(R('#13'), 5.5, 5.5, 'covered by the confirmed XI', false);
  } else {
    push(R('#12'), 5.5, 5.5, 'XI not published yet', false);
    if (av && (av.home.missing !== null || av.away.missing !== null))
      push(R('#13'), avVal(av.home.missing, CONV.injK), avVal(av.away.missing, CONV.injK),
        `out: ${names(av.home.missingNames, av.home.missing !== null)} | ${names(av.away.missingNames, av.away.missing !== null)}`, false);
    else push(R('#13'), 5.5, 5.5, 'no injury data for this match', false);
  }
  push(R('#19'), h.v.attack, a.v.attack);
  push(R('#14'), h.v.defence, a.v.defence);
  push(R('#10'), h.v.fresh, a.v.fresh, `${h.gamesLast8} vs ${a.gamesLast8} games in the last 8 days`);
  push(R('#23'), h.v.home, a.v.away, 'home record of the home side vs away record of the away side');
  // fewer than 3 meetings say nothing (one win in two games would read as a 10-vs-1 edge): neutral
  if (h2h && h2h.n >= 3) push(R('#7'), 1 + 9 * h2h.share, 1 + 9 * (1 - h2h.share), `${h2h.n} meetings, home side share ${Math.round(h2h.share * 100)}%`);
  else if (h2h) push(R('#7'), 5, 5, `only ${h2h.n} meeting${h2h.n > 1 ? 's' : ''} in the data — not enough to count`);
  else push(R('#7'), 5, 5, 'no previous meetings in the data');
  push(R('#21'), h.v.form, a.v.form, `last 6: ${h.formPts} vs ${a.formPts} pts`);
  // draw rows: draw-prone = average of both teams' draw values; league = draw rate vs 25% norm; derby flag
  push(R('#15'), Math.round(((h.v.draws + a.v.draws) / 2) * 10) / 10, 0);
  push(R('#30'), clamp(5 + (leagueDraw - 0.25) * 60, 1, 10), 0, `league draw rate ${Math.round(leagueDraw * 100)}%`);
  push(R('#16'), derby ? 8 : 5, 0, derby ? 'derby' : undefined);

  // --- goal rates (used by the draw pot in drawMode 1 and for the extras: xG / O2.5 / BTTS / scores)
  const avg = state.leagueAvgGoals[div] || 1.35;
  const ha = state.homeAdv[div] || 1.25;
  const lamH = clamp((h.attack / avg) * (a.defence / avg) * avg * Math.sqrt(ha), 0.3, 4);
  const lamA = clamp((a.attack / avg) * (h.defence / avg) * avg / Math.sqrt(ha), 0.3, 4);

  // --- relative gap between the two totals (+ league home advantage)
  const gap =
    (CONV.gapMode === 1 ? (totH - totA) / (11 * Math.max(1, relSum)) : (totH - totA) / (totH + totA)) + CONV.homeGap;

  // --- draw pot
  const base = CONV.drawMode === 1 ? Math.round(1000 * poissonDraw(lamH, lamA) * CONV.drawPoisScale) : CONV.drawBase[type];
  const volatility = 0; // no card/referee feed yet
  // closeness: draws are likelier when the sides are level
  const closeness = CONV.drawClose * Math.max(0, 1 - Math.abs(gap) / CONV.drawCloseSpan);
  let drawRaw = base + drawFactors + volatility + closeness;
  drawRaw = CONV.drawCenter + CONV.drawStretch * (drawRaw - CONV.drawCenter) - CONV.drawGapK * 1000 * Math.abs(gap - CONV.homeGap);
  LAST_RAW = { gap, drawRaw, type };
  LAST_DETAIL = { div, type, rows: detRows, draws: detDraws, poisDraw: poissonDraw(lamH, lamA), leagueDraw, derby, evidence: Math.min(h.played, a.played) };

  // --- split the 1000 points (with this league's own settings, if any)
  const lc = CONV.useLeagueConv ? LEAGUE_CONV.get(div) : undefined;
  const sp = splitPoints(gap, drawRaw, type, lc);
  let ptsH = Math.round(sp.ptsH), ptsA = Math.round(sp.ptsA);
  // Oct 2026 (Málaga–Espanyol): the 1X2 split and the goals model could disagree on the favourite. poisBlend mixes in
  // the win/draw/loss chances implied by the expected goals (same Poisson grid as the score extras). 0 = off.
  // poisBlendMode 0 blends all three; 1 keeps our draw and only re-splits home vs away.
  if (CONV.poisBlend > 0) {
    const ph = poisson1x2(lamH * CONV.goalScale, lamA * CONV.goalScale);
    const w = CONV.poisBlend;
    if (CONV.poisBlendMode === 1) {
      const dec = ptsH + ptsA, share = ptsH / Math.max(1, dec), pShare = ph.H / Math.max(1e-9, ph.H + ph.A);
      const s2 = (1 - w) * share + w * pShare;
      ptsH = Math.round(dec * s2); ptsA = dec - ptsH;
    } else {
      ptsH = Math.round((1 - w) * ptsH + w * 1000 * ph.H);
      ptsA = Math.round((1 - w) * ptsA + w * 1000 * ph.A);
    }
  }
  // Common-sense guard (Oct 2026, Yarin): a side that the rows rate weaker AND that is in clearly worse form over its
  // last 10 games may not come out as the favourite just because of home advantage. When both point the same way,
  // the order is flipped back with a small margin (guardMargin, in 1000-points). guardPts = minimum form gap, 0 = off.
  let guarded = false;
  if (CONV.guardPts > 0 || CONV.guardH2H > 0) {
    // > 0: away in better shape. Last-10 points gap, or (guardUsePpg) the season points-per-game gap scaled to 10 games
    const fg = a.form10Pts - h.form10Pts, pg = (a.ppgSeason - h.ppgSeason) * 10;
    const formGap = CONV.guardUsePpg ? (Math.abs(pg) > Math.abs(fg) ? pg : fg) : fg;
    const h2hBad = (share: number) => CONV.guardH2H > 0 && !!h2h && h2h.n >= 5 && share <= CONV.guardH2H;
    if (totA > totH && ((CONV.guardPts > 0 && formGap >= CONV.guardPts) || h2hBad(h2h ? h2h.share : 1)) && ptsH > ptsA - CONV.guardMargin) {
      const mid = (ptsH + ptsA) / 2;
      ptsH = Math.round(mid - CONV.guardMargin / 2); ptsA = Math.round(mid + CONV.guardMargin / 2); guarded = true;
    } else if (totH > totA && ((CONV.guardPts > 0 && -formGap >= CONV.guardPts) || h2hBad(h2h ? 1 - h2h.share : 1)) && ptsA > ptsH - CONV.guardMargin) {
      const mid = (ptsH + ptsA) / 2;
      ptsA = Math.round(mid - CONV.guardMargin / 2); ptsH = Math.round(mid + CONV.guardMargin / 2); guarded = true;
    }
  }
  const drawPts = 1000 - ptsH - ptsA;

  const grid: number[][] = [];
  let over25 = 0, btts = 0;
  const scores: { home: number; away: number; prob: number }[] = [];
  const gH = lamH * CONV.goalScale, gA = lamA * CONV.goalScale;
  for (let i = 0; i <= 8; i++) { grid.push([]); for (let j = 0; j <= 8; j++) { const p = poisson(gH, i) * poisson(gA, j); grid[i].push(p); if (i + j > 2.5) over25 += p; if (i > 0 && j > 0) btts += p; scores.push({ home: i, away: j, prob: p }); } }
  scores.sort((x, y) => y.prob - x.prob);

  // --- reasons: the rows with the largest edge, plus draw pushes
  const reasons: string[] = [];
  const byEdge = rows.filter(r => r.edge !== 0).sort((x, y) => Math.abs(y.edge) - Math.abs(x.edge)).slice(0, 3);
  for (const r of byEdge) reasons.push(`${r.name}: ${r.edge > 0 ? home : away} +${Math.abs(r.edge)}`);
  if (drawFactors > 8) reasons.push(`draw factors +${Math.round(drawFactors)} (${derby ? 'derby, ' : ''}draw-prone / league)`);
  if (lc) reasons.push(`league settings (${div}): ${describeLc(lc)}`);
  for (const t of [h, a]) if (t.newcomer) reasons.unshift(`new to this league: ${t.name} have no games in it yet, so they start from ${t.newcomer === 'promoted' ? 'the average of the teams promoted into it over the last 3 seasons' : t.newcomer === 'bottom3' ? 'the average of its bottom 3 teams' : 'the league average'}`);
  if (guarded) reasons.push(`common-sense check: form (last 10: ${h.form10Pts} vs ${a.form10Pts} pts, season ${h.ppgSeason.toFixed(2)} vs ${a.ppgSeason.toFixed(2)} ppg) and the factors agree, so the weaker side is not the favourite`);

  const evidence = Math.min(h.played, a.played);
  // draw streaks: bookmakers over-price draws for teams that drew a lot lately (draw-factor test, both seasons)
  const last20 = (t: string) => {
    let memo = streakMemo.get(all);
    if (!memo) streakMemo.set(all, (memo = new Map()));
    const key = `${t}|${asOf}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const g = all.filter(m => m.date < asOf && (m.home === t || m.away === t));
    const l = g.slice(-20);
    const v = l.length ? Math.round((l.filter(m => m.hg === m.ag).length / l.length) * 100) / 100 : 0;
    memo.set(key, v);
    return v;
  };
  return {
    model: MODEL_V3,
    ...(h.newcomer || a.newcomer ? { newcomer: { home: h.newcomer || null, away: a.newcomer || null } } : {}),
    drawStreak: { home: last20(home), away: last20(away) },
    home: ptsH / 10, draw: drawPts / 10, away: ptsA / 10,
    expectedGoals: { home: Math.round(gH * 100) / 100, away: Math.round(gA * 100) / 100 },
    over25: Math.round(over25 * 1000) / 10,
    btts: Math.round(btts * 1000) / 10,
    topScores: scores.slice(0, 5).map(s => ({ ...s, prob: Math.round(s.prob * 1000) / 10 })),
    confidence: evidence < 4 ? 'low' : evidence < 10 ? 'medium' : 'high',
    factors: {
      homeAttack: Math.round((h.attack / avg) * 100) / 100, homeDefence: Math.round((h.defence / avg) * 100) / 100,
      awayAttack: Math.round((a.attack / avg) * 100) / 100, awayDefence: Math.round((a.defence / avg) * 100) / 100,
      homeAdvantage: Math.round(ha * 100) / 100, homeForm: h.formPts / 18, awayForm: a.formPts / 18,
      gamesPlayed: { home: h.played, away: a.played }, leagueAvgGoals: Math.round(avg * 100) / 100
    },
    grid: {
      matchType: type,
      points: { home: ptsH, draw: drawPts, away: ptsA },
      totals: { home: Math.round(totH), away: Math.round(totA) },
      rows,
      drawPot: { base, factors: Math.round(drawFactors), volatility, closeness: Math.round(closeness), total: drawPts },
      reasons,
      // fix282: the league's home advantage (CONV.homeGap + the league's own) in the rows' points, so "Why we think so"
      // ranks it with the rows from the model's own sums (gap = Σedge / scale + home)
      homeEdge: Math.round((CONV.homeGap + (lc?.home || 0)) * (CONV.gapMode === 1 ? 11 * Math.max(1, relSum) : totH + totA) * 10) / 10
    }
  };
}

/* ------------------------------------------------------------------ */
/* Live use                                                            */
/* ------------------------------------------------------------------ */

const liveState = new Map<string, { state: GroupState; all: HistoryMatch[] }>();
let lastBuiltAt: string | null = null;

/**
 * Same as prepareModelV3, but gives the server a breath between groups (20 groups since Oct 2026), so visitors
 * are not kept waiting while the whole model is rebuilt.
 */
export async function prepareModelV3Async() {
  const asOf = new Date(Date.now() + DAY).toISOString().slice(0, 10);
  let built = 0;
  for (const group of Object.keys(GROUPS)) {
    await yieldLoop();
    const all = loadGroupMatches(group);
    if (all.length < 100) continue;
    liveState.set(group, { state: withLiveConfig(() => buildState(group, all, asOf)), all });
    built++;
  }
  lastBuiltAt = new Date().toISOString();
  clearPredictionCache();
  trendCache.clear();
  markFresh('model', `${built} groups`);
  logger.info(`model v3 state built for ${built} groups`);
  publishV3();
  await warmTrends();
  return built;
}

/*
 * fix202: the worker builds the group states; the web process reads them (the match and team pages). Each group is its
 * own key (one at a time to load); 'v3:meta' comes last and makes the web process re-read the stored tuning.
 */
function publishV3() {
  if (!runsJobs) return;
  for (const [group, v] of liveState) publishState(`v3:g:${group}`, v);
  publishState('v3:meta', { lastBuiltAt });
}
onState('v3:', (key, v) => {
  if (key.startsWith('v3:g:')) { liveState.set(key.slice(5), v); return; }
  if (key === 'v3:meta') {
    lastBuiltAt = v.lastBuiltAt;
    applyStoredTuning();
    loadLeagueConv();
    clearPredictionCache();
  } else if (key.startsWith('v3:trend:')) trendCache.set(key.slice(9), v);
});
/** fix202 (worker): the team pages' trend snapshots of every group, built here (12 h), not on a visitor's request */
async function warmTrends() {
  if (!runsJobs) return;
  for (const group of liveState.keys()) {
    const c = trendCache.get(group);
    if (c && Date.now() - c.at < 12 * 3600 * 1000) continue;
    await yieldLoop();
    trendSnaps(group);
    const t = trendCache.get(group);
    if (t) publishState(`v3:trend:${group}`, t);
  }
}

/** Rebuild every group's state as of today (cheap: a few thousand rows per group). */
export function prepareModelV3() {
  const asOf = new Date(Date.now() + DAY).toISOString().slice(0, 10); // include today's finished games
  let built = 0;
  for (const group of Object.keys(GROUPS)) {
    const all = loadGroupMatches(group);
    if (all.length < 100) continue;
    liveState.set(group, { state: withLiveConfig(() => buildState(group, all, asOf)), all });
    built++;
  }
  lastBuiltAt = new Date().toISOString();
  clearPredictionCache();
  trendCache.clear();
  markFresh('model', `${built} groups`);
  logger.info(`model v3 state built for ${built} groups`);
  publishV3();
  void warmTrends();
  return built;
}

/** v3 prediction for a Football-Data.org match object, or null if not covered. */
export function predictV3(match: any): Prediction | null {
  const code = match?.competition?.code;
  const group = code ? groupForCompetition(code) : null;
  if (!group) return null;
  const live = liveState.get(group);
  if (!live) return null;
  // fix192: a team the map doesn't know has no games in the group's history (a play-off side from the division below,
  // a promoted club before its first game): it plays under its own name and scoreMatch gives it the newcomer profile
  const home = fdNameFor(group, match.homeTeam?.id) || (CONV.newcomer ? match.homeTeam?.name : null);
  const away = fdNameFor(group, match.awayTeam?.id) || (CONV.newcomer ? match.awayTeam?.name : null);
  if (!home || !away || home === away) return null;
  const date = String(match.utcDate || '').slice(0, 10) || undefined;
  const res = withLiveConfig(() => scoreMatch(live.state, live.all, home, away, live.state.asOf, date));
  // Confirmed lineups are in and counted: also send the numbers from before them, so the page can show what changed
  if (res?.grid?.rows.some(r => r.id === '#12' && /^usual starters out/.test(r.note || ''))) {
    const pre = withLiveConfig(() => {
      const keep = CONV.useLineups;
      CONV.useLineups = 0;
      try { return scoreMatch(live.state, live.all, home, away, live.state.asOf, date); } finally { CONV.useLineups = keep; }
    });
    if (pre) res.beforeLineups = { home: pre.home, draw: pre.draw, away: pre.away, over25: pre.over25, btts: pre.btts };
  }
  return res;
}

/** v3 prediction by football-data.co.uk names (used by CLV tracking, which works from API-Football fixtures). */
export function predictV3ByNames(group: string, home: string, away: string, date: string): Prediction | null {
  const live = liveState.get(group);
  if (!live) return null;
  return withLiveConfig(() => scoreMatch(live.state, live.all, home, away, live.state.asOf, date.slice(0, 10)));
}

/*
 * Team analysis: how v3 sees one team now, and how that changed over the last months (state rebuilt at a few past
 * dates; the snapshots are shared by every team of the group and kept for 12 hours).
 */
const trendCache = new Map<string, { at: number; snaps: { date: string; state: GroupState }[] }>();
function trendSnaps(group: string) {
  const live = liveState.get(group);
  if (!live) return [];
  const c = trendCache.get(group);
  if (c && Date.now() - c.at < 12 * 3600 * 1000) return c.snaps;
  // fix202: the web process never rebuilds them (the worker publishes them with the model)
  if (!runsJobs) return c?.snaps || [];
  const snaps: { date: string; state: GroupState }[] = [];
  for (let back = 6; back >= 1; back--) {
    const date = new Date(Date.now() - back * 30 * DAY).toISOString().slice(0, 10);
    try { snaps.push({ date, state: withLiveConfig(() => buildState(group, live.all, date)) }); } catch { /* skip */ }
  }
  trendCache.set(group, { at: Date.now(), snaps });
  return snaps;
}

export function teamModelView(group: string, name: string) {
  const live = liveState.get(group);
  const t = live?.state.teams.get(name);
  if (!live || !t) return null;
  const peers = [...live.state.teams.values()].filter(x => x.division === t.division && x.played > 0);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  // strength rank among the teams actually playing in that division that season (by Elo)
  const rankIn = (st: GroupState, x: TeamFeat) =>
    [...st.teams.values()].filter(y => y.division === x.division && y.played > 0 && y.elo > x.elo).length + 1;
  const point = (st: GroupState, date: string) => {
    const x = st.teams.get(name);
    if (!x || x.division !== t.division || x.played === 0) return null;
    return { date, elo: Math.round(x.elo), rank: rankIn(st, x), attack: r2(x.attack), defence: r2(x.defence) };
  };
  const trend = [...trendSnaps(group).map(s => point(s.state, s.date)), point(live.state, live.state.asOf)].filter(Boolean);
  return {
    division: t.division,
    teams: peers.length,
    played: t.played,
    rank: rankIn(live.state, t),
    elo: Math.round(t.elo),
    attack: r2(t.attack),
    defence: r2(t.defence),
    leagueGoals: r2(live.state.leagueAvgGoals[t.division] || 0),
    ppg: r2(t.ppgSeason),
    homePpg: r2(t.homePpg),
    awayPpg: r2(t.awayPpg),
    formPts: t.formPts,
    drawRate: Math.round(t.drawRate * 100),
    squadEur: t.squadEur,
    scores: t.v,
    asOf: live.state.asOf,
    trend
  };
}

export function modelV3Status() {
  const groups: Record<string, any> = {};
  liveState.forEach((v, g) => {
    groups[g] = { teams: v.state.teams.size, asOf: v.state.asOf, leagueDrawRate: v.state.leagueDrawRate };
  });
  return { model: MODEL_V3, lastBuiltAt, conv: CONV, leagueConv: Object.fromEntries([...LEAGUE_CONV].map(([d, lc]) => [d, describeLc(lc)])), rows: ROWS.map(r => ({ id: r.id, name: r.name, rel: r.rel })), groups };
}

/* ------------------------------------------------------------------ */
/* Backtest (same harness/tables as v2, model = grid-v3)               */
/* ------------------------------------------------------------------ */

// Prepared lazily: the backtest tables are created by historyModel.ts, which may load after this file
let insertBtStmt: any = null;
const insertBt = () =>
  (insertBtStmt ||= db.prepare(`
    INSERT OR REPLACE INTO backtest_predictions
      (run_id, division, date, home, away, hg, ag, outcome, p_home, p_draw, p_away, xg_home, xg_away, odds_home, odds_draw, odds_away, early_h, early_d, early_a, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `));

let running: { season: string; group: string; done: number; total: number } | null = null;
export const backtestProgressV3 = () => running;

export async function runBacktestV3(season: string, group: string, conv: Partial<typeof CONV> = {}, allDivisions = false) {
  const saved = { ...CONV };
  Object.assign(CONV, conv);
  try {
    const divs = GROUPS[group]?.divisions || [];
    if (!divs.length) throw new Error(`Unknown group ${group}`);
    const all = loadGroupMatches(group);
    const target = all.filter(m => m.season === season && (allDivisions ? divs.includes(m.division) : m.division === divs[0]));
    if (!target.length) throw new Error(`No matches for ${group} ${season}`);

    db.prepare(`DELETE FROM backtest_predictions WHERE run_id IN (SELECT id FROM backtest_runs WHERE season = ? AND grp = ? AND model = ?)`).run(season, group, MODEL_V3);
    db.prepare(`DELETE FROM backtest_runs WHERE season = ? AND grp = ? AND model = ?`).run(season, group, MODEL_V3);
    const runId = Number(
      db.prepare(`INSERT INTO backtest_runs (season, grp, model, matches, started_at, params) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(season, group, MODEL_V3, target.length, new Date().toISOString(), JSON.stringify(CONV)).lastInsertRowid
    );

    running = { season, group, done: 0, total: target.length };
    let cursor = new Date(target[0].date);
    const last = new Date(target[target.length - 1].date);
    let predicted = 0;
    while (cursor <= last) {
      const from = cursor.toISOString().slice(0, 10);
      const to = new Date(cursor.getTime() + 7 * DAY).toISOString().slice(0, 10);
      const week = target.filter(m => m.date >= from && m.date < to);
      if (week.length) {
        const state = buildState(group, all, from, weekDivs(week));
        db.exec('BEGIN');
        try {
          for (const m of week) {
            const p = scoreMatch(state, all, m.home, m.away, from, m.date);
            if (!p) continue;
            const outcome = m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D';
            insertBt().run(
              runId, m.division, m.date, m.home, m.away, m.hg, m.ag, outcome,
              p.home, p.draw, p.away, p.expectedGoals.home, p.expectedGoals.away,
              m.close_h ?? m.odds_h, m.close_d ?? m.odds_d, m.close_a ?? m.odds_a,
              m.odds_h, m.odds_d, m.odds_a,
              Math.min(p.factors.gamesPlayed.home, p.factors.gamesPlayed.away)
            );
            predicted++;
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        running.done += week.length;
        await new Promise<void>(resolve => setImmediate(() => resolve()));
      }
      cursor = new Date(cursor.getTime() + 7 * DAY);
    }
    db.prepare(`UPDATE backtest_runs SET finished_at = ?, matches = ? WHERE id = ?`).run(new Date().toISOString(), predicted, runId);
    logger.info(`Backtest v3 ${group} ${season}: ${predicted} predictions`);
    return { runId, predicted };
  } finally {
    Object.assign(CONV, saved);
    running = null;
  }
}

export async function runBacktestV3All(season: string, conv: Partial<typeof CONV> = {}, allDivisions = false) {
  const out: Record<string, any> = {};
  for (const group of Object.keys(GROUPS)) {
    try { out[group] = await runBacktestV3(season, group, conv, allDivisions); } catch (error: any) { out[group] = { error: error.message }; }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sweep: many variants of CONV / relevance, in memory, one table back  */
/* ------------------------------------------------------------------ */

export interface SweepVariant {
  name: string;
  conv?: Partial<typeof CONV>;
  rel?: RelOverride;
}

interface SweepMetrics {
  n: number;
  hitRate: number;
  brier: number;
  logLoss: number;
  picks: { H: number; D: number; A: number };
  avgDraw: number; // mean predicted draw %
}

const MATCH_TYPES: MatchType[] = ['mismatch', 'standard', 'even', 'big'];

/** Deep-merge conv overrides (drawBase / drawCap are nested). */
function mergeConv(base: typeof CONV, over: Partial<typeof CONV> | undefined): typeof CONV {
  const out: any = { ...base, drawBase: { ...base.drawBase }, drawCap: { ...base.drawCap } };
  if (!over) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object') out[k] = { ...out[k], ...(v as any) };
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Automatic variant lists for a coordinate-descent style search. */
export function autoVariants(kind: string, step = 1): SweepVariant[] {
  const out: SweepVariant[] = [];
  if (kind === 'gapcube') {
    for (const c of [1, 2, 4, 8, 16]) out.push({ name: `gapCube ${c}`, conv: { gapCube: c } as any });
    for (const c of [2, 4, 8]) for (const gs of [0.18, 0.22]) out.push({ name: `gapCube ${c} gapScale ${gs}`, conv: { gapCube: c, gapScale: gs } as any });
  }
  if (kind === 'drawspread') {
    for (const st of [1, 1.25, 1.5, 1.75, 2, 2.5])
      for (const gk of [0, 0.1, 0.2, 0.35])
        if (st !== 1 || gk !== 0) out.push({ name: `drawStretch ${st} drawGapK ${gk}`, conv: { drawStretch: st, drawGapK: gk } as any });
  }
  if (kind === 'rel') {
    for (const row of ROWS)
      for (const t of MATCH_TYPES)
        for (const d of [-step, step]) {
          const r = row.rel[t] + d;
          if (r < 0 || r > 6) continue;
          out.push({ name: `${row.id} ${t} ${row.rel[t]}→${r}`, rel: { [row.id]: { [t]: r } } });
        }
  } else if (kind === 'rows') {
    for (const row of ROWS) {
      const mk = (f: (r: number) => number) => Object.fromEntries(MATCH_TYPES.map(t => [t, f(row.rel[t])])) as Partial<Record<MatchType, number>>;
      out.push({ name: `${row.id} off`, rel: { [row.id]: mk(() => 0) } });
      out.push({ name: `${row.id} half`, rel: { [row.id]: mk(r => r / 2) } });
      out.push({ name: `${row.id} x2`, rel: { [row.id]: mk(r => r * 2) } });
    }
  } else if (kind === 'shape') {
    // score-time structure: linear gap, goals-based draw pot, and both
    for (const gs of [0.2, 0.24, 0.28, 0.32, 0.36, 0.42]) out.push({ name: `gapMode 1 gapScale ${gs}`, conv: { gapMode: 1, gapScale: gs } });
    for (const ds of [0.9, 1.0, 1.1]) for (const k of [0, 1, 2])
      out.push({ name: `drawMode 1 scale ${ds} kDraw ${k}`, conv: { drawMode: 1, drawPoisScale: ds, kDraw: k } });
    for (const gs of [0.24, 0.28, 0.32, 0.36]) for (const ds of [1.0, 1.1])
      out.push({ name: `both gapScale ${gs} drawScale ${ds}`, conv: { gapMode: 1, gapScale: gs, drawMode: 1, drawPoisScale: ds, kDraw: 1 } });
  } else if (kind === 'avail') {
    for (const k of [0, 1, 2, 3, 4, 6, 8]) out.push({ name: `injK ${k}`, conv: { injK: k } });
    for (const k of [0, 1, 2, 3, 4, 6, 8]) out.push({ name: `xiK ${k}`, conv: { xiK: k } });
    out.push({ name: 'provisional (no XI)', conv: { useLineups: 0 } });
  } else if (kind === 'conv') {
    for (const g of [-0.04, -0.02, 0.02, 0.04]) out.push({ name: `gapScale ${(CONV.gapScale + g).toFixed(2)}`, conv: { gapScale: CONV.gapScale + g } });
    for (const g of [-0.02, -0.01, 0.01, 0.02]) out.push({ name: `homeGap ${(CONV.homeGap + g).toFixed(3)}`, conv: { homeGap: CONV.homeGap + g } });
    for (const k of [1, 3, 4]) out.push({ name: `kDraw ${k}`, conv: { kDraw: k } });
    for (const c of [40, 80, 120, 160]) for (const sp of [0.2, 0.3, 0.45]) out.push({ name: `drawClose ${c} span ${sp}`, conv: { drawClose: c, drawCloseSpan: sp } });
    // closeness paid for by a lower base, so the average draw stays put
    for (const c of [60, 100, 140, 180]) for (const sp of [0.2, 0.3]) for (const f of [0.4, 0.6]) {
      const shift = Math.round(c * f);
      const drawBase = Object.fromEntries(MATCH_TYPES.map(t => [t, CONV.drawBase[t] - shift])) as Record<MatchType, number>;
      out.push({ name: `drawClose ${c} span ${sp} base -${shift}`, conv: { drawClose: c, drawCloseSpan: sp, drawBase } });
    }
    for (const t of MATCH_TYPES)
      for (const d of [-40, -20, 20, 40])
        out.push({ name: `drawBase.${t} ${CONV.drawBase[t] + d}`, conv: { drawBase: { [t]: CONV.drawBase[t] + d } as any } });
    for (const hl of [60, 90, 180]) out.push({ name: `halfLifeProd ${hl}`, conv: { halfLifeProd: hl } });
  }
  return out;
}

/**
 * Compact variant syntax for URLs: variants separated by ';', rows by '/', e.g.
 *   r=#1:0,0,0,0;#7:2,4,6,8/#21:4,6,8,6      (order: mismatch,standard,even,big; '-' keeps the default)
 */
export function parseCompactVariants(text: string): SweepVariant[] {
  return text.split(';').map(s => s.trim()).filter(Boolean).map(spec => {
    const rel: RelOverride = {};
    for (const part of spec.split('/')) {
      const [rawId, vals] = part.split(':');
      if (!rawId || !vals) continue;
      const id = rawId.trim().startsWith('#') ? rawId.trim() : `#${rawId.trim()}`; // '#' is a URL fragment, so "1e:..." works too
      const nums = vals.split(',');
      rel[id] = {};
      MATCH_TYPES.forEach((t, i) => { const n = parseFloat(nums[i]); if (Number.isFinite(n)) rel[id][t] = n; });
    }
    return { name: spec, rel };
  });
}

/**
 * Score every variant on one season, walk-forward like the real backtest, without touching the
 * DB. States are built once per week and shared by all variants (they depend only on the
 * half-lives, which the sweep keeps fixed), so 50 variants cost about as much as one run.
 */
export let sweepProgress: { done: number; total: number } | null = null;

export async function sweepV3(season: string, variants: SweepVariant[], baseConv: Partial<typeof CONV> = {}, groups?: string[], allDivisions = false) {
  const savedConv = { ...CONV, drawBase: { ...CONV.drawBase }, drawCap: { ...CONV.drawCap } };
  const savedRel = REL_OVERRIDE;
  const t0 = Date.now();
  try {
    // 1) collect (state, match) pairs, weekly walk-forward, with the base conv (half-lives)
    Object.assign(CONV, mergeConv(savedConv, baseConv));
    type Item = { state: GroupState; all: HistoryMatch[]; m: HistoryMatch; from: string };
    const items: Item[] = [];
    for (const group of groups?.length ? groups : Object.keys(GROUPS)) {
      const divs = GROUPS[group]?.divisions || [];
      if (!divs.length) continue;
      const all = loadGroupMatches(group);
      const target = all.filter(m => m.season === season && (allDivisions ? divs.includes(m.division) : m.division === divs[0]));
      if (!target.length) continue;
      let cursor = new Date(target[0].date);
      const last = new Date(target[target.length - 1].date);
      while (cursor <= last) {
        const from = cursor.toISOString().slice(0, 10);
        const to = new Date(cursor.getTime() + 7 * DAY).toISOString().slice(0, 10);
        const week = target.filter(m => m.date >= from && m.date < to);
        if (week.length) {
          const state = buildState(group, all, from, weekDivs(week));
          for (const m of week) items.push({ state, all, m, from });
          await new Promise<void>(resolve => setImmediate(() => resolve()));
        }
        cursor = new Date(cursor.getTime() + 7 * DAY);
      }
    }

    // 2) market reference (closing odds, margin removed)
    const market = { n: 0, hit: 0, brier: 0, ll: 0 };
    for (const { m } of items) {
      const oh = m.close_h ?? m.odds_h, od = m.close_d ?? m.odds_d, oa = m.close_a ?? m.odds_a;
      if (!oh || !od || !oa) continue;
      const s = 1 / oh + 1 / od + 1 / oa;
      const p = { H: 1 / oh / s, D: 1 / od / s, A: 1 / oa / s };
      const o = m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D';
      market.n++;
      market.brier += (p.H - (o === 'H' ? 1 : 0)) ** 2 + (p.D - (o === 'D' ? 1 : 0)) ** 2 + (p.A - (o === 'A' ? 1 : 0)) ** 2;
      market.ll += -Math.log(Math.max(1e-6, p[o]));
      const pick = p.H >= p.D && p.H >= p.A ? 'H' : p.A >= p.D ? 'A' : 'D';
      if (pick === o) market.hit++;
    }

    // 3) score each variant
    const evalVariant = (v: SweepVariant): SweepMetrics => {
      Object.assign(CONV, mergeConv(mergeConv(savedConv, baseConv), v.conv));
      REL_OVERRIDE = v.rel || null;
      let n = 0, hit = 0, brier = 0, ll = 0, drawSum = 0;
      const picks = { H: 0, D: 0, A: 0 };
      for (const it of items) {
        const p = scoreMatch(it.state, it.all, it.m.home, it.m.away, it.from, it.m.date);
        if (!p) continue;
        const pH = p.home / 100, pD = p.draw / 100, pA = p.away / 100;
        const o = it.m.hg > it.m.ag ? 'H' : it.m.hg < it.m.ag ? 'A' : 'D';
        n++;
        brier += (pH - (o === 'H' ? 1 : 0)) ** 2 + (pD - (o === 'D' ? 1 : 0)) ** 2 + (pA - (o === 'A' ? 1 : 0)) ** 2;
        ll += -Math.log(Math.max(1e-6, o === 'H' ? pH : o === 'D' ? pD : pA));
        drawSum += pD;
        const pick = pH >= pD && pH >= pA ? 'H' : pA >= pD ? 'A' : 'D';
        picks[pick]++;
        if (pick === o) hit++;
      }
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      return { n, hitRate: Math.round((hit / Math.max(1, n)) * 1000) / 10, brier: r3(brier / Math.max(1, n)), logLoss: r3(ll / Math.max(1, n)), picks, avgDraw: Math.round((drawSum / Math.max(1, n)) * 1000) / 10 };
    };

    const base = evalVariant({ name: 'base' });
    const results: any[] = [];
    for (const v of variants) {
      const m = evalVariant(v);
      results.push({ name: v.name, ...m, dBrier: Math.round((m.brier - base.brier) * 1000) / 1000, dLogLoss: Math.round((m.logLoss - base.logLoss) * 1000) / 1000, conv: v.conv, rel: v.rel });
      sweepProgress = { done: results.length, total: variants.length };
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }
    results.sort((a, b) => a.brier - b.brier || a.logLoss - b.logLoss);

    let outcomes = { H: 0, D: 0, A: 0 };
    for (const { m } of items) outcomes[m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D']++;

    return {
      season,
      matches: items.length,
      outcomes,
      market: { n: market.n, hitRate: Math.round((market.hit / Math.max(1, market.n)) * 1000) / 10, brier: Math.round((market.brier / Math.max(1, market.n)) * 1000) / 1000, logLoss: Math.round((market.ll / Math.max(1, market.n)) * 1000) / 1000 },
      baseConv: mergeConv(savedConv, baseConv),
      base,
      variants: results,
      ms: Date.now() - t0
    };
  } finally {
    Object.assign(CONV, savedConv);
    REL_OVERRIDE = savedRel;
    sweepProgress = null;
  }
}

/* ------------------------------------------------------------------ */
/* Backfill: v3 predictions for tracked matches that predate the model  */
/* ------------------------------------------------------------------ */

let backfillColumnReady = false;
function ensureBackfillColumn() {
  if (backfillColumnReady) return;
  const cols = (db.prepare(`PRAGMA table_info(predictions)`).all() as any[]).map(c => c.name);
  if (!cols.includes('backfilled')) db.exec(`ALTER TABLE predictions ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0`);
  backfillColumnReady = true;
}

/**
 * Give v3 the same tracked history as v2: for every settled v2 prediction without a v3 row,
 * score the match with the state as of its kick-off date (only matches before that date are
 * used, exactly like the backtest), copy the market odds, and store it locked + settled and
 * flagged `backfilled = 1` so it can be told apart from predictions made live.
 */
export function backfillV3(model = 'dc-history-v2', redo = false) {
  ensureBackfillColumn();
  if (redo) db.prepare(`DELETE FROM predictions WHERE model = ? AND backfilled = 1`).run(MODEL_V3);
  const rows = db.prepare(`
    SELECT p.match_id, p.competition_code, p.competition_name, p.utc_date, p.home_team_id, p.home_team, p.away_team_id, p.away_team,
           p.odds_home, p.odds_draw, p.odds_away, p.settled, p.locked
    FROM predictions p
    WHERE p.model = ? AND p.locked = 1
      AND NOT EXISTS (SELECT 1 FROM predictions q WHERE q.match_id = p.match_id AND q.model = ?)
    ORDER BY p.utc_date
  `).all(model, MODEL_V3) as any[];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO predictions (
      match_id, model, competition_code, competition_name, utc_date, home_team_id, home_team, away_team_id, away_team,
      p_home, p_draw, p_away, xg_home, xg_away, over25, btts, confidence, games_home, games_away,
      odds_home, odds_draw, odds_away, locked, locked_at, settled, created_at, updated_at, backfilled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)
  `);
  const states = new Map<string, { state: GroupState; all: HistoryMatch[] }>();
  const now = new Date().toISOString();
  let done = 0, skipped = 0;
  const skippedWhy: Record<string, number> = {};
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const group = r.competition_code ? groupForCompetition(r.competition_code) : null;
      if (!group) { skipped++; skippedWhy['no group'] = (skippedWhy['no group'] || 0) + 1; continue; }
      const home = fdNameFor(group, r.home_team_id);
      const away = fdNameFor(group, r.away_team_id);
      if (!home || !away) { skipped++; skippedWhy['team not mapped'] = (skippedWhy['team not mapped'] || 0) + 1; continue; }
      const asOf = String(r.utc_date).slice(0, 10); // matches strictly before kick-off day
      const key = `${group}|${asOf}`;
      let s = states.get(key);
      if (!s) {
        const all = loadGroupMatches(group);
        s = { state: buildState(group, all, asOf), all };
        states.set(key, s);
      }
      const p = scoreMatch(s.state, s.all, home, away, asOf, asOf);
      if (!p) { skipped++; skippedWhy['no prediction'] = (skippedWhy['no prediction'] || 0) + 1; continue; }
      insert.run(
        r.match_id, MODEL_V3, r.competition_code, r.competition_name, r.utc_date, r.home_team_id, r.home_team, r.away_team_id, r.away_team,
        p.home, p.draw, p.away, p.expectedGoals.home, p.expectedGoals.away, p.over25, p.btts, p.confidence,
        p.factors.gamesPlayed.home, p.factors.gamesPlayed.away,
        r.odds_home, r.odds_draw, r.odds_away, r.utc_date, r.settled, now, now
      );
      done++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  logger.info(`v3 backfill: ${done} predictions added, ${skipped} skipped`, skippedWhy);
  return { candidates: rows.length, added: done, skipped, skippedWhy };
}

/* ------------------------------------------------------------------ */
/* Per-league tuner                                                     */
/* ------------------------------------------------------------------ */
/*
 * 1. Walk-forward over three seasons (train, test, extra), every division of every group, with the live
 *    config; each match keeps only the numbers the final split needs (gap, draw pot, match type).
 * 2. Per division: try every combination of the five league settings on the TRAIN season, keep the best.
 * 3. Check it on the TEST season (never seen). It passes only if it beats the shared model there.
 * 4. A passing division is refitted on train + test together (more data) — that is the live setting.
 * 5. EXTRA (the current season) was not used by any fit: an honest last look.
 */
type TuneItem = { div: string; season: string; gap: number; drawRaw: number; type: MatchType; o: 'H' | 'D' | 'A'; mkt: { H: number; D: number; A: number } | null };
export let leagueTuneProgress: { stage: string; done: number; total: number } | null = null;

const TUNE_GRID = {
  draw: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50],
  home: [-0.04, -0.02, 0, 0.02, 0.04],
  stretch: [0.85, 0.92, 1, 1.08, 1.16, 1.25],
  cube: [0, 3, 6],
  close: [0, 40, 80]
};

async function collectTuneItems(seasons: string[]): Promise<TuneItem[]> {
  const out: TuneItem[] = [];
  const groups = Object.keys(GROUPS);
  let gi = 0;
  for (const group of groups) {
    leagueTuneProgress = { stage: `collecting ${group}`, done: gi++, total: groups.length };
    const divs = GROUPS[group].divisions;
    const all = loadGroupMatches(group);
    for (const season of seasons) {
      const target = all.filter(m => m.season === season && divs.includes(m.division));
      if (!target.length) continue;
      let cursor = new Date(target[0].date);
      const last = new Date(target[target.length - 1].date);
      while (cursor <= last) {
        const from = cursor.toISOString().slice(0, 10);
        const to = new Date(cursor.getTime() + 7 * DAY).toISOString().slice(0, 10);
        const week = target.filter(m => m.date >= from && m.date < to);
        if (week.length) {
          withLiveConfig(() => {
            const state = buildState(group, all, from, weekDivs(week));
            for (const m of week) {
              LAST_RAW = null;
              const p = scoreMatch(state, all, m.home, m.away, from, m.date);
              if (!p || !LAST_RAW) continue;
              const raw = LAST_RAW as { gap: number; drawRaw: number; type: MatchType };
              const oh = m.close_h ?? m.odds_h, od = m.close_d ?? m.odds_d, oa = m.close_a ?? m.odds_a;
              let mkt: TuneItem['mkt'] = null;
              if (oh && od && oa) { const s = 1 / oh + 1 / od + 1 / oa; mkt = { H: 1 / oh / s, D: 1 / od / s, A: 1 / oa / s }; }
              out.push({ div: m.division, season, gap: raw.gap, drawRaw: raw.drawRaw, type: raw.type, o: m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D', mkt });
            }
          });
          await new Promise<void>(resolve => setImmediate(() => resolve()));
        }
        cursor = new Date(cursor.getTime() + 7 * DAY);
      }
    }
  }
  return out;
}

const sq = (x: number) => x * x;
function probsOf(it: TuneItem, lc: LeagueConv) {
  const s = splitPoints(it.gap, it.drawRaw, it.type, lc);
  return { H: s.ptsH / 1000, D: s.drawPts / 1000, A: s.ptsA / 1000 };
}
const brierP = (p: { H: number; D: number; A: number }, o: 'H' | 'D' | 'A') =>
  sq(p.H - (o === 'H' ? 1 : 0)) + sq(p.D - (o === 'D' ? 1 : 0)) + sq(p.A - (o === 'A' ? 1 : 0));

/** n, mean Brier, total Brier, hit rate, average predicted draw %, real draw % — model (lc) or market (lc = 'market'). */
function tuneSummary(items: TuneItem[], lc: LeagueConv | 'market') {
  let n = 0, br = 0, hit = 0, dr = 0, realD = 0;
  for (const it of items) {
    if (!it.mkt) continue; // same matches for model and market
    const p = lc === 'market' ? it.mkt : probsOf(it, lc);
    n++;
    br += brierP(p, it.o);
    dr += p.D;
    if (it.o === 'D') realD++;
    const pick = p.H >= p.D && p.H >= p.A ? 'H' : p.A >= p.D ? 'A' : 'D';
    if (pick === it.o) hit++;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { n, brier: Math.round((br / Math.max(1, n)) * 10000) / 10000, brierTotal: Math.round(br * 10) / 10, hitRate: r1((hit / Math.max(1, n)) * 100), predDraw: r1((dr / Math.max(1, n)) * 100), realDraw: r1((realD / Math.max(1, n)) * 100) };
}

function fitLeague(items: TuneItem[]): LeagueConv {
  const usable = items.filter(i => i.mkt);
  let best = LC0, bestB = Infinity;
  for (const draw of TUNE_GRID.draw) for (const home of TUNE_GRID.home) for (const stretch of TUNE_GRID.stretch)
    for (const cube of TUNE_GRID.cube) for (const close of TUNE_GRID.close) {
      const lc = { draw, home, stretch, cube, close };
      let b = 0;
      for (const it of usable) b += brierP(probsOf(it, lc), it.o);
      if (b < bestB - 1e-9) { bestB = b; best = lc; }
    }
  return best;
}

export async function tuneLeaguesV3(train = '2425', test = '2526', extra = '2627', apply = false) {
  const t0 = Date.now();
  try {
    const items = await collectTuneItems([train, test, extra]);
    const divs = [...new Set(items.map(i => i.div))].sort();
    const leagues: any[] = [];
    const keep = new Map<string, { lc: LeagueConv; report: any }>();
    let di = 0;
    for (const div of divs) {
      leagueTuneProgress = { stage: `fitting ${div}`, done: di++, total: divs.length };
      const tr = items.filter(i => i.div === div && i.season === train);
      const te = items.filter(i => i.div === div && i.season === test);
      const ex = items.filter(i => i.div === div && i.season === extra);
      if (tr.filter(i => i.mkt).length < 150 || te.filter(i => i.mkt).length < 150) {
        leagues.push({ division: div, skipped: `too few matches (train ${tr.length}, test ${te.length})` });
        continue;
      }
      const row = withLiveConfig(() => {
        const trainFit = fitLeague(tr);
        const testBase = tuneSummary(te, LC0), testTuned = tuneSummary(te, trainFit), testMarket = tuneSummary(te, 'market');
        const pass = testTuned.brierTotal < testBase.brierTotal;
        const live = pass ? fitLeague([...tr, ...te]) : null;
        const lcNow = live || LC0;
        return {
          division: div,
          trainFit, trainFitMeaning: describeLc(trainFit),
          train: { base: tuneSummary(tr, LC0), tuned: tuneSummary(tr, trainFit), market: tuneSummary(tr, 'market') },
          test: { base: testBase, tuned: testTuned, market: testMarket, gainPoints: Math.round((testBase.brierTotal - testTuned.brierTotal) * 10) / 10 },
          pass,
          live, liveMeaning: live ? describeLc(live) : 'shared model (no league setting)',
          extra: ex.length ? { base: tuneSummary(ex, LC0), tuned: tuneSummary(ex, lcNow), market: tuneSummary(ex, 'market') } : null
        };
      });
      leagues.push(row);
      if (row.pass && row.live) keep.set(div, { lc: row.live, report: { test: row.test, extra: row.extra } });
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }

    // totals: shared model vs "league settings where they passed" vs market
    const tot = (season: 'test' | 'extra', which: 'base' | 'tuned' | 'market') => {
      let n = 0, b = 0;
      for (const l of leagues) { const s = l[season]?.[which]; if (s) { n += s.n; b += s.brierTotal; } }
      return { n, brierTotal: Math.round(b * 10) / 10 };
    };
    // "tuned" for a failed league is its train fit (test) — for the combined total use the setting we would actually run
    const testReal = (() => {
      let n = 0, b = 0;
      for (const l of leagues) if (l.test) { const s = l.pass ? l.test.tuned : l.test.base; n += s.n; b += s.brierTotal; }
      return { n, brierTotal: Math.round(b * 10) / 10 };
    })();
    const summary = {
      test: { season: test, shared: tot('test', 'base'), perLeague: testReal, market: tot('test', 'market') },
      extra: { season: extra, shared: tot('extra', 'base'), perLeague: tot('extra', 'tuned'), market: tot('extra', 'market') },
      passed: leagues.filter(l => l.pass).map(l => l.division),
      failed: leagues.filter(l => l.test && !l.pass).map(l => l.division)
    };

    if (apply) {
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        db.exec(`DELETE FROM v3_league_conv`);
        const ins = db.prepare(`INSERT INTO v3_league_conv (division, conf, report, updated_at) VALUES (?, ?, ?, ?)`);
        keep.forEach((v, d) => ins.run(d, JSON.stringify(v.lc), JSON.stringify(v.report), now));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      loadLeagueConv();
    }
    return { train, test, extra, applied: apply, grid: TUNE_GRID, summary, leagues, ms: Date.now() - t0 };
  } finally {
    leagueTuneProgress = null;
  }
}

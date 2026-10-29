/**
 * Basketball model "bb-v1" (Oct 2026): team ratings from every game, points per game, updated game by game.
 *
 *  - Each team has an attack rating (points scored above the league average) and a defence rating (points allowed
 *    above average). Expected score = league average ± half the home-court edge + own attack + opponent's defence.
 *  - After each game both ratings move toward what happened (learning rate k). Between seasons ratings shrink
 *    toward average (r), because rosters change.
 *  - A team playing on the second night of a back-to-back loses `b2b` points.
 *  - Win % = normal curve of the expected margin over the league's typical miss (sigma), learned as it goes.
 *  - k, r and b2b are chosen per league on one season (tuning season) and then tested on the later seasons,
 *    which the choice never saw (bbBacktest). Only games before kick-off are used for every prediction.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { isMainThread } from 'node:worker_threads';
import { yieldLoop } from './perf';
import { onState, publishState, applyStored } from './shared';
import { threadJobsOn, inThread } from './threadJob';
import { winnerBands, winnerCalibration, winnerByConfidence, winnerBrier } from '../utils/winnerBands';
import { injuryLoss } from './bbInjuries';
import type { RBase } from '../utils/nbaImpact';
import type { GridBase, GridView } from '../utils/bbGridMath';
import { bbCalibrated, bbCalibVer, bbStrongLine } from './sportCalibration';
import { anchorPoints, marketVer } from './marketAnchor';
import { nbaV4Adjust, nbaV4Ver, buildNbaV4, saveShadow, nbaSameDay, type V4Result } from './nbaV4';
import { replayLeague, storeRows, publishSnap, gridSnapVer, boxFitDue, fitBoxFormula, storedBox } from './bbGrid';
import { publishGridState, gridPredict, gridParamsVer, row4Points } from './bbTuner';

export const BB_MODEL = 'bb-v3';
const FINISHED = ['FT', 'AOT'];

type Game = {
  game_id: number; code: string; season: string; kickoff: string; status: string | null;
  home_id: number; away_id: number; hs: number | null; as_: number | null; week: string | null;
  home_name?: string; away_name?: string;
};
type Params = { k: number; r: number; b2b: number };
type Team = { o: number; d: number; season: string; games: number; last: number; sg: number; ha: number };
type Pred = { pHome: number; margin: number; neutral?: number; netH?: number; netA?: number; haH?: number; haA?: number; sig?: number; grid?: GridView; model?: string; pV3?: number; pRaw?: number; total: number; home: number; away: number; hca: number; b2bHome: boolean; b2bAway: boolean; restHome: number | null; restAway: number | null; injHome?: number; injAway?: number; injPlayersHome?: string[]; injPlayersAway?: string[]; newHome?: NewBasis; newAway?: NewBasis; gridOff?: string[];
  /** fix278: the model's own numbers before the season's scoring level and the market anchor (pModel = the calibrated chance), and why the line is what it is */
  line?: { pModel: number; margin: number; total: number; shift: number; anchored: boolean; why: string } };
/** fix192: how a team with no games in the league was rated ('other-league' = its rating there, moved to this league's level) */
export type NewBasis = 'other-league' | 'bottom3';

/**
 * bb-v3 (8 Oct 2026 research, 14,308 test games in 18 leagues; log loss 0.5817 → 0.5765, picks 68.5% → 69.2%):
 *  - v1: faster learning in a team's first 10 games of a season, learned team-specific home edge
 *  - v2 (possessions): faster early learning
 *  - v1 and v2 blended 50/50 (was a weight chosen on one season), then stretched ×1.05 on the probit scale (calibration)
 *  - player talent: the value (game score per minute, all our leagues) of the players a team used in its last game
 *    (NBA: last 5 games, injuries are handled by the injury report), shift = 0.12 × talent gap / 13 on the probit scale
 *  - round 2: player value shrunk toward 0 with 800 minutes (unproven players count little): 0.5765 → 0.5751, 69.2% → 69.3%
 */
export const V3 = { kEarly: 1.5, earlyN: 10, kha: 0.01, rha: 0.7, w2: 0.5, stretch: 1.05, talent: 0.12, decay: 0.995, priorMin: 800, priorRate: 0 };

/** NBA games before 19 October are pre-season (they count less and are left out of the record). fix240: a game the
 *  provider files under a pre-season stage is too (a late US tip-off on the 18th is already the 19th in UTC). */
export const isPreseason = (g: { code: string; kickoff: string; stage?: string | null }) => {
  if (g.stage && /pre[- ]?season/i.test(g.stage)) return true;
  if (g.code !== 'NBA') return false;
  const d = new Date(g.kickoff);
  return d.getUTCMonth() === 9 && d.getUTCDate() < 19;
};

const normCdf = (x: number) => {
  // Abramowitz–Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const p = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const c = 1 - 0.3989422804014327 * Math.exp(-x * x / 2) * p;
  return x >= 0 ? c : 1 - c;
};

/** Inverse of the normal curve (Acklam), to shift a win % by a number of points. */
function normInv(p: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - 0.02425) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5, t = r * r;
  return (((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * r / (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1);
}

/** NBA: take the expected points of injured regulars off each side (ESPN injury list, see bbInjuries). */
function withInjuries(g: Game, pr: Pred, sigma: number): Pred {
  if (g.code !== 'NBA' || !g.home_name || !g.away_name) return pr;
  const h = injuryLoss(g.home_id, g.home_name, g.kickoff), a = injuryLoss(g.away_id, g.away_name, g.kickoff);
  if (!h.points && !a.points) return { ...pr, injHome: 0, injAway: 0 };
  const shift = h.points - a.points; // points the home side loses relative to the away side
  return {
    ...pr,
    margin: pr.margin - shift, home: pr.home - h.points, away: pr.away - a.points, total: pr.total - h.points - a.points,
    pHome: Math.min(0.995, Math.max(0.005, normCdf(normInv(pr.pHome) - shift / sigma))),
    injHome: h.points, injAway: a.points, injPlayersHome: h.players, injPlayersAway: a.players
  };
}

class League {
  teams = new Map<number, Team>();
  mu = 0;       // average points per team per game
  hca = 3;      // home-court edge (points)
  sigma = 12;   // typical miss on the margin
  sigmaT = 17;  // typical miss on the total
  n = 0;
  lastPlayed = new Map<number, number>(); // team → kickoff ms of its previous game (any status, by date)
  /** fix192: where a team new to the league starts (after the league's first 100 games); null = the league average */
  prior: ((id: number, now: number) => { o: number; d: number } | null) | null = null;
  now = 0;
  constructor(public p: Params) {}

  team(id: number, season: string): Team {
    let t = this.teams.get(id);
    if (!t) {
      const pr = this.prior && this.n >= 100 ? this.prior(id, this.now) : null;
      t = { o: pr?.o ?? 0, d: pr?.d ?? 0, season, games: 0, last: 0, sg: 0, ha: 0 };
      this.teams.set(id, t);
    } else if (t.season !== season) {
      t.o *= this.p.r;
      t.d *= this.p.r;
      t.ha *= V3.rha;
      t.sg = 0;
      t.season = season;
    }
    return t;
  }

  predict(g: Game): Pred {
    this.now = Date.parse(g.kickoff);
    const h = this.team(g.home_id, g.season), a = this.team(g.away_id, g.season);
    const ko = new Date(g.kickoff).getTime();
    const restOf = (id: number) => {
      const prev = this.lastPlayed.get(id);
      return prev ? (ko - prev) / 86400000 : null;
    };
    const restHome = restOf(g.home_id), restAway = restOf(g.away_id);
    const b2bHome = restHome !== null && restHome < 1.4, b2bAway = restAway !== null && restAway < 1.4;
    const ha = (h.ha - a.ha) / 2; // bb-v3: how much better this home team is at home than the away team on the road (learned)
    const home = this.mu + this.hca / 2 + ha + h.o + a.d - (b2bHome ? this.p.b2b / 2 : 0) + (b2bAway ? this.p.b2b / 2 : 0);
    const away = this.mu - this.hca / 2 - ha + a.o + h.d - (b2bAway ? this.p.b2b / 2 : 0) + (b2bHome ? this.p.b2b / 2 : 0);
    const margin = home - away;
    return {
      pHome: Math.min(0.995, Math.max(0.005, normCdf(margin / this.sigma))),
      margin, total: home + away, home, away, hca: this.hca, b2bHome, b2bAway,
      neutral: h.o + a.d - a.o - h.d, // fix217: the rating gap alone (no home edge, no back-to-back)
      netH: h.o - h.d, netA: a.o - a.d, haH: h.ha, haA: a.ha, sig: this.sigma, // fix219: the grid rows #3 / #7
      restHome: restHome === null ? null : Math.round(restHome * 10) / 10,
      restAway: restAway === null ? null : Math.round(restAway * 10) / 10
    };
  }

  update(g: Game, pr: Pred) {
    const w = isPreseason(g) ? 0.3 : 1;
    const hs = g.hs!, as = g.as_!;
    const h = this.team(g.home_id, g.season), a = this.team(g.away_id, g.season);
    const eh = hs - pr.home, ea = as - pr.away;
    // bb-v3: learn faster in a team's first games of a season (new rosters)
    const early = h.sg < V3.earlyN || a.sg < V3.earlyN ? V3.kEarly : 1;
    const k = this.p.k * w * (this.n < 100 ? 2 : 1) * early;
    h.o += k * eh; a.d += k * eh;
    a.o += k * ea; h.d += k * ea;
    const resid = hs - as - pr.margin;
    h.ha += V3.kha * w * resid; a.ha -= V3.kha * w * resid;
    h.games++; a.games++; h.sg++; a.sg++;
    // league-wide numbers learn slowly
    const alpha = this.n < 100 ? 0.05 : 0.01;
    if (!this.n) this.mu = (hs + as) / 2;
    else this.mu += alpha * w * ((hs + as) / 2 - this.mu);
    this.hca += alpha * w * 0.5 * (hs - as - pr.margin);
    const em = hs - as - pr.margin, et = hs + as - pr.total;
    this.sigma = Math.sqrt(Math.max(36, this.sigma ** 2 + alpha * w * (em * em - this.sigma ** 2)));
    this.sigmaT = Math.sqrt(Math.max(64, this.sigmaT ** 2 + alpha * w * (et * et - this.sigmaT ** 2)));
    this.n++;
  }

  /** Mark that a team played (finished or not — rest counts from the schedule). */
  played(g: Game) {
    const t = new Date(g.kickoff).getTime();
    this.lastPlayed.set(g.home_id, t);
    this.lastPlayed.set(g.away_id, t);
  }
}

/* ------------------------------------------------------------------ */
/* bb-v2 (Oct 2026): ratings per 100 possessions + pace, from box scores */
/* ------------------------------------------------------------------ */
// Backtest (browser research, 7 Oct 2026, seasons 2024-25 + 2025-26 never seen when the settings were chosen):
//   log loss v1 → v2: NBA 0.607 → 0.603, ACB 0.587 → 0.586, Serie A 0.602 → 0.599, EuroLeague 0.627 → 0.629 (blend wins there)
type P2 = { k: number; kp: number; r: number; rp: number; rh: number; b2b: number; clip: number; early: number; kh: number };
const P2_DEFAULT: P2 = { k: 0.05, kp: 0.05, r: 0.9, rp: 0.7, rh: 0.8, b2b: 1.5, clip: 40, early: 2, kh: 0.01 };
const P2_LEAGUE: Record<string, Partial<P2>> = { NBA: { b2b: 3 } };
type T2 = { o: number; d: number; p: number; h: number; season: string; n: number; tg?: number; at?: number };

class LeagueV2 {
  teams = new Map<number, T2>();
  ppp = 105; pace = 90; hca = 3; sigma = 12; sigmaT = 17; n = 0; first = true;
  /** fix192: same as League.prior, on the possession ratings */
  prior: ((id: number, now: number) => { o: number; d: number } | null) | null = null;
  now = 0;
  constructor(public p: P2) {}
  team(id: number, season: string): T2 {
    let t = this.teams.get(id);
    if (!t) { const pr = this.prior && this.n >= 100 ? this.prior(id, this.now) : null; t = { o: pr?.o ?? 0, d: pr?.d ?? 0, p: 0, h: 0, season, n: 0, tg: 0, at: 0 }; this.teams.set(id, t); }
    else if (t.season !== season) { t.o *= this.p.r; t.d *= this.p.r; t.p *= this.p.rp; t.h *= this.p.rh; t.season = season; t.n = 0; }
    return t;
  }
  predict(g: Game, restH: number | null, restA: number | null) {
    this.now = Date.parse(g.kickoff);
    const H = this.team(g.home_id, g.season), A = this.team(g.away_id, g.season);
    const hca = this.hca + H.h;
    const b2bHome = restH !== null && restH < 1.4, b2bAway = restA !== null && restA < 1.4;
    const fh = b2bHome ? this.p.b2b : 0, fa = b2bAway ? this.p.b2b : 0;
    const pace = Math.max(55, this.pace + H.p + A.p);
    const per = 100 / this.pace;
    const ph = (this.ppp + H.o + A.d + (hca / 2) * per - fh * per) / 100;
    const pa = (this.ppp + A.o + H.d - (hca / 2) * per - fa * per) / 100;
    const home = pace * ph, away = pace * pa, margin = home - away;
    return {
      pHome: Math.min(0.995, Math.max(0.005, normCdf(margin / this.sigma))), margin, total: home + away, home, away, hca, b2bHome, b2bAway,
      neutral: (pace * (H.o + A.d - A.o - H.d)) / 100, // fix217
      sig: this.sigma, // fix219
      restHome: restH === null ? null : Math.round(restH * 10) / 10, restAway: restA === null ? null : Math.round(restA * 10) / 10,
      _ph: ph, _pa: pa, _pace: pace
    };
  }
  update(g: Game, pr: ReturnType<LeagueV2['predict']>, poss: number | null) {
    const w = isPreseason(g) ? 0.3 : 1;
    if (this.first && poss) { this.pace = poss; this.ppp = (100 * (g.hs! + g.as_!)) / 2 / poss; this.first = false; }
    const H = this.team(g.home_id, g.season), A = this.team(g.away_id, g.season);
    const pz = poss || pr._pace;
    const clip = (x: number) => Math.max(-this.p.clip, Math.min(this.p.clip, x));
    const ah = (100 * g.hs!) / pz, aa = (100 * g.as_!) / pz;
    const eH = clip(ah - pr._ph * 100), eA = clip(aa - pr._pa * 100);
    const k = this.p.k * w * (H.n < 10 || A.n < 10 ? this.p.early : 1);
    H.o += k * eH; A.d += k * eH; A.o += k * eA; H.d += k * eA;
    const al = this.n < 150 ? 0.04 : 0.008;
    if (poss) { const ep = poss - pr._pace; H.p += (this.p.kp * w * ep) / 2; A.p += (this.p.kp * w * ep) / 2; this.pace += al * w * ep; }
    const res = g.hs! - g.as_! - pr.margin;
    H.h += this.p.kh * w * res;
    H.n++; A.n++;
    H.tg = (H.tg || 0) + 1; A.tg = (A.tg || 0) + 1; H.at = A.at = this.now;
    this.ppp += al * w * ((ah + aa) / 2 - this.ppp);
    this.hca += al * w * 0.5 * res;
    this.sigma = Math.sqrt(Math.max(36, this.sigma ** 2 + al * w * (res * res - this.sigma ** 2)));
    const et = g.hs! + g.as_! - pr.total;
    this.sigmaT = Math.sqrt(Math.max(64, this.sigmaT ** 2 + al * w * (et * et - this.sigmaT ** 2)));
    this.n++;
  }
}

/**
 * Possessions of each finished game with a box score (both teams' estimate averaged).
 * fix204d: since Jan 2026 the provider's box scores have no offensive / defensive rebound split, and the fixed 27% of
 * missed shots used instead moved the possession scale mid-season (NBA −3%, most European leagues +2–4%): bb-v2's pace
 * and points per possession then predicted totals off by up to 4.4 points (FEC). Now: the split when given (or total −
 * defensive), else the league's own offensive-rebound rate from the box scores that have it; and a game more than 25% from
 * the league's median possessions (doubled, cumulative or partial stats) is not used. Walk-forward (18 leagues, 14,343
 * test games): log loss 0.57402 → 0.57394, mean |total bias| per league 0.72 → 0.44 points.
 */
function possessionsOf(code: string): Map<number, number> {
  const rows = db.prepare(`SELECT t.game_id, t.fgm, t.fga, t.oreb, t.dreb, t.reb, t.tov, t.fta FROM bb_team_stats t JOIN bb_games g ON g.game_id = t.game_id WHERE g.code = ? AND t.fga > 0`).all(code) as any[];
  const by = new Map<number, number[]>();
  // the league's own offensive-rebound rate (offensive rebounds ÷ missed shots) from the box scores that have the split
  let om = 0, mm = 0;
  for (const r of rows) if (r.oreb != null && r.fga - (r.fgm || 0) > 0) { om += r.oreb; mm += r.fga - (r.fgm || 0); }
  const orate = mm > 2000 ? om / mm : 0.27;
  for (const r of rows) {
    const oreb = r.oreb != null ? r.oreb : r.reb != null && r.dreb != null && r.reb >= r.dreb && r.dreb > 0 ? r.reb - r.dreb : orate * (r.fga - (r.fgm || 0));
    const est = r.fga - oreb + (r.tov || 0) + 0.44 * (r.fta || 0);
    if (!by.has(r.game_id)) by.set(r.game_id, []);
    by.get(r.game_id)!.push(est);
  }
  const out = new Map<number, number>();
  for (const [id, v] of by) if (v.length === 2) out.set(id, (v[0] + v[1]) / 2);
  if (out.size >= 50) {
    // a box score far from the league's usual possessions (doubled, cumulative or partial stats) is not used
    const med = [...out.values()].sort((a, b) => a - b)[Math.floor(out.size / 2)];
    for (const [id, v] of out) if (v < 0.75 * med || v > 1.25 * med) out.delete(id);
  }
  return out;
}

function runV2(games: Game[], p: P2, poss: Map<number, number>, onPred?: (g: Game, pr: ReturnType<LeagueV2['predict']>, L: LeagueV2) => void, prior?: (L: LeagueV2) => LeagueV2['prior']) {
  const L = new LeagueV2(p);
  if (prior) L.prior = prior(L);
  const last = new Map<number, number>();
  for (const g of games) {
    if (!done(g)) continue;
    const t = new Date(g.kickoff).getTime();
    const rh = last.has(g.home_id) ? (t - last.get(g.home_id)!) / 86400000 : null;
    const ra = last.has(g.away_id) ? (t - last.get(g.away_id)!) / 86400000 : null;
    const pr = L.predict(g, rh, ra);
    onPred?.(g, pr, L);
    L.update(g, pr, poss.get(g.game_id) ?? null);
    last.set(g.home_id, t); last.set(g.away_id, t);
  }
  return L;
}

function gamesOf(code: string): Game[] {
  return db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week FROM bb_games WHERE code = ? ORDER BY kickoff, game_id`).all(code) as Game[];
}
const done = (g: Game) => FINISHED.includes(g.status || '') && g.hs !== null && g.as_ !== null;

type Metrics = { n: number; hits: number; logLoss: number; brier: number; maeMargin: number; maeTotal: number; homeHits: number };
const emptyM = (): Metrics => ({ n: 0, hits: 0, logLoss: 0, brier: 0, maeMargin: 0, maeTotal: 0, homeHits: 0 });
function addM(m: Metrics, pr: Pred, g: Game) {
  const y = g.hs! > g.as_! ? 1 : 0;
  const p = pr.pHome;
  m.n++;
  m.hits += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
  m.homeHits += y;
  m.logLoss += -(y ? Math.log(p) : Math.log(1 - p));
  m.brier += (p - y) ** 2;
  m.maeMargin += Math.abs(g.hs! - g.as_! - pr.margin);
  m.maeTotal += Math.abs(g.hs! + g.as_! - pr.total);
}
const fin = (m: Metrics) => m.n ? {
  games: m.n, hitRate: Math.round((m.hits / m.n) * 1000) / 10, homeWinRate: Math.round((m.homeHits / m.n) * 1000) / 10,
  logLoss: Math.round((m.logLoss / m.n) * 10000) / 10000, brier: Math.round((m.brier / m.n) * 10000) / 10000,
  maeMargin: Math.round((m.maeMargin / m.n) * 10) / 10, maeTotal: Math.round((m.maeTotal / m.n) * 10) / 10
} : { games: 0 };

/** Run the model through a league's games in order. `onPred` sees every finished game's pre-game prediction. */
function run(games: Game[], p: Params, onPred?: (g: Game, pr: Pred, L: League) => void, prior?: (L: League) => League['prior']) {
  const L = new League(p);
  if (prior) L.prior = prior(L);
  for (const g of games) {
    if (!done(g)) continue;
    const pr = L.predict(g);
    onPred?.(g, pr, L);
    L.update(g, pr);
    L.played(g);
  }
  return L;
}


/* ---------- bb-v3 player talent (all leagues together: players move between our leagues) ---------- */
const talentState = { rates: new Map<number, { m: number; g: number }>(), rosters: new Map<number, Map<number, number>[]>(), byGame: new Map<number, [number | null, number | null]>(), builtAt: 0 };
const gsOf = (r: any) => (r.pts || 0) + 0.4 * (r.fgm || 0) - 0.7 * (r.fga || 0) - 0.4 * ((r.fta || 0) - (r.ftm || 0)) + 0.5 * (r.reb || 0) + 0.7 * (r.ast || 0);
type TalentState = typeof talentState;
function playerRate(pid: number, st: TalentState = talentState) {
  const x = st.rates.get(pid);
  // shrunk toward 0 (8 Oct 2026 round 2): a player we have seen little of counts as little — proven production matters
  return x ? (x.g + V3.priorRate * V3.priorMin) / (x.m + V3.priorMin) : null;
}
/** A team's talent: minutes-weighted value of the players it used in its last `lastN` games (game score per 200 minutes). */
export function teamTalent(teamId: number, lastN = 1, st: TalentState = talentState) {
  const h = st.rosters.get(teamId);
  if (!h || !h.length) return null;
  const use = h.slice(-lastN);
  const mins = new Map<number, number>();
  for (const r of use) for (const [p, mi] of r) mins.set(p, (mins.get(p) || 0) + mi / use.length);
  let s = 0, m = 0;
  for (const [p, mi] of mins) { const v = playerRate(p, st); if (v == null) continue; s += mi * v; m += mi; }
  return m > 60 ? (200 * s) / m : null;
}
/**
 * One pass over every finished game with a box score: pre-game talent of both teams, then the players' values update.
 * fix165: async — player lines read in pages of 20,000, a yield every 1,500 games; the new numbers are built apart and
 * swapped in at the end (predictions use the previous build until then). Same pass, same results.
 */
export async function buildTalent(): Promise<void> {
  const games = db.prepare(`SELECT game_id, home_id, away_id FROM bb_games WHERE status IN ('FT','AOT') AND hs IS NOT NULL ORDER BY kickoff, game_id`).all() as any[];
  await yieldLoop();
  const byGame = new Map<number, any[]>();
  let after = 0;
  for (;;) {
    const lines = db.prepare(`SELECT rowid AS rid, game_id, team_id, player_id, minutes, pts, fgm, fga, ftm, fta, reb, ast FROM bb_player_stats WHERE minutes > 0 AND rowid > ? ORDER BY rowid LIMIT 20000`).all(after) as any[];
    if (!lines.length) break;
    for (const r of lines) { if (!byGame.has(r.game_id)) byGame.set(r.game_id, []); byGame.get(r.game_id)!.push(r); }
    after = lines[lines.length - 1].rid;
    await yieldLoop();
  }
  const st: TalentState = { rates: new Map(), rosters: new Map(), byGame: new Map(), builtAt: 0 };
  let i = 0;
  for (const g of games) {
    st.byGame.set(g.game_id, [teamTalent(g.home_id, 1, st), teamTalent(g.away_id, 1, st)]);
    const ls = byGame.get(g.game_id);
    if (ls) {
      const per = new Map<number, Map<number, number>>();
      for (const r of ls) {
        if (!per.has(r.team_id)) per.set(r.team_id, new Map());
        per.get(r.team_id)!.set(r.player_id, r.minutes);
        const x = st.rates.get(r.player_id) || { m: 0, g: 0 };
        x.m = x.m * V3.decay + r.minutes; x.g = x.g * V3.decay + gsOf(r);
        st.rates.set(r.player_id, x);
      }
      for (const [t, r] of per) { const h = st.rosters.get(t) || []; h.push(r); if (h.length > 5) h.shift(); st.rosters.set(t, h); }
    }
    if (++i % 1500 === 0) await yieldLoop();
  }
  talentState.rates = st.rates; talentState.rosters = st.rosters; talentState.byGame = st.byGame;
  talentState.builtAt = Date.now();
  talentVer++; // fix159: cached predictions use the talent numbers
}
/** Probit shift from the talent gap (positive = favours the home team). */
const talentShift = (th: number | null, ta: number | null) => (th != null && ta != null ? (V3.talent * (th - ta)) / 13 : 0);
/** bb-v3 final probability: stretch (calibration) + talent, on the probit scale. */
const finalP = (p: number, shift: number) => Math.min(0.995, Math.max(0.005, normCdf(V3.stretch * normInv(Math.min(0.995, Math.max(0.005, p))) + shift)));

const GRID: Params[] = [];
for (const k of [0.03, 0.05, 0.07, 0.09, 0.12]) for (const r of [0.5, 0.65, 0.8, 0.9]) for (const b2b of [0, 1.5, 3]) GRID.push({ k, r, b2b });

type LeagueModel = { code: string; params: Params; L: League; L2: LeagueV2 | null; w2: number; tuneSeason: string | null; testSeasons: string[]; test: any; tune: any; compare?: any; builtAt: string; snaps?: Snap[] };
const models = new Map<string, LeagueModel>();
/** fix192 (data health): is the league's model built? */
export const bbModelReady = (code: string) => models.has(code);

// fix135: the k / r / b2b grid (60 fits) is re-tuned at most once a day per league; in between the ratings are refit
// with the saved params. Kept in the database so a deploy doesn't re-tune 18 leagues at once.
db.exec(`CREATE TABLE IF NOT EXISTS bb_model_params (code TEXT PRIMARY KEY, k REAL NOT NULL, r REAL NOT NULL, b2b REAL NOT NULL, tune_season TEXT, tuned_day TEXT NOT NULL)`);
const utcDay = () => new Date().toISOString().slice(0, 10);

/** Choose k, r, b2b on the tuning season; test on the seasons after it; keep the final ratings for predictions. */
export async function buildLeague(code: string, opts: { retune?: boolean } = {}): Promise<LeagueModel | null> {
  const games = gamesOf(code);
  const seasons = [...new Set(games.filter(done).map(g => g.season))].sort();
  if (seasons.length < 2) return null;
  // fix192: teams new to the league start from the newcomer prior (other leagues: their latest built ratings)
  // (league levels kept per 30 days of the replay: the 60 tuning fits would otherwise solve them thousands of times)
  const lvl = new Map<string, ReturnType<typeof leagueLevels>>();
  const cached = (key: string, pools: Map<string, Map<number, Rated>>) => () => { let x = lvl.get(key); if (!x) lvl.set(key, (x = leagueLevels(pools))); return x; };
  const prior1 = (Lx: League) => (id: number, now: number) => {
    if (!NEWCOMER.mode) return null;
    const pools = poolsWith(code, recentRated(Lx.teams, Lx.lastPlayed, now), now, false);
    return newcomerPriorOf(id, code, pools, NEWCOMER.mode !== 3, cached(`1|${Math.floor(now / (30 * 86400000))}`, pools));
  };
  const prior2 = (Lx: LeagueV2) => (id: number, now: number) => {
    if (!NEWCOMER.mode) return null;
    const pools = poolsWith(code, v2Pool(Lx, now), now, true);
    return newcomerPriorOf(id, code, pools, NEWCOMER.mode !== 3, cached(`2|${Math.floor(now / (30 * 86400000))}`, pools));
  };
  // tuning season: the third-last finished season (the first is warm-up); test: every season after it
  const tuneSeason = seasons.length >= 4 ? seasons[seasons.length - 4] : seasons[0];
  const testSeasons = seasons.filter(s => s > tuneSeason);
  const saved = db.prepare(`SELECT k, r, b2b, tune_season, tuned_day FROM bb_model_params WHERE code = ?`).get(code) as any;
  let params: Params;
  if (!opts.retune && saved && saved.tuned_day === utcDay() && saved.tune_season === tuneSeason) {
    params = { k: saved.k, r: saved.r, b2b: saved.b2b };
  } else {
    let best: { p: Params; ll: number } | null = null;
    for (const p of GRID) {
      const m = emptyM();
      run(games, p, (g, pr) => { if (g.season === tuneSeason && !isPreseason(g)) addM(m, pr, g); }, prior1);
      const ll = m.n ? m.logLoss / m.n : Infinity;
      if (!best || ll < best.ll) best = { p, ll };
      await yieldLoop(); // fix165: the daily re-tune (60 fits) gives way to visitors between fits
    }
    params = best!.p;
    db.prepare(`INSERT OR REPLACE INTO bb_model_params (code, k, r, b2b, tune_season, tuned_day) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(code, params.k, params.r, params.b2b, tuneSeason, utcDay());
  }
  // v1 and v2 predictions of every finished game, then the blend weight of v2 chosen on the tuning season
  const p1 = new Map<number, Pred>(), p2 = new Map<number, Pred>();
  // fix126: rating snapshots at the start of each of the last 6 months (team page: league rank over time)
  const cut = [6, 5, 4, 3, 2, 1].map(b => new Date(Date.now() - b * 30 * 86400000).toISOString());
  const snaps: Snap[] = cut.map(date => ({ date: date.slice(0, 10), v1: null, v2: null, pace: 0, ppp: 0 }));
  let c1 = 0, c2 = 0;
  const L = run(games, params, (g, pr, Lx) => {
    p1.set(g.game_id, pr);
    while (c1 < cut.length && g.kickoff >= cut[c1]) {
      snaps[c1].v1 = new Map([...Lx.teams.entries()].filter(([id]) => (Lx.lastPlayed.get(id) || 0) > Date.parse(cut[c1]) - 400 * 86400000).map(([id, t]) => [id, { o: t.o, d: t.d }]));
      c1++;
    }
  }, prior1);
  await yieldLoop();
  const poss = possessionsOf(code);
  const P2v: P2 = { ...P2_DEFAULT, ...(P2_LEAGUE[code] || {}) };
  const L2 = poss.size >= 200 ? runV2(games, P2v, poss, (g, pr, Lx) => {
    p2.set(g.game_id, pr);
    while (c2 < cut.length && g.kickoff >= cut[c2]) {
      snaps[c2].v2 = new Map([...Lx.teams.entries()].map(([id, t]) => [id, { o: t.o, d: t.d, p: t.p }]));
      snaps[c2].pace = Lx.pace; snaps[c2].ppp = Lx.ppp;
      c2++;
    }
  }, prior2) : null;
  await yieldLoop();
  const blend = (a: Pred, b: Pred | undefined, w: number): Pred => !b || !w ? a : {
    ...b, pHome: w * b.pHome + (1 - w) * a.pHome, margin: w * b.margin + (1 - w) * a.margin, total: w * b.total + (1 - w) * a.total,
    home: w * b.home + (1 - w) * a.home, away: w * b.away + (1 - w) * a.away
  };
  const fin2 = done;
  const tuneGames = games.filter(g => fin2(g) && g.season === tuneSeason && !isPreseason(g));
  // bb-v3: fixed 50/50 blend when possession ratings exist (a weight chosen on one season was noisy)
  const w2 = L2 ? V3.w2 : 0;
  void tuneGames;
  const tune = emptyM(), test = emptyM(), t1 = emptyM(), t2 = emptyM();
  const wf: [number, number, number, number][] = [];
  // fix217: NBA — bb-v3's walk-forward pieces the v4 replay starts from (neutral-court rating gap, back-to-backs)
  const base = code === 'NBA' ? new Map<number, RBase>() : null;
  if (base) nbaBase = base;
  // fix219: every league — the pieces the bb-v4 grid rows read (v1 team ratings, home edges, rest, sigma, bb-v3's chance)
  const gb = new Map<number, GridBase>();
  gridBases.set(code, gb);
  const bySeason = new Map<string, Metrics>();
  for (const g of games) {
    if (!fin2(g) || isPreseason(g) || !p1.has(g.game_id)) continue;
    const b = blend(p1.get(g.game_id)!, p2.get(g.game_id), w2);
    const tg = talentState.byGame.get(g.game_id);
    const pr = { ...b, pHome: finalP(b.pHome, tg ? talentShift(tg[0], tg[1]) : 0) };
    wf.push([g.game_id, Math.round(pr.pHome * 10000) / 10000, Math.round(pr.margin * 10) / 10, Math.round(pr.total * 10) / 10]);
    {
      const a = p1.get(g.game_id)!, c = p2.get(g.game_id);
      gb.set(g.game_id, {
        p: pr.pHome, m1: a.margin, netH: a.netH || 0, netA: a.netA || 0, hca: a.hca, haH: a.haH || 0, haA: a.haA || 0,
        b2bH: a.b2bHome, b2bA: a.b2bAway, sig: c && w2 ? w2 * (c.sig || 12) + (1 - w2) * (a.sig || 12) : a.sig || 12
      });
    }
    if (base) {
      const a = p1.get(g.game_id)!, c = p2.get(g.game_id);
      base.set(g.game_id, { nm: c && w2 ? w2 * (c.neutral || 0) + (1 - w2) * (a.neutral || 0) : a.neutral || 0, b2bH: a.b2bHome, b2bA: a.b2bAway, p: pr.pHome });
    }
    if (g.season === tuneSeason) addM(tune, pr, g);
    if (testSeasons.includes(g.season)) {
      addM(test, pr, g);
      addM(t1, p1.get(g.game_id)!, g);
      if (p2.has(g.game_id)) addM(t2, p2.get(g.game_id)!, g);
      if (!bySeason.has(g.season)) bySeason.set(g.season, emptyM());
      addM(bySeason.get(g.season)!, pr, g);
    }
  }
  const model: LeagueModel = {
    code, params, L, L2, w2, tuneSeason, testSeasons, snaps: snaps.filter(x => x.v1),
    tune: fin(tune), test: { all: fin(test), bySeason: Object.fromEntries([...bySeason.entries()].map(([s, m]) => [s, fin(m)])) },
    compare: { v1: fin(t1), v2: fin(t2), v2Weight: w2 },
    builtAt: new Date().toISOString()
  };
  models.set(code, model);
  modelStamp.set(code, (modelStamp.get(code) || 0) + 1); // fix159: cached predictions of this league are out of date
  wfByCode.set(code, wf);
  return model;
}

/** fix217: bb-v3's NBA walk-forward pieces of the last build (the v4 replay's base). */
let nbaBase = new Map<number, RBase>();
export const nbaV3Base = () => nbaBase;
/** fix219: every league's walk-forward pieces of the last build (the bb-v4 grid rows) */
const gridBases = new Map<string, Map<number, GridBase>>();
export const gridBaseOf = (code: string) => gridBases.get(code) || null;

/** Research export (admin): the walk-forward bb-v3 prediction of every finished game (as it was before tip-off). */
const wfByCode = new Map<string, [number, number, number, number][]>();
/** fix210b: every league's walk-forward rows (passed to the more-predictions job thread) */
export const allWalkForward = (): [string, [number, number, number, number][]][] => [...wfByCode.entries()];
/** fix210b (job thread): the rows the worker holds */
export function setWalkForward(rows: [string, [number, number, number, number][]][]) { for (const [c, r] of rows) wfByCode.set(c, r); }
export function bbWalkForward(code: string) {
  return { code, cols: ['id', 'pHome', 'margin', 'total'], rows: wfByCode.get(code) || [] };
}

/** Admin research export: every game of a league in compact rows, with box-score possessions. */
export function bbExport(code: string) {
  const poss = possessionsOf(code);
  const rows = db.prepare(`SELECT game_id, season, kickoff, status, home_id, away_id, hs, as_, stage FROM bb_games WHERE code = ? ORDER BY kickoff, game_id`).all(code) as any[];
  return {
    code,
    cols: ['id', 'season', 'ms', 'status', 'h', 'a', 'hs', 'as', 'stage', 'poss'],
    games: rows.map(r => [r.game_id, r.season, Date.parse(r.kickoff), r.status, r.home_id, r.away_id, r.hs, r.as_, r.stage || null, poss.has(r.game_id) ? Math.round(poss.get(r.game_id)! * 10) / 10 : null])
  };
}

/** Admin research export: player lines (minutes and game score) of a league's games. */
export function bbExportPlayers(code: string) {
  const rows = db.prepare(`SELECT ps.game_id, ps.team_id, ps.player_id, ps.minutes, ps.pts, ps.fgm, ps.fga, ps.tpm, ps.ftm, ps.fta, ps.reb, ps.ast, ps.starter
    FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = ? AND ps.minutes > 0`).all(code) as any[];
  const gs = (r: any) => (r.pts || 0) + 0.4 * (r.fgm || 0) - 0.7 * (r.fga || 0) - 0.4 * ((r.fta || 0) - (r.ftm || 0)) + 0.5 * (r.reb || 0) + 0.7 * (r.ast || 0);
  return { code, cols: ['game', 'team', 'player', 'min', 'gs', 'pts', 'fgm', 'fga', 'tpm', 'ftm', 'fta', 'reb', 'ast', 'starter'], rows: rows.map(r => [r.game_id, r.team_id, r.player_id, Math.round(r.minutes * 10) / 10, Math.round(gs(r) * 10) / 10, r.pts, r.fgm, r.fga, r.tpm, r.ftm, r.fta, r.reb, r.ast, r.starter]) };
}

/**
 * What a league's model was built from (fix135): finished games (count, last tip-off, score sum: result checks can
 * correct a score) and box scores in (possessions, player talent). Unchanged → no rebuild.
 */
const leagueSig = new Map<string, string>();
function signature(code: string): string {
  const r: any = db.prepare(`SELECT COUNT(*) AS n, MAX(kickoff) AS last, SUM(hs + as_) AS pts, SUM(CASE WHEN stats = 1 THEN 1 ELSE 0 END) AS box
    FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND hs IS NOT NULL AND as_ IS NOT NULL`).get(code);
  return [r.n, r.last, r.pts, r.box].join('|');
}
const MODEL_MAX_AGE_MS = 24 * 3600 * 1000; // a day old: rebuild anyway (rating snapshots, the daily re-tune)

/**
 * Build the leagues whose data changed (fix135: async, gives the event loop back between leagues, so visitors never
 * wait for the whole 18-league fit). force = rebuild every league.
 */
let building: Promise<{ built: string[]; skipped: number }> | null = null;
export function buildAll(codes: string[], force = false): Promise<{ built: string[]; skipped: number }> {
  // one build at a time (startup, the 30-min tick): a second caller waits for the running one
  if (!building) building = buildChanged(codes, force).finally(() => { building = null; });
  return building;
}
async function buildChanged(codes: string[], force: boolean): Promise<{ built: string[]; skipped: number }> {
  const todo: { code: string; sig: string }[] = [];
  for (const c of codes) {
    const sig = signature(c);
    const m = models.get(c);
    // (a league with too little data has no model: rebuilt only when its games change, not on every tick)
    if (force || leagueSig.get(c) !== sig || (m && Date.now() - Date.parse(m.builtAt) > MODEL_MAX_AGE_MS)) todo.push({ code: c, sig });
  }
  if (!todo.length) return { built: [], skipped: codes.length };
  // fix210: in a worker thread (every box-score line is read there, and freed when it ends); its states come back
  // through the same appliers the web process uses (models, talent), the walk-forward rows with the result
  const r = threadJobsOn()
    ? await inThread<{ built: string[]; wf: [string, [number, number, number, number][]][] }>('bb model', [todo.map(t => t.code)])
    : await buildLeaguesHere(todo.map(t => t.code));
  for (const [c, rows] of r.wf) wfByCode.set(c, rows);
  for (const { code: c, sig } of todo) leagueSig.set(c, sig);
  return { built: r.built, skipped: codes.length - todo.length };
}
/**
 * The talent pass and these leagues' models, published as they are built (fix210: in the job thread; in-process with
 * THREAD_JOBS=0). In a thread the other leagues' last models are loaded first (newcomer priors read them).
 */
export async function buildLeaguesHere(codes: string[]): Promise<{ built: string[]; wf: [string, [number, number, number, number][]][] }> {
  if (!isMainThread) applyStored('bb:m:');
  try { await buildTalent(); } catch (e: any) { logger.warn(`bb-v3 talent: ${e.message}`); }
  // fix202: the web process gets the player numbers its predictions read (not the per-game history)
  publishState('bb:talent', { rates: talentState.rates, rosters: talentState.rosters, builtAt: talentState.builtAt });
  await yieldLoop();
  const built: string[] = [];
  for (const c of codes) {
    try {
      const m = await buildLeague(c);
      if (m) {
        built.push(c);
        publishLeague(m);
        logger.info(`${BB_MODEL} ${c}: k=${m.params.k} r=${m.params.r} b2b=${m.params.b2b}, test hit ${(m.test.all as any).hitRate}% over ${(m.test.all as any).games} games`);
      }
    } catch (e: any) {
      logger.warn(`${BB_MODEL} ${c}: ${e.message}`);
    }
    await yieldLoop();
  }
  // fix217: NBA v4 (player impact ratings, the gate) from this NBA build's walk-forward pieces
  if (built.includes('NBA')) { try { await buildNbaV4(nbaBase); } catch (e: any) { logger.warn(`bb-v4: ${e.message}`); } }
  // fix219: bb-v4 grid rows of every league built now (stored for the tuner / gate), its teams' live values, then the gate
  let gridDone = 0;
  // fix225: the box-score formula, fitted once per database on 2022-23 … 2024-25 (the replay's player values read it)
  if (built.length && boxFitDue()) { try { await fitBoxFormula(); } catch (e: any) { logger.warn(`bb box-score formula: ${e.message}`); } }
  const formula = storedBox();
  for (const c of built) {
    const gb = gridBases.get(c);
    if (!gb || !gb.size) continue;
    try { const r = await replayLeague(c, gb, formula); storeRows(c, r.items); publishSnap(r.snap); gridDone++; } catch (e: any) { logger.warn(`bb-v4 grid ${c}: ${e.message}`); }
    await yieldLoop();
  }
  if (gridDone) { try { const s = publishGridState(); logger.info(`bb-v4 grid: ${gridDone} league(s), gate ${Object.values(s.gate).map(x => `${x.group} ${x.pass ? 'pass' : 'fail'}`).join(', ')}`); } catch (e: any) { logger.warn(`bb-v4 gate: ${e.message}`); } }
  return { built, wf: codes.filter(c => wfByCode.has(c)).map(c => [c, wfByCode.get(c)!]) };
}

/*
 * fix202: the worker builds the leagues; the web process gets each finished model. League / LeagueV2 are classes with
 * a newcomer function: they go as plain data and come back as instances, the newcomer prior taken from the live models
 * (livePrior: the same rule the build used).
 */
function publishLeague(m: LeagueModel) {
  publishState(`bb:m:${m.code}`, { ...m, L: { ...m.L, prior: null }, L2: m.L2 ? { ...m.L2, prior: null } : null });
}
onState('bb:', (key, v) => {
  if (key.startsWith('bb:m:')) {
    const code = key.slice(5);
    const L = Object.assign(new League(v.L.p), v.L, { prior: (id: number, now: number) => livePrior(code, id, now, false) });
    const L2 = v.L2 ? Object.assign(new LeagueV2(v.L2.p), v.L2, { prior: (id: number, now: number) => livePrior(code, id, now, true) }) : null;
    models.set(code, { ...v, L, L2 });
    modelStamp.set(code, (modelStamp.get(code) || 0) + 1);
  } else if (key === 'bb:talent') {
    talentState.rates = v.rates; talentState.rosters = v.rosters; talentState.builtAt = v.builtAt;
    talentVer++;
  } else if (key === 'bb:injuries') injuryVer++;
});

/** Prediction for an upcoming (or live) game from the latest ratings; rest from the schedule before it. */
/*
 * fix159: predictions are cached per game. A list of 400 games used to recompute every upcoming one on every request
 * (~2 s of blocked event loop per /api/basketball/games while games were live). The cache key holds everything a
 * prediction depends on: the league's model build, kick-off, status, both teams' previous games (rest), the player
 * talent build and (NBA) the injury list version — so a game is recomputed only when one of them changed. The bb tick
 * fills it (recordBbPredictions); requests only read it.
 */
const modelStamp = new Map<string, number>();
let talentVer = 0, injuryVer = 0;
/** The NBA injury list changed (bbInjuries refresh): NBA predictions are recomputed on next use. */
export const bumpBbInjuries = () => { injuryVer++; };
const predCache = new Map<number, { key: string; pred: Pred | null }>();
let prevStmt: { home: any; away: any } | null = null;
/** Kick-off (ms) of a team's previous game on the schedule before this one (it may not be in the finished list yet). */
function prevKickoff(teamId: number, g: Game): number | undefined {
  prevStmt ||= {
    home: db.prepare(`SELECT kickoff FROM bb_games WHERE home_id = ? AND kickoff < ? AND game_id != ? ORDER BY kickoff DESC LIMIT 1`),
    away: db.prepare(`SELECT kickoff FROM bb_games WHERE away_id = ? AND kickoff < ? AND game_id != ? ORDER BY kickoff DESC LIMIT 1`)
  };
  const before = new Date(new Date(g.kickoff).getTime() - 3 * 3600 * 1000).toISOString();
  const h: any = prevStmt.home.get(teamId, before, g.game_id), a: any = prevStmt.away.get(teamId, before, g.game_id);
  const k = h?.kickoff && (!a?.kickoff || h.kickoff > a.kickoff) ? h.kickoff : a?.kickoff;
  return k ? new Date(k).getTime() : undefined;
}

/*
 * fix192: newcomers. A team with no games in a league (Monaco in the EuroCup, a promoted club) started at the league
 * average. Now: its rating in another of our leagues, moved to this league's level (leagueLevels: from every team that
 * plays in two of our leagues, 10+ recent games in each), else still the league average (NEWCOMER: the bottom-3
 * fallback lost out of sample). Same rule for the v1 points and the v2 possession ratings.
 */
type Rated = { o: number; d: number; games: number };
const RECENT = 400 * 86400000;
function recentRated<T extends Rated>(teams: Map<number, T>, last: Map<number, number> | null, now: number, minGames = 10) {
  const out = new Map<number, T>();
  for (const [id, t] of teams) if (t.games >= minGames && (!last || now - (last.get(id) || 0) < RECENT)) out.set(id, t);
  return out;
}
function bottom3<T extends Rated>(pool: Map<number, T>): { o: number; d: number } | null {
  const list = [...pool.values()].sort((x, y) => (x.o - x.d) - (y.o - y.d)).slice(0, 3);
  if (list.length < 3) return null;
  return { o: list.reduce((s, t) => s + t.o, 0) / 3, d: list.reduce((s, t) => s + t.d, 0) / 3 };
}
/**
 * League levels from the teams that play in two of our leagues (EuroLeague + LNB, LNB + EuroCup …): a team's rating
 * in league A plus A's level ≈ its rating in B plus B's level. Least squares, solved by a few hundred sweeps (18
 * leagues), with a light pull to 0 so a league without links stays at 0. Separate levels for attack (o) and defence (d).
 */
function leagueLevels<T extends Rated>(pools: Map<string, Map<number, T>>) {
  const pairs: { a: string; b: string; dO: number; dD: number }[] = [];
  const byTeam = new Map<number, [string, T][]>();
  for (const [code, pool] of pools) for (const [id, t] of pool) { let x = byTeam.get(id); if (!x) byTeam.set(id, (x = [])); x.push([code, t]); }
  for (const list of byTeam.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
    pairs.push({ a: list[i][0], b: list[j][0], dO: list[i][1].o - list[j][1].o, dD: list[i][1].d - list[j][1].d });
  const lo = new Map<string, number>(), ld = new Map<string, number>(), links = new Map<string, number>();
  // each league's links as (other league, sign): a(t) = r_A(t) + level_A is the same in both leagues → level_a − level_b = −d
  const adj = new Map<string, { o: string; dO: number; dD: number }[]>();
  const push = (c: string, x: { o: string; dO: number; dD: number }) => { let l = adj.get(c); if (!l) adj.set(c, (l = [])); l.push(x); links.set(c, (links.get(c) || 0) + 1); };
  for (const p of pairs) { push(p.a, { o: p.b, dO: -p.dO, dD: -p.dD }); push(p.b, { o: p.a, dO: p.dO, dD: p.dD }); }
  for (let it = 0; it < 300; it++) for (const [code, l] of adj) {
    let so = 0, sd = 0;
    for (const x of l) { so += (lo.get(x.o) || 0) + x.dO; sd += (ld.get(x.o) || 0) + x.dD; }
    lo.set(code, so / (l.length + 0.5)); ld.set(code, sd / (l.length + 0.5));
  }
  // leagues connected to each other through shared teams
  const comp = new Map<string, number>();
  let k = 0;
  for (const start of adj.keys()) {
    if (comp.has(start)) continue;
    const stack = [start]; comp.set(start, ++k);
    while (stack.length) { const c = stack.pop()!; for (const x of adj.get(c) || []) if (!comp.has(x.o)) { comp.set(x.o, k); stack.push(x.o); } }
  }
  return { lo, ld, links, comp };
}
/**
 * The newcomer prior for team `id` in league `target`: its rating in the other leagues it plays in, moved by the league
 * levels (both leagues need 3+ links to the rest and the same connected group), weighted by games; else (fallback) the
 * average of the target's bottom 3. `pools`: every league's rated teams at the same moment, target included.
 */
export function newcomerPriorOf<T extends Rated>(id: number, target: string, pools: Map<string, Map<number, T>>, fallback = true, levels?: () => ReturnType<typeof leagueLevels>): { o: number; d: number; basis: NewBasis } | null {
  const homes = [...pools].filter(([c, p]) => c !== target && p.has(id));
  if (homes.length) {
    const L = levels ? levels() : leagueLevels(pools);
    let w = 0, o = 0, d = 0;
    for (const [c, p] of homes) {
      if ((L.links.get(c) || 0) < 3 || (L.links.get(target) || 0) < 3 || L.comp.get(c) !== L.comp.get(target)) continue;
      const me = p.get(id)!, g = Math.min(80, me.games);
      o += g * (me.o + (L.lo.get(c) || 0) - (L.lo.get(target) || 0)); d += g * (me.d + (L.ld.get(c) || 0) - (L.ld.get(target) || 0)); w += g;
    }
    if (w > 0) return { o: o / w, d: d / w, basis: 'other-league' };
  }
  if (!fallback) return null;
  const b = bottom3(pools.get(target) || new Map<number, T>());
  return b ? { ...b, basis: 'bottom3' } : null;
}
/**
 * 0 = off (league average, before fix192), 1 = bottom 3 only, 2 = other league else bottom 3, 3 = other league else
 * league average. Walk-forward test 20 Oct 2026 (bbNewcomerTest, 242 first games / 1,422 first-10 games of teams new
 * to a league, all 18 leagues, 10 Oct database, other leagues moved by the league levels): log loss first game
 * 0.6497 / 0.7585 / 0.6185 / 0.5982, first 10 games 0.6019 / 0.6327 / 0.5830 / 0.5833 → 3. New basketball teams are
 * not weak (bottom 3 is clearly worse): only a rating from another league helps.
 */
export const NEWCOMER = { mode: 3 };
/** v1 teams with 10+ games, the last one in the 400 days before `now`. */
const ratedPool = (m: LeagueModel, now: number): Map<number, Rated> => recentRated(m.L.teams, m.L.lastPlayed, now);
/** v2 teams with 10+ games, the last one in the 400 days before `now`. */
function v2Pool(L2: LeagueV2, now: number): Map<number, Rated> {
  const out = new Map<number, Rated>();
  for (const [id, t] of L2.teams) if ((t.tg || 0) >= 10 && now - (t.at || 0) < RECENT) out.set(id, { o: t.o, d: t.d, games: t.tg || 0 });
  return out;
}
/** Every league's rated teams (the latest built models; mode 1 = the target only), with `own` as the target's. */
function poolsWith(code: string, own: Map<number, Rated>, now: number, v2: boolean): Map<string, Map<number, Rated>> {
  const out = new Map<string, Map<number, Rated>>([[code, own]]);
  if (NEWCOMER.mode >= 2) for (const [c, x] of models) if (c !== code && (!v2 || x.L2)) out.set(c, v2 ? v2Pool(x.L2!, now) : ratedPool(x, now));
  return out;
}
function livePrior(code: string, id: number, now: number, v2: boolean) {
  if (!NEWCOMER.mode) return null;
  const m = models.get(code)!;
  return newcomerPriorOf(id, code, poolsWith(code, v2 ? v2Pool(m.L2!, now) : ratedPool(m, now), now, v2), NEWCOMER.mode !== 3);
}

/**
 * fix278: the shown line = the model + the season's scoring level (early season), blended with the market's latest
 * line by the walk-forward weights (services/marketAnchor.ts; 0 until a fit is kept, no market line = the model). The
 * market itself is never in the prediction.
 */
function withAnchor(g: Game, pr: Pred | null): Pred | null {
  if (!pr) return pr;
  const a = anchorPoints('basketball', g.game_id, g.code, { pHome: pr.pHome, margin: pr.margin, total: pr.total });
  if (!a.shift && !a.anchored) return { ...pr, line: { pModel: pr.pHome, margin: pr.margin, total: pr.total, shift: 0, anchored: false, why: lineWhy(pr, a.shift, false) } };
  return {
    ...pr, pHome: a.pHome, margin: a.margin, total: a.total, home: a.home, away: a.away,
    line: { pModel: pr.pHome, margin: pr.margin, total: pr.total, shift: a.shift, anchored: a.anchored, why: lineWhy(pr, a.shift, a.anchored) }
  };
}
const lineWhy = (pr: Pred, shift: number, anchored: boolean) => JSON.stringify({
  raw: Math.round(pr.total * 10) / 10, shift, anchored,
  notes: [
    pr.b2bHome ? 'home on a back-to-back' : '', pr.b2bAway ? 'away on a back-to-back' : '',
    pr.restHome != null && pr.restAway != null ? `rest ${pr.restHome} / ${pr.restAway} days` : '',
    pr.injPlayersHome?.length ? `home missing ${pr.injPlayersHome.slice(0, 3).join(', ')}` : '', pr.injPlayersAway?.length ? `away missing ${pr.injPlayersAway.slice(0, 3).join(', ')}` : '',
    pr.newHome || pr.newAway ? 'newly promoted / new team' : ''
  ].filter(Boolean)
});

/** predictGame through the cache (same result; recomputed only when an input changed). */
export function predictGameCached(g: Game): Pred | null {
  if (!models.has(g.code)) return null;
  const ph = prevKickoff(g.home_id, g), pa = prevKickoff(g.away_id, g);
  const key = `${modelStamp.get(g.code) || 0}|${talentVer}|${gridSnapVer()}.${gridParamsVer()}.${bbCalibVer()}|${g.code === 'NBA' ? `${injuryVer}.${nbaV4Ver()}` : 0}|${g.kickoff}|${g.status || ''}|${g.home_id}|${g.away_id}|${ph || 0}|${pa || 0}|m${marketVer()}`;
  const c = predCache.get(g.game_id);
  if (c && c.key === key) return c.pred;
  const pred = withAnchor(g, predictGame(g, ph, pa));
  predCache.set(g.game_id, { key, pred });
  if (predCache.size > 20000) predCache.delete(predCache.keys().next().value as number);
  return pred;
}

/** fix217: the last v4 numbers of each NBA game (players removed, same-day move) for the re-pricing log */
const v4Detail = new Map<number, V4Result>();

/** fix222: the shown chance = the league's calibration layer (services/sportCalibration.ts) on the model's own (pRaw) */
export function predictGame(g: Game, phIn?: number, paIn?: number): Pred | null {
  const pr = predictRaw(g, phIn, paIn);
  return pr ? { ...pr, pRaw: pr.pHome, pHome: bbCalibrated(g.code, pr.pHome) } : null;
}
function predictRaw(g: Game, phIn?: number, paIn?: number): Pred | null {
  const m = models.get(g.code);
  if (!m) return null;
  const L = m.L;
  // rest: the team's previous game on the schedule
  const ph = phIn !== undefined ? phIn : prevKickoff(g.home_id, g), pa = paIn !== undefined ? paIn : prevKickoff(g.away_id, g);
  // only these two entries change for the prediction (fix159: no copy of the whole map)
  const oldH = L.lastPlayed.get(g.home_id), oldA = L.lastPlayed.get(g.away_id);
  if (ph) L.lastPlayed.set(g.home_id, ph); else L.lastPlayed.delete(g.home_id);
  if (pa) L.lastPlayed.set(g.away_id, pa); else L.lastPlayed.delete(g.away_id);
  // predicting must not change the stored ratings (a new season shrinks them only for this prediction)
  const keep = [g.home_id, g.away_id].map(id => [id, L.teams.get(id) ? { ...L.teams.get(id)! } : null] as const);
  // fix192: a side with no games in this league plays from the newcomer prior (restored with `keep` below)
  const ko0 = new Date(g.kickoff).getTime();
  const nb: { home?: NewBasis; away?: NewBasis } = {};
  for (const [side, id] of [['home', g.home_id], ['away', g.away_id]] as const) {
    if ((L.teams.get(id)?.games || 0) > 0) continue;
    const pri = livePrior(g.code, id, ko0, false);
    if (pri) { L.teams.set(id, { o: pri.o, d: pri.d, season: g.season, games: 0, last: 0, sg: 0, ha: 0 }); nb[side] = pri.basis; }
  }
  const pr: Pred = { ...L.predict(g), ...(nb.home ? { newHome: nb.home } : {}), ...(nb.away ? { newAway: nb.away } : {}) };
  for (const [id, t] of keep) { if (t) L.teams.set(id, t); else L.teams.delete(id); }
  for (const [id, old] of [[g.home_id, oldH], [g.away_id, oldA]] as [number, number | undefined][]) { if (old !== undefined) L.lastPlayed.set(id, old); else L.lastPlayed.delete(id); }
  // fix217: NBA — v4 prices the injury report (and line-ups) itself, from bb-v3 without its injury points; pV3 = the
  // current model's chance (bb-v3 with its injury points), kept for the side-by-side
  const finish = (x: Pred, sigma: number): Pred => {
    const cur = withInjuries(g, x, sigma);
    // fix219: bb-v4 grid where its league group passed the gate (NBA #4 = the injury report's lost impact)
    const sd = g.code === 'NBA' ? nbaSameDay(g) : null;
    // fix225: + each side's top-3 part (the star factor)
    const gv = gridPredict(g, { p: x.pHome, hca: pr.hca, haH: pr.haH, haA: pr.haA, b2bHome: pr.b2bHome, b2bAway: pr.b2bAway }, sigma, sd ? { home: sd.home.sameDay, away: sd.away.sameDay, homeTop: sd.home.sameDayTop || 0, awayTop: sd.away.sameDayTop || 0 } : undefined);
    // fix238: a row out of its usual range (or a rotation that doesn't fill the game) → bb-v3, listed in data health
    if (gv?.off) return { ...cur, gridOff: gv.off };
    if (gv) {
      const pts =(s: { sameDay: number; sameDayTop?: number }) => Math.round(Math.max(0, -row4Points(g.code, s.sameDay, s.sameDayTop || 0)) * 10) / 10;
      if (sd) {
        v4Detail.set(g.game_id, { model: 'bb-v4', mode: 'grid', pHome: gv.pHome, margin: gv.margin, impact: 0, sameDay: sd.home.sameDay - sd.away.sameDay, home: sd.home, away: sd.away, points: { home: pts(sd.home), away: pts(sd.away) }, row4: Math.round(gv.parts[3] * 100) / 100 });
        if (v4Detail.size > 2000) v4Detail.delete(v4Detail.keys().next().value as number);
      }
      const dm = gv.margin - x.margin;
      const out = (s: NonNullable<typeof sd>['home']) => s.removed.filter(p => p.keep < 1).map(p => p.name);
      return {
        ...x, pHome: gv.pHome, margin: gv.margin, home: x.home + dm / 2, away: x.away - dm / 2, model: 'bb-v4', pV3: cur.pHome, grid: gv.view,
        ...(sd ? { injHome: pts(sd.home), injAway: pts(sd.away), injPlayersHome: out(sd.home), injPlayersAway: out(sd.away) } : {})
      };
    }
    if (g.code !== 'NBA') return cur;
    const v = nbaV4Adjust(g, x.pHome, x.b2bHome, x.b2bAway);
    if (!v) return cur;
    v4Detail.set(g.game_id, v);
    if (v4Detail.size > 2000) v4Detail.delete(v4Detail.keys().next().value as number);
    const dm = v.margin - x.margin;
    const names = (sd: typeof v.home) => sd.removed.filter(p => p.keep < 1).map(p => p.name);
    return {
      ...x, pHome: v.pHome, margin: v.margin, home: x.home + dm / 2, away: x.away - dm / 2, model: v.model, pV3: cur.pHome,
      injHome: v.points.home, injAway: v.points.away, injPlayersHome: names(v.home), injPlayersAway: names(v.away)
    };
  };
  const v3 = (x: Pred, sigma: number): Pred => {
    const th = teamTalent(g.home_id, g.code === 'NBA' ? 5 : 1), ta = teamTalent(g.away_id, g.code === 'NBA' ? 5 : 1);
    const shift = talentShift(th, ta);
    const p = finalP(x.pHome, shift);
    const dm = (shift * sigma) / V3.stretch; // the talent gap in points (the calibration stretch changes confidence, not the spread)
    return { ...x, pHome: p, margin: x.margin + dm, home: x.home + dm / 2, away: x.away - dm / 2 };
  };
  if (!m.L2 || !m.w2) return finish(v3(pr, L.sigma), L.sigma);
  // bb-v2: possession ratings, blended with v1 by the weight chosen on the tuning season
  const ko = new Date(g.kickoff).getTime();
  const keep2 = [g.home_id, g.away_id].map(id => [id, m.L2!.teams.get(id) ? { ...m.L2!.teams.get(id)! } : null] as const);
  for (const id of [g.home_id, g.away_id]) {
    if (m.L2.teams.has(id)) continue; // (n restarts every season; an entry means it has played here)
    const pri = livePrior(g.code, id, ko, true);
    if (pri) m.L2.teams.set(id, { o: pri.o, d: pri.d, p: 0, h: 0, season: g.season, n: 0 });
  }
  const p2 = m.L2.predict(g, ph ? (ko - ph) / 86400000 : null, pa ? (ko - pa) / 86400000 : null);
  for (const [id, t] of keep2) { if (t) m.L2.teams.set(id, t); else m.L2.teams.delete(id); }
  const w = m.w2;
  const sig = w * m.L2.sigma + (1 - w) * L.sigma;
  return finish(v3({
    ...pr, pHome: w * p2.pHome + (1 - w) * pr.pHome, margin: w * p2.margin + (1 - w) * pr.margin, total: w * p2.total + (1 - w) * pr.total,
    home: w * p2.home + (1 - w) * pr.home, away: w * p2.away + (1 - w) * pr.away, hca: w * p2.hca + (1 - w) * pr.hca
  }, sig), sig);
}

/**
 * fix204d: where a league's predicted totals come from right now (admin / More predictions backtest): the upcoming games'
 * predicted total against the league's recent finished games, the v1 league mean, v2's pace × points per possession, and
 * how many recent box scores lack the rebound split or were left out of the pace.
 */
export function leagueTotalsCheck(code: string) {
  const m = models.get(code);
  if (!m) return null;
  const now = Date.now(), iso = (t: number) => new Date(t).toISOString();
  const up = db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week FROM bb_games WHERE code = ? AND status = 'NS' AND kickoff > ? AND kickoff < ? ORDER BY kickoff LIMIT 80`)
    .all(code, iso(now), iso(now + 10 * 86400000)) as Game[];
  let s = 0, n = 0;
  for (const g of up) { const p = predictGameCached(g); if (p) { s += p.total; n++; } }
  const rec = db.prepare(`SELECT COUNT(*) AS n, AVG(hs + as_) AS t FROM bb_games WHERE code = ? AND status IN ('FT','AOT') AND hs IS NOT NULL AND kickoff > ?`).get(code, iso(now - 60 * 86400000)) as any;
  const box = db.prepare(`SELECT COUNT(*) AS n, SUM(t.oreb IS NULL) AS noSplit FROM bb_team_stats t JOIN bb_games g ON g.game_id = t.game_id WHERE g.code = ? AND g.kickoff > ?`).get(code, iso(now - 60 * 86400000)) as any;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    upcoming: n, upcomingTotal: n ? r1(s / n) : null, recentGames: rec?.n || 0, recentTotal: rec?.t ? r1(rec.t) : null,
    v1Mean: r1(2 * m.L.mu), v2Total: m.L2 ? r1((2 * m.L2.pace * m.L2.ppp) / 100) : null, v2Pace: m.L2 ? r1(m.L2.pace) : null,
    boxScores: box?.n || 0, noReboundSplit: box?.noSplit || 0
  };
}

/** The league numbers behind a prediction (for the game page's markets and model table). */
export function leagueModelInfo(code: string) {
  const m = models.get(code);
  if (!m) return null;
  const w = m.L2 && m.w2 ? m.w2 : 0;
  return {
    version: BB_MODEL, v2Weight: w, avgPoints: m.L.mu, homeEdge: m.L.hca,
    sigma: w ? w * m.L2!.sigma + (1 - w) * m.L.sigma : m.L.sigma,
    sigmaTotal: w ? w * m.L2!.sigmaT + (1 - w) * m.L.sigmaT : m.L.sigmaT,
    b2b: m.params.b2b, gamesRated: m.L.n
  };
}
export { normCdf, normInv };

/** Every team's ratings in a league (this season's teams), ranked: attack 1 = scores most, defence 1 = allows least. */
export function leagueRatings(code: string) {
  const m = models.get(code);
  if (!m) return [];
  // every team that played in the last ~13 months (ratings carry over between seasons, so this also works in pre-season)
  const since = Date.now() - 400 * 86400000;
  const list = [...m.L.teams.entries()].filter(([id]) => (m.L.lastPlayed.get(id) || 0) > since)
    .map(([id, t]) => ({ id, attack: t.o, defence: -t.d, net: t.o - t.d }));
  const rank = (key: 'attack' | 'defence' | 'net') => new Map([...list].sort((a, b) => b[key] - a[key]).map((x, i) => [x.id, i + 1]));
  const ra = rank('attack'), rd = rank('defence'), rn = rank('net');
  return list.map(x => ({ ...x, attackRank: ra.get(x.id)!, defenceRank: rd.get(x.id)!, netRank: rn.get(x.id)!, of: list.length }));
}

type Snap = { date: string; v1: Map<number, { o: number; d: number }> | null; v2: Map<number, { o: number; d: number; p: number }> | null; pace: number; ppp: number };

/**
 * fix126 — how bb-v3 rates a team (team page "Team analysis"): strength = the v1 and v2 net ratings blended like the
 * predictions (points better than an average team per game, neutral court), attack / defence per 100 possessions
 * (opponent-adjusted, v2; v1 points a game when a league has no box scores), pace, roster talent; ranks among the
 * teams of the current season and the rank at the start of each of the last 6 months.
 */
export function bbTeamModel(code: string, teamId: number) {
  const m = models.get(code);
  if (!m) return null;
  const season = (db.prepare(`SELECT MAX(season) AS s FROM bb_games WHERE code = ? AND kickoff <= ?`).get(code, new Date().toISOString()) as any)?.s;
  const inSeason = new Set((season ? db.prepare(`SELECT home_id AS id FROM bb_games WHERE code = ? AND season = ? UNION SELECT away_id FROM bb_games WHERE code = ? AND season = ?`).all(code, season, code, season) as any[] : []).map(r => r.id as number));
  const since = Date.now() - 400 * 86400000;
  const ids = [...m.L.teams.keys()].filter(id => (inSeason.size >= 4 ? inSeason.has(id) : (m.L.lastPlayed.get(id) || 0) > since));
  if (!ids.includes(teamId)) return null;
  const L2 = m.L2, w2 = L2 ? m.w2 : 0;
  const net = (v1: { o: number; d: number } | undefined, v2: { o: number; d: number } | undefined, pace: number) =>
    (1 - (v2 ? w2 : 0)) * (v1 ? v1.o - v1.d : 0) + (v2 ? w2 * ((v2.o - v2.d) * pace) / 100 : 0);
  const rows = ids.map(id => {
    const t1 = m.L.teams.get(id)!, t2 = L2?.teams.get(id);
    return {
      id,
      strength: net(t1, t2, L2?.pace || 100),
      attack: L2 && t2 ? L2.ppp + t2.o : m.L.mu + t1.o,
      defence: L2 && t2 ? L2.ppp + t2.d : m.L.mu + t1.d,
      pace: L2 && t2 ? L2.pace + t2.p : null,
      talent: teamTalent(id, code === 'NBA' ? 5 : 1)
    };
  });
  const n = rows.length;
  const rankBy = (key: 'strength' | 'attack' | 'defence' | 'pace' | 'talent', lowerBetter = false) => {
    const have = rows.filter(r => r[key] !== null && r[key] !== undefined);
    const sorted = [...have].sort((a, b) => (lowerBetter ? (a[key] as number) - (b[key] as number) : (b[key] as number) - (a[key] as number)));
    const i = sorted.findIndex(r => r.id === teamId);
    return i < 0 ? null : { rank: i + 1, of: sorted.length };
  };
  const score = (r: { rank: number; of: number } | null) => (r && r.of > 1 ? Math.round((1 + (9 * (r.of - r.rank)) / (r.of - 1)) * 10) / 10 : undefined);
  const me = rows.find(r => r.id === teamId)!;
  const avg = (k: 'attack' | 'pace') => { const v = rows.map(r => r[k]).filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  const strength = rankBy('strength');
  // rank over time: same blend on the stored snapshots (teams active then)
  const trend = (m.snaps || []).map(sn => {
    if (!sn.v1 || !sn.v1.has(teamId)) return null;
    const list = [...sn.v1.entries()].map(([id, v]) => ({ id, s: net(v, sn.v2?.get(id), sn.pace || 100), v2: sn.v2?.get(id) }));
    const mine = list.find(x => x.id === teamId)!;
    return {
      date: sn.date, rank: list.filter(x => x.s > mine.s).length + 1, teams: list.length, elo: Math.round(mine.s * 10) / 10,
      attack: mine.v2 ? Math.round((sn.ppp + mine.v2.o) * 10) / 10 : Math.round(sn.v1.get(teamId)!.o * 10) / 10,
      defence: mine.v2 ? Math.round((sn.ppp + mine.v2.d) * 10) / 10 : Math.round(sn.v1.get(teamId)!.d * 10) / 10
    };
  }).filter(Boolean) as { date: string; rank: number; teams: number; elo: number; attack: number; defence: number }[];
  trend.push({ date: new Date().toISOString().slice(0, 10), rank: strength!.rank, teams: n, elo: r1(me.strength)!, attack: r1(me.attack)!, defence: r1(me.defence)! });
  return {
    teams: n, season: season || null, perPossession: !!L2,
    rank: strength!.rank, rating: r1(me.strength)!,
    attack: r1(me.attack)!, defence: r1(me.defence)!, leagueAttack: r1(avg('attack'))!,
    pace: r1(me.pace), leaguePace: r1(avg('pace')),
    talent: me.talent === null ? null : r1(me.talent),
    ranks: { strength, attack: rankBy('attack'), defence: rankBy('defence', true), pace: rankBy('pace'), talent: rankBy('talent') },
    scores: {
      strength: score(strength), attack: score(rankBy('attack')), defence: score(rankBy('defence', true)),
      pace: score(rankBy('pace')), talent: score(rankBy('talent'))
    },
    trend
  };
}

export function teamRating(code: string, teamId: number) {
  const t = models.get(code)?.L.teams.get(teamId);
  return t ? { attack: Math.round(t.o * 10) / 10, defence: Math.round(-t.d * 10) / 10, net: Math.round((t.o - t.d) * 10) / 10, games: t.games } : null;
}

/**
 * fix217 (data health "NBA vs backtest", every league): the saved predictions of the last 30 days against the league's
 * backtest hit rate; a league with 50+ finished games more than 8 points under its backtest warns.
 */
export function bbLiveVsBacktest(now = Date.now()) {
  const since = new Date(now - 30 * 86400000).toISOString();
  const rows = db.prepare(`SELECT p.code, COUNT(*) AS n, SUM(CASE WHEN (p.p_home >= 0.5) = (g.hs > g.as_) THEN 1 ELSE 0 END) AS hits
    FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
    WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND g.hs != g.as_ AND g.kickoff > ? AND g.kickoff <= ? GROUP BY p.code`).all(since, new Date(now).toISOString()) as any[];
  const out: { code: string; games: number; hitRate: number; backtest: number; gap: number; warn: boolean }[] = [];
  for (const r of rows) {
    const bt = (models.get(r.code)?.test?.all as any)?.hitRate;
    if (typeof bt !== 'number' || r.n < 50) continue;
    const hit = Math.round((1000 * r.hits) / r.n) / 10;
    out.push({ code: r.code, games: r.n, hitRate: hit, backtest: bt, gap: Math.round((hit - bt) * 10) / 10, warn: hit < bt - 8 });
  }
  return out.sort((a, b) => a.gap - b.gap);
}

/** Admin: how each league's model did on seasons it never saw. */
export function bbBacktest() {
  return [...models.values()].map(m => ({
    code: m.code, params: m.params, tuneSeason: m.tuneSeason, testSeasons: m.testSeasons, tune: m.tune, test: m.test, compare: m.compare,
    now: { avgPoints: Math.round(m.L.mu * 10) / 10, homeEdge: Math.round(m.L.hca * 10) / 10, sigma: Math.round(m.L.sigma * 10) / 10, sigmaTotal: Math.round(m.L.sigmaT * 10) / 10 },
    builtAt: m.builtAt
  }));
}

/* ------------------------------------------------------------------ */
/* Saved predictions (the public record)                                */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS bb_predictions (
    game_id INTEGER PRIMARY KEY, code TEXT NOT NULL, kickoff TEXT NOT NULL, model TEXT NOT NULL,
    p_home REAL NOT NULL, margin REAL NOT NULL, total REAL NOT NULL, home_pts REAL NOT NULL, away_pts REAL NOT NULL,
    made_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bb_pred_kickoff ON bb_predictions(kickoff);
`);
// fix222: the model's own chance beside the calibrated one shown (null = saved before the layer)
try { db.exec(`ALTER TABLE bb_predictions ADD COLUMN p_raw REAL`); } catch { /* there already */ }
// fix278: the model's own numbers before the season's scoring level and the market anchor, the shift, why the line is what it is
for (const c of ['p_model REAL', 'margin_raw REAL', 'total_raw REAL', 'level_shift REAL', 'line_why TEXT']) { try { db.exec(`ALTER TABLE bb_predictions ADD COLUMN ${c}`); } catch { /* there already */ } }

/** Save / refresh predictions for games in the next 7 days. A game's prediction is frozen at tip-off. */
// fix210: async — 200 games a turn (predictions first, then one short transaction), a yield between turns
export async function recordBbPredictions(codes?: string[], ids?: number[], out?: Map<number, { v3: number; v4: V4Result | null }>): Promise<number> {
  const now = new Date();
  // optional league filter (fix122): the 15-minute NBA injury refresh only re-saves NBA games
  const only = codes && codes.length ? ` AND code IN (${codes.map(() => '?').join(',')})` : '';
  // fix217: optional game list (the NBA re-pricing before tip-off)
  const onlyIds = ids && ids.length ? ` AND game_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week, home_name, away_name FROM bb_games
    WHERE kickoff > ? AND kickoff < ? AND (status IS NULL OR status = 'NS')${only}${onlyIds}`).all(now.toISOString(), new Date(now.getTime() + 7 * 86400000).toISOString(), ...(codes && codes.length ? codes : []), ...(ids || [])) as Game[];
  const up = db.prepare(`INSERT OR REPLACE INTO bb_predictions (game_id, code, kickoff, model, p_home, margin, total, home_pts, away_pts, made_at, p_raw, p_model, margin_raw, total_raw, level_shift, line_why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200).map(g => ({ g, pr: predictGameCached(g) })).filter(x => x.pr); // fix159: also fills the cache the game lists read
    await yieldLoop();
    db.exec('BEGIN');
    try {
      for (const { g, pr } of part) up.run(g.game_id, g.code, g.kickoff, pr!.model || BB_MODEL, pr!.pHome, pr!.margin, pr!.total, pr!.home, pr!.away, now.toISOString(), pr!.pRaw ?? null,
        pr!.line?.pModel ?? null, pr!.line?.margin ?? null, pr!.line?.total ?? null, pr!.line?.shift ?? 0, pr!.line?.why ?? null);
      // fix217: NBA — v4 and the current model side by side (daily report, admin NBA model check)
      saveShadow(part.filter(x => x.pr!.pV3 !== undefined).map(({ g, pr }) => ({ game_id: g.game_id, kickoff: g.kickoff, mode: pr!.grid ? 'grid' : pr!.model === 'bb-v4' ? 'full' : 'reprice', p_v3: pr!.pV3!, p_v4: pr!.pRaw ?? pr!.pHome })));
      db.exec('COMMIT');
      if (out) for (const { g, pr } of part) out.set(g.game_id, { v3: pr!.pV3 ?? pr!.pHome, v4: v4Detail.get(g.game_id) ?? null });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    n += part.length;
    await yieldLoop();
  }
  return n;
}

/**
 * fix192 research (admin): the newcomer prior, walk-forward over every league at once (v1 ratings, each league's saved
 * k / r / b2b). Scores the first `firstN` games of every team that joined a league after its first 100 games, for
 * mode 0 (league average, before fix192), 1 (bottom 3) and 2 (other league, else bottom 3). Nothing is stored.
 */
export function bbNewcomerTest(firstN = 10) {
  const rows = db.prepare(`SELECT game_id, code, season, kickoff, status, home_id, away_id, hs, as_, stage AS week FROM bb_games ORDER BY kickoff, game_id`).all() as Game[];
  const saved = new Map((db.prepare(`SELECT code, k, r, b2b FROM bb_model_params`).all() as any[]).map(r => [r.code, { k: r.k, r: r.r, b2b: r.b2b } as Params]));
  const out: Record<string, any> = {};
  for (const mode of [0, 1, 2, 3]) {
    const Ls = new Map<string, League>();
    const get = (code: string) => {
      let L = Ls.get(code);
      if (!L) {
        const Lx = (L = new League(saved.get(code) || { k: 0.07, r: 0.8, b2b: 1.5 }));
        if (mode) Lx.prior = (id, now) => newcomerPriorOf(id, code, new Map([...Ls].filter(([c]) => mode >= 2 || c === code).map(([c, o]) => [c, recentRated(o.teams, o.lastPlayed, now)])), mode !== 3);
        Ls.set(code, L);
      }
      return L;
    };
    const seen = new Map<string, number>(), fresh = new Set<string>();
    const all = emptyM(), first = emptyM();
    for (const g of rows) {
      if (!done(g)) continue;
      const L = get(g.code);
      const keys = [`${g.code}|${g.home_id}`, `${g.code}|${g.away_id}`];
      for (const k of keys) if (!seen.has(k)) { seen.set(k, 0); if (L.n >= 100) fresh.add(k); }
      const pr = L.predict(g);
      if (!isPreseason(g) && keys.some(k => fresh.has(k) && seen.get(k)! < firstN)) {
        addM(all, pr, g);
        if (keys.some(k => fresh.has(k) && seen.get(k) === 0)) addM(first, pr, g);
      }
      L.update(g, pr); L.played(g);
      for (const k of keys) seen.set(k, seen.get(k)! + 1);
    }
    out[['league average (before)', 'bottom 3', 'other league, else bottom 3', 'other league, else league average'][mode]] = { firstGame: fin(first), [`first${firstN}`]: fin(all) };
  }
  return out;
}

/** fix174: mean miss of the expected margin and of the total points. */
function scoreOff(rows: { margin: number | null; total: number | null; hs: number; as_: number }[]) {
  const m = rows.filter(r => typeof r.margin === 'number'), t = rows.filter(r => typeof r.total === 'number');
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    marginOff: m.length ? r1(m.reduce((s, r) => s + Math.abs(r.margin! - (r.hs - r.as_)), 0) / m.length) : null,
    totalOff: t.length ? r1(t.reduce((s, r) => s + Math.abs(r.total! - (r.hs + r.as_)), 0) / t.length) : null,
    scoreN: m.length
  };
}

/** The public record: every saved prediction of a finished game in every league (fix203: no "in testing" exclusion; pre-season left out). */
export function bbRecord(days = 3650, code?: string, recentLimit = 50) {
  const rows = db.prepare(`
    SELECT p.*, g.hs, g.as_, g.home_name, g.away_name, g.home_logo, g.away_logo, g.status, g.stage AS g_stage
    FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
    WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND p.made_at <= p.kickoff AND p.kickoff >= ? ${code ? 'AND p.code = ?' : ''}
      AND p.game_id NOT IN (SELECT game_id FROM bb_result_check WHERE resolved_at IS NULL OR voided = 1)
    ORDER BY p.kickoff DESC`).all(...[new Date(Date.now() - days * 86400000).toISOString(), ...(code ? [code] : [])]) as any[];
  const list = rows.filter(r => !isPreseason({ code: r.code, kickoff: r.kickoff, stage: r.g_stage }));
  const by = new Map<string, { n: number; hits: number; strongN: number; strongHits: number }>();
  const tot = { n: 0, hits: 0, strongN: 0, strongHits: 0 };
  for (const r of list) {
    const hit = (r.p_home >= 0.5) === (r.hs > r.as_);
    // fix222: the league's calibrated line for predictions made with the layer (p_raw saved), 70% as shown before it
    const strong = Math.max(r.p_home, 1 - r.p_home) >= (r.p_raw == null ? 0.7 : bbStrongLine(r.code));
    const lg = by.get(r.code) || (by.set(r.code, { n: 0, hits: 0, strongN: 0, strongHits: 0 }), by.get(r.code)!);
    for (const b of [tot, lg]) {
      b.n++; if (hit) b.hits++;
      if (strong) { b.strongN++; if (hit) b.strongHits++; }
    }
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const row = (r: any) => ({
    gameId: r.game_id, code: r.code, kickoff: r.kickoff, home: r.home_name, away: r.away_name, homeLogo: r.home_logo, awayLogo: r.away_logo,
    score: [r.hs, r.as_], pick: r.p_home >= 0.5 ? 'H' : 'A', pHome: r.p_home, hit: (r.p_home >= 0.5) === (r.hs > r.as_)
  });
  // pre-season: shown apart, never counted
  const pre = rows.filter(r => isPreseason({ code: r.code, kickoff: r.kickoff, stage: r.g_stage }));
  const preHits = pre.filter(r => (r.p_home >= 0.5) === (r.hs > r.as_)).length;
  // picks already saved and waiting for the result (live now or tipping off in the next 36 hours) — the pick only
  const pending = (db.prepare(`
    SELECT p.game_id, p.code, p.kickoff, p.p_home, g.home_name, g.away_name, g.home_logo, g.away_logo, g.status, g.hs, g.as_
    FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
    WHERE (g.status IS NULL OR g.status NOT IN ('FT','AOT','CANC','POST','ABD','AWD')) AND p.kickoff BETWEEN ? AND ? ${code ? 'AND p.code = ?' : ''}
    ORDER BY p.kickoff LIMIT 60`).all(...[new Date(Date.now() - 4 * 3600000).toISOString(), new Date(Date.now() + 36 * 3600000).toISOString(), ...(code ? [code] : [])]) as any[])
    .map(r => ({
      gameId: r.game_id, code: r.code, kickoff: r.kickoff, home: r.home_name, away: r.away_name, homeLogo: r.home_logo, awayLogo: r.away_logo,
      status: r.status, live: !!r.status && r.status !== 'NS' && Date.parse(r.kickoff) <= Date.now(), score: r.hs != null ? [r.hs, r.as_] : null,
      pick: r.p_home >= 0.5 ? 'H' : 'A', preseason: isPreseason({ code: r.code, kickoff: r.kickoff })
    }));
  return {
    preseason: { n: pre.length, hits: preHits, hitRate: pct(preHits, pre.length), recent: pre.slice(0, 30).map(row) },
    pending,
    since: list.length ? list[list.length - 1].kickoff : null,
    total: { ...tot, hitRate: pct(tot.hits, tot.n), strongHitRate: pct(tot.strongHits, tot.strongN) },
    // fix141: home "Our record" bars — all picks and 60 / 70 / 80%+ sure
    bands: winnerBands(list.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: (r.p_home >= 0.5) === (r.hs > r.as_) }))),
    // fix152b: the shared Accuracy page (football's layout): calibration and picks by how sure we were
    calibration: winnerCalibration(list.map(r => ({ pHome: r.p_home, homeWon: r.hs > r.as_ }))),
    byConfidence: winnerByConfidence(list.map(r => ({ p: Math.max(r.p_home, 1 - r.p_home), hit: (r.p_home >= 0.5) === (r.hs > r.as_) }))),
    leagues: [...by.entries()].map(([c, b]) => ({ code: c, ...b, hitRate: pct(b.hits, b.n), strongHitRate: pct(b.strongHits, b.strongN), ...scoreOff(list.filter(r => r.code === c)),
      // fix206: the how-it-works pages' accuracy table
      brier: winnerBrier(list.filter(r => r.code === c).map(r => ({ pHome: r.p_home, homeWon: r.hs > r.as_ }))) })),
    // fix174: how far the expected margin and the total were off
    scores: scoreOff(list),
    recent: list.slice(0, recentLimit).map(r => ({
      gameId: r.game_id, code: r.code, kickoff: r.kickoff, home: r.home_name, away: r.away_name, homeLogo: r.home_logo, awayLogo: r.away_logo,
      score: [r.hs, r.as_], pick: r.p_home >= 0.5 ? 'H' : 'A', pHome: r.p_home, hit: (r.p_home >= 0.5) === (r.hs > r.as_)
    }))
  };
}

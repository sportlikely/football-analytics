/**
 * fix204 — "More predictions": the extra outputs of every sport, derived from what each model already gives (no new
 * model). Pure functions, no database (tests import this file directly).
 *
 *  Football   the score grid of the expected goals (independent Poisson, like gridModel's topScores): likely scores,
 *             total goals, each team's goals, clean sheets, win by 2+, half-time and HT/FT (first-half goal rates =
 *             full-time rates × the league's first-half share, second half from the rest).
 *  Basketball / American football   normal curves around the predicted margin and total: the margin's spread is the one
 *             that gives our own win chance (so the bands never contradict the pick), the total's is the league's.
 *             First half: mean × the league's first-half share, spread × √share; level at half / overtime from the
 *             normal's mass around 0, scaled per league to what the stored quarter scores show.
 *  Tennis     the point-by-point chain's own distributions (set scores, first set, games, tie-breaks): tennisModel.ts.
 *
 * Every output is a probability set { labels, p } (p sums to 1). Numeric sets carry `cuts`: value < cuts[0] → label 0,
 * cuts[k-1] ≤ value < cuts[k] → label k, value ≥ the last cut → the last label.
 */

export type MoreSport = 'football' | 'basketball' | 'nfl' | 'tennis';
export interface PSet { labels: string[]; p: number[]; cuts?: number[] }
export interface Extras {
  sport: MoreSport; v: 1;
  sets: Record<string, PSet>;
  /** football: grid6 (6×6 heatmap, %), xg; basketball / NFL: expected score, side of the margin bands; tennis: bo */
  info: Record<string, any>;
}

/* ---------- normal curve ---------- */

/** Φ(x), |error| < 1.5e-7 (Abramowitz–Stegun 7.1.26) */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** Φ⁻¹(p) (Acklam) */
export function normInv(p: number): number {
  const q0 = Math.min(1 - 1e-12, Math.max(1e-12, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (q0 < 0.02425) { const q = Math.sqrt(-2 * Math.log(q0)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (q0 > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - q0)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = q0 - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** probabilities of the bins of N(mu, sd) cut at `cuts` (cut values are already half-integers or edges) */
function binsOf(mu: number, sd: number, cuts: number[]): number[] {
  const cdf = cuts.map(c => normCdf((c - mu) / sd));
  const out: number[] = [];
  for (let k = 0; k <= cuts.length; k++) out.push((k === cuts.length ? 1 : cdf[k]) - (k === 0 ? 0 : cdf[k - 1]));
  return out.map(x => Math.max(0, x));
}
const norm1 = (p: number[]) => { const s = p.reduce((a, b) => a + b, 0) || 1; return p.map(x => x / s); };

/* ---------- football ---------- */

const MAXG = 10;
function poissonVec(l: number): number[] {
  const lam = Math.max(0.01, l), v: number[] = [];
  let x = Math.exp(-lam);
  for (let k = 0; k <= MAXG; k++) { v.push(x); x *= lam / (k + 1); }
  return norm1(v);
}
/** distribution of h − a for two independent Poissons, index d + 2·MAXG */
function diffVec(lh: number, la: number): number[] {
  const ph = poissonVec(lh), pa = poissonVec(la), out = new Array(2 * MAXG + 1).fill(0);
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) out[i - j + MAXG] += ph[i] * pa[j];
  return out;
}
export const DEFAULT_HT_SHARE = 0.45;
export const HTFT = ['H/H', 'H/D', 'H/A', 'D/H', 'D/D', 'D/A', 'A/H', 'A/D', 'A/A'];

/**
 * The model's expected goals are spread too wide for exact counts (backtest 2025–27: games it puts at 4.2 goals
 * averaged 3.4). The full-time extras pull each side's expected goals toward the average by k (fitted on earlier seasons:
 * goals = m + k·(xg − m)); the main pick and its 1X2 are not touched.
 */
export interface GoalShrink { k: number; mh: number; ma: number }
/**
 * fix204b: before the server has its own fit, never "no shrink": k between the local walk-forward fits (2526 0.877,
 * 2627 0.791), averages = typical league goals per side
 */
export const DEFAULT_GOAL_SHRINK: GoalShrink = { k: 0.83, mh: 1.5, ma: 1.2 };
export const shrinkGoals = (xg: number, m: number, k: number) => Math.max(0.05, m + k * (xg - m));
/** least squares through the averages: k = cov(xg, goals) / var(xg), both sides pooled */
export function fitGoalShrink(rows: { xh: number; xa: number; hg: number; ag: number }[]): GoalShrink | null {
  if (rows.length < 500) return null;
  const n = rows.length, mh = rows.reduce((s, r) => s + r.hg, 0) / n, ma = rows.reduce((s, r) => s + r.ag, 0) / n;
  const xmh = rows.reduce((s, r) => s + r.xh, 0) / n, xma = rows.reduce((s, r) => s + r.xa, 0) / n;
  let cov = 0, v = 0;
  for (const r of rows) { cov += (r.xh - xmh) * (r.hg - mh) + (r.xa - xma) * (r.ag - ma); v += (r.xh - xmh) ** 2 + (r.xa - xma) ** 2; }
  return v > 0 ? { k: Math.round(Math.min(1, Math.max(0.3, cov / v)) * 1000) / 1000, mh: Math.round(mh * 1000) / 1000, ma: Math.round(ma * 1000) / 1000 } : null;
}

export function footballExtras(xgHome0: number, xgAway0: number, htShare = DEFAULT_HT_SHARE, shrink: GoalShrink | null = null): Extras {
  const xgHome = shrink ? shrinkGoals(xgHome0, shrink.mh, shrink.k) : xgHome0, xgAway = shrink ? shrinkGoals(xgAway0, shrink.ma, shrink.k) : xgAway0;
  const ph = poissonVec(xgHome), pa = poissonVec(xgAway);
  const score: PSet = { labels: [], p: [] };
  let other = 1;
  for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) { const q = ph[i] * pa[j]; score.labels.push(`${i}-${j}`); score.p.push(q); other -= q; }
  score.labels.push('other'); score.p.push(Math.max(0, other));
  const goals = [0, 0, 0, 0, 0];
  let w2h = 0, w2a = 0;
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const q = ph[i] * pa[j];
    goals[Math.min(4, i + j)] += q;
    if (i - j >= 2) w2h += q;
    if (j - i >= 2) w2a += q;
  }
  const team = (v: number[]) => [v[0], v[1], v[2], 1 - v[0] - v[1] - v[2]];
  // halves: first-half rates = full-time rates × share; the second half the rest (independent of the first)
  const s = Math.min(0.7, Math.max(0.3, htShare));
  // (the halves keep the model's own expected goals: the shrink made half-time worse on the later seasons, log loss 1.0522 vs 1.0516)
  const h1 = poissonVec(xgHome0 * s), a1 = poissonVec(xgAway0 * s);
  const d2 = diffVec(xgHome0 * (1 - s), xgAway0 * (1 - s));
  const ht = [0, 0, 0], htft = new Array(9).fill(0);
  const res = (d: number) => (d > 0 ? 0 : d === 0 ? 1 : 2);
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) {
    const q = h1[i] * a1[j];
    if (q < 1e-12) continue;
    const r1 = res(i - j);
    ht[r1] += q;
    for (let k = 0; k < d2.length; k++) { const d = i - j + k - MAXG; htft[r1 * 3 + res(d)] += q * d2[k]; }
  }
  const grid6 = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => Math.round(ph[i] * pa[j] * 1000) / 10));
  return {
    sport: 'football', v: 1,
    sets: {
      score,
      goals: { labels: ['0', '1', '2', '3', '4+'], p: norm1(goals), cuts: [1, 2, 3, 4] },
      homeGoals: { labels: ['0', '1', '2', '3+'], p: team(ph), cuts: [1, 2, 3] },
      awayGoals: { labels: ['0', '1', '2', '3+'], p: team(pa), cuts: [1, 2, 3] },
      cleanHome: { labels: ['yes', 'no'], p: [pa[0], 1 - pa[0]] },
      cleanAway: { labels: ['yes', 'no'], p: [ph[0], 1 - ph[0]] },
      win2Home: { labels: ['yes', 'no'], p: [w2h, 1 - w2h] },
      win2Away: { labels: ['yes', 'no'], p: [w2a, 1 - w2a] },
      ht: { labels: ['H', 'D', 'A'], p: norm1(ht) },
      htft: { labels: HTFT, p: norm1(htft) }
    },
    info: { xg: [round2(xgHome0), round2(xgAway0)], grid6, htShare: round3(s), ...(shrink ? { shrink: shrink.k } : {}) }
  };
}

/* ---------- basketball / American football ---------- */

/** per league, fitted on stored final and quarter scores (services/morePredictions.ts fitLeague) */
export interface LeagueFit {
  /** first-half points ÷ regulation points */
  share: number;
  /** level at half: what happened ÷ what the normal curve of the half-time margins says */
  kHalf: number;
  /** overtime: what happened ÷ what the normal curve of the regulation margins says */
  kOt: number;
  /** a typical game's total (the band centre) */
  meanTotal: number;
  /** league spreads: margin and total (used when the game has none of its own) */
  sigma: number; sigmaT: number;
  games: number;
}
export const SPORT_BANDS = {
  basketball: { margin: [1, 6, 11, 16], marginLabels: ['loser', '1–5', '6–10', '11–15', '16+'], totalWidth: (sT: number) => (sT >= 15 ? 10 : 8), teamWidth: 8 },
  nfl: { margin: [1, 4, 8, 15], marginLabels: ['loser', '1–3', '4–7', '8–14', '15+'], totalWidth: () => 7, teamWidth: 7 }
} as const;

export interface NormalIn {
  sport: 'basketball' | 'nfl';
  /** home win chance (0–1), predicted margin (home − away), total, each side's points */
  pHome: number; margin: number; total: number; homePts: number; awayPts: number;
  fit: LeagueFit;
}

/** the margin's spread that turns the predicted margin into our own win chance (league spread when they disagree) */
export function marginSpread(pHome: number, margin: number, sigma: number): { mu: number; sd: number } {
  const z = normInv(Math.min(0.995, Math.max(0.005, pHome)));
  if (Math.abs(z) < 0.03) return { mu: 0, sd: sigma };
  if (z * margin > 0 && Math.abs(margin) >= 0.3) return { mu: margin, sd: Math.min(1.6 * sigma, Math.max(0.6 * sigma, margin / z)) };
  return { mu: z * sigma, sd: sigma }; // the margin points the other way: the win chance decides
}
/** P(level) from the normal curve, scaled by the league factor; the two sides keep their share of the rest */
function threeWay(mu: number, sd: number, k: number): [number, number, number] {
  const pH0 = 1 - normCdf((0.5 - mu) / sd), pA0 = normCdf((-0.5 - mu) / sd), pT0 = Math.max(0, 1 - pH0 - pA0);
  const pT = Math.min(0.5, Math.max(0, k * pT0)), rest = (1 - pT) / Math.max(1e-9, pH0 + pA0);
  return [pH0 * rest, pT, pA0 * rest];
}
const intCuts = (edges: number[]) => edges.map(e => e - 0.5);

export function normalExtras(x: NormalIn): Extras {
  const B = SPORT_BANDS[x.sport], f = x.fit;
  const { mu, sd } = marginSpread(x.pHome, x.margin, f.sigma);
  const side = x.pHome >= 0.5 ? 1 : -1;
  // winner-side margin bands: value = side × (home − away); 'loser' = the other side wins (or a tie)
  const marginP = binsOf(side * mu, sd, B.margin.map(c => c - 0.5).map((c, k) => (k === 0 ? 0 : c)));
  const w = B.totalWidth(f.sigmaT), c = Math.round(f.meanTotal);
  const e1 = Math.round(c - 1.5 * w), tEdges = [e1, e1 + w, e1 + 2 * w, e1 + 3 * w];
  const totalLabels = [`<${tEdges[0]}`, `${tEdges[0]}–${tEdges[1] - 1}`, `${tEdges[1]}–${tEdges[2] - 1}`, `${tEdges[2]}–${tEdges[3] - 1}`, `${tEdges[3]}+`];
  const wt = B.teamWidth, a1 = Math.round(f.meanTotal / 2 - wt), aEdges = [a1, a1 + wt, a1 + 2 * wt];
  const teamLabels = [`<${aEdges[0]}`, `${aEdges[0]}–${aEdges[1] - 1}`, `${aEdges[1]}–${aEdges[2] - 1}`, `${aEdges[2]}+`];
  const sdTeam = Math.sqrt(f.sigmaT ** 2 + sd ** 2) / 2;
  const s = Math.min(0.65, Math.max(0.35, f.share));
  const half = threeWay(s * mu, sd * Math.sqrt(s), f.kHalf);
  const pT0 = normCdf((0.5 - mu) / sd) - normCdf((-0.5 - mu) / sd);
  const ot = Math.min(0.35, Math.max(0, f.kOt * pT0));
  return {
    sport: x.sport, v: 1,
    sets: {
      margin: { labels: [...B.marginLabels], p: norm1(marginP), cuts: [...B.margin] },
      total: { labels: totalLabels, p: norm1(binsOf(x.total, f.sigmaT, intCuts(tEdges))), cuts: tEdges },
      homePts: { labels: teamLabels, p: norm1(binsOf(x.homePts, sdTeam, intCuts(aEdges))), cuts: aEdges },
      awayPts: { labels: teamLabels, p: norm1(binsOf(x.awayPts, sdTeam, intCuts(aEdges))), cuts: aEdges },
      half: { labels: ['H', 'D', 'A'], p: norm1(half) },
      ot: { labels: ['yes', 'no'], p: [ot, 1 - ot] }
    },
    info: { expected: [Math.round(x.homePts), Math.round(x.awayPts)], side: side > 0 ? 'H' : 'A', sd: round2(sd), share: round3(s) }
  };
}

/**
 * fix204b sanity check: the total and team-point bands sit around the league's typical score, so a regular game never
 * puts more than 85% in one band. When one does, the bands are centred on the wrong league (e.g. European ranges for an
 * NBA game): returns what is wrong, else null.
 */
export const BAND_MAX = 0.85;
export function bandAlarm(x: Extras): string | null {
  if (x.sport !== 'basketball' && x.sport !== 'nfl') return null;
  for (const k of ['total', 'homePts', 'awayPts']) {
    const s = x.sets[k];
    if (!s) continue;
    const i = s.p.indexOf(Math.max(...s.p));
    if (s.p[i] > BAND_MAX) return `${k} ${s.labels[i]} ${Math.round(s.p[i] * 1000) / 10}%`;
  }
  return null;
}

/* ---------- tennis (the chain's distributions come from tennisModel.tennisExtrasDist) ---------- */

export const TENNIS_GAME_CUTS: Record<number, number[]> = { 3: [20, 23, 26], 5: [33, 37, 41] };
export function tennisExtras(d: { sets: Record<string, number>; first: number; games: ArrayLike<number>; noTb: number }, bo: number): Extras {
  const need = bo === 5 ? 3 : 2;
  const order: string[] = [];
  for (let l = 0; l < need; l++) order.push(`${need}-${l}`);
  for (let l = need - 1; l >= 0; l--) order.push(`${l}-${need}`);
  const cuts = TENNIS_GAME_CUTS[bo === 5 ? 5 : 3];
  const gp = new Array(cuts.length + 1).fill(0);
  for (let x = 0; x < d.games.length; x++) { const v = d.games[x]; if (!v) continue; let k = 0; while (k < cuts.length && x >= cuts[k]) k++; gp[k] += v; }
  const tb = Math.min(1, Math.max(0, 1 - d.noTb));
  return {
    sport: 'tennis', v: 1,
    sets: {
      sets: { labels: order, p: norm1(order.map(k => d.sets[k] || 0)) },
      first: { labels: ['1', '2'], p: [d.first, 1 - d.first] },
      games: { labels: [`<${cuts[0]}`, ...cuts.slice(0, -1).map((c, k) => `${c}–${cuts[k + 1] - 1}`), `${cuts[cuts.length - 1]}+`], p: norm1(gp), cuts: [...cuts] },
      tb: { labels: ['yes', 'no'], p: [tb, 1 - tb] }
    },
    info: { bo: bo === 5 ? 5 : 3 }
  };
}

/* ---------- checking a set against what happened ---------- */

/** the label index of what happened: a label for categorical sets, a number for sets with cuts */
export function actualIndex(set: PSet, actual: string | number | null | undefined): number | null {
  if (actual === null || actual === undefined) return null;
  if (set.cuts) {
    const v = Number(actual);
    if (!Number.isFinite(v)) return null;
    let k = 0;
    while (k < set.cuts.length && v >= set.cuts[k]) k++;
    return k;
  }
  const i = set.labels.indexOf(String(actual));
  if (i >= 0) return i;
  const o = set.labels.indexOf('other');
  return o >= 0 ? o : null;
}
export interface SetCheck { i: number; hit: boolean; brier: number; logLoss: number; top: number }
export function checkSet(set: PSet, actual: string | number | null | undefined): SetCheck | null {
  const i = actualIndex(set, actual);
  if (i === null) return null;
  const top = topIndex(set);
  const brier = set.p.reduce((s, q, k) => s + (q - (k === i ? 1 : 0)) ** 2, 0);
  return { i, hit: top === i, brier: round4(brier), logLoss: round4(-Math.log(Math.max(1e-4, set.p[i]))), top };
}
/**
 * our pick in a set: the most likely label. Never 'other' (the likely scores' catch-all) or 'loser' (margin bands: the
 * pick is by how much our winner wins, so it never contradicts the main pick)
 */
export function topIndex(set: PSet): number {
  let best = -1;
  set.p.forEach((q, k) => { if (set.labels[k] !== 'other' && set.labels[k] !== 'loser' && (best < 0 || q > set.p[best])) best = k; });
  return best < 0 ? 0 : best;
}

/** said vs happened in 10% steps; every label's probability counts as one forecast of that label */
export interface CalBin { from: number; n: number; said: number; happened: number }
export function calibration(pairs: { p: number[]; i: number }[]): CalBin[] {
  const acc = Array.from({ length: 10 }, (_, k) => ({ from: k * 10, n: 0, sp: 0, hp: 0 }));
  for (const x of pairs) x.p.forEach((q, k) => { const b = acc[Math.min(9, Math.floor(q * 10))]; b.n++; b.sp += q; b.hp += k === x.i ? 1 : 0; });
  return acc.filter(b => b.n).map(b => ({ from: b.from, n: b.n, said: Math.round((1000 * b.sp) / b.n) / 10, happened: Math.round((1000 * b.hp) / b.n) / 10 }));
}
/** the public rule (fix204 F): every step with 100+ forecasts within 3 points; at least one such step */
export function calibrationOk(bins: CalBin[], minN = 100, maxGap = 3): { ok: boolean; worst: number | null } {
  const big = bins.filter(b => b.n >= minN);
  if (!big.length) return { ok: false, worst: null };
  const worst = Math.max(...big.map(b => Math.abs(b.said - b.happened)));
  return { ok: worst <= maxGap, worst: Math.round(worst * 10) / 10 };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** a set in whole tenths of a percent for the pages (the stored copy keeps full precision) */
export const pctSet = (s: PSet) => ({ labels: s.labels, p: s.p.map(q => Math.round(q * 1000) / 10), ...(s.cuts ? { cuts: s.cuts } : {}) });

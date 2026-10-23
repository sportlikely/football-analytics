/**
 * fix204c — "More predictions": fixes at the source and the final calibration layer. Pure functions, no database
 * (tests import this file directly; services/morePredictions.ts fits them walk-forward and stores them).
 *
 *  Points (basketball, NFL / college)  per-league bias of the predicted total and of each team's points
 *            (predicted − actual, removed; the margin and the win chance are not touched) and the measured spread
 *            (actual misses' RMS ÷ the spread the bands used).
 *  Football  goal counts from a Dixon–Coles-corrected grid (low-score τ, ρ fitted per league), with the goal shrink,
 *            and negative-binomial goal counts (a gamma mix of Poisson rates per team, size fitted per league) when the
 *            dispersion is over 1.1.
 *  Tennis    per tour / format / surface bias of the total games (the chain's games distribution shifted).
 *  Calibration  per output: Platt for two outcomes, isotonic (per label when there is enough data, else pooled) for
 *            more; each set renormalised to 100%.
 */
import { tau } from '../services/dixonColes';
import { normInv, type PSet } from './moreMath';

/* ------------------------------------------------------------------ */
/* Calibration maps                                                    */
/* ------------------------------------------------------------------ */

export type CalibMap = { kind: 'iso'; x: number[]; y: number[] } | { kind: 'platt'; a: number; b: number } | { kind: 'id' };
/** one output: one map for every label (pooled) or one per label; `fixed` labels keep their chance (margin: 'loser') */
export interface OutputCalib { pooled?: CalibMap; perLabel?: Record<string, CalibMap>; fixed?: string[]; n: number }

const clamp01 = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clamp01(p) / (1 - clamp01(p)));

/** pool adjacent violators: (x, y, w) sorted by x → non-decreasing fit; knots at each block's mean x */
export function fitIsotonic(pairs: { x: number; y: number; w?: number }[], maxKnots = 200): CalibMap {
  if (pairs.length < 2) return { kind: 'id' };
  const s = [...pairs].sort((a, b) => a.x - b.x);
  const bx: number[] = [], by: number[] = [], bw: number[] = [];
  for (const p of s) {
    const w = p.w ?? 1;
    bx.push(p.x * w); by.push(p.y * w); bw.push(w);
    // merge while the last block's mean is below the one before it
    while (by.length > 1 && by[by.length - 2] / bw[bw.length - 2] >= by[by.length - 1] / bw[bw.length - 1]) {
      const y1 = by.pop()!, w1 = bw.pop()!, x1 = bx.pop()!;
      by[by.length - 1] += y1; bw[bw.length - 1] += w1; bx[bx.length - 1] += x1;
    }
  }
  let x = bx.map((v, i) => v / bw[i]), y = by.map((v, i) => v / bw[i]);
  if (x.length > maxKnots) {
    const step = x.length / maxKnots, keep: number[] = [];
    for (let k = 0; k < maxKnots; k++) keep.push(Math.floor(k * step));
    keep.push(x.length - 1);
    const u = [...new Set(keep)];
    x = u.map(i => x[i]); y = u.map(i => y[i]);
  }
  return { kind: 'iso', x: x.map(r6), y: y.map(r6) };
}
/** logistic regression on logit(p) (Newton, a few steps) */
export function fitPlatt(pairs: { x: number; y: number }[]): CalibMap {
  if (pairs.length < 50) return { kind: 'id' };
  let a = 1, b = 0;
  for (let it = 0; it < 30; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const p of pairs) {
      const z = logit(p.x), q = 1 / (1 + Math.exp(-(a * z + b))), r = q - p.y, h = q * (1 - q);
      ga += r * z; gb += r; haa += h * z * z; hab += h * z; hbb += h;
    }
    const det = haa * hbb - hab * hab;
    if (Math.abs(det) < 1e-12) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a -= da; b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  // a map that turns the order round is never right for a probability
  if (!(a > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return { kind: 'id' };
  return { kind: 'platt', a: r6(a), b: r6(b) };
}
export function applyMap(m: CalibMap | undefined, p: number): number {
  if (!m || m.kind === 'id') return p;
  if (m.kind === 'platt') return 1 / (1 + Math.exp(-(m.a * logit(p) + m.b)));
  const { x, y } = m;
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= p) lo = mid; else hi = mid; }
  const f = (p - x[lo]) / Math.max(1e-12, x[hi] - x[lo]);
  return y[lo] + f * (y[hi] - y[lo]);
}

const MIN_CAL = 300;
/**
 * fit one output's calibration from (set, index of what happened) pairs. Two outcomes: Platt on the first label. More:
 * one isotonic map per label when there are 1,000+ forecasts and ≤ 10 labels, else one pooled map.
 */
export function fitOutputCalib(items: { p: number[]; i: number; labels: string[] }[], fixed: string[] = []): OutputCalib {
  const n = items.length;
  if (n < MIN_CAL) return { n };
  const labels = items[0].labels;
  if (labels.length === 2 && !fixed.length) return { n, pooled: fitPlatt(items.map(e => ({ x: e.p[0], y: e.i === 0 ? 1 : 0 }))) };
  const free = labels.map((l, k) => k).filter(k => !fixed.includes(labels[k]));
  // the free labels are calibrated within what the fixed ones leave
  const share = (e: { p: number[] }) => free.reduce((s, k) => s + e.p[k], 0) || 1;
  if (n >= 1000 && labels.length <= 10) {
    const perLabel: Record<string, CalibMap> = {};
    for (const k of free) perLabel[labels[k]] = fitIsotonic(items.map(e => ({ x: e.p[k] / share(e), y: e.i === k ? 1 : 0 })));
    return { n, perLabel, ...(fixed.length ? { fixed } : {}) };
  }
  const pairs: { x: number; y: number }[] = [];
  for (const e of items) { const s = share(e); for (const k of free) pairs.push({ x: e.p[k] / s, y: e.i === k ? 1 : 0 }); }
  return { n, pooled: fitIsotonic(pairs), ...(fixed.length ? { fixed } : {}) };
}
/** a set through its output's calibration, renormalised to 100% (fixed labels keep their chance) */
export function calibrateSet(set: PSet, c: OutputCalib | null | undefined): PSet {
  if (!c || (!c.pooled && !c.perLabel)) return set;
  const fixed = new Set(c.fixed || []);
  if (set.labels.length === 2 && c.pooled && !fixed.size) {
    const q = clamp01(applyMap(c.pooled, set.p[0]));
    return { ...set, p: [q, 1 - q] };
  }
  const free = set.labels.map((l, k) => k).filter(k => !fixed.has(set.labels[k]));
  const freeMass = free.reduce((s, k) => s + set.p[k], 0);
  if (freeMass <= 0) return set;
  const raw = set.p.map((q, k) => (fixed.has(set.labels[k]) ? q : Math.max(1e-5, applyMap(c.perLabel?.[set.labels[k]] ?? c.pooled, q / freeMass))));
  const s = free.reduce((a, k) => a + raw[k], 0) || 1;
  return { ...set, p: set.p.map((q, k) => (fixed.has(set.labels[k]) ? q : (raw[k] / s) * freeMass)) };
}
/** is a map non-decreasing (tests) */
export function monotone(m: CalibMap): boolean {
  if (m.kind === 'id') return true;
  if (m.kind === 'platt') return m.a > 0;
  for (let k = 1; k < m.y.length; k++) if (m.y[k] < m.y[k - 1] - 1e-12 || m.x[k] < m.x[k - 1]) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Points: bias and spread per league                                   */
/* ------------------------------------------------------------------ */

export interface PointsRow { league?: string; total: number; home: number; away: number; hs: number; as: number; sdT: number; sdTeam: number }
/**
 * per league (or sport-wide, each league centred on its own means): bias b (predicted − actual), the slope k of the
 * actual on the predicted around the league's mean prediction m (k < 1: the model's totals are too far from the
 * league's usual ones), and spread ratios r (RMS of the corrected misses ÷ RMS of the spread the bands used).
 * Corrected: actual ≈ (m − b) + k·(predicted − m). T = total, H / A = each side.
 */
export interface PointsFit {
  n: number; bT: number; bH: number; bA: number; rT: number; rH: number; rA: number;
  mT?: number; mH?: number; mA?: number; kT?: number; kH?: number; kA?: number;
  /** the shape of the corrected misses ÷ the spread used (SHAPE_K quantiles): the total, each side (home and away pooled) */
  qT?: number[]; qTeam?: number[];
}
export const SHAPE_K = 39;
/** K quantiles at (k + ½) / K of a sample */
export function quantiles(xs: number[], K = SHAPE_K): number[] {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return Array.from({ length: K }, (_, k) => { const pos = ((k + 0.5) / K) * n - 0.5, lo = Math.max(0, Math.floor(pos)), hi = Math.min(n - 1, lo + 1), f = Math.min(1, Math.max(0, pos - lo)); return Math.round((s[lo] * (1 - f) + s[hi] * f) * 1000) / 1000; });
}
export function fitPoints(rows: PointsRow[]): PointsFit | null {
  const n = rows.length;
  if (n < 30) return null;
  const mean = (f: (r: PointsRow) => number) => rows.reduce((s, r) => s + f(r), 0) / n;
  // league means of the predictions and the results (one league: the plain means)
  const lm = new Map<string, { n: number; t: number; h: number; a: number; at: number; ah: number; aa: number }>();
  for (const r of rows) { const k = r.league || '', x = lm.get(k) || { n: 0, t: 0, h: 0, a: 0, at: 0, ah: 0, aa: 0 }; x.n++; x.t += r.total; x.h += r.home; x.a += r.away; x.at += r.hs + r.as; x.ah += r.hs; x.aa += r.as; lm.set(k, x); }
  const L = (r: PointsRow) => lm.get(r.league || '')!;
  const slope = (px: (r: PointsRow) => number, mx: (l: ReturnType<typeof L>) => number, py: (r: PointsRow) => number, my: (l: ReturnType<typeof L>) => number) => {
    let c = 0, v = 0;
    for (const r of rows) { const l = L(r), dx = px(r) - mx(l) / l.n, dy = py(r) - my(l) / l.n; c += dx * dy; v += dx * dx; }
    return v > 0 ? Math.min(1.3, Math.max(0.3, c / v)) : 1;
  };
  const kT = slope(r => r.total, l => l.t, r => r.hs + r.as, l => l.at), kH = slope(r => r.home, l => l.h, r => r.hs, l => l.ah), kA = slope(r => r.away, l => l.a, r => r.as, l => l.aa);
  const bT = mean(r => r.total - r.hs - r.as), bH = mean(r => r.home - r.hs), bA = mean(r => r.away - r.as);
  // the corrected prediction of each row (around its own league's means)
  const cT = (r: PointsRow) => { const l = L(r); return l.at / l.n + kT * (r.total - l.t / l.n); };
  const cH = (r: PointsRow) => { const l = L(r); return l.ah / l.n + kH * (r.home - l.h / l.n); };
  const cA = (r: PointsRow) => { const l = L(r); return l.aa / l.n + kA * (r.away - l.a / l.n); };
  const rms = (f: (r: PointsRow) => number) => Math.sqrt(mean(r => f(r) ** 2));
  const ratio = (miss: number, used: number) => (used > 0 ? Math.min(2.5, Math.max(0.4, miss / used)) : 1);
  const rT = ratio(rms(r => cT(r) - r.hs - r.as), rms(r => r.sdT)), rH = ratio(rms(r => cH(r) - r.hs), rms(r => r.sdTeam)), rA = ratio(rms(r => cA(r) - r.as), rms(r => r.sdTeam));
  const shape = n >= 1000 ? {
    qT: quantiles(rows.map(r => (r.hs + r.as - cT(r)) / (r.sdT * rT))),
    qTeam: quantiles([...rows.map(r => (r.hs - cH(r)) / (r.sdTeam * rH)), ...rows.map(r => (r.as - cA(r)) / (r.sdTeam * rA))])
  } : {};
  return {
    n, bT: r2(bT), bH: r2(bH), bA: r2(bA), rT: r3(rT), rH: r3(rH), rA: r3(rA), ...shape,
    mT: r2(mean(r => r.total)), mH: r2(mean(r => r.home)), mA: r2(mean(r => r.away)), kT: r3(kT), kH: r3(kH), kA: r3(kA)
  };
}
/** a prediction corrected by a fit: around the centre m (the league's mean prediction) with bias b and slope k */
export const correctPts = (pred: number, m: number, b: number, k = 1) => m - b + k * (pred - m);
/** a league with < 300 games uses the sport-wide fit */
export const MIN_LEAGUE_GAMES = 300;

/* ------------------------------------------------------------------ */
/* Football: Dixon–Coles grid, negative-binomial counts                 */
/* ------------------------------------------------------------------ */

export const MAXG = 10;
function poissonVec(l: number): number[] {
  const lam = Math.max(0.01, l), v: number[] = [];
  let x = Math.exp(-lam);
  for (let k = 0; k <= MAXG; k++) { v.push(x); x *= lam / (k + 1); }
  const s = v.reduce((a, b) => a + b, 0);
  return v.map(q => q / s);
}
/**
 * the equal-probability points of a mean-1 gamma(size) rate multiplier (Wilson–Hilferty quantiles, rescaled to mean 1):
 * a Poisson mixed over them is a negative binomial of that size
 */
export function gammaPoints(size: number, n = 5): number[] {
  const c = 1 / (9 * size), g: number[] = [];
  for (let k = 0; k < n; k++) { const z = normInv((k + 0.5) / n); g.push(Math.max(0.02, (1 - c + z * Math.sqrt(c)) ** 3)); }
  const m = g.reduce((a, b) => a + b, 0) / n;
  return g.map(x => x / m);
}
/** goal count vector: Poisson(mean), or the negative binomial of `size` (null = Poisson) */
export function countVec(mean: number, size: number | null): number[] {
  if (!size) return poissonVec(mean);
  const pts = gammaPoints(size), out = new Array(MAXG + 1).fill(0);
  for (const g of pts) poissonVec(mean * g).forEach((q, k) => { out[k] += q / pts.length; });
  return out;
}
/** the full-time score grid: each side's count (Poisson or negative binomial), Dixon–Coles τ on the low scores, sums to 1 */
export function dcGrid(lh: number, la: number, rho: number, sizeH: number | null = null, sizeA: number | null = null): number[][] {
  const ph = countVec(lh, sizeH), pa = countVec(la, sizeA);
  const g = ph.map((x, i) => pa.map((y, j) => Math.max(0, x * y * (rho ? tau(i, j, lh, la, rho) : 1))));
  const s = g.reduce((a, row) => a + row.reduce((b, c) => b + c, 0), 0) || 1;
  return g.map(row => row.map(c => c / s));
}
/** ρ by 1-D search on the Dixon–Coles likelihood of the scores given each game's expected goals (−0.25 … 0.1) */
export function fitRho(rows: { mh: number; ma: number; hg: number; ag: number }[]): number | null {
  if (rows.length < 300) return null;
  const low = rows.filter(r => r.hg <= 1 && r.ag <= 1);
  let best = 0, bestLl = -Infinity;
  for (let rho = -0.25; rho <= 0.1001; rho += 0.005) {
    // with Poisson counts τ keeps the grid's total at 1, so only the low scores' τ moves the likelihood
    let ll = 0;
    for (const r of low) ll += Math.log(Math.max(1e-9, tau(r.hg, r.ag, r.mh, r.ma, rho)));
    if (ll > bestLl) { bestLl = ll; best = rho; }
  }
  return Math.round(best * 1000) / 1000;
}
/** dispersion = Σ(goals − m)² ÷ Σ m (1 = Poisson); method-of-moments negative-binomial size when it is over 1.1 */
export function fitDispersion(rows: { m: number; y: number }[]): { n: number; dispersion: number; size: number | null } {
  const n = rows.length;
  if (!n) return { n, dispersion: 1, size: null };
  const sm = rows.reduce((s, r) => s + r.m, 0), sm2 = rows.reduce((s, r) => s + r.m * r.m, 0), ss = rows.reduce((s, r) => s + (r.y - r.m) ** 2, 0);
  const dispersion = sm > 0 ? ss / sm : 1;
  const extra = ss - sm;
  const size = dispersion > 1.1 && extra > 0 ? Math.max(1, Math.min(200, sm2 / extra)) : null;
  return { n, dispersion: r3(dispersion), size: size === null ? null : r2(size) };
}

/* ------------------------------------------------------------------ */
/* Tennis: total games shifted by the group's bias                      */
/* ------------------------------------------------------------------ */

/** a games distribution moved by −bias games (fractional: split between the two neighbouring counts) */
export function shiftGames(games: ArrayLike<number>, bias: number): number[] {
  const n = games.length, out = new Array(n).fill(0);
  const s = -bias, lo = Math.floor(s), f = s - lo;
  for (let x = 0; x < n; x++) {
    const v = games[x];
    if (!v) continue;
    const a = Math.min(n - 1, Math.max(0, x + lo)), b = Math.min(n - 1, Math.max(0, x + lo + 1));
    out[a] += v * (1 - f); out[b] += v * f;
  }
  return out;
}
export const meanOf = (games: ArrayLike<number>) => { let m = 0, s = 0; for (let x = 0; x < games.length; x++) { m += x * games[x]; s += games[x]; } return s ? m / s : 0; };

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

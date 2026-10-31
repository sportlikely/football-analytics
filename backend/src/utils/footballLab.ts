/**
 * fix291: the football model lab (Yarin, 31 Oct 2026: the double-chance pick is right 79.1% of the time — target
 * 82–83%). Pure maths, no database: services/footballLab.ts loads the games and runs it nightly; the same functions
 * apply a promoted candidate live (services/footballLabLive.ts).
 *
 * Every candidate is a layer on the champion (the 1X2 the site shows: v3-mix when it is live, else grid-v3). For each
 * test window it is fitted only on games played before the window starts (walk-forward by season), then scored on the
 * window: log loss / Brier on 1X2 and on the double-chance pick, hit rates at every band, against the closing market.
 *
 *  1. anchor  — market anchor now: p = (1 − a)·ours + a·market, a per league group (big 5 / rest; the pooled weight for a
 *               group with < 150 priced games), fitted on every earlier game with a closing line (≥ 80 needed, not 300).
 *  2. goals   — goals model refresh: expected goals per side from goals, xG and shots on target form (EWMA, crossed
 *               attack × defence; shots on target turned into goals at the league's rate), Poisson + Dixon–Coles, blended
 *               with the champion (weights, home factor, rho and blend fitted on the earlier games).
 *  3. lineup  — line-up re-rating: the confirmed XI's value / rating and the missing players' weight move the home / away
 *               split, one weight set per league group (today v3 uses one weight for every league).
 *  4. draw    — a separate draw model: logit P(draw) moved by the league's draw rate, both teams' draw habits (last 20),
 *               expected goals, how close the game is and the champion's own draw; home and away keep their ratio.
 *  5. gbm     — a learned combiner: gradient-boosted trees (softmax, depth 3, started from the champion's own log-odds) over
 *               the champion, every v3 row, the lab features and the market line; kept only if it beats the champion by
 *               ≥ 0.003 log loss out of sample in both windows.
 *  6. pickRule — per-league threshold for showing the double-chance pick (report only: fewer, surer picks in weak
 *               leagues; changing what is shown is Yarin's decision).
 *
 * Promotion (fix251's rule, utils/dailyRules.ts): ≥ 300 games in both judging windows (last full season and this season),
 * better in both, gain ≥ 0.0005 per game this season, better in ≥ 90% of 2,000 paired bootstrap resamples, 1X2 hit rate
 * not down > 0.5 pp; the public record's last 60 days must not be worse (when it has ≥ 300 games). The passing candidate
 * with the biggest pooled gain wins.
 */
import { DAILY_RULES, pairedBootstrap, mulberry32, type Boot } from './dailyRules';

export type P3 = [number, number, number];
export type LabGroup = 'big' | 'rest';
export type CandId = 'anchor' | 'goals' | 'lineup' | 'draw' | 'gbm';
export const CANDS: CandId[] = ['anchor', 'goals', 'lineup', 'draw', 'gbm'];
export const CAND_LABEL: Record<CandId | 'pickRule' | 'champion', string> = {
  champion: 'Today (champion)',
  anchor: '1. Market anchor now',
  goals: '2. Goals model refresh (xG / shots on target)',
  lineup: '3. Line-up re-rating per league group',
  draw: '4. Separate draw model',
  gbm: '5. Learned combiner (boosted trees)',
  pickRule: '6. Per-league pick rule'
};

export const LAB_RULES = {
  minTrain: 1500,        // a window needs this many earlier games to fit on
  minWindow: 300,        // fix251's minimum per judging window
  minAnchorGames: 80,    // "don't wait for 300"
  groupAnchorGames: 150, // a group's own anchor weight from this many priced games
  anchorWeights: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6],
  gbmMinGain: 0.003,     // Yarin: the combiner must beat the champion by ≥ 0.003
  recordGames: 300,      // the record guard counts from this many games
  pickTarget: 0.82, pickMinTrain: 30, pickThresholds: [0, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9],
  bands: [0, 0.6, 0.7, 0.8, 0.85, 0.9] as number[],
  gbm: { rounds: 100, lr: 0.04, depth: 3, bins: 24, minHess: 60, lambda: 2 },
  logit: { iters: 250, lr: 0.3, l2: 0.02 }
};

/**
 * Lab features per game (walk-forward, before kick-off), index-aligned with LAB_F. NaN = unknown.
 * gH/gA: goals form (EWMA, my attack × their defence); xH/xA: the same with xG; sH/sA: shots on target × the league's
 * goals per shot on target; drawH/drawA: the team's draw rate over its last 20 (shrunk to the league's); lgDraw: the
 * league's draw rate; xiVal: log value ratio of the confirmed XIs (0 when unknown) and xiKnown; xiRating: previous-season
 * rating difference of the XIs; injW: missing players' weight difference (home − away); elo: Elo difference / 100.
 */
export const LAB_F = ['gH', 'gA', 'xH', 'xA', 'sH', 'sA', 'drawH', 'drawA', 'lgDraw', 'xiVal', 'xiKnown', 'xiRating', 'injW', 'elo'] as const;
export const NLF = LAB_F.length;
export const F = Object.fromEntries(LAB_F.map((k, i) => [k, i])) as Record<(typeof LAB_F)[number], number>;

export interface LabGame {
  id: string; t: number; season: string; src: 'season' | 'record';
  div: string; league: string; group: LabGroup; home: string; away: string;
  y: number;              // 0 home, 1 draw, 2 away
  p: P3;                  // the champion (what the site shows)
  mkt: P3 | null;         // margin-free market (closing when stored)
  f: Float64Array | null; // LAB_F
  rows: Float64Array | null; // v3 rows (team rows home − away, then draw rows), when replayed / on the prediction
}

/* ---------- small maths ---------- */

export const norm = (p: ArrayLike<number>): P3 => { const s = p[0] + p[1] + p[2] || 1; return [p[0] / s, p[1] / s, p[2] / s]; };
const clampP = (x: number) => Math.min(1 - 1e-6, Math.max(1e-6, x));
export const ll = (p: P3, y: number) => -Math.log(clampP(norm(p)[y]));
export const brier = (p: P3, y: number) => { const q = norm(p); return (q[0] - (y === 0 ? 1 : 0)) ** 2 + (q[1] - (y === 1 ? 1 : 0)) ** 2 + (q[2] - (y === 2 ? 1 : 0)) ** 2; };
export const argmax = (p: P3) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1);
/** the double chance (fix120: the two most likely results; ties 1X, X2, 12) — the outcome it leaves out */
export function dcOf(p: P3): { out: number; p: number } {
  const q = norm(p);
  const c = [{ out: 2, p: q[0] + q[1] }, { out: 0, p: q[1] + q[2] }, { out: 1, p: q[0] + q[2] }];
  let b = c[0];
  for (const x of c) if (x.p > b.p + 1e-12) b = x;
  return b;
}
export const dcHit = (p: P3, y: number) => dcOf(p).out !== y;
const softmax = (z: ArrayLike<number>): P3 => { const m = Math.max(z[0], z[1], z[2]); const e = [Math.exp(z[0] - m), Math.exp(z[1] - m), Math.exp(z[2] - m)]; return norm(e); };
const logs = (p: P3): P3 => { const q = norm(p); return [Math.log(clampP(q[0])), Math.log(clampP(q[1])), Math.log(clampP(q[2]))]; };
export function* noSteps<T>(v: T): Generator<void, T> { return v; }
export function run<T>(g: Generator<void, T>): T { for (;;) { const r = g.next(); if (r.done) return r.value; } }
export async function runAsync<T>(g: Generator<void, T>, pause: () => Promise<void>): Promise<T> { for (;;) { const r = g.next(); if (r.done) return r.value; await pause(); } }

/* ---------- Poisson (candidate 2) ---------- */

/** 1X2 from expected goals (Poisson, Dixon–Coles low-score correction rho, goals 0–10) */
export function poisson1x2(lh: number, la: number, rho = 0): P3 {
  lh = Math.min(6, Math.max(0.05, lh)); la = Math.min(6, Math.max(0.05, la));
  const N = 11, ph = new Array(N), pa = new Array(N);
  ph[0] = Math.exp(-lh); pa[0] = Math.exp(-la);
  for (let k = 1; k < N; k++) { ph[k] = (ph[k - 1] * lh) / k; pa[k] = (pa[k - 1] * la) / k; }
  let H = 0, D = 0, A = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let v = ph[i] * pa[j];
    if (rho) {
      if (i === 0 && j === 0) v *= 1 - lh * la * rho; else if (i === 0 && j === 1) v *= 1 + lh * rho;
      else if (i === 1 && j === 0) v *= 1 + la * rho; else if (i === 1 && j === 1) v *= 1 - rho;
    }
    if (i > j) H += v; else if (i === j) D += v; else A += v;
  }
  return norm([H, D, A]);
}
export interface GoalsParams { wx: number; ws: number; hf: number; rho: number; beta: number }
const fin = (x: number) => Number.isFinite(x);
/** expected goals for both sides from the lab features (null when the goals form is unknown) */
export function lambdas(f: Float64Array | null, wx: number, ws: number, hf: number): [number, number] | null {
  if (!f || !fin(f[F.gH]) || !fin(f[F.gA])) return null;
  const side = (g: number, x: number, s: number) => {
    let a = 1 - (fin(x) ? wx : 0) - (fin(s) ? ws : 0), v = 0;
    if (fin(x)) v += wx * x;
    if (fin(s)) v += ws * s;
    if (a < 0) a = 0;
    return v + a * g;
  };
  return [side(f[F.gH], f[F.xH], f[F.sH]) * hf, side(f[F.gA], f[F.xA], f[F.sA]) / hf];
}
export function applyGoals(p: P3, f: Float64Array | null, P: GoalsParams): P3 {
  const l = lambdas(f, P.wx, P.ws, P.hf);
  if (!l || !P.beta) return norm(p);
  const q = poisson1x2(l[0], l[1], P.rho), b = norm(p);
  return norm([0, 1, 2].map(i => (1 - P.beta) * b[i] + P.beta * q[i]));
}
export function* fitGoals(train: LabGame[]): Generator<void, GoalsParams | null> {
  const rows = train.filter(g => lambdas(g.f, 0, 0, 1));
  if (rows.length < LAB_RULES.minTrain / 2) return null;
  let best: { P: GoalsParams; s: number } | null = null;
  const base = rows.reduce((s, g) => s + ll(g.p, g.y), 0);
  for (const wx of [0, 0.25, 0.5, 0.75, 1]) for (const ws of [0, 0.25, 0.5]) {
    if (wx + ws > 1 + 1e-9) continue;
    for (const hf of [1.0, 1.08, 1.16, 1.24]) for (const rho of [0, -0.08]) {
      const q = rows.map(g => { const l = lambdas(g.f, wx, ws, hf)!; return poisson1x2(l[0], l[1], rho); });
      for (const beta of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5]) {
        let s = 0;
        for (let i = 0; i < rows.length; i++) { const b = norm(rows[i].p); s += ll(norm([0, 1, 2].map(k => (1 - beta) * b[k] + beta * q[i][k])), rows[i].y); }
        if (!best || s < best.s) best = { P: { wx, ws, hf, rho, beta }, s };
      }
      yield;
    }
  }
  return best && best.s < base ? best.P : { wx: 0, ws: 0, hf: 1, rho: 0, beta: 0 };
}

/* ---------- market anchor (candidate 1) ---------- */

export interface AnchorParams { all: number; big: number | null; rest: number | null; n: number }
export const anchorP = (p: P3, mkt: P3 | null, a: number): P3 => (mkt && a > 0 ? norm([0, 1, 2].map(i => (1 - a) * norm(p)[i] + a * norm(mkt)[i])) : norm(p));
export function applyAnchor(p: P3, mkt: P3 | null, group: LabGroup, P: AnchorParams): P3 {
  const a = P[group] ?? P.all;
  return anchorP(p, mkt, a);
}
function bestWeight(rows: LabGame[]): number {
  let best = 0, bs = Infinity;
  for (const a of LAB_RULES.anchorWeights) { let s = 0; for (const g of rows) s += ll(anchorP(g.p, g.mkt, a), g.y); if (s < bs - 1e-12) { bs = s; best = a; } }
  return best;
}
export function* fitAnchor(train: LabGame[]): Generator<void, AnchorParams | null> {
  const priced = train.filter(g => g.mkt);
  if (priced.length < LAB_RULES.minAnchorGames) return null;
  const all = bestWeight(priced);
  yield;
  const grp = (k: LabGroup) => { const r = priced.filter(g => g.group === k); return r.length >= LAB_RULES.groupAnchorGames ? bestWeight(r) : null; };
  const big = grp('big'); yield;
  const rest = grp('rest');
  return { all, big, rest, n: priced.length };
}

/* ---------- logit shift layers (candidates 3 and 4) ---------- */

/** z = log p + [v·b, v·c, −v·b]: `b` moves home against away, `c` the draw (home and away keep their ratio) */
export interface ShiftParams { kind: 'lineup' | 'draw'; mean: number[]; sd: number[]; b: number[]; c: number[] }
type VecFn = (g: { p: P3; f: Float64Array | null; group: LabGroup }) => number[] | null;
/** line-up inputs per league group: [xi value × known, XI rating, missing weight] for the game's group, 0 for the other */
export const lineupVec: VecFn = g => {
  const f = g.f;
  if (!f) return null;
  const v = [fin(f[F.xiVal]) && f[F.xiKnown] > 0 ? f[F.xiVal] : 0, fin(f[F.xiRating]) ? f[F.xiRating] : 0, fin(f[F.injW]) ? f[F.injW] : 0];
  if (v.every(x => x === 0)) return null;
  return g.group === 'big' ? [...v, 0, 0, 0] : [0, 0, 0, ...v];
};
/** draw inputs: [1, league draw rate, both teams' draw habit, expected goals total, closeness |H − A|, the champion's draw] */
export const drawVec: VecFn = g => {
  const f = g.f, q = norm(g.p);
  const lg = f && fin(f[F.lgDraw]) ? f[F.lgDraw] : 0.26;
  const habit = f && fin(f[F.drawH]) && fin(f[F.drawA]) ? (f[F.drawH] + f[F.drawA]) / 2 : lg;
  const l = lambdas(f, 0.5, 0, 1);
  const tot = l ? l[0] + l[1] : 2.6;
  return [1, lg, habit, tot, Math.abs(q[0] - q[2]), q[1]];
};
const vecOf = (kind: ShiftParams['kind']) => (kind === 'lineup' ? lineupVec : drawVec);
export function applyShift(p: P3, g: { f: Float64Array | null; group: LabGroup }, P: ShiftParams): P3 {
  const v = vecOf(P.kind)({ p, f: g.f, group: g.group });
  if (!v) return norm(p);
  const z = logs(p);
  let sb = 0, sc = 0;
  for (let j = 0; j < v.length; j++) { const x = P.sd[j] ? (v[j] - P.mean[j]) / P.sd[j] : v[j]; sb += P.b[j] * x; sc += P.c[j] * x; }
  return softmax([z[0] + sb, z[1] + sc, z[2] - sb]);
}
export function* fitShift(train: LabGame[], kind: ShiftParams['kind']): Generator<void, ShiftParams | null> {
  const fn = vecOf(kind);
  const rows: { z: P3; v: number[]; y: number }[] = [];
  for (const g of train) { const v = fn(g); if (v) rows.push({ z: logs(g.p), v, y: g.y }); }
  if (rows.length < LAB_RULES.minTrain / 2) return null;
  const k = rows[0].v.length, n = rows.length;
  const mean = new Array(k).fill(0), sd = new Array(k).fill(0);
  for (const r of rows) for (let j = 0; j < k; j++) mean[j] += r.v[j] / n;
  for (const r of rows) for (let j = 0; j < k; j++) sd[j] += (r.v[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < k; j++) { sd[j] = Math.sqrt(sd[j]); if (sd[j] < 1e-9) { sd[j] = 0; mean[j] = 0; } }
  // the constant column stays a constant (the draw model's intercept)
  const X = rows.map(r => r.v.map((x, j) => (sd[j] ? (x - mean[j]) / sd[j] : x)));
  const b = new Array(k).fill(0), c = new Array(k).fill(0), vb = new Array(k).fill(0), vc = new Array(k).fill(0);
  const { iters, lr, l2 } = LAB_RULES.logit;
  for (let it = 0; it < iters; it++) {
    const gb = new Array(k).fill(0), gc = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      const x = X[i], z = rows[i].z;
      let sb = 0, sc = 0;
      for (let j = 0; j < k; j++) { sb += b[j] * x[j]; sc += c[j] * x[j]; }
      const q = softmax([z[0] + sb, z[1] + sc, z[2] - sb]);
      const y = rows[i].y;
      const eH = q[0] - (y === 0 ? 1 : 0), eD = q[1] - (y === 1 ? 1 : 0), eA = q[2] - (y === 2 ? 1 : 0);
      for (let j = 0; j < k; j++) { gb[j] += (eH - eA) * x[j]; gc[j] += eD * x[j]; }
    }
    for (let j = 0; j < k; j++) {
      if (kind === 'lineup') { vb[j] = 0.9 * vb[j] - lr * (gb[j] / n + l2 * b[j]); b[j] += vb[j]; }
      else { vc[j] = 0.9 * vc[j] - lr * (gc[j] / n + l2 * c[j]); c[j] += vc[j]; }
    }
    if (it % 10 === 9) yield;
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { kind, mean: mean.map(r6), sd: sd.map(r6), b: b.map(r6), c: c.map(r6) };
}

/* ---------- boosted trees (candidate 5): no library, started from the champion's log-odds ---------- */

export interface Trees { names: string[]; lr: number; depth: number; t: { f: number[]; t: number[]; v: number[] }[][] }
/** the combiner's inputs: champion log-odds, market (flag + log-odds), lab features, v3 rows (NaN = unknown) */
export function gbmX(g: { p: P3; mkt: P3 | null; f: Float64Array | null; rows: Float64Array | null }, nRows: number): Float64Array {
  const z = logs(g.p);
  const x = new Float64Array(6 + NLF + nRows).fill(NaN);
  x[0] = z[0] - z[2]; x[1] = z[1] - (z[0] + z[2]) / 2; x[2] = g.mkt ? 1 : 0;
  if (g.mkt) { const m = logs(g.mkt); x[3] = m[0] - m[2]; x[4] = m[1] - (m[0] + m[2]) / 2; x[5] = (m[0] - m[2]) - x[0]; }
  if (g.f) for (let j = 0; j < NLF; j++) x[6 + j] = g.f[j];
  if (g.rows) for (let j = 0; j < Math.min(nRows, g.rows.length); j++) x[6 + NLF + j] = g.rows[j];
  return x;
}
export const gbmNames = (rowNames: string[]) => ['champ H−A', 'champ draw', 'market known', 'market H−A', 'market draw', 'market − champ', ...LAB_F, ...rowNames.map(r => `v3 ${r}`)];
function treeOut(t: { f: number[]; t: number[]; v: number[] }, x: ArrayLike<number>, depth: number) {
  let nd = 0;
  for (let d = 0; d < depth; d++) { const j = t.f[nd]; nd = 2 * nd + (j >= 0 && x[j] > t.t[nd] ? 2 : 1); } // NaN goes left
  return t.v[nd - ((1 << depth) - 1)];
}
export function applyTrees(p: P3, x: ArrayLike<number>, m: Trees): P3 {
  const z = logs(p);
  for (const r of m.t) for (let k = 0; k < 3; k++) z[k] += m.lr * treeOut(r[k], x, m.depth);
  return softmax(z);
}
export function* fitTrees(X: Float64Array[], Z: P3[], Y: number[], names: string[], C = LAB_RULES.gbm): Generator<void, Trees> {
  const n = X.length, NF = X[0]?.length || 0, D = C.depth, nLeaf = 1 << D, nInt = nLeaf - 1, nb = C.bins;
  const edges: number[][] = [], bin: Uint8Array[] = [];
  for (let j = 0; j < NF; j++) {
    const v: number[] = [];
    for (let i = 0; i < n; i++) if (fin(X[i][j])) v.push(X[i][j]);
    v.sort((a, b) => a - b);
    const e: number[] = [];
    for (let b = 1; b < nb - 1 && v.length; b++) { const q = v[Math.floor((b / (nb - 1)) * (v.length - 1))]; if (!e.length || q > e[e.length - 1]) e.push(q); }
    edges.push(e);
    const bj = new Uint8Array(n);
    // bin 0 = unknown (always goes left with the lowest values); bin k + 1 = x ≤ e[k]
    for (let i = 0; i < n; i++) { const x = X[i][j]; if (!fin(x)) { bj[i] = 0; continue; } let lo = 0, hi = e.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x > e[m]) lo = m + 1; else hi = m; } bj[i] = lo + 1; }
    bin.push(bj);
  }
  yield;
  const Fz = Z.map(z => logs(z));
  const rounds: Trees['t'] = [];
  const node = new Int32Array(n), g = new Float64Array(n), h = new Float64Array(n);
  for (let r = 0; r < C.rounds; r++) {
    const P = Fz.map(z => softmax(z));
    const round: Trees['t'][number] = [];
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < n; i++) { const p = P[i][k]; g[i] = (Y[i] === k ? 1 : 0) - p; h[i] = Math.max(1e-6, p * (1 - p)); }
      const tf = new Array(nInt).fill(-1), tt = new Array(nInt).fill(0);
      node.fill(0);
      for (let depth = 0; depth < D; depth++) {
        const first = (1 << depth) - 1, count = 1 << depth, W = nb + 1;
        const HG = new Float64Array(count * NF * W), HH = new Float64Array(count * NF * W);
        for (let i = 0; i < n; i++) {
          const nd = node[i] - first;
          const base = nd * NF * W;
          for (let j = 0; j < NF; j++) { const o = base + j * W + bin[j][i]; HG[o] += g[i]; HH[o] += h[i]; }
        }
        for (let nd = 0; nd < count; nd++) {
          let best = 0, bf = -1, bt = 0;
          let GT = 0, HT = 0;
          for (let b = 0; b < W; b++) { GT += HG[nd * NF * W + b]; HT += HH[nd * NF * W + b]; }
          const parent = (GT * GT) / (HT + C.lambda);
          for (let j = 0; j < NF; j++) {
            let GL = 0, HL = 0;
            const base = nd * NF * W + j * W;
            for (let b = 0; b < edges[j].length; b++) {
              GL += HG[base + b]; HL += HH[base + b];
              const GR = GT - GL, HR = HT - HL;
              if (b === 0 || HL < C.minHess || HR < C.minHess) continue;
              const gain = (GL * GL) / (HL + C.lambda) + (GR * GR) / (HR + C.lambda) - parent;
              if (gain > best) { best = gain; bf = j; bt = edges[j][b - 1]; }
            }
          }
          if (bf >= 0) { tf[first + nd] = bf; tt[first + nd] = bt; }
        }
        for (let i = 0; i < n; i++) { const nd = node[i], j = tf[nd]; node[i] = 2 * nd + (j >= 0 && X[i][j] > tt[nd] ? 2 : 1); }
      }
      const SG = new Float64Array(nLeaf), SH = new Float64Array(nLeaf);
      for (let i = 0; i < n; i++) { const l = node[i] - nInt; SG[l] += g[i]; SH[l] += h[i]; }
      const tv = Array.from(SG, (s, l) => Math.round(((2 / 3) * s / (SH[l] + C.lambda)) * 1e6) / 1e6);
      for (let i = 0; i < n; i++) Fz[i][k] += C.lr * tv[node[i] - nInt];
      round.push({ f: tf, t: tt.map(v => Math.round(v * 1e6) / 1e6), v: tv });
      yield;
    }
    rounds.push(round);
  }
  return { names, lr: C.lr, depth: D, t: rounds };
}
export function* fitGbm(train: LabGame[], nRows: number, rowNames: string[]): Generator<void, Trees | null> {
  if (train.length < LAB_RULES.minTrain) return null;
  const X = train.map(g => gbmX(g, nRows));
  return yield* fitTrees(X, train.map(g => g.p), train.map(g => g.y), gbmNames(rowNames));
}

/* ---------- one candidate: fit and apply ---------- */

export type Params =
  | { cand: 'anchor'; P: AnchorParams } | { cand: 'goals'; P: GoalsParams } | { cand: 'lineup'; P: ShiftParams }
  | { cand: 'draw'; P: ShiftParams } | { cand: 'gbm'; P: Trees; nRows: number };
export function* fitCand(c: CandId, train: LabGame[], nRows = 0, rowNames: string[] = []): Generator<void, Params | null> {
  if (c === 'anchor') { const P = yield* fitAnchor(train); return P ? { cand: c, P } : null; }
  if (c === 'goals') { const P = yield* fitGoals(train); return P ? { cand: c, P } : null; }
  if (c === 'lineup' || c === 'draw') { const P = yield* fitShift(train, c); return P ? { cand: c, P } : null; }
  const P = yield* fitGbm(train, nRows, rowNames);
  return P ? { cand: 'gbm', P, nRows } : null;
}
/** a fitted candidate on one game (the game's own champion numbers in, the layer's out) */
export function applyParams(s: Params, g: { p: P3; mkt: P3 | null; f: Float64Array | null; rows: Float64Array | null; group: LabGroup }): P3 {
  switch (s.cand) {
    case 'anchor': return applyAnchor(g.p, g.mkt, g.group, s.P);
    case 'goals': return applyGoals(g.p, g.f, s.P);
    case 'lineup': case 'draw': return applyShift(g.p, g, s.P);
    case 'gbm': return applyTrees(g.p, gbmX(g, s.nRows), s.P);
  }
}
/** the fitted settings in a few words (admin table) */
export function describeParams(s: Params | null): string {
  if (!s) return 'not fitted (too few earlier games)';
  const f2 = (x: number) => (Math.round(x * 100) / 100).toString();
  switch (s.cand) {
    case 'anchor': return `weight ${f2(s.P.all)} all${s.P.big != null ? `, big 5 ${f2(s.P.big)}` : ''}${s.P.rest != null ? `, rest ${f2(s.P.rest)}` : ''} (${s.P.n} priced games)`;
    case 'goals': return s.P.beta ? `blend ${f2(s.P.beta)} · xG ${f2(s.P.wx)} · shots on target ${f2(s.P.ws)} · goals ${f2(1 - s.P.wx - s.P.ws)} · home ×${f2(s.P.hf)}${s.P.rho ? ` · rho ${s.P.rho}` : ''}` : 'no blend helped on the fitting games';
    case 'lineup': return `big 5: XI value ${f2(s.P.b[0])}, XI rating ${f2(s.P.b[1])}, missing ${f2(s.P.b[2])} · rest: ${f2(s.P.b[3])}, ${f2(s.P.b[4])}, ${f2(s.P.b[5])}`;
    case 'draw': return `league ${f2(s.P.c[1])}, habits ${f2(s.P.c[2])}, goals ${f2(s.P.c[3])}, closeness ${f2(s.P.c[4])}, own draw ${f2(s.P.c[5])}, base ${f2(s.P.c[0])}`;
    case 'gbm': return `${s.P.t.length} rounds × 3 trees, depth ${s.P.depth}, learning rate ${s.P.lr}`;
  }
}

/* ---------- scoring ---------- */

export interface Band { from: number; to: number; n: number; hit: number }
export interface Score {
  n: number; logLoss: number; brier: number;
  dcLogLoss: number; dcBrier: number; dcHit: number; hit: number;
  hit60: { n: number; hit: number };            // 1X2 picks at 60%+
  bands: Band[];                                // the double-chance pick by its chance
  market: { n: number; ours: number; market: number; dcOurs: number; dcMarket: number; hit60Market: { n: number; hit: number } } | null;
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4, r1 = (x: number) => Math.round(x * 10) / 10;
export function scoreOf(games: { y: number; mkt: P3 | null }[], probs: P3[]): Score {
  const n = games.length, B = LAB_RULES.bands;
  let L = 0, Br = 0, dL = 0, dB = 0, dH = 0, H = 0, n60 = 0, h60 = 0;
  const bands = B.map((from, i) => ({ from, to: B[i + 1] ?? 1, n: 0, hit: 0 }));
  let mn = 0, mo = 0, mm = 0, dco = 0, dcm = 0, m60 = 0, mh60 = 0;
  for (let i = 0; i < n; i++) {
    const p = norm(probs[i]), y = games[i].y, dc = dcOf(p), hit = dc.out !== y, pc = clampP(dc.p);
    L += ll(p, y); Br += brier(p, y);
    dL += hit ? -Math.log(pc) : -Math.log(1 - pc); dB += ((hit ? 1 : 0) - pc) ** 2;
    if (hit) dH++;
    if (argmax(p) === y) H++;
    if (Math.max(p[0], p[1], p[2]) >= 0.6) { n60++; if (argmax(p) === y) h60++; }
    for (let b = bands.length - 1; b >= 0; b--) if (dc.p >= bands[b].from - 1e-12) { bands[b].n++; if (hit) bands[b].hit++; break; }
    const m = games[i].mkt;
    if (m) {
      mn++; mo += ll(p, y); mm += ll(m, y);
      if (hit) dco++;
      if (dcHit(m, y)) dcm++;
      if (Math.max(m[0], m[1], m[2]) >= 0.6) { m60++; if (argmax(m) === y) mh60++; }
    }
  }
  const pc = (a: number, b: number) => (b ? r1((100 * a) / b) : 0);
  return {
    n, logLoss: n ? r4(L / n) : 0, brier: n ? r4(Br / n) : 0, dcLogLoss: n ? r4(dL / n) : 0, dcBrier: n ? r4(dB / n) : 0, dcHit: pc(dH, n), hit: pc(H, n),
    hit60: { n: n60, hit: pc(h60, n60) },
    bands: bands.map(b => ({ ...b, hit: pc(b.hit, b.n) })),
    market: mn ? { n: mn, ours: r4(mo / mn), market: r4(mm / mn), dcOurs: pc(dco, mn), dcMarket: pc(dcm, mn), hit60Market: { n: m60, hit: pc(mh60, m60) } } : null
  };
}

/* ---------- windows ---------- */

export interface Window { key: string; label: string; from: number; to: number; src: 'season' | 'record'; judge: boolean }
/** a window's fitting games: every season game before it starts (+ earlier record games for the record window) */
export const trainFor = (games: LabGame[], w: Window) => games.filter(g => g.t < w.from && (g.src === 'season' || w.src === 'record'));
export const testFor = (games: LabGame[], w: Window) => games.filter(g => g.t >= w.from && g.t < w.to && g.src === w.src);
/**
 * Season windows: every season but the first is a test window; one with fewer than minTrain earlier games starts at the
 * game that has minTrain games before it (and is dropped when fewer than minWindow games remain).
 */
export function seasonWindows(games: LabGame[], seasons: string[], R = LAB_RULES): Window[] {
  const season = games.filter(g => g.src === 'season').sort((a, b) => a.t - b.t);
  const out: Window[] = [];
  const nice = (s: string) => `20${s.slice(0, 2)}-${s.slice(2)}`;
  const sorted = [...seasons].sort();
  sorted.forEach((s, i) => {
    const list = season.filter(g => g.season === s);
    if (!list.length) return;
    let from = list[0].t;
    const before = season.filter(g => g.t < from).length;
    let label = nice(s);
    if (before < R.minTrain) {
      if (season.length <= R.minTrain) return;
      from = season[R.minTrain - 1].t + 1; // every game up to the minTrain-th (ties included) is a fitting game
      label = `${nice(s)} (from ${new Date(from).toISOString().slice(0, 10)})`;
    }
    const to = list[list.length - 1].t + 1;
    if (season.filter(g => g.t >= from && g.t < to).length < R.minWindow / 3) return;
    out.push({ key: s, label: i === sorted.length - 1 ? `${label} so far` : label, from, to, src: 'season', judge: false });
  });
  // fix251's two windows: the last full season and this season
  out.slice(-2).forEach(w => { w.judge = true; });
  return out;
}

/* ---------- the pick rule (candidate 6, report only) ---------- */

export interface PickRule { thresholds: Record<string, number>; pooled: { t: number; n: number; hit: number }[]; shown: { n: number; hit: number }; all: { n: number; hit: number } }
/** per league: the lowest threshold whose fitting-game picks were right ≥ pickTarget (≥ pickMinTrain picks), else the surest one */
export function fitPickRule(train: LabGame[], R = LAB_RULES): Record<string, number> {
  const by = new Map<string, LabGame[]>();
  for (const g of train) { if (!by.has(g.div)) by.set(g.div, []); by.get(g.div)!.push(g); }
  const out: Record<string, number> = {};
  for (const [div, list] of by) {
    const dcs = list.map(g => ({ p: dcOf(g.p).p, hit: dcHit(g.p, g.y) }));
    let chosen: number | null = null, best = { t: 0, rate: -1 };
    for (const t of R.pickThresholds) {
      const s = dcs.filter(d => d.p >= t - 1e-12);
      if (s.length < R.pickMinTrain) continue;
      const rate = s.filter(d => d.hit).length / s.length;
      if (rate >= R.pickTarget && chosen === null) chosen = t;
      if (rate > best.rate) best = { t, rate };
    }
    out[div] = chosen ?? (best.rate >= 0 ? best.t : 0);
  }
  return out;
}
export function pickRuleReport(train: LabGame[], test: LabGame[], probs: P3[], R = LAB_RULES): PickRule {
  const th = fitPickRule(train, R);
  const pc = (a: number, b: number) => (b ? r1((100 * a) / b) : 0);
  let sn = 0, sh = 0, an = 0, ah = 0;
  test.forEach((g, i) => {
    const d = dcOf(probs[i]), hit = d.out !== g.y;
    an++; if (hit) ah++;
    if (d.p >= (th[g.div] ?? 0) - 1e-12) { sn++; if (hit) sh++; }
  });
  const pooled = R.pickThresholds.map(t => {
    let n = 0, h = 0;
    test.forEach((g, i) => { const d = dcOf(probs[i]); if (d.p >= t - 1e-12) { n++; if (d.out !== g.y) h++; } });
    return { t, n, hit: pc(h, n) };
  });
  return { thresholds: th, pooled, shown: { n: sn, hit: pc(sh, sn) }, all: { n: an, hit: pc(ah, an) } };
}

/* ---------- the verdict (fix251's rule) ---------- */

export interface WinDiff { key: string; n: number; diff: number; hitC: number; hitB: number }
export interface LabVerdict { pass: boolean; why: string; boot: Boot | null; pooled: number }
const sg = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;
export function windowDiff(key: string, games: { y: number }[], cand: P3[], base: P3[]): { s: WinDiff; d: number[] } {
  const d: number[] = [];
  let hc = 0, hb = 0;
  games.forEach((g, i) => { d.push(ll(cand[i], g.y) - ll(base[i], g.y)); if (argmax(norm(cand[i])) === g.y) hc++; if (argmax(norm(base[i])) === g.y) hb++; });
  const n = d.length;
  return { s: { key, n, diff: n ? Math.round((d.reduce((a, b) => a + b, 0) / n) * 1e5) / 1e5 : 0, hitC: n ? r1((100 * hc) / n) : 0, hitB: n ? r1((100 * hb) / n) : 0 }, d };
}
/**
 * fix251's bar on the lab's two judging windows (Wp = last full season, W = this season): ≥ 300 games each, better in
 * both, gain ≥ 0.0005 this season, ≥ 90% of the paired resamples better, 1X2 hit rate not down > 0.5 pp; the combiner
 * (gbm) needs ≥ 0.003 in both; the public record (last 60 days) must not be worse when it has ≥ 300 games.
 */
export function* judgeSteps(c: CandId, Wp: { s: WinDiff; d: number[] } | null, W: { s: WinDiff; d: number[] } | null, rec: WinDiff | null, R = DAILY_RULES, L = LAB_RULES): Generator<void, LabVerdict> {
  const pooled = W && Wp ? Math.round(((W.s.diff * W.s.n + Wp.s.diff * Wp.s.n) / Math.max(1, W.s.n + Wp.s.n)) * 1e5) / 1e5 : 0;
  const no = (why: string, boot: Boot | null = null): LabVerdict => ({ pass: false, why, boot, pooled });
  if (!W || !Wp) return no('needs two judging windows (last season and this season)');
  if (Wp.s.n < R.minGames) return no(`${Wp.s.n} games last season (< ${R.minGames})`);
  if (W.s.n < R.minGames) return no(`${W.s.n} games this season (< ${R.minGames})`);
  if (Wp.s.diff >= 0) return no(`not better last season (${sg(Wp.s.diff)})`);
  if (W.s.diff >= 0) return no(`not better this season (${sg(W.s.diff)})`);
  if (W.s.diff > -R.minGain + 1e-12) return no(`gain too small this season (${sg(W.s.diff)}, needs ≤ −${R.minGain})`);
  if (c === 'gbm' && (W.s.diff > -L.gbmMinGain || Wp.s.diff > -L.gbmMinGain)) return no(`the combiner needs ≥ ${L.gbmMinGain} in both (${sg(Wp.s.diff)} / ${sg(W.s.diff)})`);
  if (rec && rec.n >= L.recordGames && rec.diff > 0) return no(`worse on the public record's last 60 days (${sg(rec.diff)} on ${rec.n} games)`);
  const g = (function* () { return yield* bootGen([...W.d, ...Wp.d], R.resamples); })();
  const boot = yield* g;
  if (boot.pBetter < R.confidence) return no(`better in both, but only ${Math.round(boot.pBetter * 100)}% of resamples (needs ${Math.round(R.confidence * 100)}%)`, boot);
  const drop = Math.round((W.s.hitB - W.s.hitC) * 10) / 10;
  if (drop > R.maxHitDrop) return no(`1X2 hit rate down ${drop} pp this season (max ${R.maxHitDrop})`, boot);
  return { pass: true, why: `last season ${sg(Wp.s.diff)}, this season ${sg(W.s.diff)}, better in ${Math.round(boot.pBetter * 100)}% of resamples`, boot, pooled };
}
/** the bootstrap (same numbers as fix251's: seed 251), after one pause */
function* bootGen(d: number[], B: number): Generator<void, Boot> { yield; return pairedBootstrap(d, B, 251); }
export const judge = (c: CandId, Wp: { s: WinDiff; d: number[] } | null, W: { s: WinDiff; d: number[] } | null, rec: WinDiff | null) => run(judgeSteps(c, Wp, W, rec));

/* ---------- the whole lab on a set of games (the service feeds it; the test feeds made-up games) ---------- */

export interface CandWindow { key: string; score: Score; diff: WinDiff; params: string }
export interface CandReport { cand: CandId; label: string; windows: CandWindow[]; verdict: LabVerdict }
export interface LabReport {
  windows: { key: string; label: string; from: string; to: string; src: 'season' | 'record'; judge: boolean; train: number; n: number }[];
  champion: { key: string; score: Score }[];
  cands: CandReport[];
  pickRule: { key: string; rule: PickRule }[];
  winner: CandId | null; winnerWhy: string;
  live: Params | null; // the winner refitted on every game (what goes live)
}
export function* labSteps(games: LabGame[], windows: Window[], o: { nRows?: number; rowNames?: string[]; cands?: CandId[] } = {}): Generator<void, LabReport> {
  const cands = o.cands || CANDS, nRows = o.nRows || 0, rowNames = o.rowNames || [];
  const sorted = [...games].sort((a, b) => a.t - b.t);
  const champion: LabReport['champion'] = [], pickRule: LabReport['pickRule'] = [];
  const wins = windows.map(w => ({ w, train: trainFor(sorted, w), test: testFor(sorted, w) })).filter(x => x.test.length);
  const per = new Map<CandId, { windows: CandWindow[]; d: Map<string, { s: WinDiff; d: number[] }> }>();
  for (const c of cands) per.set(c, { windows: [], d: new Map() });
  for (const { w, train, test } of wins) {
    const base = test.map(g => norm(g.p));
    champion.push({ key: w.key, score: scoreOf(test, base) });
    pickRule.push({ key: w.key, rule: pickRuleReport(train, test, base) });
    yield;
    for (const c of cands) {
      const s = yield* fitCand(c, train, nRows, rowNames);
      const probs = s ? test.map(g => applyParams(s, g)) : base;
      const diff = windowDiff(w.key, test, probs, base);
      const e = per.get(c)!;
      e.windows.push({ key: w.key, score: scoreOf(test, probs), diff: diff.s, params: describeParams(s) });
      e.d.set(w.key, diff);
      yield;
    }
  }
  const judged = wins.filter(x => x.w.judge && x.w.src === 'season').map(x => x.w.key);
  const recKey = wins.find(x => x.w.src === 'record')?.w.key;
  const out: CandReport[] = [];
  for (const c of cands) {
    const e = per.get(c)!;
    const Wp = judged.length === 2 ? e.d.get(judged[0]) || null : null, W = judged.length === 2 ? e.d.get(judged[1]) || null : null;
    const verdict = yield* judgeSteps(c, Wp, W, recKey ? e.d.get(recKey)?.s || null : null);
    out.push({ cand: c, label: CAND_LABEL[c], windows: e.windows, verdict });
  }
  const passing = out.filter(x => x.verdict.pass).sort((a, b) => a.verdict.pooled - b.verdict.pooled);
  const winner = passing[0]?.cand ?? null;
  let live: Params | null = null;
  if (winner) live = yield* fitCand(winner, sorted, nRows, rowNames);
  const best = [...out].sort((a, b) => a.verdict.pooled - b.verdict.pooled)[0];
  return {
    windows: wins.map(x => ({ key: x.w.key, label: x.w.label, from: new Date(x.w.from).toISOString().slice(0, 10), to: new Date(x.w.to - 1).toISOString().slice(0, 10), src: x.w.src, judge: x.w.judge, train: x.train.length, n: x.test.length })),
    champion, cands: out, pickRule, winner,
    winnerWhy: winner ? `${CAND_LABEL[winner]}: ${passing[0].verdict.why}` : best ? `nothing passed — closest: ${best.label} (${best.verdict.why})` : 'nothing to judge',
    live
  };
}
export const runLab = (games: LabGame[], windows: Window[], o?: Parameters<typeof labSteps>[2]) => run(labSteps(games, windows, o));

/* ---------- lab features: the walk-forward team state (history and live use the same code) ---------- */

export interface LabTeam { gf: number; ga: number; xgf: number; xga: number; sotf: number; sota: number; draws: number[]; games: number }
export interface LabDiv { gpg: number; xgpg: number; sotpg: number; gps: number; draw: number; n: number }
export interface LabState { teams: Map<string, LabTeam>; divs: Map<string, LabDiv> }
export const newLabState = (): LabState => ({ teams: new Map(), divs: new Map() });
const ALPHA = 0.15, DRAW_N = 20, DRAW_SHRINK = 8;
function divSt(st: LabState, div: string): LabDiv {
  let d = st.divs.get(div);
  if (!d) st.divs.set(div, (d = { gpg: 1.35, xgpg: 1.35, sotpg: 4.3, gps: 0.31, draw: 0.26, n: 0 }));
  return d;
}
function teamSt(st: LabState, key: string, d: LabDiv): LabTeam {
  let t = st.teams.get(key);
  if (!t) st.teams.set(key, (t = { gf: d.gpg, ga: d.gpg, xgf: NaN, xga: NaN, sotf: NaN, sota: NaN, draws: [], games: 0 }));
  return t;
}
export interface LabFx { div: string; home: string; away: string; hg?: number | null; ag?: number | null; xh?: number | null; xa?: number | null; sh?: number | null; sa?: number | null }
/** the lab features of a game from the state before it; `fx` = the feature model's row (XI, injuries, Elo) or null */
export function labFeatures(st: LabState, m: LabFx, fx: ArrayLike<number> | null): Float64Array {
  const d = divSt(st, m.div), h = teamSt(st, m.home, d), a = teamSt(st, m.away, d);
  const f = new Float64Array(NLF).fill(NaN);
  const warm = h.games >= 3 && a.games >= 3;
  if (warm) {
    f[F.gH] = (h.gf + a.ga) / 2; f[F.gA] = (a.gf + h.ga) / 2;
    if (fin(h.xgf) && fin(a.xga)) f[F.xH] = (h.xgf + a.xga) / 2;
    if (fin(a.xgf) && fin(h.xga)) f[F.xA] = (a.xgf + h.xga) / 2;
    if (fin(h.sotf) && fin(a.sota)) f[F.sH] = ((h.sotf + a.sota) / 2) * d.gps;
    if (fin(a.sotf) && fin(h.sota)) f[F.sA] = ((a.sotf + h.sota) / 2) * d.gps;
  }
  const habit = (t: LabTeam) => (t.draws.reduce((s, v) => s + v, 0) + DRAW_SHRINK * d.draw) / (t.draws.length + DRAW_SHRINK);
  f[F.drawH] = habit(h); f[F.drawA] = habit(a); f[F.lgDraw] = d.draw;
  if (fx) {
    // the feature model's vector (featureModel.FEATURES): elo 0, xiValue 12, xiKnown 13, xiRating 14, injWeighted 17
    f[F.elo] = fx[0]; f[F.xiVal] = fx[12]; f[F.xiKnown] = fx[13]; f[F.xiRating] = fx[14]; f[F.injW] = fx[17];
  }
  return f;
}
/** learn a finished game */
export function labLearn(st: LabState, m: LabFx) {
  if (m.hg == null || m.ag == null) return;
  const d = divSt(st, m.div), h = teamSt(st, m.home, d), a = teamSt(st, m.away, d);
  const ew = (old: number, v: number) => (fin(old) ? old + ALPHA * (v - old) : v);
  const hg = m.hg, ag = m.ag;
  h.gf = ew(h.gf, hg); h.ga = ew(h.ga, ag); a.gf = ew(a.gf, ag); a.ga = ew(a.ga, hg);
  if (m.xh != null && m.xa != null) { h.xgf = ew(h.xgf, m.xh); h.xga = ew(h.xga, m.xa); a.xgf = ew(a.xgf, m.xa); a.xga = ew(a.xga, m.xh); d.xgpg = d.xgpg + 0.01 * ((m.xh + m.xa) / 2 - d.xgpg); }
  if (m.sh != null && m.sa != null) {
    h.sotf = ew(h.sotf, m.sh); h.sota = ew(h.sota, m.sa); a.sotf = ew(a.sotf, m.sa); a.sota = ew(a.sota, m.sh);
    d.sotpg = d.sotpg + 0.01 * ((m.sh + m.sa) / 2 - d.sotpg);
    if (m.sh + m.sa > 0) d.gps = d.gps + 0.01 * ((hg + ag) / (m.sh + m.sa) - d.gps);
  }
  const dr = hg === ag ? 1 : 0;
  for (const t of [h, a]) { t.draws.push(dr); if (t.draws.length > DRAW_N) t.draws.shift(); t.games++; }
  d.gpg = d.gpg + 0.01 * ((hg + ag) / 2 - d.gpg);
  d.draw = d.draw + 0.01 * (dr - d.draw);
  d.n++;
}

/** made-up games for the test and for the admin's dry run: known strengths, a market that knows a little more */
export function syntheticGames(o: { seasons: string[]; teams?: number; leagues?: number; seed?: number; drawSignal?: number; marketEdge?: number; champSd?: number }): LabGame[] {
  const rnd = mulberry32(o.seed ?? 291);
  const gauss = () => { const u = Math.max(1e-12, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const T = o.teams ?? 16, Lg = o.leagues ?? 6;
  const out: LabGame[] = [];
  let id = 0;
  for (let l = 0; l < Lg; l++) {
    const div = `L${l}`, st = newLabState(), drawy = (l % 3) * 0.4 * (o.drawSignal ?? 0.1);
    const str = Array.from({ length: T }, () => gauss() * 0.35), drawT = Array.from({ length: T }, () => rnd() * (o.drawSignal ?? 0.1));
    o.seasons.forEach((s, si) => {
      const t0 = Date.UTC(2000 + Number(s.slice(0, 2)), 7, 10);
      let k = 0;
      for (let r = 0; r < 2 * (T - 1); r++) for (let i = 0; i < T / 2; i++) {
        const hI = (r + i) % T, aI = (T - 1 - i + r) % T;
        if (hI === aI) continue;
        const truth = str[hI] - str[aI] + 0.25;
        const lh = Math.exp(0.25 + truth / 2), la = Math.exp(0.15 - truth / 2);
        const extra = drawy + drawT[hI] + drawT[aI];
        const pois = (l: number) => { let k = 0, p = Math.exp(-l), c = p; const u = rnd(); while (u > c && k < 10) { k++; p *= l / k; c += p; } return k; };
        let hg = pois(lh), ag = pois(la);
        if (rnd() < extra) ag = hg;
        const y = hg > ag ? 0 : hg === ag ? 1 : 2;
        const noisy = (sd: number) => { const z = truth + (sd ? gauss() * sd : 0); const lh2 = Math.exp(0.25 + z / 2), la2 = Math.exp(0.15 - z / 2); return poisson1x2(lh2, la2); };
        const home = `${div}-${hI}`, away = `${div}-${aI}`;
        const f = labFeatures(st, { div, home, away }, null);
        const t = t0 + (k++) * 3600 * 1000 * 20;
        const p = noisy(o.champSd ?? 0.35), mkt = rnd() < 0.8 ? (() => { const m = noisy(Math.max(0.05, 0.35 * (1 - (o.marketEdge ?? 0.4)))); return norm([m[0] * (1 - extra * 0.6), m[1] + extra * 0.6 * (m[0] + m[2]), m[2] * (1 - extra * 0.6)]); })() : null;
        out.push({ id: `s${id++}`, t, season: s, src: 'season', div, league: `League ${l}`, group: l < 2 ? 'big' : 'rest', home, away, y, p, mkt, f, rows: null });
        labLearn(st, { div, home, away, hg, ag, xh: lh * (0.8 + 0.4 * rnd()), xa: la * (0.8 + 0.4 * rnd()), sh: Math.round(lh * 3), sa: Math.round(la * 3) });
      }
      void si;
    });
  }
  return out;
}

/**
 * fix251: the rules of the football daily champion / challenger job (services/modelDaily.ts), pure — no database.
 *
 *  - the candidate list: every mix weight 0.4 … 1.0 (1.0 = the feature model alone) with the current and the fresh
 *    feature fit, the refitted v3 weights (with the champion's mix and with the best mix), a mix weight per league
 *    group (big leagues / the rest, ≥ 300 games each) and a market anchor (games with stored prices only, weight
 *    0.1–0.4 chosen walk-forward on the window before);
 *  - the bar: a paired bootstrap on the per-game log-loss differences (candidate − champion) over both 60-day
 *    windows, 2,000 resamples; promote when the candidate is better in both windows, better in ≥ 90% of the
 *    resamples, and its hit rate is not down by more than 0.5 pp. (Replaces fix113's fixed −0.003.)
 */

export type P3 = [number, number, number];

export const DAILY_RULES = {
  windowDays: 60, minGames: 300, resamples: 2000, confidence: 0.9, maxHitDrop: 0.5,
  guardGames: 100, guardWorse: 0.005, mixOffWorse: 0.005,
  mixWeights: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], anchorWeights: [0.1, 0.2, 0.3, 0.4], groupMinGames: 300,
  quietDays: 30 // data health warns after this many days without a promotion while the best candidate is better in both windows
};

/** The big leagues (top flights of England, Spain, Italy, Germany, France); every other league is "rest". */
export const BIG_DIVS = new Set(['E0', 'SP1', 'I1', 'D1', 'F1']);
export const BIG_COMPS = new Set(['PL', 'PD', 'SA', 'BL1', 'FL1']);
export type LeagueGroup = 'big' | 'rest';
export const groupOfDiv = (div: string | null | undefined, comp?: string | null): LeagueGroup =>
  (div && BIG_DIVS.has(div)) || (comp && BIG_COMPS.has(comp)) ? 'big' : 'rest';

/* ---------- probabilities ---------- */

const norm = (p: number[]): P3 => { const s = p[0] + p[1] + p[2] || 1; return [p[0] / s, p[1] / s, p[2] / s]; };
export const mixP = (w: number, v: P3, f: P3): P3 => norm([0, 1, 2].map(i => (1 - w) * v[i] + w * f[i]));
/** blend toward the market's (margin-free) probabilities: (1 − a) · ours + a · market */
export const anchorP = (p: P3, mkt: P3 | null, a: number): P3 => (mkt && a > 0 ? norm([0, 1, 2].map(i => (1 - a) * norm(p)[i] + a * norm(mkt)[i])) : norm(p));
export const logLossOf = (p: P3, y: number) => -Math.log(Math.max(1e-6, norm(p)[y]));
const isHit = (p: P3, y: number) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1) === y;

/* ---------- the candidate list ---------- */

export type FitKind = 'current' | 'fresh';
/** one setting: how a game's probabilities are made. `anchor` 'wf' = weight chosen on the window before. */
export interface Spec {
  w: number; groupW: { big: number; rest: number } | null; fit: FitKind; v3: 'champion' | 'refit'; anchor: number | 'wf';
}
export interface CandSpec extends Spec { id: string; label: string; kind: 'champion' | 'feature' | 'mix' | 'v3' | 'group' | 'anchor' }

const fitWord = (f: FitKind) => (f === 'fresh' ? 'fresh feature fit' : 'current feature fit');
export const sameSpec = (a: Spec, b: Spec) =>
  Math.abs(a.w - b.w) < 1e-9 && a.fit === b.fit && a.v3 === b.v3 && a.anchor === b.anchor &&
  JSON.stringify(a.groupW) === JSON.stringify(b.groupW);

/**
 * Stage 1 (always): the champion, the mix grid × {current, fresh} fit, the refitted v3 weights at the champion's mix.
 * Stage 2 (`best` given — the best stage-1 mix, chosen on both windows): the refitted v3 weights with that mix, the
 * per-group weights (`group`, only when both groups have enough games), the market anchor on the champion and on
 * the best mix. Duplicates of the champion are left out.
 */
export function candidateList(o: {
  champion: Spec; v3Refit: boolean; weights?: number[];
  best?: { w: number; fit: FitKind } | null; group?: { big: number; rest: number; fit: FitKind } | null; anchor?: boolean;
}): CandSpec[] {
  const c0 = o.champion;
  const out: CandSpec[] = [{ ...c0, id: 'champion', label: 'champion', kind: 'champion' }];
  const add = (c: CandSpec) => { if (!out.some(x => x.id === c.id || sameSpec(x, c))) out.push(c); };
  // challenger (a): the champion's setting with the daily refit of the feature model
  add({ ...c0, fit: 'fresh', id: 'feature-refit', kind: 'feature', label: 'fresher feature fit (the daily refit), champion’s mix' });
  for (const fit of ['fresh', 'current'] as FitKind[]) {
    for (const w of o.weights || DAILY_RULES.mixWeights) {
      const alone = w >= 1 - 1e-9;
      add({ ...c0, w, groupW: null, fit, id: `mix-${w}-${fit}`, kind: 'mix', label: alone ? `feature model alone (${fitWord(fit)})` : `mix weight ${w} (${fitWord(fit)})` });
    }
  }
  if (o.v3Refit) add({ ...c0, v3: 'refit', id: 'v3-weights', kind: 'v3', label: 'v3 row weights refitted (v3 tuner, 2 seasons + this season)' });
  if (o.best) {
    const b = o.best;
    if (o.v3Refit) add({ ...c0, v3: 'refit', w: b.w, groupW: null, fit: b.fit, id: 'v3-weights+best-mix', kind: 'v3', label: `v3 row weights refitted + mix weight ${b.w} (${fitWord(b.fit)})` });
    if (o.anchor) {
      add({ ...c0, anchor: 'wf', id: 'anchor-champion', kind: 'anchor', label: 'market anchor on the champion (weight 0.1–0.4 chosen on the window before)' });
      add({ ...c0, w: b.w, groupW: null, fit: b.fit, anchor: 'wf', id: 'anchor-best-mix', kind: 'anchor', label: `market anchor on mix weight ${b.w} (${fitWord(b.fit)})` });
    }
  }
  if (o.group) {
    const g = o.group;
    add({ ...c0, w: g.big, groupW: { big: g.big, rest: g.rest }, fit: g.fit, id: 'mix-by-group', kind: 'group', label: `mix weight per league group: big leagues ${g.big}, rest ${g.rest} (${fitWord(g.fit)})` });
  }
  return out;
}

/* ---------- choosing a weight ---------- */

/** the weight with the lowest log loss on `rows` (ties: the smaller weight) */
export function chooseWeight(rows: { y: number }[], weights: number[], probs: (r: any, w: number) => P3 | null): { w: number; logLoss: number; n: number } | null {
  let best: { w: number; logLoss: number; n: number } | null = null;
  for (const w of weights) {
    let s = 0, n = 0;
    for (const r of rows) { const p = probs(r, w); if (p) { s += logLossOf(p, r.y); n++; } }
    if (!n) continue;
    const ll = s / n;
    if (!best || ll < best.logLoss - 1e-12) best = { w, logLoss: ll, n };
  }
  return best;
}
/** the market-anchor weight for a window, chosen on the games with prices of the window before */
export const chooseAnchor = (rows: { p: P3; mkt: P3 | null; y: number }[], weights = DAILY_RULES.anchorWeights) =>
  chooseWeight(rows.filter(r => r.mkt), weights, (r, a) => anchorP(r.p, r.mkt, a))?.w ?? null;

/* ---------- the bar: paired bootstrap ---------- */

/** small seeded generator (the same table every run on the same games) */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export interface Boot { n: number; mean: number; lo: number; hi: number; pBetter: number }
function* bootSteps(d: ArrayLike<number>, B: number, seed: number): Generator<void, Boot> {
  const n = d.length;
  if (!n) return { n: 0, mean: 0, lo: 0, hi: 0, pBetter: 0 };
  let s = 0;
  for (let i = 0; i < n; i++) s += d[i];
  const rnd = mulberry32(seed + n);
  const means = new Float64Array(B);
  let below = 0;
  for (let b = 0; b < B; b++) {
    let t = 0;
    for (let i = 0; i < n; i++) t += d[(rnd() * n) | 0];
    means[b] = t / n;
    if (means[b] < 0) below++;
    if (b % 100 === 99) yield;
  }
  means.sort();
  const q = (p: number) => means[Math.min(B - 1, Math.max(0, Math.floor(p * (B - 1))))];
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return { n, mean: r6(s / n), lo: r6(q(0.05)), hi: r6(q(0.95)), pBetter: Math.round((1000 * below) / B) / 1000 };
}
/**
 * Paired bootstrap of per-game differences d (candidate − champion log loss; negative = candidate better): resample
 * the games with replacement `B` times; `pBetter` = share of resamples whose mean is below 0, `lo` / `hi` = the 5th /
 * 95th percentile of the resampled means (the 90% interval). Seeded: the same games give the same answer.
 */
export function pairedBootstrap(d: ArrayLike<number>, B = DAILY_RULES.resamples, seed = 251): Boot {
  const g = bootSteps(d, B, seed);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
/** the same, giving the thread back every 100 resamples (the worker's job) — identical result */
export async function pairedBootstrapAsync(d: ArrayLike<number>, pause: () => Promise<void>, B = DAILY_RULES.resamples, seed = 251): Promise<Boot> {
  const g = bootSteps(d, B, seed);
  for (;;) { const r = g.next(); if (r.done) return r.value; await pause(); }
}

/* ---------- the verdict ---------- */

export interface Paired { n: number; diff: number; hitC: number; hitB: number } // per window: games, mean diff, hit rates (%)
/** per-window paired numbers from per-game rows (only games where both have a number) */
export function paired(rows: { c: P3 | null; b: P3 | null; y: number }[]): { s: Paired; d: number[] } {
  const d: number[] = [];
  let hc = 0, hb = 0;
  for (const r of rows) {
    if (!r.c || !r.b) continue;
    d.push(logLossOf(r.c, r.y) - logLossOf(r.b, r.y));
    if (isHit(r.c, r.y)) hc++;
    if (isHit(r.b, r.y)) hb++;
  }
  const n = d.length;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { s: { n, diff: n ? Math.round((d.reduce((a, b) => a + b, 0) / n) * 1e5) / 1e5 : 0, hitC: n ? r1((100 * hc) / n) : 0, hitB: n ? r1((100 * hb) / n) : 0 }, d };
}

export interface Verdict { pass: boolean; why: string; boot: Boot | null; gap: string | null }
type Win = { s: Paired; d: number[] };
const sg = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;
/** the checks that need no bootstrap: a verdict, or null when the bootstrap decides */
export function preJudge(W: Win, Wp: Win, R = DAILY_RULES): Verdict | null {
  if (W.s.n < R.minGames) return { pass: false, why: `${W.s.n} games in the last 60 days (< ${R.minGames})`, boot: null, gap: `needs ${R.minGames - W.s.n} more games` };
  if (Wp.s.n < R.minGames) return { pass: false, why: `${Wp.s.n} games in the previous 60 days (< ${R.minGames})`, boot: null, gap: `needs ${R.minGames - Wp.s.n} more games in the previous window` };
  if (W.s.diff >= 0) return { pass: false, why: `not better in the last 60 days (${sg(W.s.diff)})`, boot: null, gap: `last 60 days ${sg(W.s.diff)}: needs below 0` };
  if (Wp.s.diff >= 0) return { pass: false, why: `not better in the previous 60 days (${sg(Wp.s.diff)})`, boot: null, gap: `previous 60 days ${sg(Wp.s.diff)}: needs below 0` };
  return null;
}
export function finishJudge(W: Win, Wp: Win, boot: Boot, R = DAILY_RULES): Verdict {
  const hitDrop = Math.round((W.s.hitB - W.s.hitC) * 10) / 10;
  if (boot.pBetter < R.confidence) return { pass: false, why: `better in both windows but not sure enough: better in ${Math.round(boot.pBetter * 100)}% of resamples (needs ${Math.round(R.confidence * 100)}%)`, boot, gap: `${Math.round(boot.pBetter * 100)}% of the ${Math.round(R.confidence * 100)}% needed` };
  if (hitDrop > R.maxHitDrop) return { pass: false, why: `hit rate ${W.s.hitC}% vs ${W.s.hitB}% (down more than ${R.maxHitDrop} pp)`, boot, gap: `hit rate down ${hitDrop.toFixed(1)} pp (max ${R.maxHitDrop})` };
  return { pass: true, why: `last 60 days ${sg(W.s.diff)}, previous 60 days ${sg(Wp.s.diff)}, better in ${Math.round(boot.pBetter * 100)}% of resamples`, boot, gap: null };
}
/**
 * W = the last 60 days, Wp = the 60 days before. The candidate passes when: ≥ minGames in each window, better (mean
 * per-game log loss below the champion's) in both, better in ≥ confidence of the bootstrap resamples of both windows
 * together, and its hit rate in W is not down by more than maxHitDrop. `gap` says how far a failing one is.
 */
export function judge(W: Win, Wp: Win, R = DAILY_RULES, seed = 251): Verdict {
  return preJudge(W, Wp, R) || finishJudge(W, Wp, pairedBootstrap([...W.d, ...Wp.d], R.resamples, seed), R);
}

/** how close a failing candidate is (lower = closer): the order of "today's best candidate" */
export const closeness = (v: { W: Paired; Wp: Paired; boot: Boot | null }) =>
  (v.W.diff < 0 && v.Wp.diff < 0 ? -1 - (v.boot?.pBetter ?? 0) : 0) + (v.W.n * v.W.diff + v.Wp.n * v.Wp.diff) / Math.max(1, v.W.n + v.Wp.n);

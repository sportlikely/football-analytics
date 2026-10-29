/**
 * fix254 — the recent calibration layer (football, tennis; basketball since fix270), pure: no database.
 * services/recentCalib.ts runs it nightly.
 *
 * Data health failed on 28 Oct: football 50–60% said 54%, happened 59.8% (326 games); tennis 60–70% said 64.9%,
 * happened 74% (77 games) — the live models were less sure than they turned out to be. The season layers (tennis:
 * fix222's Platt on past seasons; football: none) can't see a drift inside the live season.
 *
 * fix270 (the layer never fitted: fix254 wanted 300 games older than 120 days, which the new sports don't have):
 *  - Fit on everything settled except the last TEST_DAYS (30) days, MIN_FIT (200) games at least; the walk-forward test
 *    is those 30 days (MIN_TEST games at least). The layer that passed is the one that goes live (it never saw them).
 *    A young sport (basketball / tennis saved the model's own chance only from 25 Oct: fewer than MIN_FIT games before
 *    the 30 days, MIN_FIT+ in all): every settled game tested out of fold (5 blocks of time, each scored by a fit on the
 *    other 4), then the fit on all of them goes live — "refit now on every settled game", still tested on unseen games.
 *  - Two kinds, each shrunk toward "no change" (the identity) so a small sample can't over-correct:
 *    isotonic (pool adjacent violators, each block shrunk toward its own mean chance, SHRINK games' worth) and Platt
 *    on the logit of the pick's chance (a ridge prior at a = 1, b = 0 worth PLATT_SHRINK games). The kind is chosen on
 *    the fit rows only (fit on all but their last 30 days, scored on those); too few for that = Platt (2 numbers).
 *  - Applied to the top chance only; the other results share the rest in their old proportion. The favourite never
 *    changes (the top chance is held above the second's new value) — Yarin's model principle. Monotone: a surer pick
 *    stays surer.
 *  - Promotion: fix251's bootstrap rule on the 30 test days — better than the live layer (none = the model's own),
 *    gain ≥ 0.0005 per game, better in ≥ 90% of 2,000 paired resamples, hit rate not down by > 0.5 pp, at most one
 *    promotion in 7 days. Rollback as the champion rule: a live layer worse than none by > 0.005 on the 100+ games
 *    since it went live goes (any day, never held).
 */
import { DAILY_RULES, paired, pairedBootstrap, promotionWait, logLossOf, type P3, type Verdict } from './dailyRules';

export const TEST_DAYS = 30;
/** rows read (days back from today): "everything settled" in practice */
export const HORIZON_DAYS = 400;
export const MIN_FIT = 200;
export const MIN_TEST = 100;
export const SHRINK = 30;
export const PLATT_SHRINK = 100;
/** kept for older callers: the fit reaches this far back before the test window */
export const FIT_DAYS = HORIZON_DAYS - TEST_DAYS;
const DAY = 86400000;
const MIN_A = 0.05;

export type LayerKind = 'iso' | 'platt';
/** iso: knots x → y; platt: p' = σ(a · logit(p) + b) on the pick's chance (x / y empty). `fitted` = the day it was made */
export interface IsoLayer { x: number[]; y: number[]; n: number; from: string; to: string; kind?: LayerKind; a?: number; b?: number; fitted?: string }
export type LayerFn = Pick<IsoLayer, 'x' | 'y'> & Partial<Pick<IsoLayer, 'kind' | 'a' | 'b'>>;
/**
 * p = the chance before this layer (the fit's input); `cur` = what was shown while no recent layer was live, when that
 * differs from p (basketball: fix222's season layer on p_raw) — the "before" the candidate has to beat.
 */
export interface CRow { p: P3; y: number; t: number; cur?: P3 }

const norm = (p: number[]): P3 => { const s = p[0] + p[1] + p[2] || 1; return [p[0] / s, p[1] / s, p[2] / s]; };
const topOf = (p: P3) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const clip = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p: number) => Math.log(clip(p) / (1 - clip(p)));
const sig = (x: number) => 1 / (1 + Math.exp(-x));

/** PAV on (top chance, right) sorted by chance, then each block shrunk toward its mean chance */
export function fitIso(rows: { top: number; hit: number }[], shrink = SHRINK): { x: number[]; y: number[] } {
  const s = rows.filter(r => Number.isFinite(r.top)).slice().sort((a, b) => a.top - b.top);
  const blocks: { sx: number; sy: number; n: number }[] = [];
  for (const r of s) {
    blocks.push({ sx: r.top, sy: r.hit, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sy / a.n < b.sy / b.n) break;
      a.sx += b.sx; a.sy += b.sy; a.n += b.n; blocks.pop();
    }
  }
  const x: number[] = [], y: number[] = [];
  for (const b of blocks) {
    const mx = b.sx / b.n, my = b.sy / b.n, w = b.n / (b.n + shrink);
    const v = w * my + (1 - w) * mx;
    // equal chances in two blocks can't happen after pooling; keep the knots strictly increasing in x and monotone in y
    if (x.length && mx <= x[x.length - 1] + 1e-9) { y[y.length - 1] = Math.max(y[y.length - 1], v); continue; }
    x.push(r4(mx)); y.push(r4(Math.max(v, y.length ? y[y.length - 1] : 0)));
  }
  return { x, y };
}

/**
 * fix270: Platt on the logit of the pick's chance, with a ridge prior at the identity (a = 1, b = 0) worth `shrink`
 * games: the prior's weight is `shrink` × the average information one game carries at the identity, so 200 games move
 * the fit about 2/3 of the way to what they say, 20 games barely move it.
 */
export function fitPlattTop(rows: { top: number; hit: number }[], shrink = PLATT_SHRINK): { a: number; b: number } {
  const s = rows.filter(r => Number.isFinite(r.top));
  if (!s.length) return { a: 1, b: 0 };
  const xs = s.map(r => logit(r.top));
  let iaa = 0, iab = 0, ibb = 0;
  for (let i = 0; i < s.length; i++) { const w = clip(s[i].top) * (1 - clip(s[i].top)); iaa += w * xs[i] * xs[i]; iab += w * xs[i]; ibb += w; }
  const k = shrink / s.length;
  const Paa = k * iaa, Pab = k * iab, Pbb = k * ibb + 1e-9;
  let a = 1, b = 0;
  for (let it = 0; it < 50; it++) {
    let ga = -(Paa * (a - 1) + Pab * b), gb = -(Pab * (a - 1) + Pbb * b), haa = Paa, hab = Pab, hbb = Pbb;
    for (let i = 0; i < xs.length; i++) {
      const q = sig(a * xs[i] + b), e = s[i].hit - q, w = Math.max(1e-9, q * (1 - q));
      ga += e * xs[i]; gb += e; haa += w * xs[i] * xs[i]; hab += w * xs[i]; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { a: 1, b: 0 };
  return { a: r4(Math.max(MIN_A, a)), b: r4(b) };
}

const hasLayer = (L: LayerFn | null | undefined): L is LayerFn => !!L && (L.kind === 'platt' ? Number.isFinite(L.a) : L.x.length > 0);

/** the iso layer's value for a top chance (0–1) */
export function applyIso(L: Pick<IsoLayer, 'x' | 'y'> | null | undefined, top: number): number {
  if (!L || !L.x.length || !Number.isFinite(top)) return top;
  const { x, y } = L;
  let v: number;
  if (top <= x[0]) v = top + (y[0] - x[0]);
  else if (top >= x[x.length - 1]) v = top + (y[y.length - 1] - x[x.length - 1]);
  else {
    let i = 1;
    while (x[i] < top) i++;
    const f = (top - x[i - 1]) / (x[i] - x[i - 1]);
    v = y[i - 1] + f * (y[i] - y[i - 1]);
  }
  return Math.min(0.99, Math.max(0.01, v));
}
/** either kind's value for a top chance (0–1) */
export function layerValue(L: LayerFn | null | undefined, top: number): number {
  if (!hasLayer(L) || !Number.isFinite(top)) return top;
  if (L.kind === 'platt') return Math.min(0.99, Math.max(0.01, sig(L.a! * logit(top) + (L.b ?? 0))));
  return applyIso(L, top);
}

/** the calibrated chances (2- or 3-way, any scale: returned on the same scale); the favourite stays the favourite */
export function calibrateP(L: LayerFn | null | undefined, pIn: number[]): number[] {
  if (!hasLayer(L)) return pIn;
  const scale = pIn.reduce((a, b) => a + b, 0) || 1;
  const p = pIn.map(v => v / scale);
  const k = p.indexOf(Math.max(...p));
  const t = p[k];
  if (!(t > 0 && t < 1)) return pIn;
  const second = Math.max(0, ...p.filter((_, i) => i !== k));
  let t2 = layerValue(L, t);
  const floor = second / (1 - t + second) + 1e-4; // the favourite stays on top
  if (t2 < floor) t2 = Math.min(t, floor);
  const rest = (1 - t2) / (1 - t);
  return p.map((v, i) => (i === k ? t2 : v * rest) * scale);
}
/** a 2-way chance (tennis: the first player's; basketball: the home side's) through the layer */
export const calibrate2 = (L: LayerFn | null | undefined, p1: number) => calibrateP(L, [p1, 1 - p1])[0];

const tops = (sel: CRow[]) => sel.map(r => { const q = norm(r.p); const k = topOf(q); return { top: q[k], hit: k === r.y ? 1 : 0 }; });
/** a fit on the rows in [from, to) (null with fewer than minFit) */
export function fitLayer(rows: CRow[], from: number, to: number, minFit = MIN_FIT, kind: LayerKind = 'iso'): IsoLayer | null {
  const sel = rows.filter(r => r.t >= from && r.t < to);
  if (sel.length < minFit) return null;
  const pts = tops(sel);
  const t0 = sel.reduce((m, r) => Math.min(m, r.t), Infinity);
  const first = new Date(Math.max(from, t0)).toISOString().slice(0, 10), last = new Date(to).toISOString().slice(0, 10);
  if (kind === 'platt') return { x: [], y: [], kind, ...fitPlattTop(pts), n: sel.length, from: first, to: last };
  return { ...fitIso(pts), kind, n: sel.length, from: first, to: last };
}

const asP3 = (p: number[]): P3 => (p.length === 2 ? [p[0], 0, p[1]] : norm(p));
/** a row as `L` shows it (P3; 2-way rows are [p1, 0, p2], y 0 or 2) */
const shown = (L: LayerFn | null, r: CRow): P3 => {
  const two = r.p[1] === 0;
  const q = two ? [r.p[0], r.p[2]] : [...r.p];
  return asP3(calibrateP(L, q));
};
const meanLL = (rows: CRow[], f: (r: CRow) => P3) => (rows.length ? r4(rows.reduce((s, r) => s + logLossOf(f(r), r.y), 0) / rows.length) : null);

/**
 * The kind for these fit rows, chosen on them alone: both kinds fitted on all but their last TEST_DAYS days and scored
 * on those days; fewer than MIN_FIT / MIN_TEST for that = Platt (two numbers: the safer one on a small sample).
 */
export function chooseKind(fitRows: CRow[], to: number): { kind: LayerKind; why: string } {
  const v0 = to - TEST_DAYS * DAY;
  const val = fitRows.filter(r => r.t >= v0 && r.t < to);
  const iso = fitLayer(fitRows, 0, v0, MIN_FIT, 'iso'), pl = fitLayer(fitRows, 0, v0, MIN_FIT, 'platt');
  if (!iso || !pl || val.length < MIN_TEST) return { kind: 'platt', why: 'too few games to compare the kinds: Platt' };
  const li = meanLL(val, r => shown(iso, r))!, lp = meanLL(val, r => shown(pl, r))!;
  return li < lp ? { kind: 'iso', why: `isotonic ${li} vs Platt ${lp} on the fit rows' last ${TEST_DAYS} days` } : { kind: 'platt', why: `Platt ${lp} vs isotonic ${li} on the fit rows' last ${TEST_DAYS} days` };
}

export interface Band { lo: number; hi: number; n: number; said: number | null; happened: number | null; cal: number | null }
export interface RecentDecision {
  decision: 'promote' | 'keep' | 'rollback' | 'held';
  reason: string; verdict: Verdict | null;
  mode: 'walk-forward' | 'cross-fit' | 'young';
  /** the layer to go live on 'promote' (walk-forward: the candidate that passed, fit before the test days; cross-fit: the fit on every settled game) */
  live: IsoLayer | null;
  /** the candidate (null = too few games to fit) and how its kind was chosen */
  candidate: IsoLayer | null; kindWhy: string | null;
  fit: { from: string; to: string; n: number };
  test: { from: string; to: string; n: number; diff: number; champion: number | null; candidate: number | null; none: number | null };
  guard: { games: number; current: number; none: number } | null;
  /** the test games by the chance shown now: said now (`said`), said by the candidate (`cal`, out of sample), happened */
  bands: Band[];
}

/** said vs happened per band on `rows`, banded by the chance `before` shows; `cal` = what `after` says for the same games */
export function bandTable(rows: CRow[], before: (r: CRow) => P3, after: ((r: CRow) => P3) | null, edges = [50, 60, 70, 80]): Band[] {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return edges.map((lo, i, a) => {
    const hi = a[i + 1] ?? 101;
    const sel = rows.filter(r => { const q = before(r); const t = q[topOf(q)] * 100; return t >= lo && t < hi; });
    const n = sel.length;
    const said = n ? r1((sel.reduce((s, r) => { const q = before(r); return s + q[topOf(q)]; }, 0) / n) * 100) : null;
    const happened = n ? r1((100 * sel.filter(r => topOf(before(r)) === r.y).length) / n) : null;
    const cal = n && after ? r1((sel.reduce((s, r) => { const q = after(r); return s + q[topOf(q)]; }, 0) / n) * 100) : null;
    return { lo, hi: Math.min(hi, 100), n, said, happened, cal };
  });
}

const sg = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;
/** fix251's bootstrap rule on one test set (the last 30 days, or every game out of fold); `on` names it */
export function judgeTest(W: { s: { n: number; diff: number; hitC: number; hitB: number }; d: number[] }, R = DAILY_RULES, seed = 270, minTest = MIN_TEST, on = `the last ${TEST_DAYS} days`): Verdict {
  if (W.s.n < minTest) return { pass: false, why: `${W.s.n} games in ${on} (< ${minTest})`, boot: null, gap: `needs ${minTest - W.s.n} more games` };
  if (W.s.diff >= 0) return { pass: false, why: `not better on ${on} (${sg(W.s.diff)})`, boot: null, gap: `${sg(W.s.diff)}: needs below 0` };
  if (W.s.diff > -R.minGain + 1e-12) return { pass: false, why: `gain too small on ${on} (${sg(W.s.diff)}, needs ≤ −${R.minGain})`, boot: null, gap: `${sg(W.s.diff)}: needs ≤ −${R.minGain}` };
  const boot = pairedBootstrap(W.d, R.resamples, seed);
  const hitDrop = Math.round((W.s.hitB - W.s.hitC) * 10) / 10;
  if (boot.pBetter < R.confidence) return { pass: false, why: `better but not sure enough: better in ${Math.round(boot.pBetter * 100)}% of resamples (needs ${Math.round(R.confidence * 100)}%)`, boot, gap: `${Math.round(boot.pBetter * 100)}% of the ${Math.round(R.confidence * 100)}% needed` };
  if (hitDrop > R.maxHitDrop) return { pass: false, why: `hit rate ${W.s.hitC}% vs ${W.s.hitB}% (down more than ${R.maxHitDrop} pp)`, boot, gap: `hit rate down ${hitDrop.toFixed(1)} pp (max ${R.maxHitDrop})` };
  return { pass: true, why: `${on} ${sg(W.s.diff)} per game over ${W.s.n} games, better in ${Math.round(boot.pBetter * 100)}% of resamples`, boot, gap: null };
}

export const CROSS_FOLDS = 5;
/**
 * fix270, a young sport (fewer than MIN_FIT games older than the test days — basketball / tennis saved their raw chance
 * only from 25 Oct): every game scored by a Platt fit on the other blocks of time (CROSS_FOLDS contiguous blocks), so
 * each game's number comes from a fit that never saw it. Returns the out-of-fold view of each row.
 */
export function crossFit(rows: CRow[], K = CROSS_FOLDS, kind: LayerKind = 'platt'): Map<CRow, P3> {
  const s = rows.slice().sort((a, b) => a.t - b.t);
  const out = new Map<CRow, P3>();
  for (let j = 0; j < K; j++) {
    const lo = Math.floor((j * s.length) / K), hi = Math.floor(((j + 1) * s.length) / K);
    const train = s.slice(0, lo).concat(s.slice(hi));
    // fix273: either kind (isotonic shrunk SHRINK games' worth per block; Platt with its ridge prior at the identity)
    const L: LayerFn | null = !train.length ? null : kind === 'iso' ? { ...fitIso(tops(train)), kind: 'iso' } : { x: [], y: [], kind: 'platt', ...fitPlattTop(tops(train)) };
    for (const r of s.slice(lo, hi)) out.set(r, shown(L, r));
  }
  return out;
}

/*
 * fix273 — a young sport (basketball, tennis: their raw chances are saved only since 25 Oct). fix270's bar (better in
 * 90% of 2,000 resamples, a gain of 0.0005, one promotion a week) kept the layer out while data health stayed red
 * (29 Oct: basketball 50–60% said 54.9 happened 46.9 on 64 games, 60–70% said 65.1 happened 59.3 on 81; tennis 60–70%
 * said 64.9 happened 75.8 on 95). While it has fewer than YOUNG_MAX settled games (YOUNG_MIN at least):
 *  - the kind is chosen out of fold: isotonic and Platt (both shrunk toward no change) each scored on every settled game
 *    by fits on the other time blocks; the one with the lower log loss is fitted on every settled game and goes live;
 *  - the lower bar: better on log loss overall AND in each half of the games (earlier / later: a gain carried by one
 *    stretch doesn't count), better in ≥ YOUNG_CONFIDENCE (75%) of the paired resamples, hit rate not down > 0.5 pp;
 *  - re-tested every night (one promotion a day, not a week); the rollback rule as before.
 */
export const YOUNG_MAX = 1000;
export const YOUNG_MIN = 150;
export const YOUNG_CONFIDENCE = 0.75;

/** fix273: the young-sport bar on the out-of-fold games (`view`) against what was shown (`champ`) */
export function judgeYoung(rows: CRow[], view: (r: CRow) => P3, champ: (r: CRow) => P3, R = DAILY_RULES, seed = 273, minTest = MIN_TEST): Verdict & { halves: [number, number] } {
  const s = rows.slice().sort((a, b) => a.t - b.t), h = Math.floor(s.length / 2);
  const pw = (sel: CRow[]) => paired(sel.map(r => ({ c: view(r), b: champ(r), y: r.y })));
  const all = pw(s), A = pw(s.slice(0, h)), B = pw(s.slice(h));
  const halves: [number, number] = [A.s.diff, B.s.diff];
  const on = 'every settled game, out of fold';
  if (all.s.n < minTest) return { pass: false, why: `${all.s.n} games (< ${minTest})`, boot: null, gap: `needs ${minTest - all.s.n} more games`, halves };
  if (all.s.diff >= 0) return { pass: false, why: `not better on ${on} (${sg(all.s.diff)})`, boot: null, gap: `${sg(all.s.diff)}: needs below 0`, halves };
  if (A.s.diff >= 0 || B.s.diff >= 0) return { pass: false, why: `not better in both halves (earlier ${sg(A.s.diff)}, later ${sg(B.s.diff)})`, boot: null, gap: 'needs both halves below 0', halves };
  const boot = pairedBootstrap(all.d, R.resamples, seed);
  const hitDrop = Math.round((all.s.hitB - all.s.hitC) * 10) / 10;
  if (boot.pBetter < YOUNG_CONFIDENCE) return { pass: false, why: `better but not sure enough: better in ${Math.round(boot.pBetter * 100)}% of resamples (needs ${Math.round(YOUNG_CONFIDENCE * 100)}%)`, boot, gap: `${Math.round(boot.pBetter * 100)}% of the ${Math.round(YOUNG_CONFIDENCE * 100)}% needed`, halves };
  if (hitDrop > R.maxHitDrop) return { pass: false, why: `hit rate ${all.s.hitC}% vs ${all.s.hitB}% (down more than ${R.maxHitDrop} pp)`, boot, gap: `hit rate down ${hitDrop.toFixed(1)} pp (max ${R.maxHitDrop})`, halves };
  return { pass: true, why: `${on} ${sg(all.s.diff)} per game over ${all.s.n} games (earlier half ${sg(A.s.diff)}, later ${sg(B.s.diff)}), better in ${Math.round(boot.pBetter * 100)}% of resamples`, boot, gap: null, halves };
}

/**
 * The nightly decision for one sport. `champion` = the live layer (null = none), `championSince` = when it went live,
 * `lastPromotion` = the date of the last promotion (YYYY-MM-DD). `edges` = the report's bands (football: from 0).
 *  - walk-forward (MIN_FIT+ games before the last 30 days): the candidate is fitted on them, tested on the 30 days,
 *    and is the layer that goes live;
 *  - cross-fit (fewer, but MIN_FIT+ settled games in all): tested out of fold on every game (crossFit); the layer that
 *    goes live is the Platt fit on all of them.
 */
export function decideRecent(rows: CRow[], champion: IsoLayer | null, championSince: string | null, lastPromotion: string | null, now = Date.now(), R = DAILY_RULES, seed = 270, edges = [50, 60, 70, 80], opts: { young?: boolean } = {}): RecentDecision {
  const day0 = Math.floor(now / DAY) * DAY;
  const T0 = day0 - TEST_DAYS * DAY;
  const d = (x: number) => new Date(x).toISOString().slice(0, 10);
  const settled = rows.filter(r => r.t < day0);
  const fitRows = settled.filter(r => r.t < T0);
  // fix273: a young sport (opts.young) with YOUNG_MIN–YOUNG_MAX settled games: the young rule (see judgeYoung)
  const young = !!opts.young && settled.length >= YOUNG_MIN && settled.length < YOUNG_MAX;
  const mode: RecentDecision['mode'] = young ? 'young' : fitRows.length < MIN_FIT && settled.length >= MIN_FIT ? 'cross-fit' : 'walk-forward';
  // the champion: the live layer, or with none live what was shown (the model's own, or basketball's season layer)
  const champ = (r: CRow): P3 => (champion ? shown(champion, r) : r.cur ?? shown(null, r));
  const firstOf = (sel: CRow[], dflt: number) => d(sel.length ? sel.reduce((m, r) => Math.min(m, r.t), Infinity) : dflt);

  let cand: IsoLayer | null, kindWhy: string | null, test: CRow[], view: ((r: CRow) => P3) | null, on: string;
  if (mode === 'young') {
    const oi = crossFit(settled, CROSS_FOLDS, 'iso'), op = crossFit(settled, CROSS_FOLDS, 'platt');
    const li = meanLL(settled, r => oi.get(r)!)!, lp = meanLL(settled, r => op.get(r)!)!;
    const kind: LayerKind = li < lp ? 'iso' : 'platt';
    cand = fitLayer(settled, 0, day0, YOUNG_MIN, kind);
    kindWhy = `young sport (${settled.length} settled games, under ${YOUNG_MAX}): ${kind === 'iso' ? `isotonic ${li} vs Platt ${lp}` : `Platt ${lp} vs isotonic ${li}`} out of fold (${CROSS_FOLDS} time blocks), fitted on every settled game`;
    const oof = kind === 'iso' ? oi : op;
    test = settled; view = r => oof.get(r)!; on = 'every settled game, out of fold';
  } else if (mode === 'cross-fit') {
    const oof = crossFit(settled);
    cand = fitLayer(settled, 0, day0, MIN_FIT, 'platt');
    kindWhy = `fewer than ${MIN_FIT} games before the last ${TEST_DAYS} days: Platt, each game tested by a fit on the other ${CROSS_FOLDS - 1} of ${CROSS_FOLDS} time blocks`;
    test = settled; view = r => oof.get(r)!; on = 'every settled game, out of fold';
  } else {
    const k = fitRows.length >= MIN_FIT ? chooseKind(fitRows, T0) : null;
    const c = k ? fitLayer(fitRows, 0, T0, MIN_FIT, k.kind) : null;
    cand = c; kindWhy = k?.why ?? null;
    test = settled.filter(r => r.t >= T0); view = c ? r => shown(c, r) : null; on = `the last ${TEST_DAYS} days`;
  }
  if (cand) cand.fitted = d(day0);
  const pw = paired(test.map(r => ({ c: view ? view(r) : null, b: champ(r), y: r.y })));
  const base = {
    mode, candidate: cand, kindWhy,
    fit: mode !== 'walk-forward' ? { from: firstOf(settled, day0), to: d(day0), n: settled.length } : { from: firstOf(fitRows, T0), to: d(T0), n: fitRows.length },
    test: { from: mode !== 'walk-forward' ? firstOf(settled, day0) : d(T0), to: d(day0), n: test.length, diff: pw.s.diff, champion: meanLL(test, champ), candidate: view ? meanLL(test, view) : null, none: meanLL(test, r => shown(null, r)) },
    bands: bandTable(test, champ, view, edges),
    live: null as IsoLayer | null
  };

  // guardrail first: a live layer that does worse than no layer on the games since it went live goes
  let guard: RecentDecision['guard'] = null;
  if (champion && championSince) {
    const since = Date.parse(`${championSince}T00:00:00Z`);
    const after = settled.filter(r => r.t >= since);
    if (after.length >= R.guardGames) {
      const cur = meanLL(after, r => shown(champion, r))!, none = meanLL(after, r => shown(null, r))!;
      guard = { games: after.length, current: cur, none };
      if (cur - none > R.guardWorse) return { ...base, decision: 'rollback', reason: `Rollback: since ${championSince} the layer scored ${cur} vs ${none} without it (${after.length} games, worse by ${(cur - none).toFixed(4)} > ${R.guardWorse}).`, verdict: null, guard };
    }
  }
  if (!cand) return { ...base, decision: 'keep', reason: `No change: ${settled.length} settled games (${MIN_FIT} needed to fit).`, verdict: null, guard };
  const v = mode === 'young' && view ? judgeYoung(test, view, champ, R, seed) : judgeTest(pw, R, seed, MIN_TEST, on);
  if (!v.pass) return { ...base, decision: 'keep', reason: `No change: ${v.why}.`, verdict: v, guard };
  // fix273: a young sport is re-tested and may move every night
  const wait = promotionWait(lastPromotion, d(day0), mode === 'young' ? { ...R, minDaysBetween: 1 } : R);
  if (wait > 0) return { ...base, decision: 'held', reason: `No change: a new layer passed (${v.why}), but the last promotion was on ${lastPromotion} — at most one in ${R.minDaysBetween} days (${wait} day(s) to go).`, verdict: v, guard };
  const kindName = cand.kind === 'platt' ? `Platt a ${cand.a}, b ${cand.b}` : `isotonic, ${cand.x.length} knots`;
  return { ...base, live: cand, decision: 'promote', reason: `New layer (${kindName}; fit ${cand.from} → ${cand.to}, ${cand.n} games): ${v.why}.`, verdict: v, guard };
}


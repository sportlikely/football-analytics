/**
 * fix254 — the recent calibration layer (football, tennis), pure: no database. services/recentCalib.ts runs it nightly.
 *
 * Data health failed on 28 Oct: football 50–60% said 54%, happened 59.8% (326 games); tennis 60–70% said 64.9%,
 * happened 74% (77 games) — the live models were less sure than they turned out to be. The season layers (tennis:
 * fix222's Platt on past seasons; football: none) can't see a drift inside the live season.
 *
 *  - Isotonic regression (pool adjacent violators) of "the pick was right" on the pick's chance (the top chance of the
 *    2 or 3 results), each block shrunk toward its own mean chance (SHRINK games' worth): a small block barely moves.
 *    Between the blocks: straight lines; outside them: the nearest block's shift. Monotone: a surer pick stays surer.
 *  - Applied to the top chance only; the other results share the rest in their old proportion. The favourite never
 *    changes (the top chance is held above the second's new value) — Yarin's model principle.
 *  - Walk-forward: the last 60 days (W) and the 60 before (Wp) are each calibrated by a fit on the FIT_DAYS before the
 *    window's start only; the live fit uses the FIT_DAYS before today. Every row's chance is the one before this layer
 *    (p_pre saved with the prediction; older rows: the shown chance, there was no layer then).
 *  - Promotion: the football daily job's rules (utils/dailyRules.ts): 300+ games in each window, log loss better in
 *    both, gain ≥ 0.0005 per game in the last window, better in ≥ 90% of 2,000 paired bootstrap resamples, hit rate not
 *    down by > 0.5 pp, at most one promotion in 7 days. Guardrail: a live layer worse than none by > 0.005 on the 100+
 *    games since it went live goes (any day).
 */
import { DAILY_RULES, paired, preJudge, finishJudge, pairedBootstrap, promotionWait, logLossOf, type P3, type Verdict } from './dailyRules';

export const FIT_DAYS = 180;
export const MIN_FIT = 300;
export const SHRINK = 30;
const DAY = 86400000;

export interface IsoLayer { x: number[]; y: number[]; n: number; from: string; to: string }
export interface CRow { p: P3; y: number; t: number }

const norm = (p: number[]): P3 => { const s = p[0] + p[1] + p[2] || 1; return [p[0] / s, p[1] / s, p[2] / s]; };
const topOf = (p: P3) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

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

/** the layer's value for a top chance (0–1) */
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

/** the calibrated chances (2- or 3-way, any scale: returned on the same scale); the favourite stays the favourite */
export function calibrateP(L: Pick<IsoLayer, 'x' | 'y'> | null | undefined, pIn: number[]): number[] {
  if (!L || !L.x.length) return pIn;
  const scale = pIn.reduce((a, b) => a + b, 0) || 1;
  const p = pIn.map(v => v / scale);
  const k = p.indexOf(Math.max(...p));
  const t = p[k];
  if (!(t > 0 && t < 1)) return pIn;
  const second = Math.max(0, ...p.filter((_, i) => i !== k));
  let t2 = applyIso(L, t);
  const floor = second / (1 - t + second) + 1e-4; // the favourite stays on top
  if (t2 < floor) t2 = Math.min(t, floor);
  const rest = (1 - t2) / (1 - t);
  return p.map((v, i) => (i === k ? t2 : v * rest) * scale);
}
/** a 2-way chance (tennis: the first player's) through the layer */
export const calibrate2 = (L: Pick<IsoLayer, 'x' | 'y'> | null | undefined, p1: number) => calibrateP(L, [p1, 1 - p1])[0];

/** a fit on these rows (null with fewer than MIN_FIT) */
export function fitLayer(rows: CRow[], from: number, to: number, minFit = MIN_FIT): IsoLayer | null {
  const sel = rows.filter(r => r.t >= from && r.t < to);
  if (sel.length < minFit) return null;
  const f = fitIso(sel.map(r => { const q = norm(r.p); const k = topOf(q); return { top: q[k], hit: k === r.y ? 1 : 0 }; }));
  return { ...f, n: sel.length, from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) };
}

const asP3 = (p: number[]): P3 => (p.length === 2 ? [p[0], 0, p[1]] : norm(p));
/** a row as `L` shows it (P3; 2-way rows are [p1, 0, p2], y 0 or 2) */
const shown = (L: Pick<IsoLayer, 'x' | 'y'> | null, r: CRow): P3 => {
  const two = r.p[1] === 0;
  const q = two ? [r.p[0], r.p[2]] : [...r.p];
  return asP3(calibrateP(L, q));
};

export interface RecentDecision {
  decision: 'promote' | 'keep' | 'rollback' | 'held';
  reason: string; verdict: Verdict | null; live: IsoLayer | null;
  windows: { W: { from: string; to: string; n: number; diff: number; champion: number | null; candidate: number | null }; Wp: { from: string; to: string; n: number; diff: number; champion: number | null; candidate: number | null } };
  guard: { games: number; current: number; none: number } | null;
  bands: { lo: number; hi: number; n: number; said: number | null; happened: number | null; cal: number | null }[];
}

const meanLL = (rows: CRow[], f: (r: CRow) => P3) => (rows.length ? r4(rows.reduce((s, r) => s + logLossOf(f(r), r.y), 0) / rows.length) : null);

/**
 * The nightly decision for one sport. `champion` = the live layer (null = none), `championSince` = when it went live,
 * `lastPromotion` = the date of the last promotion (YYYY-MM-DD).
 */
export function decideRecent(rows: CRow[], champion: IsoLayer | null, championSince: string | null, lastPromotion: string | null, now = Date.now(), R = DAILY_RULES, seed = 254): RecentDecision {
  const day0 = Math.floor(now / DAY) * DAY;
  const W0 = day0 - R.windowDays * DAY, Wp0 = W0 - R.windowDays * DAY;
  const inW = rows.filter(r => r.t >= W0 && r.t < day0), inWp = rows.filter(r => r.t >= Wp0 && r.t < W0);
  const fW = fitLayer(rows, W0 - FIT_DAYS * DAY, W0), fWp = fitLayer(rows, Wp0 - FIT_DAYS * DAY, Wp0);
  const pw = paired(inW.map(r => ({ c: fW ? shown(fW, r) : null, b: shown(champion, r), y: r.y })));
  const pwp = paired(inWp.map(r => ({ c: fWp ? shown(fWp, r) : null, b: shown(champion, r), y: r.y })));
  const live = fitLayer(rows, day0 - FIT_DAYS * DAY, day0);
  const d = (x: Date | number) => new Date(x).toISOString().slice(0, 10);
  const windows = {
    W: { from: d(W0), to: d(day0), n: pw.s.n, diff: pw.s.diff, champion: meanLL(inW, r => shown(champion, r)), candidate: fW ? meanLL(inW, r => shown(fW, r)) : null },
    Wp: { from: d(Wp0), to: d(W0), n: pwp.s.n, diff: pwp.s.diff, champion: meanLL(inWp, r => shown(champion, r)), candidate: fWp ? meanLL(inWp, r => shown(fWp, r)) : null }
  };
  // said vs happened in the last 60 days: as shown by the champion, and by the walk-forward candidate
  const bands = [50, 60, 70, 80].map((lo, i, a) => {
    const hi = a[i + 1] ?? 101;
    const sel = inW.filter(r => { const q = shown(champion, r); return q[topOf(q)] * 100 >= lo && q[topOf(q)] * 100 < hi; });
    const n = sel.length;
    const said = n ? Math.round(sel.reduce((s, r) => { const q = shown(champion, r); return s + q[topOf(q)]; }, 0) / n * 1000) / 10 : null;
    const happened = n ? Math.round((1000 * sel.filter(r => topOf(shown(champion, r)) === r.y).length) / n) / 10 : null;
    const cal = n && fW ? Math.round(sel.reduce((s, r) => { const q = shown(fW, r); return s + q[topOf(q)]; }, 0) / n * 1000) / 10 : null;
    return { lo, hi: Math.min(hi, 100), n, said, happened, cal };
  });
  const base = { windows, bands, live };

  // guardrail first: a live layer that does worse than no layer on the games since it went live goes
  let guard: RecentDecision['guard'] = null;
  if (champion && championSince) {
    const since = Date.parse(`${championSince}T00:00:00Z`);
    const after = rows.filter(r => r.t >= since && r.t < day0);
    if (after.length >= R.guardGames) {
      const cur = meanLL(after, r => shown(champion, r))!, none = meanLL(after, r => shown(null, r))!;
      guard = { games: after.length, current: cur, none };
      if (cur - none > R.guardWorse) return { ...base, decision: 'rollback', reason: `Rollback: since ${championSince} the layer scored ${cur} vs ${none} without it (${after.length} games, worse by ${(cur - none).toFixed(4)} > ${R.guardWorse}).`, verdict: null, live: null, guard };
    }
  }
  if (!fW || !fWp) return { ...base, decision: 'keep', reason: `No change: fewer than ${MIN_FIT} games to fit on before ${!fWp ? 'the previous' : 'the last'} 60 days.`, verdict: null, guard };
  if (!live) return { ...base, decision: 'keep', reason: `No change: fewer than ${MIN_FIT} games in the last ${FIT_DAYS} days.`, verdict: null, guard };
  const v = preJudge(pw, pwp, R) || finishJudge(pw, pwp, pairedBootstrap([...pw.d, ...pwp.d], R.resamples, seed), R);
  if (!v.pass) return { ...base, decision: 'keep', reason: `No change: ${v.why}.`, verdict: v, guard };
  const wait = promotionWait(lastPromotion, d(day0), R);
  if (wait > 0) return { ...base, decision: 'held', reason: `No change: a new layer passed (${v.why}), but the last promotion was on ${lastPromotion} — at most one in ${R.minDaysBetween} days (${wait} day(s) to go).`, verdict: v, guard };
  return { ...base, decision: 'promote', reason: `New layer (fit ${live.from} → ${live.to}, ${live.n} games): ${v.why}.`, verdict: v, guard };
}

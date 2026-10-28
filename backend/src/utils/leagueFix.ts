/**
 * fix255: leagues under 52% on 1X2 — the test and the per-league layer, pure (no database). The service is
 * services/leagueFix.ts (worker job, admin card, live settings).
 *
 * Input: the games of the public record (one row per game, the main model's saved pre-kick-off numbers, the stored
 * market prices, the result) and, per league, the results of the last 2 seasons + this one (history base rates).
 * Every candidate is walk-forward: a game's settings come only from games settled before its kick-off (kick-off + 3 h)
 * and from history before its date. The result of the game itself is never used.
 *
 * Candidates (each against the saved numbers):
 *   home        per-league home advantage: the home / away split moved so the league's average matches its base rates
 *               (history: 2 seasons + this one), shrunk toward the group's value (k = 60 games)
 *   draw        per-league draw-rate prior: the draw share moved the same way
 *   calib       home + draw together
 *   close       close games (|home − away| < y) shrunk toward the league's base rates by s; y, s chosen per group
 *   anchor      market anchor (fix251), weight 0.1–0.4 chosen per group; prices are never shown
 *   calib+anchor
 * Pick rules (hit rate only, log loss unchanged): "pick the draw when P(draw) ≥ max(P(H), P(A)) − x" (x per group), and
 * the double-chance side instead of the most likely outcome.
 * A league with < 60 games in the window uses its group's settings (rule e). A change passes for a league / group
 * only when its log loss is better in both halves of the window (first 45 / last 45 days), better in ≥ 90% of 2,000
 * paired bootstrap resamples (fix251's rules) and its hit rate is not down by more than 0.5 pp.
 */
import { pairedBootstrap, type Boot } from './dailyRules';

export type P3 = [number, number, number];
export type LGroup = 'big5' | 'second' | 'europe' | 'americas' | 'asia' | 'nordic' | 'cups';
export const GROUP_NAMES: Record<LGroup, string> = {
  big5: 'Big 5', second: 'Second tiers', europe: 'Other European top flights', americas: 'Americas', asia: 'Asia',
  nordic: 'Nordic', cups: 'Cups & national teams'
};
export type Cand = 'home' | 'draw' | 'calib' | 'close' | 'anchor' | 'calib+anchor';
export const CANDS: Cand[] = ['home', 'draw', 'calib', 'close', 'anchor', 'calib+anchor'];
export const CAND_LABEL: Record<Cand, string> = {
  home: 'own home advantage', draw: 'own draw rate', calib: 'own home advantage + draw rate', close: 'close games toward base rates',
  anchor: 'market anchor', 'calib+anchor': 'home advantage + draw rate + market anchor'
};

export const LF_RULES = {
  windowDays: 90, halfDays: 45, minReport: 20, minOwn: 60, under: 52, warnUnder: 50, warnDays: 30,
  settleMs: 3 * 3600 * 1000, shrinkK: 60, minLeaguePrior: 20, minGroupPrior: 50, minChoose: 30, histMin: 50, prior: 30,
  clampH: 0.6, clampD: 0.4,
  resamples: 2000, confidence: 0.9, maxHitDrop: 0.5, minGain: 1e-5,
  drawX: [0, 0.02, 0.04, 0.06, 0.08, 0.1],
  close: [[0, 0], [0.05, 0.2], [0.05, 0.4], [0.1, 0.2], [0.1, 0.4], [0.15, 0.2], [0.15, 0.4]] as [number, number][],
  anchors: [0, 0.1, 0.2, 0.3, 0.4],
  // causes in the report
  drawGap: 0.2, homeBias: 1.8, marketGap: 0.02
};
const DEFAULT_BASE: P3 = [0.45, 0.26, 0.29];

/* ---------- groups ---------- */

const FIXED: Record<string, LGroup> = {
  PL: 'big5', PD: 'big5', SA: 'big5', BL1: 'big5', FL1: 'big5',
  ELC: 'second', AF41: 'second', AF42: 'second', AF79: 'second', AF141: 'second', AF136: 'second', AF62: 'second', AF180: 'second',
  DED: 'europe', PPL: 'europe', AF144: 'europe', AF203: 'europe', AF179: 'europe', AF197: 'europe', AF106: 'europe',
  AF71: 'americas', AF128: 'americas', AF253: 'americas', AF262: 'americas',
  AF98: 'asia', AF119: 'nordic', AF103: 'nordic', AF113: 'nordic',
  CL: 'cups', EC: 'cups', WC: 'cups'
};
const CUP_RE = /\b(cup|copa|coupe|pokal|coppa|ta[cç]a|beker|trophy|shield|super ?cup|supercopa|nations|qualif|friendl|champions league|europa|conference|libertadores|sudamericana|world|euro\b|afc|caf\b|concacaf|uefa|fifa|play-?offs?)\b/i;
const SECOND_RE = /(championship|league (one|two)|serie b|segunda|laliga ?2|liga 2|ligue 2|2\. bundesliga|challenger|eerste divisie|1\. lig|superettan|obos|1\. division|first division|national league|liga de expansi|primera b|b nacional|j2|k league 2|2\. liga|prva liga|ykk[oö]nen)/i;
const AMERICAS = new Set(['usa', 'mexico', 'brazil', 'argentina', 'colombia', 'chile', 'peru', 'uruguay', 'paraguay', 'ecuador', 'bolivia', 'venezuela', 'canada', 'costa-rica', 'costa rica', 'honduras', 'guatemala', 'el-salvador', 'panama', 'jamaica']);
const ASIA = new Set(['japan', 'china', 'qatar', 'saudi-arabia', 'saudi arabia', 'south-korea', 'korea', 'korea-republic', 'australia', 'united-arab-emirates', 'uae', 'iran', 'india', 'thailand', 'vietnam', 'indonesia', 'malaysia', 'uzbekistan', 'kuwait', 'bahrain', 'oman', 'jordan', 'iraq']);
const NORDIC = new Set(['denmark', 'norway', 'sweden', 'finland', 'iceland', 'faroe-islands']);

/** the league group of a competition (code, name, country of an admin-added league when known) */
export function groupOf(code: string, name?: string | null, country?: string | null): LGroup {
  if (FIXED[code]) return FIXED[code];
  const n = name || '';
  if (CUP_RE.test(n)) return 'cups';
  if (SECOND_RE.test(n)) return 'second';
  const c = (country || '').toLowerCase();
  if (c === 'world') return 'cups';
  if (AMERICAS.has(c)) return 'americas';
  if (ASIA.has(c)) return 'asia';
  if (NORDIC.has(c)) return 'nordic';
  return 'europe';
}

/* ---------- probabilities ---------- */

export const norm = (p: number[]): P3 => { const s = p[0] + p[1] + p[2] || 1; return [p[0] / s, p[1] / s, p[2] / s]; };
export const ll = (p: P3, y: number) => -Math.log(Math.max(1e-6, norm(p)[y]));
export const argmax = (p: P3) => (p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1);
const clamp = (x: number, a: number) => Math.max(-a, Math.min(a, x));

/** home advantage h and draw shift d on a split: p' ∝ (pH·e^(h/2), pD·e^d, pA·e^(−h/2)) */
export const shift = (p: P3, h: number, d: number): P3 => norm([p[0] * Math.exp(h / 2), p[1] * Math.exp(d), p[2] * Math.exp(-h / 2)]);
/**
 * The (h, d) that move the average prediction M to the target rates T (first order, exact for one game):
 *   h = log(T_H / T_A) − log(M_H / M_A),   d = log(T_D / √(T_H·T_A)) − log(M_D / √(M_H·M_A))
 */
export function fitShift(T: P3, M: P3): { h: number; d: number } {
  const L = (x: number) => Math.log(Math.max(1e-6, x));
  return {
    h: L(T[0]) - L(T[2]) - (L(M[0]) - L(M[2])),
    d: L(T[1]) - 0.5 * (L(T[0]) + L(T[2])) - (L(M[1]) - 0.5 * (L(M[0]) + L(M[2])))
  };
}
/** shrink a league's own value toward the group's: λ = n / (n + k) */
export const shrink = (own: number, group: number, n: number, k = LF_RULES.shrinkK) => (n / (n + k)) * own + (k / (n + k)) * group;
/** close games (|H − A| < y) moved toward the league's base rates by s */
export const closeShrink = (p: P3, base: P3, y: number, s: number): P3 => {
  const q = norm(p);
  return y > 0 && s > 0 && Math.abs(q[0] - q[2]) < y ? norm([0, 1, 2].map(i => (1 - s) * q[i] + s * base[i])) : q;
};
export const anchor = (p: P3, mkt: P3 | null, a: number): P3 => (mkt && a > 0 ? norm([0, 1, 2].map(i => (1 - a) * norm(p)[i] + a * norm(mkt)[i])) : norm(p));
/** the draw-pick rule: the draw when P(draw) ≥ max(P(H), P(A)) − x, else the most likely of home / away (or the draw when it leads) */
export const drawRulePick = (p: P3, x: number) => (p[1] >= Math.max(p[0], p[2]) - x ? 1 : argmax(p));
/** the double-chance side: the result of the two most likely that is not the draw (home / away), the draw only when both sides tie below it */
export const dcSidePick = (p: P3) => (p[0] >= p[2] ? 0 : 2);

/** settings of one league, as applied live */
export interface LeagueSetting { cand: Cand; h: number; d: number; base: P3; close: [number, number]; anchor: number; unit: 'league' | 'group' }
/** the live layer: saved numbers (fractions) → shown numbers; `mkt` = margin-free market split or null */
export function applySetting(p: P3, mkt: P3 | null, s: LeagueSetting): P3 {
  const q = norm(p);
  switch (s.cand) {
    case 'home': return shift(q, s.h, 0);
    case 'draw': return shift(q, 0, s.d);
    case 'calib': return shift(q, s.h, s.d);
    case 'close': return closeShrink(q, s.base, s.close[0], s.close[1]);
    case 'anchor': return anchor(q, mkt, s.anchor);
    case 'calib+anchor': return anchor(shift(q, s.h, s.d), mkt, s.anchor);
  }
}

/* ---------- walk-forward ---------- */

export interface Row { id: number; comp: string; name: string; group: LGroup; t: number; p: P3; mkt: P3 | null; y: number }
/** results history per competition: kick-off times (sorted) and cumulative H / D / A counts (`c[i]` = counts of the first i games) */
export interface Hist { t: number[]; c: P3[] }
export function makeHist(games: { t: number; y: number }[]): Hist {
  const s = games.slice().sort((a, b) => a.t - b.t);
  const c: P3[] = [[0, 0, 0]];
  for (const g of s) { const l = c[c.length - 1]; const n: P3 = [l[0], l[1], l[2]]; n[g.y]++; c.push(n); }
  return { t: s.map(g => g.t), c };
}
/** history counts before time t */
export function histBefore(h: Hist | undefined, t: number): P3 | null {
  if (!h || !h.t.length) return null;
  let lo = 0, hi = h.t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (h.t[m] < t) lo = m + 1; else hi = m; }
  return h.c[lo];
}

/** per-row walk-forward output */
export interface WRow extends Row {
  own: boolean;                 // the league has ≥ minOwn games in the window (own settings) — else the group's
  h: number; d: number; base: P3;
  closeYS: [number, number]; a: number; aCalib: number; x: number;
  probs: Record<Cand | 'base', P3>;
  pickDraw: number; pickDc: number;
}

interface Acc { n: number; sp: [number, number, number]; cnt: [number, number, number] }
const acc = (): Acc => ({ n: 0, sp: [0, 0, 0], cnt: [0, 0, 0] });
const addAcc = (a: Acc, r: Row) => { const q = norm(r.p); a.n++; for (let i = 0; i < 3; i++) a.sp[i] += q[i]; a.cnt[r.y]++; };
const meanOf = (a: Acc): P3 => [a.sp[0] / a.n, a.sp[1] / a.n, a.sp[2] / a.n];

/** grid choice per group from the rows settled so far: running loss sums per grid value */
class GridChooser {
  private sums = new Map<string, { n: number; s: number[] }>();
  constructor(private size: number) {}
  add(key: string, losses: number[] | null) {
    if (!losses) return;
    let e = this.sums.get(key);
    if (!e) this.sums.set(key, (e = { n: 0, s: new Array(this.size).fill(0) }));
    e.n++;
    for (let i = 0; i < this.size; i++) e.s[i] += losses[i];
  }
  /** index of the lowest sum (ties: the lower index = the milder setting); 0 until minChoose rows */
  pick(key: string): number {
    const e = this.sums.get(key);
    if (!e || e.n < LF_RULES.minChoose) return 0;
    let b = 0;
    for (let i = 1; i < this.size; i++) if (e.s[i] < e.s[b] - 1e-12) b = i;
    return b;
  }
}

/**
 * Walk forward over every row (sorted by kick-off; rows before the window only feed the fits). `ownComps` = leagues with
 * ≥ minOwn games in the window. Returns one WRow per row in [from, to).
 */
export function walkForward(rowsIn: Row[], hist: Map<string, Hist>, ownComps: Set<string>, from: number, to: number, R = LF_RULES): WRow[] {
  const rows = rowsIn.slice().sort((a, b) => a.t - b.t || a.id - b.id);
  const lg = new Map<string, Acc>(), gr = new Map<string, Acc>();
  const closeCh = new GridChooser(R.close.length), ancCh = new GridChooser(R.anchors.length), ancCalibCh = new GridChooser(R.anchors.length), drawCh = new GridChooser(R.drawX.length);
  const pre: { close: number[]; anc: number[] | null; ancC: number[] | null; draw: number[] }[] = [];
  const out: WRow[] = [];
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // settle every game finished before this kick-off
    while (j < i && rows[j].t + R.settleMs <= r.t) {
      const s = rows[j];
      if (!lg.has(s.comp)) lg.set(s.comp, acc());
      if (!gr.has(s.group)) gr.set(s.group, acc());
      addAcc(lg.get(s.comp)!, s); addAcc(gr.get(s.group)!, s);
      const pp = pre[j];
      closeCh.add(s.group, pp.close); ancCh.add(s.group, pp.anc); ancCalibCh.add(s.group, pp.ancC); drawCh.add(s.group, pp.draw);
      j++;
    }
    const G = gr.get(r.group), L = lg.get(r.comp);
    const gBase: P3 = G && G.n >= R.minGroupPrior ? norm(G.cnt) : DEFAULT_BASE;
    // the league's base rates: history (2 seasons + this one) before the game, else the record so far, with a group prior
    const hc = histBefore(hist.get(r.comp), r.t);
    const hn = hc ? hc[0] + hc[1] + hc[2] : 0;
    const cnt: P3 = hc && hn >= R.histMin ? hc : L ? L.cnt : [0, 0, 0];
    const cn = cnt[0] + cnt[1] + cnt[2];
    const base = norm([0, 1, 2].map(k => cnt[k] + R.prior * gBase[k]));
    // group shift: the group's record so far (outcomes vs average prediction)
    const gs = G && G.n >= R.minGroupPrior ? fitShift(norm([0, 1, 2].map(k => G.cnt[k] + R.prior * DEFAULT_BASE[k])), meanOf(G)) : { h: 0, d: 0 };
    const own = ownComps.has(r.comp);
    let h = gs.h, d = gs.d;
    if (own && L && L.n >= R.minLeaguePrior && cn > 0) {
      const ls = fitShift(base, meanOf(L));
      h = shrink(ls.h, gs.h, L.n); d = shrink(ls.d, gs.d, L.n);
    }
    h = clamp(h, R.clampH); d = clamp(d, R.clampD);
    // grid choices from the group's settled rows
    const ci = closeCh.pick(r.group), ai = ancCh.pick(r.group), aci = ancCalibCh.pick(r.group), xi = drawCh.pick(r.group);
    const closeYS = R.close[ci], a = R.anchors[ai], aCalib = R.anchors[aci], x = R.drawX[xi];
    const q = norm(r.p);
    const calib = shift(q, h, d);
    const probs: WRow['probs'] = {
      base: q, home: shift(q, h, 0), draw: shift(q, 0, d), calib,
      close: closeShrink(q, base, closeYS[0], closeYS[1]), anchor: anchor(q, r.mkt, a), 'calib+anchor': anchor(calib, r.mkt, aCalib)
    };
    // this row's losses for every grid value (used once it is settled, for later games)
    pre.push({
      close: R.close.map(([y, s]) => ll(closeShrink(q, base, y, s), r.y)),
      anc: r.mkt ? R.anchors.map(v => ll(anchor(q, r.mkt, v), r.y)) : null,
      ancC: r.mkt ? R.anchors.map(v => ll(anchor(calib, r.mkt, v), r.y)) : null,
      draw: R.drawX.map(v => (drawRulePick(q, v) === r.y ? 0 : 1))
    });
    const w: WRow = { ...r, own, h, d, base, closeYS, a, aCalib, x, probs, pickDraw: drawRulePick(q, x), pickDc: dcSidePick(q) };
    if (r.t >= from && r.t < to) out.push(w);
  }
  return out;
}

/* ---------- the verdict ---------- */

export interface CandResult {
  cand: Cand | 'pick-draw' | 'pick-dc'; n: number; dAll: number; d1: number; d2: number;
  hitBase: number; hitCand: number; boot: Boot | null; pass: boolean; why: string;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const r1 = (x: number) => Math.round(x * 10) / 10;
const pctHit = (rows: WRow[], f: (w: WRow) => number) => (rows.length ? r1((100 * rows.filter(w => f(w) === w.y).length) / rows.length) : 0);

/** one candidate on a set of games: both halves better, ≥ 90% of resamples, hit rate not down by more than 0.5 pp */
export function judgeCand(rows: WRow[], cand: Cand, mid: number, R = LF_RULES, seed = 255): CandResult {
  const d = rows.map(w => ll(w.probs[cand], w.y) - ll(w.probs.base, w.y));
  const d1 = d.filter((_, i) => rows[i].t < mid), d2 = d.filter((_, i) => rows[i].t >= mid);
  const hitBase = pctHit(rows, w => argmax(w.probs.base)), hitCand = pctHit(rows, w => argmax(w.probs[cand]));
  const res: CandResult = { cand, n: rows.length, dAll: r5(mean(d)), d1: r5(mean(d1)), d2: r5(mean(d2)), hitBase, hitCand, boot: null, pass: false, why: '' };
  if (!d1.length || !d2.length) return { ...res, why: 'games in one half only' };
  // a real gain in each half (an unchanged candidate differs from the saved numbers by float noise only)
  if (mean(d1) > -R.minGain || mean(d2) > -R.minGain) return { ...res, why: `not better in both halves (${res.d1 >= 0 ? '+' : ''}${res.d1.toFixed(4)} / ${res.d2 >= 0 ? '+' : ''}${res.d2.toFixed(4)})` };
  const boot = pairedBootstrap(d, R.resamples, seed);
  res.boot = boot;
  if (boot.pBetter < R.confidence) return { ...res, why: `better in both halves but only in ${Math.round(boot.pBetter * 100)}% of resamples (needs ${Math.round(R.confidence * 100)}%)` };
  if (hitBase - hitCand > R.maxHitDrop) return { ...res, why: `hit rate down ${r1(hitBase - hitCand)} pp` };
  return { ...res, pass: true, why: `better in both halves, ${Math.round(boot.pBetter * 100)}% of resamples` };
}
/** a pick rule (hit rate only): more hits in both halves and in ≥ 90% of resamples of the per-game hit differences */
export function judgePick(rows: WRow[], which: 'pick-draw' | 'pick-dc', mid: number, R = LF_RULES, seed = 255): CandResult {
  const f = (w: WRow) => (which === 'pick-draw' ? w.pickDraw : w.pickDc);
  const d = rows.map(w => (argmax(w.probs.base) === w.y ? 1 : 0) - (f(w) === w.y ? 1 : 0)); // negative = the rule hits more
  const d1 = d.filter((_, i) => rows[i].t < mid), d2 = d.filter((_, i) => rows[i].t >= mid);
  const res: CandResult = { cand: which, n: rows.length, dAll: 0, d1: 0, d2: 0, hitBase: pctHit(rows, w => argmax(w.probs.base)), hitCand: pctHit(rows, f), boot: null, pass: false, why: '' };
  if (!d1.length || !d2.length) return { ...res, why: 'games in one half only' };
  if (mean(d1) >= 0 || mean(d2) >= 0) return { ...res, why: `not more hits in both halves (${r1(-100 * mean(d1))} / ${r1(-100 * mean(d2))} pp)` };
  const boot = pairedBootstrap(d, R.resamples, seed);
  res.boot = boot;
  if (boot.pBetter < R.confidence) return { ...res, why: `more hits in both halves but only in ${Math.round(boot.pBetter * 100)}% of resamples` };
  return { ...res, pass: true, why: `more hits in both halves, ${Math.round(boot.pBetter * 100)}% of resamples` };
}
/** every candidate on a unit; `best` = the passing one with the lowest log loss */
export function judgeUnit(rows: WRow[], mid: number, R = LF_RULES) {
  const results = CANDS.map(c => judgeCand(rows, c, mid, R));
  const picks = [judgePick(rows, 'pick-draw', mid, R), judgePick(rows, 'pick-dc', mid, R)];
  const best = results.filter(x => x.pass).sort((a, b) => a.dAll - b.dAll)[0] || null;
  return { results, picks, best: best ? (best.cand as Cand) : null };
}

/* ---------- report numbers ---------- */

export interface LeagueStats {
  comp: string; name: string; group: LGroup; n: number; hit: number; logLoss: number; brier: number;
  marketN: number; marketLogLoss: number | null; oursOnMarket: number | null; marketBrier: number | null;
  outcomes: P3; picks: P3; homeBias: number | null; drawGap: number; causes: string[];
}
export function leagueStats(rows: { comp: string; name: string; group: LGroup; p: P3; mkt: P3 | null; y: number }[], R = LF_RULES): LeagueStats {
  const n = rows.length;
  const o: P3 = [0, 0, 0], pk: P3 = [0, 0, 0];
  let hit = 0, lls = 0, br = 0, mN = 0, mll = 0, oll = 0, mbr = 0;
  for (const r of rows) {
    const q = norm(r.p), a = argmax(q);
    o[r.y]++; pk[a]++;
    if (a === r.y) hit++;
    lls += ll(q, r.y);
    br += q.reduce((s, v, i) => s + (v - (i === r.y ? 1 : 0)) ** 2, 0);
    if (r.mkt) { mN++; mll += ll(r.mkt, r.y); oll += ll(q, r.y); mbr += norm(r.mkt).reduce((s, v, i) => s + (v - (i === r.y ? 1 : 0)) ** 2, 0); }
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const homeBias = o[0] ? Math.round((pk[0] / o[0]) * 100) / 100 : null;
  const drawGap = n ? Math.round(((o[1] - pk[1]) / n) * 1000) / 1000 : 0;
  const s: LeagueStats = {
    comp: rows[0]?.comp || '', name: rows[0]?.name || '', group: rows[0]?.group || 'europe', n,
    hit: n ? r1((100 * hit) / n) : 0, logLoss: n ? r3(lls / n) : 0, brier: n ? r3(br / n) : 0,
    marketN: mN, marketLogLoss: mN ? r3(mll / mN) : null, oursOnMarket: mN ? r3(oll / mN) : null, marketBrier: mN ? r3(mbr / mN) : null,
    outcomes: o, picks: pk, homeBias, drawGap, causes: []
  };
  if (drawGap >= R.drawGap) s.causes.push('draws');
  if (homeBias != null && homeBias >= R.homeBias) s.causes.push('home bias');
  if (mN >= R.minReport && s.oursOnMarket! - s.marketLogLoss! >= R.marketGap) s.causes.push('market better');
  return s;
}

/**
 * Data health: the leagues with ≥ minOwn games whose 90-day hit rate was under warnUnder% on every one of the last
 * warnDays days (rolling windows ending each day). `rows` = settled rows of the last windowDays + warnDays days.
 */
export function leaguesUnder(rows: { comp: string; name: string; t: number; p: P3; y: number }[], now: number, R = LF_RULES) {
  const DAY = 86400000;
  const by = new Map<string, typeof rows>();
  for (const r of rows) { if (!by.has(r.comp)) by.set(r.comp, []); by.get(r.comp)!.push(r); }
  const out: { comp: string; name: string; n: number; hit: number; worst: number; best: number }[] = [];
  for (const [comp, list] of by) {
    let all = true, best = 0, worst = 100, nNow = 0, hitNow = 0;
    for (let k = 0; k < R.warnDays && all; k++) {
      const end = now - k * DAY, start = end - R.windowDays * DAY;
      const w = list.filter(r => r.t >= start && r.t < end);
      if (w.length < R.minOwn) { all = false; break; }
      const h = (100 * w.filter(r => argmax(norm(r.p)) === r.y).length) / w.length;
      if (k === 0) { nNow = w.length; hitNow = h; }
      if (h >= R.warnUnder) all = false;
      best = Math.max(best, h); worst = Math.min(worst, h);
    }
    if (all) out.push({ comp, name: list[0].name, n: nNow, hit: r1(hitNow), worst: r1(worst), best: r1(best) });
  }
  return out.sort((a, b) => a.hit - b.hit);
}

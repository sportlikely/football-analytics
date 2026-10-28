/**
 * fix255 / fix255b: leagues under 52% on 1X2 — the test and the per-group layer, pure (no database). The service is
 * services/leagueFix.ts (worker job, admin card, live settings), the live part services/leagueFixLive.ts.
 *
 * fix255b: fix255 tested per league on 21–61 games each (most leagues were only predicted from 7 Oct; /api/accuracy
 * without ?model= counts every model's row of a game, 4–5 per game) — nothing could pass. Now:
 *  - the games: every settled game of the public record once (the main model's own numbers: layer_raw, else p_pre,
 *    else the saved split), plus the last 2 seasons of the walk-forward grid-v3 backtest (backtest_predictions) for
 *    games before the league's record starts;
 *  - pooled per group first (big 5 / second tiers / other European top flights / Nordic / Americas / Asia / cups &
 *    national teams); a league gets its own settings only with ≥ 150 games in the window, and only when its own pass;
 *  - candidates are layers on the saved numbers, fitted on log loss:
 *      home   the home / away ratio × e^h, renormalised
 *      draw   P(draw) moved toward the group's draw rate: (1 − w)·P(D) + w·rate, home / away rescaled
 *      close  |P(H) − P(A)| < y → (1 − s)·p + s·(the group's base rates)
 *      home+draw, all (home + draw, then close)
 *    each fitted two ways: on record games only, and on record + the 2 backtest seasons ('extended');
 *    the pick is the most likely result of the shown numbers, so after a layer it can be the draw (counted);
 *  - the test: the 90 days in three 30-day blocks; each block predicted with settings fitted on everything else
 *    (fit on the first 60 → test the last 30, fit on the last 60 → test the first 30, and the middle one, so every game
 *    of the window has an out-of-sample number); pass = log loss better (by ≥ 1e-5) on the first and on the last block
 *    and in ≥ 90% of 2,000 paired bootstrap resamples of all three blocks (fix251's rules); hit rate is reported;
 *  - past seasons check (reported): fit on the backtest before its last season, test on that season.
 */
import { pairedBootstrap, type Boot } from './dailyRules';

export type P3 = [number, number, number];
export type LGroup = 'big5' | 'second' | 'europe' | 'americas' | 'asia' | 'nordic' | 'cups';
export const GROUP_NAMES: Record<LGroup, string> = {
  big5: 'Big 5 top tiers', second: 'Second tiers (Europe)', europe: 'Other European top flights', americas: 'Americas', asia: 'Asia',
  nordic: 'Nordic', cups: 'Cups & national teams'
};
export type Cand = 'home' | 'draw' | 'close' | 'home+draw' | 'all';
export const CANDS: Cand[] = ['home', 'draw', 'close', 'home+draw', 'all'];
export type Variant = 'record' | 'extended';
export const CAND_LABEL: Record<Cand, string> = {
  home: 'home advantage correction', draw: 'draw toward the group rate', close: 'close games toward base rates',
  'home+draw': 'home advantage + draw', all: 'home advantage + draw + close games'
};

export const LF_RULES = {
  windowDays: 90, blockDays: 30, minReport: 20, minLeague: 150, minUnit: 60, under: 52, warnUnder: 50, warnDays: 30, minOwn: 60,
  resamples: 2000, confidence: 0.9, minGain: 1e-5,
  hGrid: Array.from({ length: 25 }, (_, i) => Math.round((-0.6 + i * 0.05) * 100) / 100),
  wGrid: Array.from({ length: 17 }, (_, i) => Math.round(i * 0.05 * 100) / 100),
  yGrid: [0.05, 0.1, 0.15, 0.2], sGrid: [0.1, 0.2, 0.3, 0.4, 0.5],
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

/* ---------- the layers ---------- */

/** the settings of one unit: home h, draw weight w toward `dr`, close-game band y and weight s toward `base` */
export interface Params { h: number; w: number; dr: number; y: number; s: number; base: P3 }
export const NO_PARAMS: Params = { h: 0, w: 0, dr: 0.26, y: 0, s: 0, base: DEFAULT_BASE };
/** home / away ratio × e^h */
export const homeAdj = (q: P3, h: number): P3 => (h ? norm([q[0] * Math.exp(h / 2), q[1], q[2] * Math.exp(-h / 2)]) : q);
/** P(draw) → (1 − w)·P(D) + w·rate; home and away keep their ratio */
export const drawAdj = (q: P3, w: number, rate: number): P3 => {
  if (!w) return q;
  const d = (1 - w) * q[1] + w * rate, k = (1 - d) / Math.max(1e-9, q[0] + q[2]);
  return [q[0] * k, d, q[2] * k];
};
/** close games (|H − A| < y) toward the base rates by s */
export const closeAdj = (q: P3, y: number, s: number, base: P3): P3 =>
  y > 0 && s > 0 && Math.abs(q[0] - q[2]) < y ? [0, 1, 2].map(i => (1 - s) * q[i] + s * base[i]) as P3 : q;
const uses = (c: Cand) => ({ h: c === 'home' || c === 'home+draw' || c === 'all', w: c === 'draw' || c === 'home+draw' || c === 'all', c: c === 'close' || c === 'all' });
/** a candidate's numbers for one game (fractions in, fractions out) */
export function applyCand(p: P3, c: Cand, P: Params): P3 {
  const u = uses(c);
  let q = norm(p);
  if (u.h) q = homeAdj(q, P.h);
  if (u.w) q = drawAdj(q, P.w, P.dr);
  if (u.c) q = closeAdj(q, P.y, P.s, P.base);
  return q;
}

/* ---------- fitting ---------- */

export interface Game { id: number; comp: string; name: string; group: LGroup; t: number; p: P3; mkt: P3 | null; y: number; src: 'record' | 'backtest'; season?: string }

/** the group's base rates (with a light prior) from the fit games */
export function baseRates(games: { y: number }[]): P3 {
  const c = [0, 0, 0];
  for (const g of games) c[g.y]++;
  return norm([c[0] + 30 * DEFAULT_BASE[0], c[1] + 30 * DEFAULT_BASE[1], c[2] + 30 * DEFAULT_BASE[2]]);
}
const lossOf = (games: Game[], c: Cand, P: Params) => { let s = 0; for (const g of games) s += ll(applyCand(g.p, c, P), g.y); return s; };
/** the grid value with the lowest loss (ties: the one closest to "no change", listed first by `order`) */
function best<T>(vals: T[], f: (v: T) => number): T {
  let b = vals[0], bl = f(b);
  for (const v of vals.slice(1)) { const l = f(v); if (l < bl - 1e-9) { b = v; bl = l; } }
  return b;
}
const byZero = (xs: number[]) => xs.slice().sort((a, b) => Math.abs(a) - Math.abs(b));
/** fit a candidate on games (coordinate search on the grids, log loss); draw rate and base rates from the games */
export function fitCand(games: Game[], c: Cand, R = LF_RULES): Params { return run(fitSteps(games, c, R)); }
/** the same, as steps: it yields after each grid search (the worker gives the thread back there) */
export function* fitSteps(games: Game[], c: Cand, R = LF_RULES): Generator<void, Params> {
  const base = baseRates(games);
  const P: Params = { ...NO_PARAMS, dr: base[1], base };
  if (!games.length) return P;
  const u = uses(c);
  for (let round = 0; round < (u.h && u.w ? 3 : 1); round++) {
    if (u.h) { P.h = best(byZero(R.hGrid), h => lossOf(games, c === 'all' ? 'home+draw' : c, { ...P, h })); yield; }
    if (u.w) { P.w = best(R.wGrid, w => lossOf(games, c === 'all' ? 'home+draw' : c, { ...P, w })); yield; }
  }
  if (u.c) {
    const pairs = [[0, 0], ...R.yGrid.flatMap(y => R.sGrid.map(s => [y, s]))];
    const [y, s] = best(pairs, ([y, s]) => lossOf(games, c, { ...P, y, s }));
    P.y = y; P.s = s;
    yield;
  }
  return P;
}
/** drive a generator to its end (sync) */
export function run<T>(g: Generator<void, T>): T { for (;;) { const r = g.next(); if (r.done) return r.value; } }
/** drive it giving the thread back at every step (the worker's job) */
export async function runAsync<T>(g: Generator<void, T>, pause: () => Promise<void>): Promise<T> { for (;;) { const r = g.next(); if (r.done) return r.value; await pause(); } }

/* ---------- the cross test ---------- */

export interface BlockRes { from: string; n: number; diff: number; hitBase: number; hitCand: number }
export interface CandResult {
  cand: Cand; variant: Variant; n: number; dAll: number; blocks: BlockRes[]; hitBase: number; hitCand: number;
  drawPicks: number; drawPickHits: number; past: { n: number; diff: number } | null; boot: Boot | null; pass: boolean; why: string;
  /** out-of-sample numbers of every window game (id → split), for the table */
  probs?: Map<number, P3>;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const r1 = (x: number) => Math.round(x * 10) / 10;
const DAY = 86400000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** the three test blocks of the window: [from, from + 30d), [+30, +60), [+60, to) */
export const blocksOf = (from: number, to: number, R = LF_RULES) => [0, 1, 2].map(k => ({ from: from + k * R.blockDays * DAY, to: k === 2 ? to : from + (k + 1) * R.blockDays * DAY }));

/**
 * One candidate on one unit: `games` = every game of the unit (record, in and before the window, and backtest).
 * Each block's games get the candidate fitted on the others (record only, or + backtest for 'extended').
 */
export function crossTest(games: Game[], c: Cand, v: Variant, from: number, to: number, R = LF_RULES, seed = 255): CandResult { return run(crossSteps(games, c, v, from, to, R, seed)); }
export function* crossSteps(games: Game[], c: Cand, v: Variant, from: number, to: number, R = LF_RULES, seed = 255): Generator<void, CandResult> {
  const blocks = blocksOf(from, to, R);
  const inBlock = (g: Game, b: { from: number; to: number }) => g.src === 'record' && g.t >= b.from && g.t < b.to;
  const probs = new Map<number, P3>();
  const d: number[] = [];
  const res: BlockRes[] = [];
  let hb = 0, hc = 0, n = 0, dp = 0, dph = 0;
  for (const b of blocks) {
    const test = games.filter(g => inBlock(g, b));
    const fit = games.filter(g => !inBlock(g, b) && (v === 'extended' || g.src === 'record'));
    const P = yield* fitSteps(fit, c, R);
    const bd: number[] = [];
    let bhb = 0, bhc = 0;
    for (const g of test) {
      const q = applyCand(g.p, c, P), base = norm(g.p);
      probs.set(g.id, q);
      bd.push(ll(q, g.y) - ll(base, g.y));
      if (argmax(base) === g.y) bhb++;
      if (argmax(q) === g.y) bhc++;
      if (argmax(q) === 1) { dp++; if (g.y === 1) dph++; }
    }
    d.push(...bd); hb += bhb; hc += bhc; n += test.length;
    res.push({ from: isoDay(b.from), n: test.length, diff: r5(mean(bd)), hitBase: test.length ? r1((100 * bhb) / test.length) : 0, hitCand: test.length ? r1((100 * bhc) / test.length) : 0 });
  }
  // past seasons check (reported only): fit on the backtest before its last season, test on that season
  let past: CandResult['past'] = null;
  const bt = games.filter(g => g.src === 'backtest' && g.season);
  const seasons = [...new Set(bt.map(g => g.season!))].sort();
  if (seasons.length >= 2) {
    const last = seasons[seasons.length - 1];
    const tst = bt.filter(g => g.season === last), P = yield* fitSteps(bt.filter(g => g.season! < last), c, R);
    if (tst.length) past = { n: tst.length, diff: r5(mean(tst.map(g => ll(applyCand(g.p, c, P), g.y) - ll(norm(g.p), g.y)))) };
  }
  const out: CandResult = {
    cand: c, variant: v, n, dAll: r5(mean(d)), blocks: res, hitBase: n ? r1((100 * hb) / n) : 0, hitCand: n ? r1((100 * hc) / n) : 0,
    drawPicks: dp, drawPickHits: dph, past, boot: null, pass: false, why: '', probs
  };
  const first = mean(d.slice(0, res[0].n)), lastB = mean(d.slice(n - res[2].n));
  if (n < R.minUnit) return { ...out, why: `${n} games in the window (< ${R.minUnit})` };
  if (!res[0].n || !res[2].n) return { ...out, why: 'no games in the first or the last 30 days' };
  if (first > -R.minGain || lastB > -R.minGain) return { ...out, why: `not better on both the first and the last 30 days (${sg(res[0].diff)} / ${sg(res[2].diff)})` };
  yield;
  const boot = pairedBootstrap(d, R.resamples, seed);
  out.boot = boot;
  if (boot.pBetter < R.confidence) return { ...out, why: `better on the first and last 30 days but only in ${Math.round(boot.pBetter * 100)}% of resamples (needs ${Math.round(R.confidence * 100)}%)` };
  return { ...out, pass: true, why: `better on the first and last 30 days (${sg(res[0].diff)} / ${sg(res[2].diff)}), ${Math.round(boot.pBetter * 100)}% of resamples` };
}
const sg = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)}`;

/** every candidate × variant on a unit; `best` = the passing one with the lowest log loss */
export function judgeUnit(games: Game[], from: number, to: number, R = LF_RULES) {
  const results: CandResult[] = [];
  const hasBt = games.some(g => g.src === 'backtest');
  for (const c of CANDS) for (const v of (hasBt ? ['record', 'extended'] : ['record']) as Variant[]) results.push(crossTest(games, c, v, from, to, R));
  const best = results.filter(x => x.pass).sort((a, b) => a.dAll - b.dAll)[0] || null;
  return { results, best };
}
/** the settings applied live: the candidate fitted on every game of the unit (record, + backtest for 'extended') */
export const liveSteps = (games: Game[], c: Cand, v: Variant, R = LF_RULES) => fitSteps(games.filter(g => v === 'extended' || g.src === 'record'), c, R);

/** the live setting of a group or league */
export interface LeagueSetting { cand: Cand; variant: Variant; P: Params }
export const applySetting = (p: P3, s: LeagueSetting): P3 => applyCand(p, s.cand, s.P);

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

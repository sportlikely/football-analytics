/**
 * fix223 — per-league settings like football's league tune (pure: no database). Every sport's model keeps its shared
 * settings; a league (basketball league, American football level, tennis tour × surface) gets settings of its own only
 * when they beat the shared model on games they never saw:
 *
 *  - own: a league with LS_MIN_OWN+ games in the three train seasons. Fit on LS_FIT (2022-23 + 2023-24), kept only when
 *    it beats the shared model on LS_TEST (2024-25) by LS_MIN_GAIN log loss (LS_MIN_TEST+ games), then refitted on all
 *    three (LS_REFIT). LS_CHECK (2025-26) = the untouched check (reported only); LS_LIVE_FROM (2026-27+) reported, never
 *    tuned (assertLsYears throws).
 *  - group: smaller leagues pooled by group (each sport names its groups), fitted and gated the same way on the pooled
 *    games; every member uses the group's settings when the group passed.
 *  - shared: everything else (or a league whose own / group settings lost on the test season).
 * Shrinkage toward the shared settings: the fits minimise log loss + Σ ((θ − θ₀) / τ)² / (2n) — a prior worth ~one
 * game per unit of τ², so the fewer games, the stronger the pull.
 */

export const LS_FIT = [2022, 2023];
export const LS_TEST = 2024;
export const LS_REFIT = [2022, 2023, 2024];
export const LS_CHECK = 2025;
export const LS_LIVE_FROM = 2026;
export const LS_MIN_OWN = 400;
export const LS_MIN_TEST = 100;
export const LS_MIN_GAIN = 0.0005;
/** a fit after this many days is due again (data health "League settings fresh" warns after 35) */
export const LS_REFIT_DAYS = 30;

export type LsYears = { fit: number[]; test: number; refit: number[]; check: number; liveFrom: number };
export const LS_YEARS: LsYears = { fit: LS_FIT, test: LS_TEST, refit: LS_REFIT, check: LS_CHECK, liveFrom: LS_LIVE_FROM };
export function assertLsYears(years: number[], Y: LsYears = LS_YEARS) {
  if (!years.length) throw new Error('no fit seasons');
  for (const y of years) if (!(y < Y.liveFrom)) throw new Error(`season ${y} is the live period: never tuned on`);
  for (const y of years) if (y >= Y.check) throw new Error(`season ${y} is the untouched check: never tuned on`);
}

/** one parameter of a fit: read / write, bounds, search step, shrinkage scale τ, the shared value it is pulled toward */
export type Param = { get: () => number; set: (v: number) => void; lo: number; hi: number; step: number; tau: number; at: number };
export const shrinkPenalty = (defs: Param[], n: number, k = 1) => (n > 0 ? (k * defs.reduce((s, d) => s + ((d.get() - d.at) / d.tau) ** 2, 0)) / (2 * n) : 0);

/**
 * Pattern search (as utils/bbGridMath's): each parameter up and down by its step, keep the first improvement, halve the
 * steps when a round finds none (stop after 4 halvings). f = the loss to minimise (penalty included by the caller).
 */
export async function minimize(f: () => number, defs: Param[], opt: { rounds?: number; pause?: () => Promise<void> } = {}) {
  const pause = opt.pause || (async () => undefined);
  const steps = defs.map(d => d.step * 2);
  let best = f(), halvings = 0;
  for (let round = 1; round <= (opt.rounds ?? 40); round++) {
    let improved = false;
    for (let i = 0; i < defs.length; i++) {
      for (const dir of [1, -1]) {
        const old = defs[i].get();
        const nv = Math.min(defs[i].hi, Math.max(defs[i].lo, Math.round((old + dir * steps[i]) * 1e6) / 1e6));
        if (nv === old) continue;
        defs[i].set(nv);
        const fn = f();
        if (fn < best - 1e-9) { best = fn; improved = true; break; }
        defs[i].set(old);
      }
    }
    await pause();
    if (!improved) { halvings++; for (let i = 0; i < steps.length; i++) steps[i] /= 2; if (halvings >= 4) break; }
  }
  return best;
}

export type LsUsed = 'own' | 'group' | 'shared';
export interface LsLeague<S> {
  league: string; group: string | null; used: LsUsed;
  games: { train: number; test: number; check: number; live: number };
  /** test season (2024-25) log loss: shared, own fit (fit seasons only), the group's fit; gain = shared − used */
  test: { shared: number | null; own: number | null; group: number | null; gain: number | null };
  /** the untouched check (2025-26) and the live period (2026-27+): shared vs the settings used */
  check: { shared: number | null; used: number | null }; live: { shared: number | null; used: number | null };
  why: string; settings: S | null;
}
export interface LsGroup<S> { group: string; members: string[]; games: { train: number; test: number }; test: { shared: number | null; group: number | null }; pass: boolean; why: string; settings: S | null }
export interface LsResult<S> { leagues: LsLeague<S>[]; groups: LsGroup<S>[]; years: LsYears }

const r5 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e5) / 1e5);

/**
 * The whole selection. `fit(items, years)` = shrunk settings on those items (years already filtered; fit only sees those
 * years), `ll(items, s)` = mean log loss with settings s (null = the shared model). Items carry their league and year.
 */
export async function tuneLeagueSettings<I extends { league: string; year: number }, S>(items: I[], o: {
  groupOf: (league: string) => string | null;
  fit: (items: I[], years: number[]) => Promise<S>;
  ll: (items: I[], s: S | null) => number;
  minOwn?: number; minTest?: number; minGain?: number; pause?: () => Promise<void>;
  /** the periods (default: seasons 2022-23 + 2023-24 → 2024-25, refit on the three, check 2025-26, live 2026-27+) */
  years?: LsYears;
}): Promise<LsResult<S>> {
  const Y = o.years || LS_YEARS;
  const LS_FIT = Y.fit, LS_TEST = Y.test, LS_REFIT = Y.refit, LS_CHECK = Y.check, LS_LIVE_FROM = Y.liveFrom;
  const minOwn = o.minOwn ?? LS_MIN_OWN, minTest = o.minTest ?? LS_MIN_TEST, minGain = o.minGain ?? LS_MIN_GAIN;
  const pause = o.pause || (async () => undefined);
  const by = new Map<string, I[]>();
  for (const it of items) { let l = by.get(it.league); if (!l) by.set(it.league, (l = [])); l.push(it); }
  const yrs = (l: I[], ys: number[]) => l.filter(x => ys.includes(x.year));
  const fitOn = async (l: I[], ys: number[]) => { assertLsYears(ys, Y); return o.fit(yrs(l, ys), ys); };
  const llOf = (l: I[], s: S | null) => (l.length ? o.ll(l, s) : null);
  const leagues: LsLeague<S>[] = [];
  const small: string[] = [];
  for (const [league, l] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const train = yrs(l, LS_REFIT).length, test = l.filter(x => x.year === LS_TEST);
    const row: LsLeague<S> = {
      league, group: o.groupOf(league), used: 'shared',
      games: { train, test: test.length, check: l.filter(x => x.year === LS_CHECK).length, live: l.filter(x => x.year >= LS_LIVE_FROM).length },
      test: { shared: r5(llOf(test, null)), own: null, group: null, gain: null }, check: { shared: null, used: null }, live: { shared: null, used: null }, why: '', settings: null
    };
    leagues.push(row);
    if (train < minOwn) { small.push(league); row.why = `${train} train games (< ${minOwn}): group settings`; continue; }
    if (test.length < minTest || yrs(l, LS_FIT).length < 100) { row.why = `${test.length} test games / ${yrs(l, LS_FIT).length} fit games: shared settings`; continue; }
    const a = await fitOn(l, LS_FIT);
    row.test.own = r5(llOf(test, a));
    const gain = row.test.shared! - row.test.own!;
    if (gain > minGain) {
      row.used = 'own'; row.test.gain = r5(gain);
      row.settings = await fitOn(l, LS_REFIT);
      row.why = `own settings beat the shared model on ${LS_TEST} by ${gain.toFixed(4)} (${test.length} games): refitted on ${LS_REFIT.join(', ')}`;
    } else row.why = `own settings ${row.test.own} vs shared ${row.test.shared} on ${LS_TEST} (${test.length} games): shared settings`;
    await pause();
  }
  const groups: LsGroup<S>[] = [];
  const gnames = [...new Set(small.map(x => o.groupOf(x)).filter((x): x is string => !!x))].sort();
  for (const g of gnames) {
    const members = small.filter(x => o.groupOf(x) === g);
    const pool = members.flatMap(m => by.get(m) || []);
    const test = pool.filter(x => x.year === LS_TEST);
    const G: LsGroup<S> = { group: g, members, games: { train: yrs(pool, LS_REFIT).length, test: test.length }, test: { shared: r5(llOf(test, null)), group: null }, pass: false, why: '', settings: null };
    groups.push(G);
    if (G.games.train < minOwn || test.length < minTest) { G.why = `${G.games.train} train / ${test.length} test games pooled: shared settings`; continue; }
    const a = await fitOn(pool, LS_FIT);
    G.test.group = r5(llOf(test, a));
    G.pass = G.test.shared! - G.test.group! > minGain;
    if (G.pass) G.settings = await fitOn(pool, LS_REFIT);
    G.why = G.pass ? `group settings beat the shared model on ${LS_TEST} (${G.test.group} vs ${G.test.shared}, ${test.length} games): refitted on ${LS_REFIT.join(', ')}`
      : `group settings ${G.test.group} vs shared ${G.test.shared} on ${LS_TEST}: shared settings`;
    for (const m of members) {
      const row = leagues.find(x => x.league === m)!;
      const t = (by.get(m) || []).filter(x => x.year === LS_TEST);
      row.test.group = r5(llOf(t, a));
      if (G.pass) { row.used = 'group'; row.settings = G.settings; row.test.gain = row.test.shared !== null && row.test.group !== null ? r5(row.test.shared - row.test.group) : null; row.why = `group ${g}: ${G.why}`; }
      else row.why = `group ${g}: ${G.why}`;
    }
    await pause();
  }
  for (const row of leagues) {
    const l = by.get(row.league)!;
    const ch = l.filter(x => x.year === LS_CHECK), lv = l.filter(x => x.year >= LS_LIVE_FROM);
    row.check = { shared: r5(llOf(ch, null)), used: r5(llOf(ch, row.settings)) };
    row.live = { shared: r5(llOf(lv, null)), used: r5(llOf(lv, row.settings)) };
  }
  return { leagues, groups, years: Y };
}

/* ---------- the probability-level settings (American football, tennis: models that give a chance, not grid rows) ---------- */

/** home edge h (probit units, 0 for tennis / neutral games) and stretch: p' = Φ(stretch · Φ⁻¹(p) + h) */
export interface ProbSet { home: number; stretch: number; n: number }
export interface ProbItem { league: string; year: number; p: number; y: number; home: boolean }
const PHI_C = 0.7071067811865476;
function erf(x: number) { // Abramowitz–Stegun 7.1.26
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
export const Phi = (x: number) => 0.5 * (1 + erf(x * PHI_C));
/** inverse normal (Acklam) */
export function probitOf(p: number) {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (q < lo) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - lo) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5, s = r * r;
  return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}
const clampP = (p: number) => Math.min(0.995, Math.max(0.005, p));
export function applyProbSet(s: ProbSet | null | undefined, p: number, home = true): number {
  if (!s) return p;
  return clampP(Phi(s.stretch * probitOf(p) + (home ? s.home : 0)));
}
export function probLL(items: { p: number; y: number; home: boolean }[], s: ProbSet | null) {
  let t = 0;
  for (const it of items) { const q = clampP(applyProbSet(s, it.p, it.home)); t += -(it.y * Math.log(q) + (1 - it.y) * Math.log(1 - q)); }
  return items.length ? t / items.length : 0;
}
/** shrunk fit toward the shared model (home 0, stretch 1); symmetric = no home edge (tennis) */
export async function fitProbSet(items: { p: number; y: number; home: boolean }[], symmetric: boolean, pause?: () => Promise<void>): Promise<ProbSet> {
  const s: ProbSet = { home: 0, stretch: 1, n: items.length };
  const defs: Param[] = [{ get: () => s.stretch, set: v => { s.stretch = v; }, lo: 0.6, hi: 1.5, step: 0.02, tau: 0.1, at: 1 }];
  if (!symmetric) defs.push({ get: () => s.home, set: v => { s.home = v; }, lo: -0.5, hi: 0.5, step: 0.01, tau: 0.05, at: 0 });
  await minimize(() => probLL(items, s) + shrinkPenalty(defs, items.length), defs, { pause });
  return s;
}

/** a kept setting as the live model reads it: own or its group's */
export type UsedProbSet = ProbSet & { src: 'own' | 'group'; group: string | null };
/** the whole selection on probability-level items (American football levels, tennis tour × surface) */
export async function probSettings(items: ProbItem[], o: { groupOf: (league: string) => string | null; symmetric: boolean; years?: LsYears; minOwn?: number; pause?: () => Promise<void> }) {
  const res = await tuneLeagueSettings(items, {
    groupOf: o.groupOf, years: o.years, minOwn: o.minOwn, pause: o.pause,
    fit: l => fitProbSet(l, o.symmetric, o.pause),
    ll: (l, s) => probLL(l, s)
  });
  const used: Record<string, UsedProbSet> = {};
  for (const r of res.leagues) if (r.settings && r.used !== 'shared') used[r.league] = { ...r.settings, src: r.used, group: r.used === 'group' ? r.group : null };
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const total = (yr: (y: number) => boolean) => {
    const l = items.filter(x => yr(x.year));
    let a = 0, b = 0;
    for (const it of l) { a += probLL([it], null); b += probLL([it], used[it.league] || null); }
    return { games: l.length, shared: l.length ? r5(a / l.length) : null, used: l.length ? r5(b / l.length) : null };
  };
  const Y = res.years;
  return { ...res, used, total: { test: total(y => y === Y.test), check: total(y => y === Y.check), live: total(y => y >= Y.liveFrom) } };
}
/** the chance with a league's kept settings (none = as it is) */
export const applyUsed = (used: Record<string, UsedProbSet> | null | undefined, league: string | null | undefined, p: number, home = true) =>
  (used && league && used[league] ? applyProbSet(used[league], p, home) : p);

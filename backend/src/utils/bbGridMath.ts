/**
 * fix219 — bb-v4, the basketball grid model (the pure part: no database). Like football v3: every game gets 13 rows,
 * each a value per team as it was before tip-off; margin = Σ weight × (home value − away value) in points;
 * P(home) = Φ(stretch × margin / sigma), sigma = the league's typical miss widened by 3-point volatility (#12).
 * The weights are fitted by the tuner (fitGrid: pattern search on log loss, like v3Tuner), shared by every league, with
 * per-league offsets only for leagues with 1,500+ training games, and a calibration stretch per league.
 * The game page shows the "1,000 points split" (split1000) like football.
 */
import { phi, scoreP } from './nbaImpact';
import { minimize, shrinkPenalty } from './leagueSettings';
import { clampTop, TOP_LO, TOP_HI, WB_START, type BoxCoef } from './boxValue';

/** The 13 rows (index = position in the value arrays). Bounds / steps for the tuner; `w0` = the starting weight. */
export const GRID_ROWS = [
  { id: '#1', key: 'impact', name: 'Player impact of the expected rotation', lo: -1, hi: 3, step: 0.05, w0: 0.2 },
  { id: '#2', key: 'net100', name: 'Net rating per 100 possessions (opponent-adjusted)', lo: -1, hi: 3, step: 0.05, w0: 0.3 },
  // fix219 research: bb-v1's points rating alone left the grid worse than bb-v3 on its own training seasons (0.5829 vs
  // 0.5815): #3 carries bb-v3's whole team rating (points + possessions + player talent) as a margin, split ± half
  { id: '#3', key: 'team', name: 'Team rating (bb-v3: points, possessions, talent)', lo: -1, hi: 3, step: 0.05, w0: 1 },
  { id: '#4', key: 'missing', name: 'Missing players', lo: -1, hi: 4, step: 0.1, w0: 1 },
  { id: '#5', key: 'fourFactors', name: 'Four factors (shooting, turnovers, rebounds, free throws)', lo: -1, hi: 2, step: 0.05, w0: 0 },
  { id: '#6', key: 'rest', name: 'Rest (back-to-back, 3 games in 4 days)', lo: -2, hi: 6, step: 0.25, w0: 1 },
  { id: '#7', key: 'home', name: 'Home court (league + team)', lo: -1, hi: 3, step: 0.05, w0: 0 },
  { id: '#8', key: 'carry', name: 'Season carry-over (players who stayed)', lo: -2, hi: 3, step: 0.1, w0: 0 },
  { id: '#9', key: 'matchup', name: 'Matchups (style against style)', lo: -2, hi: 2, step: 0.05, w0: 0 },
  { id: '#10', key: 'form', name: 'Form: last 10 games against expectation', lo: -1, hi: 2, step: 0.05, w0: 0 },
  { id: '#11', key: 'motivation', name: 'Motivation (late-season tanking)', lo: -3, hi: 6, step: 0.25, w0: 0 },
  { id: '#12', key: 'volatility', name: '3-point volatility (spreads the chances)', lo: 0, hi: 3, step: 0.1, w0: 0 },
  { id: '#13', key: 'h2h', name: 'Head-to-head', lo: -1, hi: 1, step: 0.05, w0: 0 }
] as const;
export const N_ROWS = GRID_ROWS.length;
/** #12 doesn't move the margin: its weight widens sigma (sigma × (1 + w × volatility)). */
export const VOL = 11;

/** bb-v3's walk-forward pieces of one game (bbModel.buildLeague). */
export type GridBase = { p: number; m1: number; netH: number; netA: number; hca: number; haH: number; haA: number; b2bH: boolean; b2bA: boolean; sig: number };
/** One finished game for the tuner / gate: row values (home side, away side), sigma, result, bb-v3's chance. */
export type GridItem = {
  id: number; code: string; season: string; year: number; gp: number; y: number; v3: number; sig: number; hv: number[]; av: number[]; oracle: number | null; mg?: number | null;
  /** fix225: the impact rows under the two new rating sets (ALT layout); null on rows built before fix225 */
  alt?: (number | null)[] | null;
  /** fix225: the top-3 players' part of the oracle (home − away) and of #4 as the row stands (the star factor reads it) */
  ot?: number | null; t4?: number;
};
/**
 * fix223 — a league's own settings (or its group's), on top of the shared ones: home edge (points added to #7 when the
 * court is not neutral), stretch (× the shared stretch), sigma (× the league's typical miss: its spread of results
 * against the model's margin, relative to every league's) and offsets for the 4 big rows (LS_ROWS).
 */
export type LeagueSet = { src: 'own' | 'group'; group: string | null; home: number; str: number; sig: number; off: number[]; n: number };
export type GridParams = {
  w: number[]; stretch: Record<string, number>; offsets: Record<string, number[]>; version: string; fittedAt: string | null; train: number[] | null;
  /** fix223: per-league settings that passed their gate (services/bbTuner.ts runLeagueTune) */
  league?: Record<string, LeagueSet>;
  /** fix228: row #4 frozen at its "who actually played" fit (services/bbTuner.ts runMissFit) */
  miss?: MissSet;
  /** fix225: player impact = box-score value blended with on/off (services/bbTuner.ts runImpactFit); absent = on/off only */
  impact?: ImpactSet;
};
/**
 * fix225 — the player impact the rows #1 / #4 / #8 read: wb × box-score value + (1 − wb) × on/off rating (the on/off
 * shrink scaled by minutes). box = the formula the values were made with (utils/boxValue.ts).
 */
export type ImpactSet = { wb: number; box: BoxCoef; fittedAt: string; train: number[]; test: number };
/**
 * fix228 — row #4 (missing players) fitted on the oracle rows (who actually played vs the expected rotation, from the box
 * score: what the injury report / confirmed line-up gives live), then frozen: every tune fits the other rows around it.
 * w = the NBA weight (live input: injury report + confirmed starters, never the "missed the last games" proxy);
 * star = how much more a big loss counts (value × (1 + star × |value|): a star out costs more than two role players);
 * proxy = the weight of every other league (live input: missed the last 2 games + news / rest, fix224), fitted the same
 * way on its own rows and never above w.
 */
export type MissSet = {
  w: number; star: number; proxy: number; fittedAt: string; train: number[]; test: number;
  /** fix225: star factor (1.0–1.6) on the top-3 players' part of an NBA team's loss (replaces `star` when set) */
  top?: number;
};
/** row #4's index; the leagues whose live #4 is the injury report (oracle in history) */
export const MISS = 3;
export const ORACLE_CODES = ['NBA'];
export const usesOracle = (code: string) => ORACLE_CODES.includes(code);
/** a #4 difference with the star factor (signed: bigger losses count more than in proportion) */
export const starOf = (d: number, star: number) => d * (1 + star * Math.abs(d));

/** Live numbers until the first /api/bb/tune?apply=1 (fix219 research, 10 Oct database, train 2022-23 … 2024-25). */
/** the starting weights of a fit from nothing (GRID_ROWS.w0) */
export const GRID_START: GridParams = { w: GRID_ROWS.map(r => r.w0), stretch: {}, offsets: {}, version: 'start', fittedAt: null, train: null };
export const GRID_DEFAULT: GridParams = {
  w: [0.35,0,0.75,0.525,-0.2375,0.5,0.275,0.025,-0.0125,-0.0375,0.0625,0.675,-0.05],
  stretch: {"BSN":0.915,"EC":0.975,"EL":1.005,"LNB":1.01,"ABA":1.04,"FEC":1.23,"NBL":0.725,"LBA":0.93,"JBL":0.995,"BBL":1.01,"ACB":1.025,"LKL":1.08,"GBL":1.38,"NBB":0.975,"BCL":1.125,"NBA":0.9,"BSL":0.985,"CBA":1.11},
  offsets: {"JBL":[-0.0375,-0.05,0.05,0.175,0.0375,0,-0.125,0.175,-0.05,0.025,-0.125,-0.025,0.075],"NBA":[0.025,-0.05,0.0125,0.1,0.0125,0.125,-0.05,0,0,0,0.1875,0.05,0.0125]},
  version: 'default (fix219 research, 10 Oct database)', fittedAt: '2026-10-25', train: [2022, 2023, 2024]
};

export const startYear = (season: string) => parseInt(String(season).slice(0, 4), 10);
/** Train seasons start 2022 … 2024, test 2025 (2025-26 or the 2025 calendar season), live 2026+ never tuned. */
export const GRID_TRAIN = [2022, 2023, 2024];
export const GRID_TEST = 2025;
export const GRID_LIVE_FROM = 2026;
export function assertTrainYears(train: number[], test: number) {
  if (!train.length) throw new Error('no train seasons');
  for (const y of train) if (!(y < GRID_LIVE_FROM)) throw new Error(`season ${y} is the live period: never tuned on`);
  if (train.some(y => y >= test)) throw new Error('train seasons must come before the test season');
}

const clampP = (p: number) => Math.min(0.995, Math.max(0.005, p));
export const diff = (it: { hv: number[]; av: number[] }, i: number) => (it.hv[i] || 0) - (it.av[i] || 0);
/** volatility of a game: both teams' 3-point attempt share against the league (stored as the #12 values, already centred) */
export const volOf = (it: { hv: number[]; av: number[] }) => (it.hv[VOL] || 0) + (it.av[VOL] || 0);

export function weightsFor(p: GridParams, code: string): number[] {
  const off = p.offsets[code], ls = p.league?.[code];
  const w = off ? p.w.map((w, i) => w + (off[i] || 0)) : p.w;
  const out = ls ? w.map((x, i) => x + (ls.off[i] || 0)) : w;
  // fix228: #4 frozen — no league offset moves it; the NBA's injury-report weight, the proxy weight elsewhere
  if (!p.miss) return out;
  const fr = out === p.w ? [...out] : out;
  fr[MISS] = usesOracle(code) ? p.miss.w : p.miss.proxy;
  return fr;
}
/**
 * fix228: the #4 inputs as live has them. 'oracle' = the NBA's #4 is who actually played (the injury report's stand-in;
 * unknown → 0), 'blind' = the NBA's #4 is 0 (no injury information: bb-v4 against bb-v3, which had none either); other
 * leagues keep the stored proxy (missed the last 2 games). Copies; the stored items stay as they are.
 */
export function missInputs<T extends { code: string; hv: number[]; av: number[]; oracle: number | null; ot?: number | null; t4?: number }>(items: T[], mode: 'oracle' | 'blind'): T[] {
  return items.map(x => {
    if (!usesOracle(x.code)) return x;
    const hv = [...x.hv], av = [...x.av];
    const known = mode === 'oracle' && x.oracle !== null;
    hv[MISS] = known ? x.oracle! : 0; av[MISS] = 0;
    return { ...x, hv, av, t4: known ? x.ot ?? 0 : 0 };
  });
}

/* ---------- fix225: the impact variants of the stored rows ---------- */

/**
 * bb_grid_rows.alt (home view): for the on/off ratings with the minutes-scaled shrink (A, from 0) and the box-score
 * values (B, from 10): #1 home / away, #4 home / away, #4's top-3 part home / away, #8 home / away (already faded by
 * game 25), the oracle (home − away, null = unknown) and its top-3 part. The stored hv / av stay the fix219 values
 * (on/off, one lambda): what live uses until runImpactFit's gate passes.
 */
export const ALT = { A: 0, B: 10, imp: 0, miss: 2, top: 4, stay: 6, oracle: 8, otop: 9, len: 20 };
/**
 * The rows as the impact setting reads them (wb = the box share): #1 / #4 / #8 and the oracle blended from the two
 * rating sets (everything there is linear in the ratings: the rotation's minutes don't depend on them), t4 / ot = the
 * top-3 parts. Without a setting (or a row without alt) the stored rows. Copies; the stored items stay as they are.
 */
export function impactInputs<T extends GridItem>(items: T[], imp: { wb: number } | null | undefined): T[] {
  if (!imp) return items;
  const wb = imp.wb;
  const b = (x: (number | null)[], k: number) => { const a = x[ALT.A + k], c = x[ALT.B + k]; return a === null || c === null || a === undefined || c === undefined ? null : wb * c + (1 - wb) * a; };
  return items.map(x => {
    const a = x.alt;
    if (!a || a.length < ALT.len) return x;
    const hv = [...x.hv], av = [...x.av];
    hv[0] = b(a, ALT.imp) ?? hv[0]; av[0] = b(a, ALT.imp + 1) ?? av[0];
    hv[MISS] = b(a, ALT.miss) ?? hv[MISS]; av[MISS] = b(a, ALT.miss + 1) ?? av[MISS];
    hv[7] = b(a, ALT.stay) ?? hv[7]; av[7] = b(a, ALT.stay + 1) ?? av[7];
    const t4 = (b(a, ALT.top) ?? 0) - (b(a, ALT.top + 1) ?? 0);
    return { ...x, hv, av, oracle: b(a, ALT.oracle), ot: b(a, ALT.otop), t4 };
  });
}
/** share of rows with the fix225 values (the fit waits for the rebuild) */
export const altShare = (items: GridItem[]) => (items.length ? items.filter(x => x.alt && x.alt.length >= ALT.len).length / items.length : 0);
/** #7 is 0 for both teams only on a neutral court (final fours): no home edge there */
const neutralOf = (it: { hv: number[]; av: number[] }) => !(it.hv[6] || 0) && !(it.av[6] || 0);
/** margin in points (home − away), the contribution of each row, the sigma used and the home win chance */
export function gridEval(p: GridParams, code: string, it: { hv: number[]; av: number[]; sig: number; t4?: number }, w = weightsFor(p, code)) {
  const parts = new Array<number>(N_ROWS).fill(0);
  let m = 0;
  const star = p.miss && usesOracle(code) ? p.miss.star : 0;
  const top = p.miss?.top && usesOracle(code) ? clampTop(p.miss.top) : 0;
  for (let i = 0; i < N_ROWS; i++) {
    if (i === VOL) continue;
    // fix225: the top-3 part of the NBA's #4 counted `top` times (the fix228 star form only without it)
    const d = i !== MISS ? diff(it, i) : top ? diff(it, i) + (top - 1) * (it.t4 || 0) : star ? starOf(diff(it, i), star) : diff(it, i);
    parts[i] = w[i] * d; m += parts[i];
  }
  const ls = p.league?.[code];
  if (ls?.home && !neutralOf(it)) { parts[6] += ls.home; m += ls.home; }
  const sig = it.sig * (ls?.sig ?? 1) * Math.min(1.5, Math.max(0.7, 1 + w[VOL] * volOf(it)));
  const pHome = clampP(phi(((p.stretch[code] ?? 1) * (ls?.str ?? 1) * m) / sig));
  return { margin: m, parts, sigma: sig, pHome };
}

/** What the game page shows: the 1,000 points split (football's table), rows with weight 0 hidden and listed apart. */
export type GridView = {
  rows: { id: string; key: string; home: number; away: number; rel: number; edge: number }[];
  points: { home: number; away: number }; unused: string[]; volatility: number | null; margin: number; sigma: number;
};
/** rel = the row's share of the fitted split (points per row out of 1,000, from the weights × the rows' spread) */
export function fittedSplit(w: number[], sd: number[]): number[] {
  const raw = w.map((x, i) => (i === VOL ? 0 : Math.abs(x) * (sd[i] || 0)));
  const tot = raw.reduce((a, b) => a + b, 0) || 1;
  const out = raw.map(x => Math.round((1000 * x) / tot));
  const gap = 1000 - out.reduce((a, b) => a + b, 0);
  if (gap && tot > 0) { const k = out.indexOf(Math.max(...out)); out[k] += gap; }
  return out;
}
export function split1000(p: GridParams, code: string, it: { hv: number[]; av: number[]; sig: number; t4?: number }, sd: number[]): GridView {
  const w = weightsFor(p, code), e = gridEval(p, code, it, w);
  const home = Math.round(1000 * e.pHome), lean = home - 500;
  const rel = fittedSplit(w, sd);
  // each row's edge = its share of the margin × the points the margin moves away from 500 (sums to home − 500)
  const homeEdge = !!p.league?.[code]?.home;
  const used = GRID_ROWS.map((r, i) => ({ r, i })).filter(({ i }) => i !== VOL && (Math.abs(w[i]) > 1e-9 || (i === 6 && homeEdge)));
  const tot = e.margin;
  const edges = used.map(({ i }) => (Math.abs(tot) > 1e-6 ? (e.parts[i] / tot) * lean : 0));
  const rounded = edges.map(x => Math.round(x));
  const gap = lean - rounded.reduce((a, b) => a + b, 0);
  if (gap && rounded.length) { let k = 0; for (let j = 1; j < edges.length; j++) if (Math.abs(edges[j]) > Math.abs(edges[k])) k = j; rounded[k] += gap; }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    rows: used.map(({ r, i }, j) => ({ id: r.id, key: r.key, home: r2(it.hv[i] || 0), away: r2(it.av[i] || 0), rel: rel[i], edge: rounded[j] })),
    points: { home, away: 1000 - home },
    unused: GRID_ROWS.filter((_, i) => i !== VOL && Math.abs(w[i]) <= 1e-9 && !(i === 6 && homeEdge)).map(r => r.key),
    volatility: w[VOL] > 0 ? r2(volOf(it)) : null, margin: Math.round(e.margin * 10) / 10, sigma: Math.round(e.sigma * 10) / 10
  };
}

/** spread of every row's home − away difference on the given games (the split's scale and the row-sanity guard) */
export function rowStats(items: GridItem[]): { mean: number[]; sd: number[] } {
  const mean = new Array<number>(N_ROWS).fill(0), sd = new Array<number>(N_ROWS).fill(0);
  if (!items.length) return { mean, sd };
  for (const it of items) for (let i = 0; i < N_ROWS; i++) mean[i] += (i === VOL ? volOf(it) : diff(it, i)) / items.length;
  for (const it of items) for (let i = 0; i < N_ROWS; i++) sd[i] += ((i === VOL ? volOf(it) : diff(it, i)) - mean[i]) ** 2 / items.length;
  return { mean: mean.map(x => Math.round(x * 1e4) / 1e4), sd: sd.map(x => Math.round(Math.sqrt(x) * 1e4) / 1e4) };
}

export const logLoss = (p: GridParams, items: GridItem[]) => {
  let s = 0;
  for (const it of items) { const q = gridEval(p, it.code, it).pHome; s += -(it.y ? Math.log(q) : Math.log(1 - q)); }
  return items.length ? s / items.length : 0;
};

/**
 * Pattern search (v3Tuner's fitVector): try each free parameter up and down, keep the first improvement, halve the
 * steps when a round finds none (stop after 4 halvings). `get` / `set` read and write the parameter in `p`.
 */
async function patternSearch(p: GridParams, items: GridItem[], defs: { get: () => number; set: (v: number) => void; lo: number; hi: number; step: number }[],
  rounds: number, penalty: () => number, pause: () => Promise<void>) {
  const steps = defs.map(d => d.step * 2);
  let f = logLoss(p, items) + penalty();
  let halvings = 0, round = 0;
  for (round = 1; round <= rounds; round++) {
    let improved = false;
    for (let i = 0; i < defs.length; i++) {
      for (const dir of [1, -1]) {
        const old = defs[i].get();
        const nv = Math.min(defs[i].hi, Math.max(defs[i].lo, Math.round((old + dir * steps[i]) * 1e6) / 1e6));
        if (nv === old) continue;
        defs[i].set(nv);
        const fn = logLoss(p, items) + penalty();
        if (fn < f - 1e-9) { f = fn; improved = true; break; }
        defs[i].set(old);
      }
      await pause();
    }
    if (!improved) { halvings++; for (let i = 0; i < steps.length; i++) steps[i] /= 2; if (halvings >= 4) break; }
  }
  return { f, rounds: round };
}

/**
 * Fit the grid on the training games: (1) the shared weights on every league together, (2) a calibration stretch per
 * league, (3) per-league weight offsets where a league has 1,500+ training games (pulled toward 0), (4) the stretch again.
 */
export async function fitGrid(items: GridItem[], start: GridParams, opt: { rounds?: number; minOffsetGames?: number; offsetPenalty?: number; pause?: () => Promise<void> } = {}): Promise<{ params: GridParams; trainLL: number; startLL: number; offsetLeagues: string[] }> {
  const pause = opt.pause || (async () => undefined);
  const p: GridParams = { w: [...start.w], stretch: { ...start.stretch }, offsets: {}, version: 'fit', fittedAt: new Date().toISOString(), train: null, ...(start.miss ? { miss: { ...start.miss } } : {}), ...(start.impact ? { impact: start.impact } : {}) };
  const startLL = logLoss(start, items);
  // fix228: a frozen #4 is never moved (shared weight or league offset): the other rows are fitted around it
  const free = (i: number) => !(p.miss && i === MISS);
  if (p.miss) p.w[MISS] = p.miss.w;
  const wDefs = GRID_ROWS.map((r, i) => ({ i, get: () => p.w[i], set: (v: number) => { p.w[i] = v; }, lo: r.lo, hi: r.hi, step: r.step })).filter(d => free(d.i));
  await patternSearch(p, items, wDefs, opt.rounds ?? 60, () => 0, pause);
  const byCode = new Map<string, GridItem[]>();
  for (const it of items) { let l = byCode.get(it.code); if (!l) byCode.set(it.code, (l = [])); l.push(it); }
  const fitStretch = async () => {
    for (const [code, list] of byCode) {
      if (list.length < 150) { delete p.stretch[code]; continue; }
      await patternSearch(p, list, [{ get: () => p.stretch[code] ?? 1, set: v => { p.stretch[code] = v; }, lo: 0.6, hi: 1.5, step: 0.02 }], 30, () => 0, pause);
    }
  };
  await fitStretch();
  const offsetLeagues: string[] = [];
  const minN = opt.minOffsetGames ?? 1500, lam = opt.offsetPenalty ?? 0.002;
  for (const [code, list] of byCode) {
    if (list.length < minN) continue;
    const off = new Array<number>(N_ROWS).fill(0);
    p.offsets[code] = off;
    const defs = GRID_ROWS.map((r, i) => ({ i, get: () => off[i], set: (v: number) => { off[i] = v; }, lo: r.lo - p.w[i], hi: r.hi - p.w[i], step: r.step })).filter(d => free(d.i));
    // pulled toward 0: an offset has to pay for itself (lam per step², like v3Tuner's lambda)
    await patternSearch(p, list, defs, opt.rounds ?? 60, () => lam * off.reduce((s, x, i) => s + (x / GRID_ROWS[i].step) ** 2, 0) / 100, pause);
    if (off.every(x => Math.abs(x) < 1e-9)) delete p.offsets[code]; else offsetLeagues.push(code);
  }
  await fitStretch();
  return { params: p, trainLL: logLoss(p, items), startLL, offsetLeagues };
}

/* ---------- fix228: row #4 fitted on who actually played ---------- */

/** train / test games of the #4 fit (assertTrainYears: never the live period, never the test season in train) */
export function missSplit<T extends { year: number }>(items: T[], train: number[], test: number): { train: T[]; test: T[] } {
  assertTrainYears(train, test);
  return { train: items.filter(x => train.includes(x.year) && x.year < GRID_LIVE_FROM), test: items.filter(x => x.year === test) };
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
/** a MissSet from the shared settings (the #4 weight live now, no star) */
export const missFrom = (p: GridParams, code = 'NBA'): MissSet =>
  p.miss ? { ...p.miss } : { w: weightsFor(p, code)[MISS], star: 0, proxy: p.w[MISS], fittedAt: '', train: [], test: GRID_TEST };

/**
 * The oracle fit: the NBA's games with #4 = who actually played (missInputs 'oracle'), every weight + the star factor
 * by pattern search on log loss from `start` (the NBA's weights live now). Returns the #4 weight and the star factor;
 * the shared tune then fits the other rows around the frozen #4.
 */
export async function fitMiss(items: GridItem[], start: GridParams, opt: { rounds?: number; pause?: () => Promise<void>; form?: 'star' | 'top' } = {}) {
  const pause = opt.pause || (async () => undefined);
  const code = items[0]?.code || 'NBA';
  const m0 = missFrom(start, code);
  // fix225 'top': the star factor on the top-3 players' part (1.0–1.6, start 1.2) in place of fix228's star form
  if (opt.form === 'top') { m0.star = 0; m0.top = clampTop(m0.top ?? 1.2); } else delete m0.top;
  const p: GridParams = { w: [...weightsFor({ ...start, miss: undefined, league: undefined }, code)], stretch: { ...start.stretch }, offsets: {}, version: 'oracle fit', fittedAt: null, train: null, miss: { ...m0 } };
  p.w[MISS] = m0.w;
  const startLL = logLoss(p, items);
  const R = GRID_ROWS[MISS];
  const defs = [
    { get: () => p.miss!.w, set: (v: number) => { p.miss!.w = v; p.w[MISS] = v; }, lo: 0, hi: R.hi, step: R.step },
    opt.form === 'top'
      ? { get: () => p.miss!.top!, set: (v: number) => { p.miss!.top = v; }, lo: TOP_LO, hi: TOP_HI, step: 0.05 }
      : { get: () => p.miss!.star, set: (v: number) => { p.miss!.star = v; }, lo: 0, hi: 0.5, step: 0.02 },
    ...GRID_ROWS.map((r, i) => ({ i, get: () => p.w[i], set: (v: number) => { p.w[i] = v; }, lo: r.lo, hi: r.hi, step: r.step })).filter(d => d.i !== MISS)
  ];
  await patternSearch(p, items, defs, opt.rounds ?? 60, () => 0, pause);
  return { w: r4(p.miss!.w), star: r4(p.miss!.star), ...(opt.form === 'top' ? { top: r4(p.miss!.top!) } : {}), params: p, startLL: r4(startLL), trainLL: r4(logLoss(p, items)) };
}

/**
 * The proxy weight of the other leagues, fitted the same way (log loss, train seasons) on their own rows (#4 = missed the
 * last 2 games), every other weight as `base` has it; between 0 and the oracle weight (a guess is never worth more than
 * knowing who played).
 */
export async function fitProxy(items: GridItem[], base: GridParams & { miss: MissSet }, opt: { rounds?: number; pause?: () => Promise<void> } = {}) {
  const p: GridParams & { miss: MissSet } = { ...base, miss: { ...base.miss } };
  p.miss.proxy = Math.min(p.miss.proxy, p.miss.w);
  const startLL = logLoss(p, items);
  await patternSearch(p, items, [{ get: () => p.miss.proxy, set: v => { p.miss.proxy = v; }, lo: 0, hi: p.miss.w, step: 0.05 }], opt.rounds ?? 30, () => 0, opt.pause || (async () => undefined));
  return { proxy: r4(p.miss.proxy), startLL: r4(startLL), trainLL: r4(logLoss(p, items)) };
}

export type MissGate = { pass: boolean; reason: string; oracle: { games: number; cur: number; next: number }; whole: { games: number; cur: number; next: number } };
/**
 * fix228 gate on the test season (`test` = missInputs 'oracle': the inputs live has): the NBA's games with who played
 * known must improve (log loss) and every game of every league must be no worse, against the settings live now.
 */
export function missGate(test: GridItem[], next: GridParams, cur: GridParams): MissGate {
  const known = test.filter(x => usesOracle(x.code) && x.oracle !== null);
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const oracle = { games: known.length, cur: r5(logLoss(cur, known)), next: r5(logLoss(next, known)) };
  const whole = { games: test.length, cur: r5(logLoss(cur, test)), next: r5(logLoss(next, test)) };
  const ok1 = known.length >= 100 && logLoss(next, known) < logLoss(cur, known) - 1e-9;
  const ok2 = test.length > 0 && logLoss(next, test) <= logLoss(cur, test) + 1e-9;
  const why = [!ok1 && (known.length < 100 ? `only ${known.length} test games with who played known` : `who played known ${oracle.next} vs ${oracle.cur} now`), !ok2 && `whole season ${whole.next} vs ${whole.cur} now`].filter(Boolean);
  return { pass: ok1 && ok2, reason: ok1 && ok2 ? `who played known ${oracle.cur} → ${oracle.next}; whole season ${whole.cur} → ${whole.next}` : `kept as it is: ${why.join('; ')}`, oracle, whole };
}

/**
 * fix225 gate on the test season: the new impact (and the settings fitted with it) against the settings live now, each
 * on its own inputs as live has them (`curItems` / `nextItems`: NBA #4 = who played). Checks: NBA and Europe, the whole
 * season and games 1–25, and the NBA's games with who played known. Passes when the NBA's whole season and its
 * who-played-known games improve and no check is worse.
 */
export type ImpactCheck = { name: string; games: number; cur: number; next: number; better: boolean; worse: boolean };
export type ImpactGate = { pass: boolean; reason: string; checks: ImpactCheck[] };
export function impactGate(curItems: GridItem[], nextItems: GridItem[], cur: GridParams, next: GridParams, test: number): ImpactGate {
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const ids = (l: GridItem[]) => l.map(x => x.id);
  const by = new Map(nextItems.map(x => [x.id, x]));
  const checks: ImpactCheck[] = [];
  const add = (name: string, sel: (x: GridItem) => boolean, min: number) => {
    const c = curItems.filter(x => x.year === test && sel(x));
    const n = ids(c).map(id => by.get(id)).filter((x): x is GridItem => !!x);
    if (c.length < min || n.length !== c.length) return;
    const a = logLoss(cur, c), b = logLoss(next, n);
    checks.push({ name, games: c.length, cur: r5(a), next: r5(b), better: b < a - 1e-9, worse: b > a + 1e-9 });
  };
  add('NBA whole season', x => x.code === 'NBA', 200);
  add('NBA games 1–25', x => x.code === 'NBA' && x.gp < 25, 50);
  add('NBA who played known', x => x.code === 'NBA' && x.oracle !== null && (by.get(x.id)?.oracle ?? null) !== null, 100);
  add('Europe whole season', x => groupOf(x.code) === 'Europe', 200);
  add('Europe games 1–25', x => groupOf(x.code) === 'Europe' && x.gp < 25, 50);
  const need = ['NBA whole season', 'NBA who played known'];
  const missing = need.filter(n => !checks.some(c => c.name === n));
  const notBetter = checks.filter(c => need.includes(c.name) && !c.better), worse = checks.filter(c => c.worse);
  const pass = !missing.length && !notBetter.length && !worse.length;
  const f = (c: ImpactCheck) => `${c.name} ${c.cur} → ${c.next}`;
  const reason = pass ? `the new values win: ${checks.map(f).join('; ')}`
    : `today's values stay: ${[...missing.map(n => `${n}: too few test games`), ...notBetter.filter(c => !c.worse).map(c => `${f(c)} (not better)`), ...worse.map(c => `${f(c)} (worse)`)].join('; ')}`;
  return { pass, reason, checks };
}
export { WB_START };

/** log loss / Brier / hit rate of bb-v4 and bb-v3 on a set of games (+ "who actually played" in place of #4) */
export function compare(p: GridParams, items: GridItem[]) {
  const ys = items.map(x => x.y);
  const known = items.filter(x => x.oracle !== null);
  return {
    games: items.length,
    v3: scoreP(items.map(x => x.v3), ys),
    v4: scoreP(items.map(x => gridEval(p, x.code, x).pHome), ys),
    oracle: { games: known.length, v3: scoreP(known.map(x => x.v3), known.map(x => x.y)), v4: scoreP(known.map(x => gridEval(p, x.code, { ...x, hv: x.hv.map((v, i) => (i === 3 ? x.oracle! : v)), av: x.av.map((v, i) => (i === 3 ? 0 : v)), t4: x.ot ?? 0 }).pHome), known.map(x => x.y)) }
  };
}

/** League groups for the gate (fix219 brief: the NBA, the European leagues pooled; the rest pooled too). */
export const EUROPE = ['EL', 'EC', 'BCL', 'FEC', 'ACB', 'LBA', 'BSL', 'LNB', 'BBL', 'GBL', 'LKL', 'ABA'];
export const groupOf = (code: string) => (code === 'NBA' ? 'NBA' : EUROPE.includes(code) ? 'Europe' : 'Rest of the world');

/* ---------- fix223: per-league settings (the selection and gate: utils/leagueSettings.ts) ---------- */

/** the 4 big rows a league may move: #1 player impact, #3 team rating (bb-v3's points rating + possessions + talent), #4 missing players, #6 rest */
export const LS_ROWS = [0, 2, 3, 5];
/** shrinkage scale per offset row (a prior worth one game per unit of τ², see utils/leagueSettings.ts) */
export const LS_TAU: Record<number, number> = { 0: 0.1, 2: 0.1, 3: 0.2, 5: 0.5 };
const SIG_N0 = 400;

/** the miss of the model's margin in sigma units (√ mean ((result − margin) / sigma)²), games with a final margin */
export function spreadOf(p: GridParams, items: GridItem[]): { r: number; n: number } {
  let s = 0, n = 0;
  for (const it of items) {
    if (typeof it.mg !== 'number' || !Number.isFinite(it.mg)) continue;
    const e = gridEval(p, it.code, it);
    s += ((it.mg - e.margin) / (e.sigma || 1)) ** 2; n++;
  }
  return { r: n ? Math.sqrt(s / n) : 1, n };
}

/**
 * One league's (or group's) settings fitted on `items` (fit years only: the caller filters): sigma = the items' spread
 * relative to every league's (`all`, same years), shrunk toward 1 with 400 games' worth; then home edge, stretch and the
 * LS_ROWS offsets by pattern search on log loss + the shrinkage toward the shared settings.
 */
export async function fitLeagueSet(items: GridItem[], base: GridParams, all: { r: number }, src: 'own' | 'group', group: string | null,
  opt: { rounds?: number; shrink?: number; pause?: () => Promise<void> } = {}): Promise<LeagueSet> {
  const shared: GridParams = { ...base, league: undefined };
  const sp = spreadOf(shared, items);
  const kRaw = all.r > 0 ? sp.r / all.r : 1;
  const set: LeagueSet = { src, group, home: 0, str: 1, sig: Math.round(((sp.n * kRaw + SIG_N0) / (sp.n + SIG_N0)) * 1e4) / 1e4, off: new Array<number>(N_ROWS).fill(0), n: items.length };
  const p: GridParams = { ...shared, league: Object.fromEntries([...new Set(items.map(x => x.code))].map(c => [c, set])) };
  const defs = [
    { get: () => set.home, set: (v: number) => { set.home = v; }, lo: -4, hi: 4, step: 0.25, tau: 1, at: 0 },
    { get: () => set.str, set: (v: number) => { set.str = v; }, lo: 0.7, hi: 1.4, step: 0.02, tau: 0.1, at: 1 },
    ...LS_ROWS.filter(i => !(base.miss && i === MISS)).map(i => ({ get: () => set.off[i], set: (v: number) => { set.off[i] = v; }, lo: GRID_ROWS[i].lo - base.w[i], hi: GRID_ROWS[i].hi - base.w[i], step: GRID_ROWS[i].step, tau: LS_TAU[i], at: 0 }))
  ];
  await minimize(() => logLoss(p, items) + shrinkPenalty(defs, items.length, opt.shrink ?? 1), defs, { rounds: opt.rounds ?? 30, pause: opt.pause });
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  set.home = r4(set.home); set.str = r4(set.str); set.off = set.off.map(r4);
  return set;
}

/** groups for small leagues (< 400 train games), by the league's country (every country alike) */
const ASIA = /japan|china|korea|philippines|taiwan|taipei|indonesia|lebanon|iran|jordan|qatar|saudi|emirates|uae|bahrain|india|thailand|vietnam|malaysia|hong kong|mongolia|syria|iraq|kuwait|asia/i;
const AMERICAS = /usa|united states|canada|mexico|puerto rico|brazil|argentina|uruguay|chile|venezuela|colombia|dominican|panama|cuba|peru|paraguay|ecuador|bolivia|america/i;
const OCEANIA = /australia|new zealand|oceania/i;
const AFRICA = /africa|egypt|morocco|tunisia|nigeria|senegal|angola|algeria|cameroon/i;
export function regionGroup(country: string | null | undefined): string | null {
  const c = String(country || '').trim();
  if (!c || /^world$/i.test(c)) return null;
  if (OCEANIA.test(c)) return 'Oceania';
  if (ASIA.test(c)) return 'Asia';
  if (AMERICAS.test(c)) return 'Americas';
  if (AFRICA.test(c)) return 'Africa';
  return 'Europe second tier';
}

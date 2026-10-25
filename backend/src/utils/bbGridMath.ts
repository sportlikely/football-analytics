/**
 * fix219 — bb-v4, the basketball grid model (the pure part: no database). Like football v3: every game gets 13 rows,
 * each a value per team as it was before tip-off; margin = Σ weight × (home value − away value) in points;
 * P(home) = Φ(stretch × margin / sigma), sigma = the league's typical miss widened by 3-point volatility (#12).
 * The weights are fitted by the tuner (fitGrid: pattern search on log loss, like v3Tuner), shared by every league, with
 * per-league offsets only for leagues with 1,500+ training games, and a calibration stretch per league.
 * The game page shows the "1,000 points split" (split1000) like football.
 */
import { phi, scoreP } from './nbaImpact';

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
export type GridItem = { id: number; code: string; season: string; year: number; gp: number; y: number; v3: number; sig: number; hv: number[]; av: number[]; oracle: number | null };
export type GridParams = { w: number[]; stretch: Record<string, number>; offsets: Record<string, number[]>; version: string; fittedAt: string | null; train: number[] | null };

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
  const off = p.offsets[code];
  return off ? p.w.map((w, i) => w + (off[i] || 0)) : p.w;
}
/** margin in points (home − away), the contribution of each row, the sigma used and the home win chance */
export function gridEval(p: GridParams, code: string, it: { hv: number[]; av: number[]; sig: number }, w = weightsFor(p, code)) {
  const parts = new Array<number>(N_ROWS).fill(0);
  let m = 0;
  for (let i = 0; i < N_ROWS; i++) { if (i === VOL) continue; parts[i] = w[i] * diff(it, i); m += parts[i]; }
  const sig = it.sig * Math.min(1.5, Math.max(0.7, 1 + w[VOL] * volOf(it)));
  const pHome = clampP(phi(((p.stretch[code] ?? 1) * m) / sig));
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
export function split1000(p: GridParams, code: string, it: { hv: number[]; av: number[]; sig: number }, sd: number[]): GridView {
  const w = weightsFor(p, code), e = gridEval(p, code, it, w);
  const home = Math.round(1000 * e.pHome), lean = home - 500;
  const rel = fittedSplit(w, sd);
  // each row's edge = its share of the margin × the points the margin moves away from 500 (sums to home − 500)
  const used = GRID_ROWS.map((r, i) => ({ r, i })).filter(({ i }) => i !== VOL && Math.abs(w[i]) > 1e-9);
  const tot = e.margin;
  const edges = used.map(({ i }) => (Math.abs(tot) > 1e-6 ? (e.parts[i] / tot) * lean : 0));
  const rounded = edges.map(x => Math.round(x));
  const gap = lean - rounded.reduce((a, b) => a + b, 0);
  if (gap && rounded.length) { let k = 0; for (let j = 1; j < edges.length; j++) if (Math.abs(edges[j]) > Math.abs(edges[k])) k = j; rounded[k] += gap; }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    rows: used.map(({ r, i }, j) => ({ id: r.id, key: r.key, home: r2(it.hv[i] || 0), away: r2(it.av[i] || 0), rel: rel[i], edge: rounded[j] })),
    points: { home, away: 1000 - home },
    unused: GRID_ROWS.filter((_, i) => i !== VOL && Math.abs(w[i]) <= 1e-9).map(r => r.key),
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
  const p: GridParams = { w: [...start.w], stretch: { ...start.stretch }, offsets: {}, version: 'fit', fittedAt: new Date().toISOString(), train: null };
  const startLL = logLoss(start, items);
  const wDefs = GRID_ROWS.map((r, i) => ({ get: () => p.w[i], set: (v: number) => { p.w[i] = v; }, lo: r.lo, hi: r.hi, step: r.step }));
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
    const defs = GRID_ROWS.map((r, i) => ({ get: () => off[i], set: (v: number) => { off[i] = v; }, lo: r.lo - p.w[i], hi: r.hi - p.w[i], step: r.step }));
    // pulled toward 0: an offset has to pay for itself (lam per step², like v3Tuner's lambda)
    await patternSearch(p, list, defs, opt.rounds ?? 60, () => lam * off.reduce((s, x, i) => s + (x / GRID_ROWS[i].step) ** 2, 0) / 100, pause);
    if (off.every(x => Math.abs(x) < 1e-9)) delete p.offsets[code]; else offsetLeagues.push(code);
  }
  await fitStretch();
  return { params: p, trainLL: logLoss(p, items), startLL, offsetLeagues };
}

/** log loss / Brier / hit rate of bb-v4 and bb-v3 on a set of games (+ "who actually played" in place of #4) */
export function compare(p: GridParams, items: GridItem[]) {
  const ys = items.map(x => x.y);
  const known = items.filter(x => x.oracle !== null);
  return {
    games: items.length,
    v3: scoreP(items.map(x => x.v3), ys),
    v4: scoreP(items.map(x => gridEval(p, x.code, x).pHome), ys),
    oracle: { games: known.length, v3: scoreP(known.map(x => x.v3), known.map(x => x.y)), v4: scoreP(known.map(x => gridEval(p, x.code, { ...x, hv: x.hv.map((v, i) => (i === 3 ? x.oracle! : v)), av: x.av.map((v, i) => (i === 3 ? 0 : v)) }).pHome), known.map(x => x.y)) }
  };
}

/** League groups for the gate (fix219 brief: the NBA, the European leagues pooled; the rest pooled too). */
export const EUROPE = ['EL', 'EC', 'BCL', 'FEC', 'ACB', 'LBA', 'BSL', 'LNB', 'BBL', 'GBL', 'LKL', 'ABA'];
export const groupOf = (code: string) => (code === 'NBA' ? 'NBA' : EUROPE.includes(code) ? 'Europe' : 'Rest of the world');

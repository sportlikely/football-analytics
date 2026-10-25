/**
 * fix225 — box-score value per player (BPM-style) and the pieces that turn it into the player impact the bb-v4 grid
 * reads (the pure part: no database). Used by services/bbGrid.ts (the walk-forward replay), services/bbTuner.ts (the
 * fit and the gate) and the tests (scripts/fix225.test.mjs).
 *
 * Why (live test 25 Oct on 3 NBA seasons): game-level on/off ratings blur a star with his teammates (Jokić +3.0–4.4,
 * Payton Pritchard #2) because we have minutes per game, not who shared the floor. The box score says who produced.
 *
 *  - Rates: points, shot attempts (FGA + 0.44 FTA: the efficiency term), 3-pointers made, rebounds, assists — per game
 *    length (48 NBA / CBA, 40 FIBA: the same formula for every league), × league pace / team pace. Steals, blocks and
 *    turnovers are not in our player box scores (API-Basketball gives them per team only): the team adjustment carries
 *    the team's share of them.
 *  - Raw value = Σ coef × (rate − the league-season's minutes-weighted mean): points of margin per game length against an
 *    average player. The coefficients are fitted on game margins (fitBoxCoef: the players' season rates without the
 *    game itself, 2022-23 … 2024-25 only, every league pooled).
 *  - Team adjustment: one constant per team-season added to its players so that Σ value × minutes / (games × L) = the
 *    team's opponent-adjusted net rating per game (BPM's rule: the players' values add up to the team).
 *  - Carry-over: last season's value (any team: traded players keep theirs) blended with this season's by minutes, full
 *    weight at ~800 minutes (40-minute leagues 667); no last season → the prior (NBA: draft slot, else −1).
 *  - Player impact = wb × box value + (1 − wb) × on/off rating; the on/off ridge shrinks each player by
 *    lambda × 1,000 / his minutes (capped): high-minute stars barely, a 100-minute player hard.
 *  - Star factor (row #4): the part of a team's lost impact that comes from its top-3 players counts × factor (1.0–1.6).
 */

/** Season (or game) totals of one player: minutes and the counting stats the formula reads. */
export type BoxTot = { min: number; pts: number; fga: number; fta: number; tpm: number; reb: number; ast: number };
export const BOX_FEATS = ['points', 'shot attempts (FGA + 0.44 FTA)', '3-pointers made', 'rebounds', 'assists'] as const;
export const N_FEAT = BOX_FEATS.length;

/** The formula: one coefficient per rate (points of margin per unit of rate above the league mean). */
export type BoxCoef = { c: number[]; version: string; fittedAt: string | null; train: number[] | null; games: number; ll?: number | null };
/**
 * Before the first fit on a database: a points-over-shots form close to public box-score models (≈ +1 per point scored
 * above 1.07 points per shot attempt, assists and rebounds worth part of a point). The fit replaces it.
 */
export const BOX_DEFAULT: BoxCoef = { c: [0.75, -0.7, 0.3, 0.25, 0.55], version: 'default', fittedAt: null, train: null, games: 0 };
/** Seasons the formula may be fitted on (start years); the test season (2025) and the live period (2026+) never. */
export const BOX_TRAIN = [2022, 2023, 2024];
export function assertBoxTrain(years: number[]) {
  for (const y of years) if (!BOX_TRAIN.includes(y)) throw new Error(`box-score formula fitted on ${y}: only ${BOX_TRAIN.join(', ')} are allowed`);
}

export const emptyTot = (): BoxTot => ({ min: 0, pts: 0, fga: 0, fta: 0, tpm: 0, reb: 0, ast: 0 });
export function addTot(t: BoxTot, x: BoxTot, sign = 1) {
  t.min += sign * x.min; t.pts += sign * x.pts; t.fga += sign * x.fga; t.fta += sign * x.fta; t.tpm += sign * x.tpm; t.reb += sign * x.reb; t.ast += sign * x.ast;
  return t;
}
/** rates per game length (L minutes), pace-adjusted (league pace / team pace); null under 1 minute */
export function ratesOf(t: BoxTot, L: number, paceAdj = 1): number[] | null {
  if (!(t.min >= 1)) return null;
  const k = (L / t.min) * paceAdj;
  return [t.pts * k, (t.fga + 0.44 * t.fta) * k, t.tpm * k, t.reb * k, t.ast * k];
}
/** the league's minutes-weighted mean rates (pace-adjusted) */
export function leagueRates(list: { tot: BoxTot; paceAdj: number }[], L: number): number[] {
  const s = new Array<number>(N_FEAT).fill(0);
  let m = 0;
  for (const x of list) { const r = ratesOf(x.tot, L, x.paceAdj); if (!r) continue; for (let k = 0; k < N_FEAT; k++) s[k] += r[k] * x.tot.min; m += x.tot.min; }
  return m > 0 ? s.map(v => v / m) : s;
}
export const rawValue = (c: number[], rates: number[], lg: number[]) => rates.reduce((s, r, k) => s + (c[k] || 0) * (r - lg[k]), 0);

/** One stint = a player's totals for one team in one season. */
export type Stint = { id: number; team: number; tot: BoxTot };
/**
 * Box values of a season's stints: raw value + the team adjustment so that Σ value × minutes / (games × L) equals the
 * team's net rating per game (`net`, opponent-adjusted points per game; `games` = the team's games in those totals).
 * A player with several teams gets the minutes-weighted mean of his stints. Returns value and minutes per player.
 */
export function stintValues(stints: Stint[], c: number[], L: number, lg: number[], paceAdj: Map<number, number>, net: Map<number, number>, games: Map<number, number>): Map<number, { v: number; min: number }> {
  const byTeam = new Map<number, { s: Stint; raw: number }[]>();
  for (const s of stints) {
    const r = ratesOf(s.tot, L, paceAdj.get(s.team) ?? 1);
    if (!r) continue;
    let l = byTeam.get(s.team); if (!l) byTeam.set(s.team, (l = [])); l.push({ s, raw: rawValue(c, r, lg) });
  }
  const acc = new Map<number, { vm: number; min: number }>();
  for (const [team, list] of byTeam) {
    const G = games.get(team) || 0;
    const adj = G > 0 ? teamAdjust(list.map(x => ({ raw: x.raw, min: x.s.tot.min })), net.get(team) ?? 0, G, L) : 0;
    for (const x of list) {
      const v = x.raw + adj;
      const a = acc.get(x.s.id) || { vm: 0, min: 0 };
      a.vm += v * x.s.tot.min; a.min += x.s.tot.min;
      acc.set(x.s.id, a);
    }
  }
  return new Map([...acc].map(([id, a]) => [id, { v: a.vm / a.min, min: a.min }]));
}
/** the constant that makes Σ (raw + adj) × min / (games × L) = net (points per game) */
export function teamAdjust(players: { raw: number; min: number }[], net: number, games: number, L: number): number {
  const share = players.reduce((s, p) => s + p.min, 0) / (games * L); // ≈ 5 (five on the floor)
  if (!(share > 0)) return 0;
  const sum = players.reduce((s, p) => s + (p.raw * p.min) / (games * L), 0);
  return (net - sum) / share;
}

/** Minutes at which this season's value has full weight (NBA 800; 40-minute leagues scaled: 667). */
export const fullMinutes = (L: number) => Math.round((800 * L) / 48);
/** this season's value blended with last season's (or the prior) by minutes */
export function carry(cur: { v: number; min: number } | undefined, prev: number, full: number): number {
  if (!cur || !(cur.min > 0)) return prev;
  const w = Math.min(1, cur.min / full);
  return w * cur.v + (1 - w) * prev;
}
/** A player with no value yet: NBA draft slot (pick 1 ≈ 0, pick 30 ≈ −1.9, 2nd round / undrafted −2), else −1. */
export const NO_PRIOR = -1;
export function draftPrior(pick: number | null | undefined, round: number | null | undefined): number {
  if (!pick || !(pick > 0) || (round !== null && round !== undefined && round > 1) || pick > 30) return pick === undefined ? NO_PRIOR : -2;
  return Math.round((-2 + (2 * (31 - pick)) / 30) * 100) / 100;
}

/** On/off shrink per player: lambda × 1,000 / his (season-weighted) minutes, between 0.1 × and 3 × lambda. */
export const SHRINK_LO = 0.1, SHRINK_HI = 3;
export function shrinkLambda(lambda: number, minutes: number): number {
  const x = (lambda * 1000) / Math.max(1, minutes);
  return Math.min(lambda * SHRINK_HI, Math.max(lambda * SHRINK_LO, x));
}

/** the blend (wb = the box-score share, fitted by the tuner; start 0.6) */
export const WB_START = 0.6;
export const blendRating = (box: number, onoff: number, wb: number) => wb * box + (1 - wb) * onoff;

/** Star factor bounds (row #4: a top-3 player's loss × factor) */
export const TOP_LO = 1, TOP_HI = 1.6, TOP_N = 3;
export const clampTop = (f: number) => Math.min(TOP_HI, Math.max(TOP_LO, f));
/** #4 with the star factor: the whole loss, the top-3 part counted `f` times */
export const topLoss = (loss: number, lossTop: number, f: number) => loss + (clampTop(f) - 1) * lossTop;
/** a team's top-3 by box value × projected minutes (the star factor's players) */
export function topIds(players: { id: number; box: number; min: number }[], n = TOP_N): Set<number> {
  return new Set([...players].filter(p => p.min > 0).sort((a, b) => b.box * b.min - a.box * a.min || a.id - b.id).slice(0, n).map(p => p.id));
}

/**
 * The formula's coefficients from game margins: margin = home + Σ_home (min / L) × c · z − Σ_away (min / L) × c · z,
 * z = a player's season rates without this game, pace-adjusted, minus the league mean (players under 50 such minutes
 * count as average: z = 0). Weighted least squares with a small ridge (the rates are correlated). Returns c and the
 * fitted home edge.
 */
export type BoxFitGame = { home: [number, number[]][]; away: [number, number[]][]; L: number; margin: number; w?: number };
export function fitBoxCoef(games: BoxFitGame[], ridge = 0.01): { c: number[]; home: number; games: number; rmse: number } {
  const n = N_FEAT + 1;
  const A = new Float64Array(n * n), b = new Float64Array(n);
  const xs: number[][] = [];
  for (const g of games) {
    const x = new Array<number>(n).fill(0);
    for (const [min, z] of g.home) for (let k = 0; k < N_FEAT; k++) x[k] += (min / g.L) * z[k];
    for (const [min, z] of g.away) for (let k = 0; k < N_FEAT; k++) x[k] -= (min / g.L) * z[k];
    x[N_FEAT] = 1;
    const w = g.w ?? 1;
    for (let i = 0; i < n; i++) { b[i] += w * x[i] * g.margin; for (let j = 0; j < n; j++) A[i * n + j] += w * x[i] * x[j]; }
    xs.push(x);
  }
  if (games.length < 50) return { c: [...BOX_DEFAULT.c], home: 0, games: games.length, rmse: 0 };
  const diag = (Array.from({ length: N_FEAT }, (_, i) => A[i * n + i]).reduce((s, v) => s + v, 0) / N_FEAT) || 1;
  for (let i = 0; i < N_FEAT; i++) A[i * n + i] += ridge * diag;
  A[n * n - 1] += 1e-6;
  const beta = solve(A, b, n);
  let se = 0;
  games.forEach((g, i) => { const f = xs[i].reduce((s, v, k) => s + v * beta[k], 0); se += (g.margin - f) ** 2; });
  return { c: Array.from(beta.slice(0, N_FEAT), v => Math.round(v * 1e4) / 1e4), home: Math.round(beta[N_FEAT] * 1e3) / 1e3, games: games.length, rmse: Math.round(Math.sqrt(se / games.length) * 1e3) / 1e3 };
}
/** Gaussian elimination with partial pivoting (small systems) */
function solve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const M = Array.from({ length: n }, (_, i) => [...Array.from(A.slice(i * n, i * n + n)), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / d; if (!f) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return Float64Array.from(M.map((row, i) => row[n] / (row[i] || 1e-12)));
}

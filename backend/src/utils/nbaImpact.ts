/**
 * fix217 — NBA model v4, the pure part (no database): player impact ratings, projected minutes, team strength and the
 * final margin. Used by services/nbaV4.ts (the walk-forward replay in the bb model thread, the live predictions, the
 * pre-tip re-pricing) and by the tests.
 *
 *  - Player impact: ridge regression of every regular-season game's final margin on who played how long (home players
 *    +minutes/48, away players −minutes/48, plus a home term), the last 3 seasons, each season back weighted ×0.5,
 *    penalty lambda on the players only. A rating is points of margin per 48 minutes against an average player.
 *  - Team strength for a game = Σ rating × projected minutes / 48 over the top 10 of the rotation, scaled to 240 minutes.
 *  - Final margin = wTeam × team rating margin (bb-v3, neutral court) + wImpact × player-impact margin + home − b2b;
 *    P(home) = Φ(margin / sigma).
 */

/** One game for the ridge fit: [player id, minutes] per side, final margin (home − away), weight. */
export type FitGame = { home: [number, number][]; away: [number, number][]; margin: number; w: number };
export type ImpactFit = { ratings: Map<number, number>; home: number; players: number; games: number };

/**
 * Ridge fit by the normal equations ((XᵀWX + λI) β = XᵀWy, the home term not penalised), solved by Cholesky.
 * ~900 players over 3 seasons: one dense solve takes well under a second.
 */
export function ridgeFit(games: FitGame[], lambda: number): ImpactFit {
  const idx = new Map<number, number>();
  for (const g of games) for (const side of [g.home, g.away]) for (const [p] of side) if (!idx.has(p)) idx.set(p, idx.size);
  const P = idx.size, n = P + 1; // last column = home term
  const A = new Float64Array(n * n), b = new Float64Array(n);
  const xi: number[] = [], xv: number[] = [];
  for (const g of games) {
    xi.length = 0; xv.length = 0;
    for (const [p, m] of g.home) { xi.push(idx.get(p)!); xv.push(m / 48); }
    for (const [p, m] of g.away) { xi.push(idx.get(p)!); xv.push(-m / 48); }
    xi.push(P); xv.push(1);
    for (let i = 0; i < xi.length; i++) {
      const wi = g.w * xv[i];
      b[xi[i]] += wi * g.margin;
      for (let j = 0; j < xi.length; j++) A[xi[i] * n + xi[j]] += wi * xv[j];
    }
  }
  for (let i = 0; i < P; i++) A[i * n + i] += lambda;
  A[P * n + P] += 1e-6;
  const beta = choleskySolve(A, b, n);
  const ratings = new Map<number, number>();
  for (const [p, i] of idx) ratings.set(p, beta[i]);
  return { ratings, home: beta[P], players: P, games: games.length };
}

/** Solve A x = b for a symmetric positive definite A (row-major n × n; A is overwritten). */
export function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let j = 0; j < n; j++) {
    const rj = j * n;
    let s = A[rj + j];
    for (let k = 0; k < j; k++) s -= A[rj + k] * A[rj + k];
    const d = Math.sqrt(Math.max(s, 1e-12));
    A[rj + j] = d;
    for (let i = j + 1; i < n; i++) {
      const ri = i * n;
      let t = A[ri + j];
      for (let k = 0; k < j; k++) t -= A[ri + k] * A[rj + k];
      A[ri + j] = t / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= A[i * n + k] * y[k]; y[i] = s / A[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= A[k * n + i] * x[k]; x[i] = s / A[i * n + i]; }
  return x;
}

/** Injury report status → share of a player's minutes he keeps (Out 0, Doubtful 25%, Questionable 60%). */
export function statusKeep(status: string): number {
  const x = String(status || '').toLowerCase();
  if (/out|suspend|inactive/.test(x)) return 0;
  if (/doubt/.test(x)) return 0.25;
  if (/question|day-to-day|game.?time/.test(x)) return 0.6;
  return 1;
}

export type RotPlayer = { id: number; min: number; rating: number };
const ROT = 10, TEAM_MIN = 240, CAP = 42;

/**
 * The rotation for a game: each player's projected minutes × the share he keeps (injury report / line-up), the top 10,
 * scaled to 240 minutes (no one above 42; what a capped player can't take goes to the others). Minutes an injured
 * player loses go to the next players in the rotation: the 11th man moves into the top 10 and everyone's share grows.
 */
export function rotation(players: RotPlayer[], keep: Map<number, number> = new Map()): (RotPlayer & { proj: number })[] {
  const list = players.map(p => ({ ...p, min: p.min * (keep.has(p.id) ? keep.get(p.id)! : 1) }))
    .filter(p => p.min > 0).sort((a, b) => b.min - a.min || a.id - b.id).slice(0, ROT);
  if (!list.length) return [];
  const out = list.map(p => ({ ...p, proj: p.min }));
  // water-filling: scale the uncapped players until the team has 240 minutes (or everyone is at the cap)
  for (let it = 0; it < ROT; it++) {
    const fixed = out.filter(p => p.proj >= CAP - 1e-9).reduce((s, p) => s + CAP, 0);
    const free = out.filter(p => p.proj < CAP - 1e-9);
    const freeMin = free.reduce((s, p) => s + p.proj, 0);
    if (!free.length || freeMin <= 0) break;
    const f = (TEAM_MIN - fixed) / freeMin;
    let capped = false;
    for (const p of free) { p.proj *= f; if (p.proj > CAP) { p.proj = CAP; capped = true; } }
    if (!capped) break;
  }
  return out;
}

/** Team strength: Σ rating × minutes / 48 over the rotation (points of margin against a team of average players). */
export const strength = (rot: { rating: number; proj: number }[]) => rot.reduce((s, p) => s + (p.rating * p.proj) / 48, 0);

/**
 * v4 settings. The numbers that combine the parts are tuned on 2023-24 + 2024-25 only (2022-23 is the first season in
 * our database: the ridge fit has no earlier seasons there, it is the warm-up); 2025-26 is the test season; 2026-27 is
 * never used for tuning (assertTuneSeasons).
 *  - wTeam0 → wTeam1 over the first rampN games: weight of the team part = bb-v3's whole prediction as a margin
 *    (TEAM_SCALE × probit of its home win chance: ratings, its home edge, rest, player talent). The neutral-court rating
 *    gap alone (V4_SPEC's first idea) lost on the tune seasons: log loss 0.6040 against 0.6004.
 *  - wImpact: weight of the player-impact margin of the projected rotations.
 *  - wSame: weight of what same-day information changes in the player-impact margin (injury report, line-ups). Tuned with
 *    who really played as the stand-in (we hold no old injury reports): knowing it is worth much more than the
 *    projected rotation (1.4 against 0.2; Questionable / Doubtful already count only part of a player).
 *  - home / b2b: extra home edge and back-to-back on top of bb-v3's own.
 */
export type V4Params = { wTeam0: number; wTeam1: number; rampN: number; wImpact: number; wSame: number; home: number; b2b: number; sigma: number; lambda: number; decay: number; rookie: number };
/** Yarin's starting numbers (fix217 brief). */
export const V4_SPEC: V4Params = { wTeam0: 0.6, wTeam1: 0.5, rampN: 15, wImpact: 0.6, wSame: 0.6, home: 1.5, b2b: 1.5, sigma: 12, lambda: 30, decay: 0.5, rookie: -1 };
/** Live numbers: tuneV4 on 2023-24 + 2024-25 (research 25 Oct 2026, 10 Oct database; table in docs/notes/basketball.md). */
export const V4_TUNED: V4Params = { wTeam0: 0.6, wTeam1: 0.75, rampN: 15, wImpact: 0.2, wSame: 1.4, home: 0.5, b2b: 0.5, sigma: 12, lambda: 30, decay: 0.5, rookie: -1 };
/** bb-v3's home win chance as a margin: TEAM_SCALE × probit(p). */
export const TEAM_SCALE = 12;

/** The team-part weight for a game: wTeam0 at a team's first game of the season → wTeam1 after rampN games. */
export const teamWeight = (p: V4Params, gamesPlayed: number) => p.wTeam0 + (p.wTeam1 - p.wTeam0) * Math.min(1, Math.max(0, gamesPlayed) / p.rampN);

/** teamMargin = TEAM_SCALE × probit(bb-v3 home win chance); sameDay = impact margin with same-day information − without. */
export type V4Inputs = { teamMargin: number; impactMargin: number; sameDay: number; b2bHome: boolean; b2bAway: boolean; gamesPlayed: number };
/** Final v4 margin and home win chance. */
export function v4Margin(p: V4Params, x: V4Inputs): { margin: number; pHome: number } {
  const margin = teamWeight(p, x.gamesPlayed) * x.teamMargin + p.wImpact * x.impactMargin + p.wSame * x.sameDay + p.home - (x.b2bHome ? p.b2b : 0) + (x.b2bAway ? p.b2b : 0);
  return { margin, pHome: Math.min(0.995, Math.max(0.005, phi(margin / p.sigma))) };
}
/** "Re-pricing only" (the gate failed): bb-v3's prediction moved by the same-day part alone. */
export function repriceOnly(p: V4Params, v3p: number, sameDay: number): { margin: number; pHome: number } {
  const margin = TEAM_SCALE * probit(v3p) + p.wSame * sameDay;
  return { margin, pHome: Math.min(0.995, Math.max(0.005, phi(margin / TEAM_SCALE))) };
}

/** Inverse normal curve (Acklam, same as bbModel). */
export function probit(p: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - 0.02425) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5, t = r * r;
  return (((((a[0] * t + a[1]) * t + a[2]) * t + a[3]) * t + a[4]) * t + a[5]) * r / (((((b[0] * t + b[1]) * t + b[2]) * t + b[3]) * t + b[4]) * t + 1);
}

/** Normal curve (Abramowitz–Stegun, same as bbModel). */
export function phi(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const q = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const c = 1 - 0.3989422804014327 * Math.exp(-x * x / 2) * q;
  return x >= 0 ? c : 1 - c;
}

/** Seasons the v4 settings may be tuned on (fix217: 2022-23 … 2024-25; the default is the last two). 2025-26 = test, 2026-27 = live: never. */
export const V4_TUNE_SEASONS = ['2022-2023', '2023-2024', '2024-2025'];
export const V4_TEST_SEASON = '2025-2026';
export const V4_TUNE_DEFAULT = ['2023-2024', '2024-2025'];
export function assertTuneSeasons(seasons: string[]) {
  for (const s of seasons) if (!V4_TUNE_SEASONS.includes(s)) throw new Error(`v4 tuning on ${s} is not allowed (tune seasons: ${V4_TUNE_SEASONS.join(', ')})`);
}

/** Days between refits; the first fit of a season is on its first regular-season day. */
export const REFIT_DAYS = 14;

/* ---------- the walk-forward replay (every NBA game in order; only what was known before tip-off) ---------- */

export type RGame = { id: number; season: string; ms: number; home: number; away: number; hs: number | null; as_: number | null; finished: boolean; pre: boolean; rs: boolean };
/** A box-score line: game, team, player, minutes. */
export type RLine = [number, number, number, number];
/** bb-v3 for a game (walk-forward): neutral-court team rating margin, back-to-backs, its own home win chance. */
export type RBase = { nm: number; b2bH: boolean; b2bA: boolean; p: number };
/** teamMargin = bb-v3 as a margin; neutral = its rating gap alone; known = the impact margin of the players who did play (research). */
export type RRow = { id: number; season: string; ms: number; rs: boolean; teamMargin: number; neutral: number; impactMargin: number; known: number | null; b2bH: boolean; b2bA: boolean; gp: number; y: number; v3: number };

/** Projected minutes: the last 15 regular-season games (any team); no regular-season games yet → pre-season × 0.7. */
export function projMinutes(rs: number[] | undefined, pre: number[] | undefined): number | null {
  if (rs && rs.length) return rs.reduce((a, b) => a + b, 0) / rs.length;
  if (pre && pre.length) return (0.7 * pre.reduce((a, b) => a + b, 0)) / pre.length;
  return null;
}

/** Everything the live predictions need after the replay (published to the processes that predict). */
export type V4State = {
  ratings: Map<number, number>; fitAt: number | null; fitPlayers: number; fitGames: number; fitHome: number;
  rs: Map<number, number[]>; pre: Map<number, number[]>; preSeason: string | null;
  rosters: Map<number, number[]>; gp: Map<string, number>;
};

export const seasonIndex = (s: string) => parseInt(s.slice(0, 4), 10);

/**
 * Replay every NBA game in order. Before each finished game: the rotation of both teams from what was known then
 * (players of the team's last 3 games, projected minutes, ratings of the latest fit) and the bb-v3 base → one row.
 * After it the box score joins the history. Refit: at a season's first regular-season game, then every 14 days.
 * Pre-season games give rosters and pre-season minutes, never ratings. A game not played yet never triggers a refit.
 * pause: awaited after each fit and every 500 games (the worker gives way).
 */
export async function replayV4(games: RGame[], lines: RLine[], base: Map<number, RBase>, p: V4Params, pause: () => Promise<void> = async () => undefined): Promise<{ rows: RRow[]; state: V4State }> {
  const byGame = new Map<number, RLine[]>();
  for (const l of lines) { let x = byGame.get(l[0]); if (!x) byGame.set(l[0], (x = [])); x.push(l); }
  const fitRows: (FitGame & { s: number })[] = [];
  let fit: ImpactFit | null = null, fitAt: number | null = null, nextFit = Infinity, fitSeason = '';
  const rs = new Map<number, number[]>(), pre = new Map<number, number[]>();
  let preSeason: string | null = null;
  const rosters = new Map<number, number[][]>();
  const gp = new Map<string, number>();
  const rows: RRow[] = [];
  const doFit = (g: RGame) => {
    const cur = seasonIndex(g.season);
    const use = fitRows.filter(r => r.s >= cur - 2 && r.s <= cur).map(r => ({ ...r, w: Math.pow(p.decay, cur - r.s) }));
    if (use.length < 50) return;
    fit = ridgeFit(use, p.lambda);
    fitAt = g.ms;
  };
  // only: the players who did play (research: what knowing the line-up is worth), else the roster of the last 3 games
  const side = (team: number, only?: Set<number>) => {
    const ids = only || new Set<number>();
    if (!only) for (const r of rosters.get(team) || []) for (const id of r) ids.add(id);
    const out: RotPlayer[] = [];
    for (const id of ids) {
      const m = projMinutes(rs.get(id), preSeason ? pre.get(id) : undefined);
      if (m === null) continue;
      out.push({ id, min: m, rating: fit ? (fit.ratings.get(id) ?? p.rookie) : 0 });
    }
    return out;
  };
  let i = 0;
  for (const g of games) {
    if (++i % 500 === 0) await pause();
    if (g.rs && g.finished && (fitSeason !== g.season || g.ms >= nextFit)) {
      doFit(g);
      await pause();
      fitSeason = g.season;
      nextFit = Math.floor(g.ms / 86400000) * 86400000 + REFIT_DAYS * 86400000; // 14 days after the fit day (UTC)
    }
    if (g.pre && preSeason !== g.season) { preSeason = g.season; pre.clear(); }
    if (!g.finished) continue;
    const b = base.get(g.id);
    const ls = byGame.get(g.id);
    if (b && fit && !g.pre) {
      const im = strength(rotation(side(g.home))) - strength(rotation(side(g.away)));
      const played = (t: number) => new Set((ls || []).filter(l => l[1] === t && l[3] > 0).map(l => l[2]));
      const ph = played(g.home), pa = played(g.away);
      const known = ph.size >= 5 && pa.size >= 5 ? strength(rotation(side(g.home, ph))) - strength(rotation(side(g.away, pa))) : null;
      rows.push({ id: g.id, season: g.season, ms: g.ms, rs: g.rs, teamMargin: TEAM_SCALE * probit(b.p), neutral: b.nm, impactMargin: im, known, b2bH: b.b2bH, b2bA: b.b2bA, gp: Math.min(gp.get(`${g.home}|${g.season}`) || 0, gp.get(`${g.away}|${g.season}`) || 0), y: g.hs! > g.as_! ? 1 : 0, v3: b.p });
    }
    if (ls && ls.length) {
      const h: [number, number][] = [], a: [number, number][] = [];
      const per = new Map<number, number[]>();
      for (const [, team, pid, min] of ls) {
        if (!(min > 0)) continue;
        if (team === g.home) h.push([pid, min]); else if (team === g.away) a.push([pid, min]); else continue;
        let x = per.get(team); if (!x) per.set(team, (x = [])); x.push(pid);
        if (g.rs) { let r = rs.get(pid); if (!r) rs.set(pid, (r = [])); r.push(min); if (r.length > 15) r.shift(); }
        else if (g.pre) { let r = pre.get(pid); if (!r) pre.set(pid, (r = [])); r.push(min); }
      }
      for (const [team, ids] of per) { const r = rosters.get(team) || []; r.push(ids); if (r.length > 3) r.shift(); rosters.set(team, r); }
      if (g.rs && h.length >= 5 && a.length >= 5) fitRows.push({ home: h, away: a, margin: g.hs! - g.as_!, w: 1, s: seasonIndex(g.season) });
    }
    if (g.rs) for (const t of [g.home, g.away]) { const k = `${t}|${g.season}`; gp.set(k, (gp.get(k) || 0) + 1); }
  }
  const f = fit as ImpactFit | null;
  return {
    rows,
    state: {
      ratings: f ? f.ratings : new Map(), fitAt, fitPlayers: f ? f.players : 0, fitGames: f ? f.games : 0, fitHome: f ? f.home : 0,
      rs, pre, preSeason, rosters: new Map([...rosters].map(([t, r]) => [t, [...new Set(r.flat())]])), gp
    }
  };
}

/** Log loss / Brier / hit rate of home win chances against results. */
export function scoreP(ps: number[], ys: number[]) {
  let ll = 0, br = 0, hit = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = Math.min(0.995, Math.max(0.005, ps[i])), y = ys[i];
    ll += -(y ? Math.log(p) : Math.log(1 - p)); br += (p - y) ** 2; hit += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
  }
  const n = ps.length || 1;
  return { games: ps.length, logLoss: Math.round((ll / n) * 10000) / 10000, brier: Math.round((br / n) * 10000) / 10000, hitRate: Math.round((hit / n) * 1000) / 10 };
}

/** A replay row's v4 chance; withKnown = who really played stands in for the same-day information (research / tuning). */
export const rowP = (p: V4Params, r: RRow, withKnown = false) => v4Margin(p, { teamMargin: r.teamMargin, impactMargin: r.impactMargin, sameDay: withKnown && r.known !== null ? r.known - r.impactMargin : 0, b2bHome: r.b2bH, b2bAway: r.b2bA, gamesPlayed: r.gp }).pHome;

/** Coordinate search of the combining numbers on the tune seasons only (the replay rows don't depend on them). */
export function tuneV4(rows: RRow[], start: V4Params, seasons: string[] = V4_TUNE_DEFAULT): V4Params {
  assertTuneSeasons(seasons);
  const use = rows.filter(r => seasons.includes(r.season));
  if (use.length < 300) return start;
  const ll = (q: V4Params) => { let s = 0; for (const r of use) { const pr = rowP(q, r, true); s += -(r.y ? Math.log(pr) : Math.log(1 - pr)); } return s / use.length; };
  let best = { ...start }, bestLL = ll(best);
  const steps: [keyof V4Params, number[]][] = [
    ['wTeam0', [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1]], ['wTeam1', [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1]],
    ['wImpact', [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]], ['wSame', [0, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 2]],
    ['home', [-1, -0.5, 0, 0.5, 1, 1.5]], ['b2b', [-1, -0.5, 0, 0.5, 1, 1.5]]
  ];
  for (let round = 0; round < 3; round++) for (const [k, vals] of steps) for (const v of vals) {
    const q = { ...best, [k]: v };
    const x = ll(q);
    if (x < bestLL - 1e-7) { best = q; bestLL = x; }
  }
  return best;
}

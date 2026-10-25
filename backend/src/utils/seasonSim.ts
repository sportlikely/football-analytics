/**
 * fix215 — season simulator: the rest of a league season played N times (20,000 by default) with our own match model.
 * Pure functions, no database (tests import this file directly; services/seasonForecast.ts feeds it).
 *
 *  Football     each remaining game from OUR 1X2 for that game: an ordered-probit latent z ~ N(m + noise, 1), home win
 *               above +w, away win below −w, so the three chances are exactly ours with no noise; the score is drawn
 *               from the game's score grid (expected goals, independent Poisson) restricted to that result, so goal
 *               difference and goals scored are simulated for the tie-breaks. Games without a prediction: the teams'
 *               model ratings (same latent scale) + home advantage.
 *  Basketball / American football   margin ~ N(mu + noise, sd), mu / sd giving our own win chance (marginSpread);
 *               no prediction: rating difference + home advantage, the league's spread.
 *  Season uncertainty: every run gives each team one small rating shift (`noise`), the same in all its games.
 *
 * Then the league's rules (utils/seasonRules.ts): points, tie-breaks (head-to-head as a mini-league among the teams
 * still level), split seasons (top / bottom groups after N games, points halved where the league does it), play-in and
 * play-off brackets (NBA, EuroLeague …), NFL divisions + wild cards + seeding, college conference title games.
 *
 * Output per team: the chance of every final position, of every zone (title, Champions League, relegation …), the
 * average points (wins in the winner sports) and the average final position; per watched game, how each zone chance of
 * both teams moves with each result ("what this game means").
 */

import { normCdf, normInv } from './moreMath';

export type SimSport = 'football' | 'basketball' | 'nfl';
/** fix230: 'rounded' = a split's halving (rounded up ranks below on a tie: Belgium; rounded down ranks above: Austria);
 *  'apts' / 'agd' / 'agf' = the annual table (earlier tournaments of the year + this one: Argentina's relegation) */
export type TieKey = 'pts' | 'gd' | 'gf' | 'h2h' | 'h2hgd' | 'h2hgf' | 'wins' | 'pd' | 'div' | 'conf' | 'h2hpd' | 'rounded' | 'apts' | 'agd' | 'agf';
/** zones by final position; the post-season adds title / final / playoffs / playin / bye / div_title / conf_title;
 *  fix230: shield = top of the whole table (Supporters' Shield, Premiers, Argentina's annual table), top_group = the
 *  top group of a split season (championship round, Final A, Top 8) */
export type ZoneKey = 'title' | 'cl' | 'europe' | 'promotion' | 'promo_po' | 'releg_po' | 'relegation'
  | 'playoffs' | 'playin' | 'bye' | 'div_title' | 'conf_title' | 'final' | 'shield' | 'top_group';
/** places from / to (1 = first; fix230: negative = from the bottom, −1 = last); over = ranked over the whole league
 *  (conference leagues: the Supporters' Shield) or over the annual table, instead of the team's own table group */
export interface Zone { key: ZoneKey; from: number; to: number; over?: 'league' | 'annual' }
export interface SplitRule {
  /** games per team before the split */
  after: number;
  /** points halved at the split (rounded up: Belgium; down: Austria) */
  halve?: 'up' | 'down';
  /** the groups by position after `after` games; rounds 1 = everyone once, 2 = home and away */
  groups: { from: number; to: number; rounds: 1 | 2 }[];
}
export type PostSeason =
  /** seeds 1..N per table group (perGroup) or the whole league; play-in 7–10 for seeds 7 and 8 (playInFrom moves it:
   *  NBL 3–6 for seeds 3 and 4), 'wildcard' = N v N+1 in one game for seed N (MLS); bestOf per round: 0 = one game on
   *  neutral ground (Final Four), 1 = one game at the better seed, 3 / 5 / 7 = a series, −2 = two legs, level on
   *  aggregate → the better seed (Liga MX), −3 = two legs, level → extra time and penalties; byes = the top seeds wait
   *  out round one (A-League top two, CBA top four); reseed = the best seed left meets the worst each round;
   *  final = the two group winners (perGroup) best of `final` */
  | { kind: 'bracket'; seeds: number; bestOf: number[]; playIn?: boolean | 'wildcard'; playInFrom?: number; perGroup?: boolean; final?: number; byes?: number; reseed?: boolean }
  /** fix230: two table groups crossed: 1A v 8B, 4A v 5B, 2B v 7A … (Argentina), bestOf per round as above */
  | { kind: 'cross'; seeds: number; bestOf: number[] }
  | { kind: 'nfl' }
  /** college: the top two of every conference play a title game on neutral ground */
  | { kind: 'confTitle' };
export interface LeagueRules {
  sport: SimSport;
  /** football: points per win / draw / loss (default 3 / 1 / 0); the winner sports rank by win share */
  points?: { win: number; draw: number; loss: number };
  /** the ranking keys in order, the first is the main one (pts = points in football, win share elsewhere) */
  tiebreaks: TieKey[];
  /** rank inside each table group (NBA conferences, college conferences); positions are per group */
  groupBy?: 'group';
  zones: Zone[];
  split?: SplitRule;
  post?: PostSeason;
  /** false = no zone rules known for this league: only the position chances */
  known: boolean;
  label?: string;
  /** fix230: no title zone (cups whose later rounds are drawn: BCL, EuroCup groups) */
  noTitle?: boolean;
  /** fix230: where the table groups come from — the provider's table (MLS conferences), or the schedule itself (teams
   *  that play each other: Argentina's zones, EuroCup / BCL groups) when the provider has none */
  groupsFrom?: 'provider' | 'schedule';
  /** fix230: the season is tournaments (Apertura / Clausura): only the current one's rounds are this table */
  rounds?: 'tournament';
  /** fix230: new rules show their zones only once last season's replay beats the table order (else positions only) */
  gate?: boolean;
  /** fix230: the rule's source (the league's own site) and the season it was checked for */
  source?: string; season?: string;
  /** set by the service when a gated league is shown without zones (why) */
  gateNote?: string;
}

export interface SimTeam {
  id: string; name: string;
  /** table now: points (football), wins / losses / draws (ties), goals or points for / against, games played */
  pts: number; w: number; d: number; l: number; gf: number; ga: number; played: number;
  /** model rating on the game scale (football: latent probit units; winner sports: points of margin) */
  rating: number;
  /** table group (conference) and division (NFL) */
  group?: string; div?: string;
  /** fix230: the annual table before this tournament (Argentina), the split group once the split is played (index
   *  into split.groups; set by applySplit), 1 = the points were rounded at the split's halving */
  annual?: { pts: number; gd: number; gf: number }; splitGroup?: number; rounded?: number;
}
export interface SimPlayed { home: string; away: string; hg: number; ag: number }
export interface SimGame {
  id: string; home: string; away: string; neutral?: boolean;
  /** football: our 1X2 and expected goals */
  pH?: number; pD?: number; pA?: number; xgH?: number; xgA?: number;
  /** winner sports: our home win chance and predicted margin */
  pHome?: number; margin?: number;
  /** watch this game: record how the zones move with its result */
  watch?: boolean;
}
export interface SimParams {
  runs: number; seed: number;
  /** home advantage on the game scale (football latent units; points elsewhere) */
  home: number;
  /** football: half-width of the draw band (latent units); winner sports: sd of the margin (points) */
  drawBand: number; sigma: number;
  /** per-run team rating noise (season uncertainty), same units as the ratings */
  noise: number;
  /** fix218: the drift of a team's strength over the rest of the season (a random walk, one step a game; sd of the
   *  total drift to the end, same units) — fitted with `noise` by last season's replay; 0 = fixed strength */
  walk?: number;
  /** football: the league's average goals of the home / away side (games without expected goals) */
  goalsH: number; goalsA: number;
}
export interface TeamOut {
  id: string; name: string; group?: string;
  /** chance of each final position (index 0 = 1st), positions within the team's table group */
  pos: number[];
  zones: Partial<Record<ZoneKey, number>>;
  avgPts: number; avgPos: number;
}
export interface GameMeans {
  id: string; home: string; away: string;
  /** results: football H / D / A, winner sports H / A; share of the runs with that result */
  results: string[]; share: number[];
  /** per side, per result, per zone: the chance in the runs with that result */
  home_: Record<string, number[]>; away_: Record<string, number[]>;
}
export interface SimOut { runs: number; teams: TeamOut[]; games: GameMeans[]; zones: ZoneKey[]; groups: string[] }

/* ---------- random numbers (seeded, so a run can be repeated) ---------- */

export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h || 1;
}
export class Rng {
  private s: number; private spare: number | null = null;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  /** mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  normal(): number {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
    let u = 0; while (u <= 1e-12) u = this.next();
    const v = this.next(), r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/* ---------- one game ---------- */

/** football 1X2 → ordered-probit mean m and draw half-band w (z ~ N(m,1): home above w, away below −w) */
export function probitOf(pH: number, pA: number): { m: number; w: number } {
  const h = Math.min(0.995, Math.max(0.005, pH)), a = Math.min(0.995, Math.max(0.005, pA));
  const hi = normInv(1 - h), lo = normInv(a);
  return { m: -(hi + lo) / 2, w: Math.max(0.01, (hi - lo) / 2) };
}
/** winner sports: home win chance + predicted margin → normal margin mean / sd that keep that chance */
export function marginOf(pHome: number, margin: number, sigma: number): { mu: number; sd: number } {
  const p = Math.min(0.995, Math.max(0.005, pHome)), z = normInv(p);
  // keep the predicted margin as the mean when it agrees in sign; the spread is what gives our chance
  if (margin * z > 0 && Math.abs(z) > 0.05) {
    const sd = Math.abs(margin / z);
    if (sd > sigma * 0.5 && sd < sigma * 2) return { mu: margin, sd };
  }
  return { mu: z * sigma, sd: sigma };
}

const MAXG = 9;
function poisson(l: number): number[] {
  const lam = Math.max(0.02, l), v: number[] = []; let x = Math.exp(-lam), s = 0;
  for (let k = 0; k <= MAXG; k++) { v.push(x); s += x; x *= lam / (k + 1); }
  return v.map(q => q / s);
}
/** cumulative score tables per result (0 home win, 1 draw, 2 away win) from the expected goals */
function scoreTables(xh: number, xa: number): { cum: Float64Array[]; hg: Int8Array[]; ag: Int8Array[] } {
  const ph = poisson(xh), pa = poisson(xa);
  const lists: [number, number, number][][] = [[], [], []];
  for (let i = 0; i <= MAXG; i++) for (let j = 0; j <= MAXG; j++) lists[i > j ? 0 : i === j ? 1 : 2].push([i, j, ph[i] * pa[j]]);
  const cum: Float64Array[] = [], hg: Int8Array[] = [], ag: Int8Array[] = [];
  for (const L of lists) {
    const s = L.reduce((t, x) => t + x[2], 0) || 1;
    const c = new Float64Array(L.length), h = new Int8Array(L.length), a = new Int8Array(L.length);
    let run = 0;
    L.forEach((x, k) => { run += x[2] / s; c[k] = run; h[k] = x[0]; a[k] = x[1]; });
    cum.push(c); hg.push(h); ag.push(a);
  }
  return { cum, hg, ag };
}
function pick(c: Float64Array, u: number): number { let k = 0; while (k < c.length - 1 && c[k] < u) k++; return k; }
/** fix230: a zone's places in a table of `len` (negative = from the bottom), 0-based [a, b) */
export function zoneSpan(z: Zone, len: number): [number, number] {
  const at = (x: number) => x < 0 ? len + 1 + x : x;
  return [Math.max(0, at(z.from) - 1), Math.min(len, at(z.to))];
}
/** Poisson draw (Knuth; small means only: goals) */
function poissonDraw(rng: Rng, lam: number): number {
  const L = Math.exp(-Math.max(0.02, lam)); let k = 0, p = 1;
  do { k++; p *= rng.next(); } while (p > L && k < 20);
  return k - 1;
}

/* ---------- prepared league ---------- */

interface Prep {
  n: number; teams: SimTeam[]; idx: Map<string, number>;
  groupOf: Int32Array; groups: string[]; divOf: Int32Array; divs: string[];
  games: { h: number; a: number; neutral: boolean; m: number; w: number; sd: number; tab: ReturnType<typeof scoreTables> | null; watch: boolean; id: string }[];
  /** head-to-head from played games: [i*n+j] = points / goal diff / goals for of i against j */
  h2hPts: Float64Array; h2hGd: Float64Array; h2hGf: Float64Array; h2hW: Float64Array; h2hG: Float64Array;
  /** division / conference record so far (NFL): wins, games */
  divW: Float64Array; divG: Float64Array; confW: Float64Array; confG: Float64Array;
  /** fix218: the random-walk step of each team (walk / √games left) */
  walkStep: Float64Array;
}

function prepare(rules: LeagueRules, teams: SimTeam[], played: SimPlayed[], games: SimGame[], P: SimParams): Prep {
  const n = teams.length, idx = new Map(teams.map((t, i) => [t.id, i] as [string, number]));
  const groups = [...new Set(teams.map(t => t.group || ''))].sort();
  const divs = [...new Set(teams.map(t => t.div || ''))].sort();
  const groupOf = new Int32Array(n), divOf = new Int32Array(n);
  teams.forEach((t, i) => { groupOf[i] = groups.indexOf(t.group || ''); divOf[i] = divs.indexOf(t.div || ''); });
  const pts = rules.points || { win: 3, draw: 1, loss: 0 };
  const h2hPts = new Float64Array(n * n), h2hGd = new Float64Array(n * n), h2hGf = new Float64Array(n * n), h2hW = new Float64Array(n * n), h2hG = new Float64Array(n * n);
  const divW = new Float64Array(n), divG = new Float64Array(n), confW = new Float64Array(n), confG = new Float64Array(n);
  for (const g of played) {
    const h = idx.get(g.home), a = idx.get(g.away);
    if (h === undefined || a === undefined) continue;
    const r = g.hg > g.ag ? 0 : g.hg === g.ag ? 1 : 2;
    h2hPts[h * n + a] += r === 0 ? pts.win : r === 1 ? pts.draw : pts.loss;
    h2hPts[a * n + h] += r === 2 ? pts.win : r === 1 ? pts.draw : pts.loss;
    h2hGd[h * n + a] += g.hg - g.ag; h2hGd[a * n + h] += g.ag - g.hg;
    h2hGf[h * n + a] += g.hg; h2hGf[a * n + h] += g.ag;
    h2hW[h * n + a] += r === 0 ? 1 : r === 1 ? 0.5 : 0; h2hW[a * n + h] += r === 2 ? 1 : r === 1 ? 0.5 : 0;
    h2hG[h * n + a]++; h2hG[a * n + h]++;
    if (groupOf[h] === groupOf[a]) {
      const wh = r === 0 ? 1 : r === 1 ? 0.5 : 0;
      confW[h] += wh; confW[a] += 1 - wh; confG[h]++; confG[a]++;
      if (divOf[h] === divOf[a]) { divW[h] += wh; divW[a] += 1 - wh; divG[h]++; divG[a]++; }
    }
  }
  const prepped = [] as Prep['games'];
  const left = new Float64Array(n);
  // fix230: before the split only the games up to the split count (each run makes the groups' games itself); a fixture
  // list that already holds the post-split rounds (or last season's replay) would otherwise be played twice
  const preSplit = splitPending(rules, teams);
  const cnt = Float64Array.from(teams.map(t => t.played));
  for (const g of games) {
    const h = idx.get(g.home), a = idx.get(g.away);
    if (h === undefined || a === undefined || h === a) continue;
    if (preSplit) { if (cnt[h] >= rules.split!.after || cnt[a] >= rules.split!.after) continue; cnt[h]++; cnt[a]++; }
    prepped.push(gameOf(rules, teams, h, a, !!g.neutral, P, g));
    left[h]++; left[a]++;
  }
  const walkStep = new Float64Array(n);
  for (let i = 0; i < n; i++) walkStep[i] = (P.walk || 0) / Math.sqrt(Math.max(1, left[i]));
  return { n, teams, idx, groupOf, groups, divOf, divs, games: prepped, h2hPts, h2hGd, h2hGf, h2hW, h2hG, divW, divG, confW, confG, walkStep };
}

/** fix230: the split is still to come (no team has a split group yet, nobody past the split's games) */
export function splitPending(rules: LeagueRules, teams: SimTeam[]): boolean {
  if (!rules.split || rules.groupBy) return false;
  if (teams.some(t => t.splitGroup != null)) return false;
  return Math.max(0, ...teams.map(t => t.played)) <= rules.split.after;
}

function gameOf(rules: LeagueRules, teams: SimTeam[], h: number, a: number, neutral: boolean, P: SimParams, g?: SimGame): Prep['games'][number] {
  const diff = teams[h].rating - teams[a].rating + (neutral ? 0 : P.home);
  if (rules.sport === 'football') {
    let m = diff, w = P.drawBand;
    if (g && g.pH != null && g.pA != null && g.pH + g.pA < 1) ({ m, w } = probitOf(g.pH, g.pA));
    // expected goals: ours, else the league's home / away goals moved by the rating difference
    const xh = g?.xgH ?? P.goalsH * Math.exp(0.42 * (m - P.home / 2));
    const xa = g?.xgA ?? P.goalsA * Math.exp(-0.42 * (m - P.home / 2));
    return { h, a, neutral, m, w, sd: 1, tab: scoreTables(xh, xa), watch: !!g?.watch, id: g?.id || '' };
  }
  let mu = diff, sd = P.sigma;
  if (g && g.pHome != null) ({ mu, sd } = marginOf(g.pHome, g.margin ?? 0, P.sigma));
  return { h, a, neutral, m: mu, w: 0, sd, tab: null, watch: !!g?.watch, id: g?.id || '' };
}

/* ---------- one run's state ---------- */

interface Run {
  pts: Float64Array; w: Float64Array; d: Float64Array; l: Float64Array; gf: Float64Array; ga: Float64Array; g: Float64Array;
  divW: Float64Array; divG: Float64Array; confW: Float64Array; confG: Float64Array;
  /** results of the simulated games: home goals / away goals (winner sports: margin, 0) */
  rh: Float64Array; ra: Float64Array;
  /** split-season extra games (made per run) */
  extra: { h: number; a: number; rh: number; ra: number }[];
  noise: Float64Array; tieRand: Float64Array;
  /** fix230: points rounded at the split's halving (1) */
  rounded: Float64Array;
}

function newRun(p: Prep, nGames: number): Run {
  const n = p.n, f = () => new Float64Array(n);
  return { pts: f(), w: f(), d: f(), l: f(), gf: f(), ga: f(), g: f(), divW: f(), divG: f(), confW: f(), confG: f(), rh: new Float64Array(nGames), ra: new Float64Array(nGames), extra: [], noise: f(), tieRand: f(), rounded: f() };
}
function resetRun(p: Prep, R: Run, rng: Rng, P: SimParams) {
  p.teams.forEach((t, i) => {
    R.pts[i] = t.pts; R.w[i] = t.w; R.d[i] = t.d; R.l[i] = t.l; R.gf[i] = t.gf; R.ga[i] = t.ga; R.g[i] = t.played;
    R.noise[i] = P.noise * rng.normal(); R.tieRand[i] = rng.next(); R.rounded[i] = t.rounded || 0;
  });
  R.divW.set(p.divW); R.divG.set(p.divG); R.confW.set(p.confW); R.confG.set(p.confG);
  R.extra.length = 0;
}

/** play one game; returns 0 home win, 1 draw, 2 away win */
function play(rules: LeagueRules, p: Prep, R: Run, rng: Rng, G: Prep['games'][number], pts: { win: number; draw: number; loss: number }): { r: number; x: number; y: number } {
  const { h, a } = G;
  // fix218: the season-level shift (drawn once a run) drifts a little with every game the team plays
  if (p.walkStep[h] > 0) R.noise[h] += p.walkStep[h] * rng.normal();
  if (p.walkStep[a] > 0) R.noise[a] += p.walkStep[a] * rng.normal();
  const shift = R.noise[h] - R.noise[a];
  let r: number, x: number, y: number;
  if (rules.sport === 'football') {
    const z = G.m + shift + rng.normal();
    r = z > G.w ? 0 : z < -G.w ? 2 : 1;
    const t = G.tab!, k = pick(t.cum[r], rng.next());
    x = t.hg[r][k]; y = t.ag[r][k];
  } else {
    let m = G.m + shift + G.sd * rng.normal();
    if (Math.abs(m) < 0.5) m = m < 0 ? -1 : 1; // no ties in the winner sports (overtime)
    m = Math.round(m);
    r = m > 0 ? 0 : 2; x = m; y = 0;
  }
  R.g[h]++; R.g[a]++;
  if (rules.sport === 'football') { R.gf[h] += x; R.ga[h] += y; R.gf[a] += y; R.ga[a] += x; }
  else { R.gf[h] += x; R.ga[a] += x; } // point difference only (x = margin)
  if (r === 0) { R.w[h]++; R.l[a]++; R.pts[h] += pts.win; R.pts[a] += pts.loss; }
  else if (r === 2) { R.w[a]++; R.l[h]++; R.pts[a] += pts.win; R.pts[h] += pts.loss; }
  else { R.d[h]++; R.d[a]++; R.pts[h] += pts.draw; R.pts[a] += pts.draw; }
  if (p.groupOf[h] === p.groupOf[a]) {
    const wh = r === 0 ? 1 : r === 1 ? 0.5 : 0;
    R.confW[h] += wh; R.confW[a] += 1 - wh; R.confG[h]++; R.confG[a]++;
    if (p.divOf[h] === p.divOf[a]) { R.divW[h] += wh; R.divW[a] += 1 - wh; R.divG[h]++; R.divG[a]++; }
  }
  return { r, x, y };
}

/* ---------- ranking with tie-breaks ---------- */

const share = (w: number, gp: number) => gp > 0 ? w / gp : 0.5;

function primary(rules: LeagueRules, R: Run, i: number): number {
  if (rules.sport === 'football') return R.pts[i];
  const gp = R.w[i] + R.l[i] + R.d[i];
  return gp > 0 ? (R.w[i] + 0.5 * R.d[i]) / gp : 0.5;
}

/** fix230: the annual table's points (football) — earlier tournaments of the year + this one */
function primaryAnnual(rules: LeagueRules, p: Prep, R: Run, i: number): number {
  return rules.sport === 'football' ? R.pts[i] + (p.teams[i].annual?.pts || 0) : primary(rules, R, i);
}
const ANNUAL: TieKey[] = ['apts', 'agd', 'agf'];

/** mini-league of `set` among themselves: played games + this run's simulated ones */
function miniTable(rules: LeagueRules, p: Prep, R: Run, set: number[], pairs: Map<number, number[]>): { pts: Map<number, number>; gd: Map<number, number>; gf: Map<number, number>; w: Map<number, number> } {
  const n = p.n, pt = rules.points || { win: 3, draw: 1, loss: 0 };
  const pts = new Map<number, number>(), gd = new Map<number, number>(), gf = new Map<number, number>(), w = new Map<number, number>(), gp = new Map<number, number>();
  for (const i of set) { pts.set(i, 0); gd.set(i, 0); gf.set(i, 0); w.set(i, 0); gp.set(i, 0); }
  const add = (i: number, P_: number, D: number, F: number, W: number, Gc: number) => { pts.set(i, pts.get(i)! + P_); gd.set(i, gd.get(i)! + D); gf.set(i, gf.get(i)! + F); w.set(i, w.get(i)! + W); gp.set(i, gp.get(i)! + Gc); };
  for (const i of set) for (const j of set) if (i !== j) add(i, p.h2hPts[i * n + j], p.h2hGd[i * n + j], p.h2hGf[i * n + j], p.h2hW[i * n + j], p.h2hG[i * n + j]);
  const res = (h: number, a: number, x: number, y: number) => {
    if (!pts.has(h) || !pts.has(a)) return;
    if (rules.sport === 'football') {
      const r = x > y ? 0 : x === y ? 1 : 2;
      add(h, r === 0 ? pt.win : r === 1 ? pt.draw : pt.loss, x - y, x, r === 0 ? 1 : r === 1 ? 0.5 : 0, 1);
      add(a, r === 2 ? pt.win : r === 1 ? pt.draw : pt.loss, y - x, y, r === 2 ? 1 : r === 1 ? 0.5 : 0, 1);
    } else {
      add(h, x > 0 ? 1 : 0, x, 0, x > 0 ? 1 : 0, 1); add(a, x < 0 ? 1 : 0, -x, 0, x < 0 ? 1 : 0, 1);
    }
  };
  for (const i of set) for (const j of set) if (i < j) for (const gi of pairs.get(i * n + j) || []) res(p.games[gi].h, p.games[gi].a, R.rh[gi], R.ra[gi]);
  for (const e of R.extra) res(e.h, e.a, e.rh, e.ra);
  // winner sports: head-to-head = win share among them
  if (rules.sport !== 'football') for (const i of set) pts.set(i, share(w.get(i)!, gp.get(i)!));
  return { pts, gd, gf, w };
}

function rankSet(rules: LeagueRules, p: Prep, R: Run, set: number[], keys: TieKey[], pairs: Map<number, number[]>): number[] {
  if (set.length <= 1) return set.slice();
  if (!keys.length) return set.slice().sort((x, y) => R.tieRand[y] - R.tieRand[x]);
  const [k, ...rest] = keys;
  let val: (i: number) => number;
  if (k === 'pts') val = i => primary(rules, R, i);
  else if (k === 'gd' || k === 'pd') val = i => R.gf[i] - R.ga[i];
  else if (k === 'gf') val = i => R.gf[i];
  else if (k === 'wins') val = i => R.w[i];
  else if (k === 'div') val = i => share(R.divW[i], R.divG[i]);
  else if (k === 'conf') val = i => share(R.confW[i], R.confG[i]);
  else if (k === 'rounded') val = i => (rules.split?.halve === 'down' ? 1 : -1) * R.rounded[i];
  else if (k === 'apts') val = i => primaryAnnual(rules, p, R, i);
  else if (k === 'agd') val = i => R.gf[i] - R.ga[i] + (p.teams[i].annual?.gd || 0);
  else if (k === 'agf') val = i => R.gf[i] + (p.teams[i].annual?.gf || 0);
  else {
    const mt = miniTable(rules, p, R, set, pairs);
    val = k === 'h2h' ? i => mt.pts.get(i)! : k === 'h2hgd' || k === 'h2hpd' ? i => mt.gd.get(i)! : i => mt.gf.get(i)!;
  }
  const v = new Map(set.map(i => [i, val(i)] as [number, number]));
  const sorted = set.slice().sort((x, y) => v.get(y)! - v.get(x)!);
  const out: number[] = [];
  for (let s = 0; s < sorted.length;) {
    let e = s + 1;
    while (e < sorted.length && Math.abs(v.get(sorted[e])! - v.get(sorted[s])!) < 1e-9) e++;
    const tie = sorted.slice(s, e);
    out.push(...(tie.length > 1 ? rankSet(rules, p, R, tie, rest, pairs) : tie));
    s = e;
  }
  return out;
}

/* ---------- post-season ---------- */

function winProb(rules: LeagueRules, p: Prep, R: Run, h: number, a: number, neutral: boolean, P: SimParams): number {
  const d = p.teams[h].rating - p.teams[a].rating + (neutral ? 0 : P.home) + R.noise[h] - R.noise[a];
  if (rules.sport === 'football') return normCdf(d / Math.SQRT2);
  return normCdf(d / P.sigma);
}
/** a series best of `bo` (0 = one game on neutral ground); `hi` has home court (games 1, 2, 5, 7 …) */
function series(rules: LeagueRules, p: Prep, R: Run, rng: Rng, hi: number, lo: number, bo: number, P: SimParams): number {
  if (bo <= 1) return rng.next() < winProb(rules, p, R, hi, lo, bo === 0, P) ? hi : lo;
  const need = Math.ceil(bo / 2), pHome = winProb(rules, p, R, hi, lo, false, P), pAway = 1 - winProb(rules, p, R, lo, hi, false, P);
  // home pattern 2-2-1-1-1 (bo7), 2-2-1 (bo5), 1-1-1 (bo3)
  const homeGame = (g: number) => bo === 3 ? g !== 1 : bo === 5 ? (g < 2 || g === 4) : (g < 2 || g === 4 || g === 6);
  let a = 0, b = 0;
  for (let g = 0; a < need && b < need; g++) {
    if (rng.next() < (homeGame(g) ? pHome : pAway)) a++; else b++;
  }
  return a >= need ? hi : lo;
}

/** fix230: two legs (the better seed at home second): the aggregate on goals from the teams' strengths; level → the
 *  better seed (mode −2: Liga MX) or extra time and penalties at its ground (−3). Winner sports: one game at `hi`. */
function twoLegs(rules: LeagueRules, p: Prep, R: Run, rng: Rng, hi: number, lo: number, mode: number, P: SimParams): number {
  if (rules.sport !== 'football') return series(rules, p, R, rng, hi, lo, 1, P);
  let gh = 0, gl = 0;
  for (const [home, away] of [[lo, hi], [hi, lo]]) {
    const d = p.teams[home].rating - p.teams[away].rating + P.home + R.noise[home] - R.noise[away];
    const x = poissonDraw(rng, P.goalsH * Math.exp(0.42 * (d - P.home / 2))), y = poissonDraw(rng, P.goalsA * Math.exp(-0.42 * (d - P.home / 2)));
    if (home === hi) { gh += x; gl += y; } else { gl += x; gh += y; }
  }
  if (gh !== gl) return gh > gl ? hi : lo;
  if (mode === -2) return hi;
  return rng.next() < winProb(rules, p, R, hi, lo, false, P) ? hi : lo;
}
/** one knockout tie by its round code (see PostSeason) */
function tie(rules: LeagueRules, p: Prep, R: Run, rng: Rng, hi: number, lo: number, bo: number, P: SimParams): number {
  return bo < 0 ? twoLegs(rules, p, R, rng, hi, lo, bo, P) : series(rules, p, R, rng, hi, lo, bo, P);
}

/** standard bracket order for N seeds (1 v N, then the winner meets 4 v 5's …) */
function bracketOrder(N: number): number[] {
  let o = [1, 2];
  while (o.length < N) { const m = o.length * 2 + 1; o = o.flatMap(s => [s, m - s]); }
  return o;
}
/** best seed left v the worst, the second v the second worst … (in that order, so pairs are next to each other) */
function reseeded(alive: number[], rank: (i: number) => number): number[] {
  const s = alive.slice().sort((x, y) => rank(x) - rank(y)), out: number[] = [];
  for (let k = 0; k < s.length / 2; k++) out.push(s[k], s[s.length - 1 - k]);
  return out;
}

interface PostOut { set: (i: number, z: ZoneKey) => void }

function playBracket(rules: LeagueRules, p: Prep, R: Run, rng: Rng, P: SimParams, order: number[], post: Extract<PostSeason, { kind: 'bracket' }>, out: PostOut): number {
  // order = teams by final standing in this table; returns the bracket winner
  const S = post.seeds;
  let seeds = order.slice(0, S);
  if (post.playIn === 'wildcard' && order.length > S) {
    // MLS: N v N+1, one game at N, for the last seed
    const a = order[S - 1], b = order[S];
    out.set(a, 'playin'); out.set(b, 'playin');
    seeds = [...order.slice(0, S - 1), series(rules, p, R, rng, a, b, 1, P)];
  } else if (post.playIn === true) {
    // NBA style on places f+1 … f+4 for the last two seeds (7–10 for seeds 7 and 8; NBL 3–6 for 3 and 4)
    const f = (post.playInFrom || S - 1) - 1;
    if (order.length >= f + 4 && f + 2 === S) {
      const [s7, s8, s9, s10] = order.slice(f, f + 4);
      for (const t of [s7, s8, s9, s10]) out.set(t, 'playin');
      const w78 = series(rules, p, R, rng, s7, s8, 1, P), l78 = w78 === s7 ? s8 : s7;
      const w910 = series(rules, p, R, rng, s9, s10, 1, P);
      const eighth = series(rules, p, R, rng, l78, w910, 1, P);
      seeds = [...order.slice(0, f), w78, eighth];
    }
  }
  for (const t of seeds) out.set(t, 'playoffs');
  const rank = (i: number) => order.indexOf(i);
  let alive: number[], round = 0;
  const byes = Math.min(post.byes || 0, seeds.length - 2);
  if (byes > 0) {
    // round one without the top seeds: the rest outside-in (A-League 3 v 6, 4 v 5)
    const first = seeds.slice(byes), winners: number[] = [];
    for (let k = 0; k < first.length / 2; k++) winners.push(tie(rules, p, R, rng, first[k], first[first.length - 1 - k], post.bestOf[0], P));
    alive = [...seeds.slice(0, byes), ...winners]; round = 1;
  } else alive = bracketOrder(seeds.length).map(s => seeds[s - 1]).filter(x => x !== undefined);
  while (alive.length > 1) {
    if (post.reseed || byes > 0) alive = reseeded(alive, rank);
    if (alive.length === 2 && !post.perGroup) { out.set(alive[0], 'final'); out.set(alive[1], 'final'); }
    const bo = post.bestOf[Math.min(round, post.bestOf.length - 1)];
    const next: number[] = [];
    for (let k = 0; k + 1 < alive.length; k += 2) {
      const x = alive[k], y = alive[k + 1];
      const hi = rank(x) < rank(y) ? x : y, lo = hi === x ? y : x;
      next.push(tie(rules, p, R, rng, hi, lo, bo, P));
    }
    if (alive.length % 2) next.push(alive[alive.length - 1]);
    alive = next; round++;
  }
  return alive[0];
}

/** fix230: two groups crossed (Argentina): half one 1A–8B, 4A–5B, 2B–7A, 3B–6A, half two the mirror; the better
 *  place hosts (the same place: the more points); returns the winner */
function playCross(rules: LeagueRules, p: Prep, R: Run, rng: Rng, P: SimParams, A: number[], B: number[], post: Extract<PostSeason, { kind: 'cross' }>, out: PostOut): number {
  const S = Math.min(post.seeds, A.length, B.length);
  const seedOf = new Map<number, number>();
  A.slice(0, S).forEach((t, k) => { seedOf.set(t, k); out.set(t, 'playoffs'); });
  B.slice(0, S).forEach((t, k) => { seedOf.set(t, k); out.set(t, 'playoffs'); });
  const ord = bracketOrder(S), pairs: [number, number][] = [];
  for (let k = 0; k < ord.length; k += 2) pairs.push([ord[k], ord[k + 1]]);
  const half = (X: number[], Y: number[]) => pairs.flatMap(([s, t], k) => k < Math.floor(pairs.length / 2) ? [X[s - 1], Y[t - 1]] : [Y[s - 1], X[t - 1]]);
  let alive = [...half(A, B), ...half(B, A)], round = 0;
  const better = (x: number, y: number) => seedOf.get(x)! !== seedOf.get(y)! ? seedOf.get(x)! < seedOf.get(y)! : primary(rules, R, x) >= primary(rules, R, y);
  while (alive.length > 1) {
    if (alive.length === 2) { out.set(alive[0], 'final'); out.set(alive[1], 'final'); }
    const bo = post.bestOf[Math.min(round, post.bestOf.length - 1)];
    const next: number[] = [];
    for (let k = 0; k + 1 < alive.length; k += 2) {
      const x = alive[k], y = alive[k + 1], hi = better(x, y) ? x : y, lo = hi === x ? y : x;
      next.push(tie(rules, p, R, rng, hi, lo, bo, P));
    }
    alive = next; round++;
  }
  return alive[0];
}

/* ---------- the season ---------- */

export function simulateSeason(rules: LeagueRules, teams: SimTeam[], played: SimPlayed[], games: SimGame[], P: SimParams): SimOut {
  const it = seasonSteps(rules, teams, played, games, P);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
/** the same, pausing every 250 runs (in-process builds: the event loop is never held more than a few ms) */
export async function simulateSeasonAsync(rules: LeagueRules, teams: SimTeam[], played: SimPlayed[], games: SimGame[], P: SimParams, pause: () => Promise<void>): Promise<SimOut> {
  const it = seasonSteps(rules, teams, played, games, P);
  for (;;) { const r = it.next(); if (r.done) return r.value; await pause(); }
}

function* seasonSteps(rules: LeagueRules, teams: SimTeam[], played: SimPlayed[], games: SimGame[], P: SimParams): Generator<void, SimOut> {
  const p = prepare(rules, teams, played, games, P);
  const n = p.n, rng = new Rng(P.seed);
  const preSplit = splitPending(rules, teams);
  const pts = rules.points || { win: 3, draw: 1, loss: 0 };
  const pairs = new Map<number, number[]>();
  p.games.forEach((g, gi) => { const k = Math.min(g.h, g.a) * n + Math.max(g.h, g.a); (pairs.get(k) || pairs.set(k, []).get(k)!).push(gi); });
  const R = newRun(p, p.games.length);

  const groupSizes = p.groups.map((_, gi) => teams.filter((_, i) => p.groupOf[i] === gi).length);
  const perGroup = rules.groupBy === 'group';
  const byGroup = perGroup || rules.post?.kind === 'nfl';
  const posLen = byGroup ? Math.max(...groupSizes) : n;
  const posCnt = new Float64Array(n * posLen), ptsSum = new Float64Array(n), posSum = new Float64Array(n);
  const zoneKeys = zoneList(rules);
  const zIdx = new Map(zoneKeys.map((z, k) => [z, k] as [ZoneKey, number]));
  const zoneCnt = new Float64Array(n * zoneKeys.length);
  const inZone = new Uint8Array(n * zoneKeys.length);
  const setZone = (i: number, z: ZoneKey) => { const k = zIdx.get(z); if (k !== undefined) inZone[i * zoneKeys.length + k] = 1; };

  const watched = p.games.map((g, gi) => g.watch ? gi : -1).filter(gi => gi >= 0);
  const nRes = rules.sport === 'football' ? 3 : 2;
  const Z = zoneKeys.length;
  // [watch][result][side][zone] counts, and [watch][result] runs
  const wCnt = new Float64Array(watched.length * nRes * 2 * Z), wRuns = new Float64Array(watched.length * nRes);
  const lastRes = new Int8Array(p.games.length);

  for (let run = 0; run < P.runs; run++) {
    if (run % 250 === 249) yield;
    resetRun(p, R, rng, P);
    inZone.fill(0);
    for (let gi = 0; gi < p.games.length; gi++) {
      const o = play(rules, p, R, rng, p.games[gi], pts);
      R.rh[gi] = o.x; R.ra[gi] = o.y; lastRes[gi] = o.r;
    }
    // split season: the groups, then their games
    let order: number[];
    const split = rules.split;
    if (split && !perGroup) {
      const all = Array.from({ length: n }, (_, i) => i);
      if (preSplit) {
        const pre = rankSet(rules, p, R, all, rules.tiebreaks, pairs);
        order = [];
        for (const grp of split.groups) {
          const members = pre.slice(grp.from - 1, grp.to);
          if (split.halve) for (const i of members) {
            R.rounded[i] = R.pts[i] % 2 ? 1 : 0;
            R.pts[i] = split.halve === 'up' ? Math.ceil(R.pts[i] / 2) : Math.floor(R.pts[i] / 2);
          }
          for (let x = 0; x < members.length; x++) for (let y = x + 1; y < members.length; y++) {
            const legs: [number, number][] = grp.rounds === 2 ? [[members[x], members[y]], [members[y], members[x]]] : [rng.next() < 0.5 ? [members[x], members[y]] : [members[y], members[x]]];
            for (const [h, a] of legs) {
              const G = gameOf(rules, teams, h, a, false, P);
              const o = play(rules, p, R, rng, G, pts);
              R.extra.push({ h, a, rh: o.x, ra: o.y });
            }
          }
          order.push(...rankSet(rules, p, R, members, rules.tiebreaks, pairs));
        }
      } else {
        // after the split: each team stays in its split group (applySplit); else the current table's ranges
        const nowRank = all.slice().sort((x, y) => (teams[y].pts - teams[x].pts) || ((teams[y].gf - teams[y].ga) - (teams[x].gf - teams[x].ga)) || (teams[y].gf - teams[x].gf));
        const known = teams.every(t => t.splitGroup != null);
        order = [];
        split.groups.forEach((grp, gk) => order.push(...rankSet(rules, p, R, known ? all.filter(i => teams[i].splitGroup === gk) : nowRank.slice(grp.from - 1, grp.to), rules.tiebreaks, pairs)));
      }
    } else if (perGroup || rules.post?.kind === 'nfl') {
      order = [];
    } else {
      order = rankSet(rules, p, R, Array.from({ length: n }, (_, i) => i), rules.tiebreaks, pairs);
    }

    // positions + zones by position (fix230: a zone `over` the league or the annual table is ranked over every team)
    const posOf = new Int32Array(n);
    const own = rules.zones.filter(z => !z.over), wide = rules.zones.filter(z => z.over);
    if (rules.post?.kind === 'nfl') {
      nflSeason(rules, p, R, rng, P, pairs, posOf, setZone);
    } else if (perGroup) {
      const champs: number[] = [], ords: number[][] = [];
      for (let gi = 0; gi < p.groups.length; gi++) {
        const members = Array.from({ length: n }, (_, i) => i).filter(i => p.groupOf[i] === gi);
        const ord = rankSet(rules, p, R, members, rules.tiebreaks, pairs);
        ords.push(ord);
        ord.forEach((i, k) => { posOf[i] = k; });
        for (const z of own) { const [x, y] = zoneSpan(z, ord.length); for (let k = x; k < y; k++) setZone(ord[k], z.key); }
        const post = rules.post;
        if (post?.kind === 'bracket' && post.perGroup) {
          const c = playBracket(rules, p, R, rng, P, ord, post, { set: setZone });
          setZone(c, 'conf_title'); champs.push(c);
        } else if (post?.kind === 'confTitle' && ord.length >= 2 && !/independ|^other$|^$/i.test(p.groups[gi])) {
          const c = series(rules, p, R, rng, ord[0], ord[1], 0, P);
          setZone(c, 'conf_title');
        }
      }
      const post = rules.post;
      if (post?.kind === 'bracket' && post.perGroup && champs.length === 2) {
        const [x, y] = champs;
        const hi = primary(rules, R, x) >= primary(rules, R, y) ? x : y, lo = hi === x ? y : x;
        setZone(x, 'final'); setZone(y, 'final');
        setZone(series(rules, p, R, rng, hi, lo, post.final ?? 7, P), 'title');
      } else if (post?.kind === 'cross' && ords.length === 2) {
        setZone(playCross(rules, p, R, rng, P, ords[0], ords[1], post, { set: setZone }), 'title');
      }
    } else {
      order.forEach((i, k) => { posOf[i] = k; });
      for (const z of own) { const [x, y] = zoneSpan(z, n); for (let k = x; k < y; k++) setZone(order[k], z.key); }
      const post = rules.post;
      if (post?.kind === 'bracket') setZone(playBracket(rules, p, R, rng, P, order, post, { set: setZone }), 'title');
      else if (order.length) setZone(order[0], 'title');
    }
    if (wide.length) {
      const all = Array.from({ length: n }, (_, i) => i);
      const lg = wide.some(z => z.over === 'league') ? rankSet(rules, p, R, all, rules.tiebreaks, pairs) : [];
      const an = wide.some(z => z.over === 'annual') ? rankSet(rules, p, R, all, ANNUAL, pairs) : [];
      for (const z of wide) { const o = z.over === 'annual' ? an : lg, [x, y] = zoneSpan(z, n); for (let k = x; k < y; k++) setZone(o[k], z.key); }
    }

    for (let i = 0; i < n; i++) {
      posCnt[i * posLen + posOf[i]]++; posSum[i] += posOf[i] + 1;
      ptsSum[i] += rules.sport === 'football' ? R.pts[i] : R.w[i];
      for (let k = 0; k < Z; k++) zoneCnt[i * Z + k] += inZone[i * Z + k];
    }
    for (let wi = 0; wi < watched.length; wi++) {
      const gi = watched[wi], g = p.games[gi];
      const r = nRes === 3 ? lastRes[gi] : lastRes[gi] === 0 ? 0 : 1;
      wRuns[wi * nRes + r]++;
      const base = ((wi * nRes + r) * 2) * Z;
      for (let k = 0; k < Z; k++) { wCnt[base + k] += inZone[g.h * Z + k]; wCnt[base + Z + k] += inZone[g.a * Z + k]; }
    }
  }

  const N = P.runs;
  const outTeams: TeamOut[] = teams.map((t, i) => {
    const len = byGroup ? groupSizes[p.groupOf[i]] : n;
    const zones: Partial<Record<ZoneKey, number>> = {};
    zoneKeys.forEach((z, k) => { zones[z] = zoneCnt[i * Z + k] / N; });
    return { id: t.id, name: t.name, group: t.group, pos: Array.from({ length: len }, (_, k) => posCnt[i * posLen + k] / N), zones, avgPts: ptsSum[i] / N, avgPos: posSum[i] / N };
  });
  const results = nRes === 3 ? ['H', 'D', 'A'] : ['H', 'A'];
  const outGames: GameMeans[] = watched.map((gi, wi) => {
    const g = p.games[gi];
    const home_: Record<string, number[]> = {}, away_: Record<string, number[]> = {};
    zoneKeys.forEach((z, k) => {
      home_[z] = results.map((_, r) => wRuns[wi * nRes + r] ? wCnt[((wi * nRes + r) * 2) * Z + k] / wRuns[wi * nRes + r] : NaN);
      away_[z] = results.map((_, r) => wRuns[wi * nRes + r] ? wCnt[((wi * nRes + r) * 2) * Z + Z + k] / wRuns[wi * nRes + r] : NaN);
    });
    return { id: g.id, home: teams[g.h].id, away: teams[g.a].id, results, share: results.map((_, r) => wRuns[wi * nRes + r] / N), home_, away_ };
  });
  return { runs: N, teams: outTeams, games: outGames, zones: zoneKeys, groups: p.groups };
}

/** the zone keys a league reports: its position zones + what its post-season adds */
export function zoneList(rules: LeagueRules): ZoneKey[] {
  const z = new Set<ZoneKey>();
  if ((rules.sport === 'football' || !rules.post) && rules.known && !rules.noTitle) z.add('title');
  for (const x of rules.zones) z.add(x.key);
  const post = rules.post;
  if (post?.kind === 'bracket') { z.add('playoffs'); if (post.playIn) z.add('playin'); z.add('final'); z.add('title'); if (post.perGroup) z.add('conf_title'); }
  if (post?.kind === 'cross') ['playoffs', 'final', 'title'].forEach(k => z.add(k as ZoneKey));
  if (post?.kind === 'nfl') ['div_title', 'playoffs', 'bye', 'conf_title', 'title'].forEach(k => z.add(k as ZoneKey));
  if (post?.kind === 'confTitle') z.add('conf_title');
  if (!rules.known) z.clear();
  // a fixed order: best first
  const ORDER: ZoneKey[] = ['title', 'final', 'shield', 'conf_title', 'div_title', 'bye', 'playoffs', 'playin', 'top_group', 'promotion', 'promo_po', 'cl', 'europe', 'releg_po', 'relegation'];
  return ORDER.filter(k => z.has(k));
}

/* ---------- NFL: divisions, seeds, wild cards, playoffs ---------- */

function nflSeason(rules: LeagueRules, p: Prep, R: Run, rng: Rng, P: SimParams, pairs: Map<number, number[]>, posOf: Int32Array, setZone: (i: number, z: ZoneKey) => void) {
  const n = p.n, champs: number[] = [];
  const tb: TieKey[] = ['pts', 'h2h', 'div', 'conf', 'pd'];
  const tbWild: TieKey[] = ['pts', 'h2h', 'conf', 'pd'];
  for (let gi = 0; gi < p.groups.length; gi++) {
    const conf = Array.from({ length: n }, (_, i) => i).filter(i => p.groupOf[i] === gi);
    const divs = [...new Set(conf.map(i => p.divOf[i]))];
    const winners: number[] = [], rest: number[] = [];
    for (const d of divs) {
      const ord = rankSet(rules, p, R, conf.filter(i => p.divOf[i] === d), tb, pairs);
      winners.push(ord[0]); rest.push(...ord.slice(1));
      setZone(ord[0], 'div_title');
    }
    const w = rankSet(rules, p, R, winners, tbWild, pairs);
    const others = rankSet(rules, p, R, rest, tbWild, pairs);
    const seeds = [...w, ...others.slice(0, 7 - w.length)];
    const order = [...seeds, ...others.slice(7 - w.length)];
    order.forEach((i, k) => { posOf[i] = k; });
    seeds.forEach(i => setZone(i, 'playoffs'));
    if (seeds[0] !== undefined) setZone(seeds[0], 'bye');
    if (seeds.length < 7) { if (seeds[0] !== undefined) { champs.push(seeds[0]); setZone(seeds[0], 'conf_title'); } continue; }
    // wild-card round 2v7, 3v6, 4v5; then the top seed plays the lowest left (re-seeding)
    let alive = [seeds[0]];
    for (const [x, y] of [[1, 6], [2, 5], [3, 4]]) alive.push(series(rules, p, R, rng, seeds[x], seeds[y], 1, P));
    while (alive.length > 1) {
      alive.sort((x, y) => seeds.indexOf(x) - seeds.indexOf(y));
      const next: number[] = [];
      for (let k = 0; k < alive.length / 2; k++) next.push(series(rules, p, R, rng, alive[k], alive[alive.length - 1 - k], 1, P));
      alive = next;
    }
    champs.push(alive[0]); setZone(alive[0], 'conf_title');
  }
  if (champs.length === 2) setZone(series(rules, p, R, rng, champs[0], champs[1], 0, P), 'title');
}

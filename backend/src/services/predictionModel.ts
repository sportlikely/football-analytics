/**
 * SportLikely – prediction model v1 (Poisson with Dixon-Coles correction)
 *
 * Inputs come straight from the league table (Football-Data.org standings):
 *   TOTAL / HOME / AWAY tables → goals for/against per game for each team.
 *
 * For a match Home vs Away:
 *   attack(T)  = goals scored per game by T   / league average goals per team per game
 *   defence(T) = goals conceded per game by T / league average goals per team per game
 *   λ_home = leagueHomeAvg * attack(H) * defence(A)
 *   λ_away = leagueAwayAvg * attack(A) * defence(H)
 * where leagueHomeAvg / leagueAwayAvg encode home advantage (from HOME/AWAY tables).
 *
 * Strengths are shrunk toward 1.0 early in the season (few games = less trust),
 * and nudged by recent form (the W/D/L string in the standings).
 * Goal probabilities are Poisson(λ); the Dixon-Coles rho term fixes the known
 * under-estimation of 0-0 / 1-1 and over-estimation of 1-0 / 0-1.
 */

export interface StandingRow {
  position: number;
  playedGames: number;
  form?: string | null;
  won: number;
  draw: number;
  lost: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  team: { id: number; name: string };
}

export interface StandingsResponse {
  standings?: { type: string; group?: string | null; table: StandingRow[] }[];
}

export interface Prediction {
  model: string;
  /** v3, once the confirmed lineups are in: the numbers from before them (to show what changed) */
  beforeLineups?: { home: number; draw: number; away: number; over25: number; btts: number };
  home: number; // %
  draw: number; // %
  away: number; // %
  expectedGoals: { home: number; away: number };
  over25: number; // %
  btts: number; // %
  topScores: { home: number; away: number; prob: number }[];
  confidence: 'low' | 'medium' | 'high';
  factors: {
    homeAttack: number;
    homeDefence: number;
    awayAttack: number;
    awayDefence: number;
    homeAdvantage: number; // leagueHomeAvg / leagueAwayAvg
    homeForm: number; // multiplier applied from recent form
    awayForm: number;
    gamesPlayed: { home: number; away: number };
    leagueAvgGoals: number; // per team per game
  };
  /** fix192 (grid-v3): a side with no games in the league yet plays from the newcomer profile (promoted-teams / bottom-3 / league average) */
  newcomer?: { home: string | null; away: string | null };
  /** v3 leagues: each team's draw share over its last 20 games (draw alerts skip games where both are 0.32+) */
  drawStreak?: { home: number; away: number };
  /** Grid model (v3) extras — absent on v1/v2 */
  grid?: {
    matchType: 'mismatch' | 'standard' | 'even' | 'big';
    points: { home: number; draw: number; away: number }; // out of 1000
    totals: { home: number; away: number };
    rows: { id: string; name: string; rel: number; home: number; away: number; edge: number; note?: string }[];
    drawPot: { base: number; factors: number; volatility: number; closeness?: number; total: number };
    reasons: string[];
    /** 'national' = the national-team engine of v3 (values ranked among national teams) */
    scope?: 'league' | 'national' | 'cups';
    /** fix282: grid-v3's league home advantage in the rows' points (elo-euro / elo-intl have a "Home advantage" row instead) */
    homeEdge?: number;
  };
}

const SHRINK_K = 5; // games of "prior" weight for strengths
const FORM_WEIGHT = 0.15; // how much recent form can move attack strength (±)
const RHO = -0.1; // Dixon-Coles low-score correction
const MAX_GOALS = 10;
const DEFAULT_AVG = 1.35; // goals per team per game if we know nothing
const DEFAULT_HOME_ADV = 1.25; // home avg / away avg when tables are missing

function shrink(value: number, n: number, k: number = SHRINK_K) {
  return (n * value + k * 1) / (n + k);
}

function poisson(lambda: number, k: number) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function dixonColes(h: number, a: number, lh: number, la: number) {
  if (h === 0 && a === 0) return 1 - lh * la * RHO;
  if (h === 0 && a === 1) return 1 + lh * RHO;
  if (h === 1 && a === 0) return 1 + la * RHO;
  if (h === 1 && a === 1) return 1 - RHO;
  return 1;
}

/** Points-per-game from the standings "form" string, e.g. "W,W,D,L,W". */
function formPPG(form?: string | null): { ppg: number; n: number } {
  if (!form) return { ppg: 0, n: 0 };
  const results = form.split(',').map(s => s.trim()).filter(Boolean);
  if (!results.length) return { ppg: 0, n: 0 };
  const pts = results.reduce((s, r) => s + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
  return { ppg: pts / results.length, n: results.length };
}

interface TeamRates {
  gf: number; // goals for per game
  ga: number; // goals against per game
  n: number;
  form?: string | null;
  seasonPPG: number;
}

function findRow(table: StandingRow[] | undefined, teamId: number) {
  return table?.find(r => r.team?.id === teamId) || null;
}

function tableAvg(table: StandingRow[] | undefined) {
  if (!table || !table.length) return null;
  const games = table.reduce((s, r) => s + r.playedGames, 0);
  const goals = table.reduce((s, r) => s + r.goalsFor, 0);
  return games > 0 && goals > 0 ? goals / games : null; // 0 goals (e.g. one 0-0) would make every rate 0/0
}

function rates(row: StandingRow | null): TeamRates | null {
  if (!row || row.playedGames <= 0) return null;
  return {
    gf: row.goalsFor / row.playedGames,
    ga: row.goalsAgainst / row.playedGames,
    n: row.playedGames,
    form: row.form,
    seasonPPG: row.points / row.playedGames
  };
}

export function predictFromStandings(
  standings: StandingsResponse | null,
  homeId: number,
  awayId: number
): Prediction {
  const tables = standings?.standings || [];

  // Pick the TOTAL table that contains both teams (league or CL league phase);
  // fall back to any table containing the home team (group stages).
  const totalTables = tables.filter(t => t.type === 'TOTAL');
  const total =
    totalTables.find(t => findRow(t.table, homeId) && findRow(t.table, awayId)) ||
    totalTables.find(t => findRow(t.table, homeId)) ||
    totalTables[0];
  const homeTbl = tables.find(t => t.type === 'HOME' && findRow(t.table, homeId)) || tables.find(t => t.type === 'HOME');
  const awayTbl = tables.find(t => t.type === 'AWAY' && findRow(t.table, awayId)) || tables.find(t => t.type === 'AWAY');

  const leagueAvg = tableAvg(total?.table) ?? DEFAULT_AVG;
  const homeAvgRaw = tableAvg(homeTbl?.table);
  const awayAvgRaw = tableAvg(awayTbl?.table);

  // Home advantage: ratio of league home-goals to away-goals, shrunk toward the typical value
  const gamesInLeague = total?.table.reduce((s, r) => s + r.playedGames, 0) ?? 0;
  let homeAdv = DEFAULT_HOME_ADV;
  if (homeAvgRaw && awayAvgRaw && awayAvgRaw > 0) {
    const raw = homeAvgRaw / awayAvgRaw;
    const w = gamesInLeague / (gamesInLeague + 60); // ~30 matches of evidence = half weight
    homeAdv = w * raw + (1 - w) * DEFAULT_HOME_ADV;
  }
  // Split league average into home/away halves preserving the total
  const leagueHomeAvg = (2 * leagueAvg * homeAdv) / (1 + homeAdv);
  const leagueAwayAvg = (2 * leagueAvg) / (1 + homeAdv);

  const h = rates(findRow(total?.table, homeId));
  const a = rates(findRow(total?.table, awayId));

  const strength = (t: TeamRates | null) => {
    if (!t) return { attack: 1, defence: 1, n: 0, formMult: 1 };
    const attack = shrink(t.gf / leagueAvg, t.n);
    const defence = shrink(t.ga / leagueAvg, t.n);
    // Form nudge: compare last-5 PPG with season PPG (both 0..3). ±FORM_WEIGHT max.
    const f = formPPG(t.form);
    let formMult = 1;
    if (f.n >= 3 && t.n >= 3) {
      const diff = (f.ppg - t.seasonPPG) / 3; // -1..1
      formMult = 1 + Math.max(-FORM_WEIGHT, Math.min(FORM_WEIGHT, diff * FORM_WEIGHT * 2));
    }
    return { attack, defence, n: t.n, formMult };
  };

  const H = strength(h);
  const A = strength(a);

  const lambdaHome = Math.max(0.15, leagueHomeAvg * H.attack * A.defence * H.formMult);
  const lambdaAway = Math.max(0.15, leagueAwayAvg * A.attack * H.defence * A.formMult);

  // Score matrix
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pOver25 = 0;
  let pBtts = 0;
  const scores: { home: number; away: number; prob: number }[] = [];
  let mass = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poisson(lambdaHome, i) * poisson(lambdaAway, j) * dixonColes(i, j, lambdaHome, lambdaAway);
      mass += p;
      scores.push({ home: i, away: j, prob: p });
      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;
      if (i + j > 2.5) pOver25 += p;
      if (i > 0 && j > 0) pBtts += p;
    }
  }
  // normalise (Dixon-Coles can leave mass slightly off 1)
  pHome /= mass;
  pDraw /= mass;
  pAway /= mass;
  pOver25 /= mass;
  pBtts /= mass;

  const minGames = Math.min(H.n, A.n);
  const confidence: Prediction['confidence'] = !h || !a ? 'low' : minGames < 5 ? 'low' : minGames < 12 ? 'medium' : 'high';

  const pct = (x: number) => Math.round(x * 1000) / 10;
  const r2 = (x: number) => Math.round(x * 100) / 100;

  return {
    model: 'poisson-dc-v1',
    home: pct(pHome),
    draw: pct(pDraw),
    away: pct(pAway),
    expectedGoals: { home: r2(lambdaHome), away: r2(lambdaAway) },
    over25: pct(pOver25),
    btts: pct(pBtts),
    topScores: scores
      .sort((x, y) => y.prob - x.prob)
      .slice(0, 3)
      .map(s => ({ home: s.home, away: s.away, prob: pct(s.prob / mass) })),
    confidence,
    factors: {
      homeAttack: r2(H.attack),
      homeDefence: r2(H.defence),
      awayAttack: r2(A.attack),
      awayDefence: r2(A.defence),
      homeAdvantage: r2(homeAdv),
      homeForm: r2(H.formMult),
      awayForm: r2(A.formMult),
      gamesPlayed: { home: H.n, away: A.n },
      leagueAvgGoals: r2(leagueAvg)
    }
  };
}

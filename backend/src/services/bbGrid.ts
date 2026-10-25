/**
 * fix219 — bb-v4 grid rows (every basketball league). A walk-forward replay of each league's games builds the 13 rows
 * of utils/bbGridMath.ts for every finished game as they were before tip-off, stores them (bb_grid_rows: the tuner and
 * the gate read them), and keeps each team's latest values for the live predictions (state 'bb:grid').
 *
 *  #1 player impact: ridge regression of margins on player minutes (home +min/L, away −min/L, a home term; L = 48 NBA /
 *     CBA, 40 FIBA), last 3 seasons ×0.5 a season back, lambda 30, refit at each season's first game and every 14 days;
 *     rotation = players of the last 3 games, projected minutes = their last 15 games (NBA: regular season; newcomers
 *     pre-season × 0.7), top 10 scaled to 5L; rookies −1.0; pre-season box scores never rate anyone.
 *  #2 net rating per 100 possessions: ridge on team indicators (same windows) × the league's pace.
 *  #3 team rating: bb-v3's whole prediction as a margin (bb-v1 alone lost on the training seasons) · #4 missing players: lost impact of rotation players who missed the last 2 games
 *     (live NBA: only the injury report + confirmed starters, services/nbaV4.ts; fix228: its weight from "who actually
 *     played" = the oracle value kept per game, bbTuner.runMissFit) · #5 four factors for / against (eFG%, TOV%,
 *     OREB%, FT rate; Dean Oliver weights), shrunk to the league mean · #6 rest: −1 back-to-back, −0.5 third game in 4
 *     days · #7 home court: league edge + the team's own (neutral final fours 0) · #8 carry-over: strength of the players
 *     who stayed from last season, fading to 0 by game 25 · #9 matchups: style against style (shooting, rebounds,
 *     turnovers) · #10 form: last 10 games against bb-v1's expectation · #11 motivation: −1 late in the regular season
 *     for a team under 30% wins · #12 3-point volatility: share of 3-point attempts (widens sigma) · #13 head-to-head:
 *     last 3 meetings (2 years) against expectation.
 * Not built (no data): travel km / time zones (needs an arena table), playoff-race motivation (needs standings history).
 * The impact parts (#1 #4 #8 and the "who actually played" check) are kept per game (bb_grid_imp): a later build refits
 * only the windows with games not stored yet and the current one.
 * fix225: each window also rates every player two more ways — on/off with the shrink scaled by his minutes (A) and the
 * box-score value (B, utils/boxValue.ts: the formula fitted once on 2022-23 … 2024-25 by fitBoxFormula, last season
 * carried, this season blended in by minutes, NBA rookies from their draft slot). The rows #1 / #4 / #8 and the oracle
 * under A and B are stored beside the fix219 values (bb_grid_rows.alt); the tuner blends them (bbTuner.runImpactFit)
 * and the live snapshot keeps all three ratings per player, so the gate's answer applies without a rebuild.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { yieldLoop } from './perf';
import { onState, publishState } from './shared';
import { ridgeFit, rotation, strength, projMinutes, choleskySolve, probit, type FitGame, type ImpactFit, type RotPlayer } from '../utils/nbaImpact';
import { GRID_ROWS, N_ROWS, VOL, startYear, ALT, type GridBase, type GridItem } from '../utils/bbGridMath';
import {
  BOX_DEFAULT, BOX_TRAIN, assertBoxTrain, emptyTot, addTot, ratesOf, leagueRates, stintValues, carry, fullMinutes, draftPrior, NO_PRIOR,
  shrinkLambda, topIds, blendRating, fitBoxCoef, type BoxCoef, type BoxTot, type Stint, type BoxFitGame
} from '../utils/boxValue';

/** fix225: + the A / B ratings (the formula's version is part of it: a new formula recomputes every game) */
const impVer = (box: BoxCoef) => `imp2|l30|d0.5|r-1|${box.version}`;
const DAY = 86400000;
db.exec(`
  CREATE TABLE IF NOT EXISTS bb_grid_imp (game_id INTEGER PRIMARY KEY, code TEXT NOT NULL, ver TEXT NOT NULL, v TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_bb_grid_imp_code ON bb_grid_imp(code);
  CREATE TABLE IF NOT EXISTS bb_grid_rows (
    game_id INTEGER PRIMARY KEY, code TEXT NOT NULL, season TEXT NOT NULL, ms INTEGER NOT NULL, gp INTEGER NOT NULL,
    y INTEGER NOT NULL, v3 REAL NOT NULL, sig REAL NOT NULL, hv TEXT NOT NULL, av TEXT NOT NULL, oracle REAL
  );
  CREATE INDEX IF NOT EXISTS idx_bb_grid_rows_code ON bb_grid_rows(code);
  CREATE TABLE IF NOT EXISTS bb_tuned (id TEXT PRIMARY KEY, params TEXT NOT NULL, report TEXT, at TEXT NOT NULL);
`);
// fix225: the impact rows under the two new rating sets (utils/bbGridMath ALT)
try { db.exec(`ALTER TABLE bb_grid_rows ADD COLUMN alt TEXT`); } catch { /* there already */ }

export const gameMinOf = (code: string) => (code === 'NBA' || code === 'CBA' ? 48 : 40);
const isPre = (code: string, iso: string) => { if (code !== 'NBA') return false; const d = new Date(iso); return d.getUTCMonth() === 9 && d.getUTCDate() < 19; };
/** regular season: no stage or a round number ("12"); play-offs have a named stage ("ACB - Semi-finals") */
export const isRegular = (stage: string | null) => !stage || /^\d+$/.test(stage.trim());
/** final fours on a neutral court (EuroLeague, Champions League) */
export const isNeutral = (code: string, stage: string | null) => (code === 'EL' || code === 'BCL') && !!stage && /semi-finals|3rd place|- final$/i.test(stage);

/** Four-factor numbers of one team in one game */
type FF = { efg: number; tov: number; orb: number; ftr: number; tpar: number };
/** exponentially weighted mean of a team's numbers (decay a game; halved at a new season) */
class EW {
  s = [0, 0, 0, 0, 0]; w = 0; season = '';
  add(x: number[], season: string, decay = 0.93) {
    if (season !== this.season) { this.s = this.s.map(v => v * 0.5); this.w *= 0.5; this.season = season; }
    this.s = this.s.map((v, i) => v * decay + x[i]); this.w = this.w * decay + 1;
  }
  mean(lg: number[], n0 = 5) { return this.s.map((v, i) => (v + n0 * lg[i]) / (this.w + n0)); }
}
const ffArr = (f: FF) => [f.efg, f.tov, f.orb, f.ftr, f.tpar];

/** Team values at one moment (the live state keeps the last of these per team). */
export type TeamSnap = {
  imp: number; miss: number; stay: number; net: number; ff: number[]; ffAg: number[]; form: number; wins: number; gp: number; season: string;
  /**
   * fix224 (live snapshot only): players of the team's last 10 games — [id, rating, projected minutes, team games since
   * he last played]; fix225: + [on/off rating with the minutes-scaled shrink, box-score value, 1 = one of the team's top 3]
   */
  pl?: PlRow[];
  /** fix225: #1, #4, #4's top-3 part and #8 (not faded) under the A ratings, then the same under the B values */
  nv?: number[];
};
export type PlRow = [number, number, number, number, number?, number?, number?];
export type LeagueSnap = {
  code: string; gameMin: number; teams: Map<number, TeamSnap>; lg: number[]; pace: number; seasonLen: number;
  h2h: Map<string, [number, number, number][]>; builtAt: string;
};

/** the row values of one game from the two teams' snapshots and the game's own facts */
export function rowsOf(s: { lg: number[]; seasonLen: number; h2h: Map<string, [number, number, number][]> }, h: TeamSnap, a: TeamSnap, f: {
  base: { p: number; sig: number; hca: number; haH: number; haA: number; b2bH: boolean; b2bA: boolean };
  home: number; away: number; ms: number; rs: boolean; neutral: boolean; three: [boolean, boolean]; gpH: number; gpA: number; missH?: number; missA?: number;
}): { hv: number[]; av: number[] } {
  const hv = new Array<number>(N_ROWS).fill(0), av = new Array<number>(N_ROWS).fill(0);
  const lg = s.lg;
  hv[0] = h.imp; av[0] = a.imp;
  hv[1] = h.net; av[1] = a.net;
  const v3m = f.base.sig * probit(f.base.p); // bb-v3's whole prediction as a margin
  hv[2] = v3m / 2; av[2] = -v3m / 2;
  hv[3] = f.missH ?? h.miss; av[3] = f.missA ?? a.miss;
  const ffv = (t: TeamSnap) => 100 * (0.4 * (t.ff[0] - t.ffAg[0]) - 0.25 * (t.ff[1] - t.ffAg[1]) + 0.2 * (t.ff[2] - t.ffAg[2]) + 0.15 * (t.ff[3] - t.ffAg[3]));
  hv[4] = ffv(h); av[4] = ffv(a);
  hv[5] = -(f.base.b2bH ? 1 : 0) - (f.three[0] && !f.base.b2bH ? 0.5 : 0);
  av[5] = -(f.base.b2bA ? 1 : 0) - (f.three[1] && !f.base.b2bA ? 0.5 : 0);
  hv[6] = f.neutral ? 0 : f.base.hca + f.base.haH; av[6] = f.neutral ? 0 : f.base.haA;
  const ramp = (gp: number) => Math.max(0, 1 - gp / 25);
  hv[7] = h.stay * ramp(f.gpH); av[7] = a.stay * ramp(f.gpA);
  const mu = (t: TeamSnap, o: TeamSnap) => 1000 * ((t.ff[0] - lg[0]) * (o.ffAg[0] - lg[0]) + (t.ff[2] - lg[2]) * (o.ffAg[2] - lg[2]) + (t.ff[1] - lg[1]) * (o.ffAg[1] - lg[1]));
  hv[8] = mu(h, a); av[8] = mu(a, h);
  hv[9] = h.form; av[9] = a.form;
  const tank = (t: TeamSnap, gp: number) => (f.rs && s.seasonLen > 10 && gp >= 0.75 * s.seasonLen && t.gp > 0 && t.wins / t.gp < 0.3 ? -1 : 0);
  hv[10] = tank(h, f.gpH); av[10] = tank(a, f.gpA);
  hv[VOL] = h.ff[4] - lg[4]; av[VOL] = a.ff[4] - lg[4];
  const key = f.home < f.away ? `${f.home}|${f.away}` : `${f.away}|${f.home}`;
  const met = (s.h2h.get(key) || []).filter(x => f.ms - x[0] < 730 * DAY).slice(-3);
  hv[12] = met.length ? (met.reduce((acc, x) => acc + (x[1] === f.home ? x[2] : -x[2]), 0) / 3) : 0;
  return { hv: hv.map(r3), av: av.map(r3) };
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;

type G = { id: number; season: string; ms: number; iso: string; home: number; away: number; hs: number | null; as_: number | null; finished: boolean; pre: boolean; rs: boolean; neutral: boolean };

/** Ridge on team indicators: per-100 margin = rating_home − rating_away + home (small penalty). */
function netFit(rows: { h: number; a: number; y: number; w: number }[], lambda = 5): Map<number, number> {
  const idx = new Map<number, number>();
  for (const r of rows) for (const t of [r.h, r.a]) if (!idx.has(t)) idx.set(t, idx.size);
  const n = idx.size + 1, A = new Float64Array(n * n), b = new Float64Array(n);
  for (const r of rows) {
    const xi = [idx.get(r.h)!, idx.get(r.a)!, n - 1], xv = [1, -1, 1];
    for (let i = 0; i < 3; i++) { b[xi[i]] += r.w * xv[i] * r.y; for (let j = 0; j < 3; j++) A[xi[i] * n + xi[j]] += r.w * xv[i] * xv[j]; }
  }
  for (let i = 0; i < n - 1; i++) A[i * n + i] += lambda;
  A[(n - 1) * n + n - 1] += 1e-6;
  const x = choleskySolve(A, b, n);
  return new Map([...idx].map(([t, i]) => [t, x[i]]));
}

/**
 * One league's replay: rows of every finished game (with bb-v3's walk-forward pieces) and the teams' latest values.
 * `base` = gridBaseOf(code) from the build that just ran. fix225: `box` = the box-score formula (storedBox()).
 */
export async function replayLeague(code: string, base: Map<number, GridBase>, formula: BoxCoef = storedBox()): Promise<{ items: GridItem[]; snap: LeagueSnap }> {
  const L = gameMinOf(code);
  const IMP_VER = impVer(formula);
  const games: G[] = (db.prepare(`SELECT game_id, season, kickoff, status, home_id, away_id, hs, as_, stage FROM bb_games WHERE code = ? ORDER BY kickoff, game_id`).all(code) as any[]).map(g => {
    const pre = isPre(code, g.kickoff);
    return { id: g.game_id, season: g.season, ms: Date.parse(g.kickoff), iso: g.kickoff, home: g.home_id, away: g.away_id, hs: g.hs, as_: g.as_, finished: ['FT', 'AOT'].includes(g.status) && g.hs !== null && g.as_ !== null, pre, rs: !pre && isRegular(g.stage), neutral: isNeutral(code, g.stage) };
  });
  const lines = new Map<number, [number, number, number, BoxTot][]>();
  for (const r of db.prepare(`SELECT ps.game_id, ps.team_id, ps.player_id, ps.minutes, ps.pts, ps.fga, ps.fta, ps.tpm, ps.reb, ps.ast FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = ? AND ps.minutes > 0`).all(code) as any[]) {
    let l = lines.get(r.game_id); if (!l) lines.set(r.game_id, (l = [])); l.push([r.team_id, r.player_id, r.minutes, totOf(r)]);
  }
  const box = new Map<number, Map<number, any>>();
  for (const r of db.prepare(`SELECT t.* FROM bb_team_stats t JOIN bb_games g ON g.game_id = t.game_id WHERE g.code = ? AND t.fga > 0`).all(code) as any[]) {
    let m = box.get(r.game_id); if (!m) box.set(r.game_id, (m = new Map())); m.set(r.team_id, r);
  }
  const cache = new Map<number, number[]>();
  for (const r of db.prepare(`SELECT game_id, v FROM bb_grid_imp WHERE code = ? AND ver = ?`).all(code, IMP_VER) as any[]) { try { cache.set(r.game_id, (JSON.parse(r.v) as (number | null)[]).map(x => (x === null ? NaN : x))); } catch { /* recompute */ } }
  const draft = draftInfo(code);
  await yieldLoop();

  // ---- state ----
  const fitRows: (FitGame & { s: number })[] = [], netRows: { h: number; a: number; y: number; s: number }[] = [];
  let fit: ImpactFit | null = null, fitA: ImpactFit | null = null, boxNow: Map<number, number> | null = null;
  let net = new Map<number, number>(), nextFit = Infinity, fitSeason = '';
  const rs = new Map<number, number[]>(), pre = new Map<number, number[]>();
  let preSeason: string | null = null;
  const rosters = new Map<number, number[][]>();
  const rosters10 = new Map<number, number[][]>(); // fix224: the last 10 games (key players)
  const seasonPlayers = new Map<string, Set<number>>(); // `${team}|${season}` → players who appeared
  const ewF = new Map<number, EW>(), ewA = new Map<number, EW>();
  let lg = [0.5, 0.14, 0.27, 0.2, 0.38], lgN = 0, pace = 75;
  const form = new Map<number, number[]>(), wins = new Map<string, number>(), gp = new Map<string, number>();
  const seasonGames = new Map<string, number>(); // `${season}` → most regular-season games by a team
  const h2h = new Map<string, [number, number, number][]>();
  const lastKo = new Map<number, number[]>();
  // fix225: box-score totals per player × team × season, team games / possessions per season, end-of-season values
  const tots = new Map<string, Map<string, Stint>>(); // season → `${pid}|${team}` → stint
  const tGames = new Map<string, number>(), tPoss = new Map<string, [number, number]>();
  const prevVal = new Map<number, number>();
  const items: GridItem[] = [];
  const newImp: [number, number[]][] = [];
  const finished = games.filter(g => g.finished);
  const lastFinishedMs = finished.length ? finished[finished.length - 1].ms : 0;
  const FULL = fullMinutes(L);

  const priorOf = (id: number, season: string) => { const d = draft.get(id); return d && d.year !== null && d.year >= startYear(season) - 1 ? draftPrior(d.pick, d.round) : NO_PRIOR; };
  /** this season's box values (team adjustment to the net rating now), each blended with last season's / the prior */
  const boxValues = (season: string): Map<number, number> => {
    const st = [...(tots.get(season)?.values() || [])];
    const team = (t: number) => `${t}|${season}`;
    const paces = [...new Set(st.map(x => x.team))].map(t => tPoss.get(team(t))).filter((x): x is [number, number] => !!x && x[1] > 0);
    const lgPace = paces.length ? paces.reduce((a, x) => a + x[0], 0) / paces.reduce((a, x) => a + x[1], 0) : 0;
    const paceAdj = new Map<number, number>(), nets = new Map<number, number>(), gms = new Map<number, number>();
    for (const t of new Set(st.map(x => x.team))) {
      const pp = tPoss.get(team(t));
      paceAdj.set(t, pp && pp[1] >= 3 && lgPace > 0 ? lgPace / (pp[0] / pp[1]) : 1);
      nets.set(t, ((net.get(t) || 0) * pace) / 100);
      gms.set(t, tGames.get(team(t)) || 0);
    }
    // early in a season (under ~20 team games of minutes) the league means come from last season's totals too
    let pool = st;
    const minutes = st.reduce((a, x) => a + x.tot.min, 0);
    if (minutes < 5 * L * 20) { const prev = tots.get(prevSeasonOf(season)); if (prev) pool = [...st, ...prev.values()]; }
    const lgR = leagueRates(pool.map(x => ({ tot: x.tot, paceAdj: paceAdj.get(x.team) ?? 1 })), L);
    const cur = stintValues(st, formula.c, L, lgR, paceAdj, nets, gms);
    const out = new Map<number, number>();
    for (const [id, v] of prevVal) out.set(id, v);
    for (const [id, c] of cur) out.set(id, carry(c, prevVal.get(id) ?? priorOf(id, season), FULL));
    return out;
  };
  const rC = (id: number) => (fit ? (fit.ratings.get(id) ?? -1) : 0);
  const rA = (id: number, season: string) => (fitA ? (fitA.ratings.get(id) ?? priorOf(id, season)) : 0);
  const rB = (id: number, season: string) => (boxNow ? (boxNow.get(id) ?? priorOf(id, season)) : 0);

  const side = (team: number, only?: Set<number>) => {
    const ids = only || new Set<number>();
    if (!only) for (const r of rosters.get(team) || []) for (const id of r) ids.add(id);
    const out: RotPlayer[] = [];
    for (const id of ids) { const m = projMinutes(rs.get(id), preSeason ? pre.get(id) : undefined); if (m !== null) out.push({ id, min: m, rating: 0 }); }
    return out;
  };
  /** strength of the rotation under the three rating sets: [C (fix219), A, B] (one rotation: minutes don't depend on ratings) */
  const S3 = (pl: RotPlayer[], season: string, keep?: Map<number, number>): number[] => {
    const rot = rotation(pl, keep, L);
    const o = [0, 0, 0];
    for (const p of rot) { const k = p.proj / L; o[0] += rC(p.id) * k; o[1] += rA(p.id, season) * k; o[2] += rB(p.id, season) * k; }
    return o;
  };
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const impParts = (team: number, season: string) => {
    const pl = side(team), full = S3(pl, season);
    const last2 = new Set((rosters.get(team) || []).slice(-2).flat());
    const keep = new Map<number, number>();
    if ((rosters.get(team) || []).length >= 3) for (const p of pl) if (!last2.has(p.id)) keep.set(p.id, 0);
    const miss = keep.size ? sub(S3(pl, season, keep), full) : [0, 0, 0];
    const top = topIds(pl.map(p => ({ id: p.id, box: rB(p.id, season), min: p.min })));
    const keepTop = new Map([...keep].filter(([id]) => top.has(id)));
    const missTop = keepTop.size ? sub(S3(pl, season, keepTop), full) : [0, 0, 0];
    const prevSet = seasonPlayers.get(`${team}|${prevSeasonOf(season)}`);
    const stay = prevSet ? S3(pl.filter(p => prevSet.has(p.id)), season) : [0, 0, 0];
    return { pl, full, miss, missTop, stay, top };
  };
  const seasonsSeen: string[] = [];
  const prevSeasonOf = (s: string) => { const i = seasonsSeen.indexOf(s); return i > 0 ? seasonsSeen[i - 1] : seasonsSeen.length && seasonsSeen[seasonsSeen.length - 1] !== s ? seasonsSeen[seasonsSeen.length - 1] : ''; };
  const snapOf = (team: number, season: string): TeamSnap => {
    const p = impParts(team, season);
    const f = ewF.get(team)?.mean(lg) || lg, ag = ewA.get(team)?.mean(lg) || lg;
    const fl = form.get(team) || [];
    return {
      imp: p.full[0], miss: p.miss[0], stay: p.stay[0], net: ((net.get(team) || 0) * pace) / 100, ff: f, ffAg: ag, form: fl.length ? fl.reduce((x, y) => x + y, 0) / fl.length : 0, wins: wins.get(`${team}|${season}`) || 0, gp: gp.get(`${team}|${season}`) || 0, season,
      nv: [p.full[1], p.miss[1], p.missTop[1], p.stay[1], p.full[2], p.miss[2], p.missTop[2], p.stay[2]].map(r3)
    };
  };

  let i = 0;
  for (const g of games) {
    if (++i % 300 === 0) await yieldLoop();
    if (!seasonsSeen.includes(g.season)) {
      // fix225: the season that ended → every player's value carried into the next one (traded players keep theirs)
      if (seasonsSeen.length) { const last = seasonsSeen[seasonsSeen.length - 1]; for (const [id, v] of boxValues(last)) prevVal.set(id, v); }
      seasonsSeen.push(g.season);
    }
    if (!g.pre && g.finished && (fitSeason !== g.season || g.ms >= nextFit)) {
      const end = Math.floor(g.ms / DAY) * DAY + 14 * DAY;
      // refit the impact only when a game of this window has no stored value (the live state gets its own fit at the end)
      const need = finished.some(x => x.ms >= g.ms && x.ms < end && !x.pre && !cache.has(x.id));
      const cur = startYear(g.season);
      const nu = netRows.filter(r => r.s >= cur - 2 && r.s <= cur).map(r => ({ ...r, w: Math.pow(0.5, cur - r.s) }));
      if (nu.length >= 30) net = netFit(nu);
      if (need) {
        const use = fitRows.filter(r => r.s >= cur - 2 && r.s <= cur).map(r => ({ ...r, w: Math.pow(0.5, cur - r.s) }));
        if (use.length >= 50) { fit = ridgeFit(use, 30, L); await yieldLoop(); fitA = ridgeFit(use, 30, L, shrinkLambda); }
        boxNow = boxValues(g.season);
      }
      fitSeason = g.season; nextFit = end;
      await yieldLoop();
    }
    if (g.pre && preSeason !== g.season) { preSeason = g.season; pre.clear(); }
    if (!g.finished) continue;
    const b = base.get(g.id);
    const ls = lines.get(g.id) || [];
    const kH = `${g.home}|${g.season}`, kA = `${g.away}|${g.season}`;
    if (b && !g.pre && (fit || cache.has(g.id))) {
      let v = cache.get(g.id);
      if (!v || v.length < 27) {
        const ph = impParts(g.home, g.season), pa = impParts(g.away, g.season);
        const played = (t: number) => new Set(ls.filter(l => l[0] === t).map(l => l[1]));
        const oh = played(g.home), oa = played(g.away);
        let oracle = [NaN, NaN, NaN], otop = [NaN, NaN, NaN];
        if (oh.size >= 5 && oa.size >= 5) {
          oracle = sub(sub(S3(side(g.home, oh), g.season), ph.full), sub(S3(side(g.away, oa), g.season), pa.full));
          // the top-3 players who did not play, alone (the rest of the roster as expected)
          const lostTop = (p: typeof ph, o: Set<number>) => { const k = new Map([...p.top].filter(id => !o.has(id)).map(id => [id, 0] as [number, number])); return k.size ? sub(S3(p.pl, g.season, k), p.full) : [0, 0, 0]; };
          otop = sub(lostTop(ph, oh), lostTop(pa, oa));
        }
        const part = (k: number) => [ph.full[k], pa.full[k], ph.miss[k], pa.miss[k], ph.missTop[k], pa.missTop[k], ph.stay[k], pa.stay[k], oracle[k], otop[k]];
        v = [ph.full[0], pa.full[0], ph.miss[0], pa.miss[0], ph.stay[0], pa.stay[0], oracle[0], ...part(1), ...part(2)].map(x => (Number.isFinite(x) ? r3(x) : NaN));
        newImp.push([g.id, v]);
      }
      const sh = snapOf(g.home, g.season), sa = snapOf(g.away, g.season);
      sh.imp = v[0]; sa.imp = v[1]; sh.miss = v[2]; sa.miss = v[3]; sh.stay = v[4]; sa.stay = v[5];
      const three = (t: number) => { const k = lastKo.get(t) || []; return k.length >= 2 && g.ms - k[k.length - 2] <= 3.5 * DAY; };
      const prevLen = seasonGames.get(prevSeasonOf(g.season)) || 0;
      const r = rowsOf({ lg, seasonLen: prevLen, h2h }, sh, sa, { base: b, home: g.home, away: g.away, ms: g.ms, rs: g.rs, neutral: g.neutral, three: [three(g.home), three(g.away)], gpH: sh.gp, gpA: sa.gp });
      // fix225: the A / B parts as rows (#8 faded like rowsOf: full at game 0, gone by game 25)
      const rampH = Math.max(0, 1 - sh.gp / 25), rampA = Math.max(0, 1 - sa.gp / 25);
      const alt: (number | null)[] = [];
      for (const o of [7, 17]) {
        const x = v.slice(o, o + 10);
        alt.push(x[0], x[1], x[2], x[3], x[4], x[5], r3(x[6] * rampH), r3(x[7] * rampA), Number.isFinite(x[8]) ? x[8] : null, Number.isFinite(x[9]) ? x[9] : null);
      }
      items.push({ id: g.id, code, season: g.season, year: startYear(g.season), gp: Math.min(sh.gp, sa.gp), y: g.hs! > g.as_! ? 1 : 0, v3: b.p, sig: b.sig, hv: r.hv, av: r.av, oracle: Number.isFinite(v[6]) ? v[6] : null, alt: alt.length === ALT.len ? alt : null });
    }
    // ---- after the game: the history grows ----
    const per = new Map<number, number[]>(), h: [number, number][] = [], a: [number, number][] = [];
    const counts = !g.pre && (code !== 'NBA' || g.rs);
    for (const [team, pid, min, bt] of ls) {
      if (team === g.home) h.push([pid, min]); else if (team === g.away) a.push([pid, min]); else continue;
      let x = per.get(team); if (!x) per.set(team, (x = [])); x.push(pid);
      if (counts) {
        let r = rs.get(pid); if (!r) rs.set(pid, (r = [])); r.push(min); if (r.length > 15) r.shift();
        let ts = tots.get(g.season); if (!ts) tots.set(g.season, (ts = new Map()));
        const k = `${pid}|${team}`; let st = ts.get(k); if (!st) ts.set(k, (st = { id: pid, team, tot: emptyTot() }));
        addTot(st.tot, bt);
      }
      else if (g.pre) { let r = pre.get(pid); if (!r) pre.set(pid, (r = [])); r.push(min); }
      if (!g.pre) { const k = `${team}|${g.season}`; let s = seasonPlayers.get(k); if (!s) seasonPlayers.set(k, (s = new Set())); s.add(pid); }
    }
    if (counts && per.size) for (const t of per.keys()) tGames.set(`${t}|${g.season}`, (tGames.get(`${t}|${g.season}`) || 0) + 1);
    for (const [team, ids] of per) {
      const r = rosters.get(team) || []; r.push(ids); if (r.length > 3) r.shift(); rosters.set(team, r);
      if (!g.pre) { const r10 = rosters10.get(team) || []; r10.push(ids); if (r10.length > 10) r10.shift(); rosters10.set(team, r10); }
    }
    if (!g.pre && (code !== 'NBA' || g.rs) && h.length >= 5 && a.length >= 5) fitRows.push({ home: h, away: a, margin: g.hs! - g.as_!, w: 1, s: startYear(g.season) });
    const bx = box.get(g.id);
    if (bx && bx.has(g.home) && bx.has(g.away) && !g.pre) {
      const th = bx.get(g.home), ta = bx.get(g.away);
      const possOf = (t: any) => t.fga - (t.oreb || 0) + (t.tov || 0) + 0.44 * (t.fta || 0);
      const poss = (possOf(th) + possOf(ta)) / 2;
      if (poss > 40) {
        if (counts) for (const t of [g.home, g.away]) { const k = `${t}|${g.season}`; const x = tPoss.get(k) || [0, 0]; x[0] += poss; x[1]++; tPoss.set(k, x); }
        netRows.push({ h: g.home, a: g.away, y: (100 * (g.hs! - g.as_!)) / poss, s: startYear(g.season) });
        pace += (lgN < 50 ? 0.1 : 0.01) * (poss - pace);
        const ff = (t: any, o: any): FF => ({ efg: (t.fgm + 0.5 * (t.tpm || 0)) / t.fga, tov: (t.tov || 0) / poss, orb: (t.oreb || 0) / Math.max(1, (t.oreb || 0) + (o.dreb || 0)), ftr: (t.ftm || 0) / t.fga, tpar: (t.tpa || 0) / t.fga });
        const fh = ffArr(ff(th, ta)), fa = ffArr(ff(ta, th));
        for (const [t, mine, theirs] of [[g.home, fh, fa], [g.away, fa, fh]] as [number, number[], number[]][]) {
          let e = ewF.get(t); if (!e) ewF.set(t, (e = new EW())); e.add(mine, g.season);
          let x = ewA.get(t); if (!x) ewA.set(t, (x = new EW())); x.add(theirs, g.season);
        }
        const al = lgN < 100 ? 0.05 : 0.005;
        lg = lg.map((v, k) => v + al * ((fh[k] + fa[k]) / 2 - v)); lgN++;
      }
    }
    if (b) {
      const res = g.hs! - g.as_! - b.m1; // home view, against bb-v1's expectation
      for (const [t, r] of [[g.home, res], [g.away, -res]] as [number, number][]) { const l = form.get(t) || []; l.push(r); if (l.length > 10) l.shift(); form.set(t, l); }
      const key = g.home < g.away ? `${g.home}|${g.away}` : `${g.away}|${g.home}`;
      const l = h2h.get(key) || []; l.push([g.ms, g.home, r3(res)]); if (l.length > 6) l.shift(); h2h.set(key, l);
    }
    if (!g.pre) {
      for (const [k, t] of [[kH, g.home], [kA, g.away]] as [string, number][]) {
        gp.set(k, (gp.get(k) || 0) + 1);
        if ((t === g.home) === (g.hs! > g.as_!)) wins.set(k, (wins.get(k) || 0) + 1);
        if (g.rs) seasonGames.set(g.season, Math.max(seasonGames.get(g.season) || 0, gp.get(k)!));
      }
    }
    for (const t of [g.home, g.away]) { const k = lastKo.get(t) || []; k.push(g.ms); if (k.length > 3) k.shift(); lastKo.set(t, k); }
  }
  // stored impact parts of the games computed now (the next build skips their fits)
  if (newImp.length) {
    const up = db.prepare(`INSERT OR REPLACE INTO bb_grid_imp (game_id, code, ver, v) VALUES (?, ?, ?, ?)`);
    db.exec('BEGIN');
    try { for (const [id, v] of newImp) up.run(id, code, IMP_VER, JSON.stringify(v.map(x => (Number.isFinite(x) ? x : null)))); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  // the live values use a fit of everything played so far (a cached last window, or a league ending in pre-season,
  // would otherwise leave no fit or an old one)
  const lastSeason = finished.length ? finished[finished.length - 1].season : '';
  if (lastSeason) {
    const cur = startYear(lastSeason);
    const use = fitRows.filter(r => r.s >= cur - 2 && r.s <= cur).map(r => ({ ...r, w: Math.pow(0.5, cur - r.s) }));
    if (use.length >= 50) { fit = ridgeFit(use, 30, L); await yieldLoop(); fitA = ridgeFit(use, 30, L, shrinkLambda); }
    boxNow = boxValues(seasonsSeen[seasonsSeen.length - 1] || lastSeason);
  }
  // the latest values of every team that played in the last 400 days (the live predictions)
  const teams = new Map<number, TeamSnap>();
  const recent = games.filter(g => g.finished && lastFinishedMs - g.ms < 400 * DAY);
  const cur = recent.length ? recent[recent.length - 1].season : '';
  // fix224: each team's players of its last 10 games (key players card, row #4 with news / rest statuses)
  const plOf = (team: number, top: Set<number>): PlRow[] => {
    const r10 = rosters10.get(team) || [], seen = new Map<number, number>();
    r10.forEach((ids, k) => { for (const id of ids) seen.set(id, r10.length - 1 - k); });
    const out: PlRow[] = [];
    for (const [id, since] of seen) { const m = projMinutes(rs.get(id), preSeason ? pre.get(id) : undefined); if (m !== null) out.push([id, r3(rC(id)), r3(m), since, r3(rA(id, cur)), r3(rB(id, cur)), top.has(id) ? 1 : 0]); }
    return out;
  };
  for (const g of recent) for (const t of [g.home, g.away]) if (!teams.has(t)) {
    const top = topIds(side(t).map(p => ({ id: p.id, box: rB(p.id, cur), min: p.min })));
    teams.set(t, { ...snapOf(t, cur), pl: plOf(t, top) });
  }
  // seasonLen for the live tank rule: the last finished season
  const seasonLen = seasonGames.get(prevSeasonOf(cur)) || seasonGames.get(cur) || 0;
  return { items, snap: { code, gameMin: L, teams, lg, pace, seasonLen, h2h, builtAt: new Date().toISOString() } };
}

const totOf = (r: any): BoxTot => ({ min: Number(r.minutes) || 0, pts: Number(r.pts) || 0, fga: Number(r.fga) || 0, fta: Number(r.fta) || 0, tpm: Number(r.tpm) || 0, reb: Number(r.reb) || 0, ast: Number(r.ast) || 0 });

/** fix225: NBA draft slot per player (balldontlie bios matched by name): the rookies' prior */
function draftInfo(code: string): Map<number, { pick: number | null; round: number | null; year: number | null }> {
  const out = new Map<number, { pick: number | null; round: number | null; year: number | null }>();
  if (code !== 'NBA') return out;
  try {
    const byKey = new Map<string, any>();
    for (const r of db.prepare(`SELECT name_key, draft_year, draft_round, draft_number FROM bdl_players WHERE name_key IS NOT NULL ORDER BY active, updated_at`).all() as any[]) byKey.set(r.name_key, r);
    for (const r of db.prepare(`SELECT DISTINCT ps.player_id, ps.name FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = 'NBA' AND ps.name IS NOT NULL`).all() as any[]) {
      const b = byKey.get(personKey(r.name));
      if (b) out.set(r.player_id, { pick: b.draft_number ?? null, round: b.draft_round ?? null, year: b.draft_year ?? null });
    }
  } catch { /* no balldontlie table: everyone gets the plain prior */ }
  return out;
}
const personKey = (name: string) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(w)).sort().join(' ');

/* ---------- fix225: the box-score formula (fitted once per database on 2022-23 … 2024-25) ---------- */

/** the stored formula (bb_tuned 'box'), else the code default */
export function storedBox(): BoxCoef {
  try {
    const r = db.prepare(`SELECT params FROM bb_tuned WHERE id = 'box'`).get() as any;
    if (r) { const b = JSON.parse(r.params) as BoxCoef; if (Array.isArray(b.c) && b.c.length === BOX_DEFAULT.c.length) return b; }
  } catch { /* default */ }
  return BOX_DEFAULT;
}
/**
 * Fit the formula on every league's train seasons: each game's margin against the players' season rates without that
 * game (pace-adjusted, minus the league-season mean; under 50 such minutes = average), weighted by their minutes in it
 * (utils/boxValue.fitBoxCoef). Stored in bb_tuned 'box'; the rows are rebuilt with it on the next model build (the
 * formula's version is part of the impact cache key). Never the test season or the live period (assertBoxTrain).
 */
export async function fitBoxFormula(train: number[] = BOX_TRAIN): Promise<BoxCoef & { home: number; rmse: number }> {
  assertBoxTrain(train);
  const t0 = Date.now();
  const rows = db.prepare(`SELECT g.game_id, g.code, g.season, g.kickoff, g.home_id, g.away_id, g.hs, g.as_, g.stage, ps.team_id, ps.player_id, ps.minutes, ps.pts, ps.fga, ps.fta, ps.tpm, ps.reb, ps.ast
    FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND ps.minutes > 0`).all() as any[];
  await yieldLoop();
  type GL = { code: string; season: string; home: number; away: number; margin: number; lines: [number, number, BoxTot][] };
  const byGame = new Map<number, GL>();
  for (const r of rows) {
    if (!train.includes(startYear(r.season))) continue;
    if (isPre(r.code, r.kickoff) || (r.code === 'NBA' && !isRegular(r.stage))) continue;
    let g = byGame.get(r.game_id); if (!g) byGame.set(r.game_id, (g = { code: r.code, season: r.season, home: r.home_id, away: r.away_id, margin: r.hs - r.as_, lines: [] }));
    g.lines.push([r.team_id, r.player_id, totOf(r)]);
  }
  const poss = new Map<number, number>();
  for (const r of db.prepare(`SELECT game_id, SUM(fga - COALESCE(oreb, 0) + COALESCE(tov, 0) + 0.44 * COALESCE(fta, 0)) / 2.0 AS p FROM bb_team_stats WHERE fga > 0 GROUP BY game_id HAVING COUNT(*) = 2`).all() as any[]) poss.set(r.game_id, r.p);
  // season totals per player × team, team pace, league pace and means (per league-season)
  const tot = new Map<string, BoxTot>(), tp = new Map<string, [number, number]>(), lp = new Map<string, [number, number]>();
  for (const [id, g] of byGame) {
    for (const [team, pid, bt] of g.lines) { const k = `${g.code}|${g.season}|${team}|${pid}`; addTot(tot.get(k) || (tot.set(k, emptyTot()), tot.get(k)!), bt); }
    const p = poss.get(id);
    if (p && p > 40) for (const t of [g.home, g.away]) {
      const k = `${g.code}|${g.season}|${t}`; const x = tp.get(k) || [0, 0]; x[0] += p; x[1]++; tp.set(k, x);
      const l = `${g.code}|${g.season}`; const y = lp.get(l) || [0, 0]; y[0] += p; y[1]++; lp.set(l, y);
    }
  }
  const adjOf = (code: string, season: string, team: number) => { const t = tp.get(`${code}|${season}|${team}`), l = lp.get(`${code}|${season}`); return t && l && t[1] >= 3 ? (l[0] / l[1]) / (t[0] / t[1]) : 1; };
  const lgMean = new Map<string, number[]>();
  const byLs = new Map<string, { tot: BoxTot; paceAdj: number }[]>();
  for (const [k, t] of tot) { const [code, season, team] = k.split('|'); const l = `${code}|${season}`; let x = byLs.get(l); if (!x) byLs.set(l, (x = [])); x.push({ tot: t, paceAdj: adjOf(code, season, Number(team)) }); }
  for (const [l, x] of byLs) lgMean.set(l, leagueRates(x, gameMinOf(l.split('|')[0])));
  await yieldLoop();
  const fitGames: BoxFitGame[] = [];
  let n = 0;
  for (const g of byGame.values()) {
    if (++n % 2000 === 0) await yieldLoop();
    const L = gameMinOf(g.code), lgR = lgMean.get(`${g.code}|${g.season}`)!;
    const side = (team: number): [number, number[]][] => g.lines.filter(l => l[0] === team).map(([t, pid, bt]) => {
      const loo = addTot({ ...tot.get(`${g.code}|${g.season}|${t}|${pid}`)! }, bt, -1);
      const r = loo.min >= 50 ? ratesOf(loo, L, adjOf(g.code, g.season, t)) : null;
      return [bt.min, r ? r.map((v, k) => v - lgR[k]) : new Array(lgR.length).fill(0)];
    });
    const h = side(g.home), a = side(g.away);
    if (h.length >= 5 && a.length >= 5) fitGames.push({ home: h, away: a, L, margin: g.margin });
  }
  const f = fitBoxCoef(fitGames);
  const at = new Date().toISOString();
  const coef: BoxCoef & { home: number; rmse: number } = { c: f.c, version: `fit ${at.slice(0, 10)}`, fittedAt: at, train, games: f.games, home: f.home, rmse: f.rmse };
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('box', ?, ?, ?)`).run(JSON.stringify(coef), JSON.stringify({ ...coef, seconds: Math.round((Date.now() - t0) / 1000), rule: BOX_RULE }), at);
  logger.info(`bb box-score formula fitted on ${train.join(', ')}: ${f.games} games, coefficients ${f.c.join(' / ')} (points, shot attempts, 3PM, rebounds, assists), home ${f.home}, rmse ${f.rmse}`);
  return coef;
}
const BOX_RULE = 'fix225';
/** the model build fits the formula once per database (before the grid rows are replayed) */
export function boxFitDue(): boolean {
  try { const r = db.prepare(`SELECT report FROM bb_tuned WHERE id = 'box'`).get() as any; return !r || JSON.parse(r.report || '{}').rule !== BOX_RULE; } catch { return true; }
}

/** Write a league's rows for the tuner / gate (replaces the league's old rows). */
export function storeRows(code: string, items: GridItem[]) {
  const up = db.prepare(`INSERT OR REPLACE INTO bb_grid_rows (game_id, code, season, ms, gp, y, v3, sig, hv, av, oracle, alt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM bb_grid_rows WHERE code = ?`).run(code);
    for (const it of items) up.run(it.id, code, it.season, 0, it.gp, it.y, it.v3, it.sig, JSON.stringify(it.hv), JSON.stringify(it.av), it.oracle, it.alt ? JSON.stringify(it.alt) : null);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/** Every league's stored rows (the tuner and the gate) */
export function loadRows(codes?: string[]): GridItem[] {
  const q = codes && codes.length ? ` WHERE r.code IN (${codes.map(() => '?').join(',')})` : '';
  // fix223: + the final margin (mg: the league settings' spread of results)
  return (db.prepare(`SELECT r.*, g.hs - g.as_ AS mg FROM bb_grid_rows r LEFT JOIN bb_games g ON g.game_id = r.game_id${q}`).all(...(codes || [])) as any[]).map(r => ({
    id: r.game_id, code: r.code, season: r.season, year: startYear(r.season), gp: r.gp, y: r.y, v3: r.v3, sig: r.sig, hv: JSON.parse(r.hv), av: JSON.parse(r.av), oracle: r.oracle,
    mg: typeof r.mg === 'number' ? r.mg : null, alt: r.alt ? JSON.parse(r.alt) : null
  }));
}

/* ---------- live state (every process that predicts) ---------- */
const snaps = new Map<string, LeagueSnap>();
let snapVer = 0;
/**
 * fix224: same-day statuses of players outside the NBA (news "reported out", EuroLeague double-week rest) for row #4:
 * keep share per player id (services/keyPlayers.ts registers it; a hook keeps the import one way). null = none.
 */
type KeepHook = (g: { code: string; game_id?: number; kickoff: string }, teamId: number) => Map<number, number> | null;
let keepHook: KeepHook | null = null;
export function setKeepHook(f: KeepHook) { keepHook = f; }
/** fix224: a new news / rest state changes the predictions (part of their cache key) */
export function bumpGridVer() { snapVer++; }
/**
 * Row #4 of a team in an upcoming game with the hook's statuses on top of the usual rule (rotation players of the last 3
 * games who missed the last 2 sit). undefined = the hook has nothing for the team (the snapshot's own value stays).
 */
function missWithHook(s: LeagueSnap, g: { code: string; game_id?: number; kickoff: string }, teamId: number, t: TeamSnap, imp?: Imp): { miss: number; top: number } | undefined {
  const extra = keepHook && t.pl ? keepHook(g, teamId) : null;
  if (!extra || !extra.size || !t.pl) return undefined;
  const pl = t.pl.filter(p => p[3] <= 2).map(p => ({ id: p[0], min: p[2], rating: plRating(p, imp) }));
  const keep = new Map<number, number>();
  if (t.pl.some(p => p[3] >= 2)) for (const p of t.pl) if (p[3] === 2) keep.set(p[0], 0); // missed the last 2 (in the last 3)
  for (const [id, k] of extra) keep.set(id, Math.min(k, keep.get(id) ?? 1));
  const S = (k?: Map<number, number>) => strength(rotation(pl, k, s.gameMin), s.gameMin);
  const full = S(), top = new Set(t.pl.filter(p => p[6] === 1).map(p => p[0]));
  const keepTop = new Map([...keep].filter(([id]) => top.has(id)));
  return { miss: S(keep) - full, top: keepTop.size ? S(keepTop) - full : 0 };
}
/** fix225: the impact setting live (bbTuner passes gs.params.impact): wb = the box-score share */
export type Imp = { wb: number } | null | undefined;
/** a snapshot player's rating under the setting (fix219's on/off without one, or a row from before fix225) */
export const plRating = (p: PlRow, imp: Imp) => (imp && typeof p[4] === 'number' && typeof p[5] === 'number' ? blendRating(p[5], p[4], imp.wb) : p[1]);
/** a team's values under the setting: #1 / #4 / #8 blended, and #4's top-3 part */
export function teamUnder(t: TeamSnap, imp: Imp): TeamSnap & { top: number } {
  const nv = t.nv;
  if (!imp || !nv || nv.length < 8) return { ...t, top: 0 };
  const b = (k: number) => blendRating(nv[4 + k], nv[k], imp.wb);
  return { ...t, imp: b(0), miss: b(1), top: b(2), stay: b(3) };
}
/**
 * fix225: a team's players as the key players card / NBA re-pricing read them — rating under the setting, projected
 * minutes, games since he played, one of the team's top 3 (the star factor).
 */
export function teamPlayers(code: string, teamId: number, imp: Imp): { id: number; rating: number; proj: number; since: number; top: boolean }[] | null {
  const t = snaps.get(code)?.teams.get(teamId);
  if (!t?.pl) return null;
  return t.pl.map(p => ({ id: p[0], rating: plRating(p, imp), proj: p[2], since: p[3], top: p[6] === 1 }));
}
onState('bb:grid:s:', (k, v: any) => { snaps.set(k.slice('bb:grid:s:'.length), v as LeagueSnap); snapVer++; });
export const gridSnapVer = () => snapVer;
export const gridSnap = (code: string) => snaps.get(code) || null;
export function publishSnap(s: LeagueSnap) { snaps.set(s.code, s); snapVer++; publishState(`bb:grid:s:${s.code}`, s); }

/** the team's previous two kick-offs before this game (3rd game in 4 days) */
let koStmt: any = null;
export function threeInFour(teamId: number, kickoff: string): boolean {
  koStmt ||= db.prepare(`SELECT kickoff FROM bb_games WHERE (home_id = ? OR away_id = ?) AND kickoff < ? ORDER BY kickoff DESC LIMIT 2`);
  const r = koStmt.all(teamId, teamId, new Date(Date.parse(kickoff) - 3 * 3600 * 1000).toISOString()) as any[];
  return r.length === 2 && Date.parse(kickoff) - Date.parse(r[1].kickoff) <= 3.5 * DAY;
}

/** Row values of an upcoming game (null: a team without values yet). */
/**
 * fix225: `imp` = the impact setting live (rows #1 / #4 / #8 from the blended ratings); `miss` may carry the top-3 part
 * of each side's loss (homeTop / awayTop) for the star factor; t4 = home − away of that part.
 */
export function liveRows(g: { code: string; game_id?: number; home_id: number; away_id: number; kickoff: string; season: string; week?: string | null },
  base: { p: number; sig: number; hca: number; haH: number; haA: number; b2bH: boolean; b2bA: boolean }, miss?: { home: number; away: number; homeTop?: number; awayTop?: number }, imp?: Imp) {
  const s = snaps.get(g.code);
  if (!s) return null;
  const h0 = s.teams.get(g.home_id), a0 = s.teams.get(g.away_id);
  if (!h0 || !a0) return null;
  const h = teamUnder(h0, imp), a = teamUnder(a0, imp);
  const gpOf = (t: TeamSnap) => (t.season === g.season ? t.gp : 0);
  const hh = { ...h, gp: gpOf(h), wins: h.season === g.season ? h.wins : 0 }, aa = { ...a, gp: gpOf(a), wins: a.season === g.season ? a.wins : 0 };
  let tH = h.top, tA = a.top;
  // fix228: the NBA's #4 is only the injury report + confirmed starters (nbaV4.sideOf, passed in): never "missed the last games"
  if (!miss && g.code === 'NBA') miss = { home: 0, away: 0, homeTop: 0, awayTop: 0 };
  if (!miss && keepHook) { // fix224: news / rest statuses outside the NBA (the NBA passes its own, nbaV4.sideOf)
    const mh = missWithHook(s, g, g.home_id, h0, imp), ma = missWithHook(s, g, g.away_id, a0, imp);
    if (mh !== undefined || ma !== undefined) miss = { home: mh?.miss ?? h.miss, away: ma?.miss ?? a.miss, homeTop: mh?.top ?? h.top, awayTop: ma?.top ?? a.top };
  }
  if (miss) { tH = miss.homeTop ?? 0; tA = miss.awayTop ?? 0; }
  const r = rowsOf(s, hh, aa, {
    base, home: g.home_id, away: g.away_id, ms: Date.parse(g.kickoff), rs: isRegular(g.week || null) && !isPre(g.code, g.kickoff), neutral: isNeutral(g.code, g.week || null),
    three: [threeInFour(g.home_id, g.kickoff), threeInFour(g.away_id, g.kickoff)], gpH: hh.gp, gpA: aa.gp, missH: miss?.home, missA: miss?.away
  });
  return { ...r, t4: r3(tH - tA) };
}

export const GRID_ROW_NAMES = GRID_ROWS.map(r => r.name);
void logger;

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
 *     (live NBA: the injury report + confirmed starters, services/nbaV4.ts) · #5 four factors for / against (eFG%, TOV%,
 *     OREB%, FT rate; Dean Oliver weights), shrunk to the league mean · #6 rest: −1 back-to-back, −0.5 third game in 4
 *     days · #7 home court: league edge + the team's own (neutral final fours 0) · #8 carry-over: strength of the players
 *     who stayed from last season, fading to 0 by game 25 · #9 matchups: style against style (shooting, rebounds,
 *     turnovers) · #10 form: last 10 games against bb-v1's expectation · #11 motivation: −1 late in the regular season
 *     for a team under 30% wins · #12 3-point volatility: share of 3-point attempts (widens sigma) · #13 head-to-head:
 *     last 3 meetings (2 years) against expectation.
 * Not built (no data): travel km / time zones (needs an arena table), playoff-race motivation (needs standings history).
 * The impact parts (#1 #4 #8 and the "who actually played" check) are kept per game (bb_grid_imp): a later build refits
 * only the windows with games not stored yet and the current one.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { yieldLoop } from './perf';
import { onState, publishState } from './shared';
import { ridgeFit, rotation, strength, projMinutes, choleskySolve, probit, type FitGame, type ImpactFit, type RotPlayer } from '../utils/nbaImpact';
import { GRID_ROWS, N_ROWS, VOL, startYear, type GridBase, type GridItem } from '../utils/bbGridMath';

const IMP_VER = 'imp1|l30|d0.5|r-1';
const DAY = 86400000;
db.exec(`
  CREATE TABLE IF NOT EXISTS bb_grid_imp (game_id INTEGER PRIMARY KEY, code TEXT NOT NULL, ver TEXT NOT NULL, v TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_bb_grid_imp_code ON bb_grid_imp(code);
  CREATE TABLE IF NOT EXISTS bb_grid_rows (
    game_id INTEGER PRIMARY KEY, code TEXT NOT NULL, season TEXT NOT NULL, ms INTEGER NOT NULL, gp INTEGER NOT NULL,
    y INTEGER NOT NULL, v3 REAL NOT NULL, sig REAL NOT NULL, hv TEXT NOT NULL, av TEXT NOT NULL, oracle REAL
  );
  CREATE INDEX IF NOT EXISTS idx_bb_grid_rows_code ON bb_grid_rows(code);
`);

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
  /** fix224 (live snapshot only): players of the team's last 10 games — [id, rating, projected minutes, team games since he last played] */
  pl?: [number, number, number, number][];
};
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
 * `base` = gridBaseOf(code) from the build that just ran.
 */
export async function replayLeague(code: string, base: Map<number, GridBase>): Promise<{ items: GridItem[]; snap: LeagueSnap }> {
  const L = gameMinOf(code);
  const games: G[] = (db.prepare(`SELECT game_id, season, kickoff, status, home_id, away_id, hs, as_, stage FROM bb_games WHERE code = ? ORDER BY kickoff, game_id`).all(code) as any[]).map(g => {
    const pre = isPre(code, g.kickoff);
    return { id: g.game_id, season: g.season, ms: Date.parse(g.kickoff), iso: g.kickoff, home: g.home_id, away: g.away_id, hs: g.hs, as_: g.as_, finished: ['FT', 'AOT'].includes(g.status) && g.hs !== null && g.as_ !== null, pre, rs: !pre && isRegular(g.stage), neutral: isNeutral(code, g.stage) };
  });
  const lines = new Map<number, [number, number, number][]>();
  for (const r of db.prepare(`SELECT ps.game_id, ps.team_id, ps.player_id, ps.minutes FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = ? AND ps.minutes > 0`).all(code) as any[]) {
    let l = lines.get(r.game_id); if (!l) lines.set(r.game_id, (l = [])); l.push([r.team_id, r.player_id, r.minutes]);
  }
  const box = new Map<number, Map<number, any>>();
  for (const r of db.prepare(`SELECT t.* FROM bb_team_stats t JOIN bb_games g ON g.game_id = t.game_id WHERE g.code = ? AND t.fga > 0`).all(code) as any[]) {
    let m = box.get(r.game_id); if (!m) box.set(r.game_id, (m = new Map())); m.set(r.team_id, r);
  }
  const cache = new Map<number, number[]>();
  for (const r of db.prepare(`SELECT game_id, v FROM bb_grid_imp WHERE code = ? AND ver = ?`).all(code, IMP_VER) as any[]) { try { cache.set(r.game_id, (JSON.parse(r.v) as (number | null)[]).map(x => (x === null ? NaN : x))); } catch { /* recompute */ } }
  await yieldLoop();

  // ---- state ----
  const fitRows: (FitGame & { s: number })[] = [], netRows: { h: number; a: number; y: number; s: number }[] = [];
  let fit: ImpactFit | null = null, net = new Map<number, number>(), nextFit = Infinity, fitSeason = '';
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
  const items: GridItem[] = [];
  const newImp: [number, number[]][] = [];
  const finished = games.filter(g => g.finished);
  const lastFinishedMs = finished.length ? finished[finished.length - 1].ms : 0;

  const side = (team: number, only?: Set<number>) => {
    const ids = only || new Set<number>();
    if (!only) for (const r of rosters.get(team) || []) for (const id of r) ids.add(id);
    const out: RotPlayer[] = [];
    for (const id of ids) { const m = projMinutes(rs.get(id), preSeason ? pre.get(id) : undefined); if (m !== null) out.push({ id, min: m, rating: fit ? (fit.ratings.get(id) ?? -1) : 0 }); }
    return out;
  };
  const S = (pl: RotPlayer[], keep?: Map<number, number>) => strength(rotation(pl, keep, L), L);
  const impParts = (team: number, season: string) => {
    const pl = side(team), full = S(pl);
    const last2 = new Set((rosters.get(team) || []).slice(-2).flat());
    const keep = new Map<number, number>();
    if ((rosters.get(team) || []).length >= 3) for (const p of pl) if (!last2.has(p.id)) keep.set(p.id, 0);
    const miss = keep.size ? S(pl, keep) - full : 0;
    const prevSet = seasonPlayers.get(`${team}|${prevSeasonOf(season)}`);
    const stay = prevSet ? S(pl.filter(p => prevSet.has(p.id))) : 0;
    return { full, miss, stay };
  };
  const seasonsSeen: string[] = [];
  const prevSeasonOf = (s: string) => { const i = seasonsSeen.indexOf(s); return i > 0 ? seasonsSeen[i - 1] : seasonsSeen.length && seasonsSeen[seasonsSeen.length - 1] !== s ? seasonsSeen[seasonsSeen.length - 1] : ''; };
  const snapOf = (team: number, season: string): TeamSnap => {
    const p = impParts(team, season);
    const f = ewF.get(team)?.mean(lg) || lg, ag = ewA.get(team)?.mean(lg) || lg;
    const fl = form.get(team) || [];
    return { imp: p.full, miss: p.miss, stay: p.stay, net: ((net.get(team) || 0) * pace) / 100, ff: f, ffAg: ag, form: fl.length ? fl.reduce((x, y) => x + y, 0) / fl.length : 0, wins: wins.get(`${team}|${season}`) || 0, gp: gp.get(`${team}|${season}`) || 0, season };
  };

  let i = 0;
  for (const g of games) {
    if (++i % 300 === 0) await yieldLoop();
    if (!seasonsSeen.includes(g.season)) seasonsSeen.push(g.season);
    if (!g.pre && g.finished && (fitSeason !== g.season || g.ms >= nextFit)) {
      const end = Math.floor(g.ms / DAY) * DAY + 14 * DAY;
      // refit the impact only when a game of this window has no stored value (the live state gets its own fit at the end)
      const need = finished.some(x => x.ms >= g.ms && x.ms < end && !x.pre && !cache.has(x.id));
      const cur = startYear(g.season);
      if (need) {
        const use = fitRows.filter(r => r.s >= cur - 2 && r.s <= cur).map(r => ({ ...r, w: Math.pow(0.5, cur - r.s) }));
        if (use.length >= 50) fit = ridgeFit(use, 30, L);
      }
      const nu = netRows.filter(r => r.s >= cur - 2 && r.s <= cur).map(r => ({ ...r, w: Math.pow(0.5, cur - r.s) }));
      if (nu.length >= 30) net = netFit(nu);
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
      if (!v) {
        const ph = impParts(g.home, g.season), pa = impParts(g.away, g.season);
        const played = (t: number) => new Set(ls.filter(l => l[0] === t).map(l => l[1]));
        const oh = played(g.home), oa = played(g.away);
        const oracle = oh.size >= 5 && oa.size >= 5 ? (S(side(g.home, oh)) - ph.full) - (S(side(g.away, oa)) - pa.full) : null;
        v = [r3(ph.full), r3(pa.full), r3(ph.miss), r3(pa.miss), r3(ph.stay), r3(pa.stay), oracle === null ? NaN : r3(oracle)];
        newImp.push([g.id, v]);
      }
      const sh = snapOf(g.home, g.season), sa = snapOf(g.away, g.season);
      sh.imp = v[0]; sa.imp = v[1]; sh.miss = v[2]; sa.miss = v[3]; sh.stay = v[4]; sa.stay = v[5];
      const three = (t: number) => { const k = lastKo.get(t) || []; return k.length >= 2 && g.ms - k[k.length - 2] <= 3.5 * DAY; };
      const prevLen = seasonGames.get(prevSeasonOf(g.season)) || 0;
      const r = rowsOf({ lg, seasonLen: prevLen, h2h }, sh, sa, { base: b, home: g.home, away: g.away, ms: g.ms, rs: g.rs, neutral: g.neutral, three: [three(g.home), three(g.away)], gpH: sh.gp, gpA: sa.gp });
      items.push({ id: g.id, code, season: g.season, year: startYear(g.season), gp: Math.min(sh.gp, sa.gp), y: g.hs! > g.as_! ? 1 : 0, v3: b.p, sig: b.sig, hv: r.hv, av: r.av, oracle: Number.isFinite(v[6]) ? v[6] : null });
    }
    // ---- after the game: the history grows ----
    const per = new Map<number, number[]>(), h: [number, number][] = [], a: [number, number][] = [];
    for (const [team, pid, min] of ls) {
      if (team === g.home) h.push([pid, min]); else if (team === g.away) a.push([pid, min]); else continue;
      let x = per.get(team); if (!x) per.set(team, (x = [])); x.push(pid);
      if (!g.pre && (code !== 'NBA' || g.rs)) { let r = rs.get(pid); if (!r) rs.set(pid, (r = [])); r.push(min); if (r.length > 15) r.shift(); }
      else if (g.pre) { let r = pre.get(pid); if (!r) pre.set(pid, (r = [])); r.push(min); }
      if (!g.pre) { const k = `${team}|${g.season}`; let s = seasonPlayers.get(k); if (!s) seasonPlayers.set(k, (s = new Set())); s.add(pid); }
    }
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
    if (use.length >= 50) fit = ridgeFit(use, 30, L);
  }
  // the latest values of every team that played in the last 400 days (the live predictions)
  const teams = new Map<number, TeamSnap>();
  const recent = games.filter(g => g.finished && lastFinishedMs - g.ms < 400 * DAY);
  const cur = recent.length ? recent[recent.length - 1].season : '';
  // fix224: each team's players of its last 10 games (key players card, row #4 with news / rest statuses)
  const plOf = (team: number): [number, number, number, number][] => {
    const r10 = rosters10.get(team) || [], seen = new Map<number, number>();
    r10.forEach((ids, k) => { for (const id of ids) seen.set(id, r10.length - 1 - k); });
    const out: [number, number, number, number][] = [];
    for (const [id, since] of seen) { const m = projMinutes(rs.get(id), preSeason ? pre.get(id) : undefined); if (m !== null) out.push([id, r3(fit ? (fit.ratings.get(id) ?? -1) : 0), r3(m), since]); }
    return out;
  };
  for (const g of recent) for (const t of [g.home, g.away]) if (!teams.has(t)) teams.set(t, { ...snapOf(t, cur), pl: plOf(t) });
  // seasonLen for the live tank rule: the last finished season
  const seasonLen = seasonGames.get(prevSeasonOf(cur)) || seasonGames.get(cur) || 0;
  return { items, snap: { code, gameMin: L, teams, lg, pace, seasonLen, h2h, builtAt: new Date().toISOString() } };
}

/** Write a league's rows for the tuner / gate (replaces the league's old rows). */
export function storeRows(code: string, items: GridItem[]) {
  const up = db.prepare(`INSERT OR REPLACE INTO bb_grid_rows (game_id, code, season, ms, gp, y, v3, sig, hv, av, oracle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM bb_grid_rows WHERE code = ?`).run(code);
    for (const it of items) up.run(it.id, code, it.season, 0, it.gp, it.y, it.v3, it.sig, JSON.stringify(it.hv), JSON.stringify(it.av), it.oracle);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/** Every league's stored rows (the tuner and the gate) */
export function loadRows(codes?: string[]): GridItem[] {
  const q = codes && codes.length ? ` WHERE r.code IN (${codes.map(() => '?').join(',')})` : '';
  // fix223: + the final margin (mg: the league settings' spread of results)
  return (db.prepare(`SELECT r.*, g.hs - g.as_ AS mg FROM bb_grid_rows r LEFT JOIN bb_games g ON g.game_id = r.game_id${q}`).all(...(codes || [])) as any[]).map(r => ({
    id: r.game_id, code: r.code, season: r.season, year: startYear(r.season), gp: r.gp, y: r.y, v3: r.v3, sig: r.sig, hv: JSON.parse(r.hv), av: JSON.parse(r.av), oracle: r.oracle,
    mg: typeof r.mg === 'number' ? r.mg : null
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
function missWithHook(s: LeagueSnap, g: { code: string; game_id?: number; kickoff: string }, teamId: number, t: TeamSnap): number | undefined {
  const extra = keepHook && t.pl ? keepHook(g, teamId) : null;
  if (!extra || !extra.size || !t.pl) return undefined;
  const pl = t.pl.filter(p => p[3] <= 2).map(p => ({ id: p[0], min: p[2], rating: p[1] }));
  const keep = new Map<number, number>();
  if (t.pl.some(p => p[3] >= 2)) for (const p of t.pl) if (p[3] === 2) keep.set(p[0], 0); // missed the last 2 (in the last 3)
  for (const [id, k] of extra) keep.set(id, Math.min(k, keep.get(id) ?? 1));
  return strength(rotation(pl, keep, s.gameMin), s.gameMin) - strength(rotation(pl, undefined, s.gameMin), s.gameMin);
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
export function liveRows(g: { code: string; game_id?: number; home_id: number; away_id: number; kickoff: string; season: string; week?: string | null },
  base: { p: number; sig: number; hca: number; haH: number; haA: number; b2bH: boolean; b2bA: boolean }, miss?: { home: number; away: number }) {
  const s = snaps.get(g.code);
  if (!s) return null;
  const h = s.teams.get(g.home_id), a = s.teams.get(g.away_id);
  if (!h || !a) return null;
  const gpOf = (t: TeamSnap) => (t.season === g.season ? t.gp : 0);
  const hh = { ...h, gp: gpOf(h), wins: h.season === g.season ? h.wins : 0 }, aa = { ...a, gp: gpOf(a), wins: a.season === g.season ? a.wins : 0 };
  if (!miss && keepHook) { // fix224: news / rest statuses outside the NBA (the NBA passes its own, nbaV4.sideOf)
    const mh = missWithHook(s, g, g.home_id, h), ma = missWithHook(s, g, g.away_id, a);
    if (mh !== undefined || ma !== undefined) miss = { home: mh ?? h.miss, away: ma ?? a.miss };
  }
  return rowsOf(s, hh, aa, {
    base, home: g.home_id, away: g.away_id, ms: Date.parse(g.kickoff), rs: isRegular(g.week || null) && !isPre(g.code, g.kickoff), neutral: isNeutral(g.code, g.week || null),
    three: [threeInFour(g.home_id, g.kickoff), threeInFour(g.away_id, g.kickoff)], gpH: hh.gp, gpA: aa.gp, missH: miss?.home, missA: miss?.away
  });
}

export const GRID_ROW_NAMES = GRID_ROWS.map(r => r.name);
void logger;

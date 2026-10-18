/**
 * nfl-v2 experiments (fix146, NFL only = league 1). Walk-forward: every test season (2021 on, the current one so far) is
 * predicted with settings and weights fitted only on the seasons before it. Every feature below is built "online": a
 * game's numbers use only games that finished before its week, so one pass serves every test season.
 *
 *  E1 nfl-v1 as it is (baseline).
 *  E2 margin ratings: exponentially decayed ridge least squares on the point margin (capped at 28) + home field;
 *     last season's games count `carry` as much (tuned with the half-life); win chance = logistic fitted on train.
 *  E3 opponent-adjusted efficiency (ridge, game level, offence + defence per team): yards / play, first downs / play,
 *     turnovers (heavily shrunk), sacks taken / play, third-down %, red-zone %.
 *  E4 QB v2: ANY/A adjusted for the opponent's pass defence, a replacement-level prior for rookies / backups, a new
 *     starter at the start of a season = the team's last rating shrunk halfway; with the Elo gap.
 *  E5 context: west-coast team at 1 pm ET, short week, bye, division game, week 18, travel distance; with the Elo gap.
 *  E6 early season: last season's rating vs this season's, weight k / (k + games played) (k tuned).
 *  E7 stacked logistic on all of the above (ridge); E7b small gradient-boosted trees + Platt scaling (train only).
 *
 * The best total log loss becomes nfl-v2 only if it beats nfl-v1 on log loss and its hit % is not lower. Runs after a
 * deploy (new version) and with the weekly re-tune. Report in /api/admin/nfl-model (experiments). No odds anywhere.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { yieldLoop, timed, slicer } from './perf';
import { teamBox } from './nflSite';
import { modelInternals as M, type NflG as G, type NflPre as Pre, type NflCtx as Ctx, type NflRow as Row, type Params } from './nflModel';

export const EXP_VERSION = 'fix149-1'; // a new version runs the experiments again on the next tick after deploy
export const NFL_V2 = 'nfl-v2';
const DAY = 86400000, WEEK = 7 * DAY;
const bucketOf = (t: number) => Math.floor((t - 5 * DAY) / WEEK); // Tuesday to Monday
const weekNo = (g: G) => { if (!/reg/i.test(g.stage || '')) return null; const m = String(g.week || '').match(/(\d+)/); return m ? Number(m[1]) : null; };
const yOf = (g: G) => (g.hs! > g.as! ? 1 : g.hs! < g.as! ? 0 : 0.5);
const sig = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(M.clip(p) / (1 - M.clip(p)));
/** fix149: every feature finite (else 0 = the average / no information). */
const fin = (v: number) => (Number.isFinite(v) ? v : 0);
const VALID_HIT = 55;

/* ---------- small linear algebra ---------- */

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, a = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
    [a[c], a[piv]] = [a[piv], a[c]];
    const d = a[c][c] || 1e-9;
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = a[r][n]; for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k]; x[r] = s / (a[r][r] || 1e-9); }
  return x;
}
/** Weighted ridge least squares, rows given as sparse (index, coefficient) lists. */
class LS {
  A: number[][]; b: number[];
  constructor(public n: number) { this.A = Array.from({ length: n }, () => new Array(n).fill(0)); this.b = new Array(n).fill(0); }
  add(idx: number[], c: number[], y: number, w: number) {
    for (let i = 0; i < idx.length; i++) { this.b[idx[i]] += w * c[i] * y; for (let j = 0; j < idx.length; j++) this.A[idx[i]][idx[j]] += w * c[i] * c[j]; }
  }
  solve(pen: number[]) { for (let i = 0; i < this.n; i++) this.A[i][i] += pen[i]; return solve(this.A, this.b); }
}

/* ---------- logistic regression (IRLS, ridge) and small boosted trees ---------- */

interface Logit { w: number[]; b: number; mu: number[]; sd: number[] }
function fitLogit(X0: number[][], y0: number[], l2 = 1): Logit {
  // fix149: only finite rows; non-finite weights fall back to the base rate (logged as a bad fit by the caller's LL)
  const keep = X0.map((x, i) => x.every(Number.isFinite) && Number.isFinite(y0[i]));
  const X = X0.filter((_, i) => keep[i]), y = y0.filter((_, i) => keep[i]);
  const k = X0[0]?.length || 0, n = X.length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[j], 0) / Math.max(1, n));
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / Math.max(1, n)) || 1);
  const Z = X.map(r => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
  let w = new Array(k + 1).fill(0);
  for (let it = 0; it < 12; it++) {
    const H = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0)), g = new Array(k + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const z = Z[i], p = sig(z.reduce((s, v, j) => s + v * w[j], 0)), q = Math.max(1e-6, p * (1 - p));
      for (let a = 0; a <= k; a++) { g[a] += (y[i] - p) * z[a]; for (let c = 0; c <= k; c++) H[a][c] += q * z[a] * z[c]; }
    }
    for (let a = 1; a <= k; a++) { g[a] -= l2 * w[a]; H[a][a] += l2; }
    const step = solve(H, g);
    w = w.map((v, j) => v + step[j]);
    if (step.reduce((s, v) => s + Math.abs(v), 0) < 1e-6) break;
  }
  if (!w.every(Number.isFinite)) { const yb = y.reduce((s, v) => s + v, 0) / Math.max(1, n); return { b: logit(yb || 0.5), w: new Array(k).fill(0), mu, sd }; }
  return { b: w[0], w: w.slice(1), mu, sd };
}
const predLogit = (m: Logit, x: number[]) => sig(m.b + x.reduce((s, v, j) => s + ((v - m.mu[j]) / m.sd[j]) * m.w[j], 0));

interface Tree { f: number; t: number; l: Tree | number; r: Tree | number }
interface Gbdt { trees: Tree[]; lr: number; base: number; platt: Logit }
function fitGbdt(X: number[][], y: number[], rounds = 80, lr = 0.1, minLeaf = 40): Gbdt {
  const n = X.length, k = X[0]?.length || 0;
  const ybar = y.reduce((s, v) => s + v, 0) / Math.max(1, n), base = logit(ybar);
  const F = new Array(n).fill(base), trees: Tree[] = [];
  const cuts = Array.from({ length: k }, (_, j) => { const v = X.map(r => r[j]).sort((a, b) => a - b); return [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(q => v[Math.floor(q * (n - 1))]); });
  const leaf = (ids: number[], g: number[], h: number[]) => { let G = 0, Hs = 0; for (const i of ids) { G += g[i]; Hs += h[i]; } return G / (Hs + 1); };
  const grow = (ids: number[], g: number[], h: number[], depth: number): Tree | number => {
    if (depth === 0 || ids.length < 2 * minLeaf) return leaf(ids, g, h);
    let best: { f: number; t: number; gain: number } | null = null;
    let G0 = 0, H0 = 0; for (const i of ids) { G0 += g[i]; H0 += h[i]; }
    for (let f = 0; f < k; f++) for (const t of cuts[f]) {
      let GL = 0, HL = 0, nL = 0;
      for (const i of ids) if (X[i][f] <= t) { GL += g[i]; HL += h[i]; nL++; }
      if (nL < minLeaf || ids.length - nL < minLeaf) continue;
      const gain = GL * GL / (HL + 1) + (G0 - GL) ** 2 / (H0 - HL + 1) - G0 * G0 / (H0 + 1);
      if (!best || gain > best.gain) best = { f, t, gain };
    }
    if (!best) return leaf(ids, g, h);
    return { f: best.f, t: best.t, l: grow(ids.filter(i => X[i][best!.f] <= best!.t), g, h, depth - 1), r: grow(ids.filter(i => X[i][best!.f] > best!.t), g, h, depth - 1) };
  };
  const all = Array.from({ length: n }, (_, i) => i);
  for (let r = 0; r < rounds; r++) {
    const p = F.map(sig), g = p.map((v, i) => y[i] - v), h = p.map(v => v * (1 - v));
    const tree = grow(all, g, h, 2);
    trees.push(tree as Tree);
    for (let i = 0; i < n; i++) F[i] += lr * evalTree(tree, X[i]);
  }
  const platt = fitLogit(F.map(v => [v]), y, 0.01); // Platt scaling on the training rows only
  return { trees, lr, base, platt };
}
function evalTree(t: Tree | number, x: number[]): number { while (typeof t !== 'number') t = x[t.f] <= t.t ? t.l : t.r; return t; }
const predGbdt = (m: Gbdt, x: number[]) => predLogit(m.platt, [m.trees.reduce((s, t) => s + m.lr * evalTree(t, x), m.base)]);

/* ---------- E2 / E6: margin ratings ---------- */

const teamIndex = (games: G[]) => { const ix = new Map<number, number>(); for (const g of games) for (const id of [g.h, g.a]) if (!ix.has(id)) ix.set(id, ix.size); return ix; };
const capM = (g: G) => Math.max(-28, Math.min(28, g.hs! - g.as!));
const buckets = (games: G[], from: number) => {
  const out = new Map<number, G[]>();
  for (const g of games) if (g.t >= from) { const b = bucketOf(g.t); (out.get(b) || out.set(b, []).get(b)!).push(g); }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
};

/** E2: predicted margin (home minus away) of every game from `from` on. hl = half-life in weeks. */
async function marginRatings(games: G[], hl: number, carry: number, from = 0): Promise<Map<number, number>> {
  const ix = teamIndex(games), T = ix.size, out = new Map<number, number>();
  const done = games.filter(g => g.done);
  for (const [b, list] of buckets(games, from)) {
    const start = (b * WEEK) + 5 * DAY, S = list[0].season;
    const ls = new LS(T + 1);
    for (const g of done) {
      if (g.t >= start || g.t < start - 900 * DAY) continue;
      const w = Math.pow(0.5, (start - g.t) / WEEK / hl) * (g.season < S ? Math.pow(carry, S - g.season) : 1);
      ls.add([ix.get(g.h)!, ix.get(g.a)!, T], [1, -1, g.neutral ? 0 : 1], capM(g), w);
    }
    const x = ls.solve([...new Array(T).fill(4), 0.01]);
    for (const g of list) out.set(g.id, x[ix.get(g.h)!] - x[ix.get(g.a)!] + (g.neutral ? 0 : x[T]));
    await yieldLoop();
  }
  return out;
}

/** E6: last season's rating (shrunk) against this season's so far, weight k / (k + games played). */
async function earlyRatings(games: G[], k: number, from = 0): Promise<Map<number, number>> {
  const ix = teamIndex(games), T = ix.size, out = new Map<number, number>();
  const done = games.filter(g => g.done);
  const fit = (list: G[]) => { const ls = new LS(T + 1); for (const g of list) ls.add([ix.get(g.h)!, ix.get(g.a)!, T], [1, -1, g.neutral ? 0 : 1], capM(g), 1); return ls.solve([...new Array(T).fill(4), 0.01]); };
  const prevFit = new Map<number, number[]>();
  for (const [b, list] of buckets(games, from)) {
    const start = (b * WEEK) + 5 * DAY, S = list[0].season;
    if (!prevFit.has(S)) prevFit.set(S, fit(done.filter(g => g.season === S - 1)));
    const prev = prevFit.get(S)!;
    const curGames = done.filter(g => g.season === S && g.t < start);
    const cur = curGames.length ? fit(curGames) : new Array(T + 1).fill(0);
    const played = new Map<number, number>(); for (const g of curGames) for (const id of [g.h, g.a]) played.set(id, (played.get(id) || 0) + 1);
    const R = (id: number) => { const w = k / (k + (played.get(id) || 0)); return w * 0.8 * prev[ix.get(id)!] + (1 - w) * cur[ix.get(id)!]; };
    const H = curGames.length >= 40 ? cur[T] : prev[T];
    for (const g of list) out.set(g.id, R(g.h) - R(g.a) + (g.neutral ? 0 : H));
    await yieldLoop();
  }
  return out;
}

/* ---------- E3: opponent-adjusted efficiency ---------- */

const STATS = ['ypp', 'fdpp', 'to', 'sackRate', 'third', 'rz'] as const;
const STAT_PEN = [6, 6, 30, 10, 8, 10]; // turnovers heavily shrunk
/** fix155: parsed once, then only the rows added since (">=": a replaced last row can keep its rowid). */
const effCache = { row: 0, map: new Map<string, (number | null)[]>() };
async function loadEffBox(): Promise<Map<string, (number | null)[]>> {
  const out = effCache.map;
  const slice = slicer(); // fix169: the first parse of every NFL team box score gives way every ~30 ms
  for (const r of db.prepare(`SELECT s.rowid AS rid, s.game_id, s.team_id, s.json FROM nfl_team_stats s JOIN nfl_games g ON g.game_id = s.game_id WHERE g.league = 1 AND s.rowid >= ? ORDER BY s.rowid`).all(effCache.row) as any[]) {
    effCache.row = Math.max(effCache.row, r.rid);
    await slice();
    let j: any = null; try { j = JSON.parse(r.json); } catch { j = null; }
    const b = teamBox(j);
    if (!b) continue;
    const plays = b.plays || null;
    out.set(`${r.game_id}|${r.team_id}`, [
      b.yardsPerPlay ?? (b.yards != null && plays ? b.yards / plays : null),
      b.firstDowns != null && plays ? b.firstDowns / plays : null,
      b.turnovers ?? null,
      b.sacked != null && plays ? b.sacked / plays : null,
      b.third && b.third[1] ? b.third[0] / b.third[1] : null,
      b.redZone && b.redZone[1] ? b.redZone[0] / b.redZone[1] : null
    ]);
  }
  return out;
}
/** E3: per game, the expected home-minus-away difference of each stat + a "no data" flag (7 numbers). */
async function efficiency(games: G[], box: Map<string, (number | null)[]>, from = 0): Promise<Map<number, number[]>> {
  const ix = teamIndex(games), T = ix.size, out = new Map<number, number[]>();
  const done = games.filter(g => g.done && box.has(`${g.id}|${g.h}`) && box.has(`${g.id}|${g.a}`));
  for (const [b, list] of buckets(games, from)) {
    const start = (b * WEEK) + 5 * DAY;
    const win = done.filter(g => g.t < start && g.t >= start - 600 * DAY);
    const n = new Map<number, number>(); for (const g of win) for (const id of [g.h, g.a]) n.set(id, (n.get(id) || 0) + 1);
    const fits = STATS.map((_, s) => {
      const ls = new LS(2 * T + 2);
      for (const g of win) {
        const w = Math.pow(0.5, (start - g.t) / WEEK / 20);
        for (const [me, op, home] of [[g.h, g.a, g.neutral ? 0 : 1], [g.a, g.h, 0]] as [number, number, number][]) {
          const v = box.get(`${g.id}|${me}`)![s];
          if (v === null || !Number.isFinite(v)) continue;
          ls.add([0, 1, 2 + ix.get(me)!, 2 + T + ix.get(op)!], [1, home, 1, 1], v, w);
        }
      }
      return ls.solve([0.01, 0.01, ...new Array(2 * T).fill(STAT_PEN[s])]);
    });
    for (const g of list) {
      const ok = (n.get(g.h) || 0) >= 3 && (n.get(g.a) || 0) >= 3;
      const h = ix.get(g.h)!, a = ix.get(g.a)!;
      out.set(g.id, ok ? [...fits.map(x => (x[2 + h] + x[2 + T + a]) - (x[2 + a] + x[2 + T + h])), 0] : [0, 0, 0, 0, 0, 0, 1]);
    }
    await yieldLoop();
  }
  return out;
}

/* ---------- E4: QB v2 ---------- */

/** E4: home QB value minus away QB value (ANY/A, opponent-adjusted, shrunk) for every game. */
function qbV2(games: G[], ctx: Ctx): Map<number, number> {
  const PRIOR = 200, REPL = 0.7, DEC = 0.985, DDEC = 0.97, DPRIOR = 8;
  let mean = 6.0;
  const qb = new Map<number, { s: number; w: number }>(), def = new Map<number, { s: number; w: number }>();
  const team = new Map<number, { season: number; starter: number | null; prevValue: number | null; first: boolean }>();
  const val = (id: number | null) => { if (!id) return null; const r = qb.get(id); return r ? (r.s + (mean - REPL) * PRIOR) / (r.w + PRIOR) : null; };
  const defAllowed = (id: number) => { const d = def.get(id); return d ? (d.s + mean * DPRIOR) / (d.w + DPRIOR) : mean; };
  const out = new Map<number, number>();
  for (const g of games) {
    const sides = [g.h, g.a].map(id => {
      let t = team.get(id);
      if (!t) { t = { season: g.season, starter: null, prevValue: null, first: true }; team.set(id, t); }
      if (t.season !== g.season) { t.prevValue = val(t.starter); t.season = g.season; t.first = true; }
      const list = ctx.qb.get(`${g.id}|${id}`);
      const starter = list && list.length ? list[0].id : t.starter;
      let v = val(starter);
      if (v === null) v = t.first && t.prevValue !== null ? (mean - REPL) + 0.5 * (t.prevValue - (mean - REPL)) : mean - REPL; // rookie / new starter
      return { id, t, v };
    });
    out.set(g.id, sides[0].v - sides[1].v);
    if (!g.done) continue;
    for (const [me, op] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
      const list = ctx.qb.get(`${g.id}|${me.id}`);
      if (!list || !list.length) continue;
      const adj = defAllowed(op.id) - mean;
      for (const p of list) {
        const r = qb.get(p.id) || { s: 0, w: 0 };
        r.s = r.s * DEC + (p.anya - adj) * p.att; r.w = r.w * DEC + p.att; qb.set(p.id, r);
        const d = def.get(op.id) || { s: 0, w: 0 };
        d.s = d.s * DDEC + p.anya * (p.att / 30); d.w = d.w * DDEC + p.att / 30; def.set(op.id, d);
        mean += 0.0005 * p.att * (p.anya - mean) / 30;
      }
      me.t.starter = list[0].id; me.t.first = false;
    }
  }
  return out;
}

/* ---------- E5: context ---------- */

/** Home cities by nickname (the last word of the name): latitude, longitude, time zone (ET 0 … PT 3). */
const CITY: Record<string, [number, number, number]> = {
  bills: [42.77, -78.79, 0], dolphins: [25.96, -80.24, 0], patriots: [42.09, -71.26, 0], jets: [40.81, -74.07, 0], ravens: [39.28, -76.62, 0], bengals: [39.1, -84.52, 0],
  browns: [41.51, -81.7, 0], steelers: [40.45, -80.02, 0], texans: [29.68, -95.41, 1], colts: [39.76, -86.16, 0], jaguars: [30.32, -81.64, 0], titans: [36.17, -86.77, 1],
  broncos: [39.74, -105.02, 2], chiefs: [39.05, -94.48, 1], raiders: [36.09, -115.18, 3], chargers: [33.95, -118.34, 3], cowboys: [32.75, -97.09, 1], giants: [40.81, -74.07, 0],
  eagles: [39.9, -75.17, 0], commanders: [38.91, -76.86, 0], redskins: [38.91, -76.86, 0], team: [38.91, -76.86, 0], bears: [41.86, -87.62, 1], lions: [42.34, -83.05, 0],
  packers: [44.5, -88.06, 1], vikings: [44.97, -93.26, 1], falcons: [33.76, -84.4, 0], panthers: [35.23, -80.85, 0], saints: [29.95, -90.08, 1], buccaneers: [27.98, -82.5, 0],
  cardinals: [33.53, -112.26, 2], rams: [33.95, -118.34, 3], '49ers': [37.4, -121.97, 3], seahawks: [47.6, -122.33, 3]
};
// fix148: a game may come without a team name (null): no city then, never a crash
const cityOf = (name: string | null | undefined) => (name ? CITY[String(name).trim().split(/\s+/).pop()!.toLowerCase()] || null : null);
const km = (a: [number, number, number], b: [number, number, number]) => {
  const R = 6371, rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
/** E5 numbers per game: [west team at 1 pm ET, short-week diff, bye diff, division game, travel (1,000 km), week 18]. */
function context(games: G[]): Map<number, number[]> {
  const div = new Map((db.prepare(`SELECT team_id, division FROM nfl_teams WHERE league = 1`).all() as any[]).map(r => [r.team_id, r.division as string | null]));
  const last = new Map<number, { t: number; season: number }>(), out = new Map<number, number[]>();
  for (const g of games) {
    const rest = (id: number) => { const l = last.get(id); return l && l.season === g.season ? (g.t - l.t) / DAY : null; };
    const rH = rest(g.h), rA = rest(g.a);
    const short = (r: number | null) => (r !== null && r <= 5.5 ? 1 : 0), bye = (r: number | null) => (r !== null && r >= 12.5 ? 1 : 0);
    const cH = cityOf(g.hn), cA = cityOf(g.an);
    const utc = new Date(g.t).getUTCHours() + new Date(g.t).getUTCMinutes() / 60;
    const early = utc >= 16.5 && utc < 19; // the 1 pm ET window
    const westEarly = !g.neutral && early && cA && cH && cA[2] >= 3 && cH[2] <= 1 ? 1 : 0;
    const dH = div.get(g.h), dA = div.get(g.a);
    out.set(g.id, [westEarly, short(rH) - short(rA), bye(rH) - bye(rA), dH && dH === dA ? 1 : 0, !g.neutral && cH && cA ? km(cH, cA) / 1000 : 0, weekNo(g) === 18 ? 1 : 0]);
    if (g.done) { last.set(g.h, { t: g.t, season: g.season }); last.set(g.a, { t: g.t, season: g.season }); }
  }
  return out;
}

/* ---------- the experiment ---------- */

const E2_GRID: [number, number][] = [[8, 0.4], [8, 0.7], [8, 1], [16, 0.4], [16, 0.7], [16, 1], [32, 0.4], [32, 0.7], [32, 1]];
const E6_GRID = [1, 2, 4, 8];
const NAMES: Record<string, string> = {
  E1: 'nfl-v1 (baseline)', E2: 'margin ratings', E3: 'opponent-adjusted efficiency', E4: 'QB v2 + Elo', E5: 'context + Elo', E6: 'early-season weighting',
  E7: 'stacked logistic (E1–E6)', E7b: 'boosted trees (E1–E6) + Platt'
};

interface E1Row { p: number; gap: number; home: number; total: number }
interface Feats { m2: Map<number, number>[]; m6: Map<number, number>[]; eff: Map<number, number[]>; qb: Map<number, number>; ctx: Map<number, number[]> }

/** The design rows of each variant for one game (E1 numbers from the season's nfl-v1 settings). */
function xOf(v: string, g: G, e1: E1Row, F: Feats, c2: number, c6: number): number[] {
  return xRaw(v, g, e1, F, c2, c6).map(fin);
}
function xRaw(v: string, g: G, e1: E1Row, F: Feats, c2: number, c6: number): number[] {
  const eff = F.eff.get(g.id) || [0, 0, 0, 0, 0, 0, 1], q = F.qb.get(g.id) || 0, c = F.ctx.get(g.id) || [0, 0, 0, 0, 0, 0];
  const gap = e1.gap / 100;
  const ctxRow = [gap, e1.home, c[0], c[1], c[2], c[3], c[3] * gap, c[4], c[5] * gap];
  switch (v) {
    case 'E2': return [F.m2[c2].get(g.id) || 0];
    case 'E3': return [e1.home, ...eff];
    case 'E4': return [gap, e1.home, q];
    case 'E5': return ctxRow;
    case 'E6': return [F.m6[c6].get(g.id) || 0];
    default: return [logit(e1.p), F.m2[c2].get(g.id) || 0, ...eff, q, ...ctxRow.slice(2), F.m6[c6].get(g.id) || 0]; // E7 / E7b
  }
}
type Model = { kind: 'logit'; m: Logit } | { kind: 'gbdt'; m: Gbdt };
const fitV = (v: string, X: number[][], y: number[]): Model => (v === 'E7b' ? { kind: 'gbdt', m: fitGbdt(X, y) } : { kind: 'logit', m: fitLogit(X, y, v === 'E7' ? 4 : 1) });
const predV = (m: Model, x: number[]) => (m.kind === 'gbdt' ? predGbdt(m.m, x) : predLogit(m.m, x));
const trainLL = (m: Model, X: number[][], y: number[]) => X.reduce((s, x, i) => { const p = M.clip(predV(m, x)); return s - (y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p)); }, 0) / Math.max(1, X.length);

/** Pick a variant's hyper-setting (E2 combo / E6 k) and weights on the training games. */
function fitVariant(v: string, train: G[], e1: Map<number, E1Row>, F: Feats) {
  const y = train.map(yOf);
  const c2s = v === 'E2' || v === 'E7' || v === 'E7b' ? E2_GRID.map((_, i) => i) : [4];
  const c6s = v === 'E6' || v === 'E7' || v === 'E7b' ? E6_GRID.map((_, i) => i) : [1];
  let best: { ll: number; c2: number; c6: number; m: Model } | null = null;
  // E7 / E7b take E2's and E6's best settings (fitted alone) instead of searching every pair
  const pick = (vv: string, list: number[], mk: (c: number) => [number, number]) => {
    let b: { ll: number; c: number; m: Model } | null = null;
    for (const c of list) { const [c2, c6] = mk(c); const X = train.map(g => xOf(vv, g, e1.get(g.id)!, F, c2, c6)); const m = fitV(vv, X, y); const ll = trainLL(m, X, y); if (!b || ll < b.ll) b = { ll, c, m }; }
    return b!;
  };
  if (v === 'E2') { const b = pick('E2', c2s, c => [c, 1]); best = { ll: b.ll, c2: b.c, c6: 1, m: b.m }; }
  else if (v === 'E6') { const b = pick('E6', c6s, c => [4, c]); best = { ll: b.ll, c2: 4, c6: b.c, m: b.m }; }
  else if (v === 'E7' || v === 'E7b') {
    const c2 = pick('E2', c2s, c => [c, 1]).c, c6 = pick('E6', c6s, c => [4, c]).c;
    const X = train.map(g => xOf(v, g, e1.get(g.id)!, F, c2, c6)); const m = fitV(v, X, y);
    best = { ll: trainLL(m, X, y), c2, c6, m };
  } else {
    const X = train.map(g => xOf(v, g, e1.get(g.id)!, F, 4, 1)); const m = fitV(v, X, y);
    best = { ll: trainLL(m, X, y), c2: 4, c6: 1, m };
  }
  return best!;
}

async function buildFeats(games: G[], ctx: Ctx, from = 0): Promise<Feats> {
  const m2: Map<number, number>[] = [];
  for (const [hl, carry] of E2_GRID) m2.push(await marginRatings(games, hl, carry, from));
  const m6: Map<number, number>[] = [];
  for (const k of E6_GRID) m6.push(await earlyRatings(games, k, from));
  const eff = await efficiency(games, await loadEffBox(), from);
  return { m2, m6, eff, qb: qbV2(games, ctx), ctx: context(games) };
}

/**
 * E1 = nfl-v1 exactly as it runs: the Elo engine with the season's settings and, when nfl-v1 keeps its efficiency blend,
 * the blend refitted on the training games only.
 */
function e1Rows(games: G[], ctx: Ctx, p: Params, blend: boolean, inTrain: (g: G) => boolean): Map<number, E1Row> {
  const out = new Map<number, E1Row>(), feats = new Map<number, number[] | null>(), trainRows: { x: number[]; y: number }[] = [];
  M.run(games, p, ctx, (pr: Pre) => {
    out.set(pr.g.id, { p: pr.p, gap: pr.eloH - pr.eloA, home: pr.g.neutral ? 0 : 1, total: pr.total });
    const x = M.featOf(pr); feats.set(pr.g.id, x);
    if (blend && x && inTrain(pr.g) && yOf(pr.g) !== 0.5) trainRows.push({ x, y: yOf(pr.g) });
  }, undefined, 1);
  const bl = blend ? M.fitBlend(trainRows) : null;
  if (bl) for (const [id, r] of out) { const x = feats.get(id); if (x) r.p = M.blendP(bl, x); }
  return out;
}

/** fix149: the first game (in time order) with a non-finite input, logged once per run. */
let nanLogged = false;
function firstNaN(games: G[], e1: Map<number, E1Row>, F: Feats) {
  if (nanLogged) return;
  for (const g of games) {
    const r = e1.get(g.id);
    const checks: [string, number | undefined][] = [['nfl-v1 p', r?.p], ['Elo gap', r?.gap], ['total', r?.total], ['QB v2', F.qb.get(g.id)]];
    F.m2.forEach((m, i) => checks.push([`margin rating ${i}`, m.get(g.id)]));
    F.m6.forEach((m, i) => checks.push([`early rating ${i}`, m.get(g.id)]));
    (F.eff.get(g.id) || []).forEach((v, i) => checks.push([`efficiency ${i}`, v]));
    (F.ctx.get(g.id) || []).forEach((v, i) => checks.push([`context ${i}`, v]));
    const bad = checks.find(([, v]) => v !== undefined && !Number.isFinite(v));
    if (bad) { nanLogged = true; logger.warn(`nfl-exp: first NaN at game ${g.id} season ${g.season} field ${bad[0]}`); return; }
  }
}

const VARIANTS = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E7b'];
let running = false;

export async function runNflExperiments(): Promise<any> {
  if (running) return null;
  running = true;
  nanLogged = false;
  const t0 = Date.now();
  try {
    const games = await M.loadGamesAsync(1), ctx = await M.loadCtxAsync(1); // fix169 / fix171: paged, with yields
    const done = games.filter(g => g.done);
    const seasons = [...new Set(done.map(g => g.season))].sort((a, b) => a - b);
    let tests = seasons.filter(s => s >= 2021 && s > seasons[0] + 1 && done.filter(g => g.season === s).length >= 30);
    if (!tests.length) tests = seasons.slice(2).slice(-6); // little data (tests): the last seasons with two before them
    if (!tests.length) { logger.info('nfl-exp: not enough seasons'); return null; }
    logger.info(`nfl-exp: ${done.length} finished games, test seasons ${tests.join(', ')}`);
    const F = await buildFeats(games, ctx);
    const v1Report = M.readSync('model|report');
    const rows: Record<string, (Row & { wk: number | null; season: number })[]> = Object.fromEntries(VARIANTS.map(v => [v, []]));
    const per: Record<string, any[]> = Object.fromEntries(VARIANTS.map(v => [v, []]));
    for (const S of tests) {
      const start = Math.min(...done.filter(g => g.season === S).map(g => g.t));
      const stored = v1Report?.seasons?.find((x: any) => x.season === S)?.params as Params | undefined;
      // fix149: settings stored by older versions miss reg / fcs / movCap → completed from the defaults (NaN before)
      const p: Params = M.fullParams(stored || await M.tune(games, ctx, start, false, 1), 1);
      const e1 = e1Rows(games, ctx, p, !!v1Report?.blend?.used, g => g.t < start && g.season > seasons[0]);
      firstNaN(done, e1, F);
      const train = done.filter(g => g.t < start && g.season > seasons[0] && e1.has(g.id));
      const test = done.filter(g => g.season === S && e1.has(g.id));
      for (const v of VARIANTS) {
        let probs: number[];
        if (v === 'E1') probs = test.map(g => e1.get(g.id)!.p);
        else { const fit = fitVariant(v, train, e1, F); probs = test.map(g => predV(fit.m, xOf(v, g, e1.get(g.id)!, F, fit.c2, fit.c6))); }
        const rs = test.map((g, i) => { const m = g.hs! - g.as!; return { p: probs[i], y: yOf(g), m, mHat: M.marginFromP(probs[i]), tot: g.hs! + g.as!, totHat: e1.get(g.id)!.total, wk: weekNo(g), season: S }; });
        rows[v].push(...rs);
        const mt: any = M.metrics(rs);
        per[v].push({ season: S, games: mt.games, hit: mt.hit, logLoss: mt.logLoss, brier: mt.brier });
        logger.info(`nfl-exp ${v} ${S}: hit ${mt.hit}% LL ${mt.logLoss} n=${mt.games}`);
        await yieldLoop();
      }
    }
    const table = VARIANTS.map(v => {
      const tot: any = M.metrics(rows[v]);
      // fix149: NaN / Infinity log loss or under 55% right = invalid, never chosen
      const valid = Number.isFinite(tot.logLoss) && tot.hit !== null && tot.hit >= VALID_HIT;
      logger.info(`nfl-exp ${v} total: hit ${tot.hit}% LL ${tot.logLoss} n=${tot.games}`);
      if (!valid) logger.warn(`nfl-exp ${v} invalid (LL ${tot.logLoss}, hit ${tot.hit}%)`);
      return { id: v, name: NAMES[v], valid, total: tot, perSeason: per[v], weeks1to4: M.metrics(rows[v].filter(r => r.wk !== null && r.wk <= 4)), rest: M.metrics(rows[v].filter(r => r.wk === null || r.wk > 4)) };
    });
    const base = table[0].total as any;
    const validRows = table.filter(x => x.valid);
    const best = [...(validRows.length ? validRows : table)].sort((a, b) => (a.total as any).logLoss - (b.total as any).logLoss)[0];
    const bt = best.total as any;
    // nfl-v1 itself invalid: nothing can be compared with it, so nothing is adopted
    const adopt = table[0].valid && best.valid && best.id !== 'E1' && bt.logLoss < base.logLoss && bt.hit >= base.hit;
    const reason = !table[0].valid ? 'nfl-v1 (E1) invalid in this run: nothing adopted' : !best.valid ? 'no valid variant' : best.id === 'E1' ? 'nfl-v1 has the best log loss' : adopt ? `${best.id} LL ${bt.logLoss} < ${base.logLoss}, hit ${bt.hit}% ≥ ${base.hit}%` : `${best.id} LL ${bt.logLoss} but hit ${bt.hit}% < nfl-v1 ${base.hit}%`;
    logger.info(`nfl-exp: best ${best.id} (${NAMES[best.id]}) → ${adopt ? 'adopted as nfl-v2' : 'nfl-v1 kept'}: ${reason}`);
    // the live nfl-v2: settings and weights fitted on every finished game (the first season = warm-up)
    let live: any = null;
    if (adopt) {
      const stored = M.readSync('model|params');
      const p: Params = { ...M.DEFAULTS[1], ...(stored?.params || {}) };
      const e1 = e1Rows(games, ctx, p, !!stored?.blend, g => g.season > seasons[0]);
      const train = done.filter(g => g.season > seasons[0] && e1.has(g.id));
      const fit = fitVariant(best.id, train, e1, F);
      live = { variant: best.id, c2: fit.c2, c6: fit.c6, model: fit.m, at: new Date().toISOString() };
    }
    const report = {
      version: EXP_VERSION, builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), testSeasons: tests, variants: table,
      best: best.id, adopted: adopt, reason, live: live ? { variant: live.variant, e2: E2_GRID[live.c2], e6: E6_GRID[live.c6] } : null,
      data: { finished: done.length, seasons, withBox: [...F.eff.values()].filter(x => !x[6]).length }
    };
    M.sync('model|exp', report);
    M.sync('model|v2', live);
    v2Cache = null;
    return report;
  } finally { running = false; }
}

export const nflExperimentReport = () => M.readSync('model|exp');
export const nflV2Adopted = (): boolean => !!M.readSync('model|v2');

/* ---------- live nfl-v2 ---------- */

let v2Cache: { key: string; at: number; live: any; F: Feats } | null = null;
/** nfl-v2's win chance for a game that has not started (null = nfl-v2 not adopted / not ready). `pr` = nfl-v1's numbers. */
export function v2Prob(g: G, pr: Pre): number | null {
  const c = v2Cache;
  if (!c || !c.live || !c.F.qb.has(g.id)) { void timed('nfl-v2 features', () => refreshV2()); return null; } // fix169: named (it runs after the caller)
  return predV(c.live.model, xOf(c.live.variant, g, { p: pr.p, gap: pr.eloH - pr.eloA, home: g.neutral ? 0 : 1, total: pr.total }, c.F, c.live.c2, c.live.c6));
}
let refreshing = false;
let checkedAt = 0;
/** Rebuild the live features (games from 10 days ago on) when a game has finished since, at most every 30 min.
 *  fix155: v2Prob asks for every game it has no features for — the check itself runs at most every 5 s. */
export async function refreshV2(): Promise<void> {
  if (refreshing || Date.now() - checkedAt < 5000) return;
  checkedAt = Date.now();
  const live = M.readSync('model|v2');
  if (!live) { v2Cache = null; return; }
  const games = await M.loadGamesAsync(1); // fix171
  const key = `${live.at}|${games.filter(g => g.done).length}|${games.length}`;
  if (v2Cache && v2Cache.key === key && Date.now() - v2Cache.at < 30 * 60 * 1000) return;
  refreshing = true;
  try {
    const F = await buildFeats(games, await M.loadCtxAsync(1), Date.now() - 10 * DAY); // fix169: box scores in steps, not all at once
    v2Cache = { key, at: Date.now(), live, F };
  } catch (e: any) { logger.warn(`nfl-v2 features: ${e.message}`); } finally { refreshing = false; }
}

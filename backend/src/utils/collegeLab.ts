/**
 * fix292 — the college football (FBS) model lab and the 2025 + 2026 refit of the college calibration layer. Pure
 * functions (no database); services/collegeLab.ts feeds them our tables and runs them inside the fix220 build.
 *
 * Lab candidates (walk-forward: test season S = 2023, 2024, 2025 and 2026 so far; every setting / weight fitted on the
 * seasons before S only, never on 2026):
 *  - ncaa-v1 and ncaa-v2 as they ran in their own walk-forward tests (fix142 / fix220);
 *  - "elo": a margin rating (points) with margin of victory (capped), early-season K, home field, and a pre-season
 *    prior = the conference mean + carry × (last season's end − conference mean) + retW × returning production
 *    (the share of last season's box-score value of the team's players who are on this season's roster);
 *  - rows on top of the Elo (ridge logistic, fitted on the training seasons): talent (the roster's last-season value
 *    from any team, transfers included, weighted by the level they played at), home field per team (shrunk), conference
 *    strength (cross-conference results, shrunk, carried half a season) with G5 vs P4 and FBS vs FCS explicit;
 *  - "rows": one logistic on every row + the live model's chance; "trees": small boosted trees (depth 2) + Platt
 *    scaling on the same rows (the shape of nflExperiments E7b);
 *  - market: the closing line alone and an anchor (logistic on the live model + the closing line), walk-forward by week,
 *    only on games with a closing line.
 * Promotion (pickWinner): the best walk-forward log loss of 2023–2025 among the lab candidates, kept only when it
 * beats the live model there by LAB_MARGIN, is not worse on FBS vs FBS games and not worse on 2026 so far (100+ games).
 *
 * Roster note: the providers give no historical rosters, so a season's roster = the players with a box-score line for
 * the team that season (plus the current roster for the live season) — a proxy for the pre-season roster.
 */
import { fitPlatt, logit, scoreRows, pickBands, IDENTITY, type Platt, type Score, type Band } from './afCalib';

export const LAB_VERSION = 'fix292-1';
export const LAB_TESTS = [2023, 2024, 2025, 2026];
/** the last season any lab setting may be fitted on (2026 is the test) */
export const LAB_FIT_LAST = 2025;
/** combiners train from here (the live model's walk-forward chances start in 2022) */
export const LAB_TRAIN_FIRST = 2022;
/** the lab winner must beat the live model by this much log loss on 2023–2025 */
export const LAB_MARGIN = 0.002;
export const LAB_MODEL = 'ncaa-v3';

export function assertLabFit(seasons: number[]) {
  for (const s of seasons) if (s > LAB_FIT_LAST) throw new Error(`college lab fit on ${s} is not allowed (fit seasons up to ${LAB_FIT_LAST})`);
}

const sig = (x: number) => 1 / (1 + Math.exp(-x));
const clip = (p: number) => Math.min(0.995, Math.max(0.005, p));
const DAY = 86400000;

export interface LabGame { id: number; season: number; t: number; h: number; a: number; hs: number | null; as: number | null; done: boolean; neutral: boolean }
export interface LabTeam { conf: string | null; level: string | null; power: boolean }
/** returning production share (0–1) and talent (z within the season) of a team-season; null = no data */
export interface TeamSeason { ret: number | null; talent: number | null }

/* ---------- team-season numbers from the box-score values ---------- */

/** season|team|player → box-score value that season (offence + defence), from services/collegeLab.ts */
export type ProdMap = Map<string, number>;
export const prodKey = (season: number, team: number, pid: number) => `${season}|${team}|${pid}`;
const LEVEL_W = (t: LabTeam | undefined) => (!t ? 0.4 : t.level === 'FBS' ? (t.power ? 1 : 0.8) : 0.5);

/**
 * ret(S, team) = value of last season's team players who are on this season's roster / all of last season's team value;
 * talent(S, team) = Σ last-season value (any team, level-weighted) of this season's roster, z-scored within S.
 * `roster` adds players to a season's roster (the provider's current roster for the live season).
 */
export function teamSeasons(prod: ProdMap, teams: Map<number, LabTeam>, roster: Map<string, Set<number>> = new Map()): Map<string, TeamSeason> {
  const bySeasonTeam = new Map<string, Map<number, number>>(); // season|team → player → value
  const byPlayerSeason = new Map<string, { team: number; v: number }[]>(); // season|player → teams
  for (const [k, v] of prod) {
    const [s, t, p] = k.split('|').map(Number);
    const st = `${s}|${t}`;
    if (!bySeasonTeam.has(st)) bySeasonTeam.set(st, new Map());
    bySeasonTeam.get(st)!.set(p, (bySeasonTeam.get(st)!.get(p) || 0) + v);
    const ps = `${s}|${p}`;
    if (!byPlayerSeason.has(ps)) byPlayerSeason.set(ps, []);
    byPlayerSeason.get(ps)!.push({ team: t, v });
  }
  const rosterOf = (s: number, t: number) => {
    const set = new Set<number>(bySeasonTeam.get(`${s}|${t}`)?.keys() || []);
    for (const p of roster.get(`${s}|${t}`) || []) set.add(p);
    return set;
  };
  const keys = new Set<string>([...bySeasonTeam.keys(), ...roster.keys()]);
  const raw = new Map<string, { ret: number | null; tal: number | null }>();
  for (const st of keys) {
    const [s, t] = st.split('|').map(Number);
    const ros = rosterOf(s, t);
    if (!ros.size) continue;
    const last = bySeasonTeam.get(`${s - 1}|${t}`);
    let all = 0, back = 0;
    if (last) for (const [p, v] of last) { const w = Math.max(0, v); all += w; if (ros.has(p)) back += w; }
    let tal = 0, any = false;
    for (const p of ros) for (const x of byPlayerSeason.get(`${s - 1}|${p}`) || []) { tal += Math.max(0, x.v) * LEVEL_W(teams.get(x.team)); any = true; }
    raw.set(st, { ret: all > 0 ? back / all : null, tal: any || last ? tal : null });
  }
  // talent z within the season (teams with a value)
  const out = new Map<string, TeamSeason>();
  const seasons = new Set([...raw.keys()].map(k => Number(k.split('|')[0])));
  for (const s of seasons) {
    const list = [...raw.entries()].filter(([k, v]) => k.startsWith(`${s}|`) && v.tal !== null);
    const xs = list.map(([, v]) => Math.log1p(v.tal!));
    const mu = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, xs.length)) || 1;
    for (const [k, v] of raw) if (k.startsWith(`${s}|`)) out.set(k, { ret: v.ret, talent: v.tal === null || xs.length < 10 ? null : (Math.log1p(v.tal) - mu) / sd });
  }
  return out;
}

/* ---------- the Elo pass (margin rating with a pre-season prior) and the rows ---------- */

export interface EloP { k: number; kEarly: number; hfa: number; cap: number; carry: number; retW: number; fcs: number; scale: number }
export const ELO0: EloP = { k: 0.07, kEarly: 0.14, hfa: 3, cap: 28, carry: 0.65, retW: 6, fcs: -18, scale: 8 };
const KH = 15, KC = 20, KP = 4;

export interface LabRow {
  id: number; season: number; t: number; done: boolean; y: number; fbs: boolean;
  /** the Elo's chance in logit units (expected margin / scale) and its expected margin */
  elo: number; expM: number;
  talent: number; talE: number; ret: number; home: number; conf: number; g5p4: number; mis: number;
}
export const FEATURES = ['base', 'elo', 'talent', 'talE', 'ret', 'home', 'conf', 'g5p4', 'mis'] as const;
export type Feature = typeof FEATURES[number];

const isFbs = (t?: LabTeam) => t?.level === 'FBS';
const isP4 = (t?: LabTeam) => !!t && isFbs(t) && t.power;
const isG5 = (t?: LabTeam) => !!t && isFbs(t) && !t.power;

/**
 * One pass over the games in kick-off order: every game's numbers from earlier games only (and the season's team
 * numbers). `stopAfter`: stop once a game of a later season is reached (tuning). `pause` awaited every 400 games.
 */
export async function labPass(games: LabGame[], teams: Map<number, LabTeam>, ts: Map<string, TeamSeason>, P: EloP, stopAfter = Infinity, pause?: () => Promise<void>): Promise<LabRow[]> {
  const sorted = [...games].sort((x, y) => x.t - y.t || x.id - y.id);
  const r = new Map<number, { v: number; season: number; gp: number }>();
  const home = new Map<number, { s: number; n: number; season: number }>();
  const conf = new Map<string, { s: number; n: number; season: number }>();
  const confMean = new Map<number, Map<string, number>>(); // season → conference → mean rating at its start
  const retMean = new Map<number, number>();
  const out: LabRow[] = [];
  let i = 0;
  const startOf = (season: number) => {
    if (confMean.has(season)) return;
    const acc = new Map<string, { s: number; n: number }>();
    for (const [id, x] of r) {
      const c = teams.get(id)?.conf;
      if (!c || x.season !== season - 1) continue;
      const a = acc.get(c) || { s: 0, n: 0 }; a.s += x.v; a.n++; acc.set(c, a);
    }
    confMean.set(season, new Map([...acc].map(([c, a]) => [c, a.s / a.n])));
    const rets = [...ts.entries()].filter(([k, v]) => k.startsWith(`${season}|`) && v.ret !== null).map(([, v]) => v.ret!);
    retMean.set(season, rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0.5);
  };
  const rating = (id: number, season: number) => {
    let x = r.get(id);
    if (x && x.season === season) return x;
    startOf(season);
    const T = teams.get(id), cm = T?.conf ? confMean.get(season)!.get(T.conf) : undefined;
    const base = cm ?? (isFbs(T) ? 0 : P.fcs);
    const tsv = ts.get(`${season}|${id}`);
    const retAdj = tsv?.ret != null ? P.retW * (tsv.ret - retMean.get(season)!) : 0;
    const v = x ? base + P.carry * (x.v - base) + retAdj : base + retAdj;
    x = { v, season, gp: 0 };
    r.set(id, x);
    return x;
  };
  const homeOf = (id: number, season: number) => {
    let h = home.get(id);
    if (!h) { h = { s: 0, n: 0, season }; home.set(id, h); }
    if (h.season !== season) { h.s *= 0.7; h.n *= 0.7; h.season = season; }
    return (P.hfa * KH + h.s) / (KH + h.n);
  };
  const confOf = (c: string | null | undefined, season: number) => {
    if (!c) return null;
    let x = conf.get(c);
    if (!x) { x = { s: 0, n: 0, season }; conf.set(c, x); }
    if (x.season !== season) { x.s *= 0.5; x.n *= 0.5; x.season = season; }
    return x;
  };
  for (const g of sorted) {
    if (g.season > stopAfter) break;
    const H = teams.get(g.h), A = teams.get(g.a);
    const rh = rating(g.h, g.season), ra = rating(g.a, g.season);
    const hfa = g.neutral ? 0 : P.hfa;
    const expM = rh.v - ra.v + hfa;
    const early = KP / (KP + (rh.gp + ra.gp) / 2);
    const th = ts.get(`${g.season}|${g.h}`), ta = ts.get(`${g.season}|${g.a}`);
    const rm = retMean.get(g.season) ?? 0.5;
    const talent = (th?.talent ?? 0) - (ta?.talent ?? 0);
    const ch = confOf(H?.conf, g.season), ca = confOf(A?.conf, g.season);
    const sameConf = !!H?.conf && H.conf === A?.conf;
    const csh = ch ? ch.s / (ch.n + KC) : 0, csa = ca ? ca.s / (ca.n + KC) : 0;
    const homeRow = g.neutral ? 0 : (homeOf(g.h, g.season) - P.hfa) / P.scale;
    const y = !g.done ? 0.5 : g.hs! > g.as! ? 1 : g.hs! < g.as! ? 0 : 0.5;
    out.push({
      id: g.id, season: g.season, t: g.t, done: g.done, y, fbs: isFbs(H) && isFbs(A),
      elo: expM / P.scale, expM, talent, talE: talent * early, ret: ((th?.ret ?? rm) - (ta?.ret ?? rm)) * early,
      home: homeRow, conf: sameConf ? 0 : (csh - csa) / P.scale,
      g5p4: isP4(H) && isG5(A) ? 1 : isG5(H) && isP4(A) ? -1 : 0, mis: isFbs(H) && !isFbs(A) ? 1 : !isFbs(H) && isFbs(A) ? -1 : 0
    });
    if (g.done) {
      const m = g.hs! - g.as!, mc = Math.max(-P.cap, Math.min(P.cap, m)), err = mc - expM;
      rh.v += (rh.gp < 4 ? P.kEarly : P.k) * err; ra.v -= (ra.gp < 4 ? P.kEarly : P.k) * err;
      rh.gp++; ra.gp++;
      if (!g.neutral) { const h = home.get(g.h)!; h.s += m - (expM - hfa); h.n++; }
      if (!sameConf && ch && ca) { const res = mc - expM; ch.s += res; ch.n++; ca.s -= res; ca.n++; }
    }
    if (pause && ++i % 400 === 0) await pause();
  }
  return out;
}

const llOf = (rows: { p: number; y: number }[]) => {
  let s = 0;
  for (const r of rows) { const p = clip(r.p); s += -(r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p)); }
  return rows.length ? s / rows.length : Infinity;
};

/** Pattern search of the Elo settings on log loss of the finished games of `seasons` (fit seasons checked). */
export async function tuneElo(games: LabGame[], teams: Map<number, LabTeam>, ts: Map<string, TeamSeason>, seasons: number[], pause?: () => Promise<void>, start: EloP = ELO0): Promise<{ P: EloP; ll: number }> {
  assertLabFit(seasons);
  const set = new Set(seasons), last = Math.max(...seasons);
  const evalP = async (P: EloP) => llOf((await labPass(games, teams, ts, P, last, pause)).filter(r => r.done && set.has(r.season) && r.y !== 0.5).map(r => ({ p: sig(r.elo), y: r.y })));
  let P = { ...start }, best = await evalP(P);
  const keys = Object.keys(P) as (keyof EloP)[];
  const bounds: Record<keyof EloP, [number, number]> = { k: [0.01, 0.3], kEarly: [0.01, 0.5], hfa: [0, 7], cap: [10, 50], carry: [0.2, 0.95], retW: [-5, 20], fcs: [-35, -5], scale: [4, 14] };
  const span: Record<keyof EloP, number> = { k: 0.03, kEarly: 0.06, hfa: 1, cap: 8, carry: 0.1, retW: 4, fcs: 5, scale: 1 };
  for (const step of [1, 0.5, 0.25]) {
    let moved = true, rounds = 0;
    while (moved && rounds++ < 4) {
      moved = false;
      for (const k of keys) for (const dir of [1, -1]) {
        const v = Math.max(bounds[k][0], Math.min(bounds[k][1], P[k] + dir * span[k] * step));
        if (v === P[k]) continue;
        const Q = { ...P, [k]: v }, ll = await evalP(Q);
        if (ll < best - 1e-6) { best = ll; P = Q; moved = true; break; }
      }
    }
  }
  return { P, ll: best };
}

/* ---------- combiners: ridge logistic (IRLS) and small boosted trees ---------- */

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}
export interface Logit { w: number[]; b: number; mu: number[]; sd: number[] }
export function fitLogit(X: number[][], y: number[], l2 = 1): Logit {
  const k = X[0]?.length || 0, n = X.length;
  const mu = Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[j], 0) / Math.max(1, n));
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / Math.max(1, n)) || 1);
  const Z = X.map(r => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
  let w = new Array(k + 1).fill(0);
  for (let it = 0; it < 15; it++) {
    const H = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0)), g = new Array(k + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const z = Z[i], p = sig(z.reduce((s, v, j) => s + v * w[j], 0)), q = Math.max(1e-6, p * (1 - p));
      for (let a = 0; a <= k; a++) { g[a] += (y[i] - p) * z[a]; for (let c = 0; c <= k; c++) H[a][c] += q * z[a] * z[c]; }
    }
    for (let a = 1; a <= k; a++) { g[a] -= l2 * w[a]; H[a][a] += l2; }
    const step = solve(H, g);
    w = w.map((v, j) => v + step[j]);
    if (step.reduce((s, v) => s + Math.abs(v), 0) < 1e-7) break;
  }
  if (!w.every(Number.isFinite)) { const yb = y.reduce((s, v) => s + v, 0) / Math.max(1, n); return { b: logit(yb || 0.5), w: new Array(k).fill(0), mu, sd }; }
  return { b: w[0], w: w.slice(1), mu, sd };
}
export const predLogit = (m: Logit, x: number[]) => sig(m.b + x.reduce((s, v, j) => s + ((v - m.mu[j]) / m.sd[j]) * m.w[j], 0));

export interface Tree { f: number; t: number; l: Tree | number; r: Tree | number }
export interface Gbdt { trees: Tree[]; lr: number; base: number; platt: Logit }
export async function fitGbdt(X: number[][], y: number[], rounds = 80, lr = 0.08, minLeaf = 40, depth = 2, pause?: () => Promise<void>): Promise<Gbdt> {
  const n = X.length, k = X[0]?.length || 0;
  const ybar = y.reduce((s, v) => s + v, 0) / Math.max(1, n), base = logit(ybar || 0.5);
  const F = new Array(n).fill(base), trees: Tree[] = [];
  const cuts = Array.from({ length: k }, (_, j) => { const v = X.map(r => r[j]).sort((a, b) => a - b); return [...new Set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(q => v[Math.floor(q * (n - 1))]))]; });
  const leaf = (ids: number[], g: number[], h: number[]) => { let G = 0, Hs = 0; for (const i of ids) { G += g[i]; Hs += h[i]; } return G / (Hs + 1); };
  const grow = (ids: number[], g: number[], h: number[], d: number): Tree | number => {
    if (d === 0 || ids.length < 2 * minLeaf) return leaf(ids, g, h);
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
    const b = best;
    return { f: b.f, t: b.t, l: grow(ids.filter(i => X[i][b.f] <= b.t), g, h, d - 1), r: grow(ids.filter(i => X[i][b.f] > b.t), g, h, d - 1) };
  };
  const all = Array.from({ length: n }, (_, i) => i);
  for (let r = 0; r < rounds; r++) {
    const p = F.map(sig), g = p.map((v, i) => y[i] - v), h = p.map(v => v * (1 - v));
    const tree = grow(all, g, h, depth);
    trees.push(tree as Tree);
    for (let i = 0; i < n; i++) F[i] += lr * evalTree(tree, X[i]);
    if (pause && r % 4 === 3) await pause();
  }
  return { trees, lr, base, platt: fitLogit(F.map(v => [v]), y, 0.01) };
}
function evalTree(t: Tree | number, x: number[]): number { while (typeof t !== 'number') t = x[t.f] <= t.t ? t.l : t.r; return t; }
export const predGbdt = (m: Gbdt, x: number[]) => predLogit(m.platt, [m.trees.reduce((s, t) => s + m.lr * evalTree(t, x), m.base)]);

/* ---------- candidates ---------- */

export type LabCand = 'elo' | 'talent' | 'home' | 'conf' | 'rows' | 'trees';
export const CANDS: { id: LabCand; label: string; feats: Feature[] | null }[] = [
  { id: 'elo', label: 'Elo + margin + pre-season prior (returning production)', feats: null },
  { id: 'talent', label: 'Elo + talent (roster value, transfers in)', feats: ['elo', 'talent', 'talE'] },
  { id: 'home', label: 'Elo + home field per team', feats: ['elo', 'home'] },
  { id: 'conf', label: 'Elo + conference strength (G5 vs P4, FBS vs FCS)', feats: ['elo', 'conf', 'g5p4', 'mis'] },
  { id: 'rows', label: 'All rows + live model (logistic)', feats: [...FEATURES] },
  { id: 'trees', label: 'All rows + live model (boosted trees)', feats: [...FEATURES] }
];
export type LabFit = { cand: LabCand; feats: Feature[]; kind: 'none' } | { cand: LabCand; feats: Feature[]; kind: 'logit'; m: Logit } | { cand: LabCand; feats: Feature[]; kind: 'gbdt'; m: Gbdt };
export const featRow = (r: LabRow, base: number, feats: Feature[]) => feats.map(f => (f === 'base' ? logit(base) : (r as any)[f] as number));

/** One candidate fitted on rows (each with the live model's chance `base`); seasons checked. */
export async function fitCand(cand: LabCand, train: { r: LabRow; base: number }[], pause?: () => Promise<void>): Promise<LabFit> {
  const c = CANDS.find(x => x.id === cand)!;
  if (!c.feats) return { cand, feats: [], kind: 'none' };
  assertLabFit([...new Set(train.map(x => x.r.season))]);
  const rows = train.filter(x => x.r.y !== 0.5);
  const X = rows.map(x => featRow(x.r, x.base, c.feats!)), y = rows.map(x => x.r.y);
  if (cand === 'trees') return { cand, feats: c.feats, kind: 'gbdt', m: await fitGbdt(X, y, 80, 0.08, 40, 2, pause) };
  return { cand, feats: c.feats, kind: 'logit', m: fitLogit(X, y, 1) };
}
export function predCand(f: LabFit, r: LabRow, base: number): number {
  if (f.kind === 'none') return sig(r.elo);
  const x = featRow(r, base, f.feats);
  return f.kind === 'gbdt' ? predGbdt(f.m, x) : predLogit(f.m, x);
}

/* ---------- the table ---------- */

export interface Cell { all: Score; fbs: Score }
export interface CandRow { id: string; label: string; seasons: Record<number, Cell>; total: Cell; s2026: Cell | null; bands: Band[]; bandsFbs: Band[]; vsMarket: { games: number; ll: number | null; market: number | null } | null }
type Pred = { id: number; season: number; p: number; y: number; fbs: boolean };
const cell = (list: Pred[]): Cell => ({ all: scoreRows(list), fbs: scoreRows(list.filter(x => x.fbs)) });

export function tableRow(id: string, label: string, preds: Pred[], market?: Map<number, number>): CandRow {
  const seasons: Record<number, Cell> = {};
  for (const s of LAB_TESTS) { const l = preds.filter(x => x.season === s); if (l.length) seasons[s] = cell(l); }
  const fit = preds.filter(x => x.season <= LAB_FIT_LAST), now = preds.filter(x => x.season > LAB_FIT_LAST);
  let vsMarket: CandRow['vsMarket'] = null;
  if (market && market.size) {
    const sel = preds.filter(x => market.has(x.id));
    vsMarket = { games: sel.length, ll: sel.length ? scoreRows(sel).logLoss : null, market: sel.length ? scoreRows(sel.map(x => ({ p: market.get(x.id)!, y: x.y }))).logLoss : null };
  }
  return { id, label, seasons, total: cell(fit), s2026: now.length ? cell(now) : null, bands: pickBands(fit), bandsFbs: pickBands(fit.filter(x => x.fbs)), vsMarket };
}

/** The promotion rule (out of sample only). */
export function pickWinner(rows: CandRow[], liveId: string, lab: string[] = CANDS.map(c => c.id)) {
  const live = rows.find(r => r.id === liveId);
  const cands = rows.filter(r => lab.includes(r.id) && r.total.all.logLoss !== null).sort((a, b) => a.total.all.logLoss! - b.total.all.logLoss!);
  const best = cands[0];
  if (!live || !best || live.total.all.logLoss === null) return { winner: best?.id ?? null, promote: false, reason: 'not enough test games' };
  const d = live.total.all.logLoss - best.total.all.logLoss!;
  const fbsOk = best.total.fbs.logLoss === null || live.total.fbs.logLoss === null || best.total.fbs.logLoss <= live.total.fbs.logLoss;
  const n26 = best.s2026?.all.games || 0;
  const now26 = n26 < 100 || best.s2026!.all.logLoss! <= (live.s2026?.all.logLoss ?? Infinity);
  const promote = d >= LAB_MARGIN && fbsOk && now26;
  const reason = `${best.id} LL ${best.total.all.logLoss} vs live ${liveId} ${live.total.all.logLoss} on 2023–2025 (${best.total.all.games} games, needs −${LAB_MARGIN})`
    + `; FBS vs FBS ${best.total.fbs.logLoss} vs ${live.total.fbs.logLoss}${fbsOk ? '' : ' (worse)'}`
    + `; 2026 so far ${n26 >= 100 ? `${best.s2026!.all.logLoss} vs ${live.s2026?.all.logLoss}${now26 ? '' : ' (worse)'}` : `${n26} games (under 100: not checked)`}`
    + ` → ${promote ? `${best.id} promoted (${LAB_MODEL})` : `${liveId} stays`}`;
  return { winner: best.id, promote, reason };
}

/** Market anchor walk-forward by week: logistic on [live model, closing line] fitted on the earlier weeks (80+ games). */
export function marketAnchorWf(rows: { id: number; t: number; y: number; base: number; mkt: number; fbs: boolean }[], minTrain = 80) {
  const list = rows.filter(r => r.y !== 0.5).sort((a, b) => a.t - b.t);
  const week = (t: number) => Math.floor(t / (7 * DAY));
  const out: { p: number; base: number; mkt: number; y: number; fbs: boolean }[] = [];
  const weeks = [...new Set(list.map(r => week(r.t)))];
  let fit: Logit | null = null;
  for (const w of weeks) {
    const train = list.filter(r => week(r.t) < w);
    if (train.length < minTrain) continue;
    fit = fitLogit(train.map(r => [logit(r.base), logit(r.mkt)]), train.map(r => r.y), 1);
    for (const r of list.filter(x => week(x.t) === w)) out.push({ p: predLogit(fit, [logit(r.base), logit(r.mkt)]), base: r.base, mkt: r.mkt, y: r.y, fbs: r.fbs });
  }
  const sc = (k: 'p' | 'base' | 'mkt', fbs = false) => scoreRows(out.filter(r => !fbs || r.fbs).map(r => ({ p: r[k], y: r.y })));
  const anchor = sc('p'), model = sc('base'), market = sc('mkt');
  return {
    games: list.length, scored: out.length, model, market, anchor, fbs: { model: sc('base', true), market: sc('mkt', true), anchor: sc('p', true) },
    weights: fit ? { model: fit.w[0] / fit.sd[0], market: fit.w[1] / fit.sd[1] } : null,
    better: out.length >= 100 && anchor.logLoss! < Math.min(model.logLoss!, market.logLoss!)
  };
}

/* ---------- fix292 part 1: the college layer refit on 2025 + 2026, out of fold ---------- */

export interface RefitRow { id: number; p: number; y: number; season: number; t: number; level: 'fbs' | 'mismatch' | 'fcs'; cur: number }
export interface Refit { mode: 'fbs' | 'shared' | 'kept'; shared: Platt; fbs: Platt | null; games: number; seasons: number[]; at?: string }
const apply = (f: Platt, p: number) => sig(f.a * logit(p) + f.b);

/**
 * Out-of-fold check (5 folds by week) of: the current layer (as it is), one shared college fit, and a separate FBS fit
 * (FBS vs FBS games; the rest keep the shared fit). Separate only when it beats shared on FBS games by 0.0005 log loss;
 * the refit replaces the current layer unless it is worse on the 2026 games (where the current layer never saw a game).
 */
export function refitCollege(rows: RefitRow[], folds = 5) {
  const list = rows.filter(r => r.y !== 0.5 && Number.isFinite(r.p));
  const fold = (r: RefitRow) => Math.floor(r.t / (7 * DAY)) % folds;
  const oofShared = new Map<number, number>(), oofSplit = new Map<number, number>();
  for (let f = 0; f < folds; f++) {
    const train = list.filter(r => fold(r) !== f), test = list.filter(r => fold(r) === f);
    if (!test.length) continue;
    const sh = train.length >= 50 ? fitPlatt(train) : IDENTITY;
    const fbsTrain = train.filter(r => r.level === 'fbs');
    const fb = fbsTrain.length >= 50 ? fitPlatt(fbsTrain) : sh;
    for (const r of test) { oofShared.set(r.id, apply(sh, r.p)); oofSplit.set(r.id, r.level === 'fbs' ? apply(fb, r.p) : apply(sh, r.p)); }
  }
  const sc = (pick: (r: RefitRow) => number, sel: (r: RefitRow) => boolean) => scoreRows(list.filter(sel).map(r => ({ p: pick(r), y: r.y })));
  const variants = { raw: (r: RefitRow) => r.p, current: (r: RefitRow) => r.cur, shared: (r: RefitRow) => oofShared.get(r.id)!, split: (r: RefitRow) => oofSplit.get(r.id)! };
  const groups: Record<string, (r: RefitRow) => boolean> = {
    all: () => true, fbs: r => r.level === 'fbs', mismatch: r => r.level === 'mismatch', fcs: r => r.level === 'fcs',
    fbs2026: r => r.level === 'fbs' && r.season > LAB_FIT_LAST, all2026: r => r.season > LAB_FIT_LAST
  };
  const scores = Object.fromEntries(Object.entries(variants).map(([k, pick]) => [k, Object.fromEntries(Object.entries(groups).map(([g, sel]) => [g, sc(pick, sel)]))])) as Record<keyof typeof variants, Record<string, Score>>;
  const bandsFbs = Object.fromEntries(Object.entries(variants).map(([k, pick]) => [k, pickBands(list.filter(r => r.level === 'fbs').map(r => ({ p: pick(r), y: r.y })))]));
  const llF = (k: keyof typeof variants) => scores[k].fbs.logLoss ?? Infinity;
  const split = llF('split') < llF('shared') - 0.0005;
  const chosen = split ? 'split' : 'shared';
  // against the current layer on 2026 (out of sample for it): the chosen refit must not be worse
  const worse = (scores[chosen].all2026.games >= 30) && (scores[chosen].all2026.logLoss ?? Infinity) > (scores.current.all2026.logLoss ?? Infinity);
  const mode: Refit['mode'] = list.length < 100 ? 'kept' : worse ? 'kept' : split ? 'fbs' : 'shared';
  const shared = list.length >= 50 ? fitPlatt(list) : IDENTITY;
  const fbsRows = list.filter(r => r.level === 'fbs');
  const fbs = mode === 'fbs' && fbsRows.length >= 50 ? fitPlatt(fbsRows) : null;
  const why = list.length < 100 ? `only ${list.length} settled games of 2025–2026: the current layer stays`
    : `out of fold on ${list.length} games (${fbsRows.length} FBS vs FBS): FBS LL raw ${scores.raw.fbs.logLoss}, current ${scores.current.fbs.logLoss}, shared refit ${scores.shared.fbs.logLoss}, separate FBS ${scores.split.fbs.logLoss}`
      + ` → ${split ? 'separate FBS layer' : 'shared college layer'}; 2026 games: current ${scores.current.all2026.logLoss}, refit ${scores[chosen].all2026.logLoss}`
      + ` → ${mode === 'kept' ? 'the current layer stays (the refit is worse on 2026)' : 'refit live'}`;
  const refit: Refit = { mode, shared, fbs, games: list.length, seasons: [...new Set(list.map(r => r.season))].sort() };
  return { refit, scores, bandsFbs, why };
}
/** The refit layer on a college chance (mode 'kept' = null: the current layer applies). */
export function applyRefit(r: Refit | null | undefined, p: number, fbs: boolean): number | null {
  if (!r || r.mode === 'kept') return null;
  return apply(r.mode === 'fbs' && fbs && r.fbs ? r.fbs : r.shared, p);
}

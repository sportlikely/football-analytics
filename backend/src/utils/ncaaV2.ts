/**
 * fix220 — ncaa-v2, the college football model with the NFL model's inputs. Pure functions (no database);
 * services/afCalibration.ts feeds them our tables and runs the test, the gate and the live predictions.
 *
 * Rows (buildRows): one pass over every game in kick-off order; a game's numbers use only games that finished before
 * it (the same pass serves the training seasons, the test seasons and the upcoming games):
 *  - eff: opponent-adjusted points per play (plays from the box score, else the league's average plays per team),
 *    offence and defence per team, updated after each game against what the opponent usually allows / scores.
 *    Two sets: this season only, and carried over seasons (last season's end = the early-season prior).
 *    The team's rating = k / (k + games played) × prior + the rest × this season (k tuned).
 *  - ypp: opponent-adjusted yards per play (box scores only; 0 when a side has fewer than 3).
 *  - qb: the expected starter (the team's last starter: what was known before kick-off, never this game's box score)
 *    ANY/A shrunk toward a replacement level (200 attempts); a new starter (not last season's main passer) shrunk
 *    halfway more. 0 when either side has no passing lines.
 *  - rest: bye (≥ 12.5 days) and short week (≤ 5.5 days), home minus away.
 *  - travel: the away team's distance (state centres, 1,000 km), 0 at neutral sites.
 *  - level: Power conference 2 / other FBS 1 / FCS 0, home minus away.
 *  - ret: last season's main passer back (he has thrown for the team this season), home minus away, early season only.
 *  - conf / mismatch: conference game, FBS vs FCS — they scale how far the Elo (ncaa-v1) chance is trusted.
 * Model: logit(p) = b + wElo·L + wConf·conf·L + wMis·mis·L + Σ w·x (L = ncaa-v1's logit), features scaled by their
 * training spread (not centred: 0 = no information). Tuned by pattern search on log loss (fix217's approach) on the
 * training seasons only; assertTrain refuses 2026.
 */

import { segOfTeams } from './afCalib';

export const V2_TRAIN_LAST = 2025; // the live fit may use 2021–2025; never 2026
export const V2_TEST_SEASON = 2025;
export const V2_FIRST = 2021;
export function assertTrain(seasons: number[], last = V2_TRAIN_LAST) {
  for (const s of seasons) if (s > last || s < V2_FIRST) throw new Error(`ncaa-v2 fit on ${s} is not allowed (fit seasons: ${V2_FIRST}–${last})`);
}

export interface V2Game { id: number; season: number; t: number; h: number; a: number; hs: number | null; as: number | null; done: boolean; neutral: boolean }
export interface V2Team { conf: string | null; level: 'FBS' | 'FCS' | string | null; power: boolean; state: string | null }
export interface V2Box { plays: number | null; ypp: number | null }
export interface V2Passer { id: number; att: number; anya: number }
/** The pre-game numbers of a game (L = ncaa-v1's logit comes separately). */
export interface V2Raw {
  id: number; season: number; done: boolean; y: number;
  prevH: number; prevA: number; curH: number; curA: number; gpH: number; gpA: number;
  ypp: number; qb: number; bye: number; short: number; travel: number; lvl: number; ret: number; conf: number; mis: number; home: number;
}

const DAY = 86400000;
const PLAYS = 70; // a college team's usual plays per game (no box score)
const QB_PRIOR = 200, QB_REPL = 0.7, QB_DECAY = 0.985;
const A_CUR = 0.18, A_CARRY = 0.08, CARRY_KEEP = 0.6;

/** Power conferences (and Notre Dame, independent) = level 2. */
export const POWER = /^(sec|southeastern|big ten|big 10|big 12|big twelve|acc|atlantic coast|pac[- ]?12|pacific[- ]?12)/i;
export function levelOf(t: V2Team | undefined, name?: string | null): number {
  if (!t) return 0;
  if (t.level === 'FBS') return t.power || /notre dame/i.test(name || '') ? 2 : 1;
  return 0;
}

/** State centres (lat, lon) by postal code; full names map to the code. */
const STATES: Record<string, [number, number]> = {
  AL: [32.8, -86.8], AK: [61.4, -152.3], AZ: [34.2, -111.7], AR: [34.9, -92.4], CA: [36.8, -119.4], CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5],
  DC: [38.9, -77.0], FL: [28.6, -82.4], GA: [32.7, -83.4], HI: [20.8, -156.3], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3], IA: [42.1, -93.5],
  KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2], MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3],
  MS: [32.7, -89.7], MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6], NJ: [40.2, -74.7], NM: [34.4, -106.1],
  NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5], OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5],
  SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7], VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5],
  WV: [38.6, -80.6], WI: [44.6, -89.9], WY: [43.0, -107.6]
};
const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL',
  georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY'
};
/** "Tuscaloosa, AL" / "Tuscaloosa, Alabama" → 'AL' (null when not found). */
export function stateOf(city: string | null | undefined): string | null {
  if (!city) return null;
  const last = String(city).split(',').pop()!.trim();
  if (/^[A-Z]{2}$/.test(last) && STATES[last]) return last;
  return STATE_NAMES[last.toLowerCase()] || null;
}
function km(a: [number, number], b: [number, number]) {
  const R = 6371, rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

interface TS {
  season: number; last: number; gp: number;
  co: number; cd: number; ko: number; kd: number; prev: number; // points per play: this season (c), carried (k), last season's end net
  yo: number; yd: number; yn: number;
  starter: number | null; mainPrev: number | null; att: Map<number, number>; retSeen: boolean;
}

/**
 * Every game's pre-game numbers, in kick-off order. `pause` is awaited every 200 games (the worker yields there).
 * `outQb` (optional): passers ruled out for upcoming games (the injury report), skipped when choosing the starter.
 */
export async function buildRows(games: V2Game[], box: Map<string, V2Box>, qb: Map<string, V2Passer[]>, teams: Map<number, V2Team>, names: Map<number, string>,
  pause: () => Promise<void> = async () => undefined, outQb: Set<number> = new Set()): Promise<V2Raw[]> {
  const list = [...games].sort((x, y) => x.t - y.t || x.id - y.id);
  const st = new Map<number, TS>();
  const qr = new Map<number, { s: number; w: number }>();
  let mu = 0.42, qbMean = 6.0; // points per play, league ANY/A (moving)
  const team = (id: number, season: number): TS => {
    let t = st.get(id);
    if (!t) { t = { season, last: 0, gp: 0, co: 0, cd: 0, ko: 0, kd: 0, prev: 0, yo: 0, yd: 0, yn: 0, starter: null, mainPrev: null, att: new Map(), retSeen: false }; st.set(id, t); }
    else if (t.season !== season) {
      t.prev = t.ko - t.kd;
      t.ko *= CARRY_KEEP; t.kd *= CARRY_KEEP; t.yo *= CARRY_KEEP; t.yd *= CARRY_KEEP; t.yn = Math.min(t.yn, 3);
      t.co = 0; t.cd = 0; t.gp = 0;
      t.mainPrev = [...t.att.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      t.att = new Map(); t.retSeen = false; t.season = season;
    }
    return t;
  };
  const qbVal = (id: number | null) => {
    if (!id) return null;
    const r = qr.get(id), rep = qbMean - QB_REPL;
    return r ? (r.s + rep * QB_PRIOR) / (r.w + QB_PRIOR) : rep;
  };
  const out: V2Raw[] = [];
  let i = 0;
  for (const g of list) {
    if (++i % 200 === 0) await pause();
    const H = team(g.h, g.season), A = team(g.a, g.season);
    const tH = teams.get(g.h), tA = teams.get(g.a);
    const seg = segOfTeams(tH, tA); // the same segments as the calibration layer
    const rest = (t: TS) => (t.last && t.gp > 0 ? (g.t - t.last) / DAY : null);
    const rH = rest(H), rA = rest(A);
    const bye = (r: number | null) => (r !== null && r >= 12.5 ? 1 : 0), short = (r: number | null) => (r !== null && r <= 5.5 ? 1 : 0);
    const sH = tH?.state ? STATES[tH.state] : null, sA = tA?.state ? STATES[tA.state] : null;
    const qbSide = (t: TS) => {
      let id = t.starter;
      if (id && outQb.has(id)) id = [...t.att.entries()].filter(([p]) => p !== id && !outQb.has(p)).sort((x, y) => y[1] - x[1])[0]?.[0] ?? -1;
      if (!id) return null;
      let v = id === -1 ? qbMean - QB_REPL : qbVal(id)!;
      if (t.mainPrev !== null && id !== t.mainPrev && t.gp < 4) v = (qbMean - QB_REPL) + 0.5 * (v - (qbMean - QB_REPL)); // new starter
      return v;
    };
    const qH = qbSide(H), qA = qbSide(A);
    const retOf = (t: TS) => (t.mainPrev === null ? 0.5 : t.retSeen ? 1 : t.gp > 0 ? 0 : 0.5);
    const y = g.done ? (g.hs! > g.as! ? 1 : g.hs! < g.as! ? 0 : 0.5) : 0.5;
    out.push({
      id: g.id, season: g.season, done: g.done, y,
      prevH: H.prev, prevA: A.prev, curH: H.co - H.cd, curA: A.co - A.cd, gpH: H.gp, gpA: A.gp,
      ypp: H.yn >= 3 && A.yn >= 3 ? (H.yo - H.yd) - (A.yo - A.yd) : 0,
      qb: qH !== null && qA !== null ? qH - qA : 0,
      bye: bye(rH) - bye(rA), short: short(rH) - short(rA),
      travel: !g.neutral && sH && sA ? km(sH, sA) / 1000 : 0,
      lvl: levelOf(tH, names.get(g.h)) - levelOf(tA, names.get(g.a)),
      ret: retOf(H) - retOf(A),
      conf: seg === 'conf' ? 1 : 0,
      mis: seg === 'mismatch' ? 1 : 0,
      home: g.neutral ? 0 : 1
    });
    if (!g.done) continue;
    // ratings after the game
    const home = g.neutral ? 0 : 1;
    const bH = box.get(`${g.id}|${g.h}`), bA = box.get(`${g.id}|${g.a}`);
    const ppH = g.hs! / Math.max(20, bH?.plays || PLAYS), ppA = g.as! / Math.max(20, bA?.plays || PLAYS);
    if (Number.isFinite(ppH) && Number.isFinite(ppA)) {
      const hf = 0.02 * home;
      const eH = ppH - (mu + hf + H.co + A.cd), eA = ppA - (mu - hf + A.co + H.cd);
      H.co += A_CUR * eH; A.cd += A_CUR * eH; A.co += A_CUR * eA; H.cd += A_CUR * eA;
      const kH = ppH - (mu + hf + H.ko + A.kd), kA = ppA - (mu - hf + A.ko + H.kd);
      H.ko += A_CARRY * kH; A.kd += A_CARRY * kH; A.ko += A_CARRY * kA; H.kd += A_CARRY * kA;
      mu += 0.003 * ((ppH + ppA) / 2 - mu);
    }
    if (bH?.ypp != null && bA?.ypp != null && Number.isFinite(bH.ypp) && Number.isFinite(bA.ypp)) {
      const yMu = 5.6;
      const eH = bH.ypp - (yMu + H.yo + A.yd), eA = bA.ypp - (yMu + A.yo + H.yd);
      H.yo += 0.12 * eH; A.yd += 0.12 * eH; A.yo += 0.12 * eA; H.yd += 0.12 * eA;
      H.yn++; A.yn++;
    }
    for (const [id, t] of [[g.h, H], [g.a, A]] as [number, TS][]) {
      const lines = qb.get(`${g.id}|${id}`);
      if (!lines || !lines.length) continue;
      for (const p of lines) {
        if (!Number.isFinite(p.anya) || !(p.att > 0)) continue;
        const r = qr.get(p.id) || { s: 0, w: 0 };
        r.s = r.s * QB_DECAY + p.anya * p.att; r.w = r.w * QB_DECAY + p.att; qr.set(p.id, r);
        qbMean += 0.0005 * p.att * (p.anya - qbMean) / 30;
        t.att.set(p.id, (t.att.get(p.id) || 0) + p.att);
        if (p.id === t.mainPrev) t.retSeen = true;
      }
      t.starter = lines[0].id;
    }
    H.gp++; A.gp++; H.last = g.t; A.last = g.t;
  }
  return out;
}

/* ---------- the model ---------- */

export const FEATS = ['eff', 'ypp', 'qb', 'bye', 'short', 'travel', 'lvl', 'ret', 'home'] as const;
export type Feat = (typeof FEATS)[number];
export interface V2Params { k: number; b: number; wElo: number; wConf: number; wMis: number; w: Record<Feat, number>; scale: Record<Feat, number> }

const sig = (x: number) => 1 / (1 + Math.exp(-x));
const clip = (p: number) => Math.min(0.995, Math.max(0.005, p));
export const lgt = (p: number) => Math.log(clip(p) / (1 - clip(p)));

/** The team ratings with the early-season prior: k / (k + games played) of last season's end. */
export function effGap(r: V2Raw, k: number) {
  const R = (prev: number, cur: number, gp: number) => { const w = k / (k + gp); return w * prev + (1 - w) * cur; };
  return R(r.prevH, r.curH, r.gpH) - R(r.prevA, r.curA, r.gpA);
}
export function featOf(r: V2Raw, k: number): Record<Feat, number> {
  const early = k / (k + Math.min(r.gpH, r.gpA));
  return { eff: effGap(r, k), ypp: r.ypp, qb: r.qb, bye: r.bye, short: r.short, travel: r.travel, lvl: r.lvl, ret: r.ret * early, home: r.home };
}
/** ncaa-v2's home win chance from its numbers and ncaa-v1's chance. */
export function v2P(p: V2Params, r: V2Raw, v1p: number): number {
  const L = lgt(v1p), f = featOf(r, p.k);
  let z = p.b + L * (p.wElo + p.wConf * r.conf + p.wMis * r.mis);
  for (const k of FEATS) z += p.w[k] * (f[k] / (p.scale[k] || 1));
  return sig(z);
}

export function logLoss(ps: number[], ys: number[]) {
  let s = 0;
  for (let i = 0; i < ps.length; i++) { const p = clip(ps[i]); s += -(ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p)); }
  return s / Math.max(1, ps.length);
}

export function startParams(rows: { r: V2Raw }[]): V2Params {
  const scale = {} as Record<Feat, number>;
  for (const k of FEATS) {
    const v = rows.map(x => featOf(x.r, 4)[k]);
    const m2 = v.reduce((s, x) => s + x * x, 0) / Math.max(1, v.length);
    scale[k] = Math.sqrt(m2) || 1;
  }
  return { k: 4, b: 0, wElo: 1, wConf: 0, wMis: 0, w: Object.fromEntries(FEATS.map(k => [k, 0])) as Record<Feat, number>, scale };
}

/**
 * Pattern search on log loss (fix217's tuner): every setting tried a step up and down, the step halved when nothing
 * improves, until the smallest step. Training rows only (their seasons checked against `last`).
 */
export async function tuneV2(rows: { r: V2Raw; v1: number }[], last = V2_TRAIN_LAST, pause: () => Promise<void> = async () => undefined): Promise<V2Params> {
  assertTrain([...new Set(rows.map(x => x.r.season))], last);
  const use = rows.filter(x => x.r.done && x.r.y !== 0.5);
  let best = startParams(use);
  if (use.length < 300) return best;
  const ys = use.map(x => x.r.y);
  const ll = (q: V2Params) => logLoss(use.map(x => v2P(q, x.r, x.v1)), ys);
  let bestLL = ll(best);
  type Knob = { get: (q: V2Params) => number; set: (q: V2Params, v: number) => V2Params; lo: number; hi: number; mult?: boolean };
  const w = (k: Feat): Knob => ({ get: q => q.w[k], set: (q, v) => ({ ...q, w: { ...q.w, [k]: v } }), lo: -3, hi: 3 });
  const knobs: Knob[] = [
    { get: q => q.wElo, set: (q, v) => ({ ...q, wElo: v }), lo: 0, hi: 2 },
    { get: q => q.wConf, set: (q, v) => ({ ...q, wConf: v }), lo: -1, hi: 1 },
    { get: q => q.wMis, set: (q, v) => ({ ...q, wMis: v }), lo: -1, hi: 1 },
    { get: q => q.b, set: (q, v) => ({ ...q, b: v }), lo: -1, hi: 1 },
    { get: q => q.k, set: (q, v) => ({ ...q, k: v }), lo: 0.5, hi: 20, mult: true },
    ...FEATS.map(w)
  ];
  let evals = 0;
  for (const step of [0.4, 0.2, 0.1, 0.05, 0.02]) {
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (const kn of knobs) for (const dir of [1, -1]) {
        const cur = kn.get(best);
        const v = kn.mult ? cur * (dir > 0 ? 1 + 2.5 * step : 1 / (1 + 2.5 * step)) : cur + dir * step;
        if (v < kn.lo || v > kn.hi) continue;
        const q = kn.set(best, v), x = ll(q);
        if (++evals % 40 === 0) await pause();
        if (x < bestLL - 1e-7) { best = q; bestLL = x; moved = true; }
      }
      if (!moved) break;
    }
  }
  return best;
}

/**
 * Full tuner for v3: fits every row weight and conversion constant at once, on whole seasons, and reports
 * what that does on a later season (the honest test) — including the period since the site started
 * recording its predictions.
 *
 * It replays the live model's own numbers: for every match the values of the 10 team rows (home, away), the
 * 3 draw rows and the goals-based draw chance are collected once (walk-forward, like the backtest), then the
 * final formula (gap → split) is re-evaluated in memory for each candidate setting, so a full fit of ~70
 * numbers takes a minute, not hours.
 *
 *   GET /api/model/v3/tune?train=2425,2526&test=2627[&since=2026-09-05][&rounds=80][&lambda=0][&shared=0][&lc=1][&apply=0]
 *   GET /api/model/v3/tune/result
 *   GET /api/model/v3/tuned[?clear=1]
 */
import logger from '../utils/logger';
import { db } from '../db';
import { GROUPS, loadGroupMatches } from './history';
import { inBatches, slicer } from './perf';
import {
  CONV, buildState, scoreMatch, withLiveConfig, weekDivs, LAST_DETAIL, TEAM_ROW_IDS, DRAW_ROW_IDS, rowRel, MatchType,
  leagueConvStatus, LeagueConv, storeTuning
} from './gridModel';

type Out = 'H' | 'D' | 'A';
interface Item {
  div: string; season: string; date: string; type: number; // type index 0..3
  home: string; away: string; // football-data.co.uk names (to join other models' predictions)
  o: Out; mkt: { H: number; D: number; A: number } | null;
  d: Float64Array; // team rows: vh - va
  c: Uint8Array; // counted in Σrel
  dv: Float64Array; // draw rows values
  pois: number; // goals-based draw chance
}
const TYPES: MatchType[] = ['mismatch', 'standard', 'even', 'big'];
const DAY = 24 * 3600 * 1000;
/** Divisions the site predicts live (the second divisions are history only, for promoted sides). */
const LIVE_DIVS = new Set(Object.values(GROUPS).map(g => g.divisions[0]).concat(['E1']));

export let tuneProgress: { stage: string; done: number; total: number } | null = null;

async function collect(seasons: string[], allDivs: boolean): Promise<Item[]> {
  const out: Item[] = [];
  const groups = Object.keys(GROUPS);
  let gi = 0;
  for (const group of groups) {
    tuneProgress = { stage: `collecting ${group}`, done: gi++, total: groups.length };
    const divs = GROUPS[group].divisions.filter(d => allDivs || LIVE_DIVS.has(d));
    const all = loadGroupMatches(group);
    for (const season of seasons) {
      const target = all.filter(m => m.season === season && divs.includes(m.division));
      if (!target.length) continue;
      let cursor = new Date(target[0].date);
      const last = new Date(target[target.length - 1].date);
      while (cursor <= last) {
        const from = cursor.toISOString().slice(0, 10);
        const to = new Date(cursor.getTime() + 7 * DAY).toISOString().slice(0, 10);
        const week = target.filter(m => m.date >= from && m.date < to);
        if (week.length) {
          withLiveConfig(() => {
            const state = buildState(group, all, from, weekDivs(week));
            for (const m of week) {
              const p = scoreMatch(state, all, m.home, m.away, from, m.date);
              const det = LAST_DETAIL;
              if (!p || !det) continue;
              const d = new Float64Array(TEAM_ROW_IDS.length), c = new Uint8Array(TEAM_ROW_IDS.length);
              TEAM_ROW_IDS.forEach((id, i) => { const r = det.rows.find(x => x.id === id); if (r) { d[i] = r.vh - r.va; c[i] = r.counted ? 1 : 0; } });
              const dv = new Float64Array(DRAW_ROW_IDS.length);
              DRAW_ROW_IDS.forEach((id, i) => { const r = det.draws.find(x => x.id === id); dv[i] = r ? r.v : 5; });
              const oh = m.close_h ?? m.odds_h, od = m.close_d ?? m.odds_d, oa = m.close_a ?? m.odds_a;
              let mkt: Item['mkt'] = null;
              if (oh && od && oa) { const s = 1 / oh + 1 / od + 1 / oa; mkt = { H: 1 / oh / s, D: 1 / od / s, A: 1 / oa / s }; }
              out.push({ div: m.division, season, date: m.date, home: m.home, away: m.away, type: TYPES.indexOf(det.type), o: m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D', mkt, d, c, dv, pois: det.poisDraw });
            }
          });
          await new Promise<void>(resolve => setImmediate(() => resolve()));
        }
        cursor = new Date(cursor.getTime() + 7 * DAY);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Parameter vector                                                     */
/* ------------------------------------------------------------------ */

interface ParamDef { name: string; lo: number; hi: number; step: number; group: string }
const NT = TEAM_ROW_IDS.length, ND = DRAW_ROW_IDS.length;

function paramDefs(shared: boolean): ParamDef[] {
  const defs: ParamDef[] = [];
  const types = shared ? ['all'] : TYPES;
  for (const id of TEAM_ROW_IDS) for (const t of types) defs.push({ name: `${id}.${t}`, lo: 0, hi: 15, step: 0.5, group: 'rel' });
  for (const id of DRAW_ROW_IDS) for (const t of types) defs.push({ name: `${id}.${t}`, lo: 0, hi: 12, step: 0.5, group: 'rel' });
  defs.push({ name: 'gapScale', lo: 0.05, hi: 1, step: 0.01, group: 'conv' });
  defs.push({ name: 'homeGap', lo: -0.1, hi: 0.3, step: 0.005, group: 'conv' });
  defs.push({ name: 'drawPoisScale', lo: 0.5, hi: 1.6, step: 0.025, group: 'conv' });
  defs.push({ name: 'drawStretch', lo: 0.4, hi: 2.5, step: 0.05, group: 'conv' });
  defs.push({ name: 'drawGapK', lo: 0, hi: 1.5, step: 0.025, group: 'conv' });
  defs.push({ name: 'drawClose', lo: 0, hi: 250, step: 10, group: 'conv' });
  defs.push({ name: 'drawCloseSpan', lo: 0.1, hi: 0.8, step: 0.05, group: 'conv' });
  defs.push({ name: 'gapCube', lo: 0, hi: 40, step: 1, group: 'conv' });
  defs.push({ name: 'floorOutsider', lo: 5, hi: 100, step: 5, group: 'conv' });
  defs.push({ name: 'floorDraw', lo: 20, hi: 200, step: 10, group: 'conv' });
  for (const t of TYPES) defs.push({ name: `drawCap.${t}`, lo: 200, hi: 600, step: 10, group: 'conv' });
  return defs;
}

/** Current live setting as a vector. */
function startVector(defs: ParamDef[], shared: boolean): Float64Array {
  const x = new Float64Array(defs.length);
  defs.forEach((p, i) => {
    const [a, b] = p.name.split('.');
    if (p.group === 'rel') {
      const rel = rowRel(a)!;
      x[i] = shared ? (rel.mismatch + rel.standard + rel.even + rel.big) / 4 : rel[b as MatchType];
      if (DRAW_ROW_IDS.includes(a)) x[i] *= CONV.kDraw;
    } else if (a === 'drawCap') x[i] = CONV.drawCap[b as MatchType];
    else x[i] = (CONV as any)[a];
  });
  return x;
}

/** Vector → the live setting it means (row weights per match type, conversion constants). */
function unpack(defs: ParamDef[], x: Float64Array, shared: boolean) {
  const rel: Record<string, Record<MatchType, number>> = {};
  const conv: any = { drawCap: {} as Record<MatchType, number>, kDraw: 1 };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  defs.forEach((p, i) => {
    const [a, b] = p.name.split('.');
    if (p.group === 'rel') {
      rel[a] ||= { mismatch: 0, standard: 0, even: 0, big: 0 };
      if (shared) for (const t of TYPES) rel[a][t] = r3(x[i]);
      else rel[a][b as MatchType] = r3(x[i]);
    } else if (a === 'drawCap') conv.drawCap[b as MatchType] = r3(x[i]);
    else conv[a] = r3(x[i]);
  });
  return { rel, conv };
}

/* ------------------------------------------------------------------ */
/* The live formula, evaluated from a vector                             */
/* ------------------------------------------------------------------ */

interface Compiled {
  w: Float64Array; // [type*NT + row]
  wd: Float64Array; // [type*ND + k]
  gapScale: number; homeGap: number; drawPoisScale: number; drawStretch: number; drawGapK: number; drawClose: number; drawCloseSpan: number;
  gapCube: number; floorOutsider: number; floorDraw: number; drawCap: Float64Array;
}
function compile(defs: ParamDef[], x: Float64Array, shared: boolean): Compiled {
  const c: Compiled = {
    w: new Float64Array(4 * NT), wd: new Float64Array(4 * ND), gapScale: 0.2, homeGap: 0, drawPoisScale: 1, drawStretch: 1, drawGapK: 0, drawClose: 0,
    drawCloseSpan: 0.3, gapCube: 0, floorOutsider: 35, floorDraw: 60, drawCap: new Float64Array(4)
  };
  defs.forEach((p, i) => {
    const [a, b] = p.name.split('.');
    if (p.group === 'rel') {
      const ti = TEAM_ROW_IDS.indexOf(a), di = DRAW_ROW_IDS.indexOf(a);
      const types = shared ? [0, 1, 2, 3] : [TYPES.indexOf(b as MatchType)];
      for (const t of types) { if (ti >= 0) c.w[t * NT + ti] = x[i]; else c.wd[t * ND + di] = x[i]; }
    } else if (a === 'drawCap') c.drawCap[TYPES.indexOf(b as MatchType)] = x[i];
    else (c as any)[a] = x[i];
  });
  return c;
}

const LC0: LeagueConv = { draw: 0, home: 0, stretch: 1, cube: 0, close: 0 };
const DRAW_CENTER = 260;

function probs(c: Compiled, it: Item, lc: LeagueConv): [number, number, number] {
  const t = it.type;
  let tot = 0, relSum = 0;
  for (let i = 0; i < NT; i++) { const w = c.w[t * NT + i]; tot += w * it.d[i]; if (it.c[i]) relSum += w; }
  const gap0 = tot / (11 * Math.max(1, relSum)) + c.homeGap;
  let drawFactors = 0;
  for (let k = 0; k < ND; k++) drawFactors += (it.dv[k] - 5) * c.wd[t * ND + k];
  const base = Math.round(1000 * it.pois * c.drawPoisScale);
  const closeness = c.drawClose * Math.max(0, 1 - Math.abs(gap0) / c.drawCloseSpan);
  let drawRaw = base + drawFactors + closeness;
  drawRaw = DRAW_CENTER + c.drawStretch * (drawRaw - DRAW_CENTER) - c.drawGapK * 1000 * Math.abs(gap0 - c.homeGap);
  // split (with the league's own setting, as live)
  const gap = gap0 + lc.home;
  const close = lc.close ? lc.close * Math.max(0, 1 - Math.abs(gap) / c.drawCloseSpan) : 0;
  const capHi = c.drawCap[t] + Math.max(0, lc.draw) + lc.close;
  let drawPts = drawRaw + lc.draw + close;
  drawPts = drawPts < c.floorDraw ? c.floorDraw : drawPts > capHi ? capHi : drawPts;
  const gEff = (gap + (c.gapCube + lc.cube) * gap * gap * gap) * lc.stretch;
  const pH = 1 / (1 + Math.exp(-gEff / c.gapScale));
  const rest = 1000 - drawPts;
  let ptsH = rest * pH, ptsA = rest - ptsH;
  if (ptsA < c.floorOutsider) { ptsH -= c.floorOutsider - ptsA; ptsA = c.floorOutsider; }
  if (ptsH < c.floorOutsider) { ptsA -= c.floorOutsider - ptsH; ptsH = c.floorOutsider; }
  return [ptsH / 1000, (1000 - ptsH - ptsA) / 1000, ptsA / 1000];
}

/* ------------------------------------------------------------------ */
/* Scoring                                                              */
/* ------------------------------------------------------------------ */

interface Summary {
  n: number; logLoss: number; brier: number; hitRate: number; picks: { H: number; D: number; A: number };
  predDraw: number; realDraw: number; predHome: number; realHome: number;
  strong60: { n: number; hitRate: number }; strong70: { n: number; hitRate: number };
  double: { n: number; hitRate: number };
}
const idx = (o: Out) => (o === 'H' ? 0 : o === 'D' ? 1 : 2);

function summarize(items: Item[], pf: (it: Item) => [number, number, number] | null): Summary {
  let n = 0, ll = 0, br = 0, hit = 0, pd = 0, rd = 0, ph = 0, rh = 0, s60 = 0, h60 = 0, s70 = 0, h70 = 0, dbl = 0;
  const picks = { H: 0, D: 0, A: 0 };
  for (const it of items) {
    const p = pf(it);
    if (!p) continue;
    n++;
    const o = idx(it.o);
    ll += -Math.log(Math.max(1e-6, p[o]));
    br += (p[0] - (o === 0 ? 1 : 0)) ** 2 + (p[1] - (o === 1 ? 1 : 0)) ** 2 + (p[2] - (o === 2 ? 1 : 0)) ** 2;
    pd += p[1]; ph += p[0];
    if (o === 1) rd++;
    if (o === 0) rh++;
    const pick = p[0] >= p[1] && p[0] >= p[2] ? 0 : p[2] >= p[1] ? 2 : 1;
    picks[pick === 0 ? 'H' : pick === 1 ? 'D' : 'A']++;
    const won = pick === o;
    if (won) hit++;
    if (p[pick] >= 0.6) { s60++; if (won) h60++; }
    if (p[pick] >= 0.7) { s70++; if (won) h70++; }
    // double chance: the pick or the draw (or the two likeliest when the pick is the draw)
    const second = pick === 1 ? (p[0] >= p[2] ? 0 : 2) : 1;
    if (won || second === o) dbl++;
  }
  const r1 = (v: number) => Math.round(v * 10) / 10, r4 = (v: number) => Math.round(v * 10000) / 10000;
  const pct = (a: number, b: number) => r1((a / Math.max(1, b)) * 100);
  return {
    n, logLoss: r4(ll / Math.max(1, n)), brier: r4(br / Math.max(1, n)), hitRate: pct(hit, n), picks,
    predDraw: pct(pd, n), realDraw: pct(rd, n), predHome: pct(ph, n), realHome: pct(rh, n),
    strong60: { n: s60, hitRate: pct(h60, s60) }, strong70: { n: s70, hitRate: pct(h70, s70) }, double: { n, hitRate: pct(dbl, n) }
  };
}

/* ------------------------------------------------------------------ */
/* Reference: an unconstrained multinomial logit on the same inputs     */
/* ------------------------------------------------------------------ */

function features(it: Item): Float64Array {
  // 10 row differences, 3 draw rows, goals draw chance, 3 type flags, intercept
  const f = new Float64Array(NT + ND + 1 + 3 + 1);
  for (let i = 0; i < NT; i++) f[i] = it.d[i] / 5;
  for (let k = 0; k < ND; k++) f[NT + k] = (it.dv[k] - 5) / 3;
  f[NT + ND] = (it.pois - 0.26) * 10;
  if (it.type > 0) f[NT + ND + 1 + it.type - 1] = 1;
  f[NT + ND + 4] = 1;
  return f;
}
function fitLogit(items: Item[], epochs = 400): { W: Float64Array[]; dim: number } {
  const X = items.map(features);
  const dim = X[0]?.length || 1;
  const W = [new Float64Array(dim), new Float64Array(dim)]; // H and D vs A
  const m = [new Float64Array(dim), new Float64Array(dim)], v = [new Float64Array(dim), new Float64Array(dim)];
  const lr = 0.05, b1 = 0.9, b2 = 0.999, l2 = 1e-4;
  for (let ep = 1; ep <= epochs; ep++) {
    const g = [new Float64Array(dim), new Float64Array(dim)];
    for (let n = 0; n < X.length; n++) {
      const x = X[n];
      let zH = 0, zD = 0;
      for (let j = 0; j < dim; j++) { zH += W[0][j] * x[j]; zD += W[1][j] * x[j]; }
      const mx = Math.max(zH, zD, 0);
      const eH = Math.exp(zH - mx), eD = Math.exp(zD - mx), eA = Math.exp(-mx);
      const s = eH + eD + eA;
      const o = idx(items[n].o);
      const dH = eH / s - (o === 0 ? 1 : 0), dD = eD / s - (o === 1 ? 1 : 0);
      for (let j = 0; j < dim; j++) { g[0][j] += dH * x[j]; g[1][j] += dD * x[j]; }
    }
    for (let k = 0; k < 2; k++) for (let j = 0; j < dim; j++) {
      const gr = g[k][j] / X.length + l2 * W[k][j];
      m[k][j] = b1 * m[k][j] + (1 - b1) * gr;
      v[k][j] = b2 * v[k][j] + (1 - b2) * gr * gr;
      W[k][j] -= lr * (m[k][j] / (1 - Math.pow(b1, ep))) / (Math.sqrt(v[k][j] / (1 - Math.pow(b2, ep))) + 1e-8);
    }
  }
  return { W, dim };
}
function logitProbs(model: { W: Float64Array[] }, it: Item): [number, number, number] {
  const x = features(it);
  let zH = 0, zD = 0;
  for (let j = 0; j < x.length; j++) { zH += model.W[0][j] * x[j]; zD += model.W[1][j] * x[j]; }
  const mx = Math.max(zH, zD, 0);
  const eH = Math.exp(zH - mx), eD = Math.exp(zD - mx), eA = Math.exp(-mx), s = eH + eD + eA;
  return [eH / s, eD / s, eA / s];
}

/* ------------------------------------------------------------------ */
/* The fit                                                              */
/* ------------------------------------------------------------------ */

export interface TuneOptions {
  train: string[]; test: string[]; since?: string | null; rounds?: number; lambda?: number; shared?: boolean; lc?: boolean;
  obj?: 'll' | 'brier'; apply?: boolean; allDivs?: boolean; freeze?: string[]; only?: string[];
}

let tuning = false;
let lastTune: any = null;
export const tuneStatus = () => (tuning ? { running: true, progress: tuneProgress } : lastTune);
export const isTuning = () => tuning;

export async function tuneV3Full(opt: TuneOptions) {
  if (tuning) throw new Error('A tune is already running');
  tuning = true;
  const t0 = Date.now();
  try {
    const seasons = [...new Set([...opt.train, ...opt.test])];
    const items = await collect(seasons, !!opt.allDivs);
    const train = items.filter(i => opt.train.includes(i.season));
    const test = items.filter(i => opt.test.includes(i.season));
    const since = opt.since || recordingStart();
    const recorded = since ? items.filter(i => i.date >= since) : [];
    if (train.length < 500) throw new Error(`Too few training matches (${train.length})`);

    // league settings (fixed during the fit) — the live ones, or none
    const lcMap = new Map<string, LeagueConv>();
    if (opt.lc !== false) for (const l of leagueConvStatus()) lcMap.set(l.division, { ...LC0, ...l.conf });
    const lcOf = (it: Item) => lcMap.get(it.div) || LC0;

    const shared = !!opt.shared;
    const defs = paramDefs(shared);
    const x0 = startVector(defs, shared);
    const free = defs.map((p, i) => {
      if (opt.only?.length) return opt.only.some(o => p.name === o || p.name.startsWith(o + '.') || p.group === o);
      if (opt.freeze?.length) return !opt.freeze.some(o => p.name === o || p.name.startsWith(o + '.') || p.group === o);
      return i >= 0;
    });
    const lambda = opt.lambda || 0;
    const useBrier = opt.obj === 'brier';

    const fit = await fitVector(train, defs, x0, free, { lambda, useBrier, lcOf, rounds: opt.rounds ?? 80, shared });
    const x = fit.x, f = fit.f, f0 = fit.f0, trail = fit.trail, rounds = fit.rounds;

    const cLive = compile(defs, x0, shared), cFit = compile(defs, x, shared);
    // reference: free multinomial logit on the same inputs (fit on train)
    tuneProgress = { stage: 'reference logit', done: rounds, total: rounds };
    const logit = fitLogit(train);

    const report = (set: Item[]) => ({
      live: summarize(set, it => probs(cLive, it, lcOf(it))),
      fitted: summarize(set, it => probs(cFit, it, lcOf(it))),
      freeLogit: summarize(set, it => logitProbs(logit, it)),
      market: summarize(set, it => it.mkt ? [it.mkt.H, it.mkt.D, it.mkt.A] : null)
    });
    const byDivision = (set: Item[]) => {
      const divs = [...new Set(set.map(i => i.div))].sort();
      return divs.map(d => {
        const s = set.filter(i => i.div === d);
        const a = summarize(s, it => probs(cLive, it, lcOf(it))), b = summarize(s, it => probs(cFit, it, lcOf(it)));
        return { division: d, n: s.length, live: { logLoss: a.logLoss, hitRate: a.hitRate }, fitted: { logLoss: b.logLoss, hitRate: b.hitRate }, dLogLoss: Math.round((b.logLoss - a.logLoss) * 10000) / 10000 };
      });
    };

    const { rel, conv } = unpack(defs, x, shared);
    const changes = defs.map((p, i) => ({ name: p.name, from: Math.round(x0[i] * 1000) / 1000, to: Math.round(x[i] * 1000) / 1000 })).filter(c => c.from !== c.to);
    const out = {
      options: { ...opt, since, shared, lambda, rounds, obj: useBrier ? 'brier' : 'logLoss', params: defs.length, free: free.filter(Boolean).length },
      sizes: { train: train.length, test: test.length, recorded: recorded.length },
      objective: { start: Math.round(f0 * 1e6) / 1e6, end: Math.round(f * 1e6) / 1e6, trail },
      train: report(train),
      test: report(test),
      recorded: recorded.length ? report(recorded) : null,
      testByDivision: byDivision(test),
      recordedByDivision: recorded.length ? byDivision(recorded) : null,
      changes,
      setting: { rel, conv },
      ms: Date.now() - t0
    };
    if (opt.apply) {
      storeTuning(rel, conv, { options: out.options, sizes: out.sizes, test: out.test, recorded: out.recorded });
      (out as any).applied = 'stored — GET /api/model/v3/tuned?reload=1 puts it live';
    }
    lastTune = { running: false, ...out };
    return out;
  } finally {
    tuning = false;
    tuneProgress = null;
  }
}

/** Pattern search: try each free parameter up and down, keep improvements, halve the steps when a round finds none. */
async function fitVector(train: Item[], defs: ParamDef[], x0: Float64Array, free: boolean[],
  o: { lambda: number; useBrier: boolean; lcOf: (it: Item) => LeagueConv; rounds: number; shared: boolean }) {
  const objective = (x: Float64Array): number => {
    const c = compile(defs, x, o.shared);
    let s = 0;
    for (const it of train) {
      const p = probs(c, it, o.lcOf(it));
      const oi = idx(it.o);
      if (o.useBrier) s += (p[0] - (oi === 0 ? 1 : 0)) ** 2 + (p[1] - (oi === 1 ? 1 : 0)) ** 2 + (p[2] - (oi === 2 ? 1 : 0)) ** 2;
      else s += -Math.log(Math.max(1e-6, p[oi]));
    }
    s /= train.length;
    if (o.lambda) for (let i = 0; i < x.length; i++) s += o.lambda * ((x[i] - x0[i]) / (defs[i].step * 4)) ** 2;
    return s;
  };
  const x = Float64Array.from(x0);
  const steps = defs.map(p => p.step * 2);
  let f = objective(x);
  const f0 = f;
  const trail: { round: number; obj: number; stepScale: number }[] = [];
  let halvings = 0, round = 0;
  // fix194: a round tries every parameter (each try = one pass over the training games): the thread is given back every
  // ~30 ms, not once a round (the 04:00 daily job froze the server 1.2–1.8 s at a time on 20 Oct)
  const slice = slicer();
  for (round = 1; round <= o.rounds; round++) {
    tuneProgress = { stage: `fitting round ${round} (obj ${f.toFixed(5)})`, done: round, total: o.rounds };
    let improved = false;
    for (let i = 0; i < defs.length; i++) {
      if (!free[i]) continue;
      for (const dir of [1, -1]) {
        const old = x[i];
        const nv = Math.min(defs[i].hi, Math.max(defs[i].lo, old + dir * steps[i]));
        if (nv === old) continue;
        x[i] = nv;
        const fn = objective(x);
        await slice();
        if (fn < f - 1e-9) { f = fn; improved = true; break; }
        x[i] = old;
      }
    }
    trail.push({ round, obj: Math.round(f * 1e6) / 1e6, stepScale: Math.pow(0.5, halvings) });
    if (!improved) {
      halvings++;
      for (let i = 0; i < steps.length; i++) steps[i] /= 2;
      if (halvings >= 4) break;
    }
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
  return { x, f, f0, trail, rounds: round };
}

/* ------------------------------------------------------------------ */
/* Window runs for the daily champion / challenger job (modelDaily.ts)  */
/* ------------------------------------------------------------------ */

export interface WindowItem { div: string; date: string; home: string; away: string; o: Out; mkt: [number, number, number] | null }
export interface WindowRun {
  items: WindowItem[];                       // games on or after scoreFrom (walk-forward state, like the backtest)
  live: [number, number, number][];          // the live setting's probabilities for those games
  fits: Record<string, { probs: [number, number, number][]; x: number[]; setting: { rel: any; conv: any }; train: number }>;
  vectors: Record<string, [number, number, number][]>; // probabilities from stored vectors (previous champions)
}

/**
 * Collect the replayed rows once, then: the live setting's probabilities for every game from `scoreFrom`, plus one
 * refit per entry of `fits` trained only on games before its `trainBefore` date (so the games it is scored on were
 * never seen). `vectors`: probabilities from stored parameter vectors (a previous champion, for the guardrail).
 */
export async function v3WindowRun(opt: { seasons: string[]; scoreFrom: string; fits: { label: string; trainBefore: string; trainFrom?: string }[]; vectors?: Record<string, number[]>; rounds?: number }): Promise<WindowRun> {
  if (tuning) throw new Error('A tune is already running');
  tuning = true;
  try {
    const items = await collect(opt.seasons, false);
    const lcMap = new Map<string, LeagueConv>();
    for (const l of leagueConvStatus()) lcMap.set(l.division, { ...LC0, ...l.conf });
    const lcOf = (it: Item) => lcMap.get(it.div) || LC0;
    const defs = paramDefs(false);
    const x0 = startVector(defs, false);
    const cLive = compile(defs, x0, false);
    const scored = items.filter(i => i.date >= opt.scoreFrom);
    const out: WindowRun = {
      items: scored.map(i => ({ div: i.div, date: i.date, home: i.home, away: i.away, o: i.o, mkt: i.mkt ? [i.mkt.H, i.mkt.D, i.mkt.A] : null })),
      live: await inBatches(scored, 200, b => b.map(i => probs(cLive, i, lcOf(i)))), // fix169: in slices
      fits: {}, vectors: {}
    };
    for (const f of opt.fits) {
      const train = items.filter(i => i.date < f.trainBefore && (!f.trainFrom || i.date >= f.trainFrom));
      if (train.length < 500) continue;
      const fit = await fitVector(train, defs, x0, defs.map(() => true), { lambda: 0, useBrier: false, lcOf, rounds: opt.rounds ?? 60, shared: false });
      const c = compile(defs, fit.x, false);
      out.fits[f.label] = { probs: await inBatches(scored, 200, b => b.map(i => probs(c, i, lcOf(i)))), x: Array.from(fit.x), setting: unpack(defs, fit.x, false), train: train.length };
    }
    for (const [label, v] of Object.entries(opt.vectors || {})) {
      if (v.length !== defs.length) continue;
      const c = compile(defs, Float64Array.from(v), false);
      out.vectors[label] = await inBatches(scored, 200, b => b.map(i => probs(c, i, lcOf(i))));
    }
    return out;
  } finally {
    tuning = false;
    tuneProgress = null;
  }
}

/** The live setting as a stored vector (for rolling back to it later). */
export function liveVector(): number[] { return Array.from(startVector(paramDefs(false), false)); }
/** Put a stored vector live (stored in v3_tuned, then applied). */
export function applyVector(x: number[], report: any) {
  const defs = paramDefs(false);
  const { rel, conv } = unpack(defs, Float64Array.from(x), false);
  storeTuning(rel, conv, report);
}

/** Date of the first tracked v3 prediction (the site started recording its predictions then). */
function recordingStart(): string | null {
  try {
    // first prediction saved before kick-off by the live site (backfilled rows are copies made later)
    const r: any = db.prepare(`SELECT MIN(utc_date) AS d FROM predictions WHERE model = 'grid-v3' AND locked = 1 AND COALESCE(backfilled, 0) = 0`).get();
    return r?.d ? String(r.d).slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Test hook: the live setting's probabilities for one item (checks that probs() reproduces scoreMatch). */
export const __test = {
  probsLive(it: Item) { const defs = paramDefs(false); return probs(compile(defs, startVector(defs, false), false), it, LC0); },
  probsOf(x: Float64Array, it: Item) { const defs = paramDefs(false); return probs(compile(defs, x, false), it, LC0); },
  defs: () => paramDefs(false), start: () => startVector(paramDefs(false), false),
  fit: (train: Item[], rounds: number) => { const defs = paramDefs(false); return fitVector(train, defs, startVector(defs, false), defs.map(() => true), { lambda: 0, useBrier: false, lcOf: () => LC0, rounds, shared: false }); },
  summarize
};

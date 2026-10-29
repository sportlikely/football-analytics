/**
 * National-team Elo ("elo-intl") — predictions for friendlies, Nations League and qualifiers.
 *
 * Ratings: every senior men's international result since 2014 from API-Football (World Cup, Euro, Copa América,
 * AFCON, Asian Cup, Gold Cup, qualifiers, Nations League, friendlies). World-Football-Elo style:
 *   K by importance (finals 60 / continental finals 50 / qualifiers & Nations League 40 / friendlies 20),
 *   goal-difference multiplier, home advantage (none at tournament finals, reduced in friendlies).
 * Percentages: ordered logistic on the rating gap, P(H) = σ((d − c)/s), P(A) = σ((−d − c)/s), draw = the rest,
 * with c and s fitted by maximum likelihood on walk-forward (pre-match) ratings.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { afGet, afConfigured } from './apiFootball';
import { Prediction } from './predictionModel';
import { Meetings, commonSense, type H2H } from './h2hGuard';
import { nationalValueFor } from './squadValues';
import { runSteps, runStepsAsync, afterHeavy, everyHeavy } from './perf';
import { onState, publishState } from './shared';
import { keepSign } from '../utils/whyFactors';
import { threadJobsOn, inThread } from './threadJob';

export const MODEL_ELO = 'elo-intl';
const AF_OFFSET = 1_000_000_000;

/** API-Football league id → [K, home advantage]. */
export const COMPS: Record<number, { k: number; ha: number; name: string }> = {
  1: { k: 60, ha: 0, name: 'World Cup' },
  4: { k: 50, ha: 0, name: 'Euro' },
  9: { k: 50, ha: 0, name: 'Copa America' },
  6: { k: 50, ha: 0, name: 'Africa Cup of Nations' },
  7: { k: 50, ha: 0, name: 'Asian Cup' },
  22: { k: 45, ha: 0, name: 'Gold Cup' },
  5: { k: 40, ha: 90, name: 'UEFA Nations League' },
  32: { k: 40, ha: 90, name: 'WC qualification Europe' },
  34: { k: 40, ha: 90, name: 'WC qualification South America' },
  29: { k: 40, ha: 90, name: 'WC qualification Africa' },
  30: { k: 40, ha: 90, name: 'WC qualification Asia' },
  31: { k: 40, ha: 90, name: 'WC qualification CONCACAF' },
  960: { k: 40, ha: 90, name: 'Euro qualification' },
  36: { k: 40, ha: 90, name: 'AFCON qualification' },
  536: { k: 35, ha: 90, name: 'CONCACAF Nations League' },
  35: { k: 40, ha: 90, name: 'Asian Cup qualification' },
  10: { k: 20, ha: 50, name: 'Friendlies' }
};
const FIRST_SEASON = 2014;
const YOUTH = /\bU-?(1[5-9]|2[0-3])\b|\bUnder[- ]?\d{2}\b|\b(W|Women)$/i;

db.exec(`
  CREATE TABLE IF NOT EXISTS nat_matches (
    fixture_id INTEGER PRIMARY KEY, league_id INTEGER NOT NULL, date TEXT NOT NULL,
    home_id INTEGER NOT NULL, away_id INTEGER NOT NULL, home_name TEXT, away_name TEXT, hg INTEGER, ag INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_nat_date ON nat_matches(date);
  CREATE TABLE IF NOT EXISTS nat_sync (key TEXT PRIMARY KEY, done_at TEXT NOT NULL, n INTEGER);
`);

/* ------------------------------------------------------------------ */
/* Data                                                                 */
/* ------------------------------------------------------------------ */

async function syncLeagueSeason(leagueId: number, season: number) {
  const j = await afGet('/fixtures', { league: leagueId, season });
  const ins = db.prepare(`INSERT OR REPLACE INTO nat_matches (fixture_id, league_id, date, home_id, away_id, home_name, away_name, hg, ag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const f of j.response || []) {
      if (!['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short)) continue;
      const h = f.teams?.home, a = f.teams?.away;
      if (!h?.id || !a?.id || YOUTH.test(h.name || '') || YOUTH.test(a.name || '')) continue;
      // score after 90/120 minutes (penalty shoot-outs count as a draw)
      const hg = f.goals?.home ?? f.score?.fulltime?.home;
      const ag = f.goals?.away ?? f.score?.fulltime?.away;
      if (hg === null || hg === undefined || ag === null || ag === undefined) continue;
      ins.run(f.fixture.id, leagueId, String(f.fixture.date).slice(0, 10), h.id, a.id, h.name, a.name, hg, ag);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.prepare(`INSERT OR REPLACE INTO nat_sync (key, done_at, n) VALUES (?, ?, ?)`).run(`${leagueId}|${season}`, new Date().toISOString(), n);
  return n;
}

/** Past seasons once, the current and previous year every 12 h. */
export async function syncNationalHistory(force = false) {
  if (!afConfigured()) return { requests: 0, matches: 0 };
  const year = new Date().getUTCFullYear();
  let requests = 0, matches = 0;
  for (const id of Object.keys(COMPS).map(Number)) {
    for (let s = FIRST_SEASON; s <= year; s++) {
      const key = `${id}|${s}`;
      const row: any = db.prepare(`SELECT done_at FROM nat_sync WHERE key = ?`).get(key);
      const recent = s >= year - 1;
      if (!force && row && (!recent || Date.now() - new Date(row.done_at).getTime() < 12 * 3600 * 1000)) continue;
      try {
        matches += await syncLeagueSeason(id, s);
        requests++;
      } catch (e: any) {
        logger.warn(`national history ${key}: ${e.message}`);
      }
    }
  }
  return { requests, matches };
}

/* ------------------------------------------------------------------ */
/* Ratings + fit                                                        */
/* ------------------------------------------------------------------ */

type TeamState = {
  elo: number; name: string; n: number; last: string;
  att: number; def: number; // goal ratings (log scale): attack adds to own goals, defence subtracts from the opponent's
  recent: number[]; // last 6: actual − expected result (Elo), +ve = better than rated
};
const ratings = new Map<number, TeamState>();
let fit = { c: 60, s: 110, beta: 0 }; // Elo-only engine: ordered-logit parameters (Elo points); beta = Elo points per ln(value ratio)
let lastBuilt: string | null = null;
let evalStats: any = null;

const sig = (x: number) => 1 / (1 + Math.exp(-x));
function probs(d: number, c = fit.c, s = fit.s) {
  const h = sig((d - c) / s), a = sig((-d - c) / s);
  const dr = Math.max(0.03, 1 - h - a);
  const t = h + a + dr;
  return { h: h / t, d: dr / t, a: a / t };
}
function gdMult(gd: number) {
  const g = Math.abs(gd);
  return g <= 1 ? 1 : g === 2 ? 1.5 : (11 + g) / 8;
}

/* ------------------------------------------------------------------ */
/* v3 national grid: several pre-match factors, weights fitted on history */
/* ------------------------------------------------------------------ */
/*
 * Rows (each a difference home − away, all known before kick-off):
 *   strength  – Elo gap (+ competition home advantage)
 *   squad     – ln(squad value ratio), players by nationality (Transfermarkt snapshot)
 *   goals     – ln(expected goals ratio) from attack / defence goal ratings (opponent-adjusted)
 *   form      – last 6 games: results above / below what the ratings expected
 *   rest      – days since each side's last international (capped), short turnarounds hurt
 *   home      – playing at home in a competitive game / in a friendly
 * Ordered logit: z = Σ w·row;  friendlies scale z by m (rotated squads = less predictable);
 * draw threshold c by match type (finals / competitive / friendly) + g × (Poisson draw chance − 0.27).
 * Weights are fitted by maximum likelihood on 2018 → two years ago and judged on the last two years
 * against the Elo-only engine; the live engine is whichever scores better there.
 */
type Kind = 'finals' | 'competitive' | 'friendly';
const kindOf = (leagueId: number): Kind => {
  const cfg = COMPS[leagueId] || COMPS[10];
  return cfg.k <= 20 ? 'friendly' : cfg.ha === 0 ? 'finals' : 'competitive';
};
interface Feat { dElo: number; lv: number; gl: number; form: number; rest: number; homeComp: number; homeFriendly: number; pDraw: number; kind: Kind; lamH: number; lamA: number; h2h: number; h2hInfo: H2H | null }
// head-to-head (Oct 2026): past meetings since 2014, used as a fitted row and by the common-sense check
const meetings = new Meetings();
let h2hUsed = true;
let guardOpt = { on: false, formT: 0.3, h2hT: 0.2, margin: 0.02 };
const GW = ['w_elo', 'w_squad', 'w_goals', 'w_form', 'w_rest', 'w_homeComp', 'w_homeFriendly', 'm_friendly', 'c_finals', 'c_comp', 'c_friendly', 'g_draw', 'w_h2h'] as const;
type GridW = Record<(typeof GW)[number], number>;
const GRID0: GridW = { w_elo: 0.6, w_squad: 0.3, w_goals: 0.3, w_form: 0, w_rest: 0, w_homeComp: 0.3, w_homeFriendly: 0.15, m_friendly: 0.9, c_finals: 0.6, c_comp: 0.6, c_friendly: 0.6, g_draw: 0, w_h2h: 0 };
let gridW: GridW = { ...GRID0 };
let engine: 'grid' | 'elo' = 'elo';

const MU = Math.log(1.3); // average international goals per team per game (log)
/*
 * Settings of the rating engine itself (not fitted by the ordered logit): how fast goal ratings learn in competitive
 * games / friendlies, the home effect on goals, and a multiplier on Elo K. Defaults below; /api/model/elo/tune tries
 * variants and keeps a set only when it scores better on the last-2-years test (saved in nat_params).
 */
const NP_DEFAULT = { etaComp: 0.045, etaFriendly: 0.025, homeG: 0.18, kScale: 1 };
type NatParams = typeof NP_DEFAULT;
db.exec(`CREATE TABLE IF NOT EXISTS nat_params (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, at TEXT NOT NULL)`);
let NP: NatParams = (() => {
  try { const r: any = db.prepare(`SELECT json FROM nat_params WHERE id = 1`).get(); return r ? { ...NP_DEFAULT, ...JSON.parse(r.json) } : { ...NP_DEFAULT }; } catch { return { ...NP_DEFAULT }; }
})();
function poissonDraw(lh: number, la: number) {
  let d = 0, ph = Math.exp(-lh), pa = Math.exp(-la);
  for (let k = 0; k <= 10; k++) { d += ph * pa; ph *= lh / (k + 1); pa *= la / (k + 1); }
  return d;
}
function lambdas(H: TeamState, A: TeamState, neutral: boolean) {
  const h = neutral ? 0 : NP.homeG;
  return { lamH: Math.exp(MU + H.att - A.def + h), lamA: Math.exp(MU + A.att - H.def) };
}
function featOf(H: TeamState, A: TeamState, leagueId: number, date: string, vh: number | null, va: number | null, hid = 0, aid = 0): Feat {
  const cfg = COMPS[leagueId] || COMPS[10];
  const kind = kindOf(leagueId);
  const neutral = cfg.ha === 0;
  const { lamH, lamA } = lambdas(H, A, neutral);
  const noHome = lambdas(H, A, true);
  const days = (x: string) => (x ? Math.min(30, (new Date(date).getTime() - new Date(x).getTime()) / 86400000) : 30);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return {
    dElo: (H.elo - A.elo) / 100,
    lv: vh && va ? Math.log(vh / va) : 0,
    gl: Math.log(noHome.lamH / noHome.lamA),
    form: avg(H.recent) - avg(A.recent),
    rest: (Math.min(days(H.last), 10) - Math.min(days(A.last), 10)) / 10,
    homeComp: !neutral && kind !== 'friendly' ? 1 : 0,
    homeFriendly: !neutral && kind === 'friendly' ? 1 : 0,
    pDraw: poissonDraw(lamH, lamA),
    kind, lamH, lamA,
    ...(() => { const h = hid && aid ? meetings.get(hid, aid, date) : null; return { h2h: h ? h.x : 0, h2hInfo: h }; })()
  };
}
function gridProbs(f: Feat, w: GridW = gridW) {
  let z = w.w_elo * f.dElo + w.w_squad * f.lv + w.w_goals * f.gl + w.w_form * f.form + w.w_rest * f.rest + w.w_homeComp * f.homeComp + w.w_homeFriendly * f.homeFriendly + (w.w_h2h || 0) * f.h2h;
  if (f.kind === 'friendly') z *= w.m_friendly;
  const c = Math.max(0.05, (f.kind === 'finals' ? w.c_finals : f.kind === 'friendly' ? w.c_friendly : w.c_comp) + w.g_draw * (f.pDraw - 0.27));
  const h = sig(z - c), a = sig(-z - c);
  const dr = Math.max(0.03, 1 - h - a);
  const t = h + a + dr;
  return { h: h / t, d: dr / t, a: a / t, z };
}
function nll(xs: { f: Feat; o: 'H' | 'D' | 'A' }[], w: GridW) {
  let ll = 0;
  for (const x of xs) { const p = gridProbs(x.f, w); ll -= Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a)); }
  return ll / Math.max(1, xs.length);
}
/**
 * Pattern search (coordinate steps that only ever lower the log loss, step halves when nothing improves).
 * Starts from the Elo-only fit, so the grid can only end up at least as good as Elo on the training data.
 */
const fitGrid = (xs: { f: Feat; o: 'H' | 'D' | 'A' }[], start: GridW, fixed: string[] = []): GridW => runSteps(fitGridSteps(xs, start, fixed));
/** fix167: the fit as steps (a yield after each weight tried), so the scheduled rebuild gives the thread back. */
function* fitGridSteps(xs: { f: Feat; o: 'H' | 'D' | 'A' }[], start: GridW, fixed: string[] = []): Generator<unknown, GridW> {
  const w: any = Object.fromEntries(Object.entries(start).map(([k, v]) => [k, keepSign(k, v as number)]));
  let best = nll(xs, w);
  let step = 0.2;
  for (let pass = 0; pass < 80 && step > 0.002; pass++) {
    let improved = false;
    for (const k of GW) {
      if (fixed.includes(k)) continue;
      for (const dir of [1, -1]) {
        const old = w[k];
        w[k] = keepSign(k, old + dir * step); // fix282: a "more is better" factor never gets a negative weight
        if (k === 'm_friendly') w[k] = Math.min(1.5, Math.max(0.3, w[k]));
        if (k.startsWith('c_')) w[k] = Math.max(0.05, w[k]);
        if (w[k] === old) continue;
        const v = nll(xs, w);
        yield;
        if (v < best - 1e-7) { best = v; improved = true; break; }
        w[k] = old;
      }
    }
    if (!improved) step /= 2;
  }
  return w;
}
/** Grid starting point equivalent to the Elo-only engine (c, s in Elo points; beta per ln value ratio). */
const gridFromElo = (e: { c: number; s: number; beta: number }): GridW => ({
  ...GRID0, w_elo: 100 / e.s, w_squad: e.beta / e.s, w_goals: 0, w_form: 0, w_rest: 0,
  w_homeComp: 90 / e.s, w_homeFriendly: 50 / e.s, m_friendly: 1, c_finals: e.c / e.s, c_comp: e.c / e.s, c_friendly: e.c / e.s, g_draw: 0, w_h2h: 0
});
/** The factors' verdict without home advantage (> 0 favours the home side). */
const factorsOf = (f: Feat, w: GridW) => w.w_elo * f.dElo + w.w_squad * f.lv + w.w_goals * f.gl + w.w_form * f.form + w.w_rest * f.rest + (w.w_h2h || 0) * f.h2h;

let lastSplit: { trainOld: any[]; test: any[]; gridOld: GridW; eloOld: { c: number; s: number; beta: number }; score: (pf: (x: any) => { h: number; d: number; a: number }) => any } | null = null;

/**
 * How much should the goals row (#19, attack vs defence) count? Scores the last-2-years test set with its weight
 * at 0 / 25 / 50 / 75 / 100 / 125 % of the fitted value: "as is" (other weights unchanged) and "refit" (the other
 * weights re-fitted on the training years with the goals weight held at that level).
 */
/**
 * Expected goals scale for national-team matches (both sides × this). 1 = as fitted. Set from the goals calibration
 * test (services/goalsCalibration.ts); NAT_GOAL_SCALE on Railway overrides it for a trial.
 */
export let NAT_GOAL_SCALE = parseFloat(process.env.NAT_GOAL_SCALE || '1') || 1;
export function setNatGoalScale(k: number) { NAT_GOAL_SCALE = k; }
/*
 * Goal scale per match type, fitted on the last two years every rebuild (friendlies, qualifiers / Nations League,
 * tournament finals score differently: finals were predicted ~13% too low). Only used when NAT_GOAL_SCALE is not set,
 * and only for a type with 150+ test matches. Affects goal markets and likely scores, not the 1-X-2.
 */
let natGoalByKind: Record<Kind, number> = { friendly: 1, competitive: 1, finals: 1 };
function fitGoalScales(test: { f: Feat; hg: number; ag: number }[]) {
  const out: Record<Kind, number> = { friendly: 1, competitive: 1, finals: 1 };
  const ll = (p: number, y: boolean) => -Math.log(Math.max(1e-6, y ? p : 1 - p));
  for (const kind of ['friendly', 'competitive', 'finals'] as Kind[]) {
    const xs = test.filter(x => x.f.kind === kind);
    if (xs.length < 150) continue;
    let best = { k: 1, l: Infinity };
    for (let k = 0.8; k <= 1.401; k += 0.05) {
      let l = 0;
      for (const x of xs) {
        const lh = Math.min(4, Math.max(0.2, x.f.lamH)) * k, la = Math.min(4, Math.max(0.2, x.f.lamA)) * k, lam = lh + la, e = Math.exp(-lam);
        const t = x.hg + x.ag;
        l += ll(1 - e * (1 + lam + lam * lam / 2), t > 2.5) + ll(1 - e * (1 + lam), t > 1.5) + ll((1 - Math.exp(-lh)) * (1 - Math.exp(-la)), x.hg > 0 && x.ag > 0);
      }
      if (l < best.l) best = { k: Math.round(k * 100) / 100, l };
    }
    out[kind] = best.k;
  }
  return out;
}
const goalScaleFor = (kind: Kind) => (process.env.NAT_GOAL_SCALE ? NAT_GOAL_SCALE : natGoalByKind[kind] || 1);

/** The last two years of national-team matches with the goal rates the model had before each one (for calibration). */
export function nationalGoalsTestSet() {
  if (!lastSplit) buildNationalElo();
  return lastSplit!.test.map((x: any) => ({
    lh: Math.min(4, Math.max(0.2, x.f.lamH)), la: Math.min(4, Math.max(0.2, x.f.lamA)), hg: x.hg, ag: x.ag, kind: x.f.kind as string
  }));
}

export function nationalGoalsSensitivity() {
  if (!lastSplit) buildNationalElo();
  const s = lastSplit!;
  const base = s.gridOld.w_goals;
  const out: any[] = [];
  for (const m of [0, 0.25, 0.5, 0.75, 1, 1.25]) {
    const asIs = { ...s.gridOld, w_goals: base * m };
    const refit = m === 1 ? s.gridOld : fitGrid(s.trainOld, asIs, ['w_goals']);
    out.push({ share: m, goalsWeight: Math.round(base * m * 1000) / 1000, asIs: s.score(x => gridProbs(x.f, asIs)), refit: s.score(x => gridProbs(x.f, refit)) });
  }
  return { testMatches: s.test.length, fittedGoalsWeight: Math.round(base * 1000) / 1000, results: out };
}

/** The whole build at once (admin rebuild, tuning trials). */
export const buildNationalElo = () => runSteps(buildSteps());
/**
 * fix167: the scheduled rebuild in slices of 40 ms (it blocked 9.5 s on a copy of the database: the parameter fits).
 * The ratings are rebuilt in one go as before; the fitted settings are swapped in together at the end.
 */
let building: Promise<unknown> | null = null;
export function buildNationalEloAsync() {
  // fix210: in a worker thread (its state comes back through the onState below, as in the web process)
  if (!building) building = (threadJobsOn() ? inThread('national elo') : runStepsAsync(buildSteps())).finally(() => { building = null; });
  return building;
}
/** fix210 (job thread): the whole build at once — the thread is its own */
export const buildNationalEloHere = () => buildNationalElo();
function* buildSteps(): Generator<unknown, { matches: number; teams: number; engine: 'grid' | 'elo' }> {
  const rows = db.prepare(`SELECT * FROM nat_matches ORDER BY date, fixture_id`).all() as any[];
  ratings.clear();
  meetings.clear();
  const pre: { d: number; lv: number; o: 'H' | 'D' | 'A'; date: string; f: Feat; hg: number; ag: number; league: number }[] = [];
  const valueCache = new Map<number, number | null>();
  const valueOf = (id: number, name: string) => {
    if (!valueCache.has(id)) valueCache.set(id, nationalValueFor(name));
    return valueCache.get(id)!;
  };
  const get = (id: number, name: string) =>
    ratings.get(id) || ratings.set(id, { elo: 1500, name, n: 0, last: '', att: 0, def: 0, recent: [] }).get(id)!;
  for (const r of rows) {
    const cfg = COMPS[r.league_id] || COMPS[10];
    const H = get(r.home_id, r.home_name), A = get(r.away_id, r.away_name);
    const d = H.elo - A.elo + cfg.ha;
    const o = r.hg > r.ag ? 'H' : r.hg < r.ag ? 'A' : 'D';
    const vh = valueOf(r.home_id, r.home_name), va = valueOf(r.away_id, r.away_name);
    if (H.n >= 10 && A.n >= 10) pre.push({ d, lv: vh && va ? Math.log(vh / va) : 0, o, date: r.date, f: featOf(H, A, r.league_id, r.date, vh, va, r.home_id, r.away_id), hg: r.hg, ag: r.ag, league: r.league_id });
    // Elo
    const we = 1 / (1 + Math.pow(10, -d / 400));
    const w = o === 'H' ? 1 : o === 'D' ? 0.5 : 0;
    const delta = cfg.k * NP.kScale * gdMult(r.hg - r.ag) * (w - we);
    H.elo += delta; A.elo -= delta;
    // form: result above / below the rating's expectation
    H.recent.push(w - we); A.recent.push(we - w);
    if (H.recent.length > 6) H.recent.shift();
    if (A.recent.length > 6) A.recent.shift();
    // goal ratings (online Poisson), smaller steps for friendlies
    const { lamH, lamA } = lambdas(H, A, cfg.ha === 0);
    const eta = kindOf(r.league_id) === 'friendly' ? NP.etaFriendly : NP.etaComp;
    const eh = Math.max(-3, Math.min(3, r.hg - lamH)), ea = Math.max(-3, Math.min(3, r.ag - lamA));
    H.att += eta * eh; A.def -= eta * eh;
    A.att += eta * ea; H.def -= eta * ea;
    H.n++; A.n++; H.last = r.date; A.last = r.date;
    meetings.add(r.home_id, r.away_id, r.date, w);
  }
  // Elo-only engine: fit c, s (and beta for the squad-value term) on matches from 2018
  const twoYears = new Date(Date.now() - 2 * 365 * 86400000).toISOString().slice(0, 10);
  const trainAll = pre.filter(x => x.date >= '2018-01-01');
  const trainOld = trainAll.filter(x => x.date < twoYears);
  const test = pre.filter(x => x.date >= twoYears);
  const llOf = (xs: typeof pre, c: number, s: number, beta: number) => {
    let ll = 0;
    for (const x of xs) { const p = probs(x.d + beta * x.lv, c, s); ll -= Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a)); }
    return ll;
  };
  function* fitElo(xs: typeof pre, betas: number[]) {
    let best = { ll: Infinity, c: 60, s: 110, beta: 0 };
    for (const beta of betas)
      for (let c = 0; c <= 300; c += 10) {
        for (let s = 60; s <= 400; s += 10) {
          const ll = llOf(xs, c, s, beta);
          if (ll < best.ll) best = { ll, c, s, beta };
        }
        yield; // fix167: a safe point every 35 settings
      }
    return best;
  }
  const BETAS = [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350];
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const score = (pf: (x: (typeof pre)[number]) => { h: number; d: number; a: number }) => {
    let brier = 0, ll = 0, hits = 0, pd = 0, rd = 0;
    const part = new Map<string, { n: number; hits: number; ll: number }>();
    const add = (k: string, hit: boolean, l: number) => { const g = part.get(k) || { n: 0, hits: 0, ll: 0 }; g.n++; if (hit) g.hits++; g.ll += l; part.set(k, g); };
    for (const x of test) {
      const p = pf(x);
      brier += (p.h - (x.o === 'H' ? 1 : 0)) ** 2 + (p.d - (x.o === 'D' ? 1 : 0)) ** 2 + (p.a - (x.o === 'A' ? 1 : 0)) ** 2;
      ll -= Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a));
      const pick = p.h >= p.d && p.h >= p.a ? 'H' : p.a >= p.d ? 'A' : 'D';
      if (pick === x.o) hits++;
      const l1 = -Math.log(Math.max(1e-6, x.o === 'H' ? p.h : x.o === 'D' ? p.d : p.a));
      add(x.f.kind, pick === x.o, l1);
      if (x.league === 5) add('nationsLeague', pick === x.o, l1);
      pd += p.d;
      if (x.o === 'D') rd++;
    }
    const n = Math.max(1, test.length);
    const byKind = Object.fromEntries([...part.entries()].map(([k, g]) => [k, { n: g.n, hitRate: Math.round((g.hits / g.n) * 1000) / 10, logLoss: r3(g.ll / g.n) }]));
    return { brier: r3(brier / n), logLoss: r3(ll / n), hitRate: Math.round((hits / n) * 1000) / 10, predDraw: Math.round((pd / n) * 1000) / 10, realDraw: Math.round((rd / n) * 1000) / 10, byKind };
  };
  // honest comparison: both engines fitted on 2018 → two years ago, scored on the last two years
  // fix167: the new settings are kept in locals and swapped in together at the end (the steps may be spread over turns)
  const eloOld = yield* fitElo(trainOld, BETAS);
  // head-to-head row: fitted with and without it, kept only if it does not make the test worse
  const gridNoH2H = yield* fitGridSteps(trainOld, gridFromElo(eloOld), ['w_h2h']);
  const gridWithH2H = yield* fitGridSteps(trainOld, gridFromElo(eloOld));
  const testNoH2H = score(x => gridProbs(x.f, gridNoH2H)), testWithH2H = score(x => gridProbs(x.f, gridWithH2H));
  yield;
  const useH2H = testWithH2H.logLoss <= testNoH2H.logLoss + 0.0005 && (gridWithH2H.w_h2h || 0) > 0; // a negative H2H weight is noise, not a pattern
  const gridOld = useH2H ? gridWithH2H : gridNoH2H;
  const eloTest = score(x => probs(x.d + eloOld.beta * x.lv, eloOld.c, eloOld.s));
  const split = { trainOld, test, gridOld, eloOld, score };
  const gridTest = score(x => gridProbs(x.f, gridOld));
  yield;
  const eng: 'grid' | 'elo' = test.length >= 300 && gridTest.logLoss < eloTest.logLoss ? 'grid' : 'elo';
  // live parameters: refit on everything since 2018
  const eloAll = yield* fitElo(trainAll, BETAS);
  const newGridW = eng === 'grid' ? yield* fitGridSteps(trainAll, gridFromElo(eloAll), useH2H ? [] : ['w_h2h']) : gridOld;
  // swapped in together; from here to the end the build runs in one go
  h2hUsed = useH2H; lastSplit = split; fit = { c: eloAll.c, s: eloAll.s, beta: eloAll.beta }; gridW = newGridW; engine = eng;
  // common-sense check: on when it does not make the test clearly worse (Yarin, Oct 2026: picks must make sense)
  const baseP = (x: (typeof pre)[number]) => (engine === 'grid' ? gridProbs(x.f, gridOld) : probs(x.d + eloOld.beta * x.lv, eloOld.c, eloOld.s));
  const facOf = (x: (typeof pre)[number]) => (engine === 'grid' ? factorsOf(x.f, gridOld) : x.d - (COMPS[x.league] || COMPS[10]).ha);
  const guardTrial = { ...guardOpt, on: true };
  const guardTest = score(x => commonSense(baseP(x), facOf(x), x.f.form, x.f.h2hInfo, guardTrial));
  const plainTest = engine === 'grid' ? gridTest : eloTest;
  guardOpt = { ...guardOpt, on: guardTest.logLoss <= plainTest.logLoss + 0.003 };
  const h2hGuard = { h2h: { used: h2hUsed, withoutH2H: testNoH2H, withH2H: testWithH2H, weight: Math.round((gridWithH2H.w_h2h || 0) * 1000) / 1000 }, guard: { on: guardOpt.on, without: plainTest, with: guardTest } };
  const rw = (w: GridW) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  evalStats = test.length
    ? {
        matches: test.length,
        trainedOn: `2018-01-01 → ${twoYears}`,
        eloPlusSquadValue: eloTest,
        grid: gridTest,
        engine,
        gridWeightsTest: rw(gridOld),
        withValues: test.filter(x => x.lv !== 0).length,
        note: 'both engines fitted before the test period and scored on the last 2 years; squad values are a July 2026 snapshot (mild look-ahead on older matches, same for both)',
        h2hGuard
      }
    : null;
  natGoalByKind = fitGoalScales(test);
  if (evalStats) { evalStats.goalScaleByKind = natGoalByKind; evalStats.params = NP; }
  lastBuilt = new Date().toISOString();
  publishState('elo-intl', { ratings, meetings: meetings.dump(), h2hUsed, guardOpt, fit, gridW, engine, evalStats, lastBuilt, popStats, natGoalByKind, NP });
  logger.info(`National model: ${rows.length} matches, ${ratings.size} teams, engine ${engine} (test log loss grid ${gridTest.logLoss} vs elo ${eloTest.logLoss})`);
  return { matches: rows.length, teams: ratings.size, engine };
}

/* ------------------------------------------------------------------ */
/* Tuning the engine settings                                           */
/* ------------------------------------------------------------------ */

type TuneRow = { params: NatParams; grid: any; elo: any };
let tuneState: { running: boolean; startedAt: string; done: number; total: number; baseline?: TuneRow; results: TuneRow[]; chosen?: NatParams; adopted?: boolean; note?: string; error?: string } | null = null;
export const nationalTuneStatus = () => tuneState;

function snapshot() {
  return {
    ratings: new Map([...ratings.entries()].map(([k, v]) => [k, { ...v, recent: [...v.recent] }])),
    fit: { ...fit }, gridW: { ...gridW }, engine, evalStats, lastSplit, lastBuilt, popStats, natGoalByKind: { ...natGoalByKind }
  };
}
function restore(x: ReturnType<typeof snapshot>) {
  ratings.clear(); x.ratings.forEach((v, k) => ratings.set(k, v));
  fit = x.fit; gridW = x.gridW; engine = x.engine; evalStats = x.evalStats; lastSplit = x.lastSplit; lastBuilt = x.lastBuilt; popStats = x.popStats; natGoalByKind = x.natGoalByKind;
}
/** One variant: build with these settings, read the test scores, put the live model back exactly as it was. */
function trial(params: NatParams): TuneRow {
  const keep = snapshot(), keepNP = NP;
  try {
    NP = params;
    buildNationalElo();
    return { params, grid: evalStats?.grid, elo: evalStats?.eloPlusSquadValue };
  } finally {
    NP = keepNP;
    restore(keep);
  }
}
const pause = () => new Promise(r => setImmediate(r));

/**
 * Try the engine settings one at a time around the current ones, then the best of each together. A set is adopted
 * (saved, model rebuilt) only when it lowers the test log loss by 0.002+ — otherwise the model stays as it is.
 */
export async function tuneNational() {
  if (tuneState?.running) throw new Error('Already running');
  const base = { ...NP };
  const grid: [keyof NatParams, number[]][] = [
    ['etaComp', [0.03, 0.06, 0.08]],
    ['etaFriendly', [0.015, 0.04]],
    ['homeG', [0.1, 0.26]],
    ['kScale', [0.7, 1.3]]
  ];
  tuneState = { running: true, startedAt: new Date().toISOString(), done: 0, total: 2 + grid.reduce((s, [, v]) => s + v.length, 0), results: [] };
  try {
    const baseline = trial(base);
    tuneState.baseline = baseline; tuneState.done++;
    const bestOf: Partial<NatParams> = {};
    for (const [k, vals] of grid) {
      let bestV = base[k], bestL = baseline.grid?.logLoss ?? Infinity;
      for (const v of vals) {
        await pause();
        const r = trial({ ...base, [k]: v });
        tuneState.results.push(r); tuneState.done++;
        if (r.grid && r.grid.logLoss < bestL) { bestL = r.grid.logLoss; bestV = v; }
      }
      bestOf[k] = bestV;
    }
    await pause();
    const combo = trial({ ...base, ...bestOf });
    tuneState.results.push(combo); tuneState.done++;
    const all = [baseline, ...tuneState.results].filter(r => r.grid);
    const best = all.sort((a, b) => a.grid.logLoss - b.grid.logLoss)[0];
    tuneState.chosen = best.params;
    if (best !== baseline && best.grid.logLoss < baseline.grid.logLoss - 0.002) {
      NP = { ...best.params };
      db.prepare(`INSERT OR REPLACE INTO nat_params (id, json, at) VALUES (1, ?, ?)`).run(JSON.stringify(NP), new Date().toISOString());
      buildNationalElo();
      tuneState.adopted = true;
      tuneState.note = `adopted: test log loss ${baseline.grid.logLoss} → ${best.grid.logLoss}, hit rate ${baseline.grid.hitRate}% → ${best.grid.hitRate}%`;
    } else {
      tuneState.adopted = false;
      tuneState.note = 'kept the current settings (no variant was clearly better on the test years)';
    }
  } catch (e: any) {
    tuneState.error = e.message;
    logger.warn(`national tune: ${e.message}`);
  } finally {
    tuneState.running = false;
  }
  return tuneState;
}

/* ------------------------------------------------------------------ */
/* Prediction                                                           */
/* ------------------------------------------------------------------ */

function poisson(l: number, k: number) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }

/** 1–10 value for a team on a row, from its standing among active teams (5.5 = average). */
function scale(x: number, mean: number, sd: number) {
  return Math.round(Math.max(1, Math.min(10, 5.5 + 2.25 * ((x - mean) / (sd || 1)))) * 10) / 10;
}
let popStats: { at: number; s: Record<string, { mean: number; sd: number }> } | null = null;
// fix202: built in the worker; the web process takes the finished ratings and settings (national-team predictions)
onState('elo-intl', (_k, v) => {
  ratings.clear(); for (const [id, r] of v.ratings) ratings.set(id, r);
  meetings.load(v.meetings);
  h2hUsed = v.h2hUsed; guardOpt = v.guardOpt; fit = v.fit; gridW = v.gridW; engine = v.engine; evalStats = v.evalStats; lastBuilt = v.lastBuilt;
  popStats = v.popStats; natGoalByKind = v.natGoalByKind; NP = v.NP;
});
function population() {
  if (popStats && Date.now() - popStats.at < 3600_000) return popStats.s;
  const since = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const act = [...ratings.values()].filter(r => r.n >= 15 && r.last >= since);
  const ms = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1)) };
  };
  const vals = act.map(r => nationalValueFor(r.name)).filter((v): v is number => !!v).map(v => Math.log(v));
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const s = {
    elo: ms(act.map(r => r.elo)),
    squad: ms(vals),
    goals: ms(act.map(r => r.att + r.def)),
    form: ms(act.map(r => avg(r.recent)))
  };
  popStats = { at: Date.now(), s };
  return s;
}

/** Prediction for an API-Football-backed match object (team ids are offset). */
export function predictNational(match: any, leagueId: number): Prediction | null {
  const hid = (match.homeTeam?.id || 0) - AF_OFFSET, aid = (match.awayTeam?.id || 0) - AF_OFFSET;
  const H = ratings.get(hid), A = ratings.get(aid);
  if (!H || !A || H.n < 5 || A.n < 5) return null;
  const cfg = COMPS[leagueId] || COMPS[10];
  const vh = nationalValueFor(H.name), va = nationalValueFor(A.name);
  const date = String(match.utcDate || new Date().toISOString()).slice(0, 10);
  const f = featOf(H, A, leagueId, date, vh, va, hid, aid);
  const valueTerm = vh && va ? fit.beta * Math.log(vh / va) : 0;
  const d = H.elo - A.elo + cfg.ha + valueTerm;
  const p0 = engine === 'grid' ? gridProbs(f) : probs(d);
  const p = commonSense(p0, engine === 'grid' ? factorsOf(f, gridW) : d - cfg.ha, f.form, f.h2hInfo, guardOpt);
  // goals: from the goal ratings (grid) or the rating gap (elo)
  const gs = goalScaleFor(f.kind);
  const lamH = (engine === 'grid' ? Math.min(4, Math.max(0.2, f.lamH)) : Math.max(0.2, 1.3 * Math.exp(d / 650))) * gs;
  const lamA = (engine === 'grid' ? Math.min(4, Math.max(0.2, f.lamA)) : Math.max(0.2, 1.3 * Math.exp(-d / 650))) * gs;
  let over25 = 0, btts = 0;
  const scores: { home: number; away: number; prob: number }[] = [];
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const q = poisson(lamH, i) * poisson(lamA, j);
    if (i + j > 2.5) over25 += q;
    if (i > 0 && j > 0) btts += q;
    scores.push({ home: i, away: j, prob: q });
  }
  scores.sort((x, y) => y.prob - x.prob);
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const n = Math.min(H.n, A.n);
  const out: Prediction = {
    model: MODEL_ELO,
    home: pct(p.h), draw: pct(p.d), away: pct(p.a),
    expectedGoals: { home: Math.round(lamH * 100) / 100, away: Math.round(lamA * 100) / 100 },
    over25: pct(over25), btts: pct(btts),
    topScores: scores.slice(0, 3).map(s => ({ ...s, prob: pct(s.prob) })),
    confidence: n >= 30 ? 'high' : n >= 15 ? 'medium' : 'low',
    factors: {
      homeAttack: Math.round(H.elo), homeDefence: 0, awayAttack: Math.round(A.elo), awayDefence: 0,
      homeAdvantage: cfg.ha, homeForm: Math.round(valueTerm), awayForm: 1, gamesPlayed: { home: H.n, away: A.n }, leagueAvgGoals: 1.3
    }
  };
  if (engine === 'grid') {
    // the v3 breakdown: each row's value (1–10 among active national teams), weight and edge (points out of 1000)
    const ps = population();
    const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const w = gridW;
    const mult = f.kind === 'friendly' ? w.m_friendly : 1;
    const edge = (x: number) => Math.round(x * mult * 250) / 10; // z units → points-ish (display)
    const relOf = (x: number) => (Math.abs(x) < 1e-9 ? 0 : Math.max(1, Math.min(5, Math.round(Math.abs(x) * 5)))); // fix282: weight 0 = not used
    const eur = (x: number | null) => (x ? `€${Math.round(x / 1e6)}m` : 'n/a');
    const rows: NonNullable<Prediction['grid']>['rows'] = [
      { id: '#1e', name: 'Strength (rating)', rel: relOf(w.w_elo), home: scale(H.elo, ps.elo.mean, ps.elo.sd), away: scale(A.elo, ps.elo.mean, ps.elo.sd), edge: edge(w.w_elo * f.dElo), note: `rating ${Math.round(H.elo)} vs ${Math.round(A.elo)}` },
      { id: '#1', name: 'Squad value (by nationality)', rel: relOf(w.w_squad), home: vh ? scale(Math.log(vh), ps.squad.mean, ps.squad.sd) : 5.5, away: va ? scale(Math.log(va), ps.squad.mean, ps.squad.sd) : 5.5, edge: edge(w.w_squad * f.lv), note: `top-23 value ${eur(vh)} vs ${eur(va)}` },
      { id: '#19', name: 'Goals: attack vs defence', rel: relOf(w.w_goals), home: scale(H.att + H.def, ps.goals.mean, ps.goals.sd), away: scale(A.att + A.def, ps.goals.mean, ps.goals.sd), edge: edge(w.w_goals * f.gl), note: `expected goals ${out.expectedGoals.home} vs ${out.expectedGoals.away}` },
      { id: '#21', name: 'Form, last 6 (vs expectation)', rel: relOf(w.w_form), home: scale(avg(H.recent), ps.form.mean, ps.form.sd), away: scale(avg(A.recent), ps.form.mean, ps.form.sd), edge: edge(w.w_form * f.form) },
      { id: '#10', name: 'Rest days', rel: relOf(w.w_rest), home: 5.5 + Math.round(f.rest * 45) / 10, away: 5.5 - Math.round(f.rest * 45) / 10, edge: edge(w.w_rest * f.rest) },
      { id: '#7', name: 'Head-to-head, last 10', rel: relOf(w.w_h2h || 0), home: f.h2hInfo ? Math.round((1 + 9 * f.h2hInfo.share) * 10) / 10 : 5, away: f.h2hInfo ? Math.round((1 + 9 * (1 - f.h2hInfo.share)) * 10) / 10 : 5, edge: edge((w.w_h2h || 0) * f.h2h), note: f.h2hInfo ? `${f.h2hInfo.n} meetings, ${H.name} share ${Math.round(f.h2hInfo.share * 100)}%` : 'no meetings in the last 10 years' },
      { id: '#23', name: f.kind === 'friendly' ? 'Home advantage (friendly)' : 'Home advantage', rel: relOf(f.kind === 'friendly' ? w.w_homeFriendly : w.w_homeComp), home: f.homeComp || f.homeFriendly ? 7 : 5.5, away: 5.5, edge: edge(w.w_homeComp * f.homeComp + w.w_homeFriendly * f.homeFriendly), note: f.kind === 'finals' ? 'tournament finals: neutral venue' : undefined }
    ];
    const reasons = rows.filter(r => Math.abs(r.edge) >= 3).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, 3)
      .map(r => `${r.name}: ${r.edge > 0 ? H.name : A.name} +${Math.abs(r.edge)}`);
    if (f.kind === 'friendly') reasons.push('friendly: rotated squads make it less predictable');
    if (p.fired) reasons.push('common-sense check: the weaker side on form or head-to-head is not made the favourite');
    const ptsH = Math.round(p.h * 1000), ptsA = Math.round(p.a * 1000);
    out.grid = {
      matchType: Math.abs(gridProbs(f).z) > 1.4 ? 'mismatch' : Math.abs(gridProbs(f).z) < 0.35 ? 'even' : 'standard',
      points: { home: ptsH, draw: 1000 - ptsH - ptsA, away: ptsA },
      totals: { home: Math.round(rows.reduce((s, r) => s + Math.max(0, r.edge), 0) * 10) / 10, away: Math.round(rows.reduce((s, r) => s + Math.max(0, -r.edge), 0) * 10) / 10 },
      rows,
      drawPot: { base: Math.round(f.pDraw * 1000), factors: 0, volatility: 0, total: 1000 - ptsH - ptsA },
      reasons,
      scope: 'national'
    };
  }
  return out;
}

export function nationalEloStatus() {
  const top = [...ratings.entries()]
    .filter(([, r]) => r.n >= 15 && r.last >= new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10))
    .sort((a, b) => b[1].elo - a[1].elo)
    .slice(0, 30)
    .map(([, r], i) => ({ rank: i + 1, team: r.name, elo: Math.round(r.elo), matches: r.n, squadValueM: Math.round((nationalValueFor(r.name) || 0) / 1e6) }));
  const n: any = db.prepare(`SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM nat_matches`).get();
  // Active teams without a squad value (name mismatch, or fewer than 11 valued players)
  const since = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const active = [...ratings.values()].filter(r => r.n >= 15 && r.last >= since);
  const noValue = active.filter(r => !nationalValueFor(r.name)).sort((a, b) => b.elo - a.elo).map(r => `${r.name} (${Math.round(r.elo)})`);
  return { model: MODEL_ELO, engine, gridWeights: gridW, lastBuilt, matches: n, teams: ratings.size, activeTeams: active.length, withValue: active.length - noValue.length, noValue, fit, evaluation: evalStats, top };
}

export function startNationalEloScheduler() {
  if (!afConfigured()) return;
  // fix167: built in slices (was one synchronous build at start-up and after every sync)
  // fix210: in the heavy-job queue; the build itself runs in a worker thread (services/threadJob.ts)
  afterHeavy('national elo build', () => buildNationalEloAsync().catch(() => undefined /* empty table on first boot */), 0);
  const run = () => syncNationalHistory().then(r => (r.requests ? buildNationalEloAsync() : undefined)).catch(() => undefined);
  afterHeavy('national elo', run, 3 * 60 * 1000);
  everyHeavy('national elo', run, 12 * 3600 * 1000);
}

/** Team analysis for a national team: Elo and world rank among active national teams. */
export function nationalTeamView(afId: number) {
  const me = ratings.get(afId);
  if (!me) return null;
  const since = new Date(Date.now() - 3 * 365 * 86400000).toISOString().slice(0, 10);
  const active = [...ratings.values()].filter(r => r.n >= 15 && r.last >= since);
  return { elo: Math.round(me.elo), rank: active.filter(r => r.elo > me.elo).length + 1, teams: active.length, matches: me.n };
}

/** Is this API-Football team a national team we rate (5+ internationals)? */
export function isNationalTeam(afId: number) {
  const r = ratings.get(afId);
  return !!r && r.n >= 5;
}

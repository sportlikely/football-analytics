/**
 * tennis-v1 (fix190, Oct 2026) — the tennis model. Admin only: nothing reaches a public route. Built and tested on our
 * own tables (services/tennis.ts): tennis_matches, tennis_match_stats, tennis_rankings, tennis_players, tennis_stoppages.
 * Singles only. Market prices are never a model input (tennis_prices / the benchmark below are admin numbers only).
 *
 * Scope: ratings learn from every singles match we hold (ATP, WTA, Challenger, ITF, qualifying); juniors, UTR,
 * exhibitions and team events (Davis Cup, BJK Cup, Laver Cup, United Cup) are left out of training and testing.
 * Predicted + tested: ATP, WTA, Challenger, Grand Slams (main draw + qualifying). ITF is predicted for admins only.
 * Walkovers (and abandoned / unresolved matches) are void. A retirement after the start counts for the winner in the
 * record; in the ratings it moves `ret` (tuned) of a normal result.
 *
 *  A. Elo per player: overall + one per surface (hard, clay, grass; indoor hard = hard). Rating used = w·surface +
 *     (1−w)·overall, w tuned per surface. K = K0 / (matches + offset)^shape (538 style) × a level multiplier (Slam /
 *     1000 / 500 / 250 / Challenger / ITF, tuned). A new player starts from his as-of ranking (rank → Elo fitted on
 *     players who already have 25+ matches), else from a typical rank for the level of his first match. Best of 5 makes
 *     the gap count more (tuned). 60+ days without a match: pulled toward his rank-based start (tuned), "returning".
 *     The 2015–2022 archive (ATP / WTA) is replayed first, then 2023 → now.
 *  B. Serve / return points: per player an exp-weighted (half-life tuned), opponent-adjusted, surface-blended (tuned)
 *     serve and return strength, shrunk to the tour / surface mean by points played (tuned). Partial tapes count with
 *     weight = coverage. p1 serve point % = mean + (p1 serve − mean) − (p2 return − mean). A Markov chain point → game
 *     → tiebreak → set → match with the real format (BO3 / BO5; deciding set: full set with a 7-point tiebreak, a
 *     10-point tiebreak at 6-6 (Slams since 2022) or a 10-point match tiebreak instead of the set (found from the
 *     tournament's stored scores)) gives the win chance, set scores, total games and the first-set winner.
 *  C. Context, each kept only if it lowers the walk-forward log loss: fatigue (matches 3 / 7 / 14 days, sets and
 *     minutes 7 days, a long match yesterday), a stoppage in the last 30 days, home country, first match on the surface
 *     in 30+ days, ranking trend (now vs 3 months ago).
 *  D. Logistic blend of [A logit, B logit, kept C features] (no intercept: symmetric in p1 / p2). Used only if its
 *     walk-forward log loss beats A alone and B alone; else the best single one. Sets and totals: both serve-point
 *     chances shift by the same amount until the chain's win chance equals the final one, then the chain is read.
 *
 * Test (never on fitting data): walk-forward by month, Jan 2024 → last full month: each month predicted with settings
 * tuned only on matches before it (A and B tuned on 2023-01 → the month before; the blend refitted each month). Every
 * Elo / point-model setting is evaluated in ONE full replay (ratings are online: the predictions of a replay that stops
 * at month M are the same as the full replay's up to M), keeping the log loss per month, so each month's tune is a sum
 * over the months before it — no replay per month. Starts only once the monthly backfill has reached 2023-01.
 * GET /api/admin/tennis-model has the report. Live: ratings updated after each finished match, settings re-tuned
 * weekly (Monday 04:00 Israel time), the next 48 h predicted every 30 min until the start (then frozen).
 *
 * fix200: all of it (report, re-tune, ratings replay, new results, predictions) runs in a worker thread
 * (workers/tennisModelWorker.ts) with its own database connection in read mode. The worker collects its writes; the main
 * thread applies them in one short transaction and keeps a snapshot of the ratings for the pages (tennisPlayerModel).
 * TENNIS_WORKER=0, or a worker that crashes 3 times, falls back to the in-process run (the fix194 slices).
 */
import fs from 'fs';
import path from 'path';
import { Worker, isMainThread, workerData, MessagePort } from 'worker_threads';
import { db, Statement } from '../db';
import logger from '../utils/logger';
import { winnerBands, winnerByConfidence } from '../utils/winnerBands';
import { slicer, yieldLoop, timed, heavy, track } from './perf';
import { tournamentKey, tennisLiveBusy, fetchHistoryPrices } from './tennis';

export const TENNIS_MODEL = 'tennis-v1';
const DAY = 86400000;
const LN10_400 = Math.LN10 / 400;
/** one slicer for every loop here: many short replays in a row still give the thread back every ~30 ms */
const shared = slicer(30);

db.exec(`
  CREATE TABLE IF NOT EXISTS tennis_predictions (
    match_id INTEGER PRIMARY KEY, model TEXT NOT NULL, scheduled_at TEXT, cat TEXT, p1 REAL NOT NULL, sets TEXT, games TEXT,
    first_set_p1 REAL, why TEXT, made_at TEXT NOT NULL, first_p1 REAL, first_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tennis_pred_time ON tennis_predictions(scheduled_at);
  CREATE TABLE IF NOT EXISTS tennis_model_store (k TEXT PRIMARY KEY, v TEXT, at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tennis_market_bench (match_id INTEGER PRIMARY KEY, p1 REAL, at TEXT, rows INTEGER, fetched_at TEXT NOT NULL);
`);
/*
 * fix200: in the worker thread every write is collected (`sink`) and sent to the main thread, which applies them in one
 * transaction; what the worker stored itself is read back from `overlay` until then.
 */
const IN_WORKER = !isMainThread && !!workerData?.tennisModel;
interface Write { sql: string; params: unknown[] }
let sink: Write[] | null = IN_WORKER ? [] : null;
const overlay = new Map<string, unknown>();
const write = (sql: string, params: unknown[]) => { if (sink) sink.push({ sql, params }); else db.prepare(sql).run(...params); };
const STORE_SET = `INSERT OR REPLACE INTO tennis_model_store (k, v, at) VALUES (?, ?, ?)`;
const store = {
  get: (k: string): any => {
    if (overlay.has(k)) return overlay.get(k);
    const r = db.prepare(`SELECT v FROM tennis_model_store WHERE k = ?`).get(k) as any; try { return r ? JSON.parse(r.v) : null; } catch { return null; }
  },
  set: (k: string, v: unknown) => { if (sink) overlay.set(k, JSON.parse(JSON.stringify(v))); write(STORE_SET, [k, JSON.stringify(v), new Date().toISOString()]); }
};
// the live record counts from the day this model was first deployed
if (!IN_WORKER && !store.get('deploy_day')) store.set('deploy_day', new Date().toISOString().slice(0, 10));

/* ------------------------------------------------------------------ */
/* Categories, levels, formats                                          */
/* ------------------------------------------------------------------ */

const SURF: Record<string, number> = { hard: 0, clay: 1, grass: 2, carpet: 0 };
const SURF_NAME = ['hard', 'clay', 'grass'];
/** 0 slam, 1 atp, 2 wta, 3 challenger, 4 itf — the first four are tested */
export const CAT_NAME = ['slam', 'atp', 'wta', 'challenger', 'itf'] as const;
const TESTED = (c: number) => c <= 3;
const LVL_NAME = ['Grand Slam', '1000', '500', '250', 'Challenger', 'ITF'];
const EXCL_TIERS = new Set(['juniors', 'utr', 'exhibition', 'davis_cup', 'bjk_cup', 'laver_cup', 'united_cup']);
const EXCL_NAME = /davis cup|billie jean|bjk cup|fed cup|laver cup|united cup|hopman|exhibition|junior|\butr\b|world team|six kings|ultimate tennis/i;
const ROUND_ORDER: Record<string, number> = { Q: 0, Q1: 0, Q2: 1, Q3: 2, Q4: 3, ER: 4, R128: 5, R64: 6, R32: 7, R16: 8, RR: 8, QF: 9, SF: 10, BR: 11, F: 12 };

/** cat, level group, gender (0 men, 1 women) — null = left out (juniors, exhibitions, team events) */
function classify(tour: string | null, tier: string | null, name: string | null, source: string): { cat: number; lvl: number; gen: number } | null {
  const tr = String(tour || '').toLowerCase(), ti = String(tier || '').toLowerCase();
  if (tr === 'juniors' || EXCL_TIERS.has(ti) || EXCL_NAME.test(name || '')) return null;
  if (source === 'archive') {
    // archive rows keep the source level code in `tier`: G slam, M masters, A tour, F finals, D Davis Cup, C challenger, O olympics, digits = ITF
    const g = tr === 'wta' ? 1 : 0;
    if (ti === 'd') return null;
    if (ti === 'g') return { cat: 0, lvl: 0, gen: g };
    if (['m', 'f', 'o', 'p', 'pm', 't1'].includes(ti)) return { cat: 1 + g, lvl: 1, gen: g };
    if (ti === 'c') return { cat: 3, lvl: 4, gen: g };
    if (/^\d+$/.test(ti) || ti === 's' || ti === 'itf') return { cat: 4, lvl: 5, gen: g };
    return { cat: 1 + g, lvl: 3, gen: g };
  }
  // fix195: an ITF event by its name ("M25 Sarreguemines", "W35 Santa Margherita di Pula") is ITF whatever the row's
  // tour says (fixture rows called them 'atp'); the letter is the gender
  const itfName = /^(?:ITF\s+)?([MW])(15|25|35|40|50|60|75|80|100)\b/i.exec(String(name || '').trim());
  if (itfName) return { cat: 4, lvl: 5, gen: itfName[1].toUpperCase() === 'W' ? 1 : 0 };
  const g = tr === 'wta' || /^wta_|^itf_w|^bjk/.test(ti) ? 1 : 0;
  if (ti === 'grand_slam') return { cat: 0, lvl: 0, gen: g };
  if (ti === 'wta_125') return { cat: 2, lvl: 4, gen: 1 };
  if (/^challenger/.test(ti) || tr === 'challenger') return { cat: 3, lvl: 4, gen: 0 };
  if (/^itf/.test(ti) || tr === 'itf') return { cat: 4, lvl: 5, gen: g };
  if (/1000|finals|olympics|elite|next_gen/.test(ti)) return { cat: 1 + g, lvl: 1, gen: g };
  if (/500/.test(ti)) return { cat: 1 + g, lvl: 2, gen: g };
  return { cat: 1 + g, lvl: 3, gen: g };
}

/* IOC codes (the players' country) and the tournament country (code or name) → one code */
const COUNTRIES = `arg:ar:argentina aus:au:australia aut:at:austria bel:be:belgium bih:ba:bosnia bra:br:brazil bul:bg:bulgaria can:ca:canada
chi:cl:chile chn:cn:china col:co:colombia cro:hr:croatia cyp:cy:cyprus cze:cz:czechia den:dk:denmark ecu:ec:ecuador egy:eg:egypt esp:es:spain
est:ee:estonia fin:fi:finland fra:fr:france gbr:gb:united kingdom geo:ge:georgia ger:de:germany gre:gr:greece hkg:hk:hong kong hun:hu:hungary
ind:in:india ina:id:indonesia irl:ie:ireland ita:it:italy jpn:jp:japan kaz:kz:kazakhstan kor:kr:south korea lat:lv:latvia ltu:lt:lithuania
lux:lu:luxembourg mar:ma:morocco mex:mx:mexico mda:md:moldova mon:mc:monaco ned:nl:netherlands nzl:nz:new zealand nor:no:norway par:py:paraguay
per:pe:peru phi:ph:philippines pol:pl:poland por:pt:portugal qat:qa:qatar rou:ro:romania rsa:za:south africa rus:ru:russia srb:rs:serbia
slo:si:slovenia svk:sk:slovakia sui:ch:switzerland swe:se:sweden tha:th:thailand tun:tn:tunisia tur:tr:turkey ukr:ua:ukraine uru:uy:uruguay
usa:us:united states uzb:uz:uzbekistan ven:ve:venezuela blr:by:belarus uae:ae:united arab emirates ksa:sa:saudi arabia tpe:tw:chinese taipei
mne:me:montenegro mkd:mk:north macedonia alb:al:albania arm:am:armenia aze:az:azerbaijan isl:is:iceland mlt:mt:malta dom:do:dominican republic
pur:pr:puerto rico bar:bb:barbados jam:jm:jamaica`.split(/\s+(?=[a-z]{3}:)/).map(x => x.trim().split(':'));
const CODE = new Map<string, string>();
for (const [ioc, iso, name] of COUNTRIES) { CODE.set(ioc, ioc); CODE.set(iso, ioc); CODE.set(name, ioc); }
for (const [a, b] of [['great britain', 'gbr'], ['england', 'gbr'], ['scotland', 'gbr'], ['usa', 'usa'], ['united states of america', 'usa'], ['czech republic', 'cze'], ['korea', 'kor'], ['the netherlands', 'ned'], ['holland', 'ned'], ['deutschland', 'ger'], ['türkiye', 'tur'], ['turkiye', 'tur'], ['uk', 'gbr']]) CODE.set(a, b);
const ctry = (x: string | null | undefined): string | null => { if (!x) return null; const k = String(x).trim().toLowerCase(); return CODE.get(k) ?? (k.length === 3 ? k : null); };

/* ------------------------------------------------------------------ */
/* Players and match rows (typed arrays: ~500k matches stay small)       */
/* ------------------------------------------------------------------ */

class Reg {
  idx = new Map<string, number>(); pid: number[] = []; name: string[] = []; country: (string | null)[] = []; women: Uint8Array = new Uint8Array(0);
  get(key: string, pid: number, name: string | null): number {
    let i = this.idx.get(key);
    if (i === undefined) { i = this.pid.length; this.idx.set(key, i); this.pid.push(pid); this.name.push(name || String(pid)); this.country.push(null); }
    return i;
  }
  get size() { return this.pid.length; }
}

const F32 = ['a_pts', 'a_won', 'b_pts', 'b_won', 'cov', 'mins', 'games', 'r1', 'r2'] as const;
const U8 = ['win', 'cat', 'lvl', 'surf', 'gen', 'bo', 'rule', 'ret', 'quali', 'indoor', 'ro', 'sets', 'sw1', 'sw2', 'lastA', 'lastB', 'h1', 'h2'] as const;
class Rows {
  n = 0;
  id: Float64Array; t: Float64Array; p1: Int32Array; p2: Int32Array; tk: Int32Array; month: Int16Array;
  a_pts!: Float32Array; a_won!: Float32Array; b_pts!: Float32Array; b_won!: Float32Array; cov!: Float32Array; mins!: Float32Array; games!: Float32Array; r1!: Float32Array; r2!: Float32Array;
  win!: Uint8Array; cat!: Uint8Array; lvl!: Uint8Array; surf!: Uint8Array; gen!: Uint8Array; bo!: Uint8Array; rule!: Uint8Array; ret!: Uint8Array; quali!: Uint8Array; indoor!: Uint8Array;
  ro!: Uint8Array; sets!: Uint8Array; sw1!: Uint8Array; sw2!: Uint8Array; lastA!: Uint8Array; lastB!: Uint8Array; h1!: Uint8Array; h2!: Uint8Array;
  constructor(cap: number) {
    cap = Math.max(1, cap);
    this.id = new Float64Array(cap); this.t = new Float64Array(cap); this.p1 = new Int32Array(cap); this.p2 = new Int32Array(cap); this.tk = new Int32Array(cap); this.month = new Int16Array(cap);
    for (const f of F32) (this as any)[f] = new Float32Array(cap);
    for (const f of U8) (this as any)[f] = new Uint8Array(cap);
  }
  /** reorder [lo, hi) by `order` (indices into that range) */
  permute(lo: number, order: number[]) {
    for (const f of ['id', 't', 'p1', 'p2', 'tk', 'month', ...F32, ...U8]) {
      const a = (this as any)[f];
      const tmp = order.map(i => a[i]);
      for (let k = 0; k < tmp.length; k++) a[lo + k] = tmp[k];
    }
  }
}
const monthIdx = (t: number) => { const d = new Date(t); return (d.getUTCFullYear() - 2023) * 12 + d.getUTCMonth(); };
const monthName = (m: number) => `${2023 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
const normName = (s: string | null) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const shortName = (s: string | null) => { const p = normName(s).split(' '); return p.length >= 2 ? `${p[0][0]} ${p[p.length - 1]}` : p[0] || ''; };

/** Everything the parse needs besides the row: players, rank history, tournament formats, archive id mapping. */
interface Ctx {
  reg: Reg; tkeys: Map<string, number>; tkName: string[]; ruleOfKey: Map<number, number>;
  rankHist: Map<number, { t: number[]; r: number[] }>; archMap: Map<number, string>;
  playerRank: Map<number, number>; playerCountry: Map<number, string | null>; playerTour: Map<number, string | null>;
  stops: Map<number, number[]>;
}
function rankAt(c: Ctx, idx: number, t: number, maxAge = 120 * DAY): number {
  const h = c.rankHist.get(idx);
  if (!h) return NaN;
  let lo = 0, hi = h.t.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (h.t[m] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 && t - h.t[best] <= maxAge ? h.r[best] : NaN;
}
function addRank(c: Ctx, idx: number, t: number, r: number) {
  if (!(r > 0) || !Number.isFinite(t)) return;
  let h = c.rankHist.get(idx);
  if (!h) { h = { t: [], r: [] }; c.rankHist.set(idx, h); }
  h.t.push(t); h.r.push(r);
}
/** fix194: in slices (thousands of players × hundreds of weekly ranks each) */
async function sortRanks(c: Ctx) {
  const slice = shared;
  for (const h of c.rankHist.values()) {
    const o = h.t.map((_, i) => i).sort((a, b) => h.t[a] - h.t[b]);
    h.t = o.map(i => h.t[i]); h.r = o.map(i => h.r[i]);
    await slice();
  }
}
const keyOf = (c: Ctx, id: number, source: string) => (source === 'archive' ? c.archMap.get(id) ?? `a${id}` : `p${id}`);

const sumArr = (a: any) => (Array.isArray(a) ? a.reduce((s: number, x: any) => s + (Number(x) || 0), 0) : 0);
/**
 * One tennis_matches row (+ stats of both sides, tournament country) → row i of R. `live` = an upcoming match: the
 * player's current ranking is his rank (in the test only as-of ranks are used: never a later ranking).
 */
function parseInto(c: Ctx, R: Rows, r: any, live: boolean): boolean {
  const cls = classify(r.tour, r.tier, r.tournament, r.source);
  if (!cls) return false;
  const t = Date.parse(r.scheduled_at);
  if (!Number.isFinite(t)) return false;
  const i = R.n;
  const k1 = keyOf(c, r.p1_id, r.source), k2 = keyOf(c, r.p2_id, r.source);
  const p1 = c.reg.get(k1, r.source === 'archive' && k1.startsWith('a') ? -r.p1_id : Number(k1.slice(1)), r.p1_name);
  const p2 = c.reg.get(k2, r.source === 'archive' && k2.startsWith('a') ? -r.p2_id : Number(k2.slice(1)), r.p2_name);
  if (p1 === p2) return false;
  for (const p of [p1, p2]) if (c.reg.country[p] == null && c.reg.pid[p] > 0) c.reg.country[p] = c.playerCountry.get(c.reg.pid[p]) ?? null;
  let gen = cls.gen;
  if (String(r.tour || '').toLowerCase() === 'itf' && !r.tier) gen = c.playerTour.get(c.reg.pid[p1]) === 'wta' ? 1 : 0;
  R.id[i] = r.id; R.t[i] = t; R.p1[i] = p1; R.p2[i] = p2; R.month[i] = monthIdx(t);
  R.win[i] = r.winner === 1 || r.winner === 2 ? r.winner : 0;
  R.cat[i] = cls.cat; R.lvl[i] = cls.lvl; R.gen[i] = gen;
  R.surf[i] = SURF[String(r.surface || '').toLowerCase()] ?? 0;
  R.indoor[i] = r.indoor ? 1 : 0;
  R.ro[i] = ROUND_ORDER[String(r.round_code || r.round || '').toUpperCase()] ?? 6;
  R.quali[i] = r.is_qualifying === 1 || /^Q/.test(String(r.round_code || '')) ? 1 : 0;
  R.bo[i] = r.best_of === 5 ? 5 : r.best_of === 3 ? 3 : cls.cat === 0 && gen === 0 && !R.quali[i] ? 5 : 3;
  R.ret[i] = /retired|default/.test(String(r.outcome || '')) ? 1 : 0;
  const tname = r.tournament ? `${r.tour || ''}|${tournamentKey(String(r.tournament))}` : '';
  let tk = c.tkeys.get(tname);
  if (tk === undefined) { tk = c.tkName.length; c.tkeys.set(tname, tk); c.tkName.push(tname); }
  R.tk[i] = tk;
  // stats: player 1 / player 2 service points (archive: player 1 = the winner)
  const ap = Number(r.a_pts) || 0, bp = Number(r.b_pts) || 0;
  if (ap > 0 && bp > 0 && r.a_won != null && r.b_won != null) {
    R.a_pts[i] = ap; R.a_won[i] = Number(r.a_won); R.b_pts[i] = bp; R.b_won[i] = Number(r.b_won);
    R.cov[i] = r.a_c === 1 ? 1 : Math.min(1, Math.max(0.3, 1 - (Number(r.gaps) || 0) / (ap + bp)));
  } else { R.a_pts[i] = 0; R.a_won[i] = 0; R.b_pts[i] = 0; R.b_won[i] = 0; R.cov[i] = 0; }
  let extra: any = null;
  if (r.extra) { try { extra = JSON.parse(r.extra); } catch { extra = null; } }
  R.mins[i] = r.dur > 0 ? r.dur / 60 : extra?.minutes > 0 ? extra.minutes : NaN;
  // score
  let g: any = null;
  try { g = r.games ? JSON.parse(r.games) : null; } catch { g = null; }
  if (Array.isArray(g) && Array.isArray(g[0]) && Array.isArray(g[1]) && g[0].length) {
    let w1 = 0, w2 = 0;
    for (let s = 0; s < g[0].length; s++) { const a = Number(g[0][s]) || 0, b = Number(g[1][s]) || 0; if (a > b) w1++; else if (b > a) w2++; }
    R.sets[i] = g[0].length; R.sw1[i] = w1; R.sw2[i] = w2; R.games[i] = sumArr(g[0]) + sumArr(g[1]);
    R.lastA[i] = Math.min(255, Number(g[0][g[0].length - 1]) || 0); R.lastB[i] = Math.min(255, Number(g[1][g[1].length - 1]) || 0);
  } else { R.sets[i] = 0; R.sw1[i] = 0; R.sw2[i] = 0; R.games[i] = NaN; R.lastA[i] = 0; R.lastB[i] = 0; }
  // ranks: the archive's rank at the time, else the rank history (tennis_rankings) as of the match; live: current rank
  const ar1 = extra?.winner?.rank, ar2 = extra?.loser?.rank;
  if (r.source === 'archive') { if (ar1 > 0) addRank(c, p1, t - 1, ar1); if (ar2 > 0) addRank(c, p2, t - 1, ar2); }
  const rk = (idx: number, ar: any) => {
    if (ar > 0) return ar;
    const h = rankAt(c, idx, t);
    if (Number.isFinite(h)) return h;
    return live ? c.playerRank.get(c.reg.pid[idx]) ?? NaN : NaN;
  };
  R.r1[i] = rk(p1, r.source === 'archive' ? ar1 : null); R.r2[i] = rk(p2, r.source === 'archive' ? ar2 : null);
  const tc = ctry(r.tcountry);
  R.h1[i] = tc && ctry(c.reg.country[p1]) === tc ? 1 : 0;
  R.h2[i] = tc && ctry(c.reg.country[p2]) === tc ? 1 : 0;
  R.rule[i] = 0;
  R.n++;
  return true;
}

const MATCH_SQL = `SELECT m.id, m.tournament_id, m.tournament, m.tour, m.tier, m.surface, m.indoor, m.round, m.round_code, m.is_qualifying, m.best_of,
    m.scheduled_at, m.status, m.p1_id, m.p1_name, m.p2_id, m.p2_name, m.games, m.winner, m.outcome, m.extra, m.source, m.updated_at,
    s1.svc_pts AS a_pts, s1.svc_won AS a_won, s1.complete AS a_c, s1.gaps AS gaps, s1.duration_s AS dur, s2.svc_pts AS b_pts, s2.svc_won AS b_won,
    t.country AS tcountry
  FROM tennis_matches m INDEXED BY idx_tennis_matches_time LEFT JOIN tennis_match_stats s1 ON s1.match_id = m.id AND s1.player = 1
    LEFT JOIN tennis_match_stats s2 ON s2.match_id = m.id AND s2.player = 2 LEFT JOIN tennis_tournaments t ON t.id = m.tournament_id`;
const DONE_WHERE = `m.status = 'completed' AND m.winner IN (1, 2) AND m.p1_id IS NOT NULL AND m.p2_id IS NOT NULL AND m.scheduled_at IS NOT NULL
  AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved') AND COALESCE(m.draw, 'singles') = 'singles'`;

/** Archive player ids → our ids: the same id with the same name, else a unique player with the same (or initial + last) name. */
/**
 * fix194: big tables are read in primary-key pages with yields (whole-table reads + the UNION blocked the server
 * ~2 s at the model's first run): archive rows are the negative ids.
 */
async function pagedRows(sql: string, start: number, size = 2000): Promise<any[]> {
  const st = db.prepare(sql);
  const out: any[] = [];
  let after = start;
  for (;;) {
    const rows = st.all(after, size) as any[];
    if (!rows.length) break;
    for (const r of rows) out.push(r);
    after = rows[rows.length - 1].id;
    await yieldLoop();
  }
  return out;
}
const allPlayers = (cols: string) => pagedRows(`SELECT ${cols} FROM tennis_players WHERE id > ? ORDER BY id LIMIT ?`, -Number.MAX_SAFE_INTEGER);
async function archiveMap(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const names = new Map<number, string>();
  for (const r of await pagedRows(`SELECT id, p1_id, p1_name, p2_id, p2_name FROM tennis_matches WHERE id > ? AND id < 0 ORDER BY id LIMIT ?`, -Number.MAX_SAFE_INTEGER)) {
    if (r.p1_id != null && !names.has(r.p1_id)) names.set(r.p1_id, r.p1_name);
    if (r.p2_id != null && !names.has(r.p2_id)) names.set(r.p2_id, r.p2_name);
  }
  const arch = [...names].map(([id, name]) => ({ id, name }));
  if (!arch.length) return out;
  const players = await allPlayers('id, name');
  const slice = shared;
  const byId = new Map<number, string>();
  const full = new Map<string, number | null>(), short = new Map<string, number | null>();
  for (const p of players) {
    const f = normName(p.name), s = shortName(p.name);
    byId.set(p.id, f);
    if (f) full.set(f, full.has(f) ? null : p.id);
    if (s) short.set(s, short.has(s) ? null : p.id);
    await slice();
  }
  for (const a of arch) {
    const n = normName(a.name);
    if (byId.get(a.id) === n && n) out.set(a.id, `p${a.id}`);
    else if (full.get(n)) out.set(a.id, `p${full.get(n)}`);
    else if (short.get(shortName(a.name))) out.set(a.id, `p${short.get(shortName(a.name))}`);
    await slice();
  }
  return out;
}

async function newCtx(): Promise<Ctx> {
  const c: Ctx = { reg: new Reg(), tkeys: new Map(), tkName: [], ruleOfKey: new Map(), rankHist: new Map(), archMap: await archiveMap(),
    playerRank: new Map(), playerCountry: new Map(), playerTour: new Map(), stops: new Map() };
  for (const p of await allPlayers('id, country, tour, ranking')) {
    c.playerCountry.set(p.id, p.country ?? null); c.playerTour.set(p.id, p.tour ?? null);
    if (p.ranking > 0) c.playerRank.set(p.id, p.ranking);
  }
  // the latest rankings table beats /players/{id}
  for (const r of db.prepare(`SELECT r.player_id, r.rank FROM tennis_rankings r WHERE r.player_id IS NOT NULL AND r.date = (SELECT MAX(date) FROM tennis_rankings r2 WHERE r2.tour = r.tour)`).all() as any[]) c.playerRank.set(r.player_id, r.rank);
  return c;
}
/**
 * fix194: pages by rowid (the keyset on date || rank could use no index: every page of 20,000 scanned and sorted the
 * whole table — the "tennis model first + tennis ratings" 2.1 s stalls). The order does not matter: sortRanks follows.
 */
async function loadRankHistory(c: Ctx) {
  let after = 0;
  const page = db.prepare(`SELECT player_id, date, rank, rowid AS rid FROM tennis_rankings WHERE rowid > ? ORDER BY rowid LIMIT 5000`);
  for (;;) {
    const rows = page.all(after) as any[];
    if (!rows.length) break;
    for (const r of rows) {
      if (r.player_id == null) continue;
      const i = c.reg.idx.get(`p${r.player_id}`);
      if (i !== undefined) addRank(c, i, Date.parse(`${r.date}T00:00:00Z`), r.rank);
    }
    after = rows[rows.length - 1].rid;
    await yieldLoop();
  }
}
function loadStops(c: Ctx) {
  for (const r of db.prepare(`SELECT player_id, kind, at FROM tennis_stoppages`).all() as any[]) {
    if (!/medical|retire|injur|treat|physio/i.test(String(r.kind || ''))) continue;
    const i = c.reg.idx.get(`p${r.player_id}`), t = Date.parse(r.at);
    if (i === undefined || !Number.isFinite(t)) continue;
    const l = c.stops.get(i) || []; l.push(t); c.stops.set(i, l);
  }
  for (const l of c.stops.values()) l.sort((a, b) => a - b);
}

/**
 * Deciding-set rule per tournament (0 = full set, 7-point tiebreak at 6-6; 1 = 10-point tiebreak at 6-6; 2 = 10-point
 * match tiebreak instead of the set). Slams since 2022 → 1. Other events → 2 when most of their deciding sets read like a
 * match tiebreak (1-0, or a winner's count of 8+: a tour event has no advantage final set).
 */
async function detectRules(c: Ctx, R: Rows) {
  const cnt = new Map<number, [number, number]>();
  for (let i = 0; i < R.n; i++) {
    if ((i & 8191) === 0) await shared(); // fix194
    if (R.cat[i] === 0 || !R.sets[i] || R.sets[i] !== R.bo[i]) continue;
    const a = R.lastA[i], b = R.lastB[i], hi = Math.max(a, b), lo = Math.min(a, b);
    const x = cnt.get(R.tk[i]) || [0, 0];
    x[0]++; if ((hi === 1 && lo === 0) || hi >= 8) x[1]++;
    cnt.set(R.tk[i], x);
  }
  for (const [k, [n, m]] of cnt) if (n >= 3 && m / n >= 0.5) c.ruleOfKey.set(k, 2);
  applyRules(c, R);
}
const SLAM_TB10 = Date.UTC(2022, 2, 1);
function applyRules(c: Ctx, R: Rows) {
  for (let i = 0; i < R.n; i++) {
    R.rule[i] = R.cat[i] === 0 ? (R.t[i] >= SLAM_TB10 ? 1 : 0) : c.ruleOfKey.get(R.tk[i]) ?? 0;
    // a match tiebreak counts as one game
    if (R.rule[i] === 2 && R.sets[i] === R.bo[i] && Number.isFinite(R.games[i])) R.games[i] -= R.lastA[i] + R.lastB[i] - 1;
  }
}

/** Every finished singles match in time order (archive first), in pages with yields. */
async function loadData(): Promise<{ c: Ctx; R: Rows }> {
  const c = await newCtx();
  // fix194: every row as the capacity (a plain COUNT reads the smallest index; the filtered one decoded every row)
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM tennis_matches`).get() as any).n as number;
  const R = new Rows(n + 10);
  // keyset pages on the time index (no sort of the whole table per page): the rest of the last timestamp, then later ones
  // fix194: pages of 1,000 (was 4,000) and the parse in slices
  const PAGE = 1000;
  let at = '', id = 0;
  const slice = shared;
  const same = db.prepare(`${MATCH_SQL} WHERE ${DONE_WHERE} AND m.scheduled_at = ? AND m.id > ? ORDER BY m.id LIMIT ${PAGE}`);
  const later = db.prepare(`${MATCH_SQL} WHERE ${DONE_WHERE} AND m.scheduled_at > ? ORDER BY m.scheduled_at, m.id LIMIT ?`);
  for (;;) {
    let rows = at ? (same.all(at, id) as any[]) : [];
    if (rows.length < PAGE) rows = rows.concat(later.all(at, PAGE - rows.length) as any[]);
    if (!rows.length) break;
    for (let k = 0; k < rows.length; k++) { if (R.n < R.id.length) parseInto(c, R, rows[k], false); if ((k & 127) === 0) await slice(); }
    const l = rows[rows.length - 1]; at = l.scheduled_at; id = l.id;
    await yieldLoop();
  }
  // same timestamp (archive rows carry the tournament's start date): rounds in order
  let lo = 0;
  for (let i = 1; i <= R.n; i++) {
    if (i < R.n && R.t[i] === R.t[lo]) continue;
    if (i - lo > 1) { const order = Array.from({ length: i - lo }, (_, k) => lo + k).sort((a, b) => R.ro[a] - R.ro[b] || R.id[a] - R.id[b]); R.permute(lo, order); }
    lo = i;
    await slice();
  }
  await loadRankHistory(c);
  await sortRanks(c);
  // ranks of non-archive rows: as of the match (rank history now loaded)
  for (let i = 0; i < R.n; i++) {
    if (!Number.isFinite(R.r1[i])) R.r1[i] = rankAt(c, R.p1[i], R.t[i]);
    if (!Number.isFinite(R.r2[i])) R.r2[i] = rankAt(c, R.p2[i], R.t[i]);
    if (i % 5000 === 0) await slice();
  }
  await detectRules(c, R);
  loadStops(c);
  return { c, R };
}

/* ------------------------------------------------------------------ */
/* A. Elo                                                               */
/* ------------------------------------------------------------------ */

type Rec = Record<string, number>;
const A_DEFAULT: Rec = { k0: 250, off: 5, shape: 0.4, lv0: 1.1, lv1: 1.05, lv2: 1, lv3: 1, lv4: 0.95, lv5: 0.9, ws0: 0.5, ws1: 0.5, ws2: 0.5, bo5: 1.15, pull: 0.2, ret: 0.5 };
const LV = [0.8, 0.9, 1, 1.1, 1.2, 1.35], WS = [0, 0.2, 0.4, 0.6, 0.8, 1];
const A_GRID: Record<string, number[]> = {
  k0: [150, 200, 250, 300, 375, 450], off: [2, 5, 10, 20], shape: [0.2, 0.3, 0.4, 0.5, 0.6],
  lv0: LV, lv1: LV, lv2: LV, lv3: LV, lv4: LV, lv5: LV, ws0: WS, ws1: WS, ws2: WS, bo5: [1, 1.08, 1.15, 1.25, 1.35, 1.5], pull: [0, 0.1, 0.2, 0.35, 0.5], ret: [0, 0.25, 0.5, 0.75, 1]
};
const A_KEYS = ['k0', 'shape', 'off', 'ws0', 'ws1', 'ws2', 'lv0', 'lv1', 'lv2', 'lv3', 'lv4', 'lv5', 'bo5', 'ret', 'pull'];
/** rank → Elo: a − b·ln(rank) */
interface RankMap { a: number; b: number; n: number }
const RM_DEFAULT: RankMap = { a: 2250, b: 95, n: 0 };
/** a typical rank for a newcomer with no known ranking, by the level of his first match (qualifying: lower) */
const GUESS_RANK = [100, 140, 170, 230, 380, 950];
const BREAK = 60 * DAY;

class AEng {
  eO: Float64Array; eS: Float64Array; nO: Float64Array; nS: Float64Array; last: Float64Array; init: Uint8Array;
  constructor(public P: Rec, public rm: RankMap, cap: number) {
    this.eO = new Float64Array(cap); this.eS = new Float64Array(cap * 3); this.nO = new Float64Array(cap); this.nS = new Float64Array(cap * 3);
    this.last = new Float64Array(cap); this.init = new Uint8Array(cap);
  }
  ensure(cap: number) {
    if (cap <= this.eO.length) return;
    const g = (a: any, k: number) => { const b = new (a.constructor)(Math.max(cap, a.length / k * 2) * k); b.set(a); return b; };
    this.eO = g(this.eO, 1); this.eS = g(this.eS, 3); this.nO = g(this.nO, 1); this.nS = g(this.nS, 3); this.last = g(this.last, 1); this.init = g(this.init, 1);
  }
  eloOfRank(r: number) { return this.rm.a - this.rm.b * Math.log(Math.max(1, r)); }
  start(p: number, rank: number, lvl: number, quali: number) {
    const e = this.eloOfRank(Number.isFinite(rank) ? rank : GUESS_RANK[lvl] * (quali ? 1.6 : 1));
    this.eO[p] = e; this.eS[p * 3] = e; this.eS[p * 3 + 1] = e; this.eS[p * 3 + 2] = e; this.init[p] = 1;
  }
  /** the pull of a returning player toward his rank-based start (0 when not returning or no rank) */
  pullOf(p: number, t: number, rank: number) {
    if (!this.P.pull || !this.last[p] || t - this.last[p] < BREAK || !Number.isFinite(rank)) return null;
    return { target: this.eloOfRank(rank), w: this.P.pull };
  }
  rating(p: number, s: number, t: number, rank: number) {
    let o = this.eO[p], sf = this.eS[p * 3 + s];
    const pl = this.pullOf(p, t, rank);
    if (pl) { o += pl.w * (pl.target - o); sf += pl.w * (pl.target - sf); }
    const w = this.P[`ws${s}`];
    return { r: w * sf + (1 - w) * o, o, s: sf };
  }
  /** logit of p1 winning (and both ratings) */
  pre(R: Rows, i: number) {
    const p1 = R.p1[i], p2 = R.p2[i], s = R.surf[i];
    if (!this.init[p1]) this.start(p1, R.r1[i], R.lvl[i], R.quali[i]);
    if (!this.init[p2]) this.start(p2, R.r2[i], R.lvl[i], R.quali[i]);
    const a = this.rating(p1, s, R.t[i], R.r1[i]), b = this.rating(p2, s, R.t[i], R.r2[i]);
    const f = R.bo[i] === 5 ? this.P.bo5 : 1;
    return { logit: (a.r - b.r) * f * LN10_400, a, b };
  }
  update(R: Rows, i: number) {
    const p1 = R.p1[i], p2 = R.p2[i], s = R.surf[i], t = R.t[i];
    if (!this.init[p1]) this.start(p1, R.r1[i], R.lvl[i], R.quali[i]);
    if (!this.init[p2]) this.start(p2, R.r2[i], R.lvl[i], R.quali[i]);
    for (const [p, rk] of [[p1, R.r1[i]], [p2, R.r2[i]]]) {
      const pl = this.pullOf(p, t, rk);
      if (pl) { this.eO[p] += pl.w * (pl.target - this.eO[p]); for (let k = 0; k < 3; k++) this.eS[p * 3 + k] += pl.w * (pl.target - this.eS[p * 3 + k]); }
    }
    const y = R.win[i] === 1 ? 1 : 0;
    const f = (R.bo[i] === 5 ? this.P.bo5 : 1) * LN10_400;
    const m = this.P[`lv${R.lvl[i]}`] * (R.ret[i] ? this.P.ret : 1);
    const k0 = this.P.k0, off = this.P.off, sh = this.P.shape;
    if (m > 0) {
      const pO = 1 / (1 + Math.exp(-(this.eO[p1] - this.eO[p2]) * f));
      this.eO[p1] += (k0 / Math.pow(this.nO[p1] + off, sh)) * m * (y - pO);
      this.eO[p2] -= (k0 / Math.pow(this.nO[p2] + off, sh)) * m * (y - pO);
      const j1 = p1 * 3 + s, j2 = p2 * 3 + s;
      const pS = 1 / (1 + Math.exp(-(this.eS[j1] - this.eS[j2]) * f));
      this.eS[j1] += (k0 / Math.pow(this.nS[j1] + off, sh)) * m * (y - pS);
      this.eS[j2] -= (k0 / Math.pow(this.nS[j2] + off, sh)) * m * (y - pS);
    }
    this.nO[p1]++; this.nO[p2]++; this.nS[p1 * 3 + s]++; this.nS[p2 * 3 + s]++;
    this.last[p1] = t; this.last[p2] = t;
  }
}

/* ------------------------------------------------------------------ */
/* B. Serve / return points + the Markov chain                          */
/* ------------------------------------------------------------------ */

const B_DEFAULT: Rec = { hl: 240, prior: 300, lam: 0.5 };
const B_GRID: Record<string, number[]> = { hl: [60, 120, 240, 365, 540, 730], prior: [75, 150, 300, 600, 1200], lam: [0, 0.25, 0.5, 0.75, 1] };
const B_KEYS = ['hl', 'prior', 'lam'];
/** serve-point mean by gender × surface (hard, clay, grass), the start of the running means */
const MU0 = [0.645, 0.625, 0.67, 0.565, 0.555, 0.585];
const clampP = (p: number) => Math.min(0.95, Math.max(0.2, p));

class BEng {
  /** per player: [overall, hard, clay, grass] × [sum, weight, time] for serve (s) and return (r) */
  s: Float64Array; r: Float64Array; mu = Float64Array.from(MU0); kd: number;
  constructor(public P: Rec, cap: number) { this.s = new Float64Array(cap * 12); this.r = new Float64Array(cap * 12); this.kd = Math.LN2 / (P.hl * DAY); }
  ensure(cap: number) {
    if (cap * 12 <= this.s.length) return;
    const g = (a: Float64Array) => { const b = new Float64Array(Math.max(cap * 12, a.length * 2)); b.set(a); return b; };
    this.s = g(this.s); this.r = g(this.r);
  }
  private devAt(a: Float64Array, j: number, t: number) {
    const w = a[j + 1];
    if (!w) return 0;
    const f = Math.exp(-(t - a[j + 2]) * this.kd);
    return (a[j] * f) / (w * f + this.P.prior);
  }
  dev(a: Float64Array, p: number, s: number, t: number) {
    const o = this.devAt(a, p * 12, t), sf = this.devAt(a, p * 12 + 3 + s * 3, t);
    return (1 - this.P.lam) * o + this.P.lam * sf;
  }
  /** serve-point chances of p1 and p2 and the four strengths behind them */
  pre(R: Rows, i: number) {
    const p1 = R.p1[i], p2 = R.p2[i], s = R.surf[i], t = R.t[i];
    const mu = this.mu[R.gen[i] * 3 + s];
    const ds1 = this.dev(this.s, p1, s, t), dr1 = this.dev(this.r, p1, s, t), ds2 = this.dev(this.s, p2, s, t), dr2 = this.dev(this.r, p2, s, t);
    return { pa: clampP(mu + ds1 - dr2), pb: clampP(mu + ds2 - dr1), mu, ds1, dr1, ds2, dr2 };
  }
  private add(a: Float64Array, j: number, t: number, w: number, x: number) {
    const f = a[j + 1] ? Math.exp(-(t - a[j + 2]) * this.kd) : 0;
    a[j] = a[j] * f + w * x; a[j + 1] = a[j + 1] * f + w; a[j + 2] = t;
  }
  update(R: Rows, i: number) {
    if (!(R.cov[i] > 0)) return;
    const pr = this.pre(R, i);
    const p1 = R.p1[i], p2 = R.p2[i], s = R.surf[i], t = R.t[i];
    const s1 = R.a_won[i] / R.a_pts[i], s2 = R.b_won[i] / R.b_pts[i];
    if (!(s1 >= 0 && s1 <= 1 && s2 >= 0 && s2 <= 1)) return;
    const w1 = R.a_pts[i] * R.cov[i], w2 = R.b_pts[i] * R.cov[i];
    // opponent-adjusted: my serve as if against an average returner; the opponent's return as if against an average server
    const obs: [Float64Array, number, number, number][] = [
      [this.s, p1, w1, s1 - pr.mu + pr.dr2], [this.r, p2, w1, pr.mu + pr.ds1 - s1],
      [this.s, p2, w2, s2 - pr.mu + pr.dr1], [this.r, p1, w2, pr.mu + pr.ds2 - s2]
    ];
    for (const [a, p, w, x] of obs) { this.add(a, p * 12, t, w, x); this.add(a, p * 12 + 3 + s * 3, t, w, x); }
    const j = R.gen[i] * 3 + s;
    this.mu[j] += 0.0015 * ((s1 + s2) / 2 - this.mu[j]);
  }
}

/** a service game won by the server (point chance p; deuce: two in a row) */
function gameP(p: number) {
  const q = 1 - p;
  return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * ((p * p) / (1 - 2 * p * q));
}
/** a tiebreak to N won by A (A serves the first point, then two each) */
function tbP(pa: number, pb: number, N: number, aFirst: boolean): number {
  const S = N + 1, P = new Float64Array(S * S);
  P[0] = 1;
  let win = 0;
  const a = pa, b = 1 - pb;
  const deuce = (a * b) / (a * b + (1 - a) * (1 - b));
  for (let sum = 0; sum <= 2 * N - 2; sum++) {
    for (let i = Math.max(0, sum - (N - 1)); i <= Math.min(N - 1, sum); i++) {
      const j = sum - i, pr = P[i * S + j];
      if (!pr) continue;
      if (i === N - 1 && j === N - 1) { win += pr * deuce; continue; }
      const aServes = (((sum + 1) >> 1) % 2 === 0) === aFirst;
      const w = aServes ? a : b;
      if (i + 1 === N) win += pr * w; else P[(i + 1) * S + j] += pr * w;
      if (j + 1 !== N) P[i * S + j + 1] += pr * (1 - w);
    }
  }
  return win;
}
/** set outcomes: index 0–4 = A 6-0…6-4, 5 = 7-5, 6 = 7-6, 7–11 = B 6-0…6-4, 12 = 5-7, 13 = 6-7 (kind 2: 0 = A, 7 = B) */
const SET_OUT: [number, number][] = [[6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 5], [7, 6], [0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 7], [6, 7]];
function setDist(pa: number, pb: number, aFirst: boolean, kind: number): Float64Array {
  const res = new Float64Array(14);
  if (kind === 2) { const w = tbP(pa, pb, 10, aFirst); res[0] = w; res[7] = 1 - w; return res; }
  const gA = gameP(pa), gB = gameP(pb);
  const P = new Float64Array(64);
  P[0] = 1;
  for (let sum = 0; sum <= 13; sum++) {
    for (let i = Math.max(0, sum - 7); i <= Math.min(7, sum); i++) {
      const j = sum - i, pr = P[i * 8 + j];
      if (!pr) continue;
      if (i === 6 && j <= 4) { res[j] += pr; continue; }
      if (j === 6 && i <= 4) { res[7 + i] += pr; continue; }
      if (i === 7) { res[j === 5 ? 5 : 6] += pr; continue; }
      if (j === 7) { res[i === 5 ? 12 : 13] += pr; continue; }
      if (i === 6 && j === 6) { const w = tbP(pa, pb, kind === 1 ? 10 : 7, aFirst); res[6] += pr * w; res[13] += pr * (1 - w); continue; }
      const aServes = ((i + j) % 2 === 0) === aFirst;
      const w = aServes ? gA : 1 - gB;
      P[(i + 1) * 8 + j] += pr * w; P[i * 8 + j + 1] += pr * (1 - w);
    }
  }
  return res;
}
interface MatchOut { win: number; first: number; sets: Record<string, number>; games: Float64Array | null }
/** The match: sets to win, the deciding-set rule, who serves first (unknown: 50/50). `games` = total games distribution. */
function matchDist(pa: number, pb: number, bo: number, rule: number, wantGames: boolean): MatchOut {
  const need = bo === 5 ? 3 : 2;
  const cache = new Map<number, Float64Array>();
  const sd = (af: boolean, kind: number) => { const k = (af ? 1 : 0) + kind * 2; let d = cache.get(k); if (!d) { d = setDist(pa, pb, af, kind); cache.set(k, d); } return d; };
  // per state: its probability and the games played so far given the state
  type St = { p: number; g: Float64Array | null };
  let cur = new Map<number, St>();
  const G = 80;
  for (const af of [0, 1]) { const g = wantGames ? new Float64Array(G) : null; if (g) g[0] = 1; cur.set(af, { p: 0.5, g }); }
  let win = 0, first = 0, setNo = 0;
  const sets: Record<string, number> = {};
  const games = wantGames ? new Float64Array(G) : null;
  while (cur.size) {
    const next = new Map<number, St>();
    for (const [key, st] of cur) {
      const af = key & 1, sa = (key >> 1) & 7, sb = key >> 4;
      const kind = sa === need - 1 && sb === need - 1 ? rule : 0;
      const d = sd(af === 1, kind);
      for (let o = 0; o < 14; o++) {
        const pr = d[o];
        if (!pr) continue;
        const aw = o < 7;
        const inc = kind === 2 ? 1 : SET_OUT[o][0] + SET_OUT[o][1];
        const p = st.p * pr;
        if (setNo === 0 && aw) first += p;
        const nsa = sa + (aw ? 1 : 0), nsb = sb + (aw ? 0 : 1), naf = inc % 2 === 1 ? 1 - af : af;
        let g: Float64Array | null = null;
        if (st.g) { g = new Float64Array(G); for (let x = 0; x + inc < G; x++) g[x + inc] = st.g[x]; }
        if (nsa === need || nsb === need) {
          if (nsa === need) win += p;
          const k = `${nsa}-${nsb}`;
          sets[k] = (sets[k] || 0) + p;
          if (g && games) for (let x = 0; x < G; x++) games[x] += p * g[x];
          continue;
        }
        const nk = naf + (nsa << 1) + (nsb << 4);
        const ex = next.get(nk);
        if (!ex) next.set(nk, { p, g });
        else { if (ex.g && g) for (let x = 0; x < G; x++) ex.g[x] = (ex.g[x] * ex.p + g[x] * p) / (ex.p + p); ex.p += p; }
      }
    }
    cur = next;
    setNo++;
  }
  return { win, first, sets, games };
}
/** win chance only, memoised on a 0.001 grid (the replays call it ~10^5 times) */
const winMemo = new Map<number, number>();
function winFast(pa: number, pb: number, bo: number, rule: number) {
  const qa = Math.round(pa * 1000), qb = Math.round(pb * 1000);
  const key = ((qa * 1001 + qb) * 6 + (bo === 5 ? 3 : 0) + rule);
  let v = winMemo.get(key);
  if (v === undefined) {
    if (winMemo.size > 600_000) winMemo.clear();
    v = matchDist(qa / 1000, qb / 1000, bo, rule, false).win;
    winMemo.set(key, v);
  }
  return v;
}
const logit = (p: number) => { const q = Math.min(0.999, Math.max(0.001, p)); return Math.log(q / (1 - q)); };
const sigma = (x: number) => 1 / (1 + Math.exp(-x));
/** the same shift on both serve-point chances (p1 up, p2 down) so the chain's win chance equals `target` */
function rescale(pa: number, pb: number, bo: number, rule: number, target: number) {
  let lo = -0.3, hi = 0.3;
  for (let k = 0; k < 22; k++) {
    const m = (lo + hi) / 2;
    if (winFast(clampP(pa + m), clampP(pb - m), bo, rule) < target) lo = m; else hi = m;
  }
  const d = (lo + hi) / 2;
  return { pa: clampP(pa + d), pb: clampP(pb - d) };
}
const OVER_LINES = { 3: [18.5, 19.5, 20.5, 21.5, 22.5, 23.5, 24.5], 5: [34.5, 35.5, 36.5, 37.5, 38.5, 39.5, 40.5] } as Record<number, number[]>;
function gamesSummary(g: Float64Array, bo: number) {
  let mean = 0, tot = 0;
  for (let x = 0; x < g.length; x++) { mean += x * g[x]; tot += g[x]; }
  mean /= tot || 1;
  let cdf = 0, median = 0;
  for (let x = 0; x < g.length; x++) { cdf += g[x] / (tot || 1); if (cdf >= 0.5) { median = x; break; } }
  const over: Record<string, number> = {};
  for (const l of OVER_LINES[bo === 5 ? 5 : 3]) { let s = 0; for (let x = Math.ceil(l); x < g.length; x++) s += g[x]; over[String(l)] = Math.round((1000 * s) / (tot || 1)) / 1000; }
  return { mean: Math.round(mean * 10) / 10, median, over };
}

/* ------------------------------------------------------------------ */
/* C. Context features                                                  */
/* ------------------------------------------------------------------ */

/** per feature, p1 minus p2 */
const FEAT = ['m3', 'm7', 'm14', 'sets7', 'hours7', 'longYesterday', 'stoppage30', 'home', 'surfaceSwitch', 'rankTrend'] as const;
const GROUPS: Record<string, number[]> = { fatigue: [0, 1, 2, 3, 4, 5], stoppage: [6], home: [7], surfaceSwitch: [8], rankTrend: [9] };
interface Past { t: number; s: number; sets: number; mins: number; won: boolean; retLost: boolean; opp: number }
class FEng {
  hist = new Map<number, Past[]>(); lastSurf = new Map<number, Float64Array>(); h2h = new Map<string, number[]>();
  constructor(public c: Ctx) {}
  one(p: number, t: number, s: number, rankNow: number, out: Float32Array, sign: number) {
    const h = this.hist.get(p) || [];
    let m3 = 0, m7 = 0, m14 = 0, sets7 = 0, min7 = 0, longY = 0, stop = 0;
    for (const x of h) {
      const d = t - x.t;
      if (d < 0) continue;
      if (d <= 3 * DAY) m3++;
      if (d <= 7 * DAY) { m7++; sets7 += x.sets; min7 += Number.isFinite(x.mins) ? x.mins : x.sets * 42; }
      if (d <= 14 * DAY) m14++;
      if (d <= 36 * 3600000 && (x.sets >= 3 || x.mins >= 150)) longY = 1;
      if (x.retLost && d <= 30 * DAY) stop = 1;
    }
    const st = this.c.stops.get(p);
    if (st) for (let k = st.length - 1; k >= 0; k--) { const d = t - st[k]; if (d > 30 * DAY) break; if (d >= 0) { stop = 1; break; } }
    const ls = this.lastSurf.get(p);
    const sw = h.length && (!ls || !ls[s] || t - ls[s] > 30 * DAY) ? 1 : 0;
    const before = rankAt(this.c, p, t - 90 * DAY, 45 * DAY);
    const trend = Number.isFinite(rankNow) && Number.isFinite(before) ? Math.log(before) - Math.log(rankNow) : 0;
    const v = [m3, m7, m14, sets7, min7 / 60, longY, stop, 0, sw, trend];
    for (let k = 0; k < v.length; k++) if (k !== 7) out[k] += sign * v[k];
  }
  pre(R: Rows, i: number): Float32Array {
    const out = new Float32Array(FEAT.length);
    this.one(R.p1[i], R.t[i], R.surf[i], R.r1[i], out, 1);
    this.one(R.p2[i], R.t[i], R.surf[i], R.r2[i], out, -1);
    out[7] = R.h1[i] - R.h2[i];
    return out;
  }
  update(R: Rows, i: number) {
    const t = R.t[i], s = R.surf[i], sets = R.sets[i] || 2, mins = R.mins[i];
    for (const [p, o, won] of [[R.p1[i], R.p2[i], R.win[i] === 1], [R.p2[i], R.p1[i], R.win[i] === 2]] as [number, number, boolean][]) {
      const h = this.hist.get(p) || [];
      h.push({ t, s, sets, mins, won, retLost: !won && R.ret[i] === 1, opp: o });
      if (h.length > 15) h.shift();
      this.hist.set(p, h);
      let ls = this.lastSurf.get(p);
      if (!ls) { ls = new Float64Array(3); this.lastSurf.set(p, ls); }
      ls[s] = t;
    }
    const a = Math.min(R.p1[i], R.p2[i]), b = Math.max(R.p1[i], R.p2[i]);
    const winnerLow = (R.win[i] === 1 ? R.p1[i] : R.p2[i]) === a ? 1 : 0;
    const k = `${a}-${b}`, l = this.h2h.get(k) || [];
    l.push(s * 2 + winnerLow);
    if (l.length > 30) l.shift();
    this.h2h.set(k, l);
  }
}

/* ------------------------------------------------------------------ */
/* D. Logistic blend (no intercept: symmetric), Newton steps            */
/* ------------------------------------------------------------------ */

interface Blend { cols: string[]; w: number[]; sd: number[] }
function solve(H: number[][], g: number[]): number[] {
  const k = g.length, A = H.map((r, i) => [...r, g[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let x = c; x <= k; x++) A[r][x] -= f * A[c][x]; }
  }
  return A.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[k] / r[i]));
}
/** X: columns (already divided by sd); rows given as a list of index arrays; y: 1 when p1 won */
async function fitLogit(X: Float32Array[], parts: Int32Array[], y: Uint8Array, w0: number[] | null, iters: number): Promise<number[]> {
  const k = X.length;
  let w = w0 ? w0.slice() : new Array(k).fill(0);
  const slice = shared;
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: k }, () => new Array(k).fill(0)), g = new Array(k).fill(0);
    for (let j = 0; j < k; j++) { H[j][j] += 1; g[j] -= w[j]; } // L2 (λ = 1 on the standardised scale)
    const x = new Float64Array(k);
    for (const part of parts) {
      for (let n = 0; n < part.length; n++) {
        const i = part[n];
        let s = 0;
        for (let j = 0; j < k; j++) { x[j] = X[j][i]; s += x[j] * w[j]; }
        const p = sigma(s), e = y[i] - p, v = p * (1 - p);
        for (let a = 0; a < k; a++) { g[a] += e * x[a]; const va = v * x[a]; for (let b = a; b < k; b++) H[a][b] += va * x[b]; }
        if ((n & 2047) === 0) await slice();
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
    const d = solve(H, g);
    w = w.map((v, j) => v + d[j]);
    if (Math.max(...d.map(Math.abs)) < 1e-5) break;
  }
  return w;
}

/* ------------------------------------------------------------------ */
/* Replays and tuning                                                   */
/* ------------------------------------------------------------------ */

const clipP = (p: number) => Math.min(0.995, Math.max(0.005, p));
const llOf = (p: number, y: number) => -(y ? Math.log(clipP(p)) : Math.log(1 - clipP(p)));
interface Monthly { ll: Float64Array; n: Float64Array }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** tuning gives way to the live sync */
async function calm() { for (let k = 0; k < 120 && tennisLiveBusy(); k++) await sleep(1000); }
const progress: { phase: string | null; detail: string | null; at: string | null; error: string | null } = { phase: null, detail: null, at: null, error: null };
const setPhase = (phase: string | null, detail: string | null = null) => { progress.phase = phase; progress.detail = detail; progress.at = new Date().toISOString(); };

async function replayA(R: Rows, P: Rec, rm: RankMap, cap: number, onPre: ((i: number, lg: number, E: AEng) => void) | null, stopT = Infinity): Promise<AEng> {
  const E = new AEng(P, rm, cap);
  const slice = shared;
  for (let i = 0; i < R.n; i++) {
    if (R.t[i] >= stopT) break;
    if (onPre) onPre(i, E.pre(R, i).logit, E);
    E.update(R, i);
    if ((i & 1023) === 0) await slice();
  }
  return E;
}
async function replayB(R: Rows, P: Rec, cap: number, onPre: ((i: number, pr: ReturnType<BEng['pre']>) => void) | null, from = -1): Promise<BEng> {
  const E = new BEng(P, cap);
  const slice = shared;
  for (let i = 0; i < R.n; i++) {
    if (onPre && R.month[i] >= from) onPre(i, E.pre(R, i));
    E.update(R, i);
    if ((i & 1023) === 0) await slice();
  }
  return E;
}
const cfgKey = (p: Rec, keys: string[]) => keys.map(k => p[k]).join(',');
async function evalMonthly(memo: Map<string, Monthly>, key: string, nm: number, run: (m: Monthly) => Promise<void>): Promise<Monthly> {
  let m = memo.get(key);
  if (m) return m;
  await calm();
  m = { ll: new Float64Array(nm), n: new Float64Array(nm) };
  await run(m);
  memo.set(key, m);
  return m;
}
const windowLL = (m: Monthly, from: number, to: number) => { let s = 0, n = 0; for (let k = Math.max(0, from); k < to; k++) { s += m.ll[k]; n += m.n[k]; } return n ? s / n : Infinity; };

/** Coordinate search over `keys`. neighbours = only the grid steps next to the current value (warm start). */
async function coord(start: Rec, grid: Record<string, number[]>, keys: string[], score: (p: Rec) => Promise<number>, passes: number, neighbours: boolean): Promise<Rec> {
  let best = { ...start }, bestS = await score(best);
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const k of keys) {
      const g = grid[k];
      let vals = g;
      if (neighbours) {
        let ix = g.indexOf(best[k]);
        if (ix < 0) ix = g.reduce((bi, v, j) => (Math.abs(v - best[k]) < Math.abs(g[bi] - best[k]) ? j : bi), 0);
        vals = [g[ix - 1], g[ix + 1]].filter(v => v !== undefined);
      }
      for (const v of vals) {
        if (v === best[k]) continue;
        const cand = { ...best, [k]: v }, s = await score(cand);
        await shared();
        if (s < bestS - 1e-6) { bestS = s; best = cand; moved = true; }
      }
    }
    if (!moved) break;
  }
  return best;
}

/** rank → Elo fitted on players with 25+ matches whose rank at the time is known (matches before `beforeT`) */
async function fitRankMap(R: Rows, cap: number, beforeT: number): Promise<RankMap> {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  const take = (E: AEng, p: number, r: number) => {
    if (!(r > 0) || E.nO[p] < 25 || !E.init[p]) return;
    const x = Math.log(r), y = E.eO[p];
    n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
  };
  await replayA(R, A_DEFAULT, RM_DEFAULT, cap, (i, _lg, E) => { take(E, R.p1[i], R.r1[i]); take(E, R.p2[i], R.r2[i]); }, beforeT);
  if (n < 300) return { ...RM_DEFAULT, n };
  const b = -(n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy + b * sx) / n;
  return Number.isFinite(a) && Number.isFinite(b) && b > 20 && b < 300 ? { a: Math.round(a), b: Math.round(b * 10) / 10, n } : { ...RM_DEFAULT, n };
}

/* ------------------------------------------------------------------ */
/* Metrics                                                              */
/* ------------------------------------------------------------------ */

const r1 = (x: number) => Math.round(x * 10) / 10, r4 = (x: number) => Math.round(x * 10000) / 10000;
function metrics(idx: number[], p: (i: number) => number, y: (i: number) => number) {
  if (!idx.length) return { n: 0 };
  let ll = 0, br = 0, hit = 0, s70 = 0, h70 = 0;
  const bands = [[50, 60], [60, 70], [70, 80], [80, 101]].map(([lo, hi]) => ({ band: hi > 100 ? `${lo}+` : `${lo}-${hi}`, lo, hi, n: 0, sum: 0, hits: 0 }));
  for (const i of idx) {
    const q = p(i), yy = y(i);
    ll += llOf(q, yy); br += (q - yy) ** 2;
    const right = (q >= 0.5 ? 1 : 0) === yy;
    if (right) hit++;
    const top = Math.max(q, 1 - q) * 100;
    const b = bands.find(x => top >= x.lo && top < x.hi);
    if (b) { b.n++; b.sum += top; if (right) b.hits++; }
    if (top >= 70) { s70++; if (right) h70++; }
  }
  const n = idx.length;
  return {
    n, hit: r1((100 * hit) / n), logLoss: r4(ll / n), brier: r4(br / n),
    calibration: bands.map(b => ({ band: b.band, n: b.n, said: b.n ? r1(b.sum / b.n) : null, happened: b.n ? r1((100 * b.hits) / b.n) : null })),
    sure70: { n: s70, hit: s70 ? r1((100 * h70) / s70) : null }
  };
}

/* ------------------------------------------------------------------ */
/* The walk-forward report                                              */
/* ------------------------------------------------------------------ */

const countWhere = (n: number, f: (i: number) => boolean) => { let c = 0; for (let i = 0; i < n; i++) if (f(i)) c++; return c; };
const lastFullMonth = () => monthIdx(Date.now()) - 1;
const FIRST_TEST = 12; // 2024-01
export function backfillReady(): boolean {
  return !!(db.prepare(`SELECT 1 FROM tennis_meta WHERE k = 'pkg:2023-01'`).get());
}

interface Settings { a: Rec; b: Rec; rm: RankMap; mode: 'blend' | 'elo' | 'point'; blend: Blend | null; strong: Record<string, { line: number; reached: boolean }>; at: string; matches: number }

export async function buildTennisReport(): Promise<any> {
  const t0 = Date.now();
  setPhase('loading matches');
  const { c, R } = await loadData();
  const cap = c.reg.size + 10;
  const lastM = lastFullMonth(), nm = Math.max(lastM + 2, FIRST_TEST + 1);
  const testMonths: number[] = [];
  for (let m = FIRST_TEST; m <= lastM; m++) testMonths.push(m);
  if (!testMonths.length) throw new Error('no full test month yet');
  const isEval = (i: number) => TESTED(R.cat[i]) && R.month[i] >= 0 && R.month[i] < nm;
  const y = (i: number) => (R.win[i] === 1 ? 1 : 0);
  // rank → Elo from the matches before the first test month
  setPhase('rank → Elo');
  const rmTest = await fitRankMap(R, cap, Date.UTC(2024, 0, 1));
  // A: one replay per setting, the log loss kept per month
  const memoA = new Map<string, Monthly>(), memoB = new Map<string, Monthly>();
  const evalA = (p: Rec) => evalMonthly(memoA, cfgKey(p, A_KEYS), nm, async m => {
    await replayA(R, p, rmTest, cap, (i, lg) => { if (isEval(i)) { m.ll[R.month[i]] += llOf(sigma(lg), y(i)); m.n[R.month[i]]++; } });
  });
  const evalB = (p: Rec) => evalMonthly(memoB, cfgKey(p, B_KEYS), nm, async m => {
    await replayB(R, p, cap, (i, pr) => { if (isEval(i)) { m.ll[R.month[i]] += llOf(winFast(pr.pa, pr.pb, R.bo[i], R.rule[i]), y(i)); m.n[R.month[i]]++; } }, 0);
  });
  const chosenA: Rec[] = [], chosenB: Rec[] = [];
  let curA = { ...A_DEFAULT }, curB = { ...B_DEFAULT };
  for (const M of testMonths) {
    setPhase('tuning', `${monthName(M)} (Elo: ${memoA.size} settings tried, point model: ${memoB.size})`);
    const first = M === FIRST_TEST;
    curA = await coord(curA, A_GRID, A_KEYS, async p => windowLL(await evalA(p), 0, M), first ? 2 : 1, !first);
    curB = await coord(curB, B_GRID, B_KEYS, async p => windowLL(await evalB(p), 0, M), first ? 2 : 1, !first);
    chosenA[M] = curA; chosenB[M] = curB;
  }
  // the chosen settings' per-match numbers (months before 2024: the Jan 2024 settings, for the blend's training rows)
  setPhase('replaying the chosen settings');
  const eloL = new Float32Array(R.n).fill(NaN), bL = new Float32Array(R.n).fill(NaN), PA = new Float32Array(R.n), PB = new Float32Array(R.n);
  const settingOf = (arr: Rec[], m: number) => arr[Math.max(FIRST_TEST, Math.min(lastM, m))];
  for (const key of new Set(testMonths.map(m => cfgKey(chosenA[m], A_KEYS)))) {
    const p = testMonths.map(m => chosenA[m]).find(x => cfgKey(x, A_KEYS) === key)!;
    await replayA(R, p, rmTest, cap, (i, lg) => { if (R.month[i] >= 0 && cfgKey(settingOf(chosenA, R.month[i]), A_KEYS) === key) eloL[i] = lg; });
  }
  for (const key of new Set(testMonths.map(m => cfgKey(chosenB[m], B_KEYS)))) {
    const p = testMonths.map(m => chosenB[m]).find(x => cfgKey(x, B_KEYS) === key)!;
    await replayB(R, p, cap, (i, pr) => {
      if (cfgKey(settingOf(chosenB, R.month[i]), B_KEYS) !== key) return;
      bL[i] = logit(winFast(pr.pa, pr.pb, R.bo[i], R.rule[i])); PA[i] = pr.pa; PB[i] = pr.pb;
    }, 0);
  }
  // C: the context features (no settings)
  setPhase('context features');
  const X: Float32Array[] = FEAT.map(() => new Float32Array(R.n));
  {
    const F = new FEng(c), slice = shared;
    for (let i = 0; i < R.n; i++) {
      if (R.month[i] >= 0) { const f = F.pre(R, i); for (let k = 0; k < FEAT.length; k++) X[k][i] = f[k]; }
      F.update(R, i);
      if ((i & 1023) === 0) await slice();
    }
  }
  // rows: tested matches from 2023 on, by month
  const byMonth: Int32Array[] = Array.from({ length: nm }, () => new Int32Array(0));
  {
    const lists: number[][] = Array.from({ length: nm }, () => []);
    for (let i = 0; i < R.n; i++) if (isEval(i) && Number.isFinite(eloL[i]) && Number.isFinite(bL[i])) lists[R.month[i]].push(i);
    lists.forEach((l, m) => { byMonth[m] = Int32Array.from(l); });
  }
  const testIdx = testMonths.flatMap(m => Array.from(byMonth[m]));
  // D: walk-forward blend (refitted each month on the months before it)
  const colsOf = (groups: string[]) => [{ name: 'elo', a: eloL }, { name: 'point', a: bL }, ...groups.flatMap(g => GROUPS[g].map(k => ({ name: FEAT[k], a: X[k] })))];
  const sdOf = (a: Float32Array) => { let s = 0, n = 0; for (let m = 0; m < nm; m++) for (const i of byMonth[m]) { s += a[i] * a[i]; n++; } return Math.sqrt(s / Math.max(1, n)) || 1; };
  const yArr = new Uint8Array(R.n); for (let i = 0; i < R.n; i++) yArr[i] = y(i);
  const wf = async (groups: string[]) => {
    const cols = colsOf(groups), sd: number[] = [], Xs: Float32Array[] = [];
    for (const [j, x] of cols.entries()) {
      sd.push(sdOf(x.a));
      const a = new Float32Array(R.n);
      for (let m = 0; m < nm; m++) for (const i of byMonth[m]) a[i] = x.a[i] / sd[j];
      Xs.push(a);
      await shared();
    }
    const p = new Float32Array(R.n).fill(NaN);
    let w: number[] | null = null;
    for (const M of testMonths) {
      await calm();
      w = await fitLogit(Xs, byMonth.slice(0, M), yArr, w, w ? 3 : 8);
      for (const i of byMonth[M]) { let s = 0; for (let j = 0; j < Xs.length; j++) s += Xs[j][i] * w[j]; p[i] = sigma(s); }
    }
    let ll = 0; for (const i of testIdx) ll += llOf(p[i], yArr[i]);
    return { p, ll: ll / Math.max(1, testIdx.length) };
  };
  setPhase('blend', 'Elo + point model');
  let best = await wf([]);
  const kept: string[] = [], tried: { group: string; logLoss: number; kept: boolean }[] = [];
  for (const g of Object.keys(GROUPS)) {
    setPhase('blend', `+ ${g}`);
    const cand = await wf([...kept, g]);
    const keep = cand.ll < best.ll - 0.0003;
    tried.push({ group: g, logLoss: r4(cand.ll), kept: keep });
    if (keep) { kept.push(g); best = cand; }
  }
  const pA = (i: number) => sigma(eloL[i]), pB = (i: number) => sigma(bL[i]);
  const llA = testIdx.reduce((s, i) => s + llOf(pA(i), yArr[i]), 0) / Math.max(1, testIdx.length);
  const llB = testIdx.reduce((s, i) => s + llOf(pB(i), yArr[i]), 0) / Math.max(1, testIdx.length);
  const mode: Settings['mode'] = best.ll < llA && best.ll < llB ? 'blend' : llA <= llB ? 'elo' : 'point';
  const pF = (i: number) => (mode === 'blend' ? best.p[i] : mode === 'elo' ? pA(i) : pB(i));
  logger.info(`${TENNIS_MODEL} walk-forward: Elo LL ${r4(llA)}, point model ${r4(llB)}, blend ${r4(best.ll)} (${kept.join(', ') || 'no context'}) → ${mode}`);
  // sets and totals from the chain, shifted to the final win chance
  setPhase('sets and totals');
  const setsHit = new Uint8Array(R.n), gMean = new Float32Array(R.n).fill(NaN), ouRight = new Uint8Array(R.n), ouN = new Uint8Array(R.n);
  {
    const slice = shared;
    for (const i of testIdx) {
      if (R.ret[i] || !R.sets[i] || !Number.isFinite(R.games[i])) continue;
      const sc = rescale(PA[i], PB[i], R.bo[i], R.rule[i], pF(i));
      const d = matchDist(sc.pa, sc.pb, R.bo[i], R.rule[i], true);
      const likely = Object.entries(d.sets).sort((a, b) => b[1] - a[1])[0]?.[0];
      setsHit[i] = likely === `${R.sw1[i]}-${R.sw2[i]}` ? 1 : 0;
      const gs = gamesSummary(d.games!, R.bo[i]);
      gMean[i] = gs.mean;
      const line = gs.median + 0.5;
      let over = 0; for (let x = Math.ceil(line); x < d.games!.length; x++) over += d.games![x];
      ouN[i] = 1; ouRight[i] = (over >= 0.5) === (R.games[i] > line) ? 1 : 0;
      await slice();
    }
  }
  const setsTotals = (idx: number[]) => {
    const s = idx.filter(i => ouN[i]);
    return s.length ? { n: s.length, likelySetScoreHit: r1((100 * s.filter(i => setsHit[i]).length) / s.length), totalGamesMAE: r1(s.reduce((a, i) => a + Math.abs(gMean[i] - R.games[i]), 0) / s.length), overUnderAtMedian: r1((100 * s.filter(i => ouRight[i]).length) / s.length) } : { n: 0 };
  };
  // the rank baseline: the rank at the time where we know it, else today's ranking (look-ahead: flatters the baseline)
  const rankBase = (idx: number[]) => {
    let n = 0, hit = 0, current = 0;
    for (const i of idx) {
      let a = R.r1[i], b = R.r2[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { a = c.playerRank.get(c.reg.pid[R.p1[i]]) ?? NaN; b = c.playerRank.get(c.reg.pid[R.p2[i]]) ?? NaN; if (Number.isFinite(a) && Number.isFinite(b)) current++; }
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
      n++; if ((a < b ? 1 : 0) === yArr[i]) hit++;
    }
    return { n, hit: n ? r1((100 * hit) / n) : null, withTodaysRanking: current };
  };
  const block = async (idx: number[]) => {
    const model = metrics(idx, pF, y); await yieldLoop();
    const baselines = { higherRanked: rankBase(idx), eloOnly: metrics(idx, pA, y), pointModelOnly: metrics(idx, pB, y) }; await yieldLoop();
    return { model, baselines, setsAndTotals: setsTotals(idx) };
  };
  const tours: Record<string, any> = { all: await block(testIdx) };
  for (const cat of [0, 1, 2, 3]) tours[CAT_NAME[cat]] = await block(testIdx.filter(i => R.cat[i] === cat));
  const surfaces: Record<string, any> = {};
  for (let s = 0; s < 3; s++) {
    const ix = testIdx.filter(i => R.surf[i] === s);
    surfaces[SURF_NAME[s]] = { ...(await block(ix)), byTour: Object.fromEntries([0, 1, 2, 3].map(cat => [CAT_NAME[cat], metrics(ix.filter(i => R.cat[i] === cat), pF, y)])) };
  }
  // strong pick line per tour: the lowest of 65 / 70 / 75 where the test hit rate is at least 75%
  const strong: Settings['strong'] = {};
  for (const cat of [0, 1, 2, 3]) {
    const ix = testIdx.filter(i => R.cat[i] === cat);
    let found: number | null = null;
    for (const line of [65, 70, 75]) {
      const s = ix.filter(i => Math.max(pF(i), 1 - pF(i)) * 100 >= line);
      if (s.length >= 30 && s.filter(i => (pF(i) >= 0.5 ? 1 : 0) === yArr[i]).length / s.length >= 0.75) { found = line; break; }
    }
    strong[CAT_NAME[cat]] = { line: found ?? 75, reached: found !== null };
  }
  const months = testMonths.map(M => {
    const ix = Array.from(byMonth[M]);
    const m = metrics(ix, pF, y) as any;
    return { month: monthName(M), n: m.n, hit: m.hit ?? null, logLoss: m.logLoss ?? null, elo: chosenA[M], point: chosenB[M] };
  });
  for (const k of ['all', 'slam', 'atp', 'wta', 'challenger']) {
    const t = tours[k], m = t.model;
    if (m.n) logger.info(`${TENNIS_MODEL} ${k}: hit ${m.hit}% LL ${m.logLoss} Brier ${m.brier} over ${m.n} matches (Elo ${t.baselines.eloOnly.hit}% / ${t.baselines.eloOnly.logLoss}, point ${t.baselines.pointModelOnly.hit}% / ${t.baselines.pointModelOnly.logLoss}, higher rank ${t.baselines.higherRanked.hit}%) · sets ${t.setsAndTotals.likelySetScoreHit}% · games MAE ${t.setsAndTotals.totalGamesMAE}`);
  }
  // the tested ATP / WTA / Slam predictions, for the market benchmark
  const bench: Record<string, [number, number, number]> = {};
  for (const i of testIdx) if (R.id[i] > 0 && R.cat[i] <= 2) bench[String(R.id[i])] = [r4(pF(i)), r4(pA(i)), r4(pB(i))];
  store.set('test_preds', bench);
  const report = {
    model: TENNIS_MODEL, builtAt: new Date().toISOString(), minutes: r1((Date.now() - t0) / 60000),
    test: { from: monthName(FIRST_TEST), to: monthName(lastM), months: testMonths.length, matches: testIdx.length },
    mode, walkForwardLogLoss: { eloOnly: r4(llA), pointModelOnly: r4(llB), blend: r4(best.ll) }, context: { tried, kept },
    rankToElo: rmTest, tours, surfaces, strong, months,
    settingsTried: { elo: memoA.size, pointModel: memoB.size },
    data: {
      matches: R.n, players: c.reg.size, withStats: countWhere(R.n, i => R.cov[i] > 0),
      byTour: Object.fromEntries(CAT_NAME.map((n, cat) => [n, countWhere(R.n, i => R.cat[i] === cat)])),
      matchTiebreakEvents: [...c.ruleOfKey.values()].filter(v => v === 2).length, archivePlayersMapped: [...c.archMap.values()].length
    }
  };
  store.set('report', report);
  // live settings: tuned on everything, the blend fitted on every row
  setPhase('live settings');
  const live = await tuneLive(R, c, cap, nm, curA, curB, kept, mode, strong);
  setPhase(null);
  void live;
  return report;
}

/** The live settings: A and B tuned on 2023 → now (warm start from the last test month), the blend on every row. */
async function tuneLive(R: Rows, c: Ctx, cap: number, nm: number, startA: Rec, startB: Rec, groups: string[], mode: Settings['mode'], strong: Settings['strong']): Promise<Settings> {
  const rm = await fitRankMap(R, cap, Infinity);
  const isEval = (i: number) => TESTED(R.cat[i]) && R.month[i] >= 0;
  const y = (i: number) => (R.win[i] === 1 ? 1 : 0);
  const memoA = new Map<string, Monthly>(), memoB = new Map<string, Monthly>();
  const scoreA = async (p: Rec) => windowLL(await evalMonthly(memoA, cfgKey(p, A_KEYS), nm, async m => {
    await replayA(R, p, rm, cap, (i, lg) => { if (isEval(i)) { m.ll[0] += llOf(sigma(lg), y(i)); m.n[0]++; } });
  }), 0, 1);
  const scoreB = async (p: Rec) => windowLL(await evalMonthly(memoB, cfgKey(p, B_KEYS), nm, async m => {
    await replayB(R, p, cap, (i, pr) => { if (isEval(i)) { m.ll[0] += llOf(winFast(pr.pa, pr.pb, R.bo[i], R.rule[i]), y(i)); m.n[0]++; } }, 0);
  }), 0, 1);
  const a = await coord(startA, A_GRID, A_KEYS, scoreA, 1, true);
  const b = await coord(startB, B_GRID, B_KEYS, scoreB, 1, true);
  let blend: Blend | null = null;
  if (mode === 'blend') {
    const eloL = new Float32Array(R.n).fill(NaN), bL = new Float32Array(R.n).fill(NaN);
    await replayA(R, a, rm, cap, (i, lg) => { if (R.month[i] >= 0) eloL[i] = lg; });
    await replayB(R, b, cap, (i, pr) => { bL[i] = logit(winFast(pr.pa, pr.pb, R.bo[i], R.rule[i])); }, 0);
    const X: Float32Array[] = FEAT.map(() => new Float32Array(R.n));
    const F = new FEng(c), slice = shared;
    for (let i = 0; i < R.n; i++) { if (R.month[i] >= 0) { const f = F.pre(R, i); for (let k = 0; k < FEAT.length; k++) X[k][i] = f[k]; } F.update(R, i); if ((i & 1023) === 0) await slice(); }
    const rows: number[] = [];
    for (let i = 0; i < R.n; i++) if (isEval(i) && Number.isFinite(eloL[i]) && Number.isFinite(bL[i])) rows.push(i);
    const cols = [{ name: 'elo', a: eloL }, { name: 'point', a: bL }, ...groups.flatMap(g => GROUPS[g].map(k => ({ name: FEAT[k] as string, a: X[k] })))];
    const sd: number[] = [], Xs: Float32Array[] = [];
    for (const x of cols) {
      const v = Math.sqrt(rows.reduce((s, i) => s + x.a[i] * x.a[i], 0) / Math.max(1, rows.length)) || 1;
      const o = new Float32Array(R.n); for (const i of rows) o[i] = x.a[i] / v;
      sd.push(v); Xs.push(o);
      await shared();
    }
    const yArr = new Uint8Array(R.n); for (const i of rows) yArr[i] = y(i);
    const w = await fitLogit(Xs, [Int32Array.from(rows)], yArr, null, 10);
    blend = { cols: cols.map(x => x.name), w, sd };
  }
  const s: Settings = { a, b, rm, mode, blend, strong, at: new Date().toISOString(), matches: R.n };
  store.set('settings', s);
  logger.info(`${TENNIS_MODEL}: live settings stored (${mode}${blend ? `: ${blend.cols.join(', ')}` : ''}; K0 ${a.k0}, shape ${a.shape}, half-life ${b.hl} d)`);
  liveState = null; // the next tick replays with the new settings
  return s;
}

/** Weekly: the live settings only (the report is rebuilt when a new full month is in). */
async function retuneLive() {
  const s: Settings | null = store.get('settings');
  const rep = store.get('report');
  if (!s || !rep) return buildTennisReport();
  setPhase('weekly re-tune: loading');
  const { c, R } = await loadData();
  const cap = c.reg.size + 10, nm = Math.max(lastFullMonth() + 2, FIRST_TEST + 1);
  setPhase('weekly re-tune');
  const out = await tuneLive(R, c, cap, nm, s.a, s.b, rep.context?.kept || [], rep.mode || s.mode, rep.strong || s.strong);
  setPhase(null);
  return out;
}

/* ------------------------------------------------------------------ */
/* Market benchmark (admin only, never public)                          */
/* ------------------------------------------------------------------ */

/** the last pre-start quote of a price history: probability from the mid (decimal odds → 1 / odds), normalised */
function preStartPrice(rows: any[], start: number): { p1: number; at: string } | null {
  let pick: any = null;
  for (const r of rows) {
    const at = Date.parse(r?.at || '');
    const love = sumArr(r?.sets) === 0 && sumArr(Array.isArray(r?.games) ? r.games.flat() : r?.games) === 0 && (!r?.score || /^0\D+0$|^$/.test(String(r.score).trim()));
    if ((Number.isFinite(at) && at <= start) || love) pick = r; else if (pick) break;
  }
  const q = (k: string) => { const m = Number(pick?.prices?.[k]?.mid); return m > 0 ? (m <= 1 ? m : 1 / m) : NaN; };
  const a = q('1'), b = q('2');
  return pick && a > 0 && b > 0 ? { p1: a / (a + b), at: pick.at } : null;
}
export async function runMarketBench(max = 500): Promise<string> {
  const preds: Record<string, number[]> = store.get('test_preds') || {};
  const have = new Set((db.prepare(`SELECT match_id FROM tennis_market_bench`).all() as any[]).map(r => r.match_id as number));
  const need = max - have.size;
  if (need <= 0) return 'benchmark complete';
  const ids = Object.keys(preds).map(Number).filter(id => !have.has(id));
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const up = db.prepare(`INSERT OR REPLACE INTO tennis_market_bench (match_id, p1, at, rows, fetched_at) VALUES (?, ?, ?, ?, ?)`);
  let n = 0;
  for (const id of ids.slice(0, need)) {
    let rows: any[] | null;
    try { rows = await fetchHistoryPrices(id); } catch (e: any) { return `paused after ${n}: ${e.message}`; }
    const m = db.prepare(`SELECT scheduled_at FROM tennis_matches WHERE id = ?`).get(id) as any;
    const pr = rows ? preStartPrice(rows, Date.parse(m?.scheduled_at || '') || Infinity) : null;
    up.run(id, pr ? pr.p1 : null, pr ? pr.at : null, rows ? rows.length : 0, new Date().toISOString());
    n++;
    await yieldLoop();
  }
  return `${n} price histories read`;
}
function marketBench() {
  const preds: Record<string, number[]> = store.get('test_preds') || {};
  const rows = (db.prepare(`SELECT b.match_id, b.p1, m.winner FROM tennis_market_bench b JOIN tennis_matches m ON m.id = b.match_id WHERE b.p1 IS NOT NULL AND m.winner IN (1, 2)`).all() as any[])
    .filter(r => preds[String(r.match_id)]);
  const tried = (db.prepare(`SELECT COUNT(*) AS n FROM tennis_market_bench`).get() as any).n;
  if (!rows.length) return { tried, withPrice: 0 };
  const idx = rows.map((_, i) => i), y = (i: number) => (rows[i].winner === 1 ? 1 : 0);
  return {
    tried, withPrice: rows.length,
    market: metrics(idx, i => rows[i].p1, y), model: metrics(idx, i => preds[String(rows[i].match_id)][0], y),
    eloOnly: metrics(idx, i => preds[String(rows[i].match_id)][1], y), pointModelOnly: metrics(idx, i => preds[String(rows[i].match_id)][2], y)
  };
}

/* ------------------------------------------------------------------ */
/* Live: ratings after each result, predictions of the next 48 h        */
/* ------------------------------------------------------------------ */

/**
 * fix194: the ratings are built once (and again when the settings change, or after 7 days for restated old results);
 * new results are added incrementally. `changed` = when each player's rating last moved (the predictions of the next 48 h
 * are only recomputed for players whose ratings moved since).
 */
interface LiveState { s: Settings; c: Ctx; A: AEng; B: BEng; F: FEng; builtAt: number; lastT: number; recent: Set<number>; stale: boolean; changed: Map<number, number> }
let liveState: LiveState | null = null;
let liveBuilding: Promise<unknown> | null = null;
const REBUILD_MS = 7 * DAY;

async function buildLive(): Promise<void> {
  const s: Settings | null = store.get('settings');
  if (!s) return;
  const { c, R } = await loadData();
  const cap = c.reg.size + 5000;
  const A = new AEng(s.a, s.rm, cap), B = new BEng(s.b, cap), F = new FEng(c);
  const slice = shared, recent = new Set<number>();
  for (let i = 0; i < R.n; i++) {
    A.update(R, i); B.update(R, i); F.update(R, i);
    if (R.t[i] > Date.now() - 30 * DAY) recent.add(R.id[i]);
    if ((i & 511) === 0) await slice();
  }
  liveState = { s, c, A, B, F, builtAt: Date.now(), lastT: R.n ? R.t[R.n - 1] : 0, recent, stale: false, changed: new Map() };
}
/** the ratings need a full replay: none yet, other settings, or a week old */
function needsBuild(): boolean {
  const L = liveState;
  if (!L || L.stale || Date.now() - L.builtAt > REBUILD_MS) return true;
  const s: Settings | null = store.get('settings');
  return !!s && s.at !== L.s.at;
}
/** pages (player model): the replay is queued as a heavy job; the old ratings serve until the new ones are ready */
function ensureLive(): LiveState | null {
  if (!needsBuild()) return liveState;
  if (!liveBuilding) {
    liveBuilding = heavy('tennis ratings', () => (needsBuild() ? timed('tennis ratings', async () => { await buildLive(); refreshSnap(); }) : undefined))
      .catch(e => { logger.warn(`${TENNIS_MODEL} replay: ${e.message}`); }).finally(() => { liveBuilding = null; });
  }
  return liveState;
}
const grow = (L: LiveState) => { L.A.ensure(L.c.reg.size + 10); L.B.ensure(L.c.reg.size + 10); };

/**
 * Finished matches since the last look → the live ratings (in time order; an old one → the weekly full replay).
 * fix194: read in keyset pages of 1,000 and replayed in slices (was up to 8,000 rows in one go after every results sync).
 */
export async function applyNewResults(): Promise<number> {
  const L = liveState;
  if (!L || L.stale) return 0;
  const PAGE = 1000, MAX = 8000;
  const same = db.prepare(`${MATCH_SQL} WHERE ${DONE_WHERE} AND m.scheduled_at = ? AND m.id > ? ORDER BY m.id LIMIT ${PAGE}`);
  const later = db.prepare(`${MATCH_SQL} WHERE ${DONE_WHERE} AND m.scheduled_at > ? ORDER BY m.scheduled_at, m.id LIMIT ?`);
  const rows: any[] = [];
  let at = new Date(L.lastT - 3 * DAY - 1).toISOString(), id = 0, first = true;
  while (rows.length < MAX) {
    let page = first ? [] : (same.all(at, id) as any[]);
    first = false;
    if (page.length < PAGE) page = page.concat(later.all(at, PAGE - page.length) as any[]);
    if (!page.length) break;
    for (const r of page) if (!L.recent.has(r.id)) rows.push(r);
    const l = page[page.length - 1]; at = l.scheduled_at; id = l.id;
    await yieldLoop();
  }
  if (!rows.length || liveState !== L) return 0;
  const slice = shared;
  const R = new Rows(rows.length);
  for (let k = 0; k < rows.length; k++) { parseInto(L.c, R, rows[k], false); if ((k & 127) === 0) await slice(); }
  applyRules(L.c, R);
  grow(L);
  let n = 0;
  const now = Date.now();
  for (let i = 0; i < R.n; i++) {
    // an old row touched again (a tape added, a restatement): left to the weekly full replay
    if (R.t[i] < L.lastT - 3 * DAY || L.recent.has(R.id[i])) continue;
    L.A.update(R, i); L.B.update(R, i); L.F.update(R, i);
    L.changed.set(R.p1[i], now); L.changed.set(R.p2[i], now);
    L.recent.add(R.id[i]); L.lastT = Math.max(L.lastT, R.t[i]); n++;
    if ((i & 255) === 0) await slice();
  }
  return n;
}

export interface TennisPred {
  p1: number; p2: number; pick: 1 | 2; strong: boolean; cat: string; model: string; firstSetP1: number;
  sets: Record<string, number>; games: ReturnType<typeof gamesSummary>; why: string[];
  numbers: { eloSurface: [number, number]; eloOverall: [number, number]; servePoint: [number, number]; pElo: number; pPoint: number; mode: string }
}
function predictRow(L: LiveState, R: Rows, i: number, names: [string, string]): TennisPred {
  const s = L.s;
  const a = L.A.pre(R, i), b = L.B.pre(R, i), f = L.F.pre(R, i);
  const pE = sigma(a.logit), pP = winFast(b.pa, b.pb, R.bo[i], R.rule[i]);
  let p = s.mode === 'elo' ? pE : s.mode === 'point' ? pP : pE;
  if (s.mode === 'blend' && s.blend) {
    const val = (name: string) => (name === 'elo' ? a.logit : name === 'point' ? logit(pP) : f[FEAT.indexOf(name as any)]);
    p = sigma(s.blend.cols.reduce((acc, name, j) => acc + (val(name) / s.blend!.sd[j]) * s.blend!.w[j], 0));
  }
  const sc = rescale(b.pa, b.pb, R.bo[i], R.rule[i], p);
  const d = matchDist(sc.pa, sc.pb, R.bo[i], R.rule[i], true);
  const cat = CAT_NAME[R.cat[i]];
  const line = (s.strong[cat]?.line ?? 75) / 100;
  const pct = (x: number) => Math.round(x * 1000) / 10;
  return {
    p1: pct(p), p2: pct(1 - p), pick: p >= 0.5 ? 1 : 2, strong: TESTED(R.cat[i]) && Math.max(p, 1 - p) >= line, cat, model: TENNIS_MODEL,
    firstSetP1: pct(d.first), sets: Object.fromEntries(Object.entries(d.sets).sort().map(([k, v]) => [k, pct(v)])), games: gamesSummary(d.games!, R.bo[i]),
    why: whyLines(L, R, i, names, a, b, f),
    numbers: { eloSurface: [Math.round(a.a.s), Math.round(a.b.s)], eloOverall: [Math.round(a.a.o), Math.round(a.b.o)], servePoint: [pct(b.pa), pct(b.pb)], pElo: pct(pE), pPoint: pct(pP), mode: s.mode }
  };
}
/** "Why" lines from fixed rules (admin view; plain English) */
function whyLines(L: LiveState, R: Rows, i: number, nm: [string, string], a: ReturnType<AEng['pre']>, b: ReturnType<BEng['pre']>, f: Float32Array): string[] {
  const out: string[] = [], surf = SURF_NAME[R.surf[i]];
  const gap = Math.round(a.a.r - a.b.r);
  if (Math.abs(gap) >= 40) out.push(`${gap > 0 ? nm[0] : nm[1]} is rated ${Math.abs(gap)} Elo points higher on ${surf}.`);
  const sp = (x: number) => Math.round(x * 1000) / 10;
  if (Math.abs(b.pa - b.pb) >= 0.02) out.push(`Serve and return: ${nm[0]} should win ${sp(b.pa)}% of service points, ${nm[1]} ${sp(b.pb)}%.`);
  const hist = (p: number) => L.F.hist.get(p) || [];
  const recent7 = (p: number) => hist(p).filter(x => R.t[i] - x.t <= 7 * DAY && R.t[i] >= x.t).length;
  for (const [k, p] of [[0, R.p1[i]], [1, R.p2[i]]] as [number, number][]) {
    const h = hist(p), lastM = h[h.length - 1];
    if (lastM && R.t[i] - lastM.t <= 36 * 3600000 && (lastM.sets >= 3 || lastM.mins >= 150)) out.push(`${nm[k]} played a long match ${R.t[i] - lastM.t <= 20 * 3600000 ? 'today' : 'yesterday'}${Number.isFinite(lastM.mins) ? ` (${Math.round(lastM.mins)} minutes)` : ''}.`);
    if (L.A.last[p] && R.t[i] - L.A.last[p] >= BREAK) out.push(`${nm[k]} returns after ${Math.round((R.t[i] - L.A.last[p]) / DAY)} days without a match.`);
  }
  if (Math.abs(f[1]) >= 2) out.push(`Fatigue: ${nm[0]} played ${recent7(R.p1[i])} matches in the last 7 days, ${nm[1]} ${recent7(R.p2[i])}.`);
  const form = (p: number) => { const h = hist(p).slice(-10); return { w: h.filter(x => x.won).length, n: h.length }; };
  const f1 = form(R.p1[i]), f2 = form(R.p2[i]);
  if (f1.n >= 5 && f2.n >= 5 && Math.abs(f1.w - f2.w) >= 3) out.push(`Form: ${nm[0]} won ${f1.w} of the last ${f1.n}, ${nm[1]} ${f2.w} of ${f2.n}.`);
  const lo = Math.min(R.p1[i], R.p2[i]), hi = Math.max(R.p1[i], R.p2[i]);
  const meet = (L.F.h2h.get(`${lo}-${hi}`) || []).filter(x => x >> 1 === R.surf[i]);
  if (meet.length >= 3) {
    const lowWins = meet.filter(x => x & 1).length, p1Wins = R.p1[i] === lo ? lowWins : meet.length - lowWins;
    out.push(`Head-to-head on ${surf}: ${p1Wins > meet.length - p1Wins ? `${nm[0]} leads ${p1Wins}-${meet.length - p1Wins}` : p1Wins < meet.length - p1Wins ? `${nm[1]} leads ${meet.length - p1Wins}-${p1Wins}` : `level ${p1Wins}-${p1Wins}`}.`);
  }
  if (f[6] !== 0) out.push(`${f[6] > 0 ? nm[0] : nm[1]} had a medical stoppage or retired in the last 30 days.`);
  return out;
}

/**
 * Predictions of the next 48 h (not started), saved until the start; the first version is remembered.
 * fix194: incremental — a match is recomputed only when it has no prediction yet, when the ratings were rebuilt or one of
 * its players' ratings moved since its prediction, or when its prediction is 6 hours old (time, tier or surface changed);
 * written 200 rows per transaction with yields (all 3,000 were written in one block).
 */
let predsSkipped = 0;
export async function saveTennisPredictions(): Promise<number> {
  const L = liveState;
  if (!L) return 0;
  const now = new Date();
  const rows = db.prepare(`${MATCH_SQL} WHERE m.status = 'upcoming' AND m.p1_id IS NOT NULL AND m.p2_id IS NOT NULL AND m.scheduled_at > ? AND m.scheduled_at < ?
    AND COALESCE(m.draw, 'singles') = 'singles' ORDER BY m.scheduled_at LIMIT 3000`).all(now.toISOString(), new Date(now.getTime() + 48 * 3600000).toISOString()) as any[];
  const madeAt = db.prepare(`SELECT made_at FROM tennis_predictions WHERE match_id = ?`);
  const slice = shared;
  const R = new Rows(rows.length);
  const names: [string, string][] = [];
  predsSkipped = 0;
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    if ((k & 127) === 0) await slice();
    if (!parseInto(L.c, R, { ...r, winner: 0 }, true)) continue;
    const i = R.n - 1;
    const prev = Date.parse((madeAt.get(r.id) as any)?.made_at || '');
    const moved = Math.max(L.builtAt, L.changed.get(R.p1[i]) || 0, L.changed.get(R.p2[i]) || 0);
    if (Number.isFinite(prev) && prev > moved && now.getTime() - prev < 6 * 3600000) { R.n--; predsSkipped++; continue; } // unchanged
    names.push([r.p1_name || 'Player 1', r.p2_name || 'Player 2']);
  }
  applyRules(L.c, R);
  grow(L);
  const UP = `INSERT INTO tennis_predictions (match_id, model, scheduled_at, cat, p1, sets, games, first_set_p1, why, made_at, first_p1, first_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET model = excluded.model, scheduled_at = excluded.scheduled_at, cat = excluded.cat,
    p1 = excluded.p1, sets = excluded.sets, games = excluded.games, first_set_p1 = excluded.first_set_p1, why = excluded.why, made_at = excluded.made_at
    WHERE tennis_predictions.scheduled_at IS NULL OR tennis_predictions.scheduled_at > excluded.made_at`;
  const out: { id: number; at: string; pr: TennisPred }[] = [];
  for (let i = 0; i < R.n; i++) {
    out.push({ id: R.id[i], at: new Date(R.t[i]).toISOString(), pr: predictRow(L, R, i, names[i]) });
    await slice();
  }
  const at = new Date().toISOString();
  // a match that started while we were computing keeps the prediction it had at the start (and the SQL guard above)
  const params = (o: typeof out[number]) => [o.id, o.pr.model, o.at, o.pr.cat, o.pr.p1 / 100, JSON.stringify(o.pr.sets), JSON.stringify(o.pr.games), o.pr.firstSetP1 / 100,
    JSON.stringify({ lines: o.pr.why, numbers: o.pr.numbers }), at, o.pr.p1 / 100, at];
  if (sink) { for (const o of out) if (Date.parse(o.at) > Date.now()) sink.push({ sql: UP, params: params(o) }); return out.length; } // fix200: the worker
  const up = db.prepare(UP);
  for (let k = 0; k < out.length; k += 200) {
    db.exec('BEGIN');
    try {
      for (const o of out.slice(k, k + 200)) if (Date.parse(o.at) > Date.now()) up.run(...params(o));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    await yieldLoop();
  }
  return out.length;
}

/* ------------------------------------------------------------------ */
/* Admin routes' data                                                   */
/* ------------------------------------------------------------------ */

export function tennisPredictions(o: { status?: string; tour?: string; limit?: number }) {
  const done = o.status === 'done';
  const cat = CAT_NAME.includes(o.tour as any) ? String(o.tour) : null;
  const limit = Math.min(1000, Math.max(1, Number(o.limit) || 200));
  const deployDay: string = store.get('deploy_day') || '2026-10-19';
  const rows = db.prepare(`SELECT p.*, m.tournament, m.tier, m.surface, m.round, m.best_of, m.p1_name, m.p2_name, m.status, m.winner, m.outcome, m.games AS score
    FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
    WHERE ${done ? `m.status = 'completed'` : `m.status <> 'completed' AND p.scheduled_at >= ?`} ${cat ? 'AND p.cat = ?' : ''}
    ORDER BY p.scheduled_at ${done ? 'DESC' : 'ASC'} LIMIT ?`).all(...[done ? null : new Date(Date.now() - 6 * 3600000).toISOString(), cat, limit].filter(x => x !== null) as any[]) as any[];
  const parse = (x: string | null) => { try { return x ? JSON.parse(x) : null; } catch { return null; } };
  const void_ = (r: any) => /walkover|abandoned|unresolved/.test(String(r.outcome || '')) || !(r.winner === 1 || r.winner === 2);
  const list = rows.map(r => ({
    matchId: r.match_id, start: r.scheduled_at, tour: r.cat, tournament: r.tournament, tier: r.tier, surface: r.surface, round: r.round, bestOf: r.best_of,
    p1: r.p1_name, p2: r.p2_name, chanceP1: Math.round(r.p1 * 1000) / 10, firstChanceP1: r.first_p1 == null ? null : Math.round(r.first_p1 * 1000) / 10,
    pick: r.p1 >= 0.5 ? r.p1_name : r.p2_name, firstSetP1: r.first_set_p1 == null ? null : Math.round(r.first_set_p1 * 1000) / 10,
    sets: parse(r.sets), games: parse(r.games), why: parse(r.why), madeAt: r.made_at,
    outcome: r.status === 'completed' ? { winner: r.winner === 1 ? r.p1_name : r.winner === 2 ? r.p2_name : null, how: r.outcome, score: parse(r.score), void: void_(r), hit: void_(r) ? null : (r.p1 >= 0.5) === (r.winner === 1) } : null
  }));
  // the live record: predictions made before the start, from the deploy day, finished and not void
  const rec = db.prepare(`SELECT p.p1, p.cat, m.winner FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
    WHERE m.status = 'completed' AND m.winner IN (1, 2) AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')
      AND p.made_at <= p.scheduled_at AND p.scheduled_at >= ?`).all(`${deployDay}T00:00:00Z`) as any[];
  const bandsOf = (rs: any[]) => { const x = rs.map(r => ({ p: Math.max(r.p1, 1 - r.p1), hit: (r.p1 >= 0.5) === (r.winner === 1) })); return { n: x.length, bands: winnerBands(x), byConfidence: winnerByConfidence(x) }; };
  return {
    model: TENNIS_MODEL, status: done ? 'done' : 'upcoming', tour: cat, count: list.length, predictions: list,
    record: { since: deployDay, all: bandsOf(rec.filter(r => r.cat !== 'itf')), byTour: Object.fromEntries(CAT_NAME.map(c => [c, bandsOf(rec.filter(r => r.cat === c))])) }
  };
}

export function tennisModelReport() {
  const s: Settings | null = store.get('settings');
  const st = remote && !workerOff ? remote : localState();
  return {
    model: TENNIS_MODEL, ready: backfillReady(), running: st.busy, progress: st.progress, lastTick: st.lastTick,
    report: store.get('report'), live: s ? { mode: s.mode, at: s.at, elo: s.a, pointModel: s.b, rankToElo: s.rm, blend: s.blend, strong: s.strong, matches: s.matches } : null,
    ratings: st.ratings,
    worker: workerInfo(),
    marketBenchmark: marketBench()
  };
}
const localState = (): WorkerState => ({
  busy, progress: { ...progress }, lastTick,
  ratings: liveState ? { builtAt: new Date(liveState.builtAt).toISOString(), players: liveState.c.reg.size, lastResult: new Date(liveState.lastT).toISOString() } : null
});

/* ------------------------------------------------------------------ */
/* Jobs                                                                 */
/* ------------------------------------------------------------------ */

let busy = false;
let lastTick: { at: string; info: string } | null = null;
function israelNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  return { day: parts.find(p => p.type === 'weekday')?.value || '', hour: Number(parts.find(p => p.type === 'hour')?.value) };
}
/**
 * Heavy work (report / re-tune) in the background; then ratings + predictions. `force` = admin ?rebuild=1.
 * fix200: in the worker thread when it runs (else in-process, in the heavy() queue).
 */
export async function tennisModelTick(force: 'report' | 'retune' | null = null): Promise<void> {
  if (IN_WORKER) { await tickHere(force); return; }
  if (useWorker()) {
    try {
      const r = await callWorker({ cmd: 'tick', force });
      // the benchmark reads the provider's price histories (the main thread keeps the tennis API budget)
      if (r.reportBuilt) void heavy('tennis benchmark', () => timed('tennis benchmark', runMarketBench)).then(x => { if (x) logger.info(`${TENNIS_MODEL} benchmark: ${x}`); }).catch(e => logger.warn(`${TENNIS_MODEL} benchmark: ${e.message}`));
      return;
    } catch (e: any) {
      logger.warn(`${TENNIS_MODEL} worker: ${e.message}${workerOff ? ' (in-process from now on)' : ''}`);
      if (!workerOff) return;
    }
  }
  await heavy('tennis model', () => timed('tennis model', async () => { if ((await tickHere(force)).reportBuilt) await runMarketBench().catch(() => undefined); }));
}
/** one tick here (in the worker, or in-process): returns whether the report was rebuilt */
async function tickHere(force: 'report' | 'retune' | null): Promise<{ reportBuilt: boolean }> {
  let reportBuilt = false;
  if (busy) return { reportBuilt };
  busy = true;
  try {
    if (!backfillReady()) { lastTick = { at: new Date().toISOString(), info: 'waiting: the monthly backfill has not reached 2023-01 yet' }; return { reportBuilt }; }
    const report = store.get('report'), settings: Settings | null = store.get('settings');
    const il = israelNow();
    const weekly = il.day === 'Mon' && il.hour >= 4 && (!settings || Date.now() - Date.parse(settings.at) > 5 * DAY);
    const newMonth = report && report.test?.to !== monthName(lastFullMonth());
    if (force === 'report' || !report || !settings || (weekly && newMonth)) {
      await timed('tennis model report', buildTennisReport);
      reportBuilt = true; // fix200: the benchmark (provider calls) runs on the main thread after the write-back
    } else if (force === 'retune' || weekly) {
      await timed('tennis model retune', retuneLive);
    }
    // fix194: the full replay only when needed (this tick already runs in the heavy-job queue: no heavy() inside)
    if (needsBuild()) await timed('tennis ratings', buildLive);
    const applied = await applyNewResults();
    const n = await saveTennisPredictions();
    lastTick = { at: new Date().toISOString(), info: `${applied} new results in the ratings, ${n} predictions saved (${predsSkipped} unchanged)${IN_WORKER ? ' · worker thread' : ''}` };
    if (!IN_WORKER) refreshSnap();
  } catch (e: any) {
    progress.error = `${new Date().toISOString()}: ${e.message}`;
    setPhase(null);
    logger.warn(`${TENNIS_MODEL}: ${e.message}`);
  } finally { busy = false; }
  return { reportBuilt };
}
/** after the tennis results job (services/tennis.ts): new results into the live ratings (fix200: in the worker) */
export async function tennisResultsHook(): Promise<void> {
  try {
    if (!IN_WORKER && useWorker()) { await callWorker({ cmd: 'results' }); return; }
    if (await applyNewResults()) refreshSnap();
  } catch (e: any) { logger.warn(`${TENNIS_MODEL} results: ${e.message}`); }
}

let started = false;
export function startTennisModelScheduler() {
  if (started || IN_WORKER) return;
  started = true;
  // fix200: the worker thread does the work, so the tick no longer holds the heavy() queue (tennisModelTick queues
  // itself there only in the in-process fallback); its write-back is timed as "tennis model write-back"
  setTimeout(() => void tennisModelTick().catch(e => logger.warn(`${TENNIS_MODEL}: ${e.message}`)), 12 * 60 * 1000).unref();
  setInterval(() => void tennisModelTick().catch(e => logger.warn(`${TENNIS_MODEL}: ${e.message}`)), 30 * 60 * 1000).unref();
}

/* ------------------------------------------------------------------ */
/* fix200: the worker thread                                            */
/* ------------------------------------------------------------------ */

/** The ratings the pages read (player page "how our model rates them"): one row per rated player, typed arrays. */
export interface RatingsSnap {
  at: number; builtAt: number; lastT: number; players: number;
  pid: Float64Array; eO: Float64Array; nO: Float64Array; last: Float64Array; eS: Float64Array; nS: Float64Array; devS: Float64Array; devR: Float64Array;
  formWon: Uint8Array; formPlayed: Uint8Array; mu: Float64Array; men: Float64Array; women: Float64Array;
}
/** the snapshot of the live ratings at time `t` (serve / return strengths decay with time: read at `t`) */
function ratingsSnapshot(L: LiveState, t = Date.now()): RatingsSnap {
  const A = L.A, B = L.B, idx: number[] = [];
  for (let k = 0; k < L.c.reg.size; k++) if (A.init[k]) idx.push(k);
  const n = idx.length, f64 = (m = 1) => new Float64Array(n * m);
  const S: RatingsSnap = { at: t, builtAt: L.builtAt, lastT: L.lastT, players: L.c.reg.size, pid: f64(), eO: f64(), nO: f64(), last: f64(), eS: f64(3), nS: f64(3),
    devS: f64(3), devR: f64(3), formWon: new Uint8Array(n), formPlayed: new Uint8Array(n), mu: Float64Array.from(B.mu), men: new Float64Array(0), women: new Float64Array(0) };
  const men: number[] = [], wom: number[] = [];
  for (let j = 0; j < n; j++) {
    const k = idx[j];
    S.pid[j] = L.c.reg.pid[k]; S.eO[j] = A.eO[k]; S.nO[j] = A.nO[k]; S.last[j] = A.last[k];
    for (let s = 0; s < 3; s++) { S.eS[j * 3 + s] = A.eS[k * 3 + s]; S.nS[j * 3 + s] = A.nS[k * 3 + s]; S.devS[j * 3 + s] = B.dev(B.s, k, s, t); S.devR[j * 3 + s] = B.dev(B.r, k, s, t); }
    const h = (L.F.hist.get(k) || []).slice(-10);
    S.formWon[j] = h.filter(x => x.won).length; S.formPlayed[j] = h.length;
    // the rank lists: players with a match in the last 365 days, by tour
    if (A.last[k] && t - A.last[k] <= 365 * DAY) (L.c.playerTour.get(L.c.reg.pid[k]) === 'wta' ? wom : men).push(A.eO[k]);
  }
  S.men = Float64Array.from(men).sort().reverse(); S.women = Float64Array.from(wom).sort().reverse();
  return S;
}
const snapBuffers = (S: RatingsSnap) => [S.pid, S.eO, S.nO, S.last, S.eS, S.nS, S.devS, S.devR, S.formWon, S.formPlayed, S.mu, S.men, S.women].map(a => a.buffer as ArrayBuffer);

let snap: RatingsSnap | null = null;
let snapIdx = new Map<number, number>();
function setSnap(S: RatingsSnap) {
  const m = new Map<number, number>();
  for (let j = 0; j < S.pid.length; j++) if (S.pid[j] > 0) m.set(S.pid[j], j);
  snap = S; snapIdx = m;
}
/** in-process: the pages' snapshot from the live ratings (after a tick / new results / a replay) */
function refreshSnap() { if (liveState) setSnap(ratingsSnapshot(liveState)); }

interface WorkerState { busy: boolean; progress: typeof progress; lastTick: { at: string; info: string } | null; ratings: { builtAt: string; players: number; lastResult: string } | null }
interface Reply { id: number; ok: boolean; error?: string; writes: Write[]; state: WorkerState; snap?: RatingsSnap; reportBuilt?: boolean; ms: number }
let worker: Worker | null = null;
let workerOff = process.env.TENNIS_WORKER === '0';
let crashes = 0, seq = 0;
let remote: WorkerState | null = null;
let lastWriteBack: { at: string; writes: number; ms: number } | null = null;
const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
const workerInfo = () => ({ on: !workerOff && !!worker, off: workerOff, crashes, lastWriteBack });
const useWorker = () => !IN_WORKER && !workerOff && !!startWorker();

function workerFile(): { file: string; execArgv?: string[] } | null {
  const js = path.join(__dirname, '../workers/tennisModelWorker.js');
  if (fs.existsSync(js)) return { file: js };
  // ts-node-dev (npm run dev): the TypeScript source through ts-node
  const ts = path.join(__dirname, '../workers/tennisModelWorker.ts');
  if (fs.existsSync(ts)) return { file: ts, execArgv: ['-r', 'ts-node/register/transpile-only'] };
  return null;
}
function workerDown(e: Error) {
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
  worker = null; remote = null;
  if (++crashes >= 3) { workerOff = true; logger.warn(`${TENNIS_MODEL}: the worker thread stopped 3 times: in-process from now on`); }
}
function startWorker(): Worker | null {
  if (worker) return worker;
  const f = workerFile();
  if (!f) { workerOff = true; logger.warn(`${TENNIS_MODEL}: no worker file, in-process`); return null; }
  try {
    const w = new Worker(f.file, { workerData: { readOnlyDb: true, tennisModel: true }, execArgv: f.execArgv });
    w.on('message', (m: Reply) => onReply(m));
    w.on('error', e => { logger.warn(`${TENNIS_MODEL} worker error: ${e.message}`); workerDown(e); });
    w.on('exit', code => { if (worker === w) { if (code) logger.warn(`${TENNIS_MODEL} worker exited (${code})`); workerDown(new Error(`worker exited (${code})`)); } });
    w.unref();
    worker = w;
    return w;
  } catch (e: any) {
    workerOff = true;
    logger.warn(`${TENNIS_MODEL}: worker thread failed to start (${e.message}), in-process`);
    return null;
  }
}
/** the worker's writes in ONE transaction on the main thread (prepared once per statement) */
function applyWrites(ws: Write[]) {
  if (!ws.length) return;
  const st = new Map<string, Statement>();
  db.exec('BEGIN');
  try {
    for (const w of ws) { let s = st.get(w.sql); if (!s) { s = db.prepare(w.sql); st.set(w.sql, s); } s.run(...w.params); }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
}
function onReply(m: Reply) {
  remote = m.state;
  const t0 = Date.now();
  try {
    if (m.writes?.length) {
      const done = track('tennis model write-back'); // named in /api/perf like a job
      try { applyWrites(m.writes); } finally { done(); }
      strongCache = null;
    }
    lastWriteBack = { at: new Date().toISOString(), writes: m.writes?.length || 0, ms: Date.now() - t0 };
    if (m.snap) setSnap(m.snap);
  } catch (e: any) {
    logger.warn(`${TENNIS_MODEL} write-back: ${e.message}`);
    const w = waiting.get(m.id); waiting.delete(m.id); w?.reject(e); return;
  }
  const w = waiting.get(m.id);
  waiting.delete(m.id);
  if (!w) return;
  if (m.ok) w.resolve(m); else w.reject(new Error(m.error || 'worker failed'));
}
function callWorker(msg: { cmd: 'tick'; force: 'report' | 'retune' | null } | { cmd: 'results' } | { cmd: 'snapshot'; t: number }): Promise<Reply> {
  const w = startWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise<Reply>((resolve, reject) => { waiting.set(id, { resolve, reject }); w.postMessage({ id, ...msg }); });
}

/** the worker thread's side (workers/tennisModelWorker.ts): one command at a time, the writes and a snapshot back */
export function runTennisWorker(port: MessagePort) {
  let chain: Promise<unknown> = Promise.resolve();
  let sentBuilt = 0, sentLastT = 0, sentAt = 0;
  port.on('message', (m: any) => {
    chain = chain.then(async () => {
      const t0 = Date.now();
      let ok = true, error: string | undefined, reportBuilt = false, applied = 0;
      try {
        if (m.cmd === 'tick') reportBuilt = (await tickHere(m.force ?? null)).reportBuilt;
        else if (m.cmd === 'results') applied = await applyNewResults();
        else if (m.cmd === 'snapshot' && needsBuild()) await buildLive();
      } catch (e: any) { ok = false; error = e.message; }
      const writes = sink || [];
      sink = [];
      const L = liveState;
      // a snapshot when the ratings moved (a replay, new results) or every 10 minutes; always when asked for
      let S: RatingsSnap | undefined;
      if (L && (m.cmd === 'snapshot' || L.builtAt !== sentBuilt || L.lastT !== sentLastT || applied || Date.now() - sentAt > 10 * 60 * 1000)) {
        S = ratingsSnapshot(L, m.cmd === 'snapshot' ? m.t : Date.now());
        sentBuilt = L.builtAt; sentLastT = L.lastT; sentAt = Date.now();
      }
      const reply: Reply = { id: m.id, ok, error, writes, state: localState(), snap: S, reportBuilt, ms: Date.now() - t0 };
      port.postMessage(reply, S ? snapBuffers(S) : []);
    });
  });
}

/** scripts/tennis-worker.test.ts: the ratings built here and in the worker, read at the same time `t` */
export const tennisModelTest = {
  inProcess: async (t: number): Promise<RatingsSnap | null> => { await buildLive(); return liveState ? ratingsSnapshot(liveState, t) : null; },
  inWorker: async (t: number): Promise<RatingsSnap | null> => (await callWorker({ cmd: 'snapshot', t })).snap ?? null,
  playerModel: (pid: number, women: boolean) => tennisPlayerModel(pid, women),
  useSnap: (S: RatingsSnap) => setSnap(S),
  stop: async () => { const w = worker; worker = null; if (w) await w.terminate(); }
};

/* ------------------------------------------------------------------ */
/* fix193: what the public tennis pages read (services/tennisSite.ts)   */
/* ------------------------------------------------------------------ */

/**
 * "How our model rates them" (player page): overall and per-surface Elo, serve / return points won against an average
 * opponent, form (last 10), and the overall rank among players with a match in the last 12 months (same tour).
 * null = the ratings are not built yet or the player has no match.
 * fix200: read from the ratings snapshot (sent by the worker thread after each tick, or made in-process), never from
 * the replay itself.
 */
export function tennisPlayerModel(pid: number, women: boolean) {
  if (!useWorker()) { ensureLive(); if (liveState && (!snap || snap.builtAt !== liveState.builtAt || Date.now() - snap.at > 10 * 60 * 1000)) refreshSnap(); }
  const S = snap;
  if (!S) return null;
  const i = snapIdx.get(pid);
  if (i === undefined) return null;
  const gen = women ? 1 : 0;
  const list = gen ? S.women : S.men;
  let rank = 1; for (const e of list) if (e > S.eO[i]) rank++; else break;
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const mu = (s: number) => S.mu[gen * 3 + s];
  const serve = (s: number) => clampP(mu(s) + S.devS[i * 3 + s]), ret = (s: number) => clampP(1 - mu(s) + S.devR[i * 3 + s]);
  return {
    elo: Math.round(S.eO[i]), rank, of: list.length,
    surfaces: SURF_NAME.map((name, s) => ({ surface: name, elo: Math.round(S.eS[i * 3 + s]), matches: Math.round(S.nS[i * 3 + s]) })),
    serve: pct((serve(0) + serve(1) + serve(2)) / 3), ret: pct((ret(0) + ret(1) + ret(2)) / 3),
    tourServe: pct((mu(0) + mu(1) + mu(2)) / 3),
    form: { won: S.formWon[i], played: S.formPlayed[i] },
    matches: Math.round(S.nO[i]), lastMatch: S.last[i] ? new Date(S.last[i]).toISOString() : null
  };
}

/**
 * fix193: live win chance of player 1 from the current score, on the model's own chain (point → game → tiebreak → set
 * → match). pa / pb = the serve-point chances behind the saved pre-match prediction (rescaled to its win chance).
 * sets = sets won so far; games = games in the current set; points = points in the current game (0–4, null = unknown);
 * server = 1 / 2 / null (unknown: 50/50).
 */
export function tennisLiveChance(o: { pa: number; pb: number; bo: number; rule?: number; sets: [number, number]; games: [number, number]; points?: [number, number] | null; server?: 1 | 2 | null }): number {
  const need = o.bo === 5 ? 3 : 2;
  const [sa, sb] = o.sets, [ga, gb] = o.games;
  if (sa >= need) return 1;
  if (sb >= need) return 0;
  const rule = o.rule ?? 0;
  const gA = gameP(o.pa), gB = gameP(o.pb);
  // game won by the server from a point score (deuce: two in a row)
  const gameFrom = (p: number, x: number, y: number): number => {
    if (x >= 4 && x - y >= 2) return 1;
    if (y >= 4 && y - x >= 2) return 0;
    if (x >= 3 && y >= 3) { const d = (p * p) / (p * p + (1 - p) * (1 - p)); return x === y ? d : x > y ? p + (1 - p) * d : p * d; }
    return p * gameFrom(p, x + 1, y) + (1 - p) * gameFrom(p, x, y + 1);
  };
  // set won by A from games (i, j); aServes = A serves the next game; tb = tiebreak length at 6-6 (0 = none: the deciding set's match tiebreak handled by setDist kind 2)
  const memo = new Map<string, number>();
  const setFrom = (i: number, j: number, aServes: boolean, kind: number): number => {
    if (kind === 2) return tbP(o.pa, o.pb, 10, aServes);
    if ((i >= 6 && i - j >= 2) || i === 7) return 1;
    if ((j >= 6 && j - i >= 2) || j === 7) return 0;
    if (i === 6 && j === 6) return tbP(o.pa, o.pb, kind === 1 ? 10 : 7, aServes);
    const k = `${i}-${j}-${aServes ? 1 : 0}-${kind}`;
    const c = memo.get(k); if (c !== undefined) return c;
    const w = aServes ? gA : 1 - gB;
    const v = w * setFrom(i + 1, j, !aServes, kind) + (1 - w) * setFrom(i, j + 1, !aServes, kind);
    memo.set(k, v);
    return v;
  };
  const kindOf = (x: number, y: number) => (x === need - 1 && y === need - 1 ? rule : 0);
  // the match from sets (x, y) with a fresh set; server of its first game unknown → 50/50
  const mmemo = new Map<string, number>();
  const matchFrom = (x: number, y: number): number => {
    if (x >= need) return 1;
    if (y >= need) return 0;
    const k = `${x}-${y}`; const c = mmemo.get(k); if (c !== undefined) return c;
    const s = (setFrom(0, 0, true, kindOf(x, y)) + setFrom(0, 0, false, kindOf(x, y))) / 2;
    const v = s * matchFrom(x + 1, y) + (1 - s) * matchFrom(x, y + 1);
    mmemo.set(k, v);
    return v;
  };
  const kind = kindOf(sa, sb);
  // the current set, from its games (and the current game's points when known)
  const setNow = (aServes: boolean): number => {
    if (kind !== 2 && o.points && !(ga === 6 && gb === 6)) {
      const [x, y] = o.points;
      const hold = gameFrom(aServes ? o.pa : o.pb, aServes ? x : y, aServes ? y : x);
      const aWinsGame = aServes ? hold : 1 - hold;
      return aWinsGame * setFrom(ga + 1, gb, !aServes, kind) + (1 - aWinsGame) * setFrom(ga, gb + 1, !aServes, kind);
    }
    return setFrom(ga, gb, aServes, kind);
  };
  const sNow = o.server === 1 ? setNow(true) : o.server === 2 ? setNow(false) : (setNow(true) + setNow(false)) / 2;
  return sNow * matchFrom(sa + 1, sb) + (1 - sNow) * matchFrom(sa, sb + 1);
}
/** the strong-pick line of a category (tuned per tour, % sure), cached a minute */
let strongCache: { at: number; v: Record<string, number> } | null = null;
export function tennisStrongLine(cat: string): number {
  if (!strongCache || Date.now() - strongCache.at > 60 * 1000) {
    const st: Settings | null = store.get('settings');
    strongCache = { at: Date.now(), v: Object.fromEntries(CAT_NAME.map(c => [c, st?.strong?.[c]?.line ?? 75])) };
  }
  return strongCache.v[cat] ?? 75;
}
/** when the public record starts (TENNIS_PUBLIC day, else the model's deploy day) */
export const tennisRecordSince = (): string => process.env.TENNIS_PUBLIC_SINCE || store.get('deploy_day') || '2026-10-19';
/** the serve-point chances behind a saved prediction (rescaled so the chain gives its win chance) */
export function tennisServeChances(servePoint: [number, number] | null | undefined, p1: number, bo: number, rule = 0): { pa: number; pb: number } {
  const pa = servePoint ? servePoint[0] / 100 : 0.62, pb = servePoint ? servePoint[1] / 100 : 0.62;
  return rescale(pa, pb, bo === 5 ? 5 : 3, rule, Math.min(0.995, Math.max(0.005, p1)));
}

/**
 * fix204 "More predictions": the chain's own distributions — set scores, first set, total games — and the chance that
 * no set reaches a tie-break (the same chain with the tie-break outcomes left out; a match tiebreak counts as one).
 */
export function tennisExtrasDist(pa: number, pb: number, bo: number, rule: number) {
  const d = matchDist(pa, pb, bo, rule, true);
  const need = bo === 5 ? 3 : 2;
  let cur = new Map<number, number>([[0, 0.5], [1, 0.5]]);
  let noTb = 0;
  while (cur.size) {
    const next = new Map<number, number>();
    for (const [key, p] of cur) {
      const af = key & 1, sa = (key >> 1) & 7, sb = key >> 4;
      const kind = sa === need - 1 && sb === need - 1 ? rule : 0;
      if (kind === 2) continue;
      const sd = setDist(pa, pb, af === 1, kind);
      for (let o = 0; o < 14; o++) {
        if (o === 6 || o === 13 || !sd[o]) continue;
        const aw = o < 7, q = p * sd[o];
        const nsa = sa + (aw ? 1 : 0), nsb = sb + (aw ? 0 : 1), naf = (SET_OUT[o][0] + SET_OUT[o][1]) % 2 === 1 ? 1 - af : af;
        if (nsa === need || nsb === need) { noTb += q; continue; }
        const nk = naf + (nsa << 1) + (nsb << 4);
        next.set(nk, (next.get(nk) || 0) + q);
      }
    }
    cur = next;
  }
  return { sets: d.sets, first: d.first, games: d.games!, noTb };
}
/** the deciding-set rule outside the model's replay (no per-event history here): Slams since 2022 → 10-point tiebreak */
export const tennisRuleFor = (tier: string | null, at: string | null) => (/slam/i.test(String(tier || '')) && Date.parse(at || '') >= SLAM_TB10 ? 1 : 0);
/**
 * fix204 backtest: the point model's serve chances of every finished tour match (not retired) before it was played,
 * with the live settings (walk-forward ratings; the settings themselves were tuned on the whole history).
 */
export async function tennisExtrasWalkForward(fromMonth = 0): Promise<{ id: number; t: number; pa: number; pb: number; bo: number; rule: number; cat: string }[]> {
  const st: Settings | null = store.get('settings');
  const { c, R } = await loadData();
  const out: { id: number; t: number; pa: number; pb: number; bo: number; rule: number; cat: string }[] = [];
  await replayB(R, st?.b || B_DEFAULT, c.reg.size + 10, (i, pr) => {
    if (TESTED(R.cat[i]) && !R.ret[i] && R.win[i] && R.sets[i]) out.push({ id: R.id[i], t: R.t[i], pa: pr.pa, pb: pr.pb, bo: R.bo[i], rule: R.rule[i], cat: CAT_NAME[R.cat[i]] });
  }, fromMonth);
  return out;
}

/* for the local test script */
export const tennisModelInternals = { gameP, tbP, setDist, matchDist, winFast, rescale, gamesSummary, classify, preStartPrice, loadData, replayA, replayB, fitRankMap, A_DEFAULT, B_DEFAULT, RM_DEFAULT, FEng };

/**
 * Feature model (Oct 2026, "feat-v1") — a second football league model next to v3 (grid-v3), and the v3-mix built from
 * both. Research: docs/notes/all-data-test-model-oct-2026.md and model-sweep-oct-2026.md (Cowork, DB copy of 10 Oct):
 * on its own it ties v3; v3 + this model 50/50 was −0.004 log loss vs v3 on 739 live games.
 *
 * Pre-match features per league game, computed walk-forward (a game's features use only games played before it):
 *   Elo difference (margin-weighted, K 20, ×1.5 in a team's first 10 games of a season) + learned home edge per division;
 *   EWMA (α 0.15) of goals, xG and shots on target, for and against (crossed: my attack vs their defence);
 *   luck = goals − xG over the last 10; home-only points (home side) and away-only points (away side);
 *   league draw and home rates; squad value log ratio (+ known flag); confirmed XI: value (lineup names → squad_players),
 *   previous-season rating and goals (af_player_season, season − 1); injuries: count and previous-season minutes × rating.
 * Fit: multinomial logistic regression (standardised, L2 as C 0.5) + gradient-boosted trees (softmax, depth 3), 50/50.
 * Training: the two previous seasons + the current season to date. Fitted models are stored in `feature_model`.
 *
 * v3-mix = (1 − w) × grid-v3 + w × feature model, w = 0.5 (`model_config.mix_weight`), league games only — national
 * teams and UEFA cups stay on elo-intl / elo-euro. While `mix_live` is not on, v3-mix and feat-v1 are computed and
 * stored (shadow) but the site keeps showing grid-v3. See modelDaily.ts for the daily champion / challenger job.
 */
import logger from '../utils/logger';
import { timed, every, runSteps, runStepsAsync } from './perf';
import { db } from '../db';
import { groupForCompetition, fdNameFor } from './history';
import { playerKey } from './squadValues';
import type { Prediction } from './predictionModel';

export const FEAT_MODEL = 'feat-v1';
export const MIX_MODEL = 'v3-mix';
const AF_OFFSET = 1_000_000_000;
const DAY = 24 * 3600 * 1000;
const tick = () => new Promise<void>(r => setImmediate(r));
const FINISHED = new Set(['FT', 'AET', 'PEN']);
const UPCOMING = new Set(['NS', 'TBD']);

export const FEAT_CONF = { eloK: 20, earlyMult: 1.5, earlyGames: 10, alpha: 0.15, luckN: 10, warmup: 5, C: 0.5, rounds: 120, lr: 0.03, depth: 3, bins: 32, minHess: 80, lambda: 1 };

export const FEATURES = [
  'elo', 'eloAbs', 'goals', 'xg', 'sot', 'goalsTotal', 'luck', 'homeAwayPts', 'leagueDraw', 'leagueHome',
  'squadRatio', 'squadKnown', 'xiValue', 'xiKnown', 'xiRating', 'xiGoals', 'injCount', 'injWeighted'
] as const;
const NF = FEATURES.length;

/* ------------------------------------------------------------------ */
/* Settings (shared with modelDaily.ts)                                 */
/* ------------------------------------------------------------------ */

db.exec(`
  CREATE TABLE IF NOT EXISTS model_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS feature_model (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    json TEXT NOT NULL,
    trained_at TEXT NOT NULL,
    cutoff TEXT NOT NULL,           -- trained on games before this date
    train_games INTEGER NOT NULL,
    test_logloss REAL,              -- out of sample, when measured at fit time
    active INTEGER NOT NULL DEFAULT 0
  );
`);

// read on every prediction and every JSON response: cached for 30 s, dropped on every write
const cfgCache = new Map<string, { v: string | null; at: number }>();
// tracked rows copied in later carry backfilled = 1 (gridModel.backfillV3 adds the column on first use; we read it)
try {
  const cols = (db.prepare(`PRAGMA table_info(predictions)`).all() as any[]).map(c => c.name);
  if (!cols.includes('backfilled')) db.exec(`ALTER TABLE predictions ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0`);
} catch { /* predictions table created later */ }

export function getConfig(key: string, def: string): string {
  const c = cfgCache.get(key);
  if (c && Date.now() - c.at < 30_000) return c.v ?? def;
  const r: any = db.prepare(`SELECT value FROM model_config WHERE key = ?`).get(key);
  const v = r ? String(r.value) : null;
  cfgCache.set(key, { v, at: Date.now() });
  return v ?? def;
}
export function setConfig(key: string, value: string) {
  db.prepare(`INSERT OR REPLACE INTO model_config (key, value, updated_at) VALUES (?, ?, ?)`).run(key, value, new Date().toISOString());
  cfgCache.delete(key);
}
/** Weight of the feature model in v3-mix (0..1). */
export const mixWeight = () => Math.min(1, Math.max(0, Number(getConfig('mix_weight', '0.5')) || 0.5));
/** 'auto' (the daily job turns it on once v3-mix passes), 'on' or 'off'. */
export const mixMode = () => getConfig('mix_mode', 'auto');
/** v3-mix is the published league model (since `mixLiveSince()`). */
export const mixLive = () => getConfig('mix_live', '0') === '1' && mixMode() !== 'off';
export const mixLiveSince = () => getConfig('mix_live_since', '');
export function setMixLive(on: boolean) {
  const was = getConfig('mix_live', '0') === '1';
  setConfig('mix_live', on ? '1' : '0');
  if (on && !was) setConfig('mix_live_since', new Date().toISOString());
}

/* ------------------------------------------------------------------ */
/* Features, walk-forward                                                */
/* ------------------------------------------------------------------ */

interface Fx { fid: number; grp: string; div: string; season: number; kickoff: string; home: number; away: number; status: string; hg: number | null; ag: number | null; xh: number | null; xa: number | null; sh: number | null; sa: number | null }
export interface FeatRow { fid: number; grp: string; div: string; kickoff: string; x: Float64Array; y: number | null; ok: boolean }
interface TeamSt {
  elo: number; gf: number; ga: number; xgf: number; xga: number; sotf: number; sota: number; luck: number[];
  homePts: number; awayPts: number; games: number; season: number; seasonGames: number;
  lastXi: { value: number; rating: number; goals: number } | null;
}
interface DivSt { home: number; draw: number; edge: number; gpg: number; xgpg: number; sotpg: number }
interface Lookups {
  squad: Map<string, number>;                         // `${grp}|${teamId}` → squad value €
  starters: Map<number, Map<number, { id: number; name: string }[]>>; // fixture → team → starters
  injuries: Map<number, Map<number, number[]>>;       // fixture → team → player ids
  prev: Map<string, { min: number; rating: number; goals: number }>; // `${playerId}|${season}`
  value: Map<string, number>;                         // playerKey → € value
}
export interface FeatState { teams: Map<string, TeamSt>; divs: Map<string, DivSt>; rows: FeatRow[]; builtAt: number; look: Lookups; fixtures: Map<number, Fx> }

let STATE: FeatState | null = null;

/**
 * fix167: a big table read in pages of `size` rows by rowid, with a yield between pages (af_lineups: ~480k rows,
 * 373 ms in one read on a copy of the database, more on the server).
 */
function* rowsInPages(sql: string, size = 40000): Generator<unknown, any[]> {
  const q = db.prepare(`${sql} AND rowid > ? ORDER BY rowid LIMIT ?`);
  const out: any[] = [];
  let last = 0;
  for (;;) {
    const page = q.all(last, size) as any[];
    for (const r of page) out.push(r);
    if (page.length < size) return out;
    last = page[page.length - 1].rid;
    yield;
  }
}

function* loadLookups(): Generator<unknown, Lookups> {
  const squad = new Map<string, number>();
  try {
    for (const r of db.prepare(`SELECT t.grp, t.team_id, v.total_eur FROM af_teams t JOIN squad_values v ON v.grp = t.grp AND v.fd_name = t.fd_name WHERE t.fd_name IS NOT NULL`).all() as any[])
      if (r.total_eur > 0) squad.set(`${r.grp}|${r.team_id}`, r.total_eur);
  } catch { /* no squad values yet */ }
  const starters = new Map<number, Map<number, { id: number; name: string }[]>>();
  yield;
  for (const r of yield* rowsInPages(`SELECT rowid AS rid, fixture_id, team_id, player_id, player_name FROM af_lineups WHERE starter = 1`)) {
    let f = starters.get(r.fixture_id);
    if (!f) starters.set(r.fixture_id, (f = new Map()));
    let t = f.get(r.team_id);
    if (!t) f.set(r.team_id, (t = []));
    t.push({ id: r.player_id, name: r.player_name || '' });
  }
  const injuries = new Map<number, Map<number, number[]>>();
  yield;
  for (const r of yield* rowsInPages(`SELECT rowid AS rid, fixture_id, team_id, player_id FROM af_injuries WHERE 1`)) {
    let f = injuries.get(r.fixture_id);
    if (!f) injuries.set(r.fixture_id, (f = new Map()));
    let t = f.get(r.team_id);
    if (!t) f.set(r.team_id, (t = []));
    t.push(r.player_id);
  }
  const prev = new Map<string, { min: number; rating: number; goals: number }>();
  yield;
  // fix167: by ranges of player ids (a yield between them), not one aggregate over the whole table
  let range: { lo: number | null; hi: number | null } = { lo: null, hi: null };
  try { range = db.prepare(`SELECT MIN(player_id) AS lo, MAX(player_id) AS hi FROM af_player_season`).get() as any; } catch { /* no player seasons yet */ }
  if (range.lo !== null && range.hi !== null) {
    const q = db.prepare(`SELECT player_id, season, SUM(COALESCE(minutes, 0)) AS min, SUM(COALESCE(goals, 0)) AS goals,
        SUM(CASE WHEN rating > 0 THEN rating * COALESCE(minutes, 0) ELSE 0 END) AS rm, SUM(CASE WHEN rating > 0 THEN COALESCE(minutes, 0) ELSE 0 END) AS rmin
        FROM af_player_season WHERE player_id >= ? AND player_id < ? GROUP BY player_id, season`);
    const step = Math.max(1, Math.ceil((range.hi - range.lo + 1) / 12));
    for (let lo = range.lo; lo <= range.hi; lo += step) {
      for (const r of q.all(lo, lo + step) as any[])
        prev.set(`${r.player_id}|${r.season}`, { min: r.min || 0, goals: r.goals || 0, rating: r.rmin > 0 ? r.rm / r.rmin : 0 });
      yield;
    }
  }
  const value = new Map<string, number>();
  try {
    for (const r of db.prepare(`SELECT pkey, MAX(value_eur) AS v FROM squad_players GROUP BY pkey`).all() as any[]) if (r.pkey && r.v > 0) value.set(r.pkey, r.v);
  } catch { /* no player values yet */ }
  return { squad, starters, injuries, prev, value };
}

const RATING0 = 6.6; // a player without a previous-season rating (or under 300 minutes) counts as an average starter
function xiOf(look: Lookups, fid: number, team: number, season: number) {
  const list = look.starters.get(fid)?.get(team);
  if (!list || list.length < 9) return null;
  let value = 0, matched = 0, rating = 0, goals = 0;
  for (const p of list) {
    const v = look.value.get(playerKey(p.name));
    if (v) { value += v; matched++; }
    const pr = look.prev.get(`${p.id}|${season - 1}`);
    rating += pr && pr.min >= 300 && pr.rating > 0 ? pr.rating : RATING0;
    goals += pr ? pr.goals : 0;
  }
  return { value: matched >= 6 ? value * (list.length / matched) : 0, rating: rating / list.length, goals, known: matched >= 6 };
}
function injOf(look: Lookups, fid: number, team: number, season: number) {
  const ids = look.injuries.get(fid)?.get(team) || [];
  let w = 0;
  for (const id of ids) {
    const pr = look.prev.get(`${id}|${season - 1}`);
    if (pr && pr.min > 0) w += (pr.min / 3000) * ((pr.rating || RATING0) / 7);
  }
  return { n: ids.length, w };
}

function newTeam(d: DivSt, season: number): TeamSt {
  const g = d.gpg, x = d.xgpg, s = d.sotpg;
  return { elo: 1450, gf: g, ga: g, xgf: x, xga: x, sotf: s, sota: s, luck: [], homePts: 1.5, awayPts: 1.1, games: 0, season, seasonGames: 0, lastXi: null };
}

/** Feature vector for a game from the state before it (lineups / injuries of that fixture when stored). */
function featuresFor(st: FeatState, f: Fx, over: { home?: TeamSt; away?: TeamSt } = {}): { x: Float64Array; ok: boolean } {
  const d = divOf(st, f.div);
  const h = over.home || teamOf(st, f.grp, f.home, d, f.season), a = over.away || teamOf(st, f.grp, f.away, d, f.season);
  const x = new Float64Array(NF);
  const elo = (h.elo + d.edge - a.elo) / 100;
  x[0] = elo; x[1] = Math.abs(elo);
  x[2] = (h.gf + a.ga) - (a.gf + h.ga);
  x[3] = (h.xgf + a.xga) - (a.xgf + h.xga);
  x[4] = (h.sotf + a.sota) - (a.sotf + h.sota);
  x[5] = h.gf + a.ga + a.gf + h.ga;
  const luck = (t: TeamSt) => (t.luck.length ? t.luck.reduce((s, v) => s + v, 0) : 0);
  x[6] = luck(h) - luck(a);
  x[7] = h.homePts - a.awayPts;
  x[8] = d.draw; x[9] = d.home;
  const vh = st.look.squad.get(`${f.grp}|${f.home}`), va = st.look.squad.get(`${f.grp}|${f.away}`);
  x[10] = vh && va ? Math.log(vh / va) : 0; x[11] = vh && va ? 1 : 0;
  const xh = xiOf(st.look, f.fid, f.home, f.season), xa = xiOf(st.look, f.fid, f.away, f.season);
  const xiH = xh || (h.lastXi ? { ...h.lastXi, known: false } : null), xiA = xa || (a.lastXi ? { ...a.lastXi, known: false } : null);
  x[12] = xiH && xiA && xiH.value > 0 && xiA.value > 0 ? Math.log(xiH.value / xiA.value) : 0;
  x[13] = xh?.known && xa?.known ? 1 : 0;
  x[14] = xiH && xiA ? xiH.rating - xiA.rating : 0;
  x[15] = xiH && xiA ? (xiH.goals - xiA.goals) / 10 : 0;
  const ih = injOf(st.look, f.fid, f.home, f.season), ia = injOf(st.look, f.fid, f.away, f.season);
  x[16] = ih.n - ia.n; x[17] = ih.w - ia.w;
  return { x, ok: h.games >= FEAT_CONF.warmup && a.games >= FEAT_CONF.warmup };
}

function divOf(st: FeatState, div: string): DivSt {
  let d = st.divs.get(div);
  if (!d) st.divs.set(div, (d = { home: 0.44, draw: 0.26, edge: 60, gpg: 1.35, xgpg: 1.35, sotpg: 4.3 }));
  return d;
}
function teamOf(st: FeatState, grp: string, id: number, d: DivSt, season: number): TeamSt {
  const k = `${grp}|${id}`;
  let t = st.teams.get(k);
  if (!t) st.teams.set(k, (t = newTeam(d, season)));
  if (t.season !== season) { t.season = season; t.seasonGames = 0; }
  return t;
}

/** Update the state with a finished game. */
function learn(st: FeatState, f: Fx) {
  const c = FEAT_CONF, al = c.alpha;
  const d = divOf(st, f.div);
  const h = teamOf(st, f.grp, f.home, d, f.season), a = teamOf(st, f.grp, f.away, d, f.season);
  const hg = f.hg!, ag = f.ag!;
  const s = hg > ag ? 1 : hg === ag ? 0.5 : 0;
  const e = 1 / (1 + Math.pow(10, -(h.elo + d.edge - a.elo) / 400));
  const margin = Math.log(Math.abs(hg - ag) + 1) + 1;
  const kOf = (t: TeamSt) => c.eloK * (t.seasonGames < c.earlyGames ? c.earlyMult : 1);
  h.elo += kOf(h) * margin * (s - e);
  a.elo -= kOf(a) * margin * (s - e);
  d.edge += 0.075 * c.eloK * (s - e); // learned league home edge (slow)
  const ew = (old: number, v: number) => old + al * (v - old);
  h.gf = ew(h.gf, hg); h.ga = ew(h.ga, ag); a.gf = ew(a.gf, ag); a.ga = ew(a.ga, hg);
  if (f.xh != null && f.xa != null) {
    h.xgf = ew(h.xgf, f.xh); h.xga = ew(h.xga, f.xa); a.xgf = ew(a.xgf, f.xa); a.xga = ew(a.xga, f.xh);
    h.luck.push(hg - f.xh); a.luck.push(ag - f.xa);
    if (h.luck.length > c.luckN) h.luck.shift();
    if (a.luck.length > c.luckN) a.luck.shift();
    d.xgpg = ew(d.xgpg, (f.xh + f.xa) / 2); // per team per game
  }
  if (f.sh != null && f.sa != null) {
    h.sotf = ew(h.sotf, f.sh); h.sota = ew(h.sota, f.sa); a.sotf = ew(a.sotf, f.sa); a.sota = ew(a.sota, f.sh);
    d.sotpg = ew(d.sotpg, (f.sh + f.sa) / 2);
  }
  h.homePts = ew(h.homePts, hg > ag ? 3 : hg === ag ? 1 : 0);
  a.awayPts = ew(a.awayPts, ag > hg ? 3 : hg === ag ? 1 : 0);
  const dl = 0.01;
  d.home += dl * ((hg > ag ? 1 : 0) - d.home);
  d.draw += dl * ((hg === ag ? 1 : 0) - d.draw);
  d.gpg += dl * ((hg + ag) / 2 - d.gpg);
  for (const [t, id] of [[h, f.home], [a, f.away]] as const) {
    t.games++; t.seasonGames++;
    const xi = xiOf(st.look, f.fid, id, f.season);
    if (xi && xi.known) t.lastXi = { value: xi.value, rating: xi.rating, goals: xi.goals };
  }
}

/** Walk every league fixture in kick-off order: features for finished games, then learn from them. */
export const buildFeatures = (): FeatState => runSteps(buildFeatureSteps());
/**
 * fix167: the same in slices of 40 ms (3–4 s in one block before). It builds a new state and only returns it at the
 * end, so the live state is swapped in whole.
 */
export const buildFeaturesAsync = (): Promise<FeatState> => runStepsAsync(buildFeatureSteps());
function* buildFeatureSteps(): Generator<unknown, FeatState> {
  const t0 = Date.now();
  const look = yield* loadLookups();
  yield;
  const fixtures = db.prepare(`SELECT fixture_id AS fid, grp, division AS div, season, kickoff, home_id AS home, away_id AS away, status, hg, ag,
      xg_h AS xh, xg_a AS xa, sot_h AS sh, sot_a AS sa FROM af_fixtures ORDER BY kickoff, fixture_id`).all() as unknown as Fx[];
  yield;
  const st: FeatState = { teams: new Map(), divs: new Map(), rows: [], builtAt: Date.now(), look, fixtures: new Map() };
  const now = Date.now();
  let i = 0;
  yield;
  for (const f of fixtures) {
    if (++i % 500 === 0) yield;
    st.fixtures.set(f.fid, f);
    const done = FINISHED.has(String(f.status)) && f.hg != null && f.ag != null;
    if (!done) continue;
    if (Date.parse(f.kickoff) > now) continue;
    const { x, ok } = featuresFor(st, f);
    st.rows.push({ fid: f.fid, grp: f.grp, div: f.div, kickoff: f.kickoff, x, y: f.hg! > f.ag! ? 0 : f.hg === f.ag ? 1 : 2, ok });
    learn(st, f);
  }
  logger.info(`feature model: ${st.rows.length} games, ${st.teams.size} teams in ${Date.now() - t0} ms`);
  return st;
}

export function featureState(maxAgeMs = 30 * 60 * 1000): FeatState {
  if (!STATE || Date.now() - STATE.builtAt > maxAgeMs) STATE = buildFeatures();
  return STATE;
}
export const dropFeatureState = () => { STATE = null; };
/** Request path: never builds (a few seconds of work) — the scheduler keeps the state fresh every 30 minutes. */
function liveFeatureState(): FeatState | null { return STATE; }
/**
 * What the feature state was built from (fix135): finished games (count, last kick-off, goals, xG filled in), all
 * fixtures (new upcoming ones must be findable) and line-up / injury rows (the XI features). A few COUNT/MAX queries.
 */
function stateSignature(): string {
  const f: any = db.prepare(`SELECT COUNT(*) AS n, MAX(fixture_id) AS maxId,
      SUM(CASE WHEN status IN ('FT','AET','PEN') AND hg IS NOT NULL THEN 1 ELSE 0 END) AS done,
      MAX(CASE WHEN status IN ('FT','AET','PEN') AND hg IS NOT NULL THEN kickoff END) AS lastDone,
      SUM(CASE WHEN status IN ('FT','AET','PEN') THEN COALESCE(hg, 0) + COALESCE(ag, 0) ELSE 0 END) AS goals,
      SUM(CASE WHEN xg_h IS NOT NULL THEN 1 ELSE 0 END) AS xg FROM af_fixtures`).get();
  const l: any = db.prepare(`SELECT COUNT(*) AS n FROM af_lineups`).get();
  const i: any = db.prepare(`SELECT COUNT(*) AS n FROM af_injuries`).get();
  return [f.n, f.maxId, f.done, f.lastDone, f.goals, f.xg, l.n, i.n].join('|');
}
let stateSig = '';
const STATE_MAX_AGE_MS = 6 * 3600 * 1000; // rebuild at least every 6 h anyway (squad values, player seasons)

export function startFeatureModelScheduler() {
  // every 30 min, but only rebuild (3–4 s on the one thread) when the data behind it changed (fix135)
  const refresh = () => timed('feature state', async () => {
    try {
      const sig = stateSignature();
      if (STATE && sig === stateSig && Date.now() - STATE.builtAt < STATE_MAX_AGE_MS) return;
      STATE = await buildFeaturesAsync(); // fix167: in slices
      stateSig = sig;
    } catch (e: any) { logger.warn(`feature state: ${e.message}`); }
  });
  // first run 7 min after boot: never on top of the basketball tick (45 s after boot, then every 30 min)
  // (the 30-min cycle starts from that first run: 7, 37, 67 min … after boot, the basketball tick runs at 0:45, 30:45 …)
  setTimeout(() => {
    void refresh().then(() => timed('feature model', () => ensureFeatureModel()).catch(e => logger.warn(`feature model: ${e.message}`)));
    every('feature state', () => void refresh(), 30 * 60 * 1000);
  }, 7 * 60 * 1000);
}

/* ------------------------------------------------------------------ */
/* Fitting: multinomial logit + gradient-boosted trees                   */
/* ------------------------------------------------------------------ */

interface Tree { f: Int16Array; t: Float64Array; v: Float64Array } // complete binary tree, depth D: internal nodes then leaves
export interface FittedModel {
  version: 1; features: readonly string[]; mean: number[]; sd: number[];
  W: number[][];                       // 3 × (NF + 1), last = bias
  trees: { prior: number[]; lr: number; depth: number; t: { f: number[]; t: number[]; v: number[] }[][] }; // rounds × 3 classes
}

function softmax3(a: number, b: number, c: number): [number, number, number] {
  const m = Math.max(a, b, c);
  const ea = Math.exp(a - m), eb = Math.exp(b - m), ec = Math.exp(c - m), s = ea + eb + ec;
  return [ea / s, eb / s, ec / s];
}

async function fitLogit(X: Float64Array[], Y: number[], C: number): Promise<number[][]> {
  const n = X.length, d = NF + 1;
  const W = [new Float64Array(d), new Float64Array(d), new Float64Array(d)];
  const V = [new Float64Array(d), new Float64Array(d), new Float64Array(d)];
  const lam = 1 / (C * n);
  const lr = 0.5, mom = 0.9;
  for (let it = 0; it < 400; it++) {
    if (it % 25 === 0) await tick();
    const G = [new Float64Array(d), new Float64Array(d), new Float64Array(d)];
    for (let i = 0; i < n; i++) {
      const x = X[i];
      const z = [0, 0, 0];
      for (let k = 0; k < 3; k++) { let s = W[k][NF]; for (let j = 0; j < NF; j++) s += W[k][j] * x[j]; z[k] = s; }
      const p = softmax3(z[0], z[1], z[2]);
      for (let k = 0; k < 3; k++) {
        const g = p[k] - (Y[i] === k ? 1 : 0);
        for (let j = 0; j < NF; j++) G[k][j] += g * x[j];
        G[k][NF] += g;
      }
    }
    for (let k = 0; k < 3; k++) for (let j = 0; j < d; j++) {
      const g = G[k][j] / n + (j < NF ? lam * W[k][j] : 0);
      V[k][j] = mom * V[k][j] - lr * g;
      W[k][j] += V[k][j];
    }
  }
  return W.map(w => Array.from(w));
}

async function fitTrees(X: Float64Array[], Y: number[]) {
  const c = FEAT_CONF, n = X.length, D = c.depth, nLeaf = 1 << D, nInt = nLeaf - 1;
  // quantile bins per feature
  const edges: Float64Array[] = [];
  const bin: Uint8Array[] = [];
  for (let j = 0; j < NF; j++) {
    const v = X.map(x => x[j]).sort((a, b) => a - b);
    const e: number[] = [];
    for (let b = 1; b < c.bins; b++) { const q = v[Math.floor((b / c.bins) * (n - 1))]; if (!e.length || q > e[e.length - 1]) e.push(q); }
    edges.push(Float64Array.from(e));
    const bj = new Uint8Array(n);
    for (let i = 0; i < n; i++) { let lo = 0, hi = e.length; const x = X[i][j]; while (lo < hi) { const m = (lo + hi) >> 1; if (x > e[m]) lo = m + 1; else hi = m; } bj[i] = lo; }
    bin.push(bj);
  }
  const cnt = [0, 0, 0];
  for (const y of Y) cnt[y]++;
  const prior = cnt.map(k => Math.log(Math.max(1, k) / n));
  const F = [new Float64Array(n).fill(prior[0]), new Float64Array(n).fill(prior[1]), new Float64Array(n).fill(prior[2])];
  const rounds: { f: number[]; t: number[]; v: number[] }[][] = [];
  const node = new Int32Array(n);
  const g = new Float64Array(n), h = new Float64Array(n);
  for (let r = 0; r < c.rounds; r++) {
    await tick();
    const P = new Array(n);
    for (let i = 0; i < n; i++) P[i] = softmax3(F[0][i], F[1][i], F[2][i]);
    const round: { f: number[]; t: number[]; v: number[] }[] = [];
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < n; i++) { const p = P[i][k]; g[i] = (Y[i] === k ? 1 : 0) - p; h[i] = Math.max(1e-6, p * (1 - p)); }
      const tf = new Array(nInt).fill(-1), tt = new Array(nInt).fill(0);
      node.fill(0);
      for (let depth = 0; depth < D; depth++) {
        const first = (1 << depth) - 1, count = 1 << depth;
        // histograms: node × feature × bin
        const nb = c.bins;
        const HG = new Float64Array(count * NF * nb), HH = new Float64Array(count * NF * nb);
        for (let i = 0; i < n; i++) {
          const nd = node[i] - first;
          if (nd < 0 || nd >= count) continue;
          const base = nd * NF * nb;
          for (let j = 0; j < NF; j++) { const o = base + j * nb + bin[j][i]; HG[o] += g[i]; HH[o] += h[i]; }
        }
        for (let nd = 0; nd < count; nd++) {
          let best = 0, bf = -1, bb = 0;
          let GT = 0, HT = 0;
          for (let b = 0; b < nb; b++) { GT += HG[nd * NF * nb + b]; HT += HH[nd * NF * nb + b]; }
          const parent = (GT * GT) / (HT + c.lambda);
          for (let j = 0; j < NF; j++) {
            let GL = 0, HL = 0;
            const base = nd * NF * nb + j * nb;
            const nE = edges[j].length;
            for (let b = 0; b < nE; b++) {
              GL += HG[base + b]; HL += HH[base + b];
              const GR = GT - GL, HR = HT - HL;
              if (HL < c.minHess || HR < c.minHess) continue;
              const gain = (GL * GL) / (HL + c.lambda) + (GR * GR) / (HR + c.lambda) - parent;
              if (gain > best) { best = gain; bf = j; bb = b; }
            }
          }
          if (bf >= 0) { tf[first + nd] = bf; tt[first + nd] = edges[bf][bb]; }
        }
        // move samples down (no split = always left)
        for (let i = 0; i < n; i++) {
          const nd = node[i];
          const j = tf[nd];
          node[i] = 2 * nd + (j >= 0 && X[i][j] > tt[nd] ? 2 : 1);
        }
      }
      // leaf values (Newton step, scaled for 3 classes)
      const SG = new Float64Array(nLeaf), SH = new Float64Array(nLeaf);
      for (let i = 0; i < n; i++) { const l = node[i] - nInt; SG[l] += g[i]; SH[l] += h[i]; }
      const tv = Array.from(SG, (s, l) => (2 / 3) * s / (SH[l] + c.lambda));
      for (let i = 0; i < n; i++) F[k][i] += c.lr * tv[node[i] - nInt];
      round.push({ f: tf, t: tt, v: tv });
    }
    rounds.push(round);
  }
  return { prior, lr: c.lr, depth: D, t: rounds };
}

function treeOut(t: { f: number[]; t: number[]; v: number[] }, x: Float64Array, depth: number): number {
  let nd = 0;
  for (let d = 0; d < depth; d++) { const j = t.f[nd]; nd = 2 * nd + (j >= 0 && x[j] > t.t[nd] ? 2 : 1); }
  return t.v[nd - ((1 << depth) - 1)];
}

/** Probabilities [home, draw, away] from a fitted model for a raw feature vector. */
export function predictWith(m: FittedModel, raw: Float64Array): [number, number, number] {
  const x = new Float64Array(NF);
  for (let j = 0; j < NF; j++) x[j] = (raw[j] - m.mean[j]) / m.sd[j];
  const z = [0, 1, 2].map(k => { let s = m.W[k][NF]; for (let j = 0; j < NF; j++) s += m.W[k][j] * x[j]; return s; });
  const pl = softmax3(z[0], z[1], z[2]);
  const F = [...m.trees.prior];
  for (const round of m.trees.t) for (let k = 0; k < 3; k++) F[k] += m.trees.lr * treeOut(round[k], x, m.trees.depth);
  const pt = softmax3(F[0], F[1], F[2]);
  const p: [number, number, number] = [0.5 * pl[0] + 0.5 * pt[0], 0.5 * pl[1] + 0.5 * pt[1], 0.5 * pl[2] + 0.5 * pt[2]];
  const s = p[0] + p[1] + p[2];
  return [p[0] / s, p[1] / s, p[2] / s];
}

/** Start of the season a date belongs to (1 July), and the training start: two seasons before that. */
export function trainFromFor(cutoff: string): string {
  const d = new Date(cutoff);
  const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y - 2}-07-01`;
}

/** Fit on finished games before `cutoff` (two previous seasons + current to date). */
export async function fitFeatureModel(st: FeatState, cutoff: string, from = trainFromFor(cutoff)): Promise<{ model: FittedModel; n: number } | null> {
  const rows = st.rows.filter(r => r.ok && r.y !== null && r.kickoff < cutoff && r.kickoff >= from);
  if (rows.length < 1000) return null;
  const mean = new Array(NF).fill(0), sd = new Array(NF).fill(0);
  for (const r of rows) for (let j = 0; j < NF; j++) mean[j] += r.x[j];
  for (let j = 0; j < NF; j++) mean[j] /= rows.length;
  for (const r of rows) for (let j = 0; j < NF; j++) sd[j] += (r.x[j] - mean[j]) ** 2;
  for (let j = 0; j < NF; j++) sd[j] = Math.sqrt(sd[j] / rows.length) || 1;
  const X = rows.map(r => { const x = new Float64Array(NF); for (let j = 0; j < NF; j++) x[j] = (r.x[j] - mean[j]) / sd[j]; return x; });
  const Y = rows.map(r => r.y!);
  const W = await fitLogit(X, Y, FEAT_CONF.C);
  const trees = await fitTrees(X, Y);
  return { model: { version: 1, features: FEATURES, mean, sd, W, trees }, n: rows.length };
}

/** Walk-forward probabilities for games in [from, to) from a model fitted on games before `fitCutoff` (≤ from). */
export function predictWindow(st: FeatState, m: FittedModel, from: string, to: string): Map<number, [number, number, number]> {
  const out = new Map<number, [number, number, number]>();
  for (const r of st.rows) if (r.kickoff >= from && r.kickoff < to && r.ok) out.set(r.fid, predictWith(m, r.x));
  return out;
}

/* ------------------------------------------------------------------ */
/* The stored (live) model                                               */
/* ------------------------------------------------------------------ */

let ACTIVE: { id: number; model: FittedModel; cutoff: string } | null = null;
export function activeFeatureModel() {
  if (ACTIVE) return ACTIVE;
  const r: any = db.prepare(`SELECT id, json, cutoff FROM feature_model WHERE active = 1 ORDER BY id DESC LIMIT 1`).get();
  if (r) { try { ACTIVE = { id: r.id, model: JSON.parse(r.json), cutoff: r.cutoff }; } catch { ACTIVE = null; } }
  return ACTIVE;
}
export function loadFeatureModel(id: number): FittedModel | null {
  const r: any = db.prepare(`SELECT json FROM feature_model WHERE id = ?`).get(id);
  try { return r ? JSON.parse(r.json) : null; } catch { return null; }
}
export function storeFeatureModel(m: FittedModel, cutoff: string, n: number, testLogLoss: number | null, active: boolean): number {
  if (active) db.exec(`UPDATE feature_model SET active = 0`);
  const r = db.prepare(`INSERT INTO feature_model (json, trained_at, cutoff, train_games, test_logloss, active) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(JSON.stringify(m), new Date().toISOString(), cutoff, n, testLogLoss, active ? 1 : 0);
  // keep the last 40 fits (the history is what a rollback goes back to)
  db.exec(`DELETE FROM feature_model WHERE id NOT IN (SELECT id FROM feature_model ORDER BY id DESC LIMIT 40) AND active = 0`);
  if (active) ACTIVE = null;
  return Number(r.lastInsertRowid);
}
export function activateFeatureModel(id: number) {
  db.exec(`UPDATE feature_model SET active = 0`);
  db.prepare(`UPDATE feature_model SET active = 1 WHERE id = ?`).run(id);
  ACTIVE = null;
}
export function featureModelStatus() {
  const a: any = db.prepare(`SELECT id, trained_at, cutoff, train_games, test_logloss FROM feature_model WHERE active = 1 ORDER BY id DESC LIMIT 1`).get();
  return { active: a || null, mixWeight: mixWeight(), mixMode: mixMode(), mixLive: mixLive(), mixLiveSince: mixLiveSince() || null, stateGames: STATE?.rows.length ?? null };
}

/** First start: fit and store a model when none exists (two seasons + current to date). */
export async function ensureFeatureModel() {
  if (activeFeatureModel()) return;
  await new Promise<void>(r => setImmediate(r));
  // fix167: the state the scheduler has just built (was built a second time here, in one block)
  const st = STATE || (STATE = await buildFeaturesAsync());
  const cutoff = new Date().toISOString().slice(0, 10);
  const fit = await fitFeatureModel(st, cutoff);
  if (!fit) { logger.warn('feature model: too few games to fit'); return; }
  storeFeatureModel(fit.model, cutoff, fit.n, null, true);
  logger.info(`feature model fitted on ${fit.n} games (cutoff ${cutoff})`);
}

/* ------------------------------------------------------------------ */
/* Live predictions: feat-v1 and v3-mix next to grid-v3                  */
/* ------------------------------------------------------------------ */

/** The API-Football fixture behind a match object (API-Football ids directly; Football-Data.org via names). */
export function afFixtureFor(match: any, st: FeatState): Fx | null {
  const id = Number(match?.id);
  if (id >= AF_OFFSET) return st.fixtures.get(id - AF_OFFSET) || null;
  const code = match?.competition?.code;
  const grp = code ? groupForCompetition(code) : null;
  if (!grp) return null;
  return fixtureByNames(st, grp, fdNameFor(grp, match.homeTeam?.id), fdNameFor(grp, match.awayTeam?.id), String(match.utcDate || ''));
}

const teamIdCache = new Map<string, number | null>();
export function afTeamId(grp: string, fdName: string | null): number | null {
  if (!fdName) return null;
  const k = `${grp}|${fdName}`;
  if (teamIdCache.has(k)) return teamIdCache.get(k)!;
  const r: any = db.prepare(`SELECT team_id FROM af_teams WHERE grp = ? AND fd_name = ?`).get(grp, fdName);
  const v = r ? Number(r.team_id) : null;
  if (teamIdCache.size > 5000) teamIdCache.clear();
  teamIdCache.set(k, v);
  return v;
}
const fixtureIdx = new Map<string, number>(); // `${grp}|${home}|${away}|${date}` → fixture id (rebuilt with the state)
let fixtureIdxAt = 0;
export function fixtureByNames(st: FeatState, grp: string, home: string | null, away: string | null, date: string): Fx | null {
  const h = afTeamId(grp, home), a = afTeamId(grp, away);
  if (!h || !a) return null;
  if (fixtureIdxAt !== st.builtAt) {
    fixtureIdx.clear();
    for (const f of st.fixtures.values()) fixtureIdx.set(`${f.grp}|${f.home}|${f.away}|${f.kickoff.slice(0, 10)}`, f.fid);
    fixtureIdxAt = st.builtAt;
  }
  const d0 = date.slice(0, 10);
  for (const dd of [0, -1, 1]) {
    const d = new Date(Date.parse(d0) + dd * DAY).toISOString().slice(0, 10);
    const fid = fixtureIdx.get(`${grp}|${h}|${a}|${d}`);
    if (fid) return st.fixtures.get(fid) || null;
  }
  return null;
}

/**
 * fix192: a side with fewer than `warmup` games in the league (a play-off team from the division below, a promoted
 * club before its first games) is played as a newcomer: the average state of the division's bottom 3 over the last
 * two seasons (same rule as grid-v3, where it beat the promoted-teams average out of sample). Kept per state.
 */
const newcomerSt = new WeakMap<FeatState, Map<string, TeamSt | null>>();
function newcomerTeam(st: FeatState, grp: string, div: string, season: number): TeamSt | null {
  let memo = newcomerSt.get(st);
  if (!memo) newcomerSt.set(st, (memo = new Map()));
  const key = `${grp}|${div}|${season}`;
  if (memo.has(key)) return memo.get(key)!;
  const recent = new Set<number>();
  for (const f of st.fixtures.values())
    if (f.grp === grp && f.div === div && f.season >= season - 1 && f.hg != null && FINISHED.has(String(f.status))) { recent.add(f.home); recent.add(f.away); }
  const known = (id: number) => { const t = st.teams.get(`${grp}|${id}`); return t && t.games >= FEAT_CONF.warmup ? t : null; };
  const pool = ([...recent].map(known).filter(Boolean) as TeamSt[]).sort((x, y) => x.elo - y.elo).slice(0, 3);
  let out: TeamSt | null = null;
  if (pool.length === 3) {
    const avg = (g: (t: TeamSt) => number) => pool.reduce((s, t) => s + g(t), 0) / pool.length;
    out = {
      elo: avg(t => t.elo), gf: avg(t => t.gf), ga: avg(t => t.ga), xgf: avg(t => t.xgf), xga: avg(t => t.xga), sotf: avg(t => t.sotf), sota: avg(t => t.sota),
      luck: [], homePts: avg(t => t.homePts), awayPts: avg(t => t.awayPts), games: FEAT_CONF.warmup, season, seasonGames: 0, lastXi: null
    };
  }
  memo.set(key, out);
  return out;
}

/** Feature-model probabilities (%) for a match about to be played, or null. */
export function featureProbs(match: any): [number, number, number] | null {
  const act = activeFeatureModel();
  if (!act) return null;
  const st = liveFeatureState();
  if (!st) return null;
  const f = afFixtureFor(match, st);
  if (!f) return null; // a fixture we don't have
  // a started / finished game: the state already holds its result, so only upcoming games get a fresh number
  if (!UPCOMING.has(String(f.status)) && Date.parse(f.kickoff) < Date.now()) return null;
  const over: { home?: TeamSt; away?: TeamSt } = {};
  for (const side of ['home', 'away'] as const) {
    const t = st.teams.get(`${f.grp}|${f[side]}`);
    if (!t || t.games < FEAT_CONF.warmup) { const n = newcomerTeam(st, f.grp, f.div, f.season); if (n) over[side] = { ...n, lastXi: t?.lastXi ?? null }; }
  }
  const { x, ok } = featuresFor(st, f, over);
  if (!ok) return null;
  const p = predictWith(act.model, x);
  return [p[0] * 100, p[1] * 100, p[2] * 100];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
/**
 * feat-v1 and v3-mix predictions built on the v3 one (same goals numbers and breakdown; 1X2 replaced / mixed).
 * `mix` on v3-mix: both models' numbers, and whether the feature model disagrees on the favourite by > 8 points.
 */
export function mixPredictions(match: any, v3: Prediction | null): Prediction[] {
  if (!v3 || v3.grid?.scope && v3.grid.scope !== 'league') return [];
  let fp: [number, number, number] | null = null;
  try { fp = featureProbs(match); } catch (e: any) { logger.warn(`feature model: ${e.message}`); }
  // fix181: right after a deploy the feature state is still being built — the last saved v3-mix numbers of the match
  // are served until it is ready (no jump to grid-v3 and back)
  if (!fp && !STATE) return savedMix(match, v3);
  if (!fp) return [];
  const w = mixWeight();
  const v = [v3.home, v3.draw, v3.away];
  const m = v.map((x, i) => (1 - w) * x + w * fp![i]);
  const s = m[0] + m[1] + m[2] || 1;
  const mix = m.map(x => (x / s) * 100);
  const fav = v[0] >= v[1] && v[0] >= v[2] ? 0 : v[2] >= v[1] ? 2 : 1;
  // feat-v1 is stored for comparison only: no breakdown copy (the grid stays on grid-v3 / v3-mix)
  const feat: Prediction = { ...v3, model: FEAT_MODEL, home: r1(fp[0]), draw: r1(fp[1]), away: r1(fp[2]), beforeLineups: undefined, grid: undefined, topScores: [] };
  const out: Prediction & { mix?: any } = {
    ...v3, model: MIX_MODEL, home: r1(mix[0]), draw: r1(mix[1]), away: r1(mix[2]), beforeLineups: undefined,
    mix: {
      weight: w, v3: { home: v3.home, draw: v3.draw, away: v3.away }, feature: { home: r1(fp[0]), draw: r1(fp[1]), away: r1(fp[2]) },
      favourite: (['H', 'D', 'A'] as const)[fav], gap: r1(fp[fav] - v[fav]), disagrees: Math.abs(fp[fav] - v[fav]) > 8
    }
  };
  return [out, feat];
}

// prepared on first use (fix183: the payload column is added by tracking.ts, which may load after this file)
let savedMixStmt: ReturnType<typeof db.prepare> | null = null;
function savedMix(match: any, v3: Prediction): Prediction[] {
  let r: any = null;
  try { savedMixStmt ??= db.prepare(`SELECT p_home, p_draw, p_away, payload FROM predictions WHERE match_id = ? AND model = ?`); r = savedMixStmt.get(Number(match?.id), MIX_MODEL); } catch { return []; }
  if (!r) return [];
  let mix: any = null;
  try { mix = r.payload ? JSON.parse(r.payload)?.mix ?? null : null; } catch { mix = null; }
  return [{ ...v3, model: MIX_MODEL, home: r.p_home, draw: r.p_draw, away: r.p_away, beforeLineups: undefined, ...(mix ? { mix } : {}) } as Prediction];
}

/** Models hidden from visitors: feat-v1 always; v3-mix until it is live; grid-v3 once v3-mix is live (one "v3"). */
export function hiddenModels(): Set<string> {
  return mixLive() ? new Set([FEAT_MODEL, 'grid-v3']) : new Set([FEAT_MODEL, MIX_MODEL]);
}

/* ------------------------------------------------------------------ */
/* Backtest: v3-mix vs v3 on a season to date (admin)                    */
/* ------------------------------------------------------------------ */

type P3 = [number, number, number];
function score(rows: { p: P3; y: number }[]) {
  let ll = 0, br = 0, hit = 0;
  for (const r of rows) {
    const p = r.p, s = p[0] + p[1] + p[2];
    const q = [p[0] / s, p[1] / s, p[2] / s];
    ll += -Math.log(Math.max(1e-6, q[r.y]));
    br += q.reduce((a, v, i) => a + (v - (i === r.y ? 1 : 0)) ** 2, 0);
    const pick = q[0] >= q[1] && q[0] >= q[2] ? 0 : q[2] >= q[1] ? 2 : 1;
    if (pick === r.y) hit++;
  }
  const n = rows.length || 1;
  return { n: rows.length, logLoss: Math.round((ll / n) * 10000) / 10000, brier: Math.round((br / n) * 10000) / 10000, hitRate: Math.round((1000 * hit) / n) / 10 };
}
export { score as scoreProbs };

/**
 * v3-mix backtest on games from `from` (default: 1 July of this season): the feature model is fitted once on games
 * before `from`, then compared with v3 on the same games, two ways:
 *  - tracked: v3 as saved before kick-off by the site (predictions table, grid-v3, locked);
 *  - backtest: v3 from the latest grid-v3 backtest run of `season` (backtest_predictions), when one exists.
 */
export async function v3MixBacktest(opts: { from?: string; season?: string } = {}) {
  const st = featureState(0);
  const now = new Date();
  const from = opts.from || `${now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1}-07-01`;
  const fit = await fitFeatureModel(st, from);
  if (!fit) return { error: 'too few games before ' + from };
  const feat = predictWindow(st, fit.model, from, '9999');
  const ws = [0.4, 0.5, 0.6];
  const build = (pairs: { fid: number; v3: P3; y: number; mkt: P3 | null }[]) => {
    const rows = pairs.filter(r => feat.has(r.fid));
    const res: any = { games: rows.length, v3: score(rows.map(r => ({ p: r.v3, y: r.y }))), feature: score(rows.map(r => ({ p: feat.get(r.fid)!, y: r.y }))) };
    for (const w of ws) res[`mix${w}`] = score(rows.map(r => { const f = feat.get(r.fid)!; return { p: [0, 1, 2].map(i => (1 - w) * r.v3[i] + w * f[i]) as P3, y: r.y }; }));
    const withMkt = rows.filter(r => r.mkt);
    res.withOdds = withMkt.length ? {
      games: withMkt.length, market: score(withMkt.map(r => ({ p: r.mkt!, y: r.y }))), v3: score(withMkt.map(r => ({ p: r.v3, y: r.y }))),
      mix0_5: score(withMkt.map(r => { const f = feat.get(r.fid)!; return { p: [0, 1, 2].map(i => 0.5 * r.v3[i] + 0.5 * f[i]) as P3, y: r.y }; }))
    } : null;
    res.passes = rows.length > 0 && res['mix0.5'].logLoss <= res.v3.logLoss;
    return res;
  };
  // tracked v3 (saved before kick-off)
  const tracked: { fid: number; v3: P3; y: number; mkt: P3 | null }[] = [];
  const rows = db.prepare(`SELECT p.match_id, p.competition_code, p.home_team_id, p.away_team_id, p.utc_date, p.p_home, p.p_draw, p.p_away,
      p.odds_home, p.odds_draw, p.odds_away, r.outcome FROM predictions p JOIN results r ON r.match_id = p.match_id
      WHERE p.model = 'grid-v3' AND p.settled = 1 AND p.locked = 1 AND COALESCE(p.backfilled, 0) = 0 AND r.outcome IN ('H','D','A') AND p.utc_date >= ?`).all(from) as any[];
  for (const r of rows) {
    const f = afFixtureFor({ id: r.match_id, competition: { code: r.competition_code }, homeTeam: { id: r.home_team_id }, awayTeam: { id: r.away_team_id }, utcDate: r.utc_date }, st);
    if (!f) continue;
    const mkt = r.odds_home && r.odds_draw && r.odds_away ? ([1 / r.odds_home, 1 / r.odds_draw, 1 / r.odds_away] as P3) : null;
    tracked.push({ fid: f.fid, v3: [r.p_home, r.p_draw, r.p_away], y: r.outcome === 'H' ? 0 : r.outcome === 'D' ? 1 : 2, mkt });
  }
  // backtest run v3
  const season = opts.season || `${from.slice(2, 4)}${String(Number(from.slice(2, 4)) + 1).padStart(2, '0')}`;
  const bt: { fid: number; v3: P3; y: number; mkt: P3 | null }[] = [];
  const runs = db.prepare(`SELECT r.id, r.grp FROM backtest_runs r WHERE r.model = 'grid-v3' AND r.season = ? AND r.finished_at IS NOT NULL
      AND r.id = (SELECT MAX(id) FROM backtest_runs x WHERE x.model = r.model AND x.season = r.season AND x.grp = r.grp AND x.finished_at IS NOT NULL)`).all(season) as any[];
  for (const run of runs) {
    for (const b of db.prepare(`SELECT date, home, away, outcome, p_home, p_draw, p_away, odds_home, odds_draw, odds_away FROM backtest_predictions WHERE run_id = ?`).all(run.id) as any[]) {
      if (b.date < from) continue;
      const f = fixtureByNames(st, run.grp, b.home, b.away, b.date);
      if (!f) continue;
      const mkt = b.odds_home && b.odds_draw && b.odds_away ? ([1 / b.odds_home, 1 / b.odds_draw, 1 / b.odds_away] as P3) : null;
      bt.push({ fid: f.fid, v3: [b.p_home, b.p_draw, b.p_away], y: b.outcome === 'H' ? 0 : b.outcome === 'D' ? 1 : 2, mkt });
    }
  }
  return {
    from, season, featureTrainGames: fit.n,
    tracked: tracked.length ? build(tracked) : null,
    backtest: bt.length ? build(bt) : { note: `no finished grid-v3 backtest run for ${season} (run one from Admin → Accuracy, or /api/backtest/run?season=${season})` },
    rule: 'v3-mix (0.5) must be ≤ v3 in log loss on the same games'
  };
}

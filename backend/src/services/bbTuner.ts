/**
 * fix219 — bb-v4 tuner, gate and live predictions (the grid of services/bbGrid.ts, maths in utils/bbGridMath.ts).
 *
 *  - runTune (thread job 'bb tune', /api/bb/tune?train=2022,2023,2024&test=2025[&apply=1]): pattern search of the 13
 *    weights + per-league stretch (+ offsets for leagues with 1,500+ train games) on the stored rows; the report has the
 *    fitted split (points per row), the test table (whole season and games 1–25, per group and league), "who actually
 *    played" in place of #4 (the ceiling of an injury feed) and the live period (reported, never tuned). apply=1 stores
 *    the settings in bb_tuned and publishes them (no redeploy). /api/bb/tuned[?reload=1|clear=1].
 *  - Gate (every build and every apply): per group (NBA / Europe pooled / rest of the world pooled) bb-v4 must beat
 *    bb-v3 on log loss over the whole test season AND games 1–25 of each team; else bb-v3 stays live there.
 *  - gridPredict: an upcoming game's bb-v4 chance and its 1,000-point split, when its group passed.
 */
import logger from '../utils/logger';
import { db } from '../db';
import { onState, publishState } from './shared';
import { yieldLoop } from './perf';
import {
  GRID_ROWS, GRID_DEFAULT, GRID_TRAIN, GRID_TEST, GRID_LIVE_FROM, N_ROWS, VOL, assertTrainYears, fitGrid, compare, rowStats, fittedSplit,
  gridEval, split1000, groupOf, diff, volOf, weightsFor, logLoss, spreadOf, fitLeagueSet, regionGroup, LS_ROWS,
  MISS, missInputs, missSplit, fitMiss, fitProxy, missGate, missFrom, usesOracle, starOf, impactInputs, impactGate, altShare,
  type GridItem, type GridParams, type GridView, type LeagueSet, type MissSet, type MissGate, type ImpactSet, type ImpactGate
} from '../utils/bbGridMath';
import { WB_START, topLoss, BOX_FEATS, type BoxCoef } from '../utils/boxValue';
import { rotation, strength } from '../utils/nbaImpact';
import type { Check } from './dataHealth';
import { tuneLeagueSettings, LS_FIT, LS_REFIT, LS_REFIT_DAYS, type LsResult } from '../utils/leagueSettings';
import { loadRows, liveRows, storedBox, gridSnap, plRating } from './bbGrid';

db.exec(`CREATE TABLE IF NOT EXISTS bb_tuned (id TEXT PRIMARY KEY, params TEXT NOT NULL, report TEXT, at TEXT NOT NULL)`);

/**
 * fix236: variant = the settings the group runs with ('full' = the shared + the leagues' own, 'shared' = the leagues'
 * own dropped: they lost the test season), basis = the #4 inputs the test read, checks = what each variant scored (a
 * failing group: with the leagues' own dropped, #4's proxy at its value before the fix228 fit, #4's proxy off).
 */
export type GateCheck = { name: string; pass: boolean; whole: number; first25: number; live: boolean };
export type GroupGate = { group: string; pass: boolean; reason: string; whole: any; first25: any; oracle: any; leagues: string[]; variant?: 'full' | 'shared'; basis?: string; checks?: GateCheck[] };
export type GridState = { params: GridParams; gate: Record<string, GroupGate>; stats: { mean: number[]; sd: number[] }; at: string; perLeague: Record<string, any>; live: any };
let gs: GridState | null = null;
let ver = 0;
onState('bb:grid:p', (_k, v: any) => { gs = v as GridState; ver++; });
export const gridParamsVer = () => ver;
export const gridState = () => gs;

/** The stored shared settings (or the code defaults), without any league's own settings. */
export function sharedParams(): GridParams {
  const r = db.prepare(`SELECT params FROM bb_tuned WHERE id = 'live'`).get() as any;
  if (r) { try { const p = JSON.parse(r.params) as GridParams; delete p.league; return p; } catch (e: any) { logger.warn(`bb_tuned: ${e.message}`); } }
  return GRID_DEFAULT;
}
/** fix223: the shared settings a league fit was made on (a new shared tune makes the league settings stale) */
export const baseKey = (p: GridParams) => `${p.version}|${p.fittedAt || ''}`;
/** fix223: the stored league settings (bb_tuned 'leagues'): used only while their shared base is the one live */
export function storedLeagues(): { base: string; at: string; league: Record<string, LeagueSet>; report: any } | null {
  const r = db.prepare(`SELECT params, report, at FROM bb_tuned WHERE id = 'leagues'`).get() as any;
  if (!r) return null;
  try { const v = JSON.parse(r.params); return { base: v.base, at: r.at, league: v.league || {}, report: r.report ? JSON.parse(r.report) : null }; } catch { return null; }
}
/** The settings live: the shared ones + the leagues' own (fix223) when they were fitted on these shared ones. */
export function storedParams(): GridParams {
  const p = sharedParams(), l = storedLeagues();
  return l && l.base === baseKey(p) && Object.keys(l.league).length ? { ...p, league: l.league } : p;
}

/**
 * fix236: the gate's inputs = what each group runs live: the NBA's #4 from who actually played (live: the injury report
 * + confirmed starters on every game, fix217 / fix228), every other league the news / rest proxy it reads live.
 * (fix219–fix228 judged the NBA blind, #4 = 0: a test of a model the NBA never runs.)
 */
export const gateInputs = (items: GridItem[], p: GridParams) => inputsFor(items, p, 'oracle');
export const gateBasis = (group: string) => (group === 'NBA' ? '#4 = who actually played (live: injury report + confirmed starters)' : '#4 = the news / rest proxy (as live)');

/** the settings a group's league runs with (fix236 variant 'shared': the leagues' own settings dropped) */
const withoutLeagues = (p: GridParams, codes: string[]): GridParams => {
  if (!p.league) return p;
  const league = Object.fromEntries(Object.entries(p.league).filter(([c]) => !codes.includes(c)));
  return { ...p, league: Object.keys(league).length ? league : undefined };
};

/**
 * The gate of every group on the test season with these settings (`items` = gateInputs: the inputs live has). bb-v4
 * must beat bb-v3 on the whole season and on games 1–25. fix236: a group that fails is checked again with its leagues'
 * own settings dropped (those may run live: a return to the shared settings, not a new fit) and, as a diagnosis only,
 * with #4's proxy at its value before the fix228 fit (`proxyBefore`) and with #4's proxy off.
 */
export function gridGate(items: GridItem[], p: GridParams, opt: { proxyBefore?: number | null } = {}): Record<string, GroupGate> {
  const out: Record<string, GroupGate> = {};
  const groups = [...new Set(items.map(x => groupOf(x.code)))];
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  for (const gname of groups) {
    const test = items.filter(x => groupOf(x.code) === gname && x.year === GRID_TEST);
    const first = test.filter(x => x.gp < 25);
    const codes = [...new Set(test.map(x => x.code))].sort();
    const judge = (q: GridParams) => {
      const whole = compare(q, test), f25 = compare(q, first);
      const ok1 = test.length >= 200 && whole.v4.logLoss < whole.v3.logLoss, ok2 = first.length >= 50 && f25.v4.logLoss < f25.v3.logLoss;
      const why = [!ok1 && (test.length < 200 ? `only ${test.length} test games` : `whole season ${whole.v4.logLoss} vs bb-v3 ${whole.v3.logLoss}`), !ok2 && (first.length < 50 ? `only ${first.length} games 1–25` : `games 1–25 ${f25.v4.logLoss} vs bb-v3 ${f25.v3.logLoss}`)].filter(Boolean) as string[];
      return { pass: ok1 && ok2, whole, f25, why };
    };
    const full = judge(p);
    let use = full, variant: 'full' | 'shared' = 'full';
    const checks: GateCheck[] = [];
    if (!full.pass) {
      const own = codes.filter(c => p.league?.[c]);
      if (own.length) {
        const s = judge(withoutLeagues(p, own));
        checks.push({ name: `without the leagues' own settings (${own.join(', ')})`, pass: s.pass, whole: r5(s.whole.v4.logLoss), first25: r5(s.f25.v4.logLoss), live: true });
        if (s.pass) { use = s; variant = 'shared'; }
      }
      if (p.miss && gname !== 'NBA') {
        const px = (v: number): GridParams => ({ ...p, miss: { ...p.miss!, proxy: v } });
        if (typeof opt.proxyBefore === 'number' && Math.abs(opt.proxyBefore - p.miss.proxy) > 1e-9) {
          const b = judge(px(opt.proxyBefore));
          checks.push({ name: `#4 proxy ${opt.proxyBefore} (before the fix228 fit; now ${p.miss.proxy})`, pass: b.pass, whole: r5(b.whole.v4.logLoss), first25: r5(b.f25.v4.logLoss), live: false });
        }
        if (p.miss.proxy) {
          const z = judge(px(0));
          checks.push({ name: '#4 proxy off', pass: z.pass, whole: r5(z.whole.v4.logLoss), first25: r5(z.f25.v4.logLoss), live: false });
        }
      }
    }
    const reason = use.pass
      ? `bb-v4 beats bb-v3 on the whole test season and on games 1–25${variant === 'shared' ? ` (with the leagues' own settings dropped: with them ${full.why.join('; ')})` : ''}`
      : `bb-v3 stays: ${full.why.join('; ')}${checks.length ? ` · checked: ${checks.map(c => `${c.name} ${c.whole} / ${c.first25}${c.pass ? ' passes' : ''}${c.pass && !c.live ? ' (diagnosis only)' : ''}`).join('; ')}` : ''}`;
    out[gname] = {
      group: gname, pass: use.pass, reason, whole: { v3: use.whole.v3, v4: use.whole.v4 }, first25: { v3: use.f25.v3, v4: use.f25.v4 }, oracle: use.whole.oracle, leagues: codes,
      variant, basis: gateBasis(gname), ...(checks.length ? { checks } : {})
    };
  }
  return out;
}

function perLeague(items: GridItem[], p: GridParams, year: (y: number) => boolean) {
  const out: Record<string, any> = {};
  for (const code of [...new Set(items.map(x => x.code))].sort()) { const l = items.filter(x => x.code === code && year(x.year)); if (l.length) { const c = compare(p, l); out[code] = { games: c.games, v3: c.v3, v4: c.v4 }; } }
  return out;
}

/**
 * fix228: the rows as the settings read them. With #4 frozen (p.miss): 'oracle' = the NBA's #4 is who actually played
 * (what the injury report gives live: the tunes, the split's spread), 'blind' = the NBA's #4 is 0 (fix219–228's gate against
 * bb-v3, which had no injury information in those seasons either). Without it: the stored rows.
 * fix236: the gate reads 'oracle' too (gateInputs: the NBA's injury report is known on every live game).
 */
export const inputsFor = (items: GridItem[], p: GridParams, mode: 'oracle' | 'blind') => { const x = impactInputs(items, p.impact); return p.miss ? missInputs(x, mode) : x; };

/** fix236: the #4 proxy weight before the stored fix228 fit (the gate's diagnosis of a failing group) */
const proxyBefore = () => storedMiss()?.before?.other ?? null;

/** Gate + stats with the stored settings over every league's stored rows; published for every process. */
export function publishGridState(items = loadRows(), p = storedParams()): GridState {
  const live = gateInputs(items, p); // fix236: the gate and the tables on the inputs live has (NBA #4 = who played)
  const train = live.filter(x => (p.train || GRID_TRAIN).includes(x.year));
  const s: GridState = {
    params: p, gate: gridGate(live, p, { proxyBefore: proxyBefore() }), stats: rowStats(train), at: new Date().toISOString(),
    perLeague: perLeague(live, p, y => y === GRID_TEST), live: perLeague(live, p, y => y >= GRID_LIVE_FROM)
  };
  gs = s; ver++;
  try { noteEngines(s.gate); } catch (e: any) { logger.warn(`bb engine log: ${e?.message || e}`); }
  publishState('bb:grid:p', s);
  return s;
}

/* ---------- fix236: which engine each group runs, why, since when (bb_tuned 'engine') ---------- */

export type EngineRow = { group: string; engine: 'bb-v3' | 'bb-v4'; variant: 'full' | 'shared'; reason: string; basis: string; since: string; leagues: string[] };
export function engineLog(): Record<string, EngineRow> {
  const r = db.prepare(`SELECT params FROM bb_tuned WHERE id = 'engine'`).get() as any;
  try { return r?.params ? JSON.parse(r.params) : {}; } catch { return {}; }
}
/** keeps `since` while a group's engine (and variant) stays the same; a change starts a new `since` */
function noteEngines(gate: Record<string, GroupGate>, now = new Date().toISOString()) {
  const old = engineLog(), next: Record<string, EngineRow> = { ...old };
  for (const g of Object.values(gate)) {
    const engine = g.pass ? 'bb-v4' : 'bb-v3', variant = g.variant || 'full';
    const prev = old[g.group];
    const same = prev && prev.engine === engine && prev.variant === variant;
    next[g.group] = { group: g.group, engine, variant, reason: g.reason, basis: g.basis || '', since: same ? prev.since : now, leagues: g.leagues };
    if (!same) logger.info(`bb engine ${g.group}: ${prev ? `${prev.engine} → ` : ''}${engine}${variant === 'shared' ? ' (shared settings)' : ''} — ${g.reason}`);
  }
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('engine', ?, NULL, ?)`).run(JSON.stringify(next), now);
}
/** the engine each group runs now (BB_GRID=on|off overrides every group) */
export function engineInfo() {
  const env = String(process.env.BB_GRID || '').toLowerCase();
  const log = engineLog();
  const groups = Object.values(gs?.gate || {}).map(g => {
    const engine: 'bb-v3' | 'bb-v4' = env === 'off' ? 'bb-v3' : env === 'on' || g.pass ? 'bb-v4' : 'bb-v3';
    return { group: g.group, engine, variant: g.variant || 'full', reason: env === 'on' || env === 'off' ? `BB_GRID=${env} (gate: ${g.reason})` : g.reason, basis: g.basis || gateBasis(g.group), since: log[g.group]?.since || null, leagues: g.leagues };
  });
  return { env: env || null, at: gs?.at || null, groups };
}
/** Data health "Basketball engine per group": warn when the NBA runs bb-v3 (or nothing is published yet) */
export function engineHealth(): Check[] {
  const e = engineInfo();
  const nba = e.groups.find(g => g.group === 'NBA');
  const level = !gs ? 'warn' : nba && nba.engine === 'bb-v3' ? 'warn' : 'ok';
  const since = (s: string | null) => (s ? ` since ${s.slice(0, 16).replace('T', ' ')} UTC` : '');
  return [{
    id: 'bb-engine', label: 'Basketball engine per group', level,
    detail: !gs ? 'No bb-v4 gate published yet (the next basketball model build publishes it): every league runs bb-v3'
      : `${e.groups.map(g => `${g.group} ${g.engine}${g.variant === 'shared' ? ' (shared settings)' : ''}`).join(' · ')}${nba?.engine === 'bb-v3' ? ' — the NBA runs bb-v3: no grid on its game pages' : ''}${e.env ? ` · BB_GRID=${e.env}` : ''}`,
    items: e.groups.map(g => `${g.group}: ${g.engine}${since(g.since)} — ${g.reason} [${g.basis}]`)
  }];
}

/**
 * /api/bb/tune: fit on `train`, report on `test` (+ the live period, never tuned); apply = store + publish.
 * fix222: `auto` = the worker's own run on the live database (after the deploy, then monthly): applied only when at
 * least one group passes the gate with the new weights and the test season is not worse than with the settings live
 * now; the run is remembered either way (bb_tuned 'auto').
 * fix223: while nothing is stored on this database (the code defaults were fitted on the 10 Oct copy), the first run is
 * applied when the gate passes (a group beats bb-v3 on the test season) — "not worse than the settings live" only from
 * the second run on; always compared with the shared settings (the leagues' own are refitted after an applied tune:
 * runLeagueTune). apply = 'gate' does the same from /api/bb/tune?apply=gate.
 */
export async function runTune(opt: { train?: number[]; test?: number; apply?: boolean | 'gate'; rounds?: number; auto?: string }) {
  const train = opt.train && opt.train.length ? opt.train : GRID_TRAIN, test = opt.test ?? GRID_TEST;
  assertTrainYears(train, test);
  // fix228: with #4 frozen the tune reads the inputs live has (NBA #4 = who played) and never moves #4
  const raw = loadRows(), all = inputsFor(raw, sharedParams(), 'oracle');
  await yieldLoop();
  const tr = all.filter(x => train.includes(x.year));
  if (tr.length < 500) throw new Error(`only ${tr.length} training games (build the basketball model first)`);
  const t0 = Date.now();
  const fit = await fitGrid(tr, sharedParams(), { rounds: opt.rounds, pause: yieldLoop });
  const params: GridParams = { ...fit.params, version: `fit ${new Date().toISOString().slice(0, 10)}`, train };
  const stats = rowStats(tr);
  const te = all.filter(x => x.year === test);
  const report = {
    train, test, trainGames: tr.length, testGames: te.length, ms: Date.now() - t0, trainLL: Math.round(fit.trainLL * 1e5) / 1e5, startLL: Math.round(fit.startLL * 1e5) / 1e5,
    offsetLeagues: fit.offsetLeagues,
    split: GRID_ROWS.map((r, i) => ({ id: r.id, name: r.name, weight: Math.round(params.w[i] * 1000) / 1000, points: fittedSplit(params.w, stats.sd)[i], sd: stats.sd[i] })),
    stretch: params.stretch, offsets: params.offsets,
    testTable: { all: compare(params, te), first25: compare(params, te.filter(x => x.gp < 25)), byGroup: gridGate(gateInputs(raw, params).filter(x => x.year === test), params, { proxyBefore: proxyBefore() }), byLeague: perLeague(gateInputs(raw, params), params, y => y === test) },
    live: { note: 'the live period: reported, never tuned', byLeague: perLeague(gateInputs(raw, params), params, y => y >= GRID_LIVE_FROM) },
    params
  };
  const fittedAt = new Date().toISOString();
  let apply = opt.apply === true, auto: AutoTune | null = null;
  if (opt.auto || opt.apply === 'gate') {
    const cur = sharedParams(), first = !hasStored();
    const before = compare(cur, te).v4.logLoss, after = report.testTable.all.v4.logLoss;
    const passing = Object.values(report.testTable.byGroup).filter(g => g.pass).map(g => g.group);
    apply = passing.length > 0 && (first || after <= before + 1e-6);
    const reason = !passing.length ? `not applied: no group beats bb-v3 on ${test} with the new weights`
      : !apply ? `not applied: test log loss ${after} vs ${before} with the settings live now (${cur.version})`
        : `applied${first ? ' (the first tune stored on this database: the gate decides)' : ''}: test log loss ${before} (${cur.version}) → ${after}; bb-v4 live in ${passing.join(', ')}`;
    auto = { why: opt.auto || 'admin (apply if the gate passes)', at: fittedAt, applied: apply, reason, before, after, passing, train, test, trainGames: tr.length, testGames: te.length, rule: AUTO_RULE };
    db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('auto', ?, ?, ?)`).run(JSON.stringify(params), JSON.stringify(auto), fittedAt);
    logger.info(`bb-v4 tune on the live database (${opt.auto}): ${tr.length} train games, ${te.length} test games — ${reason}`);
  }
  if (apply) {
    db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, ?, ?)`)
      .run(JSON.stringify(params), JSON.stringify({ ...report, params: undefined, source: opt.auto ? 'live database (worker)' : 'admin', fittedAt, auto }), fittedAt);
    publishGridState(raw, params);
  }
  return { ...report, auto };
}

/** fix222: the worker's own tune (bb_tuned 'auto'): when it ran, on what, and whether it was applied */
export type AutoTune = { why: string; at: string; applied: boolean; reason: string; before: number; after: number; passing: string[]; train: number[]; test: number; trainGames: number; testGames: number; rule?: string };
export const AUTO_TUNE_DAYS = 30;
/** fix223: the apply rule of a run (a fix222 run that stored nothing is run once more under the first-store rule) */
const AUTO_RULE = 'fix223';
export const hasStored = () => !!db.prepare(`SELECT 1 FROM bb_tuned WHERE id = 'live'`).get();
export function lastAutoTune(): AutoTune | null {
  const r = db.prepare(`SELECT report FROM bb_tuned WHERE id = 'auto'`).get() as any;
  try { return r?.report ? JSON.parse(r.report) : null; } catch { return null; }
}
/** why a tune on the live database is due now (null = not due): nothing tuned here yet, or the last one is 30+ days old */
export function autoTuneDue(now = Date.now()): string | null {
  const last = lastAutoTune();
  if (!last) return 'first tune on the live database';
  // fix223: fix222's run stored nothing here (not better than the code defaults): once more under the first-store rule
  if (!hasStored() && last.rule !== AUTO_RULE) return `first tune stored on the live database (the run of ${last.at.slice(0, 10)}: ${last.reason})`;
  return now - Date.parse(last.at) > AUTO_TUNE_DAYS * 86400000 ? `monthly re-tune (last ${last.at.slice(0, 10)})` : null;
}
/** the morning report's line */
export function autoTuneLine(): string | null {
  const a = lastAutoTune();
  if (!a) return null;
  const next = new Date(Date.parse(a.at) + AUTO_TUNE_DAYS * 86400000).toISOString().slice(0, 10);
  return `Basketball bb-v4 tune on the live database ${a.at.slice(0, 16).replace('T', ' ')} UTC (train ${a.train.join(', ')}, test ${a.test}; ${a.trainGames} / ${a.testGames} games): ${a.reason}. Next re-tune ${next}.`;
}

/** /api/bb/tuned: the stored settings and the last report; reload = publish again, clear = back to the code defaults. */
export function tunedInfo(action?: 'reload' | 'clear') {
  if (action === 'clear') db.exec(`DELETE FROM bb_tuned WHERE id = 'live'`);
  if (action) publishGridState();
  const r = db.prepare(`SELECT report, at FROM bb_tuned WHERE id = 'live'`).get() as any;
  let report: any = null;
  try { report = r?.report ? JSON.parse(r.report) : null; } catch { report = null; }
  const lg = storedLeagues();
  return {
    stored: !!r, at: r?.at || null, params: storedParams(), report, auto: lastAutoTune(), autoDue: autoTuneDue(), gate: gs?.gate || null, perLeague: gs?.perLeague || null, live: gs?.live || null, stats: gs?.stats || null,
    leagues: lg ? { at: lg.at, stale: lg.base !== baseKey(sharedParams()), due: leagueTuneDue(), report: lg.report } : { at: null, stale: false, due: leagueTuneDue(), report: null },
    miss: missInfo(), impact: impactInfo(), engine: engineInfo()
  };
}

/* ---------- fix223: per-league settings (like football's league tune; selection + gate in utils/leagueSettings.ts) ---------- */

/** a league's country (bb_leagues: the built-in leagues and the ones added from the admin) → its group when small */
const countries = () => new Map((db.prepare(`SELECT code, country FROM bb_leagues`).all() as any[]).map(r => [r.code as string, r.country as string]));
export const bbLeagueGroup = (code: string, cc = countries()) => regionGroup(cc.get(code));

/** why the league settings are due (null = not due): never fitted, the shared settings changed, or 30+ days old */
export function leagueTuneDue(now = Date.now()): string | null {
  const l = storedLeagues();
  if (!l) return 'first league fit on this database';
  if (l.base !== baseKey(sharedParams())) return `the shared settings changed (fitted on ${l.base.split('|')[0]})`;
  return now - Date.parse(l.at) > LS_REFIT_DAYS * 86400000 ? `monthly refit (last ${l.at.slice(0, 10)})` : null;
}

/**
 * fix223 — every league with 400+ games in 2022-23 … 2024-25: home edge, stretch, sigma and offsets for the 4 big rows
 * (#1 impact, #3 team rating, #4 missing, #6 rest), shrunk toward the shared settings; fit 2022-23 + 2023-24, kept only
 * when it beats the shared model on 2024-25, then refitted on all three; smaller leagues by group (Europe second tier,
 * Asia, Americas, Oceania, Africa); 2025-26 = the untouched check, 2026-27+ reported, never tuned. `apply` (the worker's
 * run and ?apply=1) stores the leagues that passed (bb_tuned 'leagues', with the shared settings they were fitted on)
 * and publishes the settings; a shared tune applied later makes them stale until the next run (storedParams).
 */
export async function runLeagueTune(opt: { auto?: string; apply?: boolean; rounds?: number } = {}) {
  const t0 = Date.now();
  const base = sharedParams(), cc = countries();
  const raw = loadRows(), all = inputsFor(raw, base, 'oracle'); // fix228: the inputs live has (#4 frozen)
  await yieldLoop();
  if (all.filter(x => LS_REFIT.includes(x.year)).length < 500) throw new Error('too few training games (build the basketball model first)');
  const items = all.map(x => Object.assign(x, { league: x.code }));
  const spreads = new Map<string, { r: number }>();
  const spreadAll = (years: number[]) => {
    const k = years.join(',');
    if (!spreads.has(k)) spreads.set(k, spreadOf(base, all.filter(x => years.includes(x.year))));
    return spreads.get(k)!;
  };
  const withSet = (l: GridItem[], s: LeagueSet | null): GridParams => (s ? { ...base, league: Object.fromEntries([...new Set(l.map(x => x.code))].map(c => [c, s])) } : base);
  const res: LsResult<LeagueSet> = await tuneLeagueSettings(items, {
    groupOf: code => regionGroup(cc.get(code)),
    fit: (l, years) => fitLeagueSet(l, base, spreadAll(years), 'own', null, { rounds: opt.rounds, pause: yieldLoop }),
    ll: (l, s) => logLoss(withSet(l, s), l),
    pause: yieldLoop
  });
  const league: Record<string, LeagueSet> = {};
  for (const row of res.leagues) if (row.settings && row.used !== 'shared') league[row.league] = { ...row.settings, src: row.used, group: row.used === 'group' ? row.group : null };
  const live: GridParams = { ...base, league };
  const stats = rowStats(all.filter(x => LS_REFIT.includes(x.year)));
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const total = (year: (y: number) => boolean) => { const l = all.filter(x => year(x.year)); return { games: l.length, shared: l.length ? r5(logLoss(base, l)) : null, used: l.length ? r5(logLoss(live, l)) : null }; };
  const at = new Date().toISOString();
  const report = {
    at, why: opt.auto || 'admin', base: base.version, baseKey: baseKey(base), years: res.years, seconds: Math.round((Date.now() - t0) / 1000),
    leagues: res.leagues.map(r => ({ ...r, settings: league[r.league] || null, split: fittedSplit(weightsFor(live, r.league), stats.sd) })),
    groups: res.groups, rows: LS_ROWS.map(i => GRID_ROWS[i].id), sharedSplit: fittedSplit(base.w, stats.sd),
    total: { test: total(y => y === res.years.test), check: total(y => y === res.years.check), live: total(y => y >= res.years.liveFrom), fit: LS_FIT },
    own: Object.keys(league).filter(k => league[k].src === 'own'), group: Object.keys(league).filter(k => league[k].src === 'group'),
    applied: !!opt.apply
  };
  if (opt.apply) {
    db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('leagues', ?, ?, ?)`).run(JSON.stringify({ base: baseKey(base), league }), JSON.stringify(report), at);
    publishGridState(raw, storedParams());
  }
  logger.info(`bb-v4 league settings (${report.why}${opt.apply ? ', stored' : ', report only'}): own ${report.own.join(', ') || 'none'}; group ${report.group.join(', ') || 'none'}; ${res.years.test} LL ${report.total.test.shared} → ${report.total.test.used}; untouched ${res.years.check} ${report.total.check.shared} → ${report.total.check.used}; live ${report.total.live.shared} → ${report.total.live.used}`);
  return report;
}
/** the morning report's line */
export function leagueTuneLine(): string | null {
  const l = storedLeagues();
  if (!l?.report) return null;
  const r = l.report;
  return `Basketball league settings ${l.at.slice(0, 16).replace('T', ' ')} UTC: own ${r.own?.length || 0}, group ${r.group?.length || 0}, shared ${(r.leagues?.length || 0) - (r.own?.length || 0) - (r.group?.length || 0)}; ${r.years?.test} log loss ${r.total?.test?.shared} → ${r.total?.test?.used}, untouched ${r.years?.check} ${r.total?.check?.shared} → ${r.total?.check?.used}${l.base !== baseKey(sharedParams()) ? ' (stale: the shared settings changed, refit due)' : ''}.`;
}

/* ---------- fix228: row #4 fitted on who actually played, then frozen ---------- */

export type MissReport = {
  at: string; why: string; train: number[]; test: number; seconds: number; applied: boolean; rule: string;
  miss: MissSet; before: { nba: number; other: number; star: number };
  oracle: { trainGames: number; startLL: number; trainLL: number; test: { games: number; cur: number; fit: number; gain: number } };
  proxy: null | { trainGames: number; startLL: number; trainLL: number; test: { games: number; cur: number; fit: number; gain: number } | null };
  gate: MissGate; groups: Record<string, GroupGate>;
  split: { nba: { before: number[]; after: number[] }; other: { before: number[]; after: number[] } };
  params: GridParams;
};
const MISS_RULE = 'fix228';
export function storedMiss(): MissReport | null {
  const r = db.prepare(`SELECT report FROM bb_tuned WHERE id = 'miss'`).get() as any;
  try { return r?.report ? JSON.parse(r.report) : null; } catch { return null; }
}
/** the worker runs the #4 fit once on a database (then #4 stays frozen; a new fit only from the admin card) */
export function missFitDue(): string | null {
  const m = storedMiss();
  return !m || m.rule !== MISS_RULE ? 'first #4 fit on who actually played' : null;
}

/**
 * fix228 — /api/bb/missing-fit (thread job 'bb miss fit'; the worker once a database): row #4's weight from "who actually
 * played" (box score vs the expected rotation = the injury report / confirmed line-up live):
 *  1. the NBA's oracle rows of the train seasons → #4 weight + star factor (all weights refitted, only these two kept);
 *  2. every other league's proxy rows (missed the last 2 games) → their own, smaller weight (≤ the NBA's);
 *  3. the shared tune around the frozen #4 (the other rows, stretch, offsets) on the inputs live has;
 *  4. gate on the test season against the settings live now: NBA games with who played known better, the whole season
 *     of every league no worse. apply = true stores it; 'gate' (the worker, the admin's default) only when it passes.
 */
export async function runMissFit(opt: { train?: number[]; test?: number; apply?: boolean | 'gate'; rounds?: number; auto?: string } = {}): Promise<MissReport> {
  const train = opt.train && opt.train.length ? opt.train : GRID_TRAIN, test = opt.test ?? GRID_TEST;
  assertTrainYears(train, test);
  const t0 = Date.now();
  const raw = loadRows();
  await yieldLoop();
  const cur = sharedParams(), at = new Date().toISOString();
  // fix225: with the box-score impact live the rows are read the way it reads them, and #4 keeps its star factor form
  const rows = impactInputs(raw, cur.impact);
  const oracleAll = missInputs(rows, 'oracle');
  const nba = missSplit(oracleAll.filter(x => usesOracle(x.code) && x.oracle !== null), train, test);
  if (nba.train.length < 300) throw new Error(`only ${nba.train.length} NBA training games with who played known (build the basketball model first)`);
  const om = await fitMiss(nba.train, cur, { rounds: opt.rounds, pause: yieldLoop, form: cur.miss?.top ? 'top' : 'star' });
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  const testOf = (l: GridItem[], a: GridParams, b: GridParams) => (l.length ? { games: l.length, cur: r5(logLoss(a, l)), fit: r5(logLoss(b, l)), gain: r5(logLoss(a, l) - logLoss(b, l)) } : null);
  const m0: MissSet = { w: om.w, star: om.star, ...(om.top ? { top: om.top } : {}), proxy: Math.min(weightsFor(cur, '')[MISS], om.w), fittedAt: at, train, test };
  const shared: GridParams = { ...cur, league: undefined };
  // 2. the other leagues' proxy weight, fitted the same way on their own (stored) rows
  const others = missSplit(rows.filter(x => !usesOracle(x.code)), train, test);
  const px = others.train.length >= 300 ? await fitProxy(others.train, { ...shared, miss: m0 }, { rounds: opt.rounds, pause: yieldLoop }) : null;
  const miss: MissSet = { ...m0, proxy: px ? px.proxy : m0.proxy };
  // 3. the shared tune around the frozen #4
  const all = missSplit(oracleAll, train, test);
  const fit = await fitGrid(all.train, { ...shared, miss }, { rounds: opt.rounds, pause: yieldLoop });
  const params: GridParams = { ...fit.params, miss, version: `fit ${at.slice(0, 10)} (#4 frozen)`, fittedAt: at, train };
  // 4. the gate (inputs live has) + bb-v4 against bb-v3 per group (fix236: NBA #4 = who played, as live)
  const gate = missGate(all.test, params, cur);
  const groups = gridGate(gateInputs(raw, params).filter(x => x.year === test), params, { proxyBefore: weightsFor(cur, '')[MISS] });
  const apply = opt.apply === true || ((opt.apply === 'gate' || !!opt.auto) && gate.pass);
  const sdN = rowStats(nba.train).sd, sdO = rowStats(others.train).sd;
  const before = missFrom(cur, 'NBA');
  const report: MissReport = {
    at, why: opt.auto || 'admin', train, test, seconds: Math.round((Date.now() - t0) / 1000), applied: apply, rule: MISS_RULE, miss,
    before: { nba: Math.round(before.w * 1e4) / 1e4, other: Math.round(weightsFor(cur, '')[MISS] * 1e4) / 1e4, star: before.star },
    oracle: { trainGames: nba.train.length, startLL: om.startLL, trainLL: om.trainLL, test: testOf(nba.test, cur, om.params) ?? { games: 0, cur: 0, fit: 0, gain: 0 } },
    proxy: px ? { trainGames: others.train.length, startLL: px.startLL, trainLL: px.trainLL, test: testOf(others.test, shared, { ...shared, miss }) } : null,
    gate, groups,
    split: {
      nba: { before: fittedSplit(weightsFor(cur, 'NBA'), sdN), after: fittedSplit(weightsFor(params, 'NBA'), sdN) },
      other: { before: fittedSplit(weightsFor(cur, ''), sdO), after: fittedSplit(weightsFor(params, ''), sdO) }
    },
    params
  };
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('miss', ?, ?, ?)`).run(JSON.stringify(miss), JSON.stringify(report), at);
  if (apply) {
    db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, ?, ?)`)
      .run(JSON.stringify(params), JSON.stringify({ trainGames: all.train.length, testGames: all.test.length, trainLL: Math.round(fit.trainLL * 1e5) / 1e5, startLL: Math.round(fit.startLL * 1e5) / 1e5, offsetLeagues: fit.offsetLeagues, source: `fix228 #4 fit (${report.why})`, fittedAt: at, miss: report.gate }), at);
    publishGridState(raw, storedParams());
  }
  logger.info(`bb-v4 #4 fit on who actually played (${report.why}${apply ? ', stored' : ', not stored'}): NBA weight ${report.before.nba} → ${miss.w} (star ${miss.star}), other leagues ${report.before.other} → ${miss.proxy}; ${gate.reason}`);
  return report;
}

/** the morning report's line */
export function missFitLine(): string | null {
  const m = storedMiss();
  if (!m) return null;
  return `Basketball #4 missing players (who actually played, ${m.at.slice(0, 10)}): NBA weight ${m.before.nba} → ${m.miss.w} (star ${m.miss.star}), other leagues ${m.before.other} → ${m.miss.proxy}; ${m.gate.reason}${m.applied ? '' : ' (not stored)'}.`;
}

/** #4's move of the margin (home view, points) in an NBA game from its logged same-day difference (older log rows) */
const moveOf = (r: { row4: number | null; same_day: number }, p: GridParams | null) =>
  typeof r.row4 === 'number' ? r.row4 : p ? weightsFor(p, 'NBA')[MISS] * (p.miss ? starOf(r.same_day, p.miss.star) : r.same_day) : 0;
/** the latest pre-tip log row of each finished NBA bb-v4 game (newest first) */
function nbaLogged(sinceIso: string, finished: boolean) {
  try {
    const rows = db.prepare(`SELECT l.game_id, l.checkpoint, l.p_v4, l.same_day, l.row4, l.margin_after, g.kickoff, g.home_name, g.away_name, g.hs, g.as_, g.status
      FROM bb_v4_log l JOIN bb_games g ON g.game_id = l.game_id WHERE g.code = 'NBA' AND l.mode = 'grid' AND g.kickoff > ?${finished ? ` AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL` : ''}
      ORDER BY g.kickoff DESC, CAST(l.checkpoint AS INTEGER) ASC LIMIT 5000`).all(sinceIso) as any[];
    const seen = new Set<number>();
    return rows.filter(r => (seen.has(r.game_id) ? false : (seen.add(r.game_id), true)));
  } catch { return []; } // (bb_v4_log: created by services/nbaV4.ts)
}
/** admin card: the stored fit, the weights live, the last 20 NBA games where #4 moved the margin 2+ points */
export function missInfo() {
  const p = gs?.params || storedParams(), m = storedMiss();
  const examples = nbaLogged(new Date(Date.now() - 365 * 86400000).toISOString(), true)
    .map(r => ({ r, move: moveOf(r, p) })).filter(x => Math.abs(x.move) >= 2).slice(0, 20)
    .map(({ r, move }) => {
      const homeWon = r.hs > r.as_;
      return {
        gameId: r.game_id, kickoff: r.kickoff, home: r.home_name, away: r.away_name, score: `${r.hs}–${r.as_}`,
        move: Math.round(move * 10) / 10, pHome: Math.round(r.p_v4 * 1000) / 1000, pickRight: (r.p_v4 >= 0.5) === homeWon, fourRight: (move > 0) === homeWon
      };
    });
  return {
    frozen: p.miss || null, live: { nba: Math.round(weightsFor(p, 'NBA')[MISS] * 1e4) / 1e4, other: Math.round(weightsFor(p, '')[MISS] * 1e4) / 1e4 },
    due: missFitDue(), report: m ? { ...m, params: undefined } : null, examples
  };
}

/** Data health "Missing players row": the weights live and the games #4 moved this week (NBA log; other leagues' statuses) */
export function missingRowHealth(now = Date.now()): Check[] {
  const p = gs?.params || storedParams();
  const since = new Date(now - 7 * 86400000).toISOString();
  const nba = nbaLogged(since, false), moved = nba.filter(r => Math.abs(moveOf(r, p)) >= 1);
  let other = 0;
  try { other = (db.prepare(`SELECT COUNT(DISTINCT r.game_id) AS n FROM bb_rest_log r JOIN bb_games g ON g.game_id = r.game_id WHERE r.kickoff > ? AND g.code != 'NBA'`).get(since) as any)?.n || 0; } catch { other = 0; }
  const w = (code: string) => Math.round(weightsFor(p, code)[MISS] * 100) / 100;
  const m = storedMiss();
  return [{
    id: 'bb-missing-row', label: 'Missing players row (basketball #4)', level: p.miss ? 'ok' : 'warn',
    detail: `${p.miss ? `Frozen at the who-actually-played fit (${p.miss.fittedAt.slice(0, 10)})` : 'Not frozen: weight from history without injury reports'} · NBA ${w('NBA')} pts per point of lost impact${p.miss?.star ? ` (star ×${p.miss.star})` : ''}, other leagues ${w('')} · this week: NBA ${moved.length} of ${nba.length} priced game(s) moved 1+ point, other leagues ${other} game(s) with news / rest statuses`,
    items: [
      ...(m ? [`Last fit ${m.at.slice(0, 16).replace('T', ' ')} UTC: ${m.gate.reason}${m.applied ? '' : ' (not stored)'}`] : ['No #4 fit on this database yet (the worker runs it once)']),
      // fix225: which player values #1 / #4 / #8 read
      ((im = storedImpact()) => p.impact ? `Player impact: box score ×${p.impact.wb} + on/off, star factor ×${p.miss?.top ?? 1} (fix225, ${p.impact.fittedAt.slice(0, 10)})` : `Player impact: on/off only${im ? ` (fix225 fit ${im.at.slice(0, 10)}: ${im.gate.reason})` : ' (fix225 fit not run yet)'}`)(),
      ...moved.slice(0, 10).map(r => `${String(r.kickoff).slice(0, 10)} ${r.home_name} – ${r.away_name}: #4 ${Math.round(moveOf(r, p) * 10) / 10} pts`)
    ]
  }];
}

/** fix236: the settings a league runs with live (its group's gate variant 'shared' = the leagues' own dropped) */
export const groupParams = (p: GridParams, gate: Record<string, GroupGate>, code: string) => (gate[groupOf(code)]?.variant === 'shared' ? withoutLeagues(p, [code]) : p);
export const liveParams = (code: string): GridParams | null => (gs ? groupParams(gs.params, gs.gate, code) : null);
/** the live weight of row i for a league (shared + offset) */
export const gridWeight = (code: string, i: number) => { const p = liveParams(code); return p ? weightsFor(p, code)[i] : 0; };

/** Is bb-v4 live for this league (its group passed the gate)? BB_GRID=on|off overrides every league. */
export function gridLive(code: string): boolean {
  const env = String(process.env.BB_GRID || '').toLowerCase();
  if (env === 'off') return false;
  if (!gs) return false;
  return env === 'on' || !!gs.gate[groupOf(code)]?.pass;
}

/**
 * bb-v4 for an upcoming game from bb-v3's prediction (x.p: its chance before the injury points; home edges, rest; sigma) and, for the NBA, the injury report's lost impact (#4). null = not live for the league / no team values.
 */
export function gridPredict(g: { code: string; home_id: number; away_id: number; kickoff: string; season: string; week?: string | null }, x: { p: number; hca: number; haH?: number; haA?: number; b2bHome: boolean; b2bAway: boolean }, sigma: number, miss?: { home: number; away: number; homeTop?: number; awayTop?: number }): { pHome: number; margin: number; parts: number[]; view: GridView } | null {
  if (!gridLive(g.code) || !gs) return null;
  const r = liveRows(g, { p: x.p, sig: sigma, hca: x.hca, haH: x.haH || 0, haA: x.haA || 0, b2bH: x.b2bHome, b2bA: x.b2bAway }, miss, gs.params.impact);
  if (!r) return null;
  const it = { hv: r.hv, av: r.av, sig: sigma, t4: r.t4 };
  const p = liveParams(g.code)!;
  const e = gridEval(p, g.code, it);
  return { pHome: e.pHome, margin: e.margin, parts: e.parts, view: split1000(p, g.code, it, gs.stats.sd) };
}

/** Row sanity from the game-page views (the rows a live prediction used): see rowSanity. */
export function rowSanityViews(list: { label: string; view: GridView }[]) {
  const rows = list.map(x => {
    const hv = new Array<number>(N_ROWS).fill(0), av = new Array<number>(N_ROWS).fill(0);
    for (const r of x.view.rows) { const i = GRID_ROWS.findIndex(g => g.id === r.id); if (i >= 0) { hv[i] = r.home; av[i] = r.away; } }
    return { label: x.label, hv, av };
  });
  return rowSanity(rows);
}

/** bb-v4 against bb-v3 per league on finished games with both chances saved (bb_v4_shadow), for the daily report. */
export function gridReportLines(now = Date.now()): string[] {
  const first = db.prepare(`SELECT MIN(s.made_at) AS t FROM bb_v4_shadow s WHERE s.mode = 'grid'`).get() as any;
  if (!first?.t || now - Date.parse(first.t) > 15 * 86400000) return [];
  const rows = db.prepare(`SELECT g.code, s.p_v3, s.p_v4, g.hs, g.as_ FROM bb_v4_shadow s JOIN bb_games g ON g.game_id = s.game_id
    WHERE s.mode = 'grid' AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND g.hs != g.as_`).all() as any[];
  const by = new Map<string, any[]>();
  for (const r of rows) { let l = by.get(r.code); if (!l) by.set(r.code, (l = [])); l.push(r); }
  const sc = (l: any[], k: string) => {
    let ll = 0, hit = 0;
    for (const r of l) { const p = Math.min(0.995, Math.max(0.005, r[k])), y = r.hs > r.as_ ? 1 : 0; ll -= y ? Math.log(p) : Math.log(1 - p); hit += (p >= 0.5 ? 1 : 0) === y ? 1 : 0; }
    return `${(ll / l.length).toFixed(3)} / ${Math.round((100 * hit) / l.length)}%`;
  };
  return [
    `Basketball bb-v4 (grid) vs bb-v3 since ${String(first.t).slice(0, 10)}, log loss / picks right (market favourite: no basketball odds feed, n/a):`,
    ...[...by].sort((a, b) => b[1].length - a[1].length).map(([code, l]) => `  ${code} ${l.length} games — v4 ${sc(l, 'p_v4')} · v3 ${sc(l, 'p_v3')}`)
  ];
}

/** Data health "Row sanity": upcoming games whose row differences drift more than 3 sd from the training spread. */
export function rowSanity(rows: { label: string; hv: number[]; av: number[] }[]) {
  if (!gs) return { checked: 0, bad: [] as string[] };
  const { mean, sd } = gs.stats;
  const bad: string[] = [];
  // (#6 rest and #11 motivation are flags: a back-to-back or a tanking team is a normal value, not a drift)
  for (const r of rows) for (let i = 0; i < N_ROWS; i++) {
    if (!(sd[i] > 1e-6) || i === 5 || i === 10) continue;
    const d = i === VOL ? volOf(r) : diff(r, i);
    if (Math.abs(d - mean[i]) > 3 * sd[i]) bad.push(`${r.label}: ${GRID_ROWS[i].id} ${GRID_ROWS[i].name} ${Math.round(d * 100) / 100} (train ${mean[i]} ± ${sd[i]})`);
  }
  return { checked: rows.length, bad };
}

/* ---------- fix225: key players count more (box-score value blended with on/off, the star factor) ---------- */

export type ImpactReport = {
  at: string; why: string; rule: string; train: number[]; test: number; seconds: number; applied: boolean;
  box: BoxCoef; wb: number; tried: { wb: number; trainLL: number }[];
  miss: MissSet; before: { wb: number | null; nba: number; star: number; top: number | null; other: number };
  oracle: { trainGames: number; startLL: number; trainLL: number };
  gate: ImpactGate; groups: Record<string, GroupGate>;
  /** fix236: the stored fit judged again by the gate on the live basis */
  regate?: { rule: string; at: string; why: string; was: string; applied: boolean };
  split: { nba: { before: number[]; after: number[] }; other: { before: number[]; after: number[] } };
  params: GridParams;
};
const IMPACT_RULE = 'fix225';
export function storedImpact(): ImpactReport | null {
  const r = db.prepare(`SELECT report FROM bb_tuned WHERE id = 'impact'`).get() as any;
  try { return r?.report ? JSON.parse(r.report) : null; } catch { return null; }
}
/** the stored rows have the fix225 values (the model build makes them; the fit waits for 90%) */
export function impactRowsReady(): boolean {
  const r = db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN alt IS NOT NULL THEN 1 ELSE 0 END) AS a FROM bb_grid_rows`).get() as any;
  return !!r?.n && r.a / r.n >= 0.9;
}
/** the worker runs the fit once a database, after the rows were rebuilt with the box-score values */
export function impactFitDue(): string | null {
  const m = storedImpact();
  return !m || m.rule !== IMPACT_RULE ? 'first fit of the box-score impact' : null;
}

/**
 * fix225 — /api/bb/impact-fit (thread job 'bb impact fit'; the worker once a database): player impact = wb × box-score
 * value + (1 − wb) × on/off (minutes-scaled shrink), read by rows #1 / #4 / #8 and the oracle.
 *  1. wb by pattern search from 0.6 on the train seasons' log loss (each try: #4 + star factor on the NBA's oracle rows,
 *     the other leagues' proxy weight, the shared tune around them, short rounds);
 *  2. the full fit at that wb: #4's weight + the star factor (a top-3 player's loss × 1.0–1.6) on the oracle rows,
 *     frozen, then the shared tune around it (like fix228);
 *  3. gate on the test season against the settings live now (impactGate: NBA and Europe, whole season and games 1–25,
 *     the NBA's who-played-known games). apply = true stores it; 'gate' (the worker, the admin's default) only when it
 *     passes. The report is kept either way (bb_tuned 'impact').
 */
export async function runImpactFit(opt: { train?: number[]; test?: number; apply?: boolean | 'gate'; rounds?: number; auto?: string } = {}): Promise<ImpactReport> {
  const train = opt.train && opt.train.length ? opt.train : GRID_TRAIN, test = opt.test ?? GRID_TEST;
  assertTrainYears(train, test);
  const t0 = Date.now();
  const raw = loadRows();
  await yieldLoop();
  const share = altShare(raw);
  if (share < 0.9) throw new Error(`only ${Math.round(share * 100)}% of the rows have the box-score values (the next basketball model build makes them)`);
  const cur = sharedParams(), at = new Date().toISOString();
  const shared: GridParams = { ...cur, league: undefined };
  const fitAt = async (wb: number, rounds: number | undefined) => {
    const impact: ImpactSet = { wb, box: storedBox(), fittedAt: at, train, test };
    const rows = impactInputs(raw, impact);
    const oracleAll = missInputs(rows, 'oracle');
    const nba = missSplit(oracleAll.filter(x => usesOracle(x.code) && x.oracle !== null), train, test);
    if (nba.train.length < 300) throw new Error(`only ${nba.train.length} NBA training games with who played known`);
    const om = await fitMiss(nba.train, shared, { rounds, pause: yieldLoop, form: 'top' });
    const m0: MissSet = { w: om.w, star: 0, top: om.top, proxy: Math.min(weightsFor(cur, '')[MISS], om.w), fittedAt: at, train, test };
    const others = missSplit(rows.filter(x => !usesOracle(x.code)), train, test);
    const px = others.train.length >= 300 ? await fitProxy(others.train, { ...shared, impact, miss: m0 }, { rounds, pause: yieldLoop }) : null;
    const miss: MissSet = { ...m0, proxy: px ? px.proxy : m0.proxy };
    const all = missSplit(oracleAll, train, test);
    const fit = await fitGrid(all.train, { ...shared, miss, impact }, { rounds, pause: yieldLoop });
    const params: GridParams = { ...fit.params, miss, impact, version: `fit ${at.slice(0, 10)} (box-score impact, wb ${wb})`, fittedAt: at, train };
    return { params, trainLL: Math.round(fit.trainLL * 1e5) / 1e5, om, nbaTrain: nba.train, othersTrain: others.train };
  };
  // 1. wb: the box-score share (pattern search on the train seasons, short fits)
  const tried: { wb: number; trainLL: number }[] = [];
  const quick = new Map<number, number>();
  const ll = async (wb: number) => {
    const k = Math.round(wb * 100) / 100;
    if (!quick.has(k)) { const r = await fitAt(k, Math.min(opt.rounds ?? 12, 12)); quick.set(k, r.trainLL); tried.push({ wb: k, trainLL: r.trainLL }); }
    return quick.get(k)!;
  };
  let wb = WB_START, best = await ll(wb);
  for (let step = 0.2; step >= 0.05 - 1e-9; step /= 2) {
    for (let moved = true; moved;) {
      moved = false;
      for (const dir of [1, -1]) {
        const c = Math.min(1, Math.max(0, Math.round((wb + dir * step) * 100) / 100));
        if (c === wb) continue;
        const x = await ll(c);
        if (x < best - 1e-6) { wb = c; best = x; moved = true; break; }
      }
    }
  }
  // 2. the full fit at that wb
  const f = await fitAt(wb, opt.rounds);
  const params = f.params;
  // 3. the gate: each side on its own inputs as live has them
  const curItems = inputsFor(raw, cur, 'oracle'), nextItems = inputsFor(raw, params, 'oracle');
  const gate = impactGate(curItems, nextItems, cur, params, test);
  const groups = gridGate(gateInputs(raw, params).filter(x => x.year === test), params, { proxyBefore: proxyBefore() });
  const apply = opt.apply === true || ((opt.apply === 'gate' || !!opt.auto) && gate.pass);
  const curN = inputsFor(raw, cur, 'oracle'), sdN = rowStats(curN.filter(x => usesOracle(x.code) && train.includes(x.year))).sd, sdO = rowStats(curN.filter(x => !usesOracle(x.code) && train.includes(x.year))).sd;
  const sdN2 = rowStats(f.nbaTrain).sd, sdO2 = rowStats(f.othersTrain).sd;
  const bm = missFrom(cur, 'NBA');
  const report: ImpactReport = {
    at, why: opt.auto || 'admin', rule: IMPACT_RULE, train, test, seconds: Math.round((Date.now() - t0) / 1000), applied: apply,
    box: storedBox(), wb, tried: tried.sort((a, b) => a.wb - b.wb), miss: params.miss!,
    before: { wb: cur.impact?.wb ?? null, nba: Math.round(bm.w * 1e4) / 1e4, star: bm.star, top: cur.miss?.top ?? null, other: Math.round(weightsFor(cur, '')[MISS] * 1e4) / 1e4 },
    oracle: { trainGames: f.nbaTrain.length, startLL: f.om.startLL, trainLL: f.om.trainLL },
    gate, groups,
    split: {
      nba: { before: fittedSplit(weightsFor(cur, 'NBA'), sdN), after: fittedSplit(weightsFor(params, 'NBA'), sdN2) },
      other: { before: fittedSplit(weightsFor(cur, ''), sdO), after: fittedSplit(weightsFor(params, ''), sdO2) }
    },
    params
  };
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('impact', ?, ?, ?)`).run(JSON.stringify(params.impact), JSON.stringify(report), at);
  if (apply) {
    db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, ?, ?)`)
      .run(JSON.stringify(params), JSON.stringify({ source: `fix225 box-score impact (${report.why})`, fittedAt: at, impact: gate, wb }), at);
    publishGridState(raw, storedParams());
  }
  impactCache = null;
  logger.info(`bb-v4 box-score impact (${report.why}${apply ? ', stored' : ', not stored'}): wb ${wb} (tried ${tried.map(t => `${t.wb}: ${t.trainLL}`).join(', ')}), NBA #4 ${report.before.nba} → ${params.miss!.w} (star factor ×${params.miss!.top}), other leagues ${report.before.other} → ${params.miss!.proxy}; ${gate.reason}`);
  return report;
}

/** the morning report's line */
export function impactFitLine(): string | null {
  const m = storedImpact();
  if (!m) return null;
  return `Basketball player impact (box score × ${m.wb} + on/off × ${Math.round((1 - m.wb) * 100) / 100}, ${m.at.slice(0, 10)}): star factor ×${m.miss.top}, NBA #4 ${m.before.nba} → ${m.miss.w}; ${m.gate.reason}${m.applied ? '' : ' (not stored)'}.`;
}

/**
 * fix236 — the stored fix225 fit judged again by today's gate (no refit): NBA #4 = who played on both sides, games 1–25
 * worse only beyond FIRST25_TOL; stored live when it passes. The worker runs it once a database (impactRegateDue).
 */
const REGATE_RULE = 'fix236';
export function impactRegateDue(): string | null {
  const m = storedImpact();
  if (!m?.params?.impact || m.applied || m.regate?.rule === REGATE_RULE) return null;
  return sharedParams().impact?.fittedAt === m.params.impact.fittedAt ? null : 'fix236: the fix225 fit judged by the gate on the live basis';
}
export async function regateImpact(opt: { apply?: boolean | 'gate'; auto?: string } = {}) {
  const m = storedImpact();
  if (!m?.params?.impact) throw new Error('no fix225 fit stored on this database');
  const raw = loadRows();
  await yieldLoop();
  const cur = sharedParams(), params = m.params, at = new Date().toISOString();
  const gate = impactGate(inputsFor(raw, cur, 'oracle'), inputsFor(raw, params, 'oracle'), cur, params, m.test);
  const groups = gridGate(gateInputs(raw, params).filter(x => x.year === m.test), params, { proxyBefore: proxyBefore() });
  const apply = opt.apply === true || ((opt.apply === 'gate' || !!opt.auto) && gate.pass);
  const regate = { rule: REGATE_RULE, at, why: opt.auto || 'admin', was: m.gate.reason, applied: apply };
  const report: ImpactReport = { ...m, gate, groups, applied: apply, regate };
  db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('impact', ?, ?, ?)`).run(JSON.stringify(params.impact), JSON.stringify(report), m.at);
  if (apply) {
    db.prepare(`INSERT OR REPLACE INTO bb_tuned (id, params, report, at) VALUES ('live', ?, ?, ?)`)
      .run(JSON.stringify(params), JSON.stringify({ source: `fix225 box-score impact, fix236 gate (${regate.why})`, fittedAt: params.fittedAt || m.at, impact: gate, wb: m.wb }), at);
    publishGridState(raw, storedParams());
  }
  impactCache = null;
  logger.info(`bb-v4 box-score impact re-gated (${regate.why}${apply ? ', stored' : ', not stored'}): was "${m.gate.reason}" → ${gate.reason}`);
  return { ...report, params: undefined };
}

/** the impact setting live (null = fix219's on/off ratings) */
export const impactLive = (): ImpactSet | null => gs?.params.impact || null;
/** the star factor live for a league (1 = none) */
export const topFactor = (code: string) => (gs?.params.miss?.top && usesOracle(code) ? gs.params.miss.top : 1);
/** a #4 loss in margin points under the settings live (the star factor on the top-3 part) */
export const row4Points = (code: string, loss: number, lossTop = 0) => gridWeight(code, MISS) * topLoss(loss, lossTop, topFactor(code));

const nameStmt = () => db.prepare(`SELECT name FROM bb_player_stats WHERE player_id = ? AND name IS NOT NULL LIMIT 1`);
let impactCache: { at: number; v: any } | null = null;
/**
 * Admin card "Key players count more (fix225)": the stored fit, the top 20 per league before (fix219's on/off) and after
 * (the blend the fit chose, or the start 0.6 before any fit), and 5 NBA teams' record with / without their top player
 * this season against what the model implies (#4's points before / after).
 */
export function impactInfo() {
  if (impactCache && Date.now() - impactCache.at < 5 * 60000) return impactCache.v;
  const m = storedImpact(), live = impactLive();
  const wb = live?.wb ?? m?.wb ?? WB_START;
  const ns = nameStmt();
  const name = (id: number) => String((ns.get(id) as any)?.name || id);
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const leagues: { code: string; before: { id: number; name: string; rating: number }[]; after: { id: number; name: string; rating: number; was: number }[] }[] = [];
  for (const code of ['NBA', 'EL', 'EC', 'ACB', 'LBA', 'BSL', 'LNB', 'BBL', 'ABA', 'GBL', 'LKL', 'BCL', 'NBL', 'CBA', 'JBL', 'NBB', 'BSN', 'FEC']) {
    const snap = gridSnap(code);
    if (!snap) continue;
    const pool = new Map<number, [number, number, number, number, number?, number?, number?]>();
    for (const t of snap.teams.values()) for (const p of t.pl || []) if (p[2] >= 15 && p[3] <= 9) pool.set(p[0], p);
    if (pool.size < 20 || ![...pool.values()].some(p => typeof p[5] === 'number')) continue;
    const list = [...pool.values()];
    const before = [...list].sort((a, b) => b[1] - a[1]).slice(0, 20).map(p => ({ id: p[0], name: name(p[0]), rating: r1(p[1]) }));
    const after = [...list].sort((a, b) => plRating(b, { wb }) - plRating(a, { wb })).slice(0, 20).map(p => ({ id: p[0], name: name(p[0]), rating: r1(plRating(p, { wb })), was: r1(p[1]) }));
    leagues.push({ code, before, after });
  }
  const v = {
    live: live ? { wb: live.wb, box: live.box, top: gs?.params.miss?.top ?? null, fittedAt: live.fittedAt } : null,
    due: impactFitDue(), report: m ? { ...m, params: undefined } : null, wb, feats: BOX_FEATS, box: storedBox(),
    leagues, withWithout: withWithout(m, wb)
  };
  impactCache = { at: Date.now(), v };
  return v;
}

/** 5 NBA teams whose top player missed the most games this season: real margin with / without him against #4's points */
function withWithout(m: ImpactReport | null, wb: number) {
  const snap = gridSnap('NBA');
  if (!snap) return [];
  const p = gs?.params || storedParams();
  const season = (db.prepare(`SELECT season FROM bb_games WHERE code = 'NBA' AND status IN ('FT','AOT') GROUP BY season HAVING COUNT(*) >= 100 ORDER BY season DESC LIMIT 1`).get() as any)?.season;
  if (!season) return [];
  const games = db.prepare(`SELECT g.game_id, g.home_id, g.away_id, g.hs, g.as_ FROM bb_games g WHERE g.code = 'NBA' AND g.season = ? AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND g.stats = 1`).all(season) as any[];
  const playedBy = new Map<number, Set<number>>();
  for (const r of db.prepare(`SELECT ps.game_id, ps.player_id FROM bb_player_stats ps JOIN bb_games g ON g.game_id = ps.game_id WHERE g.code = 'NBA' AND g.season = ? AND ps.minutes > 0`).all(season) as any[]) {
    let s = playedBy.get(r.game_id); if (!s) playedBy.set(r.game_id, (s = new Set())); s.add(r.player_id);
  }
  const L = snap.gameMin;
  const ns = nameStmt();
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const beforeW = m ? m.before.nba : weightsFor(p, 'NBA')[MISS], beforeStar = m ? m.before.star : p.miss?.star || 0;
  const afterW = m ? m.miss.w : null, afterTop = m ? m.miss.top ?? 1 : null;
  const out: any[] = [];
  for (const [teamId, t] of snap.teams) {
    if (!t.pl?.length) continue;
    const star = [...t.pl].filter(x => x[6] === 1).sort((a, b) => plRating(b, { wb }) * b[2] - plRating(a, { wb }) * a[2])[0];
    if (!star) continue;
    const mine = games.filter(g => g.home_id === teamId || g.away_id === teamId);
    const marg = (g: any) => (g.home_id === teamId ? g.hs - g.as_ : g.as_ - g.hs);
    const w = mine.filter(g => playedBy.get(g.game_id)?.has(star[0])), wo = mine.filter(g => !playedBy.get(g.game_id)?.has(star[0]));
    if (w.length < 10 || wo.length < 3) continue;
    const mean = (l: any[]) => l.reduce((s, g) => s + marg(g), 0) / l.length;
    // what the team's strength loses without him (the rotation re-filled), under each rating set
    const loss = (rate: (x: PlRowT) => number) => {
      const pl = t.pl!.map(x => ({ id: x[0], min: x[2], rating: rate(x) })); // (all of the last 10 games: he may be out now)
      const S = (k?: Map<number, number>) => strength(rotation(pl, k, L), L);
      return S(new Map([[star[0], 0]])) - S();
    };
    const lb = loss(x => x[1]), la = loss(x => plRating(x, { wb }));
    out.push({
      team: (db.prepare(`SELECT home_name AS n FROM bb_games WHERE home_id = ? AND home_name IS NOT NULL ORDER BY kickoff DESC LIMIT 1`).get(teamId) as any)?.n || String(teamId),
      player: String((ns.get(star[0]) as any)?.name || star[0]), season, with: { games: w.length, margin: r1(mean(w)) }, without: { games: wo.length, margin: r1(mean(wo)) },
      real: r1(mean(w) - mean(wo)), before: r1(-beforeW * starOf(lb, beforeStar)), after: afterW === null ? null : r1(-afterW * topLoss(la, la, afterTop ?? 1))
    });
  }
  return out.sort((a, b) => b.without.games - a.without.games).slice(0, 5);
}
type PlRowT = [number, number, number, number, number?, number?, number?];

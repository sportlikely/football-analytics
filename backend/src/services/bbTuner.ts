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
  type GridItem, type GridParams, type GridView, type LeagueSet
} from '../utils/bbGridMath';
import { tuneLeagueSettings, LS_FIT, LS_REFIT, LS_REFIT_DAYS, type LsResult } from '../utils/leagueSettings';
import { loadRows, liveRows } from './bbGrid';

db.exec(`CREATE TABLE IF NOT EXISTS bb_tuned (id TEXT PRIMARY KEY, params TEXT NOT NULL, report TEXT, at TEXT NOT NULL)`);

export type GroupGate = { group: string; pass: boolean; reason: string; whole: any; first25: any; oracle: any; leagues: string[] };
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

/** The gate of every group on the test season with these settings. */
export function gridGate(items: GridItem[], p: GridParams): Record<string, GroupGate> {
  const out: Record<string, GroupGate> = {};
  const groups = [...new Set(items.map(x => groupOf(x.code)))];
  for (const gname of groups) {
    const test = items.filter(x => groupOf(x.code) === gname && x.year === GRID_TEST);
    const first = test.filter(x => x.gp < 25);
    const whole = compare(p, test), f25 = compare(p, first);
    const ok1 = test.length >= 200 && whole.v4.logLoss < whole.v3.logLoss, ok2 = first.length >= 50 && f25.v4.logLoss < f25.v3.logLoss;
    const why = [!ok1 && (test.length < 200 ? `only ${test.length} test games` : `whole season ${whole.v4.logLoss} vs bb-v3 ${whole.v3.logLoss}`), !ok2 && (first.length < 50 ? `only ${first.length} games 1–25` : `games 1–25 ${f25.v4.logLoss} vs bb-v3 ${f25.v3.logLoss}`)].filter(Boolean);
    out[gname] = { group: gname, pass: ok1 && ok2, reason: ok1 && ok2 ? 'bb-v4 beats bb-v3 on the whole test season and on games 1–25' : `bb-v3 stays: ${why.join('; ')}`, whole: { v3: whole.v3, v4: whole.v4 }, first25: { v3: f25.v3, v4: f25.v4 }, oracle: whole.oracle, leagues: [...new Set(test.map(x => x.code))].sort() };
  }
  return out;
}

function perLeague(items: GridItem[], p: GridParams, year: (y: number) => boolean) {
  const out: Record<string, any> = {};
  for (const code of [...new Set(items.map(x => x.code))].sort()) { const l = items.filter(x => x.code === code && year(x.year)); if (l.length) { const c = compare(p, l); out[code] = { games: c.games, v3: c.v3, v4: c.v4 }; } }
  return out;
}

/** Gate + stats with the stored settings over every league's stored rows; published for every process. */
export function publishGridState(items = loadRows(), p = storedParams()): GridState {
  const train = items.filter(x => (p.train || GRID_TRAIN).includes(x.year));
  const s: GridState = {
    params: p, gate: gridGate(items, p), stats: rowStats(train), at: new Date().toISOString(),
    perLeague: perLeague(items, p, y => y === GRID_TEST), live: perLeague(items, p, y => y >= GRID_LIVE_FROM)
  };
  gs = s; ver++;
  publishState('bb:grid:p', s);
  return s;
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
  const all = loadRows();
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
    testTable: { all: compare(params, te), first25: compare(params, te.filter(x => x.gp < 25)), byGroup: gridGate(all.filter(x => x.year === test), params), byLeague: perLeague(all, params, y => y === test) },
    live: { note: 'the live period: reported, never tuned', byLeague: perLeague(all, params, y => y >= GRID_LIVE_FROM) },
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
    publishGridState(all, params);
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
    leagues: lg ? { at: lg.at, stale: lg.base !== baseKey(sharedParams()), due: leagueTuneDue(), report: lg.report } : { at: null, stale: false, due: leagueTuneDue(), report: null }
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
  const all = loadRows();
  await yieldLoop();
  if (all.filter(x => LS_REFIT.includes(x.year)).length < 500) throw new Error('too few training games (build the basketball model first)');
  const base = sharedParams(), cc = countries();
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
    publishGridState(all, storedParams());
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

/** the live weight of row i for a league (shared + offset) */
export const gridWeight = (code: string, i: number) => (gs ? weightsFor(gs.params, code)[i] : 0);

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
export function gridPredict(g: { code: string; home_id: number; away_id: number; kickoff: string; season: string; week?: string | null }, x: { p: number; hca: number; haH?: number; haA?: number; b2bHome: boolean; b2bAway: boolean }, sigma: number, miss?: { home: number; away: number }): { pHome: number; margin: number; view: GridView } | null {
  if (!gridLive(g.code) || !gs) return null;
  const r = liveRows(g, { p: x.p, sig: sigma, hca: x.hca, haH: x.haH || 0, haA: x.haA || 0, b2bH: x.b2bHome, b2bA: x.b2bAway }, miss);
  if (!r) return null;
  const it = { hv: r.hv, av: r.av, sig: sigma };
  const e = gridEval(gs.params, g.code, it);
  return { pHome: e.pHome, margin: e.margin, view: split1000(gs.params, g.code, it, gs.stats.sd) };
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

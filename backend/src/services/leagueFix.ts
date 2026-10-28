/**
 * fix255 / fix255b: leagues under 52% on 1X2 — test, then improve only where it is proven (pure rules and the reasons
 * for the design: utils/leagueFix.ts).
 *
 *  - The games: every settled game of the public record once (the main model's own numbers: predictions.layer_raw when
 *    this layer moved it, else p_pre when only fix254's recent calibration moved it, else the saved split), 240 days;
 *    plus the last 2 seasons + this one of the walk-forward grid-v3 backtest (backtest_predictions, latest run per season
 *    and group), only for games before the league's first record game.
 *  - Units: every group (pooled), then a league on its own when it has ≥ 150 record games in the 90 days.
 *  - Applied: the passing candidate (lowest log loss) of a group to every league of the group, a league's own to that
 *    league; stored in model_config 'league_fix_live' (fix251's config store), applied by leagueFixLive.applyLeagueFix
 *    on every model of a game but feat-v1 (before fix254's recent calibration layer). Nightly (04:40 UTC) the test runs
 *    again: a new pass is applied; a unit already live stays while its candidate is not worse on the first and last
 *    30 days and overall, otherwise it is rolled back (written in the report).
 *  - Report (admin card "Leagues under 52%", /api/admin/league-fix): every league with ≥ 20 games (stats, causes), the
 *    verdict of every candidate per group / league, before → after (hit rate, log loss, draw picks) per group and per
 *    league on out-of-sample numbers, leagues and games above 52%, the 90-day totals.
 *  - Data health "Leagues under 50%" (services/leagueFixHealth.ts).
 */
import { db } from '../db';
import logger from '../utils/logger';
import { GROUPS, groupForCompetition, seasonCodes } from './history';
import { setConfig } from './featureModel';
import { liveLayer, LIVE_KEY, type LiveLayer } from './leagueFixLive';
import { preloadSettled, mainSettledRows } from './tracking';
import { clearPredictionCache } from './predCache';
import { yieldLoop } from './perf';
import {
  LF_RULES, CANDS, CAND_LABEL, GROUP_NAMES, groupOf, crossSteps, liveSteps, runAsync, leagueStats, leaguesUnder, norm, argmax, ll,
  type Game, type LGroup, type Cand, type Variant, type P3, type CandResult, type LeagueSetting
} from '../utils/leagueFix';

const DAY = 86400000;
const RECORD_DAYS = 240;

db.exec(`CREATE TABLE IF NOT EXISTS league_fix_runs (date TEXT PRIMARY KEY, ran_at TEXT NOT NULL, report TEXT NOT NULL, under50 TEXT, ms INTEGER)`);

/* ---------- inputs ---------- */

function extraLeagues(): Map<string, { name: string; country: string }> {
  const m = new Map<string, { name: string; country: string }>();
  try { for (const r of db.prepare(`SELECT league_id, name, country FROM af_extra_leagues`).all() as any[]) m.set(`AF${r.league_id}`, { name: String(r.name || ''), country: String(r.country || '') }); } catch { /* table not there yet */ }
  return m;
}
/** the history division of a competition code (index-aligned in GROUPS), or null */
export function divisionOf(code: string): string | null {
  const g = groupForCompetition(code);
  if (!g) return null;
  const cfg = GROUPS[g];
  const i = cfg.competitions.indexOf(code);
  return i >= 0 && i < cfg.divisions.length ? cfg.divisions[i] : null;
}
/** the competition code of a history division (the inverse of divisionOf) */
export function codeOfDivision(div: string): string | null {
  for (const cfg of Object.values(GROUPS)) { const i = cfg.divisions.indexOf(div); if (i >= 0 && i < cfg.competitions.length) return cfg.competitions[i]; }
  return null;
}
const marketOf = (r: any): P3 | null =>
  r.odds_home && r.odds_draw && r.odds_away ? norm([1 / r.odds_home, 1 / r.odds_draw, 1 / r.odds_away]) : null;
const yOf = (o: string) => (o === 'H' ? 0 : o === 'D' ? 1 : 2);
const parse3 = (s: string | null): P3 | null => { try { const v = s ? JSON.parse(s) : null; return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? (v as P3) : null; } catch { return null; } };

export async function loadRecord(now: number): Promise<Game[]> {
  await preloadSettled(RECORD_DAYS);
  const main = mainSettledRows(RECORD_DAYS);
  // the model's own numbers: before this layer (layer_raw), else before fix254's recent calibration (p_pre)
  const own = new Map<string, P3>();
  for (const r of db.prepare(`SELECT match_id, model, layer_raw, p_pre FROM predictions WHERE (layer_raw IS NOT NULL OR p_pre IS NOT NULL) AND utc_date >= ?`).all(new Date(now - RECORD_DAYS * DAY).toISOString()) as any[]) {
    const v = parse3(r.layer_raw) || parse3(r.p_pre);
    if (v) own.set(`${r.match_id}|${r.model}`, v);
  }
  const ex = extraLeagues();
  const out: Game[] = [];
  for (const r of main) {
    const t = Date.parse(r.utc_date);
    if (!Number.isFinite(t) || t > now) continue;
    const code = r.competition_code || '?';
    const p = own.get(`${r.match_id}|${r.model}`) || [Number(r.p_home), Number(r.p_draw), Number(r.p_away)];
    if (!(p[0] + p[1] + p[2] > 0)) continue;
    out.push({ id: r.match_id, comp: code, name: r.competition_name || code, group: groupOf(code, r.competition_name, ex.get(code)?.country), t, p: norm(p), mkt: marketOf(r), y: yOf(r.outcome), src: 'record' });
  }
  return out;
}

/** the grid-v3 backtest (latest run per season and group) for games before each league's first record game */
async function loadBacktest(record: Game[]): Promise<Game[]> {
  const first = new Map<string, number>();
  const names = new Map<string, string>();
  for (const g of record) { if (!first.has(g.comp) || g.t < first.get(g.comp)!) first.set(g.comp, g.t); names.set(g.comp, g.name); }
  const ex = extraLeagues();
  const out: Game[] = [];
  let runs: any[] = [];
  try {
    const seasons = seasonCodes(3);
    runs = db.prepare(`SELECT MAX(id) AS id, season FROM backtest_runs WHERE model = 'grid-v3' AND finished_at IS NOT NULL AND season IN (${seasons.map(() => '?').join(',')}) GROUP BY season, grp`).all(...seasons) as any[];
  } catch { return out; } // no backtest tables yet
  const st = db.prepare(`SELECT division, date, outcome, p_home, p_draw, p_away, odds_home, odds_draw, odds_away FROM backtest_predictions WHERE run_id = ?`);
  let id = -1;
  for (const run of runs) {
    for (const r of st.all(run.id) as any[]) {
      const code = codeOfDivision(r.division) || r.division;
      const t = Date.parse(`${r.date}T15:00:00Z`);
      if (!Number.isFinite(t) || !['H', 'D', 'A'].includes(r.outcome)) continue;
      if (first.has(code) && t >= first.get(code)! - DAY) continue; // the record has it (or the days around its start)
      const p: P3 = [Number(r.p_home), Number(r.p_draw), Number(r.p_away)];
      if (!(p[0] + p[1] + p[2] > 0)) continue;
      const name = names.get(code) || ex.get(code)?.name || code;
      out.push({ id: id--, comp: code, name, group: groupOf(code, name, ex.get(code)?.country), t, p: norm(p), mkt: marketOf(r), y: yOf(r.outcome), src: 'backtest', season: String(run.season) });
    }
    await yieldLoop();
  }
  return out;
}

/* ---------- the run ---------- */

interface Totals { n: number; hit: number; logLoss: number; drawPicks: number; drawPickHit: number | null; leaguesAbove: number; gamesAbove: number }
type Verdict = Omit<CandResult, 'probs'>;
export interface UnitReport {
  key: string; name: string; n: number; nBacktest: number; verdicts: Verdict[]; best: { cand: Cand; variant: Variant } | null;
  applied: { cand: Cand; variant: Variant } | null; action: string; before: Totals; after: Totals
}
export interface FixReport {
  builtAt: string; from: string; to: string; blocks: string[]; rules: typeof LF_RULES; ms: number; note: string;
  totals: { before: Totals; after: Totals; under: number; underGames: number; movedAbove: number; movedAboveGames: number; record: number; backtest: number };
  groups: (UnitReport & { group: LGroup })[];
  leagues: (ReturnType<typeof leagueStats> & { own: UnitReport | null; applied: string | null; via: 'league' | 'group' | null; after: Totals })[];
  table: { comp: string; name: string; group: string; n: number; before: { hit: number; logLoss: number; drawPicks: number }; after: { hit: number; logLoss: number; drawPicks: number }; applied: string | null }[];
  rolledBack: { unit: string; name: string; cand: Cand; why: string }[];
  under50: { comp: string; name: string; n: number; hit: number; worst: number; best: number }[];
  live: Record<string, { cand: Cand; variant: Variant; since: string; P: LeagueSetting['P'] }>;
}
const r1 = (x: number) => Math.round(x * 10) / 10;
function totals(games: Game[], f: (g: Game) => P3): Totals {
  const n = games.length;
  let h = 0, l = 0, dp = 0, dph = 0;
  const by = new Map<string, { n: number; h: number }>();
  for (const g of games) {
    const p = f(g), a = argmax(p), hit = a === g.y;
    if (hit) h++;
    l += ll(p, g.y);
    if (a === 1) { dp++; if (hit) dph++; }
    const e = by.get(g.comp) || { n: 0, h: 0 };
    e.n++; if (hit) e.h++;
    by.set(g.comp, e);
  }
  const above = [...by.values()].filter(e => (100 * e.h) / e.n >= LF_RULES.under);
  return {
    n, hit: n ? r1((100 * h) / n) : 0, logLoss: n ? Math.round((1000 * l) / n) / 1000 : 0, drawPicks: dp, drawPickHit: dp ? r1((100 * dph) / dp) : null,
    leaguesAbove: above.length, gamesAbove: above.reduce((a, e) => a + e.n, 0)
  };
}
const strip = (x: CandResult): Verdict => { const { probs: _p, ...rest } = x; return rest; };

/** every candidate × variant on a unit, giving the thread back between them */
async function judgeUnitAsync(games: Game[], from: number, to: number) {
  const results: CandResult[] = [];
  const variants: Variant[] = games.some(g => g.src === 'backtest') ? ['record', 'extended'] : ['record'];
  for (const c of CANDS) for (const v of variants) { results.push(await runAsync(crossSteps(games, c, v, from, to), yieldLoop)); await yieldLoop(); }
  const best = results.filter(x => x.pass).sort((a, b) => a.dAll - b.dAll)[0] || null;
  return { results, best };
}
const label = (s: { cand: Cand; variant: Variant }) => `${CAND_LABEL[s.cand]}${s.variant === 'extended' ? ' (fitted with 2 past seasons)' : ''}`;

let running = false;
export const leagueFixRunning = () => running;

/** The nightly run (and the admin's "run now"): test, apply what passed, roll back what got worse, store the report. */
export async function runLeagueFix(now = Date.now(), apply = true): Promise<FixReport | { skipped: string }> {
  if (running) return { skipped: 'running' };
  running = true;
  const t0 = Date.now();
  try {
    const R = LF_RULES;
    const from = now - R.windowDays * DAY, to = now + 1;
    const record = await loadRecord(now);
    const backtest = await loadBacktest(record);
    const all = [...record, ...backtest];
    const win = record.filter(g => g.t >= from);
    const prev = liveLayer();
    const live: LiveLayer = { since: {}, groups: {}, leagues: {}, compGroup: {} };
    for (const g of all) live.compGroup[g.comp] = g.group;
    const rolledBack: FixReport['rolledBack'] = [];
    const after = new Map<number, P3>();

    /** decide one unit: a new pass, kept while not worse, or rolled back */
    const decide = async (key: string, name: string, games: Game[], was: LeagueSetting | undefined) => {
      const j = await judgeUnitAsync(games, from, to);
      let chosen: CandResult | null = j.best, action = j.best ? (was && was.cand === j.best.cand && was.variant === j.best.variant ? 'kept (passed again)' : was ? `changed to ${label(j.best)}` : `applied: ${label(j.best)}`) : 'nothing passed';
      if (!j.best && was) {
        const r = j.results.find(x => x.cand === was.cand && x.variant === was.variant);
        if (r && r.dAll <= 0 && r.blocks[0].diff <= 0 && r.blocks[2].diff <= 0) { chosen = r; action = `kept (live since ${prev.since[key] || '—'}, not worse: ${r.dAll.toFixed(4)})`; }
        else { action = `rolled back (${r?.why || 'worse'})`; rolledBack.push({ unit: key, name, cand: was.cand, why: r ? `${r.dAll.toFixed(4)} over 90 days, ${r.blocks[0].diff.toFixed(4)} / ${r.blocks[2].diff.toFixed(4)} on the first / last 30 days` : 'no result' }); }
      }
      let setting: LeagueSetting | null = null;
      if (chosen) {
        setting = { cand: chosen.cand, variant: chosen.variant, P: roundP(await runAsync(liveSteps(games, chosen.cand, chosen.variant), yieldLoop)) };
        live.since[key] = was && was.cand === setting.cand && was.variant === setting.variant ? prev.since[key] || iso(now) : iso(now);
      }
      await yieldLoop();
      return { j, chosen, action, setting };
    };

    // 1. groups (pooled: every league of the group, record + backtest)
    const groups: FixReport['groups'] = [];
    const groupChosen = new Map<LGroup, CandResult | null>();
    for (const g of Object.keys(GROUP_NAMES) as LGroup[]) {
      const games = all.filter(x => x.group === g), gw = win.filter(x => x.group === g);
      if (!gw.length) continue;
      const d = await decide(`g:${g}`, GROUP_NAMES[g], games, prev.groups[g]);
      if (d.setting) live.groups[g] = d.setting;
      groupChosen.set(g, d.chosen);
      groups.push({
        group: g, key: `g:${g}`, name: GROUP_NAMES[g], n: gw.length, nBacktest: games.filter(x => x.src === 'backtest').length,
        verdicts: d.j.results.map(strip), best: d.j.best ? { cand: d.j.best.cand, variant: d.j.best.variant } : null,
        applied: d.chosen ? { cand: d.chosen.cand, variant: d.chosen.variant } : null, action: d.action,
        before: totals(gw, x => x.p), after: totals(gw, x => d.chosen?.probs?.get(x.id) || x.p)
      });
    }
    // 2. leagues with ≥ 150 games in the window: their own test, as a refinement of the group's
    const byComp = new Map<string, Game[]>();
    for (const g of win) { if (!byComp.has(g.comp)) byComp.set(g.comp, []); byComp.get(g.comp)!.push(g); }
    const leagues: FixReport['leagues'] = [];
    for (const [comp, list] of byComp) {
      let own: UnitReport | null = null, chosen: CandResult | null = null;
      if (list.length >= R.minLeague) {
        const games = all.filter(x => x.comp === comp);
        const d = await decide(`l:${comp}`, list[0].name, games, prev.leagues[comp]);
        if (d.setting) live.leagues[comp] = d.setting;
        chosen = d.chosen;
        own = {
          key: `l:${comp}`, name: list[0].name, n: list.length, nBacktest: games.filter(x => x.src === 'backtest').length, verdicts: d.j.results.map(strip),
          best: d.j.best ? { cand: d.j.best.cand, variant: d.j.best.variant } : null, applied: d.chosen ? { cand: d.chosen.cand, variant: d.chosen.variant } : null,
          action: d.action, before: totals(list, x => x.p), after: totals(list, x => d.chosen?.probs?.get(x.id) || x.p)
        };
      }
      const via: 'league' | 'group' | null = chosen ? 'league' : groupChosen.get(list[0].group) ? 'group' : null;
      const src = chosen || groupChosen.get(list[0].group) || null;
      for (const g of list) { const q = src?.probs?.get(g.id); if (q) after.set(g.id, q); }
      leagues.push({ ...leagueStats(list, R), own, applied: src ? label(src) : null, via, after: totals(list, x => after.get(x.id) || x.p) });
    }
    leagues.sort((a, b) => a.hit - b.hit);
    const before = totals(win, x => x.p), aft = totals(win, x => after.get(x.id) || x.p);
    const under = leagues.filter(l => l.n >= R.minReport && l.hit < R.under);
    const table = under.map(l => ({
      comp: l.comp, name: l.name, group: GROUP_NAMES[l.group], n: l.n,
      before: { hit: l.hit, logLoss: l.logLoss, drawPicks: l.picks[1] }, after: { hit: l.after.hit, logLoss: l.after.logLoss, drawPicks: l.after.drawPicks },
      applied: l.applied ? `${l.applied} (${l.via})` : null
    }));
    const moved = table.filter(t => t.after.hit >= R.under);
    const report: FixReport = {
      builtAt: new Date(now).toISOString(), from: iso(from), to: iso(now), blocks: [0, 1, 2].map(k => iso(from + k * R.blockDays * DAY)), rules: R, ms: 0,
      note: 'Each 30-day block is predicted with settings fitted on the other 60 days (and, for "fitted with 2 past seasons", the grid-v3 backtest), so every "after" number is out of sample. The pick is always the most likely result of the shown numbers: a layer that raises the draw makes draw picks.',
      totals: { before, after: aft, under: under.length, underGames: under.reduce((a, l) => a + l.n, 0), movedAbove: moved.length, movedAboveGames: moved.reduce((a, t) => a + t.n, 0), record: win.length, backtest: backtest.length },
      groups, leagues, table, rolledBack,
      under50: leaguesUnder(record.filter(r => r.t >= now - (R.windowDays + R.warnDays) * DAY), now, R),
      live: Object.fromEntries([
        ...Object.entries(live.groups).map(([g, s]) => [`g:${g}`, { cand: s.cand, variant: s.variant, since: live.since[`g:${g}`], P: s.P }]),
        ...Object.entries(live.leagues).map(([c, s]) => [`l:${c}`, { cand: s.cand, variant: s.variant, since: live.since[`l:${c}`], P: s.P }])
      ])
    };
    report.ms = Date.now() - t0;
    db.prepare(`INSERT OR REPLACE INTO league_fix_runs (date, ran_at, report, under50, ms) VALUES (?, ?, ?, ?, ?)`)
      .run(iso(now), new Date().toISOString(), JSON.stringify(report), JSON.stringify(report.under50), report.ms);
    db.prepare(`DELETE FROM league_fix_runs WHERE date < ?`).run(iso(now - 120 * DAY));
    if (apply) {
      const changed = JSON.stringify([live.groups, live.leagues]) !== JSON.stringify([prev.groups, prev.leagues]);
      setConfig(LIVE_KEY, JSON.stringify(live));
      if (changed) clearPredictionCache();
      logger.info(`league fix: ${Object.keys(live.groups).length} group(s) + ${Object.keys(live.leagues).length} league(s) adjusted, ${rolledBack.length} rolled back · 90 days ${before.hit}% / ${before.logLoss} → ${aft.hit}% / ${aft.logLoss}`);
    }
    return report;
  } finally { running = false; }
}
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const roundP = (P: LeagueSetting['P']): LeagueSetting['P'] => ({ ...P, dr: Math.round(P.dr * 10000) / 10000, base: P.base.map(x => Math.round(x * 10000) / 10000) as P3 });

/** the last stored report (admin card), or null */
export function lastLeagueFix(): FixReport | null {
  try { const r: any = db.prepare(`SELECT report FROM league_fix_runs ORDER BY date DESC LIMIT 1`).get(); return r ? JSON.parse(r.report) : null; } catch { return null; }
}

/** worker: once ~25 min after start (when today has no run), then every day at 04:40 UTC */
export function leagueFixDue(now = Date.now()): boolean {
  const d = new Date(now);
  const r: any = db.prepare(`SELECT ran_at FROM league_fix_runs WHERE date = ?`).get(iso(now));
  if (r) return false;
  return d.getUTCHours() * 60 + d.getUTCMinutes() >= 4 * 60 + 40 || !db.prepare(`SELECT 1 FROM league_fix_runs LIMIT 1`).get();
}

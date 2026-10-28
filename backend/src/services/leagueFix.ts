/**
 * fix255: leagues under 52% on 1X2 — test, then improve only where it is proven (pure rules: utils/leagueFix.ts).
 *
 *  - The games: the public record (/api/accuracy's rows: one main prediction per settled game, saved before kick-off),
 *    90 days scored, up to 150 days before them feeding the fits. A row the layer already moved is read back from its
 *    saved original numbers (predictions.layer_raw), so the test always starts from what the model said.
 *  - History base rates: history_matches of the last 2 seasons + this one (seasonCodes(3)), days before the game only.
 *  - Report (admin, Predictions & models → "Leagues under 52%"): every league with ≥ 20 games — games, hit rate, log loss,
 *    market log loss, H / D / A vs our picks, home bias, draw gap, the causes; each candidate's verdict per league and
 *    per group; the table before → after for the leagues under 52%; the 90-day totals before → after.
 *  - Applied: only a candidate that passed (league, or the group's for a league with < 60 games). Stored in model_config
 *    'league_fix_live' (the fix251 config store) and applied to every model of the game when its prediction is built
 *    (applyLeagueFix). The nightly run (04:40 UTC, after the 04:00 champion / challenger job) re-tests everything on the
 *    new window: a new pass is added, a league already applied stays while it is not worse on the window and the last
 *    45 days, otherwise it is rolled back (written in the run's report).
 *  - Data health "Leagues under 50%": a league with ≥ 60 games under 50% on each of the last 30 days (90-day windows).
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
  LF_RULES, CANDS, CAND_LABEL, GROUP_NAMES, groupOf, walkForward, judgeCand, judgePick, leagueStats, leaguesUnder, makeHist, norm, argmax, ll,
  type Row, type Hist, type WRow, type LGroup, type Cand, type P3, type CandResult
} from '../utils/leagueFix';

const DAY = 86400000;
const PRIOR_DAYS = 150;

db.exec(`CREATE TABLE IF NOT EXISTS league_fix_runs (date TEXT PRIMARY KEY, ran_at TEXT NOT NULL, report TEXT NOT NULL, under50 TEXT, ms INTEGER)`);

/* ---------- inputs ---------- */

function countries(): Map<string, string> {
  const m = new Map<string, string>();
  try { for (const r of db.prepare(`SELECT league_id, country FROM af_extra_leagues`).all() as any[]) m.set(`AF${r.league_id}`, String(r.country || '')); } catch { /* table not there yet */ }
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
function historyFor(codes: string[]): Map<string, Hist> {
  const seasons = seasonCodes(3);
  const st = db.prepare(`SELECT date, hg, ag FROM history_matches WHERE division = ? AND season IN (${seasons.map(() => '?').join(',')})`);
  const out = new Map<string, Hist>();
  for (const code of codes) {
    const div = divisionOf(code);
    if (!div) continue;
    const games = (st.all(div, ...seasons) as any[]).map(r => ({
      // a history day counts from the end of that day (a same-day game never sees its own result)
      t: Date.parse(`${r.date}T00:00:00Z`) + DAY, y: r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2
    })).filter(g => Number.isFinite(g.t));
    if (games.length) out.set(code, makeHist(games));
  }
  return out;
}
const marketOf = (r: any): P3 | null =>
  r.odds_home && r.odds_draw && r.odds_away ? norm([1 / r.odds_home, 1 / r.odds_draw, 1 / r.odds_away]) : null;

async function loadRows(now: number): Promise<Row[]> {
  const days = LF_RULES.windowDays + PRIOR_DAYS;
  await preloadSettled(days);
  const main = mainSettledRows(days);
  const raw = new Map<string, P3>();
  for (const r of db.prepare(`SELECT match_id, model, layer_raw FROM predictions WHERE layer_raw IS NOT NULL AND utc_date >= ?`).all(new Date(now - days * DAY).toISOString()) as any[]) {
    try { const v = JSON.parse(r.layer_raw); if (Array.isArray(v) && v.length === 3) raw.set(`${r.match_id}|${r.model}`, v as P3); } catch { /* skip */ }
  }
  const cty = countries();
  const out: Row[] = [];
  for (const r of main) {
    const t = Date.parse(r.utc_date);
    if (!Number.isFinite(t) || t > now) continue;
    const code = r.competition_code || '?';
    const p = raw.get(`${r.match_id}|${r.model}`) || [Number(r.p_home), Number(r.p_draw), Number(r.p_away)];
    if (!(p[0] + p[1] + p[2] > 0)) continue;
    out.push({
      id: r.match_id, comp: code, name: r.competition_name || code, group: groupOf(code, r.competition_name, cty.get(code)),
      t, p: norm(p), mkt: marketOf(r), y: r.outcome === 'H' ? 0 : r.outcome === 'D' ? 1 : 2
    });
  }
  return out;
}

/* ---------- the run ---------- */

export interface FixReport {
  builtAt: string; from: string; mid: string; to: string; rules: typeof LF_RULES; ms: number;
  totals: { before: Totals; after: Totals; movedAbove: number; gamesAbove: number; under: number; underGames: number };
  note: string;
  leagues: (ReturnType<typeof leagueStats> & { own: boolean; verdicts: CandResult[]; pickRules: CandResult[]; best: Cand | null; applied: Cand | null; appliedVia: 'league' | 'group' | null; action: string; after: { hit: number; logLoss: number } })[];
  groups: { group: LGroup; name: string; n: number; verdicts: CandResult[]; pickRules: CandResult[]; best: Cand | null }[];
  table: { comp: string; name: string; n: number; before: { hit: number; logLoss: number }; after: { hit: number; logLoss: number }; applied: string | null; why: string }[];
  rolledBack: { comp: string; name: string; cand: Cand; why: string }[];
  under50: { comp: string; name: string; n: number; hit: number; worst: number; best: number }[];
  live: Record<string, { cand: Cand; unit: 'league' | 'group'; since: string; h: number; d: number }>;
}
interface Totals { n: number; hit: number; logLoss: number }
const tot = (rows: WRow[], f: (w: WRow) => P3): Totals => {
  const n = rows.length;
  if (!n) return { n: 0, hit: 0, logLoss: 0 };
  let h = 0, l = 0;
  for (const w of rows) { const p = f(w); if (argmax(p) === w.y) h++; l += ll(p, w.y); }
  return { n, hit: Math.round((1000 * h) / n) / 10, logLoss: Math.round((1000 * l) / n) / 1000 };
};

/** every candidate and pick rule on a unit (utils judgeUnit), giving the thread back between them */
async function judgeUnitAsync(rows: WRow[], mid: number) {
  const results: CandResult[] = [];
  for (const c of CANDS) { results.push(judgeCand(rows, c, mid)); await yieldLoop(); }
  const picks = [judgePick(rows, 'pick-draw', mid), judgePick(rows, 'pick-dc', mid)];
  await yieldLoop();
  const best = results.filter(x => x.pass).sort((a, b) => a.dAll - b.dAll)[0] || null;
  return { results, picks, best: best ? (best.cand as Cand) : null };
}

let running = false;
export const leagueFixRunning = () => running;

/** The nightly run (and the admin's "run now"): test, apply what passed, roll back what got worse, store the report. */
export async function runLeagueFix(now = Date.now(), apply = true): Promise<FixReport | { skipped: string }> {
  if (running) return { skipped: 'running' };
  running = true;
  const t0 = Date.now();
  try {
    const R = LF_RULES;
    const from = now - R.windowDays * DAY, mid = now - R.halfDays * DAY;
    const rows = await loadRows(now);
    const inWin = rows.filter(r => r.t >= from);
    const counts = new Map<string, number>();
    for (const r of inWin) counts.set(r.comp, (counts.get(r.comp) || 0) + 1);
    const own = new Set([...counts].filter(([, n]) => n >= R.minOwn).map(([c]) => c));
    const hist = historyFor([...counts.keys()]);
    await yieldLoop();
    // one extra row per league "now": its settings are the ones applied live from today (never scored)
    const synth: Row[] = [...counts.keys()].map((comp, i) => {
      const any = inWin.find(r => r.comp === comp)!;
      return { id: -1 - i, comp, name: any.name, group: any.group, t: now + R.settleMs, p: [1 / 3, 1 / 3, 1 / 3], mkt: null, y: 0 };
    });
    const all = walkForward([...rows, ...synth], hist, own, from, Infinity, R);
    const win = all.filter(w => w.id >= 0), nowRows = new Map(all.filter(w => w.id < 0).map(w => [w.comp, w]));
    await yieldLoop();

    // groups (every game of the group) and leagues with their own settings
    const groups: FixReport['groups'] = [];
    const groupBest = new Map<LGroup, Cand | null>();
    const groupRes = new Map<LGroup, Awaited<ReturnType<typeof judgeUnitAsync>>>();
    for (const g of Object.keys(GROUP_NAMES) as LGroup[]) {
      const gr = win.filter(w => w.group === g);
      if (!gr.length) continue;
      const j = await judgeUnitAsync(gr, mid);
      groupRes.set(g, j);
      groupBest.set(g, gr.length >= R.minOwn ? j.best : null);
      groups.push({ group: g, name: GROUP_NAMES[g], n: gr.length, verdicts: j.results, pickRules: j.picks, best: gr.length >= R.minOwn ? j.best : null });
      await yieldLoop();
    }
    const prev = liveLayer();
    const live: LiveLayer = { since: {}, settings: {} };
    const leagues: FixReport['leagues'] = [];
    const rolledBack: FixReport['rolledBack'] = [];
    const afterProbs = new Map<number, P3>();
    const byComp = new Map<string, WRow[]>();
    for (const w of win) { if (!byComp.has(w.comp)) byComp.set(w.comp, []); byComp.get(w.comp)!.push(w); }
    for (const [comp, list] of byComp) {
      const isOwn = own.has(comp);
      const j = isOwn ? await judgeUnitAsync(list, mid) : null;
      const via: 'league' | 'group' = isOwn ? 'league' : 'group';
      const best = isOwn ? j!.best : groupBest.get(list[0].group) ?? null;
      const was = prev.settings[comp];
      let applied: Cand | null = best, action = best ? (was?.cand === best ? 'kept (passed again)' : was ? `changed ${was.cand} → ${best}` : 'applied (passed)') : 'nothing passed';
      if (!best && was) {
        // already live: kept while it is not worse on the window and on the last 45 days, else rolled back
        const r = (isOwn ? j!.results : groupRes.get(list[0].group)?.results || []).find(x => x.cand === was.cand);
        const mine = list.map(w => ll(w.probs[was.cand], w.y) - ll(w.probs.base, w.y));
        const late = list.map((w, i) => (w.t >= mid ? mine[i] : NaN)).filter(x => !Number.isNaN(x));
        const m = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
        if (m(mine) <= 0 && m(late) <= 0) { applied = was.cand; action = `kept (live since ${prev.since[comp] || '—'}, not worse: ${m(mine).toFixed(4)} / last 45 days ${m(late).toFixed(4)})`; }
        else { applied = null; action = `rolled back (${r?.why || 'worse'})`; rolledBack.push({ comp, name: list[0].name, cand: was.cand, why: `worse than the saved numbers: ${m(mine).toFixed(4)} over 90 days, ${m(late).toFixed(4)} in the last 45` }); }
      }
      if (applied) {
        const n0 = nowRows.get(comp);
        if (n0) {
          live.settings[comp] = { cand: applied, h: round(n0.h), d: round(n0.d), base: n0.base.map(round) as P3, close: n0.closeYS, anchor: applied === 'calib+anchor' ? n0.aCalib : n0.a, unit: via, name: list[0].name };
          live.since[comp] = was?.cand === applied ? prev.since[comp] || iso(now) : iso(now);
        }
        for (const w of list) afterProbs.set(w.id, w.probs[applied]);
      }
      const st = leagueStats(list, R);
      const aft = tot(list, w => afterProbs.get(w.id) || w.probs.base);
      leagues.push({ ...st, own: isOwn, verdicts: j?.results || [], pickRules: j?.picks || [], best, applied, appliedVia: applied ? via : null, action, after: { hit: aft.hit, logLoss: aft.logLoss } });
      await yieldLoop();
    }
    leagues.sort((a, b) => a.hit - b.hit);
    const before = tot(win, w => w.probs.base), after = tot(win, w => afterProbs.get(w.id) || w.probs.base);
    const under = leagues.filter(l => l.n >= R.minReport && l.hit < R.under);
    const table = under.map(l => ({
      comp: l.comp, name: l.name, n: l.n, before: { hit: l.hit, logLoss: l.logLoss }, after: l.after,
      applied: l.applied ? `${CAND_LABEL[l.applied]} (${l.appliedVia})` : null, why: l.applied ? l.action : whyNot(l, groups)
    }));
    const report: FixReport = {
      builtAt: new Date(now).toISOString(), from: iso(from), mid: iso(mid), to: iso(now), rules: R, ms: Date.now() - t0,
      totals: {
        before, after, movedAbove: table.filter(t => t.after.hit >= R.under).length, gamesAbove: table.filter(t => t.after.hit >= R.under).reduce((a, t) => a + t.n, 0),
        under: table.length, underGames: table.reduce((a, t) => a + t.n, 0)
      },
      note: 'Pick rules (draw rule, double-chance side) change only which result is named, not the percentages: they are tested and shown here, never applied by this job (the site names the most likely result everywhere).',
      leagues, groups, table, rolledBack,
      under50: leaguesUnder(rows.filter(r => r.t >= now - (R.windowDays + R.warnDays) * DAY), now, R),
      live: Object.fromEntries(Object.entries(live.settings).map(([c, s]) => [c, { cand: s.cand, unit: s.unit, since: live.since[c], h: s.h, d: s.d }]))
    };
    report.ms = Date.now() - t0;
    db.prepare(`INSERT OR REPLACE INTO league_fix_runs (date, ran_at, report, under50, ms) VALUES (?, ?, ?, ?, ?)`)
      .run(iso(now), new Date().toISOString(), JSON.stringify(report), JSON.stringify(report.under50), report.ms);
    db.prepare(`DELETE FROM league_fix_runs WHERE date < ?`).run(iso(now - 120 * DAY));
    if (apply) {
      const changed = JSON.stringify(live.settings) !== JSON.stringify(prev.settings);
      setConfig(LIVE_KEY, JSON.stringify(live));
      if (changed) clearPredictionCache();
      logger.info(`league fix: ${Object.keys(live.settings).length} league(s) adjusted, ${rolledBack.length} rolled back · 90 days ${before.hit}% / ${before.logLoss} → ${after.hit}% / ${after.logLoss}`);
    }
    return report;
  } finally { running = false; }
}
const round = (x: number) => Math.round(x * 10000) / 10000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
function whyNot(l: FixReport['leagues'][number], groups: FixReport['groups']): string {
  if (!l.own) {
    const g = groups.find(x => x.group === l.group);
    return `< ${LF_RULES.minOwn} games: group ${GROUP_NAMES[l.group]} — ${g?.best ? 'passed' : `nothing passed (closest: ${closest(g?.verdicts || [])})`}`;
  }
  return `nothing passed (closest: ${closest(l.verdicts)})`;
}
function closest(v: CandResult[]): string {
  const c = v.slice().sort((a, b) => a.dAll - b.dAll)[0];
  return c ? `${CAND_LABEL[c.cand as Cand] || c.cand}: ${c.why}` : '—';
}

/** the last stored report (admin card), or null */
export function lastLeagueFix(): FixReport | null {
  try { const r: any = db.prepare(`SELECT report FROM league_fix_runs ORDER BY date DESC LIMIT 1`).get(); return r ? JSON.parse(r.report) : null; } catch { return null; }
}
export { CANDS };

/** worker: once ~25 min after start (when today has no run), then every day at 04:40 UTC */
export function leagueFixDue(now = Date.now()): boolean {
  const d = new Date(now);
  const r: any = db.prepare(`SELECT ran_at FROM league_fix_runs WHERE date = ?`).get(iso(now));
  if (r) return false;
  return d.getUTCHours() * 60 + d.getUTCMinutes() >= 4 * 60 + 40 || !db.prepare(`SELECT 1 FROM league_fix_runs LIMIT 1`).get();
}

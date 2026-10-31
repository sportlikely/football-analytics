/**
 * fix291: the football model lab — the nightly test of six ways to make the double-chance pick surer (maths and the
 * rules: utils/footballLab.ts; live layer: services/footballLabLive.ts; notes: docs/notes/model-lab.md).
 *
 * The games:
 *  - seasons: the grid-v3 walk-forward replay (v3Tuner.v3WindowRun, live setting, with the v3 rows) of the last four
 *    seasons, closing prices from football-data.co.uk; the champion = what the site shows: v3-mix (when it is live) with
 *    a feature-model fit trained before the game's season (walk-forward), the live mix weights and market anchor;
 *  - the public record's last 60 days (every league, the saved main prediction before this layer: predictions.lab_raw
 *    when the layer moved it), prices: the closing 1X2 line (market_lines) when stored, else the saved odds;
 *  - lab features per game from the feature model's fixtures (goals / xG / shots on target form, draw habits, the
 *    league's draw rate, XI and missing players), walk-forward in kick-off order.
 * Windows: 2024-25, 2025-26 (the last full season) and this season so far — each fitted on every earlier game only —
 * plus the record's 60 days (fitted on everything before them). Judged on the last two seasons by fix251's rule.
 * Promotion writes model_config 'football_lab_live' (at most once in 7 days); a live layer that is worse than no layer by
 * > 0.005 over ≥ 100 record games since it went live is rolled back. Worker job "football lab", 05:10 UTC.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { GROUPS, seasonCodes } from './history';
import { v3WindowRun, isTuning } from './v3Tuner';
import { yieldLoop } from './perf';
import {
  buildFeaturesAsync, fitFeatureModel, predictWith, fixtureByNames, afFixtureFor, getConfig, setConfig, mixLive, mixWeightFor, marketAnchor,
  type FeatState, type FittedModel
} from './featureModel';
import { preloadSettled, mainSettledRows } from './tracking';
import { codeOfDivision } from './leagueFix';
import { clearPredictionCache } from './predCache';
import { LAB_KEY, labLive, rowsOfGrid, type LabLive } from './footballLabLive';
import { groupOfDiv, mixP, anchorP, promotionWait, DAILY_RULES } from '../utils/dailyRules';
import {
  LAB_RULES, CAND_LABEL, labSteps, runAsync, seasonWindows, labFeatures, labLearn, newLabState, norm, ll,
  type LabGame, type LabReport, type P3, type Window, type CandId
} from '../utils/footballLab';

const DAY = 86400000;
const RECORD_DAYS = 60;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

db.exec(`CREATE TABLE IF NOT EXISTS football_lab_runs (date TEXT PRIMARY KEY, ran_at TEXT NOT NULL, report TEXT NOT NULL, decision TEXT, ms INTEGER)`);

/* ---------- inputs ---------- */

const seasonOf = (date: string) => { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); const s = m >= 7 ? y : y - 1; return `${String(s).slice(2)}${String(s + 1).slice(2)}`; };
const p3 = (v: unknown): P3 | null => (Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(Number(x))) && Number(v[0]) + Number(v[1]) + Number(v[2]) > 0 ? norm(v.map(Number)) : null);
const parse = (s: string | null): any => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** lab features of every fixture of the feature state (before its kick-off), by fixture id */
async function labFeatureMap(st: FeatState): Promise<Map<number, Float64Array>> {
  const rows = new Map(st.rows.map(r => [r.fid, r]));
  const list = [...st.fixtures.values()].sort((a, b) => (a.kickoff < b.kickoff ? -1 : a.kickoff > b.kickoff ? 1 : a.fid - b.fid));
  const s = newLabState(), out = new Map<number, Float64Array>();
  let i = 0;
  for (const f of list) {
    const m = { div: f.div, home: `${f.grp}|${f.home}`, away: `${f.grp}|${f.away}`, hg: f.hg, ag: f.ag, xh: f.xh, xa: f.xa, sh: f.sh, sa: f.sa };
    out.set(f.fid, labFeatures(s, m, rows.get(f.fid)?.x || null));
    labLearn(s, m);
    if (++i % 2000 === 0) await yieldLoop();
  }
  return out;
}

/** a feature-model fit per season start (walk-forward champion); null when there are too few earlier games */
async function seasonFits(st: FeatState, seasons: string[]): Promise<Map<string, FittedModel | null>> {
  const out = new Map<string, FittedModel | null>();
  if (!mixLive()) return out; // the site shows grid-v3: the champion has no feature part
  for (const s of seasons) { out.set(s, (await fitFeatureModel(st, `20${s.slice(0, 2)}-07-01`))?.model || null); await yieldLoop(); }
  return out;
}

interface Loaded { games: LabGame[]; seasons: string[]; rowNames: string[]; nRows: number; notes: string[] }
async function loadGames(now: number): Promise<Loaded> {
  const notes: string[] = [];
  const seasons = seasonCodes(4);
  const st = await buildFeaturesAsync();
  const fmap = await labFeatureMap(st);
  const rowsByFid = new Map(st.rows.map(r => [r.fid, r]));
  const fits = await seasonFits(st, seasons);
  const anchor = marketAnchor();
  const firstSeason = [...seasons].sort()[0];
  const run = await v3WindowRun({ seasons, scoreFrom: `20${firstSeason.slice(0, 2)}-07-01`, fits: [], rows: true });
  const rowNames = run.rowNames || [];
  const divGroup = new Map<string, string>();
  for (const [g, cfg] of Object.entries(GROUPS)) for (const d of cfg.divisions) divGroup.set(d, g);
  const games: LabGame[] = [];
  let joined = 0;
  for (let i = 0; i < run.items.length; i++) {
    if (i % 500 === 499) await yieldLoop();
    const it = run.items[i], v3 = run.live[i];
    const grp = divGroup.get(it.div);
    if (!grp || !v3) continue;
    const t = Date.parse(`${it.date}T15:00:00Z`);
    if (!Number.isFinite(t) || t > now) continue;
    const fx = fixtureByNames(st, grp, it.home, it.away, it.date);
    const row = fx ? rowsByFid.get(fx.fid) : null;
    const season = seasonOf(it.date), code = codeOfDivision(it.div) || it.div, group = groupOfDiv(it.div, code);
    const fit = fits.get(season) || null;
    let p: P3 = norm(v3);
    if (fit && row?.ok) p = mixP(mixWeightFor(group), p, predictWith(fit, row.x));
    p = anchorP(p, it.mkt as P3 | null, anchor);
    if (fx) joined++;
    games.push({
      id: `s:${it.div}:${it.date}:${it.home}:${it.away}`, t, season, src: 'season', div: code, league: code, group,
      home: `${grp}|${it.home}`, away: `${grp}|${it.away}`, y: it.o === 'H' ? 0 : it.o === 'D' ? 1 : 2, p, mkt: (it.mkt as P3 | null) || null,
      f: fx ? fmap.get(fx.fid) || null : null, rows: run.rows?.[i] ? Float64Array.from(run.rows[i]) : null
    });
  }
  notes.push(`${games.length} replayed league games (${seasons.slice().sort().join(', ')}), ${joined} joined to the feature model's fixtures (xG / shots / line-ups); champion = ${mixLive() ? 'v3-mix (feature fit before each season)' : 'grid-v3 (v3-mix is not live)'}${anchor ? `, market anchor ${anchor}` : ''}`);
  const rec = await loadRecord(now, st, fmap);
  notes.push(`${rec.length} public-record games in the last ${RECORD_DAYS} days (${rec.filter(g => g.mkt).length} with a price, ${rec.filter(g => g.f).length} with lab features)`);
  return { games: [...games, ...rec], seasons, rowNames, nRows: rowNames.length, notes };
}

/** the public record's last 60 days: the main prediction before the lab layer, the closing 1X2 when stored */
async function loadRecord(now: number, st: FeatState, fmap: Map<number, Float64Array>): Promise<LabGame[]> {
  await preloadSettled(RECORD_DAYS);
  const main = mainSettledRows(RECORD_DAYS);
  const since = new Date(now - RECORD_DAYS * DAY).toISOString();
  const extra = new Map<string, { raw: P3 | null; rows: Float64Array | null }>();
  // read 3 days at a time with a pause between (the payloads are big: one read of 60 days held the worker)
  const st3 = db.prepare(`SELECT match_id, model, lab_raw, json_extract(payload, '$.grid.rows') AS rows FROM predictions
    WHERE settled = 1 AND utc_date >= ? AND utc_date < ? AND model IN ('grid-v3', 'v3-mix', 'elo-intl', 'elo-euro', 'dc-history-v2', 'poisson-dc-v1')`);
  for (let from = now - RECORD_DAYS * DAY; from < now + DAY; from += 3 * DAY) {
    for (const r of st3.all(new Date(from).toISOString(), new Date(from + 3 * DAY).toISOString()) as any[]) {
      const rows = parse(r.rows);
      extra.set(`${r.match_id}|${r.model}`, { raw: p3(parse(r.lab_raw)), rows: Array.isArray(rows) ? rowsOfGrid({ rows }) : null });
    }
    await yieldLoop();
  }
  const closing = new Map<number, P3>();
  try {
    for (const r of db.prepare(`SELECT game_id, closing, prices FROM market_lines WHERE sport = 'football' AND market = 'ml' AND kickoff >= ? ORDER BY closing`).all(since) as any[]) {
      const p = parse(r.prices)?.p || {};
      const v = p3([p.Home ?? p.home ?? p['1'], p.Draw ?? p.draw ?? p.X, p.Away ?? p.away ?? p['2']]);
      if (v) closing.set(Number(r.game_id), v);
    }
  } catch { /* no market lines yet */ }
  const out: LabGame[] = [];
  let i = 0;
  for (const r of main) {
    if (++i % 500 === 0) await yieldLoop();
    const t = Date.parse(r.utc_date);
    if (!Number.isFinite(t) || t > now || !['H', 'D', 'A'].includes(r.outcome)) continue;
    const ex = extra.get(`${r.match_id}|${r.model}`);
    const p = ex?.raw || p3([r.p_home, r.p_draw, r.p_away]);
    if (!p) continue;
    const code = r.competition_code || '?';
    const odds = r.odds_home && r.odds_draw && r.odds_away ? norm([1 / r.odds_home, 1 / r.odds_draw, 1 / r.odds_away]) : null;
    let f: Float64Array | null = null;
    try {
      const fx = afFixtureFor({ id: r.match_id, competition: { code }, homeTeam: { id: r.home_team_id }, awayTeam: { id: r.away_team_id }, utcDate: r.utc_date }, st);
      if (fx) f = fmap.get(fx.fid) || null;
    } catch { f = null; }
    out.push({
      id: `r:${r.match_id}`, t, season: seasonOf(r.utc_date), src: 'record', div: code, league: r.competition_name || code, group: groupOfDiv(null, code),
      home: String(r.home_team_id ?? r.home_team), away: String(r.away_team_id ?? r.away_team), y: r.outcome === 'H' ? 0 : r.outcome === 'D' ? 1 : 2,
      p, mkt: closing.get(r.match_id) || odds, f, rows: ex?.rows || null
    });
  }
  return out;
}
/* ---------- the live layer's guard ---------- */

/** record games since the layer went live: log loss with the layer (saved) vs without (lab_raw) */
function guardOf(L: LabLive): { n: number; diff: number } {
  let n = 0, d = 0;
  try {
    for (const r of db.prepare(`SELECT p.p_home, p.p_draw, p.p_away, p.lab_raw, p.layer_raw, p.p_pre, r.outcome FROM predictions p JOIN results r ON r.match_id = p.match_id
      WHERE p.settled = 1 AND p.lab_raw IS NOT NULL AND p.utc_date >= ? AND r.outcome IN ('H','D','A') AND p.model IN ('grid-v3', 'v3-mix')`).all(`${L.since}T00:00:00Z`) as any[]) {
      const raw = p3(parse(r.lab_raw));
      const shown = p3(parse(r.layer_raw)) || p3(parse(r.p_pre)) || p3([r.p_home, r.p_draw, r.p_away]);
      if (!raw || !shown) continue;
      const y = r.outcome === 'H' ? 0 : r.outcome === 'D' ? 1 : 2;
      d += ll(shown, y) - ll(raw, y); n++;
    }
  } catch { /* column not there yet */ }
  return { n, diff: n ? Math.round((d / n) * 1e5) / 1e5 : 0 };
}

/* ---------- the run ---------- */

export interface LabRun extends LabReport {
  builtAt: string; ms: number; notes: string[]; rules: typeof LAB_RULES;
  decision: 'promote' | 'refit' | 'keep' | 'rollback' | 'none' | 'held';
  decisionWhy: string; liveNow: { cand: CandId; label: string; since: string; why: string; guard: { n: number; diff: number } } | null;
  names: { before: string; after: string | null };
}

let running = false;
export const footballLabRunning = () => running;

/** The nightly run (and the admin's "Run now"). `apply` false = report only. */
export async function runFootballLab(now = Date.now(), apply = true): Promise<LabRun | { skipped: string }> {
  if (running) return { skipped: 'running' };
  if (isTuning()) return { skipped: 'a v3 tune is running' };
  running = true;
  const t0 = Date.now();
  try {
    const data = await loadGames(now);
    const windows: Window[] = seasonWindows(data.games, data.seasons);
    if (data.games.some(g => g.src === 'record')) windows.push({ key: 'record', label: `Public record, last ${RECORD_DAYS} days`, from: now - RECORD_DAYS * DAY, to: now + 1, src: 'record', judge: false });
    const rep = await runAsync(labSteps(data.games, windows, { nRows: data.nRows, rowNames: data.rowNames }), yieldLoop);
    const prev = labLive();
    const guard = prev ? guardOf(prev) : null;
    let decision: LabRun['decision'] = 'none', why = rep.winnerWhy;
    let next: LabLive | null = prev;
    const lastPromo = getConfig('football_lab_promoted', '');
    const wait = promotionWait(lastPromo || null, iso(now));
    if (prev && guard && guard.n >= DAILY_RULES.guardGames && guard.diff > DAILY_RULES.guardWorse) {
      decision = 'rollback'; why = `${CAND_LABEL[prev.cand]} was worse than no layer by ${guard.diff.toFixed(4)} over ${guard.n} record games since ${prev.since}`; next = null;
    } else if (rep.winner && rep.live) {
      if (prev && prev.cand === rep.winner) { decision = 'refit'; why = `passed again — refitted on every game (${rep.winnerWhy})`; next = { ...prev, params: rep.live, refitAt: iso(now), why: rep.winnerWhy }; }
      else if (wait > 0) { decision = 'held'; why = `${rep.winnerWhy} — held: the last promotion was ${lastPromo} (next in ${wait} days)`; }
      else { decision = 'promote'; why = rep.winnerWhy; next = { cand: rep.winner, params: rep.live, since: iso(now), why: rep.winnerWhy }; }
    } else if (prev) {
      decision = 'keep'; why = `${CAND_LABEL[prev.cand]} stays live (${guard ? `${guard.n} record games since ${prev.since}, ${guard.diff >= 0 ? '+' : ''}${guard.diff.toFixed(4)} vs no layer` : 'no record games yet'}); tonight: ${rep.winnerWhy}`;
    }
    const report: LabRun = {
      ...rep, live: null, builtAt: new Date(now).toISOString(), ms: Date.now() - t0, notes: data.notes, rules: LAB_RULES, decision, decisionWhy: why,
      liveNow: next ? { cand: next.cand, label: CAND_LABEL[next.cand], since: next.since, why: next.why, guard: guard && prev?.cand === next.cand ? guard : { n: 0, diff: 0 } } : null,
      names: { before: 'SL Football 3.0', after: decision === 'promote' ? 'SL Football 3.1 (bump utils/modelNames.ts + lib/modelNames.ts in a commit)' : null }
    };
    db.prepare(`INSERT OR REPLACE INTO football_lab_runs (date, ran_at, report, decision, ms) VALUES (?, ?, ?, ?, ?)`).run(iso(now), new Date().toISOString(), JSON.stringify(report), decision, report.ms);
    db.prepare(`DELETE FROM football_lab_runs WHERE date < ?`).run(iso(now - 120 * DAY));
    if (apply && (decision === 'promote' || decision === 'refit' || decision === 'rollback')) {
      setConfig(LAB_KEY, next ? JSON.stringify(next) : '');
      if (decision === 'promote') setConfig('football_lab_promoted', iso(now));
      clearPredictionCache();
    }
    logger.info(`football lab: ${decision} — ${why} (${Math.round(report.ms / 1000)} s)`);
    return report;
  } finally { running = false; }
}

/** the last stored report (admin card), or null */
export function lastFootballLab(): LabRun | null {
  try { const r: any = db.prepare(`SELECT report FROM football_lab_runs ORDER BY date DESC LIMIT 1`).get(); return r ? JSON.parse(r.report) : null; } catch { return null; }
}

/** worker: once ~40 min after start (when no run is stored yet), then every day from 05:10 UTC */
export function footballLabDue(now = Date.now()): boolean {
  const d = new Date(now);
  if (db.prepare(`SELECT 1 FROM football_lab_runs WHERE date = ?`).get(iso(now))) return false;
  return d.getUTCHours() * 60 + d.getUTCMinutes() >= 5 * 60 + 10 || !db.prepare(`SELECT 1 FROM football_lab_runs LIMIT 1`).get();
}

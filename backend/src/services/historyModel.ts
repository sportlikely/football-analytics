/**
 * Model v2 ("dc-history-v2"): Dixon-Coles fitted on football-data.co.uk history,
 * one fit per country group. Also runs the walk-forward backtest.
 */
import { yieldLoop, timed } from './perf';
import { db } from '../db';
import logger from '../utils/logger';
import { Prediction } from './predictionModel';
import { fitDixonColes, fitDixonColesAsync, predictDC, DCParams } from './dixonColes';
import { GROUPS, groupForCompetition, loadGroupMatches, buildTeamMap, fdNameFor, ApiTeam, seasonCodes, syncAll } from './history';

export const MODEL_V2 = 'dc-history-v2';
const FIT_OPTS = { halfLifeDays: 180, ridge: 1.0, sweeps: 40 };

const params = new Map<string, DCParams>();
let lastFitAt: string | null = null;
let lastMapReport: Record<string, { mapped: number; unmatched: string[] }> = {};

db.exec(`
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    season      TEXT NOT NULL,
    grp         TEXT NOT NULL,
    model       TEXT NOT NULL,
    matches     INTEGER NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    params      TEXT
  );
  CREATE TABLE IF NOT EXISTS backtest_predictions (
    run_id      INTEGER NOT NULL,
    division    TEXT NOT NULL,
    date        TEXT NOT NULL,
    home        TEXT NOT NULL,
    away        TEXT NOT NULL,
    hg          INTEGER NOT NULL,
    ag          INTEGER NOT NULL,
    outcome     TEXT NOT NULL,
    p_home      REAL NOT NULL,
    p_draw      REAL NOT NULL,
    p_away      REAL NOT NULL,
    xg_home     REAL, xg_away REAL,
    odds_home   REAL, odds_draw REAL, odds_away REAL,      -- closing (fallback early)
    early_h     REAL, early_d REAL, early_a REAL,          -- 1-3 days before kick-off
    evidence    REAL,
    PRIMARY KEY (run_id, division, date, home, away)
  );
`);
// Schema upgrade: older databases lack the early_* columns → rebuild (backtests are cheap to re-run)
{
  const cols: any[] = db.prepare(`PRAGMA table_info(backtest_predictions)`).all();
  if (cols.length && !cols.some(c => c.name === 'early_h')) {
    db.exec(`DROP TABLE backtest_predictions; DROP TABLE backtest_runs;`);
    db.exec(`
      CREATE TABLE backtest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, grp TEXT NOT NULL, model TEXT NOT NULL,
        matches INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, params TEXT
      );
      CREATE TABLE backtest_predictions (
        run_id INTEGER NOT NULL, division TEXT NOT NULL, date TEXT NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
        hg INTEGER NOT NULL, ag INTEGER NOT NULL, outcome TEXT NOT NULL,
        p_home REAL NOT NULL, p_draw REAL NOT NULL, p_away REAL NOT NULL, xg_home REAL, xg_away REAL,
        odds_home REAL, odds_draw REAL, odds_away REAL, early_h REAL, early_d REAL, early_a REAL, evidence REAL,
        PRIMARY KEY (run_id, division, date, home, away)
      );
    `);
    logger.info('backtest tables rebuilt with early-odds columns');
  }
}

/** Fit (or refit) every group from the stored history, as of today. */
export async function fitAllGroups(asOf: string = new Date().toISOString().slice(0, 10)) {
  let fitted = 0;
  for (const group of Object.keys(GROUPS)) {
    await yieldLoop(); // one group at a time, so the site keeps answering
    const matches = loadGroupMatches(group, asOf);
    if (matches.length < 100) {
      console.log(`  ⚠️  model v2 ${group}: only ${matches.length} matches, skipping`);
      continue;
    }
    const t0 = Date.now();
    const p = await fitDixonColesAsync(matches, asOf, { ...FIT_OPTS, warm: params.get(group) || null }); // fix169: yields between sweeps
    params.set(group, p);
    fitted++;
    console.log(
      `  🧮 model v2 ${group}: ${matches.length} matches, ${p.teams.length} teams, home adv ${p.homeAdv.toFixed(2)}, rho ${p.rho}, ${Date.now() - t0}ms`
    );
  }
  lastFitAt = new Date().toISOString();
  return fitted;
}

/** Build team maps for every group from the current standings (by competition code). */
export function mapTeamsFromStandings(standingsByCode: Map<string, any>) {
  const teamsByGroup = new Map<string, Map<number, ApiTeam>>();
  standingsByCode.forEach((standings, code) => {
    const group = groupForCompetition(code);
    if (!group) return;
    const bucket = teamsByGroup.get(group) || new Map<number, ApiTeam>();
    for (const table of standings?.standings || []) {
      for (const row of table.table || []) {
        const t = row.team;
        if (t?.id) bucket.set(t.id, { id: t.id, name: t.name, shortName: t.shortName, tla: t.tla });
      }
    }
    teamsByGroup.set(group, bucket);
  });
  const report: Record<string, { mapped: number; unmatched: string[] }> = {};
  teamsByGroup.forEach((teams, group) => {
    report[group] = buildTeamMap(group, Array.from(teams.values()));
  });
  return report;
}

/** Model v2 prediction for a Football-Data.org match object, or null if not covered. */
export function predictV2(match: any): Prediction | null {
  const code = match?.competition?.code;
  const group = code ? groupForCompetition(code) : null;
  if (!group) return null;
  const p = params.get(group);
  if (!p) return null;
  const home = fdNameFor(group, match.homeTeam?.id);
  const away = fdNameFor(group, match.awayTeam?.id);
  if (!home || !away) return null;
  const dc = predictDC(p, home, away);
  if (!dc) return null;
  const minEvidence = Math.min(dc.evidence.home, dc.evidence.away);
  return {
    model: MODEL_V2,
    home: dc.home,
    draw: dc.draw,
    away: dc.away,
    expectedGoals: { home: dc.lambdaHome, away: dc.lambdaAway },
    over25: dc.over25,
    btts: dc.btts,
    topScores: dc.topScores,
    confidence: minEvidence < 8 ? 'low' : minEvidence < 20 ? 'medium' : 'high',
    factors: {
      homeAttack: dc.strengths.homeAttack,
      homeDefence: dc.strengths.homeDefence,
      awayAttack: dc.strengths.awayAttack,
      awayDefence: dc.strengths.awayDefence,
      homeAdvantage: Math.round(Math.exp(p.homeAdv) * 100) / 100,
      homeForm: 1,
      awayForm: 1,
      gamesPlayed: { home: Math.round(dc.evidence.home), away: Math.round(dc.evidence.away) },
      leagueAvgGoals: Math.round(Math.exp(p.intercept) * 100) / 100
    }
  };
}

export function modelV2Status() {
  const groups: Record<string, any> = {};
  params.forEach((p, g) => {
    groups[g] = { teams: p.teams.length, homeAdv: Math.round(p.homeAdv * 100) / 100, rho: p.rho, avgGoals: Math.round(Math.exp(p.intercept) * 100) / 100 };
  });
  return { model: MODEL_V2, lastFitAt, groups, teamMap: lastMapReport };
}

/** Sync history (if needed), map teams, fit. Safe to call repeatedly. */
export async function prepareModelV2(standingsByCode: Map<string, any>, forceSync = false) {
  // Always refresh: syncAll re-downloads only the current season (and any missing one), so new results
  // reach v2/v3 every run. Past seasons are skipped unless forced.
  try {
    await syncAll(seasonCodes(3), forceSync);
  } catch (e: any) {
    console.log(`⚠️  History sync failed, fitting on stored results: ${e.message}`);
  }
  const map = mapTeamsFromStandings(standingsByCode);
  lastMapReport = map;
  const fitted = await timed('model v2 fit', () => fitAllGroups());
  return { fitted, map };
}

/* ---------------- backtest ---------------- */

const insertBt = db.prepare(`
  INSERT OR REPLACE INTO backtest_predictions
    (run_id, division, date, home, away, hg, ag, outcome, p_home, p_draw, p_away, xg_home, xg_away, odds_home, odds_draw, odds_away, early_h, early_d, early_a, evidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let running: { season: string; group: string; done: number; total: number } | null = null;
export const backtestProgress = () => running;

/**
 * Walk-forward backtest of one season for one group: every 7 days, refit on
 * everything before that date (with decay) and predict the coming week.
 */
export async function runBacktest(season: string, group: string) {
  const divs = GROUPS[group]?.divisions || [];
  if (!divs.length) throw new Error(`Unknown group ${group}`);
  const all = loadGroupMatches(group);
  const target = all.filter(m => m.season === season && m.division === divs[0]); // top division only
  if (!target.length) throw new Error(`No matches for ${group} ${season} — sync history first`);

  db.prepare(`DELETE FROM backtest_predictions WHERE run_id IN (SELECT id FROM backtest_runs WHERE season = ? AND grp = ? AND model = ?)`).run(season, group, MODEL_V2);
  db.prepare(`DELETE FROM backtest_runs WHERE season = ? AND grp = ? AND model = ?`).run(season, group, MODEL_V2);
  const runId = Number(
    db.prepare(`INSERT INTO backtest_runs (season, grp, model, matches, started_at, params) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(season, group, MODEL_V2, target.length, new Date().toISOString(), JSON.stringify(FIT_OPTS)).lastInsertRowid
  );

  running = { season, group, done: 0, total: target.length };
  let warm: DCParams | null = null;
  let cursor = new Date(target[0].date);
  const last = new Date(target[target.length - 1].date);
  let predicted = 0;
  const DAY = 24 * 3600 * 1000;

  while (cursor <= last) {
    const from = cursor.toISOString().slice(0, 10);
    const to = new Date(cursor.getTime() + 7 * DAY).toISOString().slice(0, 10);
    const week = target.filter(m => m.date >= from && m.date < to);
    if (week.length) {
      const train = all.filter(m => m.date < from);
      const p = fitDixonColes(train, from, { ...FIT_OPTS, warm, sweeps: warm ? 15 : 40 });
      warm = p;
      db.exec('BEGIN');
      try {
        for (const m of week) {
          const dc = predictDC(p, m.home, m.away);
          if (!dc) continue;
          const outcome = m.hg > m.ag ? 'H' : m.hg < m.ag ? 'A' : 'D';
          insertBt.run(
            runId, m.division, m.date, m.home, m.away, m.hg, m.ag, outcome,
            dc.home, dc.draw, dc.away, dc.lambdaHome, dc.lambdaAway,
            m.close_h ?? m.odds_h, m.close_d ?? m.odds_d, m.close_a ?? m.odds_a,
            m.odds_h, m.odds_d, m.odds_a,
            Math.min(dc.evidence.home, dc.evidence.away)
          );
          predicted++;
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      running.done += week.length;
      // yield to the event loop so the server stays responsive
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }
    cursor = new Date(cursor.getTime() + 7 * DAY);
  }
  db.prepare(`UPDATE backtest_runs SET finished_at = ?, matches = ? WHERE id = ?`).run(new Date().toISOString(), predicted, runId);
  running = null;
  logger.info(`Backtest ${group} ${season}: ${predicted} predictions`);
  return { runId, predicted };
}

export async function runBacktestAll(season: string) {
  const out: Record<string, any> = {};
  for (const group of Object.keys(GROUPS)) {
    try {
      out[group] = await runBacktest(season, group);
    } catch (error: any) {
      out[group] = { error: error.message };
    }
  }
  return out;
}

export interface BacktestRow {
  division: string;
  date: string;
  home: string;
  away: string;
  hg: number;
  ag: number;
  outcome: 'H' | 'D' | 'A';
  p_home: number;
  p_draw: number;
  p_away: number;
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
  early_h: number | null;
  early_d: number | null;
  early_a: number | null;
  evidence: number;
}

export function backtestRows(season: string, group?: string, minEvidence: number = 0, model: string = MODEL_V2): BacktestRow[] {
  const sql = `
    SELECT b.* FROM backtest_predictions b
    JOIN backtest_runs r ON r.id = b.run_id
    WHERE r.season = ? AND r.model = ? ${group ? 'AND r.grp = ?' : ''} AND b.evidence >= ?
    ORDER BY b.date DESC`;
  return group
    ? db.prepare(sql).all(season, model, group, minEvidence)
    : db.prepare(sql).all(season, model, minEvidence);
}

export function backtestRunsList() {
  return db.prepare(`SELECT id, season, grp, model, matches, started_at, finished_at FROM backtest_runs ORDER BY season DESC, grp`).all();
}

/**
 * Prediction tracking: save every prediction, lock it at kick-off,
 * settle it against the result, and compute accuracy metrics.
 */
import { MIX_MODEL, FEAT_MODEL, mixLive, mixLiveSince } from './featureModel';
import { TRIAL_COMPETITIONS } from './trial';
import { db } from '../db';
import logger from '../utils/logger';
import { Prediction } from './predictionModel';
import { doubleChance, dcHit, DC_STRONG, type DC } from '../utils/doubleChance';

const LIVE_OR_DONE = new Set(['IN_PLAY', 'PAUSED', 'FINISHED', 'AWARDED']);
const SETTLE_AFTER_MS = 105 * 60 * 1000; // kick-off + 105 min before we look for a result
const EDGE_THRESHOLD = 0.05; // bet when model EV at market odds >= +5%

export type Outcome = 'H' | 'D' | 'A';

// draw_streak: the lower of the two teams' draw share over their last 20 games (v3 league predictions), for the draw-alert rule
if (!(db.prepare(`PRAGMA table_info(predictions)`).all() as any[]).some(c => c.name === 'draw_streak'))
  db.exec(`ALTER TABLE predictions ADD COLUMN draw_streak REAL`);
// payload: the whole prediction as shown before kick-off (breakdown, reasons, scores), so a finished match can show
// exactly what we said — not a recalculation made after the result moved the ratings
if (!(db.prepare(`PRAGMA table_info(predictions)`).all() as any[]).some(c => c.name === 'payload'))
  db.exec(`ALTER TABLE predictions ADD COLUMN payload TEXT`);

const upsertStmt = db.prepare(`
  INSERT INTO predictions (
    match_id, model, competition_code, competition_name, utc_date,
    home_team_id, home_team, away_team_id, away_team,
    p_home, p_draw, p_away, xg_home, xg_away, over25, btts, confidence,
    games_home, games_away, odds_home, odds_draw, odds_away,
    locked, settled, created_at, updated_at, draw_streak, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
  ON CONFLICT(match_id, model) DO UPDATE SET
    utc_date = excluded.utc_date,
    p_home = excluded.p_home, p_draw = excluded.p_draw, p_away = excluded.p_away,
    xg_home = excluded.xg_home, xg_away = excluded.xg_away,
    over25 = excluded.over25, btts = excluded.btts, confidence = excluded.confidence,
    games_home = excluded.games_home, games_away = excluded.games_away,
    draw_streak = excluded.draw_streak,
    payload = excluded.payload,
    odds_home = COALESCE(excluded.odds_home, predictions.odds_home),
    odds_draw = COALESCE(excluded.odds_draw, predictions.odds_draw),
    odds_away = COALESCE(excluded.odds_away, predictions.odds_away),
    updated_at = excluded.updated_at
  WHERE predictions.locked = 0
`);

const lockStmt = db.prepare(
  `UPDATE predictions SET locked = 1, locked_at = COALESCE(locked_at, ?), updated_at = ? WHERE match_id = ? AND locked = 0`
);

/** Save/refresh predictions for a batch of matches (with .prediction attached). */
export function recordPredictions(matches: any[]) {
  // One transaction for the whole batch (Oct 2026): ~2,000 separate writes every 5 minutes froze the server for seconds
  db.exec('BEGIN');
  try {
    const r = recordPredictionsTx(matches);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already closed */ }
    throw e;
  }
}

function recordPredictionsTx(matches: any[]) {
  const now = new Date().toISOString();
  let saved = 0;
  let locked = 0;
  for (const m of matches) {
    const preds: Prediction[] = (m.predictions && m.predictions.length ? m.predictions : [m.prediction]).filter(Boolean);
    if (!preds.length) continue;
    // Postponed / suspended / cancelled matches are not locked: a rescheduled date must still be recordable
    const kickedOff =
      LIVE_OR_DONE.has(m.status) || (new Date(m.utcDate).getTime() <= Date.now() && !['POSTPONED', 'SUSPENDED', 'CANCELLED'].includes(m.status));

    if (kickedOff) {
      // Kick-off: freeze whatever was predicted before the match. Never insert
      // or update after the start — only pre-match predictions count.
      const l = lockStmt.run(now, now, m.id);
      if (Number(l.changes) > 0) locked++;
      continue;
    }

    const odds = m.odds?.msw || {};
    for (const p of preds) {
    const res = upsertStmt.run(
      m.id,
      p.model,
      m.competition?.code || null,
      m.competition?.name || null,
      m.utcDate,
      m.homeTeam?.id || null,
      m.homeTeam?.shortName || m.homeTeam?.name || null,
      m.awayTeam?.id || null,
      m.awayTeam?.shortName || m.awayTeam?.name || null,
      p.home,
      p.draw,
      p.away,
      p.expectedGoals.home,
      p.expectedGoals.away,
      p.over25,
      p.btts,
      p.confidence,
      p.factors.gamesPlayed.home,
      p.factors.gamesPlayed.away,
      odds.homeWin ?? null,
      odds.draw ?? null,
      odds.awayWin ?? null,
      now,
      now,
      p.drawStreak ? Math.min(p.drawStreak.home, p.drawStreak.away) : null,
      JSON.stringify(p)
    );
    if (Number(res.changes) > 0) saved++;
    }
  }
  if (saved || locked) logger.info(`Predictions saved: ${saved}, newly locked: ${locked}`);
}

/* ------------------------------------------------------------------ */
/* Frozen predictions: what a started / finished match shows            */
/* ------------------------------------------------------------------ */

const frozenStmt = db.prepare(`
  SELECT model, p_home, p_draw, p_away, xg_home, xg_away, over25, btts, confidence, games_home, games_away, draw_streak, payload, locked_at
  FROM predictions WHERE match_id = ? AND locked = 1`);

/**
 * Once a match has started, the site must show the prediction we saved BEFORE kick-off. Recomputing it later would
 * use ratings that already include this result (Grenada–Cuba: 45% Grenada before the game, 35% after the 0–3).
 * Matches we never saved (older than tracking) keep the computed prediction.
 * Rows saved before the full payload was stored (≤ 26 Sep 2026) keep their saved 1X2 and goals figures; the
 * breakdown and scores from the recalculation are dropped, because they would be hindsight.
 */
export function freezePredictions(match: any, computed: Prediction[]): Prediction[] {
  if (!match || !LIVE_OR_DONE.has(match.status)) return computed;
  let rows: any[] = [];
  try { rows = frozenStmt.all(match.id) as any[]; } catch { return computed; }
  if (!rows.length) return computed;
  const order = (m: string) => { const i = computed.findIndex(p => p.model === m); return i < 0 ? 99 : i; };
  return rows.sort((a, b) => order(a.model) - order(b.model)).map(r => {
    let full: any = null;
    if (r.payload) { try { full = JSON.parse(r.payload); } catch { full = null; } }
    const recalc: any = computed.find(p => p.model === r.model);
    const base: any = full || recalc || {
      model: r.model, topScores: [],
      factors: { homeAttack: 0, homeDefence: 0, awayAttack: 0, awayDefence: 0, homeAdvantage: 1, homeForm: 0, awayForm: 0, gamesPlayed: { home: r.games_home || 0, away: r.games_away || 0 }, leagueAvgGoals: 0 }
    };
    const out: any = {
      ...base,
      home: r.p_home, draw: r.p_draw, away: r.p_away,
      expectedGoals: { home: r.xg_home, away: r.xg_away },
      over25: r.over25, btts: r.btts, confidence: r.confidence,
      frozen: { at: r.locked_at || null, full: !!full }
    };
    if (!full) { delete out.grid; out.topScores = []; }
    return out as Prediction;
  });
}

const pendingStmt = db.prepare(
  `SELECT DISTINCT match_id, utc_date FROM predictions WHERE settled = 0 AND utc_date <= ? ORDER BY utc_date`
);
// fix200: a void game keeps its reason (admin: /api/admin/voided)
if (!(db.prepare(`PRAGMA table_info(results)`).all() as any[]).some(c => c.name === 'reason')) db.exec(`ALTER TABLE results ADD COLUMN reason TEXT`);
const insertResult = db.prepare(
  `INSERT OR REPLACE INTO results (match_id, status, home_goals, away_goals, outcome, settled_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const markSettled = db.prepare(`UPDATE predictions SET settled = 1, locked = 1, updated_at = ? WHERE match_id = ?`);
// Postponed / suspended: unlock so the rescheduled date (and a fresh pre-match prediction) can be recorded
const unlockStmt = db.prepare(`UPDATE predictions SET locked = 0, updated_at = ? WHERE match_id = ? AND settled = 0`);

const AF_ID_OFFSET = 1_000_000_000;
const MAX_PENDING_DAYS = 21; // give up on a result after 3 weeks (void)
const RESCHEDULE_STATUSES = new Set(['POSTPONED', 'SUSPENDED']);

/** Normalised result from either source. status: FINISHED | VOID | RESCHEDULE | OPEN */
interface ResultRow { id: number; status: 'FINISHED' | 'VOID' | 'RESCHEDULE' | 'OPEN'; raw: string; h: number | null; a: number | null }

/** Football-Data.org match → result. 1X2 is settled on the 90-minute score (regularTime after extra time / penalties). */
function fdResult(m: any): ResultRow {
  if (m.status === 'FINISHED' || m.status === 'AWARDED') {
    const s = m.score?.duration && m.score.duration !== 'REGULAR' && m.score.regularTime ? m.score.regularTime : m.score?.fullTime;
    const h = s?.home, a = s?.away;
    if (h === null || h === undefined || a === null || a === undefined) return { id: m.id, status: 'OPEN', raw: m.status, h: null, a: null };
    return { id: m.id, status: 'FINISHED', raw: m.status, h, a };
  }
  if (m.status === 'CANCELLED') return { id: m.id, status: 'VOID', raw: m.status, h: null, a: null };
  if (RESCHEDULE_STATUSES.has(m.status)) return { id: m.id, status: 'RESCHEDULE', raw: m.status, h: null, a: null };
  // moved to a later date without a POSTPONED flag
  if (m.utcDate && new Date(m.utcDate).getTime() > Date.now()) return { id: m.id, status: 'RESCHEDULE', raw: m.status, h: null, a: null };
  return { id: m.id, status: 'OPEN', raw: m.status, h: null, a: null };
}

/** API-Football fixture → result (id offset applied). 1X2 on the 90-minute score. */
export function afResult(f: any): ResultRow {
  const id = AF_ID_OFFSET + f.fixture.id;
  const st = f.fixture?.status?.short;
  if (['FT', 'AET', 'PEN'].includes(st)) {
    const h = f.score?.fulltime?.home ?? f.goals?.home, a = f.score?.fulltime?.away ?? f.goals?.away;
    if (h === null || h === undefined || a === null || a === undefined) return { id, status: 'OPEN', raw: st, h: null, a: null };
    return { id, status: 'FINISHED', raw: 'FINISHED', h, a };
  }
  if (['AWD', 'WO', 'CANC', 'ABD'].includes(st)) return { id, status: 'VOID', raw: st, h: null, a: null };
  if (['PST', 'SUSP', 'INT', 'TBD'].includes(st)) return { id, status: 'RESCHEDULE', raw: st, h: null, a: null };
  if (f.fixture?.date && new Date(f.fixture.date).getTime() > Date.now()) return { id, status: 'RESCHEDULE', raw: st, h: null, a: null };
  return { id, status: 'OPEN', raw: st, h: null, a: null };
}

let settling = false;

/**
 * Settle pending predictions.
 * `fetchRange(dateFrom, dateTo)` returns Football-Data.org matches (any status) between two ISO dates.
 * `fetchAf(ids)` returns API-Football fixtures by fixture id (ids without the offset).
 */
export async function settlePending(
  fetchRange: (dateFrom: string, dateTo: string) => Promise<any[]>,
  fetchAf?: (fixtureIds: number[]) => Promise<any[]>
) {
  if (settling) return { settled: 0, pending: 0, skipped: true };
  settling = true;
  try {
    const cutoff = new Date(Date.now() - SETTLE_AFTER_MS).toISOString();
    const pending: { match_id: number; utc_date: string }[] = pendingStmt.all(cutoff);
    if (!pending.length) return { settled: 0, pending: 0 };
    const now = new Date().toISOString();
    const giveUp = new Date(Date.now() - MAX_PENDING_DAYS * 86400000).toISOString();
    let settled = 0;

    // Too old to still be waiting: void (keeps the fetch range short)
    const stale = pending.filter(p => p.utc_date < giveUp);
    for (const p of stale) {
      insertResult.run(p.match_id, 'UNRESOLVED', null, null, 'VOID', now, `no result ${MAX_PENDING_DAYS} days after kick-off`);
      markSettled.run(now, p.match_id);
      settled++;
    }
    const live = pending.filter(p => p.utc_date >= giveUp);
    const fdPending = live.filter(p => p.match_id < AF_ID_OFFSET);
    const afPending = live.filter(p => p.match_id >= AF_ID_OFFSET);
    const results: ResultRow[] = [];

    if (fdPending.length) {
      const day = (d: Date) => d.toISOString().slice(0, 10);
      let from = new Date(new Date(fdPending[0].utc_date).getTime() - 24 * 3600 * 1000);
      const end = new Date(new Date(fdPending[fdPending.length - 1].utc_date).getTime() + 24 * 3600 * 1000);
      while (from <= end) {
        const to = new Date(Math.min(from.getTime() + 9 * 24 * 3600 * 1000, end.getTime()));
        try {
          for (const m of await fetchRange(day(from), day(to))) results.push(fdResult(m));
        } catch (error: any) {
          logger.warn('Settle fetch failed', { from: day(from), to: day(to), message: error.message });
        }
        from = new Date(to.getTime() + 24 * 3600 * 1000);
      }
    }
    if (afPending.length && fetchAf) {
      const ids = afPending.map(p => p.match_id - AF_ID_OFFSET);
      for (let i = 0; i < ids.length; i += 20) {
        try {
          for (const f of await fetchAf(ids.slice(i, i + 20))) results.push(afResult(f));
        } catch (error: any) {
          logger.warn('Settle (API-Football) failed', { message: error.message });
          break;
        }
      }
    }

    const ids = new Set(live.map(p => p.match_id));
    for (const r of results) {
      if (!ids.has(r.id)) continue;
      if (r.status === 'FINISHED') {
        const outcome: Outcome = r.h! > r.a! ? 'H' : r.h! < r.a! ? 'A' : 'D';
        insertResult.run(r.id, r.raw, r.h, r.a, outcome, now, null);
        markSettled.run(now, r.id);
        settled++;
      } else if (r.status === 'VOID') {
        insertResult.run(r.id, r.raw, null, null, 'VOID', now, `${r.raw === 'CANC' || r.raw === 'CANCELLED' ? 'cancelled' : r.raw === 'ABD' ? 'abandoned' : r.raw === 'AWD' || r.raw === 'WO' ? 'awarded (no score)' : r.raw} by the provider`);
        markSettled.run(now, r.id);
        settled++;
      } else if (r.status === 'RESCHEDULE') {
        unlockStmt.run(now, r.id);
      }
    }
    if (settled) logger.info(`Settled ${settled} predictions (${pending.length - settled} still pending)`);
    return { settled, pending: pending.length - settled };
  } finally {
    settling = false;
  }
}

/* ---------------- metrics ---------------- */

export interface SettledRow {
  match_id: number;
  model: string;
  competition_code: string | null;
  competition_name: string | null;
  utc_date: string;
  home_team: string;
  away_team: string;
  home_team_id?: number | null;
  away_team_id?: number | null;
  p_home: number;
  p_draw: number;
  p_away: number;
  confidence: string | null;
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
  draw_streak?: number | null;
  over25?: number | null;
  btts?: number | null;
  xg_home?: number | null;
  xg_away?: number | null;
  home_goals: number;
  away_goals: number;
  outcome: Outcome;
}

/**
 * Pseudo-models for the Accuracy page:
 *   main   – every settled match once, seen by our best model for it (v3 for leagues, national-team Elo,
 *            European-cup Elo, then v2 / v1) → every game counts, national teams and cups included
 *   market – the same matches seen by the bookmakers (only matches with recorded odds; margin removed)
 */
const MAIN_PRIORITY = ['grid-v3', 'elo-intl', 'elo-euro', 'dc-history-v2', 'poisson-dc-v1'];
// v3-mix counts as the main league model only for games from the day it went live (before that it was a shadow);
// feat-v1 never does
const mainRank = (m: string, date?: string) => {
  if (m === MIX_MODEL) { const since = mixLive() ? mixLiveSince() : ''; return since && date && date >= since ? -1 : 99; }
  if (m === FEAT_MODEL) return 99;
  const i = MAIN_PRIORITY.indexOf(m); return i < 0 ? 99 : i;
};
function settledRows(days: number, competition?: string, model?: string): SettledRow[] {
  if (model !== 'main' && model !== 'market') return settledRowsRaw(days, competition, model);
  const all = settledRowsRaw(days, competition);
  const best = new Map<number, SettledRow>();
  const odds = new Map<number, [number, number, number]>();
  for (const r of all) {
    const cur = best.get(r.match_id);
    if (r.odds_home && r.odds_draw && r.odds_away && !odds.has(r.match_id)) odds.set(r.match_id, [r.odds_home, r.odds_draw, r.odds_away]);
    if ((r.model === FEAT_MODEL || r.model === MIX_MODEL) && mainRank(r.model, r.utc_date) >= 99) continue; // shadow rows
    if (!cur || mainRank(r.model, r.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(r.match_id, r);
  }
  let rows = [...best.values()].map(r => {
    const o = odds.get(r.match_id);
    return o && !r.odds_home ? { ...r, odds_home: o[0], odds_draw: o[1], odds_away: o[2] } : r;
  });
  if (model === 'market') {
    rows = rows.filter(r => r.odds_home && r.odds_draw && r.odds_away).map(r => {
      const inv = [1 / r.odds_home!, 1 / r.odds_draw!, 1 / r.odds_away!];
      const s = inv[0] + inv[1] + inv[2];
      const q = (x: number) => Math.round((x / s) * 1000) / 10;
      return { ...r, model: 'market', p_home: q(inv[0]), p_draw: q(inv[1]), p_away: q(inv[2]), confidence: null };
    });
  }
  return rows.sort((a, b) => (a.utc_date < b.utc_date ? 1 : -1));
}

/** Every settled match once (best model), newest first — for per-team records (team analysis). */
export function mainSettledRows(days: number): SettledRow[] {
  return settledRows(days, undefined, 'main');
}

function settledRowsRaw(days: number, competition?: string, model?: string): SettledRow[] {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const args: any[] = [since];
  let where = '';
  if (competition) {
    where += ' AND p.competition_code = ?';
    args.push(competition);
  } else if (TRIAL_COMPETITIONS.size) {
    // leagues still in testing count only when asked for by name (admin), not in the overall record
    where += ` AND COALESCE(p.competition_code, '') NOT IN (${[...TRIAL_COMPETITIONS].map(() => '?').join(',')})`;
    args.push(...TRIAL_COMPETITIONS);
  }
  if (model) {
    where += ' AND p.model = ?';
    args.push(model);
  }
  const sql = `
    SELECT p.match_id, p.model, p.competition_code, p.competition_name, p.utc_date,
           p.home_team, p.away_team, p.home_team_id, p.away_team_id, p.p_home, p.p_draw, p.p_away, p.confidence,
           p.odds_home, p.odds_draw, p.odds_away, p.draw_streak, p.over25, p.btts, p.xg_home, p.xg_away,
           r.home_goals, r.away_goals, r.outcome
    FROM predictions p JOIN results r ON r.match_id = p.match_id
    WHERE p.settled = 1 AND r.outcome IN ('H','D','A') AND p.utc_date >= ?${where}
    ORDER BY p.utc_date DESC`;
  return db.prepare(sql).all(...args);
}

export function modelsTracked(): string[] {
  return db.prepare(`SELECT DISTINCT model FROM predictions ORDER BY model`).all().map((r: any) => r.model);
}

function pick(r: { p_home: number; p_draw: number; p_away: number }): Outcome {
  if (r.p_home >= r.p_draw && r.p_home >= r.p_away) return 'H';
  if (r.p_away >= r.p_draw) return 'A';
  return 'D';
}

function dcOf(r: { p_home: number; p_draw: number; p_away: number; outcome?: string }) {
  const d = doubleChance(Number(r.p_home), Number(r.p_draw), Number(r.p_away));
  if (!d) return null;
  const o = r.outcome;
  const tot = Number(r.p_home) + Number(r.p_draw) + Number(r.p_away) || 1; // % (fractions on very old rows)
  return { pick: d.k, p: Math.round((100 * d.p) / tot), hit: o === 'H' || o === 'D' || o === 'A' ? dcHit(d.k, o) : null };
}

function probOf(r: { p_home: number; p_draw: number; p_away: number }, o: Outcome) {
  return (o === 'H' ? r.p_home : o === 'D' ? r.p_draw : r.p_away) / 100;
}

/** Generic row shape for metric computation (live tracking and backtests). */
export interface MetricRow {
  p_home: number;
  p_draw: number;
  p_away: number;
  odds_home: number | null;
  odds_draw: number | null;
  odds_away: number | null;
  outcome: Outcome;
  groupKey: string;
  groupName: string;
  drawAlertEligible?: boolean; // v3 prediction outside La Liga
  drawStreak?: number | null; // lower of the two teams' draw share over their last 20 games
}

function oddsOf(r: MetricRow, o: Outcome) {
  return o === 'H' ? r.odds_home : o === 'D' ? r.odds_draw : r.odds_away;
}

/** Bookmaker implied probabilities with the overround removed. */
function marketProbs(r: MetricRow): Record<Outcome, number> | null {
  if (!r.odds_home || !r.odds_draw || !r.odds_away) return null;
  const inv = { H: 1 / r.odds_home, D: 1 / r.odds_draw, A: 1 / r.odds_away };
  const sum = inv.H + inv.D + inv.A;
  return { H: inv.H / sum, D: inv.D / sum, A: inv.A / sum };
}

function brier(p: Record<Outcome, number>, actual: Outcome) {
  return (['H', 'D', 'A'] as Outcome[]).reduce((s, o) => s + Math.pow(p[o] - (o === actual ? 1 : 0), 2), 0);
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => Math.round(x * 1000) / 10;

export function computeMetrics(rows: MetricRow[], opts: { edgeThreshold?: number } = {}) {
  const EDGE = opts.edgeThreshold ?? EDGE_THRESHOLD;
  const n = rows.length;
  let hits = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let mHits = 0;
  let mBrier = 0;
  let mLogLoss = 0;
  let mN = 0;
  const outcomes = { H: 0, D: 0, A: 0 };
  const picks = { H: 0, D: 0, A: 0 };
  const bins = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.01].map((hi, i, arr) => ({
    from: i === 0 ? 0 : arr[i - 1],
    to: hi,
    n: 0,
    hits: 0,
    predSum: 0
  }));
  const edgeBets = { bets: 0, wins: 0, profit: 0 };
  const favBets = { bets: 0, wins: 0, profit: 0 };
  // strong picks: the model's pick when it is at least X% sure (and the market's, for comparison)
  const TIERS = [0.5, 0.6, 0.7];
  const tiers = TIERS.map(t => ({ min: t, n: 0, hits: 0, profit: 0, bets: 0, mN: 0, mHits: 0 }));
  // two options (double chance): the two most likely results; "close" = no result reaches 50%
  const two = { n: 0, hits: 0, profit: 0, bets: 0, closeN: 0, closeHits: 0 };
  // draw alerts (v3 rule, priced at the recorded market odds): see DRAW_ALERT in the frontend
  const da = { n: 0, wins: 0, profit: 0 };
  const byGroup = new Map<string, { name: string; n: number; hits: number; brier: number; mBrier: number; mN: number; profit: number; bets: number }>();

  for (const r of rows) {
    const p = { H: r.p_home / 100, D: r.p_draw / 100, A: r.p_away / 100 };
    const pk = pick(r);
    const hit = pk === r.outcome;
    hits += hit ? 1 : 0;
    const b = brier(p, r.outcome);
    brierSum += b;
    logLossSum += -Math.log(Math.max(1e-6, probOf(r, r.outcome)));
    outcomes[r.outcome]++;
    picks[pk]++;

    const bin = bins.find(x => p[pk] >= x.from && p[pk] < x.to);
    if (bin) {
      bin.n++;
      bin.hits += hit ? 1 : 0;
      bin.predSum += p[pk];
    }

    const top2 = (['H', 'D', 'A'] as Outcome[]).sort((x, y) => p[y] - p[x]).slice(0, 2);
    const twoHit = top2.includes(r.outcome);
    two.n++;
    if (twoHit) two.hits++;
    if (p[pk] < 0.5) { two.closeN++; if (twoHit) two.closeHits++; }
    const oa = oddsOf(r, top2[0]), ob = oddsOf(r, top2[1]);
    if (oa && ob) {
      const dc = 1 / (1 / oa + 1 / ob); // double-chance price implied by the 1X2 odds
      two.bets++;
      two.profit += twoHit ? dc - 1 : -1;
    }
    for (const t of tiers) {
      if (p[pk] < t.min) continue;
      t.n++;
      if (hit) t.hits++;
      const o = oddsOf(r, pk);
      if (o) { t.bets++; t.profit += hit ? o - 1 : -1; }
    }

    const g = byGroup.get(r.groupKey) || { name: r.groupName, n: 0, hits: 0, brier: 0, mBrier: 0, mN: 0, profit: 0, bets: 0 };
    g.n++;
    g.hits += hit ? 1 : 0;
    g.brier += b;

    const mp = marketProbs(r);
    if (mp) {
      mN++;
      const mPick = (['H', 'D', 'A'] as Outcome[]).reduce((best, o) => (mp[o] > mp[best] ? o : best), 'H' as Outcome);
      mHits += mPick === r.outcome ? 1 : 0;
      for (const t of tiers) if (mp[mPick] >= t.min) { t.mN++; if (mPick === r.outcome) t.mHits++; }
      if (r.drawAlertEligible && r.odds_draw && p.D >= 0.3 && !(r.drawStreak != null && r.drawStreak >= 0.32)) {
        const anchored = mp.D + 0.75 * (p.D - mp.D);
        const e = anchored * r.odds_draw - 1;
        if (e >= 0.02 && e <= 0.2) { da.n++; if (r.outcome === 'D') { da.wins++; da.profit += r.odds_draw - 1; } else da.profit -= 1; }
      }
      const mb = brier(mp, r.outcome);
      mBrier += mb;
      mLogLoss += -Math.log(Math.max(1e-6, mp[r.outcome]));
      g.mBrier += mb;
      g.mN++;

      for (const o of ['H', 'D', 'A'] as Outcome[]) {
        const odds = oddsOf(r, o)!;
        if (p[o] * odds - 1 >= EDGE) {
          edgeBets.bets++;
          g.bets++;
          if (o === r.outcome) {
            edgeBets.wins++;
            edgeBets.profit += odds - 1;
            g.profit += odds - 1;
          } else {
            edgeBets.profit -= 1;
            g.profit -= 1;
          }
        }
      }
      const fo = oddsOf(r, pk)!;
      favBets.bets++;
      if (hit) {
        favBets.wins++;
        favBets.profit += fo - 1;
      } else favBets.profit -= 1;
    }
    byGroup.set(r.groupKey, g);
  }

  return {
    settled: n,
    model: n ? { hitRate: pct(hits / n), brier: r3(brierSum / n), logLoss: r3(logLossSum / n) } : null,
    market: mN ? { n: mN, hitRate: pct(mHits / mN), brier: r3(mBrier / mN), logLoss: r3(mLogLoss / mN) } : null,
    betting: mN
      ? {
          edgeThreshold: EDGE,
          edge: { ...edgeBets, profit: r3(edgeBets.profit), roi: edgeBets.bets ? pct(edgeBets.profit / edgeBets.bets) : 0 },
          favourite: { ...favBets, profit: r3(favBets.profit), roi: favBets.bets ? pct(favBets.profit / favBets.bets) : 0 }
        }
      : null,
    outcomes,
    picks,
    strongPicks: tiers.map(t => ({
      min: Math.round(t.min * 100),
      n: t.n,
      share: n ? pct(t.n / n) : 0, // % of all matches that qualify
      hitRate: t.n ? pct(t.hits / t.n) : null,
      roi: t.bets ? pct(t.profit / t.bets) : null,
      market: t.mN ? { n: t.mN, hitRate: pct(t.mHits / t.mN) } : null
    })),
    drawAlerts: da.n ? { n: da.n, wins: da.wins, hitRate: pct(da.wins / da.n), roi: pct(da.profit / da.n) } : { n: 0, wins: 0, hitRate: null, roi: null },
    twoOptions: {
      n: two.n,
      hitRate: two.n ? pct(two.hits / two.n) : null,
      closeGames: { n: two.closeN, hitRate: two.closeN ? pct(two.closeHits / two.closeN) : null },
      roi: two.bets ? pct(two.profit / two.bets) : null
    },
    calibration: bins
      .filter(x => x.n > 0)
      .map(x => ({ range: `${Math.round(x.from * 100)}–${Math.min(100, Math.round(x.to * 100))}%`, n: x.n, predicted: pct(x.predSum / x.n), actual: pct(x.hits / x.n) })),
    byCompetition: Array.from(byGroup.entries())
      .map(([code, g]) => ({
        code,
        name: g.name,
        n: g.n,
        hitRate: pct(g.hits / g.n),
        brier: r3(g.brier / g.n),
        marketBrier: g.mN ? r3(g.mBrier / g.mN) : null,
        bets: g.bets,
        profit: r3(g.profit)
      }))
      .sort((a, b) => b.n - a.n)
  };
}

export function accuracy(days: number = 90, competition?: string, model?: string) {
  const rows = settledRows(days, competition, model);
  const metrics = computeMetrics(
    rows.map(r => ({
      p_home: r.p_home,
      p_draw: r.p_draw,
      p_away: r.p_away,
      odds_home: r.odds_home,
      odds_draw: r.odds_draw,
      odds_away: r.odds_away,
      outcome: r.outcome,
      groupKey: r.competition_code || '?',
      groupName: r.competition_name || r.competition_code || '?',
      drawAlertEligible: r.model === 'grid-v3' && r.competition_code !== 'PD',
      drawStreak: r.draw_streak ?? null
    }))
  );
  return {
    days,
    competition: competition || null,
    modelName: model || null,
    models: modelsTracked(),
    pending: (db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE settled = 0`).get() as any).c,
    ...metrics
  };
}

/** Club / national-team badge from a stored team id (API-Football ids are offset by 1e9). */
function crestOf(id?: number | null): string | null {
  if (!id) return null;
  return id >= 1_000_000_000 ? `https://media.api-sports.io/football/teams/${id - 1_000_000_000}.png` : `https://crests.football-data.org/${id}.png`;
}

export function recentSettled(days: number = 90, competition?: string, limit: number = 100, model?: string) {
  return settledRows(days, competition, model)
    .slice(0, limit)
    .map(r => ({
      matchId: r.match_id,
      date: r.utc_date,
      competition: r.competition_name,
      code: r.competition_code,
      home: r.home_team,
      away: r.away_team,
      homeCrest: crestOf(r.home_team_id),
      awayCrest: crestOf(r.away_team_id),
      score: `${r.home_goals}–${r.away_goals}`,
      outcome: r.outcome,
      pick: pick(r),
      hit: pick(r) === r.outcome,
      // fix120: the recommended pick is the double chance; `pick`/`hit` stay as the 1X2 hard call
      dc: dcOf(r),
      p: { H: r.p_home, D: r.p_draw, A: r.p_away },
      odds: r.odds_home ? { H: r.odds_home, D: r.odds_draw, A: r.odds_away } : null,
      confidence: r.confidence,
      model: r.model
    }));
}

export function trackingStatus() {
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM predictions`).get() as any).c;
  const locked = (db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE locked = 1 AND settled = 0`).get() as any).c;
  const settled = (db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE settled = 1`).get() as any).c;
  const withOdds = (db.prepare(`SELECT COUNT(*) AS c FROM predictions WHERE odds_home IS NOT NULL`).get() as any).c;
  return { total, open: total - locked - settled, locked, settled, withOdds };
}


/**
 * The public record (Accuracy page): three numbers, every settled game our main model predicted before kick-off.
 *  1. Match result, v3 vs the bookmakers: on games with bookmaker odds, how often v3's most likely result happened
 *     vs how often the bookmakers' favourite (lowest odds) did.
 *  2. Both teams to score: yes if v3 gave it 50%+, else no.
 *  3. Over / under 2.5 goals: over if v3 gave it 50%+, else under.
 */
export function publicRecord(days = 30, competition?: string, recentLimit = 60) {
  const rows = settledRows(days, competition, 'main');
  // Oct 2026: no bookmakers on the site. Every pick is counted on every finished game (not only games with odds).
  const res = { n: 0, v3: 0 };
  const btts = { n: 0, hits: 0, yesPicks: 0 };
  const ou = { n: 0, hits: 0, overPicks: 0 };
  const byComp = new Map<string, { code: string; name: string; n: number; v3: number; bn: number; bh: number; on: number; oh: number; dn: number; dh: number }>();
  // calibration (Oct 2026): every outcome of every match (home, draw, away) by the chance we gave it, in 10% steps
  const cal = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, n: 0, sumP: 0, hits: 0 }));
  const recent: any[] = [];
  // "safer" calls: double chance, over/under 1.5, and the most confident pick of each match
  const dc = { n: 0, v3: 0 };
  // double chance by how sure the model was of it (its two most likely results together)
  const DC_BANDS = [{ id: '90+', lo: 90, hi: 101 }, { id: '80-90', lo: 80, hi: 90 }, { id: '70-80', lo: 70, hi: 80 }];
  const dcBands = DC_BANDS.map(b => ({ ...b, n: 0, hits: 0 }));
  // the home page's "Our record" card: our best numbers at a few confidence levels (≥, cumulative), same games
  const HL = ['dcAll', 'dc85', 'dc90', 'resAll', 'res60', 'res70', 'res80', 'btts70', 'ou70'] as const;
  const hl = Object.fromEntries(HL.map(k => [k, { n: 0, hits: 0 }])) as Record<typeof HL[number], { n: number; hits: number }>;
  const hlAdd = (k: typeof HL[number], hit: boolean) => { hl[k].n++; if (hit) hl[k].hits++; };
  const ou15 = { n: 0, hits: 0, overPicks: 0 };
  const safest = { n: 0, hits: 0, byMarket: {} as Record<string, { n: number; hits: number }> };
  // how often we are right at each confidence level (the pick's own %)
  const BANDS = [{ id: '70+', lo: 70, hi: 101, label: '70% or more' }, { id: '60-70', lo: 60, hi: 70, label: '60–70%' }, { id: '50-60', lo: 50, hi: 60, label: '50–60%' }, { id: '<50', lo: 0, hi: 50, label: 'under 50%' }];
  const bands = BANDS.map(b => ({ ...b, n: 0, hits: 0, sumP: 0 }));
  // fix120: the double chance is our recommended pick; strong pick = double chance 85%+
  const dcStrong = { n: 0, v3: 0 };
  for (const r of rows) {
    const hg = Number(r.home_goals), ag = Number(r.away_goals);
    const v3pick = pick(r);
    const v3hit = v3pick === r.outcome;
    const topP = Math.max(Number(r.p_home), Number(r.p_draw), Number(r.p_away));
    const band = bands.find(b => topP >= b.lo && topP < b.hi);
    {
      const tot = Number(r.p_home) + Number(r.p_draw) + Number(r.p_away) || 1;
      const top = (100 * topP) / tot; // % (fractions on very old rows)
      hlAdd('resAll', v3hit);
      if (top >= 60) hlAdd('res60', v3hit);
      if (top >= 70) hlAdd('res70', v3hit);
      if (top >= 80) hlAdd('res80', v3hit);
    }
    if (band) {
      band.n++; band.sumP += topP; if (v3hit) band.hits++;
    }
    res.n++;
    if (v3hit) res.v3++;
    {
      const key = r.competition_code || r.competition_name || '?';
      const c = byComp.get(key) || { code: r.competition_code || '', name: r.competition_name || key, n: 0, v3: 0, bn: 0, bh: 0, on: 0, oh: 0, dn: 0, dh: 0 };
      c.n++;
      if (v3hit) c.v3++;
      if (r.btts !== null && r.btts !== undefined) { c.bn++; if ((Number(r.btts) >= 50) === (hg > 0 && ag > 0)) c.bh++; }
      if (r.over25 !== null && r.over25 !== undefined) { c.on++; if ((Number(r.over25) >= 50) === (hg + ag > 2.5)) c.oh++; }
      byComp.set(key, c);
    }
    for (const [p, o] of [[Number(r.p_home), 'H'], [Number(r.p_draw), 'D'], [Number(r.p_away), 'A']] as [number, Outcome][]) {
      if (!Number.isFinite(p)) continue;
      const b = cal[Math.min(9, Math.max(0, Math.floor(p / 10)))];
      b.n++; b.sumP += p; if (r.outcome === o) b.hits++;
    }
    let bttsPick: boolean | null = null, bttsHit: boolean | null = null;
    if (r.btts !== null && r.btts !== undefined) {
      bttsPick = Number(r.btts) >= 50;
      bttsHit = bttsPick === (hg > 0 && ag > 0);
      btts.n++;
      if (bttsHit) btts.hits++;
      if (bttsPick) btts.yesPicks++;
      if (Math.max(Number(r.btts), 100 - Number(r.btts)) >= 70) hlAdd('btts70', bttsHit);
    }
    let ouPick: boolean | null = null, ouHit: boolean | null = null;
    if (r.over25 !== null && r.over25 !== undefined) {
      ouPick = Number(r.over25) >= 50;
      ouHit = ouPick === (hg + ag > 2.5);
      ou.n++;
      if (ouHit) ou.hits++;
      if (ouPick) ou.overPicks++;
      if (Math.max(Number(r.over25), 100 - Number(r.over25)) >= 70) hlAdd('ou70', ouHit);
    }
    // double chance: the two results we rate highest together
    const myDc: { k: DC; p: number } = doubleChance(Number(r.p_home), Number(r.p_draw), Number(r.p_away)) || { k: '1X', p: 0 };
    const myDcHit = dcHit(myDc.k, r.outcome);
    dc.n++;
    if (myDcHit) dc.v3++;
    {
      const tot = Number(r.p_home) + Number(r.p_draw) + Number(r.p_away) || 1;
      const dcPct = (100 * myDc.p) / tot; // the stored chances are % (fractions on very old rows)
      const b = dcBands.find(x => dcPct >= x.lo && dcPct < x.hi);
      if (b) { b.n++; if (myDcHit) b.hits++; }
      hlAdd('dcAll', myDcHit);
      if (dcPct >= 85) hlAdd('dc85', myDcHit);
      if (dcPct >= 90) hlAdd('dc90', myDcHit);
      // fix120: strong pick = double chance 85%+
      if (dcPct >= DC_STRONG) { dcStrong.n++; if (myDcHit) dcStrong.v3++; }
    }
    {
      const c = byComp.get(r.competition_code || r.competition_name || '?');
      if (c) { c.dn++; if (myDcHit) c.dh++; }
    }
    // over/under 1.5 from the expected goals (Poisson): P(2+ goals) = 1 − e^−λ (1 + λ)
    let o15: { pick: boolean; hit: boolean; p: number } | null = null;
    if (r.xg_home != null && r.xg_away != null) {
      const lam = Number(r.xg_home) + Number(r.xg_away);
      const pOver = (1 - Math.exp(-lam) * (1 + lam)) * 100;
      const pk = pOver >= 50;
      o15 = { pick: pk, hit: pk === (hg + ag > 1.5), p: pk ? pOver : 100 - pOver };
      ou15.n++;
      if (o15.hit) ou15.hits++;
      if (pk) ou15.overPicks++;
    }
    // the most confident pick of the match across these markets
    const cands: { market: string; label: string; p: number; hit: boolean }[] = [
      { market: 'result', label: v3pick === 'H' ? r.home_team : v3pick === 'A' ? r.away_team : 'Draw', p: Math.max(Number(r.p_home), Number(r.p_draw), Number(r.p_away)), hit: v3hit },
      { market: 'double chance', label: myDc.k, p: myDc.p, hit: myDcHit }
    ];
    if (o15) cands.push({ market: 'goals 1.5', label: o15.pick ? 'Over 1.5' : 'Under 1.5', p: o15.p, hit: o15.hit });
    if (ouPick !== null) cands.push({ market: 'goals 2.5', label: ouPick ? 'Over 2.5' : 'Under 2.5', p: ouPick ? Number(r.over25) : 100 - Number(r.over25), hit: !!ouHit });
    if (bttsPick !== null) cands.push({ market: 'btts', label: bttsPick ? 'BTTS yes' : 'BTTS no', p: bttsPick ? Number(r.btts) : 100 - Number(r.btts), hit: !!bttsHit });
    const best = cands.sort((x, y) => y.p - x.p)[0];
    safest.n++;
    if (best.hit) safest.hits++;
    const bm = (safest.byMarket[best.market] ||= { n: 0, hits: 0 });
    bm.n++;
    if (best.hit) bm.hits++;

    if (recent.length < recentLimit)
      recent.push({
        dc: { pick: myDc.k, p: Math.round((100 * myDc.p) / (Number(r.p_home) + Number(r.p_draw) + Number(r.p_away) || 1)), hit: myDcHit },
        over15: o15 ? { pick: o15.pick, hit: o15.hit } : null,
        safest: { market: best.market, label: best.label, p: Math.round(best.p), hit: best.hit },
        matchId: r.match_id, date: r.utc_date, competition: r.competition_name, code: r.competition_code,
        home: r.home_team, away: r.away_team, homeCrest: crestOf(r.home_team_id), awayCrest: crestOf(r.away_team_id),
        score: `${hg}–${ag}`, outcome: r.outcome,
        result: { pick: v3pick, hit: v3hit },
        btts: bttsPick === null ? null : { pick: bttsPick, hit: bttsHit },
        over25: ouPick === null ? null : { pick: ouPick, hit: ouHit }
      });
  }
  const pc = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 10 : null);
  return {
    days,
    competition: competition || null,
    result: { n: res.n, v3: pc(res.v3, res.n), v3Hits: res.v3 },
    btts: { n: btts.n, hitRate: pc(btts.hits, btts.n), hits: btts.hits, yesShare: pc(btts.yesPicks, btts.n) },
    over25: { n: ou.n, hitRate: pc(ou.hits, ou.n), hits: ou.hits, overShare: pc(ou.overPicks, ou.n) },
    highlights: Object.fromEntries(HL.map(k => [k, { n: hl[k].n, hits: hl[k].hits, pct: pc(hl[k].hits, hl[k].n) }])) as Record<typeof HL[number], { n: number; hits: number; pct: number | null }>,
    doubleChance: { n: dc.n, v3: pc(dc.v3, dc.n), v3Hits: dc.v3, bands: dcBands.map(b => ({ id: b.id, min: b.lo, n: b.n, hits: b.hits, pct: pc(b.hits, b.n) })), strong: { min: DC_STRONG, n: dcStrong.n, hits: dcStrong.v3, hitRate: pc(dcStrong.v3, dcStrong.n) } },
    over15: { n: ou15.n, hitRate: pc(ou15.hits, ou15.n), hits: ou15.hits, overShare: pc(ou15.overPicks, ou15.n) },
    safest: {
      n: safest.n,
      hitRate: pc(safest.hits, safest.n),
      hits: safest.hits,
      byMarket: Object.entries(safest.byMarket).map(([market, v]) => ({ market, n: v.n, hitRate: pc(v.hits, v.n) })).sort((a, b) => b.n - a.n)
    },
    byConfidence: bands.map(b => ({ id: b.id, label: b.label, n: b.n, hitRate: pc(b.hits, b.n), said: b.n ? Math.round(b.sumP / b.n) : null })),
    calibration: cal.filter(b => b.n > 0).map(b => ({ lo: b.lo, hi: b.lo + 10, n: b.n, said: Math.round((b.sumP / b.n) * 10) / 10, happened: pc(b.hits, b.n) })),
    byCompetition: [...byComp.values()]
      .filter(c => c.n >= 5)
      .map(c => ({ code: c.code, name: c.name, n: c.n, v3: pc(c.v3, c.n), dc: pc(c.dh, c.dn), btts: pc(c.bh, c.bn), over25: pc(c.oh, c.on) }))
      .sort((a, b) => b.n - a.n),
    recent
  };
}

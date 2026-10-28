/**
 * fix254 — the nightly refit of the recent calibration layers (maths: utils/recentCalib.ts; the live state:
 * services/recentCalibState.ts). Football and tennis, once a day from 04:30 UTC (after the football daily job), in the
 * heavy queue: rows of the last 300 days (each pick's chance before this layer + whether it was right), the walk-forward
 * decision by the daily job's rules (promote / keep / held / rollback), the state stored and published, every run in
 * recent_calib_log. Data health "Calibration (<sport>)" then counts only predictions made with the live layer.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { heavy, timed, yieldLoop } from './perf';
import { publishState } from './shared';
import { mainRank } from './tracking';
import { MIX_MODEL, FEAT_MODEL } from './featureModel';
import { clearPredictionCache } from './predCache';
import { decideRecent, FIT_DAYS, type CRow, type RecentDecision } from '../utils/recentCalib';
import { DAILY_RULES, type P3 } from '../utils/dailyRules';
import { readRecentState, setRecentCache, recentState, type RecentSport, type RecentState } from './recentCalibState';

const DAY = 86400000;
export const RECENT_SPORTS: RecentSport[] = ['football', 'tennis'];
const horizon = (now: number) => new Date(Math.floor(now / DAY) * DAY - (2 * DAILY_RULES.windowDays + FIT_DAYS) * DAY).toISOString();
const Y: Record<string, number> = { H: 0, D: 1, A: 2 };

/** football: every settled league / cup / national game once (the main model's saved row), its 1X2 before the layer */
export function footballRows(now = Date.now()): CRow[] {
  const all = db.prepare(`SELECT p.match_id, p.model, p.utc_date, p.p_home, p.p_draw, p.p_away, p.p_pre, r.outcome
    FROM predictions p JOIN results r ON r.match_id = p.match_id
    WHERE p.locked = 1 AND COALESCE(p.backfilled, 0) = 0 AND r.outcome IN ('H','D','A') AND p.utc_date >= ? AND p.utc_date < ?`)
    .all(horizon(now), new Date(now).toISOString()) as any[];
  const best = new Map<number, any>();
  for (const r of all) {
    if ((r.model === FEAT_MODEL || r.model === MIX_MODEL) && mainRank(r.model, r.utc_date) >= 99) continue;
    const cur = best.get(r.match_id);
    if (!cur || mainRank(r.model, r.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(r.match_id, r);
  }
  const out: CRow[] = [];
  for (const r of best.values()) {
    let p: number[] = [Number(r.p_home), Number(r.p_draw), Number(r.p_away)];
    if (r.p_pre) { try { const q = JSON.parse(r.p_pre); if (Array.isArray(q) && q.length === 3 && q.every((x: any) => Number.isFinite(x))) p = q; } catch { /* the shown one */ } }
    const s = p[0] + p[1] + p[2];
    if (!(s > 0)) continue;
    out.push({ p: [p[0] / s, p[1] / s, p[2] / s] as P3, y: Y[r.outcome], t: Date.parse(r.utc_date) });
  }
  return out;
}

/** tennis: singles made with the season layer (p_raw saved), finished with a winner; [p1, 0, p2], y 0 / 2 */
export function tennisRows(now = Date.now()): CRow[] {
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT p.p1, p.p_pre, p.scheduled_at, m.winner FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
      WHERE p.scheduled_at >= ? AND p.scheduled_at < ? AND p.made_at <= p.scheduled_at AND p.p_raw IS NOT NULL AND COALESCE(p.cat, '') <> 'itf'
        AND m.status = 'completed' AND m.winner IN (1, 2) AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')`)
      .all(horizon(now), new Date(now).toISOString()) as any[];
  } catch { return []; }
  return rows.map(r => {
    const p = Number(r.p_pre ?? r.p1);
    return { p: [p, 0, 1 - p] as P3, y: r.winner === 1 ? 0 : 2, t: Date.parse(r.scheduled_at) };
  }).filter(r => r.p[0] > 0 && r.p[0] < 1 && Number.isFinite(r.t));
}

const rowsOf = (sport: RecentSport, now: number) => (sport === 'football' ? footballRows(now) : tennisRows(now));
const lastPromotion = (sport: RecentSport, today: string) =>
  ((db.prepare(`SELECT date FROM recent_calib_log WHERE sport = ? AND decision = 'promote' AND date < ? ORDER BY date DESC LIMIT 1`).get(sport, today) as any)?.date as string) || null;

/** one sport: decide, apply (promote / rollback), log */
export async function runRecentCalibration(sport: RecentSport, now = Date.now()): Promise<RecentDecision> {
  const today = new Date(now).toISOString().slice(0, 10);
  const rows = rowsOf(sport, now);
  await yieldLoop();
  const st = readRecentState(sport);
  const d = decideRecent(rows, st?.layer ?? null, st?.since ?? null, lastPromotion(sport, today), now);
  await yieldLoop();
  if (d.decision === 'promote' || d.decision === 'rollback') {
    const next: RecentState = { at: new Date(now).toISOString(), layer: d.decision === 'promote' ? d.live : null, since: today, prev: st ? { layer: st.layer, since: st.since } : null };
    db.prepare(`INSERT OR REPLACE INTO recent_calib (sport, at, state) VALUES (?, ?, ?)`).run(sport, next.at, JSON.stringify(next));
    setRecentCache(sport, next);
    publishState(`calib-recent:${sport}`, next);
    if (sport === 'football') clearPredictionCache();
  }
  const report = { rows: rows.length, windows: d.windows, bands: d.bands, verdict: d.verdict, guard: d.guard, live: d.live ? { from: d.live.from, to: d.live.to, n: d.live.n, knots: d.live.x.length } : null };
  db.prepare(`INSERT OR REPLACE INTO recent_calib_log (date, sport, ran_at, decision, reason, report) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(today, sport, new Date(now).toISOString(), d.decision, d.reason, JSON.stringify(report));
  logger.info(`recent calibration (${sport}): ${d.decision} — ${d.reason}`);
  return d;
}

/** admin: each sport's live layer and the last 14 runs */
export function recentCalibStatus() {
  return Object.fromEntries(RECENT_SPORTS.map(s => [s, {
    live: recentState(s),
    runs: (db.prepare(`SELECT date, ran_at, decision, reason, report FROM recent_calib_log WHERE sport = ? ORDER BY date DESC LIMIT 14`).all(s) as any[])
      .map(r => ({ ...r, report: (() => { try { return JSON.parse(r.report || 'null'); } catch { return null; } })() }))
  }]));
}
/** data health: the last run's line */
export function recentCalibLine(sport: RecentSport): string {
  try {
    const r: any = db.prepare(`SELECT date, decision, reason FROM recent_calib_log WHERE sport = ? ORDER BY date DESC LIMIT 1`).get(sport);
    const st = recentState(sport);
    return `Recent layer: ${st?.layer ? `live since ${st.since} (fit ${st.layer.from} → ${st.layer.to}, ${st.layer.n} games)` : 'none'}${r ? ` · last run ${r.date}: ${r.decision} — ${r.reason}` : ' · not run yet (nightly from 04:30 UTC)'}`;
  } catch { return 'Recent layer: not run yet'; }
}

let running = false;
/** worker: from 04:30 UTC, once a day per sport, in the heavy queue */
export function startRecentCalibScheduler() {
  const tick = async () => {
    const now = new Date();
    if (running || now.getUTCHours() < 4 || (now.getUTCHours() === 4 && now.getUTCMinutes() < 30) || process.env.RECENT_CALIB === 'off') return;
    const today = now.toISOString().slice(0, 10);
    for (const sport of RECENT_SPORTS) {
      const done = db.prepare(`SELECT 1 AS x FROM recent_calib_log WHERE sport = ? AND date = ?`).get(sport, today);
      if (done) continue;
      running = true;
      try { await heavy(`${sport} calibration`, () => timed(`${sport} calibration`, () => runRecentCalibration(sport))); }
      catch (e: any) { logger.warn(`recent calibration (${sport}): ${e?.message || e}`); }
      finally { running = false; }
    }
  };
  const run = () => { tick().catch(e => logger.warn(`recent calibration: ${e?.message || e}`)); };
  setTimeout(run, 6 * 60 * 1000).unref();
  setInterval(run, 10 * 60 * 1000).unref();
}

/** data health (fix254): said vs happened on the predictions made with the live layer (null = no layer: the usual rows) */
export function recentHealthRows(sport: RecentSport, days = 30, now = Date.now()): { n: number; said: number | null; hitRate: number | null; label: string }[] | null {
  const st = recentState(sport);
  if (!st?.layer || !st.since) return null;
  const from = new Date(Math.max(now - days * DAY, Date.parse(`${st.since}T00:00:00Z`))).toISOString();
  let picks: { top: number; hit: boolean }[] = [];
  if (sport === 'football') {
    const all = db.prepare(`SELECT p.match_id, p.model, p.utc_date, p.p_home, p.p_draw, p.p_away, r.outcome FROM predictions p JOIN results r ON r.match_id = p.match_id
      WHERE p.locked = 1 AND p.p_pre IS NOT NULL AND r.outcome IN ('H','D','A') AND p.utc_date >= ?`).all(from) as any[];
    const best = new Map<number, any>();
    for (const r of all) { if (mainRank(r.model, r.utc_date) >= 99) continue; const c = best.get(r.match_id); if (!c || mainRank(r.model, r.utc_date) < mainRank(c.model, c.utc_date)) best.set(r.match_id, r); }
    picks = [...best.values()].map(r => { const p = [r.p_home, r.p_draw, r.p_away].map(Number); const s = p[0] + p[1] + p[2] || 1; const k = p.indexOf(Math.max(...p)); return { top: (100 * p[k]) / s, hit: k === Y[r.outcome] }; });
  } else {
    const rows = db.prepare(`SELECT p.p1, m.winner FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
      WHERE p.scheduled_at >= ? AND p.made_at <= p.scheduled_at AND p.p_pre IS NOT NULL AND COALESCE(p.cat, '') <> 'itf' AND m.status = 'completed' AND m.winner IN (1, 2)
        AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')`).all(from) as any[];
    picks = rows.map(r => ({ top: 100 * Math.max(r.p1, 1 - r.p1), hit: (r.p1 >= 0.5) === (r.winner === 1) }));
  }
  const BANDS = sport === 'football'
    ? [{ lo: 70, hi: 101, label: '70% or more' }, { lo: 60, hi: 70, label: '60–70%' }, { lo: 50, hi: 60, label: '50–60%' }, { lo: 0, hi: 50, label: 'under 50%' }]
    : [{ lo: 50, hi: 60, label: '50–60%' }, { lo: 60, hi: 70, label: '60–70%' }, { lo: 70, hi: 80, label: '70–80%' }, { lo: 80, hi: 101, label: '80% or more' }];
  return BANDS.map(b => {
    const sel = picks.filter(x => x.top >= b.lo && x.top < b.hi);
    const n = sel.length;
    return { n, said: n ? Math.round((sel.reduce((s, x) => s + x.top, 0) / n) * 10) / 10 : null, hitRate: n ? Math.round((1000 * sel.filter(x => x.hit).length) / n) / 10 : null, label: `${b.label} (since the layer, ${st.since})` };
  });
}

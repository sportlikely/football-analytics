/**
 * fix254 — the nightly refit of the recent calibration layers (maths: utils/recentCalib.ts; the live state:
 * services/recentCalibState.ts). Football, tennis and (fix270) basketball, once a day from 04:30 UTC (after the
 * football daily job), in the heavy queue: every settled game of the last HORIZON_DAYS (each pick's chance before this
 * layer + whether it was right), the walk-forward decision on the last 30 days (promote / keep / held / rollback), the
 * state stored and published, every run in recent_calib_log. Data health "Calibration (<sport>)" then counts only
 * predictions made with the live layer and names the layer in use and its fit date.
 * fix270: basketball's rows are the saved p_raw (the model's own chance) of settled games; the "before" it has to beat
 * is what was shown (fix222's season layer). A run made before fix270 doesn't count as today's: the new rule runs once
 * on the first tick after the deploy. fix273: basketball and tennis under the young-sport rule (utils/recentCalib.ts
 * judgeYoung); a run of an older rule again doesn't count as today's.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { heavy, timed, yieldLoop } from './perf';
import { publishState } from './shared';
import { mainRank } from './tracking';
import { MIX_MODEL, FEAT_MODEL } from './featureModel';
import { clearPredictionCache } from './predCache';
import { isPreseason } from './bbModel';
import { decideRecent, HORIZON_DAYS, type CRow, type RecentDecision } from '../utils/recentCalib';
import { type P3 } from '../utils/dailyRules';
import { readRecentState, setRecentCache, recentState, type RecentSport, type RecentState } from './recentCalibState';

const DAY = 86400000;
export const RECENT_SPORTS: RecentSport[] = ['football', 'basketball', 'tennis'];
/** the rule version stored with each run (a run of an older rule doesn't count as today's) */
export const RECENT_RULE = 'fix273';
/** the report's bands (said vs happened, before → after); football's pick can be under 50% */
export const RECENT_EDGES: Record<RecentSport, number[]> = { football: [0, 50, 60, 70], basketball: [50, 60, 70, 80], tennis: [50, 60, 70, 80] };
const horizon = (now: number) => new Date(Math.floor(now / DAY) * DAY - HORIZON_DAYS * DAY).toISOString();
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

/**
 * tennis: singles saved before the start, finished with a winner; [p1, 0, p2], y 0 / 2. The input = the chance before
 * this layer (p_pre; saved before fix254: p1, which no recent layer had touched). fix293: every settled match since the
 * launch (19 Oct) — the rows saved before the season layer's p_raw (25 Oct) count too (Yarin: "all 653").
 */
export function tennisRows(now = Date.now()): CRow[] {
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT p.p1, p.p_pre, p.scheduled_at, m.winner FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
      WHERE p.scheduled_at >= ? AND p.scheduled_at < ? AND p.made_at <= p.scheduled_at AND COALESCE(p.cat, '') <> 'itf'
        AND m.status = 'completed' AND m.winner IN (1, 2) AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')`)
      .all(horizon(now), new Date(now).toISOString()) as any[];
  } catch { return []; }
  return rows.map(r => {
    const p = Number(r.p_pre ?? r.p1);
    return { p: [p, 0, 1 - p] as P3, y: r.winner === 1 ? 0 : 2, t: Date.parse(r.scheduled_at) };
  }).filter(r => r.p[0] > 0 && r.p[0] < 1 && Number.isFinite(r.t));
}

/**
 * fix270, basketball: every settled game with the model's own chance saved (p_raw, since fix222), saved before tip-off,
 * no pre-season; [pHome, 0, pAway], y 0 / 2. `cur` = the chance shown (fix222's season layer) while no recent layer is live.
 */
export function basketballRows(now = Date.now()): CRow[] {
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT p.code, p.kickoff, p.p_home, p.p_raw, g.hs, g.as_ FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
      WHERE p.kickoff >= ? AND p.kickoff < ? AND p.made_at <= p.kickoff AND p.p_raw IS NOT NULL AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND g.hs != g.as_`)
      .all(horizon(now), new Date(now).toISOString()) as any[];
  } catch { return []; }
  const live = !!recentState('basketball')?.layer;
  return rows.filter(r => !isPreseason({ code: r.code, kickoff: r.kickoff })).map(r => {
    const p = Number(r.p_raw), s = Number(r.p_home);
    const row: CRow = { p: [p, 0, 1 - p] as P3, y: r.hs > r.as_ ? 0 : 2, t: Date.parse(r.kickoff) };
    if (!live && s > 0 && s < 1) row.cur = [s, 0, 1 - s];
    return row;
  }).filter(r => r.p[0] > 0 && r.p[0] < 1 && Number.isFinite(r.t));
}

const rowsOf = (sport: RecentSport, now: number) => (sport === 'football' ? footballRows(now) : sport === 'tennis' ? tennisRows(now) : basketballRows(now));
const lastPromotion = (sport: RecentSport, today: string) =>
  ((db.prepare(`SELECT date FROM recent_calib_log WHERE sport = ? AND decision = 'promote' AND date < ? ORDER BY date DESC LIMIT 1`).get(sport, today) as any)?.date as string) || null;

/** one sport: decide, apply (promote / rollback), log */
export async function runRecentCalibration(sport: RecentSport, now = Date.now(), opts: { refit?: boolean } = {}): Promise<RecentDecision> {
  const today = new Date(now).toISOString().slice(0, 10);
  const rows = rowsOf(sport, now);
  await yieldLoop();
  const st = readRecentState(sport);
  // fix273: basketball and tennis (raw chances saved only since 25 Oct) under the young-sport rule while their sample is small
  const d = decideRecent(rows, st?.layer ?? null, st?.since ?? null, lastPromotion(sport, today), now, undefined, undefined, RECENT_EDGES[sport], { young: sport !== 'football', refit: !!opts.refit });
  await yieldLoop();
  if (d.decision === 'promote' || d.decision === 'rollback') {
    const next: RecentState = { at: new Date(now).toISOString(), layer: d.decision === 'promote' ? d.live : null, since: today, prev: st ? { layer: st.layer, since: st.since } : null };
    db.prepare(`INSERT OR REPLACE INTO recent_calib (sport, at, state) VALUES (?, ?, ?)`).run(sport, next.at, JSON.stringify(next));
    setRecentCache(sport, next);
    publishState(`calib-recent:${sport}`, next);
    if (sport === 'football') clearPredictionCache();
    // basketball: the next 7 days' saved predictions through the new layer at once
    if (sport === 'basketball') { const { recordBbPredictions } = await import('./bbModel'); await recordBbPredictions().catch(e => logger.warn(`recent calibration (basketball) re-save: ${e?.message || e}`)); }
  }
  const c = d.candidate;
  const report = {
    v: RECENT_RULE, ...(opts.refit ? { refit: REFIT_RULE } : {}), mode: d.mode, rows: rows.length, fit: d.fit, test: d.test, bands: d.bands, verdict: d.verdict, guard: d.guard, kindWhy: d.kindWhy,
    candidate: c ? { kind: c.kind, from: c.from, to: c.to, n: c.n, knots: c.x.length, a: c.a ?? null, b: c.b ?? null } : null
  };
  db.prepare(`INSERT OR REPLACE INTO recent_calib_log (date, sport, ran_at, decision, reason, report) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(today, sport, new Date(now).toISOString(), d.decision, d.reason, JSON.stringify(report));
  logger.info(`recent calibration (${sport})${opts.refit ? ' [fix293 refit on every settled match]' : ''}: ${d.decision} — ${d.reason} · ${bandsText(d)}`);
  return d;
}

/** the before → after table in one line: "50–60%: said 54.5 → 49.1, happened 44.2 (43)" */
export function bandsText(d: Pick<RecentDecision, 'bands'>): string {
  return d.bands.filter(b => b.n).map(b => `${b.lo === 0 ? `under ${b.hi}` : b.hi >= 100 ? `${b.lo}+` : `${b.lo}–${b.hi}`}%: said ${b.said} → ${b.cal ?? '–'}, happened ${b.happened} (${b.n})`).join(' · ');
}

/** admin: each sport's live layer and the last 14 runs */
export function recentCalibStatus() {
  return Object.fromEntries(RECENT_SPORTS.map(s => [s, {
    live: recentState(s),
    runs: (db.prepare(`SELECT date, ran_at, decision, reason, report FROM recent_calib_log WHERE sport = ? ORDER BY date DESC LIMIT 14`).all(s) as any[])
      .map(r => ({ ...r, report: (() => { try { return JSON.parse(r.report || 'null'); } catch { return null; } })() }))
  }]));
}

const kindName = (k: string | undefined) => (k === 'platt' ? 'Platt' : 'isotonic');
/** fix270: the layer in use and its fit date, in words */
export function layerInUse(sport: RecentSport): string {
  const st = recentState(sport);
  if (st?.layer) return `Layer in use: recent ${kindName(st.layer.kind)} layer, fitted ${st.layer.fitted || st.at.slice(0, 10)} on ${st.layer.n} games (${st.layer.from} → ${st.layer.to}), live since ${st.since}`;
  if (sport === 'football') return 'Layer in use: none (the model’s own chances)';
  try {
    const r = db.prepare(`SELECT at FROM sport_calib WHERE sport = ?`).get(sport) as any;
    return r ? `Layer in use: season layer (fix222), fitted ${String(r.at).slice(0, 10)}` : 'Layer in use: none (the model’s own chances)';
  } catch { return 'Layer in use: none (the model’s own chances)'; }
}
/** data health: the layer in use + the last run's line */
export function recentCalibLine(sport: RecentSport): string {
  try {
    const r: any = db.prepare(`SELECT date, decision, reason, report FROM recent_calib_log WHERE sport = ? ORDER BY date DESC LIMIT 1`).get(sport);
    let table = '';
    try { const rep = JSON.parse(r?.report || 'null'); if (rep?.bands) table = ` · last ${rep.test ? `${rep.test.from} → ${rep.test.to}` : '30 days'} before → after: ${bandsText(rep)}`; } catch { /* old row */ }
    return `${layerInUse(sport)}${r ? ` · last run ${r.date}: ${r.decision} — ${r.reason}${table}` : ' · not run yet (nightly from 04:30 UTC)'}`;
  } catch { return 'Recent layer: not run yet'; }
}

/** fix293: the one-time tennis refit on every settled match (out of fold), run on the first tick after the deploy */
export const REFIT_RULE = 'fix293';
export function refitDue(sport: RecentSport): boolean {
  if (sport !== 'tennis') return false;
  try {
    return !(db.prepare(`SELECT 1 FROM recent_calib_log WHERE sport = ? AND report LIKE ? LIMIT 1`).get(sport, `%"refit":"${REFIT_RULE}"%`));
  } catch { return false; }
}

let running = false;
/** today's run with the current rule done? */
const doneToday = (sport: RecentSport, today: string) => {
  const r = db.prepare(`SELECT report FROM recent_calib_log WHERE sport = ? AND date = ?`).get(sport, today) as any;
  if (!r) return false;
  try { return JSON.parse(r.report || 'null')?.v === RECENT_RULE; } catch { return false; }
};
/** worker: from 04:30 UTC, once a day per sport, in the heavy queue */
export function startRecentCalibScheduler() {
  const tick = async () => {
    const now = new Date();
    if (running || process.env.RECENT_CALIB === 'off') return;
    const early = now.getUTCHours() < 4 || (now.getUTCHours() === 4 && now.getUTCMinutes() < 30);
    const today = now.toISOString().slice(0, 10);
    for (const sport of RECENT_SPORTS) {
      // fix293: tennis's one-time refit does not wait for 04:30
      const refit = refitDue(sport);
      if (!refit && (early || doneToday(sport, today))) continue;
      running = true;
      try { await heavy(`${sport} calibration`, () => timed(`${sport} calibration`, () => runRecentCalibration(sport, Date.now(), { refit }))); }
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
  } else if (sport === 'tennis') {
    const rows = db.prepare(`SELECT p.p1, m.winner FROM tennis_predictions p JOIN tennis_matches m ON m.id = p.match_id
      WHERE p.scheduled_at >= ? AND p.made_at <= p.scheduled_at AND p.p_pre IS NOT NULL AND COALESCE(p.cat, '') <> 'itf' AND m.status = 'completed' AND m.winner IN (1, 2)
        AND COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')`).all(from) as any[];
    picks = rows.map(r => ({ top: 100 * Math.max(r.p1, 1 - r.p1), hit: (r.p1 >= 0.5) === (r.winner === 1) }));
  } else {
    // basketball: the predictions saved after the layer went live (each game is re-saved until tip-off)
    const rows = (db.prepare(`SELECT p.code, p.kickoff, p.p_home, g.hs, g.as_ FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
      WHERE p.kickoff >= ? AND p.made_at >= ? AND p.made_at <= p.kickoff AND p.p_raw IS NOT NULL AND g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND g.hs != g.as_`).all(from, st.at) as any[])
      .filter(r => !isPreseason({ code: r.code, kickoff: r.kickoff }));
    picks = rows.map(r => ({ top: 100 * Math.max(r.p_home, 1 - r.p_home), hit: (r.p_home >= 0.5) === (r.hs > r.as_) }));
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

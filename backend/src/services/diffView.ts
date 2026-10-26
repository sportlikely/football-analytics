/**
 * fix246 (admin only): "Our different view" test — games where our model and the market disagree, and whether our side
 * happened more often than the market said. Nothing here reaches a public route: market prices stay admin-only until
 * Yarin decides on the results. Maths in utils/diffView.ts.
 *
 * Sources (prices with the margin removed; return = 1 unit on our side at the stored price):
 *  - football, past seasons: the walk-forward grid-v3 backtest (backtest_predictions: every prediction only used games
 *    before it) with football-data.co.uk closing prices (early price when no closing one);
 *  - football, live: the saved prediction locked at kick-off (predictions, best model per game as on the record) with
 *    the last price stored before kick-off (The Odds API, Pinnacle or the median line);
 *  - tennis, past: the walk-forward test predictions (tennis_model_store test_preds) with the last pre-start exchange
 *    quote (tennis_market_bench: fair probability only, so the return is at the fair price, no margin);
 *  - tennis, live: the saved prediction (frozen at the start) with the exchange mid ~1 h before the start (tennis_prices);
 *  - basketball, American football: no market prices stored (n/a).
 * Games with a gap of FLAG_GAP+ points are written to diff_view_flags after kick-off from those frozen numbers, by the
 * worker; a row there can't be changed or deleted (triggers) — only its result is filled in.
 */
import { db } from '../db';
import { yieldEvery } from './perf';
import { mainRank } from './tracking';
import { DIVISION_NAMES } from './pastView';
import { BANDS, FLAG_GAP, bandOf, fairProbs, ourSide, summarize, type Band, type Bet, type Summary } from '../utils/diffView';

const MODEL_V3 = 'grid-v3'; // = gridModel.MODEL_V3 (not imported: the model module is heavy)
const IDX3 = { H: 0, D: 1, A: 2 } as Record<string, number>;
const MIN_GROUP = 30; // games a group needs to be ranked best / worst

db.exec(`
  CREATE TABLE IF NOT EXISTS diff_view_flags (
    sport TEXT NOT NULL, game_id INTEGER NOT NULL, league TEXT, kickoff TEXT NOT NULL, home TEXT, away TEXT,
    side TEXT NOT NULL, side_name TEXT, ours REAL NOT NULL, market REAL NOT NULL, gap REAL NOT NULL, price REAL NOT NULL,
    model TEXT, flagged_at TEXT NOT NULL, outcome TEXT, won INTEGER, settled_at TEXT,
    PRIMARY KEY (sport, game_id)
  );
  CREATE TRIGGER IF NOT EXISTS diff_view_flags_frozen BEFORE UPDATE ON diff_view_flags
  WHEN NEW.ours IS NOT OLD.ours OR NEW.market IS NOT OLD.market OR NEW.gap IS NOT OLD.gap OR NEW.price IS NOT OLD.price
    OR NEW.side IS NOT OLD.side OR NEW.kickoff IS NOT OLD.kickoff OR NEW.flagged_at IS NOT OLD.flagged_at OR NEW.game_id IS NOT OLD.game_id OR NEW.sport IS NOT OLD.sport
  BEGIN SELECT RAISE(ABORT, 'diff_view_flags rows are frozen at kick-off'); END;
  CREATE TRIGGER IF NOT EXISTS diff_view_flags_keep BEFORE DELETE ON diff_view_flags
  BEGIN SELECT RAISE(ABORT, 'diff_view_flags rows are kept'); END;
`);

export type Period = 'past' | 'live';
export interface DvRow {
  sport: string; league: string; period: Period; season?: string; date: string; home: string; away: string;
  side: string; sideName: string; ours: number; market: number; gap: number; price: number; won: boolean
}

/** one game → a row (null when there's no disagreement of 3+ points or no usable price) */
export function rowOf(g: {
  sport: string; league: string; period: Period; season?: string; date: string; home: string; away: string;
  model: number[]; prices: (number | null | undefined)[]; outcome: number | null; sides: string[]; names: string[]
}): DvRow | null {
  const market = fairProbs(g.prices);
  if (!market || g.model.some(x => !Number.isFinite(x))) return null;
  const { side, gap } = ourSide(g.model, market);
  if (!bandOf(gap)) return null;
  const raw = g.prices[side] as number;
  const price = raw > 1 ? raw : 1 / market[side]; // a probability quote: the fair price
  return {
    sport: g.sport, league: g.league, period: g.period, season: g.season, date: g.date, home: g.home, away: g.away,
    side: g.sides[side], sideName: g.names[side], ours: g.model[side], market: market[side], gap, price,
    won: g.outcome === side
  };
}

/* ------------------------------------------------------------------ */
/* Sources                                                              */
/* ------------------------------------------------------------------ */

const has = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);

async function footballPast(out: DvRow[]) {
  if (!has('backtest_runs')) return;
  const tick = yieldEvery(2000, 50);
  const runs = db.prepare(`SELECT id, season FROM backtest_runs WHERE model = ? ORDER BY season, grp`).all(MODEL_V3) as any[];
  const q = db.prepare(`SELECT division, date, home, away, outcome, p_home, p_draw, p_away, odds_home, odds_draw, odds_away, early_h, early_d, early_a
    FROM backtest_predictions WHERE run_id = ?`);
  for (const run of runs) {
    for (const r of q.all(run.id) as any[]) {
      const close = [r.odds_home, r.odds_draw, r.odds_away];
      const prices = close.every(x => x > 1) ? close : [r.early_h, r.early_d, r.early_a];
      const x = rowOf({
        sport: 'football', league: DIVISION_NAMES[r.division] || r.division, period: 'past', season: run.season, date: r.date, home: r.home, away: r.away,
        model: [r.p_home / 100, r.p_draw / 100, r.p_away / 100], prices, outcome: IDX3[r.outcome] ?? null,
        sides: ['H', 'D', 'A'], names: [r.home, 'Draw', r.away]
      });
      if (x) out.push(x);
      await tick();
    }
  }
}

/** football saved predictions (best model per game, shadows left out) with a price; finished or upcoming */
function footballSaved(finished: boolean, now: number): any[] {
  const rows = (finished
    ? db.prepare(`SELECT p.match_id, p.model, p.competition_name, p.utc_date, p.home_team, p.away_team, p.p_home, p.p_draw, p.p_away,
        p.odds_home, p.odds_draw, p.odds_away, r.outcome FROM predictions p JOIN results r ON r.match_id = p.match_id
        WHERE p.locked = 1 AND r.outcome IN ('H','D','A')`).all()
    : db.prepare(has('market_odds')
      ? `SELECT p.match_id, p.model, p.competition_name, p.utc_date, p.home_team, p.away_team, p.p_home, p.p_draw, p.p_away,
        COALESCE(mo.home, p.odds_home) AS odds_home, COALESCE(mo.draw, p.odds_draw) AS odds_draw, COALESCE(mo.away, p.odds_away) AS odds_away, NULL AS outcome
        FROM predictions p LEFT JOIN market_odds mo ON mo.match_id = p.match_id
        WHERE p.locked = 0 AND p.utc_date > ? AND p.utc_date <= ?`
      : `SELECT p.match_id, p.model, p.competition_name, p.utc_date, p.home_team, p.away_team, p.p_home, p.p_draw, p.p_away,
        p.odds_home, p.odds_draw, p.odds_away, NULL AS outcome FROM predictions p
        WHERE p.locked = 0 AND p.utc_date > ? AND p.utc_date <= ?`).all(new Date(now).toISOString(), new Date(now + 7 * 86400000).toISOString())) as any[];
  const best = new Map<number, any>();
  const odds = new Map<number, number[]>();
  for (const r of rows) {
    if (r.odds_home > 1 && r.odds_draw > 1 && r.odds_away > 1 && !odds.has(r.match_id)) odds.set(r.match_id, [r.odds_home, r.odds_draw, r.odds_away]);
    if (mainRank(r.model, r.utc_date) >= 99) continue;
    const cur = best.get(r.match_id);
    if (!cur || mainRank(r.model, r.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(r.match_id, r);
  }
  return [...best.values()].filter(r => odds.has(r.match_id)).map(r => ({ ...r, prices: odds.get(r.match_id) }));
}

function footballRow(r: any, period: Period): DvRow | null {
  return rowOf({
    sport: 'football', league: r.competition_name || '?', period, date: r.utc_date, home: r.home_team, away: r.away_team,
    model: [r.p_home / 100, r.p_draw / 100, r.p_away / 100], prices: r.prices, outcome: r.outcome ? IDX3[r.outcome] ?? null : null,
    sides: ['H', 'D', 'A'], names: [r.home_team, 'Draw', r.away_team]
  });
}

const TOUR = (t: string | null) => (t ? (t === 'atp' || t === 'wta' || t === 'itf' ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1)) : '?');

function tennisPast(out: DvRow[]) {
  if (!has('tennis_market_bench') || !has('tennis_model_store')) return;
  const s = db.prepare(`SELECT v FROM tennis_model_store WHERE k = 'test_preds'`).get() as any;
  let preds: Record<string, number[]> = {};
  try { preds = s ? JSON.parse(s.v) : {}; } catch { /* unreadable: no past rows */ }
  const rows = db.prepare(`SELECT b.match_id, b.p1, m.scheduled_at, m.tour, m.p1_name, m.p2_name, m.winner FROM tennis_market_bench b
    JOIN tennis_matches m ON m.id = b.match_id WHERE b.p1 > 0 AND b.p1 < 1 AND m.winner IN (1, 2)`).all() as any[];
  for (const r of rows) {
    const p = preds[String(r.match_id)];
    if (!p) continue;
    const x = rowOf({
      sport: 'tennis', league: TOUR(r.tour), period: 'past', season: String(r.scheduled_at || '').slice(0, 4), date: r.scheduled_at,
      home: r.p1_name, away: r.p2_name, model: [p[0], 1 - p[0]], prices: [r.p1, 1 - r.p1], outcome: r.winner - 1,
      sides: ['1', '2'], names: [r.p1_name, r.p2_name]
    });
    if (x) out.push(x);
  }
}

function tennisSaved(finished: boolean, now: number): any[] {
  if (!has('tennis_prices') || !has('tennis_predictions')) return [];
  return (finished
    ? db.prepare(`SELECT tp.match_id, tp.model, tp.p1 AS mp, pr.p1_mid, pr.p2_mid, m.scheduled_at, m.tour, m.p1_name, m.p2_name, m.winner
        FROM tennis_predictions tp JOIN tennis_prices pr ON pr.match_id = tp.match_id JOIN tennis_matches m ON m.id = tp.match_id
        WHERE m.status = 'completed' AND m.winner IN (1, 2)`).all()
    : db.prepare(`SELECT tp.match_id, tp.model, tp.p1 AS mp, pr.p1_mid, pr.p2_mid, m.scheduled_at, m.tour, m.p1_name, m.p2_name, NULL AS winner
        FROM tennis_predictions tp JOIN tennis_prices pr ON pr.match_id = tp.match_id JOIN tennis_matches m ON m.id = tp.match_id
        WHERE m.status = 'upcoming' AND m.scheduled_at > ?`).all(new Date(now).toISOString())) as any[];
}

function tennisRow(r: any, period: Period): DvRow | null {
  return rowOf({
    sport: 'tennis', league: TOUR(r.tour), period, date: r.scheduled_at, home: r.p1_name, away: r.p2_name,
    model: [r.mp, 1 - r.mp], prices: [r.p1_mid, r.p2_mid], outcome: r.winner ? r.winner - 1 : null,
    sides: ['1', '2'], names: [r.p1_name, r.p2_name]
  });
}

/* ------------------------------------------------------------------ */
/* Frozen at kick-off                                                   */
/* ------------------------------------------------------------------ */

/**
 * Worker job (every 5 min): games with a FLAG_GAP+ gap that started in the last 3 days are written once, from the
 * numbers frozen at kick-off (football: the locked prediction and its last price; tennis: the prediction saved before the
 * start and the price ~1 h before). Never updated after; the result is filled in when it is known.
 */
export function diffViewFreezeTick(now = Date.now()): { flagged: number; settled: number } {
  const from = new Date(now - 3 * 86400000).toISOString(), to = new Date(now).toISOString();
  const ins = db.prepare(`INSERT OR IGNORE INTO diff_view_flags (sport, game_id, league, kickoff, home, away, side, side_name, ours, market, gap, price, model, flagged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let flagged = 0;
  const put = (id: number, model: string, x: DvRow | null) => {
    if (!x || x.gap < FLAG_GAP) return;
    flagged += Number(ins.run(x.sport, id, x.league, x.date, x.home, x.away, x.side, x.sideName, x.ours, x.market, x.gap, x.price, model, to).changes) || 0;
  };
  // football: locked (= kicked off) predictions of the last 3 days, whatever the result
  const fb = db.prepare(`SELECT p.match_id, p.model, p.competition_name, p.utc_date, p.home_team, p.away_team, p.p_home, p.p_draw, p.p_away,
      p.odds_home, p.odds_draw, p.odds_away FROM predictions p WHERE p.locked = 1 AND p.utc_date > ? AND p.utc_date <= ?`).all(from, to) as any[];
  const best = new Map<number, any>(), odds = new Map<number, number[]>();
  for (const r of fb) {
    if (r.odds_home > 1 && r.odds_draw > 1 && r.odds_away > 1 && !odds.has(r.match_id)) odds.set(r.match_id, [r.odds_home, r.odds_draw, r.odds_away]);
    if (mainRank(r.model, r.utc_date) >= 99) continue;
    const cur = best.get(r.match_id);
    if (!cur || mainRank(r.model, r.utc_date) < mainRank(cur.model, cur.utc_date)) best.set(r.match_id, r);
  }
  for (const r of best.values()) if (odds.has(r.match_id)) put(r.match_id, r.model, footballRow({ ...r, prices: odds.get(r.match_id), outcome: null }, 'live'));
  if (has('tennis_prices') && has('tennis_predictions')) {
    const tn = db.prepare(`SELECT tp.match_id, tp.model, tp.p1 AS mp, pr.p1_mid, pr.p2_mid, m.scheduled_at, m.tour, m.p1_name, m.p2_name, NULL AS winner
      FROM tennis_predictions tp JOIN tennis_prices pr ON pr.match_id = tp.match_id JOIN tennis_matches m ON m.id = tp.match_id
      WHERE m.scheduled_at > ? AND m.scheduled_at <= ? AND m.status <> 'upcoming'`).all(from, to) as any[];
    for (const r of tn) put(r.match_id, r.model, tennisRow(r, 'live'));
  }
  // results
  let settled = 0;
  const open = db.prepare(`SELECT sport, game_id, side FROM diff_view_flags WHERE settled_at IS NULL`).all() as any[];
  const set = db.prepare(`UPDATE diff_view_flags SET outcome = ?, won = ?, settled_at = ? WHERE sport = ? AND game_id = ?`);
  for (const f of open) {
    let out: string | null = null, voided = false;
    if (f.sport === 'football') {
      const r = db.prepare(`SELECT outcome FROM results WHERE match_id = ?`).get(f.game_id) as any;
      if (r?.outcome === 'VOID') voided = true; else if (r?.outcome && IDX3[r.outcome] !== undefined) out = r.outcome;
    } else if (f.sport === 'tennis') {
      const m = db.prepare(`SELECT status, winner FROM tennis_matches WHERE id = ?`).get(f.game_id) as any;
      if (m?.status === 'completed' && (m.winner === 1 || m.winner === 2)) out = String(m.winner);
      else if (m && ['void', 'cancelled', 'walkover', 'abandoned'].includes(String(m.status))) voided = true;
    }
    if (out) { set.run(out, out === f.side ? 1 : 0, to, f.sport, f.game_id); settled++; }
    else if (voided) { set.run('VOID', null, to, f.sport, f.game_id); settled++; }
  }
  return { flagged, settled };
}

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

const SPORTS = [
  { sport: 'football', prices: true, note: 'past: grid-v3 walk-forward backtest, football-data.co.uk closing prices · live: saved prediction at kick-off, last price stored before kick-off' },
  { sport: 'basketball', prices: false, note: 'no market prices stored' },
  { sport: 'american-football', prices: false, note: 'no market prices stored' },
  { sport: 'tennis', prices: true, note: 'past: walk-forward test predictions, last pre-start exchange quote (return at the fair price) · live: saved prediction, exchange mid ~1 h before the start' }
];

export interface Group extends Summary { sport: string; period: Period; league: string; band: Band | 'all' }

function groups(rows: DvRow[]): Group[] {
  const by = new Map<string, { k: Omit<Group, keyof Summary>; bets: Bet[] }>();
  const add = (k: Omit<Group, keyof Summary>, b: Bet) => {
    const key = `${k.sport}|${k.period}|${k.league}|${k.band}`;
    (by.get(key) || by.set(key, { k, bets: [] }).get(key)!).bets.push(b);
  };
  for (const r of rows) {
    const band = bandOf(r.gap)!;
    const b: Bet = { won: r.won, price: r.price, ours: r.ours, market: r.market };
    add({ sport: r.sport, period: r.period, league: r.league, band }, b);
    add({ sport: r.sport, period: r.period, league: 'All leagues', band }, b);
    add({ sport: r.sport, period: r.period, league: r.league, band: 'all' }, b);
    add({ sport: r.sport, period: r.period, league: 'All leagues', band: 'all' }, b);
  }
  const order = (b: Band | 'all') => (b === 'all' ? 9 : BANDS.indexOf(b));
  return [...by.values()].map(({ k, bets }) => ({ ...k, ...summarize(bets) }))
    .sort((a, b) => a.sport.localeCompare(b.sport) || a.period.localeCompare(b.period) || (a.league === 'All leagues' ? -1 : b.league === 'All leagues' ? 1 : b.games - a.games) || order(a.band) - order(b.band));
}

let cache: { at: number; data: any } | null = null;

export async function diffViewReport(now = Date.now(), fresh = false) {
  if (!fresh && cache && now - cache.at < 15 * 60 * 1000) return cache.data;
  const rows: DvRow[] = [];
  await footballPast(rows);
  for (const r of footballSaved(true, now)) { const x = footballRow(r, 'live'); if (x) rows.push(x); }
  tennisPast(rows);
  for (const r of tennisSaved(true, now)) { const x = tennisRow(r, 'live'); if (x) rows.push(x); }

  const all = groups(rows);
  const ranked = all.filter(g => g.league !== 'All leagues' && g.band !== 'all' && g.games >= MIN_GROUP && g.roi !== null);
  const liveSince = (sport: string) => rows.filter(r => r.sport === sport && r.period === 'live').reduce<string | null>((m, r) => (!m || r.date < m ? r.date : m), null);

  const upcoming: any[] = [];
  for (const r of footballSaved(false, now)) { const x = footballRow(r, 'live'); if (x && x.gap >= FLAG_GAP) upcoming.push({ ...x, gameId: r.match_id }); }
  for (const r of tennisSaved(false, now)) { const x = tennisRow(r, 'live'); if (x && x.gap >= FLAG_GAP) upcoming.push({ ...x, gameId: r.match_id }); }
  upcoming.sort((a, b) => (a.date < b.date ? -1 : 1));

  const flags = db.prepare(`SELECT * FROM diff_view_flags ORDER BY kickoff DESC`).all() as any[];
  const settledFlags = flags.filter(f => f.won === 0 || f.won === 1);
  const flagSummary = (sport?: string) => summarize(settledFlags.filter(f => !sport || f.sport === sport).map(f => ({ won: f.won === 1, price: f.price, ours: f.ours, market: f.market })));

  const data = {
    builtAt: new Date(now).toISOString(),
    method: 'Market % = 1/price divided by the sum over all outcomes (margin removed). Gap = our % − market % for the side we rate higher than the market by the most. Return = 1 unit on that side at the stored price; 95% interval of the mean return.',
    bands: BANDS, flagGap: FLAG_GAP, minGroup: MIN_GROUP,
    sports: SPORTS.map(s => ({ ...s, liveSince: s.prices ? liveSince(s.sport) : null, games: rows.filter(r => r.sport === s.sport).length })),
    seasons: [...new Set(rows.filter(r => r.period === 'past' && r.season).map(r => `${r.sport} ${r.season}`))].sort(),
    groups: all,
    best: [...ranked].sort((a, b) => (b.roiLo ?? -999) - (a.roiLo ?? -999)).slice(0, 8),
    worst: [...ranked].sort((a, b) => (a.roiHi ?? 999) - (b.roiHi ?? 999)).slice(0, 8),
    upcoming: upcoming.slice(0, 200),
    flagged: {
      total: flags.length, settled: settledFlags.length,
      all: flagSummary(), football: flagSummary('football'), tennis: flagSummary('tennis'),
      recent: flags.slice(0, 100).map(f => ({
        sport: f.sport, gameId: f.game_id, league: f.league, kickoff: f.kickoff, home: f.home, away: f.away, side: f.side, sideName: f.side_name,
        ours: f.ours, market: f.market, gap: f.gap, price: f.price, flaggedAt: f.flagged_at, outcome: f.outcome, won: f.won === null ? null : f.won === 1
      }))
    }
  };
  cache = { at: now, data };
  return data;
}

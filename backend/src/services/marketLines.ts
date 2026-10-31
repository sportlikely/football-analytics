/**
 * fix278: the market lines feed (admin-only data), the anchor fits, the gap report and the data-health rows.
 *
 * Feed — from the API-Sports plans we already have (same key, inside the day's quota, checked before each call):
 *  - basketball (API-Basketball /odds per league + season) and American football (API-American-Football /odds per game):
 *    money line, main spread, main total, team totals, first half where offered;
 *  - football (API-Football /odds per date, every page): 1X2, over / under 1.5 / 2.5 / 3.5, both teams score, Asian
 *    handicap (main line), double chance, draw no bet, half-time result, HT/FT, correct score, corners and cards over /
 *    under, anytime goalscorer;
 *  - tennis: tennis_prices stays; total games and set betting are stored when the feed sends them (tennis.ts).
 *  Games of the next 48 h every 2 h (latest snapshot), plus one closing snapshot ≤ 60 min before the start (taken in
 *  the last 35 minutes, one call per game). Each market stored as its consensus (median over books): market_lines.
 *
 * Anchor fits (daily, worker): per sport × market (× league group with 300+ games), walk-forward on settled games with
 * a closing line (utils/marketLines fitAnchor), kept only when better on unseen games than the model alone and the
 * market alone; the early-season scoring level of basketball / NFL tested the same way. Then the more-predictions
 * gates are re-applied with the market limits (morePredictions.applyMarketGates).
 *
 * Nothing here reaches a public route: /api/admin/market-gap is admin-only (not in OPEN_API) and stripMarket drops the
 * fields everywhere else.
 */
import { db } from '../db';
import logger from '../utils/logger';
import { afGet, afBudgetLeft, afQuota, afConfigured } from './apiFootball';
import { afUsageToday } from './afUsage';
import { afIdOfFd, AF_OFFSET } from './afMatches';
import { bbGet, bbRemainingDay } from './basketball';
import { nflCall, nflBudgetLeft } from './nfl';
import { budgetAllows } from '../utils/liveBox';
import { yieldLoop } from './perf';
import {
  gameConsensus, swapConsensus, fitAnchorGroups, levelTest, levelShift, LEVEL_K, gapStats, closerStats, MARKET_LIMITS, GATE_MARKET_GAMES,
  type MarketSport, type AnchorRow, type LevelRow, type AnchorKind, type Consensus
} from '../utils/marketLines';
import { readFeed, writeFeed, type FeedStatus, storeLines, storeAnchor, bumpMarketVer, anchorFits, levelStates, anchorGroup, marketNumber, oursOfExtras, gateGap, recentGap, overOf, bttsOf, type LevelState } from './marketAnchor';
import { tennisAnchorRows, tennisPriced, clearTennisAnchorCache } from './tennisAnchor';


const DAY = 86400000, HOUR = 3600000;
const FULL_EVERY = 2 * HOUR;
const WINDOW = 48 * HOUR;
/** the closing snapshot is taken in the last 35 minutes before the start (≤ 60 min, Yarin) */
const CLOSE_MS = 35 * 60000;
const FEED_SPORTS: MarketSport[] = ['football', 'basketball', 'nfl'];
const iso = (t: number) => new Date(t).toISOString();
const parse = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/* ---------- feed status (marketAnchor.ts: readFeed / writeFeed) ---------- */

export const feedStatus = () => Object.fromEntries([...FEED_SPORTS, 'tennis'].map(s => [s, readFeed(s)]));

/** quota before each call: football keeps 2,000 of API-Football's day (and the client's own reserve), the others their live reserve */
function quotaOk(sport: MarketSport): boolean {
  if (sport === 'football') { const q = afQuota(); return afConfigured() && !q.blocked && afBudgetLeft() > 2000 && budgetAllows(q.remainingDay, q.limitDay, 1); }
  if (sport === 'basketball') return budgetAllows(bbRemainingDay(), null, 1);
  return nflBudgetLeft() > 300;
}

/* ---------- the games we predict in the next 48 h ---------- */

interface Up { id: number; kickoff: string; league: string; fid?: number; swapped?: boolean; leagueId?: number; season?: string }
function upcoming(sport: MarketSport, now: number, until = now + WINDOW): Up[] {
  if (sport === 'basketball') {
    return (db.prepare(`SELECT game_id AS id, kickoff, code AS league, league_id AS leagueId, season FROM bb_games WHERE kickoff > ? AND kickoff < ? AND (status IS NULL OR status = 'NS')`)
      .all(iso(now), iso(until)) as any[]);
  }
  if (sport === 'nfl') {
    return (db.prepare(`SELECT g.game_id AS id, g.kickoff, CAST(COALESCE(g.league, 1) AS TEXT) AS league FROM nfl_games g JOIN nfl_predictions p ON p.game_id = g.game_id
      WHERE g.kickoff > ? AND g.kickoff < ? AND (g.status IS NULL OR g.status = 'NS')`).all(iso(now), iso(until)) as any[]);
  }
  const rows = db.prepare(`SELECT DISTINCT match_id AS id, utc_date AS kickoff, competition_code AS league FROM predictions WHERE settled = 0 AND utc_date > ? AND utc_date < ?`)
    .all(iso(now).slice(0, 19), iso(until).slice(0, 19)) as any[];
  const out: Up[] = [];
  for (const r of rows) {
    if (r.id >= AF_OFFSET) { out.push({ ...r, fid: r.id - AF_OFFSET, swapped: false }); continue; }
    const tw = afIdOfFd(r.id);
    if (tw) out.push({ ...r, fid: tw.fid, swapped: tw.swapped });
  }
  return out;
}
const hasClosing = db.prepare(`SELECT 1 FROM market_lines WHERE sport = ? AND game_id = ? AND closing = 1 LIMIT 1`);
const latestAt = db.prepare(`SELECT MAX(at) AS at FROM market_lines WHERE sport = ? AND game_id = ? AND closing = 0`);

/** one game's answer → its consensus markets in our terms (swapped twin: the other way round) */
const consensusOf = (sport: MarketSport, item: any, swapped?: boolean): Consensus[] => {
  const list = gameConsensus(sport, item?.bookmakers || []);
  return swapped ? swapConsensus(list) : list;
};
const gameIdOfItem = (sport: MarketSport, item: any): number | null => Number((sport === 'football' ? item?.fixture?.id : item?.game?.id) ?? NaN) || null;

async function callOdds(sport: MarketSport, params: Record<string, string | number>): Promise<any> {
  if (sport === 'football') return afGet('/odds', params);
  if (sport === 'basketball') return bbGet('/odds', params);
  return nflCall('/odds', params);
}

/** the 2-hourly snapshot of one sport (latest lines of every game of the next 48 h) */
async function fullRun(sport: MarketSport, now: number, f: FeedStatus) {
  const games = upcoming(sport, now);
  let calls = 0, stored = 0, lines = 0;
  const markets = new Set<string>();
  const keep = (u: Up | undefined, item: any) => {
    if (!u) return;
    const list = consensusOf(sport, item, u.swapped);
    for (const c of list) markets.add(c.market);
    if (list.length) { lines += storeLines(sport, u.id, u.kickoff, u.league, list, false); stored++; }
  };
  if (sport === 'football') {
    const byFid = new Map<number, Up>(games.filter(g => g.fid).map(g => [g.fid!, g]));
    const dates = [...new Set(games.map(g => g.kickoff.slice(0, 10)))].sort();
    for (const date of dates) {
      for (let page = 1, total = 1; page <= total && page <= 100; page++) {
        if (!quotaOk(sport)) { f.skipped = `quota: stopped at ${date} page ${page}`; break; }
        const j = await callOdds(sport, { date, page });
        calls++;
        total = Number(j?.paging?.total) || 1;
        for (const item of j?.response || []) keep(byFid.get(gameIdOfItem(sport, item) || -1), item);
        await yieldLoop();
      }
    }
  } else if (sport === 'basketball') {
    const byId = new Map(games.map(g => [g.id, g]));
    const pairs = [...new Map(games.map(g => [`${g.leagueId}|${g.season}`, g])).values()];
    for (const g of pairs) {
      if (!quotaOk(sport)) { f.skipped = 'quota: stopped before every league was read'; break; }
      const j = await callOdds(sport, { league: g.leagueId!, season: g.season! });
      calls++;
      for (const item of j?.response || []) keep(byId.get(gameIdOfItem(sport, item) || -1), item);
      await yieldLoop();
    }
  } else {
    for (const g of games) {
      const last = (latestAt.get(sport, g.id) as any)?.at;
      if (last && now - Date.parse(last) < FULL_EVERY - 10 * 60000) continue;
      if (!quotaOk(sport)) { f.skipped = 'quota: stopped before every game was read'; break; }
      const j = await callOdds(sport, { game: g.id });
      calls++;
      for (const item of j?.response || []) keep(g, item);
      await yieldLoop();
    }
  }
  Object.assign(f, { lastFull: iso(now), calls: f.calls + calls, games: stored, lines, markets: [...markets].sort() });
}

/** the closing snapshot: each game starting in the next 35 minutes without one, one call each (at most 60 a tick) */
async function closeRun(sport: MarketSport, now: number, f: FeedStatus) {
  const games = upcoming(sport, now, now + CLOSE_MS).filter(g => !hasClosing.get(sport, g.id)).slice(0, 60);
  let n = 0, calls = 0;
  for (const g of games) {
    if (!quotaOk(sport)) { f.skipped = 'quota: closing lines skipped'; break; }
    const params: Record<string, number> = sport === 'football' ? { fixture: g.fid! } : { game: g.id };
    if (sport === 'football' && !g.fid) continue;
    const j = await callOdds(sport, params);
    calls++;
    const item = (j?.response || [])[0];
    const list = item ? consensusOf(sport, item, g.swapped) : [];
    if (list.length) { storeLines(sport, g.id, g.kickoff, g.league, list, true); n++; }
    await yieldLoop();
  }
  if (games.length) Object.assign(f, { lastClose: iso(now), closing: f.closing + n, calls: f.calls + calls });
}

/**
 * fix278b: handicap rows stored before the sign fix may carry the home favourite as +x (the away side's numbers paired
 * the wrong way): once per database they are removed and every sport's next snapshot is taken at once (closing lines
 * of games already started cannot be read again; the gap report and the fits only use rows stored after this).
 */
function repairHandicapsOnce() {
  const done = db.prepare(`SELECT 1 FROM market_feed WHERE sport = 'fix278b'`).get();
  if (done) return;
  const n = db.prepare(`DELETE FROM market_lines WHERE market IN ('spread', 'ah', 'h1_spread')`).run().changes;
  db.prepare(`DELETE FROM market_anchor WHERE market = 'spread'`).run(); // refitted by the next daily run on the clean rows
  for (const sport of FEED_SPORTS) { const f = readFeed(sport); f.lastFull = null; writeFeed(sport, f); }
  db.prepare(`INSERT OR REPLACE INTO market_feed (sport, json, at) VALUES ('fix278b', ?, ?)`).run(JSON.stringify({ removed: n }), iso(Date.now()));
  bumpMarketVer();
  logger.info(`market lines (fix278b): ${n} handicap rows stored before the sign fix removed, snapshots taken again`);
}

let ticking = false;
/** every 10 minutes (worker): closing snapshots, and the 2-hourly snapshot of each sport when due */
export async function marketTick(now = Date.now()): Promise<Record<string, string>> {
  if (ticking || process.env.MARKET_LINES === 'off') return {};
  ticking = true;
  const out: Record<string, string> = {};
  try {
    repairHandicapsOnce();
    for (const sport of FEED_SPORTS) {
      const f = readFeed(sport);
      f.skipped = null;
      try {
        await closeRun(sport, now, f);
        if (!f.lastFull || now - Date.parse(f.lastFull) >= FULL_EVERY) await fullRun(sport, now, f);
        f.error = null;
      } catch (e: any) {
        f.error = String(e?.message || e).slice(0, 200);
        logger.warn(`market lines ${sport}: ${f.error}`);
      }
      writeFeed(sport, f);
      out[sport] = `${f.games} games, ${f.lines} lines${f.skipped ? ` (${f.skipped})` : ''}${f.error ? ` error ${f.error}` : ''}`;
    }
    const u = afUsageToday() as any;
    logger.info(`market lines: ${Object.entries(out).map(([s, v]) => `${s} ${v}`).join(' · ')} · API-Football today ${JSON.stringify(u?.counts || {})}`);
  } finally { ticking = false; }
  return out;
}

/* ---------- settled rows (the anchor fits and the report) ---------- */

interface Settled { id: number; t: number; league: string; total: number; margin: number; won: number; ours: { total: number; margin: number; p: number }; model: { total: number; margin: number; p: number }; why: string | null }
/** basketball / NFL settled games with our saved prediction (shown and the model's own) */
function settledPoints(sport: 'basketball' | 'nfl', since: number): Settled[] {
  const rows = sport === 'basketball'
    ? db.prepare(`SELECT p.game_id AS id, p.kickoff, p.code AS league, p.p_home, p.margin, p.total, p.p_model, p.margin_raw, p.total_raw, p.level_shift, p.line_why, g.hs, g.as_ AS aws
        FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL AND p.kickoff > ?`).all(iso(since)) as any[]
    : db.prepare(`SELECT p.game_id AS id, p.kickoff, CAST(COALESCE(g.league, 1) AS TEXT) AS league, p.p_home, p.margin, p.total, p.p_model, p.margin_raw, p.total_raw, p.level_shift, p.line_why, g.home_pts AS hs, g.away_pts AS aws
        FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL AND p.kickoff > ?`).all(iso(since)) as any[];
  return rows.map(r => ({
    id: r.id, t: Date.parse(r.kickoff), league: String(r.league), total: r.hs + r.aws, margin: r.hs - r.aws, won: r.hs > r.aws ? 1 : 0,
    ours: { total: r.total, margin: r.margin, p: r.p_home },
    model: { total: r.total_raw != null ? r.total_raw + (r.level_shift || 0) : r.total, margin: r.margin_raw ?? r.margin, p: r.p_model ?? r.p_home },
    why: r.line_why
  }));
}
const closingRows = (sport: MarketSport, market: string, since: number) => new Map((db.prepare(`SELECT game_id, line, prices FROM market_lines WHERE sport = ? AND market = ? AND closing = 1 AND kickoff > ?`)
  .all(sport, market, iso(since)) as any[]).map(r => [r.game_id, { line: r.line as number | null, p: (parse(r.prices)?.p || {}) as Record<string, number> }]));
const mlHome = (p: Record<string, number>) => p.home ?? p.Home ?? null;

/** the anchor rows of one sport × market (settled games with a closing line): model's own number, market, outcome */
function anchorRows(sport: MarketSport, market: string, since: number): { kind: AnchorKind; rows: AnchorRow[] } {
  // fix293: tennis winner — tennis_prices (the closing exchange mid) against the chance saved before the anchor, per tour × surface
  if (sport === 'tennis') return { kind: 'chance', rows: market === 'ml' ? tennisAnchorRows().filter(r => r.t > since) : [] };
  const close = closingRows(sport, market, since);
  if (sport === 'basketball' || sport === 'nfl') {
    const out: AnchorRow[] = [];
    for (const s of settledPoints(sport, since)) {
      const c = close.get(s.id);
      if (!c) continue;
      const group = anchorGroup(sport, s.league);
      if (market === 'total' && c.line != null) out.push({ t: s.t, model: s.model.total, market: c.line, actual: s.total, group });
      if (market === 'spread' && c.line != null) out.push({ t: s.t, model: s.model.margin, market: marketNumber('spread', c.line, null)!, actual: s.margin, group });
      if (market === 'ml' && mlHome(c.p) != null && s.total > 0 && s.margin !== 0) out.push({ t: s.t, model: s.model.p, market: mlHome(c.p)!, actual: s.won, group });
    }
    return { kind: market === 'ml' ? 'chance' : 'line', rows: out };
  }
  // football over / under 2.5: our own chance (before the anchor) from the saved extras, the outcome from the check
  const out: AnchorRow[] = [];
  for (const r of db.prepare(`SELECT game_id, kickoff, json, result FROM prediction_extras WHERE sport = 'football' AND settled = 1 AND kickoff > ?`).all(iso(since)) as any[]) {
    const c = close.get(r.game_id), x = parse(r.json), res = parse(r.result);
    if (!c || !x || c.p?.over == null || !Number.isFinite(res?.actual?.goals)) continue;
    const model = x.info?.anchor?.ou25 ?? overOf(x, 2.5);
    if (model == null) continue;
    out.push({ t: Date.parse(r.kickoff), model, market: c.p.over, actual: res.actual.goals > 2.5 ? 1 : 0, group: 'all' });
  }
  return { kind: 'chance', rows: out };
}

/** the season's scoring level per league (basketball / NFL): walk-forward test over every stored season, shifts of the current one */
function levelFit(sport: 'basketball' | 'nfl'): LevelState {
  const k = LEVEL_K[sport];
  const rows = (sport === 'basketball'
    ? db.prepare(`SELECT p.kickoff, p.code AS league, g.season, COALESCE(p.total_raw, p.total) AS predicted, g.hs + g.as_ AS actual FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id
        WHERE g.status IN ('FT','AOT') AND g.hs IS NOT NULL`).all()
    : db.prepare(`SELECT p.kickoff, CAST(COALESCE(g.league, 1) AS TEXT) AS league, CAST(p.season AS TEXT) AS season, COALESCE(p.total_raw, p.total) AS predicted, g.home_pts + g.away_pts AS actual
        FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE g.status IN ('FT','AOT') AND g.home_pts IS NOT NULL`).all()) as any[];
  const lr: LevelRow[] = rows.map(r => ({ t: Date.parse(r.kickoff), league: String(r.league), season: String(r.season), predicted: r.predicted, actual: r.actual }));
  // college levels per league id 2 need more games (60): one k per sport keeps it simple; NFL k 32 also used for college
  const test = levelTest(lr, k);
  const cur = new Map<string, string>();
  for (const r of [...lr].sort((a, b) => a.t - b.t)) cur.set(r.league, r.season);
  const shifts: LevelState['shifts'] = {};
  for (const [league, season] of cur) {
    const rs = lr.filter(r => r.league === league && r.season === season);
    shifts[league] = { season, n: rs.length, shift: Math.round(levelShift(rs, k) * 10) / 10 };
  }
  return { test, shifts, k };
}

const ANCHOR_MARKETS: Record<MarketSport, string[]> = { basketball: ['total', 'spread', 'ml'], nfl: ['total', 'spread', 'ml'], football: ['ou2.5'], tennis: ['ml'] };
let lastFit: { at: string; out: Record<string, any> } | null = null;
/** daily (worker, heavy queue): the anchor fits of every sport × market, the scoring levels, then the gates again */
export async function runMarketFits(now = Date.now()): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const since = now - 400 * DAY;
  for (const sport of ['basketball', 'nfl', 'football', 'tennis'] as MarketSport[]) {
    for (const market of ANCHOR_MARKETS[sport]) {
      const { kind, rows } = anchorRows(sport, market, since);
      const fits = fitAnchorGroups(kind, rows);
      storeAnchor(sport, market, fits);
      out[`${sport} ${market}`] = Object.fromEntries(Object.entries(fits).map(([g, f]) => [g, `${f.kept ? `w ${f.w}` : 'model only'} (${f.why})`]));
      await yieldLoop();
    }
    if (sport === 'tennis') clearTennisAnchorCache();
    if (sport === 'basketball' || sport === 'nfl') {
      const lv = levelFit(sport);
      storeAnchor(sport, 'level', lv);
      out[`${sport} level`] = lv.test.why;
    }
  }
  try {
    const { applyMarketGates } = await import('./morePredictions');
    out.gates = applyMarketGates();
  } catch (e: any) { out.gates = `failed: ${e?.message || e}`; }
  lastFit = { at: iso(now), out };
  logger.info(`market anchor: ${JSON.stringify(out)}`);
  return out;
}
export const lastMarketFit = () => lastFit;
export function marketFitDue(now = Date.now()): boolean {
  const r = db.prepare(`SELECT MAX(at) AS at FROM market_anchor`).get() as any;
  // fix293: the tennis winner fit runs on the first look after the deploy (then daily with the others)
  const tn = db.prepare(`SELECT 1 FROM market_anchor WHERE sport = 'tennis' AND market = 'ml'`).get();
  return !r?.at || !tn || now - Date.parse(r.at) > 20 * HOUR;
}

/* ---------- the gap report (Admin → Predictions & models → "Our lines vs the market") ---------- */

const REPORT_MARKETS: Record<MarketSport, { market: string; kind: AnchorKind; label: string }[]> = {
  basketball: [{ market: 'total', kind: 'line', label: 'Total points' }, { market: 'spread', kind: 'line', label: 'Spread (home margin)' }, { market: 'ml', kind: 'chance', label: 'Winner (home %)' }],
  nfl: [{ market: 'total', kind: 'line', label: 'Total points' }, { market: 'spread', kind: 'line', label: 'Spread (home margin)' }, { market: 'ml', kind: 'chance', label: 'Winner (home %)' }],
  football: [{ market: 'ou1.5', kind: 'chance', label: 'Over 1.5 goals %' }, { market: 'ou2.5', kind: 'chance', label: 'Over 2.5 goals %' }, { market: 'ou3.5', kind: 'chance', label: 'Over 3.5 goals %' }, { market: 'btts', kind: 'chance', label: 'Both teams score %' }, { market: 'ah', kind: 'line', label: 'Asian handicap (home goal margin)' }],
  tennis: [{ market: 'ml', kind: 'chance', label: 'Winner (player 1 %)' }, { market: 'total_games', kind: 'line', label: 'Total games' }]
};
interface Pair { id: number; league: string; ours: number; market: number; actual: number | null; why?: string | null; kickoff: string }

/** our number of a game for a report market: basketball / NFL the saved prediction (shown), football / tennis the saved extras */
function pairs(sport: MarketSport, market: string, from: number, to: number, settled: boolean): Pair[] {
  const out: Pair[] = [];
  // fix293: tennis winner — the saved chance against tennis_prices (the closing exchange mid), not market_lines
  if (sport === 'tennis' && market === 'ml') {
    return tennisPriced(from, to, settled).map(r => ({ id: r.id, league: r.seg, ours: r.ours * 100, market: r.market * 100, actual: r.won == null ? null : r.won * 100, kickoff: r.kickoff,
      why: Math.abs(r.ours - r.model) > 0.0005 ? `model ${Math.round(r.model * 1000) / 10}% before the anchor` : null }));
  }
  const rows = db.prepare(`SELECT game_id, line, prices, closing, kickoff, league FROM market_lines WHERE sport = ? AND market = ? AND kickoff > ? AND kickoff < ? ORDER BY closing`)
    .all(sport, market, iso(from), iso(to)) as any[];
  const mk = new Map<number, any>();
  for (const r of rows) if (!settled || r.closing) mk.set(r.game_id, r); // settled: the closing line only; upcoming: closing over latest
  if (!mk.size) return out;
  const ids = [...mk.keys()];
  const chunk = (f: (part: number[]) => void) => { for (let i = 0; i < ids.length; i += 400) f(ids.slice(i, i + 400)); };
  if (sport === 'basketball' || sport === 'nfl') {
    chunk(part => {
      const q = part.map(() => '?').join(',');
      const sql = sport === 'basketball'
        ? `SELECT p.game_id AS id, p.kickoff, p.code AS league, p.p_home, p.margin, p.total, p.line_why, g.status, g.hs, g.as_ AS aws FROM bb_predictions p JOIN bb_games g ON g.game_id = p.game_id WHERE p.game_id IN (${q})`
        : `SELECT p.game_id AS id, p.kickoff, CAST(COALESCE(g.league, 1) AS TEXT) AS league, p.p_home, p.margin, p.total, p.line_why, p.why, g.status, g.home_pts AS hs, g.away_pts AS aws FROM nfl_predictions p JOIN nfl_games g ON g.game_id = p.game_id WHERE p.game_id IN (${q})`;
      for (const r of db.prepare(sql).all(...part) as any[]) {
        const done = ['FT', 'AOT'].includes(r.status) && r.hs != null;
        if (settled !== done) continue;
        const m = mk.get(r.id), p = parse(m.prices)?.p || {};
        const ours = market === 'total' ? r.total : market === 'spread' ? r.margin : r.p_home * 100;
        const mkt = market === 'ml' ? (mlHome(p) != null ? mlHome(p)! * 100 : null) : marketNumber(market, m.line, p);
        if (mkt == null) continue;
        const actual = done ? (market === 'total' ? r.hs + r.aws : market === 'spread' ? r.hs - r.aws : r.hs > r.aws ? 100 : 0) : null;
        out.push({ id: r.id, league: String(r.league), ours, market: mkt, actual, why: whyText(sport, r), kickoff: r.kickoff });
      }
    });
    return out;
  }
  chunk(part => {
    const q = part.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT game_id, kickoff, json, result, settled FROM prediction_extras WHERE sport = ? AND game_id IN (${q})`).all(sport, ...part) as any[]) {
      if (settled !== (r.settled === 1)) continue;
      const x = parse(r.json), m = mk.get(r.game_id);
      const ours = market.startsWith('ou') ? (overOf(x, Number(market.slice(2))) ?? NaN) * 100 : market === 'btts' ? (bttsOf(x) ?? NaN) * 100
        : market === 'ah' ? (Array.isArray(x?.info?.xg) ? x.info.xg[0] - x.info.xg[1] : NaN) : oursOfExtras(sport, market, x);
      const mkt = marketNumber(market, m.line, parse(m.prices)?.p || null);
      if (ours == null || !Number.isFinite(ours) || mkt == null) continue;
      const res = parse(r.result)?.actual;
      const actual = !res ? null : market === 'ah' ? (Number.isFinite(res.homeGoals) && Number.isFinite(res.awayGoals) ? res.homeGoals - res.awayGoals : null) : market.startsWith('ou') ? (res.goals > Number(market.slice(2)) ? 100 : 0) : market === 'btts' ? (res.cleanHome === 'no' && res.cleanAway === 'no' ? 100 : 0) : Number.isFinite(res.games) ? res.games : null;
      const xg = x?.info?.xg;
      out.push({ id: r.game_id, league: String(m.league || ''), ours, market: mkt, actual, kickoff: r.kickoff, why: Array.isArray(xg) ? `expected goals ${xg[0]} – ${xg[1]}${x.info?.anchored ? ' · anchored' : ''}` : null });
    }
  });
  return out;
}
/** the reasons the model gives for a basketball / NFL line (stored with the prediction) */
function whyText(sport: MarketSport, r: any): string | null {
  const lw = parse(r.line_why);
  const parts: string[] = [];
  if (lw) {
    if (lw.raw != null) parts.push(`model total ${lw.raw}`);
    if (lw.shift) parts.push(`season scoring level ${lw.shift > 0 ? '+' : ''}${lw.shift}`);
    if (lw.anchored) parts.push('anchored to the market');
    if (Array.isArray(lw.notes)) parts.push(...lw.notes);
  }
  if (sport === 'nfl') {
    const w = parse(r.why);
    if (w) {
      parts.push(`Elo gap ${Math.round(w.eloGap)}`, `home field ${w.neutral ? 'neutral' : Math.round(w.homeField * 10) / 10}`);
      if (w.qb?.[0]?.out || w.qb?.[1]?.out) parts.push('starting QB out');
      if (w.eff) parts.push(`yards per play ${w.eff.yppHome} / ${w.eff.yppAway}`);
    }
  }
  return parts.length ? parts.join(' · ') : null;
}
const r2 = (x: number) => Math.round(x * 100) / 100;
function summary(kind: AnchorKind, ps: Pair[]) {
  const g = gapStats(ps);
  const settled = ps.filter(p => p.actual != null);
  const c = closerStats(kind, settled.map(p => ({ ours: kind === 'chance' ? p.ours / 100 : p.ours, market: kind === 'chance' ? p.market / 100 : p.market, actual: kind === 'chance' ? (p.actual! > 50 ? 1 : 0) : p.actual! })));
  return { ...g, closer: c };
}
function byLeague(kind: AnchorKind, ps: Pair[]) {
  const by = new Map<string, Pair[]>();
  for (const p of ps) { const l = by.get(p.league) || []; l.push(p); by.set(p.league, l); }
  return [...by].map(([league, l]) => ({ league, ...summary(kind, l) })).sort((a, b) => b.n - a.n).slice(0, 40);
}
let reportCache: { at: number; v: any } | null = null;
/** the gap report of every sport × market: last 30 / 90 days (settled: vs the closing line; upcoming: vs the latest), per league, the 10 biggest gaps today */
export function marketGapReport(now = Date.now(), fresh = false) {
  if (!fresh && reportCache && now - reportCache.at < 10 * 60000) return reportCache.v;
  const sports: any[] = [];
  for (const sport of ['basketball', 'nfl', 'football', 'tennis'] as MarketSport[]) {
    const markets: any[] = [];
    const today: { market: string; label: string; id: number; league: string; kickoff: string; ours: number; market_: number; gap: number; why: string | null; score: number }[] = [];
    for (const m of REPORT_MARKETS[sport]) {
      const windows: Record<string, any> = {};
      for (const days of [30, 90]) {
        const s = pairs(sport, m.market, now - days * DAY, now, true), u = pairs(sport, m.market, now, now + WINDOW, false);
        windows[`d${days}`] = { settled: summary(m.kind, s), upcoming: gapStats(u), leagues: byLeague(m.kind, s) };
      }
      const lim = Object.values(MARKET_LIMITS[sport] || {}).find(l => l.market === m.market) || null;
      const fit = anchorFits()[sport]?.[m.market] || null;
      const gate = lim ? gateGap(sport, m.market, 90, now) : null;
      markets.push({ market: m.market, label: m.label, kind: m.kind, windows, limit: lim ? { limit: lim.limit, unit: lim.unit, label: lim.label } : null, gate, anchor: fit });
      for (const p of pairs(sport, m.market, now, now + DAY, false)) {
        const gap = r2(p.ours - p.market);
        today.push({ market: m.market, label: m.label, id: p.id, league: p.league, kickoff: p.kickoff, ours: r2(p.ours), market_: r2(p.market), gap, why: p.why || null, score: Math.abs(gap) / (lim?.limit || (m.kind === 'chance' ? 5 : 3)) });
      }
    }
    const biggest = today.sort((a, b) => b.score - a.score).slice(0, 10).map(({ score: _s, market_, ...x }) => ({ ...x, marketLine: market_ }));
    sports.push({ sport, markets, biggest, feed: readFeed(sport), level: (levelStates() as any)[sport] || null });
  }
  const v = { builtAt: iso(now), rules: { gateGames: GATE_MARKET_GAMES, limits: MARKET_LIMITS }, sports, lastFit };
  reportCache = { at: now, v };
  return v;
}

/** the report as plain text for Copy for Claude (admin only) */
export function marketGapText(rep = marketGapReport()): string {
  const lines: string[] = [`Our lines vs the market (built ${rep.builtAt.slice(0, 16)} UTC). Gap = ours − market (below 0 = we are lower).`];
  for (const s of rep.sports) {
    lines.push('', `## ${s.sport} — feed: last snapshot ${s.feed.lastFull?.slice(0, 16) || 'never'}, ${s.feed.games} games, ${s.feed.lines} lines${s.feed.error ? `, error ${s.feed.error}` : ''}`);
    if (s.level) lines.push(`Season scoring level: ${s.level.test.why}; shifts ${Object.entries(s.level.shifts).map(([l, v]: any) => `${l} ${v.shift} (${v.n} games)`).join(', ')}`);
    for (const m of s.markets) {
      const w = m.windows.d30, w9 = m.windows.d90;
      const cl = w9.settled.closer;
      lines.push(`- ${m.label}: 30 days ${w.settled.n} settled, mean gap ${w.settled.meanGap ?? '—'}, median |gap| ${w.settled.medianAbs ?? '—'}; 90 days ${w9.settled.n} settled, mean ${w9.settled.meanGap ?? '—'}, median |gap| ${w9.settled.medianAbs ?? '—'}; upcoming ${w.upcoming.n} (mean ${w.upcoming.meanGap ?? '—'})`
        + (cl ? (cl.oursMae != null ? `; closer to the result: ours ${cl.oursMae} vs market ${cl.marketMae} mean error` : `; log loss ours ${cl.oursLogLoss} vs market ${cl.marketLogLoss}, Brier ${cl.oursBrier} vs ${cl.marketBrier}`) : '')
        + (m.limit ? `; gate limit ${m.limit.limit} (${m.gate.n} of ${rep.rules.gateGames} games, median |gap| ${m.gate.medianAbs ?? '—'})` : '')
        + (m.anchor ? `; anchor ${Object.entries(m.anchor).map(([g, f]: any) => `${g}: ${f.kept ? `w ${f.w}` : 'model only'}`).join(', ')}` : ''));
    }
    if (s.biggest.length) lines.push('Biggest gaps today:', ...s.biggest.map((b: any) => `  ${b.label} game ${b.id} (${b.league}): ours ${b.ours} vs market ${b.marketLine} (gap ${b.gap})${b.why ? ` — ${b.why}` : ''}`));
  }
  return lines.join('\n').slice(0, 11500);
}

/* ---------- data health: "Close to the market (<sport>)" ---------- */

const SPORT_NAME: Record<MarketSport, string> = { football: 'football', basketball: 'basketball', nfl: 'American football', tennis: 'tennis' };
export function marketHealth(publicOf: (sport: MarketSport, output: string) => boolean, now = Date.now()) {
  const rows: { id: string; label: string; level: 'ok' | 'warn' | 'fail'; detail: string; items: string[] }[] = [];
  for (const sport of ['football', 'basketball', 'nfl', 'tennis'] as MarketSport[]) {
    const limits = MARKET_LIMITS[sport];
    const markets = [...new Set(Object.values(limits).map(l => l.market))];
    let level: 'ok' | 'warn' | 'fail' = 'ok';
    const items: string[] = [];
    for (const market of markets) {
      const outs = Object.entries(limits).filter(([, l]) => l.market === market);
      const lim = outs[0][1];
      const all = gateGap(sport, market, 90, now), week = recentGap(sport, market, now);
      const pub = outs.filter(([o]) => publicOf(sport, o)).map(([o]) => o);
      if (!all.feed) { items.push(`${lim.label}: not in the feed — judged on calibration only`); continue; }
      if (all.n < GATE_MARKET_GAMES) { if (level === 'ok') level = 'warn'; items.push(`${lim.label}: collecting market lines (${all.n} of ${GATE_MARKET_GAMES} settled games) — admin-only until then`); continue; }
      const over = week.n >= 20 && week.medianAbs != null && week.medianAbs > lim.limit;
      if (over && pub.length) level = 'fail';
      items.push(`${lim.label}: last 7 days median |gap| ${week.medianAbs ?? '—'} on ${week.n} games (limit ${lim.limit}${lim.unit === 'chance' ? ' points of chance' : ' points'}), 90 days ${all.medianAbs} on ${all.n}; public: ${pub.join(', ') || 'none'}${over && pub.length ? ' — over the limit' : ''}`);
    }
    // fix293: tennis winner chance vs the closing exchange price (tennis_prices) and the anchor's fit
    if (sport === 'tennis') {
      const win = tennisWinnerHealth(now);
      items.unshift(win.item);
      if (win.warn && level === 'ok') level = 'warn';
    }
    const f = readFeed(sport);
    rows.push({
      id: `market-close-${sport}`, label: `Close to the market (${SPORT_NAME[sport]})`, level,
      detail: `${level === 'fail' ? 'A public output is over its limit to the market (last 7 days)' : level === 'warn' ? 'Collecting market lines' : 'Every public output within its limit'} · feed: ${sport === 'tennis' ? `markets seen ${(f.markets || []).join(', ') || 'none yet'}` : `last snapshot ${f.lastFull ? `${f.lastFull.slice(11, 16)} UTC` : 'none yet'}, ${f.games} games${f.error ? `, error ${f.error}` : ''}`}`,
      items
    });
  }
  return rows;
}

/** fix293: the tennis winner line of "Close to the market (tennis)": settled matches with a price, the gap, the anchor */
export function tennisWinnerHealth(now = Date.now()): { item: string; warn: boolean } {
  const all = tennisPriced(now - 90 * DAY, now, true), week = all.filter(r => r.t > now - 7 * DAY);
  const up = tennisPriced(now, now + WINDOW, false);
  const fit = (anchorFits() as any).tennis?.ml as Record<string, any> | undefined;
  const g = gapStats(all.map(r => ({ ours: r.ours * 100, market: r.market * 100 }))), gw = gapStats(week.map(r => ({ ours: r.ours * 100, market: r.market * 100 })));
  const c = closerStats('chance', all.map(r => ({ ours: r.ours, market: r.market, actual: r.won! })));
  const anchor = !fit ? 'anchor not fitted yet (daily job)' : Object.entries(fit).map(([k, f]: any) => `${k === 'all' ? 'all tours' : k}: ${f.kept ? `weight ${f.w}` : 'model only'} (${f.n} matches)`).join(', ');
  if (!all.length) return { item: `winner chance: no settled match with a closing price yet (tennis_prices; ${up.length} upcoming priced) — ${anchor}`, warn: true };
  return {
    item: `winner chance: ${all.length} settled matches with a closing price in 90 days (last 7 days ${gw.n}, median |gap| ${gw.medianAbs ?? '—'} points of chance), median |gap| ${g.medianAbs} · log loss ours ${c?.oursLogLoss} vs market ${c?.marketLogLoss} · ${anchor}`,
    warn: all.length < 300
  };
}

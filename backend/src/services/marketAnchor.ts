/**
 * fix278: market lines (admin-only data) and the market anchor, read side. No provider calls here and no service
 * imports (the models import this file): the feed that fills `market_lines` is services/marketLines.ts.
 *
 * Tables:
 *  - market_lines (sport, game_id, market, closing): the consensus of a market (median over books) — the latest
 *    snapshot (closing 0, every 2 h for games of the next 48 h) and the closing one (closing 1, ≤ 60 min before the
 *    start). line = the main line (totals: the total; spreads: the home side's handicap), prices = {prices, p}.
 *  - market_anchor (sport, market): the walk-forward anchor fits per league group, and 'level' (the early-season
 *    scoring level per league, basketball / NFL).
 * The shown line / chance = blend of the model and the market's latest line with the fitted weight; without a market
 * line (or a weight of 0) the model alone. The market is never shown, only used inside (payloads say `anchored`).
 */
import { db } from '../db';
import type { Consensus, AnchorFit, LevelTest, MarketSport } from '../utils/marketLines';
import { anchorWeightOf, blendLine, blendChance, marketMargin, marketTotal, median, gapStats } from '../utils/marketLines';
import { groupOf as bbGroupOf } from '../utils/bbGridMath';
import type { Extras } from '../utils/moreMath';

db.exec(`
  CREATE TABLE IF NOT EXISTS market_lines (
    sport TEXT NOT NULL, game_id INTEGER NOT NULL, market TEXT NOT NULL, closing INTEGER NOT NULL DEFAULT 0,
    line REAL, prices TEXT NOT NULL, books INTEGER NOT NULL, at TEXT NOT NULL, kickoff TEXT, league TEXT,
    PRIMARY KEY (sport, game_id, market, closing)
  );
  CREATE INDEX IF NOT EXISTS idx_market_lines_kickoff ON market_lines(sport, kickoff);
  CREATE TABLE IF NOT EXISTS market_anchor (sport TEXT NOT NULL, market TEXT NOT NULL, json TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (sport, market));
  CREATE TABLE IF NOT EXISTS market_feed (sport TEXT PRIMARY KEY, json TEXT NOT NULL, at TEXT NOT NULL);
`);

let ver = 0;
/** changes whenever market lines or the anchor settings are stored (prediction caches key on it) */
export const marketVer = () => ver;
export const bumpMarketVer = () => { ver++; anchorCache = null; lineCache.clear(); };

const up = db.prepare(`INSERT OR REPLACE INTO market_lines (sport, game_id, market, closing, line, prices, books, at, kickoff, league) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
/** one game's consensus markets (one snapshot: latest or closing) */
export function storeLines(sport: MarketSport, gameId: number, kickoff: string | null, league: string | null, list: Consensus[], closing: boolean, at = new Date().toISOString()): number {
  if (!list.length) return 0;
  db.exec('BEGIN');
  try {
    for (const c of list) up.run(sport, gameId, c.market, closing ? 1 : 0, c.line, JSON.stringify({ prices: c.prices, p: c.p }), c.books, at, kickoff, league);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  bumpMarketVer();
  return list.length;
}

/* ---------- the feed's status per sport (services/marketLines.ts writes it; tennis.ts for its markets) ---------- */

export interface FeedStatus { lastFull: string | null; lastClose: string | null; calls: number; games: number; lines: number; closing: number; skipped: string | null; error: string | null; markets?: string[] }
export function readFeed(sport: string): FeedStatus {
  let v: any = null;
  try { v = JSON.parse((db.prepare(`SELECT json FROM market_feed WHERE sport = ?`).get(sport) as any)?.json || 'null'); } catch { v = null; }
  return v || { lastFull: null, lastClose: null, calls: 0, games: 0, lines: 0, closing: 0, skipped: null, error: null };
}
export function writeFeed(sport: string, f: FeedStatus) { db.prepare(`INSERT OR REPLACE INTO market_feed (sport, json, at) VALUES (?, ?, ?)`).run(sport, JSON.stringify(f), new Date().toISOString()); }
/** tennis.ts: a match's markets beyond the match winner (total games, set betting) when the feed sends them */
export function storeTennisMarkets(matchId: number, kickoff: string | null, tour: string | null, list: Consensus[], names: string[], closing: boolean) {
  const f = readFeed('tennis');
  f.markets = [...new Set([...(f.markets || []), ...names])].slice(0, 40);
  if (list.length) { storeLines('tennis', matchId, kickoff, tour, list, closing); f.games++; f.lines += list.length; if (closing) f.closing++; }
  f.lastFull = new Date().toISOString();
  writeFeed('tennis', f);
}

export type StoredLine = Consensus & { closing: boolean; at: string };
const readGame = db.prepare(`SELECT market, closing, line, prices, books, at FROM market_lines WHERE sport = ? AND game_id = ?`);
const lineCache = new Map<string, Map<string, StoredLine>>();
/** a game's markets: the closing snapshot when there is one, else the latest */
export function marketFor(sport: MarketSport, gameId: number): Map<string, StoredLine> {
  const key = `${sport}|${gameId}`;
  const c = lineCache.get(key);
  if (c) return c;
  const out = new Map<string, StoredLine>();
  for (const r of readGame.all(sport, gameId) as any[]) {
    const cur = out.get(r.market);
    if (cur && cur.closing && !r.closing) continue;
    let pr: any = {};
    try { pr = JSON.parse(r.prices); } catch { pr = {}; }
    out.set(r.market, { market: r.market, line: r.line, prices: pr.prices || {}, p: pr.p || {}, books: r.books, closing: !!r.closing, at: r.at });
  }
  if (lineCache.size > 5000) lineCache.delete(lineCache.keys().next().value as string);
  lineCache.set(key, out);
  return out;
}

/* ---------- the anchor settings ---------- */

export interface LevelState { test: LevelTest; shifts: Record<string, { season: string; n: number; shift: number }>; k: number }
interface AnchorState { fits: Record<string, Record<string, Record<string, AnchorFit>>>; level: Record<string, LevelState>; at: number }
let anchorCache: AnchorState | null = null;
function anchorState(): AnchorState {
  if (anchorCache && Date.now() - anchorCache.at < 5 * 60 * 1000) return anchorCache;
  const fits: AnchorState['fits'] = {}, level: AnchorState['level'] = {};
  for (const r of db.prepare(`SELECT sport, market, json FROM market_anchor`).all() as any[]) {
    let v: any = null;
    try { v = JSON.parse(r.json); } catch { v = null; }
    if (!v) continue;
    if (r.market === 'level') level[r.sport] = v;
    else (fits[r.sport] ||= {})[r.market] = v;
  }
  anchorCache = { fits, level, at: Date.now() };
  return anchorCache;
}
export function storeAnchor(sport: MarketSport, market: string, v: unknown) {
  db.prepare(`INSERT OR REPLACE INTO market_anchor (sport, market, json, at) VALUES (?, ?, ?, ?)`).run(sport, market, JSON.stringify(v), new Date().toISOString());
  bumpMarketVer();
}
export const anchorFits = () => anchorState().fits;
export const levelStates = () => anchorState().level;

/** the league group an anchor weight may have of its own (300+ games) */
export function anchorGroup(sport: MarketSport, league: string | number | null | undefined): string {
  if (sport === 'basketball') return bbGroupOf(String(league || ''));
  if (sport === 'nfl') return String(league) === '2' ? 'College' : 'NFL';
  return 'all';
}
export const weightFor = (sport: MarketSport, market: string, league: string | number | null | undefined) =>
  anchorWeightOf(anchorState().fits[sport]?.[market], anchorGroup(sport, league));

/** the early-season scoring shift of a league's current season (0 when the test did not keep it) */
export function levelShiftFor(sport: 'basketball' | 'nfl', league: string | number | null | undefined): number {
  const s = anchorState().level[sport];
  if (!s || !s.test?.kept) return 0;
  return s.shifts[String(league)]?.shift || 0;
}

/* ---------- applying it ---------- */

export interface PointsBase { pHome: number; margin: number; total: number }
export interface PointsAnchored extends PointsBase {
  home: number; away: number; anchored: boolean
  /** the model's own numbers (before the level shift and the anchor) and the shift */
  raw: PointsBase; shift: number
}
const r1 = (x: number) => Math.round(x * 10) / 10;
/**
 * basketball / NFL: total = model + the season's level shift, then blended with the market's total; margin blended
 * with the market's spread; the win chance with the market's money line (log-odds). Each with its own walk-forward
 * weight (0 until a fit is kept). home / away points from the shown total and margin.
 */
export function anchorPoints(sport: 'basketball' | 'nfl', gameId: number, league: string | number | null | undefined, base: PointsBase): PointsAnchored {
  const shift = levelShiftFor(sport, league);
  const m = marketFor(sport, gameId);
  const wT = weightFor(sport, 'total', league), wM = weightFor(sport, 'spread', league), wP = weightFor(sport, 'ml', league);
  const mlHome = m.get('ml')?.p?.home ?? m.get('ml')?.p?.Home ?? null;
  const total = blendLine(base.total + shift, wT ? marketTotal(m.get('total')) : null, wT);
  const margin = blendLine(base.margin, wM ? marketMargin(m.get('spread')) : null, wM);
  const pHome = blendChance(base.pHome, wP ? mlHome : null, wP);
  const anchored = (!!wT && m.has('total')) || (!!wM && m.has('spread')) || (!!wP && mlHome != null);
  return { pHome, margin, total, home: (total + margin) / 2, away: (total - margin) / 2, anchored, raw: base, shift: r1(shift) };
}
/** the extras' (more predictions) points anchor: the market's total and margin with their weights, or null */
export function pointsMarketFor(sport: 'basketball' | 'nfl', gameId: number, league: string | number | null | undefined): { total: number | null; margin: number | null; wT: number; wM: number } | null {
  const wT = weightFor(sport, 'total', league), wM = weightFor(sport, 'spread', league);
  if (!wT && !wM) return null;
  const m = marketFor(sport, gameId);
  const total = wT ? marketTotal(m.get('total')) : null, margin = wM ? marketMargin(m.get('spread')) : null;
  return total == null && margin == null ? null : { total, margin, wT, wM };
}

/** our P(over 2.5 goals) from the goals set (0 / 1 / 2 / 3 / 4+) */
export const overOf = (x: Extras, line = 2.5): number | null => {
  const g = x.sets?.goals;
  if (!g?.p?.length) return null;
  const from = Math.ceil(line);
  return g.p.slice(from).reduce((s, v) => s + v, 0);
};
/** our P(both teams score): 1 − P(home 0) − P(away 0) + P(0-0) */
export const bttsOf = (x: Extras): number | null => {
  const ch = x.sets?.cleanHome?.p?.[0], ca = x.sets?.cleanAway?.p?.[0];
  const sc = x.sets?.score;
  if (ch == null || ca == null || !sc) return null;
  const i = sc.labels.indexOf('0-0');
  return Math.max(0, Math.min(1, 1 - ch - ca + (i >= 0 ? sc.p[i] : 0)));
};
/**
 * football: the goals set's over / under 2.5 moved to the blend of ours and the market's (the under labels scaled to
 * 1 − shown, the over labels to shown); info.anchor keeps our own chance for the next fit. No line / weight: unchanged.
 */
export function anchorFootballGoals(gameId: number, league: string | null, x: Extras): Extras {
  const ours = overOf(x);
  if (ours == null || ours <= 0 || ours >= 1) return x;
  const w = weightFor('football', 'ou2.5', league);
  const mk = w ? marketFor('football', gameId).get('ou2.5')?.p?.over ?? null : null;
  const shown = blendChance(ours, mk, w);
  const g = x.sets.goals;
  const p = g.p.map((v, i) => (i >= 3 ? (v * shown) / ours : (v * (1 - shown)) / (1 - ours)));
  return { ...x, sets: { ...x.sets, goals: { ...g, p } }, info: { ...x.info, anchor: { ou25: Math.round(ours * 10000) / 10000 }, ...(mk != null ? { anchored: true } : {}) } };
}

/* ---------- the gate's measure: median |gap| to the closing line on settled games ---------- */

const DAY = 86400000;
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
/** our shown number of an output's market from a saved extras row (lines: points, chances: percentage points) */
export function oursOfExtras(sport: MarketSport, market: string, x: Extras | null): number | null {
  if (!x) return null;
  const e = x.info?.expected;
  if ((sport === 'basketball' || sport === 'nfl') && Array.isArray(e)) {
    if (market === 'total') return e[0] + e[1];
    if (market === 'spread') return e[0] - e[1];
  }
  if (sport === 'football') {
    if (market === 'ou2.5') { const v = overOf(x, 2.5); return v == null ? null : v * 100; }
    if (market === 'btts') { const v = bttsOf(x); return v == null ? null : v * 100; }
  }
  if (sport === 'tennis' && market === 'total_games') return Number.isFinite(x.info?.expGames) ? x.info.expGames : null;
  return null;
}
/** the market's number of a stored line in the same terms */
export function marketNumber(market: string, line: number | null, p: Record<string, number> | null): number | null {
  if (market === 'total' || market === 'total_games') return line;
  // fix278b: a handicap (home favoured = negative) → our home margin (home favoured = positive): the one conversion
  if (market === 'spread' || market === 'ah' || market === 'h1_spread') return line == null ? null : -line;
  if (market.startsWith('ou')) return p?.over != null ? p.over * 100 : null;
  if (market === 'btts') return p?.Yes != null ? p.Yes * 100 : p?.yes != null ? p.yes * 100 : null;
  return null;
}
/**
 * the gate's numbers of one sport × market: settled games of the last `days` with extras and a closing line — how
 * many, the median |gap|; feed = any line of that market stored in the last 30 days (no such market in the feed:
 * the output is judged on calibration only).
 */
export function gateGap(sport: MarketSport, market: string, days = 90, now = Date.now()): { n: number; medianAbs: number | null; meanGap: number | null; feed: boolean } {
  const feed = !!db.prepare(`SELECT 1 FROM market_lines WHERE sport = ? AND market = ? AND at > ? LIMIT 1`).get(sport, market, new Date(now - 30 * DAY).toISOString());
  const rows = db.prepare(`SELECT e.json, m.line, m.prices FROM prediction_extras e JOIN market_lines m ON m.sport = e.sport AND m.game_id = e.game_id AND m.market = ? AND m.closing = 1
    WHERE e.sport = ? AND e.settled = 1 AND e.kickoff > ?`).all(market, sport, new Date(now - days * DAY).toISOString()) as any[];
  const pairs: { ours: number; market: number }[] = [];
  for (const r of rows) {
    const ours = oursOfExtras(sport, market, parse(r.json)), mk = marketNumber(market, r.line, parse(r.prices)?.p || null);
    if (ours != null && mk != null) pairs.push({ ours, market: mk });
  }
  const g = gapStats(pairs);
  return { n: g.n, medianAbs: g.medianAbs, meanGap: g.meanGap, feed };
}
/** median |gap| of the last 7 days (data health) — same numbers, a shorter window */
export const recentGap = (sport: MarketSport, market: string, now = Date.now()) => gateGap(sport, market, 7, now);
export const medianOf = median;

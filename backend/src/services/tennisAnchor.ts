/**
 * fix293 (Yarin, 31 Oct): the tennis winner chance and the market (fix278's anchor). Admin-only data: the market price
 * is never shown or sent; only the shown chance moves (blend in log-odds with a weight fitted walk-forward per tour ×
 * surface, kept only when it beats the model alone and the market alone on unseen matches).
 *
 * Read side only, safe on the tennis model's read-only worker connection (no CREATE / ALTER here, every read in a try):
 *  - the price of a match = tennis_prices (the exchange mid taken 45–75 min before the start: our closing price);
 *    the mid is a probability (≤ 1) or decimal odds (> 1) → 1 / odds; both sides normalised to sum 1;
 *  - the fits = market_anchor ('tennis', 'ml'), written by the daily anchor job (services/marketLines.ts runMarketFits).
 * The settled rows the fit learns from = tennis_predictions saved before the start with the chance before the anchor
 * (p_anchor_pre; older rows: p1, saved before any anchor existed) + the closing price + the winner.
 */
import { db } from '../db';
import { anchorWeightOf, blendChance, type AnchorFit, type AnchorRow } from '../utils/marketLines';

const DAY = 86400000;
/** the mid of one side → a probability (a probability quote stays, decimal odds → 1 / odds) */
export const midToProb = (m: number | null | undefined): number => (Number(m) > 0 ? (Number(m) <= 1 ? Number(m) : 1 / Number(m)) : NaN);
/** both sides' mids → player 1's margin-free chance (null when either side is missing) */
export function priceP1(p1Mid: number | null | undefined, p2Mid: number | null | undefined): number | null {
  const a = midToProb(p1Mid), b = midToProb(p2Mid);
  if (!(a > 0) || !(b > 0)) return null;
  const p = a / (a + b);
  return p > 0.005 && p < 0.995 ? p : null;
}

let fitCache: { at: number; v: Record<string, AnchorFit> | null } | null = null;
/** the stored tennis winner fits (re-read every 5 minutes; null = none yet) */
export function tennisAnchorFits(): Record<string, AnchorFit> | null {
  if (fitCache && Date.now() - fitCache.at < 5 * 60000) return fitCache.v;
  let v: Record<string, AnchorFit> | null = null;
  try { const r = db.prepare(`SELECT json FROM market_anchor WHERE sport = 'tennis' AND market = 'ml'`).get() as any; v = r ? JSON.parse(r.json) : null; } catch { v = null; }
  fitCache = { at: Date.now(), v };
  return v;
}
export const clearTennisAnchorCache = () => { fitCache = null; };

/** player 1's closing chance of one match (null = no price) */
export function tennisPriceOf(matchId: number): number | null {
  try {
    const r = db.prepare(`SELECT p1_mid, p2_mid FROM tennis_prices WHERE match_id = ?`).get(matchId) as any;
    return r ? priceP1(r.p1_mid, r.p2_mid) : null;
  } catch { return null; }
}

/**
 * the shown chance after the anchor: the tour × surface weight (its own with 300+ matches, else the sport's), blended
 * with the closing price in log-odds. No price or a weight of 0 → unchanged.
 */
export function anchorTennis(matchId: number, segment: string, p: number, fits = tennisAnchorFits()): { p: number; anchored: boolean; w: number } {
  const w = anchorWeightOf(fits, segment);
  if (!w || !(matchId > 0)) return { p, anchored: false, w: 0 };
  const mk = tennisPriceOf(matchId);
  if (mk == null) return { p, anchored: false, w };
  return { p: blendChance(p, mk, w), anchored: true, w };
}

/** tour × surface of a saved prediction ("atp·hard"), the same key the model's settings use */
export const segmentOf = (cat: string | null | undefined, surface: string | null | undefined) => {
  const s = String(surface || '').toLowerCase();
  return `${cat || 'atp'}·${s === 'clay' ? 'clay' : s === 'grass' ? 'grass' : 'hard'}`;
};
const VOID = `COALESCE(m.outcome, '') NOT IN ('walkover', 'abandoned', 'unresolved')`;

export interface TennisPricedRow { id: number; t: number; seg: string; cat: string; ours: number; model: number; market: number; won: number | null; kickoff: string }
/**
 * tennis predictions with a closing price: `ours` = the chance saved (shown), `model` = the chance before the anchor,
 * `market` = the closing price, `won` = 1 / 0 for player 1 when settled (null = not finished). ITF left out.
 */
export function tennisPriced(from: number, to: number, settled: boolean): TennisPricedRow[] {
  let rows: any[] = [];
  try {
    rows = db.prepare(`SELECT p.match_id AS id, p.scheduled_at, p.cat, p.p1, p.p_anchor_pre, m.surface, m.status, m.winner, pr.p1_mid, pr.p2_mid
      FROM tennis_predictions p JOIN tennis_prices pr ON pr.match_id = p.match_id JOIN tennis_matches m ON m.id = p.match_id
      WHERE p.scheduled_at > ? AND p.scheduled_at < ? AND COALESCE(p.cat, '') <> 'itf'
        AND ${settled ? `m.status = 'completed' AND m.winner IN (1, 2) AND p.made_at <= p.scheduled_at AND ${VOID}` : `m.status = 'upcoming'`}`)
      .all(new Date(from).toISOString(), new Date(to).toISOString()) as any[];
  } catch { return []; }
  const out: TennisPricedRow[] = [];
  for (const r of rows) {
    const market = priceP1(r.p1_mid, r.p2_mid);
    const ours = Number(r.p1), model = Number(r.p_anchor_pre ?? r.p1);
    if (market == null || !(ours > 0 && ours < 1) || !(model > 0 && model < 1)) continue;
    out.push({ id: r.id, t: Date.parse(r.scheduled_at), seg: segmentOf(r.cat, r.surface), cat: String(r.cat || ''), ours, model, market, won: settled ? (r.winner === 1 ? 1 : 0) : null, kickoff: r.scheduled_at });
  }
  return out.filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
}

/** the anchor's fit rows (settled matches of the last 400 days with a closing price), grouped by tour × surface */
export const tennisAnchorRows = (now = Date.now()): AnchorRow[] =>
  tennisPriced(now - 400 * DAY, now, true).map(r => ({ t: r.t, model: r.model, market: r.market, actual: r.won!, group: r.seg }));

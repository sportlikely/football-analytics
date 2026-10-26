/**
 * fix246 (admin only): "Our different view" — the maths for games where our model and the market disagree.
 *
 * Market prices → fair probabilities (the bookmaker margin removed proportionally: each 1/price divided by their sum),
 * for 3-way (home / draw / away) and 2-way (player 1 / player 2) markets. "Our side" = the outcome we rate higher than
 * the market by the most; gap = our % − market % for it, in points. Each game is then a 1-unit stake on our side at the
 * stored price: return = price − 1 when it happens, −1 when not. Pure: no database, no imports.
 */

export type Band = '3–5' | '5–8' | '8–12' | '12+';
export const BANDS: Band[] = ['3–5', '5–8', '8–12', '12+'];
/** games with a gap of this many points or more are followed live (flagged at kick-off) */
export const FLAG_GAP = 5;

/** Decimal prices (or probabilities ≤ 1) → probabilities that add up to 1. null when a price is missing or not a price. */
export function fairProbs(prices: (number | null | undefined)[]): number[] | null {
  if (prices.length < 2) return null;
  const inv: number[] = [];
  for (const x of prices) {
    if (x == null || !Number.isFinite(x) || x <= 0) return null;
    if (x > 1) inv.push(1 / x);
    else if (x < 1) inv.push(x); // already a probability (exchange mid)
    else return null; // 1.00 is neither a usable price nor a probability
  }
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map(v => v / s);
}

/** The bookmaker margin (overround) of decimal prices: 0.05 = 5%. */
export function overround(prices: number[]): number {
  return prices.reduce((s, x) => s + 1 / x, 0) - 1;
}

/** The side we favour more than the market: its index and the gap in points (our % − market %). */
export function ourSide(model: number[], market: number[]): { side: number; gap: number } {
  let side = 0, best = -Infinity;
  for (let i = 0; i < model.length; i++) {
    const d = model[i] - market[i];
    if (d > best) { best = d; side = i; }
  }
  return { side, gap: Math.round(best * 1000) / 10 };
}

/** Gap band (points); null under 3 points (no real disagreement). */
export function bandOf(gap: number): Band | null {
  if (!(gap >= 3)) return null;
  if (gap < 5) return '3–5';
  if (gap < 8) return '5–8';
  if (gap < 12) return '8–12';
  return '12+';
}

/** 1 unit on a side at a decimal price */
export const unitReturn = (won: boolean, price: number) => (won ? price - 1 : -1);

export interface Bet { won: boolean; price: number; ours: number; market: number }
export interface Summary {
  games: number;
  /** how often our side happened (%) */
  hit: number | null;
  /** what we said on average (%) */
  ours: number | null;
  /** what the market said on average (%) */
  market: number | null;
  /** units won or lost on 1 unit a game */
  units: number;
  /** return per unit staked (%) with its 95% interval (normal approximation of the mean return) */
  roi: number | null; roiLo: number | null; roiHi: number | null;
}
const r1 = (x: number) => Math.round(x * 10) / 10;

export function summarize(bets: Bet[]): Summary {
  const n = bets.length;
  if (!n) return { games: 0, hit: null, ours: null, market: null, units: 0, roi: null, roiLo: null, roiHi: null };
  let won = 0, ours = 0, market = 0, sum = 0, sq = 0;
  for (const b of bets) {
    const u = unitReturn(b.won, b.price);
    if (b.won) won++;
    ours += b.ours; market += b.market; sum += u; sq += u * u;
  }
  const mean = sum / n;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (sq - n * mean * mean) / (n - 1))) : 0;
  const half = n > 1 ? 1.96 * sd / Math.sqrt(n) : null;
  return {
    games: n, hit: r1((won / n) * 100), ours: r1((ours / n) * 100), market: r1((market / n) * 100),
    units: Math.round(sum * 100) / 100,
    roi: r1(mean * 100), roiLo: half === null ? null : r1((mean - half) * 100), roiHi: half === null ? null : r1((mean + half) * 100)
  };
}

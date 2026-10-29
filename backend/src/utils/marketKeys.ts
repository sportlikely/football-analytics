/**
 * No bookmakers on the site (Oct 2026): odds, bookmaker names and market comparisons are internal data only. For everyone
 * except admins, every API response is cleaned of them before it leaves the server (app.ts, stored-page views).
 * fix278: + the market lines feed's fields (market_lines: consensus lines, closing lines, gaps to the market, the anchor's
 * market number) — kept here so the test can check every one stays off public routes.
 */
export const MARKET_KEYS = new Set([
  'odds', 'bookmaker', 'books', 'clv', 'price', 'bestPrice', 'marketDraw', 'marketHit', 'marketHits', 'marketN', 'marketHitRate', 'bookmakers', 'roi', 'msw', 'overround',
  // fix278
  'marketLine', 'marketLines', 'closingLine', 'closing', 'consensus', 'marketGap', 'gapToMarket', 'marketTotal', 'marketSpread', 'marketChance', 'anchorMarket', 'marketGaps'
]);
export function stripMarket(x: any, depth = 0): any {
  if (depth > 12 || x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(v => stripMarket(v, depth + 1));
  if (x instanceof Date) return x;
  const out: any = {};
  for (const [k, v] of Object.entries(x)) {
    if (MARKET_KEYS.has(k)) continue;
    // "market" as an object / number / null is bookmaker data; as a string it is a bet type ("double chance")
    if (k === 'market' && typeof v !== 'string') continue;
    out[k] = stripMarket(v, depth + 1);
  }
  return out;
}

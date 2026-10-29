/**
 * fix276: data health is red only when something is really wrong (Yarin, 29 Oct 18:04: 4 red checks, one real fault).
 * Pure rules (scripts/fix276.test.mjs):
 *  - calibration: a band's allowed gap grows with its size — max(5 points, 2 × the standard error of its hit rate);
 *    over 5 but inside 2 SE = yellow "too few games to tell", outside = red
 *  - search engines: red when ≥ 0.5% of a verified crawler's requests got 429 / 503, or any 429 outside the warm-up
 *    (the 503 "Starting up" answers of a start are counted apart: "Errors during the last deploy")
 *  - slow requests: outside the warm-up, red over 5 public requests over 1 s in the hour, yellow 1–5
 */
export type Level = 'ok' | 'warn' | 'fail';

export const CALIB_MIN_GAP = 5;
/** the allowed gap (points) for a band of `n` games whose picks were right `hitRate`% of the time */
export function calibAllowed(n: number, hitRate: number): number {
  if (!n) return CALIB_MIN_GAP;
  const p = Math.min(0.99, Math.max(0.01, hitRate / 100));
  return Math.round(Math.max(CALIB_MIN_GAP, 2 * Math.sqrt((p * (1 - p)) / n) * 100) * 10) / 10;
}

type Band = { n: number; said: number | null; hitRate: number | null; label?: string };
export type CalibBand<B extends Band = Band> = B & { gap: number; allowed: number; level: Level };
/**
 * every band of `minBand`+ games judged on its own allowed gap; red when one is outside it, yellow when one is over
 * 5 points but inside it (100+ games in all, as before)
 */
export function calibVerdict<B extends Band>(rows: B[], minTotal = 100, minBand = 50) {
  const total = rows.reduce((s, r) => s + (r.n || 0), 0);
  const bands: CalibBand<B>[] = rows.filter(r => r.n >= minBand && r.said !== null && r.hitRate !== null).map(r => {
    const gap = Math.round((r.said! - r.hitRate!) * 10) / 10, allowed = calibAllowed(r.n, r.hitRate!);
    return { ...r, gap, allowed, level: Math.abs(gap) > allowed ? 'fail' : Math.abs(gap) > CALIB_MIN_GAP ? 'warn' : 'ok' };
  });
  const enough = total >= minTotal;
  const fails = bands.filter(b => b.level === 'fail').sort((a, b) => (Math.abs(b.gap) - b.allowed) - (Math.abs(a.gap) - a.allowed));
  const warns = bands.filter(b => b.level === 'warn').sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const level: Level = !enough ? 'ok' : fails.length ? 'fail' : warns.length ? 'warn' : 'ok';
  return { total, enough, level, worst: fails[0] || warns[0] || null, bands };
}

/** search engines: one line per verified crawler (Google's ranges as one more) — counts outside the warm-up */
export type CrawlerCount = { name: string; requests: number; refused: number; s429: number; warm429?: number };
export const CRAWLER_FAIL_SHARE = 0.005;
export function crawlerVerdict(list: CrawlerCount[]): { level: Level; why: string | null } {
  for (const c of list) {
    const out429 = c.s429 - (c.warm429 || 0);
    if (out429 > 0) return { level: 'fail', why: `${c.name}: ${out429} request(s) got 429 outside a start's first 10 minutes` };
  }
  for (const c of list) {
    if (c.requests > 0 && c.refused / c.requests >= CRAWLER_FAIL_SHARE) return { level: 'fail', why: `${c.name}: ${c.refused} of ${c.requests.toLocaleString('en-US')} requests got 429 / 503 (${((c.refused / c.requests) * 100).toFixed(2)}%, 0.5% allowed)` };
  }
  return { level: 'ok', why: null };
}

/** slow requests: public requests over 1 s in the hour, outside the warm-up */
export const SLOW_FAIL_OVER = 5;
export function slowVerdict(rows: { route: string; people: number; maxMs: number }[]): { level: Level; total: number; slowest: string } {
  const total = rows.reduce((t, r) => t + r.people, 0);
  const slowest = rows.filter(r => r.people > 0).sort((a, b) => b.maxMs - a.maxMs).slice(0, 3).map(r => `${r.route} ${(r.maxMs / 1000).toFixed(1)} s`).join(', ');
  return { level: total > SLOW_FAIL_OVER ? 'fail' : total ? 'warn' : 'ok', total, slowest };
}

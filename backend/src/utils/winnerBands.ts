/**
 * "Our record" bars of the home page (fix141) for sports where the pick is the winner (basketball, NFL): how often the
 * picked team won, for all picks and when we were 60% / 70% / 80%+ sure of it (cumulative, like football's highlights).
 * `p` = the chance we gave the picked team (0.5–1).
 */
export const WINNER_BANDS = [0, 60, 70, 80] as const;

export function winnerBands(rows: { p: number; hit: boolean }[]) {
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return WINNER_BANDS.map(min => {
    const sel = rows.filter(r => 100 * r.p >= min);
    const hits = sel.filter(r => r.hit).length;
    return { min, n: sel.length, hits, pct: pct(hits, sel.length) };
  });
}

/**
 * fix152b — the Accuracy page's calibration for the winner sports (same shape as football's /public/record): every
 * chance we gave (the home side's and the away side's of every game) in 10-point bins, with how often it happened.
 */
export function winnerCalibration(rows: { pHome: number; homeWon: boolean }[]) {
  const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i * 10 + 10, n: 0, sum: 0, hits: 0 }));
  for (const r of rows) for (const [p, won] of [[r.pHome, r.homeWon], [1 - r.pHome, !r.homeWon]] as [number, boolean][]) {
    const b = bins[Math.min(9, Math.floor(100 * p / 10))];
    b.n++; b.sum += 100 * p; if (won) b.hits++;
  }
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return bins.map(b => ({ lo: b.lo, hi: b.hi, n: b.n, said: b.n ? r1(b.sum / b.n) : b.lo + 5, happened: b.n ? r1((100 * b.hits) / b.n) : null }));
}
/** Picks by how sure we were (ranges, not cumulative): 50–60%, 60–70%, 70–80%, 80%+ — n, how often right, the average we said. */
export function winnerByConfidence(rows: { p: number; hit: boolean }[]) {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return [[50, 60], [60, 70], [70, 80], [80, 101]].map(([lo, hi]) => {
    const sel = rows.filter(r => 100 * r.p >= lo && 100 * r.p < hi);
    const hits = sel.filter(r => r.hit).length;
    return { id: `${lo}`, label: hi > 100 ? `${lo}%+` : `${lo}–${hi}%`, n: sel.length, hitRate: sel.length ? r1((100 * hits) / sel.length) : null, said: sel.length ? r1((100 * sel.reduce((s, r) => s + r.p, 0)) / sel.length) : null };
  });
}
/**
 * fix206: Brier score of the winner sports — the average of (chance we gave the home side − 1 if it won, else 0)²,
 * 0 = perfect, 0.25 = a coin flip every time. The "how it works" pages show it per competition next to the hit rate.
 */
export function winnerBrier(rows: { pHome: number; homeWon: boolean }[]): number | null {
  if (!rows.length) return null;
  const s = rows.reduce((a, r) => a + (r.pHome - (r.homeWon ? 1 : 0)) ** 2, 0);
  return Math.round((s / rows.length) * 1000) / 1000;
}

/**
 * fix260: people's names in the order people write them (first name first) — the slugs and the pages use it.
 * API-Basketball writes players last name first ("Lillard Damian", "Champagnie Julian", "Jackson Jr. Jaren"); a few rows
 * come as "D. Harper" (already first-last) or "Harper D." (initial last). The live sitemap held 7,900 basketball player
 * slugs like lillard-damian; the common order makes them damian-lillard (the old slug stays as a 301 alias).
 */
const INITIAL = /^\p{Lu}\.$/u;

/** "Lillard Damian" → "Damian Lillard", "Harper D." → "D. Harper", "D. Harper" stays, "Jackson Jr. Jaren" → "Jaren Jackson Jr." */
export function bbCommonName(raw: string | null | undefined): string {
  const n = String(raw || '').trim().replace(/\s+/g, ' ');
  const w = n.split(' ');
  if (w.length < 2 || INITIAL.test(w[0]) || /^\p{Lu}\.\p{Lu}\.?$/u.test(w[0])) return n;
  // the given name is the last word ("Van Vleet Fred" → "Fred Van Vleet", "Gilgeous-Alexander Shai" → "Shai Gilgeous-Alexander")
  return [w[w.length - 1], ...w.slice(0, -1)].join(' ');
}

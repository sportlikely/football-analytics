import { t } from './i18n'

/**
 * fix281 — how sure a pick is, one rule for every sport and every page (Yarin, 29 Oct: replaces the old "Strong"
 * badge and its 85% rule): 80%+ "Very likely" (accent), 60–79% "Likely" (yellow), under 60% "Close call" (grey).
 * The % is rounded first, so 79.6% is 80% and "Very likely" — the number on screen decides.
 */
export type Band = 'very' | 'likely' | 'close'
export const VERY_AT = 80
export const LIKELY_AT = 60

export function bandOf(pct: number): Band {
  const v = Math.round(pct)
  return v >= VERY_AT ? 'very' : v >= LIKELY_AT ? 'likely' : 'close'
}
/** the word next to a pick: "Very likely" / "Likely" / "Close call" */
export function bandWord(b: Band) {
  return b === 'very' ? t("Very likely") : b === 'likely' ? t("Likely") : t("Close call")
}
/** the group titles of "Most sure first" (the lowest group is "Possible", not "Close call") */
export function bandGroup(b: Band) {
  return b === 'very' ? t("Very likely") : b === 'likely' ? t("Likely") : t("Possible")
}
export const BAND_RANGE: Record<Band, string> = { very: '80%+', likely: '60–79%', close: '<60%' }
/** text / fill colours of each band (tokens: accent, likely, muted) */
export const BAND_TEXT: Record<Band, string> = { very: 'text-accent', likely: 'text-likely', close: 'text-muted' }
export const BAND_FILL: Record<Band, string> = { very: 'bg-accent', likely: 'bg-likely', close: 'bg-muted/60' }
export const BAND_ORDER: Band[] = ['very', 'likely', 'close']

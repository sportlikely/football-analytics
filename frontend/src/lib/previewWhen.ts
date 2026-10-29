import { LOCALE } from './i18n'

/**
 * fix284: the game preview's day and clock time in the visitor's own time zone, like the rest of the page (never
 * "UTC"). The server writes ⟦d:<iso>⟧ / ⟦t:<iso>⟧ (backend utils/previewWhen.ts, same marks); this fills them in.
 */
const MARK = /⟦([dt]):([^⟧]+)⟧/g

/** "Friday, 30 October" (the year only when it is not this year's) */
export function dayWords(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(d).map(p => [p.type, p.value]))
  return `${parts.weekday}, ${parts.day} ${parts.month}${Number(parts.year) !== new Date().getFullYear() ? ` ${parts.year}` : ''}`
}

/** The preview text with every mark filled in (an old text without marks is returned as it is). */
export function previewText(text: string): string {
  return text.replace(MARK, (_, k: string, iso: string) =>
    k === 'd' ? dayWords(iso) : new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }))
}

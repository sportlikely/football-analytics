/**
 * fix284: dates and times inside the game previews (every sport). The server never knows the visitor's time zone, so
 * the preview text carries a mark — ⟦d:<iso>⟧ for the day ("Friday, 30 October"), ⟦t:<iso>⟧ for the clock time —
 * and the game page fills it in the visitor's own zone (frontend lib/previewWhen.ts, same marks). Copies that leave
 * the server as text (crawler HTML, JSON-LD, hub pages) go through plainPreview: the day in UTC, the sentence with a
 * clock time dropped. No preview ever says "UTC".
 */
export const dayMark = (iso: string) => `⟦d:${iso}⟧`;
export const timeMark = (iso: string) => `⟦t:${iso}⟧`;

const MARK = /⟦([dt]):([^⟧]+)⟧/g;

/** "Friday, 30 October" (the year only when it is not this year's) */
export function dayWords(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).formatToParts(d).map(p => [p.type, p.value]));
  const thisYear = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone }).formatToParts(new Date()).map(p => [p.type, p.value])).year;
  return `${parts.weekday}, ${parts.day} ${parts.month}${parts.year !== thisYear ? ` ${parts.year}` : ''}`;
}

/** The text for anything that is not the game page: day in UTC, no clock time, no marks. */
export function plainPreview<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(s => !/⟦t:/.test(s))
    .join(' ')
    .replace(MARK, (_, k, iso) => (k === 'd' ? dayWords(iso, 'UTC') : '')) as T;
}

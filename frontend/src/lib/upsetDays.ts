/**
 * fix242: the upset watch list grouped by day in the visitor's own time zone (a 01:00 UTC game on Saturday is a Friday
 * evening game in New York). Pure: no imports, tested by backend/scripts/fix242.test.mjs.
 */
export interface Dated { date: string }

/** "2026-10-31" for an ISO time, in the given time zone (default: the visitor's). */
export function dayKey(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find(p => p.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Days in order, each with its games by kick-off time. */
export function groupByDay<T extends Dated>(items: T[], timeZone?: string): { day: string; items: T[] }[] {
  const by = new Map<string, T[]>()
  for (const x of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    const k = dayKey(x.date, timeZone)
    if (!by.has(k)) by.set(k, [])
    by.get(k)!.push(x)
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, items]) => ({ day, items }))
}

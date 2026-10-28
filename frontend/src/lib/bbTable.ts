import { t, lang } from './i18n'

/**
 * fix201: basketball standings as the API sends them (backend utils/bbStandingsGroups.ts: one table per stage + group,
 * rows ranked inside their table) and the helpers the game, team and league pages share, so they can't disagree.
 */
export interface StandRow { position: number; team: { id: number; name: string; logo: string | null }; played: number; won: number; lost: number; pct: number | null; pointsFor: number | null; pointsAgainst: number | null }
export type StandLevel = 'conference' | 'division' | 'group'
export interface StandGroup { name: string | null; stage: string | null; level?: StandLevel; kind?: 'pre' | 'regular' | 'post'; rows: StandRow[] }
export interface Standings { season: string; groups: StandGroup[] }

/** the league has conferences and divisions: divisions sit behind the "Divisions" toggle */
export const hasDivisions = (d: Standings) => d.groups.some(g => g.level === 'division') && d.groups.some(g => g.level !== 'division')

/** the tables to show: conferences / groups by default, the divisions when the toggle is on */
export const tablesToShow = (d: Standings, divisions: boolean) =>
  hasDivisions(d) ? d.groups.filter(g => g.kind === 'post' || (g.level === 'division') === divisions) : d.groups

/** the team's own main table (conference / group, regular stage first; a division only when there is nothing else) */
export function teamPlace(d: Standings | null | undefined, teamId: number): { row: StandRow; of: number; group: StandGroup } | null {
  if (!d) return null
  const rank = (g: StandGroup) => (g.kind === 'post' ? 2 : 0) + (g.level === 'division' ? 1 : 0)
  for (const g of [...d.groups].sort((a, b) => rank(a) - rank(b))) {
    const row = g.rows.find(r => r.team.id === teamId)
    if (row) return { row, of: g.rows.length, group: g }
  }
  return null
}

/** short group name for sentences: "Eastern Conference" → "East" */
export function groupShort(name: string | null): string {
  if (!name) return ''
  if (/^east/i.test(name)) return t('East')
  if (/^west/i.test(name)) return t('West')
  return name
}

/** the group in a sentence: "Pacers 7th in the East" / "… in Group A" */
export function groupIn(name: string | null): string {
  if (!name) return ''
  if (/^east/i.test(name)) return t('the East')
  if (/^west/i.test(name)) return t('the West')
  return name
}

/** 7 → "7th" (en), "7." (de, tr, pl), "7.º" (es, pt), "7e" (fr), "7°" (it), "7-й" (ru), "7ος" (el), "7वाँ" (hi), "ke-7" (id) */
export function ordinal(n: number): string {
  if (lang === 'en') {
    const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] || 'th'
    return `${n}${s}`
  }
  if (lang === 'fr') return n === 1 ? '1er' : `${n}e`
  if (lang === 'it') return `${n}°`
  if (lang === 'es' || lang === 'pt') return `${n}.º`
  if (lang === 'ru') return `${n}-й`
  if (lang === 'el') return `${n}ος`
  if (lang === 'hi') return n === 1 ? '1ला' : n === 2 ? '2रा' : n === 3 ? '3रा' : n === 4 ? '4था' : n === 6 ? '6ठा' : `${n}वाँ`
  if (lang === 'id') return `ke-${n}`
  return `${n}.`
}

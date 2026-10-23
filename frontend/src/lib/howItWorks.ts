import type { ModelSport } from './modelNames'

/** fix206: the "How our models work" page of each sport (backend twin: HIW_PATH in services/howItWorks.ts). */
export type HowSport = 'football' | 'basketball' | 'american-football' | 'tennis'
export const HOW_PATH: Record<HowSport, string> = {
  football: '/how-it-works',
  basketball: '/basketball/how-it-works',
  'american-football': '/american-football/how-it-works',
  tennis: '/tennis/how-it-works'
}
/** A changelog entry (docs/changelog.json through /api/changelog). */
export interface ChangelogEntry { date: string; sport: HowSport | 'all'; kind: 'model' | 'site'; version: string | null; text: Record<string, string> }
/** The changelog filter: a sport's own entries and the ones for every sport ('all' = everything). */
export const filterEntries = (list: ChangelogEntry[], f: 'all' | HowSport) => (f === 'all' ? list : list.filter(e => e.sport === f || e.sport === 'all'))

/** The page of a model's sport (null for a sport without a model yet). */
export const howPath = (s: ModelSport | string): string | null => HOW_PATH[s as HowSport] || null

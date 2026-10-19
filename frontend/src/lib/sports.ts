import { t } from './i18n'

/** The sports of SportLikely. Football is live; the others open later (Oct 2026: "coming soon" pages). */
export type SportId = 'football' | 'basketball' | 'tennis' | 'american-football' | 'baseball'

export interface Sport {
  id: SportId
  name: string
  icon: string
  path: string // where the sport's section starts
  live: boolean
  /** shorter label for the phone header (fix137: "American football" is too wide at 375 px) */
  short?: string
}

export const SPORTS: Sport[] = [
  { id: 'football', name: t('Football'), icon: '⚽', path: '/', live: true },
  { id: 'basketball', name: t('Basketball'), icon: '🏀', path: '/basketball', live: false },
  { id: 'american-football', name: t('American football'), short: 'NFL', icon: '🏈', path: '/american-football', live: false },
  // fix145: tennis last (coming soon)
  { id: 'tennis', name: t('Tennis'), icon: '🎾', path: '/tennis', live: false },
  // fix186: baseball last (coming soon)
  { id: 'baseball', name: t('Baseball'), icon: '⚾', path: '/baseball', live: false }
]

/** The sport a page belongs to (everything outside another sport's section is football). */
export function sportOfPath(pathname: string): Sport {
  return SPORTS.find(s => s.id !== 'football' && (pathname === s.path || pathname.startsWith(s.path + '/'))) || SPORTS[0]
}

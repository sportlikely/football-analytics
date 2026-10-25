import { movedPage } from './slugRules'
/**
 * Weekly league prediction hubs (fix125): /predictions/<slug>. Same list as backend/src/services/hubs.ts.
 * old = the fix125 URL (/predictions/PL …), redirected to the slug (fix134).
 */
export type HubSport = 'football' | 'basketball' | 'american-football'
export const HUBS: { slug: string; old: string; sport: HubSport; code: string; name: string }[] = [
  { slug: 'premier-league', old: 'PL', sport: 'football', code: 'PL', name: 'Premier League' },
  { slug: 'la-liga', old: 'PD', sport: 'football', code: 'PD', name: 'La Liga' },
  { slug: 'serie-a', old: 'SA', sport: 'football', code: 'SA', name: 'Serie A' },
  { slug: 'bundesliga', old: 'BL1', sport: 'football', code: 'BL1', name: 'Bundesliga' },
  { slug: 'ligue-1', old: 'FL1', sport: 'football', code: 'FL1', name: 'Ligue 1' },
  { slug: 'champions-league', old: 'CL', sport: 'football', code: 'CL', name: 'Champions League' },
  { slug: 'nba', old: 'NBA', sport: 'basketball', code: 'NBA', name: 'NBA' },
  { slug: 'nfl', old: 'NFL', sport: 'american-football', code: 'NFL', name: 'NFL' },
  { slug: 'college-football', old: 'NCAA', sport: 'american-football', code: 'NCAA', name: 'College football' },
  { slug: 'euroleague', old: 'EUROLEAGUE', sport: 'basketball', code: 'EL', name: 'EuroLeague' }
]
export const hubByOld = (slug: string) => HUBS.find(h => h.old === slug.toUpperCase()) || null
export const hubFor = (sport: HubSport, code: string) => HUBS.find(h => h.sport === sport && h.code === code.toUpperCase()) || null
/** fix235: a hub's address, under its sport: /football/predictions/premier-league, /basketball/predictions/nba */
export const hubHref = (slug: string) => movedPage(`/predictions/${slug}`) || `/football/predictions/${slug}`

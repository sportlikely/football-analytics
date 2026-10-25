import type { SportId } from './sports'

/**
 * One menu per sport (fix144): the desktop menu, the phone tabs and the account menu read their links from here, so
 * every sport has the same pages in the same order — Home, Games / Matches, Today, Favorites, My picks, Upset watch,
 * [Draw picks: football only], Accuracy (admins). A new sport adds its paths here, nothing else.
 * `label` is the English text (shown through t()); `tab` = also a phone tab (the icon / short label key in App.tsx).
 */
export interface NavItem {
  key: 'home' | 'games' | 'today' | 'standings' | 'rankings' | 'favorites' | 'myPicks' | 'upsets' | 'draws' | 'accuracy'
  label: string
  to: string
  end?: boolean
  admin?: boolean
  tab?: string
}

export function sportNav(sport: SportId, nflBase = '/american-football'): NavItem[] {
  if (sport === 'basketball') return [
    { key: 'home', label: 'Home', to: '/basketball', end: true, tab: 'Home' },
    { key: 'games', label: 'Games', to: '/basketball/matches', tab: 'Games' },
    { key: 'today', label: 'Today', to: '/basketball/today' },
    { key: 'favorites', label: 'Favorites', to: '/basketball/favorites', tab: 'Favorites' },
    { key: 'myPicks', label: 'My picks', to: '/basketball/my-picks' },
    { key: 'upsets', label: 'Upset watch', to: '/basketball/upset-watch', tab: 'Upsets' },
    { key: 'accuracy', label: 'Accuracy', to: '/basketball/accuracy', admin: true, tab: 'Accuracy' }
  ]
  // fix193: tennis — Home · Matches · Today · Rankings · Favorites · Upset watch (Pro) · Accuracy (admins); Rankings
  // takes Upset watch's phone tab (five tabs + search, like the other sports)
  if (sport === 'tennis') return [
    { key: 'home', label: 'Home', to: '/tennis', end: true, tab: 'Home' },
    { key: 'games', label: 'Matches', to: '/tennis/matches', tab: 'Matches' },
    { key: 'today', label: 'Today', to: '/tennis/today' },
    { key: 'rankings', label: 'Rankings', to: '/tennis/rankings', tab: 'Rankings' },
    { key: 'favorites', label: 'Favorites', to: '/tennis/favorites', tab: 'Favorites' },
    { key: 'upsets', label: 'Upset watch', to: '/tennis/upset-watch' },
    { key: 'accuracy', label: 'Accuracy', to: '/tennis/accuracy', admin: true, tab: 'Accuracy' }
  ]
  if (sport === 'american-football') return [
    // fix185: one home / games / today for NFL and college; the standings follow the league last shown
    { key: 'home', label: 'Home', to: '/american-football', end: true, tab: 'Home' },
    { key: 'games', label: 'Games', to: '/american-football/matches', tab: 'Games' },
    { key: 'today', label: 'Today', to: '/american-football/today' },
    { key: 'standings', label: 'Standings', to: nflBase.endsWith('/college') ? '/american-football/league/college-football' : '/american-football/league/nfl' },
    { key: 'favorites', label: 'Favorites', to: '/american-football/favorites', tab: 'Favorites' },
    { key: 'myPicks', label: 'My picks', to: '/american-football/my-picks' },
    { key: 'upsets', label: 'Upset watch', to: '/american-football/upset-watch', tab: 'Upsets' },
    { key: 'accuracy', label: 'Accuracy', to: '/american-football/accuracy', admin: true, tab: 'Accuracy' }
  ]
  return [
    { key: 'home', label: 'Home', to: '/football', end: true, tab: 'Home' },
    { key: 'games', label: 'Matches', to: '/football/matches', tab: 'Matches' },
    { key: 'today', label: 'Today', to: '/football/today' },
    { key: 'favorites', label: 'Favorites', to: '/football/favorites', tab: 'Favorites' },
    { key: 'myPicks', label: 'My picks', to: '/football/my-picks' },
    { key: 'upsets', label: 'Upset watch', to: '/football/upset-watch' },
    { key: 'draws', label: 'Draw picks', to: '/football/draw-alerts', tab: 'Draws' },
    { key: 'accuracy', label: 'Accuracy', to: '/football/accuracy', admin: true, tab: 'Accuracy' }
  ]
}

/** Staff "Past seasons" page of each sport (account menu). */
export const PAST_OF: Record<SportId, string> = { football: '/football/past', basketball: '/basketball/past', 'american-football': '/american-football/past', tennis: '/tennis/past', baseball: '/football/past' }

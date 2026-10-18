import type { ParityProvides } from '../../lib/sportParity'

/** fix175: the parity keys the home adapter (SportHome/nfl.ts) feeds for nfl (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'nfl',
  keys: [
    'home.record',
    'home.results',
    'home.special',
    'home.favorites',
    'home.news'
  ]
}

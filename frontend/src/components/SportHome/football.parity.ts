import type { ParityProvides } from '../../lib/sportParity'

/** fix175: the parity keys the home adapter (SportHome/football.ts) feeds for football (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'football',
  keys: [
    'home.record',
    'home.results',
    'home.introStats',
    'home.special',
    'home.favorites',
    'home.news',
    'home.modelName' // fix191: slModel('football') on the featured card
  ]
}

import type { ParityProvides } from '../../lib/sportParity'

/** fix175: the parity keys the home adapter (SportHome/basketball.ts) feeds for basketball (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'basketball',
  keys: [
    'home.introStats',
    'home.record',
    'home.results',
    'home.special',
    'home.favorites',
    'home.news',
    'home.modelName' // fix191: slModel('basketball') on the featured card
  ]
}

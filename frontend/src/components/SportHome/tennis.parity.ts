import type { ParityProvides } from '../../lib/sportParity'

/** fix193c: the parity keys the home adapter (SportHome/tennis.ts) feeds for tennis (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'tennis',
  keys: [
    'home.introStats',
    'home.record',
    'home.results',
    'home.special', // upset watch
    'home.favorites',
    'home.news',
    'home.modelName' // slModel('tennis') on the featured card
  ]
}

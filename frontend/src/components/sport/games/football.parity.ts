import type { ParityProvides } from '../../../lib/sportParity'

/** fix175: the parity keys the games-list adapter (sport/games/football) feeds for football (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'football',
  keys: [
    'games.liveBox',
    'games.spotlight',
    'games.leaguePanel'
  ]
}

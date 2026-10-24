import type { ParityProvides } from '../../../lib/sportParity'

/** fix175: the parity keys the games-list adapter (sport/games/nfl) feeds for nfl (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'nfl',
  keys: [
    'games.leagueList',
    'games.leaguePanel',
    'games.liveBox',
    'games.spotlight'
  ]
}

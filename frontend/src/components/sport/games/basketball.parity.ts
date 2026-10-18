import type { ParityProvides } from '../../../lib/sportParity'

/** fix175: the parity keys the games-list adapter (sport/games/basketball) feeds for basketball (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'basketball',
  keys: [
    'games.leaguePanel',
    'games.liveBox',
    'games.spotlight'
  ]
}

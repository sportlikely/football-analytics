import type { ParityProvides } from '../../../lib/sportParity'

/** fix193c: the parity keys the matches-list adapter (sport/games/tennis) feeds for tennis (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'tennis',
  keys: [
    'games.leaguePanel', // TennisTournamentPanel
    'games.leagueList', // the tournaments
    'games.liveBox',
    'games.spotlight'
  ]
}

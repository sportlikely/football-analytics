import type { ParityProvides } from '../../lib/sportParity'

/**
 * fix193c: the parity keys the match, player, tournament and rankings pages (pages/tennis/*) and search feed for tennis
 * (checked by npm run parity). Football's blocks map to tennis like this: Standings → Draw (match page) and Rankings,
 * Team → Player, League → Tournament, line-ups / squad / league leaders → 'na' (individual sport, sportParity.ts).
 */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'tennis',
  keys: [
    'game.prediction',
    'game.why',
    'game.howCalculated', // TennisParts (ModelParts)
    'game.preview', // tennisWriteup, English pages
    'game.injuries', // stoppages (medical timeouts, retirements) in Schedule & rest
    'game.h2h',
    'game.form',
    'game.restTab', // Schedule & rest
    'game.pastMatchLinks', // H2H, form and rest rows open the match
    'game.standingsTab', // the Draw tab
    'game.liveChance',
    'game.swingChart',
    'game.events', // the set-by-set table
    'game.stats', // Serve & return
    'game.highlights',
    'game.savedBadge',
    'game.modelName',
    'team.analysis', // player page: strengths & weaknesses
    'team.ratingTiles', // How our model rates them
    'team.scores', // 1–10 tour scores
    'team.rankOverTime', // ranking, last 12 months
    'team.ourRecord',
    'team.fixtures', // next match + recent results
    'team.miniTable', // the ranking around the player
    'team.news',
    'player.stats', // serve / return numbers (Player analysis)
    'player.career', // titles in our data
    'player.injuries', // stoppages
    'league.table', // tournament: the draw
    'league.favoriteStar',
    'league.hubLink', // /tennis/predictions/<tournament>
    'league.recordTile',
    'league.liveNextResults',
    'search.players',
    'search.leagues', // tournaments
    'search.games'
  ]
}

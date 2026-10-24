import type { ParityProvides } from '../../lib/sportParity'

/** fix175: the parity keys the game, team, player and league pages (pages/nfl/*) and search feeds for nfl (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'nfl',
  keys: [
    'game.beforeAfter',
    'game.lineups',
    'game.howCalculated',
    'game.preview',
    'game.restTab',
    'game.pastMatchLinks', // fix180: NflGame H2HForm meetings + form rows, GameTabs schedule rows
    'game.standingsTab',
    'game.liveChance',
    'game.swingChart',
    'game.highlights',
    'team.ourRecord',
    'team.miniTable',
    'player.career',
    'player.injuries',
    'league.recordTile',
    'search.leagues',
    'game.prediction',
    'game.why',
    'game.injuries',
    'game.h2h',
    'game.form',
    'game.events',
    'game.stats',
    'game.livePlayerStats', // fix208: live player lines in the Players tab (LiveBox)
    'game.scorers', // fix209: the scoring plays under the score (nflScorers, games/events live too); the row arrow
    'game.savedBadge',
    'game.morePredictions', 'record.morePredictions', // fix204
    'game.howItWorks', // fix206: "How does this work?" in ModelName + the sport's how-it-works page (components/sport/HowItWorks)
    'game.modelName', // fix191: ModelName in the shared WinnerPrediction
    'team.analysis',
    'team.ratingTiles',
    'team.scores',
    'team.rankOverTime',
    'team.squad',
    'team.fixtures',
    'team.news',
    'player.stats',
    'player.photo', // the provider's player image (NflPlayer)
    'league.table',
    'league.leaders',
    'league.favoriteStar',
    'league.hubLink',
    'league.liveNextResults',
    'search.teams',
    'search.players',
    'search.games',
    'favorites.calendar' // fix205: CalendarCard in components/sport/Favorites
  ]
}

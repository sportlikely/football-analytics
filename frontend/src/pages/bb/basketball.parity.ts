import type { ParityProvides } from '../../lib/sportParity'

/** fix175: the parity keys the game, team, player and league pages (pages/bb/*) and search feeds for basketball (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'basketball',
  keys: [
    'game.swingChart',
    'team.miniTable',
    'game.beforeAfter',
    'game.lineups',
    'game.highlights',
    'game.prediction',
    'game.why',
    'game.howCalculated',
    'game.preview',
    'game.injuries',
    'game.h2h',
    'game.form',
    'game.restTab',
    'game.pastMatchLinks', // fix180: GameTabs H2H, Result / Upcoming rows
    'game.standingsTab',
    'game.liveChance',
    'game.events',
    'game.stats',
    'game.livePlayerStats', // fix208: live box score (LiveBox)
    'game.scorers', // fix209: each team's top scorer under the score (basketballScorers), live and final; the row arrow
    'game.savedBadge',
    'game.morePredictions', 'record.morePredictions', // fix204
    'game.howItWorks', // fix206: "How does this work?" in ModelName + the sport's how-it-works page (components/sport/HowItWorks)
    'game.modelName', // fix191: ModelName in the shared WinnerPrediction
    'team.analysis',
    // fix215: season forecast (components/sport/forecast/*)
    'team.seasonForecast',
    'league.seasonForecast',
    'game.whatItMeans',
    'team.ratingTiles',
    'team.scores',
    'team.rankOverTime',
    'team.ourRecord',
    'team.squad',
    'team.fixtures',
    'team.news',
    'player.stats',
    'player.photo', // fix211: Commons photo + credit (BbPlayer), also in the box score and search
    'player.career',
    'player.injuries',
    'league.table',
    'league.leaders',
    'league.favoriteStar',
    'league.hubLink',
    'league.recordTile',
    'league.logo',
    'league.liveNextResults',
    'search.teams',
    'search.players',
    'search.leagues',
    'search.games',
    'favorites.calendar' // fix205: CalendarCard in components/sport/Favorites
  ]
}

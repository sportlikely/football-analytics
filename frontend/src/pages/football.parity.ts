import type { ParityProvides } from '../lib/sportParity'

/** fix175: the parity keys the game, team, player and league pages (pages/MatchDetail, Team, Player, League) and search feeds for football (checked by npm run parity). */
export const PARITY_PROVIDES: ParityProvides = {
  sport: 'football',
  keys: [
    'game.prediction',
    'game.why',
    'game.howCalculated',
    'game.preview',
    'game.beforeAfter',
    'game.lineups',
    'game.injuries',
    'game.h2h',
    'game.form',
    'game.restTab',
    'game.pastMatchLinks', // fix180: MatchDetail H2H / form / rest rows (RowLink), team page fixtures
    'game.standingsTab',
    'game.liveChance',
    'game.swingChart',
    'game.events',
    'game.stats',
    'game.livePlayerStats', // fix208: live line-ups + events (as before)
    'game.scorers', // fix209: GamePage scorers (lib/scorers footballScorers) + GameRow / ResultsCard arrow
    'game.highlights',
    'game.savedBadge',
    'game.morePredictions', 'record.morePredictions', // fix204
    'game.howItWorks', // fix206: "How does this work?" in ModelName + the sport's how-it-works page (components/sport/HowItWorks)
    'game.modelName', // fix191: ModelName under the prediction
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
    'team.miniTable',
    'team.news',
    'player.stats',
    'player.photo', // API-Football photo (Player.tsx)
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

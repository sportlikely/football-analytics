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
    'game.whyFactors', // fix282: WhyPanel in the shared WinnerPrediction
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
    'game.livePlayerStats', // fix208: live point stats from the tape
    'game.scorers', // fix209: set scores under the score + the set table by player with the game score while live (TennisMatch)
    'game.highlights',
    'game.savedBadge',
    'game.morePredictions', 'record.morePredictions', // fix204
    'game.howItWorks', // fix206: "How does this work?" in ModelName + the sport's how-it-works page (components/sport/HowItWorks)
    'game.modelName',
    'team.analysis', // player page: strengths & weaknesses
    'team.ratingTiles', // How our model rates them
    'team.scores', // 1–10 tour scores
    'team.rankOverTime', // ranking, last 12 months
    'team.ourRecord',
    'team.fixtures', // next match + recent results
    'game.trends', 'game.weather', 'team.difficulty', // fix231: GameExtras (all matches / this surface; outdoors) / TeamDifficulty on the player page
    'team.miniTable', // the ranking around the player
    'team.news',
    'player.stats', // serve / return numbers (Player analysis)
    'player.photo', // fix241: initials + flag (official photos only; TennisPlayer, match header, rows, rankings, search)
    'player.career', // titles in our data
    'player.injuries', // stoppages
    'league.table', // tournament: the draw
    'league.favoriteStar',
    'league.hubLink', // /tennis/predictions/<tournament>
    'league.recordTile',
    'league.liveNextResults',
    'search.players',
    'search.leagues', // tournaments
    'search.games',
    'favorites.calendar' // fix205: CalendarCard in components/sport/Favorites
  ]
}

/**
 * Sport parity (fix175). Football is the template: every block on a football page exists on the same page of every
 * sport. One entry per feature block, a claim per sport:
 *  - true: the sport feeds it (one of its *.parity.ts files lists the key);
 *  - 'na: <reason>': doesn't exist in that sport / no provider data — Yarin approves every one (docs/notes/sport-parity.md);
 *  - 'todo: <reason>': a known gap from the fix175 audit (18 Oct 2026), red on the admin card and listed in
 *    sport-parity.md until it is built.
 *
 * `npm run parity` (scripts/parity-check.ts) fails when a sport neither provides a key nor explains it, when a sport now
 * provides a key marked 'na' / 'todo' (flip it to true), and when a shared component gets a prop from football that no
 * other sport passes. Keep this file plain data (the check script runs it with Node's type stripping): no imports.
 */

export const PARITY_SPORTS = ['football', 'basketball', 'nfl', 'tennis'] as const
export type ParitySport = (typeof PARITY_SPORTS)[number]
type Claim = true | `na: ${string}` | `todo: ${string}`
export interface ParityEntry { key: string; label: string; football: true | `todo: ${string}`; basketball: Claim; nfl: Claim; tennis: Claim }

export const PARITY = [
  /* ---------- home ---------- */
  { key: 'home.record', label: 'Our record card + link', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'home.results', label: 'Latest results + link', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'home.introStats', label: 'First-visit stat tiles', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'home.special', label: 'Special card (draw picks / upset watch)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'home.favorites', label: 'Your favorites rail', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'favorites.calendar', label: 'Calendar subscription card on the Favorites page (fix205)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'home.news', label: 'News', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'home.modelName', label: 'Public model name on the featured card (SL <Sport> <version>, fix191)', football: true, basketball: true, nfl: true, tennis: true },
  /* ---------- games list ---------- */
  { key: 'games.liveBox', label: 'Live box on the games list', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'games.spotlight', label: 'Spotlight', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'games.leaguePanel', label: 'League panel', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'games.leagueList', label: 'League list on the games page (All leagues / My favorites / Pinned / My teams)', football: true, basketball: true, nfl: 'na: only two leagues; the NFL / College switch replaces it', tennis: true },
  /* ---------- game page ---------- */
  { key: 'game.prediction', label: 'Prediction', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.why', label: 'Why we think so', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.howCalculated', label: 'How we calculated it', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.preview', label: 'Match / game preview text', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.beforeAfter', label: 'Before / after (saved prediction vs result)', football: true, basketball: true, nfl: true, tennis: 'na: no line-up or injury news moves a tennis prediction (it only updates from new results until the first serve)' },
  { key: 'game.lineups', label: 'Starters / line-ups', football: true, basketball: true, nfl: true, tennis: 'na: individual sport, no line-ups' },
  { key: 'game.injuries', label: 'Injuries', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.h2h', label: 'Head-to-head', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.form', label: 'Form', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.restTab', label: 'Rest tab', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.pastMatchLinks', label: 'Past-match rows link to the match (H2H, form, rest / schedule)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.standingsTab', label: 'Standings tab', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.liveChance', label: 'Live win chance', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.swingChart', label: 'Win-chance swing chart', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.events', label: 'Events / quarter strip', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.stats', label: 'Game stats', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.highlights', label: 'Video highlights', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.savedBadge', label: 'Saved before kick-off', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.morePredictions', label: 'More predictions block under the prediction (fix204)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'record.morePredictions', label: 'More predictions section on the record page (fix204)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.crawler.moreSentence', label: 'Crawler game page: one More predictions sentence (fix204)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.modelName', label: 'Public model name + version line under the prediction (ModelName, fix191)', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'game.howItWorks', label: 'How-it-works link under the prediction + the how-it-works page of the sport (fix206)', football: true, basketball: true, nfl: true, tennis: true },
  /* ---------- team page ---------- */
  { key: 'team.analysis', label: 'Strengths & weaknesses', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.ratingTiles', label: 'Model rating tiles', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.scores', label: '1–10 league scores', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.rankOverTime', label: 'Rank over time', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.ourRecord', label: 'Our record on the team', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.squad', label: 'Squad', football: true, basketball: true, nfl: true, tennis: 'na: individual sport, no squad (the player page is the team page)' },
  { key: 'team.fixtures', label: 'Fixtures', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.miniTable', label: 'Mini table', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'team.news', label: 'Team news', football: true, basketball: true, nfl: true, tennis: true },
  /* ---------- player page ---------- */
  { key: 'player.stats', label: 'Player stats', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'player.career', label: 'Career', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'player.injuries', label: 'Injury history', football: true, basketball: true, nfl: true, tennis: true },
  /* ---------- league page ---------- */
  { key: 'league.table', label: 'Table', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'league.leaders', label: 'Leaders', football: true, basketball: true, nfl: true, tennis: 'na: individual sport, no player leaders inside a tournament (the Rankings page lists the top players)' },
  { key: 'league.favoriteStar', label: 'Favorite star', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'league.hubLink', label: 'Weekly hub link', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'league.recordTile', label: 'Record tile', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'league.logo', label: 'League logo', football: true, basketball: true, nfl: "na: the provider's NFL / college league images are its 'image not available' placeholder", tennis: 'na: the provider has no tournament logos' },
  { key: 'league.liveNextResults', label: 'Live / next / results', football: true, basketball: true, nfl: true, tennis: true },
  /* ---------- search ---------- */
  { key: 'search.teams', label: 'Search: teams', football: true, basketball: true, nfl: true, tennis: 'na: individual sport, search finds players and tournaments' },
  { key: 'search.players', label: 'Search: players', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'search.leagues', label: 'Search: leagues', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'search.games', label: 'Search: games', football: true, basketball: true, nfl: true, tennis: true },
  /* ---------- search engines ---------- */
  { key: 'seo.crawler.home', label: 'Crawler page: home', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.crawler.game', label: 'Crawler page: game', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.crawler.team', label: 'Crawler page: team', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.crawler.player', label: 'Crawler page: player', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.crawler.league', label: 'Crawler page: league', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.sitemap.game', label: 'Sitemap: games', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.sitemap.team', label: 'Sitemap: teams', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.sitemap.player', label: 'Sitemap: players', football: true, basketball: true, nfl: true, tennis: true },
  { key: 'seo.sitemap.league', label: 'Sitemap: leagues', football: true, basketball: true, nfl: true, tennis: true }
] as const satisfies readonly ParityEntry[]

export type ParityKey = (typeof PARITY)[number]['key']
/** What one sport's adapter feeds (exported as PARITY_PROVIDES from a *.parity.ts file next to it). */
export interface ParityProvides { sport: ParitySport; keys: readonly ParityKey[] }

/**
 * Props of a shared component that only football passes, with the reason (Component.prop → reason). Anything not
 * listed here fails the check when basketball and NFL don't pass it too.
 */
export const FOOTBALL_ONLY_PROPS: Record<string, string> = {}

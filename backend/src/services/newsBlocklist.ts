/**
 * fix180: news that never reaches the site (every sport), checked before a story is stored and again when news is
 * served. Stats / data pages and prediction-tip pages are not news; youth, women's and reserve-team stories don't
 * belong to a men's senior league. Betting stories are filtered in news.ts (isBettingStory, no-bookmakers rule).
 */

/** Stats / data sites that publish auto-generated pages, not news (outlet names as feeds show them, lower case). */
export const BLOCKED_SOURCES = [
  'apwin', 'apwin.com', 'footystats', 'footystats.org', 'soccerstats', 'soccerstats.com', 'flashscore', 'flashscore.com',
  'sofascore', 'sofascore.com', 'fotmob', 'fotmob.com', 'livescore', 'livescore.com', 'besoccer', 'besoccer.com',
  'statarea', 'forebet', 'forebet.com', 'predictz', 'windrawwin', 'betensured', 'scores24', 'scores24.live', 'aiscore',
  'sportskeeda live score', 'oddspedia', 'betexplorer', 'oddschecker', 'covers.com', 'pickswise', 'sportytrader'
];

/** Titles of stats pages, live-score pages and prediction tips. */
export const JUNK_TITLE = /team stats|latest .*statistics|stats (?:&|and) head[- ]to[- ]head|live score|line-?ups? and stats|betting|\bodds\b|\bprediction|\btips?\b|preview (?:&|and) prediction|head to head stats|h2h stats|match stats|player ratings? and stats/i;

/** Youth / women / reserves (dropped when the league is a men's senior league). */
export const YOUTH_WOMEN = /\bU-?\d{2}\b|\bWU\d{2}\b|under-\d{2}|\bwomen'?s?\b|\bladies\b|\breserves\b|\bacademy\b/i;

export function isBlockedSource(source: string): boolean {
  const s = String(source || '').toLowerCase().trim();
  return BLOCKED_SOURCES.some(b => s === b || s.endsWith(` ${b}`) || s.replace(/^www\./, '') === b);
}

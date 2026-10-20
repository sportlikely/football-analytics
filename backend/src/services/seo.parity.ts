/**
 * fix175: the search-engine pages and sitemaps (seo.ts) per sport, for the sport parity check
 * (frontend/scripts/parity-check.ts reads this file; keys are checked against frontend/src/lib/sportParity.ts).
 */
export const PARITY_PROVIDES = [
  { sport: 'football', keys: ['seo.crawler.player', 'seo.sitemap.player', 'seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.league'] },
  { sport: 'basketball', keys: ['seo.crawler.player', 'seo.sitemap.player', 'seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.league'] },
  { sport: 'nfl', keys: ['seo.sitemap.player', 'seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.player', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.league'] },
  // fix193c (seoTennis.ts): Team → Player, League → Tournament (+ the weekly tournament hubs); players in sitemap-players.xml
  { sport: 'tennis', keys: ['seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.player', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.player', 'seo.sitemap.league'] }
];

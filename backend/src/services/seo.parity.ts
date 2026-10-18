/**
 * fix175: the search-engine pages and sitemaps (seo.ts) per sport, for the sport parity check
 * (frontend/scripts/parity-check.ts reads this file; keys are checked against frontend/src/lib/sportParity.ts).
 */
export const PARITY_PROVIDES = [
  { sport: 'football', keys: ['seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.league'] },
  { sport: 'basketball', keys: ['seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.league'] },
  { sport: 'nfl', keys: ['seo.crawler.home', 'seo.crawler.game', 'seo.crawler.team', 'seo.crawler.player', 'seo.crawler.league', 'seo.sitemap.game', 'seo.sitemap.team', 'seo.sitemap.league'] }
];

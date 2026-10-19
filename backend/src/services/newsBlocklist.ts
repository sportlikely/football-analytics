/**
 * fix180: news that never reaches the site (every sport), checked before a story is stored and again when news is
 * served. Stats / data pages and prediction-tip pages are not news; youth, women's and reserve-team stories don't
 * belong to a men's senior league. Betting stories are filtered in news.ts (isBettingStory, no-bookmakers rule).
 * fix181: spam / clickbait (its domain is blocked automatically, news_blocked_domains), stories of another sport,
 * game-log pages, business / broadcast items that name no team.
 */
import { db } from '../db';

/** Stats / data sites that publish auto-generated pages, not news (outlet names as feeds show them, lower case). */
export const BLOCKED_SOURCES = [
  'apwin', 'apwin.com', 'footystats', 'footystats.org', 'soccerstats', 'soccerstats.com', 'flashscore', 'flashscore.com',
  'sofascore', 'sofascore.com', 'fotmob', 'fotmob.com', 'livescore', 'livescore.com', 'besoccer', 'besoccer.com',
  'statarea', 'forebet', 'forebet.com', 'predictz', 'windrawwin', 'betensured', 'scores24', 'scores24.live', 'aiscore',
  'sportskeeda live score', 'oddspedia', 'betexplorer', 'oddschecker', 'covers.com', 'pickswise', 'sportytrader'
];

/** Titles of stats pages, live-score pages, game logs and prediction tips. */
export const JUNK_TITLE = /team stats|latest .*statistics|stats (?:&|and) head[- ]to[- ]head|live score|line-?ups? and stats|betting|\bodds\b|\bprediction|\btips?\b|preview (?:&|and) prediction|head to head stats|h2h stats|match stats|player ratings? and stats|game log|match log|player stats/i;

/** Youth / women / reserves (dropped when the league is a men's senior league). */
export const YOUTH_WOMEN = /\bU-?\d{2}\b|\bWU\d{2}\b|under-\d{2}|\bwomen'?s?\b|\bladies\b|\breserves\b|\bacademy\b/i;

/** Spam / adult / clickbait. */
export const SPAM = /viral video|full video|leaked|\bsexy?\b|onlyfans|【|】|!!|\bxxx\b|\bporn|\bnude\b|\bscandal video\b|\bmms\b|watch full|link video/i;
/** Mostly non-Latin letters (the site is in Latin-script languages; such titles in English searches are clickbait). */
export function mostlyNonLatin(title: string): boolean {
  const letters = [...String(title || '')].filter(c => /\p{L}/u.test(c));
  if (letters.length < 8) return false;
  const latin = letters.filter(c => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.6;
}

/** Stories of another sport (football / basketball / American football news). Case-sensitive league acronyms. */
const OTHER_SPORT: Record<string, { words: RegExp; acronyms: RegExp }> = {
  football: {
    words: /tennis|touchdown|quarterback|basketball|futsal|beach soccer|rugby|cricket|handball|volleyball|ice hockey|baseball|formula 1|grand prix/i,
    acronyms: /\b(ATP|WTA|NFL|NBA|NHL|MLB|WNBA)\b/
  },
  basketball: {
    words: /\bsoccer\b|premier league|champions league|\btennis\b|touchdown|quarterback|futsal|rugby|cricket|handball|volleyball|ice hockey|baseball|footballer/i,
    acronyms: /\b(ATP|WTA|NFL|NHL|MLB|UEFA|FIFA)\b/
  },
  'american-football': {
    words: /basketball|\bsoccer\b|premier league|champions league|\btennis\b|futsal|rugby|cricket|handball|volleyball|ice hockey|baseball|hoops|footballer/i,
    acronyms: /\b(NBA|WNBA|NHL|MLB|ATP|WTA|UEFA|FIFA)\b/
  }
};
export function otherSport(title: string, summary: string, sport: string): boolean {
  const o = OTHER_SPORT[sport] || OTHER_SPORT.football;
  const text = `${title} ${summary || ''}`;
  return o.words.test(text) || o.acronyms.test(text);
}

/** Business / broadcast items (dropped when they name no team). */
export const BUSINESS = /\blands on\b|\blaunch(es|ed)?\b|\bpartnership\b|\bpartners with\b|\bsponsor(ship)?\b|broadcast(ing)? (rights|deal)|\bstreaming\b|\bTV deal\b|\bchannel\b|\bsubscribers?\b|\brevenue\b|\bshares\b|\bstock\b|\bIPO\b|\bapp\b|\bplatform\b|\bsmart TV\b|\bSky Glass\b/i;

export function isBlockedSource(source: string): boolean {
  const s = String(source || '').toLowerCase().trim();
  return BLOCKED_SOURCES.some(b => s === b || s.endsWith(` ${b}`) || s.replace(/^www\./, '') === b);
}

/* domains blocked automatically after a spam story (fix181) */
db.exec(`CREATE TABLE IF NOT EXISTS news_blocked_domains (domain TEXT PRIMARY KEY, reason TEXT, at TEXT NOT NULL)`);
let blocked: Set<string> | null = null;
export function isBlockedDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  if (!blocked) blocked = new Set((db.prepare(`SELECT domain FROM news_blocked_domains`).all() as any[]).map(r => r.domain));
  const d = domain.toLowerCase();
  return [...blocked].some(b => d === b || d.endsWith('.' + b));
}
export function blockDomain(domain: string | null | undefined, reason: string) {
  if (!domain || isBlockedDomain(domain)) return;
  db.prepare(`INSERT OR IGNORE INTO news_blocked_domains (domain, reason, at) VALUES (?, ?, ?)`).run(domain.toLowerCase(), reason.slice(0, 200), new Date().toISOString());
  blocked?.add(domain.toLowerCase());
}

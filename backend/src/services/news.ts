/**
 * Football news: headlines from public RSS feeds of major outlets, filed per league.
 * We show the headline, the outlet, the time and a link to the original article (no copying of articles or photos).
 *
 * Oct 2026: every league has its own news.
 *  - General feeds (BBC, Guardian, ESPN, Sky) plus league feeds (BBC / Guardian league sections, Sky Premier League).
 *  - Each story is filed under a league when it comes from that league's feed, names the league ("La Liga",
 *    "Eredivisie"…) or names one of the league's current teams (team names from our API-Football fixtures).
 *  - Stories are stored (news_items) for 21 days, so a quieter league still has a page of news.
 *  - All feeds refresh every 15 minutes in the background; a feed that fails is skipped (and retried later).
 * Home page = every story combined; league page = that league's stories.
 */
import logger from '../utils/logger';
import { schoolName, collegeNick } from './nfl';
import { db } from '../db';
import { every, after } from './perf';
import { isBlockedSource, JUNK_TITLE, YOUTH_WOMEN } from './newsBlocklist';

type Sport = 'football' | 'basketball' | 'american-football';
type Feed = { source: string; url: string; league?: string; sport?: Sport; search?: boolean };

const UA = { 'User-Agent': 'SportLikely/1.0 (+https://sportlikely.com)' };
const BBC = (path: string) => `https://feeds.bbci.co.uk/sport/football/${path}/rss.xml`;
const GDN = (tag: string) => `https://www.theguardian.com/football/${tag}/rss`;

const FEEDS: Feed[] = [
  // general football news (every league; stories are filed by the names they mention)
  { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/football/rss' },
  { source: 'ESPN', url: 'https://www.espn.com/espn/rss/soccer/news' },
  { source: 'Sky Sports', url: 'https://www.skysports.com/rss/11095' },
  { source: 'BBC Sport', url: BBC('european') },
  { source: 'The Guardian', url: GDN('europeanfootball') },
  // league sections
  { source: 'BBC Sport', url: BBC('premier-league'), league: 'PL' },
  { source: 'The Guardian', url: GDN('premierleague'), league: 'PL' },
  { source: 'Sky Sports', url: 'https://www.skysports.com/rss/11661', league: 'PL' },
  { source: 'BBC Sport', url: BBC('championship'), league: 'ELC' },
  { source: 'The Guardian', url: GDN('championship'), league: 'ELC' },
  { source: 'BBC Sport', url: BBC('league-one'), league: 'AF41' },
  { source: 'The Guardian', url: GDN('leagueonefootball'), league: 'AF41' },
  { source: 'The Guardian', url: GDN('laligafootball'), league: 'PD' },
  { source: 'The Guardian', url: GDN('serieafootball'), league: 'SA' },
  { source: 'The Guardian', url: GDN('bundesligafootball'), league: 'BL1' },
  { source: 'The Guardian', url: GDN('ligue1football'), league: 'FL1' },
  { source: 'BBC Sport', url: BBC('scottish'), league: 'AF179' },
  { source: 'The Guardian', url: GDN('scottish-premiership'), league: 'AF179' },
  { source: 'The Guardian', url: GDN('mls'), league: 'AF253' },
  { source: 'BBC Sport', url: BBC('champions-league'), league: 'CL' },
  { source: 'The Guardian', url: GDN('championsleague'), league: 'CL' },
  { source: 'BBC Sport', url: BBC('europa-league'), league: 'AF3' },
  { source: 'The Guardian', url: GDN('uefa-europa-league'), league: 'AF3' },
  { source: 'The Guardian', url: GDN('europa-conference-league'), league: 'AF848' },
  // basketball (Oct 2026): NBA and the European leagues; stories are filed by league names and team names
  { source: 'ESPN', url: 'https://www.espn.com/espn/rss/nba/news', league: 'NBA', sport: 'basketball' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/sport/nba/rss', league: 'NBA', sport: 'basketball' },
  { source: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nba/', league: 'NBA', sport: 'basketball' },
  { source: 'Yahoo Sports', url: 'https://sports.yahoo.com/nba/rss.xml', league: 'NBA', sport: 'basketball' },
  { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/basketball/rss.xml', sport: 'basketball' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/sport/basketball/rss', sport: 'basketball' },
  { source: 'Eurohoops', url: 'https://www.eurohoops.net/en/feed/', sport: 'basketball' },
  { source: 'Sportando', url: 'https://sportando.basketball/en/feed/', sport: 'basketball' },
  // NFL (fix138; each feed checked on 16 Oct 2026)
  { source: 'ESPN', url: 'https://www.espn.com/espn/rss/nfl/news', league: 'NFL', sport: 'american-football' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/sport/nfl/rss', league: 'NFL', sport: 'american-football' },
  { source: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/nfl/', league: 'NFL', sport: 'american-football' },
  { source: 'Yahoo Sports', url: 'https://sports.yahoo.com/nfl/rss.xml', league: 'NFL', sport: 'american-football' },
  { source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/american-football/rss.xml', league: 'NFL', sport: 'american-football' },
  { source: 'ProFootballTalk', url: 'https://profootballtalk.nbcsports.com/feed/', league: 'NFL', sport: 'american-football' },
  // College football (fix142; each feed checked on 16 Oct 2026)
  { source: 'ESPN', url: 'https://www.espn.com/espn/rss/ncf/news', league: 'NCAA', sport: 'american-football' },
  { source: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/', league: 'NCAA', sport: 'american-football' },
  { source: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss.xml', league: 'NCAA', sport: 'american-football' },
  { source: 'The Guardian', url: 'https://www.theguardian.com/sport/college-football/rss', league: 'NCAA', sport: 'american-football' }
];

/** Basketball leagues for filing stories (team names come from bb_games). */
const BB_NEWS_LEAGUES: { code: string; name: string; phrases: string[]; not?: string[] }[] = [
  { code: 'NBA', name: 'NBA', phrases: ['NBA'], not: ['ex-', 'former'] },
  { code: 'EL', name: 'EuroLeague', phrases: ['EuroLeague', 'Euroleague', 'Turkish Airlines EuroLeague'] },
  { code: 'ACB', name: 'Liga ACB', phrases: ['Liga ACB', 'Liga Endesa', 'ACB'] },
  { code: 'LBA', name: 'Lega Basket Serie A', phrases: ['Lega Basket', 'LBA', 'Serie A'] },
  { code: 'BSL', name: 'Basketbol Süper Ligi', phrases: ['Basketbol Süper Ligi', 'Turkish Super League', 'Turkish BSL', 'BSL'] },
  { code: 'LNB', name: 'LNB Pro A', phrases: ['LNB', 'Pro A', 'Betclic Elite', 'Betclic ELITE'] },
  { code: 'BBL', name: 'Basketball Bundesliga', phrases: ['easyCredit BBL', 'Basketball Bundesliga', 'BBL'] },
  { code: 'GBL', name: 'Greek Basket League', phrases: ['Greek Basket League', 'Greek League', 'GBL'] },
  { code: 'LKL', name: 'LKL', phrases: ['LKL', 'Lithuanian League'] },
  { code: 'EC', name: 'EuroCup', phrases: ['EuroCup', 'Eurocup', 'BKT EuroCup'] },
  { code: 'BCL', name: 'Basketball Champions League', phrases: ['Basketball Champions League', 'BCL'] },
  { code: 'ABA', name: 'ABA League', phrases: ['ABA League', 'AdmiralBet ABA League', 'ABA'] },
  { code: 'FEC', name: 'FIBA Europe Cup', phrases: ['FIBA Europe Cup'] },
  { code: 'NBL', name: 'NBL', phrases: ['NBL'] },
  { code: 'JBL', name: 'B.League', phrases: ['B.League', 'B League'] },
  { code: 'CBA', name: 'CBA', phrases: ['CBA'] },
  { code: 'NBB', name: 'NBB', phrases: ['NBB'] },
  { code: 'BSN', name: 'BSN', phrases: ['BSN'] }
];
const BB_LEAGUE_NAME = new Map(BB_NEWS_LEAGUES.map(l => [l.code, l.name]));

/**
 * Our leagues: name, API-Football league id (its current teams tag stories) and the phrases that name the league.
 * Phrases are matched case-sensitively on whole words; `not` drops a phrase hit preceded by those words
 * ("Austrian Bundesliga" is not the Bundesliga).
 */
export const NEWS_LEAGUES: { code: string; name: string; af?: number; phrases: string[]; not?: string[] }[] = [
  { code: 'PL', name: 'Premier League', af: 39, phrases: ['Premier League'], not: ['Scottish', 'Russian', 'Ukrainian', 'Egyptian', 'Israeli', 'Women’s', "Women's", 'Welsh', 'Northern Irish', 'Irish', 'Indian', 'Saudi'] },
  { code: 'ELC', name: 'Championship', af: 40, phrases: ['EFL Championship'] },
  { code: 'AF41', name: 'League One', af: 41, phrases: ['League One'] },
  { code: 'PD', name: 'La Liga', af: 140, phrases: ['La Liga', 'LaLiga'] },
  { code: 'AF141', name: 'Segunda División', af: 141, phrases: ['Segunda División', 'Segunda Division', 'LaLiga Hypermotion'] },
  { code: 'SA', name: 'Serie A', af: 135, phrases: ['Serie A'], not: ['Brazilian', 'Brazil’s', "Brazil's"] },
  { code: 'AF136', name: 'Serie B', af: 136, phrases: ['Serie B'], not: ['Brazilian'] },
  { code: 'BL1', name: 'Bundesliga', af: 78, phrases: ['Bundesliga'], not: ['2.', 'Austrian', 'Austria’s', "Austria's", 'Women’s', "Women's"] },
  { code: 'AF79', name: '2. Bundesliga', af: 79, phrases: ['2. Bundesliga', 'Bundesliga 2'] },
  { code: 'FL1', name: 'Ligue 1', af: 61, phrases: ['Ligue 1', 'Ligue Un'] },
  { code: 'AF62', name: 'Ligue 2', af: 62, phrases: ['Ligue 2'] },
  { code: 'DED', name: 'Eredivisie', af: 88, phrases: ['Eredivisie'] },
  { code: 'PPL', name: 'Primeira Liga', af: 94, phrases: ['Primeira Liga', 'Liga Portugal'] },
  { code: 'AF144', name: 'Belgian Pro League', af: 144, phrases: ['Belgian Pro League', 'Jupiler Pro League', 'Belgian top flight'] },
  { code: 'AF203', name: 'Süper Lig', af: 203, phrases: ['Süper Lig', 'Super Lig', 'Turkish Super League'] },
  { code: 'AF179', name: 'Scottish Premiership', af: 179, phrases: ['Scottish Premiership'] },
  { code: 'AF180', name: 'Scottish Championship', af: 180, phrases: ['Scottish Championship'] },
  { code: 'AF197', name: 'Greek Super League', af: 197, phrases: ['Greek Super League', 'Super League Greece'] },
  { code: 'AF71', name: 'Brasileirão', af: 71, phrases: ['Brasileirão', 'Brasileirao', 'Brazilian Serie A', 'Brazilian league'] },
  { code: 'AF128', name: 'Liga Profesional (Argentina)', af: 128, phrases: ['Liga Profesional', 'Argentine Primera', 'Argentine league'] },
  { code: 'AF253', name: 'MLS', af: 253, phrases: ['MLS', 'Major League Soccer'] },
  { code: 'AF262', name: 'Liga MX', af: 262, phrases: ['Liga MX'] },
  { code: 'AF98', name: 'J1 League', af: 98, phrases: ['J1 League', 'J.League', 'J-League', 'J League'] },
  { code: 'AF119', name: 'Danish Superliga', af: 119, phrases: ['Danish Superliga', 'Superligaen'] },
  { code: 'AF106', name: 'Ekstraklasa', af: 106, phrases: ['Ekstraklasa'] },
  { code: 'AF103', name: 'Eliteserien', af: 103, phrases: ['Eliteserien'] },
  { code: 'AF113', name: 'Allsvenskan', af: 113, phrases: ['Allsvenskan'] },
  { code: 'AF218', name: 'Austrian Bundesliga', phrases: ['Austrian Bundesliga'] },
  { code: 'AF207', name: 'Swiss Super League', phrases: ['Swiss Super League'] },
  { code: 'AF383', name: "Ligat Ha'Al", phrases: ["Ligat Ha'Al", 'Israeli Premier League'] },
  { code: 'AF307', name: 'Saudi Pro League', phrases: ['Saudi Pro League', 'Saudi Professional League'] },
  { code: 'CL', name: 'Champions League', phrases: ['Champions League'], not: ['AFC', 'CAF', 'Concacaf', 'CONCACAF', 'Women’s', "Women's", 'Asian', 'African'] },
  { code: 'AF3', name: 'Europa League', phrases: ['Europa League'] },
  { code: 'AF848', name: 'Conference League', phrases: ['Conference League', 'Europa Conference League'] }
];
const LEAGUE_NAME = new Map(NEWS_LEAGUES.map(l => [l.code, l.name]));

/** Headline spellings of API-Football team names (normalized name → extra names). */
const TEAM_ALIASES: Record<string, string[]> = {
  'manchester united': ['Man Utd', 'Man United'],
  'manchester city': ['Man City'],
  'tottenham': ['Spurs', 'Tottenham Hotspur'],
  'wolves': ['Wolverhampton'],
  'nottingham forest': ["Nott'm Forest"],
  'bayern munchen': ['Bayern Munich', 'Bayern'],
  'borussia dortmund': ['Dortmund'],
  'borussia monchengladbach': ['Gladbach', 'Monchengladbach', 'Mönchengladbach'],
  'bayer leverkusen': ['Leverkusen'],
  'rb leipzig': ['Leipzig'],
  'eintracht frankfurt': ['Frankfurt'],
  '1899 hoffenheim': ['Hoffenheim'],
  '1. fc koln': ['Cologne', 'Köln'],
  'paris saint germain': ['PSG', 'Paris St-Germain', 'Paris Saint-Germain'],
  'olympique marseille': ['Marseille'],
  'olympique lyonnais': ['Lyon'],
  'atletico madrid': ['Atlético Madrid', 'Atlético', 'Atletico'],
  'athletic club': ['Athletic Bilbao'],
  'ac milan': ['Milan'],
  'inter': ['Inter Milan', 'Internazionale'],
  'as roma': ['Roma'],
  'sporting cp': ['Sporting Lisbon', 'Sporting'],
  'fc porto': ['Porto'],
  'sl benfica': ['Benfica'],
  'olympiakos piraeus': ['Olympiacos', 'Olympiakos'],
  'legia warszawa': ['Legia Warsaw', 'Legia'],
  'fc copenhagen': ['Copenhagen', 'FC København'],
  'bodo/glimt': ['Bodø/Glimt', 'Bodo/Glimt'],
  'fenerbahce': ['Fenerbahçe'],
  'besiktas': ['Beşiktaş'],
  'qpr': ['Queens Park Rangers'],
  'psv eindhoven': ['PSV'],
  'ajax': ['Ajax'],
  'club america': ['Club América'],
  'river plate': ['River Plate'],
  'boca juniors': ['Boca Juniors', 'Boca']
};
/** Short team names that are also ordinary words, cities or surnames: matched only in their full form. */
const RISKY = new Set(['america', 'nice', 'santos', 'leon', 'austin', 'charlotte', 'viking', 'atlas', 'racing', 'nacional', 'juarez', 'union', 'city', 'united', 'real', 'sport', 'chicago', 'toronto', 'vancouver', 'montreal', 'miami', 'orlando', 'houston', 'dallas', 'portland', 'seattle', 'san diego', 'colorado', 'minnesota', 'new york', 'cincinnati', 'columbus', 'philadelphia', 'atlanta', 'nashville', 'kansas city', 'salt lake', 'velez', 'olimpia', 'start', 'sirius']);

export interface NewsItem {
  title: string; link: string; source: string; published: string | null; summary: string; image: string | null;
  leagues: { code: string; name: string }[];
  /** fix180: 'logo' = a league logo / team crest standing in for a missing picture */
  imageKind?: 'photo' | 'logo';
}

db.exec(`
  CREATE TABLE IF NOT EXISTS news_items (
    link      TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    source    TEXT NOT NULL,
    published TEXT,
    summary   TEXT NOT NULL DEFAULT '',
    image     TEXT,
    leagues   TEXT NOT NULL DEFAULT '',   -- ",PL,CL," (comma-wrapped codes)
    seen_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_news_seen ON news_items(seen_at);
`);
try { db.exec(`ALTER TABLE news_items ADD COLUMN sport TEXT NOT NULL DEFAULT 'football'`); } catch { /* column exists */ }

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
const tag = (block: string, name: string) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};

type Raw = Omit<NewsItem, 'leagues'> & { feedLeague?: string; sport: Sport };

/**
 * Betting stories (fix138): odds, betting previews, parlays, sportsbooks and bookmaker brands never reach the site
 * (hard rule: no odds or bookmakers in public). Checked when a feed is read and again when news is served.
 */
const BETTING = /\b(odds|betting|bets?|bettors?|parlays?|sportsbooks?|bookmakers?|wagers?|against the spread|point spreads?|moneyline|prop bets?|player props|fanduel|draftkings|betmgm|caesars sportsbook|bet365|fanatics sportsbook)\b/i;
const BETTING_LINK = /\/(betting|odds|gambling|sportsbook|picks-and-odds)(\/|-|$)/i;
export const isBettingStory = (x: { title: string; summary?: string | null; link: string }) => BETTING.test(x.title) || BETTING.test(x.summary || '') || BETTING_LINK.test(x.link);


async function fetchFeed(f: Feed): Promise<Raw[]> {
  const res = await fetch(f.url, { signal: AbortSignal.timeout(8000), headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items: Raw[] = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const b = m[0];
    const title = tag(b, 'title');
    const link = tag(b, 'link') || (b.match(/<guid[^>]*>(https?:[^<]+)<\/guid>/i)?.[1] ?? '');
    if (!title || !/^https:\/\//.test(link)) continue;
    // fix176: search feeds (Google News) name the real outlet in <source> and add " - Outlet" to the headline
    const outlet = f.search ? tag(b, 'source') : '';
    const cleanTitle = outlet && title.endsWith(` - ${outlet}`) ? title.slice(0, -(outlet.length + 3)) : title;
    if (isBettingStory({ title, summary: tag(b, 'description'), link })) continue;
    // football feeds: football only (some feeds mix in other sports: tennis, F1, cricket…)
    if ((!f.sport || f.sport === 'football') && /\/(tennis|f1|formula-1|cricket|golf|boxing|rugby-union|rugby-league|nfl|nba|darts|racing|cycling|snooker|netball|athletics)\//i.test(link)) continue;
    const pub = tag(b, 'pubDate') || tag(b, 'dc:date');
    const d = pub ? new Date(pub) : null;
    // picture the feed ships with the story (media:content / media:thumbnail / enclosure) — the largest one
    let image: string | null = null, best = -1;
    for (const im of b.matchAll(/<(media:content|media:thumbnail|enclosure)\b([^>]*)>/gi)) {
      const attrs = im[2];
      const url = attrs.match(/url="([^"]+)"/i)?.[1];
      if (!url || !/^https:\/\//.test(url)) continue;
      const type = attrs.match(/type="([^"]+)"/i)?.[1] || '';
      if (type && !/^image\//i.test(type)) continue;
      const w = Number(attrs.match(/width="(\d+)"/i)?.[1] || 0);
      if (w > best) { best = w; image = url.replace(/&amp;/g, '&'); }
    }
    // BBC ships 240px thumbnails; its image server has the same picture at 480px
    if (image && /ichef\.bbci\.co\.uk\/.*\/240\//.test(image)) image = image.replace('/240/', '/480/');
    const summary = tag(b, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); // some feeds escape their HTML
    items.push({
      title: cleanTitle, link, source: outlet || f.source, feedLeague: f.league, sport: f.sport || 'football',
      published: d && !isNaN(d.getTime()) && d.getTime() <= Date.now() + 5 * 60000 ? d.toISOString() : null,
      summary: summary.length > 180 ? summary.slice(0, 177) + '…' : summary, image
    });
    if (items.length >= 30) break;
  }
  // Some feeds (ESPN) stamp every item with the feed's build time, not the article's. That date is meaningless, so drop it.
  if (items.length >= 3 && items.every(it => it.published && it.published === items[0].published)) items.forEach(it => { it.published = null; });
  return items;
}

/*
 * Some feeds (ESPN) ship no picture with their items. The article page's own preview image (og:image — the one
 * the outlet provides for link previews) is used instead. Looked up once per article and stored with it.
 */
async function previewImage(link: string, timeout = 6000): Promise<string | null> {
  try {
    const res = await fetch(link, { signal: AbortSignal.timeout(timeout), headers: UA });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 300_000);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    const url = m?.[1]?.replace(/&amp;/g, '&') || null;
    return url && /^https:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* fix180: pictures, league names, junk                                 */
/* ------------------------------------------------------------------ */

db.exec(`CREATE TABLE IF NOT EXISTS news_pics (link TEXT PRIMARY KEY, url TEXT, image TEXT, at TEXT NOT NULL)`);
const PIC_TIMEOUT = 3000;
/**
 * A Google News link → the publisher's article URL. The link no longer redirects: its own page carries a signature and
 * a timestamp, and Google's decode call returns the URL (two requests, 3 s each). Null when that fails.
 */
async function resolveGoogleNews(link: string): Promise<string | null> {
  const id = link.split('/articles/')[1]?.split('?')[0];
  if (!id) return null;
  try {
    const page = await (await fetch(`https://news.google.com/articles/${id}`, { headers: UA, signal: AbortSignal.timeout(PIC_TIMEOUT) })).text();
    const sig = page.match(/data-n-a-sg="([^"]+)"/)?.[1], ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sig || !ts) return null;
    const req = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sig]), null, 'generic']]];
    const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'f.req=' + encodeURIComponent(JSON.stringify(req)), signal: AbortSignal.timeout(PIC_TIMEOUT)
    });
    const url = (await r.text()).match(/\\"garturlres\\",\\"(https?:[^\\"]+)\\"/)?.[1] || null;
    return url && /^https:\/\//.test(url) ? url : null;
  } catch { return null; }
}
/** A story's picture: the publisher page's og:image / twitter:image (cached by link for 7 days, also when none). */
export async function pictureFor(link: string): Promise<string | null> {
  const c = db.prepare(`SELECT image, at FROM news_pics WHERE link = ?`).get(link) as any;
  if (c && Date.now() - Date.parse(c.at) < 7 * 86400000) return c.image || null;
  const url = /news\.google\.com/.test(link) ? await resolveGoogleNews(link) : link;
  const image = url ? await previewImage(url, PIC_TIMEOUT) : null;
  db.prepare(`INSERT OR REPLACE INTO news_pics (link, url, image, at) VALUES (?, ?, ?, ?)`).run(link, url, image, new Date().toISOString());
  return image;
}
const picQueue = new Set<string>();
let picWorkers = 0;
/** Background picture lookups, 4 at a time; each found picture is saved on the story. */
function queuePictures(links: string[]) {
  for (const l of links) picQueue.add(l);
  while (picWorkers < 4 && picQueue.size) {
    picWorkers++;
    void (async () => {
      const setImg = db.prepare(`UPDATE news_items SET image = ? WHERE link = ? AND image IS NULL`);
      while (picQueue.size) {
        const link = picQueue.values().next().value as string;
        picQueue.delete(link);
        try { const img = await pictureFor(link); if (img) setImg.run(img, link); } catch { /* next */ }
      }
      picWorkers--;
    })();
  }
}

/** League name as the league page shows it (every sport): hand-written names, then the competitions we track. */
const nameCache = new Map<string, { at: number; name: string | null }>();
db.exec(`CREATE TABLE IF NOT EXISTS news_league_names (key TEXT PRIMARY KEY, name TEXT NOT NULL)`);
export function leagueNameOf(code: string, sport: Sport = 'football'): string {
  const fixed = sport === 'basketball' ? BB_LEAGUE_NAME.get(code) : sport === 'american-football' ? (code === 'NCAA' ? 'College football' : code === 'NFL' ? 'NFL' : undefined) : LEAGUE_NAME.get(code);
  if (fixed) return fixed;
  const k = `${sport}|${code}`, c = nameCache.get(k);
  if (c && Date.now() - c.at < (c.name ? 3600 : 300) * 1000) return c.name || code;
  let name: string | null = null;
  try {
    if (sport === 'basketball') name = (db.prepare(`SELECT name FROM bb_leagues WHERE code = ?`).get(code) as any)?.name || null;
    else if (sport === 'football') {
      const { afCompetitions } = require('./afMatches') as typeof import('./afMatches');
      name = afCompetitions().find(x => x.code === code)?.name || null;
      if (!name) name = (db.prepare(`SELECT competition_name AS n FROM predictions WHERE competition_code = ? AND competition_name IS NOT NULL ORDER BY utc_date DESC LIMIT 1`).get(code) as any)?.n || null;
      if (!name && /^AF\d+$/.test(code)) name = (db.prepare(`SELECT name FROM af_extra_leagues WHERE league_id = ?`).get(Number(code.slice(2))) as any)?.name || null;
      if (!name) name = ({ EC: 'European Championship', WC: 'World Cup' } as Record<string, string>)[code] || null;
    }
    // names seen before are kept (the provider's league list loads a while after a restart)
    if (name) db.prepare(`INSERT OR REPLACE INTO news_league_names (key, name) VALUES (?, ?)`).run(k, name);
    else name = (db.prepare(`SELECT name FROM news_league_names WHERE key = ?`).get(k) as any)?.name || null;
  } catch { /* tables not ready */ }
  nameCache.set(k, { at: Date.now(), name });
  return name || code;
}

/** fix180: the picture a story without one gets — its league's logo (football / basketball) or the crest of the NFL /
 *  college team it names; our own mark as the last resort (never a grey tile with a domain name). */
const FD_AF: Record<string, number> = { PL: 39, ELC: 40, PD: 140, SA: 135, BL1: 78, FL1: 61, DED: 88, PPL: 94, CL: 2, BSA: 71, EC: 4, WC: 1 };
let nflCrests: { at: number; list: { re: RegExp; logo: string; league: string }[] } | null = null;
function fallbackPicture(r: any): string {
  const codes = String(r.leagues || '').split(',').filter(Boolean);
  if (r.sport === 'football') {
    for (const c of codes) { const id = /^AF(\d+)$/.exec(c)?.[1] ?? FD_AF[c]; if (id) return `https://media.api-sports.io/football/leagues/${id}.png`; }
  } else if (r.sport === 'basketball') {
    for (const c of codes) {
      try { const l = db.prepare(`SELECT league_id, logo FROM bb_leagues WHERE code = ?`).get(c) as any; if (l) return l.logo || `https://media.api-sports.io/basketball/leagues/${l.league_id}.png`; } catch { /* none */ }
    }
  } else {
    if (!nflCrests || Date.now() - nflCrests.at > 3600 * 1000) {
      const list: { re: RegExp; logo: string; league: string }[] = [];
      try {
        for (const t of db.prepare(`SELECT team_id, logo, league FROM nfl_teams WHERE logo IS NOT NULL`).all() as any[]) {
          const names = nflTeamNamesById(t.team_id).filter(n => n.length >= 4);
          if (names.length) list.push({ re: new RegExp(`(?<![\\p{L}])(?:${names.map(esc).join('|')})(?![\\p{L}])`, 'u'), logo: t.logo, league: t.league === 2 ? 'NCAA' : 'NFL' });
        }
      } catch { /* tables missing */ }
      nflCrests = { at: Date.now(), list };
    }
    const text = norm(`${r.title} ${r.summary || ''}`);
    const hit = nflCrests.list.find(x => (!codes.length || codes.includes(x.league)) && x.re.test(text));
    if (hit) return hit.logo;
  }
  return '/logo-mark.png';
}

/** Stats / tips / youth / women / reserves / stats sites (every sport). */
function isJunk(title: string, source: string, codes: string[], sport: Sport): boolean {
  if (isBlockedSource(source) || JUNK_TITLE.test(title) || isBettingStory({ title, link: '' })) return true;
  if (YOUTH_WOMEN.test(title)) {
    const womensLeague = codes.some(c => /women|ladies|wsl|liga f\b|nwsl|wnba/i.test(leagueNameOf(c, sport)));
    if (!womensLeague) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Filing stories under leagues                                         */
/* ------------------------------------------------------------------ */

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GENERIC = /^(fc|afc|cf|sc|ac|as|ss|sv|vfb|vfl|fk|bk|if|ik|cd|ca|cr|club|sl|rc|rcd|ud|sd|kv|krc|kaa|rsc)\s+|\s+(fc|afc|cf|sc|fk|bk|if|ff|sk|kv|ac)$/i;

let matcher: { re: RegExp; leaguesOf: Map<string, Set<string>> } | null = null;
let matcherAt = 0;

/** One regex over every team name (longest first, so "Inter Miami" wins over "Inter") and every league phrase. */
function buildMatcher() {
  const leaguesOf = new Map<string, Set<string>>();
  const add = (name: string, code: string) => {
    const k = norm(name).trim();
    if (k.length < 3) return;
    if (!leaguesOf.has(k)) leaguesOf.set(k, new Set());
    leaguesOf.get(k)!.add(code);
  };
  for (const l of NEWS_LEAGUES) {
    if (!l.af) continue;
    let names: string[] = [];
    try {
      names = (db.prepare(`
        SELECT DISTINCT n FROM (
          SELECT home_name AS n FROM af_fixtures WHERE league_id = ? AND season = (SELECT MAX(season) FROM af_fixtures WHERE league_id = ? AND kickoff <= datetime('now', '+30 days'))
          UNION SELECT away_name FROM af_fixtures WHERE league_id = ? AND season = (SELECT MAX(season) FROM af_fixtures WHERE league_id = ? AND kickoff <= datetime('now', '+30 days'))
        )`).all(l.af, l.af, l.af, l.af) as any[]).map(r => r.n);
    } catch { /* fixtures table not ready yet */ }
    for (const full of names) {
      const short = full.replace(GENERIC, '').trim();
      const key = norm(full).toLowerCase();
      // the full name always counts; the short form only when it isn't an ordinary word
      add(full, l.code);
      if (short !== full && !RISKY.has(norm(short).toLowerCase())) add(short, l.code);
      for (const a of TEAM_ALIASES[key] || TEAM_ALIASES[norm(short).toLowerCase()] || []) add(a, l.code);
    }
  }
  // a full name that is itself an ordinary word ("Nice", "Viking") is dropped too — the league phrase still files those stories
  for (const k of [...leaguesOf.keys()]) if (RISKY.has(k.toLowerCase())) leaguesOf.delete(k);
  const alts = [...leaguesOf.keys()].sort((a, b) => b.length - a.length).map(esc);
  const re = alts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : /(?!)/g;
  matcher = { re, leaguesOf };
  matcherAt = Date.now();
}

/* basketball: the current season's teams of each league (NBA nicknames too: "Lakers", "Celtics") */
let bbMatcher: { re: RegExp; leaguesOf: Map<string, Set<string>> } | null = null;
const BB_RISKY = new Set(['real', 'union', 'olympia', 'partizan mozzart', 'virtus', 'reggiana']);
/** Names a basketball team goes by in headlines. */
export function bbTeamNames(full: string, code: string): string[] {
  const out = new Set<string>([full]);
  const words = full.split(/\s+/);
  if (code === 'NBA' && words.length > 1) {
    out.add(words[words.length - 1]);                                       // "Lakers", "76ers"
    if (/^(Trail Blazers)$/.test(words.slice(-2).join(' '))) out.add('Trail Blazers');
  } else if (words.length > 1) {
    // European clubs carry sponsors ("Partizan Mozzart Bet", "Crvena Zvezda Meridianbet"): the club part too
    out.add(words.slice(0, 2).join(' '));
    if (words[0].length >= 6 && !BB_RISKY.has(words[0].toLowerCase())) out.add(words[0]);
  }
  return [...out].filter(n => n.length >= 3);
}
function buildBbMatcher() {
  const leaguesOf = new Map<string, Set<string>>();
  let rows: any[] = [];
  try {
    // fix122: the correlated subquery ran MAX(season) once per game row (17 s on the 14 Oct DB copy, blocking the event
    // loop at every 15-minute news refresh); one grouped MAX per league joined back gives the same 393 rows in 18 ms
    rows = db.prepare(`SELECT DISTINCT g.code, g.home_name AS n FROM bb_games g
      JOIN (SELECT code, MAX(season) AS s FROM bb_games GROUP BY code) m ON m.code = g.code AND g.season = m.s`).all() as any[];
  } catch { /* basketball tables not ready */ }
  for (const r of rows) for (const n of bbTeamNames(r.n, r.code)) {
    const k = norm(n).trim();
    if (!leaguesOf.has(k)) leaguesOf.set(k, new Set());
    leaguesOf.get(k)!.add(r.code);
  }
  const alts = [...leaguesOf.keys()].sort((a, b) => b.length - a.length).map(esc);
  bbMatcher = { re: alts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : /(?!)/g, leaguesOf };
}
const bbPhraseRes = BB_NEWS_LEAGUES.map(l => ({
  code: l.code,
  re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${l.phrases.map(p => esc(norm(p))).join('|')})(?![\\p{L}\\p{N}])`, 'gu'),
  not: (l.not || []).map(n => norm(n))
}));

const phraseRes = NEWS_LEAGUES.map(l => ({
  code: l.code,
  re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${l.phrases.map(p => esc(norm(p))).join('|')})(?![\\p{L}\\p{N}])`, 'gu'),
  not: (l.not || []).map(n => norm(n))
}));

/**
 * Names an NFL team goes by in headlines (fix138): the full name, the nickname ("Chiefs", "49ers") and the city /
 * region when only one team has it ("Kansas City"; not "New York" or "Los Angeles"). `cities` = every team's city.
 */
export function nflTeamNames(full: string, cities: string[] = []): string[] {
  const w = full.split(/\s+/);
  const out = new Set<string>([full]);
  if (w.length > 1) {
    out.add(w[w.length - 1]);
    const city = w.slice(0, -1).join(' ');
    if (cities.filter(c => c === city).length <= 1) out.add(city);
  }
  return [...out].filter(n => n.length >= 3);
}
export function nflTeamNamesById(id: number): string[] {
  try {
    const me = db.prepare(`SELECT team_id, name, league FROM nfl_teams WHERE team_id = ?`).get(id) as any;
    if (!me) return [];
    const all = (db.prepare(`SELECT name FROM nfl_teams WHERE league = ?`).all(me.league) as any[]).map(r => String(r.name));
    if (me.league === 2) return collegeTeamNames(me.name, all);
    return nflTeamNames(me.name, all.map(n => n.split(/\s+/).slice(0, -1).join(' ')));
  } catch { return []; }
}
/** College (fix142): the full name, the school ("Ohio State") and the nickname ("Buckeyes", 5+ letters) when no other
 *  college team shares them. */
export function collegeTeamNames(full: string, all: string[]): string[] {
  const out = new Set<string>([full]);
  const school = schoolName(full), nick = collegeNick(full);
  if (school !== full && school.length >= 4 && all.filter(n => n === school || n.startsWith(school + ' ')).length <= 1) out.add(school);
  if (nick.length >= 5 && all.filter(n => n.endsWith(' ' + nick)).length <= 1) out.add(nick);
  return [...out];
}

/** League codes a story belongs to. */
export function leaguesFor(title: string, summary: string, feedLeague?: string, sport: Sport = 'football'): string[] {
  // NFL / college feeds belong to their league only; the team pages find their stories by team name (newsFor team)
  if (sport === 'american-football') return [feedLeague || 'NFL'];
  if (!matcher || Date.now() - matcherAt > 6 * 3600 * 1000) buildMatcher();
  if (sport === 'basketball' && !bbMatcher) buildBbMatcher();
  const M = sport === 'basketball' ? bbMatcher! : matcher!;
  const text = norm(`${title} . ${summary}`);
  const out = new Set<string>(feedLeague ? [feedLeague] : []);
  for (const p of sport === 'basketball' ? bbPhraseRes : phraseRes) {
    for (const m of text.matchAll(p.re)) {
      const before = text.slice(Math.max(0, m.index! - 20), m.index!).trimEnd();
      if (!p.not.some(n => before.endsWith(n))) { out.add(p.code); break; }
    }
  }
  for (const m of text.matchAll(M.re)) {
    const hit = m[0];
    // names are proper nouns: skip a match that starts lower-case ("forest fire")
    if (hit[0] !== hit[0].toUpperCase()) continue;
    for (const c of M.leaguesOf.get(hit) || []) out.add(c);
  }
  return [...out];
}

/* ------------------------------------------------------------------ */
/* Refresh and storage                                                   */
/* ------------------------------------------------------------------ */

const feedStatus = new Map<string, { source: string; league: string | null; ok: boolean; items: number; last14d?: number; newest?: string | null; error: string | null; at: string }>();
let lastRefresh: string | null = null;
let refreshing: Promise<void> | null = null;

async function refresh() {
  const t0 = Date.now();
  const feeds = [...FEEDS, ...searchFeedsOf()]; // fix176: plus a few league searches each time
  const results = await Promise.allSettled(feeds.map(fetchFeed));
  markSearched(feeds);
  const now = new Date().toISOString();
  const raws: Raw[] = [];
  results.forEach((r, i) => {
    const f = feeds[i];
    if (r.status === 'fulfilled') {
      raws.push(...r.value);
      const cut = Date.now() - 14 * 86400000;
      const dated = r.value.map(x => x.published).filter((x): x is string => !!x).sort();
      feedStatus.set(f.url, {
        source: f.source, league: f.league || null, ok: true, items: r.value.length,
        last14d: r.value.filter(x => !x.published || new Date(x.published).getTime() >= cut).length,
        newest: dated.length ? dated[dated.length - 1] : null, error: null, at: now
      });
    } else {
      const msg = (r.reason as any)?.message || String(r.reason);
      const prev = feedStatus.get(f.url);
      if (prev?.ok !== false) logger.warn(`News feed ${f.source} ${f.url} failed`, { message: msg }); // log once per outage
      feedStatus.set(f.url, { source: f.source, league: f.league || null, ok: false, items: 0, error: msg, at: now });
    }
  });
  buildMatcher(); // team lists can change (new season, promotions)
  buildBbMatcher();
  const fresh = storeRaws(raws);
  // pictures for new stories whose feed has none (fix180: one background queue, 4 at a time)
  queuePictures(fresh);
  lastRefresh = now;
  logger.info(`News refreshed: ${raws.length} stories from ${results.filter(r => r.status === 'fulfilled').length}/${feeds.length} feeds, ${fresh.length} new pictures looked up, ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** Files and stores stories (new ones inserted, a known link gets the extra leagues); the new links without a picture. */
function storeRaws(raws: Raw[]): string[] {
  const now = new Date().toISOString();
  const get = db.prepare(`SELECT leagues, image FROM news_items WHERE link = ?`);
  const ins = db.prepare(`INSERT INTO news_items (link, title, source, published, summary, image, leagues, seen_at, sport) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE news_items SET leagues = ?, image = COALESCE(image, ?), published = COALESCE(published, ?) WHERE link = ?`);
  const fresh: string[] = [];
  const titles = new Set<string>();
  db.exec('BEGIN');
  try {
    const dupWithin48h = db.prepare(`SELECT 1 FROM news_items WHERE title = ? AND link != ? AND seen_at >= ? LIMIT 1`);
    const since48 = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    for (const it of raws) {
      const tkey = it.title.toLowerCase().slice(0, 60);
      const codes = leaguesFor(it.title, it.summary, it.feedLeague, it.sport);
      // fix180: junk never stored — stats / live-score / tip pages, stats sites, youth / women / reserves (unless the
      // league itself is a women's league), the same headline from another outlet within 48 h
      if (isJunk(it.title, it.source, codes, it.sport)) continue;
      if (!get.get(it.link) && dupWithin48h.get(it.title, it.link, since48)) continue;
      const old: any = get.get(it.link);
      if (old) {
        // the same story in another feed (league section) adds that league
        const merged = new Set([...String(old.leagues).split(',').filter(Boolean), ...codes]);
        upd.run(merged.size ? `,${[...merged].join(',')},` : '', it.image, it.published, it.link);
        continue;
      }
      if (titles.has(tkey)) continue; // same story twice in one refresh under two links
      titles.add(tkey);
      ins.run(it.link, it.title, it.source, it.published, it.summary, it.image, codes.length ? `,${codes.join(',')},` : '', now, it.sport);
      if (!it.image) fresh.push(it.link); // fix180: Google News stories too (their publisher page is looked up)
    }
    db.prepare(`DELETE FROM news_items WHERE seen_at < ? AND (leagues = '' OR seen_at < ?)`)
      .run(new Date(Date.now() - 21 * 86400000).toISOString(), new Date(Date.now() - 60 * 86400000).toISOString());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return fresh;
}

/* ------------------------------------------------------------------ */
/* fix176: a search feed for every league                               */
/* ------------------------------------------------------------------ */

/**
 * The general feeds above never name many leagues (Saudi Pro League, Austria, Switzerland, J1, Brazil, Nations League,
 * qualifiers, NBB…), so every league also gets a news search (Google News RSS, last 14 days): the query is built from
 * the league's name + country + sport, or from the hand-written phrase lists (NEWS_LEAGUES, BB_NEWS_LEAGUES) when the
 * league has one; national-team competitions by their name. Every league added from admin gets one automatically.
 * Each league is searched at most every 3 hours, 12 searches per 15-minute refresh; its stories are filed under it.
 */
// fix177: 40 searches a refresh until every league has had its first one (after a deploy every league is new), then 12
const SEARCH_EVERY = 3 * 3600 * 1000, SEARCH_PER_TICK = 12, SEARCH_FIRST_PASS = 40;
/**
 * fix177: national-team competitions by the words headlines use ("World Cup qualifiers", "Nations League"), not the
 * provider's names ("World Cup - Qualification Europe"). The rule below covers new ones ("X - Qualification Y").
 */
const NATIONAL_QUERIES: Record<string, string> = {
  WC: '"FIFA World Cup" OR "World Cup qualifiers" football', AF1: '"FIFA World Cup" OR "World Cup qualifiers" football',
  EC: '"Euro 2028" OR "European Championship" OR "Euro qualifiers" football', AF4: '"Euro 2028" OR "European Championship" OR "Euro qualifiers" football',
  AF960: '"Euro qualifiers" OR "Euro 2028 qualifying" football', AF5: '"Nations League" UEFA football', AF10: '"international friendly" football',
  AF29: '"World Cup qualifiers" Africa football', AF30: '"World Cup qualifiers" Asia football', AF31: '"World Cup qualifiers" CONCACAF football',
  AF32: '"World Cup qualifiers" Europe football', AF33: '"World Cup qualifiers" Oceania football', AF34: '"World Cup qualifiers" South America football',
  AF36: '"Africa Cup of Nations" qualifiers football', AF536: '"CONCACAF Nations League" football'
};
/** A national-team competition's search from its name: "World Cup - Qualification Europe" → "World Cup qualifiers" Europe. */
function nationalQuery(name: string): string {
  const m = /^(.*?)\s*-\s*Qualification\s*(.*)$/i.exec(name);
  return m ? `${quote(`${m[1]} qualifiers`)}${m[2] ? ` ${m[2]}` : ''} football` : `${quote(name)} football`;
}
const searchedAt = new Map<string, number>();
const quote = (s: string) => `"${String(s).replace(/"/g, '').trim()}"`;
const searchFeed = (q: string): string => `https://news.google.com/rss/search?${new URLSearchParams({ q: `${q} when:14d`, hl: 'en-US', gl: 'US', ceid: 'US:en' })}`;
export interface LeagueTopic { code: string; sport: Sport; query: string }
/** The news search of every league we cover (hand-written phrases first, then the name + country + sport rule). */
export function leagueTopics(): LeagueTopic[] {
  const out = new Map<string, LeagueTopic>();
  const add = (code: string, sport: Sport, query: string) => { const k = `${sport}|${code}`; if (!out.has(k)) out.set(k, { code, sport, query }); };
  const place = (name: string, country?: string | null) => (country && !/world|europe|international/i.test(country) && !name.toLowerCase().includes(country.toLowerCase()) ? ` ${country}` : '');
  const fed = new Set(FEEDS.filter(f => f.league).map(f => `${f.sport || 'football'}|${f.league}`)); // leagues with their own section feed
  for (const [code, q] of Object.entries(NATIONAL_QUERIES)) add(code, 'football', q);
  for (const l of NEWS_LEAGUES) if (!fed.has(`football|${l.code}`)) add(l.code, 'football', `${quote(l.phrases[0])} football`);
  for (const l of BB_NEWS_LEAGUES) if (!fed.has(`basketball|${l.code}`) && l.phrases[0].length >= 5) add(l.code, 'basketball', `${quote(l.phrases[0])} basketball`);
  try {
    const { afCompetitions } = require('./afMatches') as typeof import('./afMatches');
    for (const c of afCompetitions()) {
      if (fed.has(`football|${c.code}`)) continue;
      // national-team competitions and cups: by their name; leagues: name + country
      add(c.code, 'football', c.type === 'LEAGUE' ? `${quote(c.name)}${place(c.name, c.area?.name)} football` : c.type === 'NATIONAL' ? nationalQuery(c.name) : `${quote(c.name)} football`);
    }
  } catch { /* fixtures not loaded */ }
  try {
    for (const r of db.prepare(`SELECT competition_code AS code, MAX(competition_name) AS name FROM predictions WHERE utc_date >= ? AND competition_code IS NOT NULL GROUP BY competition_code`).all(new Date(Date.now() - 120 * 86400000).toISOString()) as any[])
      if (r.name && !fed.has(`football|${r.code}`)) add(r.code, 'football', `${quote(r.name)} football`);
  } catch { /* table missing */ }
  try {
    const { BB_LEAGUES } = require('./basketball') as typeof import('./basketball');
    for (const l of BB_LEAGUES) if (!fed.has(`basketball|${l.code}`)) add(l.code, 'basketball', `${quote(l.name)}${place(l.name, l.country)} basketball`);
  } catch { /* basketball not loaded */ }
  // never a search for the Israeli league (house rule: no new Israel references on the site)
  return [...out.values()].filter(t => t.code !== 'AF383' && !/israel/i.test(t.query));
}
/** The searches due this refresh (never searched or older than 3 h), oldest first. */
function dueTopics(): LeagueTopic[] {
  const now = Date.now();
  return leagueTopics().filter(t => now - (searchedAt.get(`${t.sport}|${t.code}`) || 0) > SEARCH_EVERY)
    .sort((a, b) => (searchedAt.get(`${a.sport}|${a.code}`) || 0) - (searchedAt.get(`${b.sport}|${b.code}`) || 0))
    .slice(0, leagueTopics().some(t => !searchedAt.has(`${t.sport}|${t.code}`)) ? SEARCH_FIRST_PASS : SEARCH_PER_TICK);
}
/**
 * fix177: a league asked for that has no stories and wasn't searched in the last 3 h is searched right away (one
 * search, shared by everyone asking, 8 s at most) — the first visitor of a league added today sees its news.
 */
const searching = new Map<string, Promise<void>>();
async function searchNow(code: string, sport: Sport): Promise<void> {
  const key = `${sport}|${code}`;
  if (Date.now() - (searchedAt.get(key) || 0) < SEARCH_EVERY) return;
  const topic = leagueTopics().find(t => t.code === code && t.sport === sport);
  if (!topic) return;
  let run = searching.get(key);
  if (!run) {
    const f: Feed = { source: 'Google News', url: searchFeed(topic.query), league: code, sport, search: true };
    run = fetchFeed(f).then(raws => { markSearched([f]); storeRaws(raws); }).catch(e => { logger.warn(`news search ${code}: ${e.message}`); markSearched([f]); })
      .finally(() => searching.delete(key));
    searching.set(key, run);
  }
  await Promise.race([run, new Promise(r => setTimeout(r, 8000))]);
}
export const searchFeedsOf = (): Feed[] => dueTopics().map(t => ({ source: 'Google News', url: searchFeed(t.query), league: t.code, sport: t.sport, search: true }));
const markSearched = (feeds: Feed[]) => { for (const f of feeds) if (f.search && f.league) searchedAt.set(`${f.sport || 'football'}|${f.league}`, Date.now()); };

function refreshNow(): Promise<void> {
  if (!refreshing) {
    refreshing = refresh()
      .catch((e: any) => { logger.warn('News refresh failed', { message: e?.message }); })
      .finally(() => { refreshing = null; });
  }
  return refreshing as Promise<void>;
}

let started = false;
/** Refresh every 15 minutes (first run shortly after boot). */
export function startNewsScheduler() {
  if (started) return;
  started = true;
  after('news', () => refreshNow(), 20 * 1000).unref();
  every('news', () => void refreshNow(), 15 * 60 * 1000).unref();
}

function toItem(r: any): NewsItem {
  return {
    title: r.title, link: r.link, source: r.source, published: r.published, summary: r.summary,
    // fix180: no picture of its own → the league logo / team crest (marked, so the page shows it whole, not cropped)
    image: r.image || fallbackPicture(r), imageKind: r.image ? 'photo' : 'logo',
    leagues: String(r.leagues || '').split(',').filter(Boolean).map((c: string) => ({ code: c, name: leagueNameOf(c, r.sport || 'football') }))
  };
}
const when = (r: any) => r.published || r.seen_at;

/**
 * One story per headline: titles compared lowercase without punctuation or spaces (the same story from two outlets or
 * under two links). Keeps the first (newest) one in place, but takes the copy with a picture when the first has none.
 */
const titleKey = (t: string) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
function dedupe(rows: any[]): any[] {
  rows = rows.filter(r => !isBettingStory(r) && !isJunk(r.title, r.source, String(r.leagues || '').split(',').filter(Boolean), r.sport || 'football'));
  const out: any[] = [];
  const at = new Map<string, number>();
  for (const r of rows) {
    const k = titleKey(r.title);
    if (!k) { out.push(r); continue; }
    const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push(r); }
    else if (!out[i].image && r.image) out[i] = r;
  }
  return out;
}

/** Interleave outlets so one of them doesn't fill the list (each outlet newest first). */
function mix(rows: any[], limit: number): any[] {
  const bySource = new Map<string, any[]>();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }
  const lists = [...bySource.values()].map(l => l.sort((a, b) => when(b).localeCompare(when(a))))
    .sort((a, b) => when(b[0]).localeCompare(when(a[0])));
  const out: any[] = [];
  for (let i = 0; out.length < limit && lists.some(l => i < l.length); i++) for (const l of lists) if (l[i] && out.length < limit) out.push(l[i]);
  return out;
}

/**
 * Home page: every story of the last 3 days, all leagues combined (outlets interleaved).
 * League page (`league` = competition code): that league's stories of the last 14 days, newest first.
 * Team page (`team` = names the team goes by): stories that name the team, last 30 days.
 */
export async function newsFor(opts: { sport?: Sport; limit?: number; league?: string; team?: string[] }): Promise<NewsItem[]> {
  const sport = opts.sport || 'football';
  const limit = opts.limit || 12;
  const have: any = db.prepare(`SELECT COUNT(*) AS n FROM news_items`).get();
  if (!have.n) await refreshNow(); // first boot: wait for the first fill
  else if (!lastRefresh) void refreshNow();
  if (opts.team && opts.team.length) {
    const names = [...new Set(opts.team.map(n => norm(n).trim()).filter(n => n.length >= 3))].sort((a, b) => b.length - a.length);
    if (!names.length) return [];
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'u');
    // american football: a team's stories come from its own league's feeds (Miami NFL vs Miami college)
    const lg = sport === 'american-football' && opts.league ? `%,${opts.league.toUpperCase()},%` : '%';
    const rows = db.prepare(`SELECT * FROM news_items WHERE sport = ? AND leagues LIKE ? AND COALESCE(published, seen_at) >= ? ORDER BY COALESCE(published, seen_at) DESC LIMIT 3000`)
      .all(sport, lg, new Date(Date.now() - 30 * 86400000).toISOString()) as any[];
    return dedupe(rows.filter(r => re.test(norm(`${r.title} . ${r.summary}`)))).slice(0, limit).map(toItem);
  }
  if (opts.league) {
    // the last 14 days; a quiet league (fewer than 8 stories) also gets its older stories, up to 60 days back
    const code = opts.league.toUpperCase();
    // fix176: Brazil Série A's stories were filed as BSA before it moved to AF71
    const old = ({ AF71: 'BSA' } as Record<string, string>)[code] || code;
    const q = db.prepare(`
      SELECT * FROM news_items WHERE sport = ? AND (leagues LIKE ? OR leagues LIKE ?) AND COALESCE(published, seen_at) >= ?
      ORDER BY COALESCE(published, seen_at) DESC LIMIT ?`);
    // fix177: nothing stored yet for this league — its news search runs now (the first visitor waits up to 8 s)
    if (!(db.prepare(`SELECT 1 FROM news_items WHERE sport = ? AND (leagues LIKE ? OR leagues LIKE ?) LIMIT 1`).get(sport, `%,${code},%`, `%,${old},%`))) await searchNow(code, sport);
    let rows = dedupe(q.all(sport, `%,${code},%`, `%,${old},%`, new Date(Date.now() - 14 * 86400000).toISOString(), limit * 2)).slice(0, limit);
    if (rows.length < Math.min(8, limit)) rows = dedupe(q.all(sport, `%,${code},%`, `%,${old},%`, new Date(Date.now() - 60 * 86400000).toISOString(), Math.min(limit, 8) * 2)).slice(0, Math.min(limit, 8));
    return rows.map(toItem);
  }
  const rows = db.prepare(`SELECT * FROM news_items WHERE sport = ? AND COALESCE(published, seen_at) >= ? ORDER BY COALESCE(published, seen_at) DESC LIMIT 300`)
    .all(sport, new Date(Date.now() - (sport === 'football' ? 3 : 5) * 86400000).toISOString());
  return mix(dedupe(rows), limit).map(toItem);
}

/** Football news (home / league page). */
export function footballNews(limit = 12, league?: string): Promise<NewsItem[]> {
  return newsFor({ sport: 'football', limit, league });
}

/** The names a football team goes by in headlines ("Manchester United" → "Man Utd", "Man United"). */
export function footballTeamNames(name: string, shortName?: string): string[] {
  const out = new Set<string>([name]);
  if (shortName) out.add(shortName);
  for (const n of [name, shortName || '']) {
    const short = n.replace(GENERIC, '').trim();
    if (short && !RISKY.has(norm(short).toLowerCase())) out.add(short);
    for (const a of TEAM_ALIASES[norm(n).toLowerCase()] || TEAM_ALIASES[norm(short).toLowerCase()] || []) out.add(a);
  }
  return [...out].filter(n => n.length >= 3 && !RISKY.has(norm(n).toLowerCase()));
}

/** Admin: every feed's last result and how many stories each league has. */
export function newsStatus() {
  const counts = new Map<string, number>();
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  for (const r of db.prepare(`SELECT leagues FROM news_items WHERE sport = 'football' AND COALESCE(published, seen_at) >= ?`).all(since) as any[])
    for (const c of String(r.leagues).split(',').filter(Boolean)) counts.set(c, (counts.get(c) || 0) + 1);
  const total: any = db.prepare(`SELECT COUNT(*) AS n FROM news_items`).get();
  return {
    lastRefresh,
    stored: total.n,
    teamNames: matcher?.leaguesOf.size || 0,
    feeds: FEEDS.map(f => ({ url: f.url, ...(feedStatus.get(f.url) || { source: f.source, league: f.league || null, ok: null, items: 0, error: null, at: null }) })),
    leagues: NEWS_LEAGUES.map(l => ({ code: l.code, name: l.name, stories14d: counts.get(l.code) || 0 })),
    basketball: BB_NEWS_LEAGUES.map(l => ({ code: l.code, name: l.name, stories14d: (db.prepare(`SELECT COUNT(*) AS n FROM news_items WHERE sport = 'basketball' AND leagues LIKE ? AND COALESCE(published, seen_at) >= ?`).get(`%,${l.code},%`, since) as any).n })),
    bbTeamNames: bbMatcher?.leaguesOf.size || 0
  };
}

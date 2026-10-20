/**
 * Official match highlights from YouTube, embedded on the match page after full time.
 *
 * Only videos from official channels are used: the leagues and competitions themselves, their licensed broadcasters,
 * or the two clubs' own channels. Fan uploads and re-uploads are never shown. The video is played through YouTube's
 * own player (the channel decides where it can be watched; some are blocked in some countries).
 *
 * Needs YOUTUBE_API_KEY (YouTube Data API v3, free quota 10,000 units/day; one search = 100 units). Searched only
 * when someone opens a finished match, cached forever once found; while not found, retried at most every 2 hours
 * for 4 days after the match. Without a key the feature is simply off.
 */
import { db } from '../db';
import logger from '../utils/logger';

db.exec(`
  CREATE TABLE IF NOT EXISTS match_highlights (
    match_id   INTEGER PRIMARY KEY,
    video_id   TEXT,
    title      TEXT,
    channel    TEXT,
    published  TEXT,
    checked_at TEXT NOT NULL,
    tries      INTEGER NOT NULL DEFAULT 0
  );
`);

const KEY = () => process.env.YOUTUBE_API_KEY || '';
const RETRY_MS = 2 * 3600 * 1000;
const GIVE_UP_MS = 14 * 86400 * 1000;
let quotaBlockedUntil = 0;

// Official channels (as YouTube shows the name). Tier 0 = the competition itself (best), tier 2 = a licensed broadcaster.
// A club's own channel is tier 1 (see isOfficial).
const LEAGUES = [
  'premier league', 'efl', 'laliga', 'laliga ea sports', 'laliga hypermotion', 'laliga en espanol', 'serie a', 'lega serie b',
  'bundesliga', '2. bundesliga', 'ligue 1 mcdonalds', 'ligue 1', 'ligue 2 bkt', 'eredivisie', 'liga portugal', 'liga portugal betclic',
  'spfl', 'trendyol super lig', 'super lig', 'pro league', 'jupiler pro league', 'super league greece', 'uefa', 'uefa champions league',
  'uefa europa league', 'uefa conference league', 'fifa', 'concacaf', 'caf tv', 'the afc channel', 'afc asian cup', 'conmebol',
  // fix174: American football and basketball (the league's own channel)
  'nfl', 'nba', 'euroleague basketball', 'eurocup basketball', 'fiba', 'basketball champions league', 'liga endesa', 'lnb pro a', 'easycredit bbl',
  'lega basket serie a', 'nbl', 'ncaa',
  // fix193c: tennis (the tours, their video service and the four Grand Slams)
  'atp tour', 'wta', 'tennis tv', 'australian open tv', 'australian open', 'roland garros', 'wimbledon', 'us open tennis championships'
];
const BROADCASTERS = [
  'sky sports premier league', 'sky sports football', 'sky sports football league', 'nbc sports', 'cbs sports golazo', 'tnt sports football',
  'dazn football', 'dazn', 'canal+ sport', 'bein sports', 'bein sports usa', 'bein sports france', 'espn fc', 'espn nl', 'espn deportes',
  'espn brasil', 'fox soccer', 'tudn usa', 'viaplay football',
  // fix174: college football's licensed broadcasters
  'espn college football', 'sec network', 'big ten network', 'acc digital network', 'big 12 conference', 'cbs sports', 'fox college football',
  // fix193c: tennis broadcaster
  'tennis channel'
];

// apostrophes of any kind are dropped, so "Ligue 1 McDonald’s" = "ligue 1 mcdonalds"
const norm = (s: string) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&amp;/g, '&').replace(/['’`´]/g, '')
    .replace(/[^a-z0-9+. ]+/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = ['fc', 'cf', 'afc', 'sc', 'ac', 'club', 'de', 'cd', 'sad', 'official', 'oficial', 'ufficiale', 'tv', 'channel', 'the'];
const clubKey = (s: string) => norm(s).split(' ').filter(w => !STOP.includes(w)).join(' ');

// short names in our data → the words a title or channel uses
const ALIAS: Record<string, string[]> = {
  psg: ['paris saint germain', 'paris sg', 'psg'], 'man city': ['manchester city', 'man city'], 'man united': ['manchester united', 'man united', 'man utd'],
  'man utd': ['manchester united', 'man utd'], inter: ['inter', 'internazionale'], spurs: ['tottenham', 'spurs'], wolves: ['wolverhampton', 'wolves'],
  'atletico': ['atletico'], 'atl. madrid': ['atletico'], bayern: ['bayern'], 'b. dortmund': ['dortmund'], 'ath bilbao': ['athletic'], om: ['marseille']
};
const names = (team: string) => [clubKey(team), ...(ALIAS[norm(team)] || []).map(clubKey)].filter(Boolean);

/** 0 = the competition's channel, 1 = one of the two clubs' own channel, 2 = licensed broadcaster; null = not official. */
function tierOf(channel: string, home: string, away: string): number | null {
  const c = norm(channel);
  if (LEAGUES.some(o => c === norm(o))) return 0;
  if (BROADCASTERS.some(o => c === norm(o))) return 2;
  // a club's own channel: "FC Barcelona", "Real Sociedad TV", "PSG - Paris Saint-Germain" (nothing but the club's names)
  const ck = clubKey(channel);
  for (const team of [home, away]) {
    const ns = names(team);
    if (!ck || !ns.length) continue;
    let rest = ` ${ck} `;
    for (const n of ns) rest = rest.split(` ${n} `).join(' ')
    if (rest.trim() === '' || ns.includes(ck)) return 1;
  }
  return null;
}
const isOfficial = (channel: string, home: string, away: string) => tierOf(channel, home, away) !== null;

/** The words of a team name worth searching for ("Wolverhampton Wanderers" → "Wolverhampton"). */
const short = (s: string) => clubKey(s).split(' ').sort((a, b) => b.length - a.length)[0] || s;

function mentions(title: string, team: string) {
  const t = ` ${norm(title)} `;
  return names(team).some(k => t.includes(` ${k} `) || k.split(' ').some(w => w.length >= 4 && t.includes(w)));
}

export interface Highlight { videoId: string; title: string; channel: string; published: string }

export let lastCandidates: { q: string; items: { channel: string; title: string; official: boolean }[]; error?: string } | null = null;

export async function highlightsFor(match: any, force = false): Promise<Highlight | null> {
  if (!match || !['FINISHED', 'AWARDED'].includes(match.status)) return null;
  const row: any = db.prepare(`SELECT * FROM match_highlights WHERE match_id = ?`).get(match.id);
  if (row?.video_id) return { videoId: row.video_id, title: row.title, channel: row.channel, published: row.published };
  if (!KEY() || Date.now() < quotaBlockedUntil) return null;
  const ko = new Date(match.utcDate).getTime();
  if (!Number.isFinite(ko) || Date.now() - ko > GIVE_UP_MS) return null;
  if (!force && row && Date.now() - new Date(row.checked_at).getTime() < RETRY_MS) return null;

  const home = match.homeTeam?.shortName || match.homeTeam?.name || '', away = match.awayTeam?.shortName || match.awayTeam?.name || '';
  const q = `${short(home)} ${short(away)} highlights`;
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', maxResults: '15', q, videoEmbeddable: 'true', order: 'relevance',
    publishedAfter: new Date(ko).toISOString(), key: KEY()
  });
  let found: Highlight | null = null;
  lastCandidates = { q, items: [] };
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 403) { quotaBlockedUntil = Date.now() + 3600 * 1000; throw new Error('quota or key refused (403)'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    // every official candidate that names both teams; best = the competition's own video, then the clubs', then
    // broadcasters; a title that says highlights/resumen/… beats one that doesn't; extended beats short
    const cands: { tier: number; score: number; h: Highlight }[] = [];
    for (const it of j.items || []) {
      const s = it.snippet || {};
      const title = String(s.title || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const tier = tierOf(s.channelTitle, match.homeTeam?.name || home, match.awayTeam?.name || away);
      lastCandidates.items.push({ channel: s.channelTitle, title, official: tier !== null });
      if (!it.id?.videoId || tier === null) continue;
      if (!mentions(title, home) || !mentions(title, away)) continue;
      const hl = /highlight|resumen|sintesi|samenvatting|r[eé]sum[eé]|zusammenfassung|melhores momentos|ozet|özet|all goals|goals/i.test(title)
      // a broadcaster or club must say it is highlights; the competition's own match video may just be "A - B (1-2)"
      if (!hl && !(tier === 0 && /\d\s*[-–]\s*\d/.test(title))) continue;
      if (/\b(reaction|preview|press conference|conference|interview|live|watchalong|podcast)\b/i.test(title)) continue;
      cands.push({ tier, score: tier * 10 - (hl ? 2 : 0) - (/extended/i.test(title) ? 1 : 0), h: { videoId: it.id.videoId, title, channel: s.channelTitle, published: s.publishedAt } });
    }
    cands.sort((x, y) => x.score - y.score);
    found = cands[0]?.h || null;
  } catch (e: any) {
    logger.warn(`highlights ${match.id}: ${e.message}`);
    if (lastCandidates) lastCandidates.error = e.message;
  }
  db.prepare(`
    INSERT INTO match_highlights (match_id, video_id, title, channel, published, checked_at, tries) VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(match_id) DO UPDATE SET video_id = excluded.video_id, title = excluded.title, channel = excluded.channel,
      published = excluded.published, checked_at = excluded.checked_at, tries = match_highlights.tries + 1`)
    .run(match.id, found?.videoId || null, found?.title || null, found?.channel || null, found?.published || null, new Date().toISOString());
  return found;
}

export function highlightsStatus() {
  const r: any = db.prepare(`SELECT COUNT(*) n, SUM(video_id IS NOT NULL) found FROM match_highlights`).get();
  return { configured: !!KEY(), checked: r.n, found: r.found || 0, quotaBlocked: Date.now() < quotaBlockedUntil };
}

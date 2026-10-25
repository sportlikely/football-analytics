/**
 * fix229: the slug rules of every public link — one copy for the server (backend/src/utils/slugRules.ts) and one for
 * the app (frontend/src/lib/slugRules.ts). The two files must stay identical (`npm run parity` compares them).
 *
 * Every public page is /<lang?>/<sport>/<kind>/<slug> (docs/notes/links.md). A slug is lowercase ASCII words joined
 * by dashes: "Atlético" → atletico, "1. FC Köln" → koln, "FC St. Pauli" → st-pauli, "Man City" → manchester-city.
 * Which entity a slug belongs to (and the -country / -team / -2 forms when two share a name) is decided by the server
 * (services/slugs.ts, table slugs); these rules only turn a name into its plain slug.
 */

/** the sports with public pages, as they appear in links (a new sport: its name with dashes, e.g. ice-hockey) */
export const LINK_SPORTS = ['football', 'basketball', 'american-football', 'tennis'] as const
export type LinkSport = typeof LINK_SPORTS[number]
/** the page kinds that carry a slug (one word "match" for every sport) */
export const LINK_KINDS = ['team', 'player', 'league', 'match'] as const
export type LinkKind = typeof LINK_KINDS[number]

/** letters that NFD does not split into a base letter + accent */
const SPECIAL: Record<string, string> = {
  'ß': 'ss', 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd',
  'ð': 'd', 'Ð': 'd', 'þ': 'th', 'Þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't'
}

/** plain words of a name: no accents, lowercase, "&" → "and", apostrophes dropped ("Nott'm" → nottm) */
export function slugWords(name: string): string[] {
  const s = String(name || '')
    .replace(/[ßøØæÆœŒłŁđĐðÐþÞıħŧ]/g, c => SPECIAL[c] || c)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return s ? s.split(' ') : []
}

/** any text → slug (a slug always has a letter: an all-digit slug would read as an old numeric id) */
export function slugify(name: string): string {
  const s = slugWords(name).join('-')
  return /[a-z]/.test(s) ? s : s ? `n-${s}` : ''
}

/** club words dropped from the start / end of a team name ("FC Barcelona", "Real Madrid CF", "1. FC Köln") */
const CLUB_WORDS = new Set(['fc', 'cf', 'afc', 'cfc', 'sc', 'ac', 'as', 'ss', 'ssc', 'us', 'fk', 'sk', 'bk', 'if', 'sv', 'vfb', 'vfl', 'tsg', 'rcd', 'cd', 'ud', 'sd', 'ca', 'club', 'kv', 'krc', 'rc', 'osc'])
/** common short names → the slug people know (Man City → manchester-city) */
const TEAM_ALIASES: Record<string, string> = {
  'man city': 'manchester-city', 'man united': 'manchester-united', 'man utd': 'manchester-united', 'manchester utd': 'manchester-united',
  'nottm forest': 'nottingham-forest', 'notts forest': 'nottingham-forest', 'spurs': 'tottenham', 'tottenham hotspur': 'tottenham',
  'wolverhampton wanderers': 'wolves', 'wolverhampton': 'wolves', 'brighton and hove albion': 'brighton', 'brighton hove albion': 'brighton',
  'west ham united': 'west-ham', 'newcastle united': 'newcastle', 'leeds united': 'leeds', 'sheffield utd': 'sheffield-united',
  'psg': 'paris-saint-germain', 'paris sg': 'paris-saint-germain', 'paris st germain': 'paris-saint-germain',
  'bayern munchen': 'bayern-munich', 'fc bayern munchen': 'bayern-munich', 'bayern': 'bayern-munich',
  'internazionale': 'inter', 'internazionale milano': 'inter', 'inter milan': 'inter', 'ac milan': 'ac-milan', 'milan': 'ac-milan',
  'atletico de madrid': 'atletico-madrid', 'atleti': 'atletico-madrid', 'barca': 'barcelona',
  'borussia monchengladbach': 'monchengladbach', 'b monchengladbach': 'monchengladbach', 'gladbach': 'monchengladbach',
  'bayer 04 leverkusen': 'bayer-leverkusen', 'leverkusen': 'bayer-leverkusen', 'rb leipzig': 'rb-leipzig', 'leipzig': 'rb-leipzig',
  'olympique lyonnais': 'lyon', 'olympique de marseille': 'marseille', 'olympique marseille': 'marseille',
  'sporting clube de portugal': 'sporting-cp', 'sporting lisbon': 'sporting-cp', 'sporting': 'sporting-cp'
}

/** a team name → its plain slug: club words off the ends, then the short-name list ("1. FC Köln" → koln) */
export function teamSlug(name: string): string {
  const all = slugWords(name)
  const whole = all.join(' ')
  if (TEAM_ALIASES[whole]) return TEAM_ALIASES[whole]
  let w = all.slice()
  const drop = (x: string) => CLUB_WORDS.has(x) || (/^\d{1,2}$/.test(x))
  while (w.length > 1 && drop(w[0])) w.shift()
  while (w.length > 1 && CLUB_WORDS.has(w[w.length - 1])) w.pop()
  const core = w.join(' ')
  if (TEAM_ALIASES[core]) return TEAM_ALIASES[core]
  const s = w.join('-')
  return /[a-z]/.test(s) ? s : slugify(name)
}

/** a player name → its plain slug */
export const playerSlug = (name: string) => slugify(name)
/** a league / competition / tournament name → its plain slug */
export const leagueSlug = (name: string) => slugify(name)

/** the day of a match in its slug: the UTC date of the start (yyyy-mm-dd) */
export const matchDay = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : '')
/** /match/<home>-vs-<away>-<yyyy-mm-dd> from the two sides' slugs (a second game of the same teams that day adds -2) */
export function matchSlug(home: string, away: string, iso: string | null | undefined): string {
  const d = matchDay(iso)
  return `${home || 'tbd'}-vs-${away || 'tbd'}${/^\d{4}-\d{2}-\d{2}$/.test(d) ? `-${d}` : ''}`
}
/** a match slug back into its parts (null = not a match slug) */
export function parseMatchSlug(slug: string): { home: string; away: string; day: string | null; n: number } | null {
  const m = /^(.+?)-vs-(.+?)(?:-(\d{4}-\d{2}-\d{2}))?(?:-(\d))?$/.exec(slug)
  return m ? { home: m[1], away: m[2], day: m[3] || null, n: m[4] ? Number(m[4]) : 1 } : null
}

/** the plain slug of any kind from a name */
export function plainSlug(kind: LinkKind, name: string): string {
  return kind === 'team' ? teamSlug(name) : slugify(name)
}

/** a valid slug as it appears in a link */
export const isSlug = (s: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && /[a-z]/.test(s)

/** /<sport>/<kind>/<slug> */
export const slugPath = (sport: LinkSport, kind: LinkKind, slug: string) => `/${sport}/${kind}/${slug}`

/**
 * The only query parameters a public link may carry (the guard in `npm run parity` reads this list). Everything else
 * that tells a page which item to show is in the path.
 */
export const ALLOWED_QUERY = ['q', 'league', 'tour', 'tab', 'day', 'plan', 'ref', 'token', 'next', 'utm_source', 'utm_medium', 'utm_campaign'] as const

/* ---------- fix235: tabs are sub-paths, every sport page is /<sport>/<page> (docs/notes/links.md) ---------- */

/** a match page's tabs, every sport: /<sport>/match/<slug>/<tab>; the prediction is the page itself (no sub-path) */
export const MATCH_TABS = ['stats', 'lineups', 'h2h', 'table', 'highlights', 'rest', 'players', 'box', 'quarters', 'plays', 'form', 'draw'] as const
/** a league page's tabs: /<sport>/league/<slug>/<tab> (the overview is the page itself) */
export const LEAGUE_TABS = ['forecast'] as const
/**
 * "/football/match/<slug>/stats" → { base: "/football/match/<slug>", tab: "stats" }; tab null = not a tab of that page
 * (the address moves to the page itself); null = no sub-path of a match / league page
 */
export function splitTab(path: string): { base: string; tab: string | null } | null {
  const m = /^(\/[a-z-]+\/(match|league)\/[a-z0-9-]+)\/([^/]+)\/?$/.exec(path)
  if (!m) return null
  const list: readonly string[] = m[2] === 'match' ? MATCH_TABS : LEAGUE_TABS
  return { base: m[1], tab: list.includes(m[3]) ? m[3] : null }
}

/** the pages every sport has under its name (same names in every sport; football no longer at the root) */
export const SPORT_PAGES = ['matches', 'today', 'predictions', 'favorites', 'my-picks', 'upset-watch', 'draw-alerts', 'accuracy', 'how-it-works', 'past', 'rankings'] as const
/** the weekly hubs that are not football's: /<sport>/predictions/<slug> */
const HUB_SPORT: Record<string, LinkSport> = { nba: 'basketball', euroleague: 'basketball', nfl: 'american-football', 'college-football': 'american-football' }
const FOOTBALL_ROOT = /^\/(matches|favorites|my-picks|upset-watch|draw-alerts|accuracy|past)$/
/**
 * an old page address (no language prefix, no query) → its address now; null = not an old page address.
 * /matches → /football/matches, /predictions/today → /football/today, /predictions/nba → /basketball/predictions/nba,
 * /basketball/games → /basketball/matches, /basketball/predictions/today → /basketball/today, a hub under the wrong sport.
 */
export function movedPage(path: string): string | null {
  const p = path.replace(/\/+$/, '') || '/'
  if (p === '/predictions/today') return '/football/today'
  let m = /^\/predictions\/([a-z0-9-]+)$/.exec(p)
  if (m) return `/${HUB_SPORT[m[1]] || 'football'}/predictions/${m[1]}`
  m = /^\/(football|basketball|american-football)\/predictions\/([a-z0-9-]+)$/.exec(p)
  if (m && m[2] === 'today') return `/${m[1]}/today`
  if (m && (HUB_SPORT[m[2]] || 'football') !== m[1]) return `/${HUB_SPORT[m[2]] || 'football'}/predictions/${m[2]}`
  m = FOOTBALL_ROOT.exec(p)
  if (m) return `/football/${m[1]}`
  m = /^\/(basketball|american-football)\/games$/.exec(p)
  if (m) return `/${m[1]}/matches`
  return null
}
/** the server's crawler pages still read the old page addresses: /football/matches → /matches, … (null = not a sport page) */
export function internalPage(path: string): string | null {
  const p = path.replace(/\/+$/, '') || '/'
  let m = /^\/football\/(matches|favorites|my-picks|upset-watch|draw-alerts|accuracy|past)$/.exec(p)
  if (m) return `/${m[1]}`
  if (p === '/football/today') return '/predictions/today'
  if (p === '/basketball/today') return '/basketball/predictions/today'
  m = /^\/(football|basketball|american-football)\/predictions\/([a-z0-9-]+)$/.exec(p)
  if (m) return `/predictions/${m[2]}`
  m = /^\/(basketball|american-football)\/matches$/.exec(p)
  if (m) return `/${m[1]}/games`
  return null
}

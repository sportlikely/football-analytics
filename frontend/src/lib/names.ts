/**
 * fix261: names in the local script on Hebrew / Arabic pages (teams, leagues, countries, cities, players).
 *
 * The server keeps the dictionary (backend services/names.ts: admin > press spelling > Wikidata label > letter rules)
 * and sends one map per language, Latin → local (`/api/names/he`). It is loaded with the language before the first
 * paint (the last copy from localStorage at once, a fresh one for the next page load), and every public API answer's
 * name fields are swapped as they arrive (an axios interceptor), so lists, cards, pages, search results and generated
 * sentences (lib/genText.ts) show the local name. A name without an entry stays as the provider writes it.
 *
 * Links stay Latin: lib/links.ts turns a swapped name back (latinOf) before it makes a slug, and anything that compares
 * a name with a fixed Latin list (lib/fame.ts) does the same. Other languages: nothing is loaded or changed.
 */
import axios from 'axios'
import { lang } from './i18n'

export const NAME_LANGS = ['he', 'ar'] as const
export const namesOn = (NAME_LANGS as readonly string[]).includes(lang)
const LS_KEY = `sl-names-${lang}`
const WAIT_MS = 1500

let map: Record<string, string> = {}
const back = new Map<string, string>()
function use(names: Record<string, string> | null | undefined) {
  if (!names || typeof names !== 'object') return
  map = names
  back.clear()
  for (const [latin, local] of Object.entries(names)) if (!back.has(local)) back.set(local, latin)
}

/** the name in this page's script, or as given */
export const nm = (s: string | null | undefined): string => (s && namesOn ? map[s] ?? map[s.trim()] ?? s : s ?? '')
/** the provider's (Latin) name of a swapped name — for slugs and fixed Latin lists; anything else unchanged */
export const latinOf = (s: string | null | undefined): string => (s && namesOn ? back.get(s) ?? s : s ?? '')
export const namesCount = () => Object.keys(map).length

/** before the first paint: the kept map at once (the fresh one replaces it for the next page), else wait ≤ 1.5 s */
export async function loadNames(): Promise<void> {
  if (!namesOn) return
  let kept: { at: number; names: Record<string, string> } | null = null
  try { kept = JSON.parse(localStorage.getItem(LS_KEY) || 'null') } catch { /* private mode */ }
  // fix273: an empty map kept from before the names were built counts as none (it hid the names for good)
  if (kept?.names && !Object.keys(kept.names).length) kept = null
  if (kept?.names) use(kept.names)
  const fresh = fetch(`/api/names/${lang}`, { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then((j: { names?: Record<string, string> } | null) => {
      if (!j?.names || !Object.keys(j.names).length) return
      try { localStorage.setItem(LS_KEY, JSON.stringify({ at: Date.now(), names: j.names })) } catch { /* full / private */ }
      if (!kept?.names) use(j.names)
    })
    .catch(() => { /* offline: the kept map, or Latin names */ })
  if (!kept?.names) await Promise.race([fresh, new Promise(r => setTimeout(r, WAIT_MS))])
}

/** the fields that carry a team / league / country / city / player name in the API answers */
export const NAME_FIELDS = new Set([
  'name', 'short', 'shortName', 'short_name', 'fullName', 'full_name', 'displayName', 'display',
  'home', 'away', 'home_team', 'away_team', 'homeTeam', 'awayTeam', 'home_name', 'away_name', 'homeName', 'awayName', 'homeShort', 'awayShort',
  'team', 'teamName', 'team_name', 'opp', 'opponent', 'oppName', 'opp_name', 'club', 'clubName',
  'league', 'leagueName', 'league_name', 'competition', 'competitionName', 'competition_name', 'comp', 'tournament', 'tournamentName', 'cup',
  'country', 'countryName', 'country_name', 'area', 'nationality', 'city', 'venueCity',
  'player', 'playerName', 'player_name', 'p1', 'p2', 'p1_name', 'p2_name', 'p1Name', 'p2Name', 'winner', 'loser', 'scorer', 'assist', 'by', 'who', 'star',
  'favourite', 'favorite', 'underdog', 'pickTeam', 'side', 'sideName', 'leader', 'top', 'mvp'
])
/** answers never swapped (accounts, the admin console, the link lists themselves) */
const SKIP = /\/api\/(admin|crm|staff|auth|names|slugs?|slug-|perf|billing|unlocks|picks|email|push|client-error|visit)(\/|$|\?|-)/

/** every name field of an answer, in place (strings only; ids, slugs and links are other fields) */
export function localizeNames<T>(data: T, depth = 0): T {
  if (!namesOn || depth > 12 || data == null) return data
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      if (v && typeof v === 'object') localizeNames(v, depth + 1)
    }
    return data
  }
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (typeof v === 'string') { if (NAME_FIELDS.has(k)) { const x = map[v]; if (x !== undefined) o[k] = x } }
      else if (v && typeof v === 'object') localizeNames(v, depth + 1)
    }
  }
  return data
}

/** the axios side: public answers get their names swapped (called once at start, he / ar pages only) */
export function installNames() {
  if (!namesOn) return
  axios.interceptors.response.use(r => {
    const url = String(r.config?.url || '')
    if (url.includes('/api/') && !SKIP.test(url) && r.data && typeof r.data === 'object') localizeNames(r.data)
    return r
  })
}

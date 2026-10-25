/**
 * fix229: every link to a team, player, league or match, every sport: /<sport>/<kind>/<slug> (docs/notes/links.md).
 *
 * The slug comes from the item's name with the shared rules (lib/slugRules.ts, the server's twin), except for the
 * few items the server named differently (a shared name: barcelona-sc-ecuador, a renamed team, a second game of the
 * same teams on one day): those come from `/api/slugs/<sport>` (+ `/players`), loaded once per visit when a link of
 * that sport is first drawn; the app draws its links again when they arrive (useSlugVersion in App.tsx).
 * Each link remembers which id its slug stands for, so a click opens the page without asking the server.
 */
import { useSyncExternalStore } from 'react'
import { API_URL } from './socket'
import { teamSlug, playerSlug, leagueSlug, matchSlug, type LinkSport, type LinkKind } from './slugRules'

export type { LinkSport, LinkKind }
type Ex = { l: Record<string, string>; t: Record<string, string>; m: Record<string, string> }

const ex: Partial<Record<LinkSport, Ex>> = {}
const exP: Partial<Record<LinkSport, Record<string, string>>> = {}
const asked = new Set<string>()
let version = 0
const listeners = new Set<() => void>()
const bump = () => { version++; for (const l of listeners) l() }

function load(sport: LinkSport, players = false) {
  const k = `${sport}${players ? ':p' : ''}`
  if (asked.has(k) || typeof fetch === 'undefined') return
  asked.add(k)
  fetch(`${API_URL}/slugs/${sport}${players ? '/players' : ''}`, { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (!j) { asked.delete(k); return }
      if (players) exP[sport] = j.p || {}
      else ex[sport] = { l: j.l || {}, t: j.t || {}, m: j.m || {} }
      bump()
    })
    .catch(() => { setTimeout(() => asked.delete(k), 30_000) })
}
/** the app's links are drawn again when a sport's exception list arrives */
export function useSlugVersion(): number {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => version, () => version)
}

/* ---------- which id a slug stands for (filled by every link drawn, and by the page the server sent) ---------- */

const known = new Map<string, string>()
const remember = (sport: LinkSport, kind: LinkKind, slug: string, id: string | number) => {
  known.set(`${sport}/${kind}/${slug}`, String(id))
  if (known.size > 20000) known.delete(known.keys().next().value as string)
  return `/${sport}/${kind}/${slug}`
}
/** the id behind a slug when this visit already drew a link to it */
export const knownId = (sport: LinkSport, kind: LinkKind, slug: string) => known.get(`${sport}/${kind}/${slug}`) ?? null
export const rememberSlug = (sport: LinkSport, kind: LinkKind, slug: string, id: string | number) => { remember(sport, kind, slug, id) }

/* ---------- the links ---------- */

type Id = string | number | null | undefined
const ok = (id: Id): id is string | number => id != null && id !== '' && id !== 0

/** the slug of a team (its exception, else the rules on its name) */
export function teamSlugOf(sport: LinkSport, id: Id, name: string | null | undefined): string {
  load(sport)
  return (ok(id) && ex[sport]?.t[String(id)]) || teamSlug(name || '') || 'team'
}
/** the slug of a player */
export function playerSlugOf(sport: LinkSport, id: Id, name: string | null | undefined): string {
  load(sport); load(sport, true)
  return (ok(id) && exP[sport]?.[String(id)]) || playerSlug(name || '') || 'player'
}
/** a side of a match: tennis sides are players */
const sideSlug = (sport: LinkSport, id: Id, name: string | null | undefined) => (sport === 'tennis' ? playerSlugOf(sport, id, name) : teamSlugOf(sport, id, name))

/** fixed league slugs before the list arrives (the server's FB_LEAGUE_FIXED; NFL levels) */
const LEAGUE_FIXED: Partial<Record<LinkSport, Record<string, string>>> = {
  football: { PL: 'premier-league', ELC: 'championship', PD: 'la-liga', SA: 'serie-a', BL1: 'bundesliga', FL1: 'ligue-1', DED: 'eredivisie', PPL: 'primeira-liga', CL: 'champions-league', EC: 'european-championship', WC: 'world-cup', CLI: 'copa-libertadores', AF39: 'premier-league', AF40: 'championship', AF140: 'la-liga', AF135: 'serie-a', AF78: 'bundesliga', AF61: 'ligue-1', AF88: 'eredivisie', AF94: 'primeira-liga', AF2: 'champions-league' },
  'american-football': { '1': 'nfl', '2': 'college-football', NFL: 'nfl', NCAA: 'college-football' }
}

export function teamHref(sport: LinkSport, id: Id, name: string | null | undefined): string | null {
  if (!ok(id)) return null
  return remember(sport, 'team', teamSlugOf(sport, id, name), id)
}
export function playerHref(sport: LinkSport, id: Id, name: string | null | undefined): string | null {
  if (!ok(id)) return null
  return remember(sport, 'player', playerSlugOf(sport, id, name), id)
}
/** a league / competition / tournament by its code (football PL / AF383, basketball NBA, NFL 1 / 2, a tennis key) */
export function leagueHref(sport: LinkSport, code: Id, name?: string | null): string | null {
  if (!ok(code)) return null
  load(sport)
  let c = String(code)
  if (sport === 'football' && /^\d+$/.test(c)) c = `AF${c}`
  if (sport === 'football' || sport === 'basketball') c = c.toUpperCase()
  const slug = ex[sport]?.l[c] || LEAGUE_FIXED[sport]?.[c] || (sport === 'tennis' ? c : name ? leagueSlug(name) : c.toLowerCase())
  return remember(sport, 'league', slug, sport === 'american-football' ? (c === 'NCAA' || c === '2' ? '2' : '1') : c)
}
/** a match: /<sport>/match/<home>-vs-<away>-<yyyy-mm-dd> */
export function matchHref(sport: LinkSport, id: Id, m: { home: string | null | undefined; away: string | null | undefined; date: string | null | undefined; homeId?: Id; awayId?: Id }): string | null {
  if (!ok(id)) return null
  load(sport)
  const slug = ex[sport]?.m[String(id)] || matchSlug(sideSlug(sport, m.homeId, m.home), sideSlug(sport, m.awayId, m.away), m.date)
  return remember(sport, 'match', slug, id)
}

/** API sport keys → link sports */
export const LINK_SPORT: Record<string, LinkSport> = { football: 'football', fb: 'football', basketball: 'basketball', bb: 'basketball', nfl: 'american-football', 'american-football': 'american-football', tennis: 'tennis' }

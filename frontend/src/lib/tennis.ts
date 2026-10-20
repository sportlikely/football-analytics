import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from './socket'
import { t, LOCALE } from './i18n'
import { useAuth } from './auth'
import { useFavorites, type Favorite } from './favorites'

/**
 * Tennis site (fix193): types and helpers shared by the /tennis pages. Built like basketball / NFL: the two players are
 * the game's two sides ("home" = player 1, "away" = player 2) and the prediction uses the same fields (pHome / pAway /
 * pick 'H' | 'A'), so the shared components (SportHome, Games, GamePage, WinnerPrediction …) work as they are.
 */

export type TennisTour = 'atp' | 'wta' | 'challenger' | 'itf'
export interface TennisConfig { public: boolean; open: boolean; tours: TennisTour[] }
export interface TSide { id: number | null; name: string; country: string | null; rank: number | null; logo: null }
export interface TScore { sets: [number, number][]; won: [number, number]; points: [string, string] | null; server: 1 | 2 | null }
export interface TPred {
  locked: boolean
  model?: string
  pHome?: number; pAway?: number; pick?: 'H' | 'A'
  strongAt?: number; strong?: boolean; hit?: boolean | null
  firstSet?: { pHome: number; pAway: number } | null
  sets?: { score: string; pct: number }[]
  games?: { mean: number | null; median: number | null; over: Record<string, number> } | null
  why?: string[]
  numbers?: { eloSurface: [number, number]; eloOverall: [number, number]; servePoint: [number, number] } | null
  live?: { pHome: number; pAway: number; score: { home: number; away: number }; total: number } | null
}
export interface TMatch {
  id: number; tour: TennisTour; cat: string; women: boolean
  tournament: { key: string; name: string; tier: string | null; level: string; surface: string | null; indoor: boolean | null; city: string | null; country: string | null }
  round: string | null; roundCode: string | null; qualifying: boolean; bestOf: number
  start: string; status: string; state: 'upcoming' | 'live' | 'done' | 'off'
  home: TSide; away: TSide; score: TScore | null; winner: 1 | 2 | null; outcome: string | null
  rid: number
  prediction?: TPred | null
}

let configPromise: Promise<TennisConfig> | null = null
let configValue: TennisConfig | null = null
let configUser: string | null | undefined = undefined
/** Who may see the tennis site (admins before launch, everyone once TENNIS_PUBLIC=1). Loaded once per visit and sign-in. */
export function useTennisConfig(): TennisConfig | null {
  const { user, loading } = useAuth()
  const who = loading ? undefined : user ? String(user.id ?? user.email) : null
  const [cfg, setCfg] = useState<TennisConfig | null>(configUser === who ? configValue : null)
  useEffect(() => {
    if (who === undefined) return
    if (configUser !== who) { configUser = who; configValue = null; configPromise = null }
    if (configValue) { setCfg(configValue); return }
    configPromise ||= axios.get(`${API_URL}/tennis/config`, { withCredentials: true })
      .then(r => (configValue = r.data.data as TennisConfig))
      .catch(() => (configValue = { public: false, open: false, tours: [] }))
    let alive = true
    configPromise.then(v => alive && setCfg(v))
    return () => { alive = false }
  }, [who])
  return cfg
}

/** Reveal / unlock id (the server's tennisRid): its own negative range */
export const tennisRid = (m: { id: number }) => -(4e9 + m.id)
export const tennisRstatus = (m: TMatch) => (m.state === 'done' ? 'FT' : m.status)
/** the strong-pick line of tennis (tuned per tour on the server; 75% when the match doesn't say) */
export const TENNIS_STRONG = 75

export const TOUR_NAME: Record<TennisTour, string> = { atp: 'ATP', wta: 'WTA', challenger: 'Challenger', itf: 'ITF' }
/** "Grand Slam", "ATP 500", "WTA 1000", "Challenger" */
export function tierLabel(m: { tour: TennisTour; tournament: { tier: string | null; level: string } }): string {
  const t0 = String(m.tournament.tier || '').toLowerCase()
  if (t0 === 'grand_slam' || m.tournament.level === 'Grand Slam') return t('Grand Slam')
  if (m.tour === 'challenger') return m.tournament.level && /^\d+$/.test(t0.split('_').pop() || '') ? `Challenger ${t0.split('_').pop()}` : 'Challenger'
  if (/^\d+$/.test(m.tournament.level)) return `${TOUR_NAME[m.tour]} ${m.tournament.level}`
  return TOUR_NAME[m.tour]
}
export const SURFACE: Record<string, string> = { hard: t('Hard'), clay: t('Clay'), grass: t('Grass'), carpet: t('Carpet') }
export const surfaceName = (s: string | null | undefined, indoor?: boolean | null) => (s ? `${SURFACE[s] || s}${indoor ? ` · ${t('indoor')}` : ''}` : '')
/** colour dot of a surface (hard blue, clay orange, grass green) */
export const SURFACE_DOT: Record<string, string> = { hard: 'bg-sky-400', clay: 'bg-orange-400', grass: 'bg-emerald-500', carpet: 'bg-violet-400' }

/** "Carlos Alcaraz" → "Alcaraz" (tight rows); two-part surnames stay whole when the name has a particle */
export function surname(name: string | null | undefined): string {
  const n = String(name || '').trim()
  if (!n) return 'TBD'
  const w = n.split(/\s+/)
  if (w.length === 1) return n
  const i = w.findIndex((x, k) => k > 0 && /^(de|del|van|von|da|di|le|la|du|dos|der)$/i.test(x))
  return i > 0 ? w.slice(i).join(' ') : w[w.length - 1]
}

/** a set score from player 1's side: "6-4 3-6 7-6"; the current set of a live match is included */
export const setsText = (s: TScore | null, flip = false) => (s ? s.sets.map(([a, b]) => (flip ? `${b}-${a}` : `${a}-${b}`)).join(' ') : '')

/* ---------- flags (IOC country codes → emoji) ---------- */

const IOC_ISO: Record<string, string> = Object.fromEntries(`arg:ar aus:au aut:at bel:be bih:ba bra:br bul:bg can:ca chi:cl chn:cn col:co cro:hr cyp:cy cze:cz den:dk ecu:ec egy:eg
esp:es est:ee fin:fi fra:fr gbr:gb geo:ge ger:de gre:gr hkg:hk hun:hu ind:in ina:id irl:ie ita:it jpn:jp kaz:kz kor:kr lat:lv ltu:lt lux:lu mar:ma mex:mx
mda:md mon:mc ned:nl nzl:nz nor:no par:py per:pe phi:ph pol:pl por:pt qat:qa rou:ro rsa:za rus:ru srb:rs slo:si svk:sk sui:ch swe:se tha:th tun:tn tur:tr
ukr:ua uru:uy usa:us uzb:uz ven:ve blr:by uae:ae ksa:sa tpe:tw mne:me mkd:mk alb:al arm:am aze:az isl:is mlt:mt dom:do pur:pr bar:bb jam:jm lbn:lb jor:jo
kuw:kw bah:bs zim:zw ken:ke`.split(/\s+/).filter(Boolean).map(x => x.split(':')))
/** 🇪🇸 from "ESP" (or "es"); '' when unknown or a neutral flag */
export function flagOf(code: string | null | undefined): string {
  if (!code) return ''
  const c = String(code).trim().toLowerCase()
  const iso = c.length === 2 ? c : IOC_ISO[c]
  if (!iso || !/^[a-z]{2}$/.test(iso)) return ''
  return String.fromCodePoint(...[...iso.toUpperCase()].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65))
}

let byName: Map<string, string> | null = null
/** "Austria" → "at" (tournament countries come as English names): from the browser's own country names; '' unknown */
export function isoOfCountry(name: string | null | undefined): string {
  if (!name) return ''
  const n = name.trim().toLowerCase()
  if (/^[a-z]{2}$/.test(n)) return n
  if (/^[a-z]{3}$/.test(n)) return IOC_ISO[n] || ''
  if (!byName) {
    byName = new Map()
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' })
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b)
        const label = dn.of(code)
        if (label && label !== code) byName.set(label.toLowerCase(), code.toLowerCase())
      }
    } catch { /* old browser: no flags */ }
    for (const [k, v] of [['usa', 'us'], ['united states of america', 'us'], ['great britain', 'gb'], ['england', 'gb'], ['czech republic', 'cz'], ['korea', 'kr'], ['south korea', 'kr'], ['russia', 'ru'], ['turkey', 'tr'], ['the netherlands', 'nl'], ['uae', 'ae']]) byName.set(k, v)
  }
  return byName.get(n) || ''
}

/* ---------- links ---------- */

export const tennisHref = {
  match: (id: number) => `/tennis/match/${id}`,
  player: (id: number | null | undefined) => (id ? `/tennis/player/${id}` : null),
  tournament: (key: string) => `/tennis/tournament/${key}`
}
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })

/* ---------- favorites (players and tournaments, in the same account list as the other sports) ---------- */

export const tennisPlayerFav = (p: { id: number | null; name: string; country?: string | null }): Favorite => ({ kind: 'tennis-player', ref: String(p.id), name: p.name, img: null, code: p.country || null, ids: p.id ? [p.id] : [] })
export const tennisTournamentFav = (t0: { key: string; name: string }): Favorite => ({ kind: 'tennis-tournament', ref: t0.key, name: t0.name, img: null, code: t0.key })

export function useTennisFavorites() {
  const { list } = useFavorites()
  const players = list.filter(f => f.kind === 'tennis-player')
  const tournaments = list.filter(f => f.kind === 'tennis-tournament')
  const reasons = (m: TMatch) => [
    ...players.filter(f => f.ref === String(m.home.id) || f.ref === String(m.away.id)),
    ...tournaments.filter(f => f.ref === m.tournament.key)
  ]
  return { players, tournaments, all: [...players, ...tournaments], reasons }
}

/** The list pages' tour filter — All (default) · ATP · WTA · Challenger, kept in the address as ?tour=. */
export type TourFilter = 'all' | 'atp' | 'wta' | 'challenger'
export function useTennisTour() {
  const [params, setParams] = useSearchParams()
  const v = (params.get('tour') || '').toLowerCase()
  const tour: TourFilter = v === 'atp' || v === 'wta' || v === 'challenger' ? v : 'all'
  const set = (f: TourFilter) => {
    const next = new URLSearchParams(params)
    if (f === 'all') next.delete('tour'); else next.set('tour', f)
    setParams(next, { replace: true })
  }
  return { tour, set }
}

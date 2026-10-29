import type { Factor } from './whyFactors'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { matchHref, playerHref, leagueHref } from './links'
import axios from 'axios'
import { API_URL } from './socket'
import { t, LOCALE, lang } from './i18n'
import { useAuth } from './auth'
import { useFavorites, type Favorite } from './favorites'
import { latinOf } from './names'

/**
 * Tennis site (fix193): types and helpers shared by the /tennis pages. Built like basketball / NFL: the two players are
 * the game's two sides ("home" = player 1, "away" = player 2) and the prediction uses the same fields (pHome / pAway /
 * pick 'H' | 'A'), so the shared components (SportHome, Games, GamePage, WinnerPrediction …) work as they are.
 */

export type TennisTour = 'atp' | 'wta' | 'challenger' | 'itf'
export interface TennisConfig { public: boolean; open: boolean; tours: TennisTour[] }
/** fix195: `name` = the full name, `short` = the real surname (from the server) */
export interface TSide { id: number | null; name: string; short?: string; country: string | null; rank: number | null; logo: string | null }
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
  /** fix282: "Why we think so" — the model's logit terms */
  factors?: Factor[] | null
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

const PARTICLE = /^(de|del|della|dalla|delle|dello|di|da|das|dos|do|du|van|von|der|den|ter|ten|le|la|lo|mc|st\.?|al|el|ben|bin|y)$/i
/** two-word surnames that stay together (twin of COMPOUND_SURNAMES in backend/src/utils/tennisNames.ts) */
const COMPOUND = new Set([
  'bautista agut', 'carreno busta', 'davidovich fokina', 'ramos vinolas', 'haddad maia', 'sorribes tormo', 'carballes baena',
  'zapata miralles', 'martinez portero', 'diaz acosta', 'seyboth wild', 'mpetshi perricard', 'barrios vera', 'ugo carabelli',
  'pacheco mendez', 'bouzas maneiro', 'riera sanchez', 'garcia lopez', 'munar clar', 'mena garcia', 'bolelli tabilo', 'galan riveros',
  'varillas patino', 'nava torres', 'gomez lopez', 'blanch serrano', 'romero gormaz', 'sanchez izquierdo', 'llamas ruiz', 'moro canas',
  'vallejo ferreira', 'ramirez gonzalez', 'hernandez vazquez', 'lopez montagud', 'alvarez varona', 'castro vallejo', 'rodriguez taverna',
  'tirante baena', 'cid subervi', 'gonzalez caceres', 'olivieri menendez', 'rincon lopez', 'perez sanchez', 'herrero gonzalez',
  'bueno gonzalez', 'pellegrino martinez', 'meligeni rodrigues', 'ribeiro monteiro', 'trungelliti marchesi', 'garcia perez',
  'osorio serrano', 'vidal azorin', 'parrizas diaz', 'bassols ribera', 'sierra mendoza', 'gonzalez vaquero'
])
/**
 * fix195: the real surname for tight rows — "Carlos Alcaraz" → "Alcaraz", "Alex de Minaur" → "de Minaur", "Federico Dalla
 * Valle" → "Dalla Valle", "Roberto Bautista Agut" → "Bautista Agut", "Felix Auger-Aliassime" stays one word. A side from
 * the server carries `short` (the API's own last name when it has one): that wins. Twin of shortName() on the server.
 */
export function surname(x: string | { name: string; short?: string | null } | null | undefined): string {
  // fix261: a name swapped to the local script (he / ar) takes its own last word, not the provider's Latin last name
  if (x && typeof x === 'object') { if (x.short && latinOf(x.name) === x.name) return x.short; x = x.name }
  const n = String(x || '').trim()
  if (!n) return 'TBD'
  const w = n.split(/\s+/)
  if (w.length === 1) return n
  const i = w.findIndex((s, k) => k > 0 && k < w.length - 1 && PARTICLE.test(s))
  if (i > 0) return w.slice(i).join(' ')
  const two = w.slice(-2).join(' ')
  if (w.length >= 3 && COMPOUND.has(two.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase())) return two
  return w[w.length - 1]
}

/** fix195: "Round of 32", "Quarter-final", "Qualifying R2" from the round code (never the provider's text) */
export function roundName(x: { roundCode?: string | null; code?: string | null } | string | null | undefined): string {
  const c = String((x && typeof x === 'object' ? x.roundCode ?? x.code : x) || '').toUpperCase()
  if (!c) return ''
  let q: RegExpExecArray | null
  if ((q = /^Q(\d)$/.exec(c))) return t('Qualifying R{0}', { 0: q[1] })
  if (c === 'Q') return qualifyingWord()
  if (c === 'R16') return t('Round of 16')
  if ((q = /^R(32|64|128)$/.exec(c))) return t('Round of {0}', { 0: q[1] })
  if ((q = /^R(\d)$/.exec(c))) return t('Round {0}', { 0: q[1] })
  if (c === 'QF') return t('Quarter-final')
  if (c === 'SF') return t('Semi-final')
  // "Final" / "Qualifying" are other words elsewhere on the site (a finished game, a football preview): own keys here
  if (c === 'F') return lang === 'en' ? 'Final' : t('Final (round)')
  if (c === 'RR') return t('Round robin')
  return ''
}
/** "Qualifying" (the tennis qualifying draw) */
export const qualifyingWord = () => (lang === 'en' ? 'Qualifying' : t('Qualifying (round)'))

/** fix195: a country code ("PER", "pe") or English name → the country's name in the page language ("Peru", "Perú") */
export function countryName(code: string | null | undefined): string {
  const c = String(code || '').trim()
  if (!c) return ''
  const iso = /^[a-z]{2}$/i.test(c) ? c.toLowerCase() : /^[a-z]{3}$/i.test(c) ? IOC_ISO[c.toLowerCase()] : isoOfCountry(c)
  if (!iso) return /^[a-z]{3}$/i.test(c) ? c.toUpperCase() : c
  try { return new Intl.DisplayNames([LOCALE], { type: 'region' }).of(iso.toUpperCase()) || c } catch { return c }
}

/**
 * fix195: a short list of the biggest matches without one event filling it — at most `perEvent` from one tournament,
 * and men's and women's matches both in it when both play (the order of `sorted` is kept otherwise).
 */
export function spreadPicks(sorted: TMatch[], n: number, perEvent = 2): TMatch[] {
  const out: TMatch[] = []
  const per = new Map<string, number>()
  const room = (m: TMatch) => (per.get(m.tournament.key) || 0) < perEvent
  const take = (m: TMatch) => { out.push(m); per.set(m.tournament.key, (per.get(m.tournament.key) || 0) + 1) }
  for (const m of sorted) { if (out.length >= n) break; if (room(m)) take(m) }
  // both tours: when every pick is men's (or women's) and the other side has a match, its best one takes the last place
  for (const women of [true, false]) {
    if (out.length < 2 || out.some(m => m.women === women)) continue
    const other = sorted.find(m => m.women === women && !out.includes(m))
    if (!other) continue
    const drop = out.length >= n ? out.pop()! : null
    if (drop) per.set(drop.tournament.key, (per.get(drop.tournament.key) || 1) - 1)
    if (room(other)) take(other); else if (drop) take(drop)
  }
  return out
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
  const n = latinOf(name).trim().toLowerCase()
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

// fix229: slug links (/tennis/match/<player>-vs-<player>-<day>, /tennis/player/<slug>, /tennis/league/<tournament key>)
type TLinkSide = { id: number | null; name: string }
export const tennisHref = {
  match: (m: { id: number; start: string; home: TLinkSide; away: TLinkSide }) => matchHref('tennis', m.id, { home: m.home.name, away: m.away.name, homeId: m.home.id, awayId: m.away.id, date: m.start })!,
  player: (id: number | null | undefined, name: string | null | undefined) => playerHref('tennis', id, name),
  tournament: (key: string) => leagueHref('tennis', key)!
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

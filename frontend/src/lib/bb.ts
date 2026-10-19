import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from './socket'
import { t, LOCALE } from './i18n'
import { useAuth } from './auth'
import { useFavorites, type Favorite } from './favorites'

/** Basketball site (Oct 2026): types and helpers shared by the /basketball pages. */

export interface BbLeague { code: string; name: string; country: string; logo: string | null; flag?: string | null }
export interface BbConfig { public: boolean; open: boolean; leagues: BbLeague[] }
export interface BbSide { id: number; name: string; logo: string | null }
export interface BbPrediction {
  model: string
  pick: 'H' | 'A' | null
  locked: boolean
  pHome?: number
  pAway?: number
  spread?: number
  total?: number
  score?: { home: number; away: number }
  restHome?: number | null
  restAway?: number | null
  b2bHome?: boolean
  b2bAway?: boolean
  injHome?: number
  injAway?: number
  /** fix192: no games in this league yet, rated from another of our leagues */
  newHome?: string | null
  newAway?: string | null
  /** while the game is on: win chance now and the projected final score (from the prediction saved at tip-off) */
  live?: BbLiveChance | null
  hit: boolean | null
}
export interface BbLiveChance { pHome: number; pAway: number; score: { home: number; away: number }; total: number; left: number }
export interface BbGame {
  id: number
  league: { code: string; name: string; trial?: boolean }
  season: string
  round: string | null
  preseason: boolean
  kickoff: string
  status: string
  state: 'upcoming' | 'live' | 'done' | 'off'
  home: BbSide
  away: BbSide
  score: { home: number; away: number } | null
  quarters: { home: (number | null)[]; away: (number | null)[] } | null
  /** final score under review (doesn't count until checked) */
  resultCheck?: boolean
  /** final score corrected by us (provider was wrong) */
  corrected?: boolean
  /** live: minutes played / left in the current period (whole minutes) */
  clock?: { played: number; left: number } | null
  prediction: BbPrediction | null
}

let configPromise: Promise<BbConfig> | null = null
let configValue: BbConfig | null = null
let configUser: string | null | undefined = undefined
/** Who may see the basketball site (admins before launch, everyone after). Loaded once per visit and per sign-in. */
export function useBbConfig(): BbConfig | null {
  const { user, loading } = useAuth()
  const who = loading ? undefined : user ? String(user.id ?? user.email) : null
  const [cfg, setCfg] = useState<BbConfig | null>(configUser === who ? configValue : null)
  useEffect(() => {
    if (who === undefined) return
    if (configUser !== who) { configUser = who; configValue = null; configPromise = null }
    if (configValue) { setCfg(configValue); return }
    configPromise ||= axios.get(`${API_URL}/basketball/config`, { withCredentials: true })
      .then(r => {
        configValue = r.data.data as BbConfig
        // leagues added from the admin panel bring their own flag for the countries menu
        for (const l of configValue.leagues || []) if (l.flag && !BB_COUNTRY[l.code]) BB_COUNTRY[l.code] = l.flag
        return configValue
      })
      .catch(() => (configValue = { public: false, open: false, leagues: [] }))
    let alive = true
    configPromise.then(v => alive && setCfg(v))
    return () => { alive = false }
  }, [who])
  return cfg
}

/** League order on the pages (biggest first) and the country of each league for the flags menu. */
export const BB_ORDER = ['NBA', 'EL', 'ACB', 'BSL', 'EC', 'LBA', 'LNB', 'GBL', 'BBL', 'BCL', 'ABA', 'LKL', 'FEC', 'NBL', 'JBL', 'CBA', 'NBB', 'BSN']
export const bbRank = (code: string) => { const i = BB_ORDER.indexOf(code); return i < 0 ? 99 : i }
export const BB_COUNTRY: Record<string, string> = {
  NBA: 'us', EL: 'eu', ACB: 'es', LBA: 'it', BSL: 'tr', LNB: 'fr', BBL: 'de', GBL: 'gr', LKL: 'lt',
  EC: 'eu', BCL: 'eu', ABA: 'eu', FEC: 'eu', NBL: 'au', JBL: 'jp', CBA: 'cn', NBB: 'br', BSN: 'pr'
}

export const BB_STATUS: Record<string, string> = {
  Q1: t('Q1'), Q2: t('Q2'), Q3: t('Q3'), Q4: t('Q4'), OT: t('OT'), BT: t('Break'), HT: t('Half-time'),
  FT: t('Final'), AOT: t('Final (OT)'), POST: t('Postponed'), CANC: t('Cancelled'), SUSP: t('Suspended'), AWD: t('Awarded'), ABD: t('Abandoned')
}

/** "Q4 · 5 min left" (or just "Q4" / "Half-time" when there is no clock). */
export const liveLabel = (g: { status: string; clock?: { left: number } | null }, short = false) => {
  const base = BB_STATUS[g.status] || t('Live')
  if (!g.clock) return base
  return short ? `${base} · ${g.clock.left}'` : `${base} · ${t('{0} min left', { 0: g.clock.left })}`
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
export const dayOf = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })

/** The team we pick, its chance, and colours. */
export function pickOf(g: BbGame) {
  const p = g.prediction
  if (!p || !p.pick) return null
  const team = p.pick === 'H' ? g.home : g.away
  const pct = p.pick === 'H' ? p.pHome : p.pAway
  return { side: p.pick, team, pct: pct ?? null, color: p.pick === 'H' ? 'text-home' : 'text-away' }
}

/** Spread as people read it: "Lakers −4.5". */
export function spreadText(g: BbGame) {
  const s = g.prediction?.spread
  if (s === undefined || s === null) return null
  const fav = s >= 0 ? g.home : g.away
  return `${fav.name} −${Math.abs(s).toFixed(1)}`
}

/* ---------- favorites (basketball teams and leagues, in the same account list as football's) ---------- */

export const bbTeamFav = (team: BbSide, league?: string): Favorite => ({ kind: 'bb-team', ref: String(team.id), name: team.name, img: team.logo, code: league || null, ids: [team.id] })
/** fix153: a basketball player; their team's games count as favorites */
export const bbPlayerFav = (p: { id: number; name: string }, team: BbSide | null): Favorite => ({ kind: 'bb-player', ref: String(p.id), name: p.name, img: null, teamName: team?.name || null, teamImg: team?.logo || null, teamIds: team ? [team.id] : [] })
export const bbLeagueFav = (l: { code: string; name: string; logo: string | null }): Favorite => ({ kind: 'bb-league', ref: l.code, name: l.name, img: l.logo, code: l.code })

/** Basketball favorites and why a game is one of them. */
export function useBbFavorites() {
  const { list } = useFavorites()
  const teams = list.filter(f => f.kind === 'bb-team')
  const leagues = list.filter(f => f.kind === 'bb-league')
  const players = list.filter(f => f.kind === 'bb-player')
  const reasons = (g: BbGame) => [
    ...leagues.filter(f => f.ref === g.league.code),
    ...teams.filter(f => f.ref === String(g.home.id) || f.ref === String(g.away.id)),
    ...players.filter(f => (f.teamIds || []).some(id => id === g.home.id || id === g.away.id))
  ]
  return { teams, leagues, players, all: [...teams, ...leagues, ...players], reasons }
}

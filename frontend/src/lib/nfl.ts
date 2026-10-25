import { useEffect, useState, useSyncExternalStore } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from './socket'
import { t, LOCALE } from './i18n'
import { useAuth } from './auth'
import { useFavorites, type Favorite } from './favorites'
import { schoolOf } from './collegeNames'

/** NFL site (fix137): types and helpers shared by the /american-football pages. Predictions: nfl-v1 (fix139). */

export interface NflConfig { public: boolean; open: boolean; season: number | null; seasons: number[]; leagues?: { id: NflLeague; season: number | null }[] }
/** fix142: 1 = NFL, 2 = college football (NCAA) */
export type NflLeague = 1 | 2
export interface NflSide { id: number; name: string; logo: string | null }
export interface NflGame {
  id: number
  season: number
  week: string | null
  /** "1".."18" (regular season) or "post" (playoffs) */
  weekKey: string
  stage: string | null
  kickoff: string
  status: string
  state: 'upcoming' | 'live' | 'done' | 'off'
  home: NflSide
  away: NflSide
  score: { home: number; away: number } | null
  quarters: { home: (number | null)[]; away: (number | null)[] } | null
  venue: string | null
  /** fix142: 1 = NFL, 2 = college */
  league?: NflLeague
  /** fix213: the quarter clock while live ("8:42") */
  clock?: string | null
  /** fix139: our saved prediction (null = none yet). Locked = free / signed-out viewer, game not finished. */
  prediction?: NflPred | null
}
export interface NflQb { id: number; name: string; value: number; usualId: number | null; usualName: string | null; usualValue: number | null; adj: number; reason: 'same' | 'changed' | 'injury' | 'new' }
export interface NflWhy {
  eloHome: number; eloAway: number; eloGap: number; homeField: number; neutral: boolean
  rest: [number | null, number | null]; restAdj: [number, number]
  qb: [NflQb | null, NflQb | null]
  eff: { yppHome: number; yppAway: number; toHome: number; toAway: number } | null
  blend: boolean
}
export interface NflPred {
  locked: boolean
  model?: string
  pHome?: number; pAway?: number; pick?: 'H' | 'A'
  /** expected margin, home minus away (points) */
  margin?: number; total?: number; homePts?: number; awayPts?: number
  strong?: boolean; hit?: boolean | null
  why?: NflWhy | null
  /** fix174: live win chance + projected score while the game is on (numbers unlocked) */
  live?: { pHome: number; pAway: number; score: { home: number; away: number }; total: number } | null
}
export interface NflWeek { key: string; label: string; first: string; last: string; games: number }
export interface StandRow { team: NflSide; conference: string | null; division: string | null; level?: string | null; confW?: number; confL?: number; w: number; l: number; t: number; pct: number; pf: number; pa: number; diff: number; streak: string | null; games: number }
export interface Standings { season: number; league?: NflLeague; conferences: { name: string; level?: string | null; divisions: { name: string; rows: StandRow[] }[] }[]; rows: StandRow[] }
export interface LeaderCat { id: string; label: string; rows: { id: number; name: string; image: string | null; teamId: number; value: number; team: NflSide | null }[] }

let configPromise: Promise<NflConfig> | null = null
let configValue: NflConfig | null = null
let configUser: string | null | undefined = undefined
/** Who may see the NFL site (admins before launch, everyone once NFL_PUBLIC=1). Loaded once per visit and sign-in. */
export function useNflConfig(): NflConfig | null {
  const { user, loading } = useAuth()
  const who = loading ? undefined : user ? String(user.id ?? user.email) : null
  const [cfg, setCfg] = useState<NflConfig | null>(configUser === who ? configValue : null)
  useEffect(() => {
    if (who === undefined) return
    if (configUser !== who) { configUser = who; configValue = null; configPromise = null }
    if (configValue) { setCfg(configValue); return }
    configPromise ||= axios.get(`${API_URL}/nfl/config`, { withCredentials: true })
      .then(r => (configValue = r.data.data as NflConfig))
      .catch(() => (configValue = { public: false, open: false, season: null, seasons: [] }))
    let alive = true
    configPromise.then(v => alive && setCfg(v))
    return () => { alive = false }
  }, [who])
  return cfg
}

export const NFL_STATUS: Record<string, string> = {
  Q1: t('Q1'), Q2: t('Q2'), Q3: t('Q3'), Q4: t('Q4'), OT: t('OT'), HT: t('Half-time'),
  FT: t('Final'), AOT: t('Final (OT)'), CANC: t('Cancelled'), PST: t('Postponed')
}
export const weekLabel = (key: string | null, league: NflLeague = 1) => (!key ? '' : key === 'post' ? (league === 2 ? t('Bowls') : t('Playoffs')) : t('Week {0}', { 0: key }))
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
export const dayOf = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })
/** fix151: a game may come without a team name (null): shown as "TBD", never a crash. */
export const teamName = (name: string | null | undefined) => (typeof name === 'string' && name.trim() ? name : 'TBD')
/**
 * "Ohio State Buckeyes" → "Ohio State", "Alabama Crimson Tide" → "Alabama" (fix142: college rows use the school); a name
 * that already is a school ("South Dakota", "North Texas") stays whole (fix189, lib/collegeNames.ts).
 */
export const schoolName = (raw: string | null | undefined) => { const name = teamName(raw); return name === 'TBD' ? name : schoolOf(name) }
/** "Kansas City Chiefs" → "Chiefs" for tight rows (the nickname is what people say); college: the school name. */
export const nick = (raw: string | null | undefined, league: NflLeague = 1) => { if (league === 2) return schoolName(raw); const name = teamName(raw); const w = name.split(/\s+/); return w.length > 1 ? w[w.length - 1] : name }
/**
 * fix214: a school's name for tight rows on phones (list rows, the Live box, Spotlight): "North Dakota State" →
 * "N. Dakota St.", "Eastern Michigan" → "E. Michigan"; short names (12 letters or fewer) stay as they are.
 */
export const schoolShort = (raw: string | null | undefined) => {
  const s = schoolName(raw)
  if (s.length <= 12) return s
  return s.replace(/^University of /, '').replace(/\bState\b/g, 'St.').replace(/\b(North|South|East|West)(ern)?\b(?=\s)/g, m => `${m[0]}.`)
    .replace(/\bCentral\b(?=\s)/g, 'C.').replace(/\bInternational\b/g, 'Intl.')
}
/** fix214: the name in a list row: NFL the nickname ("Chiefs"), college the short school name */
export const rowName = (raw: string | null | undefined, league: NflLeague = 1) => (league === 2 ? schoolShort(raw) : nick(raw, 1))
/** Reveal ids for NFL games (own negative range: never clashes with football ids or basketball's -id). */
export const nflRid = (g: { id: number }) => -(2e9 + g.id)
export const nflRstatus = (g: NflGame) => (g.state === 'done' ? 'FT' : g.status)
export const record = (r: { w: number; l: number; t: number } | null | undefined) => (r ? `${r.w ?? 0}-${r.l ?? 0}${r.t ? `-${r.t}` : ''}` : '–')

/* ---------- favorites (NFL teams, in the same account list as football's) ---------- */

export const nflTeamFav = (team: NflSide): Favorite => ({ kind: 'nfl-team', ref: String(team.id), name: team.name, img: team.logo, ids: [team.id] })

/** fix153: an NFL / college player; their team's games count as favorites */
export const nflPlayerFav = (p: { id: number; name: string; image?: string | null }, team: NflSide | null): Favorite => ({ kind: 'nfl-player', ref: String(p.id), name: p.name, img: p.image || null, teamName: team?.name || null, teamImg: team?.logo || null, teamIds: team ? [team.id] : [] })

export function useNflFavorites() {
  const { list } = useFavorites()
  const teams = list.filter(f => f.kind === 'nfl-team')
  const players = list.filter(f => f.kind === 'nfl-player')
  const reasons = (g: NflGame) => [
    ...teams.filter(f => f.ref === String(g.home.id) || f.ref === String(g.away.id)),
    ...players.filter(f => (f.teamIds || []).some(id => id === g.home.id || id === g.away.id))
  ]
  return { teams, players, all: [...teams, ...players], reasons }
}

/* ---------- fix142: the league on screen (NFL | College) ---------- */

/** List pages of college football live under /american-football/college (games, today, league). */
export const nflBase = (l: NflLeague) => (l === 2 ? '/american-football/college' : '/american-football')
export const nflLeagueName = (l: NflLeague) => (l === 2 ? t('College football') : 'NFL')
/** The model of the league and its strong-pick line (college has more mismatches: 75%). */
export const nflModelOf = (l: NflLeague) => (l === 2 ? 'ncaa-v1' : 'nfl-v1')
export const nflStrongAt = (l: NflLeague) => (l === 2 ? 75 : 70)
// fix185: American football is one sport — home, games and today show NFL and college together (a filter in the URL,
// useNflFilter). Only the standings page is per league; the league of the page last shown (in memory, no storage) picks
// which standings the menu opens.
let remembered: NflLeague = 1
const subs = new Set<() => void>()
/** Game / team / player / standings pages tell which league they show (the menu's Standings link follows). */
export function setNflLeague(l: NflLeague | undefined | null) {
  if (l !== 1 && l !== 2) return
  if (l === remembered) return
  remembered = l
  subs.forEach(f => f())
}
const LEAGUE_PAGE = /^\/american-football\/league\/(nfl|college-football)\/?$/ // fix229: /american-football/league/<slug>
/** The league of a per-league page (standings: from the path; game / team / player pages set it). */
export function useNflLeague() {
  const { pathname } = useLocation()
  const mem = useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => remembered)
  const m = pathname.match(LEAGUE_PAGE)
  const league: NflLeague = m ? (m[1] === 'college-football' ? 2 : 1) : mem
  useEffect(() => { if (m) setNflLeague(league) }, [league, !!m])
  return { league, base: nflBase(league), name: nflLeagueName(league), model: nflModelOf(league), strong: nflStrongAt(league), sub: m ? 'league' : null }
}

/** fix185: the list pages' league filter — All (default) · NFL · College, kept in the address as ?league=nfl|college. */
export type NflFilter = 'all' | NflLeague
export function useNflFilter() {
  const [params, setParams] = useSearchParams()
  const v = (params.get('league') || '').toLowerCase()
  const filter: NflFilter = v === 'nfl' || v === '1' ? 1 : v === 'college' || v === '2' || v === 'ncaa' ? 2 : 'all'
  const set = (f: NflFilter) => {
    const next = new URLSearchParams(params)
    if (f === 'all') next.delete('league'); else next.set('league', f === 2 ? 'college' : 'nfl')
    setParams(next, { replace: true })
  }
  return { filter, set, param: filter === 'all' ? 'all' : String(filter) }
}

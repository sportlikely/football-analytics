import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from './socket'
import { t } from './i18n'
import { useAuth } from './auth'

/**
 * fix215: the season forecast — every league simulated to the end 20,000 times with our match model
 * (backend services/seasonForecast.ts). One set of types and labels for the league tab, the team card and the
 * "What this game means" line, in every sport.
 */
export type FcSport = 'football' | 'basketball' | 'nfl'
export type ZoneKey = 'title' | 'cl' | 'europe' | 'promotion' | 'promo_po' | 'releg_po' | 'relegation'
  | 'playoffs' | 'playin' | 'bye' | 'div_title' | 'conf_title' | 'final' | 'shield' | 'top_group'

export interface FcNow { rank: number; pts: number; played: number; w: number; d: number; l: number; diff: number }
export interface FcTeam {
  id: string; name: string; group: string | null; logo: string | null; now: FcNow
  avgPts?: number; avgPos?: number; zones?: Partial<Record<ZoneKey, number>>; pos?: number[]; locked?: boolean
}
/** fix218: whether last season's replay found ">99%" (hi) and "<1%" (lo) calibrated; else the page says 99% / 1% */
export interface FcExtremes { hi: boolean; lo: boolean }
export interface FcLeague {
  sport: FcSport; code: string; name: string; season: string; runAt: string; runs: number; known: boolean
  /** fix230: no zones because the format waits for last season's replay check ('replay') or is not added ('format') */
  pending?: 'replay' | 'format'
  zones: ZoneKey[]; groups: string[]; teams: FcTeam[]; gamesLeft: number; full: boolean; locked: number; extremes?: FcExtremes
}
export interface FcTeamCard {
  code: string; league: string; season: string; runAt: string; runs: number; known: boolean; zones: ZoneKey[]; size: number; extremes?: FcExtremes
  team: FcTeam; history: { day: string; zones: Partial<Record<ZoneKey, number>>; avgPos: number }[]
}
export interface FcMeaning {
  locked?: boolean; league: string; runs?: number; results?: string[]; share?: number[]; extremes?: FcExtremes
  home: { id: string; name: string; lines?: { zone: ZoneKey; now: number | null; byResult: (number | null)[] }[] }
  away: { id: string; name: string; lines?: { zone: ZoneKey; now: number | null; byResult: (number | null)[] }[] }
}

/** a zone's name on the page (column heads, the team card, what a game means) */
export function zoneLabel(z: ZoneKey, sport: FcSport): string {
  switch (z) {
    case 'title': return sport === 'nfl' ? t('Super Bowl') : t('Title')
    case 'final': return t('Final')
    case 'conf_title': return t('Conference title')
    case 'div_title': return t('Division title')
    case 'bye': return t('Top seed')
    case 'playoffs': return t('Play-offs')
    case 'playin': return t('Play-in')
    case 'promotion': return t('Promotion')
    case 'promo_po': return t('Promotion play-off')
    case 'cl': return t('Champions League')
    case 'europe': return t('Europe')
    case 'releg_po': return t('Relegation play-off')
    case 'relegation': return t('Relegation')
    case 'shield': return t('Top of the table')
    case 'top_group': return t('Top group')
  }
}
/** zones where a high number is bad news */
export const BAD_ZONE = (z: ZoneKey) => z === 'relegation' || z === 'releg_po'
/** the zone columns a table shows (the final is in the heat map / team card only) */
export const tableZones = (zones: ZoneKey[]) => zones.filter(z => z !== 'final')

/** a chance as a whole %. ">99%" / "<1%" only when the replay says that level is calibrated (fix218); else 99% / 1% */
export const pct = (x: number | null | undefined, ex?: FcExtremes) => x == null ? '–'
  : x >= 0.995 ? (ex?.hi ? '>99%' : '99%')
  : x > 0 && x < 0.005 ? (ex?.lo ? '<1%' : '1%')
  : `${Math.round(x * 100)}%`
/** fix218: a row of chances as whole percents that add up to exactly 100 (largest remainder) */
export function rowPct(pos: number[]): number[] {
  const scaled = pos.map(p => p * 100), floor = scaled.map(Math.floor)
  let left = 100 - floor.reduce((a, b) => a + b, 0)
  const order = scaled.map((v, i) => ({ i, rem: v - floor[i] })).sort((a, b) => b.rem - a.rem)
  for (let j = 0; j < order.length && left > 0; j++, left--) floor[order[j].i]++
  return floor
}

function useFc<T>(path: string | null): { data: T | null; loading: boolean } {
  const { access } = useAuth()
  const [s, setS] = useState<{ data: T | null; loading: boolean }>({ data: null, loading: !!path })
  useEffect(() => {
    if (!path) { setS({ data: null, loading: false }); return }
    let off = false
    setS(x => ({ ...x, loading: true }))
    axios.get(`${API_URL}/season-forecast/${path}`).then(r => { if (!off) setS({ data: r.data.data ?? null, loading: false }) }).catch(() => { if (!off) setS({ data: null, loading: false }) })
    return () => { off = true }
  }, [path, access])
  return s
}
export const useLeagueForecast = (sport: FcSport, code: string | null) => useFc<FcLeague>(code ? `${sport}/league/${encodeURIComponent(code)}` : null)
export const useTeamForecast = (sport: FcSport, id: string | number | null) => useFc<FcTeamCard[]>(id != null ? `${sport}/team/${id}` : null)
export const useGameMeaning = (sport: FcSport, id: string | number | null) => useFc<FcMeaning>(id != null ? `${sport}/game/${id}` : null)

import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { useAuth } from '../../../lib/auth'
import { GAME_RELOAD } from '../../UnlockPrompt'

/**
 * fix204 "More predictions" as the page reads them (backend services/morePredictions.ts moreForGame): only the outputs
 * visitors may see (the fix204 / fix278 gates; admins: all, listed in adminOnly), each set in % with its top label.
 * fix281: read by the prediction tab (components/sport/prediction/*); the separate More predictions block is gone.
 */
export type MoreSport = 'football' | 'basketball' | 'nfl' | 'tennis'
export interface MSet { labels: string[]; p: number[]; cuts?: number[]; top: number }
export interface MoreData {
  sport: MoreSport; state: 'upcoming' | 'live' | 'done'; keys: string[]
  prediction: {
    model: string; locked: boolean; madeAt?: string; savedBeforeStart?: boolean
    sets?: Record<string, MSet>
    info?: { grid6?: number[][]; expected?: [number, number]; side?: 'H' | 'A'; bo?: number; xg?: [number, number]; line?: number; expGames?: number | null }
    adminOnly?: string[]; result?: { actual: Record<string, string | number | null>; hits: Record<string, { hit: boolean; i: number }> } | null; void?: boolean
  }
}

/** the game's extras, reloaded every 2 minutes and when a free pick opens the game */
export function useMore(sport: MoreSport, id: number): MoreData | null {
  const { access } = useAuth()
  const [d, setD] = useState<MoreData | null>(null)
  useEffect(() => {
    let off = false
    const load = () => axios.get(`${API_URL}/more/${sport}/${id}`).then(r => { if (!off) setD(r.data.data || null) }).catch(() => undefined)
    load()
    const iv = setInterval(load, 120000)
    window.addEventListener(GAME_RELOAD, load)
    return () => { off = true; clearInterval(iv); window.removeEventListener(GAME_RELOAD, load) }
  }, [sport, id, access])
  return d
}

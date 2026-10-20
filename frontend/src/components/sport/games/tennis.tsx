import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t as tt } from '../../../lib/i18n'
import { useAuth } from '../../../lib/auth'
import { useFavorites } from '../../../lib/favorites'
import { useTennisFavorites, useTennisTour, tennisTournamentFav, tennisHref, tierLabel, surfaceName, isoOfCountry, type TMatch } from '../../../lib/tennis'
import { toGame, toResult } from '../../SportHome/tennis'
import { TennisTourChips, TennisTournamentPanel } from '../../../pages/tennis/parts'
import type { GamesAdapter, GamesData, SGame, SLeague, SChip } from '../types'

/** Tennis's adapter for the shared Matches page (fix193): data + labels only. The "leagues" are the tournaments. */

/** the side chips of a row: the most likely set score and the median total games */
export function tennisChips(p: TMatch['prediction']): SChip[] {
  if (!p || p.locked) return []
  const out: SChip[] = []
  const top = p.sets && p.sets[0]
  if (top) out.push({ key: 'sets', label: tt("Sets"), value: top.score.replace('-', '–'), title: tt("Most likely set score") })
  if (p.games && typeof p.games.median === 'number') out.push({ key: 'games', label: tt("Games"), value: String(p.games.median), title: tt("Total games (median)") })
  return out
}
/** a tournament as the sidebar / groups show it: biggest events first */
export const tournamentOf = (m: TMatch, level: number): SLeague => ({
  // the bar reads "AUSTRIA: Erste Bank Open · ATP 500 · Hard" (football: "SPAIN: LaLiga")
  code: m.tournament.key, name: m.tournament.name, short: `${m.tournament.name} · ${tierLabel(m)}${m.tournament.surface ? ` · ${surfaceName(m.tournament.surface, m.tournament.indoor)}` : ''}`,
  logo: null, country: isoOfCountry(m.tournament.country) || 'world', rank: level, href: tennisHref.tournament(m.tournament.key), fav: tennisTournamentFav(m.tournament)
})
const LEVEL: Record<string, number> = { 'Grand Slam': 0, '1000': 1, '500': 2, '250': 3, Challenger: 4, ITF: 5 }
export const levelOf = (m: TMatch) => (LEVEL[m.tournament.level] ?? 6) * 10 + (m.tour === 'wta' ? 1 : 0)

/** one match as the shared list rows show it (Matches, Favorites, the player and tournament pages) */
export function tennisSGame(m: TMatch, lg: SLeague = tournamentOf(m, levelOf(m)), favWhy: string[] = []): SGame {
  const p = m.prediction
  const open = !!p && !p.locked && typeof p.pHome === 'number'
  // Spotlight: the bigger the event and the closer the match, the higher
  const weight = open ? (6 - Math.min(6, Math.floor(levelOf(m) / 10))) / 3 + (1 - Math.abs(p!.pHome! - 50) / 50) : 0
  return {
    ...toGame(m), state: m.state as SGame['state'], league: lg, favWhy, weight, chips: tennisChips(p),
    note: m.state === 'live' && open && p!.live ? { text: tt("Now: {0} {1}%", { 0: (p!.live.pHome >= p!.live.pAway ? m.home : m.away).name.split(' ').pop(), 1: Math.round(Math.max(p!.live.pHome, p!.live.pAway)) }), tone: 'live' as const } : null,
    hit: m.state === 'done' ? p?.hit ?? null : undefined
  }
}

function useData(): GamesData {
  const { access } = useAuth()
  const { tour } = useTennisTour()
  const favs = useTennisFavorites()
  const { list } = useFavorites()
  const [matches, setMatches] = useState<TMatch[] | null>(null)
  const [results, setResults] = useState<TMatch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    setMatches(null); setResults(null)
    const load = () => {
      const now = Date.now()
      axios.get(`${API_URL}/tennis/matches`, { params: { from: new Date(now - 6 * 3600e3).toISOString(), to: new Date(now + 7 * 86400e3).toISOString(), tour } })
        .then(r => { if (!off) { setMatches(r.data.data.matches || []); setError(null) } }).catch(e => !off && setError(e?.message || 'error'))
      axios.get(`${API_URL}/tennis/home`, { params: { tour } }).then(r => !off && setResults(r.data.data?.results || [])).catch(() => !off && setResults([]))
    }
    load()
    const iv = setInterval(load, 60000)
    return () => { off = true; clearInterval(iv) }
  }, [access, tour])

  return useMemo(() => {
    const leagues = new Map<string, SLeague>()
    const games: SGame[] = (matches || []).filter(m => m.state === 'upcoming' || m.state === 'live').map(m => {
      const lg = leagues.get(m.tournament.key) || tournamentOf(m, levelOf(m))
      leagues.set(m.tournament.key, lg)
      return tennisSGame(m, lg, favs.reasons(m).map(f => f.name))
    })
    return {
      loading: matches === null, error, games, leagues: [...leagues.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)),
      results: { rows: results ? results.map(toResult) : null, days: 30, link: null },
      favTeams: favs.players.map(f => ({ key: f.ref, name: f.name, logo: null, to: tennisHref.player(Number(f.ref)) || '/tennis' })),
      favLeagues: list.filter(f => f.kind === 'tennis-tournament').map(f => f.ref),
      hasFavorites: favs.all.length > 0
    }
  }, [matches, results, error, favs.all.length, list])
}

/** The Matches page: football's layout; tournaments in the sidebar, the tour chips above. */
export function useTennisGames(): GamesAdapter {
  return {
    title: tt("Tennis matches"),
    countLine: (n, days) => tt("{0} matches in the next {1} days", { 0: n, 1: days }),
    noLive: tt("No matches in play right now."),
    defaultPinned: [],
    favoritesHref: '/tennis/favorites',
    top: <TennisTourChips />,
    leaguePanel: code => <TennisTournamentPanel tkey={code} />,
    useData
  }
}

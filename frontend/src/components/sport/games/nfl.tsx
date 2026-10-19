import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t as tt } from '../../../lib/i18n'
import { useAuth } from '../../../lib/auth'
import { useFavorites, type Favorite } from '../../../lib/favorites'
import { useNflFavorites, useNflLeague, nflLeagueName, nflBase, type NflGame, type NflLeague } from '../../../lib/nfl'
import { toGame, toResult } from '../../SportHome/nfl'
import { LeagueSwitch, NflLeaguePanel } from '../../../pages/nfl/parts'
import { winnerChips } from './basketball'
import type { GamesAdapter, GamesData, SGame, SLeague } from '../types'

/** NFL + college football's adapter for the shared Games page (fix152a): data + labels only; the league from the URL. */

const leagueOf = (l: NflLeague): SLeague => {
  const code = l === 2 ? 'NCAA' : 'NFL', name = nflLeagueName(l)
  const fav: Favorite = { kind: 'nfl-league', ref: code, code, name, img: null }
  return { code, name, logo: null, country: 'us', rank: 0, href: `${nflBase(l)}/league`, fav }
}
/** Primetime: Thursday / Sunday / Monday night games start 00:00–03:59 UTC (8:15 pm Eastern). */
const primetime = (g: NflGame) => new Date(g.kickoff).getUTCHours() < 4

function useData(): GamesData {
  const { access } = useAuth()
  const { league } = useNflLeague()
  const favs = useNflFavorites()
  const { list } = useFavorites()
  const [games, setGames] = useState<NflGame[] | null>(null)
  const [results, setResults] = useState<NflGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    setGames(null); setResults(null)
    const load = () => {
      const now = Date.now()
      axios.get(`${API_URL}/nfl/games`, { params: { from: new Date(now - 6 * 3600e3).toISOString(), to: new Date(now + 30 * 86400e3).toISOString(), league } })
        .then(r => { if (!off) { setGames(r.data.data.games || []); setError(null) } }).catch(e => !off && setError(e?.message || 'error'))
      axios.get(`${API_URL}/nfl/home`, { params: { league } }).then(r => !off && setResults(r.data.data?.results || [])).catch(() => !off && setResults([]))
    }
    load()
    const iv = setInterval(load, 60000)
    return () => { off = true; clearInterval(iv) }
  }, [access, league])

  return useMemo(() => {
    const lg = leagueOf(league)
    const listOut: SGame[] = (games || []).filter(g => g.state === 'upcoming' || g.state === 'live').map(g => {
      const p = g.prediction
      const open = !!p && !p.locked && typeof p.pHome === 'number'
      // Spotlight: primetime first, then the closer the game
      const weight = open ? (primetime(g) ? 1.5 : 1) + (1 - Math.abs(p!.pHome! - 50) / 50) : 0
      return { ...toGame(g), state: g.state as SGame['state'], league: lg, favWhy: favs.reasons(g).map(f => f.name), weight, chips: open ? winnerChips(p) : [] }
    })
    return {
      loading: games === null, error, games: listOut, leagues: [lg],
      results: { rows: results ? results.map(toResult) : null, days: 30, link: null },
      favTeams: favs.teams.map(f => ({ key: f.ref, name: f.name, logo: f.img || null, to: `/american-football/team/${f.ref}` })),
      favLeagues: list.filter(f => f.kind === 'nfl-league').map(f => f.ref),
      hasFavorites: favs.all.length > 0
    }
  }, [games, results, error, league, favs.all.length, list])
}

/** The adapter of the league on screen (NFL | College): the title follows it. */
export function useNflGames(): GamesAdapter {
  const { league } = useNflLeague()
  return {
    title: league === 2 ? tt("College football games") : tt("NFL games"),
    countLine: (n, days) => tt("{0} games in the next {1} days", { 0: n, 1: days }),
    noLive: tt("No games in play right now."),
    defaultPinned: [league === 2 ? 'NCAA' : 'NFL'],
    favoritesHref: '/american-football/favorites',
    top: <LeagueSwitch />,
    // fix183b: two leagues and the NFL | College switch above already chooses: no league list
    noLeagueList: true,
    // fix174: the chosen league's standings (football's league panel)
    leaguePanel: () => <NflLeaguePanel league={league} />,
    useData
  }
}

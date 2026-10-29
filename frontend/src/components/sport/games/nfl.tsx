import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t as tt } from '../../../lib/i18n'
import { useAuth } from '../../../lib/auth'
import { useFavorites, type Favorite } from '../../../lib/favorites'
import { useNflFavorites, useNflFilter, nflLeagueName, type NflGame, type NflLeague } from '../../../lib/nfl'
import { toGame, toResult } from '../../SportHome/nfl'
import { NflLeagueChips, NflLeaguePanel } from '../../../pages/nfl/parts'
import { winnerChips } from './basketball'
import type { GamesAdapter, GamesData, SGame, SLeague } from '../types'
import { teamHref, leagueHref, useSlugVersion } from '../../../lib/links'

/** NFL + college football's adapter for the shared Games page (fix152a): data + labels only; the league from the URL. */

const leagueOf = (l: NflLeague): SLeague => {
  const code = l === 2 ? 'NCAA' : 'NFL', name = nflLeagueName(l)
  const fav: Favorite = { kind: 'nfl-league', ref: code, code, name, img: null }
  // fix213: NFL first, college second (sidebar, Live box); the address keeps its words (?league=nfl / college)
  return { code, name, logo: null, country: 'us', rank: l === 2 ? 1 : 0, href: leagueHref('american-football', String(l))!, fav, param: l === 2 ? 'college' : 'nfl' }
}
/** Primetime: Thursday / Sunday / Monday night games start 00:00–03:59 UTC (8:15 pm Eastern). */
const primetime = (g: NflGame) => new Date(g.kickoff).getUTCHours() < 4

function useData(): GamesData {
  const { access } = useAuth()
  const { param: league } = useNflFilter()
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
      // fix213: both leagues always (the page filters, the sidebar counts each league's games)
      axios.get(`${API_URL}/nfl/games`, { params: { from: new Date(now - 6 * 3600e3).toISOString(), to: new Date(now + 30 * 86400e3).toISOString(), league: 'all' } })
        .then(r => { if (!off) { setGames(r.data.data.games || []); setError(null) } }).catch(e => !off && setError(e?.message || 'error'))
      axios.get(`${API_URL}/nfl/home`, { params: { league } }).then(r => !off && setResults(r.data.data?.results || [])).catch(() => !off && setResults([]))
    }
    load()
    const iv = setInterval(load, 60000)
    return () => { off = true; clearInterval(iv) }
  }, [access, league])

  // fix280: the rows' links are drawn again when the sport's slug exceptions / seasons arrive (lib/links.ts): drawn before,
  // they kept the rules' slug (a dead link) or none
  const slugV = useSlugVersion()
  return useMemo(() => {
    // fix185: both leagues mixed by time (each game in its own league); fix213: the left column / phone chips choose one
    const lgs = new Map(([1, 2] as NflLeague[]).map(l => [l, leagueOf(l)]))
    const listOut: SGame[] = (games || []).filter(g => g.state === 'upcoming' || g.state === 'live').map(g => {
      const lg = lgs.get(g.league === 2 ? 2 : 1) || leagueOf(g.league === 2 ? 2 : 1)
      const p = g.prediction
      const open = !!p && !p.locked && typeof p.pHome === 'number'
      // Spotlight: primetime first, then the closer the game
      const weight = open ? (primetime(g) ? 1.5 : 1) + (1 - Math.abs(p!.pHome! - 50) / 50) : 0
      const h = toGame(g)
      // fix213: the live win chance in the Live box (basketball's "Now: Chiefs 71%")
      let note: SGame['note'] = null
      if (g.state === 'live' && p?.live) { const k = p.live.pHome >= p.live.pAway ? 'H' : 'A'; note = { text: `${tt("Now")}: ${k === 'H' ? h.home.short : h.away.short} ${Math.round(k === 'H' ? p.live.pHome : p.live.pAway)}%`, tone: 'live' } }
      return { ...h, state: g.state as SGame['state'], league: lg, favWhy: favs.reasons(g).map(f => f.name), weight, chips: open ? winnerChips(p) : [], note }
    })
    return {
      loading: games === null, error, games: listOut, leagues: [...lgs.values()],
      results: { rows: results ? results.map(toResult) : null, days: 30, link: null },
      favTeams: favs.teams.map(f => ({ key: f.ref, name: f.name, logo: f.img || null, to: teamHref('american-football', f.ref, f.name)! })),
      favLeagues: list.filter(f => f.kind === 'nfl-league').map(f => f.ref),
      hasFavorites: favs.all.length > 0
    }
  }, [games, results, error, league, favs.all.length, list, slugV])
}

/** fix185: NFL and college together; the All · NFL · College chips (in the address) filter. */
export function useNflGames(): GamesAdapter {
  const { filter } = useNflFilter()
  return {
    title: tt("American football games"),
    countLine: (n, days) => tt("{0} games in the next {1} days", { 0: n, 1: days }),
    noLive: tt("No games in play right now."),
    defaultPinned: ['NFL', 'NCAA'],
    favoritesHref: '/american-football/favorites',
    // fix213: desktop chooses the league in the left column like every sport; phones keep the All · NFL · College chips
    mobileFilter: <NflLeagueChips />,
    // fix174: one league chosen in the chips → its standings on the right (football's league panel)
    sidePanel: filter === 'all' ? null : <NflLeaguePanel league={filter} />,
    useData
  }
}

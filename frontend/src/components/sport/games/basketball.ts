import { createElement, useEffect, useMemo, useState } from 'react'
import { BbLeaguePanel } from '../../../pages/bb/BbLeague'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t as tt } from '../../../lib/i18n'
import { useAuth } from '../../../lib/auth'
import { useBbConfig, useBbFavorites, bbLeagueFav, bbRank, BB_COUNTRY, type BbGame } from '../../../lib/bb'
import { toGame, toResult } from '../../SportHome/basketball'
import type { GamesAdapter, GamesData, SGame, SLeague, SChip } from '../types'
import { teamHref, leagueHref } from '../../../lib/links'

/** Basketball's adapter for the shared Games page (fix152a): data + labels only. */

/** Margin / Total pts chips (the model's expected margin and total). */
export function winnerChips(p: { locked?: boolean; spread?: number | null; margin?: number | null; total?: number | null } | null | undefined): SChip[] {
  if (!p || p.locked) return []
  const m = typeof p.spread === 'number' ? p.spread : typeof p.margin === 'number' ? p.margin : null
  if (m === null || typeof p.total !== 'number') return []
  return [
    { key: 'margin', label: tt("Margin"), value: `${m >= 0 ? '1' : '2'} +${Math.abs(m).toFixed(1)}`, title: tt("Expected margin") },
    { key: 'total', label: tt("Total pts"), value: p.total.toFixed(1), title: tt("Total points") }
  ]
}

function useData(): GamesData {
  const { access } = useAuth()
  const cfg = useBbConfig()
  const favs = useBbFavorites()
  const [games, setGames] = useState<BbGame[] | null>(null)
  const [results, setResults] = useState<BbGame[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let off = false
    const load = () => {
      axios.get(`${API_URL}/basketball/games`, { params: { days: 30 } }).then(r => { if (!off) { setGames(r.data.data || []); setError(null) } }).catch(e => !off && setError(e?.message || 'error'))
      axios.get(`${API_URL}/basketball/games`, { params: { days: 7, results: 1 } }).then(r => !off && setResults((r.data.data || []).filter((g: BbGame) => g.state === 'done'))).catch(() => !off && setResults([]))
    }
    load()
    const iv = setInterval(load, 60000)
    return () => { off = true; clearInterval(iv) }
  }, [access])

  return useMemo(() => {
    const leagues: SLeague[] = (cfg?.leagues || []).map(l => ({ code: l.code, name: l.name, logo: l.logo, country: BB_COUNTRY[l.code] || 'world', rank: bbRank(l.code), href: leagueHref('basketball', l.code, l.name)!, fav: bbLeagueFav(l) }))
    const byCode = new Map(leagues.map(l => [l.code, l]))
    const list: SGame[] = (games || []).filter(g => g.state === 'upcoming' || g.state === 'live').map(g => {
      const h = toGame(g)
      const p = g.prediction
      const open = !!p && !p.locked && typeof p.pHome === 'number'
      const league = byCode.get(g.league.code) || { code: g.league.code, name: g.league.name, logo: null, country: BB_COUNTRY[g.league.code] || 'world', rank: bbRank(g.league.code), href: leagueHref('basketball', g.league.code, g.league.name)!, fav: bbLeagueFav({ code: g.league.code, name: g.league.name, logo: null }) }
      // Spotlight: the bigger the league, then the closer the game
      const weight = open ? Math.max(0, 20 - bbRank(g.league.code)) / 4 + (1 - Math.abs(p!.pHome! - 50) / 50) : 0
      let note: SGame['note'] = null
      if (g.state === 'live' && p?.live) { const k = p.live.pHome >= p.live.pAway ? 'H' : 'A'; note = { text: `${tt("Now")}: ${k === 'H' ? h.home.short : h.away.short} ${Math.round(k === 'H' ? p.live.pHome : p.live.pAway)}%`, tone: 'live' } }
      return { ...h, state: g.state as SGame['state'], league, favWhy: favs.reasons(g).map(f => f.name), weight, chips: open ? winnerChips(p) : [], note }
    })
    return {
      loading: games === null, error, games: list, leagues,
      results: { rows: results ? results.slice(0, 40).map(toResult) : null, days: 7, link: { to: '/basketball/accuracy', label: tt("How accurate is the model? →") } },
      favTeams: favs.teams.map(f => ({ key: f.ref, name: f.name, logo: f.img || null, to: teamHref('basketball', f.ref, f.name)! })),
      favLeagues: favs.leagues.map(f => f.ref),
      hasFavorites: favs.all.length > 0
    }
  }, [games, results, error, cfg, favs.all.length])
}

export const basketballGames: GamesAdapter = {
  title: tt("Games"),
  // fix174: the chosen league's table and leaders (football's league panel)
  leaguePanel: code => createElement(BbLeaguePanel, { code }),
  countLine: (n, days) => tt("{0} games in the next {1} days", { 0: n, 1: days }),
  noLive: tt("No games in play right now."),
  defaultPinned: ['NBA', 'EL', 'ACB', 'BSL', 'EC'],
  favoritesHref: '/basketball/favorites',
  useData
}

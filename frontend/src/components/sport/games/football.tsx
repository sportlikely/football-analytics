import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL, socket } from '../../../lib/socket'
import { t as tt } from '../../../lib/i18n'
import { useAuth } from '../../../lib/auth'
import { useFavorites } from '../../../lib/favorites'
import { fame } from '../../../lib/fame'
import { footballCountry, leagueShortName } from '../../../lib/leagueCountry'
import { toGame, toResult, mainPred, type Match } from '../../SportHome/football'
import { LeaguePanel } from '../../../pages/Dashboard'
import type { GamesAdapter, GamesData, SGame, SLeague } from '../types'
import { footballTeamHref } from '../../../lib/teamLink'
import { leagueHref } from '../../../lib/links'

/** Football's adapter for the shared Matches page (fix152a): data + labels only. */

const LIVE = new Set(['IN_PLAY', 'PAUSED'])
const ENDED = new Set(['FINISHED', 'AWARDED', 'CANCELLED'])

function useData(): GamesData {
  const { full } = useAuth()
  const { list: favList, reasons } = useFavorites()
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<any[] | null>(null)
  useEffect(() => {
    let off = false
    const load = (initial: boolean) => {
      axios.get(`${API_URL}/matches/upcoming`, { params: { days: 30 } })
        .then(r => { if (!off) { setMatches(r.data.data || []); setError(null) } })
        .catch(e => { if (!off && initial) setError(e.response?.data?.message || e.message) })
        .finally(() => { if (!off) setLoading(false) })
    }
    load(true)
    axios.get(`${API_URL}/public/results`, { params: { days: 30, limit: 40 } }).then(r => !off && setResults(r.data.data?.rows || [])).catch(() => !off && setResults([]))
    // fix212: every 60 s while open, and again the moment the tab is back in front or the page comes out of the
    // back / forward cache (iPhone Safari): a game that ended while the phone was in a pocket never keeps its old row
    const timer = setInterval(() => load(false), 60 * 1000)
    const onVisible = () => { if (document.visibilityState === 'visible') load(false) }
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) load(false) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onShow)
    // live scores: keep a prediction this user already unlocked (the live feed carries the pick only)
    const onLive = (payload: { data: Match[] }) => {
      const live = new Map(payload.data.map(m => [m.id, m]))
      if (!live.size) return
      setMatches(prev => prev.map(m => { const n = live.get(m.id); if (!n) return m; return n.prediction?.locked && m.prediction && !m.prediction.locked ? { ...n, prediction: m.prediction } : n }))
    }
    socket.on('matches:live', onLive)
    return () => { off = true; clearInterval(timer); socket.off('matches:live', onLive); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('pageshow', onShow) }
  }, [])

  return useMemo(() => {
    const leagues = new Map<string, SLeague>()
    for (const m of matches) {
      const c = m.competition as Match['competition'] & { type?: string }
      if (!leagues.has(c.code)) leagues.set(c.code, {
        code: c.code, name: c.name, short: leagueShortName(c.name), logo: c.emblem || null, country: footballCountry(c as any),
        rank: c.rank ?? (c.code === 'CL' ? 1 : 0), href: leagueHref('football', c.code, c.name)!,
        fav: { kind: 'league', ref: c.code, code: c.code, name: c.name, img: c.emblem || null }
      })
    }
    const games: SGame[] = matches.filter(m => !ENDED.has(m.status)).map(m => {
      const h = toGame(m), p = mainPred(m)
      const open = !!p && !p.locked && typeof p.home === 'number'
      const live = LIVE.has(m.status)
      const chips = open && typeof p!.over25 === 'number' && typeof p!.btts === 'number' ? [
        { key: 'o25', label: p!.over25 >= 50 ? tt("Over 2.5") : tt("Under 2.5"), v: p!.over25 >= 50 ? p!.over25 : 100 - p!.over25, title: tt("Over 2.5 goals: {0}% · Under: {1}%", { 0: Math.round(p!.over25), 1: Math.round(100 - p!.over25) }) },
        { key: 'btts', label: p!.btts >= 50 ? tt("Both score") : tt("Not both"), v: p!.btts >= 50 ? p!.btts : 100 - p!.btts, title: tt("Both teams score: {0}% · Not both: {1}%", { 0: Math.round(p!.btts), 1: Math.round(100 - p!.btts) }) }
      ].map(x => ({ key: x.key, label: x.label, value: `${Math.round(x.v)}%`, strong: x.v >= 60, title: x.title })) : []
      // a small line under the teams: the upset (Pro) before the game, the live win chance during it
      let note: SGame['note'] = null
      if (open && full && !live) { const up = Math.min(p!.home, p!.away), fav = Math.max(p!.home, p!.away); if (up >= 30 && fav - up >= 10) note = { text: `${tt("Upset watch")} · ${Math.round(up)}%`, tone: 'loss' } }
      // fix182: a league game we can't predict (a play-off against a team without enough games) says so
      if (!p && (m as any).unpredicted === 'few-games') note = { text: tt("Not predicted (team without enough games)"), tone: 'muted' }
      if (live && p?.live) {
        const l = p.live, k = l.home >= l.draw && l.home >= l.away ? 'H' : l.away >= l.draw ? 'A' : 'D'
        const v = Math.min(99, Math.round(k === 'H' ? l.home : k === 'D' ? l.draw : l.away))
        note = { text: `${tt("Now")}: ${k === 'D' ? tt("Draw") : k === 'H' ? h.home.short : h.away.short} ${v}%`, tone: 'live' }
      }
      // Spotlight: the biggest club decides, the opponent adds a little; model strength only breaks ties
      const fh = fame(m.homeTeam), fa = fame(m.awayTeam)
      const att = p?.factors ? Number((p.factors as any).homeAttack) + Number((p.factors as any).awayAttack) : 0
      const weight = Math.max(fh, fa) + 0.4 * Math.min(fh, fa) + (Number.isFinite(att) ? att / 20 : 0)
      return { ...h, state: live ? 'live' : 'upcoming', league: leagues.get(m.competition.code)!, favWhy: reasons(m as any).map(f => f.name), weight, chips, note }
    })
    return {
      loading, error, games, leagues: [...leagues.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)),
      results: { rows: results ? results.map(toResult) : null, days: 30, link: { to: '/football/accuracy', label: tt("How accurate is the model? →") } },
      favTeams: favList.filter(f => f.kind === 'team').map(f => ({ key: f.ref, name: f.name, logo: f.img || null, to: f.ids?.[0] ? footballTeamHref(f.ids[0], f.name) : '/football/favorites' })),
      favLeagues: favList.filter(f => f.kind === 'league').map(f => f.code || f.ref),
      hasFavorites: favList.length > 0
    }
  }, [matches, loading, error, results, favList, reasons, full])
}

export const footballGames: GamesAdapter = {
  title: tt("Matches"),
  countLine: (n, days) => tt("{0} fixtures in the next {1} days", { 0: n, 1: days }),
  noLive: tt("No matches in play right now."),
  defaultPinned: ['PL', 'PD', 'BL1', 'SA', 'FL1', 'CL'],
  favoritesHref: '/football/favorites',
  leaguePanel: code => <LeaguePanel code={code} />,
  useData
}

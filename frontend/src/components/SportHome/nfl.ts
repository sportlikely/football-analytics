import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t as tt } from '../../lib/i18n'
import { slModel } from '../../lib/modelNames'
import { useAuth } from '../../lib/auth'
import { useNflConfig, useNflFavorites, useNflFilter, NFL_STATUS, weekLabel, nick, rowName, nflRid, nflRstatus, nflStrongAt, type NflGame, type Standings, type NflLeague } from '../../lib/nfl'
import { winnerPred, winnerRecordRows, upsetItems, winnerIntroStats, recordAside } from './winner'
import type { SportAdapter, SportHomeData, HGame, HNews, HResult } from './types'

/** American football's adapter for components/SportHome (fix141). fix185: NFL and college together (one sport), every
 *  row labelled with its league; ?league=nfl|college (the old college URLs) shows one. */

/** Primetime: Thursday / Sunday / Monday night games start 00:00–03:59 UTC (8:15 pm Eastern). */
const primetime = (g: NflGame) => new Date(g.kickoff).getUTCHours() < 4

const lgOf = (g: NflGame): NflLeague => g.league || 1
// fix185: "NFL · Week 7" / "College · Week 8"
const compOf = (g: NflGame) => `${lgOf(g) === 2 ? tt('College') : 'NFL'} · ${weekLabel(g.weekKey, lgOf(g))}`

/** fix213: "Q3 8:42" / "Half-time" / "OT 2:10" while live */
export const nflClock = (g: NflGame) => { const q = NFL_STATUS[g.status] || tt('LIVE'); return g.clock && g.status !== 'HT' ? `${q} ${g.clock.replace(/^0(\d)/, '$1')}` : q }

export function toGame(g: NflGame): HGame {
  const lg = lgOf(g)
  const team = (s: NflGame['home']) => ({ id: s.id, name: s.name, short: rowName(s.name, lg), logo: s.logo, href: `/american-football/team/${s.id}` })
  return {
    id: g.id, href: `/american-football/game/${g.id}`, reveal: { id: nflRid(g), status: nflRstatus(g) }, kickoff: g.kickoff,
    competition: { name: compOf(g), href: lg === 2 ? '/american-football/college/league' : '/american-football/league' }, home: team(g.home), away: team(g.away),
    live: g.state === 'live' ? { label: nflClock(g), score: [g.score?.home ?? 0, g.score?.away ?? 0] } : null,
    pred: winnerPred(g.prediction, rowName(g.home.name, lg), rowName(g.away.name, lg), nflStrongAt(lg))
  }
}

interface Home { season: number | null; live: NflGame[]; games: NflGame[]; upcoming: NflGame[]; results: NflGame[]; standings: Standings | null
  /** fix188: our model's rating, rank and (college) FBS / FCS of each team in the coming games */
  ratings?: Record<number, { elo: number; rank: number; level: string | null }> }

/** A finished game as "Latest results" shows it (fix152a: shared with the Games page). */
export function toResult(g: NflGame): HResult {
    const p = g.prediction
    const pick = p && !p.locked && p.pick ? p.pick : p?.pick || null
    const lg = lgOf(g)
    const won = (s: 'H' | 'A') => !!g.score && (s === 'H' ? g.score.home > g.score.away : g.score.away > g.score.home)
    return {
      id: g.id, href: `/american-football/game/${g.id}`, competition: compOf(g), date: g.kickoff,
      home: { name: g.home.name, logo: g.home.logo, score: g.score?.home ?? '', won: won('H') },
      away: { name: g.away.name, logo: g.away.logo, score: g.score?.away ?? '', won: won('A') },
      pick: pick ? { words: nick(pick === 'H' ? g.home.name : g.away.name, lg), pct: null, strong: false } : null,
      hit: p?.hit ?? null
    }
}

function useNflData(): SportHomeData {
  const { access } = useAuth()
  const { param: league } = useNflFilter()
  const full = access === 'pro' || access === 'admin'
  const [d, setD] = useState<Home | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [record, setRecord] = useState<{ bands?: { min: number; n: number; pct: number | null }[] } | null>(null)
  const [news, setNews] = useState<HNews[]>([])
  useEffect(() => {
    setD(null); setLoaded(false); setRecord(null); setNews([])
    const load = () => axios.get(`${API_URL}/nfl/home`, { params: { league } }).then(r => setD(r.data.data)).catch(() => undefined).finally(() => setLoaded(true))
    load()
    axios.get(`${API_URL}/nfl/record`, { params: { days: 30, league } }).then(r => setRecord(r.data.data)).catch(() => setRecord({}))
    axios.get(`${API_URL}/news`, { params: { sport: 'american-football', league: league === '2' ? 'NCAA' : league === '1' ? 'NFL' : undefined, limit: 10 } }).then(r => setNews(r.data.data || [])).catch(() => undefined)
    const iv = setInterval(load, 60 * 1000) // live scores
    return () => clearInterval(iv)
  }, [access, league])

  const notStarted = useMemo(() => (d?.upcoming || []).filter(g => new Date(g.kickoff).getTime() > Date.now()), [d])
  const week = useMemo(() => (d?.games || []).filter(g => g.state === 'upcoming' && new Date(g.kickoff).getTime() > Date.now()), [d])
  // fix188: featured = the biggest coming games by our model's ratings (both teams' strength added up): NFL games of the
  // next 4 days first, then the top college games (both teams FBS and in our top 60), then later NFL games; never an
  // FCS game. Up to 4, in kick-off order.
  const featured = useMemo(() => {
    const rt = d?.ratings || {}
    const now = Date.now(), within = (g: NflGame, days: number) => new Date(g.kickoff).getTime() - now < days * 86400000
    const strength = (g: NflGame) => (rt[g.home.id]?.elo ?? 1500) + (rt[g.away.id]?.elo ?? 1500) + (primetime(g) ? 25 : 0)
    const big = (s: NflGame['home']) => rt[s.id]?.level === 'FBS' && rt[s.id].rank <= 60
    const byStrength = (list: NflGame[]) => [...list].sort((a, b) => strength(b) - strength(a) || a.kickoff.localeCompare(b.kickoff))
    const nfl = notStarted.filter(g => lgOf(g) === 1 && within(g, 7))
    const picked = [
      ...byStrength(nfl.filter(g => within(g, 4))),
      ...byStrength(notStarted.filter(g => lgOf(g) === 2 && within(g, 7) && big(g.home) && big(g.away))),
      ...byStrength(nfl.filter(g => !within(g, 4)))
    ]
    return picked.slice(0, 4).sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  }, [notStarted, d?.ratings])
  const featuredIds = useMemo(() => new Set(featured.map(g => g.id)), [featured])
  const favs = useNflFavorites()
  const favNext = useMemo(() => notStarted.filter(g => favs.reasons(g).length > 0).slice(0, 10), [notStarted, favs.all.length])
  const soonest = useMemo(() => notStarted.filter(g => !featuredIds.has(g.id)).slice(0, 5), [notStarted, featuredIds])
  const next = useMemo(() => week.filter(g => !featuredIds.has(g.id) && !favNext.includes(g)), [week, featuredIds, favNext])

  const resultRows: HResult[] | null = d ? d.results.map(toResult) : null

  return {
    loaded, full, news,
    featured: featured.map(toGame), live: (d?.live || []).map(toGame), soonest: soonest.map(toGame), favorites: favNext.map(toGame), next: next.map(toGame),
    record: {
      rows: record ? winnerRecordRows(record.bands) : null, aside: recordAside(record?.bands),
      note: tt("Picks right, every game counted. Each prediction is saved before kick-off and never edited."),
      link: { to: '/american-football/accuracy', label: tt("See the full record →") },
      empty: { title: tt("Predictions start soon"), text: league === '2' ? tt("Once our college football model is live, every prediction is saved before kick-off and checked after the game, here and in public.") : tt("Once our NFL model is live, every prediction is saved before kick-off and checked after the game, here and in public.") }
    },
    special: {
      title: tt("Upset watch"), tone: 'loss', open: full,
      items: upsetItems(notStarted, g => g.prediction ? { id: g.id, href: `/american-football/game/${g.id}`, league: compOf(g), date: g.kickoff, home: nick(g.home.name, lgOf(g)), away: nick(g.away.name, lgOf(g)), pHome: g.prediction.pHome, pAway: g.prediction.pAway, locked: g.prediction.locked } : null),
      empty: tt("No upsets on the radar this week."),
      locked: { title: tt("Upset watch"), text: tt("The 2 games where our model gives the underdog the best chance. Part of Pro.") },
      link: full ? { to: '/american-football/games', label: tt("All games →") } : { to: '/premium', label: tt("Unlock upset watch →") }
    },
    results: { rows: resultRows, days: 30, link: { to: '/american-football/accuracy', label: tt("How accurate is the model? →") } },
    // fix174: first-visit tiles like football
    // fix185: one record for both leagues (strong line 70%); teams covered = NFL + college
    introStats: winnerIntroStats(record?.bands, league === '2' ? nflStrongAt(2) : nflStrongAt(1), d?.standings ? { value: d.standings.rows.length, label: league === '2' ? tt('college teams covered') : league === '1' ? tt('NFL teams covered') : tt('teams covered') } : null)
  }
}

/** NFL's adapter; the admin preview line comes from the config (not public yet). */
export function useNflAdapter(): SportAdapter {
  const cfg = useNflConfig()
  return {
    field: 'gridiron',
    banner: cfg && !cfg.public ? tt('Admin preview · not public yet') : null,
    // fix185: no NFL | College switch: one sport, both leagues together
    switcher: null,
    labels: {
      featured: tt("Featured game"), modelPrediction: tt("{0} prediction", { 0: slModel('american-football') }), nextList: tt("Next kick-offs"), nextSection: tt("Next games"),
      all: { to: '/american-football/games', label: tt("All games →") }, today: { to: '/american-football/today', label: tt("Today's predictions →") },
      favorites: '/american-football/favorites', liveDetail: tt("Live score and box score →"),
      emptyHero: [tt("American football,"), tt("tested in public."), tt("The next games appear here as soon as they are scheduled.")],
      newsLoading: tt("Loading the latest news…"),
      premiumText: tt("Win chances, point spread, total points and the predicted score for every game, team analysis and the complete track record.")
    },
    intro: {
      title: tt("American football predictions"),
      text: tt("Who wins every NFL and college football game, with the chance of each side, the expected score and the reasons behind each pick. Every prediction is saved before kick-off and checked in public."),
      bullets: [
        [tt("Every game"), tt("Win chances, point spread and total points, with the reasons behind each pick.")],
        [tt("Checked in public"), tt("Every prediction is saved before kick-off and scored after the game.")],
        [tt("Free to start"), tt("2 full picks every week. No card needed.")]
      ],
      cta: { to: '/signup', label: tt("Get 2 free picks a week") },
      second: { to: '/american-football/games', label: tt("See the games") }
    },
    useData: useNflData
  }
}

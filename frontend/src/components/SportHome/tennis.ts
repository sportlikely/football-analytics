import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t as tt } from '../../lib/i18n'
import { slModel } from '../../lib/modelNames'
import { useAuth } from '../../lib/auth'
import { useTennisConfig, useTennisFavorites, useTennisTour, tennisRid, tennisRstatus, tennisHref, surname, flagOf, TENNIS_STRONG, type TMatch } from '../../lib/tennis'
import { winnerPred, winnerRecordRows, upsetItems, winnerIntroStats } from './winner'
import type { SportAdapter, SportHomeData, HGame, HNews, HResult, HTeam } from './types'

/** Tennis's adapter for components/SportHome (fix193): data + labels only — the layout is football's. */

/** "Vienna · R16" / "Australian Open · Final" */
export const compOf = (m: TMatch) => [m.tournament.name, m.round].filter(Boolean).join(' · ')
const side = (s: TMatch['home']): HTeam => ({ id: s.id ?? s.name, name: s.name, short: surname(s.name), logo: null, flag: flagOf(s.country) || null, rank: s.rank, href: tennisHref.player(s.id) || '/tennis' })
/** "Set 2" while a set is on, the sets won as the score */
const liveLabel = (m: TMatch) => (m.score ? tt('Set {0}', { 0: Math.min(m.bestOf, m.score.won[0] + m.score.won[1] + 1) }) : tt('LIVE'))

export function toGame(m: TMatch): HGame {
  return {
    id: m.id, href: tennisHref.match(m.id), reveal: { id: tennisRid(m), status: tennisRstatus(m) }, kickoff: m.start,
    competition: { name: compOf(m) }, home: side(m.home), away: side(m.away),
    live: m.state === 'live' ? { label: liveLabel(m), score: m.score ? m.score.won : [0, 0] } : null,
    pred: winnerPred(m.prediction, surname(m.home.name), surname(m.away.name), m.prediction?.strongAt ?? TENNIS_STRONG)
  }
}

/** A finished match as "Latest results" shows it (sets won, our pick, ✓ / ✗). */
export function toResult(m: TMatch): HResult {
  const p = m.prediction
  const pick = p && p.pick ? p.pick : null
  return {
    id: m.id, href: tennisHref.match(m.id), competition: compOf(m), date: m.start,
    home: { name: m.home.name, logo: null, score: m.score ? m.score.won[0] : '', won: m.winner === 1 },
    away: { name: m.away.name, logo: null, score: m.score ? m.score.won[1] : '', won: m.winner === 2 },
    pick: pick ? { words: surname(pick === 'H' ? m.home.name : m.away.name), pct: null, strong: false } : null,
    hit: p?.hit ?? null
  }
}

interface Home { live: TMatch[]; upcoming: TMatch[]; results: TMatch[]; ratings: Record<number, { elo: number; rank: number }>; levels: Record<number, number> }

function useTennisData(): SportHomeData {
  const { access } = useAuth()
  const { tour } = useTennisTour()
  const full = access === 'pro' || access === 'admin'
  const [d, setD] = useState<Home | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [record, setRecord] = useState<{ bands?: { min: number; n: number; pct: number | null }[] } | null>(null)
  const [news, setNews] = useState<HNews[]>([])
  useEffect(() => {
    setD(null); setLoaded(false); setRecord(null); setNews([])
    const load = () => axios.get(`${API_URL}/tennis/home`, { params: { tour } }).then(r => setD(r.data.data)).catch(() => undefined).finally(() => setLoaded(true))
    load()
    axios.get(`${API_URL}/tennis/record`, { params: { days: 30, tour } }).then(r => setRecord(r.data.data)).catch(() => setRecord({}))
    axios.get(`${API_URL}/news`, { params: { sport: 'tennis', limit: 10 } }).then(r => setNews(r.data.data || [])).catch(() => undefined)
    const iv = setInterval(load, 60 * 1000) // live scores
    return () => clearInterval(iv)
  }, [access, tour])

  const notStarted = useMemo(() => (d?.upcoming || []).filter(m => new Date(m.start).getTime() > Date.now()), [d])
  // featured: the biggest coming matches — Grand Slam / 1000 / 500 first, then by the two players' ratings — in the
  // next 48 hours; up to 4, in start order
  const featured = useMemo(() => {
    const lv = d?.levels || {}, rt = d?.ratings || {}
    const now = Date.now()
    const strength = (m: TMatch) => (m.home.id ? rt[m.home.id]?.elo ?? 1400 : 1400) + (m.away.id ? rt[m.away.id]?.elo ?? 1400 : 1400)
    return notStarted.filter(m => new Date(m.start).getTime() - now < 48 * 3600e3 && !m.qualifying)
      .sort((a, b) => (lv[a.id] ?? 9) - (lv[b.id] ?? 9) || strength(b) - strength(a))
      .slice(0, 4).sort((a, b) => a.start.localeCompare(b.start))
  }, [notStarted, d?.levels, d?.ratings])
  const featuredIds = useMemo(() => new Set(featured.map(m => m.id)), [featured])
  const favs = useTennisFavorites()
  const favNext = useMemo(() => notStarted.filter(m => favs.reasons(m).length > 0).slice(0, 10), [notStarted, favs.all.length])
  const soonest = useMemo(() => notStarted.filter(m => !featuredIds.has(m.id)).slice(0, 5), [notStarted, featuredIds])
  // next matches: the next day, biggest events first (the full list is on Matches)
  const next = useMemo(() => {
    const lv = d?.levels || {}
    return notStarted.filter(m => !featuredIds.has(m.id) && !favNext.includes(m) && new Date(m.start).getTime() - Date.now() < 24 * 3600e3)
      .sort((a, b) => (lv[a.id] ?? 9) - (lv[b.id] ?? 9) || a.start.localeCompare(b.start)).slice(0, 12)
  }, [notStarted, featuredIds, favNext, d?.levels])
  const players = useMemo(() => new Set(notStarted.flatMap(m => [m.home.id, m.away.id]).filter(Boolean)).size, [notStarted])

  return {
    loaded, full, news,
    featured: featured.map(toGame), live: (d?.live || []).map(toGame), soonest: soonest.map(toGame), favorites: favNext.map(toGame), next: next.map(toGame),
    record: {
      rows: record ? winnerRecordRows(record.bands) : null, aside: tt("last {0} days", { 0: 30 }),
      note: tt("Picks right, every match counted. Each prediction is saved before the first serve and never edited."),
      link: { to: '/tennis/accuracy', label: tt("See the full record →") },
      empty: { title: tt("Predictions start soon"), text: tt("Every tennis prediction is saved before the first serve and checked after the match, here and in public.") }
    },
    special: {
      title: tt("Upset watch"), tone: 'loss', open: full,
      items: upsetItems(notStarted, m => m.prediction ? { id: m.id, href: tennisHref.match(m.id), league: compOf(m), date: m.start, home: surname(m.home.name), away: surname(m.away.name), pHome: m.prediction.pHome, pAway: m.prediction.pAway, locked: m.prediction.locked } : null),
      empty: tt("No upsets on the radar this week."),
      locked: { title: tt("Upset watch"), text: tt("The 2 matches where our model gives the underdog the best chance. Part of Pro.") },
      link: full ? { to: '/tennis/upset-watch', label: tt("All upsets →") } : { to: '/premium', label: tt("Unlock upset watch →") }
    },
    results: { rows: d ? d.results.map(toResult) : null, days: 30, link: { to: '/tennis/accuracy', label: tt("How accurate is the model? →") } },
    introStats: winnerIntroStats(record?.bands, TENNIS_STRONG, { value: players, label: tt('players this week') })
  }
}

/** Tennis's adapter; the admin preview line comes from the config (not public yet). */
export function useTennisAdapter(): SportAdapter {
  const cfg = useTennisConfig()
  return {
    field: 'tennis',
    banner: cfg && !cfg.public ? tt('Admin preview · not public yet') : null,
    switcher: null,
    labels: {
      featured: tt("Featured match"), modelPrediction: tt("{0} prediction", { 0: slModel('tennis') }), nextList: tt("Next matches"), nextSection: tt("Next matches"),
      all: { to: '/tennis/matches', label: tt("All matches →") }, today: { to: '/tennis/today', label: tt("Today's predictions →") },
      favorites: '/tennis/favorites', liveDetail: tt("Live score and stats →"),
      emptyHero: [tt("Tennis predictions,"), tt("tested in public."), tt("The next matches appear here as soon as they are scheduled.")],
      newsLoading: tt("Loading the latest news…"),
      premiumText: tt("Win chances, the likely set score, total games and the first-set winner for every match, player analysis and the complete track record.")
    },
    intro: {
      title: tt("Tennis predictions"),
      text: tt("Who wins every ATP, WTA and Challenger match, with the chance of each player, the likely set score and the reasons behind each pick. Every prediction is saved before the first serve and checked in public."),
      bullets: [
        [tt("Every match"), tt("Win chances, set scores and total games, with the reasons behind each pick.")],
        [tt("Checked in public"), tt("Every prediction is saved before the first serve and scored after the match.")],
        [tt("Free to start"), tt("2 full picks every week. No card needed.")]
      ],
      cta: { to: '/signup', label: tt("Get 2 free picks a week") },
      second: { to: '/tennis/matches', label: tt("See the matches") }
    },
    useData: useTennisData
  }
}


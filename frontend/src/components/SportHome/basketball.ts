import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t as tt } from '../../lib/i18n'
import { slModel } from '../../lib/modelNames'
import { useAuth } from '../../lib/auth'
import { useBbConfig, useBbFavorites, liveLabel, bbRank, type BbGame } from '../../lib/bb'
import { rid, rstatus, bbShort } from '../../pages/bb/parts'
import { winnerPred, winnerRecordRows, upsetItems, winnerIntroStats } from './winner'
import type { SportAdapter, SportHomeData, HGame, HNews, HResult } from './types'

/** Basketball's adapter for components/SportHome (fix141): the data and labels of the basketball home. */

// EuroLeague clubs that make a game "big" (both sides needed), and NBA teams that make a game more featured
const EL_BIG = [/real madrid/i, /barcelona/i, /olympiacos|olympiakos/i, /panathinaikos/i, /fenerbah/i, /efes/i, /zalgiris/i, /monaco/i, /partizan/i, /zvezda|red star/i, /olimpia milano|^milano|ea7/i, /virtus|bologna/i, /bayern/i, /baskonia/i]
const NBA_FAME = [/lakers/i, /warriors/i, /celtics/i, /knicks/i, /bucks/i, /nuggets/i, /thunder/i, /76ers|sixers/i, /mavericks/i, /suns/i, /heat/i, /cavaliers/i, /spurs/i, /timberwolves/i, /bulls/i]
const STRONG = 70
const hasPct = (g: BbGame) => !!g.prediction && !g.prediction.locked && typeof g.prediction.pHome === 'number'
const top = (g: BbGame) => Math.max(g.prediction!.pHome!, g.prediction!.pAway!)

export function toGame(g: BbGame): HGame {
  const team = (s: BbGame['home']) => ({ id: s.id, name: s.name, short: bbShort(s.name, g.league.code), logo: s.logo, href: `/basketball/team/${s.id}` })
  return {
    id: g.id, href: `/basketball/game/${g.id}`, reveal: { id: rid(g), status: rstatus(g) }, kickoff: g.kickoff,
    competition: { name: g.league.name, href: `/basketball/league/${g.league.code}` }, home: team(g.home), away: team(g.away),
    live: g.state === 'live' ? { label: liveLabel(g, true), score: [g.score?.home ?? 0, g.score?.away ?? 0] } : null,
    pred: winnerPred(g.prediction, bbShort(g.home.name, g.league.code), bbShort(g.away.name, g.league.code), STRONG)
  }
}

/** A finished game as "Latest results" shows it (fix152a: shared with the Games page). */
export function toResult(g: BbGame): HResult {
  const pick = g.prediction?.pick || null
  const won = (s: 'H' | 'A') => !!g.score && (s === 'H' ? g.score.home > g.score.away : g.score.away > g.score.home)
  return {
    id: g.id, href: `/basketball/game/${g.id}`, competition: g.league.name, date: g.kickoff,
    home: { name: g.home.name, logo: g.home.logo, score: g.score?.home ?? '', won: won('H') },
    away: { name: g.away.name, logo: g.away.logo, score: g.score?.away ?? '', won: won('A') },
    pick: pick ? { words: pick === 'H' ? g.home.name : g.away.name, pct: null, strong: false } : null,
    hit: g.prediction?.hit ?? null
  }
}

function useBasketballData(): SportHomeData {
  const { access } = useAuth()
  const full = access === 'pro' || access === 'admin'
  const [games, setGames] = useState<BbGame[]>([])
  const [loaded, setLoaded] = useState(false)
  const [results, setResults] = useState<BbGame[] | null>(null)
  const [record, setRecord] = useState<{ bands?: { min: number; n: number; pct: number | null }[] } | null>(null)
  const [news, setNews] = useState<HNews[]>([])

  useEffect(() => {
    const load = () => {
      axios.get(`${API_URL}/basketball/games`, { params: { days: 7 } }).then(r => setGames(r.data.data || [])).catch(() => undefined).finally(() => setLoaded(true))
      axios.get(`${API_URL}/basketball/games`, { params: { days: 30, results: 1 } }).then(r => setResults((r.data.data || []).filter((g: BbGame) => g.state === 'done').reverse())).catch(() => setResults([]))
    }
    load()
    axios.get(`${API_URL}/basketball/record`, { params: { days: 30 } }).then(r => setRecord(r.data.data)).catch(() => setRecord({}))
    axios.get(`${API_URL}/news`, { params: { sport: 'basketball', limit: 10 } }).then(r => setNews(r.data.data || [])).catch(() => undefined)
    const iv = setInterval(load, 60000)
    return () => clearInterval(iv)
  }, [access])

  const live = games.filter(g => g.state === 'live')
  const notStarted = useMemo(() => games.filter(g => g.state === 'upcoming' && new Date(g.kickoff).getTime() > Date.now()), [games])
  // featured (Yarin, 11 Oct): ONLY the NBA, or a really big EuroLeague game; famous teams first, then the closest game;
  // the carousel shows up to 6 of that group in tip-off order
  const featured = useMemo(() => {
    const withP = notStarted.filter(g => g.prediction)
    const fameOf = (g: BbGame) => (g.league.code === 'NBA' ? NBA_FAME : EL_BIG).filter(re => re.test(g.home.name) || re.test(g.away.name)).length
    const bigEl = (g: BbGame) => g.league.code === 'EL' && ((EL_BIG.some(re => re.test(g.home.name)) && EL_BIG.some(re => re.test(g.away.name))) || /play|final/i.test(g.round || ''))
    const groups = [withP.filter(g => g.league.code === 'NBA' && !g.preseason), withP.filter(bigEl), withP.filter(g => g.league.code === 'NBA' && g.preseason)]
    const list = groups.find(x => x.length) || []
    return [...list].sort((a, b) => fameOf(b) - fameOf(a) || (hasPct(a) && hasPct(b) ? top(a) - top(b) : 0) || a.kickoff.localeCompare(b.kickoff))
      .slice(0, 6).sort((a, b) => a.kickoff.localeCompare(b.kickoff))
  }, [notStarted])
  const featuredIds = useMemo(() => new Set(featured.map(g => g.id)), [featured])
  const favs = useBbFavorites()
  const favNext = useMemo(() => notStarted.filter(g => favs.reasons(g).length > 0).slice(0, 10), [notStarted, favs.all.length])
  const soonest = useMemo(() => notStarted.filter(g => !featuredIds.has(g.id)).slice(0, 5), [notStarted, featuredIds])
  const next = useMemo(() => notStarted.filter(g => !featuredIds.has(g.id) && !favNext.includes(g))
    .sort((a, b) => bbRank(a.league.code) - bbRank(b.league.code) || a.kickoff.localeCompare(b.kickoff)).slice(0, 12)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff)), [notStarted, featuredIds, favNext])

  const resultRows: HResult[] | null = results ? results.slice(0, 40).map(toResult) : null

  return {
    loaded, full, news,
    featured: featured.map(toGame), live: live.map(toGame), soonest: soonest.map(toGame), favorites: favNext.map(toGame), next: next.map(toGame),
    record: {
      rows: record ? winnerRecordRows(record.bands) : null, aside: tt("last {0} days", { 0: 30 }),
      note: tt("Picks right, every game counted. Each prediction is saved before tip-off and never edited."),
      link: { to: '/basketball/accuracy', label: tt("See the full record →") },
      empty: { title: tt("Predictions start soon"), text: tt("The record starts with the first games after launch. Check back after the next game day.") }
    },
    special: {
      title: tt("Upset watch"), tone: 'loss', open: full,
      items: upsetItems(notStarted, g => g.prediction ? { id: g.id, href: `/basketball/game/${g.id}`, league: g.league.name, date: g.kickoff, home: g.home.name, away: g.away.name, pHome: g.prediction.pHome, pAway: g.prediction.pAway, locked: g.prediction.locked } : null),
      empty: tt("No upsets on the radar this week."),
      locked: { title: tt("Upset watch"), text: tt("The 2 games where our model gives the underdog the best chance. Part of Pro.") },
      link: full ? { to: '/basketball/games', label: tt("All games →") } : { to: '/premium', label: tt("Unlock upset watch →") }
    },
    results: { rows: resultRows, days: 30, link: { to: '/basketball/accuracy', label: tt("How accurate is the model? →") } },
    // fix174: first-visit tiles like football; Latest results over 30 days like football
    introStats: winnerIntroStats(record?.bands, STRONG, { value: new Set([...games, ...(results || [])].map(g => g.league.code)).size, label: tt('leagues covered') })
  }
}

/** Basketball's adapter; the admin preview line comes from the config (not public yet). */
export function useBasketballAdapter(): SportAdapter {
  const cfg = useBbConfig()
  return {
    field: 'court',
    banner: cfg && !cfg.public ? tt('Admin preview · not public yet') : null,
    labels: {
      featured: tt("Featured game"), modelPrediction: tt("{0} prediction", { 0: slModel('basketball') }), nextList: tt("Next tip-offs"), nextSection: tt("Next games"),
      all: { to: '/basketball/games', label: tt("All games →") }, today: { to: '/basketball/predictions/today', label: tt("Today's predictions →") },
      favorites: '/basketball/favorites', liveDetail: tt("Live score and box score →"),
      emptyHero: [tt("Basketball predictions,"), tt("tested in public."), tt("The next games appear here as soon as they are scheduled.")],
      newsLoading: tt("Loading the latest news…"),
      premiumText: tt("Win chances, point spread, total points and the predicted score for every game, team analysis and the complete track record.")
    },
    intro: {
      title: tt("Basketball predictions"),
      text: tt('Who wins, the point spread, total points and the predicted score for every game of the NBA, the EuroLeague and {0} more leagues in Europe, Asia and the Americas. Every prediction is saved before tip-off and checked in public.', { 0: Math.max(0, (cfg?.leagues.length || 18) - 2) }),
      bullets: [
        [tt("Every game"), tt("Win chances, point spread and total points, with the reasons behind each pick.")],
        [tt("Checked in public"), tt("Every prediction is saved before tip-off and scored after the game.")],
        [tt("Free to start"), tt("2 full picks every week. No card needed.")]
      ],
      cta: { to: '/signup', label: tt("Get 2 free picks a week") },
      second: { to: '/basketball/accuracy', label: tt("See our record"), record: true }
    },
    useData: useBasketballData
  }
}

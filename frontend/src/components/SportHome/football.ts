import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { API_URL, socket } from '../../lib/socket'
import { type Prediction, doubleChance, dcLabel, shortTeam } from '../../lib/predict'
import { useAuth } from '../../lib/auth'
import { matchFame } from '../../lib/fame'
import { useFavorites } from '../../lib/favorites'
import { t as tt, LOCALE } from '../../lib/i18n'
import { slModel } from '../../lib/modelNames'
import type { SportAdapter, SportHomeData, HGame, HNews, HRecordRow, HResult, HSpecialItem } from './types'
import { footballTeamHref } from '../../lib/teamLink'
import { leagueHref, matchHref } from '../../lib/links'

/** Football's adapter for components/SportHome (fix141): the data and labels of the football home. */

interface Team { id: number; name: string; shortName?: string; tla?: string; crest?: string }
export interface Match {
  id: number; utcDate: string; status: string; minute?: number | string | null
  competition: { code: string; name: string; emblem?: string; rank?: number }
  homeTeam: Team; awayTeam: Team
  score?: { fullTime?: { home: number | null; away: number | null } }
  prediction?: Prediction | null; predictions?: Prediction[]
}
interface Summary {
  days: number
  doubleChance?: { n: number; v3: number | null; bands?: { id: string; min: number; n: number; hits: number; pct: number | null }[] } | null
  highlights?: Record<string, { n: number; hits: number; pct: number | null }> | null
  drawAlerts: { picks: number } | null
}
interface Alert { matchId: number; league: string; date: string; home: string; away: string; ourDraw: number; dc?: { k: '1X' | 'X2' | '12'; p: number } | null }

const LIVE = new Set(['IN_PLAY', 'PAUSED', 'LIVE'])
const MAIN = ['v3-mix', 'grid-v3', 'elo-intl', 'elo-euro']
const tn = (t: Team) => t.shortName || t.name
export function mainPred(m: Match): Prediction | null { return m.predictions?.find(p => MAIN.includes(p.model)) || m.prediction || null }
const hasPct = (p: Prediction | null): p is Prediction => !!p && !p.locked && typeof p.home === 'number'
const topPct = (p: Prediction) => Math.max(p.home, p.draw, p.away)
const MAJOR = /champions league|world cup|euro(pean championship)?\b|nations league|copa am[eé]rica|europa league|conference league/i
/** Lower = bigger stage: Champions League, the top leagues, major national-team / European competitions, then the rest. */
function priority(m: Match) {
  if (m.competition.code === 'CL') return 0
  if ((m.competition.rank ?? 9) <= 1) return 1
  if (MAJOR.test(m.competition.name) && !/qualif/i.test(m.competition.name)) return 2
  if (MAJOR.test(m.competition.name)) return 3
  return 5
}

/** "Our record" rows: double chance first in the list of candidates (the card keeps 30+ games, high → low, at most 6). */
const RECORD_ROWS: { key: string; label: string }[] = [
  { key: 'dc90', label: 'Double chance · 90%+ sure' }, { key: 'dc85', label: 'Double chance · 85%+ sure' },
  { key: 'res80', label: 'Result · 80%+ sure' }, { key: 'dcAll', label: 'Double chance · all picks' },
  { key: 'btts70', label: 'Both teams score · 70%+ sure' }, { key: 'res60', label: 'Strong picks (60%+)' },
  { key: 'ou70', label: 'Over/Under 2.5 · 70%+ sure' }, { key: 'resAll', label: 'All our picks (result)' }
]
/** The surest double-chance band with enough games (30+): 90%+, else 80%+, else none (first-visit tiles). */
function dcSure(dc: Summary['doubleChance']): { min: number; pct: number; n: number } | null {
  const bands = dc?.bands || []
  for (const min of [90, 80]) {
    const sel = bands.filter(b => b.min >= min)
    const n = sel.reduce((s, b) => s + b.n, 0), hits = sel.reduce((s, b) => s + b.hits, 0)
    if (n >= 30) return { min, n, pct: Math.round((1000 * hits) / n) / 10 }
  }
  return null
}

export function toGame(m: Match): HGame {
  const p = mainPred(m)
  const live = LIVE.has(m.status)
  // football shows the short club name everywhere ("Inter", not "FC Internazionale Milano")
  const team = (t: Team) => ({ id: t.id, name: tn(t), short: tn(t), logo: t.crest || null, tla: t.tla || null, href: footballTeamHref(t.id, t.name, m.competition.code) })
  let pred: HGame['pred'] = { kind: 'none' }
  if (hasPct(p)) {
    // fix120: our pick is the double chance — both of its results are highlighted
    const dc = doubleChance(p)
    const on = (o: 'H' | 'D' | 'A') => (dc ? dc.sides.includes(o) : false)
    pred = {
      kind: 'full',
      cells: [
        { key: 'H', head: '1', label: tn(m.homeTeam), pct: p.home, on: on('H') },
        { key: 'D', head: 'X', label: tt('Draw'), pct: p.draw, on: on('D') },
        { key: 'A', head: '2', label: tn(m.awayTeam), pct: p.away, on: on('A') }
      ],
      pick: dc ? { words: dcLabel(dc.code, shortTeam(m.homeTeam), shortTeam(m.awayTeam)), pct: dc.pct, strong: dc.strong, help: true } : null
    }
  } else if (p) pred = { kind: 'locked', heads: ['1', 'X', '2'] } // fix160: drawn blurred, like the open block
  return {
    id: m.id, href: matchHref('football', m.id, { home: m.homeTeam.name || m.homeTeam.shortName, away: m.awayTeam.name || m.awayTeam.shortName, homeId: m.homeTeam.id, awayId: m.awayTeam.id, date: m.utcDate })!, linkState: { match: m }, reveal: { id: m.id, status: m.status }, kickoff: m.utcDate,
    competition: { name: m.competition.name, emblem: m.competition.emblem || null, href: leagueHref('football', m.competition.code, m.competition.name) },
    home: team(m.homeTeam), away: team(m.awayTeam),
    live: live ? { label: m.minute ? `${m.minute}'` : tt('Live'), score: [m.score?.fullTime?.home ?? 0, m.score?.fullTime?.away ?? 0] } : null,
    pred
  }
}

/** A row of /public/results as "Latest results" shows it (fix152a: shared with the Matches page). */
export function toResult(r: any): HResult {
  const [hg, ag] = String(r.score || '').split(/[–-]/).map((x: string) => x.trim())
  return {
    id: r.matchId, href: matchHref('football', r.matchId, { home: r.home, away: r.away, date: r.date })!, competition: r.competition || '', date: r.date,
    home: { name: r.home, logo: r.homeCrest || null, score: hg, won: r.outcome === 'H' },
    away: { name: r.away, logo: r.awayCrest || null, score: ag, won: r.outcome === 'A' },
    pick: r.dc ? { words: dcLabel(r.dc.pick, r.home, r.away), tag: r.dc.pick, pct: r.dc.p ?? null, strong: false } : null,
    hit: r.dc ? r.dc.hit : (r.hit ?? null)
  }
}

function useFootballData(): SportHomeData {
  const { access, loading: authLoading } = useAuth()
  const full = access === 'pro' || access === 'admin'
  const [upcoming, setUpcoming] = useState<Match[]>([])
  const [live, setLive] = useState<Match[]>([])
  const [loaded, setLoaded] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [news, setNews] = useState<HNews[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [results, setResults] = useState<any[] | null>(null)

  // the lists load at once, together with the sign-in check (the login cookie goes with every request); again only
  // when the user signs in or out on this page
  const loadMatches = useCallback(() => {
    axios.get(`${API_URL}/matches/upcoming`, { params: { days: 14 } }).then(r => setUpcoming(r.data.data || [])).catch(() => undefined).finally(() => setLoaded(true))
    axios.get(`${API_URL}/matches/live`).then(r => setLive(r.data.data || [])).catch(() => undefined)
  }, [])
  useEffect(() => {
    loadMatches()
    // the live box must match the Matches page even if the live socket drops: re-check every minute
    const timer = setInterval(loadMatches, 60 * 1000)
    axios.get(`${API_URL}/public/summary`).then(r => setSummary(r.data.data)).catch(() => undefined)
    axios.get(`${API_URL}/news`, { params: { limit: 10 } }).then(r => setNews(r.data.data || [])).catch(() => undefined)
    const loadResults = () => axios.get(`${API_URL}/public/results`, { params: { days: 30, limit: 50 } }).then(r => setResults(r.data.data?.rows || [])).catch(() => setResults([]))
    loadResults()
    const rt = setInterval(loadResults, 5 * 60 * 1000)
    const onLive = (msg: { data: Match[] }) => setLive(msg.data || [])
    socket.on('matches:live', onLive)
    return () => { socket.off('matches:live', onLive); clearInterval(timer); clearInterval(rt) }
  }, [loadMatches])
  const firstAccess = useRef<string | null>(null)
  useEffect(() => {
    if (authLoading) return
    if (firstAccess.current === null) { firstAccess.current = access; return }
    if (firstAccess.current !== access) { firstAccess.current = access; loadMatches() }
  }, [access, authLoading, loadMatches])
  useEffect(() => {
    if (!full) { setAlerts([]); return }
    axios.get(`${API_URL}/draw-alerts`).then(r => setAlerts(r.data.data.picks || [])).catch(() => undefined)
  }, [full])

  const notStarted = useMemo(() => upcoming.filter(m => !LIVE.has(m.status) && new Date(m.utcDate).getTime() > Date.now()), [upcoming])
  // featured: the biggest competition playing in the next week; within it the biggest teams (lib/fame), not one-sided
  const featured = useMemo(() => {
    const week = notStarted.filter(m => new Date(m.utcDate).getTime() < Date.now() + 7 * 86400000 && mainPred(m))
    if (!week.length) return null
    const best = Math.min(...week.map(priority))
    const pool = week.filter(m => priority(m) === best)
    const lopsided = (m: Match) => { const p = mainPred(m); return hasPct(p) && topPct(p) >= 85 ? 1 : 0 }
    return [...pool].sort((a, b) =>
      lopsided(a) - lopsided(b) || matchFame(b.homeTeam, b.awayTeam) - matchFame(a.homeTeam, a.awayTeam) ||
      (hasPct(mainPred(a)) && hasPct(mainPred(b)) ? topPct(mainPred(a)!) - topPct(mainPred(b)!) : 0) || a.utcDate.localeCompare(b.utcDate)
    )[0]
  }, [notStarted, full])
  // the featured one plus up to 5 other big games of the next 7 days, in kick-off order
  const featuredList = useMemo(() => {
    if (!featured) return []
    const lopsided = (m: Match) => { const p = mainPred(m); return hasPct(p) && topPct(p) >= 85 }
    const others = notStarted
      .filter(m => m.id !== featured.id && new Date(m.utcDate).getTime() < Date.now() + 7 * 86400000 && mainPred(m))
      .filter(m => matchFame(m.homeTeam, m.awayTeam) >= 8.5 && !lopsided(m))
      .sort((a, b) => matchFame(b.homeTeam, b.awayTeam) - matchFame(a.homeTeam, a.awayTeam) || priority(a) - priority(b) || a.utcDate.localeCompare(b.utcDate))
      .slice(0, 5)
    return [featured, ...others].sort((a, b) => a.utcDate.localeCompare(b.utcDate))
  }, [notStarted, featured])
  const featuredIds = useMemo(() => new Set(featuredList.map(m => m.id)), [featuredList])
  // next kick-offs: the biggest games of the next 48 hours (then the next ones by time), in kick-off order
  const soonest = useMemo(() => {
    const rest = notStarted.filter(m => !featuredIds.has(m.id))
    const near = rest.filter(m => new Date(m.utcDate).getTime() < Date.now() + 48 * 3600 * 1000)
      .sort((a, b) => priority(a) - priority(b) || a.utcDate.localeCompare(b.utcDate)).slice(0, 5)
    const fill = rest.filter(m => !near.includes(m)).sort((a, b) => a.utcDate.localeCompare(b.utcDate)).slice(0, 5 - near.length)
    return [...near, ...fill].sort((a, b) => a.utcDate.localeCompare(b.utcDate))
  }, [notStarted, featuredIds])
  const { reasons: favReasons } = useFavorites()
  const favNext = useMemo(() => notStarted.filter(m => favReasons(m).length > 0).sort((a, b) => a.utcDate.localeCompare(b.utcDate)).slice(0, 10), [notStarted, favReasons])
  const next = useMemo(() => {
    const ranked = [...notStarted].filter(m => !favNext.includes(m)).sort((a, b) => ((a.competition.rank ?? 9) <= 1 ? 0 : 1) - ((b.competition.rank ?? 9) <= 1 ? 0 : 1) || a.utcDate.localeCompare(b.utcDate))
    return ranked.filter(m => !featuredIds.has(m.id)).slice(0, 10).sort((a, b) => a.utcDate.localeCompare(b.utcDate))
  }, [notStarted, featuredIds, favNext])

  const rows: HRecordRow[] | null = summary ? RECORD_ROWS.map(r => ({ key: r.key, label: tt(r.label), ...(summary.highlights?.[r.key] || { n: 0, pct: null }) })) : null
  const sure = summary ? dcSure(summary.doubleChance) : null
  const specialItems: HSpecialItem[] = alerts.map(x => ({
    id: x.matchId, href: matchHref('football', x.matchId, { home: x.home, away: x.away, date: x.date })!, league: x.league, date: x.date, title: `${x.home} – ${x.away}`,
    main: { label: tt('Draw chance'), value: `${Math.round(x.ourDraw)}%` },
    extra: x.dc ? { label: tt('Our pick'), value: `${x.dc.k} · ${Math.round(x.dc.p)}%` } : null
  }))
  const resultRows: HResult[] | null = results ? results.map(toResult) : null

  return {
    loaded,
    featured: featuredList.map(toGame),
    live: live.map(toGame),
    soonest: soonest.map(toGame),
    favorites: favNext.map(toGame),
    next: next.map(toGame),
    news,
    full,
    record: {
      rows, aside: summary ? (summary.doubleChance?.n ? tt("{0} games, last {1} days", { 0: summary.doubleChance.n.toLocaleString(LOCALE), 1: summary.days }) : tt("last {0} days", { 0: summary.days })) : null,
      note: `${tt("Picks right, every game counted. Each prediction is saved before kick-off and never edited.")} ${tt("Double chance = one of the two results we rate highest (1X, X2 or 12).")}`,
      link: { to: '/football/accuracy', label: tt("See the full record →") },
      empty: { text: tt("No finished games yet.") }
    },
    special: {
      title: tt("Draw picks"), tone: 'draw', open: full, items: specialItems,
      empty: tt("No draw picks this week yet. They appear when the coming games are scheduled."),
      locked: {
        title: summary?.drawAlerts?.picks ? tt("{n, plural, one {# draw pick} other {# draw picks}} this week", { n: summary.drawAlerts.picks }) : tt("Draw picks"),
        text: tt("The 2 games of the week most likely to end in a draw, picked by our model. Part of Pro.")
      },
      link: full ? { to: '/football/draw-alerts', label: tt("All draw picks →") } : { to: '/premium', label: tt("Unlock draw picks →") }
    },
    results: { rows: resultRows, days: 30, link: { to: '/football/accuracy', label: tt("How accurate is the model? →") } },
    introStats: summary?.doubleChance?.v3 != null ? [
      { value: `${summary.doubleChance.v3}%`, label: tt("right · double chance"), sub: tt("{0} games, last {1} days", { 0: summary.doubleChance.n.toLocaleString(LOCALE), 1: summary.days }) },
      ...(sure ? [{ value: `${sure.pct}%`, label: tt("when we're {0}%+ sure · double chance", { 0: sure.min }), sub: tt("{0} games", { 0: sure.n }) }] : [])
    ] : undefined
  }
}

export const footballAdapter: SportAdapter = {
  field: 'pitch',
  labels: {
    featured: tt("Featured match"), modelPrediction: tt("{0} prediction", { 0: slModel('football') }), nextList: tt("Next kick-offs"), nextSection: tt("Next matches"),
    all: { to: '/football/matches', label: tt("All matches →") }, today: { to: '/football/today', label: tt("Today's predictions →") },
    favorites: '/football/favorites', liveDetail: tt("Live stats, lineups and events →"),
    emptyHero: [tt("Sports predictions,"), tt("tested in public."), tt("The next fixtures appear here as soon as they are scheduled.")],
    newsLoading: tt("Loading the latest football news…"),
    premiumText: tt("Full percentages, the {0} breakdown, draw picks, strong picks, team analysis and the complete track record.", { 0: slModel('football') })
  },
  intro: {
    title: tt("Sports predictions, tested in public"), text: tt("Know what is likely before kick-off, and why."),
    bullets: [
      [tt("Every match"), tt("Football now, basketball next: win chances, goals or points, and the reasons behind each pick.")],
      [tt("Checked in public"), tt("Every prediction is saved before kick-off and scored after the game.")],
      [tt("Free to start"), tt("2 full picks every week. No card needed.")]
    ],
    cta: { to: '/signup', label: tt("Get 2 free picks a week") },
    second: { to: '/football/accuracy', label: tt("See our record"), record: true }
  },
  useData: useFootballData
}

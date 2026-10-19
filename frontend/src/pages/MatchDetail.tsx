import YourPicks from '../components/YourPicks'
import UnlockPrompt from '../components/UnlockPrompt'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useLocation } from 'react-router-dom'
import axios from 'axios'
import { API_URL, socket } from '../lib/socket'
import { modelInfo, isV3, score10, CONFIDENCE_LABEL, MATCH_TYPE_LABEL, pickOfPrediction, doubleChance, dcLabel, shortTeam, type DC, type Prediction } from '../lib/predict'
import OurPick from '../components/DcPick'
import WinProbability from '../components/WinProbability'
import { useReveal, justRevealed, hideMatch, guessFirstOn } from '../lib/reveal'
import CountUp from '../components/CountUp'
import { RevealCover } from '../components/Reveal'
import PredictionStory from '../components/PredictionStory'
import { FavStar, nameKey as favKey } from '../lib/favorites'
import { t as tt, LOCALE, lang } from '../lib/i18n'
import GamePage, { HeroLogo, GameNews } from '../components/sport/game/GamePage'
import Highlights from '../components/sport/game/Highlights'
import { newerFootballLive, tickedMinute } from '../lib/liveState'
import { footballTeamHref } from '../lib/teamLink'
import NameLink, { href as hrefOf } from '../components/sport/NameLink'
import RowLink from '../components/sport/RowLink'
import { tNodes } from '../lib/tNodes'

/** fix174: the match's competition code, so every team name on the page links to its team page */
const CompCode = createContext<string | undefined>(undefined)
function TeamName({ team, className, short = false }: { team: { id?: number; name: string; shortName?: string }; className?: string; short?: boolean }) {
  const code = useContext(CompCode)
  const label = short ? team.shortName || team.name : tname(team as Team)
  return <NameLink to={team.id ? footballTeamHref(team.id, team.name, code) : null} className={className}>{label}</NameLink>
}

/* ---------- types (Football-Data.org v4 shapes, loosely) ---------- */

interface Team {
  id: number
  name: string
  shortName?: string
  tla?: string
  crest?: string
  coach?: { id: number; name: string; nationality?: string } | null
  formation?: string | null
  lineup?: Player[]
  bench?: Player[]
  statistics?: Record<string, number> | null
  basedOn?: number // probable lineups only: number of recent matches analysed
}

interface Player {
  id: number
  name: string
  position?: string | null
  shirtNumber?: number | null
}

interface Match {
  id: number
  utcDate: string
  status: string
  minute?: number | null
  injuryTime?: number | null
  matchday?: number | null
  stage?: string
  group?: string | null
  venue?: string | null
  attendance?: number | null
  competition: { id: number; name: string; code: string; emblem?: string; trial?: boolean }
  season?: { startDate: string; endDate: string }
  homeTeam: Team
  awayTeam: Team
  score: {
    winner?: string | null
    fullTime: { home: number | null; away: number | null }
    halfTime?: { home: number | null; away: number | null }
  }
  goals?: Goal[]
  bookings?: Booking[]
  substitutions?: Substitution[]
  referees?: { id: number; name: string; type?: string; nationality?: string }[]
}

interface Goal {
  minute: number
  injuryTime?: number | null
  type: string
  team: { id: number; name: string }
  scorer: { id: number; name: string }
  assist?: { id: number; name: string } | null
  score?: { home: number; away: number }
}

interface Booking {
  minute: number
  team: { id: number; name: string }
  player: { id: number; name: string }
  card: 'YELLOW' | 'YELLOW_RED' | 'RED'
}

interface Substitution {
  minute: number
  team: { id: number; name: string }
  playerOut: { id: number; name: string }
  playerIn: { id: number; name: string }
}

interface StandingRow {
  position: number
  playedGames: number
  form?: string | null
  won: number
  draw: number
  lost: number
  points: number
  goalsFor: number
  goalsAgainst: number
  goalDifference: number
  group?: string | null
  teamsInTable?: number
}

interface Details {
  match: Match
  prediction: Prediction | null
  predictions?: Prediction[]
  /** SEO match preview (fix121): English text from our own data, never the pick or a %; same text crawlers get */
  preview?: { text: string; builtAt: string; title: string } | null
  head2head: {
    aggregates: {
      numberOfMatches: number
      totalGoals: number
      homeTeam: { id: number; wins: number; draws: number; losses: number }
      awayTeam: { id: number; wins: number; draws: number; losses: number }
    }
    matches: Match[]
  } | null
  standings: { home: StandingRow | null; away: StandingRow | null }
  form: { home: Match[]; away: Match[] }
  probableLineups?: { home: Probable | null; away: Probable | null } | null
  /** opened from a list (fix122): only the list's match + prediction so far, the rest is on its way */
  partial?: boolean
}

/** The match a list passed in router state, as a first, partial view of the page (header + prediction). */
function seedFromList(state: unknown, matchId: number): Details | null {
  const m: any = (state as any)?.match
  if (!m || m.id !== matchId || !m.homeTeam || !m.awayTeam || !m.score) return null
  return {
    match: m, prediction: m.prediction ?? null, predictions: m.predictions, preview: null, head2head: null,
    standings: { home: null, away: null }, form: { home: [], away: [] }, probableLineups: null, partial: true
  }
}

/** A team's usual XI, built by the backend from its last few matches. */
interface Probable {
  teamId: number
  basedOn: number
  formation: string | null
  lineup: (Player & { starts: number })[]
}

const LIVE = new Set(['IN_PLAY', 'PAUSED'])
const DONE = new Set(['FINISHED', 'AWARDED'])

/* ---------- helpers ---------- */

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
}

function resultFor(teamId: number, m: Match): 'W' | 'D' | 'L' | null {
  const w = m.score?.winner
  if (!w) return null
  if (w === 'DRAW') return 'D'
  const isHome = m.homeTeam.id === teamId
  return (w === 'HOME_TEAM') === isHome ? 'W' : 'L'
}

function statusLabel(m: Match) {
  if (m.status === 'IN_PLAY') return m.minute ? `${m.minute}'${m.injuryTime ? `+${m.injuryTime}` : ''}` : 'LIVE'
  if (m.status === 'PAUSED') return 'Half-time'
  if (m.status === 'FINISHED') return 'Full-time'
  if (m.status === 'POSTPONED') return 'Postponed'
  if (m.status === 'CANCELLED') return 'Cancelled'
  if (m.status === 'SUSPENDED') return 'Suspended'
  return fmtTime(m.utcDate)
}

// Display order: the most telling numbers first (like a live-score app)
const STAT_LABELS: Record<string, string> = {
  expected_goals: tt("Expected goals (xG)"),
  ball_possession: tt("Possession %"),
  shots: tt("Total shots"),
  shots_on_goal: tt("Shots on target"),
  shots_off_goal: tt("Shots off target"),
  blocked_shots: tt("Blocked shots"),
  shots_inside_box: tt("Shots inside the box"),
  shots_outside_box: tt("Shots outside the box"),
  corner_kicks: tt('Corners'),
  saves: tt("Goalkeeper saves"),
  passes: tt('Passes'),
  pass_accuracy: tt("Pass accuracy %"),
  fouls: tt('Fouls'),
  offsides: tt('Offsides'),
  free_kicks: tt("Free kicks"),
  goal_kicks: tt("Goal kicks"),
  throw_ins: tt('Throw-ins'),
  yellow_cards: tt("Yellow cards"),
  red_cards: tt("Red cards")
}

/** Two-sided stat bars (home left, away right), possession as one big split bar. */
function StatsPanel({ home, away, hs, as, keys }: { home: Team; away: Team; hs: Record<string, number>; as: Record<string, number>; keys: string[] }) {
  const fmt = (k: string, v: number) => (k === 'expected_goals' || k === 'goals_prevented' ? v.toFixed(2) : String(Math.round(v)))
  const poss = keys.includes('ball_possession') ? { h: hs.ball_possession ?? 0, a: as.ball_possession ?? 0 } : null
  return (
    <div>
      <div className="flex items-center justify-between text-xs font-semibold mb-3">
        <TeamName team={home} short className="text-home truncate" />
        <TeamName team={away} short className="text-away truncate text-right" />
      </div>
      {poss && (
        <div className="mb-5">
          <div className="text-[11px] text-faint text-center mb-1.5">{tt("Possession")}</div>
          <div className="flex h-7 rounded-lg overflow-hidden text-xs font-bold num">
            <div className="bg-home/80 text-bg grid place-items-center transition-all" style={{ width: `${poss.h || 50}%` }}>{Math.round(poss.h)}%</div>
            <div className="bg-away/80 text-bg grid place-items-center transition-all" style={{ width: `${poss.a || 50}%` }}>{Math.round(poss.a)}%</div>
          </div>
        </div>
      )}
      <div className="space-y-3">
        {keys
          .filter(k => k !== 'ball_possession')
          .map(k => {
            const h = hs[k] ?? 0
            const a = as[k] ?? 0
            const total = h + a || 1
            const lead = h === a ? null : h > a ? 'H' : 'A'
            return (
              <div key={k} className="grid grid-cols-[52px_1fr_52px] items-center gap-3 text-sm">
                <span className={`num font-semibold text-right ${lead === 'H' ? 'text-ink' : 'text-muted'}`}>{fmt(k, h)}</span>
                <div>
                  <div className="text-[11px] text-faint text-center mb-1">{STAT_LABELS[k]}</div>
                  <div className="flex h-1.5 gap-0.5">
                    <div className="flex-1 flex justify-end">
                      <div className={`h-full rounded-l-full bg-home transition-all ${lead === 'A' ? 'opacity-50' : ''}`} style={{ width: `${(h / total) * 100}%` }} />
                    </div>
                    <div className="flex-1">
                      <div className={`h-full rounded-r-full bg-away transition-all ${lead === 'H' ? 'opacity-50' : ''}`} style={{ width: `${(a / total) * 100}%` }} />
                    </div>
                  </div>
                </div>
                <span className={`num font-semibold ${lead === 'A' ? 'text-ink' : 'text-muted'}`}>{fmt(k, a)}</span>
              </div>
            )
          })}
      </div>
    </div>
  )
}

/* ---------- page ---------- */


/** v3 grid breakdown: match type, 1000-point split, per-parameter values × relevance. */
function GridBreakdown({ p, home, away }: { p: Prediction; home: Team; away: Team }) {
  const g = p.grid!
  const hn = home.shortName || home.name
  const an = away.shortName || away.name
  const DRAW_ROWS = new Set(['#15', '#30', '#16'])
  // rows with weight 0 are measured but carry no points (the October 2026 fit found they add nothing once the others are in)
  const unused = g.rows.filter(r => !r.rel).map(r => tt(r.name))
  const teamRows = g.rows.filter(r => !DRAW_ROWS.has(r.id) && r.rel > 0)
  const drawRows = g.rows.filter(r => DRAW_ROWS.has(r.id) && r.rel > 0)
  return (
    <div className="mt-5 rounded-xl border border-line/70 bg-surface/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="text-xs text-muted">
          <span className="font-semibold text-ink">{MATCH_TYPE_LABEL[g.matchType]}</span>
          <span className="text-faint"> {tt("· relevance weights for this match type")}</span>
        </div>
        <div className="num text-xs text-muted">
          <span className="text-home font-semibold">{g.points.home}</span> · <span className="text-draw font-semibold">{g.points.draw}</span> ·{' '}
          <span className="text-away font-semibold">{g.points.away}</span> <span className="text-faint">/ 1000</span>
        </div>
      </div>
      {g.reasons.length > 0 && (
        <ul className="mb-3 space-y-0.5 text-xs text-muted">
          {g.reasons.map((r, i) => (
            <li key={i}>· {r}</li>
          ))}
        </ul>
      )}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-faint">
            <th className="text-left font-medium py-1">{tt("Parameter")}</th>
            <th className="text-right font-medium py-1 w-12">{tt("Rel.")}</th>
            <th className="text-right font-medium py-1 w-16">{hn}</th>
            <th className="text-right font-medium py-1 w-16">{an}</th>
            <th className="text-right font-medium py-1 w-16">{tt("Edge")}</th>
          </tr>
        </thead>
        <tbody>
          {teamRows.map(r => (
            <tr key={r.id} className="border-t border-line/40" title={r.note}>
              <td className="py-1 text-muted">{tt(r.name)}</td>
              <td className="py-1 text-right num text-faint">{r.rel}</td>
              <td className="py-1 text-right num text-ink">{Math.round(score10(r.home) * 10) / 10}</td>
              <td className="py-1 text-right num text-ink">{Math.round(score10(r.away) * 10) / 10}</td>
              <td className={`py-1 text-right num font-semibold ${r.edge > 0 ? 'text-home' : r.edge < 0 ? 'text-away' : 'text-faint'}`}>
                {r.edge > 0 ? '+' : ''}{r.edge}
              </td>
            </tr>
          ))}
          <tr className="border-t border-line/70 font-semibold">
            <td className="py-1 text-ink">{tt("Total")}</td>
            <td />
            <td className="py-1 text-right num text-ink">{g.totals.home}</td>
            <td className="py-1 text-right num text-ink">{g.totals.away}</td>
            <td className={`py-1 text-right num ${g.totals.home > g.totals.away ? 'text-home' : 'text-away'}`}>
              {g.totals.home - g.totals.away > 0 ? '+' : ''}{Math.round((g.totals.home - g.totals.away) * 10) / 10}
            </td>
          </tr>
        </tbody>
      </table>
      {drawRows.length > 0 && (
        <div className="mt-3 pt-2 border-t border-line/40 text-xs text-muted flex flex-wrap gap-x-4 gap-y-1">
          <span className="text-faint">{tt("Draw pot")}</span>
          {drawRows.map(r => (
            <span key={r.id} title={r.note}>
              {tt(r.name)} <span className="num text-ink">{r.home}</span>
              <span className="text-faint">×{r.rel}</span>
            </span>
          ))}
          <span>
            {tt("base")}{' '}<span className="num text-ink">{g.drawPot.base}</span> {g.drawPot.factors >= 0 ? '+' : '−'} <span className="num text-ink">{Math.abs(g.drawPot.factors)}</span> ={' '}
            <span className="num text-draw font-semibold">{g.drawPot.total}</span>
          </span>
        </div>
      )}
      {g.scope === 'national' || g.scope === 'cups' ? (
      <p className="mt-3 text-[11px] text-faint">
        {g.scope === 'national' ? tt("v3's national-team engine. Each parameter is scored among all active national teams (5.5 = average) and weighted by how much it predicted results since 2018. Edge = how many points (out of 1000) that parameter moves toward one side. Friendlies count for less, because teams rotate their squads.") : tt("v3's European-cup engine. Each parameter is scored among all clubs playing in UEFA competitions (5.5 = average), from their league and cup games together, and weighted by how much it predicted past cup results. Edge = how many points (out of 1000) that parameter moves toward one side.")}
      </p>
      ) : (
      <p className="mt-3 text-[11px] text-faint">
        {tt("Each parameter is scored within the league (5.5 = average; most teams land between 1 and 10, standouts like the league's superteams can go above 10) and multiplied by its relevance for this match type. The difference between the two totals sets the home/away split of the points left after the draw pot, which starts from the goals-based chance of a draw. Weights fitted on the 2024-25 and 2025-26 seasons and checked on 2026-27 (October 2026).")}{unused.length > 0 && <> {tt("Measured but not used, because they add nothing once the others are in:")}{' '}{unused.join(', ')}.</>}
      </p>
      )}
    </div>
  )
}

function MatchDetail() {
  const { id } = useParams()
  const matchId = Number(id)
  const location = useLocation()
  // opened from a list: show the header and the prediction from the list at once, fill the rest when details arrive
  const [details, setDetails] = useState<Details | null>(() => seedFromList(location.state, matchId))
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(() => !seedFromList(location.state, matchId))
  // premium "guess first": the prediction stays covered until the member taps Reveal (upcoming games only)
  const { hidden, reveal } = useReveal(matchId, details?.match.status, true)
  // just unlocked ($15 Premium): play the "v3 is analysing" reveal automatically, then roll the numbers in
  const [unlockAnim, setUnlockAnim] = useState(false)
  // confirmed lineups in: the updated analysis waits behind its own "reveal" button (remembered per match)
  const xiKey = `b2b-xi-seen-${matchId}`
  const [xiSeen, setXiSeen] = useState(() => { try { return localStorage.getItem(xiKey) === '1' } catch { return false } })
  const [xiAnim, setXiAnim] = useState(false)
  const markXiSeen = () => { setXiSeen(true); try { localStorage.setItem(xiKey, '1') } catch { /* private mode */ } }
  // fix128: opened from a list's "See prediction" (phones): scroll to the card and reveal it there
  const wantReveal = !!(location.state as any)?.reveal
  const autoRevealed = useRef(false)
  useEffect(() => {
    if (wantReveal && hidden && !autoRevealed.current) { autoRevealed.current = true; setUnlockAnim(true) }
  }, [wantReveal, hidden])
  const scrolled = useRef(false)
  useEffect(() => {
    if (scrolled.current || !details || window.location.hash !== '#prediction') return
    scrolled.current = true
    requestAnimationFrame(() => document.getElementById('prediction-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [details])

  const load = (initial = false) => {
    if (initial && !seedFromList(location.state, matchId)) setLoading(true)
    return axios
      .get(`${API_URL}/matches/${matchId}/details`)
      .then(res => {
        // fix165: a reload never takes the score / minute back (the socket push may be newer than the copy we got)
        const next: Details = res.data.data
        setDetails(prev => (prev && next?.match && prev.match.id === next.match.id ? { ...next, match: newerFootballLive(prev.match, next.match) } : next))
        setError(null)
      })
      .catch(err => setError(err.response?.data?.message || err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!matchId) return
    const seed = seedFromList(location.state, matchId)
    setDetails(cur => (cur && cur.match.id === matchId ? cur : seed))
    load(true)
  }, [matchId])

  // browser tab: "Arsenal vs Chelsea · SportLikely"
  const tabTitle = details ? `${details.match.homeTeam.shortName || details.match.homeTeam.name} vs ${details.match.awayTeam.shortName || details.match.awayTeam.name}` : ''
  // English pages: the same title search engines get ("Home vs Away prediction & preview · Competition · date | SportLikely")
  const seoTitle = lang === 'en' ? details?.preview?.title : undefined
  useEffect(() => {
    if (seoTitle) document.title = seoTitle
    else if (tabTitle) document.title = tt("{0} · SportLikely", { 0: tabTitle })
  }, [tabTitle, seoTitle])

  // Live scores arrive over the socket; full details (events, lineups) are re-fetched on a timer:
  //   live → every 60s · within 2h of kick-off → every 90s (official lineups land ~1h before) · otherwise every 5 min
  const isLive = details ? LIVE.has(details.match.status) : false
  const isDone = details ? DONE.has(details.match.status) : false
  const kickoff = details ? new Date(details.match.utcDate).getTime() : 0
  const hasOfficialLineups = details
    ? (details.match.homeTeam.lineup?.length || 0) > 0 || (details.match.awayTeam.lineup?.length || 0) > 0
    : false
  useEffect(() => {
    if (!matchId) return
    // rooms belong to one connection: subscribe again after every (re)connect
    const subscribe = () => socket.emit('subscribe_match', matchId)
    subscribe()
    socket.on('connect', subscribe)
    const onLive = (m: Match) => {
      if (m.id !== matchId) return
      // Only take the live fields — the slim live payload has no lineups/stats/events
      setDetails(prev =>
        prev
          ? withLiveChance({ ...prev, match: newerFootballLive(prev.match, { ...prev.match, status: m.status, minute: m.minute, injuryTime: m.injuryTime, score: m.score }) }, (m as Match & { prediction?: Prediction | null }).prediction?.live)
          : prev
      )
    }
    socket.on('match:live', onLive)

    let timer: ReturnType<typeof setInterval> | null = null
    if (!isDone) {
      const soon = kickoff - Date.now() < 2 * 60 * 60 * 1000 && !hasOfficialLineups
      const every = isLive ? 60 : soon ? 90 : 300
      timer = setInterval(() => load(false), every * 1000)
    }
    return () => {
      socket.emit('unsubscribe_match', matchId)
      socket.off('connect', subscribe)
      socket.off('match:live', onLive)
      if (timer) clearInterval(timer)
    }
  }, [matchId, isLive, isDone, hasOfficialLineups, Math.floor((kickoff - Date.now()) / (30 * 60 * 1000))])

  // Which model the Prediction section shows (default: the one the backend prefers, v2 when available)
  const [modelId, setModelId] = useState<string | null>(null)

  // fix165: between readings the minute ticks up once a minute while the ball is in play (lib/liveState)
  const reading = useRef<{ key: string; at: number }>({ key: '', at: Date.now() })
  const readingKey = details ? `${details.match.status}|${details.match.minute}|${details.match.injuryTime}` : ''
  if (reading.current.key !== readingKey) reading.current = { key: readingKey, at: Date.now() }
  const [, setClock] = useState(0)
  useEffect(() => {
    if (!isLive) return
    const iv = setInterval(() => setClock(n => n + 1), 20 * 1000)
    return () => clearInterval(iv)
  }, [isLive])

  // Probable lineups are built server-side from recent matches; if they weren't ready in time
  // for the first response (API quota), try again a few times shortly after.
  const [probableRetries, setProbableRetries] = useState(0)
  const probableMissing =
    !!details &&
    !isDone &&
    !hasOfficialLineups &&
    !(details.probableLineups?.home?.lineup.length || details.probableLineups?.away?.lineup.length)
  useEffect(() => {
    if (!probableMissing || probableRetries >= 4) return
    const t = setTimeout(() => {
      setProbableRetries(n => n + 1)
      load(false)
    }, 15 * 1000)
    return () => clearTimeout(t)
  }, [probableMissing, probableRetries])

  const events = useMemo(() => {
    if (!details) return []
    const m = details.match
    const list: { minute: number; extra: number; kind: string; teamId: number; text: string; sub?: string; href?: string | null }[] = []
    // fix174: the player's name opens the player page
    const pHref = (pl: { id: number; name: string } | null | undefined, teamId: number) => {
      const team = teamId === m.homeTeam?.id ? m.homeTeam : teamId === m.awayTeam?.id ? m.awayTeam : null
      return pl && team ? playerHref(pl, team as Team, m.competition?.code) : null
    }
    ;(m.goals || []).forEach(g =>
      list.push({
        minute: g.minute,
        extra: g.injuryTime || 0,
        kind: g.type === 'OWN' ? 'own' : g.type === 'PENALTY' ? 'pen' : 'goal',
        teamId: g.team.id,
        text: g.scorer.name + (g.type === 'PENALTY' ? tt(" (pen)") : g.type === 'OWN' ? ' (og)' : ''),
        sub: g.assist ? `assist: ${g.assist.name}` : undefined,
        href: g.type === 'OWN' ? null : pHref(g.scorer, g.team.id)
      })
    )
    ;(m.bookings || []).forEach(b =>
      list.push({ minute: b.minute, extra: 0, kind: b.card.toLowerCase(), teamId: b.team.id, text: b.player.name, href: pHref(b.player, b.team.id) })
    )
    ;(m.substitutions || []).forEach(s =>
      list.push({
        minute: s.minute,
        extra: 0,
        kind: 'sub',
        teamId: s.team.id,
        text: s.playerIn.name,
        href: pHref(s.playerIn, s.team.id),
        sub: `for ${s.playerOut.name}`
      })
    )
    return list.sort((a, b) => a.minute - b.minute || a.extra - b.extra)
  }, [details])

  // Page sections as tabs: Prediction first, then Statistics, Lineups and the league table.
  // The open tab lives in the URL hash (#stats, #lineups, #table) so a link can open it directly.
  const [tab, setTab] = useState<TabId>(() => {
    const h = (typeof window !== 'undefined' ? window.location.hash.slice(1) : '') as TabId
    return TAB_IDS.includes(h) ? h : 'prediction'
  })
  const pickTab = (t: TabId) => {
    setTab(t)
    try { history.replaceState(null, '', t === 'prediction' ? window.location.pathname + window.location.search : `#${t}`) } catch { /* ignore */ }
  }

  // League table (fetched once per competition; the tab is hidden when there is none)
  const compCode = details?.match.competition.code
  const [tables, setTables] = useState<StandingsTable[] | null>(null)
  useEffect(() => {
    if (!compCode) return
    let cancelled = false
    setTables(null)
    axios
      .get(`${API_URL}/leagues/${compCode}/standings`)
      .then(res => !cancelled && setTables(res.data.data?.standings || []))
      .catch(() => !cancelled && setTables([]))
    return () => {
      cancelled = true
    }
  }, [compCode])

  // Tab data loaded on first open (built from API-Football: last 10 games, last 5 lineups, last 10 meetings).
  // undefined = not loaded yet, null = nothing available.
  const [xStats, setXStats] = useState<{ home: TeamAvg; away: TeamAvg } | null | undefined>(undefined)
  const [xLineups, setXLineups] = useState<{ home: XI; away: XI; injuries?: { home: Injury[]; away: Injury[] } | null } | null | undefined>(undefined)
  const [xH2H, setXH2H] = useState<H2HData | null | undefined>(undefined)
  const [xRest, setXRest] = useState<{ kickoff: string; home: TeamSchedule; away: TeamSchedule } | null | undefined>(undefined)
  const requested = useRef<{ id: number; parts: Set<string> }>({ id: 0, parts: new Set<string>() })
  useEffect(() => {
    if (!matchId || !details) return
    if (requested.current.id !== matchId) {
      requested.current = { id: matchId, parts: new Set<string>() }
      setXStats(undefined)
      setXLineups(undefined)
      setXH2H(undefined)
      setXRest(undefined)
    }
    const setters: Record<string, (v: any) => void> = { stats: setXStats, lineups: setXLineups, h2h: setXH2H, rest: setXRest }
    // the open tab; the expected lineups also load in the background from the prediction tab
    const parts = [tab, ...(tab === 'prediction' ? ['lineups'] : [])].filter(p => p in setters)
    for (const part of parts) {
      if (requested.current.parts.has(part)) continue
      requested.current.parts.add(part)
      const id = matchId
      axios
        .get(`${API_URL}/matches/${id}/extras/${part}`, { timeout: 90000 })
        .then(res => requested.current.id === id && setters[part](res.data.data ?? null))
        .catch(() => requested.current.id === id && setters[part](null))
    }
  }, [tab, matchId, !!details])

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-16 text-center text-muted">{tt("Loading match…")}</div>
  if (!details || (error && !details.partial))
    return (
      <div className="max-w-5xl mx-auto px-4 py-10">
        <Link to="/matches" className="text-sm text-muted hover:text-ink">{tt("← Back")}</Link>
        <div className="mt-4 card border-loss/40 text-loss rounded-lg p-4">
          {tt("Could not load match:")}{' '}{error || tt("unknown error")}
        </div>
      </div>
    )

  const m = tickedMinute(details.match, reading.current.at)
  const home = m.homeTeam
  const away = m.awayTeam
  const live = LIVE.has(m.status)
  const done = DONE.has(m.status)
  const halted = ['SUSPENDED', 'POSTPONED', 'CANCELLED'].includes(m.status)
  const showScore = live || done
  // v1 (standings) is a fallback only: shown when no other model covers the match
  const allModels = details.predictions && details.predictions.length ? details.predictions : details.prediction ? [details.prediction] : []
  // Only our own model (v3) is shown; the older v1/v2 stay as a fallback for matches v3 doesn't cover
  const OLD = ['poisson-dc-v1', 'dc-history-v2']
  const models = allModels.some(m => !OLD.includes(m.model))
    ? allModels.filter(m => !OLD.includes(m.model))
    : allModels.some(m => m.model === 'dc-history-v2') ? allModels.filter(m => m.model === 'dc-history-v2') : allModels
  // our main model first (v3 for leagues, national teams, European cups); older models only on request
  const p = (modelId && models.find(m => m.model === modelId)) || models.find(m => ['v3-mix', 'grid-v3', 'elo-intl', 'elo-euro'].includes(m.model)) || details.prediction || models[0] || null
  const ft = m.score.fullTime
  const ht = m.score.halfTime
  const referee = (m.referees || []).find(r => !r.type || r.type === 'REFEREE') || (m.referees || [])[0]
  const homeStats = home.statistics || null
  const awayStats = away.statistics || null
  const statKeys = homeStats && awayStats ? Object.keys(STAT_LABELS).filter(k => k in homeStats && k in awayStats) : []
  const hasLineups = (home.lineup?.length || 0) > 0 || (away.lineup?.length || 0) > 0
  // Usual XIs (from recent matches) — shown until the official lineups arrive
  const pl = details.probableLineups
  const probable =
    !hasLineups && !done && pl && ((pl.home?.lineup.length || 0) > 0 || (pl.away?.lineup.length || 0) > 0)
      ? {
          home: { ...home, formation: pl.home?.formation || null, lineup: pl.home?.lineup || [], bench: [], basedOn: pl.home?.basedOn || 0 } as Team,
          away: { ...away, formation: pl.away?.formation || null, lineup: pl.away?.lineup || [], bench: [], basedOn: pl.away?.basedOn || 0 } as Team,
          basedOn: { home: pl.home?.basedOn || 0, away: pl.away?.basedOn || 0 }
        }
      : null

  // expected XI from the last 5 lineups (API-Football), in the same shape the pitch draws
  const xProbable =
    xLineups && ((xLineups.home?.lineup.length || 0) > 0 || (xLineups.away?.lineup.length || 0) > 0)
      ? {
          home: { ...home, formation: xLineups.home?.formation || null, lineup: xLineups.home?.lineup || [], bench: [], basedOn: xLineups.home?.basedOn || 0 } as Team,
          away: { ...away, formation: xLineups.away?.formation || null, lineup: xLineups.away?.lineup || [], bench: [], basedOn: xLineups.away?.basedOn || 0 } as Team
        }
      : null

  // a locked upcoming match carries no pick at all
  const pick: 'H' | 'D' | 'A' | null = p && !(p.locked && !p.pick) ? pickOfPrediction(p) : null
  const pickVar = pick === 'H' ? '--home' : pick === 'A' ? '--away' : '--draw'
  // fix120: our recommended pick is the double chance (two results); the 1X2 pick stays as the "hard call"
  const dc = pick ? doubleChance(p) : null
  const inDc = (k: 'H' | 'D' | 'A') => (dc ? dc.sides.includes(k) : pick === k)

  const tableTotals = (tables || []).filter(t => t.type === 'TOTAL')
  const tableInvolving = tableTotals.filter(t => t.table.some(r => r.team.id === home.id || r.team.id === away.id))
  const tableShow = tableInvolving.length ? tableInvolving : tableTotals
  const tabs: { id: TabId; label: string; short?: string; hint: string; live?: boolean }[] = [
    { id: 'prediction', label: tt('Prediction'), hint: '' },
    ...(done ? [{ id: 'highlights' as TabId, label: tt('Highlights'), short: tt('Video'), hint: tt("Official match highlights") }] : []),
    { id: 'stats', label: tt('Statistics'), short: tt('Stats'), hint: live ? tt("Live stats, match events and averages") : done ? tt("Match stats, events and averages") : tt("Averages from the last 10 games"), live },
    { id: 'lineups', label: tt('Lineups & injuries'), short: tt('Lineups'), hint: hasLineups ? tt("Official lineups") : done ? tt('Lineups') : tt("Expected XI from the last 5 games") },
    { id: 'rest', label: tt('Schedule & rest'), short: tt('Rest'), hint: tt("Days of rest, recent and next games") },
    { id: 'h2h', label: tt('H2H'), hint: tt("Last 10 meetings and recent form") },
    ...(tables === null || tableShow.length ? [{ id: 'table' as TabId, label: tt('Standings'), short: tt('Table'), hint: tt('{0} table', { 0: m.competition.name }) }] : [])
  ]

  // "Matchday 2 · League Stage · Group A" (the "·" of the translated "· Matchday" moves to the join)
  const roundBits = [
    m.matchday ? `${tt("· Matchday").replace(/^·\s*/, '')} ${m.matchday}` : null,
    m.stage && m.stage !== 'REGULAR_SEASON' ? m.stage.replace(/_/g, ' ').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/ - /g, ' · ') : null,
    m.group ? m.group.replace(/_/g, ' ') : null
  ].filter((x): x is string => !!x)
  const RENDER: Record<TabId, () => ReactNode> = {
    prediction: () => (
      <>
              {/* Prediction */}
              <Section
                id="prediction-card"
                title={tt("Prediction")}
                note={p ? [modelInfo(p.model).tag, modelInfo(p.model).name.replace(new RegExp(`^${modelInfo(p.model).tag} · `), ''), p.confidence ? CONFIDENCE_LABEL[p.confidence] : null].filter(Boolean).join(' · ') : undefined}
              >
                {p && p.locked ? (
                  <LockedPrediction pick={pick} dc={dc?.code || null} home={home} away={away} matchId={m.id} status={m.status} autoUnlock={wantReveal} onUnlocked={() => { setUnlockAnim(true); load(false) }} />
                ) : p && pick ? (
                  hidden || unlockAnim ? (
                    <RevealCover
                      key={unlockAnim ? 'auto' : 'cover'}
                      autoStart={unlockAnim}
                      onReveal={() => {
                        setUnlockAnim(false)
                        reveal()
                      }}
                    />
                  ) : xiAnim ? (
                    <RevealCover key="xi" autoStart onReveal={() => { setXiAnim(false); markXiSeen() }} />
                  ) : p.beforeLineups && !xiSeen && ['SCHEDULED', 'TIMED'].includes(m.status) ? (
                    <LineupUpdateCover before={p.beforeLineups} home={home} away={away} onReveal={() => setXiAnim(true)} />
                  ) : (
                  <>
                    {models.length > 1 && (
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                        <div className="seg">
                          {models.map(m => {
                            const info = modelInfo(m.model)
                            return (
                              <button
                                key={m.model}
                                onClick={() => setModelId(m.model)}
                                className={`seg-btn flex items-center gap-1.5 ${p.model === m.model ? 'seg-btn-active' : ''}`}
                                title={info.desc}
                              >
                                <span className="font-bold">{info.tag}</span>
                                <span className="hidden sm:inline">{info.name}</span>
                              </button>
                            )
                          })}
                        </div>
                        <span className="text-[11px] text-faint">{modelInfo(p.model).desc}</span>
                      </div>
                    )}
                    {/* fix128: "Most likely result" (the highest of 1 · X · 2 highlighted), then our double chance in words;
                        the two results inside it get a lime outline on the cards, the third is dimmed */}
                    {(() => {
                      const top = p.home >= p.draw && p.home >= p.away ? 'H' : p.away >= p.draw ? 'A' : 'D'
                      return (
                        <>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint mb-2">{tt("Most likely result")}</div>
                          <div className="grid grid-cols-3 gap-3">
                            <OutcomeTile k="H" label={home.shortName || home.name} v={p.home} top={top === 'H'} inPick={inDc('H')} roll={justRevealed(matchId)} delay={0} />
                            <OutcomeTile k="D" label={tt("Draw")} v={p.draw} top={top === 'D'} inPick={inDc('D')} roll={justRevealed(matchId)} delay={120} />
                            <OutcomeTile k="A" label={away.shortName || away.name} v={p.away} top={top === 'A'} inPick={inDc('A')} roll={justRevealed(matchId)} delay={240} />
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                            <OurPick p={p} home={shortTeam(home)} away={shortTeam(away)} showCode />
                          </div>
                        </>
                      )
                    })()}
                    <div className="flex h-2.5 gap-[3px] mt-4">
                      <div className={`rounded-full bg-home ${inDc('H') ? '' : 'opacity-35'}`} style={{ width: `calc(${p.home}% - 3px)` }} />
                      <div className={`rounded-full bg-draw ${inDc('D') ? '' : 'opacity-35'}`} style={{ width: `calc(${p.draw}% - 3px)` }} />
                      <div className={`rounded-full bg-away ${inDc('A') ? '' : 'opacity-35'}`} style={{ width: `calc(${p.away}% - 3px)` }} />
                    </div>

                    {p.live && LIVE.has(m.status) && <LiveChance p={p} home={home} away={away} paused={m.status === 'PAUSED'} />}

                    {['SCHEDULED', 'TIMED'].includes(m.status) && (
                      <LineupTip kickoff={kickoff} lineupsOut={hasLineups} usesLineups={isV3(p.model)} />
                    )}

                    {p.frozen && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span className="px-2.5 py-1 rounded-full bg-surface2 border border-line font-semibold text-ink">{tt("Saved before kick-off")}</span>
                        <span>{tt("This is exactly what we predicted before the game — it is never recalculated after the result.")}{p.frozen.full ? '' : tt(" The detailed breakdown was only stored from 26 Sept 2026.")}</span>
                      </div>
                    )}

                    {p.beforeLineups && <LineupChange p={p} home={home} away={away} />}

                    <PredictionStory
                      p={p}
                      home={home.shortName || home.name}
                      away={away.shortName || away.name}
                      upcoming={['SCHEDULED', 'TIMED'].includes(m.status)}
                      friendly={/friendl/i.test(m.competition.name || '')}
                    />
                    {guessFirstOn() && ['SCHEDULED', 'TIMED'].includes(m.status) && (
                      <div className="mt-2 text-right">
                        <button type="button" onClick={() => hideMatch(matchId)} className="text-xs text-faint hover:text-ink underline underline-offset-4">{tt("Hide prediction again")}</button>
                      </div>
                    )}

                    <GoalsPanel p={p} home={home} away={away} roll={justRevealed(matchId)} />

                    {p.grid && (
                      <details className="mt-4 group">
                        <summary className="cursor-pointer text-xs text-muted hover:text-ink select-none">{tt("For experts: the full model table")}</summary>
                        <GridBreakdown p={p} home={home} away={away} />
                      </details>
                    )}

                    <details className="mt-4 group">
                      <summary className="cursor-pointer text-xs text-muted hover:text-ink select-none">{p.grid ? tt("Goal model behind the extras") : tt("How this was calculated")}</summary>
                      {p.model.startsWith('elo-') ? (
                      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-muted">
                        <span>{home.shortName || home.name} {tt("Elo")}</span>
                        <span className="num text-ink">{p.factors.homeAttack}</span>
                        <span>{away.shortName || away.name} {tt("Elo")}</span>
                        <span className="num text-ink">{p.factors.awayAttack}</span>
                        <span>{tt("Home advantage (Elo points)")}</span>
                        <span className="num text-ink">{p.factors.homeAdvantage}</span>
                        <span>{tt("Squad value adjustment (Elo points, + favours")}{' '}{home.shortName || home.name})</span>
                        <span className="num text-ink">{p.factors.homeForm > 0 ? '+' : ''}{p.factors.homeForm}</span>
                        <span>{tt("Matches rated")}</span>
                        <span className="num text-ink">{p.factors.gamesPlayed.home} / {p.factors.gamesPlayed.away}</span>
                      </div>
                      ) : (
                      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-muted">
                        <span>{home.shortName || home.name} {tt("attack / defence")}</span>
                        <span className="num text-ink">{p.factors.homeAttack} / {p.factors.homeDefence}</span>
                        <span>{away.shortName || away.name} {tt("attack / defence")}</span>
                        <span className="num text-ink">{p.factors.awayAttack} / {p.factors.awayDefence}</span>
                        <span>{tt("Home advantage")}</span>
                        <span className="num text-ink">×{p.factors.homeAdvantage}</span>
                        <span>{tt("Evidence (weighted games)")}</span>
                        <span className="num text-ink">{p.factors.gamesPlayed.home} / {p.factors.gamesPlayed.away}</span>
                        <span>{tt("League average goals per team")}</span>
                        <span className="num text-ink">{p.factors.leagueAvgGoals}</span>
                        <span>{tt("Other likely scores")}</span>
                        <span className="num text-ink">{p.topScores.slice(1).map(sc => `${sc.home}–${sc.away} (${Math.round(sc.prob)}%)`).join(' · ')}</span>
                      </div>
                      )}
                      <p className="mt-3 text-xs text-faint">
                        {tt("Strength = goals per game relative to the league average, adjusted for opponent quality and shrunk toward average early in the season (1.00 = average). Attack above 1 is good; defence below 1 is good.")}</p>
                    </details>
                  </>
                  )
                ) : (
                  <p className="text-sm text-faint">{(m as any).unpredicted === 'few-games' ? tt("Not predicted (team without enough games)") : tt("No prediction available for this match yet.")}</p>
                )}
              </Section>

              <YourPicks sport="fb" gameId={m.id} home={home.shortName || home.name} away={away.shortName || away.name} />
              <GameNews home={{ team: home.name, short: home.shortName }} away={{ team: away.name, short: away.shortName }} />

              {(live || done) && p && !p.locked && !hidden && !unlockAnim && (
                <Section title={live ? tt("Live win probability") : tt("How the game swung")} note={tt("From our pre-match prediction, updated with the score, time and red cards")}>
                  <WinProbability p={p} m={m} />
                </Section>
              )}
      </>
    ),
    highlights: () => <Highlights url={`${API_URL}/matches/${matchId}/highlights`} />,
    stats: () => (
      <>
              {live && (
                <Section title={tt("Live stats")} note={m.minute ? tt("{0}'{1} · updates every minute", { 0: m.minute, 1: m.injuryTime ? `+${m.injuryTime}` : '' }) : tt("updates every minute")}>
                  {statKeys.length > 0 && homeStats && awayStats ? (
                    <StatsPanel home={home} away={away} hs={homeStats} as={awayStats} keys={statKeys} />
                  ) : (m.minute ?? 0) < 20 ? (
                    // fix162: the provider fills statistics a few minutes into the game; "doesn't publish" only after 20'
                    <p className="text-sm text-muted">{tt("Live statistics usually appear a few minutes into the game. This page checks again every minute.")}</p>
                  ) : (
                    <p className="text-sm text-muted">
                      {tt("Our data provider doesn’t publish live statistics for this match (common for friendlies and some smaller competitions). Score, cards, goals and substitutions still update live.")}</p>
                  )}
                </Section>
              )}
              {/* Events */}
              {events.length > 0 && (
                <Section title={tt("Match events")}>
                  <ol className="relative">
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-line/70 -translate-x-1/2" />
                    {events.map((e, i) => {
                      const isHome = e.teamId === home.id
                      return (
                        <li key={i} className={`relative grid grid-cols-[1fr_56px_1fr] items-center py-1.5 text-sm ${isHome ? '' : ''}`}>
                          <div className={`${isHome ? 'text-right pr-3' : ''}`}>
                            {isHome && <EventText e={e} align="right" />}
                          </div>
                          <div className="flex items-center justify-center">
                            <span className="num text-[11px] text-faint bg-surface px-1.5 py-0.5 rounded-md border border-line/60">
                              {e.minute}'{e.extra ? `+${e.extra}` : ''}
                            </span>
                          </div>
                          <div className={`${!isHome ? 'pl-3' : ''}`}>{!isHome && <EventText e={e} align="left" />}</div>
                        </li>
                      )
                    })}
                  </ol>
                </Section>
              )}
              {/* Statistics */}
              {!live && statKeys.length > 0 && homeStats && awayStats && (
                <Section title={tt("Statistics")}>
                  <StatsPanel home={home} away={away} hs={homeStats} as={awayStats} keys={statKeys} />
                </Section>
              )}

            <section>
              <div className="flex items-baseline justify-between gap-3 mb-3 px-1">
                <h2 className="font-display text-lg font-bold text-ink">{tt("Statistics")}</h2>
                <span className="text-xs text-faint">{tt("Last")}{' '}{Math.max(xStats?.home.games || 0, xStats?.away.games || 0) || 10} {tt("games · all competitions")}</span>
              </div>
              {xStats === undefined ? (
                <div className="rounded-2xl border border-line/60 bg-surface2/30 p-10 text-sm text-muted text-center">{tt("Loading the last 10 games of both teams…")}</div>
              ) : xStats && (xStats.home.games || xStats.away.games) ? (
                <AveragesPanel home={home} away={away} h={xStats.home} a={xStats.away} form={{ home: details.form.home.map(x => resultFor(home.id, x)).filter((r): r is 'W' | 'D' | 'L' => !!r).reverse(), away: details.form.away.map(x => resultFor(away.id, x)).filter((r): r is 'W' | 'D' | 'L' => !!r).reverse() }} />
              ) : (
                <div className="rounded-2xl border border-line/60 bg-surface2/30 p-6 text-sm text-faint">{tt("No recent games found for these teams.")}</div>
              )}
            </section>
      </>
    ),
    h2h: () => (
      <>
            {(() => {
              // the copy inside the match details can come without totals (some competitions): only used when complete
              const early = details.head2head?.aggregates && Array.isArray(details.head2head.matches) ? details.head2head : null
              const h2h = xH2H?.aggregates && Array.isArray(xH2H.matches) ? xH2H : early
              if (xH2H === undefined && !early) return <p className="text-sm text-muted text-center py-10">{tt("Loading head-to-head…")}</p>
              return h2h && h2h.aggregates.numberOfMatches > 0 ? (
                <Section title={tt("Last {0} meetings", { 0: h2h.matches.length })} note={h2h.matches.length ? tt("since {0}", { 0: new Date(h2h.matches[h2h.matches.length - 1].utcDate).getFullYear() }) : undefined}>
                  <H2H h2h={h2h} home={home} away={away} />
                </Section>
              ) : (
                <p className="text-sm text-faint text-center py-6">{tt("These teams have never met in the games we can see.")}</p>
              )
            })()}

            <Section title={tt("Form")} note={tt("Last results")}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                <TeamPanel team={home} side="H" row={details.standings.home} recent={details.form.home} />
                <TeamPanel team={away} side="A" row={details.standings.away} recent={details.form.away} />
              </div>
            </Section>
      </>
    ),
    lineups: () => (
      <>
              {/* Lineups */}
              {hasLineups ? (
                <Section title={live ? tt("Live pitch") : done ? tt("Lineups and match events") : tt("Official lineups")} note={[home.formation, away.formation].filter(Boolean).join(' vs ') || undefined}>
                  {live || done ? <LivePitch m={m} home={home} away={away} live={live} /> : <Pitch home={home} away={away} code={m.competition?.code} />}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5">
                    <Bench team={home} code={m.competition?.code} />
                    <Bench team={away} code={m.competition?.code} />
                  </div>
                </Section>
              ) : !done && xProbable ? (
                <Section title={tt("Probable lineups")} note={[xProbable.home.formation, xProbable.away.formation].filter(Boolean).join(' vs ') || undefined}>
                  <Pitch home={xProbable.home} away={xProbable.away} probable code={m.competition?.code} />
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-faint">
                    <span>
                      {tt("Our expected XI from each team's last {0} games: the formation they used most, and the player who played each position most · the dots show how many of those games he started", { 0: Math.max(xProbable.home.basedOn || 0, xProbable.away.basedOn || 0) })}</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulseDot" />
                      {tt("Replaced automatically when the official lineups are published (~1h before kick-off)")}</span>
                  </div>
                </Section>
              ) : !done && xLineups === undefined && !probable ? (
                <p className="text-sm text-muted text-center py-10">{tt("Working out the expected lineups from the last 5 games…")}</p>
              ) : probable ? (
                <Section title={tt("Probable lineups")} note={[probable.home.formation, probable.away.formation].filter(Boolean).join(' vs ') || undefined}>
                  <Pitch home={probable.home} away={probable.away} probable code={m.competition?.code} />
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-faint">
                    <span>
                      {tt("Usual XI from each team's last {0} matches · the dots show how many of those a player started", { 0: Math.max(probable.basedOn.home, probable.basedOn.away) })}</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulseDot" />
                      {tt("Replaced automatically when the official lineups are published (~1h before kick-off)")}</span>
                  </div>
                </Section>
              ) : (
                <p className="text-xs text-faint text-center">
                  {live || done ? tt("No lineup data from the provider for this match.") : tt("Lineups are published about an hour before kick-off.")}
                </p>
              )}

              {/* Injured and doubtful players listed for this match */}
              {xLineups?.injuries && (
                <Section title={tt("Injuries & suspensions")} note={tt("Importance 1–5: how often he started lately and his value to the squad")}>
                  {xLineups.injuries.home.length || xLineups.injuries.away.length ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
                      <InjuryList team={home} list={xLineups.injuries.home} />
                      <InjuryList team={away} list={xLineups.injuries.away} />
                    </div>
                  ) : (
                    <p className="text-sm text-faint">{done ? tt("No missing players were listed for this match.") : tt("No missing players listed yet — the list usually fills in during the days before the game.")}</p>
                  )}
                </Section>
              )}
      </>
    ),
    rest: () => (
          xRest === undefined ? (
            <p className="text-sm text-muted text-center py-10">{tt("Loading schedule…")}</p>
          ) : xRest ? (
            <>
              <Section title={tt("Schedule & rest")} note={tt("All competitions")}>
                <RestSummary home={home} away={away} h={xRest.home} a={xRest.away} />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8 mt-5">
                  <RestPanel team={home} side="H" s={xRest.home} />
                  <RestPanel team={away} side="A" s={xRest.away} />
                </div>
              </Section>
            </>
          ) : (
            <p className="text-sm text-faint text-center py-10">{tt("No schedule data for this match.")}</p>
          )
    ),
    table: () => (
          tables === null ? (
            <p className="text-sm text-muted text-center py-10">{tt("Loading table…")}</p>
          ) : tableShow.length ? (
            <LeagueTable tables={tableShow} name={details.match.competition.name} home={home} away={away} />
          ) : (
            <p className="text-sm text-faint text-center py-10">{tt("There is no league table for this competition.")}</p>
          )
    )
  }
  const side = (team: Team) => ({
    name: team.shortName || team.name,
    logo: <HeroLogo src={team.crest} />,
    href: footballTeamHref(team.id, team.name, m.competition?.code),
    title: tt("{0}: team page", { 0: team.name }),
    linkLabel: tt("Team page →"),
    sub: team.coach?.name || null,
    star: <FavStar size="sm" fav={{ kind: 'team', ref: favKey(team.name), name: team.shortName || team.name, img: team.crest || null, ids: [team.id] }} />
  })

  return (
    <CompCode.Provider value={m.competition?.code}>
    <GamePage
      back={{ to: '/matches', label: tt("All matches") }}
      srTitle={tabTitle ? `${tabTitle}${m.competition?.name ? ` · ${m.competition.name}` : ''} ${tt("prediction")}` : undefined}
      league={{
        name: m.competition.name, href: `/league/${m.competition.code}`, logo: m.competition.emblem || null, bits: roundBits,
        star: m.competition.code ? <FavStar size="sm" fav={{ kind: 'league', ref: m.competition.code, code: m.competition.code, name: m.competition.name, img: m.competition.emblem || null }} /> : undefined,
        badges: m.competition.trial ? (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-draw/15 text-draw"
            title={tt("We added this league recently. Its predictions are being tested and don’t count in our public record yet.")}>
            {tt("New league · in testing")}
          </span>
        ) : undefined
      }}
      date={fmtDate(m.utcDate)}
      home={side(home)}
      away={side(away)}
      score={showScore ? { home: ft.home ?? 0, away: ft.away ?? 0 } : null}
      time={fmtTime(m.utcDate)}
      scoreSub={showScore && ht && ht.home !== null && (done || m.status === 'PAUSED' || (m.minute ?? 0) > 45) ? (
        <div className="num text-xs text-faint mt-1">{tt("HT")}{' '}{ht.home}–{ht.away}</div>
      ) : undefined}
      status={{ kind: live ? 'live' : halted ? 'halted' : done ? 'done' : 'upcoming', text: live ? statusLabel(m) : halted ? tt(statusLabel(m)) : done ? tt("FULL-TIME") : tt("KICK-OFF") }}
      statusNote={halted ? (
        <p className="mt-2 max-w-[260px] mx-auto text-[11px] text-muted">
          {m.status === 'CANCELLED'
            ? tt("This match was abandoned or cancelled. It does not count in our record.")
            : m.status === 'SUSPENDED'
              ? tt("This match was suspended. It does not count in our record unless it is completed later.")
              : tt("This match was postponed. Our prediction stays until the new date.")}
        </p>
      ) : undefined}
      pickVar={pick ? pickVar : null}
      footer={(m.venue || referee || m.attendance) ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1 justify-center text-xs text-faint">
          {m.venue && <span>{tt("Venue")}{' '}<span className="text-muted">{m.venue}</span> <span className="text-faint">({home.shortName || home.name})</span></span>}
          {referee && <span>{tt("Referee")}{' '}<span className="text-muted">{referee.name}</span></span>}
          {m.attendance && <span>{tt("Attendance")}{' '}<span className="num text-muted">{m.attendance.toLocaleString()}</span></span>}
        </div>
      ) : undefined}
      afterHero={<>
        {lang === 'en' && details?.preview?.text && <MatchPreview text={details.preview.text} />}
        <p className="mt-3 text-xs text-muted">
          <Link to="/guides/win-percentages" className="hover:text-ink">{tt("New here? How to read our numbers")} <span aria-hidden className="text-accent">→</span></Link>
        </p>
        {details.partial && <p className="mt-4 text-xs text-faint animate-pulse">{error ? `${tt("Could not load match:")} ${error}` : tt("Loading match…")}</p>}
      </>}
      tabs={tabs.map(x => ({ ...x, render: RENDER[x.id] }))}
      tab={tab}
      onTab={id => pickTab(id as TabId)}
    />
    </CompCode.Provider>
  )
}

/* ---------- pieces ---------- */

/** Lineups are in: the earlier numbers, and a button to reveal the analysis updated with the confirmed XI. */
/** Socket update: the new live win chance goes on the main prediction and on the same model in the list. */
function withLiveChance(d: Details, live: Prediction['live']): Details {
  if (!live) return d
  const model = d.prediction?.model
  return {
    ...d,
    prediction: d.prediction ? { ...d.prediction, live } : d.prediction,
    predictions: d.predictions?.map(x => (x.model === model ? { ...x, live } : x))
  }
}

/** While the match is played: win chance now vs before kick-off. */
function LiveChance({ p, home, away, paused }: { p: Prediction; home: Team; away: Team; paused: boolean }) {
  const l = p.live!
  const cap = (v: number) => Math.min(99, Math.max(1, Math.round(v)))
  const rows = [
    { k: 'H' as const, label: home.shortName || home.name, now: l.home, before: p.home, bar: 'bg-home' },
    { k: 'D' as const, label: tt("Draw"), now: l.draw, before: p.draw, bar: 'bg-draw' },
    { k: 'A' as const, label: away.shortName || away.name, now: l.away, before: p.away, bar: 'bg-away' }
  ]
  const top = [...rows].sort((a, b) => b.now - a.now)[0]
  return (
    <div className="mt-4 rounded-2xl border border-live/40 bg-live/[0.06] p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-live animate-pulseDot" aria-hidden />
          <span className="text-sm font-bold text-ink">{tt("Live win chance")}</span>
        </div>
        <span className="num text-xs font-semibold text-live">
          {paused ? tt("HT") : `${Math.min(90, l.minute)}'${l.minute > 90 ? '+' : ''}`} · {l.score[0]}-{l.score[1]}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3">
        {rows.map(r => {
          const diff = Math.round(r.now) - Math.round(r.before)
          return (
            <div key={r.k} className={`rounded-xl px-2 py-2 text-center ${r.k === top.k ? 'bg-surface border border-line' : ''}`}>
              <div className="text-[11px] text-muted truncate">{r.label}</div>
              <div className="num text-xl sm:text-2xl font-extrabold text-ink">{cap(r.now)}%</div>
              <div className={`num text-[11px] font-semibold ${diff > 0 ? 'text-win' : diff < 0 ? 'text-loss' : 'text-faint'}`}>
                {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {Math.abs(diff)} <span className="text-faint font-normal">· {tt("was {0}%", { 0: Math.round(r.before) })}</span>
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex h-2 gap-[3px] mt-3" aria-hidden>
        {rows.map(r => <div key={r.k} className={`rounded-full ${r.bar} transition-all duration-700`} style={{ width: `calc(${Math.max(1, r.now)}% - 3px)` }} />)}
      </div>
      <p className="text-[11px] text-faint mt-2">
        {tt("Updated every minute from our pre-match prediction, the score, the time left and red cards.")}
        {(l.reds[0] > 0 || l.reds[1] > 0) && ` ${tt("Red cards: {0} – {1}.", { 0: l.reds[0], 1: l.reds[1] })}`}
      </p>
    </div>
  )
}

function LineupUpdateCover({ before, home, away, onReveal }: { before: NonNullable<Prediction['beforeLineups']>; home: Team; away: Team; onReveal: () => void }) {
  const hn = home.shortName || home.name, an = away.shortName || away.name
  return (
    <div className="relative overflow-hidden rounded-2xl border border-accent/40 bg-[linear-gradient(150deg,rgb(var(--accent)/0.12),rgb(var(--surface)/0.6))] p-5 sm:p-6 text-center space-y-4">
      <div className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-wider text-accent">
        <span className="w-2 h-2 rounded-full bg-accent animate-pulseDot" /> {tt("Lineups are out")}</div>
      <div className="font-display text-xl sm:text-2xl font-extrabold text-ink">{tt("Our analysis is updated with the starting 11")}</div>
      <p className="text-sm text-muted max-w-md mx-auto">
        {tt("The teams have published their lineups and we have recalculated the prediction with the players who actually start.")}</p>
      <div className="text-xs text-faint num">
        {tt("Before the lineups:")}{' '}{hn} {Math.round(before.home)}{tt("% · Draw")}{' '}{Math.round(before.draw)}% · {an} {Math.round(before.away)}%
      </div>
      <button
        type="button"
        onClick={onReveal}
        className="inline-flex items-center gap-2 h-12 px-6 rounded-2xl bg-accent text-bg font-extrabold shadow-lift hover:brightness-105"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        {tt("Reveal the updated analysis")}</button>
    </div>
  )
}

/** After the reveal: how the lineups moved the numbers. */
function LineupChange({ p, home, away }: { p: Prediction; home: Team; away: Team }) {
  const b = p.beforeLineups!
  const hn = home.shortName || home.name, an = away.shortName || away.name
  const items: [string, number, number][] = [[hn, b.home, p.home], ['Draw', b.draw, p.draw], [an, b.away, p.away]]
  const moved = items.some(([, x, y]) => Math.abs(y - x) >= 1)
  const d = (x: number, y: number) => { const v = Math.round((y - x) * 10) / 10; return v === 0 ? '±0' : `${v > 0 ? '+' : ''}${v}` }
  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-3 sm:p-4">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-accent">{tt("Updated with the confirmed lineups")}</div>
      {moved ? (
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          {items.map(([label, x, y]) => (
            <div key={label} className="rounded-lg bg-surface2/60 py-2">
              <div className="text-[11px] text-faint truncate px-1">{label}</div>
              <div className="num text-sm text-ink"><span className="text-faint">{Math.round(x)}%</span> → <b>{Math.round(y)}%</b></div>
              <div className={`num text-[11px] font-bold ${y - x >= 1 ? 'text-win' : y - x <= -1 ? 'text-loss' : 'text-faint'}`}>{d(x, y)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted">{tt("The starting 11s are as expected: the prediction hardly moved.")}</p>
      )}
    </div>
  )
}

/**
 * Upcoming matches: lineups come out about 1 hour before kick-off, and for league matches (v3) the prediction is
 * recalculated with the confirmed starting 11. Tell people to come back then.
 */
function LineupTip({ kickoff, lineupsOut, usesLineups }: { kickoff: number; lineupsOut: boolean; usesLineups: boolean }) {
  const checkAt = kickoff ? fmtTime(new Date(kickoff - 60 * 60 * 1000).toISOString()) : null
  const soon = kickoff > 0 && kickoff - Date.now() <= 75 * 60 * 1000
  let title: string
  let text: string
  if (lineupsOut) {
    title = tt("Lineups are out")
    text = usesLineups
      ? tt("This prediction is updated with the confirmed starting 11 within a few minutes of the lineups being published. Refresh the page to see the latest numbers.")
      : tt("Check the starting 11 below before you decide: a missing key player can change the picture.")
  } else {
    title = tt("Check again 1 hour before kick-off")
    text = usesLineups
      ? tt("We recommend coming back to this match about 1 hour before kick-off{0}. That’s when the teams publish their lineups, and we recalculate the prediction with the players who actually start.", { 0: soon || !checkAt ? '' : ` (around ${checkAt})` })
      : tt("We recommend checking this match again about 1 hour before kick-off{0}, when the teams publish their lineups. A missing key player can change the picture.", { 0: soon || !checkAt ? '' : ` (around ${checkAt})` })
  }
  return (
    <div className="mt-4 flex gap-3 rounded-xl border border-home/40 bg-home/10 p-3">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-home flex-shrink-0 mt-0.5" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      <div className="text-sm">
        <div className="font-semibold text-ink">{title}</div>
        <div className="text-muted mt-0.5">{text}</div>
      </div>
    </div>
  )
}

function CompLink({ name }: { name: string }) {
  const code = useContext(CompCode)
  return <NameLink to={hrefOf.league(code)}>{name}</NameLink>
}

function Section({ title, note, id, children }: { title: string; note?: ReactNode; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="card p-5 sm:p-6 scroll-mt-32">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-display text-base font-bold text-ink">{title}</h2>
        {note && <span className="text-xs text-faint">{note}</span>}
      </div>
      {children}
    </section>
  )
}

/** Free / signed-out view: the pick and confidence; percentages, value and the breakdown are Premium. */

/**
 * "Match preview" (fix121): the same English text search engines get (no pick, no %). Open on wider screens,
 * folded on phones (tap to open). English pages only for now.
 */
function MatchPreview({ text }: { text: string }) {
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches)
  return (
    <details open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group mt-4 card px-4 sm:px-5 py-3">
      <summary className="flex items-center justify-between gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <h2 className="font-display text-base font-bold text-ink">Match preview</h2>
        <svg viewBox="0 0 24 24" className="w-4 h-4 text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <p className="mt-2 text-sm text-muted leading-relaxed">{text}</p>
    </details>
  )
}

function LockedPrediction({ pick, dc, home, away, matchId, status, autoUnlock = false, onUnlocked }: {
  pick: 'H' | 'D' | 'A' | null; dc: DC | null; home: Team; away: Team; matchId: number; status: string; autoUnlock?: boolean; onUnlocked: () => void
}) {
  const name = pick === 'H' ? home.shortName || home.name : pick === 'A' ? away.shortName || away.name : pick === 'D' ? 'Draw' : null
  const color = pick === 'H' ? 'text-home' : pick === 'D' ? 'text-draw' : 'text-away'
  const tiles: { k: 'H' | 'D' | 'A'; label: string }[] = [
    { k: 'H', label: home.shortName || home.name },
    { k: 'D', label: tt('Draw') },
    { k: 'A', label: away.shortName || away.name }
  ]
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 text-sm mb-4">
        <span className="px-2.5 py-1 rounded-full text-xs font-bold border bg-surface2 text-ink border-line">{dc ? tt("Our pick") : tt("Model pick")}</span>
        {dc ? (
          <span className="inline-flex items-center gap-2 min-w-0"><span className="font-display font-bold text-lg text-ink truncate">{dcLabel(dc, shortTeam(home), shortTeam(away))}</span></span>
        ) : name ? (
          <span className={`font-display font-bold text-lg ${color}`}>{name}</span>
        ) : (
          <span className="font-display font-bold text-lg text-muted">{tt("Locked")}</span>
        )}
      </div>
      <div className="relative min-h-[190px]">
        <div className="grid grid-cols-3 gap-3 pt-6 select-none blur-[5px] opacity-60" aria-hidden>
          {tiles.map(t => (
            <OutcomeTile key={t.k} k={t.k} label={t.label} v={33.3} dimOut={false} />
          ))}
        </div>
        <div className="absolute inset-0 grid place-items-center">
          <UnlockPrompt rid={matchId} status={status} autoUnlock={autoUnlock} onUnlocked={onUnlocked}
            what={tt("The full prediction, why this pick, goals and the v3 breakdown.")}
            premiumWhat={tt("The pick, win / draw / loss %, why this pick in plain words, goals, draw picks and the full v3 breakdown.")} />
        </div>
      </div>
    </div>
  )
}

/** One of the 1 · X · 2 cards: `top` = the most likely result (filled), `inPick` = inside our double chance (lime
 *  outline); a result outside our pick is dimmed (fix128). */
function OutcomeTile({ k, label, v, top = false, inPick = false, dimOut = true, roll = false, delay = 0 }: { k: 'H' | 'D' | 'A'; label: string; v: number; top?: boolean; inPick?: boolean; dimOut?: boolean; roll?: boolean; delay?: number }) {
  const color = k === 'H' ? 'text-home' : k === 'D' ? 'text-draw' : 'text-away'
  const fill = k === 'H' ? 'bg-home/15' : k === 'D' ? 'bg-draw/15' : 'bg-away/15'
  return (
    <div className={`rounded-xl p-3 sm:p-4 text-center transition-opacity ${inPick ? 'border-2 border-accent/80' : 'border border-line/70'} ${top ? fill : 'bg-surface2/40'} ${!inPick && dimOut ? 'opacity-50' : ''} ${roll && inPick ? 'animate-pop' : ''}`}>
      <div className="text-[11px] text-faint mb-1 truncate">
        <span className={`font-bold mr-1 ${inPick ? 'text-accent' : ''}`}>{k === 'H' ? '1' : k === 'D' ? 'X' : '2'}</span>
        {label}
      </div>
      <div className={`num text-2xl sm:text-3xl font-extrabold ${top ? color : 'text-ink/80'}`}><CountUp value={v} decimals={1} suffix="%" animate={roll} delay={delay} /></div>
    </div>
  )
}

/**
 * Goals and scores: total-goals lines (over 1.5 / 2.5 / 3.5 / 4.5) and the most likely correct scores.
 * Worked out from the model's expected goals (a Poisson score grid, the same method the models use); where the model
 * sends its own figure (over 2.5, BTTS, its top scores) that figure is used, so the page never shows two numbers
 * for the same thing.
 */
function scoreGrid(lh: number, la: number) {
  const pois = (l: number, k: number) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return (Math.exp(-l) * Math.pow(l, k)) / f }
  const cells: { home: number; away: number; prob: number }[] = []
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) cells.push({ home: i, away: j, prob: pois(lh, i) * pois(la, j) * 100 })
  return cells
}

function GoalsPanel({ p, home, away, roll }: { p: Prediction; home: Team; away: Team; roll: boolean }) {
  const cells = scoreGrid(p.expectedGoals.home, p.expectedGoals.away)
  const over = (line: number) => cells.filter(c => c.home + c.away > line).reduce((a, c) => a + c.prob, 0)
  // keep the model's own over 2.5, and keep the lines in order (1.5 ≥ 2.5 ≥ 3.5 ≥ 4.5)
  const o25 = p.over25
  const o15 = Math.max(over(1.5), o25), o35 = Math.min(over(3.5), o25), o45 = Math.min(over(4.5), o35)
  const lines = [{ l: '1.5', v: o15 }, { l: '2.5', v: o25 }, { l: '3.5', v: o35 }, { l: '4.5', v: o45 }]
  const own = new Map(p.topScores.map(t => [`${t.home}-${t.away}`, t.prob]))
  const scores = cells.map(c => ({ ...c, prob: own.get(`${c.home}-${c.away}`) ?? c.prob })).sort((a, b) => b.prob - a.prob).slice(0, 8)
  const hn = home.shortName || home.name, an = away.shortName || away.name
  return (
    <div className="mt-5 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <Stat label={tt("Expected goals")} value={`${p.expectedGoals.home} – ${p.expectedGoals.away}`} />
        <Stat label={tt("Both teams score")} value={`${Math.round(p.btts)}%`} />
        <Stat label={tt("Most likely score")} value={scores[0] ? `${scores[0].home}–${scores[0].away}` : '–'} sub={scores[0] ? `${Math.round(scores[0].prob)}%` : undefined} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-line/70 bg-surface2/40 p-4">
          <div className="label mb-3">{tt("Total goals")}</div>
          <div className="space-y-2.5">
            {lines.map((x, i) => (
              <div key={x.l} className="grid grid-cols-[74px_1fr_44px] items-center gap-3 text-sm">
                <span className="text-muted">{tt("Over")}{' '}{x.l}</span>
                <span className="h-2 rounded-full bg-surface2 overflow-hidden">
                  <span className="block h-full rounded-full bg-accent transition-[width] duration-1000 ease-out" style={{ width: `${Math.round(x.v)}%`, transitionDelay: `${i * 90}ms` }} />
                </span>
                <span className="num font-bold text-ink text-right"><CountUp value={x.v} suffix="%" animate={roll} delay={300 + i * 90} /></span>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[11px] text-faint">{tt("Under = 100% minus over. Under 2.5:")}{' '}<span className="num text-muted">{Math.round(100 - o25)}%</span></div>
        </div>
        <div className="rounded-xl border border-line/70 bg-surface2/40 p-4">
          <div className="label mb-3">{tt("Correct score")}</div>
          <div className="grid grid-cols-4 gap-2">
            {scores.map((c, i) => (
              <div key={`${c.home}-${c.away}`} className={`rounded-lg px-2 py-2 text-center ${i === 0 ? 'bg-accent/15 border border-accent/40' : 'bg-surface2/70'}`}>
                <div className={`num font-bold ${i === 0 ? 'text-accent' : 'text-ink'}`}>{c.home}–{c.away}</div>
                <div className="num text-[11px] text-muted"><CountUp value={c.prob} decimals={1} suffix="%" animate={roll} delay={400 + i * 60} /></div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[11px] text-faint">{tt("{0} first · {1} second", { 0: hn, 1: an })}</div>
        </div>
      </div>
      {(() => {
        // who scores first: the first goal goes to each side in proportion to its expected goals
        const lh = Math.max(0.01, p.expectedGoals.home), la = Math.max(0.01, p.expectedGoals.away), lam = lh + la
        const none = Math.exp(-lam) * 100
        const fh = (lh / lam) * (100 - none), fa = (la / lam) * (100 - none)
        return (
          <div className="rounded-xl border border-line/70 bg-surface2/40 p-4">
            <div className="label mb-3">{tt("Who scores first")}</div>
            <div className="flex h-2.5 gap-[3px] rounded-full overflow-hidden" aria-hidden>
              <div className="bg-home" style={{ width: `${fh}%` }} />
              <div className="bg-faint/50" style={{ width: `${none}%` }} />
              <div className="bg-away" style={{ width: `${fa}%` }} />
            </div>
            <div className="mt-2 grid grid-cols-3 text-sm">
              <span><span className="text-muted">{hn}</span> <b className="num text-ink">{Math.round(fh)}%</b></span>
              <span className="text-center"><span className="text-muted">{tt("No goal")}</span> <b className="num text-ink">{Math.round(none)}%</b></span>
              <span className="text-right"><span className="text-muted">{an}</span> <b className="num text-ink">{Math.round(fa)}%</b></span>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl bg-surface2/60 border border-line/50 px-3 py-2.5 text-center">
      <div className="num text-lg font-bold text-ink">
        {value}
        {sub && <span className="text-xs text-faint font-medium ml-1">{sub}</span>}
      </div>
      <div className="text-[11px] text-faint">{label}</div>
    </div>
  )
}

function EventText({ e, align }: { e: { kind: string; text: string; sub?: string; href?: string | null }; align: 'left' | 'right' }) {
  return (
    <div className={`flex items-center gap-2 ${align === 'right' ? 'justify-end' : ''}`}>
      {align === 'left' && <EventIcon kind={e.kind} />}
      <span className="min-w-0">
        <NameLink to={e.href} className="text-ink font-medium">{e.text}</NameLink>
        {e.sub && <span className="block text-[11px] text-faint">{e.sub}</span>}
      </span>
      {align === 'right' && <EventIcon kind={e.kind} />}
    </div>
  )
}

function EventIcon({ kind }: { kind: string }) {
  if (kind === 'goal' || kind === 'pen' || kind === 'own')
    return <span className={`text-base leading-none ${kind === 'own' ? 'opacity-50' : ''}`}>⚽</span>
  if (kind === 'yellow') return <span className="inline-block w-3 h-4 rounded-[2px] bg-draw" />
  if (kind === 'red') return <span className="inline-block w-3 h-4 rounded-[2px] bg-live" />
  if (kind === 'yellow_red') return <span className="inline-block w-3 h-4 rounded-[2px] bg-gradient-to-b from-draw to-live" />
  return <span className="text-faint text-sm">⇄</span>
}

/* ---------- shared look of the match tabs (same style as the basketball game page) ---------- */

type SideK = 'H' | 'A'
const SIDE_TEXT = { H: 'text-home', A: 'text-away' } as const
const SIDE_BG = { H: 'bg-home', A: 'bg-away' } as const
const tname = (t: Team) => t.shortName || t.name

function CrestBox({ team, size = 30 }: { team: { name: string; crest?: string; tla?: string }; size?: number }) {
  return (
    <span className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-surface2/80 border border-line/60 grid place-items-center shrink-0">
      {team.crest ? <img src={team.crest} alt="" className="object-contain" style={{ width: size, height: size }} /> : <span className="text-[10px] font-bold text-muted">{(team.tla || team.name).slice(0, 3).toUpperCase()}</span>}
    </span>
  )
}

function SideTitle({ team, side, right }: { team: Team; side: SideK; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className={`w-1 h-6 rounded-full ${SIDE_BG[side]}`} />
      {team.crest && <img src={team.crest} alt="" className="w-6 h-6 object-contain" />}
      <TeamName team={team} className="font-display font-bold text-ink truncate" />
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  )
}

const FORM_CLS: Record<string, string> = { W: 'bg-win/90 text-bg', D: 'bg-muted/60 text-bg', L: 'bg-loss/90 text-bg' }
function FormChips({ f, align = 'left' }: { f: string[]; align?: 'left' | 'right' }) {
  if (!f.length) return null
  return (
    <span className={`flex gap-1 mt-1 justify-center ${align === 'right' ? 'sm:justify-end' : 'sm:justify-start'}`}>
      {f.map((r, i) => (
        <span key={i} className={`w-[18px] h-[18px] rounded-[5px] text-[9px] font-extrabold grid place-items-center ${FORM_CLS[r] || 'bg-line text-muted'} ${i === f.length - 1 ? 'ring-2 ring-offset-1 ring-offset-surface ring-line' : ''}`}>{r}</span>
      ))}
    </span>
  )
}

function TeamsHead({ home, away, sub }: { home: Team; away: Team; sub?: (s: SideK) => ReactNode }) {
  const side = (s: SideK) => {
    const team = s === 'H' ? home : away
    return (
      <div className={`flex flex-col sm:flex-row items-center gap-2 sm:gap-3 min-w-0 text-center ${s === 'A' ? 'sm:flex-row-reverse sm:text-right' : 'sm:text-left'}`}>
        <CrestBox team={team} />
        <span className="min-w-0 max-w-full">
          <TeamName team={team} className="block font-display font-bold text-ink truncate" />
          {sub && <span className="block">{sub(s)}</span>}
        </span>
      </div>
    )
  }
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      {side('H')}
      <span className="text-[10px] font-extrabold tracking-widest text-faint">VS</span>
      {side('A')}
    </div>
  )
}

type Tone = 'good' | 'mid' | 'bad' | 'none'
const TONE: Record<Tone, string> = {
  good: 'border-win/40 bg-win/10 text-win',
  mid: 'border-draw/40 bg-draw/10 text-draw',
  bad: 'border-loss/40 bg-loss/10 text-loss',
  none: 'border-line/60 bg-surface2/50 text-ink'
}
function ToneTile({ label, value, tone, icon }: { label: string; value: ReactNode; tone: Tone; icon?: ReactNode }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${TONE[tone]}`}>
      <div className="flex items-start gap-1.5 opacity-80">{icon && <span className="hidden sm:inline mt-px">{icon}</span>}<span className="text-[10px] font-semibold uppercase sm:tracking-wide leading-tight">{label}</span></div>
      <div className="num text-xl font-extrabold mt-1 leading-none">{value}</div>
    </div>
  )
}
const ICO = {
  bed: <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5" /><circle cx="7" cy="11" r="1.6" /></svg>,
  cal: <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  next: <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  clock: <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></svg>
}
const RES_CLS: Record<string, string> = { W: 'bg-win/15 text-win', D: 'bg-surface2 text-muted', L: 'bg-loss/15 text-loss' }

function TeamPanel({ team, side, row, recent }: { team: Team; side: SideK; row: StandingRow | null; recent: Match[] }) {
  const formFromTable = row?.form ? row.form.split(',').map(s => s.trim()).filter(Boolean) : null
  const formFromMatches = recent.map(m => resultFor(team.id, m)).filter((r): r is 'W' | 'D' | 'L' => !!r).reverse()
  const form = formFromTable && formFromTable.length ? formFromTable : formFromMatches
  return (
    <div className="min-w-0">
      <SideTitle team={team} side={side} right={row ? <span className={`num text-xs font-bold ${SIDE_TEXT[side]}`}>#{row.position}{row.teamsInTable ? <span className="text-faint font-medium"> / {row.teamsInTable}</span> : null}</span> : undefined} />
      {row ? (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <ToneTile label={tt("Points")} value={row.points} tone="none" />
          <ToneTile label="W-D-L" value={<span className="text-base">{row.won}-{row.draw}-{row.lost}</span>} tone="none" />
          <ToneTile label={tt("GD")} value={`${row.goalDifference > 0 ? '+' : ''}${row.goalDifference}`} tone={row.goalDifference > 0 ? 'good' : row.goalDifference < 0 ? 'bad' : 'none'} />
        </div>
      ) : (
        <p className="text-xs text-faint mb-3">{tt("No league table for this competition.")}</p>
      )}
      {form.length > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">{tt("Form")}</span>
          <FormChips f={form} />
        </div>
      )}
      {recent.length > 0 && (
        <ul>
          {recent.map(m => {
            const isHome = m.homeTeam.id === team.id
            const opp = isHome ? m.awayTeam : m.homeTeam
            const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away
            const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home
            const r = resultFor(team.id, m)
            return (
              <li key={m.id}>
                <RowLink to={hrefOf.match(m.id)} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs">
                  <span className={`w-6 h-6 rounded-md grid place-items-center text-[10px] font-extrabold shrink-0 ${r ? RES_CLS[r] : 'bg-surface2 text-faint'}`}>{r || '–'}</span>
                  <NameLink to={hrefOf.match(m.id)} className="num text-faint w-14 shrink-0 whitespace-nowrap">{new Date(m.utcDate).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</NameLink>
                  <span className={`rounded px-1 text-[9px] font-bold shrink-0 ${isHome ? 'bg-home/15 text-home' : 'bg-surface2 text-muted'}`}>{isHome ? tt("H") : tt("A")}</span>
                  {opp.crest ? <img src={opp.crest} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" /> : <span className="w-4 h-4 shrink-0" />}
                  <TeamName team={opp} className="text-ink font-medium truncate" />
                  <NameLink to={hrefOf.match(m.id)} className="ml-auto num font-bold text-ink shrink-0">{gf}–{ga}</NameLink>
                </RowLink>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

type H2HData = NonNullable<Details['head2head']>

function H2H({ h2h, home, away }: { h2h: H2HData; home: Team; away: Team }) {
  const agg = h2h.aggregates
  const total = agg.numberOfMatches || 1
  const hw = agg.homeTeam.wins
  const d = agg.homeTeam.draws
  const aw = agg.awayTeam.wins
  const played = h2h.matches.filter(h => DONE.has(h.status))
  // results are shown from this page's home team's side (they may have been the away side back then)
  const isHomeSide = (id: number, name: string) => id === agg.homeTeam.id || id === home.id || name === home.name || name === home.shortName
  const lead: SideK | null = hw === aw ? null : hw > aw ? 'H' : 'A'
  return (
    <>
      <div className="rounded-2xl border border-line/60 bg-surface2/40 p-4 sm:p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          {(['H', 'A'] as const).map((s, i) => {
            const team = s === 'H' ? home : away
            return (
              <div key={s} className={`flex flex-col sm:flex-row items-center gap-2 sm:gap-3 min-w-0 text-center ${i === 1 ? 'order-3 sm:flex-row-reverse sm:text-right' : 'sm:text-left'}`}>
                <CrestBox team={team} />
                <span className="min-w-0 max-w-full">
                  <TeamName team={team} className="block font-display font-bold text-ink truncate" />
                  <span className="block text-[11px] text-faint">{tt("{0} wins", { 0: s === 'H' ? hw : aw })}</span>
                </span>
              </div>
            )
          })}
          <div className="order-2 text-center">
            <div className="num font-display text-3xl sm:text-4xl font-extrabold leading-none whitespace-nowrap">
              <span className={lead !== 'A' ? SIDE_TEXT.H : 'text-muted'}>{hw}</span>
              <span className="text-faint text-xl sm:text-2xl mx-1.5 align-middle">{d}</span>
              <span className={lead !== 'H' ? SIDE_TEXT.A : 'text-muted'}>{aw}</span>
            </div>
            <div className="text-[10px] text-faint mt-1 uppercase tracking-wide">{tt("wins · draws · wins")}</div>
          </div>
        </div>
        <div className="flex h-2 gap-[3px] mt-4">
          <div className="rounded-full bg-home" style={{ width: `${(hw / total) * 100}%` }} />
          <div className="rounded-full bg-muted/50" style={{ width: `${(d / total) * 100}%` }} />
          <div className="rounded-full bg-away" style={{ width: `${(aw / total) * 100}%` }} />
        </div>
        <div className="mt-2 text-center text-[11px] text-faint num">
          {tt("{0} goals in {1} games · {2} per game", { 0: agg.totalGoals, 1: agg.numberOfMatches, 2: (agg.totalGoals / total).toFixed(1) })}
        </div>
      </div>
      <ul className="mt-4 divide-y divide-line/40">
        {played.map(h => {
          const hg = h.score.fullTime.home ?? 0
          const ag = h.score.fullTime.away ?? 0
          const ourHomeWasHome = isHomeSide(h.homeTeam.id, h.homeTeam.name)
          const ours = ourHomeWasHome ? hg - ag : ag - hg
          const dot = ours > 0 ? 'bg-home' : ours < 0 ? 'bg-away' : 'bg-muted/50'
          return (
            <li key={h.id}>
              <RowLink to={hrefOf.match(h.id)} className="grid grid-cols-[3.5rem_1fr_auto_1fr_0.75rem] sm:grid-cols-[6rem_1fr_auto_1fr_1rem] items-center gap-2 sm:gap-3 py-2 px-1 text-sm rounded-lg">
                <span className="text-[11px] text-faint leading-tight min-w-0">
                  <NameLink to={hrefOf.match(h.id)} className="num block whitespace-nowrap">{new Date(h.utcDate).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: '2-digit' })}</NameLink>
                  <NameLink to={hrefOf.league(h.competition?.code)} className="hidden sm:block text-[10px] truncate">{h.competition?.name}</NameLink>
                </span>
                <span className="flex items-center justify-end gap-2 min-w-0">
                  <TeamName team={h.homeTeam} className={`truncate ${hg > ag ? 'font-bold text-ink' : 'text-muted'}`} />
                  {h.homeTeam.crest && <img src={h.homeTeam.crest} alt="" className="w-[18px] h-[18px] object-contain shrink-0" loading="lazy" />}
                </span>
                <NameLink to={hrefOf.match(h.id)} className="num font-extrabold text-ink rounded-lg bg-surface2/80 px-2.5 py-1 text-center min-w-[56px]">
                  <span className={hg >= ag ? '' : 'text-muted'}>{hg}</span><span className="text-faint">–</span><span className={ag >= hg ? '' : 'text-muted'}>{ag}</span>
                </NameLink>
                <span className="flex items-center gap-2 min-w-0">
                  {h.awayTeam.crest && <img src={h.awayTeam.crest} alt="" className="w-[18px] h-[18px] object-contain shrink-0" loading="lazy" />}
                  <TeamName team={h.awayTeam} className={`truncate ${ag > hg ? 'font-bold text-ink' : 'text-muted'}`} />
                </span>
                <span className={`justify-self-end w-2 h-2 rounded-full ${dot}`} />
              </RowLink>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/* ---------- averages over the last 10 games ---------- */

interface TeamAvg {
  games: number
  withStats: number
  record: { won: number; draw: number; lost: number }
  goalsFor: number
  goalsAgainst: number
  totalGoals: number
  cleanSheets: number
  btts: number
  over25: number
  averages: Record<string, number>
}

interface Injury { id: number | null; name: string; out: boolean; reason: string | null; importance?: number | null; importanceLabel?: string | null; starts?: number | null; of?: number | null }
interface Fixture1 { matchId?: number | null; date: string; days: number; home: boolean; opponent: string; opponentCrest: string | null; opponentId?: number | null; competition: string | null; competitionCode?: string | null; score: string | null }
interface TeamSchedule { previous: Fixture1 | null; next: Fixture1 | null; games14: number; games30: number | null; away30: number | null; recent: Fixture1[]; upcoming: Fixture1[] }
const IMP_TONE: Record<number, string> = { 5: 'text-loss', 4: 'text-draw', 3: 'text-ink', 2: 'text-muted', 1: 'text-faint' }
const IMP_BAR: Record<number, string> = { 5: 'bg-loss', 4: 'bg-draw', 3: 'bg-ink/70', 2: 'bg-muted/70', 1: 'bg-faint/70' }
/** Importance 1–5 as five small bars plus a word. */
function Importance({ x }: { x: Injury }) {
  if (!x.importance) return <span className="text-[11px] text-faint">{tt("Importance unknown")}</span>
  const lvl = x.importance
  const why = x.starts != null && x.of ? tt("Started {0} of the last {1} games", { 0: x.starts, 1: x.of }) : undefined
  return (
    <span className="inline-flex items-center gap-1.5" title={why}>
      <span className="inline-flex items-end gap-[2px]" aria-hidden>
        {[1, 2, 3, 4, 5].map(i => <span key={i} className={`w-[4px] rounded-sm ${i <= lvl ? IMP_BAR[lvl] : 'bg-line'}`} style={{ height: `${4 + i * 2}px` }} />)}
      </span>
      <span className={`text-[11px] font-semibold ${IMP_TONE[lvl]}`}>{lvl}/5 · {tt(x.importanceLabel || '')}</span>
    </span>
  )
}

function InjuryList({ team, list }: { team: Team; list: Injury[] }) {
  const key = list.filter(x => x.out && (x.importance ?? 0) >= 4).length
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        {team.crest && <img src={team.crest} alt="" className="w-6 h-6 object-contain" />}
        <TeamName team={team} short className="font-display font-bold text-ink" />
        <span className="ml-auto num text-xs text-faint">{list.filter(x => x.out).length} {tt("out")} · {list.filter(x => !x.out).length} {tt("doubtful")}</span>
      </div>
      {list.length > 0 && (
        <p className={`text-xs mb-3 ${key ? 'text-loss font-semibold' : 'text-faint'}`}>
          {key ? (key === 1 ? tt("1 key or important player out") : tt("{0} key or important players out", { 0: key })) : tt("No key players out")}
        </p>
      )}
      {list.length ? (
        <ul className="divide-y divide-line/40">
          {list.map((x, i) => (
            <li key={x.id ?? i} className="flex items-center gap-3 py-2 text-sm">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${x.out ? 'bg-loss' : 'bg-draw'}`} />
              <span className="min-w-0 flex-1">
                {x.id ? <Link to={`/player/${x.id}`} className="block text-ink hover:text-accent truncate font-medium">{x.name}</Link> : <span className="block text-ink truncate font-medium">{x.name}</span>}
                <span className="block text-[11px] text-faint truncate">{x.out ? tt("Out") : tt("Doubtful")}{x.reason ? ` · ${x.reason}` : ''}</span>
              </span>
              <span className="shrink-0"><Importance x={x} /></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">{tt("Nobody listed.")}</p>
      )}
    </div>
  )
}

const daysText = (d: number) => (d < 1 ? tt("under a day") : tt("{0} days", { 0: Math.floor(d) }))

/** Both teams' rest and workload, in a short banner. */
function RestSummary({ home, away, h, a }: { home: Team; away: Team; h: TeamSchedule; a: TeamSchedule }) {
  const lines: ReactNode[] = []
  const hr = h.previous?.days, ar = a.previous?.days
  if (hr != null && ar != null) {
    const diff = Math.floor(hr) - Math.floor(ar)
    if (Math.abs(diff) >= 2) {
      const s: SideK = diff > 0 ? 'H' : 'A'
      lines.push(<><b className={SIDE_TEXT[s]}><TeamName team={s === 'H' ? home : away} /></b> {tt("has {0} more days of rest.", { 0: Math.abs(diff) })}</>)
    } else lines.push(tt("Similar rest for both teams."))
  }
  for (const [t, s] of [[home, h], [away, a]] as const) {
    if (s.games14 >= 4) lines.push(tNodes("{0} played {1} games in the last 14 days.", { 0: <TeamName team={t} />, 1: s.games14 }))
    if (s.next && s.next.days <= 4) lines.push(tNodes("{0} plays again {1} later ({2}).", { 0: <TeamName team={t} />, 1: daysText(s.next.days), 2: <NameLink to={hrefOf.league(s.next.competitionCode)}>{s.next.competition || ''}</NameLink> }))
  }
  if (!lines.length) return null
  return (
    <div className="flex items-start gap-3 rounded-xl border border-accent/25 bg-accent/[0.07] px-4 py-3 text-sm text-ink">
      <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent grid place-items-center shrink-0">{ICO.bed}</span>
      <div className="space-y-0.5 pt-1.5 min-w-0">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>
    </div>
  )
}

function RestPanel({ team, side, s }: { team: Team; side: SideK; s: TeamSchedule }) {
  const rest = s.previous?.days
  const restTone: Tone = rest == null ? 'none' : rest < 3 ? 'bad' : rest < 4 ? 'mid' : 'good'
  const loadTone: Tone = s.games14 >= 5 ? 'bad' : s.games14 === 4 ? 'mid' : 'none'
  const nextTone: Tone = !s.next ? 'none' : s.next.days <= 3 ? 'mid' : 'none'
  const res = (f: Fixture1) => {
    if (!f.score) return null
    const [x, y] = f.score.split('-').map(Number)
    return x > y ? 'W' : x < y ? 'L' : 'D'
  }
  const date = (f: Fixture1) => new Date(f.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
  const opp = (f: Fixture1) => (
    <>
      <span className={`rounded px-1 text-[9px] font-bold shrink-0 ${f.home ? 'bg-home/15 text-home' : 'bg-surface2 text-muted'}`}>{f.home ? tt("H") : tt("A")}</span>
      {f.opponentCrest ? <img src={f.opponentCrest} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" /> : <span className="w-4 h-4 shrink-0" />}
      <span className="min-w-0 truncate">
        <NameLink to={f.opponentId ? footballTeamHref(f.opponentId, f.opponent) : null} className="text-ink font-medium">{f.opponent}</NameLink>
        {f.competition && <NameLink to={hrefOf.league(f.competitionCode)} className="hidden sm:inline text-[10px] text-faint ml-1.5">{f.competition}</NameLink>}
      </span>
    </>
  )
  return (
    <div className="min-w-0">
      <SideTitle team={team} side={side} />
      <div className="grid grid-cols-3 gap-2 mb-4">
        <ToneTile icon={ICO.bed} label={tt("Rest")} tone={restTone} value={rest == null ? '—' : rest < 1 ? '<1 d' : tt("{0} d", { 0: Math.floor(rest) })} />
        <ToneTile icon={ICO.cal} label={tt("Last 14 days")} tone={loadTone} value={s.games14} />
        <ToneTile icon={ICO.next} label={tt("Next game")} tone={nextTone} value={s.next ? tt("{0} d", { 0: Math.floor(s.next.days) }) : '—'} />
      </div>
      {s.recent.length > 0 && (
        <>
          <div className="label pb-1 px-2">{tt("Before this match")}</div>
          <ul className="mb-3">
            {s.recent.map((f, i) => {
              const r = res(f)
              return (
                <li key={i}>
                  <RowLink to={f.matchId ? hrefOf.match(f.matchId) : null} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs">
                    <span className={`w-6 h-6 rounded-md grid place-items-center text-[10px] font-extrabold shrink-0 ${r ? RES_CLS[r] : 'bg-surface2 text-faint'}`}>{r || '–'}</span>
                    <span className="num text-faint w-12 shrink-0">{date(f)}</span>
                    {opp(f)}
                    {f.score && <span className="ml-auto num font-bold text-ink shrink-0">{f.score.replace('-', '–')}</span>}
                  </RowLink>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {s.upcoming.length > 0 && (
        <>
          <div className="label pb-1 px-2">{tt("After this match")}</div>
          <ul>
            {s.upcoming.map((f, i) => (
              <li key={i}>
                <RowLink to={f.matchId ? hrefOf.match(f.matchId) : null} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs">
                  <span className="w-6 h-6 rounded-md grid place-items-center border border-dashed border-line text-faint shrink-0">{ICO.clock}</span>
                  <span className="num text-faint w-12 shrink-0">{date(f)}</span>
                  {opp(f)}
                  <span className="ml-auto rounded-full bg-surface2 px-2 py-0.5 text-[10px] font-semibold text-muted num shrink-0">+{tt("{0} d", { 0: Math.floor(f.days) })}</span>
                </RowLink>
              </li>
            ))}
          </ul>
        </>
      )}
      {s.games30 != null && <p className="mt-3 px-2 text-[11px] text-faint">{tt("{0} games in the last 30 days, {1} of them away.", { 0: s.games30, 1: s.away30 ?? 0 })}</p>}
    </div>
  )
}

interface XI {
  basedOn: number
  formation: string | null
  lineup: (Player & { starts: number; grid?: string | null })[]
}

type AvgRow = { k: string; label: string; lowerBetter?: boolean; pct?: boolean; dec?: number; neutral?: boolean }
const AVG_GROUPS: { title: string; rows: AvgRow[] }[] = [
  { title: tt("Goals"), rows: [
    { k: 'totalGoals', label: tt("Total goals"), neutral: true },
    { k: 'goalsFor', label: tt("Goals scored") },
    { k: 'goalsAgainst', label: tt("Goals conceded"), lowerBetter: true },
    { k: 'expected_goals', label: tt("Expected goals (xG)"), dec: 2 }
  ] },
  { title: tt("Attack"), rows: [
    { k: 'shots', label: tt("Total shots") },
    { k: 'shots_on_goal', label: tt("Shots on target") },
    { k: 'shots_off_goal', label: tt("Shots off target"), neutral: true },
    { k: 'corner_kicks', label: tt('Corners') }
  ] },
  { title: tt("Ball & keeper"), rows: [
    { k: 'ball_possession', label: tt('Possession'), pct: true },
    { k: 'pass_accuracy', label: tt("Pass accuracy"), pct: true },
    { k: 'saves', label: tt("Goalkeeper saves"), neutral: true }
  ] },
  { title: tt("Discipline"), rows: [
    { k: 'fouls', label: tt('Fouls'), lowerBetter: true },
    { k: 'offsides', label: tt('Offsides'), lowerBetter: true },
    { k: 'yellow_cards', label: tt("Yellow cards"), lowerBetter: true },
    { k: 'red_cards', label: tt("Red cards"), lowerBetter: true, dec: 2 }
  ] }
]

function avgValue(t: TeamAvg, k: string): number | null {
  if (k === 'totalGoals' || k === 'goalsFor' || k === 'goalsAgainst') return t.games ? t[k] : null
  const v = t.averages?.[k]
  return typeof v === 'number' ? v : null
}

interface CmpRow { label: string; hv: number; av: number; text: (v: number) => string; lowerBetter?: boolean; neutral?: boolean }

function CmpLine({ r }: { r: CmpRow }) {
  const sum = r.hv + r.av || 1
  const better: SideK | null = r.neutral || r.hv === r.av ? null : (r.lowerBetter ? r.hv < r.av : r.hv > r.av) ? 'H' : 'A'
  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={`num w-16 ${better === 'H' ? 'font-extrabold text-ink' : 'text-muted'}`}>{r.text(r.hv)}</span>
        <span className="text-[11px] font-semibold text-faint text-center truncate">{r.label}</span>
        <span className={`num w-16 text-right ${better === 'A' ? 'font-extrabold text-ink' : 'text-muted'}`}>{r.text(r.av)}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <div className="h-2 rounded-full bg-surface2 overflow-hidden flex justify-end">
          <div className={`h-full rounded-full transition-all duration-700 ${better === 'H' ? 'bg-home' : 'bg-home/30'}`} style={{ width: `${(r.hv / sum) * 100}%` }} />
        </div>
        <div className="h-2 rounded-full bg-surface2 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-700 ${better === 'A' ? 'bg-away' : 'bg-away/30'}`} style={{ width: `${(r.av / sum) * 100}%` }} />
        </div>
      </div>
    </li>
  )
}

function AveragesPanel({ home, away, h, a, form }: { home: Team; away: Team; h: TeamAvg; a: TeamAvg; form?: { home: string[]; away: string[] } }) {
  const groups: { title: string; rows: CmpRow[] }[] = []
  for (const g of AVG_GROUPS) {
    const rows: CmpRow[] = []
    for (const r of g.rows) {
      const hv = avgValue(h, r.k), av = avgValue(a, r.k)
      if (hv === null || av === null) continue
      rows.push({ label: r.label, hv, av, lowerBetter: r.lowerBetter, neutral: r.neutral, text: v => (r.pct ? `${Math.round(v)}%` : r.dec ? v.toFixed(r.dec) : String(Math.round(v * 10) / 10)) })
    }
    if (rows.length) groups.push({ title: g.title, rows })
  }
  const n = Math.min(h.games, a.games)
  if (n) {
    const count = (v: number) => String(v)
    groups.push({ title: tt("Last {0} games", { 0: n }), rows: [
      { label: tt("Wins (of {0})", { 0: n }), hv: h.record.won, av: a.record.won, text: count },
      { label: tt("Clean sheets"), hv: h.cleanSheets, av: a.cleanSheets, text: count },
      { label: tt("Both teams scored"), hv: h.btts, av: a.btts, text: count, neutral: true },
      { label: tt("Over 2.5 goals"), hv: h.over25, av: a.over25, text: count, neutral: true }
    ] })
  }
  let he = 0, ae = 0
  for (const g of groups) for (const r of g.rows) {
    if (r.neutral || r.hv === r.av) continue
    if (r.lowerBetter ? r.hv < r.av : r.hv > r.av) he++; else ae++
  }
  const cats = he + ae
  const lead: SideK | null = he === ae ? null : he > ae ? 'H' : 'A'
  return (
    <div className="card p-5 sm:p-6">
      <TeamsHead home={home} away={away} sub={s => {
        const x = s === 'H' ? h : a
        const gd = Math.round((x.goalsFor - x.goalsAgainst) * 10) / 10
        return (
          <>
            <span className="block text-[11px] text-faint num">{x.record.won}-{x.record.draw}-{x.record.lost} · <span className={gd > 0 ? 'text-win' : gd < 0 ? 'text-loss' : ''}>{gd > 0 ? '+' : ''}{gd}</span> {tt("goals/game")}</span>
            {form && <FormChips f={s === 'H' ? form.home : form.away} align={s === 'A' ? 'right' : 'left'} />}
          </>
        )
      }} />
      {cats > 0 && (
        <div className="mt-5 rounded-xl border border-line/60 bg-surface2/40 px-4 py-3">
          <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
            <span className={SIDE_TEXT.H}>{he}</span>
            <span className="text-muted text-center">{lead ? tt("{0} lead {1} of {2} categories", { 0: tname(lead === 'H' ? home : away), 1: Math.max(he, ae), 2: cats }) : tt("Level: {0} categories each", { 0: he })}</span>
            <span className={SIDE_TEXT.A}>{ae}</span>
          </div>
          <div className="flex h-2 gap-[3px]">
            <div className="rounded-full bg-home" style={{ width: `${(he / cats) * 100}%` }} />
            <div className="rounded-full bg-away" style={{ width: `${(ae / cats) * 100}%` }} />
          </div>
        </div>
      )}
      <div className="mt-5 space-y-5">
        {groups.map(g => (
          <div key={g.title}>
            <div className="label pb-1">{g.title}</div>
            <ul className="divide-y divide-line/40">{g.rows.map(r => <CmpLine key={r.label} r={r} />)}</ul>
          </div>
        ))}
      </div>
      {Math.min(h.withStats, a.withStats) < Math.min(h.games, a.games) && (
        <p className="mt-4 text-[11px] text-faint">
          {tt("Goals are from all {0} games. Shots, corners and cards are averaged over the games where our data provider has detailed statistics ({1}: {2}, {3}: {4}).", { 0: Math.max(h.games, a.games), 1: tname(home), 2: h.withStats, 3: tname(away), 4: a.withStats })}
        </p>
      )}
    </div>
  )
}

/* ---------- league table with both teams marked ---------- */

interface TableRow extends StandingRow {
  team: { id: number; name: string; shortName?: string; crest?: string }
}

type TabId = 'prediction' | 'highlights' | 'stats' | 'lineups' | 'rest' | 'h2h' | 'table'
const TAB_IDS: TabId[] = ['prediction', 'highlights', 'stats', 'lineups', 'rest', 'h2h', 'table']

type StandingsTable = { type: string; group?: string | null; table: TableRow[] }

function LeagueTable({ tables: show, name, home, away }: { tables: StandingsTable[]; name: string; home: Team; away: Team }) {
  const homeId = home.id, awayId = away.id
  const find = (id: number) => {
    for (const t of show) { const r = t.table.find(x => x.team.id === id); if (r) return { r, of: t.table.length } }
    return null
  }
  const h = find(homeId), a = find(awayId)
  const card = (s: SideK, x: { r: TableRow; of: number } | null) => {
    const team = s === 'H' ? home : away
    return (
      <div className={`relative overflow-hidden rounded-2xl border border-line/60 bg-surface2/40 p-4 ${s === 'A' ? 'text-right' : ''}`}>
        <span className={`absolute top-0 ${s === 'H' ? 'left-0' : 'right-0'} w-1 h-full ${SIDE_BG[s]}`} />
        <div className={`flex items-center gap-2 ${s === 'A' ? 'flex-row-reverse' : ''}`}>
          {team.crest && <img src={team.crest} alt="" className="w-[22px] h-[22px] object-contain" />}
          <TeamName team={team} className="font-display font-bold text-ink truncate" />
        </div>
        {x ? (
          <div className={`mt-3 flex flex-wrap items-end gap-x-4 gap-y-2 ${s === 'A' ? 'flex-row-reverse' : ''}`}>
            <div>
              <div className={`num font-display text-4xl font-extrabold leading-none ${SIDE_TEXT[s]}`}>{x.r.position}<span className="text-sm text-faint font-semibold">/{x.of}</span></div>
              <div className="text-[10px] text-faint uppercase tracking-wide mt-1">{tt("Position")}</div>
            </div>
            <div>
              <div className="num text-lg font-bold text-ink leading-none">{x.r.points}</div>
              <div className="text-[10px] text-faint uppercase tracking-wide mt-1">{tt("Pts")}</div>
            </div>
            <div className="hidden sm:block">
              <div className="num text-lg font-bold text-ink leading-none">{x.r.won}-{x.r.draw}-{x.r.lost}</div>
              <div className="text-[10px] text-faint uppercase tracking-wide mt-1">W-D-L</div>
            </div>
            <div>
              <div className={`num text-lg font-bold leading-none ${x.r.goalDifference > 0 ? 'text-win' : x.r.goalDifference < 0 ? 'text-loss' : 'text-ink'}`}>{x.r.goalDifference > 0 ? '+' : ''}{x.r.goalDifference}</div>
              <div className="text-[10px] text-faint uppercase tracking-wide mt-1">{tt("GD")}</div>
            </div>
          </div>
        ) : <p className="mt-3 text-xs text-faint">{tt("Not in this table")}</p>}
      </div>
    )
  }
  const sameTable = h && a && show.some(t => t.table.some(x => x.team.id === homeId) && t.table.some(x => x.team.id === awayId))
  const gap = h && a && sameTable ? Math.abs(h.r.position - a.r.position) : 0
  const pts = h && a && sameTable ? Math.abs(h.r.points - a.r.points) : 0
  const upper: SideK | null = h && a && gap ? (h.r.position < a.r.position ? 'H' : 'A') : null
  const hasForm = show.some(t => t.table.some(r => r.form))
  return (
    <Section title={tt("Standings")} note={<CompLink name={name} />}>
      <div className="grid grid-cols-2 gap-3">
        {card('H', h)}
        {card('A', a)}
      </div>
      {upper && (
        <p className="mt-3 text-center text-xs text-muted">
          <b className={SIDE_TEXT[upper]}><TeamName team={upper === 'H' ? home : away} /></b> {gap === 1 ? tt("are one place higher") : tt("are {0} places higher", { 0: gap })}{pts ? ` · ${tt("{0} points apart", { 0: pts })}` : ''}
        </p>
      )}
      <div className="mt-5 space-y-5">
        {show.map((t, i) => (
          <div key={i}>
            {t.group && show.length > 1 && <div className="label pb-2">{t.group.replace(/_/g, ' ')}</div>}
            <table className="w-full table-fixed text-xs sm:text-sm">
              <thead>
                <tr className="text-faint text-[10px] uppercase tracking-wide">
                  <th className="text-left font-semibold py-1.5 w-9">#</th>
                  <th className="text-left font-semibold py-1.5">{tt("Team")}</th>
                  <th className="text-right font-semibold py-1.5 num w-8 sm:w-10">P</th>
                  <th className="hidden sm:table-cell text-right font-semibold py-1.5 num w-10">W</th>
                  <th className="hidden sm:table-cell text-right font-semibold py-1.5 num w-10">D</th>
                  <th className="hidden sm:table-cell text-right font-semibold py-1.5 num w-10">L</th>
                  <th className="hidden sm:table-cell text-right font-semibold py-1.5 num w-16">{tt("Goals")}</th>
                  <th className="text-right font-semibold py-1.5 num w-10 sm:w-12">{tt("GD")}</th>
                  {hasForm && <th className="hidden lg:table-cell text-center font-semibold py-1.5 w-32">{tt("Form")}</th>}
                  <th className="text-right font-semibold py-1.5 pr-2 num w-10 sm:w-12">{tt("Pts")}</th>
                </tr>
              </thead>
              <tbody>
                {t.table.map(r => {
                  const side: SideK | null = r.team.id === homeId ? 'H' : r.team.id === awayId ? 'A' : null
                  const f = r.form ? r.form.split(',').map(x => x.trim()).filter(Boolean).slice(-5) : []
                  return (
                    <tr key={r.team.id} className={`border-t border-line/40 ${side === 'H' ? 'bg-home/10' : side === 'A' ? 'bg-away/10' : 'hover:bg-surface2/40'}`}>
                      <td className="py-1.5 relative">
                        {side && <span className={`absolute left-0 inset-y-1 w-[3px] rounded-full ${SIDE_BG[side]}`} />}
                        <span className={`ml-1.5 inline-grid place-items-center w-5 h-5 rounded-md num text-[10px] font-bold ${r.position <= 4 && show.length === 1 ? 'bg-accent/15 text-accent' : 'text-faint'}`}>{r.position}</span>
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="flex items-center gap-2 min-w-0">
                          {r.team.crest ? <img src={r.team.crest} alt="" className="w-[18px] h-[18px] object-contain flex-shrink-0" /> : <span className="w-[18px] h-[18px] rounded-full bg-surface2 flex-shrink-0" />}
                          <TeamName team={r.team} short className={`truncate ${side ? 'font-bold text-ink' : 'text-ink'}`} />
                        </span>
                      </td>
                      <td className="py-1.5 text-right num text-muted">{r.playedGames}</td>
                      <td className="hidden sm:table-cell py-1.5 text-right num text-muted">{r.won}</td>
                      <td className="hidden sm:table-cell py-1.5 text-right num text-muted">{r.draw}</td>
                      <td className="hidden sm:table-cell py-1.5 text-right num text-muted">{r.lost}</td>
                      <td className="hidden sm:table-cell py-1.5 text-right num text-muted">{r.goalsFor}:{r.goalsAgainst}</td>
                      <td className={`py-1.5 text-right num font-semibold ${r.goalDifference > 0 ? 'text-win' : r.goalDifference < 0 ? 'text-loss' : 'text-muted'}`}>{r.goalDifference > 0 ? '+' : ''}{r.goalDifference}</td>
                      {hasForm && (
                        <td className="hidden lg:table-cell py-1.5">
                          <span className="flex justify-center gap-0.5">{f.map((x, j) => <span key={j} className={`w-4 h-4 rounded text-[8px] font-extrabold grid place-items-center ${FORM_CLS[x] || 'bg-line text-muted'}`}>{x}</span>)}</span>
                        </td>
                      )}
                      <td className="py-1.5 pr-2 text-right num font-extrabold text-ink">{r.points}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ---------- pitch view ---------- */

interface PitchPlayer extends Player {
  photo?: string | null
  grid?: string | null
  starts?: number // probable lineups: starts in the analysed matches
}

/** Split a lineup into rows using the formation string (e.g. "4-2-3-1"); falls back to positions. */
function formationRows(team: Team): PitchPlayer[][] {
  const lineup = (team.lineup || []) as PitchPlayer[]
  if (!lineup.length) return []
  // exact positions from the provider ("row:col", row 1 = goalkeeper) when every starter has one
  if (lineup.every(p => p.grid && /^\d+:\d+$/.test(p.grid))) {
    const byRow = new Map<number, PitchPlayer[]>()
    for (const p of lineup) {
      const [r] = p.grid!.split(':').map(Number)
      byRow.set(r, [...(byRow.get(r) || []), p])
    }
    return [...byRow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, ps]) => ps.sort((a, b) => Number(b.grid!.split(':')[1]) - Number(a.grid!.split(':')[1])))
  }
  const gkFound = lineup.filter(p => /goal/i.test(p.position || ''))
  // no goalkeeper flagged: the provider lists him first
  const gk = gkFound.length ? gkFound : lineup.slice(0, 1)
  const outfield = lineup.filter(p => !gk.includes(p))
  const counts = (team.formation || '')
    .split('-')
    .map(n => parseInt(n, 10))
    .filter(n => Number.isFinite(n) && n > 0)
  const rows: PitchPlayer[][] = [gk]
  if (counts.length && counts.reduce((a, b) => a + b, 0) === outfield.length) {
    let i = 0
    for (const c of counts) {
      rows.push(outfield.slice(i, i + c))
      i += c
    }
  } else {
    const by = (re: RegExp) => outfield.filter(p => re.test(p.position || ''))
    const d = by(/def/i)
    const mid = by(/mid/i)
    const att = by(/off|att|for/i)
    const rest = outfield.filter(p => !d.includes(p) && !mid.includes(p) && !att.includes(p))
    ;[d, [...mid, ...rest], att].forEach(r => r.length && rows.push(r))
  }
  return rows
}

/** Player page link: API-Football ids open directly; other ids are looked up by name within the team. */
function playerHref(pl: { id: number; name: string }, team: Team, code?: string) {
  if (pl.id >= 1_000_000_000) return `/player/${pl.id}`
  if (!pl.name || pl.name === '?' || pl.id < 0 && !team.id) return null
  return `/player/find?${new URLSearchParams({ name: pl.name, team: String(team.id), ...(code ? { c: code } : {}), n: team.name }).toString()}`
}

function lastName(name: string) {
  const parts = name.trim().split(/\s+/)
  return parts.length > 1 ? parts[parts.length - 1] : name
}

/** Starts in the analysed games as small pips (filled = started). */
function StartPips({ n, of }: { n: number; of: number }) {
  return (
    <span className="inline-flex gap-[2px]" aria-label={tt("started {0} of {1}", { 0: n, 1: of })}>
      {Array.from({ length: of }, (_, i) => <span key={i} className={`w-[5px] h-[5px] rounded-full ${i < n ? 'bg-accent' : 'bg-white/30'}`} />)}
    </span>
  )
}

function PitchToken({ p, side, of, href }: { p: PitchPlayer; side: 'home' | 'away'; of?: number; href?: string | null }) {
  const showStarts = typeof p.starts === 'number' && !!of
  const title = `${p.name}${p.position ? ` · ${p.position}` : ''}${showStarts ? ` · ${tt("started {0} of {1}", { 0: p.starts, 1: of })}` : ''}`
  const name = <span className="block max-w-[68px] sm:max-w-[84px] truncate rounded-md bg-black/55 px-1.5 py-[2px] text-[11px] font-semibold leading-tight text-white">{lastName(p.name)}</span>
  return (
    <div className="flex flex-col items-center gap-1 w-[70px] sm:w-[84px]" title={title}>
      <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full grid place-items-center shadow-[0_2px_6px_rgba(0,0,0,0.45)] ring-2 ring-white/85 ${side === 'home' ? 'bg-home' : 'bg-away'}`}>
        <span className="num text-sm font-extrabold text-white">{p.shirtNumber ?? ''}</span>
      </div>
      {href ? <Link to={href} className="hover:underline">{name}</Link> : name}
      {showStarts && <StartPips n={p.starts!} of={of!} />}
    </div>
  )
}

const POS_GROUPS: { k: string; label: string; re: RegExp }[] = [
  { k: 'G', label: 'Goalkeeper', re: /goal/i },
  { k: 'D', label: 'Defence', re: /def|back/i },
  { k: 'M', label: 'Midfield', re: /mid/i },
  { k: 'F', label: 'Attack', re: /off|att|for|wing|striker/i }
]

/** The XI as a list by line, under the pitch — easy to read on a phone. */
function XiList({ team, side, of, code }: { team: Team; side: 'home' | 'away'; of?: number; code?: string }) {
  const rows = formationRows(team)
  const lineup = rows.flat()
  if (!lineup.length) return null
  // lines: from the provider position, or from the pitch row (GK, then the formation lines)
  const lineOf = (pl: PitchPlayer) => {
    const g = POS_GROUPS.find(x => x.re.test(pl.position || ''))
    if (g) return g.k
    const r = rows.findIndex(row => row.includes(pl))
    return r === 0 ? 'G' : r === rows.length - 1 ? 'F' : r === 1 ? 'D' : 'M'
  }
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {team.crest && <img src={team.crest} alt="" className="w-5 h-5 object-contain" />}
        <TeamName team={team} short className="font-display font-bold text-ink" />
        {team.formation && <span className="num text-xs text-faint">{team.formation}</span>}
      </div>
      <div className="space-y-2">
        {POS_GROUPS.map(g => {
          const list = lineup.filter(pl => lineOf(pl) === g.k)
          if (!list.length) return null
          return (
            <div key={g.k}>
              <div className="text-[10px] font-bold uppercase tracking-wide text-faint mb-1">{tt(g.label)}</div>
              <ul className="space-y-1">
                {list.map(pl => {
                  const href = playerHref(pl, team, code)
                  return (
                    <li key={pl.id} className="flex items-center gap-2.5 text-sm">
                      <span className={`num w-6 h-6 rounded-full grid place-items-center text-[11px] font-bold text-white shrink-0 ${side === 'home' ? 'bg-home' : 'bg-away'}`}>{pl.shirtNumber ?? ''}</span>
                      {href ? <Link to={href} className="text-ink hover:text-accent truncate">{pl.name}</Link> : <span className="text-ink truncate">{pl.name}</span>}
                      {typeof pl.starts === 'number' && !!of && <span className="ml-auto num text-[11px] text-faint whitespace-nowrap">{tt("started {0} of {1}", { 0: pl.starts, 1: of })}</span>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Both XIs on one pitch, facing each other: across on wide screens, top-to-bottom on phones. */
function Pitch({ home, away, probable = false, code }: { home: Team; away: Team; probable?: boolean; code?: string }) {
  // a: 0..100 along the pitch (home goal → away goal), b: 0..100 across
  const place = (team: Team, isHome: boolean) => {
    const rows = formationRows(team)
    const n = rows.length
    return rows.flatMap((row, i) =>
      row.map((pl, j) => {
        const t = n <= 1 ? 0 : i / (n - 1)
        const a = isHome ? 6 + t * 38 : 94 - t * 38
        const b = ((j + 1) / (row.length + 1)) * 100
        return { pl, a, b: isHome ? b : 100 - b, team, side: (isHome ? 'home' : 'away') as 'home' | 'away' }
      })
    )
  }
  const dots = [...place(home, true), ...place(away, false)]
  const ofOf = (t: Team) => (probable ? t.basedOn : undefined)
  const head = (t: Team, side: 'home' | 'away') => (
    <div className={`flex items-center gap-2 min-w-0 ${side === 'away' ? 'flex-row-reverse text-right' : ''}`}>
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${side === 'home' ? 'bg-home' : 'bg-away'}`} />
      {t.crest && <img src={t.crest} alt="" className="w-6 h-6 object-contain shrink-0" />}
      <span className="min-w-0">
        <TeamName team={t} short className="block font-display font-bold text-ink truncate" />
        <span className="block num text-[11px] text-faint truncate">{[t.formation, t.coach?.name].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
  )
  const grass = (deg: number) => ({ background: `repeating-linear-gradient(${deg}deg, rgb(28 120 66) 0 10%, rgb(33 131 73) 10% 20%)` })
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        {head(home, 'home')}
        {probable && <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-faint px-2 py-1 rounded-full border border-line">{tt("Probable")}</span>}
        {head(away, 'away')}
      </div>

      {/* wide screens: across, home on the left */}
      <div className="hidden sm:block relative w-full rounded-2xl overflow-hidden border border-line/60" style={{ aspectRatio: '16 / 10', ...grass(90) }}>
        <svg viewBox="0 0 1000 625" className="absolute inset-0 w-full h-full" preserveAspectRatio="none" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" aria-hidden>
          <rect x="15" y="15" width="970" height="595" rx="3" />
          <line x1="500" y1="15" x2="500" y2="610" />
          <circle cx="500" cy="312" r="72" />
          <rect x="15" y="150" width="140" height="325" /><rect x="15" y="235" width="50" height="155" />
          <rect x="845" y="150" width="140" height="325" /><rect x="935" y="235" width="50" height="155" />
          <path d="M155 250 A70 70 0 0 1 155 375" /><path d="M845 250 A70 70 0 0 0 845 375" />
        </svg>
        {dots.map(d => (
          <div key={`${d.side}${d.pl.id}`} className="absolute -translate-x-1/2 -translate-y-[22px]" style={{ left: `${d.a}%`, top: `${d.b}%` }}>
            <PitchToken p={d.pl} side={d.side} of={ofOf(d.team)} href={playerHref(d.pl, d.team, code)} />
          </div>
        ))}
      </div>

      {/* phones: top to bottom, away at the top */}
      <div className="sm:hidden relative w-full rounded-2xl overflow-hidden border border-line/60" style={{ aspectRatio: '10 / 15', ...grass(0) }}>
        <svg viewBox="0 0 400 600" className="absolute inset-0 w-full h-full" preserveAspectRatio="none" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" aria-hidden>
          <rect x="8" y="8" width="384" height="584" rx="2" />
          <line x1="8" y1="300" x2="392" y2="300" />
          <circle cx="200" cy="300" r="45" />
          <rect x="90" y="8" width="220" height="80" /><rect x="150" y="8" width="100" height="30" />
          <rect x="90" y="512" width="220" height="80" /><rect x="150" y="562" width="100" height="30" />
        </svg>
        {dots.map(d => (
          <div key={`${d.side}${d.pl.id}`} className="absolute -translate-x-1/2 -translate-y-[20px]" style={{ top: `${4 + (100 - d.a) * 0.88}%`, left: `${d.b}%` }}>
            <PitchToken p={d.pl} side={d.side} of={ofOf(d.team)} href={playerHref(d.pl, d.team, code)} />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5">
        <XiList team={home} side="home" of={ofOf(home)} code={code} />
        <XiList team={away} side="away" of={ofOf(away)} code={code} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Live pitch: both XIs in their formation, with what happened to each */
/* player (goals, assists, cards, substitutions). From the event feed — */
/* no positions or ball tracking (our data provider doesn't have them).  */
/* ------------------------------------------------------------------ */

const nameKey = (n: string) => lastName(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')

function LivePitch({ m, home, away, live }: { m: Match; home: Team; away: Team; live: boolean }) {
  // events are matched to players by id, or by surname when the lineup and the events come from different feeds
  const same = (pl: { id: number; name: string }, x?: { id: number; name: string } | null) =>
    !!x && (x.id === pl.id || (!!x.name && nameKey(x.name) === nameKey(pl.name)))
  const info = (pl: PitchPlayer, teamId: number) => {
    const goals = (m.goals || []).filter(g => g.type !== 'OWN' && g.team.id === teamId && same(pl, g.scorer)).length
    const own = (m.goals || []).filter(g => g.type === 'OWN' && same(pl, g.scorer)).length
    const assists = (m.goals || []).filter(g => g.team.id === teamId && same(pl, g.assist)).length
    const cards = (m.bookings || []).filter(b => b.team.id === teamId && same(pl, b.player))
    const yellow = cards.some(c => c.card === 'YELLOW')
    const red = cards.find(c => c.card === 'RED' || c.card === 'YELLOW_RED')
    return { goals, own, assists, yellow, red }
  }
  // who is in each starting slot now: follow the substitutions
  const slot = (starter: PitchPlayer, teamId: number) => {
    let cur: PitchPlayer = starter
    const chain: { out: string; in: string; minute: number }[] = []
    for (const sub of [...(m.substitutions || [])].filter(x => x.team.id === teamId).sort((a, b) => a.minute - b.minute)) {
      if (same(cur, sub.playerOut)) {
        chain.push({ out: cur.name, in: sub.playerIn.name, minute: sub.minute })
        cur = { id: sub.playerIn.id, name: sub.playerIn.name, shirtNumber: null }
      }
    }
    return { cur, chain }
  }
  const side = (team: Team, isHome: boolean) => {
    const rows = formationRows(team)
    const n = rows.length
    return rows.flatMap((row, i) =>
      row.map((pl, j) => {
        const t = n <= 1 ? 0 : i / (n - 1)
        const x = isHome ? 5 + t * 40 : 95 - t * 40
        const y = ((j + 1) / (row.length + 1)) * 100
        return { pl, x, y: isHome ? y : 100 - y, teamId: team.id }
      })
    )
  }
  const dots = [...side(home, true), ...side(away, false)]
  const ft = m.score?.fullTime
  const Mark = ({ children, cls }: { children: ReactNode; cls: string }) => <span className={`absolute grid place-items-center rounded-full text-[9px] font-extrabold leading-none ${cls}`}>{children}</span>
  return (
    <div>
      <div className="relative w-full rounded-2xl overflow-hidden border border-line/60" style={{ aspectRatio: '16 / 10', background: 'repeating-linear-gradient(90deg, rgb(28 120 66) 0 10%, rgb(33 131 73) 10% 20%)' }}>
        <svg viewBox="0 0 1000 625" className="absolute inset-0 w-full h-full" preserveAspectRatio="none" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="2" aria-hidden>
          <rect x="15" y="15" width="970" height="595" rx="3" />
          <line x1="500" y1="15" x2="500" y2="610" />
          <circle cx="500" cy="312" r="72" />
          <rect x="15" y="150" width="140" height="325" /><rect x="15" y="235" width="50" height="155" />
          <rect x="845" y="150" width="140" height="325" /><rect x="935" y="235" width="50" height="155" />
          <path d="M155 250 A70 70 0 0 1 155 375" /><path d="M845 250 A70 70 0 0 0 845 375" />
        </svg>
        {/* scoreboard */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1 rounded-full bg-black/55 backdrop-blur text-white text-xs font-bold">
          {live && <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulseDot" />}
          <span>{home.tla || home.shortName || home.name}</span>
          <span className="num">{ft?.home ?? 0} – {ft?.away ?? 0}</span>
          <span>{away.tla || away.shortName || away.name}</span>
          <span className="text-white/70 font-semibold">{live ? (m.status === 'PAUSED' ? tt("HT") : m.minute ? `${m.minute}'` : tt("Live")) : tt("FT")}</span>
        </div>
        {dots.map(({ pl, x, y, teamId }) => {
          const { cur, chain } = slot(pl, teamId)
          const a = info(pl, teamId), b = cur !== pl ? info(cur as PitchPlayer, teamId) : null
          const goals = a.goals + (b?.goals || 0), assists = a.assists + (b?.assists || 0), own = a.own + (b?.own || 0)
          const red = (b || a).red || a.red
          const yellow = (b || a).yellow
          const isHome = teamId === home.id
          const title = [
            chain.length ? `${chain.map(c => `${c.out} ⟶ ${c.in} (${c.minute}')`).join(', ')}` : pl.name,
            goals ? `${goals} goal${goals > 1 ? 's' : ''}` : '', assists ? `${assists} assist${assists > 1 ? 's' : ''}` : '',
            own ? 'own goal' : '', red ? tt("sent off {0}'", { 0: red.minute }) : yellow ? 'booked' : ''
          ].filter(Boolean).join(' · ')
          return (
            <div key={`${teamId}-${pl.id}`} className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center w-[72px] sm:w-[84px]" style={{ left: `${x}%`, top: `${y}%` }} title={title}>
              <div className={`relative w-7 h-7 sm:w-9 sm:h-9 rounded-full grid place-items-center text-[11px] sm:text-xs font-extrabold num shadow-[0_2px_6px_rgba(0,0,0,0.45)] ${isHome ? 'bg-home text-white' : 'bg-away text-white'} ${red ? 'opacity-40 grayscale' : ''}`}>
                {cur.shirtNumber ?? pl.shirtNumber ?? ''}
                {goals > 0 && <Mark cls="-top-1.5 -right-2 w-4 h-4 bg-white text-black ring-1 ring-black/30">{goals > 1 ? goals : '⚽'}</Mark>}
                {assists > 0 && <Mark cls="-bottom-1 -right-2 w-4 h-4 bg-accent text-black">A</Mark>}
                {own > 0 && <Mark cls="-top-1.5 -left-2 w-4 h-4 bg-loss text-white">{tt("OG")}</Mark>}
                {(yellow || red) && <span className={`absolute -top-1 -left-1.5 w-2.5 h-3.5 rounded-[2px] ring-1 ring-black/30 ${red ? 'bg-loss' : 'bg-draw'}`} />}
                {chain.length > 0 && <Mark cls="-bottom-1 -left-2 w-4 h-4 bg-win text-black">⇅</Mark>}
              </div>
              {(() => {
                const href = playerHref(cur, isHome ? home : away, m.competition?.code)
                const cls = 'mt-0.5 text-[10px] sm:text-[11px] leading-tight text-white font-semibold text-center drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] truncate max-w-full'
                return href ? <Link to={href} className={`${cls} hover:underline`}>{lastName(cur.name)}</Link> : <span className={cls}>{lastName(cur.name)}</span>
              })()}
              {chain.length > 0 && (
                <span className="text-[9px] leading-tight text-white/75 drop-shadow truncate max-w-full">{tt("{0}' for {1}", { 0: chain[chain.length - 1].minute, 1: lastName(chain[chain.length - 1].out) })}</span>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded-full bg-white text-black text-[8px] grid place-items-center">⚽</span>{tt("Goal")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded-full bg-accent text-black text-[8px] font-extrabold grid place-items-center">A</span>{tt("Assist")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-3 rounded-[2px] bg-draw" />{tt("Yellow")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2 h-3 rounded-[2px] bg-loss" />{tt("Red (greyed out)")}</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-3.5 rounded-full bg-win text-black text-[8px] grid place-items-center">⇅</span>{tt("Came on")}</span>
      </div>
      <p className="mt-2 text-center text-[11px] text-faint">{tt("Players in their starting formation; the pitch updates with goals, cards and substitutions. It does not show player or ball positions.")}</p>
    </div>
  )
}

function Bench({ team, code }: { team: Team; code?: string }) {
  const bench = team.bench || []
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          {team.crest && <img src={team.crest} alt="" className="w-4 h-4 object-contain" />}
          <TeamName team={team} short /> {tt("· bench")}</div>
        {team.coach?.name && <span className="text-[11px] text-faint">{tt("Coach")}{' '}{team.coach.name}</span>}
      </div>
      {bench.length ? (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
          {bench.map(pl => (
            <li key={pl.id} className="flex items-center gap-2 min-w-0">
              <span className="num w-5 text-right text-faint">{pl.shirtNumber ?? ''}</span>
              {(() => {
                const href = playerHref(pl, team, code)
                return href ? <Link to={href} className="truncate hover:text-ink hover:underline">{pl.name}</Link> : <span className="truncate">{pl.name}</span>
              })()}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">{tt("No bench data.")}</p>
      )}
    </div>
  )
}

export default MatchDetail

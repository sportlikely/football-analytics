import { useEffect, useRef, useState } from 'react'
import { useEntityId } from '../../components/SlugRoute'
import { Link } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import axios from 'axios'
import { primeGame } from '../../lib/gameBundle'
import { useApiFresh } from '../../lib/apiCache'
import { API_URL } from '../../lib/socket'
import { t, LOCALE, lang } from '../../lib/i18n'
import { FavStar } from '../../lib/favorites'
import { useReveal } from '../../lib/reveal'
import { slModelOf } from '../../lib/modelNames'
import { NFL_STATUS, weekLabel, nick, nflTeamFav, nflRid, nflRstatus, setNflLeague, nflLeagueName, nflModelOf, nflStrongAt, type NflGame as Game, type NflSide, type NflPred, type StandRow } from '../../lib/nfl'
import { Card, Skeleton, TeamLogo } from '../bb/parts'
import { GAME_RELOAD } from '../../components/UnlockPrompt'
import MorePredictions from '../../components/sport/game/MorePredictions'
import GameMeaning from '../../components/sport/forecast/GameMeaning'
import GameExtras from '../../components/sport/game/GameExtras'
import YourPicks from '../../components/YourPicks'
import { newerWinnerLive } from '../../lib/liveState'
import { StatBars, LeagueSwitch, StandTable } from './parts'
import GamePage, { useGameTab, GameNews, fmtGameDate, fmtGameTime, halfTimeOf, type GameTab } from '../../components/sport/game/GamePage'
import WinnerPrediction, { type WhyRow } from '../../components/sport/game/WinnerPrediction'
import { LiveChancePanel, SwingChart } from '../../components/sport/game/LiveChance'
import ModelParts, { type PartRow } from '../../components/sport/game/ModelParts'
import NewsChange from '../../components/sport/game/NewsChange'
import QuarterStrip from '../../components/sport/game/QuarterStrip'
import Highlights from '../../components/sport/game/Highlights'
import GamePreview from '../../components/sport/game/GamePreview'
import { useLiveBox, LiveBoxLabel } from '../../components/sport/game/LiveBox'
import { RestTab } from '../bb/GameTabs'
import KeyPlayers from '../../components/sport/game/KeyPlayers'
import { nflScorers } from '../../lib/scorers'
import type { Sched } from '../bb/BbGame'
import { teamHref, playerHref, leagueHref, matchHref } from '../../lib/links'
import { MaybeLink } from '../../components/MaybeLink'
import { tg, tgParts } from '../../lib/genText'

type Box = {
  firstDowns: number | null; plays: number | null; yards: number | null; yardsPerPlay: number | null; passYards: number | null; rushYards: number | null; rushAttempts: number | null
  third: [number, number] | null; fourth: [number, number] | null; redZone: [number, number] | null; turnovers: number | null; penalties: any; possession: any
  sacks: number | null; sacked: number | null; interceptions: number | null; fumblesRecovered: number | null
}
type Groups = Record<string, { id: number; name: string; image: string | null; stats: Record<string, string> }[]>
interface FormRow { id: number; kickoff: string; opponent: NflSide; home: boolean; for: number; against: number; result: 'W' | 'L' | 'T' }
interface Injury { id: number; name: string; image: string | null; status: string | null; description: string | null; date: string | null }
interface Starter { id: number; name: string; position: string; image: string | null; line: string | null; status: string | null; out: boolean }
interface Play { quarter: string | number | null; minute: string | null; team: number | null; teamName: string | null; player: string | null; playerId: number | null; type: string | null; comment: string | null; score: [number | null, number | null] | null }
interface BeforeAfter {
  before: { pHome: number; pAway: number; at: string }; after: { pHome: number; pAway: number }
  players: { id: number; name: string; position: string | null; status: string | null; side: 'H' | 'A' }[]
  qb: { side: 'H' | 'A'; was: string; now: string }[]
}
interface Data {
  game: Game; form: { home: FormRow[]; away: FormRow[] }; h2h: Game[]; teamStats: { home: Box | null; away: Box | null } | null
  players: { home: Groups; away: Groups } | null; playersLive?: { at: number } | null; injuries: { home: Injury[]; away: Injury[] } | null; prediction: NflPred | null
  // fix174
  live?: { now: { pHome: number; pAway: number; score: { home: number; away: number }; total: number } | null; curve: { t: number; p: number }[] } | null
  schedule?: { home: Sched; away: Sched }
  standings?: { season: number; league: number; tables: { conference: string; name: string; rows: StandRow[] }[] } | null
  starters?: { home: Starter[]; away: Starter[] } | null
  /** fix224: the starting QB + the most productive players; without = points the model takes off without him (QB only) */
  keyPlayers?: { home: NflKey[]; away: NflKey[] } | null
  beforeAfter?: BeforeAfter | null
  writeup?: string | null
  events?: Play[] | null
}
interface NflKey { id: number; name: string; position: string | null; image: string | null; perGame: number; games: number; status: string | null; out: boolean; without: number | null }
const TABS = ['prediction', 'stats', 'players', 'table', 'rest', 'h2h', 'plays', 'highlights']
const OUT = /out|ir|reserve|doubtful/i

/**
 * NFL + college game page: the shared game page (football's match page, fix152c) — Prediction · Statistics ·
 * Players & injuries · Standings · Schedule & rest · H2H, and after full time the scoring plays (or the game by
 * quarter) and the official highlights. fix174: live win chance + swing chart, "how it was calculated", the written
 * preview, likely starters and "numbers changed" when injury news moved the prediction.
 */
export default function NflGame() {
  const id = useEntityId()
  const [d, setD] = useState<Data | null>(null)
  const [missing, setMissing] = useState(false)
  const [tab, pickTab] = useGameTab(TABS, { overview: 'h2h', injuries: 'players', standings: 'table', video: 'highlights' })
  const reload = useRef<() => void>(() => undefined)
  primeGame('nfl', Number(id)) // fix250: the page's parts in one request
  useApiFresh(id ? `${API_URL}/nfl/game/${id}` : null, () => reload.current())
  useEffect(() => {
    setD(null); setMissing(false)
    const load = () => axios.get(`${API_URL}/nfl/game/${id}`)
      .then(r => setD(prev => (prev && prev.game.id === r.data.data?.game?.id ? { ...r.data.data, game: newerWinnerLive(prev.game, r.data.data.game) } : r.data.data))) // fix165: never backwards
      .catch(e => { if (e?.response?.status === 404) setMissing(true) })
    reload.current = load
    load()
    const iv = setInterval(() => { if (document.visibilityState === 'visible') load() }, 30 * 1000)
    window.addEventListener(GAME_RELOAD, load) // fix144: a free pick opened this game
    return () => { clearInterval(iv); window.removeEventListener(GAME_RELOAD, load) }
  }, [id])
  // fix208: live player stats — the page reloads its data when a new box score is stored
  useLiveBox('nfl', d?.game.id ?? null, d?.game.state === 'live' || !!d?.playersLive, () => reload.current())
  // the same title search engines get (seo.ts): "Chiefs vs Bills · NFL Week 7 | SportLikely"
  // fix142: college titles use the school names ("Alabama vs Georgia · College football Week 7")
  useEffect(() => {
    if (!d) return
    const lg = d.game.league || 1
    setNflLeague(lg)
    document.title = `${nick(d.game.home.name, lg)} ${t('vs')} ${nick(d.game.away.name, lg)} · ${lg === 2 ? t('College football') : 'NFL'} ${d.game.weekKey === 'post' ? (lg === 2 ? t('Bowls') : t('Playoffs')) : t('Week {0}', { 0: d.game.weekKey })} | SportLikely`
  }, [d?.game.id])

  if (missing) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-muted">{t('Game not found.')}</div>
  if (!d) return <div className="max-w-5xl mx-auto px-4 py-8"><Skeleton rows={6} h="h-16" /></div>
  const g = d.game
  const lg = g.league || 1
  const p = g.prediction || null
  const live = g.state === 'live', done = g.state === 'done'
  const q = g.quarters
  const ot = q && (q.home[4] != null || q.away[4] != null)
  const showQ = !!g.score && g.state !== 'upcoming' && q && q.home.some(x => x !== null)
  const side = (team: NflSide) => ({
    name: team.name, logo: <TeamLogo team={team} size={72} />, href: teamHref('american-football', team.id, team.name)!,
    title: t('{0}: team page', { 0: team.name }), linkLabel: t('Team page →'), star: <FavStar fav={nflTeamFav(team)} size="sm" />
  })
  const hasPlayers = !!(d.players || d.injuries || d.starters)
  const plays = d.events && d.events.length ? d.events : null

  const tabs: GameTab[] = [
    {
      id: 'prediction', label: t('Prediction'), hint: '',
      render: () => (
        <>
          <WinnerPrediction
            rid={nflRid(g)} status={nflRstatus(g)} p={p} home={g.home} away={g.away} upcoming={g.state === 'upcoming'} model={nflModelOf(lg)} sport="american-football"
            saved={t('Saved before kick-off')} updated={t('Updated until kick-off')} strongAt={nflStrongAt(lg)}
            stats={[
              { label: t('Expected margin'), value: typeof p?.margin === 'number' ? t('{0} by {1}', { 0: nick((p.margin >= 0 ? g.home : g.away).name, g.league), 1: Math.abs(p.margin).toFixed(1) }) : '–' },
              { label: t('Predicted score'), value: typeof p?.homePts === 'number' ? `${Math.round(p.homePts)}–${Math.round(p.awayPts!)}` : '–' },
              { label: t('Total points'), value: typeof p?.total === 'number' ? p.total.toFixed(1) : '–' }
            ]}
            why={p ? whyRows(g, p) : []}
            howCalc={p && p.why && !p.locked ? <NflModelParts g={g} p={p} injuries={d.injuries} /> : undefined}
            noPrediction={g.state === 'upcoming' ? t('Our prediction for this game is saved in the week of the game, before kick-off.') : t('No prediction for this game.')}
          />
          {/* fix204: more predictions from the same model (locked like the prediction) */}
          <MorePredictions sport="nfl" id={g.id} rid={nflRid(g)} status={nflRstatus(g)} home={nick(g.home.name, g.league)} away={nick(g.away.name, g.league)} />
          <GameMeaning sport="nfl" id={g.id} />
          {/* fix231: trends, next games, weather (outdoor stadiums) */}
          <GameExtras sport="nfl" id={g.id} />
          {d.keyPlayers && <NflKeyPlayers g={g} data={d.keyPlayers} />}
          {d.beforeAfter && <ChangeCard g={g} x={d.beforeAfter} />}
          {lang === 'en' && d.writeup && <GamePreview text={d.writeup} />}
          {d.starters && (d.starters.home.length > 0 || d.starters.away.length > 0) && <Starters g={g} data={d.starters} />}
          <YourPicks sport="nfl" gameId={g.id} home={nick(g.home.name, g.league)} away={nick(g.away.name, g.league)} />
          <GameNews home={{ sport: 'american-football', teamId: g.home.id }} away={{ sport: 'american-football', teamId: g.away.id }} />
        </>
      )
    },
    ...(d.teamStats ? [{ id: 'stats', label: t('Statistics'), short: t('Stats'), hint: live ? t('Live team stats') : t('Yards, downs, red zone and turnovers'), live, render: () => <TeamStats g={g} home={d.teamStats!.home} away={d.teamStats!.away} /> }] : []),
    ...(hasPlayers ? [{
      id: 'players', label: d.injuries ? t('Players & injuries') : t('Players'), short: t('Players'), hint: d.playersLive ? t('Live player stats') : d.injuries ? t('Likely starters, player stats and the injury reports') : t('Passing, rushing, receiving and defense'), live: !!d.playersLive,
      // fix208: during the game the live player lines come first
      render: () => (
        <>
          {d.playersLive && d.players && <Players g={g} data={d.players} at={d.playersLive.at} />}
          {d.starters && <Starters g={g} data={d.starters} />}
          {d.injuries && <Injuries g={g} data={d.injuries} />}
          {!d.playersLive && d.players && <Players g={g} data={d.players} />}
        </>
      )
    }] : []),
    ...(d.standings && d.standings.tables.length ? [{ id: 'table', label: t('Standings'), short: t('Table'), hint: lg === 2 ? t('The conference tables') : t('The division tables'), render: () => <StandingsTab g={g} data={d.standings!} /> }] : []),
    ...(d.schedule ? [{ id: 'rest', label: t('Schedule & rest'), short: t('Rest'), hint: t('Short weeks, byes and the next games'), render: () => <RestTab g={g} home={d.schedule!.home} away={d.schedule!.away} sport="nfl" /> }] : []),
    { id: 'h2h', label: t('H2H'), hint: t('Last meetings and recent form'), render: () => <H2HForm d={d} /> },
    ...(done && (plays || showQ) ? [{ id: 'plays', label: plays ? t('Scoring plays') : t('By quarter'), short: plays ? t('Plays') : t('Quarters'), hint: plays ? t('Every score in order') : t('Points and margin per quarter'), render: () => (plays ? <ScoringPlays g={g} list={plays} /> : <Card title={t('By quarter')}><QuarterStrip home={nick(g.home.name, lg)} away={nick(g.away.name, lg)} q={q!} /></Card>) }] : []),
    ...(done ? [{ id: 'highlights', label: t('Highlights'), short: t('Video'), hint: t('Official video'), render: () => <Highlights url={`${API_URL}/nfl/game/${g.id}/highlights`} /> }] : [])
  ]

  return (
    <GamePage
      back={{ to: '/american-football/matches', label: t('All games') }}
      top={<LeagueSwitch />}
      srTitle={`${g.home.name} vs ${g.away.name} · ${nflLeagueName(lg)} ${weekLabel(g.weekKey, g.league)}`}
      league={{ name: nflLeagueName(lg), href: leagueHref('american-football', String(lg))!, bits: [weekLabel(g.weekKey, g.league)] }}
      date={fmtGameDate(g.kickoff)}
      home={side(g.home)}
      away={side(g.away)}
      score={g.score && g.state !== 'upcoming' ? g.score : null}
      time={fmtGameTime(g.kickoff)}
      status={{
        kind: live ? 'live' : done ? 'done' : g.state === 'off' ? 'halted' : 'upcoming',
        text: NFL_STATUS[g.status] || (g.state === 'upcoming' ? t('KICK-OFF') : g.status)
      }}
      scoreSub={(() => { const ht = live || done ? halfTimeOf(g.quarters) : null; return ht ? <div className="num text-xs text-faint mt-1">{t('HT')} {ht.home}–{ht.away}</div> : undefined })()}
      // fix209: the scoring plays under each team ("TD Kelce 12' Q2"), live and final (games/events)
      scorers={(live || done) && plays ? { lines: nflScorers(plays, g.home.id, g.away.id), playerHref: (pid, name) => href.nflPlayer(pid, name) } : null}
      statusNote={g.state === 'off' ? (
        <p className="mt-2 max-w-[260px] mx-auto text-[11px] text-muted">
          {/CANC/.test(g.status) ? t('This game was cancelled. It does not count in our record.') : t('This game was postponed. Our prediction stays until the new date.')}
        </p>
      ) : undefined}
      pickVar={p && !p.locked && p.pick ? (p.pick === 'H' ? '--home' : '--away') : null}
      footer={(showQ || g.venue) ? (
        <>
          {showQ && (
            <div className="overflow-x-auto">
              <table className="mx-auto text-xs num">
                <thead><tr className="text-faint"><th className="px-3 text-start font-semibold" />{['Q1', 'Q2', 'Q3', 'Q4', ...(ot ? ['OT'] : [])].map(x => <th key={x} className="px-3 font-semibold">{t(x)}</th>)}<th className="px-3 font-semibold">{t('Total')}</th></tr></thead>
                <tbody>
                  {(['home', 'away'] as const).map(s => (
                    <tr key={s}>
                      <td className="px-3 py-0.5 text-muted font-semibold font-sans text-start"><NameLink to={href.nflTeam(g[s].id, g[s].name)}>{nick(g[s].name, g.league)}</NameLink></td>
                      {q![s].slice(0, ot ? 5 : 4).map((v, i) => <td key={i} className="px-3 text-center text-ink">{v ?? '–'}</td>)}
                      <td className="px-3 text-center text-ink font-bold">{g.score ? g.score[s] : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {g.venue && <p className={`text-center text-xs text-faint ${showQ ? 'mt-3' : ''}`}>{t('Venue')} <span className="text-muted">{g.venue}</span></p>}
        </>
      ) : undefined}
      afterHero={<LiveBlock d={d} />}
      tabs={tabs}
      tab={tab}
      onTab={pickTab}
    />
  )
}

/** Live win chance + projected score while the game is on; the swing chart live and after full time (numbers unlocked). */
function LiveBlock({ d }: { d: Data }) {
  const g = d.game, p = g.prediction
  const { hidden } = useReveal(nflRid(g), nflRstatus(g), !!p && !p.locked)
  if (!d.live || !p || p.locked || hidden || typeof p.pHome !== 'number') return null
  const lg = g.league || 1
  const live = g.state === 'live'
  const now = live ? (d.live.now || p.live || null) : null
  // the curve's samples are stored on every live tick (30 s), so its last point is the chance now
  const curve = d.live.curve
  if (!now && curve.length < 2) return null
  return (
    <>
      {now && <LiveChancePanel home={nick(g.home.name, lg)} away={nick(g.away.name, lg)} now={now} before={{ pHome: p.pHome, pAway: p.pAway ?? 100 - p.pHome }} status={`${NFL_STATUS[g.status] || g.status} · ${g.score?.home ?? 0}-${g.score?.away ?? 0}`} />}
      {curve.length >= 2 && (
        <div className="mt-3 rounded-2xl border border-line/60 bg-surface/60 p-3 sm:p-4">
          <SwingChart points={curve} home={nick(g.home.name, lg)} away={nick(g.away.name, lg)} live={live} />
        </div>
      )}
    </>
  )
}

/** "How it was calculated": the model's parts per team (Elo, home field, rest, quarterbacks, efficiency, injuries). */
function NflModelParts({ g, p, injuries }: { g: Game; p: NflPred; injuries: Data['injuries'] }) {
  const w = p.why!
  const pts = (elo: number) => elo / 25
  const f = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}`
  const edge = pts(w.eloGap)
  const rows: PartRow[] = [
    { label: t('Elo rating'), h: String(w.eloHome), a: String(w.eloAway) },
    { label: t('Rating edge (points)'), h: edge > 0 ? f(edge) : '0.0', a: edge < 0 ? f(-edge) : '0.0' },
    { label: t('Home field (points)'), h: w.neutral ? '0.0' : f(pts(w.homeField)), a: '0.0' }
  ]
  if (w.restAdj[0] || w.restAdj[1]) rows.push({ label: t('Rest: bye or short week (points)'), h: f(pts(w.restAdj[0])), a: f(pts(w.restAdj[1])) })
  if (w.qb[0] || w.qb[1]) rows.push({ label: t('Quarterback change (points)'), h: w.qb[0] && w.qb[0].reason !== 'same' ? f(pts(w.qb[0].adj)) : '0.0', a: w.qb[1] && w.qb[1].reason !== 'same' ? f(pts(w.qb[1].adj)) : '0.0' })
  if (w.eff) {
    rows.push({ label: t('Yards per play, gained minus allowed'), h: f(w.eff.yppHome), a: f(w.eff.yppAway) })
    rows.push({ label: t('Turnover margin per game'), h: f(w.eff.toHome), a: f(w.eff.toAway) })
  }
  if (injuries) rows.push({ label: t('Players out (injury report)'), h: String(injuries.home.filter(i => OUT.test(i.status || '')).length), a: String(injuries.away.filter(i => OUT.test(i.status || '')).length) })
  if (typeof p.margin === 'number') rows.push({ label: t('Expected margin'), h: f(p.margin), a: f(-p.margin) })
  if (typeof p.pHome === 'number') rows.push({ label: t('Win chance'), h: `${Math.round(p.pHome)}%`, a: `${Math.round(p.pAway ?? 100 - p.pHome)}%` })
  const lg = g.league || 1
  return (
    <ModelParts
      home={<NameLink to={href.nflTeam(g.home.id, g.home.name)}>{nick(g.home.name, lg)}</NameLink>} away={<NameLink to={href.nflTeam(g.away.id, g.away.name)}>{nick(g.away.name, lg)}</NameLink>}
      rows={rows}
      total={typeof p.homePts === 'number' ? { label: t('Predicted points'), h: String(Math.round(p.homePts)), a: String(Math.round(p.awayPts ?? 0)) } : null}
      note={w.blend
        ? t('25 Elo points ≈ 1 point on the scoreboard. The rating margin is blended with efficiency (yards per play, turnovers) into the final margin; win chance from the margin. Model {0}.', { 0: slModelOf(p.model || nflModelOf(lg), 'american-football') })
        : t('25 Elo points ≈ 1 point on the scoreboard; win chance from the expected margin. Model {0}.', { 0: slModelOf(p.model || nflModelOf(lg), 'american-football') })}
    />
  )
}

/** Before vs after: injury news or a new starting quarterback since our first prediction. */
function ChangeCard({ g, x }: { g: Game; x: BeforeAfter }) {
  const lg = g.league || 1
  return (
    <NewsChange
      home={nick(g.home.name, lg)} away={nick(g.away.name, lg)} before={x.before} after={x.after}
      players={x.players.map(pl => ({ id: pl.id, name: pl.name, side: pl.side, detail: [pl.position, pl.status].filter(Boolean).join(' · '), href: href.nflPlayer(pl.id, pl.name) }))}
      extra={x.qb.length ? (
        <ul className="space-y-1">
          {x.qb.map(c => <li key={c.side} className="text-sm text-ink"><span className={c.side === 'H' ? 'text-home font-semibold' : 'text-away font-semibold'}>{nick((c.side === 'H' ? g.home : g.away).name, lg)}</span> · {t('{0} starts at quarterback instead of {1}', { 0: c.now, 1: c.was })}</li>)}
        </ul>
      ) : undefined}
    />
  )
}

/** Likely starters: QB, RB, WR1-2, TE and the defence leaders, with the injury report status. */
/** fix224: the shared key players card — QB first, the injury report's status, the QB's price in our model */
function NflKeyPlayers({ g, data }: { g: Game; data: { home: NflKey[]; away: NflKey[] } }) {
  const side = (name: string, list: NflKey[]) => ({
    name, players: list.map(p => ({
      id: p.id, name: p.name, href: href.nflPlayer(p.id, p.name), photo: p.image,
      detail: [p.position, t('{0} production points a game', { 0: p.perGame.toFixed(1) }), t('{0} games', { 0: p.games })].filter(Boolean).join(' · '),
      status: p.status ? { tone: (p.out ? 'bad' : 'warn') as 'bad' | 'warn', label: p.status } : { tone: 'ok' as const, label: t('Playing') },
      without: p.without
    }))
  })
  return <KeyPlayers home={side(nick(g.home.name, g.league), data.home)} away={side(nick(g.away.name, g.league), data.away)}
    note={t('Each team’s starting quarterback and its most productive players this season (yards and touchdowns a game), with the injury report. Our model prices the quarterback: the number is what it takes off the team without him.')} />
}

function Starters({ g, data }: { g: Game; data: { home: Starter[]; away: Starter[] } }) {
  const lg = g.league || 1
  return (
    <Card title={t('Likely starters')} action={<span className="text-xs text-faint">{t('Season leaders by position')}</span>}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
        {(['home', 'away'] as const).map(s => (
          <div key={s} className="min-w-0">
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-1 h-6 rounded-full ${s === 'home' ? 'bg-home' : 'bg-away'}`} />
              <TeamLogo team={g[s]} size={22} />
              <NameLink to={href.nflTeam(g[s].id, g[s].name)} className="font-display font-bold text-ink truncate">{nick(g[s].name, lg)}</NameLink>
            </div>
            {data[s].length === 0 ? <p className="text-sm text-faint">{t('No player stats yet this season.')}</p> : (
              <ul className="divide-y divide-line/50">
                {data[s].map(pl => (
                  <li key={`${pl.position}${pl.id}`} className={`flex items-center gap-2.5 py-1.5 text-sm min-w-0 ${pl.out ? 'opacity-60' : ''}`}>
                    <span className="w-14 shrink-0 text-[10px] font-bold uppercase tracking-wide text-faint">{t(pl.position)}</span>
                    <span className="min-w-0 flex-1">
                      <NameLink to={href.nflPlayer(pl.id, pl.name)} className={`block truncate font-semibold ${pl.out ? 'line-through text-muted' : 'text-ink'}`}>{pl.name}</NameLink>
                      {pl.line && <span className="block text-[11px] text-faint truncate">{tg(pl.line)}</span>}
                    </span>
                    {pl.status && <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${pl.out ? 'bg-loss/15 text-loss' : 'bg-draw/15 text-draw'}`}>{pl.status}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

/** Standings tab: the division (NFL) or conference (college) tables with both teams marked. */
function StandingsTab({ g, data }: { g: Game; data: NonNullable<Data['standings']> }) {
  const lg = g.league || 1
  return (
    <Card title={t('Standings')} action={<Link to={href.nflStandings(lg)} className="text-xs font-bold text-accent">{t('Full table →')}</Link>}>
      <div className="space-y-5">
        {data.tables.map(tb => <StandTable key={`${tb.conference}|${tb.name}`} title={tgParts(tb.name !== tb.conference ? `${tb.conference} · ${tb.name}` : tb.name)} rows={tb.rows} highlight={[g.home.id, g.away.id]} league={lg} />)}
      </div>
    </Card>
  )
}

/** Scoring plays (the provider's game events), in order with the running score. */
function ScoringPlays({ g, list }: { g: Game; list: Play[] }) {
  const lg = g.league || 1
  let lastQ: string | null = null
  return (
    <Card title={t('Scoring plays')}>
      <ul className="divide-y divide-line/50">
        {list.map((e, i) => {
          const qLabel = String(e.quarter ?? '')
          const head = qLabel && qLabel !== lastQ ? qLabel : null
          lastQ = qLabel
          const sideH = e.team === g.home.id
          return (
            <li key={i} className="py-2">
              {head && <div className="label pb-1">{/^\d$/.test(head) ? t('Q{0}', { 0: head }) : head}</div>}
              <div className="flex items-start gap-3 text-sm min-w-0">
                <span className="num w-12 shrink-0 text-xs text-faint pt-0.5">{e.minute || ''}</span>
                <span className={`w-1.5 self-stretch rounded-full shrink-0 ${sideH ? 'bg-home' : 'bg-away'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-ink font-semibold">{e.type || t('Score')}{e.player ? <> · <NameLink to={e.playerId ? href.nflPlayer(e.playerId, e.player) : null}>{e.player}</NameLink></> : null}</span>
                  {e.comment && <span className="block text-xs text-muted">{e.comment}</span>}
                  <span className="block text-[11px] text-faint">{e.teamName ? nick(e.teamName, lg) : ''}</span>
                </span>
                {e.score && <span className="num font-bold text-ink shrink-0">{e.score[0] ?? '–'}–{e.score[1] ?? '–'}</span>}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** H2H tab (football's order: the meetings, then each team's form). */
function H2HForm({ d }: { d: Data }) {
  const g = d.game
  return (
    <>
      <Card title={d.h2h.length ? t('Last {0} meetings', { 0: d.h2h.length }) : t('Head-to-head')}>
        {d.h2h.length === 0 ? <p className="text-sm text-faint">{t('No meetings in our records.')}</p> : (
          <ul className="divide-y divide-line/50">
            {d.h2h.map(m => (
              <li key={m.id}>
                <MaybeLink to={matchHref('american-football', m.id, { home: m.home.name, away: m.away.name, homeId: m.home.id, awayId: m.away.id, date: m.kickoff })} className="flex items-center gap-3 py-1.5 text-sm hover:text-accent min-w-0">
                  <span className="w-20 shrink-0 text-xs text-faint">{new Date(m.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  <span className="flex-1 truncate text-ink">{m.home.name} – {m.away.name}</span>
                  <span className="num font-bold text-ink">{m.score ? `${m.score.home}–${m.score.away}` : '–'}</span>
                </MaybeLink>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('Form')} action={<span className="text-xs text-faint">{t('Last results')}</span>}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
          {(['home', 'away'] as const).map(s => (
            <div key={s} className="min-w-0">
              <div className="flex items-center gap-2 mb-3"><TeamLogo team={g[s]} size={22} /><NameLink to={href.nflTeam(g[s].id, g[s].name)} className="font-display font-bold text-ink truncate">{g[s].name}</NameLink></div>
              {d.form[s].length === 0 ? <p className="text-sm text-faint">{t('No games yet.')}</p> : (
                <ul className="space-y-1.5">
                  {d.form[s].map(f => (
                    <li key={f.id}>
                      <MaybeLink to={matchHref('american-football', f.id, f.home ? { home: g[s].name, homeId: g[s].id, away: f.opponent.name, awayId: f.opponent.id, date: f.kickoff } : { home: f.opponent.name, homeId: f.opponent.id, away: g[s].name, awayId: g[s].id, date: f.kickoff })} className="flex items-center gap-2 text-sm hover:text-accent min-w-0">
                        <span className={`w-5 h-5 shrink-0 rounded grid place-items-center text-[10px] font-extrabold ${f.result === 'W' ? 'bg-win/15 text-win' : f.result === 'L' ? 'bg-loss/15 text-loss' : 'bg-draw/15 text-draw'}`}>{f.result}</span>
                        <span className="text-faint text-xs w-6 shrink-0">{f.home ? t('vs') : '@'}</span>
                        <TeamLogo team={f.opponent} size={16} />
                        <span className="flex-1 truncate text-ink">{f.opponent.name}</span>
                        <span className="num font-semibold text-ink">{f.for}–{f.against}</span>
                      </MaybeLink>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Card>
    </>
  )
}

/** "Why we think so" (fix139): the model's own inputs in plain words — Elo gap, home field, rest, quarterbacks, efficiency. */
function whyRows(g: Game, p: NflPred): WhyRow[] {
  const w = p.why
  if (!w) return []
  const out: WhyRow[] = []
  const name = (s: 'H' | 'A') => nick((s === 'H' ? g.home : g.away).name, g.league)
  const pts = (elo: number) => (Math.abs(elo) / 25).toFixed(1)
  const gap = Math.abs(w.eloGap), up: 'H' | 'A' = w.eloGap >= 0 ? 'H' : 'A'
  out.push(gap < 15
    ? { tone: 'N', text: t('The two teams are rated about the same ({0} against {1} Elo).', { 0: w.eloHome, 1: w.eloAway }) }
    : { tone: up, text: t('{0} are the stronger team: {1} Elo points ahead ({2} against {3}), worth about {4} points.', { 0: name(up), 1: gap, 2: up === 'H' ? w.eloHome : w.eloAway, 3: up === 'H' ? w.eloAway : w.eloHome, 4: pts(gap) }) })
  out.push(w.neutral
    ? { tone: 'N', text: t('Neutral site: no home-field edge for either team.') }
    : { tone: 'H', text: t('Home field is worth about {0} points to {1}.', { 0: pts(w.homeField), 1: name('H') }) })
  ;(['H', 'A'] as const).forEach((s, i) => {
    const days = w.rest[i], adj = w.restAdj[i]
    if (days === null || !adj) return
    out.push(adj > 0
      ? { tone: s, text: t('{0} come off a bye week ({1} days of rest).', { 0: name(s), 1: days }) }
      : { tone: s === 'H' ? 'A' : 'H', text: t('{0} play on a short week ({1} days of rest).', { 0: name(s), 1: days }) })
  })
  ;(['H', 'A'] as const).forEach((s, i) => {
    const q = w.qb[i]
    if (!q) return
    const other: 'H' | 'A' = s === 'H' ? 'A' : 'H'
    if (q.reason === 'injury' && q.usualName) out.push({ tone: other, text: t('{0} is on the injury report: {1} should start at quarterback for {2} ({3} points in our ratings).', { 0: q.usualName, 1: q.name, 2: name(s), 3: (q.adj / 25).toFixed(1) }) })
    else if (q.reason === 'changed' && q.usualName) out.push({ tone: q.adj >= 0 ? s : other, text: t('{0} starts at quarterback for {1} instead of {2} ({3} points in our ratings).', { 0: q.name, 1: name(s), 2: q.usualName, 3: (q.adj >= 0 ? '+' : '') + (q.adj / 25).toFixed(1) }) })
    else out.push({ tone: 'N', text: t('Quarterback {0} ({1}): {2} net yards per pass attempt.', { 0: q.name, 1: name(s), 2: q.value.toFixed(1) }) })
  })
  if (w.eff) {
    const better: 'H' | 'A' = w.eff.yppHome >= w.eff.yppAway ? 'H' : 'A'
    out.push({ tone: Math.abs(w.eff.yppHome - w.eff.yppAway) < 0.3 ? 'N' : better, text: t('Yards per play, gained minus allowed: {0} {1}, {2} {3}.', { 0: name('H'), 1: (w.eff.yppHome >= 0 ? '+' : '') + w.eff.yppHome.toFixed(1), 2: name('A'), 3: (w.eff.yppAway >= 0 ? '+' : '') + w.eff.yppAway.toFixed(1) }) })
    out.push({ tone: 'N', text: t('Turnover margin per game: {0} {1}, {2} {3}.', { 0: name('H'), 1: (w.eff.toHome >= 0 ? '+' : '') + w.eff.toHome.toFixed(1), 2: name('A'), 3: (w.eff.toAway >= 0 ? '+' : '') + w.eff.toAway.toFixed(1) }) })
  }
  return out
}

function TeamStats({ g, home, away }: { g: Game; home: Box | null; away: Box | null }) {
  const v = (b: Box | null, k: keyof Box) => (b && typeof b[k] === 'number' ? (b[k] as number) : null)
  const pct = (p: [number, number] | null | undefined) => (p && p[1] ? (100 * p[0]) / p[1] : null)
  return (
    <Card title={t('Statistics')}>
      <div className="flex items-center justify-between text-xs font-bold mb-1">
        <span className="flex items-center gap-1.5 text-home"><TeamLogo team={g.home} size={16} /><NameLink to={href.nflTeam(g.home.id, g.home.name)}>{g.home.name}</NameLink></span>
        <span className="flex items-center gap-1.5 text-away"><NameLink to={href.nflTeam(g.away.id, g.away.name)}>{g.away.name}</NameLink><TeamLogo team={g.away} size={16} /></span>
      </div>
      <div className="divide-y divide-line/40">
        <StatBars label={t('Total yards')} home={v(home, 'yards')} away={v(away, 'yards')} />
        <StatBars label={t('Yards per play')} home={v(home, 'yardsPerPlay')} away={v(away, 'yardsPerPlay')} fmt={x => x.toFixed(1)} />
        <StatBars label={t('Passing yards')} home={v(home, 'passYards')} away={v(away, 'passYards')} />
        <StatBars label={t('Rushing yards')} home={v(home, 'rushYards')} away={v(away, 'rushYards')} />
        <StatBars label={t('First downs')} home={v(home, 'firstDowns')} away={v(away, 'firstDowns')} />
        <StatBars label={t('Third downs converted')} home={pct(home?.third)} away={pct(away?.third)} fmt={x => `${Math.round(x)}%`} />
        <StatBars label={t('Red-zone trips scored')} home={pct(home?.redZone)} away={pct(away?.redZone)} fmt={x => `${Math.round(x)}%`} />
        <StatBars label={t('Turnovers')} home={v(home, 'turnovers')} away={v(away, 'turnovers')} lowerBetter />
        <StatBars label={t('Sacks')} home={v(home, 'sacks')} away={v(away, 'sacks')} />
      </div>
    </Card>
  )
}

const PLAYER_GROUPS: { re: RegExp; label: string }[] = [
  { re: /^passing$/i, label: 'Passing' }, { re: /^rushing$/i, label: 'Rushing' }, { re: /^receiving$/i, label: 'Receiving' }, { re: /defens/i, label: 'Defense' }
]
function Players({ g, data, at }: { g: Game; data: { home: Groups; away: Groups }; at?: number }) {
  return (
    <>
      {PLAYER_GROUPS.map(pg => {
        const rows = (['home', 'away'] as const).flatMap(s => {
          const key = Object.keys(data[s] || {}).find(k => pg.re.test(k))
          return key ? data[s][key].map(p => ({ ...p, team: g[s] })) : []
        })
        if (!rows.length) return null
        const cols = [...new Set(rows.flatMap(r => Object.keys(r.stats)))].slice(0, 7)
        return (
          <Card key={pg.label} title={t(pg.label)} action={at ? <LiveBoxLabel at={at} /> : undefined}>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm min-w-[520px]">
                <thead><tr className="text-[10px] uppercase tracking-wide text-faint"><th className="text-start font-semibold py-1 px-1">{t('Player')}</th>{cols.map(c => <th key={c} className="text-end font-semibold py-1 px-1">{c}</th>)}</tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={`${r.team.id}-${r.id}`} className="border-t border-line/50">
                      <td className="py-1.5 px-1"><Link to={playerHref('american-football', r.id, r.name)!} className="flex items-center gap-2 hover:text-accent"><TeamLogo team={r.team} size={14} /><span className="truncate">{r.name}</span></Link></td>
                      {cols.map(c => <td key={c} className="py-1.5 px-1 text-end num text-muted">{r.stats[c] ?? '–'}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      })}
    </>
  )
}

function Injuries({ g, data }: { g: Game; data: { home: Injury[]; away: Injury[] } }) {
  return (
    <Card title={t('Injuries')}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
        {(['home', 'away'] as const).map(s => (
          <div key={s} className="min-w-0">
            <div className="flex items-center gap-2 mb-3"><TeamLogo team={g[s]} size={22} /><NameLink to={href.nflTeam(g[s].id, g[s].name)} className="font-display font-bold text-ink truncate">{g[s].name}</NameLink></div>
            {data[s].length === 0 ? <p className="text-sm text-faint">{t('No injuries reported.')}</p> : (
              <ul className="divide-y divide-line/50">
                {data[s].map(i => (
                  <li key={i.id} className="py-1.5 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link to={playerHref('american-football', i.id, i.name)!} className="text-ink hover:text-accent truncate">{i.name}</Link>
                      <span className={`text-xs font-bold ${/out|ir|reserve/i.test(i.status || '') ? 'text-loss' : 'text-draw'}`}>{i.status || '–'}</span>
                    </div>
                    {i.description && <div className="text-xs text-faint">{i.description}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

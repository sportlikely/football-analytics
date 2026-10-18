import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, lang } from '../../lib/i18n'
import { useAuth } from '../../lib/auth'
import { useReveal } from '../../lib/reveal'
import YourPicks from '../../components/YourPicks'
import { newerWinnerLive } from '../../lib/liveState'
import { BB_STATUS, liveLabel, spreadText, bbTeamFav, bbLeagueFav, useBbConfig, type BbGame as Game } from '../../lib/bb'
import { FavStar } from '../../lib/favorites'
import { Card, TeamLogo, LiveChanceBox, rid, rstatus } from './parts'
import { GAME_RELOAD } from '../../components/UnlockPrompt'
import type { Standings } from './BbLeague'
import { StatsTab, RestTab, H2HTab, StandingsTab } from './GameTabs'
import { MarketsCard, CompareCard, PlayersCard, ModelTable, type Markets, type ModelInfo, type GamePlayer } from './GameExtras'
import GamePage, { useGameTab, GameNews, fmtGameDate, fmtGameTime, halfTimeOf, type GameTab } from '../../components/sport/game/GamePage'
import WinnerPrediction, { type WhyRow } from '../../components/sport/game/WinnerPrediction'
import GamePreview from '../../components/sport/game/GamePreview'
import Highlights from '../../components/sport/game/Highlights'

export interface Avg {
  games: number; won: number; lost: number; pointsFor: number; pointsAgainst: number
  fgPct: number | null; threePct: number | null; threeMade: number | null; threeAttempts: number | null; ftPct: number | null
  rebounds: number | null; assists: number | null; steals: number | null; blocks: number | null; turnovers: number | null
  withStats: number; form: ('W' | 'L')[]
}
export interface Brief { id: number; kickoff: string; league: string; home: boolean; opponent: string; opponentLogo: string | null; score: string | null; result: 'W' | 'L' | 'T' | null }
/** fix174: NFL + college use the same tab — backToBack = a short week, offBye / bye = the bye week */
export interface Sched { restDays: number | null; backToBack: boolean; games7: number; away7: number; nextIn: number | null; recent: Brief[]; upcoming: Brief[]; offBye?: boolean; bye?: string | null }
interface BoxPlayer { id: number; name: string; starter: boolean; minutes: number | null; points: number | null; fgm: number | null; fga: number | null; tpm: number | null; tpa: number | null; ftm: number | null; fta: number | null; rebounds: number | null; assists: number | null; steals?: number | null; blocks?: number | null; turnovers?: number | null; plusMinus?: number | null }
interface BoxSide { team: any; players: BoxPlayer[] }
interface Detail {
  game: Game
  why: { kind: 'strength' | 'home' | 'b2b' | 'b2bBoth' | 'injuries' | 'attack' | 'talent'; side: 'H' | 'A'; points: number }[]
  injuries?: { home: Injury[]; away: Injury[] } | null
  ratings: { home: { attack: number; defence: number; net: number } | null; away: { attack: number; defence: number; net: number } | null } | null
  stats: { home: Avg | null; away: Avg | null }
  schedule: { home: Sched; away: Sched }
  h2h: H2H[]
  box: { home: BoxSide; away: BoxSide } | null
  standings: Standings | null
  preview?: { home: PreviewSide; away: PreviewSide; h2h: { games: number; homeWins: number; awayWins: number } }
  markets?: Markets | null
  model?: ModelInfo | null
  players?: { home: GamePlayer[]; away: GamePlayer[] }
  /** fix124: English text preview (the same text search engines get; no pick, no %) */
  writeup?: string | null
}
export interface H2H { id: number; kickoff: string; home: string; away: string; homeId: number; score: [number, number]; league: string }
interface Profile { games: number; fgPct: number | null; threePct: number | null; threeAttempts: number | null; ftPct: number | null; rebounds: number | null; assists: number | null; turnovers: number | null; steals: number | null; blocks: number | null }
interface PreviewSide {
  season: string; previousSeason: boolean
  splits: { won: number; lost: number; homeWon: number; homeLost: number; awayWon: number; awayLost: number; b2bWon: number; b2bLost: number; marginHome: number | null; marginAway: number | null; closeWon: number; closeLost: number; games: number }
  streak: { kind: 'W' | 'L'; n: number } | null
  last10: { won: number; lost: number }
  pointsFor: number | null; pointsAgainst: number | null
  ranks: { attack: number; defence: number; overall: number; of: number } | null
  profile: { team: Profile | null; league: Profile | null }
}
interface Injury { name: string; status: string; weight: number; comment: string | null; minutes: number | null; playerId: number | null }

const TABS = ['prediction', 'box', 'stats', 'players', 'rest', 'h2h', 'table', 'highlights']

/** A basketball game: the shared game page (football's match page, fix152c) with basketball's data and tabs. */
export default function BbGame() {
  const { id = '' } = useParams()
  const { access } = useAuth()
  const cfg = useBbConfig()
  const [d, setD] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, pickTab] = useGameTab(TABS, { injuries: 'players' })

  useEffect(() => {
    let cancelled = false
    setD(null); setError(null)
    const load = () =>
      axios.get(`${API_URL}/basketball/game/${id}`)
        .then(r => { if (!cancelled) setD(prev => (prev && prev.game.id === r.data.data?.game?.id ? { ...r.data.data, game: newerWinnerLive(prev.game, r.data.data.game) } : r.data.data)) }) // fix165: never backwards
        .catch(e => { if (!cancelled) setError(e?.response?.status === 404 ? t('Game not found') : t('Could not load the game')) })
    load()
    const iv = setInterval(load, 60000)
    window.addEventListener(GAME_RELOAD, load) // fix144: a free pick opened this game
    return () => { cancelled = true; clearInterval(iv); window.removeEventListener(GAME_RELOAD, load) }
  }, [id, access])
  useEffect(() => {
    if (d) document.title = t('{0} · SportLikely', { 0: `${d.game.home.name} vs ${d.game.away.name}` })
  }, [d?.game.id])

  if (error) return <div className="max-w-5xl mx-auto px-4 py-10"><Link to="/basketball/games" className="text-sm text-muted hover:text-ink">{t('← All games')}</Link><div className="mt-4 card border-loss/40 text-loss rounded-lg p-4">{error}</div></div>
  if (!d) return <div className="max-w-5xl mx-auto px-4 py-16 text-center text-muted">{t('Loading game…')}</div>

  const g = d.game
  const p = g.prediction
  const live = g.state === 'live', done = g.state === 'done'
  const showScore = !!g.score && g.state !== 'upcoming'
  const pick = p?.pick || null
  const q = g.quarters
  const showQ = showScore && q && q.home.some(x => x !== null)
  const side = (team: Game['home']) => ({
    name: team.name, logo: <TeamLogo team={team} size={72} />, href: `/basketball/team/${team.id}#analysis`,
    title: t('{0}: team page', { 0: team.name }), linkLabel: t('Team page →'), star: <FavStar size="sm" fav={bbTeamFav(team, g.league.code)} />
  })

  const tabs: GameTab[] = [
    {
      id: 'prediction', label: t('Prediction'), hint: '',
      render: () => (
        <>
          <WinnerPrediction
            rid={rid(g)} status={rstatus(g)} p={p} home={g.home} away={g.away} upcoming={g.state === 'upcoming'} model="bb-v3"
            saved={t('Saved before tip-off')} updated={t('Updated until tip-off')} strongAt={70} showLockedPick
            stats={[
              { label: t('Point spread'), value: spreadText(g) || '–' },
              { label: t('Predicted score'), value: p?.score ? `${p.score.home}–${p.score.away}` : '–' },
              { label: t('Total points'), value: typeof p?.total === 'number' ? p.total.toFixed(1) : '–' }
            ]}
            why={bbWhy(d)}
            howCalc={d.model ? <ModelTable g={g} model={d.model} ratings={d.ratings} /> : undefined}
            badges={g.resultCheck ? <span title={t('The final score from our data provider looks wrong. This game doesn’t count in our record until it is checked.')} className="ml-auto rounded-full px-3 py-1 text-xs font-bold bg-draw/15 text-draw">{t('Result being checked')}</span> : undefined}
            noPrediction={t('No prediction for this game.')}
          />
          {lang === 'en' && d.writeup && <GamePreview text={d.writeup} />}
          <YourPicks sport="bb" gameId={g.id} home={g.home.name} away={g.away.name} />
          <MarketsGate d={d} />
          {d.preview && <CompareCard g={g} home={d.preview.home} away={d.preview.away} table={d.standings ? d.standings.groups.flatMap(x => x.rows) : null} form={d.stats.home && d.stats.away ? { home: d.stats.home.form, away: d.stats.away.form } : null} />}
          {d.players && <PlayersCard g={g} home={d.players.home} away={d.players.away} limit={4} title={t('Players to watch')} />}
          <AnalysisCard d={d} />
          <GameNews home={{ sport: 'basketball', teamId: g.home.id }} away={{ sport: 'basketball', teamId: g.away.id }} />
        </>
      )
    },
    ...(d.box ? [{ id: 'box', label: t('Box score'), short: t('Box'), hint: live ? t('Live player stats') : t('Every player: points, shooting, rebounds, assists'), live, render: () => <BoxTab d={d} /> }] : []),
    { id: 'stats', label: t('Statistics'), short: t('Stats'), hint: t('Averages from the last 10 games'), render: () => <StatsTab g={g} home={d.stats.home} away={d.stats.away} /> },
    {
      id: 'players', label: d.injuries ? t('Players & injuries') : t('Players'), short: t('Players'), hint: d.injuries ? t('Key players and the NBA injury reports') : t('Each team’s key players this season'),
      render: () => (
        <>
          {d.injuries && <InjuriesCard d={d} />}
          {d.players && <PlayersCard g={g} home={d.players.home} away={d.players.away} limit={10} title={t('Key players')} />}
        </>
      )
    },
    { id: 'rest', label: t('Schedule & rest'), short: t('Rest'), hint: t('Back-to-backs, rest days and the next game'), render: () => <RestTab g={g} home={d.schedule.home} away={d.schedule.away} /> },
    { id: 'h2h', label: t('H2H'), hint: t('Last meetings and recent form'), render: () => <H2HTab g={g} list={d.h2h} /> },
    ...(d.standings ? [{ id: 'table', label: t('Standings'), short: t('Table'), hint: t('{0} table', { 0: g.league.name }), render: () => <StandingsTab g={g} data={d.standings!} /> }] : []),
    // fix174: official highlights after the final buzzer (the league's / clubs' own YouTube channels)
    ...(done ? [{ id: 'highlights', label: t('Highlights'), short: t('Video'), hint: t('Official video'), render: () => <Highlights url={`${API_URL}/basketball/game/${g.id}/highlights`} /> }] : [])
  ]

  return (
    <GamePage
      back={{ to: '/basketball/games', label: t('All games') }}
      srTitle={`${g.home.name} vs ${g.away.name} · ${g.league.name} ${t('prediction')}`}
      league={{
        name: g.league.name, href: `/basketball/league/${g.league.code}`, logo: cfg?.leagues.find(l => l.code === g.league.code)?.logo || null,
        star: <FavStar size="sm" fav={bbLeagueFav({ code: g.league.code, name: g.league.name, logo: cfg?.leagues.find(l => l.code === g.league.code)?.logo || null })} />,
        bits: [g.round].filter((x): x is string => !!x),
        badges: <>
          {g.preseason && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-draw/15 text-draw">{t('Pre-season')}</span>}
          {g.league.trial && <span title={t("We added this league recently. Its predictions are being tested and don’t count in our public record yet.")} className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-draw/15 text-draw">{t("New league · in testing")}</span>}
        </>
      }}
      date={fmtGameDate(g.kickoff)}
      home={side(g.home)}
      away={side(g.away)}
      score={showScore ? g.score : null}
      time={fmtGameTime(g.kickoff)}
      status={{
        kind: live ? 'live' : done ? 'done' : g.state === 'off' ? 'halted' : 'upcoming',
        text: live ? liveLabel(g) : done ? (BB_STATUS[g.status] || t('Final')) : g.state === 'off' ? (BB_STATUS[g.status] || g.status) : t('TIP-OFF')
      }}
      scoreSub={(() => { const ht = live || done ? halfTimeOf(g.quarters) : null; return ht ? <div className="num text-xs text-faint mt-1">{t('HT')} {ht.home}–{ht.away}</div> : undefined })()}
      statusNote={g.state === 'off' ? (
        <p className="mt-2 max-w-[260px] mx-auto text-[11px] text-muted">
          {/CANC|ABD/.test(g.status) ? t('This game was cancelled. It does not count in our record.') : t('This game was postponed. Our prediction stays until the new date.')}
        </p>
      ) : undefined}
      pickVar={pick === 'H' ? '--home' : pick === 'A' ? '--away' : null}
      footer={showQ ? (
        <div className="overflow-x-auto">
          <table className="mx-auto text-xs num">
            <thead><tr className="text-faint"><th className="px-3 text-left font-semibold" />{['Q1', 'Q2', 'Q3', 'Q4', 'OT'].map((x, i) => (i < 4 || q!.home[4] !== null) && <th key={x} className="px-3 font-semibold">{t(x)}</th>)}<th className="px-3 font-semibold">{t('Total')}</th></tr></thead>
            <tbody>
              {(['home', 'away'] as const).map(s => (
                <tr key={s}>
                  <td className="px-3 py-0.5 text-muted font-semibold font-sans text-left"><NameLink to={href.bbTeam((s === 'home' ? g.home : g.away).id)}>{(s === 'home' ? g.home : g.away).name}</NameLink></td>
                  {q![s].map((v, i) => (i < 4 || q!.home[4] !== null) && <td key={i} className="px-3 text-center text-ink">{v ?? '–'}</td>)}
                  <td className="px-3 text-center text-ink font-bold">{s === 'home' ? g.score!.home : g.score!.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : undefined}
      afterHero={<>
        {live && <LiveChanceBox g={g} />}
        {g.corrected && done && <p className="mt-2 text-center text-[11px] text-faint">{t('Final score corrected by us: our data provider had it wrong.')}</p>}
        {access === 'admin' && done && <ResultAdmin game={g} onDone={() => axios.get(`${API_URL}/basketball/game/${id}`).then(r => setD(r.data.data)).catch(() => undefined)} />}
      </>}
      tabs={tabs}
      tab={tab}
      onTab={pickTab}
    />
  )
}

/** "Why we think so": the model's own reasons in plain words (ratings, home court, back-to-backs, talent, injuries). */
function bbWhy(d: Detail): WhyRow[] {
  const g = d.game
  return d.why.map(w => {
    const team = w.side === 'H' ? g.home : g.away
    const other = w.side === 'H' ? g.away : g.home
    const pv = d.preview
    const mine = pv ? (w.side === 'H' ? pv.home : pv.away) : null
    const theirs = pv ? (w.side === 'H' ? pv.away : pv.home) : null
    const pts = Math.abs(w.points).toFixed(1)
    let text: string
    let tone: 'H' | 'A' | 'N' = w.side
    if (w.kind === 'strength') {
      text = mine?.ranks && theirs?.ranks
        ? t('{0} are the stronger team: about {1} points per game better in our ratings (overall rank {2} against {3}, out of {4}).', { 0: team.name, 1: pts, 2: mine.ranks.overall, 3: theirs.ranks.overall, 4: mine.ranks.of })
        : t('{0} are the stronger team: about {1} points per game better in our ratings.', { 0: team.name, 1: pts })
    } else if (w.kind === 'attack') {
      const dr = theirs?.ranks?.defence
      text = w.points > 0
        ? (dr ? t('{0} should score about {1} points more than an average team against {2}’s defence (rank {3}).', { 0: team.name, 1: pts, 2: other.name, 3: dr }) : t('{0} should score about {1} points more than an average team against {2}’s defence.', { 0: team.name, 1: pts, 2: other.name }))
        : (dr ? t('{0}’s defence (rank {1}) should hold {2} to about {3} points below an average team.', { 0: other.name, 1: dr, 2: team.name, 3: pts }) : t('{0}’s defence should hold {1} to about {2} points below an average team.', { 0: other.name, 1: team.name, 2: pts }))
      tone = w.points > 0 ? w.side : (w.side === 'H' ? 'A' : 'H')
    } else if (w.kind === 'home') {
      const sp = mine?.splits
      text = sp && sp.homeWon + sp.homeLost > 0 && !mine?.previousSeason
        ? t('Home court is worth about {0} points to {1} (home record this season: {2}–{3}).', { 0: pts, 1: team.name, 2: sp.homeWon, 3: sp.homeLost })
        : t('Home court is worth about {0} points to {1}.', { 0: pts, 1: team.name })
    } else if (w.kind === 'b2b') {
      text = t('{0} played last night (second game of a back-to-back), which costs about {1} points.', { 0: other.name, 1: pts })
    } else if (w.kind === 'b2bBoth') {
      text = t('Both teams played last night, so tiredness evens out.')
      tone = 'N'
    } else if (w.kind === 'talent') {
      text = t('{0} have more talent on the floor right now (the players they used in their latest games): about {1} points.', { 0: team.name, 1: pts })
    } else {
      text = t('Injuries hurt {0} more: they are missing about {1} points of production.', { 0: other.name, 1: pts })
    }
    const shown = w.points !== 0 && w.kind !== 'b2bBoth'
    return { tone, text, sub: w.kind === 'attack', points: shown ? `${tone === 'N' ? '' : '+'}${pts} ${t('pts')}` : null }
  })
}


/** Written preview: form, home/away record, ratings, rest, shooting, meetings and our verdict — in plain sentences. */
function AnalysisCard({ d }: { d: Detail }) {
  const g = d.game
  const pv = d.preview
  const { hidden } = useReveal(rid(g), rstatus(g), !!g.prediction && !g.prediction.locked)
  if (!pv) return null
  const H = g.home.name, A = g.away.name
  const paras: string[] = []
  const rec = (side: PreviewSide, name: string, home: boolean) => {
    const s = side.splits
    if (!s.games) return null
    const where = home ? t('{0}–{1} at home', { 0: s.homeWon, 1: s.homeLost }) : t('{0}–{1} on the road', { 0: s.awayWon, 1: s.awayLost })
    return side.previousSeason
      ? t('Last season {0} went {1}–{2} ({3}).', { 0: name, 1: s.won, 2: s.lost, 3: where })
      : t('{0} are {1}–{2} this season ({3}) and have won {4} of their last {5}.', { 0: name, 1: s.won, 2: s.lost, 3: where, 4: side.last10.won, 5: side.last10.won + side.last10.lost })
  }
  const form = [rec(pv.home, H, true), rec(pv.away, A, false)].filter(Boolean).join(' ')
  if (form) paras.push(form)
  const streaks = ([[pv.home, H], [pv.away, A]] as const)
    .filter(([s]) => !s.previousSeason && s.streak && s.streak.n >= 3)
    .map(([s, n]) => (s.streak!.kind === 'W' ? t('{0} have won {1} in a row.', { 0: n, 1: s.streak!.n }) : t('{0} have lost {1} in a row.', { 0: n, 1: s.streak!.n })))
  if (streaks.length) paras.push(streaks.join(' '))
  const rh = pv.home.ranks, ra = pv.away.ranks
  if (rh && ra) {
    paras.push(t('In our ratings {0} rank {1} in attack and {2} in defence out of {3} teams; {4} rank {5} and {6}.', { 0: H, 1: rh.attack, 2: rh.defence, 3: rh.of, 4: A, 5: ra.attack, 6: ra.defence }))
    // the key matchup: the bigger gap between one side's attack and the other side's defence
    const gapH = ra.defence - rh.attack, gapA = rh.defence - ra.attack
    const [att, def, ar, dr] = gapH >= gapA ? [H, A, rh.attack, ra.defence] : [A, H, ra.attack, rh.defence]
    if (Math.abs(gapH - gapA) >= 3) paras.push(t('The key matchup: {0}’s attack (rank {1}) against {2}’s defence (rank {3}).', { 0: att, 1: ar, 2: def, 3: dr }))
  }
  const sh = d.schedule.home, sa = d.schedule.away
  if (sh.backToBack || sa.backToBack) {
    paras.push([sh.backToBack ? t('{0} played last night (second game of a back-to-back).', { 0: H }) : '', sa.backToBack ? t('{0} played last night (second game of a back-to-back).', { 0: A }) : ''].filter(Boolean).join(' '))
  } else if (sh.restDays !== null && sa.restDays !== null && Math.abs(Math.floor(sh.restDays) - Math.floor(sa.restDays)) >= 2) {
    const fresher = sh.restDays > sa.restDays ? H : A
    paras.push(t('{0} are fresher, with {1} more days of rest.', { 0: fresher, 1: Math.abs(Math.floor(sh.restDays) - Math.floor(sa.restDays)) }))
  }
  const ph = pv.home.profile, pa = pv.away.profile
  if (ph.team && pa.team && ph.league && ph.team.threePct !== null && pa.team.threePct !== null && ph.league.threePct !== null) {
    const lg = ph.league.threePct
    const best = ph.team.threePct - lg >= pa.team.threePct - lg ? [H, ph.team.threePct] as const : [A, pa.team.threePct] as const
    if (Math.abs(best[1] - lg) >= 1.5) paras.push(best[1] > lg
      ? t('{0} shoot {1}% from three, above the league average of {2}%.', { 0: best[0], 1: best[1], 2: lg })
      : t('Both teams shoot below the league average from three ({0}%).', { 0: lg }))
  }
  if (d.injuries) {
    const key = (list: Injury[], name: string) => {
      const out = list.filter(x => x.weight >= 1 && (x.minutes || 0) >= 12).map(x => x.name)
      const maybe = list.filter(x => x.weight >= 0.4 && x.weight < 1 && (x.minutes || 0) >= 12).map(x => x.name)
      return [out.length ? t('{0} will be without {1}.', { 0: name, 1: out.join(', ') }) : '', maybe.length ? t('For {0}, {1} may not play.', { 0: name, 1: maybe.join(', ') }) : ''].filter(Boolean).join(' ')
    }
    const txt = [key(d.injuries.home, H), key(d.injuries.away, A)].filter(Boolean).join(' ')
    if (txt) paras.push(txt)
  }
  const p = g.prediction
  if (pv.h2h.games > 0) {
    // one-sided head-to-head (Oct 2026): say it, and whether our pick agrees. Tested: in basketball past meetings add
    // nothing once form, rest and rosters are known, so they don't move the percentages — but readers should see them.
    const hw = pv.h2h.homeWins, aw = pv.h2h.awayWins, n = pv.h2h.games
    const dom = n >= 4 ? (hw / n >= 0.75 ? 'H' : aw / n >= 0.75 ? 'A' : null) : null
    const pickSide = p?.pick && !hidden ? p.pick : null
    if (dom && pickSide) {
      const dn = dom === 'H' ? H : A, dw = dom === 'H' ? hw : aw
      paras.push(dom === pickSide
        ? t('{0} also have the upper hand in this matchup: they won {1} of the last {2} meetings.', { 0: dn, 1: dw, 2: n })
        : t('{0} won {1} of the last {2} meetings, but our numbers still favour {3}: in basketball past meetings say little once current form, rest and the rosters are known.', { 0: dn, 1: dw, 2: n, 3: pickSide === 'H' ? H : A }))
    } else paras.push(t('In their last {0} meetings {1} won {2} and {3} won {4}.', { 0: n, 1: H, 2: hw, 3: A, 4: aw }))
  }
  if (p?.pick && !hidden) {
    const team = p.pick === 'H' ? H : A
    paras.push(!p.locked && typeof p.pHome === 'number'
      ? t('Our verdict: {0} with {1}%, by about {2} points, with around {3} points in total.', { 0: team, 1: Math.round(p.pick === 'H' ? p.pHome : p.pAway!), 2: Math.abs(p.spread || 0).toFixed(1), 3: (p.total || 0).toFixed(0) })
      : t('Our pick: {0}.', { 0: team }))
  }
  if (!paras.length) return null
  return (
    <Card title={g.state === 'upcoming' ? t('Our analysis') : t('Our analysis before the game')}>
      <div className="space-y-3 text-[15px] leading-relaxed text-ink/90">
        {paras.map((x, i) => <p key={i}>{x}</p>)}
      </div>
      <p className="mt-4 text-[11px] text-faint">{t('Written from the numbers: this season’s results, our team ratings, the schedule and box scores.')}</p>
    </Card>
  )
}

/** NBA injury list of both teams; regulars (12+ minutes) are the ones the model takes points off for. */
function InjuriesCard({ d }: { d: Detail }) {
  const g = d.game
  const side = (team: Game['home'], list: Injury[], pts?: number) => (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <TeamLogo team={team} size={22} />
        <NameLink to={href.bbTeam(team.id)} className="font-display font-bold text-ink">{team.name}</NameLink>
        {pts ? <span className="ml-auto text-xs font-bold text-loss num">−{pts.toFixed(1)} {t('pts')}</span> : null}
      </div>
      {list.length === 0 ? <p className="text-sm text-faint">{t('No injuries listed.')}</p> : (
        <ul className="space-y-2">
          {list.map(x => (
            <li key={x.name} className="text-sm">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${x.weight >= 1 ? 'bg-loss' : x.weight >= 0.4 ? 'bg-draw' : 'bg-faint'}`} />
                {x.playerId ? <Link to={`/basketball/player/${x.playerId}`} className="text-ink font-semibold truncate hover:text-accent">{x.name}</Link> : <span className="text-ink font-semibold truncate">{x.name}</span>}
                {x.minutes !== null && <span className="text-[11px] text-faint num">{t('{0} min', { 0: x.minutes })}</span>}
                <span className={`ml-auto text-xs font-bold ${x.weight >= 1 ? 'text-loss' : 'text-draw'}`}>{x.status}</span>
              </div>
              {x.comment && <p className="mt-0.5 ml-4 text-xs text-muted line-clamp-2">{x.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <Card title={t('Injuries')} action={<span className="text-xs text-faint">{t('Updated every 15 minutes')}</span>}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
        {side(g.home, d.injuries!.home, g.prediction?.injHome)}
        {side(g.away, d.injuries!.away, g.prediction?.injAway)}
      </div>
      <p className="mt-4 text-[11px] text-faint">{t('Our prediction takes off the points a team is expected to lose without its injured regulars (by minutes and production; doubtful and questionable players count partly).')}</p>
    </Card>
  )
}

function BoxTab({ d }: { d: Detail }) {
  const g = d.game
  const side = (team: Game['home'], s: BoxSide) => {
    const more = s.players.some(p => p.plusMinus !== undefined && p.plusMinus !== null)
    return (
    <Card title={<NameLink to={href.bbTeam(team.id)}>{team.name}</NameLink>}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs num">
          <thead>
            <tr className="text-faint">
              <th className="text-left font-semibold py-1">{t('Player')}</th>
              <th className="text-right font-semibold px-1">{t('MIN')}</th>
              <th className="text-right font-semibold px-1">{t('PTS')}</th>
              <th className="text-right font-semibold px-1">{t('FG')}</th>
              <th className="text-right font-semibold px-1">{t('3PT')}</th>
              <th className="text-right font-semibold px-1">{t('FT')}</th>
              <th className="text-right font-semibold px-1">{t('REB')}</th>
              <th className="text-right font-semibold px-1">{t('AST')}</th>
              {more && <><th className="text-right font-semibold px-1">{t('STL')}</th><th className="text-right font-semibold px-1">{t('BLK')}</th><th className="text-right font-semibold px-1">{t('TO')}</th><th className="text-right font-semibold px-1">+/−</th></>}
            </tr>
          </thead>
          <tbody>
            {s.players.map(pl => (
              <tr key={pl.id} className="border-t border-line/40">
                <td className="py-1 font-sans text-ink whitespace-nowrap"><Link to={`/basketball/player/${pl.id}`} className="hover:text-accent">{pl.name}</Link>{pl.starter && <span className="ml-1 text-[9px] text-accent font-bold">{t('S')}</span>}</td>
                <td className="text-right px-1 text-muted">{pl.minutes !== null ? Math.round(pl.minutes) : '–'}</td>
                <td className="text-right px-1 text-ink font-bold">{pl.points ?? '–'}</td>
                <td className="text-right px-1 text-muted">{pl.fgm ?? 0}/{pl.fga ?? 0}</td>
                <td className="text-right px-1 text-muted">{pl.tpm ?? 0}/{pl.tpa ?? 0}</td>
                <td className="text-right px-1 text-muted">{pl.ftm ?? 0}/{pl.fta ?? 0}</td>
                <td className="text-right px-1 text-muted">{pl.rebounds ?? '–'}</td>
                <td className="text-right px-1 text-muted">{pl.assists ?? '–'}</td>
                {more && <>
                  <td className="text-right px-1 text-muted">{pl.steals ?? '–'}</td>
                  <td className="text-right px-1 text-muted">{pl.blocks ?? '–'}</td>
                  <td className="text-right px-1 text-muted">{pl.turnovers ?? '–'}</td>
                  <td className={`text-right px-1 ${pl.plusMinus == null ? 'text-faint' : pl.plusMinus > 0 ? 'text-win' : pl.plusMinus < 0 ? 'text-loss' : 'text-muted'}`}>{pl.plusMinus == null ? '–' : pl.plusMinus > 0 ? `+${pl.plusMinus}` : pl.plusMinus}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
    )
  }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {side(g.home, d.box!.home)}
      {side(g.away, d.box!.away)}
    </div>
  )
}

/** Points markets, shown once the prediction is uncovered (never under the reveal cover). */
function MarketsGate({ d }: { d: Detail }) {
  const g = d.game
  const { hidden } = useReveal(rid(g), rstatus(g), !!g.prediction && !g.prediction.locked)
  if (!d.markets || hidden) return null
  return <MarketsCard g={g} m={d.markets} />
}

/** Admin only: correct a wrong final score (swap home/away, set it, or confirm the provider). */
function ResultAdmin({ game, onDone }: { game: Game; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [hs, setHs] = useState(String(game.score?.home ?? ''))
  const [as_, setAs] = useState(String(game.score?.away ?? ''))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true); setMsg(null)
    try { await axios.post(`${API_URL}/admin/bb/game/${game.id}/result`, { action, ...extra }); setMsg('Saved.'); onDone() }
    catch (e: any) { setMsg(e?.response?.data?.error || 'Failed.') } finally { setBusy(false) }
  }
  const btn = 'rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink hover:border-faint disabled:opacity-60'
  return (
    <div className="mt-2 text-center">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-faint hover:text-ink underline">{game.resultCheck ? 'Admin: result flagged — check it' : 'Admin: correct the result'}</button>
      ) : (
        <div className="inline-flex flex-wrap items-center justify-center gap-2 rounded-xl border border-line bg-surface2/50 px-3 py-2 text-xs">
          <span className="text-muted">{game.home.name}</span>
          <input value={hs} onChange={e => setHs(e.target.value.replace(/\D/g, ''))} className="w-14 rounded-md border border-line bg-bg px-2 py-1 text-center num" inputMode="numeric" />
          <span className="text-faint">:</span>
          <input value={as_} onChange={e => setAs(e.target.value.replace(/\D/g, ''))} className="w-14 rounded-md border border-line bg-bg px-2 py-1 text-center num" inputMode="numeric" />
          <span className="text-muted">{game.away.name}</span>
          <button type="button" disabled={busy} onClick={() => act('set', { hs: Number(hs), as_: Number(as_) })} className={btn}>Save score</button>
          <button type="button" disabled={busy} onClick={() => act('swap')} className={btn}>Swap home/away</button>
          {game.resultCheck && <button type="button" disabled={busy} onClick={() => act('confirm')} className={btn}>Provider is right</button>}
          {game.corrected && <button type="button" disabled={busy} onClick={() => act('undo')} className={btn}>Undo correction</button>}
          <button type="button" onClick={() => setOpen(false)} className="text-faint">Close</button>
          {msg && <span className="text-muted">{msg}</span>}
        </div>
      )}
    </div>
  )
}

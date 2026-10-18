import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { FavStar } from '../../lib/favorites'
import { NFL_STATUS, weekLabel, nick, nflTeamFav, nflRid, nflRstatus, setNflLeague, nflBase, nflLeagueName, nflModelOf, nflStrongAt, type NflGame as Game, type NflSide, type NflPred } from '../../lib/nfl'
import { Card, Skeleton, TeamLogo } from '../bb/parts'
import { GAME_RELOAD } from '../../components/UnlockPrompt'
import YourPicks from '../../components/YourPicks'
import { newerWinnerLive } from '../../lib/liveState'
import { StatBars, LeagueSwitch } from './parts'
import GamePage, { useGameTab, GameNews, fmtGameDate, fmtGameTime, halfTimeOf, type GameTab } from '../../components/sport/game/GamePage'
import WinnerPrediction, { type WhyRow } from '../../components/sport/game/WinnerPrediction'

type Box = {
  firstDowns: number | null; plays: number | null; yards: number | null; yardsPerPlay: number | null; passYards: number | null; rushYards: number | null; rushAttempts: number | null
  third: [number, number] | null; fourth: [number, number] | null; redZone: [number, number] | null; turnovers: number | null; penalties: any; possession: any
  sacks: number | null; sacked: number | null; interceptions: number | null; fumblesRecovered: number | null
}
type Groups = Record<string, { id: number; name: string; image: string | null; stats: Record<string, string> }[]>
interface FormRow { id: number; kickoff: string; opponent: NflSide; home: boolean; for: number; against: number; result: 'W' | 'L' | 'T' }
interface Injury { id: number; name: string; image: string | null; status: string | null; description: string | null; date: string | null }
interface Data {
  game: Game; form: { home: FormRow[]; away: FormRow[] }; h2h: Game[]; teamStats: { home: Box | null; away: Box | null } | null
  players: { home: Groups; away: Groups } | null; injuries: { home: Injury[]; away: Injury[] } | null; prediction: NflPred | null
}
const TABS = ['prediction', 'stats', 'players', 'h2h']

/**
 * NFL + college game page: the shared game page (football's match page, fix152c) — Prediction · Statistics ·
 * Players & injuries · H2H, the score by quarter under the hero.
 */
export default function NflGame() {
  const { id } = useParams()
  const [d, setD] = useState<Data | null>(null)
  const [missing, setMissing] = useState(false)
  const [tab, pickTab] = useGameTab(TABS, { overview: 'h2h', injuries: 'players' })
  useEffect(() => {
    setD(null); setMissing(false)
    const load = () => axios.get(`${API_URL}/nfl/game/${id}`).then(r => setD(prev => (prev && prev.game.id === r.data.data?.game?.id ? { ...r.data.data, game: newerWinnerLive(prev.game, r.data.data.game) } : r.data.data))) // fix165: never backwards.catch(e => { if (e?.response?.status === 404) setMissing(true) })
    load()
    const iv = setInterval(() => { if (document.visibilityState === 'visible') load() }, 30 * 1000)
    window.addEventListener(GAME_RELOAD, load) // fix144: a free pick opened this game
    return () => { clearInterval(iv); window.removeEventListener(GAME_RELOAD, load) }
  }, [id])
  // the same title search engines get (seo.ts): "Chiefs vs Bills · NFL Week 7 | SportLikely"
  // fix142: college titles use the school names ("Alabama vs Georgia · College football Week 7")
  useEffect(() => {
    if (!d) return
    const lg = d.game.league || 1
    setNflLeague(lg)
    document.title = `${nick(d.game.home.name, lg)} vs ${nick(d.game.away.name, lg)} · ${lg === 2 ? 'College football' : 'NFL'} ${d.game.weekKey === 'post' ? (lg === 2 ? 'Bowls' : 'Playoffs') : `Week ${d.game.weekKey}`} | SportLikely`
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
    name: team.name, logo: <TeamLogo team={team} size={72} />, href: `/american-football/team/${team.id}`,
    title: t('{0}: team page', { 0: team.name }), linkLabel: t('Team page →'), star: <FavStar fav={nflTeamFav(team)} size="sm" />
  })
  const hasPlayers = !!(d.players || d.injuries)

  const tabs: GameTab[] = [
    {
      id: 'prediction', label: t('Prediction'), hint: '',
      render: () => (
        <>
          <WinnerPrediction
            rid={nflRid(g)} status={nflRstatus(g)} p={p} home={g.home} away={g.away} upcoming={g.state === 'upcoming'} model={nflModelOf(lg)}
            saved={t('Saved before kick-off')} updated={t('Updated until kick-off')} strongAt={nflStrongAt(lg)}
            stats={[
              { label: t('Expected margin'), value: typeof p?.margin === 'number' ? t('{0} by {1}', { 0: nick((p.margin >= 0 ? g.home : g.away).name, g.league), 1: Math.abs(p.margin).toFixed(1) }) : '–' },
              { label: t('Predicted score'), value: typeof p?.homePts === 'number' ? `${Math.round(p.homePts)}–${Math.round(p.awayPts!)}` : '–' },
              { label: t('Total points'), value: typeof p?.total === 'number' ? p.total.toFixed(1) : '–' }
            ]}
            why={p ? whyRows(g, p) : []}
            noPrediction={g.state === 'upcoming' ? t('Our prediction for this game is saved in the week of the game, before kick-off.') : t('No prediction for this game.')}
          />
          <YourPicks sport="nfl" gameId={g.id} home={nick(g.home.name, g.league)} away={nick(g.away.name, g.league)} />
          <GameNews home={{ sport: 'american-football', teamId: g.home.id }} away={{ sport: 'american-football', teamId: g.away.id }} />
        </>
      )
    },
    ...(d.teamStats ? [{ id: 'stats', label: t('Statistics'), short: t('Stats'), hint: live ? t('Live team stats') : t('Yards, downs, red zone and turnovers'), live, render: () => <TeamStats g={g} home={d.teamStats!.home} away={d.teamStats!.away} /> }] : []),
    ...(hasPlayers ? [{
      id: 'players', label: d.injuries ? t('Players & injuries') : t('Players'), short: t('Players'), hint: d.injuries ? t('Player stats and the injury reports') : t('Passing, rushing, receiving and defense'),
      render: () => (
        <>
          {d.injuries && <Injuries g={g} data={d.injuries} />}
          {d.players && <Players g={g} data={d.players} />}
        </>
      )
    }] : []),
    { id: 'h2h', label: t('H2H'), hint: t('Last meetings and recent form'), render: () => <H2HForm d={d} /> }
  ]

  return (
    <GamePage
      back={{ to: `${nflBase(lg)}/games`, label: t('All games') }}
      top={<LeagueSwitch />}
      srTitle={`${g.home.name} vs ${g.away.name} · ${nflLeagueName(lg)} ${weekLabel(g.weekKey, g.league)}`}
      league={{ name: nflLeagueName(lg), href: `${nflBase(lg)}/league`, bits: [weekLabel(g.weekKey, g.league)] }}
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
                <thead><tr className="text-faint"><th className="px-3 text-left font-semibold" />{['Q1', 'Q2', 'Q3', 'Q4', ...(ot ? ['OT'] : [])].map(x => <th key={x} className="px-3 font-semibold">{t(x)}</th>)}<th className="px-3 font-semibold">{t('Total')}</th></tr></thead>
                <tbody>
                  {(['home', 'away'] as const).map(s => (
                    <tr key={s}>
                      <td className="px-3 py-0.5 text-muted font-semibold font-sans text-left">{nick(g[s].name, g.league)}</td>
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
      tabs={tabs}
      tab={tab}
      onTab={pickTab}
    />
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
                <Link to={`/american-football/game/${m.id}`} className="flex items-center gap-3 py-1.5 text-sm hover:text-accent min-w-0">
                  <span className="w-20 shrink-0 text-xs text-faint">{new Date(m.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  <span className="flex-1 truncate text-ink">{m.home.name} – {m.away.name}</span>
                  <span className="num font-bold text-ink">{m.score ? `${m.score.home}–${m.score.away}` : '–'}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t('Form')} action={<span className="text-xs text-faint">{t('Last results')}</span>}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
          {(['home', 'away'] as const).map(s => (
            <div key={s} className="min-w-0">
              <div className="flex items-center gap-2 mb-3"><TeamLogo team={g[s]} size={22} /><span className="font-display font-bold text-ink truncate">{g[s].name}</span></div>
              {d.form[s].length === 0 ? <p className="text-sm text-faint">{t('No games yet.')}</p> : (
                <ul className="space-y-1.5">
                  {d.form[s].map(f => (
                    <li key={f.id}>
                      <Link to={`/american-football/game/${f.id}`} className="flex items-center gap-2 text-sm hover:text-accent min-w-0">
                        <span className={`w-5 h-5 shrink-0 rounded grid place-items-center text-[10px] font-extrabold ${f.result === 'W' ? 'bg-win/15 text-win' : f.result === 'L' ? 'bg-loss/15 text-loss' : 'bg-draw/15 text-draw'}`}>{f.result}</span>
                        <span className="text-faint text-xs w-6 shrink-0">{f.home ? t('vs') : '@'}</span>
                        <TeamLogo team={f.opponent} size={16} />
                        <span className="flex-1 truncate text-ink">{f.opponent.name}</span>
                        <span className="num font-semibold text-ink">{f.for}–{f.against}</span>
                      </Link>
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
        <span className="flex items-center gap-1.5 text-home"><TeamLogo team={g.home} size={16} />{g.home.name}</span>
        <span className="flex items-center gap-1.5 text-away">{g.away.name}<TeamLogo team={g.away} size={16} /></span>
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
function Players({ g, data }: { g: Game; data: { home: Groups; away: Groups } }) {
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
          <Card key={pg.label} title={t(pg.label)}>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm min-w-[520px]">
                <thead><tr className="text-[10px] uppercase tracking-wide text-faint"><th className="text-left font-semibold py-1 px-1">{t('Player')}</th>{cols.map(c => <th key={c} className="text-right font-semibold py-1 px-1">{c}</th>)}</tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={`${r.team.id}-${r.id}`} className="border-t border-line/50">
                      <td className="py-1.5 px-1"><Link to={`/american-football/player/${r.id}`} className="flex items-center gap-2 hover:text-accent"><TeamLogo team={r.team} size={14} /><span className="truncate">{r.name}</span></Link></td>
                      {cols.map(c => <td key={c} className="py-1.5 px-1 text-right num text-muted">{r.stats[c] ?? '–'}</td>)}
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
            <div className="flex items-center gap-2 mb-3"><TeamLogo team={g[s]} size={22} /><span className="font-display font-bold text-ink truncate">{g[s].name}</span></div>
            {data[s].length === 0 ? <p className="text-sm text-faint">{t('No injuries reported.')}</p> : (
              <ul className="divide-y divide-line/50">
                {data[s].map(i => (
                  <li key={i.id} className="py-1.5 text-sm">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link to={`/american-football/player/${i.id}`} className="text-ink hover:text-accent truncate">{i.name}</Link>
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

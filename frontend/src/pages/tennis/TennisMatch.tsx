import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { FavStar } from '../../lib/favorites'
import { useReveal } from '../../lib/reveal'
import { slModelOf } from '../../lib/modelNames'
import { tennisRid, tennisRstatus, tennisHref, tennisPlayerFav, tennisTournamentFav, surname, flagOf, tierLabel, surfaceName, setsText, TENNIS_STRONG, type TMatch, type TPred } from '../../lib/tennis'
import { Skeleton } from '../bb/parts'
import { GAME_RELOAD } from '../../components/UnlockPrompt'
import GamePage, { useGameTab, GameNews, Section, fmtGameDate, fmtGameTime, type GameTab } from '../../components/sport/game/GamePage'
import WinnerPrediction, { type WhyRow } from '../../components/sport/game/WinnerPrediction'
import { LiveChancePanel, SwingChart } from '../../components/sport/game/LiveChance'
import ModelParts, { type PartRow } from '../../components/sport/game/ModelParts'
import { PlayerName, SurfaceTag } from './parts'

interface SR { matches: number; servicePointsWon: number | null; returnPointsWon: number | null; holdPct: number | null; breakPct: number | null; bpSaved: number | null; bpConverted: number | null; tiebreaksWon: number | null; tiebreaks: number }
interface Played { id: number; start: string; tournament: string; surface: string | null; round: string | null; opponent: { id: number | null; name: string; country: string | null }; won: boolean; score: string; sets: number; minutes: number | null; retired: boolean }
interface Rating { elo: number; rank: number; of: number; surfaces: { surface: string; elo: number; matches: number }[]; serve: number; ret: number; tourServe: number; form: { won: number; played: number }; matches: number; lastMatch: string | null }
interface Rest { last3: { matches: number; sets: number; hours: number | null }; last7: { matches: number; sets: number; hours: number | null }; last14: { matches: number; sets: number; hours: number | null }
  yesterday: { minutes: number | null; sets: number; hoursAgo: number } | null; daysSinceLast: number | null; newTournament: boolean; surfaceSwitch: { from: string; to: string } | null
  stoppages: { medical: number; other: number; retirements: number } }
interface Data {
  match: TMatch; prediction: TPred | null
  live: { now: TPred['live'] | null; curve: { t: number; p: number }[] } | null
  stats: { home: { last52: SR; surface: SR | null } | null; away: { last52: SR; surface: SR | null } | null }
  form: { home: Played[]; away: Played[] }
  ratings: { home: Rating | null; away: Rating | null }
  schedule: { home: Rest | null; away: Rest | null }
  h2h: { list: TMatch[]; won: [number, number]; bySurface: { surface: string; won: [number, number] }[] }
  draw: { code: string; name: string; qualifying: boolean; matches: TMatch[] }[]
}
const TABS = ['prediction', 'stats', 'form', 'rest', 'h2h', 'draw']

/**
 * Tennis match page (fix193): the shared game page (football's match page) — Prediction · Stats · Form & surface ·
 * Schedule & rest · H2H · Draw (the "Standings" tab of the other sports). Live: the score by sets / games / points,
 * a live win chance from our Markov chain and the swing chart.
 */
export default function TennisMatch() {
  const { id } = useParams()
  const [d, setD] = useState<Data | null>(null)
  const [missing, setMissing] = useState(false)
  const [tab, pickTab] = useGameTab(TABS, { standings: 'draw', table: 'draw', players: 'stats' })
  useEffect(() => {
    setD(null); setMissing(false)
    const load = () => axios.get(`${API_URL}/tennis/match/${id}`).then(r => setD(r.data.data)).catch(e => { if (e?.response?.status === 404) setMissing(true) })
    load()
    const iv = setInterval(() => { if (document.visibilityState === 'visible') load() }, 30 * 1000)
    window.addEventListener(GAME_RELOAD, load) // a free pick opened this match
    return () => { clearInterval(iv); window.removeEventListener(GAME_RELOAD, load) }
  }, [id])
  useEffect(() => {
    if (d) document.title = `${surname(d.match.home.name)} vs ${surname(d.match.away.name)} · ${d.match.tournament.name} | SportLikely`
  }, [d?.match.id])

  if (missing) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-muted">{t('Match not found.')}</div>
  if (!d) return <div className="max-w-5xl mx-auto px-4 py-8"><Skeleton rows={6} h="h-16" /></div>
  const m = d.match
  const p = d.prediction
  const live = m.state === 'live', done = m.state === 'done'
  const hs = surname(m.home.name), as = surname(m.away.name)
  const side = (s: TMatch['home']) => ({
    name: s.name, logo: <span className="text-5xl sm:text-6xl leading-none" aria-hidden>{flagOf(s.country) || '🎾'}</span>, href: tennisHref.player(s.id) || '/tennis',
    title: t('{0}: player page', { 0: s.name }), linkLabel: t('Player page →'), star: s.id ? <FavStar fav={tennisPlayerFav(s)} size="sm" /> : undefined,
    sub: s.rank ? t('World No. {0}', { 0: s.rank }) : null
  })
  const strongAt = p?.strongAt ?? TENNIS_STRONG
  const sets = p?.sets || []
  const g = p?.games
  const tabs: GameTab[] = [
    {
      id: 'prediction', label: t('Prediction'), hint: '',
      render: () => (
        <>
          <WinnerPrediction
            rid={tennisRid(m)} status={tennisRstatus(m)} p={p} home={{ name: m.home.name, logo: null }} away={{ name: m.away.name, logo: null }} upcoming={m.state === 'upcoming'}
            model={p?.model || 'tennis-v1'} sport="tennis" saved={t('Saved before the first serve')} updated={t('Updated until the first serve')} strongAt={strongAt}
            middle={{ label: t('Total games'), value: g && typeof g.median === 'number' ? String(g.median) : '–' }}
            stats={[
              { label: t('Likely score'), value: sets[0] ? sets[0].score.replace('-', '–') : '–' },
              { label: t('Chance of it'), value: sets[0] ? `${Math.round(sets[0].pct)}%` : '–' },
              { label: p?.firstSet ? t('First set: {0}', { 0: p.firstSet.pHome >= p.firstSet.pAway ? hs : as }) : t('First set'), value: p?.firstSet ? `${Math.round(Math.max(p.firstSet.pHome, p.firstSet.pAway))}%` : '–' }
            ]}
            why={(p?.why || []).map(line => toWhy(line, m))}
            howCalc={p && !p.locked && p.numbers ? <TennisParts m={m} p={p} /> : undefined}
            noPrediction={m.state === 'upcoming' ? t('Our prediction for this match is saved in the 48 hours before the first serve.') : t('No prediction for this match.')}
          />
          {p && !p.locked && sets.length > 0 && <SetsCard m={m} p={p} />}
          <GameNews home={{ sport: 'tennis', playerId: m.home.id ?? undefined }} away={{ sport: 'tennis', playerId: m.away.id ?? undefined }} title={t('News about both players')} />
        </>
      )
    },
    { id: 'stats', label: t('Serve & return'), short: t('Stats'), hint: t('Last 52 weeks and on this surface'), render: () => <ServeReturn m={m} d={d} /> },
    { id: 'form', label: t('Form & surface'), short: t('Form'), hint: t('Last 10 matches and the surface ratings'), render: () => <FormSurface m={m} d={d} /> },
    { id: 'rest', label: t('Schedule & rest'), short: t('Rest'), hint: t('Matches, sets and hours played lately'), render: () => <RestTab m={m} d={d} /> },
    { id: 'h2h', label: t('H2H'), hint: t('Every meeting, by surface'), render: () => <H2H m={m} d={d} /> },
    ...(d.draw.length ? [{ id: 'draw', label: t('Draw'), hint: t('{0} draw', { 0: m.tournament.name }), render: () => <DrawTab m={m} rounds={d.draw} /> }] : [])
  ]
  const statusText = live ? `${t('Set {0}', { 0: Math.min(m.bestOf, (m.score?.won[0] || 0) + (m.score?.won[1] || 0) + 1) })}${m.score?.points ? ` · ${m.score.points[0]}-${m.score.points[1]}` : ''}`
    : done ? (/retired/.test(m.outcome || '') ? t('Retired') : t('Final')) : m.state === 'off' ? (/walkover/.test(m.outcome || '') ? t('Walkover') : /postpon/i.test(m.status) ? t('Postponed') : t('Cancelled')) : t('FIRST SERVE')
  return (
    <GamePage
      back={{ to: '/tennis/matches', label: t('All matches') }}
      srTitle={`${m.home.name} vs ${m.away.name} · ${m.tournament.name} ${t('prediction')}`}
      league={{ name: m.tournament.name, href: tennisHref.tournament(m.tournament.key), star: <FavStar size="sm" fav={tennisTournamentFav(m.tournament)} />,
        bits: [tierLabel(m), surfaceName(m.tournament.surface, m.tournament.indoor), m.round || '', m.bestOf === 5 ? t('Best of 5') : ''].filter(Boolean) }}
      date={fmtGameDate(m.start)}
      home={side(m.home)}
      away={side(m.away)}
      score={m.score && m.state !== 'upcoming' ? { home: m.score.won[0], away: m.score.won[1] } : null}
      time={fmtGameTime(m.start)}
      status={{ kind: live ? 'live' : done ? 'done' : m.state === 'off' ? 'halted' : 'upcoming', text: statusText }}
      scoreSub={m.score && m.state !== 'upcoming' ? <div className="num text-xs text-faint mt-1">{setsText(m.score)}</div> : undefined}
      statusNote={m.state === 'off' ? (
        <p className="mt-2 max-w-[260px] mx-auto text-[11px] text-muted">{/walkover/.test(m.outcome || '') ? t('A walkover: the match was not played. It does not count in our record.') : t('This match did not take place. It does not count in our record.')}</p>
      ) : undefined}
      pickVar={p && !p.locked && p.pick ? (p.pick === 'H' ? '--home' : '--away') : null}
      footer={m.score && m.state !== 'upcoming' ? <SetTable m={m} /> : undefined}
      afterHero={<LiveBlock d={d} />}
      tabs={tabs}
      tab={tab}
      onTab={pickTab}
    />
  )
}

/** a "why" line in the tone of the player it is about (the model writes the players' full names) */
function toWhy(line: string, m: TMatch): WhyRow {
  const h = line.indexOf(m.home.name), a = line.indexOf(m.away.name)
  const tone: WhyRow['tone'] = h >= 0 && (a < 0 || h < a) ? 'H' : a >= 0 ? 'A' : 'N'
  return { tone, text: line }
}

/** the score by set (and the current game while live) */
function SetTable({ m }: { m: TMatch }) {
  const s = m.score!
  const live = m.state === 'live'
  return (
    <div className="overflow-x-auto">
      <table className="mx-auto text-xs num">
        <thead><tr className="text-faint"><th className="px-3 text-left font-semibold" />{s.sets.map((_, i) => <th key={i} className="px-2.5 font-semibold">{t('Set {0}', { 0: i + 1 })}</th>)}{live && s.points && <th className="px-2.5 font-semibold">{t('Game')}</th>}</tr></thead>
        <tbody>
          {([0, 1] as const).map(k => (
            <tr key={k}>
              <td className="px-3 py-0.5 text-muted font-semibold font-sans text-left whitespace-nowrap">{live && s.server === k + 1 && <span className="text-accent mr-1" title={t('Serving')}>●</span>}<PlayerName p={k === 0 ? m.home : m.away} short /></td>
              {s.sets.map((x, i) => <td key={i} className={`px-2.5 text-center ${x[k] > x[1 - k] ? 'text-ink font-bold' : 'text-muted'}`}>{x[k]}</td>)}
              {live && s.points && <td className="px-2.5 text-center text-live font-bold">{s.points[k]}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** live win chance + the swing chart (numbers unlocked) */
function LiveBlock({ d }: { d: Data }) {
  const m = d.match, p = d.prediction
  const { hidden } = useReveal(tennisRid(m), tennisRstatus(m), !!p && !p.locked)
  if (!d.live || !p || p.locked || hidden || typeof p.pHome !== 'number') return null
  const live = m.state === 'live'
  const now = live ? (d.live.now || p.live || null) : null
  const curve = d.live.curve
  if (!now && curve.length < 2) return null
  return (
    <>
      {now && <LiveChancePanel home={surname(m.home.name)} away={surname(m.away.name)} now={now} before={{ pHome: p.pHome, pAway: p.pAway ?? 100 - p.pHome }} status={`${setsText(m.score)}${m.score?.points ? ` · ${m.score.points[0]}-${m.score.points[1]}` : ''}`}
        words={{ score: t('Sets so far'), total: t('{0} games played', { 0: now.total }) }} />}
      {curve.length >= 2 && (
        <div className="mt-3 rounded-2xl border border-line/60 bg-surface/60 p-3 sm:p-4">
          <SwingChart points={curve} home={surname(m.home.name)} away={surname(m.away.name)} periods={m.bestOf} live={live} />
        </div>
      )}
    </>
  )
}

/** "How it was calculated": ratings on this surface and overall, serve points, the two parts' chances */
function TennisParts({ m, p }: { m: TMatch; p: TPred }) {
  const n = p.numbers!
  const rows: PartRow[] = [
    { label: t('Rating on {0}', { 0: surfaceName(m.tournament.surface) || t('this surface') }), h: String(n.eloSurface[0]), a: String(n.eloSurface[1]) },
    { label: t('Overall rating'), h: String(n.eloOverall[0]), a: String(n.eloOverall[1]) },
    { label: t('Service points won (expected)'), h: `${n.servePoint[0]}%`, a: `${n.servePoint[1]}%` }
  ]
  if (typeof p.pHome === 'number') rows.push({ label: t('Win chance'), h: `${Math.round(p.pHome)}%`, a: `${Math.round(p.pAway ?? 100 - p.pHome)}%` })
  return (
    <ModelParts home={<PlayerName p={m.home} short />} away={<PlayerName p={m.away} short />} rows={rows}
      note={t('Two parts: a rating from every result (one per surface, 400 points ≈ 10 to 1), and the share of points each player wins on serve and return, played point by point through the match format. Model {0}.', { 0: slModelOf(p.model || 'tennis-v1', 'tennis') })} />
  )
}

/** set-score chances and the total games lines */
function SetsCard({ m, p }: { m: TMatch; p: TPred }) {
  const g = p.games
  return (
    <Section title={t('Set scores and total games')}>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          {(p.sets || []).map(s => {
            const [a, b] = s.score.split('-').map(Number)
            const who = a > b ? surname(m.home.name) : surname(m.away.name)
            return (
              <div key={s.score} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <div className="min-w-0">
                  <div className="flex justify-between gap-2"><span className="text-muted truncate">{who} {a > b ? `${a}-${b}` : `${b}-${a}`}</span><span className="num text-ink font-semibold">{Math.round(s.pct)}%</span></div>
                  <div className="mt-1 h-1.5 rounded-full bg-surface2 overflow-hidden"><div className={`h-full rounded-full ${a > b ? 'bg-home' : 'bg-away'}`} style={{ width: `${Math.min(100, s.pct)}%` }} /></div>
                </div>
              </div>
            )
          })}
        </div>
        {g && (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted">{t('Total games, median')}</span><span className="num font-bold text-ink">{g.median ?? '–'}</span></div>
            {typeof g.mean === 'number' && <div className="flex justify-between"><span className="text-muted">{t('Total games, average')}</span><span className="num font-bold text-ink">{g.mean.toFixed(1)}</span></div>}
            <table className="w-full text-xs num mt-2">
              <thead><tr className="text-faint"><th className="text-left font-semibold py-1">{t('Games')}</th><th className="text-right font-semibold">{t('Over')}</th><th className="text-right font-semibold">{t('Under')}</th></tr></thead>
              <tbody>
                {Object.entries(g.over).map(([line, v]) => (
                  <tr key={line} className="border-t border-line/50"><td className="py-1">{line}</td><td className="text-right">{Math.round(v * 100)}%</td><td className="text-right">{Math.round((1 - v) * 100)}%</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  )
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${x}%`)
/** two columns of the same numbers, the better one bold */
function Compare({ m, rows, note }: { m: TMatch; rows: { label: string; h: number | null | undefined; a: number | null | undefined; fmt?: (x: number | null | undefined) => string; lowerBetter?: boolean }[]; note?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-faint"><th className="text-left font-semibold py-1.5 w-[34%]"><PlayerName p={m.home} short /></th><th /><th className="text-right font-semibold w-[34%]"><PlayerName p={m.away} short /></th></tr></thead>
        <tbody>
          {rows.map(r => {
            const better = r.h == null || r.a == null || r.h === r.a ? 0 : (r.h > r.a) !== !!r.lowerBetter ? 1 : 2
            const f = r.fmt || pct
            return (
              <tr key={r.label} className="border-t border-line/50">
                <td className={`py-1.5 num ${better === 1 ? 'font-bold text-ink' : 'text-muted'}`}>{f(r.h)}</td>
                <td className="py-1.5 text-center text-xs text-muted px-2">{r.label}</td>
                <td className={`py-1.5 num text-right ${better === 2 ? 'font-bold text-ink' : 'text-muted'}`}>{f(r.a)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {note && <p className="text-xs text-faint mt-2">{note}</p>}
    </div>
  )
}
function srRows(h: SR | null | undefined, a: SR | null | undefined) {
  return [
    { label: t('Service points won'), h: h?.servicePointsWon, a: a?.servicePointsWon },
    { label: t('Return points won'), h: h?.returnPointsWon, a: a?.returnPointsWon },
    { label: t('Service games held'), h: h?.holdPct, a: a?.holdPct },
    { label: t('Return games broken'), h: h?.breakPct, a: a?.breakPct },
    { label: t('Break points saved'), h: h?.bpSaved, a: a?.bpSaved },
    { label: t('Break points converted'), h: h?.bpConverted, a: a?.bpConverted },
    { label: t('Tiebreaks won'), h: h?.tiebreaksWon, a: a?.tiebreaksWon },
    { label: t('Matches with stats'), h: h?.matches, a: a?.matches, fmt: (x: number | null | undefined) => (x == null ? '–' : String(x)) }
  ]
}
function ServeReturn({ m, d }: { m: TMatch; d: Data }) {
  const h = d.stats.home, a = d.stats.away
  if (!h && !a) return <Section title={t('Serve & return')}><p className="text-sm text-faint">{t('No match statistics for these players yet.')}</p></Section>
  return (
    <>
      <Section title={t('Serve & return · last 52 weeks')}><Compare m={m} rows={srRows(h?.last52, a?.last52)} /></Section>
      {m.tournament.surface && (h?.surface || a?.surface) && (
        <Section title={t('On {0}', { 0: surfaceName(m.tournament.surface) })}><Compare m={m} rows={srRows(h?.surface, a?.surface)} /></Section>
      )}
    </>
  )
}

function FormList({ list, title }: { list: Played[]; title: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="label pb-1.5">{title}</div>
      {!list.length ? <p className="text-sm text-faint">{t('No recent matches.')}</p> : (
        <ul className="divide-y divide-line/50">
          {list.map(x => (
            <li key={x.id}>
              <Link to={tennisHref.match(x.id)} className="flex items-center gap-2 py-1.5 text-sm hover:bg-surface2/50 rounded-lg px-1">
                <span className={`w-5 h-5 rounded grid place-items-center text-[10px] font-extrabold flex-shrink-0 ${x.won ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{x.won ? t('W') : t('L')}</span>
                <span className="min-w-0 flex-1 truncate">{flagOf(x.opponent.country)} {x.opponent.name}<span className="block text-[11px] text-faint truncate">{x.tournament}{x.round ? ` · ${x.round}` : ''}</span></span>
                <span className="num text-xs text-muted shrink-0">{x.score}{x.retired ? ` ${t('ret.')}` : ''}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
function FormSurface({ m, d }: { m: TMatch; d: Data }) {
  const rh = d.ratings.home, ra = d.ratings.away
  const surf = (r: Rating | null, s: string) => r?.surfaces.find(x => x.surface === s)?.elo ?? null
  return (
    <>
      {(rh || ra) && (
        <Section title={t('Surface ratings')} note={t('Our ratings: 1500 is a typical tour player')}>
          <Compare m={m} rows={[
            { label: t('Overall'), h: rh?.elo, a: ra?.elo, fmt: x => (x == null ? '–' : String(x)) },
            { label: t('Hard'), h: surf(rh, 'hard'), a: surf(ra, 'hard'), fmt: x => (x == null ? '–' : String(x)) },
            { label: t('Clay'), h: surf(rh, 'clay'), a: surf(ra, 'clay'), fmt: x => (x == null ? '–' : String(x)) },
            { label: t('Grass'), h: surf(rh, 'grass'), a: surf(ra, 'grass'), fmt: x => (x == null ? '–' : String(x)) },
            { label: t('Rank in our ratings'), h: rh?.rank, a: ra?.rank, fmt: x => (x == null ? '–' : `#${x}`), lowerBetter: true },
            { label: t('Won, last 10'), h: rh?.form.won, a: ra?.form.won, fmt: x => (x == null ? '–' : String(x)) }
          ]} />
        </Section>
      )}
      <Section title={t('Last 10 matches')}>
        <div className="grid gap-5 md:grid-cols-2">
          <FormList list={d.form.home} title={<PlayerName p={m.home} />} />
          <FormList list={d.form.away} title={<PlayerName p={m.away} />} />
        </div>
      </Section>
    </>
  )
}

function RestTab({ m, d }: { m: TMatch; d: Data }) {
  const h = d.schedule.home, a = d.schedule.away
  if (!h && !a) return <Section title={t('Schedule & rest')}><p className="text-sm text-faint">{t('No recent matches for these players.')}</p></Section>
  const num = (x: number | null | undefined) => (x == null ? '–' : String(x))
  const hrs = (x: number | null | undefined) => (x == null ? '–' : t('{0} h', { 0: x }))
  const lines = (r: Rest | null, name: string) => {
    if (!r) return []
    const out: string[] = []
    if (r.yesterday) out.push(t('{0} played {1} sets {2} hours ago{3}.', { 0: name, 1: r.yesterday.sets, 2: r.yesterday.hoursAgo, 3: r.yesterday.minutes ? t(' ({0} minutes)', { 0: r.yesterday.minutes }) : '' }))
    if (r.surfaceSwitch) out.push(t('{0} comes from {1} to {2}.', { 0: name, 1: surfaceName(r.surfaceSwitch.from), 2: surfaceName(r.surfaceSwitch.to) }))
    else if (r.newTournament) out.push(t('{0} comes from another tournament.', { 0: name }))
    if (r.stoppages.medical || r.stoppages.retirements) out.push(t('{0}: {1} medical stoppages and {2} retirements in the last 30 days.', { 0: name, 1: r.stoppages.medical, 2: r.stoppages.retirements }))
    return out
  }
  const notes = [...lines(h, surname(m.home.name)), ...lines(a, surname(m.away.name))]
  return (
    <Section title={t('Schedule & rest')}>
      <Compare m={m} rows={[
        { label: t('Matches, last 3 days'), h: h?.last3.matches, a: a?.last3.matches, fmt: num, lowerBetter: true },
        { label: t('Matches, last 7 days'), h: h?.last7.matches, a: a?.last7.matches, fmt: num, lowerBetter: true },
        { label: t('Matches, last 14 days'), h: h?.last14.matches, a: a?.last14.matches, fmt: num, lowerBetter: true },
        { label: t('Sets, last 7 days'), h: h?.last7.sets, a: a?.last7.sets, fmt: num, lowerBetter: true },
        { label: t('Hours on court, last 7 days'), h: h?.last7.hours, a: a?.last7.hours, fmt: hrs, lowerBetter: true },
        { label: t('Days since the last match'), h: h?.daysSinceLast, a: a?.daysSinceLast, fmt: num }
      ]} note={notes.length ? <span className="block space-y-1">{notes.map(n => <span key={n} className="block">{n}</span>)}</span> : undefined} />
    </Section>
  )
}

function H2H({ m, d }: { m: TMatch; d: Data }) {
  const x = d.h2h
  return (
    <Section title={t('Head-to-head')} note={x.list.length ? `${surname(m.home.name)} ${x.won[0]} – ${x.won[1]} ${surname(m.away.name)}` : undefined}>
      {!x.list.length ? <p className="text-sm text-faint">{t('These players have not met in our records.')}</p> : (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            {x.bySurface.map(s => <span key={s.surface} className="inline-flex items-center gap-1.5 rounded-full border border-line/70 px-2.5 py-1 text-xs"><SurfaceTag surface={s.surface} /> <span className="num font-bold text-ink">{s.won[0]}–{s.won[1]}</span></span>)}
          </div>
          <ul className="divide-y divide-line/50">
            {x.list.map(g => {
              const homeWon = (g.winner === 1 ? g.home.id : g.away.id) === m.home.id
              return (
                <li key={g.id}>
                  <Link to={tennisHref.match(g.id)} className="flex items-center gap-3 py-2 text-sm hover:bg-surface2/50 rounded-lg px-1">
                    <span className="w-20 text-xs text-faint shrink-0">{new Date(g.start).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: '2-digit' })}</span>
                    <span className="min-w-0 flex-1 truncate">{g.tournament.name}{g.round ? ` · ${g.round}` : ''}<span className="block text-[11px] text-faint"><SurfaceTag surface={g.tournament.surface} /></span></span>
                    <span className="text-xs text-right shrink-0"><span className="font-bold text-ink">{surname((homeWon ? m.home : m.away).name)}</span><span className="block num text-muted">{setsText(g.score, g.winner === 2)}</span></span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Section>
  )
}

/** the tournament's draw by round, this match highlighted */
export function DrawTab({ m, rounds }: { m: TMatch | null; rounds: Data['draw'] }) {
  const main = rounds.filter(r => !r.qualifying), quali = rounds.filter(r => r.qualifying)
  const block = (r: Data['draw'][number]) => (
    <div key={(r.qualifying ? 'q' : '') + r.code} className="min-w-0">
      <div className="label pb-1">{r.qualifying ? `${t('Qualifying')} · ${r.name}` : r.name}</div>
      <ul className="space-y-1.5">
        {r.matches.map(x => {
          const on = m && x.id === m.id
          const w = x.winner
          return (
            <li key={x.id}>
              <Link to={tennisHref.match(x.id)} className={`block rounded-xl border px-3 py-2 text-sm hover:border-accent/50 ${on ? 'border-accent/70 bg-accent/10' : 'border-line/60 bg-surface2/30'}`}>
                {([1, 2] as const).map(k => {
                  const s = k === 1 ? x.home : x.away
                  return (
                    <div key={k} className="flex items-center justify-between gap-2">
                      <span className={`truncate ${w === k ? 'font-bold text-ink' : w ? 'text-muted' : 'text-ink/85'}`}>{flagOf(s.country)} {s.name}{s.rank ? <span className="ml-1 text-[10px] text-faint num">{s.rank}</span> : null}</span>
                      <span className="num text-xs text-muted shrink-0">{x.score ? x.score.sets.map(v => v[k - 1]).join(' ') : ''}</span>
                    </div>
                  )
                })}
                {x.state === 'upcoming' && <div className="text-[11px] text-faint mt-0.5">{new Date(x.start).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
                {x.state === 'live' && <div className="text-[11px] text-live font-bold mt-0.5">{t('LIVE')}</div>}
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
  return (
    <Section title={t('Draw')} note={m ? m.tournament.name : undefined}>
      {!main.length && !quali.length ? <p className="text-sm text-faint">{t('The draw appears once the matches are scheduled.')}</p> : (
        <div className="space-y-6">
          {main.length > 0 && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[...main].reverse().map(block)}</div>}
          {quali.length > 0 && <details><summary className="cursor-pointer text-sm font-semibold text-muted">{t('Qualifying')}</summary><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 mt-3">{[...quali].reverse().map(block)}</div></details>}
        </div>
      )}
    </Section>
  )
}

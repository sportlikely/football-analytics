import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import NameLink, { href } from '../../components/sport/NameLink'
import { t, LOCALE } from '../../lib/i18n'
import type { BbGame as Game } from '../../lib/bb'
import { Card, TeamLogo } from './parts'
import { StandingsTable, type Standings, type StandRow } from './BbLeague'
import { teamPlace, groupShort, groupIn, ordinal } from '../../lib/bbTable'
import type { Avg, Sched, Brief, H2H } from './BbGame'
import { teamHref, matchHref } from '../../lib/links'

/** The richer game-page tabs (Oct 2026): statistics, schedule & rest, head-to-head and standings. */

type Side = 'H' | 'A'
const TEXT = { H: 'text-home', A: 'text-away' } as const
const BG = { H: 'bg-home', A: 'bg-away' } as const
const DAY = 86400000

/** Both teams side by side, logo and name, with an optional line under each. */
function TeamsHead({ g, sub }: { g: Game; sub?: (s: Side) => ReactNode }) {
  const side = (s: Side) => {
    const team = s === 'H' ? g.home : g.away
    return (
      <Link to={teamHref('basketball', team.id, team.name)!} className={`flex flex-col sm:flex-row items-center gap-2 sm:gap-3 min-w-0 group text-center ${s === 'A' ? 'sm:flex-row-reverse sm:text-right' : 'sm:text-left'}`}>
        <span className="w-11 h-11 sm:w-12 sm:h-12 rounded-2xl bg-surface2/80 border border-line/60 grid place-items-center shrink-0"><TeamLogo team={team} size={30} /></span>
        <span className="min-w-0 max-w-full">
          <span className="block font-display font-bold text-ink truncate group-hover:text-accent">{team.name}</span>
          {sub && <span className="block">{sub(s)}</span>}
        </span>
      </Link>
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

function FormChips({ f, align = 'left' }: { f: ('W' | 'L')[]; align?: 'left' | 'right' }) {
  return (
    <span className={`flex gap-1 mt-1 justify-center ${align === 'right' ? 'sm:justify-end' : 'sm:justify-start'}`}>
      {f.map((r, i) => (
        <span key={i} className={`w-[18px] h-[18px] rounded-[5px] text-[9px] font-extrabold grid place-items-center ${r === 'W' ? 'bg-win/90 text-bg' : 'bg-loss/90 text-bg'} ${i === f.length - 1 ? 'ring-2 ring-offset-1 ring-offset-surface ring-line' : ''}`}>
          {r === 'W' ? t('W') : t('L')}
        </span>
      ))}
    </span>
  )
}

/* ---------------- Statistics ---------------- */

interface Row { k: keyof Avg; label: string; pct?: boolean; lowerBetter?: boolean }
const GROUPS: { title: string; rows: Row[] }[] = [
  { title: t('Scoring'), rows: [{ k: 'pointsFor', label: t('Points scored') }, { k: 'pointsAgainst', label: t('Points allowed'), lowerBetter: true }] },
  { title: t('Shooting'), rows: [{ k: 'fgPct', label: t('Field goal %'), pct: true }, { k: 'threePct', label: t('3-point %'), pct: true }, { k: 'threeMade', label: t('3-pointers made') }, { k: 'ftPct', label: t('Free throw %'), pct: true }] },
  { title: t('Hustle & ball control'), rows: [{ k: 'rebounds', label: t('Rebounds') }, { k: 'assists', label: t('Assists') }, { k: 'steals', label: t('Steals') }, { k: 'blocks', label: t('Blocks') }, { k: 'turnovers', label: t('Turnovers'), lowerBetter: true }] }
]

function StatLine({ r, a, b }: { r: Row; a: number; b: number }) {
  const better: Side | null = a === b ? null : (a > b) !== !!r.lowerBetter ? 'H' : 'A'
  const sum = a + b || 1
  const fmt = (x: number) => `${x}${r.pct ? '%' : ''}`
  return (
    <li className="py-2">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className={`num w-16 ${better === 'H' ? 'font-extrabold text-ink' : 'text-muted'}`}>{fmt(a)}</span>
        <span className="text-[11px] font-semibold text-faint text-center truncate">{r.label}</span>
        <span className={`num w-16 text-right ${better === 'A' ? 'font-extrabold text-ink' : 'text-muted'}`}>{fmt(b)}</span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <div className="h-2 rounded-full bg-surface2 overflow-hidden flex justify-end">
          <div className={`h-full rounded-full transition-all duration-700 ${better === 'H' ? 'bg-home' : 'bg-home/30'}`} style={{ width: `${(a / sum) * 100}%` }} />
        </div>
        <div className="h-2 rounded-full bg-surface2 overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-700 ${better === 'A' ? 'bg-away' : 'bg-away/30'}`} style={{ width: `${(b / sum) * 100}%` }} />
        </div>
      </div>
    </li>
  )
}

export function StatsTab({ g, home, away }: { g: Game; home: Avg | null; away: Avg | null }) {
  if (!home || !away) return <Card><p className="text-sm text-faint">{t('Not enough games yet for averages.')}</p></Card>
  let hEdge = 0, aEdge = 0, n = 0
  for (const gr of GROUPS) for (const r of gr.rows) {
    const a = home[r.k] as number | null, b = away[r.k] as number | null
    if (a === null || b === null || a === b) continue
    n++
    if ((a > b) !== !!r.lowerBetter) hEdge++; else aEdge++
  }
  const lead: Side | null = hEdge === aEdge ? null : hEdge > aEdge ? 'H' : 'A'
  const net = (x: Avg) => Math.round((x.pointsFor - x.pointsAgainst) * 10) / 10
  return (
    <Card title={t('Averages, last {0} games', { 0: Math.max(home.games, away.games) })}>
      <TeamsHead g={g} sub={s => {
        const x = s === 'H' ? home : away
        return (
          <>
            <span className="block text-[11px] text-faint num">{t('{0}–{1} in these games', { 0: x.won, 1: x.lost })} · <span className={net(x) >= 0 ? 'text-win' : 'text-loss'}>{net(x) > 0 ? '+' : ''}{net(x)}</span></span>
            <FormChips f={x.form} align={s === 'A' ? 'right' : 'left'} />
          </>
        )
      }} />

      {n > 0 && (
        <div className="mt-5 rounded-xl border border-line/60 bg-surface2/40 px-4 py-3">
          <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
            <span className={TEXT.H}>{hEdge}</span>
            <span className="text-muted">{lead ? t('{0} lead {1} of {2} categories', { 0: lead === 'H' ? g.home.name : g.away.name, 1: Math.max(hEdge, aEdge), 2: n }) : t('Level: {0} categories each', { 0: hEdge })}</span>
            <span className={TEXT.A}>{aEdge}</span>
          </div>
          <div className="flex h-2 gap-[3px]">
            <div className="rounded-full bg-home" style={{ width: `${(hEdge / n) * 100}%` }} />
            <div className="rounded-full bg-away" style={{ width: `${(aEdge / n) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="mt-5 space-y-5">
        {GROUPS.map(gr => {
          const rows = gr.rows.filter(r => home[r.k] !== null && away[r.k] !== null)
          if (!rows.length) return null
          return (
            <div key={gr.title}>
              <div className="label pb-1">{gr.title}</div>
              <ul className="divide-y divide-line/40">{rows.map(r => <StatLine key={r.k} r={r} a={home[r.k] as number} b={away[r.k] as number} />)}</ul>
            </div>
          )
        })}
      </div>
      {(home.withStats < home.games || away.withStats < away.games) && <p className="mt-4 text-[11px] text-faint">{t('Shooting and other stats from the games with a box score.')}</p>}
    </Card>
  )
}

/* ---------------- Schedule & rest ---------------- */

type Tone = 'good' | 'mid' | 'bad' | 'none'
const TONE: Record<Tone, string> = {
  good: 'border-win/40 bg-win/10 text-win',
  mid: 'border-draw/40 bg-draw/10 text-draw',
  bad: 'border-loss/40 bg-loss/10 text-loss',
  none: 'border-line/60 bg-surface2/50 text-ink'
}
function Tile({ label, value, tone, icon }: { label: string; value: ReactNode; tone: Tone; icon: ReactNode }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${TONE[tone]}`}>
      <div className="flex items-start gap-1.5 opacity-80"><span className="hidden sm:inline mt-px">{icon}</span><span className="text-[10px] font-semibold uppercase sm:tracking-wide leading-tight">{label}</span></div>
      <div className="num text-xl font-extrabold mt-1 leading-none">{value}</div>
    </div>
  )
}
const Ico = {
  bed: <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 18V7M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5" /><circle cx="7" cy="11" r="1.6" /></svg>,
  cal: <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  next: <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
}

/** fix229: a game of a team's schedule: the slug link from the team, the opponent and the day */
const briefHref = (b: Brief, team: { id: number; name: string }, nfl: boolean) =>
  matchHref(nfl ? 'american-football' : 'basketball', b.id, b.home ? { home: team.name, homeId: team.id, away: b.opponent, date: b.kickoff } : { home: b.opponent, away: team.name, awayId: team.id, date: b.kickoff })!

function Result({ b, team, nfl }: { b: Brief; team: { id: number; name: string }; nfl: boolean }) {
  const [x, y] = (b.score || '').split('-').map(Number)
  const margin = Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) : null
  return (
    <li>
      <Link to={briefHref(b, team, nfl)} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface2/60 text-xs">
        <span className={`w-6 h-6 rounded-md grid place-items-center text-[10px] font-extrabold shrink-0 ${b.result === 'W' ? 'bg-win/15 text-win' : b.result === 'L' ? 'bg-loss/15 text-loss' : 'bg-surface2 text-faint'}`}>{b.result === 'W' ? t('W') : b.result === 'L' ? t('L') : b.result === 'T' ? t('T') : '–'}</span>
        <span className="num text-faint w-12 shrink-0">{new Date(b.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
        <span className={`rounded px-1 text-[9px] font-bold shrink-0 ${b.home ? 'bg-home/15 text-home' : 'bg-surface2 text-muted'}`}>{b.home ? t('H') : t('A')}</span>
        {b.opponentLogo ? <img src={b.opponentLogo} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" /> : <span className="w-4 h-4 shrink-0" />}
        <span className="text-ink font-medium truncate">{b.opponent}</span>
        {b.score && <span className="ml-auto num font-bold text-ink shrink-0">{b.score}</span>}
        {margin !== null && b.result !== 'T' && <span className={`num text-[10px] w-8 text-right shrink-0 ${b.result === 'W' ? 'text-win' : 'text-loss'}`}>{b.result === 'W' ? '+' : '−'}{margin}</span>}
      </Link>
    </li>
  )
}

function Upcoming({ b, from, team, nfl }: { b: Brief; from: number; team: { id: number; name: string }; nfl: boolean }) {
  const days = Math.max(0, Math.round((new Date(b.kickoff).getTime() - from) / DAY))
  return (
    <li>
      <Link to={briefHref(b, team, nfl)} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface2/60 text-xs">
        <span className="w-6 h-6 rounded-md grid place-items-center border border-dashed border-line text-faint shrink-0">
          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 7v5l3 2" /><circle cx="12" cy="12" r="9" /></svg>
        </span>
        <span className="num text-faint w-12 shrink-0">{new Date(b.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
        <span className={`rounded px-1 text-[9px] font-bold shrink-0 ${b.home ? 'bg-home/15 text-home' : 'bg-surface2 text-muted'}`}>{b.home ? t('H') : t('A')}</span>
        {b.opponentLogo ? <img src={b.opponentLogo} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" /> : <span className="w-4 h-4 shrink-0" />}
        <span className="text-ink font-medium truncate">{b.opponent}</span>
        <span className="ml-auto rounded-full bg-surface2 px-2 py-0.5 text-[10px] font-semibold text-muted num shrink-0">{t('+{0} d', { 0: days })}</span>
      </Link>
    </li>
  )
}

/** Schedule & rest — basketball (back-to-backs) and, since fix174, NFL + college (short weeks and byes). */
export function RestTab({ g, home, away, sport = 'basketball' }: { g: Pick<Game, 'kickoff' | 'home' | 'away'>; home: Sched; away: Sched; sport?: 'basketball' | 'nfl' }) {
  const nfl = sport === 'nfl'
  const teamHref = (id: number, name: string) => (nfl ? href.nflTeam(id, name) : href.bbTeam(id, name))
  const shortLabel = nfl ? t('Short week') : t('B2B')
  const from = new Date(g.kickoff).getTime()
  const restTone = (s: Sched): Tone => (s.restDays === null ? 'none' : s.backToBack ? 'bad' : s.restDays < 2 ? 'mid' : 'good')
  const loadTone = (s: Sched): Tone => (s.games7 >= 4 ? 'bad' : s.games7 === 3 ? 'mid' : 'none')
  const nextTone = (s: Sched): Tone => (s.nextIn === null ? 'none' : s.nextIn < 1.5 ? 'mid' : 'none')
  const rest = (s: Sched) => (s.backToBack ? 0 : s.restDays === null ? null : Math.floor(s.restDays))
  const rh = rest(home), ra = rest(away)
  let edge: ReactNode = null
  if (home.backToBack && away.backToBack) edge = nfl ? t('Both teams play on a short week.') : t('Both teams play the second night of a back-to-back.')
  else if (rh !== null && ra !== null && rh !== ra) {
    const s: Side = rh > ra ? 'H' : 'A'
    edge = <><b className={TEXT[s]}>{s === 'H' ? g.home.name : g.away.name}</b> {Math.abs(rh - ra) === 1 ? t('come in with one more day of rest') : t('come in with {0} more days of rest', { 0: Math.abs(rh - ra) })}{(s === 'H' ? away : home).backToBack ? ` · ${nfl ? t('the other side is on a short week') : t('the other side is on a back-to-back')}` : ''}.</>
  } else if (rh !== null && ra !== null) edge = t('Same rest for both teams.')

  const panel = (s: Side, x: Sched) => {
    const team = s === 'H' ? g.home : g.away
    return (
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-1 h-6 rounded-full ${BG[s]}`} />
          <TeamLogo team={team} size={22} />
          <NameLink to={teamHref(team.id, team.name)} className="font-display font-bold text-ink truncate">{team.name}</NameLink>
          {x.backToBack && <span className="ml-auto rounded-full bg-loss/15 text-loss px-2 py-0.5 text-[10px] font-extrabold whitespace-nowrap">{shortLabel}</span>}
          {x.offBye && <span className="ml-auto rounded-full bg-win/15 text-win px-2 py-0.5 text-[10px] font-extrabold whitespace-nowrap">{t('Off a bye')}</span>}
        </div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          <Tile icon={Ico.bed} label={t('Rest')} tone={nfl ? (x.restDays === null ? 'none' : x.backToBack ? 'bad' : x.offBye ? 'good' : 'none') : restTone(x)} value={x.restDays === null ? '–' : x.backToBack && !nfl ? t('B2B') : t('{0} d', { 0: Math.floor(x.restDays) })} />
          {nfl ? <Tile icon={Ico.cal} label={t('Bye week')} tone="none" value={x.bye ? x.bye.replace(/^Week /, t('Wk') + ' ') : '–'} /> : <Tile icon={Ico.cal} label={t('Last 7 days')} tone={loadTone(x)} value={x.games7} />}
          <Tile icon={Ico.next} label={t('Next game')} tone={nextTone(x)} value={x.nextIn === null ? '–' : t('{0} d', { 0: Math.round(x.nextIn) })} />
        </div>
        {x.recent.length > 0 && (
          <>
            <div className="label pb-1 px-2">{t('Before this game')}</div>
            <ul className="mb-3">{x.recent.map(b => <Result key={b.id} b={b} team={team} nfl={nfl} />)}</ul>
          </>
        )}
        {x.upcoming.length > 0 && (
          <>
            <div className="label pb-1 px-2">{t('After this game')}</div>
            <ul>{x.upcoming.map(b => <Upcoming key={b.id} b={b} from={from} team={team} nfl={nfl} />)}</ul>
          </>
        )}
      </div>
    )
  }
  return (
    <Card title={t('Schedule & rest')}>
      {edge && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/[0.07] px-4 py-3 text-sm text-ink">
          <span className="w-8 h-8 rounded-lg bg-accent/15 text-accent grid place-items-center shrink-0">{Ico.bed}</span>
          <span>{edge}</span>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">
        {panel('H', home)}
        {panel('A', away)}
      </div>
    </Card>
  )
}

/* ---------------- Head to head ---------------- */

export function H2HTab({ g, list }: { g: Game; list: H2H[] }) {
  const sideOf = (id: number): Side => (id === g.home.id ? 'H' : 'A')
  const teamOf = (s: Side) => (s === 'H' ? g.home : g.away)
  let hw = 0, aw = 0, hp = 0, ap = 0
  for (const m of list) {
    const hs = sideOf(m.homeId)
    const [x, y] = m.score
    const ptsH = hs === 'H' ? x : y, ptsA = hs === 'H' ? y : x
    hp += ptsH; ap += ptsA
    if (ptsH > ptsA) hw++; else aw++
  }
  const n = list.length
  const avg = (p: number) => (n ? (p / n).toFixed(1) : '–')
  return (
    <Card title={t('Head to head')}>
      {n ? (
        <>
          <div className="rounded-2xl border border-line/60 bg-surface2/40 p-4 sm:p-5">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              {(['H', 'A'] as const).map((s, i) => (
                <div key={s} className={`flex flex-col sm:flex-row items-center gap-2 sm:gap-3 min-w-0 text-center ${i === 1 ? 'order-3 sm:flex-row-reverse sm:text-right' : 'sm:text-left'}`}>
                  <span className="w-12 h-12 rounded-2xl bg-surface border border-line/60 grid place-items-center shrink-0"><TeamLogo team={teamOf(s)} size={30} /></span>
                  <span className="min-w-0 max-w-full">
                    <NameLink to={href.bbTeam(teamOf(s).id, teamOf(s).name)} className="block font-display font-bold text-ink truncate">{teamOf(s).name}</NameLink>
                    <span className="block text-[11px] text-faint num">{t('{0} pts a game', { 0: avg(s === 'H' ? hp : ap) })}</span>
                  </span>
                </div>
              ))}
              <div className="order-2 text-center">
                <div className="num font-display text-3xl sm:text-4xl font-extrabold leading-none">
                  <span className={hw >= aw ? TEXT.H : 'text-muted'}>{hw}</span>
                  <span className="text-faint mx-1.5">–</span>
                  <span className={aw >= hw ? TEXT.A : 'text-muted'}>{aw}</span>
                </div>
                <div className="text-[10px] text-faint mt-1 uppercase tracking-wide">{t('{0} meetings', { 0: n })}</div>
              </div>
            </div>
            <div className="flex h-2 gap-[3px] mt-4">
              <div className="rounded-full bg-home" style={{ width: `${(hw / n) * 100}%` }} />
              <div className="rounded-full bg-away" style={{ width: `${(aw / n) * 100}%` }} />
            </div>
          </div>

          <ul className="mt-4 divide-y divide-line/40">
            {list.map(m => {
              const hs = sideOf(m.homeId), as: Side = hs === 'H' ? 'A' : 'H'
              const homeWon = m.score[0] > m.score[1]
              const winner: Side = homeWon ? hs : as
              return (
                <li key={m.id}>
                  <Link to={matchHref('basketball', m.id, { home: m.home, away: m.away, homeId: m.homeId, date: m.kickoff })!} className="grid grid-cols-[3.5rem_1fr_auto_1fr_2.5rem] sm:grid-cols-[5.5rem_1fr_auto_1fr_3rem] items-center gap-2 sm:gap-3 py-2 px-1 rounded-lg hover:bg-surface2/50 text-sm">
                    <span className="text-[11px] text-faint leading-tight">
                      {new Date(m.kickoff).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: '2-digit' })}
                      <span className="hidden sm:block text-[10px] truncate">{m.league}</span>
                    </span>
                    <span className="flex items-center justify-end gap-2 min-w-0">
                      <span className={`truncate ${homeWon ? 'font-bold text-ink' : 'text-muted'}`}>{m.home}</span>
                      <TeamLogo team={teamOf(hs)} size={18} />
                    </span>
                    <span className="num font-extrabold text-ink rounded-lg bg-surface2/80 px-2.5 py-1 text-center min-w-[72px]">
                      <span className={homeWon ? '' : 'text-muted'}>{m.score[0]}</span>
                      <span className="text-faint">–</span>
                      <span className={!homeWon ? '' : 'text-muted'}>{m.score[1]}</span>
                    </span>
                    <span className="flex items-center gap-2 min-w-0">
                      <TeamLogo team={teamOf(as)} size={18} />
                      <span className={`truncate ${!homeWon ? 'font-bold text-ink' : 'text-muted'}`}>{m.away}</span>
                    </span>
                    <span className={`justify-self-end w-2 h-2 rounded-full ${BG[winner]}`} title={teamOf(winner).name} />
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      ) : <p className="text-sm text-faint">{t('These teams have not met in the seasons we hold.')}</p>}
      <p className="mt-3 text-[11px] text-faint">{t('Meetings in our leagues over the last five seasons.')}</p>
    </Card>
  )
}

/* ---------------- Standings ---------------- */

export function StandingsTab({ g, data }: { g: Game; data: Standings }) {
  // fix201: the position inside the team's own table (conference / group), e.g. "7th of 15 · East"
  const find = (id: number) => {
    const p = teamPlace(data, id)
    return p ? { r: p.row, of: p.of, group: p.group } : null
  }
  const h = find(g.home.id), a = find(g.away.id)
  const same = !!h && !!a && h.group === a.group
  const where = (x: { group: { name: string | null } }) => (data.groups.length > 1 ? groupShort(x.group.name) : '')
  const diff = (r: StandRow) => (r.pointsFor !== null && r.pointsAgainst !== null && r.played ? (r.pointsFor - r.pointsAgainst) / r.played : null)
  const card = (s: Side, x: { r: StandRow; of: number; group: { name: string | null } } | null) => {
    const team = s === 'H' ? g.home : g.away
    const d = x ? diff(x.r) : null
    return (
      <div className={`relative overflow-hidden rounded-2xl border border-line/60 bg-surface2/40 p-4 ${s === 'A' ? 'text-right' : ''}`}>
        <span className={`absolute top-0 ${s === 'H' ? 'left-0' : 'right-0'} w-1 h-full ${BG[s]}`} />
        <div className={`flex items-center gap-2 ${s === 'A' ? 'flex-row-reverse' : ''}`}>
          <TeamLogo team={team} size={22} />
          <NameLink to={href.bbTeam(team.id, team.name)} className="font-display font-bold text-ink truncate">{team.name}</NameLink>
        </div>
        {x ? (
          <div className={`mt-3 flex items-end gap-4 ${s === 'A' ? 'flex-row-reverse' : ''}`}>
            <div>
              <div className={`num font-display text-4xl font-extrabold leading-none ${TEXT[s]}`}>{ordinal(x.r.position)}</div>
              <div className="text-[10px] text-faint uppercase tracking-wide mt-1">{t('of {0}', { 0: x.of })}{where(x) ? ` · ${where(x)}` : ''}</div>
            </div>
            <div>
              <div className="num text-lg font-bold text-ink leading-none">{x.r.won}–{x.r.lost}</div>
              <div className="text-[10px] text-faint uppercase tracking-wide mt-1">{t('Record')}</div>
            </div>
            {d !== null && (
              <div>
                <div className={`num text-lg font-bold leading-none ${d >= 0 ? 'text-win' : 'text-loss'}`}>{d > 0 ? '+' : ''}{d.toFixed(1)}</div>
                <div className="text-[10px] text-faint uppercase tracking-wide mt-1">{t('Margin')}</div>
              </div>
            )}
          </div>
        ) : <p className="mt-3 text-xs text-faint">{t('Not in this table')}</p>}
      </div>
    )
  }
  const gap = h && a ? Math.abs(h.r.position - a.r.position) : 0
  return (
    <Card title={t('Standings')} action={<NameLink to={href.bbLeague(g.league.code)} className="text-xs text-faint">{g.league.name}</NameLink>}>
      <div className="grid grid-cols-2 gap-3">
        {card('H', h)}
        {card('A', a)}
      </div>
      {h && a && !same && (
        <p className="mt-3 text-center text-xs text-muted">
          {t('{0} {1} in {2}, {3} {4} in {5}', { 0: g.home.name, 1: ordinal(h.r.position), 2: groupIn(h.group.name), 3: g.away.name, 4: ordinal(a.r.position), 5: groupIn(a.group.name) })}
        </p>
      )}
      {h && a && same && gap > 0 && (
        <p className="mt-3 text-center text-xs text-muted">
          <b className={TEXT[h.r.position < a.r.position ? 'H' : 'A']}><NameLink to={href.bbTeam(h.r.position < a.r.position ? g.home.id : g.away.id, h.r.position < a.r.position ? g.home.name : g.away.name)}>{h.r.position < a.r.position ? g.home.name : g.away.name}</NameLink></b> {gap === 1 ? t('are one place higher') : t('are {0} places higher', { 0: gap })}
        </p>
      )}
      <div className="mt-5">
        <StandingsTable data={data} mark={[g.home.id, g.away.id]} colors={{ [g.home.id]: 'H', [g.away.id]: 'A' }} />
      </div>
    </Card>
  )
}

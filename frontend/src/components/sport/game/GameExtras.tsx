import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t, LOCALE } from '../../../lib/i18n'
import { Section } from './GamePage'
import NameLink from '../NameLink'
import { matchHref, teamHref as teamLink, playerHref, LINK_SPORT } from '../../../lib/links'
import { placeText } from '../../../lib/genText'

/**
 * fix231: the game-page extras, every sport where they apply (backend services/gameExtras.ts) — Trends (true facts from
 * our own results, at most 4), each side's next 5 games coloured by our win chance (fixture difficulty), the weather at
 * the venue for the start (outdoors only) and the referee (football). Each card shows only when it has something.
 * TeamDifficulty is the team page's (tennis: the player page's) next 5 games.
 */
export type ExtrasSport = 'football' | 'basketball' | 'nfl' | 'tennis'
type Band = 'easy' | 'medium' | 'hard' | 'unknown'
interface NextGame { id: number; date: string | null; opp: string | null; oppId: number | null; home: boolean | null; band: Band; sides: { home: string | null; away: string | null; homeId: number | null; awayId: number | null } | null }
interface TrendT { side: 'home' | 'away'; team: string | null; pattern: string; split: 'all' | 'home' | 'away' | 'surface'; k: number | null; n: number | null; line: number | null }
interface Side { id: number | null; name: string | null; next: NextGame[] | null }
interface Extras {
  indoor: boolean
  surface: string | null
  weather: { tempC: number | null; rainPct: number | null; rainMm: number | null; windKmh: number | null; notes: ('wind' | 'rain' | 'heat')[] | null; venue: string | null; city: string | null; start: string | null; at: string } | null
  referee: { name: string | null; games: number | null; show: boolean; homeWin?: number | null; leagueHomeWin?: number; cards?: number | null; leagueCards?: number | null; pens?: number | null; leaguePens?: number | null } | null
  trends: TrendT[] | null
  difficulty: { home: Side | null; away: Side | null } | null
}

/* fix271: the API may leave any field null (a college team with no next game, a game whose opponent is not known yet:
   "reading 'length' of null" on /american-football/team/…): every list goes through arr(), every game list through
   games(), every text is read with ?? '', so no card reads .length / .map / .toFixed of null */
const arr = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x.filter(v => v != null) : [])
const games = (x: NextGame[] | null | undefined): NextGame[] => arr(x).filter(g => typeof g === 'object' && g.id != null)

function useExtras<T>(path: string | null): T | null {
  const [d, setD] = useState<T | null>(null)
  useEffect(() => {
    setD(null)
    if (!path) return
    let off = false
    axios.get(`${API_URL}/extras/${path}`).then(r => { if (!off) setD(r.data?.data ?? null) }).catch(() => undefined)
    return () => { off = true }
  }, [path])
  return d
}

// fix229: slug links from lib/links (names + date), never a hand-built path
const gameHref = (sport: ExtrasSport, g: NextGame) => matchHref(LINK_SPORT[sport], g.id, { home: g.sides?.home, away: g.sides?.away, date: g.date, homeId: g.sides?.homeId, awayId: g.sides?.awayId })
const teamHref = (sport: ExtrasSport, id: number | null, name: string | null) => sport === 'tennis' ? playerHref('tennis', id, name) : teamLink(LINK_SPORT[sport], id, name)

/* ---------- trends ---------- */

const SURFACE: Record<string, string> = { clay: 'clay', grass: 'grass', hard: 'hard courts', carpet: 'carpet' }
function gamesWord(sport: ExtrasSport, split: TrendT['split'], surface: string | null): string {
  if (sport === 'tennis') return split === 'surface' && surface ? t('matches on {surface}', { surface: t(SURFACE[surface] || surface) }) : t('matches')
  return split === 'home' ? t('home games') : split === 'away' ? t('away games') : t('games')
}
/** one trend → its sentence (the numbers are the counted games; the backend checks every one before it is sent) */
export function trendText(sport: ExtrasSport, x: TrendT, surface: string | null = null): string {
  const v = { team: x.team ?? '', k: x.k ?? 0, n: x.n ?? 0, games: gamesWord(sport, x.split, surface), line: x.line ?? '' }
  if (sport === 'tennis') return x.pattern === 'win' ? t('{team} has won {k} of their last {n} {games}', v) : t('{team} has lost {k} of their last {n} {games}', v)
  switch (x.pattern) {
    case 'win': return t('{team} have won {k} of their last {n} {games}', v)
    case 'loss': return t('{team} have lost {k} of their last {n} {games}', v)
    case 'unbeaten': return t('{team} have avoided defeat in {k} of their last {n} {games}', v)
    case 'winless': return t('{team} have failed to win {k} of their last {n} {games}', v)
    case 'over': return sport === 'football' ? t('Over {line} goals in {k} of {team}’s last {n} {games}', v) : t('Over {line} points in {k} of {team}’s last {n} {games}', v)
    case 'under': return sport === 'football' ? t('Under {line} goals in {k} of {team}’s last {n} {games}', v) : t('Under {line} points in {k} of {team}’s last {n} {games}', v)
    case 'btts': return t('Both teams scored in {k} of {team}’s last {n} {games}', v)
    case 'cleanSheet': return t('{team} have kept a clean sheet in {k} of their last {n} {games}', v)
    case 'noGoal': return t('{team} have failed to score in {k} of their last {n} {games}', v)
    default: return ''
  }
}

function Trends({ sport, list, surface }: { sport: ExtrasSport; list: TrendT[]; surface: string | null }) {
  const shown = list.map(x => trendText(sport, x, surface)).filter(Boolean)
  if (!shown.length) return null
  return (
    <Section title={t('Trends')}>
      <ul className="space-y-2">
        {list.map((x, i) => {
          const text = trendText(sport, x, surface)
          return text ? (
            <li key={i} className="flex gap-2 text-sm text-ink">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${x.side === 'home' ? 'bg-home' : 'bg-away'}`} aria-hidden />
              <span>{text}</span>
            </li>
          ) : null
        })}
      </ul>
      <p className="mt-3 text-[11px] text-faint">{t('From our own results: the most unusual next to the league, at least 6 games.')}</p>
    </Section>
  )
}

/* ---------- fixture difficulty ---------- */

const BAND_CLS: Record<Band, string> = {
  easy: 'bg-win/15 text-win border-win/30', medium: 'bg-draw/15 text-draw border-draw/30', hard: 'bg-loss/15 text-loss border-loss/30', unknown: 'bg-surface2 text-faint border-line'
}
const bandLabel = (b: Band) => b === 'easy' ? t('Easy') : b === 'medium' ? t('Medium') : b === 'hard' ? t('Tough') : t('No prediction yet')
const day = (iso: string | null) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d.getTime()) ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : '' }
const short = (s: string | null) => { const x = s ?? ''; return x.length > 14 ? `${x.slice(0, 13)}…` : x }

function Strip({ sport, list }: { sport: ExtrasSport; list: NextGame[] }) {
  if (!list.length) return <p className="text-xs text-faint">{t('No games scheduled yet')}</p>
  return (
    <div className="grid grid-cols-5 gap-1.5">
      {list.map(g => (
        <NameLink key={g.id} to={gameHref(sport, g)} className={`block rounded-lg border px-1.5 py-1.5 text-center min-w-0 ${BAND_CLS[g.band] ?? BAND_CLS.unknown}`}>
          <span title={`${bandLabel(g.band)} · ${g.opp ?? ''}`} className="block">
            <span className="block text-[10px] num opacity-80">{day(g.date)}</span>
            <span className="block text-[11px] font-semibold truncate">{short(g.opp)}</span>
            {g.home != null && <span className="block text-[10px] opacity-80">{g.home ? t('H') : t('A')}</span>}
          </span>
        </NameLink>
      ))}
    </div>
  )
}
function Legend() {
  return (
    <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-faint">
      {(['easy', 'medium', 'hard'] as Band[]).map(b => <span key={b} className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm border ${BAND_CLS[b]}`} />{bandLabel(b)}</span>)}
      <span>{t('By our win chance for each game.')}</span>
    </div>
  )
}
function Difficulty({ sport, d }: { sport: ExtrasSport; d: NonNullable<Extras['difficulty']> }) {
  const sides = [d.home, d.away].map(s => ({ id: s?.id ?? null, name: s?.name ?? '', next: games(s?.next) }))
  if (!sides.some(s => s.next.length)) return null
  return (
    <Section title={t('Next games')}>
      <div className="space-y-4">
        {sides.map((s, i) => (
          <div key={i}>
            <NameLink to={teamHref(sport, s.id, s.name)} className={`label block pb-1.5 ${i === 0 ? 'text-home' : 'text-away'}`}>{s.name}</NameLink>
            <Strip sport={sport} list={s.next} />
          </div>
        ))}
      </div>
      <Legend />
    </Section>
  )
}

/** a team's (tennis: a player's) next 5 games on its page, coloured by our win chance */
export function TeamDifficulty({ sport, id }: { sport: ExtrasSport; id: number }) {
  const d = useExtras<{ next: NextGame[] | null }>(`${sport}/team/${id}`)
  const next = games(d?.next)
  if (!next.length) return null
  return (
    <Section title={sport === 'tennis' ? t('Next matches') : t('Next games')}>
      <Strip sport={sport} list={next} />
      <Legend />
    </Section>
  )
}

/* ---------- weather ---------- */

const NOTE: Record<'wind' | 'rain' | 'heat', string> = {
  wind: 'Strong wind (30 km/h or more): harder conditions for both sides.',
  rain: 'Heavy rain expected: a slower, heavier game.',
  heat: 'Hot (30 °C or more): the pace usually drops.'
}
const fx = (x: number | null | undefined, d: number) => (typeof x !== 'number' ? '–' : x.toFixed(d))
function WeatherCard({ w, sport }: { w: NonNullable<Extras['weather']>; sport: ExtrasSport }) {
  const n = (x: number | null, unit: string, d = 0) => (typeof x !== 'number' ? '–' : `${x.toFixed(d)}${unit}`)
  const start = w.start ? new Date(w.start) : null
  const when = start && !isNaN(start.getTime()) ? start.toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : null
  const notes = arr(w.notes).filter(k => NOTE[k])
  const tiles = [
    { label: t('Temperature'), value: n(w.tempC, ' °C') },
    { label: t('Chance of rain'), value: n(w.rainPct, '%') },
    { label: t('Rain'), value: n(w.rainMm, ' mm', 1) },
    { label: t('Wind'), value: n(w.windKmh, ' km/h') }
  ]
  return (
    <Section title={sport === 'tennis' ? t('Weather at the start') : t('Weather at kick-off')} note={[w.venue ? placeText(w.venue) : null, when].filter(Boolean).join(' · ')}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tiles.map(x => (
          <div key={x.label} className="rounded-lg bg-surface2 px-3 py-2">
            <div className="text-[11px] text-faint">{x.label}</div>
            <div className="num text-base font-bold text-ink">{x.value}</div>
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {notes.map(k => <li key={k} className="text-sm text-draw">{t(NOTE[k])}</li>)}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-faint">{t('Forecast for the venue at the start time (Open-Meteo), updated every 3 hours.')}</p>
    </Section>
  )
}

/* ---------- referee ---------- */

const pc = (x: number | null | undefined) => (typeof x !== 'number' ? '–' : `${Math.round(x * 100)}%`)
function RefereeCard({ r }: { r: NonNullable<Extras['referee']> }) {
  const rows = r.show ? [
    { label: t('Cards a game'), his: fx(r.cards, 1), lg: fx(r.leagueCards, 1) },
    { label: t('Penalties a game'), his: fx(r.pens, 2), lg: fx(r.leaguePens, 2) },
    { label: t('Home wins'), his: pc(r.homeWin), lg: pc(r.leagueHomeWin) }
  ] : []
  return (
    <Section title={t('Referee')} note={t('{0} games this season', { 0: r.games ?? 0 })}>
      <div className="font-semibold text-ink">{r.name}</div>
      {r.show ? (
        <table className="mt-3 w-full text-sm num">
          <thead><tr className="text-[11px] text-faint"><th className="text-start font-normal" /><th className="text-end font-normal">{t('His games')}</th><th className="text-end font-normal">{t('League')}</th></tr></thead>
          <tbody>{rows.map(x => <tr key={x.label} className="border-t border-line"><td className="py-1.5 text-muted">{x.label}</td><td className="py-1.5 text-end font-bold text-ink">{x.his}</td><td className="py-1.5 text-end text-muted">{x.lg}</td></tr>)}</tbody>
        </table>
      ) : (
        <p className="mt-2 text-xs text-muted">{t('His numbers show from 10 games in this league this season.')}</p>
      )}
      <p className="mt-3 text-[11px] text-faint">{t('Pulled toward the league average until he has many games. Shown for interest: it does not change our prediction.')}</p>
    </Section>
  )
}

/** every extra of one game page */
export default function GameExtras({ sport, id }: { sport: ExtrasSport; id: number }) {
  const d = useExtras<Extras>(`${sport}/game/${id}`)
  if (!d || typeof d !== 'object') return null
  return (
    <>
      <Trends sport={sport} list={arr(d.trends)} surface={d.surface ?? null} />
      {d.difficulty && <Difficulty sport={sport} d={d.difficulty} />}
      {d.weather && !d.indoor && <WeatherCard w={d.weather} sport={sport} />}
      {d.referee?.name && <RefereeCard r={d.referee} />}
    </>
  )
}

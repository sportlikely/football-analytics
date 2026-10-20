import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { Section } from '../../components/sport/game/GamePage'
import { t, LOCALE } from '../../lib/i18n'
import { useTennisTour, tennisHref, flagOf, surname, roundName, qualifyingWord, countryName, setsText, tierLabel, surfaceName, SURFACE_DOT, type TourFilter, type TMatch } from '../../lib/tennis'

/** Shared pieces of the tennis pages (fix193): the tour chips, the tournament panel, a player's name with flag and rank. */

/** All · ATP · WTA · Challenger — in the address (?tour=), like American football's league chips */
export function TennisTourChips({ className = '' }: { className?: string }) {
  const { tour, set } = useTennisTour()
  const chip = (active: boolean) => `shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full text-sm font-semibold border transition-colors ${active ? 'bg-accent text-bg border-accent' : 'bg-surface2/70 text-ink border-line/70 hover:border-accent/50'}`
  const opt = (f: TourFilter, label: string) => <button key={f} type="button" onClick={() => set(f)} aria-pressed={tour === f} className={chip(tour === f)}>{label}</button>
  return (
    <div role="group" aria-label={t('Tour')} className={`flex gap-2 overflow-x-auto no-scrollbar ${className}`}>
      {opt('all', t('All'))}{opt('atp', 'ATP')}{opt('wta', 'WTA')}{opt('challenger', 'Challenger')}
    </div>
  )
}

/** "🇪🇸 Carlos Alcaraz 2" — flag, the name (a link when we know the player), the ranking */
export function PlayerName({ p, short = false, bold = false, className = '' }: { p: TMatch['home']; short?: boolean; bold?: boolean; className?: string }) {
  const href = tennisHref.player(p.id)
  const name = short ? surname(p) : p.name
  const flag = flagOf(p.country)
  const body = <>{flag && <span aria-hidden className="mr-1">{flag}</span>}<span className={bold ? 'font-bold text-ink' : ''}>{name}</span>{p.rank ? <span className="ml-1 text-[10px] font-semibold text-faint num">{p.rank}</span> : null}</>
  return href ? <Link to={href} className={`hover:text-accent ${className}`}>{body}</Link> : <span className={className}>{body}</span>
}

export function SurfaceTag({ surface, indoor }: { surface: string | null; indoor?: boolean | null }) {
  if (!surface) return null
  return <span className="inline-flex items-center gap-1 text-xs text-muted"><span className={`w-2 h-2 rounded-full ${SURFACE_DOT[surface] || 'bg-faint'}`} aria-hidden />{surfaceName(surface, indoor)}</span>
}

interface TournamentLite { key: string; name: string; tour: string; level: string; tier: string | null; surface: string | null; indoor: boolean | null; city: string | null; country: string | null; start: string | null; end: string | null
  draw: { code: string; name: string; qualifying: boolean; matches: TMatch[] }[]; record: { n: number; right: number; pct: number | null } }

/** The Matches page's right panel when one tournament is chosen: the event, its latest results and the next matches. */
export function TennisTournamentPanel({ tkey }: { tkey: string }) {
  const [d, setD] = useState<TournamentLite | null | undefined>(undefined)
  useEffect(() => {
    setD(undefined)
    axios.get(`${API_URL}/tennis/tournament/${tkey}`).then(r => setD(r.data.data || null)).catch(() => setD(null))
  }, [tkey])
  const all = d ? d.draw.flatMap(r => r.matches) : []
  const done = all.filter(m => m.state === 'done').sort((a, b) => b.start.localeCompare(a.start)).slice(0, 8)
  const first = all[0]
  return (
    <aside className="xl:sticky xl:top-20 space-y-4">
      <section className="card p-4 space-y-3">
        {d === undefined ? <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-6 rounded-lg bg-surface2/60 animate-pulse" />)}</div>
          : !d ? <p className="text-xs text-faint">{t('No details for this tournament yet.')}</p>
          : (
            <>
              <div>
                <Link to={tennisHref.tournament(d.key)} className="font-display font-bold text-ink hover:text-accent">{d.name}</Link>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted mt-1">
                  {first && <span>{tierLabel(first)}</span>}
                  <SurfaceTag surface={d.surface} indoor={d.indoor} />
                  {(d.city || d.country) && <span>{[d.city, d.country ? countryName(d.country) : null].filter(Boolean).join(', ')}</span>}
                </div>
              </div>
              {done.length > 0 && (
                <div>
                  <div className="label pb-1">{t('Latest results')}</div>
                  <ul className="space-y-1.5 text-xs">
                    {done.map(m => (
                      <li key={m.id}>
                        <Link to={tennisHref.match(m.id)} className="flex items-center justify-between gap-2 hover:text-accent">
                          <span className="min-w-0 truncate"><span className="font-semibold text-ink">{surname(m.winner === 2 ? m.away : m.home)}</span> <span className="text-faint">{t('beat')}</span> {surname(m.winner === 2 ? m.home : m.away)}</span>
                          <span className="num text-muted shrink-0">{setsText(m.score, m.winner === 2)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.record.n >= 5 && <p className="text-xs text-muted">{t('Our record here: {0} of {1} picks right ({2}%).', { 0: d.record.right, 1: d.record.n, 2: d.record.pct ?? 0 })}</p>}
            </>
          )}
      </section>
      <Link to={tennisHref.tournament(tkey)} className="block text-center text-xs font-bold text-accent">{t('Draw and results →')}</Link>
    </aside>
  )
}

export const dayTime = (iso: string) => new Date(iso).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** a player's finished match as the match and player pages list it */
export interface Played { id: number; start: string; tournament: string; tkey: string; surface: string | null; round: string | null; roundCode?: string | null; opponent: { id: number | null; name: string; short?: string; country: string | null }; won: boolean; score: string; sets: number; minutes: number | null; retired: boolean }

/** W / L, the opponent (their page), the tournament (its page), the score (the match page) */
export function FormList({ list, title, empty }: { list: Played[]; title?: ReactNode; empty?: string }) {
  return (
    <div className="min-w-0">
      {title && <div className="label pb-1.5">{title}</div>}
      {!list.length ? <p className="text-sm text-faint">{empty || t('No recent matches.')}</p> : (
        <ul className="divide-y divide-line/50">
          {list.map(x => (
            <li key={x.id} className="flex items-center gap-2 py-1.5 text-sm px-1">
              <span className={`w-5 h-5 rounded grid place-items-center text-[10px] font-extrabold flex-shrink-0 ${x.won ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{x.won ? t('W') : t('L')}</span>
              <span className="min-w-0 flex-1">
                <PlayerName p={{ ...x.opponent, rank: null, logo: null }} className="block truncate" />
                <span className="block text-[11px] text-faint truncate"><Link to={tennisHref.tournament(x.tkey)} className="hover:text-accent">{x.tournament}</Link>{roundName(x) ? ` · ${roundName(x)}` : ''}</span>
              </span>
              <Link to={tennisHref.match(x.id)} className="num text-xs text-muted shrink-0 hover:text-accent inline-flex gap-1.5">{x.score.split(' ').filter(Boolean).map((v, i) => <span key={i}>{v.replace('-', '–')}</span>)}{x.retired ? <span>{t('ret.')}</span> : null}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** one round of a tournament's draw (from our matches) */
export interface DrawRound { code: string; name: string; qualifying: boolean; matches: TMatch[] }

/**
 * The draw: rounds from our matches (one row per match), the main draw in order — first round to the final — and
 * qualifying in its own section below it (fix195); `m` = the match to highlight (the match page)
 */
export function DrawTab({ m, rounds }: { m: TMatch | null; rounds: DrawRound[] }) {
  const main = rounds.filter(r => !r.qualifying), quali = rounds.filter(r => r.qualifying)
  const block = (r: DrawRound) => (
    <div key={(r.qualifying ? 'q' : '') + r.code} className="min-w-0">
      <div className="label pb-1">{roundName(r.code) || (r.qualifying ? qualifyingWord() : t('Matches'))}</div>
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
                      <span className="num text-xs text-muted shrink-0 inline-flex gap-2">{x.score ? x.score.sets.map((v, i) => <span key={i}>{v[k - 1]}</span>) : null}</span>
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
          {main.length > 0 && <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{main.map(block)}</div>}
          {quali.length > 0 && (
            <div className="border-t border-line/60 pt-4">
              <h3 className="font-display font-bold text-sm text-ink pb-2">{qualifyingWord()}</h3>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{quali.map(block)}</div>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

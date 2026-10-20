import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { useTennisTour, tennisHref, flagOf, surname, setsText, tierLabel, surfaceName, SURFACE_DOT, type TourFilter, type TMatch } from '../../lib/tennis'

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
  const name = short ? surname(p.name) : p.name
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
                  {(d.city || d.country) && <span>{[d.city, d.country].filter(Boolean).join(', ')}</span>}
                </div>
              </div>
              {done.length > 0 && (
                <div>
                  <div className="label pb-1">{t('Latest results')}</div>
                  <ul className="space-y-1.5 text-xs">
                    {done.map(m => (
                      <li key={m.id}>
                        <Link to={tennisHref.match(m.id)} className="flex items-center justify-between gap-2 hover:text-accent">
                          <span className="min-w-0 truncate"><span className="font-semibold text-ink">{surname((m.winner === 2 ? m.away : m.home).name)}</span> <span className="text-faint">{t('beat')}</span> {surname((m.winner === 2 ? m.home : m.away).name)}</span>
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

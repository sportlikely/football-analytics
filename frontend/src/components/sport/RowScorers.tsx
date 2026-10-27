import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t } from '../../lib/i18n'
import { footballScorers, basketballScorers, nflScorers, hasScorerLine, scorersRoute, type ScorerLines } from '../../lib/scorers'
import { knownId } from '../../lib/links'
import { RowScorers } from './game/ScoreLines'

/**
 * fix209 — a live or finished list row (every sport, every list) opens with its arrow to the same scorers line as the
 * match header. Collapsed by default (lists stay short); fetched on first open from the sport's small /scorers route
 * (no provider call), every 60 s while open and live.
 */

/** The /scorers route of a game page link, and how to read it; null = this row has no scorers line (tennis: the sets, a
 *  past season's game: no link). fix252: the link may be null, and a slug link finds its id in lib/links. */
export function scorersSource(href: string | null | undefined): { url: string; read: (d: any) => ScorerLines | null } | null {
  const r = scorersRoute(href, (sport, slug) => knownId(sport, 'match', slug))
  if (!r) return null
  if (r.sport === 'football') return { url: `${API_URL}/matches/${r.id}/scorers`, read: d => (d ? footballScorers(d) : null) }
  if (r.sport === 'basketball') return { url: `${API_URL}/basketball/game/${r.id}/scorers`, read: d => (d ? basketballScorers(d) : null) }
  return { url: `${API_URL}/nfl/game/${r.id}/scorers`, read: d => (d ? nflScorers(d.plays || [], d.homeId, d.awayId) : null) }
}

/** The arrow (inside the row's link: it opens the line, never the page). */
export function ScorersToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} aria-label={open ? t('Hide scorers') : t('Show scorers')} title={open ? t('Hide scorers') : t('Show scorers')}
      onClick={e => { e.preventDefault(); e.stopPropagation(); onToggle() }}
      className="mx-auto mt-0.5 grid place-items-center w-5 h-4 rounded text-faint hover:text-ink hover:bg-surface2">
      <svg viewBox="0 0 24 24" className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
    </button>
  )
}

/** The opened line under the row. */
export function RowScorersLine({ href, live, homeName, awayName, className = '' }: { href: string | null | undefined; live: boolean; homeName: string; awayName: string; className?: string }) {
  const src = scorersSource(href)
  const [lines, setLines] = useState<ScorerLines | null | undefined>(undefined)
  useEffect(() => {
    if (!src) return
    let gone = false
    // "pending" (football: the match is being built) stays undefined and asks again in 15 s
    const load = () => axios.get(src.url).then(r => !gone && setLines(r.data?.pending ? undefined : src.read(r.data?.data) || null)).catch(() => !gone && setLines(null))
    load()
    const iv = live || lines === undefined ? setInterval(load, live ? 60 * 1000 : 15 * 1000) : null
    return () => { gone = true; if (iv) clearInterval(iv) }
  }, [src?.url, live, lines === undefined])
  if (!src) return null
  return (
    <div className={className}>
      {lines === undefined ? <span className="text-[11px] text-faint animate-pulse">{t('Loading…')}</span>
        : lines && hasScorerLine(lines) ? <RowScorers lines={lines} homeName={homeName} awayName={awayName} />
        : <span className="text-[11px] text-faint">{t('No scorers yet')}</span>}
    </div>
  )
}

/** Open / closed state of one row's line. */
export function useScorersOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(false)
  return [open, () => setOpen(o => !o)]
}

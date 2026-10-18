import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import NameLink from '../NameLink'

/**
 * fix174: before vs after for the winner sports — football's "Lineups are out" cover pattern: our first prediction
 * against the current one when injury news (or a new starting quarterback) moved the numbers, with the players out.
 */
export interface ChangedPlayer { id: number; name: string; detail?: string | null; side: 'H' | 'A'; href?: string | null }
export default function NewsChange({ home, away, before, after, players, extra }: {
  home: string; away: string
  before: { pHome: number; pAway: number }; after: { pHome: number; pAway: number }
  players: ChangedPlayer[]; extra?: ReactNode
}) {
  const row = (label: string, b: number, a: number, cls: string) => {
    const d = Math.round(a) - Math.round(b)
    return (
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className={`font-semibold truncate ${cls}`}>{label}</span>
        <span className="num whitespace-nowrap"><span className="text-faint">{Math.round(b)}%</span> <span className="text-faint">→</span> <b className="text-ink">{Math.round(a)}%</b> <span className={d > 0 ? 'text-win' : d < 0 ? 'text-loss' : 'text-faint'}>({d > 0 ? '+' : ''}{d})</span></span>
      </div>
    )
  }
  return (
    <div className="mt-4 relative overflow-hidden rounded-2xl border border-accent/40 bg-[linear-gradient(150deg,rgb(var(--accent)/0.12),rgb(var(--surface)/0.6))] p-4 sm:p-5 space-y-3">
      <div className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-wider text-accent">
        <span className="w-2 h-2 rounded-full bg-accent animate-pulseDot" /> {t('Numbers changed')}</div>
      <p className="text-sm text-muted">{t('Injury news since our first prediction for this game: we recalculated with the players who are out.')}</p>
      <div className="space-y-1.5">
        {row(home, before.pHome, after.pHome, 'text-home')}
        {row(away, before.pAway, after.pAway, 'text-away')}
      </div>
      {extra}
      {players.length > 0 && (
        <div>
          <div className="label pb-1">{t('Players out')}</div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {players.map(p => (
              <li key={`${p.side}${p.id}`} className="flex items-center gap-2 text-sm min-w-0">
                <span className={`w-1.5 h-4 rounded-full shrink-0 ${p.side === 'H' ? 'bg-home' : 'bg-away'}`} />
                <NameLink to={p.href} className="text-ink truncate">{p.name}</NameLink>
                {p.detail && <span className="ml-auto text-[11px] text-faint whitespace-nowrap">{p.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

import type { ReactNode } from 'react'
import { t, ltr } from '../../../lib/i18n'
import NameLink from '../NameLink'
import PlayerPhoto from '../PlayerPhoto'

/**
 * fix224: the key players of both teams (every sport with teams: basketball's top 5 by impact × expected minutes, the
 * NFL's starting QB and top players), each with photo, impact, today's status and what the team loses without him.
 */
export type KeyTone = 'ok' | 'warn' | 'bad' | 'muted'
export interface KeyPlayerRow {
  id: number; name: string; href?: string | null; photo?: string | null
  /** "+3.2 pts a game · 34 min" */
  detail: string
  status: { tone: KeyTone; label: string; title?: string | null; link?: string | null }
  /** points of margin the team loses without him (negative); null = not priced by the model */
  without: number | null
}
export interface KeySideT { name: string; players: KeyPlayerRow[] }

const TONE: Record<KeyTone, string> = {
  ok: 'bg-win/15 text-win', warn: 'bg-draw/15 text-draw', bad: 'bg-loss/15 text-loss', muted: 'bg-surface2 text-muted'
}

function Side({ side, cls }: { side: KeySideT; cls: string }) {
  return (
    <div className="min-w-0">
      <div className={`label pb-2 ${cls}`}>{side.name}</div>
      <ul className="space-y-2.5">
        {side.players.map(p => (
          <li key={p.id} className="flex items-center gap-3 min-w-0">
            <PlayerPhoto src={p.photo} name={p.name} size={36} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <NameLink to={p.href} className="text-sm font-semibold text-ink truncate">{p.name}</NameLink>
                <span title={p.status.title || undefined} className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${TONE[p.status.tone]}`}>
                  {p.status.link ? <a href={p.status.link} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{p.status.label}</a> : p.status.label}
                </span>
              </div>
              <div className="text-[11px] text-faint num truncate">{p.detail}</div>
            </div>
            {p.without !== null && (
              <div className="shrink-0 text-end leading-tight" title={t('What our model takes off the team without him')}>
                <div className={`num text-sm font-bold ${p.without <= -1.5 ? 'text-loss' : 'text-muted'}`}>{ltr(`${p.without > 0 ? '+' : p.without < 0 ? '−' : ''}${Math.abs(p.without).toFixed(1)}`)}</div>
                <div className="text-[10px] text-faint">{t('without him')}</div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function KeyPlayers({ home, away, note, title }: { home: KeySideT | null; away: KeySideT | null; note?: ReactNode; title?: string }) {
  if (!home?.players.length && !away?.players.length) return null
  return (
    <section className="card p-5 sm:p-6 mt-4">
      <h2 className="font-display text-base sm:text-lg font-bold text-ink">{title || t('Key players')}</h2>
      <p className="mt-1 mb-4 text-xs text-muted">{note || t('The players who matter most to each team, their status for this game and how many points of margin the team loses without them.')}</p>
      <div className="grid gap-5 sm:grid-cols-2">
        {home && home.players.length > 0 && <Side side={home} cls="text-home" />}
        {away && away.players.length > 0 && <Side side={away} cls="text-away" />}
      </div>
    </section>
  )
}

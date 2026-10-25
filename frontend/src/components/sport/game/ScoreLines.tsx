import { Link } from 'react-router-dom'
import { t } from '../../../lib/i18n'
import type { ScorerItem, ScorerLines } from '../../../lib/scorers'

/**
 * fix209 — the scorers line under the score (every sport's game page, and a list row opened with its arrow): each
 * side's items under its own team, in order (football: goals, own goals "(OG)", penalties "(P)", red cards; basketball:
 * the top scorer; American football: the scoring plays). Built from lib/scorers.ts. A goal the provider has not named
 * yet shows as "Goal 52'" until the next update. Wraps on phones (one line per team when it fits).
 */

/** "N. Jackson" → "Jackson" (initials off; full names stay as written). */
export const scorerName = (n: string) => n.replace(/^(?:[A-ZÀ-Ý]\.\s*)+/u, '').trim() || n

function Item({ it, href }: { it: ScorerItem; href?: string | null }) {
  const name = it.name ? scorerName(it.name) : ''
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" data-scorer-mark={it.mark || 'goal'}>
      {it.mark === 'red' && <span role="img" aria-label={t('Red card')} className="inline-block w-[7px] h-[10px] rounded-[1.5px] bg-live translate-y-[1px]" />}
      {it.pre && <span className="font-bold text-ink/80">{it.pre}</span>}
      {it.mark === 'pending' ? (
        <span className="italic text-faint">{t('Goal')}</span>
      ) : href ? (
        <Link to={href} onClick={e => e.stopPropagation()} className="text-ink/90 font-semibold hover:underline underline-offset-2 decoration-1">{name}</Link>
      ) : (
        <span className="text-ink/90 font-semibold">{name}</span>
      )}
      {it.detail && <span className={`num ${it.mark === 'pts' ? 'font-bold text-ink' : 'text-faint'}`}>{it.detail}</span>}
    </span>
  )
}

function Side({ items, align, playerHref }: { items: ScorerItem[]; align: 'left' | 'right' | 'center'; playerHref?: (id: number, name: string) => string | null }) {
  return (
    <div className={`flex flex-wrap gap-x-2.5 gap-y-0.5 min-w-0 ${align === 'right' ? 'justify-center sm:justify-end' : align === 'left' ? 'justify-center sm:justify-start' : 'justify-center'}`}>
      {items.map((it, i) => <Item key={i} it={it} href={it.id && it.mark !== 'pending' && playerHref ? playerHref(it.id, it.name || '') : null} />)}
    </div>
  )
}

/** Under the hero: home items under the home team, away under the away team. */
export function HeaderScorers({ lines, playerHref }: { lines: ScorerLines; playerHref?: (id: number, name: string) => string | null }) {
  return (
    <div data-scorers="header" aria-label={t('Scorers')} className="relative mt-4 sm:mt-5 grid grid-cols-[1fr_auto_1fr] items-start gap-2 sm:gap-8 text-[11px] sm:text-xs text-muted">
      <Side items={lines.home} align="right" playerHref={playerHref} />
      <span aria-hidden className="w-5 sm:min-w-[170px] text-center text-faint leading-4">•</span>
      <Side items={lines.away} align="left" playerHref={playerHref} />
    </div>
  )
}

/** A list row opened with its arrow: the same items, home then away, on two short lines. */
export function RowScorers({ lines, homeName, awayName }: { lines: ScorerLines; homeName: string; awayName: string }) {
  return (
    <div data-scorers="row" className="space-y-0.5 text-[11px] text-muted">
      {(['home', 'away'] as const).map(s => lines[s].length > 0 && (
        <div key={s} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 min-w-0">
          <span className="text-faint font-semibold mr-0.5">{s === 'home' ? homeName : awayName}</span>
          {lines[s].map((it, i) => <Item key={i} it={it} />)}
        </div>
      ))}
    </div>
  )
}

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { footballTeamHref } from '../../lib/teamLink'

/**
 * fix174: a team / player / competition name that opens its page — same look as the text around it, underline on
 * hover. No `to` (no page for it): plain text. Inside a card that is already one link, render the name without this.
 */
export default function NameLink({ to, children, className = '' }: { to?: string | null; children: ReactNode; className?: string }) {
  if (!to) return <span className={className}>{children}</span>
  return (
    <Link to={to} onClick={e => e.stopPropagation()} className={`${className} hover:underline underline-offset-2 decoration-1`}>
      {children}
    </Link>
  )
}

/** Page links of every sport (one place, so every list links the same way). */
export const href = {
  /** football competition: Football-Data code (PL, CL…) or API-Football id / `AF<id>` (the page redirects AF39 → PL) */
  league: (c: string | number | null | undefined) => c == null || c === '' ? null : `/league/${typeof c === 'number' ? `AF${c}` : c}`,
  team: (id: number | null | undefined, comp?: string | null, name?: string | null) => id ? footballTeamHref(id, name || '', comp) : null,
  player: (id: number | null | undefined) => id ? `/player/${id}` : null,
  match: (id: number | null | undefined) => id ? `/match/${id}` : null,
  bbTeam: (id: number | null | undefined) => id ? `/basketball/team/${id}` : null,
  bbPlayer: (id: number | null | undefined) => id ? `/basketball/player/${id}` : null,
  bbLeague: (code: string | null | undefined) => code ? `/basketball/league/${code}` : null,
  bbGame: (id: number | null | undefined) => id ? `/basketball/game/${id}` : null,
  nflTeam: (id: number | null | undefined) => id ? `/american-football/team/${id}` : null,
  nflPlayer: (id: number | null | undefined) => id ? `/american-football/player/${id}` : null,
  nflGame: (id: number | null | undefined) => id ? `/american-football/game/${id}` : null,
  /** NFL (league 1) or college (league 2) standings */
  nflStandings: (league?: number | string | null) => String(league) === '2' || /college|ncaa/i.test(String(league ?? '')) ? '/american-football/college/league' : '/american-football/league'
}

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { teamHref, playerHref, leagueHref, matchHref } from '../../lib/links'

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

type M = { home: string | null | undefined; away: string | null | undefined; date: string | null | undefined; homeId?: number | string | null; awayId?: number | string | null }
type Id = number | null | undefined
/** Page links of every sport (one place, so every list links the same way). fix229: slug addresses (lib/links.ts) */
export const href = {
  /** football competition: Football-Data code (PL, CL…) or API-Football id / `AF<id>` */
  league: (c: string | number | null | undefined, name?: string | null) => leagueHref('football', c, name),
  team: (id: Id, _comp?: string | null, name?: string | null) => teamHref('football', id, name),
  player: (id: Id, name: string | null | undefined) => playerHref('football', id, name),
  match: (id: Id, m: M) => matchHref('football', id, m),
  bbTeam: (id: Id, name: string | null | undefined) => teamHref('basketball', id, name),
  bbPlayer: (id: Id, name: string | null | undefined) => playerHref('basketball', id, name),
  bbLeague: (code: string | null | undefined, name?: string | null) => leagueHref('basketball', code, name),
  bbGame: (id: Id, m: M) => matchHref('basketball', id, m),
  nflTeam: (id: Id, name: string | null | undefined) => teamHref('american-football', id, name),
  nflPlayer: (id: Id, name: string | null | undefined) => playerHref('american-football', id, name),
  nflGame: (id: Id, m: M) => matchHref('american-football', id, m),
  /** NFL (league 1) or college (league 2) standings */
  nflStandings: (league?: number | string | null) => leagueHref('american-football', String(league) === '2' || /college|ncaa/i.test(String(league ?? '')) ? '2' : '1')!
}

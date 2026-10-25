import { teamHref } from './links'

/**
 * fix164: the one link to a football team page. fix229: its slug address (/football/team/real-madrid) — the
 * Football-Data.org / API-Football id is only remembered for the click (lib/links.ts); `code` is no longer needed.
 */
export function footballTeamHref(id: number, name: string, _code?: string | null): string {
  return teamHref('football', id, name) || '/football'
}

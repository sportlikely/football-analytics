/**
 * fix289: one name style per game page (31 Oct check: the header said "Utah Jazz", the prediction bar "Utah Jazz" next to
 * "Blazers"). The hero, the prediction bar and "Your picks" show the same short display name of each side, and both sides
 * in the same style. The full name stays in the page title and the link's tooltip. Pure (no imports): test:fix289 runs it.
 *
 * Every sport's game page takes its names from here: football `fbPageNames`, basketball `bbPageNames`, American football
 * `pairPageNames` with lib/nfl.ts nick, tennis `pairPageNames` with lib/tennis.ts surname.
 */
export interface PageNames { home: string; away: string }

/** the longest name a row / the bar shows whole (fix132) */
export const NAME_FIT = 14

/** a short form per side from the sport's own rule (NFL nickname, tennis surname): the same rule for both */
export const pairPageNames = <T>(home: T, away: T, short: (x: T) => string): PageNames => ({ home: short(home), away: short(away) })

/** football: the provider's short name (Football-Data "Man United"), else the name — on both sides */
export const fbPageNames = (home: { name: string; shortName?: string | null }, away: { name: string; shortName?: string | null }): PageNames =>
  pairPageNames(home, away, t => t.shortName || t.name)

/**
 * basketball: both full names when both fit; else the NBA's nicknames on both sides ("Jazz" with "Blazers"); other
 * leagues (no city + nickname pattern) shorten only the side that does not fit, to its first word
 */
export function bbPageNames(home: string | null | undefined, away: string | null | undefined, code: string): PageNames {
  const h = home || 'TBD', a = away || 'TBD'
  if (h.length <= NAME_FIT && a.length <= NAME_FIT) return { home: h, away: a }
  const words = (n: string) => n.split(/\s+/)
  if (code === 'NBA') return { home: words(h).slice(-1)[0], away: words(a).slice(-1)[0] }
  return { home: h.length <= NAME_FIT ? h : words(h)[0], away: a.length <= NAME_FIT ? a : words(a)[0] }
}

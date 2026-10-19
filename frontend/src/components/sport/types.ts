import type { ReactNode } from 'react'
import type { Favorite } from '../../lib/favorites'
import type { SideTeam } from '../LeagueSidebar'
import type { HGame, HResults } from '../SportHome/types'

/**
 * fix152: football is the template for every page of every sport. The shared pages in components/sport/* render the
 * football layout; each sport passes an adapter with data, labels and stat names only (no layout code per sport).
 * The game shape is the home page's (HGame: teams, cells, "Our pick") plus what the lists need.
 */

/** A league / competition in the sidebar and the "day → league" groups. */
export interface SLeague {
  code: string
  name: string
  /** name under its country ("Serie A" instead of "Serie A (Brazil)") */
  short?: string
  logo: string | null
  /** ISO code for the flag ("gb-eng"); "world" / "eu" = international */
  country: string
  /** lower = shown first */
  rank: number
  /** league page (null = none) */
  href: string | null
  fav: Favorite
}

/** A side chip after the result cells (football: Over 2.5 / Both score; basketball + NFL: Margin / Total pts). */
export interface SChip { key: string; label: string; value: string; strong?: boolean; title?: string }

export interface SGame extends HGame {
  state: 'upcoming' | 'live' | 'done' | 'off'
  league: SLeague
  /** favorites this game belongs to (names), for the star and "Your favorites" */
  favWhy: string[]
  /** Spotlight weight: how big the game is (bigger = first) */
  weight: number
  chips: SChip[]
  /** a small line under the teams: "Upset watch · 34%" (loss) or "Now: Real 71%" (live) */
  note?: { text: string; tone: 'loss' | 'live' | 'muted' } | null
  /** finished games: our pick right / wrong */
  hit?: boolean | null
}

/** Everything the Matches / Games page shows; the adapter fetches it. */
export interface GamesData {
  loading: boolean
  error: string | null
  /** the next 30 days (live included); finished games are not in it */
  games: SGame[]
  leagues: SLeague[]
  /** Latest results (right column), "x / y picks right" */
  results: HResults
  /** the favorites menu: my teams, starred league codes, any favorite at all */
  favTeams: SideTeam[]
  favLeagues: string[]
  hasFavorites: boolean
}

export interface GamesAdapter {
  /** page title with no league chosen ("Matches" / "Games") */
  title: string
  /** "{0} fixtures in the next {1} days" in the sport's words */
  countLine: (n: number, days: number) => string
  /** nothing in play */
  noLive: string
  /** leagues pinned until the visitor stars some */
  defaultPinned: string[]
  favoritesHref: string
  /** a league's panel on the right when one league is chosen (table, results …); none = no panel */
  leaguePanel?: (code: string) => ReactNode
  /** fix183b: no league list (left panel, phone league chips): a sport whose leagues have their own switch (American
   *  football: NFL | College). The Live box stays; the games list takes the width. */
  noLeagueList?: boolean
  /** the switcher above the title (American football: NFL | College) */
  top?: ReactNode
  useData: () => GamesData
}

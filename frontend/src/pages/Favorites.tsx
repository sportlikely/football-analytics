import { t } from '../lib/i18n'
import type { Favorite } from '../lib/favorites'
import FavoritesPage from '../components/sport/Favorites'
import { footballGames } from '../components/sport/games/football'
import { footballTeamHref } from '../lib/teamLink'
import { leagueHref, playerHref } from '../lib/links'

/** fix152b: football's Favorites page is the shared one (components/sport/Favorites) with football's adapter. */
function hrefOf(f: Favorite) {
  if (f.kind === 'league') return leagueHref('football', f.code || f.ref, f.name)!
  if (f.kind === 'player') return playerHref('football', f.ref, f.name)!
  const id = f.ids?.[0]
  return id ? footballTeamHref(id, f.name) : `/football/matches`
}

export default function Favorites() {
  return (
    <FavoritesPage a={{
      games: footballGames, kinds: ['team', 'player', 'league'], hrefOf, self: '/football/favorites',
      browse: { to: '/football/matches', label: t("Browse matches") },
      empty: t("Search above, open a team, league or player and tap the star. You can also star a league from the list on the Matches page. Their games then appear here, are marked with a star everywhere, and come first on the Matches page.")
    }} />
  )
}

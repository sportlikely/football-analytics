import { t } from '../../lib/i18n'
import FavoritesPage from '../../components/sport/Favorites'
import { useNflGames } from '../../components/sport/games/nfl'
import { teamHref, playerHref, leagueHref } from '../../lib/links'

/** fix152b: NFL + college favorites = the shared Favorites page (football's) with the NFL adapter. */
export default function NflFavorites() {
  return (
    <FavoritesPage a={{
      games: useNflGames(), kinds: ['nfl-team', 'nfl-player', 'nfl-league'], self: '/american-football/favorites',
      hrefOf: f => (f.kind === 'nfl-league' ? leagueHref('american-football', f.ref === 'NCAA' ? '2' : '1')! : f.kind === 'nfl-player' ? playerHref('american-football', f.ref, f.name)! : teamHref('american-football', f.ref, f.name)!),
      browse: { to: '/american-football/games', label: t("Browse games") },
      empty: t("Search above, open a team, league or player and tap the star. You can also star a league from the list on the Games page. Their games then appear here, are marked with a star everywhere, and come first on the Games page.")
    }} />
  )
}

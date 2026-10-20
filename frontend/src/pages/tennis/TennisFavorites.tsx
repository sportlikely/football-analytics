import { t } from '../../lib/i18n'
import FavoritesPage from '../../components/sport/Favorites'
import { useTennisGames } from '../../components/sport/games/tennis'

/** fix193b: tennis favorites = the shared Favorites page (football's) with the tennis adapter: players and tournaments. */
export default function TennisFavorites() {
  return (
    <FavoritesPage a={{
      games: useTennisGames(), kinds: ['tennis-player', 'tennis-tournament'], self: '/tennis/favorites',
      hrefOf: f => (f.kind === 'tennis-tournament' ? `/tennis/tournament/${f.ref}` : `/tennis/player/${f.ref}`),
      browse: { to: '/tennis/matches', label: t("Browse matches") },
      empty: t("Search above, open a player or a tournament and tap the star. Their matches then appear here, are marked with a star everywhere, and come first on the Matches page.")
    }} />
  )
}

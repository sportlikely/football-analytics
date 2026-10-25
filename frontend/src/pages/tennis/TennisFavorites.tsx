import { t } from '../../lib/i18n'
import FavoritesPage from '../../components/sport/Favorites'
import { useTennisGames } from '../../components/sport/games/tennis'
import { leagueHref, playerHref } from '../../lib/links'

/** fix193b: tennis favorites = the shared Favorites page (football's) with the tennis adapter: players and tournaments. */
export default function TennisFavorites() {
  return (
    <FavoritesPage a={{
      games: useTennisGames(), kinds: ['tennis-player', 'tennis-tournament'], self: '/tennis/favorites',
      hrefOf: f => (f.kind === 'tennis-tournament' ? leagueHref('tennis', f.ref)! : playerHref('tennis', f.ref, f.name)!),
      browse: { to: '/tennis/matches', label: t("Browse matches") },
      empty: t("Search above, open a player or a tournament and tap the star. Their matches then appear here, are marked with a star everywhere, and come first on the Matches page.")
    }} />
  )
}

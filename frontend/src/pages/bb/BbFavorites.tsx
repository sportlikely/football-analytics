import { t } from '../../lib/i18n'
import FavoritesPage from '../../components/sport/Favorites'
import { basketballGames } from '../../components/sport/games/basketball'
import { teamHref, playerHref, leagueHref } from '../../lib/links'

/** fix152b: basketball favorites = the shared Favorites page (football's) with basketball's adapter. */
export default function BbFavorites() {
  return (
    <FavoritesPage a={{
      games: basketballGames, kinds: ['bb-team', 'bb-player', 'bb-league'], self: '/basketball/favorites',
      hrefOf: f => (f.kind === 'bb-league' ? leagueHref('basketball', f.code || f.ref, f.name)! : f.kind === 'bb-player' ? playerHref('basketball', f.ref, f.name)! : teamHref('basketball', f.ref, f.name)!),
      browse: { to: '/basketball/matches', label: t("Browse games") },
      empty: t("Search above, open a team, league or player and tap the star. You can also star a league from the list on the Games page. Their games then appear here, are marked with a star everywhere, and come first on the Games page.")
    }} />
  )
}

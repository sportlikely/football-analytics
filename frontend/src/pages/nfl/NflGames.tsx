import { t } from '../../lib/i18n'
import { useNflFilter } from '../../lib/nfl'
import Games from '../../components/sport/Games'
import TodayPage from '../../components/sport/Today'
import { useNflGames } from '../../components/sport/games/nfl'
import { NflLeagueChips } from './parts'

/**
 * NFL + college games (fix152): the Games list (fix152a) and Today (fix152b) are the shared pages — football's layout —
 * with the NFL adapters. The league (NFL | College) comes from the address.
 */
export default function NflGames({ today = false }: { today?: boolean }) {
  return today ? <NflToday /> : <NflGamesShared />
}

function NflGamesShared() {
  return <Games a={useNflGames()} />
}

function NflToday() {
  // fix185: NFL and college together (each game in its league's group); All · NFL · College filter in the address
  const { filter, param } = useNflFilter()
  return (
    <TodayPage a={{
      title: t('American football today'),
      params: { sport: 'american-football', league: param },
      gameHref: id => `/american-football/game/${id}`,
      leagueHref: code => (code === 'NCAA' ? '/american-football/college/league' : '/american-football/league'),
      all: { to: `/american-football/games${filter === 'all' ? '' : `?league=${filter === 2 ? 'college' : 'nfl'}`}`, label: t('All games →') },
      top: <NflLeagueChips />
    }} />
  )
}

import { t } from '../../lib/i18n'
import { useNflFilter } from '../../lib/nfl'
import Games from '../../components/sport/Games'
import TodayPage from '../../components/sport/Today'
import { useNflGames } from '../../components/sport/games/nfl'
import { NflLeagueChips } from './parts'
import { matchHref, leagueHref } from '../../lib/links'

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
      gameHref: g => matchHref('american-football', g.id, { ...g, date: g.kickoff })!,
      leagueHref: code => leagueHref('american-football', code === 'NCAA' ? '2' : '1'),
      all: { to: `/american-football/games${filter === 'all' ? '' : `?league=${filter === 2 ? 'college' : 'nfl'}`}`, label: t('All games →') },
      top: <NflLeagueChips />
    }} />
  )
}

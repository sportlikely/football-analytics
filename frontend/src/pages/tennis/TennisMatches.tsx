import { t } from '../../lib/i18n'
import { useTennisTour, tennisHref } from '../../lib/tennis'
import Games from '../../components/sport/Games'
import TodayPage from '../../components/sport/Today'
import { useTennisGames } from '../../components/sport/games/tennis'
import { TennisTourChips } from './parts'

/**
 * Tennis matches (fix193): the shared Matches list and Today page — football's layout — with the tennis adapters. The
 * tour (All · ATP · WTA · Challenger) comes from the address.
 */
export default function TennisMatches({ today = false }: { today?: boolean }) {
  return today ? <TennisToday /> : <Games a={useTennisGames()} />
}

function TennisToday() {
  const { tour } = useTennisTour()
  return (
    <TodayPage a={{
      title: t('Tennis today'),
      params: { sport: 'tennis', tour },
      gameHref: id => tennisHref.match(id),
      leagueHref: code => (code ? tennisHref.tournament(code) : null),
      all: { to: `/tennis/matches${tour === 'all' ? '' : `?tour=${tour}`}`, label: t('All matches →') },
      top: <TennisTourChips />
    }} />
  )
}

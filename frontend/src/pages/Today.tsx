import { t as tt } from '../lib/i18n'
import TodayPage, { type TodayAdapter } from '../components/sport/Today'
import { matchHref, leagueHref } from '../lib/links'

/** fix152b: the Today page is the shared one (components/sport/Today); football and basketball adapters. */
const ADAPTERS: Record<'football' | 'basketball', TodayAdapter> = {
  football: {
    title: tt("Football predictions today"), params: { sport: 'football' },
    gameHref: g => matchHref('football', g.id, { ...g, date: g.kickoff })!, leagueHref: (code, name) => leagueHref('football', code, name), all: { to: '/matches', label: tt("All matches →") }
  },
  basketball: {
    title: tt("Basketball predictions today"), params: { sport: 'basketball' },
    gameHref: g => matchHref('basketball', g.id, { ...g, date: g.kickoff })!, leagueHref: (code, name) => leagueHref('basketball', code, name), all: { to: '/basketball/games', label: tt('All games →') }
  }
}

export default function Today({ sport }: { sport: 'football' | 'basketball' }) {
  return <TodayPage a={ADAPTERS[sport]} />
}

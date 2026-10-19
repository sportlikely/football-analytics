import { t } from '../../lib/i18n'
import Accuracy from '../../components/sport/Accuracy'
import { winnerAccuracy } from '../../components/sport/accuracy/winner'

/** NFL + college football record (admins for now): football's record page with the winner adapter (fix152b). */
const a = winnerAccuracy({
  title: t('American football accuracy'),
  model: 'american-football',
  intro: t('Every pick is saved before kick-off and checked after the final whistle. Nothing is removed. Strong picks: 70%+ in the NFL, 75%+ in college football.'),
  url: '/nfl/accuracy',
  gameHref: id => `/american-football/game/${id}`,
  leagueName: c => (c === 'NCAA' ? t('College football') : 'NFL'),
  leagueHref: c => (c === 'NCAA' ? '/american-football/college/league' : '/american-football/league'),
  strongLabel: t('Strong picks right'),
  savedNote: t('picks saved before kick-off'),
  waitingNote: t('Bold = our pick. Each game is checked automatically after the final whistle.'),
  footnote: t('Our pick: the team we rate more likely to win, counted on every finished game. Predictions are probabilities, not promises.')
})

export default function NflAccuracy() {
  return <Accuracy a={a} />
}

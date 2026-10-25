import { t } from '../../lib/i18n'
import Accuracy from '../../components/sport/Accuracy'
import { winnerAccuracy } from '../../components/sport/accuracy/winner'

/** NFL + college football record (admins for now): football's record page with the winner adapter (fix152b). */
const a = winnerAccuracy({
  title: t('American football accuracy'),
  model: 'american-football',
  more: 'nfl',
  intro: t("Every pick is saved before kick-off and checked after the final whistle. Nothing is removed. College games are shown by level, so easy FBS vs FCS games don't pad the number. Strong picks: from the chance where our picks were right at least 75% of the time in testing, set per league."),
  url: '/nfl/accuracy',
  gameHref: id => `/american-football/game/${id}`,
  // fix220: college by level pairing
  leagueName: c => (c === 'NCAA-FBS' ? t('College football · FBS vs FBS') : c === 'NCAA-MISMATCH' ? t('College football · FBS vs FCS') : c === 'NCAA-FCS' ? t('College football · FCS vs FCS') : c.startsWith('NCAA') ? t('College football') : 'NFL'),
  leagueHref: c => (c.startsWith('NCAA') ? '/american-football/college/league' : '/american-football/league'),
  strongLabel: t('Strong picks right'),
  savedNote: t('picks saved before kick-off'),
  waitingNote: t('Bold = our pick. Each game is checked automatically after the final whistle.'),
  footnote: t('Our pick: the team we rate more likely to win, counted on every finished game. Predictions are probabilities, not promises.')
})

export default function NflAccuracy() {
  return <Accuracy a={a} />
}

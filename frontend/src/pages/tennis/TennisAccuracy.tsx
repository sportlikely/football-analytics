import { t } from '../../lib/i18n'
import Accuracy from '../../components/sport/Accuracy'
import { winnerAccuracy } from '../../components/sport/accuracy/winner'

const GROUP: Record<string, string> = { slam: 'Grand Slams', atp: 'ATP', wta: 'WTA', challenger: 'Challenger', 's:hard': 'Hard courts', 's:clay': 'Clay courts', 's:grass': 'Grass courts' }

/** Tennis record (admins for now, like the other sports): football's record page with the winner adapter (fix193c) —
 *  by tour and by surface, strong picks, calibration, the set score and total games. */
const a = winnerAccuracy({
  title: t('Tennis accuracy'),
  model: 'tennis',
  more: 'tennis',
  intro: t('Every pick is saved before the first serve and checked after the match. Nothing is removed. Walkovers and cancelled matches are not counted.'),
  url: '/tennis/accuracy',
  gameHref: id => `/tennis/match/${id}`,
  leagueName: c => t(GROUP[c] || c),
  strongLabel: t('Strong picks right'),
  savedNote: t('picks saved before the first serve'),
  waitingNote: t('Bold = our pick. Each match is checked automatically once it is over.'),
  footnote: t('Our pick: the player we rate more likely to win, counted on every finished match. Predictions are probabilities, not promises.'),
  scoreWords: {
    cols: [t('Set score right'), t('Games off')],
    title: t('Set scores and total games'),
    text: n => t('How often our most likely set score was exactly right, and how far our total games were from the real number, over {n, plural, one {# match} other {# matches}} (retirements left out).', { n }),
    a: t('Set score right'), aUnit: t('of matches'), aFmt: v => `${v}%`,
    b: t('Total games off by'), bUnit: t('games a match'), bFmt: v => `±${v}`
  }
})

export default function TennisAccuracy() {
  return <Accuracy a={a} />
}

import { useMemo } from 'react'
import { t } from '../../lib/i18n'
import { useBbConfig } from '../../lib/bb'
import Accuracy from '../../components/sport/Accuracy'
import { winnerAccuracy } from '../../components/sport/accuracy/winner'
import { matchHref, leagueHref } from '../../lib/links'

/** Basketball's record: every pick saved before tip-off (fix152b: football's record page with the winner adapter). */
export default function BbAccuracy() {
  const cfg = useBbConfig()
  const a = useMemo(() => winnerAccuracy({
    title: t('Basketball accuracy'),
    model: 'basketball',
    more: 'basketball',
    intro: t('Every pick is saved before tip-off and checked after the final buzzer. Nothing is removed. Pre-season games are not counted.'),
    url: '/basketball/record',
    gameHref: r => matchHref('basketball', r.gameId, { ...r, date: r.kickoff })!,
    leagueName: c => cfg?.leagues.find(l => l.code === c)?.name || c,
    leagueHref: c => leagueHref('basketball', c),
    strongLabel: t('Strong picks (70%+)'),
    savedNote: t('picks saved before tip-off'),
    waitingNote: t('Bold = our pick. Each game is checked automatically after the final buzzer.'),
    footnote: t('Our pick: the team we rate more likely to win, counted on every finished game. Predictions are probabilities, not promises.')
  }), [cfg])
  return <Accuracy a={a} />
}

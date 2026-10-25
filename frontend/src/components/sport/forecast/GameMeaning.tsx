import { t } from '../../../lib/i18n'
import { useGameMeaning, zoneLabel, pct, BAD_ZONE, type FcSport, type FcMeaning } from '../../../lib/seasonForecast'
import { Section } from '../game/GamePage'

/**
 * fix215: "What this game means" on every sport's game page — how each side's title / top-4 / play-off / relegation
 * chance changes with a win, a draw or a loss, from the season forecast's runs where that result happened. Shown only
 * when a result moves a chance by 2 points or more; locked like the game's prediction.
 */
export default function GameMeaning({ sport, id }: { sport: FcSport; id: number }) {
  const { data } = useGameMeaning(sport, id)
  if (!data) return null
  if (data.locked) return (
    <Section title={t('What this game means')}>
      <p className="text-sm text-muted">{t('How a win, a draw or a loss changes {0} and {1}’s season chances comes with this game’s prediction.', { 0: data.home.name, 1: data.away.name })}</p>
    </Section>
  )
  return (
    <Section title={t('What this game means')} note={data.league}>
      <div className="space-y-4">
        <Side d={data} side="home" sport={sport} />
        <Side d={data} side="away" sport={sport} />
      </div>
      <p className="mt-3 text-[11px] text-faint">{t('From the season forecast: the runs where this result happened, next to all runs.')}</p>
    </Section>
  )
}

function Side({ d, side, sport }: { d: FcMeaning; side: 'home' | 'away'; sport: FcSport }) {
  const s = d[side]
  if (!s.lines?.length) return null
  const res = d.results || []
  // this side's win / draw / loss → the result index (H, D, A or H, A)
  const order = (side === 'home' ? ['H', 'D', 'A'] : ['A', 'D', 'H']).filter(r => res.includes(r)).map(r => res.indexOf(r))
  const names = order.map(i => (res[i] === 'D' ? t('Draw') : (res[i] === 'H') === (side === 'home') ? t('Win') : t('Loss')))
  return (
    <div>
      <div className="font-bold text-ink text-sm mb-1.5">{s.name}</div>
      <div className="space-y-1.5">
        {s.lines.map(l => (
          <div key={l.zone} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm num">
            <span className="text-muted min-w-[8rem]">{zoneLabel(l.zone, sport)} <span className="text-faint">{t('now')} {pct(l.now, d.extremes)}</span></span>
            {order.map((i, k) => {
              const v = l.byResult[i], up = v != null && l.now != null && v > l.now
              const good = BAD_ZONE(l.zone) ? !up : up
              return (
                <span key={k} className="whitespace-nowrap">
                  <span className="text-faint text-xs">{names[k]}</span>{' '}
                  <b className={v == null ? 'text-faint' : good ? 'text-win' : 'text-loss'}>{pct(v, d.extremes)}</b>
                </span>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

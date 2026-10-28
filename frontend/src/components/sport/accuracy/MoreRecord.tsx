import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../../lib/socket'
import { t, LOCALE } from '../../../lib/i18n'
import type { MoreSport } from '../game/MorePredictions'

/**
 * "More predictions" on every sport's record page (fix204): per output, the games checked, how often our most likely
 * answer was right, and said vs happened in 10% steps once 200+ games are in ("Tracking since <date>: N games so far"
 * before that). Every competition counts (fix203). Only the outputs that are public (they passed the backtest).
 */
interface Out { output: string; games: number; hitRate: number | null; brier: number | null; logLoss: number | null; calibration: { from: number; n: number; said: number; happened: number }[] | null; public?: boolean }
interface Rec { sport: MoreSport; since: string | null; minGames: number; outputs: Out[] }

export default function MoreRecord({ sport }: { sport: MoreSport }) {
  const [r, setR] = useState<Rec | null>(null)
  useEffect(() => { axios.get(`${API_URL}/more/${sport}/record`).then(x => setR(x.data.data)).catch(() => setR(null)) }, [sport])
  if (!r || !r.outputs.length) return null
  const name: Record<string, string> = {
    score: t('Likely scores'), goals: t('Total goals'), homeGoals: t('Home team goals'), awayGoals: t('Away team goals'),
    cleanHome: t('Home clean sheet'), cleanAway: t('Away clean sheet'), win2Home: t('Home win by 2+ goals'), win2Away: t('Away win by 2+ goals'),
    ht: t('Half-time result'), htft: t('Half-time / full-time'), margin: t('Winning margin'), total: t('Total points'),
    homePts: t('Home team points'), awayPts: t('Away team points'), half: sport === 'nfl' ? t('Halftime leader') : t('First-half winner'), ot: t('Overtime'),
    sets: t('Set score'), first: t('First set'), games: t('Total games'), tb: t('At least one tie-break')
  }
  const since = r.since ? new Date(r.since).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) : null
  return (
    <section className="card p-5 sm:p-6">
      <h2 className="font-display text-base font-bold text-ink">{t('More predictions')}</h2>
      <p className="text-xs text-muted mt-1 mb-4">{t('Likely scores, totals, halves and more, saved before the start. "Right" = our most likely answer happened.')}</p>
      <div className="space-y-4">
        {r.outputs.map(o => (
          <div key={o.output} className="border-t border-line/60 pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-ink">{name[o.output] || o.output}{o.public === false && <span className="ms-2 text-[10px] font-bold uppercase text-draw">{t('admin only')}</span>}</span>
              <span className="text-xs text-muted num">
                {o.games ? t('{0} games · {1}% right', { 0: o.games.toLocaleString(LOCALE), 1: o.hitRate ?? '–' }) : t('No games checked yet')}
              </span>
            </div>
            {o.calibration ? (
              <div className="mt-2 flex items-end gap-1 h-16" aria-label={t('Said vs happened')}>
                {o.calibration.map(b => (
                  <div key={b.from} className="flex-1 flex flex-col items-center justify-end gap-0.5" title={t('We said {0}%, it happened {1}% ({2})', { 0: b.said, 1: b.happened, 2: b.n })}>
                    <div className="w-full flex items-end gap-px h-12">
                      <div className="flex-1 bg-muted/40 rounded-t" style={{ height: `${b.said}%` }} />
                      <div className="flex-1 bg-accent rounded-t" style={{ height: `${b.happened}%` }} />
                    </div>
                    <span className="text-[10px] text-faint num">{b.from}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-faint">{t('Tracking since {0}: {1} games so far', { 0: since || '–', 1: o.games })}</p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-4 text-[11px] text-faint">{t('Grey: what we said · lime: what happened, in 10% steps (from {0} games).', { 0: r.minGames })}</p>
    </section>
  )
}

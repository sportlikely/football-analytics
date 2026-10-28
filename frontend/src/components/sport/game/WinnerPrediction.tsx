import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { t } from '../../../lib/i18n'
import { useReveal, justRevealed, guessFirstOn, hideMatch } from '../../../lib/reveal'
import CountUp from '../../CountUp'
import { RevealCover } from '../../Reveal'
import UnlockPrompt from '../../UnlockPrompt'
import { TeamLogo } from '../../../pages/bb/parts'
import { Section } from './GamePage'
import { ModelName } from './ModelName'
import { slModelOf, type ModelSport } from '../../../lib/modelNames'

/**
 * The prediction block of the sports where our pick is the winner (basketball, NFL + college; fix152c — it was
 * written twice): 1 · total · 2 tiles, how strong the pick is, the bar, "saved before the start", three numbers
 * (spread or margin, predicted score, total) and "Why we think so". Locked, guess-first and reveal like football.
 */
export interface WinnerPred { locked?: boolean; pick?: 'H' | 'A' | null; pHome?: number; pAway?: number; total?: number | null; hit?: boolean | null; model?: string | null }
export interface WhyRow { tone: 'H' | 'A' | 'N'; text: string; points?: string | null; sub?: boolean }
interface Side { name: string; logo: string | null }
export interface WinnerPredictionProps {
  rid: number
  status: string
  p: WinnerPred | null
  home: Side
  away: Side
  upcoming: boolean
  model: string
  /** fix192: the page's sport, so an unknown model id still shows the right public name */
  sport: ModelSport
  /** 'tip-off' / 'kick-off' wording */
  saved: string
  updated: string
  strongAt: number
  stats: { label: string; value: string }[]
  why: WhyRow[]
  howCalc?: ReactNode
  badges?: ReactNode
  noPrediction: string
  /** a locked pick shows the team (basketball) */
  showLockedPick?: boolean
  /** fix193: the middle tile's label and value (tennis: total games); default total points */
  middle?: { label: string; value: string }
}

function Tile({ k, label, v, active, roll, delay = 0, text }: { k: 'H' | 'A' | 'T'; label: string; v?: number; active: boolean; roll: boolean; delay?: number; text?: string }) {
  const color = k === 'H' ? 'text-home' : k === 'A' ? 'text-away' : 'text-ink'
  const border = k === 'H' ? 'border-home/50 bg-home/10' : 'border-away/50 bg-away/10'
  return (
    <div className={`rounded-xl border p-3 sm:p-4 text-center min-w-0 ${active ? border : 'border-line/70 bg-surface2/40'} ${roll && active ? 'animate-pop' : ''}`}>
      <div className="text-[11px] text-faint mb-1 truncate">
        {k !== 'T' && <span className={`font-bold me-1 ${active ? color : ''}`}>{k === 'H' ? '1' : '2'}</span>}
        {label}
      </div>
      <div className={`num text-2xl sm:text-3xl font-extrabold ${active ? color : k === 'T' ? 'text-ink' : 'text-ink/70'}`}>
        {text !== undefined ? text : <CountUp value={v || 0} decimals={1} suffix="%" animate={roll} delay={delay} />}
      </div>
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface2/50 border border-line/60 px-3 py-2.5 text-center min-w-0">
      <div className="text-[11px] text-faint leading-tight">{label}</div>
      <div className="num text-base sm:text-lg font-extrabold text-ink truncate">{value}</div>
    </div>
  )
}

export default function WinnerPrediction(x: WinnerPredictionProps) {
  const p = x.p
  const open = !!p && !p.locked && typeof p.pHome === 'number'
  const { hidden, reveal } = useReveal(x.rid, x.status, open)
  const [anim, setAnim] = useState(false)
  const roll = justRevealed(x.rid)
  // opened from a phone list's "See prediction": play the reveal of a "guess first" cover (fix235: the page opens on
  // the prediction, no #prediction)
  const location = useLocation()
  const once = useRef(false)
  useEffect(() => {
    if (once.current) return
    once.current = true
    if ((location.state as any)?.reveal && hidden) setAnim(true)
  }, [])
  const note = p ? [slModelOf(p.model || x.model, x.sport), x.upcoming ? x.updated : x.saved].join(' · ') : undefined
  const total = typeof p?.total === 'number' ? p.total.toFixed(1) : '–'

  return (
    <Section id="prediction" title={t('Prediction')} note={note}>
      {!p ? (
        <p className="text-sm text-faint">{x.noPrediction}</p>
      ) : p.locked ? (
        <div className="space-y-4">
          {x.showLockedPick && p.pick && (
            <div className="flex items-center gap-3">
              <TeamLogo team={p.pick === 'H' ? x.home : x.away} size={40} />
              <div>
                <div className="text-xs text-faint">{t('Our pick')}</div>
                <div className={`font-display text-xl font-extrabold ${p.pick === 'H' ? 'text-home' : 'text-away'}`}>{t('{0} to win', { 0: (p.pick === 'H' ? x.home : x.away).name })}</div>
              </div>
            </div>
          )}
          <UnlockPrompt rid={x.rid} status={x.status} what={t('Win chances, point spread, total points and the predicted score, with the reasons behind the pick.')} />
        </div>
      ) : hidden || anim ? (
        <RevealCover key={anim ? 'auto' : 'cover'} autoStart={anim} model={slModelOf(p.model || x.model, x.sport)} onReveal={() => { setAnim(false); reveal() }} />
      ) : (() => {
        const pick = p.pick || ((p.pHome || 0) >= 50 ? 'H' : 'A')
        const team = pick === 'H' ? x.home : x.away
        const topV = Math.max(p.pHome || 0, p.pAway || 0)
        return (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-faint mb-2">{t('Who wins')}</div>
            <div className="grid grid-cols-3 gap-3">
              <Tile k="H" label={x.home.name} v={p.pHome} active={pick === 'H'} roll={roll} />
              <Tile k="T" label={x.middle?.label ?? t('Total points')} text={x.middle?.value ?? total} active={false} roll={roll} />
              <Tile k="A" label={x.away.name} v={p.pAway} active={pick === 'A'} roll={roll} delay={240} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${topV >= x.strongAt ? 'bg-accent/15 text-accent border-accent/40' : 'bg-surface2 text-ink border-line'}`}>
                {topV >= x.strongAt + 10 ? t('Very strong pick') : topV >= x.strongAt ? t('Strong pick') : topV >= 55 ? t('Pick') : Math.abs((p.pHome || 0) - (p.pAway || 0)) < 3 ? t('Even game') : t('Close game')}
              </span>
              <span className="text-muted">{t('Our pick')} · <span className="text-ink font-semibold">{team.name}</span> · <span className="num text-accent font-extrabold">{Math.round(topV)}%</span></span>
              {typeof p.hit === 'boolean' && <span className={`ms-auto rounded-full px-3 py-1 text-xs font-bold ${p.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{p.hit ? t('Right') : t('Wrong')}</span>}
              {x.badges}
            </div>
            <div className="flex h-2.5 gap-[3px] mt-4">
              <div className={`rounded-full bg-home ${pick === 'H' ? '' : 'opacity-35'}`} style={{ width: `calc(${p.pHome}% - 2px)` }} />
              <div className={`rounded-full bg-away ${pick === 'A' ? '' : 'opacity-35'}`} style={{ width: `calc(${p.pAway}% - 2px)` }} />
            </div>
            <ModelName sport={x.sport} className="mt-3" />
            {!x.upcoming && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="px-2.5 py-1 rounded-full bg-surface2 border border-line font-semibold text-ink">{x.saved}</span>
                <span>{t('This is exactly what we predicted before the game — it is never recalculated after the result.')}</span>
              </div>
            )}
            <div className="mt-5 grid grid-cols-3 gap-2">
              {x.stats.map(s => <Stat key={s.label} label={s.label} value={s.value} />)}
            </div>
            {x.why.length > 0 && (
              <div className="mt-5 rounded-2xl border border-line/60 bg-surface2/30 p-4">
                <div className="text-sm font-bold text-ink mb-2">{t('Why we think so')}</div>
                <ul className="space-y-2">
                  {x.why.map((w, i) => (
                    <li key={i} className={`flex items-start gap-3 text-sm ${w.sub ? 'ps-5' : ''}`}>
                      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${w.tone === 'H' ? 'bg-home' : w.tone === 'A' ? 'bg-away' : 'bg-faint'} ${w.sub ? 'opacity-60' : ''}`} />
                      <span className={`flex-1 leading-snug ${w.sub ? 'text-muted' : 'text-ink'}`}>{w.text}</span>
                      {w.points && (
                        <span className={`num text-xs font-bold whitespace-nowrap ${w.tone === 'H' ? 'text-home' : w.tone === 'A' ? 'text-away' : 'text-muted'}`}>{w.points}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {x.howCalc && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted hover:text-ink select-none">{t('How this was calculated')}</summary>
                    {x.howCalc}
                  </details>
                )}
              </div>
            )}
            {guessFirstOn() && x.upcoming && (
              <div className="mt-2 text-end">
                <button type="button" onClick={() => hideMatch(x.rid)} className="text-xs text-faint hover:text-ink underline underline-offset-4">{t('Hide prediction again')}</button>
              </div>
            )}
            <p className="mt-4 text-xs text-faint">{t('Probabilities, not promises. 18+.')}</p>
          </>
        )
      })()}
    </Section>
  )
}

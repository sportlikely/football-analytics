import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { t } from '../../../lib/i18n'
import { useReveal, justRevealed, guessFirstOn, hideMatch } from '../../../lib/reveal'
import { RevealCover } from '../../Reveal'
import UnlockPrompt from '../../UnlockPrompt'
import { TeamLogo } from '../../../pages/bb/parts'
import { Section } from './GamePage'
import { ModelName } from './ModelName'
import { slModelOf, type ModelSport } from '../../../lib/modelNames'
import { tg } from '../../../lib/genText'
import { useAuth } from '../../../lib/auth'
import type { Factor } from '../../../lib/whyFactors'
import WhyPanel from './WhyPanel'
import PredictionPanel from '../prediction/PredictionPanel'
import type { MoreSport } from '../prediction/more'
import type { TopicId } from '../prediction/questions'

/**
 * The prediction block of the sports where our pick is the winner (basketball, NFL + college, tennis; fix152c).
 * Locked, guess-first and reveal like football; open: fix281's shared prediction tab (components/sport/prediction:
 * split bar, "Most sure first", topics as sub-paths, "Why we think so" behind a button) with "saved before the
 * start" and three numbers (spread or margin, predicted score, total) under the bar.
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
  stats: { label: string; value: string }[]
  why: WhyRow[]
  /** fix282: every factor with the model's own points ("Why we think so" panel); the why lines + howCalc stay for admins */
  factors?: Factor[] | null
  howCalc?: ReactNode
  badges?: ReactNode
  noPrediction: string
  /** a locked pick shows the team (basketball) */
  showLockedPick?: boolean
  /** fix193: tennis: total games (the first of the three numbers under the bar) */
  middle?: { label: string; value: string }
  /** fix281: where the game's extras are stored, the open topic (a sub-path) and the short names of the sentences */
  more: { sport: MoreSport; id: number }
  topic: string
  onTopic: (id: TopicId) => void
  names?: { home: string; away: string }
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
  const admin = !!useAuth().user?.isAdmin
  const note = p ? [slModelOf(p.model || x.model, x.sport), x.upcoming ? x.updated : x.saved].join(' · ') : undefined

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
        // fix281: the shared prediction tab (split bar, "Most sure first", topics, "Why we think so" behind a button)
        const pick = p.pick || ((p.pHome || 0) >= 50 ? 'H' : 'A')
        const pH = p.pHome || 0, pA = typeof p.pAway === 'number' ? p.pAway : 100 - pH
        const hn = x.names?.home || x.home.name, an = x.names?.away || x.away.name
        const topV = pick === 'H' ? pH : pA
        // fix282: the factor panel; the why lines + how it was calculated stay for admins (or when no factors came)
        const showRows = x.why.length > 0 && (!x.factors?.length || admin)
        const whyBlock = x.factors?.length || showRows || x.howCalc ? (
          <>
            {x.factors && x.factors.length > 0 && <WhyPanel factors={x.factors} fav={pH > pA ? 'H' : pA > pH ? 'A' : null} home={x.home.name} away={x.away.name} favPct={Math.max(pH, pA)} otherPct={pH > pA ? pA : pA > pH ? pH : null} />}
            {(showRows || (x.howCalc && (!x.factors?.length || admin))) && (
              <div className={`rounded-2xl border border-line/60 bg-surface2/30 p-4 ${x.factors?.length ? 'mt-4' : ''}`}>
                {x.factors?.length ? <div className="text-sm font-bold text-ink mb-2">{t('Factor by factor')}</div> : null}
                {showRows && (
                  <ul className="space-y-2">
                    {x.why.map((w, i) => (
                      <li key={i} className={`flex items-start gap-3 text-sm ${w.sub ? 'ps-5' : ''}`}>
                        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${w.tone === 'H' ? 'bg-home' : w.tone === 'A' ? 'bg-away' : 'bg-faint'} ${w.sub ? 'opacity-60' : ''}`} />
                        <span className={`flex-1 leading-snug ${w.sub ? 'text-muted' : 'text-ink'}`}>{tg(w.text)}</span>
                        {w.points && (
                          <span className={`num text-xs font-bold whitespace-nowrap ${w.tone === 'H' ? 'text-home' : w.tone === 'A' ? 'text-away' : 'text-muted'}`}>{w.points}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {x.howCalc && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-muted hover:text-ink select-none">{t('How this was calculated')}</summary>
                    {x.howCalc}
                  </details>
                )}
              </div>
            )}
          </>
        ) : undefined
        return (
          <div className={roll ? 'animate-pop' : ''}>
            <PredictionPanel
              sport={x.more.sport} moreId={x.more.id} rid={x.rid} status={x.status} names={{ home: hn, away: an }} topic={x.topic} onTopic={x.onTopic}
              main={{
                cells: [{ key: 'H', pct: pH, on: pick === 'H' }, { key: 'A', pct: pA, on: pick === 'A' }],
                pick: { words: pick === 'H' ? x.home.name : x.away.name, pct: Math.round(topV) },
                items: [
                  { id: 'win-H', text: t('{0} win', { 0: hn }), pct: pH, hit: typeof p.hit === 'boolean' && pick === 'H' ? { text: p.hit ? hn : an, ok: p.hit } : null },
                  { id: 'win-A', text: t('{0} win', { 0: an }), pct: pA, hit: typeof p.hit === 'boolean' && pick === 'A' ? { text: p.hit ? an : hn, ok: p.hit } : null }
                ],
                card: { kind: 'split', id: 'winner', q: t('Who wins?'), cells: [{ key: 'H', label: `${hn} ${Math.round(pH)}%`, pct: pH, on: pick === 'H' }, { key: 'A', label: `${an} ${Math.round(pA)}%`, pct: pA, on: pick === 'A' }], call: { words: pick === 'H' ? hn : an, pct: topV } }
              }}
              under={(
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    {typeof p.hit === 'boolean' && <span className={`rounded-full px-3 py-1 text-xs font-bold ${p.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{p.hit ? t('Right') : t('Wrong')}</span>}
                    {x.badges}
                  </div>
                  <ModelName sport={x.sport} className="mt-3" />
                  {!x.upcoming && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span className="px-2.5 py-1 rounded-full bg-surface2 border border-line font-semibold text-ink">{x.saved}</span>
                      <span>{t('This is exactly what we predicted before the game — it is never recalculated after the result.')}</span>
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-3 gap-2">
                    {[...(x.middle ? [x.middle] : []), ...x.stats].slice(0, 3).map(s => <Stat key={s.label} label={s.label} value={s.value} />)}
                  </div>
                  {guessFirstOn() && x.upcoming && (
                    <div className="mt-2 text-end">
                      <button type="button" onClick={() => hideMatch(x.rid)} className="text-xs text-faint hover:text-ink underline underline-offset-4">{t('Hide prediction again')}</button>
                    </div>
                  )}
                </>
              )}
              why={whyBlock}
            />
          </div>
        )
      })()}
    </Section>
  )
}

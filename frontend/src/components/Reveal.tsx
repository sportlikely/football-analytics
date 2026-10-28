import { useEffect, useState } from 'react'
import { setGuessFirst } from '../lib/reveal'
import { t as tt } from '../lib/i18n'
import { slModel } from '../lib/modelNames'

const Eye = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const Spinner = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
)

// buttons can sit inside a card that is itself a link: keep the click from opening the match
const stop = (fn: () => void) => (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault()
  e.stopPropagation()
  fn()
}

const STEPS = [tt("Loading both squads"), tt("Reading form and strength"), tt("Checking injuries and lineups"), tt("Weighing home and away"), tt("Scoring the match")]

/**
 * Big cover for the match page. Tap Reveal → a short "SL Football 3.0 is analysing" sequence (steps tick by, a bar fills,
 * a scan line sweeps), then the prediction appears and its numbers roll in to their values.
 */
/** `model` (fix144; fix191: the public name, slModel / slModelOf): the sport's model, "SL Basketball 3.0" …; football by default. */
export function RevealCover({ onReveal, autoStart = false, model }: { onReveal: () => void; autoStart?: boolean; model?: string }) {
  // autoStart: the analysing sequence plays straight away (right after a match is unlocked)
  const [phase, setPhase] = useState<'idle' | 'loading'>(autoStart ? 'loading' : 'idle')
  const [step, setStep] = useState(0)
  const [fill, setFill] = useState(false)
  useEffect(() => {
    if (phase !== 'loading') return
    const total = 1700
    const f = requestAnimationFrame(() => setFill(true))
    const iv = setInterval(() => setStep(s => Math.min(STEPS.length - 1, s + 1)), total / STEPS.length)
    const done = setTimeout(onReveal, total)
    return () => { cancelAnimationFrame(f); clearInterval(iv); clearTimeout(done) }
  }, [phase])

  if (phase === 'loading')
    return (
      <div className="relative overflow-hidden rounded-2xl border border-accent/40 bg-accent/[0.06] p-6 sm:p-8" role="status" aria-live="polite">
        <div aria-hidden className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-accent/15 to-transparent animate-[scan_1.1s_linear_infinite]" />
        <div className="relative flex flex-col items-center gap-4 text-center">
          <div className="flex items-center gap-2.5 text-accent font-display font-bold">
            <Spinner size={18} /> {model ? tt("{0} is analysing this game", { 0: model }) : tt("{0} is analysing this match", { 0: slModel('football') })}</div>
          <div className="w-full max-w-md h-2 rounded-full bg-surface2 overflow-hidden">
            <div className="h-full rounded-full bg-accent transition-[width] ease-out" style={{ width: fill ? '100%' : '4%', transitionDuration: '1700ms' }} />
          </div>
          <ul className="w-full max-w-md space-y-1.5 text-start text-sm">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex items-center gap-2.5 transition-opacity duration-300 ${i <= step ? 'opacity-100' : 'opacity-30'}`}>
                <span className={`w-4 h-4 rounded-full grid place-items-center text-[10px] font-extrabold ${i < step ? 'bg-accent text-bg' : i === step ? 'border-2 border-accent' : 'border border-line'}`}>
                  {i < step ? '✓' : ''}
                </span>
                <span className={i <= step ? 'text-ink' : 'text-faint'}>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    )

  return (
    <div className="rounded-2xl border border-dashed border-accent/40 bg-accent/[0.06] p-6 sm:p-8 text-center flex flex-col items-center gap-3">
      <div className="font-display text-lg font-bold text-ink">{tt("What's your call?")}</div>
      <p className="text-sm text-muted max-w-sm">{model ? tt("Make your own guess first, then see what {0} thinks — the percentages, why this pick, and the full breakdown.", { 0: model }) : tt("Make your own guess first, then see what {0} thinks — the percentages, why this pick, and the full breakdown.", { 0: slModel('football') })}</p>
      <button type="button" onClick={stop(() => setPhase('loading'))} className="mt-1 h-12 px-6 inline-flex items-center gap-2 rounded-2xl bg-accent text-bg font-extrabold hover:brightness-105 active:scale-[0.98] transition">
        <Eye /> {tt("Reveal prediction")}</button>
      <button type="button" onClick={stop(() => setGuessFirst(false))} className="text-xs text-faint hover:text-ink underline underline-offset-4">
        {tt("Always show predictions")}</button>
    </div>
  )
}

/** Small version for match cards and the home page. `dark` = on the always-dark featured hero. */
export function RevealChip({ onReveal, dark = false }: { onReveal: () => void; dark?: boolean }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(onReveal, 750)
    return () => clearTimeout(t)
  }, [busy])
  return (
    <button
      type="button"
      onClick={stop(() => setBusy(true))}
      disabled={busy}
      className={`relative overflow-hidden w-full h-11 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-bold transition-colors ${
        dark ? 'bg-white/10 text-[#C8FF3D] border border-white/15 hover:bg-white/15' : 'bg-accent/10 text-accent border border-accent/30 hover:bg-accent/15'
      }`}
    >
      {busy && <span aria-hidden className="absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-current to-transparent opacity-20 animate-[scan_0.75s_linear_infinite]" />}
      {busy ? <><Spinner size={15} /> {tt("Analysing…")}</> : <><Eye size={16} /> {tt("Reveal prediction")}</>}
    </button>
  )
}

import type { ReactNode } from 'react'
import { t } from '../../../lib/i18n'
import { bandOf, bandWord, BAND_TEXT } from '../../../lib/confidence'
import { DcHelp } from '../../DcPick'
import { Lock } from '../../SportHome/parts'

/**
 * fix281 — "B split bar" (Yarin, 29 Oct), every sport: one bar split home / draw / away (no draw segment in sports
 * without draws), our side's segment(s) in accent, the rest grey; "58% win · Draw 18% · 24% win" under it, then one
 * line "Our pick  <words>  <%>" coloured by band (lib/confidence). The same bar on list rows (small) and at the top of
 * the prediction tab (big). 1 · X · 2 stay left to right on ar / he (fix261: dir="ltr").
 */
export interface BarCell { key: 'H' | 'D' | 'A'; pct: number; on: boolean }
export interface BarPick { words: string; pct: number | null; help?: boolean }

const segLabel = (c: BarCell) => (c.key === 'D' ? t("Draw {0}%", { 0: Math.round(c.pct) }) : t("{0}% win", { 0: Math.round(c.pct) }))

/** labels: the words under each segment (question cards: "Yes 64%"); default "58% win · Draw 18% · 24% win" */
export function SplitBar({ cells, size = 'sm', className = '', labels }: { cells: BarCell[]; size?: 'sm' | 'lg'; className?: string; labels?: string[] }) {
  const total = cells.reduce((s, c) => s + c.pct, 0) || 100
  const lg = size === 'lg'
  return (
    <div data-testid="split-bar" className={`min-w-0 ${className}`}>
      <div className={`flex ${lg ? 'h-3 gap-[3px]' : 'h-2 gap-[2px]'} rounded-full overflow-hidden`} dir="ltr" aria-hidden>
        {cells.map(c => (
          <span key={c.key} data-seg={c.key} data-on={c.on ? '1' : '0'} className={`block h-full ${c.on ? 'bg-accent' : c.key === 'D' ? 'bg-muted/25' : 'bg-muted/40'}`}
            style={{ width: `${(100 * c.pct) / total}%` }} />
        ))}
      </div>
      <div className={`mt-1 flex items-center justify-between gap-2 ${lg ? 'text-xs sm:text-sm' : 'text-[10px]'} leading-none`} dir="ltr">
        {cells.map((c, i) => (
          <span key={c.key} className={`num whitespace-nowrap ${c.on ? 'font-bold text-ink' : 'text-faint'} ${i === 0 ? 'text-start' : i === cells.length - 1 ? 'text-end' : 'text-center'}`}>{labels?.[i] ?? segLabel(c)}</span>
        ))}
      </div>
    </div>
  )
}

/** the bar with the numbers hidden: covered ("guess first") or locked for the plan — grey, no labels */
export function GreyBar({ n, size = 'sm' }: { n: number; size?: 'sm' | 'lg' }) {
  return (
    <div data-testid="split-bar" data-locked="1" className={`flex ${size === 'lg' ? 'h-3 gap-[3px]' : 'h-2 gap-[2px]'} rounded-full overflow-hidden`} dir="ltr" aria-hidden>
      {Array.from({ length: n }, (_, i) => <span key={i} className="block h-full flex-1 bg-surface2" />)}
    </div>
  )
}

/** "Our pick  Barça or draw  76%  Likely" — the % and the word in the band's colour */
export function PickLine({ pick, size = 'sm', extra }: { pick: BarPick; size?: 'sm' | 'lg'; extra?: ReactNode }) {
  const b = pick.pct === null ? null : bandOf(pick.pct)
  const lg = size === 'lg'
  return (
    <div data-testid="pick-line" data-band={b || ''} className={`flex items-center gap-1.5 min-w-0 ${lg ? 'text-sm sm:text-base' : 'text-[11px]'} leading-tight`}>
      <span className="text-faint whitespace-nowrap">{t("Our pick")}</span>
      {pick.help && <DcHelp />}
      <span className={`font-bold text-ink min-w-0 truncate ${lg ? 'font-display text-base sm:text-lg' : ''}`}>{pick.words}</span>
      {pick.pct !== null && b && (
        <>
          <span className={`num font-extrabold whitespace-nowrap ${BAND_TEXT[b]}`}>{Math.round(pick.pct)}%</span>
          <span className={`whitespace-nowrap font-semibold ${lg ? 'text-xs' : 'text-[10px]'} ${BAND_TEXT[b]}`}>{bandWord(b)}</span>
        </>
      )}
      {extra}
    </div>
  )
}

/** the row of a covered pick: grey bar + the Reveal control */
export function RevealLine({ onReveal }: { onReveal: () => void }) {
  return (
    <button type="button" onClick={e => { e.preventDefault(); e.stopPropagation(); onReveal() }}
      className="inline-flex items-center gap-1 text-[11px] leading-none font-bold text-accent hover:underline whitespace-nowrap">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
      {t("Reveal")}
    </button>
  )
}

/** the row of a locked pick: today's lock — the pick in words when it is free to see, else "Locked" */
export function LockedLine({ pick }: { pick?: string | null }) {
  return (
    <span data-testid="pick-locked" className="flex items-center gap-1 text-[11px] leading-none whitespace-nowrap text-faint min-w-0">
      <Lock />
      {pick ? <><span>{t("Our pick")}</span><span className="font-bold text-ink truncate">{pick}</span></> : <span>{t("Locked")}</span>}
    </span>
  )
}

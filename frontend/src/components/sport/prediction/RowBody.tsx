import type { ReactNode } from 'react'
import { SplitBar, GreyBar, PickLine, RevealLine, LockedLine, type BarCell, type BarPick } from './SplitBar'

/**
 * fix281 — the middle of every list row of every sport (shared GameRow, basketball / NFL rows, football league rows):
 * the two names left / right, the split bar under them, its labels, then one "Our pick" line. Covered → grey bar +
 * Reveal; locked → grey bar + today's lock; no prediction → the names alone. Replaces the fix127 1 · X · 2 cells,
 * the "Strong" badge and the side chips.
 */
export interface RowTeam { name: string; short?: string; logo: ReactNode; score?: number | null; bold?: boolean; live?: boolean; dim?: boolean; extra?: ReactNode }
export type RowPred =
  | { kind: 'open'; cells: BarCell[]; pick: BarPick | null; roll?: boolean }
  | { kind: 'covered'; n: number; onReveal: () => void }
  | { kind: 'locked'; n: number; pick?: string | null }
  | { kind: 'none' }

function Name({ s, end }: { s: RowTeam; end?: boolean }) {
  const score = typeof s.score === 'number' ? <span className={`num text-[13px] font-extrabold tabular-nums ${s.live ? 'text-live' : s.dim ? 'text-muted' : 'text-ink'}`}>{s.score}</span> : null
  return (
    <span className={`flex items-center gap-1.5 min-w-0 ${end ? 'justify-end text-end' : ''}`}>
      {!end && s.logo}
      {end && score}
      <span data-testid="team-name" className={`text-[13px] leading-tight line-clamp-2 break-words min-w-0 ${s.bold ? 'font-bold text-ink' : 'text-ink/85'}`}>
        {s.short ? <><span className="sm:hidden">{s.short}</span><span className="hidden sm:inline">{s.name}</span></> : s.name}
        {s.extra}
      </span>
      {!end && score}
      {end && s.logo}
    </span>
  )
}

export default function RowBody({ home, away, pred, top, note }: { home: RowTeam; away: RowTeam; pred: RowPred; top?: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex-1 min-w-0" data-testid="row-body">
      {top}
      {/* two names side by side: a long one wraps to a second line (never cut, fix214) */}
      <div className="grid grid-cols-2 items-center gap-2 min-h-5">
        <Name s={home} />
        <Name s={away} end />
      </div>
      {pred.kind === 'open' ? (
        <div className={`mt-1 space-y-1 ${pred.roll ? 'pop-in' : ''}`}>
          <SplitBar cells={pred.cells} />
          {pred.pick && <PickLine pick={pred.pick} />}
        </div>
      ) : pred.kind === 'covered' ? (
        <div className="mt-1 space-y-1"><GreyBar n={pred.n} /><RevealLine onReveal={pred.onReveal} /></div>
      ) : pred.kind === 'locked' ? (
        <div className="mt-1 space-y-1"><GreyBar n={pred.n} /><LockedLine pick={pred.pick} /></div>
      ) : null}
      {note}
    </div>
  )
}

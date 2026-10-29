import { useState } from 'react'
import { previewText } from '../../../lib/previewWhen'

/**
 * "Game preview" (fix124, like the football match preview of fix121): the same English text search engines get (no
 * pick, no %). Open on wider screens, folded on phones. English pages only for now. fix174: shared by basketball and
 * American football. fix284: every sport (football's "Match preview" too); the day and time in the visitor's own zone
 * (lib/previewWhen.ts); from 1024 px it sits in the game page's side column (GameLayout).
 */
export default function GamePreview({ text, title = 'Game preview' }: { text: string; title?: string }) {
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches)
  return (
    <details open={open} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group card px-4 sm:px-5 py-3" data-game-preview>
      <summary className="flex items-center justify-between gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <h2 className="font-display text-base font-bold text-ink">{title}</h2>
        <svg viewBox="0 0 24 24" className="w-4 h-4 text-muted transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
      </summary>
      <p className="mt-2 text-sm text-muted leading-relaxed">{previewText(text)}</p>
    </details>
  )
}

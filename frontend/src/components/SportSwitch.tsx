import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { SPORTS, sportOfPath } from '../lib/sports'
import { t } from '../lib/i18n'
import { useBbConfig } from '../lib/bb'
import { useNflConfig } from '../lib/nfl'
import { useTennisConfig } from '../lib/tennis'

/** Sport picker next to the logo: Football now, the other sports as "soon". */
export default function SportSwitch() {
  const loc = useLocation()
  const current = sportOfPath(loc.pathname)
  const bb = useBbConfig()
  const nfl = useNflConfig()
  const tennis = useTennisConfig()
  // basketball / American football / tennis are open for admins before launch, for everyone after
  const isLive = (id: string, live: boolean) => live || (id === 'basketball' && !!bb?.open) || (id === 'american-football' && !!nfl?.open) || (id === 'tennis' && !!tennis?.open)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)

  useEffect(() => setOpen(false), [loc.pathname])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('Choose a sport')}
        title={current.name}
        className="h-9 ps-2 pe-1.5 inline-flex items-center gap-1.5 rounded-xl border border-line/80 bg-surface hover:border-faint text-ink"
      >
        <span className="text-sm font-bold leading-none">{current.short ? <><span className="sm:hidden">{current.short}</span><span className="hidden sm:inline">{current.name}</span></> : current.name}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute start-0 top-11 z-50 w-60 rounded-2xl border border-line/80 bg-surface shadow-lift p-1.5">
          {SPORTS.map(s => {
            const active = s.id === current.id
            return (
              <Link
                key={s.id}
                to={s.path}
                role="menuitem"
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm ${active ? 'bg-accent/15 text-ink font-bold' : 'text-ink hover:bg-surface2'}`}
              >
                <span className="text-lg leading-none" aria-hidden>{s.icon}</span>
                <span className="flex-1">{s.name}</span>
                {!isLive(s.id, s.live) && <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-surface2 text-muted">{t('Soon')}</span>}
                {active && isLive(s.id, s.live) && <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

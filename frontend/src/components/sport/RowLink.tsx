import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * fix180: a past / coming match row that opens its match page as a whole (every sport: H2H, form, rest & schedule,
 * team results). Not an <a>, so the team / competition names inside keep their own links (NameLink stops the click);
 * keyboard: Tab to the row, Enter opens it. No `to` = a plain row.
 */
export default function RowLink({ to, className = '', children }: { to: string | null | undefined; className?: string; children: ReactNode }) {
  const nav = useNavigate()
  if (!to) return <div className={className}>{children}</div>
  const open = (e: MouseEvent | KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('a')) return
    if ('metaKey' in e && (e.metaKey || e.ctrlKey)) { window.open(to, '_blank'); return }
    nav(to)
  }
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter') open(e) }}
      className={`${className} cursor-pointer hover:bg-surface2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 transition-colors`}
    >
      {children}
    </div>
  )
}

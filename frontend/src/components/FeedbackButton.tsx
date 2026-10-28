import { useEffect, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { t as tt } from '../lib/i18n'

/* Feedback button for beta testers (and staff): bottom right on every page; lands in the CRM support inbox. */

const KINDS: { k: string; label: string }[] = [
  { k: 'bug', label: 'Something is broken' },
  { k: 'confusing', label: 'Confusing' },
  { k: 'idea', label: 'Idea' },
  { k: 'like', label: 'I like this' }
]

export default function FeedbackButton() {
  const { user, tester, staff } = useAuth()
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('bug')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    if (!open) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [open])

  if (!user || (!tester && !staff)) return null

  const send = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    const w = window.innerWidth
    const device = `${w < 640 ? 'phone' : w < 1024 ? 'tablet' : 'computer'} ${w}px`
    try {
      await axios.post(`${API_URL}/feedback`, { kind, message: msg, page: loc.pathname + loc.search, device })
      setSent(true); setMsg('')
      setTimeout(() => { setOpen(false); setSent(false) }, 1800)
    } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  return (
    <div className="fixed end-3 bottom-[4.6rem] xl:end-4 xl:bottom-5 z-40">
      {open && (
        <form onSubmit={send} className="menu-panel absolute end-0 bottom-12 w-[min(340px,calc(100vw-2rem))] rounded-2xl border border-line p-4 space-y-3 shadow-lift">
          {sent ? (
            <p className="text-sm text-win font-semibold py-6 text-center">{tt("Thank you! We read every message.")}</p>
          ) : (<>
            <div className="flex items-center justify-between">
              <span className="font-display font-bold text-ink">{tt("Feedback")}</span>
              <button type="button" onClick={() => setOpen(false)} className="text-muted hover:text-ink text-lg leading-none" aria-label={tt("Close")}>×</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map(k => (
                <button key={k.k} type="button" onClick={() => setKind(k.k)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold border ${kind === k.k ? 'bg-accent text-bg border-accent' : 'border-line text-muted hover:text-ink'}`}>{tt(k.label)}</button>
              ))}
            </div>
            <textarea value={msg} onChange={e => setMsg(e.target.value)} rows={4} maxLength={3000} required autoFocus
              placeholder={tt("What happened, or what would make it better?")}
              className="w-full rounded-xl border border-line bg-surface2/60 px-3 py-2 text-sm text-ink placeholder:text-faint outline-none focus:border-accent" />
            <p className="text-[11px] text-faint">{tt("We also get the page you're on.")}</p>
            {error && <p className="text-xs text-loss">{error}</p>}
            <button type="submit" disabled={busy || msg.trim().length < 3} className="w-full rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{busy ? tt("Sending…") : tt("Send")}</button>
          </>)}
        </form>
      )}
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="h-9 w-9 xl:w-auto xl:h-10 xl:px-4 rounded-full bg-accent text-bg font-bold text-sm shadow-lift inline-flex items-center justify-center gap-2 opacity-90 xl:opacity-100" aria-label={tt("Feedback")}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
        <span className="hidden xl:inline">{tt("Feedback")}</span>
      </button>
    </div>
  )
}

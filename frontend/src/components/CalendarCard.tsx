import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { t, lang } from '../lib/i18n'

/**
 * fix205: "Calendar" — the private calendar link (Google / Apple / Outlook subscribe to it): the games of your favorite
 * teams and players in every sport, with our pick under the same rules as the site. On the account page and on every
 * sport's Favorites page.
 */
interface Cal { url: string; webcal: string; google: string }

export default function CalendarCard({ className = '' }: { className?: string }) {
  const { user } = useAuth()
  const loc = useLocation()
  const [cal, setCal] = useState<Cal | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let on = true
    axios.get(`${API_URL}/favorites/calendar`, { params: { lang } })
      .then(r => on && setCal(r.data.data))
      .catch(e => on && setErr(errorText(e)))
    return () => { on = false }
  }, [user])

  const copy = async () => {
    if (!cal) return
    try { await navigator.clipboard.writeText(cal.url); setNote(t("Link copied")) } catch { setNote(cal.url) }
  }
  const reset = async () => {
    if (!window.confirm(t("Reset your calendar link? The old link stops working: calendars that use it must be added again."))) return
    setBusy(true)
    setNote(null)
    try {
      const r = await axios.post(`${API_URL}/favorites/calendar/reset`, { lang })
      setCal(r.data.data)
      setNote(t("New link ready. Add it to your calendar again."))
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const btn = 'h-10 px-4 rounded-xl text-sm font-bold grid place-items-center text-center'
  return (
    <div className={`card p-6 space-y-3 ${className}`}>
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        <span className="font-display font-bold text-ink">{t("Calendar")}</span>
      </div>
      <p className="text-sm text-muted">{t("The games of your favorite teams and players, with our pick, in Google, Apple or Outlook calendar.")}</p>
      {!user ? (
        <Link to={`/login?next=${encodeURIComponent(loc.pathname)}`} className={`${btn} bg-accent text-bg w-fit`}>{t("Sign in to get your calendar")}</Link>
      ) : err ? (
        <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{err}</div>
      ) : !cal ? (
        <div className="h-10 rounded-xl bg-surface2/60 animate-pulse" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <a href={cal.google} target="_blank" rel="noopener noreferrer" className={`${btn} bg-accent text-bg`}>{t("Add to Google Calendar")}</a>
            <a href={cal.webcal} className={`${btn} bg-surface2 border border-line text-ink`}>{t("Add to Apple / Outlook")}</a>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copy} className="h-9 px-3 rounded-xl bg-surface2 border border-line text-sm font-semibold text-ink">{t("Copy link")}</button>
            <button type="button" onClick={reset} disabled={busy} className="h-9 px-3 rounded-xl border border-line text-sm font-semibold text-muted hover:text-loss disabled:opacity-60">{t("Reset link")}</button>
          </div>
          {note && <p className="text-sm text-win break-all">{note}</p>}
          <p className="text-xs text-muted">{t("Calendar apps refresh every few hours. Keep the link private: anyone who has it sees these games.")}</p>
        </>
      )}
    </div>
  )
}

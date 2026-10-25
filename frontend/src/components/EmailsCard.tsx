import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t, lang, LANGS } from '../lib/i18n'

/**
 * fix216: "Emails" on the account page — the daily picks email and the weekly digest (both off unless turned on),
 * the sports, the send time in the person's own time zone. The language is the site language they use (saved with
 * every change). Each change is saved at once; the server stores when and where a switch was turned on.
 */
type Sport = 'football' | 'basketball' | 'american-football' | 'tennis'
interface Settings { daily: boolean; weekly: boolean; sports: Sport[]; sendHour: number; tz: string; lang: string; sportsOpen: Sport[]; emailConfirmed: boolean; enabled: boolean; stopped: string | null }

/** The browser's IANA time zone (UTC when it can't tell). */
export function browserTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}
const SPORT_LABEL: Record<Sport, string> = { football: 'Football', basketball: 'Basketball', 'american-football': 'American football', tennis: 'Tennis' }

export default function EmailsCard() {
  const [s, setS] = useState<Settings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let on = true
    axios.get(`${API_URL}/email/settings`).then(r => on && setS(r.data.data)).catch(e => on && setErr(errorText(e)))
    return () => { on = false }
  }, [])

  const zones = useMemo(() => {
    let list: string[] = []
    try { list = (Intl as any).supportedValuesOf?.('timeZone') || [] } catch { list = [] }
    const extra = [s?.tz, browserTz(), 'UTC'].filter((z): z is string => !!z && !list.includes(z))
    return [...extra, ...list]
  }, [s?.tz])

  const save = async (patch: Partial<Pick<Settings, 'daily' | 'weekly' | 'sports' | 'sendHour' | 'tz'>>) => {
    if (!s) return
    const prev = s
    setS({ ...s, ...patch })
    setErr(null)
    setSaved(false)
    try {
      // turning an email on for the first time also keeps this browser's time zone if none was saved yet
      const tz = patch.tz ?? (s.tz === 'UTC' && (patch.daily || patch.weekly) ? browserTz() : undefined)
      const r = await axios.put(`${API_URL}/email/settings`, { ...patch, ...(tz ? { tz } : {}), lang })
      setS(r.data.data)
      setSaved(true)
    } catch (e) {
      setS(prev)
      setErr(errorText(e))
    }
  }

  const toggle = (label: string, note: string, on: boolean, flip: () => void) => (
    <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
      <span>
        <span className="font-semibold text-ink block">{label}</span>
        <span className="text-sm text-muted">{note}</span>
      </span>
      <input type="checkbox" checked={on} onChange={flip} className="mt-1 w-5 h-5 shrink-0 accent-[rgb(var(--accent))]" />
    </label>
  )
  const select = 'rounded-xl border border-line bg-surface2/60 px-3 py-2 text-sm text-ink outline-none focus:border-accent max-w-full'

  return (
    <div id="emails" className="card p-6 space-y-4 scroll-mt-24">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
        <span className="font-display font-bold text-ink">{t("Emails")}</span>
      </div>
      {!s ? (err ? <p className="text-sm text-loss">{err}</p> : <p className="text-sm text-faint">{t("Loading…")}</p>) : (
        <>
          {toggle(t("Daily picks"), t("Each morning: today's strongest picks and your teams' games, with how we did yesterday."), s.daily, () => save({ daily: !s.daily }))}
          {toggle(t("Weekly digest"), t("Every Monday: last week's record, the best call and this week's big games."), s.weekly, () => save({ weekly: !s.weekly }))}

          {(s.daily || s.weekly) && (
            <div className="space-y-3 pt-1">
              <div>
                <div className="label mb-1.5">{t("Sports")}</div>
                <div className="flex flex-wrap gap-2">
                  {s.sportsOpen.map(sp => {
                    const on = s.sports.includes(sp)
                    return (
                      <button key={sp} type="button" aria-pressed={on}
                        onClick={() => { const next = on ? s.sports.filter(x => x !== sp) : [...s.sports, sp]; if (next.some(x => s.sportsOpen.includes(x))) save({ sports: next }) }}
                        className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${on ? 'bg-accent/15 text-accent border-accent/40' : 'bg-surface2 text-muted border-line'}`}>
                        {t(SPORT_LABEL[sp])}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <label className="block">
                  <span className="label block mb-1">{t("Send time")}</span>
                  <select className={select} value={s.sendHour} onChange={e => save({ sendHour: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
                  </select>
                </label>
                <label className="block min-w-0 flex-1">
                  <span className="label block mb-1">{t("Time zone")}</span>
                  <select className={`${select} w-full`} value={s.tz} onChange={e => save({ tz: e.target.value })}>
                    {zones.map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                  </select>
                </label>
              </div>
              <p className="text-xs text-faint">{t("Language: {0} (the language you use on the site).", { 0: LANGS[lang].name })}</p>
            </div>
          )}

          {!s.emailConfirmed && <p className="text-sm text-draw">{t("Confirm your email first: we only send these emails to a confirmed address.")} <Link to="/verify?next=/account" className="font-semibold underline">{t("Enter code →")}</Link></p>}
          {s.stopped && <p className="text-sm text-loss">{t("Emails to this address stopped because they could not be delivered. Change your email or write to support@sportlikely.com.")}</p>}
          {!s.enabled && <p className="text-xs text-faint">{t("Emails are not switched on on this server yet.")}</p>}
          <p className="text-xs text-faint">{t("No spam: you can unsubscribe with one click from any email. Probabilities, not promises. 18+.")}</p>
          {err && <p className="text-sm text-loss">{err}</p>}
          {saved && <p className="text-xs text-win">{t("Saved")}</p>}
        </>
      )}
    </div>
  )
}

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t, lang } from '../lib/i18n'
import { browserTz } from './EmailsCard'
import { pushSupported, isIos, isStandalone, permission, currentSubscription, subscribe, deviceId, showTest } from '../lib/push'

/**
 * fix226: "Alerts" on the account page — push alerts for your favourite teams and players (and, if chosen, the games
 * you picked): game starting, score, final score, upset watch (Pro). Off unless turned on; the browser asks for its
 * permission when you turn them on. Quiet hours in your own time zone (default 00:00–07:00: nothing is sent, final
 * scores arrive in the morning). iPhone: only once the site is added to the Home Screen.
 */
interface Settings {
  on: boolean; starting: boolean; score: boolean; final: boolean; upset: boolean; myPicks: boolean
  quietFrom: number; quietTo: number; tz: string; lang: string
  devices: { id: string; device: string; since: string }[]; pro: boolean; enabled: boolean; publicKey: string | null
}
type Patch = Partial<Pick<Settings, 'on' | 'starting' | 'score' | 'final' | 'upset' | 'myPicks' | 'quietFrom' | 'quietTo' | 'tz'>>

export default function AlertsCard() {
  const [s, setS] = useState<Settings | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [here, setHere] = useState<string | null>(null) // this browser's device id, when it has a subscription
  const [perm, setPerm] = useState(permission())
  const ios = isIos(), homeScreen = isStandalone(), supported = pushSupported()

  useEffect(() => {
    let on = true
    axios.get(`${API_URL}/push/settings`).then(r => on && setS(r.data.data)).catch(e => on && setErr(errorText(e)))
    currentSubscription().then(async sub => { if (on && sub) setHere(await deviceId(sub.endpoint)) }).catch(() => undefined)
    return () => { on = false }
  }, [])

  const zones = useMemo(() => {
    let list: string[] = []
    try { list = (Intl as any).supportedValuesOf?.('timeZone') || [] } catch { list = [] }
    const extra = [s?.tz, browserTz(), 'UTC'].filter((z): z is string => !!z && !list.includes(z))
    return [...extra, ...list]
  }, [s?.tz])

  const thisDevice = !!s && !!here && s.devices.some(d => d.id === here)

  const save = async (patch: Patch) => {
    if (!s) return
    const prev = s
    setS({ ...s, ...patch })
    setErr(null); setSaved(false)
    try {
      const r = await axios.put(`${API_URL}/push/settings`, { ...patch, lang })
      setS(r.data.data); setSaved(true)
    } catch (e) { setS(prev); setErr(errorText(e)) }
  }

  /** the permission prompt + this browser's subscription; `andOn` also turns the alerts on */
  const addThisDevice = async (andOn: boolean) => {
    if (!s?.publicKey) return
    setBusy(true); setErr(null); setSaved(false)
    try {
      const sub = await subscribe(s.publicKey)
      setPerm(permission())
      const r = await axios.post(`${API_URL}/push/subscribe`, { subscription: sub.toJSON(), ...(andOn ? { on: true, tz: s.tz === 'UTC' ? browserTz() : s.tz, lang } : {}) })
      setS(r.data.data)
      setHere(await deviceId(sub.endpoint))
      setSaved(true)
    } catch (e: any) {
      setPerm(permission())
      setErr(e?.message === 'denied' ? t("Alerts are blocked in this browser. Allow notifications for sportlikely.com in the browser settings, then try again.") : errorText(e))
    } finally { setBusy(false) }
  }

  const removeThisDevice = async () => {
    setBusy(true); setErr(null)
    try {
      const sub = await currentSubscription()
      if (sub) {
        const r = await axios.post(`${API_URL}/push/unsubscribe`, { endpoint: sub.endpoint })
        await sub.unsubscribe().catch(() => undefined)
        setS(r.data.data)
      }
      setHere(null)
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }

  const toggle = (label: string, note: string, on: boolean, flip: () => void, disabled = false, extra?: ReactNode) => (
    <label className={`flex items-start justify-between gap-4 select-none ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <span>
        <span className="font-semibold text-ink block">{label}{extra}</span>
        <span className="text-sm text-muted">{note}</span>
      </span>
      <input type="checkbox" checked={on} disabled={disabled} onChange={flip} className="mt-1 w-5 h-5 shrink-0 accent-[rgb(var(--accent))]" />
    </label>
  )
  const select = 'rounded-xl border border-line bg-surface2/60 px-3 py-2 text-sm text-ink outline-none focus:border-accent max-w-full'
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`
  // iPhone outside the Home Screen app: no Web Push at all (one line on how to get it)
  const needsHomeScreen = ios && !homeScreen
  const canAsk = supported && !needsHomeScreen && !!s?.enabled && perm !== 'denied'

  return (
    <div id="alerts" className="card p-6 space-y-4 scroll-mt-24">
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" className="w-5 h-5 text-accent" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        <span className="font-display font-bold text-ink">{t("Alerts")}</span>
      </div>
      {!s ? (err ? <p className="text-sm text-loss">{err}</p> : <p className="text-sm text-faint">{t("Loading…")}</p>) : (
        <>
          <p className="text-sm text-muted">{t("Alerts on your phone or computer for your favourite teams and players: kick-off, scores and the final result with our pick.")} <Link to="/favorites" className="font-semibold text-accent">{t("Your favourites →")}</Link></p>
          {needsHomeScreen && <p className="text-sm text-draw">{t("On iPhone, alerts work only from the Home Screen: tap Share, then \"Add to Home Screen\", and open SportLikely from there.")}</p>}
          {!supported && !needsHomeScreen && <p className="text-sm text-faint">{t("This browser can't show alerts. Try Chrome, Edge, Firefox or Safari.")}</p>}
          {!s.enabled && <p className="text-xs text-faint">{t("Alerts are not switched on on this server yet.")}</p>}

          {toggle(t("Alerts"), t("Off unless you turn them on. Your browser asks for permission first."), s.on,
            () => (s.on ? save({ on: false }) : thisDevice ? save({ on: true }) : addThisDevice(true)), busy || (!s.on && !canAsk))}

          {s.on && (
            <div className="space-y-3 pt-1">
              {canAsk && !thisDevice && (
                <button type="button" disabled={busy} onClick={() => addThisDevice(false)} className="rounded-xl bg-accent text-bg px-4 py-2 text-sm font-semibold disabled:opacity-60">
                  {t("Turn on for this device too")}
                </button>
              )}
              {toggle(t("Game starting"), t("15 minutes before, with our pick when you can see it."), s.starting, () => save({ starting: !s.starting }))}
              {toggle(t("Score"), t("Football goals; basketball and American football quarter ends and lead changes in the last 3 minutes; tennis sets."), s.score, () => save({ score: !s.score }))}
              {toggle(t("Final score"), t("The result, and whether our pick was right."), s.final, () => save({ final: !s.final }))}
              {toggle(t("Upset watch"), t("When the side we gave 20–45% is ahead late in the game."), s.pro && s.upset, () => save({ upset: !s.upset }), !s.pro,
                !s.pro ? <Link to="/premium" className="ml-2 text-xs font-bold text-accent">Pro</Link> : null)}
              {toggle(t("Games I picked"), t("Also alerts for the games you made a pick on."), s.myPicks, () => save({ myPicks: !s.myPicks }))}

              <div className="flex flex-wrap gap-3">
                <label className="block">
                  <span className="label block mb-1">{t("Quiet from")}</span>
                  <select className={select} value={s.quietFrom} onChange={e => save({ quietFrom: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hour(h)}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="label block mb-1">{t("Quiet until")}</span>
                  <select className={select} value={s.quietTo} onChange={e => save({ quietTo: Number(e.target.value) })}>
                    {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hour(h)}</option>)}
                  </select>
                </label>
                <label className="block min-w-0 flex-1">
                  <span className="label block mb-1">{t("Time zone")}</span>
                  <select className={`${select} w-full`} value={s.tz} onChange={e => save({ tz: e.target.value })}>
                    {zones.map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                  </select>
                </label>
              </div>
              <p className="text-xs text-faint">
                {s.quietFrom === s.quietTo ? t("No quiet hours.") : t("Nothing is sent from {0} to {1}; final scores from that time arrive in the morning.", { 0: hour(s.quietFrom), 1: hour(s.quietTo) })}
                {' '}{t("At most one alert a minute.")}
              </p>

              {s.devices.length > 0 && (
                <div className="text-sm">
                  <div className="label mb-1">{t("Devices")}</div>
                  <ul className="space-y-1">
                    {s.devices.map(d => (
                      <li key={d.id} className="flex flex-wrap items-center gap-2 text-muted">
                        <span className="text-ink">{d.device}</span>
                        {d.id === here && <span className="text-xs font-semibold text-accent">{t("this device")}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {thisDevice && (
                <div className="flex flex-wrap gap-3">
                  <button type="button" onClick={() => showTest(t("Test alert"), t("Alerts are working on this device.")).catch(e => setErr(errorText(e)))} className="rounded-xl bg-surface2 border border-line px-4 py-2 text-sm font-semibold text-ink">
                    {t("Show a test alert")}
                  </button>
                  <button type="button" disabled={busy} onClick={removeThisDevice} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-muted disabled:opacity-60">
                    {t("Turn off on this device")}
                  </button>
                </div>
              )}
            </div>
          )}

          {perm === 'denied' && <p className="text-sm text-loss">{t("Alerts are blocked in this browser. Allow notifications for sportlikely.com in the browser settings, then try again.")}</p>}
          <p className="text-xs text-faint">{t("Times are in your time zone. Probabilities, not promises. 18+.")}</p>
          {err && perm !== 'denied' && <p className="text-sm text-loss">{err}</p>}
          {saved && <p className="text-xs text-win">{t("Saved")}</p>}
        </>
      )}
    </div>
  )
}

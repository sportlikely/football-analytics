import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/**
 * fix226 (admin): push alerts — sent / failed / quiet / merged / expired per day and per type, device results (ok,
 * failed, gone), opt-ins, the live tick, recent failures and "Send me a test" (to the admin's own devices). English only.
 */
interface Day {
  day: string; sent: number; failed: number; quiet: number; merged: number; expired: number; dropped: number; queued: number
  devicesOk: number; devicesFailed: number; devicesGone: number; byKind: Record<string, number>
}
interface Stats {
  enabled: boolean; devices: number
  optedIn: { people: number; starting: number; score: number; final: number; upset: number; myPicks: number }
  tick: { ticks: number; lastAt: string | null; lastMs: number; games: number; events: number; sent: number; failed: number; lastError: string | null; bySport: Record<string, number> }
  perDay: Day[]
  failures: { userId: number; kind: string; at: string; status: string; reason: string | null; failed: number }[]
  recentEvents: { sport: string; gameId: number; kind: string; key: string; at: string }[]
}
const COLS: (keyof Day)[] = ['sent', 'failed', 'quiet', 'merged', 'expired', 'dropped', 'devicesOk', 'devicesFailed', 'devicesGone']
const KINDS = ['start', 'score', 'final', 'upset']
const when = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export default function PushAdminCard() {
  const [d, setD] = useState<Stats | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { axios.get(`${API_URL}/admin/push`).then(r => setD(r.data.data)).catch(e => setNote(errorText(e))) }, [])

  const test = async () => {
    setBusy(true); setNote(null)
    try {
      const r = (await axios.post(`${API_URL}/admin/push/test`)).data.data
      setNote(r.ok ? `Test alert sent to ${r.ok} device(s)${r.fail ? `, ${r.fail} failed` : ''}${r.gone ? `, ${r.gone} gone (removed)` : ''}.` : 'No device of yours has alerts on: turn them on in Account → Alerts first.')
    } catch (e) { setNote(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Push alerts</h2>
        {d && <span className="text-xs text-faint">
          {d.enabled ? 'VAPID keys on' : <span className="text-loss">not configured (set VAPID_PUBLIC / VAPID_PRIVATE)</span>} ·
          {' '}{d.optedIn.people} people on ({d.optedIn.starting} starting, {d.optedIn.score} score, {d.optedIn.final} final, {d.optedIn.upset} upset, {d.optedIn.myPicks} own picks) · {d.devices} device(s)
          {d.tick.lastAt && <> · last tick {when(d.tick.lastAt)} ({d.tick.lastMs} ms, {d.tick.games} games: {Object.entries(d.tick.bySport).map(([s, n]) => `${s} ${n}`).join(', ')})</>}
        </span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button type="button" disabled={busy} onClick={test} className="px-3 py-1.5 rounded-lg bg-accent text-bg text-sm font-semibold disabled:opacity-50">{busy ? 'Sending…' : 'Send me a test'}</button>
        {d?.tick.lastError && <span className="text-xs text-loss">last error: {d.tick.lastError}</span>}
      </div>
      {note && <p className="text-sm text-muted mb-3">{note}</p>}
      {d && (d.perDay.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-xs text-faint text-left">
              <th className="py-1 pr-3">Day (UTC)</th>{COLS.map(c => <th key={c} className="py-1 px-2 text-right">{c}</th>)}{KINDS.map(k => <th key={k} className="py-1 px-2 text-right">sent {k}</th>)}
            </tr></thead>
            <tbody>{d.perDay.map(r => (
              <tr key={r.day} className="border-t border-line/50">
                <td className="py-1 pr-3 text-ink">{r.day}</td>
                {COLS.map(c => <td key={c} className={`py-1 px-2 text-right ${(c === 'failed' || c === 'devicesFailed') && r[c] ? 'text-loss' : 'text-ink'}`}>{String(r[c] ?? 0)}</td>)}
                {KINDS.map(k => <td key={k} className="py-1 px-2 text-right text-ink">{r.byKind[k] || 0}</td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="text-sm text-faint">No alerts yet.</p>)}
      {d && d.failures.length > 0 && (
        <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted">Recent failures</summary>
          <ul className="mt-2 space-y-1">{d.failures.map((r, i) => (
            <li key={i} className="text-xs text-faint">user {r.userId} · {r.kind} · {when(r.at)} · <span className="text-loss">{r.status}</span> · {r.failed} device(s) failed{r.reason ? ` · ${r.reason}` : ''}</li>
          ))}</ul>
        </details>
      )}
      {d && d.recentEvents.length > 0 && (
        <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted">Recent events</summary>
          <ul className="mt-2 space-y-1">{d.recentEvents.map((e, i) => (
            <li key={i} className="text-xs text-faint">{when(e.at)} · {e.sport} {e.gameId} · {e.key}</li>
          ))}</ul>
        </details>
      )}
    </section>
  )
}

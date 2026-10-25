import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/**
 * fix216 (admin): the picks emails — sent / skipped / failed and the webhook counts (delivered, opened, clicked,
 * bounced, complaints, unsubscribed) per day, "send me a test" (to the admin's own address) and a preview of today's
 * email for any user id. English only, like the rest of the admin pages.
 */
interface Day { day: string; sent: number; skipped: number; failed: number; delivered: number; opened: number; clicked: number; bounced: number; complained: number; unsubscribed: number }
interface Stats {
  enabled: boolean; webhook: boolean; optedIn: { daily: number; weekly: number }; suppressed: number
  lastRun: { at: string | null; sent: number; skipped: number; failed: number }; perDay: Day[]
  recent: { userId: number; kind: string; day: string; at: string; status: string; reason: string | null }[]
}
const COLS: (keyof Day)[] = ['sent', 'skipped', 'failed', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'unsubscribed']

export default function EmailsAdminCard() {
  const [d, setD] = useState<Stats | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uid, setUid] = useState('')
  const [kind, setKind] = useState<'daily' | 'weekly'>('daily')
  useEffect(() => { axios.get(`${API_URL}/admin/emails`).then(r => setD(r.data.data)).catch(e => setNote(errorText(e))) }, [])

  const test = async () => {
    setBusy(true); setNote(null)
    try {
      const r = await axios.post(`${API_URL}/admin/emails/test`, { kind })
      setNote(r.data.data.sent ? `Test ${kind} email sent to ${r.data.data.to}.` : `Not sent: ${r.data.data.reason}`)
    } catch (e) { setNote(errorText(e)) } finally { setBusy(false) }
  }
  const preview = () => window.open(`${API_URL}/admin/emails/preview?kind=${kind}${uid.trim() ? `&user=${encodeURIComponent(uid.trim())}` : ''}`, '_blank', 'noopener')

  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Picks emails</h2>
        {d && <span className="text-xs text-faint">
          {d.enabled ? 'Resend on' : <span className="text-loss">email not configured</span>} · webhook {d.webhook ? 'on' : <span className="text-draw">off (set RESEND_WEBHOOK_SECRET)</span>} ·
          opted in: {d.optedIn.daily} daily, {d.optedIn.weekly} weekly · {d.suppressed} stopped address(es)
          {d.lastRun.at && <> · last run {new Date(d.lastRun.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: {d.lastRun.sent} sent, {d.lastRun.skipped} skipped, {d.lastRun.failed} failed</>}
        </span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={kind} onChange={e => setKind(e.target.value as 'daily' | 'weekly')} className="rounded-lg border border-line bg-surface2 px-2 py-1.5 text-sm text-ink">
          <option value="daily">Daily picks</option><option value="weekly">Weekly digest</option>
        </select>
        <button type="button" disabled={busy} onClick={test} className="px-3 py-1.5 rounded-lg bg-accent text-bg text-sm font-semibold disabled:opacity-50">{busy ? 'Sending…' : 'Send me a test'}</button>
        <input value={uid} onChange={e => setUid(e.target.value.replace(/\D/g, ''))} placeholder="user id (empty = me)" inputMode="numeric" className="w-40 rounded-lg border border-line bg-surface2 px-2 py-1.5 text-sm text-ink" />
        <button type="button" onClick={preview} className="px-3 py-1.5 rounded-lg border border-line bg-surface2 text-sm font-semibold text-ink">Preview today's email</button>
      </div>
      {note && <p className="text-sm text-muted mb-3">{note}</p>}
      {d && (d.perDay.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead><tr className="text-xs text-faint text-left"><th className="py-1 pr-3">Day (UTC)</th>{COLS.map(c => <th key={c} className="py-1 px-2 text-right">{c}</th>)}</tr></thead>
            <tbody>{d.perDay.map(r => (
              <tr key={r.day} className="border-t border-line/50"><td className="py-1 pr-3 text-ink">{r.day}</td>{COLS.map(c => <td key={c} className={`py-1 px-2 text-right ${(c === 'failed' || c === 'bounced' || c === 'complained') && r[c] ? 'text-loss' : 'text-ink'}`}>{r[c]}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="text-sm text-faint">No picks emails yet.</p>)}
      {d && d.recent.some(r => r.status !== 'sent') && (
        <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted">Recent skips and failures</summary>
          <ul className="mt-2 space-y-1">{d.recent.filter(r => r.status !== 'sent').slice(0, 20).map(r => (
            <li key={`${r.userId}${r.kind}${r.day}`} className="text-xs text-faint">user {r.userId} · {r.kind} · {r.day} · <span className={r.status === 'failed' ? 'text-loss' : ''}>{r.status}</span> · {r.reason}</li>
          ))}</ul>
        </details>
      )}
    </section>
  )
}

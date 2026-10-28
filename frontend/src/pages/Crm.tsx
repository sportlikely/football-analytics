import { Fragment, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { useConsole } from '../components/ConsoleGate'
import CopyForClaude from '../components/admin/CopyForClaude'

/*
 * CRM (staff only, English): support inbox (admin + support staff), email campaigns and revenue (admin only).
 * Replies go out by email from support@; customers' answers arrive in the support@ Gmail inbox.
 */

type Tab = 'inbox' | 'customers' | 'testers' | 'campaigns' | 'revenue' | 'security' | 'activity' | 'team'
const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const TOPIC: Record<string, string> = {
  feedback: 'Tester feedback', question: 'Question', account: 'Account', billing: 'Billing', privacy: 'Privacy', bug: 'Bug', idea: 'Idea', business: 'Business', other: 'Other'
}
const STATUS_TONE: Record<string, string> = { open: 'bg-accent/15 text-accent', waiting: 'bg-draw/15 text-draw', closed: 'bg-surface2 text-muted' }
const input =
  'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'
const Err = ({ e }: { e: string | null }) => (e ? <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{e}</div> : null)

export default function Crm() {
  const { staff, user, loading, can } = useAuth()
  const con = useConsole()
  const [params, setParams] = useSearchParams()
  useEffect(() => { document.title = 'CRM · SportLikely' }, [])

  if (loading) return null
  if (!staff)
    return (
      <div className="max-w-md mx-auto px-4 py-16 text-center space-y-3">
        <h1 className="font-display text-2xl font-extrabold text-ink">CRM</h1>
        <p className="text-sm text-muted">
          {user?.role
            ? user.twoFactor
              ? 'Sign out and sign in again with your two-step code to open the CRM.'
              : 'Staff need two-step login. Turn it on in your account settings, then come back.'
            : 'Staff only.'}
        </p>
        {user?.role && !user.twoFactor && <Link to="/account" className="inline-block rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">Go to settings</Link>}
      </div>
    )

  const all: { k: Tab; label: string; ok: boolean }[] = [
    { k: 'inbox', label: 'Support inbox', ok: can('inbox.read') },
    { k: 'customers', label: 'Customers', ok: can('customers.view') },
    { k: 'testers', label: 'Testers', ok: can('customers.view') },
    { k: 'campaigns', label: 'Campaigns', ok: can('campaigns') },
    { k: 'revenue', label: 'Revenue & churn', ok: can('revenue') },
    { k: 'security', label: 'Security log', ok: can('security') },
    { k: 'activity', label: 'Staff activity', ok: can('activity') },
    { k: 'team', label: 'Team & roles', ok: can('team') }
  ]
  const tabs = all.filter(t => t.ok)
  const want = params.get('tab') as Tab | null
  const tab: Tab | null = tabs.find(t => t.k === want)?.k || tabs[0]?.k || null
  const roleName = staff === 'admin' ? 'Admin' : staff.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">CRM</h1>
          <p className="text-sm text-muted mt-1">{roleName} · {user?.email}</p>
          {con.username && (
            <p className="text-[11px] text-faint mt-1">
              Console: <b className="text-muted">{con.username}</b> ·{' '}
              {staff === 'admin' && <><button type="button" onClick={con.changePassword} className="underline hover:text-ink">Change console password</button> ·{' '}</>}
              <button type="button" onClick={con.lock} className="underline hover:text-ink">Lock</button>
            </p>
          )}
        </div>
        <div className="seg flex-wrap">
          {tabs.map(t => (
            <button key={t.k} type="button" onClick={() => setParams({ tab: t.k }, { replace: true })} className={`seg-btn ${tab === t.k ? 'seg-btn-active' : ''}`}>{t.label}</button>
          ))}
        </div>
      </div>
      {!tab && <div className="card p-6 text-sm text-muted">Your role has no CRM permissions yet. Ask the admin.</div>}
      {tab === 'inbox' && <Inbox />}
      {tab === 'customers' && <Customers />}
      {tab === 'testers' && <Testers canInvite={can('customers.plan')} />}
      {tab === 'campaigns' && <Campaigns />}
      {tab === 'revenue' && <Revenue />}
      {tab === 'security' && <SecurityLog />}
      {tab === 'activity' && <Activity />}
      {tab === 'team' && <Team />}
    </div>
  )
}

/* ================================================================== */
/* Inbox                                                              */
/* ================================================================== */

interface ThreadRow { id: number; at: string; updatedAt: string | null; userId: number | null; name: string | null; email: string; topic: string; preview: string; status: string; replies: number; plan: string | null; assignedTo: number | null; assignedName: string | null }
interface StaffRef { id: number; name: string }
interface Thread {
  message: { id: number; at: string; name: string | null; email: string; topic: string; message: string; page: string | null; status: string; sent: boolean; userId: number | null; assignedTo: number | null }
  replies: { id: number; at: string; byName: string; kind: 'reply' | 'note'; body: string; sent: boolean }[]
  account: { id: number; plan: string; premiumUntil: string | null; createdAt: string; lastLoginAt: string | null; cancelAt: string | null } | null
  others: { id: number; at: string; topic: string; status: string }[]
}

function Inbox() {
  const [status, setStatus] = useState<'open' | 'waiting' | 'closed' | ''>('open')
  const [list, setList] = useState<{ counts: Record<string, number>; rows: ThreadRow[]; staff: StaffRef[] } | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/crm/inbox`, { params: { status: status || undefined } }).then(r => { setList(r.data.data); setError(null) }).catch(e => setError(errorText(e)))
  useEffect(() => { load() }, [status])

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_1fr] items-start">
      <section className="card overflow-hidden">
        <div className="flex gap-1 p-2 border-b border-line/60">
          {(['open', 'waiting', 'closed', ''] as const).map(s => (
            <button key={s || 'all'} type="button" onClick={() => setStatus(s)} className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold ${status === s ? 'bg-surface2 text-ink' : 'text-muted hover:text-ink'}`}>
              {s ? `${s[0].toUpperCase()}${s.slice(1)}` : 'All'}{s && list ? ` · ${list.counts[s] ?? 0}` : ''}
            </button>
          ))}
        </div>
        <Err e={error} />
        {!list ? <div className="p-6 text-sm text-faint">Loading…</div> : list.rows.length === 0 ? (
          <div className="p-6 text-sm text-faint">{status === 'open' ? 'Nothing open. All answered.' : 'No messages here.'}</div>
        ) : (
          <ul className="divide-y divide-line/50 max-h-[70vh] overflow-y-auto">
            {list.rows.map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpenId(r.id)} className={`w-full text-left px-4 py-3 hover:bg-surface2/50 ${openId === r.id ? 'bg-surface2/70' : ''}`}>
                  <div className="flex items-center gap-2 text-[11px] text-faint">
                    <span className={`px-1.5 py-0.5 rounded font-bold uppercase tracking-wide text-[9px] ${STATUS_TONE[r.status] || ''}`}>{r.status}</span>
                    <span>#{r.id}</span><span>{TOPIC[r.topic] || r.topic}</span>
                    {r.plan && r.plan !== 'free' && <span className="text-accent font-semibold">{r.plan}</span>}
                    <span className="ml-auto">{fmt(r.updatedAt || r.at)}</span>
                  </div>
                  <div className="text-sm font-semibold text-ink truncate mt-0.5">{r.name || r.email}</div>
                  <div className="text-xs text-muted line-clamp-2">{r.preview}</div>
                  <div className="flex gap-3 text-[11px] text-faint mt-0.5">
                    {r.replies > 0 && <span>{r.replies} {r.replies === 1 ? 'reply' : 'replies'} sent</span>}
                    <span className={r.assignedTo ? 'text-ink/80' : ''}>{r.assignedName ? `→ ${r.assignedName}` : 'Unassigned'}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {openId ? <ThreadView id={openId} onChange={load} staff={list?.staff || []} /> : <section className="card p-8 text-sm text-faint hidden lg:block">Pick a message on the left.</section>}
    </div>
  )
}

function ThreadView({ id, onChange, staff }: { id: number; onChange: () => void; staff: StaffRef[] }) {
  const { user, can } = useAuth()
  const [t, setT] = useState<Thread | null>(null)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/crm/inbox/${id}`).then(r => { setT(r.data.data); setError(null) }).catch(e => setError(errorText(e)))
  useEffect(() => { setT(null); setText(''); load() }, [id])
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn(); await load(); onChange() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const send = (close: boolean) => (e?: FormEvent) => {
    e?.preventDefault()
    act(async () => {
      if (mode === 'note') await axios.post(`${API_URL}/crm/inbox/${id}/note`, { body: text })
      else await axios.post(`${API_URL}/crm/inbox/${id}/reply`, { body: text, close })
      setText('')
    })
  }
  const setStatus = (s: string) => act(() => axios.post(`${API_URL}/crm/inbox/${id}/status`, { status: s }))
  const assignTo = (to: number | null) => act(() => axios.post(`${API_URL}/crm/inbox/${id}/assign`, { to }))
  const canReply = can('inbox.reply'), manage = can('inbox.manage')
  if (!t) return <section className="card p-6 text-sm text-faint">{error || 'Loading…'}</section>
  const m = t.message

  return (
    <section className="card p-5 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] text-faint">#{m.id} · {TOPIC[m.topic] || m.topic} · {fmt(m.at)}{m.page ? ` · from ${m.page}` : ''}</div>
          <h2 className="font-display text-xl font-bold text-ink truncate">{m.name || m.email}</h2>
          <a href={`mailto:${m.email}`} className="text-sm text-accent">{m.email}</a>
          {/* fix259: the thread for Claude (customer id, no email) */}
          <div className="mt-2"><CopyForClaude api="crm" size="sm" req={() => ({ place: `CRM → Support inbox → message #${m.id}`, scope: 'crm-message', id: m.id })} /></div>
        </div>
        <div className="flex flex-col items-end gap-2">
        <div className="flex gap-1">
          {['open', 'waiting', 'closed'].map(s => (
            <button key={s} type="button" disabled={busy || m.status === s || !canReply} onClick={() => setStatus(s)} className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${m.status === s ? STATUS_TONE[s] : 'text-muted hover:text-ink border border-line'}`}>{s}</button>
          ))}
        </div>
        {manage ? (
          <select value={m.assignedTo ?? ''} disabled={busy} onChange={e => assignTo(e.target.value ? Number(e.target.value) : null)} className="rounded-lg border border-line bg-surface2/60 px-2 py-1 text-xs text-ink">
            <option value="">Unassigned</option>
            {staff.map(p => <option key={p.id} value={p.id}>{p.id === user?.id ? `${p.name} (me)` : p.name}</option>)}
          </select>
        ) : m.assignedTo === user?.id ? (
          <span className="text-xs text-muted">Assigned to you</span>
        ) : canReply && !m.assignedTo ? (
          <button type="button" disabled={busy} onClick={() => assignTo(user!.id)} className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink">Take it</button>
        ) : null}
        </div>
      </div>

      {t.account && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-xl bg-surface2/50 border border-line/60 px-3 py-2 text-xs text-muted">
          <span>Account #{t.account.id}</span>
          <span>Plan <b className="text-ink">{t.account.plan}</b>{t.account.premiumUntil ? ` until ${fmtDay(t.account.premiumUntil)}` : ''}</span>
          <span>Joined {fmtDay(t.account.createdAt)}</span>
          <span>Last sign-in {fmtDay(t.account.lastLoginAt)}</span>
          {t.account.cancelAt && <span className="text-loss">Cancelled {fmtDay(t.account.cancelAt)}</span>}
        </div>
      )}

      <div className="space-y-3">
        <div className="rounded-2xl border border-line bg-surface2/40 p-4">
          <div className="text-[11px] text-faint mb-1">{m.name || 'Customer'} wrote</div>
          <p className="text-sm text-ink whitespace-pre-wrap break-words">{m.message}</p>
        </div>
        {t.replies.map(r => (
          <div key={r.id} className={`rounded-2xl p-4 ${r.kind === 'note' ? 'border border-dashed border-draw/50 bg-draw/5' : 'border border-accent/30 bg-accent/5 ml-4 sm:ml-10'}`}>
            <div className="text-[11px] text-faint mb-1">
              {r.kind === 'note' ? 'Internal note' : 'Reply'} · {r.byName} · {fmt(r.at)}{r.kind === 'reply' && !r.sent ? ' · not delivered' : ''}
            </div>
            <p className="text-sm text-ink whitespace-pre-wrap break-words">{r.body}</p>
          </div>
        ))}
        {t.replies.some(r => r.kind === 'reply') && (
          <p className="text-[11px] text-faint">The customer's answer arrives in the support@ inbox (Gmail), with [#{m.id}] in the subject.</p>
        )}
      </div>

      {canReply && <form onSubmit={send(false)} className="space-y-2">
        <div className="flex gap-1">
          <button type="button" onClick={() => setMode('reply')} className={`rounded-lg px-3 py-1 text-xs font-semibold ${mode === 'reply' ? 'bg-accent text-bg' : 'text-muted border border-line'}`}>Reply by email</button>
          <button type="button" onClick={() => setMode('note')} className={`rounded-lg px-3 py-1 text-xs font-semibold ${mode === 'note' ? 'bg-draw text-bg' : 'text-muted border border-line'}`}>Internal note</button>
        </div>
        <textarea className={`${input} min-h-[140px] resize-y`} value={text} onChange={e => setText(e.target.value)} placeholder={mode === 'reply' ? `Hi ${m.name || ''}…` : 'Only staff see this'} maxLength={10000} />
        <Err e={error} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy || text.trim().length < 2} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">
            {busy ? 'Sending…' : mode === 'reply' ? 'Send reply' : 'Save note'}
          </button>
          {mode === 'reply' && (
            <button type="button" onClick={() => send(true)()} disabled={busy || text.trim().length < 2} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60">Send and close</button>
          )}
        </div>
        {mode === 'reply' && <p className="text-[11px] text-faint">Sent from support@sportlikely.com with your message quoted below it.</p>}
      </form>}

      {t.others.length > 0 && (
        <div className="text-xs text-muted">
          Other messages from this email: {t.others.map(o => <span key={o.id} className="mr-2">#{o.id} ({TOPIC[o.topic] || o.topic}, {o.status})</span>)}
        </div>
      )}
    </section>
  )
}

/* ================================================================== */
/* Campaigns                                                          */
/* ================================================================== */

interface Seg { plans: string[]; joinedWithinDays: string; activeWithinDays: string; inactiveForDays: string; includeStaff: boolean }
interface Camp { id: number; createdAt: string; subject: string; total: number; sent: number; failed: number; status: string; finishedAt: string | null }

function Campaigns() {
  const [seg, setSeg] = useState<Seg>({ plans: [], joinedWithinDays: '', activeWithinDays: '', inactiveForDays: '', includeStaff: false })
  const [preview, setPreview] = useState<{ count: number; optedIn: number; sample: { email: string; plan: string }[] } | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [list, setList] = useState<Camp[]>([])
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const segment = useMemo(() => ({
    plans: seg.plans, includeStaff: seg.includeStaff,
    joinedWithinDays: seg.joinedWithinDays || null, activeWithinDays: seg.activeWithinDays || null, inactiveForDays: seg.inactiveForDays || null
  }), [seg])
  const loadList = () => axios.get(`${API_URL}/crm/campaigns`).then(r => setList(r.data.data)).catch(() => undefined)
  useEffect(() => { loadList() }, [])
  useEffect(() => {
    const t = setTimeout(() => { axios.post(`${API_URL}/crm/segment`, { segment }).then(r => setPreview(r.data.data)).catch(e => setError(errorText(e))) }, 300)
    return () => clearTimeout(t)
  }, [segment])
  useEffect(() => {
    if (!list.some(c => c.status === 'sending')) return
    const t = setInterval(loadList, 3000)
    return () => clearInterval(t)
  }, [list])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setInfo(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const test = () => run(async () => {
    const r = await axios.post(`${API_URL}/crm/campaigns/test`, { subject, body })
    setInfo(`Test sent to ${r.data.data.sentTo}.`)
  })
  const send = () => {
    if (!preview?.count) return
    if (!window.confirm(`Send "${subject}" to ${preview.count} ${preview.count === 1 ? 'person' : 'people'} now? This cannot be undone.`)) return
    run(async () => {
      const r = await axios.post(`${API_URL}/crm/campaigns`, { subject, body, segment, confirm: true })
      setInfo(`Sending to ${r.data.data.total}…`); setSubject(''); setBody(''); await loadList()
    })
  }
  const togglePlan = (p: string) => setSeg(s => ({ ...s, plans: s.plans.includes(p) ? s.plans.filter(x => x !== p) : [...s.plans, p] }))
  const num = (k: 'joinedWithinDays' | 'activeWithinDays' | 'inactiveForDays', label: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className={`${input} mt-1`} inputMode="numeric" value={seg[k]} onChange={e => setSeg(s => ({ ...s, [k]: e.target.value.replace(/\D/g, '').slice(0, 4) }))} placeholder="any" />
    </label>
  )

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_1fr] items-start">
        <section className="card p-5 space-y-4">
          <h2 className="font-display text-lg font-bold text-ink">Who gets it</h2>
          <div>
            <span className="label">Plan</span>
            <div className="flex gap-2 mt-1">
              {['free', 'premium', 'pro'].map(p => (
                <button key={p} type="button" onClick={() => togglePlan(p)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold border ${seg.plans.includes(p) ? 'bg-accent text-bg border-accent' : 'border-line text-muted'}`}>{p}</button>
              ))}
            </div>
            <p className="text-[11px] text-faint mt-1">None selected = every plan.</p>
          </div>
          {num('joinedWithinDays', 'Joined in the last … days')}
          {num('activeWithinDays', 'Signed in during the last … days')}
          {num('inactiveForDays', 'No sign-in for … days (win back)')}
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={seg.includeStaff} onChange={e => setSeg(s => ({ ...s, includeStaff: e.target.checked }))} className="w-4 h-4 accent-[rgb(var(--accent))]" />
            Include admin and staff accounts
          </label>
          <div className="rounded-xl bg-surface2/60 border border-line px-3 py-2">
            <div className="num text-2xl font-extrabold text-ink">{preview ? preview.count : '–'}</div>
            <div className="text-[11px] text-muted">people in this segment · {preview?.optedIn ?? '–'} accounts accept update emails in total</div>
            {preview && preview.sample.length > 0 && <div className="text-[11px] text-faint mt-1 truncate">{preview.sample.map(x => x.email).join(', ')}</div>}
          </div>
          <p className="text-[11px] text-faint">Only accounts that ticked "email updates" and confirmed their email. Every email has a one-click unsubscribe link.</p>
        </section>

        <section className="card p-5 space-y-3">
          <h2 className="font-display text-lg font-bold text-ink">Message</h2>
          <input className={input} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" maxLength={150} />
          <textarea className={`${input} min-h-[220px] resize-y`} value={body} onChange={e => setBody(e.target.value)} maxLength={20000}
            placeholder={'Hi {name},\n\nWrite your update here. A blank line starts a new paragraph. **bold** works, links are clickable.\n\nThe SportLikely team'} />
          <p className="text-[11px] text-faint">{'{name}'} is replaced by the person's name (or "there"). Replies go to support@.</p>
          <Err e={error} />
          {info && <div className="rounded-xl border border-win/40 bg-win/10 px-3 py-2 text-sm text-win">{info}</div>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={test} disabled={busy || subject.trim().length < 3 || body.trim().length < 10} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">Send me a test</button>
            <button type="button" onClick={send} disabled={busy || !preview?.count || subject.trim().length < 3 || body.trim().length < 10} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-50">
              Send to {preview?.count ?? 0}
            </button>
          </div>
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60 font-display font-bold text-ink">Sent campaigns</div>
        {list.length === 0 ? <p className="p-5 text-sm text-faint">None yet.</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase tracking-wide text-faint text-left"><th className="px-5 py-2">Date</th><th className="px-2 py-2">Subject</th><th className="px-2 py-2 text-right">Sent</th><th className="px-5 py-2 text-right">Status</th></tr></thead>
            <tbody className="divide-y divide-line/50">
              {list.map(c => (
                <tr key={c.id}>
                  <td className="px-5 py-2 text-muted whitespace-nowrap">{fmt(c.createdAt)}</td>
                  <td className="px-2 py-2 text-ink truncate max-w-[280px]">{c.subject}</td>
                  <td className="px-2 py-2 text-right num">{c.sent}/{c.total}{c.failed ? <span className="text-loss"> · {c.failed} failed</span> : ''}</td>
                  <td className="px-5 py-2 text-right text-xs">{c.status === 'sending' ? <span className="text-draw font-semibold">sending…</span> : <span className="text-win">done</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

/* ================================================================== */
/* Revenue & churn                                                    */
/* ================================================================== */

interface Rev {
  accounts: number
  paying: { total: number; premium: number; pro: number; fromPayments: number; testOrManual: number }
  mrr: number; arr: number; prices: Record<string, number>
  conversion: number | null; churnThisMonth: number | null; cancelledStillActive: number
  monthly: { month: string; signups: number; newPaid: number; revenue: number; cancels: number; deletes: number; testChanges: number }[]
  reasons: { reason: string; n: number }[]
  paymentsLive: boolean
}
const REASON: Record<string, string> = {
  too_expensive: 'Too expensive', not_accurate: 'Predictions not accurate enough', not_using: 'Not using it enough',
  missing_feature: 'Missing a feature', other_service: 'Found another service', technical: 'Technical problems', other: 'Other'
}

function Revenue() {
  const [d, setD] = useState<Rev | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { axios.get(`${API_URL}/crm/revenue`).then(r => setD(r.data.data)).catch(e => setError(errorText(e))) }, [])
  if (error) return <Err e={error} />
  if (!d) return <div className="card p-6 text-sm text-faint">Loading…</div>
  const maxSign = Math.max(1, ...d.monthly.map(m => m.signups))
  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-2xl border border-line/60 bg-surface2/50 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="num text-2xl font-extrabold text-ink leading-none mt-1.5">{value}</div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  )

  return (
    <div className="space-y-5">
      {!d.paymentsLive && (
        <div className="rounded-xl border border-draw/40 bg-draw/10 px-4 py-3 text-sm text-ink">
          Payments are not live yet: money figures stay at $0 until real payments come in. Plans set by hand or in test mode are counted as accounts, not revenue ({d.paying.testOrManual} now).
        </div>
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tile('Monthly revenue (MRR)', `$${d.mrr.toLocaleString('en-US')}`, `$${d.arr.toLocaleString('en-US')} a year at this rate`)}
        {tile('Paying accounts', String(d.paying.total), `${d.paying.premium} Premium · ${d.paying.pro} Pro`)}
        {tile('Free → paid', d.conversion !== null ? `${d.conversion}%` : '–', `of ${d.accounts} accounts`)}
        {tile('Churn this month', d.churnThisMonth !== null ? `${d.churnThisMonth}%` : '–', `${d.cancelledStillActive} cancelled, still active`)}
      </div>

      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60 flex items-baseline justify-between gap-3">
          <h2 className="font-display font-bold text-ink">Last 12 months</h2>
          <span className="text-[11px] text-faint">Premium ${d.prices.premium} · Pro ${d.prices.pro} a month</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead><tr className="text-[11px] uppercase tracking-wide text-faint text-left">
              <th className="px-5 py-2">Month</th><th className="px-2 py-2">Sign-ups</th><th className="px-2 py-2 text-right">New paying</th><th className="px-2 py-2 text-right">Revenue</th><th className="px-2 py-2 text-right">Cancelled</th><th className="px-5 py-2 text-right">Deleted</th>
            </tr></thead>
            <tbody className="divide-y divide-line/50">
              {d.monthly.slice().reverse().map(m => (
                <tr key={m.month}>
                  <td className="px-5 py-2 text-muted num whitespace-nowrap">{new Date(`${m.month}-01T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-2">
                      <span className="w-6 text-right num text-ink">{m.signups}</span>
                      <span className="flex-1 max-w-[160px] h-1.5 rounded-full bg-surface2 overflow-hidden"><span className="block h-full bg-accent rounded-full" style={{ width: `${(m.signups / maxSign) * 100}%` }} /></span>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right num text-ink">{m.newPaid || '–'}</td>
                  <td className="px-2 py-2 text-right num text-ink">{m.revenue ? `$${m.revenue.toLocaleString('en-US')}` : '–'}</td>
                  <td className={`px-2 py-2 text-right num ${m.cancels ? 'text-loss' : 'text-faint'}`}>{m.cancels || '–'}</td>
                  <td className={`px-5 py-2 text-right num ${m.deletes ? 'text-loss' : 'text-faint'}`}>{m.deletes || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-display font-bold text-ink mb-3">Why people leave (12 months)</h2>
        {d.reasons.length === 0 ? <p className="text-sm text-faint">Nobody has cancelled or deleted an account yet.</p> : (
          <ul className="space-y-2">
            {d.reasons.map(r => {
              const max = d.reasons[0].n
              return (
                <li key={r.reason} className="flex items-center gap-3 text-sm">
                  <span className="w-56 truncate text-ink">{REASON[r.reason] || r.reason}</span>
                  <span className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden"><span className="block h-full bg-loss/80 rounded-full" style={{ width: `${(r.n / max) * 100}%` }} /></span>
                  <span className="w-8 text-right num text-muted">{r.n}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

/* ================================================================== */
/* Customers                                                          */
/* ================================================================== */

interface CustRow { trust?: 'real' | 'unsure' | 'bot'; trustReasons?: string[]; id: number; email: string; name: string | null; plan: string; premiumUntil: string | null; createdAt: string; lastLoginAt: string | null; cancelAt: string | null; emailVerified: boolean }
interface CustProfile extends CustRow {
  role: string | null; emailUpdates: boolean; twoFactor: boolean; devices: number; unlocksThisMonth: number; favorites: number
  planHistory: { at: string; fromPlan: string | null; toPlan: string; until: string | null; source: string }[]
  messages: { id: number; at: string; topic: string; status: string }[]
  security: { at: string; event: string; ip: string | null; ua: string | null }[] | null
  staffActivity?: ActRow[]
}
// fix168: Real / Unsure / Bot (reasons on hover)
const TRUST_TONE: Record<string, string> = { real: 'bg-win/15 text-win', unsure: 'bg-draw/15 text-draw', bot: 'bg-loss/15 text-loss' }
const TRUST_LABEL: Record<string, string> = { real: 'Real', unsure: 'Unsure', bot: 'Bot' }
const PLAN_TONE: Record<string, string> = { free: 'text-muted', premium: 'text-accent', pro: 'text-accent font-bold' }

function Customers() {
  const [q, setQ] = useState('')
  const [trust, setTrust] = useState<'' | 'real' | 'unsure' | 'bot'>('')
  const [rows, setRows] = useState<CustRow[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(() => { axios.get(`${API_URL}/crm/customers`, { params: { q, ...(trust ? { trust } : {}) } }).then(r => { setRows(r.data.data); setError(null) }).catch(e => setError(errorText(e))) }, 250)
    return () => clearTimeout(t)
  }, [q, trust])
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_1fr] items-start">
      <section className="card overflow-hidden">
        <div className="p-2 border-b border-line/60">
          <input className={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Search email or name" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          <div className="seg mt-2">
            {([['', 'All'], ['real', 'Real'], ['unsure', 'Unsure'], ['bot', 'Bot']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTrust(k)} className={`seg-btn ${trust === k ? 'seg-btn-active' : ''}`}>{l}</button>
            ))}
          </div>
        </div>
        <Err e={error} />
        {!rows ? <div className="p-6 text-sm text-faint">Loading…</div> : rows.length === 0 ? <div className="p-6 text-sm text-faint">No accounts found.</div> : (
          <ul className="divide-y divide-line/50 max-h-[70vh] overflow-y-auto">
            {rows.map(r => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpenId(r.id)} className={`w-full text-left px-4 py-2.5 hover:bg-surface2/50 ${openId === r.id ? 'bg-surface2/70' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink truncate flex-1">{r.email}</span>
                    {r.trust && <span title={(r.trustReasons || []).join(' · ')} className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${TRUST_TONE[r.trust]}`}>{TRUST_LABEL[r.trust]}</span>}
                    <span className={`text-[11px] uppercase ${PLAN_TONE[r.plan] || ''}`}>{r.plan}</span>
                  </div>
                  <div className="text-[11px] text-faint">{r.name ? `${r.name} · ` : ''}joined {fmtDay(r.createdAt)} · last seen {fmtDay(r.lastLoginAt)}{r.cancelAt ? ' · cancelled' : ''}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {openId ? <CustomerView id={openId} /> : <section className="card p-8 text-sm text-faint hidden lg:block">Pick an account on the left.</section>}
    </div>
  )
}

function CustomerView({ id }: { id: number }) {
  const { can } = useAuth()
  const [c, setC] = useState<CustProfile | null>(null)
  const [plan, setPlan] = useState<'premium' | 'pro' | 'free'>('premium')
  const [days, setDays] = useState('7')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/crm/customers/${id}`).then(r => { setC(r.data.data); setError(null) }).catch(e => setError(errorText(e)))
  useEffect(() => { setC(null); setInfo(null); load() }, [id])
  const act = async (fn: () => Promise<string>) => {
    setBusy(true); setError(null); setInfo(null)
    try { setInfo(await fn()); await load() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  if (!c) return <section className="card p-6 text-sm text-faint">{error || 'Loading…'}</section>
  const staffAcct = !!c.role
  const row = (k: string, v: ReactNode) => <div className="flex justify-between gap-3 py-1.5 border-b border-line/40 text-sm"><span className="text-muted">{k}</span><span className="text-ink text-right">{v}</span></div>

  return (
    <section className="card p-5 sm:p-6 space-y-5">
      <div>
        <div className="text-[11px] text-faint">Account #{c.id}{staffAcct ? ` · staff (${c.role})` : ''}</div>
        <h2 className="font-display text-xl font-bold text-ink truncate">{c.name || c.email}</h2>
        <div className="text-sm text-muted truncate">{c.email}</div>
        {/* fix259: the profile for Claude (account id, no email) */}
        <div className="mt-2"><CopyForClaude api="crm" size="sm" req={() => ({ place: `CRM → Customers → account #${c.id}`, scope: 'crm-customer', id: c.id })} /></div>
      </div>
      <div>
        {row('Plan', <span className={PLAN_TONE[c.plan]}>{c.plan}{c.premiumUntil ? ` · until ${fmtDay(c.premiumUntil)}` : ''}{c.cancelAt ? ' · cancelled' : ''}</span>)}
        {row('Joined', fmtDay(c.createdAt))}
        {row('Last sign-in', fmt(c.lastLoginAt))}
        {row('Email confirmed', c.emailVerified ? 'Yes' : 'No')}
        {row('Email updates', c.emailUpdates ? 'Yes' : 'No')}
        {row('Two-step login', c.twoFactor ? 'On' : 'Off')}
        {row('Signed-in devices', c.devices)}
        {row('Unlocks this month', c.unlocksThisMonth)}
        {row('Favorites', c.favorites)}
      </div>

      {can('customers.plan') && !staffAcct && (
        <div className="rounded-2xl border border-line p-4 space-y-3">
          <div className="font-semibold text-ink text-sm">Change plan</div>
          <div className="flex flex-wrap items-end gap-2">
            <select value={plan} onChange={e => setPlan(e.target.value as any)} className="rounded-lg border border-line bg-surface2/60 px-2 py-2 text-sm text-ink">
              <option value="premium">Premium</option><option value="pro">Pro</option><option value="free">Free</option>
            </select>
            {plan !== 'free' && (
              <label className="text-xs text-muted">Days<input value={days} onChange={e => setDays(e.target.value.replace(/\D/g, '').slice(0, 3))} className="ml-1 w-16 rounded-lg border border-line bg-surface2/60 px-2 py-2 text-sm text-ink num" inputMode="numeric" /></label>
            )}
            <button type="button" disabled={busy} onClick={() => {
              if (!window.confirm(plan === 'free' ? `Set ${c.email} back to Free?` : `Give ${c.email} ${plan} for ${days} days?`)) return
              act(async () => { await axios.post(`${API_URL}/crm/customers/${id}/plan`, { plan, days: Number(days) || 7 }); return 'Plan updated.' })
            }} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">Apply</button>
          </div>
          <p className="text-[11px] text-faint">Same plan already running: the days are added to its end date. Recorded as a manual change (not revenue).</p>
        </div>
      )}

      <CustomerCredits id={id} canGrant={can('customers.plan')} />

      {can('customers.security') && !staffAcct && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => act(async () => { const r = await axios.post(`${API_URL}/crm/customers/${id}/reset-email`); return `Password-reset code sent to ${r.data.data.sentTo}.` })} className="rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink">Send password reset email</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm('Sign this customer out on every device?')) act(async () => { const r = await axios.post(`${API_URL}/crm/customers/${id}/sign-out`); return `Signed out on ${r.data.data.devices} device(s).` }) }} className="rounded-xl border border-line px-3 py-2 text-sm font-semibold text-ink">Sign out everywhere</button>
        </div>
      )}
      <Err e={error} />
      {info && <div className="rounded-xl border border-win/40 bg-win/10 px-3 py-2 text-sm text-win">{info}</div>}

      {c.planHistory.length > 0 && (
        <div>
          <div className="label pb-1">Plan history</div>
          <ul className="text-xs text-muted space-y-1">
            {c.planHistory.map((h, i) => <li key={i}>{fmt(h.at)} · {h.fromPlan || '—'} → <b className="text-ink">{h.toPlan}</b>{h.until ? ` until ${fmtDay(h.until)}` : ''} · {h.source}</li>)}
          </ul>
        </div>
      )}
      {c.messages.length > 0 && (
        <div>
          <div className="label pb-1">Messages</div>
          <ul className="text-xs text-muted space-y-1">
            {c.messages.map(m => <li key={m.id}>#{m.id} · {fmt(m.at)} · {TOPIC[m.topic] || m.topic} · {m.status}</li>)}
          </ul>
        </div>
      )}
      {c.staffActivity && c.staffActivity.length > 0 && (
        <div>
          <div className="label pb-1">What staff did on this account</div>
          <ul className="text-xs text-muted space-y-1">
            {c.staffActivity.slice(0, 15).map(a => <li key={a.id}>{fmt(a.at)} · <span className="text-ink">{a.staffEmail}</span> · {a.label}{a.detail ? ` (${a.detail})` : ''}</li>)}
          </ul>
        </div>
      )}
      {c.security && c.security.length > 0 && (
        <div>
          <div className="label pb-1">Recent sign-ins and security events</div>
          <ul className="text-xs text-muted space-y-1">
            {c.security.slice(0, 12).map((x, i) => <li key={i}>{fmt(x.at)} · <span className="text-ink">{x.event.replace(/_/g, ' ')}</span>{x.ip ? ` · ${x.ip}` : ''}</li>)}
          </ul>
        </div>
      )}
    </section>
  )
}

/* ================================================================== */
/* Security log                                                       */
/* ================================================================== */

function SecurityLog() {
  const [d, setD] = useState<{ failed24h: number; rows: { id: number; at: string; email: string | null; event: string; ip: string | null; ua: string | null; detail: string | null }[] } | null>(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { axios.get(`${API_URL}/crm/security`).then(r => setD(r.data.data)).catch(e => setError(errorText(e))) }, [])
  if (error) return <Err e={error} />
  if (!d) return <div className="card p-6 text-sm text-faint">Loading…</div>
  const term = q.trim().toLowerCase()
  const rows = d.rows.filter(r => !term || `${r.email} ${r.event} ${r.ip} ${r.detail}`.toLowerCase().includes(term))
  const bad = (e: string) => /fail|off|deleted|role_|signed_out|reset|recovery/.test(e)
  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-line/60">
        <span className={`text-sm ${d.failed24h > 5 ? 'text-loss font-semibold' : 'text-muted'}`}>{d.failed24h} failed sign-ins in the last 24 h · IPs kept 90 days</span>
        <input className={`${input} max-w-xs`} value={q} onChange={e => setQ(e.target.value)} placeholder="Filter (email, IP, event)" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <tbody className="divide-y divide-line/50">
            {rows.slice(0, 300).map(r => (
              <tr key={r.id}>
                <td className="px-5 py-2 text-[11px] text-faint whitespace-nowrap num">{fmt(r.at)}</td>
                <td className={`px-2 py-2 font-semibold whitespace-nowrap ${bad(r.event) ? 'text-loss' : 'text-ink'}`}>{r.event.replace(/_/g, ' ')}</td>
                <td className="px-2 py-2 text-muted truncate max-w-[220px]">{r.email || '—'}</td>
                <td className="px-2 py-2 text-[11px] text-faint truncate max-w-[260px]">{r.detail || ''}</td>
                <td className="px-5 py-2 text-[11px] text-faint num whitespace-nowrap">{r.ip || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/* ================================================================== */
/* Team & roles                                                       */
/* ================================================================== */

interface PermDef { key: string; group: string; label: string; help: string }
interface RoleDef { key: string; name: string; perms: string[]; members?: number; locked?: boolean }
interface StaffRow { id: number; email: string; name: string | null; role: string; roleName: string; emailVerified: boolean; twoFactor: boolean; lastLoginAt: string | null; console: { username: string; mustChange: boolean; updatedAt: string } | null }
interface TeamData { perms: PermDef[]; admin: RoleDef; roles: RoleDef[]; staff: StaffRow[]; isAdmin: boolean }

function Team() {
  const [d, setD] = useState<TeamData | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  // team changes need a fresh two-step code (opens a 5-minute window on the server)
  const [left, setLeft] = useState(0)
  const [pending, setPending] = useState<null | (() => Promise<string | void>)>(null)
  const [code, setCode] = useState('')
  const [conFor, setConFor] = useState<number | null>(null)
  const [conUser, setConUser] = useState('')
  const [conPw, setConPw] = useState('')
  const load = () => axios.get(`${API_URL}/crm/team`).then(r => { setD(r.data.data); setError(null) }).catch(e => setError(errorText(e)))
  const loadSudo = () => axios.get(`${API_URL}/crm/team/sudo`).then(r => setLeft(r.data.data.leftMs)).catch(() => undefined)
  useEffect(() => { load(); loadSudo() }, [])
  useEffect(() => {
    if (left <= 0) return
    const t = setInterval(() => setLeft(x => Math.max(0, x - 1000)), 1000)
    return () => clearInterval(t)
  }, [left > 0])
  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true); setError(null); setInfo(null)
    try { const m = await fn(); if (m) setInfo(m); await load() }
    catch (e: any) {
      if (e?.response?.status === 401 && e?.response?.data?.sudo) { setLeft(0); setPending(() => fn) }
      else setError(errorText(e))
    } finally { setBusy(false) }
  }
  const unlock = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await axios.post(`${API_URL}/crm/team/sudo`, { code })
      setLeft(r.data.data.leftMs); setCode('')
      const fn = pending; setPending(null)
      if (fn) { setBusy(false); await act(fn); return }
    } catch (err) { setError(errorText(err)); setCode('') } finally { setBusy(false) }
  }
  if (!d) return <div className="card p-6 text-sm text-faint">{error || 'Loading…'}</div>
  const mmss = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
  const groups = [...new Set(d.perms.map(p => p.group))]
  const toggle = (r: RoleDef, perm: string) => {
    const perms = r.perms.includes(perm) ? r.perms.filter(x => x !== perm) : [...r.perms, perm]
    act(async () => { await axios.post(`${API_URL}/crm/team/roles/${r.key}`, { perms }) })
  }
  const cols: RoleDef[] = [d.admin, ...d.roles]

  return (
    <div className="space-y-5">
      <div className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm ${left > 0 ? 'border-win/40 bg-win/10' : 'border-line bg-surface2/40'}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={left > 0 ? 'text-win' : 'text-muted'} aria-hidden>
          <rect x="5" y="11" width="14" height="10" rx="2" /><path d={left > 0 ? 'M8 11V7a4 4 0 0 1 7.5-2' : 'M8 11V7a4 4 0 0 1 8 0v4'} />
        </svg>
        <span className="flex-1 text-ink">
          {left > 0 ? <>Team changes unlocked for <b className="num">{mmss}</b>. Every change is logged.</> : 'Team changes are locked. Each time you change the team or a role, you confirm it with a code from your authenticator app.'}
        </span>
        {left <= 0 && !pending && <button type="button" onClick={() => setPending(() => async () => 'Unlocked.')} className="rounded-xl border border-line px-3 py-1.5 text-xs font-semibold text-ink">Unlock now</button>}
      </div>

      {pending && (
        <form onSubmit={unlock} className="card p-5 space-y-3 border-accent/40">
          <div className="font-display font-bold text-ink">Confirm with two-step login</div>
          <p className="text-sm text-muted">Enter the 6-digit code from your authenticator app. The change you asked for is saved right after.</p>
          <div className="flex flex-wrap gap-2">
            <input
              className="w-[200px] rounded-xl border border-line bg-surface2/60 px-4 py-2.5 text-center num text-2xl tracking-[0.4em] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus aria-label="6-digit code"
            />
            <button type="submit" disabled={busy || code.length !== 6} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{busy ? 'Checking…' : 'Confirm'}</button>
            <button type="button" onClick={() => { setPending(null); setCode('') }} className="rounded-xl px-4 py-2 text-sm text-muted">Cancel</button>
          </div>
        </form>
      )}

      <Err e={error} />
      {info && <div className="rounded-xl border border-win/40 bg-win/10 px-3 py-2 text-sm text-win">{info}</div>}

      {/* staff members */}
      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display font-bold text-ink">Team ({d.staff.length})</h2>
          <span className="text-[11px] text-faint">Staff need a confirmed email and two-step login before their role works.</span>
        </div>
        <form onSubmit={e => { e.preventDefault(); act(async () => { await axios.post(`${API_URL}/crm/team/member`, { email, role: role || null }); setEmail(''); return 'Saved.' }) }} className="flex flex-wrap gap-2 p-4 border-b border-line/60">
          <input className={`${input} flex-1 min-w-[220px]`} type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Their account email (they sign up first)" autoCapitalize="none" spellCheck={false} />
          <select value={role} onChange={e => setRole(e.target.value)} className="rounded-xl border border-line bg-surface2/60 px-3 py-2 text-sm text-ink">
            <option value="">Choose a role…</option>
            {d.roles.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
          <button type="submit" disabled={busy || !role} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">Add to team</button>
        </form>
        {d.staff.length === 0 ? <p className="p-5 text-sm text-faint">No staff yet. You (admin) have every permission.</p> : (
          <ul className="divide-y divide-line/50">
            {d.staff.map(m => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="flex-1 min-w-[200px]">
                  <span className="block text-ink truncate">{m.name || m.email}</span>
                  <span className="block text-[11px] text-faint truncate">{m.email} · last seen {fmtDay(m.lastLoginAt)}</span>
                  <span className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2/60 px-2 py-0.5 text-xs">
                    <span className="text-faint">Console username</span>
                    {m.console ? <b className="num text-ink select-all">{m.console.username}</b> : <span className="text-loss font-semibold">not set</span>}
                  </span>
                </span>
                {(!m.twoFactor || !m.emailVerified) && <span className="text-[11px] text-draw font-semibold">{!m.emailVerified ? 'email not confirmed' : 'no two-step login yet'}</span>}
                <button type="button" disabled={busy} onClick={() => { setConFor(conFor === m.id ? null : m.id); setConUser(m.console?.username || ''); setConPw('') }} className="text-xs text-accent font-semibold">{m.console ? 'Edit console login' : 'Set console login'}</button>
                <select value={m.role} disabled={busy} onChange={e => act(async () => { await axios.post(`${API_URL}/crm/team/member`, { email: m.email, role: e.target.value }); return `${m.email} is now ${d.roles.find(r => r.key === e.target.value)?.name}.` })} className="rounded-lg border border-line bg-surface2/60 px-2 py-1.5 text-xs text-ink">
                  {d.roles.map(r => <option key={r.key} value={r.key}>{r.name}</option>)}
                </select>
                <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.email} from the team? Their access stops at once.`)) act(async () => { await axios.post(`${API_URL}/crm/team/member`, { email: m.email, role: null }); return 'Removed from the team.' }) }} className="text-xs text-muted hover:text-loss">Remove</button>
              {conFor === m.id && (
                  <form
                    onSubmit={e => {
                      e.preventDefault()
                      const id = m.id, u = conUser.trim(), p = conPw
                      if (m.console && !p && u === m.console.username) { setConFor(null); return }
                      act(async () => {
                        const r = await axios.post(`${API_URL}/crm/team/console`, { userId: id, username: u, password: p || undefined })
                        setConFor(null); setConPw('')
                        return r.data.data.passwordChanged
                          ? `Console login for ${m.email}: username ${r.data.data.username}, new password saved. Give it to them in person or by phone (not by email).`
                          : `Console username for ${m.email} is now ${r.data.data.username}. Their password did not change.`
                      })
                    }}
                    className="basis-full rounded-xl border border-line bg-surface2/40 p-3 space-y-2"
                  >
                    <div className="text-xs font-semibold text-ink">{m.console ? 'Edit console login' : 'Set console login'}</div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block">
                        <span className="block text-[11px] text-faint mb-1">Console username</span>
                        <input className={input} value={conUser} onChange={e => setConUser(e.target.value)} placeholder="e.g. dana.s" autoCapitalize="none" spellCheck={false} autoComplete="off" required />
                      </label>
                      <label className="block">
                        <span className="block text-[11px] text-faint mb-1">{m.console ? 'New password (leave empty to keep it)' : 'Password'}</span>
                        <input className={input} type="text" value={conPw} onChange={e => setConPw(e.target.value)} placeholder="10+ characters" autoComplete="off" minLength={10} required={!m.console} />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="submit" disabled={busy} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">Save</button>
                      <button type="button" onClick={() => setConFor(null)} className="rounded-xl px-3 py-2 text-sm text-muted">Cancel</button>
                      <span className="text-[11px] text-faint">Only managers set console passwords — staff can't change their own. A new password signs them out of the console.</span>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* permissions matrix */}
      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display font-bold text-ink">Roles & permissions</h2>
          <span className="text-[11px] text-faint">Click a box to switch a permission on or off. Changes apply at once. Admin always has everything.</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="text-[11px] text-faint">
                <th className="text-left px-5 py-2 font-semibold w-[260px]">Permission</th>
                {cols.map(r => (
                  <th key={r.key} className="px-2 py-2 font-semibold text-center align-bottom">
                    <span className="block text-ink">{r.name}</span>
                    <span className="block font-normal">{r.locked ? 'locked' : `${r.members ?? 0} ${(r.members ?? 0) === 1 ? 'person' : 'people'}`}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <Fragment key={g}>
                  <tr><td colSpan={cols.length + 1} className="px-5 pt-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-faint">{g}</td></tr>
                  {d.perms.filter(p => p.group === g).map(p => (
                    <tr key={p.key} className="border-t border-line/40">
                      <td className="px-5 py-2"><span className="block text-ink">{p.label}</span><span className="block text-[11px] text-faint">{p.help}</span></td>
                      {cols.map(r => {
                        const on = r.perms.includes(p.key)
                        const locked = !!r.locked || (p.key === 'team' && !d.isAdmin)
                        return (
                          <td key={r.key} className="px-2 py-2 text-center">
                            <button type="button" disabled={busy || locked} onClick={() => toggle(r, p.key)} aria-pressed={on} aria-label={`${p.label} for ${r.name}`}
                              className={`w-7 h-7 rounded-lg border grid place-items-center mx-auto transition-colors ${on ? 'bg-accent border-accent text-bg' : 'border-line text-transparent hover:border-faint'} ${locked ? 'opacity-60 cursor-not-allowed' : ''}`}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="border-t border-line/60">
                <td className="px-5 py-3 text-[11px] text-faint">Rename / delete</td>
                {cols.map(r => (
                  <td key={r.key} className="px-2 py-3 text-center">
                    {!r.locked && (
                      <span className="inline-flex flex-col gap-1">
                        <button type="button" disabled={busy} onClick={() => { const n = window.prompt('New name for this role', r.name); if (n && n.trim() !== r.name) act(async () => { await axios.post(`${API_URL}/crm/team/roles/${r.key}`, { name: n }) }) }} className="text-[11px] text-accent">Rename</button>
                        <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Delete the role "${r.name}"?`)) act(async () => { await axios.delete(`${API_URL}/crm/team/roles/${r.key}`); return 'Role deleted.' }) }} className="text-[11px] text-muted hover:text-loss">Delete</button>
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <form onSubmit={e => { e.preventDefault(); act(async () => { await axios.post(`${API_URL}/crm/team/roles`, { name: newName, perms: [] }); setNewName(''); return 'Role created. Tick its permissions in the table.' }) }} className="flex flex-wrap gap-2 p-4 border-t border-line/60">
          <input className={`${input} max-w-xs`} value={newName} onChange={e => setNewName(e.target.value)} placeholder="New role name (e.g. Finance)" maxLength={40} />
          <button type="submit" disabled={busy || newName.trim().length < 2} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60">Create role</button>
        </form>
      </section>
    </div>
  )
}

/* ---------- Beta testers: invite links (free Pro for N days) and who joined ---------- */
interface Invite { code: string; label: string | null; days: number; maxUses: number | null; open: boolean; createdAt: string; uses: number }
interface TesterRow { id: number; code: string; joinedAt: string; until: string; email: string; name: string | null; verified: boolean; lastLoginAt: string | null; feedback: number; active: boolean }
function Testers({ canInvite }: { canInvite: boolean }) {
  const [d, setD] = useState<{ invites: Invite[]; testers: TesterRow[] } | null>(null)
  const [label, setLabel] = useState('')
  const [days, setDays] = useState('21')
  const [limit, setLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/crm/testers`).then(r => { setD(r.data.data); setError(null) }).catch(e => setError(errorText(e)))
  useEffect(() => { load() }, [])
  const linkOf = (code: string) => `${window.location.origin}/join/${code}`
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(linkOf(code)); setCopied(code); setTimeout(() => setCopied(null), 1500) } catch { /* no clipboard */ }
  }
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn(); await load() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  if (!d) return <div className="card p-6 text-sm text-faint">{error || 'Loading…'}</div>
  const active = d.testers.filter(t => t.active).length
  const week = Date.now() - 7 * 86400000
  const seenWeek = d.testers.filter(t => t.lastLoginAt && new Date(t.lastLoginAt).getTime() > week).length
  const fb = d.testers.reduce((a, t) => a + t.feedback, 0)

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[['Testers', d.testers.length], ['Pro still on', active], ['Seen in the last 7 days', seenWeek], ['Feedback messages', fb]].map(([k, v]) => (
          <div key={k as string} className="card px-4 py-3"><div className="num text-2xl font-extrabold text-ink">{v}</div><div className="text-[11px] text-faint">{k}</div></div>
        ))}
      </div>
      <Err e={error} />

      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display font-bold text-ink">Invite links</h2>
          <span className="text-[11px] text-faint">Anyone with the link gets free Pro for the days you choose. Feedback arrives in the Support inbox as "Tester feedback".</span>
        </div>
        {canInvite && (
          <form onSubmit={e => { e.preventDefault(); act(async () => { await axios.post(`${API_URL}/crm/testers/invite`, { label, days: Number(days), maxUses: limit ? Number(limit) : null }); setLabel(''); setLimit('') }) }} className="flex flex-wrap gap-2 p-4 border-b border-line/60">
            <input className={`${input} flex-1 min-w-[180px]`} value={label} onChange={e => setLabel(e.target.value)} placeholder="Name for the link (e.g. Friends WhatsApp)" />
            <label className="flex items-center gap-1.5 text-xs text-muted">Days <input className={`${input} w-20`} type="number" min={1} max={90} value={days} onChange={e => setDays(e.target.value)} /></label>
            <label className="flex items-center gap-1.5 text-xs text-muted">Max people <input className={`${input} w-24`} type="number" min={1} value={limit} onChange={e => setLimit(e.target.value)} placeholder="no limit" /></label>
            <button type="submit" disabled={busy} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">Create link</button>
          </form>
        )}
        {d.invites.length === 0 ? <p className="p-5 text-sm text-faint">No invite links yet.</p> : (
          <ul className="divide-y divide-line/50">
            {d.invites.map(i => (
              <li key={i.code} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="flex-1 min-w-[220px]">
                  <span className="block text-ink font-semibold">{i.label || 'Invite link'} {!i.open && <span className="ml-1 text-[11px] text-loss">closed</span>}</span>
                  <span className="block text-[11px] text-faint num select-all break-all">{linkOf(i.code)}</span>
                </span>
                <span className="text-xs text-muted num">{i.uses}{i.maxUses ? ` / ${i.maxUses}` : ''} joined · {i.days} days Pro</span>
                <button type="button" onClick={() => copy(i.code)} className="text-xs font-semibold text-accent">{copied === i.code ? 'Copied ✓' : 'Copy link'}</button>
                {canInvite && <button type="button" disabled={busy} onClick={() => act(() => axios.post(`${API_URL}/crm/testers/invite/${i.code}`, { open: !i.open }))} className="text-xs text-muted hover:text-ink">{i.open ? 'Close' : 'Reopen'}</button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60"><h2 className="font-display font-bold text-ink">Testers ({d.testers.length})</h2></div>
        {d.testers.length === 0 ? <p className="p-5 text-sm text-faint">Nobody has joined yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead><tr className="text-[11px] text-faint text-left">
                <th className="px-5 py-2 font-semibold">Tester</th><th className="px-3 py-2 font-semibold">Joined</th><th className="px-3 py-2 font-semibold">Pro until</th><th className="px-3 py-2 font-semibold">Last seen</th><th className="px-3 py-2 font-semibold text-right">Feedback</th>
              </tr></thead>
              <tbody className="divide-y divide-line/50">
                {d.testers.map(t => (
                  <tr key={t.id}>
                    <td className="px-5 py-2"><span className="block text-ink truncate max-w-[260px]">{t.name || t.email}</span><span className="block text-[11px] text-faint truncate max-w-[260px]">{t.email}{!t.verified && <span className="text-draw"> · email not confirmed</span>}</span></td>
                    <td className="px-3 py-2 text-muted num">{fmtDay(t.joinedAt)}</td>
                    <td className={`px-3 py-2 num ${t.active ? 'text-ink' : 'text-faint'}`}>{fmtDay(t.until)}</td>
                    <td className="px-3 py-2 text-muted num">{fmtDay(t.lastLoginAt)}</td>
                    <td className="px-3 py-2 text-right num text-ink">{t.feedback}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/* ---------- Staff activity: who did what (recorded automatically for every staff action) ---------- */
interface ActRow { id: number; at: string; staffId: number; staffEmail: string | null; role: string | null; action: string; label: string; targetUser: number | null; targetEmail: string | null; target: string | null; detail: string | null }
const ACT_GROUPS: { k: string; label: string }[] = [
  { k: '', label: 'Everything' }, { k: 'inbox', label: 'Support inbox' }, { k: 'customer', label: 'Customers' },
  { k: 'campaign', label: 'Campaigns' }, { k: 'tester', label: 'Testers' }, { k: 'team', label: 'Team' }, { k: 'role', label: 'Roles' },
  { k: 'console', label: 'Console sign-ins' }, { k: 'backup', label: 'Backups' }, { k: 'users', label: 'Users export' }
]
const ACT_TONE = (a: string) => (/password|sign_out|reset|role_|team_|backup_download|users_export|customer_plan/.test(a) ? 'text-draw' : 'text-ink')
function Activity() {
  const [d, setD] = useState<{ rows: ActRow[]; staff: { id: number; email: string; n: number; last: string }[]; week: { action: string; n: number }[] } | null>(null)
  const [staffId, setStaffId] = useState('')
  const [group, setGroup] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    axios.get(`${API_URL}/crm/activity`, { params: { staff: staffId || undefined, action: group || undefined } })
      .then(r => { setD(r.data.data); setError(null) }).catch(e => setError(errorText(e)))
  }, [staffId, group])
  if (!d) return <div className="card p-6 text-sm text-faint">{error || 'Loading…'}</div>
  const wk = (re: RegExp) => d.week.filter(w => re.test(w.action)).reduce((a, w) => a + w.n, 0)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {([['Replies sent', wk(/^inbox_reply$/)], ['Profiles opened', wk(/^customer_open$/)], ['Plan changes', wk(/^customer_plan$/)], ['Team / role changes', wk(/^(team_|role_)/)]] as [string, number][]).map(([k, v]) => (
          <div key={k} className="card px-4 py-3"><div className="num text-2xl font-extrabold text-ink">{v}</div><div className="text-[11px] text-faint">{k} · last 7 days</div></div>
        ))}
      </div>
      <section className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-line/60 flex flex-wrap items-center gap-2">
          <h2 className="font-display font-bold text-ink mr-auto">Staff activity</h2>
          <select value={staffId} onChange={e => setStaffId(e.target.value)} className="rounded-lg border border-line bg-surface2/60 px-2 py-1.5 text-xs text-ink">
            <option value="">All staff</option>
            {d.staff.map(s => <option key={s.id} value={s.id}>{s.email} ({s.n})</option>)}
          </select>
          <select value={group} onChange={e => setGroup(e.target.value)} className="rounded-lg border border-line bg-surface2/60 px-2 py-1.5 text-xs text-ink">
            {ACT_GROUPS.map(g => <option key={g.k} value={g.k}>{g.label}</option>)}
          </select>
        </div>
        <Err e={error} />
        {d.rows.length === 0 ? <p className="p-5 text-sm text-faint">Nothing recorded yet.</p> : (
          <ul className="divide-y divide-line/50 text-sm">
            {d.rows.map(r => (
              <li key={r.id} className="px-5 py-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="w-32 shrink-0 text-[11px] text-faint num">{fmt(r.at)}</span>
                <span className="w-48 shrink-0 truncate text-muted" title={r.role || ''}>{r.staffEmail}</span>
                <span className={`font-semibold ${ACT_TONE(r.action)}`}>{r.label}</span>
                {(r.targetEmail || r.target) && <span className="text-muted truncate">{[r.targetEmail, r.target && r.target !== r.targetEmail ? r.target : null].filter(Boolean).join(' · ')}</span>}
                {r.detail && <span className="text-[11px] text-faint">{r.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="px-5 py-3 text-[11px] text-faint border-t border-line/60">Recorded automatically for every staff action, kept 1 year. Message texts and passwords are never stored here.</p>
      </section>
    </div>
  )
}

/** fix147: a customer's pick packs — balance, history, grant / take picks (plan permission; logged on the server). */
function CustomerCredits({ id, canGrant }: { id: number; canGrant: boolean }) {
  const [d, setD] = useState<{ balance: number; events: { delta: number; reason: string; at: string }[] } | null>(null)
  const [n, setN] = useState('5')
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/crm/customers/${id}/credits`).then(r => setD(r.data.data)).catch(() => setD(null))
  useEffect(() => { load() }, [id])
  if (!d) return null
  const grant = (sign: 1 | -1) => {
    const delta = sign * (parseInt(n, 10) || 0)
    if (!delta || !window.confirm(`${delta > 0 ? 'Give' : 'Take'} ${Math.abs(delta)} picks?`)) return
    axios.post(`${API_URL}/crm/customers/${id}/credits`, { delta, note }).then(r => { setD(r.data.data); setMsg('Saved.'); setNote('') }).catch(e => setMsg(errorText(e)))
  }
  return (
    <div className="rounded-2xl border border-line p-4 space-y-3">
      <div className="flex items-baseline justify-between"><div className="font-semibold text-ink text-sm">Pick packs</div><div className="text-sm text-ink">Balance <b className="num">{d.balance}</b></div></div>
      {canGrant && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">Picks<input value={n} onChange={e => setN(e.target.value.replace(/\D/g, '').slice(0, 3))} className="ml-1 w-16 rounded-lg border border-line bg-surface2/60 px-2 py-2 text-sm text-ink num" inputMode="numeric" /></label>
          <label className="text-xs text-muted flex-1 min-w-[140px]">Note<input value={note} onChange={e => setNote(e.target.value.slice(0, 60))} className="ml-1 w-full rounded-lg border border-line bg-surface2/60 px-2 py-2 text-sm text-ink" placeholder="goodwill, support case…" /></label>
          <button type="button" onClick={() => grant(1)} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">Give</button>
          <button type="button" onClick={() => grant(-1)} className="rounded-xl border border-line text-ink font-semibold px-4 py-2 text-sm">Take</button>
        </div>
      )}
      {msg && <p className="text-xs text-muted">{msg}</p>}
      {d.events.length > 0 && (
        <ul className="text-xs divide-y divide-line/50 max-h-48 overflow-y-auto">
          {d.events.map((e, i) => <li key={i} className="py-1.5 flex gap-3"><span className="num text-faint w-24 shrink-0">{e.at.slice(0, 16).replace('T', ' ')}</span><span className={`num w-10 shrink-0 font-bold ${e.delta > 0 ? 'text-win' : 'text-loss'}`}>{e.delta > 0 ? '+' : ''}{e.delta}</span><span className="text-muted truncate">{e.reason}</span></li>)}
        </ul>
      )}
    </div>
  )
}

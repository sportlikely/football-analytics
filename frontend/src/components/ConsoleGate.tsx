import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'

/*
 * Staff console login: the CRM and the Users area ask for a separate console username + password once per sign-in.
 * The server refuses /api/crm/* and /api/admin/* (HTTP 423) until this session has passed it.
 */

interface Status { hasLogin: boolean; username: string | null; unlocked: boolean; mustChange: boolean; isAdmin: boolean }
const input =
  'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'
const btn = 'w-full rounded-xl bg-accent text-bg font-semibold px-4 py-2.5 text-sm disabled:opacity-60'

const Ctx = createContext<{ username: string | null; lock: () => void; changePassword: () => void }>({ username: null, lock: () => undefined, changePassword: () => undefined })
/** Inside the gate: the console username, "Lock console" and "Change console password". */
export const useConsole = () => useContext(Ctx)

function Box({ title, sub, children }: { title: string; sub: ReactNode; children: ReactNode }) {
  return (
    <div className="max-w-sm mx-auto px-4 py-14">
      <div className="card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-accent/15 text-accent grid place-items-center shrink-0" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          </span>
          <h1 className="font-display text-xl font-extrabold text-ink">{title}</h1>
        </div>
        <div className="text-sm text-muted">{sub}</div>
        {children}
      </div>
    </div>
  )
}
const Err = ({ e }: { e: string | null }) => (e ? <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{e}</div> : null)

export default function ConsoleGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()
  const [st, setSt] = useState<Status | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const [mode, setMode] = useState<'normal' | 'reset' | 'change'>('normal')
  const [username, setUsername] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [cur, setCur] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // fix258: only the server's own answer decides — a start-up { pending: true } (202), a restarting worker (5xx) or an
  // answer without hasLogin is asked again, never read as "no console login yet"
  const load = useCallback(function again(n = 0): Promise<void> {
    const retry = (e?: unknown) => { if (n < 20) setTimeout(() => void again(n + 1), 1500); else setFail(e ? errorText(e) : 'The console did not answer. Reload the page.') }
    return axios.get(`${API_URL}/crm/console/status`).then(r => {
      const d = r.data?.data
      if (r.status === 202 || typeof d?.hasLogin !== 'boolean') return retry()
      setSt(d); setFail(null)
    }).catch(e => ((e?.response?.status ?? 500) >= 500 ? retry(e) : setFail(errorText(e))))
  }, [])
  useEffect(() => { if (user) load() }, [user?.id, load])
  // the server locked the console (sign-in elsewhere, password set by a manager): show the gate again
  useEffect(() => {
    const id = axios.interceptors.response.use(undefined, err => {
      if (err?.response?.status === 423 && err?.response?.data?.console) load()
      return Promise.reject(err)
    })
    return () => axios.interceptors.response.eject(id)
  }, [load])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null); setInfo(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const clear = () => { setPw(''); setPw2(''); setCur(''); setCode('') }
  const lock = () => { axios.post(`${API_URL}/crm/console/lock`).finally(() => { clear(); setMode('normal'); load() }) }
  const changePassword = () => { clear(); setError(null); setInfo(null); setMode('change') }

  if (loading || (user && !st && !fail)) return null
  if (!user || fail) return <>{children}</> // the page itself explains (sign in / staff only / two-step needed)
  const s = st!

  const newPwFields = (label: string) => (
    <>
      <input className={input} type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder={label} autoComplete="new-password" minLength={10} required />
      <input className={input} type="password" value={pw2} onChange={e => setPw2(e.target.value)} placeholder="Repeat it" autoComplete="new-password" required />
      <p className="text-[11px] text-faint">At least 10 characters. It must be different from your account password.</p>
    </>
  )
  const same = () => { if (pw !== pw2) throw { response: { data: { error: 'The two passwords are not the same.' } } } }

  // change the console password (required after a manager set it, or chosen from the CRM header)
  if (s.unlocked && (s.mustChange || mode === 'change')) {
    const submit = (e: FormEvent) => { e.preventDefault(); run(async () => {
      same()
      await axios.post(`${API_URL}/crm/console/change`, { current: cur, next: pw })
      clear(); setMode('normal'); await load()
    }) }
    return (
      <Box title="New console password" sub={s.mustChange ? 'Your console password was set by a manager. Choose your own before you continue.' : <>Signed in to the console as <b className="text-ink">{s.username}</b>.</>}>
        <form onSubmit={submit} className="space-y-3">
          <input className={input} type="password" value={cur} onChange={e => setCur(e.target.value)} placeholder="Current console password" autoComplete="current-password" required />
          {newPwFields('New console password')}
          <Err e={error} />
          <button type="submit" disabled={busy} className={btn}>{busy ? 'Saving…' : 'Save new password'}</button>
          {!s.mustChange && <button type="button" onClick={() => setMode('normal')} className="w-full text-sm text-muted">Cancel</button>}
        </form>
      </Box>
    )
  }

  if (s.unlocked) return <Ctx.Provider value={{ username: s.username, lock, changePassword }}>{children}</Ctx.Provider>

  // no console login yet
  if (!s.hasLogin) {
    if (!s.isAdmin)
      return (
        <Box title="Staff console" sub="You don’t have a console login yet. Ask your manager to set one for you in CRM → Team & roles.">
          <></>
        </Box>
      )
    const submit = (e: FormEvent) => { e.preventDefault(); run(async () => {
      same()
      await axios.post(`${API_URL}/crm/console/setup`, { username, password: pw })
      clear(); await load()
    }) }
    return (
      <Box title="Create your console login" sub="The CRM and Users ask for this once after every sign-in. Choose a username and a password that is different from your account password.">
        <form onSubmit={submit} className="space-y-3">
          <input className={input} value={username} onChange={e => setUsername(e.target.value)} placeholder="Console username" autoCapitalize="none" spellCheck={false} autoComplete="username" required />
          {newPwFields('Console password')}
          <Err e={error} />
          <button type="submit" disabled={busy} className={btn}>{busy ? 'Saving…' : 'Create and continue'}</button>
        </form>
      </Box>
    )
  }

  // admin forgot their console login: account password + two-step code
  if (mode === 'reset') {
    const submit = (e: FormEvent) => { e.preventDefault(); run(async () => {
      await axios.post(`${API_URL}/crm/console/reset`, { password: pw, code })
      clear(); setMode('normal'); await load()
    }) }
    return (
      <Box title="Reset console login" sub="Confirm with your account password and a code from your authenticator app. Then you choose a new console login.">
        <form onSubmit={submit} className="space-y-3">
          <input className={input} type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Account password" autoComplete="current-password" required />
          <input className={`${input} text-center num tracking-[0.3em]`} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" required />
          <Err e={error} />
          <button type="submit" disabled={busy || code.length !== 6} className={btn}>{busy ? 'Checking…' : 'Reset'}</button>
          <button type="button" onClick={() => { clear(); setMode('normal') }} className="w-full text-sm text-muted">Back</button>
        </form>
      </Box>
    )
  }

  const submit = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const r = await axios.post(`${API_URL}/crm/console/login`, { username, password: pw })
    if (r.data.data.mustChange) setCur(pw)
    setPw(''); await load()
  }) }
  return (
    <Box title="Staff console" sub="Sign in with your console username and password (not your account password). Your manager gives you these.">
      <form onSubmit={submit} className="space-y-3">
        <input className={input} value={username} onChange={e => setUsername(e.target.value)} placeholder="Console username" autoCapitalize="none" spellCheck={false} autoComplete="username" required autoFocus />
        <input className={input} type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Console password" autoComplete="current-password" required />
        <Err e={error} />
        {info && <div className="text-sm text-win">{info}</div>}
        <button type="submit" disabled={busy} className={btn}>{busy ? 'Checking…' : 'Open'}</button>
        <p className="text-[11px] text-faint text-center">
          {s.isAdmin
            ? <button type="button" onClick={() => { clear(); setError(null); setMode('reset') }} className="underline">Forgot your console login?</button>
            : 'Forgot it? Ask your manager to reset it.'}
        </p>
      </form>
    </Box>
  )
}

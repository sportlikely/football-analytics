import { useEffect, useState, type FormEvent } from 'react'
import axios from 'axios'
import QRCode from 'qrcode'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { t, LOCALE } from '../lib/i18n'

const input =
  'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

/** Sign-in step 2: the 6-digit code from the authenticator app (or a recovery code). */
export function TwoFactorStep({ ticket, onDone, onCancel }: { ticket: string; onDone: () => void; onCancel: () => void }) {
  const { loginCode } = useAuth()
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await loginCode(ticket, code)
      onDone()
    } catch (err) {
      setError(errorText(err))
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-xl bg-accent/15 text-accent grid place-items-center shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        </span>
        <p className="text-sm text-muted">
          {recovery ? t("Enter one of your recovery codes. Each code works once.") : t("Open your authenticator app and enter the 6-digit code for SportLikely.")}
        </p>
      </div>
      {recovery ? (
        <input className={input} value={code} onChange={e => setCode(e.target.value)} placeholder="xxxxx-xxxxx" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus aria-label={t("Recovery code")} />
      ) : (
        <input
          className="w-full rounded-xl border border-line bg-surface2/60 px-4 py-3 text-center num text-3xl tracking-[0.45em] text-ink placeholder:text-faint/60 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          value={code}
          onChange={e => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 6)
            setCode(v)
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          autoFocus
          aria-label={t("6-digit code")}
        />
      )}
      {error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>}
      <button type="submit" disabled={busy || (recovery ? code.trim().length < 8 : code.length !== 6)} className="w-full rounded-xl bg-accent text-bg font-semibold py-2.5 text-sm disabled:opacity-60">
        {busy ? t("Checking…") : t("Sign in")}
      </button>
      <div className="flex items-center justify-between text-xs">
        <button type="button" onClick={() => { setRecovery(v => !v); setCode(''); setError(null) }} className="text-accent font-medium">
          {recovery ? t("Use the app code instead") : t("Lost your phone? Use a recovery code")}
        </button>
        <button type="button" onClick={onCancel} className="text-muted hover:text-ink">{t("Back")}</button>
      </div>
    </form>
  )
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  const text = `SportLikely recovery codes (each works once)\n\n${codes.join('\n')}\n`
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    a.download = 'sportlikely-recovery-codes.txt'
    a.click()
    URL.revokeObjectURL(a.href)
    setSaved(true)
  }
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-draw/40 bg-draw/10 px-3 py-2 text-sm text-ink">
        {t("Save these recovery codes somewhere safe (not on the same phone). If you lose your phone, each code lets you sign in once. They are shown only now.")}
      </div>
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-surface2/60 border border-line p-3 num text-sm text-ink">
        {codes.map(c => <span key={c} className="text-center">{c}</span>)}
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={download} className="rounded-xl bg-surface2 border border-line px-3 py-2 text-sm font-semibold text-ink">{t("Download")}</button>
        <button type="button" onClick={() => { navigator.clipboard?.writeText(text).then(() => setSaved(true)).catch(() => undefined) }} className="rounded-xl bg-surface2 border border-line px-3 py-2 text-sm font-semibold text-ink">{t("Copy")}</button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} className="w-4 h-4 accent-[rgb(var(--accent))]" />
        {t("I saved my recovery codes")}
      </label>
      <button type="button" disabled={!saved} onClick={onDone} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-50">{t("Done")}</button>
    </div>
  )
}

function QrBlock({ setup }: { setup: { secret: string; otpauth: string; qr?: string } }) {
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      {setup.qr && <img src={setup.qr} alt={t("QR code for your authenticator app")} className="w-[200px] h-[200px] rounded-xl bg-white p-2" />}
      <div className="text-sm space-y-2 min-w-0">
        <div className="label">{t("Setup key")}</div>
        <div className="num text-ink break-all select-all bg-surface2/60 border border-line rounded-xl px-3 py-2">{setup.secret.match(/.{1,4}/g)?.join(' ')}</div>
        <a href={setup.otpauth} className="inline-block text-accent font-semibold sm:hidden">{t("Open in authenticator app")}</a>
      </div>
    </div>
  )
}

interface Status { enabled: boolean; enabledAt: string | null; recoveryLeft: number; adminRequired: boolean }

/** Account page: switch two-step login on / off, new recovery codes. */
export function TwoFactorCard() {
  const { user, refresh } = useAuth()
  const [st, setSt] = useState<Status | null>(null)
  const [mode, setMode] = useState<'idle' | 'password' | 'scan' | 'codes' | 'off' | 'newcodes' | 'device' | 'deviceScan'>('idle')
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<{ secret: string; otpauth: string; qr?: string } | null>(null)
  const [codes, setCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => axios.get(`${API_URL}/auth/2fa`).then(r => setSt(r.data.data)).catch(() => setSt(null))
  useEffect(() => { load() }, [])
  const reset = () => { setMode('idle'); setPw(''); setCode(''); setSetup(null); setError(null) }
  const run = async (fn: () => Promise<void>) => {
    setError(null); setBusy(true)
    try { await fn() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  const start = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const r = await axios.post(`${API_URL}/auth/2fa/setup`, { password: pw })
    const d = r.data.data as { secret: string; otpauth: string }
    let qr: string | undefined
    try { qr = await QRCode.toDataURL(d.otpauth, { margin: 1, width: 220, errorCorrectionLevel: 'M' }) } catch { /* the key below still works */ }
    setSetup({ ...d, qr }); setPw(''); setMode('scan')
  }) }
  const confirm = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const r = await axios.post(`${API_URL}/auth/2fa/confirm`, { code })
    setCodes(r.data.data.recoveryCodes); setCode(''); setMode('codes')
  }) }
  const turnOff = (e: FormEvent) => { e.preventDefault(); run(async () => {
    await axios.post(`${API_URL}/auth/2fa/disable`, { password: pw, code })
    reset(); await load(); await refresh()
  }) }
  const addDevice = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const r = await axios.post(`${API_URL}/auth/2fa/device`, { password: pw, code })
    const d = r.data.data as { secret: string; otpauth: string }
    let qr: string | undefined
    try { qr = await QRCode.toDataURL(d.otpauth, { margin: 1, width: 220, errorCorrectionLevel: 'M' }) } catch { /* the key still works */ }
    setSetup({ ...d, qr }); setPw(''); setCode(''); setMode('deviceScan')
  }) }
  const newCodes = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const r = await axios.post(`${API_URL}/auth/2fa/recovery`, { code })
    setCodes(r.data.data.recoveryCodes); setCode(''); setMode('codes')
  }) }

  if (!user || !st) return null
  const codeInput = (
    <input className={`${input} num tracking-widest`} value={code} onChange={e => setCode(e.target.value.slice(0, 20))} placeholder={t("6-digit code")} inputMode="text" autoComplete="one-time-code" aria-label={t("6-digit code")} />
  )
  const err = error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>

  return (
    <div className="card p-6 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display font-bold text-ink">{t("Two-step login")}</div>
          <p className="text-sm text-muted mt-0.5">{t("After your password, a 6-digit code from an app on your phone. A stolen password alone is then not enough.")}</p>
        </div>
        <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-bold ${st.enabled ? 'bg-win/15 text-win' : 'bg-surface2 text-muted'}`}>{st.enabled ? t("On") : t("Off")}</span>
      </div>

      {mode === 'codes' ? (
        <RecoveryCodes codes={codes} onDone={async () => { reset(); setCodes([]); await load(); await refresh() }} />
      ) : !st.enabled ? (
        mode === 'idle' ? (
          <button type="button" onClick={() => setMode('password')} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">{t("Set up two-step login")}</button>
        ) : mode === 'password' ? (
          <form onSubmit={start} className="space-y-3">
            <p className="text-sm text-muted">{t("You need an authenticator app on your phone, for example Google Authenticator or Microsoft Authenticator. First, confirm your password.")}</p>
            <input className={input} type="password" required value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" placeholder={t("Password")} aria-label={t("Password")} />
            {err}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || !pw} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{busy ? t("Please wait…") : t("Continue")}</button>
              <button type="button" onClick={reset} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
            </div>
          </form>
        ) : setup ? (
          <form onSubmit={confirm} className="space-y-4">
            <ol className="text-sm text-muted space-y-1 list-decimal ps-5">
              <li>{t("In your authenticator app, tap + and choose \"Scan a QR code\".")}</li>
              <li>{t("Scan this code (or type the setup key below).")}</li>
              <li>{t("Enter the 6-digit code the app shows for SportLikely.")}</li>
            </ol>
            <QrBlock setup={setup} />
            <input
              className="w-full max-w-[220px] rounded-xl border border-line bg-surface2/60 px-4 py-2.5 text-center num text-2xl tracking-[0.4em] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" aria-label={t("6-digit code")}
            />
            {err}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || code.length !== 6} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{busy ? t("Checking…") : t("Turn on")}</button>
              <button type="button" onClick={reset} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
            </div>
            <p className="text-[11px] text-faint">{t("Turning it on signs you out on every other device.")}</p>
          </form>
        ) : null
      ) : mode === 'off' ? (
        <form onSubmit={turnOff} className="space-y-3">
          <p className="text-sm text-muted">{t("To switch it off, confirm your password and a code from your app (or a recovery code).")}</p>
          <input className={input} type="password" required value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" placeholder={t("Password")} aria-label={t("Password")} />
          {codeInput}
          {err}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !pw || code.trim().length < 6} className="rounded-xl bg-loss/90 text-white font-semibold px-4 py-2 text-sm disabled:opacity-60">{t("Switch off")}</button>
            <button type="button" onClick={reset} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
          </div>
        </form>
      ) : mode === 'device' ? (
        <form onSubmit={addDevice} className="space-y-3">
          <p className="text-sm text-muted">{t("Add a second phone or tablet: both will show the same codes. Confirm your password and a code from your current app.")}</p>
          <input className={input} type="password" required value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" placeholder={t("Password")} aria-label={t("Password")} />
          {codeInput}
          {err}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !pw || code.trim().length < 6} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{t("Continue")}</button>
            <button type="button" onClick={reset} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
          </div>
        </form>
      ) : mode === 'deviceScan' && setup ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">{t("On the other device, open your authenticator app, tap + and scan this code (or type the setup key). Both devices will then show the same 6-digit codes.")}</p>
          <QrBlock setup={setup} />
          <button type="button" onClick={reset} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm">{t("Done")}</button>
        </div>
      ) : mode === 'newcodes' ? (
        <form onSubmit={newCodes} className="space-y-3">
          <p className="text-sm text-muted">{t("New recovery codes replace the old ones. Enter a code from your app to continue.")}</p>
          {codeInput}
          {err}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.trim().length < 6} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{t("Get new codes")}</button>
            <button type="button" onClick={reset} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {t("On since {0}. Recovery codes left: {1}.", { 0: st.enabledAt ? new Date(st.enabledAt).toLocaleDateString(LOCALE) : '–', 1: st.recoveryLeft })}
          </p>
          <div className="flex flex-wrap gap-3 text-sm">
            <button type="button" onClick={() => setMode('device')} className="font-semibold text-accent">{t("Add another device")}</button>
            <button type="button" onClick={() => setMode('newcodes')} className="font-semibold text-accent">{t("New recovery codes")}</button>
            {!(user.isAdmin && st.adminRequired) && (
              <button type="button" onClick={() => setMode('off')} className="text-muted hover:text-loss">{t("Switch off")}</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

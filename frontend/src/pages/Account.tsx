import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { useGuessFirst } from '../lib/reveal'
import { useUnlocks, resetDay } from '../lib/unlocks'
import { t, LOCALE } from '../lib/i18n'
import { TwoFactorCard } from '../components/TwoFactor'

function fmtDay(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

export default function Account() {
  const { user, access, loading, logout, needsVerification, setOptIn } = useAuth()
  const unlocks = useUnlocks(access === 'premium' || access === 'free')
  const nav = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [guessFirst, setGuessFirst] = useGuessFirst()

  useEffect(() => {
    if (!loading && !user) nav('/login?next=/account', { replace: true })
  }, [loading, user, nav])
  if (!user) return null

  const changePw = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    setBusy(true)
    try {
      await axios.post(`${API_URL}/auth/password`, { current, next })
      setCurrent('')
      setNext('')
      setMsg({ ok: true, text: t("Password changed. Other devices were signed out.") })
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'
  const planLabel = access === 'admin' ? t("Admin (full access)") : user.plan === 'pro' ? 'Pro' : user.plan === 'premium' ? 'Premium' : 'Free'

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">{t("Account")}</h1>
        <p className="text-sm text-muted">{user.email}</p>
      </div>

      <div className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="label">{t("Plan")}</div>
            <div className="font-display text-xl font-bold text-ink mt-0.5">{planLabel}</div>
            {user.plan !== 'free' && user.premiumUntil && <div className="text-xs text-muted mt-0.5">{t("Until")}{' '}{fmtDay(user.premiumUntil)}</div>}
            {access === 'premium' && unlocks && unlocks.left !== null && (
              <div className="text-xs text-ink mt-1">
                {t("{0} of {1} unlocks left this month · renews {2}", { 0: unlocks.left, 1: unlocks.allowance, 2: resetDay(unlocks.resetsAt) })}
              </div>
            )}
            {(access === 'free' || access === 'premium') && unlocks && (
              <div className="text-xs text-ink mt-1">{t("Pick packs: {0} picks left", { 0: unlocks.credits ?? 0 })} · <Link to="/premium#packs" className="font-semibold text-accent">{t("Buy picks")}</Link></div>
            )}
            <div className="text-xs text-faint mt-0.5">{t("Member since")}{' '}{fmtDay(user.createdAt)}</div>
            {needsVerification && (
              <Link to="/verify?next=/account" className="text-xs font-semibold text-draw mt-1 inline-block">
                {t("Email not confirmed — enter code →")}</Link>
            )}
          </div>
          {(access === 'free' || access === 'premium') && !user.cancelAt && (
            <Link to="/premium" className="px-4 py-2 rounded-xl bg-accent text-bg text-sm font-semibold">
              {access === 'premium' ? t("Go Pro: unlimited") : t("See plans")}
            </Link>
          )}
        </div>
        {(access === 'premium' || access === 'pro') && <CancelPlan />}
      </div>

      {(access === 'premium' || access === 'pro' || access === 'admin') && (
        <div className="card p-6">
          <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
            <span>
              <span className="font-display font-bold text-ink block">{t("Guess first")}</span>
              <span className="text-sm text-muted">{t("Hide our prediction on upcoming games until you tap \"Reveal prediction\", so you can make your own call first. Saved on this device.")}</span>
            </span>
            <input type="checkbox" checked={guessFirst} onChange={e => setGuessFirst(e.target.checked)} className="mt-1 w-5 h-5 accent-[rgb(var(--accent))]" />
          </label>
        </div>
      )}

      <div className="card p-6">
        <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
          <span>
            <span className="font-display font-bold text-ink block">{t("Email updates")}</span>
            <span className="text-sm text-muted">{t("New features, Premium news and weekly picks. No spam.")}</span>
          </span>
          <input
            type="checkbox"
            checked={user.marketingOptIn}
            onChange={e => setOptIn(e.target.checked).catch(() => undefined)}
            className="mt-1 w-5 h-5 accent-[rgb(var(--accent))]"
          />
        </label>
      </div>

      <EmailCard />

      <form onSubmit={changePw} className="card p-6 space-y-3">
        <div className="font-display font-bold text-ink">{t("Change password")}</div>
        <label className="block">
          <span className="label">{t("Current password")}</span>
          <input className={`${input} mt-1`} type="password" required value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
        </label>
        <label className="block">
          <span className="label">{t("New password")}</span>
          <input className={`${input} mt-1`} type="password" required minLength={8} value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" />
        </label>
        {msg && (
          <div className={`rounded-xl border px-3 py-2 text-sm ${msg.ok ? 'border-win/40 bg-win/10 text-win' : 'border-loss/40 bg-loss/10 text-loss'}`}>{msg.text}</div>
        )}
        <button type="submit" disabled={busy} className="rounded-xl bg-surface2 border border-line px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60">
          {busy ? t("Saving…") : t("Change password")}
        </button>
      </form>

      <TwoFactorCard />

      <DataCard />

      <button
        onClick={async () => {
          await logout()
          nav('/')
        }}
        className="text-sm text-muted hover:text-loss"
      >
        {t("Sign out")}</button>
    </div>
  )
}

/** Change the account email: password (+ two-step code) → a code to the new address → confirm. */
function EmailCard() {
  const { user, refresh } = useAuth()
  const [step, setStep] = useState<'idle' | 'form' | 'code' | 'done'>('idle')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [code2fa, setCode2fa] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!user) return null
  const input =
    'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'
  const run = async (fn: () => Promise<void>) => {
    setError(null); setBusy(true)
    try { await fn() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }
  const start = (e: FormEvent) => { e.preventDefault(); run(async () => {
    const r = await axios.post(`${API_URL}/auth/email`, { email, password: pw, code: user.twoFactor ? code2fa : undefined })
    setSentTo(r.data.data.sentTo); setPw(''); setCode2fa(''); setStep('code')
  }) }
  const confirm = (e: FormEvent) => { e.preventDefault(); run(async () => {
    await axios.post(`${API_URL}/auth/email/confirm`, { code })
    await refresh(); setCode(''); setEmail(''); setStep('done')
  }) }
  const close = () => { setStep('idle'); setError(null); setPw(''); setCode(''); setCode2fa('') }
  const err = error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>

  return (
    <div className="card p-6 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display font-bold text-ink">{t("Email")}</div>
          <div className="text-sm text-muted truncate">{user.email}</div>
        </div>
        {step === 'idle' && (
          <button type="button" onClick={() => setStep('form')} className="shrink-0 rounded-xl bg-surface2 border border-line px-3 py-1.5 text-sm font-semibold text-ink">{t("Change")}</button>
        )}
      </div>
      {user.isAdmin && step === 'idle' && <p className="text-[11px] text-faint">Admin account: add the new address to ADMIN_EMAILS in Railway first (keep the old one too), then change it here.</p>}
      {step === 'form' && (
        <form onSubmit={start} className="space-y-3">
          <label className="block">
            <span className="label">{t("New email")}</span>
            <input className={`${input} mt-1`} type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </label>
          <label className="block">
            <span className="label">{t("Password")}</span>
            <input className={`${input} mt-1`} type="password" required value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
          </label>
          {user.twoFactor && (
            <label className="block">
              <span className="label">{t("6-digit code")}</span>
              <input className={`${input} mt-1 num tracking-widest`} value={code2fa} onChange={e => setCode2fa(e.target.value.slice(0, 20))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" />
            </label>
          )}
          {err}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{busy ? t("Please wait…") : t("Send code to the new email")}</button>
            <button type="button" onClick={close} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
          </div>
        </form>
      )}
      {step === 'code' && (
        <form onSubmit={confirm} className="space-y-3">
          <p className="text-sm text-muted">{t("We sent a 6-digit code to {0}. It’s valid for 10 minutes. Check spam if you don’t see it.", { 0: sentTo })}</p>
          <input
            className="w-full max-w-[220px] rounded-xl border border-line bg-surface2/60 px-4 py-2.5 text-center num text-2xl tracking-[0.4em] text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
            value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" aria-label={t("6-digit code")}
          />
          {err}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.length !== 6} className="rounded-xl bg-accent text-bg font-semibold px-4 py-2 text-sm disabled:opacity-60">{busy ? t("Checking…") : t("Confirm")}</button>
            <button type="button" onClick={close} className="rounded-xl px-4 py-2 text-sm text-muted">{t("Cancel")}</button>
          </div>
        </form>
      )}
      {step === 'done' && (
        <div className="rounded-xl border border-win/40 bg-win/10 px-3 py-2 text-sm text-win">
          {t("Your email is now {0}. We sent a notice to your old address.", { 0: user.email })}
        </div>
      )}
    </div>
  )
}

/** Your data (GDPR): download everything we hold, or delete the account. */
function DataCard() {
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const del = async (e: FormEvent) => {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      await axios.post(`${API_URL}/auth/delete`, { password: pw, confirm, reason: reason || 'other', details })
      window.location.href = '/'
    } catch (x) {
      setErr(errorText(x))
      setBusy(false)
    }
  }
  const input = 'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-loss focus:ring-2 focus:ring-loss/20'
  return (
    <div className="card p-6 space-y-4">
      <div>
        <div className="font-display font-bold text-ink">{t("Your data")}</div>
        <p className="text-sm text-muted mt-0.5">{t("Download a copy of everything we store about your account, or delete the account and all of it.")}{' '}
          <Link to="/privacy" className="text-accent hover:underline">{t("Privacy policy")}</Link>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={`${API_URL}/auth/export`} className="rounded-xl bg-surface2 border border-line px-4 py-2 text-sm font-semibold text-ink hover:border-faint">{t("Download my data")}</a>
      </div>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} className="block text-[11px] text-faint hover:text-loss underline-offset-2 hover:underline">{t("Delete account")}</button>
      )}
      {open && (
        <form onSubmit={del} className="rounded-xl border border-loss/40 bg-loss/5 p-4 space-y-3">
          <p className="text-sm text-ink">{t("This deletes your account, favorites, unlocked matches and unused pack picks for good. It cannot be undone. Paid plans are not refunded automatically: write to us first if you want a refund.")}</p>
          <ReasonPicker value={reason} onChange={setReason} details={details} onDetails={setDetails} />
          <label className="block">
            <span className="label">{t("Password")}</span>
            <input className={`${input} mt-1`} type="password" required value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="block">
            <span className="label">{t("Type DELETE to confirm")}</span>
            <input className={`${input} mt-1`} required value={confirm} onChange={e => setConfirm(e.target.value)} />
          </label>
          {err && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{err}</div>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || confirm !== 'DELETE' || !pw} className="rounded-xl bg-loss text-bg px-4 py-2 text-sm font-bold disabled:opacity-50">{busy ? t("Deleting…") : t("Delete my account")}</button>
            <button type="button" onClick={() => { setOpen(false); setPw(''); setConfirm(''); setErr(null) }} className="rounded-xl px-4 py-2 text-sm text-muted hover:text-ink">{t("Cancel")}</button>
          </div>
        </form>
      )}
    </div>
  )
}

const REASONS: [string, string][] = [
  ['too_expensive', t('It is too expensive')],
  ['not_accurate', t('The predictions were not accurate enough')],
  ['not_using', t('I don’t use it enough')],
  ['missing_feature', t('A feature or sport I need is missing')],
  ['other_service', t('I found another service')],
  ['technical', t('Technical problems')],
  ['other', t('Something else')]
]

/** Why are you leaving? A required choice plus an optional comment. */
function ReasonPicker({ value, onChange, details, onDetails }: { value: string; onChange: (v: string) => void; details: string; onDetails: (v: string) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-ink mb-1">{t('Why are you leaving?')}</legend>
      {REASONS.map(([k, label]) => (
        <label key={k} className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm cursor-pointer ${value === k ? 'border-accent/60 bg-accent/10 text-ink' : 'border-line/60 text-muted hover:text-ink'}`}>
          <input type="radio" name="reason" value={k} checked={value === k} onChange={() => onChange(k)} className="accent-[rgb(var(--accent))]" />
          {label}
        </label>
      ))}
      <textarea value={details} onChange={e => onDetails(e.target.value)} maxLength={1000} rows={3} placeholder={t('Anything else you want to tell us? (optional)')}
        className="w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink outline-none focus:border-accent" />
    </fieldset>
  )
}

/** Cancel a paid plan: asks why, keeps the plan until the end of the period; can be undone. */
function CancelPlan() {
  const { user, refresh } = useAuth()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!user) return null
  const until = user.premiumUntil ? fmtDay(user.premiumUntil) : null
  const post = async (url: string, body: object) => {
    setErr(null); setBusy(true)
    try { await axios.post(`${API_URL}${url}`, body); await refresh(); setOpen(false) } catch (x) { setErr(errorText(x)) } finally { setBusy(false) }
  }
  if (user.cancelAt) {
    return (
      <div className="mt-4 rounded-xl border border-draw/40 bg-draw/10 px-4 py-3 text-sm text-ink flex flex-wrap items-center justify-between gap-2">
        <span>{until ? t('Cancelled: your plan stays active until {0} and will not renew.', { 0: until }) : t('Cancelled: your plan will not renew.')}</span>
        <button type="button" disabled={busy} onClick={() => post('/auth/cancel/undo', {})} className="rounded-lg bg-accent text-bg px-3 py-1.5 text-xs font-bold">{t('Keep my plan')}</button>
      </div>
    )
  }
  return (
    <div className="mt-4">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-faint hover:text-ink underline-offset-2 hover:underline">{t('Cancel subscription')}</button>
      ) : (
        <form onSubmit={e => { e.preventDefault(); post('/auth/cancel', { reason, details }) }} className="rounded-xl border border-line/60 bg-surface2/40 p-4 space-y-3">
          <p className="text-sm text-ink">{until ? t('Your plan stays active until {0}. After that it will not renew.', { 0: until }) : t('Your plan will not renew.')}</p>
          <ReasonPicker value={reason} onChange={setReason} details={details} onDetails={setDetails} />
          {err && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{err}</div>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl bg-accent text-bg px-4 py-2 text-sm font-bold">{t('Keep my plan')}</button>
            <button type="submit" disabled={busy || !reason} className="rounded-xl border border-line px-4 py-2 text-sm text-muted hover:text-loss disabled:opacity-50">{t('Cancel subscription')}</button>
          </div>
        </form>
      )}
    </div>
  )
}

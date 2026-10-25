import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { errorText, useAuth } from '../lib/auth'
import { safeNext } from '../lib/nav'
import { t, lang } from '../lib/i18n'
import { browserTz } from '../components/EmailsCard'
import { TwoFactorStep } from '../components/TwoFactor'
import Turnstile, { useTurnstileKey } from '../components/Turnstile'
import axios from 'axios'
import { API_URL } from '../lib/socket'

/** Sign in and create account on one page: /login and /signup. */
export default function Login({ mode: initial }: { mode: 'login' | 'signup' }) {
  const { login, signup, user, needsVerification } = useAuth()
  const nav = useNavigate()
  const loc = useLocation()
  const next = safeNext(new URLSearchParams(loc.search).get('next'))
  const [mode, setMode] = useState(initial)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [optIn, setOptIn] = useState(false)
  const [picksOptIn, setPicksOptIn] = useState(false) // fix216: daily picks + weekly digest, off unless ticked
  const [adult, setAdult] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ticket, setTicket] = useState<string | null>(null) // password OK, two-step code still needed
  // fix168: bot checks — the hidden field, the signed "form shown at" token, Cloudflare Turnstile (when it is on)
  const [website, setWebsite] = useState('')
  const [formToken, setFormToken] = useState<string | null>(null)
  const [cfToken, setCfToken] = useState('')
  const [cfKey, setCfKey] = useState(0) // a Turnstile token works once: a new widget after a failed try
  const [needCheck, setNeedCheck] = useState(false) // login: after 3 failed attempts the server asks for it
  const siteKey = useTurnstileKey()
  useEffect(() => {
    if (mode !== 'signup') return
    axios.get(`${API_URL}/auth/signup-token`).then(r => setFormToken(r.data?.token || null)).catch(() => setFormToken(null))
  }, [mode])
  const showCheck = !!siteKey && (mode === 'signup' || needCheck)

  useEffect(() => setMode(initial), [initial])
  useEffect(() => {
    if (!user) return
    const target = next
    if (needsVerification) nav(`/verify?next=${encodeURIComponent(target)}`, { replace: true })
    else nav(target, { replace: true })
  }, [user, needsVerification, next, nav])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'signup' && password.length < 8) return setError(t("Password must be at least 8 characters."))
    if (mode === 'signup' && !adult) return setError(t("Please confirm you are 18 or older and accept the terms."))
    setBusy(true)
    try {
      const guard = { website, formToken, turnstile: cfToken || null }
      if (mode === 'login') {
        const step = await login(email, password, guard)
        if (step.ticket) { setTicket(step.ticket); setPassword('') }
      } else await signup(email, password, name, optIn, adult, guard, { picksOptIn, tz: browserTz(), lang })
    } catch (err: any) {
      if (err?.response?.data?.captcha) setNeedCheck(true)
      setCfToken(''); setCfKey(k => k + 1)
      // a fresh form token for the next try (the old one stays valid, but a stale page may have kept one past its hour)
      if (mode === 'signup') axios.get(`${API_URL}/auth/signup-token`).then(r => setFormToken(r.data?.token || null)).catch(() => undefined)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-12 sm:py-16">
      <div className="card p-6 sm:p-8">
        {ticket ? (
          <>
            <h1 className="font-display text-2xl font-extrabold text-ink">{t("Two-step login")}</h1>
            <TwoFactorStep ticket={ticket} onDone={() => setTicket(null)} onCancel={() => setTicket(null)} />
          </>
        ) : (
        <>
        <h1 className="font-display text-2xl font-extrabold text-ink">{mode === 'login' ? t("Sign in") : t("Create your account")}</h1>
        <p className="text-sm text-muted mt-1">
          {mode === 'login' ? t("Welcome back.") : t("Free account: every match, live scores, the model’s pick and 2 full predictions a week.")}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-3">
          {mode === 'signup' && (
            <label className="block">
              <span className="label">{t("Name (optional)")}</span>
              <input className={`${input} mt-1`} value={name} onChange={e => setName(e.target.value)} autoComplete="name" autoCapitalize="words" maxLength={80} />
            </label>
          )}
          <label className="block">
            <span className="label">{t("Email")}</span>
            <input
              className={`${input} mt-1`}
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="label">{t("Password")}</span>
            <div className="relative mt-1">
              <input
                className={`${input} pr-16`}
                type={showPw ? 'text' : 'password'}
                required
                minLength={mode === 'signup' ? 8 : undefined}
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                aria-pressed={showPw}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-muted hover:text-ink"
              >
                {showPw ? t("Hide") : t("Show")}
              </button>
            </div>
            {mode === 'signup' && <span className="text-[11px] text-faint">{t("At least 8 characters.")}</span>}
          </label>

          {mode === 'signup' && (
            <label className="flex items-start gap-2.5 text-sm text-muted cursor-pointer select-none">
              <input type="checkbox" checked={optIn} onChange={e => setOptIn(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-[rgb(var(--accent))]" />
              <span>{t("Email me about new features, Premium and weekly picks. You can turn this off anytime.")}</span>
            </label>
          )}

          {mode === 'signup' && (
            <label className="flex items-start gap-2.5 text-sm text-muted cursor-pointer select-none">
              <input type="checkbox" checked={picksOptIn} onChange={e => setPicksOptIn(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-[rgb(var(--accent))]" />
              <span>{t("Send me today's strongest picks each morning and a weekly digest. You can turn this off anytime.")}</span>
            </label>
          )}

          {mode === 'signup' && (
            <label className="flex items-start gap-2.5 text-sm text-muted cursor-pointer select-none">
              <input type="checkbox" required checked={adult} onChange={e => setAdult(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0 accent-[rgb(var(--accent))]" />
              <span>
                {t("I am 18 or older and I accept the")}{' '}
                <Link to="/terms" target="_blank" className="text-accent hover:underline">{t("Terms of use")}</Link>{' '}
                {t("and the")}{' '}
                <Link to="/privacy" target="_blank" className="text-accent hover:underline">{t("Privacy policy")}</Link>.
              </span>
            </label>
          )}

          {/* fix168: hidden from people (off-screen, not focusable); bots fill it */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
            <label>Website<input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></label>
          </div>
          {showCheck && <Turnstile key={cfKey} siteKey={siteKey} onToken={setCfToken} />}

          {error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-accent text-bg font-semibold py-2.5 text-sm disabled:opacity-60 transition-opacity"
          >
            {busy ? t("Please wait…") : mode === 'login' ? t("Sign in") : t("Create account")}
          </button>
        </form>

        <div className="mt-5 text-sm text-muted text-center">
          {mode === 'login' ? (
            <>
              {t("New here?")}{' '}
              <Link to={`/signup${loc.search}`} className="text-accent font-medium">
                {t("Create an account")}</Link>
            </>
          ) : (
            <>
              {t("Already have an account?")}{' '}
              <Link to={`/login${loc.search}`} className="text-accent font-medium">
                {t("Sign in")}</Link>
            </>
          )}
        </div>
        {mode === 'login' && (
          <p className="mt-3 text-xs text-center">
            <Link to="/forgot" className="text-muted hover:text-ink">
              {t("Forgot your password?")}</Link>
          </p>
        )}
        </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { errorText, useAuth } from '../lib/auth'
import { safeNext } from '../lib/nav'
import { t } from '../lib/i18n'
import { TwoFactorStep } from '../components/TwoFactor'
import Turnstile, { useTurnstileKey, type CheckState } from '../components/Turnstile'
import axios from 'axios'
import { API_URL } from '../lib/socket'

/** fix198: what a person can type by mistake — "name@gmail com", "name@gmail", "name@@gmail.com", "name@gmail..com" */
export const emailLooksOk = (e: string) => /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(e.trim())
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

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
  const [adult, setAdult] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ticket, setTicket] = useState<string | null>(null) // password OK, two-step code still needed
  // fix168: bot checks — the hidden field, the signed "form shown at" token, Cloudflare Turnstile (when it is on)
  const [website, setWebsite] = useState('')
  const [formToken, setFormToken] = useState<string | null>(null)
  const tokenAt = useRef(0) // when the form token was given (the server refuses a sign-up sent within 3 s of it)
  const [cfToken, setCfToken] = useState('')
  const [cfKey, setCfKey] = useState(0) // a Turnstile token works once: a new widget after a failed try
  const [needCheck, setNeedCheck] = useState(false) // login: after 3 failed attempts the server asks for it
  const siteKey = useTurnstileKey()
  // fix198: where the security check stands; after 2 widget failures (or a blocked script) the form goes on without it
  // (the server then asks for email confirmation before any free pick and marks the account "Unsure")
  const [check, setCheck] = useState<CheckState>({ state: 'loading' })
  const [checkFails, setCheckFails] = useState(0)
  const [noCaptcha, setNoCaptcha] = useState<string | null>(null)
  const getFormToken = () => axios.get(`${API_URL}/auth/signup-token`).then(r => { setFormToken(r.data?.token || null); tokenAt.current = Date.now() }).catch(() => setFormToken(null))
  useEffect(() => {
    if (mode !== 'signup' && !needCheck) return
    void getFormToken()
  }, [mode, needCheck])
  const showCheck = !!siteKey && (mode === 'signup' || needCheck)
  const checkOn = showCheck && !noCaptcha
  const onCheck = (s: CheckState) => {
    setCheck(s)
    if (s.state !== 'error') return
    const fails = checkFails + 1
    setCheckFails(fails)
    // two failures on this form (the server recorded both) → the sign-up goes on without the check
    if (fails >= 2) setNoCaptcha(`${s.code || 'error'} · ${fails}x`)
  }
  const retryCheck = () => { setCfToken(''); setCheck({ state: 'loading' }); setCfKey(k => k + 1) }
  const waiting = checkOn && !cfToken

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
    if (mode === 'signup' && !emailLooksOk(email)) return setError(t("This email address doesn't look right."))
    if (waiting) return
    setBusy(true)
    try {
      // the form token must be 3 s old (bots are faster): a person who fills the form in under 3 s just waits a moment
      if (mode === 'signup') {
        if (!formToken) await getFormToken()
        const left = 3300 - (Date.now() - tokenAt.current)
        if (left > 0) await wait(left)
      }
      // fix198: no token because the widget failed twice → "fallback", which the server accepts only for a form token it
      // recorded two widget errors for
      const guard = { website, formToken, turnstile: cfToken || (showCheck && noCaptcha ? 'fallback' : null) }
      if (mode === 'login') {
        const step = await login(email, password, guard)
        if (step.ticket) { setTicket(step.ticket); setPassword('') }
      } else await signup(email, password, name, optIn, adult, guard)
    } catch (err: any) {
      const d = err?.response?.data || {}
      if (d.captcha) setNeedCheck(true)
      // fix198: a Turnstile token works once — a new widget; the form token stays (a new one would make a quick retry
      // "too fast"), unless the server says it expired
      if (checkOn || d.captcha) retryCheck()
      // never a new form token after a failed submit (that made the retry "too fast") — except when the server says this
      // one is dead (an hour old / not ours): the only way to recover, and the form waits the 3 s before sending again
      if (mode === 'signup' && d.code === 'form_expired') void getFormToken()
      if (d.code === 'captcha_missing') onCheck({ state: 'error', code: 'no token at the server' })
      setError(
        d.code === 'too_fast' ? t("One moment, then try again.")
          : d.code === 'form_expired' || d.code === 'captcha_refused' ? t("The form timed out, please try again.")
          : d.code === 'captcha_missing' ? null // the check box says what to do
          : d.code === 'bad_email' ? t("This email address doesn't look right.")
          : errorText(err)
      )
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
          {showCheck && !noCaptcha && <Turnstile key={cfKey} siteKey={siteKey} onToken={setCfToken} onState={onCheck} hidden={check.state === 'error'} where={mode} formToken={formToken} />}
          {/* fix198: never the bare "Please try again": what went wrong, what to do, a Retry */}
          {showCheck && !noCaptcha && check.state === 'error' && (
            <div role="alert" className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2.5 text-sm text-ink space-y-2">
              <p>{t("The security check didn't load. Tap Retry.")} <span className="text-muted">{t("If it keeps failing, turn off ad-blockers or open the site in Safari or Chrome.")}</span></p>
              <button type="button" onClick={retryCheck} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-ink hover:border-accent/60">{t("Retry")}</button>
            </div>
          )}
          {showCheck && noCaptcha && mode === 'signup' && (
            <p className="rounded-xl border border-line bg-surface2/60 px-3 py-2 text-xs text-muted">{t("The security check can't run in this browser, so we'll ask you to confirm your email before your free picks.")}</p>
          )}

          {error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>}

          <button
            type="submit"
            disabled={busy || waiting}
            className="w-full rounded-xl bg-accent text-bg font-semibold py-2.5 text-sm disabled:opacity-60 transition-opacity"
          >
            {busy ? t("Please wait…") : waiting && check.state !== 'error' ? (check.state === 'interactive' ? t("Tap the check above") : t("Checking you're human…")) : mode === 'login' ? t("Sign in") : t("Create account")}
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

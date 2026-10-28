import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { t as tt } from '../lib/i18n'

/* Contact us: the message goes to our support inbox; we answer by email. */

const TOPICS: { k: string; label: string }[] = [
  { k: 'question', label: 'A question' },
  { k: 'account', label: 'Account / sign-in' },
  { k: 'billing', label: 'Billing / my plan' },
  { k: 'privacy', label: 'Privacy / my data' },
  { k: 'bug', label: 'Something is broken' },
  { k: 'idea', label: 'Idea / feedback' },
  { k: 'business', label: 'Business / partnership' },
  { k: 'other', label: 'Other' }
]

export default function Contact() {
  const { user } = useAuth()
  const loc = useLocation()
  const params = new URLSearchParams(loc.search)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [topic, setTopic] = useState(TOPICS.some(x => x.k === params.get('topic')) ? params.get('topic')! : 'question')
  const [message, setMessage] = useState('')
  const [website, setWebsite] = useState('') // honeypot, hidden from people
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const startedAt = useRef(Date.now())

  useEffect(() => { document.title = tt("Contact us · SportLikely") }, [])
  useEffect(() => { if (user?.name && !name) setName(user.name) }, [user])

  const input =
    'w-full rounded-xl border border-line bg-surface2/60 px-3.5 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent/20'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (message.trim().length < 10) return setError(tt("Please write a little more (at least 10 characters)."))
    setBusy(true)
    try {
      await axios.post(`${API_URL}/contact`, {
        name, email: user ? undefined : email, topic, message, website, startedAt: startedAt.current, page: params.get('from') || undefined
      })
      setSent(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Contact us")}</h1>
      <p className="text-muted mt-2">
        {tt("Questions, problems, ideas: write to us and we answer by email, usually within 1–2 working days.")}
      </p>

      {sent ? (
        <div className="card p-6 sm:p-8 mt-8 text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-win/15 text-win grid place-items-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12l5 5L20 7" /></svg>
          </div>
          <div className="font-display text-xl font-bold text-ink">{tt("Message sent")}</div>
          <p className="text-sm text-muted">{tt("Thanks! We will reply to {0}.", { 0: user?.email || email })}</p>
          <Link to="/" className="inline-block mt-2 text-sm font-bold text-accent">{tt("Back to home")}</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="card relative p-6 sm:p-8 mt-8 space-y-4">
          <label className="block">
            <span className="label">{tt("Name (optional)")}</span>
            <input className={`${input} mt-1`} value={name} onChange={e => setName(e.target.value)} autoComplete="name" autoCapitalize="words" maxLength={80} />
          </label>
          {user ? (
            <div className="text-sm text-muted">
              {tt("We will reply to")} <span className="text-ink font-semibold">{user.email}</span>
            </div>
          ) : (
            <label className="block">
              <span className="label">{tt("Your email")}</span>
              <input className={`${input} mt-1`} type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>
          )}
          <label className="block">
            <span className="label">{tt("Topic")}</span>
            <select className={`${input} mt-1`} value={topic} onChange={e => setTopic(e.target.value)}>
              {TOPICS.map(x => <option key={x.k} value={x.k}>{tt(x.label)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">{tt("Message")}</span>
            <textarea className={`${input} mt-1 min-h-[150px] resize-y`} required value={message} onChange={e => setMessage(e.target.value)} maxLength={5000} />
            <span className="text-[11px] text-faint">{message.length}/5000</span>
          </label>
          {/* honeypot: hidden from people and screen readers */}
          <div aria-hidden="true" className="absolute -start-[9999px] w-px h-px overflow-hidden">
            <label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={e => setWebsite(e.target.value)} /></label>
          </div>
          {error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</div>}
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-accent text-bg font-semibold py-2.5 text-sm disabled:opacity-60">
            {busy ? tt("Sending…") : tt("Send message")}
          </button>
          <p className="text-[11px] text-faint">
            {tt("We use your message only to answer you. See our")}{' '}
            <Link to="/privacy" className="text-accent hover:underline">{tt("Privacy policy")}</Link>.
          </p>
        </form>
      )}

      <p className="text-xs text-faint mt-6 text-center">
        {tt("Prefer email? Write to")}{' '}
        <a href="mailto:support@sportlikely.com" className="text-accent hover:underline">support@sportlikely.com</a>
      </p>
    </div>
  )
}

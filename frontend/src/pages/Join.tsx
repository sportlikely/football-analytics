import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'

/* Beta tester invite: /join/<code> → free Pro for N days. Signed-in visitors join at once. */

interface Info { valid: boolean; closed: boolean; full: boolean; days: number }
const dateOf = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })

export default function Join() {
  const { code = '' } = useParams()
  const { user, loading, tester, needsVerification, refresh } = useAuth()
  const [info, setInfo] = useState<Info | null | undefined>(undefined)
  const [until, setUntil] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tried = useRef(false)

  useEffect(() => { document.title = tt("You're invited · SportLikely") }, [])
  useEffect(() => {
    axios.get(`${API_URL}/testers/invite/${encodeURIComponent(code)}`).then(r => setInfo(r.data.data)).catch(() => setInfo(null))
  }, [code])
  // signed in: join straight away (once)
  useEffect(() => {
    if (!user || !info?.valid || tester || tried.current) return
    tried.current = true
    axios.post(`${API_URL}/testers/join`, { code })
      .then(async r => { setUntil(r.data.data.until); await refresh() })
      .catch(e => setError(errorText(e)))
  }, [user, info, tester])

  if (loading || info === undefined) return null
  const next = encodeURIComponent(`/join/${code}`)
  const box = (children: ReactNode) => (
    <div className="max-w-lg mx-auto px-4 py-14">
      <div className="card p-6 sm:p-8 space-y-4 text-center">{children}</div>
    </div>
  )
  const done = until || tester?.until

  if (done)
    return box(<>
      <div className="mx-auto w-12 h-12 rounded-2xl bg-accent/15 text-accent grid place-items-center text-2xl" aria-hidden>✓</div>
      <h1 className="font-display text-2xl font-extrabold text-ink">{tt("You're a SportLikely tester")}</h1>
      <p className="text-sm text-muted">{tt("You have Pro until {0}: every prediction in full, draw picks and upset watch.", { 0: dateOf(done) })}</p>
      {needsVerification && (
        <p className="text-sm text-draw font-semibold">{tt("Confirm your email to switch Pro on.")} <Link to="/verify" className="underline">{tt("Confirm now")}</Link></p>
      )}
      <div className="rounded-xl border border-line bg-surface2/50 p-4 text-start text-sm text-ink space-y-1.5">
        <p className="font-semibold">{tt("How to help us")}</p>
        <p className="text-muted">{tt("Use the site like you normally would before and after matches. Whenever something is broken, confusing or missing — or you like something — press the Feedback button at the bottom right of every page. Short is fine.")}</p>
      </div>
      <Link to="/" className="inline-block rounded-xl bg-accent text-bg font-semibold px-5 py-2.5 text-sm">{tt("Start")}</Link>
    </>)

  if (!info || !info.valid)
    return box(<>
      <h1 className="font-display text-2xl font-extrabold text-ink">{tt("This invite link doesn't work")}</h1>
      <p className="text-sm text-muted">{!info ? tt("The link is not valid. Check that you copied all of it.") : info.full ? tt("All places on this invite are taken.") : tt("This invite has been closed.")}</p>
      <Link to="/" className="inline-block text-sm font-semibold text-accent">{tt("Go to SportLikely")} <span aria-hidden className="rtl-flip">→</span></Link>
    </>)

  if (user)
    return box(error ? <>
      <h1 className="font-display text-2xl font-extrabold text-ink">{tt("Couldn't join")}</h1>
      <p className="text-sm text-loss">{error}</p>
    </> : <p className="text-sm text-muted">{tt("Joining…")}</p>)

  return box(<>
    <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-accent">{tt("Beta tester invite")}</div>
    <h1 className="font-display text-3xl font-extrabold text-ink">{tt("Help us test SportLikely")}</h1>
    <p className="text-sm text-muted">{tt("Get Pro free for {0} days — every prediction in full, draw picks and upset watch. No card needed. In return, tell us what works and what doesn't.", { 0: info.days })}</p>
    <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
      <Link to={`/signup?next=${next}`} className="rounded-xl bg-accent text-bg font-semibold px-5 py-2.5 text-sm">{tt("Create a free account")}</Link>
      <Link to={`/login?next=${next}`} className="rounded-xl border border-line text-ink font-semibold px-5 py-2.5 text-sm">{tt("I already have an account")}</Link>
    </div>
  </>)
}

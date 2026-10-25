import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText, useAuth } from '../lib/auth'
import { refreshUnlocks, useUnlocks, resetDay, money, type Pack } from '../lib/unlocks'
import PickPacks from '../components/PickPacks'
import { t } from '../lib/i18n'
import { useSectionPath } from '../lib/tabPath'

/**
 * Plans (fix147): Free · Premium $8.99 (60 match unlocks a month) · Pro $14.99 (unlimited + draw alerts); each also for
 * 6 months (10% off) and a year (20% off) — a Monthly / 6 months / Yearly toggle, monthly first. Pick packs for Free and Premium.
 * Pro sits in the middle and is marked "Most popular". While the backend runs with BILLING_TEST_MODE=1 the buttons
 * switch the plan straight away (test checkout); otherwise they say payments open soon.
 */

type Period = 'month' | '6 months' | 'year'
interface PlanRow { id: string; plan?: string; name: string; price: number; period: string; perMonth: number; save: number }
/** Shown until /billing/plans answers (the same numbers as the server). */
const PLAN_DEFAULTS: PlanRow[] = [
  { id: 'premium', name: 'Premium', price: 8.99, period: 'month', perMonth: 8.99, save: 0 }, { id: 'premium-6m', plan: 'premium', name: 'Premium 6 months', price: 48.49, period: '6 months', perMonth: 8.08, save: 10 },
  { id: 'premium-year', plan: 'premium', name: 'Premium yearly', price: 86.29, period: 'year', perMonth: 7.19, save: 20 }, { id: 'pro', name: 'Pro', price: 14.99, period: 'month', perMonth: 14.99, save: 0 },
  { id: 'pro-6m', plan: 'pro', name: 'Pro 6 months', price: 80.99, period: '6 months', perMonth: 13.5, save: 10 }, { id: 'pro-year', plan: 'pro', name: 'Pro yearly', price: 143.99, period: 'year', perMonth: 12, save: 20 }
]

const FREE = [t("2 full picks a week with a free account"), t("Live scores, lineups and events"), t("League tables, team and player pages"), t("Latest results and our public record")]
// fix172: the allowance is the card's subtitle (it was also the first line here)
const PREMIUM = [
  t("Win / draw / loss %, and why this pick"),
  t("Goals: over/under, both teams score, likely scores"),
  t("Every finished match in full"),
  t("Full team and player stats")
]
const PRO = [
  t("Unlimited predictions, no counting"),
  t("Everything in Premium"),
  t("Draw picks: the 2 likeliest draws every week"),
  t("Every sport we add, included"),
  t("Early access to new models and features")
]

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-accent flex-shrink-0 mt-0.5" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}

const SECTIONS = ['packs'] // fix235: /premium/packs (was #packs)

export default function Premium() {
  useSectionPath(SECTIONS)
  const { user, access, refresh } = useAuth()
  const [testMode, setTestMode] = useState(false)
  const [plans, setPlans] = useState<PlanRow[]>(PLAN_DEFAULTS)
  const [packs, setPacks] = useState<Pack[]>([])
  // fix172: the pick prices and pack sizes from the server (the same config the pack checkout uses)
  const [pickPrice, setPickPrice] = useState<{ free: number; premium: number } | null>(null)
  const [packSizes, setPackSizes] = useState<number[]>([])
  const [period, setPeriod] = useState<Period>('month')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const u = useUnlocks(access === 'premium' || access === 'free')

  useEffect(() => {
    axios
      .get(`${API_URL}/billing/plans`)
      .then(r => { setTestMode(!!r.data.data?.testMode); if (Array.isArray(r.data.data?.plans)) setPlans(r.data.data.plans); setPacks(r.data.data?.packs || [])
        const pp = r.data.data?.pickPrice
        if (pp && Number.isFinite(pp.free) && Number.isFinite(pp.premium)) setPickPrice({ free: pp.free, premium: pp.premium })
        if (Array.isArray(r.data.data?.packSizes)) setPackSizes(r.data.data.packSizes) })
      .catch(() => undefined)
  }, [])

  const choose = async (plan: string, label: string) => {
    setBusy(plan)
    setMsg(null)
    try {
      await axios.post(`${API_URL}/billing/test-checkout`, { plan })
      await refresh()
      await refreshUnlocks()
      setMsg({ ok: true, text: plan === 'free' ? t("You are back on Free (test).") : t("You are on {0} now (test checkout, no payment taken).", { 0: label }) })
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(null)
    }
  }

  const button = (plan: string, label: string, primary: boolean) => {
    const target = plans.find(p => p.id === plan)?.plan || plan
    if (access === 'admin') return <div className="rounded-xl bg-surface2/70 text-center py-2.5 text-sm text-muted">{t("Admin: full access")}</div>
    if (access === target) return <div className="rounded-xl bg-accent/15 text-accent text-center py-2.5 text-sm font-semibold">{t("Your plan")}</div>
    if (!user)
      return (
        <Link to="/signup?next=/premium" className={`block text-center rounded-xl py-2.5 text-sm font-semibold ${primary ? 'bg-accent text-bg' : 'border border-line text-ink hover:border-faint'}`}>
          {t("Create an account")}</Link>
      )
    if (!testMode) return <div className="rounded-xl border border-line text-center py-2.5 text-sm text-muted">{t("Payments open soon")}</div>
    const upgrade = access === 'premium' && target === 'pro'
    return (
      <button
        onClick={() => choose(plan, label)}
        disabled={!!busy}
        className={`w-full rounded-xl py-2.5 text-sm font-extrabold disabled:opacity-60 ${primary ? 'bg-accent text-bg' : 'border border-line text-ink hover:border-faint'}`}
      >
        {busy === plan ? t("Switching…") : upgrade ? t("Upgrade to {0}", { 0: label }) : t("Choose {0}", { 0: label })}
      </button>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{t("See the numbers behind every pick")}</h1>
        <p className="text-muted mt-3">
          {t("Every prediction is saved before kick-off and scored in public. Pick the plan that fits how much you use it.")}</p>
        <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-win/40 bg-win/10 px-3 py-1 text-xs font-semibold text-win">
          {t("3-day money-back guarantee · cancel any time")}</p>
        {testMode && (
          <p className="mt-4 inline-block rounded-full border border-draw/40 bg-draw/10 px-3 py-1 text-xs font-semibold text-draw">
            {t("Test mode: choosing a plan switches it straight away, no payment is taken")}</p>
        )}
      </div>

      {access === 'premium' && u && u.left !== null && (
        <div className="mt-8 card p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink">
            {t("{0} of {1} unlocks left this month · renews {2}", { 0: u.left, 1: u.allowance, 2: resetDay(u.resetsAt) })}
          </div>
          <div className="h-2 w-full sm:w-64 rounded-full bg-surface2 overflow-hidden">
            <div className="h-full bg-accent" style={{ width: `${(u.left / Math.max(1, u.allowance)) * 100}%` }} />
          </div>
        </div>
      )}

      {/* fix147: one card per plan, the period from the toggle (monthly first) */}
      <div className="mt-8 flex justify-center">
        <div role="tablist" className="inline-flex p-1 rounded-full bg-surface2 border border-line/60">
          {([['month', t("Monthly")], ['6 months', t("6 months")], ['year', t("Yearly")]] as [Period, string][]).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}
              className={`px-3.5 sm:px-4 py-2 rounded-full text-sm font-semibold ${period === k ? 'bg-accent text-bg' : 'text-muted hover:text-ink'}`}>
              {label}{k !== 'month' && <span className={`ml-1.5 text-[10px] font-extrabold ${period === k ? 'text-bg' : 'text-win'}`}>{k === 'year' ? '−20%' : '−10%'}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-5 items-stretch max-w-4xl mx-auto">
        {(['premium', 'pro'] as const).map(kind => {
          const p = plans.find(x => (x.plan || x.id) === kind && x.period === period) || plans.find(x => x.id === kind)!
          const pro = kind === 'pro'
          const per = period === 'month' ? t("/ month") : period === 'year' ? t("/ year") : t("/ 6 months")
          return (
            <div key={kind} className={`card p-6 flex flex-col relative overflow-hidden ${pro ? 'border-accent/60 shadow-lift order-first md:order-none' : ''}`}>
              {pro && <div className="pointer-events-none absolute -top-24 -right-24 w-64 h-64 rounded-full bg-accent/20 blur-3xl" />}
              {pro && <span className="absolute top-4 right-4 text-[10px] font-extrabold uppercase tracking-wider text-bg bg-accent px-2.5 py-1 rounded-full">{t("Most popular")}</span>}
              <div className="relative flex flex-col flex-1">
                <div className={`label ${pro ? 'text-accent' : ''}`}>{pro ? t("Pro") : t("Premium")}</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="font-display text-4xl font-extrabold text-ink">{money(p.price)}</span>
                  <span className="text-sm text-muted">{per}</span>
                </div>
                <div className="text-xs mt-1 flex flex-wrap items-center gap-x-2">
                  {period !== 'month' && <span className="text-muted">{t("= {0}/month", { 0: money(p.perMonth) })}</span>}
                  {/* fix172: the allowance on every tab (it is no longer repeated in the list below) */}
                  <span className={pro ? 'text-accent font-semibold' : 'text-faint'}>{pro ? t("Unlimited matches") : t("60 match unlocks a month")}</span>
                  {p.save > 0 && <span className="text-win font-semibold">{t("Save {0}%", { 0: p.save })}</span>}
                </div>
                <ul className="mt-5 space-y-2.5 text-sm text-ink/90 flex-1">
                  {(pro ? PRO : PREMIUM).map(f => (
                    <li key={f} className="flex gap-2">
                      <Check /> {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-6">{button(p.id, pro ? 'Pro' : 'Premium', pro)}</div>
              </div>
            </div>
          )
        })}
      </div>

      {msg && <p className={`mt-6 text-center text-sm ${msg.ok ? 'text-win' : 'text-loss'}`}>{msg.text}</p>}

      <div className="mt-10 card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="label">{t("Free")}</div>
            <div className="font-display text-xl font-bold text-ink mt-0.5">$0</div>
          </div>
          {testMode && user && (access === 'premium' || access === 'pro') && (
            <button onClick={() => choose('free', 'Free')} disabled={!!busy} className="text-xs text-muted hover:text-ink underline">
              {t("Back to Free (test)")}</button>
          )}
        </div>
        <ul className="mt-3 grid sm:grid-cols-2 gap-2 text-sm text-ink/90">
          {FREE.map(f => (
            <li key={f} className="flex gap-2">
              <Check /> {f}
            </li>
          ))}
        </ul>
        {!user && (
          <Link to="/signup" className="mt-5 inline-block rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink hover:border-faint">
            {t("Create free account")}</Link>
        )}
      </div>

      {/* fix172: pick packs listed with the plans (prices and sizes from /billing/plans) */}
      {pickPrice && (
        <div className="mt-4 card px-6 py-4 flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4">
          <div className="label flex-shrink-0">{t("Pick packs")}</div>
          <div className="text-sm text-ink/90 min-w-0">
            {t("One pick at {0}, or {1} with Premium.", { 0: money(pickPrice.free), 1: money(pickPrice.premium) })}
            {packSizes.length > 0 && <>{' '}{t("Packs of {0} picks.", { 0: packSizes.join(' / ') })}</>}
            <span className="block text-xs text-faint mt-1">{t("Pick packs never expire; a pick that was used is not refunded.")}</span>
          </div>
        </div>
      )}

      {/* fix147: pick packs — single picks once the free / monthly ones are used up */}
      {access !== 'pro' && access !== 'admin' && (
        <section id="packs" className="mt-4 card p-6 scroll-mt-24">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
            <div>
              <div className="label">{t("Buy picks")}</div>
            </div>
            {user && u && typeof u.credits === 'number' && <div className="text-sm text-ink">{t("Your balance: {0} picks", { 0: u.credits })}</div>}
          </div>
          <PickPacks fallback={packs} note={false} />
        </section>
      )}

      <p className="mt-8 text-center text-xs text-faint max-w-xl mx-auto">
        {t("3-day money-back guarantee on every plan: not for you? Ask within 3 days of paying and you get the full amount back. Unlocked matches stay open. Finished matches are always open on paid plans. Unlocks renew on the 1st of every month. Predictions are probabilities, not promises. SportLikely is an analytics service and does not take bets.")}</p>
    </div>
  )
}

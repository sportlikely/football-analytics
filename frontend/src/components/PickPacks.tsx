import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { t as tt } from '../lib/i18n'
import { useUnlocks, buyPack, money, type Pack } from '../lib/unlocks'

/**
 * Pick packs (fix147): 5 / 10 / 20 picks at the price of the member's plan ($0.79 a pick on Free, $0.59 on Premium; Pro
 * needs none). Used on the Premium page, the Account page and in the "Unlock this pick" sheet. While payments are in test
 * mode a pack is added straight away (no charge); otherwise the buttons say payments open soon.
 * `fallback` = the packs to show signed-out visitors (from /billing/plans). `note` = false hides the terms line (fix172:
 * the Premium page shows them once, in its pick packs row).
 */
export default function PickPacks({ compact = false, note = true, fallback, onBought }: { compact?: boolean; note?: boolean; fallback?: Pack[]; onBought?: () => void }) {
  const { user, access } = useAuth()
  const u = useUnlocks(!!user && (access === 'free' || access === 'premium'))
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  if (access === 'pro' || access === 'admin') return null
  const packs = (user ? u?.packs : fallback) || fallback || []
  if (!packs.length) return null
  const buy = async (p: Pack) => {
    setBusy(p.id); setMsg(null)
    try {
      const st = await buyPack(p.id)
      setMsg({ ok: true, text: tt("{0} picks added (test, no payment taken). Balance: {1}.", { 0: p.picks, 1: st.credits ?? 0 }) })
      onBought?.()
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || tt("Could not add the pack. Try again.") })
    } finally { setBusy(null) }
  }
  const next = encodeURIComponent(window.location.pathname.replace(/^\/[a-z]{2}(?=\/|$)/, ''))
  return (
    <div>
      <div className={`grid ${compact ? 'grid-cols-3 gap-2' : 'grid-cols-1 sm:grid-cols-3 gap-3'}`}>
        {packs.map((p, i) => (
          <div key={p.id} className={`rounded-2xl border ${i === 1 ? 'border-accent/60' : 'border-line'} bg-surface2/40 ${compact ? 'p-2.5' : 'p-4'} flex flex-col items-center text-center gap-1`}>
            {compact
              ? <div className="leading-none"><div className="font-display font-extrabold text-ink text-xl num">{p.picks}</div><div className="text-[10px] text-faint">{tt("{0} picks", { 0: p.picks }).replace(String(p.picks), '').trim()}</div></div>
              : <div className="font-display font-extrabold text-ink text-2xl">{tt("{0} picks", { 0: p.picks })}</div>}
            <div className={`num font-bold text-ink ${compact ? 'text-sm' : 'text-base'}`}>{money(p.price)}</div>
            <div className="text-[11px] text-faint">{tt("{0} a pick", { 0: money(p.each) })}</div>
            {!user ? (
              <Link to={`/signup?next=${next}`} className="mt-1 w-full rounded-xl border border-line py-1.5 text-xs font-semibold text-ink hover:border-faint">{tt("Create an account")}</Link>
            ) : u?.testMode ? (
              <button type="button" disabled={!!busy} onClick={() => buy(p)} className={`mt-1 w-full rounded-xl py-1.5 text-xs font-extrabold disabled:opacity-60 ${i === 1 ? 'bg-accent text-bg' : 'border border-line text-ink hover:border-faint'}`}>
                {busy === p.id ? tt("Adding…") : tt("Buy")}</button>
            ) : (
              <div className="mt-1 w-full rounded-xl border border-line py-1.5 text-[11px] text-muted">{tt("Payments open soon")}</div>
            )}
          </div>
        ))}
      </div>
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-win' : 'text-loss'}`}>{msg.text}</p>}
      {!compact && note && <p className="mt-3 text-[11px] text-faint">{tt("Pack picks never expire and work in every sport. They are used after your free picks (and Premium's monthly unlocks). A pick that was used is not refunded.")}</p>}
    </div>
  )
}

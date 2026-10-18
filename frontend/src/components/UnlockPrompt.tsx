import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { t as tt } from '../lib/i18n'
import { useUnlocks, unlockMatch, resetDay } from '../lib/unlocks'
import PickPacks from './PickPacks'

/** Game pages listen for this to load the game again after a free pick opened it. */
export const GAME_RELOAD = 'sl-game-reload'

/**
 * The locked-prediction card of every sport (fix144, from football's match page): signed-in Free members spend one of
 * their 2 free picks a week (shared by every sport), Premium one of its monthly unlocks, then (fix147) one pick from their
 * pick-pack balance; with none left the "Unlock this pick" sheet offers a pack at their plan's price or an upgrade. Signed-out visitors are
 * asked to create a free account. `rid` = the game's reveal id (football: match id, basketball -id, NFL -(2e9 + id)).
 * `what` = what the full prediction holds in this sport.
 */
export default function UnlockPrompt({ rid, status, what, premiumWhat, autoUnlock = false, onUnlocked }: {
  rid: number; status: string; what: string; premiumWhat?: string; autoUnlock?: boolean; onUnlocked?: () => void
}) {
  const { user, access } = useAuth()
  const canUnlock = !!user && (access === 'premium' || access === 'free')
  const u = useUnlocks(canUnlock)
  const weekly = u?.period === 'week'
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [needPro, setNeedPro] = useState(false)
  const doUnlock = async () => {
    setBusy(true)
    setErr(null)
    try {
      await unlockMatch(rid, status)
      if (onUnlocked) onUnlocked()
      else window.dispatchEvent(new Event(GAME_RELOAD))
    } catch (e: any) {
      if (e?.upgrade) setNeedPro(true)
      else setErr(e?.message || tt("Could not unlock this match."))
    } finally {
      setBusy(false)
    }
  }
  const credits = u?.credits ?? 0
  // allowance used up: a pack pick is spent next (the server does it); none left → the "Unlock this pick" sheet
  const useCredit = !!u && u.left === 0 && credits > 0
  const out = canUnlock && (needPro || (!!u && u.left === 0 && credits === 0))
  // fix128: "See prediction" from a list = the member asked to open it: use one reveal here
  const tried = useRef(false)
  useEffect(() => {
    if (!autoUnlock || tried.current || !canUnlock || !u || busy || needPro) return
    if (u.left !== null && u.left <= 0 && !(u.credits ?? 0)) return
    tried.current = true
    void doUnlock()
  }, [autoUnlock, canUnlock, u, busy, needPro])
  const next = encodeURIComponent(window.location.pathname.replace(/^\/[a-z]{2}(?=\/|$)/, ''))

  return canUnlock ? (
    <div className={`rounded-2xl border border-line bg-surface/95 shadow-lift px-5 py-4 text-center mx-auto ${out ? 'max-w-md' : 'max-w-sm'}`}>
      {out ? (
        <>
          {/* fix147: the "Unlock this pick" sheet — a pick pack at the plan's price, or an upgrade */}
          <div className="font-display font-bold text-ink">{tt("Unlock this pick")}</div>
          <div className="text-xs text-ink/80 mt-0.5">{weekly ? tt("You've used this week's free picks") : tt("You've used all your unlocks this month")}</div>
          <div className="text-xs text-muted mt-1">
            {weekly ? tt("Your {0} free picks come back on Monday. Premium opens 60 matches a month; Pro opens every match.", { 0: u?.allowance ?? 2 }) : tt("{0}Pro is unlimited, and adds draw picks.", { 0: u ? tt("Your {0} unlocks renew on {1}. ", { 0: u.allowance, 1: resetDay(u.resetsAt) }) : '' })}
          </div>
          <div className="mt-3 text-left"><div className="label pb-1.5">{tt("Pick packs")}</div><PickPacks compact onBought={() => setNeedPro(false)} /></div>
          <div className="mt-3 flex justify-center">
            <Link to="/premium" className="px-4 py-2 rounded-xl border border-line text-ink text-sm font-extrabold hover:border-faint">{weekly ? tt("See plans") : tt("Upgrade to Pro")}</Link>
          </div>
        </>
      ) : (
        <>
          <div className="font-display font-bold text-ink">{tt("Unlock this match")}</div>
          <div className="text-xs text-muted mt-1">
            {what}{' '}
            {useCredit ? tt("Uses 1 of your {0} pack picks", { 0: credits }) : weekly ? tt("Uses 1 of your {0} free picks this week", { 0: u?.allowance ?? 2 }) : tt("Uses 1 of your monthly unlocks")}{tt("; it stays open after that.")}</div>
          <div className="mt-3 flex flex-col items-center gap-1.5">
            <button onClick={doUnlock} disabled={busy} className="px-4 py-2 rounded-xl bg-accent text-bg text-sm font-extrabold disabled:opacity-60">
              {busy ? tt("Unlocking…") : useCredit ? tt("Unlock pick") : tt("Unlock prediction")}
            </button>
            {u && u.left !== null && !useCredit && <span className="text-[11px] text-faint num">{weekly ? tt("{0} of {1} free picks left this week", { 0: u.left, 1: u.allowance }) : tt("{0} of {1} unlocks left this month", { 0: u.left, 1: u.allowance })}</span>}
            {err && <span className="text-[11px] text-loss">{err}</span>}
          </div>
        </>
      )}
    </div>
  ) : (
    <div className="rounded-2xl border border-line bg-surface/95 shadow-lift px-5 py-4 text-center max-w-sm mx-auto">
      <div className="font-display font-bold text-ink">{user ? tt("Full prediction with Premium") : tt("Get 2 free picks every week")}</div>
      <div className="text-xs text-muted mt-1">
        {user ? premiumWhat || what : tt("Create a free account and open the full prediction of any 2 matches a week. No card needed.")}
      </div>
      <div className="mt-3 flex justify-center gap-2">
        {user ? (
          <Link to="/premium" className="px-3.5 py-1.5 rounded-xl bg-accent text-bg text-sm font-semibold">{tt("See Premium")}</Link>
        ) : (
          <>
            <Link to={`/signup?next=${next}`} className="px-3.5 py-1.5 rounded-xl bg-accent text-bg text-sm font-semibold">{tt("Create free account")}</Link>
            <Link to={`/login?next=${next}`} className="px-3.5 py-1.5 rounded-xl border border-line text-sm font-medium text-ink hover:border-faint">{tt("Sign in")}</Link>
          </>
        )}
      </div>
    </div>
  )
}

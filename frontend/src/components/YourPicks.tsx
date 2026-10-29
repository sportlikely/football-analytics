import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t as tt } from '../lib/i18n'

/*
 * "Your picks" card (Oct 2026): every signed-in account picks the winner, over / under and both-teams-score
 * (basketball: winner and over / under the points line) before kick-off. Changeable until kick-off, then locked and
 * counted in the personal record (/my-picks). It never reveals or unlocks our own prediction. fix284: tennis too (who wins),
 * and on PC the card sits in the game page's right column (GameLayout).
 */

type Result = 'hit' | 'miss' | 'void' | 'pending'
interface PickState {
  signedIn: boolean
  available: boolean
  kickoff?: string
  locked?: boolean
  line?: number | null
  markets?: string[]
  picks?: Record<string, { pick: string; line: number | null; result: Result }>
}

export function marketLabel(market: string) {
  return market === 'result' || market === 'win' ? tt('Who wins?') : market === 'ou25' ? tt('Goals: over / under 2.5') : market === 'btts' ? tt('Both teams score?') : tt('Total points')
}

/** Button labels for one market. */
export function optionsFor(market: string, home: string, away: string, line: number | null | undefined): { k: string; label: string }[] {
  if (market === 'result') return [{ k: 'H', label: home }, { k: 'D', label: tt('Draw') }, { k: 'A', label: away }]
  if (market === 'win') return [{ k: 'H', label: home }, { k: 'A', label: away }]
  if (market === 'ou25') return [{ k: 'O', label: tt('Over 2.5') }, { k: 'U', label: tt('Under 2.5') }]
  if (market === 'btts') return [{ k: 'Y', label: tt('Yes') }, { k: 'N', label: tt('No') }]
  const l = line != null ? String(line) : ''
  return [{ k: 'O', label: tt('Over {0}', { 0: l }) }, { k: 'U', label: tt('Under {0}', { 0: l }) }]
}

export function ResultBadge({ r }: { r: Result }) {
  if (r === 'hit') return <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-win/15 text-win">✓ {tt('Right')}</span>
  if (r === 'miss') return <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-loss/15 text-loss">✕ {tt('Wrong')}</span>
  if (r === 'void') return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-surface2 text-muted">{tt('Void')}</span>
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-surface2 text-muted">{tt('Waiting for the result')}</span>
}

export default function YourPicks({ sport, gameId, home, away }: { sport: 'fb' | 'bb' | 'nfl' | 'tn'; gameId: number; home: string; away: string }) {
  const loc = useLocation()
  const [d, setD] = useState<PickState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    setD(null)
    axios.get(`${API_URL}/picks/game/${sport}/${gameId}`).then(r => { if (!off) setD(r.data.data) }).catch(() => { if (!off) setD({ signedIn: false, available: false }) })
    return () => { off = true }
  }, [sport, gameId])

  if (!d || !d.available || !d.markets?.length) return null
  const picks = d.picks || {}
  const locked = !!d.locked
  const made = Object.keys(picks).length

  const choose = (market: string, k: string) => {
    if (locked || busy) return
    const next = picks[market]?.pick === k ? null : k // tap the same choice again to remove it
    setBusy(market); setErr(null)
    // instant feedback, then the server's answer
    setD({ ...d, picks: next ? { ...picks, [market]: { pick: next, line: market === 'total' ? d.line ?? null : null, result: 'pending' } } : Object.fromEntries(Object.entries(picks).filter(([m]) => m !== market)) })
    axios.post(`${API_URL}/picks`, { sport, id: gameId, market, pick: next })
      .then(r => setD(r.data.data))
      .catch(e => { setErr(errorText(e)); setD(d) })
      .finally(() => setBusy(null))
  }

  return (
    <section className="card p-5 sm:p-6" aria-labelledby={`yp-${gameId}`} data-your-picks>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 id={`yp-${gameId}`} className="font-display text-base font-bold text-ink">{tt('Your picks')}</h2>
        <span className="text-xs text-faint">
          {locked ? (sport === 'bb' ? tt('Locked at tip-off') : sport === 'tn' ? tt('Locked at the first serve') : tt('Locked at kick-off')) : d.signedIn ? (sport === 'bb' ? tt('Change them until tip-off') : sport === 'tn' ? tt('Change them until the first serve') : tt('Change them until kick-off')) : tt('Free for every account')}
        </span>
      </div>

      {!d.signedIn ? (
        <div className="rounded-2xl border border-line/60 bg-surface2/40 p-4 sm:p-5 flex flex-wrap items-center gap-3 justify-between">
          <p className="text-sm text-muted max-w-md">{tt('Pick the winner, goals and more yourself, and build your own record against the results.')}</p>
          <Link to={`/login?next=${encodeURIComponent(loc.pathname)}`} className="px-4 py-2 rounded-xl bg-accent text-bg font-semibold text-sm">{tt('Sign in to pick')}</Link>
        </div>
      ) : locked && !made ? (
        <p className="text-sm text-faint">{tt('You made no picks for this game.')}</p>
      ) : (
        <div className="space-y-4">
          {d.markets.map(market => {
            const mine = picks[market]
            if (locked && !mine) return null
            const opts = optionsFor(market, home, away, mine?.line ?? d.line)
            return (
              <div key={market}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">{marketLabel(market)}</span>
                  {mine && locked && <ResultBadge r={mine.result} />}
                </div>
                <div className={`grid gap-2 ${opts.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`} role="radiogroup" aria-label={marketLabel(market)}>
                  {opts.map(o => {
                    const on = mine?.pick === o.k
                    return (
                      <button key={o.k} type="button" role="radio" aria-checked={on} disabled={locked || busy === market}
                        onClick={() => choose(market, o.k)}
                        className={`min-w-0 px-3 py-2.5 rounded-xl text-sm font-semibold border transition-colors truncate ${
                          on ? 'bg-accent text-bg border-accent' : locked ? 'border-line/50 text-faint' : 'border-line hover:border-accent/60 text-ink'
                        } ${locked ? 'cursor-default' : ''}`}>
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {err && <p className="text-xs text-loss" role="alert">{err}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <span className="text-[11px] text-faint">{locked ? tt('Your picks are saved in your personal record.') : made ? tt('Saved. Tap again to remove a pick.') : (sport === 'bb' ? tt('Tap to pick before tip-off.') : sport === 'tn' ? tt('Tap to pick before the first serve.') : tt('Tap to pick before kick-off.'))}</span>
            <Link to="/football/my-picks" className="text-xs font-semibold text-accent hover:underline">{tt('My record')} <span aria-hidden className="rtl-flip">→</span></Link>
          </div>
        </div>
      )}
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { useAuth } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'
import { marketLabel, optionsFor, ResultBadge } from '../components/YourPicks'
import { matchHref } from '../lib/links'

/* Personal record (Oct 2026): the account's own picks, hit rate per pick type, and every pick with its result.
 * fix144: every sport (football, basketball, NFL + college); each sport's menu opens it filtered on that sport. */

type Result = 'hit' | 'miss' | 'void' | 'pending'
type SportKey = 'fb' | 'bb' | 'nfl'
interface Row { sport: SportKey; gameId: number; market: string; pick: string; line: number | null; kickoff: string; result: Result; home: string | null; away: string | null; league: string | null }
interface Stat { picks: number; settled: number; hits: number; pending: number; void: number }
interface Tot { picks: number; settled: number; hits: number; pending: number }
interface Rec { total: Tot; bySport?: Record<string, Tot>; streak: number; stats: Record<string, Stat>; list: Row[]; basketball: boolean; nfl?: boolean }

const TYPES: { key: string; sport: SportKey; market: string }[] = [
  { key: 'fb:result', sport: 'fb', market: 'result' },
  { key: 'fb:ou25', sport: 'fb', market: 'ou25' },
  { key: 'fb:btts', sport: 'fb', market: 'btts' },
  { key: 'bb:win', sport: 'bb', market: 'win' },
  { key: 'bb:total', sport: 'bb', market: 'total' },
  { key: 'nfl:win', sport: 'nfl', market: 'win' }
]
const SPORT_LABEL = (s: SportKey) => (s === 'fb' ? tt('Football') : s === 'bb' ? tt('Basketball') : tt('American football'))
const GAME_HREF = (r: Row) => matchHref(s2l(r.sport), r.gameId, { home: r.home, away: r.away, date: r.kickoff })!
const s2l = (s: SportKey) => (s === 'fb' ? 'football' : s === 'bb' ? 'basketball' : 'american-football')
const GAMES_HREF: Record<SportKey, string> = { fb: '/football/matches', bb: '/basketball/matches', nfl: '/american-football/matches' }
const pct = (s: { settled: number; hits: number }) => (s.settled ? Math.round((s.hits / s.settled) * 1000) / 10 : null)

export default function MyPicks({ initial = 'all' }: { initial?: 'all' | SportKey }) {
  const { user, loading } = useAuth()
  const [d, setD] = useState<Rec | null>(null)
  const [err, setErr] = useState(false)
  const [sport, setSport] = useState<'all' | SportKey>(initial)
  useEffect(() => setSport(initial), [initial])

  useEffect(() => {
    if (!user) return
    axios.get(`${API_URL}/picks/record`).then(r => setD(r.data.data)).catch(() => setErr(true))
  }, [user])

  const list = useMemo(() => (d ? d.list.filter(r => sport === 'all' || r.sport === sport) : []), [d, sport])

  if (loading) return null
  if (!user)
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <h1 className="font-display text-2xl font-bold text-ink">{tt('My picks')}</h1>
        <p className="text-muted">{tt('Pick the winner, goals and more yourself, and build your own record against the results.')}</p>
        <Link to={`/login?next=${encodeURIComponent(window.location.pathname)}`} className="inline-block px-5 py-2.5 rounded-xl bg-accent text-bg font-semibold">{tt('Sign in to pick')}</Link>
      </div>
    )

  const day = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
  // fix144: the record of the sport chosen (all sports together on "All")
  const total = d ? (sport === 'all' ? d.total : d.bySport?.[sport] || { picks: 0, settled: 0, hits: 0, pending: 0 }) : undefined
  const overall = total ? pct(total) : null
  const shown = (x: SportKey) => x === 'fb' || (x === 'bb' ? !!d?.basketball : !!d?.nfl)
  const sports = (['fb', 'bb', 'nfl'] as SportKey[]).filter(shown)
  const types = TYPES.filter(x => shown(x.sport)).filter(x => sport === 'all' || x.sport === sport)

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-ink">{tt('My picks')}</h1>
          <p className="text-sm text-muted mt-1">{tt('Your own picks and how they turned out. Picks lock at kick-off.')}</p>
        </div>
        {sports.length > 1 && (
          <div className="inline-flex flex-wrap p-1 rounded-full bg-surface2 border border-line/60" role="tablist">
            {(['all', ...sports] as const).map(s => (
              <button key={s} type="button" role="tab" aria-selected={sport === s} onClick={() => setSport(s)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold ${sport === s ? 'bg-accent text-bg' : 'text-muted hover:text-ink'}`}>
                {s === 'all' ? tt('All') : SPORT_LABEL(s)}
              </button>
            ))}
          </div>
        )}
      </div>

      {err && <p className="text-sm text-loss">{tt('Something went wrong. Try again.')}</p>}
      {!d && !err && <div className="card h-40 animate-pulse" />}

      {d && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="card p-4"><div className="text-xs text-muted">{tt('Right')}</div><div className={`font-display text-2xl font-bold ${overall !== null && overall >= 50 ? 'text-win' : 'text-ink'}`}>{overall !== null ? `${overall}%` : '–'}</div><div className="text-[11px] text-faint">{tt('{0} of {1} settled', { 0: total!.hits, 1: total!.settled })}</div></div>
            <div className="card p-4"><div className="text-xs text-muted">{tt('Picks made')}</div><div className="font-display text-2xl font-bold text-ink">{total!.picks}</div></div>
            <div className="card p-4"><div className="text-xs text-muted">{tt('Waiting for the result')}</div><div className="font-display text-2xl font-bold text-ink">{total!.pending}</div></div>
            <div className="card p-4"><div className="text-xs text-muted">{tt('Current streak')}</div><div className="font-display text-2xl font-bold text-accent">{d.streak}</div><div className="text-[11px] text-faint">{tt('right in a row')}</div></div>
          </div>

          <section className="card p-5 sm:p-6">
            <h2 className="font-display text-base font-bold text-ink mb-4">{tt('By pick type')}</h2>
            <div className="divide-y divide-line/50">
              {types.map(x => {
                const s = d.stats[x.key]
                const p = s ? pct(s) : null
                return (
                  <div key={x.key} className="py-3 flex items-center gap-3">
                    <span className="flex-1 min-w-0">
                      <span className="block text-[10px] font-bold uppercase tracking-wide text-faint truncate">{SPORT_LABEL(x.sport)}</span>
                      <span className="block text-sm font-semibold text-ink truncate">{marketLabel(x.market)}</span>
                    </span>
                    <div className="hidden sm:block w-40 h-2 rounded-full bg-surface2 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${p ?? 0}%` }} /></div>
                    <span className="text-sm font-bold text-ink num w-14 text-right">{p !== null ? `${p}%` : '–'}</span>
                    <span className="text-[11px] text-faint num w-20 text-right">{s ? `${s.hits}/${s.settled}` : '0/0'}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="card p-5 sm:p-6">
            <h2 className="font-display text-base font-bold text-ink mb-4">{tt('All my picks')}</h2>
            {list.length === 0 ? (
              <div className="text-sm text-faint space-y-2">
                <p>{tt('No picks yet. Open any game and pick under "Your picks".')}</p>
                <Link to={GAMES_HREF[sport === 'all' ? 'fb' : sport]} className="inline-block text-accent font-semibold hover:underline">{sport === 'all' || sport === 'fb' ? tt('See the matches') : tt('See the games')} →</Link>
              </div>
            ) : (
              <ul className="divide-y divide-line/50">
                {list.map(r => {
                  const opt = optionsFor(r.market, r.home || tt('Home'), r.away || tt('Away'), r.line).find(o => o.k === r.pick)
                  return (
                    <li key={`${r.sport}-${r.gameId}-${r.market}`} className="py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1">
                      <span className="text-[11px] text-faint num w-14 shrink-0">{day(r.kickoff)}</span>
                      <Link to={GAME_HREF(r)} className="flex-1 min-w-0 text-sm text-ink hover:text-accent truncate">
                        <span className="font-semibold">{r.home || '?'} – {r.away || '?'}</span>
                        {r.league && <span className="text-faint text-xs"> · {r.league}</span>}
                      </Link>
                      <span className="text-xs text-muted min-w-0 truncate w-full sm:w-auto sm:shrink-0 pl-[68px] sm:pl-0">{marketLabel(r.market)}: <b className="text-ink">{opt?.label || r.pick}</b></span>
                      <span className="shrink-0"><ResultBadge r={r.result} /></span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          <p className="text-[11px] text-faint">{tt('Your picks are private and only for you. Cancelled games are void and not counted.')}</p>
        </>
      )}
    </div>
  )
}

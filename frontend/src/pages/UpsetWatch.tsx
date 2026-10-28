import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'
import { matchHref } from '../lib/links'
import { groupByDay } from '../lib/upsetDays'

/*
 * Upset watch (Pro, model only, no bookmakers): favourites our model thinks are less safe than they look.
 * fix242: the server picks the games (favourite 50%+, underdog 25%+, a clear reason: backend utils/upsetWatch.ts) and
 * names the favourite / underdog from the win % — this page never works them out from home / away. A short list: the
 * top 10 of the week grouped by day (the visitor's time zone), one line each with one reason; the rest behind
 * "Show all (N)"; the last 10 results with "See all". The same page in every sport (no draw in the winner sports).
 */
export type UpsetSport = 'football' | 'basketball' | 'american-football' | 'tennis'
/** the API route of each sport's list (under API_URL; not page addresses) */
const API_OF: Record<UpsetSport, string> = { football: 'upset-watch', basketball: 'basketball/upset-watch', 'american-football': 'nfl/upset-watch', tennis: 'tennis/upset-watch' }
/** fix229: the game's slug link (the sides as listed, the day) */
const GAME_OF = (sport: UpsetSport, g: { matchId: number; home: string; away: string; date: string }) => matchHref(sport, g.matchId, { home: g.home, away: g.away, date: g.date })!

interface TeamSide { side: 'H' | 'A'; name: string; p: number }
interface Reason { key: 'keyOut' | 'form' | 'rest' | 'awayRecord' | 'closerThanTable' | 'h2h'; grid?: boolean; player?: string; a?: number; b?: number; c?: number; d?: number; n?: number }
interface Watch {
  matchId: number; league: string; date: string; home: string; away: string
  pHome: number; pDraw: number | null; pAway: number
  favourite: TeamSide; underdog: TeamSide; reason: Reason; top: boolean
}
interface Past { matchId: number; league: string; date: string; home: string; away: string; score: string; favourite: TeamSide; underdog: TeamSide; result: 'upset' | 'draw' | 'favourite' }
interface Report { upcoming: Watch[]; total: number; record: { days: number; n: number; upsets: number; upsetRate: number | null; said: number | null; recent: Past[] } }

const time = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })
const dayTitle = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' })
const pct = (p: number) => `${Math.round(p)}%`

/** One short reason, from the server's key and numbers (names are the favourite / underdog the server chose). */
function reasonText(r: Reason, fav: string, dog: string): string {
  switch (r.key) {
    case 'keyOut': return tt("{0} is out for {1}", { 0: r.player || '', 1: fav })
    case 'form': return r.grid
      ? tt("{0} in better form: {1} vs {2} points from the last {3}", { 0: dog, 1: r.a ?? 0, 2: r.b ?? 0, 3: r.n ?? 6 })
      : tt("{0} won {1} of the last {2}, {3} {4}", { 0: dog, 1: r.a ?? 0, 2: r.n ?? 5, 3: fav, 4: r.b ?? 0 })
    case 'rest': return r.grid
      ? tt("{0} played {1} games in {2} days, {3} {4}", { 0: fav, 1: r.a ?? 0, 2: r.n ?? 8, 3: dog, 4: r.b ?? 0 })
      : tt("{0} is more rested: {1} days off vs {2}", { 0: dog, 1: r.b ?? 0, 2: r.a ?? 0 })
    case 'awayRecord': return typeof r.a === 'number' && typeof r.b === 'number'
      ? tt("{0} won {1} of their last {2} away games", { 0: fav, 1: r.a, 2: r.b })
      : tt("{0}'s away record is weaker than {1}'s home record", { 0: fav, 1: dog })
    case 'closerThanTable': return typeof r.c === 'number'
      ? tt("{0} {1}–{2}, {3} {4}–{5} this season, but our numbers say it is closer", { 0: fav, 1: r.a ?? 0, 2: r.b ?? 0, 3: dog, 4: r.c, 5: r.d ?? 0 })
      : tt("Ranked {0} vs {1}, but closer than the ranking says", { 0: r.a ?? '–', 1: r.b ?? '–' })
    case 'h2h': return r.grid
      ? tt("{0} has the edge in the last {1} meetings", { 0: dog, 1: r.n ?? 0 })
      : tt("{0} won {1} of the last {2} meetings", { 0: dog, 1: r.a ?? 0, 2: r.n ?? 0 })
  }
}

/** One game on one line (wraps under the time on phones): time · league · Favourite (58%) vs Underdog (27%) · reason. */
function WatchRow({ w, sport }: { w: Watch; sport: UpsetSport }) {
  return (
    <li>
      <Link to={GAME_OF(sport, w)} className="flex flex-col sm:flex-row sm:items-center gap-x-3 gap-y-0.5 px-4 sm:px-5 py-2.5 hover:bg-surface2/50 min-w-0">
        <span className="flex items-center gap-2 text-[11px] text-faint shrink-0 sm:w-44 min-w-0">
          <span className="num text-muted">{time(w.date)}</span>
          <span className="truncate">{w.league}</span>
        </span>
        <span className="text-sm min-w-0 sm:truncate">
          <span className="text-muted">{w.favourite.name} <span className="num">({pct(w.favourite.p)})</span></span>
          <span className="text-faint mx-1.5">{tt("vs")}</span>
          <span className="font-bold text-loss">{w.underdog.name} <span className="num">({pct(w.underdog.p)})</span></span>
        </span>
        <span className="text-xs text-muted sm:ms-auto sm:text-end min-w-0 sm:truncate sm:max-w-[45%]">{reasonText(w.reason, w.favourite.name, w.underdog.name)}</span>
      </Link>
    </li>
  )
}

export default function UpsetWatch({ sport = 'football' }: { sport?: UpsetSport }) {
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [allPast, setAllPast] = useState(false)

  useEffect(() => {
    document.title = tt("Upset watch · SportLikely")
    setData(null); setError(null); setAll(false); setAllPast(false)
    axios.get(`${API_URL}/${API_OF[sport]}`).then(r => setData(r.data.data)).catch(e => setError(errorText(e)))
  }, [sport])

  if (error) return <div className="max-w-5xl mx-auto px-4 py-10 text-loss">{error}</div>
  const rec = data?.record
  const shown = data ? (all ? data.upcoming : data.upcoming.filter(w => w.top)) : []
  const days = groupByDay(shown)
  const past = rec ? (allPast ? rec.recent : rec.recent.slice(0, 10)) : []

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Upset watch")}</h1>
        <p className="text-muted mt-2 max-w-2xl">{tt("Favourites our model thinks are less safe than they look.")}</p>
        {rec && rec.n > 0 && rec.upsetRate !== null && rec.said !== null && (
          <p className="text-xs text-faint mt-1.5">
            {tt("Last {0} days: {1} flagged, the underdog won {2}% — we said {3}%.", { 0: rec.days, 1: rec.n, 2: Math.round(rec.upsetRate), 3: Math.round(rec.said) })}
            {rec.n < 30 && <> {tt("Too few games to judge yet.")}</>}
          </p>
        )}
      </div>

      {!data ? (
        <div className="card h-[260px] animate-pulse" />
      ) : data.upcoming.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <div className="font-display text-lg font-bold text-ink">{tt("No favourite at risk this week yet")}</div>
          <p className="text-sm text-muted max-w-md mx-auto">{tt("Games appear here once they are scheduled and our model has rated them.")}</p>
        </div>
      ) : (
        <section className="card overflow-hidden">
          {days.map(d => (
            <div key={d.day}>
              <h2 className="px-4 sm:px-5 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-faint">{dayTitle(d.items[0].date)}</h2>
              <ul className="divide-y divide-line/50 border-b border-line/50">{d.items.map(w => <WatchRow key={w.matchId} w={w} sport={sport} />)}</ul>
            </div>
          ))}
          {data.total > data.upcoming.filter(w => w.top).length && (
            <button type="button" onClick={() => setAll(x => !x)} className="w-full px-4 sm:px-5 py-2.5 text-sm font-bold text-accent hover:bg-surface2/50 text-start">
              {all ? tt("Show the top {0} only", { 0: data.upcoming.filter(w => w.top).length }) : tt("Show all ({0})", { 0: data.total })}
            </button>
          )}
        </section>
      )}

      {rec && rec.recent.length > 0 && (
        <section className="card overflow-hidden">
          <h2 className="px-4 sm:px-5 pt-4 pb-2 font-display text-lg font-bold text-ink">{tt("Past results")}</h2>
          <ul className="divide-y divide-line/50 border-t border-line/50">
            {past.map(r => (
              <li key={r.matchId}>
                <Link to={GAME_OF(sport, r)} className="flex items-center gap-3 px-4 sm:px-5 py-2 hover:bg-surface2/50 text-sm min-w-0">
                  <span className="w-14 text-[11px] text-faint shrink-0">{new Date(r.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
                  <span className="flex-1 min-w-0 truncate">
                    <span className={r.underdog.side === 'H' ? 'font-bold text-ink' : 'text-muted'}>{r.home}</span>
                    <span className="num text-ink mx-1.5">{r.score}</span>
                    <span className={r.underdog.side === 'A' ? 'font-bold text-ink' : 'text-muted'}>{r.away}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${r.result === 'upset' ? 'bg-loss/15 text-loss' : 'bg-surface2 text-muted'}`}>
                    {r.result === 'upset' ? tt("Upset ✓") : r.result === 'draw' ? tt("Draw") : tt("Favourite won")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {rec.recent.length > 10 && (
            <button type="button" onClick={() => setAllPast(x => !x)} className="w-full px-4 sm:px-5 py-2.5 text-sm font-bold text-accent hover:bg-surface2/50 text-start border-t border-line/50">
              {allPast ? tt("Show the last 10 only") : tt("See all ({0})", { 0: rec.recent.length })}
            </button>
          )}
        </section>
      )}

      <p className="text-xs text-faint max-w-2xl leading-relaxed">
        {sport === 'football' ? tt("An upset watch is not a tip: the favourite still wins or draws most of the time. Probabilities, not promises.") : tt("An upset watch is not a tip: the favourite still wins most of the time. Probabilities, not promises.")}
      </p>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'
import { OurPickBadge } from '../components/DcPick'

/*
 * Upset watch (Pro): games of the coming 7 days where our model gives the underdog 20–45% (fix188; and the favourite
 * leads by 10+ points), and how those calls have gone. Model only, no bookmakers, no betting claims.
 * fix144: the same page for basketball and American football (/basketball/upset-watch, /american-football/upset-watch):
 * winner sports have no draw, so the draw bar and the draw numbers are left out.
 */
export type UpsetSport = 'football' | 'basketball' | 'american-football' | 'tennis'
const API_OF: Record<UpsetSport, string> = { football: '/upset-watch', basketball: '/basketball/upset-watch', 'american-football': '/nfl/upset-watch', tennis: '/tennis/upset-watch' }
const GAME_OF: Record<UpsetSport, (id: number) => string> = { football: id => `/match/${id}`, basketball: id => `/basketball/game/${id}`, 'american-football': id => `/american-football/game/${id}`, tennis: id => `/tennis/match/${id}` }

interface Watch {
  matchId: number; league: string; date: string; home: string; away: string
  homeCrest?: string | null; awayCrest?: string | null
  home_p: number; draw_p: number; away_p: number
  favourite: 'H' | 'A'; underdog: 'H' | 'A'; favChance: number; upsetChance: number; draw: number
  /** fix120: our recommended pick (double chance) */
  dc?: { k: '1X' | 'X2' | '12'; p: number } | null
}
interface Recent { matchId: number; league: string; date: string; home: string; away: string; score: string; underdog: 'H' | 'A'; upsetChance: number; result: 'upset' | 'draw' | 'favourite' }
interface Record_ {
  n: number; upsets: number; draws: number; upsetRate: number | null; said: number | null; drawRate: number | null; saidDraw: number | null
  bands: { range: string; n: number; said: number | null; happened: number | null }[]
  since: string | null; recent: Recent[]
}
interface Report { rule: { minUnderdog: number; maxUnderdog?: number; minGap: number }; upcoming: Watch[]; record: Record_ }

const when = (iso: string) =>
  new Date(iso).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Crest({ src, name, size = 'w-10 h-10' }: { src?: string | null; name: string; size?: string }) {
  return src ? (
    <img src={src} alt="" className={`${size} object-contain`} />
  ) : (
    <span className={`${size} rounded-full bg-surface2 grid place-items-center text-xs font-bold text-muted`}>{String(name || "?").slice(0, 2).toUpperCase()}</span>
  )
}

function WatchCard({ w, sport }: { w: Watch; sport: UpsetSport }) {
  const draws = sport === 'football'
  const und = w.underdog === 'H' ? w.home : w.away
  const fav = w.favourite === 'H' ? w.home : w.away
  const rows = [
    { k: 'H', label: w.home, v: w.home_p, bar: 'bg-home' },
    { k: 'D', label: tt("Draw"), v: w.draw_p, bar: 'bg-draw' },
    { k: 'A', label: w.away, v: w.away_p, bar: 'bg-away' }
  ].filter(r => draws || r.k !== 'D')
  return (
    <Link to={GAME_OF[sport](w.matchId)} className="card card-hover p-4 sm:p-5 flex flex-col gap-4 min-w-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-2 min-w-0">
          <span className="px-2 py-0.5 rounded-full bg-loss/15 text-loss font-extrabold uppercase tracking-wider text-[10px] whitespace-nowrap">{tt("Upset watch")}</span>
          <span className="text-muted truncate">{w.league}</span>
        </span>
        <span className="text-muted whitespace-nowrap">{when(w.date)}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex flex-col items-center gap-1.5 text-center min-w-0">
          <Crest src={w.homeCrest} name={w.home} />
          <span className={`text-sm leading-tight truncate max-w-full ${w.underdog === 'H' ? 'font-bold text-ink' : 'text-muted'}`}>{w.home}</span>
        </div>
        <div className="text-center">
          <div className="font-display text-3xl sm:text-4xl font-extrabold text-loss num leading-none">{Math.round(w.upsetChance)}%</div>
          <div className="text-[11px] text-muted mt-1 max-w-[120px]">{tt("{0} to win", { 0: und })}</div>
        </div>
        <div className="flex flex-col items-center gap-1.5 text-center min-w-0">
          <Crest src={w.awayCrest} name={w.away} />
          <span className={`text-sm leading-tight truncate max-w-full ${w.underdog === 'A' ? 'font-bold text-ink' : 'text-muted'}`}>{w.away}</span>
        </div>
      </div>
      <div>
        <div className="flex h-2 gap-[3px]" aria-hidden>
          {rows.map(r => <div key={r.k} className={`rounded-full ${r.bar} ${r.k === w.underdog ? '' : 'opacity-40'}`} style={{ width: `calc(${r.v}% - 3px)` }} />)}
        </div>
        <div className="flex justify-between text-[11px] text-faint mt-1.5 num">
          {rows.map(r => <span key={r.k}>{Math.round(r.v)}%</span>)}
        </div>
      </div>
      <p className="text-[11px] text-faint">{tt("{0} is the favourite, but our model gives {1} about a 1 in {2} chance.", { 0: fav, 1: und, 2: Math.max(2, Math.round(100 / w.upsetChance)) })}</p>
      {w.dc && <OurPickBadge code={w.dc.k} pct={w.dc.p} home={w.home} away={w.away} compact />}
    </Link>
  )
}

export default function UpsetWatch({ sport = 'football' }: { sport?: UpsetSport }) {
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const draws = sport === 'football'

  useEffect(() => {
    document.title = tt("Upset watch · SportLikely")
    setData(null); setError(null)
    axios.get(`${API_URL}${API_OF[sport]}`).then(r => setData(r.data.data)).catch(e => setError(errorText(e)))
  }, [sport])

  if (error) return <div className="max-w-5xl mx-auto px-4 py-10 text-loss">{error}</div>
  const rec = data?.record

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Upset watch")}</h1>
        <p className="text-muted mt-2 max-w-2xl">
          {tt("Games of the coming week where the favourite is at risk: our model gives the underdog between {0}% and {1}% to win.", { 0: data?.rule.minUnderdog ?? 20, 1: data?.rule.maxUnderdog ?? 45 })}
        </p>
      </div>

      {!data ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{[0, 1].map(i => <div key={i} className="card h-[230px] animate-pulse" />)}</div>
      ) : data.upcoming.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <div className="font-display text-lg font-bold text-ink">{tt("No favourite at risk this week yet")}</div>
          <p className="text-sm text-muted max-w-md mx-auto">{tt("Games appear here once they are scheduled and our model has rated them.")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{data.upcoming.map(w => <WatchCard key={w.matchId} w={w} sport={sport} />)}</div>
      )}

      {rec && rec.n > 0 && (
        <section className="card p-4 sm:p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-ink">{tt("How these calls went")}</h2>
            {rec.since && <span className="text-[11px] text-faint">{tt("since {0}", { 0: new Date(rec.since).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) })}</span>}
          </div>
          {rec.n < 30 && (
            <p className="text-xs text-muted rounded-xl border border-line bg-surface2/40 px-3 py-2">
              {tt("Only {0} games so far, too few to judge.", { 0: rec.n })}
            </p>
          )}
          <div className={`grid ${draws ? 'grid-cols-3' : 'grid-cols-2'} gap-3`}>
            <div className="rounded-xl bg-surface2/60 p-3 text-center">
              <div className="num text-2xl font-extrabold text-ink">{rec.n}</div>
              <div className="text-[11px] text-muted">{tt("games flagged")}</div>
            </div>
            <div className="rounded-xl bg-surface2/60 p-3 text-center">
              <div className="num text-2xl font-extrabold text-loss">{rec.upsetRate}%</div>
              <div className="text-[11px] text-muted">{tt("underdog won (we said {0}%)", { 0: rec.said ?? '–' })}</div>
            </div>
            {draws && (
              <div className="rounded-xl bg-surface2/60 p-3 text-center">
                <div className="num text-2xl font-extrabold text-draw">{rec.drawRate}%</div>
                <div className="text-[11px] text-muted">{tt("draws (we said {0}%)", { 0: rec.saidDraw ?? '–' })}</div>
              </div>
            )}
          </div>
          <ul className="space-y-2">
            {rec.bands.filter(b => b.n > 0).map(b => (
              <li key={b.range} className="flex items-center gap-3 text-sm">
                <span className="w-24 text-muted shrink-0">{tt("We said {0}", { 0: b.range })}</span>
                <span className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden relative">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-loss" style={{ width: `${Math.min(100, ((b.happened ?? 0) / 60) * 100)}%` }} />
                  <span className="absolute inset-y-0 w-0.5 bg-ink/70" style={{ left: `${Math.min(100, ((b.said ?? 0) / 60) * 100)}%` }} aria-hidden />
                </span>
                <span className="w-20 text-right num text-xs text-ink whitespace-nowrap">{b.happened}% <span className="text-faint">· {b.n}</span></span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-faint">{tt("Bar = how often the underdog won; line = the chance we gave. Close together means our numbers are honest.")}</p>
          {rec.recent.length > 0 && (
            <ul className="divide-y divide-line/50 -mx-4 sm:-mx-5 border-t border-line/50">
              {rec.recent.map(r => (
                <li key={r.matchId}>
                  <Link to={GAME_OF[sport](r.matchId)} className="flex items-center gap-3 px-4 sm:px-5 py-2 hover:bg-surface2/50 text-sm">
                    <span className="w-14 text-[11px] text-faint shrink-0">{new Date(r.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}</span>
                    <span className="flex-1 min-w-0 truncate">
                      <span className={r.underdog === 'H' ? 'font-bold text-ink' : 'text-muted'}>{r.home}</span>
                      <span className="num text-ink mx-1.5">{r.score}</span>
                      <span className={r.underdog === 'A' ? 'font-bold text-ink' : 'text-muted'}>{r.away}</span>
                    </span>
                    <span className="num text-[11px] text-faint w-9 text-right">{Math.round(r.upsetChance)}%</span>
                    <span className={`w-20 text-right text-[11px] font-bold ${r.result === 'upset' ? 'text-loss' : r.result === 'draw' ? 'text-draw' : 'text-muted'}`}>
                      {r.result === 'upset' ? tt("Upset") : r.result === 'draw' ? tt("Draw") : tt("Favourite won")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="text-xs text-faint max-w-2xl leading-relaxed">
        {draws ? tt("An upset watch is not a tip: at 20–45% the favourite still wins or draws most of the time. It tells you which favourites are less safe than they look. Probabilities, not promises.") : tt("An upset watch is not a tip: at 20–45% the favourite still wins most of the time. It tells you which favourites are less safe than they look. Probabilities, not promises.")}
      </p>
    </div>
  )
}

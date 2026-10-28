import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'
import { OurPickBadge } from '../components/DcPick'
import { matchHref } from '../lib/links'

/*
 * Draw picks (Pro): the 2 games of the coming 7 days where a draw is most likely by our own model, then more
 * likely draws, draws by league and the teams that draw most. No bookmakers.
 */

interface Pick {
  matchId: number; league: string; date: string; home: string; away: string
  homeCrest?: string | null; awayCrest?: string | null
  ourDraw: number
  /** fix120: our recommended pick (double chance) */
  dc?: { k: '1X' | 'X2' | '12'; p: number } | null
}
interface Likely { matchId: number; league: string; date: string; home: string; away: string; homeCrest?: string | null; awayCrest?: string | null; draw: number }
interface LeagueDraw { division: string; league: string; now: number | null; n: number; last: number | null }
interface TeamDraw { team: string; league: string; n: number; d: number; rate: number }
interface Report { picks: Pick[]; likely?: Likely[]; leagues?: LeagueDraw[]; teams?: TeamDraw[] }

const when = (iso: string) =>
  new Date(iso).toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Crest({ src, name }: { src?: string | null; name: string }) {
  return src ? (
    <img src={src} alt="" className="w-14 h-14 sm:w-16 sm:h-16 object-contain drop-shadow" />
  ) : (
    <span className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-surface2 grid place-items-center font-display font-bold text-muted">{name.slice(0, 2).toUpperCase()}</span>
  )
}

function PickCard({ p, n }: { p: Pick; n: number }) {
  const max = 50
  return (
    <Link to={matchHref('football', p.matchId, { home: p.home, away: p.away, date: p.date })!} className="card card-hover relative overflow-hidden p-5 sm:p-6 flex flex-col gap-5 border-draw/40">
      <div className="pointer-events-none absolute -top-24 -end-24 w-64 h-64 rounded-full bg-draw/15 blur-3xl" />
      <div className="relative flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-2 min-w-0">
          <span className="px-2 py-0.5 rounded-full bg-draw/20 text-draw font-extrabold uppercase tracking-wider text-[10px] whitespace-nowrap">{tt("Draw pick")}{' '}{n}</span>
          <span className="text-muted truncate">{p.league}</span>
        </span>
        <span className="text-muted whitespace-nowrap">{when(p.date)}</span>
      </div>

      <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex flex-col items-center gap-2 text-center min-w-0">
          <Crest src={p.homeCrest} name={p.home} />
          <span className="font-display font-bold text-ink leading-tight truncate max-w-full">{p.home}</span>
        </div>
        <div className="text-center">
          <div className="font-display text-4xl sm:text-5xl font-extrabold text-draw num leading-none">{Math.round(p.ourDraw)}%</div>
          <div className="text-[11px] text-muted mt-1">{tt("draw chance")}</div>
        </div>
        <div className="flex flex-col items-center gap-2 text-center min-w-0">
          <Crest src={p.awayCrest} name={p.away} />
          <span className="font-display font-bold text-ink leading-tight truncate max-w-full">{p.away}</span>
        </div>
      </div>

      <div className="relative space-y-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="w-24 text-muted shrink-0">{tt("Draw chance")}</span>
          <div className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden">
            <div className="h-full bg-draw rounded-full" style={{ width: `${Math.min(100, (p.ourDraw / max) * 100)}%` }} />
          </div>
          <span className="num w-12 text-end font-bold text-ink">{Math.round(p.ourDraw)}%</span>
        </div>
        <p className="text-[11px] text-faint">{tt("A typical game ends level about 1 time in 4. This one is among the most likely draws of the week.")}</p>
      </div>
      {p.dc && <OurPickBadge code={p.dc.k} pct={p.dc.p} home={p.home} away={p.away} compact className="relative" />}

      <span className="relative text-sm font-bold text-accent">{tt("Full match analysis →")}</span>
    </Link>
  )
}

export default function DrawAlerts() {
  const [data, setData] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = tt("Draw picks · SportLikely")
    axios
      .get(`${API_URL}/draw-alerts`)
      .then(r => setData(r.data.data))
      .catch(e => setError(errorText(e)))
  }, [])

  if (error) return <div className="max-w-5xl mx-auto px-4 py-10 text-loss">{error}</div>

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Draw picks")}</h1>
        <p className="text-muted mt-2 max-w-2xl">
          {tt("The 2 games of the coming week where a draw is most likely, picked by our model. Updated as new information comes in.")}</p>
        <Link to="/football/upset-watch" className="inline-block mt-2 text-sm font-bold text-accent">{tt("Also for Pro: Upset watch →")}</Link>
      </div>

      {!data ? (
        <div className="grid gap-5 md:grid-cols-2">
          {[0, 1].map(i => <div key={i} className="card h-[420px] animate-pulse" />)}
        </div>
      ) : data.picks.length === 0 ? (
        <div className="card p-8 text-center space-y-2">
          <div className="font-display text-lg font-bold text-ink">{tt("Our 2 draw picks are coming")}</div>
          <p className="text-sm text-muted max-w-md mx-auto">
            {tt("They appear once the coming week's games are scheduled and our model has rated them.")}</p>
        </div>
      ) : (
        <div className={`grid gap-5 ${data.picks.length > 1 ? 'md:grid-cols-2' : 'max-w-xl'}`}>
          {data.picks.map((p, i) => <PickCard key={p.matchId} p={p} n={i + 1} />)}
        </div>
      )}

      {/* more games likely to end level this week (after the 2 picks) */}
      {data?.likely && data.likely.filter(m => !data.picks.some(p => p.matchId === m.matchId)).length > 0 && (
        <section className="card overflow-hidden">
          <div className="px-4 sm:px-5 py-3 border-b border-line/60 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-lg font-bold text-ink">{tt("More likely draws this week")}</h2>
            <span className="text-[11px] text-faint">{tt("by our draw chance")}</span>
          </div>
          <ul className="divide-y divide-line/50">
            {data.likely.filter(m => !data.picks.some(p => p.matchId === m.matchId)).map(m => (
              <li key={m.matchId}>
                <Link to={matchHref('football', m.matchId, { home: m.home, away: m.away, date: m.date })!} className="flex items-center gap-3 px-4 sm:px-5 py-2.5 hover:bg-surface2/50">
                  <span className="w-16 flex-shrink-0 text-[11px] text-faint leading-tight">
                    {new Date(m.date).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric' })}
                    <span className="block num">{new Date(m.date).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</span>
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0 text-sm text-ink">
                      {m.homeCrest && <img src={m.homeCrest} alt="" className="w-4 h-4 object-contain" />}
                      <span className="truncate">{m.home}</span>
                      <span className="text-faint">–</span>
                      {m.awayCrest && <img src={m.awayCrest} alt="" className="w-4 h-4 object-contain" />}
                      <span className="truncate">{m.away}</span>
                    </span>
                    <span className="block text-[11px] text-faint truncate">{m.league}</span>
                  </span>
                  <span className="w-14 text-end font-display font-extrabold text-draw num">{Math.round(m.draw)}%</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {((data?.leagues && data.leagues.length > 0) || (data?.teams && data.teams.length > 0)) && (
        <div className="grid gap-5 md:grid-cols-2 items-start">
          {data?.leagues && data.leagues.length > 0 && (
            <section className="card p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="font-display text-lg font-bold text-ink">{tt("Draws by league")}</h2>
                <span className="text-[11px] text-faint">{tt("this season · last season")}</span>
              </div>
              <ul className="space-y-2">
                {data.leagues.map(l => (
                  <li key={l.division} className="flex items-center gap-3 text-sm" title={tt("{0} games this season", { 0: l.n })}>
                    <span className="w-36 truncate text-ink">{l.league}</span>
                    <span className="flex-1 h-2 rounded-full bg-surface2 overflow-hidden">
                      <span className="block h-full rounded-full bg-draw" style={{ width: `${Math.min(100, ((l.now ?? 0) / 40) * 100)}%` }} />
                    </span>
                    <span className="w-11 text-end num font-bold text-ink">{l.now !== null ? `${Math.round(l.now)}%` : '–'}</span>
                    <span className="w-9 text-end num text-[11px] text-faint">{l.last !== null ? `${Math.round(l.last)}%` : ''}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[11px] text-faint mt-3">{tt("Share of league games that ended in a draw.")}</p>
            </section>
          )}
          {data?.teams && data.teams.length > 0 && (
            <section className="card p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <h2 className="font-display text-lg font-bold text-ink">{tt("Teams that draw the most")}</h2>
                <span className="text-[11px] text-faint">{tt("this season")}</span>
              </div>
              <ul className="divide-y divide-line/50">
                {data.teams.map((t, i) => (
                  <li key={t.team} className="flex items-center gap-3 py-2 text-sm">
                    <span className="w-5 text-faint num text-xs">{i + 1}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-ink font-semibold">{t.team}</span>
                      <span className="block truncate text-[11px] text-faint">{t.league}</span>
                    </span>
                    <span className="text-[11px] text-muted num whitespace-nowrap">{tt("{0} of {1}", { 0: t.d, 1: t.n })}</span>
                    <span className="w-11 text-end num font-bold text-draw">{Math.round(t.rate)}%</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <p className="text-xs text-faint max-w-2xl leading-relaxed">
        {tt("A draw is never a sure thing: even our strongest draw calls come in about 1 time in 3. Probabilities, not promises.")}</p>
    </div>
  )
}

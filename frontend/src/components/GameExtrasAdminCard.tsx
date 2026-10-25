import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/**
 * fix231 (admin): game-page extras — per sport, the upcoming games (next 72 h) with weather / referee / trends / next
 * games, the last worker run (venues looked up, forecasts, referee lists), venues without coordinates. English only.
 */
interface Cov { games: number; games48: number; weatherShould: number; weatherHave: number; weather48Should: number; weather48Have: number; refereeNamed: number; refereeStats: number; trends: number; difficulty: number; indoor: number }
interface Data {
  coverage: { at: string; sports: Record<string, Cov>; missingWeather: string[]; venuesMissing: string[] } | null
  lastRun: { at: string; ms: number; games: Record<string, number>; geocoded: number; weather: { games: number; calls: number }; referees: { lists: number; details: number }; error?: string } | null
  venues: { sport: string; n: number; found: number }[]
  referees: { n: number; detailed: number; leagues: number }
}
const when = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const share = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : '–')

export default function GameExtrasAdminCard() {
  const [d, setD] = useState<Data | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = (run = false) => {
    setBusy(run); setNote(null)
    axios.get(`${API_URL}/admin/game-extras${run ? '?run=1' : ''}`).then(r => setD(r.data.data)).catch(e => setNote(errorText(e))).finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [])
  const c = d?.coverage
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Game extras (weather, referee, trends, next games)</h2>
        <button onClick={() => load(true)} disabled={busy} className="text-xs font-bold text-accent disabled:opacity-50">{busy ? 'Running…' : 'Run now'}</button>
      </div>
      {note && <p className="text-sm text-loss mb-2">{note}</p>}
      {d?.lastRun && (
        <p className="text-xs text-faint mb-3">
          Last run {when(d.lastRun.at)} ({Math.round(d.lastRun.ms / 1000)} s): games {Object.entries(d.lastRun.games).map(([s, n]) => `${s} ${n}`).join(', ')} ·
          {' '}{d.lastRun.geocoded} venues looked up · weather for {d.lastRun.weather.games} games ({d.lastRun.weather.calls} calls) ·
          {' '}referees {d.lastRun.referees.lists} league lists, {d.lastRun.referees.details} games read{d.lastRun.error && <span className="text-loss"> · {d.lastRun.error}</span>}
        </p>
      )}
      {!c ? <p className="text-sm text-faint">Not built yet (every 3 h; first run ~6 min after the start).</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm num">
            <thead><tr className="text-[11px] text-faint text-left">
              <th className="py-1 pr-3 font-normal">Sport</th><th className="pr-3 font-normal">Games 72 h (48 h)</th><th className="pr-3 font-normal">Weather 48 h</th><th className="pr-3 font-normal">Weather 72 h</th>
              <th className="pr-3 font-normal">Indoor</th><th className="pr-3 font-normal">Referee (with stats)</th><th className="pr-3 font-normal">Trends</th><th className="font-normal">Next games</th>
            </tr></thead>
            <tbody>
              {Object.entries(c.sports).map(([s, x]) => (
                <tr key={s} className="border-t border-line">
                  <td className="py-1.5 pr-3 font-semibold text-ink">{s}</td>
                  <td className="pr-3">{x.games} ({x.games48})</td>
                  <td className={`pr-3 ${x.weather48Should && x.weather48Have / x.weather48Should < 0.8 ? 'text-loss' : ''}`}>{share(x.weather48Have, x.weather48Should)}</td>
                  <td className="pr-3">{share(x.weatherHave, x.weatherShould)}</td>
                  <td className="pr-3">{x.indoor}</td>
                  <td className="pr-3">{s === 'football' ? `${x.refereeNamed} (${x.refereeStats})` : 'n/a'}</td>
                  <td className="pr-3">{share(x.trends, x.games)}</td>
                  <td>{share(x.difficulty, x.games)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-faint">Built {when(c.at)}. Venues: {d!.venues.map(v => `${v.sport} ${v.found}/${v.n} found`).join(', ') || 'none yet'} · referee games stored {d!.referees.n} ({d!.referees.detailed} with cards / penalties, {d!.referees.leagues} league seasons).</p>
          {c.venuesMissing.length > 0 && (
            <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">{c.venuesMissing.length} venue(s) without coordinates</summary>
              <ul className="mt-1 space-y-0.5 text-faint">{c.venuesMissing.map(v => <li key={v}>{v}</li>)}</ul></details>
          )}
          {c.missingWeather.length > 0 && (
            <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">{c.missingWeather.length} outdoor game(s) in 48 h without weather</summary>
              <ul className="mt-1 space-y-0.5 text-faint">{c.missingWeather.map(v => <li key={v}>{v}</li>)}</ul></details>
          )}
        </div>
      )}
    </section>
  )
}

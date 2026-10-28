import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/**
 * fix215 admin: the season forecast — every league's last run (runs, time, games left, rules used), the leagues not
 * simulated and why, and last season's week-by-week replay (Brier of the title / zone / relegation chances against
 * the "current table order" baseline). Admin text is English only.
 */
interface Row { sport: string; code: string; name: string; season: string; run_at: string; runs: number; ms: number; games_left: number; known: boolean; last_final: string | null; note: string; rules: any }
interface Acc { sport: string; code: string; season: string; steps: number; n: number; sim: Record<string, number>; base: Record<string, number>; simAll: number; baseAll: number; at: string }
interface Data {
  status: { running: boolean; lastAt: string | null; lastLeagues: number; lastMs: number; lastError: string | null; dirty: { league: string; since: string }[] }
  leagues: Row[]; skipped: { sport: string; code: string; name: string; reason: string; at: string }[]
  accuracy: { leagues: Acc[]; sports: Record<string, { sim: number; base: number; n: number; beats: boolean }> }
}

const ago = (iso: string | null) => { if (!iso) return '—'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
const rulesText = (r: any) => !r ? '—' : [
  r.tiebreaks?.join(' › '),
  r.zones?.map((z: any) => `${z.key} ${z.from}${z.to !== z.from ? `–${z.to}` : ''}`).join(', '),
  r.split ? `split after ${r.split.after}${r.split.halve ? ` (halved ${r.split.halve})` : ''}` : '',
  r.post ? `post: ${r.post.kind}${r.post.seeds ? ` ${r.post.seeds}${r.post.playIn ? ' + play-in' : ''} bo ${r.post.bestOf?.join('/')}` : ''}` : ''
].filter(Boolean).join(' · ')

export default function SeasonForecastAdminCard() {
  const [d, setD] = useState<Data | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/admin/season-forecast`).then(r => setD(r.data.data)).catch(() => setD(null))
  useEffect(() => { load() }, [])
  if (!d) return null
  const run = (q: string, note: string) => axios.post(`${API_URL}/admin/season-forecast/run${q}`).then(() => { setMsg(note); setTimeout(load, 5000) }).catch(e => setMsg(errorText(e)))
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Season forecast (fix215)</h2>
        <span className="text-xs text-faint">{d.status.running ? 'running now · ' : ''}last run {ago(d.status.lastAt)} · {d.status.lastLeagues} league(s) in {Math.round(d.status.lastMs / 1000)} s{d.status.lastError ? ` · error: ${d.status.lastError}` : ''}</span>
      </div>
      <p className="text-sm text-muted">20,000 runs per league, 10 min after each finished game (5-min check) and nightly at 02:00 UTC. Waiting: {d.status.dirty.length ? d.status.dirty.map(x => x.league).join(', ') : 'none'}.</p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button type="button" className="px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink" onClick={() => run('', 'Every league queued (a few minutes).')}>Run every league</button>
        <button type="button" className="px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink" onClick={() => run('?accuracy=1', 'Last season replay queued (several minutes).')}>Replay last season</button>
      </div>
      {msg && <p className="mt-2 text-xs text-accent">{msg}</p>}

      <h3 className="mt-4 text-sm font-bold text-ink">Accuracy (last season, admin only)</h3>
      <div className="mt-1 flex flex-wrap gap-3 text-sm">
        {Object.entries(d.accuracy.sports).map(([s, a]) => (
          <span key={s} className={a.beats ? 'text-win' : 'text-loss'}>{s}: Brier {a.sim.toFixed(4)} vs table {a.base.toFixed(4)} ({a.n})</span>
        ))}
        {!Object.keys(d.accuracy.sports).length && <span className="text-faint">No replay yet (Mondays 03:00 UTC).</span>}
      </div>
      {d.accuracy.leagues.length > 0 && (
        <ul className="mt-1 text-xs text-muted space-y-0.5">
          {d.accuracy.leagues.map(a => (
            <li key={`${a.sport}${a.code}`} className="num">{a.sport} {a.code} {a.season}: {a.steps} weeks · {Object.keys(a.sim).map(k => `${k} ${a.sim[k]} / ${a.base[k]}`).join(' · ')}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-xs num">
          <thead><tr className="text-faint text-start"><th className="py-1 pe-2">League</th><th className="pe-2">Season</th><th className="pe-2">Run</th><th className="pe-2">Runs</th><th className="pe-2">Time</th><th className="pe-2">Games left</th><th className="pe-2">Rules</th><th>Inputs</th></tr></thead>
          <tbody className="divide-y divide-line/50">
            {d.leagues.map(r => {
              const k = `${r.sport}|${r.code}`
              return (
                <tr key={k} className="align-top cursor-pointer" onClick={() => setOpen(open === k ? null : k)}>
                  <td className="py-1.5 pe-2 text-ink">{r.sport} · {r.name || r.code}</td>
                  <td className="pe-2">{r.season}</td>
                  <td className="pe-2">{ago(r.run_at)}</td>
                  <td className="pe-2">{r.runs.toLocaleString('en-GB')}</td>
                  <td className="pe-2">{r.ms} ms</td>
                  <td className="pe-2">{r.games_left}</td>
                  <td className={`pe-2 ${r.known ? '' : 'text-loss'}`}>{r.known ? (open === k ? rulesText(r.rules) : 'known') : 'no zones'}</td>
                  <td className="text-muted">{r.note}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {d.skipped.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-bold text-ink">Not simulated</h3>
          <ul className="mt-1 text-xs text-muted space-y-0.5">{d.skipped.map(s => <li key={`${s.sport}${s.code}`}>{s.sport} · {s.name || s.code}: {s.reason}</li>)}</ul>
        </>
      )}
    </section>
  )
}

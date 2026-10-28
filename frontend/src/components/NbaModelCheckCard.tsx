import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { slAdmin } from '../lib/modelNames'
import { matchHref } from '../lib/links'

type Score = { games: number; logLoss: number; brier: number; hitRate: number }
type Removed = { id: number; name: string; status: string; min: number; keep: number }
type LogRow = {
  gameId: number; kickoff: string; home: string; away: string; score: string | null; checkpoint: string; at: string; mode: string
  pV3: number | null; pV4: number; marginBefore: number | null; marginAfter: number; sameDay: number; lineups: boolean
  removed: { home: Removed[]; away: Removed[] } | null
}
type Check = {
  mode: 'full' | 'reprice' | 'off'; override: string | null; built: string | null; params: Record<string, number>; suggested: Record<string, number> | null
  fit: { at: string | null; players: number; games: number } | null
  gate: null | {
    pass: boolean; reason: string
    test: { season: string; whole: { v3: Score; v4: Score }; first25: { v3: Score; v4: Score }; withLineups: { v3: Score; v4: Score }; passWhole: boolean; passFirst25: boolean }
    live: { games: number; v3: Score; v4: Score; pass: boolean; note: string }
  }
  side: { games: number; current: Score; v4: Score }
  best: { id: number; name: string; rating: number; minutes: number | null }[]
  log: LogRow[]
}

const pct = (p: number | null) => (p === null ? '—' : `${Math.round(p * 100)}%`)
const ll = (s: Score) => (s.games ? s.logLoss.toFixed(4) : '—')

/** fix217 (admin): NBA model check — v4 mode and gate, the latest player fit, side by side, every re-pricing before tip-off. */
export default function NbaModelCheckCard() {
  const [d, setD] = useState<Check | null>(null)
  useEffect(() => { axios.get(`${API_URL}/admin/nba-model-check`).then(r => setD(r.data.data)).catch(() => setD(null)) }, [])
  if (!d) return null
  const g = d.gate
  const row = (label: string, a: { v3: Score; v4: Score }, ok?: boolean) => (
    <tr className="border-t border-line/50">
      <td className="py-1.5 pe-3 text-muted">{label}</td>
      <td className="py-1.5 pe-3 num">{a.v4.games}</td>
      <td className="py-1.5 pe-3 num">{ll(a.v3)} · {a.v3.games ? `${a.v3.hitRate}%` : '—'}</td>
      <td className={`py-1.5 pe-3 num font-semibold ${ok === undefined ? 'text-ink' : ok ? 'text-win' : 'text-loss'}`}>{ll(a.v4)} · {a.v4.games ? `${a.v4.hitRate}%` : '—'}</td>
    </tr>
  )
  const names = (l: Removed[]) => l.map(p => `${p.name} (${p.min} min${p.keep > 0 ? `, ${Math.round(p.keep * 100)}%` : ''}${p.status ? `, ${p.status}` : ''})`).join(', ')
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">NBA model check</h2>
        <span className="text-xs text-faint">re-priced 90, 30 and 10 min before tip-off · built {d.built ? new Date(d.built).toLocaleString('en-GB') : 'not yet'}</span>
      </div>
      <p className="text-sm text-muted">
        In use: <b className={d.mode === 'full' ? 'text-win' : 'text-ink'}>{d.mode === 'full' ? slAdmin('bb-v4') : d.mode === 'reprice' ? `${slAdmin('bb-v3')} + v4 injury / line-up re-pricing` : `${slAdmin('bb-v3')} (v4 off)`}</b>
        {d.override ? ` · NBA_V4=${d.override}` : ''}{g ? ` · ${g.reason}` : ''}
      </p>
      {d.fit && <p className="text-xs text-faint mt-1">Player fit {d.fit.at ? new Date(d.fit.at).toLocaleDateString('en-GB') : '—'} · {d.fit.players} players · {d.fit.games} games (refit every 14 days)</p>}
      {g && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-faint text-start"><th className="pb-1 pe-3 font-normal">Gate (log loss · picks right)</th><th className="pb-1 pe-3 font-normal">games</th><th className="pb-1 pe-3 font-normal">bb-v3</th><th className="pb-1 pe-3 font-normal">v4</th></tr></thead>
            <tbody>
              {row(`${g.test.season} whole season (no worse)`, g.test.whole, g.test.passWhole)}
              {row(`${g.test.season} games 1–25 (better)`, g.test.first25, g.test.passFirst25)}
              {row(`This season, out of sample (better) — ${g.live.note}`, g.live, g.live.pass)}
              {row(`${g.test.season} if we knew who plays (stand-in for the injury report)`, g.test.withLineups)}
              {d.side.games > 0 && row('Saved before tip-off, side by side', { v3: d.side.current, v4: d.side.v4 })}
            </tbody>
          </table>
        </div>
      )}
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">Settings and top-rated players</summary>
        <p className="mt-2 num break-words">In use: {Object.entries(d.params).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>
        {d.suggested && <p className="mt-1 num break-words">Tuner on this database (2023-24 + 2024-25, not applied): {Object.entries(d.suggested).map(([k, v]) => `${k} ${v}`).join(' · ')}</p>}
        <p className="mt-2">{d.best.map(p => `${p.name} ${p.rating > 0 ? '+' : ''}${p.rating}${p.minutes ? ` (${p.minutes} min)` : ''}`).join(' · ')}</p>
      </details>
      <ul className="mt-3 divide-y divide-line/50 text-sm">
        {d.log.length === 0 && <li className="py-2 text-sm text-faint">No re-pricing logged yet (it runs 90 minutes before each NBA tip-off).</li>}
        {d.log.slice(0, 120).map(x => {
          const out = x.removed ? [...x.removed.home.map(p => ({ ...p, team: x.home })), ...x.removed.away.map(p => ({ ...p, team: x.away }))] : []
          const moved = x.marginBefore === null ? null : Math.round((x.marginAfter - x.marginBefore) * 10) / 10
          return (
            <li key={`${x.gameId}-${x.checkpoint}`} className="py-2">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="w-24 text-[11px] text-faint num">{new Date(x.kickoff).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="text-[11px] text-faint num w-12">−{x.checkpoint} min</span>
                <Link to={matchHref('basketball', x.gameId, { home: x.home, away: x.away, date: x.kickoff })!} className="font-semibold text-ink hover:underline">{x.home} – {x.away}</Link>
                {x.score && <span className="text-xs text-muted num">{x.score}</span>}
                <span className="text-xs num text-muted">home {pct(x.pV3)} → <b className="text-ink">{pct(x.pV4)}</b> · margin {x.marginAfter > 0 ? '+' : ''}{x.marginAfter}{moved !== null && moved !== 0 ? ` (${moved > 0 ? '+' : ''}${moved} since last save)` : ''} · same-day {x.sameDay > 0 ? '+' : ''}{x.sameDay}{x.lineups ? ' · line-ups' : ''}</span>
              </div>
              {out.length > 0 && <p className="text-[11px] text-muted mt-0.5 break-words">Removed: {x.removed && x.removed.home.length > 0 && <>{x.home}: {names(x.removed.home)}. </>}{x.removed && x.removed.away.length > 0 && <>{x.away}: {names(x.removed.away)}.</>}</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

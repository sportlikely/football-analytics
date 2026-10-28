import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { useBbConfig } from '../../lib/bb'
import { Card, Skeleton } from './parts'

interface M { games: number; hitRate?: number; homeWinRate?: number; logLoss?: number; brier?: number; maeMargin?: number; maeTotal?: number }
interface Row { code: string; params: { k: number; r: number; b2b: number }; tuneSeason: string; testSeasons: string[]; tune: M; test: { all: M; bySeason: Record<string, M> }; now: { avgPoints: number; homeEdge: number; sigma: number; sigmaTotal: number }; builtAt: string }

/** Admin only: how bb-v1 did on seasons it never saw (internal, English only). */
export default function BbPast() {
  const cfg = useBbConfig()
  const [rows, setRows] = useState<Row[] | null>(null)
  useEffect(() => { axios.get(`${API_URL}/bb/backtest`).then(r => setRows(r.data.data || [])).catch(() => setRows([])) }, [])
  const name = (c: string) => cfg?.leagues.find(l => l.code === c)?.name || c
  const line = (label: string, m: M) => (
    <tr key={label} className="border-t border-line/50">
      <td className="py-1.5 text-ink">{label}</td>
      <td className="text-end num">{m.games}</td>
      <td className="text-end num font-bold text-ink">{m.hitRate ?? '–'}%</td>
      <td className="text-end num text-muted">{m.homeWinRate ?? '–'}%</td>
      <td className="text-end num text-muted">{m.logLoss ?? '–'}</td>
      <td className="text-end num text-muted">{m.brier ?? '–'}</td>
      <td className="text-end num text-muted">{m.maeMargin ?? '–'}</td>
      <td className="text-end num text-muted">{m.maeTotal ?? '–'}</td>
    </tr>
  )
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6 pb-28 xl:pb-10">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-ink">Basketball · past seasons (admin)</h1>
        <p className="mt-1 text-sm text-muted">bb-v1: settings chosen on the tuning season, then tested on later seasons it never saw. Pre-season left out. Reference: bookmaker favourite wins ~66–74% in the NBA.</p>
      </div>
      {!rows ? <Skeleton rows={4} h="h-32" /> : rows.map(r => (
        <Card key={r.code} title={`${name(r.code)} · k ${r.params.k} · season carry-over ${r.params.r} · back-to-back ${r.params.b2b} pts`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm">
              <thead><tr className="text-faint text-[11px]"><th className="text-start font-semibold">Season</th><th className="text-end font-semibold">Games</th><th className="text-end font-semibold">Hit</th><th className="text-end font-semibold">Home wins</th><th className="text-end font-semibold">Log loss</th><th className="text-end font-semibold">Brier</th><th className="text-end font-semibold">Margin miss</th><th className="text-end font-semibold">Total miss</th></tr></thead>
              <tbody>
                {line(`${r.tuneSeason} (tuning)`, r.tune)}
                {Object.entries(r.test.bySeason).map(([s, m]) => line(s, m))}
                {line('All test seasons', r.test.all)}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-faint">Now: {r.now.avgPoints} pts per team, home edge {r.now.homeEdge}, typical margin miss {r.now.sigma}, total miss {r.now.sigmaTotal}. Built {new Date(r.builtAt).toLocaleString('en-GB')}.</p>
        </Card>
      ))}
    </div>
  )
}

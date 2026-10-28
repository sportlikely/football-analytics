import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { Card, Skeleton } from '../bb/parts'

interface M { n: number; hit: number | null; logLoss: number | null; brier?: number | null }
interface Tour { model: M; baselines: { eloOnly: M; pointModelOnly: M; higherRanked: M }; setsAndTotals: { likelySetScoreHit: number | null; totalGamesMAE: number | null } }
interface Report {
  model: string; builtAt: string; test: { from: string; to: string; months: number; matches: number }
  tours: Record<string, Tour>; surfaces?: Record<string, Tour>; strong: Record<string, { line: number; reached: boolean }>
  months: { month: string; n: number; hit: number | null; logLoss: number | null }[]
}

/**
 * Admin only (fix193c, like the other sports' Past seasons): how the tennis model did on months it never saw —
 * walk-forward, each month predicted with settings tuned on the months before it. Internal, English only.
 * The full report (with the market benchmark) is /api/admin/tennis-model.
 */
export default function TennisPast() {
  const [d, setD] = useState<{ model: string; ready: boolean; running: boolean; report: Report | null } | null | undefined>(undefined)
  useEffect(() => { axios.get(`${API_URL}/tennis-past`).then(r => setD(r.data.data)).catch(() => setD(null)) }, [])
  const row = (label: string, x: Tour) => (
    <tr key={label} className="border-t border-line/50">
      <td className="py-1.5 text-ink">{label}</td>
      <td className="text-end num">{x.model.n}</td>
      <td className="text-end num font-bold text-ink">{x.model.hit ?? '–'}%</td>
      <td className="text-end num text-muted">{x.model.logLoss ?? '–'}</td>
      <td className="text-end num text-muted">{x.baselines.eloOnly.logLoss ?? '–'}</td>
      <td className="text-end num text-muted">{x.baselines.higherRanked.hit ?? '–'}%</td>
      <td className="text-end num text-muted">{x.setsAndTotals.likelySetScoreHit ?? '–'}%</td>
      <td className="text-end num text-muted">{x.setsAndTotals.totalGamesMAE ?? '–'}</td>
    </tr>
  )
  const table = (title: string, rows: Record<string, Tour> | undefined) => rows && (
    <Card title={title}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead><tr className="text-faint text-[11px]"><th className="text-start font-semibold">Group</th><th className="text-end font-semibold">Matches</th><th className="text-end font-semibold">Hit</th><th className="text-end font-semibold">Log loss</th><th className="text-end font-semibold">Elo-only LL</th><th className="text-end font-semibold">Higher rank</th><th className="text-end font-semibold">Set score</th><th className="text-end font-semibold">Games MAE</th></tr></thead>
          <tbody>{Object.entries(rows).filter(([, x]) => x?.model?.n).map(([k, x]) => row(k, x))}</tbody>
        </table>
      </div>
    </Card>
  )
  const r = d?.report
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6 pb-28 xl:pb-10">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl font-extrabold text-ink">Tennis · past seasons (admin)</h1>
        <p className="mt-1 text-sm text-muted">Walk-forward: each test month is predicted with settings tuned only on the months before it. Picks saved before the first serve count in the public record from launch day on; these months never do.</p>
      </div>
      {d === undefined ? <Skeleton rows={4} h="h-32" /> : !r ? (
        <Card title="No report yet"><p className="text-sm text-muted">{d?.running ? 'The model is being built on the server.' : 'The report is built on the server once the history backfill is in (open /api/admin/tennis-model).'}</p></Card>
      ) : <>
        <p className="text-sm text-muted">{r.model} · test {r.test.from} – {r.test.to} ({r.test.months} months, {r.test.matches.toLocaleString('en-GB')} matches) · built {new Date(r.builtAt).toLocaleString('en-GB')}</p>
        {table('By tour', r.tours)}
        {table('By surface', r.surfaces)}
        <Card title="Strong pick lines">
          <p className="text-sm text-ink">{Object.entries(r.strong).map(([k, v]) => `${k} ${v.line}%${v.reached ? '' : ' (75% not reached)'}`).join(' · ')}</p>
        </Card>
        <Card title="By month">
          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm">
              <thead><tr className="text-faint text-[11px]"><th className="text-start font-semibold">Month</th><th className="text-end font-semibold">Matches</th><th className="text-end font-semibold">Hit</th><th className="text-end font-semibold">Log loss</th></tr></thead>
              <tbody>{r.months.map(m => <tr key={m.month} className="border-t border-line/50"><td className="py-1 text-ink">{m.month}</td><td className="text-end num">{m.n}</td><td className="text-end num">{m.hit ?? '–'}%</td><td className="text-end num text-muted">{m.logLoss ?? '–'}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
      </>}
    </div>
  )
}

import { t, ltr } from '../../../lib/i18n'

/** fix219: what the backend sends (backend/src/utils/bbGridMath.ts GridView) */
export interface GridView {
  rows: { id: string; key: string; home: number; away: number; rel: number; edge: number }[]
  points: { home: number; away: number }
  unused: string[]
  volatility: number | null
  margin: number
  sigma: number
}

/** Row names (keys from bbGridMath GRID_ROWS), translated here. */
const ROW_NAME: Record<string, string> = {
  impact: 'Player impact of the expected rotation',
  net100: 'Net rating per 100 possessions',
  team: 'Team rating (points, possessions, talent)',
  missing: 'Missing players',
  fourFactors: 'Four factors (shooting, turnovers, rebounds, free throws)',
  rest: 'Rest (back-to-back, 3 games in 4 days)',
  home: 'Home court',
  carry: 'Season carry-over (players who stayed)',
  matchup: 'Matchups (style against style)',
  form: 'Form: last 10 games against expectation',
  motivation: 'Motivation (late-season tanking)',
  volatility: '3-point volatility',
  h2h: 'Head-to-head'
}
const rowName = (key: string) => t(ROW_NAME[key] || key)
const num = (x: number) => (Math.abs(x) >= 10 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString())

/**
 * fix219: the model's "1,000 points split" (football's grid table, for the grid sports): each factor's value for both
 * teams, its share of the fitted split (Rel.) and the points it moves toward one side (Edge). Rows with weight 0 are
 * hidden and named in the footnote.
 */
export default function GridSplit({ grid, home, away }: { grid: GridView; home: string; away: string }) {
  return (
    <div className="mt-5 rounded-xl border border-line/70 bg-surface/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="text-xs font-semibold text-ink">{t('Our 13 factors: 1,000 points split')}</div>
        <div className="num text-xs text-muted">
          <span className="text-home font-semibold">{grid.points.home}</span> · <span className="text-away font-semibold">{grid.points.away}</span> <span className="text-faint">/ 1000</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-faint">
              <th className="text-start font-medium py-1">{t('Parameter')}</th>
              <th className="text-end font-medium py-1 w-12">{t('Rel.')}</th>
              <th className="text-end font-medium py-1 w-16 truncate max-w-[4rem]">{home}</th>
              <th className="text-end font-medium py-1 w-16 truncate max-w-[4rem]">{away}</th>
              <th className="text-end font-medium py-1 w-14">{t('Edge')}</th>
            </tr>
          </thead>
          <tbody>
            {grid.rows.map(r => (
              <tr key={r.id} className="border-t border-line/40">
                <td className="py-1 pe-2 text-muted">{rowName(r.key)}</td>
                <td className="py-1 text-end num text-faint">{r.rel}</td>
                <td className="py-1 text-end num text-ink">{num(r.home)}</td>
                <td className="py-1 text-end num text-ink">{num(r.away)}</td>
                <td className={`py-1 text-end num font-semibold ${r.edge > 0 ? 'text-home' : r.edge < 0 ? 'text-away' : 'text-faint'}`}>{ltr(`${r.edge > 0 ? '+' : ''}${r.edge}`)}</td>
              </tr>
            ))}
            <tr className="border-t border-line/70 font-semibold">
              <td className="py-1 text-ink">{t('Total')}</td>
              <td />
              <td className="py-1 text-end num text-ink">{grid.points.home}</td>
              <td className="py-1 text-end num text-ink">{grid.points.away}</td>
              <td className={`py-1 text-end num ${grid.points.home >= grid.points.away ? 'text-home' : 'text-away'}`}>{grid.points.home - 500 > 0 ? '+' : ''}{grid.points.home - 500}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {grid.volatility !== null && grid.volatility > 0.05 && <p className="mt-2 text-[11px] text-muted">{t('Both teams take many 3-pointers: this game is harder to call, so the chances sit closer to 50%.')}</p>}
      <p className="mt-3 text-[11px] text-faint">
        {t('Each factor is measured for both teams before tip-off and weighted by how much it predicted results over three seasons (2022-23 to 2024-25), then checked on 2025-26. Edge = how many points (out of 1000) that factor moves toward one side.')}
        {grid.unused.length > 0 && <> {t('Measured but not used, because they add nothing once the others are in:')} {grid.unused.map(rowName).join(', ')}.</>}
      </p>
    </div>
  )
}

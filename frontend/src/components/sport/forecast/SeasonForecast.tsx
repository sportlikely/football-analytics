import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { t, LOCALE } from '../../../lib/i18n'
import { useLeagueForecast, zoneLabel, tableZones, pct, rowPct, BAD_ZONE, type FcSport, type FcTeam, type FcLeague, type FcExtremes } from '../../../lib/seasonForecast'
import { LCard, Lines } from '../page/LeaguePage'

/**
 * fix215: the league page's "Season forecast" tab, every sport. The rest of the season played 20,000 times with our
 * match model: each team's average points (wins), average final place and the chance of each zone of the league
 * (title, Champions League, play-offs, relegation …), and on demand every position's chance as a heat map.
 * Free: the forecast's top three and bottom three + your favourite teams; Pro: every team.
 */
export default function SeasonForecast({ sport, code, teamHref }: { sport: FcSport; code: string; teamHref: (id: string, name: string) => string }) {
  const { data, loading } = useLeagueForecast(sport, code)
  const [heat, setHeat] = useState(false)
  if (loading && !data) return <LCard title={t('Season forecast')}><Lines n={8} /></LCard>
  if (!data) return (
    <LCard title={t('Season forecast')}>
      <p className="text-sm text-muted">{t('No season forecast for this league yet. It appears once the season has games left and our model has rated the teams.')}</p>
    </LCard>
  )
  const groups = data.groups.length ? data.groups : ['']
  const open = data.teams.filter(x => !x.locked)
  return (
    <div data-testid="season-forecast">
    <LCard title={t('Season forecast')} action={open.length > 0 && (
      <div className="seg">
        <button onClick={() => setHeat(false)} className={`seg-btn ${!heat ? 'seg-btn-active' : ''}`}>{t('Chances')}</button>
        <button data-testid="forecast-heat" onClick={() => setHeat(true)} className={`seg-btn ${heat ? 'seg-btn-active' : ''}`}>{t('Every position')}</button>
      </div>
    )}>
      <p className="text-xs text-muted mb-4">
        {t('The rest of the season played {0} times with our match model. Probabilities, not promises.', { 0: data.runs.toLocaleString(LOCALE) })}{' '}
        <span className="text-faint">{t('Updated {0}', { 0: new Date(data.runAt).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) })}</span>
      </p>
      {!data.known && (
        // fix230: say why there are no title / play-off / relegation columns
        <p data-testid="forecast-no-zones" className="-mt-2 mb-4 text-xs text-muted rounded-lg border border-line px-3 py-2">
          {data.pending === 'replay'
            ? t('Play-off format added: its chances appear once our check on last season passes. Until then, final positions only.')
            : t('Play-off format not added yet: final positions only.')}
        </p>
      )}
      <div className="space-y-6">
        {groups.map(g => {
          const rows = data.teams.filter(x => (x.group || '') === g)
          return (
            <div key={g} className="min-w-0">
              {groups.length > 1 && <h3 className="text-sm font-bold text-ink mb-2">{g}</h3>}
              {heat ? <HeatMap rows={rows} teamHref={teamHref} extremes={data.extremes} /> : <ChanceTable data={data} rows={rows} teamHref={teamHref} />}
            </div>
          )
        })}
      </div>
      {!data.full && data.locked > 0 && (
        <div className="mt-4 rounded-xl border border-accent/40 bg-accent/5 p-3 text-sm flex flex-wrap items-center justify-between gap-3">
          <span className="text-muted">{t('Free shows the top three, the bottom three and your favourite teams. Pro shows every team.')}</span>
          <Link to="/premium" className="px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-bold">{t('See Pro')}</Link>
        </div>
      )}
    </LCard>
    </div>
  )
}

function Name({ x, teamHref }: { x: FcTeam; teamHref: (id: string, name: string) => string }) {
  return (
    <Link to={teamHref(x.id, x.name)} className="flex items-center gap-2 min-w-0 hover:text-accent">
      {x.logo && <img src={x.logo} alt="" className="w-5 h-5 object-contain flex-shrink-0" loading="lazy" />}
      <span className="truncate">{x.name}</span>
    </Link>
  )
}
const nowText = (sport: FcSport, x: FcTeam) => sport === 'football' ? String(x.now.pts) : `${x.now.w}–${x.now.l}${x.now.d ? `–${x.now.d}` : ''}`

function ChanceTable({ data, rows, teamHref }: { data: FcLeague; rows: FcTeam[]; teamHref: (id: string, name: string) => string }) {
  const extremes = data.extremes
  const zones = tableZones(data.zones)
  const sport = data.sport
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="w-full text-sm num">
        <thead>
          <tr className="text-[11px] text-faint text-right">
            <th className="text-left font-medium py-1.5 pr-2 w-6">#</th>
            <th className="text-left font-medium py-1.5">{t('Team')}</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">{sport === 'football' ? t('Points now') : t('Record now')}</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">{sport === 'football' ? t('Avg points') : t('Avg wins')}</th>
            <th className="font-medium py-1.5 px-2 whitespace-nowrap">{t('Avg place')}</th>
            {zones.map(z => <th key={z} className="font-medium py-1.5 px-2 whitespace-nowrap">{zoneLabel(z, sport)}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((x, i) => (
            <tr key={x.id} className={x.locked ? 'text-faint' : ''}>
              <td className="py-2 pr-2 text-faint">{x.locked ? x.now.rank : i + 1}</td>
              <td className="py-2 min-w-[7rem] max-w-[9rem] sm:max-w-[14rem]"><Name x={x} teamHref={teamHref} /></td>
              <td className="py-2 px-2 text-right text-muted">{nowText(sport, x)}</td>
              {x.locked ? (
                <td colSpan={2 + zones.length} className="py-2 px-2 text-right" aria-label={t('Pro')}>
                  <span className="inline-block blur-[5px] opacity-60 select-none" aria-hidden>{zones.map(() => '00%').join('  ')} 00.0</span>
                </td>
              ) : (
                <>
                  <td className="py-2 px-2 text-right">{x.avgPts?.toFixed(1)}</td>
                  <td className="py-2 px-2 text-right">{x.avgPos?.toFixed(1)}</td>
                  {zones.map(z => {
                    const v = x.zones?.[z] ?? 0
                    return (
                      <td key={z} className="py-2 px-2 text-right">
                        <span className={`inline-block min-w-[2.75rem] rounded-md px-1.5 py-0.5 ${v >= 0.005 ? (BAD_ZONE(z) ? 'text-loss' : 'text-ink') : 'text-faint'}`}
                          style={v >= 0.005 ? { background: `rgb(var(--${BAD_ZONE(z) ? 'loss' : 'accent'}) / ${Math.min(0.35, v * 0.35 + 0.04)})` } : undefined}>{pct(v, extremes)}</span>
                      </td>
                    )
                  })}
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HeatMap({ rows, teamHref, extremes }: { rows: FcTeam[]; teamHref: (id: string, name: string) => string; extremes?: FcExtremes }) {
  const open = rows.filter(x => !x.locked && x.pos)
  const n = Math.max(0, ...open.map(x => x.pos!.length))
  if (!open.length) return <p className="text-sm text-muted">{t('Pro shows every position for every team.')}</p>
  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <table className="text-[11px] num border-separate border-spacing-0.5">
        <thead>
          <tr className="text-faint">
            <th className="text-left font-medium pr-2 sticky left-0 bg-surface">{t('Team')}</th>
            {Array.from({ length: n }, (_, k) => <th key={k} className="font-medium w-8 text-center">{k + 1}</th>)}
          </tr>
        </thead>
        <tbody>
          {open.map(x => {
            const whole = rowPct(x.pos!) // fix218: the row adds up to 100
            return (
            <Fragment key={x.id}>
              <tr>
                <td className="pr-2 sticky left-0 bg-surface min-w-[7rem] max-w-[10rem]"><Name x={x} teamHref={teamHref} /></td>
                {x.pos!.map((p, k) => (
                  <td key={k} className="w-8 h-7 text-center rounded" title={`${x.name} · ${k + 1} · ${pct(p, extremes)}`}
                    style={{ background: p > 0 ? `rgb(var(--accent) / ${Math.min(0.85, p * 1.6)})` : undefined, color: p > 0.4 ? 'rgb(var(--bg))' : undefined }}>
                    {whole[k] > 0 ? whole[k] : ''}
                  </td>
                ))}
              </tr>
            </Fragment>
          )})}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-faint">{t('Each cell: the chance (%) of finishing in that position.')}</p>
    </div>
  )
}

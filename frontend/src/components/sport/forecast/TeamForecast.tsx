import { useState } from 'react'
import { Link } from 'react-router-dom'
import { t, LOCALE } from '../../../lib/i18n'
import { useTeamForecast, zoneLabel, tableZones, pct, BAD_ZONE, type FcSport, type FcTeamCard, type ZoneKey } from '../../../lib/seasonForecast'
import { TCard } from '../page/TeamPage'

/**
 * fix215: the team page's "Season forecast" card, every sport: the chance of each zone of the team's league, the
 * average final place and points, and a small chart of how the title / relegation (or play-off) chance moved over the
 * season (one point a day). Free: shown for the forecast's top three / bottom three and your favourite teams.
 */
export default function TeamForecast({ sport, id, leagueHref }: { sport: FcSport; id: string | number; leagueHref: (code: string) => string }) {
  const { data } = useTeamForecast(sport, id)
  if (!data || !data.length) return null
  return <div data-testid="team-forecast" className="space-y-6">{data.map(c => <Card key={c.code} c={c} sport={sport} leagueHref={leagueHref} />)}</div>
}

function Card({ c, sport, leagueHref }: { c: FcTeamCard; sport: FcSport; leagueHref: (code: string) => string }) {
  const zones = tableZones(c.zones)
  const action = <Link to={`${leagueHref(c.code)}#forecast`} className="text-xs font-bold text-accent">{t('Whole table →')}</Link>
  if (c.team.locked) return (
    <TCard title={t('Season forecast')} action={action}>
      <p className="text-sm text-muted">{t('Pro shows the season forecast for every team. Free shows the top three, the bottom three and your favourite teams.')}</p>
      <Link to="/premium" className="mt-3 inline-block px-3 py-1.5 rounded-lg bg-accent text-bg text-xs font-bold">{t('See Pro')}</Link>
    </TCard>
  )
  const x = c.team
  // the chart: the best zone and the worst one this league has (title / relegation, else play-offs)
  const lines = ([zones.find(z => !BAD_ZONE(z)), zones.find(z => BAD_ZONE(z))].filter(Boolean) as ZoneKey[]).slice(0, 2)
  return (
    <TCard title={t('Season forecast')} action={action}>
      <p className="text-xs text-muted mb-3">{c.league} · {t('{0} simulations of the rest of the season', { 0: c.runs.toLocaleString(LOCALE) })}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Tile label={t('Avg place')} value={x.avgPos?.toFixed(1) || '–'} sub={t('of {0}', { 0: c.size })} />
        <Tile label={sport === 'football' ? t('Avg points') : t('Avg wins')} value={x.avgPts?.toFixed(1) || '–'} />
        {zones.map(z => <Tile key={z} label={zoneLabel(z, sport)} value={pct(x.zones?.[z])} bad={BAD_ZONE(z)} />)}
      </div>
      {lines.length > 0 && c.history.length >= 2 && <Trend history={c.history} zones={lines} sport={sport} />}
    </TCard>
  )
}

function Tile({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <div className="glass px-3 py-2.5">
      <div className="text-[11px] text-faint">{label}</div>
      <div className={`font-display text-xl font-extrabold num ${bad ? 'text-loss' : 'text-ink'}`}>{value}{sub && <span className="ml-1 text-xs font-medium text-faint">{sub}</span>}</div>
    </div>
  )
}

const COLORS = ['accent', 'loss']
/** a small line chart of the zone chances over the season (0–100%), one point a day */
function Trend({ history, zones, sport }: { history: FcTeamCard['history']; zones: ZoneKey[]; sport: FcSport }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 320, H = 110, padL = 30, padR = 10, padT = 10, padB = 20
  const pts = history.slice(-120)
  const x = (i: number) => padL + (i / Math.max(1, pts.length - 1)) * (W - padL - padR)
  const y = (v: number) => padT + (1 - v) * (H - padT - padB)
  const h = hover !== null ? pts[hover] : null
  const day = (d: string) => new Date(d).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-3 text-[11px] text-muted mb-1">
        {zones.map((z, k) => <span key={z} className="flex items-center gap-1.5"><span className={`w-3 h-0.5 rounded ${k ? 'bg-loss' : 'bg-accent'}`} />{zoneLabel(z, sport)}</span>)}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
          aria-label={zones.map(z => `${zoneLabel(z, sport)}: ${pts.map(p => `${day(p.day)} ${pct(p.zones[z])}`).join(', ')}`).join('; ')}>
          {[0, 0.5, 1].map(v => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="rgb(var(--line))" strokeWidth="1" strokeDasharray={v === 0 ? undefined : '2 4'} />
              <text x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="rgb(var(--faint))">{Math.round(v * 100)}%</text>
            </g>
          ))}
          {zones.map((z, k) => (
            <path key={z} d={pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.zones[z] ?? 0).toFixed(1)}`).join(' ')}
              fill="none" stroke={`rgb(var(--${COLORS[k]}))`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          <text x={padL} y={H - 5} fontSize="9" fill="rgb(var(--faint))">{day(pts[0].day)}</text>
          <text x={W - padR} y={H - 5} textAnchor="end" fontSize="9" fill="rgb(var(--faint))">{t('Now')}</text>
          {pts.map((p, i) => (
            <rect key={p.day} x={x(i) - (W - padL - padR) / pts.length / 2} y={0} width={(W - padL - padR) / pts.length} height={H} fill="transparent"
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
          ))}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="rgb(var(--faint))" strokeWidth="1" />}
        </svg>
        {h && (
          <div className="absolute -top-2 pointer-events-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] shadow-lift whitespace-nowrap"
            style={{ left: `${(x(hover!) / W) * 100}%`, transform: 'translate(-50%, -100%)' }}>
            <div className="font-bold text-ink">{day(h.day)}</div>
            {zones.map(z => <div key={z} className="text-muted">{zoneLabel(z, sport)} {pct(h.zones[z])}</div>)}
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { t, LOCALE } from '../../lib/i18n'
import { tennisHref, flagOf } from '../../lib/tennis'
import { Skeleton } from '../bb/parts'
import PlayerPhoto from '../../components/sport/PlayerPhoto'
import LeaguePage, { LCard as Card } from '../../components/sport/page/LeaguePage'

interface Row { rank: number; id: number | null; name: string; country: string | null; points: number | null; move: number | null; isNew: boolean; photo?: string | null }
interface Data { tour: 'atp' | 'wta'; date: string | null; previous: string | null; rows: Row[] }

const Move = ({ r }: { r: Row }) => (
  r.isNew ? <span className="text-[10px] font-bold text-accent">{t('NEW')}</span>
    : r.move ? <span className={`num text-[11px] font-bold ${r.move > 0 ? 'text-win' : 'text-loss'}`}>{r.move > 0 ? `▲${r.move}` : `▼${-r.move}`}</span>
      : <span className="text-[11px] text-faint">–</span>
)
const Name = ({ r }: { r: Row }) => {
  // fix211: the player's photo when we have one (initials otherwise), then flag and name
  const body = <><PlayerPhoto src={r.photo} name={r.name} size={22} className="mr-2 align-middle" />{flagOf(r.country) && <span aria-hidden className="mr-1.5">{flagOf(r.country)}</span>}{r.name}</>
  return r.id ? <Link to={tennisHref.player(r.id)!} className="min-w-0 truncate font-semibold text-ink hover:text-accent">{body}</Link> : <span className="min-w-0 truncate font-semibold text-ink">{body}</span>
}

/**
 * Tennis rankings (fix193b): football's league page frame with the ATP / WTA singles rankings as the table — top 200,
 * points and the move since the table a week before; the biggest climbers and falls on the right.
 */
export default function TennisRankings() {
  const [sp, setSp] = useSearchParams()
  const tour: 'atp' | 'wta' = sp.get('tour') === 'wta' ? 'wta' : 'atp'
  const [d, setD] = useState<Data | null | undefined>(undefined)
  useEffect(() => {
    document.title = t('{0} · SportLikely', { 0: tour === 'wta' ? t('WTA rankings') : t('ATP rankings') })
    setD(undefined)
    axios.get(`${API_URL}/tennis/rankings`, { params: { tour } }).then(r => setD(r.data.data)).catch(() => setD(null))
  }, [tour])
  const chip = (on: boolean) => `shrink-0 inline-flex items-center h-9 px-4 rounded-full text-sm font-semibold border transition-colors ${on ? 'bg-accent text-bg border-accent' : 'bg-surface2/70 text-ink border-line/70 hover:border-accent/50'}`
  const pick = (x: 'atp' | 'wta') => setSp(prev => { const n = new URLSearchParams(prev); if (x === 'atp') n.delete('tour'); else n.set('tour', x); return n }, { replace: true })
  const rows = d?.rows || []
  const movers = rows.filter(r => r.move !== null && r.move !== 0)
  const up = [...movers].sort((a, b) => b.move! - a.move! || a.rank - b.rank).filter(r => r.move! > 0).slice(0, 8)
  const down = [...movers].sort((a, b) => a.move! - b.move! || a.rank - b.rank).filter(r => r.move! < 0).slice(0, 8)
  const moverList = (list: Row[]) => (
    <ul className="divide-y divide-line/50">
      {list.map(r => (
        <li key={r.rank} className="flex items-center gap-2 py-1.5 text-sm min-w-0">
          <span className="w-8 num text-faint shrink-0">{r.rank}</span>
          <Name r={r} />
          <span className="ml-auto shrink-0"><Move r={r} /></span>
        </li>
      ))}
    </ul>
  )
  return (
    <LeaguePage
      top={(
        <div role="group" aria-label={t('Tour')} className="flex gap-2">
          <button type="button" onClick={() => pick('atp')} aria-pressed={tour === 'atp'} className={chip(tour === 'atp')}>ATP</button>
          <button type="button" onClick={() => pick('wta')} aria-pressed={tour === 'wta'} className={chip(tour === 'wta')}>WTA</button>
        </div>
      )}
      logo={null}
      country={{ name: t('Singles rankings') }}
      name={tour === 'wta' ? 'WTA' : 'ATP'}
      sub={d?.date ? t('Updated {0}', { 0: new Date(d.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' }) }) : null}
      left={(
        <Card title={t('Top {0}', { 0: rows.length || 200 })} action={d?.previous ? <span className="text-xs text-faint">{t('moves since {0}', { 0: new Date(d.previous).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) })}</span> : undefined}>
          {d === undefined ? <Skeleton rows={12} h="h-7" /> : !rows.length ? <p className="text-sm text-faint">{t('The rankings appear after the next update.')}</p> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-faint text-left">
                  <th className="py-1.5 w-10 font-semibold">#</th>
                  <th className="py-1.5 w-12 font-semibold">{t('Move')}</th>
                  <th className="py-1.5 font-semibold">{t('Player')}</th>
                  <th className="py-1.5 text-right font-semibold">{t('Points')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                {rows.map(r => (
                  <tr key={r.rank}>
                    <td className="py-1.5 num text-muted">{r.rank}</td>
                    <td className="py-1.5"><Move r={r} /></td>
                    <td className="py-1.5 max-w-0 w-full"><div className="flex min-w-0"><Name r={r} /></div></td>
                    <td className="py-1.5 pl-2 text-right num text-ink">{r.points !== null ? r.points.toLocaleString(LOCALE) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      right={<>
        {up.length > 0 && <Card title={t('Biggest climbers')}>{moverList(up)}</Card>}
        {down.length > 0 && <Card title={t('Biggest falls')}>{moverList(down)}</Card>}
        <Card title={t('Matches')}>
          <p className="text-sm text-muted">{t('Our predictions for every ATP, WTA and Challenger match.')}</p>
          <Link to="/tennis/matches" className="mt-2 inline-block text-sm font-bold text-accent">{t('All matches →')}</Link>
        </Card>
      </>}
    />
  )
}

import { useState, type ReactNode } from 'react'
import { t, LOCALE, ltr } from '../../lib/i18n'
import NameLink from './NameLink'

/**
 * fix267 — the career table of every player page, every sport (football's "Club career" since fix152; basketball,
 * American football and tennis from services/playerCareers.ts): every season with team and league, per-game numbers
 * (basketball), season totals (American football, columns by position) or the year's record (tennis), career totals,
 * best seasons, where the numbers come from, and a note when the provider's history is incomplete. `npm run parity`
 * (scripts/career-check.ts) checks that every sport's player page renders it.
 */

export interface CareerCol { key: string; kind: 'int' | 'dec' | 'pct' | 'text'; accent?: boolean }
export interface CareerTeam { id: number | null; name: string; logo: string | null }
export interface CareerRow {
  season: string; order: number; kind: 'regular' | 'playoffs'
  league: { code: string | null; name: string } | null
  team: CareerTeam | null; also?: CareerTeam[]
  gp: number | null
  stats: Record<string, number | string | null>
  source?: string
}
export interface CareerData {
  sport: string
  group?: string | null
  columns: CareerCol[]
  parts: ('regular' | 'playoffs')[]
  rows: CareerRow[]
  totals: Partial<Record<'regular' | 'playoffs', { gp: number; stats: Record<string, number | string | null> }>>
  highs: { key: string; value: number | string; season: string }[]
  seasons: number
  from: string | null
  partial: boolean
  partialWhy: string | null
  sources: string[]
}

/** column headers (short, as on the sport's own stat sheets); unknown keys show as they are */
const label = (k: string): string => ({
  gp: t('GP'), min: t('MIN'), pts: t('PTS'), reb: t('REB'), ast: t('AST'), stl: t('STL'), blk: t('BLK'), fgPct: t('FG%'), tpPct: t('3P%'), ftPct: t('FT%'),
  cmp: t('CMP'), att: t('ATT'), cmpPct: t('CMP%'), passYds: t('Pass yds'), passTd: t('Pass TD'), int: t('INT'), rate: t('Rating'), rushYds: t('Rush yds'), rushTd: t('Rush TD'),
  car: t('Carries'), ypc: t('Yds/carry'), rec: t('Rec'), tgt: t('Targets'), recYds: t('Rec yds'), ypr: t('Yds/catch'), recTd: t('Rec TD'), lng: t('Long'),
  tackles: t('Tackles'), solo: t('Solo'), sacks: t('Sacks'), pd: t('Passes defended'), ff: t('Forced fumbles'), fgm: t('FG made'), fga: t('FG att'), xpm: t('XP made'), xpa: t('XP att'),
  kPts: t('Points'), punts: t('Punts'), puntYds: t('Punt yds'), puntAvg: t('Avg'), in20: t('Inside 20'),
  rank: t('Year-end rank'), w: t('W'), l: t('L'), winPct: t('Win %'), titles: t('Titles'), finals: t('Finals'), hard: t('Hard'), clay: t('Clay'), grass: t('Grass'), slams: t('Grand Slams'),
  apps: t('Apps'), goals: t('Goals'), assists: t('Ast'), minutes: t('Min')
} as Record<string, string>)[k] || k

function cell(v: number | string | null | undefined, kind: CareerCol['kind']): string {
  if (v === null || v === undefined || v === '') return '–'
  if (typeof v === 'string') return ltr(v)
  if (kind === 'pct') return ltr(`${v.toLocaleString(LOCALE, { maximumFractionDigits: 1 })}%`)
  if (kind === 'dec') return v.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return v.toLocaleString(LOCALE)
}

/** the note under the table when the provider's history is incomplete */
export function partialNote(why: string | null): string | null {
  if (!why) return null
  if (why === 'loading') return t('Older seasons are still loading: they appear within a day.')
  const start = /^provider-start:(.+)$/.exec(why)
  if (start) return t("Our data provider's history starts in {0}: earlier seasons are missing.", { 0: start[1] })
  return t('Some older seasons could not be loaded yet: we try again within a day.')
}

export default function CareerTable({ data, teamHref, leagueHref, onRow, active, note, wide = 520 }: {
  data: CareerData
  teamHref?: (t: CareerTeam) => string | null
  leagueHref?: (code: string) => string | null
  /** football: tap a season to see it in detail */
  onRow?: (row: CareerRow, i: number) => void
  active?: number
  note?: ReactNode
  wide?: number
}) {
  const [part, setPart] = useState<'regular' | 'playoffs'>(data.parts[0] || 'regular')
  const rows = data.rows.filter(r => r.kind === part)
  const showLeague = rows.some(r => r.league)
  const showTeam = rows.some(r => r.team)
  const showGp = rows.some(r => r.gp != null)
  const tot = data.totals[part]
  const teamCell = (r: CareerRow) => {
    const teams = [r.team, ...(r.also || [])].filter((x): x is CareerTeam => !!x)
    if (!teams.length) return <span className="text-faint">–</span>
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        {teams.map((x, k) => x.logo ? <img key={k} src={x.logo} alt="" className="w-4 h-4 object-contain shrink-0" loading="lazy" /> : null)}
        <span className="truncate text-ink">{teams.map((x, k) => <span key={k}>{k > 0 && ' · '}{teamHref && x.id != null ? <NameLink to={teamHref(x)}>{x.name}</NameLink> : x.name}</span>)}</span>
      </span>
    )
  }
  const partial = partialNote(data.partialWhy)
  return (
    <div>
      {data.parts.length > 1 && (
        <div className="flex gap-1.5 mb-3" role="tablist">
          {data.parts.map(p => (
            <button key={p} role="tab" aria-selected={part === p} onClick={() => setPart(p)}
              className={`rounded-full px-3 py-1 text-xs font-bold border ${part === p ? 'bg-accent/15 border-accent/40 text-ink' : 'border-line text-muted hover:text-ink'}`}>
              {p === 'regular' ? t('Regular season') : t('Playoffs')}
            </button>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{partial || t('No season data for this player yet.')}</p>
      ) : (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm num" style={{ minWidth: Math.min(wide + data.columns.length * 44, 1100) }}>
            <thead>
              <tr className="text-[11px] text-faint">
                <th className="text-start font-medium py-1.5 px-1 whitespace-nowrap">{data.sport === 'tennis' ? t('Year') : t('Season')}</th>
                {showTeam && <th className="text-start font-medium py-1.5 px-1">{data.sport === 'football' ? t('Club') : t('Team')}</th>}
                {showLeague && <th className="text-start font-medium py-1.5 px-1">{t('League')}</th>}
                {showGp && <th className="text-end font-medium py-1.5 px-1">{data.sport === 'tennis' ? t('Matches') : t('GP')}</th>}
                {data.columns.map(c => <th key={c.key} className="text-end font-medium py-1.5 px-1 whitespace-nowrap">{label(c.key)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.order}|${r.team?.id ?? r.team?.name ?? ''}|${r.league?.code ?? r.league?.name ?? ''}|${i}`}
                  onClick={onRow ? () => onRow(r, i) : undefined}
                  className={`border-t border-line/50 ${onRow ? 'cursor-pointer hover:bg-surface2/40' : ''} ${active === i ? 'bg-accent/5' : ''}`}>
                  <td className="py-1.5 px-1 text-muted whitespace-nowrap">{ltr(r.season)}</td>
                  {showTeam && <td className="py-1.5 px-1 max-w-[180px]">{teamCell(r)}</td>}
                  {showLeague && (
                    <td className="py-1.5 px-1 text-xs text-muted whitespace-nowrap">
                      {r.league ? (leagueHref && r.league.code ? <NameLink to={leagueHref(r.league.code)}>{r.league.name}</NameLink> : r.league.name) : t('Other games')}
                    </td>
                  )}
                  {showGp && <td className="py-1.5 px-1 text-end text-muted">{r.gp ?? '–'}</td>}
                  {data.columns.map(c => (
                    <td key={c.key} className={`py-1.5 px-1 text-end whitespace-nowrap ${c.accent ? 'font-bold text-ink' : c.kind === 'text' ? 'text-xs text-muted' : 'text-ink'}`}>{cell(r.stats[c.key], c.kind)}</td>
                  ))}
                </tr>
              ))}
              {tot && rows.length > 1 && (
                <tr className="border-t-2 border-line">
                  <td className="py-2 px-1 font-bold text-ink" colSpan={1 + (showTeam ? 1 : 0) + (showLeague ? 1 : 0)}>{t('Total')}</td>
                  {showGp && <td className="py-2 px-1 text-end font-bold text-ink">{tot.gp}</td>}
                  {data.columns.map(c => (
                    <td key={c.key} className={`py-2 px-1 text-end whitespace-nowrap ${c.accent ? 'font-extrabold text-accent' : c.kind === 'text' ? 'text-xs font-semibold text-ink' : 'font-bold text-ink'}`}>{cell(tot.stats[c.key], c.kind)}</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {data.highs.length > 0 && part === 'regular' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-[11px] text-faint self-center">{t('Best seasons')}</span>
          {data.highs.map(h => (
            <span key={h.key} className="inline-flex items-baseline gap-1.5 rounded-lg bg-surface2/60 border border-line/60 px-2 py-1 text-xs">
              <span className="text-faint">{label(h.key)}</span>
              <span className="num font-bold text-ink">{cell(h.value, data.columns.find(c => c.key === h.key)?.kind || 'int')}</span>
              <span className="text-faint num">{ltr(h.season)}</span>
            </span>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-faint">
        {note}
        {partial && rows.length > 0 ? <>{note ? ' ' : ''}{partial}</> : null}
        {data.sources.length > 0 && <>{(note || (partial && rows.length > 0)) ? ' ' : ''}{t('Source: {0}', { 0: data.sources.join(', ') })}</>}
      </p>
    </div>
  )
}

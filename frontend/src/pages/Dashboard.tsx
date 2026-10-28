import { useEffect, useState } from 'react'
import RecentResults from '../components/RecentResults'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t as tt, ltr } from '../lib/i18n'
import Games from '../components/sport/Games'
import { footballGames } from '../components/sport/games/football'

/**
 * fix152: the Matches page is the shared one (components/sport/Games, football's layout) with football's adapter. The
 * football league panel (table, results, scorers, assists) stays here until stage d makes it shared.
 */

export interface Team {
  id: number
  name: string
  shortName?: string
  tla?: string
  crest?: string
}


function Dashboard() {
  return <Games a={footballGames} />
}

/* ---------- league panel: table, scorers, assists ---------- */

interface StandingRow {
  position: number
  team: Team
  playedGames: number
  won: number
  draw: number
  lost: number
  goalDifference: number
  points: number
  form?: string | null
}
interface Scorer {
  player: { id: number; name: string; nationality?: string }
  team: Team
  goals: number | null
  assists: number | null
  penalties: number | null
  playedMatches?: number | null
}

export function LeaguePanel({ code }: { code: string }) {
  const [tables, setTables] = useState<{ type: string; group?: string | null; table: StandingRow[] }[]>([])
  const [scorers, setScorers] = useState<Scorer[]>([])
  const [tab, setTab] = useState<'table' | 'scorers' | 'assists' | 'results'>('table')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([axios.get(`${API_URL}/leagues/${code}/standings`), axios.get(`${API_URL}/leagues/${code}/scorers`, { params: { limit: 40 } })])
      .then(([st, sc]) => {
        if (cancelled) return
        setTables(st.data.data?.standings || [])
        setScorers(sc.data.data?.scorers || [])
      })
      .catch(err => !cancelled && setError(err.response?.data?.message || err.message))
    return () => {
      cancelled = true
    }
  }, [code])

  const totals = tables.filter(t => t.type === 'TOTAL')
  const topScorers = [...scorers].sort((a, b) => (b.goals || 0) - (a.goals || 0) || (b.assists || 0) - (a.assists || 0)).slice(0, 15)
  const topAssists = [...scorers].filter(s => (s.assists || 0) > 0).sort((a, b) => (b.assists || 0) - (a.assists || 0) || (b.goals || 0) - (a.goals || 0)).slice(0, 15)

  return (
    <aside className="xl:sticky xl:top-20 space-y-4">
      <div className="seg w-full">
        {(['table', 'results', 'scorers', 'assists'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`seg-btn flex-1 ${tab === t ? 'seg-btn-active' : ''}`}>
            {t === 'table' ? tt("Table") : t === 'results' ? tt("Results") : t === 'scorers' ? tt("Scorers") : tt("Assists")}
          </button>
        ))}
      </div>

      {error && <div className="card p-4 text-xs text-loss">{error}</div>}

      {tab === 'table' &&
        (totals.length ? totals : tables).map((t, i) => (
          <section key={i} className="card p-3">
            {t.group && <div className="label px-1 pb-2">{t.group.replace(/_/g, ' ')}</div>}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-faint">
                  <th className="text-start font-medium py-1 ps-1 w-6">#</th>
                  <th className="text-start font-medium py-1">{tt("Team")}</th>
                  <th className="text-end font-medium py-1 num">P</th>
                  <th className="text-end font-medium py-1 num">{tt("GD")}</th>
                  <th className="text-end font-medium py-1 pe-1 num">{tt("Pts")}</th>
                </tr>
              </thead>
              <tbody>
                {t.table.map(r => (
                  <tr key={r.team.id} className="border-t border-line/50">
                    <td className="py-1.5 ps-1 num text-faint">{r.position}</td>
                    <td className="py-1.5">
                      <span className="flex items-center gap-2 min-w-0">
                        <Crest team={r.team} size={16} />
                        <span className="truncate text-ink">{r.team.shortName || r.team.name}</span>
                      </span>
                    </td>
                    <td className="py-1.5 text-end num text-muted">{r.playedGames}</td>
                    <td className={`py-1.5 text-end num ${r.goalDifference > 0 ? 'text-win' : r.goalDifference < 0 ? 'text-loss' : 'text-muted'}`}>
                      {ltr(`${r.goalDifference > 0 ? '+' : ''}${r.goalDifference}`)}
                    </td>
                    <td className="py-1.5 pe-1 text-end num font-bold text-ink">{r.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

      {tab === 'results' && (
        <section className="card p-3">
          <RecentResults code={code} limit={30} days={60} />
        </section>
      )}

      {(tab === 'scorers' || tab === 'assists') && (
        <section className="card p-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-faint">
                <th className="text-start font-medium py-1 ps-1 w-6">#</th>
                <th className="text-start font-medium py-1">{tt("Player")}</th>
                <th className="text-end font-medium py-1 num">{tab === 'scorers' ? 'G' : 'A'}</th>
                <th className="text-end font-medium py-1 pe-1 num">{tab === 'scorers' ? 'A' : 'G'}</th>
              </tr>
            </thead>
            <tbody>
              {(tab === 'scorers' ? topScorers : topAssists).map((sc, i) => (
                <tr key={sc.player.id} className="border-t border-line/50">
                  <td className="py-1.5 ps-1 num text-faint">{i + 1}</td>
                  <td className="py-1.5">
                    <span className="flex items-center gap-2 min-w-0">
                      <Crest team={sc.team} size={16} />
                      <span className="min-w-0">
                        <span className="block truncate text-ink">{sc.player.name}</span>
                        <span className="block truncate text-[10px] text-faint">{sc.team.shortName || sc.team.name}</span>
                      </span>
                    </span>
                  </td>
                  <td className="py-1.5 text-end num font-bold text-ink">{tab === 'scorers' ? sc.goals ?? 0 : sc.assists ?? 0}</td>
                  <td className="py-1.5 pe-1 text-end num text-muted">{tab === 'scorers' ? sc.assists ?? 0 : sc.goals ?? 0}</td>
                </tr>
              ))}
              {(tab === 'scorers' ? topScorers : topAssists).length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-faint">{tt("No data yet this season.")}</td>
                </tr>
              )}
            </tbody>
          </table>
          {tab === 'assists' && <p className="text-[10px] text-faint mt-2 px-1">{tt("Assists from the top-40 scorers list.")}</p>}
        </section>
      )}
    </aside>
  )
}

function Crest({ team, size = 32 }: { team: Team; size?: number }) {
  return team.crest ? (
    <img src={team.crest} alt="" width={size} height={size} className="object-contain flex-shrink-0 drop-shadow-sm" style={{ width: size, height: size }} />
  ) : (
    <span className="rounded-full bg-surface2 flex-shrink-0 grid place-items-center text-[10px] text-faint" style={{ width: size, height: size }}>
      {team.tla || '?'}
    </span>
  )
}


export default Dashboard

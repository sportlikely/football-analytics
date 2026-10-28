import { useEffect, useState, type ReactNode } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { t as tt, LOCALE } from '../lib/i18n'

type O = 'H' | 'D' | 'A'
interface SeasonModel { n: number; hitRate: number | null; marketN: number; marketHitRate: number | null; strong60: { n: number; hitRate: number | null }; first: string; last: string; leagues: number }
interface Season { season: string; label: string; models: Record<string, SeasonModel> }
interface Row { league: string; division: string; date: string; home: string; away: string; score: string; outcome: O; pick: O; hit: boolean; p: Record<O, number>; market: Record<O, number> | null }
interface Page { total: number; page: number; limit: number; rows: Row[]; divisions: { code: string; name: string }[] }
interface Inventory {
  leagueMatches: number; leagueTeams: number; leagues: number; seasons: { season: string; matches: number; leagues: number }[]
  withOdds: number; withShots: number; withXg: number; lineups: number; injuries: number
  nationalMatches: number; nationalSince: string | null; cupMatches: number; squadClubs: number; squadMonths: number; players: number
  backtestPredictions: number; livePredictions: number; liveSettled: number; trackingSince: string | null
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString(LOCALE))
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${Math.round(x)}%`)
const MODEL_NAME: Record<string, string> = { 'grid-v3': tt("Our model (v3)") }

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card p-5 sm:p-6 ${className}`}>{children}</div>
}

function Fact({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-line/70 bg-surface2/40 p-3.5">
      <div className="num text-xl sm:text-2xl font-extrabold text-ink">{value}</div>
      <div className="text-xs text-muted mt-0.5 leading-snug">{label}</div>
    </div>
  )
}

function Probs({ p, pick, outcome }: { p: Record<O, number>; pick?: O; outcome: O }) {
  return (
    <div className="flex gap-1 num text-xs">
      {(['H', 'D', 'A'] as O[]).map(k => (
        <span
          key={k}
          className={`w-9 text-center rounded-md py-0.5 ${k === outcome ? 'ring-1 ring-ink/40' : ''} ${pick === k ? 'bg-accent/20 text-ink font-bold' : 'text-muted'}`}
          title={k === 'H' ? tt("Home") : k === 'D' ? tt("Draw") : tt("Away")}
        >
          {p[k]}
        </span>
      ))}
    </div>
  )
}

export default function Past() {
  const [inv, setInv] = useState<Inventory | null>(null)
  const [seasons, setSeasons] = useState<Season[]>([])
  const [season, setSeason] = useState<string | null>(null)
  const [model, setModel] = useState('grid-v3')
  const [division, setDivision] = useState('')
  const [team, setTeam] = useState('')
  const [teamQ, setTeamQ] = useState('')
  const [result, setResult] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Page | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([axios.get(`${API_URL}/past/data`), axios.get(`${API_URL}/past/seasons`)])
      .then(([d, s]) => {
        setInv(d.data.data)
        setSeasons(s.data.data)
        if (s.data.data.length) setSeason(s.data.data[0].season)
      })
      .catch(e => setError(errorText(e)))
  }, [])

  // debounce the team search
  useEffect(() => {
    const t = setTimeout(() => setTeamQ(team.trim()), 350)
    return () => clearTimeout(t)
  }, [team])

  useEffect(() => setPage(1), [season, model, division, teamQ, result])

  useEffect(() => {
    if (!season) return
    let cancelled = false
    axios
      .get(`${API_URL}/past/predictions`, { params: { season, model, division: division || undefined, team: teamQ || undefined, result: result || undefined, page, limit: 50 } })
      .then(r => !cancelled && setData(r.data.data))
      .catch(e => !cancelled && setError(errorText(e)))
    return () => {
      cancelled = true
    }
  }, [season, model, division, teamQ, result, page])

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1
  const select = 'rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent'

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div>
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Past seasons")}</h1>
        <p className="text-sm text-muted mt-1 max-w-2xl">
          {tt("What our models would have predicted on every match of the last seasons. Each prediction was made the way it is today: using only results known before that match — so these are honest tests, not hindsight.")}</p>
      </div>

      {error && <div className="rounded-xl border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">{error}</div>}

      {/* What we've collected */}
      {inv && (
        <Card>
          <h2 className="font-display text-xl font-bold text-ink">{tt("What we've collected")}</h2>
          <p className="text-sm text-muted mt-0.5 mb-4">{tt("All the information the models learn from")}{inv.trackingSince ? tt("; live tracking since {0}", { 0: new Date(inv.trackingSince).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' }) }) : ''}.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Fact value={fmt(inv.leagueMatches)} label={tt("league matches · {0} leagues", { 0: inv.leagues })} />
            <Fact value={fmt(inv.leagueTeams)} label={tt("clubs")} />
            <Fact value={fmt(inv.withShots)} label={tt("matches with shots & corners")} />
            <Fact value={fmt(inv.withXg)} label={tt("matches with expected goals (xG) — still downloading")} />
            <Fact value={fmt(inv.lineups)} label={tt("official lineups")} />
            <Fact value={fmt(inv.injuries)} label={tt("injury & suspension records")} />
            <Fact value={fmt(inv.squadClubs)} label={tt("clubs with monthly squad values ({0} club-months)", { 0: fmt(inv.squadMonths) })} />
            <Fact value={fmt(inv.nationalMatches)} label={tt("national-team matches{0}", { 0: inv.nationalSince ? ` since ${inv.nationalSince}` : '' })} />
            <Fact value={fmt(inv.cupMatches)} label={tt("Champions / Europa / Conference League matches")} />
            <Fact value={fmt(inv.backtestPredictions)} label={tt("past predictions (tests)")} />
            <Fact value={fmt(inv.liveSettled)} label={tt("live predictions already scored")} />
          </div>
          {inv.seasons.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted">
              {inv.seasons.map(s => (
                <span key={s.season} className="px-2.5 py-1 rounded-full border border-line">
                  {s.season}: <span className="num text-ink">{fmt(s.matches)}</span> {tt("matches")}</span>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Season by season */}
      {seasons.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {seasons.map(s => {
            const v3 = s.models['grid-v3']
            const v2 = s.models['dc-history-v2']
            const active = s.season === season
            return (
              <button key={s.season} onClick={() => setSeason(s.season)} className={`text-start card p-5 transition-colors ${active ? 'border-accent/60 bg-accent/5' : 'hover:border-faint'}`}>
                <div className="flex items-center justify-between">
                  <span className="font-display text-lg font-bold text-ink">{s.label}</span>
                  {active && <span className="text-[11px] font-bold uppercase tracking-wider text-accent">{tt("Showing")}</span>}
                </div>
                <div className="text-xs text-faint mt-0.5">{fmt(v3?.n ?? v2?.n)} {tt("matches")}{v3 ? tt(" · {0} leagues", { 0: v3.leagues }) : ''}</div>
                <div className="mt-3 space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted">{tt("Our model (v3)")}</span><span className="num font-bold text-ink">{pct(v3?.hitRate)}</span></div>
                  {v3 && v3.strong60.n > 0 && (
                    <div className="pt-1.5 mt-1.5 border-t border-line/60 text-xs text-muted">
                      {tt("When v3 said 60%+: right {0} of {1}", { 0: pct(v3.strong60.hitRate), 1: fmt(v3.strong60.n) })}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
      {seasons.length > 0 && <p className="text-xs text-faint -mt-3">{tt("% = how often the pick (the most likely result) was right. Click a season to browse its matches.")}</p>}

      {/* Browse */}
      {season && (
        <Card>
          <h2 className="font-display text-xl font-bold text-ink mb-4">{tt("Every prediction ·")}{' '}{seasons.find(s => s.season === season)?.label}</h2>
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.keys(MODEL_NAME).length > 1 && (
              <select value={model} onChange={e => setModel(e.target.value)} className={select}>
                {Object.entries(MODEL_NAME).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            )}
            <select value={division} onChange={e => setDivision(e.target.value)} className={select}>
              <option value="">{tt("All leagues")}</option>
              {(data?.divisions || []).map(d => (
                <option key={d.code} value={d.code}>{d.name}</option>
              ))}
            </select>
            <select value={result} onChange={e => setResult(e.target.value)} className={select}>
              <option value="">{tt("Right and wrong")}</option>
              <option value="right">{tt("Only right picks")}</option>
              <option value="wrong">{tt("Only wrong picks")}</option>
            </select>
            <input value={team} onChange={e => setTeam(e.target.value)} placeholder={tt("Search a team")} className={`${select} w-44`} />
          </div>

          {data && (
            <>
              <div className="text-xs text-faint mb-2">
                {fmt(data.total)} {tt("matches · numbers are Home / Draw / Away % · our pick is highlighted, the real result is outlined")}</div>
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-sm min-w-[480px]">
                  <thead>
                    <tr className="text-start text-xs text-faint border-b border-line">
                      <th className="px-2 py-2 font-medium w-8"></th>
                      <th className="px-2 py-2 font-medium">{tt("Match")}</th>
                      <th className="px-2 py-2 font-medium">{tt("Our %")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <tr key={`${r.date}-${r.home}-${i}`} className="border-b border-line/50 last:border-0">
                        <td className="px-2 py-2">
                          <span className={`w-6 h-6 rounded-full grid place-items-center text-xs font-bold ${r.hit ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss'}`}>{r.hit ? '✓' : '✗'}</span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="text-ink">
                            {r.home} <span className="num font-semibold">{r.score}</span> {r.away}
                          </div>
                          <div className="text-xs text-faint">
                            {new Date(r.date).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })} · {r.league}
                          </div>
                        </td>
                        <td className="px-2 py-2"><Probs p={r.p} pick={r.pick} outcome={r.outcome} /></td>
                      </tr>
                    ))}
                    {!data.rows.length && (
                      <tr>
                        <td colSpan={3} className="px-2 py-8 text-center text-faint">{tt("No matches for this filter.")}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-xl border border-line text-ink disabled:opacity-40">
                    {tt("← Newer")}</button>
                  <span className="text-muted num">{tt("Page {0} of {1}", { 0: page, 1: pages })}</span>
                  <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-xl border border-line text-ink disabled:opacity-40">
                    {tt("Older →")}</button>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  )
}

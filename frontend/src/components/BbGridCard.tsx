import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { slAdmin } from '../lib/modelNames'

type Score = { games: number; logLoss: number; brier: number; hitRate: number }
type Gate = { group: string; pass: boolean; reason: string; whole: { v3: Score; v4: Score }; first25: { v3: Score; v4: Score }; oracle: { games: number; v3: Score; v4: Score }; leagues: string[] }
type Info = {
  stored: boolean; at: string | null; params: { w: number[]; version: string; fittedAt: string | null; train: number[] | null; stretch: Record<string, number>; offsets: Record<string, number[]> }
  report: null | { split: { id: string; name: string; weight: number; points: number }[]; trainGames: number; testGames: number; trainLL: number; startLL: number; offsetLeagues: string[] }
  gate: Record<string, Gate> | null; perLeague: Record<string, { games: number; v3: Score; v4: Score }> | null; live: Record<string, { games: number; v3: Score; v4: Score }> | null
  stats: { mean: number[]; sd: number[] } | null
  /** fix222: the worker's own tune on the live database (after the deploy, then monthly) */
  auto: null | { why: string; at: string; applied: boolean; reason: string; before: number; after: number; passing: string[]; train: number[]; test: number; trainGames: number; testGames: number }
  autoDue: string | null
}
type CalScore = { games: number; logLoss: number | null; brier: number | null; hit: number | null }
type CalBand = { lo: number; hi: number; n: number; said: number | null; happened: number | null }
type Calib = { at: string; source: string; test: { season: number; fitOn: number[]; raw: CalScore; ownFit: CalScore; sportFit: CalScore; sportKept: boolean; rawBands: CalBand[]; calBands: CalBand[] }
  perLeague: { league: string; games: number; raw: CalScore; cal: CalScore; kept: boolean; why: string }[]; strong: Record<string, number>; strongSport: number
  live: { games: number; raw: CalScore; cal: CalScore; rawBands: CalBand[]; calBands: CalBand[] } }
const ROWS = ['#1 Player impact', '#2 Net rating / 100', '#3 Team rating (bb-v3)', '#4 Missing players', '#5 Four factors', '#6 Rest', '#7 Home court', '#8 Carry-over', '#9 Matchups', '#10 Form', '#11 Motivation', '#12 3-pt volatility (sigma)', '#13 Head-to-head']

/** fix219 (admin): bb-v4 grid — the gate per group, the fitted split, the test table, the live period, tune / apply. */
export default function BbGridCard() {
  const [d, setD] = useState<Info | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<any>(null)
  const [cal, setCal] = useState<Calib | null>(null)
  const load = (q = '') => axios.get(`${API_URL}/bb/tuned${q}`).then(r => setD(r.data.data)).catch(() => setD(null))
  const loadCal = (q = '') => axios.get(`${API_URL}/admin/calibration?sport=basketball${q}`).then(r => setCal(r.data.data.report)).catch(() => setCal(null))
  useEffect(() => { load(); loadCal() }, [])
  if (!d) return null
  const tune = (apply: boolean) => {
    setBusy(true); setMsg(apply ? 'Fitting and applying (in the job thread)…' : 'Fitting a preview…')
    axios.get(`${API_URL}/bb/tune?train=2022,2023,2024&test=2025${apply ? '&apply=1' : ''}`)
      .then(r => { setPreview(r.data.data); setMsg(apply ? 'Applied: live predictions use the new weights.' : 'Preview below (not applied).'); load() })
      .catch(e => setMsg(errorText(e))).finally(() => setBusy(false))
  }
  // the fitted split: points per row out of 1,000 (weight × spread of the row on the training games)
  const sd = d.stats?.sd || []
  const raw = d.params.w.map((w, i) => (i === 11 ? 0 : Math.abs(w) * (sd[i] || 0)))
  const tot = raw.reduce((a, b) => a + b, 0) || 1
  const ll = (s: Score) => (s.games ? s.logLoss.toFixed(4) : '—')
  const btn = 'px-3 py-1.5 rounded-full border border-line text-muted hover:text-ink disabled:opacity-50'
  const report = preview || d.report
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Basketball model v4 (grid)</h2>
        <span className="text-xs text-faint">{slAdmin('bb-v4')} · 13 rows · settings: {d.params.version}{d.at ? ` · applied ${new Date(d.at).toLocaleString('en-GB')}` : ' (code defaults)'}</span>
      </div>
      {d.auto ? (
        <p className={`text-xs mb-1 ${d.auto.applied ? 'text-win' : 'text-muted'}`}>
          Fitted on live data at {new Date(d.auto.at).toLocaleString('en-GB')} · train {d.auto.train.join(', ')} ({d.auto.trainGames} games) → test {d.auto.test} ({d.auto.testGames} games) · {d.auto.reason}
        </p>
      ) : <p className="text-xs text-loss mb-1">Not fitted on the live database yet{d.autoDue ? ` (due: ${d.autoDue}; the worker runs it ~20 min after a start, then monthly)` : ''}.</p>}
      <p className="text-sm text-muted">Gate on 2025-26 (or the 2025 season): bb-v4 must beat bb-v3 on log loss over the whole season and on games 1–25, per group; otherwise bb-v3 stays live there.</p>
      {d.gate && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-faint text-left"><th className="pb-1 pr-3 font-normal">Group</th><th className="pb-1 pr-3 font-normal">Whole season bb-v3 → v4</th><th className="pb-1 pr-3 font-normal">Games 1–25</th><th className="pb-1 pr-3 font-normal">Who played known</th><th className="pb-1 font-normal">Live</th></tr></thead>
            <tbody>
              {Object.values(d.gate).map(g => (
                <tr key={g.group} className="border-t border-line/50" title={g.leagues.join(', ')}>
                  <td className="py-1.5 pr-3 text-ink font-semibold">{g.group}</td>
                  <td className="py-1.5 pr-3 num">{ll(g.whole.v3)} → <b className={g.whole.v4.logLoss < g.whole.v3.logLoss ? 'text-win' : 'text-loss'}>{ll(g.whole.v4)}</b> <span className="text-faint">({g.whole.v4.games})</span></td>
                  <td className="py-1.5 pr-3 num">{ll(g.first25.v3)} → <b className={g.first25.v4.logLoss < g.first25.v3.logLoss ? 'text-win' : 'text-loss'}>{ll(g.first25.v4)}</b> <span className="text-faint">({g.first25.v4.games})</span></td>
                  <td className="py-1.5 pr-3 num text-muted">{ll(g.oracle.v4)}</td>
                  <td className={`py-1.5 font-semibold ${g.pass ? 'text-win' : 'text-loss'}`} title={g.reason}>{g.pass ? 'bb-v4' : 'bb-v3'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 grid sm:grid-cols-2 gap-x-6 text-xs">
        <div>
          <div className="text-faint mb-1">Fitted split (points per row of 1,000) · weight</div>
          {ROWS.map((name, i) => (
            <div key={name} className="flex justify-between border-t border-line/40 py-0.5"><span className={raw[i] ? 'text-ink' : 'text-faint'}>{name}</span><span className="num">{i === 11 ? '—' : Math.round((1000 * raw[i]) / tot)} · {d.params.w[i]}</span></div>
          ))}
        </div>
        <div>
          <div className="text-faint mb-1">Test season per league (log loss bb-v3 → v4)</div>
          {Object.entries(d.perLeague || {}).map(([c, x]) => (
            <div key={c} className="flex justify-between border-t border-line/40 py-0.5"><span className="text-ink">{c} <span className="text-faint">({x.games})</span></span><span className="num">{ll(x.v3)} → <b className={x.v4.logLoss < x.v3.logLoss ? 'text-win' : 'text-loss'}>{ll(x.v4)}</b></span></div>
          ))}
          {d.live && Object.keys(d.live).length > 0 && <p className="mt-2 text-faint">Live period (reported, never tuned): {Object.entries(d.live).map(([c, x]) => `${c} ${ll(x.v3)} → ${ll(x.v4)} (${x.games})`).join(' · ')}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button type="button" className={btn} disabled={busy} onClick={() => tune(false)}>Fit preview (2022–24 → 2025)</button>
        <button type="button" className={btn} disabled={busy} onClick={() => tune(true)}>Fit and apply</button>
        <button type="button" className={btn} disabled={busy} onClick={() => { load('?clear=1'); setMsg('Back to the code defaults.') }}>Back to code defaults</button>
      </div>
      {msg && <p className="mt-2 text-xs text-accent">{msg}</p>}
      {cal && (
        <div className="mt-4 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-ink">Calibration layer (fix222)</h3>
            <button type="button" className={btn} onClick={() => { loadCal('&rebuild=1'); setMsg('Building the calibration layer again (a minute)…') }}>Rebuild</button>
          </div>
          <p className="text-faint">{cal.source} · built {new Date(cal.at).toLocaleString('en-GB')} · fitted on {cal.test.fitOn.join(', ')}, tested on {cal.test.season}: log loss raw {cal.test.raw.logLoss} → own fits {cal.test.ownFit.logLoss} / one fit {cal.test.sportFit.logLoss} · strong line {Math.round(cal.strongSport * 100)}%</p>
          <p className="text-faint">Live season (never fitted): {cal.live.games} games, log loss {cal.live.raw.logLoss} → {cal.live.cal.logLoss} · {cal.live.calBands.filter(b => b.n).map((b, i) => `${b.lo}%+: said ${cal.live.rawBands[i].said} → ${b.said}, happened ${b.happened} (${b.n})`).join(' · ')}</p>
          <div className="mt-1 grid sm:grid-cols-2 gap-x-6">
            {cal.perLeague.map(x => (
              <div key={x.league} className="flex justify-between border-t border-line/40 py-0.5" title={x.why}>
                <span className="text-ink">{x.league} <span className="text-faint">({x.games})</span></span>
                <span className="num">{x.raw.logLoss ?? '—'} → <b className={x.kept ? 'text-win' : 'text-faint'}>{x.kept ? x.cal.logLoss : 'raw kept'}</b> · strong {Math.round((cal.strong[x.league] ?? cal.strongSport) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {report && <p className="mt-2 text-[11px] text-faint num">Last fit: {report.trainGames} train games, log loss {report.startLL} → {report.trainLL}; per-league offsets: {(report.offsetLeagues || []).join(', ') || 'none'}.</p>}
    </section>
  )
}

import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'
import { slAdmin } from '../lib/modelNames'

type Score = { games: number; logLoss: number; brier: number; hitRate: number }
/** fix236: variant 'shared' = the leagues' own settings dropped; basis = the #4 inputs the test read; checks = a failing group's diagnosis */
type GateCheck = { name: string; pass: boolean; whole: number; first25: number; live: boolean }
type Gate = { group: string; pass: boolean; reason: string; whole: { v3: Score; v4: Score }; first25: { v3: Score; v4: Score }; oracle: { games: number; v3: Score; v4: Score }; leagues: string[]; variant?: 'full' | 'shared'; basis?: string; checks?: GateCheck[] }
type EngineRow = { group: string; engine: 'bb-v3' | 'bb-v4'; variant: 'full' | 'shared'; reason: string; basis: string; since: string | null; leagues: string[] }
type Info = {
  stored: boolean; at: string | null; params: { w: number[]; version: string; fittedAt: string | null; train: number[] | null; stretch: Record<string, number>; offsets: Record<string, number[]> }
  report: null | { split: { id: string; name: string; weight: number; points: number }[]; trainGames: number; testGames: number; trainLL: number; startLL: number; offsetLeagues: string[] }
  gate: Record<string, Gate> | null; perLeague: Record<string, { games: number; v3: Score; v4: Score }> | null; live: Record<string, { games: number; v3: Score; v4: Score }> | null
  stats: { mean: number[]; sd: number[] } | null
  /** fix222: the worker's own tune on the live database (after the deploy, then monthly) */
  auto: null | { why: string; at: string; applied: boolean; reason: string; before: number; after: number; passing: string[]; train: number[]; test: number; trainGames: number; testGames: number }
  autoDue: string | null
  /** fix223: the per-league settings on top of the shared ones */
  leagues?: { at: string | null; stale: boolean; due: string | null; report: LeagueReport | null }
  /** fix228: row #4 fitted on who actually played, frozen in the shared tune */
  miss?: MissInfo
  /** fix225: box-score value blended with on/off, the star factor */
  impact?: ImpactInfo
  /** fix236: the engine each group runs, why, since when */
  engine?: { env: string | null; at: string | null; groups: EngineRow[] }
}
type ImpactCheck = { name: string; games: number; cur: number; next: number; better: boolean; worse: boolean; tol?: number }
type ImpactReport = {
  at: string; why: string; train: number[]; test: number; seconds: number; applied: boolean; wb: number; tried: { wb: number; trainLL: number }[]
  box: { c: number[]; version: string; games: number }; miss: MissSet & { top?: number }; before: { wb: number | null; nba: number; star: number; top: number | null; other: number }
  gate: { pass: boolean; reason: string; checks: ImpactCheck[] }
  split: { nba: { before: number[]; after: number[] }; other: { before: number[]; after: number[] } }
  regate?: { rule: string; at: string; why: string; was: string; applied: boolean }
}
type ImpactPlayer = { id: number; name: string; rating: number; was?: number }
type ImpactInfo = {
  live: null | { wb: number; top: number | null; fittedAt: string }; due: string | null; report: ImpactReport | null; wb: number
  feats: string[]; box: { c: number[]; version: string; fittedAt: string | null; train: number[] | null; games: number }
  leagues: { code: string; before: ImpactPlayer[]; after: ImpactPlayer[] }[]
  withWithout: { team: string; player: string; season: string; with: { games: number; margin: number }; without: { games: number; margin: number }; real: number; before: number; after: number | null }[]
}
type MissSet = { w: number; star: number; proxy: number; fittedAt: string; train: number[]; test: number }
type MissTest = { games: number; cur: number; fit: number; gain: number }
type MissReport = {
  at: string; why: string; train: number[]; test: number; seconds: number; applied: boolean; miss: MissSet; before: { nba: number; other: number; star: number }
  oracle: { trainGames: number; startLL: number; trainLL: number; test: MissTest }
  proxy: null | { trainGames: number; startLL: number; trainLL: number; test: MissTest | null }
  gate: { pass: boolean; reason: string; oracle: { games: number; cur: number; next: number }; whole: { games: number; cur: number; next: number } }
  split: { nba: { before: number[]; after: number[] }; other: { before: number[]; after: number[] } }
}
type MissInfo = {
  frozen: MissSet | null; live: { nba: number; other: number }; due: string | null; report: MissReport | null
  examples: { gameId: number; kickoff: string; home: string; away: string; score: string; move: number; pHome: number; pickRight: boolean; fourRight: boolean }[]
}
type LsLL = number | null
type LeagueRow = {
  league: string; group: string | null; used: 'own' | 'group' | 'shared'; games: { train: number; test: number; check: number; live: number }
  test: { shared: LsLL; own: LsLL; group: LsLL; gain: LsLL }; check: { shared: LsLL; used: LsLL }; live: { shared: LsLL; used: LsLL }; why: string
  settings: null | { src: string; group: string | null; home: number; str: number; sig: number; off: number[] }; split: number[]
}
type LeagueReport = {
  at: string; base: string; years: { fit: number[]; test: number; refit: number[]; check: number; liveFrom: number }; leagues: LeagueRow[]
  groups: { group: string; members: string[]; pass: boolean; why: string }[]; sharedSplit: number[]; own: string[]; group: string[]; applied: boolean
  total: { test: { games: number; shared: LsLL; used: LsLL }; check: { games: number; shared: LsLL; used: LsLL }; live: { games: number; shared: LsLL; used: LsLL } }
}
type CalScore = { games: number; logLoss: number | null; brier: number | null; hit: number | null }
type CalBand = { lo: number; hi: number; n: number; said: number | null; happened: number | null }
type Calib = { at: string; source: string; test: { season: number; fitOn: number[]; raw: CalScore; ownFit: CalScore; sportFit: CalScore; sportKept: boolean; rawBands: CalBand[]; calBands: CalBand[] }
  perLeague: { league: string; games: number; raw: CalScore; cal: CalScore; kept: boolean; why: string }[]; strong: Record<string, number>; strongSport: number
  live: { games: number; raw: CalScore; cal: CalScore; rawBands: CalBand[]; calBands: CalBand[] }
  inSeason?: { season: number; kept: boolean; used: boolean; mode: 'on' | 'off'; why: string; games: number; tested: number; from: string | null; test: { base: CalScore; cal: CalScore; baseBands: CalBand[]; calBands: CalBand[] } } }
const ROWS = ['#1 Player impact', '#2 Net rating / 100', '#3 Team rating (bb-v3)', '#4 Missing players', '#5 Four factors', '#6 Rest', '#7 Home court', '#8 Carry-over', '#9 Matchups', '#10 Form', '#11 Motivation', '#12 3-pt volatility (sigma)', '#13 Head-to-head']

/**
 * fix234: the fit endpoints answer at once — ?run=1 starts the job, then the page asks every 5 s until it is done
 * ("running, started <time>" meanwhile); resolves with the job's result
 */
function runFitJob(url: string, say: (m: string) => void): Promise<any> {
  const sep = url.includes('?') ? '&' : '?'
  const ask = (run: boolean): Promise<any> => axios.get(run ? `${url}${sep}run=1` : url).then(r => {
    const a = r.data.data
    if (a.job?.state === 'failed') throw new Error(a.job.error || 'The job failed')
    if (a.job?.state === 'done') return a.result ?? a.stored
    if (a.job?.running) say(a.job.startedAt ? `Running, started ${new Date(a.job.startedAt).toLocaleTimeString('en-GB')}…` : `Waiting in the job queue since ${new Date(a.job.queuedAt).toLocaleTimeString('en-GB')}…`)
    return new Promise(res => setTimeout(res, 5000)).then(() => ask(false))
  })
  return ask(true)
}

/** fix219 (admin): bb-v4 grid — the gate per group, the fitted split, the test table, the live period, tune / apply. */
export default function BbGridCard() {
  const [d, setD] = useState<Info | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<any>(null)
  const [cal, setCal] = useState<Calib | null>(null)
  const [inMode, setInMode] = useState<{ mode: 'on' | 'off' | null; env: string | null }>({ mode: null, env: null })
  const [lsPreview, setLsPreview] = useState<LeagueReport | null>(null)
  const [missPreview, setMissPreview] = useState<MissReport | null>(null)
  const [impPreview, setImpPreview] = useState<ImpactReport | null>(null)
  const [impLeague, setImpLeague] = useState('NBA')
  const load = (q = '') => axios.get(`${API_URL}/bb/tuned${q}`).then(r => setD(r.data.data)).catch(() => setD(null))
  const loadCal = (q = '') => axios.get(`${API_URL}/admin/calibration?sport=basketball${q}`).then(r => { setCal(r.data.data.report); setInMode({ mode: r.data.data.inSeasonMode, env: r.data.data.inSeasonEnv }) }).catch(() => setCal(null))
  useEffect(() => { load(); loadCal() }, [])
  if (!d) return null
  const tune = (apply: boolean | 'gate') => {
    setBusy(true); setMsg(apply ? 'Fitting (in the job thread)…' : 'Fitting a preview…')
    runFitJob(`${API_URL}/bb/tune?train=2022,2023,2024&test=2025${apply === 'gate' ? '&apply=gate' : apply ? '&apply=1' : ''}`, setMsg)
      .then(data => { setPreview(data); setMsg(data.auto ? data.auto.reason : apply ? 'Applied: live predictions use the new weights.' : 'Preview below (not applied).'); load() })
      .catch(e => setMsg(errorText(e))).finally(() => setBusy(false))
  }
  // fix223: the per-league settings (report, or stored when apply)
  const leagueTune = (apply: boolean) => {
    setBusy(true); setMsg(apply ? 'Fitting the league settings and storing the ones that pass…' : 'Fitting the league settings (preview)…')
    runFitJob(`${API_URL}/bb/league-tune${apply ? '?apply=1' : ''}`, setMsg)
      .then(data => { setLsPreview(data); setMsg(apply ? `Stored: own ${data.own.join(', ') || 'none'}, group ${data.group.join(', ') || 'none'}.` : 'League settings preview below (not stored).'); load() })
      .catch(e => setMsg(errorText(e))).finally(() => setBusy(false))
  }
  const ls = lsPreview || d.leagues?.report || null
  // fix228: row #4 on who actually played (report, or stored through its gate)
  const missFit = (apply: 'gate' | '0') => {
    setBusy(true); setMsg(apply === 'gate' ? 'Fitting #4 on who actually played, stored if the gate passes…' : 'Fitting #4 on who actually played (preview)…')
    runFitJob(`${API_URL}/bb/missing-fit?apply=${apply}`, setMsg)
      .then(data => { setMissPreview(data); setMsg(data.applied ? `Stored: ${data.gate.reason}` : `Not stored: ${data.gate.reason}`); load() })
      .catch(e => setMsg(errorText(e))).finally(() => setBusy(false))
  }
  const mr = missPreview || d.miss?.report || null
  // fix225: box-score value blended with on/off + the star factor (report, or stored through its gate)
  const impactFit = (apply: 'gate' | '0') => {
    setBusy(true); setMsg(apply === 'gate' ? 'Fitting the box-score impact (several minutes), stored if the gate passes…' : 'Fitting the box-score impact (preview, several minutes)…')
    runFitJob(`${API_URL}/bb/impact-fit?apply=${apply}`, setMsg)
      .then(data => { setImpPreview(data); setMsg(data.applied ? `Stored: ${data.gate.reason}` : `Not stored: ${data.gate.reason}`); load() })
      .catch(e => setMsg(errorText(e))).finally(() => setBusy(false))
  }
  // fix236: the stored fix225 fit judged again by the gate on the live basis (no refit)
  const impactRegate = () => {
    setBusy(true); setMsg('Judging the stored box-score fit again (NBA #4 = who played), stored if the gate passes…')
    runFitJob(`${API_URL}/bb/impact-regate?apply=gate`, setMsg)
      .then(data => { setImpPreview(data); setMsg(data.applied ? `Stored: ${data.gate.reason}` : `Not stored: ${data.gate.reason}`); load() })
      .catch(e => setMsg(errorText(e))).finally(() => setBusy(false))
  }
  const ir = impPreview || d.impact?.report || null
  const il = d.impact?.leagues.find(x => x.code === impLeague) || d.impact?.leagues[0] || null
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
      <p className="text-sm text-muted">Gate on 2025-26 (or the 2025 season): bb-v4 must beat bb-v3 on log loss over the whole season and on games 1–25, per group; otherwise bb-v3 stays live there. Each group is judged the way it runs live: NBA #4 = who actually played (live: injury report + confirmed starters), other leagues the news / rest proxy. A failing group is checked again without its leagues' own settings (that may go live) and with #4's proxy changed (diagnosis only).</p>
      {d.engine && d.engine.groups.length > 0 && (
        <div className="mt-2 text-xs">
          {d.engine.groups.map(g => (
            <p key={g.group} className={g.engine === 'bb-v4' ? 'text-win' : g.group === 'NBA' ? 'text-loss font-semibold' : 'text-muted'}>
              <b>{g.group}</b>: {slAdmin(g.engine)}{g.variant === 'shared' ? ' (shared settings)' : ''}{g.since ? ` since ${new Date(g.since).toLocaleString('en-GB')}` : ''} — {g.reason}
            </p>
          ))}
          {d.engine.env && <p className="text-loss">BB_GRID={d.engine.env} overrides the gate.</p>}
        </div>
      )}
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
                  <td className={`py-1.5 font-semibold ${g.pass ? 'text-win' : 'text-loss'}`} title={`${g.reason}${g.basis ? ` [${g.basis}]` : ''}`}>{g.pass ? 'bb-v4' : 'bb-v3'}{g.variant === 'shared' ? ' (shared)' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {Object.values(d.gate).filter(g => g.checks?.length).map(g => (
            <p key={g.group} className="mt-1 text-xs text-faint num">
              {g.group} checked (whole season / games 1–25, bb-v3 {ll(g.whole.v3)} / {ll(g.first25.v3)}): {g.checks!.map(c => `${c.name} ${c.whole.toFixed(4)} / ${c.first25.toFixed(4)}${c.pass ? (c.live ? ' passes' : ' passes (diagnosis only)') : ''}`).join(' · ')}
            </p>
          ))}
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
        <button type="button" className={btn} disabled={busy} onClick={() => tune('gate')}>Fit, apply if the gate passes</button>
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
          <p className="text-faint">Live season (never fitted): {cal.live.games} games, log loss {cal.live.raw.logLoss} → {cal.live.cal.logLoss} · {cal.live.calBands.map((b, i) => (b.n ? `${b.lo}%+: said ${cal.live.rawBands[i].said} → ${b.said}, happened ${b.happened} (${b.n})` : '')).filter(Boolean).join(' · ')}</p>
          {cal.inSeason && (
            <div className="mt-2 rounded-lg border border-line/60 p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-ink font-semibold">In-season layer ({cal.inSeason.season}) · switch {inMode.mode || cal.inSeason.mode}{inMode.env ? ` (BB_INSEASON=${inMode.env})` : ''} · {cal.inSeason.used ? <b className="text-win">in use</b> : cal.inSeason.kept ? 'passes its test, switch off' : <span className="text-faint">not used</span>}</span>
                <span className="flex gap-2">
                  <button type="button" className={btn} disabled={(inMode.mode || cal.inSeason.mode) === 'on'} onClick={() => { loadCal('&inseason=on'); setMsg('In-season layer switched on: used when it passes its walk-forward test (rebuilding).') }}>Switch on</button>
                  <button type="button" className={btn} disabled={(inMode.mode || cal.inSeason.mode) === 'off'} onClick={() => { loadCal('&inseason=off'); setMsg('In-season layer switched off (rebuilding).') }}>Switch off</button>
                </span>
              </div>
              <p className="text-faint">{cal.inSeason.why} · {cal.inSeason.games} finished games this season{cal.inSeason.from ? `, tested from ${cal.inSeason.from}` : ''}</p>
              {cal.inSeason.tested > 0 && <p className="text-faint">{cal.inSeason.test.calBands.map((b, i) => (b.n ? `${b.lo}%+: said ${cal.inSeason!.test.baseBands[i].said} → ${b.said}, happened ${b.happened} (${b.n})` : '')).filter(Boolean).join(' · ')}</p>}
            </div>
          )}
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
      <div className="mt-4 text-xs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold text-ink">League settings (fix223)</h3>
          <span className="flex gap-2">
            <button type="button" className={btn} disabled={busy} onClick={() => leagueTune(false)}>Preview</button>
            <button type="button" className={btn} disabled={busy} onClick={() => leagueTune(true)}>Fit and store</button>
          </span>
        </div>
        <p className="text-faint">Per league: home edge, stretch, sigma and offsets for #1 / #3 / #4 / #6, pulled toward the shared settings. Fit {ls ? ls.years.fit.join(' + ') : '2022 + 2023'}, kept only when it beats the shared model on {ls ? ls.years.test : 2024}, refitted on all three; {ls ? ls.years.check : 2025} is the untouched check, {ls ? ls.years.liveFrom : 2026}+ reported, never tuned. Leagues under 400 train games share their group's (Europe second tier, Asia, Americas, Oceania).</p>
        {d.leagues && <p className={`text-faint ${d.leagues.stale ? 'text-loss' : ''}`}>{d.leagues.at ? `Stored ${new Date(d.leagues.at).toLocaleString('en-GB')} on ${d.leagues.report?.base || '—'}` : 'Not stored yet'}{d.leagues.stale ? ' · stale (fitted on other shared settings: not used)' : ''}{d.leagues.due ? ` · due: ${d.leagues.due}` : ''}</p>}
        {ls && (
          <>
            <p className="text-faint num">All leagues: {ls.years.test} {ls.total.test.shared} → {ls.total.test.used} ({ls.total.test.games}) · untouched {ls.years.check} {ls.total.check.shared} → {ls.total.check.used} ({ls.total.check.games}) · live {ls.total.live.shared} → {ls.total.live.used} ({ls.total.live.games}){lsPreview ? ' · preview' : ''}</p>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-faint text-left"><th className="pb-1 pr-3 font-normal">League</th><th className="pb-1 pr-3 font-normal">Used</th><th className="pb-1 pr-3 font-normal">Test gain</th><th className="pb-1 pr-3 font-normal">Check shared → used</th><th className="pb-1 pr-3 font-normal">Home · stretch · sigma</th><th className="pb-1 font-normal">Split #1 / #3 / #4 / #6 / #7</th></tr></thead>
                <tbody>
                  {ls.leagues.map(r => (
                    <tr key={r.league} className="border-t border-line/50" title={r.why}>
                      <td className="py-1 pr-3 text-ink font-semibold">{r.league} <span className="text-faint font-normal">({r.games.train})</span></td>
                      <td className={`py-1 pr-3 ${r.used === 'shared' ? 'text-faint' : 'text-win font-semibold'}`}>{r.used}{r.used === 'group' && r.group ? ` (${r.group})` : ''}</td>
                      <td className="py-1 pr-3 num">{r.test.gain ?? '—'}</td>
                      <td className="py-1 pr-3 num">{r.check.shared ?? '—'} → {r.check.used ?? '—'}</td>
                      <td className="py-1 pr-3 num">{r.settings ? `${r.settings.home > 0 ? '+' : ''}${r.settings.home} · ×${r.settings.str} · ×${r.settings.sig}` : '—'}</td>
                      <td className="py-1 num">{[0, 2, 3, 5, 6].map(i => r.split[i]).join(' / ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {d.miss && (
        <div className="mt-4 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-ink">#4 Missing players: who actually played (fix228)</h3>
            <span className="flex gap-2">
              <button type="button" className={btn} disabled={busy} onClick={() => missFit('0')}>Preview</button>
              <button type="button" className={btn} disabled={busy} onClick={() => missFit('gate')}>Fit, store if the gate passes</button>
            </span>
          </div>
          <p className="text-faint">The weight comes from past games' box scores (who played against the expected rotation: what the injury report and confirmed line-ups tell us live), not from history without injury reports. NBA: injury report + confirmed starters only. Other leagues: missed the last 2 games + news, at their own smaller weight.</p>
          <p className={d.miss.frozen ? 'text-win' : 'text-loss'}>
            {d.miss.frozen ? `Frozen since ${new Date(d.miss.frozen.fittedAt).toLocaleString('en-GB')}` : `Not frozen${d.miss.due ? ` (due: ${d.miss.due}; the worker runs it once)` : ''}`} · live weight NBA <b className="num">{d.miss.live.nba}</b>{d.miss.frozen?.star ? ` (star ×${d.miss.frozen.star})` : ''} · other leagues <b className="num">{d.miss.live.other}</b>
          </p>
          {mr && (
            <>
              <p className="text-faint num">
                {missPreview ? 'Preview' : 'Last fit'} {new Date(mr.at).toLocaleString('en-GB')} (train {mr.train.join(', ')}, test {mr.test}): NBA weight {mr.before.nba} → <b className="text-ink">{mr.miss.w}</b>, star {mr.before.star} → {mr.miss.star} · other leagues {mr.before.other} → <b className="text-ink">{mr.miss.proxy}</b>
              </p>
              <p className="text-faint num">
                Who played known (NBA {mr.test}, {mr.oracle.test.games} games): {mr.oracle.test.cur} → {mr.oracle.test.fit} (gain {mr.oracle.test.gain}){mr.proxy?.test ? ` · other leagues ${mr.proxy.test.cur} → ${mr.proxy.test.fit} (gain ${mr.proxy.test.gain})` : ''}
              </p>
              <p className={mr.gate.pass ? 'text-win' : 'text-loss'}>Gate: {mr.gate.reason}{mr.applied ? ' · stored' : ' · not stored'}</p>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-faint text-left"><th className="pb-1 pr-3 font-normal">1,000 points split</th><th className="pb-1 pr-3 font-normal">NBA before → after</th><th className="pb-1 font-normal">Other leagues before → after</th></tr></thead>
                  <tbody>
                    {ROWS.map((name, i) => (i === 11 ? null : (
                      <tr key={name} className={`border-t border-line/40 ${i === 3 ? 'text-ink font-semibold' : ''}`}>
                        <td className="py-0.5 pr-3">{name}</td>
                        <td className="py-0.5 pr-3 num">{mr.split.nba.before[i]} → {mr.split.nba.after[i]}</td>
                        <td className="py-0.5 num">{mr.split.other.before[i]} → {mr.split.other.after[i]}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="mt-2 text-faint">Last 20 NBA games where #4 moved the margin 2+ points</div>
          {d.miss.examples.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-faint text-left"><th className="pb-1 pr-3 font-normal">Game</th><th className="pb-1 pr-3 font-normal">#4 (home view)</th><th className="pb-1 pr-3 font-normal">Home chance</th><th className="pb-1 pr-3 font-normal">Result</th><th className="pb-1 font-normal">#4 side won</th></tr></thead>
                <tbody>
                  {d.miss.examples.map(x => (
                    <tr key={x.gameId} className="border-t border-line/40">
                      <td className="py-0.5 pr-3 text-ink">{x.kickoff.slice(0, 10)} {x.home} – {x.away}</td>
                      <td className="py-0.5 pr-3 num">{x.move > 0 ? '+' : ''}{x.move}</td>
                      <td className="py-0.5 pr-3 num">{Math.round(x.pHome * 100)}%</td>
                      <td className={`py-0.5 pr-3 num ${x.pickRight ? 'text-win' : 'text-loss'}`}>{x.score}</td>
                      <td className={`py-0.5 ${x.fourRight ? 'text-win' : 'text-loss'}`}>{x.fourRight ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-faint">#4 side won in {d.miss.examples.filter(x => x.fourRight).length} of {d.miss.examples.length}.</p>
            </div>
          ) : <p className="text-faint">None yet (logged at the 90 / 30 / 10 minute re-pricing).</p>}
        </div>
      )}
      {d.impact && (
        <div className="mt-4 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-semibold text-ink">Key players count more: box-score value + on/off (fix225)</h3>
            <span className="flex gap-2">
              <button type="button" className={btn} disabled={busy} onClick={() => impactFit('0')}>Preview</button>
              <button type="button" className={btn} disabled={busy} onClick={() => impactFit('gate')}>Fit, store if the gate passes</button>
              {d.impact.report && !d.impact.report.applied && <button type="button" className={btn} disabled={busy} onClick={impactRegate}>Judge the stored fit again</button>}
            </span>
          </div>
          <p className="text-faint">Player impact = box-score value (points, shot attempts, 3-pointers, rebounds, assists per game length, pace-adjusted; a team's players add up to its net rating) × share + on/off rating × the rest, the on/off shrink scaled by minutes. A top-3 player out counts × the star factor in #4 (NBA). Gate on {ir ? ir.test : 2025}: NBA and Europe, whole season and games 1–25, and the NBA's games with who played known.</p>
          <p className={d.impact.live ? 'text-win' : 'text-loss'}>
            {d.impact.live ? `Live since ${new Date(d.impact.live.fittedAt).toLocaleString('en-GB')}: box ×${d.impact.live.wb} + on/off ×${Math.round((1 - d.impact.live.wb) * 100) / 100}${d.impact.live.top ? ` · star factor ×${d.impact.live.top}` : ''}` : `Not live: today's on/off ratings${d.impact.due ? ` (due: ${d.impact.due}; the worker runs it once, after the model build stored the new values)` : ''}`}
          </p>
          <p className="text-faint num">Formula ({d.impact.box.version}{d.impact.box.train ? `, fitted on ${d.impact.box.train.join(', ')}, ${d.impact.box.games} games` : ''}): {d.impact.feats.map((f, i) => `${f} ${d.impact!.box.c[i]}`).join(' · ')}</p>
          {ir && (
            <>
              <p className="text-faint num">
                {impPreview ? 'Preview' : 'Last fit'} {new Date(ir.at).toLocaleString('en-GB')} (train {ir.train.join(', ')}, {ir.seconds} s): box share <b className="text-ink">{ir.wb}</b> (tried {ir.tried.map(t => `${t.wb}: ${t.trainLL}`).join(', ')}) · NBA #4 {ir.before.nba} → <b className="text-ink">{ir.miss.w}</b>, star factor <b className="text-ink">×{ir.miss.top}</b> · other leagues {ir.before.other} → {ir.miss.proxy}
              </p>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-faint text-left"><th className="pb-1 pr-3 font-normal">Test {ir.test}</th><th className="pb-1 pr-3 font-normal">Games</th><th className="pb-1 font-normal">Log loss today → new</th></tr></thead>
                  <tbody>
                    {ir.gate.checks.map(c => (
                      <tr key={c.name} className="border-t border-line/40">
                        <td className="py-0.5 pr-3 text-ink">{c.name}</td>
                        <td className="py-0.5 pr-3 num">{c.games}</td>
                        <td className="py-0.5 num">{c.cur.toFixed(4)} → <b className={c.better ? 'text-win' : c.worse ? 'text-loss' : 'text-muted'}>{c.next.toFixed(4)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={ir.gate.pass ? 'text-win' : 'text-loss'}>Gate: {ir.gate.reason}{ir.applied ? ' · stored' : ' · not stored'}</p>
              {ir.regate && <p className="text-faint">Judged again {new Date(ir.regate.at).toLocaleString('en-GB')} ({ir.regate.why}); the first gate said: {ir.regate.was}</p>}
              <p className="text-faint num">1,000 points split, NBA before → after: {ROWS.map((n, i) => (i === 11 ? null : `${n.split(' ')[0]} ${ir.split.nba.before[i]}→${ir.split.nba.after[i]}`)).filter(Boolean).join(' · ')}</p>
            </>
          )}
          {d.impact.leagues.length > 0 && il && (
            <div className="mt-2">
              <div className="flex flex-wrap gap-1 mb-1">
                {d.impact.leagues.map(x => <button key={x.code} type="button" className={`px-2 py-0.5 rounded-full border ${x.code === il.code ? 'border-accent text-ink' : 'border-line text-muted'}`} onClick={() => setImpLeague(x.code)}>{x.code}</button>)}
              </div>
              <div className="grid sm:grid-cols-2 gap-x-6">
                <div>
                  <div className="text-faint mb-0.5">Top 20 before (on/off, points per game length)</div>
                  {il.before.map((p, i) => <div key={p.id} className="flex justify-between border-t border-line/40 py-0.5"><span className="text-ink">{i + 1}. {p.name}</span><span className="num">{p.rating > 0 ? '+' : ''}{p.rating}</span></div>)}
                </div>
                <div>
                  <div className="text-faint mb-0.5">Top 20 after (box ×{d.impact.wb} + on/off)</div>
                  {il.after.map((p, i) => <div key={p.id} className="flex justify-between border-t border-line/40 py-0.5"><span className="text-ink">{i + 1}. {p.name}</span><span className="num">{p.rating > 0 ? '+' : ''}{p.rating} <span className="text-faint">(was {p.was})</span></span></div>)}
                </div>
              </div>
            </div>
          )}
          {d.impact.withWithout.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <div className="text-faint mb-0.5">With / without their top player this season (margin a game) vs what #4 implies</div>
              <table className="w-full text-xs">
                <thead><tr className="text-faint text-left"><th className="pb-1 pr-3 font-normal">Team · player</th><th className="pb-1 pr-3 font-normal">With</th><th className="pb-1 pr-3 font-normal">Without</th><th className="pb-1 pr-3 font-normal">Real gap</th><th className="pb-1 font-normal">Model before → after</th></tr></thead>
                <tbody>
                  {d.impact.withWithout.map(x => (
                    <tr key={x.team} className="border-t border-line/40">
                      <td className="py-0.5 pr-3 text-ink">{x.team} · {x.player}</td>
                      <td className="py-0.5 pr-3 num">{x.with.margin > 0 ? '+' : ''}{x.with.margin} ({x.with.games})</td>
                      <td className="py-0.5 pr-3 num">{x.without.margin > 0 ? '+' : ''}{x.without.margin} ({x.without.games})</td>
                      <td className="py-0.5 pr-3 num font-semibold">{x.real}</td>
                      <td className="py-0.5 num">{x.before} → {x.after ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-faint">Small samples: a team's games without its star are few; read the direction, not the decimals.</p>
            </div>
          )}
        </div>
      )}
      {report && <p className="mt-2 text-[11px] text-faint num">Last fit: {report.trainGames} train games, log loss {report.startLL} → {report.trainLL}; per-league offsets: {(report.offsetLeagues || []).join(', ') || 'none'}.</p>}
    </section>
  )
}

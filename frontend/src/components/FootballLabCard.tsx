import { Fragment, useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'

type Band = { from: number; to: number; n: number; hit: number }
type Score = {
  n: number; logLoss: number; brier: number; dcLogLoss: number; dcBrier: number; dcHit: number; hit: number
  hit60: { n: number; hit: number }; bands: Band[]
  market: { n: number; ours: number; market: number; dcOurs: number; dcMarket: number; hit60Market: { n: number; hit: number } } | null
}
type CandWindow = { key: string; score: Score; diff: { n: number; diff: number; hitC: number; hitB: number }; params: string }
type Cand = { cand: string; label: string; windows: CandWindow[]; verdict: { pass: boolean; why: string; pooled: number; boot: { pBetter: number } | null } }
type Win = { key: string; label: string; from: string; to: string; src: 'season' | 'record'; judge: boolean; train: number; n: number }
type PickRule = { thresholds: Record<string, number>; pooled: { t: number; n: number; hit: number }[]; shown: { n: number; hit: number }; all: { n: number; hit: number } }
type Report = {
  builtAt: string; ms: number; notes: string[]; windows: Win[]; champion: { key: string; score: Score }[]; cands: Cand[]
  pickRule: { key: string; rule: PickRule }[]; winner: string | null; winnerWhy: string
  decision: string; decisionWhy: string; liveNow: { label: string; since: string; guard: { n: number; diff: number } } | null
  names: { before: string; after: string | null }; rules: { gbmMinGain: number; pickTarget: number }
}
type Answer = { job: { running: boolean; startedAt: string | null; error: string | null } | null; result: Report | null; stored: Report | null }

const sg = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(4)}`
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const band = (b: Band) => `${Math.round(b.from * 100)}${b.to >= 1 ? '%+' : `–${Math.round(b.to * 100)}%`}`
const DECISION: Record<string, string> = { promote: 'Promoted', refit: 'Live layer refitted', keep: 'Live layer kept', rollback: 'Rolled back', none: 'No change', held: 'Passed, held (one promotion a week)' }

function Row({ name, s, d, base, verdict, onClick, open }: { name: string; s: Score; d: number | null; base: Score; verdict?: Cand['verdict']; onClick?: () => void; open?: boolean }) {
  const td = 'py-1.5 pe-3 num whitespace-nowrap'
  const better = (a: number, b: number, lower = true) => (d === null || a === b ? '' : (lower ? a < b : a > b) ? 'text-win' : 'text-loss')
  return (
    <tr className={`border-t border-line/50 ${onClick ? 'cursor-pointer' : ''} ${open ? 'bg-accent/5' : ''}`} onClick={onClick}>
      <td className="py-1.5 pe-3 text-ink">{name}{verdict && <span className={`block text-xs ${verdict.pass ? 'text-win font-semibold' : 'text-faint'}`}>{verdict.pass ? '✓ passes' : '·'} {verdict.why}</span>}</td>
      <td className={td}>{s.n}</td>
      <td className={`${td} ${better(s.logLoss, base.logLoss)}`}>{s.logLoss}</td>
      <td className={`${td} ${better(s.brier, base.brier)}`}>{s.brier}</td>
      <td className={`${td} ${better(s.dcLogLoss, base.dcLogLoss)}`}>{s.dcLogLoss}</td>
      <td className={`${td} font-semibold ${better(s.dcHit, base.dcHit, false)}`}>{s.dcHit}%</td>
      <td className={`${td} ${better(s.hit, base.hit, false)}`}>{s.hit}%</td>
      <td className={td}>{s.hit60.hit}% <span className="text-faint">({s.hit60.n})</span></td>
      <td className={td}>{s.market ? <>{sg(s.market.ours - s.market.market)} <span className="text-faint">· DC {s.market.dcOurs}% vs {s.market.dcMarket}% ({s.market.n})</span></> : '—'}</td>
      <td className={`${td} ${d === null ? 'text-faint' : d < 0 ? 'text-win' : d > 0 ? 'text-loss' : ''}`}>{d === null ? '—' : sg(d)}</td>
    </tr>
  )
}

/**
 * fix291: Admin → Predictions & models → "Football lab": six candidates to make the double-chance pick surer, each fitted
 * only on games before the window it is scored on (2024-25, 2025-26, this season, the record's 60 days): log loss / Brier
 * for 1X2 and for the double-chance pick, hit rates, the closing market on the same games, before → after per band, the
 * per-league pick rule and fix251's verdict. Market numbers stay admin-only.
 */
export default function FootballLabCard() {
  const [d, setD] = useState<Report | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [win, setWin] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const ask = (run: boolean): Promise<void> =>
    axios.get(`${API_URL}/admin/football-lab${run ? '?run=1' : ''}`).then(r => {
      const a: Answer = r.data.data
      const rep = a.result || a.stored
      if (rep && Array.isArray(rep.cands)) setD(rep)
      if (a.job?.running) {
        setMsg(a.job.startedAt ? `Running, started ${new Date(a.job.startedAt).toLocaleTimeString('en-GB')}…` : 'Waiting in the job queue…')
        return new Promise<void>(res => setTimeout(res, 5000)).then(() => ask(false))
      }
      setMsg(a.job?.error ? `Failed: ${a.job.error}` : '')
    })
  const run = () => { setBusy(true); ask(true).catch(() => setMsg('Could not start the lab')).finally(() => setBusy(false)) }
  useEffect(() => { ask(false).catch(() => setD(null)) }, [])

  const head = (
    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
      <h2 className="font-display text-lg font-bold text-ink">Football lab</h2>
      <span className="text-xs text-faint">admin only{d ? ` · built ${when(d.builtAt)} · ${Math.round(d.ms / 1000)} s` : ''} · <button type="button" onClick={run} disabled={busy} className="text-accent font-semibold">{busy ? 'running…' : 'run now'}</button></span>
    </div>
  )
  if (!d) return <section className="card p-5 sm:p-6 mb-8">{head}<p className="text-sm text-faint">{msg || 'No run yet — it runs every night at 05:10 UTC (and 40 minutes after a restart).'}</p></section>
  const key = win && d.windows.some(w => w.key === win) ? win : (d.windows.find(w => w.src === 'record') || d.windows[d.windows.length - 1])?.key
  const w = d.windows.find(x => x.key === key)
  const base = d.champion.find(c => c.key === key)?.score
  const pr = d.pickRule.find(p => p.key === key)?.rule
  const th = 'pb-1 pe-3 font-normal whitespace-nowrap'
  const openCand = d.cands.find(c => c.cand === open)
  const openWin = openCand?.windows.find(x => x.key === key)
  return (
    <section className="card p-5 sm:p-6 mb-8">
      {head}
      {msg && <p className="text-xs text-muted mb-2">{msg}</p>}
      <p className="text-sm text-ink"><b>{DECISION[d.decision] || d.decision}:</b> {d.decisionWhy}</p>
      <p className="text-xs text-muted mt-1">
        Live layer: {d.liveNow ? `${d.liveNow.label} since ${d.liveNow.since}${d.liveNow.guard.n ? ` (${d.liveNow.guard.n} record games, ${sg(d.liveNow.guard.diff)} vs no layer)` : ''}` : 'none'} · public name {d.names.before}{d.names.after ? ` → ${d.names.after}` : ''}
      </p>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {d.windows.map(x => (
          <button key={x.key} type="button" onClick={() => setWin(x.key)}
            className={`text-xs px-2 py-1 rounded-full border ${x.key === key ? 'border-accent text-ink font-semibold' : 'border-line text-muted'}`}>
            {x.label}{x.judge ? ' ·judged' : ''}
          </button>
        ))}
      </div>
      {w && <p className="text-xs text-faint mt-1">{w.from} → {w.to} · {w.n} games scored, fitted on {w.train} earlier games{w.judge ? ' · one of the two windows fix251’s rule judges' : ''}</p>}

      {base && (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-sm">
            <thead><tr className="text-faint text-start">
              <th className={th}>Candidate</th><th className={th}>Games</th><th className={th}>Log loss</th><th className={th}>Brier</th><th className={th}>DC log loss</th>
              <th className={th}>DC right</th><th className={th}>1X2 right</th><th className={th}>1X2 60%+</th><th className={th}>vs market (log loss · DC)</th><th className={th}>vs today</th>
            </tr></thead>
            <tbody>
              <Row name="Today (champion)" s={base} d={null} base={base} />
              {d.cands.map(c => {
                const cw = c.windows.find(x => x.key === key)
                return cw ? <Fragment key={c.cand}><Row name={c.label} s={cw.score} d={cw.diff.diff} base={base} verdict={c.verdict} open={open === c.cand} onClick={() => setOpen(open === c.cand ? null : c.cand)} /></Fragment> : null
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-faint mt-1">Click a candidate for its settings and before → after per band. DC = our double-chance pick (the two most likely results). Green = better than today on the same games. The combiner must win by {d.rules.gbmMinGain} or more.</p>

      {openCand && openWin && base && (
        <div className="mt-3">
          <p className="text-xs text-ink"><b>{openCand.label}</b> — fitted: {openWin.params}</p>
          <div className="overflow-x-auto">
            <table className="text-sm mt-1">
              <thead><tr className="text-faint text-start"><th className={th}>DC chance</th><th className={th}>Today</th><th className={th}>After</th></tr></thead>
              <tbody>
                {base.bands.map((b, i) => {
                  const a = openWin.score.bands[i]
                  return (
                    <tr key={b.from} className="border-t border-line/50">
                      <td className="py-1 pe-3 num">{band(b)}</td>
                      <td className="py-1 pe-3 num">{b.hit}% <span className="text-faint">({b.n})</span></td>
                      <td className="py-1 pe-3 num"><b className={a.hit > b.hit ? 'text-win' : a.hit < b.hit ? 'text-loss' : ''}>{a.hit}%</b> <span className="text-faint">({a.n})</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pr && (
        <div className="mt-4">
          <h3 className="font-semibold text-ink text-sm">6. Per-league pick rule (report only)</h3>
          <p className="text-xs text-muted">Each league shows the double-chance pick only above its own threshold (the lowest that was right {Math.round(d.rules.pickTarget * 100)}%+ on its earlier games). Here: {pr.shown.n} of {pr.all.n} picks shown, right {pr.shown.hit}% (all picks {pr.all.hit}%). Showing fewer picks is a site change — Yarin decides.</p>
          <div className="overflow-x-auto">
            <table className="text-sm mt-1">
              <thead><tr className="text-faint text-start"><th className={th}>Show picks from</th>{pr.pooled.map(p => <th key={p.t} className={th}>{Math.round(p.t * 100)}%</th>)}</tr></thead>
              <tbody>
                <tr className="border-t border-line/50"><td className="py-1 pe-3 text-faint">Picks</td>{pr.pooled.map(p => <td key={p.t} className="py-1 pe-3 num">{p.n}</td>)}</tr>
                <tr className="border-t border-line/50"><td className="py-1 pe-3 text-faint">Right</td>{pr.pooled.map(p => <td key={p.t} className="py-1 pe-3 num">{p.n ? `${p.hit}%` : '—'}</td>)}</tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ul className="text-xs text-faint mt-3 list-disc ps-4">{d.notes.map(n => <li key={n}>{n}</li>)}</ul>
    </section>
  )
}

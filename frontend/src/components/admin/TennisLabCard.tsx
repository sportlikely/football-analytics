import { Fragment, useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import CopyForClaude from './CopyForClaude'
import type { ForClaudeReq } from '../../lib/forClaude'

type Band = { band: string; n: number; said: number | null; happened: number | null }
type Row = {
  family: string; label: string; setting: string; kept: boolean | null; note: string; val2024: number | null
  test: { n: number; logLoss: number | null; brier: number | null; hit: number | null; bands: Band[] }
  years: Record<string, number | null>; market: { n: number; model: number | null; market: number | null }
}
type Lab = {
  version: string; builtAt: string; minutes: number; promoted: boolean; why: string
  split: { validation: string; test: string; validationMatches: number; testMatches: number; pricedTestMatches: number }
  rows: Row[]
  market: {
    matches: number; sources: string
    anchor: { kept: boolean; w: number; why: string; oos: { model: number; market: number; blend: number } | null }
    combiner: { n: number; logLoss: number | null; w: [number, number] | null; kept: boolean }
  }
}
type Answer = { lab: Lab | null; promoted: { at: string; why: string } | null; running: { phase: string | null; detail: string | null } | null; text: string }

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never')
const v = (x: number | null | undefined) => (x == null ? '—' : x)

/**
 * fix293 (admin only): "Tennis lab" — every idea for the tennis model tried walk-forward (setting picked on 2024, scored
 * on Jan 2025 → today, never used to pick): log loss, Brier, hit rate, said vs happened per band, each year, and the
 * matches with a market price (model vs market). The market rows: the anchor's walk-forward weight and a learned
 * combiner. The winner is promoted only when better on the test months in 2025 and 2026 alike.
 */
export default function TennisLabCard() {
  const [d, setD] = useState<Answer | null>(null)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const load = () => axios.get(`${API_URL}/admin/tennis-lab`).then(r => setD(r.data.data)).catch(() => setMsg('Could not load the lab'))
  const run = () => axios.get(`${API_URL}/admin/tennis-lab?run=1`).then(() => setMsg('Started on the server (it runs after the next predictions; 20–60 minutes).')).catch(() => setMsg('Could not start the lab'))
  useEffect(() => { load() }, [])
  const req = (): ForClaudeReq => ({ place: 'Admin → Predictions & models → Tennis lab', scope: 'card', shown: [{ title: 'Tennis lab', text: d?.text || '' }] })
  const lab = d?.lab
  const th = 'pb-1 pe-3 font-normal'
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Tennis lab</h2>
        <span className="text-xs text-faint flex flex-wrap items-center gap-2">
          admin only{lab ? ` · built ${when(lab.builtAt)} (${lab.minutes} min)` : ''}
          <button type="button" onClick={run} className="text-accent font-semibold">run again</button>
          <CopyForClaude size="sm" req={req} />
        </span>
      </div>
      {msg && <p className="text-xs text-muted mb-2">{msg}</p>}
      {d?.running?.phase === 'lab' && <p className="text-xs text-muted mb-2">Running: {d.running.detail}</p>}
      {!lab ? (
        <p className="text-sm text-faint">{d ? 'Not run yet: it runs on the server after the tennis report (once per full month).' : 'Loading…'}</p>
      ) : (
        <>
          <p className="text-xs text-faint">
            Each idea's setting is picked on {lab.split.validation} ({lab.split.validationMatches} matches) and kept when it lowers that log loss by 0.0003; the test
            ({lab.split.test}, {lab.split.testMatches} matches) is never used to pick. Lower log loss / Brier is better. Click a row for said vs happened per band.
          </p>
          <p className={`text-sm mt-2 ${lab.promoted ? 'text-win' : 'text-muted'}`}>{lab.promoted ? 'Promoted: ' : 'Not promoted: '}{lab.why}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm mt-2">
              <thead><tr className="text-faint text-start">
                <th className={th}>Idea</th><th className={th}>Setting</th><th className={th}>2024 LL</th><th className={th}>Test LL</th><th className={th}>Brier</th>
                <th className={th}>Hit %</th><th className={th}>2025</th><th className={th}>2026</th><th className={th}>Priced: ours vs market</th><th className={th}>Kept</th>
              </tr></thead>
              <tbody>
                {lab.rows.map(r => (
                  <Fragment key={r.family}>
                    <tr className="border-t border-line/50 cursor-pointer" onClick={() => setOpen(open === r.family ? null : r.family)}>
                      <td className="py-1.5 pe-3 text-ink">{r.label}</td>
                      <td className="py-1.5 pe-3 text-muted">{r.setting}</td>
                      <td className="py-1.5 pe-3 num">{v(r.val2024)}</td>
                      <td className="py-1.5 pe-3 num">{v(r.test.logLoss)}</td>
                      <td className="py-1.5 pe-3 num">{v(r.test.brier)}</td>
                      <td className="py-1.5 pe-3 num">{v(r.test.hit)}</td>
                      <td className="py-1.5 pe-3 num">{v(r.years['2025'])}</td>
                      <td className="py-1.5 pe-3 num">{v(r.years['2026'])}</td>
                      <td className="py-1.5 pe-3 num whitespace-nowrap">{v(r.market.model)} vs {v(r.market.market)} ({r.market.n})</td>
                      <td className={`py-1.5 pe-3 ${r.kept ? 'text-win' : 'text-faint'}`}>{r.kept == null ? '' : r.kept ? 'yes' : 'no'}</td>
                    </tr>
                    {open === r.family && (
                      <tr><td colSpan={10} className="pb-2 text-xs text-muted">
                        {r.note} · {r.test.bands.filter(b => b.n).map(b => `${b.band}%: said ${b.said}, happened ${b.happened} (${b.n})`).join(' · ')}
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted mt-3">
            Market ({lab.market.matches} test matches with a price: {lab.market.sources}). Anchor: {lab.market.anchor.kept ? `weight ${lab.market.anchor.w}` : 'model only'} — {lab.market.anchor.why}.
            {' '}Learned combiner: {v(lab.market.combiner.logLoss)} on {lab.market.combiner.n} unseen matches ({lab.market.combiner.kept ? 'better than the model and the market' : 'not better than both'}).
          </p>
        </>
      )}
    </section>
  )
}

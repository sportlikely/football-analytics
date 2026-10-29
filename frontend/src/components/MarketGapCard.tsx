import { Fragment, useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import CopyForClaude from './admin/CopyForClaude'
import type { ForClaudeReq } from '../lib/forClaude'

type Closer = { n: number; oursMae?: number; marketMae?: number; oursLogLoss?: number; marketLogLoss?: number; oursBrier?: number; marketBrier?: number } | null
type Gap = { n: number; meanGap: number | null; medianAbs: number | null }
type Window = { settled: Gap & { closer: Closer }; upcoming: Gap; leagues: (Gap & { league: string; closer: Closer })[] }
type Fit = { n: number; tested: number; w: number; kept: boolean; why: string }
type Market = {
  market: string; label: string; kind: 'line' | 'chance'; windows: { d30: Window; d90: Window }
  limit: { limit: number; unit: 'points' | 'chance'; label: string } | null
  gate: { n: number; medianAbs: number | null; feed: boolean } | null
  anchor: Record<string, Fit> | null
}
type Biggest = { market: string; label: string; id: number; league: string; kickoff: string; ours: number; marketLine: number; gap: number; why: string | null }
type Feed = { lastFull: string | null; lastClose: string | null; games: number; lines: number; closing: number; skipped: string | null; error: string | null; markets?: string[] }
type Level = { test: { n: number; maeModel: number | null; maeShift: number | null; kept: boolean; why: string }; shifts: Record<string, { season: string; n: number; shift: number }>; k: number } | null
type Sport = { sport: string; markets: Market[]; biggest: Biggest[]; feed: Feed; level: Level }
type Report = { builtAt: string; rules: { gateGames: number }; sports: Sport[] }
type Answer = { job: { running: boolean; startedAt: string | null; error: string | null } | null; report: Report; text: string }

const NAME: Record<string, string> = { basketball: 'Basketball', nfl: 'American football', football: 'Football', tennis: 'Tennis' }
const sg = (x: number | null | undefined) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x}`)
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never')
const closer = (c: Closer) => {
  if (!c) return '—'
  if (c.oursMae != null) return <span className={c.oursMae <= c.marketMae! ? 'text-win' : 'text-loss'}>{c.oursMae} vs {c.marketMae}</span>
  return <span className={c.oursLogLoss! <= c.marketLogLoss! ? 'text-win' : 'text-loss'}>{c.oursLogLoss} vs {c.marketLogLoss}</span>
}
const anchorText = (a: Record<string, Fit> | null) => (!a ? 'no fit yet' : Object.entries(a).map(([g, f]) => `${g === 'all' ? 'all' : g}: ${f.kept ? `weight ${f.w}` : 'model only'}`).join(' · '))

/**
 * fix278 (admin only): "Our lines vs the market" — per sport × market, the mean gap (ours − market: below 0 = we are
 * low) and the median |gap| over the last 30 / 90 days (settled games against the closing line, upcoming against the
 * latest), who was closer to what happened, per league, the anchor's walk-forward weight, the public gate (300 games,
 * the limit), and the 10 biggest gaps of the next 24 hours with the reasons the model gives. Market numbers never
 * reach the public site.
 */
export default function MarketGapCard() {
  const [d, setD] = useState<Answer | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [days, setDays] = useState<'d30' | 'd90'>('d30')
  const [open, setOpen] = useState<string | null>(null)
  const ask = (run: boolean, fresh = false): Promise<void> =>
    axios.get(`${API_URL}/admin/market-gap${run ? '?run=1' : fresh ? '?fresh=1' : ''}`).then(r => {
      const a: Answer = r.data.data
      setD(a)
      if (a.job?.running) {
        setMsg(a.job.startedAt ? `Fitting, started ${new Date(a.job.startedAt).toLocaleTimeString('en-GB')}…` : 'Waiting in the job queue…')
        return new Promise<void>(res => setTimeout(res, 5000)).then(() => ask(false, true))
      }
      setMsg(a.job?.error ? `Failed: ${a.job.error}` : '')
    })
  const run = () => { setBusy(true); ask(true).catch(() => setMsg('Could not start the fits')).finally(() => setBusy(false)) }
  useEffect(() => { ask(false).catch(() => setMsg('Could not load the report')) }, [])

  const req = (): ForClaudeReq => ({
    place: 'Admin → Predictions & models → Our lines vs the market', scope: 'card',
    checks: [{ id: 'market-close-basketball' }, { id: 'market-close-nfl' }, { id: 'market-close-football' }, { id: 'market-close-tennis' }],
    shown: [{ title: 'Our lines vs the market', text: d?.text || '' }]
  })
  const head = (
    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
      <h2 className="font-display text-lg font-bold text-ink">Our lines vs the market</h2>
      <span className="text-xs text-faint flex flex-wrap items-center gap-2">
        admin only{d ? ` · built ${when(d.report.builtAt)}` : ''}
        <button type="button" onClick={() => setDays(days === 'd30' ? 'd90' : 'd30')} className="text-accent font-semibold">{days === 'd30' ? 'last 30 days' : 'last 90 days'}</button>
        <button type="button" onClick={run} disabled={busy} className="text-accent font-semibold">{busy ? 'running…' : 'fit the anchor now'}</button>
        <CopyForClaude size="sm" req={req} />
      </span>
    </div>
  )
  if (!d) return <section className="card p-5 sm:p-6 mb-8">{head}<p className="text-sm text-faint">{msg || 'Loading…'}</p></section>
  const th = 'pb-1 pe-3 font-normal'
  return (
    <section className="card p-5 sm:p-6 mb-8">
      {head}
      {msg && <p className="text-xs text-muted mb-2">{msg}</p>}
      <p className="text-xs text-faint">
        Gap = ours − market (below 0: we are lower). Settled games are compared with the closing line, upcoming ones with the latest. An output goes public only
        with {d.report.rules.gateGames}+ settled games and a median gap within its limit; the anchor blends the market in only when that beat both the model and the market on games it never saw.
      </p>
      {d.report.sports.map(s => (
        <div key={s.sport} className="mt-5">
          <h3 className="font-semibold text-ink text-sm">{NAME[s.sport] || s.sport}</h3>
          <p className="text-xs text-faint">
            Feed: last snapshot {when(s.feed.lastFull)}, {s.feed.games} games, {s.feed.lines} lines, {s.feed.closing} closing{s.feed.skipped ? ` · ${s.feed.skipped}` : ''}{s.feed.error ? ` · error: ${s.feed.error}` : ''}
            {s.sport === 'tennis' && ` · markets seen: ${(s.feed.markets || []).join(', ') || 'none yet'}`}
          </p>
          {s.level && (
            <p className="text-xs text-faint">Season scoring level: {s.level.test.why}{s.level.test.kept ? ` — shifts ${Object.entries(s.level.shifts).filter(([, v]) => v.shift).slice(0, 12).map(([l, v]) => `${l} ${sg(v.shift)}`).join(', ') || 'none'}` : ''}</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm mt-1">
              <thead><tr className="text-faint text-start">
                <th className={th}>Market</th><th className={th}>Settled</th><th className={th}>Mean gap</th><th className={th}>Median |gap|</th>
                <th className={th}>Closer to the result (ours vs market)</th><th className={th}>Upcoming</th><th className={th}>Public gate</th><th className={th}>Anchor</th>
              </tr></thead>
              <tbody>
                {s.markets.map(m => {
                  const w = m.windows[days], key = `${s.sport}|${m.market}`
                  const over = m.limit && m.gate && m.gate.medianAbs != null && m.gate.n >= d.report.rules.gateGames && m.gate.medianAbs > m.limit.limit
                  return (
                    <Fragment key={key}>
                      <tr className="border-t border-line/50 cursor-pointer" onClick={() => setOpen(open === key ? null : key)}>
                        <td className="py-1.5 pe-3 text-ink whitespace-nowrap">{m.label}</td>
                        <td className="py-1.5 pe-3 num">{w.settled.n}</td>
                        <td className={`py-1.5 pe-3 num ${w.settled.meanGap != null && Math.abs(w.settled.meanGap) > (m.limit?.limit ?? 3) ? 'text-loss' : ''}`}>{sg(w.settled.meanGap)}</td>
                        <td className="py-1.5 pe-3 num">{w.settled.medianAbs ?? '—'}</td>
                        <td className="py-1.5 pe-3 num whitespace-nowrap">{closer(w.settled.closer)}</td>
                        <td className="py-1.5 pe-3 num whitespace-nowrap">{w.upcoming.n} · {sg(w.upcoming.meanGap)}</td>
                        <td className={`py-1.5 pe-3 text-xs ${over ? 'text-loss' : 'text-faint'}`}>
                          {!m.limit ? '—' : !m.gate?.feed ? 'not in the feed' : m.gate.n < d.report.rules.gateGames ? `collecting ${m.gate.n} / ${d.report.rules.gateGames}` : `${m.gate.medianAbs} (limit ${m.limit.limit})`}
                        </td>
                        <td className="py-1.5 pe-3 text-xs text-faint">{anchorText(m.anchor)}</td>
                      </tr>
                      {open === key && (
                        <tr><td colSpan={8} className="pb-3 ps-2">
                          {m.anchor && <ul className="text-xs text-faint mb-1">{Object.entries(m.anchor).map(([g, f]) => <li key={g}>{g}: {f.why}</li>)}</ul>}
                          {w.leagues.length ? (
                            <table className="text-xs">
                              <thead><tr className="text-faint"><th className={th}>League</th><th className={th}>Games</th><th className={th}>Mean gap</th><th className={th}>Median |gap|</th><th className={th}>Closer</th></tr></thead>
                              <tbody>{w.leagues.map(l => (
                                <tr key={l.league}><td className="pe-3 text-ink">{l.league}</td><td className="pe-3 num">{l.n}</td><td className="pe-3 num">{sg(l.meanGap)}</td><td className="pe-3 num">{l.medianAbs ?? '—'}</td><td className="pe-3 num">{closer(l.closer)}</td></tr>
                              ))}</tbody>
                            </table>
                          ) : <p className="text-xs text-faint">No settled game with a closing line yet.</p>}
                        </td></tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {s.biggest.length > 0 && (
            <>
              <p className="text-xs font-semibold text-ink mt-2">Biggest gaps, next 24 hours</p>
              <ul className="text-xs space-y-0.5">
                {s.biggest.map(b => (
                  <li key={`${b.market}-${b.id}`} className="flex flex-wrap gap-x-2">
                    <span className="text-ink">{b.label} · game {b.id} ({b.league}, {when(b.kickoff)})</span>
                    <span className="num">ours {b.ours} vs market {b.marketLine} ({sg(b.gap)})</span>
                    {b.why && <span className="text-faint">— {b.why}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ))}
    </section>
  )
}

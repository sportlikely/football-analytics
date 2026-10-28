import { Fragment, useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'

type P3 = [number, number, number]
type Verdict = { cand: string; n: number; dAll: number; d1: number; d2: number; hitBase: number; hitCand: number; boot: { pBetter: number } | null; pass: boolean; why: string }
type League = {
  comp: string; name: string; group: string; n: number; hit: number; logLoss: number; marketN: number; marketLogLoss: number | null; oursOnMarket: number | null
  outcomes: P3; picks: P3; homeBias: number | null; drawGap: number; causes: string[]; own: boolean
  verdicts: Verdict[]; pickRules: Verdict[]; best: string | null; applied: string | null; appliedVia: 'league' | 'group' | null; action: string
  after: { hit: number; logLoss: number }
}
type Totals = { n: number; hit: number; logLoss: number }
type Report = {
  builtAt: string; from: string; mid: string; to: string; note: string
  rules: { minReport: number; minOwn: number; under: number }
  totals: { before: Totals; after: Totals; movedAbove: number; gamesAbove: number; under: number; underGames: number }
  leagues: League[]
  groups: { group: string; name: string; n: number; verdicts: Verdict[]; pickRules: Verdict[]; best: string | null }[]
  table: { comp: string; name: string; n: number; before: { hit: number; logLoss: number }; after: { hit: number; logLoss: number }; applied: string | null; why: string }[]
  rolledBack: { comp: string; name: string; cand: string; why: string }[]
}
type Answer = { job: { running: boolean; startedAt: string | null; queuedAt: string; error: string | null; state: string } | null; result: Report | null; stored: Report | null }

const LABEL: Record<string, string> = {
  home: 'Own home advantage', draw: 'Own draw rate', calib: 'Home advantage + draw rate', close: 'Close games toward base rates',
  anchor: 'Market anchor', 'calib+anchor': 'Home + draw + market anchor', 'pick-draw': 'Draw pick rule', 'pick-dc': 'Double-chance side as the pick'
}
const pct = (a: number, n: number) => (n ? Math.round((100 * a) / n) : 0)
const split = (x: P3) => { const n = x[0] + x[1] + x[2]; return `${pct(x[0], n)} / ${pct(x[1], n)} / ${pct(x[2], n)}` }
const sg = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(4)}`
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function Verdicts({ v }: { v: Verdict[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {v.map(x => (
        <li key={x.cand} className="text-xs flex flex-wrap gap-x-2">
          <span className={x.pass ? 'text-win font-semibold' : 'text-muted'}>{x.pass ? '✓' : '·'} {LABEL[x.cand] || x.cand}</span>
          <span className="num text-faint">{x.cand.startsWith('pick') ? `hits ${x.hitBase}% → ${x.hitCand}%` : `log loss ${sg(x.d1)} / ${sg(x.d2)}`}{x.boot ? ` · ${Math.round(x.boot.pBetter * 100)}%` : ''}</span>
          {!x.pass && <span className="text-faint">— {x.why}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * fix255 (admin only): "Leagues under 52%" — every league with 20+ games in 90 days (hit rate, log loss, market, results
 * vs our picks, home bias, draw gap, causes), the walk-forward test of each candidate per league and per group, the
 * table before → after and what is applied live. Market numbers never reach the public site.
 */
export default function LeagueFixCard() {
  const [d, setD] = useState<Report | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const ask = (run: boolean): Promise<void> =>
    axios.get(`${API_URL}/admin/league-fix${run ? '?run=1' : ''}`).then(r => {
      const a: Answer = r.data.data
      if (a.result || a.stored) setD(a.result || a.stored)
      if (a.job?.running) {
        setMsg(a.job.startedAt ? `Running, started ${new Date(a.job.startedAt).toLocaleTimeString('en-GB')}…` : 'Waiting in the job queue…')
        return new Promise<void>(res => setTimeout(res, 5000)).then(() => ask(false))
      }
      setMsg(a.job?.error ? `Failed: ${a.job.error}` : '')
    })
  const run = () => { setBusy(true); ask(true).catch(() => setMsg('Could not start the test')).finally(() => setBusy(false)) }
  useEffect(() => { ask(false).catch(() => setD(null)) }, [])

  const head = (
    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
      <h2 className="font-display text-lg font-bold text-ink">Leagues under 52%</h2>
      <span className="text-xs text-faint">admin only{d ? ` · ${d.from} → ${d.to} · built ${when(d.builtAt)}` : ''} · <button type="button" onClick={run} disabled={busy} className="text-accent font-semibold">{busy ? 'running…' : 'run now'}</button></span>
    </div>
  )
  if (!d) return <section className="card p-5 sm:p-6 mb-8">{head}<p className="text-sm text-faint">{msg || 'No test yet — it runs every night at 04:40 UTC (and 25 minutes after a restart).'}</p></section>
  const t = d.totals
  const leagues = d.leagues.filter(l => l.n >= d.rules.minReport && (all || l.hit < d.rules.under))
  return (
    <section className="card p-5 sm:p-6 mb-8">
      {head}
      {msg && <p className="text-xs text-muted mb-2">{msg}</p>}
      <p className="text-sm text-muted">
        90 days, {t.before.n} games: hit rate <b className="text-ink num">{t.before.hit}% → {t.after.hit}%</b>, log loss <b className="text-ink num">{t.before.logLoss} → {t.after.logLoss}</b>.
        {' '}{t.under} leagues under {d.rules.under}% ({t.underGames} games); {t.movedAbove} moved above ({t.gamesAbove} games).
      </p>
      <p className="text-xs text-faint mt-1">Each game is predicted only from games settled before its kick-off. A change is applied only when its log loss is better in both halves ({d.from} → {d.mid} → {d.to}) and in 90% of 2,000 resamples; a league with under {d.rules.minOwn} games uses its group's result. {d.note}</p>
      {d.rolledBack.length > 0 && (
        <p className="text-xs text-loss mt-2">Rolled back: {d.rolledBack.map(r => `${r.name} (${LABEL[r.cand] || r.cand}: ${r.why})`).join(' · ')}</p>
      )}

      <div className="overflow-x-auto mt-4">
        <table className="w-full text-sm">
          <thead><tr className="text-faint text-left">
            <th className="pb-1 pr-3 font-normal">League</th><th className="pb-1 pr-3 font-normal">Games</th><th className="pb-1 pr-3 font-normal">Hit rate</th>
            <th className="pb-1 pr-3 font-normal">Log loss (market)</th><th className="pb-1 pr-3 font-normal">Results H/D/A</th><th className="pb-1 pr-3 font-normal">Our picks H/D/A</th>
            <th className="pb-1 pr-3 font-normal">Home bias</th><th className="pb-1 pr-3 font-normal">Draw gap</th><th className="pb-1 pr-3 font-normal">After</th>
          </tr></thead>
          <tbody>
            {leagues.map(l => (
              <Fragment key={l.comp}>
                <tr className="border-t border-line/50 cursor-pointer" onClick={() => setOpen(open === l.comp ? null : l.comp)}>
                  <td className="py-1.5 pr-3 text-ink whitespace-nowrap">{l.name}<span className="block text-xs text-faint">{l.causes.join(', ') || '—'}</span></td>
                  <td className="py-1.5 pr-3 num">{l.n}</td>
                  <td className={`py-1.5 pr-3 num font-semibold ${l.hit < 50 ? 'text-loss' : 'text-ink'}`}>{l.hit}%</td>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{l.logLoss}{l.marketLogLoss != null && <span className="text-faint"> ({l.marketLogLoss} vs {l.oursOnMarket}, {l.marketN})</span>}</td>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{split(l.outcomes)}</td>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{split(l.picks)}</td>
                  <td className="py-1.5 pr-3 num">{l.homeBias ?? '—'}</td>
                  <td className="py-1.5 pr-3 num">{Math.round(l.drawGap * 100)} pts</td>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{l.applied ? <span className="text-win font-semibold">{l.after.hit}% · {l.after.logLoss}</span> : <span className="text-faint">no change</span>}</td>
                </tr>
                {open === l.comp && (
                  <tr><td colSpan={9} className="pb-3 pl-2">
                    <p className="text-xs text-ink">{l.action}{l.applied ? ` — ${LABEL[l.applied]} (${l.appliedVia === 'group' ? 'group setting' : 'own setting'})` : ''}</p>
                    {l.own ? <Verdicts v={[...l.verdicts, ...l.pickRules]} /> : <p className="text-xs text-faint">Under {d.rules.minOwn} games: tested with its group.</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setAll(!all)} className="text-xs text-accent font-semibold mt-2">{all ? `Only leagues under ${d.rules.under}%` : `Every league with ${d.rules.minReport}+ games`}</button>

      <h3 className="font-semibold text-ink mt-5 text-sm">By group</h3>
      {d.groups.map(g => (
        <div key={g.group} className="mt-2">
          <p className="text-sm text-ink">{g.name} <span className="text-faint num">· {g.n} games · {g.best ? `passed: ${LABEL[g.best]}` : 'nothing passed'}</span></p>
          <Verdicts v={[...g.verdicts, ...g.pickRules]} />
        </div>
      ))}
    </section>
  )
}

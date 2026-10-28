import { Fragment, useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import CopyForClaude from './admin/CopyForClaude'
import type { ForClaudeReq } from '../lib/forClaude'

type P3 = [number, number, number]
type Block = { from: string; n: number; diff: number; hitBase: number; hitCand: number }
type Verdict = {
  cand: string; variant: 'record' | 'extended'; n: number; dAll: number; blocks: Block[]; hitBase: number; hitCand: number
  drawPicks: number; drawPickHits: number; past: { n: number; diff: number } | null; boot: { pBetter: number } | null; pass: boolean; why: string
}
type Totals = { n: number; hit: number; logLoss: number; drawPicks: number; drawPickHit: number | null; leaguesAbove: number; gamesAbove: number }
type Unit = { key: string; name: string; n: number; nBacktest: number; verdicts: Verdict[]; applied: { cand: string; variant: string } | null; action: string; before: Totals; after: Totals }
type League = {
  comp: string; name: string; group: string; n: number; hit: number; logLoss: number; marketN: number; marketLogLoss: number | null; oursOnMarket: number | null
  outcomes: P3; picks: P3; homeBias: number | null; drawGap: number; causes: string[]; own: Unit | null; applied: string | null; via: 'league' | 'group' | null; after: Totals
}
type Report = {
  builtAt: string; from: string; to: string; blocks: string[]; note: string
  rules: { minReport: number; minLeague: number; under: number }
  totals: { before: Totals; after: Totals; under: number; underGames: number; movedAbove: number; movedAboveGames: number; record: number; backtest: number }
  groups: (Unit & { group: string })[]
  leagues: League[]
  rolledBack: { unit: string; name: string; cand: string; why: string }[]
}
type Answer = { job: { running: boolean; startedAt: string | null; error: string | null } | null; result: Report | null; stored: Report | null }

const LABEL: Record<string, string> = {
  home: 'Home advantage correction', draw: 'Draw toward the group rate', close: 'Close games toward base rates',
  'home+draw': 'Home advantage + draw', all: 'Home + draw + close games'
}
const pct = (a: number, n: number) => (n ? Math.round((100 * a) / n) : 0)
const split = (x: P3) => { const n = x[0] + x[1] + x[2]; return `${pct(x[0], n)} / ${pct(x[1], n)} / ${pct(x[2], n)}` }
const sg = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(4)}`
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const draws = (t: Totals) => `${t.drawPicks}${t.drawPickHit != null ? ` (${t.drawPickHit}% right)` : ''}`
const arrow = (a: string | number, b: string | number, better: boolean | null) => (
  <span className="num whitespace-nowrap">{a} → <b className={better === null ? 'text-ink' : better ? 'text-win' : 'text-loss'}>{b}</b></span>
)

function Verdicts({ v }: { v: Verdict[] }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {v.map(x => (
        <li key={`${x.cand}-${x.variant}`} className="text-xs flex flex-wrap gap-x-2">
          <span className={x.pass ? 'text-win font-semibold' : 'text-muted'}>{x.pass ? '✓' : '·'} {LABEL[x.cand] || x.cand}{x.variant === 'extended' ? ' + 2 past seasons' : ''}</span>
          <span className="num text-faint">log loss {x.blocks.map(b => sg(b.diff)).join(' / ')} · hits {x.hitBase}% → {x.hitCand}% · draw picks {x.drawPicks}{x.past ? ` · past season ${sg(x.past.diff)}` : ''}{x.boot ? ` · ${Math.round(x.boot.pBetter * 100)}%` : ''}</span>
          {!x.pass && <span className="text-faint">— {x.why}</span>}
        </li>
      ))}
    </ul>
  )
}

/** fix259: one league for Claude (every number of its row, before → after, and its test verdicts) */
const leagueReq = (l: League): ForClaudeReq => ({
  place: `Admin → Predictions & models → Leagues under 52% → ${l.name}`, scope: 'item',
  checks: [{ id: 'league-fix' }],
  shown: [{
    title: `League ${l.name} (${l.comp}, group ${l.group})`,
    text: [
      `Games ${l.n} · hit rate ${l.hit}% · log loss ${l.logLoss}${l.marketLogLoss != null ? ` · market ${l.marketLogLoss} vs ours ${l.oursOnMarket} on ${l.marketN} games` : ''}`,
      `Results H/D/A ${l.outcomes.join(' / ')} · our picks H/D/A ${l.picks.join(' / ')} · home bias ${l.homeBias ?? '—'} · draw gap ${Math.round(l.drawGap * 100)} pts`,
      `Likely causes: ${l.causes.join(', ') || 'none named'} · applied: ${l.applied ? `${l.applied} (${l.via} setting)` : 'nothing'} · after: hit ${l.after.hit}%, log loss ${l.after.logLoss}`,
      ...(l.own ? [`Own test (${l.own.n} games, ${l.own.nBacktest} past-season games): ${l.own.action}`,
        ...l.own.verdicts.map(v => `Test ${v.cand} (${v.variant}): ${v.n} games, Δ ${v.dAll} (blocks ${v.blocks.map(x => `${x.from} ${x.diff}`).join(', ')}), hit ${v.hitBase}% → ${v.hitCand}%${v.boot ? `, better in ${Math.round(v.boot.pBetter * 100)}% of resamples` : ''} → ${v.pass ? 'passed' : `kept out: ${v.why}`}`)]
        : ['No own test (under the games needed): uses its group.'])
    ].join('\n')
  }]
})

/**
 * fix255 / fix255b (admin only): "Leagues under 52%" — tested per group (pooled) and per league with 150+ games: each
 * 30-day block predicted with settings fitted on the other 60 days (+ the 2 past seasons of the backtest), before → after
 * per group and per league (hit rate, log loss, draw picks), what is applied live. Market numbers stay admin-only.
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
      const rep = a.result || a.stored
      if (rep && rep.groups && rep.totals?.before?.leaguesAbove !== undefined) setD(rep) // fix255's older report shape is skipped
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
  const th = 'pb-1 pr-3 font-normal'
  return (
    <section className="card p-5 sm:p-6 mb-8">
      {head}
      {msg && <p className="text-xs text-muted mb-2">{msg}</p>}
      <p className="text-sm text-muted">
        90 days, {t.before.n} games (+ {t.backtest} past-season games for the fits): hit rate {arrow(`${t.before.hit}%`, `${t.after.hit}%`, t.after.hit === t.before.hit ? null : t.after.hit > t.before.hit)},
        {' '}log loss {arrow(t.before.logLoss, t.after.logLoss, t.after.logLoss === t.before.logLoss ? null : t.after.logLoss < t.before.logLoss)},
        {' '}draw picks {arrow(draws(t.before), draws(t.after), null)}, leagues at 52%+ {arrow(`${t.before.leaguesAbove} (${t.before.gamesAbove} games)`, `${t.after.leaguesAbove} (${t.after.gamesAbove} games)`, null)}.
        {' '}{t.under} leagues under {d.rules.under}% ({t.underGames} games), {t.movedAbove} moved above ({t.movedAboveGames} games).
      </p>
      <p className="text-xs text-faint mt-1">Blocks {d.blocks.join(' · ')}. {d.note} A change is used only when its log loss is better on the first and the last 30 days and in 90% of 2,000 resamples. A group's change applies to every league in it; a league with {d.rules.minLeague}+ games can have its own.</p>
      {d.rolledBack.length > 0 && <p className="text-xs text-loss mt-2">Rolled back: {d.rolledBack.map(r => `${r.name} (${LABEL[r.cand] || r.cand}: ${r.why})`).join(' · ')}</p>}

      <h3 className="font-semibold text-ink mt-4 text-sm">By group</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-faint text-left"><th className={th}>Group</th><th className={th}>Games</th><th className={th}>Hit rate</th><th className={th}>Log loss</th><th className={th}>Draw picks</th><th className={th}>Leagues 52%+</th><th className={th}>Used</th></tr></thead>
          <tbody>
            {d.groups.map(g => (
              <Fragment key={g.key}>
                <tr className="border-t border-line/50 cursor-pointer" onClick={() => setOpen(open === g.key ? null : g.key)}>
                  <td className="py-1.5 pr-3 text-ink whitespace-nowrap">{g.name}</td>
                  <td className="py-1.5 pr-3 num">{g.n}<span className="text-faint"> +{g.nBacktest}</span></td>
                  <td className="py-1.5 pr-3">{arrow(`${g.before.hit}%`, `${g.after.hit}%`, g.applied ? g.after.hit >= g.before.hit : null)}</td>
                  <td className="py-1.5 pr-3">{arrow(g.before.logLoss, g.after.logLoss, g.applied ? g.after.logLoss <= g.before.logLoss : null)}</td>
                  <td className="py-1.5 pr-3">{arrow(draws(g.before), draws(g.after), null)}</td>
                  <td className="py-1.5 pr-3">{arrow(g.before.leaguesAbove, g.after.leaguesAbove, null)}</td>
                  <td className="py-1.5 pr-3 text-xs">{g.applied ? <span className="text-win font-semibold">{LABEL[g.applied.cand]}{g.applied.variant === 'extended' ? ' + past seasons' : ''}</span> : <span className="text-faint">no change</span>}</td>
                </tr>
                {open === g.key && <tr><td colSpan={7} className="pb-3 pl-2"><p className="text-xs text-ink">{g.action}</p><Verdicts v={g.verdicts} /></td></tr>}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="font-semibold text-ink mt-5 text-sm">By league</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-faint text-left">
            <th className={th}>League</th><th className={th}>Games</th><th className={th}>Hit rate</th><th className={th}>Log loss (market)</th><th className={th}>Draw picks</th>
            <th className={th}>Results H/D/A</th><th className={th}>Our picks H/D/A</th><th className={th}>Home bias</th><th className={th}>Draw gap</th><th className={th}>Used</th>
          </tr></thead>
          <tbody>
            {leagues.map(l => (
              <Fragment key={l.comp}>
                <tr className="border-t border-line/50 cursor-pointer" onClick={() => setOpen(open === l.comp ? null : l.comp)}>
                  <td className="py-1.5 pr-3 text-ink whitespace-nowrap">{l.name}<span className="block text-xs text-faint">{l.causes.join(', ') || '—'}</span>
                    {/* fix259: a league under 50% */}
                    {l.hit < 50 && <span className="block mt-1" onClick={e => e.stopPropagation()}><CopyForClaude size="sm" req={() => leagueReq(l)} /></span>}
                  </td>
                  <td className="py-1.5 pr-3 num">{l.n}</td>
                  <td className={`py-1.5 pr-3 ${l.hit < 50 ? 'text-loss' : ''}`}>{arrow(`${l.hit}%`, `${l.after.hit}%`, l.applied ? l.after.hit >= l.hit : null)}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{arrow(l.logLoss, l.after.logLoss, l.applied ? l.after.logLoss <= l.logLoss : null)}{l.marketLogLoss != null && <span className="text-faint"> ({l.marketLogLoss} vs {l.oursOnMarket}, {l.marketN})</span>}</td>
                  <td className="py-1.5 pr-3">{arrow(l.picks[1], l.after.drawPicks, null)}</td>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{split(l.outcomes)}</td>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{split(l.picks)}</td>
                  <td className="py-1.5 pr-3 num">{l.homeBias ?? '—'}</td>
                  <td className="py-1.5 pr-3 num">{Math.round(l.drawGap * 100)} pts</td>
                  <td className="py-1.5 pr-3 text-xs">{l.applied ? <span className="text-win">{l.via === 'group' ? 'group: ' : 'own: '}{l.applied}</span> : <span className="text-faint">no change</span>}</td>
                </tr>
                {open === l.comp && (
                  <tr><td colSpan={10} className="pb-3 pl-2">
                    {l.own ? <><p className="text-xs text-ink">Own test: {l.own.action}</p><Verdicts v={l.own.verdicts} /></> : <p className="text-xs text-faint">Under {d.rules.minLeague} games: uses its group's result.</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setAll(!all)} className="text-xs text-accent font-semibold mt-2">{all ? `Only leagues under ${d.rules.under}%` : `Every league with ${d.rules.minReport}+ games`}</button>
    </section>
  )
}

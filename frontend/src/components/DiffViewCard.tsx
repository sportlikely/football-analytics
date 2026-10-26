import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { matchHref } from '../lib/links'
import type { LinkSport } from '../lib/slugRules'

type Summary = { games: number; hit: number | null; ours: number | null; market: number | null; units: number; roi: number | null; roiLo: number | null; roiHi: number | null }
type Group = Summary & { sport: string; period: 'past' | 'live'; league: string; band: string }
type Game = {
  sport: string; gameId: number; league: string; date?: string; kickoff?: string; home: string; away: string; side: string; sideName: string
  ours: number; market: number; gap: number; price: number; outcome?: string | null; won?: boolean | null
}
type Report = {
  builtAt: string; method: string; bands: string[]; flagGap: number; minGroup: number
  sports: { sport: string; prices: boolean; note: string; liveSince: string | null; games: number }[]
  seasons: string[]; groups: Group[]; best: Group[]; worst: Group[]; upcoming: Game[]
  flagged: { total: number; settled: number; all: Summary; football: Summary; tennis: Summary; recent: Game[] }
}

const SPORT_NAME: Record<string, string> = { football: 'Football', basketball: 'Basketball', 'american-football': 'American football', tennis: 'Tennis' }
const pc = (x: number) => `${Math.round(x * 1000) / 10}%`
const roi = (s: Summary) => (s.roi === null ? '—' : `${s.roi > 0 ? '+' : ''}${s.roi}%`)
const ci = (s: Summary) => (s.roiLo === null || s.roiHi === null ? '' : `${s.roiLo} to ${s.roiHi}`)
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '')
const roiTone = (s: Summary) => (s.roiLo !== null && s.roiLo > 0 ? 'text-win' : s.roiHi !== null && s.roiHi < 0 ? 'text-loss' : 'text-ink')

function GameName({ g }: { g: Game }) {
  const href = matchHref(g.sport as LinkSport, g.gameId, { home: g.home, away: g.away, date: g.kickoff || g.date })
  const name = `${g.home} – ${g.away}`
  return href ? <Link to={href} className="font-semibold text-ink hover:underline">{name}</Link> : <span className="font-semibold text-ink">{name}</span>
}

/**
 * fix246 (admin only): "Our different view" test — when our model and the market disagree, does our side happen more
 * often than the market said, and what would 1 unit on it have returned. Never shown to visitors.
 */
export default function DiffViewCard() {
  const [d, setD] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [sport, setSport] = useState('football')
  const [period, setPeriod] = useState<'past' | 'live'>('past')
  const load = (fresh = false) => {
    setBusy(true)
    axios.get(`${API_URL}/admin/diff-view${fresh ? '?fresh=1' : ''}`).then(r => setD(r.data.data)).catch(() => setD(null)).finally(() => setBusy(false))
  }
  useEffect(() => { load() }, [])
  if (!d) return busy ? <section className="card p-5 sm:p-6 mb-8 text-sm text-faint">Loading the different view test…</section> : null
  const rows = d.groups.filter(g => g.sport === sport && g.period === period)
  const totals = rows.filter(g => g.league === 'All leagues')
  const leagues = [...new Set(rows.filter(g => g.league !== 'All leagues').map(g => g.league))]
  const info = d.sports.find(s => s.sport === sport)
  const head = (
    <thead><tr className="text-faint text-left">
      <th className="pb-1 pr-3 font-normal">Gap</th><th className="pb-1 pr-3 font-normal">Games</th><th className="pb-1 pr-3 font-normal">Our side happened</th>
      <th className="pb-1 pr-3 font-normal">Market said</th><th className="pb-1 pr-3 font-normal">We said</th><th className="pb-1 pr-3 font-normal">Return (95%)</th>
    </tr></thead>
  )
  const line = (g: Group, label: string) => (
    <tr key={`${g.league}-${g.band}`} className="border-t border-line/50">
      <td className="py-1.5 pr-3 text-muted whitespace-nowrap">{label}</td>
      <td className="py-1.5 pr-3 num">{g.games}</td>
      <td className="py-1.5 pr-3 num font-semibold text-ink">{g.hit ?? '—'}%</td>
      <td className="py-1.5 pr-3 num">{g.market ?? '—'}%</td>
      <td className="py-1.5 pr-3 num">{g.ours ?? '—'}%</td>
      <td className={`py-1.5 pr-3 num font-semibold whitespace-nowrap ${roiTone(g)}`}>{roi(g)} <span className="font-normal text-faint">{ci(g)}</span></td>
    </tr>
  )
  const groupLine = (g: Group) => (
    <li key={`${g.sport}-${g.period}-${g.league}-${g.band}`} className="py-1 flex flex-wrap gap-x-2">
      <span className="text-ink">{SPORT_NAME[g.sport] || g.sport} · {g.league} · {g.band} pts · {g.period === 'past' ? 'past seasons' : 'live'}</span>
      <span className="num text-muted">{g.games} games · {g.hit}% vs market {g.market}% · <b className={roiTone(g)}>{roi(g)}</b> <span className="text-faint">({ci(g)})</span></span>
    </li>
  )
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-lg font-bold text-ink">Different view test</h2>
        <span className="text-xs text-faint">admin only · built {when(d.builtAt)} · <button type="button" onClick={() => load(true)} disabled={busy} className="text-accent font-semibold">{busy ? 'building…' : 'rebuild'}</button></span>
      </div>
      <p className="text-sm text-muted">Games where our model and the market disagree by 3+ points: how often our side happened against what the market said, and 1 unit on our side at the market price.</p>
      <p className="text-xs text-faint mt-1">{d.method}</p>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        {d.sports.map(s => (
          <button key={s.sport} type="button" onClick={() => setSport(s.sport)} className={`px-3 py-1.5 rounded-full border ${sport === s.sport ? 'border-accent text-ink font-semibold' : 'border-line text-muted'}`}>
            {SPORT_NAME[s.sport] || s.sport}{s.prices ? ` · ${s.games}` : ' · n/a'}
          </button>
        ))}
        <span className="mx-1" />
        {(['past', 'live'] as const).map(p => (
          <button key={p} type="button" onClick={() => setPeriod(p)} className={`px-3 py-1.5 rounded-full border ${period === p ? 'border-accent text-ink font-semibold' : 'border-line text-muted'}`}>
            {p === 'past' ? 'Past seasons (backtest)' : 'Live since prices were stored'}
          </button>
        ))}
      </div>
      {info && <p className="text-xs text-faint mt-2">{info.note}{period === 'live' && info.liveSince ? ` · first live game ${new Date(info.liveSince).toLocaleDateString('en-GB')}` : ''}{period === 'past' && d.seasons.some(s => s.startsWith(sport)) ? ` · seasons ${d.seasons.filter(s => s.startsWith(sport + ' ')).map(s => s.slice(sport.length + 1)).join(', ')}` : ''}</p>}

      {!info?.prices ? (
        <p className="mt-3 text-sm text-faint">No market prices are stored for this sport, so there is nothing to compare yet.</p>
      ) : totals.length === 0 ? (
        <p className="mt-3 text-sm text-faint">No finished games with a 3+ point gap and a stored price yet.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">{head}<tbody>{d.bands.map(b => totals.find(g => g.band === b)).filter((g): g is Group => !!g).map(g => line(g, `${g.band} pts`))}{totals.filter(g => g.band === 'all').map(g => line(g, 'All 3+'))}</tbody></table>
          </div>
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted">Per league ({leagues.length})</summary>
            <div className="mt-2 overflow-x-auto">
              {leagues.map(l => (
                <div key={l} className="mb-3">
                  <p className="font-semibold text-ink">{l}</p>
                  <table className="w-full text-xs">{head}<tbody>{rows.filter(g => g.league === l).map(g => line(g, g.band === 'all' ? 'All 3+' : `${g.band} pts`))}</tbody></table>
                </div>
              ))}
            </div>
          </details>
        </>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2 text-xs">
        <div>
          <h3 className="font-semibold text-ink mb-1">Best groups ({d.minGroup}+ games, by the low end of the interval)</h3>
          <ul className="divide-y divide-line/50">{d.best.length ? d.best.map(groupLine) : <li className="py-1 text-faint">Not enough games yet.</li>}</ul>
        </div>
        <div>
          <h3 className="font-semibold text-ink mb-1">Worst groups</h3>
          <ul className="divide-y divide-line/50">{d.worst.length ? d.worst.map(groupLine) : <li className="py-1 text-faint">Not enough games yet.</li>}</ul>
        </div>
      </div>

      <h3 className="mt-5 font-semibold text-ink text-sm">Upcoming games with a {d.flagGap}+ point gap ({d.upcoming.length})</h3>
      <p className="text-xs text-faint">Written into the live record at kick-off from the numbers frozen then; a stored row can't be changed afterwards.</p>
      <ul className="mt-1 divide-y divide-line/50 text-xs">
        {d.upcoming.length === 0 && <li className="py-2 text-faint">None right now (football prices arrive in the last 48 h, tennis ~1 h before the start).</li>}
        {d.upcoming.map(g => (
          <li key={`${g.sport}-${g.gameId}`} className="py-1.5 flex flex-wrap items-baseline gap-x-3">
            <span className="w-24 text-faint num">{when(g.date)}</span>
            <span className="text-faint">{SPORT_NAME[g.sport]} · {g.league}</span>
            <GameName g={g} />
            <span className="num text-muted">our side <b className="text-ink">{g.sideName}</b> {pc(g.ours)} vs market {pc(g.market)} · <b className="text-ink">+{g.gap}</b> pts · price {g.price.toFixed(2)}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-5 font-semibold text-ink text-sm">Live record (frozen at kick-off)</h3>
      <p className="text-xs text-muted num">
        {d.flagged.total} games flagged · {d.flagged.settled} settled
        {d.flagged.all.games > 0 && <> · our side happened {d.flagged.all.hit}% vs market {d.flagged.all.market}% · return <b className={roiTone(d.flagged.all)}>{roi(d.flagged.all)}</b> <span className="text-faint">({ci(d.flagged.all)})</span> · {d.flagged.all.units > 0 ? '+' : ''}{d.flagged.all.units} units</>}
      </p>
      <ul className="mt-1 divide-y divide-line/50 text-xs">
        {d.flagged.recent.map(g => (
          <li key={`${g.sport}-${g.gameId}`} className="py-1.5 flex flex-wrap items-baseline gap-x-3">
            <span className="w-24 text-faint num">{when(g.kickoff)}</span>
            <GameName g={g} />
            <span className="num text-muted">{g.sideName} {pc(g.ours)} vs {pc(g.market)} · +{g.gap} pts · {g.price.toFixed(2)}</span>
            <span className={`font-semibold ${g.won === true ? 'text-win' : g.won === false ? 'text-loss' : 'text-faint'}`}>{g.won === true ? 'happened' : g.won === false ? 'did not happen' : g.outcome === 'VOID' ? 'void' : 'waiting'}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { errorText } from '../lib/auth'

/*
 * Admin → Football leagues (Oct 2026): every league API-Football has, by how much data it gives, and the leagues we
 * added from here. Adding a league pulls its fixtures, 3 seasons of history, lineups, injuries, match and player
 * stats; it starts "in testing" — an admin label only (fix203: every league counts in the public record).
 */
type Tier = 'full' | 'good' | 'basic'
interface ScanLeague {
  id: number; name: string; country: string; flag: string | null; logo: string | null
  season: number; start: string; end: string; calendar: boolean; active: boolean
  tier: Tier; injuries: boolean; history: number
  status: 'predicted' | 'added' | 'shown' | 'new'; recommended: boolean
}
interface ExtraRow { id: number; name: string; country: string; trial: boolean; enabled: boolean; live: boolean; addedAt: string }
interface Coverage {
  at: string
  totals: { leagues: number; full: number; fullActive: number; good: number; basic: number; predicted: number; added: number; recommended: number; recommendedWithInjuries: number }
  leagues: ScanLeague[]
  extra: ExtraRow[]
}

const TIER_STYLE: Record<Tier, string> = {
  full: 'bg-accent/15 text-accent',
  good: 'bg-draw/15 text-draw',
  basic: 'bg-line/40 text-faint'
}
const STATUS_TEXT: Record<ScanLeague['status'], string> = { predicted: 'Predicted', added: 'Added', shown: 'On site, no model', new: '' }

export default function LeaguesCard({ sport = 'football' }: { sport?: 'football' | 'basketball' }) {
  const bb = sport === 'basketball'
  const ep = (x: string) => `${API_URL}/admin/${bb ? 'bb-' : ''}${x}`
  const [d, setD] = useState<Coverage | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'recommended' | 'full' | 'good' | 'all'>('recommended')
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const load = (refresh = false) => {
    setBusy(true); setErr(null)
    return axios.get(`${ep('league-coverage')}${refresh ? '?refresh=1' : ''}`)
      .then(r => setD(r.data.data))
      .catch(e => setErr(errorText(e)))
      .finally(() => setBusy(false))
  }
  useEffect(() => { if (open && !d) load() }, [open])

  const list = useMemo(() => {
    if (!d) return []
    const s = q.trim().toLowerCase()
    return d.leagues.filter(l => {
      if (s && !`${l.country} ${l.name}`.toLowerCase().includes(s)) return false
      if (view === 'recommended') return l.recommended
      if (view === 'full') return l.tier === 'full'
      if (view === 'good') return l.tier === 'good'
      return true
    })
  }, [d, view, q])

  const addable = (l: ScanLeague) => (l.status === 'new' || l.status === 'shown') && l.tier !== 'basic' && l.history >= 1
  const toggle = (id: number) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const pickAllShown = () => setPicked(new Set(list.filter(addable).map(l => l.id)))

  const add = () => {
    setBusy(true); setMsg(null)
    axios.post(ep('extra-leagues'), { ids: [...picked] })
      .then(r => {
        const x = r.data.data
        setMsg(`Added ${x.added.length} league${x.added.length === 1 ? '' : 's'}${x.skipped.length ? ` · skipped ${x.skipped.length}` : ''}. ${x.note}`)
        setPicked(new Set()); setConfirming(false)
        return load()
      })
      .catch(e => setMsg(errorText(e)))
      .finally(() => setBusy(false))
  }
  const setTrial = (id: number, trial: boolean) => axios.post(ep(`extra-leagues/${id}/trial`), { trial }).then(() => load()).catch(e => setMsg(errorText(e)))
  const remove = (id: number) => axios.post(ep(`extra-leagues/${id}/remove`), {}).then(r => { setMsg(r.data.data.note); return load() }).catch(e => setMsg(errorText(e)))

  const tile = (label: string, value: number | undefined, hint?: string) => (
    <div className="rounded-xl border border-line/60 bg-surface2/40 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="num text-xl font-bold text-ink">{value ?? '–'}</div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  )

  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-bold text-ink">{bb ? 'Basketball leagues' : 'Football leagues'}</h2>
        <button type="button" onClick={() => setOpen(o => !o)} className="text-xs font-semibold text-accent">
          {open ? 'Hide' : 'Open coverage & add leagues →'}
        </button>
      </div>
      {!open ? (
        <p className="mt-1 text-xs text-faint">Every {bb ? 'basketball' : 'football'} league our data plan has, by how much information it gives, and the leagues added from here.</p>
      ) : (
        <div className="mt-4">
          {err && <p className="text-sm text-loss mb-3">{err}</p>}
          {!d ? <p className="text-sm text-faint">{busy ? 'Scanning API-Football (one request)…' : ''}</p> : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {tile('Full information', d.totals.fullActive, bb ? 'playing now · team + player box scores' : 'playing now · lineups, stats, players')}
                {tile('Ready to add', d.totals.recommended, bb ? 'full + 2 past seasons' : `full + 2 past seasons · ${d.totals.recommendedWithInjuries} with injuries`)}
                {tile('Predicted now', d.totals.predicted + d.totals.added, d.totals.added ? `${d.totals.added} added from here` : undefined)}
                {tile('All senior leagues', d.totals.leagues, `${d.totals.good} good · ${d.totals.basic} scores only`)}
              </div>

              {d.extra.length > 0 && (
                <div className="mb-5">
                  <h3 className="text-sm font-semibold text-ink mb-2">Added from here</h3>
                  <ul className="divide-y divide-line/50 text-sm rounded-xl border border-line/60">
                    {d.extra.map(x => (
                      <li key={x.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 ${x.enabled ? '' : 'opacity-50'}`}>
                        <span className="text-faint w-28 truncate">{x.country}</span>
                        <span className="font-semibold text-ink">{x.name}</span>
                        <span className="text-[11px] text-faint num">{bb ? 'BB' : 'AF'}{x.id}</span>
                        {!x.enabled && <span className="text-[11px] text-loss">removed{x.live ? ' · leaves after the next deploy' : ''}</span>}
                        {x.enabled && (
                          <span className="ms-auto flex items-center gap-3">
                            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                              <input type="checkbox" checked={x.trial} onChange={e => setTrial(x.id, e.target.checked)} />
                              In testing
                            </label>
                            <button type="button" onClick={() => remove(x.id)} className="text-xs text-loss hover:underline">Remove</button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[11px] text-faint">"In testing" = an admin label only. Every league counts in the public record and every public number.</p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mb-3">
                <nav className="flex gap-1 rounded-full border border-line/60 bg-surface p-1">
                  {([['recommended', `Ready to add · ${d.totals.recommended}`], ['full', `Full · ${d.totals.full}`], ['good', `Good · ${d.totals.good}`], ['all', 'All']] as const).map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setView(k)}
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${view === k ? 'bg-accent text-bg' : 'text-muted hover:text-ink'}`}>{label}</button>
                  ))}
                </nav>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Country or league"
                  className="flex-1 min-w-[10rem] rounded-full border border-line/60 bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-faint" />
                <button type="button" onClick={() => load(true)} disabled={busy} className="text-xs text-muted hover:text-ink underline disabled:opacity-50">Scan again</button>
              </div>

              <div className="flex flex-wrap items-center gap-3 mb-2 text-xs">
                <button type="button" onClick={pickAllShown} className="font-semibold text-accent hover:underline">Select all in this list</button>
                {picked.size > 0 && <button type="button" onClick={() => setPicked(new Set())} className="text-muted hover:underline">Clear ({picked.size})</button>}
                <span className="text-faint">{list.length} leagues · scanned {new Date(d.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>

              <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-line/60">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-surface text-[11px] uppercase tracking-wide text-faint">
                    <tr>
                      <th className="w-8 px-2 py-2" />
                      <th className="text-start px-2 py-2">Country</th>
                      <th className="text-start px-2 py-2">League</th>
                      <th className="px-2 py-2">Data</th>
                      {!bb && <th className="px-2 py-2">Injuries</th>}
                      <th className="px-2 py-2">Past seasons</th>
                      <th className="px-2 py-2">Season</th>
                      <th className="text-start px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/40">
                    {list.map(l => (
                      <tr key={l.id} className={addable(l) ? 'cursor-pointer hover:bg-surface2/40' : 'opacity-70'} onClick={() => addable(l) && toggle(l.id)}>
                        <td className="px-2 py-1.5 text-center">
                          {addable(l) && <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} onClick={e => e.stopPropagation()} aria-label={`Add ${l.name}`} />}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {l.flag && <img src={l.flag} alt="" className="inline-block w-4 h-3 me-1.5 align-[-1px] object-cover rounded-[2px]" loading="lazy" />}
                          <span className="text-muted">{l.country}</span>
                        </td>
                        <td className="px-2 py-1.5 text-ink">{l.name}</td>
                        <td className="px-2 py-1.5 text-center"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TIER_STYLE[l.tier]}`}>{l.tier}</span></td>
                        {!bb && <td className="px-2 py-1.5 text-center text-xs">{l.injuries ? '✓' : <span className="text-faint">–</span>}</td>}
                        <td className="px-2 py-1.5 text-center num text-xs">{l.history}</td>
                        <td className="px-2 py-1.5 text-center text-[11px] text-faint whitespace-nowrap">{l.active ? `${l.start.slice(0, 7)} → ${l.end.slice(0, 7)}` : 'not playing'}</td>
                        <td className="px-2 py-1.5 text-[11px] text-faint whitespace-nowrap">{STATUS_TEXT[l.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                {!confirming ? (
                  <button type="button" disabled={!picked.size || busy} onClick={() => setConfirming(true)}
                    className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-40">
                    Add {picked.size || ''} league{picked.size === 1 ? '' : 's'}
                  </button>
                ) : (
                  <>
                    <span className="text-sm text-ink">Add {picked.size} league{picked.size === 1 ? '' : 's'} to the site, in testing?</span>
                    <button type="button" disabled={busy} onClick={add} className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-bg disabled:opacity-40">Yes, add</button>
                    <button type="button" onClick={() => setConfirming(false)} className="text-sm text-muted hover:underline">Cancel</button>
                  </>
                )}
                {msg && <span className="text-xs text-muted">{msg}</span>}
              </div>
              <p className="mt-2 text-[11px] text-faint">
                {bb
                  ? 'Each league loads 5 seasons of games and box scores (a few hundred requests once, then a few a day). Predictions start after the next model build.'
                  : 'Each league costs about 50–100 API requests a day (fixtures, live scores, lineups, stats). Adding many at once fills their history over the next hours; predictions start once 3 seasons of results are in.'}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  )
}

import { useEffect, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'

/**
 * fix211: Admin → Player photos (tennis, basketball; Wikidata / Commons). Low-confidence matches wait here to be
 * approved or rejected; any shown photo can be removed (takedown: the file is deleted, the player and the Commons
 * file are blocked for good). Admin pages are English only.
 */
interface PRow { sport: 'tennis' | 'basketball'; id: number; name: string; status: string; wikidata: string | null; reason: string; confidence: string | null; file: string | null; author: string | null; licence: string | null; source: string | null; url: string | null; checkedAt: string }
interface Data {
  run: { at: string | null; done: number; ok: number; review: number; none: number; errors: number; lastError: string | null; running: boolean; calls: number }
  counts: { sport: string; status: string; n: number }[]
  /** fix221: basketball photos shown per league (current squads) */
  coverage?: { code: string; n: number; has: number; pct: number }[]
  review: PRow[]; recent: PRow[]; notMatched: PRow[]; blocked: { key: string; reason: string; at: string }[]
}
const href = (r: PRow) => (r.sport === 'tennis' ? `/tennis/player/${r.id}` : `/basketball/player/${r.id}`)

export default function PlayerPhotosCard() {
  const [d, setD] = useState<Data | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [tab, setTab] = useState<'review' | 'recent' | 'notMatched' | 'blocked'>('review')
  const load = () => axios.get(`${API_URL}/admin/player-photos`).then(r => setD(r.data.data)).catch(() => undefined)
  useEffect(() => { load() }, [])
  if (!d) return null
  const act = (r: PRow, action: 'approve' | 'reject' | 'remove') => {
    const reason = action === 'remove' ? window.prompt(`Remove the photo of ${r.name} for good? Reason (e.g. takedown request):`, 'takedown request') : ''
    if (reason === null) return
    setBusy(`${r.sport}${r.id}`)
    axios.post(`${API_URL}/admin/player-photos/${r.sport}/${r.id}/${action}`, { reason }).then(load).finally(() => setBusy(null))
  }
  const unblock = (key: string) => axios.post(`${API_URL}/admin/player-photos/unblock`, { key }).then(load)
  const count = (sport: string, status: string) => d.counts.find(c => c.sport === sport && c.status === status)?.n || 0
  const rows = tab === 'blocked' ? [] : d[tab]
  const chip = (k: typeof tab, label: string, n: number) => (
    <button key={k} type="button" onClick={() => setTab(k)} className={`h-8 px-3 rounded-full text-xs font-semibold border ${tab === k ? 'bg-accent text-bg border-accent' : 'border-line/70 text-muted hover:text-ink'}`}>{label} {n}</button>
  )
  return (
    <section className="card p-5 sm:p-6 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="font-display text-lg font-bold text-ink">Player photos: <span className={d.review.length ? 'text-draw' : 'text-win'}>{d.review.length} to review</span></h2>
        <span className="text-xs text-faint">
          tennis {count('tennis', 'ok')} shown · basketball {count('basketball', 'ok')} shown · last run {d.run.at ? new Date(d.run.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'not yet'} · {d.run.calls} Wikimedia calls since start{d.run.errors ? ` · ${d.run.errors} errors` : ''}
          <button type="button" disabled={d.run.running} onClick={() => axios.post(`${API_URL}/admin/player-photos/run`, {}).then(() => setTimeout(load, 5000))} className="ml-3 font-semibold text-accent hover:underline disabled:opacity-50">Run now</button>
        </span>
      </div>
      {!!d.coverage?.length && (
        <p className="text-xs text-muted mb-2">
          Basketball shown: {d.coverage.map((l, i) => (
            <span key={l.code}>{i ? ' · ' : ''}<span className={(l.code === 'NBA' && l.pct < 85) || (l.code === 'EL' && l.pct < 60) ? 'text-draw font-semibold' : l.code === 'NBA' || l.code === 'EL' ? 'text-win font-semibold' : ''}>{l.code} {l.pct}%</span> ({l.has}/{l.n})</span>
          ))} · targets NBA 85%, EuroLeague 60%
        </p>
      )}
      {d.run.lastError && <p className="text-xs text-loss mb-2 break-all">Last error: {d.run.lastError}</p>}
      <div className="flex flex-wrap gap-2 mb-3">
        {chip('review', 'To review', d.review.length)}{chip('recent', 'Shown (latest)', d.recent.length)}{chip('notMatched', 'Not matched', d.notMatched.length)}{chip('blocked', 'Blocked', d.blocked.length)}
      </div>
      {tab === 'blocked' ? (
        d.blocked.length === 0 ? <p className="text-sm text-faint">Nothing blocked.</p> : (
          <ul className="divide-y divide-line/50 text-sm max-h-96 overflow-y-auto">
            {d.blocked.map(b => (
              <li key={b.key} className="py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-semibold text-ink break-all">{b.key}</span>
                <span className="text-xs text-faint">{b.reason} · {b.at.slice(0, 10)}</span>
                <button type="button" onClick={() => unblock(b.key)} className="ml-auto text-xs font-semibold text-accent hover:underline">Unblock</button>
              </li>
            ))}
          </ul>
        )
      ) : rows.length === 0 ? <p className="text-sm text-faint">{tab === 'review' ? 'Nothing waiting. Low-confidence matches (name + country only, or age only) show up here.' : 'None yet.'}</p> : (
        <ul className="divide-y divide-line/50 text-sm max-h-[32rem] overflow-y-auto">
          {rows.map(r => (
            <li key={`${r.sport}${r.id}`} className="py-2.5 flex items-start gap-3">
              {r.url ? <img src={r.url} alt={r.name} width={56} height={56} className="w-14 h-14 rounded-xl object-cover bg-surface2 shrink-0" /> : <span className="w-14 h-14 rounded-xl bg-surface2 shrink-0" />}
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <a href={href(r)} target="_blank" rel="noreferrer" className="font-semibold text-ink hover:text-accent">{r.name}</a>
                  <span className="text-xs text-faint">{r.sport} {r.id}{r.confidence ? ` · ${r.confidence}` : ''}</span>
                  {r.wikidata && <a href={`https://www.wikidata.org/wiki/${r.wikidata}`} target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline">{r.wikidata}</a>}
                </div>
                <div className="text-xs text-muted">{r.reason}</div>
                {r.author && <div className="text-xs text-faint break-words">{r.author} · {r.licence}{r.source && <> · <a href={r.source} target="_blank" rel="noreferrer" className="hover:underline">Commons</a></>}</div>}
              </div>
              {tab !== 'notMatched' && (
                <div className="flex flex-col gap-1 shrink-0">
                  {r.status === 'review' && <button type="button" disabled={!!busy} onClick={() => act(r, 'approve')} className="h-7 px-3 rounded-lg text-xs font-semibold bg-win/15 text-win hover:bg-win/25">Approve</button>}
                  {r.status === 'review' && <button type="button" disabled={!!busy} onClick={() => act(r, 'reject')} className="h-7 px-3 rounded-lg text-xs font-semibold bg-loss/15 text-loss hover:bg-loss/25">Wrong person</button>}
                  <button type="button" disabled={!!busy} onClick={() => act(r, 'remove')} className="h-7 px-3 rounded-lg text-xs font-semibold border border-line/70 text-muted hover:text-loss">Remove photo</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

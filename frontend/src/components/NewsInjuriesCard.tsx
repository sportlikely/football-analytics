import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { playerHref } from '../lib/links'

type Item = {
  id: number; playerId: number; name: string; teamId: number; team: string | null; code: string; status: 'out' | 'doubtful'; injury: string | null
  days: number; sentence: string; link: string; source: string | null; published: string; until: string; state: 'active' | 'expired' | 'played' | 'dismissed'; reviewed: boolean
}

/**
 * fix224 (admin): basketball injuries read from news ("reported out", every league but the NBA). Each active item
 * lowers the player's minutes in the model (row #4) until its date or until he plays. Dismiss = a false positive,
 * never applied again; OK = checked.
 */
export default function NewsInjuriesCard() {
  const [list, setList] = useState<Item[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const load = () => axios.get(`${API_URL}/admin/bb/news-injuries`).then(r => setList(r.data.data)).catch(() => setList(null))
  useEffect(() => { load() }, [])
  if (!list) return null
  const act = (id: number, action: 'dismiss' | 'ok') => { setBusy(id); axios.post(`${API_URL}/admin/bb/news-injuries/${id}/${action}`, {}).then(load).finally(() => setBusy(null)) }
  const active = list.filter(x => x.state === 'active'), pending = active.filter(x => !x.reviewed)
  return (
    <section className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="font-display text-base sm:text-lg font-bold text-ink">Basketball injuries from news</h2>
        <span className={`text-xs font-semibold ${pending.length ? 'text-draw' : 'text-win'}`}>{pending.length ? `${pending.length} to review` : 'nothing to review'} · {active.length} active</span>
      </div>
      <p className="text-xs text-muted mb-3">Stories that name a club and say one of its players is out (leagues without an injury report). Active items lower his minutes in the model until the date or until he plays. Dismiss a false positive: it is never applied again.</p>
      {list.length === 0 ? <p className="text-sm text-faint">No items in the last 30 days.</p> : (
        <ul className="divide-y divide-line/50">
          {list.map(x => (
            <li key={x.id} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={playerHref('basketball', x.playerId, x.name)!} className="font-semibold text-ink hover:underline">{x.name}</Link>
                <span className="text-faint">{x.team || x.teamId} · {x.code}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${x.state === 'active' ? 'bg-loss/15 text-loss' : 'bg-surface2 text-muted'}`}>{x.state === 'active' ? `${x.status}${x.injury ? ` (${x.injury})` : ''} until ${x.until.slice(0, 10)}` : x.state}</span>
                {x.reviewed && x.state === 'active' && <span className="text-[10px] text-win font-bold">checked</span>}
                {x.state === 'active' && (
                  <span className="ml-auto flex gap-2">
                    {!x.reviewed && <button disabled={busy === x.id} onClick={() => act(x.id, 'ok')} type="button" className="text-xs font-semibold text-accent hover:underline disabled:opacity-50">OK</button>}
                    <button disabled={busy === x.id} onClick={() => act(x.id, 'dismiss')} type="button" className="text-xs font-semibold text-loss hover:underline disabled:opacity-50">Dismiss</button>
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">“{x.sentence}” — <a href={x.link} target="_blank" rel="noopener noreferrer nofollow" className="underline">{x.source || 'story'}</a>, {x.published.slice(0, 10)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

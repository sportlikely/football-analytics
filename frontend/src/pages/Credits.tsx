import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t } from '../lib/i18n'
import { playerHref } from '../lib/links'

/**
 * fix211: photo credits — every player photo shown on the site (Wikimedia Commons, free licences), with its author,
 * licence and the Commons file. Photos only appear on that player's own information, never as an endorsement.
 */
interface Credit { sport: 'tennis' | 'basketball'; id: number; name: string; author: string; licence: string; licenceUrl: string | null; source: string }

const playerTo = (c: Credit) => playerHref(c.sport, c.id, c.name)!

export default function Credits() {
  const [list, setList] = useState<Credit[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    document.title = t('{0} · SportLikely', { 0: t('Photo credits') })
    axios.get(`${API_URL}/public/photo-credits`).then(r => setList(r.data.data || [])).catch(() => setList([]))
  }, [])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (list || []).filter(c => !s || c.name.toLowerCase().includes(s) || c.author.toLowerCase().includes(s))
  }, [list, q])
  const groups: [Credit['sport'], string][] = [['tennis', t('Tennis')], ['basketball', t('Basketball')]]
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-ink">{t('Photo credits')}</h1>
        <p className="text-sm text-muted">{t('Player photos come from Wikimedia Commons under free licences (CC0, public domain, CC BY, CC BY-SA). Each one is shown only on that player\'s own information and does not mean the player supports SportLikely.')}</p>
        <p className="text-sm text-muted">{t('Is one of these photos yours, or of you, and you want it removed?')} <Link to="/contact" className="text-accent hover:underline">{t('Contact us')}</Link> {t('and we will take it down the same day.')}</p>
      </header>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search a player or author')} aria-label={t('Search a player or author')}
        className="w-full h-11 px-4 rounded-xl bg-surface2 border border-line/70 text-sm text-ink placeholder:text-faint focus:outline-none focus:border-accent/60" />
      {list === null ? <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-10 rounded-lg bg-surface2/60 animate-pulse" />)}</div>
        : !list.length ? <p className="text-sm text-faint">{t('No player photos yet.')}</p>
        : groups.map(([sport, label]) => {
          const rows = shown.filter(c => c.sport === sport)
          if (!rows.length) return null
          return (
            <section key={sport} className="card p-4 sm:p-5 space-y-3">
              <h2 className="font-display text-lg font-bold text-ink">{label} <span className="num text-xs font-normal text-faint">{rows.length}</span></h2>
              <ul className="divide-y divide-line/60 text-sm">
                {rows.map(c => (
                  <li key={`${c.sport}${c.id}`} className="py-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Link to={playerTo(c)} className="font-semibold text-ink hover:text-accent">{c.name}</Link>
                    <span className="text-muted min-w-0 [overflow-wrap:anywhere]">
                      {t('Photo: {0}', { 0: c.author })} · {c.licenceUrl ? <a href={c.licenceUrl} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-ink underline decoration-dotted">{c.licence}</a> : c.licence} · <a href={c.source} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-ink underline decoration-dotted">{t('Wikimedia Commons')}</a>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
    </div>
  )
}

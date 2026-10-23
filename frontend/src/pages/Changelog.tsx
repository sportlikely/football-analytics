import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t, lang, LOCALE } from '../lib/i18n'
import { HOW_PATH, filterEntries, type HowSport, type ChangelogEntry } from '../lib/howItWorks'

/**
 * fix206: the changelog — docs/changelog.json through /api/changelog (newest first, every entry in the seven
 * languages; a sport before its launch only for admins), with a sport filter. Model entries carry the model name and
 * version ("SL Basketball 3.0").
 */

const SPORT_LABEL: Record<HowSport, string> = { football: 'Football', basketball: 'Basketball', 'american-football': 'American football', tennis: 'Tennis' }
const MODEL_NAME: Record<HowSport, string> = { football: 'SL Football', basketball: 'SL Basketball', 'american-football': 'SL American Football', tennis: 'SL Tennis' }
const HOW_TITLE: Record<HowSport, string> = {
  football: 'How our football predictions work', basketball: 'How our basketball predictions work',
  'american-football': 'How our American football predictions work', tennis: 'How our tennis predictions work'
}
type Filter = 'all' | HowSport


export default function Changelog() {
  const [list, setList] = useState<ChangelogEntry[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  useEffect(() => {
    document.title = t('{0} · SportLikely', { 0: t('Changelog') })
    axios.get(`${API_URL}/changelog`).then(r => setList(r.data.data || [])).catch(() => setList([]))
  }, [])
  const sports = useMemo(() => (Object.keys(SPORT_LABEL) as HowSport[]).filter(s => list?.some(e => e.sport === s)), [list])
  const shown = list ? filterEntries(list, filter) : []

  if (!list) return <div className="min-h-[50vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={t('Loading…')} /></div>
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 pb-28 xl:pb-10 space-y-5">
      <header className="space-y-1">
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{t('Changelog')}</h1>
        <p className="text-sm text-muted">{t('What changed on SportLikely, newest first: our models and the site.')}</p>
      </header>
      {sports.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('Sport')}>
          {(['all', ...sports] as Filter[]).map(s => (
            <button key={s} onClick={() => setFilter(s)} aria-pressed={filter === s}
              className={`px-3 h-9 rounded-full text-xs font-bold border ${filter === s ? 'bg-accent/15 text-accent border-accent/40' : 'bg-surface2 text-muted border-line hover:text-ink'}`}>
              {s === 'all' ? t('All sports') : t(SPORT_LABEL[s])}
            </button>
          ))}
        </div>
      )}
      <ol className="space-y-3">
        {shown.map((e, i) => (
          <li key={`${e.date}-${i}`} className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <time dateTime={e.date} className="font-semibold text-ink">{new Date(`${e.date}T12:00:00Z`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}</time>
              <span className={`px-2 py-0.5 rounded-full font-bold ${e.kind === 'model' ? 'bg-accent/15 text-accent' : 'bg-surface2 text-muted'}`}>{e.kind === 'model' ? t('Model') : t('Site')}</span>
              <span className="text-muted">{e.sport === 'all' ? t('All sports') : t(SPORT_LABEL[e.sport])}</span>
              {e.version && e.sport !== 'all' && <span className="font-bold text-ink">{MODEL_NAME[e.sport]} {e.version}</span>}
            </div>
            <p className="mt-2 text-sm text-muted leading-relaxed">{e.text[lang] || e.text.en}</p>
          </li>
        ))}
      </ol>
      <p className="text-xs text-faint flex flex-wrap gap-x-3">
        {(filter === 'all' ? sports : [filter]).map(s => <Link key={s} to={HOW_PATH[s]} className="hover:text-ink underline">{t(HOW_TITLE[s])}</Link>)}
      </p>
    </div>
  )
}

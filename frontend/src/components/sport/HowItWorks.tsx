import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../../lib/socket'
import { useAuth } from '../../lib/auth'
import { t, LOCALE } from '../../lib/i18n'
import type { HowSport } from '../../lib/howItWorks'
import { Card } from './Accuracy'

/**
 * fix206: "How our models work" — one page for every sport (football's layout, like Accuracy): what we predict, what the
 * model looks at (from the config next to each model, backend *.inputs.ts), how we test it, what it can't do, the model
 * name and version, accuracy by competition (the sport's record, last 365 days, 20+ games, sortable) and the FAQ.
 * The text comes from /api/how-it-works/:sport as English keys and is translated here with t(); the server's
 * search-engine copy uses the same keys and dictionaries.
 */
interface Row { key: string; name: string; n: number; main: number | null; brier: number | null }
interface Faq { q: string; a: string; vars?: Record<string, string | number>; list?: string[] }
interface HowData {
  sport: HowSport
  model: { name: string; version: string; since: string | null }
  title: string
  mainPick: string
  predicts: string[]
  test: string[]
  cant: string[]
  inputs: { key: string; label: string; detail: string }[]
  accuracy: { rows: Row[]; total: { n: number; hitRate: number | null } }
  faq: Faq[]
  /** fix215: how the season forecast works (null in tennis) */
  season: { points: string[]; check: string; accuracy: { sim: number; base: number } | null } | null
}

const ACCURACY_PATH: Record<HowSport, string> = { football: '/accuracy', basketball: '/basketball/accuracy', 'american-football': '/american-football/accuracy', tennis: '/tennis/accuracy' }
const date = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** A FAQ answer: numbers, the translated input list and the date filled in (same rule as the server's faqAnswer). */
function answer(f: Faq) {
  const vars: Record<string, string | number> = { ...(f.vars || {}) }
  if (f.list) vars[0] = f.list.map(k => t(k)).join(', ')
  if (f.a.startsWith('{0}, our own model, live since') && typeof vars[1] === 'string') vars[1] = date(vars[1])
  return t(f.a, vars)
}

type SortKey = 'name' | 'n' | 'main' | 'brier'

export default function HowItWorks({ sport }: { sport: HowSport }) {
  const { access } = useAuth()
  const [d, setD] = useState<HowData | null>(null)
  const [failed, setFailed] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'n', desc: true })

  useEffect(() => {
    let cancelled = false
    setD(null); setFailed(false)
    axios.get(`${API_URL}/how-it-works/${sport}`)
      .then(r => { if (!cancelled) { setD(r.data.data); document.title = t('{0} · SportLikely', { 0: t(r.data.data.title) }) } })
      .catch(() => !cancelled && setFailed(true))
    return () => { cancelled = true }
  }, [sport])

  const rows = useMemo(() => {
    if (!d) return []
    const name = (r: Row) => (sport === 'tennis' || sport === 'american-football' ? t(r.name) : r.name)
    const list = [...d.accuracy.rows]
    const v = (r: Row) => (sort.key === 'name' ? name(r) : r[sort.key] ?? -1)
    list.sort((a, b) => {
      const x = v(a), y = v(b)
      const c = typeof x === 'string' ? x.localeCompare(String(y), LOCALE) : (x as number) - (y as number)
      return sort.desc ? -c : c
    })
    return list.map(r => ({ ...r, label: name(r) }))
  }, [d, sort, sport])

  if (failed) return <div className="max-w-2xl mx-auto px-4 py-16 text-center text-muted">{t("Couldn't load this page. Try again in a moment.")}</div>
  if (!d) return <div className="min-h-[50vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={t('Loading…')} /></div>

  const head = (key: SortKey, label: string, cls = '') => (
    <th className={`py-2 px-2 font-semibold ${cls}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'name' && key !== 'brier' }))} className="inline-flex items-center gap-1 hover:text-ink">
        {label}<span aria-hidden className="text-faint">{sort.key === key ? (sort.desc ? '↓' : '↑') : ''}</span>
      </button>
    </th>
  )
  const bullets = (keys: readonly string[]) => (
    <ul className="mt-3 space-y-2 text-sm text-muted list-disc pl-5 marker:text-accent">{keys.map(k => <li key={k}>{t(k)}</li>)}</ul>
  )

  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-8 pb-28 xl:pb-10 space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{t(d.title)}</h1>
        <p className="text-sm sm:text-base text-muted">{t('{0} is our own model. Here is what it predicts, what it looks at and how we check it, in plain words.', { 0: d.model.name })}</p>
      </header>

      <Card>
        <h2 className="font-display text-xl font-bold text-ink">{t('What we predict')}</h2>
        {bullets(d.predicts)}
      </Card>

      <Card>
        <h2 className="font-display text-xl font-bold text-ink">{t('What the model looks at')}</h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {d.inputs.map(i => (
            <li key={i.key} className="rounded-2xl bg-surface2/60 p-4">
              <div className="font-semibold text-ink text-sm">{t(i.label)}</div>
              <p className="text-xs text-muted mt-1 leading-relaxed">{t(i.detail)}</p>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="font-display text-xl font-bold text-ink">{t('How we test it')}</h2>
          {bullets(d.test)}
          {/* the record pages are admins-only for now (14 Oct): visitors see the table below instead */}
          {access === 'admin' && <Link to={ACCURACY_PATH[sport]} className="inline-block mt-3 text-sm font-bold text-accent">{t('See the full record →')}</Link>}
        </Card>
        <Card>
          <h2 className="font-display text-xl font-bold text-ink">{t("What it can't do")}</h2>
          {bullets(d.cant)}
        </Card>
      </div>

      {d.season && (
        <Card>
          <h2 className="font-display text-xl font-bold text-ink">{t('How the season forecast works')}</h2>
          {bullets(d.season.points)}
          <p className="mt-2 text-sm text-muted">{d.season.accuracy ? t('Last season replayed week by week: Brier score {0}, against {1} for reading the table as it stood. Lower is better.', { 0: d.season.accuracy.sim, 1: d.season.accuracy.base }) : t(d.season.check)}</p>
        </Card>
      )}

      <Card>
        <h2 className="font-display text-xl font-bold text-ink">{t('Model and version')}</h2>
        <p className="mt-2 text-sm text-muted">
          {d.model.since ? t('{0} went live on {1}.', { 0: d.model.name, 1: date(d.model.since) }) : t('{0} is not live yet.', { 0: d.model.name })}
        </p>
        <Link to="/changelog" className="inline-block mt-2 text-sm font-bold text-accent">{t('See every change in the changelog')} →</Link>
      </Card>

      <Card>
        <h2 className="font-display text-xl font-bold text-ink">{t('Accuracy by competition')}</h2>
        <p className="mt-1 text-sm text-muted">{t('Last 365 days, competitions with at least 20 finished games.')} {t(d.mainPick)}</p>
        {rows.length ? (
          <>
            <div className="mt-4 overflow-x-auto -mx-2">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted border-b border-line">
                  <tr>{head('name', t('Competition'))}{head('n', t('Games'), 'text-right')}{head('main', t('Main pick right'), 'text-right')}{head('brier', t('Brier score'), 'text-right')}</tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {rows.map(r => (
                    <tr key={r.key}>
                      <td className="py-2 px-2 text-ink truncate max-w-[180px] sm:max-w-none">{r.label}</td>
                      <td className="py-2 px-2 text-right num text-muted">{r.n}</td>
                      <td className="py-2 px-2 text-right num font-bold text-ink">{r.main == null ? '–' : `${r.main}%`}</td>
                      <td className="py-2 px-2 text-right num text-muted">{r.brier == null ? '–' : r.brier.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-faint">{t('Brier score: how far our chances were from what happened. Lower is better, 0 would be perfect.')}</p>
          </>
        ) : <p className="mt-3 text-sm text-faint">{t('Not enough finished games yet. A competition appears here once it has 20.')}</p>}
      </Card>

      <Card>
        <h2 className="font-display text-xl font-bold text-ink">{t('Questions and answers')}</h2>
        <dl className="mt-3 divide-y divide-line/50">
          {d.faq.map(f => (
            <div key={f.q} className="py-3">
              <dt className="font-semibold text-ink text-sm">{t(f.q)}</dt>
              <dd className="mt-1 text-sm text-muted">{answer(f)}</dd>
            </div>
          ))}
        </dl>
      </Card>

    </article>
  )
}

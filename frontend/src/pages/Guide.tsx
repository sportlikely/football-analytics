import { useEffect, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { t as tt } from '../lib/i18n'

/*
 * Guides (fix125): plain-English explainers at /guides/:slug and the list at /guides. The text is markdown in
 * src/content/guides/<slug>.md, rendered by the server (same HTML search engines get, live numbers filled in).
 * English only for now: other language versions show the English text (canonical = the English URL).
 */

interface GuideData { slug: string; title: string; description: string; h1: string; html: string; related: { slug: string; title: string }[] }
interface GuideItem { slug: string; title: string; description: string }

const plainTitle = (t: string) => t.replace(/\s*\|\s*SportLikely\s*$/, '')

const PROSE = [
  'text-[15px] sm:text-base text-muted leading-relaxed',
  '[&_h2]:font-display [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-ink [&_h2]:mt-8 [&_h2]:mb-2',
  '[&_h3]:font-display [&_h3]:text-lg [&_h3]:font-bold [&_h3]:text-ink [&_h3]:mt-6 [&_h3]:mb-2',
  '[&_p]:my-3 [&_ul]:my-3 [&_ul]:ps-5 [&_ul]:list-disc [&_li]:my-1.5 [&_li::marker]:text-accent',
  '[&_strong]:text-ink [&_strong]:font-semibold [&_a]:text-accent [&_a]:font-semibold hover:[&_a]:underline'
].join(' ')

function Spinner() {
  return <div className="min-h-[50vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={tt('Loading…')} /></div>
}

export default function Guide() {
  const { slug = '' } = useParams()
  const navigate = useNavigate()
  const [g, setG] = useState<GuideData | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    setG(null); setMissing(false)
    axios.get(`${API_URL}/guides/${encodeURIComponent(slug)}`)
      .then(r => { setG(r.data.data); document.title = r.data.data.title })
      .catch(() => setMissing(true))
  }, [slug])

  // links inside the guide text stay in the app (and keep the language prefix)
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (href && href.startsWith('/') && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href) }
  }

  if (missing) return (
    <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-3">
      <p className="text-muted">{tt("Guide not found.")}</p>
      <Link to="/guides" className="text-sm font-bold text-accent">{tt("All guides →")}</Link>
    </div>
  )
  if (!g) return <Spinner />
  return (
    <article className="max-w-2xl mx-auto px-4 py-6 sm:py-10">
      <Link to="/guides" className="text-sm text-muted hover:text-ink"><span aria-hidden className="rtl-flip">←</span> {tt("Guides")}</Link>
      <h1 className="mt-3 font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink leading-tight">{g.h1}</h1>
      <div className={`mt-4 ${PROSE}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: g.html }} />
      {g.related.length > 0 && (
        <section className="mt-10 card p-4 sm:p-5">
          <h2 className="font-display text-base font-bold text-ink">{tt("Related guides")}</h2>
          <ul className="mt-2 space-y-1.5">
            {g.related.map(r => <li key={r.slug}><Link to={`/guides/${r.slug}`} className="text-sm font-semibold text-accent">{r.title} →</Link></li>)}
          </ul>
        </section>
      )}
    </article>
  )
}

export function GuideIndex() {
  const [list, setList] = useState<GuideItem[] | null>(null)
  useEffect(() => {
    document.title = tt('{0} · SportLikely', { 0: tt('Guides') })
    axios.get(`${API_URL}/guides`).then(r => setList(r.data.data || [])).catch(() => setList([]))
  }, [])
  if (!list) return <Spinner />
  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-10 space-y-5">
      <header className="space-y-1">
        <h1 className="font-display text-3xl sm:text-4xl font-extrabold tracking-tight text-ink">{tt("Guides")}</h1>
        <p className="text-sm text-muted">{tt("How our predictions work, in plain English.")}</p>
      </header>
      <ul className="space-y-3">
        {list.map(g => (
          <li key={g.slug}>
            <Link to={`/guides/${g.slug}`} className="card card-hover block p-4 sm:p-5">
              <span className="block font-display text-lg font-bold text-ink">{plainTitle(g.title)}</span>
              <span className="block mt-1 text-sm text-muted">{g.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

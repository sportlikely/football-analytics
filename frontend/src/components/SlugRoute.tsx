import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { knownId, rememberSlug, type LinkKind, type LinkSport } from '../lib/links'
import { t } from '../lib/i18n'

/**
 * fix229: a page at /<sport>/<kind>/<slug> — the slug becomes the item's id for the page inside (useEntityId), from
 *  1. the link the visitor clicked (it remembered its id), 2. the page the server sent (#sl-ent), 3. /api/slug/….
 * A renamed item's old slug moves to the new one; an unknown slug opens the search with its words; a number where
 * the slug belongs (an old link inside the app) moves to the item's slug address.
 */
const EntityId = createContext<string | null>(null)
/** the id of the item this page shows (inside SlugRoute), else the route's :id / :code / :key */
export function useEntityId(): string | undefined {
  const fromSlug = useContext(EntityId)
  const p = useParams()
  return fromSlug ?? p.id ?? p.code ?? p.key
}

let served: { sport: string; kind: string; slug: string; id: string } | null | undefined
function fromServer(sport: string, kind: string, slug: string): string | null {
  if (served === undefined) {
    try { const el = document.getElementById('sl-ent'); served = el ? JSON.parse(el.textContent || 'null') : null } catch { served = null }
  }
  return served && served.sport === sport && served.kind === kind && served.slug === slug ? served.id : null
}

const searchOf = (slug: string) => `/search?q=${encodeURIComponent(slug.replace(/-vs-/, ' ').replace(/-\d{4}-\d{2}-\d{2}(-\d)?$/, '').replace(/-/g, ' '))}`

export function SlugRoute({ sport, kind, children }: { sport: LinkSport; kind: LinkKind; children: ReactNode }) {
  const { slug = '' } = useParams()
  const nav = useNavigate()
  const loc = useLocation()
  // a number (an old id) or a code with capitals (an old basketball league code: NBA, BB123) where the slug belongs
  const numeric = /^-?\d+$/.test(slug) || /[A-Z]/.test(slug)
  const [id, setId] = useState<string | null>(() => (numeric ? null : knownId(sport, kind, slug) ?? fromServer(sport, kind, slug)))
  useEffect(() => {
    let off = false
    const clicked = numeric ? null : knownId(sport, kind, slug)
    const now = clicked ?? (numeric ? null : fromServer(sport, kind, slug))
    setId(now)
    if (clicked) {
      // the link drew this slug from the name it had: the address bar gets the item's own slug if that differs
      axios.get(`${API_URL}/slug-of/${sport}/${kind}/${encodeURIComponent(clicked)}`).then(r => {
        const s = r.data?.data?.slug
        if (!off && s && s !== slug) { rememberSlug(sport, kind, s, clicked); nav(`/${sport}/${kind}/${s}${loc.search}${loc.hash}`, { replace: true }) }
      }).catch(() => undefined)
    }
    if (now) return () => { off = true }
    const url = numeric ? `${API_URL}/slug-of/${sport}/${kind}/${slug}` : `${API_URL}/slug/${sport}/${kind}/${slug}`
    axios.get(url).then(r => {
      if (off) return
      const d = r.data?.data || {}
      if (d.slug && d.slug !== slug) {
        if (d.id) rememberSlug(sport, kind, d.slug, d.id)
        nav(`/${sport}/${kind}/${d.slug}${loc.search}${loc.hash}`, { replace: true })
      } else if (d.id) setId(String(d.id))
    }).catch(() => { if (!off) nav(numeric ? `/${sport}` : searchOf(slug), { replace: true }) })
    return () => { off = true }
  }, [sport, kind, slug, numeric, nav, loc.search, loc.hash])
  if (!id) return <div className="min-h-[70vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={t('Loading…')} /></div>
  return <EntityId.Provider value={id}><Fragment key={id}>{children}</Fragment></EntityId.Provider>
}

/**
 * An old address inside the app (/team/86?c=…, /match/1, /basketball/game/1 …): the server answers these with a 301
 * when the page is loaded; a click on a stale in-app link lands here and moves to the slug address.
 */
export function OldLink({ sport, kind, id: fixedId }: { sport: LinkSport; kind: LinkKind; id?: string }) {
  const p = useParams()
  const loc = useLocation()
  const nav = useNavigate()
  const id = fixedId ?? p.id ?? p.code ?? p.key ?? ''
  useEffect(() => {
    let off = false
    axios.get(`${API_URL}/slug-of/${sport}/${kind}/${encodeURIComponent(id)}${loc.search}`)
      .then(r => { if (!off && r.data?.data?.slug) { rememberSlug(sport, kind, r.data.data.slug, id); nav(`/${sport}/${kind}/${r.data.data.slug}`, { replace: true }) } })
      .catch(() => { if (!off) nav(`/${sport}`, { replace: true }) })
    return () => { off = true }
  }, [sport, kind, id, loc.search, nav])
  return <div className="min-h-[70vh] grid place-items-center"><span className="w-8 h-8 rounded-full border-2 border-line border-t-accent animate-spin" aria-label={t('Loading…')} /></div>
}

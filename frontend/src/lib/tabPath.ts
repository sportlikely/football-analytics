import { useEffect } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

/**
 * fix235: a page's tabs are sub-paths — /football/match/<slug>/stats, /basketball/league/nba/forecast; the first tab
 * is the page itself (no sub-path, no "#…"). The page's route ends in `/*`, so the page stays mounted when the tab
 * changes. An old #tab link (#stats, #prediction …) opens its tab and the address becomes the sub-path; a sub-path that
 * is not a tab of this page moves to the page itself (the server does the same for a page load).
 */
export function useTabPath(ids: readonly string[], aliases: Record<string, string> = {}): [string, (id: string) => void] {
  const sub = (useParams()['*'] || '').replace(/\/+$/, '')
  const loc = useLocation()
  const nav = useNavigate()
  const path = loc.pathname.replace(/\/+$/, '')
  const base = sub && path.endsWith(`/${sub}`) ? path.slice(0, -(sub.length + 1)) : path
  const of = (raw: string) => { const h = aliases[raw] || raw; return ids.includes(h) ? h : null }
  const fromHash = loc.hash ? of(decodeURIComponent(loc.hash.slice(1))) : null
  const tab = fromHash ?? (sub ? of(sub) : null) ?? ids[0]
  const to = (id: string) => `${base}${id === ids[0] ? '' : `/${id}`}${loc.search}`
  const want = to(tab)
  useEffect(() => {
    if (fromHash || `${loc.pathname}${loc.search}` !== want) nav(want, { replace: true, state: loc.state })
  }, [want, fromHash, loc.pathname, loc.search, loc.state, nav])
  return [tab, (id: string) => { if (id !== tab) nav(to(id), { replace: true, state: loc.state }) }]
}

/**
 * fix235: a section of a page as a sub-path (/premium/packs, /account/emails): scrolled to once it is drawn (tried for
 * 2 s while the page loads); an old #section link moves to the sub-path.
 */
export function useSectionPath(ids: readonly string[]) {
  const loc = useLocation()
  const nav = useNavigate()
  const path = loc.pathname.replace(/\/+$/, '')
  const last = path.split('/').pop() || ''
  const hash = loc.hash.slice(1)
  useEffect(() => {
    if (hash && ids.includes(hash) && !ids.includes(last)) { nav(`${path}/${hash}${loc.search}`, { replace: true }); return }
    if (!ids.includes(last)) return
    let n = 0, timer = 0
    const go = () => {
      const el = document.getElementById(last)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      else if (n++ < 10) timer = window.setTimeout(go, 200)
    }
    go()
    return () => window.clearTimeout(timer)
  }, [path, last, hash, loc.search, nav, ids])
}

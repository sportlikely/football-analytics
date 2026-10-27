/**
 * fix167: after a deploy the old page files (/assets/*-<hash>.js) are gone. A tab opened before the deploy that opens a
 * page asks for the old file and gets a 404: the page reloads once and the visitor lands on the new version of the same
 * address. Guarded with sessionStorage (fix252: once per build per session, a hard reload), so it can never loop;
 * without sessionStorage, no reload (the error shows as before).
 */
const KEY = 'sl-chunk-reload'
let reloading = false

/** A failed page-file load (Chrome, Firefox, Safari wordings; Vite's preload helper; fix252: an import that came back
 *  without the module — "Cannot destructure property 'default' of 'undefined'" — or without its default export). */
export const isChunkError = (e: unknown) =>
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk|ChunkLoadError|dynamically imported module \((empty|no default)\)|destructure property 'default' of 'undefined'|reading 'default'/i
    .test(String((e as any)?.message ?? e))

/** fix252c: React's hooks with no renderer behind them — "Cannot read properties of null (reading 'useState')", "Invalid
 *  hook call": two copies of React on one page (app files that don't belong together), cured by one hard reload */
export const isTwoReacts = (e: unknown) =>
  /reading 'use[A-Z][A-Za-z]*'\)|Invalid hook call|null is not an object \(evaluating '[A-Za-z_$]+\.use[A-Z]/i
    .test(String((e as any)?.message ?? e))

/** fix252: a lazy import's result — the module with its default export, or a chunk error (treated like a failed load) */
export function moduleDefault<T>(m: { default?: T } | null | undefined): T {
  if (!m) throw new Error('Failed to fetch dynamically imported module (empty)')
  if (m.default == null) throw new Error('Failed to fetch dynamically imported module (no default)')
  return m.default
}

/** A reload for the new version has been started (the page is going away: show nothing more). */
export const isReloading = () => reloading

/** the query parameter of the fix252 hard reload (removed from the address again once the app is up: dropReloadParam) */
export const RELOAD_PARAM = 'sl_v'
const HARD_KEY = 'sl-hard-reload'
/** this page's own app file (/assets/index-<hash>.js): which build the tab runs */
const appFile = () => { try { return (document.querySelector('script[type=module][src*="/assets/"]') as HTMLScriptElement | null)?.src.split('?')[0] || '' } catch { return '' } }

/**
 * Reload the page for the new version; false when that would loop (a real error, not an old tab).
 * fix252: a hard reload — the same address with ?sl_v=<time>, so no browser or CDN copy of the old page (naming the old
 * build's files) can come back — once per session for this build: the tab reloads again only when it then runs another
 * build (a later deploy). Without the app file's name (dev) at most once a minute as before; without sessionStorage none.
 */
export function reloadForNewVersion(): boolean {
  if (reloading) return true
  try {
    const app = appFile()
    if (app) {
      if (sessionStorage.getItem(HARD_KEY) === app) return false
      sessionStorage.setItem(HARD_KEY, app)
    } else {
      const last = Number(sessionStorage.getItem(KEY)) || 0
      if (Date.now() - last < 60_000) return false
      sessionStorage.setItem(KEY, String(Date.now()))
    }
  } catch {
    return false
  }
  reloading = true
  try {
    const u = new URL(window.location.href)
    u.searchParams.set(RELOAD_PARAM, String(Date.now()))
    window.location.replace(u.toString())
  } catch {
    window.location.reload()
  }
  return true
}

/** fix252: the app is up — take ?sl_v= off the address (never in a shared or bookmarked link) */
export function dropReloadParam() {
  try {
    const u = new URL(window.location.href)
    if (!u.searchParams.has(RELOAD_PARAM)) return
    u.searchParams.delete(RELOAD_PARAM)
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash)
  } catch { /* the address keeps it: harmless */ }
}

/**
 * Vite fires `vite:preloadError` when a page file (or a file it needs) can't be loaded: reload once. It is marked
 * handled only when we reload — a handled event makes Vite's loader return nothing instead of failing, so when the
 * guard says no, the error is left to fail the page's import as usual (the page shows its error box).
 */
export function watchChunkErrors() {
  window.addEventListener('vite:preloadError', e => {
    if (reloadForNewVersion()) e.preventDefault()
  })
}

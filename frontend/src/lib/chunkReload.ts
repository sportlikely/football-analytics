/**
 * fix167: after a deploy the old page files (/assets/*-<hash>.js) are gone. A tab opened before the deploy that opens a
 * page asks for the old file and gets a 404: the page reloads once and the visitor lands on the new version of the same
 * address. Guarded with sessionStorage (at most one reload a minute), so it can never loop; without sessionStorage, no
 * reload (the error shows as before).
 */
const KEY = 'sl-chunk-reload'
let reloading = false

/** A failed page-file load (Chrome, Firefox, Safari wordings; Vite's preload helper). */
export const isChunkError = (e: unknown) =>
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk|ChunkLoadError/i
    .test(String((e as any)?.message ?? e))

/** A reload for the new version has been started (the page is going away: show nothing more). */
export const isReloading = () => reloading

/** Reload the page for the new version; false when we reloaded less than a minute ago (a real error, not an old tab). */
export function reloadForNewVersion(): boolean {
  if (reloading) return true
  try {
    const last = Number(sessionStorage.getItem(KEY)) || 0
    if (Date.now() - last < 60_000) return false
    sessionStorage.setItem(KEY, String(Date.now()))
  } catch {
    return false
  }
  reloading = true
  window.location.reload()
  return true
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

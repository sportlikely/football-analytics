/**
 * fix252c: the error card is never a blank page. The server sends every page with its stored text inside #root (the
 * crawler copy, hidden while the app runs); the app keeps that copy before it replaces it, and an error box on that
 * same address shows it under the message (components/ErrorFallback.tsx).
 */
let saved: { path: string; html: string } | null = null

/** keep #root's server copy (call once, before the app renders into #root) */
export function captureStoredHtml() {
  try {
    const root = document.getElementById('root')
    const html = root?.innerHTML.trim() || ''
    if (html && root?.querySelector('.sl-seo')) saved = { path: window.location.pathname, html }
  } catch { /* no copy: the box shows the message only */ }
}

/** the server copy of `path` (the address the tab was opened on), or null */
export function storedHtml(path: string = window.location.pathname): string | null {
  return saved && saved.path === path ? saved.html : null
}

/**
 * fix273: an admin page's background refresh. Every admin card polled on its own (the Visitors card every 30 s, the
 * summary every minute) and kept polling in a hidden tab — one admin tab left open kept the server busy all night.
 * `poll(load, ms)` calls `load` every `ms` while the tab is visible, pauses while it is hidden and loads once on return
 * when a tick was missed. Returns the stop function (for useEffect's cleanup). The first load is the caller's.
 */
export const ADMIN_POLL_MS = 5 * 60 * 1000

export function poll(load: () => unknown, ms: number = ADMIN_POLL_MS): () => void {
  let last = Date.now()
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const tick = () => { if (hidden()) return; last = Date.now(); load() }
  const iv = setInterval(tick, ms)
  const onVis = () => { if (!hidden() && Date.now() - last >= ms) tick() }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
  return () => { clearInterval(iv); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis) }
}

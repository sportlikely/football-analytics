import { API_URL } from './socket'

/**
 * fix183: the visitor counter counts people, not scripts. Once per page load, after the page has been visible for
 * 5 seconds in total and the visitor scrolled, clicked, pressed a key or touched the screen, the browser sends one
 * small "seen" message. It carries a random token for this page load and a few browser signals (automated browser,
 * number of languages and plugins); nothing about the person. The server keeps only its usual salted visitor hash.
 */
export function watchSeen() {
  try {
    if (typeof document === 'undefined' || /^\/admin/.test(location.pathname)) return
    const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 20)
    let visibleMs = 0, since = document.visibilityState === 'visible' ? performance.now() : 0, interacted = false, sent = false
    const tick = () => {
      if (since) { const t = performance.now(); visibleMs += t - since; since = t }
      if (!sent && interacted && visibleMs >= 5000) send()
    }
    const send = () => {
      sent = true
      const body = JSON.stringify({
        token, visibleMs: Math.round(visibleMs), interacted,
        webdriver: !!(navigator as any).webdriver, languages: navigator.languages?.length || 0, plugins: navigator.plugins?.length || 0
      })
      try {
        fetch(`${API_URL}/visit/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'include' }).catch(() => undefined)
      } catch { /* never breaks the page */ }
      for (const ev of EVENTS) window.removeEventListener(ev, onInput, true)
      clearInterval(iv)
    }
    const onInput = () => { interacted = true; tick() }
    const EVENTS = ['scroll', 'click', 'keydown', 'touchstart', 'pointerdown', 'wheel']
    for (const ev of EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') since = performance.now()
      else { tick(); since = 0 }
    })
    const iv = setInterval(tick, 1000)
  } catch { /* old browser: not counted */ }
}

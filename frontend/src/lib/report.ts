/**
 * Site crash reports (Oct 2026): when a page breaks, a short report goes to the server so the admin sees which pages
 * break (Admin → Overview → Site errors) and gets an email for a new problem. Sent: the error message, a few lines of
 * code location, the page address, the site version and the browser name. Nothing personal.
 */
const sent = new Set<string>()

/** "Safari · iOS", "Instagram app · iOS", "Chrome · Android" (fix198: in-app browsers by name — WhatsApp, Instagram …) */
export function browserName() {
  const ua = navigator.userAgent
  const app = /Instagram/.test(ua) ? 'Instagram app' : /FBAN|FBAV|FB_IAB|FBIOS/.test(ua) ? 'Facebook app' : /WhatsApp/i.test(ua) ? 'WhatsApp app'
    : /BytedanceWebview|musical_ly|TikTok/i.test(ua) ? 'TikTok app' : /Snapchat/.test(ua) ? 'Snapchat app' : /\bLine\//.test(ua) ? 'LINE app'
    : /Twitter/.test(ua) ? 'X app' : /LinkedInApp/.test(ua) ? 'LinkedIn app' : /GSA\//.test(ua) ? 'Google app' : null
  const b = app || (/EdgiOS|Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /iPhone|iPad/.test(ua) && /AppleWebKit/.test(ua) ? 'in-app browser' : 'Other')
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} · ${os}` : b
}

function version() {
  const s = [...document.scripts].map(x => x.src).find(x => /\/assets\/index-/.test(x)) || ''
  return (s.match(/index-[A-Za-z0-9_-]+/) || [''])[0]
}

export function reportError(err: unknown, kind: 'page' | 'uncaught') {
  try {
    const e = err as { message?: string; stack?: string } | null
    const message = String(e?.message || err || '').slice(0, 300)
    if (!message) return
    const page = window.location.pathname
    const key = `${message}|${page}`
    if (sent.has(key) || sent.size > 20) return // once per problem per visit
    sent.add(key)
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify({ message, stack: String(e?.stack || '').slice(0, 2000), page, kind, version: version(), browser: browserName() })
    }).catch(() => undefined)
  } catch { /* reporting never breaks the page */ }
}

/** Errors no page caught (only from our own code: browser extensions and other sites' scripts are skipped). */
export function watchErrors() {
  window.addEventListener('error', ev => {
    if (!(ev.error instanceof Error)) return // broken pictures and other resources: not a crash
    if (ev.filename && !ev.filename.startsWith(window.location.origin)) return
    reportError(ev.error, 'uncaught')
  })
}

/**
 * fix198: the sign-up security check (Cloudflare Turnstile) failed in this browser — the widget's error code goes to the
 * server with the form token (logged with the browser family, counted on Admin → Data health; two of them on the same
 * form let the sign-up through without the check).
 */
export function reportCheck(code: string, where: 'signup' | 'login', formToken: string | null) {
  try {
    void fetch('/api/auth/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify({ where, code, formToken, browser: browserName() })
    }).catch(() => undefined)
  } catch { /* reporting never breaks the page */ }
}

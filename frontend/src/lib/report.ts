/**
 * Site crash reports (Oct 2026): when a page breaks, a short report goes to the server so the admin sees which pages
 * break (Admin → Overview → Site errors) and gets an email for a new problem. Sent: the error message, a few lines of
 * code location, the page address, the site version and the browser name. Nothing personal.
 */
const sent = new Set<string>()

function browserName() {
  const ua = navigator.userAgent
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox\//.test(ua) ? 'Firefox'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other'
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} · ${os}` : b
}

/** the build id "index-<hash>" (fix275: from this file's own address when the page's script tags don't name it) */
function version() {
  const s = [...document.scripts].map(x => x.src).find(x => /\/assets\/index-/.test(x)) || ''
  return (s.match(/index-[A-Za-z0-9_-]+/) || String(import.meta.url).match(/index-[A-Za-z0-9_-]+/) || [''])[0]
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

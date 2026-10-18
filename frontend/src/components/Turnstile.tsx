import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'

/**
 * fix168: Cloudflare Turnstile (managed mode, the site's light / dark theme). The site key comes from
 * /api/auth/config at run time (never baked into the build); with no key configured nothing renders and the server
 * skips the check. Cloudflare's script loads only when a widget is shown.
 */
declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id: string) => void } } }

let keyPromise: Promise<string | null> | null = null
export function useTurnstileKey(): string | null {
  const [k, setK] = useState<string | null>(null)
  useEffect(() => {
    keyPromise ||= axios.get(`${API_URL}/auth/config`).then(r => r.data?.turnstileSiteKey || null).catch(() => null)
    let on = true
    keyPromise.then(v => { if (on) setK(v) })
    return () => { on = false }
  }, [])
  return k
}

let scriptPromise: Promise<void> | null = null
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  scriptPromise ||= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => { scriptPromise = null; reject(new Error('turnstile script')) }
    document.head.appendChild(s)
  })
  return scriptPromise
}

/** The widget; calls onToken with Cloudflare's token (or '' when it expires). Renders nothing without a site key. */
export default function Turnstile({ siteKey, onToken }: { siteKey: string | null; onToken: (t: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const cb = useRef(onToken)
  cb.current = onToken
  useEffect(() => {
    if (!siteKey || !box.current) return
    let id: string | null = null
    let gone = false
    loadScript().then(() => {
      if (gone || !box.current || !window.turnstile) return
      id = window.turnstile.render(box.current, {
        sitekey: siteKey,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        appearance: 'managed',
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(''),
        'error-callback': () => cb.current('')
      })
    }).catch(() => undefined)
    return () => { gone = true; if (id && window.turnstile) window.turnstile.remove(id) }
  }, [siteKey])
  if (!siteKey) return null
  return <div ref={box} className="min-h-[65px]" />
}

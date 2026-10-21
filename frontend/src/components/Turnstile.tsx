import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { API_URL } from '../lib/socket'
import { reportCheck } from '../lib/report'

/**
 * fix168: Cloudflare Turnstile (managed mode, the site's light / dark theme). The site key comes from
 * /api/auth/config at run time (never baked into the build); with no key configured nothing renders and the server
 * skips the check. Cloudflare's script loads only when a widget is shown.
 *
 * fix198: the form always knows where the check stands (onState): loading → ready (a token) or interactive (the person
 * has to tap it) or error with a code — Cloudflare's error code, 'timeout' (nothing after 10 s), 'script' (the script
 * was blocked: ad-blocker, in-app browser, network), 'challenge-timeout', 'unsupported'. Every error is reported with
 * the browser name. A new widget = a new `key` from the form (Retry, or after a failed submit: a token works once).
 */
declare global { interface Window { turnstile?: { render: (el: HTMLElement, o: Record<string, unknown>) => string; remove: (id: string) => void; reset: (id: string) => void } } }

export interface CheckState { state: 'loading' | 'ready' | 'interactive' | 'error'; code?: string }

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
    s.onload = () => (window.turnstile ? resolve() : reject(new Error('turnstile script')))
    s.onerror = () => { scriptPromise = null; s.remove(); reject(new Error('turnstile script')) }
    document.head.appendChild(s)
  })
  return scriptPromise
}

/** The widget; onToken gets Cloudflare's token ('' while there is none). Renders nothing without a site key. */
export default function Turnstile({ siteKey, onToken, onState, hidden = false, where = 'signup', formToken = null }: {
  siteKey: string | null; onToken: (t: string) => void; onState?: (s: CheckState) => void; hidden?: boolean; where?: 'signup' | 'login'; formToken?: string | null
}) {
  const box = useRef<HTMLDivElement>(null)
  const cb = useRef(onToken)
  cb.current = onToken
  const st = useRef(onState)
  st.current = onState
  const ft = useRef(formToken)
  ft.current = formToken
  useEffect(() => {
    if (!siteKey || !box.current) return
    let id: string | null = null
    let gone = false
    const set = (s: CheckState) => { if (!gone) st.current?.(s) }
    const fail = (code: string) => {
      if (gone) return
      clearTimeout(timer)
      cb.current('')
      set({ state: 'error', code })
      reportCheck(code, where, ft.current)
    }
    set({ state: 'loading' })
    // nothing from the widget in 10 s (no token, no box to tap): it isn't going to work in this browser
    const timer = setTimeout(() => fail('timeout'), 10000)
    loadScript().then(() => {
      if (gone || !box.current || !window.turnstile) return
      id = window.turnstile.render(box.current, {
        sitekey: siteKey,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        appearance: 'managed',
        retry: 'never', // the form's Retry button decides (Cloudflare's own retries left the box empty on iPhones)
        'refresh-expired': 'auto',
        callback: (t: string) => { clearTimeout(timer); cb.current(t); set({ state: 'ready' }) },
        'before-interactive-callback': () => { clearTimeout(timer); set({ state: 'interactive' }) },
        'expired-callback': () => { cb.current(''); set({ state: 'loading' }) },
        'error-callback': (code?: string | number) => { fail(String(code || 'error')); return true },
        'timeout-callback': () => fail('challenge-timeout'),
        'unsupported-callback': () => fail('unsupported')
      })
    }).catch(() => fail('script'))
    return () => { gone = true; clearTimeout(timer); if (id && window.turnstile) { try { window.turnstile.remove(id) } catch { /* gone */ } } }
  }, [siteKey, where])
  if (!siteKey) return null
  return <div ref={box} className={hidden ? 'hidden' : 'min-h-[65px]'} />
}

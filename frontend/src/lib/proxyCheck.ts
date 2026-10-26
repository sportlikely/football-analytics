/**
 * fix244: the app's side of the proxy rules (server: services/proxyGuard.ts).
 *  - every API call says which page view it belongs to (X-SL-View, a new id each time the address changes; the first
 *    view of a page load starts with "L"): on a VPN / proxy network the server counts page views, not API calls;
 *  - a 429 from the proxy rules opens the Quick check (a small server page with Cloudflare Turnstile), then comes back
 *    to this page; any other 429 reads "Too many requests, try again in a minute" — never "Request failed with status
 *    code 429".
 */
import axios, { type AxiosError } from 'axios'
import { t, basename } from './i18n'
import { currentView } from './viewId'

const ownApi = (url?: string) => !!url && (url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`))

let leaving = false
export function openQuickCheck() {
  if (leaving) return
  leaving = true
  try { sessionStorage.setItem('sl-qc-return', window.location.pathname + window.location.search) } catch { /* private mode */ }
  window.location.assign(`${basename}/quick-check`)
}

export function watchProxyCheck() {
  axios.interceptors.request.use(cfg => {
    if (ownApi(cfg.url)) cfg.headers.set('X-SL-View', currentView())
    return cfg
  })
  axios.interceptors.response.use(undefined, (err: AxiosError) => {
    const r = err.response
    if (r?.status !== 429) throw err
    const data = (r.data && typeof r.data === 'object' ? r.data : {}) as { error?: string; proxy?: boolean; check?: boolean }
    if (data.proxy && data.check) openQuickCheck()
    const msg = data.proxy && !data.check
      ? t('Too many pages opened from this network. Please try again later, or sign in.')
      : t('Too many requests, try again in a minute')
    err.message = msg
    r.data = { ...data, error: msg }
    throw err
  })
}

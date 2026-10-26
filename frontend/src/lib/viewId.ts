/**
 * fix244: which page view an API call belongs to (header X-SL-View): a new id each time the address changes, the first
 * view of a page load starts with "L". On a VPN / proxy network the server counts page views, not API calls
 * (services/proxyGuard.ts). No imports (links.ts uses it).
 */
const rid = () => Math.random().toString(36).slice(2, 10)
let viewPath: string | null = null
let viewId = `L${rid()}`

export function currentView(): string {
  if (typeof window === 'undefined') return viewId
  const p = window.location.pathname
  if (viewPath === null) viewPath = p
  else if (p !== viewPath) { viewPath = p; viewId = `V${rid()}` }
  return viewId
}

export const viewHeaders = (): Record<string, string> => ({ 'X-SL-View': currentView() })

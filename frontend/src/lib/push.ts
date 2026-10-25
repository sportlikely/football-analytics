/**
 * fix226: web push in the browser — the service worker (/sw.js), the permission and this browser's subscription.
 * iPhone / iPad: Web Push works only for the site added to the Home Screen (iOS 16.4+), never in a Safari tab.
 */
export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export const isIos = () =>
  typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/** opened from the Home Screen (not a browser tab) */
export const isStandalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true)

export const permission = (): NotificationPermission | 'unsupported' => (pushSupported() ? Notification.permission : 'unsupported')

const keyBytes = (b64u: string) => {
  const s = atob((b64u + '='.repeat((4 - (b64u.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, c => c.charCodeAt(0))
}

export async function registration(): Promise<ServiceWorkerRegistration> {
  const r = (await navigator.serviceWorker.getRegistration('/')) || (await navigator.serviceWorker.register('/sw.js', { scope: '/' }))
  await navigator.serviceWorker.ready
  return r
}

/** this browser's subscription, if it has one (no permission prompt) */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null
  const r = await navigator.serviceWorker.getRegistration('/')
  return r ? r.pushManager.getSubscription() : null
}

/**
 * Ask for the permission and subscribe. Call it straight from a tap (browsers only show the prompt then).
 * Throws 'denied' when the person said no (or blocked it before).
 */
export async function subscribe(publicKey: string): Promise<PushSubscription> {
  const p = await Notification.requestPermission()
  if (p !== 'granted') throw new Error('denied')
  const r = await registration()
  const cur = await r.pushManager.getSubscription()
  if (cur) return cur
  return r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
}

/** The short id the server lists each device under (sha-256 of the endpoint, 16 hex characters). */
export async function deviceId(endpoint: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

/** A notification from this page (no server): shows the person what an alert looks like on this device. */
export async function showTest(title: string, body: string) {
  const r = await registration()
  await r.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', tag: 'test', data: { url: '/account/alerts' } })
}

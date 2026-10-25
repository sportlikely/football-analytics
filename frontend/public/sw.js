/*
 * fix226: SportLikely service worker — push alerts only (no offline cache: pages always come from the network).
 * The server sends { title, body, url, tag, kind }; a newer alert of the same game replaces the older one (tag).
 * Served from /sw.js with Cache-Control: no-cache, so a new version reaches every browser on its next visit.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { body: e.data ? e.data.text() : '' } }
  e.waitUntil(self.registration.showNotification(d.title || 'SportLikely', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/' }
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.location.origin) && 'focus' in c) return c.focus().then(w => (w && 'navigate' in w ? w.navigate(url) : w))
    }
    return self.clients.openWindow(url)
  }))
})

// the browser renewed the subscription: tell the server (the person's sign-in cookie goes with it)
self.addEventListener('pushsubscriptionchange', e => {
  const key = e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey
  if (!key) return
  e.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then(sub =>
    fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) })
  ).catch(() => undefined))
})

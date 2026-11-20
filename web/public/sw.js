const CACHE = 'yantra-shell'

// R-23: a cached reading is a confident lie with a longer memory. These paths
// are never answered from here, so offline reads as offline.
const DATA = /^\/(api|healthz|heartbeat)(\/|$)/

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(precache())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || DATA.test(url.pathname)) return
  event.respondWith(shell(request))
})

self.addEventListener('push', (event) => {
  event.waitUntil(show(event.data))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(open(event.notification.data && event.notification.data.url))
})

/** ADR-0047: the daemon sends `{title, body, url}`. Every push shows a
 *  notification, readable or not, because iOS takes the permission away from
 *  an app whose pushes show nothing. */
async function show(data) {
  let said = {}
  try {
    said = (data && data.json()) || {}
  } catch {
    // Not JSON: the notification below still names Yantra.
  }
  await self.registration.showNotification(said.title || 'Yantra', {
    body: said.body || '',
    icon: '/icon-192.png',
    data: { url: said.url || '/' },
  })
}

/** A push names a page of this dashboard and never another site, so a URL
 *  on any other origin opens the dashboard's first page. */
function page(url) {
  try {
    const asked = new URL(url || '/', self.location.origin)
    if (asked.origin === self.location.origin) return asked.href
  } catch {
    // Not a URL at all.
  }
  return new URL('/', self.location.origin).href
}

/** An open dashboard goes to the page and takes the focus. With none open,
 *  or one that cannot be moved, the page opens in a new window. */
async function open(url) {
  const href = page(url)
  const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (client) {
    try {
      const there = await client.navigate(href)
      await (there || client).focus()
      return
    } catch {
      // A window this worker does not control cannot be navigated.
    }
  }
  await self.clients.openWindow(href)
}

/** Network first, so a shell served from cache only ever means the network was
 *  not there. Every navigation is `index.html` — yantrad's SPA fallback — so
 *  they share one key and a deep link works offline. */
async function shell(request) {
  const key = request.mode === 'navigate' ? '/' : request
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(key, response.clone())
    return response
  } catch (offline) {
    const cached = await cache.match(key)
    if (cached) return cached
    throw offline
  }
}

/** The first launch after installing to a home screen may be the first one
 *  offline, so the shell is taken now rather than when it is next asked for.
 *  Vite's asset names are hashed, so index.html is the only place they exist. */
async function precache() {
  const cache = await caches.open(CACHE)
  const index = await fetch('/', { cache: 'reload' })
  if (!index.ok) return
  await cache.put('/', index.clone())
  const assets = [...(await index.text()).matchAll(/(?:src|href)="(\/[^"]+)"/g)]
  await Promise.allSettled(assets.map(([, url]) => cache.add(url)))
}

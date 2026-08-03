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

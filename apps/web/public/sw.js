const CACHE_NAME = 'xefig-v6'

const PRECACHE_URLS = ['/', '/favicon.svg', '/icons.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    const current = await caches.open(CACHE_NAME)
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map(async (oldKey) => {
      const oldCache = await caches.open(oldKey)
      const reqs = await oldCache.keys()
      await Promise.all(reqs.map(async (req) => {
        if (new URL(req.url).pathname.startsWith('/music/')) {
          const res = await oldCache.match(req)
          if (res) await current.put(req, res)
        }
      }))
      await caches.delete(oldKey)
    }))
  })())
  self.clients.claim()
})

// Strip query params to get a stable cache key
function cacheKey(request) {
  const url = new URL(request.url)
  url.search = ''
  return new Request(url.toString())
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle http(s) requests from our origin
  if (url.origin !== self.location.origin || !url.protocol.startsWith('http')) {
    return
  }

  // API requests: network-first, fall back to cache
  if (url.pathname.startsWith('/api')) {
    if (request.method !== 'GET') {
      event.respondWith(
        fetch(request).catch(() => new Response('{"error":"offline"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }))
      )
      return
    }

    const key = cacheKey(request)
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(key, clone))
          }
          return response
        })
        .catch(() => caches.match(key).then((cached) => cached || new Response('{"error":"offline"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })))
    )
    return
  }

  // Non-GET requests outside /api (e.g. Cloudflare RUM beacons,
  // challenge-platform POSTs) can't be stored in the Cache API — let them
  // pass straight through to the network.
  if (request.method !== 'GET') return

  // CDN images: key by the full URL (including ?v=<timestamp>) so a regenerated
  // image served at a new version is a cache miss and gets re-fetched, rather
  // than being served forever from the first cached copy.
  // Offline fallback: if the network fails and we have no exact-URL match,
  // serve any previously cached version of the same path (ignoreSearch) so
  // users on frail networks still see something they had before a regeneration.
  if (url.pathname.startsWith('/cdn')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request)
        if (cached) {
          // Refresh in background so a newer ?v= is picked up next time.
          fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone())
          }).catch(() => {})
          return cached
        }
        try {
          const response = await fetch(request)
          if (response.ok) cache.put(request, response.clone())
          return response
        } catch (err) {
          const stale = await cache.match(request, { ignoreSearch: true })
          if (stale) return stale
          throw err
        }
      })
    )
    return
  }

  // Stale-while-revalidate for app shell & assets
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        const fetched = fetch(request).then((response) => {
          if (response.ok) cache.put(request, response.clone())
          return response
        })
        return cached || fetched
      })
    )
  )
})

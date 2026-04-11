const CACHE_NAME = 'xefig-v4'

const PRECACHE_URLS = ['/', '/favicon.svg', '/icons.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
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

  // CDN images: stale-while-revalidate (serve cached immediately, refresh in background)
  if (url.pathname.startsWith('/cdn')) {
    const key = cacheKey(request)
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(key).then((cached) => {
          const fetched = fetch(request).then((response) => {
            if (response.ok) cache.put(key, response.clone())
            return response
          }).catch(() => cached)
          return cached || fetched
        })
      )
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

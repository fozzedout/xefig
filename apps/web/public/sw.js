const CACHE_NAME = 'xefig-v10'

const PRECACHE_URLS = ['/', '/favicon.svg', '/icons.svg']

// iOS Safari refuses to serve a cached navigation response if the original
// had redirected: true — even when the body is fine and the URL is unchanged.
// new Response() always has redirected: false, so wrap anything we put in
// (or read out of) the cache. Harmless on responses that weren't redirected.
function cleanResponse(response) {
  if (!response || !response.redirected) return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  )
  self.skipWaiting()
})

// Eviction channel from the page. The page tells us which cached URLs
// are no longer worth keeping (e.g. full-res images for puzzles the
// user has just completed) so the budget stays focused on unplayed
// content. ignoreSearch handles the ?v= cache-bust on /cdn images.
self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'evict-cached') return
  const urls = Array.isArray(data.urls) ? data.urls : []
  if (urls.length === 0) return
  // Hard-match on pathname: ignoreSearch on cache.delete has been
  // observed (iOS Safari especially) to over-match in ways that
  // include sibling URLs we never named. Iterate the cache, compare
  // pathnames exactly, delete by the original Request object so the
  // query string is preserved during deletion.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    const targetPaths = new Set()
    for (const raw of urls) {
      try {
        targetPaths.add(new URL(raw, self.location.origin).pathname)
      } catch {
        // Ignore unparseable entries.
      }
    }
    if (targetPaths.size === 0) return
    const keys = await cache.keys()
    await Promise.all(keys.map((req) => {
      try {
        const path = new URL(req.url).pathname
        if (targetPaths.has(path)) return cache.delete(req)
      } catch {
        // Skip unparseable cache keys.
      }
      return null
    }))
  })())
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
          if (response.status === 200) {
            const clone = cleanResponse(response.clone())
            caches.open(CACHE_NAME).then((cache) => cache.put(key, clone))
          }
          return response
        })
        .catch(() => caches.match(key).then((cached) => cleanResponse(cached) || new Response('{"error":"offline"}', {
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

  // Navigations / HTML documents: network-first with a generous timeout,
  // falling back to cache. Stale-while-revalidate bricks the app across
  // deploys because the old index.html references hashed asset filenames
  // that no longer exist on the server (404s → "Loading..." forever).
  // The timeout is intentionally long (5s) — on a heavily-congested
  // cellular network a fast fallback to stale cache is preferable to
  // staring at a blank screen, but we want to prefer fresh HTML when the
  // network is healthy. The background fetch always runs to completion
  // and updates the cache, so a stale-cached load is recovered next
  // time. The brick-recovery script in index.html catches the rare case
  // where the stale-cached HTML's hashed asset is gone from both the
  // server and the SW cache.
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(request)

      const networkFetch = (async () => {
        try {
          const response = await fetch(request)
          if (response.status === 200) {
            cache.put(request, cleanResponse(response.clone()))
          }
          return response
        } catch {
          return null
        }
      })()

      if (cached) {
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000))
        const winner = await Promise.race([networkFetch, timeout])
        if (winner) return winner
        return cleanResponse(cached)
      }

      const response = await networkFetch
      if (response) return response
      const fallback = await cache.match('/')
      if (fallback) return cleanResponse(fallback)
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    })())
    return
  }

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
            if (response.status === 200) cache.put(request, cleanResponse(response.clone()))
          }).catch(() => {})
          return cleanResponse(cached)
        }
        try {
          const response = await fetch(request)
          if (response.status === 200) cache.put(request, cleanResponse(response.clone()))
          return response
        } catch (err) {
          const stale = await cache.match(request, { ignoreSearch: true })
          if (stale) return cleanResponse(stale)
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
          if (response.status === 200) cache.put(request, cleanResponse(response.clone()))
          return response
        })
        return cleanResponse(cached) || fetched
      })
    )
  )
})

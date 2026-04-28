import { expect, test } from '@playwright/test'

const HERO_URL = '/src/assets/hero.png'

function createTodayPayload() {
  const today = new Date().toISOString().slice(0, 10)
  return {
    date: today,
    categories: {
      jigsaw: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      slider: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      swap: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      polygram: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      diamond: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
    },
  }
}

async function mockApi(page) {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(createTodayPayload()),
    })
  })
}

async function waitForActiveSW(page) {
  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false
    const reg = await navigator.serviceWorker.ready
    return !!(reg && reg.active && reg.active.state === 'activated')
  }, null, { timeout: 15000 })
}

async function warmUp(page) {
  await mockApi(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await waitForActiveSW(page)
  // Force a SW-intercepted navigation so `/` and its assets end up in the cache.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(async () => {
    const keys = await caches.keys()
    for (const name of keys) {
      const cache = await caches.open(name)
      const match = await cache.match('/')
      if (match) return true
    }
    return false
  }, null, { timeout: 10000 })
}

test.describe('service worker navigation caching', () => {
  test('normal network: reload renders the launcher from a live response', async ({ page }) => {
    await warmUp(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.slice[data-mode="jigsaw"]')).toBeVisible({ timeout: 10000 })
  })

  test('offline: navigation falls back to cached HTML', async ({ page, context }) => {
    await warmUp(page)
    await context.setOffline(true)
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.slice[data-mode="jigsaw"]')).toBeVisible({ timeout: 10000 })
    } finally {
      await context.setOffline(false)
    }
  })

  test('slow connection: SW 2.5s timeout race serves cached HTML quickly', async ({ page, context }) => {
    await warmUp(page)

    // page.route does not intercept the SW's internal fetch() by default, so
    // throttle at the network layer instead. 10s latency is well past the SW's
    // 2.5s race-to-cache timeout — if the race is working the cached HTML must
    // win and the launcher renders in well under 10s.
    const client = await context.newCDPSession(page)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 10000,
      downloadThroughput: 500 * 1024,
      uploadThroughput: 500 * 1024,
    })

    const start = Date.now()
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.slice[data-mode="jigsaw"]')).toBeVisible({ timeout: 15000 })
    } finally {
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
    }
    const elapsed = Date.now() - start

    // Cached response must beat the stalled network. Lower bound is loose —
    // the point is the launcher appears long before the 10s latency would have
    // allowed a fresh fetch to complete.
    expect(elapsed).toBeLessThan(9000)
  })

  test('post-deploy: stale cached HTML is replaced by fresh network HTML', async ({ page }) => {
    await warmUp(page)

    // Poison the navigation cache with HTML referencing nonexistent hashed
    // assets — the exact failure mode that bricked the app under SWR. With
    // network-first, the fresh HTML must win on the next load.
    await page.evaluate(async () => {
      const staleHtml = `<!doctype html><html><head>
        <title>STALE</title>
        <link rel="stylesheet" href="/assets/stale-DEADBEEF.css">
        <script type="module" src="/assets/stale-DEADBEEF.js"></script>
      </head><body><div id="stale-marker">STALE</div></body></html>`
      const keys = await caches.keys()
      for (const name of keys) {
        const cache = await caches.open(name)
        const existing = await cache.match('/')
        if (existing) {
          await cache.put('/', new Response(staleHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }))
        }
      }
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.slice[data-mode="jigsaw"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('#stale-marker')).toHaveCount(0)
  })
})

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

test('cached daily puzzle and cached image still open when live requests stall', async ({ page }) => {
  const payload = createTodayPayload()

  await page.route('**/api/puzzles/today**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await expect(page.locator('.slice[data-mode="jigsaw"]')).toBeVisible()

  await page.evaluate(async ({ heroUrl, cachedPayload }) => {
    localStorage.setItem('xefig:daily-cache', JSON.stringify(cachedPayload))
    const response = await fetch(heroUrl)
    const cache = await caches.open('xefig-offline-test')
    await cache.put(heroUrl, response.clone())
  }, { heroUrl: HERO_URL, cachedPayload: payload })

  await page.unroute('**/api/puzzles/today**')
  await page.route('**/api/puzzles/today**', async () => {
    await new Promise(() => {})
  })
  await page.route('**/src/assets/hero.png', async () => {
    await new Promise(() => {})
  })

  await page.reload({ waitUntil: 'domcontentloaded' })

  const jigsawSlice = page.locator('.slice[data-mode="jigsaw"]')
  await expect(jigsawSlice).toBeVisible({ timeout: 7000 })

  if (!(await jigsawSlice.evaluate((element) => element.classList.contains('active')))) {
    await jigsawSlice.click()
  }
  await jigsawSlice.click()

  await expect(page.locator('.jigsaw-root')).toBeVisible({ timeout: 15000 })
})

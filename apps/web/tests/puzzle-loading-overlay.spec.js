import { expect, test } from '@playwright/test'

// Use a distinct URL for the puzzle image so route mocking doesn't
// stall the menu's hero thumbnails (which reference HERO_URL directly).
const HERO_URL = '/src/assets/hero.png'
const PUZZLE_IMG = '/__test/puzzle-image.png'
const PUZZLE_IMG_PATTERN = /\/__test\/puzzle-image\.png/

// 16x16 solid-red PNG, just enough to satisfy the puzzle's decode +
// .naturalWidth / .naturalHeight reads.
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP8z8DAwMDAwsDAwMAwGgIAB4QAk9bKv6MAAAAASUVORK5CYII='
const TEST_PNG_BUFFER = Buffer.from(TEST_PNG_BASE64, 'base64')

function createTodayPayload() {
  const today = new Date().toISOString().slice(0, 10)
  // Jigsaw's full image is PUZZLE_IMG (intercepted by the route mock so
  // the test controls when it resolves / fails). Its thumbnail uses
  // HERO_URL (handled by Vite directly) — that way the overlay's
  // background-image fetch and the menu thumbnail rendering are
  // independent of the test's failure scenarios. Menu's preload loop
  // (main.js:~1731) will fire one extra PUZZLE_IMG request because
  // fullUrl !== thumbUrl, but the menu phase of the router fulfills it.
  return {
    date: today,
    categories: {
      jigsaw: { imageUrl: PUZZLE_IMG, thumbnailUrl: HERO_URL },
      slider: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      swap: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      polygram: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      diamond: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
    },
  }
}

// Single route handler with a mutable phase. Avoids `page.unroute` +
// `page.route` round-trips, which seemed to leave a window where the
// regex-matched URL would fall through to Vite's SPA fallback. Phase
// flips from 'menu' → 'play' once the user activates the slice; the
// play handler is what each test customises.
function createPuzzleRouter() {
  let phase = 'menu'
  let playHandler = null
  const setPlayHandler = (handler) => {
    playHandler = handler
    phase = 'play'
  }
  const handler = async (route) => {
    if (phase === 'menu') {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: TEST_PNG_BUFFER,
      })
      return
    }
    if (typeof playHandler === 'function') {
      await playHandler(route)
      return
    }
    await route.continue()
  }
  return { handler, setPlayHandler }
}

async function setupMenuAndStartJigsaw(page, playHandler) {
  const context = page.context()
  await context.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(createTodayPayload()),
    })
  })

  const router = createPuzzleRouter()
  await context.route(PUZZLE_IMG_PATTERN, router.handler)

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })

  const slice = page.locator('.slice[data-mode="jigsaw"]')
  await expect(slice).toBeVisible({ timeout: 10000 })
  if (!(await slice.evaluate((element) => element.classList.contains('active')))) {
    await slice.click()
  }
  // Give menu thumbnail fetch a moment to settle through the menu phase.
  await page.waitForTimeout(300)
  router.setPlayHandler(playHandler)
  await slice.click()
}

test('shows loading overlay while puzzle image is downloading', async ({ page }) => {
  let releaseImg
  const released = new Promise((resolve) => { releaseImg = resolve })

  await setupMenuAndStartJigsaw(page, async (route) => {
    await released
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TEST_PNG_BUFFER,
    })
  })

  const overlay = page.locator('.puzzle-loading-overlay')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  // While the route is held, setupLayout() can't have run.
  await expect(page.locator('.jigsaw-root')).toHaveCount(0)

  releaseImg()

  await expect(page.locator('.jigsaw-root')).toBeVisible({ timeout: 15000 })
  await expect(overlay).toBeHidden()
})

test('shows error card with retry when image load fails, then recovers', async ({ page }) => {
  // The image-loader tries fetch first, then falls back to a native <img>
  // request — that's two route hits per user-visible attempt. Abort both
  // for the first user attempt; let the third (after Retry) succeed.
  let attempts = 0
  await setupMenuAndStartJigsaw(page, async (route) => {
    attempts += 1
    if (attempts <= 2) {
      await route.abort('failed')
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: TEST_PNG_BUFFER,
      })
    }
  })

  const errorCard = page.locator('.puzzle-loading-overlay.is-error')
  await expect(errorCard).toBeVisible({ timeout: 10000 })
  await expect(errorCard.locator('.puzzle-error-title')).toContainText(/couldn't load/i)

  const retryBtn = errorCard.locator('.puzzle-error-retry')
  await expect(retryBtn).toBeVisible()
  await retryBtn.click()

  await expect(page.locator('.jigsaw-root')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.puzzle-loading-overlay')).toBeHidden()
})

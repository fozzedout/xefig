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

function createTodayPayload({ jigsawThumb = PUZZLE_IMG } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  // Default: jigsaw thumb === image === PUZZLE_IMG. loadImageThumbFirst
  // skips the thumb attempt when the URLs match, so all attempts the
  // route mock sees come from the puzzle's actual play-time loadImage
  // call — the simplest case to reason about for slow / failing scenarios.
  // Tests of the thumb-first happy path override jigsawThumb with a
  // different URL (HERO_URL) so the thumbnail stage is exercised first.
  return {
    date: today,
    categories: {
      jigsaw: { imageUrl: PUZZLE_IMG, thumbnailUrl: jigsawThumb },
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

async function setupMenuAndStartJigsaw(page, playHandler, payloadOptions = {}) {
  const context = page.context()
  await context.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(createTodayPayload(payloadOptions)),
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
  // Each render of the game page triggers up to three PUZZLE_IMG hits:
  //   1. the loading overlay's CSS background-image (thumbnail preview)
  //   2. the puzzle's loadImage fetch
  //   3. its <img> fallback when (2) fails
  // Abort all three to force loadImage to reject so the error card
  // appears. After the user taps Retry, the next round of attempts
  // succeeds and the puzzle loads.
  let attempts = 0
  await setupMenuAndStartJigsaw(page, async (route) => {
    attempts += 1
    if (attempts <= 3) {
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

test('thumb-first: puzzle becomes playable from thumbnail while full image stalls', async ({ page }) => {
  // Distinct thumb (HERO_URL via Vite) and full image (PUZZLE_IMG via
  // route mock) — exercises the thumb-first path. Hold the full image
  // forever; the puzzle should still become playable from the thumb.
  let releaseFull
  const fullReleased = new Promise((resolve) => { releaseFull = resolve })

  await setupMenuAndStartJigsaw(page, async (route) => {
    await fullReleased
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: TEST_PNG_BUFFER,
    })
  }, { jigsawThumb: HERO_URL })

  // Puzzle root must appear from the thumbnail load alone, even though
  // the route mock holds the full image hostage.
  await expect(page.locator('.jigsaw-root')).toBeVisible({ timeout: 10000 })
  // And the loading overlay should NOT be sitting on top — the puzzle
  // is its own loading state.
  await expect(page.locator('.puzzle-loading-overlay')).toBeHidden()

  // Tear down cleanly without leaving a hung route handler.
  releaseFull()
})

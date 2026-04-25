import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const HERO_URL = '/src/assets/hero.png'

function payloadFor(date) {
  return {
    date,
    categories: {
      jigsaw: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      slider: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      swap: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      polygram: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      diamond: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
    },
  }
}

async function mockBaseline(page) {
  await page.route(/\/api\/puzzles\//, async (route) => {
    const url = new URL(route.request().url())
    const m = url.pathname.match(/\/api\/puzzles\/(\d{4}-\d{2}-\d{2})$/)
    const date = m ? m[1] : new Date().toISOString().slice(0, 10)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payloadFor(date)),
    })
  })
  await page.route('**/api/leaderboard**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
}

function yesterdayUtc() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10)
}

test('archive timeline preserves DOM identity across navigation to game and back', async ({ page }) => {
  const yesterday = yesterdayUtc()

  await mockBaseline(page)
  // Seed a saved active jigsaw run for yesterday so the day is NOT collapsed
  // as untouched and we have a clickable thumb that enters the game.
  await page.addInitScript((date) => {
    localStorage.setItem(
      `xefig:run:${date}:jigsaw`,
      JSON.stringify({
        puzzleDate: date,
        gameMode: 'jigsaw',
        imageUrl: '/src/assets/hero.png',
        difficulty: 'medium',
        elapsedActiveMs: 12000,
      }),
    )
  }, yesterday)

  await page.goto('/', { waitUntil: 'networkidle' })

  await page.locator('.slice-more').click()
  await page.locator('.more-sheet-card[data-page="archive"]').click()

  const day = page.locator(`.timeline-day[data-date="${yesterday}"]`)
  await expect(day).toBeVisible({ timeout: 15000 })

  // Tag the day so we can prove DOM identity is preserved across navigation.
  await day.evaluate((el) => el.setAttribute('data-test-tag', 'sentinel'))

  // The resume thumb is visible (day is not untouched because it has an active run).
  const resumeThumb = day.locator('.puzzle-thumb.thumb-resume[data-mode="jigsaw"]')
  await expect(resumeThumb).toBeVisible()
  await resumeThumb.click()

  // The game page renders; tap the in-game back button which calls returnFromGame().
  const backBtn = page.locator('.page-back-btn').first()
  await expect(backBtn).toBeVisible({ timeout: 10000 })
  await backBtn.click({ force: true })

  // Without the archiveRendered=false reset, the same day node must still exist.
  const tagged = page.locator('.timeline-day[data-test-tag="sentinel"]')
  await expect(tagged).toHaveCount(1)
  await expect(tagged).toHaveAttribute('data-date', yesterday)
})

test('seeded completed run renders with thumb-completed pill', async ({ page }) => {
  const yesterday = yesterdayUtc()

  await mockBaseline(page)
  await page.addInitScript((date) => {
    localStorage.setItem(
      'xefig:puzzles:completed:v1',
      JSON.stringify({
        [date]: {
          jigsaw: {
            puzzleDate: date,
            gameMode: 'jigsaw',
            bestElapsedMs: 123456,
            completedAt: new Date().toISOString(),
          },
        },
      }),
    )
  }, yesterday)

  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('.slice-more').click()
  await page.locator('.more-sheet-card[data-page="archive"]').click()

  const day = page.locator(`.timeline-day[data-date="${yesterday}"]`)
  await expect(day).toBeVisible({ timeout: 15000 })

  const completedThumb = day.locator('.puzzle-thumb.thumb-completed[data-mode="jigsaw"]')
  await expect(completedThumb).toBeVisible()
  await expect(completedThumb.locator('.thumb-pill-completed')).toBeVisible()
})

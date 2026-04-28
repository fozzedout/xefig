import { expect, test } from '@playwright/test'

const TODAY = '2026-04-28'

const PAYLOAD = {
  date: TODAY,
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

function makeCompletedRuns(modes) {
  const runs = {}
  for (const mode of modes) {
    runs[mode] = {
      completedAt: `${TODAY}T10:00:00Z`,
      difficulty: 'medium',
      elapsedActiveMs: 120000,
      bestElapsedMs: 120000,
    }
  }
  return { [TODAY]: runs }
}

async function setupPage(page, { completedRuns } = {}) {
  await page.route('**/api/puzzles/*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD) }),
  )
  await page.route('**/api/leaderboard**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }),
  )

  await page.addInitScript(({ completedRuns, today }) => {
    if (completedRuns) {
      localStorage.setItem('xefig:puzzles:completed:v1', JSON.stringify(completedRuns))
    }
    const RealDate = Date
    const fakeNow = new RealDate(`${today}T12:00:00`).getTime()
    globalThis.Date = class extends RealDate {
      constructor(...args) { if (args.length === 0) super(fakeNow); else super(...args) }
      static now() { return fakeNow }
    }
  }, { completedRuns, today: TODAY })

  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('.slice[data-mode]').first().waitFor()
}

async function openArchive(page) {
  await page.locator('.slice-more').click()
  await page.locator('.more-sheet-card[data-page="archive"]').click()
  await expect(page.locator('.cal-region')).toBeVisible({ timeout: 15000 })
}

async function backToPlay(page) {
  await page.locator('.page-back-btn[data-page="play"]').click()
  await page.locator('.slice[data-mode]').first().waitFor()
}

test.describe('archive star reflects all completions', () => {
  test('shows correct arm count after completing puzzles from play page', async ({ page }) => {
    const completed = makeCompletedRuns(['jigsaw', 'sliding', 'swap', 'diamond'])
    await setupPage(page, { completedRuns: completed })
    await openArchive(page)

    const todayGlyph = page.locator(`.day[data-date="${TODAY}"] .glyph`)
    await expect(todayGlyph).toBeVisible()
    await expect(todayGlyph.locator('[data-done="1"]')).toHaveCount(4)
  })

  test('archive refreshes when returning from play page with new completions', async ({ page }) => {
    const initial = makeCompletedRuns(['jigsaw'])
    await setupPage(page, { completedRuns: initial })
    await openArchive(page)

    const todayGlyph = page.locator(`.day[data-date="${TODAY}"] .glyph`)
    await expect(todayGlyph.locator('[data-done="1"]')).toHaveCount(1)

    // Go back to play, simulate completing more puzzles via localStorage
    await backToPlay(page)

    await page.evaluate((today) => {
      const runs = JSON.parse(localStorage.getItem('xefig:puzzles:completed:v1') || '{}')
      runs[today].sliding = {
        completedAt: `${today}T11:00:00Z`,
        difficulty: 'medium',
        elapsedActiveMs: 90000,
        bestElapsedMs: 90000,
      }
      runs[today].swap = {
        completedAt: `${today}T11:05:00Z`,
        difficulty: 'medium',
        elapsedActiveMs: 80000,
        bestElapsedMs: 80000,
      }
      localStorage.setItem('xefig:puzzles:completed:v1', JSON.stringify(runs))
    }, TODAY)

    // Return to archive — should show updated glyphs
    await openArchive(page)
    await expect(todayGlyph.locator('[data-done="1"]')).toHaveCount(3)
  })
})

test.describe('completion overlay progress glyph', () => {
  test('SVG defs are present in DOM on initial load', async ({ page }) => {
    await setupPage(page)
    const defs = page.locator('#xefig-arm')
    await expect(defs).toBeAttached()
  })
})

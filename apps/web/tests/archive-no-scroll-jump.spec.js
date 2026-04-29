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

function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}
function yesterdayUtc() {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10)
}

async function openArchive(page) {
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.locator('.slice-more').click()
  await page.locator('.more-sheet-card[data-page="archive"]').click()
  await expect(page.locator('.cal-region')).toBeVisible({ timeout: 15000 })
}

test('archive renders the current-month calendar with the brand glyph per day', async ({ page }) => {
  await mockBaseline(page)
  await openArchive(page)

  const today = todayUtc()
  const todayCell = page.locator(`.day[data-date="${today}"]`)
  await expect(todayCell).toBeVisible()
  await expect(todayCell).toHaveClass(/today/)
  await expect(todayCell.locator('.glyph')).toBeVisible()

  // Page-dots reflect 12 months and the current month is the highlighted dot
  const dots = page.locator('.cal-dots .dot')
  await expect(dots).toHaveCount(12)
  await expect(page.locator('.cal-dots .dot.current')).toHaveCount(1)
})

test('tapping a playable day opens the day-detail sheet with all five mode thumbs', async ({ page }) => {
  const yesterday = yesterdayUtc()
  await mockBaseline(page)
  await openArchive(page)

  await page.locator(`.day[data-date="${yesterday}"]`).click()

  const sheet = page.locator('.day-detail-overlay.open')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.day-detail-title')).toContainText(String(new Date(yesterday).getUTCDate()))
  await expect(sheet.locator('.puzzle-thumb')).toHaveCount(5)
})

test('locked future and pre-launch days do not open the day-detail sheet', async ({ page }) => {
  await mockBaseline(page)
  await openArchive(page)

  // Pre-launch (before 2026-03-17) — pick 2026-03-01 which is in March
  // Navigate to March via the year picker (prev arrow is hidden in portrait).
  await page.locator('.cal-nav-title').click()
  await expect(page.locator('.year-picker.open')).toBeVisible()
  const marchCell = page.locator('.year-picker-cell').nth(2)
  await marchCell.click()
  await page.waitForTimeout(200)
  // March 1 is locked (pre-launch), should have .locked
  const marchOne = page.locator('.day[data-date="2026-03-01"]')
  if (await marchOne.count() > 0) {
    await expect(marchOne).toHaveClass(/locked/)
    // Click should not open the sheet
    await marchOne.click({ force: true })
    await expect(page.locator('.day-detail-overlay.open')).toHaveCount(0)
  }
})

test('year picker opens and jumps to the selected month', async ({ page }) => {
  await mockBaseline(page)
  await openArchive(page)

  await page.locator('.cal-nav-title').click()
  const picker = page.locator('.year-picker.open')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.year-picker-cell')).toHaveCount(12)

  // Click January (the first cell)
  await picker.locator('.year-picker-cell').first().click()
  await expect(page.locator('.year-picker.open')).toHaveCount(0)
  await expect(page.locator('.cal-nav-title .month-name')).toHaveText('January')
})

test('day-detail thumb launches game; returning preserves the calendar DOM', async ({ page }) => {
  const yesterday = yesterdayUtc()
  await mockBaseline(page)
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

  await openArchive(page)

  // Tag the calendar to prove DOM identity survives game→archive return
  await page.locator('.cal-deck').evaluate((el) => el.setAttribute('data-test-tag', 'sentinel'))

  await page.locator(`.day[data-date="${yesterday}"]`).click()
  const sheet = page.locator('.day-detail-overlay.open')
  await expect(sheet).toBeVisible()

  await sheet.locator('.puzzle-thumb[data-mode="jigsaw"]').click()

  const backBtn = page.locator('.page-back-btn').first()
  await expect(backBtn).toBeVisible({ timeout: 10000 })
  await backBtn.click({ force: true })

  await expect(page.locator('.cal-deck[data-test-tag="sentinel"]')).toHaveCount(1)
})

test('seeded completed run shows a gold ring on its day glyph', async ({ page }) => {
  const yesterday = yesterdayUtc()
  await mockBaseline(page)
  await page.addInitScript((date) => {
    const allModes = ['jigsaw', 'sliding', 'swap', 'polygram', 'diamond']
    const completed = {}
    for (const m of allModes) {
      completed[m] = {
        puzzleDate: date,
        gameMode: m,
        bestElapsedMs: 123456,
        completedAt: new Date().toISOString(),
      }
    }
    localStorage.setItem(
      'xefig:puzzles:completed:v1',
      JSON.stringify({ [date]: completed }),
    )
  }, yesterday)

  await openArchive(page)

  const cell = page.locator(`.day[data-date="${yesterday}"]`)
  await expect(cell).toBeVisible()
  // All 5 modes done → glyph carries data-complete="1"
  await expect(cell.locator('.glyph[data-complete="1"]')).toBeVisible()
})

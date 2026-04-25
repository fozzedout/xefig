import { expect, test } from '@playwright/test'

const HERO_URL = '/src/assets/hero.png'

function todayPayload() {
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

async function mockBaseline(page) {
  await page.route('**/api/puzzles/today**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(todayPayload()),
    })
  })
  await page.route('**/api/leaderboard**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
}

test('More slice opens the sheet and Settings + Archive cards are always present', async ({ page }) => {
  await mockBaseline(page)
  await page.goto('/', { waitUntil: 'networkidle' })

  await page.locator('.slice-more').click()

  const sheet = page.locator('.more-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.more-sheet-card[data-page="settings"]')).toBeVisible()
  await expect(sheet.locator('.more-sheet-card[data-page="archive"]')).toBeVisible()
})

test('Devices card is hidden when sync is disabled, shown when enabled', async ({ page }) => {
  await mockBaseline(page)
  await page.goto('/', { waitUntil: 'networkidle' })

  await page.locator('.slice-more').click()
  await expect(page.locator('.more-sheet')).toBeVisible()
  await expect(page.locator('.more-sheet-card[data-action="share-sync"]')).toHaveCount(0)

  await page.locator('.more-sheet-overlay').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.more-sheet')).toHaveCount(0)

  await page.evaluate(() => {
    localStorage.setItem('xefig:sync:enabled:v1', 'true')
    localStorage.setItem('xefig:sync:share-code:v1', 'ABC234')
  })

  await page.locator('.slice-more').click()
  await expect(page.locator('.more-sheet-card[data-action="share-sync"]')).toBeVisible()
})

test('Backdrop click and ESC close the sheet', async ({ page }) => {
  await mockBaseline(page)
  await page.goto('/', { waitUntil: 'networkidle' })

  await page.locator('.slice-more').click()
  await expect(page.locator('.more-sheet')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.more-sheet')).toHaveCount(0)

  await page.locator('.slice-more').click()
  await expect(page.locator('.more-sheet')).toBeVisible()
  await page.locator('.more-sheet-overlay').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.more-sheet')).toHaveCount(0)
})

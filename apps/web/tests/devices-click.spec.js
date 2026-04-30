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

test('Tapping Devices opens the share-code overlay (with profile name)', async ({ page }) => {
  const errors = []
  page.on('pageerror', (err) => { errors.push(err.message) })

  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(todayPayload()) })
  })
  await page.route('**/api/leaderboard**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  await page.goto('/', { waitUntil: 'networkidle' })

  await page.evaluate(() => {
    localStorage.setItem('xefig:sync:enabled:v1', 'true')
    localStorage.setItem('xefig:sync:share-code:v1', 'ABC234')
    localStorage.setItem('xefig:profile-name:v1', 'Paul <test>')
  })

  await page.locator('.slice-more').click()
  const card = page.locator('.more-sheet-card[data-action="share-sync"]')
  await expect(card).toBeVisible()

  // Cloud overlay (replacement for the old dot) should be visible on the icon.
  const cloud = card.locator('.more-card-sync-cloud')
  await expect(cloud).toBeVisible()
  await expect(cloud).toHaveAttribute('data-state', /saved|syncing|pending|error/)

  await card.click()

  await expect(page.locator('.more-sheet')).toHaveCount(0, { timeout: 2000 })
  await expect(page.locator('.sync-celebrate-overlay')).toBeVisible({ timeout: 2000 })
  await expect(page.locator('.sync-celebrate-title')).toContainText('Paul')

  expect(errors).toEqual([])
})

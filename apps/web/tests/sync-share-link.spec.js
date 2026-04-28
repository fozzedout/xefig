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

function linkResponse(shareCode) {
  return {
    playerGuid: '00000000-0000-4000-8000-000000000001',
    revision: 0,
    shareCode,
    settings: { profileName: 'Shared Player', boardColorIndex: 0 },
    completedRuns: {},
    activeRuns: {},
    deletedActiveRuns: {},
  }
}

async function mockBaseline(page) {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(todayPayload()),
    })
  })
  // Leaderboard / other feeds just return empty arrays so the launcher boots.
  await page.route('**/api/leaderboard**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
}

test('?sync=<code> auto-links the code on boot and clears the query param', async ({ page }) => {
  await mockBaseline(page)

  const linkCalls = []
  await page.route('**/api/sync/link', async (route) => {
    const body = route.request().postDataJSON()
    linkCalls.push(body)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(linkResponse(body.shareCode)),
    })
  })
  // No sync pushes expected but mock so nothing 404s noisily.
  await page.route('**/api/sync/push', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"revision":0}' })
  })
  await page.route('**/api/sync/pull**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: 0, settings: {}, completedRuns: {}, activeRuns: {}, deletedActiveRuns: {} }),
    })
  })

  await page.addInitScript(() => {
    localStorage.setItem('xefig:player-guid:v1', '00000000-0000-4000-8000-000000000002')
  })

  await page.goto('/?sync=ABC234', { waitUntil: 'networkidle' })

  await expect.poll(() => linkCalls.length, { timeout: 7000 }).toBeGreaterThan(0)
  expect(linkCalls[0]).toEqual({ shareCode: 'ABC234' })

  // The share param must be stripped so a reload doesn't re-trigger the link.
  expect(new URL(page.url()).search).toBe('')

  // Sync should now be enabled in localStorage.
  const enabled = await page.evaluate(() => localStorage.getItem('xefig:sync:enabled:v1'))
  expect(enabled).toBe('true')
})

test('?sync=<invalid> is ignored and param is still cleared', async ({ page }) => {
  await mockBaseline(page)
  let linkCalled = false
  await page.route('**/api/sync/link', async (route) => {
    linkCalled = true
    await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"bad code"}' })
  })

  await page.goto('/?sync=bad', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)

  expect(linkCalled).toBe(false)
  expect(new URL(page.url()).search).toBe('')
})

test('More slice share card opens celebration with the share code when sync is enabled', async ({ page }) => {
  await mockBaseline(page)
  await page.route('**/api/sync/push', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"revision":0}' })
  })
  await page.route('**/api/sync/pull**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision: 0, settings: {}, completedRuns: {}, activeRuns: {}, deletedActiveRuns: {} }),
    })
  })

  // Seed a player with sync already enabled and a known code.
  await page.addInitScript(() => {
    localStorage.setItem('xefig:player-guid:v1', '00000000-0000-4000-8000-000000000003')
    localStorage.setItem('xefig:sync:enabled:v1', 'true')
    localStorage.setItem('xefig:sync:share-code:v1', 'XYZ789')
    localStorage.setItem('xefig:sync:revision:v2', '0')
  })

  await page.goto('/', { waitUntil: 'networkidle' })

  // Open the More slice — now triggers a modal sheet rather than expanding inline.
  const moreSlice = page.locator('.slice-more')
  await moreSlice.click()

  const sheet = page.locator('.more-sheet')
  await expect(sheet).toBeVisible()

  const shareCard = sheet.locator('.more-sheet-card[data-action="share-sync"]')
  await expect(shareCard).toBeVisible()
  await expect(shareCard).toContainText('Share with another device')
  await shareCard.click()

  const celebrate = page.locator('.sync-celebrate-overlay')
  await expect(celebrate).toBeVisible()
  await expect(celebrate.locator('.sync-code-value')).toHaveText('XYZ789')
})

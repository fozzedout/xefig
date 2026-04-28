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
  await page.route('**/api/puzzles/*', async (route) => {
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

async function openSettings(page) {
  await page.locator('.slice-more').click()
  await page.locator('.more-sheet-card[data-page="settings"]').click()
  await expect(page.locator('#page-settings.visible, #page-settings:visible')).toBeVisible()
}

test('all six settings sections render', async ({ page }) => {
  await mockBaseline(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await openSettings(page)

  for (const id of ['profile', 'display', 'audio', 'sync', 'about', 'contact']) {
    await expect(page.locator(`#settings-section-${id}`)).toBeVisible()
  }
})

test('volume slider writes xefig:music-volume:v1', async ({ page }) => {
  await mockBaseline(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await openSettings(page)

  // Audio section is collapsed by default — open it.
  const audio = page.locator('#settings-section-audio')
  await audio.locator('summary').click()

  const slider = audio.locator('#settings-music-volume')
  await expect(slider).toBeVisible()
  // dispatch an input event with a known value
  await slider.evaluate((el) => {
    el.value = '0.42'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await expect.poll(async () =>
    page.evaluate(() => localStorage.getItem('xefig:music-volume:v1')),
  ).toBe('0.42')
})

test('section open state persists across reload', async ({ page }) => {
  await mockBaseline(page)
  await page.goto('/', { waitUntil: 'networkidle' })
  await openSettings(page)

  // Profile is open by default. Toggle Audio open and Profile closed.
  await page.locator('#settings-section-audio summary').click()
  await page.locator('#settings-section-profile summary').click()

  await expect.poll(async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('xefig:settings:open-sections:v1')
      return raw ? JSON.parse(raw) : null
    }),
  ).toEqual(expect.arrayContaining(['audio']))

  await page.reload({ waitUntil: 'networkidle' })
  await openSettings(page)

  await expect(page.locator('#settings-section-audio')).toHaveAttribute('open', '')
  await expect(page.locator('#settings-section-profile')).not.toHaveAttribute('open', '')
})

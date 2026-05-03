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

async function setup(page) {
  await page.route('**/api/puzzles/*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(todayPayload()) }),
  )
  await page.route('**/api/leaderboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
}

async function openDisplaySettings(page) {
  await page.locator('.slice-more').click()
  await page.waitForTimeout(300)
  await page.locator('.more-sheet-card[data-page="settings"]').click()
  await page.waitForTimeout(400)
  await page.locator('#settings-section-display summary').click()
  await page.waitForTimeout(200)
}

test('manual light overrides system dark', async ({ browser }) => {
  // Start with system dark
  const ctx = await browser.newContext({ colorScheme: 'dark' })
  const page = await ctx.newPage()
  await setup(page)
  await page.goto('/', { waitUntil: 'networkidle' })

  // Confirm initial state: data-theme=dark (matches system)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')

  await openDisplaySettings(page)
  await page.locator('.settings-theme-option[data-theme-pref="light"]').click()
  await page.waitForTimeout(150)

  // After click: data-theme should be "light" even though system is dark
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  expect(await page.evaluate(() => localStorage.getItem('xefig:theme:v1'))).toBe('light')

  // body bg flipped to light
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const m = bg.match(/rgba?\(([^)]+)\)/)
  const avg = m ? m[1].split(',').slice(0, 3).map((v) => Number(v.trim())).reduce((a, b) => a + b, 0) / 3 : null
  expect(avg).toBeGreaterThan(200)

  await ctx.close()
})

test('manual dark overrides system light', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'light' })
  const page = await ctx.newPage()
  await setup(page)
  await page.goto('/', { waitUntil: 'networkidle' })

  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')

  await openDisplaySettings(page)
  await page.locator('.settings-theme-option[data-theme-pref="dark"]').click()
  await page.waitForTimeout(150)

  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  expect(await page.evaluate(() => localStorage.getItem('xefig:theme:v1'))).toBe('dark')

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const m = bg.match(/rgba?\(([^)]+)\)/)
  const avg = m ? m[1].split(',').slice(0, 3).map((v) => Number(v.trim())).reduce((a, b) => a + b, 0) / 3 : null
  expect(avg).toBeLessThan(40)

  await ctx.close()
})

test('auto resolves to system pref', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' })
  const page = await ctx.newPage()
  await setup(page)
  // Pre-set a manual theme in localStorage so we can assert that switching
  // back to "auto" actually does follow the system pref.
  await page.addInitScript(() => localStorage.setItem('xefig:theme:v1', 'light'))
  await page.goto('/', { waitUntil: 'networkidle' })

  // Initial: manual=light wins over system=dark
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')

  await openDisplaySettings(page)
  await page.locator('.settings-theme-option[data-theme-pref="auto"]').click()
  await page.waitForTimeout(150)

  // After auto: should follow system (dark)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark')
  expect(await page.evaluate(() => localStorage.getItem('xefig:theme:v1'))).toBe('auto')

  await ctx.close()
})

test('default pref is auto (no localStorage value)', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'light' })
  const page = await ctx.newPage()
  await setup(page)
  await page.goto('/', { waitUntil: 'networkidle' })

  // No saved pref → "auto" → resolved from system (light)
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  expect(await page.evaluate(() => localStorage.getItem('xefig:theme:v1'))).toBeNull()

  await openDisplaySettings(page)
  // The "Auto" button should be the selected one
  const autoSelected = await page.evaluate(() => {
    const btn = document.querySelector('.settings-theme-option[data-theme-pref="auto"]')
    return btn?.classList.contains('is-selected')
  })
  expect(autoSelected).toBe(true)

  await ctx.close()
})

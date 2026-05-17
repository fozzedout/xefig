import { devices, expect, test } from '@playwright/test'

// Match the user-reported viewport: iPhone SE 2nd-gen, 375×667. Playwright's
// devices['iPhone SE'] is the older 320×568, which actually fit fine.
test.use({
  viewport: { width: 375, height: 667 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
})

const TODAY_PAYLOAD = {
  date: '2026-05-16',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

test('slider board fits the iPhone SE viewport during tutorial', async ({ page }) => {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  const slice = page.locator('.slice[data-mode="sliding"]')
  await slice.waitFor()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()

  await page.locator('.sliding-tile').first().waitFor()

  const before = await page.evaluate(() => {
    const board = document.querySelector('.sliding-board')
    const rect = board.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
  })
  console.log('board before tutorial:', before)
  await page.screenshot({ path: 'test-results/slider-se-before.png' })

  // Open tutorial and step into the corner-marker step.
  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#how-to-play-btn').click()
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible({ timeout: 4000 })
  await page.locator('.assistant-tutorial-bubble').click()
  await page.locator('.assistant-tutorial-bubble').click()
  await expect(page.locator('.sliding-gap-marker.is-highlighted')).toBeVisible({ timeout: 4000 })

  const during = await page.evaluate(() => {
    const board = document.querySelector('.sliding-board')
    const rect = board.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
  })
  console.log('board during tutorial:', during)
  await page.screenshot({ path: 'test-results/slider-se-during.png' })

  expect(during.left).toBeGreaterThanOrEqual(0)
  expect(during.right).toBeLessThanOrEqual(during.vw + 1)
  expect(during.bottom).toBeLessThanOrEqual(during.vh + 1)
})

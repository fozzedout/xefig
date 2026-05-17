import { expect, test } from '@playwright/test'

test.use({
  viewport: { width: 667, height: 375 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
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

test('slider SE landscape — opens and step through tutorial', async ({ page }) => {
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

  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#how-to-play-btn').click()
  await page.locator('.assistant-tutorial-bubble').click()
  await page.locator('.assistant-tutorial-bubble').click()
  await expect(page.locator('.sliding-gap-marker.is-highlighted')).toBeVisible({ timeout: 4000 })

  const layout = await page.evaluate(() => {
    const board = document.querySelector('.sliding-board')
    const rect = board.getBoundingClientRect()
    const tile = document.querySelector('.sliding-tile')
    return {
      board: { w: rect.width, h: rect.height, l: rect.left, r: rect.right, t: rect.top, b: rect.bottom },
      vw: window.innerWidth,
      vh: window.innerHeight,
      tileSize: tile ? tile.getBoundingClientRect().width : null,
    }
  })
  console.log('landscape layout:', layout)
  await page.screenshot({ path: 'test-results/slider-se-landscape.png' })
})

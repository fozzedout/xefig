import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-03-23',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

test('jigsaw board uses most of the available board frame in immersive desktop layout', async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 980 })

  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })

  const slice = page.locator('.slice[data-mode="jigsaw"]')
  await slice.waitFor()
  if (!(await slice.evaluate((element) => element.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()

  await page.locator('.jigsaw-root').waitFor()

  const layout = await page.evaluate(() => {
    const stage = document.querySelector('.jigsaw-stage')?.getBoundingClientRect()
    const floatingMenuButton = document.querySelector('#menu-btn')
    const toolbar = document.querySelector('.game-toolbar')
    if (!stage) return null
    return {
      stageCoversViewport: stage.width >= window.innerWidth && stage.height >= window.innerHeight,
      hasFloatingMenuButton: Boolean(floatingMenuButton),
      hasToolbar: Boolean(toolbar),
    }
  })

  expect(layout).not.toBeNull()
  expect(layout.stageCoversViewport).toBe(true)
  expect(layout.hasFloatingMenuButton).toBe(true)
  expect(layout.hasToolbar).toBe(false)
})

test('jigsaw portrait board fits within the viewport (no bottom-row cutoff)', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })

  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })

  const slice = page.locator('.slice[data-mode="jigsaw"]')
  await slice.waitFor()
  if (!(await slice.evaluate((element) => element.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()

  await page.locator('.jigsaw-root').waitFor()
  // Board dimensions are set after the image loads; wait until the
  // stage-content has a real height before measuring.
  await expect
    .poll(async () => page.locator('.jigsaw-stage-content').evaluate((el) => el.getBoundingClientRect().height))
    .toBeGreaterThan(0)

  const geo = await page.evaluate(() => {
    const content = document.querySelector('.jigsaw-stage-content')?.getBoundingClientRect()
    const carousel = document.querySelector('.jigsaw-carousel')?.getBoundingClientRect()
    if (!content || !carousel) return null
    return {
      boardTop: content.top,
      boardBottom: content.bottom,
      carouselBottom: carousel.bottom,
      viewportHeight: window.innerHeight,
    }
  })

  expect(geo).not.toBeNull()
  // The bug: the board overflowed the bottom edge, clipping the last row
  // off-screen. calculateBoardSize now *measures* the tray's bottom rather
  // than predicting it from CSS paddings, so the board lands flush — its
  // bottom on the viewport edge and its top on the carousel's bottom, with
  // no clip and no wasted gap (within sub-pixel rounding).
  expect(geo.boardBottom).toBeLessThanOrEqual(geo.viewportHeight + 1)
  expect(geo.viewportHeight - geo.boardBottom).toBeLessThanOrEqual(4)
  expect(Math.abs(geo.boardTop - geo.carouselBottom)).toBeLessThanOrEqual(2)
})

test('jigsaw immersive controls fade when idle and reappear on interaction', async ({ page }) => {
  await page.setViewportSize({ width: 1720, height: 980 })

  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })

  const slice = page.locator('.slice[data-mode="jigsaw"]')
  await slice.waitFor()
  if (!(await slice.evaluate((element) => element.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()

  await page.locator('.jigsaw-root').waitFor()

  await page.waitForTimeout(3000)
  const hiddenOpacity = await page.locator('.floating-game-controls').evaluate((element) => {
    return Number(window.getComputedStyle(element).opacity)
  })
  expect(hiddenOpacity).toBeGreaterThan(0.2)
  expect(hiddenOpacity).toBeLessThan(0.4)

  await page.locator('.workspace').click({ position: { x: 240, y: 240 } })

  await expect
    .poll(async () => page.locator('.floating-game-controls').evaluate((element) => {
      return Number(window.getComputedStyle(element).opacity)
    }))
    .toBeGreaterThan(0.9)
})

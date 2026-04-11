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

async function openGame(page, mode, readySelector) {
  await page.setViewportSize({ width: 568, height: 320 })

  await page.route('**/api/puzzles/today**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })

  const slice = page.locator(`.slice[data-mode="${mode}"]`)
  await slice.waitFor()

  if (!(await slice.evaluate((element) => element.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  await page.locator(readySelector).waitFor()
}

test('jigsaw uses a right-side tray on landscape mobile', async ({ page }) => {
  await openGame(page, 'jigsaw', '.jigsaw-root')

  const layout = await page.evaluate(() => {
    const board = document.querySelector('.jigsaw-board-frame')?.getBoundingClientRect()
    const tray = document.querySelector('.jigsaw-carousel')?.getBoundingClientRect()
    if (!board || !tray) return null
    return {
      boardRight: board.right,
      trayLeft: tray.left,
      trayHeight: tray.height,
      trayWidth: tray.width,
      viewportWidth: window.innerWidth,
    }
  })

  expect(layout).not.toBeNull()
  expect(layout.trayLeft).toBeGreaterThanOrEqual(layout.boardRight - 2)
  expect(layout.trayWidth).toBeLessThan(layout.viewportWidth * 0.35)
})

test('polygram uses a right-side tray on landscape mobile', async ({ page }) => {
  await openGame(page, 'polygram', '.polygram-root')

  const layout = await page.evaluate(() => {
    const board = document.querySelector('.polygram-board-wrap')?.getBoundingClientRect()
    const tray = document.querySelector('.polygram-tray')?.getBoundingClientRect()
    if (!board || !tray) return null
    return {
      boardRight: board.right,
      trayLeft: tray.left,
      trayHeight: tray.height,
      trayWidth: tray.width,
      viewportWidth: window.innerWidth,
    }
  })

  expect(layout).not.toBeNull()
  expect(layout.trayLeft).toBeGreaterThanOrEqual(layout.boardRight - 2)
  expect(layout.trayWidth).toBeLessThan(layout.viewportWidth * 0.35)
})

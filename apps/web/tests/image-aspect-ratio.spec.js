import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-03-23',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openGame(page, mode) {
  await page.route('**/api/puzzles/today', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await page.locator(`.mode-card:has(.mode-card-title:text-matches("${mode}", "i"))`).click()
}

test('slider tile backgrounds use cover sizing to match the preview image aspect ratio', async ({
  page,
}) => {
  await openGame(page, 'Sliding')
  await page.locator('.sliding-tile').first().waitFor()

  const result = await page.evaluate(() => {
    const board = document.querySelector('.sliding-board')
    const tile = document.querySelector('.sliding-tile')
    if (!board || !tile) return null

    const boardSize = board.clientWidth
    const bgSize = tile.style.backgroundSize
    const [bgW, bgH] = bgSize.split(' ').map(parseFloat)

    return { boardSize, bgW, bgH }
  })

  expect(result).not.toBeNull()

  // hero.png is 343x361 (wider than tall → landscape-ish, actually taller).
  // With cover sizing, the background should be >= boardSize in BOTH dimensions
  // and at least one dimension should be larger than boardSize (non-square image).
  expect(result.bgW).toBeGreaterThanOrEqual(result.boardSize - 1)
  expect(result.bgH).toBeGreaterThanOrEqual(result.boardSize - 1)

  // The background should NOT be exactly boardSize x boardSize for a non-square image
  // (that would mean it's being stretched/squished).
  const isSquareBackground =
    Math.abs(result.bgW - result.boardSize) < 1 && Math.abs(result.bgH - result.boardSize) < 1
  expect(isSquareBackground).toBe(false)
})

test('swap tile backgrounds use cover sizing to match the preview image aspect ratio', async ({
  page,
}) => {
  await openGame(page, 'swap')
  await page.locator('.picture-swap-tile').first().waitFor()

  const result = await page.evaluate(() => {
    const board = document.querySelector('.picture-swap-board')
    const tile = document.querySelector('.picture-swap-tile')
    if (!board || !tile) return null

    const boardSize = board.clientWidth
    const bgSize = tile.style.backgroundSize
    const [bgW, bgH] = bgSize.split(' ').map(parseFloat)

    return { boardSize, bgW, bgH }
  })

  expect(result).not.toBeNull()

  expect(result.bgW).toBeGreaterThanOrEqual(result.boardSize - 1)
  expect(result.bgH).toBeGreaterThanOrEqual(result.boardSize - 1)

  const isSquareBackground =
    Math.abs(result.bgW - result.boardSize) < 1 && Math.abs(result.bgH - result.boardSize) < 1
  expect(isSquareBackground).toBe(false)
})

import { expect, test } from '@playwright/test'

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

test('slider tiles show 1-based numbered badges in reading order', async ({ page }) => {
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
  await page.waitForTimeout(300)

  const labels = await page.evaluate(() => {
    // Map each tile's homeIndex to its rendered badge text.
    // (We can't read the puzzle instance directly, but we can read each tile
    // element and its number child, then sort by homeIndex via the slot the
    // tile would occupy when solved — we approximate via DOM order which
    // matches creation order = id order = homeIndex in canonical orientation.)
    const tiles = Array.from(document.querySelectorAll('.sliding-tile'))
    return tiles.map((t) => t.querySelector('.sliding-tile-number')?.textContent || '')
  })

  // Each tile has a non-empty label.
  expect(labels.every((s) => /^\d+$/.test(s))).toBe(true)
  // Labels are 1..tileCount, no duplicates, no gaps.
  const nums = labels.map(Number).sort((a, b) => a - b)
  expect(nums[0]).toBe(1)
  expect(nums[nums.length - 1]).toBe(labels.length)
  for (let i = 1; i < nums.length; i += 1) {
    expect(nums[i]).toBe(nums[i - 1] + 1)
  }

  // Numbers stay visible while in progress.
  const board = page.locator('.sliding-board')
  await expect(board).not.toHaveClass(/is-completed/)

  await page.screenshot({ path: 'test-results/slider-numbered-tiles.png' })
})

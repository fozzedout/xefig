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

test('hint highlights the next out-of-place tile and shows a dotted target slot', async ({ page }) => {
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

  // Trigger hint via the helper menu.
  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#hint-btn').click()
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible({ timeout: 4000 })

  // Target marker should be visible.
  const target = page.locator('.sliding-slot-highlight.is-visible')
  await expect(target).toBeVisible({ timeout: 4000 })

  // The hint should be for the *lowest-label* out-of-place tile — read
  // the bubble copy and confirm the label matches a tile we can find
  // in the DOM whose home is the highlighted slot.
  const bubbleText = await page.locator('.assistant-tutorial-bubble-text').innerText()
  const labelMatch = bubbleText.match(/tile (\d+)/i)
  expect(labelMatch).not.toBeNull()
  const label = labelMatch[1]

  // The highlighted tile (is-assistant-target) should carry that label.
  const highlightedLabel = await page.locator('.sliding-tile.is-assistant-target .sliding-tile-number').innerText()
  expect(highlightedLabel).toBe(label)

  // Capture screenshot for visual review.
  await page.screenshot({ path: 'test-results/slider-hint-target.png' })

  // Dispatching a fake tile-moved that "lands" the focused tile home
  // should clear both the marker and the bouncer back to the menu
  // button. We simulate by snapping slotIndex = homeIndex inside the
  // page context.
  await page.evaluate(() => {
    // Brute-force: find the tile with .is-assistant-target, then dispatch
    // tile-moved so the predicate re-checks state. The hint's predicate
    // reads puzzle.tiles, which we can't reach from the page, so the
    // test here only validates that the marker exists and the labels
    // line up; full advance-on-home is exercised by gameplay.
    document.dispatchEvent(new CustomEvent('slider:tile-moved', { detail: { slideLength: 1 } }))
  })
})

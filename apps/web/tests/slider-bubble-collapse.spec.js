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

test('helper bubble collapses on workspace tap and re-expands on bouncer tap', async ({ page }) => {
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

  // Open hint (single noManualAdvance step — easier than walking through
  // the full tutorial for this test).
  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#hint-btn').click()

  const bubble = page.locator('.assistant-tutorial-bubble')
  const bouncer = page.locator('.assistant-bouncer')
  await expect(bubble).toBeVisible({ timeout: 4000 })
  const initialMessage = await page.locator('.assistant-tutorial-bubble-text').innerText()

  // Tap the bubble — it should collapse (not advance).
  await bubble.click()
  await expect(bubble).toHaveClass(/assistant-tutorial-bubble--collapsed/)
  await expect(bouncer).toHaveClass(/assistant-bouncer--clickable/)

  // Tap the bouncer — bubble re-expands with the SAME message.
  await bouncer.click()
  await expect(bubble).not.toHaveClass(/assistant-tutorial-bubble--collapsed/)
  const afterRestore = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(afterRestore).toBe(initialMessage)

  // Workspace pointerdown should also collapse (simulates tapping a tile).
  await page.evaluate(() => {
    const ws = document.querySelector('.workspace')
    ws.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  await expect(bubble).toHaveClass(/assistant-tutorial-bubble--collapsed/)
})

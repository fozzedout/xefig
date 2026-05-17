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

test('slider tutorial: gap marker highlights, timer hides, slide advances step', async ({ page }) => {
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

  // Kick off the tutorial.
  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#how-to-play-btn').click()
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible({ timeout: 4000 })

  // Timer should be hidden across every mode (display:none, not just
  // during the helper flow).
  const timer = page.locator('#timer')
  await expect(timer).toHaveCSS('display', 'none')

  // Step 1 = welcome, step 2 = general goal explanation (no marker
  // highlight). Step 3 is the gap-marker info step; need two bubble
  // taps to reach it.
  await page.locator('.assistant-tutorial-bubble').click()
  await page.locator('.assistant-tutorial-bubble').click()
  await expect(page.locator('.sliding-gap-marker.is-highlighted')).toBeVisible({ timeout: 4000 })
  await page.screenshot({ path: 'test-results/slider-tutorial-gap-highlighted.png' })

  // The gap-marker step is informational ("not a tile") — tap the bubble
  // to move to the first action step (tap an adjacent tile).
  await page.locator('.assistant-tutorial-bubble').click()
  await expect(page.locator('.sliding-gap-marker.is-highlighted')).toHaveCount(0, { timeout: 4000 })

  // Action step 1: any tile-moved advances.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('slider:tile-moved', {
      detail: { slideLength: 1 },
    }))
  })

  // Multi-tile step: length-1 should NOT advance, length-2+ should.
  await page.waitForTimeout(150)
  const messageBeforeMulti = await page.locator('.assistant-tutorial-bubble-text').innerText()
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('slider:tile-moved', {
      detail: { slideLength: 1 },
    }))
  })
  await page.waitForTimeout(150)
  expect(await page.locator('.assistant-tutorial-bubble-text').innerText()).toBe(messageBeforeMulti)

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('slider:tile-moved', {
      detail: { slideLength: 2 },
    }))
  })
  await page.waitForTimeout(200)
  const messageAfterMulti = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(messageAfterMulti).not.toBe(messageBeforeMulti)
  expect(messageAfterMulti.toLowerCase()).toMatch(/double-tap|peek/)

  // Reference-toggle visible=true advances; visible=false then advances
  // through the "single-tap to hide" step.
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('slider:reference-toggled', {
      detail: { visible: true },
    }))
  })
  await page.waitForTimeout(200)
  const hideText = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(hideText.toLowerCase()).toMatch(/single-tap|hide/)

  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('slider:reference-toggled', {
      detail: { visible: false },
    }))
  })
  await page.waitForTimeout(200)
  const afterHide = await page.locator('.assistant-tutorial-bubble-text').innerText()
  // Either the guided-placement step ("get tile 1...") or the final pep
  // talk, depending on whether tile 1 happens to be home in the shuffle.
  expect(afterHide.toLowerCase()).toMatch(/tile 1|top-left|keep going/)
})

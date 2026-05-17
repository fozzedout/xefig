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

test('slider has the rosette helper button, how-to-play, and hint items', async ({ page }) => {
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

  // Menu button should be the rosette (assistant) variant.
  const menuBtn = page.locator('#menu-btn')
  await expect(menuBtn).toHaveClass(/gt-icon-btn--assistant/)
  await expect(menuBtn.locator('.assistant-logo')).toBeVisible()

  // Open menu, verify How to play + hint items present. Force-click
  // because the auto-nudge bounces the button.
  await menuBtn.click({ force: true })
  await expect(page.locator('#how-to-play-btn')).toBeVisible()
  await expect(page.locator('#hint-btn')).toBeVisible()

  // Click How to play — bouncer + tutorial bubble should appear.
  await page.locator('#how-to-play-btn').click()
  await expect(page.locator('.assistant-bouncer')).toBeVisible({ timeout: 4000 })
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible()
  await page.screenshot({ path: 'test-results/slider-assistant-tutorial.png' })

  // Bubble should reference the slider verb set.
  const text = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(text.toLowerCase()).toMatch(/slider|numbered|tile/)
})

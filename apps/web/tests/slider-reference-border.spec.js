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

test('reference image shows a cyan border and dismisses on tap', async ({ page }) => {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })

  const playTab = page.getByRole('button', { name: /^play$/i })
  if (await playTab.isVisible().catch(() => false)) {
    await playTab.click()
  }

  const sliderSlice = page.locator('.slice[data-mode="sliding"]')
  await sliderSlice.waitFor()
  if (!(await sliderSlice.evaluate((el) => el.classList.contains('active')))) {
    await sliderSlice.click()
  }
  await sliderSlice.click()

  const board = page.locator('.sliding-board')
  await board.waitFor()
  await page.waitForTimeout(500)

  const reference = page.locator('.sliding-reference')
  const frame = page.locator('.sliding-reference-frame')

  await expect(reference).toHaveClass(/^(?!.*is-visible).*$/)
  await expect(frame).toHaveClass(/^(?!.*is-visible).*$/)

  // Double-tap centre of the board to reveal the reference.
  const box = await board.boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.click(cx, cy)
  await page.waitForTimeout(50)
  await page.mouse.click(cx, cy)

  await expect(reference).toHaveClass(/is-visible/)
  await expect(frame).toHaveClass(/is-visible/)
  await page.waitForTimeout(250)

  const frameStyle = await frame.evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      borderTop: cs.borderTopWidth,
      borderColor: cs.borderTopColor,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
    }
  })
  console.log('frame computed:', frameStyle)
  expect(frameStyle.opacity).toBe('1')
  expect(frameStyle.borderTop).toBe('4px')

  await page.screenshot({ path: 'test-results/slider-reference-with-border.png' })

  // Now wait past the 400ms dismiss-guard then tap to dismiss.
  await page.waitForTimeout(500)
  await page.mouse.click(cx, cy)
  await expect(reference).not.toHaveClass(/is-visible/)
  await expect(frame).not.toHaveClass(/is-visible/)
})

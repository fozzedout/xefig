import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-05-19',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openDiamond(page) {
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
  const slice = page.locator('.slice[data-mode="diamond"]')
  await slice.waitFor()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  // Wait for the palette to render — the tutorial needs swatches.
  await page.locator('.diamond-palette-bar .diamond-swatch').first().waitFor()
}

test('diamond tutorial: launches, highlights a swatch, advances on diamond:* events', async ({ page }) => {
  await openDiamond(page)

  // Menu uses the assistant rosette icon now, same as the other modes.
  // Pre-check: the menu button carries the assistant class so the rosette
  // is rendered (consistency with jigsaw/swap/slider/polygram).
  await expect(page.locator('#menu-btn.gt-icon-btn--assistant')).toBeVisible()

  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#how-to-play-btn').click()
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible({ timeout: 4000 })

  // Step 1 = welcome, step 2 = goal (board target). Tap bubble twice to
  // reach the swatch step.
  await page.locator('.assistant-tutorial-bubble').click()
  await page.locator('.assistant-tutorial-bubble').click()

  // A swatch should now carry the hint ring.
  const highlighted = page.locator('.diamond-swatch.is-hint-target')
  await expect(highlighted).toHaveCount(1, { timeout: 4000 })

  // Read the highlighted swatch's color number (1-based label on the
  // button) and verify the bubble references the same number.
  const colorNumber = await highlighted.innerText()
  const stepText = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(stepText).toContain(`colour ${colorNumber}`)

  // Inferred colour index (0-based) = label - 1.
  const colorIndex = parseInt(colorNumber, 10) - 1

  // Wrong colour should NOT advance — dispatch a color-selected with the
  // wrong index and confirm the highlight + message stay put.
  await page.evaluate((wrongIndex) => {
    document.dispatchEvent(new CustomEvent('diamond:color-selected', {
      detail: { colorIndex: wrongIndex, changed: true },
    }))
  }, colorIndex === 0 ? 1 : 0)
  await page.waitForTimeout(150)
  await expect(highlighted).toHaveCount(1)

  // Correct colour advances — message should pivot from "tap colour X" to
  // the zoom-info step (which is now the gate before fill so the player
  // can actually see the cell numbers).
  await page.evaluate((idx) => {
    document.dispatchEvent(new CustomEvent('diamond:color-selected', {
      detail: { colorIndex: idx, changed: true },
    }))
  }, colorIndex)
  await page.waitForTimeout(200)
  const zoomStepText = await page.locator('.assistant-tutorial-bubble-text').innerText()
  // iPhone 12 (mobile-chromium) has no fine pointer, so the touch copy is
  // what's served. Zoom step mentions pinch but NOT pan (that's the next
  // step's job).
  expect(zoomStepText.toLowerCase()).toMatch(/pinch/)
  expect(zoomStepText.toLowerCase()).not.toMatch(/drag/)
  // Swatch highlight should have been cleared by the previous step's
  // cleanup hook.
  await expect(page.locator('.diamond-swatch.is-hint-target')).toHaveCount(0)

  // Click bubble to advance to the pan step.
  await page.locator('.assistant-tutorial-bubble').click()
  await page.waitForTimeout(150)
  const panStepText = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(panStepText.toLowerCase()).toMatch(/drag with one finger|pan/)

  // Click bubble again to advance to the fill step. Wrong-colour
  // reassurance is folded INTO this step's copy now (so the player has
  // expectations set BEFORE they tap, not corrected afterwards).
  await page.locator('.assistant-tutorial-bubble').click()
  await page.waitForTimeout(150)
  const fillStepText = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(fillStepText.toLowerCase()).toMatch(/tap any cell|number \d+/)
  expect(fillStepText.toLowerCase()).toMatch(/flash|red/)

  // Fire a cell-filled event for the matching colour — advances straight
  // to the final pep-talk step. The reference-image steps were dropped
  // (paint-by-numbers gameplay didn't need a guided peek at the source).
  await page.evaluate((idx) => {
    document.dispatchEvent(new CustomEvent('diamond:cell-filled', {
      detail: { colorIndex: idx, cellIndex: 0, cellCount: 1 },
    }))
  }, colorIndex)
  await page.waitForTimeout(200)
  const finalStep = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(finalStep.toLowerCase()).toMatch(/nice work|one colour at a time/)
  // And the reference-image step is gone — neither "finished picture"
  // nor "eye" should appear anywhere in the tutorial after the fill.
  expect(finalStep.toLowerCase()).not.toMatch(/finished picture|tap the eye/)
})

test('diamond tutorial step 2: bouncer lands at the painting-area centre', async ({ page }) => {
  await openDiamond(page)

  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#how-to-play-btn').click()
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible({ timeout: 4000 })

  // Welcome (step 1) → tap to reach the goal step (step 2 — centred on
  // the board frame).
  await page.locator('.assistant-tutorial-bubble').click()
  await page.waitForTimeout(500) // let the bouncer animate to its target

  const offset = await page.evaluate(() => {
    const bouncer = document.querySelector('.assistant-bouncer')
    const frame = document.querySelector('.diamond-board-frame')
    if (!bouncer || !frame) return null
    const bRect = bouncer.getBoundingClientRect()
    const fRect = frame.getBoundingClientRect()
    return {
      bouncerCx: bRect.left + bRect.width / 2,
      bouncerCy: bRect.top + bRect.height / 2,
      frameCx: fRect.left + fRect.width / 2,
      frameCy: fRect.top + fRect.height / 2,
    }
  })
  expect(offset).not.toBeNull()
  // ±15px tolerance — the bouncer's inner mark runs an infinite hop
  // (translateY up to -14px) and a scale that subtly inflates the visual
  // bounding rect even though the underlying 60×60 container holds steady.
  // 15px keeps us well inside "visually centred" while staying robust to
  // whatever phase of the hop the measurement happens to catch.
  expect(Math.abs(offset.bouncerCx - offset.frameCx)).toBeLessThan(15)
  expect(Math.abs(offset.bouncerCy - offset.frameCy)).toBeLessThan(15)
})

test('diamond hint: highlights a swatch and references its number in copy', async ({ page }) => {
  await openDiamond(page)

  await page.locator('#menu-btn').click({ force: true })
  await page.locator('#hint-btn').click()
  await expect(page.locator('.assistant-tutorial-bubble')).toBeVisible({ timeout: 4000 })

  // Hint should immediately surface the suggested swatch with its number
  // mentioned in the copy.
  const highlighted = page.locator('.diamond-swatch.is-hint-target')
  await expect(highlighted).toHaveCount(1, { timeout: 4000 })
  const colorNumber = await highlighted.innerText()
  const text = await page.locator('.assistant-tutorial-bubble-text').innerText()
  expect(text).toContain(`colour ${colorNumber}`)
})

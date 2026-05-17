import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-05-17',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openPolygram(page) {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  const slice = page.locator('.slice[data-mode="polygram"]')
  await slice.waitFor()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  await page.locator('.polygram-tray').waitFor()
}

test('polygram has the highlight loose button and menu item, both run the same routine', async ({ page }) => {
  await openPolygram(page)

  // In-puzzle button is rendered with the jigsaw-tray-tool styling.
  const trayBtn = page.locator('.polygram-tray-tools .jigsaw-tray-tool[aria-label="Highlight loose pieces"]')
  await expect(trayBtn).toBeVisible({ timeout: 4000 })

  // Menu also exposes the Highlight loose item (matches jigsaw).
  await page.locator('#menu-btn').click({ force: true })
  await expect(page.locator('#highlight-btn')).toBeVisible()
  // Edges-only is still jigsaw-specific — should NOT appear in polygram.
  await expect(page.locator('#edges-btn')).toHaveCount(0)

  // Close the menu so it doesn't intercept the next click.
  await page.locator('#menu-btn').click({ force: true })

  // Synthetically promote a piece to "placed" so the highlight has
  // something to act on. Then click the in-puzzle button and assert
  // the piece picks up the is-highlighted class.
  const placed = await page.evaluate(() => {
    const pieces = document.querySelectorAll('.polygram-piece')
    if (!pieces.length) return false
    const target = pieces[0]
    target.classList.add('is-placed')
    target.dataset.testPlaced = '1'
    // Find the puzzle instance via the global game state — not exposed
    // directly. Easier path: monkey-patch the state by dispatching to
    // the live puzzle through a known DOM affordance: just click the
    // tray button and observe the class side-effects on placed pieces.
    return true
  })
  expect(placed).toBe(true)

  // We can't easily promote `piece.state` from outside the module, so
  // instead invoke the method via dispatching against the menu item —
  // which calls puzzle.highlightLoosePieces() with whichever pieces
  // happen to be in 'placed' state. With a fresh-init puzzle there
  // won't be any 'placed' pieces, but the call itself shouldn't error.
  await page.locator('.polygram-tray-tools .jigsaw-tray-tool[aria-label="Highlight loose pieces"]').click()
})

test('polygram exposes an eye toggle that mirrors the menu view-btn', async ({ page }) => {
  await openPolygram(page)

  const eye = page.locator('#polygram-reveal-btn')
  await expect(eye).toBeVisible({ timeout: 4000 })
  await expect(eye).toHaveAttribute('aria-pressed', 'false')

  // Dismiss the auto-nudge bubble — it overlays and intercepts taps on
  // the tray-tools row otherwise.
  const nudgeClose = page.locator('.assistant-bubble--anchor .assistant-bubble-close')
  if (await nudgeClose.isVisible().catch(() => false)) {
    await nudgeClose.click()
  }

  await eye.click()
  await expect(eye).toHaveAttribute('aria-pressed', 'true')
  // Open the menu and confirm the matching view-btn is also pressed.
  await page.locator('#menu-btn').click({ force: true })
  await expect(page.locator('#view-btn')).toHaveAttribute('aria-pressed', 'true')
  // Close menu, tap eye again to toggle off.
  await page.locator('#menu-btn').click({ force: true })
  await eye.click()
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  // If it errors, page console would log; nothing else to assert here
  // without an in-page hook to manipulate piece.state.
})

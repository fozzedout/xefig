import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-04-19',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

const VIEWPORTS = [
  { label: 'small-landscape', width: 640, height: 400 },
  { label: 'medium-landscape', width: 1280, height: 720 },
  { label: 'large-landscape', width: 1920, height: 1080 },
]

async function loadLauncher(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await page.route('**/api/puzzles/today**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await page.locator('.slice[data-mode]').first().waitFor()
  await page.locator('.slice-more').waitFor()
  // Let ResizeObserver settle the CSS vars
  await page.waitForTimeout(100)
}

for (const viewport of VIEWPORTS) {
  test(`launcher geometry @ ${viewport.label} (${viewport.width}x${viewport.height})`, async ({ page }) => {
    await loadLauncher(page, viewport)

    const geom = await page.evaluate(() => {
      const moreSlice = document.querySelector('.slice-more')
      const moreLabel = document.querySelector('.slice-more .slice-title')
      const moreIcon = document.querySelector('.slice-more .slice-icon')
      const oldCards = document.querySelector('.slice-more .more-card')

      const rect = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
      }

      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        moreSlice: rect(moreSlice),
        moreLabel: rect(moreLabel),
        moreIcon: rect(moreIcon),
        moreLabelText: moreLabel?.textContent?.trim() ?? '',
        oldCardsPresent: !!oldCards,
        otherSliceIcons: Array.from(document.querySelectorAll('.slice:not(.slice-more) .slice-icon svg')).map((svg) => ({
          mode: svg.closest('.slice')?.dataset?.mode,
          rect: rect(svg),
        })),
      }
    })

    await page.screenshot({
      path: `test-results/launcher-${viewport.label}.png`,
      fullPage: false,
    })

    // More slice exists, fits in viewport, and is no longer the in-slice card grid.
    expect(geom.moreSlice).not.toBeNull()
    expect(geom.moreSlice.x).toBeGreaterThanOrEqual(0)
    expect(geom.moreSlice.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(geom.oldCardsPresent).toBe(false)

    // The slice now shows just an icon + "More" label, both inside the slice bounds.
    expect(geom.moreLabel).not.toBeNull()
    expect(geom.moreLabelText.toLowerCase()).toBe('more')
    expect(geom.moreIcon).not.toBeNull()
    for (const child of [geom.moreLabel, geom.moreIcon]) {
      expect(child.x).toBeGreaterThanOrEqual(geom.moreSlice.x - 1)
      expect(child.right).toBeLessThanOrEqual(geom.moreSlice.right + 1)
      expect(child.y).toBeGreaterThanOrEqual(geom.moreSlice.y - 1)
      expect(child.bottom).toBeLessThanOrEqual(geom.moreSlice.bottom + 1)
    }

    // Tapping the slice opens the modal sheet rather than expanding inline.
    await page.locator('.slice-more').click()
    await expect(page.locator('.more-sheet')).toBeVisible()
  })
}

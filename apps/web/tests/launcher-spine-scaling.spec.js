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
      const container = document.querySelector('#slice-container')
      const moreSlice = document.querySelector('.slice-more')
      const moreCards = document.querySelector('.slice-more-cards')
      const cards = Array.from(document.querySelectorAll('.slice-more .more-card'))
      const moreTitle = document.querySelector('.slice-more .slice-title')
      const activeSlice = document.querySelector('.slice.active:not(.slice-more)')
      const activeInfo = activeSlice?.querySelector('.slice-info')
      const activeAction = activeSlice?.querySelector('.slice-action')
      const activeIcon = activeSlice?.querySelector('.slice-icon svg')
      const cs = getComputedStyle(container)

      const rect = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
      }

      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        cssVars: {
          sliceCenter: cs.getPropertyValue('--slice-center').trim(),
          sliceMiddle: cs.getPropertyValue('--slice-middle').trim(),
          infoWidth: cs.getPropertyValue('--info-width').trim(),
        },
        moreSlice: rect(moreSlice),
        moreCards: rect(moreCards),
        moreTitle: rect(moreTitle),
        cards: cards.map((c) => ({
          rect: rect(c),
          label: c.querySelector('.more-card-label')?.textContent?.trim() ?? '',
          svg: rect(c.querySelector('svg')),
        })),
        otherSliceIcons: Array.from(document.querySelectorAll('.slice:not(.slice-more) .slice-icon svg')).map((svg, i) => ({
          mode: svg.closest('.slice')?.dataset?.mode,
          rect: rect(svg),
        })),
        activeSlice: rect(activeSlice),
        activeInfo: rect(activeInfo),
        activeInfoFontSize: activeInfo ? getComputedStyle(activeInfo.querySelector('p') || activeInfo).fontSize : null,
        activeAction: rect(activeAction),
        activeIcon: rect(activeIcon),
      }
    })

    console.log(`\n=== ${viewport.label} (${viewport.width}x${viewport.height}) ===`)
    console.log(JSON.stringify(geom, null, 2))

    await page.screenshot({
      path: `test-results/launcher-${viewport.label}.png`,
      fullPage: false,
    })

    // Sanity: every More card must sit inside the More slice bounds
    expect(geom.moreSlice).not.toBeNull()
    expect(geom.cards.length).toBeGreaterThanOrEqual(2)
    for (const card of geom.cards) {
      expect(card.rect.x).toBeGreaterThanOrEqual(geom.moreSlice.x - 1)
      expect(card.rect.right).toBeLessThanOrEqual(geom.moreSlice.right + 1)
      expect(card.rect.y).toBeGreaterThanOrEqual(geom.moreSlice.y - 1)
      expect(card.rect.bottom).toBeLessThanOrEqual(geom.moreSlice.bottom + 1)
    }

    // Cards must not collide with the MORE title at the top of the slice
    if (geom.moreTitle) {
      const topCard = geom.cards.reduce((a, b) => (a.rect.y < b.rect.y ? a : b))
      expect(topCard.rect.y).toBeGreaterThanOrEqual(geom.moreTitle.bottom - 2)
    }

    // MORE title must be horizontally centered in the More slice (the More
    // slice is narrower than a collapsed slice so it can't reuse the shared
    // --slice-center that positions the other titles).
    if (geom.moreTitle) {
      const sliceMid = geom.moreSlice.x + geom.moreSlice.w / 2
      const titleMid = geom.moreTitle.x + geom.moreTitle.w / 2
      expect(Math.abs(sliceMid - titleMid)).toBeLessThan(1.5)
    }

    // Bottom More-card SVG must sit on the same row as the other slices'
    // bottom icons (within a few px of rounding).
    const lastCard = geom.cards[geom.cards.length - 1]
    if (lastCard?.svg && geom.otherSliceIcons?.length) {
      const otherBottom = geom.otherSliceIcons[0].rect.bottom
      expect(Math.abs(lastCard.svg.bottom - otherBottom)).toBeLessThan(3)
    }
  })
}

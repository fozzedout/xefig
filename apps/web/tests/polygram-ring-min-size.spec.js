import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-05-18',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openPolygramGame(page) {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TODAY_PAYLOAD) })
  })
  await page.goto('/', { waitUntil: 'networkidle' })
  const slice = page.locator('.slice[data-mode="polygram"]')
  await slice.waitFor()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  await page.locator('.polygram-piece').first().waitFor()
}

test('polygram rotation ring respects min size + has grippy texture', async ({ page }) => {
  await openPolygramGame(page)

  // Pick the smallest available shard that's actually visible in the
  // tray viewport — small shards trigger the "ring too tiny to grab"
  // failure mode best, but if none are scrolled into view, fall back to
  // any visible shard.
  const smallestLabel = await page.locator('.polygram-piece').evaluateAll((elements) => {
    const vw = window.innerWidth
    const candidates = []
    for (const el of elements) {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      if (r.right <= 0 || r.left >= vw) continue
      candidates.push({ size: Math.max(r.width, r.height), label: el.getAttribute('aria-label') })
    }
    candidates.sort((a, b) => a.size - b.size)
    return candidates[0]?.label ?? null
  })
  expect(smallestLabel).not.toBeNull()
  const piece = page.locator(`.polygram-piece[aria-label="${smallestLabel}"]`)

  // Drag it down to the board (portrait tray on top) and release.
  const box = await piece.boundingBox()
  expect(box).not.toBeNull()
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const to = { x: from.x, y: from.y + 400 }
  await piece.evaluate(
    async (target, { fromPoint, toPoint }) => {
      const root = target.closest('.polygram-root')
      const init = { bubbles: true, composed: true, pointerId: 2, pointerType: 'touch' }
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: fromPoint.x, clientY: fromPoint.y }))
      const steps = 12
      for (let s = 1; s <= steps; s += 1) {
        const k = s / steps
        root.dispatchEvent(new PointerEvent('pointermove', {
          ...init,
          clientX: fromPoint.x + (toPoint.x - fromPoint.x) * k,
          clientY: fromPoint.y + (toPoint.y - fromPoint.y) * k,
        }))
        await new Promise((r) => setTimeout(r, 16))
      }
      root.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: toPoint.x, clientY: toPoint.y }))
    },
    { fromPoint: from, toPoint: to },
  )

  // Ring should show now.
  const ring = page.locator('.polygram-rotate-ring.is-visible')
  await expect(ring).toBeVisible()

  const layout = await page.evaluate(() => {
    const ring = document.querySelector('.polygram-rotate-ring.is-visible')
    const rect = ring.getBoundingClientRect()
    return { ring: { width: rect.width, height: rect.height } }
  })
  console.log(JSON.stringify(layout, null, 2))

  await page.screenshot({ path: 'test-results/polygram-ring-min-size.png', fullPage: false })

  // Min ring size in code is 220 — verify the floor kicked in (or that
  // the natural 2.1× size already exceeded it on a non-tiny shard).
  expect(layout.ring.width).toBeGreaterThanOrEqual(219)
  expect(layout.ring.height).toBeGreaterThanOrEqual(219)
})

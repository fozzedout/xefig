import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-03-23',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openDiamondGame(page) {
  await page.route('**/api/puzzles/today**', async (route) => {
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

  const diamondSlice = page.locator('.slice[data-mode="diamond"]')
  await diamondSlice.waitFor()

  if (!(await diamondSlice.evaluate((element) => element.classList.contains('active')))) {
    await diamondSlice.click()
  }
  await diamondSlice.click()
  await page.locator('.diamond-board-frame').waitFor()
  await page.locator('.diamond-board-content').waitFor()
  await page.addInitScript(() => {})
  await page.evaluate(() => {
    const prototype = window.HTMLCanvasElement?.prototype
    if (!prototype) return

    const original = prototype.setPointerCapture
    prototype.setPointerCapture = function setPointerCaptureSafe(pointerId) {
      try {
        return original?.call(this, pointerId)
      } catch {
        return undefined
      }
    }
  })
}

async function pinchZoomDiamondBoard(page, spread = 60) {
  await page.evaluate((nextSpread) => {
    const canvas = document.querySelector('.diamond-canvas')
    if (!canvas) throw new Error('Diamond canvas not found')

    const rect = canvas.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const init = { bubbles: true, composed: true, pointerType: 'touch' }

    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 10, clientX: cx - 20, clientY: cy }))
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 11, clientX: cx + 20, clientY: cy }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 10, clientX: cx - nextSpread, clientY: cy }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 11, clientX: cx + nextSpread, clientY: cy }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 10, clientX: cx - nextSpread, clientY: cy }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 11, clientX: cx + nextSpread, clientY: cy }))
  }, spread)
}

async function readDiamondViewportMetrics(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('.diamond-board-frame')
    const content = document.querySelector('.diamond-board-content')
    if (!frame || !content) return null

    const frameRect = frame.getBoundingClientRect()
    const contentRect = content.getBoundingClientRect()
    const viewportLeft = frameRect.left + frame.clientLeft
    const viewportTop = frameRect.top + frame.clientTop
    const viewportRight = viewportLeft + frame.clientWidth
    const viewportBottom = viewportTop + frame.clientHeight

    return {
      viewportWidth: frame.clientWidth,
      viewportHeight: frame.clientHeight,
      contentWidth: contentRect.width,
      contentHeight: contentRect.height,
      leftGap: contentRect.left - viewportLeft,
      topGap: contentRect.top - viewportTop,
      rightGap: viewportRight - contentRect.right,
      bottomGap: viewportBottom - contentRect.bottom,
    }
  })
}

async function readDiamondCanvasMetrics(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.diamond-canvas')
    if (!canvas) return null

    return {
      width: canvas.width,
      height: canvas.height,
      pixels: canvas.width * canvas.height,
    }
  })
}

async function panDiamondBoard(page, deltaX, deltaY) {
  await page.evaluate(({ dx, dy }) => {
    const canvas = document.querySelector('.diamond-canvas')
    if (!canvas) throw new Error('Diamond canvas not found')

    const rect = canvas.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const init = { bubbles: true, composed: true, pointerType: 'touch' }

    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 20, clientX: cx, clientY: cy }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 20, clientX: cx + dx, clientY: cy + dy }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 20, clientX: cx + dx, clientY: cy + dy }))
  }, { dx: deltaX, dy: deltaY })
}

async function zoomOutDiamondBoard(page, steps = 12) {
  await page.evaluate((count) => {
    const canvas = document.querySelector('.diamond-canvas')
    if (!canvas) throw new Error('Diamond canvas not found')

    const rect = canvas.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    for (let index = 0; index < count; index += 1) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        composed: true,
        clientX: cx,
        clientY: cy,
        deltaY: 240,
      }))
    }
  }, steps)
}

test('diamond board pinch zoom scales the board content', async ({ page }) => {
  await openDiamondGame(page)

  const before = await page.locator('.diamond-board-content').evaluate((element) => element.style.transform || '')
  const beforeScaleMatch = before.match(/scale\(([\d.]+)\)/)

  await pinchZoomDiamondBoard(page)

  const after = await page.locator('.diamond-board-content').evaluate((element) => element.style.transform || '')

  expect(after).not.toBe(before)
  expect(after).toMatch(/scale\(/)

  const scaleMatch = after.match(/scale\(([\d.]+)\)/)
  expect(scaleMatch).not.toBeNull()
  expect(beforeScaleMatch).not.toBeNull()
  expect(parseFloat(scaleMatch[1])).toBeGreaterThan(parseFloat(beforeScaleMatch[1]))
})

test('diamond canvas backing store stays within iOS-safe limits', async ({ page }) => {
  await openDiamondGame(page)

  const metrics = await readDiamondCanvasMetrics(page)

  expect(metrics).not.toBeNull()
  expect(metrics.width).toBeLessThanOrEqual(4096)
  expect(metrics.height).toBeLessThanOrEqual(4096)
  expect(metrics.pixels).toBeLessThanOrEqual(4096 * 4096)
})

test('diamond board can pan far enough to reveal the bottom-right edge after zooming', async ({ page }) => {
  await openDiamondGame(page)
  await pinchZoomDiamondBoard(page)
  await panDiamondBoard(page, -2000, -2000)

  const metrics = await readDiamondViewportMetrics(page)

  expect(metrics).not.toBeNull()
  expect(metrics.contentWidth).toBeGreaterThan(metrics.viewportWidth)
  expect(metrics.contentHeight).toBeGreaterThan(metrics.viewportHeight)
  expect(Math.abs(metrics.rightGap)).toBeLessThanOrEqual(2)
  expect(Math.abs(metrics.bottomGap)).toBeLessThanOrEqual(2)
})

test('diamond board can zoom back out to a fully visible fitted view', async ({ page }) => {
  await openDiamondGame(page)
  await pinchZoomDiamondBoard(page, 70)
  await zoomOutDiamondBoard(page)

  const metrics = await readDiamondViewportMetrics(page)

  expect(metrics).not.toBeNull()
  expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 2)
  expect(metrics.contentHeight).toBeLessThanOrEqual(metrics.viewportHeight + 2)
  expect(Math.abs(metrics.leftGap - metrics.rightGap)).toBeLessThanOrEqual(2)
  expect(Math.abs(metrics.topGap - metrics.bottomGap)).toBeLessThanOrEqual(2)
})

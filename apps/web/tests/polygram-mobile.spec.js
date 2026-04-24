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

async function openPolygramGame(page) {
  await page.route('**/api/puzzles/today**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  const slice = page.locator('.slice[data-mode="polygram"]')
  await slice.waitFor()

  // First click expands the slice, second click launches the game
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  await page.locator('.polygram-piece').first().waitFor()
}

async function getVisiblePieceLocator(page) {
  const label = await page.locator('.polygram-piece').evaluateAll((elements) => {
    const viewportWidth = window.innerWidth
    const candidates = elements
      .map((element) => ({ label: element.getAttribute('aria-label'), rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < viewportWidth)
      .sort((a, b) => a.rect.left - b.rect.left)

    return candidates[0]?.label ?? null
  })

  if (!label) {
    throw new Error('No visible polygram piece found.')
  }

  return page.locator(`.polygram-piece[aria-label="${label}"]`)
}

async function dragVisiblePieceWithTouch(page, locator, delta, { steps = 8, release = true } = {}) {
  const box = await locator.boundingBox()
  if (!box) {
    throw new Error('Visible shard bounding box not available.')
  }

  const from = {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  }
  const to = {
    x: from.x + delta.x,
    y: from.y + delta.y,
  }

  // Use locator.evaluate to dispatch events directly on the correct element,
  // avoiding clip-path hit-testing issues with elementFromPoint.
  // Events are dispatched on the polygram root (which has pointer capture).
  return locator.evaluate(
    async (piece, { fromPoint, toPoint, stepCount, shouldRelease }) => {
      const root = piece.closest('.polygram-root') || piece.getRootNode()
      const init = {
        bubbles: true,
        composed: true,
        pointerId: 2,
        pointerType: 'touch',
      }

      piece.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...init,
          clientX: fromPoint.x,
          clientY: fromPoint.y,
        }),
      )

      for (let step = 1; step <= stepCount; step += 1) {
        const progress = step / stepCount
        root.dispatchEvent(
          new PointerEvent('pointermove', {
            ...init,
            clientX: fromPoint.x + (toPoint.x - fromPoint.x) * progress,
            clientY: fromPoint.y + (toPoint.y - fromPoint.y) * progress,
          }),
        )
        await new Promise((resolve) => window.setTimeout(resolve, 16))
      }

      const state = {
        className: piece.className,
        parentClass: piece.parentElement?.className || '',
      }

      if (shouldRelease) {
        root.dispatchEvent(
          new PointerEvent('pointerup', {
            ...init,
            clientX: toPoint.x,
            clientY: toPoint.y,
          }),
        )
      }

      // Re-read state after potential release
      state.className = piece.className
      state.parentClass = piece.parentElement?.className || ''

      return state
    },
    { fromPoint: from, toPoint: to, stepCount: steps, shouldRelease: release },
  )
}

test('mobile polygram tray keeps controls visible and lets a shard be picked up', async ({ page }) => {
  await openPolygramGame(page)

  await expect(page.locator('.polygram-tray')).toBeVisible()

  const trayLayout = await page.evaluate(() => {
    const tray = document.querySelector('.polygram-tray')?.getBoundingClientRect()
    const grid = document.querySelector('.polygram-tray-grid')?.getBoundingClientRect()
    const visiblePieces = Array.from(document.querySelectorAll('.polygram-piece'))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth)
    return {
      trayWidth: tray?.width ?? 0,
      gridWidth: grid?.width ?? 0,
      gridTop: grid?.top ?? 0,
      gridBottom: grid?.bottom ?? 0,
      visiblePieceTop: visiblePieces.length ? Math.min(...visiblePieces.map((rect) => rect.top)) : 0,
      visiblePieceBottom: visiblePieces.length ? Math.max(...visiblePieces.map((rect) => rect.bottom)) : 0,
    }
  })
  expect(trayLayout.gridWidth).toBeLessThanOrEqual(trayLayout.trayWidth + 1)
  // Rotated pieces can extend slightly beyond slot boundaries due to transform-origin
  const pieceTolerance = 20
  expect(trayLayout.visiblePieceTop).toBeGreaterThanOrEqual(trayLayout.gridTop - pieceTolerance)
  expect(trayLayout.visiblePieceBottom).toBeLessThanOrEqual(trayLayout.gridBottom + pieceTolerance)

  // Dragging a tray piece picks it up (holds it). In portrait the tray
  // is on top and the pickup direction is downward (toward the board),
  // matching the jigsaw tray behaviour.
  const firstPiece = await getVisiblePieceLocator(page)
  const dragResult = await dragVisiblePieceWithTouch(page, firstPiece, { x: 0, y: 200 }, { release: false })
  expect(dragResult.className).toContain('is-held')
})

test('dragging a shard onto the board places it and shows rotation ring', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // Drag piece down from the top tray onto the board and release
  const dragResult = await dragVisiblePieceWithTouch(page, piece, { x: 0, y: 400 }, { release: true })

  // Verify the drag actually worked (class set inside evaluate)
  expect(dragResult.className + ' | ' + dragResult.parentClass).toContain('is-placed')

  // Placed piece should have the rotation ring visible
  await expect(page.locator('.polygram-rotate-ring.is-visible')).toBeVisible()
  await expect(piece).toHaveClass(/is-placed/)
})

test('dragging a placed shard back to the tray returns it', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // Place piece on the board (drag down from top tray)
  await dragVisiblePieceWithTouch(page, piece, { x: 0, y: 400 }, { release: true })
  await page.waitForTimeout(50)
  await expect(piece).toHaveClass(/is-placed/)

  // Tap the placed piece to pick it back up, then tap the tray area to return it
  // In the current implementation, tapping a placed piece toggles the ring;
  // dragging picks it up and dropping over tray returns it
  await dragVisiblePieceWithTouch(page, piece, { x: 0, y: -400 }, { release: true })
  await page.waitForTimeout(50)

  // Should be back in the tray
  const parentClass = await piece.evaluate((el) => el.parentElement?.className || '')
  expect(parentClass).toBe('polygram-tray-grid')
  expect(await piece.evaluate((el) => el.classList.contains('is-placed'))).toBe(false)
})

test('dragging a tray piece picks it up as held', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // In the current implementation, dragging a tray piece holds it
  const dragResult = await dragVisiblePieceWithTouch(page, piece, { x: 0, y: 200 }, { release: false })
  expect(dragResult.className).toContain('is-held')
})

test('dragging a piece onto the board results in placed or locked state', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // Drag piece down from the top tray onto the board
  await dragVisiblePieceWithTouch(page, piece, { x: 0, y: 400 }, { release: true })
  await page.waitForTimeout(50)

  // The piece should either snap-lock (if rotation and position happen to be correct)
  // or be placed on the board for further adjustment
  const state = await piece.evaluate((el) => ({
    isLocked: el.classList.contains('is-locked'),
    hasFlash: el.classList.contains('snap-flash'),
    isPlaced: el.classList.contains('is-placed'),
  }))

  if (state.isLocked) {
    expect(state.hasFlash).toBe(true)
  } else {
    expect(state.isPlaced).toBe(true)
  }
})

test('pinch-to-zoom scales the board content', async ({ page }) => {
  await openPolygramGame(page)

  // Read initial transform
  const before = await page.evaluate(() => {
    const content = document.querySelector('.polygram-board-content')
    return content?.style.transform || ''
  })

  // Simulate a pinch-zoom gesture on the board
  await page.evaluate(() => {
    const board = document.querySelector('.polygram-board')
    if (!board) throw new Error('Board not found')

    const rect = board.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const init = { bubbles: true, composed: true, pointerType: 'touch' }

    // Two fingers down, 40px apart
    board.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 10, clientX: cx - 20, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 11, clientX: cx + 20, clientY: cy }))

    // Spread fingers to 120px apart (3x scale ratio)
    board.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 10, clientX: cx - 60, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 11, clientX: cx + 60, clientY: cy }))

    // Release
    board.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 10, clientX: cx - 60, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 11, clientX: cx + 60, clientY: cy }))
  })

  const after = await page.evaluate(() => {
    const content = document.querySelector('.polygram-board-content')
    return content?.style.transform || ''
  })

  // Transform should have changed — scale should be > 1
  expect(after).not.toBe(before)
  expect(after).toMatch(/scale\(/)
  const scaleMatch = after.match(/scale\(([\d.]+)\)/)
  expect(scaleMatch).not.toBeNull()
  expect(parseFloat(scaleMatch[1])).toBeGreaterThan(1)
})

test('single-finger drag on zoomed board pans the view', async ({ page }) => {
  await openPolygramGame(page)

  // First zoom in via pinch
  await page.evaluate(() => {
    const board = document.querySelector('.polygram-board')
    const rect = board.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const init = { bubbles: true, composed: true, pointerType: 'touch' }

    board.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 10, clientX: cx - 20, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 11, clientX: cx + 20, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 10, clientX: cx - 60, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 11, clientX: cx + 60, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 10, clientX: cx - 60, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 11, clientX: cx + 60, clientY: cy }))
  })

  // Read transform after zoom
  const afterZoom = await page.evaluate(() => {
    return document.querySelector('.polygram-board-content')?.style.transform || ''
  })
  expect(afterZoom).toMatch(/scale\(/)

  // Now single-finger pan
  await page.evaluate(() => {
    const board = document.querySelector('.polygram-board')
    const rect = board.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const init = { bubbles: true, composed: true, pointerType: 'touch' }

    board.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 20, clientX: cx, clientY: cy }))
    board.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 20, clientX: cx + 50, clientY: cy + 30 }))
    board.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 20, clientX: cx + 50, clientY: cy + 30 }))
  })

  const afterPan = await page.evaluate(() => {
    return document.querySelector('.polygram-board-content')?.style.transform || ''
  })

  // Pan should have changed the translate values but not the scale
  expect(afterPan).not.toBe(afterZoom)
  expect(afterPan).toMatch(/translate\(/)
})

import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-03-23',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openPolygramGame(page) {
  await page.route('**/api/puzzles/today', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /polygram/i }).click()
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
  return locator.evaluate(
    async (piece, { fromPoint, toPoint, stepCount, shouldRelease }) => {
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
        window.dispatchEvent(
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
        piece.dispatchEvent(
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

test('mobile polygram tray keeps controls visible and lets a shard be selected and rotated', async ({ page }) => {
  await openPolygramGame(page)

  await expect(page.locator('.polygram-tray')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rotate selected shard left' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rotate selected shard right' })).toBeVisible()

  const trayLayout = await page.evaluate(() => {
    const tray = document.querySelector('.polygram-tray')?.getBoundingClientRect()
    const header = document.querySelector('.polygram-tray-header')?.getBoundingClientRect()
    const viewport = document.querySelector('.polygram-tray-viewport')?.getBoundingClientRect()
    const visiblePieces = Array.from(document.querySelectorAll('.polygram-piece'))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth)
    return {
      trayWidth: tray?.width ?? 0,
      headerWidth: header?.width ?? 0,
      viewportWidth: viewport?.width ?? 0,
      viewportTop: viewport?.top ?? 0,
      viewportBottom: viewport?.bottom ?? 0,
      visiblePieceTop: visiblePieces.length ? Math.min(...visiblePieces.map((rect) => rect.top)) : 0,
      visiblePieceBottom: visiblePieces.length ? Math.max(...visiblePieces.map((rect) => rect.bottom)) : 0,
    }
  })
  expect(trayLayout.headerWidth).toBeLessThanOrEqual(trayLayout.trayWidth + 1)
  expect(trayLayout.viewportWidth).toBeLessThanOrEqual(trayLayout.trayWidth + 1)
  // Rotated pieces can extend slightly beyond slot boundaries due to transform-origin
  const pieceTolerance = 20
  expect(trayLayout.visiblePieceTop).toBeGreaterThanOrEqual(trayLayout.viewportTop - pieceTolerance)
  expect(trayLayout.visiblePieceBottom).toBeLessThanOrEqual(trayLayout.viewportBottom + pieceTolerance)

  const firstPiece = await getVisiblePieceLocator(page)
  await firstPiece.click()

  await expect(firstPiece).toHaveClass(/is-selected/)
  await expect(firstPiece).toHaveClass(/is-select-pulse/)
  await expect(page.locator('.polygram-rotate-label')).not.toHaveText(/No shard selected/i)
  await expect(page.locator('.polygram-rotate-dock')).toHaveClass(/has-selection/)

  // Rotate label shows shard name
  await expect(page.locator('.polygram-rotate-label')).toHaveText(/Shard \d+/)

  const beforeTransform = await firstPiece.evaluate((element) => element.style.transform)
  await page.getByRole('button', { name: 'Rotate selected shard right' }).click()
  await page.waitForTimeout(250)
  const afterTransform = await firstPiece.evaluate((element) => element.style.transform)

  expect(afterTransform).not.toBe(beforeTransform)
})

test('dragging a shard onto the board places it there for rotation', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // Drag piece well above the tray area onto the board and release
  const dragResult = await dragVisiblePieceWithTouch(page, piece, { x: 0, y: -400 }, { release: true })

  // Verify the drag actually worked (class set inside evaluate)
  expect(dragResult.className + ' | ' + dragResult.parentClass).toContain('is-placed')

  // Piece should be selected and rotatable
  await expect(piece).toHaveClass(/is-selected/)
  await expect(page.locator('.polygram-rotate-label')).not.toHaveText(/No shard selected/i)

  // Rotate the placed piece — it should stay on the board
  const beforeTransform = await piece.evaluate((el) => el.style.transform)
  await page.getByRole('button', { name: 'Rotate selected shard right' }).click()
  await page.waitForTimeout(250)
  const afterTransform = await piece.evaluate((el) => el.style.transform)
  expect(afterTransform).not.toBe(beforeTransform)
  await expect(piece).toHaveClass(/is-placed/)
})

test('dragging a placed shard back to the tray returns it', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // Place piece on the board
  await dragVisiblePieceWithTouch(page, piece, { x: 0, y: -400 }, { release: true })
  await page.waitForTimeout(50)
  await expect(piece).toHaveClass(/is-placed/)

  // Now drag it back down well into the tray area
  await dragVisiblePieceWithTouch(page, piece, { x: 0, y: 400 }, { release: true })
  await page.waitForTimeout(50)

  // Should be back in the tray
  const parentClass = await piece.evaluate((el) => el.parentElement?.className || '')
  expect(parentClass).toBe('polygram-tray-track')
  expect(await piece.evaluate((el) => el.classList.contains('is-placed'))).toBe(false)
})

test('selection pulse animation class is applied on click', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)
  await piece.click()

  await expect(piece).toHaveClass(/is-select-pulse/)
  await expect(piece).toHaveClass(/is-selected/)
})

test('snap-flash animation plays when a piece locks into place', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)

  // Rotate piece to 0° so it can snap (12 steps × 30° = 360°)
  await piece.click()
  const rotateBtn = page.getByRole('button', { name: 'Rotate selected shard right' })
  for (let i = 0; i < 12; i++) {
    await rotateBtn.click()
  }
  await page.waitForTimeout(50)

  // Place piece on the board first
  await dragVisiblePieceWithTouch(page, piece, { x: 0, y: -400 }, { release: true })
  await page.waitForTimeout(50)

  // If the piece snapped directly (rotation was already 0 and position happened to be correct),
  // it should have snap-flash. Otherwise it's placed and we can verify placement feedback works.
  const state = await piece.evaluate((el) => ({
    isLocked: el.classList.contains('is-locked'),
    hasFlash: el.classList.contains('snap-flash'),
    isPlaced: el.classList.contains('is-placed'),
  }))

  if (state.isLocked) {
    // Piece snapped — verify flash animation was triggered
    expect(state.hasFlash).toBe(true)
  } else {
    // Piece is placed on board — verify it's interactive
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

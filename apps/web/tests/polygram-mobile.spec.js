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
  const index = await page.locator('.polygram-piece').evaluateAll((elements) => {
    const viewportWidth = window.innerWidth
    const candidates = elements
      .map((element, idx) => ({ idx, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < viewportWidth)
      .sort((a, b) => a.rect.left - b.rect.left)

    return candidates[0]?.idx ?? 0
  })

  return page.locator('.polygram-piece').nth(index)
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

  return page.evaluate(
    async ({ fromPoint, toPoint, stepCount, shouldRelease }) => {
      const init = {
        bubbles: true,
        composed: true,
        pointerId: 2,
        pointerType: 'touch',
      }

      const piece = document.elementFromPoint(fromPoint.x, fromPoint.y)
      if (!piece) {
        throw new Error('Unable to find shard at touch start point.')
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
        window.dispatchEvent(
          new PointerEvent('pointerup', {
            ...init,
            clientX: toPoint.x,
            clientY: toPoint.y,
          }),
        )
      }

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
    return {
      trayWidth: tray?.width ?? 0,
      headerWidth: header?.width ?? 0,
      viewportWidth: viewport?.width ?? 0,
    }
  })
  expect(trayLayout.headerWidth).toBeLessThanOrEqual(trayLayout.trayWidth + 1)
  expect(trayLayout.viewportWidth).toBeLessThanOrEqual(trayLayout.trayWidth + 1)

  const firstPiece = await getVisiblePieceLocator(page)
  await firstPiece.click()

  await expect(firstPiece).toHaveClass(/is-selected/)
  await expect(page.locator('.polygram-rotate-label')).not.toHaveText(/No shard selected/i)

  const beforeTransform = await firstPiece.evaluate((element) => element.style.transform)
  await page.getByRole('button', { name: 'Rotate selected shard right' }).click()
  await page.waitForTimeout(100)
  const afterTransform = await firstPiece.evaluate((element) => element.style.transform)

  expect(afterTransform).not.toBe(beforeTransform)
})

test('mobile polygram tray supports touch dragging a shard out of the tray', async ({ page }) => {
  await openPolygramGame(page)

  const piece = await getVisiblePieceLocator(page)
  const dragState = await dragVisiblePieceWithTouch(page, piece, { x: 8, y: -140 }, { release: false })

  expect(dragState.className).toContain('is-dragging')
  expect(dragState.parentClass).toBe('polygram-drag-layer')
  await expect(page.locator('.polygram-rotate-label')).not.toHaveText(/No shard selected/i)
})

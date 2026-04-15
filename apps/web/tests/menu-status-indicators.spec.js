import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-04-15',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

const COMPLETED_RUNS = {
  '2026-04-15': {
    jigsaw: {
      completedAt: '2026-04-15T10:00:00Z',
      difficulty: 'easy',
      elapsedActiveMs: 125000,
      bestElapsedMs: 125000,
    },
  },
}

const SAVED_RUN = {
  puzzleDate: '2026-04-15',
  gameMode: 'sliding',
  difficulty: 'easy',
  imageUrl: '/src/assets/hero.png',
  elapsedActiveMs: 30000,
  puzzleState: {},
  updatedAt: '2026-04-15T09:00:00Z',
  completed: false,
}

async function setupPage(page, { completedRuns, savedRun } = {}) {
  await page.route('**/api/puzzles/today**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.addInitScript(({ completedRuns, savedRun }) => {
    if (completedRuns) {
      localStorage.setItem('xefig:puzzles:completed:v1', JSON.stringify(completedRuns))
    }
    if (savedRun) {
      const key = `xefig:run:${savedRun.puzzleDate}:${savedRun.gameMode}`
      localStorage.setItem(key, JSON.stringify(savedRun))
    }
  }, { completedRuns, savedRun })

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await page.locator('.slice[data-mode]').first().waitFor()
}

// ─── Portrait tests (iPhone 12 default is portrait) ───

test.describe('portrait menu status indicators', () => {
  test('shows "new" status on untouched puzzles', async ({ page }) => {
    await setupPage(page)

    const status = page.locator('.slice[data-mode="swap"] .slice-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveClass(/status-new/)
    await expect(status).toHaveText('new')
  })

  test('shows completed status with time on finished puzzles', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS })

    const status = page.locator('.slice[data-mode="jigsaw"] .slice-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveClass(/status-completed/)
    // 125000ms = 02:05
    await expect(status).toContainText('02:05')
  })

  test('shows saved status on in-progress puzzles', async ({ page }) => {
    await setupPage(page, { savedRun: SAVED_RUN })

    const status = page.locator('.slice[data-mode="sliding"] .slice-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveClass(/status-saved/)
    await expect(status).toContainText('saved')
  })

  test('status indicators visible on collapsed (non-active) slices', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS, savedRun: SAVED_RUN })

    // Make sure we check a non-active slice
    const jigsawSlice = page.locator('.slice[data-mode="jigsaw"]')
    const isActive = await jigsawSlice.evaluate((el) => el.classList.contains('active'))

    if (isActive) {
      // Click another slice to deactivate jigsaw
      await page.locator('.slice[data-mode="swap"]').click()
      await page.waitForTimeout(400)
    }

    const status = page.locator('.slice[data-mode="jigsaw"] .slice-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveClass(/status-completed/)
  })

  test('all three status types coexist in the menu', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS, savedRun: SAVED_RUN })

    const completedStatus = page.locator('.slice[data-mode="jigsaw"] .slice-status.status-completed')
    const savedStatus = page.locator('.slice[data-mode="sliding"] .slice-status.status-saved')
    const newStatus = page.locator('.slice[data-mode="swap"] .slice-status.status-new')

    await expect(completedStatus).toBeVisible()
    await expect(savedStatus).toBeVisible()
    await expect(newStatus).toBeVisible()
  })
})

// ─── Landscape tests ───

test.describe('landscape menu status indicators', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 })
  })

  test('shows status indicators on collapsed landscape slices', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS, savedRun: SAVED_RUN })

    const completedStatus = page.locator('.slice[data-mode="jigsaw"] .slice-status.status-completed')
    const savedStatus = page.locator('.slice[data-mode="sliding"] .slice-status.status-saved')
    const newStatus = page.locator('.slice[data-mode="swap"] .slice-status.status-new')

    await expect(completedStatus).toBeVisible()
    await expect(savedStatus).toBeVisible()
    await expect(newStatus).toBeVisible()
  })

  test('completed status shows time in landscape', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS })

    const status = page.locator('.slice[data-mode="jigsaw"] .slice-status')
    await expect(status).toBeVisible()
    await expect(status).toContainText('02:05')
  })

  test('completed status visible on active (expanded) slice in landscape', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS })

    const jigsawSlice = page.locator('.slice[data-mode="jigsaw"]')
    const isActive = await jigsawSlice.evaluate((el) => el.classList.contains('active'))
    if (!isActive) {
      await jigsawSlice.click()
      await page.waitForTimeout(400)
    }

    const status = jigsawSlice.locator('.slice-status')
    await expect(status).toBeVisible()
    await expect(status).toContainText('02:05')
  })

  test('new status hides on active (expanded) slice in landscape', async ({ page }) => {
    await setupPage(page)

    const swapSlice = page.locator('.slice[data-mode="swap"]')
    const isActive = await swapSlice.evaluate((el) => el.classList.contains('active'))
    if (!isActive) {
      await swapSlice.click()
      await page.waitForTimeout(400)
    }

    const status = swapSlice.locator('.slice-status')
    const opacity = await status.evaluate((el) => Number(window.getComputedStyle(el).opacity))
    expect(opacity).toBe(0)
  })
})

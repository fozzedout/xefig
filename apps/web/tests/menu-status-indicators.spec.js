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
  await page.route('**/api/puzzles/*', async (route) => {
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

// ─── Portrait tests ───

test.describe('portrait menu status indicators', () => {
  test('shows default action text on untouched puzzles', async ({ page }) => {
    await setupPage(page)

    const action = page.locator('.slice[data-mode="swap"] .slice-action')
    await expect(action).toContainText('Swap now')
    await expect(action).not.toHaveClass(/action-completed/)
    await expect(action).not.toHaveClass(/action-saved/)
  })

  test('shows completed icon on collapsed finished puzzle', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS })

    // Ensure jigsaw is collapsed
    const jigsawSlice = page.locator('.slice[data-mode="jigsaw"]')
    const isActive = await jigsawSlice.evaluate((el) => el.classList.contains('active'))
    if (isActive) {
      await page.locator('.slice[data-mode="swap"]').click()
      await page.waitForTimeout(400)
    }

    const action = page.locator('.slice[data-mode="jigsaw"] .slice-action')
    await expect(action).toHaveClass(/action-completed/)
    await expect(action).toBeVisible()
    // Icon should be visible
    await expect(action.locator('svg.action-icon')).toBeVisible()
    // Text should be hidden on collapsed
    const spanDisplay = await action.locator('span').evaluate((el) => window.getComputedStyle(el).display)
    expect(spanDisplay).toBe('none')
  })

  test('shows resume icon on collapsed saved puzzle', async ({ page }) => {
    await setupPage(page, { savedRun: SAVED_RUN })

    // Ensure sliding is collapsed
    const slidingSlice = page.locator('.slice[data-mode="sliding"]')
    const isActive = await slidingSlice.evaluate((el) => el.classList.contains('active'))
    if (isActive) {
      await page.locator('.slice[data-mode="swap"]').click()
      await page.waitForTimeout(400)
    }

    const action = page.locator('.slice[data-mode="sliding"] .slice-action')
    await expect(action).toHaveClass(/action-saved/)
    await expect(action).toBeVisible()
    await expect(action.locator('svg.action-icon')).toBeVisible()
  })

  test('active completed slice shows pill with time', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS })

    const jigsawSlice = page.locator('.slice[data-mode="jigsaw"]')
    const isActive = await jigsawSlice.evaluate((el) => el.classList.contains('active'))
    if (!isActive) {
      await jigsawSlice.click()
      await page.waitForTimeout(400)
    }

    const action = jigsawSlice.locator('.slice-action')
    await expect(action).toHaveClass(/action-completed/)
    // Text should now be visible with time
    await expect(action.locator('span')).toBeVisible()
    await expect(action).toContainText('02:05')
  })

  test('active saved slice shows pill with Resume', async ({ page }) => {
    await setupPage(page, { savedRun: SAVED_RUN })

    const slidingSlice = page.locator('.slice[data-mode="sliding"]')
    const isActive = await slidingSlice.evaluate((el) => el.classList.contains('active'))
    if (!isActive) {
      await slidingSlice.click()
      await page.waitForTimeout(400)
    }

    const action = slidingSlice.locator('.slice-action')
    await expect(action).toHaveClass(/action-saved/)
    await expect(action.locator('span')).toBeVisible()
    await expect(action).toContainText('Resume')
  })
})

// ─── Landscape tests ───

test.describe('landscape menu status indicators', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 })
  })

  test('shows icons on collapsed landscape spines', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS, savedRun: SAVED_RUN })

    const completedAction = page.locator('.slice[data-mode="jigsaw"] .slice-action.action-completed')
    const savedAction = page.locator('.slice[data-mode="sliding"] .slice-action.action-saved')

    await expect(completedAction).toBeVisible()
    await expect(savedAction).toBeVisible()
    await expect(completedAction.locator('svg.action-icon')).toBeVisible()
    await expect(savedAction.locator('svg.action-icon')).toBeVisible()
  })

  test('active completed slice shows pill with time in landscape', async ({ page }) => {
    await setupPage(page, { completedRuns: COMPLETED_RUNS })

    const jigsawSlice = page.locator('.slice[data-mode="jigsaw"]')
    const isActive = await jigsawSlice.evaluate((el) => el.classList.contains('active'))
    if (!isActive) {
      await jigsawSlice.click()
      await page.waitForTimeout(400)
    }

    const action = jigsawSlice.locator('.slice-action')
    await expect(action).toBeVisible()
    await expect(action).toContainText('02:05')
  })
})

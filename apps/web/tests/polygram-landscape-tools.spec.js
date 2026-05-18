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

test('polygram landscape: tray-tools straddle the canvas/tray edge', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 480 })

  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TODAY_PAYLOAD),
    })
  })

  await page.goto('/', { waitUntil: 'networkidle' })
  const slice = page.locator('.slice[data-mode="polygram"]')
  await slice.waitFor()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  await page.locator('.polygram-piece').first().waitFor()
  await page.waitForTimeout(400) // give the layout time to settle

  const layout = await page.evaluate(() => {
    const root = document.querySelector('.polygram-root')
    const tray = document.querySelector('.polygram-tray')
    const tools = document.querySelector('.polygram-tray-tools')
    const board = document.querySelector('.polygram-board-wrap')
    const gameShell = document.querySelector('.game-shell')
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      gameShellClasses: gameShell?.className || '',
      rootGridCols: getComputedStyle(root).gridTemplateColumns,
      tray: tray ? tray.getBoundingClientRect() : null,
      tools: tools ? tools.getBoundingClientRect() : null,
      board: board ? board.getBoundingClientRect() : null,
      toolsStyle: tools ? {
        position: getComputedStyle(tools).position,
        flexDirection: getComputedStyle(tools).flexDirection,
        gridColumn: getComputedStyle(tools).gridColumn,
        marginLeft: getComputedStyle(tools).marginLeft,
        top: getComputedStyle(tools).top,
        left: getComputedStyle(tools).left,
      } : null,
    }
  })
  console.log(JSON.stringify(layout, null, 2))
  await page.screenshot({ path: 'test-results/polygram-landscape-tools.png', fullPage: false })

  expect(layout.tools).not.toBeNull()
  expect(layout.toolsStyle.flexDirection).toBe('column')

  // Tools centre should align with the canvas/tray boundary (= tray.left).
  const trayLeftEdge = layout.tray.left
  const toolsCentreX = layout.tools.left + layout.tools.width / 2
  expect(Math.abs(toolsCentreX - trayLeftEdge)).toBeLessThan(12)
  // And at the top of the board area.
  expect(layout.tools.top).toBeLessThan(80)
})

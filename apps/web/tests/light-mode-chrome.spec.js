import { expect, test } from '@playwright/test'

const HERO_URL = '/src/assets/hero.png'

function todayPayload() {
  const today = new Date().toISOString().slice(0, 10)
  return {
    date: today,
    categories: {
      jigsaw: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      slider: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      swap: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      polygram: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
      diamond: { imageUrl: HERO_URL, thumbnailUrl: HERO_URL },
    },
  }
}

async function mockBaseline(page) {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(todayPayload()),
    })
  })
  await page.route('**/api/leaderboard**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
}

function rgbBrightness(rgbStr) {
  const m = rgbStr.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const [r, g, b] = m[1].split(',').map((v) => Number(v.trim()))
  return (r + g + b) / 3
}

test.describe('light/dark mode chrome adaptation', () => {
  test('body background flips from dark to light when OS theme is light', async ({ browser }) => {
    const darkContext = await browser.newContext({ colorScheme: 'dark' })
    const darkPage = await darkContext.newPage()
    await mockBaseline(darkPage)
    await darkPage.goto('/', { waitUntil: 'networkidle' })
    const darkBg = await darkPage.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    )

    const lightContext = await browser.newContext({ colorScheme: 'light' })
    const lightPage = await lightContext.newPage()
    await mockBaseline(lightPage)
    await lightPage.goto('/', { waitUntil: 'networkidle' })
    const lightBg = await lightPage.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    )

    const darkAvg = rgbBrightness(darkBg)
    const lightAvg = rgbBrightness(lightBg)
    expect(darkAvg).toBeLessThan(40)
    expect(lightAvg).toBeGreaterThan(200)

    await darkContext.close()
    await lightContext.close()
  })

  test('settings page surface is light in light mode', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' })
    const page = await ctx.newPage()
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.locator('.slice-more').click()
    await page.locator('.more-sheet-card[data-page="settings"]').click()
    await expect(page.locator('#page-settings.visible')).toBeVisible()
    const bg = await page.evaluate(
      () => getComputedStyle(document.querySelector('.settings-page')).backgroundColor,
    )
    const avg = rgbBrightness(bg)
    expect(avg).toBeGreaterThan(200)
    await ctx.close()
  })

  test('game elements stay dark in light mode (game-toolbar, gt-icon-btn, slice-launcher)', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' })
    const page = await ctx.newPage()
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    // Inject a synthetic game-shell + toolbar + dropdown trigger button + tray
    // into the live page so we can read computed styles without navigating
    // through the full game-launch flow. The CSS we're verifying is purely
    // selector-based, so injection is sufficient.
    const colors = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.innerHTML = `
        <div class="game-shell">
          <div class="game-toolbar">
            <button class="gt-icon-btn" type="button"></button>
          </div>
        </div>
        <div class="jigsaw-carousel"></div>
      `
      probe.style.position = 'absolute'
      probe.style.left = '-9999px'
      document.body.appendChild(probe)
      const out = {
        gameShell: getComputedStyle(probe.querySelector('.game-shell')).backgroundColor,
        toolbar: getComputedStyle(probe.querySelector('.game-toolbar')).backgroundColor,
        iconBtn: getComputedStyle(probe.querySelector('.gt-icon-btn')).color,
      }
      const launcher = document.querySelector('.slice-launcher')
      if (launcher) out.sliceLauncher = getComputedStyle(launcher).backgroundColor
      probe.remove()
      return out
    })

    // game-shell is hardcoded #0a0a0f (avg ≈ 9.6)
    expect(rgbBrightness(colors.gameShell)).toBeLessThan(40)
    // game-toolbar is rgba(10, 10, 15, 0.85) (avg ≈ 11.66)
    expect(rgbBrightness(colors.toolbar)).toBeLessThan(40)
    // gt-icon-btn text colour is hardcoded #e8e6e0 (avg ≈ 230) — stays light
    // even in light mode because the button sits over the dark game shell.
    expect(rgbBrightness(colors.iconBtn)).toBeGreaterThan(200)
    // .slice-launcher's bg flips to var(--bg) in light mode so the iOS
    // safe-area-top region matches the theme — the slice imagery on top
    // is what stays dark, not the underlying surface.
    if (colors.sliceLauncher) {
      expect(rgbBrightness(colors.sliceLauncher)).toBeGreaterThan(200)
    }
    await ctx.close()
  })

  test('top nav text is dark in light mode', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'light' })
    const page = await ctx.newPage()
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const brandColor = await page.evaluate(
      () => getComputedStyle(document.querySelector('.nav-brand')).color,
    )
    const avg = rgbBrightness(brandColor)
    // var(--text) in light mode is #102131 → avg ≈ 28
    expect(avg).toBeLessThan(80)
    await ctx.close()
  })

  test('top nav text is light in dark mode (no regression)', async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: 'dark' })
    const page = await ctx.newPage()
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const brandColor = await page.evaluate(
      () => getComputedStyle(document.querySelector('.nav-brand')).color,
    )
    const avg = rgbBrightness(brandColor)
    // .nav-brand color is hardcoded #e8e6e0 → avg ≈ 230
    expect(avg).toBeGreaterThan(200)
    await ctx.close()
  })
})

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

async function spoofPlatform(page, { touchPoints = 0, hasBIP = false } = {}) {
  await page.addInitScript(({ touchPoints, hasBIP }) => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => touchPoints })
    if (hasBIP && !('BeforeInstallPromptEvent' in window)) {
      // eslint-disable-next-line no-undef
      window.BeforeInstallPromptEvent = function () {}
    }
    if (!hasBIP && 'BeforeInstallPromptEvent' in window) {
      try { delete window.BeforeInstallPromptEvent } catch {}
    }
  }, { touchPoints, hasBIP })
}

async function openInstallCard(page) {
  await page.locator('.slice-more').click()
  await expect(page.locator('.more-sheet')).toBeVisible()
  const card = page.locator('.more-sheet-card[data-action="install-app"]')
  await expect(card).toBeVisible()
  return card
}

test.describe('Install guide overlay', () => {
  test('iPhone Safari shows the iPhone Share → Add to Home Screen guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 5, hasBIP: false })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'ios-safari')
    await card.click()

    const guide = page.locator('.install-guide')
    await expect(guide).toBeVisible()
    await expect(guide.locator('.install-guide-title')).toHaveText(/iPhone/)
    await expect(guide.locator('.install-guide-step')).toHaveCount(2)
    await context.close()
  })

  test('iOS Chrome routes to the "open in Safari" guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 5, hasBIP: false })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'ios-other-browser')
    await card.click()

    const guide = page.locator('.install-guide')
    await expect(guide).toBeVisible()
    await expect(guide.locator('.install-guide-title')).toHaveText(/Safari/)
    await expect(guide.locator('.install-guide-step')).toHaveCount(3)
    await context.close()
  })

  test('iPad Safari shows the iPad Share → Add to Home Screen guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 5, hasBIP: false })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'ipad-safari')
    await card.click()

    await expect(page.locator('.install-guide-title')).toHaveText(/iPad/)
    await context.close()
  })

  test('macOS Safari shows the Add to Dock guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 0, hasBIP: false })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'macos-safari')
    await card.click()

    await expect(page.locator('.install-guide-title')).toHaveText(/macOS/)
    await context.close()
  })

  test('Android without a captured prompt shows the browser-menu guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 5, hasBIP: true })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'android-fallback')
    await card.click()

    await expect(page.locator('.install-guide-title')).toHaveText(/Android/)
  })

  test('Desktop Chromium without a captured prompt shows the address-bar guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 0, hasBIP: true })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'chrome-no-prompt')
    await card.click()

    await expect(page.locator('.install-guide-title')).toHaveText(/desktop/)
  })

  test('Captured beforeinstallprompt fires the JS prompt instead of the guide', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    })
    const page = await context.newPage()
    await spoofPlatform(page, { touchPoints: 5, hasBIP: true })
    await mockBaseline(page)
    await page.goto('/', { waitUntil: 'networkidle' })

    let promptCalled = false
    await page.exposeBinding('__markPrompt', () => { promptCalled = true })

    await page.evaluate(() => {
      const fakeEvent = new Event('beforeinstallprompt')
      fakeEvent.prompt = async () => { window.__markPrompt() }
      Object.defineProperty(fakeEvent, 'userChoice', { value: Promise.resolve({ outcome: 'accepted' }) })
      window.dispatchEvent(fakeEvent)
    })

    const card = await openInstallCard(page)
    await expect(card).toHaveAttribute('data-install-platform', 'chrome-prompt')
    await card.click()

    await expect(page.locator('.install-guide')).toHaveCount(0)
    await page.waitForFunction(() => true)
    expect(promptCalled).toBe(true)
  })
})

import { devices, expect, test } from '@playwright/test'

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

async function setup(page) {
  await page.route('**/api/puzzles/*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(todayPayload()) }),
  )
  await page.route('**/api/leaderboard**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
}

async function openDisplaySettings(page) {
  await page.locator('.slice-more').click()
  await page.waitForTimeout(300)
  await page.locator('.more-sheet-card[data-page="settings"]').click()
  await page.waitForTimeout(400)
  await page.locator('#settings-section-display summary').click()
  await page.waitForTimeout(200)
}

function parseRgb(value) {
  const match = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/)
  if (match) return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) }
  const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/)
  if (!srgb) throw new Error(`Invalid RGB color: ${value}`)
  return { r: Math.round(Number(srgb[1]) * 255), g: Math.round(Number(srgb[2]) * 255), b: Math.round(Number(srgb[3]) * 255), a: srgb[4] === undefined ? 1 : Number(srgb[4]) }
}

function parseHex(value) {
  const match = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (!match) throw new Error(`Invalid hex color: ${value}`)
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) }
}

async function tintDetails(page) {
  return page.evaluate(() => {
    const tint = document.querySelector('#status-tint')
    const style = getComputedStyle(tint)
    const rect = tint.getBoundingClientRect()
    return {
      position: style.position, top: rect.top, left: rect.left, width: rect.width,
      height: rect.height, innerWidth: window.innerWidth, backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage, visibility: style.visibility,
      pointerEvents: style.pointerEvents, zIndex: style.zIndex,
      metaColor: document.querySelector('#meta-theme-color').content,
      theme: document.documentElement.getAttribute('data-theme'),
    }
  })
}

function expectMatchingColors(details) {
  const { r, g, b, a } = parseRgb(details.backgroundColor)
  expect(a).toBe(1)
  expect({ r, g, b }).toEqual(parseHex(details.metaColor))
  return (r + g + b) / 3
}

for (const colorScheme of ['dark', 'light']) {
  test(`phone tint matches ${colorScheme} theme`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme })
    try {
      const page = await ctx.newPage()
      await setup(page)
      await page.goto('/', { waitUntil: 'networkidle' })
      await expect(page.locator('#status-tint')).toHaveCount(1)
      const details = await tintDetails(page)
      expect(details.position).toBe('fixed')
      expect(details.top).toBe(0)
      expect(details.left).toBe(0)
      expect(details.width).toBe(details.innerWidth)
      expect(details.height).toBeGreaterThanOrEqual(11)
      expect(details.backgroundImage).toBe('none')
      expect(details.visibility).toBe('visible')
      expect(details.pointerEvents).toBe('none')
      expect(Number(details.zIndex)).toBeGreaterThan(10000)
      expect(details.theme).toBe(colorScheme)
      expectMatchingColors(details)
    } finally {
      await ctx.close()
    }
  })
}

test('phone tint covers the top inset', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme: 'dark' })
  try {
    const page = await ctx.newPage()
    await setup(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: ':root{--sai-top:47px !important}' })
    expect((await tintDetails(page)).height).toBe(47)
  } finally {
    await ctx.close()
  }
})

test('phone tint follows runtime theme changes', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme: 'dark' })
  try {
    const page = await ctx.newPage()
    await setup(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await openDisplaySettings(page)
    await page.locator('.settings-theme-option[data-theme-pref="light"]').click()
    await page.waitForTimeout(150)
    expect(expectMatchingColors(await tintDetails(page))).toBeGreaterThan(200)
    await page.locator('.settings-theme-option[data-theme-pref="dark"]').click()
    await page.waitForTimeout(150)
    expect(expectMatchingColors(await tintDetails(page))).toBeLessThan(40)
  } finally {
    await ctx.close()
  }
})

test('desktop tint is hidden but remains opaque and full width', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  try {
    const page = await ctx.newPage()
    await setup(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    const details = await tintDetails(page)
    expect(details.visibility).toBe('hidden')
    expect(details.position).toBe('fixed')
    expect(details.height).toBe(11)
    expect(details.width).toBe(details.innerWidth)
    expect(parseRgb(details.backgroundColor).a).toBe(1)
  } finally {
    await ctx.close()
  }
})

async function enterGame(page) {
  const slice = page.locator('.slice[data-mode="jigsaw"]')
  await expect(slice).toBeVisible()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) await slice.click()
  await slice.click()
  await expect(page.locator('#page-game')).toHaveClass(/\bvisible\b/)
}

function expectDarkStage(details) {
  expect(parseRgb(details.backgroundColor)).toEqual({ r: 10, g: 10, b: 15, a: 1 })
}

for (const colorScheme of ['light', 'dark']) {
  test(`phone tint is dark stage colour in a game (${colorScheme} theme)`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme })
    try {
      const page = await ctx.newPage()
      await setup(page)
      await page.goto('/', { waitUntil: 'networkidle' })
      if (colorScheme === 'light') expect(expectMatchingColors(await tintDetails(page))).toBeGreaterThan(200)
      await enterGame(page)
      const details = await tintDetails(page)
      expectDarkStage(details)
      await expect(page.locator('html')).toHaveAttribute('data-stage', 'dark')
      if (colorScheme === 'light') {
        expect(details.visibility).toBe('visible')
        expect(Number(details.zIndex)).toBeGreaterThan(10000)
        expect(parseHex(details.metaColor)).toEqual({ r: 244, g: 247, b: 251 })
        expect(parseHex(details.metaColor)).not.toEqual({ r: 10, g: 10, b: 15 })
      }
    } finally {
      await ctx.close()
    }
  })
}

test('phone tint transitions into and out of a game', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme: 'light' })
  try {
    const page = await ctx.newPage()
    await setup(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    expect(expectMatchingColors(await tintDetails(page))).toBeGreaterThan(200)
    await enterGame(page)
    expectDarkStage(await tintDetails(page))
    await expect(page.locator('html')).toHaveAttribute('data-stage', 'dark')
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
      expectDarkStage(await tintDetails(page))
    }
    await page.evaluate(() => window.switchToPage('play'))
    await expect(page.locator('html')).not.toHaveAttribute('data-stage')
    expect(expectMatchingColors(await tintDetails(page))).toBeGreaterThan(200)
  } finally {
    await ctx.close()
  }
})

test('phone tint is dark on direct load into a game URL', async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme: 'light' })
  try {
    const page = await ctx.newPage()
    await setup(page)
    await page.route('**/demo-config.json', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ areas: [{ id: 't', puzzleDate: new Date().toISOString().slice(0, 10), difficulties: {} }] }),
    }))
    await page.goto('/?demo=t-jigsaw', { waitUntil: 'domcontentloaded' })
    expectDarkStage(await tintDetails(page))
    expect(await page.locator('html').getAttribute('data-stage')).toBe('dark')
    await expect(page.locator('#page-game')).toHaveClass(/\bvisible\b/)
    expectDarkStage(await tintDetails(page))
  } finally {
    await ctx.close()
  }
})

for (const colorScheme of ['light', 'dark']) {
  test(`phone tint dims opaquely under the more-sheet (${colorScheme} theme)`, async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 12'], colorScheme })
    try {
      const page = await ctx.newPage()
      await setup(page)
      await page.goto('/', { waitUntil: 'networkidle' })
      await page.locator('.slice-more').click()
      await expect(page.locator('.more-sheet-overlay')).toHaveClass(/\bis-visible\b/)
      await page.waitForTimeout(400)
      const details = await tintDetails(page)
      const color = parseRgb(details.backgroundColor)
      const base = colorScheme === 'light' ? [244, 247, 251] : [10, 10, 15]
      expect(color.a).toBe(1)
      for (const [actual, channel] of [color.r, color.g, color.b].map((v, i) => [v, base[i]])) {
        expect(Math.abs(actual - Math.round(channel * 0.45))).toBeLessThanOrEqual(2)
      }
      const overlayZ = await page.locator('.more-sheet-overlay').evaluate((el) => getComputedStyle(el).zIndex)
      expect(Number(details.zIndex)).toBeGreaterThan(Number(overlayZ))
      expect(details.visibility).toBe('visible')
      expect(details.backgroundImage).toBe('none')
      await page.locator('.more-sheet-overlay').click({ position: { x: 2, y: 2 } })
      await page.waitForTimeout(400)
      expectMatchingColors(await tintDetails(page))
    } finally {
      await ctx.close()
    }
  })
}

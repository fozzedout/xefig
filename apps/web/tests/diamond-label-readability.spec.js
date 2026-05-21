import { expect, test } from '@playwright/test'

const TODAY_PAYLOAD = {
  date: '2026-05-19',
  categories: {
    jigsaw: { imageUrl: '/src/assets/hero.png' },
    slider: { imageUrl: '/src/assets/hero.png' },
    swap: { imageUrl: '/src/assets/hero.png' },
    polygram: { imageUrl: '/src/assets/hero.png' },
    diamond: { imageUrl: '/src/assets/hero.png' },
  },
}

async function openDiamondGame(page) {
  await page.route('**/api/puzzles/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TODAY_PAYLOAD) })
  })
  await page.goto('/', { waitUntil: 'networkidle' })
  const slice = page.locator('.slice[data-mode="diamond"]')
  await slice.waitFor()
  if (!(await slice.evaluate((el) => el.classList.contains('active')))) {
    await slice.click()
  }
  await slice.click()
  await page.locator('.diamond-canvas').waitFor()
  await page.waitForTimeout(800)  // let cells render
}

test('diamond label outline — current live variant', async ({ page }) => {
  await openDiamondGame(page)

  // Crop a zoomed-in patch of the canvas so we can SEE the label outline
  // at human-readable size instead of trying to read 10px text from a
  // device-pixel screenshot.
  const patchUrl = await page.evaluate(() => {
    const src = document.querySelector('.diamond-canvas')
    if (!src) return null
    // Find a region with labels — top-left has unfilled cells.
    const CELL_PX = 14  // matches diamond-painting-puzzle.js
    const cellsW = 12, cellsH = 8
    const sx = 0
    const sy = 0
    const sw = CELL_PX * cellsW
    const sh = CELL_PX * cellsH
    // Scale up 6× so the 10px label glyphs are roughly 60px tall.
    const scale = 6
    const out = document.createElement('canvas')
    out.width = sw * scale
    out.height = sh * scale
    const ctx = out.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  })
  expect(patchUrl).not.toBeNull()

  // Save the patch as a file we can eyeball.
  const buffer = Buffer.from(patchUrl.split(',')[1], 'base64')
  const fs = await import('node:fs/promises')
  await fs.mkdir('test-results', { recursive: true })
  await fs.writeFile('test-results/diamond-label-live.png', buffer)
})

test('diamond label outline — A/B compare variants on a probe canvas', async ({ page }) => {
  await openDiamondGame(page)

  // Reach into the puzzle to grab a real palette so the probe uses the
  // same colours the player would see. The puzzle attaches itself to
  // window via main.js as part of normal flow; if it isn't exposed,
  // fall back to a synthetic palette covering the luminance range.
  const result = await page.evaluate(() => {
    // Pick six representative palette entries: dark-cool, mid-warm,
    // mid-cool, light-warm, near-white, near-black. Mirrors a realistic
    // diamond palette without needing to inspect a live one.
    const palette = [
      [202, 132, 52],  // mid orange (the c15 from the actual session)
      [215, 152, 57],  // close orange (the c17 from the actual session)
      [131, 145, 132], // mid-tone grey-green
      [252, 244, 215], // light cream
      [41, 44, 41],    // near-black
      [49, 64, 51],    // dark green
    ]
    // Render a 4-row grid: each row a different outline variant, six
    // columns one per palette entry, showing the same two-digit label
    // ("18") so we can compare silhouette clarity row-to-row.
    const labels = ['16', '18', '20', '11', '5', '2']
    const CELL = 14
    const SCALE = 6
    const cs = CELL * SCALE
    // Each variant declares its stroke characteristics in *native* CSS
    // pixels (i.e. what the player would see). The probe scales those
    // up by SCALE for the screenshot so we read the proportions, not
    // the absolute pixel count.
    const variants = [
      { name: 'live (2.2 dark @ 0.6)',   strokeWidth: 2.2, strokeStyle: 'rgba(20, 18, 12, 0.6)' },
      { name: 'thin (1.0 dark @ 0.55)',  strokeWidth: 1.0, strokeStyle: 'rgba(20, 18, 12, 0.55)' },
      { name: 'hairline (0.6 black)',    strokeWidth: 0.6, strokeStyle: 'rgba(0, 0, 0, 0.9)' },
      { name: 'cream halo (2.0)',        strokeWidth: 2.0, strokeStyle: 'rgba(245, 243, 238, 1.0)' },
      { name: 'baseline (no outline)',   strokeWidth: 0,   strokeStyle: null },
    ]

    const out = document.createElement('canvas')
    out.width = cs * palette.length
    out.height = (cs + 36) * variants.length  // header + cell-row per variant
    const ctx = out.getContext('2d')
    ctx.imageSmoothingEnabled = true

    let cursorY = 0
    for (const v of variants) {
      // Variant header
      ctx.fillStyle = '#000'
      ctx.font = '600 20px sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(v.name, 4, cursorY + 4)
      cursorY += 28

      for (let i = 0; i < palette.length; i++) {
        const color = palette[i]
        const label = labels[i]
        const x = i * cs
        const y = cursorY
        // Cream cell background (matches the production code)
        ctx.fillStyle = 'rgba(245,243,238,1)'
        ctx.fillRect(x, y, cs, cs)
        // Label
        const lum = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
        ctx.font = `600 ${10 * SCALE}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        if (v.strokeWidth > 0 && v.strokeStyle) {
          // Scale stroke width once — the SCALE factor matches the
          // font scale, preserving the strokeWidth/fontSize ratio the
          // player would see.
          ctx.lineWidth = v.strokeWidth * SCALE
          ctx.lineJoin = 'round'
          ctx.miterLimit = 2
          ctx.strokeStyle = v.strokeStyle
          ctx.strokeText(label, x + cs / 2, y + cs / 2)
        }
        ctx.fillStyle = lum > 180
          ? `rgb(${color[0] >> 1},${color[1] >> 1},${color[2] >> 1})`
          : `rgb(${color[0]},${color[1]},${color[2]})`
        ctx.fillText(label, x + cs / 2, y + cs / 2)
      }
      cursorY += cs + 8
    }
    return out.toDataURL('image/png')
  })

  const buffer = Buffer.from(result.split(',')[1], 'base64')
  const fs = await import('node:fs/promises')
  await fs.mkdir('test-results', { recursive: true })
  await fs.writeFile('test-results/diamond-label-variants.png', buffer)
})

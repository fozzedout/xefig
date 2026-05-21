import { expect, test } from '@playwright/test'

// Verify the label-silhouette de-collide pass at the algorithm level:
// construct a palette that REPRODUCES the 2026-05-18 failure (two close
// oranges ending up at indices 15 and 17 = labels 16 and 18), run the
// pass, and assert the swap happened.
test('decollideLabelSilhouettes splits same-tens confusable pairs', async ({ page }) => {
  // Need to hit the dev server (vite) so module imports resolve.
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const mod = await import('/src/components/diamond-painting-puzzle.js')
    const { decollideLabelSilhouettes } = mod

    // 24-colour palette synthesised from the real 2026-05-18 session's
    // RGB triples. Pre-sorted ascending luminance so the two close
    // oranges land at indices 15 and 17 (labels 16, 18) — same tens
    // digit, perceptual Δ ≈ 25.
    const palette = [
      [41, 34, 15],   // 1
      [41, 44, 41],   // 2
      [63, 37, 11],   // 3
      [86, 54, 19],   // 4
      [80, 72, 49],   // 5
      [97, 86, 50],   // 6
      [135, 78, 33],  // 7
      [113, 97, 65],  // 8
      [133, 101, 48], // 9
      [153, 93, 49],  // 10
      [120, 111, 80], // 11
      [142, 116, 61], // 12
      [162, 133, 83], // 13
      [189, 125, 78], // 14
      [162, 146, 111],// 15
      [202, 132, 52], // 16  ← orange A
      [177, 163, 111],// 17
      [215, 152, 57], // 18  ← orange B (Δ≈25 from index 15 in this layout)
      [198, 180, 126],// 19
      [235, 180, 88], // 20
      [209, 201, 170],// 21
      [246, 215, 161],// 22
      [244, 227, 189],// 23
      [252, 244, 215],// 24
    ]
    // Snapshot pre-state.
    const before = palette.map((c) => [...c])

    // Run the de-collide.
    decollideLabelSilhouettes(palette)

    // Helper: find an rgb tuple in the palette → new index.
    const findIndex = (rgb) => palette.findIndex((c) => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2])
    const orangeAOld = 15  // [202, 132, 52]
    const orangeBOld = 17  // [215, 152, 57]
    const orangeANew = findIndex(before[orangeAOld])
    const orangeBNew = findIndex(before[orangeBOld])

    // Count same-tens collisions in both states (using a simple
    // "labels share tens digit AND Δ < 70" check, mirroring the
    // function's own definition).
    const redmean = (a, b) => {
      const rMean = (a[0] + b[0]) / 2
      const dr = a[0] - b[0]
      const dg = a[1] - b[1]
      const db = a[2] - b[2]
      return Math.sqrt(
        (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db,
      )
    }
    const countCollisions = (pal) => {
      let n = 0
      for (let i = 0; i < pal.length; i++) {
        for (let j = i + 1; j < pal.length; j++) {
          const a = i + 1, b = j + 1
          if (a >= 10 && b >= 10 && Math.floor(a / 10) === Math.floor(b / 10)) {
            if (redmean(pal[i], pal[j]) < 50) n++  // matches decollideLabelSilhouettes' threshold
          }
        }
      }
      return n
    }

    // Build a side-by-side swatch render so a human can eyeball how much
    // luminance order survives the de-collide pass.
    const SW = 80, ROW = 60
    const out = document.createElement('canvas')
    out.width = SW * palette.length + 80
    out.height = ROW * 2 + 40
    const ctx = out.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.fillStyle = '#000'
    ctx.font = '600 16px sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText('before', 4, 16)
    ctx.fillText('after', 4, ROW + 36)
    for (let i = 0; i < palette.length; i++) {
      const cb = before[i]
      ctx.fillStyle = `rgb(${cb[0]},${cb[1]},${cb[2]})`
      ctx.fillRect(80 + i * SW, 4, SW - 4, ROW - 4)
      ctx.fillStyle = '#000'
      ctx.font = '600 14px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), 80 + i * SW + (SW - 4) / 2, ROW + 8)
      const ca = palette[i]
      ctx.fillStyle = `rgb(${ca[0]},${ca[1]},${ca[2]})`
      ctx.fillRect(80 + i * SW, ROW + 16, SW - 4, ROW - 4)
      ctx.fillStyle = '#000'
      ctx.fillText(String(i + 1), 80 + i * SW + (SW - 4) / 2, ROW * 2 + 20)
    }
    const swatchUrl = out.toDataURL('image/png')

    return {
      before_collisions: countCollisions(before),
      after_collisions: countCollisions(palette),
      orangeA: { old_index: orangeAOld, new_index: orangeANew, old_label: orangeAOld + 1, new_label: orangeANew + 1 },
      orangeB: { old_index: orangeBOld, new_index: orangeBNew, old_label: orangeBOld + 1, new_label: orangeBNew + 1 },
      swatchUrl,
    }
  })

  const fs = await import('node:fs/promises')
  await fs.mkdir('test-results', { recursive: true })
  await fs.writeFile('test-results/diamond-label-decollide.png',
    Buffer.from(result.swatchUrl.split(',')[1], 'base64'))
  console.log(JSON.stringify(result, null, 2))

  // Hard assertion: the pass must strictly reduce collisions, ideally
  // to zero for this seed.
  expect(result.after_collisions).toBeLessThan(result.before_collisions)
  // The two oranges had label-tens collision before (both teens). They
  // should no longer share a tens digit (one moves to single-digit or
  // twenties).
  const orangeATens = Math.floor(result.orangeA.new_label / 10)
  const orangeBTens = Math.floor(result.orangeB.new_label / 10)
  expect(orangeATens === orangeBTens && result.orangeA.new_label >= 10).toBe(false)
})

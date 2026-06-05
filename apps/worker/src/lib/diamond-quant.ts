// Worker-side port of the in-game diamond quantization, used to detect a
// "too simple" puzzle (one giant flat region → fill it and you're done) at
// generation time so the batch pipeline can auto-regenerate it.
//
// This MIRRORS the production client path in
// apps/web/src/components/diamond-painting-puzzle.js (the source of truth the
// player actually sees): sampleCellRegions → samplePixelsForPalette →
// createDistinctPalette(default knobs) → assignCellColors(no dither) →
// cleanupTinyRegions(level 1). The canvas-based samplers are replaced with
// nearest-neighbour reads of a decoded RGBA buffer; everything downstream is
// copied verbatim. Region geometry is invariant to palette ORDER, so the
// label-only steps (sortPaletteDarkToLight, decollideLabelSilhouettes) and the
// admin-only splitLargeRegions are intentionally omitted.
//
// Keep these constants in lock-step with diamond-painting-puzzle.js.

import { decodeImage, type RgbaImage } from './image'
import UPNG from 'upng-js'

const DIAMOND_TARGET_CELLS = 15000
const DIAMOND_NUM_COLORS = 24
const DIAMOND_MIN_DIM = 20
const DIAMOND_SAMPLE_GRID = 3
const CLEANUP_MIN_REGION = 2
const PALETTE_SAMPLE_COUNT = 20000
const PALETTE_MAX_DIM = 1024

// ─── Gate thresholds ──────────────────────────────────────────────────────
// largest-region fraction is the headline "too easy" tell: across known-good
// diamonds the biggest region was ≤8% of cells; a too-simple one (2026-06-12)
// hit 35%. The secondary catches the rarer "few mostly-big regions" shape.
const TOO_SIMPLE_LARGEST_FRACTION = 0.20
const TOO_SIMPLE_REGION_COUNT = 450
const TOO_SIMPLE_BIG_SHARE = 0.74

type Rgb = [number, number, number]
type Candidate = { color: Rgb; lab: Rgb; weight: number }
type CellSample = { samples: number[][]; representative: Rgb }

// ─── Colour space (verbatim) ──────────────────────────────────────────────
function srgbToLinear(value: number): number {
  if (value <= 0.04045) return value / 12.92
  return ((value + 0.055) / 1.055) ** 2.4
}

function rgbToOklab(rgb: number[]): Rgb {
  const r = srgbToLinear(rgb[0] / 255)
  const g = srgbToLinear(rgb[1] / 255)
  const b = srgbToLinear(rgb[2] / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ]
}

function oklabDistSq(a: Rgb | number[], b: Rgb | number[]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

// ─── Channel reducers (verbatim) ──────────────────────────────────────────
function meanChannel(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return Math.round(sum / values.length)
}

// ─── RGBA samplers (canvas replaced with nearest-neighbour buffer reads) ──
function sampleCellRegions(image: RgbaImage, cols: number, rows: number, sampleGrid: number): CellSample[] {
  const { width: srcW, height: srcH, data } = image
  const canvasW = cols * sampleGrid
  const canvasH = rows * sampleGrid
  const regions: CellSample[] = new Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const samples: number[][] = []
      const reds: number[] = []
      const greens: number[] = []
      const blues: number[] = []
      for (let sy = 0; sy < sampleGrid; sy++) {
        for (let sx = 0; sx < sampleGrid; sx++) {
          const px = col * sampleGrid + sx
          const py = row * sampleGrid + sy
          const ssx = Math.min(srcW - 1, Math.floor(((px + 0.5) * srcW) / canvasW))
          const ssy = Math.min(srcH - 1, Math.floor(((py + 0.5) * srcH) / canvasH))
          const off = (ssy * srcW + ssx) * 4
          if (data[off + 3] < 128) continue
          samples.push([data[off], data[off + 1], data[off + 2]])
          reds.push(data[off]); greens.push(data[off + 1]); blues.push(data[off + 2])
        }
      }
      if (samples.length === 0) { samples.push([255, 255, 255]); reds.push(255); greens.push(255); blues.push(255) }
      regions[row * cols + col] = { samples, representative: [meanChannel(reds), meanChannel(greens), meanChannel(blues)] }
    }
  }
  return regions
}

function samplePixelsForPalette(image: RgbaImage, sampleCount = PALETTE_SAMPLE_COUNT, maxDim = PALETTE_MAX_DIM): number[][] {
  const { width: srcW, height: srcH, data } = image
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))
  const total = w * h
  const stride = Math.max(1, Math.floor(total / sampleCount))
  const pixels: number[][] = []
  for (let i = 0; i < total && pixels.length < sampleCount; i += stride) {
    const dx = i % w
    const dy = (i / w) | 0
    const sx = Math.min(srcW - 1, Math.floor(((dx + 0.5) * srcW) / w))
    const sy = Math.min(srcH - 1, Math.floor(((dy + 0.5) * srcH) / h))
    const off = (sy * srcW + sx) * 4
    pixels.push([data[off], data[off + 1], data[off + 2]])
  }
  return pixels
}

// ─── Palette construction (verbatim; production knobs baked: no chroma/reserve/floor) ──
function medianCutBoxes(pixels: number[][], targetColors: number): { pixels: number[][] }[] {
  if (pixels.length === 0) {
    return [{
      pixels: Array.from({ length: targetColors }, (_, i) => {
        const v = Math.round((i / Math.max(1, targetColors - 1)) * 255)
        return [v, v, v]
      }),
    }]
  }
  let boxes: { pixels: number[][] }[] = [{ pixels: pixels.slice() }]
  while (boxes.length < targetColors) {
    let bestBox = -1
    let bestScore = -1
    let bestChannel = 0
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b]
      if (box.pixels.length < 2) continue
      for (let ch = 0; ch < 3; ch++) {
        let min = 255
        let max = 0
        for (const px of box.pixels) {
          if (px[ch] < min) min = px[ch]
          if (px[ch] > max) max = px[ch]
        }
        const range = max - min
        const score = range * Math.sqrt(box.pixels.length)
        if (score > bestScore) { bestScore = score; bestBox = b; bestChannel = ch }
      }
    }
    if (bestBox === -1) break
    const box = boxes[bestBox]
    box.pixels.sort((a, b) => a[bestChannel] - b[bestChannel])
    const mid = Math.floor(box.pixels.length / 2)
    boxes.splice(bestBox, 1, { pixels: box.pixels.slice(0, mid) }, { pixels: box.pixels.slice(mid) })
  }
  return boxes
}

// Chroma-weighted centroid: saturated pixels pull the representative toward
// themselves instead of being averaged out by the grey majority.
function boxAvg(box: { pixels: number[][] }): Rgb {
  if (box.pixels.length === 0) return [128, 128, 128]
  let r = 0, g = 0, b = 0, w = 0
  for (const px of box.pixels) {
    const lab = rgbToOklab(px)
    const chroma = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2])
    const weight = 1 + chroma * 30
    r += px[0] * weight; g += px[1] * weight; b += px[2] * weight; w += weight
  }
  return [Math.round(r / w), Math.round(g / w), Math.round(b / w)]
}

function mergeNearbyCandidates(candidates: Candidate[], minDistance: number, minKeep = 0): Candidate[] {
  const items = candidates.slice()
  const minDistanceSq = minDistance ** 2
  while (items.length > minKeep) {
    let bestI = -1, bestJ = -1, bestDist = minDistanceSq
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const d = oklabDistSq(items[i].lab, items[j].lab)
        if (d < bestDist) { bestDist = d; bestI = i; bestJ = j }
      }
    }
    if (bestI === -1) break
    const a = items[bestI]
    const b = items[bestJ]
    const totalWeight = a.weight + b.weight
    const color: Rgb = [
      Math.round((a.color[0] * a.weight + b.color[0] * b.weight) / totalWeight),
      Math.round((a.color[1] * a.weight + b.color[1] * b.weight) / totalWeight),
      Math.round((a.color[2] * a.weight + b.color[2] * b.weight) / totalWeight),
    ]
    items.splice(bestJ, 1)
    items.splice(bestI, 1)
    items.push({ color, lab: rgbToOklab(color), weight: totalWeight })
  }
  return items.sort((a, b) => b.weight - a.weight)
}

// Farthest-first selection with the production defaults (chromaWeight=0,
// chromaReserve=0, consolidateFloor=0) baked in.
function selectDistinctCandidates(candidates: Candidate[], targetColors: number): Candidate[] {
  if (candidates.length <= targetColors) return candidates
  const selected: Candidate[] = []
  const remaining = candidates.slice()
  const maxWeight = remaining.reduce((max, c) => Math.max(max, c.weight), 1)
  // Anchor: highest-weight remaining candidate
  let maxIdx = 0
  for (let i = 1; i < remaining.length; i++) if (remaining[i].weight > remaining[maxIdx].weight) maxIdx = i
  selected.push(remaining.splice(maxIdx, 1)[0])
  // Second anchor: candidate furthest from the first
  if (selected.length < targetColors && remaining.length > 0) {
    let bestIndex = 0, bestDistance = -1
    for (let i = 0; i < remaining.length; i++) {
      const distance = oklabDistSq(selected[0].lab, remaining[i].lab)
      if (distance > bestDistance) { bestDistance = distance; bestIndex = i }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }
  while (selected.length < targetColors && remaining.length > 0) {
    let bestIndex = 0, bestScore = -1
    for (let i = 0; i < remaining.length; i++) {
      let minDistance = Infinity
      for (const candidate of selected) minDistance = Math.min(minDistance, oklabDistSq(candidate.lab, remaining[i].lab))
      const weightFactor = 0.7 + 0.3 * (remaining[i].weight / maxWeight)
      const score = minDistance * weightFactor
      if (score > bestScore) { bestScore = score; bestIndex = i }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }
  return selected
}

function createDistinctPalette(pixels: number[][], targetColors: number): Rgb[] {
  const boxes = medianCutBoxes(pixels, targetColors * 4)
  const candidates: Candidate[] = boxes.map((box) => {
    const color = boxAvg(box)
    return { color, lab: rgbToOklab(color), weight: box.pixels.length }
  })
  const minKeep = Math.min(candidates.length, targetColors * 2)
  const merged = mergeNearbyCandidates(candidates, 0.05, minKeep)
  return selectDistinctCandidates(merged, targetColors).map((c) => c.color)
}

// ─── Cell assignment (verbatim, no-dither vote path) ──────────────────────
function nearestPaletteIndex(color: number[], paletteLabs: Rgb[]): number {
  const lab = rgbToOklab(color)
  let bestDist = Infinity
  let bestIdx = 0
  for (let p = 0; p < paletteLabs.length; p++) {
    const dist = oklabDistSq(lab, paletteLabs[p])
    if (dist < bestDist) { bestDist = dist; bestIdx = p }
  }
  return bestIdx
}

function assignCellColors(cellSamples: CellSample[], palette: Rgb[]): Uint8Array {
  const result = new Uint8Array(cellSamples.length)
  const paletteLabs = palette.map((color) => rgbToOklab(color))
  for (let i = 0; i < cellSamples.length; i++) {
    const votes = new Uint16Array(palette.length)
    for (const sample of cellSamples[i].samples) votes[nearestPaletteIndex(sample, paletteLabs)]++
    const representativeLab = rgbToOklab(cellSamples[i].representative)
    const representativeIndex = nearestPaletteIndex(cellSamples[i].representative, paletteLabs)
    let bestIndex = representativeIndex
    let bestVotes = -1
    let bestDistance = Infinity
    for (let p = 0; p < palette.length; p++) {
      const distance = oklabDistSq(representativeLab, paletteLabs[p])
      if (
        votes[p] > bestVotes ||
        (votes[p] === bestVotes && distance < bestDistance) ||
        (votes[p] === bestVotes && distance === bestDistance && p === representativeIndex)
      ) {
        bestIndex = p; bestVotes = votes[p]; bestDistance = distance
      }
    }
    result[i] = bestIndex
  }
  return result
}

// ─── Cleanup (verbatim) ───────────────────────────────────────────────────
function cleanupTinyRegionsPass(grid: Uint8Array, cols: number, rows: number, minRegion: number): Uint8Array {
  const total = grid.length
  const visited = new Uint8Array(total)
  const result = new Uint8Array(grid)
  const region: number[] = []
  for (let start = 0; start < total; start++) {
    if (visited[start]) continue
    const color = grid[start]
    region.length = 0
    const stack = [start]
    visited[start] = 1
    while (stack.length > 0) {
      const idx = stack.pop() as number
      region.push(idx)
      const r = (idx / cols) | 0
      const c = idx - r * cols
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const nr = r + dr, nc = c + dc
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
          const n = nr * cols + nc
          if (!visited[n] && grid[n] === color) { visited[n] = 1; stack.push(n) }
        }
      }
    }
    if (region.length >= minRegion) continue
    const counts = new Map<number, number>()
    for (const idx of region) {
      const r = (idx / cols) | 0
      const c = idx - r * cols
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const nr = r + dr, nc = c + dc
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
          const neighbourColor = result[nr * cols + nc]
          if (neighbourColor === color) continue
          counts.set(neighbourColor, (counts.get(neighbourColor) || 0) + 1)
        }
      }
    }
    if (counts.size === 0) continue
    let bestColor = color
    let bestCount = -1
    for (const [cc, count] of counts) if (count > bestCount) { bestCount = count; bestColor = cc }
    for (const idx of region) result[idx] = bestColor
  }
  return result
}

function cleanupTinyRegions(grid: Uint8Array, cols: number, rows: number, minRegion: number): Uint8Array {
  const MAX_PASSES = 5
  let current = grid
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = cleanupTinyRegionsPass(current, cols, rows, minRegion)
    let changed = false
    for (let i = 0; i < current.length; i++) if (current[i] !== next[i]) { changed = true; break }
    if (!changed) return next
    current = next
  }
  return current
}

// ─── Region stats (verbatim, 8-dir flood fill) ────────────────────────────
function computeRegionStats(grid: Uint8Array, cols: number, rows: number): { regionCount: number; largestRegionFraction: number; sizes: number[] } {
  const total = grid.length
  const visited = new Uint8Array(total)
  const stack: number[] = []
  const sizes: number[] = []
  let largestSize = 0
  for (let start = 0; start < total; start++) {
    if (visited[start]) continue
    const color = grid[start]
    let size = 0
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length > 0) {
      const idx = stack.pop() as number
      size++
      const r = (idx / cols) | 0
      const c = idx - r * cols
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue
          const nr = r + dr, nc = c + dc
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue
          const n = nr * cols + nc
          if (!visited[n] && grid[n] === color) { visited[n] = 1; stack.push(n) }
        }
      }
    }
    sizes.push(size)
    if (size > largestSize) largestSize = size
  }
  return { regionCount: sizes.length, largestRegionFraction: total > 0 ? largestSize / total : 0, sizes }
}

// ─── Public API ───────────────────────────────────────────────────────────
export type DiamondComplexity = {
  cols: number
  rows: number
  totalCells: number
  paletteSize: number
  regionCount: number
  largestRegionFraction: number
  bigRegionShare: number
  tooSimple: boolean
  // The quantized grid (cell -> palette index) + palette (RGB), exposed so the
  // caller can render the finished-puzzle preview for the vision coherence check.
  grid: Uint8Array
  palette: number[][]
}

export function analyzeDiamondComplexity(image: RgbaImage): DiamondComplexity {
  const aspect = image.width / image.height
  const cols = Math.max(DIAMOND_MIN_DIM, Math.round(Math.sqrt(DIAMOND_TARGET_CELLS * aspect)))
  const rows = Math.max(DIAMOND_MIN_DIM, Math.round(DIAMOND_TARGET_CELLS / cols))
  const total = cols * rows

  const cellSamples = sampleCellRegions(image, cols, rows, DIAMOND_SAMPLE_GRID)
  const palettePixels = samplePixelsForPalette(image)
  const palette = createDistinctPalette(palettePixels, DIAMOND_NUM_COLORS)
  const rawGrid = assignCellColors(cellSamples, palette)
  const grid = cleanupTinyRegions(rawGrid, cols, rows, CLEANUP_MIN_REGION)

  const { regionCount, largestRegionFraction, sizes } = computeRegionStats(grid, cols, rows)
  let bigCells = 0
  for (const s of sizes) if (s >= 65) bigCells += s
  const bigRegionShare = total > 0 ? bigCells / total : 0

  const tooSimple =
    largestRegionFraction > TOO_SIMPLE_LARGEST_FRACTION ||
    (regionCount < TOO_SIMPLE_REGION_COUNT && bigRegionShare > TOO_SIMPLE_BIG_SHARE)

  return { cols, rows, totalCells: total, paletteSize: palette.length, regionCount, largestRegionFraction, bigRegionShare, tooSimple, grid, palette }
}

// Render the quantized grid to a PNG (each cell its flat palette colour,
// upscaled scale×). This is the "finished puzzle" image — exactly what the
// player ends up with — that the Gemini vision check judges for coherence.
export function renderQuantizedPng(grid: Uint8Array, palette: number[][], cols: number, rows: number, scale = 4): Uint8Array {
  const w = cols * scale
  const h = rows * scale
  const rgba = new Uint8Array(w * h * 4)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const p = palette[grid[row * cols + col]] ?? [0, 0, 0]
      for (let dy = 0; dy < scale; dy++) {
        const y = row * scale + dy
        for (let dx = 0; dx < scale; dx++) {
          const off = (y * w + (col * scale + dx)) * 4
          rgba[off] = p[0]; rgba[off + 1] = p[1]; rgba[off + 2] = p[2]; rgba[off + 3] = 255
        }
      }
    }
  }
  return new Uint8Array(UPNG.encode([rgba.buffer], w, h, 0))
}

// Decode raw PNG/JPEG bytes and return the complexity verdict. Throws if the
// bytes can't be decoded — callers should treat a throw as "don't gate".
export function detectTooSimpleDiamond(imageBytes: Uint8Array): DiamondComplexity {
  return analyzeDiamondComplexity(decodeImage(imageBytes))
}

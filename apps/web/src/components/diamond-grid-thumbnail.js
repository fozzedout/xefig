import { loadImage, releaseLoadedImage } from './image-loader.js'
import {
  sampleCellRegions,
  createDistinctPalette,
  sortPaletteDarkToLight,
  assignCellColors,
} from './diamond-painting-puzzle.js'

const TARGET_CELLS = 10000
const NUM_COLORS = 16
const MIN_COLS = 20
const MIN_ROWS = 20
const CELL_SAMPLE_GRID = 3

const GHOST_BG = [245, 243, 238]

/**
 * Render a diamond-painting grid thumbnail onto a canvas.
 *
 * If `savedState` is provided (from an active run's puzzleState), it draws
 * the grid with progress — filled cells as solid colour, unfilled as ghost
 * cells with colour-tinted numbers.
 *
 * If no savedState, loads the image at `imageUrl`, quantizes it, and draws
 * the full ghost grid (not-started) or full mosaic (completed).
 */
export async function renderDiamondSliceThumbnail(canvas, { imageUrl, savedState, isCompleted }) {
  let cols, rows, palette, grid, fills

  if (savedState?.grid && savedState?.palette) {
    cols = savedState.cols
    rows = savedState.rows
    palette = savedState.palette
    grid = savedState.grid
    fills = savedState.fills
  } else if (imageUrl) {
    const quantized = await quantizeFromImage(imageUrl)
    if (!quantized) return
    cols = quantized.cols
    rows = quantized.rows
    palette = quantized.palette
    grid = quantized.grid
    // Completed: all cells filled correctly. Otherwise: all empty.
    fills = isCompleted
      ? Array.from(grid)
      : new Array(grid.length).fill(-1)
  } else {
    return
  }

  drawGrid(canvas, cols, rows, palette, grid, fills)
}

async function quantizeFromImage(imageUrl) {
  let image
  try {
    image = await loadImage(imageUrl)
  } catch {
    return null
  }

  try {
    const aspect = image.naturalWidth / image.naturalHeight
    const cols = Math.max(MIN_COLS, Math.round(Math.sqrt(TARGET_CELLS * aspect)))
    const rows = Math.max(MIN_ROWS, Math.round(TARGET_CELLS / cols))

    const cellSamples = sampleCellRegions(image, cols, rows, CELL_SAMPLE_GRID)
    const pixels = cellSamples.map((cell) => cell.representative)
    const palette = createDistinctPalette(pixels, NUM_COLORS)
    sortPaletteDarkToLight(palette)
    const grid = assignCellColors(cellSamples, palette)

    return { cols, rows, palette, grid: Array.from(grid) }
  } finally {
    releaseLoadedImage(image)
  }
}

function drawGrid(canvas, cols, rows, palette, grid, fills) {
  // One pixel per cell — CSS object-fit:cover + image-rendering:pixelated
  // scales this up to the container size with crisp edges.
  canvas.width = cols
  canvas.height = rows

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const imageData = ctx.createImageData(cols, rows)
  const data = imageData.data

  for (let i = 0; i < grid.length; i++) {
    const fill = fills[i]
    const off = i * 4
    let r, g, b

    if (fill >= 0 && fill < palette.length) {
      const c = palette[fill]
      r = c[0]; g = c[1]; b = c[2]
    } else {
      const c = palette[grid[i]]
      r = Math.round(GHOST_BG[0] * 0.82 + c[0] * 0.18)
      g = Math.round(GHOST_BG[1] * 0.82 + c[1] * 0.18)
      b = Math.round(GHOST_BG[2] * 0.82 + c[2] * 0.18)
    }

    data[off] = r
    data[off + 1] = g
    data[off + 2] = b
    data[off + 3] = 255
  }

  ctx.putImageData(imageData, 0, 0)
}

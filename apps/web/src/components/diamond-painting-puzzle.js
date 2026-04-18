import { loadImage, releaseLoadedImage } from './image-loader.js'

const TARGET_CELLS = 10000
const NUM_COLORS = 16
const MIN_COLS = 20
const MIN_ROWS = 20
const CELL_PX = 24
const CELL_SAMPLE_GRID = 3
const MIN_ZOOM = 0.3
const MAX_ZOOM = 3
const MAX_CANVAS_DIMENSION = 4096
const MAX_CANVAS_PIXELS = 4096 * 4096

export class DiamondPaintingPuzzle {
  constructor({ container, imageUrl, difficulty = 'medium', onComplete, onProgress }) {
    if (!container) {
      throw new Error('DiamondPaintingPuzzle requires a container element.')
    }

    this.container = container
    this.imageUrl = imageUrl
    this.difficulty = difficulty
    this.onComplete = onComplete
    this.onProgress = onProgress

    this.completed = false
    this.referenceVisible = false
    this.displayImageUrl = imageUrl
    this.selectedColor = 0

    this.cols = 0
    this.rows = 0
    this.palette = []
    this.grid = null
    this.fills = null

    this.pieces = []

    // Zoom / pan state
    this._showDetail = false
    this.zoom = 1
    this.panX = 0
    this.panY = 0

    // Interaction state
    this.filling = false
    this.pointers = new Map()
    this.dragging = false
    this.dragStartX = 0
    this.dragStartY = 0
    this.panStartX = 0
    this.panStartY = 0
    this.pinchStartDist = 0
    this.pinchStartZoom = 1
    this.didDrag = false

    this.handleWindowResize = () => this.onWindowResize()
    this.handleWindowResume = () => this.onWindowResume()
  }

  async init() {
    this.destroy()

    this.image = await loadImage(this.imageUrl)
    this.displayImageUrl = this.image.currentSrc || this.image.src || this.imageUrl

    const aspect = this.image.naturalWidth / this.image.naturalHeight
    this.cols = Math.max(MIN_COLS, Math.round(Math.sqrt(TARGET_CELLS * aspect)))
    this.rows = Math.max(MIN_ROWS, Math.round(TARGET_CELLS / this.cols))
    this.totalCells = this.cols * this.rows

    const cellSamples = sampleCellRegions(this.image, this.cols, this.rows, CELL_SAMPLE_GRID)
    const pixels = cellSamples.map((cell) => cell.representative)
    this.palette = createDistinctPalette(pixels, NUM_COLORS)
    sortPaletteDarkToLight(this.palette)
    this.grid = assignCellColors(cellSamples, this.palette)
    this.fills = new Int8Array(this.totalCells).fill(-1)

    this.createLayout()
    this.fitZoom()
    this.drawGrid()

    this.completed = this.isComplete()
    this.setReferenceVisible(false)
    this.emitProgress()

    window.addEventListener('resize', this.handleWindowResize)
    window.addEventListener('focus', this.handleWindowResume)
    window.addEventListener('pageshow', this.handleWindowResume)
    document.addEventListener('visibilitychange', this.handleWindowResume)
  }

  destroy() {
    clearTimeout(this._fillTimer)
    this.filling = false
    window.removeEventListener('resize', this.handleWindowResize)
    window.removeEventListener('focus', this.handleWindowResume)
    window.removeEventListener('pageshow', this.handleWindowResume)
    document.removeEventListener('visibilitychange', this.handleWindowResume)

    if (this.canvas) {
      this.canvas.removeEventListener('pointerdown', this._onPointerDown)
      this.canvas.removeEventListener('pointermove', this._onPointerMove)
      this.canvas.removeEventListener('pointerup', this._onPointerUp)
      this.canvas.removeEventListener('pointercancel', this._onPointerUp)
      this.canvas.removeEventListener('wheel', this._onWheel)
    }

    this.pointers.clear()
    this.palette = []
    this.grid = null
    this.fills = null
    this.pieces = []
    releaseLoadedImage(this.image)
    this.image = null
    this.displayImageUrl = this.imageUrl
    this.container.innerHTML = ''
  }

  // ─── Layout ───

  getViewport() {
    const w = (this.boardFrame && this.boardFrame.clientWidth) || this.container.clientWidth || window.innerWidth
    const h = (this.boardFrame && this.boardFrame.clientHeight) || this.container.clientHeight || window.innerHeight
    return {
      w: Math.max(240, w),
      h: Math.max(180, h),
    }
  }

  fitZoom() {
    const vp = this.getViewport()
    this.zoom = this.getFitZoom(vp)
    const fullW = this.cols * CELL_PX
    const fullH = this.rows * CELL_PX
    this.panX = (vp.w - fullW * this.zoom) / 2
    this.panY = (vp.h - fullH * this.zoom) / 2
    this.applyTransform()
  }

  getFitZoom(vp = this.getViewport()) {
    const fullW = this.cols * CELL_PX
    const fullH = this.rows * CELL_PX
    return Math.min(vp.w / fullW, vp.h / fullH, 1)
  }

  getMinZoom(vp = this.getViewport()) {
    return Math.min(MIN_ZOOM, this.getFitZoom(vp))
  }

  // Returns the inset (in root-relative px) occupied by the palette on
  // whichever side it hugs. Used by clampPan so that, when zoomed in,
  // the user can pan cells that are under the palette into the open
  // interactive area above/beside it.
  getPaletteInsets() {
    const insets = { top: 0, right: 0, bottom: 0, left: 0 }
    if (!this.paletteBar || !this.root) return insets
    const rootRect = this.root.getBoundingClientRect()
    const palRect = this.paletteBar.getBoundingClientRect()
    if (palRect.width === 0 || palRect.height === 0) return insets
    const distTop = Math.abs(palRect.top - rootRect.top)
    const distBottom = Math.abs(rootRect.bottom - palRect.bottom)
    const distLeft = Math.abs(palRect.left - rootRect.left)
    const distRight = Math.abs(rootRect.right - palRect.right)
    if (palRect.width >= rootRect.width - 2) {
      // Palette spans full width — it's on top or bottom.
      if (distTop < distBottom) insets.top = palRect.height
      else insets.bottom = palRect.height
    } else if (palRect.height >= rootRect.height - 2) {
      // Palette spans full height — left or right column.
      if (distLeft < distRight) insets.left = palRect.width
      else insets.right = palRect.width
    }
    return insets
  }

  createLayout() {
    this.root = document.createElement('section')
    this.root.className = 'diamond-root'

    this.boardFrame = document.createElement('div')
    this.boardFrame.className = 'diamond-board-frame'
    this.boardContent = document.createElement('div')
    this.boardContent.className = 'diamond-board-content'

    const fullW = this.cols * CELL_PX
    const fullH = this.rows * CELL_PX
    this.boardContent.style.width = `${fullW}px`
    this.boardContent.style.height = `${fullH}px`

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'diamond-canvas'

    configureCanvas(this.canvas, fullW, fullH)
    this.ctx = this.canvas.getContext('2d')

    this.referenceImage = document.createElement('img')
    this.referenceImage.className = 'diamond-reference'
    this.referenceImage.src = this.displayImageUrl
    this.referenceImage.alt = 'Reference image'

    this.boardContent.append(this.canvas, this.referenceImage)
    this.boardFrame.append(this.boardContent)

    this.paletteBar = this.createPaletteBar()
    this.root.append(this.boardFrame, this.paletteBar)
    this.container.append(this.root)

    this.bindEvents()
  }

  applyTransform() {
    if (this.boardContent) {
      this.boardContent.style.transform = `translate(${this.panX}px,${this.panY}px) scale(${this.zoom})`
    }
    const showDetail = this.zoom > 1
    if (showDetail !== this._showDetail) {
      this._showDetail = showDetail
      if (this.grid) this.drawGrid()
    }
  }

  clampPan() {
    const vp = this.getViewport()
    const ins = this.getPaletteInsets()
    const fullW = this.cols * CELL_PX * this.zoom
    const fullH = this.rows * CELL_PX * this.zoom

    if (fullW <= vp.w) {
      this.panX = (vp.w - fullW) / 2
    } else {
      // Extend toward whichever side the palette hugs so cells hidden
      // beneath it can be panned into the open region.
      this.panX = clamp(this.panX, vp.w - fullW - ins.right, 0 + ins.left)
    }
    if (fullH <= vp.h) {
      this.panY = (vp.h - fullH) / 2
    } else {
      this.panY = clamp(this.panY, vp.h - fullH - ins.bottom, 0 + ins.top)
    }
  }

  // ─── Palette ───

  createPaletteBar() {
    const bar = document.createElement('div')
    bar.className = 'diamond-palette-bar'

    this.swatches = []

    for (let index = 0; index < this.palette.length; index++) {
      const color = this.palette[index]
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'diamond-swatch'
      if (index === this.selectedColor) btn.classList.add('selected')
      btn.style.background = rgbString(color)
      btn.setAttribute('aria-label', `Color ${index + 1}`)
      btn.textContent = String(index + 1)

      const lum = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
      btn.style.color = lum > 140 ? '#000' : '#fff'

      btn.addEventListener('click', () => this.selectColor(index))
      bar.append(btn)
      this.swatches.push(btn)
    }

    return bar
  }

  selectColor(index) {
    this.selectedColor = index
    for (let i = 0; i < this.swatches.length; i++) {
      this.swatches[i].classList.toggle('selected', i === index)
    }
  }

  // ─── Events ───

  bindEvents() {
    this._onPointerDown = (e) => this.onPointerDown(e)
    this._onPointerMove = (e) => this.onPointerMove(e)
    this._onPointerUp = (e) => this.onPointerUp(e)
    this._onWheel = (e) => this.onWheel(e)

    this.canvas.addEventListener('pointerdown', this._onPointerDown)
    this.canvas.addEventListener('pointermove', this._onPointerMove)
    this.canvas.addEventListener('pointerup', this._onPointerUp)
    this.canvas.addEventListener('pointercancel', this._onPointerUp)
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false })
  }

  onPointerDown(e) {
    e.preventDefault()
    this.canvas.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (this.pointers.size === 2) {
      // Start pinch
      const [a, b] = [...this.pointers.values()]
      this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y)
      this.pinchStartZoom = this.zoom
      this.dragging = false
    } else if (this.pointers.size === 1) {
      this.dragging = true
      this.didDrag = false
      this.dragStartX = e.clientX
      this.dragStartY = e.clientY
      this.panStartX = this.panX
      this.panStartY = this.panY
    }
  }

  onPointerMove(e) {
    if (!this.pointers.has(e.pointerId)) return
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (this.pointers.size === 2) {
      // Pinch zoom
      const [a, b] = [...this.pointers.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      if (this.pinchStartDist > 0) {
        const newZoom = clamp(this.pinchStartZoom * (dist / this.pinchStartDist), this.getMinZoom(), MAX_ZOOM)
        // Zoom around midpoint
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const rect = this.boardFrame.getBoundingClientRect()
        const fx = mx - rect.left
        const fy = my - rect.top
        const worldX = (fx - this.panX) / this.zoom
        const worldY = (fy - this.panY) / this.zoom
        this.zoom = newZoom
        this.panX = fx - worldX * this.zoom
        this.panY = fy - worldY * this.zoom
        this.clampPan()
        this.applyTransform()
      }
      this.didDrag = true
      return
    }

    if (this.dragging && this.pointers.size === 1) {
      const dx = e.clientX - this.dragStartX
      const dy = e.clientY - this.dragStartY
      if (!this.didDrag && Math.abs(dx) + Math.abs(dy) > 6) {
        this.didDrag = true
      }
      if (this.didDrag) {
        this.panX = this.panStartX + dx
        this.panY = this.panStartY + dy
        this.clampPan()
        this.applyTransform()
      }
    }
  }

  onPointerUp(e) {
    const wasInMap = this.pointers.has(e.pointerId)
    this.pointers.delete(e.pointerId)

    if (wasInMap && !this.didDrag && this.pointers.size === 0) {
      // It was a tap — flood fill
      this.handleTap(e)
    }

    if (this.pointers.size < 2) {
      this.pinchStartDist = 0
    }
    if (this.pointers.size === 0) {
      this.dragging = false
    }
  }

  onWheel(e) {
    e.preventDefault()
    const rect = this.boardFrame.getBoundingClientRect()
    const fx = e.clientX - rect.left
    const fy = e.clientY - rect.top
    const worldX = (fx - this.panX) / this.zoom
    const worldY = (fy - this.panY) / this.zoom

    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    this.zoom = clamp(this.zoom * factor, this.getMinZoom(), MAX_ZOOM)
    this.panX = fx - worldX * this.zoom
    this.panY = fy - worldY * this.zoom
    this.clampPan()
    this.applyTransform()
  }

  // ─── Paint ───

  handleTap(e) {
    if (this.completed || this.filling) return

    const rect = this.canvas.getBoundingClientRect()
    const scaleX = (this.cols * CELL_PX) / rect.width
    const scaleY = (this.rows * CELL_PX) / rect.height
    const x = (e.clientX - rect.left) * scaleX
    const y = (e.clientY - rect.top) * scaleY

    const col = Math.floor(x / CELL_PX)
    const row = Math.floor(y / CELL_PX)
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return

    const index = row * this.cols + col
    if (this.fills[index] === this.selectedColor) return

    const targetGridColor = this.grid[index]
    const currentFill = this.fills[index]

    // Wrong color — flash temporarily and play buzzer. Block further taps
    // (correct or wrong) until the restore completes so rapid taps can't
    // stack mismatched fills on top of an in-flight restore.
    if (this.selectedColor !== targetGridColor) {
      this.filling = true
      const allIdx = this.collectFloodIndices(col, row, targetGridColor, currentFill)
      for (const idx of allIdx) {
        this.fills[idx] = this.selectedColor
        this.drawCell(idx % this.cols, Math.floor(idx / this.cols))
      }
      this.redrawGridLines()
      playBuzzer()
      setTimeout(() => {
        for (const idx of allIdx) {
          this.fills[idx] = currentFill
          this.drawCell(idx % this.cols, Math.floor(idx / this.cols))
        }
        this.redrawGridLines()
        this.filling = false
      }, 1000)
      return
    }

    const waves = this.collectFloodWaves(col, row, targetGridColor, currentFill)

    if (waves.length === 0) return

    if (waves.length === 1) {
      // Single cell — fill instantly
      for (const idx of waves[0]) {
        this.fills[idx] = this.selectedColor
        this.drawCell(idx % this.cols, Math.floor(idx / this.cols))
      }
      this.redrawGridLines()
      this.finishFill()
      return
    }

    this.animateFill(waves, this.selectedColor)
  }

  collectFloodIndices(startCol, startRow, targetGridColor, currentFill) {
    const result = []
    const visited = new Uint8Array(this.totalCells)
    const stack = [[startCol, startRow]]

    while (stack.length > 0) {
      const [c, r] = stack.pop()
      if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) continue
      const idx = r * this.cols + c
      if (visited[idx]) continue
      visited[idx] = 1
      if (this.grid[idx] !== targetGridColor || this.fills[idx] !== currentFill) continue
      result.push(idx)
      stack.push(
        [c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1],
        [c - 1, r - 1], [c + 1, r - 1], [c - 1, r + 1], [c + 1, r + 1],
      )
    }

    return result
  }

  collectFloodWaves(startCol, startRow, targetGridColor, currentFill) {
    const waves = []
    const visited = new Uint8Array(this.totalCells)
    let frontier = [[startCol, startRow]]

    while (frontier.length > 0) {
      const wave = []
      const nextFrontier = []

      for (const [c, r] of frontier) {
        if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) continue
        const idx = r * this.cols + c
        if (visited[idx]) continue
        visited[idx] = 1

        if (this.grid[idx] !== targetGridColor || this.fills[idx] !== currentFill) continue

        wave.push(idx)
        nextFrontier.push(
          [c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1],
          [c - 1, r - 1], [c + 1, r - 1], [c - 1, r + 1], [c + 1, r + 1],
        )
      }

      if (wave.length > 0) waves.push(wave)
      frontier = nextFrontier
    }

    return waves
  }

  animateFill(waves, fillColor) {
    this.filling = true
    let i = 0

    const step = () => {
      if (i >= waves.length) {
        this.filling = false
        this.finishFill()
        return
      }

      for (const idx of waves[i]) {
        this.fills[idx] = fillColor
        this.drawCell(idx % this.cols, Math.floor(idx / this.cols))
      }
      this.redrawGridLines()
      i++
      const delay = Math.max(0, 100 - i * 5)
      this._fillTimer = setTimeout(step, delay)
    }

    step()
  }

  finishFill() {
    if (this.isComplete()) {
      this.completed = true
      this.emitProgress()
      if (typeof this.onComplete === 'function') {
        this.onComplete({
          lockedCount: this.totalCells,
          totalCount: this.totalCells,
        })
      }
      return
    }
    this.emitProgress()
  }

  isComplete() {
    if (!this.grid || !this.fills) return false
    for (let i = 0; i < this.grid.length; i++) {
      if (this.fills[i] !== this.grid[i]) return false
    }
    return true
  }

  // ─── Rendering ───

  drawGrid() {
    const ctx = this.ctx
    const cs = CELL_PX
    const fullW = this.cols * cs
    const fullH = this.rows * cs

    ctx.clearRect(0, 0, fullW, fullH)

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        this.drawCell(col, row)
      }
    }

    this.redrawGridLines()
  }

  redrawGridLines() {
    if (!this._showDetail) return
    const ctx = this.ctx
    const cs = CELL_PX
    const fullW = this.cols * cs
    const fullH = this.rows * cs
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let col = 0; col <= this.cols; col++) {
      ctx.moveTo(col * cs, 0)
      ctx.lineTo(col * cs, fullH)
    }
    for (let row = 0; row <= this.rows; row++) {
      ctx.moveTo(0, row * cs)
      ctx.lineTo(fullW, row * cs)
    }
    ctx.stroke()
  }

  drawCell(col, row) {
    const ctx = this.ctx
    const cs = CELL_PX
    const x = col * cs
    const y = row * cs
    const index = row * this.cols + col
    const correctColor = this.grid[index]
    const fill = this.fills[index]

    if (fill === -1) {
      const color = this.palette[correctColor]
      ctx.fillStyle = 'rgba(245,243,238,1)'
      ctx.fillRect(x, y, cs, cs)
      const label = String(correctColor + 1)
      ctx.font = `600 10px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const lum = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
      ctx.fillStyle = lum > 180
        ? `rgb(${color[0] >> 1},${color[1] >> 1},${color[2] >> 1})`
        : rgbString(color)
      ctx.fillText(label, x + cs / 2, y + cs / 2)
    } else if (fill === correctColor) {
      ctx.fillStyle = rgbString(this.palette[fill])
      ctx.fillRect(x, y, cs, cs)
    } else {
      // Wrong color — striking red cross
      ctx.fillStyle = rgbString(this.palette[fill])
      ctx.fillRect(x, y, cs, cs)

      ctx.strokeStyle = 'rgba(220,38,38,0.8)'
      ctx.lineWidth = Math.max(1.5, cs * 0.12)
      ctx.lineCap = 'round'
      const m = cs * 0.2
      ctx.beginPath()
      ctx.moveTo(x + m, y + m)
      ctx.lineTo(x + cs - m, y + cs - m)
      ctx.moveTo(x + cs - m, y + m)
      ctx.lineTo(x + m, y + cs - m)
      ctx.stroke()
      ctx.lineCap = 'butt'
    }
  }

  // ─── Progress / State ───

  countCorrectCells() {
    let count = 0
    for (let i = 0; i < this.grid.length; i++) {
      if (this.fills[i] === this.grid[i]) count++
    }
    return count
  }

  emitProgress() {
    if (typeof this.onProgress !== 'function') return

    const correct = this.countCorrectCells()
    this.pieces = Array.from({ length: this.totalCells }, (_, i) => ({
      locked: this.fills[i] === this.grid[i],
    }))

    this.onProgress({
      completed: this.completed,
      lockedCount: correct,
      totalCount: this.totalCells,
      state: this.getProgressState(),
    })
  }

  getProgressState() {
    return {
      cols: this.cols,
      rows: this.rows,
      palette: this.palette.map((c) => [...c]),
      grid: Array.from(this.grid),
      fills: Array.from(this.fills),
      selectedColor: this.selectedColor,
      completed: this.completed,
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object') return
    if (!Array.isArray(state.grid) || !Array.isArray(state.fills)) return
    if (!Array.isArray(state.palette) || state.palette.length < 1) return

    const savedCols = Number(state.cols)
    const savedRows = Number(state.rows)
    if (!(savedCols > 0) || !(savedRows > 0)) return
    if (state.grid.length !== savedCols * savedRows) return
    if (state.fills.length !== savedCols * savedRows) return

    this.cols = savedCols
    this.rows = savedRows
    this.totalCells = savedCols * savedRows
    this.palette = state.palette.map((c) => [c[0], c[1], c[2]])
    this.grid = new Uint8Array(state.grid)
    this.fills = new Int8Array(state.fills)

    const sel = Number(state.selectedColor)
    this.selectedColor = Number.isFinite(sel) && sel >= 0 && sel < this.palette.length ? sel : 0

    // Restore zoom/pan or fit
    if (Number.isFinite(state.zoom)) {
      this.zoom = clamp(state.zoom, this.getMinZoom(), MAX_ZOOM)
      this.panX = Number(state.panX) || 0
      this.panY = Number(state.panY) || 0
      this.clampPan()
    } else {
      this.fitZoom()
    }

    // Resize canvas to match restored grid
    const fullW = this.cols * CELL_PX
    const fullH = this.rows * CELL_PX
    if (this.canvas) {
      configureCanvas(this.canvas, fullW, fullH)
      this.ctx = this.canvas.getContext('2d')
    }
    if (this.boardContent) {
      this.boardContent.style.width = `${fullW}px`
      this.boardContent.style.height = `${fullH}px`
    }

    // Rebuild palette bar
    if (this.paletteBar) {
      this.paletteBar.remove()
      this.paletteBar = this.createPaletteBar()
      this.root.append(this.paletteBar)
    }

    this.applyTransform()
    this.completed = Boolean(state.completed) || this.isComplete()
    this.drawGrid()
    this.emitProgress()
  }

  setReferenceVisible(visible) {
    this.referenceVisible = Boolean(visible)
    if (this.referenceImage) {
      this.referenceImage.classList.toggle('is-visible', this.referenceVisible)
    }
    this.emitProgress()
    return this.referenceVisible
  }

  toggleReferenceVisible() {
    return this.setReferenceVisible(!this.referenceVisible)
  }

  resetView() {
    this.setReferenceVisible(false)
  }

  onWindowResize() {
    if (!this.grid) return
    this.clampPan()
    this.applyTransform()
    this.drawGrid()
  }

  onWindowResume() {
    if (!this.grid || document.visibilityState === 'hidden') return
    requestAnimationFrame(() => {
      if (!this.grid || document.visibilityState === 'hidden') return
      this.drawGrid()
    })
  }
}

// ─── Helpers ────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function playBuzzer() {
  const ac = new (window.AudioContext || window.webkitAudioContext)()
  const E2 = 82.41
  const C2 = 65.41
  const duration = 0.25
  const gap = 0.05

  for (const [freq, start] of [[E2, 0], [C2, duration + gap]]) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'square'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.15, ac.currentTime + start)
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + start + duration)
    osc.connect(gain)
    gain.connect(ac.destination)
    osc.start(ac.currentTime + start)
    osc.stop(ac.currentTime + start + duration)
  }
}

function rgbString(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

function configureCanvas(canvas, width, height) {
  const scale = getCanvasRenderScale(width, height)
  canvas.width = Math.max(1, Math.floor(width * scale))
  canvas.height = Math.max(1, Math.floor(height * scale))
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.style.transformOrigin = '0 0'

  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
  }
}

function getCanvasRenderScale(width, height) {
  const dpr = window.devicePixelRatio || 1
  const maxByDimension = Math.min(MAX_CANVAS_DIMENSION / width, MAX_CANVAS_DIMENSION / height)
  const maxByArea = Math.sqrt(MAX_CANVAS_PIXELS / (width * height))
  const targetScale = Math.max(1, Math.min(dpr, maxByDimension, maxByArea))

  const fittedWidthScale = Math.floor(width * targetScale) / width
  const fittedHeightScale = Math.floor(height * targetScale) / height
  return Math.max(1, Math.min(targetScale, fittedWidthScale, fittedHeightScale))
}

// ─── Color Quantization (Median Cut) ────────────────────────

function sampleCellRegions(image, cols, rows, sampleGrid) {
  const canvas = document.createElement('canvas')
  canvas.width = cols * sampleGrid
  canvas.height = rows * sampleGrid
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  const regions = new Array(cols * rows)

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const samples = []
      const reds = []
      const greens = []
      const blues = []

      for (let sy = 0; sy < sampleGrid; sy++) {
        for (let sx = 0; sx < sampleGrid; sx++) {
          const px = col * sampleGrid + sx
          const py = row * sampleGrid + sy
          const offset = (py * canvas.width + px) * 4
          if (data[offset + 3] < 128) continue

          const sample = [data[offset], data[offset + 1], data[offset + 2]]
          samples.push(sample)
          reds.push(sample[0])
          greens.push(sample[1])
          blues.push(sample[2])
        }
      }

      if (samples.length === 0) {
        samples.push([255, 255, 255])
        reds.push(255)
        greens.push(255)
        blues.push(255)
      }

      regions[row * cols + col] = {
        samples,
        representative: [
          medianChannel(reds),
          medianChannel(greens),
          medianChannel(blues),
        ],
      }
    }
  }

  return regions
}

function createDistinctPalette(pixels, targetColors) {
  const boxes = medianCutBoxes(pixels, targetColors * 4)
  const candidates = boxes.map((box) => {
    const color = boxAvg(box)
    return {
      color,
      lab: rgbToOklab(color),
      weight: box.pixels.length,
    }
  })

  const merged = mergeNearbyCandidates(candidates, 0.05)
  const selected = selectDistinctCandidates(merged, targetColors)
  return selected.map((candidate) => candidate.color)
}

function medianCutBoxes(pixels, targetColors) {
  if (pixels.length === 0) {
    return [{
      pixels: Array.from({ length: targetColors }, (_, i) => {
        const v = Math.round((i / Math.max(1, targetColors - 1)) * 255)
        return [v, v, v]
      }),
    }]
  }

  let boxes = [{ pixels: pixels.slice() }]

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
        if (score > bestScore) {
          bestScore = score
          bestBox = b
          bestChannel = ch
        }
      }
    }

    if (bestBox === -1) break

    const box = boxes[bestBox]
    box.pixels.sort((a, b) => a[bestChannel] - b[bestChannel])
    const mid = Math.floor(box.pixels.length / 2)
    const left = { pixels: box.pixels.slice(0, mid) }
    const right = { pixels: box.pixels.slice(mid) }

    boxes.splice(bestBox, 1, left, right)
  }

  return boxes
}

function mergeNearbyCandidates(candidates, minDistance) {
  const remaining = candidates
    .slice()
    .sort((a, b) => b.weight - a.weight)
  const merged = []
  const minDistanceSq = minDistance ** 2

  while (remaining.length > 0) {
    const seed = remaining.shift()
    const cluster = [seed]

    for (let i = remaining.length - 1; i >= 0; i--) {
      if (oklabDistSq(seed.lab, remaining[i].lab) < minDistanceSq) {
        cluster.push(remaining[i])
        remaining.splice(i, 1)
      }
    }

    let totalWeight = 0
    let r = 0
    let g = 0
    let b = 0
    for (const candidate of cluster) {
      totalWeight += candidate.weight
      r += candidate.color[0] * candidate.weight
      g += candidate.color[1] * candidate.weight
      b += candidate.color[2] * candidate.weight
    }

    const color = [
      Math.round(r / totalWeight),
      Math.round(g / totalWeight),
      Math.round(b / totalWeight),
    ]
    merged.push({
      color,
      lab: rgbToOklab(color),
      weight: totalWeight,
    })
  }

  return merged.sort((a, b) => b.weight - a.weight)
}

function selectDistinctCandidates(candidates, targetColors) {
  if (candidates.length <= targetColors) {
    return candidates
  }

  const selected = []
  const remaining = candidates.slice()
  const maxWeight = remaining[0]?.weight || 1

  selected.push(remaining.shift())

  if (remaining.length > 0 && selected.length < targetColors) {
    let bestIndex = 0
    let bestDistance = -1
    for (let i = 0; i < remaining.length; i++) {
      const distance = oklabDistSq(selected[0].lab, remaining[i].lab)
      if (distance > bestDistance) {
        bestDistance = distance
        bestIndex = i
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0])
  }

  while (selected.length < targetColors && remaining.length > 0) {
    let bestIndex = 0
    let bestScore = -1

    for (let i = 0; i < remaining.length; i++) {
      let minDistance = Infinity
      for (const candidate of selected) {
        minDistance = Math.min(minDistance, oklabDistSq(candidate.lab, remaining[i].lab))
      }
      const weightFactor = 0.7 + 0.3 * (remaining[i].weight / maxWeight)
      const score = minDistance * weightFactor
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0])
  }

  return selected
}

function boxAvg(box) {
  let r = 0, g = 0, b = 0
  for (const px of box.pixels) {
    r += px[0]; g += px[1]; b += px[2]
  }
  const n = box.pixels.length || 1
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

function assignCellColors(cellSamples, palette) {
  const result = new Uint8Array(cellSamples.length)
  const paletteLabs = palette.map((color) => rgbToOklab(color))

  for (let i = 0; i < cellSamples.length; i++) {
    const votes = new Uint16Array(palette.length)
    for (const sample of cellSamples[i].samples) {
      votes[nearestPaletteIndex(sample, palette, paletteLabs)]++
    }

    const representativeLab = rgbToOklab(cellSamples[i].representative)
    const representativeIndex = nearestPaletteIndex(cellSamples[i].representative, palette, paletteLabs)
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
        bestIndex = p
        bestVotes = votes[p]
        bestDistance = distance
      }
    }

    result[i] = bestIndex
  }

  return result
}

function nearestPaletteIndex(color, palette, paletteLabs = palette.map((entry) => rgbToOklab(entry))) {
  const lab = rgbToOklab(color)
  let bestDist = Infinity
  let bestIdx = 0

  for (let p = 0; p < palette.length; p++) {
    const dist = oklabDistSq(lab, paletteLabs[p])
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = p
    }
  }

  return bestIdx
}

function medianChannel(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function rgbToOklab(rgb) {
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

function srgbToLinear(value) {
  if (value <= 0.04045) {
    return value / 12.92
  }
  return ((value + 0.055) / 1.055) ** 2.4
}

function sortPaletteDarkToLight(palette) {
  const luminances = palette.map((c) => rgbToOklab(c)[0])
  const indices = palette.map((_, i) => i)
  indices.sort((a, b) => luminances[a] - luminances[b])
  const sorted = indices.map((i) => palette[i])
  for (let i = 0; i < palette.length; i++) palette[i] = sorted[i]
}

function oklabDistSq(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

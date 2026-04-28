import { loadImage, releaseLoadedImage } from './image-loader.js'

const MIN_COLS = 5
const MIN_ROWS = 5
const TARGET_TILE_COUNTS = { easy: 30, medium: 45, hard: 72 }

const SWAP_COMPLETION_STORAGE_KEY = 'xefig:picture-swap:completion:v1'
const CONFETTI_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#8338ec']

// Pick the (cols, rows) shape near targetTotal that maximises the area
// covered by square tiles in availW × availH. Square tiles always leave
// some slack in one dimension; this picks the shape that minimises that
// slack while staying close to the difficulty count. The image is then
// cover-cropped to the chosen board rect by getCoverMetrics.
function pickBestGrid(availW, availH, targetTotal) {
  const minTotal = Math.max(MIN_COLS * MIN_ROWS, Math.floor(targetTotal * 0.7))
  const maxTotal = Math.ceil(targetTotal * 1.4)
  let best = null
  for (let cols = MIN_COLS; cols <= 24; cols += 1) {
    for (let rows = MIN_ROWS; rows <= 24; rows += 1) {
      const total = cols * rows
      if (total < minTotal || total > maxTotal) continue
      const tileSize = Math.min(availW / cols, availH / rows)
      const area = total * tileSize * tileSize
      if (!best || area > best.area) best = { cols, rows, area }
    }
  }
  if (best) return { cols: best.cols, rows: best.rows }
  const aspect = availW / availH
  const cols = Math.max(MIN_COLS, Math.round(Math.sqrt(targetTotal * aspect)))
  const rows = Math.max(MIN_ROWS, Math.round(targetTotal / cols))
  return { cols, rows }
}

export class PictureSwapPuzzle {
  constructor({ container, imageUrl, difficulty = 'medium', onComplete, onProgress }) {
    if (!container) {
      throw new Error('PictureSwapPuzzle requires a container element.')
    }

    this.container = container
    this.imageUrl = imageUrl
    this.difficulty = difficulty
    this.onComplete = onComplete
    this.onProgress = onProgress

    this.completed = false
    this.referenceVisible = false
    this.displayImageUrl = imageUrl
    this.selectedTileId = null

    this.cols = 0
    this.rows = 0
    this.tiles = []
    this.slots = []

    this.confettiParticles = []
    this.confettiFrame = null
    this.confettiStartMs = 0

    this.startedAtMs = 0

    this.handleWindowResize = () => this.onWindowResize()
  }

  async init() {
    this.destroy()

    this.image = await loadImage(this.imageUrl)
    this.displayImageUrl = this.image.currentSrc || this.image.src || this.imageUrl
    this.calculateGrid()
    this.totalTiles = this.cols * this.rows
    this.startedAtMs = Date.now()

    this.createLayout()
    this.createTiles()
    this.shuffleTiles()

    this.completed = this.isSolved()
    this.syncAllTilePositions({ animate: false })
    this.setReferenceVisible(false)
    this.emitProgress()

    this.lastOrientation = this.getOrientation()
    window.addEventListener('resize', this.handleWindowResize)
  }

  destroy() {
    window.removeEventListener('resize', this.handleWindowResize)
    this.stopConfetti()

    if (this.tiles.length) {
      for (const tile of this.tiles) {
        tile.element.removeEventListener('click', tile.onClick)
      }
    }

    this.tiles = []
    this.slots = []
    this.selectedTileId = null
    releaseLoadedImage(this.image)
    this.image = null
    this.displayImageUrl = this.imageUrl
    this.container.innerHTML = ''
  }

  getSafeAreaInset(side) {
    const el = document.createElement('div')
    el.style.cssText = `position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-${side}, 0px);visibility:hidden;pointer-events:none`
    document.body.appendChild(el)
    const val = el.offsetHeight
    el.remove()
    return val
  }

  getAvailableSpace() {
    const containerWidth = this.container.clientWidth || window.innerWidth
    const containerHeight = this.container.clientHeight || window.innerHeight
    const padding = 6
    const saiTop = this.getSafeAreaInset('top')
    const saiLeft = this.getSafeAreaInset('left')
    const saiRight = this.getSafeAreaInset('right')
    // Only the native safe-area insets are reserved. The floating
    // back/menu buttons are translucent and overlay the board (same as
    // landscape behaviour) — letting the board centre naturally in the
    // viewport. Bottom is intentionally NOT reserved; iOS's home
    // indicator is semi-transparent so tiles can run to the viewport edge.
    const isPortrait = window.innerHeight >= window.innerWidth
    const topReserve = saiTop
    const horizReserve = isPortrait ? 0 : saiLeft + saiRight
    return {
      availW: Math.max(240, containerWidth - padding * 2 - horizReserve),
      availH: Math.max(180, containerHeight - padding * 2 - topReserve),
    }
  }

  calculateGrid() {
    const { availW, availH } = this.getAvailableSpace()

    // Only pick cols/rows on a fresh puzzle. After tiles exist the grid
    // shape is fixed except for transpose-on-rotation.
    if (!this.tiles || this.tiles.length === 0) {
      const targetTotal = TARGET_TILE_COUNTS[this.difficulty] || TARGET_TILE_COUNTS.medium
      const picked = pickBestGrid(availW, availH, targetTotal)
      this.cols = picked.cols
      this.rows = picked.rows
    }

    // Tile size is uniform square — sized to fit the narrower axis
    const tileFromW = availW / this.cols
    const tileFromH = availH / this.rows
    this.tileSize = Math.min(tileFromW, tileFromH)

    // Board sized exactly to the grid of square tiles
    this.boardWidth = this.tileSize * this.cols
    this.boardHeight = this.tileSize * this.rows
    this.tileWidth = this.tileSize
    this.tileHeight = this.tileSize
  }

  // Portrait→landscape rotates CCW 90°; landscape→portrait rotates CW 90°,
  // so the board tracks the physical device rotation on a typical
  // back-camera-down flip.
  transposeGrid(direction = 'ccw') {
    const oldCols = this.cols
    const oldRows = this.rows
    if (!oldCols || !oldRows) return
    const newCols = oldRows
    const newRows = oldCols

    const remap = (index) => {
      if (index == null || index < 0) return index
      const r = Math.floor(index / oldCols)
      const c = index % oldCols
      if (direction === 'cw') {
        // CW: (r, c) → (c, oldRows - 1 - r)
        return c * newCols + (oldRows - 1 - r)
      }
      // CCW: (r, c) → (oldCols - 1 - c, r)
      return (oldCols - 1 - c) * newCols + r
    }

    for (const tile of this.tiles) {
      tile.homeIndex = remap(tile.homeIndex)
      tile.slotIndex = remap(tile.slotIndex)
    }

    const newSlots = new Array(this.slots.length)
    for (let i = 0; i < this.slots.length; i += 1) {
      const tileId = this.slots[i]
      newSlots[remap(i)] = tileId
    }
    this.slots = newSlots

    this.cols = newCols
    this.rows = newRows
    this._initialCols = newCols
    this._initialRows = newRows
  }

  createLayout() {
    this.root = document.createElement('section')
    this.root.className = 'picture-swap-root'

    this.boardFrame = document.createElement('div')
    this.boardFrame.className = 'picture-swap-board-frame'

    this.board = document.createElement('div')
    this.board.className = 'picture-swap-board'

    this.referenceImage = document.createElement('img')
    this.referenceImage.className = 'picture-swap-reference'
    this.referenceImage.src = this.displayImageUrl
    this.referenceImage.alt = 'Reference image'

    this.tileLayer = document.createElement('div')
    this.tileLayer.className = 'picture-swap-tile-layer'

    this.confettiCanvas = document.createElement('canvas')
    this.confettiCanvas.className = 'picture-swap-confetti'
    this.confettiCtx = this.confettiCanvas.getContext('2d')

    this.board.append(this.referenceImage, this.tileLayer, this.confettiCanvas)
    this.boardFrame.append(this.board)
    this.root.append(this.boardFrame)
    this.container.append(this.root)

    this.applyBoardSize()
  }

  createTiles() {
    this.tiles = []

    for (let id = 0; id < this.totalTiles; id += 1) {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'picture-swap-tile'
      element.setAttribute('aria-label', `Tile ${id + 1}`)

      const tile = {
        id,
        homeIndex: id,
        slotIndex: id,
        element,
      }

      tile.onClick = () => this.onTileClick(tile)
      element.addEventListener('click', tile.onClick)

      this.paintTileFace(tile)
      this.positionTile(tile, { animate: false })
      this.tileLayer.append(tile.element)
      this.tiles.push(tile)
    }
  }

  applyBoardSize() {
    this.calculateGrid()

    if (!this._initialCols) {
      this._initialCols = this.cols
      this._initialRows = this.rows
    }

    if (this.board) {
      this.board.style.width = `${this.boardWidth}px`
      this.board.style.height = `${this.boardHeight}px`
    }

    if (this.confettiCanvas) {
      this.confettiCanvas.width = Math.round(this.boardWidth)
      this.confettiCanvas.height = Math.round(this.boardHeight)
    }

    for (const tile of this.tiles) {
      this.paintTileFace(tile)
      this.positionTile(tile, { animate: false })
    }
  }

  getOrientation() {
    return window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape'
  }

  onWindowResize() {
    if (!this.board) {
      return
    }
    const newOrientation = this.getOrientation()
    if (
      this.lastOrientation &&
      newOrientation !== this.lastOrientation &&
      this.tiles.length > 0
    ) {
      const direction = this.lastOrientation === 'portrait' ? 'ccw' : 'cw'
      this.transposeGrid(direction)
    }
    this.lastOrientation = newOrientation
    this.applyBoardSize()
  }

  getCoverMetrics() {
    const imgW = this.image?.naturalWidth || this.image?.width || 1
    const imgH = this.image?.naturalHeight || this.image?.height || 1
    const scale = Math.max(this.boardWidth / imgW, this.boardHeight / imgH)
    const drawW = imgW * scale
    const drawH = imgH * scale
    return {
      bgSize: `${drawW}px ${drawH}px`,
      offsetX: (this.boardWidth - drawW) / 2,
      offsetY: (this.boardHeight - drawH) / 2,
    }
  }

  paintTileFace(tile) {
    const row = Math.floor(tile.homeIndex / this.cols)
    const col = tile.homeIndex % this.cols
    const cover = this.getCoverMetrics()

    tile.element.style.width = `${this.tileWidth}px`
    tile.element.style.height = `${this.tileHeight}px`
    tile.element.style.backgroundImage = `url("${this.displayImageUrl}")`
    tile.element.style.backgroundSize = cover.bgSize
    tile.element.style.backgroundPosition = `${cover.offsetX - col * this.tileWidth}px ${cover.offsetY - row * this.tileHeight}px`
  }

  shuffleTiles() {
    const maxAttempts = 500
    let attempts = 0

    do {
      this.slots = Array.from({ length: this.totalTiles }, (_, index) => index)
      for (let index = this.slots.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1))
        ;[this.slots[index], this.slots[swapIndex]] = [this.slots[swapIndex], this.slots[index]]
      }
      attempts += 1
    } while (!isDerangement(this.slots) && attempts < maxAttempts)

    if (!isDerangement(this.slots)) {
      this.slots = Array.from({ length: this.totalTiles }, (_, index) => (index + 1) % this.totalTiles)
    }

    this.selectedTileId = null
    this.completed = false

    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
      const tileId = this.slots[slotIndex]
      const tile = this.tiles[tileId]
      tile.slotIndex = slotIndex
      tile.element.classList.remove('is-selected')
    }
  }

  onTileClick(tile) {
    if (this.completed) {
      return
    }

    if (this.selectedTileId === null) {
      this.selectTile(tile.id)
      this.emitProgress()
      return
    }

    if (this.selectedTileId === tile.id) {
      this.clearSelection()
      this.emitProgress()
      return
    }

    this.swapTilePositions(this.selectedTileId, tile.id)
    this.clearSelection()
    this.emitProgress()

    if (this.isSolved()) {
      this.handleSolved()
    }
  }

  selectTile(tileId) {
    this.clearSelection()
    this.selectedTileId = tileId
    const tile = this.tiles[tileId]
    if (tile) {
      tile.element.classList.add('is-selected')
    }
  }

  clearSelection() {
    if (this.selectedTileId !== null) {
      const tile = this.tiles[this.selectedTileId]
      if (tile) {
        tile.element.classList.remove('is-selected')
      }
    }
    this.selectedTileId = null
  }

  swapTilePositions(tileIdA, tileIdB) {
    const tileA = this.tiles[tileIdA]
    const tileB = this.tiles[tileIdB]
    if (!tileA || !tileB) {
      return
    }

    const slotA = tileA.slotIndex
    const slotB = tileB.slotIndex

    tileA.slotIndex = slotB
    tileB.slotIndex = slotA

    this.slots[slotA] = tileIdB
    this.slots[slotB] = tileIdA

    this.positionTile(tileA, { animate: true })
    this.positionTile(tileB, { animate: true })
  }

  positionTile(tile, { animate }) {
    const row = Math.floor(tile.slotIndex / this.cols)
    const col = tile.slotIndex % this.cols

    tile.element.style.transition = animate ? '' : 'none'
    tile.element.style.transform = `translate(${col * this.tileWidth}px, ${row * this.tileHeight}px)`

    if (!animate) {
      requestAnimationFrame(() => {
        tile.element.style.transition = ''
      })
    }
  }

  syncAllTilePositions({ animate }) {
    for (const tile of this.tiles) {
      this.positionTile(tile, { animate })
    }
  }

  isSolved() {
    for (const tile of this.tiles) {
      if (tile.slotIndex !== tile.homeIndex) {
        return false
      }
    }
    return true
  }

  countCorrectTiles() {
    let count = 0
    for (const tile of this.tiles) {
      if (tile.slotIndex === tile.homeIndex) {
        count += 1
      }
    }
    return count
  }

  handleSolved() {
    if (this.completed) {
      return
    }

    this.completed = true
    this.emitProgress()
    this.triggerConfetti()
    this.saveCompletionTime()

    if (typeof this.onComplete === 'function') {
      this.onComplete({
        lockedCount: this.totalTiles,
        totalCount: this.totalTiles,
      })
    }
  }

  triggerConfetti() {
    if (!this.confettiCtx || !this.confettiCanvas) {
      return
    }

    this.stopConfetti()

    const width = this.confettiCanvas.width
    const height = this.confettiCanvas.height
    const count = clamp(Math.round((this.cols + this.rows) * 12), 90, 240)

    this.confettiParticles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: -Math.random() * (height * 0.35),
      vx: (Math.random() - 0.5) * 6,
      vy: Math.random() * 3 + 1.5,
      size: Math.random() * 5 + 4,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.24,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      life: 1,
      decay: Math.random() * 0.013 + 0.009,
    }))

    this.confettiStartMs = performance.now()
    this.runConfettiFrame(this.confettiStartMs)
  }

  runConfettiFrame(now) {
    if (!this.confettiCtx || !this.confettiCanvas) {
      return
    }

    const elapsed = now - this.confettiStartMs
    if (elapsed > 2200) {
      this.stopConfetti()
      return
    }

    const ctx = this.confettiCtx
    const width = this.confettiCanvas.width
    const height = this.confettiCanvas.height

    ctx.clearRect(0, 0, width, height)

    for (const particle of this.confettiParticles) {
      particle.x += particle.vx
      particle.y += particle.vy
      particle.vy += 0.045
      particle.angle += particle.spin
      particle.life = Math.max(0, particle.life - particle.decay)

      if (particle.y > height + 12) {
        particle.y = -Math.random() * 120
      }

      if (particle.life <= 0) {
        continue
      }

      ctx.save()
      ctx.globalAlpha = particle.life
      ctx.translate(particle.x, particle.y)
      ctx.rotate(particle.angle)
      ctx.fillStyle = particle.color
      ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size)
      ctx.restore()
    }

    this.confettiFrame = requestAnimationFrame((time) => this.runConfettiFrame(time))
  }

  stopConfetti() {
    if (this.confettiFrame) {
      cancelAnimationFrame(this.confettiFrame)
      this.confettiFrame = null
    }
    if (this.confettiCtx && this.confettiCanvas) {
      this.confettiCtx.clearRect(0, 0, this.confettiCanvas.width, this.confettiCanvas.height)
    }
    this.confettiParticles = []
  }

  saveCompletionTime() {
    const elapsedMs = Math.max(1, Date.now() - this.startedAtMs)
    const payload = {
      completedAt: new Date().toISOString(),
      elapsedMs,
      cols: this.cols,
      rows: this.rows,
      imageUrl: this.imageUrl,
    }

    try {
      localStorage.setItem(SWAP_COMPLETION_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Best effort local persistence.
    }
  }

  getProgressState() {
    return {
      cols: this.cols,
      rows: this.rows,
      slots: [...this.slots],
      selectedTileId: this.selectedTileId,
      completed: this.completed,
      startedAtMs: this.startedAtMs,
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.slots)) {
      return
    }

    // Restore grid dimensions from saved state if they match
    const savedCols = Number(state.cols)
    const savedRows = Number(state.rows)
    if (savedCols > 0 && savedRows > 0 && savedCols * savedRows === state.slots.length) {
      this.cols = savedCols
      this.rows = savedRows
      this._initialCols = savedCols
      this._initialRows = savedRows
      this.totalTiles = savedCols * savedRows

      const { availW, availH } = this.getAvailableSpace()
      this.tileSize = Math.min(availW / this.cols, availH / this.rows)
      this.boardWidth = this.tileSize * this.cols
      this.boardHeight = this.tileSize * this.rows
      this.tileWidth = this.tileSize
      this.tileHeight = this.tileSize
      if (this.board) {
        this.board.style.width = `${this.boardWidth}px`
        this.board.style.height = `${this.boardHeight}px`
      }

      // Rebuild tiles if count changed
      if (this.tiles.length !== this.totalTiles) {
        for (const tile of this.tiles) {
          tile.element.removeEventListener('click', tile.onClick)
        }
        this.tileLayer.innerHTML = ''
        this.tiles = []
        this.createTiles()
      } else {
        for (const tile of this.tiles) {
          this.paintTileFace(tile)
        }
      }
    }

    if (state.slots.length !== this.totalTiles || !isValidPermutation(state.slots, this.totalTiles)) {
      return
    }

    this.slots = [...state.slots]

    for (let slotIndex = 0; slotIndex < this.slots.length; slotIndex += 1) {
      const tileId = this.slots[slotIndex]
      const tile = this.tiles[tileId]
      if (tile) {
        tile.slotIndex = slotIndex
      }
    }

    const startedAtMs = Number(state.startedAtMs)
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
      this.startedAtMs = startedAtMs
    }

    this.completed = Boolean(state.completed) || this.isSolved()
    this.syncAllTilePositions({ animate: false })

    const selectedTileId = Number(state.selectedTileId)
    if (
      !this.completed &&
      Number.isInteger(selectedTileId) &&
      selectedTileId >= 0 &&
      selectedTileId < this.totalTiles
    ) {
      this.selectTile(selectedTileId)
    } else {
      this.clearSelection()
    }

    this.emitProgress()
  }

  emitProgress() {
    if (typeof this.onProgress !== 'function') {
      return
    }

    this.onProgress({
      completed: this.completed,
      lockedCount: this.countCorrectTiles(),
      totalCount: this.totalTiles,
      state: this.getProgressState(),
    })
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
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isValidPermutation(values, maxValue) {
  const seen = new Set()
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value >= maxValue || seen.has(value)) {
      return false
    }
    seen.add(value)
  }
  return seen.size === maxValue
}

function isDerangement(values) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === index) {
      return false
    }
  }
  return true
}

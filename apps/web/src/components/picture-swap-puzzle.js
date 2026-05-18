import { loadImage, loadImageThumbFirst, releaseLoadedImage } from './image-loader.js'

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
  constructor({ container, imageUrl, thumbnailUrl, difficulty = 'medium', onComplete, onProgress, onLoadProgress }) {
    if (!container) {
      throw new Error('PictureSwapPuzzle requires a container element.')
    }

    this.container = container
    this.imageUrl = imageUrl
    this.thumbnailUrl = thumbnailUrl
    this.difficulty = difficulty
    this.onComplete = onComplete
    this.onProgress = onProgress
    this.onLoadProgress = onLoadProgress

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

    // Thumb-first: start the puzzle from the cached thumbnail so tiles
    // are immediately swappable. Full image streams in the background
    // and tiles are repainted at full quality.
    const { image, isThumbnail } = await loadImageThumbFirst(this.thumbnailUrl, this.imageUrl, { onProgress: this.onLoadProgress })
    this.image = image
    this.displayImageUrl = this.image.currentSrc || this.image.src || (isThumbnail ? this.thumbnailUrl : this.imageUrl)
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

    // Same fix as the slider: window-resize alone misses the case
    // where the container resizes without the viewport changing
    // (initial mount before layout settles, parent reflow, etc.).
    if (typeof ResizeObserver !== 'undefined') {
      this.containerObserver = new ResizeObserver(() => this.onWindowResize())
      this.containerObserver.observe(this.container)
    }

    if (isThumbnail) {
      this.startFullImageUpgrade()
    }
  }

  startFullImageUpgrade() {
    const initialImage = this.image
    loadImage(this.imageUrl)
      .then((fullImage) => {
        if (this.image !== initialImage) {
          releaseLoadedImage(fullImage)
          return
        }
        releaseLoadedImage(this.image)
        this.image = fullImage
        this.displayImageUrl = fullImage.currentSrc || fullImage.src || this.imageUrl
        for (const tile of this.tiles) {
          this.paintTileFace(tile)
        }
        if (this.referenceImage) {
          this.referenceImage.src = this.displayImageUrl
        }
      })
      .catch((err) => {
        console.warn('Picture-swap full image upgrade failed; staying on thumbnail.', err)
      })
  }

  destroy() {
    window.removeEventListener('resize', this.handleWindowResize)
    if (this.containerObserver) {
      this.containerObserver.disconnect()
      this.containerObserver = null
    }
    this.stopConfetti()

    if (this.tiles.length) {
      for (const tile of this.tiles) {
        tile.element.removeEventListener('click', tile.onClick)
      }
    }

    if (this._swapAnimTimer) {
      clearTimeout(this._swapAnimTimer)
      this._swapAnimTimer = null
    }
    if (this._swapFlashTimer) {
      clearTimeout(this._swapFlashTimer)
      this._swapFlashTimer = null
    }
    this._hintTileId = null

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
    this.referenceImage.className = 'picture-swap-reference puzzle-reference-overlay'
    this.referenceImage.src = this.displayImageUrl
    this.referenceImage.alt = 'Reference image'
    // Click the visible reference to dismiss — matches the slider's
    // single-tap-to-close gesture. Guard the first ~400 ms after open so
    // the second pointerup of the opening double-tap doesn't immediately
    // close the overlay it just summoned.
    this.referenceImage.addEventListener('click', () => {
      if (!this.referenceVisible) return
      if (this._referenceShownAt && performance.now() - this._referenceShownAt < 400) return
      this.setReferenceVisible(false)
    })

    // Frame overlay drawn above the reference image so every mode shows
    // the same "you're in reference mode now" cue. Drawn as a sibling
    // (not as a box-shadow on the <img>) because the bitmap content
    // paints over outlines on iOS Safari, which is the same reason the
    // slider has a separate frame element.
    this.referenceFrame = document.createElement('div')
    this.referenceFrame.className = 'picture-swap-reference-frame puzzle-reference-frame'
    this.referenceFrame.setAttribute('aria-hidden', 'true')

    this.tileLayer = document.createElement('div')
    this.tileLayer.className = 'picture-swap-tile-layer'

    this.confettiCanvas = document.createElement('canvas')
    this.confettiCanvas.className = 'picture-swap-confetti'
    this.confettiCtx = this.confettiCanvas.getContext('2d')

    this.board.append(this.referenceImage, this.referenceFrame, this.tileLayer, this.confettiCanvas)
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
    // While the reference overlay is up the tile layer is also blocked
    // via CSS, but a programmatic dispatch could still land here — keep
    // the puzzle logic in sync with the visual lock.
    if (this.referenceVisible) {
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
      // Replay the entry pulse on re-select by removing then re-adding
      // the animation class on the next frame.
      tile.element.classList.remove('is-select-pulse')
      requestAnimationFrame(() => {
        if (this.tiles[tileId] === tile) tile.element.classList.add('is-select-pulse')
      })
    }
    if (this.board) this.board.classList.add('has-selection')
    document.dispatchEvent(new CustomEvent('swap:tile-selected', {
      detail: { tileId },
    }))
  }

  clearSelection() {
    if (this.selectedTileId !== null) {
      const tile = this.tiles[this.selectedTileId]
      if (tile) {
        tile.element.classList.remove('is-selected')
        tile.element.classList.remove('is-select-pulse')
      }
      const prevId = this.selectedTileId
      this.selectedTileId = null
      if (this.board) this.board.classList.remove('has-selection')
      document.dispatchEvent(new CustomEvent('swap:selection-cleared', {
        detail: { tileId: prevId },
      }))
      return
    }
    this.selectedTileId = null
    if (this.board) this.board.classList.remove('has-selection')
  }

  // Helper-driven highlight ring. The tutorial/hint adds it to nudge the
  // player toward a specific candidate without committing to a selection.
  // Stays put across pointer events because nothing in the swap flow
  // toggles `is-hint-target` itself.
  highlightTile(tileId) {
    this.clearTileHighlight()
    const tile = this.tiles[tileId]
    if (!tile) return
    tile.element.classList.add('is-hint-target')
    this._hintTileId = tileId
  }

  clearTileHighlight() {
    if (this._hintTileId == null) return
    const tile = this.tiles[this._hintTileId]
    if (tile) tile.element.classList.remove('is-hint-target')
    this._hintTileId = null
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

    // Stage the swap visuals: both tiles lift (z-index + scale) for the
    // duration of the slide so they read as "trading places" rather than
    // sliding past each other through the grid. Cleared on transitionend
    // so we don't leave the lifted state stuck if multiple swaps stack
    // up (the next click would race the timer).
    this.runSwapAnimation(tileA, tileB)

    this.positionTile(tileA, { animate: true })
    this.positionTile(tileB, { animate: true })

    document.dispatchEvent(new CustomEvent('swap:tiles-swapped', {
      detail: { tileIdA, tileIdB },
    }))
  }

  runSwapAnimation(tileA, tileB) {
    const tiles = [tileA, tileB]
    for (const tile of tiles) {
      tile.element.classList.remove('is-swapping')
      tile.element.classList.remove('just-swapped')
    }
    // Force a reflow so the class re-add restarts the animation even if
    // a prior swap was still mid-flight.
    void tileA.element.offsetWidth
    for (const tile of tiles) tile.element.classList.add('is-swapping')

    const SWAP_MS = 360
    const FLASH_MS = 520
    if (this._swapAnimTimer) clearTimeout(this._swapAnimTimer)
    this._swapAnimTimer = setTimeout(() => {
      this._swapAnimTimer = null
      for (const tile of tiles) {
        tile.element.classList.remove('is-swapping')
        tile.element.classList.add('just-swapped')
      }
      if (this._swapFlashTimer) clearTimeout(this._swapFlashTimer)
      this._swapFlashTimer = setTimeout(() => {
        this._swapFlashTimer = null
        for (const tile of tiles) tile.element.classList.remove('just-swapped')
      }, FLASH_MS)
    }, SWAP_MS)
  }

  positionTile(tile, { animate }) {
    const row = Math.floor(tile.slotIndex / this.cols)
    const col = tile.slotIndex % this.cols

    tile.element.style.transition = animate ? '' : 'none'
    // Slot position lives on CSS vars so .is-selected / .is-swapping can
    // layer a scale on top via the composed transform in style.css. Setting
    // inline `transform: translate(...)` would have overridden the scale.
    tile.element.style.setProperty('--swap-tx', `${col * this.tileWidth}px`)
    tile.element.style.setProperty('--swap-ty', `${row * this.tileHeight}px`)

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
    // homes[id] = the canonical slot tile `id` belongs to in this saved
    // grid orientation. Without this, a destination device's init() would
    // set homeIndex=id in its own grid frame, causing the destination's
    // rotate-on-resize to pivot from a different starting frame than the
    // source's ending frame — and the round-trip would silently rotate
    // every tile's home (visible as image content "moving" across tiles
    // even though slot positions are preserved).
    const homes = new Array(this.totalTiles)
    for (const tile of this.tiles) homes[tile.id] = tile.homeIndex
    return {
      cols: this.cols,
      rows: this.rows,
      slots: [...this.slots],
      // selectedTileId intentionally omitted — see applyProgressState for
      // why. Saving it round-tripped a UI state we don't want to restore.
      completed: this.completed,
      startedAtMs: this.startedAtMs,
      homes,
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

    // Restore each tile's home to whatever the source device ended at.
    // Older saves (pre-fix) won't include `homes`; in that case we keep
    // the init default (homeIndex = id) so legacy state still loads,
    // even if its post-rotation alignment may drift on cross-device.
    if (Array.isArray(state.homes) && state.homes.length === this.totalTiles) {
      for (const tile of this.tiles) {
        const saved = state.homes[tile.id]
        if (Number.isInteger(saved) && saved >= 0 && saved < this.totalTiles) {
          tile.homeIndex = saved
        }
      }
      // homeIndex drives the image fragment each tile paints, so a
      // restored homeIndex needs the face repainted.
      for (const tile of this.tiles) this.paintTileFace(tile)
    }

    const startedAtMs = Number(state.startedAtMs)
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
      this.startedAtMs = startedAtMs
    }

    this.completed = Boolean(state.completed) || this.isSolved()
    this.syncAllTilePositions({ animate: false })

    // Selection is per-session UI state, not persisted progress. Always
    // restore with nothing selected — otherwise resuming a session where
    // the player tapped tile 0 (or any tile) shows it as pre-selected
    // before they touched anything, which reads as a bug. The earlier
    // `Number(state.selectedTileId)` coercion made this worse by turning
    // null/undefined into 0, but even the corrected check still surfaced
    // stale selections across sessions.
    this.clearSelection()

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
    if (this.referenceFrame) {
      this.referenceFrame.classList.toggle('is-visible', this.referenceVisible)
    }
    if (this.board) {
      // .is-reference-active gates pointer-events on the tile layer so
      // taps land on the dismissible overlay instead of the puzzle
      // beneath. Single-tap dismissal is therefore "tap anywhere on the
      // board while in reference mode."
      this.board.classList.toggle('is-reference-active', this.referenceVisible)
    }
    if (this.referenceVisible) {
      // Open timestamp — used by the click handler to swallow the
      // synthetic click that fires immediately after a double-tap opens
      // the overlay.
      this._referenceShownAt = performance.now()
    }
    this.emitProgress()
    document.dispatchEvent(new CustomEvent('swap:reference-toggled', {
      detail: { visible: this.referenceVisible },
    }))
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

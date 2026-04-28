import { loadImage, releaseLoadedImage } from './image-loader.js'

const MIN_COLS = 5
const MIN_ROWS = 5
const TARGET_TILE_COUNTS = { easy: 30, medium: 45, hard: 70 }

// Pick the (cols, rows) shape near targetTotal that maximises the area
// covered by square tiles in availW × availH. Square tiles always leave
// some slack in one dimension (width or height); this picks the shape
// that minimises that slack while staying close to the difficulty count.
// The image is then cover-cropped to the chosen board rect by
// getCoverMetrics, so no picture area is wasted.
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

const SWIPE_MIN_DISTANCE = 22
const TAP_MAX_DISTANCE = 10
const TAP_MAX_DURATION_MS = 350

export class SlidingTilePuzzle {
  constructor({ container, imageUrl, difficulty = 'easy', onComplete, onProgress }) {
    if (!container) {
      throw new Error('SlidingTilePuzzle requires a container element.')
    }

    this.container = container
    this.imageUrl = imageUrl
    this.difficulty = difficulty
    this.onComplete = onComplete
    this.onProgress = onProgress

    this.completed = false
    this.referenceVisible = false
    this.displayImageUrl = imageUrl

    this.cols = 0
    this.rows = 0
    this.tiles = []
    this.slots = []
    this.pointerStarts = new Map()

    this.handleWindowResize = () => this.onWindowResize()
  }

  async init() {
    this.destroy()

    this.image = await loadImage(this.imageUrl)
    this.displayImageUrl = this.image.currentSrc || this.image.src || this.imageUrl
    this.calculateGrid()
    this.totalSlots = this.cols * this.rows
    this.tileCount = this.totalSlots - 1

    this.createLayout()
    this.createTiles()
    this.resetToSolvedState()
    this.shuffleBoard()

    this.completed = this.isSolved()
    this.showVictoryTile(this.completed)
    this.setReferenceVisible(false)
    this.emitProgress()

    this.lastOrientation = this.getOrientation()
    window.addEventListener('resize', this.handleWindowResize)
  }

  destroy() {
    window.removeEventListener('resize', this.handleWindowResize)

    if (this.tiles.length) {
      for (const tile of this.tiles) {
        tile.element.removeEventListener('pointerdown', tile.onPointerDown)
        tile.element.removeEventListener('pointerup', tile.onPointerUp)
        tile.element.removeEventListener('pointercancel', tile.onPointerCancel)
      }
    }

    this.pointerStarts.clear()
    releaseLoadedImage(this.image)
    this.image = null
    this.displayImageUrl = this.imageUrl
    this.tiles = []
    this.slots = []
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
    // viewport with equal slack top and bottom. Bottom is intentionally
    // NOT reserved; iOS's home indicator is semi-transparent so tiles
    // can run to the viewport edge.
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
    // shape is fixed except for transpose-on-rotation (see transposeGrid),
    // so a plain resize just rescales tileSize.
    if (!this.tiles || this.tiles.length === 0) {
      const targetTotal = TARGET_TILE_COUNTS[this.difficulty] || TARGET_TILE_COUNTS.medium
      const picked = pickBestGrid(availW, availH, targetTotal)
      this.cols = picked.cols
      this.rows = picked.rows
    }

    this.tileSize = Math.min(availW / this.cols, availH / this.rows)
    this.boardWidth = this.tileSize * this.cols
    this.boardHeight = this.tileSize * this.rows
  }

  // Rotate the grid 90° counter-clockwise on orientation change. We pick
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

    const newSlots = new Array(oldCols * oldRows).fill(null)
    for (let i = 0; i < this.slots.length; i += 1) {
      const val = this.slots[i]
      if (val != null) newSlots[remap(i)] = val
    }
    this.slots = newSlots

    if (typeof this.emptyIndex === 'number') {
      this.emptyIndex = remap(this.emptyIndex)
    }

    this.cols = newCols
    this.rows = newRows
    this._initialCols = newCols
    this._initialRows = newRows
  }

  createLayout() {
    this.root = document.createElement('section')
    this.root.className = 'sliding-root'

    this.boardFrame = document.createElement('div')
    this.boardFrame.className = 'sliding-board-frame'

    this.board = document.createElement('div')
    this.board.className = 'sliding-board'

    this.referenceImage = document.createElement('img')
    this.referenceImage.className = 'sliding-reference'
    this.referenceImage.src = this.displayImageUrl
    this.referenceImage.alt = 'Reference image'

    this.tileLayer = document.createElement('div')
    this.tileLayer.className = 'sliding-tile-layer'

    this.victoryTile = document.createElement('div')
    this.victoryTile.className = 'sliding-victory-tile'

    this.board.append(this.referenceImage, this.tileLayer, this.victoryTile)
    this.boardFrame.append(this.board)
    this.root.append(this.boardFrame)
    this.container.append(this.root)

    if (!this._initialCols) {
      this._initialCols = this.cols
      this._initialRows = this.rows
    }

    this.applyBoardSize()
  }

  createTiles() {
    this.tiles = []

    for (let id = 0; id < this.tileCount; id += 1) {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'sliding-tile'
      element.setAttribute('aria-label', `Tile ${id + 1}`)

      const tile = {
        id,
        homeIndex: id,
        slotIndex: id,
        element,
      }

      tile.onPointerDown = (event) => this.onTilePointerDown(event, tile)
      tile.onPointerUp = (event) => this.onTilePointerUp(event, tile)
      tile.onPointerCancel = (event) => this.onTilePointerCancel(event)

      element.addEventListener('pointerdown', tile.onPointerDown)
      element.addEventListener('pointerup', tile.onPointerUp)
      element.addEventListener('pointercancel', tile.onPointerCancel)

      this.paintTileFace(tile)
      this.positionTile(tile, { animate: false })
      this.tileLayer.append(element)
      this.tiles.push(tile)
    }

    this.paintVictoryTileFace()
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
    const tileRow = Math.floor(tile.homeIndex / this.cols)
    const tileCol = tile.homeIndex % this.cols
    const cover = this.getCoverMetrics()

    tile.element.style.backgroundImage = `url("${this.displayImageUrl}")`
    tile.element.style.backgroundSize = cover.bgSize
    tile.element.style.backgroundPosition = `${cover.offsetX - tileCol * this.tileSize}px ${cover.offsetY - tileRow * this.tileSize}px`
    tile.element.style.width = `${this.tileSize}px`
    tile.element.style.height = `${this.tileSize}px`
  }

  paintVictoryTileFace() {
    const lastIndex = this.totalSlots - 1
    const tileRow = Math.floor(lastIndex / this.cols)
    const tileCol = lastIndex % this.cols
    const cover = this.getCoverMetrics()

    this.victoryTile.style.backgroundImage = `url("${this.displayImageUrl}")`
    this.victoryTile.style.backgroundSize = cover.bgSize
    this.victoryTile.style.backgroundPosition = `${cover.offsetX - tileCol * this.tileSize}px ${cover.offsetY - tileRow * this.tileSize}px`
    this.victoryTile.style.width = `${this.tileSize}px`
    this.victoryTile.style.height = `${this.tileSize}px`
    this.victoryTile.style.transform = `translate(${tileCol * this.tileSize}px, ${tileRow * this.tileSize}px)`
  }

  applyBoardSize() {
    this.calculateGrid()

    if (this.board) {
      this.board.style.width = `${this.boardWidth}px`
      this.board.style.height = `${this.boardHeight}px`
    }

    for (const tile of this.tiles) {
      this.paintTileFace(tile)
      this.positionTile(tile, { animate: false })
    }

    if (this.victoryTile) {
      this.paintVictoryTileFace()
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

  resetToSolvedState() {
    this.slots = Array.from({ length: this.totalSlots }, (_, index) =>
      index === this.totalSlots - 1 ? null : index,
    )
    this.emptyIndex = this.totalSlots - 1

    for (const tile of this.tiles) {
      tile.slotIndex = tile.homeIndex
    }

    this.syncAllTilePositions({ animate: false })
    this.showVictoryTile(false)
    this.completed = false
  }

  shuffleBoard() {
    const moveTarget = this.tileCount * 10
    let previousEmpty = -1

    for (let step = 0; step < moveTarget; step += 1) {
      const neighbors = this.getNeighborIndices(this.emptyIndex)
      const options = neighbors.filter((index) => index !== previousEmpty)
      const validMoves = options.length ? options : neighbors

      const chosen = validMoves[Math.floor(Math.random() * validMoves.length)]
      const oldEmpty = this.emptyIndex
      this.swapWithEmpty(chosen, { animate: false, emitProgress: false })
      previousEmpty = oldEmpty
    }

    if (this.isSolved()) {
      const neighbors = this.getNeighborIndices(this.emptyIndex)
      const chosen = neighbors[Math.floor(Math.random() * neighbors.length)]
      this.swapWithEmpty(chosen, { animate: false, emitProgress: false })
    }

    this.completed = false
    this.showVictoryTile(false)
    this.syncAllTilePositions({ animate: false })
  }

  getNeighborIndices(index) {
    const row = Math.floor(index / this.cols)
    const col = index % this.cols
    const neighbors = []

    if (row > 0) {
      neighbors.push(index - this.cols)
    }
    if (row < this.rows - 1) {
      neighbors.push(index + this.cols)
    }
    if (col > 0) {
      neighbors.push(index - 1)
    }
    if (col < this.cols - 1) {
      neighbors.push(index + 1)
    }

    return neighbors
  }

  onTilePointerDown(event, tile) {
    if (this.completed) {
      return
    }

    this.pointerStarts.set(event.pointerId, {
      tileId: tile.id,
      startX: event.clientX,
      startY: event.clientY,
      startAt: performance.now(),
    })

    tile.element.setPointerCapture(event.pointerId)
  }

  onTilePointerUp(event, tile) {
    if (!this.pointerStarts.has(event.pointerId)) {
      return
    }

    const pointer = this.pointerStarts.get(event.pointerId)
    this.pointerStarts.delete(event.pointerId)

    const dx = event.clientX - pointer.startX
    const dy = event.clientY - pointer.startY
    const distance = Math.hypot(dx, dy)
    const elapsed = performance.now() - pointer.startAt

    const didTap = distance <= TAP_MAX_DISTANCE && elapsed <= TAP_MAX_DURATION_MS
    if (didTap) {
      this.tryMoveTile(tile)
      return
    }

    if (distance < SWIPE_MIN_DISTANCE) {
      return
    }

    const direction = resolveSwipeDirection(dx, dy)
    if (!direction) {
      return
    }

    if (this.isSwipeTowardEmpty(tile, direction)) {
      this.tryMoveTile(tile)
    }
  }

  onTilePointerCancel(event) {
    this.pointerStarts.delete(event.pointerId)
  }

  isSwipeTowardEmpty(tile, direction) {
    const tileRow = Math.floor(tile.slotIndex / this.cols)
    const tileCol = tile.slotIndex % this.cols
    const emptyRow = Math.floor(this.emptyIndex / this.cols)
    const emptyCol = this.emptyIndex % this.cols

    if (tileRow === emptyRow && tileCol + 1 === emptyCol && direction === 'right') {
      return true
    }
    if (tileRow === emptyRow && tileCol - 1 === emptyCol && direction === 'left') {
      return true
    }
    if (tileCol === emptyCol && tileRow + 1 === emptyRow && direction === 'down') {
      return true
    }
    if (tileCol === emptyCol && tileRow - 1 === emptyRow && direction === 'up') {
      return true
    }

    return false
  }

  tryMoveTile(tile) {
    if (this.completed) {
      return false
    }

    if (!isAdjacent(tile.slotIndex, this.emptyIndex, this.cols)) {
      return false
    }

    this.swapWithEmpty(tile.slotIndex, { animate: true, emitProgress: true })
    this.afterMove()
    return true
  }

  swapWithEmpty(tileSlotIndex, { animate, emitProgress }) {
    const tileId = this.slots[tileSlotIndex]
    if (tileId === null || tileId === undefined) {
      return
    }

    const tile = this.tiles[tileId]
    const nextSlot = this.emptyIndex

    this.slots[nextSlot] = tileId
    this.slots[tileSlotIndex] = null

    tile.slotIndex = nextSlot
    this.emptyIndex = tileSlotIndex

    this.positionTile(tile, { animate })

    if (emitProgress) {
      this.emitProgress()
    }
  }

  positionTile(tile, { animate }) {
    const row = Math.floor(tile.slotIndex / this.cols)
    const col = tile.slotIndex % this.cols

    tile.element.style.transition = animate ? '' : 'none'
    tile.element.style.transform = `translate(${col * this.tileSize}px, ${row * this.tileSize}px)`

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

  afterMove() {
    const solved = this.isSolved()
    if (!solved) {
      return
    }

    this.completed = true
    this.showVictoryTile(true)
    this.emitProgress()

    if (typeof this.onComplete === 'function') {
      this.onComplete({
        lockedCount: this.tileCount,
        totalCount: this.tileCount,
      })
    }
  }

  isSolved() {
    if (this.emptyIndex !== this.totalSlots - 1) {
      return false
    }

    for (let index = 0; index < this.tileCount; index += 1) {
      if (this.slots[index] !== index) {
        return false
      }
    }

    return true
  }

  countCorrectTiles() {
    let count = 0
    for (let index = 0; index < this.tileCount; index += 1) {
      if (this.slots[index] === index) {
        count += 1
      }
    }
    return count
  }

  showVictoryTile(visible) {
    if (!this.victoryTile) {
      return
    }
    this.victoryTile.classList.toggle('is-visible', Boolean(visible))
  }

  getProgressState() {
    return {
      cols: this.cols,
      rows: this.rows,
      slots: [...this.slots],
      emptyIndex: this.emptyIndex,
      completed: this.completed,
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.slots)) {
      return
    }

    const savedCols = Number(state.cols)
    const savedRows = Number(state.rows)
    if (savedCols > 0 && savedRows > 0 && savedCols * savedRows === state.slots.length) {
      this.cols = savedCols
      this.rows = savedRows
      this._initialCols = savedCols
      this._initialRows = savedRows
      this.totalSlots = savedCols * savedRows
      this.tileCount = this.totalSlots - 1
      this.tileSize = Math.min(this.boardWidth / this.cols, this.boardHeight / this.rows)
      this.boardWidth = this.tileSize * this.cols
      this.boardHeight = this.tileSize * this.rows

      if (this.board) {
        this.board.style.width = `${this.boardWidth}px`
        this.board.style.height = `${this.boardHeight}px`
      }

      if (this.tiles.length !== this.tileCount) {
        for (const tile of this.tiles) {
          tile.element.removeEventListener('pointerdown', tile.onPointerDown)
          tile.element.removeEventListener('pointerup', tile.onPointerUp)
          tile.element.removeEventListener('pointercancel', tile.onPointerCancel)
        }
        this.tileLayer.innerHTML = ''
        this.tiles = []
        this.createTiles()
      }
    }

    if (state.slots.length !== this.totalSlots) {
      return
    }

    if (!isValidSlotsState(state.slots, this.tileCount)) {
      return
    }

    this.slots = [...state.slots]
    this.emptyIndex = this.slots.indexOf(null)
    if (this.emptyIndex < 0) {
      return
    }

    for (const tile of this.tiles) {
      tile.slotIndex = this.slots.indexOf(tile.id)
    }

    this.completed = Boolean(state.completed) || this.isSolved()

    const gridIsLandscape = this.cols > this.rows
    const deviceIsLandscape = this.getOrientation() === 'landscape'
    if (this.cols !== this.rows && gridIsLandscape !== deviceIsLandscape) {
      this.transposeGrid(gridIsLandscape ? 'cw' : 'ccw')
      this.applyBoardSize()
    }

    this.syncAllTilePositions({ animate: false })
    this.showVictoryTile(this.completed)
    this.emitProgress()
  }

  emitProgress() {
    if (typeof this.onProgress !== 'function') {
      return
    }

    this.onProgress({
      completed: this.completed,
      lockedCount: this.countCorrectTiles(),
      totalCount: this.tileCount,
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

function isAdjacent(indexA, indexB, cols) {
  const rowA = Math.floor(indexA / cols)
  const colA = indexA % cols
  const rowB = Math.floor(indexB / cols)
  const colB = indexB % cols
  return Math.abs(rowA - rowB) + Math.abs(colA - colB) === 1
}

function resolveSwipeDirection(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= SWIPE_MIN_DISTANCE) {
    return dx > 0 ? 'right' : 'left'
  }

  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) >= SWIPE_MIN_DISTANCE) {
    return dy > 0 ? 'down' : 'up'
  }

  return null
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function isValidSlotsState(slots, tileCount) {
  const seen = new Set()
  let nullCount = 0

  for (const value of slots) {
    if (value === null) {
      nullCount += 1
      continue
    }

    if (!Number.isInteger(value) || value < 0 || value >= tileCount || seen.has(value)) {
      return false
    }

    seen.add(value)
  }

  return nullCount === 1 && seen.size === tileCount
}

const DIFFICULTY_TO_GRID = {
  easy: 3,
  medium: 4,
  hard: 6,
  extreme: 7,
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

    this.tiles = []
    this.slots = []
    this.pointerStarts = new Map()

    this.handleWindowResize = () => this.onWindowResize()
  }

  async init() {
    this.destroy()

    this.image = await loadImage(this.imageUrl)
    this.gridSize = this.resolveGridSize(this.difficulty)
    this.totalSlots = this.gridSize * this.gridSize
    this.tileCount = this.totalSlots - 1

    this.createLayout()
    this.createTiles()
    this.resetToSolvedState()
    this.shuffleBoard()

    this.completed = this.isSolved()
    this.showVictoryTile(this.completed)
    this.setReferenceVisible(false)
    this.emitProgress()

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
    this.tiles = []
    this.slots = []
    this.container.innerHTML = ''
  }

  resolveGridSize(difficulty) {
    if (typeof difficulty === 'number' && Number.isFinite(difficulty)) {
      return clamp(Math.round(difficulty), 2, 12)
    }

    const normalized = String(difficulty || 'easy').trim().toLowerCase()
    if (DIFFICULTY_TO_GRID[normalized]) {
      return DIFFICULTY_TO_GRID[normalized]
    }

    const asNumber = Number(normalized)
    if (Number.isFinite(asNumber)) {
      return clamp(Math.round(asNumber), 2, 12)
    }

    return DIFFICULTY_TO_GRID.easy
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
    this.referenceImage.src = this.imageUrl
    this.referenceImage.alt = 'Reference image'

    this.tileLayer = document.createElement('div')
    this.tileLayer.className = 'sliding-tile-layer'

    this.victoryTile = document.createElement('div')
    this.victoryTile.className = 'sliding-victory-tile'

    this.board.append(this.referenceImage, this.tileLayer, this.victoryTile)
    this.boardFrame.append(this.board)
    this.root.append(this.boardFrame)
    this.container.append(this.root)

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

  paintTileFace(tile) {
    const tileRow = Math.floor(tile.homeIndex / this.gridSize)
    const tileCol = tile.homeIndex % this.gridSize

    tile.element.style.backgroundImage = `url("${this.imageUrl}")`
    tile.element.style.backgroundSize = `${this.boardSize}px ${this.boardSize}px`
    tile.element.style.backgroundPosition = `${-tileCol * this.tileSize}px ${-tileRow * this.tileSize}px`
    tile.element.style.width = `${this.tileSize}px`
    tile.element.style.height = `${this.tileSize}px`
  }

  paintVictoryTileFace() {
    const lastIndex = this.totalSlots - 1
    const tileRow = Math.floor(lastIndex / this.gridSize)
    const tileCol = lastIndex % this.gridSize

    this.victoryTile.style.backgroundImage = `url("${this.imageUrl}")`
    this.victoryTile.style.backgroundSize = `${this.boardSize}px ${this.boardSize}px`
    this.victoryTile.style.backgroundPosition = `${-tileCol * this.tileSize}px ${-tileRow * this.tileSize}px`
    this.victoryTile.style.width = `${this.tileSize}px`
    this.victoryTile.style.height = `${this.tileSize}px`
    this.victoryTile.style.transform = `translate(${tileCol * this.tileSize}px, ${tileRow * this.tileSize}px)`
  }

  applyBoardSize() {
    const size = this.calculateBoardSize()
    this.boardSize = size
    this.tileSize = size / this.gridSize

    if (this.board) {
      this.board.style.width = `${this.boardSize}px`
      this.board.style.height = `${this.boardSize}px`
    }

    for (const tile of this.tiles) {
      this.paintTileFace(tile)
      this.positionTile(tile, { animate: false })
    }

    if (this.victoryTile) {
      this.paintVictoryTileFace()
    }
  }

  calculateBoardSize() {
    const containerWidth = this.container.clientWidth || window.innerWidth
    const containerHeight = this.container.clientHeight || window.innerHeight
    const side = Math.min(containerWidth, containerHeight)
    return Math.round(clamp(side - 10, 260, 900))
  }

  onWindowResize() {
    if (!this.board) {
      return
    }
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
    const row = Math.floor(index / this.gridSize)
    const col = index % this.gridSize
    const neighbors = []

    if (row > 0) {
      neighbors.push(index - this.gridSize)
    }
    if (row < this.gridSize - 1) {
      neighbors.push(index + this.gridSize)
    }
    if (col > 0) {
      neighbors.push(index - 1)
    }
    if (col < this.gridSize - 1) {
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
    const tileRow = Math.floor(tile.slotIndex / this.gridSize)
    const tileCol = tile.slotIndex % this.gridSize
    const emptyRow = Math.floor(this.emptyIndex / this.gridSize)
    const emptyCol = this.emptyIndex % this.gridSize

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

    if (!isAdjacent(tile.slotIndex, this.emptyIndex, this.gridSize)) {
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
    const row = Math.floor(tile.slotIndex / this.gridSize)
    const col = tile.slotIndex % this.gridSize

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
      gridSize: this.gridSize,
      slots: [...this.slots],
      emptyIndex: this.emptyIndex,
      completed: this.completed,
      referenceVisible: this.referenceVisible,
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.slots)) {
      return
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
    this.syncAllTilePositions({ animate: false })
    this.showVictoryTile(this.completed)
    this.setReferenceVisible(Boolean(state.referenceVisible))
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

function isAdjacent(indexA, indexB, gridSize) {
  const rowA = Math.floor(indexA / gridSize)
  const colA = indexA % gridSize
  const rowB = Math.floor(indexB / gridSize)
  const colB = indexB % gridSize
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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    image.src = url
  })
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

const DIFFICULTY_TO_GRID = {
  easy: 4,
  medium: 6,
  hard: 8,
  extreme: 10,
}

const SWAP_COMPLETION_STORAGE_KEY = 'xefig:picture-swap:completion:v1'
const CONFETTI_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#8338ec']

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
    this.selectedTileId = null

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
    this.gridSize = this.resolveGridSize(this.difficulty)
    this.totalTiles = this.gridSize * this.gridSize
    this.startedAtMs = Date.now()

    this.createLayout()
    this.createTiles()
    this.shuffleTiles()

    this.completed = this.isSolved()
    this.syncAllTilePositions({ animate: false })
    this.setReferenceVisible(false)
    this.emitProgress()

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
    this.container.innerHTML = ''
  }

  resolveGridSize(difficulty) {
    if (typeof difficulty === 'number' && Number.isFinite(difficulty)) {
      return clamp(Math.round(difficulty), 2, 12)
    }

    const normalized = String(difficulty || 'medium').trim().toLowerCase()
    if (DIFFICULTY_TO_GRID[normalized]) {
      return DIFFICULTY_TO_GRID[normalized]
    }

    const asNumber = Number(normalized)
    if (Number.isFinite(asNumber)) {
      return clamp(Math.round(asNumber), 2, 12)
    }

    return DIFFICULTY_TO_GRID.medium
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
    this.referenceImage.src = this.imageUrl
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
    const size = this.calculateBoardSize()
    this.boardSize = size
    this.tileSize = size / this.gridSize

    if (this.board) {
      this.board.style.width = `${this.boardSize}px`
      this.board.style.height = `${this.boardSize}px`
    }

    if (this.confettiCanvas) {
      this.confettiCanvas.width = Math.round(this.boardSize)
      this.confettiCanvas.height = Math.round(this.boardSize)
    }

    for (const tile of this.tiles) {
      this.paintTileFace(tile)
      this.positionTile(tile, { animate: false })
    }
  }

  calculateBoardSize() {
    const containerWidth = this.container.clientWidth || window.innerWidth
    const containerHeight = this.container.clientHeight || window.innerHeight
    const side = Math.min(containerWidth, containerHeight)
    return Math.round(clamp(side - 10, 260, 920))
  }

  onWindowResize() {
    if (!this.board) {
      return
    }
    this.applyBoardSize()
  }

  paintTileFace(tile) {
    const row = Math.floor(tile.homeIndex / this.gridSize)
    const col = tile.homeIndex % this.gridSize

    tile.element.style.width = `${this.tileSize}px`
    tile.element.style.height = `${this.tileSize}px`
    tile.element.style.backgroundImage = `url("${this.imageUrl}")`
    tile.element.style.backgroundSize = `${this.boardSize}px ${this.boardSize}px`
    tile.element.style.backgroundPosition = `${-col * this.tileSize}px ${-row * this.tileSize}px`
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
      // Deterministic fallback to avoid any fixed-position tile.
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

  isSolved() {
    for (let index = 0; index < this.slots.length; index += 1) {
      if (this.slots[index] !== index) {
        return false
      }
    }
    return true
  }

  countCorrectTiles() {
    let count = 0
    for (let index = 0; index < this.slots.length; index += 1) {
      if (this.slots[index] === index) {
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
    const count = clamp(Math.round(this.gridSize * 22), 90, 240)

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
      difficulty: String(this.difficulty),
      gridSize: this.gridSize,
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
      gridSize: this.gridSize,
      slots: [...this.slots],
      selectedTileId: this.selectedTileId,
      completed: this.completed,
      referenceVisible: this.referenceVisible,
      startedAtMs: this.startedAtMs,
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.slots)) {
      return
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
    this.setReferenceVisible(Boolean(state.referenceVisible))

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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`Failed to load image: ${url}`))
    image.src = url
  })
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

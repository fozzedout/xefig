const SHARD_COUNT_RANGES = {
  easy: [16, 20],
  medium: [25, 30],
  hard: [36, 42],
  extreme: [52, 60],
}

const DRAG_START_DISTANCE = 8
const ROTATION_STEP_DEG = 30
const SNAP_POSITION_MARGIN = 0.05
const SNAP_ROTATION_MARGIN_DEG = 18
const TOUCH_LIFT_MIN_PX = 42
const TOUCH_LIFT_MAX_PX = 88
const MIN_BOARD_SIZE = 180
const MAX_BOARD_SIZE = 980

export class PolygramPuzzle {
  constructor({ container, imageUrl, difficulty = 'medium', onComplete, onProgress }) {
    if (!container) {
      throw new Error('PolygramPuzzle requires a container element.')
    }

    this.container = container
    this.imageUrl = imageUrl
    this.difficulty = difficulty
    this.onComplete = onComplete
    this.onProgress = onProgress

    this.completed = false
    this.referenceVisible = false

    this.shardCount = 0
    this.pieces = []

    this.pointerState = null
    this.boardMetrics = {
      x: 0,
      y: 0,
      size: 0,
    }

    this.handleWindowResize = () => this.onWindowResize()
    this.handleWindowPointerMove = (event) => this.onWindowPointerMove(event)
    this.handleWindowPointerUp = (event) => this.onWindowPointerUp(event)
    this.handleWindowPointerCancel = (event) => this.onWindowPointerCancel(event)
  }

  async init() {
    this.destroy()

    this.image = await loadImage(this.imageUrl)

    const rng = createSeededRng(`${this.imageUrl}|${String(this.difficulty || 'medium')}`)
    this.shardCount = resolveShardCount(this.difficulty, rng)
    this.blueprints = buildVoronoiBlueprints(this.shardCount, rng)
    this.shardCount = this.blueprints.length

    this.createLayout()
    this.createPieces(rng)
    this.applyLayoutMetrics()

    this.completed = this.areAllLocked()
    this.setReferenceVisible(false)
    this.emitProgress()

    window.addEventListener('resize', this.handleWindowResize)
  }

  destroy() {
    window.removeEventListener('resize', this.handleWindowResize)
    this.removeWindowPointerListeners()

    if (this.pieces.length) {
      for (const piece of this.pieces) {
        piece.element.removeEventListener('pointerdown', piece.onPointerDown)
        piece.element.removeEventListener('click', piece.onClick)
      }
    }

    this.pointerState = null
    this.pieces = []
    this.blueprints = []
    this.container.innerHTML = ''
  }

  createLayout() {
    this.root = document.createElement('section')
    this.root.className = 'polygram-root'

    this.boardWrap = document.createElement('div')
    this.boardWrap.className = 'polygram-board-wrap'

    this.board = document.createElement('div')
    this.board.className = 'polygram-board'

    this.ghostImage = document.createElement('img')
    this.ghostImage.className = 'polygram-ghost'
    this.ghostImage.src = this.imageUrl
    this.ghostImage.alt = ''
    this.ghostImage.setAttribute('aria-hidden', 'true')

    this.referenceImage = document.createElement('img')
    this.referenceImage.className = 'polygram-reference'
    this.referenceImage.src = this.imageUrl
    this.referenceImage.alt = 'Reference image'

    this.lockedLayer = document.createElement('div')
    this.lockedLayer.className = 'polygram-locked-layer'

    this.snapHint = document.createElement('div')
    this.snapHint.className = 'polygram-snap-hint'

    this.board.append(this.ghostImage, this.referenceImage, this.lockedLayer, this.snapHint)
    this.boardWrap.append(this.board)

    this.tray = document.createElement('div')
    this.tray.className = 'polygram-tray'

    this.trayTitle = document.createElement('p')
    this.trayTitle.className = 'polygram-tray-title'
    this.trayTitle.textContent = 'Tray'

    this.trayViewport = document.createElement('div')
    this.trayViewport.className = 'polygram-tray-viewport'

    this.trayTrack = document.createElement('div')
    this.trayTrack.className = 'polygram-tray-track'

    this.trayViewport.append(this.trayTrack)
    this.tray.append(this.trayTitle, this.trayViewport)

    this.dragLayer = document.createElement('div')
    this.dragLayer.className = 'polygram-drag-layer'

    this.root.append(this.boardWrap, this.tray, this.dragLayer)
    this.container.append(this.root)
  }

  createPieces(rng) {
    this.pieces = []

    const trayOrder = Array.from({ length: this.blueprints.length }, (_, id) => id)
    shuffleInPlace(trayOrder, rng)

    for (const blueprint of this.blueprints) {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'polygram-piece'
      element.setAttribute('aria-label', `Shard ${blueprint.id + 1}`)
      element.style.clipPath = toClipPath(blueprint.localPoints)

      const rotation = randomRotation(rng)
      const order = trayOrder.indexOf(blueprint.id)

      const piece = {
        id: blueprint.id,
        blueprint,
        element,
        trayOrder: order,
        rotation,
        locked: false,
        dragging: false,
        dragX: 0,
        dragY: 0,
        widthPx: 0,
        heightPx: 0,
        suppressClickUntil: 0,
      }

      piece.onPointerDown = (event) => this.onPiecePointerDown(event, piece)
      piece.onClick = (event) => this.onPieceClick(event, piece)

      element.addEventListener('pointerdown', piece.onPointerDown)
      element.addEventListener('click', piece.onClick)

      this.pieces.push(piece)
      this.trayTrack.append(piece.element)
    }
  }

  onPiecePointerDown(event, piece) {
    if (piece.locked || this.completed) {
      return
    }
    if (this.pointerState) {
      return
    }

    event.preventDefault()

    const rect = piece.element.getBoundingClientRect()
    const centerClientX = rect.left + rect.width / 2
    const centerClientY = rect.top + rect.height / 2
    try {
      piece.element.setPointerCapture(event.pointerId)
    } catch {
      // Best effort; some platforms can reject capture in edge cases.
    }

    this.pointerState = {
      pieceId: piece.id,
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'mouse',
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - centerClientX,
      offsetY: event.clientY - centerClientY,
      liftY:
        event.pointerType && event.pointerType !== 'mouse'
          ? clamp((piece.heightPx || 120) * 0.35, TOUCH_LIFT_MIN_PX, TOUCH_LIFT_MAX_PX)
          : 0,
      dragging: false,
    }

    piece.element.classList.add('is-active')
    this.addWindowPointerListeners()
  }

  addWindowPointerListeners() {
    window.addEventListener('pointermove', this.handleWindowPointerMove)
    window.addEventListener('pointerup', this.handleWindowPointerUp)
    window.addEventListener('pointercancel', this.handleWindowPointerCancel)
  }

  removeWindowPointerListeners() {
    window.removeEventListener('pointermove', this.handleWindowPointerMove)
    window.removeEventListener('pointerup', this.handleWindowPointerUp)
    window.removeEventListener('pointercancel', this.handleWindowPointerCancel)
  }

  onWindowPointerMove(event) {
    const pointer = this.pointerState
    if (!pointer || pointer.pointerId !== event.pointerId) {
      return
    }
    const piece = this.pieces[pointer.pieceId]
    if (!piece) {
      return
    }
    this.onPiecePointerMove(event, piece)
  }

  onWindowPointerUp(event) {
    const pointer = this.pointerState
    if (!pointer || pointer.pointerId !== event.pointerId) {
      return
    }
    const piece = this.pieces[pointer.pieceId]
    if (!piece) {
      this.pointerState = null
      this.removeWindowPointerListeners()
      this.clearSnapHint()
      return
    }
    this.onPiecePointerUp(event, piece)
  }

  onWindowPointerCancel(event) {
    const pointer = this.pointerState
    if (!pointer || pointer.pointerId !== event.pointerId) {
      return
    }
    const piece = this.pieces[pointer.pieceId]
    if (!piece) {
      this.pointerState = null
      this.removeWindowPointerListeners()
      this.clearSnapHint()
      return
    }
    this.onPiecePointerCancel(event, piece)
  }

  onPiecePointerMove(event, piece) {
    const pointer = this.pointerState
    if (!pointer || pointer.pieceId !== piece.id || pointer.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()

    const dx = event.clientX - pointer.startX
    const dy = event.clientY - pointer.startY

    if (!pointer.dragging && Math.hypot(dx, dy) >= DRAG_START_DISTANCE) {
      pointer.dragging = true
      this.startDraggingPiece(piece, pointer)
    }

    if (!pointer.dragging) {
      return
    }

    this.updateDraggedPiecePosition(piece, event.clientX, event.clientY, pointer)
  }

  onPiecePointerUp(event, piece) {
    const pointer = this.pointerState
    if (!pointer || pointer.pieceId !== piece.id || pointer.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    this.pointerState = null
    this.removeWindowPointerListeners()
    piece.element.classList.remove('is-active')

    if (piece.element.hasPointerCapture(event.pointerId)) {
      piece.element.releasePointerCapture(event.pointerId)
    }

    if (!pointer.dragging) {
      piece.suppressClickUntil = performance.now() + 360
      this.clearSnapHint()
      this.rotatePiece(piece)
      return
    }

    piece.suppressClickUntil = performance.now() + 220
    this.finishDraggingPiece(piece)
  }

  onPiecePointerCancel(event, piece) {
    const pointer = this.pointerState
    if (!pointer || pointer.pieceId !== piece.id || pointer.pointerId !== event.pointerId) {
      return
    }

    this.pointerState = null
    this.removeWindowPointerListeners()
    piece.element.classList.remove('is-active')

    if (piece.element.hasPointerCapture(event.pointerId)) {
      piece.element.releasePointerCapture(event.pointerId)
    }

    if (piece.dragging) {
      piece.dragging = false
      piece.element.classList.remove('is-dragging')
      piece.element.classList.remove('is-ready-to-snap')
      this.trayTrack.append(piece.element)
      this.layoutTrayPieces()
    }
    this.clearSnapHint()
  }

  onPieceClick(event, piece) {
    if (piece.locked || this.completed) {
      return
    }

    if (this.pointerState) {
      return
    }

    if (performance.now() < piece.suppressClickUntil) {
      event.preventDefault()
      return
    }

    event.preventDefault()
    this.rotatePiece(piece)
  }

  rotatePiece(piece) {
    piece.rotation += ROTATION_STEP_DEG
    this.layoutTrayPieces()
    this.emitProgress()
  }

  startDraggingPiece(piece, pointer) {
    piece.dragging = true
    piece.element.classList.add('is-dragging')
    this.dragLayer.append(piece.element)
    this.updateDraggedPiecePosition(piece, pointer.startX, pointer.startY, pointer)
  }

  updateDraggedPiecePosition(piece, clientX, clientY, pointer) {
    const rootRect = this.root.getBoundingClientRect()
    piece.dragX = clientX - rootRect.left - pointer.offsetX
    piece.dragY = clientY - rootRect.top - pointer.offsetY - (pointer.liftY || 0)

    this.applyPieceTransform(piece, piece.dragX, piece.dragY, 1)
    piece.element.style.zIndex = '2'
    this.updateSnapHint(piece)
  }

  finishDraggingPiece(piece) {
    piece.dragging = false
    piece.element.classList.remove('is-dragging')
    piece.element.classList.remove('is-ready-to-snap')
    this.clearSnapHint()

    if (this.canSnapPiece(piece)) {
      this.snapPiece(piece)
      this.emitProgress()

      if (this.areAllLocked()) {
        this.handleCompleted()
      }
      return
    }

    this.trayTrack.append(piece.element)
    this.layoutTrayPieces()
    this.emitProgress()
  }

  canSnapPiece(piece) {
    const state = this.getSnapState(piece)
    return Boolean(state?.canSnap)
  }

  getSnapState(piece) {
    if (!this.boardMetrics.size) {
      return null
    }

    const currentCenterX = (piece.dragX - this.boardMetrics.x) / this.boardMetrics.size
    const currentCenterY = (piece.dragY - this.boardMetrics.y) / this.boardMetrics.size
    const targetCenterX = piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2
    const targetCenterY = piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2

    const positionError = Math.hypot(currentCenterX - targetCenterX, currentCenterY - targetCenterY)
    const rotationError = Math.abs(shortestAngleDelta(piece.rotation, 0))

    const canSnap = positionError <= SNAP_POSITION_MARGIN && rotationError <= SNAP_ROTATION_MARGIN_DEG
    const nearTarget = positionError <= SNAP_POSITION_MARGIN * 2.2

    return {
      canSnap,
      nearTarget,
      targetCenterX: targetCenterX * this.boardMetrics.size,
      targetCenterY: targetCenterY * this.boardMetrics.size,
    }
  }

  snapPiece(piece) {
    piece.locked = true
    piece.rotation = nearestEquivalentAngle(piece.rotation, 0)

    piece.element.classList.add('is-locked')
    piece.element.classList.remove('is-ready-to-snap')
    piece.element.style.zIndex = '1'

    this.lockedLayer.append(piece.element)
    this.placePieceOnBoard(piece)
    this.layoutTrayPieces()
  }

  placePieceOnBoard(piece) {
    const x = (piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2) * this.boardMetrics.size
    const y = (piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2) * this.boardMetrics.size
    this.applyPieceTransform(piece, x, y, 1)
  }

  applyLayoutMetrics() {
    if (!this.root || !this.board || !this.tray) {
      return
    }

    const rootWidth = this.root.clientWidth || this.container.clientWidth || window.innerWidth
    const rootHeight = this.root.clientHeight || this.container.clientHeight || window.innerHeight

    const trayHeight = Math.round(clamp(rootHeight * 0.3, 132, 224))
    this.tray.style.height = `${trayHeight}px`

    const boardSide = Math.round(
      clamp(Math.min(rootWidth - 12, rootHeight - trayHeight - 14), MIN_BOARD_SIZE, MAX_BOARD_SIZE),
    )

    this.board.style.width = `${boardSide}px`
    this.board.style.height = `${boardSide}px`

    const rootRect = this.root.getBoundingClientRect()
    const boardRect = this.board.getBoundingClientRect()
    const boardInnerSize = this.board.clientWidth

    this.boardMetrics = {
      x: boardRect.left - rootRect.left + this.board.clientLeft,
      y: boardRect.top - rootRect.top + this.board.clientTop,
      size: boardInnerSize,
    }

    this.paintAllPieces()
    this.syncPieceMounts()
    this.layoutTrayPieces()
  }

  paintAllPieces() {
    const boardSize = this.boardMetrics.size
    const cover = getCoverMetrics(this.image.naturalWidth || this.image.width, this.image.naturalHeight || this.image.height, boardSize)

    for (const piece of this.pieces) {
      piece.widthPx = piece.blueprint.bbox.w * boardSize
      piece.heightPx = piece.blueprint.bbox.h * boardSize

      const pieceBoardX = piece.blueprint.bbox.x * boardSize
      const pieceBoardY = piece.blueprint.bbox.y * boardSize

      piece.element.style.width = `${piece.widthPx}px`
      piece.element.style.height = `${piece.heightPx}px`
      piece.element.style.backgroundImage = `url("${this.imageUrl}")`
      piece.element.style.backgroundSize = `${cover.drawWidth}px ${cover.drawHeight}px`
      piece.element.style.backgroundPosition = `${cover.offsetX - pieceBoardX}px ${cover.offsetY - pieceBoardY}px`
    }
  }

  syncPieceMounts() {
    for (const piece of this.pieces) {
      if (piece.dragging) {
        this.dragLayer.append(piece.element)
        this.applyPieceTransform(piece, piece.dragX, piece.dragY, 1)
        continue
      }

      if (piece.locked) {
        this.lockedLayer.append(piece.element)
        piece.element.classList.add('is-locked')
        this.placePieceOnBoard(piece)
      } else {
        this.trayTrack.append(piece.element)
        piece.element.classList.remove('is-locked')
      }
    }
  }

  layoutTrayPieces() {
    if (!this.trayViewport || !this.trayTrack) {
      return
    }

    const unlocked = this.pieces
      .filter((piece) => !piece.locked && !piece.dragging)
      .sort((a, b) => a.trayOrder - b.trayOrder)

    const viewportWidth = this.trayViewport.clientWidth || this.root.clientWidth || 320
    const slotSize = Math.round(clamp(this.boardMetrics.size * 0.22, 64, 96))
    const gap = Math.round(clamp(slotSize * 0.14, 8, 14))
    const rows = 2
    const columns = Math.max(1, Math.ceil(unlocked.length / rows))

    const trackWidth = Math.max(viewportWidth, gap + columns * (slotSize + gap))
    const trackHeight = gap + rows * (slotSize + gap)

    this.trayTrack.style.width = `${trackWidth}px`
    this.trayTrack.style.height = `${trackHeight}px`

    unlocked.forEach((piece, index) => {
      const row = index % rows
      const col = Math.floor(index / rows)
      const baseX = gap + col * (slotSize + gap)
      const baseY = gap + row * (slotSize + gap)

      const trayScale = Math.min(
        (slotSize * 0.86) / Math.max(1, piece.widthPx),
        (slotSize * 0.86) / Math.max(1, piece.heightPx),
      )

      const centerX = baseX + slotSize / 2
      const centerY = baseY + slotSize / 2

      piece.element.style.zIndex = '1'
      this.applyPieceTransform(piece, centerX, centerY, trayScale)
    })
  }

  applyPieceTransform(piece, centerX, centerY, scale = 1) {
    const left = centerX - piece.widthPx / 2
    const top = centerY - piece.heightPx / 2
    piece.element.style.transform = `translate(${left}px, ${top}px) rotate(${piece.rotation}deg) scale(${scale})`
  }

  updateSnapHint(piece) {
    const snapState = this.getSnapState(piece)
    if (!snapState || !snapState.nearTarget) {
      piece.element.classList.remove('is-ready-to-snap')
      this.clearSnapHint()
      return
    }

    const left = snapState.targetCenterX - piece.widthPx / 2
    const top = snapState.targetCenterY - piece.heightPx / 2

    this.snapHint.style.width = `${piece.widthPx}px`
    this.snapHint.style.height = `${piece.heightPx}px`
    this.snapHint.style.clipPath = piece.element.style.clipPath || 'none'
    this.snapHint.style.transform = `translate(${left}px, ${top}px)`
    this.snapHint.classList.add('is-visible')
    this.snapHint.classList.toggle('is-ready', snapState.canSnap)
    piece.element.classList.toggle('is-ready-to-snap', snapState.canSnap)
  }

  clearSnapHint() {
    if (!this.snapHint) {
      return
    }
    this.snapHint.classList.remove('is-visible', 'is-ready')
  }

  onWindowResize() {
    this.applyLayoutMetrics()
  }

  areAllLocked() {
    return this.pieces.length > 0 && this.pieces.every((piece) => piece.locked)
  }

  handleCompleted() {
    if (this.completed) {
      return
    }

    this.completed = true
    this.emitProgress()

    if (typeof this.onComplete === 'function') {
      this.onComplete({
        lockedCount: this.pieces.length,
        totalCount: this.pieces.length,
      })
    }
  }

  countLockedPieces() {
    return this.pieces.reduce((count, piece) => count + (piece.locked ? 1 : 0), 0)
  }

  getProgressState() {
    return {
      version: 1,
      shardCount: this.shardCount,
      completed: this.completed,
      referenceVisible: this.referenceVisible,
      pieces: this.pieces.map((piece) => ({
        id: piece.id,
        locked: piece.locked,
        rotation: round(normalizeAngle(piece.rotation), 3),
        trayOrder: piece.trayOrder,
      })),
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object') {
      return
    }

    if (!Array.isArray(state.pieces) || Number(state.shardCount) !== this.shardCount) {
      return
    }

    if (state.pieces.length !== this.pieces.length) {
      return
    }

    const byId = new Map()
    for (const item of state.pieces) {
      if (!item || typeof item !== 'object') {
        return
      }
      const id = Number(item.id)
      if (!Number.isInteger(id) || id < 0 || id >= this.pieces.length || byId.has(id)) {
        return
      }
      byId.set(id, item)
    }

    for (const piece of this.pieces) {
      const item = byId.get(piece.id)
      if (!item) {
        continue
      }
      piece.locked = Boolean(item.locked)
      piece.rotation = normalizeAngle(Number(item.rotation) || 0)

      const order = Number(item.trayOrder)
      if (Number.isInteger(order) && order >= 0 && order < this.pieces.length) {
        piece.trayOrder = order
      } else {
        piece.trayOrder = piece.id
      }

      piece.dragging = false
      piece.element.classList.toggle('is-locked', piece.locked)
    }

    this.completed = Boolean(state.completed) || this.areAllLocked()
    this.syncPieceMounts()
    this.layoutTrayPieces()
    this.setReferenceVisible(Boolean(state.referenceVisible))
    this.emitProgress()
  }

  emitProgress() {
    if (typeof this.onProgress !== 'function') {
      return
    }

    this.onProgress({
      completed: this.completed,
      lockedCount: this.countLockedPieces(),
      totalCount: this.pieces.length,
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

function resolveShardCount(difficulty, rng) {
  const normalized = String(difficulty || 'medium').trim().toLowerCase()
  const range = SHARD_COUNT_RANGES[normalized] || SHARD_COUNT_RANGES.medium
  return randomInt(range[0], range[1], rng)
}

function buildVoronoiBlueprints(count, rng) {
  let best = null

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const seeds = generateJitteredSeeds(count, rng)
    const polygons = buildVoronoiPolygons(seeds)
    const blueprints = polygons
      .map((polygon, id) => buildBlueprintFromPolygon(polygon, id))
      .filter(Boolean)

    if (blueprints.length === count) {
      return blueprints
    }

    if (!best || blueprints.length > best.length) {
      best = blueprints
    }
  }

  if (best && best.length) {
    return best
  }

  throw new Error('Unable to generate polygram shards.')
}

function buildBlueprintFromPolygon(polygon, id) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return null
  }

  const area = polygonArea(polygon)
  if (area <= 1e-7) {
    return null
  }

  const bbox = polygonBounds(polygon)
  if (bbox.w <= 1e-6 || bbox.h <= 1e-6) {
    return null
  }

  const localPoints = polygon.map((point) => ({
    x: (point.x - bbox.x) / bbox.w,
    y: (point.y - bbox.y) / bbox.h,
  }))

  return {
    id,
    area,
    polygon,
    bbox,
    localPoints,
  }
}

function getCoverMetrics(imageWidth, imageHeight, boxSize) {
  const safeWidth = Math.max(1, Number(imageWidth) || 1)
  const safeHeight = Math.max(1, Number(imageHeight) || 1)
  const scale = Math.max(boxSize / safeWidth, boxSize / safeHeight)
  const drawWidth = safeWidth * scale
  const drawHeight = safeHeight * scale
  const offsetX = (boxSize - drawWidth) / 2
  const offsetY = (boxSize - drawHeight) / 2

  return {
    drawWidth,
    drawHeight,
    offsetX,
    offsetY,
  }
}

function buildVoronoiPolygons(seeds) {
  const bounds = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]

  return seeds.map((seed, seedIndex) => {
    let cell = bounds

    for (let otherIndex = 0; otherIndex < seeds.length; otherIndex += 1) {
      if (seedIndex === otherIndex) {
        continue
      }

      const other = seeds[otherIndex]
      const midpoint = {
        x: (seed.x + other.x) / 2,
        y: (seed.y + other.y) / 2,
      }
      const normal = {
        x: other.x - seed.x,
        y: other.y - seed.y,
      }

      cell = clipPolygonHalfPlane(cell, midpoint, normal)
      if (cell.length < 3) {
        break
      }
    }

    return cell
  })
}

function clipPolygonHalfPlane(polygon, midpoint, normal) {
  if (!polygon.length) {
    return []
  }

  const clipped = []

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const previous = polygon[(index + polygon.length - 1) % polygon.length]

    const currentValue = halfPlaneValue(current, midpoint, normal)
    const previousValue = halfPlaneValue(previous, midpoint, normal)

    const currentInside = currentValue <= 1e-7
    const previousInside = previousValue <= 1e-7

    if (previousInside && currentInside) {
      clipped.push(current)
      continue
    }

    if (previousInside && !currentInside) {
      const intersection = intersectSegmentWithLine(previous, current, previousValue, currentValue)
      if (intersection) {
        clipped.push(intersection)
      }
      continue
    }

    if (!previousInside && currentInside) {
      const intersection = intersectSegmentWithLine(previous, current, previousValue, currentValue)
      if (intersection) {
        clipped.push(intersection)
      }
      clipped.push(current)
    }
  }

  return clipped
}

function halfPlaneValue(point, midpoint, normal) {
  return (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y
}

function intersectSegmentWithLine(a, b, aValue, bValue) {
  const denominator = aValue - bValue
  if (Math.abs(denominator) < 1e-9) {
    return null
  }

  const t = aValue / (aValue - bValue)
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

function generateJitteredSeeds(count, rng) {
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const cellW = 1 / cols
  const cellH = 1 / rows

  const seeds = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = (col + randomBetween(0.16, 0.84, rng)) * cellW
      const y = (row + randomBetween(0.16, 0.84, rng)) * cellH
      seeds.push({ x, y })
    }
  }

  shuffleInPlace(seeds, rng)
  return seeds.slice(0, count)
}

function toClipPath(localPoints) {
  const points = localPoints
    .map((point) => `${round(point.x * 100, 3)}% ${round(point.y * 100, 3)}%`)
    .join(', ')
  return `polygon(${points})`
}

function polygonBounds(polygon) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const point of polygon) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  }
}

function polygonArea(polygon) {
  let area = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) * 0.5
}

function randomRotation(rng) {
  const steps = Math.floor(randomBetween(0, 12, rng))
  return normalizeAngle(steps * ROTATION_STEP_DEG)
}

function normalizeAngle(value) {
  const normalized = value % 360
  if (normalized < 0) {
    return normalized + 360
  }
  return normalized
}

function shortestAngleDelta(from, to) {
  let delta = normalizeAngle(from) - normalizeAngle(to)
  if (delta > 180) {
    delta -= 360
  }
  if (delta < -180) {
    delta += 360
  }
  return delta
}

function nearestEquivalentAngle(current, target) {
  return current + shortestAngleDelta(target, current)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round(value, precision = 0) {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function shuffleInPlace(items, rng) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1))
    ;[items[index], items[swapIndex]] = [items[swapIndex], items[index]]
  }
  return items
}

function randomInt(min, max, rng) {
  const lower = Math.min(min, max)
  const upper = Math.max(min, max)
  return lower + Math.floor(rng() * (upper - lower + 1))
}

function randomBetween(min, max, rng) {
  return min + rng() * (max - min)
}

function createSeededRng(seedText) {
  let h = 2166136261 >>> 0
  for (let index = 0; index < seedText.length; index += 1) {
    h ^= seedText.charCodeAt(index)
    h = Math.imul(h, 16777619)
  }

  return function rng() {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
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

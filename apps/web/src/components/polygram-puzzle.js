const SHARD_COUNT_RANGES = {
  easy: [36, 42],
  medium: [52, 60],
  hard: [80, 96],
  extreme: [120, 144],
}

const DRAG_START_DISTANCE = 8
const TRAY_SCROLL_START_DISTANCE = 10
const ROTATION_STEP_DEG = 30
const SNAP_POSITION_MARGIN = 0.08
const SNAP_ROTATION_MARGIN_DEG = 22
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
    this.selectedPieceId = null

    this.pointerState = null
    this.boardMetrics = {
      x: 0,
      y: 0,
      size: 0,
    }

    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.touchPoints = new Map()
    this.pinchState = null
    this.panState = null

    this.handleWindowResize = () => this.onWindowResize()
    this.handleWindowPointerMove = (event) => this.onWindowPointerMove(event)
    this.handleWindowPointerUp = (event) => this.onWindowPointerUp(event)
    this.handleWindowPointerCancel = (event) => this.onWindowPointerCancel(event)
    this.handleBoardPointerDown = (event) => this.onBoardPointerDown(event)
    this.handleBoardPointerMove = (event) => this.onBoardPointerMove(event)
    this.handleBoardPointerUp = (event) => this.onBoardPointerUp(event)
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
        piece.element.removeEventListener('pointermove', piece.onPointerMove)
        piece.element.removeEventListener('pointerup', piece.onPointerUp)
        piece.element.removeEventListener('pointercancel', piece.onPointerCancel)
        piece.element.removeEventListener('click', piece.onClick)
      }
    }

    this.pointerState = null
    this.pieces = []
    this.selectedPieceId = null
    this.blueprints = []
    this.touchPoints.clear()
    this.pinchState = null
    this.panState = null
    this.container.innerHTML = ''

    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
  }

  createLayout() {
    this.root = document.createElement('section')
    this.root.className = 'polygram-root'

    this.boardWrap = document.createElement('div')
    this.boardWrap.className = 'polygram-board-wrap'

    this.board = document.createElement('div')
    this.board.className = 'polygram-board'

    this.boardContent = document.createElement('div')
    this.boardContent.className = 'polygram-board-content'

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

    this.placedLayer = document.createElement('div')
    this.placedLayer.className = 'polygram-placed-layer'

    this.boardContent.append(this.ghostImage, this.referenceImage, this.lockedLayer, this.placedLayer, this.snapHint)
    this.board.append(this.boardContent)
    this.boardWrap.append(this.board)

    this.tray = document.createElement('div')
    this.tray.className = 'polygram-tray'

    this.trayHeader = document.createElement('div')
    this.trayHeader.className = 'polygram-tray-header'

    this.trayTitle = document.createElement('div')
    this.trayTitle.className = 'polygram-tray-title'
    this.trayTitle.innerHTML = '<span>Shard Tray</span><small>Drag shards onto the board, then rotate and reposition.</small>'

    this.rotateDock = document.createElement('div')
    this.rotateDock.className = 'polygram-rotate-dock'

    this.rotateStatus = document.createElement('div')
    this.rotateStatus.className = 'polygram-rotate-status'

    this.rotateLabel = document.createElement('span')
    this.rotateLabel.className = 'polygram-rotate-label'
    this.rotateLabel.textContent = 'No shard selected'

    this.rotateStatus.append(this.rotateLabel)

    this.rotateButtons = document.createElement('div')
    this.rotateButtons.className = 'polygram-rotate-buttons'

    this.rotateLeftBtn = document.createElement('button')
    this.rotateLeftBtn.type = 'button'
    this.rotateLeftBtn.className = 'polygram-rotate-btn'
    this.rotateLeftBtn.setAttribute('aria-label', 'Rotate selected shard left')
    this.rotateLeftBtn.textContent = '↺'

    this.rotateRightBtn = document.createElement('button')
    this.rotateRightBtn.type = 'button'
    this.rotateRightBtn.className = 'polygram-rotate-btn'
    this.rotateRightBtn.setAttribute('aria-label', 'Rotate selected shard right')
    this.rotateRightBtn.textContent = '↻'

    this.rotateButtons.append(this.rotateLeftBtn, this.rotateRightBtn)
    this.rotateDock.append(this.rotateStatus, this.rotateButtons)

    this.trayScroller = document.createElement('div')
    this.trayScroller.className = 'polygram-tray-scroller'

    this.trayViewport = document.createElement('div')
    this.trayViewport.className = 'polygram-tray-viewport'

    this.trayTrack = document.createElement('div')
    this.trayTrack.className = 'polygram-tray-track'

    this.trayViewport.append(this.trayTrack)
    this.trayScroller.append(this.trayViewport)
    this.trayHeader.append(this.trayTitle, this.rotateDock)
    this.tray.append(this.trayHeader, this.trayScroller)

    this.dragLayer = document.createElement('div')
    this.dragLayer.className = 'polygram-drag-layer'

    this.root.append(this.boardWrap, this.tray, this.dragLayer)
    this.container.append(this.root)

    this.rotateLeftBtn.addEventListener('click', () => this.rotateSelectedPiece(-1))
    this.rotateRightBtn.addEventListener('click', () => this.rotateSelectedPiece(1))
    this.updateRotateDock()

    this.board.addEventListener('pointerdown', this.handleBoardPointerDown)
    this.board.addEventListener('pointermove', this.handleBoardPointerMove)
    this.board.addEventListener('pointerup', this.handleBoardPointerUp)
    this.board.addEventListener('pointercancel', this.handleBoardPointerUp)

    this.updateBoardTransform()
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
        placed: false,
        dragging: false,
        dragX: 0,
        dragY: 0,
        widthPx: 0,
        heightPx: 0,
        suppressClickUntil: 0,
      }

      piece.onPointerDown = (event) => this.onPiecePointerDown(event, piece)
      piece.onPointerMove = (event) => this.onPiecePointerMove(event, piece)
      piece.onPointerUp = (event) => this.onPiecePointerUp(event, piece)
      piece.onPointerCancel = (event) => this.onPiecePointerCancel(event, piece)
      piece.onClick = (event) => this.onPieceClick(event, piece)

      element.addEventListener('pointerdown', piece.onPointerDown)
      element.addEventListener('pointermove', piece.onPointerMove)
      element.addEventListener('pointerup', piece.onPointerUp)
      element.addEventListener('pointercancel', piece.onPointerCancel)
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

    this.selectPiece(piece.id)

    const rect = piece.element.getBoundingClientRect()
    const centerClientX = rect.left + rect.width / 2
    const centerClientY = rect.top + rect.height / 2

    this.pointerState = {
      pieceId: piece.id,
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'mouse',
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - centerClientX,
      offsetY: event.clientY - centerClientY,
      dragging: false,
      scrollingTray: false,
      trayScrollStartLeft: this.trayViewport?.scrollLeft || 0,
    }

    try {
      piece.element.setPointerCapture(event.pointerId)
    } catch {
      // Best effort; some platforms can reject capture in edge cases.
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

    if (!pointer.dragging && !pointer.scrollingTray && this.shouldScrollTray(pointer, piece, dx, dy)) {
      pointer.scrollingTray = true
      piece.element.classList.remove('is-active')
      this.clearSnapHint()
    }

    if (pointer.scrollingTray) {
      if (this.trayViewport) {
        this.trayViewport.scrollLeft = pointer.trayScrollStartLeft - dx
      }
      return
    }

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

    if (pointer.scrollingTray) {
      piece.suppressClickUntil = performance.now() + 220
      this.clearSnapHint()
      return
    }

    if (!pointer.dragging) {
      piece.suppressClickUntil = performance.now() + 360
      this.clearSnapHint()
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

    if (pointer.scrollingTray) {
      piece.suppressClickUntil = performance.now() + 220
      this.clearSnapHint()
      return
    }

    if (piece.dragging) {
      piece.dragging = false
      piece.element.classList.remove('is-ready-to-snap')

      // If piece has a stored board position, return it there
      if (piece.element.dataset.boardX) {
        piece.placed = true
        piece.element.classList.add('is-placed')
        this.placedLayer.append(piece.element)
        this.applyPlacedPieceTransform(piece)
      } else {
        this.trayTrack.append(piece.element)
      }
      // Remove is-dragging after reparent + transform to avoid animated jump
      piece.element.classList.remove('is-dragging')
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
    this.selectPiece(piece.id)
  }

  rotatePiece(piece, direction = 1) {
    piece.rotation += ROTATION_STEP_DEG * direction
    piece.element.classList.add('is-rotating')

    if (piece.placed) {
      // Rotate in-place on the board — reapply transform at current position
      this.applyPlacedPieceTransform(piece)

      // Check if rotation brought it into snap range
      if (this.canSnapPlacedPiece(piece)) {
        piece.placed = false
        piece.element.classList.remove('is-placed')
        piece.element.classList.remove('is-rotating')
        this.snapPiece(piece)
        if (this.areAllLocked()) {
          this.handleCompleted()
        }
        return
      }
    } else {
      this.layoutTrayPieces()
    }

    this.updateRotateDock()
    this.emitProgress()

    // Remove animation class after transition completes
    const onEnd = () => {
      piece.element.classList.remove('is-rotating')
      piece.element.removeEventListener('transitionend', onEnd)
    }
    piece.element.addEventListener('transitionend', onEnd)
    // Fallback cleanup
    setTimeout(onEnd, 300)
  }

  applyPlacedPieceTransform(piece) {
    // placed pieces store position relative to the board
    const boardRelX = parseFloat(piece.element.dataset.boardX) || 0
    const boardRelY = parseFloat(piece.element.dataset.boardY) || 0
    this.applyPieceTransform(piece, boardRelX, boardRelY, 1)
  }

  canSnapPlacedPiece(piece) {
    if (!this.boardMetrics.size) {
      return false
    }
    const boardRelX = parseFloat(piece.element.dataset.boardX) || 0
    const boardRelY = parseFloat(piece.element.dataset.boardY) || 0
    const currentCenterX = boardRelX / this.boardMetrics.size
    const currentCenterY = boardRelY / this.boardMetrics.size
    const targetCenterX = piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2
    const targetCenterY = piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2

    const positionError = Math.hypot(currentCenterX - targetCenterX, currentCenterY - targetCenterY)
    const rotationError = Math.abs(shortestAngleDelta(piece.rotation, 0))

    return positionError <= SNAP_POSITION_MARGIN && rotationError <= SNAP_ROTATION_MARGIN_DEG
  }

  rotateSelectedPiece(direction) {
    const piece = this.getSelectedPiece()
    if (!piece || piece.locked || piece.dragging || this.completed) {
      return
    }

    this.rotatePiece(piece, direction)
  }

  getSelectedPiece() {
    if (!Number.isInteger(this.selectedPieceId)) {
      return null
    }

    return this.pieces[this.selectedPieceId] || null
  }

  selectPiece(pieceId) {
    const previous = this.selectedPieceId
    if (!Number.isInteger(pieceId)) {
      this.selectedPieceId = null
    } else {
      const piece = this.pieces[pieceId]
      this.selectedPieceId = piece && !piece.locked ? pieceId : null
    }

    for (const piece of this.pieces) {
      const isNowSelected = piece.id === this.selectedPieceId
      piece.element.classList.toggle('is-selected', isNowSelected)

      // Pulse animation on newly selected piece
      if (isNowSelected && previous !== this.selectedPieceId) {
        piece.element.classList.remove('is-select-pulse')
        // Force reflow to restart animation
        void piece.element.offsetWidth
        piece.element.classList.add('is-select-pulse')
      } else if (!isNowSelected) {
        piece.element.classList.remove('is-select-pulse')
      }
    }

    this.updateRotateDock()
    if (previous !== this.selectedPieceId) {
      this.emitProgress()
    }
  }

  updateRotateDock() {
    if (!this.rotateLabel || !this.rotateLeftBtn || !this.rotateRightBtn) {
      return
    }

    const piece = this.getSelectedPiece()
    const disabled = !piece || piece.locked || piece.dragging || this.completed
    this.rotateLeftBtn.disabled = disabled
    this.rotateRightBtn.disabled = disabled

    if (!piece) {
      this.rotateLabel.textContent = 'No shard selected'
      this.rotateDock.classList.remove('has-selection')
      return
    }

    this.rotateLabel.textContent = `Shard ${piece.id + 1}`
    this.rotateDock.classList.add('has-selection')
  }

  shouldScrollTray(pointer, piece, dx, dy) {
    if (!pointer || !piece || pointer.pointerType === 'mouse' || piece.locked || piece.dragging) {
      return false
    }

    const withinTray = piece.element.parentElement === this.trayTrack
    if (!withinTray) {
      return false
    }

    const absDx = Math.abs(dx)
    const absDy = Math.abs(dy)
    return absDx >= TRAY_SCROLL_START_DISTANCE && absDx > absDy * 1.15
  }

  startDraggingPiece(piece, pointer) {
    const wasPlaced = piece.placed
    piece.dragging = true
    piece.placed = false
    piece.element.classList.add('is-dragging')
    piece.element.classList.remove('is-placed')

    try {
      piece.element.setPointerCapture(pointer.pointerId)
    } catch {
      // Ignored
    }

    this.selectPiece(piece.id)
    this.dragLayer.append(piece.element)

    if (wasPlaced) {
      // Recalculate offset so piece center stays under the pointer
      const rect = piece.element.getBoundingClientRect()
      const centerClientX = rect.left + rect.width / 2
      const centerClientY = rect.top + rect.height / 2
      pointer.offsetX = pointer.startX - centerClientX
      pointer.offsetY = pointer.startY - centerClientY
    }

    this.updateDraggedPiecePosition(piece, pointer.startX, pointer.startY, pointer)
  }

  updateDraggedPiecePosition(piece, clientX, clientY, pointer) {
    const rootRect = this.root.getBoundingClientRect()
    piece.dragX = clientX - rootRect.left - pointer.offsetX
    piece.dragY = clientY - rootRect.top - pointer.offsetY

    this.applyPieceTransform(piece, piece.dragX, piece.dragY, this.zoom)
    piece.element.style.zIndex = '2'

    // Convert drag position from root-relative to board-content space for snap checking
    const boardRelX = (piece.dragX - this.boardMetrics.x - this.panX) / this.zoom
    const boardRelY = (piece.dragY - this.boardMetrics.y - this.panY) / this.zoom
    piece.boardSnapX = boardRelX
    piece.boardSnapY = boardRelY
    this.updateSnapHint(piece)
  }

  finishDraggingPiece(piece) {
    piece.dragging = false
    piece.element.classList.remove('is-ready-to-snap')
    this.clearSnapHint()

    // Keep is-dragging (transition: none) until after reparent + transform,
    // so the coordinate-system change doesn't trigger an animated jump.

    if (this.canSnapPiece(piece)) {
      this.snapPiece(piece)
      piece.element.classList.remove('is-dragging')
      this.emitProgress()

      if (this.areAllLocked()) {
        this.handleCompleted()
      }
      return
    }

    // If the piece was dropped in the tray area, return it to the tray
    if (this.isDragInTrayArea(piece)) {
      piece.placed = false
      piece.element.classList.remove('is-placed')
      this.trayTrack.append(piece.element)
      this.layoutTrayPieces()
      piece.element.classList.remove('is-dragging')
      this.emitProgress()
      return
    }

    // Otherwise, place the piece on the board for rotation and repositioning
    piece.placed = true
    piece.element.classList.add('is-placed')
    this.placedLayer.append(piece.element)
    // Convert root-relative drag position to board-content space (accounting for zoom/pan)
    const boardRelX = (piece.dragX - this.boardMetrics.x - this.panX) / this.zoom
    const boardRelY = (piece.dragY - this.boardMetrics.y - this.panY) / this.zoom
    piece.element.dataset.boardX = boardRelX
    piece.element.dataset.boardY = boardRelY
    this.applyPieceTransform(piece, boardRelX, boardRelY, 1)
    piece.element.style.zIndex = '1'
    piece.element.classList.remove('is-dragging')
    this.selectPiece(piece.id)
    this.layoutTrayPieces()
    this.emitProgress()
  }

  isDragInTrayArea(piece) {
    if (!this.tray) {
      return false
    }
    const trayRect = this.tray.getBoundingClientRect()
    const rootRect = this.root.getBoundingClientRect()
    const pieceCenterY = piece.dragY + rootRect.top
    return pieceCenterY >= trayRect.top
  }

  canSnapPiece(piece) {
    const state = this.getSnapState(piece)
    return Boolean(state?.canSnap)
  }

  getSnapState(piece) {
    if (!this.boardMetrics.size) {
      return null
    }

    // Use zoom-aware board coordinates computed during drag
    const boardSize = this.boardMetrics.size
    const currentCenterX = (piece.boardSnapX ?? ((piece.dragX - this.boardMetrics.x - this.panX) / this.zoom)) / boardSize
    const currentCenterY = (piece.boardSnapY ?? ((piece.dragY - this.boardMetrics.y - this.panY) / this.zoom)) / boardSize
    const targetCenterX = piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2
    const targetCenterY = piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2

    const positionError = Math.hypot(currentCenterX - targetCenterX, currentCenterY - targetCenterY)
    const rotationError = Math.abs(shortestAngleDelta(piece.rotation, 0))

    const canSnap = positionError <= SNAP_POSITION_MARGIN && rotationError <= SNAP_ROTATION_MARGIN_DEG
    const nearTarget = positionError <= SNAP_POSITION_MARGIN * 2.2

    return {
      canSnap,
      nearTarget,
      targetCenterX: targetCenterX * boardSize,
      targetCenterY: targetCenterY * boardSize,
    }
  }

  snapPiece(piece) {
    piece.locked = true
    piece.placed = false
    piece.rotation = nearestEquivalentAngle(piece.rotation, 0)
    if (this.selectedPieceId === piece.id) {
      this.selectedPieceId = null
    }

    piece.element.classList.add('is-locked')
    piece.element.classList.remove('is-ready-to-snap')
    piece.element.classList.remove('is-placed')
    piece.element.style.zIndex = '1'

    this.lockedLayer.append(piece.element)
    this.placePieceOnBoard(piece)
    this.layoutTrayPieces()
    this.updateRotateDock()

    this.flashSnapOutline(piece)
    this.vibrateOnSnap()
    this.playSnapSound()
  }

  flashSnapOutline(piece) {
    piece.element.classList.add('snap-flash')
    piece.element.addEventListener(
      'animationend',
      () => piece.element.classList.remove('snap-flash'),
      { once: true },
    )
  }

  vibrateOnSnap() {
    try {
      if (navigator.vibrate) {
        navigator.vibrate(15)
      }
    } catch {
      // Best effort haptic feedback.
    }
  }

  playSnapSound() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) {
        return
      }

      if (!this.audioContext) {
        this.audioContext = new AudioContextClass()
      }

      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {})
      }

      const now = this.audioContext.currentTime
      const oscillator = this.audioContext.createOscillator()
      const gain = this.audioContext.createGain()

      oscillator.type = 'triangle'
      oscillator.frequency.setValueAtTime(720, now)
      oscillator.frequency.exponentialRampToValueAtTime(980, now + 0.04)

      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11)

      oscillator.connect(gain)
      gain.connect(this.audioContext.destination)
      oscillator.start(now)
      oscillator.stop(now + 0.12)
    } catch {
      // Best effort sound effect.
    }
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

    const isCompactScreen = rootWidth <= 760
    const trayHeight = isCompactScreen
      ? Math.round(clamp(rootHeight * 0.32, 172, 260))
      : Math.round(clamp(rootHeight * 0.38, 198, 320))
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
        this.applyPieceTransform(piece, piece.dragX, piece.dragY, this.zoom)
        continue
      }

      if (piece.locked) {
        this.lockedLayer.append(piece.element)
        piece.element.classList.add('is-locked')
        piece.element.classList.remove('is-selected')
        piece.element.classList.remove('is-placed')
        this.placePieceOnBoard(piece)
      } else if (piece.placed) {
        this.placedLayer.append(piece.element)
        piece.element.classList.add('is-placed')
        piece.element.classList.remove('is-locked')
        piece.element.classList.toggle('is-selected', piece.id === this.selectedPieceId)
        this.applyPlacedPieceTransform(piece)
      } else {
        this.trayTrack.append(piece.element)
        piece.element.classList.remove('is-locked')
        piece.element.classList.remove('is-placed')
        piece.element.classList.toggle('is-selected', piece.id === this.selectedPieceId)
      }
    }
  }

  layoutTrayPieces() {
    if (!this.trayViewport || !this.trayTrack) {
      return
    }

    const unlocked = this.pieces
      .filter((piece) => !piece.locked && !piece.dragging && !piece.placed)
      .sort((a, b) => a.trayOrder - b.trayOrder)

    const viewportWidth = this.trayViewport.clientWidth || this.root.clientWidth || 320
    const isCompactScreen = viewportWidth <= 760
    const slotSize = Math.round(clamp(this.boardMetrics.size * (isCompactScreen ? 0.32 : 0.22), 72, 120))
    const gap = Math.round(clamp(slotSize * 0.16, 10, 16))
    const slotInset = Math.round(clamp(slotSize * 0.14, 10, 16))
    const usableSlotSize = slotSize - slotInset
    const columns = Math.max(1, unlocked.length)

    const trackWidth = Math.max(viewportWidth, gap + columns * (slotSize + gap))
    const trackHeight = gap * 2 + slotSize + slotInset

    this.trayTrack.style.width = `${trackWidth}px`
    this.trayTrack.style.height = `${trackHeight}px`

    unlocked.forEach((piece, index) => {
      const baseX = gap + index * (slotSize + gap)
      const baseY = gap + slotInset / 2
      const trayBounds = getRotatedBounds(piece.widthPx, piece.heightPx, piece.rotation)

      const trayScale = Math.min(
        usableSlotSize / Math.max(1, trayBounds.width),
        usableSlotSize / Math.max(1, trayBounds.height),
      )

      const centerX = baseX + slotSize / 2
      const centerY = baseY + slotSize / 2

      piece.element.style.zIndex = '1'
      this.applyPieceTransform(piece, centerX, centerY, trayScale)
      piece.element.classList.toggle('is-selected', piece.id === this.selectedPieceId)
    })

    this.updateRotateDock()
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

  // --- Zoom and pan ---

  onBoardPointerDown(event) {
    if (event.pointerType !== 'touch' || this.pointerState) {
      return
    }
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.touchPoints.size === 2) {
      this.panState = null
      this.beginPinch()
    } else if (this.touchPoints.size === 1 && this.zoom > 1) {
      this.panState = { startX: event.clientX, startY: event.clientY, startPanX: this.panX, startPanY: this.panY }
    }
  }

  onBoardPointerMove(event) {
    if (this.pointerState || !this.touchPoints.has(event.pointerId)) {
      return
    }
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })

    // Two-finger pinch zoom
    if (this.touchPoints.size >= 2 && this.pinchState) {
      event.preventDefault()

      const points = [...this.touchPoints.values()]
      const center = midpoint(points[0], points[1])
      const distance = Math.max(1, distanceBetween(points[0], points[1]))
      const boardRect = this.board.getBoundingClientRect()

      const scaleRatio = distance / this.pinchState.startDistance
      const nextScale = clamp(this.pinchState.startScale * scaleRatio, 1, 4)

      const centerX = center.x - boardRect.left
      const centerY = center.y - boardRect.top

      const nextPanX = centerX - this.pinchState.anchorX * nextScale
      const nextPanY = centerY - this.pinchState.anchorY * nextScale

      this.zoom = nextScale
      const clamped = this.clampPan(nextPanX, nextPanY, nextScale)
      this.panX = clamped.x
      this.panY = clamped.y
      this.updateBoardTransform()
      return
    }

    // Single-finger pan when zoomed
    if (this.touchPoints.size === 1 && this.panState) {
      event.preventDefault()
      const dx = event.clientX - this.panState.startX
      const dy = event.clientY - this.panState.startY
      const clamped = this.clampPan(this.panState.startPanX + dx, this.panState.startPanY + dy, this.zoom)
      this.panX = clamped.x
      this.panY = clamped.y
      this.updateBoardTransform()
    }
  }

  onBoardPointerUp(event) {
    if (this.pointerState) {
      this.touchPoints.delete(event.pointerId)
      this.pinchState = null
      this.panState = null
      return
    }
    if (!this.touchPoints.has(event.pointerId)) {
      return
    }
    this.touchPoints.delete(event.pointerId)
    if (this.touchPoints.size < 2) {
      this.pinchState = null
    }
    if (this.touchPoints.size === 0) {
      this.panState = null
    }
    if (this.touchPoints.size === 2) {
      this.beginPinch()
    }
  }

  beginPinch() {
    if (this.touchPoints.size < 2) {
      this.pinchState = null
      return
    }
    const [pointA, pointB] = [...this.touchPoints.values()]
    const center = midpoint(pointA, pointB)
    const boardRect = this.board.getBoundingClientRect()

    this.pinchState = {
      startScale: this.zoom,
      startDistance: Math.max(1, distanceBetween(pointA, pointB)),
      anchorX: (center.x - boardRect.left - this.panX) / this.zoom,
      anchorY: (center.y - boardRect.top - this.panY) / this.zoom,
    }
  }

  clampPan(panX, panY, scale) {
    const boardSize = this.boardMetrics.size || 1
    const scaledSize = boardSize * scale
    const minX = Math.min(0, boardSize - scaledSize)
    const minY = Math.min(0, boardSize - scaledSize)
    return {
      x: clamp(panX, minX, 0),
      y: clamp(panY, minY, 0),
    }
  }

  updateBoardTransform() {
    if (!this.boardContent) {
      return
    }
    this.boardContent.style.transformOrigin = '0 0'
    this.boardContent.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`
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
    this.updateRotateDock()
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
      selectedPieceId: this.selectedPieceId,
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      pieces: this.pieces.map((piece) => ({
        id: piece.id,
        locked: piece.locked,
        placed: piece.placed,
        rotation: round(normalizeAngle(piece.rotation), 3),
        trayOrder: piece.trayOrder,
        boardX: piece.placed ? parseFloat(piece.element.dataset.boardX) || 0 : undefined,
        boardY: piece.placed ? parseFloat(piece.element.dataset.boardY) || 0 : undefined,
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
      piece.placed = Boolean(item.placed) && !piece.locked
      piece.rotation = normalizeAngle(Number(item.rotation) || 0)

      const order = Number(item.trayOrder)
      if (Number.isInteger(order) && order >= 0 && order < this.pieces.length) {
        piece.trayOrder = order
      } else {
        piece.trayOrder = piece.id
      }

      if (piece.placed && item.boardX != null && item.boardY != null) {
        piece.element.dataset.boardX = Number(item.boardX) || 0
        piece.element.dataset.boardY = Number(item.boardY) || 0
      }

      piece.dragging = false
      piece.element.classList.toggle('is-locked', piece.locked)
      piece.element.classList.toggle('is-placed', piece.placed)
    }

    const selectedPieceId = Number(state.selectedPieceId)
    this.selectedPieceId =
      Number.isInteger(selectedPieceId) &&
      selectedPieceId >= 0 &&
      selectedPieceId < this.pieces.length &&
      !this.pieces[selectedPieceId].locked
        ? selectedPieceId
        : null

    const rawZoom = Number(state.zoom)
    this.zoom = Number.isFinite(rawZoom) ? clamp(rawZoom, 1, 4) : 1
    const clamped = this.clampPan(Number(state.panX) || 0, Number(state.panY) || 0, this.zoom)
    this.panX = clamped.x
    this.panY = clamped.y
    this.updateBoardTransform()

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
    this.selectPiece(null)
    this.setReferenceVisible(false)
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.updateBoardTransform()
    this.emitProgress()
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

function getRotatedBounds(width, height, rotationDeg) {
  const safeWidth = Math.max(1, Number(width) || 1)
  const safeHeight = Math.max(1, Number(height) || 1)
  const radians = (normalizeAngle(rotationDeg) * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))

  return {
    width: safeWidth * cos + safeHeight * sin,
    height: safeWidth * sin + safeHeight * cos,
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

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

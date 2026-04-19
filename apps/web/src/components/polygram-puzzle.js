import { loadImage, releaseLoadedImage } from './image-loader.js'

const SHARD_COUNT_RANGES = {
  easy: [36, 42],
  medium: [52, 60],
  hard: [80, 96],
  extreme: [120, 144],
}

const SNAP_POSITION_MARGIN = 0.08
const SNAP_ROTATION_MARGIN_DEG = 22
const MIN_BOARD_SIZE = 180
const MAX_BOARD_SIZE = 1400
const WHEEL_ROTATION_DEG = 15

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
    this.displayImageUrl = imageUrl

    this.shardCount = 0
    this.pieces = []
    this.heldPieceId = null
    this.ringPieceId = null // piece with rotation ring visible

    this.boardMetrics = { x: 0, y: 0, size: 0 }

    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.touchPoints = new Map()
    this.pinchState = null
    this.panState = null
    this.ringDragState = null
    this.trackingPointerId = null

    this.handleWindowResize = () => this.onWindowResize()
  }

  async init() {
    this.destroy()

    this.image = await loadImage(this.imageUrl)
    this.displayImageUrl = this.image.currentSrc || this.image.src || this.imageUrl

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

    if (this.root) {
      this.root.removeEventListener('pointermove', this._onRootPointerMove)
      this.root.removeEventListener('pointerup', this._onRootPointerUp)
      this.root.removeEventListener('pointerdown', this._onRootPointerDown)
      this.root.removeEventListener('wheel', this._onWheel)
    }
    if (this.board) {
      this.board.removeEventListener('pointerdown', this._onBoardPointerDown)
      this.board.removeEventListener('pointermove', this._onBoardPointerMove)
      this.board.removeEventListener('pointerup', this._onBoardPointerUp)
      this.board.removeEventListener('pointercancel', this._onBoardPointerUp)
    }

    this.dismissRing()
    this.pieces = []
    this.heldPieceId = null
    this.ringPieceId = null
    this.blueprints = []
    this.touchPoints.clear()
    this.pinchState = null
    this.panState = null
    this.ringDragState = null
    this.trackingPointerId = null
    releaseLoadedImage(this.image)
    this.image = null
    this.displayImageUrl = this.imageUrl
    this.container.innerHTML = ''

    if (this.audioContext) {
      this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

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
    this.ghostImage.src = this.displayImageUrl
    this.ghostImage.alt = ''
    this.ghostImage.setAttribute('aria-hidden', 'true')

    this.referenceImage = document.createElement('img')
    this.referenceImage.className = 'polygram-reference'
    this.referenceImage.src = this.displayImageUrl
    this.referenceImage.alt = 'Reference image'

    this.lockedLayer = document.createElement('div')
    this.lockedLayer.className = 'polygram-locked-layer'

    this.snapHint = document.createElement('div')
    this.snapHint.className = 'polygram-snap-hint'

    this.placedLayer = document.createElement('div')
    this.placedLayer.className = 'polygram-placed-layer'

    this.rotateRing = document.createElement('div')
    this.rotateRing.className = 'polygram-rotate-ring'
    this.rotateRing.innerHTML = '<div class="polygram-ring-knob"></div>'

    this.boardContent.append(this.ghostImage, this.referenceImage, this.lockedLayer, this.placedLayer, this.snapHint, this.rotateRing)
    this.board.append(this.boardContent)
    this.boardWrap.append(this.board)

    this.tray = document.createElement('div')
    this.tray.className = 'polygram-tray'

    this.trayGrid = document.createElement('div')
    this.trayGrid.className = 'polygram-tray-grid'

    this.tray.append(this.trayGrid)

    this.heldLayer = document.createElement('div')
    this.heldLayer.className = 'polygram-held-layer'

    this.root.append(this.boardWrap, this.tray, this.heldLayer)
    this.container.append(this.root)

    // Board zoom/pan listeners
    this._onBoardPointerDown = (e) => this.onBoardPointerDown(e)
    this._onBoardPointerMove = (e) => this.onBoardPointerMove(e)
    this._onBoardPointerUp = (e) => this.onBoardPointerUp(e)
    this.board.addEventListener('pointerdown', this._onBoardPointerDown)
    this.board.addEventListener('pointermove', this._onBoardPointerMove)
    this.board.addEventListener('pointerup', this._onBoardPointerUp)
    this.board.addEventListener('pointercancel', this._onBoardPointerUp)

    // Ring interaction listeners
    this._onRingPointerDown = (e) => this.onRingPointerDown(e)
    this._onRingPointerMove = (e) => this.onRingPointerMove(e)
    this._onRingPointerUp = (e) => this.onRingPointerUp(e)
    this.rotateRing.addEventListener('pointerdown', this._onRingPointerDown)

    // Root-level interaction listeners
    this._onRootPointerDown = (e) => this.onRootPointerDown(e)
    this._onRootPointerMove = (e) => this.onRootPointerMove(e)
    this._onRootPointerUp = (e) => this.onRootPointerUp(e)
    this._onWheel = (e) => this.onWheel(e)
    this.root.addEventListener('pointerdown', this._onRootPointerDown)
    this.root.addEventListener('pointermove', this._onRootPointerMove)
    this.root.addEventListener('pointerup', this._onRootPointerUp)
    this.root.addEventListener('wheel', this._onWheel, { passive: false })

    this.updateBoardTransform()
  }

  createPieces(rng) {
    this.pieces = []

    const trayOrder = Array.from({ length: this.blueprints.length }, (_, id) => id)
    shuffleInPlace(trayOrder, rng)

    for (const blueprint of this.blueprints) {
      const element = document.createElement('div')
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
        state: 'tray', // tray | held | placed | locked
        widthPx: 0,
        heightPx: 0,
      }

      element.addEventListener('pointerdown', (e) => {
        if (piece.state === 'locked' || this.completed) return
        e.preventDefault()
        e.stopPropagation()
        this.onPiecePointerDown(piece, e)
      })

      this.pieces.push(piece)
      this.trayGrid.append(element)
    }
  }

  // ---------------------------------------------------------------------------
  // Interaction: tap to hold, tap to place, gesture to rotate
  // ---------------------------------------------------------------------------

  onPiecePointerDown(piece, event) {
    this.pieceDragState = {
      pieceId: piece.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    }
    this.trackingPointerId = event.pointerId
    try { this.root.setPointerCapture(event.pointerId) } catch {}
  }

  onPieceDragMove(piece, event) {
    if (!this.pieceDragState || this.pieceDragState.pieceId !== piece.id) return
    const dx = event.clientX - this.pieceDragState.startX
    const dy = event.clientY - this.pieceDragState.startY
    if (!this.pieceDragState.moved && Math.hypot(dx, dy) < 8) return

    if (!this.pieceDragState.moved) {
      this.pieceDragState.moved = true
      this.dismissRing()
      this.holdPiece(piece, this.pieceDragState.startX, this.pieceDragState.startY)
    }
  }

  onPieceDragEnd(piece) {
    if (!this.pieceDragState || this.pieceDragState.pieceId !== piece.id) return
    const wasDragged = this.pieceDragState.moved
    this.pieceDragState = null

    if (wasDragged) return // holdPiece already handled it

    // It was a tap, not a drag
    if (piece.state === 'tray') {
      this.dismissRing()
      this.holdPiece(piece, 0, 0) // position will update on next move
    } else if (piece.state === 'placed') {
      if (this.ringPieceId === piece.id) {
        this.dismissRing()
      } else {
        this.dismissRing()
        this.showRing(piece)
      }
    }
  }

  holdPiece(piece, clientX, clientY) {
    // Auto-hide reference overlay when picking up a piece
    if (this.referenceVisible) {
      this.setReferenceVisible(false)
    }

    if (this.heldPieceId != null && this.heldPieceId !== piece.id) {
      this.returnHeldToTray()
    }

    const wasPlaced = piece.state === 'placed'
    let placedRect = null
    if (wasPlaced) {
      placedRect = piece.element.getBoundingClientRect()
    }

    piece.state = 'held'
    this.heldPieceId = piece.id
    piece.element.classList.add('is-held')
    piece.element.classList.remove('is-placed', 'is-selected')
    piece.element.style.pointerEvents = 'none'
    this.root.style.touchAction = 'none'
    this.heldLayer.append(piece.element)

    const rootRect = this.root.getBoundingClientRect()
    let heldX, heldY
    if (placedRect) {
      heldX = placedRect.left + placedRect.width / 2 - rootRect.left
      heldY = placedRect.top + placedRect.height / 2 - rootRect.top
    } else {
      heldX = clientX - rootRect.left
      heldY = clientY - rootRect.top
    }
    this.applyPieceTransform(piece, heldX, heldY, this.zoom)

    this.layoutTrayPieces()
    this.emitProgress()
  }

  placeHeldPiece(clientX, clientY) {
    const piece = this.getHeldPiece()
    if (!piece) return

    const boardRect = this.board.getBoundingClientRect()
    const boardRelX = (clientX - boardRect.left - this.panX * (boardRect.width / this.boardMetrics.width)) / this.zoom
    const boardRelY = (clientY - boardRect.top - this.panY * (boardRect.height / this.boardMetrics.height)) / this.zoom

    piece.state = 'placed'
    this.heldPieceId = null
    piece.element.classList.remove('is-held')
    piece.element.classList.add('is-placed')
    piece.element.style.pointerEvents = ''
    this.root.style.touchAction = ''
    this.releaseAllPointerCaptures()
    piece.element.dataset.boardX = boardRelX
    piece.element.dataset.boardY = boardRelY
    this.placedLayer.append(piece.element)

    if (this.canSnapPlacedPiece(piece)) {
      piece.state = 'tray'
      piece.element.classList.remove('is-placed')
      this.snapPiece(piece)
      if (this.areAllLocked()) {
        this.handleCompleted()
      }
    } else {
      this.applyPlacedPieceTransform(piece)
      this.showRing(piece)
    }

    this.clearSnapHint()
    this.layoutTrayPieces()
    this.emitProgress()
  }

  returnHeldToTray() {
    const piece = this.getHeldPiece()
    if (!piece) return

    piece.state = 'tray'
    this.heldPieceId = null
    piece.element.classList.remove('is-held')
    piece.element.style.pointerEvents = ''
    this.root.style.touchAction = ''
    this.releaseAllPointerCaptures()
    this.trayGrid.append(piece.element)
    this.clearSnapHint()
    this.layoutTrayPieces()
    this.emitProgress()
  }

  getHeldPiece() {
    if (this.heldPieceId == null) return null
    return this.pieces[this.heldPieceId] || null
  }

  releaseAllPointerCaptures() {
    try {
      if (this.trackingPointerId != null && this.root.hasPointerCapture(this.trackingPointerId)) {
        this.root.releasePointerCapture(this.trackingPointerId)
      }
    } catch {}
    this.trackingPointerId = null
  }

  // ---------------------------------------------------------------------------
  // Rotation ring
  // ---------------------------------------------------------------------------

  showRing(piece) {
    this.ringPieceId = piece.id
    const centerX = parseFloat(piece.element.dataset.boardX) || 0
    const centerY = parseFloat(piece.element.dataset.boardY) || 0

    const ringSize = Math.max(piece.widthPx, piece.heightPx) * 1.8
    const left = centerX - ringSize / 2
    const top = centerY - ringSize / 2

    this.rotateRing.style.width = `${ringSize}px`
    this.rotateRing.style.height = `${ringSize}px`
    this.rotateRing.style.transform = `translate(${left}px, ${top}px)`
    this.rotateRing.classList.add('is-visible')

    // Position knob at current rotation angle
    this.updateRingKnob(piece)
  }

  dismissRing() {
    this.ringPieceId = null
    this.ringDragState = null
    if (this.rotateRing) {
      this.rotateRing.classList.remove('is-visible')
    }
  }

  updateRingKnob(piece) {
    const knob = this.rotateRing.querySelector('.polygram-ring-knob')
    if (!knob) return
    const angle = piece.rotation - 90 // CSS: 0deg = top
    const rad = (angle * Math.PI) / 180
    const radius = 50 // percentage
    const kx = 50 + Math.cos(rad) * (radius - 2)
    const ky = 50 + Math.sin(rad) * (radius - 2)
    knob.style.left = `${kx}%`
    knob.style.top = `${ky}%`
  }

  getRingPiece() {
    if (this.ringPieceId == null) return null
    return this.pieces[this.ringPieceId] || null
  }

  onRingPointerDown(event) {
    event.preventDefault()
    event.stopPropagation()
    const piece = this.getRingPiece()
    if (!piece) return

    const ringRect = this.rotateRing.getBoundingClientRect()
    const centerX = ringRect.left + ringRect.width / 2
    const centerY = ringRect.top + ringRect.height / 2
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX)

    this.ringDragState = {
      pointerId: event.pointerId,
      centerX,
      centerY,
      prevAngle: startAngle,
      currentRotation: piece.rotation,
    }

    piece.element.classList.add('is-rotating')
    try { this.rotateRing.setPointerCapture(event.pointerId) } catch {}

    this.rotateRing.addEventListener('pointermove', this._onRingPointerMove)
    this.rotateRing.addEventListener('pointerup', this._onRingPointerUp)
    this.rotateRing.addEventListener('pointercancel', this._onRingPointerUp)
  }

  onRingPointerMove(event) {
    if (!this.ringDragState || event.pointerId !== this.ringDragState.pointerId) return
    event.preventDefault()
    const piece = this.getRingPiece()
    if (!piece) return

    const currentAngle = Math.atan2(
      event.clientY - this.ringDragState.centerY,
      event.clientX - this.ringDragState.centerX,
    )

    // Compute shortest angular delta to avoid the atan2 wrap at ±π
    let deltaRad = currentAngle - this.ringDragState.prevAngle
    if (deltaRad > Math.PI) deltaRad -= 2 * Math.PI
    if (deltaRad < -Math.PI) deltaRad += 2 * Math.PI

    this.ringDragState.prevAngle = currentAngle
    this.ringDragState.currentRotation += (deltaRad * 180) / Math.PI
    piece.rotation = this.ringDragState.currentRotation
    this.applyPlacedPieceTransform(piece)
    this.updateRingKnob(piece)

    // Check auto-snap during rotation
    if (this.canSnapPlacedPiece(piece)) {
      this.dismissRing()
      piece.state = 'tray'
      piece.element.classList.remove('is-placed')
      this.snapPiece(piece)
      this.emitProgress()
      if (this.areAllLocked()) {
        this.handleCompleted()
      }
    }
  }

  onRingPointerUp(event) {
    if (!this.ringDragState || event.pointerId !== this.ringDragState.pointerId) return
    const piece = this.getRingPiece()
    if (piece) piece.element.classList.remove('is-rotating')
    this.ringDragState = null
    this.rotateRing.removeEventListener('pointermove', this._onRingPointerMove)
    this.rotateRing.removeEventListener('pointerup', this._onRingPointerUp)
    this.rotateRing.removeEventListener('pointercancel', this._onRingPointerUp)
    try { this.rotateRing.releasePointerCapture(event.pointerId) } catch {}
    this.emitProgress()
  }

  // ---------------------------------------------------------------------------
  // Root-level pointer handlers
  // ---------------------------------------------------------------------------

  onRootPointerDown(event) {
    if (this.heldPieceId == null) {
      // Dismiss ring if tapping outside it
      if (this.ringPieceId != null && !this.rotateRing.contains(event.target)) {
        const piece = this.getRingPiece()
        if (!piece || !piece.element.contains(event.target)) {
          this.dismissRing()
        }
      }
      return
    }

    if (this.trackingPointerId == null) {
      this.trackingPointerId = event.pointerId
    }
  }

  onRootPointerMove(event) {
    // Check if this is a piece drag-to-hold
    if (this.pieceDragState && event.pointerId === this.pieceDragState.pointerId) {
      const piece = this.pieces[this.pieceDragState.pieceId]
      if (piece) this.onPieceDragMove(piece, event)
    }

    const piece = this.getHeldPiece()
    if (!piece) return
    if (event.pointerId !== this.trackingPointerId) return

    event.preventDefault()
    const rootRect = this.root.getBoundingClientRect()
    const heldX = event.clientX - rootRect.left
    const heldY = event.clientY - rootRect.top
    this.applyPieceTransform(piece, heldX, heldY, this.zoom)

    const boardRelX = (heldX - this.boardMetrics.x - this.panX) / this.zoom
    const boardRelY = (heldY - this.boardMetrics.y - this.panY) / this.zoom
    piece.boardSnapX = boardRelX
    piece.boardSnapY = boardRelY
    this.updateSnapHint(piece)
  }

  onRootPointerUp(event) {
    // Check if this ends a piece drag
    if (this.pieceDragState && event.pointerId === this.pieceDragState.pointerId) {
      const piece = this.pieces[this.pieceDragState.pieceId]
      if (piece) this.onPieceDragEnd(piece)
    }

    if (this.trackingPointerId === event.pointerId) {
      this.trackingPointerId = null
    }

    const piece = this.getHeldPiece()
    if (!piece) return

    const boardRect = this.board.getBoundingClientRect()
    const overBoard = event.clientX >= boardRect.left && event.clientX <= boardRect.right &&
                      event.clientY >= boardRect.top && event.clientY <= boardRect.bottom

    if (overBoard) {
      this.placeHeldPiece(event.clientX, event.clientY)
    } else {
      const trayRect = this.tray.getBoundingClientRect()
      if (event.clientY >= trayRect.top) {
        this.returnHeldToTray()
      }
    }
  }

  // Scroll wheel rotation
  onWheel(event) {
    // Rotate held piece
    let piece = this.getHeldPiece()

    // Or rotate ring piece
    if (!piece) piece = this.getRingPiece()
    if (!piece) return

    event.preventDefault()
    const direction = Math.sign(event.deltaY)
    piece.rotation += direction * WHEEL_ROTATION_DEG

    if (piece.state === 'held') {
      const rootRect = this.root.getBoundingClientRect()
      const heldX = event.clientX - rootRect.left
      const heldY = event.clientY - rootRect.top
      this.applyPieceTransform(piece, heldX, heldY, this.zoom)

      const boardRelX = (heldX - this.boardMetrics.x - this.panX) / this.zoom
      const boardRelY = (heldY - this.boardMetrics.y - this.panY) / this.zoom
      piece.boardSnapX = boardRelX
      piece.boardSnapY = boardRelY
      this.updateSnapHint(piece)
    } else if (piece.state === 'placed') {
      this.applyPlacedPieceTransform(piece)
      this.updateRingKnob(piece)
      if (this.canSnapPlacedPiece(piece)) {
        this.dismissRing()
        piece.state = 'tray'
        piece.element.classList.remove('is-placed')
        this.snapPiece(piece)
        if (this.areAllLocked()) {
          this.handleCompleted()
        }
      }
    }

    this.emitProgress()
  }

  // ---------------------------------------------------------------------------
  // Board zoom/pan (only when no piece is held)
  // ---------------------------------------------------------------------------

  onBoardPointerDown(event) {
    if (this.heldPieceId != null) return // Held piece interaction takes priority
    if (event.pointerType !== 'touch') return
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (this.touchPoints.size === 2) {
      this.panState = null
      this.beginPinch()
    } else if (this.touchPoints.size === 1 && this.zoom > 1) {
      this.panState = { startX: event.clientX, startY: event.clientY, startPanX: this.panX, startPanY: this.panY }
    }
  }

  onBoardPointerMove(event) {
    if (this.heldPieceId != null) return
    if (!this.touchPoints.has(event.pointerId)) return
    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })

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
    if (this.heldPieceId != null) {
      this.touchPoints.delete(event.pointerId)
      return
    }
    if (!this.touchPoints.has(event.pointerId)) return
    this.touchPoints.delete(event.pointerId)
    if (this.touchPoints.size < 2) this.pinchState = null
    if (this.touchPoints.size === 0) this.panState = null
    if (this.touchPoints.size === 2) this.beginPinch()
  }

  beginPinch() {
    if (this.touchPoints.size < 2) { this.pinchState = null; return }
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
    const bw = this.boardMetrics.width || 1
    const bh = this.boardMetrics.height || 1
    const minX = Math.min(0, bw - bw * scale)
    const minY = Math.min(0, bh - bh * scale)
    return { x: clamp(panX, minX, 0), y: clamp(panY, minY, 0) }
  }

  updateBoardTransform() {
    if (!this.boardContent) return
    this.boardContent.style.transformOrigin = '0 0'
    this.boardContent.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`
  }

  // ---------------------------------------------------------------------------
  // Snap logic (kept from original)
  // ---------------------------------------------------------------------------

  applyPlacedPieceTransform(piece) {
    const boardRelX = parseFloat(piece.element.dataset.boardX) || 0
    const boardRelY = parseFloat(piece.element.dataset.boardY) || 0
    this.applyPieceTransform(piece, boardRelX, boardRelY, 1)
  }

  canSnapPlacedPiece(piece) {
    if (!this.boardMetrics.width) return false
    const boardRelX = parseFloat(piece.element.dataset.boardX) || 0
    const boardRelY = parseFloat(piece.element.dataset.boardY) || 0
    const currentCenterX = boardRelX / this.boardMetrics.width
    const currentCenterY = boardRelY / this.boardMetrics.height
    const targetCenterX = piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2
    const targetCenterY = piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2

    const positionError = Math.hypot(currentCenterX - targetCenterX, currentCenterY - targetCenterY)
    const rotationError = Math.abs(shortestAngleDelta(piece.rotation, 0))
    return positionError <= SNAP_POSITION_MARGIN && rotationError <= SNAP_ROTATION_MARGIN_DEG
  }

  canSnapPiece(piece) {
    return Boolean(this.getSnapState(piece)?.canSnap)
  }

  getSnapState(piece) {
    if (!this.boardMetrics.width) return null
    const bw = this.boardMetrics.width
    const bh = this.boardMetrics.height
    const currentCenterX = (piece.boardSnapX ?? ((piece.dragX - this.boardMetrics.x - this.panX) / this.zoom)) / bw
    const currentCenterY = (piece.boardSnapY ?? ((piece.dragY - this.boardMetrics.y - this.panY) / this.zoom)) / bh
    const targetCenterX = piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2
    const targetCenterY = piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2

    const positionError = Math.hypot(currentCenterX - targetCenterX, currentCenterY - targetCenterY)
    const rotationError = Math.abs(shortestAngleDelta(piece.rotation, 0))
    const canSnap = positionError <= SNAP_POSITION_MARGIN && rotationError <= SNAP_ROTATION_MARGIN_DEG
    const nearTarget = positionError <= SNAP_POSITION_MARGIN * 2.2

    return {
      canSnap,
      nearTarget,
      targetCenterX: targetCenterX * bw,
      targetCenterY: targetCenterY * bh,
    }
  }

  snapPiece(piece) {
    piece.state = 'locked'
    piece.rotation = nearestEquivalentAngle(piece.rotation, 0)
    if (this.heldPieceId === piece.id) this.heldPieceId = null

    piece.element.classList.add('is-locked')
    piece.element.classList.remove('is-held', 'is-placed', 'is-ready-to-snap')
    piece.element.style.pointerEvents = ''
    piece.element.style.zIndex = '1'

    this.lockedLayer.append(piece.element)
    this.placePieceOnBoard(piece)
    this.layoutTrayPieces()

    this.flashSnapOutline(piece)
    this.vibrateOnSnap()
    this.playSnapSound()
  }

  flashSnapOutline(piece) {
    piece.element.classList.add('snap-flash')
    piece.element.addEventListener('animationend', () => piece.element.classList.remove('snap-flash'), { once: true })
  }

  vibrateOnSnap() {
    try { if (navigator.vibrate) navigator.vibrate(15) } catch {}
  }

  playSnapSound() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) return
      if (!this.audioContext) this.audioContext = new AudioContextClass()
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {})

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
    } catch {}
  }

  placePieceOnBoard(piece) {
    const x = (piece.blueprint.bbox.x + piece.blueprint.bbox.w / 2) * this.boardMetrics.width
    const y = (piece.blueprint.bbox.y + piece.blueprint.bbox.h / 2) * this.boardMetrics.height
    this.applyPieceTransform(piece, x, y, 1)
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
    if (!this.snapHint) return
    this.snapHint.classList.remove('is-visible', 'is-ready')
  }

  // ---------------------------------------------------------------------------
  // Layout metrics and piece painting
  // ---------------------------------------------------------------------------

  applyLayoutMetrics() {
    if (!this.root || !this.board || !this.tray) return

    const rootWidth = this.root.clientWidth || this.container.clientWidth || window.innerWidth
    const rootHeight = window.innerHeight || this.root.clientHeight || this.container.clientHeight

    const isLandscapeDesktop = rootWidth > rootHeight
    const isPortrait = rootHeight > rootWidth

    // Let CSS drive tray size (auto-sized to shard content in portrait,
    // grid-column width in landscape). Forcing a fixed portrait height
    // padded empty space above/below the shards.
    this.tray.style.height = ''

    // Let CSS grid handle sizing, then read the actual board dimensions
    this.board.style.width = '100%'
    this.board.style.height = '100%'

    const rootRect = this.root.getBoundingClientRect()
    const boardRect = this.board.getBoundingClientRect()

    this.boardMetrics = {
      x: boardRect.left - rootRect.left + this.board.clientLeft,
      y: boardRect.top - rootRect.top + this.board.clientTop,
      width: this.board.clientWidth,
      height: this.board.clientHeight,
    }

    this.paintAllPieces()
    this.syncPieceMounts()
    this.layoutTrayPieces()
  }

  paintAllPieces() {
    const bw = this.boardMetrics.width
    const bh = this.boardMetrics.height
    const cover = getCoverMetrics(this.image.naturalWidth || this.image.width, this.image.naturalHeight || this.image.height, bw, bh)

    for (const piece of this.pieces) {
      piece.widthPx = piece.blueprint.bbox.w * bw
      piece.heightPx = piece.blueprint.bbox.h * bh

      const pieceBoardX = piece.blueprint.bbox.x * bw
      const pieceBoardY = piece.blueprint.bbox.y * bh

      piece.element.style.width = `${piece.widthPx}px`
      piece.element.style.height = `${piece.heightPx}px`
      piece.element.style.backgroundImage = `url("${this.displayImageUrl}")`
      piece.element.style.backgroundSize = `${cover.drawWidth}px ${cover.drawHeight}px`
      piece.element.style.backgroundPosition = `${cover.offsetX - pieceBoardX}px ${cover.offsetY - pieceBoardY}px`
    }
  }

  syncPieceMounts() {
    for (const piece of this.pieces) {
      if (piece.state === 'held') {
        this.heldLayer.append(piece.element)
        piece.element.classList.add('is-held')
        piece.element.style.pointerEvents = 'none'
      } else if (piece.state === 'locked') {
        this.lockedLayer.append(piece.element)
        piece.element.classList.add('is-locked')
        piece.element.classList.remove('is-held', 'is-placed')
        piece.element.style.pointerEvents = ''
        this.placePieceOnBoard(piece)
      } else if (piece.state === 'placed') {
        this.placedLayer.append(piece.element)
        piece.element.classList.add('is-placed')
        piece.element.classList.remove('is-held', 'is-locked')
        piece.element.style.pointerEvents = ''
        this.applyPlacedPieceTransform(piece)
      } else {
        this.trayGrid.append(piece.element)
        piece.element.classList.remove('is-locked', 'is-placed', 'is-held')
        piece.element.style.pointerEvents = ''
      }
    }
  }

  layoutTrayPieces() {
    const unlocked = this.pieces
      .filter((p) => p.state === 'tray')
      .sort((a, b) => a.trayOrder - b.trayOrder)

    const viewportWidth = this.tray.clientWidth || this.root.clientWidth || 320
    const isCompact = viewportWidth <= 760
    const slotSize = Math.round(clamp(Math.min(this.boardMetrics.width, this.boardMetrics.height) * (isCompact ? 0.2 : 0.14), 48, 80))

    for (const piece of unlocked) {
      const bounds = getRotatedBounds(piece.widthPx, piece.heightPx, piece.rotation)
      const scale = Math.min(
        slotSize / Math.max(1, bounds.width),
        slotSize / Math.max(1, bounds.height),
      )

      piece.element.style.position = 'relative'
      piece.element.style.zIndex = '1'
      piece.element.style.flex = '0 0 auto'
      const centerX = piece.widthPx / 2
      const centerY = piece.heightPx / 2
      piece.element.style.transform = `rotate(${piece.rotation}deg) scale(${scale})`
      piece.element.style.transformOrigin = `${centerX}px ${centerY}px`
      piece.element.style.margin = ''
    }
  }

  applyPieceTransform(piece, centerX, centerY, scale = 1) {
    const left = centerX - piece.widthPx / 2
    const top = centerY - piece.heightPx / 2
    piece.element.style.position = 'absolute'
    piece.element.style.margin = ''
    piece.element.style.transformOrigin = ''
    piece.element.style.transform = `translate(${left}px, ${top}px) rotate(${piece.rotation}deg) scale(${scale})`
  }

  onWindowResize() {
    this.applyLayoutMetrics()
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  areAllLocked() {
    return this.pieces.length > 0 && this.pieces.every((p) => p.state === 'locked')
  }

  handleCompleted() {
    if (this.completed) return
    this.completed = true
    this.emitProgress()
    if (typeof this.onComplete === 'function') {
      this.onComplete({ lockedCount: this.pieces.length, totalCount: this.pieces.length })
    }
  }

  countLockedPieces() {
    return this.pieces.reduce((c, p) => c + (p.state === 'locked' ? 1 : 0), 0)
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  getProgressState() {
    return {
      version: 1,
      shardCount: this.shardCount,
      completed: this.completed,
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      pieces: this.pieces.map((piece) => ({
        id: piece.id,
        locked: piece.state === 'locked',
        placed: piece.state === 'placed',
        rotation: round(normalizeAngle(piece.rotation), 3),
        trayOrder: piece.trayOrder,
        boardX: piece.state === 'placed' ? parseFloat(piece.element.dataset.boardX) || 0 : undefined,
        boardY: piece.state === 'placed' ? parseFloat(piece.element.dataset.boardY) || 0 : undefined,
      })),
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object') return
    if (!Array.isArray(state.pieces) || Number(state.shardCount) !== this.shardCount) return
    if (state.pieces.length !== this.pieces.length) return

    const byId = new Map()
    for (const item of state.pieces) {
      if (!item || typeof item !== 'object') return
      const id = Number(item.id)
      if (!Number.isInteger(id) || id < 0 || id >= this.pieces.length || byId.has(id)) return
      byId.set(id, item)
    }

    for (const piece of this.pieces) {
      const item = byId.get(piece.id)
      if (!item) continue

      const locked = Boolean(item.locked)
      const placed = Boolean(item.placed) && !locked
      piece.state = locked ? 'locked' : placed ? 'placed' : 'tray'
      piece.rotation = normalizeAngle(Number(item.rotation) || 0)

      const order = Number(item.trayOrder)
      if (Number.isInteger(order) && order >= 0 && order < this.pieces.length) {
        piece.trayOrder = order
      } else {
        piece.trayOrder = piece.id
      }

      if (piece.state === 'placed' && item.boardX != null && item.boardY != null) {
        piece.element.dataset.boardX = Number(item.boardX) || 0
        piece.element.dataset.boardY = Number(item.boardY) || 0
      }

      piece.element.classList.toggle('is-locked', piece.state === 'locked')
      piece.element.classList.toggle('is-placed', piece.state === 'placed')
      piece.element.classList.remove('is-held')
    }

    const rawZoom = Number(state.zoom)
    this.zoom = Number.isFinite(rawZoom) ? clamp(rawZoom, 1, 4) : 1
    const clamped = this.clampPan(Number(state.panX) || 0, Number(state.panY) || 0, this.zoom)
    this.panX = clamped.x
    this.panY = clamped.y
    this.updateBoardTransform()

    this.completed = Boolean(state.completed) || this.areAllLocked()
    this.syncPieceMounts()
    this.layoutTrayPieces()
    this.emitProgress()
  }

  emitProgress() {
    if (typeof this.onProgress !== 'function') return
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
    if (this.heldPieceId != null) this.returnHeldToTray()
    this.dismissRing()
    this.setReferenceVisible(false)
    this.zoom = 1
    this.panX = 0
    this.panY = 0
    this.updateBoardTransform()
    this.emitProgress()
  }
}

// ---------------------------------------------------------------------------
// Utility functions (unchanged)
// ---------------------------------------------------------------------------

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
    const blueprints = polygons.map((polygon, id) => buildBlueprintFromPolygon(polygon, id)).filter(Boolean)
    if (blueprints.length === count) return blueprints
    if (!best || blueprints.length > best.length) best = blueprints
  }
  if (best && best.length) return best
  throw new Error('Unable to generate polygram shards.')
}

function buildBlueprintFromPolygon(polygon, id) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null
  const area = polygonArea(polygon)
  if (area <= 1e-7) return null
  const bbox = polygonBounds(polygon)
  if (bbox.w <= 1e-6 || bbox.h <= 1e-6) return null
  const localPoints = polygon.map((point) => ({
    x: (point.x - bbox.x) / bbox.w,
    y: (point.y - bbox.y) / bbox.h,
  }))
  return { id, area, polygon, bbox, localPoints }
}

function getCoverMetrics(imageWidth, imageHeight, boxWidth, boxHeight) {
  const bh = boxHeight ?? boxWidth
  const safeWidth = Math.max(1, Number(imageWidth) || 1)
  const safeHeight = Math.max(1, Number(imageHeight) || 1)
  const scale = Math.max(boxWidth / safeWidth, bh / safeHeight)
  const drawWidth = safeWidth * scale
  const drawHeight = safeHeight * scale
  return { drawWidth, drawHeight, offsetX: (boxWidth - drawWidth) / 2, offsetY: (bh - drawHeight) / 2 }
}

function getRotatedBounds(width, height, rotationDeg) {
  const safeWidth = Math.max(1, Number(width) || 1)
  const safeHeight = Math.max(1, Number(height) || 1)
  const radians = (normalizeAngle(rotationDeg) * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  return { width: safeWidth * cos + safeHeight * sin, height: safeWidth * sin + safeHeight * cos }
}

function buildVoronoiPolygons(seeds) {
  const bounds = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  return seeds.map((seed, seedIndex) => {
    let cell = bounds
    for (let otherIndex = 0; otherIndex < seeds.length; otherIndex += 1) {
      if (seedIndex === otherIndex) continue
      const other = seeds[otherIndex]
      const mp = { x: (seed.x + other.x) / 2, y: (seed.y + other.y) / 2 }
      const normal = { x: other.x - seed.x, y: other.y - seed.y }
      cell = clipPolygonHalfPlane(cell, mp, normal)
      if (cell.length < 3) break
    }
    return cell
  })
}

function clipPolygonHalfPlane(polygon, mp, normal) {
  if (!polygon.length) return []
  const clipped = []
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const previous = polygon[(index + polygon.length - 1) % polygon.length]
    const currentValue = halfPlaneValue(current, mp, normal)
    const previousValue = halfPlaneValue(previous, mp, normal)
    const currentInside = currentValue <= 1e-7
    const previousInside = previousValue <= 1e-7
    if (previousInside && currentInside) { clipped.push(current); continue }
    if (previousInside && !currentInside) { const i = intersectSegmentWithLine(previous, current, previousValue, currentValue); if (i) clipped.push(i); continue }
    if (!previousInside && currentInside) { const i = intersectSegmentWithLine(previous, current, previousValue, currentValue); if (i) clipped.push(i); clipped.push(current) }
  }
  return clipped
}

function halfPlaneValue(point, mp, normal) {
  return (point.x - mp.x) * normal.x + (point.y - mp.y) * normal.y
}

function intersectSegmentWithLine(a, b, aValue, bValue) {
  const denominator = aValue - bValue
  if (Math.abs(denominator) < 1e-9) return null
  const t = aValue / (aValue - bValue)
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function generateJitteredSeeds(count, rng) {
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const cellW = 1 / cols
  const cellH = 1 / rows
  const seeds = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      seeds.push({ x: (col + randomBetween(0.16, 0.84, rng)) * cellW, y: (row + randomBetween(0.16, 0.84, rng)) * cellH })
    }
  }
  shuffleInPlace(seeds, rng)
  return seeds.slice(0, count)
}

function toClipPath(localPoints) {
  return `polygon(${localPoints.map((p) => `${round(p.x * 100, 3)}% ${round(p.y * 100, 3)}%`).join(', ')})`
}

function polygonBounds(polygon) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polygon) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function polygonArea(polygon) {
  let area = 0
  for (let i = 0; i < polygon.length; i += 1) { const c = polygon[i]; const n = polygon[(i + 1) % polygon.length]; area += c.x * n.y - n.x * c.y }
  return Math.abs(area) * 0.5
}

function randomRotation(rng) {
  return normalizeAngle(Math.floor(randomBetween(0, 12, rng)) * 30)
}

function normalizeAngle(value) {
  const n = value % 360
  return n < 0 ? n + 360 : n
}

function shortestAngleDelta(from, to) {
  let d = normalizeAngle(from) - normalizeAngle(to)
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return d
}

function nearestEquivalentAngle(current, target) {
  return current + shortestAngleDelta(target, current)
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)) }
function round(value, precision = 0) { const f = 10 ** precision; return Math.round(value * f) / f }
function shuffleInPlace(items, rng) { for (let i = items.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [items[i], items[j]] = [items[j], items[i]] } return items }
function randomInt(min, max, rng) { return Math.min(min, max) + Math.floor(rng() * (Math.abs(max - min) + 1)) }
function randomBetween(min, max, rng) { return min + rng() * (max - min) }

function createSeededRng(seedText) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < seedText.length; i += 1) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619) }
  return function rng() { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
function distanceBetween(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

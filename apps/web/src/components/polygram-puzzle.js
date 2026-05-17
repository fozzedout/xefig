import { loadImage, loadImageThumbFirst, releaseLoadedImage } from './image-loader.js'

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
  constructor({ container, imageUrl, thumbnailUrl, difficulty = 'medium', onComplete, onProgress, onLoadProgress }) {
    if (!container) {
      throw new Error('PolygramPuzzle requires a container element.')
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

    // Tray scroll-vs-drag: mirrors the jigsaw carousel. Touch pointerdown
    // on a tray piece arms an undecided lift; first axis past threshold
    // picks the mode. Taking scroll over from iOS avoids its strict
    // angle heuristic cancelling a diagonal drag.
    this.pendingLift = null
    this.trayMomentumRaf = null

    // Tutorial-only: while true, dropping a held piece always lands it in
    // the 'placed' state (rotation ring) instead of locking, even if the
    // drop position + random initial rotation happen to be within the
    // snap margin. Lets the tutorial guarantee the player sees the
    // rotation lesson on their first drop. Rotation-driven snap honours
    // the flag too, so the player isn't locked into placement until the
    // tutorial clears it.
    this.tutorialBlockSnap = false

    this.handleWindowResize = () => this.onWindowResize()
    this.handleWindowPointerMove = (event) => this.onWindowPointerMove(event)
    this.handleWindowPointerUp = (event) => this.onWindowPointerUp(event)
    this.handleTrayPointerDown = (event) => this.onTrayPointerDown(event)
  }

  async init() {
    this.destroy()

    // Thumb-first so shards become draggable immediately; full image
    // streams in the background and shards get repainted at full
    // quality without disturbing positions or lock state.
    const { image, isThumbnail } = await loadImageThumbFirst(this.thumbnailUrl, this.imageUrl, { onProgress: this.onLoadProgress })
    this.image = image
    this.displayImageUrl = this.image.currentSrc || this.image.src || (isThumbnail ? this.thumbnailUrl : this.imageUrl)

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
        // paintAllPieces re-applies background-image (with the new URL)
        // and re-computes cover metrics from this.image's natural dims.
        this.paintAllPieces()
        // The ghost image and reference image also need their src
        // swapped, otherwise the board background and the eye-toggle
        // preview stay on the upscaled thumbnail (visible as a heavily
        // pixellated background behind the placed shards).
        if (this.ghostImage) {
          this.ghostImage.src = this.displayImageUrl
        }
        if (this.referenceImage) {
          this.referenceImage.src = this.displayImageUrl
        }
      })
      .catch((err) => {
        console.warn('Polygram full image upgrade failed; staying on thumbnail.', err)
      })
  }

  destroy() {
    window.removeEventListener('resize', this.handleWindowResize)
    this.detachWindowTracking()
    this.stopTrayMomentum()
    this.pendingLift = null

    if (this.root) {
      this.root.removeEventListener('pointermove', this._onRootPointerMove)
      this.root.removeEventListener('pointerup', this._onRootPointerUp)
      this.root.removeEventListener('pointerdown', this._onRootPointerDown)
      this.root.removeEventListener('wheel', this._onWheel)
    }
    if (this.tray) {
      this.tray.removeEventListener('pointerdown', this.handleTrayPointerDown)
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

    // Rotation handle: an annulus that captures rotation drags around its
    // ring band, with 12 radial "energy spindles" inside that rotate with
    // the shape. The centre of the annulus is pointer-transparent so the
    // placed shard underneath stays draggable — no mode switching, no
    // tap-to-dismiss to learn. The knob is gone: a single grippy ring
    // doesn't suffer the "handle clipped off-screen" failure mode the
    // small knob had near the board edges.
    const ringSvgNs = 'http://www.w3.org/2000/svg'
    this.rotateRing = document.createElementNS(ringSvgNs, 'svg')
    this.rotateRing.setAttribute('class', 'polygram-rotate-ring')
    this.rotateRing.setAttribute('viewBox', '0 0 100 100')
    this.rotateRing.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    // 6 spindles, evenly spaced (60° apart). Each is three stacked
    // strokes (halo, glow, core) so the "energy" reads on busy/bright
    // backgrounds without an SVG filter (which would re-rasterise on
    // every rotation tick). 6 reads as a star/spark; 12 (the previous
    // count) read as a clock face and competed visually with the photo
    // fragment inside the shard.
    const SPINDLE_COUNT = 6
    const spindleMarkup = []
    for (let i = 0; i < SPINDLE_COUNT; i += 1) {
      const angle = (i / SPINDLE_COUNT) * 360 - 90
      const rad = (angle * Math.PI) / 180
      // Outer end sits just inside the annulus inner edge (r≈36 vs
      // annulus stroke band starting at r=36.5). Inner end runs deep
      // into the shape's likely body (r≈6) — irregular Voronoi shards
      // can be narrow on one axis, so we want spindles to reach close
      // to the centre to guarantee they touch the silhouette from any
      // direction. The placed layer paints the shard on top, so only
      // the segment outside the shape's clip-path is visible.
      const x1 = (50 + Math.cos(rad) * 36).toFixed(2)
      const y1 = (50 + Math.sin(rad) * 36).toFixed(2)
      const x2 = (50 + Math.cos(rad) * 6).toFixed(2)
      const y2 = (50 + Math.sin(rad) * 6).toFixed(2)
      spindleMarkup.push(
        `<line class="polygram-ring-spindle-halo" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
        + `<line class="polygram-ring-spindle-glow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`
        + `<line class="polygram-ring-spindle-core" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`,
      )
    }
    // The annulus is two stacked circles (glow + body) — the body stroke
    // is the hit-target for rotation; the glow is purely visual. Both
    // have fill:none so the centre is transparent to pointer events.
    // Paint order matters: outer glow first (the diffuse halo), then the
    // spindles paint on top of the glow's inner overlap so their tips
    // read as bright sparks rather than dimmed-by-haze blobs, then the
    // crisp annulus body sits on top of everything to define the grip.
    this.rotateRing.innerHTML = `
      <circle class="polygram-ring-annulus-glow" cx="50" cy="50" r="42"/>
      <g class="polygram-ring-spindles">${spindleMarkup.join('')}</g>
      <circle class="polygram-ring-annulus" cx="50" cy="50" r="42"/>
    `

    // Shape-outline overlay: same three-stroke neon stack as the
    // spindles, but as a polygon tracing the shard's silhouette so
    // there's no doubt the shard itself is the source of the energy
    // radiating along the spokes. Lives in its own SVG because it has
    // to sit *above* the placed layer (the actual shard) so the glow
    // is visible. CSS drop-shadow on the shard didn't survive busy
    // photo content — five compounded drop-shadows are too diffuse to
    // read, whereas a hard SVG stroke definitely does.
    this.shapeOutlineRing = document.createElementNS(ringSvgNs, 'svg')
    this.shapeOutlineRing.setAttribute('class', 'polygram-shape-outline')
    this.shapeOutlineRing.setAttribute('viewBox', '0 0 100 100')
    this.shapeOutlineRing.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    this.shapeOutlineRing.innerHTML = `
      <g class="polygram-shape-outline-spin">
        <polygon class="polygram-shape-outline-halo" points=""/>
        <polygon class="polygram-shape-outline-glow" points=""/>
        <polygon class="polygram-shape-outline-core" points=""/>
      </g>
    `

    // Ring SVG sits *before* the placed layer so the shard's clip-path
    // paints on top of the spindles. The visible parts of each spoke
    // are then just the segments outside the shape's silhouette — they
    // read as "emerging from the edge of the shape", which is the
    // spokes-meet-edges look we want even on irregular Voronoi
    // polygons. The annulus stays unobstructed because it sits well
    // outside the shape (r=42 viewBox vs ~r=24 shape half-extent).
    // The outline SVG sits *after* the placed layer so its glowing
    // stroke paints on top of the photo content, tracing the silhouette.
    this.boardContent.append(this.ghostImage, this.referenceImage, this.lockedLayer, this.rotateRing, this.placedLayer, this.shapeOutlineRing, this.snapHint)
    this.board.append(this.boardContent)
    this.boardWrap.append(this.board)

    this.tray = document.createElement('div')
    this.tray.className = 'polygram-tray'

    this.trayGrid = document.createElement('div')
    this.trayGrid.className = 'polygram-tray-grid'

    this.tray.append(this.trayGrid)

    // Match jigsaw's "Highlight loose" button + system. Pieces dropped on
    // the board but not snapped (state === 'placed') can be hard to spot
    // in a dense layout; tapping the sparkle pulses every loose piece.
    this.trayTools = document.createElement('div')
    this.trayTools.className = 'polygram-tray-tools'

    this.highlightTrayBtn = document.createElement('button')
    this.highlightTrayBtn.type = 'button'
    this.highlightTrayBtn.className = 'jigsaw-tray-tool polygram-tray-tool'
    this.highlightTrayBtn.setAttribute('aria-label', 'Highlight loose pieces')
    this.highlightTrayBtn.title = 'Highlight loose pieces'
    this.highlightTrayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 2l1.6 4.6L15 8l-4.4 1.4L9 14l-1.6-4.6L3 8l4.4-1.4Zm8 4l1 2.8 2.8 1-2.8 1L17 14l-1-2.8L13.2 10l2.8-1Zm-4 10l.8 2.2L16 19.2l-2.2.8L13 22l-.8-2-2.2-1 2.2-.8Z"/></svg>'
    this.highlightTrayBtn.addEventListener('click', () => this.highlightLoosePieces())

    // Eye toggle for the reference image — same shape and aria-pressed
    // affordance as jigsaw's. main.js mirrors aria-pressed across this,
    // the menu's view-btn, and (where applicable) the diamond floating
    // source button, via the polygram:reference-toggled event we
    // dispatch below.
    this.revealTrayBtn = document.createElement('button')
    this.revealTrayBtn.type = 'button'
    this.revealTrayBtn.id = 'polygram-reveal-btn'
    this.revealTrayBtn.className = 'jigsaw-tray-tool polygram-tray-tool'
    this.revealTrayBtn.setAttribute('aria-label', 'Show reference image')
    this.revealTrayBtn.setAttribute('aria-pressed', 'false')
    this.revealTrayBtn.title = 'Show reference image'
    this.revealTrayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>'
    this.revealTrayBtn.addEventListener('click', () => {
      const active = this.toggleReferenceVisible()
      this.revealTrayBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
      this.container.dispatchEvent(new CustomEvent('polygram:reference-toggled', { detail: { active }, bubbles: true }))
    })

    this.trayTools.append(this.highlightTrayBtn, this.revealTrayBtn)

    this.heldLayer = document.createElement('div')
    this.heldLayer.className = 'polygram-held-layer'

    this.root.append(this.boardWrap, this.tray, this.trayTools, this.heldLayer)
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

    // Background touches on the tray drive manual scroll directly.
    this.tray.addEventListener('pointerdown', this.handleTrayPointerDown)

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
        // Stop propagation so the tray's background pointerdown handler
        // doesn't also arm a scroll-only lift for the same gesture.
        e.stopPropagation()
        if (e.pointerType === 'touch' && piece.state === 'tray') {
          if (this.pendingLift || this.heldPieceId != null) return
          this.armTrayLift(e, piece)
          return
        }
        e.preventDefault()
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
      // With the annulus design the ring is on whenever a piece is in
      // placed state — tapping the same piece is a no-op (don't yank
      // the rotation handle from under the user). A tap on a *different*
      // placed piece moves the ring to it, which is genuinely useful
      // when the player has stacked up multiple unplaced drops.
      if (this.ringPieceId !== piece.id) {
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
      this.container.dispatchEvent(
        new CustomEvent('polygram:piece-placed', { detail: { piece }, bubbles: true }),
      )
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
  // Tray scroll-vs-drag (mirrors jigsaw-puzzle.js carousel handling)
  // ---------------------------------------------------------------------------

  usesSidebarTray() {
    return window.innerWidth > window.innerHeight
  }

  armTrayLift(event, piece) {
    this.stopTrayMomentum()
    // Touching a tray piece is also the "tap anywhere else" gesture that
    // dismisses an active rotation ring on a placed piece.
    if (this.ringPieceId != null) this.dismissRing()
    this.pendingLift = {
      piece,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: performance.now(),
      velocity: 0,
      mode: 'undecided',
    }
    this.attachWindowTracking()
  }

  onTrayPointerDown(event) {
    if (event.pointerType !== 'touch') return
    if (this.pendingLift || this.heldPieceId != null) return
    this.stopTrayMomentum()
    if (this.ringPieceId != null) this.dismissRing()
    this.pendingLift = {
      piece: null,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      lastT: performance.now(),
      velocity: 0,
      mode: 'scrolling',
    }
    this.attachWindowTracking()
  }

  attachWindowTracking() {
    window.addEventListener('pointermove', this.handleWindowPointerMove)
    window.addEventListener('pointerup', this.handleWindowPointerUp)
    window.addEventListener('pointercancel', this.handleWindowPointerUp)
  }

  detachWindowTracking() {
    window.removeEventListener('pointermove', this.handleWindowPointerMove)
    window.removeEventListener('pointerup', this.handleWindowPointerUp)
    window.removeEventListener('pointercancel', this.handleWindowPointerUp)
  }

  onWindowPointerMove(event) {
    if (!this.pendingLift || this.pendingLift.pointerId !== event.pointerId) return
    const lift = this.pendingLift
    const usesSidebar = this.usesSidebarTray()
    // Drag-axis delta: leftward in landscape (tray on right),
    // downward in portrait (tray on top in immersive).
    const dragDelta = usesSidebar
      ? lift.startX - event.clientX
      : event.clientY - lift.startY
    // Scroll-axis delta: perpendicular to drag axis.
    const scrollDelta = usesSidebar
      ? event.clientY - lift.startY
      : event.clientX - lift.startX

    if (lift.mode === 'scrolling') {
      const now = performance.now()
      const dt = Math.max(1, now - lift.lastT)
      const axisDelta = usesSidebar
        ? event.clientY - lift.lastY
        : event.clientX - lift.lastX
      if (this.trayGrid) {
        if (usesSidebar) this.trayGrid.scrollTop -= axisDelta
        else this.trayGrid.scrollLeft -= axisDelta
      }
      // Rolling velocity in px/ms, blended so a stall right before
      // lift-off doesn't kill the flick's momentum.
      const instant = axisDelta / dt
      lift.velocity = lift.velocity * 0.4 + instant * 0.6
      lift.lastX = event.clientX
      lift.lastY = event.clientY
      lift.lastT = now
      return
    }

    // Undecided — first axis past its threshold picks the mode. Drag
    // threshold is looser so a diagonal drag still commits to drag.
    const DRAG_THRESHOLD = 12
    const SCROLL_THRESHOLD = 18
    if (lift.piece && dragDelta >= DRAG_THRESHOLD) {
      const piece = lift.piece
      this.pendingLift = null
      this.detachWindowTracking()
      this.dismissRing()
      // Hand the gesture off to the existing held-piece flow: root
      // pointer capture + trackingPointerId drive subsequent moves and
      // the eventual drop.
      this.trackingPointerId = event.pointerId
      try { this.root.setPointerCapture(event.pointerId) } catch {}
      this.holdPiece(piece, event.clientX, event.clientY)
      return
    }
    if (Math.abs(scrollDelta) >= SCROLL_THRESHOLD) {
      lift.mode = 'scrolling'
      if (this.trayGrid) {
        if (usesSidebar) this.trayGrid.scrollTop -= event.clientY - lift.startY
        else this.trayGrid.scrollLeft -= event.clientX - lift.startX
      }
      lift.lastX = event.clientX
      lift.lastY = event.clientY
      lift.lastT = performance.now()
    }
  }

  onWindowPointerUp(event) {
    if (!this.pendingLift || this.pendingLift.pointerId !== event.pointerId) return
    const lift = this.pendingLift
    if (lift.mode === 'scrolling' && event.type !== 'pointercancel') {
      this.startTrayMomentum(lift.velocity)
    }
    this.pendingLift = null
    this.detachWindowTracking()
  }

  stopTrayMomentum() {
    if (this.trayMomentumRaf !== null) {
      cancelAnimationFrame(this.trayMomentumRaf)
      this.trayMomentumRaf = null
    }
  }

  startTrayMomentum(initialVelocityPxPerMs) {
    if (!this.trayGrid || !Number.isFinite(initialVelocityPxPerMs)) return
    if (Math.abs(initialVelocityPxPerMs) < 0.15) return
    const usesSidebar = this.usesSidebarTray()
    let velocity = initialVelocityPxPerMs
    let lastT = performance.now()
    const step = () => {
      const now = performance.now()
      const dt = now - lastT
      lastT = now
      const dist = velocity * dt
      if (usesSidebar) this.trayGrid.scrollTop -= dist
      else this.trayGrid.scrollLeft -= dist
      velocity *= Math.pow(0.95, dt / 16.67)
      if (Math.abs(velocity) < 0.02) {
        this.trayMomentumRaf = null
        return
      }
      this.trayMomentumRaf = requestAnimationFrame(step)
    }
    this.trayMomentumRaf = requestAnimationFrame(step)
  }

  // ---------------------------------------------------------------------------
  // Rotation ring
  // ---------------------------------------------------------------------------

  showRing(piece) {
    this.ringPieceId = piece.id
    const centerX = parseFloat(piece.element.dataset.boardX) || 0
    const centerY = parseFloat(piece.element.dataset.boardY) || 0

    // Outer diameter is 2.1× the shard's larger dimension: wider than the
    // old solid ring (1.8×) so the annulus band stays a comfortable
    // target on hard/extreme shards, with enough centre hole left over
    // for the shard's body to remain draggable.
    const ringSize = Math.max(piece.widthPx, piece.heightPx) * 2.1
    const left = centerX - ringSize / 2
    const top = centerY - ringSize / 2

    this.rotateRing.style.width = `${ringSize}px`
    this.rotateRing.style.height = `${ringSize}px`
    this.rotateRing.style.transform = `translate(${left}px, ${top}px)`
    this.rotateRing.classList.add('is-visible')

    // The shape outline SVG mirrors the ring's position/size so its
    // viewBox shares the same (50, 50) centre — the polygon points
    // computed below are in that shared frame.
    if (this.shapeOutlineRing) {
      this.shapeOutlineRing.style.width = `${ringSize}px`
      this.shapeOutlineRing.style.height = `${ringSize}px`
      this.shapeOutlineRing.style.transform = `translate(${left}px, ${top}px)`
      this.shapeOutlineRing.classList.add('is-visible')
      this.updateShapeOutlinePoints(piece, ringSize)
    }

    this.updateRingSpindles(piece)
  }

  dismissRing() {
    this.ringPieceId = null
    this.ringDragState = null
    if (this.rotateRing) {
      this.rotateRing.classList.remove('is-visible')
    }
    if (this.shapeOutlineRing) {
      this.shapeOutlineRing.classList.remove('is-visible')
    }
  }

  updateRingSpindles(piece) {
    const spindles = this.rotateRing.querySelector('.polygram-ring-spindles')
    if (spindles) {
      // Rotate the spindle group with the shape so the spokes read as
      // "stuck to" it. The annulus stays fixed — that's the user's grip.
      spindles.setAttribute('transform', `rotate(${piece.rotation.toFixed(2)} 50 50)`)
    }
    if (this.shapeOutlineRing) {
      const spin = this.shapeOutlineRing.querySelector('.polygram-shape-outline-spin')
      if (spin) {
        spin.setAttribute('transform', `rotate(${piece.rotation.toFixed(2)} 50 50)`)
      }
    }
  }

  // Compute the shard polygon's vertices in the outline SVG's 100×100
  // viewBox. localPoints are 0..1 fractions of the shard's bbox; the
  // shard is centred at (50, 50) in the viewBox and spans a fraction
  // of it equal to piece.widthPx / ringSize on each axis.
  updateShapeOutlinePoints(piece, ringSize) {
    if (!this.shapeOutlineRing || !piece.blueprint?.localPoints) return
    const shardWvb = (piece.widthPx / ringSize) * 100
    const shardHvb = (piece.heightPx / ringSize) * 100
    const points = piece.blueprint.localPoints
      .map((p) => `${(50 + (p.x - 0.5) * shardWvb).toFixed(2)},${(50 + (p.y - 0.5) * shardHvb).toFixed(2)}`)
      .join(' ')
    for (const cls of ['halo', 'glow', 'core']) {
      const el = this.shapeOutlineRing.querySelector(`.polygram-shape-outline-${cls}`)
      if (el) el.setAttribute('points', points)
    }
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

    if (this.referenceVisible) this.setReferenceVisible(false)

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
    this.updateRingSpindles(piece)

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
      // Dismiss ring only when the tap is clearly off the rotation handle
      // *and* its centre area. With the annulus design the centre passes
      // pointer events through to the shard underneath; gaps inside the
      // hole (between the shard's polygon and the ring's inner edge) get
      // routed to whatever is below the SVG — without this check those
      // clumsy taps would kill the ring out from under the player.
      if (this.ringPieceId != null) {
        const piece = this.getRingPiece()
        const onShard = piece && piece.element && piece.element.contains(event.target)
        const ringRect = this.rotateRing.getBoundingClientRect()
        const inRingBox = (
          event.clientX >= ringRect.left && event.clientX <= ringRect.right
          && event.clientY >= ringRect.top && event.clientY <= ringRect.bottom
        )
        if (!onShard && !inRingBox) {
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
    if (this.referenceVisible) this.setReferenceVisible(false)
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
      this.updateRingSpindles(piece)
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
    if (this.tutorialBlockSnap) return false
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
    const canSnap = !this.tutorialBlockSnap
      && positionError <= SNAP_POSITION_MARGIN
      && rotationError <= SNAP_ROTATION_MARGIN_DEG
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
    this.container.dispatchEvent(
      new CustomEvent('polygram:piece-snapped', { detail: { piece }, bubbles: true }),
    )
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

  // Pulse every piece dropped on the board that isn't snapped yet
  // (state === 'placed'). Mirrors jigsaw's highlightLoosePieces — same
  // animation, same intent: surface pieces a player has lost track of
  // somewhere on the canvas. Tray pieces and locked pieces are skipped.
  highlightLoosePieces() {
    for (const piece of this.pieces) {
      if (piece.state !== 'placed') continue
      const el = piece.element
      if (!el) continue
      el.classList.remove('is-highlighted')
      // Force reflow so the animation restarts when re-adding the class
      // on a piece that was highlighted moments ago.
      void el.offsetWidth
      el.classList.add('is-highlighted')
      el.addEventListener(
        'animationend',
        () => el.classList.remove('is-highlighted'),
        { once: true },
      )
    }
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

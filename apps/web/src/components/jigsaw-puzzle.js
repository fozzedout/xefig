import { loadImage, releaseLoadedImage } from './image-loader.js'

const DIFFICULTY_TO_GRID = {
  easy: 8,
  medium: 10,
  hard: 12,
  extreme: 15,
}

const BOARD_COLORS_LIGHT = [
  { name: 'birch', color: '#d6cbb5' },
  { name: 'maple', color: '#cba96a' },
  { name: 'oak', color: '#b08848' },
  { name: 'cherry', color: '#9a5e42' },
  { name: 'image', color: null },
]

const BOARD_COLORS_DARK = [
  { name: 'walnut', color: '#3d2e22' },
  { name: 'mahogany', color: '#3a2222' },
  { name: 'dark oak', color: '#2e2518' },
  { name: 'ebony', color: '#1e1a16' },
  { name: 'image', color: null },
]

const SVG_NS = 'http://www.w3.org/2000/svg'
const MIN_BOARD_RATIO = 9 / 16
const MAX_BOARD_RATIO = 16 / 10
const MAX_SIDEBAR_BOARD_RATIO = 2.1

export class JigsawPuzzle {
  constructor({ container, imageUrl, difficulty = 'easy', snapDistance = 10, onComplete, onProgress, boardColorIndex } = {}) {
    if (!container) {
      throw new Error('JigsawPuzzle requires a container element.')
    }

    this.container = container
    this.imageUrl = imageUrl
    this.difficulty = difficulty
    this.snapDistance = snapDistance
    this.onComplete = onComplete
    this.onProgress = onProgress

    this.instanceId = `jigsaw-${Math.random().toString(36).slice(2, 10)}`
    this.zIndexCounter = 10
    this.completed = false
    this.pieces = []

    this.touchPoints = new Map()
    this.pinchState = null
    this.panState = null
    this.zoom = 1
    this.panX = 0
    this.panY = 0

    this.draggingPiece = null
    this.pendingLift = null
    this.referenceVisible = false
    this.audioContext = null
    this.displayImageUrl = imageUrl
    this.boardColors = this.isDarkMode() ? BOARD_COLORS_DARK : BOARD_COLORS_LIGHT
    const initColorIdx = Number(boardColorIndex)
    this.boardColorIndex = Number.isFinite(initColorIdx) && initColorIdx >= 0 && initColorIdx < this.boardColors.length ? initColorIdx : 0
    this.boardColor = this.boardColors[this.boardColorIndex].color
    this.edgesOnly = false
    this.renderScale = this.resolveRenderScale()

    this.handleWindowPointerMove = (event) => this.onWindowPointerMove(event)
    this.handleWindowPointerUp = (event) => this.onWindowPointerUp(event)

    this.handleStagePointerDown = (event) => this.onStagePointerDown(event)
    this.handleStagePointerMove = (event) => this.onStagePointerMove(event)
    this.handleStagePointerUp = (event) => this.onStagePointerUp(event)
    this.handleStageWheel = (event) => this.onStageWheel(event)
    this.handleCarouselWheel = (event) => this.onCarouselWheel(event)
    this.handleLayoutChange = () => this.onLayoutChange()
  }

  async init() {
    this.destroy()
    this.completed = false

    this.image = await loadImage(this.imageUrl)
    this.displayImageUrl = this.image.currentSrc || this.image.src || this.imageUrl
    this.gridSize = this.resolveGridSize(this.difficulty)
    this.rows = this.gridSize
    this.cols = this.gridSize

    this.setupLayout()
    this.generateEdgeMaps()
    this.createPieces()
    this.paintGhostImage()
    this.shuffleCarousel()
    this.resetView()
    this.setReferenceVisible(false)
  }

  destroy() {
    this.cancelPendingLift()
    this.stopDragging()

    if (this.stage) {
      this.stage.removeEventListener('pointerdown', this.handleStagePointerDown)
      this.stage.removeEventListener('pointermove', this.handleStagePointerMove)
      this.stage.removeEventListener('pointerup', this.handleStagePointerUp)
      this.stage.removeEventListener('pointercancel', this.handleStagePointerUp)
      this.stage.removeEventListener('wheel', this.handleStageWheel)
    }
    window.removeEventListener('orientationchange', this.handleLayoutChange)
    window.removeEventListener('resize', this.handleLayoutChange)
    if (this.carousel) {
      this.carousel.removeEventListener('wheel', this.handleCarouselWheel)
    }

    if (this.pieces?.length) {
      for (const piece of this.pieces) {
        if (piece.onPointerDown) {
          piece.canvas.removeEventListener('pointerdown', piece.onPointerDown)
        }
      }
    }

    this.touchPoints.clear()
    this.pinchState = null
    this.panState = null
    // Return floating controls to original parent before clearing
    if (this.adoptedFloatingControls && this.floatingControlsOriginalParent) {
      this.floatingControlsOriginalParent.append(this.adoptedFloatingControls)
      this.adoptedFloatingControls = null
      this.floatingControlsOriginalParent = null
    }
    releaseLoadedImage(this.image)
    this.image = null
    this.displayImageUrl = this.imageUrl
    this.pieces = []
    this.container.innerHTML = ''
  }

  resolveGridSize(difficulty) {
    if (typeof difficulty === 'number' && Number.isFinite(difficulty)) {
      return Math.max(2, Math.min(20, Math.round(difficulty)))
    }

    const normalized = String(difficulty || 'easy').trim().toLowerCase()
    if (DIFFICULTY_TO_GRID[normalized]) {
      return DIFFICULTY_TO_GRID[normalized]
    }

    const asNumber = Number(normalized)
    if (Number.isFinite(asNumber)) {
      return Math.max(2, Math.min(20, Math.round(asNumber)))
    }

    return DIFFICULTY_TO_GRID.easy
  }

  resolveRenderScale() {
    const dpr =
      typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio)
        ? window.devicePixelRatio
        : 1
    return clamp(dpr, 1, 2)
  }

  setupLayout() {
    const { width, height, crop } = this.calculateBoardSize()
    this.boardWidth = width
    this.boardHeight = height
    this.imageCrop = crop

    this.pieceWidth = this.boardWidth / this.cols
    this.pieceHeight = this.boardHeight / this.rows
    this.knobSize = Math.min(this.pieceWidth, this.pieceHeight) * 0.28
    this.bleed = Math.ceil(this.knobSize * 1.2)
    this.pieceCanvasWidth = Math.ceil(this.pieceWidth + this.bleed * 2)
    this.pieceCanvasHeight = Math.ceil(this.pieceHeight + this.bleed * 2)

    const maxPieceDimension = Math.max(this.pieceCanvasWidth, this.pieceCanvasHeight)
    const trayPieceTarget = this.usesSidebarTray() ? 112 : 92
    this.carouselScale = Math.min(1, trayPieceTarget / maxPieceDimension)

    this.root = document.createElement('section')
    this.root.className = 'jigsaw-root'

    this.stage = document.createElement('div')
    this.stage.className = 'jigsaw-stage'

    this.stageContent = document.createElement('div')
    this.stageContent.className = 'jigsaw-stage-content'
    this.stageContent.style.width = `${this.boardWidth}px`
    this.stageContent.style.height = `${this.boardHeight}px`

    this.ghostCanvas = document.createElement('canvas')
    this.ghostCanvas.className = 'jigsaw-ghost'
    configureHiDpiCanvas(this.ghostCanvas, this.boardWidth, this.boardHeight, this.renderScale)

    this.referenceImage = document.createElement('img')
    this.referenceImage.className = 'jigsaw-reference'
    this.referenceImage.src = this.displayImageUrl
    this.referenceImage.alt = 'Reference image'

    this.pieceLayer = document.createElement('div')
    this.pieceLayer.className = 'jigsaw-piece-layer'

    this.carousel = document.createElement('div')
    this.carousel.className = 'jigsaw-carousel'

    this.carouselTools = document.createElement('div')
    this.carouselTools.className = 'jigsaw-tray-tools'

    this.highlightTrayBtn = document.createElement('button')
    this.highlightTrayBtn.type = 'button'
    this.highlightTrayBtn.className = 'jigsaw-tray-tool'
    this.highlightTrayBtn.setAttribute('aria-label', 'Highlight loose pieces')
    this.highlightTrayBtn.title = 'Highlight loose pieces'
    this.highlightTrayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 2l1.6 4.6L15 8l-4.4 1.4L9 14l-1.6-4.6L3 8l4.4-1.4Zm8 4l1 2.8 2.8 1-2.8 1L17 14l-1-2.8L13.2 10l2.8-1Zm-4 10l.8 2.2L16 19.2l-2.2.8L13 22l-.8-2-2.2-1 2.2-.8Z"/></svg>'
    this.highlightTrayBtn.addEventListener('click', () => this.highlightLoosePieces())

    this.edgesTrayBtn = document.createElement('button')
    this.edgesTrayBtn.type = 'button'
    this.edgesTrayBtn.className = 'jigsaw-tray-tool'
    this.edgesTrayBtn.setAttribute('aria-label', 'Show only edge pieces in tray')
    this.edgesTrayBtn.title = 'Show only edge pieces in tray'
    this.edgesTrayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 3 L18 3 L18 7.2 C18 8.3, 21.5 8.1, 21.5 10.5 C21.5 12.9, 18 12.7, 18 13.8 L18 18 L13.8 18 C12.7 18, 12.9 21.5, 10.5 21.5 C8.1 21.5, 8.3 18, 7.2 18 L3 18 Z"/></svg>'
    this.edgesTrayBtn.addEventListener('click', () => this.toggleEdgesOnly())

    this.carouselTools.append(this.highlightTrayBtn, this.edgesTrayBtn)

    this.carouselTrack = document.createElement('div')
    this.carouselTrack.className = 'jigsaw-carousel-track'

    this.svgDefs = document.createElementNS(SVG_NS, 'svg')
    this.svgDefs.setAttribute('class', 'jigsaw-clip-defs')
    this.svgDefs.setAttribute('aria-hidden', 'true')

    this.defs = document.createElementNS(SVG_NS, 'defs')
    this.svgDefs.append(this.defs)

    this.stageContent.append(this.ghostCanvas, this.referenceImage, this.pieceLayer)
    this.stage.append(this.stageContent)
    this.carousel.append(this.carouselTrack)
    this.root.append(this.svgDefs, this.stage, this.carousel, this.carouselTools)
    this.container.append(this.root)

    // Adopt floating game controls into the jigsaw grid so they align with tray tools
    const floatingControls = this.container.parentElement?.querySelector('.floating-game-controls')
    if (floatingControls) {
      this.adoptedFloatingControls = floatingControls
      this.floatingControlsOriginalParent = floatingControls.parentElement
      this.root.append(floatingControls)
    }

    this.stage.addEventListener('pointerdown', this.handleStagePointerDown)
    this.stage.addEventListener('pointermove', this.handleStagePointerMove)
    this.stage.addEventListener('pointerup', this.handleStagePointerUp)
    this.stage.addEventListener('pointercancel', this.handleStagePointerUp)
    this.stage.addEventListener('wheel', this.handleStageWheel, { passive: false })
    this.carousel.addEventListener('wheel', this.handleCarouselWheel, { passive: false })
    window.addEventListener('orientationchange', this.handleLayoutChange)
    window.addEventListener('resize', this.handleLayoutChange)
  }

  calculateBoardSize() {
    const usesSidebarTray = this.usesSidebarTray()
    const viewportWidth = window.innerWidth || this.container.clientWidth || 0
    const viewportHeight = window.innerHeight || this.container.clientHeight || 0
    const containerWidth = Math.min(this.container.clientWidth || viewportWidth - 16, viewportWidth)
    const containerHeight = this.container.clientHeight || viewportHeight
    const saiTop = this.getSafeAreaInset('top')
    const saiBottom = this.getSafeAreaInset('bottom')

    if (usesSidebarTray) {
      // Landscape: tray on right, no column gap — reserve only the
      // tray column width itself so the canvas fills the remaining
      // viewport edge-to-edge AND edge-to-edge vertically (no
      // safe-area-inset-bottom reservation; the home indicator area
      // is semi-transparent and the canvas looks best filling to the
      // bottom of the viewport).
      const sideTrayReserve = Math.max(118, viewportWidth * 0.105)
      var availableWidth = Math.max(280, containerWidth - sideTrayReserve)
      var availableHeight = Math.max(220, containerHeight)
    } else {
      // Portrait: tray at top with sai-top padding PLUS the ~48px strip
      // reserved above the tray for the back/highlight/edges/menu buttons
      // (see .game-shell--jigsaw .jigsaw-root padding-top in style.css).
      const topTrayReserve = Math.round(13 + saiTop + 82 + 48)
      var availableWidth = Math.max(280, containerWidth)
      var availableHeight = Math.max(220, containerHeight - topTrayReserve - saiBottom)
    }
    const maxWidth = availableWidth
    const maxHeight = availableHeight
    const maxRatio = usesSidebarTray ? MAX_SIDEBAR_BOARD_RATIO : MAX_BOARD_RATIO
    const desiredRatio = clamp(maxWidth / maxHeight, MIN_BOARD_RATIO, maxRatio)

    let width = maxWidth
    let height = Math.round(width / desiredRatio)
    if (height > maxHeight) {
      height = Math.round(maxHeight)
      width = Math.round(height * desiredRatio)
    }

    width = Math.max(260, width)
    height = Math.max(200, height)

    return {
      width,
      height,
      crop: this.calculateImageCrop(width / height),
    }
  }

  usesSidebarTray() {
    return window.innerWidth > window.innerHeight
  }

  getSafeAreaInset(side) {
    const el = document.createElement('div')
    el.style.cssText = `position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-${side}, 0px);visibility:hidden;pointer-events:none`
    document.body.appendChild(el)
    const val = el.offsetHeight
    el.remove()
    return val
  }



  calculateImageCrop(targetRatio) {
    const sourceWidth = this.image.width
    const sourceHeight = this.image.height
    const sourceRatio = sourceWidth / sourceHeight

    if (sourceRatio > targetRatio) {
      const width = Math.round(sourceHeight * targetRatio)
      const x = Math.round((sourceWidth - width) / 2)
      return { x, y: 0, width, height: sourceHeight }
    }

    if (sourceRatio < targetRatio) {
      const height = Math.round(sourceWidth / targetRatio)
      const y = Math.round((sourceHeight - height) / 2)
      return { x: 0, y, width: sourceWidth, height }
    }

    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
  }

  generateEdgeMaps() {
    this.horizontalEdges = Array.from({ length: this.rows + 1 }, () =>
      Array.from({ length: this.cols }, () => 0),
    )
    this.verticalEdges = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols + 1 }, () => 0),
    )

    for (let row = 1; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        this.horizontalEdges[row][col] = randomSign()
      }
    }

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 1; col < this.cols; col += 1) {
        this.verticalEdges[row][col] = randomSign()
      }
    }
  }

  createPieces() {
    this.pieces = []

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const edges = this.getPieceEdges(row, col)
        const pathData = this.buildPiecePathData(edges)
        const clipId = `${this.instanceId}-piece-${row}-${col}`

        const clipPath = document.createElementNS(SVG_NS, 'clipPath')
        clipPath.setAttribute('id', clipId)
        clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse')

        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', pathData)
        clipPath.append(path)
        this.defs.append(clipPath)

        const canvas = document.createElement('canvas')
        canvas.className = 'jigsaw-piece'
        configureHiDpiCanvas(
          canvas,
          this.pieceCanvasWidth,
          this.pieceCanvasHeight,
          this.renderScale,
        )
        canvas.style.clipPath = `url(#${clipId})`
        canvas.style.webkitClipPath = `url(#${clipId})`

        const carouselItem = document.createElement('div')
        carouselItem.className = 'jigsaw-carousel-item'

        const carouselPreview = document.createElement('div')
        carouselPreview.className = 'jigsaw-carousel-preview'

        const outlineSvg = document.createElementNS(SVG_NS, 'svg')
        outlineSvg.setAttribute('class', 'jigsaw-carousel-outline')
        outlineSvg.setAttribute('viewBox', `0 0 ${this.pieceCanvasWidth} ${this.pieceCanvasHeight}`)
        outlineSvg.setAttribute('aria-hidden', 'true')

        const outlinePath = document.createElementNS(SVG_NS, 'path')
        outlinePath.setAttribute('d', pathData)
        outlinePath.setAttribute('class', 'jigsaw-carousel-outline-path')
        outlinePath.setAttribute('vector-effect', 'non-scaling-stroke')
        outlineSvg.append(outlinePath)

        const piece = {
          row,
          col,
          edges,
          pathData,
          canvas,
          carouselItem,
          carouselPreview,
          outlineSvg,
          locked: false,
          inCarousel: true,
          x: 0,
          y: 0,
          targetX: col * this.pieceWidth - this.bleed,
          targetY: row * this.pieceHeight - this.bleed,
          pointerId: null,
          dragOffsetX: 0,
          dragOffsetY: 0,
          dragLeft: 0,
          dragTop: 0,
        }

        this.paintPiece(piece)
        this.bindPieceEvents(piece)
        this.mountPieceInCarousel(piece)
        this.pieces.push(piece)
      }
    }
  }

  bindPieceEvents(piece) {
    piece.onPointerDown = (event) => this.onPiecePointerDown(event, piece)
    piece.canvas.addEventListener('pointerdown', piece.onPointerDown)
  }

  getPieceEdges(row, col) {
    return {
      top: row === 0 ? 0 : -this.horizontalEdges[row][col],
      right: col === this.cols - 1 ? 0 : this.verticalEdges[row][col + 1],
      bottom: row === this.rows - 1 ? 0 : this.horizontalEdges[row + 1][col],
      left: col === 0 ? 0 : -this.verticalEdges[row][col],
    }
  }

  buildPiecePathData(edges) {
    const x = this.bleed
    const y = this.bleed
    const w = this.pieceWidth
    const h = this.pieceHeight

    let d = `M ${x} ${y}`
    d += this.topEdgePath(x, y, w, edges.top)
    d += this.rightEdgePath(x + w, y, h, edges.right)
    d += this.bottomEdgePath(x + w, y + h, w, edges.bottom)
    d += this.leftEdgePath(x, y + h, h, edges.left)
    d += ' Z'
    return d
  }

  topEdgePath(x, y, width, edgeType) {
    if (edgeType === 0) {
      return ` L ${x + width} ${y}`
    }

    const offset = -edgeType * this.knobSize
    return [
      ` L ${x + width * 0.28} ${y}`,
      ` C ${x + width * 0.35} ${y}, ${x + width * 0.34} ${y + offset * 0.58}, ${x + width * 0.5} ${y + offset * 0.58}`,
      ` C ${x + width * 0.66} ${y + offset * 0.58}, ${x + width * 0.65} ${y}, ${x + width * 0.72} ${y}`,
      ` L ${x + width} ${y}`,
    ].join('')
  }

  rightEdgePath(x, y, height, edgeType) {
    if (edgeType === 0) {
      return ` L ${x} ${y + height}`
    }

    const offset = edgeType * this.knobSize
    return [
      ` L ${x} ${y + height * 0.28}`,
      ` C ${x} ${y + height * 0.35}, ${x + offset * 0.58} ${y + height * 0.34}, ${x + offset * 0.58} ${y + height * 0.5}`,
      ` C ${x + offset * 0.58} ${y + height * 0.66}, ${x} ${y + height * 0.65}, ${x} ${y + height * 0.72}`,
      ` L ${x} ${y + height}`,
    ].join('')
  }

  bottomEdgePath(x, y, width, edgeType) {
    if (edgeType === 0) {
      return ` L ${x - width} ${y}`
    }

    const offset = edgeType * this.knobSize
    return [
      ` L ${x - width * 0.28} ${y}`,
      ` C ${x - width * 0.35} ${y}, ${x - width * 0.34} ${y + offset * 0.58}, ${x - width * 0.5} ${y + offset * 0.58}`,
      ` C ${x - width * 0.66} ${y + offset * 0.58}, ${x - width * 0.65} ${y}, ${x - width * 0.72} ${y}`,
      ` L ${x - width} ${y}`,
    ].join('')
  }

  leftEdgePath(x, y, height, edgeType) {
    if (edgeType === 0) {
      return ` L ${x} ${y - height}`
    }

    const offset = -edgeType * this.knobSize
    return [
      ` L ${x} ${y - height * 0.28}`,
      ` C ${x} ${y - height * 0.35}, ${x + offset * 0.58} ${y - height * 0.34}, ${x + offset * 0.58} ${y - height * 0.5}`,
      ` C ${x + offset * 0.58} ${y - height * 0.66}, ${x} ${y - height * 0.65}, ${x} ${y - height * 0.72}`,
      ` L ${x} ${y - height}`,
    ].join('')
  }

  paintPiece(piece) {
    const ctx = piece.canvas.getContext('2d')
    if (!ctx) {
      return
    }
    const piecePath = new Path2D(piece.pathData)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, piece.canvas.width, piece.canvas.height)
    ctx.setTransform(this.renderScale, 0, 0, this.renderScale, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const crop = this.imageCrop

    ctx.save()
    ctx.clip(piecePath)
    ctx.drawImage(
      this.image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      -piece.col * this.pieceWidth + this.bleed,
      -piece.row * this.pieceHeight + this.bleed,
      this.boardWidth,
      this.boardHeight,
    )
    ctx.restore()

    ctx.strokeStyle = this.getBoardOutlineStroke()
    ctx.lineWidth = 1
    ctx.stroke(piecePath)
  }

  isDarkMode() {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
  }

  getBoardOutlineStroke() {
    return this.isDarkMode() ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.25)'
  }

  paintGhostImage() {
    const ctx = this.ghostCanvas.getContext('2d')
    if (!ctx) {
      return
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.ghostCanvas.width, this.ghostCanvas.height)
    ctx.setTransform(this.renderScale, 0, 0, this.renderScale, 0, 0)

    const crop = this.imageCrop
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    if (this.boardColor) {
      ctx.fillStyle = this.boardColor
      ctx.fillRect(0, 0, this.boardWidth, this.boardHeight)
      // Faint desaturated ghost for orientation
      ctx.globalAlpha = 0.06
      ctx.filter = 'grayscale(0.5)'
      ctx.drawImage(this.image, crop.x, crop.y, crop.width, crop.height, 0, 0, this.boardWidth, this.boardHeight)
      ctx.filter = 'none'
      ctx.globalAlpha = 1
    } else {
      ctx.globalAlpha = 0.1
      ctx.drawImage(this.image, crop.x, crop.y, crop.width, crop.height, 0, 0, this.boardWidth, this.boardHeight)
      ctx.globalAlpha = 1
    }
  }

  shuffleCarousel() {
    const shuffled = [...this.pieces]
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1))
      ;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
    }

    for (const piece of shuffled) {
      this.carouselTrack.append(piece.carouselItem)
    }
  }

  mountPieceInCarousel(piece) {
    piece.locked = false
    piece.inCarousel = true

    piece.canvas.classList.remove('is-locked', 'is-dragging', 'is-loose')
    piece.canvas.style.touchAction = this.usesSidebarTray() ? 'pan-y' : 'pan-x'
    piece.canvas.style.position = 'absolute'
    piece.canvas.style.left = '0px'
    piece.canvas.style.top = '0px'
    piece.canvas.style.zIndex = '1'
    piece.canvas.style.width = `${this.pieceCanvasWidth}px`
    piece.canvas.style.height = `${this.pieceCanvasHeight}px`
    piece.canvas.style.transformOrigin = 'top left'
    piece.canvas.style.transform = `scale(${this.carouselScale})`

    piece.carouselItem.style.width = `${this.pieceCanvasWidth * this.carouselScale}px`
    piece.carouselItem.style.height = `${this.pieceCanvasHeight * this.carouselScale}px`
    piece.carouselPreview.style.width = `${this.pieceCanvasWidth * this.carouselScale}px`
    piece.carouselPreview.style.height = `${this.pieceCanvasHeight * this.carouselScale}px`

    if (!piece.carouselPreview.contains(piece.canvas)) {
      piece.carouselPreview.append(piece.canvas)
    }

    if (!piece.carouselPreview.contains(piece.outlineSvg)) {
      piece.carouselPreview.append(piece.outlineSvg)
    }

    if (!piece.carouselItem.contains(piece.carouselPreview)) {
      piece.carouselItem.append(piece.carouselPreview)
    }

    if (!this.carouselTrack.contains(piece.carouselItem)) {
      this.carouselTrack.append(piece.carouselItem)
    }

    piece.carouselItem.classList.toggle('is-hidden', this.edgesOnly && !this.isEdgePiece(piece))
  }

  mountPieceOnBoard(piece, { locked = false } = {}) {
    piece.inCarousel = false
    piece.locked = locked
    piece.canvas.classList.toggle('is-locked', locked)
    piece.canvas.classList.toggle('is-loose', !locked)
    piece.canvas.classList.remove('is-dragging')
    piece.canvas.style.touchAction = 'none'
    piece.canvas.style.position = 'absolute'
    piece.canvas.style.left = '0px'
    piece.canvas.style.top = '0px'
    piece.canvas.style.width = `${this.pieceCanvasWidth}px`
    piece.canvas.style.height = `${this.pieceCanvasHeight}px`
    piece.canvas.style.transform = `translate(${piece.x}px, ${piece.y}px)`
    piece.canvas.style.zIndex = locked ? '1' : `${++this.zIndexCounter}`

    if (piece.carouselItem.parentElement) {
      piece.carouselItem.remove()
    }

    this.pieceLayer.append(piece.canvas)
  }

  onPiecePointerDown(event, piece) {
    if (piece.locked || this.touchPoints.size > 1 || this.draggingPiece || this.pendingLift) {
      return
    }

    if (piece.inCarousel && event.pointerType === 'touch') {
      this.armCarouselLift(event, piece)
      return
    }

    this.startDraggingPiece(event, piece)
  }

  armCarouselLift(event, piece) {
    piece.pointerId = event.pointerId
    this.pendingLift = {
      piece,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    }
    this.attachWindowTracking()
  }

  cancelPendingLift() {
    if (!this.pendingLift) {
      return
    }

    this.pendingLift.piece.pointerId = null
    this.pendingLift = null

    if (!this.draggingPiece) {
      this.detachWindowTracking()
    }
  }

  startDraggingPiece(event, piece, { centerOnPointer = false } = {}) {
    event.stopPropagation()
    event.preventDefault()

    // Auto-hide reference overlay when dragging a piece
    if (this.referenceVisible) {
      this.setReferenceVisible(false)
    }

    if (event.pointerType === 'touch') {
      this.touchPoints.clear()
      this.pinchState = null
    }

    piece.pointerId = event.pointerId
    this.draggingPiece = piece

    const rect = piece.canvas.getBoundingClientRect()
    piece.dragScale = Math.max(0.1, rect.width / this.pieceCanvasWidth)

    if (centerOnPointer) {
      const scaledW = this.pieceCanvasWidth * piece.dragScale
      const scaledH = this.pieceCanvasHeight * piece.dragScale
      piece.dragOffsetX = scaledW / 2
      piece.dragOffsetY = scaledH / 2
      piece.dragLeft = event.clientX - piece.dragOffsetX
      piece.dragTop = event.clientY - piece.dragOffsetY
    } else {
      piece.dragOffsetX = event.clientX - rect.left
      piece.dragOffsetY = event.clientY - rect.top
      piece.dragLeft = rect.left
      piece.dragTop = rect.top
    }

    piece.canvas.classList.add('is-dragging')
    piece.canvas.style.position = 'fixed'
    piece.canvas.style.left = `${piece.dragLeft}px`
    piece.canvas.style.top = `${piece.dragTop}px`
    piece.canvas.style.width = `${this.pieceCanvasWidth}px`
    piece.canvas.style.height = `${this.pieceCanvasHeight}px`
    piece.canvas.style.transformOrigin = 'top left'
    piece.canvas.style.transform = `scale(${piece.dragScale})`
    piece.canvas.style.zIndex = `${++this.zIndexCounter}`

    document.body.append(piece.canvas)

    try {
      piece.canvas.setPointerCapture(event.pointerId)
    } catch {
      // Best effort — prevents losing the pointer mid-drag on touch.
    }

    this.attachWindowTracking()
  }

  onWindowPointerMove(event) {
    if (this.pendingLift && this.pendingLift.pointerId === event.pointerId && !this.draggingPiece) {
      // If the finger has moved far enough away from the tray, snap to drag.
      // Native scroll handles the scroll axis — if the browser claims the gesture
      // for scroll, pointercancel fires and cancelPendingLift cleans up.
      const liftDistance = this.usesSidebarTray()
        ? this.pendingLift.startX - event.clientX  // leftward in landscape
        : event.clientY - this.pendingLift.startY   // downward in portrait
      if (liftDistance > 30) {
        const piece = this.pendingLift.piece
        this.pendingLift = null
        this.startDraggingPiece(event, piece, { centerOnPointer: true })
      }
      return
    }

    const piece = this.draggingPiece
    if (!piece || piece.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()

    piece.dragLeft = event.clientX - piece.dragOffsetX
    piece.dragTop = event.clientY - piece.dragOffsetY
    piece.canvas.style.left = `${piece.dragLeft}px`
    piece.canvas.style.top = `${piece.dragTop}px`
  }

  onWindowPointerUp(event) {
    if (this.pendingLift && this.pendingLift.pointerId === event.pointerId && !this.draggingPiece) {
      this.cancelPendingLift()
      return
    }

    const piece = this.draggingPiece
    if (!piece || piece.pointerId !== event.pointerId) {
      return
    }

    if (event.type === 'pointercancel') {
      this.mountPieceInCarousel(piece)
      this.emitProgress()
      this.stopDragging()
      return
    }

    const droppedInCarousel = this.isPointInCarousel(event.clientX, event.clientY)
    const drop = this.getDropState(piece)

    if (droppedInCarousel) {
      this.mountPieceInCarousel(piece)
      this.emitProgress()
      this.stopDragging()
      return
    }

    const clamped = this.clampBoardPosition(drop.boardX, drop.boardY)
    const clampedDistance = Math.hypot(clamped.x - piece.targetX, clamped.y - piece.targetY)

    if (clampedDistance <= this.snapDistance) {
      piece.x = piece.targetX
      piece.y = piece.targetY
      this.mountPieceOnBoard(piece, { locked: true })
      this.flashSnapOutline(piece)
      this.vibrateOnSnap()
      this.playSnapSound()
      this.checkEdgesComplete()
      this.checkCompletion()
    } else {
      piece.x = clamped.x
      piece.y = clamped.y
      this.mountPieceOnBoard(piece, { locked: false })
    }

    this.emitProgress()
    this.stopDragging()
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

  stopDragging() {
    const activePointerId = this.draggingPiece?.pointerId ?? null

    if (this.draggingPiece) {
      if (this.draggingPiece.canvas.parentElement === document.body) {
        this.draggingPiece.canvas.remove()
      }
      this.draggingPiece.pointerId = null
      this.draggingPiece = null
    }

    if (activePointerId !== null) {
      this.touchPoints.delete(activePointerId)
    }

    this.pinchState = null
    if (!this.pendingLift) {
      this.detachWindowTracking()
    }
  }

  getDropState(piece) {
    const stageRect = this.stage.getBoundingClientRect()
    const viewportX = piece.dragLeft - stageRect.left
    const viewportY = piece.dragTop - stageRect.top

    const boardX = (viewportX - this.panX) / this.zoom
    const boardY = (viewportY - this.panY) / this.zoom

    const distance = Math.hypot(boardX - piece.targetX, boardY - piece.targetY)

    return {
      boardX,
      boardY,
      distance,
    }
  }

  clampBoardPosition(x, y) {
    return {
      x: clamp(x, -this.bleed, this.boardWidth - this.pieceCanvasWidth + this.bleed),
      y: clamp(y, -this.bleed, this.boardHeight - this.pieceCanvasHeight + this.bleed),
    }
  }

  isPointInCarousel(clientX, clientY) {
    if (!this.carousel) {
      return false
    }

    const rect = this.carousel.getBoundingClientRect()
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    )
  }

  checkCompletion() {
    if (this.completed) {
      return
    }

    if (!this.pieces.every((candidate) => candidate.locked)) {
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

  getProgressState() {
    return {
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      boardColorIndex: this.boardColorIndex,
      edgesOnly: this.edgesOnly,
      pieces: this.pieces.map((piece) => ({
        row: piece.row,
        col: piece.col,
        x: piece.x,
        y: piece.y,
        locked: piece.locked,
        inCarousel: piece.inCarousel,
      })),
    }
  }

  applyProgressState(state) {
    if (!state || typeof state !== 'object') {
      return
    }

    const payload = state
    if (!Array.isArray(payload.pieces)) {
      return
    }

    const pieceByKey = new Map()
    for (const piece of this.pieces) {
      pieceByKey.set(`${piece.row}:${piece.col}`, piece)
    }

    for (const rawPiece of payload.pieces) {
      if (!rawPiece || typeof rawPiece !== 'object') {
        continue
      }

      const row = Number(rawPiece.row)
      const col = Number(rawPiece.col)
      const piece = pieceByKey.get(`${row}:${col}`)
      if (!piece) {
        continue
      }

      const inCarousel = Boolean(rawPiece.inCarousel)
      const locked = Boolean(rawPiece.locked)
      if (inCarousel) {
        this.mountPieceInCarousel(piece)
        continue
      }

      const rawX = Number(rawPiece.x)
      const rawY = Number(rawPiece.y)
      const x = Number.isFinite(rawX) ? rawX : piece.targetX
      const y = Number.isFinite(rawY) ? rawY : piece.targetY
      const clamped = this.clampBoardPosition(x, y)
      piece.x = locked ? piece.targetX : clamped.x
      piece.y = locked ? piece.targetY : clamped.y
      this.mountPieceOnBoard(piece, { locked })
    }

    const rawZoom = Number(payload.zoom)
    const minZoom = 1
    const zoom = Number.isFinite(rawZoom) ? clamp(rawZoom, minZoom, 4) : minZoom
    const rawPanX = Number(payload.panX)
    const rawPanY = Number(payload.panY)
    this.zoom = zoom
    const clampedPan = this.clampPan(
      Number.isFinite(rawPanX) ? rawPanX : 0,
      Number.isFinite(rawPanY) ? rawPanY : 0,
      zoom,
    )
    this.panX = clampedPan.x
    this.panY = clampedPan.y
    this.updateStageTransform()
    const rawColorIndex = Number(payload.boardColorIndex)
    if (Number.isFinite(rawColorIndex) && rawColorIndex >= 0 && rawColorIndex < this.boardColors.length) {
      this.boardColorIndex = rawColorIndex
      this.boardColor = this.boardColors[rawColorIndex].color
      this.paintGhostImage()
    }

    if (payload.edgesOnly) {
      this.setEdgesOnly(true)
    }

    this.checkEdgesComplete()

    const lockedCount = this.pieces.filter((piece) => piece.locked).length
    this.completed = lockedCount === this.pieces.length
  }

  emitProgress() {
    if (typeof this.onProgress !== 'function') {
      return
    }

    this.onProgress({
      completed: this.completed,
      lockedCount: this.pieces.filter((piece) => piece.locked).length,
      totalCount: this.pieces.length,
      state: this.getProgressState(),
    })
  }

  onStagePointerDown(event) {
    if (event.pointerType !== 'touch' || this.draggingPiece || this.pendingLift) {
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

  onStagePointerMove(event) {
    if (this.draggingPiece || this.pendingLift || !this.touchPoints.has(event.pointerId)) {
      return
    }

    this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY })

    // Two-finger pinch zoom
    if (this.touchPoints.size >= 2 && this.pinchState) {
      event.preventDefault()

      const points = [...this.touchPoints.values()]
      const center = midpoint(points[0], points[1])
      const distance = Math.max(1, distanceBetween(points[0], points[1]))
      const stageRect = this.stage.getBoundingClientRect()

      const scaleRatio = distance / this.pinchState.startDistance
      const nextScale = clamp(this.pinchState.startScale * scaleRatio, 1, 4)

      const centerX = center.x - stageRect.left
      const centerY = center.y - stageRect.top

      const nextPanX = centerX - this.pinchState.anchorX * nextScale
      const nextPanY = centerY - this.pinchState.anchorY * nextScale

      this.zoom = nextScale

      const clamped = this.clampPan(nextPanX, nextPanY, nextScale)
      this.panX = clamped.x
      this.panY = clamped.y
      this.updateStageTransform()
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
      this.updateStageTransform()
    }
  }

  onStagePointerUp(event) {
    if (this.draggingPiece || this.pendingLift) {
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
    const stageRect = this.stage.getBoundingClientRect()

    this.pinchState = {
      startScale: this.zoom,
      startDistance: Math.max(1, distanceBetween(pointA, pointB)),
      anchorX: (center.x - stageRect.left - this.panX) / this.zoom,
      anchorY: (center.y - stageRect.top - this.panY) / this.zoom,
    }
  }

  onLayoutChange() {
    if (this._layoutTimer) clearTimeout(this._layoutTimer)
    this._layoutTimer = setTimeout(async () => {
      this._layoutTimer = null
      if (this.completed) {
        this.resetView()
        return
      }
      // Re-init the puzzle for the new viewport dimensions
      const progress = this.getProgressState()
      await this.init()
      if (progress) {
        this.applyProgressState(progress)
      }
    }, 250)
  }

  getViewLayout() {
    if (this.usesSidebarTray()) {
      return { baseZoom: 1, restX: 0, restY: 0 }
    }
    // Portrait: board sits below the carousel. Use the carousel's
    // bottom edge in viewport coordinates so the jigsaw-root's
    // padding-top (which now reserves space for the floating button
    // strip) is included automatically — not just the carousel's own
    // height, which would leave the top of the board hidden under
    // the buttons and tray.
    const carouselBottom = this.carousel
      ? this.carousel.getBoundingClientRect().bottom
      : 0
    return {
      baseZoom: 1,
      restX: Math.round((window.innerWidth - this.boardWidth) / 2),
      restY: Math.round(carouselBottom),
    }
  }

  clampPan(panX, panY, scale) {
    const layout = this.getViewLayout()

    if (scale <= 1) {
      return { x: layout.restX, y: layout.restY }
    }

    const scaledWidth = this.boardWidth * scale
    const scaledHeight = this.boardHeight * scale
    const maxX = layout.restX
    const maxY = layout.restY
    const minX = Math.min(maxX, window.innerWidth - scaledWidth)
    const minY = Math.min(maxY, window.innerHeight - scaledHeight)

    return {
      x: clamp(panX, minX, maxX),
      y: clamp(panY, minY, maxY),
    }
  }

  updateStageTransform() {
    this.stageContent.style.transformOrigin = '0 0'
    this.stageContent.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`
  }

  resetView() {
    const layout = this.getViewLayout()
    this.zoom = layout.baseZoom
    this.panX = layout.restX
    this.panY = layout.restY
    if (this.stageContent) {
      this.updateStageTransform()
    }
    this.emitProgress()
  }

  onCarouselWheel(event) {
    if (!this.usesSidebarTray() || !this.carousel) {
      return
    }

    if (this.carousel.scrollHeight <= this.carousel.clientHeight) {
      return
    }

    const delta =
      Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!delta) {
      return
    }

    this.carousel.scrollTop += delta
    event.preventDefault()
    event.stopPropagation()
  }

  onStageWheel(event) {
    event.preventDefault()
    const delta = -event.deltaY * 0.002
    const nextScale = clamp(this.zoom * (1 + delta), 1, 4)
    if (nextScale === this.zoom) return

    const stageRect = this.stage.getBoundingClientRect()
    const cursorX = event.clientX - stageRect.left
    const cursorY = event.clientY - stageRect.top

    // Anchor zoom at cursor position
    const anchorX = (cursorX - this.panX) / this.zoom
    const anchorY = (cursorY - this.panY) / this.zoom

    const nextPanX = cursorX - anchorX * nextScale
    const nextPanY = cursorY - anchorY * nextScale

    this.zoom = nextScale
    const clamped = this.clampPan(nextPanX, nextPanY, nextScale)
    this.panX = clamped.x
    this.panY = clamped.y
    this.updateStageTransform()
    this.updateImmersiveZoom()
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

  flashSnapOutline(piece) {
    piece.canvas.classList.add('snap-flash')
    piece.canvas.addEventListener(
      'animationend',
      () => piece.canvas.classList.remove('snap-flash'),
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

  highlightLoosePieces() {
    for (const piece of this.pieces) {
      if (piece.locked || piece.inCarousel) {
        continue
      }
      piece.canvas.classList.remove('is-highlighted')
      void piece.canvas.offsetWidth
      piece.canvas.classList.add('is-highlighted')
      piece.canvas.addEventListener(
        'animationend',
        () => piece.canvas.classList.remove('is-highlighted'),
        { once: true },
      )
    }
  }

  isEdgePiece(piece) {
    return (
      piece.edges.top === 0 ||
      piece.edges.right === 0 ||
      piece.edges.bottom === 0 ||
      piece.edges.left === 0
    )
  }

  allEdgesPlaced() {
    return this.pieces.every((piece) => !this.isEdgePiece(piece) || piece.locked)
  }

  checkEdgesComplete() {
    if (!this.edgesTrayBtn || !this.allEdgesPlaced()) return
    if (this.edgesOnly) {
      this.setEdgesOnly(false)
    }
    this.edgesTrayBtn.style.display = 'none'
  }

  setEdgesOnly(enabled) {
    this.edgesOnly = Boolean(enabled)
    for (const piece of this.pieces) {
      if (!piece.inCarousel) {
        continue
      }
      piece.carouselItem.classList.toggle('is-hidden', this.edgesOnly && !this.isEdgePiece(piece))
    }
    if (this.edgesTrayBtn) {
      this.edgesTrayBtn.setAttribute('aria-pressed', this.edgesOnly ? 'true' : 'false')
    }
    return this.edgesOnly
  }

  toggleEdgesOnly() {
    return this.setEdgesOnly(!this.edgesOnly)
  }

  cycleBoardColor() {
    this.boardColorIndex = (this.boardColorIndex + 1) % this.boardColors.length
    this.boardColor = this.boardColors[this.boardColorIndex].color
    this.paintGhostImage()
    this.emitProgress()
    return this.boardColors[this.boardColorIndex]
  }

  getBoardColorName() {
    return this.boardColors[this.boardColorIndex].name
  }

  getBoardColorOptions() {
    return this.boardColors.map((entry, index) => ({
      ...entry,
      active: index === this.boardColorIndex,
    }))
  }

  setBoardColorIndex(index) {
    if (index < 0 || index >= this.boardColors.length) return
    this.boardColorIndex = index
    this.boardColor = this.boardColors[index].color
    this.paintGhostImage()
    this.emitProgress()
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
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function configureHiDpiCanvas(canvas, width, height, scale) {
  const internalScale = Number.isFinite(scale) ? Math.max(1, scale) : 1
  canvas.width = Math.round(width * internalScale)
  canvas.height = Math.round(height * internalScale)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
}

function randomSign() {
  return Math.random() < 0.5 ? -1 : 1
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  }
}

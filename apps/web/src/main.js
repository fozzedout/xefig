import './style.css'
import sampleImage from './assets/hero.png'
// Puzzle engines are loaded on demand in renderGame() via dynamic import()
// to keep the homepage bundle free of gameplay code.
const puzzleLoaders = {
  jigsaw: () => import('./components/jigsaw-puzzle.js').then((m) => m.JigsawPuzzle),
  sliding: () => import('./components/sliding-tile-puzzle.js').then((m) => m.SlidingTilePuzzle),
  swap: () => import('./components/picture-swap-puzzle.js').then((m) => m.PictureSwapPuzzle),
  polygram: () => import('./components/polygram-puzzle.js').then((m) => m.PolygramPuzzle),
}

const app = document.querySelector('#app')
const API_BASE = ''
const PLAYER_GUID_KEY = 'xefig:player-guid:v1'
const ACTIVE_RUN_KEY = 'xefig:jigsaw:active-run:v1'
const COMPLETED_RUNS_KEY = 'xefig:puzzles:completed:v1'
const BOARD_COLOR_KEY = 'xefig:board-color:v1'

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

function isDarkMode() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

function getBoardColors() {
  return isDarkMode() ? BOARD_COLORS_DARK : BOARD_COLORS_LIGHT
}

function getGlobalBoardColorIndex() {
  const saved = Number(localStorage.getItem(BOARD_COLOR_KEY))
  const colors = getBoardColors()
  return Number.isFinite(saved) && saved >= 0 && saved < colors.length ? saved : 0
}

function setGlobalBoardColorIndex(index) {
  localStorage.setItem(BOARD_COLOR_KEY, String(index))
}
const GAME_MODE_JIGSAW = 'jigsaw'
const GAME_MODE_SLIDING = 'sliding'
const GAME_MODE_SWAP = 'swap'
const GAME_MODE_POLYGRAM = 'polygram'
const DIFFICULTY_LABELS = {
  [GAME_MODE_JIGSAW]: {
    easy: 'Easy (8x8)',
    medium: 'Medium (10x10)',
    hard: 'Hard (12x12)',
    extreme: 'Extreme (15x15)',
  },
  [GAME_MODE_SLIDING]: {
    easy: 'Easy (3x3)',
    medium: 'Medium (4x4)',
    hard: 'Hard (6x6)',
    extreme: 'Extreme (7x7)',
  },
  [GAME_MODE_SWAP]: {
    easy: 'Easy (4x4)',
    medium: 'Medium (6x6)',
    hard: 'Hard (8x8)',
    extreme: 'Extreme (10x10)',
  },
  [GAME_MODE_POLYGRAM]: {
    easy: 'Easy (16-20 shards)',
    medium: 'Medium (25-30 shards)',
    hard: 'Hard (36-42 shards)',
    extreme: 'Extreme (52-60 shards)',
  },
}
const MODE_LABELS = {
  [GAME_MODE_JIGSAW]: 'Jigsaw',
  [GAME_MODE_SLIDING]: 'Sliding Tile',
  [GAME_MODE_SWAP]: 'Picture Swap',
  [GAME_MODE_POLYGRAM]: 'Polygram',
}
const GAME_MODE_TO_PUZZLE_CATEGORY = {
  [GAME_MODE_JIGSAW]: 'jigsaw',
  [GAME_MODE_SLIDING]: 'slider',
  [GAME_MODE_SWAP]: 'swap',
  [GAME_MODE_POLYGRAM]: 'polygram',
}

const state = {
  imageUrl: sampleImage,
  gameMode: GAME_MODE_JIGSAW,
  difficulty: 'medium',
  sourceMode: 'today',
  archiveDate: getIsoDate(new Date()),
  puzzle: null,
}

let puzzle = null
let currentRun = null
let activeElapsedBaseMs = 0
let activeStartedAtMs = null
let autosaveIntervalId = null
let gameVisibilityBound = false
const playerGuid = getPlayerGuid()

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function resolveAssetUrl(path) {
  if (!path) {
    return sampleImage
  }
  if (/^https?:\/\//i.test(path)) {
    return path
  }
  return API_BASE ? `${API_BASE}${path}` : path
}

function getIsoDate(value) {
  return value.toISOString().slice(0, 10)
}

function normalizeGameMode(mode) {
  if (mode === GAME_MODE_SLIDING) {
    return GAME_MODE_SLIDING
  }
  if (mode === GAME_MODE_SWAP) {
    return GAME_MODE_SWAP
  }
  if (mode === GAME_MODE_POLYGRAM) {
    return GAME_MODE_POLYGRAM
  }
  return GAME_MODE_JIGSAW
}

function getInteractionHint(gameMode = state.gameMode) {
  if (gameMode === GAME_MODE_SLIDING) {
    return 'Tap or swipe a tile adjacent to the empty space to slide it.'
  }
  if (gameMode === GAME_MODE_SWAP) {
    return 'Tap one square, then another to swap their positions.'
  }
  if (gameMode === GAME_MODE_POLYGRAM) {
    return 'Tap a shard to rotate. Drag from the tray and drop near the matching spot to snap it in.'
  }

  const isLandscapeDesktop = window.innerWidth >= 1024 && window.innerWidth > window.innerHeight
  return isLandscapeDesktop
    ? 'Scroll the right tray and drag pieces onto the board.'
    : 'Swipe tray left/right. Drag up on a piece to pick it up.'
}

function getGameModeOfDay(dateKey = getIsoDate(new Date())) {
  const seed = Number(dateKey.replaceAll('-', ''))
  const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]
  return modes[Math.abs(seed) % modes.length]
}

function resolvePuzzleImageUrl(puzzlePayload, gameMode) {
  const normalizedMode = normalizeGameMode(gameMode)
  const categoryKey = GAME_MODE_TO_PUZZLE_CATEGORY[normalizedMode] || 'jigsaw'
  const categoryImage = puzzlePayload?.categories?.[categoryKey]?.imageUrl
  const fallbackImage = puzzlePayload?.categories?.jigsaw?.imageUrl
  return resolveAssetUrl(categoryImage || fallbackImage)
}

function resolvePuzzleThumbnailUrl(puzzlePayload, gameMode) {
  const normalizedMode = normalizeGameMode(gameMode)
  const categoryKey = GAME_MODE_TO_PUZZLE_CATEGORY[normalizedMode] || 'jigsaw'
  const asset = puzzlePayload?.categories?.[categoryKey]
  const fallback = puzzlePayload?.categories?.jigsaw
  const thumbUrl = asset?.thumbnailUrl || fallback?.thumbnailUrl
  if (thumbUrl) return resolveAssetUrl(thumbUrl)
  // Fall back to full image if no thumbnail exists
  return resolveAssetUrl(asset?.imageUrl || fallback?.imageUrl)
}

function readJsonStorage(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      return null
    }
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Best effort local persistence.
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Best effort local persistence.
  }
}

function getCompletedRunsByDate() {
  const completedRuns = readJsonStorage(COMPLETED_RUNS_KEY)
  if (!completedRuns || typeof completedRuns !== 'object' || Array.isArray(completedRuns)) {
    return {}
  }
  return completedRuns
}

function getCompletedModesForDate(puzzleDate, difficulty = null) {
  if (!puzzleDate) {
    return new Set()
  }

  const completedRunsByDate = getCompletedRunsByDate()
  const dateRuns = completedRunsByDate[puzzleDate]
  if (!dateRuns || typeof dateRuns !== 'object' || Array.isArray(dateRuns)) {
    return new Set()
  }

  const modes = new Set()
  for (const [mode, entry] of Object.entries(dateRuns)) {
    if (difficulty && entry?.difficulty && entry.difficulty !== difficulty) {
      continue
    }
    modes.add(normalizeGameMode(mode))
  }
  return modes
}

function getCompletionEntry(puzzleDate, gameMode) {
  const completedRunsByDate = getCompletedRunsByDate()
  const dateRuns = completedRunsByDate[puzzleDate]
  if (!dateRuns || typeof dateRuns !== 'object') return null
  return dateRuns[normalizeGameMode(gameMode)] || null
}

function recordCompletedRun(run) {
  if (!run?.puzzleDate) {
    return
  }

  const completedRunsByDate = getCompletedRunsByDate()
  const puzzleDate = run.puzzleDate
  const mode = normalizeGameMode(run.gameMode)
  const dateRuns =
    completedRunsByDate[puzzleDate] &&
    typeof completedRunsByDate[puzzleDate] === 'object' &&
    !Array.isArray(completedRunsByDate[puzzleDate])
      ? completedRunsByDate[puzzleDate]
      : {}
  const previousEntry =
    dateRuns[mode] && typeof dateRuns[mode] === 'object' && !Array.isArray(dateRuns[mode]) ? dateRuns[mode] : null
  const elapsedMs = Math.max(0, Number(run.elapsedActiveMs) || 0)
  const previousBestMs = previousEntry ? Math.max(0, Number(previousEntry.bestElapsedMs) || elapsedMs) : elapsedMs

  dateRuns[mode] = {
    completedAt: new Date().toISOString(),
    difficulty: run.difficulty || null,
    elapsedActiveMs: elapsedMs,
    bestElapsedMs: Math.min(previousBestMs, elapsedMs),
  }

  completedRunsByDate[puzzleDate] = dateRuns
  writeJsonStorage(COMPLETED_RUNS_KEY, completedRunsByDate)
}

function createGuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `xefig-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}

function getPlayerGuid() {
  const existing = localStorage.getItem(PLAYER_GUID_KEY)
  if (existing) {
    return existing
  }
  const created = createGuid()
  localStorage.setItem(PLAYER_GUID_KEY, created)
  return created
}

function activeRunKey(puzzleDate, gameMode) {
  return `xefig:run:${puzzleDate}:${normalizeGameMode(gameMode)}`
}

function getResumableRun() {
  const run = readJsonStorage(ACTIVE_RUN_KEY)
  if (!run || typeof run !== 'object') {
    return null
  }
  if (run.completed) {
    return null
  }
  if (!run.puzzleDate || !run.imageUrl || !run.difficulty) {
    return null
  }
  return {
    ...run,
    gameMode: normalizeGameMode(run.gameMode),
  }
}

function getRunForMode(puzzleDate, gameMode) {
  const key = activeRunKey(puzzleDate, gameMode)
  const run = readJsonStorage(key)
  if (!run || typeof run !== 'object') return null
  if (run.completed) return null
  if (!run.puzzleDate || !run.imageUrl || !run.difficulty) return null
  return { ...run, gameMode: normalizeGameMode(run.gameMode), _storageKey: key }
}

function hasActiveRun(puzzleDate, gameMode) {
  return getRunForMode(puzzleDate, gameMode) !== null
}

function saveRunForMode(run) {
  if (!run?.puzzleDate || !run?.gameMode) return
  const key = activeRunKey(run.puzzleDate, run.gameMode)
  writeJsonStorage(key, run)
  // Also write to legacy key for backward compat
  writeJsonStorage(ACTIVE_RUN_KEY, run)
}

function clearRunForMode(run) {
  if (!run?.puzzleDate || !run?.gameMode) return
  const key = activeRunKey(run.puzzleDate, run.gameMode)
  removeStorage(key)
  removeStorage(ACTIVE_RUN_KEY)
}

function getNowMs() {
  return Date.now()
}

function startActiveTimer(initialElapsedMs = 0) {
  activeElapsedBaseMs = Math.max(0, Number(initialElapsedMs) || 0)
  activeStartedAtMs = isSessionActive() ? getNowMs() : null
}

function isSessionActive() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function pauseActiveTimer() {
  if (activeStartedAtMs === null) {
    return
  }
  activeElapsedBaseMs += Math.max(0, getNowMs() - activeStartedAtMs)
  activeStartedAtMs = null
}

function resumeActiveTimer() {
  if (activeStartedAtMs !== null || !isSessionActive()) {
    return
  }
  activeStartedAtMs = getNowMs()
}

function getActiveElapsedMs() {
  if (activeStartedAtMs === null) {
    return Math.round(activeElapsedBaseMs)
  }
  return Math.round(activeElapsedBaseMs + Math.max(0, getNowMs() - activeStartedAtMs))
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function bindGameActivity(onAutosave) {
  if (gameVisibilityBound) {
    return
  }

  const handleActivity = () => {
    if (isSessionActive()) {
      resumeActiveTimer()
    } else {
      pauseActiveTimer()
      onAutosave()
    }
  }

  const handleUnload = () => {
    pauseActiveTimer()
    onAutosave()
  }

  window.__xefigHandleActivity = handleActivity
  window.__xefigHandleUnload = handleUnload

  document.addEventListener('visibilitychange', handleActivity)
  window.addEventListener('focus', handleActivity)
  window.addEventListener('blur', handleActivity)
  window.addEventListener('pagehide', handleUnload)
  window.addEventListener('beforeunload', handleUnload)

  autosaveIntervalId = window.setInterval(() => {
    onAutosave()
  }, 5000)

  gameVisibilityBound = true
}

function unbindGameActivity() {
  if (!gameVisibilityBound) {
    return
  }

  document.removeEventListener('visibilitychange', window.__xefigHandleActivity)
  window.removeEventListener('focus', window.__xefigHandleActivity)
  window.removeEventListener('blur', window.__xefigHandleActivity)
  window.removeEventListener('pagehide', window.__xefigHandleUnload)
  window.removeEventListener('beforeunload', window.__xefigHandleUnload)

  if (autosaveIntervalId) {
    clearInterval(autosaveIntervalId)
    autosaveIntervalId = null
  }

  delete window.__xefigHandleActivity
  delete window.__xefigHandleUnload
  gameVisibilityBound = false
}

function persistActiveRun(progressState) {
  if (!currentRun || currentRun.completed) {
    return
  }

  const nextRun = {
    ...currentRun,
    elapsedActiveMs: getActiveElapsedMs(),
    updatedAt: new Date().toISOString(),
    puzzleState: progressState || (puzzle ? puzzle.getProgressState() : currentRun.puzzleState),
  }
  currentRun = nextRun
  saveRunForMode(nextRun)
}

async function submitLeaderboard(run) {
  const response = await fetch(apiUrl('/api/leaderboard/submit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      puzzleDate: run.puzzleDate,
      gameMode: normalizeGameMode(run.gameMode),
      difficulty: run.difficulty,
      playerGuid: playerGuid,
      elapsedMs: run.elapsedActiveMs,
    }),
  })

  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to submit leaderboard.')
  }
  return payload
}

async function fetchLeaderboard(puzzleDate, gameMode, difficulty, limit = 10) {
  const mode = GAME_MODE_TO_PUZZLE_CATEGORY[normalizeGameMode(gameMode)] || 'jigsaw'
  const response = await fetch(
    apiUrl(`/api/leaderboard/${encodeURIComponent(puzzleDate)}?gameMode=${mode}&difficulty=${difficulty}&limit=${limit}`),
  )
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || 'Failed to fetch leaderboard.')
  return payload
}

const CONFETTI_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9']

function createConfettiOverlay(container) {
  const canvas = document.createElement('canvas')
  canvas.className = 'confetti-overlay'
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1000'
  container.style.position = container.style.position || 'relative'
  container.appendChild(canvas)

  const resize = () => {
    canvas.width = container.clientWidth
    canvas.height = container.clientHeight
  }
  resize()

  const ctx = canvas.getContext('2d')
  const count = 150
  const particles = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.4,
    vx: (Math.random() - 0.5) * 6,
    vy: Math.random() * 3 + 1.5,
    size: Math.random() * 5 + 4,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.24,
    color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
    life: 1,
    decay: Math.random() * 0.008 + 0.005,
  }))

  let frame = null
  const start = performance.now()

  const animate = (now) => {
    if (now - start > 3500) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvas.remove()
      return
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const p of particles) {
      p.x += p.vx
      p.y += p.vy
      p.vy += 0.04
      p.angle += p.spin
      p.life = Math.max(0, p.life - p.decay)
      if (p.y > canvas.height + 12) p.y = -Math.random() * 80
      if (p.life <= 0) continue
      ctx.save()
      ctx.globalAlpha = p.life
      ctx.translate(p.x, p.y)
      ctx.rotate(p.angle)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size)
      ctx.restore()
    }
    frame = requestAnimationFrame(animate)
  }
  frame = requestAnimationFrame(animate)
}

function cacheDailyPayload(payload) {
  if (payload?.date && payload?.categories) {
    writeJsonStorage('xefig:daily-cache', { date: payload.date, categories: payload.categories })
  }
}

async function fetchPuzzlePayload({ date = null } = {}) {
  // For the default "today" request, use the early fetch started in index.html
  // so we don't wait for the module to load before hitting the API.
  if (!date && window.__earlyPuzzle) {
    const early = await window.__earlyPuzzle
    window.__earlyPuzzle = null
    if (early) return early
  }

  const endpoint = date ? `/api/puzzles/${encodeURIComponent(date)}` : '/api/puzzles/today'
  const response = await fetch(apiUrl(endpoint))
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload.error || 'Puzzle not found.')
  }
  if (!date) cacheDailyPayload(payload)
  return payload
}

const SLICE_ICONS = {
  [GAME_MODE_JIGSAW]: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor"><path d="M14 4h-8a2 2 0 00-2 2v8m0 0c1.5 0 3 1 3 3s-1.5 3-3 3v6a2 2 0 002 2h6c0-1.5 1-3 3-3s3 1.5 3 3h6a2 2 0 002-2v-6c1.5 0 3-1 3-3s-1.5-3-3-3V6a2 2 0 00-2-2h-6c0 1.5-1 3-3 3s-3-1.5-3-3z"/></svg>',
  [GAME_MODE_SLIDING]: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor"><rect x="4" y="4" width="10" height="10" rx="1"/><rect x="18" y="4" width="10" height="10" rx="1"/><rect x="4" y="18" width="10" height="10" rx="1"/><path d="M22 20v8M18 24h8" stroke-linecap="round"/></svg>',
  [GAME_MODE_SWAP]: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor"><path d="M8 10h6M18 10h6M8 22h6M18 22h6" stroke-linecap="round" stroke-width="2"/><path d="M14 10l4 12M18 10l-4 12" stroke-dasharray="2 2"/><circle cx="11" cy="10" r="3"/><circle cx="21" cy="22" r="3"/></svg>',
  [GAME_MODE_POLYGRAM]: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor"><polygon points="16,3 28,11 24,25 8,25 4,11"/><polygon points="16,8 23,13 21,22 11,22 9,13"/><line x1="16" y1="3" x2="16" y2="8"/><line x1="28" y1="11" x2="23" y2="13"/><line x1="24" y1="25" x2="21" y2="22"/><line x1="8" y1="25" x2="11" y2="22"/><line x1="4" y1="11" x2="9" y2="13"/></svg>',
}

const SLICE_DESCRIPTIONS = {
  [GAME_MODE_JIGSAW]: 'Drag and place interlocking pieces to reconstruct the full image. Start with edges and corners, then work inward.',
  [GAME_MODE_SLIDING]: 'Slide tiles into the empty space to reorder the scrambled image. Deceptively simple, maddeningly strategic.',
  [GAME_MODE_SWAP]: 'Select any two tiles and swap their positions. No empty space needed \u2014 challenges spatial memory and pattern recognition.',
  [GAME_MODE_POLYGRAM]: 'The image shatters into irregular polygon shards. Rotate and place geometric fragments to piece reality back together.',
}

const SLICE_TAGS = {
  [GAME_MODE_JIGSAW]: ['Drag & Drop', '64\u2013225 pcs', 'Classic'],
  [GAME_MODE_SLIDING]: ['Slide', '3\u00d73 \u2014 7\u00d77', 'Strategy'],
  [GAME_MODE_SWAP]: ['Tap & Swap', '4\u00d74 \u2014 10\u00d710', 'Spatial'],
  [GAME_MODE_POLYGRAM]: ['Rotate & Place', 'Freeform', 'Artistic'],
}

function renderLauncher() {
  destroyPuzzle()

  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'today'
  state.archiveDate = todayDate
  state.gameMode = getGameModeOfDay(todayDate)
  state.difficulty = state.difficulty || 'medium'

  const ACTIVE_FLEX = 2.2
  const INACTIVE_FLEX = 0.9
  const pickMode = getGameModeOfDay(todayDate)
  const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]

  const renderSlices = (puzzlePayload) => {
    const puzzleDate = puzzlePayload?.date || todayDate
    const completedModes = getCompletedModesForDate(puzzleDate)
    return modes
      .map((mode, index) => {
        const imageUrl = resolvePuzzleThumbnailUrl(puzzlePayload, mode)
        const title = MODE_LABELS[mode]
        const isPick = mode === pickMode
        const isActive = isPick
        const isCompleted = completedModes.has(mode)
        const hasSave = hasActiveRun(puzzleDate, mode)
        const entry = isCompleted ? getCompletionEntry(puzzleDate, mode) : null
        const flex = isActive ? ACTIVE_FLEX : INACTIVE_FLEX
        const isLCP = index === 0

        return `
          <div class="slice${isActive ? ' active' : ''}" data-mode="${mode}" style="--flex: ${flex};">
            <img class="slice-image" src="${imageUrl}" alt="${title}" decoding="async" loading="${isLCP ? 'eager' : 'lazy'}"${isLCP ? ' fetchpriority="high"' : ''} />
            <div class="slice-overlay"></div>
            <div class="slice-icon">${SLICE_ICONS[mode]}</div>
            <div class="slice-bar">
              <span class="bar-title">${title}</span>
              <div class="bar-icon info-btn" title="More info">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4.5v.5"/></svg>
              </div>
              <div class="bar-spacer"></div>
              ${hasSave ? `<div class="bar-icon has-save" title="Save exists"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h8l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm1 1v4h7V2H4zm4 6a2 2 0 100 4 2 2 0 000-4z"/></svg></div>` : ''}
            </div>
            <div class="info-panel" data-mode="${mode}"></div>
          </div>
        `
      })
      .join('')
  }

  const pageEl = document.querySelector('#page-play')
  pageEl.innerHTML = `
    <main class="slice-launcher">
      <div id="slice-container" class="slice-container">
        <div class="slice" style="--flex:1;opacity:0"></div>
      </div>
    </main>
  `

  const container = pageEl.querySelector('#slice-container')

  const handleSliceClick = (mode, puzzleDate) => {
    state.gameMode = normalizeGameMode(mode)
    state.imageUrl = resolvePuzzleImageUrl(state.puzzle, state.gameMode)

    const savedRun = getRunForMode(puzzleDate, state.gameMode)
    if (savedRun) {
      state.imageUrl = resolveAssetUrl(savedRun.imageUrl)
      renderGame({ resumeRun: savedRun })
      return
    }

    const completedModes = getCompletedModesForDate(puzzleDate)
    if (completedModes.has(state.gameMode)) {
      const entry = getCompletionEntry(puzzleDate, state.gameMode)
      showCompletedPuzzleScreen({
        gameMode: state.gameMode,
        puzzleDate,
        entry,
        onReplay: () => renderGame(),
        onBack: () => returnFromGame(),
      })
      return
    }

    renderGame()
  }

  const ACCENT_MAP = { jigsaw: '#f0c040', sliding: '#40d0f0', swap: '#f06050', polygram: '#a060f0' }

  const buildInfoPanel = (panel, mode, index) => {
    const title = MODE_LABELS[mode]
    const accent = ACCENT_MAP[mode]
    const puzzleDate = state.puzzle?.date || todayDate
    const hasSave = hasActiveRun(puzzleDate, mode)
    panel.innerHTML = `
      <div class="info-close"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 1l8 8M9 1l-8 8"/></svg></div>
      <div class="info-title">${title}<span class="info-accent-bar" style="background:${accent}"></span></div>
      <p class="info-description">${SLICE_DESCRIPTIONS[mode]}</p>
      <button class="info-play-btn" data-mode="${mode}" style="background:${accent}">${hasSave ? 'Resume' : 'Play'} <svg viewBox="0 0 14 14" fill="currentColor"><polygon points="3,1 12,7 3,13"/></svg></button>
    `
    panel.querySelector('.info-close').addEventListener('click', (e) => {
      e.stopPropagation()
      panel.classList.remove('open')
    })
    panel.querySelector('.info-play-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      handleSliceClick(panel.dataset.mode, state.puzzle?.date || todayDate)
    })
  }

  const bindSliceEvents = () => {
    const slices = container.querySelectorAll('.slice')

    const closeAllPanels = () => {
      container.querySelectorAll('.info-panel.open').forEach(p => p.classList.remove('open'))
    }

    const setActive = (index) => {
      closeAllPanels()
      slices.forEach((s, i) => {
        const isActive = i === index
        s.classList.toggle('active', isActive)
        s.style.setProperty('--flex', isActive ? ACTIVE_FLEX : INACTIVE_FLEX)
      })
    }

    slices.forEach((slice, i) => {
      const infoBtn = slice.querySelector('.bar-icon.info-btn')
      const panel = slice.querySelector('.info-panel')

      if (infoBtn && panel) {
        infoBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!panel.innerHTML.trim()) {
            buildInfoPanel(panel, slice.dataset.mode, i)
          }
          panel.classList.toggle('open')
        })
      }

      slice.addEventListener('click', (e) => {
        // Ignore clicks on info panel or info button
        if (e.target.closest('.info-panel') || e.target.closest('.info-btn')) return

        if (!slice.classList.contains('active')) {
          setActive(i)
          return
        }
        // Active slice click → play
        const puzzleDate = state.puzzle?.date || todayDate
        handleSliceClick(slice.dataset.mode, puzzleDate)
      })
    })
  }

  // Migrate legacy single-key save to per-mode storage
  const legacyRun = getResumableRun()
  if (legacyRun) {
    saveRunForMode(legacyRun)
    removeStorage(ACTIVE_RUN_KEY)
  }

  ;(async () => {
    try {
      const payload = await fetchPuzzlePayload()
      state.puzzle = payload
      container.innerHTML = renderSlices(payload)
      bindSliceEvents()
    } catch {
      container.innerHTML = `
        <div style="flex:1;display:grid;place-items:center;color:rgba(232,230,224,0.5);font-size:0.9rem;">
          Failed to load today's puzzles.
        </div>
      `
    }
  })()
}

const ARCHIVE_START_DATE = '2026-03-17'
const ARCHIVE_ACCENT_MAP = {
  [GAME_MODE_JIGSAW]: '#f0c040',
  [GAME_MODE_SLIDING]: '#40d0f0',
  [GAME_MODE_SWAP]: '#f06050',
  [GAME_MODE_POLYGRAM]: '#a060f0',
}
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

function renderArchivePage() {
  const pageEl = document.querySelector('#page-archive')
  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'archive'
  state.difficulty = state.difficulty || 'medium'

  pageEl.innerHTML = `
    <div class="archive-page">
      <div class="archive-top-bar">
        <h2>Archive</h2>
        <div class="archive-filters">
          <button class="filter-chip active" data-filter="all">All</button>
          <button class="filter-chip" data-filter="in-progress">In Progress</button>
          <button class="filter-chip" data-filter="completed">Completed</button>
        </div>
      </div>
      <div class="timeline" id="archive-timeline"></div>
    </div>
  `

  const timeline = pageEl.querySelector('#archive-timeline')
  const allDays = []
  let loadedCount = 0
  const BATCH_SIZE = 10

  function addDays(dateKey, n) {
    return new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
  }

  function handleThumbClick(puzzlePayload, mode, puzzleDate) {
    state.sourceMode = 'archive'
    state.archiveDate = puzzleDate
    state.puzzle = puzzlePayload
    state.gameMode = normalizeGameMode(mode)
    state.imageUrl = resolvePuzzleImageUrl(puzzlePayload, state.gameMode)

    const savedRun = getRunForMode(puzzleDate, state.gameMode)
    if (savedRun) {
      state.imageUrl = resolveAssetUrl(savedRun.imageUrl)
      renderGame({ resumeRun: savedRun })
      return
    }

    const completedModes = getCompletedModesForDate(puzzleDate)
    if (completedModes.has(state.gameMode)) {
      const entry = getCompletionEntry(puzzleDate, state.gameMode)
      showCompletedPuzzleScreen({
        gameMode: state.gameMode,
        puzzleDate,
        entry,
        onReplay: () => renderGame(),
        onBack: () => returnFromGame(),
      })
      return
    }

    renderGame()
  }

  function renderDayEntry(puzzlePayload, dateKey, index) {
    const d = new Date(Date.parse(`${dateKey}T00:00:00Z`))
    const isToday = dateKey === todayDate
    const completedModes = getCompletedModesForDate(dateKey)
    const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]

    const thumbsHtml = modes
      .map((mode) => {
        const title = MODE_LABELS[mode]
        const accent = ARCHIVE_ACCENT_MAP[mode]
        const isCompleted = completedModes.has(mode)
        const hasSave = hasActiveRun(dateKey, mode)
        const thumbUrl = resolvePuzzleThumbnailUrl(puzzlePayload, mode)
        let statusClass = 'new'
        let statusLabel = 'new'
        if (isCompleted) {
          statusClass = 'completed'
          const entry = getCompletionEntry(dateKey, mode)
          statusLabel = entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : '\u2713'
        } else if (hasSave) {
          statusClass = 'resume'
          statusLabel = '\u25B6 resume'
        }

        return `<div class="puzzle-thumb" data-mode="${mode}" data-date="${dateKey}">
          <div class="thumb-accent" style="background:${accent}"></div>
          <div class="thumb-image" style="background-image:url('${thumbUrl}')"></div>
          <div class="thumb-info">
            <div class="thumb-mode" style="color:${accent}">${title}</div>
            <div class="thumb-right">
              <span class="thumb-status ${statusClass}">${statusLabel}</span>
              ${hasSave ? '<svg class="thumb-save-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h8l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm1 1v4h7V2H4zm4 6a2 2 0 100 4 2 2 0 000-4z"/></svg>' : ''}
            </div>
          </div>
        </div>`
      })
      .join('')

    const dayName = DAY_NAMES[d.getUTCDay()]
    const monthStr = MONTH_NAMES[d.getUTCMonth()].slice(0, 3)

    const el = document.createElement('div')
    el.className = 'timeline-day' + (isToday ? ' today' : '')
    el.style.animationDelay = (index * 0.06) + 's'
    el.dataset.date = dateKey
    el.dataset.hasCompleted = completedModes.size > 0 ? '1' : ''
    el.dataset.hasResume = modes.some((m) => hasActiveRun(dateKey, m)) ? '1' : ''
    el.innerHTML = `
      <div class="day-header">
        <div class="day-date">${monthStr} ${d.getUTCDate()}</div>
        <div class="day-label${isToday ? ' today-label' : ''}">${isToday ? 'Today' : dayName}</div>
      </div>
      <div class="day-puzzles">${thumbsHtml}</div>
    `

    // Bind click handlers on thumbs
    el.querySelectorAll('.puzzle-thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        handleThumbClick(puzzlePayload, thumb.dataset.mode, thumb.dataset.date)
      })
    })

    return el
  }

  let loading = false
  let exhausted = false

  // Sentinel element at the bottom — triggers loading when scrolled into view
  const sentinel = document.createElement('div')
  sentinel.className = 'timeline-loading'
  sentinel.textContent = 'Loading\u2026'
  timeline.appendChild(sentinel)

  async function loadBatch() {
    if (loading || exhausted) return
    loading = true

    const fragment = document.createDocumentFragment()
    let lastMonth = -1

    if (loadedCount > 0) {
      const prevDate = new Date(Date.parse(`${addDays(todayDate, -(loadedCount - 1))}T00:00:00Z`))
      lastMonth = prevDate.getUTCMonth()
    }

    let loaded = 0
    for (let i = 0; i < BATCH_SIZE; i++) {
      const dateKey = addDays(todayDate, -(loadedCount + i))
      if (dateKey < ARCHIVE_START_DATE) {
        exhausted = true
        break
      }

      const d = new Date(Date.parse(`${dateKey}T00:00:00Z`))
      const m = d.getUTCMonth()

      if (m !== lastMonth) {
        lastMonth = m
        const divider = document.createElement('div')
        divider.className = 'month-divider'
        divider.innerHTML = `<span>${MONTH_NAMES[m]} ${d.getUTCFullYear()}</span>`
        fragment.appendChild(divider)
      }

      try {
        const payload = await fetchPuzzlePayload({ date: dateKey })
        const dayEl = renderDayEntry(payload, dateKey, i)
        allDays.push({ dateKey, el: dayEl, payload })
        fragment.appendChild(dayEl)
      } catch {
        // Day has no puzzle — skip
      }
      loaded++
    }

    timeline.insertBefore(fragment, sentinel)
    loadedCount += loaded

    if (exhausted || loaded === 0) {
      sentinel.remove()
      observer.disconnect()
    }

    loading = false
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) loadBatch()
    },
    { root: pageEl.querySelector('.archive-page'), rootMargin: '200px' },
  )
  observer.observe(sentinel)

  // Filter chips
  pageEl.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      pageEl.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      const filter = chip.dataset.filter

      timeline.querySelectorAll('.timeline-day').forEach((day) => {
        if (filter === 'all') {
          day.style.display = ''
        } else if (filter === 'in-progress') {
          day.style.display = day.dataset.hasResume ? '' : 'none'
        } else if (filter === 'completed') {
          day.style.display = day.dataset.hasCompleted ? '' : 'none'
        }
      })
      // Also hide/show month dividers based on next visible day
      timeline.querySelectorAll('.month-divider').forEach((div) => {
        let next = div.nextElementSibling
        while (next && !next.classList.contains('timeline-day') && !next.classList.contains('month-divider')) {
          next = next.nextElementSibling
        }
        if (!next || next.classList.contains('month-divider')) {
          div.style.display = 'none'
        } else {
          div.style.display = next.style.display
        }
      })
    })
  })

  loadBatch()
  archiveRendered = true
}

function showCompletionOverlay({ gameMode, duration, elapsedMs, rank, leaderboardEntries, totalEntries, playerGuid: myGuid }) {
  const existing = document.querySelector('.completion-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay'

  let leaderboardHtml = ''
  if (leaderboardEntries && leaderboardEntries.length > 0) {
    const rows = leaderboardEntries.map((entry) => {
      const isMe = entry.playerGuid === myGuid
      const time = formatDuration(entry.elapsedMs)
      return `<tr class="${isMe ? 'leaderboard-row-me' : ''}">
        <td class="lb-rank">#${entry.rank}</td>
        <td class="lb-time">${time}</td>
        <td class="lb-player">${isMe ? 'You' : entry.playerGuid.slice(0, 8)}</td>
      </tr>`
    }).join('')

    leaderboardHtml = `
      <div class="completion-leaderboard">
        <h3>Leaderboard</h3>
        <table class="lb-table">
          <thead><tr><th></th><th>Time</th><th>Player</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `
  }

  overlay.innerHTML = `
    <div class="completion-card">
      <h2>Puzzle Complete!</h2>
      <div class="completion-stats">
        <div class="completion-stat">
          <span class="stat-value">${duration}</span>
          <span class="stat-label">Time</span>
        </div>
        <div class="completion-stat">
          <span class="stat-value">${rank ? `#${rank}` : '—'}</span>
          <span class="stat-label">Rank</span>
        </div>
      </div>
      ${leaderboardHtml}
      <button type="button" class="completion-dismiss">Continue</button>
    </div>
  `

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))

  overlay.querySelector('.completion-dismiss').addEventListener('click', () => {
    overlay.classList.remove('is-visible')
    setTimeout(() => overlay.remove(), 200)
  })

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('is-visible')
      setTimeout(() => overlay.remove(), 200)
    }
  })
}

function showCompletedPuzzleScreen({ gameMode, puzzleDate, entry, onReplay, onBack }) {
  const durationLabel = entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : '—'
  const modeLabel = MODE_LABELS[gameMode] || gameMode
  const imageUrl = resolvePuzzleImageUrl(state.puzzle, gameMode)

  showGamePage()
  const gameEl = document.querySelector('#page-game')
  gameEl.innerHTML = `
    <main class="completed-screen">
      <div class="completed-screen-card">
        <div class="completed-screen-image-wrap">
          <img class="completed-screen-image" src="${imageUrl}" alt="${modeLabel} puzzle" />
        </div>
        <h2>Puzzle Complete</h2>
        <p class="completed-screen-mode">${modeLabel}</p>
        <p class="completed-screen-date">${puzzleDate}</p>
        <div class="completion-stats">
          <div class="completion-stat">
            <span class="stat-value">${durationLabel}</span>
            <span class="stat-label">Best Time</span>
          </div>
          <div class="completion-stat">
            <span class="stat-value" id="completed-rank">—</span>
            <span class="stat-label">Rank</span>
          </div>
        </div>
        <div id="completed-leaderboard"></div>
        <div class="completed-screen-actions">
          <button id="replay-btn" class="launcher-secondary-btn" type="button">Play Again</button>
          <button id="completed-back-btn" class="launcher-secondary-btn" type="button">Back</button>
        </div>
      </div>
    </main>
  `

  document.querySelector('#replay-btn').addEventListener('click', onReplay)
  document.querySelector('#completed-back-btn').addEventListener('click', onBack)

  // Fetch leaderboard async
  fetchLeaderboard(puzzleDate, gameMode, difficulty, 20)
    .then((lb) => {
      const entries = lb.entries || []
      const myEntry = entries.find((e) => e.playerGuid === playerGuid)
      const rankEl = document.querySelector('#completed-rank')
      if (rankEl && myEntry) {
        rankEl.textContent = `#${myEntry.rank}`
      }

      if (entries.length > 0) {
        const rows = entries.map((e) => {
          const isMe = e.playerGuid === playerGuid
          return `<tr class="${isMe ? 'leaderboard-row-me' : ''}">
            <td class="lb-rank">#${e.rank}</td>
            <td class="lb-time">${formatDuration(e.elapsedMs)}</td>
            <td class="lb-player">${isMe ? 'You' : e.playerGuid.slice(0, 8)}</td>
          </tr>`
        }).join('')

        const container = document.querySelector('#completed-leaderboard')
        if (container) {
          container.innerHTML = `
            <div class="completion-leaderboard">
              <h3>Leaderboard</h3>
              <table class="lb-table">
                <thead><tr><th></th><th>Time</th><th>Player</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          `
        }
      }
    })
    .catch(() => {
      // Non-fatal
    })
}

function renderGame({ resumeRun = null } = {}) {
  const gameMode = normalizeGameMode(resumeRun?.gameMode || state.gameMode)
  state.gameMode = gameMode

  showGamePage()
  const gameEl = document.querySelector('#page-game')
  gameEl.innerHTML = `
    <main class="game-shell">
      <header class="game-toolbar">
        <button id="back-btn" class="toolbar-btn back-btn" type="button" aria-label="Back to launcher">
          <span class="back-chevron">‹</span>
          <span>Back</span>
        </button>

        <p id="status" class="status toolbar-status">Loading puzzle...</p>

        <div class="toolbar-actions">
          ${gameMode === GAME_MODE_JIGSAW ? `
          <button id="highlight-btn" class="toolbar-btn icon-btn" type="button" aria-label="Highlight loose pieces" title="Highlight loose pieces">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 2l1.6 4.6L15 8l-4.4 1.4L9 14l-1.6-4.6L3 8l4.4-1.4Zm8 4l1 2.8 2.8 1-2.8 1L17 14l-1-2.8L13.2 10l2.8-1Zm-4 10l.8 2.2L16 19.2l-2.2.8L13 22l-.8-2-2.2-1 2.2-.8Z" />
            </svg>
          </button>
          <button id="edges-btn" class="toolbar-btn icon-btn" type="button" aria-label="Show edge pieces only" aria-pressed="false" title="Edge pieces only">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 3 L18 3 L18 7.2 C18 8.3, 21.5 8.1, 21.5 10.5 C21.5 12.9, 18 12.7, 18 13.8 L18 18 L13.8 18 C12.7 18, 12.9 21.5, 10.5 21.5 C8.1 21.5, 8.3 18, 7.2 18 L3 18 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            </svg>
          </button>
          ` : ''}
          <button id="view-btn" class="toolbar-btn icon-btn" type="button" aria-label="Toggle reference image" aria-pressed="false">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z" />
            </svg>
          </button>
          <button id="restart-btn" class="toolbar-btn icon-btn" type="button" aria-label="Restart puzzle" title="Restart">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L14 10h7V3l-3.35 3.35Z" />
            </svg>
          </button>
        </div>
      </header>

      <section class="workspace">
        <div id="puzzle-mount" class="puzzle-mount"></div>
      </section>
    </main>
  `

  const statusEl = gameEl.querySelector('#status')
  const mount = gameEl.querySelector('#puzzle-mount')
  const backBtn = gameEl.querySelector('#back-btn')
  const viewBtn = gameEl.querySelector('#view-btn')

  const setStatus = (message, variant = '') => {
    statusEl.textContent = message
    statusEl.className = `status toolbar-status ${variant}`.trim()
  }

  let leaderboardDone = false

  const preventBrowserZoom = (e) => e.preventDefault()
  document.addEventListener('gesturestart', preventBrowserZoom)
  document.addEventListener('gesturechange', preventBrowserZoom)
  document.addEventListener('gestureend', preventBrowserZoom)

  backBtn.addEventListener('click', () => {
    document.removeEventListener('gesturestart', preventBrowserZoom)
    document.removeEventListener('gesturechange', preventBrowserZoom)
    document.removeEventListener('gestureend', preventBrowserZoom)
    persistActiveRun()
    returnFromGame()
  })

  viewBtn.addEventListener('click', () => {
    if (!puzzle) {
      return
    }

    const active = puzzle.toggleReferenceVisible()
    viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
  })

  const restartBtn = gameEl.querySelector('#restart-btn')
  restartBtn.addEventListener('click', () => {
    if (!currentRun) return
    if (!confirm('Restart this puzzle? Your current progress will be lost.')) return
    clearRunForMode(currentRun)
    currentRun = null
    renderGame()
  })

  // Double-tap/click on puzzle board to toggle reference image
  // Ignores buttons, trays, and other interactive UI controls
  function isBoardTarget(target) {
    if (target.closest('button, input, select, [role="button"], .polygram-tray, .polygram-rotate-dock')) {
      return false
    }
    return mount.contains(target)
  }

  let lastTapTime = 0
  mount.addEventListener('touchend', (e) => {
    if (!puzzle || !isBoardTarget(e.target)) return
    // Ignore multi-touch (e.g. two-finger rotate)
    if (e.touches.length > 0) {
      lastTapTime = 0
      return
    }
    const now = Date.now()
    if (now - lastTapTime < 300) {
      e.preventDefault()
      const active = puzzle.toggleReferenceVisible()
      viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
      lastTapTime = 0
    } else {
      lastTapTime = now
    }
  })

  mount.addEventListener('dblclick', (e) => {
    if (!puzzle || !isBoardTarget(e.target)) return
    e.preventDefault()
    const active = puzzle.toggleReferenceVisible()
    viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
  })

  const highlightBtn = gameEl.querySelector('#highlight-btn')
  const edgesBtn = gameEl.querySelector('#edges-btn')
  if (highlightBtn) {
    highlightBtn.addEventListener('click', () => {
      puzzle?.highlightLoosePieces()
    })
  }

  if (edgesBtn) {
    edgesBtn.addEventListener('click', () => {
      if (!puzzle) return
      const active = puzzle.toggleEdgesOnly()
      edgesBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
    })
  }

  ;(async () => {
    try {
      destroyPuzzle()

      if (resumeRun) {
        state.gameMode = normalizeGameMode(resumeRun.gameMode || state.gameMode)
        state.difficulty = resumeRun.difficulty || state.difficulty
        state.imageUrl = resolveAssetUrl(resumeRun.imageUrl || state.imageUrl)
        state.puzzle = {
          date: resumeRun.puzzleDate,
        }
        currentRun = {
          ...resumeRun,
          gameMode: normalizeGameMode(resumeRun.gameMode || state.gameMode),
        }
      } else {
        currentRun = {
          version: 1,
          runId: createGuid(),
          playerGuid,
          gameMode,
          puzzleDate: state.puzzle?.date || getIsoDate(new Date()),
          difficulty: state.difficulty,
          imageUrl: state.imageUrl,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          elapsedActiveMs: 0,
          completed: false,
          puzzleState: null,
        }
      }

      startActiveTimer(currentRun.elapsedActiveMs)
      bindGameActivity(() => persistActiveRun())

      const loaderKey = gameMode === GAME_MODE_SLIDING ? 'sliding'
        : gameMode === GAME_MODE_SWAP ? 'swap'
        : gameMode === GAME_MODE_POLYGRAM ? 'polygram'
        : 'jigsaw'
      const PuzzleClass = await puzzleLoaders[loaderKey]()
      const puzzleConfig = {
        container: mount,
        imageUrl: state.imageUrl,
        difficulty: state.difficulty,
        boardColorIndex: getGlobalBoardColorIndex(),
        onProgress: ({ completed, state: progressState }) => {
          if (currentRun) {
            currentRun.completed = Boolean(completed)
          }
          persistActiveRun(progressState)
        },
        onComplete: async () => {
          if (!currentRun || leaderboardDone) {
            return
          }
          leaderboardDone = true

          pauseActiveTimer()
          currentRun.elapsedActiveMs = getActiveElapsedMs()
          currentRun.completed = true
          currentRun.updatedAt = new Date().toISOString()
          recordCompletedRun(currentRun)
          clearRunForMode(currentRun)

          // Celebration confetti
          const workspace = document.querySelector('.workspace')
          if (workspace) createConfettiOverlay(workspace)

          const durationLabel = formatDuration(currentRun.elapsedActiveMs)

          setStatus(
            `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Submitting...`,
            'ok',
          )

          let rank = null
          let leaderboardEntries = null
          let totalEntries = 0

          try {
            const result = await submitLeaderboard(currentRun)
            rank = result.rank

            const lb = await fetchLeaderboard(
              currentRun.puzzleDate,
              currentRun.gameMode,
              currentRun.difficulty,
              20,
            )
            leaderboardEntries = lb.entries || []
            totalEntries = leaderboardEntries.length
          } catch {
            // Non-fatal
          }

          showCompletionOverlay({
            gameMode,
            duration: durationLabel,
            elapsedMs: currentRun.elapsedActiveMs,
            rank,
            leaderboardEntries,
            totalEntries,
            playerGuid,
          })

          setStatus(
            rank
              ? `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Rank #${rank}.`
              : `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}.`,
            'ok',
          )
        },
      }

      if (gameMode === GAME_MODE_JIGSAW) {
        puzzleConfig.snapDistance = 10
      }

      puzzle = new PuzzleClass(puzzleConfig)

      await puzzle.init()

      if (resumeRun?.puzzleState) {
        puzzle.applyProgressState(resumeRun.puzzleState)

        if (gameMode === GAME_MODE_JIGSAW) {
          if (edgesBtn && puzzle.edgesOnly) {
            edgesBtn.setAttribute('aria-pressed', 'true')
          }
        }
      }

      persistActiveRun(puzzle.getProgressState())

      const puzzleLabel = state.puzzle ? `${state.puzzle.date}` : 'Puzzle ready'
      const elapsedLabel = formatDuration(getActiveElapsedMs())
      setStatus(
        `${puzzleLabel}. ${MODE_LABELS[gameMode]} mode. ${getInteractionHint(gameMode)} Active ${elapsedLabel}.`,
        'ok',
      )
    } catch (error) {
      console.error(error)
      setStatus('Failed to load puzzle image.', 'error')
    }
  })()
}

function destroyPuzzle() {
  unbindGameActivity()
  pauseActiveTimer()

  if (puzzle) {
    puzzle.destroy()
    puzzle = null
  }
}

// ─── Nav + page shell ───

const NAV_HTML = `
<nav class="top-nav" id="topNav">
  <div class="nav-brand">Xefig</div>
  <div class="nav-tabs" id="navTabs">
    <button class="nav-tab active" data-page="play">
      <svg class="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/>
        <rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/>
      </svg>
      <span>Play</span>
    </button>
    <button class="nav-tab" data-page="archive">
      <svg class="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 4h12M3 4v8a1 1 0 001 1h8a1 1 0 001-1V4"/><path d="M6 7h4"/>
      </svg>
      <span>Archive</span>
    </button>
    <button class="nav-tab" data-page="settings">
      <svg class="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="2.5"/>
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4"/>
      </svg>
      <span>Settings</span>
    </button>
    <div class="nav-indicator" id="navIndicator"></div>
  </div>
</nav>
<div class="app-page visible" id="page-play"></div>
<div class="app-page" id="page-archive"></div>
<div class="app-page" id="page-settings"></div>
<div class="app-page" id="page-game"></div>
`

let currentPage = 'play'
let archiveRendered = false
let settingsRendered = false

function initAppShell() {
  app.innerHTML = NAV_HTML

  const topNav = document.querySelector('#topNav')
  const tabs = [...document.querySelectorAll('.nav-tab')]
  const indicator = document.querySelector('#navIndicator')

  function updateIndicator(tab) {
    const r = tab.getBoundingClientRect()
    const pr = tab.parentElement.getBoundingClientRect()
    indicator.style.left = (r.left - pr.left) + 'px'
    indicator.style.width = r.width + 'px'
  }

  function switchPage(pageName) {
    if (pageName === currentPage) return
    currentPage = pageName

    // If coming back from game, clean up
    if (puzzle) destroyPuzzle()
    document.querySelector('#page-game').innerHTML = ''

    tabs.forEach((t) => t.classList.toggle('active', t.dataset.page === pageName))
    document.querySelectorAll('.app-page').forEach((p) => {
      p.classList.toggle('visible', p.id === `page-${pageName}`)
    })
    const activeTab = tabs.find((t) => t.dataset.page === pageName)
    if (activeTab) updateIndicator(activeTab)
    topNav.classList.toggle('solid', pageName !== 'play')
    topNav.classList.remove('hidden')

    if (pageName === 'play') {
      renderLauncher()
    } else if (pageName === 'archive') {
      if (!archiveRendered) renderArchivePage()
    } else if (pageName === 'settings') {
      renderSettingsPage()
    }
  }

  window.switchToPage = switchPage

  tabs.forEach((tab) => tab.addEventListener('click', () => switchPage(tab.dataset.page)))
  requestAnimationFrame(() => updateIndicator(tabs[0]))
  window.addEventListener('resize', () => {
    const active = tabs.find((t) => t.classList.contains('active'))
    if (active) updateIndicator(active)
  })

  renderLauncher()
}

function showGamePage() {
  currentPage = 'game'
  document.querySelector('#topNav').classList.add('hidden')
  document.querySelectorAll('.app-page').forEach((p) => {
    p.classList.toggle('visible', p.id === 'page-game')
  })
}

function returnFromGame() {
  if (state.sourceMode === 'archive') {
    archiveRendered = false
    window.switchToPage('archive')
  } else {
    window.switchToPage('play')
  }
}

function renderSettingsPage() {
  const container = document.querySelector('#page-settings')
  const colors = getBoardColors()
  const activeIndex = getGlobalBoardColorIndex()

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <h2>Settings</h2>
        <p>Customize your puzzle experience.</p>
      </div>
      <div class="settings-sections">
        <div class="settings-group">
          <div class="settings-group-title">Board Background</div>
          <div id="settings-board-colors" class="settings-color-grid">
            ${colors
              .map(
                (c, i) =>
                  `<div style="text-align:center">
                    <button class="settings-color-swatch${i === activeIndex ? ' is-active' : ''}" type="button" data-index="${i}" aria-label="${c.name}" title="${c.name}"${c.color ? ` style="background:${c.color}"` : ''}>
                      ${c.color ? '' : '\ud83d\uddbc'}
                    </button>
                    <div class="settings-color-label">${c.name}</div>
                  </div>`,
              )
              .join('')}
          </div>
        </div>
      </div>
    </div>
  `

  const grid = container.querySelector('#settings-board-colors')
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-index]')
    if (!btn) return
    const index = Number(btn.dataset.index)
    setGlobalBoardColorIndex(index)
    grid.querySelectorAll('.settings-color-swatch').forEach((s, i) => {
      s.classList.toggle('is-active', i === index)
    })
  })

  settingsRendered = true
}

initAppShell()

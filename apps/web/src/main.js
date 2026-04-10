import './style.css'
import sampleImage from './assets/hero.png'
import {
  initSync,
  onGameExit as syncOnGameExit,
  isSyncEnabled,
  getShareCode,
  getProfileName,
  setProfileName,
  enableSync,
  linkSync,
  disableSync,
  onConflict,
  resolveConflict,
  startSyncTimer,
  stopSyncTimer,
  getSyncStatus,
  onStatusChange,
  forcePush,
  hasPendingChanges,
  notifyIfPending,
  markSettingsDirty,
  markCompletedRunDirty,
  markActiveRunDirty,
  markActiveRunDeleted,
} from './sync.js'
// Puzzle engines are loaded on demand in renderGame() via dynamic import()
// to keep the homepage bundle free of gameplay code.
const puzzleLoaders = {
  jigsaw: () => import('./components/jigsaw-puzzle.js').then((m) => m.JigsawPuzzle),
  sliding: () => import('./components/sliding-tile-puzzle.js').then((m) => m.SlidingTilePuzzle),
  swap: () => import('./components/picture-swap-puzzle.js').then((m) => m.PictureSwapPuzzle),
  polygram: () => import('./components/polygram-puzzle.js').then((m) => m.PolygramPuzzle),
  diamond: () => import('./components/diamond-painting-puzzle.js').then((m) => m.DiamondPaintingPuzzle),
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

const LANDSCAPE_LAYOUT_KEY = 'xefig:landscape-layout'
const LANDSCAPE_LAYOUTS = [
  { id: 'default', name: 'Default', desc: 'Standard horizontal slices with top nav' },
  { id: 'bottom-dock', name: 'Bottom Dock', desc: 'Nav moves to a compact dock at the bottom' },
  { id: 'side-rail', name: 'Side Rail', desc: 'Vertical nav rail on the left edge' },
  { id: 'immersive', name: 'Immersive', desc: 'No nav \u2014 full-screen slices with floating pill menu' },
  { id: 'split-panel', name: 'Split Panel', desc: 'Dark sidebar with puzzle list, full-bleed active image' },
  { id: 'carousel', name: 'Carousel', desc: 'Full-screen single puzzle with swipe navigation' },
]

function getLandscapeLayout() {
  const saved = localStorage.getItem(LANDSCAPE_LAYOUT_KEY)
  return LANDSCAPE_LAYOUTS.find(l => l.id === saved) ? saved : 'default'
}

function setLandscapeLayout(id) {
  localStorage.setItem(LANDSCAPE_LAYOUT_KEY, id)
  applyLandscapeLayout()
}

function applyLandscapeLayout() {
  const id = getLandscapeLayout()
  const root = document.documentElement
  LANDSCAPE_LAYOUTS.forEach(l => root.classList.remove('ls-' + l.id))
  root.classList.add('ls-' + id)
}
const GAME_MODE_JIGSAW = 'jigsaw'
const GAME_MODE_SLIDING = 'sliding'
const GAME_MODE_SWAP = 'swap'
const GAME_MODE_POLYGRAM = 'polygram'
const GAME_MODE_DIAMOND = 'diamond'
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
  [GAME_MODE_DIAMOND]: {
    medium: '16 colors',
  },
}
const MODE_LABELS = {
  [GAME_MODE_JIGSAW]: 'Jigsaw',
  [GAME_MODE_SLIDING]: 'Sliding Tile',
  [GAME_MODE_SWAP]: 'Tile Swap',
  [GAME_MODE_POLYGRAM]: 'Polygram',
  [GAME_MODE_DIAMOND]: 'Paint by Numbers',
}
const GAME_MODE_TO_PUZZLE_CATEGORY = {
  [GAME_MODE_JIGSAW]: 'jigsaw',
  [GAME_MODE_SLIDING]: 'slider',
  [GAME_MODE_SWAP]: 'swap',
  [GAME_MODE_POLYGRAM]: 'polygram',
  [GAME_MODE_DIAMOND]: 'diamond',
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
  if (mode === GAME_MODE_DIAMOND) {
    return GAME_MODE_DIAMOND
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
  if (gameMode === GAME_MODE_DIAMOND) {
    return 'Pick a color from the palette, then tap or drag to paint cells. Match the numbers to reveal the image.'
  }

  const isLandscapeDesktop = window.innerWidth >= 1024 && window.innerWidth > window.innerHeight
  return isLandscapeDesktop
    ? 'Scroll the right tray and drag pieces onto the board.'
    : 'Swipe tray left/right. Drag up on a piece to pick it up.'
}

function getGameModeOfDay(dateKey = getIsoDate(new Date())) {
  const seed = Number(dateKey.replaceAll('-', ''))
  const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND]
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
  markCompletedRunDirty({
    puzzleDate,
    gameMode: mode,
  })
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
  markActiveRunDeleted(run)
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
    syncOnGameExit()
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
    notifyIfPending()
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

  // Don't save until the player has actually interacted (timer started)
  const elapsed = getActiveElapsedMs()
  if (elapsed === 0 && !progressState) {
    return
  }

  const nextRun = {
    ...currentRun,
    elapsedActiveMs: elapsed,
    updatedAt: new Date().toISOString(),
    puzzleState: progressState || (puzzle ? puzzle.getProgressState() : currentRun.puzzleState),
  }
  currentRun = nextRun
  saveRunForMode(nextRun)
  markActiveRunDirty(nextRun)
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
  const today = getIsoDate(new Date())

  // For the default "today" request, use the early fetch started in index.html
  // so we don't wait for the module to load before hitting the API.
  if (!date && window.__earlyPuzzle) {
    const early = await window.__earlyPuzzle
    window.__earlyPuzzle = null
    // Only use the early result if it matches today's date
    if (early && early.date === today) {
      cacheDailyPayload(early)
      return early
    }
    // Stale — fall through to a fresh fetch
  }

  const endpoint = date ? `/api/puzzles/${encodeURIComponent(date)}` : '/api/puzzles/today'
  // Bust browser cache for "today" if the day has rolled over
  const cacheBust = !date ? `?_=${today}` : ''
  const response = await fetch(apiUrl(endpoint + cacheBust))
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
  [GAME_MODE_DIAMOND]: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="22" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1" fill="currentColor" opacity="0.3"/><rect x="22" y="13" width="7" height="7" rx="1"/><rect x="4" y="22" width="7" height="7" rx="1" fill="currentColor" opacity="0.3"/><rect x="13" y="22" width="7" height="7" rx="1"/><rect x="22" y="22" width="7" height="7" rx="1" fill="currentColor" opacity="0.3"/></svg>',
}

const SPINE_LABELS = {
  [GAME_MODE_JIGSAW]: 'Jigsaw',
  [GAME_MODE_SLIDING]: 'Slider',
  [GAME_MODE_SWAP]: 'Swap',
  [GAME_MODE_POLYGRAM]: 'Polygram',
  [GAME_MODE_DIAMOND]: 'Paint',
}

const SPINE_ACTIONS = {
  [GAME_MODE_JIGSAW]: 'Solve now',
  [GAME_MODE_SLIDING]: 'Slide now',
  [GAME_MODE_SWAP]: 'Swap now',
  [GAME_MODE_POLYGRAM]: 'Build now',
  [GAME_MODE_DIAMOND]: 'Paint now',
}

const SLICE_DESCRIPTIONS = {
  [GAME_MODE_JIGSAW]: 'Drag and place interlocking pieces to reconstruct the full image. Start with edges and corners, then work inward.',
  [GAME_MODE_SLIDING]: 'Slide tiles into the empty space to reorder the scrambled image. Deceptively simple, maddeningly strategic.',
  [GAME_MODE_SWAP]: 'Select any two tiles and swap their positions. No empty space needed \u2014 challenges spatial memory and pattern recognition.',
  [GAME_MODE_POLYGRAM]: 'The image shatters into irregular polygon shards. Rotate and place geometric fragments to piece reality back together.',
  [GAME_MODE_DIAMOND]: 'Fill the numbered grid with matching colors from the palette to reveal the hidden image. A relaxing, meditative puzzle.',
}

const SLICE_TAGS = {
  [GAME_MODE_JIGSAW]: ['Drag & Drop', '64\u2013225 pcs', 'Classic'],
  [GAME_MODE_SLIDING]: ['Slide', '3\u00d73 \u2014 7\u00d77', 'Strategy'],
  [GAME_MODE_SWAP]: ['Tap & Swap', '4\u00d74 \u2014 10\u00d710', 'Spatial'],
  [GAME_MODE_POLYGRAM]: ['Rotate & Place', 'Freeform', 'Artistic'],
  [GAME_MODE_DIAMOND]: ['Tap & Paint', '16 colors', 'Relaxing'],
}

function bindLandscapeNavEvents(pageEl, container) {
  // Immersive pill, split sidebar nav links, carousel corners — all use data-page
  pageEl.querySelectorAll('[data-page]').forEach(btn => {
    if (btn.closest('.slice') || btn.closest('#navTabs')) return // skip slice/nav buttons
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const page = btn.dataset.page
      if (page && window.switchToPage) window.switchToPage(page)
    })
  })

  // Split sidebar mode buttons
  pageEl.querySelectorAll('.split-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const index = Number(btn.dataset.index)
      const slices = container.querySelectorAll('.slice')
      if (slices[index]) {
        slices.forEach((s, i) => {
          const isActive = i === index
          s.classList.toggle('active', isActive)
          s.style.setProperty('--flex', isActive ? 2.2 : 0.9)
        })
        pageEl.querySelectorAll('.split-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.index === btn.dataset.index))
      }
    })
  })

  // Carousel scroll → update dots
  const updateCarouselDots = () => {
    const dots = pageEl.querySelectorAll('.carousel-dot')
    if (!dots.length) return
    const scrollLeft = container.scrollLeft
    const width = container.clientWidth
    const activeIndex = Math.round(scrollLeft / width)
    dots.forEach((d, i) => d.classList.toggle('active', i === activeIndex))
  }
  container.addEventListener('scroll', updateCarouselDots, { passive: true })
}

function computeSliceCenter(container) {
  requestAnimationFrame(() => {
    const collapsed = container.querySelector('.slice:not(.active):not(.slice-more)')
    const active = container.querySelector('.slice.active:not(.slice-more)')
    if (collapsed) {
      const center = collapsed.offsetWidth / 2
      container.style.setProperty('--slice-center', center + 'px')
    }
    if (active && collapsed) {
      const infoWidth = active.offsetWidth - collapsed.offsetWidth / 2 - 19
      container.style.setProperty('--info-width', infoWidth + 'px')
    }
  })
}

function renderLauncher() {
  destroyPuzzle()

  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'today'
  state.archiveDate = todayDate
  state.gameMode = getGameModeOfDay(todayDate)
  state.difficulty = state.difficulty || 'medium'

  const ACTIVE_FLEX = 3
  const INACTIVE_FLEX = 0.8
  const MORE_INACTIVE_FLEX = 0.6
  const MORE_ACTIVE_FLEX = 2.5
  const pickMode = getGameModeOfDay(todayDate)
  const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND]

  const renderSlices = (puzzlePayload) => {
    const puzzleDate = puzzlePayload?.date || todayDate
    const completedModes = getCompletedModesForDate(puzzleDate)
    return modes
      .map((mode, index) => {
        const imageUrl = resolvePuzzleThumbnailUrl(puzzlePayload, mode)
        const isPick = mode === pickMode
        const isActive = isPick
        const title = (mode === GAME_MODE_DIAMOND && !isActive) ? 'Paint' : MODE_LABELS[mode]
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
            <div class="slice-accent" style="background:${ACCENT_MAP_FULL[mode]}"></div>
            <div class="slice-title">${SPINE_LABELS[mode]}</div>
            <div class="slice-info"><p>${SLICE_DESCRIPTIONS[mode]}</p></div>
            <div class="slice-action"><span>${hasSave ? 'Resume' : SPINE_ACTIONS[mode]}</span></div>
            <div class="slice-bar">
              <span class="bar-title">${title}</span>
              <div class="bar-icon info-btn" title="More info">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4.5v.5"/></svg>
              </div>
              <div class="bar-spacer"></div>
              ${isCompleted ? `<span class="bar-completed" title="Completed${entry?.bestElapsedMs ? ' \u2014 ' + formatDuration(entry.bestElapsedMs) : ''}"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.35 5.35a.5.5 0 0 0-.7-.7L7 8.29 5.35 6.65a.5.5 0 0 0-.7.7l2 2a.5.5 0 0 0 .7 0l4-4Z"/></svg>${entry?.bestElapsedMs ? ` <span class="bar-completed-time">${formatDuration(entry.bestElapsedMs)}</span>` : ''}</span>` : ''}
              ${hasSave && !isCompleted ? `<div class="bar-icon has-save" title="Save exists"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h8l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm1 1v4h7V2H4zm4 6a2 2 0 100 4 2 2 0 000-4z"/></svg></div>` : ''}
            </div>
            <div class="info-panel" data-mode="${mode}"></div>
          </div>
        `
      })
      .join('') + `
          <div class="slice slice-more" style="--flex: ${MORE_INACTIVE_FLEX};">
            <div class="slice-overlay"></div>
            <div class="slice-title">More</div>
            <div class="slice-icon"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor"><circle cx="8" cy="16" r="2.5" fill="currentColor"/><circle cx="16" cy="16" r="2.5" fill="currentColor"/><circle cx="24" cy="16" r="2.5" fill="currentColor"/></svg></div>
            <div class="slice-more-cards">
              <button class="more-card" data-page="archive">
                <div class="more-card-icon">
                  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 8h24M6 8v16a2 2 0 002 2h16a2 2 0 002-2V8"/><path d="M12 14h8"/><rect x="10" y="11" width="12" height="6" rx="1"/></svg>
                </div>
                <span class="more-card-label">Archive</span>
              </button>
              <button class="more-card" data-page="settings">
                <div class="more-card-icon">
                  <svg viewBox="0 0 100 100" fill="currentColor"><path fill-rule="evenodd" d="M40.7 15.2 L44 4.4 L56 4.4 L59.3 15.2 L68 18.8 L78 13.5 L86.5 22 L81.2 32 L84.8 40.7 L95.6 44 L95.6 56 L84.8 59.3 L81.2 68 L86.5 78 L78 86.5 L68 81.2 L59.3 84.8 L56 95.6 L44 95.6 L40.7 84.8 L32 81.2 L22 86.5 L13.5 78 L18.8 68 L15.2 59.3 L4.4 56 L4.4 44 L15.2 40.7 L18.8 32 L13.5 22 L22 13.5 L32 18.8 z M50 32 L56.9 33.4 L62.7 37.3 L66.6 43.1 L68 50 L66.6 56.9 L62.7 62.7 L56.9 66.6 L50 68 L43.1 66.6 L37.3 62.7 L33.4 56.9 L32 50 L33.4 43.1 L37.3 37.3 L43.1 33.4 z"/></svg>
                </div>
                <span class="more-card-label">Settings</span>
              </button>
            </div>
          </div>`
  }

  const ACCENT_MAP_FULL = { jigsaw: '#f0c040', sliding: '#40d0f0', swap: '#f06050', polygram: '#a060f0', diamond: '#e070a0' }

  const pageEl = document.querySelector('#page-play')
  pageEl.innerHTML = `
    <main class="slice-launcher">
      <div class="split-sidebar">
        <div class="split-brand">Xefig</div>
        <div class="split-mode-list">
          ${modes.map((m, i) => `<button class="split-mode-btn${m === pickMode ? ' active' : ''}" data-mode="${m}" data-index="${i}"><span class="split-mode-dot" style="background:${ACCENT_MAP_FULL[m]}"></span>${MODE_LABELS[m]}</button>`).join('')}
        </div>
        <div class="split-nav-links">
          <button class="split-nav-btn" data-page="archive">Archive</button>
          <button class="split-nav-btn" data-page="settings">Settings</button>
        </div>
      </div>
      <div id="slice-container" class="slice-container">
        <div class="slice" style="--flex:1;opacity:0"></div>
      </div>
      <div class="immersive-pill">
        <button data-page="play" class="active">Play</button>
        <button data-page="archive">Archive</button>
        <button data-page="settings">Settings</button>
      </div>
      <div class="carousel-dots">
        ${modes.map((m, i) => `<div class="carousel-dot${m === pickMode ? ' active' : ''}" data-index="${i}"></div>`).join('')}
      </div>
      <div class="carousel-corners">
        <button class="carousel-corner-btn cc-archive" data-page="archive">Archive</button>
        <button class="carousel-corner-btn cc-settings" data-page="settings">Settings</button>
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

  const ACCENT_MAP = { jigsaw: '#f0c040', sliding: '#40d0f0', swap: '#f06050', polygram: '#a060f0', diamond: '#e070a0' }

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
        const isMore = s.classList.contains('slice-more')
        if (isMore) {
          const moreActive = index === i
          s.classList.toggle('active', moreActive)
          s.style.setProperty('--flex', moreActive ? MORE_ACTIVE_FLEX : MORE_INACTIVE_FLEX)
        } else {
          const isActive = i === index
          s.classList.toggle('active', isActive)
          s.style.setProperty('--flex', isActive ? ACTIVE_FLEX : INACTIVE_FLEX)
        }
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

      // More slice — expands on click, nav buttons switch page
      if (slice.classList.contains('slice-more')) {
        slice.querySelectorAll('.more-card').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (!slice.classList.contains('active')) return
            window.switchToPage(btn.dataset.page)
          })
        })
        slice.addEventListener('click', () => {
          if (!slice.classList.contains('active')) {
            setActive(i)
          }
        })
        return
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
      bindLandscapeNavEvents(pageEl, container)
      computeSliceCenter(container)

      // Recompute on orientation change (portrait widths differ from landscape)
      const orientationMQ = window.matchMedia('(orientation: landscape)')
      orientationMQ.addEventListener('change', () => {
        container.classList.add('slice-recompute')
        computeSliceCenter(container)
        // Fade text back in after position is resolved
        requestAnimationFrame(() => requestAnimationFrame(() => {
          container.classList.remove('slice-recompute')
        }))
      })

      // Progressive image upgrade: swap thumbnails for full-size images once loaded
      const sliceImages = container.querySelectorAll('.slice-image')
      sliceImages.forEach((img, index) => {
        const mode = modes[index]
        const fullUrl = resolvePuzzleImageUrl(payload, mode)
        const thumbUrl = img.src
        if (fullUrl === thumbUrl) return

        const full = new Image()
        full.src = fullUrl
        full.onload = () => {
          if (img.isConnected) img.src = fullUrl
        }
      })
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
  [GAME_MODE_DIAMOND]: '#e070a0',
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
        <button class="page-back-btn" data-page="play" aria-label="Back to menu">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
        </button>
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

  pageEl.querySelector('.page-back-btn').addEventListener('click', () => window.switchToPage('play'))

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
    const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND]

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
  const accentColor = gameMode === GAME_MODE_JIGSAW ? '#f0c040'
    : gameMode === GAME_MODE_SLIDING ? '#40d0f0'
    : gameMode === GAME_MODE_SWAP ? '#f06050'
    : gameMode === GAME_MODE_DIAMOND ? '#e070a0'
    : '#a060f0'
  const dateLabel = state.puzzle?.date
    ? new Date(Date.parse(`${state.puzzle.date}T00:00:00Z`)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
    : ''
  const compactModeLabel = gameMode === GAME_MODE_DIAMOND ? 'Paint' : MODE_LABELS[gameMode]
  const titleLabel = `${compactModeLabel}${dateLabel ? ` <span style="color:${accentColor}">\u00b7</span> ${dateLabel}` : ''}`
  const showPieceCount = gameMode !== GAME_MODE_DIAMOND

  gameEl.innerHTML = `
    <main class="game-shell game-shell--${gameMode}">
      <header class="game-toolbar game-toolbar--${gameMode}">
        <button id="back-btn" class="gt-icon-btn" type="button" aria-label="Back to launcher" title="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>

        <div class="gt-title">${titleLabel}</div>

        <div class="gt-actions">
          <div class="gt-menu-wrap">
            <button id="menu-btn" class="gt-icon-btn" type="button" aria-label="More actions" aria-expanded="false" title="More">
              <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
            </button>
            <div id="gt-menu" class="gt-menu" hidden>
              ${gameMode === GAME_MODE_JIGSAW ? `
              <button id="highlight-btn" class="gt-menu-item" type="button">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2l1.6 4.6L15 8l-4.4 1.4L9 14l-1.6-4.6L3 8l4.4-1.4Zm8 4l1 2.8 2.8 1-2.8 1L17 14l-1-2.8L13.2 10l2.8-1Zm-4 10l.8 2.2L16 19.2l-2.2.8L13 22l-.8-2-2.2-1 2.2-.8Z"/></svg>
                Highlight loose
              </button>
              <button id="edges-btn" class="gt-menu-item" type="button" aria-pressed="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 3 L18 3 L18 7.2 C18 8.3, 21.5 8.1, 21.5 10.5 C21.5 12.9, 18 12.7, 18 13.8 L18 18 L13.8 18 C12.7 18, 12.9 21.5, 10.5 21.5 C8.1 21.5, 8.3 18, 7.2 18 L3 18 Z"/></svg>
                Edges only
              </button>
              ` : ''}
              ${gameMode !== GAME_MODE_DIAMOND ? `<button id="view-btn" class="gt-menu-item" type="button" aria-pressed="false">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>
                Reference image
              </button>` : ''}
              <button id="restart-btn" class="gt-menu-item gt-menu-item--danger" type="button">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L14 10h7V3l-3.35 3.35Z"/></svg>
                Restart
              </button>
            </div>
          </div>
        </div>

        <div class="gt-stats gt-stats--${gameMode}">
          ${showPieceCount ? `<span id="piece-count" class="gt-counter"></span>
          <span class="gt-divider"></span>` : ''}
          <span id="timer" class="gt-timer">00:00</span>
          ${isSyncEnabled() ? `<button id="save-indicator" class="save-indicator" type="button" aria-label="Sync status" title="Saved">
            <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.5 10.3L4.3 8.1l1-1L7.5 9.4l3.2-3.2 1 1L7.5 11.3Z"/></svg>
          </button>` : ''}
        </div>

        <p id="status" class="sr-only" aria-live="polite">Loading puzzle...</p>
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
  const pieceCountEl = gameEl.querySelector('#piece-count')
  const timerEl = gameEl.querySelector('#timer')
  const saveIndicator = gameEl.querySelector('#save-indicator')

  // Save indicator state
  function updateSaveIndicator(status) {
    if (!saveIndicator) return
    const isPending = status === 'idle' || status === 'error' || !status
    // After initial load, 'idle' means we haven't pushed yet — check for changes
    const hasChanges = isPending && hasPendingChanges()
    if (status === 'saved') {
      saveIndicator.dataset.state = 'saved'
      saveIndicator.title = 'Saved to cloud'
    } else if (status === 'syncing') {
      saveIndicator.dataset.state = 'syncing'
      saveIndicator.title = 'Syncing...'
    } else if (status === 'error' || hasChanges) {
      saveIndicator.dataset.state = 'pending'
      saveIndicator.title = 'Tap to sync now'
    } else {
      saveIndicator.dataset.state = 'saved'
      saveIndicator.title = 'Saved to cloud'
    }
  }

  if (saveIndicator) {
    updateSaveIndicator(getSyncStatus())
    onStatusChange(updateSaveIndicator)
    saveIndicator.addEventListener('click', async () => {
      persistActiveRun()
      await forcePush()
    })
  }

  let timerRaf = null
  const updateTimer = () => {
    timerEl.textContent = formatDuration(getActiveElapsedMs())
    timerRaf = requestAnimationFrame(updateTimer)
  }
  const startTimerDisplay = () => { if (!timerRaf) timerRaf = requestAnimationFrame(updateTimer) }
  const stopTimerDisplay = () => { if (timerRaf) { cancelAnimationFrame(timerRaf); timerRaf = null } }

  const updatePieceCount = () => {
    if (!puzzle || !pieceCountEl) return
    const locked = puzzle.pieces?.filter((p) => p.locked).length ?? 0
    const total = puzzle.pieces?.length ?? 0
    pieceCountEl.textContent = `${locked}/${total}`
  }

  const setStatus = (message, variant = '') => {
    statusEl.textContent = message
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
    document.removeEventListener('click', closeMenu)
    persistActiveRun()
    returnFromGame()
  })

  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      if (!puzzle) {
        return
      }

      const active = puzzle.toggleReferenceVisible()
      viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
    })
  }

  // Menu toggle
  const menuBtn = gameEl.querySelector('#menu-btn')
  const menuPanel = gameEl.querySelector('#gt-menu')
  const toggleMenu = (open) => {
    const show = open ?? menuPanel.hidden
    menuPanel.hidden = !show
    menuBtn.setAttribute('aria-expanded', show ? 'true' : 'false')
  }
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu() })
  const closeMenu = () => toggleMenu(false)
  document.addEventListener('click', closeMenu)
  menuPanel.addEventListener('click', closeMenu)

  const restartBtn = gameEl.querySelector('#restart-btn')
  restartBtn.addEventListener('click', () => {
    if (!currentRun) return
    if (!confirm('Restart this puzzle? Your current progress will be lost.')) return
    stopTimerDisplay()
    clearRunForMode(currentRun)
    currentRun = null
    renderGame()
  })

  // Double-tap/click on puzzle board to toggle reference image
  // Ignores buttons, trays, and other interactive UI controls
  function isBoardTarget(target) {
    if (target.closest('button, input, select, [role="button"], .polygram-tray, .polygram-rotate-dock, .diamond-palette-bar, .gt-menu')) {
      return false
    }
    return mount.contains(target)
  }

  function toggleReference() {
    if (!puzzle || !viewBtn) return
    const active = puzzle.toggleReferenceVisible()
    viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
  }

  let lastTapTime = 0
  let dblHandled = false
  mount.addEventListener('pointerup', (e) => {
    if (!puzzle || !isBoardTarget(e.target)) return
    if (e.target.closest('.sliding-tile, .picture-swap-tile')) return
    const now = Date.now()
    if (now - lastTapTime > 0 && now - lastTapTime < 500) {
      dblHandled = true
      toggleReference()
      lastTapTime = 0
    } else {
      dblHandled = false
      lastTapTime = now
    }
  })

  mount.addEventListener('dblclick', (e) => {
    if (!puzzle || (!isBoardTarget(e.target) && !e.target.closest('.sliding-tile, .picture-swap-tile'))) return
    e.preventDefault()
    if (dblHandled) { dblHandled = false; return }
    toggleReference()
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

      // For resumed games, start timer immediately. For new games, defer until first interaction.
      const isResume = Boolean(resumeRun)
      let timerStarted = isResume
      let initDone = false
      if (isResume) {
        startActiveTimer(currentRun.elapsedActiveMs)
      }
      bindGameActivity(() => persistActiveRun())

      const loaderKey = gameMode === GAME_MODE_SLIDING ? 'sliding'
        : gameMode === GAME_MODE_SWAP ? 'swap'
        : gameMode === GAME_MODE_POLYGRAM ? 'polygram'
        : gameMode === GAME_MODE_DIAMOND ? 'diamond'
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
          // Start timer on first piece interaction (not on puzzle load / init)
          if (!timerStarted && initDone) {
            timerStarted = true
            startActiveTimer(0)
            startTimerDisplay()
          }
          persistActiveRun(progressState)
          updatePieceCount()
          // Sync view button if puzzle auto-hid the reference
          if (viewBtn && puzzle && !puzzle.referenceVisible) {
            viewBtn.setAttribute('aria-pressed', 'false')
          }
        },
        onComplete: async () => {
          if (!currentRun || leaderboardDone) {
            return
          }
          leaderboardDone = true

          stopTimerDisplay()
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
      initDone = true

      if (resumeRun?.puzzleState) {
        puzzle.applyProgressState(resumeRun.puzzleState)

        if (gameMode === GAME_MODE_JIGSAW) {
          if (edgesBtn && puzzle.edgesOnly) {
            edgesBtn.setAttribute('aria-pressed', 'true')
          }
        }
      }

      if (isResume) persistActiveRun(puzzle.getProgressState())

      updatePieceCount()
      if (isResume) startTimerDisplay()

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
  onStatusChange(null)

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
    <div class="nav-spacer"></div>
    <button class="nav-tab nav-gear" data-page="settings" aria-label="Settings">
      <svg class="tab-icon" viewBox="0 0 100 100" fill="currentColor">
        <path fill-rule="evenodd" d="M40.7 15.2 L44 4.4 L56 4.4 L59.3 15.2 L68 18.8 L78 13.5 L86.5 22 L81.2 32 L84.8 40.7 L95.6 44 L95.6 56 L84.8 59.3 L81.2 68 L86.5 78 L78 86.5 L68 81.2 L59.3 84.8 L56 95.6 L44 95.6 L40.7 84.8 L32 81.2 L22 86.5 L13.5 78 L18.8 68 L15.2 59.3 L4.4 56 L4.4 44 L15.2 40.7 L18.8 32 L13.5 22 L22 13.5 L32 18.8 z M50 32 L56.9 33.4 L62.7 37.3 L66.6 43.1 L68 50 L66.6 56.9 L62.7 62.7 L56.9 66.6 L50 68 L43.1 66.6 L37.3 62.7 L33.4 56.9 L32 50 L33.4 43.1 L37.3 37.3 L43.1 33.4 z"/>
      </svg>
      <span class="gear-label">Settings</span>
    </button>
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
let lastSetHash = ''

function setHash(hash) {
  lastSetHash = hash
  window.location.hash = hash
}

function initAppShell() {
  applyLandscapeLayout()
  app.innerHTML = NAV_HTML

  const topNav = document.querySelector('#topNav')
  const topTabs = [...document.querySelectorAll('#navTabs .nav-tab')]

  function switchPage(pageName, { updateHash = true } = {}) {
    if (pageName === currentPage) return
    currentPage = pageName

    // If coming back from game, clean up
    if (puzzle) destroyPuzzle()
    document.querySelector('#page-game').innerHTML = ''

    topTabs.forEach((t) => t.classList.toggle('active', t.dataset.page === pageName))
    document.querySelectorAll('.app-page').forEach((p) => {
      p.classList.toggle('visible', p.id === `page-${pageName}`)
    })

    topNav.classList.toggle('solid', pageName !== 'play')
    topNav.classList.remove('hidden')

    if (pageName === 'play') {
      renderLauncher()
      if (updateHash) setHash('#play')
    } else if (pageName === 'archive') {
      if (!archiveRendered) renderArchivePage()
      if (updateHash) setHash('#archive')
    } else if (pageName === 'settings') {
      renderSettingsPage()
      if (updateHash) setHash('#settings')
    }
  }

  window.switchToPage = switchPage

  topTabs.forEach((tab) => tab.addEventListener('click', () => switchPage(tab.dataset.page)))

  // Route based on current hash
  const initialRoute = parseHash()
  if (initialRoute.page === 'game' && initialRoute.mode && initialRoute.date) {
    // Resume into a game directly
    renderLauncher()
    resumeGameFromHash(initialRoute.mode, initialRoute.date)
  } else if (initialRoute.page === 'archive') {
    switchPage('archive', { updateHash: false })
  } else if (initialRoute.page === 'settings') {
    switchPage('settings', { updateHash: false })
  } else {
    renderLauncher()
  }

  // Handle browser back/forward — ignore hash changes we set ourselves
  window.addEventListener('hashchange', () => {
    const currentHash = window.location.hash
    if (currentHash === lastSetHash) return
    lastSetHash = currentHash
    const route = parseHash()
    if (route.page === 'game' && route.mode && route.date) {
      resumeGameFromHash(route.mode, route.date)
    } else if (['play', 'archive', 'settings'].includes(route.page)) {
      switchPage(route.page, { updateHash: false })
    } else {
      switchPage('play', { updateHash: false })
    }
  })
}

function parseHash() {
  const hash = window.location.hash.replace(/^#/, '')
  const parts = hash.split('/')
  // #game/jigsaw/2026-03-27 or #play or #archive or #settings
  if (parts[0] === 'game' && parts.length >= 3) {
    return { page: 'game', mode: parts[1], date: parts[2] }
  }
  return { page: parts[0] || 'play' }
}

function resumeGameFromHash(mode, date) {
  const normalizedMode = normalizeGameMode(mode)
  state.gameMode = normalizedMode
  state.sourceMode = 'today'
  state.difficulty = state.difficulty || 'medium'

  // Try to find a saved run for this mode+date
  const savedRun = getRunForMode(date, normalizedMode)
  if (savedRun) {
    state.imageUrl = resolveAssetUrl(savedRun.imageUrl)
    state.puzzle = { date }
    renderGame({ resumeRun: savedRun })
    return
  }

  // Check if this puzzle was already completed
  const completedModes = getCompletedModesForDate(date)
  if (completedModes.has(normalizedMode)) {
    ;(async () => {
      try {
        const payload = await fetchPuzzlePayload({ date })
        state.puzzle = payload
        const entry = getCompletionEntry(date, normalizedMode)
        showCompletedPuzzleScreen({
          gameMode: normalizedMode,
          puzzleDate: date,
          entry,
          onReplay: () => renderGame(),
          onBack: () => returnFromGame(),
        })
      } catch {
        window.switchToPage('play')
      }
    })()
    return
  }

  // No saved run — fetch the puzzle and start fresh
  ;(async () => {
    try {
      const payload = await fetchPuzzlePayload({ date })
      state.puzzle = payload
      state.imageUrl = resolvePuzzleImageUrl(payload, normalizedMode)
      renderGame()
    } catch {
      // Can't load puzzle — fall back to launcher
      window.switchToPage('play')
    }
  })()
}

function showGamePage() {
  currentPage = 'game'
  document.querySelector('#topNav').classList.add('hidden')
  document.querySelectorAll('.app-page').forEach((p) => {
    p.classList.toggle('visible', p.id === 'page-game')
  })
  // Set hash: #game/mode/date
  const gameMode = state.gameMode || 'jigsaw'
  const puzzleDate = state.puzzle?.date || getIsoDate(new Date())
  setHash(`#game/${gameMode}/${puzzleDate}`)
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

  const formTs = Date.now()

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <button class="page-back-btn" data-page="play" aria-label="Back to menu">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
        </button>
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
        <div class="settings-group">
          <div class="settings-group-title">Sync Progress</div>
          <div id="settings-sync-content"></div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Landscape Layout</div>
          <p class="about-text" style="margin-bottom:0.8rem">Choose how the puzzle menu appears in landscape orientation.</p>
          <div id="settings-landscape-layouts" class="settings-landscape-grid">
            ${LANDSCAPE_LAYOUTS.map(l => `
              <button class="settings-landscape-btn${l.id === getLandscapeLayout() ? ' is-active' : ''}" data-layout="${l.id}">
                <span class="sl-name">${l.name}</span>
                <span class="sl-desc">${l.desc}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">AI-Generated Content</div>
          <p class="about-text">
            All puzzle images on Xefig are generated using artificial intelligence
            (Google Gemini). No real photographs are used. In accordance with EU
            AI Act transparency requirements, we disclose that this content is
            AI-generated and should not be mistaken for authentic photographs.
          </p>
        </div>
        <div class="settings-group">
          <div class="settings-group-title">Contact</div>
          <form id="contact-form" class="contact-form" autocomplete="off">
            <div class="contact-field">
              <label class="contact-label" for="contact-name">Name</label>
              <input class="contact-input" type="text" id="contact-name" name="name" required minlength="2" maxlength="100" placeholder="Your name" />
            </div>
            <div class="contact-field">
              <label class="contact-label" for="contact-email">Email</label>
              <input class="contact-input" type="email" id="contact-email" name="email" required placeholder="you@example.com" />
            </div>
            <div class="contact-field" aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;opacity:0;pointer-events:none;tab-index:-1">
              <label for="contact-website">Website</label>
              <input type="text" id="contact-website" name="website" tabindex="-1" autocomplete="off" />
            </div>
            <div class="contact-field">
              <label class="contact-label" for="contact-message">Message</label>
              <textarea class="contact-input contact-textarea" id="contact-message" name="message" required minlength="10" maxlength="5000" rows="5" placeholder="Your message..."></textarea>
            </div>
            <div id="contact-status" class="contact-status"></div>
            <button type="submit" class="contact-submit" id="contact-submit">Send Message</button>
          </form>
        </div>
      </div>
    </div>
  `

  container.querySelector('.page-back-btn').addEventListener('click', () => window.switchToPage('play'))

  const grid = container.querySelector('#settings-board-colors')
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-index]')
    if (!btn) return
    const index = Number(btn.dataset.index)
    setGlobalBoardColorIndex(index)
    markSettingsDirty()
    grid.querySelectorAll('.settings-color-swatch').forEach((s, i) => {
      s.classList.toggle('is-active', i === index)
    })
  })

  const lsGrid = container.querySelector('#settings-landscape-layouts')
  lsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-layout]')
    if (!btn) return
    setLandscapeLayout(btn.dataset.layout)
    lsGrid.querySelectorAll('.settings-landscape-btn').forEach(b => {
      b.classList.toggle('is-active', b.dataset.layout === btn.dataset.layout)
    })
  })

  renderSyncSettings()

  // Contact form handler
  const form = container.querySelector('#contact-form')
  const statusEl = container.querySelector('#contact-status')
  const submitBtn = container.querySelector('#contact-submit')

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    statusEl.textContent = ''
    statusEl.className = 'contact-status'
    submitBtn.disabled = true
    submitBtn.textContent = 'Sending...'

    const name = form.querySelector('#contact-name').value.trim()
    const email = form.querySelector('#contact-email').value.trim()
    const message = form.querySelector('#contact-message').value.trim()
    const website = form.querySelector('#contact-website').value

    try {
      const response = await fetch(apiUrl('/api/contact'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message, website, _ts: formTs }),
      })
      const payload = await response.json()

      if (!response.ok) {
        statusEl.textContent = payload.error || 'Failed to send. Please try again.'
        statusEl.className = 'contact-status contact-status-error'
        submitBtn.disabled = false
        submitBtn.textContent = 'Send Message'
        return
      }

      statusEl.textContent = payload.message || 'Message sent!'
      statusEl.className = 'contact-status contact-status-ok'
      form.reset()
      submitBtn.textContent = 'Sent'
    } catch {
      statusEl.textContent = 'Network error. Please try again.'
      statusEl.className = 'contact-status contact-status-error'
      submitBtn.disabled = false
      submitBtn.textContent = 'Send Message'
    }
  })

  settingsRendered = true
}

function renderSyncSettings() {
  const syncEl = document.querySelector('#settings-sync-content')
  if (!syncEl) return

  const enabled = isSyncEnabled()
  const code = getShareCode()

  if (enabled && code) {
    const currentName = getProfileName()
    syncEl.innerHTML = `
      <div class="sync-field">
        <label class="sync-field-label" for="sync-profile-name">Profile Name</label>
        <input type="text" id="sync-profile-name" class="sync-name-input" maxlength="30" placeholder="Anonymous" value="${currentName.replace(/"/g, '&quot;')}" autocomplete="off" spellcheck="false" />
      </div>
      <p class="sync-description">Your sync code:</p>
      <div class="sync-code-display">
        <span class="sync-code-value">${code}</span>
        <button type="button" id="sync-copy-btn" class="sync-copy-btn" title="Copy code">Copy</button>
      </div>
      <p class="sync-hint">Enter this code on another device to sync your progress.</p>
      <div id="sync-status-msg" class="sync-status"></div>
      <button type="button" id="sync-disable-btn" class="sync-disable-btn">Disable Sync</button>
    `

    const nameInput = syncEl.querySelector('#sync-profile-name')
    let nameTimeout = null
    nameInput.addEventListener('input', () => {
      clearTimeout(nameTimeout)
      nameTimeout = setTimeout(() => {
        setProfileName(nameInput.value)
      }, 400)
    })

    syncEl.querySelector('#sync-copy-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code)
        const btn = syncEl.querySelector('#sync-copy-btn')
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = 'Copy' }, 2000)
      } catch {
        // fallback
      }
    })

    syncEl.querySelector('#sync-disable-btn').addEventListener('click', () => {
      disableSync()
      renderSyncSettings()
    })
  } else {
    syncEl.innerHTML = `
      <p class="sync-description">Play on multiple devices by syncing your progress.</p>
      <button type="button" id="sync-enable-btn" class="sync-enable-btn">Enable Sync</button>
      <div class="sync-divider">or</div>
      <p class="sync-description">Already have a code from another device?</p>
      <div class="sync-link-row">
        <input type="text" id="sync-code-input" class="sync-code-input" maxlength="6" placeholder="Enter code" autocomplete="off" autocapitalize="characters" spellcheck="false" />
        <button type="button" id="sync-link-btn" class="sync-link-btn">Link</button>
      </div>
      <div id="sync-status-msg" class="sync-status"></div>
    `

    const statusEl = syncEl.querySelector('#sync-status-msg')

    syncEl.querySelector('#sync-enable-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      btn.textContent = 'Enabling...'
      statusEl.textContent = ''
      statusEl.className = 'sync-status'

      try {
        const shareCode = await enableSync(playerGuid)
        renderSyncSettings()
      } catch (err) {
        statusEl.textContent = err.message || 'Failed to enable sync.'
        statusEl.className = 'sync-status sync-status-error'
        btn.disabled = false
        btn.textContent = 'Enable Sync'
      }
    })

    syncEl.querySelector('#sync-link-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget
      const input = syncEl.querySelector('#sync-code-input')
      const code = (input.value || '').trim().toUpperCase()
      statusEl.textContent = ''
      statusEl.className = 'sync-status'

      if (code.length !== 6) {
        statusEl.textContent = 'Code must be 6 characters.'
        statusEl.className = 'sync-status sync-status-error'
        return
      }

      btn.disabled = true
      btn.textContent = 'Linking...'

      try {
        await linkSync(code)
        renderSyncSettings()
        statusEl.textContent = 'Linked! Progress synced from the other device.'
        statusEl.className = 'sync-status sync-status-ok'
      } catch (err) {
        statusEl.textContent = err.message || 'Failed to link.'
        statusEl.className = 'sync-status sync-status-error'
        btn.disabled = false
        btn.textContent = 'Link'
      }
    })

    // Auto-uppercase input
    const input = syncEl.querySelector('#sync-code-input')
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase()
    })
  }
}

// ─── Sync initialization (must complete before rendering so pulled state is visible) ───

await Promise.race([initSync(), new Promise((r) => setTimeout(r, 3000))])

initAppShell()

onConflict(() => {
  showSyncConflictModal()
})

function showSyncConflictModal() {
  const existing = document.querySelector('#sync-conflict-modal')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.id = 'sync-conflict-modal'
  overlay.className = 'sync-conflict-overlay'
  overlay.innerHTML = `
    <div class="sync-conflict-dialog">
      <h3 class="sync-conflict-title">Sync Conflict</h3>
      <p class="sync-conflict-text">Your progress was updated on another device. Which version would you like to keep?</p>
      <div class="sync-conflict-actions">
        <button type="button" class="sync-conflict-btn sync-conflict-btn-local" id="sync-keep-local">Keep This Device</button>
        <button type="button" class="sync-conflict-btn sync-conflict-btn-remote" id="sync-use-remote">Use Other Device</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  overlay.querySelector('#sync-keep-local').addEventListener('click', async () => {
    await resolveConflict('local')
    overlay.remove()
  })

  overlay.querySelector('#sync-use-remote').addEventListener('click', async () => {
    await resolveConflict('remote')
    overlay.remove()
    if (typeof window.switchToPage === 'function') {
      window.switchToPage('play')
    }
  })
}

// ─── Service Worker Registration ───

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

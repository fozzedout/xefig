import './style.css'
import sampleImage from './assets/hero.png'
import { JigsawPuzzle } from './components/jigsaw-puzzle.js'
import { SlidingTilePuzzle } from './components/sliding-tile-puzzle.js'
import { PictureSwapPuzzle } from './components/picture-swap-puzzle.js'
import { PolygramPuzzle } from './components/polygram-puzzle.js'

const app = document.querySelector('#app')
const API_BASE = ''
const PLAYER_GUID_KEY = 'xefig:player-guid:v1'
const ACTIVE_RUN_KEY = 'xefig:jigsaw:active-run:v1'
const COMPLETED_RUNS_KEY = 'xefig:puzzles:completed:v1'
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

async function fetchPuzzlePayload({ date = null } = {}) {
  const endpoint = date ? `/api/puzzles/${encodeURIComponent(date)}` : '/api/puzzles/today'
  const response = await fetch(apiUrl(endpoint))
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload.error || 'Puzzle not found.')
  }
  return payload
}

function renderLauncher() {
  destroyPuzzle()

  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'today'
  state.archiveDate = todayDate
  state.gameMode = getGameModeOfDay(todayDate)
  state.difficulty = state.difficulty || 'medium'

  const renderModeCards = (puzzlePayload) => {
    const puzzleDate = puzzlePayload?.date || todayDate
    const completedModes = getCompletedModesForDate(puzzleDate)
    return [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]
      .map((mode) => {
        const imageUrl = resolvePuzzleThumbnailUrl(puzzlePayload, mode)
        const title = MODE_LABELS[mode]
        const isPick = mode === getGameModeOfDay(todayDate)
        const isCompleted = completedModes.has(mode)
        const hasSave = hasActiveRun(puzzleDate, mode)
        const entry = isCompleted ? getCompletionEntry(puzzleDate, mode) : null
        const badges = []
        if (isPick) {
          badges.push('<span class="mode-card-badge mode-card-badge-pick">Daily Pick</span>')
        }
        if (isCompleted) {
          const timeLabel = entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : ''
          badges.push(`<span class="mode-card-badge mode-card-badge-completed">\u2713 ${timeLabel}</span>`)
        }
        if (hasSave) {
          badges.push('<span class="mode-card-badge mode-card-badge-save">\u25B6 Resume</span>')
        }
        const badgeMarkup = badges.join('')

        return `
          <button type="button" class="mode-card" data-mode="${mode}">
            ${badgeMarkup}
            <div class="mode-card-image-wrapper">
              <img class="mode-card-image" src="${imageUrl}" alt="${title} preview" />
              <div class="mode-card-play-overlay">
                <div class="play-icon">
                  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
            </div>
            <div class="mode-card-info">
              <span class="mode-card-title">${title}</span>
            </div>
          </button>
        `
      })
      .join('')
  }

  app.innerHTML = `
    <main class="launcher-shell">
      <section class="launcher-main">
        <header class="launcher-header">
          <p class="eyebrow">Xefig Daily</p>
          <h1>Pick a Puzzle</h1>
          <p id="preview-meta" class="launcher-copy">Loading today's puzzle...</p>
        </header>

        <div id="mode-cards" class="mode-cards-grid">
          <div class="mode-card-skeleton" style="grid-column: 1/-1; padding: 2rem; text-align: center; color: var(--muted);">
            Loading puzzles...
          </div>
        </div>

        <footer class="launcher-footer">
          <button id="archive-nav-btn" class="launcher-secondary-btn" type="button">Browse Archive</button>
        </footer>
      </section>
    </main>
  `

  const modeCardsContainer = document.querySelector('#mode-cards')
  const previewMeta = document.querySelector('#preview-meta')
  const archiveNavBtn = document.querySelector('#archive-nav-btn')

  const handleModeCardClick = (mode, puzzleDate) => {
    state.gameMode = normalizeGameMode(mode)
    state.imageUrl = resolvePuzzleImageUrl(state.puzzle, state.gameMode)

    // Check for existing save
    const savedRun = getRunForMode(puzzleDate, state.gameMode)
    if (savedRun) {
      state.imageUrl = resolveAssetUrl(savedRun.imageUrl)
      renderGame({ resumeRun: savedRun })
      return
    }

    // Check if completed at this difficulty — show completed state
    const completedModes = getCompletedModesForDate(puzzleDate)
    if (completedModes.has(state.gameMode)) {
      const entry = getCompletionEntry(puzzleDate, state.gameMode)
      showCompletedPuzzleScreen({
        gameMode: state.gameMode,
        puzzleDate,
        entry,
        onReplay: () => renderGame(),
        onBack: () => renderLauncher(),
      })
      return
    }

    renderGame()
  }

  const bindModeEvents = () => {
    const cards = modeCardsContainer.querySelectorAll('.mode-card')
    for (const card of cards) {
      card.addEventListener('click', () => {
        const puzzleDate = state.puzzle?.date || todayDate
        handleModeCardClick(card.dataset.mode, puzzleDate)
      })
    }
  }

  archiveNavBtn.addEventListener('click', () => {
    renderArchiveLauncher()
  })

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
      previewMeta.textContent = `${payload.date}`
      modeCardsContainer.innerHTML = renderModeCards(payload)
      bindModeEvents()
    } catch (error) {
      previewMeta.textContent = error.message || 'Unable to load daily puzzle.'
      modeCardsContainer.innerHTML = `
        <div style="grid-column: 1/-1; padding: 2rem; text-align: center; color: var(--error);">
          Failed to load today's puzzles.
        </div>
      `
    }
  })()
}

function renderArchiveLauncher() {
  destroyPuzzle()

  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'archive'
  state.archiveDate = state.archiveDate || todayDate
  state.gameMode = normalizeGameMode(state.gameMode || getGameModeOfDay(state.archiveDate))
  state.difficulty = state.difficulty || 'medium'

  const renderModeCards = (puzzlePayload) => {
    const puzzleDate = puzzlePayload?.date || state.archiveDate
    const completedModes = getCompletedModesForDate(puzzleDate)
    return [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]
      .map((mode) => {
        const imageUrl = resolvePuzzleThumbnailUrl(puzzlePayload, mode)
        const title = MODE_LABELS[mode]
        const isCompleted = completedModes.has(mode)
        const hasSave = hasActiveRun(puzzleDate, mode)
        const entry = isCompleted ? getCompletionEntry(puzzleDate, mode) : null
        const badges = []
        if (isCompleted) {
          badges.push(`<span class="mode-card-badge mode-card-badge-completed">\u2713 ${entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : ''}</span>`)
        }
        if (hasSave) {
          badges.push('<span class="mode-card-badge mode-card-badge-save">\u25B6 Resume</span>')
        }
        const badgeMarkup = badges.join('')
        return `
          <button type="button" class="mode-card" data-mode="${mode}">
            ${badgeMarkup}
            <div class="mode-card-image-wrapper">
              <img class="mode-card-image" src="${imageUrl}" alt="${title} preview" />
              <div class="mode-card-play-overlay">
                <div class="play-icon">
                  <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </div>
              </div>
            </div>
            <div class="mode-card-info">
              <span class="mode-card-title">${title}</span>
            </div>
          </button>
        `
      })
      .join('')
  }

  app.innerHTML = `
    <main class="launcher-shell">
      <section class="launcher-main">
        <header class="launcher-header">
          <p class="eyebrow">Archive Mode</p>
          <h1>Pick Any Day</h1>
          <p id="archive-preview-meta" class="launcher-copy">Select a date to load a puzzle.</p>
        </header>

        <div class="archive-date-row">
          <button id="archive-prev-btn" class="archive-nav-arrow" type="button" aria-label="Previous day">&lsaquo;</button>
          <input id="archive-date-input" type="date" value="${state.archiveDate}" min="2026-03-17" max="${todayDate}" class="archive-date-input" />
          <button id="archive-next-btn" class="archive-nav-arrow" type="button" aria-label="Next day">&rsaquo;</button>
        </div>

        <div id="archive-mode-cards" class="mode-cards-grid">
           <div style="grid-column: 1/-1; padding: 2rem; text-align: center; color: var(--muted);">
            Select a date to see puzzles...
          </div>
        </div>

        <footer class="launcher-footer">
          <button id="archive-back-btn" class="launcher-secondary-btn" type="button">Back To Daily</button>
        </footer>
      </section>
    </main>
  `

  const dateInput = document.querySelector('#archive-date-input')
  const previewMeta = document.querySelector('#archive-preview-meta')
  const modeCardsContainer = document.querySelector('#archive-mode-cards')
  const prevBtn = document.querySelector('#archive-prev-btn')
  const nextBtn = document.querySelector('#archive-next-btn')
  const backBtn = document.querySelector('#archive-back-btn')

  function addDays(dateKey, n) {
    return new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
  }

  prevBtn.addEventListener('click', () => {
    const prev = addDays(state.archiveDate, -1)
    if (prev < '2026-03-17') return
    state.archiveDate = prev
    dateInput.value = state.archiveDate
    loadArchivePreview()
  })

  nextBtn.addEventListener('click', () => {
    const next = addDays(state.archiveDate, 1)
    if (next > todayDate) return
    state.archiveDate = next
    dateInput.value = state.archiveDate
    loadArchivePreview()
  })

  const handleArchiveModeCardClick = (mode, puzzleDate) => {
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
        onBack: () => renderArchiveLauncher(),
      })
      return
    }

    renderGame()
  }

  const bindModeEvents = () => {
    const cards = modeCardsContainer.querySelectorAll('.mode-card')
    for (const card of cards) {
      card.addEventListener('click', () => {
        const puzzleDate = state.puzzle?.date || state.archiveDate
        handleArchiveModeCardClick(card.dataset.mode, puzzleDate)
      })
    }
  }

  const loadArchivePreview = async () => {
    if (!dateInput.value) {
      previewMeta.textContent = 'Choose an archive date.'
      return
    }

    state.archiveDate = dateInput.value
    previewMeta.textContent = 'Loading archive puzzle...'

    try {
      const payload = await fetchPuzzlePayload({ date: state.archiveDate })
      state.puzzle = payload
      previewMeta.textContent = `${payload.date}`
      modeCardsContainer.innerHTML = renderModeCards(payload)
      bindModeEvents()
    } catch (error) {
      state.puzzle = null
      previewMeta.textContent = error.message || 'Unable to load archive puzzle.'
      modeCardsContainer.innerHTML = `
        <div style="grid-column: 1/-1; padding: 2rem; text-align: center; color: var(--error);">
          Failed to load archive puzzles.
        </div>
      `
    }
  }

  dateInput.addEventListener('change', loadArchivePreview)
  backBtn.addEventListener('click', () => {
    renderLauncher()
  })

  loadArchivePreview()
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

  app.innerHTML = `
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

  app.innerHTML = `
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
          ${gameMode === GAME_MODE_JIGSAW ? `
          <button id="settings-btn" class="toolbar-btn icon-btn" type="button" aria-label="Puzzle settings" title="Settings">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19.14 12.94a7.07 7.07 0 0 0 .06-.94c0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.3.59.22l2.39-.96c.49.37 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61ZM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2Z" />
            </svg>
          </button>
          ` : ''}
        </div>
      </header>

      <section class="workspace">
        <div id="puzzle-mount" class="puzzle-mount"></div>
      </section>
    </main>

    ${gameMode === GAME_MODE_JIGSAW ? `
    <div id="settings-modal" class="settings-overlay" hidden>
      <div class="settings-panel">
        <div class="settings-header">
          <span class="settings-title">Settings</span>
          <button id="settings-close-btn" class="toolbar-btn icon-btn" type="button" aria-label="Close settings">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div class="settings-body">
          <label class="settings-label">Board background</label>
          <div id="board-color-options" class="board-color-options"></div>
        </div>
      </div>
    </div>
    ` : ''}
  `

  const statusEl = document.querySelector('#status')
  const mount = document.querySelector('#puzzle-mount')
  const backBtn = document.querySelector('#back-btn')
  const viewBtn = document.querySelector('#view-btn')

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
    if (state.sourceMode === 'archive') {
      renderArchiveLauncher()
    } else {
      renderLauncher()
    }
  })

  viewBtn.addEventListener('click', () => {
    if (!puzzle) {
      return
    }

    const active = puzzle.toggleReferenceVisible()
    viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
  })

  const restartBtn = document.querySelector('#restart-btn')
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

  const highlightBtn = document.querySelector('#highlight-btn')
  const edgesBtn = document.querySelector('#edges-btn')
  const settingsBtn = document.querySelector('#settings-btn')
  const settingsModal = document.querySelector('#settings-modal')
  const settingsCloseBtn = document.querySelector('#settings-close-btn')
  const boardColorOptions = document.querySelector('#board-color-options')

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

  const renderBoardColorOptions = () => {
    if (!boardColorOptions || !puzzle) return
    const options = puzzle.getBoardColorOptions()
    boardColorOptions.innerHTML = options
      .map(
        (opt, i) =>
          `<button class="board-color-swatch${opt.active ? ' is-active' : ''}" type="button" data-index="${i}" aria-label="${opt.name}" title="${opt.name}"${opt.color ? ` style="background:${opt.color}"` : ''}>${opt.color ? '' : '🖼'}</button>`,
      )
      .join('')
  }

  if (boardColorOptions) {
    boardColorOptions.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-index]')
      if (!btn || !puzzle) return
      puzzle.setBoardColorIndex(Number(btn.dataset.index))
      renderBoardColorOptions()
    })
  }

  const openSettings = () => {
    if (!settingsModal) return
    renderBoardColorOptions()
    settingsModal.hidden = false
  }

  const closeSettings = () => {
    if (!settingsModal) return
    settingsModal.hidden = true
  }

  if (settingsBtn) {
    settingsBtn.addEventListener('click', openSettings)
  }

  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener('click', closeSettings)
  }

  if (settingsModal) {
    settingsModal.addEventListener('click', (event) => {
      if (event.target === settingsModal) closeSettings()
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

      const PuzzleClass =
        gameMode === GAME_MODE_SLIDING
          ? SlidingTilePuzzle
          : gameMode === GAME_MODE_SWAP
            ? PictureSwapPuzzle
            : gameMode === GAME_MODE_POLYGRAM
              ? PolygramPuzzle
            : JigsawPuzzle
      const puzzleConfig = {
        container: mount,
        imageUrl: state.imageUrl,
        difficulty: state.difficulty,
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

renderLauncher()

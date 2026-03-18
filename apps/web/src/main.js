import './style.css'
import sampleImage from './assets/hero.png'
import { JigsawPuzzle } from './components/jigsaw-puzzle.js'
import { SlidingTilePuzzle } from './components/sliding-tile-puzzle.js'
import { PictureSwapPuzzle } from './components/picture-swap-puzzle.js'
import { PolygramPuzzle } from './components/polygram-puzzle.js'

const app = document.querySelector('#app')
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:8787' : ''
const PLAYER_GUID_KEY = 'xefig:player-guid:v1'
const ACTIVE_RUN_KEY = 'xefig:jigsaw:active-run:v1'
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
const DIFFICULTY_BUTTON_LABELS = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  extreme: 'Extreme',
}
const MODE_LABELS = {
  [GAME_MODE_JIGSAW]: 'Jigsaw',
  [GAME_MODE_SLIDING]: 'Sliding Tile',
  [GAME_MODE_SWAP]: 'Picture Swap',
  [GAME_MODE_POLYGRAM]: 'Polygram',
}
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard', 'extreme']
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
  writeJsonStorage(ACTIVE_RUN_KEY, nextRun)
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

  const resumableRun = getResumableRun()
  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'today'
  state.archiveDate = todayDate
  state.gameMode = getGameModeOfDay(todayDate)
  state.difficulty = state.difficulty || 'medium'

  const renderDifficultyOptions = (selected) => {
    return DIFFICULTY_ORDER
      .map((d) => {
        const isSelected = d === selected ? ' is-selected' : ''
        const label = DIFFICULTY_BUTTON_LABELS[d] || d
        return `<button type="button" class="difficulty-option${isSelected}" data-difficulty="${d}">${label}</button>`
      })
      .join('')
  }

  const renderModeCards = (puzzlePayload) => {
    return [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]
      .map((mode) => {
        const imageUrl = resolvePuzzleImageUrl(puzzlePayload, mode)
        const title = MODE_LABELS[mode]
        const isPick = mode === getGameModeOfDay(todayDate)
        const badge = isPick ? '<span class="mode-card-badge">Daily Pick</span>' : ''

        return `
          <button type="button" class="mode-card" data-mode="${mode}">
            ${badge}
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

        <section class="choice-group">
          <p class="choice-heading">Difficulty</p>
          <div id="difficulty-segmented" class="difficulty-segmented">
            ${renderDifficultyOptions(state.difficulty)}
          </div>
        </section>

        <div id="mode-cards" class="mode-cards-grid">
          <div class="mode-card-skeleton" style="grid-column: 1/-1; padding: 2rem; text-align: center; color: var(--muted);">
            Loading puzzles...
          </div>
        </div>

        <footer class="launcher-footer">
          ${resumableRun ? '<button id="resume-btn" class="launcher-secondary-btn" type="button">Resume Last Run</button>' : ''}
          <button id="archive-nav-btn" class="launcher-secondary-btn" type="button">Browse Archive</button>
        </footer>
      </section>
    </main>
  `

  const modeCardsContainer = document.querySelector('#mode-cards')
  const difficultySegmented = document.querySelector('#difficulty-segmented')
  const previewMeta = document.querySelector('#preview-meta')
  const archiveNavBtn = document.querySelector('#archive-nav-btn')
  const resumeBtn = document.querySelector('#resume-btn')

  const bindDifficultyEvents = () => {
    const buttons = difficultySegmented.querySelectorAll('[data-difficulty]')
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        state.difficulty = btn.dataset.difficulty
        difficultySegmented.innerHTML = renderDifficultyOptions(state.difficulty)
        bindDifficultyEvents()
      })
    }
  }

  const bindModeEvents = () => {
    const cards = modeCardsContainer.querySelectorAll('.mode-card')
    for (const card of cards) {
      card.addEventListener('click', () => {
        state.gameMode = normalizeGameMode(card.dataset.mode)
        state.imageUrl = resolvePuzzleImageUrl(state.puzzle, state.gameMode)
        renderGame()
      })
    }
  }

  archiveNavBtn.addEventListener('click', () => {
    renderArchiveLauncher()
  })

  if (resumeBtn && resumableRun) {
    resumeBtn.addEventListener('click', () => {
      state.gameMode = normalizeGameMode(resumableRun.gameMode)
      state.difficulty = resumableRun.difficulty
      state.imageUrl = resolveAssetUrl(resumableRun.imageUrl)
      state.puzzle = {
        date: resumableRun.puzzleDate,
      }
      renderGame({ resumeRun: resumableRun })
    })
  }

  bindDifficultyEvents()

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

  const renderDifficultyOptions = (selected) => {
    return DIFFICULTY_ORDER
      .map((d) => {
        const isSelected = d === selected ? ' is-selected' : ''
        const label = DIFFICULTY_BUTTON_LABELS[d] || d
        return `<button type="button" class="difficulty-option${isSelected}" data-difficulty="${d}">${label}</button>`
      })
      .join('')
  }

  const renderModeCards = (puzzlePayload) => {
    return [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM]
      .map((mode) => {
        const imageUrl = resolvePuzzleImageUrl(puzzlePayload, mode)
        const title = MODE_LABELS[mode]
        return `
          <button type="button" class="mode-card" data-mode="${mode}">
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

        <label class="archive-date-label">
          Archive Date
          <input id="archive-date-input" type="date" value="${state.archiveDate}" max="${todayDate}" />
        </label>

        <section class="choice-group">
          <p class="choice-heading">Difficulty</p>
          <div id="archive-difficulty-segmented" class="difficulty-segmented">
            ${renderDifficultyOptions(state.difficulty)}
          </div>
        </section>

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
  const difficultySegmented = document.querySelector('#archive-difficulty-segmented')
  const backBtn = document.querySelector('#archive-back-btn')

  const bindDifficultyEvents = () => {
    const buttons = difficultySegmented.querySelectorAll('[data-difficulty]')
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        state.difficulty = btn.dataset.difficulty
        difficultySegmented.innerHTML = renderDifficultyOptions(state.difficulty)
        bindDifficultyEvents()
      })
    }
  }

  const bindModeEvents = () => {
    const cards = modeCardsContainer.querySelectorAll('.mode-card')
    for (const card of cards) {
      card.addEventListener('click', () => {
        state.gameMode = normalizeGameMode(card.dataset.mode)
        state.imageUrl = resolvePuzzleImageUrl(state.puzzle, state.gameMode)
        renderGame()
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

  bindDifficultyEvents()
  loadArchivePreview()
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
          <button id="view-btn" class="toolbar-btn icon-btn" type="button" aria-label="Toggle reference image" aria-pressed="false">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z" />
            </svg>
          </button>
          <button id="reset-view-btn" class="toolbar-btn" type="button">Reset View</button>
        </div>
      </header>

      <section class="workspace">
        <div id="puzzle-mount" class="puzzle-mount"></div>
      </section>
    </main>
  `

  const statusEl = document.querySelector('#status')
  const mount = document.querySelector('#puzzle-mount')
  const backBtn = document.querySelector('#back-btn')
  const viewBtn = document.querySelector('#view-btn')
  const resetViewBtn = document.querySelector('#reset-view-btn')

  const setStatus = (message, variant = '') => {
    statusEl.textContent = message
    statusEl.className = `status toolbar-status ${variant}`.trim()
  }

  let leaderboardDone = false

  backBtn.addEventListener('click', () => {
    persistActiveRun()
    renderLauncher()
  })

  viewBtn.addEventListener('click', () => {
    if (!puzzle) {
      return
    }

    const active = puzzle.toggleReferenceVisible()
    viewBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
  })

  resetViewBtn.addEventListener('click', () => {
    puzzle?.resetView()
  })

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
          writeJsonStorage(ACTIVE_RUN_KEY, currentRun)
          removeStorage(ACTIVE_RUN_KEY)

          const durationLabel = formatDuration(currentRun.elapsedActiveMs)

          setStatus(
            `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Submitting leaderboard...`,
            'ok',
          )

          try {
            const result = await submitLeaderboard(currentRun)
            setStatus(
              `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Rank #${result.rank} on ${result.difficulty}.`,
              'ok',
            )
          } catch (error) {
            setStatus(
              `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Leaderboard submit failed.`,
              'error',
            )
          }
        },
      }

      if (gameMode === GAME_MODE_JIGSAW) {
        puzzleConfig.snapDistance = 10
      }

      puzzle = new PuzzleClass(puzzleConfig)

      await puzzle.init()

      if (resumeRun?.puzzleState) {
        puzzle.applyProgressState(resumeRun.puzzleState)
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

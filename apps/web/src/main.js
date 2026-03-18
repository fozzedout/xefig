import './style.css'
import sampleImage from './assets/hero.png'
import { JigsawPuzzle } from './components/jigsaw-puzzle.js'

const app = document.querySelector('#app')
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:8787' : ''
const PLAYER_GUID_KEY = 'xefig:player-guid:v1'
const ACTIVE_RUN_KEY = 'xefig:jigsaw:active-run:v1'

const state = {
  imageUrl: sampleImage,
  difficulty: 'easy',
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

function getInteractionHint() {
  const isLandscapeDesktop = window.innerWidth >= 1024 && window.innerWidth > window.innerHeight
  return isLandscapeDesktop
    ? 'Scroll the right tray and drag pieces onto the board.'
    : 'Swipe tray left/right. Drag up on a piece to pick it up.'
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
  return run
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

function renderLauncher() {
  destroyPuzzle()

  const resumableRun = getResumableRun()

  app.innerHTML = `
    <main class="launcher-shell">
      <section class="launcher-main">
        <p class="eyebrow">Puzzle Launcher</p>
        <h1>Jigsaw</h1>
        <p class="launcher-copy">Choose current day or archive day, then launch game mode.</p>

        <img id="preview-image" class="preview-image" src="${state.imageUrl}" alt="Puzzle preview" />
        <p id="preview-meta" class="launcher-copy">Loading puzzle preview...</p>

        <form id="launcher-form" class="launcher-form">
          <label>
            Puzzle Day
            <select id="source-mode" ${resumableRun ? 'disabled' : ''}>
              <option value="today" ${state.sourceMode === 'today' ? 'selected' : ''}>Current Day</option>
              <option value="archive" ${state.sourceMode === 'archive' ? 'selected' : ''}>Archived Day</option>
            </select>
          </label>

          <label>
            Archive Date
            <input id="archive-date" type="date" value="${state.archiveDate}" ${state.sourceMode === 'today' || resumableRun ? 'disabled' : ''} />
          </label>

          <label>
            Difficulty
            <select id="difficulty" ${resumableRun ? 'disabled' : ''}>
              <option value="easy" ${state.difficulty === 'easy' ? 'selected' : ''}>Easy (8x8)</option>
              <option value="medium" ${state.difficulty === 'medium' ? 'selected' : ''}>Medium (10x10)</option>
              <option value="hard" ${state.difficulty === 'hard' ? 'selected' : ''}>Hard (12x12)</option>
              <option value="extreme" ${state.difficulty === 'extreme' ? 'selected' : ''}>Extreme (15x15)</option>
            </select>
          </label>

          <button id="start-btn" type="submit" disabled>${resumableRun ? 'Resume Puzzle' : 'Start Jigsaw'}</button>
        </form>
      </section>
    </main>
  `

  const sourceMode = document.querySelector('#source-mode')
  const archiveDate = document.querySelector('#archive-date')
  const difficultyInput = document.querySelector('#difficulty')
  const startBtn = document.querySelector('#start-btn')
  const previewImage = document.querySelector('#preview-image')
  const previewMeta = document.querySelector('#preview-meta')
  const form = document.querySelector('#launcher-form')

  let requestId = 0

  const setLoading = (message) => {
    previewMeta.textContent = message
    startBtn.disabled = true
  }

  const refreshPreview = async () => {
    const currentRequest = ++requestId

    state.sourceMode = sourceMode.value
    state.archiveDate = archiveDate.value || state.archiveDate
    state.difficulty = difficultyInput.value

    archiveDate.disabled = state.sourceMode === 'today' || Boolean(resumableRun)

    if (resumableRun) {
      state.difficulty = resumableRun.difficulty
      state.imageUrl = resolveAssetUrl(resumableRun.imageUrl)
      state.puzzle = {
        date: resumableRun.puzzleDate,
        theme: resumableRun.theme || 'Resumable Puzzle',
      }
      previewImage.src = state.imageUrl
      previewMeta.textContent = `Resume ${resumableRun.puzzleDate} · ${resumableRun.theme || 'Saved run'} · ${resumableRun.difficulty}`
      startBtn.disabled = false
      return
    }

    const targetDate = state.sourceMode === 'today' ? null : archiveDate.value
    if (state.sourceMode === 'archive' && !targetDate) {
      setLoading('Pick an archive date to load the puzzle.')
      return
    }

    setLoading('Loading puzzle preview...')

    try {
      const endpoint =
        state.sourceMode === 'today'
          ? '/api/puzzles/today'
          : `/api/puzzles/${encodeURIComponent(targetDate)}`

      const response = await fetch(apiUrl(endpoint))
      const payload = await response.json()

      if (currentRequest !== requestId) {
        return
      }

      if (!response.ok) {
        throw new Error(payload.error || 'Puzzle not found for selected date.')
      }

      state.puzzle = payload
      state.imageUrl = resolveAssetUrl(payload.categories?.jigsaw?.imageUrl)

      previewImage.src = state.imageUrl
      previewMeta.textContent = `${payload.date} · ${payload.theme}`
      startBtn.disabled = false
    } catch (error) {
      if (currentRequest !== requestId) {
        return
      }

      state.puzzle = null
      previewImage.src = sampleImage
      previewMeta.textContent = error.message || 'Unable to load puzzle preview.'
      startBtn.disabled = true
    }
  }

  sourceMode.addEventListener('change', refreshPreview)
  archiveDate.addEventListener('change', refreshPreview)
  difficultyInput.addEventListener('change', () => {
    state.difficulty = difficultyInput.value
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (startBtn.disabled) {
      return
    }

    const run = getResumableRun()
    if (run) {
      state.difficulty = run.difficulty
      state.imageUrl = resolveAssetUrl(run.imageUrl)
      state.puzzle = {
        date: run.puzzleDate,
        theme: run.theme || 'Saved run',
      }
      renderGame({ resumeRun: run })
      return
    }

    state.difficulty = difficultyInput.value
    renderGame()
  })

  refreshPreview()
}

function renderGame({ resumeRun = null } = {}) {
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
        state.difficulty = resumeRun.difficulty || state.difficulty
        state.imageUrl = resolveAssetUrl(resumeRun.imageUrl || state.imageUrl)
        state.puzzle = {
          date: resumeRun.puzzleDate,
          theme: resumeRun.theme || 'Saved run',
        }
        currentRun = { ...resumeRun }
      } else {
        currentRun = {
          version: 1,
          runId: createGuid(),
          playerGuid,
          puzzleDate: state.puzzle?.date || getIsoDate(new Date()),
          theme: state.puzzle?.theme || 'Daily Puzzle',
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

      puzzle = new JigsawPuzzle({
        container: mount,
        imageUrl: state.imageUrl,
        difficulty: state.difficulty,
        snapDistance: 10,
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
          setStatus(`Completed in ${durationLabel}. Submitting leaderboard...`, 'ok')

          try {
            const result = await submitLeaderboard(currentRun)
            setStatus(
              `Completed in ${durationLabel}. Rank #${result.rank} on ${result.difficulty}.`,
              'ok',
            )
          } catch (error) {
            setStatus(`Completed in ${durationLabel}. Leaderboard submit failed.`, 'error')
          }
        },
      })

      await puzzle.init()

      if (resumeRun?.puzzleState) {
        puzzle.applyProgressState(resumeRun.puzzleState)
      }

      persistActiveRun(puzzle.getProgressState())

      const puzzleLabel = state.puzzle
        ? `${state.puzzle.date} · ${state.puzzle.theme}`
        : 'Puzzle ready'
      const elapsedLabel = formatDuration(getActiveElapsedMs())
      setStatus(`${puzzleLabel}. ${getInteractionHint()} Active ${elapsedLabel}.`, 'ok')
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

const resumableAtBoot = getResumableRun()
if (resumableAtBoot) {
  state.difficulty = resumableAtBoot.difficulty
  state.imageUrl = resolveAssetUrl(resumableAtBoot.imageUrl)
  state.puzzle = {
    date: resumableAtBoot.puzzleDate,
    theme: resumableAtBoot.theme || 'Saved run',
  }
  renderGame({ resumeRun: resumableAtBoot })
} else {
  renderLauncher()
}

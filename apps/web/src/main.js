import './style.css'
import sampleImage from './assets/hero.png'
import { JigsawPuzzle } from './components/jigsaw-puzzle.js'

const app = document.querySelector('#app')
const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:8787' : ''

const state = {
  imageUrl: sampleImage,
  difficulty: 'easy',
  sourceMode: 'today',
  archiveDate: getIsoDate(new Date()),
  puzzle: null,
}

let puzzle = null

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

function renderLauncher() {
  destroyPuzzle()

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
            <select id="source-mode">
              <option value="today" ${state.sourceMode === 'today' ? 'selected' : ''}>Current Day</option>
              <option value="archive" ${state.sourceMode === 'archive' ? 'selected' : ''}>Archived Day</option>
            </select>
          </label>

          <label>
            Archive Date
            <input id="archive-date" type="date" value="${state.archiveDate}" ${state.sourceMode === 'today' ? 'disabled' : ''} />
          </label>

          <label>
            Difficulty
            <select id="difficulty">
              <option value="easy" ${state.difficulty === 'easy' ? 'selected' : ''}>Easy (8x8)</option>
              <option value="medium" ${state.difficulty === 'medium' ? 'selected' : ''}>Medium (10x10)</option>
              <option value="hard" ${state.difficulty === 'hard' ? 'selected' : ''}>Hard (12x12)</option>
              <option value="extreme" ${state.difficulty === 'extreme' ? 'selected' : ''}>Extreme (15x15)</option>
            </select>
          </label>

          <button id="start-btn" type="submit" disabled>Start Jigsaw</button>
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

    archiveDate.disabled = state.sourceMode === 'today'

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

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (startBtn.disabled) {
      return
    }

    state.difficulty = difficultyInput.value
    renderGame()
  })

  refreshPreview()
}

function renderGame() {
  app.innerHTML = `
    <main class="game-shell">
      <header class="game-toolbar">
        <button id="back-btn" class="toolbar-btn back-btn" type="button" aria-label="Back to launcher">
          <span class="back-chevron">‹</span>
          <span>Back</span>
        </button>

        <div class="toolbar-actions">
          <button id="view-btn" class="toolbar-btn icon-btn" type="button" aria-label="Toggle reference image" aria-pressed="false">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z" />
            </svg>
          </button>
          <button id="reset-view-btn" class="toolbar-btn" type="button">Reset View</button>
        </div>
      </header>

      <p id="status" class="status">Loading puzzle...</p>

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
    statusEl.className = `status ${variant}`.trim()
  }

  backBtn.addEventListener('click', () => {
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
      puzzle = new JigsawPuzzle({
        container: mount,
        imageUrl: state.imageUrl,
        difficulty: state.difficulty,
        snapDistance: 10,
        onComplete: () => setStatus('Completed.', 'ok'),
      })

      await puzzle.init()

      const puzzleLabel = state.puzzle
        ? `${state.puzzle.date} · ${state.puzzle.theme}`
        : 'Puzzle ready'
      setStatus(`${puzzleLabel}. Swipe carousel left/right. Drag up on a piece to pick it up.`, 'ok')
    } catch (error) {
      console.error(error)
      setStatus('Failed to load puzzle image.', 'error')
    }
  })()
}

function destroyPuzzle() {
  if (puzzle) {
    puzzle.destroy()
    puzzle = null
  }
}

renderLauncher()

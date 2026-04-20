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
  pullOnForeground,
  onRemoteChanged,
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
// Beta build flag — Vite statically replaces import.meta.env.MODE at
// build time, so anything gated on BETA is tree-shaken from production
// bundles. Set by `vite build --mode beta` via the deploy:beta script.
const BETA = import.meta.env.MODE === 'beta'
if (BETA && typeof document !== 'undefined') {
  const badge = document.createElement('div')
  badge.className = 'beta-badge'
  badge.textContent = 'BETA'
  badge.title = 'Beta build — test-only features enabled, data isolated from live'
  document.body.appendChild(badge)
}
const API_BASE = ''
const PLAYER_GUID_KEY = 'xefig:player-guid:v1'
const ACTIVE_RUN_KEY = 'xefig:jigsaw:active-run:v1'
const COMPLETED_RUNS_KEY = 'xefig:puzzles:completed:v1'
const LAUNCHER_FOCUS_KEY = 'xefig:launcher:focus:v1'
// Lower bound on what a legit puzzle run looks like: nothing in the app
// is completable under a second, so anything below is a bug artifact.
const MIN_PLAUSIBLE_ELAPSED_MS = 1000
const BOARD_COLOR_KEY = 'xefig:board-color:v1'
const MUSIC_ENABLED_KEY = 'xefig:music-enabled:v1'
const MUSIC_VOLUME_KEY = 'xefig:music-volume:v1'
const MUSIC_DEFAULT_VOLUME = 0.35
const DAILY_PUZZLE_CACHE_KEY = 'xefig:daily-cache'
const EARLY_PUZZLE_WAIT_MS = 1500
const PUZZLE_FETCH_TIMEOUT_MS = 8000

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

function getMusicVolume() {
  const raw = localStorage.getItem(MUSIC_VOLUME_KEY)
  if (raw !== null) {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n
  }
  // Migrate legacy on/off key
  if (localStorage.getItem(MUSIC_ENABLED_KEY) === '1') return MUSIC_DEFAULT_VOLUME
  return 0
}

function setMusicVolume(v) {
  const clamped = Math.max(0, Math.min(1, v))
  localStorage.setItem(MUSIC_VOLUME_KEY, String(clamped))
}

function getMusicEnabled() {
  return getMusicVolume() > 0
}

function applyLandscapeLayout() {
  document.documentElement.classList.add('ls-default')
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
cleanupBadCompletedRuns()

const MUSIC_TRACKS = [
  '/music/evening-homecoming.mp3',
  '/music/weightless.mp3',
  '/music/fireside.mp3',
  '/music/morning-window.mp3',
  '/music/gentle-wandering.mp3',
  '/music/wool-sweater.mp3',
  '/music/village-lights.mp3',
  '/music/snow-globe.mp3',
  '/music/afternoon-tea.mp3',
  '/music/old-photographs.mp3',
  '/music/dusk.mp3',
  '/music/last-embers.mp3',
]

let musicAudio = null
let musicShouldPlay = false
let lastTrackIndex = -1
let nextTrackIndex = -1
let lastNonZeroVolume = getMusicVolume() || MUSIC_DEFAULT_VOLUME

// iOS Safari makes HTMLMediaElement.volume read-only. Route playback
// through a Web Audio GainNode so the slider actually attenuates on
// iPhone/iPad. All other platforms benefit too — gain is sample-accurate.
let audioContext = null
let audioGainNode = null
let audioSourceNode = null
let audioGraphFailed = false

function tryEnsureAudioGraph() {
  if (audioGainNode || audioGraphFailed) return audioGainNode
  if (!musicAudio) return null
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) { audioGraphFailed = true; return null }
    if (!audioContext) audioContext = new AC()
    if (!audioSourceNode) audioSourceNode = audioContext.createMediaElementSource(musicAudio)
    audioGainNode = audioContext.createGain()
    audioGainNode.gain.value = getMusicVolume()
    audioSourceNode.connect(audioGainNode)
    audioGainNode.connect(audioContext.destination)
    // Element output is now driven by the graph; keep it at full amplitude
    // so the GainNode is the sole attenuation stage (avoids double-attenuate
    // on browsers where setting element.volume still works).
    musicAudio.volume = 1
    return audioGainNode
  } catch (e) {
    audioGraphFailed = true
    return null
  }
}

function resumeAudioContextIfNeeded() {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {})
  }
}

function pickRandomTrackIndex(excluding) {
  if (MUSIC_TRACKS.length <= 1) return 0
  let i = excluding
  while (i === excluding) {
    i = Math.floor(Math.random() * MUSIC_TRACKS.length)
  }
  return i
}

function prefetchTrack(idx) {
  fetch(MUSIC_TRACKS[idx]).then((r) => r.arrayBuffer()).catch(() => {})
}

function ensureMusicAudio() {
  if (musicAudio) return musicAudio
  lastTrackIndex = pickRandomTrackIndex(-1)
  musicAudio = new Audio(MUSIC_TRACKS[lastTrackIndex])
  musicAudio.loop = false
  musicAudio.volume = getMusicVolume()
  musicAudio.preload = 'auto'
  nextTrackIndex = pickRandomTrackIndex(lastTrackIndex)
  prefetchTrack(nextTrackIndex)
  let recentEndedCount = 0
  let recentEndedTimer = null
  musicAudio.addEventListener('ended', () => {
    // Detect 'ended'-loops: iOS can fire spurious end events while the
    // Web Audio graph is warming up, and our src-swap + replay here would
    // cascade into a fraction-of-a-second stutter. Bail if we see too
    // many ends in a short window.
    recentEndedCount++
    if (recentEndedTimer) clearTimeout(recentEndedTimer)
    recentEndedTimer = setTimeout(() => { recentEndedCount = 0 }, 5000)
    if (recentEndedCount > 4) {
      musicShouldPlay = false
      return
    }
    // Guard against a single spurious end: if playback barely advanced
    // past the start, the element probably didn't actually finish.
    if (musicAudio.currentTime < 1) {
      if (musicShouldPlay) {
        setTimeout(() => musicAudio.play().catch(() => {}), 300)
      }
      return
    }
    lastTrackIndex = nextTrackIndex
    musicAudio.src = MUSIC_TRACKS[lastTrackIndex]
    if (musicShouldPlay) musicAudio.play().catch(() => {})
    nextTrackIndex = pickRandomTrackIndex(lastTrackIndex)
    prefetchTrack(nextTrackIndex)
  })
  return musicAudio
}

function applyMusicVolume() {
  const vol = getMusicVolume()
  if (vol > 0) {
    lastNonZeroVolume = vol
    musicShouldPlay = true
    const audio = ensureMusicAudio()
    const gain = tryEnsureAudioGraph()
    if (gain) {
      gain.gain.value = vol
    } else {
      audio.volume = vol
    }
    resumeAudioContextIfNeeded()
    audio.play().catch(() => {})
  } else {
    musicShouldPlay = false
    if (musicAudio) musicAudio.pause()
  }
}

function pauseMusicTemporary() {
  if (musicAudio && !musicAudio.paused) musicAudio.pause()
}

function resumeMusicIfEnabled() {
  if (!musicShouldPlay) return
  resumeAudioContextIfNeeded()
  ensureMusicAudio().play().catch(() => {})
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseMusicTemporary()
  } else {
    resumeMusicIfEnabled()
    pullOnForeground()
  }
})
window.addEventListener('blur', pauseMusicTemporary)
window.addEventListener('focus', () => {
  resumeMusicIfEnabled()
  pullOnForeground()
})

if (getMusicVolume() > 0) {
  musicShouldPlay = true
  const onFirstGesture = () => {
    const audio = ensureMusicAudio()
    const gain = tryEnsureAudioGraph()
    if (gain) {
      gain.gain.value = getMusicVolume()
    } else {
      audio.volume = getMusicVolume()
    }
    resumeAudioContextIfNeeded()
    audio.play().catch(() => {})
    document.removeEventListener('pointerdown', onFirstGesture)
    document.removeEventListener('keydown', onFirstGesture)
  }
  document.addEventListener('pointerdown', onFirstGesture, { once: true })
  document.addEventListener('keydown', onFirstGesture, { once: true })
}

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

function getLauncherFocus() {
  const raw = readJsonStorage(LAUNCHER_FOCUS_KEY)
  if (!raw || typeof raw !== 'object') return null
  if (raw.date !== getIsoDate(new Date())) return null
  const focus = raw.focus
  if (focus === 'more') return 'more'
  if ([GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND].includes(focus)) return focus
  return null
}

function setLauncherFocus(focus) {
  if (!focus) return
  writeJsonStorage(LAUNCHER_FOCUS_KEY, {
    date: getIsoDate(new Date()),
    focus,
  })
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

  const elapsedMs = Math.max(0, Number(run.elapsedActiveMs) || 0)
  // Floor at 1 second — no puzzle mode is completable under that, so
  // anything below is a bug artifact (e.g. the completion fired before
  // the timer started). Would otherwise leak through as 00:00 on the
  // menu pill and disagree with the leaderboard.
  if (elapsedMs < MIN_PLAUSIBLE_ELAPSED_MS) {
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
  // Only treat a previous best as valid when it's above the sanity
  // floor. A sub-second value came from the same pre-fix bug and should
  // be displaced by this run's real elapsed rather than persisting via
  // Math.min(bogus, real) = bogus.
  const rawPrevBest = previousEntry ? Number(previousEntry.bestElapsedMs) : NaN
  const previousBestMs = Number.isFinite(rawPrevBest) && rawPrevBest >= MIN_PLAUSIBLE_ELAPSED_MS
    ? rawPrevBest
    : elapsedMs

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

// One-time migration: drop completion records stuck below the plausible
// floor (0ms exact, or sub-second values like ~50ms that format to
// "00:00" on the menu pill even though the leaderboard has the real
// time). Safe to remove — the player can replay to re-record.
function cleanupBadCompletedRuns() {
  const byDate = getCompletedRunsByDate()
  let changed = false
  for (const date of Object.keys(byDate)) {
    const dateRuns = byDate[date]
    if (!dateRuns || typeof dateRuns !== 'object' || Array.isArray(dateRuns)) continue
    for (const mode of Object.keys(dateRuns)) {
      const entry = dateRuns[mode]
      if (!entry || typeof entry !== 'object') continue
      const best = Number(entry.bestElapsedMs) || 0
      if (best < MIN_PLAUSIBLE_ELAPSED_MS) {
        delete dateRuns[mode]
        changed = true
      }
    }
    if (Object.keys(dateRuns).length === 0) {
      delete byDate[date]
      changed = true
    }
  }
  if (changed) writeJsonStorage(COMPLETED_RUNS_KEY, byDate)
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
  // Self-heal: if a completion for this key arrived via sync (another
  // device finished it) but this device's local active run is still
  // sitting in storage — maybe the game tab was autosaving on top of the
  // sync removal, or the removal somehow missed — treat the completion
  // as authoritative, clean up the stale active, and return null. Keeps
  // the launcher from showing "Resume" over "Done".
  if (getCompletionEntry(puzzleDate, gameMode)) {
    try { localStorage.removeItem(key) } catch {}
    return null
  }
  return { ...run, gameMode: normalizeGameMode(run.gameMode), _storageKey: key }
}

function hasActiveRun(puzzleDate, gameMode) {
  return getRunForMode(puzzleDate, gameMode) !== null
}

// Returns the most-recently-updated uncompleted run from an archived
// date (i.e. not today). Used to surface a "Continue" shortcut on the
// launcher's More slice so users don't have to scroll the archive.
function getLatestActiveArchiveRun(todayDate = getIsoDate(new Date())) {
  let best = null
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('xefig:run:')) continue
    const run = readJsonStorage(key)
    if (!run || typeof run !== 'object') continue
    if (run.completed) continue
    if (!run.puzzleDate || !run.imageUrl || !run.difficulty) continue
    if (run.puzzleDate === todayDate) continue
    const updatedAt = Date.parse(run.updatedAt || run.startedAt || '')
    if (!Number.isFinite(updatedAt)) continue
    if (!best || updatedAt > best._updatedAtMs) {
      best = { ...run, gameMode: normalizeGameMode(run.gameMode), _updatedAtMs: updatedAt }
    }
  }
  return best
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

// Freeze the active timer at an exact elapsed — used by the BETA
// Mostly-solve hook so the submitted time equals the tester's set
// target precisely, without the live wall-clock delta that accumulates
// between "set target" and the final tap.
function setFixedActiveElapsed(ms) {
  activeElapsedBaseMs = Math.max(0, Number(ms) || 0)
  activeStartedAtMs = null
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

// Signed MM:SS for PB deltas. Positive = slower, negative = faster.
function formatDelta(ms) {
  if (!Number.isFinite(ms) || ms === 0) return '00:00'
  const sign = ms > 0 ? '+' : '−'
  return `${sign}${formatDuration(Math.abs(ms))}`
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
      // Tab hidden, window blurred, or focus lost — flush pending
      // server changes immediately (fire-and-forget via sendBeacon)
      // so we don't lose up to 5 minutes of progress if the user
      // never returns or the app is force-quit.
      syncOnGameExit()
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
  if (!currentRun) {
    return
  }

  // Don't save until the player has actually interacted (timer started)
  const elapsed = getActiveElapsedMs()
  if (elapsed === 0 && !progressState) {
    return
  }

  // If a completion for this puzzle/mode arrived via sync (another device
  // finished it) while this client is mid-game, stop autosaving. Otherwise
  // the 5-second autosave keeps re-writing the stale active run on top of
  // the sync's removal, making the launcher show "Resume" forever.
  if (getCompletionEntry(currentRun.puzzleDate, currentRun.gameMode)) {
    return
  }

  const nextPuzzleState = progressState || (puzzle ? puzzle.getProgressState() : currentRun.puzzleState)

  // Only mark dirty when gameplay state changed — ignore view-only fields (zoom/pan)
  const stripViewState = (s) => {
    if (!s || typeof s !== 'object') return s
    const { zoom, panX, panY, ...rest } = s
    return rest
  }
  const puzzleChanged = JSON.stringify(stripViewState(nextPuzzleState)) !== JSON.stringify(stripViewState(currentRun.puzzleState))

  const nextRun = {
    ...currentRun,
    elapsedActiveMs: elapsed,
    updatedAt: new Date().toISOString(),
    puzzleState: nextPuzzleState,
  }
  currentRun = nextRun
  saveRunForMode(nextRun)
  if (puzzleChanged) {
    markActiveRunDirty(nextRun)
  }
}

async function submitLeaderboard(run) {
  const response = await fetch(apiUrl('/api/leaderboard/submit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      puzzleDate: run.puzzleDate,
      gameMode: normalizeGameMode(run.gameMode),
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

async function fetchLeaderboard(puzzleDate, gameMode, limit = 10) {
  const mode = normalizeGameMode(gameMode)
  const response = await fetch(
    apiUrl(`/api/leaderboard/${encodeURIComponent(puzzleDate)}?gameMode=${mode}&limit=${limit}`),
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
    writeJsonStorage(DAILY_PUZZLE_CACHE_KEY, payload)
  }
}

function getCachedDailyPayload(date = getIsoDate(new Date())) {
  const cached = readJsonStorage(DAILY_PUZZLE_CACHE_KEY)
  if (!cached || typeof cached !== 'object') {
    return null
  }
  if (cached.date !== date || !cached.categories || typeof cached.categories !== 'object') {
    return null
  }
  return cached
}

function timeoutAfter(ms, message) {
  return new Promise((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), ms)
  })
}

async function fetchPuzzlePayloadFromApi(url, timeoutMs = PUZZLE_FETCH_TIMEOUT_MS) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const response = await fetch(url, { signal: controller?.signal })
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(payload.error || 'Puzzle not found.')
    }
    return payload
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Timed out loading puzzle metadata.')
    }
    throw error
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  }
}

async function fetchPuzzlePayload({ date = null } = {}) {
  const today = getIsoDate(new Date())
  const isTodayRequest = !date || date === today
  const cachedToday = isTodayRequest ? getCachedDailyPayload(today) : null

  // For the default "today" request, use the early fetch started in index.html
  // so we don't wait for the module to load before hitting the API.
  if (!date && window.__earlyPuzzle) {
    const earlyPromise = window.__earlyPuzzle
    window.__earlyPuzzle = null

    try {
      const early = await Promise.race([
        earlyPromise,
        timeoutAfter(EARLY_PUZZLE_WAIT_MS, 'Timed out waiting for early puzzle fetch.'),
      ])
      // Only use the early result if it matches today's date
      if (early && early.date === today) {
        cacheDailyPayload(early)
        return early
      }
    } catch {
      if (cachedToday) {
        return cachedToday
      }
    }
  }

  const endpoint = date ? `/api/puzzles/${encodeURIComponent(date)}` : '/api/puzzles/today'
  // Bust browser cache for "today" if the day has rolled over
  const cacheBust = !date ? `?_=${today}` : ''
  try {
    const payload = await fetchPuzzlePayloadFromApi(apiUrl(endpoint + cacheBust))
    if (!date) cacheDailyPayload(payload)
    return payload
  } catch (error) {
    if (cachedToday) {
      return cachedToday
    }
    throw error
  }
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


function renderDiamondGridThumbnails(container, puzzleDate) {
  const canvases = container.querySelectorAll('.diamond-grid-canvas')
  if (canvases.length === 0) return

  import('./components/diamond-grid-thumbnail.js').then(({ renderDiamondSliceThumbnail }) => {
    for (const canvas of canvases) {
      const date = canvas.dataset.date || puzzleDate
      const imageUrl = canvas.dataset.imageUrl
      const run = getRunForMode(date, GAME_MODE_DIAMOND)
      const isCompleted = getCompletedModesForDate(date).has(GAME_MODE_DIAMOND)

      renderDiamondSliceThumbnail(canvas, {
        imageUrl,
        savedState: run?.puzzleState || null,
        isCompleted,
      })
    }
  })
}

function computeSliceCenter(container) {
  requestAnimationFrame(() => {
    const collapsed = container.querySelector('.slice:not(.active):not(.slice-more)')
    if (collapsed) {
      container.style.setProperty('--slice-center', collapsed.offsetWidth / 2 + 'px')
      container.style.setProperty('--slice-middle', collapsed.offsetHeight / 2 + 'px')
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
    // Remember which slice the player was last on and open there on return
    // (same day only). Falls back to the daily pick for a fresh day.
    const defaultFocus = getLauncherFocus() || pickMode
    return modes
      .map((mode, index) => {
        const imageUrl = resolvePuzzleThumbnailUrl(puzzlePayload, mode)
        const fullImageUrl = resolvePuzzleImageUrl(puzzlePayload, mode)
        const isPick = mode === pickMode
        const isActive = mode === defaultFocus
        const title = (mode === GAME_MODE_DIAMOND && !isActive) ? 'Paint' : MODE_LABELS[mode]
        const isCompleted = completedModes.has(mode)
        const hasSave = hasActiveRun(puzzleDate, mode)
        const entry = isCompleted ? getCompletionEntry(puzzleDate, mode) : null
        const flex = isActive ? ACTIVE_FLEX : INACTIVE_FLEX
        const isLCP = index === 0

        const isDiamond = mode === GAME_MODE_DIAMOND
        const sliceImageHtml = isDiamond
          ? `<canvas class="slice-image diamond-grid-canvas" data-image-url="${fullImageUrl}" data-date="${puzzleDate}"></canvas>`
          : `<img class="slice-image" src="${imageUrl}" alt="${title}" decoding="async" loading="${isLCP ? 'eager' : 'lazy'}"${isLCP ? ' fetchpriority="high"' : ''} />`

        return `
          <div class="slice${isActive ? ' active' : ''}" data-mode="${mode}" style="--flex: ${flex};">
            ${sliceImageHtml}
            <div class="slice-overlay"></div>
            <div class="slice-icon">${SLICE_ICONS[mode]}</div>
            <div class="slice-accent" style="background:${ACCENT_MAP_FULL[mode]}"></div>
            <div class="slice-title">${SPINE_LABELS[mode]}</div>
            <div class="slice-info"><p>${SLICE_DESCRIPTIONS[mode]}</p></div>
            <div class="slice-action${hasSave ? ' action-saved' : isCompleted ? ' action-completed' : ''}">${hasSave ? `<svg class="action-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h8l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm1 1v4h7V2H4zm4 6a2 2 0 100 4 2 2 0 000-4z"/></svg><span>Resume</span>` : isCompleted ? `<svg class="action-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.35 5.35a.5.5 0 0 0-.7-.7L7 8.29 5.35 6.65a.5.5 0 0 0-.7.7l2 2a.5.5 0 0 0 .7 0l4-4Z"/></svg><span>${entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : 'Done'}</span>` : `<span>${SPINE_ACTIONS[mode]}</span>`}</div>
            <div class="slice-bar">
              <span class="bar-title">${title}</span>
              <div class="bar-icon info-btn" title="More info">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4.5v.5"/></svg>
              </div>
              <div class="bar-spacer"></div>
              ${isCompleted && !hasSave ? `<span class="bar-completed" title="Completed${entry?.bestElapsedMs ? ' \u2014 ' + formatDuration(entry.bestElapsedMs) : ''}"><svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.35 5.35a.5.5 0 0 0-.7-.7L7 8.29 5.35 6.65a.5.5 0 0 0-.7.7l2 2a.5.5 0 0 0 .7 0l4-4Z"/></svg>${entry?.bestElapsedMs ? ` <span class="bar-completed-time">${formatDuration(entry.bestElapsedMs)}</span>` : ''}</span>` : ''}
              ${hasSave ? `<div class="bar-icon has-save" title="Save exists"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 1h8l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm1 1v4h7V2H4zm4 6a2 2 0 100 4 2 2 0 000-4z"/></svg></div>` : ''}
            </div>
            <div class="info-panel" data-mode="${mode}"></div>
          </div>
        `
      })
      .join('') + `
          <div class="slice slice-more${defaultFocus === 'more' ? ' active' : ''}" style="--flex: ${defaultFocus === 'more' ? MORE_ACTIVE_FLEX : MORE_INACTIVE_FLEX};">
            <div class="slice-overlay"></div>
            <div class="slice-title">More</div>
            <div class="slice-more-cards">
              ${(() => {
                const resume = getLatestActiveArchiveRun(puzzleDate)
                if (!resume) return ''
                const d = new Date(Date.parse(`${resume.puzzleDate}T00:00:00Z`))
                const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
                const modeLabel = SPINE_LABELS[resume.gameMode] || resume.gameMode
                return `
              <button class="more-card more-card--continue" data-action="continue" data-mode="${resume.gameMode}" data-date="${resume.puzzleDate}" title="Continue ${modeLabel} from ${dateLabel}">
                <div class="more-card-img">
                  <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
                </div>
                <span class="more-card-label">Continue · ${modeLabel} · ${dateLabel}</span>
              </button>`
              })()}
              <button class="more-card" data-page="archive">
                <div class="more-card-img">
                  <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.2">
                    <rect x="8" y="6" width="48" height="10" rx="2"/>
                    <path d="M12 16v36a4 4 0 004 4h32a4 4 0 004-4V16"/>
                    <path d="M24 28h16" stroke-width="2" stroke-linecap="round"/>
                    <rect x="20" y="22" width="24" height="12" rx="2" stroke-dasharray="3 2"/>
                    <path d="M20 42h24M20 48h16" stroke-width="1" opacity="0.4"/>
                  </svg>
                </div>
                <span class="more-card-label">Archive</span>
              </button>
              <div class="more-card more-card--music ${getMusicEnabled() ? 'is-on' : 'is-off'}" data-action="toggle-music" role="button" tabindex="0" aria-label="Music: ${getMusicEnabled() ? 'On' : 'Off'}">
                <div class="more-card-img">
                  <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.2">
                    <path d="M26 44V14l20-4v30" stroke-width="2" stroke-linejoin="round"/>
                    <ellipse cx="22" cy="44" rx="6" ry="4"/>
                    <ellipse cx="42" cy="40" rx="6" ry="4"/>
                    <line class="music-off-slash" x1="8" y1="8" x2="56" y2="56" stroke-width="4" stroke-linecap="round" opacity="0"/>
                  </svg>
                </div>
                <input type="range" class="more-card-volume" min="0" max="1" step="0.01" value="${getMusicVolume()}" aria-label="Music volume">
              </div>
              <button class="more-card" data-page="settings">
                <div class="more-card-img">
                  <svg viewBox="0 0 100 100" fill="currentColor" opacity="0.7">
                    <path fill-rule="evenodd" d="M40.7 15.2 L44 4.4 L56 4.4 L59.3 15.2 L68 18.8 L78 13.5 L86.5 22 L81.2 32 L84.8 40.7 L95.6 44 L95.6 56 L84.8 59.3 L81.2 68 L86.5 78 L78 86.5 L68 81.2 L59.3 84.8 L56 95.6 L44 95.6 L40.7 84.8 L32 81.2 L22 86.5 L13.5 78 L18.8 68 L15.2 59.3 L4.4 56 L4.4 44 L15.2 40.7 L18.8 32 L13.5 22 L22 13.5 L32 18.8 z M50 32 L56.9 33.4 L62.7 37.3 L66.6 43.1 L68 50 L66.6 56.9 L62.7 62.7 L56.9 66.6 L50 68 L43.1 66.6 L37.3 62.7 L33.4 56.9 L32 50 L33.4 43.1 L37.3 37.3 L43.1 33.4 z"/>
                  </svg>
                </div>
                <span class="more-card-label">Settings</span>
              </button>
            </div>
          </div>`
  }

  const ACCENT_MAP_FULL = { jigsaw: '#f0c040', sliding: '#40d0f0', swap: '#50d070', polygram: '#a060f0', diamond: '#e070a0' }

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

  const ACCENT_MAP = { jigsaw: '#f0c040', sliding: '#40d0f0', swap: '#50d070', polygram: '#a060f0', diamond: '#e070a0' }

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
      const activated = slices[index]
      if (activated) {
        const focus = activated.classList.contains('slice-more') ? 'more' : activated.dataset.mode
        if (focus) setLauncherFocus(focus)
      }
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
        const musicSlider = slice.querySelector('.more-card--music .more-card-volume')
        if (musicSlider) {
          const stop = (e) => e.stopPropagation()
          musicSlider.addEventListener('click', stop)
          musicSlider.addEventListener('pointerdown', stop)
          musicSlider.addEventListener('mousedown', stop)
          musicSlider.addEventListener('touchstart', stop, { passive: true })
          musicSlider.addEventListener('input', (e) => {
            e.stopPropagation()
            const vol = Number(musicSlider.value)
            setMusicVolume(vol)
            applyMusicVolume()
            const card = musicSlider.closest('.more-card--music')
            if (card) {
              card.classList.toggle('is-on', vol > 0)
              card.classList.toggle('is-off', vol <= 0)
              card.setAttribute('aria-label', `Music: ${vol > 0 ? 'On' : 'Off'}`)
            }
          })
        }
        slice.querySelectorAll('.more-card').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation()
            if (btn.dataset.action === 'toggle-music') {
              // Card click toggles whether the slice is collapsed or active.
              // Slider interactions stopPropagation so they never reach here.
              const nowEnabled = !getMusicEnabled()
              const nextVol = nowEnabled ? (lastNonZeroVolume || MUSIC_DEFAULT_VOLUME) : 0
              setMusicVolume(nextVol)
              applyMusicVolume()
              const slider = btn.querySelector('.more-card-volume')
              if (slider) slider.value = String(nextVol)
              btn.classList.toggle('is-on', nowEnabled)
              btn.classList.toggle('is-off', !nowEnabled)
              btn.setAttribute('aria-label', `Music: ${nowEnabled ? 'On' : 'Off'}`)
              return
            }
            if (btn.dataset.action === 'continue') {
              const resumeMode = btn.dataset.mode
              const resumeDate = btn.dataset.date
              if (resumeMode && resumeDate) {
                // Resolve puzzle payload for the resumed run's date, then
                // dispatch through handleSliceClick so the saved run is
                // picked up and rendered.
                ;(async () => {
                  try {
                    const payload = await fetchPuzzlePayload({ date: resumeDate })
                    state.puzzle = payload
                    handleSliceClick(resumeMode, resumeDate)
                  } catch {
                    // Fallback: dispatch without a fresh payload; handleSliceClick
                    // will still resume using the saved imageUrl.
                    handleSliceClick(resumeMode, resumeDate)
                  }
                })()
              }
              return
            }
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
      computeSliceCenter(container)

      // Recompute on any container resize so --slice-center / --slice-middle /
      // --info-width track the live geometry (window resize, devtools dock,
      // orientation change, virtual keyboard, etc.).
      const ro = new ResizeObserver(() => computeSliceCenter(container))
      ro.observe(container)

      // Orientation flips swap which dimension is the "spine" — briefly
      // suppress text transitions while the new layout settles.
      const orientationMQ = window.matchMedia('(orientation: landscape)')
      orientationMQ.addEventListener('change', () => {
        container.classList.add('slice-recompute')
        computeSliceCenter(container)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          container.classList.remove('slice-recompute')
        }))
      })

      // Progressive image upgrade: swap thumbnails for full-size images once loaded
      // (skip diamond — it uses a canvas grid thumbnail instead)
      const sliceImages = container.querySelectorAll('.slice-image')
      sliceImages.forEach((img, index) => {
        const mode = modes[index]
        if (mode === GAME_MODE_DIAMOND) return
        const fullUrl = resolvePuzzleImageUrl(payload, mode)
        const thumbUrl = img.src
        if (fullUrl === thumbUrl) return

        const full = new Image()
        full.src = fullUrl
        full.onload = () => {
          if (img.isConnected) img.src = fullUrl
        }
      })

      // Render diamond grid thumbnails
      renderDiamondGridThumbnails(container, payload?.date || todayDate)
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
  [GAME_MODE_SWAP]: '#50d070',
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
        if (hasSave) {
          statusClass = 'resume'
          statusLabel = '\u25B6 resume'
        } else if (isCompleted) {
          statusClass = 'completed'
          const entry = getCompletionEntry(dateKey, mode)
          statusLabel = entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : '\u2713'
        }

        const isDiamond = mode === GAME_MODE_DIAMOND
        const fullImageUrl = resolvePuzzleImageUrl(puzzlePayload, mode)
        const thumbImageHtml = isDiamond
          ? `<div class="thumb-image"><canvas class="diamond-grid-canvas thumb-grid-canvas" data-image-url="${fullImageUrl}" data-date="${dateKey}"></canvas></div>`
          : `<div class="thumb-image" style="background-image:url('${thumbUrl}')"></div>`

        return `<div class="puzzle-thumb" data-mode="${mode}" data-date="${dateKey}">
          <div class="thumb-accent" style="background:${accent}"></div>
          ${thumbImageHtml}
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
    renderDiamondGridThumbnails(timeline)
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

const LEADERBOARD_STAR_SVG = `<svg class="lb-star" viewBox="0 0 24 24" aria-label="Your best" role="img"><path d="M12 4 L14.351 8.763 L19.608 9.528 L15.804 13.237 L16.702 18.472 L12 16 L7.298 18.472 L8.196 13.237 L4.392 9.528 L9.649 8.763 Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/></svg>`

// Resolve what to show in the Player column. Self-reference: show the
// player's name if they've set one, else fall back to "You". Other
// players: profile name if set, else "Anon-XXXXXXXX" from the guid
// prefix so they still have a stable handle.
function displayPlayerName({ isMe, profileName, playerGuid }) {
  const name = (profileName || '').trim()
  if (isMe) return name || 'You'
  if (name) return name
  return `Anon-${String(playerGuid || '').slice(0, 8)}`
}

function renderLeaderboardRow({ rank, elapsedMs, playerGuid, profileName, isMe, isBest, extraClass = '', playerLabel, hideRank = false }) {
  const time = formatDuration(elapsedMs)
  const label = playerLabel ?? displayPlayerName({ isMe, profileName, playerGuid })
  const classes = ['lb-row']
  if (isMe) classes.push('lb-row-me')
  if (isBest) classes.push('lb-row-best')
  if (extraClass) classes.push(extraClass)
  const rankCell = hideRank
    ? '<td class="lb-rank" aria-hidden="true"></td>'
    : `<td class="lb-rank"><span class="lb-rank-num">#${rank}</span></td>`
  return `
    <tr class="${classes.join(' ')}" data-player-guid="${playerGuid}">
      ${rankCell}
      <td class="lb-time">${time}</td>
      <td class="lb-player">${label}</td>
      <td class="lb-best">${isBest ? LEADERBOARD_STAR_SVG : ''}</td>
    </tr>`
}

function showCompletionOverlay({
  gameMode,
  duration,
  elapsedMs,
  rank,
  bestMs,
  previousBestMs,
  submissionRank,
  submissionElapsedMs,
  totalEntries,
  leaderboardEntries,
  playerGuid: myGuid,
  completedRun,
}) {
  const existing = document.querySelector('.completion-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay'

  let dismissed = false
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    if (completedRun) clearRunForMode(completedRun)
    overlay.classList.remove('is-visible')
    setTimeout(() => overlay.remove(), 200)
  }

  let leaderboardBlock = ''
  if (leaderboardEntries && leaderboardEntries.length > 0) {
    const submissionTime = formatDuration(submissionElapsedMs)
    const submissionRankLabel = submissionRank ? `#${submissionRank}` : (rank ? `#${rank}` : '—')
    const pinnedIsBest = Number.isFinite(bestMs) && submissionElapsedMs === bestMs
    const slowerThanPb = Number.isFinite(bestMs) && submissionElapsedMs > bestMs
    const fasterThanPb = Number.isFinite(bestMs) && submissionElapsedMs < bestMs

    // Trend marker for the pinned row's right column. Slower = dropped
    // down the board (▼), faster = climbed up (▲), tied = flat (—).
    const trendArrow = fasterThanPb
      ? '<span class="lb-trend lb-trend-better" aria-label="faster than PB">▲</span>'
      : slowerThanPb
        ? '<span class="lb-trend lb-trend-worse" aria-label="slower than PB">▼</span>'
        : '<span class="lb-trend lb-trend-tied" aria-label="same as PB">—</span>'

    // The user's own name if they've set one — used for their in-list
    // row (local source of truth in case sync hasn't pushed yet), plus
    // the pinned and ghost rows which are synthesised client-side.
    const myProfileName = (getProfileName() || '').trim()
    const myDisplayName = displayPlayerName({ isMe: true, profileName: myProfileName, playerGuid: myGuid })

    // Build the list rows. When this run is slower than the stored PB,
    // splice a ghost row into the visible list at the position it would
    // occupy — so the player sees "here's where you'd be with this
    // attempt" in context with the real entries. The PB entry stays
    // starred wherever it already sits. When the run tied or beat PB,
    // it IS the in-list starred entry, so no ghost is needed.
    const rows = leaderboardEntries.map((entry) => ({
      kind: 'real',
      rank: entry.rank,
      elapsedMs: entry.elapsedMs,
      playerGuid: entry.playerGuid,
      profileName: entry.playerGuid === myGuid ? (myProfileName || entry.profileName) : entry.profileName,
      isMe: entry.playerGuid === myGuid,
      isBest: entry.playerGuid === myGuid,
    }))
    if (slowerThanPb && submissionRank) {
      const insertAt = Math.min(Math.max(submissionRank - 1, 0), rows.length)
      rows.splice(insertAt, 0, {
        kind: 'ghost',
        rank: submissionRank,
        elapsedMs: submissionElapsedMs,
        playerGuid: myGuid,
        profileName: myProfileName,
        isMe: true,
        isBest: false,
      })
    }
    const rowsHtml = rows.map((r) => renderLeaderboardRow({
      rank: r.rank,
      elapsedMs: r.elapsedMs,
      playerGuid: r.playerGuid,
      profileName: r.profileName,
      isMe: r.isMe,
      isBest: r.isBest,
      extraClass: r.kind === 'ghost' ? 'lb-row-ghost lb-row-ghost-inline' : '',
      // Existing server ranks don't shift when we splice a ghost in,
      // so showing #26 on both the ghost and the real #26 reads as a
      // duplicate. Hide the ghost's rank — its list position is the rank.
      hideRank: r.kind === 'ghost',
    })).join('')

    // Shared colgroup so both the list table and the pinned table get
     // identical column widths under table-layout: fixed, regardless of
     // which row the browser measures first.
    const lbColgroup = `
      <colgroup>
        <col class="lb-col-rank"><col class="lb-col-time"><col class="lb-col-player"><col class="lb-col-best">
      </colgroup>`

    leaderboardBlock = `
      <div class="completion-leaderboard">
        <h3>Leaderboard</h3>
        <div class="lb-scroll" id="lb-scroll">
          <table class="lb-table">
            ${lbColgroup}
            <thead><tr><th></th><th>Time</th><th>Player</th><th aria-hidden="true"></th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
        <table class="lb-table lb-pinned" id="lb-pinned">
          ${lbColgroup}
          <tbody>
            <tr class="lb-row lb-row-me lb-row-pinned" title="Tap to find your entry on the leaderboard">
              <td class="lb-rank"><span class="lb-rank-num">${submissionRankLabel}</span></td>
              <td class="lb-time">${submissionTime}</td>
              <td class="lb-player">${myDisplayName}</td>
              <td class="lb-best">${pinnedIsBest ? LEADERBOARD_STAR_SVG : trendArrow}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `
  }

  // Header focuses on the PERSONAL story: the time the player just
  // clocked + where that sits versus their own best. Rank on the global
  // board is a quieter secondary line underneath — still present for
  // the competitive / viral hook, just not the emotional lead.
  const headerRank = submissionRank ?? rank
  let pbStatValue = formatDuration(submissionElapsedMs)
  let pbStatLabel = 'Your Time'
  let pbStatClass = 'completion-stat-pb-neutral'
  if (Number.isFinite(previousBestMs)) {
    const delta = submissionElapsedMs - previousBestMs
    if (delta < 0) {
      pbStatValue = formatDelta(delta)
      pbStatLabel = 'New PB!'
      pbStatClass = 'completion-stat-pb-better'
    } else if (delta === 0) {
      pbStatValue = '00:00'
      pbStatLabel = 'Tied PB'
      pbStatClass = 'completion-stat-pb-neutral'
    } else {
      pbStatValue = formatDelta(delta)
      pbStatLabel = 'vs PB'
      pbStatClass = 'completion-stat-pb-worse'
    }
  } else {
    pbStatLabel = 'First Solve'
  }
  const rankLine = headerRank
    ? `<div class="completion-rankline">Rank #${headerRank}</div>`
    : ''

  overlay.innerHTML = `
    <div class="completion-card">
      <h2>Puzzle Complete!</h2>
      <div class="completion-stats">
        <div class="completion-stat">
          <span class="stat-value">${duration}</span>
          <span class="stat-label">Time</span>
        </div>
        <div class="completion-stat ${pbStatClass}">
          <span class="stat-value">${pbStatValue}</span>
          <span class="stat-label">${pbStatLabel}</span>
        </div>
      </div>
      ${rankLine}
      ${leaderboardBlock}
      <button type="button" class="completion-dismiss">Continue</button>
    </div>
  `

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))

  overlay.querySelector('.completion-dismiss').addEventListener('click', dismiss)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })

  const pinned = overlay.querySelector('#lb-pinned')
  const scrollEl = overlay.querySelector('#lb-scroll')
  if (pinned && scrollEl) {
    pinned.addEventListener('click', () => {
      const target = scrollEl.querySelector('.lb-row-best') || scrollEl.querySelector('.lb-row-me')
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }
}

function forceCompletePuzzlePreview(gameMode, puzzle) {
  if (gameMode === GAME_MODE_DIAMOND) {
    puzzle.fills = new Int8Array(puzzle.grid)
    puzzle.completed = true
    puzzle.drawGrid()
    return
  }
  if (gameMode === GAME_MODE_JIGSAW) {
    puzzle.applyProgressState({
      pieces: puzzle.pieces.map((p) => ({
        row: p.row,
        col: p.col,
        locked: true,
        inCarousel: false,
      })),
    })
    return
  }
  if (gameMode === GAME_MODE_SLIDING) {
    const slots = Array.from({ length: puzzle.totalSlots }, (_, i) =>
      i < puzzle.tileCount ? i : null,
    )
    puzzle.applyProgressState({
      slots,
      cols: puzzle.cols,
      rows: puzzle.rows,
      completed: true,
    })
    return
  }
  if (gameMode === GAME_MODE_SWAP) {
    const slots = Array.from({ length: puzzle.totalTiles }, (_, i) => i)
    puzzle.applyProgressState({
      slots,
      cols: puzzle.cols,
      rows: puzzle.rows,
      completed: true,
    })
    return
  }
  if (gameMode === GAME_MODE_POLYGRAM) {
    puzzle.applyProgressState({
      pieces: puzzle.pieces.map((p) => ({
        id: p.id,
        locked: true,
        placed: false,
        rotation: 0,
        trayOrder: p.trayOrder,
      })),
      shardCount: puzzle.shardCount,
      completed: true,
    })
    return
  }
}

// Apply a near-solved state to an active puzzle instance so a single
// interaction completes it. Used by the BETA-only "Mostly solve" test
// button — tree-shaken from production bundles via the BETA guard.
function mostlySolvePuzzle(gameMode, puzzle) {
  if (gameMode === GAME_MODE_DIAMOND) {
    const lastIdx = puzzle.totalCells - 1
    const fills = Array.from(puzzle.grid)
    fills[lastIdx] = -1
    puzzle.applyProgressState({
      cols: puzzle.cols,
      rows: puzzle.rows,
      palette: puzzle.palette.map((c) => [...c]),
      grid: Array.from(puzzle.grid),
      fills,
      selectedColor: puzzle.grid[lastIdx],
      completed: false,
    })
    return
  }
  if (gameMode === GAME_MODE_JIGSAW) {
    const last = puzzle.pieces.length - 1
    puzzle.applyProgressState({
      pieces: puzzle.pieces.map((p, i) => ({
        row: p.row,
        col: p.col,
        locked: i !== last,
        inCarousel: i === last,
      })),
    })
    return
  }
  if (gameMode === GAME_MODE_SLIDING) {
    // Solved:   [0, 1, ..., tc-1, null]
    // Near:     [0, 1, ..., tc-2, null, tc-1]  (one slide finishes it)
    const tc = puzzle.tileCount
    const slots = Array.from({ length: puzzle.totalSlots }, (_, i) => {
      if (i < tc - 1) return i
      if (i === tc - 1) return null
      return tc - 1
    })
    puzzle.applyProgressState({
      slots,
      cols: puzzle.cols,
      rows: puzzle.rows,
      completed: false,
    })
    return
  }
  if (gameMode === GAME_MODE_SWAP) {
    // Solved identity; swap last two so a single swap finishes it.
    const n = puzzle.totalTiles
    const slots = Array.from({ length: n }, (_, i) => {
      if (i === n - 2) return n - 1
      if (i === n - 1) return n - 2
      return i
    })
    puzzle.applyProgressState({
      slots,
      cols: puzzle.cols,
      rows: puzzle.rows,
      completed: false,
    })
    return
  }
  if (gameMode === GAME_MODE_POLYGRAM) {
    const last = puzzle.pieces.length - 1
    puzzle.applyProgressState({
      pieces: puzzle.pieces.map((p, i) => ({
        id: p.id,
        locked: i !== last,
        placed: false,
        rotation: 0,
        trayOrder: p.trayOrder,
      })),
      shardCount: puzzle.shardCount,
      completed: false,
    })
    return
  }
}

// Ask the player to set a leaderboard name. Save enables sync so other
// players see the name; Skip remembers the decline so we don't nag.
function showNameDialog({ defaultName = '', onDone }) {
  const existing = document.querySelector('.name-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay name-overlay'
  overlay.innerHTML = `
    <div class="completion-card name-card">
      <h3 class="name-title">Claim your leaderboard name</h3>
      <p class="name-msg">Choose how you'll show up on the board. You can change or clear this anytime in Settings.</p>
      <input type="text" class="name-input" maxlength="30" placeholder="Anonymous" value="${String(defaultName).replace(/"/g, '&quot;')}" autocomplete="off" spellcheck="false" />
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel">Skip</button>
        <button type="button" class="confirm-ok">Save</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))

  const input = overlay.querySelector('.name-input')
  setTimeout(() => { try { input.focus(); input.select() } catch {} }, 50)

  let done = false
  const close = (saved, name) => {
    if (done) return
    done = true
    overlay.classList.remove('is-visible')
    setTimeout(() => overlay.remove(), 200)
    if (typeof onDone === 'function') onDone(saved ? { name } : null)
  }

  overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(false))
  overlay.querySelector('.confirm-ok').addEventListener('click', () => {
    const name = input.value.trim()
    if (name) close(true, name)
    else close(false)
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      overlay.querySelector('.confirm-ok').click()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close(false)
    }
  })
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close(false)
  })
}

function showConfirmDialog({ message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm }) {
  const existing = document.querySelector('.confirm-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay confirm-overlay'
  overlay.innerHTML = `
    <div class="completion-card confirm-card">
      <p class="confirm-message">${message}</p>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel">${cancelLabel}</button>
        <button type="button" class="confirm-ok">${confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))

  const dismiss = () => {
    overlay.classList.remove('is-visible')
    setTimeout(() => overlay.remove(), 200)
  }
  overlay.querySelector('.confirm-cancel').addEventListener('click', dismiss)
  overlay.querySelector('.confirm-ok').addEventListener('click', () => {
    dismiss()
    onConfirm()
  })
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })
}

function showCompletedPuzzleScreen({ gameMode, puzzleDate, entry, onReplay, onBack }) {
  const durationLabel = entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : '—'
  const modeLabel = MODE_LABELS[gameMode] || gameMode
  const imageUrl = resolvePuzzleImageUrl(state.puzzle, gameMode)
  const loaderKey = gameMode === GAME_MODE_JIGSAW ? 'jigsaw'
    : gameMode === GAME_MODE_SLIDING ? 'sliding'
    : gameMode === GAME_MODE_SWAP ? 'swap'
    : gameMode === GAME_MODE_POLYGRAM ? 'polygram'
    : gameMode === GAME_MODE_DIAMOND ? 'diamond'
    : null

  showGamePage()
  const gameEl = document.querySelector('#page-game')
  const previewMarkup = loaderKey
    ? `<div class="completed-screen-bg-preview" id="completed-bg-mount"></div>`
    : ''

  gameEl.innerHTML = `
    <main class="completed-screen">
      <img class="completed-screen-blur" src="${imageUrl}" alt="" aria-hidden="true" />
      ${previewMarkup}
      <div class="completed-screen-topbar">
        <button class="completed-screen-back" id="completed-back-btn" type="button" aria-label="Back">←</button>
        <div class="completed-screen-meta">
          <span class="meta-mode">${modeLabel}</span>
          <span class="meta-date">${puzzleDate}</span>
        </div>
      </div>
      <div class="completed-screen-pill">
        <div class="pill-item">
          <span class="pill-value">${durationLabel}</span>
          <span class="pill-label">Best</span>
        </div>
        <div class="pill-item">
          <span class="pill-value" id="completed-rank">—</span>
          <span class="pill-label">Rank</span>
        </div>
      </div>
      <aside class="completed-screen-sheet" id="completed-sheet" aria-expanded="false">
        <button class="sheet-handle" type="button" aria-label="Toggle leaderboard">
          <svg class="sheet-handle-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22,3H19V2a1,1,0,0,0-1-1H6A1,1,0,0,0,5,2V3H2A1,1,0,0,0,1,4V6a4.994,4.994,0,0,0,4.276,4.927A7.009,7.009,0,0,0,11,15.92V18H7a1,1,0,0,0-.949.684l-1,3A1,1,0,0,0,6,23H18a1,1,0,0,0,.948-1.316l-1-3A1,1,0,0,0,17,18H13V15.92a7.009,7.009,0,0,0,5.724-4.993A4.994,4.994,0,0,0,23,6V4A1,1,0,0,0,22,3ZM5,8.829A3.006,3.006,0,0,1,3,6V5H5ZM16.279,20l.333,1H7.387l.334-1ZM17,9A5,5,0,0,1,7,9V3H17Zm4-3a3.006,3.006,0,0,1-2,2.829V5h2ZM10.667,8.667,9,7.292,11,7l1-2,1,2,2,.292L13.333,8.667,13.854,11,12,9.667,10.146,11Z"/></svg>
          <span class="sheet-handle-bar"></span>
          <span class="sheet-handle-label">Leaderboard</span>
        </button>
        <div class="sheet-body">
          <div id="completed-leaderboard" class="sheet-leaderboard"></div>
        </div>
      </aside>
      <button id="replay-btn" class="completed-screen-replay" type="button">Play Again</button>
    </main>
  `

  const sheet = gameEl.querySelector('#completed-sheet')
  const setSheetExpanded = (expanded) => {
    sheet.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  }

  sheet.addEventListener('click', (e) => {
    const expanded = sheet.getAttribute('aria-expanded') === 'true'
    const onHandle = e.target.closest('.sheet-handle')
    if (onHandle) {
      setSheetExpanded(!expanded)
    } else if (!expanded) {
      // Any tap on the peeking sheet body expands it.
      setSheetExpanded(true)
    }
  })

  // Tap anywhere outside the sheet (on the puzzle, blurred backdrop,
  // topbar, or completed-screen chrome) collapses it when it's open.
  gameEl.querySelector('.completed-screen').addEventListener('click', (e) => {
    if (sheet.contains(e.target)) return
    if (sheet.getAttribute('aria-expanded') === 'true') {
      setSheetExpanded(false)
    }
  })

  let previewPuzzle = null
  const teardown = () => {
    if (previewPuzzle) {
      previewPuzzle.destroy()
      previewPuzzle = null
    }
  }

  gameEl.querySelector('#replay-btn').addEventListener('click', (e) => {
    e.stopPropagation() // don't let the completed-screen outside-click handler collapse the sheet first
    showConfirmDialog({
      message: 'Play this puzzle again? Your best time and leaderboard rank are already saved.',
      confirmLabel: 'Play Again',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        teardown()
        onReplay()
      },
    })
  })
  gameEl.querySelector('#completed-back-btn').addEventListener('click', () => {
    teardown()
    onBack()
  })

  if (loaderKey) {
    const mount = gameEl.querySelector('#completed-bg-mount')
    puzzleLoaders[loaderKey]().then((PuzzleClass) => {
      if (!gameEl.isConnected || !mount.isConnected) return
      const preview = new PuzzleClass({
        container: mount,
        imageUrl,
        difficulty: state.difficulty,
        boardColorIndex: getGlobalBoardColorIndex(),
        onProgress: () => {},
        onComplete: () => {},
      })
      previewPuzzle = preview
      preview.init().then(() => {
        if (previewPuzzle !== preview) return
        forceCompletePuzzlePreview(gameMode, preview)
      }).catch(() => {
        // Non-fatal — preview just won't render; topbar/pill/sheet still work.
      })
    }).catch(() => {})
  }

  fetchLeaderboard(puzzleDate, gameMode, 100)
    .then((lb) => {
      const entries = lb.entries || []
      const myEntry = entries.find((e) => e.playerGuid === playerGuid)
      const rankEl = document.querySelector('#completed-rank')
      if (rankEl && myEntry) {
        rankEl.textContent = `#${myEntry.rank}`
      }

      const container = document.querySelector('#completed-leaderboard')
      if (!container) return

      if (entries.length === 0) {
        container.innerHTML = `<p class="sheet-leaderboard-empty">No times recorded yet.</p>`
        return
      }

      const rowsHtml = entries.map((e) => renderLeaderboardRow({
        rank: e.rank,
        elapsedMs: e.elapsedMs,
        playerGuid: e.playerGuid,
        profileName: e.profileName,
        isMe: e.playerGuid === playerGuid,
        isBest: e.playerGuid === playerGuid,
      })).join('')

      // Sheet-body already scrolls — don't wrap in .lb-scroll (the inner
      // cap would clip the list at 15rem in landscape).
      container.innerHTML = `
        <table class="lb-table">
          <colgroup>
            <col class="lb-col-rank"><col class="lb-col-time"><col class="lb-col-player"><col class="lb-col-best">
          </colgroup>
          <thead><tr><th></th><th>Time</th><th>Player</th><th aria-hidden="true"></th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      `
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
    : gameMode === GAME_MODE_SWAP ? '#50d070'
    : gameMode === GAME_MODE_DIAMOND ? '#e070a0'
    : '#a060f0'
  const dateLabel = state.puzzle?.date
    ? new Date(Date.parse(`${state.puzzle.date}T00:00:00Z`)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
    : ''
  const compactModeLabel = gameMode === GAME_MODE_DIAMOND ? 'Paint' : MODE_LABELS[gameMode]
  const titleLabel = `${compactModeLabel}${dateLabel ? ` <span style="color:${accentColor}">\u00b7</span> ${dateLabel}` : ''}`
  const showPieceCount = gameMode !== GAME_MODE_DIAMOND
  const useImmersiveJigsawChrome = gameMode === GAME_MODE_JIGSAW
  const useImmersiveDiamondChrome = gameMode === GAME_MODE_DIAMOND
  const useImmersivePolygramChrome = gameMode === GAME_MODE_POLYGRAM
  const useImmersiveSlidingChrome = gameMode === GAME_MODE_SLIDING
  const useImmersiveSwapChrome = gameMode === GAME_MODE_SWAP
  const useImmersiveMenuChrome = useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome || useImmersiveSwapChrome
  const useImmersiveChrome = useImmersiveMenuChrome || useImmersiveDiamondChrome
  const viewButtonMarkup = gameMode !== GAME_MODE_DIAMOND
    ? `<button id="view-btn" class="gt-menu-item" type="button" aria-pressed="false">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>
        Reference image
      </button>`
    : ''
  const restartButtonMarkup = `<button id="restart-btn" class="gt-menu-item gt-menu-item--danger" type="button">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L14 10h7V3l-3.35 3.35Z"/></svg>
      Restart
    </button>`

  gameEl.innerHTML = `
    <main class="game-shell game-shell--${gameMode}${useImmersiveChrome ? ' game-shell--immersive' : ''}">
      ${useImmersiveChrome ? '' : `
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
              ${viewButtonMarkup}
              ${restartButtonMarkup}
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
      `}

      <section class="workspace${useImmersiveChrome ? ' workspace--immersive' : ''}">
        <div id="puzzle-mount" class="puzzle-mount"></div>
        ${useImmersiveMenuChrome ? `
          <button id="back-btn" class="diamond-floating-btn diamond-floating-btn--back" type="button" aria-label="Back to puzzles" title="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="floating-game-controls">
            <div class="gt-menu-wrap gt-menu-wrap--floating">
              <button id="menu-btn" class="gt-icon-btn gt-icon-btn--floating" type="button" aria-label="Puzzle menu" aria-expanded="false" title="Puzzle menu">
                <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
              </button>
              <div id="gt-menu" class="gt-menu gt-menu--floating" hidden>
                ${useImmersiveJigsawChrome ? `
                <button id="highlight-btn" class="gt-menu-item" type="button">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2l1.6 4.6L15 8l-4.4 1.4L9 14l-1.6-4.6L3 8l4.4-1.4Zm8 4l1 2.8 2.8 1-2.8 1L17 14l-1-2.8L13.2 10l2.8-1Zm-4 10l.8 2.2L16 19.2l-2.2.8L13 22l-.8-2-2.2-1 2.2-.8Z"/></svg>
                  Highlight loose
                </button>
                <button id="edges-btn" class="gt-menu-item" type="button" aria-pressed="false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 3 L18 3 L18 7.2 C18 8.3, 21.5 8.1, 21.5 10.5 C21.5 12.9, 18 12.7, 18 13.8 L18 18 L13.8 18 C12.7 18, 12.9 21.5, 10.5 21.5 C8.1 21.5, 8.3 18, 7.2 18 L3 18 Z"/></svg>
                  Edges only
                </button>
                ` : ''}
                ${viewButtonMarkup}
                ${restartButtonMarkup}
              </div>
            </div>
          </div>
          <p id="status" class="sr-only" aria-live="polite">Loading puzzle...</p>
        ` : ''}
        ${useImmersiveDiamondChrome ? `
          <button id="back-btn" class="diamond-floating-btn diamond-floating-btn--back" type="button" aria-label="Back to puzzles" title="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button id="restart-btn" class="diamond-floating-btn diamond-floating-btn--restart" type="button" aria-label="Restart puzzle" title="Restart">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L14 10h7V3l-3.35 3.35Z"/></svg>
          </button>
          <p id="status" class="sr-only" aria-live="polite">Loading puzzle...</p>
        ` : ''}
      </section>
    </main>
  `

  const statusEl = gameEl.querySelector('#status')
  const workspaceEl = gameEl.querySelector('.workspace')
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
    if (timerEl) timerEl.textContent = formatDuration(getActiveElapsedMs())
    timerRaf = requestAnimationFrame(updateTimer)
  }
  const startTimerDisplay = () => { if (!timerEl) return; if (!timerRaf) timerRaf = requestAnimationFrame(updateTimer) }
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
    clearImmersiveControlsTimer()
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
    if (!menuPanel || !menuBtn) return
    const show = open ?? menuPanel.hidden
    menuPanel.hidden = !show
    menuBtn.setAttribute('aria-expanded', show ? 'true' : 'false')
    if (useImmersiveMenuChrome) {
      setImmersiveControlsVisible(true, { persist: show })
    }
  }
  if (menuBtn) menuBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu() })
  const closeMenu = () => toggleMenu(false)
  document.addEventListener('click', closeMenu)
  if (menuPanel) menuPanel.addEventListener('click', closeMenu)

  let immersiveControlsHideTimer = null
  const clearImmersiveControlsTimer = () => {
    if (immersiveControlsHideTimer) {
      window.clearTimeout(immersiveControlsHideTimer)
      immersiveControlsHideTimer = null
    }
  }
  const setImmersiveControlsVisible = (visible, { persist = false } = {}) => {
    if (!useImmersiveMenuChrome || !workspaceEl) return
    workspaceEl.classList.toggle('workspace--controls-hidden', !visible)
    clearImmersiveControlsTimer()
    if (visible && !persist) {
      immersiveControlsHideTimer = window.setTimeout(() => {
        if (menuPanel && !menuPanel.hidden) return
        workspaceEl.classList.add('workspace--controls-hidden')
      }, 2600)
    }
  }
  if (useImmersiveMenuChrome && workspaceEl) {
    const wakeImmersiveControls = (event) => {
      if (event?.target?.closest?.('.floating-game-controls, .jigsaw-carousel, .jigsaw-tray-tools, .polygram-tray, .gt-menu')) {
        setImmersiveControlsVisible(true, { persist: !menuPanel.hidden })
        return
      }
      setImmersiveControlsVisible(true)
    }
    workspaceEl.addEventListener('pointerdown', wakeImmersiveControls, { passive: true })
    workspaceEl.addEventListener('pointermove', wakeImmersiveControls, { passive: true })
    workspaceEl.addEventListener('focusin', wakeImmersiveControls)
    setImmersiveControlsVisible(true)
  }

  // Shared timer-started flag so the BETA mostly-solve hook can flip it
  // and prevent the first real emitProgress from resetting the timer to
  // zero (which happens for puzzle classes whose applyProgressState
  // doesn't itself emit progress — jigsaw, sliding, swap, polygram).
  const timerState = { started: false }

  if (BETA) {
    const btn = document.createElement('button')
    btn.className = 'beta-tool-btn'
    btn.type = 'button'
    btn.textContent = 'Mostly solve'
    btn.title = 'BETA: near-solved state + set the elapsed time the submission will record'
    btn.addEventListener('click', () => {
      if (!puzzle) return
      const input = prompt('Elapsed time to record on completion (MM:SS, blank = keep current timer):', '05:00')
      if (input === null) return
      let targetMs = 0
      const trimmed = input.trim()
      if (trimmed) {
        const parts = trimmed.split(':').map((p) => Number(p))
        if (parts.length === 2 && parts.every(Number.isFinite)) {
          targetMs = Math.max(0, parts[0] * 60_000 + parts[1] * 1000)
        } else if (parts.length === 1 && Number.isFinite(parts[0])) {
          targetMs = Math.max(0, parts[0] * 1000)
        }
      }
      try {
        mostlySolvePuzzle(state.gameMode, puzzle)
        if (targetMs > 0) {
          // Freeze the timer at EXACTLY the target. setFixedActiveElapsed
          // leaves activeStartedAtMs null, so pauseActiveTimer in
          // onComplete is a no-op and the submitted elapsed equals
          // targetMs to the millisecond — no off-by-one from the
          // interaction delay between "set target" and the final tap.
          setFixedActiveElapsed(targetMs)
          timerState.started = true
          startTimerDisplay()
        }
      } catch (err) {
        console.error('Mostly solve failed', err)
      }
    })
    gameEl.appendChild(btn)
  }

  const restartBtn = gameEl.querySelector('#restart-btn')
  restartBtn.addEventListener('click', () => {
    if (!currentRun) return
    if (!confirm('Restart this puzzle? Your current progress will be lost.')) return
    clearImmersiveControlsTimer()
    stopTimerDisplay()
    clearRunForMode(currentRun)
    currentRun = null
    // Re-resolve the image URL from the current puzzle payload so a regenerated
    // image is picked up instead of reusing the stale URL captured when the run began.
    // Only update when the payload actually has a category imageUrl — otherwise
    // resolveAssetUrl would fall back to the hero sample image.
    const categoryKey = GAME_MODE_TO_PUZZLE_CATEGORY[state.gameMode] || 'jigsaw'
    const rawImageUrl = state.puzzle?.categories?.[categoryKey]?.imageUrl
      || state.puzzle?.categories?.jigsaw?.imageUrl
    if (rawImageUrl) state.imageUrl = resolveAssetUrl(rawImageUrl)
    renderGame()
  })

  // Double-tap/click on puzzle board to toggle reference image.
  // Ignores chrome buttons and trays, but slider/swap tiles (rendered
  // as <button>) must still count as board targets.
  function isBoardTarget(target) {
    if (target.closest('.sliding-tile, .picture-swap-tile')) {
      return mount.contains(target)
    }
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
  let lastTapTile = null
  let dblHandled = false
  mount.addEventListener('pointerup', (e) => {
    if (!puzzle || !isBoardTarget(e.target)) return
    const tile = e.target.closest('.sliding-tile, .picture-swap-tile') || null
    const now = Date.now()
    const quickRepeat = now - lastTapTime > 0 && now - lastTapTime < 500
    // Tile targets require the second tap on the *same* tile so legitimate
    // two-tile swaps (swap mode) don't accidentally reveal the reference.
    // Board/piece targets (jigsaw, polygram, diamond) still reveal on any
    // quick double-tap anywhere.
    const sameTarget = tile ? tile === lastTapTile : true
    if (quickRepeat && sameTarget) {
      dblHandled = true
      toggleReference()
      lastTapTime = 0
      lastTapTile = null
    } else {
      dblHandled = false
      lastTapTime = now
      lastTapTile = tile
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
        // Keep the full puzzle payload (categories etc.) that the caller set
        // so Restart can re-resolve the current image URL from it. Only
        // replace it when it's missing or for a different date.
        if (!state.puzzle?.categories || state.puzzle.date !== resumeRun.puzzleDate) {
          state.puzzle = { date: resumeRun.puzzleDate }
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
      timerState.started = isResume
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
          if (!timerState.started && initDone) {
            timerState.started = true
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
          const completedRun = currentRun

          // Celebration confetti
          const workspace = document.querySelector('.workspace')
          if (workspace) createConfettiOverlay(workspace)

          const durationLabel = formatDuration(currentRun.elapsedActiveMs)

          setStatus(
            `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Submitting...`,
            'ok',
          )

          let rank = null
          let bestMs = null
          let previousBestMs = null
          let submissionRank = null
          let submissionElapsedMs = currentRun.elapsedActiveMs
          let leaderboardEntries = null
          let totalEntries = 0

          try {
            const result = await submitLeaderboard(currentRun)
            rank = result.rank
            bestMs = Number.isFinite(result.bestMs) ? result.bestMs : null
            previousBestMs = Number.isFinite(result.previousBestMs) ? result.previousBestMs : null
            submissionRank = Number.isFinite(result.submissionRank) ? result.submissionRank : null
            if (Number.isFinite(result.submissionElapsedMs)) submissionElapsedMs = result.submissionElapsedMs
            if (Number.isFinite(result.totalEntries)) totalEntries = result.totalEntries

            const lb = await fetchLeaderboard(
              currentRun.puzzleDate,
              currentRun.gameMode,
              100,
            )
            leaderboardEntries = lb.entries || []
            if (Number.isFinite(lb.totalEntries)) totalEntries = lb.totalEntries
          } catch {
            // Non-fatal
          }

          const presentOverlay = () => showCompletionOverlay({
            gameMode,
            duration: durationLabel,
            elapsedMs: currentRun.elapsedActiveMs,
            rank,
            bestMs,
            previousBestMs,
            submissionRank,
            submissionElapsedMs,
            leaderboardEntries,
            totalEntries,
            playerGuid,
            completedRun,
          })

          // Prompt for a leaderboard name on every completion until the
          // player actually sets one. Saving enables server sync so the
          // name propagates. Skip just continues to the overlay.
          const hasName = !!(getProfileName() || '').trim()
          if (!hasName) {
            showNameDialog({
              onDone: (result) => {
                if (result && result.name) {
                  try {
                    setProfileName(result.name)
                    if (!isSyncEnabled()) enableSync(playerGuid).catch(() => {})
                  } catch (e) {
                    console.error('Failed to save profile name', e)
                  }
                }
                presentOverlay()
              },
            })
          } else {
            presentOverlay()
          }

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

function initAppShell() {
  applyLandscapeLayout()
  app.innerHTML = NAV_HTML

  const topNav = document.querySelector('#topNav')
  const topTabs = [...document.querySelectorAll('#navTabs .nav-tab')]

  function switchPage(pageName) {
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
    } else if (pageName === 'archive') {
      if (!archiveRendered) renderArchivePage()
    } else if (pageName === 'settings') {
      renderSettingsPage()
    }
  }

  window.switchToPage = switchPage

  topTabs.forEach((tab) => tab.addEventListener('click', () => switchPage(tab.dataset.page)))

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
      <button type="button" id="sync-now-btn" class="sync-now-btn">Sync Now</button>
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

    const syncNowBtn = syncEl.querySelector('#sync-now-btn')
    const syncStatusEl = syncEl.querySelector('#sync-status-msg')
    syncNowBtn.addEventListener('click', async () => {
      syncNowBtn.disabled = true
      const originalLabel = syncNowBtn.textContent
      syncNowBtn.textContent = 'Syncing...'
      syncStatusEl.textContent = ''
      syncStatusEl.className = 'sync-status'
      try {
        const result = await forcePush()
        if (result && result.pulledChanges) {
          syncStatusEl.textContent = `Synced. Pulled changes (rev ${result.revAfter}).`
        } else if (result && result.ran) {
          syncStatusEl.textContent = `Synced. No new remote changes (rev ${result.revAfter}).`
        } else {
          syncStatusEl.textContent = 'Synced.'
        }
        syncStatusEl.className = 'sync-status sync-status-ok'
        // Re-render the launcher on next home-page visit so any newly-pulled
        // completions show up. Triggering it now is safe because settings is
        // an overlay on top of the launcher.
        renderLauncher()
      } catch (err) {
        syncStatusEl.textContent = err?.message || 'Sync failed.'
        syncStatusEl.className = 'sync-status sync-status-error'
      } finally {
        syncNowBtn.textContent = originalLabel
        syncNowBtn.disabled = false
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

onConflict((conflicts) => {
  showSyncConflictModal(Array.isArray(conflicts) ? conflicts : [])
})

// When a background pull brings in new remote data (another device's
// completion, etc.), refresh the launcher so freshly-synced pills are
// visible without the user having to hit Sync Now or navigate away and
// back. Guarded to currentPage === 'play' so we don't clobber a game
// in progress or a settings view the user is editing.
onRemoteChanged(() => {
  if (currentPage === 'play') renderLauncher()
})

function showSyncConflictModal(conflicts = []) {
  const existing = document.querySelector('#sync-conflict-modal')
  if (existing) existing.remove()

  const formatRun = (run) => {
    if (!run) return '—'
    const elapsed = Number(run.elapsedActiveMs) || 0
    const when = run.updatedAt ? new Date(run.updatedAt).toLocaleString() : 'unknown'
    return `${formatDuration(elapsed)} elapsed · last saved ${when}`
  }

  const puzzleSummaries = conflicts.length
    ? conflicts
        .map((c) => `
          <li class="sync-conflict-item">
            <div class="sync-conflict-item-title">${MODE_LABELS[c.gameMode] || c.gameMode} · ${c.puzzleDate}</div>
            <div class="sync-conflict-item-row"><strong>This device:</strong> ${formatRun(c.local)}</div>
            <div class="sync-conflict-item-row"><strong>Other device:</strong> ${formatRun(c.remote)}</div>
          </li>
        `)
        .join('')
    : ''

  const overlay = document.createElement('div')
  overlay.id = 'sync-conflict-modal'
  overlay.className = 'sync-conflict-overlay'
  overlay.innerHTML = `
    <div class="sync-conflict-dialog">
      <h3 class="sync-conflict-title">Progress conflict</h3>
      <p class="sync-conflict-text">Another device has different progress on ${conflicts.length > 1 ? 'these puzzles' : 'this puzzle'}. Which version do you want to keep?</p>
      ${puzzleSummaries ? `<ul class="sync-conflict-list">${puzzleSummaries}</ul>` : ''}
      <div class="sync-conflict-actions">
        <button type="button" class="sync-conflict-btn sync-conflict-btn-local" id="sync-keep-local">Keep this device</button>
        <button type="button" class="sync-conflict-btn sync-conflict-btn-remote" id="sync-use-remote">Use other device</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  overlay.querySelector('#sync-keep-local').addEventListener('click', async () => {
    overlay.remove()
    await resolveConflict('local')
  })

  overlay.querySelector('#sync-use-remote').addEventListener('click', async () => {
    overlay.remove()
    await resolveConflict('remote')
    if (typeof window.switchToPage === 'function') {
      window.switchToPage('play')
    }
  })
}

// ─── Service Worker Registration ───

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

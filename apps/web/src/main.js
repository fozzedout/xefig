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
  getPendingActiveConflicts,
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
let activeTimerArmed = false
let autosaveIntervalId = null
let gameVisibilityBound = false
// `let` rather than `const` because linkSync replaces the local GUID with
// the shared profile's — anything captured at boot would otherwise stay
// stale and break leaderboard "is me" matching until the next reload.
let playerGuid = getPlayerGuid()
function refreshPlayerGuid() { playerGuid = getPlayerGuid() }
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

let musicFadeTimer = null

function pauseMusicTemporary() {
  if (!musicAudio || musicAudio.paused) return
  clearTimeout(musicFadeTimer)
  const gain = tryEnsureAudioGraph()
  if (gain && audioContext) {
    const now = audioContext.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(gain.gain.value, now)
    gain.gain.linearRampToValueAtTime(0.0001, now + 0.8)
    musicFadeTimer = setTimeout(() => { if (musicAudio) musicAudio.pause() }, 850)
  } else {
    let step = 0
    const startVol = musicAudio.volume
    const fadeOut = () => {
      step++
      const t = Math.min(step / 16, 1)
      musicAudio.volume = startVol * (1 - t)
      if (t < 1) musicFadeTimer = setTimeout(fadeOut, 50)
      else musicAudio.pause()
    }
    fadeOut()
  }
}

function resumeMusicIfEnabled() {
  if (!musicShouldPlay) return
  clearTimeout(musicFadeTimer)
  const audio = ensureMusicAudio()
  const gain = tryEnsureAudioGraph()
  resumeAudioContextIfNeeded()
  if (gain && audioContext) {
    const vol = getMusicVolume()
    const now = audioContext.currentTime
    gain.gain.cancelScheduledValues(now)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(vol, now + 1.2)
  } else {
    audio.volume = 0
    const vol = getMusicVolume()
    let step = 0
    const fadeIn = () => {
      step++
      const t = Math.min(step / 24, 1)
      audio.volume = vol * t
      if (t < 1) musicFadeTimer = setTimeout(fadeIn, 50)
    }
    fadeIn()
  }
  audio.play().catch(() => {})
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    pauseMusicTemporary()
  } else {
    resumeMusicIfEnabled()
    pullOnForeground()
    handleDayRollover()
  }
})
window.addEventListener('blur', pauseMusicTemporary)
window.addEventListener('focus', () => {
  resumeMusicIfEnabled()
  pullOnForeground()
  handleDayRollover()
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
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
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
  // 'more' is a legacy value from when the More slice expanded inline. The
  // sheet-based design has no expanded More state, so fall back to the day's
  // pick instead of letting nothing be focused.
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
  activeTimerArmed = true
}

// Freeze the active timer at an exact elapsed — used by the BETA
// Mostly-solve hook so the submitted time equals the tester's set
// target precisely, without the live wall-clock delta that accumulates
// between "set target" and the final tap.
function setFixedActiveElapsed(ms) {
  activeElapsedBaseMs = Math.max(0, Number(ms) || 0)
  activeStartedAtMs = null
  activeTimerArmed = true
}

function isSessionActive() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

function pauseActiveTimer() {
  if (!activeTimerArmed || activeStartedAtMs === null) {
    return
  }
  activeElapsedBaseMs += Math.max(0, getNowMs() - activeStartedAtMs)
  activeStartedAtMs = null
}

function resumeActiveTimer() {
  if (!activeTimerArmed || activeStartedAtMs !== null || !isSessionActive()) {
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

  // Only advance updatedAt when the puzzle state actually changed. Bumping
  // it on every idle autosave makes storage drift ahead of what the beacon
  // pushed and what the server echoes back, triggering spurious sync
  // conflicts where both sides are really the same saved position.
  const nextRun = {
    ...currentRun,
    elapsedActiveMs: elapsed,
    updatedAt: puzzleChanged ? new Date().toISOString() : (currentRun.updatedAt || new Date().toISOString()),
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
  const requestDate = date || today
  const isTodayRequest = requestDate === today
  const cachedToday = isTodayRequest ? getCachedDailyPayload(today) : null

  if (isTodayRequest && window.__earlyPuzzle) {
    const earlyPromise = window.__earlyPuzzle
    window.__earlyPuzzle = null

    try {
      const early = await Promise.race([
        earlyPromise,
        timeoutAfter(EARLY_PUZZLE_WAIT_MS, 'Timed out waiting for early puzzle fetch.'),
      ])
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

  const endpoint = `/api/puzzles/${encodeURIComponent(requestDate)}`
  try {
    const payload = await fetchPuzzlePayloadFromApi(apiUrl(endpoint))
    if (isTodayRequest) cacheDailyPayload(payload)
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

function bindMoreSheetSyncIndicator(sheetEl) {
  // Sync status rides on the Devices card as a small dot. The card now lives
  // inside the More sheet; this wires the dot + status update + onStatusChange
  // subscription, and returns a teardown to call when the sheet closes.
  const card = sheetEl.querySelector('#more-devices-card')
  if (!card) return () => {}
  const dot = card.querySelector('.more-card-sync-dot')
  if (!dot) return () => {}
  const apply = (status) => {
    const hasChanges = hasPendingChanges()
    let dotState = 'saved'
    let label = 'Saved to cloud — tap to send to another device'
    if (status === 'syncing') {
      dotState = 'syncing'; label = 'Syncing...'
    } else if (status === 'error') {
      dotState = 'error'; label = 'Sync failed — open Settings to retry'
    } else if (hasChanges) {
      dotState = 'pending'; label = 'Pending changes — syncing soon'
    }
    dot.dataset.state = dotState
    card.title = label
    card.setAttribute('aria-label', label)
  }
  apply(getSyncStatus())
  const off = onStatusChange(apply)
  return typeof off === 'function' ? off : () => {}
}

// ─── PWA install detection ──────────────────────────────────────────────────
let deferredInstallPrompt = null
let installPromptListenersBound = false
function bindInstallPromptListeners() {
  if (installPromptListenersBound) return
  installPromptListenersBound = true
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstallPrompt = e
    // If the More sheet is open, refresh it so the Install card appears.
    const open = document.querySelector('.more-sheet-overlay')
    if (open && typeof open.__rerender === 'function') open.__rerender()
  })
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
    const open = document.querySelector('.more-sheet-overlay')
    if (open && typeof open.__rerender === 'function') open.__rerender()
  })
}

function isStandaloneDisplay() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true
  } catch {}
  return false
}

function isIosSafari() {
  const ua = navigator.userAgent || ''
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && navigator.maxTouchPoints > 1)
  if (!isIos) return false
  // Strip out Chrome / Firefox / Edge on iOS — they all carry "CriOS"/"FxiOS"/"EdgiOS".
  return !/CriOS|FxiOS|EdgiOS/.test(ua)
}

function getInstallState() {
  if (isStandaloneDisplay()) return 'standalone'
  if (deferredInstallPrompt) return 'available'
  if (isIosSafari()) return 'ios-safari'
  return 'unavailable'
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
          <div class="slice slice-more" style="--flex: ${MORE_INACTIVE_FLEX};">
            <div class="slice-overlay"></div>
            <div class="slice-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="19" cy="12" r="2"/>
              </svg>
            </div>
            <div class="slice-title">More</div>
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
        if (s.classList.contains('slice-more')) {
          // More never expands inline now — it stays at its inactive flex and
          // delegates everything to the modal sheet on tap.
          s.classList.remove('active')
          s.style.setProperty('--flex', MORE_INACTIVE_FLEX)
          return
        }
        const isActive = i === index
        s.classList.toggle('active', isActive)
        s.style.setProperty('--flex', isActive ? ACTIVE_FLEX : INACTIVE_FLEX)
      })
      const activated = slices[index]
      if (activated && !activated.classList.contains('slice-more')) {
        if (activated.dataset.mode) setLauncherFocus(activated.dataset.mode)
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

      // More slice — opens a modal sheet rather than expanding inline.
      if (slice.classList.contains('slice-more')) {
        slice.addEventListener('click', () => {
          openMoreSheet({
            puzzleDate: state.puzzle?.date || todayDate,
            handleSliceClick,
          })
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
let archiveLastFocusKey = null
// Set by renderArchivePage so returnFromGame can refresh the calendar (and
// any open day-detail sheet) for a single (date, mode) pair without
// rebuilding the page.
let updateArchiveThumb = null
const ARCHIVE_ACCENT_MAP = {
  [GAME_MODE_JIGSAW]: '#f0c040',
  [GAME_MODE_SLIDING]: '#40d0f0',
  [GAME_MODE_SWAP]: '#50d070',
  [GAME_MODE_POLYGRAM]: '#a060f0',
  [GAME_MODE_DIAMOND]: '#e070a0',
}
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// Petal positions match brand favicon: diamond at 0° after the -20° root
// rotation, then sliding/polygram/jigsaw/swap clockwise. baseRot is applied
// to both the petal and its matching star arm so a completed mode lights
// up its colour wedge AND fills in that arm of the central gold star.
const ARCHIVE_GLYPH_MODES = [
  { key: GAME_MODE_DIAMOND,  color: '#e070a0', baseRot: 0 },
  { key: GAME_MODE_SLIDING,  color: '#40d0f0', baseRot: 72 },
  { key: GAME_MODE_POLYGRAM, color: '#a060f0', baseRot: 144 },
  { key: GAME_MODE_JIGSAW,   color: '#f0c040', baseRot: 216 },
  { key: GAME_MODE_SWAP,     color: '#50d070', baseRot: 288 },
]
const ARCHIVE_MODES = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND]

const ARCHIVE_SVG_DEFS_HTML = `
  <svg class="archive-svg-defs" width="0" height="0" aria-hidden="true">
    <defs>
      <path id="xefig-petal" d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z"/>
      <polygon id="xefig-arm" points="0,0 -9.9,-13.6 0,-44 9.9,-13.6"/>
      <polygon id="xefig-star-outline" points="0,-44 9.9,-13.6 41.9,-13.6 16,5.2 25.9,35.6 0,16.8 -25.9,35.6 -16,5.2 -41.9,-13.6 -9.9,-13.6"/>
      <linearGradient id="gold-grad" x1="0" y1="-1" x2="0" y2="1">
        <stop offset="0"   stop-color="#fcd97a"/>
        <stop offset="0.5" stop-color="#f0c040"/>
        <stop offset="1"   stop-color="#a87a1a"/>
      </linearGradient>
    </defs>
  </svg>
`

function pointOnArchiveCircle(angleDeg, r) {
  const a = (angleDeg - 90) * Math.PI / 180
  return [Math.cos(a) * r, Math.sin(a) * r]
}

function makeArchiveGlyph({ done = [], inprogress = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg'
  const allDone = done.length === ARCHIVE_GLYPH_MODES.length
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '-100 -100 200 200')
  svg.classList.add('glyph')
  if (allDone) svg.dataset.complete = '1'
  if (inprogress && !allDone) svg.dataset.inprogress = '1'

  const ring = document.createElementNS(ns, 'circle')
  ring.setAttribute('r', '88')
  ring.classList.add('ring-bg')
  svg.appendChild(ring)

  const root = document.createElementNS(ns, 'g')
  root.setAttribute('transform', 'rotate(-20)')

  const ghost = document.createElementNS(ns, 'use')
  ghost.setAttribute('href', '#xefig-star-outline')
  ghost.classList.add('star-ghost')
  root.appendChild(ghost)

  const doneSet = new Set(done)
  ARCHIVE_GLYPH_MODES.forEach((m) => {
    const g = document.createElementNS(ns, 'g')
    g.setAttribute('data-mode', m.key)
    if (doneSet.has(m.key)) g.dataset.done = '1'

    const petal = document.createElementNS(ns, 'use')
    petal.setAttribute('href', '#xefig-petal')
    petal.setAttribute('transform', `rotate(${m.baseRot})`)
    petal.setAttribute('fill', m.color)
    petal.classList.add('petal')
    g.appendChild(petal)

    const arm = document.createElementNS(ns, 'use')
    arm.setAttribute('href', '#xefig-arm')
    arm.setAttribute('transform', `rotate(${m.baseRot})`)
    arm.classList.add('arm')
    g.appendChild(arm)

    root.appendChild(g)
  })

  svg.appendChild(root)
  return svg
}

function appendArchiveCentralGlyph(svg, scale) {
  const ns = 'http://www.w3.org/2000/svg'
  const g = document.createElementNS(ns, 'g')
  g.setAttribute('transform', `scale(${scale})`)

  const petalRoot = document.createElementNS(ns, 'g')
  petalRoot.setAttribute('transform', 'rotate(-20)')
  ARCHIVE_GLYPH_MODES.forEach((m) => {
    const petal = document.createElementNS(ns, 'use')
    petal.setAttribute('href', '#xefig-petal')
    petal.setAttribute('transform', `rotate(${m.baseRot})`)
    petal.setAttribute('fill', m.color)
    petal.setAttribute('opacity', '0.95')
    petalRoot.appendChild(petal)
  })
  g.appendChild(petalRoot)

  const starRoot = document.createElementNS(ns, 'g')
  starRoot.setAttribute('transform', 'rotate(-20)')
  ARCHIVE_GLYPH_MODES.forEach((m) => {
    const arm = document.createElementNS(ns, 'use')
    arm.setAttribute('href', '#xefig-arm')
    arm.setAttribute('transform', `rotate(${m.baseRot})`)
    arm.setAttribute('fill', '#FFD700')
    starRoot.appendChild(arm)
  })
  g.appendChild(starRoot)

  svg.appendChild(g)
}

function buildWeekMedal({ completed = [], totalDays = 7 }) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('tier-svg')
  svg.setAttribute('viewBox', '-100 -100 200 200')
  const completedSet = new Set(completed)
  const isComplete = totalDays > 0 && completedSet.size === totalDays
  const frame = document.createElementNS(ns, 'circle')
  frame.setAttribute('r', '82')
  frame.setAttribute('class', isComplete ? 'gold-ring' : 'frame-ring')
  svg.appendChild(frame)
  appendArchiveCentralGlyph(svg, 0.55)
  for (let i = 0; i < totalDays; i++) {
    const angle = (360 / totalDays) * i - 90
    const [x, y] = pointOnArchiveCircle(angle + 90, 70)
    const pip = document.createElementNS(ns, 'circle')
    pip.setAttribute('cx', x.toFixed(2))
    pip.setAttribute('cy', y.toFixed(2))
    pip.setAttribute('r', '8')
    pip.setAttribute('class', completedSet.has(i) ? 'pip-filled' : 'pip-empty')
    svg.appendChild(pip)
  }
  return svg
}

function buildMonthMedal({ completed = [], totalDays = 30 }) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('tier-svg')
  svg.setAttribute('viewBox', '-100 -100 200 200')
  const completedSet = new Set(completed)
  const isComplete = totalDays > 0 && completedSet.size === totalDays
  const frame = document.createElementNS(ns, 'circle')
  frame.setAttribute('r', '95')
  frame.setAttribute('class', isComplete ? 'gold-ring' : 'frame-ring')
  svg.appendChild(frame)
  appendArchiveCentralGlyph(svg, 0.55)
  for (let i = 0; i < totalDays; i++) {
    const angle = (360 / totalDays) * i
    const a = (angle - 90) * Math.PI / 180
    const x1 = Math.cos(a) * 75, y1 = Math.sin(a) * 75
    const x2 = Math.cos(a) * 93, y2 = Math.sin(a) * 93
    const tick = document.createElementNS(ns, 'line')
    tick.setAttribute('x1', x1.toFixed(2))
    tick.setAttribute('y1', y1.toFixed(2))
    tick.setAttribute('x2', x2.toFixed(2))
    tick.setAttribute('y2', y2.toFixed(2))
    tick.setAttribute('class', completedSet.has(i) ? 'tick-filled' : 'tick-empty')
    svg.appendChild(tick)
  }
  return svg
}

function getDayCompletionGlyphData(dateKey) {
  const completed = getCompletedModesForDate(dateKey)
  const done = ARCHIVE_GLYPH_MODES.map((m) => m.key).filter((k) => completed.has(k))
  const inprogress = ARCHIVE_MODES.some((m) => hasActiveRun(dateKey, m))
  return { done, inprogress }
}

function isoDateAdd(dateKey, days) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
}

function renderArchivePage() {
  const pageEl = document.querySelector('#page-archive')
  const todayDate = getIsoDate(new Date())
  const todayParts = todayDate.split('-').map(Number)
  const todayYear = todayParts[0]
  const currentMonthIndex = todayParts[1] - 1
  state.sourceMode = 'archive'
  state.difficulty = state.difficulty || 'medium'

  pageEl.innerHTML = `
    <div class="archive-page">
      <div class="archive-top-bar">
        <button class="page-back-btn" data-page="play" aria-label="Back to menu">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <h2>Archive</h2>
        <div class="archive-top-spacer"></div>
      </div>
      <div class="cal-region">
        <div class="cal-nav">
          <button class="cal-nav-arrow" data-action="prev" aria-label="Previous month">‹</button>
          <button class="cal-nav-title" data-action="open-year">
            <span class="medal-mini" data-role="nav-medal"></span>
            <span class="month-name" data-role="nav-month-name"></span>
            <span class="year-label" data-role="nav-year"></span>
            <span class="chevron">▾</span>
          </button>
          <button class="cal-nav-arrow" data-action="next" aria-label="Next month">›</button>
        </div>
        <button class="archive-resume-btn" data-role="archive-resume-btn" hidden></button>
        <div class="cal-deck" data-role="cal-deck"></div>
        <div class="cal-dots" data-role="cal-dots"></div>
      </div>
    </div>
    <div class="day-detail-overlay" data-role="day-detail" hidden>
      <div class="day-detail-backdrop"></div>
      <div class="day-detail-sheet" role="dialog" aria-modal="true" aria-labelledby="day-detail-title">
        <button class="day-detail-close" data-role="day-detail-close" aria-label="Close">×</button>
        <div class="day-detail-head">
          <div class="day-detail-title" id="day-detail-title" data-role="day-detail-title"></div>
          <div class="day-detail-sub" data-role="day-detail-sub"></div>
        </div>
        <div class="day-detail-thumbs" data-role="day-detail-thumbs"></div>
      </div>
    </div>
    <div class="year-picker" data-role="year-picker" hidden>
      <div class="year-picker-backdrop"></div>
      <div class="year-picker-sheet" role="dialog" aria-modal="true">
        <button class="year-picker-close" data-role="year-picker-close" aria-label="Close">×</button>
        <div class="year-picker-nav">
          <button class="cal-nav-arrow" data-action="yp-prev-year" aria-label="Previous year" disabled>‹</button>
          <div class="year-picker-year" data-role="year-picker-year"></div>
          <button class="cal-nav-arrow" data-action="yp-next-year" aria-label="Next year" disabled>›</button>
        </div>
        <div class="year-picker-grid" data-role="year-picker-grid"></div>
      </div>
    </div>
  `

  pageEl.querySelector('.page-back-btn').addEventListener('click', () => window.switchToPage('play'))

  const monthCards = []
  const deck = pageEl.querySelector('[data-role="cal-deck"]')
  const dotsEl = pageEl.querySelector('[data-role="cal-dots"]')
  const navMedalSlot = pageEl.querySelector('[data-role="nav-medal"]')
  const navMonthNameEl = pageEl.querySelector('[data-role="nav-month-name"]')
  const navYearEl = pageEl.querySelector('[data-role="nav-year"]')
  const prevBtn = pageEl.querySelector('[data-action="prev"]')
  const nextBtn = pageEl.querySelector('[data-action="next"]')
  const titleBtn = pageEl.querySelector('[data-action="open-year"]')

  const detailOverlay = pageEl.querySelector('[data-role="day-detail"]')
  const detailTitleEl = pageEl.querySelector('[data-role="day-detail-title"]')
  const detailSubEl = pageEl.querySelector('[data-role="day-detail-sub"]')
  const detailThumbsEl = pageEl.querySelector('[data-role="day-detail-thumbs"]')

  const yearPickerEl = pageEl.querySelector('[data-role="year-picker"]')
  const yearPickerYearEl = pageEl.querySelector('[data-role="year-picker-year"]')
  const yearPickerGridEl = pageEl.querySelector('[data-role="year-picker-grid"]')

  let openDetailDate = null
  let activeMonthIndex = currentMonthIndex

  function isLockedDate(dateKey) {
    return dateKey < ARCHIVE_START_DATE || dateKey > todayDate
  }

  function daysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  }

  function buildMonthCardEl(year, monthIndex) {
    const card = document.createElement('div')
    card.className = 'month-card'
    card.dataset.month = monthIndex

    const dow = document.createElement('div')
    dow.className = 'dow'
    DAY_NAMES.forEach((n) => {
      const span = document.createElement('span')
      span.textContent = n.slice(0, 3)
      dow.appendChild(span)
    })
    card.appendChild(dow)

    const grid = document.createElement('div')
    grid.className = 'grid'
    const weekStrip = document.createElement('div')
    weekStrip.className = 'week-strip'

    const total = daysInMonth(year, monthIndex)
    const startOffset = new Date(year, monthIndex, 1).getDay()

    const weeks = []
    const seq = []
    for (let i = 0; i < startOffset; i++) seq.push(null)
    for (let d = 1; d <= total; d++) seq.push(d)
    while (seq.length < 42) seq.push(null)

    for (let rowStart = 0; rowStart < 42; rowStart += 7) {
      const row = seq.slice(rowStart, rowStart + 7)
      const weekDates = []
      let weekHasContent = false
      const rowHasDay = row.some((d) => d != null)

      row.forEach((dayNum) => {
        const cell = document.createElement('div')
        if (dayNum == null) {
          cell.className = rowHasDay ? 'day outside' : 'day spacer'
        } else {
          const dateKey = getIsoDate(new Date(year, monthIndex, dayNum))
          const isToday = dateKey === todayDate
          const locked = isLockedDate(dateKey)
          cell.className = 'day' + (isToday ? ' today' : '') + (locked && !isToday ? ' locked' : '')
          cell.dataset.date = dateKey
          const num = document.createElement('div')
          num.className = 'num'
          num.textContent = dayNum
          cell.appendChild(num)
          const data = locked ? { done: [], inprogress: false } : getDayCompletionGlyphData(dateKey)
          cell.appendChild(makeArchiveGlyph({ done: data.done, inprogress: data.inprogress || (isToday && !locked) }))
          weekDates.push({ dateKey, locked })
          weekHasContent = true
        }
        grid.appendChild(cell)
      })

      if (weekHasContent) {
        const wk = document.createElement('div')
        wk.className = 'week-cell'
        const lbl = document.createElement('div')
        lbl.className = 'w-label'
        wk.appendChild(buildWeekMedal({ completed: [], totalDays: weekDates.length }))
        wk.appendChild(lbl)
        weekStrip.appendChild(wk)
        weeks.push({ weekDates, cell: wk, label: lbl })
      }
    }

    // "wk" header sits at the top of the week column — visible only in
    // landscape where the column reads as a vertical track alongside the days.
    const wkHeader = document.createElement('div')
    wkHeader.className = 'wk-header'
    wkHeader.textContent = 'wk'

    // Background panel painted behind the week column in landscape. Lives in
    // the grid so it can span column 8 across all rows; hidden in portrait.
    const weekColBg = document.createElement('div')
    weekColBg.className = 'week-col-bg'

    const hero = document.createElement('div')
    hero.className = 'month-hero'
    hero.dataset.role = 'month-hero'

    // cal-square holds the calendar surface (dow + days + week medals + wk
    // header + column background). The hero (medal + counter) sits beside it
    // as a sibling so landscape can flex them as [hero | cal-square] without
    // the hero competing for a grid cell.
    const square = document.createElement('div')
    square.className = 'cal-square'
    square.appendChild(weekColBg)
    square.appendChild(dow)
    square.appendChild(grid)
    square.appendChild(weekStrip)
    square.appendChild(wkHeader)
    card.replaceChildren(square, hero)
    return { card, weeks, hero }
  }

  function refreshMonthMedals(monthIndex) {
    const entry = monthCards[monthIndex]
    if (!entry) return
    entry.weeks.forEach(({ weekDates, cell, label }) => {
      const completedIdx = []
      let total = 0
      weekDates.forEach(({ dateKey, locked }, i) => {
        if (locked) return
        total += 1
        if (getCompletedModesForDate(dateKey).size === ARCHIVE_GLYPH_MODES.length) {
          completedIdx.push(i)
        }
      })
      cell.replaceChild(buildWeekMedal({ completed: completedIdx, totalDays: weekDates.length }), cell.firstChild)
      label.textContent = total ? `${completedIdx.length}/${total}` : '—'
    })
  }

  function buildMonthMedalForCalendar(monthIndex) {
    const total = daysInMonth(todayYear, monthIndex)
    const completedIdx = []
    let playable = 0
    for (let d = 1; d <= total; d++) {
      const dateKey = getIsoDate(new Date(todayYear, monthIndex, d))
      if (isLockedDate(dateKey)) continue
      playable += 1
      if (getCompletedModesForDate(dateKey).size === ARCHIVE_GLYPH_MODES.length) {
        completedIdx.push(d - 1)
      }
    }
    return { svg: buildMonthMedal({ completed: completedIdx, totalDays: total }), completedIdx, playable, total }
  }

  function refreshDots() {
    Array.from(dotsEl.children).forEach((dot, i) => {
      dot.classList.toggle('current', i === activeMonthIndex)
      const meta = buildMonthMedalForCalendar(i)
      dot.classList.remove('has-progress', 'month-perfect')
      if (meta.playable && meta.completedIdx.length === meta.total) dot.classList.add('month-perfect')
      else if (meta.completedIdx.length > 0) dot.classList.add('has-progress')
    })
  }

  for (let m = 0; m < 12; m++) {
    const built = buildMonthCardEl(todayYear, m)
    monthCards.push({ el: built.card, weeks: built.weeks, hero: built.hero, year: todayYear })
    deck.appendChild(built.card)
  }
  function refreshMonthHero(monthIndex) {
    const entry = monthCards[monthIndex]
    if (!entry || !entry.hero) return
    const meta = buildMonthMedalForCalendar(monthIndex)

    // Title row above the medal — month name + year, clickable to open the
    // year picker. Shown in landscape (where the top cal-nav is hidden) and
    // in portrait (a quiet duplicate of the cal-nav title that anchors the
    // hero block).
    const title = document.createElement('button')
    title.type = 'button'
    title.className = 'month-hero-title'
    title.setAttribute('aria-label', `Pick month for ${entry.year}`)
    const titleMonth = document.createElement('span')
    titleMonth.className = 'month-hero-title-month'
    titleMonth.textContent = MONTH_NAMES[monthIndex]
    const titleYear = document.createElement('span')
    titleYear.className = 'month-hero-title-year'
    titleYear.textContent = String(entry.year)
    title.append(titleMonth, titleYear)
    title.addEventListener('click', openYearPicker)

    const wrap = document.createElement('div')
    wrap.className = 'month-hero-medal'
    wrap.appendChild(buildMonthMedal({ completed: meta.completedIdx, totalDays: meta.total }))

    const counter = document.createElement('div')
    counter.className = 'month-hero-counter'
    let counterText
    let subText
    if (!meta.playable) {
      counterText = `0 / ${meta.total}`
      subText = monthIndex > currentMonthIndex ? 'upcoming' : 'pre-launch'
    } else {
      counterText = `${meta.completedIdx.length} / ${meta.playable}`
      const pct = Math.round((meta.completedIdx.length / meta.playable) * 100)
      subText = meta.completedIdx.length === 0 ? 'untouched' : `${pct}% earned`
    }
    const num = document.createElement('span')
    num.className = 'month-hero-counter-num'
    num.textContent = counterText
    const unit = document.createElement('span')
    unit.className = 'month-hero-counter-unit'
    unit.textContent = ' days'
    counter.append(num, unit)

    const sub = document.createElement('div')
    sub.className = 'month-hero-sub'
    sub.textContent = subText

    entry.hero.replaceChildren(title, wrap, counter, sub)
  }
  for (let m = 0; m < 12; m++) refreshMonthHero(m)

  for (let i = 0; i < 12; i++) {
    const dot = document.createElement('div')
    dot.className = 'dot'
    dot.dataset.month = i
    dot.addEventListener('click', () => jumpToMonth(i))
    dotsEl.appendChild(dot)
  }

  function updateNav() {
    const meta = buildMonthMedalForCalendar(activeMonthIndex)
    navMedalSlot.replaceChildren(buildMonthMedal({ completed: meta.completedIdx, totalDays: meta.total }))
    navMonthNameEl.textContent = MONTH_NAMES[activeMonthIndex]
    navYearEl.textContent = String(todayYear)
    prevBtn.disabled = activeMonthIndex === 0
    nextBtn.disabled = activeMonthIndex === 11
  }

  function captionForMonth(monthIndex) {
    const meta = buildMonthMedalForCalendar(monthIndex)
    const monthName = MONTH_NAMES[monthIndex]
    if (!meta.playable) {
      return monthIndex > currentMonthIndex
        ? `${monthName} · ${meta.total} days · upcoming`
        : `${monthName} · ${meta.total} days · pre-launch`
    }
    if (meta.completedIdx.length === 0) {
      return `${monthName} · ${meta.playable} playable days · untouched`
    }
    const pct = Math.round((meta.completedIdx.length / meta.playable) * 100)
    return `${monthName} · ${meta.completedIdx.length} / ${meta.playable} days · ${pct}% earned`
  }

  function centerScrollLeftFor(index) {
    const card = deck.children[index]
    if (!card) return 0
    const cardRect = card.getBoundingClientRect()
    const deckRect = deck.getBoundingClientRect()
    const cardLeftInDeck = (cardRect.left - deckRect.left) + deck.scrollLeft
    return cardLeftInDeck + cardRect.width / 2 - deck.clientWidth / 2
  }

  function snappedIndex() {
    const deckRect = deck.getBoundingClientRect()
    const deckCenter = deckRect.left + deckRect.width / 2
    let best = 0, bestDist = Infinity
    Array.from(deck.children).forEach((c, i) => {
      const r = c.getBoundingClientRect()
      const center = r.left + r.width / 2
      const dist = Math.abs(deckCenter - center)
      if (dist < bestDist) { bestDist = dist; best = i }
    })
    return best
  }

  function jumpToMonth(monthIndex) {
    if (monthIndex < 0 || monthIndex > 11) return
    activeMonthIndex = monthIndex
    const target = centerScrollLeftFor(monthIndex)
    const prev = deck.style.scrollSnapType
    deck.style.scrollSnapType = 'none'
    deck.scrollLeft = target
    requestAnimationFrame(() => {
      deck.style.scrollSnapType = prev || ''
    })
    updateNav()
    refreshDots()
  }

  let scrollTimer
  deck.addEventListener('scroll', () => {
    clearTimeout(scrollTimer)
    scrollTimer = setTimeout(() => {
      const i = snappedIndex()
      if (i !== activeMonthIndex) {
        activeMonthIndex = i
        updateNav()
        refreshDots()
      }
    }, 60)
  })

  prevBtn.addEventListener('click', () => {
    if (activeMonthIndex > 0) {
      deck.scrollTo({ left: centerScrollLeftFor(activeMonthIndex - 1), behavior: 'smooth' })
    }
  })
  nextBtn.addEventListener('click', () => {
    if (activeMonthIndex < 11) {
      deck.scrollTo({ left: centerScrollLeftFor(activeMonthIndex + 1), behavior: 'smooth' })
    }
  })

  function statusForMode(dateKey, mode) {
    if (hasActiveRun(dateKey, mode)) {
      const run = getRunForMode(dateKey, mode)
      const elapsed = run?.elapsedMs ?? run?.elapsed ?? 0
      return { kind: 'resume', label: elapsed ? formatDuration(elapsed) : '▶' }
    }
    if (getCompletedModesForDate(dateKey).has(mode)) {
      const entry = getCompletionEntry(dateKey, mode)
      return { kind: 'completed', label: entry?.bestElapsedMs ? formatDuration(entry.bestElapsedMs) : '✓' }
    }
    return { kind: 'new', label: 'new' }
  }

  function renderDetailThumbs(payload, dateKey) {
    detailThumbsEl.replaceChildren()
    ARCHIVE_MODES.forEach((mode) => {
      const accent = ARCHIVE_ACCENT_MAP[mode]
      const status = statusForMode(dateKey, mode)
      const isDiamond = mode === GAME_MODE_DIAMOND
      const fullImageUrl = resolvePuzzleImageUrl(payload, mode)
      const thumbUrl = resolvePuzzleThumbnailUrl(payload, mode)
      const thumb = document.createElement('button')
      thumb.className = `puzzle-thumb thumb-${status.kind}`
      thumb.dataset.mode = mode
      thumb.dataset.date = dateKey
      thumb.style.setProperty('--thumb-accent', accent)
      thumb.style.setProperty('--accent', accent)
      const imageHtml = isDiamond
        ? `<div class="thumb-image"><canvas class="diamond-grid-canvas thumb-grid-canvas" data-image-url="${fullImageUrl}" data-date="${dateKey}"></canvas></div>`
        : `<div class="thumb-image" style="background-image:url('${thumbUrl}')"></div>`
      thumb.innerHTML = `
        ${imageHtml}
        <div class="thumb-info">
          <div class="thumb-mode" style="color:${accent}">${MODE_LABELS[mode]}</div>
        </div>
        <div class="thumb-pill thumb-pill-${status.kind}">${status.label}</div>
      `
      thumb.addEventListener('click', () => handleThumbClick(payload, mode, dateKey))
      detailThumbsEl.appendChild(thumb)
    })
    if (typeof renderDiamondGridThumbnails === 'function') renderDiamondGridThumbnails(detailThumbsEl)
  }

  async function openDayDetail(dateKey) {
    if (isLockedDate(dateKey)) return
    openDetailDate = dateKey
    const d = new Date(Date.parse(`${dateKey}T00:00:00Z`))
    const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getUTCDay()]
    detailTitleEl.textContent = `${weekday}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`

    const completed = getCompletedModesForDate(dateKey).size
    const total = ARCHIVE_GLYPH_MODES.length
    detailSubEl.textContent = completed === total
      ? `All ${total} completed`
      : completed === 0
        ? `${total} puzzles`
        : `${completed} / ${total} completed`

    detailThumbsEl.innerHTML = `<div class="day-detail-loading">Loading puzzles...</div>`
    detailOverlay.hidden = false
    requestAnimationFrame(() => detailOverlay.classList.add('open'))

    try {
      const payload = await fetchPuzzlePayload({ date: dateKey })
      if (openDetailDate !== dateKey) return
      renderDetailThumbs(payload, dateKey)
    } catch {
      detailThumbsEl.innerHTML = `<div class="day-detail-loading">Couldn't load puzzles for this day.</div>`
    }
  }

  function closeDayDetail() {
    openDetailDate = null
    detailOverlay.classList.remove('open')
    setTimeout(() => { detailOverlay.hidden = true }, 200)
  }

  detailOverlay.querySelector('[data-role="day-detail-close"]').addEventListener('click', closeDayDetail)
  detailOverlay.querySelector('.day-detail-backdrop').addEventListener('click', closeDayDetail)

  function handleResumeFromBadge(puzzleDate, mode) {
    const savedRun = getRunForMode(puzzleDate, normalizeGameMode(mode))
    if (!savedRun) {
      openDayDetail(puzzleDate)
      return
    }
    archiveLastFocusKey = `${puzzleDate}:${mode}`
    state.sourceMode = 'archive'
    state.archiveDate = puzzleDate
    state.gameMode = normalizeGameMode(mode)
    state.imageUrl = resolveAssetUrl(savedRun.imageUrl)
    renderGame({ resumeRun: savedRun })
  }

  function handleThumbClick(puzzlePayload, mode, puzzleDate) {
    archiveLastFocusKey = `${puzzleDate}:${mode}`
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

  monthCards.forEach((entry) => {
    entry.el.querySelectorAll('.day[data-date]').forEach((dayEl) => {
      if (dayEl.classList.contains('locked')) return
      dayEl.addEventListener('click', () => {
        openDayDetail(dayEl.dataset.date)
      })
    })
  })

  function refreshYearPickerGrid() {
    yearPickerGridEl.replaceChildren()
    yearPickerYearEl.innerHTML = `${todayYear}<span class="yp-year-sub">Tap a month to jump</span>`
    for (let i = 0; i < 12; i++) {
      const cell = document.createElement('button')
      cell.className = 'year-picker-cell'
      if (i === activeMonthIndex) cell.classList.add('current')
      const meta = buildMonthMedalForCalendar(i)
      cell.appendChild(meta.svg)
      const lbl = document.createElement('div')
      lbl.className = 'yp-label'
      lbl.textContent = MONTH_NAMES_SHORT[i]
      cell.appendChild(lbl)
      const sub = document.createElement('div')
      sub.className = 'yp-sub'
      sub.textContent = !meta.playable
        ? (i > currentMonthIndex ? 'upcoming' : 'pre-launch')
        : `${meta.completedIdx.length}/${meta.playable}`
      cell.appendChild(sub)
      cell.addEventListener('click', () => {
        closeYearPicker()
        setTimeout(() => jumpToMonth(i), 0)
      })
      yearPickerGridEl.appendChild(cell)
    }
  }

  function openYearPicker() {
    refreshYearPickerGrid()
    yearPickerEl.hidden = false
    requestAnimationFrame(() => yearPickerEl.classList.add('open'))
  }
  function closeYearPicker() {
    yearPickerEl.classList.remove('open')
    setTimeout(() => { yearPickerEl.hidden = true }, 200)
  }
  function escClose(e) {
    if (e.key !== 'Escape') return
    if (!yearPickerEl.hidden) closeYearPicker()
    else if (!detailOverlay.hidden) closeDayDetail()
  }

  titleBtn.addEventListener('click', openYearPicker)
  yearPickerEl.querySelector('[data-role="year-picker-close"]').addEventListener('click', closeYearPicker)
  yearPickerEl.querySelector('.year-picker-backdrop').addEventListener('click', closeYearPicker)
  document.addEventListener('keydown', escClose)

  updateArchiveThumb = (date, _mode) => {
    const parts = date.split('-').map(Number)
    if (parts[0] !== todayYear) return
    const monthIdx = parts[1] - 1
    const entry = monthCards[monthIdx]
    if (!entry) return
    const dayEl = entry.el.querySelector(`.day[data-date="${date}"]`)
    if (dayEl) {
      const oldGlyph = dayEl.querySelector('.glyph')
      const data = getDayCompletionGlyphData(date)
      const isToday = date === todayDate
      const newGlyph = makeArchiveGlyph({ done: data.done, inprogress: data.inprogress || isToday })
      if (oldGlyph) oldGlyph.replaceWith(newGlyph)
    }
    refreshMonthMedals(monthIdx)
    refreshMonthHero(monthIdx)
    if (monthIdx === activeMonthIndex) updateNav()
    refreshDots()
    refreshArchiveResume()
    if (openDetailDate === date) {
      fetchPuzzlePayload({ date }).then((payload) => {
        if (openDetailDate === date) renderDetailThumbs(payload, date)
      }).catch(() => {})
    }
  }

  function refreshArchiveResume() {
    const btn = pageEl.querySelector('[data-role="archive-resume-btn"]')
    if (!btn) return
    pageEl.querySelectorAll('.day.resume-highlight').forEach((el) => el.classList.remove('resume-highlight'))
    let best = null
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('xefig:run:')) continue
      const run = readJsonStorage(key)
      if (!run || typeof run !== 'object') continue
      if (run.completed) continue
      if (!run.puzzleDate || !run.imageUrl || !run.difficulty) continue
      if (getCompletionEntry(run.puzzleDate, normalizeGameMode(run.gameMode || ''))) continue
      const updatedAt = Date.parse(run.updatedAt || run.startedAt || '')
      if (!Number.isFinite(updatedAt)) continue
      if (!best || updatedAt > best._updatedAtMs) {
        best = { ...run, gameMode: normalizeGameMode(run.gameMode), _updatedAtMs: updatedAt }
      }
    }
    if (!best) {
      btn.hidden = true
      return
    }
    const dayEl = pageEl.querySelector(`.day[data-date="${best.puzzleDate}"]`)
    if (dayEl) dayEl.classList.add('resume-highlight')
    btn.hidden = false
    const modeLabel = MODE_LABELS[best.gameMode] || best.gameMode
    btn.textContent = ''
    const modeSpan = document.createElement('span')
    modeSpan.className = 'archive-resume-mode'
    modeSpan.textContent = `Resume ${modeLabel}`
    const arrow = document.createElement('span')
    arrow.className = 'archive-resume-arrow'
    arrow.textContent = '▸'
    btn.append(modeSpan, arrow)
    btn.onclick = () => handleResumeFromBadge(best.puzzleDate, best.gameMode)
  }

  monthCards.forEach((_, i) => refreshMonthMedals(i))
  refreshDots()
  updateNav()
  refreshArchiveResume()
  requestAnimationFrame(() => jumpToMonth(currentMonthIndex))

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
  submissionElapsedMs,
  playerGuid: myGuid,
  completedRun,
  showRankPill,
}) {
  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay'

  const dismiss = () => {
    if (overlay.dataset.dismissed === '1') return
    overlay.dataset.dismissed = '1'
    if (completedRun) clearRunForMode(completedRun)
    overlay.classList.remove('is-visible')
    overlay.style.pointerEvents = 'none'
    setTimeout(() => overlay.remove(), 200)
  }

  const pbStatValue = formatDuration(submissionElapsedMs)

  const puzzleDate = completedRun?.puzzleDate || getIsoDate(new Date())
  const completedModes = getCompletedModesForDate(puzzleDate)
  const doneCount = completedModes.size
  const allDone = doneCount === ARCHIVE_GLYPH_MODES.length
  const progressDateLabel = (() => {
    const [y, m, d] = puzzleDate.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  })()
  const progressLabel = allDone
    ? 'All puzzles complete!'
    : `${doneCount} of ${ARCHIVE_GLYPH_MODES.length}`
  let priorIndex = 0
  const progressGlyphArms = ARCHIVE_GLYPH_MODES.map((m) => {
    const isDone = completedModes.has(m.key)
    const isJustDone = m.key === gameMode
    const delayAttr = isDone && !isJustDone
      ? ` style="animation-delay:${0.15 + priorIndex++ * 0.12}s"`
      : ''
    return `<g data-mode="${m.key}"${isDone ? ' data-done="1"' : ''}${isJustDone ? ' data-just-done="1"' : ''}${delayAttr}>` +
      `<use href="#xefig-petal" transform="rotate(${m.baseRot})" fill="${m.color}" class="petal"/>` +
      `<use href="#xefig-arm" transform="rotate(${m.baseRot})" class="arm"/>` +
      `</g>`
  }).join('')
  const justDoneDelay = (0.15 + priorIndex * 0.12 + 0.25).toFixed(2)
  const progressGlyph = `
    <div class="completion-progress${allDone ? ' all-done' : ''}" style="--just-done-delay:${justDoneDelay}s">
      <svg class="glyph completion-glyph" viewBox="-100 -100 200 200"${allDone ? ' data-complete="1"' : ''}>
        <circle r="88" class="ring-bg"/>
        <g transform="rotate(-20)">
          <use href="#xefig-star-outline" class="star-ghost"/>
          ${progressGlyphArms}
        </g>
      </svg>
      <span class="completion-progress-date">${progressDateLabel}</span>
      <span class="completion-progress-label">${progressLabel}</span>
    </div>
  `

  const rankStampHtml = showRankPill
    ? '<button type="button" class="completion-rank-stamp is-loading" aria-live="polite"><span class="rank-stamp-text">Rank…</span></button>'
    : ''

  overlay.innerHTML = `
    <div class="completion-card">
      <h2>Puzzle Complete!</h2>
      ${progressGlyph}
      <div class="completion-stats">
        <div class="completion-stat">
          <span class="stat-value">${duration}</span>
          <span class="stat-label">Time</span>
        </div>
        <div class="completion-stat completion-stat-pb-neutral">
          <span class="stat-value">${pbStatValue}</span>
          <span class="stat-label">First Solve</span>
        </div>
      </div>
      ${rankStampHtml}
      <button type="button" class="completion-dismiss">Continue</button>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })
  overlay.querySelector('.completion-dismiss').addEventListener('click', dismiss)

  return overlay
}

function buildLeaderboardHtml({
  rank,
  bestMs,
  previousBestMs,
  submissionRank,
  submissionElapsedMs,
  leaderboardEntries,
  playerGuid: myGuid,
}) {
  if (!leaderboardEntries || leaderboardEntries.length === 0) return ''

  const submissionTime = formatDuration(submissionElapsedMs)
  const submissionRankLabel = submissionRank ? `#${submissionRank}` : (rank ? `#${rank}` : '—')
  const pinnedIsBest = Number.isFinite(bestMs) && submissionElapsedMs === bestMs
  const slowerThanPb = Number.isFinite(bestMs) && submissionElapsedMs > bestMs
  const fasterThanPb = Number.isFinite(bestMs) && submissionElapsedMs < bestMs

  const trendArrow = fasterThanPb
    ? '<span class="lb-trend lb-trend-better" aria-label="faster than PB">▲</span>'
    : slowerThanPb
      ? '<span class="lb-trend lb-trend-worse" aria-label="slower than PB">▼</span>'
      : '<span class="lb-trend lb-trend-tied" aria-label="same as PB">—</span>'

  const myProfileName = (getProfileName() || '').trim()
  const myDisplayName = displayPlayerName({ isMe: true, profileName: myProfileName, playerGuid: myGuid })

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
    hideRank: r.kind === 'ghost',
  })).join('')

  const lbColgroup = `
    <colgroup>
      <col class="lb-col-rank"><col class="lb-col-time"><col class="lb-col-player"><col class="lb-col-best">
    </colgroup>`

  return `
    <div class="completion-leaderboard">
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

// Build a link that, when opened on another device, auto-links the share
// code via the boot handler (see `?sync=` parsing below).
function makeSyncShareUrl(code) {
  const url = new URL(location.origin + '/')
  url.searchParams.set('sync', code)
  return url.toString()
}

// Ask the browser to mark our storage as persistent. On iOS 15.2+ this is
// the main lever we have against cache eviction wiping the player's identity.
// Fire-and-forget; the browser grants it silently based on engagement.
function requestPersistentStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {})
    }
  } catch {}
}

// Step 2 of the first-completion flow: reveal the sync code that was just
// minted and make it easy to hand off to another device. Shown only after
// `enableSync` succeeds — on failure we just present the completion overlay.
function showSyncCodeCelebration({ name, code, onDone }) {
  const existing = document.querySelector('.sync-celebrate-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay sync-celebrate-overlay'
  const shareUrl = makeSyncShareUrl(code)
  const greet = name ? `Saved as ${escapeHtml(name)}.` : 'Sync enabled.'
  overlay.innerHTML = `
    <div class="completion-card sync-celebrate-card">
      <h3 class="sync-celebrate-title">${greet}</h3>
      <p class="sync-celebrate-msg">Your sync code keeps your progress safe and lets you play on another device.</p>
      <div class="sync-code-display sync-celebrate-code">
        <span class="sync-code-value">${code}</span>
      </div>
      <div class="sync-celebrate-actions">
        <button type="button" class="sync-celebrate-share">Send to another device</button>
        <button type="button" class="sync-celebrate-copy">Copy code</button>
      </div>
      <p class="sync-celebrate-hint">You can see this code again in Settings at any time.</p>
      <div class="confirm-actions sync-celebrate-done-row">
        <button type="button" class="confirm-ok sync-celebrate-done">Done</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))

  let done = false
  const close = () => {
    if (done) return
    done = true
    overlay.classList.remove('is-visible')
    setTimeout(() => overlay.remove(), 200)
    if (typeof onDone === 'function') onDone()
  }

  const shareBtn = overlay.querySelector('.sync-celebrate-share')
  const copyBtn = overlay.querySelector('.sync-celebrate-copy')

  shareBtn.addEventListener('click', async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'xefig sync',
          text: 'Open xefig on your other device with this link',
          url: shareUrl,
        })
      } else {
        await navigator.clipboard.writeText(shareUrl)
        shareBtn.textContent = 'Link copied!'
        setTimeout(() => { shareBtn.textContent = 'Send to another device' }, 2000)
      }
    } catch {
      // user cancelled share sheet — ignore
    }
  })

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code)
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = 'Copy code' }, 2000)
    } catch {}
  })

  overlay.querySelector('.sync-celebrate-done').addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
}

// ─── More sheet ─────────────────────────────────────────────────────────────
// Replaces the old in-slice "More" expanded card grid. The slice itself is
// just a tap target; tapping opens this sheet (centered modal on landscape,
// bottom sheet on portrait). All horizontal labels — no rotated text, no
// portrait/landscape divergence.
function closeMoreSheet() {
  const overlay = document.querySelector('.more-sheet-overlay')
  if (!overlay) return
  if (typeof overlay.__teardown === 'function') overlay.__teardown()
  overlay.classList.remove('is-visible')
  setTimeout(() => overlay.remove(), 200)
}

function openMoreSheet({ puzzleDate, handleSliceClick }) {
  const existing = document.querySelector('.more-sheet-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'more-sheet-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'More options')

  let detachSync = () => {}
  const renderCards = () => {
    const cards = []

    const resume = getLatestActiveArchiveRun(puzzleDate)
    if (resume) {
      const d = new Date(Date.parse(`${resume.puzzleDate}T00:00:00Z`))
      const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
      const modeLabel = SPINE_LABELS[resume.gameMode] || resume.gameMode
      cards.push(`
        <button class="more-sheet-card more-sheet-card--continue" data-action="continue" data-mode="${resume.gameMode}" data-date="${resume.puzzleDate}">
          <span class="more-sheet-card-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>
          </span>
          <span class="more-sheet-card-text">
            <span class="more-sheet-card-title">Continue</span>
            <span class="more-sheet-card-sub">${modeLabel} · ${dateLabel}</span>
          </span>
        </button>`)
    }

    cards.push(`
      <button class="more-sheet-card" data-page="archive">
        <span class="more-sheet-card-icon">
          <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <rect x="8" y="6" width="48" height="10" rx="2"/>
            <path d="M12 16v36a4 4 0 004 4h32a4 4 0 004-4V16"/>
            <path d="M24 28h16" stroke-width="2" stroke-linecap="round"/>
            <rect x="20" y="22" width="24" height="12" rx="2" stroke-dasharray="3 2"/>
          </svg>
        </span>
        <span class="more-sheet-card-text">
          <span class="more-sheet-card-title">Archive</span>
          <span class="more-sheet-card-sub">Your puzzle history</span>
        </span>
      </button>`)

    const musicOn = getMusicEnabled()
    cards.push(`
      <button class="more-sheet-card more-sheet-card--music ${musicOn ? 'is-on' : 'is-off'}" data-action="toggle-music" aria-label="Music: ${musicOn ? 'On' : 'Off'}">
        <span class="more-sheet-card-icon">
          <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path d="M26 44V14l20-4v30" stroke-width="2" stroke-linejoin="round"/>
            <ellipse cx="22" cy="44" rx="6" ry="4"/>
            <ellipse cx="42" cy="40" rx="6" ry="4"/>
            <line class="music-off-slash" x1="8" y1="8" x2="56" y2="56" stroke-width="4" stroke-linecap="round" opacity="0"/>
          </svg>
        </span>
        <span class="more-sheet-card-text">
          <span class="more-sheet-card-title">Music: ${musicOn ? 'On' : 'Off'}</span>
          <span class="more-sheet-card-sub">Tap to ${musicOn ? 'mute' : 'unmute'}</span>
        </span>
      </button>`)

    if (isSyncEnabled()) {
      cards.push(`
        <button class="more-sheet-card more-sheet-card--devices" id="more-devices-card" data-action="share-sync">
          <span class="more-sheet-card-icon">
            <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="10" y="6" width="22" height="36" rx="3"/>
              <rect x="32" y="22" width="22" height="36" rx="3"/>
              <circle cx="21" cy="36" r="1.2" fill="currentColor"/>
              <circle cx="43" cy="52" r="1.2" fill="currentColor"/>
              <path d="M24 24 L40 32" stroke-dasharray="3 2"/>
            </svg>
            <span class="more-card-sync-dot" data-state="saved" aria-hidden="true"></span>
          </span>
          <span class="more-sheet-card-text">
            <span class="more-sheet-card-title">Devices</span>
            <span class="more-sheet-card-sub">Share with another device</span>
          </span>
        </button>`)
    }

    const installState = getInstallState()
    if (installState === 'available' || installState === 'ios-safari') {
      const sub = installState === 'ios-safari'
        ? 'Tap Share → Add to Home Screen'
        : 'Add to your home screen'
      cards.push(`
        <button class="more-sheet-card more-sheet-card--install" data-action="install-app">
          <span class="more-sheet-card-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12"/>
              <path d="M7 10l5 5 5-5"/>
              <path d="M5 21h14"/>
            </svg>
          </span>
          <span class="more-sheet-card-text">
            <span class="more-sheet-card-title">Install app</span>
            <span class="more-sheet-card-sub">${sub}</span>
          </span>
        </button>`)
    }

    cards.push(`
      <button class="more-sheet-card" data-page="settings">
        <span class="more-sheet-card-icon">
          <svg viewBox="0 0 100 100" fill="currentColor" opacity="0.85" aria-hidden="true">
            <path fill-rule="evenodd" d="M40.7 15.2 L44 4.4 L56 4.4 L59.3 15.2 L68 18.8 L78 13.5 L86.5 22 L81.2 32 L84.8 40.7 L95.6 44 L95.6 56 L84.8 59.3 L81.2 68 L86.5 78 L78 86.5 L68 81.2 L59.3 84.8 L56 95.6 L44 95.6 L40.7 84.8 L32 81.2 L22 86.5 L13.5 78 L18.8 68 L15.2 59.3 L4.4 56 L4.4 44 L15.2 40.7 L18.8 32 L13.5 22 L22 13.5 L32 18.8 z M50 32 L56.9 33.4 L62.7 37.3 L66.6 43.1 L68 50 L66.6 56.9 L62.7 62.7 L56.9 66.6 L50 68 L43.1 66.6 L37.3 62.7 L33.4 56.9 L32 50 L33.4 43.1 L37.3 37.3 L43.1 33.4 z"/>
          </svg>
        </span>
        <span class="more-sheet-card-text">
          <span class="more-sheet-card-title">Settings</span>
          <span class="more-sheet-card-sub">Profile, audio, sync, more</span>
        </span>
      </button>`)

    return cards.join('')
  }

  const populate = () => {
    detachSync()
    overlay.innerHTML = `
      <div class="more-sheet" role="document">
        <button type="button" class="more-sheet-close" aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 2 L14 14 M14 2 L2 14"/></svg>
        </button>
        <div class="more-sheet-handle" aria-hidden="true"></div>
        <h2 class="more-sheet-title">More</h2>
        <div class="more-sheet-cards">${renderCards()}</div>
      </div>
    `
    detachSync = bindMoreSheetSyncIndicator(overlay) || (() => {})

    overlay.querySelector('.more-sheet-close').addEventListener('click', closeMoreSheet)

    overlay.querySelectorAll('.more-sheet-card').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()

        if (btn.dataset.action === 'toggle-music') {
          const nowEnabled = !getMusicEnabled()
          const nextVol = nowEnabled ? (lastNonZeroVolume || MUSIC_DEFAULT_VOLUME) : 0
          setMusicVolume(nextVol)
          applyMusicVolume()
          // Re-render the sheet so card class + label reflect new state.
          populate()
          return
        }

        if (btn.dataset.action === 'install-app') {
          const installState = getInstallState()
          if (installState === 'available' && deferredInstallPrompt) {
            try {
              deferredInstallPrompt.prompt()
              await deferredInstallPrompt.userChoice
            } catch {}
            deferredInstallPrompt = null
            closeMoreSheet()
            return
          }
          if (installState === 'ios-safari') {
            // Just show a tooltip-style hint via showConfirmDialog reuse —
            // single OK button (Cancel hidden via empty label is awkward, so
            // we use the existing dialog with a single confirm).
            closeMoreSheet()
            showConfirmDialog({
              message: 'To install: tap the Share button in Safari, then choose "Add to Home Screen".',
              confirmLabel: 'Got it',
              cancelLabel: 'Close',
              onConfirm: () => {},
            })
            return
          }
          return
        }

        if (btn.dataset.action === 'share-sync') {
          if (isSyncEnabled()) {
            const code = getShareCode()
            if (code) {
              closeMoreSheet()
              showSyncCodeCelebration({ name: getProfileName(), code })
              return
            }
          }
          closeMoreSheet()
          window.switchToPage('settings')
          return
        }

        if (btn.dataset.action === 'continue') {
          const resumeMode = btn.dataset.mode
          const resumeDate = btn.dataset.date
          if (resumeMode && resumeDate && typeof handleSliceClick === 'function') {
            closeMoreSheet()
            try {
              const payload = await fetchPuzzlePayload({ date: resumeDate })
              state.puzzle = payload
            } catch {}
            handleSliceClick(resumeMode, resumeDate)
          }
          return
        }

        if (btn.dataset.page) {
          closeMoreSheet()
          window.switchToPage(btn.dataset.page)
        }
      })
    })
  }

  overlay.__rerender = populate
  overlay.__teardown = () => {
    detachSync()
    document.removeEventListener('keydown', onKey)
  }

  const onKey = (e) => {
    if (e.key === 'Escape') closeMoreSheet()
  }
  document.addEventListener('keydown', onKey)

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeMoreSheet()
  })

  document.body.appendChild(overlay)
  populate()
  requestAnimationFrame(() => overlay.classList.add('is-visible'))
}

function showConfirmDialog({ message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel }) {
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

  let settled = false
  const dismiss = (fn) => {
    if (settled) return
    settled = true
    overlay.classList.remove('is-visible')
    setTimeout(() => overlay.remove(), 200)
    if (typeof fn === 'function') fn()
  }
  overlay.querySelector('.confirm-cancel').addEventListener('click', () => dismiss(onCancel))
  overlay.querySelector('.confirm-ok').addEventListener('click', () => dismiss(onConfirm))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss(onCancel)
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

  const renderBoard = (lb) => {
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
  }

  fetchLeaderboard(puzzleDate, gameMode, 100)
    .then(async (lb) => {
      const entries = lb.entries || []
      const myEntry = entries.find((e) => e.playerGuid === playerGuid)

      // Self-heal: if the player has a local completion for this puzzle
      // but no leaderboard row (e.g. an earlier submit failed silently or
      // the completion arrived via cross-device sync), upsert now and
      // refetch. The server dedupes by MIN elapsed so resubmitting is
      // idempotent for players already ranked.
      const localBest = Number(entry?.bestElapsedMs)
      if (!myEntry && Number.isFinite(localBest) && localBest >= MIN_PLAUSIBLE_ELAPSED_MS) {
        try {
          await submitLeaderboard({
            puzzleDate,
            gameMode: normalizeGameMode(gameMode),
            elapsedActiveMs: localBest,
          })
          const refreshed = await fetchLeaderboard(puzzleDate, gameMode, 100)
          renderBoard(refreshed)
          return
        } catch {
          // Fall through to render whatever we had
        }
      }

      renderBoard(lb)
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
          <span id="timer" class="gt-timer floating-timer">00:00</span>
          <p id="status" class="sr-only" aria-live="polite">Loading puzzle...</p>
        ` : ''}
        ${useImmersiveDiamondChrome ? `
          <button id="back-btn" class="diamond-floating-btn diamond-floating-btn--back" type="button" aria-label="Back to puzzles" title="Back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button id="restart-btn" class="diamond-floating-btn diamond-floating-btn--restart" type="button" aria-label="Restart puzzle" title="Restart">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L14 10h7V3l-3.35 3.35Z"/></svg>
          </button>
          <span id="timer" class="gt-timer floating-timer">00:00</span>
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
    const isPending = status === 'idle' || status === 'error' || !status
    // After initial load, 'idle' means we haven't pushed yet — check for changes
    const hasChanges = isPending && hasPendingChanges()
    let state = 'saved'
    let title = 'Saved to cloud'
    if (status === 'syncing') {
      state = 'syncing'; title = 'Syncing...'
    } else if (status === 'error' || hasChanges) {
      state = 'pending'; title = status === 'error' ? 'Sync failed — tap to retry' : 'Tap to sync now'
    }
    if (saveIndicator) {
      saveIndicator.dataset.state = state
      saveIndicator.title = title
    }
    // Tint the menu button while a sync is in flight so the status is
    // visible in immersive chrome (where the legacy indicator isn't drawn).
    const menuBtns = gameEl.querySelectorAll('#menu-btn')
    menuBtns.forEach((btn) => {
      if (state === 'syncing') btn.dataset.sync = 'syncing'
      else delete btn.dataset.sync
    })
  }

  updateSaveIndicator(getSyncStatus())
  onStatusChange(updateSaveIndicator)
  if (saveIndicator) {
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
    if (isSyncEnabled()) forcePush().catch(() => {})
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
          // Skip init-time emit: a fresh updatedAt here would beat an in-flight sync pull.
          if (timerState.started) {
            persistActiveRun(progressState)
          }
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

          // Show the modal immediately with just the local time — waiting
          // on the leaderboard round-trip used to block it for 10-15s on
          // slow connections (and sometimes never appeared until the user
          // tapped elsewhere). Fill in the rank + leaderboard section as
          // soon as the network resolves.
          const presentOverlay = () => {
            const syncActive = isSyncEnabled() && navigator.onLine
            const overlay = showCompletionOverlay({
              gameMode,
              duration: durationLabel,
              elapsedMs: currentRun.elapsedActiveMs,
              submissionElapsedMs: currentRun.elapsedActiveMs,
              playerGuid,
              completedRun,
              showRankPill: syncActive,
            })

            if (!syncActive) return

            const stamp = overlay.querySelector('.completion-rank-stamp')
            if (!stamp) return

            const stampShownAt = performance.now()
            let pulseTimer
            let dimmed = false
            let period = 900
            const tick = () => {
              dimmed = !dimmed
              stamp.classList.toggle('is-dim', dimmed)
              period = Math.max(100, period * 0.78)
              pulseTimer = setTimeout(tick, period)
            }
            pulseTimer = setTimeout(tick, period)

            ;(async () => {
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

              const elapsed = performance.now() - stampShownAt
              if (elapsed < 2000) {
                await new Promise(r => setTimeout(r, 2000 - elapsed))
              }

              clearTimeout(pulseTimer)
              stamp.classList.remove('is-dim')

              if (overlay.dataset.dismissed === '1') return

              const headerRank = submissionRank ?? rank

              // Update PB stat now that we have server data
              if (Number.isFinite(previousBestMs)) {
                const pbStat = overlay.querySelectorAll('.completion-stat')[1]
                if (pbStat) {
                  const delta = submissionElapsedMs - previousBestMs
                  if (delta < 0) {
                    pbStat.className = 'completion-stat completion-stat-pb-better'
                    pbStat.querySelector('.stat-value').textContent = formatDelta(delta)
                    pbStat.querySelector('.stat-label').textContent = 'New PB!'
                  } else if (delta === 0) {
                    pbStat.className = 'completion-stat completion-stat-pb-neutral'
                    pbStat.querySelector('.stat-value').textContent = '00:00'
                    pbStat.querySelector('.stat-label').textContent = 'Tied PB'
                  } else {
                    pbStat.className = 'completion-stat completion-stat-pb-worse'
                    pbStat.querySelector('.stat-value').textContent = formatDelta(delta)
                    pbStat.querySelector('.stat-label').textContent = 'vs PB'
                  }
                }
              }

              if (headerRank) {
                const stampText = stamp.querySelector('.rank-stamp-text')
                stampText.textContent = `Rank #${headerRank}`
                stamp.classList.remove('is-loading')
                stamp.classList.add('is-revealed')

                if (leaderboardEntries && leaderboardEntries.length > 0) {
                  const lbData = { rank, bestMs, previousBestMs, submissionRank, submissionElapsedMs, leaderboardEntries, playerGuid }
                  stamp.addEventListener('click', () => {
                    const existing = overlay.querySelector('.completion-leaderboard')
                    if (existing) {
                      const willClose = existing.classList.contains('is-expanded')
                      existing.classList.toggle('is-expanded')
                      if (willClose) return
                    } else {
                      const html = buildLeaderboardHtml(lbData)
                      stamp.insertAdjacentHTML('afterend', html)
                      const lb = overlay.querySelector('.completion-leaderboard')
                      requestAnimationFrame(() => lb.classList.add('is-expanded'))
                      const pinned = lb.querySelector('#lb-pinned')
                      const scrollEl = lb.querySelector('#lb-scroll')
                      if (pinned && scrollEl) {
                        pinned.addEventListener('click', () => {
                          const target = scrollEl.querySelector('.lb-row-best') || scrollEl.querySelector('.lb-row-me')
                          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
                        })
                      }
                    }
                  })
                }
              } else {
                const stampText = stamp.querySelector('.rank-stamp-text')
                stampText.textContent = 'Unranked'
                stamp.classList.remove('is-loading')
                stamp.classList.add('is-unranked')
              }

              setStatus(
                headerRank
                  ? `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}. Rank #${headerRank}.`
                  : `Completed ${MODE_LABELS[gameMode]} in ${durationLabel}.`,
                'ok',
              )
            })()
          }

          // Prompt for a leaderboard name on every completion until the
          // player actually sets one. Saving enables server sync so the
          // name propagates, and we then surface the freshly-minted sync
          // code so the player can back up their progress to another
          // device — otherwise they'd never see it unless they dug into
          // Settings. Skip just continues to the overlay.
          const hasName = !!(getProfileName() || '').trim()
          if (!hasName) {
            showNameDialog({
              onDone: async (result) => {
                if (!result || !result.name) {
                  presentOverlay()
                  return
                }
                const wasSyncEnabled = isSyncEnabled()
                try {
                  setProfileName(result.name)
                } catch (e) {
                  console.error('Failed to save profile name', e)
                }
                if (wasSyncEnabled) {
                  presentOverlay()
                  return
                }
                try {
                  const code = await enableSync(playerGuid)
                  requestPersistentStorage()
                  if (code) {
                    showSyncCodeCelebration({
                      name: result.name,
                      code,
                      onDone: presentOverlay,
                    })
                    return
                  }
                } catch (e) {
                  console.error('Failed to enable sync', e)
                }
                presentOverlay()
              },
            })
          } else {
            presentOverlay()
          }
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
  activeElapsedBaseMs = 0
  activeTimerArmed = false
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
let dayRolloverDate = getIsoDate(new Date())
let dayRolloverTimer = null

function msUntilLocalMidnight() {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return midnight - now
}

function prefetchNextDayPuzzle() {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowDate = getIsoDate(tomorrow)
  const endpoint = apiUrl(`/api/puzzles/${encodeURIComponent(tomorrowDate)}`)
  fetch(endpoint).then(r => r.ok ? r.json() : null).then(payload => {
    if (!payload?.categories) return
    const modes = ['jigsaw', 'slider', 'swap', 'polygram', 'diamond']
    modes.forEach(cat => {
      const urls = [payload.categories[cat]?.thumbnailUrl, payload.categories[cat]?.imageUrl].filter(Boolean)
      urls.forEach(u => {
        const img = new Image()
        img.src = resolveAssetUrl(u)
      })
    })
  }).catch(() => {})
}

function scheduleDayRollover() {
  if (dayRolloverTimer) clearTimeout(dayRolloverTimer)
  const prefetchMs = msUntilLocalMidnight() - 12 * 60 * 60 * 1000
  if (prefetchMs > 0) {
    setTimeout(prefetchNextDayPuzzle, prefetchMs)
  } else {
    prefetchNextDayPuzzle()
  }
  dayRolloverTimer = setTimeout(() => {
    handleDayRollover()
  }, msUntilLocalMidnight() + 500)
}

function handleDayRollover() {
  const newDate = getIsoDate(new Date())
  if (newDate === dayRolloverDate) {
    scheduleDayRollover()
    return
  }
  dayRolloverDate = newDate
  archiveRendered = false
  if (currentPage === 'play') {
    renderLauncher()
  } else if (currentPage === 'archive') {
    renderArchivePage()
  }
  scheduleDayRollover()
}

function initAppShell() {
  applyLandscapeLayout()
  bindInstallPromptListeners()
  app.innerHTML = ARCHIVE_SVG_DEFS_HTML + NAV_HTML

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
      flushPendingSyncConflicts()
      if (isSyncEnabled()) pullOnForeground().catch(() => {})
    } else if (pageName === 'archive') {
      if (!archiveRendered) renderArchivePage()
      else if (typeof updateArchiveThumb === 'function') {
        updateArchiveThumb(getIsoDate(new Date()))
      }
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
    window.switchToPage('archive')
    if (archiveLastFocusKey && typeof updateArchiveThumb === 'function') {
      const [date, mode] = archiveLastFocusKey.split(':')
      updateArchiveThumb(date, mode)
      requestAnimationFrame(() => {
        const thumb = document.querySelector(
          `#page-archive .puzzle-thumb[data-date="${date}"][data-mode="${mode}"]`,
        )
        if (thumb) thumb.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    }
  } else {
    window.switchToPage('play')
  }
}

const SETTINGS_OPEN_SECTIONS_KEY = 'xefig:settings:open-sections:v1'
const SETTINGS_DEFAULT_OPEN = ['profile']

function getOpenSections() {
  try {
    const raw = localStorage.getItem(SETTINGS_OPEN_SECTIONS_KEY)
    if (!raw) return new Set(SETTINGS_DEFAULT_OPEN)
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed)
  } catch {}
  return new Set(SETTINGS_DEFAULT_OPEN)
}

function setSectionOpen(id, open) {
  const set = getOpenSections()
  if (open) set.add(id); else set.delete(id)
  try {
    localStorage.setItem(SETTINGS_OPEN_SECTIONS_KEY, JSON.stringify([...set]))
  } catch {}
}

function renderSettingsPage() {
  const container = document.querySelector('#page-settings')
  const colors = getBoardColors()
  const activeIndex = getGlobalBoardColorIndex()
  const openSet = getOpenSections()
  const formTs = Date.now()

  const sections = [
    { id: 'profile', title: 'Profile', desc: 'Your name and sync code' },
    { id: 'display', title: 'Display', desc: 'Board background' },
    { id: 'audio', title: 'Audio', desc: 'Music' },
    { id: 'sync', title: 'Sync & Devices', desc: 'Enable, link, and manage sync' },
    { id: 'about', title: 'About', desc: 'AI-generated content notice' },
    { id: 'contact', title: 'Contact', desc: 'Send a message' },
  ]

  const navHtml = sections
    .map((s) => `<a class="settings-nav-link" href="#settings-section-${s.id}" data-section="${s.id}">${s.title}</a>`)
    .join('')

  const sectionOpen = (id) => openSet.has(id) ? ' open' : ''

  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-header">
        <button class="page-back-btn" data-page="play" aria-label="Back to menu">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <h2>Settings</h2>
        <p>Customize your puzzle experience.</p>
      </div>
      <div class="settings-body">
        <nav class="settings-nav" aria-label="Settings sections">${navHtml}</nav>
        <div class="settings-sections">
          <details class="settings-section" id="settings-section-profile" data-section="profile"${sectionOpen('profile')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">Profile</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body" id="settings-profile-content"></div>
          </details>

          <details class="settings-section" id="settings-section-display" data-section="display"${sectionOpen('display')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">Display</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body">
              <div class="settings-subtitle">Board background</div>
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
          </details>

          <details class="settings-section" id="settings-section-audio" data-section="audio"${sectionOpen('audio')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">Audio</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body" id="settings-audio-content"></div>
          </details>

          <details class="settings-section" id="settings-section-sync" data-section="sync"${sectionOpen('sync')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">Sync &amp; Devices</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body" id="settings-sync-content"></div>
          </details>

          <details class="settings-section" id="settings-section-about" data-section="about"${sectionOpen('about')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">About</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body">
              <p class="about-text">
                All puzzle images on Xefig are generated using artificial intelligence
                (Google Gemini). No real photographs are used. In accordance with EU
                AI Act transparency requirements, we disclose that this content is
                AI-generated and should not be mistaken for authentic photographs.
              </p>
            </div>
          </details>

          <details class="settings-section" id="settings-section-contact" data-section="contact"${sectionOpen('contact')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">Contact</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body">
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
          </details>
        </div>
      </div>
    </div>
  `

  container.querySelector('.page-back-btn').addEventListener('click', () => window.switchToPage('play'))

  // Persist open/close per section.
  container.querySelectorAll('details.settings-section').forEach((det) => {
    det.addEventListener('toggle', () => {
      setSectionOpen(det.dataset.section, det.open)
    })
  })

  // Sidebar anchor links: open the target section if collapsed, then scroll.
  container.querySelectorAll('.settings-nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault()
      const id = link.dataset.section
      const det = container.querySelector(`details[data-section="${id}"]`)
      if (det && !det.open) {
        det.open = true
        setSectionOpen(id, true)
      }
      if (det) det.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  })

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

  renderProfileSettings()
  renderAudioSettings()
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

function renderProfileSettings() {
  const el = document.querySelector('#settings-profile-content')
  if (!el) return

  const currentName = getProfileName()
  const enabled = isSyncEnabled()
  const code = getShareCode()
  const nameSafe = currentName.replace(/"/g, '&quot;')

  if (enabled && code) {
    el.innerHTML = `
      <div class="sync-field">
        <label class="sync-field-label" for="sync-profile-name">Display name</label>
        <input type="text" id="sync-profile-name" class="sync-name-input" maxlength="30" placeholder="Anonymous" value="${nameSafe}" autocomplete="off" spellcheck="false" />
      </div>
      <p class="sync-description">Your sync code (use this on another device):</p>
      <div class="sync-code-display">
        <span class="sync-code-value">${code}</span>
        <button type="button" id="sync-copy-btn" class="sync-copy-btn" title="Copy code">Copy</button>
      </div>
      <p class="sync-hint">Tap the Devices card in More to send a quick link to another device.</p>
    `
    const nameInput = el.querySelector('#sync-profile-name')
    let nameTimeout = null
    nameInput.addEventListener('input', () => {
      clearTimeout(nameTimeout)
      nameTimeout = setTimeout(() => setProfileName(nameInput.value), 400)
    })
    el.querySelector('#sync-copy-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code)
        const btn = el.querySelector('#sync-copy-btn')
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = 'Copy' }, 2000)
      } catch {}
    })
  } else {
    el.innerHTML = `
      <div class="sync-field">
        <label class="sync-field-label" for="sync-profile-name">Display name</label>
        <input type="text" id="sync-profile-name" class="sync-name-input" maxlength="30" placeholder="Anonymous" value="${nameSafe}" autocomplete="off" spellcheck="false" />
      </div>
      <p class="sync-hint">Enable Sync below to get a shareable code that lets you continue on another device.</p>
    `
    const nameInput = el.querySelector('#sync-profile-name')
    let nameTimeout = null
    nameInput.addEventListener('input', () => {
      clearTimeout(nameTimeout)
      nameTimeout = setTimeout(() => setProfileName(nameInput.value), 400)
    })
  }
}

function renderAudioSettings() {
  const el = document.querySelector('#settings-audio-content')
  if (!el) return
  const vol = getMusicVolume()
  const enabled = vol > 0
  el.innerHTML = `
    <div class="settings-row">
      <label class="settings-row-label">
        <span>Music</span>
        <span class="settings-row-sub">${enabled ? 'Playing' : 'Muted'}</span>
      </label>
      <button type="button" id="settings-music-toggle" class="settings-toggle ${enabled ? 'is-on' : 'is-off'}" role="switch" aria-checked="${enabled ? 'true' : 'false'}">
        <span class="settings-toggle-track"></span>
      </button>
    </div>
    <div class="settings-row settings-row-stack">
      <label class="settings-row-label" for="settings-music-volume">
        <span>Volume</span>
        <span class="settings-row-sub" id="settings-music-volume-display">${Math.round(vol * 100)}%</span>
      </label>
      <input type="range" id="settings-music-volume" class="settings-volume-slider" min="0" max="1" step="0.01" value="${vol}" />
    </div>
  `

  const toggle = el.querySelector('#settings-music-toggle')
  const slider = el.querySelector('#settings-music-volume')
  const display = el.querySelector('#settings-music-volume-display')
  const sub = el.querySelector('.settings-row-label .settings-row-sub')

  const refresh = () => {
    const v = getMusicVolume()
    const on = v > 0
    toggle.classList.toggle('is-on', on)
    toggle.classList.toggle('is-off', !on)
    toggle.setAttribute('aria-checked', on ? 'true' : 'false')
    slider.value = String(v)
    display.textContent = `${Math.round(v * 100)}%`
    if (sub) sub.textContent = on ? 'Playing' : 'Muted'
  }

  toggle.addEventListener('click', () => {
    const nowEnabled = !getMusicEnabled()
    setMusicVolume(nowEnabled ? (lastNonZeroVolume || MUSIC_DEFAULT_VOLUME) : 0)
    applyMusicVolume()
    refresh()
  })

  slider.addEventListener('input', () => {
    const v = Number(slider.value)
    setMusicVolume(v)
    applyMusicVolume()
    refresh()
  })
}

function renderSyncSettings() {
  const syncEl = document.querySelector('#settings-sync-content')
  if (!syncEl) return

  const enabled = isSyncEnabled()
  const code = getShareCode()

  if (enabled && code) {
    syncEl.innerHTML = `
      <p class="sync-description">Sync is on. Your progress syncs automatically across devices.</p>
      <div id="sync-status-msg" class="sync-status"></div>
      <div class="sync-button-row">
        <button type="button" id="sync-now-btn" class="sync-now-btn">Sync Now</button>
        <button type="button" id="sync-disable-btn" class="sync-disable-btn">Disable Sync</button>
      </div>
    `
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
      renderProfileSettings()
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
        await enableSync(playerGuid)
        renderProfileSettings()
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
        refreshPlayerGuid()
        renderProfileSettings()
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

    const input = syncEl.querySelector('#sync-code-input')
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase()
    })
  }
}

// ─── Sync initialization (must complete before rendering so pulled state is visible) ───

let pendingSyncConflicts = null

function handleSyncConflicts(list) {
  if (!Array.isArray(list) || list.length === 0) return
  // Mid-gameplay is the wrong time to prompt the user to choose a save —
  // they'd have to abandon their current run to look at a blocking modal
  // about a different (or the same) puzzle. Defer until they're back at
  // the launcher, where "pick which save to resume from" is the natural
  // next action anyway.
  if (currentPage === 'game') {
    pendingSyncConflicts = list
    return
  }
  showSyncConflictModal(list)
}

// Register BEFORE initSync so conflicts detected during the first pull
// are not dropped — sync.js only fires the callback after a pull, so a
// late subscription misses the opening round entirely.
onConflict(handleSyncConflicts)

await Promise.race([initSync(), new Promise((r) => setTimeout(r, 3000))])

initAppShell()
scheduleDayRollover()

// ─── Sync link boot handler ───
// If the page was opened with ?sync=ABC123, try to link that code so the
// player lands on their existing progress without having to hunt through
// Settings. If sync is already enabled locally, confirm before replacing
// — we don't want a shared link to silently overwrite someone else's run.
async function handleSyncLinkParam() {
  const params = new URLSearchParams(location.search)
  const raw = params.get('sync')
  if (!raw) return
  const code = raw.trim().toUpperCase()
  // Always strip the param — whether we act on it or not, leaving it in
  // the URL means a reload would retry a link that may have already been
  // consumed or declined.
  const cleanUrl = location.pathname + location.hash
  try { history.replaceState(null, '', cleanUrl) } catch {}

  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) return

  if (isSyncEnabled()) {
    const existingCode = getShareCode()
    if (existingCode && existingCode.toUpperCase() === code) return
    const proceed = await new Promise((resolve) => {
      showConfirmDialog({
        message: 'This device is already synced. Opening this link will replace the current profile with the shared one. Your current progress stays on the other device.',
        confirmLabel: 'Switch',
        cancelLabel: 'Keep current',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
    if (!proceed) return
    try { disableSync() } catch {}
  }

  try {
    await linkSync(code)
    refreshPlayerGuid()
    requestPersistentStorage()
    if (currentPage === 'play') renderLauncher()
  } catch (e) {
    console.error('Failed to link via share URL', e)
  }
}
handleSyncLinkParam()

function flushPendingSyncConflicts() {
  // Prefer the live pending set from sync.js — it catches conflicts that
  // were registered before any callback fired (e.g. during initSync, or
  // while currentPage was 'game' and we stashed nothing yet because the
  // callback was rate-limited).
  const live = typeof getPendingActiveConflicts === 'function'
    ? getPendingActiveConflicts()
    : []
  const stashed = pendingSyncConflicts || []
  pendingSyncConflicts = null
  const list = live.length ? live : stashed
  if (list.length === 0) return
  showSyncConflictModal(list)
}

// Surface any conflicts that existed before the callback was registered.
flushPendingSyncConflicts()

// When a background pull brings in new remote data (another device's
// completion, etc.), refresh the launcher so freshly-synced pills are
// visible without the user having to hit Sync Now or navigate away and
// back. Guarded to currentPage === 'play' so we don't clobber a game
// in progress or a settings view the user is editing.
onRemoteChanged(() => {
  if (currentPage === 'play') renderLauncher()
})

function formatSavedAgo(iso) {
  if (!iso) return 'Saved recently'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'Saved recently'
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (diffSec < 60) return 'Saved just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `Saved ${diffMin} min ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `Saved ${diffHr} hr ago`
  const diffDay = Math.round(diffHr / 24)
  return `Saved ${diffDay} day${diffDay === 1 ? '' : 's'} ago`
}

function showSyncConflictModal(conflicts = []) {
  const existing = document.querySelector('#sync-conflict-modal')
  if (existing) existing.remove()
  if (conflicts.length === 0) return

  // v1 resolves all conflicts with the same choice, so the card only needs
  // to show one representative puzzle. Use the first; everything else gets
  // a small "also affects N more" footer if applicable.
  const primary = conflicts[0]
  const localTime = Date.parse(primary.local?.updatedAt || '') || 0
  const remoteTime = Date.parse(primary.remote?.updatedAt || '') || 0
  const localIsLatest = localTime >= remoteTime

  const cardHtml = (side, run, label, isLatest) => {
    const elapsed = formatDuration(Number(run?.elapsedActiveMs) || 0)
    const savedAgo = formatSavedAgo(run?.updatedAt)
    return `
      <button type="button" class="sync-conflict-card${isLatest ? ' sync-conflict-card--latest' : ''}" data-choice="${side}">
        <div class="sync-conflict-card-label">${label}</div>
        <div class="sync-conflict-card-saved">${savedAgo}</div>
        <div class="sync-conflict-card-elapsed">${elapsed} played</div>
        <div class="sync-conflict-card-use">Use</div>
        ${isLatest ? `<div class="sync-conflict-card-latest-tag">Latest save</div>` : ''}
      </button>
    `
  }

  const footer = conflicts.length > 1
    ? `<p class="sync-conflict-footer">Applies to ${conflicts.length} puzzles with unsaved progress.</p>`
    : ''

  const overlay = document.createElement('div')
  overlay.id = 'sync-conflict-modal'
  overlay.className = 'sync-conflict-overlay'
  overlay.innerHTML = `
    <div class="sync-conflict-dialog">
      <h3 class="sync-conflict-title">Choose a save</h3>
      <div class="sync-conflict-cards">
        ${cardHtml('local', primary.local, 'This device', localIsLatest)}
        ${cardHtml('remote', primary.remote, 'On the cloud', !localIsLatest)}
      </div>
      ${footer}
    </div>
  `
  document.body.appendChild(overlay)

  overlay.querySelectorAll('.sync-conflict-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const choice = card.dataset.choice === 'remote' ? 'remote' : 'local'
      overlay.remove()
      await resolveConflict(choice)
      if (choice === 'remote' && typeof window.switchToPage === 'function') {
        window.switchToPage('play')
      }
    })
  })
}

// ─── Service Worker Registration ───

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

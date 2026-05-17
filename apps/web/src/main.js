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

// Flag the brick-recovery timer in index.html that the bundle reached
// execution. Set as the first non-import statement so any later module
// failure still allows the page to recover via SW unregister + reload.
if (typeof window !== 'undefined') {
  window.__appBooted = true
}

// Puzzle engines are loaded on demand in renderGame() via dynamic import()
// to keep the homepage bundle free of gameplay code.
const puzzleLoaders = {
  jigsaw: () => import('./components/jigsaw-puzzle.js').then((m) => m.JigsawPuzzle),
  sliding: () => import('./components/sliding-tile-puzzle.js').then((m) => m.SlidingTilePuzzle),
  swap: () => import('./components/picture-swap-puzzle.js').then((m) => m.PictureSwapPuzzle),
  polygram: () => import('./components/polygram-puzzle.js').then((m) => m.PolygramPuzzle),
  diamond: () => import('./components/diamond-painting-puzzle.js').then((m) => m.DiamondPaintingPuzzle),
}

// In-game helper. Loaded on demand alongside the puzzle engine so the
// homepage bundle stays small. The same module powers every mode's
// tutorial / hint flow.
const loadAssistant = () => import('./components/assistant.js')

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
const COMPLETED_RUNS_KEY = 'xefig:puzzles:completed:v1'
const LAUNCHER_FOCUS_KEY = 'xefig:launcher:focus:v1'
// Lower bound on what a legit puzzle run looks like: nothing in the app
// is completable under a second, so anything below is a bug artifact.
const MIN_PLAUSIBLE_ELAPSED_MS = 1000
const BOARD_COLOR_KEY = 'xefig:board-color:v1'
const THEME_PREF_KEY = 'xefig:theme:v1'
const MUSIC_ENABLED_KEY = 'xefig:music-enabled:v1'
const MUSIC_VOLUME_KEY = 'xefig:music-volume:v1'
const MUSIC_DEFAULT_VOLUME = 0.35
const DIAMOND_SFX_MUTED_KEY = 'xefig:diamond-sfx-muted:v1'
const DIAMOND_LOG_PREFIX = 'xefig:diamond-log:'
const DIAMOND_LOG_RETAIN = 30
const DIAMOND_TEST_LOG_PREFIX = 'xefig:diamond-test-log:'
const DIAMOND_TEST_LOG_RETAIN = 30
// Single-slot test active-run state. Kept under its own key so the
// launcher's "Resume" pill never picks it up and the production
// active-run path stays clean. Test runs are inherently single-slot
// — there's only ever one calibration run in flight at a time.
const TEST_ACTIVE_RUN_KEY = 'xefig:test-run:active'
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

// ─── Theme preference ─────────────────────────────────────────────────
// Three-way: 'auto' (default — follow OS), 'light', or 'dark'. The
// initial resolution + DOM attribute are applied by the inline script
// in index.html before CSS loads (to avoid FOUC). These helpers handle
// in-app changes + reacting to system pref shifts when in auto mode.
const VALID_THEME_PREFS = new Set(['auto', 'light', 'dark'])

function getThemePref() {
  try {
    const raw = localStorage.getItem(THEME_PREF_KEY)
    return VALID_THEME_PREFS.has(raw) ? raw : 'auto'
  } catch {
    return 'auto'
  }
}

function setThemePref(pref) {
  if (!VALID_THEME_PREFS.has(pref)) return
  try { localStorage.setItem(THEME_PREF_KEY, pref) } catch { }
}

function resolveTheme(pref = getThemePref()) {
  if (pref === 'light' || pref === 'dark') return pref
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(pref = getThemePref()) {
  const resolved = resolveTheme(pref)
  document.documentElement.setAttribute('data-theme', resolved)
  const meta = document.getElementById('meta-theme-color')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0a0f' : '#f4f7fb')
  return resolved
}

// React to OS theme shifts when the user is in auto mode (a no-op in
// manual modes). Wire this once at boot.
function watchSystemTheme() {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!mq) return
  const onChange = () => {
    if (getThemePref() === 'auto') applyTheme('auto')
  }
  if (mq.addEventListener) mq.addEventListener('change', onChange)
  else if (mq.addListener) mq.addListener(onChange)
}

function isDarkMode() {
  return resolveTheme() === 'dark'
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

function getDiamondSfxMuted() {
  try { return localStorage.getItem(DIAMOND_SFX_MUTED_KEY) === '1' } catch { return false }
}

function setDiamondSfxMuted(muted) {
  try { localStorage.setItem(DIAMOND_SFX_MUTED_KEY, muted ? '1' : '0') } catch { }
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
let activeAssistant = null
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
let musicUnlockListenersBound = false
let musicStartAttempt = null

const MUSIC_UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'click', 'touchend', 'keydown']

function tryEnsureAudioGraph({ allowContextCreate = true } = {}) {
  if (audioGainNode || audioGraphFailed) return audioGainNode
  if (!musicAudio) return null
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) { audioGraphFailed = true; return null }
    if (!audioContext) {
      if (!allowContextCreate) return null
      audioContext = new AC()
    }
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

function hasTransientUserActivation() {
  return navigator.userActivation?.isActive === true
}

function isMusicPlaybackStarted(audio) {
  if (!audio || audio.paused) return false
  if (audioGainNode && audioContext && audioContext.state !== 'running') return false
  return true
}

function bindMusicUnlockListeners() {
  if (musicUnlockListenersBound || !musicShouldPlay || getMusicVolume() <= 0) return
  musicUnlockListenersBound = true
  // Autoplay policy failures are recoverable; keep listening until playback
  // and the Web Audio graph are both confirmed running.
  for (const eventName of MUSIC_UNLOCK_EVENTS) {
    document.addEventListener(eventName, onMusicUnlockGesture, { capture: true, passive: true })
  }
}

function unbindMusicUnlockListeners() {
  if (!musicUnlockListenersBound) return
  musicUnlockListenersBound = false
  for (const eventName of MUSIC_UNLOCK_EVENTS) {
    document.removeEventListener(eventName, onMusicUnlockGesture, { capture: true })
  }
}

function isMusicUnlockGesture(event) {
  if (event.isTrusted === false) return false
  if (event.type === 'pointerdown') return event.pointerType === 'mouse'
  if (event.type === 'pointerup') return event.pointerType !== 'mouse'
  return true
}

function onMusicUnlockGesture(event) {
  if (!isMusicUnlockGesture(event)) return
  startMusicPlayback({ fromGesture: true })
}

function startMusicPlayback({ fromGesture = false } = {}) {
  const vol = getMusicVolume()
  if (!musicShouldPlay || vol <= 0) {
    unbindMusicUnlockListeners()
    return Promise.resolve(false)
  }
  if (musicStartAttempt) return musicStartAttempt

  const canUnlockAudioContext = fromGesture || hasTransientUserActivation()
  const audio = ensureMusicAudio()
  const gain = tryEnsureAudioGraph({ allowContextCreate: canUnlockAudioContext || Boolean(audioContext) })

  if (gain) {
    gain.gain.value = vol
  } else {
    audio.volume = vol
  }

  if (audioContext && audioContext.state === 'suspended' && !canUnlockAudioContext) {
    bindMusicUnlockListeners()
    return Promise.resolve(false)
  }

  let resumeAttempt = Promise.resolve()
  if (audioContext && audioContext.state === 'suspended') {
    try {
      resumeAttempt = audioContext.resume()
    } catch (error) {
      resumeAttempt = Promise.reject(error)
    }
  }

  let playAttempt = Promise.resolve()
  try {
    playAttempt = audio.play()
  } catch (error) {
    playAttempt = Promise.reject(error)
  }

  musicStartAttempt = Promise.allSettled([resumeAttempt, playAttempt]).then(() => {
    if (!musicShouldPlay || getMusicVolume() <= 0) {
      unbindMusicUnlockListeners()
      return false
    }
    if (isMusicPlaybackStarted(audio)) {
      unbindMusicUnlockListeners()
      return true
    }
    bindMusicUnlockListeners()
    return false
  }).finally(() => {
    musicStartAttempt = null
  })

  return musicStartAttempt
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
  fetch(MUSIC_TRACKS[idx]).then((r) => r.arrayBuffer()).catch(() => { })
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
        setTimeout(() => startMusicPlayback(), 300)
      }
      return
    }
    lastTrackIndex = nextTrackIndex
    musicAudio.src = MUSIC_TRACKS[lastTrackIndex]
    if (musicShouldPlay) startMusicPlayback()
    nextTrackIndex = pickRandomTrackIndex(lastTrackIndex)
    prefetchTrack(nextTrackIndex)
  })
  return musicAudio
}

function applyMusicVolume({ fromGesture = false } = {}) {
  const vol = getMusicVolume()
  if (vol > 0) {
    lastNonZeroVolume = vol
    musicShouldPlay = true
    startMusicPlayback({ fromGesture })
  } else {
    musicShouldPlay = false
    unbindMusicUnlockListeners()
    if (musicAudio) musicAudio.pause()
  }
}

let musicFadeTimer = null

function pauseMusicTemporary() {
  if (!musicAudio || musicAudio.paused) return
  clearTimeout(musicFadeTimer)
  if (audioGainNode && audioContext) {
    const now = audioContext.currentTime
    audioGainNode.gain.cancelScheduledValues(now)
    audioGainNode.gain.setValueAtTime(audioGainNode.gain.value, now)
    audioGainNode.gain.linearRampToValueAtTime(0.0001, now + 0.8)
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
  if (!musicShouldPlay || !musicAudio) return
  clearTimeout(musicFadeTimer)
  const audio = musicAudio
  const gain = audioGainNode
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
  startMusicPlayback()
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
  bindMusicUnlockListeners()
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

// Resolve the freshest image URL we have for a saved run. The run's own
// imageUrl is a snapshot from when it was first saved — fine for the
// current day, but it can rot across format swaps (jpg → webp) or cache-
// bust changes (?v=…) if the run was started weeks/months ago. Prefer
// the puzzle payload's current URL when it covers the run's date, fall
// back to the saved one otherwise.
// Returns true when the connection is healthy enough to spend bandwidth
// on speculative prefetch / cache priming. We err on the side of "go"
// when the API isn't available (some browsers, desktop, etc.).
function isHealthyNetwork() {
  if (typeof navigator === 'undefined') return true
  const conn = navigator.connection
  if (!conn) return true
  if (conn.saveData) return false
  if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return false
  return true
}

// Iterate localStorage for every saved run that hasn't been completed.
// Active runs are stored under `xefig:run:<date>:<mode>` (see
// activeRunKey). We use this to drive prefetch priority and to know
// which images to keep cached even if the user is browsing the archive.
function listAllActiveRuns() {
  const runs = []
  if (typeof localStorage === 'undefined') return runs
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('xefig:run:')) continue
      const run = readJsonStorage(key)
      if (!run || run.completed) continue
      if (!run.puzzleDate || !run.imageUrl || !run.gameMode) continue
      // Drop runs whose completion arrived via sync from another device —
      // getRunForMode does the same self-heal.
      if (getCompletionEntry(run.puzzleDate, run.gameMode)) continue
      runs.push(run)
    }
  } catch {
    // localStorage can throw in private browsing modes.
  }
  return runs
}

async function isImageCached(url) {
  if (typeof caches === 'undefined') return false
  try {
    return Boolean(await caches.match(url))
  } catch {
    return false
  }
}

// Prefetch full-resolution puzzle images into the SW cache, in priority
// order: active resume runs first, then today's unplayed modes. Skips
// completed puzzles entirely — those are marked for cache eviction on
// completion, so re-fetching them would defeat the eviction policy.
//
// Throttled to one in-flight fetch at a time so we don't saturate the
// uplink while the user is doing something else, and re-checks
// connection health between fetches in case the link degrades mid-pass.
async function prefetchPlayableImages(puzzlePayload) {
  if (!isHealthyNetwork()) return

  const seen = new Set()
  const queue = []

  for (const run of listAllActiveRuns()) {
    // Only prefetch when the payload covers the run's date, so the URL
    // is the freshly-resolved one. The saved imageUrl on older runs is a
    // snapshot that can rot (jpg→webp re-renders, ?v=… cache busts);
    // those will be re-resolved against a fresh payload when the user
    // opens the archive day, so prefetching the stale URL only spams
    // 404s into the console.
    if (run.puzzleDate !== puzzlePayload?.date) continue
    const url = resolveResumeImageUrl(run, puzzlePayload)
    if (url && url !== sampleImage && !seen.has(url)) {
      seen.add(url)
      queue.push(url)
    }
  }

  if (puzzlePayload?.categories && puzzlePayload?.date) {
    // Prefetch every today-mode (completed included). Completed modes
    // used to be skipped under the old evict-on-completion policy;
    // now we keep today's completed full images cached so the menu
    // upgrade-to-full path can use them. After a cache wipe (e.g.
    // SW version bump) the completed modes would otherwise stay on
    // thumbnails until the user replays them.
    const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND]
    for (const mode of modes) {
      const url = resolvePuzzleImageUrl(puzzlePayload, mode)
      if (url && url !== sampleImage && !seen.has(url)) {
        seen.add(url)
        queue.push(url)
      }
    }
  }

  for (const url of queue) {
    if (!isHealthyNetwork()) return
    if (await isImageCached(url)) continue
    try {
      // Just fetch — sw.js intercepts /cdn paths and writes a 200
      // response into the cache. If the SW isn't installed yet, the
      // browser HTTP cache still picks it up, so the puzzle's
      // loadImage() short-circuits the same way.
      await fetch(url, { credentials: 'same-origin' })
    } catch {
      // Best effort. If the connection has degraded, bail.
      if (!isHealthyNetwork()) return
    }
  }
}

// Tell the SW to drop the full-res image for a completed puzzle. The
// thumbnail stays cached because the menu / archive views still use
// it; only the heavy full image is evicted. If the user replays, the
// image will be re-fetched on demand.
function evictCompletedImageFromCache(run) {
  if (!run?.imageUrl) return
  if (typeof navigator === 'undefined') return
  const sw = navigator.serviceWorker
  if (!sw?.controller) return
  try {
    sw.controller.postMessage({
      type: 'evict-cached',
      urls: [resolveAssetUrl(run.imageUrl)],
    })
  } catch {
    // Cross-origin / permission edge cases — best effort.
  }
}

function resolveResumeImageUrl(savedRun, puzzlePayload) {
  if (puzzlePayload?.date && puzzlePayload.date === savedRun.puzzleDate) {
    const fresh = resolvePuzzleImageUrl(puzzlePayload, savedRun.gameMode)
    if (fresh && fresh !== sampleImage) {
      return fresh
    }
  }
  return resolveAssetUrl(savedRun.imageUrl)
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

function persistDiamondSessionLog(puzzleDate, puzzle, elapsedActiveMs, { testMode = false } = {}) {
  if (!puzzleDate || !puzzle || typeof puzzle.getSessionLog !== 'function') return
  let log
  try {
    log = puzzle.getSessionLog()
  } catch {
    return
  }
  if (!log || !Array.isArray(log.events) || log.events.length === 0) return
  log.elapsedActiveMs = Number(elapsedActiveMs) || 0
  log.savedAt = new Date().toISOString()
  if (testMode) {
    // Test runs live in their own localStorage namespace AND their own
    // worker table — they never share storage, retention, or uploads
    // with real plays.
    log.testId = puzzleDate
    log.testMode = true
    writeJsonStorage(`${DIAMOND_TEST_LOG_PREFIX}${puzzleDate}`, log)
    pruneDiamondTestSessionLogs(DIAMOND_TEST_LOG_RETAIN)
    uploadDiamondTestSessionLog(puzzleDate, log, log.elapsedActiveMs)
    return
  }
  log.puzzleDate = puzzleDate
  writeJsonStorage(`${DIAMOND_LOG_PREFIX}${puzzleDate}`, log)
  pruneDiamondSessionLogs(DIAMOND_LOG_RETAIN)
  uploadDiamondSessionLog(puzzleDate, log, log.elapsedActiveMs)
}

function uploadDiamondTestSessionLog(testId, log, elapsedActiveMs) {
  if (!navigator.onLine) return
  postDiamondTestSessionLog(testId, log, elapsedActiveMs, { keepalive: true }).catch(() => {})
}

async function postDiamondTestSessionLog(testId, log, elapsedActiveMs, { keepalive = false } = {}) {
  const payload = JSON.stringify({
    testId,
    playerGuid,
    elapsedActiveMs: Number(elapsedActiveMs) || 0,
    log,
  })
  const res = await fetch('/api/diamond/test-session-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive,
  })
  if (!res.ok) throw new Error(`upload failed ${res.status}`)
  return res
}

function pruneDiamondTestSessionLogs(retain) {
  let keys
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(DIAMOND_TEST_LOG_PREFIX))
  } catch {
    return
  }
  if (keys.length <= retain) return
  keys.sort()
  for (const key of keys.slice(0, keys.length - retain)) removeStorage(key)
}

// Fire-and-forget upload so the run can be reviewed in admin from any
// device. Failures are silent — the localStorage copy is the source of
// truth on the play device and Sync Now re-uploads anything stranded
// (uploadLocalDiamondSessionLogs).
function uploadDiamondSessionLog(puzzleDate, log, elapsedActiveMs) {
  if (!navigator.onLine) return
  postDiamondSessionLog(puzzleDate, log, elapsedActiveMs, { keepalive: true }).catch(() => {})
}

async function postDiamondSessionLog(puzzleDate, log, elapsedActiveMs, { keepalive = false } = {}) {
  const payload = JSON.stringify({
    puzzleDate,
    playerGuid,
    elapsedActiveMs: Number(elapsedActiveMs) || 0,
    log,
  })
  const res = await fetch('/api/diamond/session-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
    keepalive,
  })
  if (!res.ok) throw new Error(`upload failed ${res.status}`)
  return res
}

// Replay every locally-stashed diamond log to the worker. The server
// upsert keeps this idempotent, so we don't need to track which dates
// have already been uploaded. Returns a count of successes/failures so
// the Sync Now status can surface it.
async function uploadLocalDiamondSessionLogs() {
  if (!navigator.onLine) return { uploaded: 0, failed: 0, total: 0 }
  let keys
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(DIAMOND_LOG_PREFIX))
  } catch {
    return { uploaded: 0, failed: 0, total: 0 }
  }
  if (keys.length === 0) return { uploaded: 0, failed: 0, total: 0 }
  const results = await Promise.allSettled(
    keys.map(async (key) => {
      const puzzleDate = key.slice(DIAMOND_LOG_PREFIX.length)
      // Stray legacy keys (e.g. "test-..." from before test logs got
      // their own namespace) — the worker will reject them. Skip
      // proactively so the count reads cleanly.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(puzzleDate)) {
        throw new Error('non-date key')
      }
      const log = readJsonStorage(key)
      if (!log || !Array.isArray(log.events) || log.events.length === 0) {
        throw new Error('empty')
      }
      await postDiamondSessionLog(puzzleDate, log, log.elapsedActiveMs || 0)
    }),
  )
  let uploaded = 0
  let failed = 0
  for (const r of results) {
    if (r.status === 'fulfilled') uploaded++
    else failed++
  }
  return { uploaded, failed, total: keys.length }
}

function pruneDiamondSessionLogs(retain) {
  let keys
  try {
    keys = Object.keys(localStorage).filter((k) => k.startsWith(DIAMOND_LOG_PREFIX))
  } catch {
    return
  }
  if (keys.length <= retain) return
  // Trailing portion of each key is the puzzle date (YYYY-MM-DD) — sortable.
  keys.sort()
  for (const key of keys.slice(0, keys.length - retain)) removeStorage(key)
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
  if (run.testMode) {
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

  // Evict the full image from the SW cache, but only for puzzles
  // whose date isn't today — the launcher reuses the cached full
  // image to upgrade the slice preview, and we want today's preview
  // sharp. Past completions (archive replays) evict immediately
  // because they're not on the menu. The next-day sweep in
  // renderLauncher handles today's completions once the date rolls.
  const todayKey = getIsoDate(new Date())
  if (run.puzzleDate !== todayKey) {
    evictCompletedImageFromCache(run)
  }
}

// On launcher render, sweep the SW cache for full images of completed
// puzzles whose date is before today. They were kept around for the
// launcher's upgrade-to-full while their date was current; now they
// are no longer on the menu and we can reclaim the bytes. Uses a
// predictable URL pattern (the worker serves /cdn/puzzles/YYYY-MM-DD/
// <category>.webp) so we don't need the exact ?v= cache-bust — the
// SW evict handler runs with ignoreSearch.
function evictPastCompletedImages(todayDate) {
  if (typeof navigator === 'undefined') return
  const sw = navigator.serviceWorker
  if (!sw || !sw.controller) return
  const completedRunsByDate = getCompletedRunsByDate()
  const urls = []
  for (const [date, dateRuns] of Object.entries(completedRunsByDate)) {
    if (!date || date >= todayDate) continue
    if (!dateRuns || typeof dateRuns !== 'object') continue
    for (const mode of Object.keys(dateRuns)) {
      const categoryKey = GAME_MODE_TO_PUZZLE_CATEGORY[normalizeGameMode(mode)] || 'jigsaw'
      urls.push(`/cdn/puzzles/${date}/${categoryKey}.webp`)
    }
  }
  if (urls.length === 0) return
  try {
    sw.controller.postMessage({ type: 'evict-cached', urls })
  } catch {}
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
    try { localStorage.removeItem(key) } catch { }
    return null
  }
  return { ...run, gameMode: normalizeGameMode(run.gameMode), _storageKey: key }
}

function hasActiveRun(puzzleDate, gameMode) {
  return getRunForMode(puzzleDate, gameMode) !== null
}

// Compute (lockedCount, totalCount) directly from a saved puzzleState
// for runs that pre-date when those fields started being persisted on
// the run object itself. Falls back to (0, 0) for shapes we can't
// recognise — caller treats the row as 0%.
function deriveProgressFromState(gameMode, puzzleState) {
  if (!puzzleState || typeof puzzleState !== 'object') return null
  if (gameMode === GAME_MODE_DIAMOND) {
    if (!Array.isArray(puzzleState.grid) || !Array.isArray(puzzleState.fills)) return null
    const grid = puzzleState.grid
    const fills = puzzleState.fills
    if (grid.length !== fills.length) return null
    let count = 0
    for (let i = 0; i < grid.length; i++) {
      if (fills[i] === grid[i]) count++
    }
    return { lockedCount: count, totalCount: grid.length }
  }
  if (gameMode === GAME_MODE_JIGSAW || gameMode === GAME_MODE_POLYGRAM) {
    if (!Array.isArray(puzzleState.pieces)) return null
    const total = puzzleState.pieces.length
    const count = puzzleState.pieces.filter((p) => p && p.locked).length
    return { lockedCount: count, totalCount: total }
  }
  if (gameMode === GAME_MODE_SLIDING) {
    if (!Array.isArray(puzzleState.slots) || !Array.isArray(puzzleState.homes)) return null
    const slots = puzzleState.slots
    const homes = puzzleState.homes
    const empty = Number(puzzleState.emptyIndex)
    let count = 0
    let total = 0
    for (let i = 0; i < slots.length; i++) {
      if (i === empty) continue
      total++
      const tileId = slots[i]
      if (homes[tileId] === i) count++
    }
    return { lockedCount: count, totalCount: total }
  }
  if (gameMode === GAME_MODE_SWAP) {
    if (!Array.isArray(puzzleState.slots) || !Array.isArray(puzzleState.homes)) return null
    const slots = puzzleState.slots
    const homes = puzzleState.homes
    let count = 0
    for (let i = 0; i < slots.length; i++) {
      const tileId = slots[i]
      if (homes[tileId] === i) count++
    }
    return { lockedCount: count, totalCount: slots.length }
  }
  return null
}

// Returns every uncompleted archive run (per-mode keyed) on this
// device, sorted by progress fraction descending — so the closest-to-
// done puzzles surface first. Used by the Unfinished modal to taunt
// the user into closing them out.
function getAllIncompleteArchiveRuns(todayDate = getIsoDate(new Date())) {
  const out = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('xefig:run:')) continue
    const run = readJsonStorage(key)
    if (!run || typeof run !== 'object') continue
    if (run.completed) continue
    if (!run.puzzleDate || !run.imageUrl) continue
    if (run.puzzleDate === todayDate) continue
    let locked = Number(run.lockedCount) || 0
    let total = Number(run.totalCount) || 0
    // Backfill: runs saved before lockedCount/totalCount were stamped
    // on the run object only have puzzleState. Derive on read so old
    // runs surface real progress instead of all reading 0%.
    if (total <= 0 && run.puzzleState) {
      const derived = deriveProgressFromState(normalizeGameMode(run.gameMode), run.puzzleState)
      if (derived) {
        locked = derived.lockedCount
        total = derived.totalCount
      }
    }
    const fraction = total > 0 ? locked / total : 0
    const updatedAt = Date.parse(run.updatedAt || run.startedAt || '')
    out.push({
      ...run,
      gameMode: normalizeGameMode(run.gameMode),
      _progressFraction: fraction,
      _lockedCount: locked,
      _totalCount: total,
      _updatedAtMs: Number.isFinite(updatedAt) ? updatedAt : 0,
    })
  }
  out.sort((a, b) => {
    if (b._progressFraction !== a._progressFraction) return b._progressFraction - a._progressFraction
    return b._updatedAtMs - a._updatedAtMs
  })
  return out
}

function formatRelativeAge(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return ''
  const ageMs = Date.now() - timestampMs
  if (ageMs < 0) return 'just now'
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`
  if (ageMs < day) return `${Math.round(ageMs / hour)}h ago`
  if (ageMs < 14 * day) return `${Math.round(ageMs / day)} days ago`
  if (ageMs < 60 * day) return `${Math.round(ageMs / (7 * day))} weeks ago`
  return `${Math.round(ageMs / (30 * day))} months ago`
}

// Mixed-tone goading copy. Warm for high progress, cheekier for stale
// or barely-started runs. Picks deterministically from the run's seed
// so the line is stable across re-renders, but varied across rows in
// the list. Each bucket has enough lines that adjacent rows in the
// same bucket should rarely share copy.
function getGoadingCopy(run) {
  const fraction = run._progressFraction || 0
  const pct = Math.round(fraction * 100)
  const elapsed = Number(run.elapsedActiveMs) || 0
  const minutes = Math.round(elapsed / 60000)
  const ageMs = run._updatedAtMs ? Date.now() - run._updatedAtMs : 0
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000))
  // Stable but varied — combine multiple identifying fields so adjacent
  // rows with similar dates pick different lines.
  const idStr = `${run.runId || ''}${run.puzzleDate || ''}${run.gameMode || ''}${run.startedAt || ''}`
  const seed = idStr.split('').reduce((s, c) => ((s * 31) + c.charCodeAt(0)) >>> 0, 5381)
  const pick = (lines) => lines[seed % lines.length]

  if (fraction >= 0.95) {
    return pick([
      `${pct}% there. Don't blink now.`,
      `${100 - pct}% from done. Seriously.`,
      `One more sitting. That's it.`,
      `So close it hurts to look.`,
      `${pct}% — leaving it here would be cruel.`,
      `The last few cells are the easy ones.`,
    ])
  }
  if (fraction >= 0.8) {
    return pick([
      `${pct}% done. The hard part is behind you.`,
      `Coast home from ${pct}%.`,
      `One last push from ${pct}%.`,
      `${minutes}m down, a few more to go.`,
      `${pct}% — finish it before you forget what it is.`,
      `The ending is the best bit.`,
    ])
  }
  if (fraction >= 0.6) {
    return pick([
      `Past halfway. ${pct}% done.`,
      `${pct}% — momentum is on your side.`,
      `${minutes}m invested. Don't waste it.`,
      `${pct}% says you can finish this one.`,
      `The middle is always the hardest. You're through it.`,
      `${pct}% done. Imagine that satisfying click.`,
    ])
  }
  if (fraction >= 0.4) {
    if (ageDays >= 21) return pick([
      `${pct}% done since ${ageDays} days ago. Awkward.`,
      `Half-done and forgotten. Pick it back up.`,
      `${ageDays} days, ${pct}%, and counting.`,
    ])
    return pick([
      `${pct}% done · ${minutes}m so far. Keep rolling.`,
      `Halfway-ish. The view from the top is better.`,
      `${pct}% — too far in to bail.`,
      `${pct}% done. Sunk cost is real, you know.`,
      `${minutes}m in. Don't make it for nothing.`,
    ])
  }
  if (fraction >= 0.15) {
    if (ageDays >= 21) return pick([
      `${ageDays} days old and only ${pct}% in. Either commit or admit defeat.`,
      `${pct}% done. ${ageDays} days ago. Awkward, isn't it?`,
      `It's been ${ageDays} days. The puzzle remembers.`,
    ])
    return pick([
      `${pct}% in. The hard part is starting — and you've already done that.`,
      `${pct}% done. Don't make it ${pct + 5}% next week. Finish it.`,
      `Barely scratched it (${pct}%). One sitting and it's gone.`,
      `${minutes}m and ${pct}%. Either invest or walk away.`,
    ])
  }
  // Sub-15% — barely-anything bucket. The richest bucket because most
  // unfinished archive runs end up here.
  if (ageDays >= 60) return pick([
    `${ageDays} days untouched. It's started seeing other players.`,
    `Two months gone. Show some commitment.`,
    `Older than some news cycles. Finish or forget.`,
    `${ageDays} days. The puzzle is older than the urge to play it.`,
    `Still here after ${ageDays} days. Imagine the loyalty.`,
  ])
  if (ageDays >= 30) return pick([
    `Untouched for ${ageDays} days. Lonely puzzle.`,
    `${ageDays} days of nothing. Throw it a bone.`,
    `A month of silence. Even a tap would do.`,
    `${ageDays} days old. Either play it or put it out of its misery.`,
    `Started ${ageDays} days ago. Has anything else lasted that long?`,
  ])
  if (ageDays >= 14) return pick([
    `${ageDays} days. Maybe today's the day.`,
    `${ageDays} days old, ${pct}% done. The maths isn't kind.`,
    `Two weeks in storage. Dust it off.`,
    `${ageDays} days idle. Surely you've got 5 minutes.`,
  ])
  if (ageDays >= 7) return pick([
    `${ageDays} days old. Don't let it grow legs.`,
    `A week stale. Refresh the streak.`,
    `${ageDays} days untouched — give it some love.`,
  ])
  if (minutes >= 10) return pick([
    `${minutes}m in and ${pct}% done. Either it's hard or you're stalling.`,
    `${minutes}m of effort to show ${pct}%. Push through.`,
    `${minutes}m down with ${pct}% to show. Don't write it off now.`,
  ])
  if (minutes >= 3) return pick([
    `${minutes}m in. Get back to it.`,
    `Just getting started — keep going.`,
    `${minutes}m so far. Pace yourself.`,
  ])
  return pick([
    `Just started. Don't ghost it.`,
    `Fresh start. Make it count.`,
    `Newly opened. The clock is ticking.`,
    `Brand-new. Don't let it become another stale entry.`,
  ])
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
}

function clearRunForMode(run) {
  if (!run?.puzzleDate || !run?.gameMode) return
  const key = activeRunKey(run.puzzleDate, run.gameMode)
  removeStorage(key)
  markActiveRunDeleted(run)
}

function loadTestActiveRun() {
  const run = readJsonStorage(TEST_ACTIVE_RUN_KEY)
  if (!run || typeof run !== 'object') return null
  if (run.completed) return null
  if (!run.testMode) return null
  return run
}

function saveTestActiveRun(run) {
  if (!run?.testMode) return
  writeJsonStorage(TEST_ACTIVE_RUN_KEY, run)
}

function clearTestActiveRun() {
  removeStorage(TEST_ACTIVE_RUN_KEY)
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
  if (currentRun.testMode) {
    // Test runs save to a dedicated single-slot key so they survive
    // back-navigation and tab discards (the whole point of the test
    // area), but never appear in the launcher's Resume pill, never
    // sync, and never compete with real per-mode active runs.
    const elapsed = getActiveElapsedMs()
    if (elapsed === 0 && !progressState) return
    const nextPuzzleState = progressState || (puzzle ? puzzle.getProgressState() : currentRun.puzzleState)
    currentRun = {
      ...currentRun,
      elapsedActiveMs: elapsed,
      updatedAt: new Date().toISOString(),
      puzzleState: nextPuzzleState,
    }
    saveTestActiveRun(currentRun)
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
  if (!card) return () => { }
  const cloud = card.querySelector('.more-card-sync-cloud')
  if (!cloud) return () => { }
  const apply = (status) => {
    const hasChanges = hasPendingChanges()
    let cloudState = 'saved'
    let label = 'Saved to cloud — tap to send to another device'
    if (status === 'syncing') {
      cloudState = 'syncing'; label = 'Syncing...'
    } else if (status === 'error') {
      cloudState = 'error'
      label = hasChanges
        ? 'Sync failed — changes queued, will retry'
        : 'Sync failed — open Settings to retry'
    } else if (hasChanges) {
      cloudState = 'pending'; label = 'Pending changes — syncing soon'
    }
    cloud.dataset.state = cloudState
    // The up-arrow tracks "data queued for upload" independent of the
    // status colour. So an `error` state with queued changes still
    // shows the arrow (red cloud + ↑ = "we tried, failed, but data is
    // still waiting to go up").
    cloud.dataset.pending = hasChanges ? 'true' : 'false'
    card.title = label
    card.setAttribute('aria-label', label)
  }
  apply(getSyncStatus())
  const off = onStatusChange(apply)
  return typeof off === 'function' ? off : () => { }
}

// ─── PWA install detection ──────────────────────────────────────────────────
// Platform detection logic adapted from khmyznikov/pwa-install (MIT, © 2023
// Gleb Khmyznikov). See showInstallGuide() below for the lifted SVG icons.
const INSTALLED_FLAG_KEY = 'xefig-installed'
let deferredInstallPrompt = null
let appAlreadyInstalled = false
function readInstalledFlag() {
  try { return localStorage.getItem(INSTALLED_FLAG_KEY) === '1' } catch { return false }
}
function writeInstalledFlag() {
  try { localStorage.setItem(INSTALLED_FLAG_KEY, '1') } catch { }
}
function clearInstalledFlag() {
  try { localStorage.removeItem(INSTALLED_FLAG_KEY) } catch { }
}
function rerenderMoreSheet() {
  const open = document.querySelector('.more-sheet-overlay')
  if (open && typeof open.__rerender === 'function') open.__rerender()
}
// Bind synchronously at module load — Chrome only fires beforeinstallprompt
// once per page load, so registering inside initAppShell can miss it.
// BIP only fires when the PWA is NOT installed, so receiving it means any
// stale "installed" state (e.g. left over after the user uninstalled) is wrong.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstallPrompt = e
  appAlreadyInstalled = false
  clearInstalledFlag()
  rerenderMoreSheet()
})
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null
  appAlreadyInstalled = true
  writeInstalledFlag()
  rerenderMoreSheet()
})
// Persisted flag from an earlier install/standalone visit (localStorage is
// shared between the standalone PWA and the regular tab on desktop Chrome
// and Android — getInstalledRelatedApps is mostly Android-only).
if (readInstalledFlag()) {
  appAlreadyInstalled = true
}
// If we're running in standalone mode right now, the PWA is installed —
// persist the flag so a future visit in a regular tab can detect it.
if (typeof window !== 'undefined' && window.matchMedia) {
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) writeInstalledFlag()
    else if (typeof navigator !== 'undefined' && navigator.standalone === true) writeInstalledFlag()
  } catch { }
}
// Chromium also exposes getInstalledRelatedApps (mostly Android). The manifest
// declares related_applications: [{ platform: "webapp", url: ... }] pointing
// at our own manifest so this returns truthy when installed.
; (async () => {
  try {
    if (typeof navigator.getInstalledRelatedApps !== 'function') return
    const apps = await navigator.getInstalledRelatedApps()
    if (apps.some((app) => app.platform === 'webapp')) {
      appAlreadyInstalled = true
      writeInstalledFlag()
      rerenderMoreSheet()
    }
  } catch { }
})()
function bindInstallPromptListeners() { /* listeners are bound at module load */ }

function isStandaloneDisplay() {
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true
  } catch { }
  return false
}

function getUA() {
  return (typeof navigator !== 'undefined' && navigator.userAgent) || ''
}

function isAppleMobile() {
  // iPhone reports as iPhone; iPadOS reports as Mac with touch.
  const ua = getUA()
  return /Mac|iPhone|iPod|iPad/.test(ua) && (navigator.maxTouchPoints || 0) > 1
}

function isIpad() {
  return isAppleMobile() && /iPad|Macintosh/.test(getUA())
}

function isAppleMobileNonSafari() {
  return isAppleMobile() && /CriOS|FxiOS|EdgiOS/.test(getUA())
}

function isAppleDesktopSafari() {
  // macOS Safari (no touch). Limited to Safari 17+ where the modern install
  // story (web app via File menu / Dock) actually exists.
  if ((navigator.maxTouchPoints || 0) > 0) return false
  const ua = getUA()
  if (!/macintosh/i.test(ua)) return false
  if (/Chrome|CriOS|Firefox|FxiOS|Edg|EdgiOS/.test(ua)) return false
  const m = /version\/(\d+)\./i.exec(ua)
  if (!m) return false
  return parseInt(m[1], 10) >= 17
}

function isAndroid() {
  return /android/i.test(getUA())
}

function getInstallPlatform() {
  if (isStandaloneDisplay()) return 'standalone'
  if (appAlreadyInstalled) return 'installed'
  if (deferredInstallPrompt) return 'chrome-prompt'
  if (isAppleMobileNonSafari()) return 'ios-other-browser'
  if (isIpad()) return 'ipad-safari'
  if (isAppleMobile()) return 'ios-safari'
  if (isAppleDesktopSafari()) return 'macos-safari'
  // Any Android browser without a captured prompt (Chrome before the
  // engagement heuristic, Firefox Android, Samsung Internet) installs via
  // the browser menu, not a JS prompt.
  if (isAndroid()) return 'android-fallback'
  // Desktop Chromium where BIP exists but hasn't fired — point at the
  // address-bar install icon and the browser menu fallback.
  if ('BeforeInstallPromptEvent' in window) return 'chrome-no-prompt'
  return 'unsupported'
}

function getInstallCardCopy(platform) {
  switch (platform) {
    case 'chrome-prompt': return 'Add to your home screen'
    case 'chrome-no-prompt': return 'Use the address-bar install icon'
    case 'android-fallback': return 'Add via your browser menu'
    case 'ios-safari':
    case 'ipad-safari': return 'Tap Share → Add to Home Screen'
    case 'ios-other-browser': return 'Open in Safari to install'
    case 'macos-safari': return 'Share → Add to Dock'
    default: return ''
  }
}

function renderLauncher() {
  destroyPuzzle()

  const todayDate = getIsoDate(new Date())
  state.sourceMode = 'today'
  state.archiveDate = todayDate
  state.gameMode = getGameModeOfDay(todayDate)
  state.difficulty = state.difficulty || 'medium'

  // Reclaim cache bytes for completions that are no longer on the
  // menu. Today's completed full images stay (they upgrade the slice
  // preview); anything before today is fair game.
  evictPastCompletedImages(todayDate)

  const ACTIVE_FLEX = 3
  const INACTIVE_FLEX = 0.8
  const MORE_INACTIVE_FLEX = 0.6
  const pickMode = getGameModeOfDay(todayDate)
  const modes = [GAME_MODE_JIGSAW, GAME_MODE_SLIDING, GAME_MODE_SWAP, GAME_MODE_POLYGRAM, GAME_MODE_DIAMOND]

  // Swap the launcher's slice images from thumbnail → full only if
  // the full image is ALREADY in the browser/SW cache (downloaded
  // previously by playing the puzzle or by a background prefetch).
  // Never initiates a fresh fetch: the menu's job is to render fast
  // and stay usable on a bad line. Thumbnails are the priority — they
  // are sufficient for the slice preview and the gameplay path will
  // upgrade on its own. The /api/* cache lookup goes through all
  // active caches (HTTP + service worker), so a one-time check is
  // enough; no need to know which named cache holds the asset.
  async function upgradeSliceImagesToFull(scope) {
    if (typeof caches === 'undefined') return
    const imgs = scope.querySelectorAll('img.slice-image[data-full-url]')
    for (const img of imgs) {
      const fullUrl = img.dataset.fullUrl
      if (!fullUrl || img.src === fullUrl) continue
      try {
        // ignoreSearch: defensive — the /cdn SW handler keys by full
        // URL (including ?v=…), so an exact match works for normal
        // play. ignoreSearch covers the case where a regenerated
        // puzzle's ?v= changes between caching and lookup, so we can
        // still surface the older cached copy on the menu.
        const hit = await caches.match(fullUrl) || await caches.match(fullUrl, { ignoreSearch: true })
        if (hit) img.src = fullUrl
      } catch {
        // Cache lookup unavailable — leave the thumbnail.
      }
    }
  }

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
          : `<img class="slice-image" src="${imageUrl}" data-full-url="${fullImageUrl}" alt="${title}" decoding="async" loading="${isLCP ? 'eager' : 'lazy'}"${isLCP ? ' fetchpriority="high"' : ''} />`

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
      state.imageUrl = resolveResumeImageUrl(savedRun, state.puzzle)
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

  ; (async () => {
    try {
      const payload = await fetchPuzzlePayload()
      state.puzzle = payload
      container.innerHTML = renderSlices(payload)
      bindSliceEvents()
      computeSliceCenter(container)
      upgradeSliceImagesToFull(container)

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

      // Prefetch full-resolution images in priority order — active
      // resume runs first, then today's unplayed modes. Throttled,
      // gated on healthy network, deferred to idle so it never fights
      // user interaction. Completed puzzles are NOT prefetched: today's
      // completed images are already in cache (we keep them so the
      // launcher can upgrade the slice preview), and past-day
      // completions are evicted on launcher render so re-pulling them
      // here would just defeat that sweep.
      const triggerPrefetch = () => {
        prefetchPlayableImages(payload).catch(() => { })
      }
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(triggerPrefetch, { timeout: 4000 })
      } else {
        setTimeout(triggerPrefetch, 800)
      }

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
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Petal positions match brand favicon: diamond at 0° after the -20° root
// rotation, then sliding/polygram/jigsaw/swap clockwise. baseRot is applied
// to both the petal and its matching star arm so a completed mode lights
// up its colour wedge AND fills in that arm of the central gold star.
const ARCHIVE_GLYPH_MODES = [
  { key: GAME_MODE_DIAMOND, color: '#e070a0', baseRot: 0 },
  { key: GAME_MODE_SLIDING, color: '#40d0f0', baseRot: 72 },
  { key: GAME_MODE_POLYGRAM, color: '#a060f0', baseRot: 144 },
  { key: GAME_MODE_JIGSAW, color: '#f0c040', baseRot: 216 },
  { key: GAME_MODE_SWAP, color: '#50d070', baseRot: 288 },
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
      <radialGradient id="medal-onyx-empty" cx="35%" cy="28%" r="78%">
        <stop offset="0%"   stop-color="#52585f"/>
        <stop offset="35%"  stop-color="#2a2e34"/>
        <stop offset="80%"  stop-color="#0e1014"/>
        <stop offset="100%" stop-color="#000000"/>
      </radialGradient>
      <radialGradient id="medal-onyx-full" cx="35%" cy="28%" r="78%">
        <stop offset="0%"   stop-color="#6a7078"/>
        <stop offset="35%"  stop-color="#34383e"/>
        <stop offset="80%"  stop-color="#14181c"/>
        <stop offset="100%" stop-color="#000000"/>
      </radialGradient>
      <filter id="medal-shadow" x="-25%" y="-25%" width="150%" height="150%">
        <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.35"/>
      </filter>
    </defs>
  </svg>
`

function pointOnArchiveCircle(angleDeg, r) {
  const a = (angleDeg - 90) * Math.PI / 180
  return [Math.cos(a) * r, Math.sin(a) * r]
}

// ─── Medal SVG (day / week / month) ───────────────────────────────────
// All three sizes share the same construction: an onyx body with a gold
// trim ring inset slightly so the onyx edge wraps it, an inner bezel
// hairline, the central petal/arm glyph, and a top-of-disc highlight
// crescent that sells the "minted" look. Day medals show per-mode state
// in the central glyph; week/month medals show progress via outer pips/
// ticks that flip from a faint silver engraving to gold once lit.
const MEDAL_SHADOW_FILTER = 'url(#medal-shadow)'
const MEDAL_RIM = '#000000'
const MEDAL_TICK_FILLED = '#fcd97a'
const MEDAL_TICK_EMPTY = 'rgba(180, 185, 195, 0.18)'
const MEDAL_ARM_ON = '#fcd97a'
const MEDAL_ARM_OFF = 'rgba(150, 155, 165, 0.32)'
const MEDAL_PETAL_OFF = '#9aa0a8'
const MEDAL_PETAL_OFF_OPACITY = '0.28'
const MEDAL_HIGHLIGHT = 'rgba(255, 255, 255, 0.22)'

const MEDAL_GEOM = {
  day: { bodyR: 78, goldR: 72, goldWidth: 5.5, glyphScale: 0.62, highlightPath: 'M -56 -36 A 68 68 0 0 1 56 -36', highlightWidth: 1.1 },
  week: { bodyR: 82, goldR: 76, goldWidth: 3, pipR: 64, pipSize: 5.5, bezelR: 52, glyphScale: 0.4, highlightPath: 'M -60 -38 A 72 72 0 0 1 60 -38', highlightWidth: 1.3 },
  month: { bodyR: 92, goldR: 85, goldWidth: 4, tickInner: 70, tickOuter: 80, tickWidthFilled: 4, tickWidthEmpty: 3, bezelR: 60, glyphScale: 0.46, highlightPath: 'M -68 -45 A 82 82 0 0 1 68 -45', highlightWidth: 1.5 },
}

function medalBodyDisc(geom, isComplete) {
  const ns = 'http://www.w3.org/2000/svg'
  const disc = document.createElementNS(ns, 'circle')
  disc.setAttribute('r', String(geom.bodyR))
  disc.setAttribute('fill', isComplete ? 'url(#medal-onyx-full)' : 'url(#medal-onyx-empty)')
  disc.setAttribute('stroke', MEDAL_RIM)
  disc.setAttribute('stroke-width', '1.5')
  return disc
}

function medalGoldRing(geom) {
  const ns = 'http://www.w3.org/2000/svg'
  const ring = document.createElementNS(ns, 'circle')
  ring.setAttribute('r', String(geom.goldR))
  ring.setAttribute('fill', 'none')
  ring.setAttribute('stroke', 'url(#gold-grad)')
  ring.setAttribute('stroke-width', String(geom.goldWidth))
  return ring
}

function medalBezel(geom) {
  const ns = 'http://www.w3.org/2000/svg'
  const bezel = document.createElementNS(ns, 'circle')
  bezel.setAttribute('r', String(geom.bezelR))
  bezel.setAttribute('fill', 'none')
  bezel.setAttribute('stroke', MEDAL_RIM)
  bezel.setAttribute('stroke-opacity', '0.45')
  bezel.setAttribute('stroke-width', '1')
  return bezel
}

function medalHighlight(geom) {
  const ns = 'http://www.w3.org/2000/svg'
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', geom.highlightPath)
  path.setAttribute('stroke', MEDAL_HIGHLIGHT)
  path.setAttribute('stroke-width', String(geom.highlightWidth))
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke-linecap', 'round')
  return path
}

// Decorative central glyph for the week / month medals — all 5 petals
// always lit (this is the brand mark, not a state indicator).
function appendArchiveCentralGlyph(svg, scale, isComplete) {
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

  const armRoot = document.createElementNS(ns, 'g')
  armRoot.setAttribute('transform', 'rotate(-20)')
  ARCHIVE_GLYPH_MODES.forEach((m) => {
    const arm = document.createElementNS(ns, 'use')
    arm.setAttribute('href', '#xefig-arm')
    arm.setAttribute('transform', `rotate(${m.baseRot})`)
    arm.setAttribute('fill', isComplete ? MEDAL_ARM_ON : 'rgba(252, 217, 122, 0.55)')
    armRoot.appendChild(arm)
  })
  g.appendChild(armRoot)

  svg.appendChild(g)
}

// Per-mode glyph for the daily medal — lit petal = mode finished, gold
// arm. Unlit petals fade to a faint silver.
function makeArchiveGlyph({ done = [] } = {}) {
  const ns = 'http://www.w3.org/2000/svg'
  const geom = MEDAL_GEOM.day
  const allDone = done.length === ARCHIVE_GLYPH_MODES.length

  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('glyph')
  svg.setAttribute('viewBox', '-100 -100 200 200')
  if (allDone) svg.dataset.complete = '1'

  const body = document.createElementNS(ns, 'g')
  body.setAttribute('filter', MEDAL_SHADOW_FILTER)
  body.appendChild(medalBodyDisc(geom, allDone))
  body.appendChild(medalGoldRing(geom))

  const glyph = document.createElementNS(ns, 'g')
  glyph.setAttribute('transform', `scale(${geom.glyphScale})`)

  const doneSet = new Set(done)
  const petalRoot = document.createElementNS(ns, 'g')
  petalRoot.setAttribute('transform', 'rotate(-20)')
  ARCHIVE_GLYPH_MODES.forEach((m) => {
    const petal = document.createElementNS(ns, 'use')
    petal.setAttribute('href', '#xefig-petal')
    petal.setAttribute('transform', `rotate(${m.baseRot})`)
    if (doneSet.has(m.key)) {
      petal.setAttribute('fill', m.color)
      petal.setAttribute('opacity', '0.95')
    } else {
      petal.setAttribute('fill', MEDAL_PETAL_OFF)
      petal.setAttribute('opacity', MEDAL_PETAL_OFF_OPACITY)
    }
    petalRoot.appendChild(petal)
  })
  glyph.appendChild(petalRoot)

  const armRoot = document.createElementNS(ns, 'g')
  armRoot.setAttribute('transform', 'rotate(-20)')
  ARCHIVE_GLYPH_MODES.forEach((m) => {
    const arm = document.createElementNS(ns, 'use')
    arm.setAttribute('href', '#xefig-arm')
    arm.setAttribute('transform', `rotate(${m.baseRot})`)
    arm.setAttribute('fill', doneSet.has(m.key) ? MEDAL_ARM_ON : MEDAL_ARM_OFF)
    armRoot.appendChild(arm)
  })
  glyph.appendChild(armRoot)
  body.appendChild(glyph)

  svg.appendChild(body)
  svg.appendChild(medalHighlight(geom))
  return svg
}

function buildWeekMedal({ completed = [], totalDays = 7 }) {
  const ns = 'http://www.w3.org/2000/svg'
  const geom = MEDAL_GEOM.week
  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('tier-svg')
  svg.setAttribute('viewBox', '-100 -100 200 200')

  const completedSet = new Set(completed)
  const isComplete = totalDays > 0 && completedSet.size === totalDays

  const body = document.createElementNS(ns, 'g')
  body.setAttribute('filter', MEDAL_SHADOW_FILTER)
  body.appendChild(medalBodyDisc(geom, isComplete))
  body.appendChild(medalGoldRing(geom))

  for (let i = 0; i < totalDays; i++) {
    const angle = (360 / totalDays) * i - 90
    const [x, y] = pointOnArchiveCircle(angle + 90, geom.pipR)
    const pip = document.createElementNS(ns, 'circle')
    pip.setAttribute('cx', x.toFixed(2))
    pip.setAttribute('cy', y.toFixed(2))
    pip.setAttribute('r', String(geom.pipSize))
    pip.setAttribute('fill', completedSet.has(i) ? MEDAL_TICK_FILLED : MEDAL_TICK_EMPTY)
    if (!completedSet.has(i)) {
      pip.setAttribute('stroke', MEDAL_RIM)
      pip.setAttribute('stroke-opacity', '0.4')
      pip.setAttribute('stroke-width', '0.8')
    }
    body.appendChild(pip)
  }

  body.appendChild(medalBezel(geom))
  appendArchiveCentralGlyph(body, geom.glyphScale, isComplete)

  svg.appendChild(body)
  svg.appendChild(medalHighlight(geom))
  return svg
}

function buildMonthMedal({ completed = [], totalDays = 30 }) {
  const ns = 'http://www.w3.org/2000/svg'
  const geom = MEDAL_GEOM.month
  const svg = document.createElementNS(ns, 'svg')
  svg.classList.add('tier-svg')
  svg.setAttribute('viewBox', '-100 -100 200 200')

  const completedSet = new Set(completed)
  const isComplete = totalDays > 0 && completedSet.size === totalDays

  const body = document.createElementNS(ns, 'g')
  body.setAttribute('filter', MEDAL_SHADOW_FILTER)
  body.appendChild(medalBodyDisc(geom, isComplete))
  body.appendChild(medalGoldRing(geom))

  for (let i = 0; i < totalDays; i++) {
    const angle = (360 / totalDays) * i
    const a = (angle - 90) * Math.PI / 180
    const x1 = Math.cos(a) * geom.tickInner, y1 = Math.sin(a) * geom.tickInner
    const x2 = Math.cos(a) * geom.tickOuter, y2 = Math.sin(a) * geom.tickOuter
    const tick = document.createElementNS(ns, 'line')
    tick.setAttribute('x1', x1.toFixed(2))
    tick.setAttribute('y1', y1.toFixed(2))
    tick.setAttribute('x2', x2.toFixed(2))
    tick.setAttribute('y2', y2.toFixed(2))
    tick.setAttribute('stroke', completedSet.has(i) ? MEDAL_TICK_FILLED : MEDAL_TICK_EMPTY)
    tick.setAttribute('stroke-width', String(completedSet.has(i) ? geom.tickWidthFilled : geom.tickWidthEmpty))
    tick.setAttribute('stroke-linecap', 'round')
    body.appendChild(tick)
  }

  body.appendChild(medalBezel(geom))
  appendArchiveCentralGlyph(body, geom.glyphScale, isComplete)

  svg.appendChild(body)
  svg.appendChild(medalHighlight(geom))
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
        <div class="cal-dots-bar">
          <button class="cal-side-arrow cal-side-arrow-prev" data-role="cal-side-prev" data-action="prev" aria-label="Previous month">‹</button>
          <div class="cal-dots" data-role="cal-dots"></div>
          <button class="cal-side-arrow cal-side-arrow-next" data-role="cal-side-next" data-action="next" aria-label="Next month">›</button>
        </div>
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
  const prevBtn = pageEl.querySelector('.cal-nav [data-action="prev"]')
  const nextBtn = pageEl.querySelector('.cal-nav [data-action="next"]')
  const sidePrevBtn = pageEl.querySelector('[data-role="cal-side-prev"]')
  const sideNextBtn = pageEl.querySelector('[data-role="cal-side-next"]')
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
    // The resume button gets re-parented into the active hero in landscape;
    // preserve it across replaceChildren below so it isn't dropped from DOM.
    const stashedResumeBtn = entry.hero.querySelector('[data-role="archive-resume-btn"]')

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
    if (stashedResumeBtn) entry.hero.appendChild(stashedResumeBtn)
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
    const atFirst = activeMonthIndex === 0
    const atLast = activeMonthIndex === 11
    prevBtn.disabled = atFirst
    nextBtn.disabled = atLast
    sidePrevBtn.disabled = atFirst
    sideNextBtn.disabled = atLast
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
    placeArchiveResumeBtn()
  }

  // In landscape the resume button moves into the active month's hero
  // panel (alongside title/medal/counter) so it doesn't steal a horizontal
  // band from the cal-deck and crush the day cells. In portrait it lives
  // in the cal-region grid (top-right "resume" area).
  function placeArchiveResumeBtn() {
    const btn = pageEl.querySelector('[data-role="archive-resume-btn"]')
    if (!btn) return
    const isLandscape = !!(window.matchMedia && window.matchMedia('(orientation: landscape)').matches)
    const region = pageEl.querySelector('.cal-region')
    const target = isLandscape
      ? (monthCards[activeMonthIndex]?.hero || region)
      : region
    if (target && btn.parentElement !== target) target.appendChild(btn)
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
        placeArchiveResumeBtn()
      }
    }, 60)
  })

  if (window.matchMedia) {
    window.matchMedia('(orientation: landscape)')
      .addEventListener('change', () => {
        // Rotation changes card content widths while deck.scrollLeft is
        // preserved, so the saved offset now points between months. Capture
        // activeMonthIndex up front and silence the pending scroll-snap
        // timer — without this, reflow-triggered scroll events update
        // activeMonthIndex to an adjacent month before we re-center, and
        // we'd then jump to the wrong target.
        const target = activeMonthIndex
        clearTimeout(scrollTimer)
        placeArchiveResumeBtn()
        requestAnimationFrame(() => requestAnimationFrame(() => {
          jumpToMonth(target)
        }))
      })
  }

  function stepMonth(delta) {
    const next = activeMonthIndex + delta
    if (next < 0 || next > 11) return
    deck.scrollTo({ left: centerScrollLeftFor(next), behavior: 'smooth' })
  }
  prevBtn.addEventListener('click', () => stepMonth(-1))
  nextBtn.addEventListener('click', () => stepMonth(1))
  sidePrevBtn.addEventListener('click', () => stepMonth(-1))
  sideNextBtn.addEventListener('click', () => stepMonth(1))

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
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]
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
      state.imageUrl = resolveResumeImageUrl(savedRun, state.puzzle)
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
      }).catch(() => { })
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
    placeArchiveResumeBtn()
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
  onShowSource,
  onAfterDismiss,
}) {
  const overlay = document.createElement('div')
  overlay.className = 'completion-overlay'

  const dismiss = () => {
    if (overlay.dataset.dismissed === '1') return
    overlay.dataset.dismissed = '1'
    if (completedRun) clearRunForMode(completedRun)
    overlay.classList.remove('is-visible')
    overlay.style.pointerEvents = 'none'
    setTimeout(() => {
      overlay.remove()
      if (typeof onAfterDismiss === 'function') {
        try { onAfterDismiss() } catch (err) { console.error(err) }
      }
    }, 200)
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
      <div class="completion-actions">
        ${typeof onShowSource === 'function'
      ? `<button type="button" class="completion-show-source">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>
              Show source image
            </button>`
      : ''}
        <button type="button" class="completion-dismiss">Continue</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss()
  })
  overlay.querySelector('.completion-dismiss').addEventListener('click', dismiss)

  if (typeof onShowSource === 'function') {
    const showSourceBtn = overlay.querySelector('.completion-show-source')
    showSourceBtn?.addEventListener('click', () => {
      try {
        onShowSource()
      } finally {
        dismiss()
      }
    })
  }

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
  setTimeout(() => { try { input.focus(); input.select() } catch { } }, 50)

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
      navigator.storage.persist().catch(() => { })
    }
  } catch { }
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str || ''
  return div.innerHTML
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
      <div class="sync-code-display sync-celebrate-code sync-code-hidden">
        <span class="sync-code-value">${code}</span>
        <button type="button" class="sync-code-reveal" aria-label="Reveal sync code">Tap to reveal</button>
      </div>
      <div class="sync-celebrate-actions">
        <button type="button" class="sync-celebrate-share">Send to another device</button>
        <button type="button" class="sync-celebrate-copy">Copy code</button>
        <button type="button" class="sync-celebrate-syncnow">Sync now</button>
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
  const revealBtn = overlay.querySelector('.sync-code-reveal')
  const codeDisplay = overlay.querySelector('.sync-code-display')
  if (revealBtn && codeDisplay) {
    revealBtn.addEventListener('click', () => {
      codeDisplay.classList.remove('sync-code-hidden')
    })
  }

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
    } catch { }
  })

  const syncNowBtn = overlay.querySelector('.sync-celebrate-syncnow')
  syncNowBtn.addEventListener('click', async () => {
    if (syncNowBtn.disabled) return
    syncNowBtn.disabled = true
    const original = syncNowBtn.textContent
    syncNowBtn.textContent = 'Syncing…'
    try {
      const result = await forcePush()
      if (!result?.ran) {
        syncNowBtn.textContent = 'Sync not enabled'
      } else if (result.pulledChanges) {
        syncNowBtn.textContent = 'Synced — pulled changes'
      } else {
        syncNowBtn.textContent = 'Synced'
      }
    } catch {
      syncNowBtn.textContent = 'Sync failed'
    }
    setTimeout(() => {
      syncNowBtn.textContent = original
      syncNowBtn.disabled = false
    }, 1800)
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

function closeUnfinishedModal() {
  const overlay = document.querySelector('.unfinished-overlay')
  if (!overlay) return
  overlay.classList.remove('is-visible')
  setTimeout(() => overlay.remove(), 200)
}

// Replays handleSliceClick's archive-resume path from anywhere outside
// the renderHome closure. Fetches the puzzle payload for the date,
// resolves the image URL against any saved run, and routes through
// renderGame so resume restores fills + sessionLog correctly.
async function resumeArchiveRunFromList(mode, date) {
  const normalized = normalizeGameMode(mode)
  state.gameMode = normalized
  try {
    const payload = await fetchPuzzlePayload({ date })
    state.puzzle = payload
  } catch { }
  state.imageUrl = resolvePuzzleImageUrl(state.puzzle, state.gameMode)
  const savedRun = getRunForMode(date, state.gameMode)
  if (savedRun) {
    state.imageUrl = resolveResumeImageUrl(savedRun, state.puzzle)
    renderGame({ resumeRun: savedRun })
    return
  }
  // Fall-through: no saved run (the user might have just completed it
  // from a different device via sync, or it expired). Fresh start.
  renderGame()
}

// Surface every uncompleted archive run so the user can pick the one
// they're closest to finishing — sorted by completion fraction desc to
// bait OCD. If `struckRun` is provided, it's rendered first with a
// strike-through animation: the user just finished it, the modal nods
// to that win before pivoting to "and here are the rest."
function openUnfinishedModal({ struckRun = null, todayDate = getIsoDate(new Date()), onResume } = {}) {
  closeUnfinishedModal()
  const overlay = document.createElement('div')
  overlay.className = 'unfinished-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Unfinished puzzles')

  const remaining = getAllIncompleteArchiveRuns(todayDate)

  const struckHtml = struckRun
    ? `
      <div class="unfinished-struck">
        <div class="unfinished-struck-row">
          <span class="unfinished-mode-icon" data-mode="${struckRun.gameMode}"></span>
          <span class="unfinished-struck-label">${MODE_LABELS[struckRun.gameMode] || struckRun.gameMode}</span>
          <span class="unfinished-struck-stamp">DONE</span>
        </div>
      </div>
    `
    : ''

  const headerTitle = struckRun
    ? 'Nice. One down.'
    : (remaining.length === 0 ? 'All caught up' : 'Unfinished business')
  const headerSub = struckRun
    ? (remaining.length === 0
      ? 'Nothing else hanging.'
      : `${remaining.length} more waiting on you.`)
    : (remaining.length === 0
      ? 'Nothing waiting in the archive.'
      : `${remaining.length} archive ${remaining.length === 1 ? 'run' : 'runs'} you haven't closed out.`)

  const rowsHtml = remaining.map((run) => {
    const pct = Math.round((run._progressFraction || 0) * 100)
    const minutes = Math.round((Number(run.elapsedActiveMs) || 0) / 60000)
    const ageLabel = formatRelativeAge(run._updatedAtMs)
    const goading = getGoadingCopy(run)
    const modeLabel = MODE_LABELS[run.gameMode] || run.gameMode
    return `
      <button class="unfinished-row" type="button" data-mode="${run.gameMode}" data-date="${run.puzzleDate}">
        <span class="unfinished-mode-icon" data-mode="${run.gameMode}"></span>
        <span class="unfinished-row-body">
          <span class="unfinished-row-head">
            <span class="unfinished-row-mode">${modeLabel}</span>
            <span class="unfinished-row-pct">${pct}%</span>
          </span>
          <span class="unfinished-row-bar"><span class="unfinished-row-bar-fill" style="width:${pct}%"></span></span>
          <span class="unfinished-row-meta">${minutes}m played${ageLabel ? ` · ${ageLabel}` : ''}</span>
          <span class="unfinished-row-goad">${goading}</span>
        </span>
      </button>
    `
  }).join('')

  overlay.innerHTML = `
    <div class="unfinished-panel" role="document">
      <button type="button" class="unfinished-close" aria-label="Close">×</button>
      <div class="unfinished-header">
        <h2 class="unfinished-title">${headerTitle}</h2>
        <p class="unfinished-sub">${headerSub}</p>
      </div>
      ${struckHtml}
      <div class="unfinished-list">${rowsHtml || '<p class="unfinished-empty">Nothing here. Start one from the archive.</p>'}</div>
    </div>
  `

  document.body.appendChild(overlay)
  requestAnimationFrame(() => overlay.classList.add('is-visible'))

  // Animate the strike-through on the just-completed row a tick after
  // the panel has settled so the user perceives it as a deliberate
  // "✓ checking it off the list" moment, not a static label.
  if (struckRun) {
    const struckEl = overlay.querySelector('.unfinished-struck')
    if (struckEl) setTimeout(() => struckEl.classList.add('is-struck'), 220)
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeUnfinishedModal()
  })
  overlay.querySelector('.unfinished-close')?.addEventListener('click', closeUnfinishedModal)
  overlay.querySelectorAll('.unfinished-row').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode
      const date = btn.dataset.date
      closeUnfinishedModal()
      if (!mode || !date || typeof onResume !== 'function') return
      try {
        await onResume({ mode, date })
      } catch (err) {
        console.error('Resume from Unfinished failed', err)
      }
    })
  })

  return overlay
}

function openMoreSheet({ puzzleDate, handleSliceClick }) {
  const existing = document.querySelector('.more-sheet-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'more-sheet-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'More options')

  let detachSync = () => { }
  const renderCards = () => {
    const cards = []

    const incompletes = getAllIncompleteArchiveRuns(puzzleDate)
    if (incompletes.length > 0) {
      const count = incompletes.length
      cards.push(`
        <button class="more-sheet-card more-sheet-card--continue" data-action="continue">
          <span class="more-sheet-card-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6,4 20,12 6,20"/></svg>
          </span>
          <span class="more-sheet-card-text">
            <span class="more-sheet-card-title">Continue</span>
            <span class="more-sheet-card-sub">${count} unfinished — pick one</span>
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
            <span class="more-card-sync-cloud" data-state="saved" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 6.5 19Z"/>
                <path class="more-card-sync-cloud-arrow" d="M12 17 V11 M9 14 L12 11 L15 14"/>
              </svg>
            </span>
          </span>
          <span class="more-sheet-card-text">
            <span class="more-sheet-card-title">Devices</span>
            <span class="more-sheet-card-sub">Share with another device</span>
          </span>
        </button>`)
    }

    const installPlatform = getInstallPlatform()
    if (
      installPlatform !== 'standalone' &&
      installPlatform !== 'installed' &&
      installPlatform !== 'unsupported'
    ) {
      const sub = getInstallCardCopy(installPlatform)
      cards.push(`
        <button class="more-sheet-card more-sheet-card--install" data-action="install-app" data-install-platform="${installPlatform}">
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
    detachSync = bindMoreSheetSyncIndicator(overlay) || (() => { })

    overlay.querySelector('.more-sheet-close').addEventListener('click', closeMoreSheet)

    overlay.querySelectorAll('.more-sheet-card').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()

        if (btn.dataset.action === 'toggle-music') {
          const nowEnabled = !getMusicEnabled()
          const nextVol = nowEnabled ? (lastNonZeroVolume || MUSIC_DEFAULT_VOLUME) : 0
          setMusicVolume(nextVol)
          applyMusicVolume({ fromGesture: e.isTrusted !== false })
          // Re-render the sheet so card class + label reflect new state.
          populate()
          return
        }

        if (btn.dataset.action === 'install-app') {
          const platform = getInstallPlatform()
          if (platform === 'chrome-prompt' && deferredInstallPrompt) {
            try {
              deferredInstallPrompt.prompt()
              await deferredInstallPrompt.userChoice
            } catch { }
            deferredInstallPrompt = null
            closeMoreSheet()
            return
          }
          if (platform === 'standalone' || platform === 'unsupported') {
            return
          }
          closeMoreSheet()
          showInstallGuide(platform)
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
          // Continue card now opens the Unfinished list rather than
          // resuming the most-recent run blindly. Lets the user pick
          // the puzzle they're closest to finishing — and bait that
          // OCD itch with progress bars + goading copy.
          closeMoreSheet()
          openUnfinishedModal({
            todayDate: puzzleDate,
            onResume: async ({ mode, date }) => {
              await resumeArchiveRunFromList(mode, date)
            },
          })
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

// SVG icons for the install guide are adapted from khmyznikov/pwa-install
// (MIT, © 2023 Gleb Khmyznikov). Each icon is a self-contained <svg>.
const INSTALL_GUIDE_ICONS = {
  share: `<svg viewBox="0 0 17.7 26.5" aria-hidden="true"><g fill="currentColor"><path d="M17.334 10.762v9.746c0 2.012-1.025 3.027-3.066 3.027H3.066C1.026 23.535 0 22.52 0 20.508v-9.746C0 8.75 1.025 7.734 3.066 7.734h2.94v1.573h-2.92c-.977 0-1.514.527-1.514 1.543v9.57c0 1.015.537 1.543 1.514 1.543h11.152c.967 0 1.524-.527 1.524-1.543v-9.57c0-1.016-.557-1.543-1.524-1.543h-2.91V7.734h2.94c2.04 0 3.066 1.016 3.066 3.028Z"/><path d="M8.662 15.889c.42 0 .781-.352.781-.762V5.097l-.058-1.464.654.693 1.484 1.582a.698.698 0 0 0 .528.235c.4 0 .713-.293.713-.694 0-.205-.088-.361-.235-.508l-3.3-3.183c-.196-.196-.362-.264-.567-.264-.195 0-.361.069-.566.264L4.795 4.94a.681.681 0 0 0-.225.508c0 .4.293.694.703.694.186 0 .4-.079.538-.235l1.474-1.582.664-.693-.058 1.465v10.029c0 .41.351.762.771.762Z"/></g></svg>`,
  addHomeScreen: `<svg viewBox="0 0 25 25" aria-hidden="true"><g fill="currentColor"><path d="M23.405 1.608C22.08.283 20.214.039 17.808.039H7.156c-2.336 0-4.202.244-5.527 1.569C.305 2.95.061 4.781.061 7.117v10.583c0 2.406.227 4.254 1.552 5.579 1.342 1.325 3.19 1.569 5.596 1.569h10.6c2.406 0 4.272-.244 5.597-1.569 1.325-1.342 1.551-3.173 1.551-5.579V7.187c0-2.406-.226-4.254-1.551-5.579zm-.384 5.213v11.245c0 1.517-.209 2.946-1.028 3.783-.837.837-2.301 1.064-3.818 1.064H6.94c-1.517 0-2.964-.227-3.8-1.064-.837-.837-1.046-2.266-1.046-3.783V6.825c0-1.552.209-3.016 1.028-3.853.837-.837 2.319-1.046 3.871-1.046h11.28c1.517 0 2.981.227 3.818 1.064.819.819 1.028 2.266 1.028 3.783zM12.49 18.903c.645 0 1.029-.436 1.029-1.133v-4.341h4.533c.663 0 1.133-.366 1.133-.994 0-.645-.436-1.029-1.133-1.029h-4.533V6.872c0-.697-.384-1.133-1.029-1.133-.628 0-.994.453-.994 1.133v4.534H6.974c-.697 0-1.151.384-1.151 1.029 0 .628.488.994 1.151.994h4.522v4.341c0 .663.366 1.133.994 1.133z"/></g></svg>`,
  addToDock: `<svg viewBox="0 0 23.4 18" aria-hidden="true"><g fill="currentColor"><path d="M1.045 3.291v1.377h20.937V3.291Zm2.021 14.688h16.895c2.05 0 3.066-1.006 3.066-3.018V3.027C23.027 1.016 22.012 0 19.961 0H3.066C1.026 0 0 1.016 0 3.027v11.934c0 2.012 1.025 3.018 3.066 3.018Zm.02-1.573c-.977 0-1.514-.517-1.514-1.533V3.115c0-1.015.537-1.543 1.514-1.543H19.94c.967 0 1.514.528 1.514 1.543v11.758c0 1.016-.547 1.533-1.514 1.533Z"/><path d="M4.2 14.014c0 .508.35.85.868.85h12.92c.518 0 .87-.343.87-.85v-1.465c0-.508-.352-.85-.87-.85H5.068c-.517 0-.869.342-.869.85Z"/></g></svg>`,
  safariCompass: `<svg viewBox="0 0 20.3 19.9" aria-hidden="true"><g fill="currentColor"><path d="M9.96 19.922c5.45 0 9.962-4.522 9.962-9.961C19.922 4.51 15.4 0 9.952 0 4.511 0 0 4.512 0 9.96c0 5.44 4.521 9.962 9.96 9.962Zm0-1.66A8.26 8.26 0 0 1 1.67 9.96c0-4.61 3.672-8.3 8.281-8.3 4.61 0 8.31 3.69 8.31 8.3 0 4.61-3.69 8.3-8.3 8.3Z"/><path d="m5.87 14.883 5.605-2.735a1.47 1.47 0 0 0 .683-.673l2.725-5.596c.312-.664-.166-1.182-.85-.84L8.447 7.764c-.302.136-.508.341-.674.673L5.03 14.043c-.312.645.196 1.152.84.84Zm4.09-3.72A1.19 1.19 0 0 1 8.77 9.97c0-.664.527-1.201 1.19-1.201a1.2 1.2 0 0 1 1.202 1.2c0 .655-.537 1.192-1.201 1.192Z"/></g></svg>`,
  // Material vertical-3-dots — Android / desktop browser menu.
  menuDots: `<svg viewBox="0 -960 960 960" aria-hidden="true"><path fill="currentColor" d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z"/></svg>`,
  // Material phone-with-plus — Android "Add to Home screen".
  phonePlus: `<svg viewBox="0 -960 960 960" aria-hidden="true"><path fill="currentColor" d="M320-40q-33 0-56.5-23.5T240-120v-160h80v40h400v-480H320v40h-80v-160q0-33 23.5-56.5T320-920h400q33 0 56.5 23.5T800-840v720q0 33-23.5 56.5T720-40H320Zm0-120v40h400v-40H320ZM176-280l-56-56 224-224H200v-80h280v280h-80v-144L176-280Z"/></svg>`,
}

function getInstallGuideContent(platform) {
  const safariOnlyNote = 'Make sure you\'re in Safari, not Chrome or Firefox.'
  switch (platform) {
    case 'ios-safari':
      return {
        label: 'Install on iPhone',
        body: 'Add Xefig to your Home Screen for a full-screen, app-like experience.',
        steps: [
          { icon: INSTALL_GUIDE_ICONS.share, label: 'Tap <strong>Share</strong> in Safari\'s toolbar.' },
          { icon: INSTALL_GUIDE_ICONS.addHomeScreen, label: 'Choose <strong>Add to Home Screen</strong>.' },
        ],
      }
    case 'ipad-safari':
      return {
        label: 'Install on iPad',
        body: 'Add Xefig to your Home Screen for a full-screen, app-like experience.',
        steps: [
          { icon: INSTALL_GUIDE_ICONS.share, label: 'Tap <strong>Share</strong> in Safari\'s toolbar.' },
          { icon: INSTALL_GUIDE_ICONS.addHomeScreen, label: 'Choose <strong>Add to Home Screen</strong>.' },
        ],
      }
    case 'ios-other-browser':
      return {
        label: 'Open in Safari first',
        body: 'On iOS, only Safari can install web apps. Open xefig.com in Safari, then add it to your Home Screen.',
        steps: [
          { icon: INSTALL_GUIDE_ICONS.safariCompass, label: 'Open <strong>xefig.com</strong> in Safari.' },
          { icon: INSTALL_GUIDE_ICONS.share, label: 'Tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.' },
        ],
      }
    case 'macos-safari':
      return {
        label: 'Install on macOS',
        body: 'Add Xefig to your Dock for one-click access.',
        steps: [
          { icon: INSTALL_GUIDE_ICONS.share, label: 'Open Safari\'s <strong>Share</strong> menu.' },
          { icon: INSTALL_GUIDE_ICONS.addToDock, label: 'Choose <strong>Add to Dock</strong>.' },
        ],
        note: safariOnlyNote,
      }
    case 'android-fallback':
      return {
        label: 'Install on Android',
        body: 'Add Xefig to your home screen via your browser\'s menu.',
        steps: [
          { icon: INSTALL_GUIDE_ICONS.menuDots, label: 'Open the browser menu (the <strong>⋮</strong> button).' },
          { icon: INSTALL_GUIDE_ICONS.phonePlus, label: 'Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.' },
        ],
      }
    case 'chrome-no-prompt':
      return {
        label: 'Install on desktop',
        body: 'Look for the install icon at the right edge of your address bar. If it\'s not there, open the browser menu (⋮) and choose <strong>Install Xefig</strong>.',
        steps: [],
      }
    default:
      return null
  }
}

function showInstallGuide(platform) {
  const content = getInstallGuideContent(platform)
  if (!content) return

  const existing = document.querySelector('.install-guide-overlay')
  if (existing) existing.remove()

  const overlay = document.createElement('div')
  overlay.className = 'install-guide-overlay'

  const stepsHtml = content.steps && content.steps.length
    ? `<ul class="install-guide-steps">${content.steps.map((step) => `
        <li class="install-guide-step">
          <span class="install-guide-step-icon">${step.icon}</span>
          <span class="install-guide-step-label">${step.label}</span>
        </li>`).join('')}</ul>`
    : ''
  const noteHtml = content.note
    ? `<p class="install-guide-note">${content.note}</p>`
    : ''

  overlay.innerHTML = `
    <div class="install-guide" role="dialog" aria-modal="true" aria-label="${content.label}">
      <button type="button" class="install-guide-close" aria-label="Close">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 2 L14 14 M14 2 L2 14"/></svg>
      </button>
      <div class="install-guide-brand">
        <img class="install-guide-brand-icon" src="/favicon.svg" alt="" aria-hidden="true" />
        <div class="install-guide-brand-meta">
          <span class="install-guide-brand-name">Xefig</span>
          <span class="install-guide-brand-domain">xefig.com</span>
        </div>
      </div>
      <p class="install-guide-section-label">${content.label}</p>
      <p class="install-guide-body">${content.body}</p>
      ${stepsHtml}
      ${noteHtml}
      <button type="button" class="install-guide-done">Got it</button>
    </div>
  `

  const close = () => {
    overlay.classList.remove('is-visible')
    document.removeEventListener('keydown', onKey)
    setTimeout(() => overlay.remove(), 200)
  }
  const onKey = (e) => { if (e.key === 'Escape') close() }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  overlay.querySelector('.install-guide-close').addEventListener('click', close)
  overlay.querySelector('.install-guide-done').addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  document.body.appendChild(overlay)
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
      <div class="completed-screen-actions">
        ${gameMode === GAME_MODE_DIAMOND
      ? `<button id="completed-show-source-btn" class="completed-screen-show-source" type="button" aria-pressed="false" aria-label="Show source image">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>
              <span>Show source</span>
            </button>`
      : ''}
        <button id="replay-btn" class="completed-screen-replay" type="button">Play Again</button>
      </div>
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
        onProgress: () => { },
        onComplete: () => { },
      })
      previewPuzzle = preview
      preview.init().then(() => {
        if (previewPuzzle !== preview) return
        forceCompletePuzzlePreview(gameMode, preview)
        // Wire the source-image toggle for diamond — the preview is the
        // painted output, the toggle overlays the source for comparison.
        if (gameMode === GAME_MODE_DIAMOND) {
          const sourceBtn = gameEl.querySelector('#completed-show-source-btn')
          if (sourceBtn) {
            sourceBtn.addEventListener('click', () => {
              if (!previewPuzzle || typeof previewPuzzle.toggleReferenceVisible !== 'function') return
              const active = previewPuzzle.toggleReferenceVisible()
              sourceBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
            })
          }
        }
      }).catch(() => {
        // Non-fatal — preview just won't render; topbar/pill/sheet still work.
      })
    }).catch(() => { })
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

function createPuzzleLoadingOverlay({ thumbnailUrl } = {}) {
  const overlay = document.createElement('div')
  overlay.className = 'puzzle-loading-overlay'
  overlay.setAttribute('role', 'status')
  overlay.setAttribute('aria-live', 'polite')
  overlay.innerHTML = `
    <div class="puzzle-loading-thumb" aria-hidden="true"></div>
    <div class="puzzle-loading-spinner" aria-hidden="true"></div>
    <div class="puzzle-loading-label">Loading puzzle…</div>
    <div class="puzzle-loading-meter" aria-hidden="true">
      <div class="puzzle-loading-meter-fill"></div>
    </div>
    <div class="puzzle-loading-detail"></div>
    <div class="puzzle-loading-hint">If this takes too long, your connection looks weak.</div>
  `
  if (thumbnailUrl) {
    overlay.classList.add('has-thumb')
    // Inline style avoids CSS-injection edge cases with arbitrary URLs;
    // JSON.stringify produces "…" which url() accepts and which escapes
    // any embedded quotes / backslashes correctly.
    const thumb = overlay.querySelector('.puzzle-loading-thumb')
    thumb.style.backgroundImage = `url(${JSON.stringify(thumbnailUrl)})`
  }
  return overlay
}

function resolvePuzzleThumbnailFromState(puzzlePayload, gameMode) {
  if (!puzzlePayload?.categories) return null
  const categoryKey = GAME_MODE_TO_PUZZLE_CATEGORY[normalizeGameMode(gameMode)] || 'jigsaw'
  const raw = puzzlePayload.categories[categoryKey]?.thumbnailUrl
    || puzzlePayload.categories.jigsaw?.thumbnailUrl
  return raw ? resolveAssetUrl(raw) : null
}

function updatePuzzleLoadingOverlay(overlay, progress) {
  if (!overlay || !progress) return
  const fill = overlay.querySelector('.puzzle-loading-meter-fill')
  const detail = overlay.querySelector('.puzzle-loading-detail')
  const label = overlay.querySelector('.puzzle-loading-label')
  if (progress.phase === 'fallback') {
    if (label) label.textContent = 'Retrying…'
    return
  }
  if (progress.phase === 'cached') {
    if (label) label.textContent = 'Loading from cache…'
    if (fill) fill.style.width = '100%'
    return
  }
  if (progress.phase === 'decoding') {
    if (label) label.textContent = 'Almost there…'
    if (fill) fill.style.width = '100%'
    return
  }
  if (progress.phase === 'downloading') {
    const { loaded = 0, total = 0 } = progress
    if (label) label.textContent = 'Downloading puzzle…'
    if (total > 0) {
      const pct = Math.max(0, Math.min(100, (loaded / total) * 100))
      if (fill) {
        fill.classList.remove('is-indeterminate')
        fill.style.width = `${pct}%`
      }
      if (detail) detail.textContent = `${formatBytesShort(loaded)} of ${formatBytesShort(total)}`
    } else {
      if (fill) fill.classList.add('is-indeterminate')
      if (detail) detail.textContent = loaded > 0 ? formatBytesShort(loaded) : ''
    }
  }
}

function formatBytesShort(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function renderPuzzleLoadError(overlay, { onRetry }) {
  if (!overlay) return
  overlay.classList.add('is-error')
  overlay.innerHTML = `
    <div class="puzzle-error-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 0 1 15.5-6.3M21 12a9 9 0 0 1-15.5 6.3"/>
        <path d="M21 5v4h-4M3 19v-4h4"/>
      </svg>
    </div>
    <div class="puzzle-error-title">Couldn't load this puzzle</div>
    <div class="puzzle-error-detail">Your connection looks weak. Try again when you're somewhere with better signal.</div>
    <button type="button" class="puzzle-error-retry">Retry</button>
  `
  const btn = overlay.querySelector('.puzzle-error-retry')
  if (btn && typeof onRetry === 'function') {
    btn.addEventListener('click', onRetry, { once: true })
  }
}

function renderGame({ resumeRun = null, testMode = false } = {}) {
  const gameMode = normalizeGameMode(resumeRun?.gameMode || state.gameMode)
  state.gameMode = gameMode

  // Test mode overrides image source and date with the bundled hero so
  // the run doesn't depend on the live puzzle pipeline. Persistence
  // routes through the test-mode-only active-run slot (see
  // persistActiveRun) so back-and-return preserves canvas + sessionLog,
  // but production data stays untouched.
  if (testMode) {
    state.imageUrl = sampleImage
    if (resumeRun) {
      state.puzzle = { date: resumeRun.puzzleDate }
    } else {
      const testDate = `test-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
      state.puzzle = { date: testDate }
    }
  }

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
  const useImmersiveMenuChrome = useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome || useImmersiveSwapChrome || useImmersiveDiamondChrome
  const useImmersiveChrome = useImmersiveMenuChrome
  // Diamond hides the view button until completion: the puzzle's intent
  // is to discover what the painting becomes, so peeking mid-paint would
  // spoil it. After completion, the painted output can be ambiguous
  // (small subjects collapse to a few pixels at 24 colours), so the
  // toggle becomes useful for verifying the source.
  const viewButtonHiddenAttr = gameMode === GAME_MODE_DIAMOND ? ' hidden' : ''
  const viewButtonMarkup = `<button id="view-btn" class="gt-menu-item" type="button" aria-pressed="false"${viewButtonHiddenAttr}>
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>
      ${gameMode === GAME_MODE_DIAMOND ? 'Show source image' : 'Reference image'}
    </button>`
  // Diamond also exposes a persistent floating source-image toggle on
  // the page itself (in addition to the menu entry above) so the option
  // is discoverable both on first completion and when reopening a
  // previously-completed painting. Hidden during play, revealed on
  // completion / resume-completed.
  const showSourceFloatingBtnMarkup = useImmersiveDiamondChrome
    ? `<button id="show-source-floating-btn" class="diamond-floating-btn diamond-floating-btn--source" type="button" aria-label="Show source image" aria-pressed="false" hidden>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.5 12s3.8-6 10.5-6 10.5 6 10.5 6-3.8 6-10.5 6S1.5 12 1.5 12Zm10.5 3.8a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Z"/></svg>
      </button>`
    : ''
  const muteSfxInitiallyMuted = useImmersiveDiamondChrome ? getDiamondSfxMuted() : false
  const muteSfxButtonMarkup = useImmersiveDiamondChrome
    ? `<button id="mute-sfx-btn" class="gt-menu-item gt-menu-item--mute-toggle" type="button" aria-pressed="${muteSfxInitiallyMuted ? 'true' : 'false'}">
        <svg class="mute-icon-sound" viewBox="0 0 512 512" aria-hidden="true">
          <g transform="translate(42.666667, 85.333333)" fill="currentColor">
            <path fill-rule="evenodd" d="M191.75,0 L80.9,87.23 L0,87.23 L0,257.9 L81.02,257.9 L191.75,343.35 L191.75,0 Z M42.67,129.9 L95.69,129.9 L149.08,87.87 L149.08,256.52 L95.56,215.23 L42.67,215.23 L42.67,129.9 Z"/>
            <g fill="none" stroke="currentColor" stroke-width="42.67" stroke-linecap="butt">
              <path d="M260.25,83.1 C306.25,133.5 306.25,210.38 260.25,260.77"/>
              <path d="M344.66,15.58 C425.06,104.48 425.06,239.41 344.66,328.3"/>
            </g>
          </g>
        </svg>
        <svg class="mute-icon-muted" viewBox="0 0 512 512" aria-hidden="true">
          <g transform="translate(42.666667, 85.333333)" fill="currentColor">
            <path fill-rule="evenodd" d="M191.75,0 L80.9,87.23 L0,87.23 L0,257.9 L81.02,257.9 L191.75,343.35 L191.75,0 Z M42.67,129.9 L95.69,129.9 L149.08,87.87 L149.08,256.52 L95.56,215.23 L42.67,215.23 L42.67,129.9 Z"/>
            <g fill="none" stroke="currentColor" stroke-width="42.67" stroke-linecap="butt">
              <line x1="255.88" y1="97.27" x2="405.21" y2="246.61"/>
              <line x1="405.21" y1="97.27" x2="255.88" y2="246.61"/>
            </g>
          </g>
        </svg>
        <span class="mute-label-sound">Sound effects: On</span>
        <span class="mute-label-muted">Sound effects: Off</span>
      </button>`
    : ''
  const restartButtonLabel = gameMode === GAME_MODE_DIAMOND ? 'Restart painting' : 'Restart'
  const restartButtonMarkup = `<button id="restart-btn" class="gt-menu-item gt-menu-item--danger" type="button">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24L14 10h7V3l-3.35 3.35Z"/></svg>
      ${restartButtonLabel}
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
              ${muteSfxButtonMarkup}
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
              <span class="gt-sync-disk" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.5A4.5 4.5 0 0 0 6.5 19Z"/>
                  <path d="M12 17 V11 M9 14 L12 11 L15 14"/>
                </svg>
              </span>
              <button id="menu-btn" class="gt-icon-btn gt-icon-btn--floating${useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome ? ' gt-icon-btn--assistant' : ''}" type="button" aria-label="${useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome ? 'Helper menu' : 'Puzzle menu'}" aria-expanded="false" title="${useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome ? 'Helper menu' : 'Puzzle menu'}">
                ${useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome ? `
                <svg class="assistant-logo" viewBox="0 0 200 200" aria-hidden="true">
                  <g transform="translate(100 100) rotate(-20)">
                    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#e070a0"/>
                    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#40d0f0" transform="rotate(72)"/>
                    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#a060f0" transform="rotate(144)"/>
                    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#f0c040" transform="rotate(216)"/>
                    <path d="M 28.69 -74.68 A 80 80 0 0 0 -28.69 -74.68 A 12 12 0 0 0 -34.10 -56.42 L -25.50 -44.59 A 12 12 0 0 0 -12.28 -40.16 A 42 42 0 0 1 12.28 -40.16 A 12 12 0 0 0 25.50 -44.59 L 34.10 -56.42 A 12 12 0 0 0 28.69 -74.68 Z" fill="#50d070" transform="rotate(288)"/>
                  </g>
                </svg>
                ` : `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`}
              </button>
              <div id="gt-menu" class="gt-menu gt-menu--floating" hidden>
                ${useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome ? `
                <button id="how-to-play-btn" class="gt-menu-item" type="button">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm.6 15h-1.3v-1.3h1.3Zm1.7-5.4-.6.6c-.5.5-.7.9-.7 1.8h-1.3v-.3c0-.7.3-1.3.8-1.8l.8-.8a1.5 1.5 0 1 0-2.6-1H8.7a3 3 0 1 1 5.6 1.5Z"/></svg>
                  How to play
                </button>
                <button id="hint-btn" class="gt-menu-item" type="button">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 21h6v-1H9Zm3-19a7 7 0 0 0-4 12.7c.6.4.9 1 .9 1.7v1.1c0 .3.2.5.5.5h5.2c.3 0 .5-.2.5-.5v-1.1c0-.7.3-1.3.9-1.7A7 7 0 0 0 12 2Z"/></svg>
                  I need a hint!
                </button>
                ${useImmersiveJigsawChrome || useImmersivePolygramChrome ? `
                <div class="gt-menu-divider" aria-hidden="true"></div>
                <button id="highlight-btn" class="gt-menu-item" type="button">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2l1.6 4.6L15 8l-4.4 1.4L9 14l-1.6-4.6L3 8l4.4-1.4Zm8 4l1 2.8 2.8 1-2.8 1L17 14l-1-2.8L13.2 10l2.8-1Zm-4 10l.8 2.2L16 19.2l-2.2.8L13 22l-.8-2-2.2-1 2.2-.8Z"/></svg>
                  Highlight loose
                </button>
                ${useImmersiveJigsawChrome ? `
                <button id="edges-btn" class="gt-menu-item" type="button" aria-pressed="false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 3 L18 3 L18 7.2 C18 8.3, 21.5 8.1, 21.5 10.5 C21.5 12.9, 18 12.7, 18 13.8 L18 18 L13.8 18 C12.7 18, 12.9 21.5, 10.5 21.5 C8.1 21.5, 8.3 18, 7.2 18 L3 18 Z"/></svg>
                  Edges only
                </button>
                ` : ''}
                ` : ''}
                ` : ''}
                ${viewButtonMarkup}
                ${muteSfxButtonMarkup}
                ${restartButtonMarkup}
              </div>
            </div>
            ${showSourceFloatingBtnMarkup}
          </div>
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
  const showSourceFloatingBtn = gameEl.querySelector('#show-source-floating-btn')
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
    if (isSyncEnabled()) forcePush().catch(() => { })
    returnFromGame()
  })

  // Keep the menu's view-btn and the floating source-btn (diamond
  // only) in sync — both toggle the same reference image, so they
  // mirror each other's aria-pressed state regardless of which one
  // the user clicked.
  const syncSourceButtons = (active) => {
    const pressed = active ? 'true' : 'false'
    if (viewBtn) viewBtn.setAttribute('aria-pressed', pressed)
    if (showSourceFloatingBtn) showSourceFloatingBtn.setAttribute('aria-pressed', pressed)
    // Jigsaw and polygram both expose the reveal as a tray-side eye
    // button; mirror state across whichever is mounted.
    const jigsawRevealBtn = gameEl.querySelector('#jigsaw-reveal-btn')
    if (jigsawRevealBtn) jigsawRevealBtn.setAttribute('aria-pressed', pressed)
    const polygramRevealBtn = gameEl.querySelector('#polygram-reveal-btn')
    if (polygramRevealBtn) polygramRevealBtn.setAttribute('aria-pressed', pressed)
  }

  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      if (!puzzle) return
      const active = puzzle.toggleReferenceVisible()
      syncSourceButtons(active)
    })
  }

  // Jigsaw and polygram both dispatch this when their in-tray eye
  // button toggles the reference. Mirror the state across every
  // reference-control surface (menu view-btn, the other tray eye if
  // mounted, diamond floating button) so any one of them reflects the
  // live truth.
  gameEl.addEventListener('jigsaw:reference-toggled', (event) => {
    syncSourceButtons(Boolean(event.detail?.active))
  })
  gameEl.addEventListener('polygram:reference-toggled', (event) => {
    syncSourceButtons(Boolean(event.detail?.active))
  })

  if (showSourceFloatingBtn) {
    showSourceFloatingBtn.addEventListener('click', () => {
      if (!puzzle) return
      const active = puzzle.toggleReferenceVisible()
      syncSourceButtons(active)
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
  if (menuBtn) menuBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    // Tapping the assistant button settles its bouncing/nudge bubble so the
    // menu doesn't open with the bubble still floating over the workspace.
    if (activeAssistant) activeAssistant.dismissNudge()
    toggleMenu()
  })
  const closeMenu = () => toggleMenu(false)
  document.addEventListener('click', closeMenu)
  if (menuPanel) menuPanel.addEventListener('click', closeMenu)

  // ─── In-game helper (jigsaw + polygram; expanding to every mode) ───
  // Loaded lazily so the homepage bundle isn't dragged into the puzzle path.
  const howToPlayBtn = gameEl.querySelector('#how-to-play-btn')
  const hintBtn = gameEl.querySelector('#hint-btn')
  const useAssistant = (useImmersiveJigsawChrome || useImmersivePolygramChrome || useImmersiveSlidingChrome) && menuBtn && menuPanel && workspaceEl
  let assistantPuzzleReady = false
  let assistantNudgeFn = null
  const tryAssistantNudge = () => {
    if (assistantPuzzleReady && assistantNudgeFn) assistantNudgeFn()
  }
  if (useAssistant) {
    loadAssistant().then(({ GameAssistant, shouldNudge, recordPlayed }) => {
      // renderGame may have torn down by the time the dynamic import resolves;
      // bail if our DOM no longer represents the current view.
      if (!menuBtn.isConnected) return
      activeAssistant = new GameAssistant({
        button: menuBtn,
        menu: menuPanel,
        workspace: workspaceEl,
        mode: gameMode,
      })

      // Find a piece currently visible in the tray viewport and compute
      // where it goes on the board. Shared by both flows so the tutorial's
      // drag demo and the hint pick the same kind of target.
      const pickDemoPieceAndTarget = () => {
        if (!puzzle || !puzzle.pieces) return { carouselItem: null, targetRect: null }
        const carouselEl = puzzle.carousel || document.querySelector('.jigsaw-carousel')
        const carouselRect = carouselEl?.getBoundingClientRect?.() || null
        // Tray scrolls horizontally in portrait, vertically in landscape
        // (sidebar). Check whichever axis is the scroll axis — otherwise
        // landscape passes every piece (all horizontally centred in the
        // column) and we pick a piece scrolled out of view at the top.
        const usesSidebar = typeof puzzle.usesSidebarTray === 'function'
          ? puzzle.usesSidebarTray()
          : window.innerWidth > window.innerHeight
        const isVisibleInTray = (piece) => {
          if (!piece.inCarousel || piece.locked) return false
          if (!piece.carouselItem || !carouselRect) return false
          const r = piece.carouselItem.getBoundingClientRect()
          if (usesSidebar) {
            const cy = r.top + r.height / 2
            return cy >= carouselRect.top + 8 && cy <= carouselRect.bottom - 8
          }
          const cx = r.left + r.width / 2
          return cx >= carouselRect.left + 8 && cx <= carouselRect.right - 8
        }
        const candidate = puzzle.pieces.find(isVisibleInTray)
          || puzzle.pieces.find((p) => p.inCarousel && !p.locked)
          || null
        if (!candidate) return { carouselItem: null, targetRect: null }
        const carouselItem = candidate.carouselItem || null
        // stageContent's bounding rect already accounts for the puzzle's
        // live transform (translate(panX, panY) scale(zoom)) — using it
        // dodges the old bug where we computed scale ourselves and ended
        // up off the right edge, where the clamp parked the bouncer.
        const stageContent = puzzle.stageContent || document.querySelector('.jigsaw-stage-content')
        const targetRect = stageContent && puzzle.boardWidth && puzzle.boardHeight ? (() => {
          const scRect = stageContent.getBoundingClientRect()
          const piecePx = puzzle.pieceWidth || 0
          const piecePxY = puzzle.pieceHeight || piecePx
          const localX = candidate.targetX + (puzzle.bleed || 0) + piecePx / 2
          const localY = candidate.targetY + (puzzle.bleed || 0) + piecePxY / 2
          const cx = scRect.left + (localX / puzzle.boardWidth) * scRect.width
          const cy = scRect.top + (localY / puzzle.boardHeight) * scRect.height
          return { left: cx - 12, top: cy - 12, width: 24, height: 24 }
        })() : null
        return { carouselItem, targetRect }
      }

      // Animate the carousel's scroll back-and-forth so the player sees
      // that swiping/scrolling the tray is a thing — the gesture isn't
      // obvious from a static row of pieces. Returns a cleanup that aborts
      // mid-animation if the tutorial step ends early.
      const demoTrayScroll = () => {
        const carousel = puzzle?.carousel || document.querySelector('.jigsaw-carousel')
        if (!carousel) return undefined
        // Axis from orientation, not scrollWidth/Height: in landscape the
        // tray sets overflow-x: hidden but browsers can still report
        // scrollWidth > clientWidth, which misdirected the demo to drive
        // scrollLeft (a no-op there) instead of scrollTop.
        const usesSidebar = typeof puzzle.usesSidebarTray === 'function'
          ? puzzle.usesSidebarTray()
          : window.innerWidth > window.innerHeight
        const prop = usesSidebar ? 'scrollTop' : 'scrollLeft'
        const range = usesSidebar
          ? (carousel.scrollHeight - carousel.clientHeight)
          : (carousel.scrollWidth - carousel.clientWidth)
        if (range <= 4) return undefined
        const origin = carousel[prop]
        // Visible swing without dumping every piece off-screen.
        const amplitude = Math.min(range * 0.55, 220)
        // If we're already at one edge, only swing toward the room we have.
        const forward = Math.min(origin + amplitude, range)
        const backward = Math.max(origin - amplitude, 0)
        let aborted = false
        let rafId = 0
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((1 - t) * (1 - t) * 2))
        const tween = (from, to, ms) => new Promise((resolve) => {
          const start = performance.now()
          const tick = (now) => {
            if (aborted) return resolve()
            const k = Math.min(1, (now - start) / ms)
            carousel[prop] = from + (to - from) * ease(k)
            if (k < 1) rafId = requestAnimationFrame(tick)
            else resolve()
          }
          rafId = requestAnimationFrame(tick)
        })
        ;(async () => {
          // Small delay so the bubble appears first, then the demo plays.
          await new Promise((r) => { rafId = requestAnimationFrame(() => setTimeout(r, 250)) })
          // Two full back-and-forth cycles — one pass is over too fast
          // for the player to register that the tray is scrollable.
          for (let cycle = 0; cycle < 2 && !aborted; cycle++) {
            await tween(carousel[prop], forward, 700)
            if (aborted) return
            await tween(carousel[prop], backward, 900)
            if (aborted) return
            await tween(carousel[prop], origin, 600)
          }
        })()
        return () => {
          aborted = true
          cancelAnimationFrame(rafId)
        }
      }

      const buildJigsawTutorialSteps = () => {
        // Targets resolved at run-time because they're inside the puzzle's
        // root (which init() rebuilds). The trailing drag demo uses a
        // live piece + computed slot so the player sees the verb, not
        // just the controls.
        const { carouselItem, targetRect } = pickDemoPieceAndTarget()
        // Direct element refs (not nth-child selectors): the edges filter
        // auto-hides once every edge piece is placed (checkEdgesComplete
        // in jigsaw-puzzle.js sets display:none), and a hidden element
        // still matches nth-child but returns a 0×0 bounding rect —
        // parking the bouncer in the top-left corner.
        const edgesBtn = puzzle?.edgesTrayBtn
        const highlightBtn = puzzle?.highlightTrayBtn
        const revealBtn = puzzle?.revealTrayBtn
        const isShown = (el) => el && el.offsetParent !== null
        const steps = [
          { target: null, message: "Welcome! Let's run through how Jigsaw works." },
          {
            target: '.jigsaw-carousel',
            message: 'These are your pieces. Scroll the tray to see more, then drag one onto the board.',
            onShow: demoTrayScroll,
          },
        ]
        if (isShown(revealBtn)) {
          steps.push({ target: revealBtn, message: 'Tap the eye anytime to peek at the finished picture.' })
        }
        if (isShown(edgesBtn)) {
          steps.push({ target: edgesBtn, message: 'Filter the tray to just the edge pieces — most people start with the frame.' })
        }
        if (isShown(highlightBtn)) {
          steps.push({ target: highlightBtn, message: 'Lost a piece on the board? Tap the sparkle to flash all loose pieces.' })
        }
        if (carouselItem && targetRect) {
          // Auto-advance when the player presses on the carousel piece —
          // the natural next gesture after the helper highlights it.
          steps.push({
            target: carouselItem,
            message: 'Press and hold this piece to pick it up.',
            advanceOn: [{ element: carouselItem, event: 'pointerdown' }],
          })
          // Then auto-advance again when they release (drop) the piece —
          // wherever it lands. Document-level pointerup catches the
          // gesture even if the piece itself has been re-parented onto
          // the board by the time release fires.
          steps.push({
            target: targetRect,
            message: 'Drag it to about here on the board — pieces snap when they get close.',
            // Wait for the actual snap (jigsaw:piece-snapped), not just any
            // pointerup: dropping the piece in the wrong spot used to
            // advance the tutorial to "That's it" even though nothing
            // locked. noManualAdvance blocks tap-to-skip past for the
            // same reason.
            advanceOn: [{ element: document, event: 'jigsaw:piece-snapped' }],
            noManualAdvance: true,
          })
        }
        steps.push({ target: null, message: "That's it. Have fun!" })
        return steps
      }

      const buildJigsawHintSteps = () => {
        const { carouselItem, targetRect } = pickDemoPieceAndTarget()
        if (!carouselItem) {
          return [{ target: null, message: 'All pieces are out of the tray — keep nudging them into place!' }]
        }
        const steps = [{
          target: carouselItem,
          message: 'Press and hold this piece to pick it up.',
          advanceOn: [{ element: carouselItem, event: 'pointerdown' }],
        }]
        if (targetRect) {
          steps.push({
            target: targetRect,
            message: 'It goes about here on the board.',
            advanceOn: [{ element: document, event: 'jigsaw:piece-snapped' }],
            noManualAdvance: true,
          })
        }
        return steps
      }

      // Polygram has the same helper button shape as jigsaw but a
      // different verb set: pick a shard from the tray, rotate it to
      // align with its target outline, then drop it on the board. The
      // hint surfaces the next unplaced shard + the rough drop area so
      // the player knows where to focus instead of scanning the whole
      // tray.
      const pickPolygramHintTarget = () => {
        if (!puzzle || !Array.isArray(puzzle.pieces)) return { trayEl: null, dropRect: null }
        // Skip locked + currently-held; prefer "still in tray" over
        // "already on the board but not snapped" so the hint points at
        // a clear next step rather than a half-fixed mistake.
        const trayPiece = puzzle.pieces.find((p) => p && p.state === 'tray')
          || puzzle.pieces.find((p) => p && p.state === 'placed')
          || null
        if (!trayPiece) return { trayEl: null, dropRect: null }
        const trayEl = trayPiece.element || null
        // Drop target = the shard's blueprint bbox centre, projected
        // through the live board rect. bbox.x/y/w/h are 0..1 fractions
        // of the board (see polygram-puzzle.js placePieceOnBoard), not
        // pixels, so they multiply by the board's current bounding
        // rect to land at the right screen coords.
        const board = puzzle.boardContent || document.querySelector('.polygram-board-content')
        let dropRect = null
        const bbox = trayPiece.blueprint && trayPiece.blueprint.bbox
        if (board && bbox && Number.isFinite(bbox.x) && Number.isFinite(bbox.y)) {
          const rect = board.getBoundingClientRect()
          const cxFrac = bbox.x + (bbox.w || 0) / 2
          const cyFrac = bbox.y + (bbox.h || 0) / 2
          const px = rect.left + cxFrac * rect.width
          const py = rect.top + cyFrac * rect.height
          dropRect = { left: px - 14, top: py - 14, width: 28, height: 28 }
        }
        return { trayEl, dropRect }
      }

      // Tray scroll demo, polygram flavour. Polygram's tray scrolls on
      // a different axis per orientation: portrait = horizontal strip
      // at top, landscape = vertical column on the right. Pick the
      // axis from window orientation (not from auto-detection on the
      // element — `.polygram-tray` has `overflow: hidden` which still
      // reports a scrollWidth > clientWidth, so axis detection there
      // would falsely flag horizontal scroll in landscape).
      const demoPolygramTrayScroll = () => {
        const scroller = puzzle?.trayGrid
          || document.querySelector('.polygram-tray-grid')
        if (!scroller) return undefined
        const isLandscape = window.matchMedia('(orientation: landscape)').matches
        const prop = isLandscape ? 'scrollTop' : 'scrollLeft'
        const range = isLandscape
          ? (scroller.scrollHeight - scroller.clientHeight)
          : (scroller.scrollWidth - scroller.clientWidth)
        if (range <= 4) return undefined
        const origin = scroller[prop]
        const amplitude = Math.min(range * 0.55, 220)
        const forward = Math.min(origin + amplitude, range)
        const backward = Math.max(origin - amplitude, 0)
        let aborted = false
        let rafId = 0
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((1 - t) * (1 - t) * 2))
        const tween = (from, to, ms) => new Promise((resolve) => {
          const start = performance.now()
          const tick = (now) => {
            if (aborted) return resolve()
            const k = Math.min(1, (now - start) / ms)
            scroller[prop] = from + (to - from) * ease(k)
            if (k < 1) rafId = requestAnimationFrame(tick)
            else resolve()
          }
          rafId = requestAnimationFrame(tick)
        })
        ;(async () => {
          await new Promise((r) => { rafId = requestAnimationFrame(() => setTimeout(r, 250)) })
          // Two cycles — matches the jigsaw demo cadence so the player
          // has time to register that the tray is scrollable.
          for (let cycle = 0; cycle < 2 && !aborted; cycle++) {
            await tween(scroller[prop], forward, 700)
            if (aborted) return
            await tween(scroller[prop], backward, 900)
            if (aborted) return
            await tween(scroller[prop], origin, 600)
          }
        })()
        return () => {
          aborted = true
          cancelAnimationFrame(rafId)
        }
      }

      const buildPolygramTutorialSteps = () => {
        const { trayEl, dropRect } = pickPolygramHintTarget()
        // Tutorial steps that point at the tray-tool buttons fade out
        // the surrounding pieces so the button is unambiguously the
        // focal point — same idea as the slider's marker-focus dim.
        const dimAround = (assistant) => {
          assistant.workspace.classList.add('workspace--tutorial-dim-pieces')
          return () => assistant.workspace.classList.remove('workspace--tutorial-dim-pieces')
        }
        const steps = [
          { target: null, message: "Welcome! Polygram is rotate-and-place." },
          {
            target: '.polygram-tray',
            message: 'These are the shards. Scroll the tray to see more.',
            onShow: demoPolygramTrayScroll,
          },
        ]
        // Tray buttons walk-through — placed right after the scroll
        // demo so the player knows the helper affordances before they
        // start picking up shards.
        const revealBtn = puzzle?.revealTrayBtn
        if (revealBtn) {
          steps.push({
            target: revealBtn,
            message: 'Tap the eye anytime to peek at the finished picture.',
            onShow: dimAround,
          })
        }
        const highlightBtn = puzzle?.highlightTrayBtn
        if (highlightBtn) {
          steps.push({
            target: highlightBtn,
            message: 'Lost a shard somewhere on the board? Tap the sparkle to flash every loose piece.',
            onShow: dimAround,
          })
        }
        if (trayEl) {
          steps.push({
            target: trayEl,
            message: 'Tap this shard to pick it up.',
            advanceOn: [{ element: trayEl, event: 'pointerdown' }],
          })
          if (dropRect) {
            // First drop is deliberately off-target so the shard lands
            // in the "placed but not snapped" state — that's what
            // surfaces the rotation ring, which the next step explains.
            // Push the off-target a meaningful distance so the two
            // drops read as clearly distinct events; small offsets put
            // the practice drop on top of the real target and the
            // tutorial loses its "move it again" payoff.
            const boardEl = puzzle?.board || document.querySelector('.polygram-board')
            const boardRect = boardEl ? boardEl.getBoundingClientRect() : null
            const offsetX = boardRect ? Math.min(boardRect.width * 0.38, 240) : 180
            const offsetY = boardRect ? Math.min(boardRect.height * 0.38, 240) : 180
            // Direction: bias toward the board centre so we don't
            // overshoot the edge.
            const boardCx = boardRect ? boardRect.left + boardRect.width / 2 : window.innerWidth / 2
            const boardCy = boardRect ? boardRect.top + boardRect.height / 2 : window.innerHeight / 2
            const dropCx = dropRect.left + dropRect.width / 2
            const dropCy = dropRect.top + dropRect.height / 2
            const sgnX = dropCx < boardCx ? 1 : -1
            const sgnY = dropCy < boardCy ? 1 : -1
            let offLeft = dropRect.left + sgnX * offsetX
            let offTop = dropRect.top + sgnY * offsetY
            // Hard clamp to the board's safe area so we don't park the
            // bouncer (and ask the player to drop) outside the canvas.
            if (boardRect) {
              const pad = 40
              offLeft = Math.max(boardRect.left + pad, Math.min(boardRect.right - pad, offLeft))
              offTop = Math.max(boardRect.top + pad, Math.min(boardRect.bottom - pad, offTop))
            }
            const offRect = { left: offLeft, top: offTop, width: 28, height: 28 }
            steps.push({
              target: offRect,
              message: 'Drop it about here — NOT on the outline. We\'ll rotate it next.',
              advanceOn: [{ element: document, event: 'pointerup' }],
            })
          }
        }
        // After the off-target drop, the rotation ring auto-appears
        // around the placed shard. ONE combined step explains both
        // verbs (rotate + dismiss) and auto-advances the moment the
        // ring goes away. Splitting these into two steps meant the
        // player often dismissed the ring while still on the "drag
        // the ring" step (no advance criteria) and nothing happened.
        steps.push({
          target: '.polygram-board',
          message: 'A ring appeared — that\'s rotate mode. Drag the ring to spin the shard, then tap anywhere off the ring to switch back to drag mode.',
          // Block tap-to-advance on the bubble: the next step asks the
          // user to pick the shard up again, which only works once
          // they\'re in drag mode (ring dismissed). Letting them tap
          // past lands them on a step they can\'t actually do.
          noManualAdvance: true,
          onShow: (assistant) => {
            // Watch for the user tapping off the ring. Any pointerdown
            // outside .polygram-rotate-ring dismisses it (per polygram
            // pointer handlers). Listen at the document level so we
            // catch the tap regardless of where it lands. Defer the
            // advance past the in-flight gesture: the next step's
            // advanceOn is `pointerup`, and if we advance synchronously
            // here that listener gets installed in time to catch the
            // same gesture's pointerup and skips the step.
            let deferredAdvance = null
            let pollTimer = null
            const ring = document.querySelector('.polygram-rotate-ring')
            const tryAdvance = () => {
              if (deferredAdvance) return
              if (!assistant.sequenceAdvanceResolve) return
              if (ring && ring.classList.contains('is-visible')) return
              deferredAdvance = setTimeout(() => {
                deferredAdvance = null
                if (assistant.sequenceAdvanceResolve) {
                  assistant.sequenceAdvanceResolve(true)
                }
              }, 300)
            }
            const onPointerDown = (event) => {
              if (event.target && event.target.closest && event.target.closest('.polygram-rotate-ring')) return
              requestAnimationFrame(tryAdvance)
            }
            document.addEventListener('pointerdown', onPointerDown, true)
            pollTimer = setInterval(tryAdvance, 150)
            const initialCheck = setTimeout(tryAdvance, 80)
            return () => {
              clearTimeout(initialCheck)
              if (deferredAdvance) clearTimeout(deferredAdvance)
              if (pollTimer) clearInterval(pollTimer)
              document.removeEventListener('pointerdown', onPointerDown, true)
            }
          },
        })
        if (trayEl && dropRect) {
          // Second drop = the real target. By this point the shard is
          // un-ringed, the user has done the rotate, and they need to
          // pick the shard back up and drop it on the actual outline.
          steps.push({
            target: dropRect,
            message: 'Pick the shard up again and drop it about here — on the real outline this time.',
            advanceOn: [{ element: document, event: 'pointerup' }],
          })
        }
        steps.push({ target: null, message: 'When edges line up, it snaps.' })
        steps.push({
          target: '.polygram-board',
          message: 'Rule of thumb: drag = move. Tap a placed shard = rotate.',
        })
        steps.push({ target: null, message: "That's it!" })
        return steps
      }

      const buildPolygramHintSteps = () => {
        const { trayEl, dropRect } = pickPolygramHintTarget()
        if (!trayEl) {
          return [{ target: null, message: 'Every shard is placed — nudge them into alignment to finish.' }]
        }
        const steps = [{
          target: trayEl,
          message: 'Pick up this shard.',
          advanceOn: [{ element: trayEl, event: 'pointerdown' }],
        }]
        if (dropRect) {
          steps.push({
            target: dropRect,
            message: 'It belongs about here — rotate until it snaps.',
            advanceOn: [{ element: document, event: 'pointerup' }],
          })
        }
        return steps
      }

      // Slider helper: tutorial walks through the slide gesture and the
      // reference-image peek; the hint surfaces a single out-of-place tile
      // adjacent to the gap so the player has a concrete next move.
      // The next tile the player should focus on — the lowest-label tile
      // that isn't in its home slot. Label tracks homeIndex (label =
      // homeIndex + 1 in the canonical case), so smallest homeIndex
      // among out-of-place tiles is the "next number to place".
      const findNextOutOfPlaceTile = () => {
        if (!puzzle || !Array.isArray(puzzle.tiles)) return null
        let best = null
        for (const t of puzzle.tiles) {
          if (t.slotIndex === t.homeIndex) continue
          if (!best || t.homeIndex < best.homeIndex) best = t
        }
        return best
      }

      const buildSliderTutorialSteps = () => {
        const gapMarker = puzzle?.gapMarker || null
        const board = puzzle?.board || null
        // Toggles the bright pulse on the gap marker while a step is
        // pointing at it, then strips the class on cleanup so the marker
        // returns to its quiet dashed state once the step advances.
        const highlightGapMarker = () => {
          if (!gapMarker) return undefined
          gapMarker.classList.add('is-highlighted')
          // Dim the tiles so the dashed marker becomes the focal point —
          // without this the bouncer eclipses the marker and the player
          // can't actually see what the message is referring to.
          board?.classList.add('is-tutorial-marker-focus')
          return () => {
            gapMarker.classList.remove('is-highlighted')
            board?.classList.remove('is-tutorial-marker-focus')
          }
        }
        // Find a tile reachable from the current gap (same row OR same
        // column). `mode: 'adjacent'` returns a tile exactly one cell
        // away — needed for the "tap this tile to slide it into the gap"
        // step, because tapping a farther tile would trigger a multi-
        // slide and contradict the bubble copy. `mode: 'far'` returns a
        // tile at least two cells away — for the multi-slide step.
        const pickReachableTile = (mode = 'adjacent') => {
          if (!puzzle || !Array.isArray(puzzle.tiles) || typeof puzzle.emptyIndex !== 'number') return null
          const cols = puzzle.cols
          const emptyRow = Math.floor(puzzle.emptyIndex / cols)
          const emptyCol = puzzle.emptyIndex % cols
          let fallback = null
          for (const t of puzzle.tiles) {
            const r = Math.floor(t.slotIndex / cols)
            const c = t.slotIndex % cols
            let dist = -1
            if (r === emptyRow) dist = Math.abs(c - emptyCol)
            else if (c === emptyCol) dist = Math.abs(r - emptyRow)
            if (dist < 1) continue
            if (mode === 'adjacent' && dist === 1) return t
            if (mode === 'far' && dist >= 2) return t
            if (!fallback) fallback = t
          }
          return fallback
        }
        const steps = [
          {
            target: null,
            message: "Welcome! Let's learn Slider.",
          },
        ]
        steps.push({
          target: null,
          message: 'Goal: put the numbered tiles in order — 1 in the top-left, then 2, 3, 4 going across each row.',
        })
        steps.push({
          target: gapMarker || null,
          message: 'One corner stays empty — that\'s the gap that lets tiles slide around.',
          onShow: gapMarker ? highlightGapMarker : undefined,
        })
        // Resolve at step-show time so the bouncer always lands on a
        // tile that's currently adjacent to the gap — picking at
        // build-time would point at a stale tile if anything (e.g. the
        // welcome step's bubble click) ran between build and show.
        steps.push({
          target: () => pickReachableTile('adjacent')?.element || null,
          message: 'Tap this numbered tile — it\'ll slide into the gap.',
          advanceOn: [{ element: document, event: 'slider:tile-moved' }],
          noManualAdvance: true,
        })
        steps.push({
          target: () => pickReachableTile('far')?.element || board,
          message: 'You can also tap a tile farther along the same row or column — everything between slides at once. Try a longer slide.',
          advanceOn: [{
            element: document,
            event: 'slider:tile-moved',
            predicate: (evt) => (evt?.detail?.slideLength || 0) > 1,
          }],
          noManualAdvance: true,
          collapseOnInteraction: true,
        })
        steps.push({
          target: board,
          message: 'Stuck? Double-tap anywhere on the board to peek at the finished picture.',
          advanceOn: [{
            element: document,
            event: 'slider:reference-toggled',
            predicate: (evt) => evt?.detail?.visible === true,
          }],
          noManualAdvance: true,
        })
        steps.push({
          target: board,
          message: 'Single-tap the picture to put it away.',
          advanceOn: [{
            element: document,
            event: 'slider:reference-toggled',
            predicate: (evt) => evt?.detail?.visible === false,
          }],
          noManualAdvance: true,
        })
        // Guided placement: lock on to whichever tile is the lowest
        // out-of-place number right now. If tile 1 is already home in
        // the shuffle, this naturally falls through to tile 2 (etc.)
        // rather than skipping the lesson — same picker the hint uses.
        // Only skipped entirely if the board is already solved.
        const placementTile = findNextOutOfPlaceTile()
        if (placementTile) {
          const placementHomeIndex = placementTile.homeIndex
          const placementLookup = () => puzzle?.tiles?.find((t) => t.homeIndex === placementHomeIndex) || null
          const placementLabel = placementTile.numberEl?.textContent || String(placementHomeIndex + 1)
          steps.push({
            target: () => placementLookup()?.element || null,
            message: `Now try it for real. Slide tile ${placementLabel} into the dotted target spot — you may need to clear a path first.`,
            onShow: (assistant) => {
              puzzle?.highlightTargetSlot?.(placementHomeIndex)
              const reposition = () => {
                // Skip if the player collapsed the bubble — keeping the
                // bouncer parked at the menu button is the whole point
                // of the collapsed state.
                if (assistant.isBubbleCollapsed?.()) return
                const t = placementLookup()
                if (t?.element) assistant.placeBouncerOver(t.element)
              }
              document.addEventListener('slider:tile-moved', reposition)
              return () => {
                document.removeEventListener('slider:tile-moved', reposition)
                puzzle?.clearTargetSlot?.()
              }
            },
            advanceOn: [{
              element: document,
              event: 'slider:tile-moved',
              predicate: () => {
                const t = placementLookup()
                return Boolean(t && t.slotIndex === t.homeIndex)
              },
            }],
            noManualAdvance: true,
            collapseOnInteraction: true,
          })
        }
        steps.push({
          target: null,
          message: 'Nice work. Keep going — get every tile in order to win!',
        })
        return steps
      }

      const buildSliderHintSteps = () => {
        const initial = findNextOutOfPlaceTile()
        if (!initial) {
          return [{ target: null, message: 'Every tile is already home — finish the last few slides!' }]
        }
        // Lock onto the tile's homeIndex so we keep tracking the same
        // tile across slides; .find by homeIndex keeps working even
        // if a transpose remaps tile ids mid-hint.
        const targetHomeIndex = initial.homeIndex
        const lookup = () => puzzle?.tiles?.find((t) => t.homeIndex === targetHomeIndex) || null
        const label = initial.numberEl?.textContent || String(targetHomeIndex + 1)
        return [{
          target: () => lookup()?.element || null,
          message: `Place tile ${label} next. Slide it into the dotted target spot — keep going until it lands home.`,
          // Stay on this tile until it actually reaches home. Re-position
          // the bouncer after every move so the spotlight follows the
          // tile as the player slides it around. Pop up the dotted
          // target marker over the destination slot, and tear it down
          // on cleanup so it doesn't linger past the hint.
          onShow: (assistant) => {
            puzzle?.highlightTargetSlot?.(targetHomeIndex)
            const reposition = () => {
              if (assistant.isBubbleCollapsed?.()) return
              const t = lookup()
              if (t?.element) assistant.placeBouncerOver(t.element)
            }
            document.addEventListener('slider:tile-moved', reposition)
            return () => {
              document.removeEventListener('slider:tile-moved', reposition)
              puzzle?.clearTargetSlot?.()
            }
          },
          advanceOn: [{
            element: document,
            event: 'slider:tile-moved',
            predicate: () => {
              const t = lookup()
              return Boolean(t && t.slotIndex === t.homeIndex)
            },
          }],
          noManualAdvance: true,
          collapseOnInteraction: true,
        }]
      }

      let tutorialBuilder
      let hintBuilder
      if (useImmersiveSlidingChrome) {
        tutorialBuilder = buildSliderTutorialSteps
        hintBuilder = buildSliderHintSteps
      } else if (useImmersivePolygramChrome) {
        tutorialBuilder = buildPolygramTutorialSteps
        hintBuilder = buildPolygramHintSteps
      } else {
        tutorialBuilder = buildJigsawTutorialSteps
        hintBuilder = buildJigsawHintSteps
      }

      if (howToPlayBtn) {
        howToPlayBtn.addEventListener('click', () => {
          if (!activeAssistant) return
          activeAssistant.runSequence(tutorialBuilder())
        })
      }

      if (hintBtn) {
        hintBtn.addEventListener('click', () => {
          if (!activeAssistant) return
          const steps = hintBuilder()
          if (!steps.length) return
          // Silent +30s clock penalty. We bump the base directly so the
          // timer keeps running normally afterwards — the user only ever
          // sees the new total.
          activeElapsedBaseMs += 30000
          if (timerEl) timerEl.textContent = formatDuration(getActiveElapsedMs())
          activeAssistant.runSequence(steps)
        })
      }

      assistantNudgeFn = () => {
        if (!activeAssistant) return
        if (shouldNudge(gameMode)) {
          activeAssistant.showNudge('Need some help?')
        }
        recordPlayed(gameMode)
      }
      tryAssistantNudge()
    }).catch((error) => {
      console.error('Failed to load in-game assistant', error)
    })
  }

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
        // Helper-active is sticky-visibility too: the tutorial bouncer is
        // pointing at chrome the player needs to see, so the timer must not
        // dim them out from under it.
        if (workspaceEl.classList.contains('workspace--helper-active')) return
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
    if (currentRun?.testMode) {
      clearTestActiveRun()
    } else {
      clearRunForMode(currentRun)
    }
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
    if (!puzzle) return
    // Diamond hides the source image until the painting is finished —
    // the double-tap shortcut must respect that gate too, otherwise it
    // becomes a back-door reveal during play.
    if (gameMode === GAME_MODE_DIAMOND && !puzzle.completed) return
    const active = puzzle.toggleReferenceVisible()
    syncSourceButtons(active)
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

  const muteSfxBtn = gameEl.querySelector('#mute-sfx-btn')
  if (muteSfxBtn) {
    muteSfxBtn.addEventListener('click', () => {
      const muted = !(muteSfxBtn.getAttribute('aria-pressed') === 'true')
      muteSfxBtn.setAttribute('aria-pressed', muted ? 'true' : 'false')
      setDiamondSfxMuted(muted)
      puzzle?.setMuted?.(muted)
    })
  }

  // Overlay lives on the workspace, not the puzzle mount, because each
  // puzzle's destroy() wipes its container's innerHTML at the start of
  // init() — anything inside #puzzle-mount would be torn down before
  // loadImage() ever ran. The workspace is positioned, so absolute-inset
  // styling on the overlay covers the mount.
  //
  // The thumbnail (if known) becomes the loading visual — the menu
  // already cached it when the user picked the puzzle, so it appears
  // instantly while the full image streams in. The full overlay
  // (spinner / label / hint) only shows when no thumb is available.
  const thumbnailUrl = resolvePuzzleThumbnailFromState(state.puzzle, gameMode)
  const loadingOverlay = createPuzzleLoadingOverlay({ thumbnailUrl })
  if (workspaceEl) workspaceEl.append(loadingOverlay)

    ; (async () => {
      try {
        destroyPuzzle()
        // destroyPuzzle calls onStatusChange(null) (via unbindGameActivity)
        // to detach the previous game's callback. Re-register the
        // current game's updateSaveIndicator AFTER, otherwise the
        // earlier-set callback (line 4937) gets nullified here and
        // post-sync status transitions never reach the menu button —
        // the disk icon ends up pulsing forever even when sync has
        // long finished.
        onStatusChange(updateSaveIndicator)

        if (resumeRun) {
          state.gameMode = normalizeGameMode(resumeRun.gameMode || state.gameMode)
          state.difficulty = resumeRun.difficulty || state.difficulty
          // Prefer the puzzle payload's current image URL when it's for the
          // same date as the saved run — handles legacy runs whose stored
          // imageUrl uses an obsolete extension (jpg → webp) or is missing
          // a current ?v= cache-bust.
          state.imageUrl = resolveResumeImageUrl({
            imageUrl: resumeRun.imageUrl || state.imageUrl,
            puzzleDate: resumeRun.puzzleDate,
            gameMode: normalizeGameMode(resumeRun.gameMode || state.gameMode),
          }, state.puzzle)
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
            testMode,
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
          thumbnailUrl,
          difficulty: state.difficulty,
          boardColorIndex: getGlobalBoardColorIndex(),
          muted: gameMode === GAME_MODE_DIAMOND ? getDiamondSfxMuted() : false,
          onLoadProgress: (progress) => updatePuzzleLoadingOverlay(loadingOverlay, progress),
          onProgress: ({ completed, lockedCount, totalCount, state: progressState }) => {
            if (currentRun) {
              currentRun.completed = Boolean(completed)
              if (Number.isFinite(lockedCount)) currentRun.lockedCount = lockedCount
              if (Number.isFinite(totalCount)) currentRun.totalCount = totalCount
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

            // Diamond's source-image controls are hidden during play;
            // reveal them once the painting is finished so the user can
            // compare against the source (small subjects collapse to a
            // few pixels under 16-colour quantization and aren't always
            // self-evident from the painted output alone). Both the
            // menu entry and the persistent floating button reveal
            // together.
            if (gameMode === GAME_MODE_DIAMOND) {
              if (viewBtn) viewBtn.hidden = false
              if (showSourceFloatingBtn) showSourceFloatingBtn.hidden = false
            }

            stopTimerDisplay()
            pauseActiveTimer()
            currentRun.elapsedActiveMs = getActiveElapsedMs()
            currentRun.completed = true
            currentRun.updatedAt = new Date().toISOString()
            recordCompletedRun(currentRun)
            if (gameMode === GAME_MODE_DIAMOND) {
              persistDiamondSessionLog(currentRun.puzzleDate, puzzle, currentRun.elapsedActiveMs, { testMode: currentRun.testMode })
            }
            if (currentRun.testMode) {
              clearTestActiveRun()
            }
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
              const syncActive = isSyncEnabled() && navigator.onLine && !currentRun.testMode
              // Diamond gets a "Show source image" action on the overlay
              // so first-time finishers discover the toggle without
              // hunting for it in the menu. Clicking reveals the source
              // overlay on the canvas behind, dismisses the celebration,
              // and leaves the persistent floating button (already
              // revealed above) for ongoing access.
              const onShowSource = gameMode === GAME_MODE_DIAMOND
                ? () => {
                  if (!puzzle) return
                  const active = puzzle.toggleReferenceVisible()
                  syncSourceButtons(active)
                }
                : undefined
              // After completing an archive run, present the Unfinished
              // modal with a strike-through animation on the just-finished
              // puzzle — the OCD nudge lands while the win is still warm.
              // Skipped for today's puzzle (the launcher is the natural
              // next stop) and for test mode (no production list).
              const todayKey = getIsoDate(new Date())
              const wasArchive = !currentRun.testMode
                && completedRun?.puzzleDate
                && completedRun.puzzleDate !== todayKey
              const onAfterDismiss = wasArchive
                ? () => {
                  const struck = {
                    gameMode: completedRun.gameMode,
                    puzzleDate: completedRun.puzzleDate,
                  }
                  openUnfinishedModal({
                    struckRun: struck,
                    todayDate: todayKey,
                    onResume: async ({ mode, date }) => {
                      await resumeArchiveRunFromList(mode, date)
                    },
                  })
                }
                : undefined

              const overlay = showCompletionOverlay({
                gameMode,
                duration: durationLabel,
                elapsedMs: currentRun.elapsedActiveMs,
                submissionElapsedMs: currentRun.elapsedActiveMs,
                playerGuid,
                completedRun,
                showRankPill: syncActive,
                onShowSource,
                onAfterDismiss,
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

                ; (async () => {
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

          // Resuming a fully-completed diamond run also needs the source-
          // image controls revealed — onComplete only fires on the
          // painting's final stroke, not on resume.
          if (gameMode === GAME_MODE_DIAMOND && puzzle.completed) {
            if (viewBtn) viewBtn.hidden = false
            if (showSourceFloatingBtn) showSourceFloatingBtn.hidden = false
          }

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

        // Reveal the puzzle once setup has fully succeeded — including any
        // applyProgressState — so a failure mid-restore still shows the
        // error card instead of an empty page over a half-built puzzle.
        if (loadingOverlay && loadingOverlay.parentElement) {
          loadingOverlay.remove()
        }

        // Helper nudge gate. The bouncing "need some help?" prompt only fires
        // after the puzzle is fully drawn so it isn't competing with the
        // loading spinner for attention.
        assistantPuzzleReady = true
        tryAssistantNudge()
      } catch (error) {
        console.error(error)
        setStatus('Failed to load puzzle image.', 'error')
        if (loadingOverlay && loadingOverlay.parentElement) {
          renderPuzzleLoadError(loadingOverlay, {
            onRetry: () => renderGame({ resumeRun }),
          })
        }
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
  if (activeAssistant) {
    activeAssistant.destroy()
    activeAssistant = null
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
  }).catch(() => { })
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
  // Apply the resolved theme + start watching for OS pref changes (no-op
  // in manual modes). The inline bootstrap script in index.html already
  // set data-theme synchronously; this re-applies in case localStorage
  // was unavailable during the early script.
  applyTheme()
  watchSystemTheme()
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
      if (isSyncEnabled()) pullOnForeground().catch(() => { })
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
  } catch { }
  return new Set(SETTINGS_DEFAULT_OPEN)
}

function setSectionOpen(id, open) {
  const set = getOpenSections()
  if (open) set.add(id); else set.delete(id)
  try {
    localStorage.setItem(SETTINGS_OPEN_SECTIONS_KEY, JSON.stringify([...set]))
  } catch { }
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
    { id: 'testing', title: 'Testing', desc: 'Run the diamond pipeline against the bundled hero image' },
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
              <div class="settings-subtitle">Theme</div>
              <div class="settings-theme-segmented" role="group" aria-label="Theme">
                ${['light', 'auto', 'dark'].map((opt) => `
                  <button type="button" class="settings-theme-option${getThemePref() === opt ? ' is-selected' : ''}" data-theme-pref="${opt}" aria-pressed="${getThemePref() === opt}">${opt[0].toUpperCase() + opt.slice(1)}</button>
                `).join('')}
              </div>

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

          <details class="settings-section" id="settings-section-testing" data-section="testing"${sectionOpen('testing')}>
            <summary class="settings-section-summary">
              <span class="settings-section-title">Testing</span>
              <span class="settings-section-chevron" aria-hidden="true">\u25b8</span>
            </summary>
            <div class="settings-section-body" id="settings-testing-content"></div>
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

  const themeSeg = container.querySelector('.settings-theme-segmented')
  if (themeSeg) {
    themeSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-theme-pref]')
      if (!btn) return
      const pref = btn.dataset.themePref
      setThemePref(pref)
      applyTheme(pref)
      themeSeg.querySelectorAll('[data-theme-pref]').forEach((b) => {
        const on = b.dataset.themePref === pref
        b.classList.toggle('is-selected', on)
        b.setAttribute('aria-pressed', String(on))
      })
      // Repaint the board-color swatches: the "image" placeholder picks
      // a different palette in light vs. dark mode, so a theme flip can
      // change which swatch is currently active.
      const newColors = getBoardColors()
      const newActive = getGlobalBoardColorIndex()
      const swatches = grid.querySelectorAll('.settings-color-swatch')
      swatches.forEach((s, i) => {
        if (i < newColors.length) {
          if (newColors[i].color) s.setAttribute('style', `background:${newColors[i].color}`)
          else s.removeAttribute('style')
        }
        s.classList.toggle('is-active', i === newActive)
      })
    })
  }

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
  renderTestingSettings()

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
      <div class="sync-code-display sync-code-hidden">
        <span class="sync-code-value">${code}</span>
        <button type="button" class="sync-code-reveal" aria-label="Reveal sync code">Tap to reveal</button>
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
      } catch { }
    })
    const revealBtn = el.querySelector('.sync-code-reveal')
    const codeDisplay = el.querySelector('.sync-code-display')
    if (revealBtn && codeDisplay) {
      revealBtn.addEventListener('click', () => {
        codeDisplay.classList.remove('sync-code-hidden')
      })
    }
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

  toggle.addEventListener('click', (event) => {
    const nowEnabled = !getMusicEnabled()
    setMusicVolume(nowEnabled ? (lastNonZeroVolume || MUSIC_DEFAULT_VOLUME) : 0)
    applyMusicVolume({ fromGesture: event.isTrusted !== false })
    refresh()
  })

  slider.addEventListener('input', (event) => {
    const v = Number(slider.value)
    setMusicVolume(v)
    applyMusicVolume({ fromGesture: event.isTrusted !== false })
    refresh()
  })
}

function renderTestingSettings() {
  const el = document.querySelector('#settings-testing-content')
  if (!el) return
  el.innerHTML = `
    <p class="settings-testing-description">
      Launch the diamond paint pipeline against the bundled hero image to validate
      calibration metrics. Test runs skip leaderboard submission, completion
      tracking, active-run persistence, and remote session-log upload — the log
      is stored locally only, under a <code>test-</code> date prefix, and is
      visible in the admin session-log viewer on the same device.
    </p>
    <button type="button" id="test-play-diamond" class="settings-test-btn">
      Play hero (diamond / paint)
    </button>
  `
  const btn = el.querySelector('#test-play-diamond')
  btn?.addEventListener('click', () => {
    state.gameMode = GAME_MODE_DIAMOND
    const existing = loadTestActiveRun()
    if (existing) {
      renderGame({ resumeRun: existing, testMode: true })
    } else {
      renderGame({ testMode: true })
    }
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
        const [result, logUpload] = await Promise.all([
          forcePush(),
          uploadLocalDiamondSessionLogs(),
        ])
        let msg
        if (result && result.pulledChanges) {
          msg = `Synced. Pulled changes (rev ${result.revAfter}).`
        } else if (result && result.ran) {
          msg = `Synced. No new remote changes (rev ${result.revAfter}).`
        } else {
          msg = 'Synced.'
        }
        if (logUpload && logUpload.total > 0) {
          msg += ` Diamond logs: ${logUpload.uploaded}/${logUpload.total}`
          if (logUpload.failed > 0) msg += ` (${logUpload.failed} failed)`
          msg += '.'
        }
        syncStatusEl.textContent = msg
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
  try { history.replaceState(null, '', cleanUrl) } catch { }

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
    try { disableSync() } catch { }
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
  navigator.serviceWorker.register('/sw.js').catch(() => { })
}

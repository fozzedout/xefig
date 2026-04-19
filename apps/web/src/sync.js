const SYNC_SHARE_CODE_KEY = 'xefig:sync:share-code:v1'
const SYNC_REVISION_KEY = 'xefig:sync:revision:v2'
const SYNC_ENABLED_KEY = 'xefig:sync:enabled:v1'
const SYNC_JOURNAL_KEY = 'xefig:sync:journal:v2'
const PROFILE_NAME_KEY = 'xefig:profile-name:v1'

const COMPLETED_RUNS_KEY = 'xefig:puzzles:completed:v1'
const BOARD_COLOR_KEY = 'xefig:board-color:v1'
const ACTIVE_RUN_PREFIX = 'xefig:run:'

const DEFAULT_PUSH_LIMIT = 24

let syncEnabled = false
let syncIntervalId = null
let syncStatus = 'idle'
let conflictCallback = null
let statusCallback = null
let syncInFlight = null
let dirtyJournal = loadJournal()

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

function entityKey(puzzleDate, gameMode) {
  return `${puzzleDate}:${gameMode}`
}

function storageKeyForRun(key) {
  return `${ACTIVE_RUN_PREFIX}${key}`
}

function compareIsoTimestamps(a, b) {
  const left = a ? Date.parse(a) : Number.NaN
  const right = b ? Date.parse(b) : Number.NaN
  if (!Number.isFinite(left) && !Number.isFinite(right)) return 0
  if (!Number.isFinite(left)) return -1
  if (!Number.isFinite(right)) return 1
  if (left === right) return 0
  return left > right ? 1 : -1
}

function normalizeCompletedEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  return {
    difficulty: entry.difficulty ?? null,
    elapsedActiveMs: Number(entry.elapsedActiveMs) || 0,
    bestElapsedMs: Number(entry.bestElapsedMs ?? entry.elapsedActiveMs) || 0,
    completedAt: entry.completedAt || '',
  }
}

function completedEntryToken(entry) {
  const normalized = normalizeCompletedEntry(entry)
  if (!normalized) return ''
  return JSON.stringify(normalized)
}

function normalizeActiveRun(run) {
  if (!run || typeof run !== 'object') return null
  return {
    puzzleDate: run.puzzleDate || '',
    gameMode: run.gameMode || '',
    difficulty: run.difficulty ?? null,
    imageUrl: run.imageUrl ?? null,
    elapsedActiveMs: Number(run.elapsedActiveMs) || 0,
    puzzleState: run.puzzleState ?? null,
    updatedAt: run.updatedAt || '',
  }
}

function activeRunToken(run) {
  const normalized = normalizeActiveRun(run)
  if (!normalized) return ''
  return normalized.updatedAt || JSON.stringify(normalized)
}

function defaultJournal() {
  return {
    settingsToken: null,
    completedRuns: {},
    activeRuns: {},
    deletedActiveRuns: {},
  }
}

function sanitizeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [key, token] of Object.entries(value)) {
    if (typeof key === 'string' && typeof token === 'string' && token) {
      out[key] = token
    }
  }
  return out
}

function loadJournal() {
  const raw = readJson(SYNC_JOURNAL_KEY)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultJournal()
  }
  return {
    settingsToken: typeof raw.settingsToken === 'string' && raw.settingsToken ? raw.settingsToken : null,
    completedRuns: sanitizeMap(raw.completedRuns),
    activeRuns: sanitizeMap(raw.activeRuns),
    deletedActiveRuns: sanitizeMap(raw.deletedActiveRuns),
  }
}

function persistJournal() {
  try {
    localStorage.setItem(SYNC_JOURNAL_KEY, JSON.stringify(dirtyJournal))
  } catch {}
}

function clearJournal() {
  dirtyJournal = defaultJournal()
  try {
    localStorage.removeItem(SYNC_JOURNAL_KEY)
  } catch {}
}

function getPlayerGuid() {
  return localStorage.getItem('xefig:player-guid:v1') || ''
}

function setPlayerGuid(guid) {
  localStorage.setItem('xefig:player-guid:v1', guid)
}

function getSyncRevision() {
  return Math.max(0, Number(localStorage.getItem(SYNC_REVISION_KEY)) || 0)
}

function setSyncRevision(revision) {
  localStorage.setItem(SYNC_REVISION_KEY, String(Math.max(0, Number(revision) || 0)))
}

function getLocalSettings() {
  return {
    profileName: localStorage.getItem(PROFILE_NAME_KEY) || '',
    boardColorIndex: Number(localStorage.getItem(BOARD_COLOR_KEY)) || 0,
  }
}

function setLocalSettings(settings) {
  if (!settings || typeof settings !== 'object') return
  if (typeof settings.profileName === 'string') {
    localStorage.setItem(PROFILE_NAME_KEY, settings.profileName)
  }
  if (typeof settings.boardColorIndex === 'number' && Number.isFinite(settings.boardColorIndex)) {
    localStorage.setItem(BOARD_COLOR_KEY, String(settings.boardColorIndex))
  }
}

function getCompletedRunsByDate() {
  const completedRuns = readJson(COMPLETED_RUNS_KEY)
  if (!completedRuns || typeof completedRuns !== 'object' || Array.isArray(completedRuns)) {
    return {}
  }
  return completedRuns
}

function flattenCompletedRuns(source = getCompletedRunsByDate()) {
  const out = {}
  for (const [date, modes] of Object.entries(source || {})) {
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) continue
    for (const [mode, entry] of Object.entries(modes)) {
      const normalized = normalizeCompletedEntry(entry)
      if (!normalized) continue
      out[entityKey(date, mode)] = { puzzleDate: date, gameMode: mode, ...normalized }
    }
  }
  return out
}

function writeCompletedMap(flatMap) {
  const nested = {}
  for (const [key, entry] of Object.entries(flatMap || {})) {
    if (!entry || typeof entry !== 'object') continue
    const [puzzleDate, gameMode] = key.split(':')
    if (!puzzleDate || !gameMode) continue
    if (!nested[puzzleDate]) nested[puzzleDate] = {}
    nested[puzzleDate][gameMode] = {
      difficulty: entry.difficulty ?? null,
      elapsedActiveMs: Number(entry.elapsedActiveMs) || 0,
      bestElapsedMs: Number(entry.bestElapsedMs ?? entry.elapsedActiveMs) || 0,
      completedAt: entry.completedAt || '',
    }
  }
  writeJson(COMPLETED_RUNS_KEY, nested)
}

function mergeCompletedEntries(localEntry, remoteEntry) {
  const local = normalizeCompletedEntry(localEntry)
  const remote = normalizeCompletedEntry(remoteEntry)
  if (!local && !remote) return null
  if (!local) return remote
  if (!remote) return local
  const cmp = compareIsoTimestamps(local.completedAt, remote.completedAt)
  const newer = cmp >= 0 ? local : remote
  return {
    difficulty: newer.difficulty ?? local.difficulty ?? remote.difficulty ?? null,
    elapsedActiveMs: cmp >= 0 ? local.elapsedActiveMs : remote.elapsedActiveMs,
    bestElapsedMs: Math.min(local.bestElapsedMs || remote.bestElapsedMs, remote.bestElapsedMs || local.bestElapsedMs),
    completedAt: cmp >= 0 ? local.completedAt || remote.completedAt : remote.completedAt || local.completedAt,
  }
}

function gatherActiveRuns() {
  const runs = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(ACTIVE_RUN_PREFIX)) continue
    try {
      const parsed = JSON.parse(localStorage.getItem(key))
      if (!parsed || typeof parsed !== 'object' || parsed.completed) continue
      const normalized = normalizeActiveRun(parsed)
      if (!normalized || !normalized.puzzleDate || !normalized.gameMode) continue
      runs[key.replace(ACTIVE_RUN_PREFIX, '')] = normalized
    } catch {}
  }
  return runs
}

function getActiveRun(key) {
  return normalizeActiveRun(readJson(storageKeyForRun(key)))
}

function setActiveRun(key, run) {
  writeJson(storageKeyForRun(key), run)
}

function removeActiveRun(key) {
  try {
    localStorage.removeItem(storageKeyForRun(key))
  } catch {}
}

function isJournalEmpty() {
  return (
    !dirtyJournal.settingsToken &&
    Object.keys(dirtyJournal.completedRuns).length === 0 &&
    Object.keys(dirtyJournal.activeRuns).length === 0 &&
    Object.keys(dirtyJournal.deletedActiveRuns).length === 0
  )
}

function queueSettingsSync() {
  dirtyJournal.settingsToken = new Date().toISOString()
  persistJournal()
}

function queueCompletedSync(key, token) {
  dirtyJournal.completedRuns[key] = token
  persistJournal()
}

function queueActiveSync(key, token) {
  dirtyJournal.activeRuns[key] = token
  delete dirtyJournal.deletedActiveRuns[key]
  persistJournal()
}

function queueDeletedActiveSync(key, deletedAt) {
  delete dirtyJournal.activeRuns[key]
  dirtyJournal.deletedActiveRuns[key] = deletedAt
  persistJournal()
}

function clearCompletedSync(key) {
  delete dirtyJournal.completedRuns[key]
}

function clearActiveSync(key) {
  delete dirtyJournal.activeRuns[key]
}

function clearDeletedActiveSync(key) {
  delete dirtyJournal.deletedActiveRuns[key]
}

function setSyncStatus(next) {
  syncStatus = next
  if (typeof statusCallback === 'function') statusCallback(next)
}

async function apiPost(path, body, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

function chooseSettingValue(localValue, remoteValue, defaultValue, localDirty) {
  if (localDirty) return localValue
  if (remoteValue !== defaultValue) return remoteValue
  if (localValue !== defaultValue) return localValue
  return remoteValue
}

function mergeRemoteSettings(remoteSettings) {
  if (!remoteSettings || typeof remoteSettings !== 'object') return
  const local = getLocalSettings()
  const localDirty = Boolean(dirtyJournal.settingsToken)
  const merged = {
    profileName: chooseSettingValue(local.profileName, remoteSettings.profileName || '', '', localDirty),
    boardColorIndex: chooseSettingValue(local.boardColorIndex, Number(remoteSettings.boardColorIndex) || 0, 0, localDirty),
  }

  setLocalSettings(merged)

  const remoteNormalized = {
    profileName: remoteSettings.profileName || '',
    boardColorIndex: Number(remoteSettings.boardColorIndex) || 0,
  }

  if (JSON.stringify(merged) !== JSON.stringify(remoteNormalized)) {
    queueSettingsSync()
  } else {
    dirtyJournal.settingsToken = null
    persistJournal()
  }
}

function applyCompletedEntries(entries, { preserveLocalOnly = false } = {}) {
  const localMap = flattenCompletedRuns()
  const remoteMap = {}

  for (const entry of entries || []) {
    if (!entry || !entry.puzzleDate || !entry.gameMode) continue
    const key = entityKey(entry.puzzleDate, entry.gameMode)
    remoteMap[key] = normalizeCompletedEntry(entry)
  }

  const mergedMap = { ...localMap }
  const remoteKeys = new Set(Object.keys(remoteMap))

  for (const [key, remoteEntry] of Object.entries(remoteMap)) {
    const localEntry = localMap[key] || null
    const merged = mergeCompletedEntries(localEntry, remoteEntry)
    if (!merged) continue
    const [puzzleDate, gameMode] = key.split(':')
    mergedMap[key] = { puzzleDate, gameMode, ...merged }
    removeActiveRun(key)
    clearActiveSync(key)
    clearDeletedActiveSync(key)

    if (completedEntryToken(merged) === completedEntryToken(remoteEntry)) {
      clearCompletedSync(key)
    } else {
      queueCompletedSync(key, completedEntryToken(merged))
    }
  }

  if (preserveLocalOnly) {
    for (const [key, localEntry] of Object.entries(localMap)) {
      if (!remoteKeys.has(key) && localEntry) {
        queueCompletedSync(key, completedEntryToken(localEntry))
      }
    }
  }

  writeCompletedMap(mergedMap)
  persistJournal()
}

function applyActiveEntries(entries, { preserveLocalOnly = false } = {}) {
  const remoteMap = {}
  for (const entry of entries || []) {
    if (!entry || !entry.puzzleDate || !entry.gameMode) continue
    remoteMap[entityKey(entry.puzzleDate, entry.gameMode)] = normalizeActiveRun(entry)
  }

  const localMap = gatherActiveRuns()
  const completedMap = flattenCompletedRuns()
  const allKeys = preserveLocalOnly
    ? new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])
    : new Set(Object.keys(remoteMap))

  for (const key of allKeys) {
    if (completedMap[key]) {
      removeActiveRun(key)
      clearActiveSync(key)
      clearDeletedActiveSync(key)
      continue
    }

    const localRun = localMap[key] || null
    const remoteRun = remoteMap[key] || null

    if (!remoteRun) {
      if (preserveLocalOnly && localRun) {
        queueActiveSync(key, activeRunToken(localRun))
      }
      continue
    }

    let chosen = remoteRun
    let keepLocalDirty = false

    if (localRun) {
      const cmp = compareIsoTimestamps(localRun.updatedAt, remoteRun.updatedAt)
      if (cmp > 0) {
        chosen = localRun
        keepLocalDirty = true
      }
    }

    setActiveRun(key, chosen)
    if (keepLocalDirty) {
      queueActiveSync(key, activeRunToken(chosen))
    } else {
      clearActiveSync(key)
      clearDeletedActiveSync(key)
    }
  }

  persistJournal()
}

function applyDeletedActiveEntries(entries) {
  for (const entry of entries || []) {
    if (!entry || !entry.puzzleDate || !entry.gameMode) continue
    const key = entityKey(entry.puzzleDate, entry.gameMode)
    const localRun = getActiveRun(key)
    if (localRun && compareIsoTimestamps(localRun.updatedAt, entry.deletedAt) > 0) {
      queueActiveSync(key, activeRunToken(localRun))
      continue
    }
    removeActiveRun(key)
    clearActiveSync(key)
    clearDeletedActiveSync(key)
  }
  persistJournal()
}

function applyFullSync(data) {
  if (!data || typeof data !== 'object') return

  mergeRemoteSettings(data.settings || {})

  const remoteCompletedEntries = []
  for (const [date, modes] of Object.entries(data.completedRuns || {})) {
    if (!modes || typeof modes !== 'object') continue
    for (const [mode, entry] of Object.entries(modes)) {
      if (!entry) continue
      remoteCompletedEntries.push({
        puzzleDate: date,
        gameMode: mode,
        difficulty: entry.difficulty ?? null,
        elapsedActiveMs: Number(entry.elapsedActiveMs) || 0,
        bestElapsedMs: Number(entry.bestElapsedMs ?? entry.elapsedActiveMs) || 0,
        completedAt: entry.completedAt || '',
      })
    }
  }
  applyCompletedEntries(remoteCompletedEntries, { preserveLocalOnly: true })

  const remoteActiveEntries = []
  for (const [storageKey, run] of Object.entries(data.activeRuns || {})) {
    const normalized = normalizeActiveRun(run)
    if (!normalized) continue
    const parts = storageKey.replace(ACTIVE_RUN_PREFIX, '').split(':')
    remoteActiveEntries.push({
      puzzleDate: parts[0] || normalized.puzzleDate,
      gameMode: parts[1] || normalized.gameMode,
      difficulty: normalized.difficulty ?? null,
      imageUrl: normalized.imageUrl ?? null,
      elapsedActiveMs: normalized.elapsedActiveMs,
      puzzleState: normalized.puzzleState ?? null,
      updatedAt: normalized.updatedAt || '',
    })
  }
  applyActiveEntries(remoteActiveEntries, { preserveLocalOnly: true })
}

function buildPushBatch(limit = DEFAULT_PUSH_LIMIT) {
  const batch = {
    baseRevision: getSyncRevision(),
    settings: undefined,
    completedRuns: [],
    activeRuns: [],
    deletedActiveRuns: [],
  }
  const ack = {
    settingsToken: null,
    completedRuns: {},
    activeRuns: {},
    deletedActiveRuns: {},
  }

  let budget = Math.max(1, Number(limit) || DEFAULT_PUSH_LIMIT)

  if (dirtyJournal.settingsToken) {
    batch.settings = getLocalSettings()
    ack.settingsToken = dirtyJournal.settingsToken
  }

  const completedMap = flattenCompletedRuns()
  for (const key of Object.keys(dirtyJournal.completedRuns).sort()) {
    if (budget <= 0) break
    const entry = completedMap[key]
    if (!entry) {
      clearCompletedSync(key)
      continue
    }
    batch.completedRuns.push({
      puzzleDate: entry.puzzleDate,
      gameMode: entry.gameMode,
      difficulty: entry.difficulty ?? null,
      elapsedActiveMs: entry.elapsedActiveMs,
      bestElapsedMs: entry.bestElapsedMs,
      completedAt: entry.completedAt,
    })
    ack.completedRuns[key] = dirtyJournal.completedRuns[key]
    budget -= 1

    if (dirtyJournal.deletedActiveRuns[key] && budget > 0) {
      batch.deletedActiveRuns.push({
        puzzleDate: entry.puzzleDate,
        gameMode: entry.gameMode,
        deletedAt: dirtyJournal.deletedActiveRuns[key],
      })
      ack.deletedActiveRuns[key] = dirtyJournal.deletedActiveRuns[key]
      budget -= 1
    }
  }

  for (const key of Object.keys(dirtyJournal.activeRuns).sort()) {
    if (budget <= 0) break
    if (ack.completedRuns[key]) continue
    const run = getActiveRun(key)
    if (!run) {
      clearActiveSync(key)
      continue
    }
    batch.activeRuns.push({
      puzzleDate: run.puzzleDate,
      gameMode: run.gameMode,
      difficulty: run.difficulty ?? null,
      imageUrl: run.imageUrl ?? null,
      elapsedActiveMs: run.elapsedActiveMs,
      puzzleState: run.puzzleState ?? null,
      updatedAt: run.updatedAt || new Date().toISOString(),
    })
    ack.activeRuns[key] = dirtyJournal.activeRuns[key]
    budget -= 1
  }

  for (const key of Object.keys(dirtyJournal.deletedActiveRuns).sort()) {
    if (budget <= 0) break
    if (ack.deletedActiveRuns[key]) continue
    const [puzzleDate, gameMode] = key.split(':')
    if (!puzzleDate || !gameMode) {
      clearDeletedActiveSync(key)
      continue
    }
    batch.deletedActiveRuns.push({
      puzzleDate,
      gameMode,
      deletedAt: dirtyJournal.deletedActiveRuns[key],
    })
    ack.deletedActiveRuns[key] = dirtyJournal.deletedActiveRuns[key]
    budget -= 1
  }

  persistJournal()

  const hasChanges =
    Boolean(batch.settings) ||
    batch.completedRuns.length > 0 ||
    batch.activeRuns.length > 0 ||
    batch.deletedActiveRuns.length > 0

  return hasChanges ? { batch, ack } : null
}

function acknowledgeBatch(ack) {
  if (!ack) return

  if (ack.settingsToken && dirtyJournal.settingsToken === ack.settingsToken) {
    dirtyJournal.settingsToken = null
  }

  for (const [key, token] of Object.entries(ack.completedRuns || {})) {
    if (dirtyJournal.completedRuns[key] === token) {
      delete dirtyJournal.completedRuns[key]
    }
  }

  for (const [key, token] of Object.entries(ack.activeRuns || {})) {
    if (dirtyJournal.activeRuns[key] === token) {
      delete dirtyJournal.activeRuns[key]
    }
  }

  for (const [key, token] of Object.entries(ack.deletedActiveRuns || {})) {
    if (dirtyJournal.deletedActiveRuns[key] === token) {
      delete dirtyJournal.deletedActiveRuns[key]
    }
  }

  persistJournal()
}

async function pullFromServer() {
  const guid = getPlayerGuid()
  if (!guid) return null

  const result = await apiPost('/api/sync/pull', {
    playerGuid: guid,
    revision: getSyncRevision(),
  })
  if (result.notFound) return null
  return result
}

async function pullAllRemoteChanges() {
  const result = await pullFromServer()
  if (!result) return

  if (result.noChanges) {
    if (typeof result.revision === 'number') setSyncRevision(result.revision)
    return
  }

  if (result.fullSync) {
    applyFullSync(result)
    if (typeof result.revision === 'number') setSyncRevision(result.revision)
  }
}

async function pushPendingBatches() {
  const guid = getPlayerGuid()
  if (!guid) return

  let attempts = 0
  while (!isJournalEmpty() && attempts < 20) {
    attempts += 1
    const payload = buildPushBatch()
    if (!payload) return

    const result = await apiPost('/api/sync/push', {
      playerGuid: guid,
      ...payload.batch,
    })

    if (result.conflict) {
      await pullAllRemoteChanges()
      continue
    }

    if (!result.ok) {
      throw new Error(result.error || 'Unable to save profile.')
    }

    if (typeof result.revision === 'number') setSyncRevision(result.revision)
    acknowledgeBatch(payload.ack)
  }
}

async function syncNow() {
  if (!syncEnabled) return
  if (syncInFlight) return syncInFlight

  syncInFlight = (async () => {
    setSyncStatus('syncing')
    try {
      await pushPendingBatches()
      await pullAllRemoteChanges()
      setSyncStatus(isJournalEmpty() ? 'saved' : 'pending')
    } catch {
      setSyncStatus('error')
    } finally {
      syncInFlight = null
    }
  })()

  return syncInFlight
}

export function isSyncEnabled() {
  return localStorage.getItem(SYNC_ENABLED_KEY) === 'true'
}

export function getShareCode() {
  return localStorage.getItem(SYNC_SHARE_CODE_KEY) || null
}

export function getProfileName() {
  return localStorage.getItem(PROFILE_NAME_KEY) || ''
}

export function setProfileName(name) {
  localStorage.setItem(PROFILE_NAME_KEY, (name || '').trim().slice(0, 30))
  if (isSyncEnabled()) {
    queueSettingsSync()
    notifyIfPending()
  }
}

export function markSettingsDirty() {
  if (!isSyncEnabled()) return
  queueSettingsSync()
  notifyIfPending()
}

export function markCompletedRunDirty(run) {
  if (!isSyncEnabled() || !run?.puzzleDate || !run?.gameMode) return
  const key = entityKey(run.puzzleDate, run.gameMode)
  const completedMap = flattenCompletedRuns()
  const entry = completedMap[key]
  if (!entry) return
  clearActiveSync(key)
  queueCompletedSync(key, completedEntryToken(entry))
  notifyIfPending()
}

export function markActiveRunDirty(run) {
  if (!isSyncEnabled() || !run?.puzzleDate || !run?.gameMode) return
  const key = entityKey(run.puzzleDate, run.gameMode)
  queueActiveSync(key, activeRunToken(run))
  notifyIfPending()
}

export function markActiveRunDeleted(run) {
  if (!isSyncEnabled() || !run?.puzzleDate || !run?.gameMode) return
  const key = entityKey(run.puzzleDate, run.gameMode)
  queueDeletedActiveSync(key, new Date().toISOString())
  notifyIfPending()
}

export function getSyncStatus() {
  return syncStatus
}

export function onStatusChange(cb) {
  statusCallback = typeof cb === 'function' ? cb : null
}

export async function forcePush() {
  if (!syncEnabled) return
  await syncNow()
}

export function hasPendingChanges() {
  if (!syncEnabled) return false
  return !isJournalEmpty()
}

export function notifyIfPending() {
  if (!syncEnabled || syncStatus === 'syncing') return
  setSyncStatus(isJournalEmpty() ? 'saved' : 'pending')
}

export function onConflict(cb) {
  conflictCallback = typeof cb === 'function' ? cb : null
}

export async function resolveConflict() {
  await syncNow()
}

export async function enableSync(playerGuid) {
  const result = await apiPost('/api/sync/register', { playerGuid })
  if (result.error) throw new Error(result.error)

  localStorage.setItem(SYNC_ENABLED_KEY, 'true')
  localStorage.setItem(SYNC_SHARE_CODE_KEY, result.shareCode)
  syncEnabled = true
  dirtyJournal = loadJournal()

  applyFullSync(result)
  setSyncRevision(result.revision || 0)
  await syncNow()
  startSyncTimer()

  return result.shareCode
}

export async function linkSync(shareCode) {
  const result = await apiPost('/api/sync/link', { shareCode: shareCode.toUpperCase() })
  if (result.error) throw new Error(result.error)

  setPlayerGuid(result.playerGuid)
  localStorage.setItem(SYNC_ENABLED_KEY, 'true')
  localStorage.setItem(SYNC_SHARE_CODE_KEY, shareCode.toUpperCase())
  syncEnabled = true
  dirtyJournal = loadJournal()

  applyFullSync(result)
  setSyncRevision(result.revision || 0)

  await syncNow()
  startSyncTimer()

  return result
}

export function disableSync() {
  stopSyncTimer()
  syncEnabled = false
  setSyncStatus('idle')
  clearJournal()
  localStorage.removeItem(SYNC_ENABLED_KEY)
  localStorage.removeItem(SYNC_SHARE_CODE_KEY)
  localStorage.removeItem(SYNC_REVISION_KEY)
}

let pullIntervalId = null

export function startSyncTimer() {
  if (syncIntervalId || !syncEnabled) return
  // Only push when there are pending changes. 5 minutes instead of 1 —
  // the main.js activity handler also flushes on exit, tab hide, and
  // focus loss via onGameExit/sendBeacon, so the interval is just a
  // background safety net rather than the primary sync path.
  syncIntervalId = setInterval(() => {
    if (!isJournalEmpty()) {
      syncNow()
    }
  }, 300_000)
  // Pull-only check every 5 minutes to pick up remote changes
  if (!pullIntervalId) {
    pullIntervalId = setInterval(() => {
      if (isJournalEmpty() && !syncInFlight) {
        pullAllRemoteChanges().catch(() => {})
      }
    }, 300_000)
  }
}

export function stopSyncTimer() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
  if (pullIntervalId) {
    clearInterval(pullIntervalId)
    pullIntervalId = null
  }
}

export function onGameExit() {
  if (!syncEnabled) return
  const payload = buildPushBatch(8)
  const guid = getPlayerGuid()
  if (!payload || !guid) return

  try {
    navigator.sendBeacon(
      '/api/sync/push',
      new Blob(
        [
          JSON.stringify({
            playerGuid: guid,
            ...payload.batch,
          }),
        ],
        { type: 'application/json' },
      ),
    )
    // Optimistically acknowledge — beacon is fire-and-forget so we can't
    // wait for a response.  The next syncNow() will reconcile if the push
    // actually failed (conflict path will re-pull).
    acknowledgeBatch(payload.ack)
  } catch {}
}

export async function initSync() {
  syncEnabled = isSyncEnabled()
  dirtyJournal = loadJournal()
  if (!syncEnabled) return

  try {
    await pullAllRemoteChanges()
    await syncNow()
  } catch {
    setSyncStatus(isJournalEmpty() ? 'saved' : 'error')
  }

  startSyncTimer()
}

// Throttled pull for use when the page regains focus — catches
// completions pushed from another device while this one was backgrounded.
// The 5-minute interval timer alone is too coarse for "I just finished
// on my laptop, why is my phone still showing partial?".
let lastForegroundPullAt = 0
export async function pullOnForeground() {
  if (!syncEnabled || syncInFlight) return
  if (!isJournalEmpty()) return
  const now = Date.now()
  if (now - lastForegroundPullAt < 30_000) return
  lastForegroundPullAt = now
  try { await pullAllRemoteChanges() } catch {}
}

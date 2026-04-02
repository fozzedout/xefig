/**
 * Sync module — anonymous profile sharing between devices.
 *
 * Normalized sync: each push sends only the specific change (active run,
 * completed run, or settings). No full-profile serialization on the hot path.
 */

const SYNC_SHARE_CODE_KEY = 'xefig:sync:share-code:v1'
const SYNC_UPDATED_AT_KEY = 'xefig:sync:updated-at:v1'
const SYNC_ENABLED_KEY = 'xefig:sync:enabled:v1'
const PROFILE_NAME_KEY = 'xefig:profile-name:v1'

const COMPLETED_RUNS_KEY = 'xefig:puzzles:completed:v1'
const BOARD_COLOR_KEY = 'xefig:board-color:v1'
const ACTIVE_RUN_PREFIX = 'xefig:run:'

let syncEnabled = false
let syncIntervalId = null
let syncStatus = 'idle'
let conflictCallback = null
let pendingConflict = null

// Snapshots for change detection
let lastCompletedJson = null
let lastActiveJson = null
let lastBoardColor = null
let lastProfileName = null

// ─── Helpers ───

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

function gatherActiveRuns() {
  const runs = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(ACTIVE_RUN_PREFIX)) {
      try {
        const val = JSON.parse(localStorage.getItem(key))
        if (val && typeof val === 'object' && !val.completed) {
          runs[key] = val
        }
      } catch {}
    }
  }
  return runs
}

function getPlayerGuid() {
  return localStorage.getItem('xefig:player-guid:v1') || ''
}

function setPlayerGuid(guid) {
  localStorage.setItem('xefig:player-guid:v1', guid)
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function snapshot() {
  lastCompletedJson = JSON.stringify(readJson(COMPLETED_RUNS_KEY) || {})
  lastActiveJson = JSON.stringify(gatherActiveRuns())
  lastBoardColor = localStorage.getItem(BOARD_COLOR_KEY)
  lastProfileName = localStorage.getItem(PROFILE_NAME_KEY)
}

// ─── Apply server data to localStorage ───

function applyServerProfile(data) {
  if (!data || typeof data !== 'object') return

  if (data.settings) {
    if (typeof data.settings.boardColorIndex === 'number') {
      localStorage.setItem(BOARD_COLOR_KEY, String(data.settings.boardColorIndex))
    }
    if (typeof data.settings.profileName === 'string') {
      localStorage.setItem(PROFILE_NAME_KEY, data.settings.profileName)
    }
  }

  if (data.completedRuns && typeof data.completedRuns === 'object') {
    writeJson(COMPLETED_RUNS_KEY, data.completedRuns)
  }

  if (data.activeRuns && typeof data.activeRuns === 'object') {
    // Clear local active runs
    const toRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(ACTIVE_RUN_PREFIX)) toRemove.push(key)
    }
    toRemove.forEach((k) => localStorage.removeItem(k))

    for (const [key, val] of Object.entries(data.activeRuns)) {
      writeJson(key, val)
    }
  }
}

// ─── Build granular push payload ───

function buildPushPayload() {
  const payload = {}
  let hasChanges = false

  // Settings
  const curColor = localStorage.getItem(BOARD_COLOR_KEY)
  const curName = localStorage.getItem(PROFILE_NAME_KEY)
  if (curColor !== lastBoardColor || curName !== lastProfileName) {
    payload.settings = {
      boardColorIndex: Number(curColor) || 0,
      profileName: curName || '',
    }
    hasChanges = true
  }

  // New completed run (find first new/changed entry)
  const curCompleted = readJson(COMPLETED_RUNS_KEY) || {}
  const prevCompleted = lastCompletedJson ? JSON.parse(lastCompletedJson) : {}
  outer: for (const [date, modes] of Object.entries(curCompleted)) {
    if (!modes || typeof modes !== 'object') continue
    for (const [mode, entry] of Object.entries(modes)) {
      const prev = prevCompleted[date]?.[mode]
      if (!prev || JSON.stringify(prev) !== JSON.stringify(entry)) {
        payload.completedRun = {
          puzzleDate: date,
          gameMode: mode,
          difficulty: entry.difficulty || null,
          elapsedActiveMs: entry.elapsedActiveMs || 0,
          bestElapsedMs: entry.bestElapsedMs || entry.elapsedActiveMs || 0,
          completedAt: entry.completedAt || new Date().toISOString(),
        }
        hasChanges = true
        break outer
      }
    }
  }

  // Active run change
  const curActiveJson = JSON.stringify(gatherActiveRuns())
  if (curActiveJson !== lastActiveJson) {
    const activeRuns = JSON.parse(curActiveJson)
    const keys = Object.keys(activeRuns)
    if (keys.length > 0) {
      const key = keys[0]
      const run = activeRuns[key]
      const parts = key.replace('xefig:run:', '').split(':')
      payload.activeRun = {
        puzzleDate: parts[0] || run.puzzleDate,
        gameMode: parts[1] || run.gameMode,
        difficulty: run.difficulty || null,
        imageUrl: run.imageUrl || null,
        elapsedActiveMs: run.elapsedActiveMs || 0,
        puzzleState: run.puzzleState || null,
        updatedAt: run.updatedAt || new Date().toISOString(),
      }
      hasChanges = true
    }
  }

  return hasChanges ? payload : null
}

// ─── Build full profile for force push ───

function buildFullProfile() {
  const completedRuns = readJson(COMPLETED_RUNS_KEY) || {}
  const activeRuns = gatherActiveRuns()
  return {
    settings: {
      profileName: localStorage.getItem(PROFILE_NAME_KEY) || '',
      boardColorIndex: Number(localStorage.getItem(BOARD_COLOR_KEY)) || 0,
    },
    completedRuns,
    activeRuns,
  }
}

// ─── Push / Pull ───

async function maybePushToServer(force = false) {
  if (!syncEnabled) return

  const guid = getPlayerGuid()
  if (!guid) return

  syncStatus = 'syncing'

  try {
    const updatedAt = localStorage.getItem(SYNC_UPDATED_AT_KEY)
    const req = { playerGuid: guid, updatedAt, force }

    if (force) {
      req.fullProfile = buildFullProfile()
    } else {
      const changes = buildPushPayload()
      if (!changes) { syncStatus = 'idle'; return }
      Object.assign(req, changes)
    }

    const result = await apiPost('/api/sync/push', req)

    if (result.conflict) {
      syncStatus = 'conflict'
      pendingConflict = {
        serverData: result.serverData,
        serverUpdatedAt: result.serverUpdatedAt,
      }
      if (conflictCallback) conflictCallback(pendingConflict)
      return
    }

    if (result.ok) {
      localStorage.setItem(SYNC_UPDATED_AT_KEY, result.updatedAt)
      snapshot()
      syncStatus = 'idle'
    } else {
      syncStatus = 'error'
    }
  } catch {
    syncStatus = 'error'
  }
}

async function pullFromServer() {
  const guid = getPlayerGuid()
  if (!guid) return null

  try {
    const result = await apiPost('/api/sync/pull', { playerGuid: guid })
    if (result.notFound) return null
    if (result.settings || result.completedRuns || result.activeRuns) {
      localStorage.setItem(SYNC_UPDATED_AT_KEY, result.updatedAt)
      return result
    }
    return null
  } catch {
    return null
  }
}

// ─── Public API ───

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
}

export function getSyncStatus() {
  return syncStatus
}

export function onConflict(cb) {
  conflictCallback = cb
}

export async function resolveConflict(choice) {
  if (!pendingConflict) return

  if (choice === 'remote') {
    applyServerProfile(pendingConflict.serverData)
    localStorage.setItem(SYNC_UPDATED_AT_KEY, pendingConflict.serverUpdatedAt)
    snapshot()
  } else {
    await maybePushToServer(true)
  }

  pendingConflict = null
  syncStatus = 'idle'
}

export async function enableSync(playerGuid) {
  const result = await apiPost('/api/sync/register', { playerGuid })
  if (result.error) throw new Error(result.error)

  localStorage.setItem(SYNC_ENABLED_KEY, 'true')
  localStorage.setItem(SYNC_SHARE_CODE_KEY, result.shareCode)
  localStorage.setItem(SYNC_UPDATED_AT_KEY, result.updatedAt)
  syncEnabled = true

  await maybePushToServer(true)
  startSyncTimer()

  return result.shareCode
}

export async function linkSync(shareCode) {
  const result = await apiPost('/api/sync/link', { shareCode: shareCode.toUpperCase() })
  if (result.error) throw new Error(result.error)

  setPlayerGuid(result.playerGuid)
  localStorage.setItem(SYNC_ENABLED_KEY, 'true')
  localStorage.setItem(SYNC_SHARE_CODE_KEY, shareCode.toUpperCase())
  localStorage.setItem(SYNC_UPDATED_AT_KEY, result.updatedAt)

  applyServerProfile(result)

  syncEnabled = true
  snapshot()
  startSyncTimer()

  return result
}

export function disableSync() {
  stopSyncTimer()
  syncEnabled = false
  syncStatus = 'idle'
  lastCompletedJson = null
  lastActiveJson = null
  lastBoardColor = null
  lastProfileName = null
  pendingConflict = null
  localStorage.removeItem(SYNC_ENABLED_KEY)
  localStorage.removeItem(SYNC_SHARE_CODE_KEY)
  localStorage.removeItem(SYNC_UPDATED_AT_KEY)
}

export function startSyncTimer() {
  if (syncIntervalId || !syncEnabled) return
  syncIntervalId = setInterval(() => maybePushToServer(), 60_000)
}

export function stopSyncTimer() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId)
    syncIntervalId = null
  }
}

export function onGameExit() {
  if (!syncEnabled) return

  const changes = buildPushPayload()
  if (!changes) return

  const guid = getPlayerGuid()
  if (!guid) return

  const payload = JSON.stringify({
    playerGuid: guid,
    updatedAt: localStorage.getItem(SYNC_UPDATED_AT_KEY),
    force: false,
    ...changes,
  })

  try {
    navigator.sendBeacon('/api/sync/push', new Blob([payload], { type: 'application/json' }))
  } catch {}
}

export async function initSync() {
  syncEnabled = isSyncEnabled()
  if (!syncEnabled) return

  snapshot()

  try {
    const result = await pullFromServer()
    if (result && (result.settings || result.completedRuns || result.activeRuns)) {
      applyServerProfile(result)
      snapshot()
    }
  } catch {}

  startSyncTimer()
}

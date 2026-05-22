// Thin wrapper around greenworks (the Steam SDK binding for nw.js).
//
// Greenworks needs a native rebuild against the Steamworks SDK headers,
// so it's installed as a separate one-time setup step rather than via
// the workspace's normal `npm install`. If it isn't present we degrade
// to a no-op so devs without the SDK can still launch the shell.
//
// The Steam App ID is resolved in this order:
//   1. $STEAM_APP_ID env var (CI / one-off override)
//   2. apps/desktop/steam_appid.local.txt (gitignored — the real ID
//      while the listing is pre-announcement)
//   3. apps/desktop/steam_appid.txt        (committed placeholder, 480)
// 480 is Valve's public SpaceWar app — it works against any Steamworks
// account, so contributors without the real ID can still test the init
// flow. steam_appid.txt is also what Steam itself reads when it loads
// a sideloaded build, so the file has to exist on disk regardless.

const fs = require('fs')
const path = require('path')

const APP_ID_FILE = path.join(__dirname, '..', 'steam_appid.txt')
const APP_ID_LOCAL_FILE = path.join(__dirname, '..', 'steam_appid.local.txt')
const FALLBACK_APP_ID = '480' // SpaceWar — Valve's public placeholder

function readAppId() {
  if (process.env.STEAM_APP_ID && process.env.STEAM_APP_ID.trim()) {
    return process.env.STEAM_APP_ID.trim()
  }
  for (const file of [APP_ID_LOCAL_FILE, APP_ID_FILE]) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim()
      if (raw) return raw
    } catch {
      // file missing — try the next one.
    }
  }
  return FALLBACK_APP_ID
}

// Steam itself only ever looks at steam_appid.txt at the moment
// SteamAPI_Init() runs, so we just (re)write it on every launch from
// whatever the resolution order picked. The file is gitignored — it's
// runtime state, not committed config.
function writeAppIdFile(appId) {
  try {
    fs.writeFileSync(APP_ID_FILE, `${appId}\n`)
  } catch (err) {
    console.warn('[steam] could not write steam_appid.txt', err.message)
  }
}

function tryRequireGreenworks() {
  try {
    return require('greenworks')
  } catch (err) {
    if (process.env.STEAM_DEBUG) {
      console.warn('[steam] greenworks not loadable:', err.message)
    }
    return null
  }
}

function init() {
  const appId = readAppId()
  writeAppIdFile(appId)
  const greenworks = tryRequireGreenworks()

  if (!greenworks) {
    return {
      ok: false,
      degraded: true,
      reason: 'greenworks-not-installed',
      appId,
    }
  }

  try {
    const ok = greenworks.initAPI()
    if (!ok) {
      return {
        ok: false,
        degraded: false,
        reason: 'init-failed',
        appId,
        hint: 'Steam client not running, or steam_appid.txt mismatch.',
      }
    }
    let user = null
    try {
      const id = greenworks.getSteamId()
      user = id?.screenName || id?.steamId || null
    } catch {
      // Older greenworks builds expose this differently — non-fatal.
    }
    return { ok: true, degraded: false, appId, user }
  } catch (err) {
    return {
      ok: false,
      degraded: false,
      reason: 'init-threw',
      appId,
      error: err.message,
    }
  }
}

module.exports = { init, readAppId }

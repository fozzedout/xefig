// Thin wrapper around greenworks (the Steam SDK binding for nw.js).
//
// Greenworks needs a native rebuild against the Steamworks SDK headers,
// so it's installed as a separate one-time setup step rather than via
// the workspace's normal `npm install`. If it isn't present we degrade
// to a no-op so devs without the SDK can still launch the shell.
//
// The Steam App ID is read from steam_appid.txt (Steam's own convention
// for sideloaded development builds) and defaults to 480 (SpaceWar) so
// the integration works against any Steamworks account before a real
// app ID is provisioned.

const fs = require('fs')
const path = require('path')

const APP_ID_FILE = path.join(__dirname, '..', 'steam_appid.txt')
const FALLBACK_APP_ID = '480' // SpaceWar — Valve's public placeholder

function readAppId() {
  try {
    const raw = fs.readFileSync(APP_ID_FILE, 'utf8').trim()
    return raw || FALLBACK_APP_ID
  } catch {
    return FALLBACK_APP_ID
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

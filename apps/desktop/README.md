# xefig-desktop

nw.js wrapper around the existing `apps/web` build, prepared for Steam
distribution. The desktop client bundles the same renderer the web
build uses, plus a Steam SDK bridge (greenworks) for overlay, achievements,
cloud saves, etc.

## Status

- [x] Workspace scaffolded
- [x] nw.js shell loads the web build
- [x] Steam SDK bridge with graceful degradation when greenworks isn't installed
- [ ] Greenworks built against the local Steamworks SDK
- [ ] Offline asset pack (the web build still expects to fetch puzzles from the API)
- [ ] Packaging via `nw-builder` for Win / macOS / Linux distributables
- [ ] Real Steam App ID (currently 480 — SpaceWar — for dev only)

## One-time setup

```sh
# 1. Install workspace deps (downloads nw.js prebuilt for your OS)
npm install

# 2. Extract your Steamworks SDK (NDA — do not commit)
npm run desktop:setup-sdk
# By default this reads the newest steamworks_sdk_*.zip in ~/Downloads.
# Override with: npm --prefix apps/desktop run setup-sdk -- /path/to/sdk.zip

# 3. (Optional, recommended) Install greenworks built against the SDK.
#    Greenworks is kept out of package.json because it needs a native
#    build with platform-specific toolchains:
#      - Windows:  Visual Studio Build Tools + Python 3
#      - macOS:    Xcode CLT
#      - Linux:    build-essential
#    Build steps live in greenworks' own README and depend on the
#    upstream fork you pick. See "Choosing a greenworks fork" below.
```

The shell launches fine without greenworks — Steam features just no-op.

## Daily devloop

```sh
# Build the web bundle and launch nw.js
npm run desktop:dev

# Or, if you've already built the web bundle and just want to relaunch
npm run desktop:start
```

`desktop:dev` rebuilds `apps/web/dist`, copies it into
`apps/desktop/dist-runtime/`, and opens it in an nw.js window. Steam
init runs first; the result is logged to the DevTools console.

## How Steam init works

- `steam_appid.txt` next to this README holds the App ID (`480` for
  dev). Steam reads it directly when a non-launched-by-Steam process
  calls `SteamAPI_Init`.
- `src/steam-bridge.js` requires `greenworks` inside a `try/catch`.
  Missing → returns `{ ok: false, degraded: true }` and logs a warning.
  Present → calls `greenworks.initAPI()` and surfaces success/failure.
- The renderer can re-require `./steam-bridge` later for in-game calls
  (unlocking achievements, opening the overlay, etc.). All entry points
  should tolerate a degraded bridge so non-Steam builds still work.

## Choosing a greenworks fork

The original `greenheartgames/greenworks` repo is unmaintained. The
forks worth evaluating, in rough order of recency:

- `ChromeProfileService/greenworks` — recent SDK 1.5x bumps
- `greenworks-prebuilds` on npm — drops the rebuild step but lags the
  latest SDK
- A fresh fork of upstream with a `binding.gyp` updated for SDK 1.64

For initial integration with SpaceWar (480), any of them work. Pick the
one whose binding matches the SDK version under
`vendor/steamworks-sdk/sdk/`.

## Pointers for later

- **Offline assets** — the web build currently fetches `/api/...`
  endpoints. For the Steam demo the renderer needs to read a bundled
  asset pack instead of hitting the production worker. Likely path:
  ship a `public/offline-puzzles.json` alongside `dist-runtime/` and
  add a runtime flag that picks it over the API.
- **Packaging** — `nw-builder` is the standard way to produce Win/Mac/
  Linux distributables from a single dev machine. Don't introduce it
  until the offline asset story is settled.
- **Real App ID** — once provisioned, edit `steam_appid.txt`. Do NOT
  commit the real ID until you've decided whether the repo is public.
- **Achievements / Cloud / DLC** — drop calls into `steam-bridge.js`
  with a default-false guard so they only fire on a real init.

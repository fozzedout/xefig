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
# Heads-up: nw 0.83.x's postinstall doesn't follow the dl.nwjs.io 302.
# If `node_modules/nw/nwjs/` is missing after install, grab the tarball
# manually with `curl -L https://dl.nwjs.io/v0.83.0/nwjs-v0.83.0-<plat>-<arch>.<ext>`
# into `node_modules/nw/`, then run `node node_modules/nw/lib/install.js`.

# 2. Extract your Steamworks SDK (NDA — do not commit)
npm run desktop:setup-sdk
# Defaults to the newest steamworks_sdk_*.zip in ~/Downloads.
# Override with: npm --prefix apps/desktop run setup-sdk -- /path/to/sdk.zip

# 3. (Optional, recommended) Install greenworks against the SDK.
#    See "Greenworks install" below.
```

The shell launches fine without greenworks — Steam features just no-op
(`steam-bridge` returns `{ ok: false, degraded: true }`).

## Greenworks install

Greenworks is a Steam SDK binding built as a native Node addon. It's
out of `package.json` because the build needs the SDK on disk plus a
working C++ toolchain — neither is true for fresh clones.

### Prereqs (one-time per machine)

| OS      | Install command                                                          |
| ------- | ------------------------------------------------------------------------ |
| Linux (Fedora) | `sudo dnf group install "c-development" && sudo dnf install python3` |
| Linux (Debian) | `sudo apt install build-essential python3`                         |
| macOS   | `xcode-select --install`                                                 |
| Windows | "Desktop development with C++" workload in Visual Studio Build Tools, plus Python 3 from python.org |

`nw-gyp` (the nw.js-flavoured node-gyp) is installed automatically by
the helper script on first run.

### Python 2 (yes, really)

nw-gyp bundles a 2009-era copy of gyp whose scripts use Python 2
`print` statements. Every fork on GitHub still pins semver
`>=2.5.0 <3.0.0` for Python — nobody upstream has done the work to
port the bundled gyp to Python 3. Fedora and current Debian have both
dropped Python 2 entirely, so install it locally via `pyenv`:

```sh
# One-time pyenv install (no sudo)
curl https://pyenv.run | bash
# Follow the printed instructions to add pyenv to your shell rc, then:
exec $SHELL
pyenv install 2.7.18

# Tell the greenworks installer to use it
export PYTHON="$(pyenv root)/versions/2.7.18/bin/python2"
```

You only need this for the greenworks build; the desktop shell itself
has no Python dependency at runtime. The install script bails with the
same `pyenv` instructions if it can't find a Python 2 binary.

### Run the helper

From the repo root:

```sh
npm run desktop:install-greenworks
```

That walks through:

1. Verifies the SDK and toolchain are present.
2. Clones a greenworks fork into `apps/desktop/greenworks/` (default:
   `greenheartgames/greenworks`; pass `--fork <url>` and `--branch`
   to point at a community fork that's been updated for SDK 1.6x).
3. Copies the unzipped SDK into the fork's `deps/steamworks/sdk/`.
4. Runs `nw-gyp configure && nw-gyp build` against the nw.js version
   pinned in `apps/desktop/package.json`.
5. Copies the per-platform shared library (`libsteam_api.so` /
   `steam_api64.dll` / `libsteam_api.dylib`) next to the built `.node`.

After it finishes, symlink the build into `node_modules` so the
bridge's `require('greenworks')` resolves:

```sh
cd apps/desktop
ln -s ../greenworks node_modules/greenworks   # or `mklink /D` on Windows
```

Then re-run `npm run desktop:dev`. The boot status should flip from
"Running without Steam (SDK not installed)" to "Steam ready".

### When the canonical fork won't compile

The upstream `greenheartgames/greenworks` repo lags the Steamworks SDK
by a year or two. If the build fails on missing 1.6x headers, point
the helper at a fresher fork:

```sh
npm run desktop:install-greenworks -- --fork https://github.com/<user>/greenworks.git --branch <branch>
```

Picking a fork is a moving target — verify the fork's binding.gyp
references match the SDK version under `vendor/steamworks-sdk/sdk/`.
Promising signals: recent commits touching `binding.gyp`,
`deps/steamworks/sdk/public/steam/*.h`, and `steam_api_flat.h`.

### What can go wrong

* **`Cannot find module 'nan'`** — fork's `npm install` was skipped or
  failed. `cd apps/desktop/greenworks && npm install --ignore-scripts`
  manually.
* **`fatal error: steam/steam_api.h: No such file or directory`** —
  fork expects the SDK at a different path. Inspect its `binding.gyp`
  for the `include_dirs` entry and re-stage the SDK to match.
* **`undefined symbol: SteamAPI_Init`** at runtime — the redist
  shared lib isn't sitting next to the built `.node` addon. Copy it
  manually from `vendor/steamworks-sdk/sdk/redistributable_bin/`.
* **`Steam_Init returned false`** — almost always a mismatch between
  `steam_appid.txt` and what the running Steam client expects, or the
  Steam client isn't running.

### Why no Steam in CI

The Steamworks SDK is NDA-restricted, so it can't live in CI. The
shell's `steam-bridge` degrades cleanly when greenworks is missing, so
CI builds the app and runs Playwright against the web bundle without
touching Steam at all. Real Steam smoke-tests happen on
contributor laptops or in a self-hosted runner with the SDK mounted.

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

- `src/steam-bridge.js` resolves the App ID in this order on every
  launch:
    1. `$STEAM_APP_ID` env var
    2. `steam_appid.local.txt` next to this README (gitignored — drop
       your real ID here while the listing is pre-announcement)
    3. fallback `480` (Valve's SpaceWar — works against any account
       that has the SDK)
  It then writes the resolved ID to `steam_appid.txt` because that's
  the file Steam itself reads at `SteamAPI_Init` time. The runtime
  `steam_appid.txt` is also gitignored — it's regenerated every boot,
  so neither file should ever land in git.
- `src/steam-bridge.js` requires `greenworks` inside a `try/catch`.
  Missing → returns `{ ok: false, degraded: true }` and logs a warning.
  Present → calls `greenworks.initAPI()` and surfaces success/failure.
- The renderer can re-require `./steam-bridge` later for in-game calls
  (unlocking achievements, opening the overlay, etc.). All entry points
  should tolerate a degraded bridge so non-Steam builds still work.

## Pointers for later

- **Offline assets** — the web build currently fetches `/api/...`
  endpoints. For the Steam demo the renderer needs to read a bundled
  asset pack instead of hitting the production worker. Likely path:
  ship a `public/offline-puzzles.json` alongside `dist-runtime/` and
  add a runtime flag that picks it over the API.
- **Packaging** — `nw-builder` is the standard way to produce Win/Mac/
  Linux distributables from a single dev machine. Don't introduce it
  until the offline asset story is settled.
- **Real App ID** — drop it into `apps/desktop/steam_appid.local.txt`
  (gitignored) so the bridge picks it up at launch. The committed
  pieces stay neutral so the repo doesn't telegraph the ID before the
  Steam listing is announced.
- **Achievements / Cloud / DLC** — drop calls into `steam-bridge.js`
  with a default-false guard so they only fire on a real init.

## Steam-native integration (bridge)

Steam-native ops run in the **boot process** (where `SteamAPI_Init` ran),
not the renderer. The web bundle can't reach `greenworks` directly, so it
POSTs to the embedded server, which forwards to `steam-bridge.js`:

| Bundle call (`notifySteam`) | Server route                  | Bridge op                |
| --------------------------- | ----------------------------- | ------------------------ |
| `presence {text}`           | `POST /api/steam/presence`    | `setRichPresence`        |
| `achievement {id}`          | `POST /api/steam/achievement` | `unlockAchievement`      |
| `leaderboard {name, score}` | `POST /api/steam/leaderboard` | `submitLeaderboardScore` |
| —                           | `GET  /api/steam/status`      | `status` → `{ready,user}`|

Every op no-ops without greenworks (and `notifySteam` is a no-op on the
web / outside shell mode), so all calls are safe fire-and-forget.

**Hooks already wired (bundle, shell mode only):**
- Rich presence: `Solving <Mode>` on puzzle start; `Browsing puzzles` on
  the launcher.
- On completion (`recordCompletedRun`): unlock `complete_<mode>` and — for
  the live daily only (not curated areas) — submit to the `daily_<mode>`
  native leaderboard.

**To activate with a real app, configure in the Steamworks partner site:**
- Achievements `complete_jigsaw`, `complete_sliding`, `complete_swap`,
  `complete_polygram`, `complete_diamond` (extend as needed).
- Leaderboards `daily_jigsaw` … `daily_diamond` (faster is better; score
  is elapsed **seconds**).
- A rich-presence `status` token (or map `steam_display`).

**Leaderboards (two populations).** The unified xefig daily board already
works: the embedded server proxies `/api/leaderboard/*` live to the origin
(desktop shares the website's board), and the Steam screen name is seeded
into the xefig profile name on first launch. The `daily_<mode>` native
Steam leaderboard is the second, in-client population.

**Cloud saves.** Handled by xefig's existing server sync, not Steam Cloud:
the embedded server now proxies `/api/sync/*` live, so enabling sync in
Settings gives cross-device saves via the same mechanism the website uses.
(Steam Auto-Cloud over the nw.js localStorage leveldb is fragile, so it's
intentionally not used.)

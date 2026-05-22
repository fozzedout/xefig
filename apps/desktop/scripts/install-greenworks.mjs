// Build greenworks (the Steam SDK native binding for nw.js) against the
// already-extracted Steamworks SDK under apps/desktop/vendor/steamworks-sdk/
// and the locally-installed nw.js prebuild.
//
// What this script does:
//   1. Verifies the SDK is unzipped and the nw.js prebuild is present.
//   2. Clones a greenworks fork into apps/desktop/greenworks/ (you pick which;
//      see --fork below). The canonical greenheartgames repo is the default
//      but it lags the Steamworks SDK; pick an active community fork if 1.64
//      headers don't compile against it.
//   3. Copies our SDK into the fork's `deps/steamworks/sdk/` so its
//      binding.gyp resolves headers/libs without env-var gymnastics.
//   4. Runs `nw-gyp configure && nw-gyp build` against the nw.js version
//      pinned in apps/desktop/package.json (devDependencies.nw).
//   5. Copies the platform redist (libsteam_api.so / steam_api.dll / .dylib)
//      next to the freshly-built .node addon so greenworks' loader finds it.
//
// What this script does NOT do:
//   * Install build prerequisites — see README.md for sudo commands per OS.
//   * Pick the "right" fork for you. The fork landscape moves; verify the
//     fork compiles against the SDK version under vendor/.
//   * Add greenworks to package.json. It's intentionally out-of-tree so
//     contributors without the SDK aren't blocked by npm install.
//
// Usage:
//   node scripts/install-greenworks.mjs
//   node scripts/install-greenworks.mjs --fork https://github.com/user/greenworks.git
//   node scripts/install-greenworks.mjs --fork ... --branch main

import { execSync, spawnSync } from 'node:child_process'
import { existsSync, cpSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const SDK = join(ROOT, 'vendor', 'steamworks-sdk', 'sdk')
const GW = join(ROOT, 'greenworks')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const FORK = argOf('--fork', 'https://github.com/greenheartgames/greenworks.git')
const BRANCH = argOf('--branch', null)
const NW_VERSION = (PKG.devDependencies?.nw || '').replace(/[^\d.]/g, '') || '0.83.0'

function step(msg) { console.log(`\n=== ${msg} ===`) }
function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

step('Preflight')
if (!existsSync(SDK)) {
  console.error(`Steamworks SDK not found at ${SDK}.`)
  console.error('Run `npm run desktop:setup-sdk` first.')
  process.exit(1)
}
console.log(`SDK at: ${SDK}`)
console.log(`nw.js target version: ${NW_VERSION}`)

const which = (bin) => spawnSync('which', [bin]).status === 0
const missing = ['gcc', 'g++', 'make'].filter((b) => !which(b))
if (missing.length) {
  console.error(`Missing build tools: ${missing.join(', ')}`)
  console.error('Install them via your package manager. See README.md.')
  process.exit(1)
}

// nw-gyp's bundled gyp (from 2009) genuinely requires Python 2. The
// project's never been updated to Python 3 — every fork on GitHub still
// pins semver `>=2.5.0 <3.0.0`. Fedora 44 (and recent Debian/Ubuntu)
// have dropped Python 2 entirely, so contributors typically install it
// via pyenv. Look for the explicit binary first, then fall back to
// `python` (which on legacy systems still means Python 2).
const PYTHON =
  process.env.PYTHON ||
  (which('python2') ? 'python2' : (which('python2.7') ? 'python2.7' : null))

if (!PYTHON) {
  console.error('Python 2.7 not found on PATH and PYTHON env var not set.')
  console.error('nw-gyp\'s bundled gyp scripts use Python 2 print statements,')
  console.error('so Python 3 will not work even with --python.')
  console.error('')
  console.error('Recommended install (no sudo, no system pollution):')
  console.error('  curl https://pyenv.run | bash')
  console.error('  # follow the printed shell-rc setup, then:')
  console.error('  pyenv install 2.7.18')
  console.error('  export PYTHON="$(pyenv root)/versions/2.7.18/bin/python2"')
  console.error('  npm run desktop:install-greenworks')
  process.exit(1)
}
console.log(`Python 2 binary: ${PYTHON}`)

if (!which('nw-gyp')) {
  console.warn('nw-gyp not on PATH — installing it locally (npx will use it).')
  run('npm install --no-save nw-gyp', { cwd: ROOT })
}

step('Clone greenworks fork')
if (existsSync(GW)) {
  console.log(`${GW} already exists. Skipping clone — delete it manually to re-clone.`)
} else {
  const branchArg = BRANCH ? `--branch ${BRANCH}` : ''
  run(`git clone --depth 1 ${branchArg} ${FORK} "${GW}"`)
}

step('Stage SDK into the fork')
// The canonical greenheartgames fork resolves the SDK via
// tools/steamworks_sdk_dir.js, which honours STEAMWORKS_SDK_PATH and
// otherwise looks at deps/steamworks_sdk/ (underscore — not the
// `deps/steamworks/sdk/` path some readmes claim). Stage the SDK there
// and the binding.gyp include_dirs entry `<(steamworks_sdk_dir)/public`
// resolves cleanly. Other forks may need editing here.
const SDK_DEST = join(GW, 'deps', 'steamworks_sdk')
if (existsSync(SDK_DEST)) rmSync(SDK_DEST, { recursive: true, force: true })
cpSync(SDK, SDK_DEST, { recursive: true })
console.log(`SDK -> ${SDK_DEST}`)

step('Install greenworks fork deps')
run('npm install --no-audit --no-fund --ignore-scripts', { cwd: GW })

step(`Build with nw-gyp (target nw ${NW_VERSION}, python=${PYTHON})`)
const arch = process.arch
// --target has to be passed to BOTH configure and build — nw-gyp's build
// step rereads it to populate release.version (otherwise the semver.gt
// check at lib/build.js:64 explodes on Invalid Version: undefined).
run(`npx nw-gyp configure --target=${NW_VERSION} --arch=${arch} --python="${PYTHON}"`, { cwd: GW })
run(`npx nw-gyp build --target=${NW_VERSION}`, { cwd: GW, env: { ...process.env, PYTHON } })

step('Stage Steam redist next to the built addon')
const builtNode = join(GW, 'build', 'Release')
if (!existsSync(builtNode)) {
  console.error(`Expected build output at ${builtNode}. nw-gyp build silently produced nothing?`)
  process.exit(1)
}
// Copy the per-platform shared library so greenworks' runtime loader finds it.
const REDIST = join(SDK, 'redistributable_bin')
const platformLib = {
  linux: { src: join(REDIST, process.arch === 'arm64' ? 'linuxarm64' : 'linux64', 'libsteam_api.so'), dest: 'libsteam_api.so' },
  darwin: { src: join(REDIST, 'osx', 'libsteam_api.dylib'), dest: 'libsteam_api.dylib' },
  win32: { src: join(REDIST, 'win64', 'steam_api64.dll'), dest: 'steam_api64.dll' },
}[process.platform]
if (platformLib && existsSync(platformLib.src)) {
  cpSync(platformLib.src, join(builtNode, platformLib.dest))
  console.log(`Copied ${platformLib.dest} -> ${builtNode}`)
} else {
  console.warn(`No redist found for ${process.platform}/${process.arch} at ${platformLib?.src}`)
}

step('Done')
console.log(`Greenworks built at ${GW}`)
console.log('The desktop bridge requires `greenworks`; add a symlink so its require() resolves:')
console.log(`  ln -s ../../greenworks node_modules/greenworks   # from apps/desktop`)
console.log('Then re-run `npm run desktop:dev` and watch the boot status flip to "Steam ready".')

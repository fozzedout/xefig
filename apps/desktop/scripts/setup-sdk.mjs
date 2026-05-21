// Unzip the Steamworks SDK into apps/desktop/vendor/steamworks-sdk/.
// The SDK is NDA-restricted, so the contents are .gitignored — each
// developer pulls their own copy from
// https://partner.steamgames.com/downloads/list and runs this script.
//
// Usage:
//   npm run setup-sdk                      # defaults to ~/Downloads/steamworks_sdk_*.zip
//   npm run setup-sdk -- /path/to/sdk.zip  # explicit path
//
// After running, the SDK tree lives at apps/desktop/vendor/steamworks-sdk/sdk/,
// which is the path layout the greenworks build expects (and the env var
// `STEAM_SDK_PATH` should point to).

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(here, '..', 'vendor', 'steamworks-sdk')

function pickDefaultZip() {
  const downloads = join(homedir(), 'Downloads')
  if (!existsSync(downloads)) return null
  const matches = readdirSync(downloads)
    .filter((f) => /^steamworks_sdk.*\.zip$/i.test(f))
    .sort()
    .reverse() // newest by lexicographic suffix
  return matches.length ? join(downloads, matches[0]) : null
}

const explicit = process.argv[2]
const zipPath = explicit || pickDefaultZip()

if (!zipPath) {
  console.error('No SDK zip path provided and none found under ~/Downloads.')
  console.error('Usage: npm run setup-sdk -- /path/to/steamworks_sdk_NNN.zip')
  process.exit(1)
}

if (!existsSync(zipPath)) {
  console.error(`SDK zip not found: ${zipPath}`)
  process.exit(1)
}

mkdirSync(VENDOR, { recursive: true })
console.log(`Unzipping ${zipPath} -> ${VENDOR}`)

try {
  // -o overwrite, -q quiet. Falls back to PowerShell on Windows if `unzip`
  // isn't available (common — Windows 10+ has tar but not unzip).
  if (process.platform === 'win32') {
    execSync(`powershell -NoLogo -NoProfile -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${VENDOR}'"`, {
      stdio: 'inherit',
    })
  } else {
    execSync(`unzip -oq "${zipPath}" -d "${VENDOR}"`, { stdio: 'inherit' })
  }
} catch (err) {
  console.error('Failed to unzip:', err.message)
  process.exit(1)
}

const sdkDir = join(VENDOR, 'sdk')
if (existsSync(sdkDir)) {
  console.log('SDK extracted to:', sdkDir)
  console.log('')
  console.log('Next step: install greenworks against this SDK. See apps/desktop/README.md.')
} else {
  console.warn('Warning: expected', sdkDir, 'to exist after extraction. Inspect the zip layout.')
}

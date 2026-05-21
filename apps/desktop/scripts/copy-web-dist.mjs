// Copy the freshly-built apps/web/dist/ tree into apps/desktop/dist-runtime/
// so nw.js can load it via file://. Kept as a separate script rather than
// a cp shell command so the path handling works the same on Windows.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', '..', 'web', 'dist')
const DEST = join(here, '..', 'dist-runtime')

if (!existsSync(SRC)) {
  console.error(`apps/web/dist not found at ${SRC}. Run \`npm --prefix apps/web run build\` first.`)
  process.exit(1)
}

if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
cpSync(SRC, DEST, { recursive: true })
console.log(`Copied apps/web/dist -> apps/desktop/dist-runtime`)

// nw.js entry — runs in the Chromium context with Node integration on.
// Initialise Steam first (greenworks if available, no-op otherwise) so
// the overlay hooks into the window before the game's renderer starts;
// then hand control to the bundled web build.

const path = require('path')
const steam = require('./steam-bridge')

const status = (msg) => {
  const el = document.getElementById('boot-status')
  if (el) el.textContent = msg
  console.log('[boot]', msg)
}

async function boot() {
  status('Connecting to Steam...')
  const steamResult = steam.init()
  if (steamResult.ok) {
    status(`Steam ready (user: ${steamResult.user || 'unknown'})`)
  } else if (steamResult.degraded) {
    status('Running without Steam (SDK not installed)')
  } else {
    status('Steam not detected — starting in offline mode')
  }

  // E2E hook: when XEFIG_E2E_LOG points at a writable path, dump the boot
  // result there so headless launchers can verify init without screenshots.
  if (process.env.XEFIG_E2E_LOG) {
    try {
      require('fs').writeFileSync(process.env.XEFIG_E2E_LOG, JSON.stringify({
        bootedAt: new Date().toISOString(),
        steam: steamResult,
      }, null, 2))
    } catch (err) {
      console.warn('[boot] could not write E2E log:', err.message)
    }
  }

  // Brief delay so the status line is visible during cold start; remove
  // once the boot screen has an actual loading animation worth seeing.
  await new Promise((r) => setTimeout(r, 250))

  // Hand off to the bundled web app. We swap the entire document via
  // location rather than embedding in an iframe — same-origin postMessage
  // bridges are noisy and the web app already expects to own the page.
  const dist = path.join(__dirname, '..', 'dist-runtime', 'index.html')
  window.location.href = `file://${dist}`
}

window.addEventListener('error', (e) => {
  console.error('[boot] unhandled error', e.error || e.message)
})

boot().catch((err) => {
  console.error('[boot] failed', err)
  status(`Boot failed: ${err.message}`)
})

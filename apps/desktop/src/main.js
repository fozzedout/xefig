// nw.js entry — runs in the Chromium context with Node integration on.
// Initialise Steam, then spin up a localhost HTTP server backed by the
// offline pack, then navigate the window to it. We can't load the web
// build via file:// because service workers refuse to register on that
// scheme and the bundle wedges on its "Loading..." overlay.
//
// Note on `__dirname`: it is NOT defined in scripts loaded via plain
// <script src="…"> tags in nw.js. CommonJS module variables only exist
// inside files that `require()` loaded. The helpers below (steam-bridge,
// server) are require()'d so they can use __dirname normally.

const steam = require('./steam-bridge')
const server = require('./server')

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

  status('Starting local server...')
  const { url, port } = await server.start()
  console.log('[boot] serving offline pack at', url)

  // Brief delay so the status line is visible during cold start; remove
  // once the boot screen has an actual loading animation worth seeing.
  await new Promise((r) => setTimeout(r, 250))

  status(`Loading game (port ${port})...`)
  // Hand off to the bundled web app via http://127.0.0.1:<port>/ so the
  // bundle's relative /api/* fetches and service worker registration
  // both resolve against a real same-origin server.
  //
  // Demo timing harness: when XEFIG_DEMO_HARNESS=1 in the env, land on
  // the 15-button difficulty matrix instead of the normal launcher.
  // Each button on the harness navigates to /?demo=area-mode which
  // main.js then resolves to a specific puzzle + overrides.
  const landing = process.env.XEFIG_DEMO_HARNESS ? `${url}demo-harness` : url
  window.location.href = landing
}

window.addEventListener('error', (e) => {
  console.error('[boot] unhandled error', e.error || e.message)
})

boot().catch((err) => {
  console.error('[boot] failed', err)
  status(`Boot failed: ${err.message}`)
})

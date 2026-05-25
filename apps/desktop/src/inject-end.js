// Runs in every loaded page after DOM ready (configured via
// package.json -> window.inject_js_end).
//
// The launcher in apps/web is deliberately conservative about loading
// the full-res slice images: it shows thumbnails as the <img src> and
// only swaps to the full URL if it finds a hit in the service-worker
// Cache Storage — which on the web means "the player has already
// played that mode and warmed the cache".
//
// In the offline desktop build the full images are always local and
// already on disk, so the lazy-load gives a worse menu (thumb-only
// previews) for no upside. This shim unconditionally upgrades the
// <img src> to the value of data-full-url as soon as the slice
// elements appear in the DOM. MutationObserver waits because the
// launcher renders slices async after fetching /api/puzzles/today.

(function upgradeSliceImagesShim() {
  // Once-per-img guard: tag the element after we've upgraded its src.
  // img.src always returns an absolute URL (resolved against document
  // origin) so a naive `img.src !== dataset.fullUrl` check is always
  // true and re-fires the assignment on every DOM mutation — which
  // burns network round-trips during e.g. paint canvas redraws. The
  // data-* tag is read straight back so it's a real fixed-cost check.
  function upgrade() {
    const imgs = document.querySelectorAll('img.slice-image[data-full-url]:not([data-demo-upgraded])')
    let n = 0
    for (const img of imgs) {
      const full = img.dataset.fullUrl
      if (full) {
        img.src = full
        img.dataset.demoUpgraded = '1'
        n++
      }
    }
    return n
  }

  // Run once now in case slices were already rendered before this
  // script reached the document.
  if (upgrade() > 0) return

  // Otherwise watch for the launcher to render them. Disconnect after
  // the first successful upgrade — the bundle re-renders the slice
  // container in place (innerHTML reset) when the launcher rebuilds,
  // and any new <img> won't carry the data-demo-upgraded tag, so a
  // fresh observer attaches on each launcher render below.
  const observer = new MutationObserver(() => { upgrade() })
  observer.observe(document.documentElement, { childList: true, subtree: true })
})()

// Persistent "back to the world hub" affordance. The nw.js shell has no
// address bar, so a player who enters the Online tier (the normal app,
// reached from the hub's lighthouse) would otherwise have no click-path
// back to /hub — the only recovery would be quitting and relaunching.
//
// Show a small fixed control whenever the normal launcher is on screen
// AND we're not inside a demo session (demo-session launchers bounce to
// their own return target on their own — see the back-loop in
// apps/web/src/main.js). Gating on the .slice-launcher marker keeps the
// button off the hub/harness/boot pages and off active puzzle screens,
// where it would clutter or be hit by accident.
//
// Leading semicolon: the IIFE above ends in `})()` without a trailing
// semicolon, so without this the two are parsed as one call expression
// (`firstIIFE()(secondIIFE)`) and the whole script throws.
;(function hubReturnShim() {
  let btn = null

  function ensureBtn() {
    if (btn) return btn
    btn = document.createElement('button')
    btn.textContent = '⌂ Worlds'
    btn.setAttribute('aria-label', 'Back to world hub')
    Object.assign(btn.style, {
      position: 'fixed', left: '12px', top: '12px', zIndex: '2147483647',
      padding: '0.4rem 0.8rem', borderRadius: '999px', border: '1px solid rgba(255,255,255,0.18)',
      background: 'rgba(10,10,15,0.72)', color: '#f0f0f4', font: '600 0.82rem system-ui, sans-serif',
      cursor: 'pointer', backdropFilter: 'blur(6px)', display: 'none',
    })
    btn.addEventListener('click', () => { window.location.href = '/hub' })
    document.body.appendChild(btn)
    return btn
  }

  function sync() {
    const inLauncher = !!document.querySelector('.slice-launcher')
    // The desktop shell-mode launcher carries its own persistent map rail,
    // which is the navigation + way home — so this fallback button is
    // redundant there and would just clutter the corner.
    const hasRail = !!document.querySelector('.map-rail')
    let demoSession = false
    try { demoSession = sessionStorage.getItem('xefig:demo-session') === '1' } catch { /* unavailable */ }
    const show = inLauncher && !demoSession && !hasRail
    if (show) ensureBtn().style.display = 'block'
    else if (btn) btn.style.display = 'none'
  }

  sync()
  new MutationObserver(sync).observe(document.documentElement, { childList: true, subtree: true })
})()

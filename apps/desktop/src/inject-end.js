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

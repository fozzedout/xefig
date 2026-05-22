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
  function upgrade() {
    const imgs = document.querySelectorAll('img.slice-image[data-full-url]')
    let n = 0
    for (const img of imgs) {
      const full = img.dataset.fullUrl
      if (full && img.src !== full) {
        img.src = full
        n++
      }
    }
    return n
  }

  // Run once now in case slices were already rendered before this
  // script reached the document.
  if (upgrade() > 0) return

  // Otherwise watch for the launcher to render them. The launcher
  // re-renders on date change, mode focus, etc., so we let the
  // observer run for the lifetime of the page rather than disconnecting
  // after the first hit.
  const observer = new MutationObserver(() => { upgrade() })
  observer.observe(document.documentElement, { childList: true, subtree: true })
})()

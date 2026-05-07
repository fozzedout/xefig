// Network-aware loader for puzzle images.
//
// Background: a 27%-loss / 1.2 s-RTT cellular link can take 16+ s to deliver a
// 400 KB jigsaw image. The previous 8 s timeout aborted long before the bytes
// arrived, leaving the puzzle UI blank with no visible feedback. This loader:
//   1. Allows up to DEFAULT_IMAGE_LOAD_TIMEOUT_MS for the whole transfer.
//   2. Streams the response body so callers can render a progress bar.
//   3. Falls back to a native <img> request when fetch() fails outright,
//      since some captive-portal proxies tamper with fetch but not <img>.
//   4. Honors an external AbortSignal so the UI can cancel a stalled load.
//
// Retries are intentionally NOT automatic — auto-retry on a contended uplink
// just multiplies the bandwidth waste. The UI shows a Retry button instead;
// the user knows when their connection is alive.

const DEFAULT_IMAGE_LOAD_TIMEOUT_MS = 60000

export async function loadImage(url, {
  timeoutMs = DEFAULT_IMAGE_LOAD_TIMEOUT_MS,
  onProgress,
  signal,
} = {}) {
  try {
    return await loadImageFromResponse(url, timeoutMs, onProgress, signal)
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'fallback' })
    }
    return loadImageDirect(url, timeoutMs, error, signal)
  }
}

// Try the thumbnail first (usually already cached from menu rendering)
// so the puzzle can become playable immediately, then upgrade to the
// full image in the background. Returns { image, isThumbnail }. Falls
// straight through to the full image when no thumb URL is provided or
// the thumb load fails — the caller still gets an image (or rejects).
export async function loadImageThumbFirst(thumbnailUrl, imageUrl, options = {}) {
  if (thumbnailUrl && thumbnailUrl !== imageUrl) {
    try {
      const image = await loadImage(thumbnailUrl, options)
      return { image, isThumbnail: true }
    } catch {
      // Thumb missed (no cache + bad network). Fall through to full.
    }
  }
  const image = await loadImage(imageUrl, options)
  return { image, isThumbnail: false }
}

export function releaseLoadedImage(image) {
  const objectUrl = image?.__xefigObjectUrl
  if (!objectUrl) return
  URL.revokeObjectURL(objectUrl)
  delete image.__xefigObjectUrl
}

async function loadImageFromResponse(url, timeoutMs, onProgress, externalSignal) {
  let blob
  try {
    blob = await fetchImageBlobWithProgress(url, timeoutMs, onProgress, externalSignal)
  } catch (error) {
    const cached = await matchCachedImage(url)
    if (cached) {
      if (typeof onProgress === 'function') {
        onProgress({ phase: 'cached' })
      }
      blob = await cached.blob()
    } else {
      throw normalizeImageError(url, error)
    }
  }

  if (typeof onProgress === 'function') {
    onProgress({ phase: 'decoding' })
  }
  return decodeImageBlob(blob, url)
}

async function fetchImageBlobWithProgress(url, timeoutMs, onProgress, externalSignal) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(new DOMException('Timeout', 'AbortError')), timeoutMs)
    : null
  const onExternalAbort = controller && externalSignal
    ? () => controller.abort(externalSignal.reason)
    : null
  if (onExternalAbort) {
    if (externalSignal.aborted) {
      onExternalAbort()
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: controller?.signal,
    })
    if (!response.ok) {
      throw new Error(`Failed to load image: ${url} (HTTP ${response.status})`)
    }

    const total = Number(response.headers.get('content-length')) || 0
    if (typeof onProgress === 'function') {
      onProgress({ phase: 'downloading', loaded: 0, total })
    }

    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null

    if (!reader) {
      const blob = await response.blob()
      if (typeof onProgress === 'function') {
        onProgress({ phase: 'downloading', loaded: blob.size, total: blob.size })
      }
      return blob
    }

    const chunks = []
    let loaded = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.byteLength
      if (typeof onProgress === 'function') {
        onProgress({ phase: 'downloading', loaded, total })
      }
    }

    const contentType = response.headers.get('content-type') || 'image/webp'
    return new Blob(chunks, { type: contentType })
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
    if (onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort)
    }
  }
}

async function matchCachedImage(url) {
  if (typeof caches === 'undefined') {
    return null
  }

  const absoluteUrl = new URL(url, window.location.href)
  const stableUrl = new URL(absoluteUrl.toString())
  stableUrl.search = ''

  return (
    await caches.match(absoluteUrl.toString())
    || await caches.match(stableUrl.toString())
    || await caches.match(absoluteUrl.pathname + absoluteUrl.search)
    || await caches.match(absoluteUrl.pathname)
    || null
  )
}

function decodeImageBlob(blob, url) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      image.__xefigObjectUrl = objectUrl
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error(`Failed to decode image: ${url}`))
    }
    image.src = objectUrl
  })
}

function loadImageDirect(url, timeoutMs, originalError, externalSignal) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(normalizeImageError(url, originalError))
    }, timeoutMs)
    const onAbort = externalSignal
      ? () => {
          cleanup()
          reject(externalSignal.reason || new DOMException('Aborted', 'AbortError'))
        }
      : null

    const cleanup = () => {
      image.onload = null
      image.onerror = null
      window.clearTimeout(timeoutId)
      if (onAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onAbort)
      }
    }

    if (onAbort) {
      if (externalSignal.aborted) {
        onAbort()
        return
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
    }

    image.onload = () => {
      cleanup()
      resolve(image)
    }
    image.onerror = () => {
      cleanup()
      reject(new Error(`Failed to load image: ${url}`))
    }
    image.src = url
  })
}

function normalizeImageError(url, error) {
  if (error?.name === 'AbortError') {
    return new Error(`Timed out loading image: ${url}`)
  }
  return error instanceof Error ? error : new Error(`Failed to load image: ${url}`)
}

const DEFAULT_IMAGE_LOAD_TIMEOUT_MS = 8000

export async function loadImage(url, { timeoutMs = DEFAULT_IMAGE_LOAD_TIMEOUT_MS } = {}) {
  try {
    return await loadImageFromResponse(url, timeoutMs)
  } catch (error) {
    return loadImageDirect(url, timeoutMs, error)
  }
}

export function releaseLoadedImage(image) {
  const objectUrl = image?.__xefigObjectUrl
  if (!objectUrl) return
  URL.revokeObjectURL(objectUrl)
  delete image.__xefigObjectUrl
}

async function loadImageFromResponse(url, timeoutMs) {
  const response = await fetchImageResponse(url, timeoutMs)
  const blob = await response.blob()
  return decodeImageBlob(blob, url)
}

async function fetchImageResponse(url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      signal: controller?.signal,
    })
    if (!response.ok) {
      throw new Error(`Failed to load image: ${url}`)
    }
    return response
  } catch (error) {
    const cached = await matchCachedImage(url)
    if (cached) {
      return cached
    }
    throw normalizeImageError(url, error)
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
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

function loadImageDirect(url, timeoutMs, originalError) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(normalizeImageError(url, originalError))
    }, timeoutMs)

    const cleanup = () => {
      image.onload = null
      image.onerror = null
      window.clearTimeout(timeoutId)
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

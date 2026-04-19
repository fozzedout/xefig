import UPNG from 'upng-js'
import jpeg from 'jpeg-js'

const JPEG_QUALITY = 80
const THUMBNAIL_WIDTH = 400

type RgbaImage = {
  width: number
  height: number
  data: Uint8Array
}

function decodePng(pngBytes: Uint8Array): RgbaImage {
  const decoded = UPNG.decode(pngBytes.buffer)
  return {
    width: decoded.width,
    height: decoded.height,
    data: new Uint8Array(UPNG.toRGBA8(decoded)[0]),
  }
}

function decodeJpeg(jpegBytes: Uint8Array): RgbaImage {
  const decoded = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: true })
  return {
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
  }
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
}

function decodeImage(bytes: Uint8Array): RgbaImage {
  if (isPng(bytes)) return decodePng(bytes)
  if (isJpeg(bytes)) return decodeJpeg(bytes)
  throw new Error(`Unsupported image format (magic: 0x${bytes[0]?.toString(16)}${bytes[1]?.toString(16)})`)
}

function encodeJpeg(image: RgbaImage): Uint8Array {
  const encoded = jpeg.encode(
    { data: image.data, width: image.width, height: image.height },
    JPEG_QUALITY,
  )
  return new Uint8Array(encoded.data)
}

function resize(src: RgbaImage, targetWidth: number): RgbaImage {
  const scale = targetWidth / src.width
  const targetHeight = Math.round(src.height * scale)

  if (targetWidth >= src.width) {
    return src
  }

  const dst = new Uint8Array(targetWidth * targetHeight * 4)

  for (let y = 0; y < targetHeight; y++) {
    const srcY = (y / targetHeight) * src.height
    const y0 = Math.floor(srcY)
    const y1 = Math.min(y0 + 1, src.height - 1)
    const fy = srcY - y0

    for (let x = 0; x < targetWidth; x++) {
      const srcX = (x / targetWidth) * src.width
      const x0 = Math.floor(srcX)
      const x1 = Math.min(x0 + 1, src.width - 1)
      const fx = srcX - x0

      const dstIdx = (y * targetWidth + x) * 4

      for (let c = 0; c < 4; c++) {
        const tl = src.data[(y0 * src.width + x0) * 4 + c]
        const tr = src.data[(y0 * src.width + x1) * 4 + c]
        const bl = src.data[(y1 * src.width + x0) * 4 + c]
        const br = src.data[(y1 * src.width + x1) * 4 + c]

        const top = tl + (tr - tl) * fx
        const bottom = bl + (br - bl) * fx
        dst[dstIdx + c] = Math.round(top + (bottom - top) * fy)
      }
    }
  }

  return { width: targetWidth, height: targetHeight, data: dst }
}

export type ProcessedImage = {
  jpeg: Uint8Array
  thumbnail: Uint8Array
}

export function processPngImage(pngBytes: Uint8Array): ProcessedImage {
  const rgba = decodeImage(pngBytes)
  const jpegBytes = encodeJpeg(rgba)
  const thumb = resize(rgba, THUMBNAIL_WIDTH)
  const thumbnailBytes = encodeJpeg(thumb)

  return {
    jpeg: jpegBytes,
    thumbnail: thumbnailBytes,
  }
}

// ---------------------------------------------------------------------------
// Border detection
//
// Flags an edge when its outer strip is ~uniform in colour AND differs
// significantly from the strip just inside it. That distinguishes a
// genuine defect border (solid frame, paper margin, vignette) from a
// legitimate uniform background that continues into the composition.
// ---------------------------------------------------------------------------

export type BorderEdge = 'top' | 'bottom' | 'left' | 'right'

export type BorderDetection = {
  hasBorder: boolean
  flaggedEdges: BorderEdge[]
  edges: {
    edge: BorderEdge
    outerMean: [number, number, number]
    outerStd: number
    innerMean: [number, number, number]
    meanDistance: number
    flagged: boolean
  }[]
}

export type BorderDetectionOptions = {
  // Strip thickness as a fraction of min(width, height).
  stripRatio?: number
  // Per-channel std below this means the strip is considered uniform.
  uniformStdMax?: number
  // Euclidean RGB distance between outer and inner means above which
  // the two bands are considered visibly different. Used together with
  // the uniformity check — catches solid coloured frames.
  meanDistanceMin?: number
  // Stronger distance threshold that flags an edge regardless of outer
  // strip uniformity — catches textured frames (e.g. a thin dark line
  // plus a cream paper margin) where the outer band itself has high std
  // but is clearly a different region from the picture content.
  meanDistanceLarge?: number
  // Number of edges that must flag before we call the image bordered.
  // Borders almost always span multiple edges; raising this to 2 keeps a
  // single naturally high-contrast edge (e.g. a horizon line) from
  // tripping a false positive.
  minFlaggedEdges?: number
}

const DEFAULTS: Required<BorderDetectionOptions> = {
  stripRatio: 0.02,
  uniformStdMax: 5,
  meanDistanceMin: 20,
  meanDistanceLarge: 60,
  minFlaggedEdges: 2,
}

function stripBounds(width: number, height: number, edge: BorderEdge, depth: number, outer: boolean) {
  switch (edge) {
    case 'top':
      return outer
        ? { x0: 0, y0: 0, x1: width, y1: depth }
        : { x0: 0, y0: depth, x1: width, y1: depth * 2 }
    case 'bottom':
      return outer
        ? { x0: 0, y0: height - depth, x1: width, y1: height }
        : { x0: 0, y0: height - depth * 2, x1: width, y1: height - depth }
    case 'left':
      return outer
        ? { x0: 0, y0: 0, x1: depth, y1: height }
        : { x0: depth, y0: 0, x1: depth * 2, y1: height }
    case 'right':
      return outer
        ? { x0: width - depth, y0: 0, x1: width, y1: height }
        : { x0: width - depth * 2, y0: 0, x1: width - depth, y1: height }
  }
}

function stripStats(rgba: RgbaImage, edge: BorderEdge, outer: boolean, depth: number) {
  const { x0, y0, x1, y1 } = stripBounds(rgba.width, rgba.height, edge, depth, outer)
  let sr = 0, sg = 0, sb = 0, count = 0
  for (let y = y0; y < y1; y++) {
    const row = y * rgba.width
    for (let x = x0; x < x1; x++) {
      const i = (row + x) * 4
      sr += rgba.data[i]
      sg += rgba.data[i + 1]
      sb += rgba.data[i + 2]
      count++
    }
  }
  const mean: [number, number, number] = [sr / count, sg / count, sb / count]
  let vr = 0, vg = 0, vb = 0
  for (let y = y0; y < y1; y++) {
    const row = y * rgba.width
    for (let x = x0; x < x1; x++) {
      const i = (row + x) * 4
      vr += (rgba.data[i] - mean[0]) ** 2
      vg += (rgba.data[i + 1] - mean[1]) ** 2
      vb += (rgba.data[i + 2] - mean[2]) ** 2
    }
  }
  const std = Math.sqrt((vr + vg + vb) / (count * 3))
  return { mean, std }
}

function rgbDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

export function detectBorder(imageBytes: Uint8Array, opts: BorderDetectionOptions = {}): BorderDetection {
  const { stripRatio, uniformStdMax, meanDistanceMin, meanDistanceLarge, minFlaggedEdges } =
    { ...DEFAULTS, ...opts }
  const rgba = decodeImage(imageBytes)
  const depth = Math.max(1, Math.round(Math.min(rgba.width, rgba.height) * stripRatio))

  const edges: BorderEdge[] = ['top', 'bottom', 'left', 'right']
  const results = edges.map((edge) => {
    const outer = stripStats(rgba, edge, true, depth)
    const inner = stripStats(rgba, edge, false, depth)
    const meanDistance = rgbDistance(outer.mean, inner.mean)
    // Either signal is enough: a uniform outer band that's noticeably
    // different from the inner band (solid frame), OR a very large
    // outer/inner mean gap regardless of texture (a textured frame —
    // paper margin, woodcut border, etc. — still produces a sharp
    // colour discontinuity at the picture's edge).
    const flagged =
      (outer.std < uniformStdMax && meanDistance > meanDistanceMin) ||
      meanDistance > meanDistanceLarge
    return {
      edge,
      outerMean: outer.mean,
      outerStd: outer.std,
      innerMean: inner.mean,
      meanDistance,
      flagged,
    }
  })

  const flaggedEdges = results.filter((r) => r.flagged).map((r) => r.edge)
  return {
    hasBorder: flaggedEdges.length >= minFlaggedEdges,
    flaggedEdges,
    edges: results,
  }
}

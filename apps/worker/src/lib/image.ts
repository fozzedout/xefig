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

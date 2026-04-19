import type { PuzzleCategory } from '../types'

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image-preview'

// ---------------------------------------------------------------------------
// Batch job types
// ---------------------------------------------------------------------------

export type BatchRequest = {
  category: PuzzleCategory
  prompt: string
}

type BatchInlineRequest = {
  request: {
    contents: Array<{ parts: Array<{ text: string }> }>
    generationConfig: {
      responseModalities: string[]
      imageConfig?: { imageSize?: string; aspectRatio?: string }
    }
  }
  metadata: { key: string }
}

// Gemini batch API nests job state and results inside a `metadata` wrapper.
// The actual state uses BATCH_STATE_* prefixes.
type BatchJobRawResponse = {
  name: string
  metadata?: {
    state?: string
    batchStats?: {
      requestCount?: string
      pendingRequestCount?: string
      succeededRequestCount?: string
      failedRequestCount?: string
    }
    error?: { message: string }
    // Results appear here when the job completes
    responses?: Array<{
      response?: {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { mimeType: string; data: string }
              text?: string
            }>
          }
        }>
      }
      metadata?: { key: string }
    }>
  }
  // Some API versions may put responses at top-level dest
  dest?: {
    inlinedResponses?: Array<{
      response?: {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { mimeType: string; data: string }
              text?: string
            }>
          }
        }>
      }
      metadata?: { key: string }
    }>
  }
  error?: { message: string }
}

export type BatchImageResult = {
  category: PuzzleCategory
  imageBytes: Uint8Array
  mimeType: string
}

// ---------------------------------------------------------------------------
// Submit a batch job with multiple image generation requests
// ---------------------------------------------------------------------------

export async function submitImageBatch(
  apiKey: string,
  requests: BatchRequest[],
): Promise<{ batchName: string }> {
  const url = `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:batchGenerateContent?key=${apiKey}`

  const inlineRequests: BatchInlineRequest[] = requests.map((r) => ({
    request: {
      contents: [{ parts: [{ text: r.prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          imageSize: r.category === 'diamond' ? '512' : '2K',
          aspectRatio: '4:3',
        },
      },
    },
    metadata: { key: r.category },
  }))

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batch: {
        display_name: `xefig-daily-puzzles-${new Date().toISOString().slice(0, 10)}`,
        input_config: {
          requests: { requests: inlineRequests },
        },
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini batch submit error ${response.status}: ${body}`)
  }

  const result = (await response.json()) as BatchJobRawResponse
  const name = result.name ?? result.metadata?.name
  if (!name) {
    throw new Error('Gemini batch submit returned no job name')
  }

  return { batchName: name }
}

// ---------------------------------------------------------------------------
// Check batch job status and retrieve results if complete
// ---------------------------------------------------------------------------

export type BatchPollResult =
  | { state: 'pending' | 'running'; stats?: Record<string, string>; rawResponse?: unknown }
  | { state: 'succeeded'; images: BatchImageResult[]; rawResponse?: unknown }
  | { state: 'failed'; error: string; rawResponse?: unknown }
  | { state: 'unknown'; error: string; rawResponse?: unknown }

export async function pollImageBatch(
  apiKey: string,
  batchName: string,
): Promise<BatchPollResult> {
  const url = `${GEMINI_API_BASE}/${batchName}?key=${apiKey}`

  const response = await fetch(url)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini batch poll error ${response.status}: ${body}`)
  }

  const raw = (await response.json()) as BatchJobRawResponse

  // State lives inside metadata.state with BATCH_STATE_* prefix
  const state = raw.metadata?.state

  if (state === 'BATCH_STATE_PENDING' || state === 'BATCH_STATE_QUEUED') {
    return { state: 'pending', stats: raw.metadata?.batchStats as Record<string, string> }
  }

  if (state === 'BATCH_STATE_RUNNING' || state === 'BATCH_STATE_PROCESSING') {
    return { state: 'running', stats: raw.metadata?.batchStats as Record<string, string> }
  }

  if (state === 'BATCH_STATE_FAILED' || state === 'BATCH_STATE_CANCELLED' || state === 'BATCH_STATE_EXPIRED') {
    const errorMsg = raw.metadata?.error?.message ?? raw.error?.message ?? `Batch ${state}`
    return { state: 'failed', error: errorMsg }
  }

  if (state === 'BATCH_STATE_SUCCEEDED' || state === 'BATCH_STATE_COMPLETED') {
    const images = extractImagesFromResponse(raw)
    const debugRaw = images.length === 0 ? stripInlineData(raw) : undefined
    return { state: 'succeeded', images, rawResponse: debugRaw }
  }

  // Unknown state — keep the job, return raw for debugging
  const debugRaw = stripInlineData(raw)
  return { state: 'unknown', error: `Unknown batch state: ${String(state)}`, rawResponse: debugRaw }
}

// ---------------------------------------------------------------------------
// Extract images from batch response — checks both metadata.responses and dest.inlinedResponses
// ---------------------------------------------------------------------------

type ResponseEntry = {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { mimeType: string; data: string }
          text?: string
        }>
      }
    }>
  }
  metadata?: { key: string }
}

function extractImagesFromResponse(raw: BatchJobRawResponse): BatchImageResult[] {
  // Gemini nests responses as: response.inlinedResponses.inlinedResponses[]
  // and also at: metadata.output.inlinedResponses.inlinedResponses[]
  const topLevel = raw as Record<string, unknown>
  const entries: ResponseEntry[] =
    dig(topLevel, 'response', 'inlinedResponses', 'inlinedResponses') ??
    dig(topLevel, 'metadata', 'output', 'inlinedResponses', 'inlinedResponses') ??
    raw.dest?.inlinedResponses ??
    []

  const images: BatchImageResult[] = []

  for (const entry of entries) {
    const category = entry.metadata?.key as PuzzleCategory | undefined
    if (!category) continue

    const parts = entry.response?.candidates?.[0]?.content?.parts
    if (!parts) continue

    const imagePart = parts.find((p) => p.inlineData?.data)
    if (!imagePart?.inlineData) continue

    const base64 = imagePart.inlineData.data
    const binaryString = atob(base64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i)
    }

    images.push({
      category,
      imageBytes: bytes,
      mimeType: imagePart.inlineData.mimeType,
    })
  }

  return images
}

// Walk a nested path and return the value if found, or undefined
function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

// Strip base64 image data from raw response to keep debug payloads small
function stripInlineData(raw: unknown): unknown {
  return JSON.parse(JSON.stringify(raw, (key, value) => {
    if (key === 'data' && typeof value === 'string' && value.length > 200) {
      return `[base64 ${value.length} chars]`
    }
    return value
  }))
}

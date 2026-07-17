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
          finishReason?: string
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
          finishReason?: string
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
  | {
      state: 'succeeded'
      images: BatchImageResult[]
      // Categories that returned a response entry but no image — Gemini
      // accepted the prompt and reported finishReason='NO_IMAGE' (safety
      // filter or generation failure). The batch is permanently done at
      // the provider; the caller has to resubmit for these categories.
      noImageCategories: PuzzleCategory[]
      // True when the response payload had at least one inlined entry —
      // distinguishes "model declined" from "Gemini returned an empty
      // batch" (which is transient).
      hasResponseEntries: boolean
      rawResponse?: unknown
    }
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
    const { images, noImageCategories, entryCount } = extractImagesFromResponse(raw)
    const debugRaw = images.length === 0 ? stripInlineData(raw) : undefined
    return {
      state: 'succeeded',
      images,
      noImageCategories,
      hasResponseEntries: entryCount > 0,
      rawResponse: debugRaw,
    }
  }

  // Unknown state — keep the job, return raw for debugging
  const debugRaw = stripInlineData(raw)
  return { state: 'unknown', error: `Unknown batch state: ${String(state)}`, rawResponse: debugRaw }
}

// ---------------------------------------------------------------------------
// Synchronous (real-time) single-image generation.
//
// Batch mode is async/best-effort (Gemini's "within 24h" SLA) and is the right
// tool for the daily 5-image cron, but it's the WRONG tool for an interactive
// admin regen of one tile — those should return in seconds. This hits the same
// image model via :generateContent (NOT :batchGenerateContent), mirroring the
// per-request body submitImageBatch builds, and returns the image bytes inline
// in a single request/response.
// ---------------------------------------------------------------------------

export type SyncImageResult = { imageBytes: Uint8Array; mimeType: string }

export async function generateImageSync(
  apiKey: string,
  category: PuzzleCategory,
  prompt: string,
): Promise<SyncImageResult> {
  const url = `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: {
          imageSize: category === 'diamond' ? '512' : '2K',
          aspectRatio: '4:3',
        },
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini sync image error ${response.status}: ${body.slice(0, 300)}`)
  }

  const raw = (await response.json()) as {
    candidates?: Array<{
      finishReason?: string
      content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> }
    }>
  }
  const parts = raw.candidates?.[0]?.content?.parts
  const imagePart = parts?.find((p) => p.inlineData?.data)
  if (!imagePart?.inlineData) {
    const reason = raw.candidates?.[0]?.finishReason ?? 'NO_IMAGE'
    throw new Error(`Gemini sync image returned no image (finishReason=${reason}).`)
  }

  return { imageBytes: base64ToBytes(imagePart.inlineData.data), mimeType: imagePart.inlineData.mimeType }
}

// ---------------------------------------------------------------------------
// Cancel a running batch AT Gemini (best-effort). Deleting the local D1 row
// only stops us polling — the job keeps running/billing on Google's side until
// it finishes or expires. :cancel asks the provider to actually stop it.
// "best effort": the API doesn't guarantee a wedged job halts, so callers
// should treat failure as non-fatal and proceed with the local cleanup.
// ---------------------------------------------------------------------------

export async function cancelImageBatch(apiKey: string, batchName: string): Promise<void> {
  const url = `${GEMINI_API_BASE}/${batchName}:cancel?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini batch cancel error ${response.status}: ${body.slice(0, 200)}`)
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Extract images from batch response — checks both metadata.responses and dest.inlinedResponses
// ---------------------------------------------------------------------------

type ResponseEntry = {
  response?: {
    candidates?: Array<{
      finishReason?: string
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

function extractImagesFromResponse(raw: BatchJobRawResponse): {
  images: BatchImageResult[]
  noImageCategories: PuzzleCategory[]
  entryCount: number
} {
  // Gemini nests responses as: response.inlinedResponses.inlinedResponses[]
  // and also at: metadata.output.inlinedResponses.inlinedResponses[]
  const topLevel = raw as Record<string, unknown>
  const entries: ResponseEntry[] =
    dig(topLevel, 'response', 'inlinedResponses', 'inlinedResponses') ??
    dig(topLevel, 'metadata', 'output', 'inlinedResponses', 'inlinedResponses') ??
    raw.dest?.inlinedResponses ??
    []

  const images: BatchImageResult[] = []
  const noImageCategories: PuzzleCategory[] = []

  for (const entry of entries) {
    const category = entry.metadata?.key as PuzzleCategory | undefined
    if (!category) continue

    const parts = entry.response?.candidates?.[0]?.content?.parts
    const imagePart = parts?.find((p) => p.inlineData?.data)

    if (!imagePart?.inlineData) {
      // No image bytes for this category. Could be finishReason='NO_IMAGE',
      // a safety block, or just a malformed entry — they all need a regen.
      noImageCategories.push(category)
      continue
    }

    images.push({
      category,
      imageBytes: base64ToBytes(imagePart.inlineData.data),
      mimeType: imagePart.inlineData.mimeType,
    })
  }

  return { images, noImageCategories, entryCount: entries.length }
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

// ---------------------------------------------------------------------------
// Vision coherence check — judges the FINISHED-puzzle render (the quantized
// image) for whether it reads as a clear picture or dissolved into incoherent
// mosaic/lattice noise. Region-size metrics can't see this (a coherent scene
// and a confetti mess can share the same region distribution).
// ---------------------------------------------------------------------------

export const DEFAULT_VISION_MODEL = 'gemini-flash-latest'

export type CoherenceVerdict = { regen: boolean; score: number; reason: string }

export async function judgeDiamondCoherence(
  apiKey: string,
  pngBytes: Uint8Array,
  model: string = DEFAULT_VISION_MODEL,
): Promise<CoherenceVerdict> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`
  const prompt = `This image is the FINISHED appearance of a paint-by-numbers puzzle (flat colour regions). Judge it ONLY on visual coherence:
- GOOD (high score): reads as a clear, recognisable scene/subject with coherent shapes.
- BAD (low score, regenerate): the main subject is incoherent visual noise — a busy mosaic / lattice / confetti of tiny disconnected colour patches with no discernible shapes (e.g. a stained-glass or tiled surface that dissolved into static).
Reply with ONLY a JSON object and nothing else: {"score": <integer 1-10 coherence>, "regen": <true if it looks like an incoherent mess that should be regenerated, else false>, "reason": "<short phrase>"}`

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: base64FromBytes(pngBytes) } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini coherence judge error ${response.status}: ${body.slice(0, 200)}`)
  }
  const raw = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = raw.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  let score = 10
  let regen = false
  let reason = ''
  if (match) {
    try {
      const v = JSON.parse(match[0]) as { score?: number; regen?: boolean; reason?: string }
      if (typeof v.score === 'number') score = v.score
      if (typeof v.regen === 'boolean') regen = v.regen
      if (typeof v.reason === 'string') reason = v.reason
    } catch {
      // leave defaults (treat unparseable as "keep" — never regen on a parse glitch)
    }
  }
  return { regen, score, reason }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

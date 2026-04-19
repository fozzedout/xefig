import type { Bindings, PuzzleCategory } from '../types'

// Google's Gemini API hosts Gemma models via the same v1beta endpoint —
// free tier keys and paid keys both authenticate via the `?key=` query
// param, so we can transparently retry against the paid key when the
// free tier hits its daily / per-minute quota.
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_GEMMA_MODEL = 'gemma-4-26b-a4b-it'

type GenerateContentResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    finishReason?: string
  }>
  error?: { code?: number; status?: string; message?: string }
  promptFeedback?: { blockReason?: string }
}

export type GemmaRewriteContext = {
  category: PuzzleCategory
  theme?: string
  keywords?: string[]
}

export type GemmaRewriter = (
  descriptive: string,
  context: GemmaRewriteContext,
) => Promise<string>

export type GemmaRewriteOutcome = {
  text: string | null
  keyUsed: 'free' | 'paid' | null
  error: string | null
}

const SYSTEM_INSTRUCTIONS = [
  'You are a scene description specialist writing prompts for an image-generation model.',
  'You will be given a structured scene brief. Transform it into a single vivid, cohesive paragraph that reads as a concrete visual description.',
  'Add sensory texture, material detail, spatial arrangement, and atmosphere — the kind of specifics that anchor the camera inside the scene.',
  'Critical framing rule: the image must be FULL-BLEED. The scene extends edge to edge on all four sides. Never describe frames, borders, mattes, paper edges, torn paper, deckled edges, paper texture around the art, vignettes, or anything that would create a non-image margin. Describe only what lives INSIDE the scene.',
  'Return ONLY the rewritten paragraph. No preamble, no explanation, no markdown, no bullet points, no quotes.',
].join(' ')

function buildUserPrompt(descriptive: string, context: GemmaRewriteContext): string {
  const themeCtx = context.theme ? `Theme: ${context.theme}` : ''
  const keywordsCtx =
    Array.isArray(context.keywords) && context.keywords.length > 0
      ? `Keywords: ${context.keywords.join(', ')}`
      : ''

  return [
    `Category: ${context.category}`,
    themeCtx,
    keywordsCtx,
    '--- Structured scene ---',
    descriptive,
  ]
    .filter(Boolean)
    .join('\n\n')
}

function isQuotaError(status: number, body: GenerateContentResponse | null): boolean {
  if (status === 429) return true
  const code = body?.error?.status ?? ''
  if (code === 'RESOURCE_EXHAUSTED') return true
  const message = (body?.error?.message ?? '').toLowerCase()
  return message.includes('quota') || message.includes('rate limit') || message.includes('exceeded')
}

function parseJsonSafely<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function extractText(payload: GenerateContentResponse | null): string {
  const parts = payload?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim()
}

function cleanRewrite(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('```')) {
    value = value
      .replace(/^```[a-zA-Z]*\s*/, '')
      .replace(/\s*```$/, '')
      .trim()
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  return value.replace(/\s+/g, ' ').trim()
}

async function callGemmaOnce(
  apiKey: string,
  model: string,
  descriptive: string,
  context: GemmaRewriteContext,
): Promise<{ text: string | null; status: number; body: GenerateContentResponse | null; rawBody: string }> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`

  // Gemma models on the Gemini API do not accept a top-level `systemInstruction`
  // (that's reserved for Gemini models). Inline the system guidance as the
  // first user turn so the request is accepted for both Gemma and Gemini.
  const userPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${buildUserPrompt(descriptive, context)}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 1,
        maxOutputTokens: 1024,
      },
    }),
  })

  const rawBody = await response.text()
  const parsed = parseJsonSafely<GenerateContentResponse>(rawBody)

  if (!response.ok) {
    return { text: null, status: response.status, body: parsed, rawBody }
  }

  const text = extractText(parsed)
  return { text: text || null, status: response.status, body: parsed, rawBody }
}

export async function rewriteWithGemma(
  env: Pick<Bindings, 'GOOGLE_AI_FREE_API_KEY' | 'GOOGLE_AI_API_KEY' | 'GEMMA_REWRITE_MODEL'>,
  descriptive: string,
  context: GemmaRewriteContext,
): Promise<GemmaRewriteOutcome> {
  const freeKey = (env.GOOGLE_AI_FREE_API_KEY || '').trim()
  const paidKey = (env.GOOGLE_AI_API_KEY || '').trim()
  const model = (env.GEMMA_REWRITE_MODEL || '').trim() || DEFAULT_GEMMA_MODEL

  const attempts: Array<{ key: string; label: 'free' | 'paid' }> = []
  if (freeKey) attempts.push({ key: freeKey, label: 'free' })
  if (paidKey && paidKey !== freeKey) attempts.push({ key: paidKey, label: 'paid' })

  if (attempts.length === 0) {
    return { text: null, keyUsed: null, error: 'No Google AI API key configured.' }
  }

  let lastError: string | null = null

  for (let i = 0; i < attempts.length; i++) {
    const { key, label } = attempts[i]
    try {
      const result = await callGemmaOnce(key, model, descriptive, context)

      if (result.text) {
        const cleaned = cleanRewrite(result.text)
        if (cleaned) {
          return { text: cleaned, keyUsed: label, error: null }
        }
        lastError = `${label} key returned empty text`
        continue
      }

      const errMsg =
        result.body?.error?.message ||
        result.body?.promptFeedback?.blockReason ||
        result.rawBody.slice(0, 240)
      lastError = `${label} key HTTP ${result.status}: ${errMsg}`

      const shouldFallback =
        i < attempts.length - 1 && isQuotaError(result.status, result.body)
      if (!shouldFallback) {
        return { text: null, keyUsed: label, error: lastError }
      }
      console.warn(`[gemma-rewriter] ${label} key quota-exhausted, falling back to paid key`)
    } catch (err) {
      lastError = `${label} key request error: ${err instanceof Error ? err.message : String(err)}`
      // Network errors — try the next key if we have one.
      if (i === attempts.length - 1) {
        return { text: null, keyUsed: label, error: lastError }
      }
    }
  }

  return { text: null, keyUsed: null, error: lastError }
}

// Convenience factory: returns a rewriter bound to `env` for passing into
// prompts.ts, with graceful fallthrough (returns original text if rewrite
// fails, so the pipeline never stalls on a text-LLM outage).
export function makeGemmaRewriter(
  env: Pick<Bindings, 'GOOGLE_AI_FREE_API_KEY' | 'GOOGLE_AI_API_KEY' | 'GEMMA_REWRITE_MODEL'>,
): GemmaRewriter | null {
  const hasKey = Boolean((env.GOOGLE_AI_FREE_API_KEY || env.GOOGLE_AI_API_KEY || '').trim())
  if (!hasKey) return null

  return async (descriptive, context) => {
    const outcome = await rewriteWithGemma(env, descriptive, context)
    if (outcome.text) {
      console.log(
        `[gemma-rewriter] ${context.category} rewritten via ${outcome.keyUsed} key (${outcome.text.length} chars)`,
      )
      return outcome.text
    }
    console.warn(
      `[gemma-rewriter] ${context.category} rewrite failed (${outcome.error}); falling back to raw descriptor prompt`,
    )
    return descriptive
  }
}

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
  rawText: string | null
  promptSent: string | null
  keyUsed: 'free' | 'paid' | null
  error: string | null
}

// Match the OpenRouter rewriter's system + user prompt byte-for-byte
// (see apps/worker/src/lib/prompt-rewriter.ts) so that swapping models
// is the only variable. Gemma's API doesn't accept `systemInstruction`
// for real, so for Gemma we concatenate the system text onto the user
// turn with a blank line between; for Gemini models we use the
// systemInstruction field and preserve the two-role shape.
const SYSTEM_MESSAGE = [
  'You are a creative writer specializing in vivid scene descriptions. You will be given a structured image prompt and its associated metadata.',
  'Your task is to transform the descriptive elements into a single, cohesive, and highly imaginative paragraph.',
  'Do not just reword the input; invent concrete sensory details, textures, and atmosphere that bring the scene to life.',
  'Use the provided Theme and Keywords as high-level creative direction to ensure the scene reflects the intended mood and subject.',
  'Return ONLY the rewritten descriptive paragraph. No technical instructions, no preamble, no explanation, no markdown.',
].join(' ')

function isGeminiModel(model: string): boolean {
  return /^gemini[-\s]/i.test(model.trim())
}

function buildUserMessage(descriptive: string, context: GemmaRewriteContext): string {
  const themeCtx = context.theme ? `Theme: ${context.theme}` : ''
  const keywordsCtx =
    Array.isArray(context.keywords) && context.keywords.length > 0
      ? `Keywords: ${context.keywords.join(', ')}`
      : ''

  return [
    `Category: ${context.category}`,
    themeCtx,
    keywordsCtx,
    '--- Structured Prompt ---',
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

// Markers Gemma emits when it shows its working. Anything at/after the
// FIRST of these gets dropped as scratchpad, keeping only the last
// coherent prose block before the leakage.
const SCRATCH_MARKERS = [
  /\n\s*\*\s*\*[A-Z][^*]+\*:/i,          // "* *Setting:* …"
  /\n\s*(?:Drafting|Draft)\s+(?:version\s*\d+|v\d+)\s*:/i,
  /\n\s*Final\s+Version(?:\s+Construction)?\s*:/i,
  /\n\s*Self[- ]Correction[:\s]/i,
  /\n\s*Keywords?\s+Check\s*:/i,
  /\n\s*Refining\s+for\s+["“]/i,
]

// De-dupe "ABC ABC" when the model emits its final paragraph twice in a
// row with no separator (a Gemma quirk). Splits the string in half; if
// both halves are identical or one contains the other, collapse to one.
function collapseDuplicatedTail(value: string): string {
  const len = value.length
  if (len < 200) return value
  for (let split = Math.floor(len / 2); split < len - 50; split++) {
    const a = value.slice(0, split).trim()
    const b = value.slice(split).trim()
    if (a.length >= 100 && b.length >= 100 && a === b) {
      return a
    }
  }
  // Also handle the no-space concat case: look for an exact internal repeat
  // of at least 120 chars immediately followed by the same substring.
  const mid = Math.floor(len / 2)
  for (let offset = -30; offset <= 30; offset++) {
    const split = mid + offset
    const left = value.slice(Math.max(0, split - 120), split)
    const right = value.slice(split, split + 120)
    if (left.length === 120 && left === right) {
      return value.slice(0, split).trim()
    }
  }
  return value
}

function stripEchoedInstructions(value: string): string {
  // Drop any leading lines that are restating our own prompt back at us.
  // We look for hallmark phrases from the instruction line or buildUserPrompt.
  const echoPatterns = [
    /^.*rewrite the image-generation scene.*$/gim,
    /^.*scene description specialist.*$/gim,
    /^.*transform[^.]{0,40}structured scene brief.*$/gim,
    /^\s*(?:Input|Rewritten paragraph|Category|Theme|Keywords)\s*:.*$/gim,
    /^\s*---[^\n]*---\s*$/gim,
    /^\s*FULL[- ]BLEED[^\n]*$/gim,
    /^\s*ONLY the rewritten paragraph[^\n]*$/gim,
  ]
  let result = value
  for (const re of echoPatterns) {
    result = result.replace(re, '')
  }
  return result.replace(/\n{3,}/g, '\n\n').trim()
}

function cleanRewrite(raw: string): string {
  let value = raw.trim()
  if (value.startsWith('```')) {
    value = value
      .replace(/^```[a-zA-Z]*\s*/, '')
      .replace(/\s*```$/, '')
      .trim()
  }

  // If the model leaked its scratchpad ("* *Setting:*", "Drafting version 2:",
  // "Self-Correction:", "Final Version Construction:"), the prose we want is
  // whatever comes AFTER the last scratch marker. Find the rightmost match
  // across all marker patterns and slice from there.
  let lastMarkerEnd = -1
  for (const re of SCRATCH_MARKERS) {
    // Global so we can find the last occurrence.
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = globalRe.exec(value)) !== null) {
      // Move past the marker line — take everything after the next newline,
      // or after the marker itself if no newline follows.
      const afterMarker = value.indexOf('\n', m.index + m[0].length)
      const end = afterMarker === -1 ? m.index + m[0].length : afterMarker + 1
      if (end > lastMarkerEnd) lastMarkerEnd = end
    }
  }
  if (lastMarkerEnd > -1 && lastMarkerEnd < value.length - 80) {
    value = value.slice(lastMarkerEnd).trim()
  }

  value = stripEchoedInstructions(value)

  // If the cleaned text still has multiple paragraphs, prefer the last one —
  // that's where the final answer usually sits after Gemma's drafts.
  const paragraphs = value
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.length > 60 &&
        !p.startsWith('*') &&
        !p.startsWith('-') &&
        !/^(?:Input|Output|Rewritten paragraph|Draft|Final)\s*:/i.test(p),
    )
  if (paragraphs.length > 0) {
    value = paragraphs[paragraphs.length - 1]
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }

  value = collapseDuplicatedTail(value)

  return value.replace(/\s+/g, ' ').trim()
}

async function callGemmaOnce(
  apiKey: string,
  model: string,
  descriptive: string,
  context: GemmaRewriteContext,
): Promise<{
  text: string | null
  status: number
  body: GenerateContentResponse | null
  rawBody: string
  promptSent: string
}> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`

  const userMessage = buildUserMessage(descriptive, context)
  const useSystemInstruction = isGeminiModel(model)

  // For Gemma the system message is concatenated onto the user turn; for
  // Gemini it goes into the systemInstruction field. Either way the
  // generationConfig matches the OpenRouter rewriter (temp 1, 1024 toks).
  const userText = useSystemInstruction
    ? userMessage
    : `${SYSTEM_MESSAGE}\n\n${userMessage}`

  const requestBody: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 1,
      maxOutputTokens: 1024,
    },
  }
  if (useSystemInstruction) {
    requestBody.systemInstruction = { parts: [{ text: SYSTEM_MESSAGE }] }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  const rawBody = await response.text()
  const parsed = parseJsonSafely<GenerateContentResponse>(rawBody)

  if (!response.ok) {
    return { text: null, status: response.status, body: parsed, rawBody, promptSent: userText }
  }

  const text = extractText(parsed)
  return { text: text || null, status: response.status, body: parsed, rawBody, promptSent: userText }
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
    return {
      text: null,
      rawText: null,
      promptSent: null,
      keyUsed: null,
      error: 'No Google AI API key configured.',
    }
  }

  let lastError: string | null = null
  let lastPromptSent: string | null = null
  let lastRaw: string | null = null

  for (let i = 0; i < attempts.length; i++) {
    const { key, label } = attempts[i]
    try {
      const result = await callGemmaOnce(key, model, descriptive, context)
      lastPromptSent = result.promptSent
      lastRaw = result.text

      if (result.text) {
        const cleaned = cleanRewrite(result.text)
        if (cleaned) {
          return {
            text: cleaned,
            rawText: result.text,
            promptSent: result.promptSent,
            keyUsed: label,
            error: null,
          }
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
        return {
          text: null,
          rawText: result.text,
          promptSent: result.promptSent,
          keyUsed: label,
          error: lastError,
        }
      }
      console.warn(`[gemma-rewriter] ${label} key quota-exhausted, falling back to paid key`)
    } catch (err) {
      lastError = `${label} key request error: ${err instanceof Error ? err.message : String(err)}`
      // Network errors — try the next key if we have one.
      if (i === attempts.length - 1) {
        return {
          text: null,
          rawText: lastRaw,
          promptSent: lastPromptSent,
          keyUsed: label,
          error: lastError,
        }
      }
    }
  }

  return {
    text: null,
    rawText: lastRaw,
    promptSent: lastPromptSent,
    keyUsed: null,
    error: lastError,
  }
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

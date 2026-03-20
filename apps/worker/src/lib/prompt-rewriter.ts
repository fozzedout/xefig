import { CATEGORIES, type Bindings, type PromptPack, type PuzzleCategory } from '../types'

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const DEFAULT_OPENROUTER_MODEL = 'openrouter/free'
const APP_REFERER = 'https://xefig.com'
const APP_TITLE = 'xefig-admin-prompt-rewriter'

type OpenRouterMessageContentPart = {
  text?: string
}

type OpenRouterMessage = {
  content?: string | OpenRouterMessageContentPart[]
}

type OpenRouterResponse = {
  choices?: Array<{
    message?: OpenRouterMessage
  }>
  error?: unknown
}

type OpenRouterModelRecord = {
  id?: unknown
  name?: unknown
  context_length?: unknown
  pricing?: unknown
}

type OpenRouterModelsResponse = {
  data?: unknown
}

export type PromptRewriteResult = {
  attempted: boolean
  applied: boolean
  model: string | null
  error: string | null
  pack: PromptPack
}

export type SinglePromptRewriteResult = {
  attempted: boolean
  applied: boolean
  model: string | null
  error: string | null
  prompt: string | null
}

export type OpenRouterFreeModel = {
  id: string
  name: string
  contextLength: number | null
}

export async function maybeRewritePromptPackWithOpenRouter(
  env: Pick<Bindings, 'OPENROUTER_API_KEY' | 'OPENROUTER_MODEL'>,
  pack: PromptPack,
): Promise<PromptRewriteResult> {
  const apiKey = (env.OPENROUTER_API_KEY || '').trim()
  if (!apiKey) {
    return {
      attempted: false,
      applied: false,
      model: null,
      error: null,
      pack,
    }
  }

  const model = resolveModel(env.OPENROUTER_MODEL)

  try {
    const fallbackModels = model === DEFAULT_OPENROUTER_MODEL ? [] : [DEFAULT_OPENROUTER_MODEL]
    const rewritten = await rewritePromptsIndividually(apiKey, model, fallbackModels, pack.prompts)
    if (rewritten.applied) {
      return {
        attempted: true,
        applied: true,
        model,
        error: null,
        pack: {
          ...pack,
          prompts: rewritten.prompts,
        },
      }
    }

    return {
      attempted: true,
      applied: false,
      model,
      error: rewritten.error || 'OpenRouter did not return any rewritten prompt text.',
      pack,
    }
  } catch (error) {
    return {
      attempted: true,
      applied: false,
      model,
      error:
        error instanceof Error ? `OpenRouter request error: ${error.message}` : 'OpenRouter request error.',
      pack,
    }
  }
}

export async function rewriteSinglePromptWithOpenRouter(
  env: Pick<Bindings, 'OPENROUTER_API_KEY' | 'OPENROUTER_MODEL'>,
  input: {
    prompt: string
    category: PuzzleCategory
    model?: string
  },
): Promise<SinglePromptRewriteResult> {
  const apiKey = (env.OPENROUTER_API_KEY || '').trim()
  if (!apiKey) {
    return {
      attempted: false,
      applied: false,
      model: null,
      error: 'OPENROUTER_API_KEY is not configured.',
      prompt: null,
    }
  }

  const model = resolveModel(input.model || env.OPENROUTER_MODEL)
  const fallbackModels = model === DEFAULT_OPENROUTER_MODEL ? [] : [DEFAULT_OPENROUTER_MODEL]

  try {
    const rewritten = await rewriteOnePrompt(
      apiKey,
      model,
      fallbackModels,
      input.category,
      cleanPrompt(input.prompt),
    )

    if (!rewritten.prompt) {
      return {
        attempted: true,
        applied: false,
        model,
        error: rewritten.error || 'No rewrite text returned.',
        prompt: null,
      }
    }

    return {
      attempted: true,
      applied: true,
      model,
      error: null,
      prompt: rewritten.prompt,
    }
  } catch (error) {
    return {
      attempted: true,
      applied: false,
      model,
      error:
        error instanceof Error ? `OpenRouter request error: ${error.message}` : 'OpenRouter request error.',
      prompt: null,
    }
  }
}

export async function listOpenRouterFreeModels(
  env: Pick<Bindings, 'OPENROUTER_API_KEY'>,
): Promise<OpenRouterFreeModel[]> {
  const apiKey = (env.OPENROUTER_API_KEY || '').trim()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': APP_REFERER,
    'X-Title': APP_TITLE,
  }

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(OPENROUTER_MODELS_URL, {
    method: 'GET',
    headers,
  })

  const rawBody = await response.text()
  const parsed = parseJsonSafely<OpenRouterModelsResponse>(rawBody)

  if (!response.ok) {
    const message = describeOpenRouterError(response.status, response.statusText, parsed as OpenRouterResponse | null, rawBody)
    throw new Error(`OpenRouter model list failed: ${message}`)
  }

  const data = Array.isArray(parsed?.data) ? parsed.data : []
  const freeModels: OpenRouterFreeModel[] = []
  const seen = new Set<string>()

  for (const item of data) {
    if (!item || typeof item !== 'object') {
      continue
    }

    const record = item as OpenRouterModelRecord
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) {
      continue
    }

    if (!isLikelyFreeModel(id, record.pricing)) {
      continue
    }

    const name = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : id

    const contextLength =
      typeof record.context_length === 'number' && Number.isFinite(record.context_length)
        ? Math.max(0, Math.floor(record.context_length))
        : null

    seen.add(id)
    freeModels.push({ id, name, contextLength })
  }

  freeModels.sort((a, b) => a.id.localeCompare(b.id))
  return freeModels
}

function resolveModel(value: string | undefined): string {
  return (value || '').trim() || DEFAULT_OPENROUTER_MODEL
}

type IndividualRewriteResult = {
  applied: boolean
  prompts: Record<PuzzleCategory, string>
  error: string | null
}

async function rewritePromptsIndividually(
  apiKey: string,
  model: string,
  fallbackModels: string[],
  prompts: Record<PuzzleCategory, string>,
): Promise<IndividualRewriteResult> {
  const nextPrompts = { ...prompts }

  const attempts = await Promise.all(
    CATEGORIES.map(async (category) => {
      const result = await rewriteOnePrompt(apiKey, model, fallbackModels, category, prompts[category])
      return {
        category,
        prompt: result.prompt,
        error: result.error,
      }
    }),
  )

  let rewrittenCount = 0
  const errors: string[] = []

  for (const result of attempts) {
    if (result.prompt) {
      rewrittenCount += 1
      nextPrompts[result.category] = result.prompt
      continue
    }

    if (result.error) {
      errors.push(`${result.category}: ${result.error}`)
    }
  }

  return {
    applied: rewrittenCount > 0,
    prompts: nextPrompts,
    error: errors.length > 0 ? errors.join(' | ').slice(0, 700) : null,
  }
}

async function rewriteOnePrompt(
  apiKey: string,
  model: string,
  fallbackModels: string[],
  category: PuzzleCategory,
  prompt: string,
): Promise<{ prompt: string | null; error: string | null }> {
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': APP_REFERER,
      'X-Title': APP_TITLE,
    },
    body: JSON.stringify({
      model,
      ...(fallbackModels.length > 0 ? { models: fallbackModels } : {}),
      temperature: 1,
      max_tokens: 1020,
      messages: [
        {
          role: 'system',
          content:
          'You are a creative image prompt writer. You will be given a structured image prompt containing a set of labelled descriptors (setting, lighting, mood, style, colour palette, camera). Your task is to author a single vivid, imaginative paragraph that conjures a fully realised scene — as if describing a painting or film still to someone who cannot see it. Do not just reword the input. Use the descriptors as raw ingredients: let the setting ground the scene, let the lighting and mood infuse its atmosphere, and make the camera angle feel intentional. Invent concrete sensory details — textures, movement, implied story — that bring the scene to life. The paragraph must still function as an image generation prompt, so preserve all technical constraints exactly as given (composition rules, quality requirements, output format, and colour palette instructions). Return only the rewritten prompt paragraph with no markdown, no preamble, and no explanation.',
        },
        {
          role: 'user',
          content: [
            `Category: ${category}`,
            'Here is the structured prompt. Rewrite it as one vivid, scene-driven paragraph:',
            prompt,
          ].join('\n\n'),
        },
      ],
    }),
  })

  const rawBody = await response.text()
  const parsed = parseJsonSafely<OpenRouterResponse>(rawBody)

  if (!response.ok) {
    return {
      prompt: null,
      error: describeOpenRouterError(response.status, response.statusText, parsed, rawBody),
    }
  }

  const content = extractFirstTextContent(parsed)
  if (!content) {
    return { prompt: null, error: 'No text content returned.' }
  }

  const cleaned = trimPromptText(content)
  if (!cleaned) {
    return { prompt: null, error: 'Empty rewrite text.' }
  }

  return { prompt: cleaned, error: null }
}

function extractFirstTextContent(payload: OpenRouterResponse | null): string {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ')
      .trim()
  }

  return ''
}

function parseJsonSafely<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function describeOpenRouterError(
  status: number,
  statusText: string,
  parsed: OpenRouterResponse | null,
  rawBody: string,
): string {
  const parts: string[] = []
  const error = parsed?.error

  if (typeof error === 'string' && error.trim()) {
    parts.push(error.trim())
  } else if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      parts.push(candidate.message.trim())
    }
    if (typeof candidate.code === 'string' || typeof candidate.code === 'number') {
      parts.push(`code: ${String(candidate.code)}`)
    }

    const metadata = candidate.metadata
    if (metadata && typeof metadata === 'object') {
      const meta = metadata as Record<string, unknown>
      if (typeof meta.provider_name === 'string' && meta.provider_name.trim()) {
        parts.push(`provider: ${meta.provider_name.trim()}`)
      }
      if (typeof meta.raw === 'string' && meta.raw.trim()) {
        parts.push(`provider_raw: ${meta.raw.trim().slice(0, 240)}`)
      }
      if (typeof meta.reason === 'string' && meta.reason.trim()) {
        parts.push(`reason: ${meta.reason.trim().slice(0, 240)}`)
      }
    }
  }

  if (parts.length === 0 && rawBody.trim()) {
    parts.push(rawBody.trim().slice(0, 260))
  }

  const statusPart = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`
  const detailPart = parts.length > 0 ? `: ${parts.join(' | ')}` : ''
  return `${statusPart}${detailPart}`
}

function trimPromptText(value: string): string {
  return cleanPrompt(stripSurroundingQuotes(stripCodeFence(value)))
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('```')) {
    return trimmed
  }

  return trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
}

function stripSurroundingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim()
  }
  return value
}

function cleanPrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function isLikelyFreeModel(id: string, pricing: unknown): boolean {
  if (id.endsWith(':free')) {
    return true
  }

  if (!pricing || typeof pricing !== 'object') {
    return false
  }

  const entry = pricing as Record<string, unknown>
  const promptPrice = parsePrice(entry.prompt)
  const completionPrice = parsePrice(entry.completion)

  return promptPrice === 0 && completionPrice === 0
}

function parsePrice(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

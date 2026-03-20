import { CATEGORIES, type Bindings, type PromptPack, type PuzzleCategory } from '../types'

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_OPENROUTER_MODEL = 'google/gemma-3-27b-it:free'

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
  error?: {
    message?: string
  }
}

export type PromptRewriteResult = {
  attempted: boolean
  applied: boolean
  model: string | null
  error: string | null
  pack: PromptPack
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

  const model = (env.OPENROUTER_MODEL || '').trim() || DEFAULT_OPENROUTER_MODEL

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        messages: [
          {
            role: 'system',
            content:
              'You rewrite image prompts. Return valid JSON only. For each prompt, convert keyword-style instructions into one coherent, descriptive narrative paragraph while preserving intent, constraints, composition, quality, and output requirements.',
          },
          {
            role: 'user',
            content: [
              'Rewrite the following prompts to follow this rule:',
              '"Describe the scene, do not just list keywords."',
              '',
              'Requirements:',
              `- Return JSON object with keys: ${CATEGORIES.join(', ')}`,
              '- Each value must be a single descriptive paragraph.',
              '- Keep all technical constraints present in the original prompt (4:3, edge-to-edge, no borders/vignettes, etc).',
              '- Do not add markdown or explanations.',
              '',
              'Input prompts:',
              JSON.stringify(pack.prompts, null, 2),
            ].join('\n'),
          },
        ],
      }),
    })

    const parsed = (await response.json().catch(() => null)) as OpenRouterResponse | null
    if (!response.ok) {
      const message = parsed?.error?.message || `HTTP ${response.status}`
      return {
        attempted: true,
        applied: false,
        model,
        error: `OpenRouter request failed: ${message}`,
        pack,
      }
    }

    const content = extractFirstTextContent(parsed)
    if (!content) {
      return {
        attempted: true,
        applied: false,
        model,
        error: 'OpenRouter returned no text content.',
        pack,
      }
    }

    const rewritten = parseRewrittenPrompts(content)
    if (!rewritten) {
      return {
        attempted: true,
        applied: false,
        model,
        error: 'OpenRouter response was not valid prompt JSON.',
        pack,
      }
    }

    let changedCount = 0
    const mergedPrompts = { ...pack.prompts }
    for (const category of CATEGORIES) {
      const next = rewritten[category]
      if (!next) {
        continue
      }
      if (next !== pack.prompts[category]) {
        changedCount += 1
      }
      mergedPrompts[category] = next
    }

    return {
      attempted: true,
      applied: changedCount > 0,
      model,
      error: null,
      pack: {
        ...pack,
        prompts: mergedPrompts,
      },
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

function extractFirstTextContent(payload: OpenRouterResponse | null): string {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ')
      .trim()
    return joined
  }

  return ''
}

function parseRewrittenPrompts(text: string): Partial<Record<PuzzleCategory, string>> | null {
  const candidates = [stripCodeFence(text), findJsonObject(text)]
    .filter((value): value is string => Boolean(value))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>
      const next: Partial<Record<PuzzleCategory, string>> = {}
      let count = 0

      for (const category of CATEGORIES) {
        const rawValue = parsed[category]
        if (typeof rawValue !== 'string') {
          continue
        }

        const cleaned = cleanPrompt(rawValue)
        if (!cleaned) {
          continue
        }

        next[category] = cleaned
        count += 1
      }

      if (count > 0) {
        return next
      }
    } catch {
      // Try the next parsing strategy.
    }
  }

  return null
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

function findJsonObject(value: string): string | null {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) {
    return null
  }

  return value.slice(start, end + 1)
}

function cleanPrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

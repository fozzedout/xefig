import { CATEGORIES, type FormValue, type PuzzleAsset, type PuzzleCategory, type PuzzleRecord } from '../types'

const PUZZLE_KEY_PREFIX = 'puzzle:'

export function toPuzzleKey(date: string): string {
  return `${PUZZLE_KEY_PREFIX}${date}`
}

export async function getPuzzleByDate(kv: KVNamespace, date: string): Promise<PuzzleRecord | null> {
  const raw = await kv.get(toPuzzleKey(date))
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return toPuzzleRecord(parsed)
  } catch {
    return null
  }
}

function toPuzzleRecord(value: unknown): PuzzleRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<PuzzleRecord>
  if (
    typeof candidate.date !== 'string' ||
    typeof candidate.theme !== 'string' ||
    typeof candidate.difficulty !== 'string' ||
    !candidate.categories ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    return null
  }

  const normalizedCategories = {} as Record<PuzzleCategory, PuzzleAsset>
  for (const category of CATEGORIES) {
    const asset = candidate.categories[category]
    if (
      !asset ||
      typeof asset.imageKey !== 'string' ||
      typeof asset.imageUrl !== 'string' ||
      typeof asset.contentType !== 'string' ||
      typeof asset.fileName !== 'string'
    ) {
      return null
    }

    normalizedCategories[category] = {
      imageKey: asset.imageKey,
      imageUrl: asset.imageUrl,
      contentType: asset.contentType,
      fileName: asset.fileName,
    }
  }

  const tags = normalizeTags((candidate as { tags?: unknown }).tags)
  return {
    date: candidate.date,
    theme: candidate.theme,
    tags: tags.length > 0 ? tags : normalizeTags(candidate.theme.split(/\s*-\s*/)),
    difficulty: candidate.difficulty,
    categories: normalizedCategories,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  }
}

export function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function addDaysToDateKey(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`)
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export async function findNextUnscheduledDate(
  kv: KVNamespace,
  fromDate: string,
  maxDaysToScan: number,
): Promise<string | null> {
  let candidate = fromDate
  for (let index = 0; index < maxDaysToScan; index += 1) {
    const exists = await kv.get(toPuzzleKey(candidate))
    if (!exists) {
      return candidate
    }
    candidate = addDaysToDateKey(candidate, 1)
  }
  return null
}

export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  return !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
}

export function getStringField(value?: FormValue): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const [first] = value
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}

export function parseTagList(raw?: string): string[] {
  if (!raw) {
    return []
  }

  const trimmed = raw.trim()
  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return normalizeTags(parsed)
    } catch {
      // Fall back to comma parsing.
    }
  }

  return normalizeTags(
    trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  )
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  const tags: string[] = []
  for (const rawTag of value) {
    if (typeof rawTag !== 'string') {
      continue
    }
    const tag = rawTag.trim().toLowerCase()
    if (!tag || seen.has(tag)) {
      continue
    }
    seen.add(tag)
    tags.push(tag)
    if (tags.length >= 24) {
      break
    }
  }
  return tags
}

export function formatThemeFromTags(tags: string[]): string {
  if (tags.length === 0) {
    return 'Daily Puzzle'
  }
  const [first = 'Daily', second = 'Puzzle'] = tags
  return `${capitalizeWords(first)} - ${capitalizeWords(second)}`
}

export function getFileField(value?: FormValue): File | undefined {
  if (value instanceof File) {
    return value
  }
  if (Array.isArray(value)) {
    const [first] = value
    return first instanceof File ? first : undefined
  }
  return undefined
}

export function getFileExtension(file: File): string {
  if (file.type === 'image/png') {
    return 'png'
  }
  if (file.type === 'image/webp') {
    return 'webp'
  }
  if (file.type === 'image/gif') {
    return 'gif'
  }
  if (file.type === 'image/jpeg') {
    return 'jpg'
  }
  if (file.name.includes('.')) {
    return file.name.split('.').pop()?.toLowerCase() || 'bin'
  }
  return 'bin'
}

export function toCdnUrl(r2Key: string): string {
  const encodedKey = r2Key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `/cdn/${encodedKey}`
}

function capitalizeWords(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase())
}

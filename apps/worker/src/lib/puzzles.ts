import { type FormValue, type PuzzleRecord } from '../types'
import { ensurePuzzleTables, getPuzzleByDateD1, savePuzzleRecord, findNextUnscheduledDateD1 } from './puzzle-db'

export { savePuzzleRecord }

export async function getPuzzleByDate(db: D1Database, date: string): Promise<PuzzleRecord | null> {
  await ensurePuzzleTables(db)
  return getPuzzleByDateD1(db, date)
}


export function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export function addDaysToDateKey(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`)
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export async function findNextUnscheduledDate(
  db: D1Database,
  fromDate: string,
  maxDaysToScan: number,
): Promise<string | null> {
  await ensurePuzzleTables(db)
  return findNextUnscheduledDateD1(db, fromDate, maxDaysToScan)
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

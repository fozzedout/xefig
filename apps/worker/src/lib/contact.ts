import type { D1Database } from '@cloudflare/workers-types'

const CONTACT_TABLE = 'contact_messages'

export async function ensureContactTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS ${CONTACT_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, message TEXT NOT NULL, ip TEXT, submitted_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ).run()
}

// ─── Bot detection ───

const GIBBERISH_CONSONANT_RUN = /[^aeiou\s]{6,}/i
const ALL_UPPERCASE = /^[A-Z\s]{8,}$/
const RANDOM_EMAIL_PREFIX = /^[a-z](\.[a-z]){4,}@/i

function looksGibberish(text: string): boolean {
  if (GIBBERISH_CONSONANT_RUN.test(text)) return true
  if (ALL_UPPERCASE.test(text)) return true
  // Very short with no spaces — likely random
  if (text.length > 6 && text.length < 40 && !text.includes(' ')) return true
  return false
}

function looksLikeBotEmail(email: string): boolean {
  return RANDOM_EMAIL_PREFIX.test(email)
}

export type ContactValidation = {
  valid: boolean
  error?: string
}

export function validateContact(body: {
  name?: string
  email?: string
  message?: string
  website?: string // honeypot
  _ts?: number // timestamp from form load
}): ContactValidation {
  // Honeypot: if the hidden "website" field is filled, it's a bot
  if (body.website) {
    return { valid: false, error: 'Invalid submission.' }
  }

  const name = (body.name || '').trim()
  const email = (body.email || '').trim()
  const message = (body.message || '').trim()

  if (!name || name.length < 2) {
    return { valid: false, error: 'Please enter your name.' }
  }
  if (name.length > 100) {
    return { valid: false, error: 'Name is too long.' }
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { valid: false, error: 'Please enter a valid email address.' }
  }
  if (!message || message.length < 10) {
    return { valid: false, error: 'Please enter a message (at least 10 characters).' }
  }
  if (message.length > 5000) {
    return { valid: false, error: 'Message is too long (max 5000 characters).' }
  }

  // Timing check: form must have been open at least 3 seconds
  if (body._ts) {
    const elapsed = Date.now() - body._ts
    if (elapsed < 3000) {
      return { valid: false, error: 'Please take a moment before submitting.' }
    }
  }

  // Gibberish checks
  if (looksGibberish(name)) {
    return { valid: false, error: 'Please enter a valid name.' }
  }
  if (looksGibberish(message)) {
    return { valid: false, error: 'Please enter a meaningful message.' }
  }
  if (looksLikeBotEmail(email)) {
    return { valid: false, error: 'Please enter a valid email address.' }
  }

  return { valid: true }
}

export async function storeContactMessage(
  db: D1Database,
  name: string,
  email: string,
  message: string,
  ip: string | null,
): Promise<void> {
  await ensureContactTable(db)
  await db
    .prepare(
      `INSERT INTO ${CONTACT_TABLE} (name, email, message, ip) VALUES (?, ?, ?, ?)`,
    )
    .bind(name, email, message, ip || '')
    .run()
}

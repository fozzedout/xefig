import type { Bindings } from '../types'

export const ADMIN_SESSION_COOKIE = 'xefig_admin_session'
export const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12

export function getAdminSessionSecret(env: Pick<Bindings, 'ADMIN_PASSWORD' | 'ADMIN_SESSION_SECRET'>): string | null {
  const explicit = env.ADMIN_SESSION_SECRET?.trim()
  if (explicit) {
    return explicit
  }

  const fallback = env.ADMIN_PASSWORD?.trim()
  return fallback || null
}

export async function createAdminSessionToken(secret: string, now = Date.now()): Promise<string> {
  const expiresAt = now + ADMIN_SESSION_TTL_SECONDS * 1000
  const payload = `admin:${expiresAt}`
  const signature = await signPayload(secret, payload)
  return `${expiresAt}.${signature}`
}

export async function verifyAdminSessionToken(
  secret: string,
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) {
    return false
  }

  const [expiresAtRaw, signature] = token.split('.', 2)
  const expiresAt = Number(expiresAtRaw)
  if (!expiresAtRaw || !signature || !Number.isFinite(expiresAt) || expiresAt <= now) {
    return false
  }

  const payload = `admin:${expiresAt}`
  const expectedSignature = await signPayload(secret, payload)
  return timingSafeEqual(signature, expectedSignature)
}

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return toBase64Url(signature)
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }

  let mismatch = 0
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return mismatch === 0
}

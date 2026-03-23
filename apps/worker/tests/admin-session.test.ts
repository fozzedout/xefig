import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  getAdminSessionSecret,
  verifyAdminSessionToken,
} from '../src/lib/admin-session'

test('getAdminSessionSecret prefers ADMIN_SESSION_SECRET', () => {
  assert.equal(
    getAdminSessionSecret({
      ADMIN_PASSWORD: 'password-secret',
      ADMIN_SESSION_SECRET: 'cookie-secret',
    }),
    'cookie-secret',
  )
})

test('createAdminSessionToken produces a verifiable token', async () => {
  const now = Date.UTC(2026, 2, 23, 12, 0, 0)
  const token = await createAdminSessionToken('top-secret', now)

  assert.equal(await verifyAdminSessionToken('top-secret', token, now + 1_000), true)
  assert.equal(
    await verifyAdminSessionToken('top-secret', token, now + ADMIN_SESSION_TTL_SECONDS * 1000 + 1),
    false,
  )
})

test('verifyAdminSessionToken rejects tampered tokens', async () => {
  const now = Date.UTC(2026, 2, 23, 12, 0, 0)
  const token = await createAdminSessionToken('top-secret', now)
  const [expiresAt, signature] = token.split('.', 2)
  const tamperedToken = `${expiresAt}.${signature.slice(0, -1)}x`

  assert.equal(await verifyAdminSessionToken('top-secret', tamperedToken, now + 1_000), false)
  assert.equal(await verifyAdminSessionToken('wrong-secret', token, now + 1_000), false)
})

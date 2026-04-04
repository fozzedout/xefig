import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../src/app'

function createTestEnv() {
  const requestedPaths: string[] = []

  return {
    requestedPaths,
    env: {
      assets: {} as never,
      metadata: {} as never,
      DB: {} as never,
      SEND_EMAIL: {
        send: async () => {},
      },
      STATIC_ASSETS: {
        fetch: async (request: Request | URL | string) => {
          const url = typeof request === 'string' ? new URL(request) : request instanceof URL ? request : new URL(request.url)
          requestedPaths.push(url.pathname)
          return new Response(`asset:${url.pathname}`, { status: 200 })
        },
      },
    },
  }
}

test('root-level static assets are served by STATIC_ASSETS', async () => {
  const app = createApp()
  const { env, requestedPaths } = createTestEnv()

  const response = await app.fetch(new Request('https://xefig.com/apple-touch-icon.png'), env, {} as never)

  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'asset:/apple-touch-icon.png')
  assert.deepEqual(requestedPaths, ['/apple-touch-icon.png'])
})

test('manifest and service worker requests are served by STATIC_ASSETS', async () => {
  const app = createApp()
  const { env, requestedPaths } = createTestEnv()

  const manifestResponse = await app.fetch(new Request('https://xefig.com/manifest.json'), env, {} as never)
  const swResponse = await app.fetch(new Request('https://xefig.com/sw.js'), env, {} as never)

  assert.equal(manifestResponse.status, 200)
  assert.equal(swResponse.status, 200)
  assert.deepEqual(requestedPaths, ['/manifest.json', '/sw.js'])
})

test('deep bogus paths still do not hit STATIC_ASSETS', async () => {
  const app = createApp()
  const { env, requestedPaths } = createTestEnv()

  const response = await app.fetch(new Request('https://xefig.com/deep/bogus/path.png'), env, {} as never)

  assert.equal(response.status, 404)
  assert.deepEqual(requestedPaths, [])
})

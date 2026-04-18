import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { cors } from 'hono/cors'

import {
  ensureLeaderboardTable,
  ensureSubmissionsTable,
  isLeaderboardDifficulty,
  isLeaderboardGameMode,
} from './lib/leaderboard'
import { ensureContactTable, validateContact as validateContactForm, storeContactMessage } from './lib/contact'
import { registerProfile, linkProfile, pushProfile, pullProfile, type PushInput } from './lib/sync'
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  createAdminSessionToken,
  getAdminSessionSecret,
  verifyAdminSessionToken,
} from './lib/admin-session'
import {
  findNextUnscheduledDate,
  getFileExtension,
  getFileField,
  getPuzzleByDate,
  getStringField,
  getUtcDateKey,
  isValidDateKey,
  parseTagList,
  savePuzzleRecord,
  toCdnUrl,
} from './lib/puzzles'
import {
  listOpenRouterFreeModels,
  maybeRewritePromptPackWithOpenRouter,
  rewriteSinglePromptWithOpenRouter,
} from './lib/prompt-rewriter'
import { generatePromptPacks, generateSingleCategoryPrompt } from './lib/prompts'
import { ensurePuzzleTables, getScheduledDatesInRange } from './lib/puzzle-db'
import {
  handleBatchSubmit,
  handleSingleBatchSubmit,
  handleBatchPoll,
  getBatchJobStatus,
  completeBatchCategory,
  cancelBatchJob,
} from './lib/scheduled'
import {
  CATEGORIES,
  type Bindings,
  type FormValue,
  type PuzzleAsset,
  type PuzzleCategory,
  type PuzzleRecord,
} from './types'

function getSessionCookieOptions(url: string) {
  const requestUrl = new URL(url)
  const isLocalhost = requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1'

  return {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict' as const,
    secure: !isLocalhost,
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  }
}

async function hasAdminSession(env: Bindings, token: string | undefined): Promise<boolean> {
  const secret = getAdminSessionSecret(env)
  if (!secret) {
    return false
  }

  return verifyAdminSessionToken(secret, token)
}

export function createApp() {
  const app = new Hono<{ Bindings: Bindings }>()

  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  )

  app.get('/admin', (c) => c.redirect('/admin-panel'))
  app.get('/admin.html', (c) => c.redirect('/admin-panel'))
  app.get('/admin-portal', (c) => c.redirect('/admin-panel'))

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      today: getUtcDateKey(),
    }),
  )

  // Beta environments don't run the puzzle-generation cron, so their
  // local `puzzles` table stays empty. Fall back to fetching from the
  // live origin (set via UPSTREAM_PUZZLE_ORIGIN) so beta testers see
  // real puzzles without contaminating live writes.
  const fetchUpstreamPuzzle = async (path: string, env: Bindings): Promise<Response | null> => {
    const origin = (env.UPSTREAM_PUZZLE_ORIGIN || '').trim()
    if (!env.IS_BETA || !origin) return null
    try {
      const upstream = await fetch(`${origin}${path}`, {
        headers: { accept: 'application/json' },
      })
      if (!upstream.ok) return null
      const body = await upstream.text()
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, s-maxage=300, max-age=60, stale-while-revalidate=600',
        },
      })
    } catch {
      return null
    }
  }

  app.get('/api/puzzles/today', async (c) => {
    const date = getUtcDateKey()
    const puzzle = await getPuzzleByDate(c.env.DB, date)
    if (!puzzle) {
      const proxied = await fetchUpstreamPuzzle(`/api/puzzles/today`, c.env)
      if (proxied) return proxied
      return c.json(
        {
          error: `No puzzle scheduled for ${date}`,
        },
        404,
      )
    }

    return c.json(puzzle, 200, {
      'cache-control': 'public, s-maxage=300, max-age=60, stale-while-revalidate=600',
    })
  })

  app.get('/api/puzzles/:date', async (c) => {
    const date = c.req.param('date')
    if (!isValidDateKey(date)) {
      return c.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, 400)
    }

    const puzzle = await getPuzzleByDate(c.env.DB, date)
    if (!puzzle) {
      const proxied = await fetchUpstreamPuzzle(`/api/puzzles/${encodeURIComponent(date)}`, c.env)
      if (proxied) return proxied
      return c.json(
        {
          error: `No puzzle scheduled for ${date}`,
        },
        404,
      )
    }

    return c.json(puzzle, 200, {
      'cache-control': 'public, s-maxage=300, max-age=60, stale-while-revalidate=600',
    })
  })

  app.get('/api/admin/puzzles/next-empty', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    const requestedFrom = (c.req.query('from') || '').trim()
    const today = getUtcDateKey()
    const fromDate = requestedFrom || today
    if (!isValidDateKey(fromDate)) {
      return c.json({ error: 'Invalid from date. Use YYYY-MM-DD.' }, 400)
    }

    const scanFrom = fromDate < today ? today : fromDate
    const nextEmptyDate = await findNextUnscheduledDate(c.env.DB, scanFrom, 3650)
    if (!nextEmptyDate) {
      return c.json({ error: 'Unable to find an unscheduled date within the next 3650 days.' }, 404)
    }

    return c.json({
      ok: true,
      from: scanFrom,
      nextEmptyDate,
    })
  })

  app.get('/api/admin/puzzles/overview', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const from = (c.req.query('from') || '').trim()
    const days = Math.min(parseInt(c.req.query('days') || '30', 10) || 30, 365)

    if (!from || !isValidDateKey(from)) {
      return c.json({ error: 'Invalid from date. Use YYYY-MM-DD.' }, 400)
    }

    const toBase = Date.parse(`${from}T00:00:00.000Z`)
    const to = new Date(toBase + (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    await ensurePuzzleTables(c.env.DB)
    const scheduled = await getScheduledDatesInRange(c.env.DB, from, to)

    return c.json({ ok: true, from, to, days, scheduled })
  })

  app.get('/api/admin/session', async (c) => {
    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    const authenticated = await hasAdminSession(c.env, getCookie(c, ADMIN_SESSION_COOKIE))
    return c.json(
      {
        ok: true,
        authenticated,
      },
      200,
      {
        'cache-control': 'no-store',
      },
    )
  })

  app.post('/api/admin/session', async (c) => {
    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    let body: { password?: string } | null = null
    try {
      body = (await c.req.json()) as { password?: string }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const password = typeof body?.password === 'string' ? body.password.trim() : ''
    if (!password || password !== configuredPassword) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Invalid admin password.' }, 401)
    }

    const secret = getAdminSessionSecret(c.env)
    if (!secret) {
      return c.json({ error: 'Admin session secret is not configured.' }, 500)
    }

    const token = await createAdminSessionToken(secret)
    setCookie(c, ADMIN_SESSION_COOKIE, token, getSessionCookieOptions(c.req.url))

    return c.json(
      {
        ok: true,
        authenticated: true,
      },
      200,
      {
        'cache-control': 'no-store',
      },
    )
  })

  app.delete('/api/admin/session', async (c) => {
    deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
    return c.json(
      {
        ok: true,
        authenticated: false,
      },
      200,
      {
        'cache-control': 'no-store',
      },
    )
  })

  app.get('/api/admin/openrouter/free-models', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    try {
      const models = await listOpenRouterFreeModels(c.env)
      return c.json({
        ok: true,
        defaultModel: (c.env.OPENROUTER_MODEL || '').trim() || 'openrouter/free',
        models,
      })
    } catch (error) {
      console.error('OpenRouter model list failed', error)
      const message = error instanceof Error ? error.message : 'Unable to load OpenRouter free models.'
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/admin/puzzles', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json(
        {
          error: 'ADMIN_PASSWORD is not configured.',
        },
        500,
      )
    }

    try {
      const body = (await c.req.parseBody({ all: true })) as Record<string, FormValue>
      const date = getStringField(body.date)?.trim()

      if (!date || !isValidDateKey(date)) {
        return c.json({ error: 'Date is required in YYYY-MM-DD format.' }, 400)
      }

      if (date < getUtcDateKey()) {
        return c.json({ error: 'Cannot schedule puzzles for past dates.' }, 400)
      }

      const existing = await getPuzzleByDate(c.env.DB, date)
      const difficulty = 'adaptive'
      const nextCategories = {} as Record<PuzzleCategory, PuzzleAsset>

      for (const category of CATEGORIES) {
        const catTheme = getStringField(body[`theme-${category}`])?.trim() || ''
        const catTags = parseTagList(getStringField(body[`tags-${category}`]))

        if (!catTheme && !existing?.categories?.[category]?.theme) {
          return c.json({ error: `Theme is required for ${category}.` }, 400)
        }

        const file = getFileField(body[category])
        if (!file || file.size === 0) {
          const existingAsset = existing?.categories?.[category]
          if (!existingAsset) {
            return c.json(
              { error: `Missing image file for "${category}". Upload all images for new dates.` },
              400,
            )
          }
          nextCategories[category] = {
            ...existingAsset,
            theme: catTheme || existingAsset.theme,
            tags: catTags.length > 0 ? catTags : existingAsset.tags,
          }
          continue
        }

        const extension = getFileExtension(file)
        const imageKey = `puzzles/${date}/${category}.${extension}`
        const contentType = file.type || 'application/octet-stream'

        await c.env.assets.put(imageKey, await file.arrayBuffer(), {
          httpMetadata: {
            contentType,
          },
        })

        if (existing?.categories?.[category]?.imageKey) {
          const previousKey = existing.categories[category].imageKey
          if (previousKey !== imageKey) {
            await c.env.assets.delete(previousKey)
          }
        }

        nextCategories[category] = {
          imageKey,
          imageUrl: toCdnUrl(imageKey) + `?v=${Date.now()}`,
          contentType,
          fileName: file.name || `${category}.${extension}`,
          theme: catTheme,
          tags: catTags,
        }
      }

      const now = new Date().toISOString()
      const record: PuzzleRecord = {
        date,
        difficulty,
        categories: nextCategories,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      await savePuzzleRecord(c.env.DB, record)
      return c.json({
        ok: true,
        message: `Puzzle details for ${date} saved.`,
        puzzle: record,
      })
    } catch (error) {
      console.error('Admin upload failed', error)
      return c.json({ error: 'Unable to save puzzle images.' }, 500)
    }
  })

  app.post('/api/admin/puzzles/thumbnail', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    try {
      const body = (await c.req.parseBody({ all: true })) as Record<string, FormValue>
      const date = getStringField(body.date)?.trim()
      const category = getStringField(body.category)?.trim() as PuzzleCategory

      if (!date || !isValidDateKey(date)) {
        return c.json({ error: 'Date is required in YYYY-MM-DD format.' }, 400)
      }
      if (!CATEGORIES.includes(category)) {
        return c.json({ error: 'Invalid category.' }, 400)
      }

      const file = getFileField(body.thumbnail)
      if (!file || file.size === 0) {
        return c.json({ error: 'Thumbnail file is required.' }, 400)
      }

      const existing = await getPuzzleByDate(c.env.DB, date)
      if (!existing) {
        return c.json({ error: `No puzzle found for ${date}.` }, 404)
      }

      const asset = existing.categories[category]
      if (!asset) {
        return c.json({ error: `No ${category} asset found for ${date}.` }, 404)
      }

      const thumbKey = `puzzles/${date}/${category}_thumb.jpg`
      await c.env.assets.put(thumbKey, await file.arrayBuffer(), {
        httpMetadata: { contentType: 'image/jpeg' },
      })

      asset.thumbnailKey = thumbKey
      asset.thumbnailUrl = toCdnUrl(thumbKey) + `?v=${Date.now()}`
      existing.updatedAt = new Date().toISOString()

      await savePuzzleRecord(c.env.DB, existing)

      return c.json({
        ok: true,
        category,
        date,
        thumbnailUrl: asset.thumbnailUrl,
      })
    } catch (error) {
      console.error('Thumbnail upload failed', error)
      return c.json({ error: 'Unable to save thumbnail.' }, 500)
    }
  })

  app.post('/api/admin/generate-images', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    if (!c.env.GOOGLE_AI_API_KEY) {
      return c.json({ error: 'GOOGLE_AI_API_KEY is not configured.' }, 500)
    }

    try {
      let body: {
        date?: string
        force?: boolean
        prompts?: Record<string, { prompt: string; theme: string; keywords: string[] }>
      } | null = null
      try {
        body = (await c.req.json()) as typeof body
      } catch {
        // No body is fine — falls back to next unscheduled date
      }
      const date = typeof body?.date === 'string' ? body.date.trim() : undefined
      const force = body?.force === true
      const prompts = body?.prompts

      const result = await handleBatchSubmit(c.env, { date, force, prompts })
      return c.json({ ok: result.submitted, ...result })
    } catch (error) {
      console.error('Batch submit failed', error)
      const message = error instanceof Error ? error.message : 'Batch submit failed.'
      return c.json({ error: message }, 500)
    }
  })

  app.post('/api/admin/generate-images/single', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    if (!c.env.GOOGLE_AI_API_KEY) {
      return c.json({ error: 'GOOGLE_AI_API_KEY is not configured.' }, 500)
    }

    try {
      const body = (await c.req.json()) as {
        category?: string
        prompt?: string
        theme?: string
        keywords?: string[]
        date?: string
        force?: boolean
      }

      const category = body?.category?.trim() as PuzzleCategory
      if (!CATEGORIES.includes(category)) {
        return c.json({ error: 'Invalid category.' }, 400)
      }

      const prompt = body?.prompt?.trim()
      if (!prompt) {
        return c.json({ error: 'Prompt is required.' }, 400)
      }

      const theme = body?.theme?.trim() || category
      const keywords = Array.isArray(body?.keywords) ? body.keywords : []
      const date = typeof body?.date === 'string' ? body.date.trim() : undefined
      const force = body?.force === true

      const result = await handleSingleBatchSubmit(c.env, {
        category,
        prompt,
        theme,
        keywords,
        date,
        force,
      })
      return c.json({ ok: result.submitted, ...result })
    } catch (error) {
      console.error('Single batch submit failed', error)
      const message = error instanceof Error ? error.message : 'Single batch submit failed.'
      return c.json({ error: message }, 500)
    }
  })

  app.post('/api/admin/generate-images/poll', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    if (!c.env.GOOGLE_AI_API_KEY) {
      return c.json({ error: 'GOOGLE_AI_API_KEY is not configured.' }, 500)
    }

    try {
      const result = await handleBatchPoll(c.env)
      return c.json({ ok: true, ...result })
    } catch (error) {
      console.error('Batch poll failed', error)
      const message = error instanceof Error ? error.message : 'Batch poll failed.'
      return c.json({ error: message }, 500)
    }
  })

  app.get('/api/admin/generate-images/status', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const status = await getBatchJobStatus(c.env)
    return c.json({ ok: true, ...status })
  })

  app.post('/api/admin/generate-images/complete-category', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    try {
      const body = (await c.req.parseBody({ all: true })) as Record<string, FormValue>
      const category = getStringField(body.category)?.trim() as PuzzleCategory
      const targetDate = getStringField(body.targetDate)?.trim() || getStringField(body.date)?.trim()

      if (!CATEGORIES.includes(category)) {
        return c.json({ error: 'Invalid category.' }, 400)
      }

      const imageFile = getFileField(body.image)
      const thumbFile = getFileField(body.thumbnail)

      if (!imageFile || imageFile.size === 0) {
        return c.json({ error: 'Image file is required.' }, 400)
      }
      if (!thumbFile || thumbFile.size === 0) {
        return c.json({ error: 'Thumbnail file is required.' }, 400)
      }

      const result = await completeBatchCategory(
        c.env,
        category,
        await imageFile.arrayBuffer(),
        await thumbFile.arrayBuffer(),
        targetDate && isValidDateKey(targetDate) ? targetDate : undefined,
      )

      return c.json(result)
    } catch (error) {
      console.error('Complete category failed', error)
      const message = error instanceof Error ? error.message : 'Failed to complete category.'
      return c.json({ error: message }, 500)
    }
  })

  app.post('/api/admin/generate-images/cancel', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    try {
      const body = (await c.req.json()) as {
        batchName?: string
        targetDate?: string
        date?: string
      }
      const batchName = typeof body.batchName === 'string' ? body.batchName.trim() : ''
      const rawDate = (body.targetDate || body.date || '').trim()
      const targetDate = isValidDateKey(rawDate) ? rawDate : ''
      if (!batchName && !targetDate) {
        return c.json({ error: 'Provide batchName (preferred) or targetDate.' }, 400)
      }
      const result = await cancelBatchJob(c.env, {
        batchName: batchName || undefined,
        targetDate: targetDate || undefined,
      })
      return c.json(result, result.ok ? 200 : 404)
    } catch (error) {
      console.error('Cancel batch job failed', error)
      const message = error instanceof Error ? error.message : 'Failed to cancel batch job.'
      return c.json({ error: message }, 500)
    }
  })

  app.post('/api/admin/prompts/generate', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    let body: { model?: string } | null = null
    try {
      body = (await c.req.json()) as { model?: string }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : ''

    const prompts = await generatePromptPacks(c.env.DB, 1)
    let rewrite = {
      attempted: false,
      applied: false,
      model: null as string | null,
      error: null as string | null,
    }

    const firstPack = prompts[0]
    if (firstPack) {
      const rewriteResult = await maybeRewritePromptPackWithOpenRouter(c.env, firstPack, requestedModel)
      prompts[0] = rewriteResult.pack
      if (rewriteResult.attempted && rewriteResult.error) {
        console.warn('Prompt rewrite failed', {
          model: rewriteResult.model,
          error: rewriteResult.error,
        })
      }
      rewrite = {
        attempted: rewriteResult.attempted,
        applied: rewriteResult.applied,
        model: rewriteResult.model,
        error: rewriteResult.error,
      }
    }

    return c.json({
      ok: true,
      prompts,
      promptRewrite: rewrite,
    })
  })

  app.post('/api/admin/prompts/generate-one', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    let body: { category?: string } | null = null
    try {
      body = (await c.req.json()) as { category?: string }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const category = (body?.category || '').trim() as PuzzleCategory
    if (!CATEGORIES.includes(category)) {
      return c.json({ error: 'Invalid category.' }, 400)
    }

    try {
      const details = await generateSingleCategoryPrompt(c.env.DB, category)
      return c.json({
        ok: true,
        category,
        ...details,
      })
    } catch (error) {
      console.error('Single category generation failed', error)
      return c.json({ error: 'Failed to generate category prompt.' }, 500)
    }
  })

  app.post('/api/admin/prompts/rewrite-one', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    let body:
      | {
          category?: string
          prompt?: string
          theme?: string
          tags?: string
          model?: string
        }
      | null = null

    try {
      body = (await c.req.json()) as {
        category?: string
        prompt?: string
        theme?: string
        tags?: string
        model?: string
      }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const categoryRaw = typeof body?.category === 'string' ? body.category.trim() : ''
    const category = CATEGORIES.find((item) => item === categoryRaw)
    if (!category) {
      return c.json({ error: 'Invalid prompt category.' }, 400)
    }

    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) {
      return c.json({ error: 'Prompt text is required.' }, 400)
    }

    const model = typeof body?.model === 'string' ? body.model.trim() : ''

    const rewritten = await rewriteSinglePromptWithOpenRouter(c.env, {
      category,
      prompt,
      theme: typeof body?.theme === 'string' ? body.theme : undefined,
      keywords: typeof body?.tags === 'string' ? parseTagList(body.tags) : undefined,
      model,
    })

    if (!rewritten.attempted) {
      return c.json({ error: rewritten.error || 'Prompt rewrite is unavailable.' }, 500)
    }

    if (!rewritten.applied || !rewritten.prompt) {
      return c.json({ error: rewritten.error || 'Unable to rewrite prompt.' }, 502)
    }

    return c.json({
      ok: true,
      category,
      model: rewritten.model,
      prompt: rewritten.prompt,
    })
  })

  app.get('/api/leaderboard/:date', async (c) => {
    const date = c.req.param('date')
    if (!isValidDateKey(date)) {
      return c.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, 400)
    }

    const gameModeRaw = (c.req.query('gameMode') || c.req.query('mode') || 'jigsaw').trim()
    if (!isLeaderboardGameMode(gameModeRaw)) {
      return c.json({ error: 'Invalid gameMode.' }, 400)
    }

    const difficultyRaw = c.req.query('difficulty') || 'easy'
    if (!isLeaderboardDifficulty(difficultyRaw)) {
      return c.json({ error: 'Invalid difficulty.' }, 400)
    }

    const limitRaw = Number(c.req.query('limit') || 20)
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 20))

    try {
      await ensureLeaderboardTable(c.env.DB)
      const rows = await c.env.DB.prepare(
        `
        SELECT l.player_guid, l.elapsed_ms, l.submitted_at, p.profile_name
        FROM puzzle_leaderboard l
        LEFT JOIN player_profiles p ON p.player_guid = l.player_guid
        WHERE l.puzzle_date = ? AND l.difficulty = ? AND l.game_mode = ?
        ORDER BY l.elapsed_ms ASC, l.submitted_at ASC
        LIMIT ?
        `,
      )
        .bind(date, difficultyRaw, gameModeRaw, limit)
        .all<{
          player_guid: string
          elapsed_ms: number
          submitted_at: string
          profile_name: string | null
        }>()

      const entries = (rows.results || []).map((entry, index) => ({
        rank: index + 1,
        playerGuid: entry.player_guid,
        elapsedMs: entry.elapsed_ms,
        submittedAt: entry.submitted_at,
        profileName: (entry.profile_name || '').trim() || null,
      }))

      const totalRow = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM puzzle_leaderboard
         WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ?`,
      )
        .bind(date, difficultyRaw, gameModeRaw)
        .first<{ total: number }>()

      return c.json({
        ok: true,
        date,
        gameMode: gameModeRaw,
        difficulty: difficultyRaw,
        entries,
        totalEntries: Number(totalRow?.total || entries.length),
      })
    } catch (error) {
      console.error('Leaderboard fetch failed', error)
      return c.json({ error: 'Unable to load leaderboard.' }, 500)
    }
  })

  app.post('/api/leaderboard/submit', async (c) => {
    let body:
      | {
          puzzleDate?: string
          gameMode?: string
          difficulty?: string
          playerGuid?: string
          elapsedMs?: number
        }
      | null = null
    try {
      body = (await c.req.json()) as {
        puzzleDate?: string
        gameMode?: string
        difficulty?: string
        playerGuid?: string
        elapsedMs?: number
      }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const puzzleDate = (body?.puzzleDate || '').trim()
    const gameMode = (body?.gameMode || 'jigsaw').trim()
    const difficulty = (body?.difficulty || '').trim()
    const playerGuid = (body?.playerGuid || '').trim()
    const elapsedMs = Number(body?.elapsedMs)

    if (!isValidDateKey(puzzleDate)) {
      return c.json({ error: 'Invalid puzzleDate. Use YYYY-MM-DD.' }, 400)
    }
    if (!isLeaderboardDifficulty(difficulty)) {
      return c.json({ error: 'Invalid difficulty.' }, 400)
    }
    if (!isLeaderboardGameMode(gameMode)) {
      return c.json({ error: 'Invalid gameMode.' }, 400)
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(playerGuid)) {
      return c.json({ error: 'Invalid playerGuid.' }, 400)
    }
    // Floor at 1s — no puzzle mode is completable in under a second; a
    // value below that is a timer-race artifact (was leaking through as
    // 00:00 on the menu pill while the leaderboard showed the real time).
    if (!Number.isFinite(elapsedMs) || elapsedMs < 1000 || elapsedMs > 24 * 60 * 60 * 1000) {
      return c.json({ error: 'Invalid elapsedMs.' }, 400)
    }

    try {
      await ensureLeaderboardTable(c.env.DB)
      await ensureSubmissionsTable(c.env.DB)

      // Capture the player's stored best BEFORE the upsert so the
      // response can tell the UI whether this attempt set a new PB,
      // tied, or was off by N seconds.
      const previousBestRow = await c.env.DB.prepare(
        `SELECT elapsed_ms FROM puzzle_leaderboard
         WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ? AND player_guid = ?
         LIMIT 1`,
      )
        .bind(puzzleDate, difficulty, gameMode, playerGuid)
        .first<{ elapsed_ms: number }>()
      const previousBestMs = previousBestRow ? Number(previousBestRow.elapsed_ms) : null

      // Keep the player's BEST time across re-submissions so a slower
      // replay can't tank the leaderboard rank. The current submission
      // rank is reported separately in the response so the UI can still
      // show where *this* attempt would have placed.
      await c.env.DB.prepare(
        `
        INSERT INTO puzzle_leaderboard (puzzle_date, difficulty, game_mode, player_guid, elapsed_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(puzzle_date, difficulty, game_mode, player_guid)
        DO UPDATE SET
          elapsed_ms = MIN(excluded.elapsed_ms, puzzle_leaderboard.elapsed_ms),
          submitted_at = datetime('now')
        `,
      )
        .bind(puzzleDate, difficulty, gameMode, playerGuid, Math.round(elapsedMs))
        .run()

      // Append to the per-attempt log (insert-only, not read on the
      // leaderboard hot path). Non-fatal if it fails so the player's
      // leaderboard submission still succeeds.
      try {
        await c.env.DB.prepare(
          `INSERT INTO puzzle_submissions (puzzle_date, difficulty, game_mode, player_guid, elapsed_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
          .bind(puzzleDate, difficulty, gameMode, playerGuid, Math.round(elapsedMs))
          .run()
      } catch (submissionErr) {
        console.error('puzzle_submissions insert failed', submissionErr)
      }

      const personal = await c.env.DB.prepare(
        `
        SELECT elapsed_ms
        FROM puzzle_leaderboard
        WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ? AND player_guid = ?
        LIMIT 1
        `,
      )
        .bind(puzzleDate, difficulty, gameMode, playerGuid)
        .first<{ elapsed_ms: number }>()

      const bestMs = personal?.elapsed_ms ?? Math.round(elapsedMs)

      const rankRow = await c.env.DB.prepare(
        `
        SELECT 1 + COUNT(*) AS rank
        FROM puzzle_leaderboard
        WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ? AND elapsed_ms < ?
        `,
      )
        .bind(puzzleDate, difficulty, gameMode, bestMs)
        .first<{ rank: number }>()

      // submissionRank = where the player WOULD sit if this attempt's
      // elapsed were what the leaderboard stored. On live this usually
      // equals bestRank (MIN-wins makes submission == best post-upsert);
      // diverges only when the attempt was slower than the stored best.
      const submissionElapsedMs = Math.round(elapsedMs)
      let submissionRank = Number(rankRow?.rank || 1)
      if (submissionElapsedMs !== bestMs) {
        const subRankRow = await c.env.DB.prepare(
          `
          SELECT 1 + COUNT(*) AS rank
          FROM puzzle_leaderboard
          WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ? AND elapsed_ms < ?
          `,
        )
          .bind(puzzleDate, difficulty, gameMode, submissionElapsedMs)
          .first<{ rank: number }>()
        submissionRank = Number(subRankRow?.rank || submissionRank)
      }

      // Total entries for "Rank #N of TOTAL" display.
      const totalRow = await c.env.DB.prepare(
        `SELECT COUNT(*) AS total FROM puzzle_leaderboard
         WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ?`,
      )
        .bind(puzzleDate, difficulty, gameMode)
        .first<{ total: number }>()

      return c.json({
        ok: true,
        puzzleDate,
        gameMode,
        difficulty,
        playerGuid,
        bestMs,
        previousBestMs,
        rank: Number(rankRow?.rank || 1),
        submissionElapsedMs,
        submissionRank,
        totalEntries: Number(totalRow?.total || 0),
      })
    } catch (error) {
      console.error('Leaderboard submit failed', error)
      return c.json({ error: 'Unable to submit leaderboard entry.' }, 500)
    }
  })

  // ─── Admin: Contact Messages ───

  app.get('/api/admin/messages', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    try {
      await ensureContactTable(c.env.DB)
      const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
      const offset = Math.max(0, Number(c.req.query('offset')) || 0)

      const rows = await c.env.DB.prepare(
        `SELECT id, name, email, message, ip, submitted_at FROM contact_messages ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
        .bind(limit, offset)
        .all<{ id: number; name: string; email: string; message: string; ip: string; submitted_at: string }>()

      const countRow = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM contact_messages`).first<{ total: number }>()

      return c.json({
        ok: true,
        messages: rows.results || [],
        total: countRow?.total ?? 0,
      })
    } catch (error) {
      console.error('Messages list failed', error)
      return c.json({ error: 'Unable to load messages.' }, 500)
    }
  })

  app.delete('/api/admin/messages/:id', async (c) => {
    const token = getCookie(c, ADMIN_SESSION_COOKIE)
    if (!(await hasAdminSession(c.env, token))) {
      deleteCookie(c, ADMIN_SESSION_COOKIE, { path: '/' })
      return c.json({ error: 'Admin session required.' }, 401)
    }

    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: 'Invalid message ID.' }, 400)
    }

    try {
      await c.env.DB.prepare(`DELETE FROM contact_messages WHERE id = ?`).bind(id).run()
      return c.json({ ok: true })
    } catch (error) {
      console.error('Message delete failed', error)
      return c.json({ error: 'Unable to delete message.' }, 500)
    }
  })

  // ─── Public: Contact Form ───

  app.post('/api/contact', async (c) => {
    let body: { name?: string; email?: string; message?: string; website?: string; _ts?: number } | null = null
    try {
      body = (await c.req.json()) as { name?: string; email?: string; message?: string; website?: string; _ts?: number }
    } catch {
      return c.json({ error: 'Invalid request.' }, 400)
    }

    const validation = validateContactForm(body || {})
    if (!validation.valid) {
      return c.json({ error: validation.error }, 400)
    }

    const name = (body?.name || '').trim()
    const email = (body?.email || '').trim()
    const message = (body?.message || '').trim()
    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null

    try {
      await storeContactMessage(c.env.DB, name, email, message, ip)

      // Attempt to send email notification
      try {
        const recipient = (c.env.CONTACT_EMAIL || '').trim()
        if (recipient && c.env.SEND_EMAIL) {
          const { createMimeMessage } = await import('mimetext')
          const msg = createMimeMessage()
          msg.setSender({ name: 'Xefig Contact', addr: 'noreply@xefig.com' })
          msg.setRecipient(recipient)
          msg.setSubject(`Xefig Contact: ${name}`)
          msg.addMessage({
            contentType: 'text/plain',
            data: `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}\n\n---\nIP: ${ip || 'unknown'}\nDate: ${new Date().toISOString()}`,
          })
          const { EmailMessage } = await import('cloudflare:email')
          const emailMsg = new EmailMessage('noreply@xefig.com', recipient, msg.asRaw())
          await c.env.SEND_EMAIL.send(emailMsg)
        }
      } catch (emailErr) {
        console.error('Contact email send failed (message still saved)', emailErr)
      }

      return c.json({ ok: true, message: 'Thank you! Your message has been sent.' })
    } catch (error) {
      console.error('Contact form failed', error)
      return c.json({ error: 'Unable to send message. Please try again.' }, 500)
    }
  })

  // ─── Sync: Anonymous Profile Sharing ───

  app.post('/api/sync/register', async (c) => {
    let body: { playerGuid?: string } | null = null
    try {
      body = (await c.req.json()) as { playerGuid?: string }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const playerGuid = (body?.playerGuid || '').trim()
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(playerGuid)) {
      return c.json({ error: 'Invalid playerGuid.' }, 400)
    }

    try {
      const result = await registerProfile(c.env.DB, playerGuid)
      return c.json(result)
    } catch (error) {
      console.error('Sync register failed', error)
      return c.json({ error: 'Unable to register profile.' }, 500)
    }
  })

  app.post('/api/sync/link', async (c) => {
    let body: { shareCode?: string } | null = null
    try {
      body = (await c.req.json()) as { shareCode?: string }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const shareCode = (body?.shareCode || '').trim().toUpperCase()
    if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(shareCode)) {
      return c.json({ error: 'Invalid share code format.' }, 400)
    }

    try {
      const result = await linkProfile(c.env.DB, shareCode)
      if (!result) {
        return c.json({ error: 'Share code not found.' }, 404)
      }
      return c.json(result)
    } catch (error) {
      console.error('Sync link failed', error)
      return c.json({ error: 'Unable to link profile.' }, 500)
    }
  })

  app.post('/api/sync/push', async (c) => {
    let body: Record<string, unknown> | null = null
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const playerGuid = String(body?.playerGuid || '').trim()
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(playerGuid)) {
      return c.json({ error: 'Invalid playerGuid.' }, 400)
    }

    const input: PushInput = {
      playerGuid,
      baseRevision: Number(body?.baseRevision) || 0,
    }

    if (body?.settings && typeof body.settings === 'object') {
      input.settings = body.settings as PushInput['settings']
    }
    if (Array.isArray(body?.completedRuns)) {
      input.completedRuns = body.completedRuns as PushInput['completedRuns']
    }
    if (Array.isArray(body?.activeRuns)) {
      input.activeRuns = body.activeRuns as PushInput['activeRuns']
    }
    if (Array.isArray(body?.deletedActiveRuns)) {
      input.deletedActiveRuns = body.deletedActiveRuns as PushInput['deletedActiveRuns']
    }

    if (
      !input.settings &&
      (!input.completedRuns || input.completedRuns.length === 0) &&
      (!input.activeRuns || input.activeRuns.length === 0) &&
      (!input.deletedActiveRuns || input.deletedActiveRuns.length === 0)
    ) {
      return c.json({ error: 'No changes provided.' }, 400)
    }

    try {
      const result = await pushProfile(c.env.DB, input)
      if ('notFound' in result) {
        return c.json({ error: 'Profile not found. Register first.' }, 404)
      }
      return c.json(result)
    } catch (error) {
      console.error('Sync push failed', error)
      return c.json({ error: 'Unable to save profile.' }, 500)
    }
  })

  app.post('/api/sync/pull', async (c) => {
    let body: { playerGuid?: string; revision?: number } | null = null
    try {
      body = (await c.req.json()) as { playerGuid?: string; revision?: number }
    } catch {
      return c.json({ error: 'Invalid JSON body.' }, 400)
    }

    const playerGuid = (body?.playerGuid || '').trim()
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(playerGuid)) {
      return c.json({ error: 'Invalid playerGuid.' }, 400)
    }

    try {
      const knownRevision = Math.max(0, Number(body?.revision) || 0)
      const result = await pullProfile(c.env.DB, playerGuid, knownRevision)
      if (!result) {
        return c.json({ notFound: true })
      }
      return c.json(result)
    } catch (error) {
      console.error('Sync pull failed', error)
      return c.json({ error: 'Unable to load profile.' }, 500)
    }
  })

  app.get('/cdn/*', async (c) => {
    const pathname = new URL(c.req.url).pathname
    const encodedKey = pathname.replace(/^\/cdn\//, '')
    const key = decodeURIComponent(encodedKey)

    if (!key) {
      return c.text('Bad Request', 400)
    }

    const object = await c.env.assets.get(key)
    if (!object?.body) {
      return c.text('Not Found', 404)
    }

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    if (object.httpEtag) {
      headers.set('etag', object.httpEtag)
    }
    headers.set('cache-control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=43200')
    headers.set('access-control-allow-origin', '*')

    return new Response(object.body, { headers })
  })

  app.notFound(async (c) => {
    const pathname = new URL(c.req.url).pathname

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return c.json({ error: 'Not Found' }, 404)
    }
    if (pathname === '/cdn' || pathname.startsWith('/cdn/')) {
      return c.text('Not Found', 404)
    }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.text('Not Found', 404)
    }

    // Only try static assets for paths that could plausibly be ours:
    // single-segment root files (manifest, icons, service worker, etc.)
    // and /assets/*. Skip everything else to avoid wasting resources on
    // bot traffic hitting deep bogus paths.
    const isAppRoute = pathname === '/' || pathname === '/admin-panel' || pathname === '/admin-panel.html'

    // With html_handling=none, rewrite extensionless app routes to .html
    if (pathname === '/' || pathname === '/admin-panel') {
      const url = new URL(c.req.url)
      url.pathname = pathname === '/' ? '/index.html' : '/admin-panel.html'
      return c.env.STATIC_ASSETS.fetch(new Request(url, c.req.raw))
    }
    const isRootStaticAsset = /^\/[^/]+\.[a-z0-9]+$/i.test(pathname)
    const isStaticAsset = isRootStaticAsset || pathname.startsWith('/assets/')
    if (isAppRoute || isStaticAsset) {
      const response = await c.env.STATIC_ASSETS.fetch(c.req.raw)
      if (response.status !== 404) {
        // Hashed assets (/assets/*) are immutable — cache for 1 year
        if (pathname.startsWith('/assets/')) {
          const cached = new Response(response.body, response)
          cached.headers.set('cache-control', 'public, max-age=31536000, immutable')
          return cached
        }
        return response
      }
    }

    return c.html('<!DOCTYPE html><html><head><meta charset="utf-8"><title>404</title></head><body><h1>404</h1><p>Page not found.</p></body></html>', 404)
  })

  return app
}

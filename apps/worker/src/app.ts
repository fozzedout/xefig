import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { cors } from 'hono/cors'

import { ensureLeaderboardTable, isLeaderboardDifficulty, isLeaderboardGameMode } from './lib/leaderboard'
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
  toCdnUrl,
  toPuzzleKey,
} from './lib/puzzles'
import {
  listOpenRouterFreeModels,
  maybeRewritePromptPackWithOpenRouter,
  rewriteSinglePromptWithOpenRouter,
} from './lib/prompt-rewriter'
import { generatePromptPacks, generateSingleCategoryPrompt } from './lib/prompts'
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

  app.get('/api/puzzles/today', async (c) => {
    const date = getUtcDateKey()
    const puzzle = await getPuzzleByDate(c.env.metadata, date)
    if (!puzzle) {
      return c.json(
        {
          error: `No puzzle scheduled for ${date}`,
        },
        404,
      )
    }

    return c.json(puzzle)
  })

  app.get('/api/puzzles/:date', async (c) => {
    const date = c.req.param('date')
    if (!isValidDateKey(date)) {
      return c.json({ error: 'Invalid date format. Use YYYY-MM-DD.' }, 400)
    }

    const puzzle = await getPuzzleByDate(c.env.metadata, date)
    if (!puzzle) {
      return c.json(
        {
          error: `No puzzle scheduled for ${date}`,
        },
        404,
      )
    }

    return c.json(puzzle)
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
    const nextEmptyDate = await findNextUnscheduledDate(c.env.metadata, scanFrom, 3650)
    if (!nextEmptyDate) {
      return c.json({ error: 'Unable to find an unscheduled date within the next 3650 days.' }, 404)
    }

    return c.json({
      ok: true,
      from: scanFrom,
      nextEmptyDate,
    })
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

      const existing = await getPuzzleByDate(c.env.metadata, date)
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
          imageUrl: toCdnUrl(imageKey),
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

      await c.env.metadata.put(toPuzzleKey(date), JSON.stringify(record))
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

    const prompts = await generatePromptPacks(c.env.metadata, 1)
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
      const details = await generateSingleCategoryPrompt(c.env.metadata, category)
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
        SELECT player_guid, elapsed_ms, submitted_at
        FROM puzzle_leaderboard
        WHERE puzzle_date = ? AND difficulty = ? AND game_mode = ?
        ORDER BY elapsed_ms ASC, submitted_at ASC
        LIMIT ?
        `,
      )
        .bind(date, difficultyRaw, gameModeRaw, limit)
        .all<{
          player_guid: string
          elapsed_ms: number
          submitted_at: string
        }>()

      const entries = (rows.results || []).map((entry, index) => ({
        rank: index + 1,
        playerGuid: entry.player_guid,
        elapsedMs: entry.elapsed_ms,
        submittedAt: entry.submitted_at,
      }))

      return c.json({
        ok: true,
        date,
        gameMode: gameModeRaw,
        difficulty: difficultyRaw,
        entries,
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
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || elapsedMs > 24 * 60 * 60 * 1000) {
      return c.json({ error: 'Invalid elapsedMs.' }, 400)
    }

    try {
      await ensureLeaderboardTable(c.env.DB)
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

      return c.json({
        ok: true,
        puzzleDate,
        gameMode,
        difficulty,
        playerGuid,
        bestMs,
        rank: Number(rankRow?.rank || 1),
      })
    } catch (error) {
      console.error('Leaderboard submit failed', error)
      return c.json({ error: 'Unable to submit leaderboard entry.' }, 500)
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
    headers.set('cache-control', 'public, max-age=3600')

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

    const response = await c.env.STATIC_ASSETS.fetch(c.req.raw)
    if (response.status === 404) {
      return c.text('Not Found', 404)
    }
    return response
  })

  return app
}

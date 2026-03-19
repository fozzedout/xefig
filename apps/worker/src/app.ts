import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { ensureLeaderboardTable, isLeaderboardDifficulty, isLeaderboardGameMode } from './lib/leaderboard'
import {
  findNextUnscheduledDate,
  formatThemeFromTags,
  getFileExtension,
  getFileField,
  getPuzzleByDate,
  getStringField,
  getUtcDateKey,
  isValidDateKey,
  normalizeTags,
  parseTagList,
  toCdnUrl,
  toPuzzleKey,
} from './lib/puzzles'
import { generatePromptPacks } from './lib/prompts'
import {
  CATEGORIES,
  type Bindings,
  type FormValue,
  type PromptPack,
  type PuzzleAsset,
  type PuzzleCategory,
  type PuzzleRecord,
} from './types'

export function createApp() {
  const app = new Hono<{ Bindings: Bindings }>()

  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
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
    const configuredPassword = c.env.ADMIN_PASSWORD
    if (!configuredPassword) {
      return c.json({ error: 'ADMIN_PASSWORD is not configured.' }, 500)
    }

    const password = (c.req.header('x-admin-password') || '').trim()
    if (!password || password !== configuredPassword) {
      return c.json({ error: 'Invalid admin password.' }, 401)
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

  app.post('/api/admin/puzzles', async (c) => {
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
      const password = getStringField(body.password)

      if (!password || password !== configuredPassword) {
        return c.json({ error: 'Invalid admin password.' }, 401)
      }

      const date = getStringField(body.date)?.trim()
      const providedTags = parseTagList(getStringField(body.tags))

      if (!date || !isValidDateKey(date)) {
        return c.json({ error: 'Date is required in YYYY-MM-DD format.' }, 400)
      }

      if (date < getUtcDateKey()) {
        return c.json({ error: 'Cannot schedule puzzles for past dates.' }, 400)
      }

      const existing = await getPuzzleByDate(c.env.metadata, date)
      const providedTheme = getStringField(body.theme)?.trim() || ''
      let generatedPack: PromptPack | null = null
      let tags = providedTags
      if (tags.length === 0) {
        tags = normalizeTags(existing?.tags ?? [])
        if (tags.length === 0) {
          const packs = await generatePromptPacks(c.env.metadata, 1)
          generatedPack = packs[0] ?? null
          tags = normalizeTags(generatedPack?.keywords ?? [])
        }
      }
      if (tags.length === 0) {
        return c.json({ error: 'Unable to determine puzzle tags.' }, 500)
      }
      const theme = providedTheme || existing?.theme || generatedPack?.themeName || formatThemeFromTags(tags)

      const difficulty = 'adaptive'

      const nextCategories = {} as Record<PuzzleCategory, PuzzleAsset>

      for (const category of CATEGORIES) {
        const file = getFileField(body[category])
        if (!file || file.size === 0) {
          const existingAsset = existing?.categories?.[category]
          if (!existingAsset) {
            return c.json(
              { error: `Missing image file for "${category}". Upload all images for new dates.` },
              400,
            )
          }
          nextCategories[category] = existingAsset
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
        }
      }

      const now = new Date().toISOString()
      const record: PuzzleRecord = {
        date,
        theme,
        tags,
        difficulty,
        categories: nextCategories,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }

      await c.env.metadata.put(toPuzzleKey(date), JSON.stringify(record))
      return c.json({
        ok: true,
        message: `Puzzle details for ${date} saved.`,
        generatedTheme: generatedPack?.themeName ?? null,
        puzzle: record,
      })
    } catch (error) {
      console.error('Admin upload failed', error)
      return c.json({ error: 'Unable to save puzzle images.' }, 500)
    }
  })

  app.post('/api/admin/prompts/generate', async (c) => {
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

    const password = typeof body?.password === 'string' ? body.password : ''
    if (!password || password !== configuredPassword) {
      return c.json({ error: 'Invalid admin password.' }, 401)
    }

    const prompts = await generatePromptPacks(c.env.metadata, 1)
    return c.json({
      ok: true,
      prompts,
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

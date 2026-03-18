import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  assets: R2Bucket
  metadata: KVNamespace
  DB: D1Database
  STATIC_ASSETS: Fetcher
  ADMIN_PASSWORD?: string
}

const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram'] as const
type PuzzleCategory = (typeof CATEGORIES)[number]
type FormValue = string | File | Array<string | File>
const LEADERBOARD_DIFFICULTIES = ['easy', 'medium', 'hard', 'extreme'] as const
type LeaderboardDifficulty = (typeof LEADERBOARD_DIFFICULTIES)[number]

type PuzzleAsset = {
  imageKey: string
  imageUrl: string
  contentType: string
  fileName: string
}

type PuzzleRecord = {
  date: string
  theme: string
  tags: string[]
  difficulty: string
  categories: Record<PuzzleCategory, PuzzleAsset>
  createdAt: string
  updatedAt: string
}

const PUZZLE_KEY_PREFIX = 'puzzle:'
const PROMPT_HISTORY_KEY = 'prompt-history:v1'
const PROMPT_HISTORY_LIMIT = 260

type PromptHistoryItem = {
  descriptors: string[]
  createdAt: string
}

type PromptPack = {
  themeName: string
  keywords: string[]
  prompts: Record<PuzzleCategory, string>
}

const MIN_DESCRIPTOR_POOL_SIZE = 100
const DESCRIPTORS_PER_PACK = 10

const DESCRIPTOR_POOL = [
  'floating market at sunrise',
  'clockwork tower interior',
  'bioluminescent forest clearing',
  'desert observatory ruins',
  'rain-soaked neon alley',
  'glacier cave sanctuary',
  'coral reef transit hub',
  'cliffside monastery bridge',
  'retro arcade boulevard',
  'sky island greenhouse',
  'ancient library atrium',
  'volcanic orchard terraces',
  'festival harbor promenade',
  'mountain rail station',
  'submerged cathedral nave',
  'glass foundry workshop',
  'tea house by waterfall',
  'tidal wind farm coast',
  'lunar dockyard gantries',
  'sunken palace courtyard',
  'misty pine valley',
  'tropical storm horizon',
  'spring blossom avenue',
  'winter dawn stillness',
  'golden hour sunlight',
  'moonlit reflections',
  'dramatic thunderclouds',
  'soft overcast lighting',
  'crisp desert air',
  'after-rain shimmer',
  'warm tungsten glow',
  'cool cyan shadows',
  'amber rim light',
  'dappled canopy light',
  'high contrast lighting',
  'diffused cinematic haze',
  'subsurface underwater rays',
  'volumetric god rays',
  'silhouette backlighting',
  'low key lighting',
  'uplifting adventurous mood',
  'cozy nostalgic mood',
  'mysterious tense mood',
  'playful whimsical mood',
  'serene meditative mood',
  'heroic epic mood',
  'dreamlike surreal mood',
  'hopeful optimistic mood',
  'moody noir tone',
  'bright celebratory tone',
  'stylized illustration',
  'high detail concept art',
  'matte painting finish',
  'storybook painting style',
  'watercolor wash texture',
  'ink linework accents',
  'gouache brush strokes',
  'oil paint texture',
  'clean vector style',
  'isometric scene design',
  'tileable visual rhythm',
  'clear foreground middle background',
  'strong depth perspective',
  'centered focal subject',
  'rule of thirds framing',
  'symmetrical composition',
  'diagonal leading lines',
  'wide panoramic framing',
  'overhead birds-eye angle',
  'low angle grandeur',
  'teal and amber palette',
  'indigo and coral palette',
  'sage and copper palette',
  'cobalt and gold palette',
  'rose and charcoal palette',
  'emerald and cream palette',
  'mint and rust palette',
  'sand and ultramarine palette',
  'violet and lime accents',
  'monochrome with accent red',
  'intricate architectural detail',
  'ornate mechanical details',
  'moss-covered stone textures',
  'weathered brass surfaces',
  'polished marble floors',
  'rough volcanic rock',
  'wet cobblestone reflections',
  'frosted glass highlights',
  'handmade ceramic elements',
  'woven fabric details',
  'gentle river movement',
  'drifting lanterns',
  'falling petals',
  'wind-swept banners',
  'swirling fog layers',
  'sparkling dust motes',
  'distant mountain silhouettes',
  'foreground framing elements',
  'balanced negative space',
  'readable large shapes',
  'clear edge separation',
  'high micro-contrast',
  'smooth gradient transitions',
  'subtle film grain',
  'clean polished rendering',
  'handcrafted tactile finish',
  'futuristic retro fusion',
  'ancient technology motif',
  'solar-punk infrastructure',
  'fantasy realism blend',
  'art deco geometry',
  'brutalist forms',
  'organic curved structures',
  'floating architecture',
  'hanging garden pathways',
  'suspended cable bridges',
  'layered terrace cityscape',
  'spiral stair landmarks',
  'arched colonnade corridors',
  'market stall clusters',
  'observatory lens arrays',
  'rail track vanishing point',
  'harbor crane silhouettes',
  'cloud sea backdrop',
  'aurora sky ribbons',
  'starlit twilight gradient',
  'bright midday clarity',
  'sunset magenta horizon',
  'pre-dawn blue tones',
  'mist and rain droplets',
  'dry heat shimmer',
  'fresh snowfall powder',
  'stormy ocean spray',
  'tranquil lake mirror',
  'clear object spacing',
  'distinct color zoning',
  'strong landmark anchors',
  'visually varied sub-regions',
  'cohesive narrative scene',
  'no text signage',
  'no watermark artifacts',
] as const

const CATEGORY_PROMPT_INTENTS: Record<
  PuzzleCategory,
  {
    title: string
    composition: string
    qualityTarget: string
  }
> = {
  jigsaw: {
    title: 'Jigsaw',
    composition:
      'Use a wide scene with layered depth and many distinct local details spread across the full frame.',
    qualityTarget:
      'Favor rich texture variety and many recognizable sub-regions with strong visual distinction.',
  },
  slider: {
    title: 'Slider',
    composition:
      'Use one dominant focal landmark with clear directional structure and strong context around it.',
    qualityTarget:
      'Favor clean visual progression and obvious anchor points so position changes are readable.',
  },
  swap: {
    title: 'Swap',
    composition:
      'Use one unified scene with distinct in-scene regions, varied objects, and crisp separation between neighboring areas while keeping a continuous environment.',
    qualityTarget:
      'Favor high local contrast and clear region boundaries without creating split panels or collage-style layouts.',
  },
  polygram: {
    title: 'Polygram',
    composition:
      'Use bold large silhouettes, simple shape clusters, and clear figure-ground separation.',
    qualityTarget:
      'Favor readable geometry and strong contour language for shape-based recognition.',
  },
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
)

app.get('/admin', (c) => c.redirect('/admin-portal'))
app.get('/admin-portal', (c) => c.html(renderAdminPage()))

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

    let generatedPack: PromptPack | null = null
    let tags = providedTags
    if (tags.length === 0) {
      const packs = await generatePromptPacks(c.env.metadata, 1)
      generatedPack = packs[0] ?? null
      tags = normalizeTags(generatedPack?.keywords ?? [])
    }
    if (tags.length === 0) {
      return c.json({ error: 'Unable to determine puzzle tags.' }, 500)
    }
    const theme = generatedPack?.themeName ?? formatThemeFromTags(tags)

    const difficulty = 'adaptive'

    const existing = await getPuzzleByDate(c.env.metadata, date)
    const nextCategories = {} as Record<PuzzleCategory, PuzzleAsset>

    for (const category of CATEGORIES) {
      const file = getFileField(body[category])
      if (!file || file.size === 0) {
        return c.json({ error: `Missing image file for "${category}".` }, 400)
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
      message: `Puzzle package for ${date} saved.`,
      generatedTheme: generatedPack?.themeName ?? null,
      puzzle: record,
    })
  } catch (error) {
    console.error('Admin upload failed', error)
    return c.json({ error: 'Unable to save puzzle package.' }, 500)
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
      WHERE puzzle_date = ? AND difficulty = ?
      ORDER BY elapsed_ms ASC, submitted_at ASC
      LIMIT ?
      `,
    )
      .bind(date, difficultyRaw, limit)
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
        difficulty?: string
        playerGuid?: string
        elapsedMs?: number
      }
    | null = null
  try {
    body = (await c.req.json()) as {
      puzzleDate?: string
      difficulty?: string
      playerGuid?: string
      elapsedMs?: number
    }
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400)
  }

  const puzzleDate = (body?.puzzleDate || '').trim()
  const difficulty = (body?.difficulty || '').trim()
  const playerGuid = (body?.playerGuid || '').trim()
  const elapsedMs = Number(body?.elapsedMs)

  if (!isValidDateKey(puzzleDate)) {
    return c.json({ error: 'Invalid puzzleDate. Use YYYY-MM-DD.' }, 400)
  }
  if (!isLeaderboardDifficulty(difficulty)) {
    return c.json({ error: 'Invalid difficulty.' }, 400)
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
      INSERT INTO puzzle_leaderboard (puzzle_date, difficulty, player_guid, elapsed_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(puzzle_date, difficulty, player_guid)
      DO UPDATE SET
        elapsed_ms = MIN(excluded.elapsed_ms, puzzle_leaderboard.elapsed_ms),
        submitted_at = datetime('now')
      `,
    )
      .bind(puzzleDate, difficulty, playerGuid, Math.round(elapsedMs))
      .run()

    const personal = await c.env.DB.prepare(
      `
      SELECT elapsed_ms
      FROM puzzle_leaderboard
      WHERE puzzle_date = ? AND difficulty = ? AND player_guid = ?
      LIMIT 1
      `,
    )
      .bind(puzzleDate, difficulty, playerGuid)
      .first<{ elapsed_ms: number }>()

    const bestMs = personal?.elapsed_ms ?? Math.round(elapsedMs)

    const rankRow = await c.env.DB.prepare(
      `
      SELECT 1 + COUNT(*) AS rank
      FROM puzzle_leaderboard
      WHERE puzzle_date = ? AND difficulty = ? AND elapsed_ms < ?
      `,
    )
      .bind(puzzleDate, difficulty, bestMs)
      .first<{ rank: number }>()

    return c.json({
      ok: true,
      puzzleDate,
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

function toPuzzleKey(date: string): string {
  return `${PUZZLE_KEY_PREFIX}${date}`
}

async function getPuzzleByDate(kv: KVNamespace, date: string): Promise<PuzzleRecord | null> {
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

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  return !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
}

function getStringField(value?: FormValue): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    const [first] = value
    return typeof first === 'string' ? first : undefined
  }
  return undefined
}

let leaderboardTableReady = false

async function ensureLeaderboardTable(db: D1Database): Promise<void> {
  if (leaderboardTableReady) {
    return
  }

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS puzzle_leaderboard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        puzzle_date TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        player_guid TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms > 0),
        submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (puzzle_date, difficulty, player_guid)
      )`,
    )
    .run()

  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_puzzle_leaderboard_daily
       ON puzzle_leaderboard (puzzle_date, difficulty, elapsed_ms, submitted_at)`,
    )
    .run()

  leaderboardTableReady = true
}

function isLeaderboardDifficulty(value: string): value is LeaderboardDifficulty {
  return LEADERBOARD_DIFFICULTIES.includes(value as LeaderboardDifficulty)
}

function parseTagList(raw?: string): string[] {
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

function normalizeTags(value: unknown): string[] {
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

function formatThemeFromTags(tags: string[]): string {
  if (tags.length === 0) {
    return 'Daily Puzzle'
  }
  const [first = 'Daily', second = 'Puzzle'] = tags
  return `${capitalizeWords(first)} - ${capitalizeWords(second)}`
}

function getFileField(value?: FormValue): File | undefined {
  if (value instanceof File) {
    return value
  }
  if (Array.isArray(value)) {
    const [first] = value
    return first instanceof File ? first : undefined
  }
  return undefined
}

function getFileExtension(file: File): string {
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

function toCdnUrl(r2Key: string): string {
  const encodedKey = r2Key.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `/cdn/${encodedKey}`
}

async function generatePromptPacks(kv: KVNamespace, count: number): Promise<PromptPack[]> {
  const history = await getPromptHistory(kv)
  const packs: PromptPack[] = []

  for (let index = 0; index < count; index += 1) {
    const pack = buildPromptPack(history)
    packs.push(pack)
  }

  await kv.put(PROMPT_HISTORY_KEY, JSON.stringify(history.slice(-PROMPT_HISTORY_LIMIT)))
  return packs
}

async function getPromptHistory(kv: KVNamespace): Promise<PromptHistoryItem[]> {
  const raw = await kv.get(PROMPT_HISTORY_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    const normalized = parsed
      .map((entry) => normalizePromptHistoryItem(entry))
      .filter((entry): entry is PromptHistoryItem => entry !== null)
    return normalized
  } catch {
    return []
  }
}

function buildPromptPack(history: PromptHistoryItem[]): PromptPack {
  if (DESCRIPTOR_POOL.length < MIN_DESCRIPTOR_POOL_SIZE) {
    throw new Error(
      `Descriptor pool must contain at least ${MIN_DESCRIPTOR_POOL_SIZE} entries.`,
    )
  }

  const recent = history.slice(-PROMPT_HISTORY_LIMIT)
  const usedInPack = new Set<string>()
  const descriptorsByCategory = {} as Record<PuzzleCategory, string[]>

  for (const category of CATEGORIES) {
    const descriptors = pickDistinctDescriptors(
      DESCRIPTOR_POOL,
      recent,
      DESCRIPTORS_PER_PACK,
      usedInPack,
    )
    descriptorsByCategory[category] = descriptors
    for (const descriptor of descriptors) {
      usedInPack.add(descriptor)
    }
  }

  const jigsawDescriptors = descriptorsByCategory.jigsaw
  const keywords = [...usedInPack].slice(0, 12)
  const themeSubject = jigsawDescriptors[0] ?? 'daily scene'
  const themeColor = jigsawDescriptors[1] ?? 'wide variety'
  const themeName = `${capitalizeWords(themeSubject)} - ${capitalizeWords(themeColor)}`

  const pack: PromptPack = {
    themeName,
    keywords,
    prompts: {
      jigsaw: buildImagePrompt('jigsaw', descriptorsByCategory.jigsaw),
      slider: buildImagePrompt('slider', descriptorsByCategory.slider),
      swap: buildImagePrompt('swap', descriptorsByCategory.swap),
      polygram: buildImagePrompt('polygram', descriptorsByCategory.polygram),
    },
  }

  history.push({
    descriptors: [...usedInPack],
    createdAt: new Date().toISOString(),
  })

  return pack
}

function buildImagePrompt(category: PuzzleCategory, descriptors: string[]): string {
  const intent = CATEGORY_PROMPT_INTENTS[category]
  const descriptorText = descriptors.join(', ')
  return [
    intent.composition,
    `Use these descriptors: ${descriptorText}.`,
    `Quality target: ${intent.qualityTarget}`,
    'Output requirements: single image, landscape 4:3, high detail, clean edges, coherent lighting, no text, no letters, no logos, no watermark, no borders, no UI overlays.',
  ].join(' ')
}

function normalizePromptHistoryItem(raw: unknown): PromptHistoryItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const candidate = raw as {
    descriptors?: unknown
    createdAt?: unknown
    subject?: unknown
    setting?: unknown
    mood?: unknown
    style?: unknown
    palette?: unknown
  }

  if (Array.isArray(candidate.descriptors)) {
    const nextDescriptors = candidate.descriptors
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .slice(0, DESCRIPTORS_PER_PACK)

    if (nextDescriptors.length > 0) {
      return {
        descriptors: [...new Set(nextDescriptors)],
        createdAt:
          typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      }
    }
  }

  const legacyDescriptors = [
    candidate.subject,
    candidate.setting,
    candidate.mood,
    candidate.style,
    candidate.palette,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())

  if (legacyDescriptors.length === 0) {
    return null
  }

  return {
    descriptors: [...new Set(legacyDescriptors)],
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
  }
}

function pickDistinctDescriptors(
  pool: readonly string[],
  recent: PromptHistoryItem[],
  count: number,
  excluded = new Set<string>(),
): string[] {
  const counts = new Map<string, number>()
  for (const item of recent) {
    for (const descriptor of item.descriptors) {
      counts.set(descriptor, (counts.get(descriptor) || 0) + 1)
    }
  }

  const sourcePool = pool.filter((descriptor) => !excluded.has(descriptor))
  const workingPool = sourcePool.length >= count ? sourcePool : [...pool]

  const scored = [...workingPool]
    .map((descriptor) => ({
      descriptor,
      seen: counts.get(descriptor) || 0,
      tieBreak: Math.random(),
    }))
    .sort((a, b) => {
      if (a.seen !== b.seen) {
        return a.seen - b.seen
      }
      return a.tieBreak - b.tieBreak
    })

  const targetCount = Math.max(1, Math.min(count, workingPool.length))
  const rarityWindowSize = Math.min(scored.length, Math.max(targetCount * 8, 60))
  const rarityWindow = scored.slice(0, rarityWindowSize).map((entry) => entry.descriptor)
  const picks: string[] = []

  while (picks.length < targetCount && rarityWindow.length > 0) {
    const index = Math.floor(Math.random() * rarityWindow.length)
    const [pick] = rarityWindow.splice(index, 1)
    if (pick) {
      picks.push(pick)
    }
  }

  if (picks.length >= targetCount) {
    return picks
  }

  const fallback = workingPool.filter((descriptor) => !picks.includes(descriptor))
  while (picks.length < targetCount && fallback.length > 0) {
    const index = Math.floor(Math.random() * fallback.length)
    const [pick] = fallback.splice(index, 1)
    if (pick) {
      picks.push(pick)
    }
  }

  return picks
}

function capitalizeWords(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase())
}

function renderHomePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Xefig</title>
    <style>
      :root {
        --bg: #f3f7fb;
        --card: #ffffff;
        --text: #12253a;
        --subtle: #4e637b;
        --line: #d5e0ea;
        --accent: #0f7a57;
        --accent-2: #1d4ed8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(80rem 40rem at 15% -20%, #c0f0df 0%, transparent 60%),
          radial-gradient(80rem 40rem at 85% -25%, #bed4ff 0%, transparent 60%),
          var(--bg);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
        padding: 2rem 1rem 3rem;
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        gap: 1rem;
        margin-bottom: 1.4rem;
      }
      h1 {
        margin: 0;
        font-size: clamp(1.6rem, 2.4vw, 2.4rem);
      }
      .meta {
        color: var(--subtle);
        margin-top: 0.35rem;
      }
      .admin-link {
        background: var(--accent-2);
        color: #fff;
        text-decoration: none;
        padding: 0.65rem 0.9rem;
        border-radius: 0.55rem;
        font-weight: 600;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 0.9rem;
      }
      article {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 0.9rem;
        overflow: hidden;
        box-shadow: 0 10px 30px rgba(8, 18, 35, 0.06);
      }
      .thumb {
        aspect-ratio: 4 / 3;
        width: 100%;
        object-fit: cover;
        display: block;
        background: #e8eef5;
      }
      .body {
        padding: 0.8rem;
      }
      .label {
        margin: 0 0 0.2rem;
        font-size: 1.05rem;
      }
      .desc {
        margin: 0;
        color: var(--subtle);
        font-size: 0.92rem;
      }
      .status {
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 0.7rem;
        padding: 0.9rem;
        color: var(--subtle);
        margin-bottom: 1rem;
      }
      .status.error {
        border-color: #f0b8b8;
        color: #952d2d;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="top">
        <div>
          <h1>Xefig</h1>
          <p class="meta" id="summary">Loading today's puzzle package...</p>
        </div>
        <a class="admin-link" href="/admin-portal">Admin Portal</a>
      </section>
      <div id="status" class="status">Fetching data from KV...</div>
      <section class="cards" id="cards"></section>
    </main>
    <script>
      const CATEGORY_LABELS = {
        jigsaw: "Jigsaw",
        slider: "Slider",
        swap: "Swap",
        polygram: "Polygram"
      }

      async function loadToday() {
        const statusEl = document.getElementById("status")
        const summaryEl = document.getElementById("summary")
        const cardsEl = document.getElementById("cards")

        try {
          const res = await fetch("/api/puzzles/today")
          const payload = await res.json()

          if (!res.ok) {
            statusEl.textContent = payload.error || "No puzzle package scheduled for today."
            statusEl.classList.add("error")
            summaryEl.textContent = "No daily package found."
            return
          }

          statusEl.remove()
          summaryEl.textContent = payload.date + " - " + payload.theme

          for (const key of Object.keys(CATEGORY_LABELS)) {
            const category = key
            const card = document.createElement("article")
            const img = document.createElement("img")
            const body = document.createElement("div")
            const title = document.createElement("h2")
            const desc = document.createElement("p")

            img.className = "thumb"
            img.loading = "lazy"
            img.alt = CATEGORY_LABELS[category] + " puzzle preview"
            img.src = payload.categories[category].imageUrl

            body.className = "body"
            title.className = "label"
            title.textContent = CATEGORY_LABELS[category]
            desc.className = "desc"
            desc.textContent = "Image key: " + payload.categories[category].imageKey

            body.append(title, desc)
            card.append(img, body)
            cardsEl.append(card)
          }
        } catch (error) {
          statusEl.textContent = "Failed to load today's package."
          statusEl.classList.add("error")
          summaryEl.textContent = "KV lookup failed."
        }
      }

      loadToday()
    </script>
  </body>
</html>`
}

function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Admin Portal</title>
    <style>
      :root {
        --bg: #0b1724;
        --panel: #102337;
        --panel-2: #0f1f31;
        --line: #2a4861;
        --text: #e7f1f8;
        --muted: #a5c0d4;
        --accent: #2aa198;
        --accent-2: #f28f3b;
        --ok: #78d8ab;
        --error: #ffb1b1;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Avenir Next", "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(55rem 28rem at 0% 0%, rgba(41, 155, 150, 0.26), transparent 65%),
          radial-gradient(60rem 30rem at 100% 0%, rgba(242, 143, 59, 0.24), transparent 68%),
          var(--bg);
        padding: 1.1rem;
      }
      .panel {
        width: min(1080px, 100%);
        margin: 0 auto;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 1rem;
        padding: 1rem;
      }
      .top {
        padding: 0.3rem 0.35rem 0.9rem;
        border-bottom: 1px solid var(--line);
        margin-bottom: 1rem;
      }
      h1 {
        margin: 0;
        font-size: clamp(1.35rem, 2.4vw, 1.85rem);
      }
      .lead {
        margin: 0.35rem 0 0;
        color: var(--muted);
      }
      .flow {
        list-style: none;
        margin: 0.85rem 0 0;
        padding: 0;
        display: grid;
        gap: 0.45rem;
      }
      .flow li {
        border: 1px solid var(--line);
        border-radius: 0.6rem;
        padding: 0.45rem 0.6rem;
        color: var(--muted);
        background: rgba(15, 31, 49, 0.7);
      }
      .flow li strong {
        color: var(--text);
        margin-right: 0.35rem;
      }
      .layout {
        display: grid;
        gap: 1rem;
      }
      .step {
        border: 1px solid var(--line);
        background: var(--panel-2);
        border-radius: 0.85rem;
        padding: 0.9rem;
      }
      .step h2 {
        margin: 0;
        font-size: 1.06rem;
      }
      .step .sub {
        margin: 0.3rem 0 0.8rem;
        color: var(--muted);
      }
      .row {
        display: grid;
        gap: 0.7rem;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        margin-bottom: 0.75rem;
      }
      label {
        display: grid;
        gap: 0.35rem;
        font-size: 0.93rem;
      }
      input,
      select {
        width: 100%;
        background: #0d1a29;
        color: var(--text);
        border: 1px solid var(--line);
        border-radius: 0.5rem;
        padding: 0.63rem 0.7rem;
      }
      textarea {
        width: 100%;
        resize: vertical;
        min-height: 135px;
        background: #0d1a29;
        color: var(--text);
        border: 1px solid var(--line);
        border-radius: 0.5rem;
        padding: 0.63rem 0.7rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        line-height: 1.38;
      }
      button {
        border: 0;
        border-radius: 0.5rem;
        background: var(--accent);
        color: #07201d;
        padding: 0.62rem 0.86rem;
        font-weight: 600;
        cursor: pointer;
      }
      button.secondary {
        background: #275174;
        color: #dbf0ff;
      }
      button.ghost {
        background: #1e2f42;
        color: #d7e6f3;
      }
      button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin-bottom: 0.75rem;
      }
      .meta-grid {
        display: grid;
        gap: 0.7rem;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        margin-bottom: 0.75rem;
      }
      .prompt-grid {
        display: grid;
        gap: 0.7rem;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
      .prompt-card {
        border: 1px solid var(--line);
        border-radius: 0.65rem;
        padding: 0.65rem;
        background: rgba(9, 21, 34, 0.65);
      }
      .prompt-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.48rem;
      }
      .prompt-head h3 {
        margin: 0;
        font-size: 0.95rem;
      }
      .upload-grid {
        display: grid;
        gap: 0.65rem;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        margin-bottom: 0.8rem;
      }
      .file-card {
        border: 1px solid var(--line);
        border-radius: 0.65rem;
        padding: 0.62rem;
        background: rgba(9, 21, 34, 0.6);
      }
      .file-card p {
        margin: 0.45rem 0 0;
        color: var(--muted);
        font-size: 0.84rem;
      }
      .status {
        margin-top: 0.8rem;
        border-radius: 0.6rem;
        padding: 0.65rem 0.7rem;
        border: 1px solid var(--line);
        color: var(--muted);
        background: rgba(7, 18, 30, 0.65);
      }
      .status.error {
        color: var(--error);
        border-color: #914646;
      }
      .status.ok {
        color: var(--ok);
        border-color: #396e56;
      }
      .status.note {
        color: #d0e6ff;
        border-color: #3d6182;
      }
      @media (max-width: 680px) {
        .panel { padding: 0.8rem; }
        .step { padding: 0.75rem; }
      }
    </style>
  </head>
  <body>
    <section class="panel">
      <header class="top">
        <h1>Xefig Admin</h1>
        <p class="lead">Workflow: generate prompts, make images externally, then upload the package for a date.</p>
        <ol class="flow">
          <li><strong>1.</strong>Generate the daily prompt pack.</li>
          <li><strong>2.</strong>Use each per-image prompt in your image model and export files.</li>
          <li><strong>3.</strong>Upload all four images to publish the day.</li>
        </ol>
      </header>

      <div class="layout">
        <section class="step" aria-label="Step 1 Prompt generation">
          <h2>Step 1: Generate Copy/Paste Prompts</h2>
          <p class="sub">Generate one daily pack with four full prompts (Jigsaw, Slider, Swap, Polygram), then copy prompts per image.</p>
          <div class="row">
            <label>
              Admin Password
              <input id="admin-password" type="password" autocomplete="current-password" required />
            </label>
          </div>
          <div class="actions">
            <button type="button" id="generate-prompt-btn" class="secondary">Generate Daily Prompt Pack</button>
            <button type="button" id="copy-pack-btn" class="ghost" disabled>Copy Full Prompt Pack</button>
          </div>
          <div class="meta-grid">
            <label>
              Pack Label
              <input id="selected-theme" type="text" readonly />
            </label>
            <label>
              Tags
              <input id="selected-keywords" type="text" readonly />
            </label>
          </div>
          <div class="prompt-grid">
            <article class="prompt-card">
              <div class="prompt-head">
                <h3>Jigsaw Prompt</h3>
                <button type="button" class="ghost copy-btn" data-target="prompt-jigsaw">Copy</button>
              </div>
              <textarea id="prompt-jigsaw" readonly></textarea>
            </article>
            <article class="prompt-card">
              <div class="prompt-head">
                <h3>Slider Prompt</h3>
                <button type="button" class="ghost copy-btn" data-target="prompt-slider">Copy</button>
              </div>
              <textarea id="prompt-slider" readonly></textarea>
            </article>
            <article class="prompt-card">
              <div class="prompt-head">
                <h3>Swap Prompt</h3>
                <button type="button" class="ghost copy-btn" data-target="prompt-swap">Copy</button>
              </div>
              <textarea id="prompt-swap" readonly></textarea>
            </article>
            <article class="prompt-card">
              <div class="prompt-head">
                <h3>Polygram Prompt</h3>
                <button type="button" class="ghost copy-btn" data-target="prompt-polygram">Copy</button>
              </div>
              <textarea id="prompt-polygram" readonly></textarea>
            </article>
          </div>
        </section>

        <section class="step" aria-label="Step 2 Upload generated images">
          <h2>Step 2: Upload Generated Images</h2>
          <p class="sub">After generating images from prompts, upload all four files for one date. Tags are attached from Step 1 for future filtering/search.</p>
          <form id="admin-form">
            <input id="form-password" name="password" type="hidden" />
            <input id="tags-hidden" name="tags" type="hidden" />

            <div class="row">
              <label>
                Date
                <input name="date" id="date" type="date" required />
              </label>
            </div>

            <div class="row">
              <label>
                Tags For This Day
                <input id="upload-tags" type="text" readonly placeholder="Generate a daily prompt pack to populate tags" />
              </label>
            </div>

            <div class="upload-grid">
              <article class="file-card">
                <label>Jigsaw Image <input name="jigsaw" type="file" accept="image/*" required /></label>
                <p>Use the Jigsaw prompt above.</p>
              </article>
              <article class="file-card">
                <label>Slider Image <input name="slider" type="file" accept="image/*" required /></label>
                <p>Use the Slider prompt above.</p>
              </article>
              <article class="file-card">
                <label>Swap Image <input name="swap" type="file" accept="image/*" required /></label>
                <p>Use the Swap prompt above.</p>
              </article>
              <article class="file-card">
                <label>Polygram Image <input name="polygram" type="file" accept="image/*" required /></label>
                <p>Use the Polygram prompt above.</p>
              </article>
            </div>

            <div class="actions">
              <button type="submit" id="submit-btn">Save Puzzle Package</button>
            </div>
          </form>
        </section>
      </div>

      <div id="status" class="status note">Ready. Start with Step 1.</div>
    </section>

    <script>
      const CATEGORIES = ["jigsaw", "slider", "swap", "polygram"]
      const form = document.getElementById("admin-form")
      const status = document.getElementById("status")
      const dateInput = document.getElementById("date")
      const passwordInput = document.getElementById("admin-password")
      const hiddenPasswordInput = document.getElementById("form-password")
      const hiddenTagsInput = document.getElementById("tags-hidden")
      const generateBtn = document.getElementById("generate-prompt-btn")
      const copyPackBtn = document.getElementById("copy-pack-btn")
      const selectedThemeInput = document.getElementById("selected-theme")
      const selectedKeywordsInput = document.getElementById("selected-keywords")
      const uploadTagsInput = document.getElementById("upload-tags")

      const promptFields = {
        jigsaw: document.getElementById("prompt-jigsaw"),
        slider: document.getElementById("prompt-slider"),
        swap: document.getElementById("prompt-swap"),
        polygram: document.getElementById("prompt-polygram"),
      }

      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      dateInput.value = tomorrow

      let promptPack = null

      function setStatus(text, type) {
        status.textContent = text
        status.className = "status " + (type || "note")
      }

      function syncPasswordIntoForm() {
        hiddenPasswordInput.value = passwordInput.value.trim()
      }

      function clearPromptFields() {
        for (const key of CATEGORIES) {
          promptFields[key].value = ""
        }
        selectedThemeInput.value = ""
        selectedKeywordsInput.value = ""
        uploadTagsInput.value = ""
        hiddenTagsInput.value = ""
      }

      async function copyText(text, label) {
        if (!text) {
          setStatus("Nothing to copy for " + label + ".", "error")
          return
        }

        try {
          await navigator.clipboard.writeText(text)
          setStatus(label + " copied to clipboard.", "ok")
        } catch (error) {
          setStatus("Clipboard copy failed for " + label + ".", "error")
        }
      }

      function renderPromptPack(pack) {
        if (!pack) {
          clearPromptFields()
          return
        }

        selectedThemeInput.value = pack.themeName || ""
        selectedKeywordsInput.value = Array.isArray(pack.keywords) ? pack.keywords.join(", ") : ""
        uploadTagsInput.value = Array.isArray(pack.keywords) ? pack.keywords.join(", ") : ""
        hiddenTagsInput.value = JSON.stringify(Array.isArray(pack.keywords) ? pack.keywords : [])
        promptFields.jigsaw.value = pack.prompts?.jigsaw || ""
        promptFields.slider.value = pack.prompts?.slider || ""
        promptFields.swap.value = pack.prompts?.swap || ""
        promptFields.polygram.value = pack.prompts?.polygram || ""
      }

      passwordInput.addEventListener("input", syncPasswordIntoForm)
      syncPasswordIntoForm()

      generateBtn.addEventListener("click", async () => {
        const password = passwordInput.value.trim()
        if (!password) {
          setStatus("Enter admin password before generating prompts.", "error")
          return
        }

        generateBtn.disabled = true
        copyPackBtn.disabled = true
        setStatus("Generating daily prompt pack...", "note")

        try {
          const response = await fetch("/api/admin/prompts/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          })

          const payload = await response.json()
          if (!response.ok) {
            setStatus(payload.error || "Prompt generation failed.", "error")
            promptPack = null
            clearPromptFields()
            return
          }

          const packs = Array.isArray(payload.prompts) ? payload.prompts : []
          const firstPack = packs[0] || null
          if (!firstPack) {
            setStatus("No prompt pack was returned.", "error")
            promptPack = null
            clearPromptFields()
            return
          }

          promptPack = firstPack
          renderPromptPack(firstPack)
          copyPackBtn.disabled = false
          setStatus("Daily prompt pack ready. Generate images, then continue to Step 2.", "ok")
        } catch (error) {
          setStatus("Network error while generating prompts.", "error")
          promptPack = null
          clearPromptFields()
        } finally {
          generateBtn.disabled = false
        }
      })

      copyPackBtn.addEventListener("click", async () => {
        if (!promptPack) {
          setStatus("Generate the daily prompt pack first.", "error")
          return
        }

        const combined = [
          "DAILY PACK",
          "Label: " + (promptPack.themeName || ""),
          "Tags: " + (Array.isArray(promptPack.keywords) ? promptPack.keywords.join(", ") : ""),
          "",
          "JIGSAW PROMPT:",
          promptPack.prompts?.jigsaw || "",
          "",
          "SLIDER PROMPT:",
          promptPack.prompts?.slider || "",
          "",
          "SWAP PROMPT:",
          promptPack.prompts?.swap || "",
          "",
          "POLYGRAM PROMPT:",
          promptPack.prompts?.polygram || "",
        ].join("\\n")

        await copyText(combined, "Full prompt pack")
      })

      document.querySelectorAll(".copy-btn").forEach((button) => {
        button.addEventListener("click", async () => {
          const target = button.getAttribute("data-target")
          if (!target) {
            return
          }
          const field = document.getElementById(target)
          if (!field) {
            return
          }
          const label = button.parentElement?.querySelector("h3")?.textContent || "Prompt"
          await copyText(field.value, label)
        })
      })

      form.addEventListener("submit", async (event) => {
        event.preventDefault()

        const password = passwordInput.value.trim()
        if (!password) {
          setStatus("Enter admin password before upload.", "error")
          return
        }
        syncPasswordIntoForm()

        const submitBtn = document.getElementById("submit-btn")
        submitBtn.disabled = true
        setStatus("Uploading puzzle package...", "note")

        try {
          const formData = new FormData(form)
          const response = await fetch("/api/admin/puzzles", {
            method: "POST",
            body: formData,
          })

          const payload = await response.json()
          if (!response.ok) {
            setStatus(payload.error || "Unable to save package.", "error")
            return
          }

          const generatedLabel = payload.generatedTheme ? " Auto-generated label: " + payload.generatedTheme + "." : ""
          setStatus((payload.message || "Puzzle package saved.") + generatedLabel, "ok")
        } catch (error) {
          setStatus("Network error while saving package.", "error")
        } finally {
          submitBtn.disabled = false
        }
      })
    </script>
  </body>
</html>`
}

export default app

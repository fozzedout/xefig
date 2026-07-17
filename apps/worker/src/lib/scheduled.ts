import { CATEGORIES, type Bindings, type PuzzleAsset, type PuzzleCategory, type PuzzleRecord } from '../types'
import { generatePromptPacks, generateSingleCategoryPrompt } from './prompts'
import {
  submitImageBatch,
  pollImageBatch,
  judgeDiamondCoherence,
  generateImageSync,
  cancelImageBatch,
  type BatchRequest,
} from './gemini'
import { makeGemmaRewriter } from './gemma-rewriter'
import { detectBorder, processPngImage } from './image'
import { detectTooSimpleDiamond, renderQuantizedPng } from './diamond-quant'

const BORDER_PROMPT_ADDENDUM =
  'Critical: the image must be full-bleed. Content extends completely to all four edges — no white frame, no coloured border, no paper texture, no torn or deckled edges, no vignette, no matting.'
const COMPLEXITY_PROMPT_ADDENDUM =
  'Critical: the scene must read as a clear, recognisable picture made of distinct, recognisable shapes with moderate detail. Avoid BOTH extremes — no single large flat area dominating the frame (big empty sky/water/wall), and no dense busy repeating detail that dissolves into noise (stained glass, mosaics, intricate lattices, tile grids, fine repeating patterns).'
import { findNextUnscheduledDate, getPuzzleByDate, getUtcDateKey, isValidDateKey, toCdnUrl, savePuzzleRecord } from './puzzles'
import {
  ensurePuzzleTables,
  getBatchJobsByTargetDate,
  getBatchJobByBatchName,
  getAllPendingBatchJobs,
  saveBatchJob,
  deleteBatchJob,
  getAppSetting,
  setAppSetting,
  type PendingBatchJob,
} from './puzzle-db'

export const PIPELINE_PAUSED_KEY = 'pipeline_paused'

export async function isPipelinePaused(db: D1Database): Promise<boolean> {
  const value = await getAppSetting(db, PIPELINE_PAUSED_KEY)
  return value === '1'
}

// A batch normally starts within minutes and a healthy single image finishes
// in ~15 min; if Gemini has queued a batch but completed ZERO of its requests
// well past the time it should have, it's wedged (a documented
// BATCH_STATE_RUNNING failure mode), not slow — drop it and resubmit rather
// than waiting out the 24h SLA. The threshold scales with the batch's image
// count: a full 5-image daily pack gets ~6h, but a single-tile admin regen is
// declared dead at ~2h. Flat 6h was far too lenient for one image (an hour
// already means "probably never").
const STUCK_PER_IMAGE_HOURS = 1
const STUCK_BUFFER_HOURS = 1
function stuckThresholdHours(imageCount: number): number {
  return Math.max(1, imageCount) * STUCK_PER_IMAGE_HOURS + STUCK_BUFFER_HOURS
}
// Per-date count of consecutive stuck-and-resubmitted batches (reset when the
// puzzle finally saves). Only alert once a *resubmit* also sticks — a one-off
// Gemini hiccup self-heals silently.
const STUCK_RETRY_KEY = 'batch_stuck_retries'
const STUCK_RETRY_ALERT = 2

async function readStuckRetries(db: D1Database): Promise<Record<string, number>> {
  try {
    return JSON.parse((await getAppSetting(db, STUCK_RETRY_KEY)) || '{}') as Record<string, number>
  } catch {
    return {}
  }
}

async function bumpStuckRetry(db: D1Database, date: string): Promise<number> {
  const map = await readStuckRetries(db)
  const next = (map[date] ?? 0) + 1
  map[date] = next
  await setAppSetting(db, STUCK_RETRY_KEY, JSON.stringify(map))
  return next
}

async function clearStuckRetry(db: D1Database, date: string): Promise<void> {
  const map = await readStuckRetries(db)
  if (map[date] != null) {
    delete map[date]
    await setAppSetting(db, STUCK_RETRY_KEY, JSON.stringify(map))
  }
}

// Shared diamond gate: does this generated diamond image need regenerating?
// Two failure modes — (1) too SIMPLE (one giant flat region, a couple of taps
// to finish), caught cheaply by region metrics; (2) too BUSY/incoherent (the
// quantization dissolves into mosaic/lattice noise), invisible to region stats
// so judged by Gemini vision on the rendered "finished puzzle". Used by BOTH
// the async batch poll loop and the synchronous admin regen so the two paths
// stay in lock-step. Fails safe: any error -> no regen (accept the image).
async function diamondNeedsRegen(
  env: Bindings,
  imageBytes: Uint8Array,
): Promise<{ regen: boolean; reason: string }> {
  try {
    const analysis = detectTooSimpleDiamond(imageBytes)
    if (analysis.tooSimple) {
      return {
        regen: true,
        reason: `too simple (largest ${(analysis.largestRegionFraction * 100).toFixed(0)}%, ${analysis.regionCount} regions, big65 ${(analysis.bigRegionShare * 100).toFixed(0)}%)`,
      }
    }
    if (env.GOOGLE_AI_API_KEY) {
      // Metrics pass — but does the quantized result actually look like a
      // coherent picture, or did it dissolve into mosaic/lattice noise?
      // Region stats can't tell; ask Gemini vision about the render.
      const png = renderQuantizedPng(analysis.grid, analysis.palette, analysis.cols, analysis.rows)
      const verdict = await judgeDiamondCoherence(env.GOOGLE_AI_API_KEY, png, env.DIAMOND_VISION_MODEL || undefined)
      if (verdict.regen) {
        return { regen: true, reason: `looks incoherent (vision ${verdict.score}/10: ${verdict.reason})` }
      }
    }
  } catch (err) {
    console.warn('[complexity] diamond gate check failed', err)
  }
  return { regen: false, reason: '' }
}

export type BatchSubmitResult = {
  submitted: boolean
  message: string
  batchName?: string
  targetDate?: string
  themes?: Record<string, string>
  existingDate?: boolean
}

export type BatchPollResult = {
  found: boolean
  message: string
  batchName?: string
  targetDate?: string
  state?: string
  submittedAt?: string
  imagesProcessed?: number
  savedDate?: string
  error?: string
  rawResponse?: unknown
  // Set when handleBatchPoll runs in skipProcess mode and a job has
  // PNGs sitting in R2 temp ready for the client to encode locally.
  remainingCategories?: PuzzleCategory[]
  // Stuck-batch auto-recovery: state==='stuck' means a wedged batch was
  // dropped + resubmitted; stuckAlert flags that a retry ALSO stuck (worth an
  // email), retryCount is the consecutive-stuck count for the date.
  stuckAlert?: boolean
  retryCount?: number
  resubmitted?: boolean
}

export type BatchPollOptions = {
  // When true, the manual admin path: poll Gemini and save raw PNGs to
  // R2 temp, but stop short of decoding/encoding so the browser can do
  // the WebP conversion locally and avoid Worker CPU limits. The cron
  // path leaves this unset and processes server-side as before.
  skipProcess?: boolean
}

// ---------------------------------------------------------------------------
// Phase 1: Submit batch job (daily cron)
// ---------------------------------------------------------------------------

export async function handleBatchSubmit(
  env: Bindings,
  opts: {
    date?: string
    force?: boolean
    // When provided, use these prompts instead of generating new ones
    prompts?: Record<string, { prompt: string; theme: string; keywords: string[] }>
  } = {},
): Promise<BatchSubmitResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { submitted: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }

  await ensurePuzzleTables(env.DB)

  if (await isPipelinePaused(env.DB)) {
    return { submitted: false, message: 'Pipeline is paused. Resume it in admin settings to submit new batches.' }
  }
  const queuedJobs = await getAllPendingBatchJobs(env.DB)
  // A full-pack submit covers every category, so it only collides with
  // a date if any job for that date exists — single-category rows
  // included (you don't want to queue a 5-category pack on top of a
  // pending jigsaw-only regen).
  const fullPackBlockedDates = new Set(queuedJobs.map((j) => j.targetDate))

  let targetDate: string | null
  if (opts.date) {
    if (!isValidDateKey(opts.date)) {
      return { submitted: false, message: 'Invalid date format. Use YYYY-MM-DD.' }
    }
    targetDate = opts.date

    // Reject if any job already queued for this date — a fresh full
    // pack would either collide with queued categories or be merged
    // unpredictably.
    if (fullPackBlockedDates.has(targetDate)) {
      const existing = queuedJobs.find((j) => j.targetDate === targetDate)!
      const categoriesNote = existing.requestedCategories && existing.requestedCategories.length < CATEGORIES.length
        ? ` (pending: ${existing.requestedCategories.join(', ')})`
        : ''
      return {
        submitted: false,
        message: `A batch job is already queued for ${targetDate}${categoriesNote}. Cancel it first or pick a different date.`,
        batchName: existing.batchName,
        targetDate,
      }
    }

    // Check if images already exist for this date
    const existingPuzzle = await getPuzzleByDate(env.DB, targetDate)
    if (existingPuzzle && !opts.force) {
      return {
        submitted: false,
        message: `Puzzle images already exist for ${targetDate}. Submit again with force to overwrite.`,
        targetDate,
        existingDate: true,
      }
    }
  } else {
    const today = getUtcDateKey()
    targetDate = await findNextUnscheduledDate(env.DB, today, 14, fullPackBlockedDates)
    if (!targetDate) {
      return {
        submitted: false,
        message: 'No unscheduled (or unqueued) dates found in the next 14 days.',
      }
    }
  }

  // Use client-provided prompts if available, otherwise generate new ones
  let categoryPrompts: Record<PuzzleCategory, { prompt: string; theme: string; keywords: string[] }>
  if (opts.prompts && CATEGORIES.every((c) => opts.prompts![c]?.prompt)) {
    categoryPrompts = opts.prompts as typeof categoryPrompts
  } else {
    const [pack] = await generatePromptPacks(env.DB, 1, makeGemmaRewriter(env) ?? undefined)
    if (!pack) {
      return { submitted: false, message: 'Failed to generate prompt pack.' }
    }
    categoryPrompts = pack.categories
  }

  const requests: BatchRequest[] = CATEGORIES.map((category) => ({
    category,
    prompt: categoryPrompts[category].prompt,
  }))

  const { batchName } = await submitImageBatch(env.GOOGLE_AI_API_KEY, requests)

  const pendingJob: PendingBatchJob = {
    batchName,
    targetDate,
    categories: {} as PendingBatchJob['categories'],
    submittedAt: new Date().toISOString(),
    phase: 'submitted',
    processedCategories: [],
  }

  const themes: Record<string, string> = {}
  for (const category of CATEGORIES) {
    pendingJob.categories[category] = {
      theme: categoryPrompts[category].theme,
      keywords: categoryPrompts[category].keywords,
    }
    themes[category] = categoryPrompts[category].theme
  }

  await saveBatchJob(env.DB, pendingJob)

  return {
    submitted: true,
    message: `Batch job submitted for ${targetDate}.`,
    batchName,
    targetDate,
    themes,
  }
}

// ---------------------------------------------------------------------------
// Single-category batch submit (manual from admin panel)
// ---------------------------------------------------------------------------

export async function handleSingleBatchSubmit(
  env: Bindings,
  opts: {
    category: PuzzleCategory
    prompt: string
    theme: string
    keywords: string[]
    date?: string
    force?: boolean
  },
): Promise<BatchSubmitResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { submitted: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }

  await ensurePuzzleTables(env.DB)
  const queuedJobs = await getAllPendingBatchJobs(env.DB)

  let targetDate: string | null
  if (opts.date) {
    if (!isValidDateKey(opts.date)) {
      return { submitted: false, message: 'Invalid date format. Use YYYY-MM-DD.' }
    }
    targetDate = opts.date

    // Reject only if THIS category is already queued for this date.
    // Stacking different single-category jobs on the same day is
    // allowed (e.g. re-run jigsaw and diamond independently for
    // 2026-04-20).
    const sameDateJobs = queuedJobs.filter((j) => j.targetDate === targetDate)
    const collision = sameDateJobs.find((j) => {
      const cats = j.requestedCategories ?? CATEGORIES
      return cats.includes(opts.category)
    })
    if (collision) {
      return {
        submitted: false,
        message: `A ${opts.category} batch is already queued for ${targetDate}. Cancel it first or pick a different date.`,
        batchName: collision.batchName,
        targetDate,
      }
    }
  } else {
    // For an auto-picked date, only skip dates that already have a
    // full-pack or same-category job queued. Since this path has no
    // pre-chosen category, use the union of all queued dates as a
    // conservative exclude.
    const queuedDates = new Set(queuedJobs.map((j) => j.targetDate))
    const today = getUtcDateKey()
    targetDate = await findNextUnscheduledDate(env.DB, today, 14, queuedDates)
    if (!targetDate) {
      return {
        submitted: false,
        message: 'No unscheduled (or unqueued) dates found in the next 14 days.',
      }
    }
  }

  const requests: BatchRequest[] = [{
    category: opts.category,
    prompt: opts.prompt,
  }]

  const { batchName } = await submitImageBatch(env.GOOGLE_AI_API_KEY, requests)

  // Build a pending job with only the single category's metadata.
  // The other categories are left empty so processing skips them.
  const pendingJob: PendingBatchJob = {
    batchName,
    targetDate,
    categories: {} as PendingBatchJob['categories'],
    submittedAt: new Date().toISOString(),
    phase: 'submitted',
    processedCategories: [],
    // Track which categories are actually part of this job
    requestedCategories: [opts.category],
  }

  pendingJob.categories[opts.category] = {
    theme: opts.theme,
    keywords: opts.keywords,
  }

  // Fill empty metadata for unrequested categories so existing code doesn't break
  for (const cat of CATEGORIES) {
    if (!pendingJob.categories[cat]) {
      pendingJob.categories[cat] = { theme: '', keywords: [] }
    }
  }

  await saveBatchJob(env.DB, pendingJob)

  return {
    submitted: true,
    message: `Single ${opts.category} batch job submitted for ${targetDate}.`,
    batchName,
    targetDate,
    themes: { [opts.category]: opts.theme },
  }
}

// ---------------------------------------------------------------------------
// Synchronous single-tile regen (interactive admin path).
//
// Unlike handleSingleBatchSubmit (which enqueues a slow async batch), this
// generates the image in-request via :generateContent, runs the SAME border +
// diamond gates inline (regenerating up to the same limits), encodes WebP, and
// writes it straight into R2 + the puzzle record — so an admin regen of one
// tile resolves in seconds and is immediately verifiable, instead of waiting
// hours on a batch that may never complete.
// ---------------------------------------------------------------------------

export type SyncRegenResult = {
  ok: boolean
  message: string
  date?: string
  category?: PuzzleCategory
  theme?: string
  attempts?: number
  gate?: string
  imageUrl?: string
}

export async function handleSyncSingleRegen(
  env: Bindings,
  opts: {
    category: PuzzleCategory
    prompt: string
    theme: string
    keywords: string[]
    date: string
  },
): Promise<SyncRegenResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { ok: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }
  if (!isValidDateKey(opts.date)) {
    return { ok: false, message: 'Invalid date format. Use YYYY-MM-DD.' }
  }

  await ensurePuzzleTables(env.DB)

  // Cancel any batch already queued for this date+category so the slow async
  // job can't later overwrite what we're about to generate synchronously.
  const queued = await getAllPendingBatchJobs(env.DB)
  for (const job of queued) {
    if (job.targetDate !== opts.date) continue
    const cats = job.requestedCategories ?? CATEGORIES
    if (!cats.includes(opts.category)) continue
    await cancelBatchJob(env, { batchName: job.batchName })
  }

  // Generate -> gate -> regenerate, capped like the batch path. Border and
  // diamond-complexity gates each force a fresh-prompt regen up to the cap;
  // a single counter bounds total attempts so a stubborn subject can't spin.
  const MAX_ATTEMPTS = 3
  let prompt = opts.prompt
  let theme = opts.theme
  let keywords = opts.keywords
  let imageBytes: Uint8Array | null = null
  let usedAttempts = 0
  let gateReason = 'passed'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    usedAttempts = attempt
    const gen = await generateImageSync(env.GOOGLE_AI_API_KEY, opts.category, prompt)

    let needsRegen = false
    let reason = ''
    try {
      const border = detectBorder(gen.imageBytes)
      if (border.hasBorder) {
        needsRegen = true
        reason = `bordered (${border.flaggedEdges.join(',')})`
      }
    } catch (err) {
      console.warn('[sync-regen] border detection failed', err)
    }

    if (!needsRegen && opts.category === 'diamond') {
      const gate = await diamondNeedsRegen(env, gen.imageBytes)
      if (gate.regen) {
        needsRegen = true
        reason = gate.reason
      }
    }

    if (!needsRegen) {
      imageBytes = gen.imageBytes
      gateReason = 'passed'
      break
    }

    gateReason = reason
    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `[sync-regen] ${opts.date}/${opts.category} ${reason} — regenerating (attempt ${attempt}/${MAX_ATTEMPTS})`,
      )
      // Fresh prompt for the next attempt, with the matching nudge.
      const details = await generateSingleCategoryPrompt(env.DB, opts.category, makeGemmaRewriter(env) ?? undefined)
      prompt = details.prompt
      prompt += reason.startsWith('bordered') ? `\n\n${BORDER_PROMPT_ADDENDUM}` : `\n\n${COMPLEXITY_PROMPT_ADDENDUM}`
      theme = details.theme
      keywords = details.keywords
    } else {
      // Exhausted — accept the last image (mirrors the batch path's "hit
      // regen limit, accept" so we never leave the tile blank).
      imageBytes = gen.imageBytes
      console.warn(`[sync-regen] ${opts.date}/${opts.category} hit regen limit (${MAX_ATTEMPTS}), accepting image (${reason})`)
    }
  }

  if (!imageBytes) {
    return { ok: false, message: 'Generation produced no usable image.', date: opts.date, category: opts.category }
  }

  // Encode WebP + thumbnail and write to R2.
  const encoded = await processPngImage(imageBytes)
  await Promise.all([
    env.assets.put(`puzzles/${opts.date}/${opts.category}.${encoded.extension}`, encoded.image, {
      httpMetadata: { contentType: encoded.contentType },
    }),
    env.assets.put(`puzzles/${opts.date}/${opts.category}_thumb.${encoded.extension}`, encoded.thumbnail, {
      httpMetadata: { contentType: encoded.contentType },
    }),
    env.assets.delete(`temp/${opts.date}/${opts.category}.png`),
  ])

  // Merge the regenerated tile into the existing puzzle record (mirrors
  // finalizeRecord's single-category merge), bumping the cache-buster.
  const now = new Date().toISOString()
  const cacheBuster = `?v=${Date.now()}`
  const existing = await getPuzzleByDate(env.DB, opts.date)
  const categories = (existing?.categories ?? {}) as Record<PuzzleCategory, PuzzleAsset>
  const imageKey = `puzzles/${opts.date}/${opts.category}.webp`
  const thumbKey = `puzzles/${opts.date}/${opts.category}_thumb.webp`
  categories[opts.category] = {
    imageKey,
    imageUrl: toCdnUrl(imageKey) + cacheBuster,
    contentType: 'image/webp',
    fileName: `${opts.category}.webp`,
    theme,
    tags: keywords,
    thumbnailKey: thumbKey,
    thumbnailUrl: toCdnUrl(thumbKey) + cacheBuster,
  }
  const record: PuzzleRecord = {
    date: opts.date,
    difficulty: existing?.difficulty ?? 'adaptive',
    categories,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await savePuzzleRecord(env.DB, record)
  await clearStuckRetry(env.DB, opts.date)

  return {
    ok: true,
    message: `Synchronously regenerated ${opts.category} for ${opts.date} in ${usedAttempts} attempt(s) (gate: ${gateReason}).`,
    date: opts.date,
    category: opts.category,
    theme,
    attempts: usedAttempts,
    gate: gateReason,
    imageUrl: toCdnUrl(imageKey) + cacheBuster,
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Poll / fetch / process (periodic cron, one step per invocation)
// ---------------------------------------------------------------------------

export async function handleBatchPoll(
  env: Bindings,
  opts: BatchPollOptions = {},
): Promise<BatchPollResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { found: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }

  await ensurePuzzleTables(env.DB)

  // The pause flag is there to stop automated cron work while the
  // pipeline is being investigated. The manual local-encode button is
  // explicitly user-driven (and is the typical reason for pausing —
  // you pause cron, then drive a stuck batch through by hand), so it
  // should bypass the pause.
  if (!opts.skipProcess && (await isPipelinePaused(env.DB))) {
    return { found: false, message: 'Pipeline is paused. Resume it in admin settings to continue polling.' }
  }

  const jobs = await getAllPendingBatchJobs(env.DB)
  if (jobs.length === 0) {
    return { found: false, message: 'No pending batch job.' }
  }

  // Prefer CPU-bound work on a job whose images are already fetched —
  // process every remaining category in one tick so the whole batch
  // finalises immediately instead of dribbling through one image per
  // cron firing.
  const fetchedJob = jobs.find((j) => j.phase === 'fetched')
  if (fetchedJob) {
    if (opts.skipProcess) {
      return describeFetchedForLocalProcess(fetchedJob)
    }
    return await processRemainingCategories(env, fetchedJob)
  }

  // Otherwise poll Gemini for every submitted job in FIFO order so
  // multiple batches can progress in parallel at the provider. Return
  // as soon as one completes — we fetch its images and let the next
  // tick advance from the 'fetched' state.
  const submittedJobs = jobs.filter((j) => j.phase === 'submitted')
  const pollMessages: string[] = []

  for (const job of submittedJobs) {
    const result = await pollImageBatch(env.GOOGLE_AI_API_KEY, job.batchName)

    if (result.state === 'pending' || result.state === 'running') {
      const stats = result.stats
      const succeeded = Number(stats?.succeededRequestCount ?? stats?.successfulRequestCount ?? 0)
      const ageHours = (Date.now() - new Date(job.submittedAt).getTime()) / 3_600_000

      // Wedged: Gemini has queued it for hours but completed ZERO requests
      // (a healthy batch starts within minutes). Drop it and resubmit the same
      // date immediately rather than waiting out the 24h SLA. Only escalate to
      // an email once a resubmit ALSO sticks — a one-off hiccup self-heals.
      // The threshold scales with image count (1 img ~2h, 5 imgs ~6h).
      const imageCount = (job.requestedCategories ?? CATEGORIES).length
      if (succeeded === 0 && ageHours > stuckThresholdHours(imageCount)) {
        const retryCount = await bumpStuckRetry(env.DB, job.targetDate)
        await deleteBatchJob(env.DB, job.batchName)
        const resub = await handleBatchSubmit(env, { date: job.targetDate, force: true })
        return {
          found: true,
          state: 'stuck',
          stuckAlert: retryCount >= STUCK_RETRY_ALERT,
          retryCount,
          resubmitted: resub.submitted,
          batchName: job.batchName,
          targetDate: job.targetDate,
          submittedAt: job.submittedAt,
          message: `Batch for ${job.targetDate} wedged at Gemini (0 done after ${Math.round(ageHours)}h) — dropped and ${resub.submitted ? 'resubmitted' : `resubmit skipped: ${resub.message}`} (attempt ${retryCount}).`,
        }
      }

      const statsMsg = stats
        ? ` [${stats.succeededRequestCount ?? stats.successfulRequestCount ?? 0}/${stats.requestCount ?? '?'} done, ${stats.pendingRequestCount ?? 0} pending]`
        : ''
      pollMessages.push(`${job.targetDate}: ${result.state}${statsMsg}`)
      continue
    }

    if (result.state === 'failed') {
      await deleteBatchJob(env.DB, job.batchName)
      return {
        found: true,
        message: `Batch job for ${job.targetDate} failed: ${result.error}`,
        batchName: job.batchName,
        targetDate: job.targetDate,
        state: 'failed',
        submittedAt: job.submittedAt,
        error: result.error,
        rawResponse: result.rawResponse,
      }
    }

    if (result.state === 'unknown') {
      pollMessages.push(`${job.targetDate}: unknown (will retry)`)
      continue
    }

    // Batch succeeded — save raw images to R2 temp, unless border detection
    // flags one. A flagged image is left off temp so processRemainingCategories
    // triggers the existing missing-temp regen path. Each category gets at
    // most BORDER_REGEN_LIMIT regens before we give up and accept the image
    // so the pipeline can't spin forever on a stubborn model.
    const BORDER_REGEN_LIMIT = 2
    const NO_IMAGE_REGEN_LIMIT = 3
    const COMPLEXITY_REGEN_LIMIT = 2
    const failures = job.validationFailures ?? {}
    const noImageFailures = job.noImageFailures ?? {}
    const complexityFailures = job.complexityFailures ?? {}
    let saved = 0
    let borderFlagged = 0
    for (const image of result.images) {
      const attempts = failures[image.category] ?? 0
      let skipForBorder = false
      if (attempts < BORDER_REGEN_LIMIT) {
        try {
          const detection = detectBorder(image.imageBytes)
          if (detection.hasBorder) {
            failures[image.category] = attempts + 1
            borderFlagged++
            skipForBorder = true
            console.warn(
              `[border] ${job.targetDate}/${image.category} flagged edges=${detection.flaggedEdges.join(',')} — skipping temp for regen (attempt ${attempts + 1}/${BORDER_REGEN_LIMIT})`,
            )
          }
        } catch (err) {
          console.warn(`[border] detection failed for ${image.category}`, err)
        }
      } else {
        console.warn(
          `[border] ${job.targetDate}/${image.category} hit regen limit (${BORDER_REGEN_LIMIT}), accepting image even if bordered`,
        )
      }

      // Diamond only: a too-simple quantization (one giant flat region you
      // fill in a couple of taps) gets the same "skip temp -> regenerate"
      // treatment as a bordered image, capped by COMPLEXITY_REGEN_LIMIT.
      let skipForComplexity = false
      if (!skipForBorder && image.category === 'diamond') {
        const cAttempts = complexityFailures[image.category] ?? 0
        if (cAttempts < COMPLEXITY_REGEN_LIMIT) {
          const gate = await diamondNeedsRegen(env, image.imageBytes)
          if (gate.regen) {
            complexityFailures[image.category] = cAttempts + 1
            skipForComplexity = true
            console.warn(
              `[complexity] ${job.targetDate}/diamond ${gate.reason} — skipping temp for regen (attempt ${cAttempts + 1}/${COMPLEXITY_REGEN_LIMIT})`,
            )
          }
        } else {
          console.warn(`[complexity] ${job.targetDate}/diamond hit regen limit (${COMPLEXITY_REGEN_LIMIT}), accepting image`)
        }
      }

      if (skipForBorder || skipForComplexity) continue

      const tempKey = `temp/${job.targetDate}/${image.category}.png`
      await env.assets.put(tempKey, image.imageBytes, {
        httpMetadata: { contentType: image.mimeType || 'image/png' },
      })
      saved++
    }
    job.validationFailures = failures
    job.complexityFailures = complexityFailures

    // Track per-category NO_IMAGE responses (Gemini accepted the prompt
    // but the model produced no image — finishReason='NO_IMAGE' or a
    // safety block). These need a freshly-generated prompt and a regen.
    for (const category of result.noImageCategories) {
      noImageFailures[category] = (noImageFailures[category] ?? 0) + 1
      console.warn(
        `[no-image] ${job.targetDate}/${category} returned no image (attempt ${noImageFailures[category]}/${NO_IMAGE_REGEN_LIMIT})`,
      )
    }
    job.noImageFailures = noImageFailures

    const exhausted = result.noImageCategories.find(
      (c) => (noImageFailures[c] ?? 0) >= NO_IMAGE_REGEN_LIMIT,
    )
    if (exhausted) {
      // Permanent failure for at least one category — bail out so an
      // alert fires and the operator can investigate / cancel manually.
      await deleteBatchJob(env.DB, job.batchName)
      return {
        found: true,
        message: `Batch for ${job.targetDate} exhausted NO_IMAGE retries for ${exhausted} (${noImageFailures[exhausted]}/${NO_IMAGE_REGEN_LIMIT}).`,
        batchName: job.batchName,
        targetDate: job.targetDate,
        state: 'failed',
        submittedAt: job.submittedAt,
        error: `Gemini returned NO_IMAGE for ${exhausted} ${noImageFailures[exhausted]} times in a row.`,
        rawResponse: result.rawResponse,
      }
    }

    // If the batch came back with zero response entries (not just zero
    // images), that's a transient Gemini issue rather than the model
    // declining to draw. Keep the job for retry without bumping any
    // counters, mirroring the pre-fix behaviour.
    if (!result.hasResponseEntries && saved === 0 && borderFlagged === 0) {
      return {
        found: true,
        message: `Batch for ${job.targetDate} completed but no response entries from Gemini. Job kept for retry.`,
        batchName: job.batchName,
        targetDate: job.targetDate,
        state: 'incomplete',
        submittedAt: job.submittedAt,
        imagesProcessed: 0,
        rawResponse: result.rawResponse,
      }
    }

    // Flipping to 'fetched' even when every image was border-flagged or
    // NO_IMAGE'd is intentional: processRemainingCategories sees the
    // missing temps and submits single-category regens with a fresh
    // prompt (and the border addendum where appropriate).
    job.phase = 'fetched'
    await saveBatchJob(env.DB, job)

    // Manual local-encode path stops here so the browser can pull the
    // raw PNGs out of R2 temp, encode WebP itself, and POST the result
    // back. Cron flow falls through and processes in-Worker.
    if (opts.skipProcess) {
      return describeFetchedForLocalProcess(job)
    }

    // Fall through into processing in the same tick rather than
    // returning and waiting for the next cron firing.
    return await processRemainingCategories(env, job)
  }

  // All submitted jobs still waiting at Gemini.
  const head = submittedJobs[0] ?? jobs[0]
  return {
    found: true,
    message: `${submittedJobs.length} batch job(s) still waiting at Gemini (${pollMessages.join('; ')}).`,
    batchName: head.batchName,
    targetDate: head.targetDate,
    state: 'pending',
    submittedAt: head.submittedAt,
  }
}

// ---------------------------------------------------------------------------
// Process every remaining category in a single tick, then finalize.
// ---------------------------------------------------------------------------

async function processRemainingCategories(env: Bindings, job: PendingBatchJob): Promise<BatchPollResult> {
  const { batchName, targetDate, submittedAt } = job
  const jobCategories = job.requestedCategories ?? CATEGORIES
  const processed = new Set(job.processedCategories)
  const remaining = jobCategories.filter((c) => !processed.has(c))

  if (remaining.length === 0) {
    return await finalizeRecord(env, job)
  }

  // Decode + encode sequentially (CPU-bound, no overlap benefit) while
  // keeping the encoded bytes in memory. If one category's temp PNG is
  // missing we bail out early — same regen-submit behaviour as before —
  // rather than silently finalising a short record.
  const encoded: { category: PuzzleCategory; jpeg: Uint8Array; thumbnail: Uint8Array }[] = []
  for (const category of remaining) {
    const tempKey = `temp/${targetDate}/${category}.png`
    const tempObject = await env.assets.get(tempKey)
    if (!tempObject) {
      if (env.GOOGLE_AI_API_KEY) {
        const details = await generateSingleCategoryPrompt(
          env.DB,
          category,
          makeGemmaRewriter(env) ?? undefined,
        )
        // Border-flagged regens need the extra nudge; other "missing temp"
        // situations (e.g. R2 hiccup) get the plain prompt back.
        const borderedBefore = (job.validationFailures?.[category] ?? 0) > 0
        const tooSimpleBefore = (job.complexityFailures?.[category] ?? 0) > 0
        let prompt = details.prompt
        if (borderedBefore) prompt += `\n\n${BORDER_PROMPT_ADDENDUM}`
        if (tooSimpleBefore) prompt += `\n\n${COMPLEXITY_PROMPT_ADDENDUM}`
        const { batchName: newBatch } = await submitImageBatch(env.GOOGLE_AI_API_KEY, [
          { category, prompt },
        ])

        // saveBatchJob upserts on batch_name (UNIQUE). Rewriting job.batchName
        // without deleting the old row leaves a duplicate behind, so the next
        // poll tick sees two pending jobs for the same date and both keep
        // submitting regens — the infinite-loop bug. Delete the old row first.
        const previousBatchName = job.batchName
        job.categories[category] = { theme: details.theme, keywords: details.keywords }
        job.phase = 'submitted'
        job.batchName = newBatch
        if (previousBatchName && previousBatchName !== newBatch) {
          await deleteBatchJob(env.DB, previousBatchName)
        }
        await saveBatchJob(env.DB, job)

        return {
          found: true,
          message: `Temp image for ${category} was missing at ${tempKey}. Submitted a regeneration batch for ${category}${borderedBefore ? ' (with no-border nudge)' : ''}.`,
          batchName: newBatch,
          targetDate,
          state: 'regenerating',
          submittedAt,
          imagesProcessed: processed.size,
        }
      }
      return {
        found: true,
        message: `Temp image for ${category} not found at ${tempKey}. Job kept for retry.`,
        batchName,
        targetDate,
        state: 'processing',
        submittedAt,
        imagesProcessed: processed.size,
      }
    }

    const pngBytes = new Uint8Array(await tempObject.arrayBuffer())
    const encodedImage = await processPngImage(pngBytes)
    encoded.push({ category, ...encodedImage })
  }

  // R2 writes are IO-bound — do them in parallel.
  await Promise.all(
    encoded.flatMap(({ category, image, thumbnail, contentType, extension }) => [
      env.assets.put(`puzzles/${targetDate}/${category}.${extension}`, image, {
        httpMetadata: { contentType },
      }),
      env.assets.put(`puzzles/${targetDate}/${category}_thumb.${extension}`, thumbnail, {
        httpMetadata: { contentType },
      }),
      env.assets.delete(`temp/${targetDate}/${category}.png`),
    ]),
  )

  job.processedCategories = [...processed, ...encoded.map((e) => e.category)]
  return await finalizeRecord(env, job)
}

// ---------------------------------------------------------------------------
// Local-process (manual) helpers
//
// The "Poll & process (manual)" admin button avoids Worker CPU limits by
// having the browser do the WebP encode. handleBatchPoll(skipProcess)
// stops once raw PNGs are in R2 temp; the client then pulls each PNG,
// encodes it locally, and POSTs the encoded bytes back via
// applyProcessedCategoryUpload, which writes R2 + finalises when the
// last category arrives.
// ---------------------------------------------------------------------------

function describeFetchedForLocalProcess(job: PendingBatchJob): BatchPollResult {
  const jobCategories = job.requestedCategories ?? CATEGORIES
  const processed = new Set(job.processedCategories)
  const remaining = jobCategories.filter((c) => !processed.has(c))
  return {
    found: true,
    message:
      remaining.length === 0
        ? `Job for ${job.targetDate} already fully processed; finalising.`
        : `Batch for ${job.targetDate} ready for local processing (${remaining.length} categor${remaining.length === 1 ? 'y' : 'ies'} pending).`,
    batchName: job.batchName,
    targetDate: job.targetDate,
    state: 'fetched',
    submittedAt: job.submittedAt,
    imagesProcessed: processed.size,
    remainingCategories: remaining,
  }
}

export async function applyProcessedCategoryUpload(
  env: Bindings,
  args: {
    batchName: string
    targetDate: string
    category: PuzzleCategory
    image: ArrayBuffer
    thumbnail: ArrayBuffer
    contentType?: string
    extension?: string
  },
): Promise<BatchPollResult> {
  const contentType = args.contentType ?? 'image/webp'
  const extension = args.extension ?? 'webp'

  await ensurePuzzleTables(env.DB)

  const job = await getBatchJobByBatchName(env.DB, args.batchName)
  if (!job) {
    return {
      found: false,
      message: `No pending batch job for ${args.batchName}; it may have already been finalised.`,
    }
  }
  if (job.targetDate !== args.targetDate) {
    return {
      found: false,
      message: `Batch ${args.batchName} targets ${job.targetDate}, not ${args.targetDate}.`,
    }
  }

  const requested = job.requestedCategories ?? CATEGORIES
  if (!requested.includes(args.category)) {
    return {
      found: false,
      message: `Category ${args.category} is not part of batch ${args.batchName}.`,
    }
  }

  await Promise.all([
    env.assets.put(`puzzles/${args.targetDate}/${args.category}.${extension}`, args.image, {
      httpMetadata: { contentType },
    }),
    env.assets.put(`puzzles/${args.targetDate}/${args.category}_thumb.${extension}`, args.thumbnail, {
      httpMetadata: { contentType },
    }),
    env.assets.delete(`temp/${args.targetDate}/${args.category}.png`),
  ])

  if (!job.processedCategories.includes(args.category)) {
    job.processedCategories = [...job.processedCategories, args.category]
  }

  const stillRemaining = requested.filter((c) => !job.processedCategories.includes(c))
  if (stillRemaining.length === 0) {
    return await finalizeRecord(env, job)
  }

  await saveBatchJob(env.DB, job)
  return {
    found: true,
    message: `Stored ${args.category} for ${args.targetDate}; ${stillRemaining.length} categor${stillRemaining.length === 1 ? 'y' : 'ies'} still to upload.`,
    batchName: job.batchName,
    targetDate: job.targetDate,
    state: 'fetched',
    submittedAt: job.submittedAt,
    imagesProcessed: job.processedCategories.length,
    remainingCategories: stillRemaining,
  }
}

// ---------------------------------------------------------------------------
// Finalize: create puzzle record from processed images
// ---------------------------------------------------------------------------

async function finalizeRecord(env: Bindings, job: PendingBatchJob): Promise<BatchPollResult> {
  const { batchName, targetDate, submittedAt, categories: categoryMeta } = job
  const jobCategories = job.requestedCategories ?? CATEGORIES

  // For single-category jobs, merge into existing puzzle record if one exists
  let existingRecord: PuzzleRecord | null = null
  if (jobCategories.length < CATEGORIES.length) {
    existingRecord = await getPuzzleByDate(env.DB, targetDate)
  }

  const now = new Date().toISOString()
  const cacheBuster = `?v=${Date.now()}`
  const puzzleCategories = (existingRecord?.categories ?? {}) as Record<PuzzleCategory, PuzzleAsset>
  for (const category of jobCategories) {
    const meta = categoryMeta[category]
    // New puzzles are encoded as WebP; older puzzle records keep their
    // existing .jpg paths since R2 still serves those files. Only new
    // generations after this commit get .webp.
    const imageKey = `puzzles/${targetDate}/${category}.webp`
    const thumbKey = `puzzles/${targetDate}/${category}_thumb.webp`

    puzzleCategories[category] = {
      imageKey,
      imageUrl: toCdnUrl(imageKey) + cacheBuster,
      contentType: 'image/webp',
      fileName: `${category}.webp`,
      theme: meta.theme,
      tags: meta.keywords,
      thumbnailKey: thumbKey,
      thumbnailUrl: toCdnUrl(thumbKey) + cacheBuster,
    }
  }
  const record: PuzzleRecord = {
    date: targetDate,
    difficulty: existingRecord?.difficulty ?? 'adaptive',
    categories: puzzleCategories,
    createdAt: existingRecord?.createdAt ?? now,
    updatedAt: now,
  }

  await savePuzzleRecord(env.DB, record)
  // The date finally produced a puzzle — clear any stuck-retry tally for it.
  await clearStuckRetry(env.DB, targetDate)
  await deleteBatchJob(env.DB, batchName)

  const catLabel = jobCategories.length === 1 ? jobCategories[0] : `${jobCategories.length} categories`

  return {
    found: true,
    message: `Puzzle for ${targetDate} saved (${catLabel}).`,
    batchName,
    targetDate,
    state: 'succeeded',
    submittedAt,
    imagesProcessed: jobCategories.length,
    savedDate: targetDate,
  }
}

// ---------------------------------------------------------------------------
// Batch job status (queue page listing)
// ---------------------------------------------------------------------------

export type BatchJobStatus = {
  active: boolean
  phase?: string
  batchName?: string
  targetDate?: string
  submittedAt?: string
  processedCategories?: PuzzleCategory[]
  remainingCategories?: PuzzleCategory[]
  themes?: Record<string, string>
  queue?: BatchJobStatus[]
  queueLength?: number
}

function describeJob(job: PendingBatchJob): BatchJobStatus {
  const jobCategories = job.requestedCategories ?? CATEGORIES
  const remaining = jobCategories.filter((c) => !job.processedCategories.includes(c))
  const themes: Record<string, string> = {}
  for (const category of jobCategories) {
    themes[category] = job.categories[category]?.theme ?? ''
  }
  return {
    active: true,
    phase: job.phase,
    batchName: job.batchName,
    targetDate: job.targetDate,
    submittedAt: job.submittedAt,
    processedCategories: [...job.processedCategories],
    remainingCategories: remaining,
    themes,
  }
}

export async function getBatchJobStatus(env: Bindings): Promise<BatchJobStatus> {
  await ensurePuzzleTables(env.DB)
  const jobs = await getAllPendingBatchJobs(env.DB)
  if (jobs.length === 0) {
    return { active: false, queue: [], queueLength: 0 }
  }

  const head = describeJob(jobs[0])
  const queue = jobs.map(describeJob)
  return { ...head, queue, queueLength: queue.length }
}

export async function cancelBatchJob(
  env: Bindings,
  opts: { batchName?: string; targetDate?: string },
): Promise<{ ok: boolean; message: string }> {
  await ensurePuzzleTables(env.DB)
  // Prefer cancelling by batch_name since it's unique — a date may
  // host multiple queued jobs (e.g. jigsaw resubmit + diamond resubmit).
  // Fall back to "cancel everything for this date" when only a date is
  // provided, for backwards compatibility.
  if (opts.batchName) {
    const existing = await getBatchJobByBatchName(env.DB, opts.batchName)
    if (!existing) {
      return { ok: false, message: `No batch job found with id ${opts.batchName}.` }
    }
    // Best-effort: ask Gemini to actually stop a still-running job (deleting
    // only the local row leaves it running/billing on Google's side). Swallow
    // failures — cancel is best-effort and the local cleanup must still happen.
    if (env.GOOGLE_AI_API_KEY && existing.phase === 'submitted') {
      try {
        await cancelImageBatch(env.GOOGLE_AI_API_KEY, opts.batchName)
      } catch (err) {
        console.warn(`[cancel] Gemini-side cancel failed for ${opts.batchName}`, err)
      }
    }
    await deleteBatchJob(env.DB, opts.batchName)
    for (const category of existing.requestedCategories ?? CATEGORIES) {
      try {
        await env.assets.delete(`temp/${existing.targetDate}/${category}.png`)
      } catch {
        // ignore
      }
    }
    return { ok: true, message: `Cancelled batch job for ${existing.targetDate}.` }
  }

  if (opts.targetDate) {
    const existingJobs = await getBatchJobsByTargetDate(env.DB, opts.targetDate)
    if (existingJobs.length === 0) {
      return { ok: false, message: `No batch job queued for ${opts.targetDate}.` }
    }
    for (const job of existingJobs) {
      if (env.GOOGLE_AI_API_KEY && job.phase === 'submitted') {
        try {
          await cancelImageBatch(env.GOOGLE_AI_API_KEY, job.batchName)
        } catch (err) {
          console.warn(`[cancel] Gemini-side cancel failed for ${job.batchName}`, err)
        }
      }
      await deleteBatchJob(env.DB, job.batchName)
      for (const category of job.requestedCategories ?? CATEGORIES) {
        try {
          await env.assets.delete(`temp/${opts.targetDate}/${category}.png`)
        } catch {
          // ignore
        }
      }
    }
    return {
      ok: true,
      message: `Cancelled ${existingJobs.length} batch job(s) for ${opts.targetDate}.`,
    }
  }

  return { ok: false, message: 'Provide either batchName or targetDate to cancel.' }
}

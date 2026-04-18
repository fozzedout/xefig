import { CATEGORIES, type Bindings, type PuzzleAsset, type PuzzleCategory, type PuzzleRecord } from '../types'
import { generatePromptPacks, generateSingleCategoryPrompt } from './prompts'
import { submitImageBatch, pollImageBatch, type BatchRequest } from './gemini'
import { detectBorder, processPngImage } from './image'

const BORDER_PROMPT_ADDENDUM =
  'Critical: the image must be full-bleed. Content extends completely to all four edges — no white frame, no coloured border, no paper texture, no torn or deckled edges, no vignette, no matting.'
import { findNextUnscheduledDate, getPuzzleByDate, getUtcDateKey, isValidDateKey, toCdnUrl, savePuzzleRecord } from './puzzles'
import {
  ensurePuzzleTables,
  getBatchJobsByTargetDate,
  getBatchJobByBatchName,
  getAllPendingBatchJobs,
  saveBatchJob,
  deleteBatchJob,
  type PendingBatchJob,
} from './puzzle-db'

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
    const [pack] = await generatePromptPacks(env.DB, 1)
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
// Phase 2: Poll / fetch / process (periodic cron, one step per invocation)
// ---------------------------------------------------------------------------

export async function handleBatchPoll(env: Bindings): Promise<BatchPollResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { found: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }

  await ensurePuzzleTables(env.DB)
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
    const failures = job.validationFailures ?? {}
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

      if (skipForBorder) continue

      const tempKey = `temp/${job.targetDate}/${image.category}.png`
      await env.assets.put(tempKey, image.imageBytes, {
        httpMetadata: { contentType: image.mimeType || 'image/png' },
      })
      saved++
    }
    job.validationFailures = failures

    if (saved === 0 && borderFlagged === 0) {
      return {
        found: true,
        message: `Batch for ${job.targetDate} completed but no images found. Job kept for retry.`,
        batchName: job.batchName,
        targetDate: job.targetDate,
        state: 'incomplete',
        submittedAt: job.submittedAt,
        imagesProcessed: 0,
        rawResponse: result.rawResponse,
      }
    }

    // Flipping to 'fetched' even when every image was border-flagged is
    // intentional: processRemainingCategories sees the missing temps and
    // submits single-category regens with a sharper prompt.
    job.phase = 'fetched'
    await saveBatchJob(env.DB, job)

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
        const details = await generateSingleCategoryPrompt(env.DB, category)
        // Border-flagged regens need the extra nudge; other "missing temp"
        // situations (e.g. R2 hiccup) get the plain prompt back.
        const borderedBefore = (job.validationFailures?.[category] ?? 0) > 0
        const prompt = borderedBefore ? `${details.prompt}\n\n${BORDER_PROMPT_ADDENDUM}` : details.prompt
        const { batchName: newBatch } = await submitImageBatch(env.GOOGLE_AI_API_KEY, [
          { category, prompt },
        ])

        job.categories[category] = { theme: details.theme, keywords: details.keywords }
        job.phase = 'submitted'
        job.batchName = newBatch
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
    const { jpeg, thumbnail } = processPngImage(pngBytes)
    encoded.push({ category, jpeg, thumbnail })
  }

  // R2 writes are IO-bound — do them in parallel.
  await Promise.all(
    encoded.flatMap(({ category, jpeg, thumbnail }) => [
      env.assets.put(`puzzles/${targetDate}/${category}.jpg`, jpeg, {
        httpMetadata: { contentType: 'image/jpeg' },
      }),
      env.assets.put(`puzzles/${targetDate}/${category}_thumb.jpg`, thumbnail, {
        httpMetadata: { contentType: 'image/jpeg' },
      }),
      env.assets.delete(`temp/${targetDate}/${category}.png`),
    ]),
  )

  job.processedCategories = [...processed, ...encoded.map((e) => e.category)]
  return await finalizeRecord(env, job)
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
    const imageKey = `puzzles/${targetDate}/${category}.jpg`
    const thumbKey = `puzzles/${targetDate}/${category}_thumb.jpg`

    puzzleCategories[category] = {
      imageKey,
      imageUrl: toCdnUrl(imageKey) + cacheBuster,
      contentType: 'image/jpeg',
      fileName: `${category}.jpg`,
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

import { CATEGORIES, type Bindings, type PuzzleAsset, type PuzzleCategory, type PuzzleRecord } from '../types'
import { generatePromptPacks, generateSingleCategoryPrompt } from './prompts'
import { submitImageBatch, pollImageBatch, type BatchRequest } from './gemini'
import { processPngImage } from './image'
import { findNextUnscheduledDate, getPuzzleByDate, getUtcDateKey, isValidDateKey, toCdnUrl, savePuzzleRecord } from './puzzles'
import {
  ensurePuzzleTables,
  getBatchJob,
  getBatchJobByTargetDate,
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
  const queuedDates = new Set(queuedJobs.map((j) => j.targetDate))

  let targetDate: string | null
  if (opts.date) {
    if (!isValidDateKey(opts.date)) {
      return { submitted: false, message: 'Invalid date format. Use YYYY-MM-DD.' }
    }
    targetDate = opts.date

    // Reject if this specific date is already in the queue — submitting
    // again for the same date would overwrite the in-flight job.
    if (queuedDates.has(targetDate)) {
      const existing = queuedJobs.find((j) => j.targetDate === targetDate)!
      return {
        submitted: false,
        message: `A batch job is already queued for ${targetDate}. Cancel it first or pick a different date.`,
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
    targetDate = await findNextUnscheduledDate(env.DB, today, 14, queuedDates)
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
  const queuedDates = new Set(queuedJobs.map((j) => j.targetDate))

  let targetDate: string | null
  if (opts.date) {
    if (!isValidDateKey(opts.date)) {
      return { submitted: false, message: 'Invalid date format. Use YYYY-MM-DD.' }
    }
    targetDate = opts.date
    if (queuedDates.has(targetDate)) {
      const existing = queuedJobs.find((j) => j.targetDate === targetDate)!
      return {
        submitted: false,
        message: `A batch job is already queued for ${targetDate}. Cancel it first or pick a different date.`,
        batchName: existing.batchName,
        targetDate,
      }
    }
  } else {
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
  // that moves the oldest ready job one category closer to done.
  const fetchedJob = jobs.find((j) => j.phase === 'fetched')
  if (fetchedJob) {
    return await processNextCategory(env, fetchedJob)
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
      await deleteBatchJob(env.DB, job.targetDate)
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

    // Batch succeeded — save raw images to R2 temp (base64 decode, lightweight)
    let saved = 0
    for (const image of result.images) {
      const tempKey = `temp/${job.targetDate}/${image.category}.png`
      await env.assets.put(tempKey, image.imageBytes, {
        httpMetadata: { contentType: image.mimeType || 'image/png' },
      })
      saved++
    }

    if (saved === 0) {
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

    job.phase = 'fetched'
    await saveBatchJob(env.DB, job)

    return {
      found: true,
      message: `Batch for ${job.targetDate} completed. ${saved} raw images saved. Processing will begin on next tick.`,
      batchName: job.batchName,
      targetDate: job.targetDate,
      state: 'fetched',
      submittedAt: job.submittedAt,
      imagesProcessed: job.processedCategories.length,
    }
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
// Process one category: read temp PNG → JPEG + thumbnail → final R2 keys
// ---------------------------------------------------------------------------

async function processNextCategory(env: Bindings, job: PendingBatchJob): Promise<BatchPollResult> {
  const { batchName, targetDate, submittedAt, categories: categoryMeta } = job
  const jobCategories = job.requestedCategories ?? CATEGORIES
  const processed = new Set(job.processedCategories)
  const remaining = jobCategories.filter((c) => !processed.has(c))

  if (remaining.length === 0) {
    return await finalizeRecord(env, job)
  }

  const category = remaining[0]
  const meta = categoryMeta[category]
  const tempKey = `temp/${targetDate}/${category}.png`

  const tempObject = await env.assets.get(tempKey)
  if (!tempObject) {
    if (env.GOOGLE_AI_API_KEY) {
      const details = await generateSingleCategoryPrompt(env.DB, category)
      const { batchName: newBatch } = await submitImageBatch(env.GOOGLE_AI_API_KEY, [
        { category, prompt: details.prompt },
      ])

      job.categories[category] = { theme: details.theme, keywords: details.keywords }
      job.phase = 'submitted'
      job.batchName = newBatch
      await saveBatchJob(env.DB, job)

      return {
        found: true,
        message: `Temp image for ${category} was missing at ${tempKey}. Submitted a regeneration batch for ${category}.`,
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

  // AI image validation disabled — cost too high and results unreliable

  const { jpeg, thumbnail } = processPngImage(pngBytes)

  const imageKey = `puzzles/${targetDate}/${category}.jpg`
  const thumbKey = `puzzles/${targetDate}/${category}_thumb.jpg`

  await env.assets.put(imageKey, jpeg, {
    httpMetadata: { contentType: 'image/jpeg' },
  })
  await env.assets.put(thumbKey, thumbnail, {
    httpMetadata: { contentType: 'image/jpeg' },
  })

  // Clean up temp file
  await env.assets.delete(tempKey)

  // Update job state
  job.processedCategories = [...job.processedCategories, category]
  await saveBatchJob(env.DB, job)

  const newRemaining = jobCategories.filter((c) => !job.processedCategories.includes(c))

  if (newRemaining.length === 0) {
    return await finalizeRecord(env, job)
  }

  return {
    found: true,
    message: `Processed ${category} (${job.processedCategories.length}/${CATEGORIES.length}). Next: ${newRemaining[0]}.`,
    batchName,
    targetDate,
    state: 'processing',
    submittedAt,
    imagesProcessed: job.processedCategories.length,
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
  await deleteBatchJob(env.DB, targetDate)

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
// Batch job status (for admin panel to pick up client-side processing)
// ---------------------------------------------------------------------------

export type BatchJobStatus = {
  // True when the head-of-queue job is active — preserved so the old
  // client behaviour (polling a single job) still works.
  active: boolean
  phase?: string
  batchName?: string
  targetDate?: string
  submittedAt?: string
  processedCategories?: PuzzleCategory[]
  remainingCategories?: PuzzleCategory[]
  themes?: Record<string, string>
  tempUrls?: Record<string, string>
  // Full queue (oldest first). Includes the head job above.
  queue?: BatchJobStatus[]
  queueLength?: number
}

function describeJob(job: PendingBatchJob): BatchJobStatus {
  const jobCategories = job.requestedCategories ?? CATEGORIES
  const remaining = jobCategories.filter((c) => !job.processedCategories.includes(c))
  const themes: Record<string, string> = {}
  const tempUrls: Record<string, string> = {}
  for (const category of jobCategories) {
    themes[category] = job.categories[category]?.theme ?? ''
    if (job.phase === 'fetched' && !job.processedCategories.includes(category)) {
      tempUrls[category] = toCdnUrl(`temp/${job.targetDate}/${category}.png`)
    }
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
    tempUrls,
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

export async function cancelBatchJob(env: Bindings, targetDate: string): Promise<{ ok: boolean; message: string }> {
  await ensurePuzzleTables(env.DB)
  const existing = await getBatchJobByTargetDate(env.DB, targetDate)
  if (!existing) {
    return { ok: false, message: `No batch job queued for ${targetDate}.` }
  }
  await deleteBatchJob(env.DB, targetDate)
  // Best-effort temp file cleanup (non-fatal if bucket/file missing).
  for (const category of existing.requestedCategories ?? CATEGORIES) {
    try {
      await env.assets.delete(`temp/${targetDate}/${category}.png`)
    } catch {
      // ignore
    }
  }
  return { ok: true, message: `Cancelled batch job for ${targetDate}.` }
}

// ---------------------------------------------------------------------------
// Complete a single category from client-side processing
// ---------------------------------------------------------------------------

export type CompleteCategoryResult = {
  ok: boolean
  message: string
  allDone: boolean
  savedDate?: string
}

export async function completeBatchCategory(
  env: Bindings,
  category: PuzzleCategory,
  imageData: ArrayBuffer,
  thumbnailData: ArrayBuffer,
  targetDate?: string,
): Promise<CompleteCategoryResult> {
  await ensurePuzzleTables(env.DB)
  const job = targetDate
    ? await getBatchJobByTargetDate(env.DB, targetDate)
    : await getBatchJob(env.DB)
  if (!job) {
    return {
      ok: false,
      message: targetDate
        ? `No queued batch job for ${targetDate}.`
        : 'No pending batch job.',
      allDone: false,
    }
  }

  if (job.phase !== 'fetched') {
    return { ok: false, message: `Batch job is in "${job.phase}" phase, not ready for processing.`, allDone: false }
  }

  if (job.processedCategories.includes(category)) {
    return { ok: true, message: `${category} already processed.`, allDone: false }
  }

  const jobTargetDate = job.targetDate
  const imageKey = `puzzles/${jobTargetDate}/${category}.jpg`
  const thumbKey = `puzzles/${jobTargetDate}/${category}_thumb.jpg`

  await env.assets.put(imageKey, imageData, {
    httpMetadata: { contentType: 'image/jpeg' },
  })
  await env.assets.put(thumbKey, thumbnailData, {
    httpMetadata: { contentType: 'image/jpeg' },
  })

  // Clean up temp file
  await env.assets.delete(`temp/${jobTargetDate}/${category}.png`)

  // Update job state
  job.processedCategories = [...job.processedCategories, category]
  const jobCategories = job.requestedCategories ?? CATEGORIES
  const remaining = jobCategories.filter((c) => !job.processedCategories.includes(c))

  if (remaining.length === 0) {
    const result = await finalizeRecord(env, job)
    return { ok: true, message: result.message, allDone: true, savedDate: result.savedDate }
  }

  await saveBatchJob(env.DB, job)
  return {
    ok: true,
    message: `${category} processed (${job.processedCategories.length}/${CATEGORIES.length}). Remaining: ${remaining.join(', ')}.`,
    allDone: false,
  }
}

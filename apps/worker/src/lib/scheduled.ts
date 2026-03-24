import { CATEGORIES, type Bindings, type PuzzleAsset, type PuzzleCategory, type PuzzleRecord } from '../types'
import { generatePromptPacks } from './prompts'
import { submitImageBatch, pollImageBatch, type BatchRequest } from './gemini'
import { processPngImage } from './image'
import { findNextUnscheduledDate, getUtcDateKey, toCdnUrl, toPuzzleKey } from './puzzles'

const BATCH_JOB_KEY = 'batch-job:pending'

type PendingBatchJob = {
  batchName: string
  targetDate: string
  categories: Record<PuzzleCategory, { theme: string; keywords: string[] }>
  submittedAt: string
  // Tracks processing progress: 'fetched' means raw PNGs saved to R2 temp
  phase: 'submitted' | 'fetched'
  processedCategories: PuzzleCategory[]
}

export type BatchSubmitResult = {
  submitted: boolean
  message: string
  batchName?: string
  targetDate?: string
  themes?: Record<string, string>
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

export async function handleBatchSubmit(env: Bindings): Promise<BatchSubmitResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { submitted: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }

  const existing = await env.metadata.get(BATCH_JOB_KEY)
  if (existing) {
    let pendingJob: PendingBatchJob | null = null
    try { pendingJob = JSON.parse(existing) as PendingBatchJob } catch {}
    return {
      submitted: false,
      message: `Batch job already pending for ${pendingJob?.targetDate ?? 'unknown date'}.`,
      batchName: pendingJob?.batchName,
      targetDate: pendingJob?.targetDate,
    }
  }

  const today = getUtcDateKey()
  const targetDate = await findNextUnscheduledDate(env.metadata, today, 14)
  if (!targetDate) {
    return { submitted: false, message: 'No unscheduled dates found in the next 14 days.' }
  }

  const [pack] = await generatePromptPacks(env.metadata, 1)
  if (!pack) {
    return { submitted: false, message: 'Failed to generate prompt pack.' }
  }

  const requests: BatchRequest[] = CATEGORIES.map((category) => ({
    category,
    prompt: pack.categories[category].prompt,
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
      theme: pack.categories[category].theme,
      keywords: pack.categories[category].keywords,
    }
    themes[category] = pack.categories[category].theme
  }

  await env.metadata.put(BATCH_JOB_KEY, JSON.stringify(pendingJob))

  return {
    submitted: true,
    message: `Batch job submitted for ${targetDate}.`,
    batchName,
    targetDate,
    themes,
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Poll / fetch / process (periodic cron, one step per invocation)
// ---------------------------------------------------------------------------

export async function handleBatchPoll(env: Bindings): Promise<BatchPollResult> {
  if (!env.GOOGLE_AI_API_KEY) {
    return { found: false, message: 'GOOGLE_AI_API_KEY not configured.' }
  }

  const raw = await env.metadata.get(BATCH_JOB_KEY)
  if (!raw) {
    return { found: false, message: 'No pending batch job.' }
  }

  let job: PendingBatchJob
  try {
    job = JSON.parse(raw) as PendingBatchJob
    // Migrate older jobs without phase
    if (!job.phase) job.phase = 'submitted'
    if (!job.processedCategories) job.processedCategories = []
  } catch {
    await env.metadata.delete(BATCH_JOB_KEY)
    return { found: false, message: 'Invalid pending batch job data, cleared.' }
  }

  const { batchName, targetDate, submittedAt } = job

  // --- Phase: fetched → process one category per tick ---
  if (job.phase === 'fetched') {
    return await processNextCategory(env, job)
  }

  // --- Phase: submitted → poll Gemini, fetch raw images when done ---
  const result = await pollImageBatch(env.GOOGLE_AI_API_KEY, batchName)

  if (result.state === 'pending' || result.state === 'running') {
    const stats = result.stats
    const statsMsg = stats
      ? ` [${stats.succeededRequestCount ?? stats.successfulRequestCount ?? 0}/${stats.requestCount ?? '?'} done, ${stats.pendingRequestCount ?? 0} pending]`
      : ''
    return {
      found: true,
      message: `Batch job for ${targetDate} is still ${result.state}${statsMsg} (submitted ${submittedAt}).`,
      batchName,
      targetDate,
      state: result.state,
      submittedAt,
    }
  }

  if (result.state === 'failed') {
    await env.metadata.delete(BATCH_JOB_KEY)
    return {
      found: true,
      message: `Batch job for ${targetDate} failed: ${result.error}`,
      batchName,
      targetDate,
      state: 'failed',
      submittedAt,
      error: result.error,
      rawResponse: result.rawResponse,
    }
  }

  if (result.state === 'unknown') {
    return {
      found: true,
      message: `Batch job for ${targetDate} returned unknown state. Job kept for retry.`,
      batchName,
      targetDate,
      state: 'unknown',
      submittedAt,
      error: result.error,
      rawResponse: result.rawResponse,
    }
  }

  // Batch succeeded — save raw images to R2 temp (just base64 decode, lightweight)
  let saved = 0
  for (const image of result.images) {
    const tempKey = `temp/${targetDate}/${image.category}.png`
    await env.assets.put(tempKey, image.imageBytes, {
      httpMetadata: { contentType: image.mimeType || 'image/png' },
    })
    saved++
  }

  if (saved === 0) {
    return {
      found: true,
      message: `Batch completed but no images found. Job kept for retry.`,
      batchName,
      targetDate,
      state: 'incomplete',
      submittedAt,
      imagesProcessed: 0,
      rawResponse: result.rawResponse,
    }
  }

  // Transition to 'fetched' phase
  job.phase = 'fetched'
  job.processedCategories = []
  await env.metadata.put(BATCH_JOB_KEY, JSON.stringify(job))

  return {
    found: true,
    message: `Batch completed. ${saved} raw images saved. Processing will begin on next tick.`,
    batchName,
    targetDate,
    state: 'fetched',
    submittedAt,
    imagesProcessed: 0,
  }
}

// ---------------------------------------------------------------------------
// Process one category: read temp PNG → JPEG + thumbnail → final R2 keys
// ---------------------------------------------------------------------------

async function processNextCategory(env: Bindings, job: PendingBatchJob): Promise<BatchPollResult> {
  const { batchName, targetDate, submittedAt, categories: categoryMeta } = job
  const processed = new Set(job.processedCategories)
  const remaining = CATEGORIES.filter((c) => !processed.has(c))

  if (remaining.length === 0) {
    return await finalizeRecord(env, job)
  }

  const category = remaining[0]
  const meta = categoryMeta[category]
  const tempKey = `temp/${targetDate}/${category}.png`

  const tempObject = await env.assets.get(tempKey)
  if (!tempObject) {
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
  await env.metadata.put(BATCH_JOB_KEY, JSON.stringify(job))

  const newRemaining = CATEGORIES.filter((c) => !job.processedCategories.includes(c))

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

  const puzzleCategories = {} as Record<PuzzleCategory, PuzzleAsset>
  for (const category of CATEGORIES) {
    const meta = categoryMeta[category]
    const imageKey = `puzzles/${targetDate}/${category}.jpg`
    const thumbKey = `puzzles/${targetDate}/${category}_thumb.jpg`

    puzzleCategories[category] = {
      imageKey,
      imageUrl: toCdnUrl(imageKey),
      contentType: 'image/jpeg',
      fileName: `${category}.jpg`,
      theme: meta.theme,
      tags: meta.keywords,
      thumbnailKey: thumbKey,
      thumbnailUrl: toCdnUrl(thumbKey),
    }
  }

  const now = new Date().toISOString()
  const record: PuzzleRecord = {
    date: targetDate,
    difficulty: 'adaptive',
    categories: puzzleCategories,
    createdAt: now,
    updatedAt: now,
  }

  await env.metadata.put(toPuzzleKey(targetDate), JSON.stringify(record))
  await env.metadata.delete(BATCH_JOB_KEY)

  return {
    found: true,
    message: `Puzzle for ${targetDate} saved with ${CATEGORIES.length} images and thumbnails.`,
    batchName,
    targetDate,
    state: 'succeeded',
    submittedAt,
    imagesProcessed: CATEGORIES.length,
    savedDate: targetDate,
  }
}

// ---------------------------------------------------------------------------
// Batch job status (for admin panel to pick up client-side processing)
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
  tempUrls?: Record<string, string>
}

export async function getBatchJobStatus(env: Bindings): Promise<BatchJobStatus> {
  const raw = await env.metadata.get(BATCH_JOB_KEY)
  if (!raw) {
    return { active: false }
  }

  let job: PendingBatchJob
  try {
    job = JSON.parse(raw) as PendingBatchJob
    if (!job.phase) job.phase = 'submitted'
    if (!job.processedCategories) job.processedCategories = []
  } catch {
    return { active: false }
  }

  const remaining = CATEGORIES.filter((c) => !job.processedCategories.includes(c))
  const themes: Record<string, string> = {}
  const tempUrls: Record<string, string> = {}

  for (const category of CATEGORIES) {
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
): Promise<CompleteCategoryResult> {
  const raw = await env.metadata.get(BATCH_JOB_KEY)
  if (!raw) {
    return { ok: false, message: 'No pending batch job.', allDone: false }
  }

  let job: PendingBatchJob
  try {
    job = JSON.parse(raw) as PendingBatchJob
    if (!job.phase) job.phase = 'submitted'
    if (!job.processedCategories) job.processedCategories = []
  } catch {
    return { ok: false, message: 'Invalid batch job data.', allDone: false }
  }

  if (job.phase !== 'fetched') {
    return { ok: false, message: `Batch job is in "${job.phase}" phase, not ready for processing.`, allDone: false }
  }

  if (job.processedCategories.includes(category)) {
    return { ok: true, message: `${category} already processed.`, allDone: false }
  }

  const { targetDate } = job
  const imageKey = `puzzles/${targetDate}/${category}.jpg`
  const thumbKey = `puzzles/${targetDate}/${category}_thumb.jpg`

  await env.assets.put(imageKey, imageData, {
    httpMetadata: { contentType: 'image/jpeg' },
  })
  await env.assets.put(thumbKey, thumbnailData, {
    httpMetadata: { contentType: 'image/jpeg' },
  })

  // Clean up temp file
  await env.assets.delete(`temp/${targetDate}/${category}.png`)

  // Update job state
  job.processedCategories = [...job.processedCategories, category]
  const remaining = CATEGORIES.filter((c) => !job.processedCategories.includes(c))

  if (remaining.length === 0) {
    const result = await finalizeRecord(env, job)
    return { ok: true, message: result.message, allDone: true, savedDate: result.savedDate }
  }

  await env.metadata.put(BATCH_JOB_KEY, JSON.stringify(job))
  return {
    ok: true,
    message: `${category} processed (${job.processedCategories.length}/${CATEGORIES.length}). Remaining: ${remaining.join(', ')}.`,
    allDone: false,
  }
}

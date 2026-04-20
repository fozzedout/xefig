import './admin.css'

const API_BASE = ''
const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram', 'diamond']

const authGate = document.getElementById('auth-gate')
const gateLoginForm = document.getElementById('gate-login-form')
const gatePassword = document.getElementById('gate-password')
const gateError = document.getElementById('gate-error')
const appContent = document.getElementById('app-content')

const logoutBtn = document.getElementById('logout-btn')

const form = document.getElementById('admin-form')
const dateInput = document.getElementById('date')
const recordBadge = document.getElementById('record-badge')
const imageRule = document.getElementById('image-rule')
const prevDayBtn = document.getElementById('prev-day-btn')
const nextDayBtn = document.getElementById('next-day-btn')
const loadDateBtn = document.getElementById('load-date-btn')
const nextEmptyBtn = document.getElementById('next-empty-btn')
const generateBtn = document.getElementById('generate-prompt-btn')
const copyPackBtn = document.getElementById('copy-pack-btn')
const refreshModelsBtn = document.getElementById('refresh-models-btn')
const rewriteModelSelect = document.getElementById('rewrite-model-select')
const autoGenerateBtn = document.getElementById('auto-generate-btn')
const batchPollBtn = document.getElementById('batch-poll-btn')
const cronSubmitBtn = document.getElementById('cron-submit-btn')
const cronPollBtn = document.getElementById('cron-poll-btn')
const pipelinePauseBtn = document.getElementById('pipeline-pause-btn')
const submitBtn = document.getElementById('submit-btn')
const submitLabel = document.getElementById('submit-label')
const statusBar = document.getElementById('status')
const statusText = document.getElementById('status-text')

// Batch status panel elements (queue grid + activity console).
const batchStatusPanel = document.getElementById('batch-status')
const batchJobGridEl = document.getElementById('batch-job-grid')
const batchEmptyEl = document.getElementById('batch-empty')
const batchQueueCountEl = document.getElementById('batch-queue-count')
const batchSummaryEl = document.getElementById('batch-summary')
const batchLastRefreshEl = document.getElementById('batch-last-refresh')
const batchConsoleLogEl = document.getElementById('batch-console-log')
const batchConsoleClearBtn = document.getElementById('batch-console-clear')
const ribbonEl = document.getElementById('center-active-ribbon')
const ribbonDateEl = document.getElementById('ribbon-date')
const ribbonPhaseEl = document.getElementById('ribbon-phase')
const ribbonProgressFillEl = document.getElementById('ribbon-progress-fill')
const ribbonCountEl = document.getElementById('ribbon-count')

// ─── Admin page switching (Editor / Batch / Messages) ──
const pageNavButtons = document.querySelectorAll('.page-nav-btn')
const adminPages = document.querySelectorAll('.admin-page')
const VALID_PAGES = new Set(['editor', 'trigger', 'queue', 'messages', 'test'])

function switchAdminPage(name) {
  const target = VALID_PAGES.has(name) ? name : 'editor'
  pageNavButtons.forEach((btn) => {
    const selected = btn.dataset.page === target
    btn.setAttribute('aria-selected', selected ? 'true' : 'false')
  })
  adminPages.forEach((pg) => {
    pg.hidden = pg.dataset.page !== target
  })
  document.body.dataset.adminPage = target
  try {
    if (location.hash !== `#${target}` && target !== 'editor') {
      history.replaceState(null, '', `#${target}`)
    } else if (target === 'editor' && location.hash) {
      history.replaceState(null, '', ' ')
    }
  } catch {
    // non-fatal
  }
}
pageNavButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchAdminPage(btn.dataset.page))
})
// Honour hash deep-links on load (#batch, #messages).
const initialHash = (location.hash || '').replace('#', '')
switchAdminPage(initialHash || 'editor')
window.addEventListener('hashchange', () => {
  const next = (location.hash || '').replace('#', '') || 'editor'
  switchAdminPage(next)
})

const promptFields = {
  jigsaw: document.getElementById('prompt-jigsaw'),
  slider: document.getElementById('prompt-slider'),
  swap: document.getElementById('prompt-swap'),
  polygram: document.getElementById('prompt-polygram'),
  diamond: document.getElementById('prompt-diamond'),
}

const thumbEls = {
  jigsaw: document.getElementById('thumb-jigsaw'),
  slider: document.getElementById('thumb-slider'),
  swap: document.getElementById('thumb-swap'),
  polygram: document.getElementById('thumb-polygram'),
  diamond: document.getElementById('thumb-diamond'),
}

const thumbnailEls = {
  jigsaw: document.getElementById('thumbnail-jigsaw'),
  slider: document.getElementById('thumbnail-slider'),
  swap: document.getElementById('thumbnail-swap'),
  polygram: document.getElementById('thumbnail-polygram'),
  diamond: document.getElementById('thumbnail-diamond'),
}

const fileInputs = {
  jigsaw: form.querySelector('input[name="jigsaw"]'),
  slider: form.querySelector('input[name="slider"]'),
  swap: form.querySelector('input[name="swap"]'),
  polygram: form.querySelector('input[name="polygram"]'),
  diamond: form.querySelector('input[name="diamond"]'),
}

// Lightbox
const lightboxOverlay = document.getElementById('lightbox')
const lightboxImg = document.getElementById('lightbox-img')

// Overview
const overviewOverlay = document.getElementById('overview-overlay')
const overviewList = document.getElementById('overview-list')
const overviewBtn = document.getElementById('overview-btn')
const overviewCloseBtn = document.getElementById('overview-close-btn')

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
dateInput.value = tomorrow

let promptPack = null
let isExistingDate = false
let isAuthenticated = false
let isDirty = false

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function setStatus(text, type = 'idle') {
  statusText.textContent = text
  statusBar.dataset.type = type
}

function setAuthState(authenticated) {
  isAuthenticated = authenticated

  // Auth gate
  authGate.hidden = authenticated
  appContent.dataset.locked = authenticated ? 'false' : 'true'

  if (authenticated) {
    startBatchAutoRefresh()
    refreshPauseState()
  } else {
    stopBatchAutoRefresh()
  }
}

function requireAuth() {
  if (isAuthenticated) {
    return true
  }

  setStatus('Sign in first.', 'error')
  return false
}

async function readJsonResponse(response) {
  try {
    return await response.json()
  } catch {
    return {}
  }
}

async function adminFetch(path, init = {}) {
  const method = (init.method || 'GET').toUpperCase()
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
  })
  const payload = await readJsonResponse(response)

  if (response.status === 401) {
    setAuthState(false)
  }

  // Route batch-related requests through the activity console so the user
  // sees every submit/poll/cancel round-trip in the same place the queue
  // is rendered.
  if (typeof logBatch === 'function' && path.startsWith('/api/admin/generate-images')) {
    const summary = summarizeBatchResponse(method, path, payload, response.status)
    if (summary) {
      logBatch(summary, response.ok ? 'info' : 'warn')
    }
  }

  return { response, payload }
}

async function refreshSession({ quiet = false } = {}) {
  try {
    const { response, payload } = await adminFetch('/api/admin/session')
    if (!response.ok) {
      setAuthState(false)
      if (!quiet) {
        setStatus(payload.error || 'Could not verify admin session.', 'error')
      }
      return false
    }

    const authenticated = Boolean(payload.authenticated)
    setAuthState(authenticated)
    if (!quiet) {
      setStatus(authenticated ? 'Admin session active.' : 'Sign in to use admin tools.', authenticated ? 'ok' : 'note')
    }
    return authenticated
  } catch {
    setAuthState(false)
    if (!quiet) {
      setStatus('Network error while checking admin session.', 'error')
    }
    return false
  }
}

function addDays(dateKey, n) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
}

function setRecordBadge(text, state = 'idle') {
  recordBadge.textContent = text
  recordBadge.dataset.state = state
}

function applyDateMode() {
  for (const cat of CATEGORIES) {
    if (fileInputs[cat]) {
      fileInputs[cat].required = !isExistingDate
    }
  }

  if (isExistingDate) {
    submitLabel.textContent = 'Save Changes'
    imageRule.textContent = 'Existing date - leave a slot empty to keep its current image.'
  } else {
    submitLabel.textContent = 'Create Puzzle'
    imageRule.textContent = 'New date - all five images are required to create it.'
  }
}

function clearPrompts() {
  for (const category of CATEGORIES) {
    if (promptFields[category]) {
      promptFields[category].value = ''
    }

    const categoryThemeInput = document.getElementById(`theme-${category}`)
    const categoryTagsInput = document.getElementById(`tags-${category}`)
    if (categoryThemeInput) {
      categoryThemeInput.value = ''
    }
    if (categoryTagsInput) {
      categoryTagsInput.value = ''
    }
  }
}

function setThumb(category, asset) {
  const wrap = thumbEls[category]
  if (!wrap) {
    return
  }

  const img = wrap.querySelector('img')
  if (!asset?.imageUrl) {
    wrap.hidden = true
    img.src = ''
  } else {
    img.src = asset.imageUrl
    wrap.hidden = false
  }

  // Thumbnail preview
  const thumbWrap = thumbnailEls[category]
  if (!thumbWrap) {
    return
  }

  const thumbImg = thumbWrap.querySelector('img')
  if (!asset?.thumbnailUrl) {
    thumbWrap.hidden = true
    thumbImg.src = ''
  } else {
    thumbImg.src = asset.thumbnailUrl
    thumbWrap.hidden = false
  }

  // Show/hide "Generate Thumbnail" button
  const genBtn = document.querySelector(`.gen-thumb-btn[data-mode="${category}"]`)
  if (genBtn) {
    // Show if there's a full image but no thumbnail
    genBtn.hidden = !asset?.imageUrl || !!asset?.thumbnailUrl
  }
}

function clearExistingMeta() {
  for (const category of CATEGORIES) {
    setThumb(category, null)

    const categoryThemeInput = document.getElementById(`theme-${category}`)
    const categoryTagsInput = document.getElementById(`tags-${category}`)
    if (categoryThemeInput) {
      categoryThemeInput.value = ''
    }
    if (categoryTagsInput) {
      categoryTagsInput.value = ''
    }

    const genBtn = document.querySelector(`.gen-thumb-btn[data-mode="${category}"]`)
    if (genBtn) {
      genBtn.hidden = true
    }
  }
}

function updateCategoryIndicator(category, hasImage) {
  const indicator = document.getElementById(`indicator-${category}`)
  if (!indicator) return
  if (hasImage) {
    indicator.innerHTML = '<span class="badge-live">\u25CF Live</span>'
  } else {
    indicator.innerHTML = '<span class="badge-empty">\u25CB Empty</span>'
  }
}

function clearIndicators() {
  for (const category of CATEGORIES) {
    const indicator = document.getElementById(`indicator-${category}`)
    if (indicator) indicator.innerHTML = ''
  }
}

function renderLoadedPuzzle(puzzle) {
  if (!puzzle) {
    clearExistingMeta()
    clearIndicators()
    return
  }

  for (const category of CATEGORIES) {
    const asset = puzzle.categories?.[category]
    setThumb(category, asset || null)
    updateCategoryIndicator(category, !!asset?.imageUrl)

    const categoryThemeInput = document.getElementById(`theme-${category}`)
    const categoryTagsInput = document.getElementById(`tags-${category}`)
    if (categoryThemeInput) {
      categoryThemeInput.value = asset?.theme || ''
    }
    if (categoryTagsInput) {
      categoryTagsInput.value = Array.isArray(asset?.tags) ? asset.tags.join(', ') : ''
    }
  }
  clearDirtyState()
}

function initDropZones() {
  for (const category of CATEGORIES) {
    const input = fileInputs[category]
    const zone = document.getElementById(`drop-${category}`)
    const nameEl = zone?.querySelector('.drop-name')
    if (!input || !zone || !nameEl) {
      continue
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      const card = zone.closest('.category-card')
      if (file) {
        nameEl.textContent = file.name
        zone.classList.add('has-file')
        card?.classList.add('has-replacement')
      } else {
        nameEl.textContent = ''
        zone.classList.remove('has-file')
        card?.classList.remove('has-replacement')
      }
    })

    zone.addEventListener('dragover', (event) => {
      event.preventDefault()
      zone.style.borderColor = 'var(--accent)'
    })
    zone.addEventListener('dragleave', () => {
      zone.style.borderColor = ''
    })
    zone.addEventListener('drop', () => {
      zone.style.borderColor = ''
    })
  }
}

// ─── Batch Status ───

// ─── Batch queue console ────────────────────────────────
const BATCH_CONSOLE_MAX = 200
const batchConsoleLines = []

function logBatch(message, level = 'info') {
  if (!message) return
  batchConsoleLines.push({ time: new Date(), message, level })
  if (batchConsoleLines.length > BATCH_CONSOLE_MAX) {
    batchConsoleLines.splice(0, batchConsoleLines.length - BATCH_CONSOLE_MAX)
  }
  renderBatchConsole()
}

function renderBatchConsole() {
  if (!batchConsoleLogEl) return
  // Newest on top so recent events are immediately visible.
  const html = batchConsoleLines
    .slice()
    .reverse()
    .map((line) => {
      const t = line.time.toLocaleTimeString(undefined, { hour12: false })
      return `<li class="batch-console-line" data-level="${line.level}">
        <span class="batch-console-time">${t}</span>
        <span class="batch-console-msg">${escapeHtml(line.message)}</span>
      </li>`
    })
    .join('')
  batchConsoleLogEl.innerHTML = html
}

if (batchConsoleClearBtn) {
  batchConsoleClearBtn.addEventListener('click', () => {
    batchConsoleLines.length = 0
    renderBatchConsole()
  })
}

function summarizeBatchResponse(method, path, payload, status) {
  if (path.endsWith('/status')) return null // too noisy; transitions are logged on diff

  const action = path.split('/').slice(-1)[0]
  const ok = status >= 200 && status < 300
  const arrow = ok ? '→' : '✗'

  if (action === 'poll') {
    const state = payload?.state || 'idle'
    const target = payload?.targetDate || ''
    return `${arrow} poll${target ? ' ' + target : ''} (${state})${payload?.message ? ' — ' + payload.message : ''}`
  }
  if (action === 'generate-images' || action === 'single') {
    if (payload?.submitted) {
      return `${arrow} submitted batch for ${payload.targetDate}${payload.batchName ? ' (' + payload.batchName + ')' : ''}`
    }
    return `${arrow} submit refused: ${payload?.message || payload?.error || 'unknown'}`
  }
  if (action === 'cancel') {
    return `${arrow} ${payload?.message || payload?.error || 'cancel request'}`
  }
  return null
}

// ─── Batch queue status panel ───────────────────────────
let lastBatchJobs = null // snapshot for transition detection

function formatRelativeAge(iso) {
  if (!iso) return '—'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return '—'
  const delta = Math.max(0, Date.now() - then)
  const mins = Math.round(delta / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

function headJobFromLegacyStatus(status) {
  return {
    targetDate: status.targetDate,
    phase: status.phase,
    submittedAt: status.submittedAt,
    processedCategories: status.processedCategories || [],
    remainingCategories: status.remainingCategories || [],
    themes: status.themes || {},
  }
}

function resolveJobCategories(job) {
  const processed = Array.isArray(job.processedCategories) ? job.processedCategories : []
  const remaining = Array.isArray(job.remainingCategories) ? job.remainingCategories : []
  const merged = [...processed]
  for (const c of remaining) if (!merged.includes(c)) merged.push(c)
  return merged.length ? merged : [...CATEGORIES]
}

function renderJobCard(job, isHead) {
  const cats = resolveJobCategories(job)
  const processed = job.processedCategories || []
  const total = cats.length
  const doneCount = processed.filter((c) => cats.includes(c)).length
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0
  const chips = cats
    .map((cat) => {
      const isDone = processed.includes(cat)
      return `<span class="batch-chip" data-status="${isDone ? 'done' : 'pending'}">${escapeHtml(cat)}</span>`
    })
    .join('')
  const age = formatRelativeAge(job.submittedAt)
  const themeSummary = (() => {
    const themes = job.themes || {}
    const vals = Object.values(themes).filter(Boolean)
    if (vals.length === 0) return ''
    const first = vals[0]
    return vals.length === 1 ? first : `${first} +${vals.length - 1}`
  })()
  return `<article class="batch-job-card" data-date="${escapeHtml(job.targetDate || '')}" data-head="${isHead ? 'true' : 'false'}" data-phase="${escapeHtml(job.phase || 'idle')}">
    <header class="batch-job-card-header">
      <span class="batch-job-date">${escapeHtml(job.targetDate || '—')}</span>
      <span class="batch-job-phase" data-phase="${escapeHtml(job.phase || 'idle')}">${escapeHtml(job.phase || 'idle')}</span>
      <button type="button" class="batch-job-cancel" data-batch-name="${escapeHtml(job.batchName || '')}" data-date="${escapeHtml(job.targetDate || '')}" title="Cancel this job" aria-label="Cancel">×</button>
    </header>
    <div class="batch-job-meta">
      <span class="batch-job-age">${age}</span>
      ${isHead ? '<span class="batch-job-active-tag">active</span>' : ''}
      ${themeSummary ? `<span class="batch-job-theme" title="${escapeHtml(Object.values(job.themes || {}).filter(Boolean).join(' · '))}">${escapeHtml(themeSummary)}</span>` : ''}
    </div>
    <div class="batch-job-chips">${chips}</div>
    <div class="batch-job-progress-row">
      <div class="batch-job-progress"><div class="batch-job-progress-fill" style="width:${pct}%"></div></div>
      <span class="batch-job-count">${doneCount}/${total}</span>
    </div>
  </article>`
}

function diffBatchJobs(prev, next) {
  if (!prev) return // first snapshot — nothing to compare
  const prevByDate = new Map(prev.map((j) => [j.targetDate, j]))
  const nextByDate = new Map(next.map((j) => [j.targetDate, j]))
  for (const p of prev) {
    if (!nextByDate.has(p.targetDate)) {
      logBatch(`${p.targetDate}: removed from queue`, 'success')
    }
  }
  for (const n of next) {
    const before = prevByDate.get(n.targetDate)
    if (!before) {
      logBatch(`${n.targetDate}: appeared in queue (${n.phase || 'idle'})`, 'info')
      continue
    }
    if ((before.phase || '') !== (n.phase || '')) {
      logBatch(`${n.targetDate}: ${before.phase || 'idle'} → ${n.phase || 'idle'}`, 'info')
    }
    const prevDone = new Set(before.processedCategories || [])
    for (const cat of n.processedCategories || []) {
      if (!prevDone.has(cat)) logBatch(`${n.targetDate}: processed ${cat}`, 'info')
    }
  }
}

function renderBatchStatus(status) {
  if (!batchStatusPanel) return
  batchStatusPanel.hidden = false

  let jobs = Array.isArray(status?.queue) ? status.queue : []
  // Back-compat: if the server only returned head-level fields, lift them.
  if (jobs.length === 0 && status?.active && status.targetDate) {
    jobs = [headJobFromLegacyStatus(status)]
  }

  diffBatchJobs(lastBatchJobs, jobs)
  lastBatchJobs = jobs.map((j) => ({
    targetDate: j.targetDate,
    phase: j.phase,
    processedCategories: [...(j.processedCategories || [])],
  }))

  if (batchQueueCountEl) {
    batchQueueCountEl.textContent = String(jobs.length)
    batchQueueCountEl.dataset.empty = jobs.length === 0 ? 'true' : 'false'
  }
  if (batchLastRefreshEl) {
    batchLastRefreshEl.textContent = new Date().toLocaleTimeString(undefined, { hour12: false })
  }
  if (batchSummaryEl) {
    if (jobs.length === 0) {
      batchSummaryEl.textContent = 'No jobs in flight'
    } else {
      const running = jobs.filter((j) => j.phase === 'fetched').length
      const queued = jobs.length - running
      const oldest = jobs[0]?.submittedAt ? formatRelativeAge(jobs[0].submittedAt) : null
      const parts = []
      if (queued > 0) parts.push(`${queued} queued`)
      if (running > 0) parts.push(`${running} processing`)
      if (oldest) parts.push(`oldest ${oldest}`)
      batchSummaryEl.textContent = parts.join(' · ')
    }
  }

  // Active-batch ribbon above the centre grid mirrors the head of queue
  // so you can see progress even when the drawer is collapsed.
  if (ribbonEl) {
    const head = jobs[0]
    if (!head) {
      ribbonEl.hidden = true
    } else {
      const cats = resolveJobCategories(head)
      const processed = head.processedCategories || []
      const total = cats.length
      const done = processed.filter((c) => cats.includes(c)).length
      const pct = total > 0 ? Math.round((done / total) * 100) : 0
      ribbonEl.hidden = false
      if (ribbonDateEl) ribbonDateEl.textContent = head.targetDate || '—'
      if (ribbonPhaseEl) {
        ribbonPhaseEl.textContent = head.phase || 'idle'
        ribbonPhaseEl.dataset.phase = head.phase || 'idle'
      }
      if (ribbonProgressFillEl) ribbonProgressFillEl.style.width = `${pct}%`
      if (ribbonCountEl) ribbonCountEl.textContent = `${done}/${total}`
    }
  }

  if (jobs.length === 0) {
    if (batchJobGridEl) batchJobGridEl.innerHTML = ''
    if (batchEmptyEl) batchEmptyEl.hidden = false
    return
  }
  if (batchEmptyEl) batchEmptyEl.hidden = true
  if (batchJobGridEl) {
    batchJobGridEl.innerHTML = jobs.map((job, i) => renderJobCard(job, i === 0)).join('')
  }
}

async function cancelQueuedBatch(batchName, targetDate) {
  if (!batchName && !targetDate) return
  const label = targetDate || batchName
  if (!confirm(`Cancel queued batch for ${label}?`)) return
  try {
    const body = {}
    if (batchName) body.batchName = batchName
    if (targetDate) body.targetDate = targetDate
    const { response, payload } = await adminFetch('/api/admin/generate-images/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) {
      setStatus(payload.message || `Cancelled ${label}.`, 'note')
      await refreshBatchStatus()
    } else {
      setStatus(payload.error || payload.message || 'Cancel failed.', 'error')
    }
  } catch (err) {
    setStatus(err?.message || 'Cancel failed.', 'error')
  }
}

if (batchJobGridEl) {
  batchJobGridEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.batch-job-cancel')
    if (!btn) return
    cancelQueuedBatch(btn.dataset.batchName, btn.dataset.date)
  })
}

async function refreshBatchStatus() {
  if (!isAuthenticated) return

  try {
    const { response, payload } = await adminFetch('/api/admin/generate-images/status')
    if (response.ok) {
      renderBatchStatus(payload)
    }
  } catch {
    // Non-fatal
  }
}

// Poll the status endpoint every 20s while authenticated so cron-driven
// transitions (phase changes, category completions, queue removals) show
// up in the activity log without needing a manual refresh.
let batchAutoRefreshId = null
function startBatchAutoRefresh() {
  if (batchAutoRefreshId || !isAuthenticated) return
  batchAutoRefreshId = setInterval(() => {
    if (isAuthenticated) refreshBatchStatus()
  }, 20_000)
}
function stopBatchAutoRefresh() {
  if (batchAutoRefreshId) {
    clearInterval(batchAutoRefreshId)
    batchAutoRefreshId = null
  }
}

// ─── Date Loading ───

async function loadDateDetails() {
  const date = dateInput.value.trim()
  if (!date) {
    setStatus('Choose a date first.', 'error')
    return
  }

  setStatus(`Loading ${date}...`, 'working')
  try {
    // Bypass CF edge cache (s-maxage=300 on /api/puzzles/:date) so admin
    // sees regenerated images immediately. Unique query → edge miss;
    // no-store → browser won't serve its own cached copy either.
    const response = await fetch(
      apiUrl(`/api/puzzles/${encodeURIComponent(date)}?_=${Date.now()}`),
      { cache: 'no-store' },
    )
    const payload = await readJsonResponse(response)
    if (response.status === 404) {
      isExistingDate = false
      clearExistingMeta()
      clearIndicators()
      applyDateMode()
      setRecordBadge('New', 'new')
      clearDirtyState()
      setStatus(`${date} has no puzzle yet - fill in details and upload images to create it.`, 'note')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Could not load date.', 'error')
      return
    }

    isExistingDate = true
    renderLoadedPuzzle(payload)
    applyDateMode()
    setRecordBadge('Exists', 'existing')
    setStatus(`Loaded ${date}. Upload replacements or leave slots empty to keep current images.`, 'ok')
  } catch {
    setStatus('Network error while loading date.', 'error')
  }
}

async function jumpToNextEmpty() {
  if (!requireAuth()) {
    return
  }

  const from = dateInput.value.trim() || tomorrow
  setStatus(`Scanning from ${from}...`, 'working')

  try {
    const { response, payload } = await adminFetch(
      `/api/admin/puzzles/next-empty?from=${encodeURIComponent(from)}`,
    )
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Could not find next empty date.', 'error')
      return
    }

    dateInput.value = payload.nextEmptyDate || from
    await loadDateDetails()
  } catch {
    setStatus('Network error while scanning dates.', 'error')
  }
}

function shiftDate(n) {
  dateInput.value = addDays(dateInput.value.trim() || tomorrow, n)
  loadDateDetails()
}

// ─── Clipboard ───

async function copyText(text, label) {
  if (!text) {
    setStatus(`Nothing to copy for ${label}.`, 'error')
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    setStatus(`${label} copied.`, 'ok')
  } catch {
    setStatus(`Clipboard copy failed for ${label}.`, 'error')
  }
}

// ─── Image Processing ───

async function convertToJpeg(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Canvas unavailable')
    }
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)

    const croppedCanvas = cropBorders(canvas)
    const blob = await new Promise((resolve, reject) => {
      croppedCanvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Conversion failed'))), 'image/jpeg', 0.8)
    })

    const safeName = (file.name || 'image').replace(/[.][^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
    return new File([blob], `${safeName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function cropBorders(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return canvas
  }

  const { width, height } = canvas
  const imgData = ctx.getImageData(0, 0, width, height)
  const data = imgData.data

  const getPixel = (x, y) => {
    const idx = (y * width + x) * 4
    return [data[idx], data[idx + 1], data[idx + 2]]
  }

  const isUniformRow = (y, threshold = 18) => {
    const first = getPixel(0, y)
    for (let x = 1; x < width; x += 1) {
      const pixel = getPixel(x, y)
      if (
        Math.abs(pixel[0] - first[0]) > threshold ||
        Math.abs(pixel[1] - first[1]) > threshold ||
        Math.abs(pixel[2] - first[2]) > threshold
      ) {
        return false
      }
    }
    return true
  }

  const isUniformCol = (x, threshold = 18) => {
    const first = getPixel(x, 0)
    for (let y = 1; y < height; y += 1) {
      const pixel = getPixel(x, y)
      if (
        Math.abs(pixel[0] - first[0]) > threshold ||
        Math.abs(pixel[1] - first[1]) > threshold ||
        Math.abs(pixel[2] - first[2]) > threshold
      ) {
        return false
      }
    }
    return true
  }

  let top = 0
  while (top < height * 0.25 && isUniformRow(top)) {
    top += 1
  }

  let bottom = height - 1
  while (bottom > height * 0.75 && isUniformRow(bottom)) {
    bottom -= 1
  }

  let left = 0
  while (left < width * 0.25 && isUniformCol(left)) {
    left += 1
  }

  let right = width - 1
  while (right > width * 0.75 && isUniformCol(right)) {
    right -= 1
  }

  if (top === 0 && bottom === height - 1 && left === 0 && right === width - 1) {
    return canvas
  }

  const croppedWidth = right - left + 1
  const croppedHeight = bottom - top + 1
  if (croppedWidth <= 32 || croppedHeight <= 32) {
    return canvas
  }

  const croppedCanvas = document.createElement('canvas')
  croppedCanvas.width = croppedWidth
  croppedCanvas.height = croppedHeight
  const croppedCtx = croppedCanvas.getContext('2d')
  croppedCtx.drawImage(canvas, left, top, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight)
  return croppedCanvas
}

// ─── Prompts ───

function renderPromptPack(pack) {
  if (!pack) {
    clearPrompts()
    return
  }

  for (const category of CATEGORIES) {
    const details = pack.categories?.[category]
    if (promptFields[category]) {
      promptFields[category].value = details?.prompt || ''
    }

    const categoryThemeInput = document.getElementById(`theme-${category}`)
    const categoryTagsInput = document.getElementById(`tags-${category}`)
    if (categoryThemeInput) {
      categoryThemeInput.value = details?.theme || ''
    }
    if (categoryTagsInput) {
      categoryTagsInput.value = Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''
    }
  }
}

function getSelectedRewriteModel() {
  return typeof rewriteModelSelect?.value === 'string' ? rewriteModelSelect.value.trim() : ''
}

function populateRewriteModels(models, defaultModel) {
  if (!rewriteModelSelect) {
    return
  }

  const previous = getSelectedRewriteModel()
  const fallback = (typeof defaultModel === 'string' && defaultModel.trim()) || 'openrouter/free'
  const options = Array.isArray(models) ? models : []

  rewriteModelSelect.innerHTML = ''

  const workerDefault = document.createElement('option')
  workerDefault.value = ''
  workerDefault.textContent = `Worker default (${fallback})`
  rewriteModelSelect.append(workerDefault)

  for (const model of options) {
    const id = typeof model?.id === 'string' ? model.id.trim() : ''
    if (!id) {
      continue
    }

    const contextLength = Number.isFinite(model?.contextLength) ? Number(model.contextLength) : null
    const contextLabel = contextLength && contextLength > 0 ? ` \u2022 ${contextLength.toLocaleString()} ctx` : ''
    const option = document.createElement('option')
    option.value = id
    option.textContent = `${id}${contextLabel}`
    rewriteModelSelect.append(option)
  }

  const values = Array.from(rewriteModelSelect.options).map((opt) => opt.value)
  if (values.includes(previous)) {
    rewriteModelSelect.value = previous
    return
  }
  if (values.includes(fallback)) {
    rewriteModelSelect.value = fallback
    return
  }
  rewriteModelSelect.value = ''
}

async function refreshFreeModels({ quiet = false } = {}) {
  if (!requireAuth()) {
    return
  }

  refreshModelsBtn.disabled = true
  if (!quiet) {
    setStatus('Loading free OpenRouter models...', 'working')
  }

  try {
    const { response, payload } = await adminFetch('/api/admin/openrouter/free-models')
    if (response.status === 401) {
      if (!quiet) {
        setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      }
      return
    }
    if (!response.ok) {
      if (!quiet) {
        setStatus(payload.error || 'Could not load free models.', 'error')
      }
      return
    }

    populateRewriteModels(payload.models, payload.defaultModel)
    if (!quiet) {
      const count = Array.isArray(payload.models) ? payload.models.length : 0
      setStatus(`Loaded ${count} free models.`, 'ok')
    }
  } catch {
    if (!quiet) {
      setStatus('Network error while loading free models.', 'error')
    }
  } finally {
    refreshModelsBtn.disabled = false
  }
}

async function rewritePrompt(category, triggerBtn) {
  if (!requireAuth()) {
    return
  }

  const field = promptFields[category]
  if (!field) {
    setStatus('Prompt field not found.', 'error')
    return
  }

  const rawPrompt = field.value.trim()
  if (!rawPrompt) {
    setStatus(`No ${category} prompt to rewrite.`, 'error')
    return
  }

  const themeInput = document.getElementById(`theme-${category}`)
  const tagsInput = document.getElementById(`tags-${category}`)
  const theme = themeInput?.value.trim() || ''
  const tags = tagsInput?.value.trim() || ''
  const model = getSelectedRewriteModel()
  const modelLabel = model || 'worker default'

  triggerBtn.disabled = true
  setStatus(`Rewriting ${category} prompt using ${modelLabel}...`, 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/prompts/rewrite-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category,
        prompt: rawPrompt,
        theme,
        tags,
        ...(model ? { model } : {}),
      }),
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || `Failed to rewrite ${category} prompt.`, 'error')
      return
    }

    const nextPrompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!nextPrompt) {
      setStatus(`No rewritten ${category} prompt returned.`, 'error')
      return
    }

    field.value = nextPrompt
    if (promptPack?.categories?.[category]) {
      promptPack.categories[category].prompt = nextPrompt
    }

    const usedModel =
      typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : modelLabel
    setStatus(`Rewrote ${category} prompt using ${usedModel}.`, 'ok')
  } catch {
    setStatus(`Network error while rewriting ${category} prompt.`, 'error')
  } finally {
    triggerBtn.disabled = false
  }
}

async function regenerateCategoryPrompt(category, triggerBtn) {
  if (!requireAuth()) {
    return
  }

  triggerBtn.disabled = true
  setStatus(`Regenerating ${category} descriptors...`, 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/prompts/generate-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category }),
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || `Failed to regenerate ${category} prompt.`, 'error')
      return
    }

    const promptField = promptFields[category]
    const themeInput = document.getElementById(`theme-${category}`)
    const tagsInput = document.getElementById(`tags-${category}`)

    if (promptField) {
      promptField.value = payload.prompt || ''
    }
    if (themeInput) {
      themeInput.value = payload.theme || ''
    }
    if (tagsInput) {
      tagsInput.value = Array.isArray(payload.keywords) ? payload.keywords.join(', ') : ''
    }

    if (promptPack?.categories) {
      promptPack.categories[category] = {
        prompt: payload.prompt,
        theme: payload.theme,
        keywords: payload.keywords,
      }
    }

    setStatus(`Regenerated ${category} prompt.`, 'ok')
  } catch {
    setStatus(`Network error while regenerating ${category} prompt.`, 'error')
  } finally {
    triggerBtn.disabled = false
  }
}

// ─── Thumbnails ───

const THUMBNAIL_WIDTH = 400

async function generateThumbnailFromUrl(imageUrl) {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = imageUrl
  await img.decode()

  const scale = THUMBNAIL_WIDTH / img.naturalWidth
  const thumbHeight = Math.round(img.naturalHeight * scale)
  const width = Math.min(THUMBNAIL_WIDTH, img.naturalWidth)
  const height = width === img.naturalWidth ? img.naturalHeight : thumbHeight

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, width, height)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Thumbnail generation failed'))),
      'image/jpeg',
      0.8,
    )
  })
}

document.querySelectorAll('.gen-thumb-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (!requireAuth()) return

    const category = btn.getAttribute('data-mode')
    if (!CATEGORIES.includes(category)) return

    const date = dateInput.value.trim()
    if (!date) {
      setStatus('Select a date first.', 'error')
      return
    }

    const thumbEl = thumbEls[category]
    const fullImg = thumbEl?.querySelector('img')
    if (!fullImg?.src) {
      setStatus(`No ${category} image to generate thumbnail from.`, 'error')
      return
    }

    btn.disabled = true
    setStatus(`Generating ${category} thumbnail...`, 'working')

    try {
      const blob = await generateThumbnailFromUrl(fullImg.src)
      const formData = new FormData()
      formData.append('date', date)
      formData.append('category', category)
      formData.append('thumbnail', blob, `${category}_thumb.jpg`)

      const { response, payload } = await adminFetch('/api/admin/puzzles/thumbnail', {
        method: 'POST',
        body: formData,
      })

      if (!response.ok) {
        setStatus(payload.error || 'Thumbnail upload failed.', 'error')
        return
      }

      // Update thumbnail preview
      const thumbnailWrap = thumbnailEls[category]
      if (thumbnailWrap) {
        const thumbImg = thumbnailWrap.querySelector('img')
        thumbImg.src = payload.thumbnailUrl + '?t=' + Date.now()
        thumbnailWrap.hidden = false
      }
      btn.hidden = true

      setStatus(`${category} thumbnail generated and saved.`, 'ok')
    } catch {
      setStatus(`Failed to generate ${category} thumbnail.`, 'error')
    } finally {
      btn.disabled = false
    }
  })
})

// ─── Auth ───

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true
  try {
    await adminFetch('/api/admin/session', { method: 'DELETE' })
    setAuthState(false)
    setStatus('Signed out.', 'note')
    batchStatusPanel.hidden = true
  } catch {
    setStatus('Network error while signing out.', 'error')
  } finally {
    logoutBtn.disabled = false
  }
})

// ─── Date Navigation ───

prevDayBtn.addEventListener('click', () => shiftDate(-1))
nextDayBtn.addEventListener('click', () => shiftDate(1))
loadDateBtn.addEventListener('click', loadDateDetails)
nextEmptyBtn.addEventListener('click', jumpToNextEmpty)
dateInput.addEventListener('change', loadDateDetails)
refreshModelsBtn.addEventListener('click', () => {
  refreshFreeModels()
})

// ─── Per-Category Prompt Actions ───

document.querySelectorAll('.regen-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const category = (btn.getAttribute('data-mode') || '').trim()
    if (!CATEGORIES.includes(category)) {
      setStatus('Invalid category.', 'error')
      return
    }
    await regenerateCategoryPrompt(category, btn)
  })
})

document.querySelectorAll('.rewrite-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const category = (btn.getAttribute('data-mode') || '').trim()
    if (!CATEGORIES.includes(category)) {
      setStatus('Invalid rewrite category.', 'error')
      return
    }
    await rewritePrompt(category, btn)
  })
})

document.querySelectorAll('.submit-single-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const category = (btn.getAttribute('data-mode') || '').trim()
    if (!CATEGORIES.includes(category)) {
      setStatus('Invalid category.', 'error')
      return
    }
    if (!requireAuth()) return

    const field = promptFields[category]
    const prompt = field?.value?.trim()
    if (!prompt) {
      setStatus(`Generate a ${category} prompt first.`, 'error')
      return
    }

    const selectedDate = dateInput.value.trim() || undefined
    const themeInput = document.getElementById(`theme-${category}`)
    const tagsInput = document.getElementById(`tags-${category}`)
    const theme = themeInput?.value?.trim() || category
    const keywords = (tagsInput?.value?.trim() || '').split(',').map((t) => t.trim()).filter(Boolean)

    // Show full prompt for verification before submitting
    const confirmMsg = `Submit ${category.toUpperCase()} batch for ${selectedDate || 'next empty date'}?\n\n--- FULL PROMPT ---\n${prompt}\n\n--- THEME ---\n${theme}\n\n--- TAGS ---\n${keywords.join(', ') || '(none)'}`
    if (!confirm(confirmMsg)) {
      setStatus('Single batch submit cancelled.', 'error')
      return
    }

    btn.disabled = true
    setStatus(`Submitting ${category} batch job...`, 'working')
    try {
      const submitSingle = async (force = false) => {
        return adminFetch('/api/admin/generate-images/single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category, prompt, theme, keywords, date: selectedDate, force }),
        })
      }

      let { response, payload } = await submitSingle()

      if (response.status === 401) {
        setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
        return
      }

      if (!response.ok && payload.existingDate) {
        if (!confirm(`Puzzle images already exist for ${payload.targetDate}. Overwrite ${category}?`)) {
          setStatus('Single batch submit cancelled.', 'error')
          return
        }
        ;({ response, payload } = await submitSingle(true))
      }

      if (!response.ok) {
        setStatus(payload.error || `${category} batch submit failed.`, 'error')
        return
      }

      setStatus(payload.message || `${category} batch job submitted. Use Poll to check progress.`, 'ok')
      refreshBatchStatus()
    } catch {
      setStatus(`Network error during ${category} batch submit.`, 'error')
    } finally {
      btn.disabled = false
    }
  })
})

// ─── Manual Prompt Generation ───

generateBtn.addEventListener('click', async () => {
  if (!requireAuth()) {
    return
  }

  generateBtn.disabled = true
  copyPackBtn.disabled = true
  setStatus('Generating prompts...', 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/prompts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getSelectedRewriteModel(),
      }),
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      promptPack = null
      clearPrompts()
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Prompt generation failed.', 'error')
      promptPack = null
      clearPrompts()
      return
    }

    const packs = Array.isArray(payload.prompts) ? payload.prompts : []
    const first = packs[0] || null
    if (!first) {
      setStatus('No prompts returned.', 'error')
      promptPack = null
      clearPrompts()
      return
    }

    promptPack = first
    renderPromptPack(first)
    copyPackBtn.disabled = false
    refreshFreeModels({ quiet: true })
    setStatus('Prompts ready - review and edit them in each category card, then submit.', 'ok')
  } catch {
    setStatus('Network error while generating prompts.', 'error')
    promptPack = null
    clearPrompts()
  } finally {
    generateBtn.disabled = false
  }
})

// ─── Manual Batch Submit ───

autoGenerateBtn.addEventListener('click', async () => {
  if (!requireAuth()) {
    return
  }

  const selectedDate = dateInput.value.trim() || undefined

  // Collect prompts from the UI if they exist, to send to server
  let clientPrompts = null
  const hasPrompts = CATEGORIES.every((cat) => promptFields[cat]?.value?.trim())
  if (hasPrompts) {
    clientPrompts = {}
    let confirmLines = []
    for (const cat of CATEGORIES) {
      const themeInput = document.getElementById(`theme-${cat}`)
      const tagsInput = document.getElementById(`tags-${cat}`)
      const prompt = promptFields[cat].value.trim()
      const theme = themeInput?.value?.trim() || cat
      const keywords = (tagsInput?.value?.trim() || '').split(',').map((t) => t.trim()).filter(Boolean)
      clientPrompts[cat] = { prompt, theme, keywords }
      confirmLines.push(`--- ${cat.toUpperCase()} ---\n${prompt}\n`)
    }

    const confirmMsg = `Submit ALL categories batch for ${selectedDate || 'next empty date'}?\n\n${confirmLines.join('\n')}`
    if (!confirm(confirmMsg)) {
      setStatus('Batch submit cancelled.', 'error')
      return
    }
  } else {
    if (!confirm(`Submit batch for ${selectedDate || 'next empty date'}? No prompts are loaded \u2014 new prompts will be generated server-side.`)) {
      setStatus('Batch submit cancelled.', 'error')
      return
    }
  }

  autoGenerateBtn.disabled = true
  setStatus('Submitting batch image generation job...', 'working')
  try {
    const submitBatch = async (force = false) => {
      // Trigger page is date-agnostic: let the worker pick the next
      // unscheduled date that isn't already queued. The per-tile
      // Submit buttons in Review keep the date-specific flow for
      // regenerating individual categories on a chosen day.
      const body = {}
      if (force) body.force = true
      if (clientPrompts) body.prompts = clientPrompts
      return adminFetch('/api/admin/generate-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    let { response, payload } = await submitBatch()

    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }

    // If images already exist, ask for confirmation before overwriting
    if (!response.ok && payload.existingDate) {
      if (!confirm(`Puzzle images already exist for ${payload.targetDate}. Overwrite them?`)) {
        setStatus('Batch submit cancelled.', 'error')
        return
      }
      ;({ response, payload } = await submitBatch(true))
      if (response.status === 401) {
        setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
        return
      }
    }

    if (!response.ok) {
      setStatus(payload.error || 'Batch submit failed.', 'error')
      return
    }

    setStatus(payload.message || 'Batch job submitted. Use Poll to check progress.', 'ok')
    refreshBatchStatus()
    if (payload.submitted || payload.ok) switchAdminPage('queue')
  } catch {
    setStatus('Network error during batch submit.', 'error')
  } finally {
    autoGenerateBtn.disabled = false
  }
})

// ─── Manual Batch Poll ───

batchPollBtn.addEventListener('click', async () => {
  if (!requireAuth()) {
    return
  }

  batchPollBtn.disabled = true
  setStatus('Polling batch job status...', 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/generate-images/poll', {
      method: 'POST',
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Batch poll failed.', 'error')
      return
    }

    setStatus(payload.message || 'Batch poll completed.', 'ok')
    if (payload.savedDate) dateInput.value = payload.savedDate
    await loadDateDetails()
    refreshBatchStatus()
  } catch {
    setStatus('Network error during batch poll.', 'error')
  } finally {
    batchPollBtn.disabled = false
  }
})

// ─── Cron Triggers ───

cronSubmitBtn.addEventListener('click', async () => {
  if (!requireAuth()) return

  if (!confirm('Trigger daily cron job? This will auto-generate prompts and submit a batch for the next empty date.')) {
    return
  }

  cronSubmitBtn.disabled = true
  setStatus('Running daily cron: submitting batch...', 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/generate-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Cron submit failed.', 'error')
      return
    }
    setStatus(payload.message || 'Cron submit completed.', 'ok')
    refreshBatchStatus()
    // After a successful submit, jump to the Queue page so the user
    // immediately sees the job they just kicked off.
    if (payload.submitted) switchAdminPage('queue')
  } catch {
    setStatus('Network error during cron submit.', 'error')
  } finally {
    cronSubmitBtn.disabled = false
  }
})

cronPollBtn.addEventListener('click', async () => {
  if (!requireAuth()) return

  cronPollBtn.disabled = true
  setStatus('Running hourly cron: polling batch...', 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/generate-images/poll', {
      method: 'POST',
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Cron poll failed.', 'error')
      return
    }

    setStatus(payload.message || 'Cron poll completed.', 'ok')
    if (payload.savedDate) dateInput.value = payload.savedDate
    await loadDateDetails()
    refreshBatchStatus()
  } catch {
    setStatus('Network error during cron poll.', 'error')
  } finally {
    cronPollBtn.disabled = false
  }
})

// ─── Pipeline pause toggle ───
// Writes a flag into app_settings that handleBatchSubmit + handleBatchPoll
// check on every tick (cron + manual). Use when the pipeline is misbehaving
// so cron doesn't keep piling on batches while you investigate.

function applyPauseButtonState(paused) {
  if (!pipelinePauseBtn) return
  pipelinePauseBtn.dataset.paused = paused ? 'true' : 'false'
  const label = pipelinePauseBtn.querySelector('.pipeline-pause-label')
  if (label) label.textContent = paused ? 'Resume pipeline' : 'Pause pipeline'
  pipelinePauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false')
}

async function refreshPauseState() {
  if (!pipelinePauseBtn) return
  try {
    const { response, payload } = await adminFetch('/api/admin/pipeline/paused')
    if (response.ok) applyPauseButtonState(Boolean(payload.paused))
  } catch {
    // Non-fatal — keep whatever local state we already have.
  }
}

if (pipelinePauseBtn) {
  pipelinePauseBtn.addEventListener('click', async () => {
    if (!requireAuth()) return
    const currentlyPaused = pipelinePauseBtn.dataset.paused === 'true'
    const nextPaused = !currentlyPaused
    pipelinePauseBtn.disabled = true
    setStatus(nextPaused ? 'Pausing pipeline...' : 'Resuming pipeline...', 'working')
    try {
      const { response, payload } = await adminFetch('/api/admin/pipeline/paused', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: nextPaused }),
      })
      if (response.status === 401) {
        setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
        return
      }
      if (!response.ok) {
        setStatus(payload.error || 'Failed to update pipeline state.', 'error')
        return
      }
      applyPauseButtonState(Boolean(payload.paused))
      setStatus(payload.paused ? 'Pipeline paused. Cron will skip until resumed.' : 'Pipeline resumed.', 'ok')
    } catch {
      setStatus('Network error updating pipeline state.', 'error')
    } finally {
      pipelinePauseBtn.disabled = false
    }
  })
}

// ─── Copy ───

copyPackBtn.addEventListener('click', async () => {
  if (!promptPack) {
    setStatus('Generate prompts first.', 'error')
    return
  }

  const lines = ['DAILY PROMPTS', '']
  for (const category of CATEGORIES) {
    const details = promptPack.categories?.[category]
    const label = category.toUpperCase()
    lines.push(`--- ${label} ---`)
    lines.push(`Theme: ${details?.theme || ''}`)
    lines.push(`Tags: ${Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''}`)
    lines.push(`Prompt: ${details?.prompt || ''}`)
    lines.push('')
  }

  await copyText(lines.join('\n'), 'All prompts')
})

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.getAttribute('data-target')
    const field = target ? document.getElementById(target) : null
    if (!field) {
      return
    }

    const label = btn.closest('.category-card')?.querySelector('.mode-tag')?.textContent || 'Prompt'
    await copyText(field.value, label)
  })
})

// ─── Form Submit (Save Puzzle) ───

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!requireAuth()) {
    return
  }

  submitBtn.disabled = true
  setStatus('Saving...', 'working')
  try {
    const formData = new FormData(form)
    for (const category of CATEGORIES) {
      const file = formData.get(category)
      if (file instanceof File && file.size > 0) {
        const jpeg = await convertToJpeg(file)
        formData.set(category, jpeg, jpeg.name)
      } else {
        formData.delete(category)
      }
    }

    const { response, payload } = await adminFetch('/api/admin/puzzles', {
      method: 'POST',
      body: formData,
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Save failed.', 'error')
      return
    }

    isExistingDate = true
    applyDateMode()
    setRecordBadge('Exists', 'existing')
    renderLoadedPuzzle(payload.puzzle || null)
    clearDirtyState()

    // Track which categories had new uploads for thumbnail generation
    const uploadedCategories = []
    for (const category of CATEGORIES) {
      const input = fileInputs[category]
      const hadFile = input?.files?.[0]?.size > 0
      if (hadFile) {
        uploadedCategories.push(category)
      }

      const zone = document.getElementById(`drop-${category}`)
      const nameEl = zone?.querySelector('.drop-name')
      if (input) {
        input.value = ''
      }
      if (zone) {
        zone.classList.remove('has-file')
      }
      if (nameEl) {
        nameEl.textContent = ''
      }
      zone?.closest('.category-card')?.classList.remove('has-replacement')
    }

    setStatus(payload.message || 'Saved.', 'ok')

    // Auto-generate thumbnails for newly uploaded images
    if (uploadedCategories.length > 0) {
      const date = dateInput.value.trim()
      for (const category of uploadedCategories) {
        const asset = payload.puzzle?.categories?.[category]
        if (!asset?.imageUrl) continue

        setStatus(`Generating ${category} thumbnail...`, 'working')
        try {
          const blob = await generateThumbnailFromUrl(asset.imageUrl)
          const thumbForm = new FormData()
          thumbForm.append('date', date)
          thumbForm.append('category', category)
          thumbForm.append('thumbnail', blob, `${category}_thumb.jpg`)

          const thumbResult = await adminFetch('/api/admin/puzzles/thumbnail', {
            method: 'POST',
            body: thumbForm,
          })

          if (thumbResult.response.ok) {
            const thumbnailWrap = thumbnailEls[category]
            if (thumbnailWrap) {
              const thumbImg = thumbnailWrap.querySelector('img')
              thumbImg.src = thumbResult.payload.thumbnailUrl + '?t=' + Date.now()
              thumbnailWrap.hidden = false
            }
            const genBtn = document.querySelector(`.gen-thumb-btn[data-mode="${category}"]`)
            if (genBtn) genBtn.hidden = true
          }
        } catch {
          // Non-fatal — thumbnail can be generated manually later
        }
      }
      setStatus('Saved with thumbnails.', 'ok')
    }
  } catch {
    setStatus('Network error while saving.', 'error')
  } finally {
    submitBtn.disabled = false
  }
})

// ─── Contact Messages ───

const loadMessagesBtn = document.getElementById('load-messages-btn')
const messagesList = document.getElementById('messages-list')
const msgCountEl = document.getElementById('msg-count')

async function loadMessages() {
  if (!requireAuth()) return

  loadMessagesBtn.disabled = true
  setStatus('Loading messages...', 'working')

  try {
    const { response, payload } = await adminFetch('/api/admin/messages?limit=100')
    if (!response.ok) {
      setStatus(payload.error || 'Failed to load messages.', 'error')
      return
    }

    const messages = payload.messages || []
    msgCountEl.textContent = `${messages.length} of ${payload.total || 0}`

    if (messages.length === 0) {
      messagesList.innerHTML = '<div class="msg-empty">No messages yet.</div>'
      setStatus('No messages.', 'idle')
      return
    }

    messagesList.innerHTML = messages
      .map((msg) => {
        const date = new Date(msg.submitted_at + 'Z').toLocaleString()
        return `
          <div class="msg-card" data-id="${msg.id}">
            <div class="msg-card-header">
              <span class="msg-chevron">\u25B6</span>
              <span class="msg-sender">${escapeHtml(msg.name)}</span>
              <span class="msg-email">${escapeHtml(msg.email)}</span>
              <span class="msg-date">${date}</span>
            </div>
            <div class="msg-card-body">
              <div class="msg-text">${escapeHtml(msg.message)}</div>
              <div class="msg-meta">IP: ${escapeHtml(msg.ip || 'unknown')} &middot; ${date}</div>
              <div class="msg-card-actions">
                <a href="mailto:${escapeHtml(msg.email)}?subject=Re:%20Xefig%20Contact&body=${encodeURIComponent('Hi ' + msg.name + ',\n\n')}" class="btn-sm btn-outline">Reply</a>
                <button type="button" class="btn-sm btn-ghost msg-delete-btn" data-id="${msg.id}">Delete</button>
              </div>
            </div>
          </div>
        `
      })
      .join('')

    // Toggle expand on header click
    messagesList.querySelectorAll('.msg-card-header').forEach((header) => {
      header.addEventListener('click', () => {
        header.parentElement.classList.toggle('is-open')
      })
    })

    // Delete buttons
    messagesList.querySelectorAll('.msg-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id
        if (!confirm('Delete this message?')) return
        btn.disabled = true
        try {
          const { response: delRes } = await adminFetch(`/api/admin/messages/${id}`, { method: 'DELETE' })
          if (delRes.ok) {
            const card = btn.closest('.msg-card')
            card.remove()
            const remaining = messagesList.querySelectorAll('.msg-card').length
            msgCountEl.textContent = `${remaining}`
            if (remaining === 0) {
              messagesList.innerHTML = '<div class="msg-empty">No messages.</div>'
            }
          }
        } catch {
          // Non-fatal
        }
      })
    })

    setStatus(`Loaded ${messages.length} message${messages.length === 1 ? '' : 's'}.`, 'ok')
  } catch {
    setStatus('Network error loading messages.', 'error')
  } finally {
    loadMessagesBtn.disabled = false
  }
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str || ''
  return div.innerHTML
}

loadMessagesBtn.addEventListener('click', loadMessages)

// ─── Dirty State ───

function markDirty(card) {
  if (!card) return
  card.classList.add('is-dirty')
  isDirty = true
}

function clearDirtyState() {
  isDirty = false
  document.querySelectorAll('.category-card.is-dirty').forEach((c) => c.classList.remove('is-dirty'))
}

// Track changes to file inputs, text inputs, and textareas within category cards
document.querySelectorAll('.category-card').forEach((card) => {
  card.addEventListener('input', () => markDirty(card))
  card.addEventListener('change', () => markDirty(card))
})

window.addEventListener('beforeunload', (e) => {
  if (isDirty) {
    e.preventDefault()
  }
})

// ─── Lightbox ───

document.querySelectorAll('.existing-thumb').forEach((thumb) => {
  thumb.style.cursor = 'zoom-in'
  thumb.addEventListener('click', () => {
    const img = thumb.querySelector('img')
    if (!img?.src) return
    lightboxImg.src = img.src
    lightboxOverlay.hidden = false
  })
})

lightboxOverlay.addEventListener('click', () => {
  lightboxOverlay.hidden = true
  lightboxImg.src = ''
})

// ─── Status Overview ───

overviewBtn.addEventListener('click', async () => {
  if (!requireAuth()) return

  overviewList.innerHTML = '<div style="text-align:center;color:var(--text-3);padding:1rem">Loading...</div>'
  overviewOverlay.hidden = false

  const from = dateInput.value.trim() || tomorrow
  const days = 30
  const rows = []

  try {
    const response = await fetch(apiUrl(`/api/admin/puzzles/overview?from=${encodeURIComponent(from)}&days=${days}`))
    const payload = await readJsonResponse(response)
    const scheduled = payload.scheduled || {}

    for (let i = 0; i < days; i++) {
      const date = addDays(from, i)
      const filledCats = scheduled[date] || []
      const cats = {}
      for (const cat of CATEGORIES) {
        cats[cat] = filledCats.includes(cat)
      }
      rows.push({ date, cats })
    }
  } catch {
    for (let i = 0; i < days; i++) {
      const date = addDays(from, i)
      const cats = {}
      for (const cat of CATEGORIES) cats[cat] = false
      rows.push({ date, cats })
    }
  }

  overviewList.innerHTML = rows.map((row) => {
    const chips = CATEGORIES.map((cat) =>
      `<span class="overview-chip" data-filled="${row.cats[cat]}">${cat}</span>`
    ).join('')
    return `<div class="overview-row" data-date="${row.date}">
      <span class="overview-date">${row.date}</span>
      <div class="overview-chips">${chips}</div>
    </div>`
  }).join('')

  overviewList.querySelectorAll('.overview-row').forEach((row) => {
    row.addEventListener('click', () => {
      dateInput.value = row.dataset.date
      overviewOverlay.hidden = true
      loadDateDetails()
    })
  })
})

overviewCloseBtn.addEventListener('click', () => {
  overviewOverlay.hidden = true
})

overviewOverlay.addEventListener('click', (e) => {
  if (e.target === overviewOverlay) overviewOverlay.hidden = true
})

// ─── Auth Gate ───

gateLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const password = gatePassword.value.trim()
  if (!password) {
    gateError.textContent = 'Enter the admin password.'
    return
  }

  gateError.textContent = ''
  try {
    const { response, payload } = await adminFetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    })

    if (!response.ok) {
      gateError.textContent = payload.error || 'Sign in failed.'
      return
    }

    setAuthState(true)
    gatePassword.value = ''
    setStatus('Admin session active.', 'ok')
    refreshFreeModels({ quiet: true })
    refreshBatchStatus()
  } catch {
    gateError.textContent = 'Network error.'
  }
})

// ─── Test tab: Gemma rewriter probe ───
const testGemmaForm = document.getElementById('test-gemma-form')
const testGemmaCategory = document.getElementById('test-gemma-category')
const testGemmaDescriptive = document.getElementById('test-gemma-descriptive')
const testGemmaRunBtn = document.getElementById('test-gemma-run-btn')
const testGemmaClearBtn = document.getElementById('test-gemma-clear-btn')
const testGemmaResult = document.getElementById('test-gemma-result')
const testGemmaStatusChip = document.getElementById('test-gemma-status-chip')
const testGemmaKeyChip = document.getElementById('test-gemma-key-chip')
const testGemmaModelChip = document.getElementById('test-gemma-model-chip')
const testGemmaTimeChip = document.getElementById('test-gemma-time-chip')
const testGemmaInput = document.getElementById('test-gemma-input')
const testGemmaPromptSent = document.getElementById('test-gemma-prompt-sent')
const testGemmaRaw = document.getElementById('test-gemma-raw')
const testGemmaOutput = document.getElementById('test-gemma-output')
const testGemmaErrorWrap = document.getElementById('test-gemma-error-wrap')
const testGemmaError = document.getElementById('test-gemma-error')
const testGemmaLog = document.getElementById('test-gemma-log')

function appendTestGemmaLog(level, message, detail) {
  if (!testGemmaLog) return
  const emptyEl = testGemmaLog.querySelector('.test-gemma-log-empty')
  if (emptyEl) emptyEl.remove()
  const row = document.createElement('div')
  row.className = `test-gemma-log-row test-gemma-log-row--${level}`
  const time = new Date().toLocaleTimeString([], { hour12: false })
  row.innerHTML = `
    <span class="test-gemma-log-time">${time}</span>
    <span class="test-gemma-log-level">${level.toUpperCase()}</span>
    <span class="test-gemma-log-msg"></span>
  `
  row.querySelector('.test-gemma-log-msg').textContent =
    detail ? `${message} — ${detail}` : message
  testGemmaLog.prepend(row)
}

async function runGemmaTest(ev) {
  ev?.preventDefault?.()
  if (!testGemmaRunBtn) return

  const category = testGemmaCategory?.value || 'jigsaw'
  const descriptive = (testGemmaDescriptive?.value || '').trim()

  testGemmaRunBtn.disabled = true
  testGemmaRunBtn.textContent = 'Running…'
  appendTestGemmaLog(
    'info',
    `request → category=${category}`,
    descriptive ? `custom descriptive (${descriptive.length} chars)` : 'auto-sample from pool',
  )

  const started = performance.now()
  try {
    const response = await fetch(apiUrl('/api/admin/prompts/test-gemma'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, descriptive: descriptive || undefined }),
    })
    const clientMs = Math.round(performance.now() - started)

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      const msg = payload?.error || `HTTP ${response.status}`
      appendTestGemmaLog('error', `response ← HTTP ${response.status}`, msg)
      renderTestGemmaResult({
        ok: false,
        category,
        model: payload?.model || '—',
        keyUsed: payload?.keyUsed || null,
        elapsedMs: clientMs,
        input: payload?.input || descriptive || '(no input)',
        promptSent: payload?.promptSent || null,
        rawOutput: payload?.rawOutput || null,
        output: null,
        error: msg,
      })
      return
    }

    const ok = Boolean(payload?.ok)
    const keyUsed = payload?.keyUsed
    const serverMs = typeof payload?.elapsedMs === 'number' ? payload.elapsedMs : clientMs

    if (ok) {
      appendTestGemmaLog(
        'ok',
        `response ← ok via ${keyUsed} key`,
        `model=${payload.model} · server ${serverMs}ms · output ${payload.output?.length || 0} chars`,
      )
    } else {
      appendTestGemmaLog('error', `response ← failed`, payload?.error || 'unknown error')
    }

    if (keyUsed === 'paid') {
      appendTestGemmaLog(
        'warn',
        'free-tier key fell back to paid key',
        'check quota — daily cron at 00:00 UTC will do the same',
      )
    }
    if (!payload?.haveFreeKey) {
      appendTestGemmaLog('warn', 'GOOGLE_AI_FREE_API_KEY is not configured', 'rewriter will only ever use paid key')
    }
    if (!payload?.havePaidKey) {
      appendTestGemmaLog('warn', 'GOOGLE_AI_API_KEY is not configured', 'no paid-key fallback available')
    }

    renderTestGemmaResult({
      ok,
      category: payload?.category || category,
      model: payload?.model || '—',
      keyUsed,
      elapsedMs: serverMs,
      input: payload?.input || '(no input)',
      promptSent: payload?.promptSent || null,
      rawOutput: payload?.rawOutput || null,
      output: payload?.output || null,
      error: payload?.error || null,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendTestGemmaLog('error', 'request threw', msg)
    renderTestGemmaResult({
      ok: false,
      category,
      model: '—',
      keyUsed: null,
      elapsedMs: Math.round(performance.now() - started),
      input: descriptive || '(no input)',
      promptSent: null,
      rawOutput: null,
      output: null,
      error: msg,
    })
  } finally {
    testGemmaRunBtn.disabled = false
    testGemmaRunBtn.textContent = 'Run test'
  }
}

function renderTestGemmaResult(r) {
  if (!testGemmaResult) return
  testGemmaResult.hidden = false
  testGemmaStatusChip.textContent = r.ok ? 'OK' : 'FAIL'
  testGemmaStatusChip.className =
    'test-gemma-chip ' + (r.ok ? 'test-gemma-chip--ok' : 'test-gemma-chip--err')
  testGemmaKeyChip.textContent = `key: ${r.keyUsed || '—'}`
  testGemmaKeyChip.className =
    'test-gemma-chip ' +
    (r.keyUsed === 'free'
      ? 'test-gemma-chip--ok'
      : r.keyUsed === 'paid'
        ? 'test-gemma-chip--warn'
        : '')
  testGemmaModelChip.textContent = `model: ${r.model}`
  testGemmaTimeChip.textContent = `${r.elapsedMs} ms`
  testGemmaInput.textContent = r.input || ''
  if (testGemmaPromptSent) testGemmaPromptSent.textContent = r.promptSent || '(not captured)'
  if (testGemmaRaw) testGemmaRaw.textContent = r.rawOutput || '(not captured)'
  testGemmaOutput.textContent = r.output || '(no output)'
  if (r.error) {
    testGemmaErrorWrap.hidden = false
    testGemmaError.textContent = r.error
  } else {
    testGemmaErrorWrap.hidden = true
    testGemmaError.textContent = ''
  }
}

if (testGemmaForm) testGemmaForm.addEventListener('submit', runGemmaTest)
if (testGemmaClearBtn) {
  testGemmaClearBtn.addEventListener('click', () => {
    if (testGemmaLog) {
      testGemmaLog.innerHTML = '<div class="test-gemma-log-empty">No runs yet.</div>'
    }
    if (testGemmaResult) testGemmaResult.hidden = true
  })
}

// ─── Init ───

if (rewriteModelSelect && rewriteModelSelect.options.length === 0) {
  populateRewriteModels([], 'openrouter/free')
}

setAuthState(false)
clearExistingMeta()
applyDateMode()
initDropZones()
loadDateDetails()
refreshSession({ quiet: true }).then((authenticated) => {
  if (authenticated) {
    refreshFreeModels({ quiet: true })
    refreshBatchStatus()
  }
})

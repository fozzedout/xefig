import './admin.css'

const API_BASE = ''
const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram']

const loginForm = document.getElementById('admin-login-form')
const usernameInput = document.getElementById('admin-username')
const passwordInput = document.getElementById('admin-password')
const loginBtn = document.getElementById('login-btn')
const logoutBtn = document.getElementById('logout-btn')
const authBadge = document.getElementById('auth-badge')

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
const submitBtn = document.getElementById('submit-btn')
const submitLabel = document.getElementById('submit-label')
const statusBar = document.getElementById('status')
const statusText = document.getElementById('status-text')

const promptFields = {
  jigsaw: document.getElementById('prompt-jigsaw'),
  slider: document.getElementById('prompt-slider'),
  swap: document.getElementById('prompt-swap'),
  polygram: document.getElementById('prompt-polygram'),
}

const thumbEls = {
  jigsaw: document.getElementById('thumb-jigsaw'),
  slider: document.getElementById('thumb-slider'),
  swap: document.getElementById('thumb-swap'),
  polygram: document.getElementById('thumb-polygram'),
}

const thumbnailEls = {
  jigsaw: document.getElementById('thumbnail-jigsaw'),
  slider: document.getElementById('thumbnail-slider'),
  swap: document.getElementById('thumbnail-swap'),
  polygram: document.getElementById('thumbnail-polygram'),
}

const fileInputs = {
  jigsaw: form.querySelector('input[name="jigsaw"]'),
  slider: form.querySelector('input[name="slider"]'),
  swap: form.querySelector('input[name="swap"]'),
  polygram: form.querySelector('input[name="polygram"]'),
}

const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
dateInput.value = tomorrow

let promptPack = null
let isExistingDate = false
let isAuthenticated = false

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function setStatus(text, type = 'idle') {
  statusText.textContent = text
  statusBar.dataset.type = type
}

function setAuthState(authenticated) {
  isAuthenticated = authenticated
  authBadge.textContent = authenticated ? 'Signed In' : 'Signed Out'
  authBadge.dataset.state = authenticated ? 'signed-in' : 'signed-out'
  loginBtn.hidden = authenticated
  logoutBtn.hidden = !authenticated
}

function requireAuth() {
  if (isAuthenticated) {
    return true
  }

  setStatus('Sign in first.', 'error')
  passwordInput.focus()
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
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    ...init,
  })
  const payload = await readJsonResponse(response)

  if (response.status === 401) {
    setAuthState(false)
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
    imageRule.textContent = 'New date - all four images are required to create it.'
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

function renderLoadedPuzzle(puzzle) {
  if (!puzzle) {
    clearExistingMeta()
    return
  }

  for (const category of CATEGORIES) {
    const asset = puzzle.categories?.[category]
    setThumb(category, asset || null)

    const categoryThemeInput = document.getElementById(`theme-${category}`)
    const categoryTagsInput = document.getElementById(`tags-${category}`)
    if (categoryThemeInput) {
      categoryThemeInput.value = asset?.theme || ''
    }
    if (categoryTagsInput) {
      categoryTagsInput.value = Array.isArray(asset?.tags) ? asset.tags.join(', ') : ''
    }
  }
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
      const card = zone.closest('.upload-card')
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

function setActiveStep(n) {
  document.querySelectorAll('.step-indicator').forEach((el) => {
    const step = parseInt(el.dataset.step, 10)
    el.classList.toggle('active', step === n)
    el.classList.toggle('done', step < n)
  })
}

async function loadDateDetails() {
  const date = dateInput.value.trim()
  if (!date) {
    setStatus('Choose a date first.', 'error')
    return
  }

  setStatus(`Loading ${date}...`, 'working')
  setActiveStep(1)
  try {
    const response = await fetch(apiUrl(`/api/puzzles/${encodeURIComponent(date)}`))
    const payload = await readJsonResponse(response)
    if (response.status === 404) {
      isExistingDate = false
      clearExistingMeta()
      applyDateMode()
      setRecordBadge('New', 'new')
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
    setActiveStep(2)
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
    const contextLabel = contextLength && contextLength > 0 ? ` • ${contextLength.toLocaleString()} ctx` : ''
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

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()

  const password = passwordInput.value.trim()
  if (!password) {
    setStatus('Enter the admin password to sign in.', 'error')
    return
  }

  loginBtn.disabled = true
  setStatus('Signing in...', 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput?.value || 'admin',
        password,
      }),
    })

    if (!response.ok) {
      setAuthState(false)
      setStatus(payload.error || 'Sign in failed.', 'error')
      return
    }

    setAuthState(true)
    passwordInput.value = ''
    setStatus('Admin session active.', 'ok')
    refreshFreeModels({ quiet: true })
  } catch {
    setStatus('Network error while signing in.', 'error')
  } finally {
    loginBtn.disabled = false
  }
})

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true
  try {
    await adminFetch('/api/admin/session', { method: 'DELETE' })
    setAuthState(false)
    setStatus('Signed out.', 'note')
  } catch {
    setStatus('Network error while signing out.', 'error')
  } finally {
    logoutBtn.disabled = false
  }
})

prevDayBtn.addEventListener('click', () => shiftDate(-1))
nextDayBtn.addEventListener('click', () => shiftDate(1))
loadDateBtn.addEventListener('click', loadDateDetails)
nextEmptyBtn.addEventListener('click', jumpToNextEmpty)
dateInput.addEventListener('change', loadDateDetails)
refreshModelsBtn.addEventListener('click', () => {
  refreshFreeModels()
})

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

generateBtn.addEventListener('click', async () => {
  if (!requireAuth()) {
    return
  }

  generateBtn.disabled = true
  copyPackBtn.disabled = true
  setStatus('Generating prompts...', 'working')
  setActiveStep(2)
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
    setStatus('Prompts ready - copy each one into your image tool, then upload the results below.', 'ok')
    setActiveStep(3)
  } catch {
    setStatus('Network error while generating prompts.', 'error')
    promptPack = null
    clearPrompts()
  } finally {
    generateBtn.disabled = false
  }
})

autoGenerateBtn.addEventListener('click', async () => {
  if (!requireAuth()) {
    return
  }

  autoGenerateBtn.disabled = true
  setStatus('Submitting batch image generation job...', 'working')
  try {
    const { response, payload } = await adminFetch('/api/admin/generate-images', {
      method: 'POST',
    })
    if (response.status === 401) {
      setStatus(payload.error || 'Admin session expired. Sign in again.', 'error')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Batch submit failed.', 'error')
      return
    }

    setStatus(payload.message || 'Batch job submitted. Use Poll Batch to check progress.', 'ok')
  } catch {
    setStatus('Network error during batch submit.', 'error')
  } finally {
    autoGenerateBtn.disabled = false
  }
})

batchPollBtn.addEventListener('click', async () => {
  if (!requireAuth()) {
    return
  }

  batchPollBtn.disabled = true
  setStatus('Polling batch job status...', 'working')
  try {
    // First do a server-side poll (advances the state machine if batch just completed)
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

    // Check if there are images ready for client-side processing
    const status = await checkAndProcessBatch()
    if (!status) {
      setStatus(payload.message || 'Batch poll completed.', 'ok')
      await loadDateDetails()
    }
  } catch {
    setStatus('Network error during batch poll.', 'error')
  } finally {
    batchPollBtn.disabled = false
  }
})

async function checkAndProcessBatch() {
  const { response, payload } = await adminFetch('/api/admin/generate-images/status')
  if (!response.ok || !payload.active) return false
  if (payload.phase !== 'fetched') return false

  const remaining = payload.remainingCategories || []
  if (remaining.length === 0) return false

  const tempUrls = payload.tempUrls || {}
  const total = CATEGORIES.length
  let processed = total - remaining.length

  for (const category of remaining) {
    const tempUrl = tempUrls[category]
    if (!tempUrl) continue

    processed++
    setStatus(`Processing ${category} (${processed}/${total})...`, 'working')

    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = tempUrl
      await img.decode()

      // Full-size JPEG
      const fullCanvas = document.createElement('canvas')
      fullCanvas.width = img.naturalWidth
      fullCanvas.height = img.naturalHeight
      const fullCtx = fullCanvas.getContext('2d')
      fullCtx.fillStyle = '#fff'
      fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height)
      fullCtx.drawImage(img, 0, 0)

      const jpegBlob = await new Promise((resolve, reject) => {
        fullCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encode failed'))), 'image/jpeg', 0.8)
      })

      // Thumbnail
      const thumbBlob = await generateThumbnailFromUrl(tempUrl)

      // Upload both
      const formData = new FormData()
      formData.append('category', category)
      formData.append('image', jpegBlob, `${category}.jpg`)
      formData.append('thumbnail', thumbBlob, `${category}_thumb.jpg`)

      const { response: completeRes, payload: completePayload } = await adminFetch(
        '/api/admin/generate-images/complete-category',
        { method: 'POST', body: formData },
      )

      if (!completeRes.ok) {
        setStatus(completePayload.error || `Failed to save ${category}.`, 'error')
        return true
      }

      if (completePayload.allDone) {
        setStatus(completePayload.message || 'All images processed and saved.', 'ok')
        dateInput.value = payload.targetDate
        await loadDateDetails()
        return true
      }
    } catch (err) {
      setStatus(`Failed to process ${category}: ${err.message || 'unknown error'}`, 'error')
      return true
    }
  }

  setStatus('Batch processing complete.', 'ok')
  await loadDateDetails()
  return true
}

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

    const label = btn.closest('.prompt-card')?.querySelector('.mode-tag')?.textContent || 'Prompt'
    await copyText(field.value, label)
  })
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!requireAuth()) {
    return
  }

  submitBtn.disabled = true
  setStatus('Saving...', 'working')
  setActiveStep(4)
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
      zone?.closest('.upload-card')?.classList.remove('has-replacement')
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
  }
})

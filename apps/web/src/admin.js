import './admin.css'

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:8787' : ''
const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram']

const form           = document.getElementById('admin-form')
const dateInput      = document.getElementById('date')
const passwordInput  = document.getElementById('admin-password')
const hiddenPassword = document.getElementById('form-password')
const recordBadge    = document.getElementById('record-badge')
const imageRule      = document.getElementById('image-rule')
const prevDayBtn     = document.getElementById('prev-day-btn')
const nextDayBtn     = document.getElementById('next-day-btn')
const loadDateBtn    = document.getElementById('load-date-btn')
const nextEmptyBtn   = document.getElementById('next-empty-btn')
const generateBtn    = document.getElementById('generate-prompt-btn')
const copyPackBtn    = document.getElementById('copy-pack-btn')
const refreshModelsBtn = document.getElementById('refresh-models-btn')
const rewriteModelSelect = document.getElementById('rewrite-model-select')
const themeInput     = document.getElementById('selected-theme')
const tagsInput      = document.getElementById('upload-tags')
const submitBtn      = document.getElementById('submit-btn')
const submitLabel    = document.getElementById('submit-label')
const statusBar      = document.getElementById('status')
const statusText     = document.getElementById('status-text')

const promptFields = {
  jigsaw:   document.getElementById('prompt-jigsaw'),
  slider:   document.getElementById('prompt-slider'),
  swap:     document.getElementById('prompt-swap'),
  polygram: document.getElementById('prompt-polygram'),
}

const thumbEls = {
  jigsaw:   document.getElementById('thumb-jigsaw'),
  slider:   document.getElementById('thumb-slider'),
  swap:     document.getElementById('thumb-swap'),
  polygram: document.getElementById('thumb-polygram'),
}

const fileInputs = {
  jigsaw:   form.querySelector('input[name="jigsaw"]'),
  slider:   form.querySelector('input[name="slider"]'),
  swap:     form.querySelector('input[name="swap"]'),
  polygram: form.querySelector('input[name="polygram"]'),
}

// ── Helpers ────────────────────────────────────────────
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
dateInput.value = tomorrow

let promptPack    = null
let isExistingDate = false

function apiUrl(path) { return `${API_BASE}${path}` }

function setStatus(text, type = 'idle') {
  statusText.textContent = text
  statusBar.dataset.type = type
}

function syncPassword() { hiddenPassword.value = passwordInput.value.trim() }

function addDays(dateKey, n) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
}

function setRecordBadge(text, state = 'idle') {
  recordBadge.textContent = text
  recordBadge.dataset.state = state
}

function applyDateMode() {
  for (const cat of CATEGORIES) {
    if (fileInputs[cat]) fileInputs[cat].required = !isExistingDate
  }
  if (isExistingDate) {
    submitLabel.textContent = 'Save Changes'
    imageRule.textContent = 'Existing date — leave a slot empty to keep its current image.'
  } else {
    submitLabel.textContent = 'Create Puzzle'
    imageRule.textContent = 'New date — all four images are required to create it.'
  }
}

function clearPrompts() {
  for (const k of CATEGORIES) promptFields[k].value = ''
}

function setThumb(category, asset) {
  const wrap = thumbEls[category]
  if (!wrap) return
  if (!asset?.imageUrl) {
    wrap.hidden = true
    wrap.querySelector('img').src = ''
    return
  }
  const img = wrap.querySelector('img')
  img.src = asset.imageUrl
  wrap.hidden = false
}

function clearExistingMeta() {
  for (const cat of CATEGORIES) setThumb(cat, null)
}

function renderLoadedPuzzle(puzzle) {
  if (!puzzle) { clearExistingMeta(); return }
  themeInput.value = typeof puzzle.theme === 'string' ? puzzle.theme : ''
  tagsInput.value  = Array.isArray(puzzle.tags) ? puzzle.tags.join(', ') : ''
  for (const cat of CATEGORIES) setThumb(cat, puzzle.categories?.[cat] || null)
}

// ── Drop-zone file feedback ────────────────────────────
function initDropZones() {
  for (const cat of CATEGORIES) {
    const input   = fileInputs[cat]
    const zone    = document.getElementById(`drop-${cat}`)
    const nameEl  = zone?.querySelector('.drop-name')
    if (!input || !zone || !nameEl) continue

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

    // Drag highlight
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.borderColor = 'var(--accent)' })
    zone.addEventListener('dragleave', () => { zone.style.borderColor = '' })
    zone.addEventListener('drop',      () => { zone.style.borderColor = '' })
  }
}

// ── Step rail active state ─────────────────────────────
function setActiveStep(n) {
  document.querySelectorAll('.step-indicator').forEach((el) => {
    const s = parseInt(el.dataset.step)
    el.classList.toggle('active', s === n)
    el.classList.toggle('done',   s < n)
  })
}

// ── Network calls ──────────────────────────────────────
async function loadDateDetails() {
  const date = dateInput.value.trim()
  if (!date) { setStatus('Choose a date first.', 'error'); return }
  setStatus(`Loading ${date}…`, 'working')
  setActiveStep(1)
  try {
    const res     = await fetch(apiUrl(`/api/puzzles/${encodeURIComponent(date)}`))
    const payload = await res.json()
    if (res.status === 404) {
      isExistingDate = false
      themeInput.value = ''
      tagsInput.value  = ''
      clearExistingMeta()
      applyDateMode()
      setRecordBadge('New', 'new')
      setStatus(`${date} has no puzzle yet — fill in details and upload images to create it.`, 'note')
      return
    }
    if (!res.ok) { setStatus(payload.error || 'Could not load date.', 'error'); return }
    isExistingDate = true
    renderLoadedPuzzle(payload)
    applyDateMode()
    setRecordBadge('Exists', 'existing')
    setStatus(`Loaded ${date}. Upload replacements or leave slots empty to keep current images.`, 'ok')
    setActiveStep(2)
  } catch { setStatus('Network error while loading date.', 'error') }
}

async function jumpToNextEmpty() {
  const pw = passwordInput.value.trim()
  if (!pw) { setStatus('Enter admin password first.', 'error'); return }
  syncPassword()
  const from = dateInput.value.trim() || tomorrow
  setStatus(`Scanning from ${from}…`, 'working')
  try {
    const res     = await fetch(apiUrl(`/api/admin/puzzles/next-empty?from=${encodeURIComponent(from)}`), {
      headers: { 'x-admin-password': pw },
    })
    const payload = await res.json()
    if (!res.ok) { setStatus(payload.error || 'Could not find next empty date.', 'error'); return }
    dateInput.value = payload.nextEmptyDate || from
    await loadDateDetails()
  } catch { setStatus('Network error while scanning dates.', 'error') }
}

function shiftDate(n) {
  dateInput.value = addDays(dateInput.value.trim() || tomorrow, n)
  loadDateDetails()
}

async function copyText(text, label) {
  if (!text) { setStatus(`Nothing to copy for ${label}.`, 'error'); return }
  try {
    await navigator.clipboard.writeText(text)
    setStatus(`${label} copied.`, 'ok')
  } catch { setStatus(`Clipboard copy failed for ${label}.`, 'error') }
}

async function convertToJpeg(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width  = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)

    const croppedCanvas = cropBorders(canvas)

    const blob = await new Promise((res, rej) => {
      croppedCanvas.toBlob((b) => b ? res(b) : rej(new Error('Conversion failed')), 'image/jpeg', 0.8)
    })
    const safe = (file.name || 'image').replace(/[.][^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
    return new File([blob], `${safe}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
  } finally { URL.revokeObjectURL(url) }
}

/**
 * Zealously crop solid or near-solid color borders from a canvas.
 */
function cropBorders(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return canvas
  const { width, height } = canvas
  const imgData = ctx.getImageData(0, 0, width, height)
  const data = imgData.data

  const getPixel = (x, y) => {
    const idx = (y * width + x) * 4
    return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]
  }

  const isUniformRow = (y, threshold = 18) => {
    const first = getPixel(0, y)
    for (let x = 1; x < width; x++) {
      const p = getPixel(x, y)
      if (Math.abs(p[0] - first[0]) > threshold ||
          Math.abs(p[1] - first[1]) > threshold ||
          Math.abs(p[2] - first[2]) > threshold) return false
    }
    return true
  }

  const isUniformCol = (x, threshold = 18) => {
    const first = getPixel(x, 0)
    for (let y = 1; y < height; y++) {
      const p = getPixel(x, y)
      if (Math.abs(p[0] - first[0]) > threshold ||
          Math.abs(p[1] - first[1]) > threshold ||
          Math.abs(p[2] - first[2]) > threshold) return false
    }
    return true
  }

  let top = 0;    while (top < height * 0.25 && isUniformRow(top)) top++
  let bottom = height - 1; while (bottom > height * 0.75 && isUniformRow(bottom)) bottom--
  let left = 0;   while (left < width * 0.25 && isUniformCol(left)) left++
  let right = width - 1;  while (right > width * 0.75 && isUniformCol(right)) right--

  if (top === 0 && bottom === height - 1 && left === 0 && right === width - 1) return canvas

  const croppedWidth  = right - left + 1
  const croppedHeight = bottom - top + 1
  if (croppedWidth <= 32 || croppedHeight <= 32) return canvas // Sanity check

  const croppedCanvas = document.createElement('canvas')
  croppedCanvas.width  = croppedWidth
  croppedCanvas.height = croppedHeight
  const croppedCtx = croppedCanvas.getContext('2d')
  croppedCtx.drawImage(canvas, left, top, croppedWidth, croppedHeight, 0, 0, croppedWidth, croppedHeight)
  return croppedCanvas
}

function renderPromptPack(pack) {
  if (!pack) { clearPrompts(); return }
  themeInput.value         = pack.themeName || ''
  tagsInput.value          = Array.isArray(pack.keywords) ? pack.keywords.join(', ') : ''
  promptFields.jigsaw.value   = pack.prompts?.jigsaw   || ''
  promptFields.slider.value   = pack.prompts?.slider   || ''
  promptFields.swap.value     = pack.prompts?.swap     || ''
  promptFields.polygram.value = pack.prompts?.polygram || ''
}

function getSelectedRewriteModel() {
  return typeof rewriteModelSelect?.value === 'string' ? rewriteModelSelect.value.trim() : ''
}

function populateRewriteModels(models, defaultModel) {
  if (!rewriteModelSelect) return
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
    if (!id) continue
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
  const pw = passwordInput.value.trim()
  if (!pw) {
    if (!quiet) setStatus('Enter admin password first.', 'error')
    return
  }

  if (refreshModelsBtn) refreshModelsBtn.disabled = true
  if (!quiet) setStatus('Loading free OpenRouter models…', 'working')

  try {
    const res = await fetch(apiUrl('/api/admin/openrouter/free-models'), {
      headers: { 'x-admin-password': pw },
    })
    const payload = await res.json()
    if (!res.ok) {
      if (!quiet) setStatus(payload.error || 'Could not load free models.', 'error')
      return
    }

    populateRewriteModels(payload.models, payload.defaultModel)
    if (!quiet) {
      const count = Array.isArray(payload.models) ? payload.models.length : 0
      setStatus(`Loaded ${count} free models.`, 'ok')
    }
  } catch {
    if (!quiet) setStatus('Network error while loading free models.', 'error')
  } finally {
    if (refreshModelsBtn) refreshModelsBtn.disabled = false
  }
}

async function rewritePrompt(category, triggerBtn) {
  const pw = passwordInput.value.trim()
  if (!pw) { setStatus('Enter admin password first.', 'error'); return }

  const field = promptFields[category]
  if (!field) { setStatus('Prompt field not found.', 'error'); return }
  const rawPrompt = field.value.trim()
  if (!rawPrompt) { setStatus(`No ${category} prompt to rewrite.`, 'error'); return }

  const model = getSelectedRewriteModel()
  const modelLabel = model || 'worker default'
  triggerBtn.disabled = true
  setStatus(`Rewriting ${category} prompt using ${modelLabel}…`, 'working')
  try {
    const res = await fetch(apiUrl('/api/admin/prompts/rewrite-one'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: pw,
        category,
        prompt: rawPrompt,
        ...(model ? { model } : {}),
      }),
    })
    const payload = await res.json()
    if (!res.ok) {
      setStatus(payload.error || `Failed to rewrite ${category} prompt.`, 'error')
      return
    }

    const nextPrompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!nextPrompt) {
      setStatus(`No rewritten ${category} prompt returned.`, 'error')
      return
    }

    field.value = nextPrompt
    if (promptPack?.prompts && typeof promptPack.prompts === 'object') {
      promptPack.prompts[category] = nextPrompt
    }

    const usedModel = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : modelLabel
    setStatus(`Rewrote ${category} prompt using ${usedModel}.`, 'ok')
  } catch {
    setStatus(`Network error while rewriting ${category} prompt.`, 'error')
  } finally {
    triggerBtn.disabled = false
  }
}

// ── Event wiring ───────────────────────────────────────
passwordInput.addEventListener('input', syncPassword)
syncPassword()
clearExistingMeta()
applyDateMode()
initDropZones()

prevDayBtn.addEventListener('click', () => shiftDate(-1))
nextDayBtn.addEventListener('click', () => shiftDate(1))
loadDateBtn.addEventListener('click', loadDateDetails)
nextEmptyBtn.addEventListener('click', jumpToNextEmpty)
dateInput.addEventListener('change', loadDateDetails)
if (refreshModelsBtn) {
  refreshModelsBtn.addEventListener('click', () => { refreshFreeModels() })
}

if (rewriteModelSelect && rewriteModelSelect.options.length === 0) {
  populateRewriteModels([], 'openrouter/free')
}

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
  const pw = passwordInput.value.trim()
  if (!pw) { setStatus('Enter admin password first.', 'error'); return }
  generateBtn.disabled  = true
  copyPackBtn.disabled  = true
  setStatus('Generating prompts…', 'working')
  setActiveStep(2)
  try {
    const res     = await fetch(apiUrl('/api/admin/prompts/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        password: pw,
        model: getSelectedRewriteModel()
      }),
    })
    const payload = await res.json()
    if (!res.ok) {
      setStatus(payload.error || 'Prompt generation failed.', 'error')
      promptPack = null; clearPrompts(); return
    }
    const packs = Array.isArray(payload.prompts) ? payload.prompts : []
    const first = packs[0] || null
    if (!first) {
      setStatus('No prompts returned.', 'error')
      promptPack = null; clearPrompts(); return
    }
    promptPack = first
    renderPromptPack(first)
    copyPackBtn.disabled = false
    refreshFreeModels({ quiet: true })
    setStatus('Prompts ready — copy each one into your image tool, then upload the results below.', 'ok')
    setActiveStep(3)
  } catch { setStatus('Network error while generating prompts.', 'error'); promptPack = null; clearPrompts()
  } finally { generateBtn.disabled = false }
})

copyPackBtn.addEventListener('click', async () => {
  if (!promptPack) { setStatus('Generate prompts first.', 'error'); return }
  const text = [
    'DAILY PROMPTS',
    `Label: ${promptPack.themeName || ''}`,
    `Tags: ${Array.isArray(promptPack.keywords) ? promptPack.keywords.join(', ') : ''}`,
    '', 'JIGSAW:',   promptPack.prompts?.jigsaw   || '',
    '', 'SLIDER:',   promptPack.prompts?.slider   || '',
    '', 'SWAP:',     promptPack.prompts?.swap     || '',
    '', 'POLYGRAM:', promptPack.prompts?.polygram || '',
  ].join('\n')
  await copyText(text, 'All prompts')
})

document.querySelectorAll('.copy-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = btn.getAttribute('data-target')
    const field  = target ? document.getElementById(target) : null
    if (!field) return
    const label = btn.closest('.prompt-card')?.querySelector('.mode-tag')?.textContent || 'Prompt'
    await copyText(field.value, label)
  })
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const pw = passwordInput.value.trim()
  if (!pw) { setStatus('Enter admin password first.', 'error'); return }
  syncPassword()
  submitBtn.disabled = true
  setStatus('Saving…', 'working')
  setActiveStep(4)
  try {
    const fd = new FormData(form)
    for (const cat of CATEGORIES) {
      const file = fd.get(cat)
      if (file instanceof File && file.size > 0) {
        const jpeg = await convertToJpeg(file)
        fd.set(cat, jpeg, jpeg.name)
      } else { fd.delete(cat) }
    }
    const res     = await fetch(apiUrl('/api/admin/puzzles'), { method: 'POST', body: fd })
    const payload = await res.json()
    if (!res.ok) { setStatus(payload.error || 'Save failed.', 'error'); return }
    const extra = payload.generatedTheme ? ` Theme: ${payload.generatedTheme}.` : ''
    isExistingDate = true
    applyDateMode()
    setRecordBadge('Exists', 'existing')
    renderLoadedPuzzle(payload.puzzle || null)
    for (const cat of CATEGORIES) {
      const input = fileInputs[cat]
      const zone  = document.getElementById(`drop-${cat}`)
      const nameEl = zone?.querySelector('.drop-name')
      if (input)  input.value = ''
      if (zone)   zone.classList.remove('has-file')
      if (nameEl) nameEl.textContent = ''
      zone?.closest('.upload-card')?.classList.remove('has-replacement')
    }
    setStatus(`${payload.message || 'Saved.'}${extra}`, 'ok')
  } catch { setStatus('Network error while saving.', 'error')
  } finally { submitBtn.disabled = false }
})

refreshFreeModels({ quiet: true })
loadDateDetails()

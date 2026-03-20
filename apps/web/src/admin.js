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
    const blob = await new Promise((res, rej) => {
      canvas.toBlob((b) => b ? res(b) : rej(new Error('Conversion failed')), 'image/jpeg', 0.8)
    })
    const safe = (file.name || 'image').replace(/[.][^/.]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_')
    return new File([blob], `${safe}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
  } finally { URL.revokeObjectURL(url) }
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
      body: JSON.stringify({ password: pw }),
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

loadDateDetails()

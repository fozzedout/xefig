import './admin.css'

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:8787' : ''
const CATEGORIES = ['jigsaw', 'slider', 'swap', 'polygram']

const form = document.getElementById('admin-form')
const status = document.getElementById('status')
const dateInput = document.getElementById('date')
const passwordInput = document.getElementById('admin-password')
const hiddenPasswordInput = document.getElementById('form-password')
const recordState = document.getElementById('record-state')
const imageRule = document.getElementById('image-rule')
const prevDayBtn = document.getElementById('prev-day-btn')
const nextDayBtn = document.getElementById('next-day-btn')
const loadDateBtn = document.getElementById('load-date-btn')
const nextEmptyBtn = document.getElementById('next-empty-btn')
const generateBtn = document.getElementById('generate-prompt-btn')
const copyPackBtn = document.getElementById('copy-pack-btn')
const selectedThemeInput = document.getElementById('selected-theme')
const uploadTagsInput = document.getElementById('upload-tags')
const submitBtn = document.getElementById('submit-btn')

const promptFields = {
  jigsaw: document.getElementById('prompt-jigsaw'),
  slider: document.getElementById('prompt-slider'),
  swap: document.getElementById('prompt-swap'),
  polygram: document.getElementById('prompt-polygram'),
}

const existingMetaFields = {
  jigsaw: document.getElementById('existing-jigsaw'),
  slider: document.getElementById('existing-slider'),
  swap: document.getElementById('existing-swap'),
  polygram: document.getElementById('existing-polygram'),
}

const fileInputs = {
  jigsaw: form.querySelector('input[name="jigsaw"]'),
  slider: form.querySelector('input[name="slider"]'),
  swap: form.querySelector('input[name="swap"]'),
  polygram: form.querySelector('input[name="polygram"]'),
}

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
dateInput.value = tomorrow

let promptPack = null
let isExistingDate = false

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function setStatus(text, type = 'note') {
  status.textContent = text
  status.className = `status ${type}`
}

function syncPasswordIntoForm() {
  hiddenPasswordInput.value = passwordInput.value.trim()
}

function addDays(dateKey, days) {
  const base = Date.parse(`${dateKey}T00:00:00.000Z`)
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function setRecordState(text, type = 'new') {
  recordState.textContent = text
  recordState.className = `record-state ${type}`
}

function applyDateModeUi() {
  for (const category of CATEGORIES) {
    const input = fileInputs[category]
    if (input) {
      input.required = !isExistingDate
    }
  }

  if (isExistingDate) {
    submitBtn.textContent = 'Save Changes'
    imageRule.textContent = 'Existing date loaded: leave file inputs empty to keep current images.'
  } else {
    submitBtn.textContent = 'Create Date'
    imageRule.textContent = 'New date: all four image uploads are required to create it.'
  }
}

function clearPromptTextareas() {
  for (const key of CATEGORIES) {
    promptFields[key].value = ''
  }
}

function setExistingFileMeta(category, asset) {
  const meta = existingMetaFields[category]
  if (!meta) {
    return
  }

  meta.textContent = ''
  if (!asset || !asset.imageUrl) {
    meta.textContent = isExistingDate ? 'No image currently saved for this mode.' : 'No image saved yet.'
    return
  }

  const prefix = document.createElement('span')
  prefix.textContent = 'Existing: '
  const link = document.createElement('a')
  link.href = asset.imageUrl
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = asset.fileName || `${category} image`
  meta.append(prefix, link)
}

function clearExistingFileMeta() {
  for (const category of CATEGORIES) {
    setExistingFileMeta(category, null)
  }
}

function renderLoadedPuzzle(puzzle) {
  if (!puzzle) {
    clearExistingFileMeta()
    return
  }

  selectedThemeInput.value = typeof puzzle.theme === 'string' ? puzzle.theme : ''
  uploadTagsInput.value = Array.isArray(puzzle.tags) ? puzzle.tags.join(', ') : ''

  for (const category of CATEGORIES) {
    setExistingFileMeta(category, puzzle.categories?.[category] || null)
  }
}

async function loadDateDetails() {
  const date = dateInput.value.trim()
  if (!date) {
    setStatus('Choose a date first.', 'error')
    return
  }

  setStatus(`Loading details for ${date}...`, 'note')

  try {
    const response = await fetch(apiUrl(`/api/puzzles/${encodeURIComponent(date)}`))
    const payload = await response.json()
    if (response.status === 404) {
      isExistingDate = false
      selectedThemeInput.value = ''
      uploadTagsInput.value = ''
      clearExistingFileMeta()
      applyDateModeUi()
      setRecordState(`Date ${date} is new (not uploaded yet).`, 'new')
      setStatus(`No puzzle scheduled for ${date}. Add metadata and upload images to create it.`, 'note')
      return
    }
    if (!response.ok) {
      setStatus(payload.error || 'Unable to load date details.', 'error')
      return
    }

    isExistingDate = true
    renderLoadedPuzzle(payload)
    applyDateModeUi()
    setRecordState(`Date ${date} exists and can be edited.`, 'existing')
    setStatus(`Loaded ${date}. Leave file inputs empty to keep current images, or upload replacements.`, 'ok')
  } catch (error) {
    setStatus('Network error while loading date details.', 'error')
  }
}

async function jumpToNextEmptyDate() {
  const password = passwordInput.value.trim()
  if (!password) {
    setStatus('Enter admin password before scanning for the next empty date.', 'error')
    return
  }
  syncPasswordIntoForm()

  const from = dateInput.value.trim() || tomorrow
  setStatus(`Searching for next empty date from ${from}...`, 'note')

  try {
    const response = await fetch(apiUrl(`/api/admin/puzzles/next-empty?from=${encodeURIComponent(from)}`), {
      headers: {
        'x-admin-password': password,
      },
    })
    const payload = await response.json()
    if (!response.ok) {
      setStatus(payload.error || 'Unable to find next empty date.', 'error')
      return
    }

    dateInput.value = payload.nextEmptyDate || from
    await loadDateDetails()
  } catch (error) {
    setStatus('Network error while finding next empty date.', 'error')
  }
}

function shiftDate(days) {
  const date = dateInput.value.trim() || tomorrow
  dateInput.value = addDays(date, days)
  loadDateDetails()
}

async function copyText(text, label) {
  if (!text) {
    setStatus(`Nothing to copy for ${label}.`, 'error')
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    setStatus(`${label} copied to clipboard.`, 'ok')
  } catch (error) {
    setStatus(`Clipboard copy failed for ${label}.`, 'error')
  }
}

async function convertImageFileToJpeg(file) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = objectUrl
    await image.decode()

    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Canvas context unavailable')
    }

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0)

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (!result) {
          reject(new Error('JPEG conversion failed'))
          return
        }
        resolve(result)
      }, 'image/jpeg', 0.8)
    })

    const safeBaseName = (file.name || 'image')
      .replace(/[.][^/.]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
    return new File([blob], `${safeBaseName}.jpg`, {
      type: 'image/jpeg',
      lastModified: Date.now(),
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function renderPromptPack(pack) {
  if (!pack) {
    clearPromptTextareas()
    return
  }

  selectedThemeInput.value = pack.themeName || ''
  uploadTagsInput.value = Array.isArray(pack.keywords) ? pack.keywords.join(', ') : ''
  promptFields.jigsaw.value = pack.prompts?.jigsaw || ''
  promptFields.slider.value = pack.prompts?.slider || ''
  promptFields.swap.value = pack.prompts?.swap || ''
  promptFields.polygram.value = pack.prompts?.polygram || ''
}

passwordInput.addEventListener('input', syncPasswordIntoForm)
syncPasswordIntoForm()
clearExistingFileMeta()
applyDateModeUi()

generateBtn.addEventListener('click', async () => {
  const password = passwordInput.value.trim()
  if (!password) {
    setStatus('Enter admin password before generating prompts.', 'error')
    return
  }

  generateBtn.disabled = true
  copyPackBtn.disabled = true
  setStatus('Generating daily prompts...', 'note')

  try {
    const response = await fetch(apiUrl('/api/admin/prompts/generate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    const payload = await response.json()
    if (!response.ok) {
      setStatus(payload.error || 'Prompt generation failed.', 'error')
      promptPack = null
      clearPromptTextareas()
      return
    }

    const packs = Array.isArray(payload.prompts) ? payload.prompts : []
    const firstPack = packs[0] || null
    if (!firstPack) {
      setStatus('No prompts were returned.', 'error')
      promptPack = null
      clearPromptTextareas()
      return
    }

    promptPack = firstPack
    renderPromptPack(firstPack)
    copyPackBtn.disabled = false
    setStatus('Daily prompts ready. For each type: copy prompt -> generate image -> upload image.', 'ok')
  } catch (error) {
    setStatus('Network error while generating prompts.', 'error')
    promptPack = null
    clearPromptTextareas()
  } finally {
    generateBtn.disabled = false
  }
})

prevDayBtn.addEventListener('click', () => shiftDate(-1))
nextDayBtn.addEventListener('click', () => shiftDate(1))
loadDateBtn.addEventListener('click', loadDateDetails)
nextEmptyBtn.addEventListener('click', jumpToNextEmptyDate)
dateInput.addEventListener('change', loadDateDetails)

copyPackBtn.addEventListener('click', async () => {
  if (!promptPack) {
    setStatus('Generate daily prompts before copying.', 'error')
    return
  }

  const combined = [
    'DAILY PROMPTS',
    `Label: ${promptPack.themeName || ''}`,
    `Tags: ${Array.isArray(promptPack.keywords) ? promptPack.keywords.join(', ') : ''}`,
    '',
    'JIGSAW PROMPT:',
    promptPack.prompts?.jigsaw || '',
    '',
    'SLIDER PROMPT:',
    promptPack.prompts?.slider || '',
    '',
    'SWAP PROMPT:',
    promptPack.prompts?.swap || '',
    '',
    'POLYGRAM PROMPT:',
    promptPack.prompts?.polygram || '',
  ].join('\n')

  await copyText(combined, 'All prompts')
})

document.querySelectorAll('.copy-btn').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = button.getAttribute('data-target')
    if (!target) {
      return
    }
    const field = document.getElementById(target)
    if (!field) {
      return
    }
    const label = button.parentElement?.querySelector('h3')?.textContent || 'Prompt'
    await copyText(field.value, label)
  })
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  const password = passwordInput.value.trim()
  if (!password) {
    setStatus('Enter admin password before upload.', 'error')
    return
  }
  syncPasswordIntoForm()

  submitBtn.disabled = true
  setStatus('Saving puzzle details...', 'note')

  try {
    const formData = new FormData(form)
    for (const category of CATEGORIES) {
      const file = formData.get(category)
      if (file instanceof File && file.size > 0) {
        const jpegFile = await convertImageFileToJpeg(file)
        formData.set(category, jpegFile, jpegFile.name)
      } else {
        formData.delete(category)
      }
    }

    const response = await fetch(apiUrl('/api/admin/puzzles'), {
      method: 'POST',
      body: formData,
    })

    const payload = await response.json()
    if (!response.ok) {
      setStatus(payload.error || 'Unable to save puzzle details.', 'error')
      return
    }

    const generatedLabel = payload.generatedTheme ? ` Auto-generated label: ${payload.generatedTheme}.` : ''
    isExistingDate = true
    applyDateModeUi()
    setRecordState(`Date ${payload.puzzle?.date || dateInput.value} exists and can be edited.`, 'existing')
    renderLoadedPuzzle(payload.puzzle || null)
    for (const category of CATEGORIES) {
      const input = fileInputs[category]
      if (input) {
        input.value = ''
      }
    }
    setStatus(`${payload.message || 'Puzzle details saved.'}${generatedLabel}`, 'ok')
  } catch (error) {
    setStatus('Network error while saving puzzle details.', 'error')
  } finally {
    submitBtn.disabled = false
  }
})

loadDateDetails()

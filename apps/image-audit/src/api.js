import { ORIGIN } from './config.js'

let sessionCookie = null

export async function login(password) {
  const res = await fetch(`${ORIGIN}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) throw new Error(`Login failed: ${res.status}`)
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) {
    const match = setCookie.match(/xef_admin_session=([^;]+)/)
    if (match) sessionCookie = match[1]
  }
  const body = await res.json()
  if (!body.authenticated) throw new Error('Login rejected — bad password')
  return body
}

function authHeaders() {
  const h = {}
  if (sessionCookie) h['Cookie'] = `xef_admin_session=${sessionCookie}`
  return h
}

export async function fetchPuzzle(date) {
  const res = await fetch(`${ORIGIN}/api/puzzles/${date}`, {
    headers: authHeaders(),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Fetch puzzle ${date}: ${res.status}`)
  return res.json()
}

export async function fetchOverview(from, days = 60) {
  const res = await fetch(
    `${ORIGIN}/api/admin/puzzles/overview?from=${from}&days=${days}`,
    { headers: authHeaders() }
  )
  if (!res.ok) throw new Error(`Fetch overview: ${res.status}`)
  return res.json()
}

export async function fetchImage(imageUrl) {
  const url = imageUrl.startsWith('http') ? imageUrl : `${ORIGIN}${imageUrl}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch image: ${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

export async function submitRegeneration(category, prompt, date) {
  const res = await fetch(`${ORIGIN}/api/admin/generate-images/single`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({
      category,
      prompt: prompt + '\n\nCritical: the image must be full-bleed with no borders, frames, or vignettes. It must contain zero text, numbers, letters, watermarks, or signatures.',
      theme: category,
      keywords: [],
      date,
      force: true,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Regen ${category} for ${date}: ${res.status} — ${text}`)
  }
  return res.json()
}

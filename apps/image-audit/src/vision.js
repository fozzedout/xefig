import { LM_STUDIO_URL, VISION_MODEL } from './config.js'

const EVAL_PROMPT = `You are an image quality checker for a puzzle game. Each puzzle image should be a clean, full-bleed photograph or illustration.

Examine this image carefully and check for:

1. BORDERS AND FRAMING: The image must appear as a full-bleed capture of the scene. Any elements added around the artwork—such as digital picture frames, decorative matting, uniform colored strips, or artificial vignettes that separate the content from the edge—will result in a fail. HOWEVER, this rule makes an exception for structural and natural environmental features. If the composition includes visible architectural structures (tunnels, arches, cave mouths, windows, etc.) that are intrinsic to the depicted scene and establish the setting's physical boundaries (e.g., looking out of a tunnel), these elements are considered part of the artwork and are NOT defects.
2. TEXT: Any visible text must be assessed for its origin. Text is acceptable ONLY if it appears as an integral, natural part of the depicted environment, such as carved inscriptions on stone, graffiti, or signage that looks physically mounted within the scene. Failure will occur due to any text that reads like metadata, branding, or annotation. This includes, but is not limited to: watermarks, logos (even if subtle), visible titles/captions placed outside of structural elements, modern label stickers, digital signatures, and usernames.

Respond with ONLY a JSON object in this exact format:
{"pass": true}
or
{"pass": false, "reason": "brief description of the defect"}`

export async function evaluateImage(imageBuffer) {
  const base64 = imageBuffer.toString('base64')

  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: EVAL_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
          ],
        },
      ],
      max_tokens: 2048,
      temperature: 0,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`LM Studio error ${res.status}: ${text}`)
  }

  const data = await res.json()
  const reply = (data.choices?.[0]?.message?.content ?? '').trim()

  const jsonMatch = reply.match(/\{[^}]+\}/)
  if (!jsonMatch) {
    console.warn('  Could not parse vision response:', reply.slice(0, 200))
    return { pass: true, raw: reply }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return { pass: parsed.pass !== false, reason: parsed.reason, raw: reply }
  } catch {
    console.warn('  JSON parse failed:', jsonMatch[0])
    return { pass: true, raw: reply }
  }
}

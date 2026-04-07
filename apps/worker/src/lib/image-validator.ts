import type { PuzzleCategory } from '../types'

const VALIDATION_MODEL = '@cf/google/gemma-4-26b-a4b-it'

const VALIDATION_PROMPT = `You are an image quality checker for a puzzle game. Examine this image and check for these defects:

1. TEXT: Any visible text, numbers, letters, labels, watermarks, signatures, captions, or titles anywhere in the image.
2. BORDERS: Any decorative borders, frames, vignettes, or edges that are not part of the scene itself.
3. UI ELEMENTS: Any buttons, icons, overlays, or interface elements.

Respond with ONLY a JSON object in this exact format, nothing else:
{"pass": true}
or
{"pass": false, "reason": "brief description of the defect"}

If the image is clean with none of the above defects, respond {"pass": true}.
Be strict — even small text or thin borders should fail.`

export type ValidationResult = {
  pass: boolean
  reason?: string
}

export async function validateGeneratedImage(
  ai: Ai,
  imageBytes: Uint8Array,
  _category: PuzzleCategory,
): Promise<ValidationResult> {
  // Convert image bytes to base64 data URL for the vision model
  const base64 = uint8ArrayToBase64(imageBytes)
  const dataUrl = `data:image/png;base64,${base64}`

  try {
    const response = await ai.run(VALIDATION_MODEL, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VALIDATION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      max_tokens: 100,
      temperature: 0,
    }) as { response?: string }

    const text = (response.response ?? '').trim()

    // Extract JSON from response (model may wrap it in markdown)
    const jsonMatch = text.match(/\{[^}]+\}/)
    if (!jsonMatch) {
      // If we can't parse the response, let it through rather than block
      console.warn('Image validation: could not parse response:', text)
      return { pass: true }
    }

    const parsed = JSON.parse(jsonMatch[0]) as { pass?: boolean; reason?: string }
    return {
      pass: parsed.pass !== false,
      reason: parsed.reason,
    }
  } catch (error) {
    // Validation failure should not block the pipeline
    console.error('Image validation error:', error)
    return { pass: true }
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

import { CATEGORIES, type PromptHistoryItem, type PromptPack, type PuzzleCategory } from '../types'

const PROMPT_HISTORY_KEY = 'prompt-history:v1'
const PROMPT_HISTORY_LIMIT = 260
const MIN_DESCRIPTOR_POOL_SIZE = 100
const DESCRIPTORS_PER_PACK = 10

const DESCRIPTOR_POOL = [
  'floating market at sunrise',
  'clockwork tower interior',
  'bioluminescent forest clearing',
  'desert observatory ruins',
  'rain-soaked neon alley',
  'glacier cave sanctuary',
  'coral reef transit hub',
  'cliffside monastery bridge',
  'retro arcade boulevard',
  'sky island greenhouse',
  'ancient library atrium',
  'volcanic orchard terraces',
  'festival harbor promenade',
  'mountain rail station',
  'submerged cathedral nave',
  'glass foundry workshop',
  'tea house by waterfall',
  'tidal wind farm coast',
  'lunar dockyard gantries',
  'sunken palace courtyard',
  'misty pine valley',
  'tropical storm horizon',
  'spring blossom avenue',
  'winter dawn stillness',
  'golden hour sunlight',
  'moonlit reflections',
  'dramatic thunderclouds',
  'soft overcast lighting',
  'crisp desert air',
  'after-rain shimmer',
  'warm tungsten glow',
  'cool cyan shadows',
  'amber rim light',
  'dappled canopy light',
  'high contrast lighting',
  'diffused cinematic haze',
  'subsurface underwater rays',
  'volumetric god rays',
  'silhouette backlighting',
  'low key lighting',
  'uplifting adventurous mood',
  'cozy nostalgic mood',
  'mysterious tense mood',
  'playful whimsical mood',
  'serene meditative mood',
  'heroic epic mood',
  'dreamlike surreal mood',
  'hopeful optimistic mood',
  'moody noir tone',
  'bright celebratory tone',
  'stylized illustration',
  'high detail concept art',
  'matte painting finish',
  'storybook painting style',
  'watercolor wash texture',
  'ink linework accents',
  'gouache brush strokes',
  'oil paint texture',
  'clean vector style',
  'isometric scene design',
  'tileable visual rhythm',
  'clear foreground middle background',
  'strong depth perspective',
  'subject placement variety',
  'rule of thirds framing',
  'symmetrical composition',
  'diagonal leading lines',
  'wide panoramic framing',
  'overhead birds-eye angle',
  'low angle grandeur',
  'teal and amber palette',
  'indigo and coral palette',
  'sage and copper palette',
  'cobalt and gold palette',
  'rose and charcoal palette',
  'emerald and cream palette',
  'mint and rust palette',
  'sand and ultramarine palette',
  'violet and lime accents',
  'monochrome with accent red',
  'intricate architectural detail',
  'ornate mechanical details',
  'moss-covered stone textures',
  'weathered brass surfaces',
  'polished marble floors',
  'rough volcanic rock',
  'wet cobblestone reflections',
  'frosted glass highlights',
  'handmade ceramic elements',
  'woven fabric details',
  'gentle river movement',
  'drifting lanterns',
  'falling petals',
  'wind-swept banners',
  'swirling fog layers',
  'sparkling dust motes',
  'distant mountain silhouettes',
  'foreground depth elements',
  'balanced negative space',
  'readable large shapes',
  'clear shape separation',
  'high micro-contrast',
  'smooth gradient transitions',
  'subtle film grain',
  'clean polished rendering',
  'clean finish',
  'futuristic retro fusion',
  'ancient technology motif',
  'solar-punk infrastructure',
  'fantasy realism blend',
  'art deco geometry',
  'brutalist forms',
  'organic curved structures',
  'floating architecture',
  'hanging garden pathways',
  'suspended cable bridges',
  'layered terrace cityscape',
  'spiral stair landmarks',
  'arched colonnade corridors',
  'market stall clusters',
  'observatory lens arrays',
  'rail track vanishing point',
  'harbor crane silhouettes',
  'cloud sea backdrop',
  'aurora sky ribbons',
  'starlit twilight gradient',
  'bright midday clarity',
  'sunset magenta horizon',
  'pre-dawn blue tones',
  'mist and rain droplets',
  'dry heat shimmer',
  'fresh snowfall powder',
  'stormy ocean spray',
  'tranquil lake mirror',
  'clear object spacing',
  'distinct color zoning',
  'varied points of interest',
  'visually varied sub-regions',
  'cohesive narrative scene',
  'wildlife close-up portrait',
  'flock of birds in motion',
  'fox in snowy woodland',
  'wolf pack at dusk',
  'jaguar in rainforest shade',
  'elephants at watering hole',
  'whale breaching ocean surface',
  'dolphins in crystal surf',
  'jellyfish bloom underwater',
  'owl in moonlit branches',
  'butterfly macro on wildflower',
  'dragonfly wing macro detail',
  'koi pond surface ripples',
  'reef fish color burst',
  'farmyard morning routine',
  'street market portrait moment',
  'cozy kitchen still life',
  'workbench tools still life',
  'vintage camera close-up',
  'mechanical watch macro gears',
  'weathered doorway textures',
  'ceramic pottery shelf study',
  'bookshop corner ambiance',
  'train cabin interior scene',
  'road trip desert stop',
  'coastal village rooftops',
  'foggy moorland trail',
  'savanna grassland horizon',
  'jungle canopy sunlight',
  'volcanic shoreline basalt columns',
  'iceberg field at noon',
  'carnival parade motion blur',
  'skate park action moment',
  'ballroom dance freeze moment',
  'abstract fluid ink marbling',
  'geometric layered abstract style',
  'minimal still-life composition',
  'maximalist color explosion',
] as const

const CATEGORY_PROMPT_INTENTS: Record<
  PuzzleCategory,
  {
    title: string
    composition: string
    qualityTarget: string
  }
> = {
  jigsaw: {
    title: 'Jigsaw',
    composition:
      'Allow any subject direction (scenery, wildlife, architecture, objects, daily life, or abstract) with broad visual variety throughout the image.',
    qualityTarget:
      'Favor rich texture variety and many recognizable sub-regions with strong visual distinction.',
  },
  slider: {
    title: 'Slider',
    composition:
      'Allow any subject direction (scenery, landmarks, animals, objects, or abstract) while keeping directional flow readable across the full image.',
    qualityTarget:
      'Favor clean visual progression and clear continuity cues so position changes are readable.',
  },
  swap: {
    title: 'Swap',
    composition:
      'Use one unified image with distinct in-image regions, varied objects, and crisp separation between neighboring areas.',
    qualityTarget:
      'Favor high local contrast and clear region boundaries within a single coherent image.',
  },
  polygram: {
    title: 'Polygram',
    composition:
      'Allow any subject direction but emphasize bold silhouettes, simple shape clusters, and clear figure-ground separation.',
    qualityTarget:
      'Favor readable geometry and strong contour language for shape-based recognition.',
  },
}

const PROMPT_LEAD_TEMPLATES = [
  'Creative direction:',
  'Art direction:',
  'Visual brief:',
  'Scene direction:',
  'Image direction:',
] as const

const PROMPT_QUALITY_TEMPLATES = [
  'Quality target: {quality}',
  'Quality guidance: {quality}',
  'Quality focus: {quality}',
  'Rendering target: {quality}',
] as const

const PROMPT_OUTPUT_TEMPLATES = [
  'Output requirements: single image, landscape 4:3, high detail, coherent lighting, continuous composition.',
  'Output format: one image only, 4:3 landscape format, strong detail clarity, coherent lighting, continuous composition.',
  'Final output: single 4:3 landscape image with crisp detail, consistent lighting, and a continuous scene.',
  'Deliver one landscape 4:3 image with high detail, clean contours, and stable lighting continuity.',
] as const

const PROMPT_COHERENCE_TEMPLATES = [
  'Compose one cohesive moment in one continuous environment with one consistent visual style.',
  'Keep the image unified as a single scene with consistent style and continuous spatial logic.',
  'Treat this as one coherent image, not multiple separate concepts.',
  'Build one continuous visual narrative with a single unified composition.',
] as const

const PROMPT_SENTENCE_ORDERS = [
  [0, 1, 2, 3, 4],
  [1, 0, 2, 3, 4],
  [0, 2, 1, 3, 4],
  [1, 2, 0, 3, 4],
] as const

export async function generatePromptPacks(kv: KVNamespace, count: number): Promise<PromptPack[]> {
  const history = await getPromptHistory(kv)
  const packs: PromptPack[] = []

  for (let index = 0; index < count; index += 1) {
    const pack = buildPromptPack(history)
    packs.push(pack)
  }

  await kv.put(PROMPT_HISTORY_KEY, JSON.stringify(history.slice(-PROMPT_HISTORY_LIMIT)))
  return packs
}

async function getPromptHistory(kv: KVNamespace): Promise<PromptHistoryItem[]> {
  const raw = await kv.get(PROMPT_HISTORY_KEY)
  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    const normalized = parsed
      .map((entry) => normalizePromptHistoryItem(entry))
      .filter((entry): entry is PromptHistoryItem => entry !== null)
    return normalized
  } catch {
    return []
  }
}

function buildPromptPack(history: PromptHistoryItem[]): PromptPack {
  if (DESCRIPTOR_POOL.length < MIN_DESCRIPTOR_POOL_SIZE) {
    throw new Error(`Descriptor pool must contain at least ${MIN_DESCRIPTOR_POOL_SIZE} entries.`)
  }

  const recent = history.slice(-PROMPT_HISTORY_LIMIT)
  const usedInPack = new Set<string>()
  const descriptorsByCategory = {} as Record<PuzzleCategory, string[]>

  for (const category of CATEGORIES) {
    const descriptors = pickDistinctDescriptors(
      DESCRIPTOR_POOL,
      recent,
      DESCRIPTORS_PER_PACK,
      usedInPack,
    )
    descriptorsByCategory[category] = descriptors
    for (const descriptor of descriptors) {
      usedInPack.add(descriptor)
    }
  }

  const jigsawDescriptors = descriptorsByCategory.jigsaw
  const keywords = [...usedInPack].slice(0, 12)
  const themeSubject = jigsawDescriptors[0] ?? 'daily scene'
  const themeColor = jigsawDescriptors[1] ?? 'wide variety'
  const themeName = `${capitalizeWords(themeSubject)} - ${capitalizeWords(themeColor)}`

  const pack: PromptPack = {
    themeName,
    keywords,
    prompts: {
      jigsaw: buildImagePrompt('jigsaw', descriptorsByCategory.jigsaw),
      slider: buildImagePrompt('slider', descriptorsByCategory.slider),
      swap: buildImagePrompt('swap', descriptorsByCategory.swap),
      polygram: buildImagePrompt('polygram', descriptorsByCategory.polygram),
    },
  }

  history.push({
    descriptors: [...usedInPack],
    createdAt: new Date().toISOString(),
  })

  return pack
}

function buildImagePrompt(category: PuzzleCategory, descriptors: string[]): string {
  const intent = CATEGORY_PROMPT_INTENTS[category]
  const randomized = shuffleCopy(descriptors)
  const primaryDescriptor = randomized[0] || 'visually distinctive subject'
  const supportingDescriptors = randomized.slice(1, 4)
  const descriptorText = supportingDescriptors.join(', ')
  const lead = `${pickRandom(PROMPT_LEAD_TEMPLATES)} ${intent.composition}`
  const descriptorLine =
    supportingDescriptors.length > 0
      ? `Primary cue: ${primaryDescriptor}. Supporting cues: ${descriptorText}.`
      : `Primary cue: ${primaryDescriptor}.`
  const qualityLine = pickRandom(PROMPT_QUALITY_TEMPLATES).replace('{quality}', intent.qualityTarget)
  const outputLine = pickRandom(PROMPT_OUTPUT_TEMPLATES)
  const coherenceLine = pickRandom(PROMPT_COHERENCE_TEMPLATES)
  const lines = [lead, descriptorLine, qualityLine, outputLine, coherenceLine]
  const order = pickRandom(PROMPT_SENTENCE_ORDERS)

  return order.map((index) => lines[index]).join(' ')
}

function normalizePromptHistoryItem(raw: unknown): PromptHistoryItem | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }

  const candidate = raw as {
    descriptors?: unknown
    createdAt?: unknown
    subject?: unknown
    setting?: unknown
    mood?: unknown
    style?: unknown
    palette?: unknown
  }

  if (Array.isArray(candidate.descriptors)) {
    const nextDescriptors = candidate.descriptors
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .slice(0, DESCRIPTORS_PER_PACK)

    if (nextDescriptors.length > 0) {
      return {
        descriptors: [...new Set(nextDescriptors)],
        createdAt:
          typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      }
    }
  }

  const legacyDescriptors = [
    candidate.subject,
    candidate.setting,
    candidate.mood,
    candidate.style,
    candidate.palette,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())

  if (legacyDescriptors.length === 0) {
    return null
  }

  return {
    descriptors: [...new Set(legacyDescriptors)],
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
  }
}

function pickDistinctDescriptors(
  pool: readonly string[],
  recent: PromptHistoryItem[],
  count: number,
  excluded = new Set<string>(),
): string[] {
  const counts = new Map<string, number>()
  for (const item of recent) {
    for (const descriptor of item.descriptors) {
      counts.set(descriptor, (counts.get(descriptor) || 0) + 1)
    }
  }

  const sourcePool = pool.filter((descriptor) => !excluded.has(descriptor))
  const workingPool = sourcePool.length >= count ? sourcePool : [...pool]

  const scored = [...workingPool]
    .map((descriptor) => ({
      descriptor,
      seen: counts.get(descriptor) || 0,
      tieBreak: Math.random(),
    }))
    .sort((a, b) => {
      if (a.seen !== b.seen) {
        return a.seen - b.seen
      }
      return a.tieBreak - b.tieBreak
    })

  const targetCount = Math.max(1, Math.min(count, workingPool.length))
  const rarityWindowSize = Math.min(scored.length, Math.max(targetCount * 8, 60))
  const rarityWindow = scored.slice(0, rarityWindowSize).map((entry) => entry.descriptor)
  const picks: string[] = []

  while (picks.length < targetCount && rarityWindow.length > 0) {
    const index = Math.floor(Math.random() * rarityWindow.length)
    const [pick] = rarityWindow.splice(index, 1)
    if (pick) {
      picks.push(pick)
    }
  }

  if (picks.length >= targetCount) {
    return picks
  }

  const fallback = workingPool.filter((descriptor) => !picks.includes(descriptor))
  while (picks.length < targetCount && fallback.length > 0) {
    const index = Math.floor(Math.random() * fallback.length)
    const [pick] = fallback.splice(index, 1)
    if (pick) {
      picks.push(pick)
    }
  }

  return picks
}

function capitalizeWords(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase())
}

function pickRandom<T>(values: readonly T[]): T {
  const index = Math.floor(Math.random() * values.length)
  return values[index] as T
}

function shuffleCopy<T>(values: readonly T[]): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]]
  }
  return copy
}

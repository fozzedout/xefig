import { CATEGORIES, type PromptHistoryItem, type PromptPack, type PuzzleCategory } from '../types'

const PROMPT_HISTORY_KEY = 'prompt-history:v1'
const PROMPT_HISTORY_LIMIT = 260

// One descriptor is picked per role per prompt, so DESCRIPTORS_PER_PACK === ROLE count.
const ROLES = ['concept', 'location', 'state', 'lighting', 'mood', 'style', 'palette', 'camera'] as const
type DescriptorRole = (typeof ROLES)[number]
const DESCRIPTORS_PER_PACK = ROLES.length

// ---------------------------------------------------------------------------
// Descriptor pool — organised by role.
// Used by all puzzle categories. To expand variety, add entries to any role slot.
// ---------------------------------------------------------------------------

const DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  concept: [
    'clockwork', 'observatory', 'market', 'library', 'foundry', 'aqueduct', 'lighthouse', 
    'cathedral', 'workshop', 'greenhouse', 'arcade', 'monastery', 'terrace', 'promenade', 
    'harbor', 'station', 'shrine', 'temple', 'palace', 'courtyard', 'plaza', 'boulevard', 
    'dockyard', 'gantries', 'orchard', 'railway', 'bridge', 'monolith', 'obelisk', 
    'pyramid', 'statue', 'airship', 'sanctuary', 'atrium', 'fountain', 'garden',
    'fox', 'wolf', 'jaguar', 'elephant', 'whale', 'dolphin', 'jellyfish', 'owl', 'koi',
    'parade', 'skate park', 'ballroom', 'still-life', 'abstract ink', 'fluid marbling',
    'waterfall', 'wind farm', 'solar array', 'canyon', 'glacier', 'reef', 'oasis',
    'staircase', 'colonnade', 'sequestration hub', 'transit node', 'vault', 'archives'
  ],

  location: [
    'ruins', 'tower', 'alley', 'forest', 'cave', 'mountain', 'valley', 'coast', 'island', 
    'cliffs', 'gorge', 'canyon', 'desert', 'savanna', 'jungle', 'tundra', 'glacier', 
    'village', 'city', 'rooftops', 'sky', 'underwater', 'lunar', 'nebula', 'void', 
    'abyss', 'cavern', 'meadow', 'swamp', 'marsh', 'delta', 'fjord', 'plateau', 
    'mesa', 'volcano', 'observatory', 'sanctuary', 'outpost', 'stronghold'
  ],

  state: [
    'neon', 'floating', 'submerged', 'volcanic', 'bioluminescent', 'ancient', 'retro', 
    'futuristic', 'industrial', 'organic', 'geometric', 'maximalist', 'minimalist', 
    'overgrown', 'frozen', 'burning', 'steampunk', 'cyberpunk', 'solarpunk', 'fantasy', 
    'mythological', 'ethereal', 'surreal', 'mystical', 'abandoned', 'decaying', 
    'pristine', 'lush', 'barren', 'stormy', 'serene', 'vibrant', 'monochrome',
    'misty', 'shimmering', 'clockwork', 'crystalline', 'decaying', 'ossified'
  ],

  lighting: [
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
    'cloud sea backdrop',
  ],

  mood: [
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
  ],

  style: [
    'stylized illustration',
    'high detail concept art',
    'matte painting finish',
    'storybook painting style',
    'watercolor wash texture',
    'heavy linework accents',
    'gouache brush strokes',
    'oil paint texture',
    'clean vector style',
    'isometric scene design',
    'futuristic retro fusion',
    'ancient technology motif',
    'solar-punk infrastructure',
    'fantasy realism blend',
    'art deco geometry',
    'brutalist forms',
    'organic curved structures',
    'geometric layered abstract style',
    'maximalist color explosion',
  ],

  palette: [
    'teal and amber as dominant tones with natural colour variation throughout',
    'indigo and coral as dominant tones with natural colour variation throughout',
    'sage and copper as dominant tones with natural colour variation throughout',
    'cobalt and gold as dominant tones with natural colour variation throughout',
    'rose and charcoal as dominant tones with natural colour variation throughout',
    'emerald and cream as dominant tones with natural colour variation throughout',
    'mint and rust as dominant tones with natural colour variation throughout',
    'sand and ultramarine as dominant tones with natural colour variation throughout',
    'violet and lime as dominant tones with natural colour variation throughout',
    'monochrome with accent red as dominant tones with natural colour variation throughout',
  ],

  camera: [
    'wide-angle establishing shot',
    "low-angle hero perspective",
    "overhead bird's-eye view",
    'close-up macro shot',
    'medium shot with foreground framing',
    "worm's-eye upward angle",
    'Dutch tilt dynamic angle',
    'symmetrical frontal framing',
    'over-the-shoulder depth shot',
    'panoramic wide shot',
    'intimate eye-level shot',
    'dramatic low horizon shot',
  ],
}

// ---------------------------------------------------------------------------
// Polygram descriptor pool — removed as it is now unified with the main pool.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimum pool size validation — checked per role at startup.
// ---------------------------------------------------------------------------

const MIN_ROLE_POOL_SIZE: Record<DescriptorRole, number> = {
  concept: 20,
  location: 20,
  state: 20,
  lighting: 10,
  mood: 6,
  style: 10,
  palette: 6,
  camera: 6,
}

const MIN_POLYGRAM_POOL_SIZE: Record<DescriptorRole, number> = {
  setting: 20,
  lighting: 6,
  mood: 6,
  style: 10,
  palette: 6,
  camera: 6,
}

// ---------------------------------------------------------------------------
// Prompt template constants
// ---------------------------------------------------------------------------

// Jigsaw, slider, and swap are all "rich scene" puzzles — the mechanic
// differences are handled by the game engine, not the image. A single shared
// intent lets the descriptor combinations carry all the creative variation.
const SCENE_PUZZLE_INTENT = {
  composition:
    'Depict a single continuous scene with strong visual variety throughout — any subject direction is welcome: landscape, wildlife, architecture, objects, daily life, or abstract.',
  qualityTarget:
    'Every region of the image should be filled with rich texture, fine surface detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation between them. Maintain natural colour variety throughout — secondary and environmental colours should remain visible beneath the dominant palette.',
} as const

const CATEGORY_PROMPT_INTENTS: Record<
  PuzzleCategory,
  {
    title: string
    composition: string
    qualityTarget: string
  }
> = {
  jigsaw: { title: 'Jigsaw', ...SCENE_PUZZLE_INTENT },
  slider: { title: 'Slider', ...SCENE_PUZZLE_INTENT },
  swap:   { title: 'Swap',   ...SCENE_PUZZLE_INTENT },
  polygram: {
    title: 'Polygram', ...SCENE_PUZZLE_INTENT },
}

// Step-by-step prompt structure per Google best practices:
// Each section builds on the last — subject/context first, then environment,
// then render instructions. Order is fixed for clarity, not shuffled.

const PROMPT_CONTEXT_TEMPLATES = [
  'Create a vivid, detailed illustration.',
  'Generate a vivid, detailed illustration.',
  'Produce a vivid, detailed illustration.',
] as const

const PROMPT_SUBJECT_TEMPLATES = [
  'First, establish the subject and scene: {composition}',
  'Begin with the subject and setting: {composition}',
  'Start by defining the scene: {composition}',
] as const

const PROMPT_DESCRIPTOR_INTRO_TEMPLATES = [
  'Then apply these visual properties:',
  'Next, apply the following properties:',
  'Apply these specific visual qualities:',
] as const

const PROMPT_QUALITY_TEMPLATES = [
  'Finally, ensure rendering quality: {quality}',
  'For the final render: {quality}',
  'Rendering requirement: {quality}',
] as const

const PROMPT_OUTPUT_TEMPLATES = [
  'Output: one landscape 4:3 image , fully edge-to-edge composition with no borders, frames, or vignettes.',
  'Deliver a single landscape 4:3 image . The composition must fill the full frame with no decorative borders or edges.',
  'Single 4:3 landscape image  only. Extend the scene to every edge — the composition should contain no frames, borders, or vignetting.',
] as const

// Polygram output templates reinforce orientation rather than edge-to-edge fill.
// "Edge-to-edge" is correct for scene puzzles but actively harmful for polygram
// because it encourages the model to crop the subject — removing the very
// perspective lines and vertical extent that anchor piece orientation.
const PROMPT_OUTPUT_TEMPLATES_POLYGRAM = [
  'Output: one landscape 4:3 image . The directional lines, shadows, and tonal gradient must be clearly readable across the whole image. No borders or frames. Use heavy line work, ink work, or a stained glass style to define shapes.',
  'Deliver a single landscape 4:3 image . Ensure perspective lines, cast shadows, and top-to-bottom tonal variation are strong and unambiguous throughout the full frame. No borders or frames. Use heavy line work, ink work, or a stained glass style to define shapes.',
  'Single 4:3 landscape image  only. The orientation cues — converging lines, directional shadows, vertical gradient — must be vivid and consistent across the entire composition. No borders or frames. Use heavy line work, ink work, or a stained glass style to define shapes.',
] as const

// ---------------------------------------------------------------------------
// A selected descriptor set — one value per role.
// ---------------------------------------------------------------------------

type DescriptorSet = Record<DescriptorRole, string>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generatePromptPacks(kv: KVNamespace, count: number): Promise<PromptPack[]> {
  validatePoolSizes()
  const history = await getPromptHistory(kv)
  const packs: PromptPack[] = []

  for (let index = 0; index < count; index += 1) {
    const pack = buildPromptPack(history)
    packs.push(pack)
  }

  await kv.put(PROMPT_HISTORY_KEY, JSON.stringify(history.slice(-PROMPT_HISTORY_LIMIT)))
  return packs
}

export async function generateSingleCategoryPrompt(
  kv: KVNamespace,
  category: PuzzleCategory,
): Promise<{ prompt: string; theme: string; keywords: string[] }> {
  validatePoolSizes()
  const history = await getPromptHistory(kv)
  const recent = history.slice(-PROMPT_HISTORY_LIMIT)

  const set = pickDescriptorSet(recent, new Set(), category)
  const details = buildCategoryPromptDetails(category, set)

  history.push({
    descriptors: [...new Set(Object.values(set))],
    createdAt: new Date().toISOString(),
  })
  await kv.put(PROMPT_HISTORY_KEY, JSON.stringify(history.slice(-PROMPT_HISTORY_LIMIT)))

  return details
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

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

    return parsed
      .map((entry) => normalizePromptHistoryItem(entry))
      .filter((entry): entry is PromptHistoryItem => entry !== null)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Pack builder
// ---------------------------------------------------------------------------

function buildPromptPack(history: PromptHistoryItem[]): PromptPack {
  const recent = history.slice(-PROMPT_HISTORY_LIMIT)

  // We pick a fresh descriptor set per puzzle category to maximise variety.
  // Each category gets its own independent setting, mood, style, etc.
  const descriptorSetsByCategory = {} as Record<PuzzleCategory, DescriptorSet>
  const usedInPack = new Set<string>()

  for (const category of CATEGORIES) {
    const set = pickDescriptorSet(recent, usedInPack, category)
    descriptorSetsByCategory[category] = set
    for (const value of Object.values(set)) {
      usedInPack.add(value)
    }
  }

  const pack: PromptPack = {
    // Per-category details
    categories: {
      jigsaw:   buildCategoryPromptDetails('jigsaw',   descriptorSetsByCategory.jigsaw),
      slider:   buildCategoryPromptDetails('slider',   descriptorSetsByCategory.slider),
      swap:     buildCategoryPromptDetails('swap',     descriptorSetsByCategory.swap),
      polygram: buildCategoryPromptDetails('polygram', descriptorSetsByCategory.polygram),
    },
  }

  history.push({
    descriptors: [...usedInPack],
    createdAt: new Date().toISOString(),
  })

  return pack
}

function buildCategoryPromptDetails(category: PuzzleCategory, set: DescriptorSet) {
  return {
    prompt: buildImagePrompt(category, set),
    theme: `${capitalizeWords(set.state)} ${capitalizeWords(set.concept)} ${capitalizeWords(set.location)} — ${capitalizeWords(set.mood)}`,
    keywords: [...new Set(Object.values(set))].map(v => v.trim()).filter(Boolean).slice(0, 12),
  }
}

// ---------------------------------------------------------------------------
// Prompt builder — assembles one prompt from a coherent DescriptorSet
// Step-by-step structure per Google best practices: context → subject →
// visual properties → quality → output format. Order is fixed, not shuffled,
// so each instruction builds clearly on the last.
// ---------------------------------------------------------------------------

function buildImagePrompt(category: PuzzleCategory, set: DescriptorSet): string {
  const intent = CATEGORY_PROMPT_INTENTS[category]

  // Step 1: context — tell the model the purpose of the image
  const contextLine = pickRandom(PROMPT_CONTEXT_TEMPLATES)

  // Step 2: subject — composition intent with camera framing
  const subjectLine = pickRandom(PROMPT_SUBJECT_TEMPLATES)
    .replace('{composition}', intent.composition)
    + ` Use a ${set.camera}.`

  // Step 3: visual properties — one specific value per role, clearly labelled
  const descriptorIntro = pickRandom(PROMPT_DESCRIPTOR_INTRO_TEMPLATES)
  const descriptorLine = [
    descriptorIntro,
    `concept: ${set.concept};`,
    `location: ${set.location};`,
    `state: ${set.state};`,
    `lighting: ${set.lighting};`,
    `mood: ${set.mood};`,
    `style: ${set.style};`,
    `colour palette: ${set.palette}.`,
  ].join(' ')

  // Step 4: quality target
  const qualityLine = pickRandom(PROMPT_QUALITY_TEMPLATES)
    .replace('{quality}', intent.qualityTarget)

  // Step 5: output format
  const outputLine = category === 'polygram'
    ? pickRandom(PROMPT_OUTPUT_TEMPLATES_POLYGRAM)
    : pickRandom(PROMPT_OUTPUT_TEMPLATES)

  return [contextLine, subjectLine, descriptorLine, qualityLine, outputLine].join(' ')
}

// ---------------------------------------------------------------------------
// Role-slot descriptor picker
// ---------------------------------------------------------------------------

// Pick one descriptor per role, preferring least-recently-used entries and
// avoiding anything already used elsewhere in this pack.
function pickDescriptorSet(
  recent: PromptHistoryItem[],
  excluded: Set<string>,
  _category: PuzzleCategory,
): DescriptorSet {
  const counts = buildUsageCounts(recent)
  const pool = DESCRIPTOR_POOL
  const set = {} as DescriptorSet

  for (const role of ROLES) {
    set[role] = pickOneDescriptor(pool[role], counts, excluded)
    excluded = new Set([...excluded, set[role]])
  }

  return set
}

function buildUsageCounts(recent: PromptHistoryItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of recent) {
    for (const descriptor of item.descriptors) {
      counts.set(descriptor, (counts.get(descriptor) ?? 0) + 1)
    }
  }
  return counts
}

function pickOneDescriptor(
  pool: readonly string[],
  counts: Map<string, number>,
  excluded: Set<string>,
): string {
  // Filter out anything already used in this pack. If that empties the pool,
  // fall back to the full pool so we never hard-fail.
  const available = pool.filter((d) => !excluded.has(d))
  const workingPool = available.length > 0 ? available : [...pool]

  // Score by usage frequency, shuffle within ties via a random tiebreaker.
  const scored = workingPool
    .map((descriptor) => ({
      descriptor,
      seen: counts.get(descriptor) ?? 0,
      tieBreak: Math.random(),
    }))
    .sort((a, b) => (a.seen !== b.seen ? a.seen - b.seen : a.tieBreak - b.tieBreak))

  // Sample from a rarity window (least-used candidates) rather than always
  // taking the single least-used entry — preserves non-determinism.
  const windowSize = Math.min(scored.length, Math.max(Math.ceil(workingPool.length * 0.4), 6))
  const window = scored.slice(0, windowSize)
  const pick = window[Math.floor(Math.random() * window.length)]

  return pick?.descriptor ?? workingPool[0]!
}

// ---------------------------------------------------------------------------
// Normalisation (supports both new role-keyed and legacy flat descriptor formats)
// ---------------------------------------------------------------------------

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
      .slice(0, DESCRIPTORS_PER_PACK * CATEGORIES.length)

    if (nextDescriptors.length > 0) {
      return {
        descriptors: [...new Set(nextDescriptors)],
        createdAt:
          typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      }
    }
  }

  // Legacy format: individual named fields
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
    createdAt:
      typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePoolSizes(): void {
  for (const role of ROLES) {
    const size = DESCRIPTOR_POOL[role].length
    const min = MIN_ROLE_POOL_SIZE[role]
    if (size < min) {
      throw new Error(
        `Descriptor pool for role "${role}" has ${size} entries but requires at least ${min}.`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalizeWords(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase())
}

function pickRandom<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)] as T
}

function shuffleCopy<T>(values: readonly T[]): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]]
  }
  return copy
}

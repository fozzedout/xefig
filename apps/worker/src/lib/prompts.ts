import { CATEGORIES, type PromptHistoryItem, type PromptPack, type PuzzleCategory } from '../types'

const PROMPT_HISTORY_KEY = 'prompt-history:v1'
const PROMPT_HISTORY_LIMIT = 260

// One descriptor is picked per role per prompt, so DESCRIPTORS_PER_PACK === ROLE count.
const ROLES = ['setting', 'lighting', 'mood', 'style', 'palette', 'camera'] as const
type DescriptorRole = (typeof ROLES)[number]
const DESCRIPTORS_PER_PACK = ROLES.length

// ---------------------------------------------------------------------------
// Descriptor pool — organised by role.
// To expand variety, add entries to any role slot. Every new entry multiplies
// combinatorial space with all entries in the other roles.
// ---------------------------------------------------------------------------

const DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  setting: [
    // Architecture / urban
    'floating market at sunrise',
    'clockwork tower interior',
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
    // Nature / landscape
    'bioluminescent forest clearing',
    'misty pine valley',
    'tropical storm horizon',
    'spring blossom avenue',
    'winter dawn stillness',
    'foggy moorland trail',
    'savanna grassland horizon',
    'jungle canopy sunlight',
    'volcanic shoreline basalt columns',
    'iceberg field at noon',
    'coastal village rooftops',
    'road trip desert stop',
    // Wildlife / life scenes
    'fox in snowy woodland',
    'wolf pack at dusk',
    'jaguar in rainforest shade',
    'elephants at watering hole',
    'whale breaching ocean surface',
    'dolphins in crystal surf',
    'jellyfish bloom underwater',
    'owl in moonlit branches',
    'koi pond surface ripples',
    'reef fish color burst',
    'farmyard morning routine',
    'street market portrait moment',
    'bookshop corner ambiance',
    'train cabin interior scene',
    // Abstract / action
    'carnival parade motion blur',
    'skate park action moment',
    'ballroom dance freeze moment',
    'abstract fluid ink marbling',
    'minimal still-life composition',
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
// Minimum pool size validation — checked per role at startup.
// ---------------------------------------------------------------------------

const MIN_ROLE_POOL_SIZE: Record<DescriptorRole, number> = {
  setting: 20,
  lighting: 10,
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
    'Every region of the image should be filled with rich texture, fine surface detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation between them.',
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
    title: 'Polygram',
    // Polygram pieces are rotated to the correct orientation. The outer
    // silhouette must be bold and readable, while the interior must be
    // dense with detail so every region looks distinct when rotated.
    composition:
      'Depict a single subject with a bold, immediately recognisable silhouette and a clear sense of orientation — animals, figures, vehicles, landmarks, and structured objects work especially well. Choose a subject whose interior is naturally filled with texture, markings, or structural detail.',
    qualityTarget:
      'The outer contour should be crisp and unambiguous. Every interior region should be packed with visible texture, fine detail, and tonal contrast — ensuring the full image surface is visually active with no large areas of uniform colour or tone.',
  },
}

// Step-by-step prompt structure per Google best practices:
// Each section builds on the last — subject/context first, then environment,
// then render instructions. Order is fixed for clarity, not shuffled.

const PROMPT_CONTEXT_TEMPLATES = [
  'Create a single image for use as a puzzle.',
  'Generate one image intended as a puzzle.',
  'Produce a single image to be used as a puzzle.',
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
  'Output: one landscape 4:3 image, fully edge-to-edge composition with no borders, frames, or vignettes.',
  'Deliver a single landscape 4:3 image. The composition must fill the full frame with no decorative borders or edges.',
  'Single 4:3 landscape image only. Extend the scene to every edge — the composition should contain no frames, borders, or vignetting.',
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

  // Pick a fresh descriptor set per puzzle category. Each category gets its
  // own independent role-slot draw so that e.g. the jigsaw and slider prompts
  // share no descriptors — maximising variety across the pack.
  const descriptorSetsByCategory = {} as Record<PuzzleCategory, DescriptorSet>
  const usedInPack = new Set<string>()

  for (const category of CATEGORIES) {
    const set = pickDescriptorSet(recent, usedInPack)
    descriptorSetsByCategory[category] = set
    for (const value of Object.values(set)) {
      usedInPack.add(value)
    }
  }

  const jigsawSet = descriptorSetsByCategory.jigsaw
  const themeName = `${capitalizeWords(jigsawSet.setting)} — ${capitalizeWords(jigsawSet.mood)}`
  const keywords = [...usedInPack].slice(0, 12)

  const pack: PromptPack = {
    themeName,
    keywords,
    prompts: {
      jigsaw: buildImagePrompt('jigsaw', descriptorSetsByCategory.jigsaw),
      slider: buildImagePrompt('slider', descriptorSetsByCategory.slider),
      swap: buildImagePrompt('swap', descriptorSetsByCategory.swap),
      polygram: buildImagePrompt('polygram', descriptorSetsByCategory.polygram),
    },
  }

  history.push({
    descriptors: [...usedInPack],
    createdAt: new Date().toISOString(),
  })

  return pack
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
    `setting: ${set.setting};`,
    `lighting: ${set.lighting};`,
    `mood: ${set.mood};`,
    `style: ${set.style};`,
    `colour palette: ${set.palette}.`,
  ].join(' ')

  // Step 4: quality target
  const qualityLine = pickRandom(PROMPT_QUALITY_TEMPLATES)
    .replace('{quality}', intent.qualityTarget)

  // Step 5: output format — edge-to-edge, no borders
  const outputLine = pickRandom(PROMPT_OUTPUT_TEMPLATES)

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
): DescriptorSet {
  const counts = buildUsageCounts(recent)
  const set = {} as DescriptorSet

  for (const role of ROLES) {
    set[role] = pickOneDescriptor(DESCRIPTOR_POOL[role], counts, excluded)
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

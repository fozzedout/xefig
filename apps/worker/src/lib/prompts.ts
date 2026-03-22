import { CATEGORIES, type PromptHistoryItem, type PromptPack, type PuzzleCategory } from '../types'

const PROMPT_HISTORY_KEY = 'prompt-history:v1'
const PROMPT_HISTORY_LIMIT = 260

// One descriptor is picked per role per prompt, so DESCRIPTORS_PER_PACK === ROLE count.
const ROLES = ['setting', 'lighting', 'mood', 'style', 'palette', 'camera'] as const
type DescriptorRole = (typeof ROLES)[number]
const DESCRIPTORS_PER_PACK = ROLES.length

// ---------------------------------------------------------------------------
// Descriptor pool — organised by role.
// Used by jigsaw, slider, and swap (rich scene puzzles).
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
// Polygram descriptor pool — purpose-built for single-subject silhouette images.
//
// Polygram puzzles require a SINGLE isolated subject against a clean background.
// The subject silhouette must be bold and immediately readable. Every descriptor
// here is chosen to reinforce that goal: subjects are singular and iconic,
// backgrounds are uncluttered, lighting separates subject from ground clearly,
// and camera angles show the full subject body without cropping key contours.
//
// Do NOT add busy scenes, crowds, action blur, or abstract compositions here —
// those belong in DESCRIPTOR_POOL for the scene-based puzzle types.
// ---------------------------------------------------------------------------

const POLYGRAM_DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  setting: [
    // Single animal subjects — iconic silhouettes, sparse surroundings
    'lone eagle soaring against open sky',
    'wolf standing alert on rocky ridge',
    'stag silhouetted on misty hilltop',
    'lion resting on flat sunlit ground',
    'bear standing upright on sparse tundra',
    'horse mid-gallop on open plain',
    'hawk perched on bare branch against sky',
    'fox sitting on snow-covered ground',
    'elephant standing on dry savanna earth',
    'whale breaching against clean horizon',
    'owl perched alone against moonlit sky',
    'leaping dolphin against clear ocean surface',
    'cheetah crouching on bare rock',
    'gorilla seated on open jungle floor',
    'bison standing on empty prairie',
    'hummingbird hovering against soft bokeh',
    'peacock displaying feathers on open ground',
    'crocodile resting on bare riverbank',
    'great white shark isolated in clear water',
    'octopus against clean dark ocean backdrop',
    // Single vehicle / object subjects
    'sailing ship isolated against clear horizon',
    'vintage motorcycle on empty road',
    'biplane against clean blue sky',
    'lighthouse standing alone on rocky coast',
    'hot air balloon against gradient sky',
    'old steam locomotive on open track',
    'classic sailing boat on calm flat water',
    'rocket on launch pad against clear sky',
  ],

  lighting: [
    // Lighting that separates subject from background cleanly
    'clean rim lighting with dark separation',
    'strong directional sidelight with crisp shadows',
    'golden hour backlight with subject separation',
    'diffused even studio light with no harsh shadows',
    'cool blue separation lighting against warm subject',
    'crisp overhead sunlight with hard ground shadow',
    'warm ambient glow with soft edge definition',
    'sharp sidelight casting long clean shadow',
    'soft overcast lighting with clear subject edges',
    'dramatic low sun with long separation shadow',
    'neutral grey sky diffused light',
    'clear bright midday clarity',
  ],

  mood: [
    'calm and focused mood',
    'bold and heroic mood',
    'serene and confident mood',
    'dramatic and powerful mood',
    'quiet and watchful mood',
    'majestic and composed mood',
    'tense and alert mood',
    'peaceful solitary mood',
  ],

  style: [
    'high detail concept art',
    'bold naturalistic illustration',
    'clean photorealistic rendering',
    'matte painting finish',
    'sharp wildlife illustration style',
    'detailed storybook painting style',
    'fantasy realism blend',
    'bold graphic illustration',
    'clean digital painting',
    'precise technical illustration',
    'rich oil paint texture',
    'detailed gouache brush strokes',
  ],

  palette: [
    // Shared with scene pool — all work well for single subjects
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
    // Angles that show the full subject body and preserve the outer contour
    'clean side profile shot showing full body',
    'symmetrical frontal framing showing full subject',
    'three-quarter angle view showing full body',
    'low-angle hero perspective showing full silhouette',
    'medium full-body framing with space around subject',
    'wide-angle shot with subject centred in frame',
    'intimate eye-level shot showing complete form',
    'slight elevated angle showing full body outline',
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
    title: 'Polygram',
    // Polygram pieces are rotated to the correct orientation. The image must
    // have a single bold subject with a crisp, unambiguous outer silhouette.
    // The background must be clean and simple so the contour reads at a glance.
    // The interior must be dense with detail so every region looks distinct
    // when the piece is rotated.
    composition:
      'Depict a SINGLE isolated subject — one animal, vehicle, or object — centred in the frame against a clean, uncluttered background. NO crowds, secondary subjects, busy scenes, or complex environments. The subject must have a bold, immediately recognisable outer silhouette with crisp edges. The background must remain simple — soft, blurred, or plain — so the subject contour reads clearly at a glance.',
    qualityTarget:
      'The outer contour of the subject must be sharp and high-contrast against the background. The interior of the subject should be packed with visible texture, fine markings, and tonal contrast — every interior region must look distinct and visually active. The background must stay visually simple with no competing detail. No large flat areas of uniform tone anywhere on the subject itself. Maintain natural colour variety within the subject.',
  },
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
  // Polygram draws from its own dedicated pool (POLYGRAM_DESCRIPTOR_POOL) and
  // does not share descriptors with the scene-based categories.
  const descriptorSetsByCategory = {} as Record<PuzzleCategory, DescriptorSet>
  const sceneUsedInPack = new Set<string>()
  const polygramUsedInPack = new Set<string>()

  for (const category of CATEGORIES) {
    if (category === 'polygram') {
      const set = pickDescriptorSet(recent, polygramUsedInPack, 'polygram')
      descriptorSetsByCategory[category] = set
      for (const value of Object.values(set)) {
        polygramUsedInPack.add(value)
      }
    } else {
      const set = pickDescriptorSet(recent, sceneUsedInPack, category)
      descriptorSetsByCategory[category] = set
      for (const value of Object.values(set)) {
        sceneUsedInPack.add(value)
      }
    }
  }

  const allUsed = new Set([...sceneUsedInPack, ...polygramUsedInPack])
  const jigsawSet = descriptorSetsByCategory.jigsaw
  const themeName = `${capitalizeWords(jigsawSet.setting)} — ${capitalizeWords(jigsawSet.mood)}`
  const keywords = [...sceneUsedInPack].slice(0, 12)

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
    descriptors: [...allUsed],
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
// Polygram draws from POLYGRAM_DESCRIPTOR_POOL; all other categories use DESCRIPTOR_POOL.
function pickDescriptorSet(
  recent: PromptHistoryItem[],
  excluded: Set<string>,
  category: PuzzleCategory,
): DescriptorSet {
  const counts = buildUsageCounts(recent)
  const pool = category === 'polygram' ? POLYGRAM_DESCRIPTOR_POOL : DESCRIPTOR_POOL
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
    const sceneSize = DESCRIPTOR_POOL[role].length
    const sceneMin = MIN_ROLE_POOL_SIZE[role]
    if (sceneSize < sceneMin) {
      throw new Error(
        `Descriptor pool for role "${role}" has ${sceneSize} entries but requires at least ${sceneMin}.`,
      )
    }

    const polygramSize = POLYGRAM_DESCRIPTOR_POOL[role].length
    const polygramMin = MIN_POLYGRAM_POOL_SIZE[role]
    if (polygramSize < polygramMin) {
      throw new Error(
        `Polygram descriptor pool for role "${role}" has ${polygramSize} entries but requires at least ${polygramMin}.`,
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

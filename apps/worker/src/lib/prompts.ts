import { CATEGORIES, type PromptHistoryItem, type PromptPack, type PuzzleCategory } from '../types'
import { ensurePuzzleTables, getPromptHistoryD1, appendPromptHistory } from './puzzle-db'

const PROMPT_HISTORY_LIMIT = 260

const ROLES = ['concept', 'location', 'state', 'lighting', 'mood', 'style', 'palette', 'camera'] as const
type DescriptorRole = (typeof ROLES)[number]

// ---------------------------------------------------------------------------
// Descriptor pool — organised by role.
// Used by all puzzle categories. To expand variety, add entries to any role slot.
// ---------------------------------------------------------------------------

const DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  concept: [
    // architecture & structures
    'clockwork', 'observatory', 'library', 'foundry', 'aqueduct', 'lighthouse',
    'cathedral', 'workshop', 'arcade', 'monastery', 'promenade', 'harbor',
    'station', 'shrine', 'temple', 'palace', 'courtyard', 'plaza', 'boulevard',
    'dockyard', 'orchard', 'railway', 'bridge', 'monolith', 'obelisk',
    'pyramid', 'statue', 'sanctuary', 'atrium', 'fountain', 'colonnade',
    'vault', 'amphitheatre', 'gatehouse', 'minaret', 'pagoda', 'ziggurat',
    'windmill', 'mill', 'barn', 'farmstead', 'boathouse', 'pier', 'jetty',
    'suspension bridge', 'viaduct', 'dam', 'lock gate', 'canal', 'wharf',
    'bell tower', 'cupola', 'dome', 'spire', 'battlement', 'drawbridge',
    'portcullis', 'rampart', 'keep', 'citadel', 'watchtower', 'bastion',
    // nature & geography
    'waterfall', 'canyon', 'glacier', 'reef', 'oasis', 'hot spring',
    'geyser', 'cenote', 'sinkhole', 'tide pool', 'kelp forest', 'mangrove',
    'bamboo grove', 'cherry blossom grove', 'lavender field', 'sunflower field',
    'rice terrace', 'vineyard', 'tea plantation', 'wildflower meadow',
    'aurora', 'thunderhead', 'supercell', 'rainbow', 'ice cave', 'sea arch',
    'sea stack', 'coral atoll', 'volcanic caldera', 'lava flow', 'basalt columns',
    'slot canyon', 'hoodoo formations', 'sand dunes', 'salt flat', 'petrified forest',
    // wildlife
    'fox', 'wolf', 'jaguar', 'elephant', 'whale', 'dolphin', 'jellyfish',
    'owl', 'koi', 'eagle', 'heron', 'flamingo', 'peacock', 'tiger',
    'snow leopard', 'red panda', 'orca', 'manta ray', 'sea turtle',
    'hummingbird', 'kingfisher', 'stag', 'bison', 'polar bear', 'lynx',
    'octopus', 'seahorse', 'butterfly swarm', 'starling murmuration',
    'bee colony', 'dragonfly', 'chameleon', 'pangolin', 'narwhal',
    // human activity & culture
    'market', 'parade', 'ballroom', 'carnival', 'regatta', 'lantern festival',
    'night bazaar', 'spice market', 'flower market', 'fish market',
    'street musicians', 'rooftop garden', 'reading room', 'apothecary',
    'blacksmith forge', 'pottery studio', 'weaving loom', 'glassblowing',
    'calligraphy', 'tea ceremony', 'harvest festival', 'bonfire gathering',
    // transport & machines
    'airship', 'galleon', 'steamship', 'narrowboat', 'gondola',
    'cable car', 'funicular', 'hot air balloon', 'biplane', 'locomotive',
    'tram', 'rickshaw', 'caravan', 'covered wagon',
    // abstract & artistic
    'still-life', 'abstract ink', 'fluid marbling', 'mosaic', 'stained glass',
    'tapestry', 'fresco', 'mandala', 'origami', 'kinetic sculpture',
    'light installation', 'paper lanterns', 'wind chimes',
  ],

  location: [
    'ruins', 'tower', 'alley', 'forest', 'cave', 'mountain', 'valley',
    'coast', 'island', 'cliffs', 'gorge', 'canyon', 'desert', 'savanna',
    'jungle', 'tundra', 'glacier', 'village', 'city', 'rooftops', 'sky',
    'underwater', 'lunar', 'nebula', 'cavern', 'meadow', 'swamp', 'delta',
    'fjord', 'plateau', 'mesa', 'volcano', 'outpost', 'stronghold',
    'archipelago', 'lagoon', 'estuary', 'wetlands', 'steppe', 'taiga',
    'rainforest canopy', 'cloud forest', 'alpine lake', 'mountain pass',
    'river bend', 'waterfront', 'harbor town', 'hilltop village',
    'cliff dwelling', 'floating village', 'terraced hillside', 'vineyard slope',
    'coastal path', 'sea cave', 'rocky shoreline', 'sandbar', 'tidal flat',
    'bamboo forest', 'birch grove', 'autumn woodland', 'misty highlands',
    'rolling hills', 'chalk cliffs', 'volcanic island', 'crater lake',
    'frozen lake', 'mountain ridge', 'ravine', 'grotto', 'cenote',
    'abandoned quarry', 'overgrown railway', 'sunken garden', 'walled garden',
    'courtyard garden', 'rooftop terrace', 'balcony overlook', 'bell tower view',
    'marketplace square', 'cobblestone street', 'lantern-lit alley',
    'canal district', 'old town', 'fishing village', 'mountain monastery',
    'desert oasis', 'palm grove', 'mangrove coast', 'coral shallows',
  ],

  state: [
    'neon', 'floating', 'submerged', 'volcanic', 'bioluminescent', 'ancient',
    'retro', 'futuristic', 'industrial', 'organic', 'geometric', 'maximalist',
    'minimalist', 'overgrown', 'frozen', 'burning', 'steampunk', 'cyberpunk',
    'solarpunk', 'fantasy', 'mythological', 'ethereal', 'surreal', 'mystical',
    'abandoned', 'pristine', 'lush', 'barren', 'stormy', 'serene', 'vibrant',
    'misty', 'shimmering', 'crystalline', 'ossified', 'weathered', 'mossy',
    'sun-bleached', 'rain-soaked', 'frost-covered', 'dew-laden', 'blooming',
    'autumnal', 'twilight', 'dawn-lit', 'moonlit', 'star-filled', 'cloud-wrapped',
    'windswept', 'sun-dappled', 'shadow-draped', 'golden', 'silver', 'copper-toned',
    'patinated', 'hand-painted', 'gilded', 'carved', 'terraced', 'layered',
    'reflected', 'translucent', 'iridescent', 'pearlescent', 'textured',
    'crumbling', 'restored', 'timeworn', 'freshly built', 'half-finished',
    'ceremonial', 'sacred', 'wild', 'domesticated', 'migratory', 'seasonal',
  ],

  lighting: [
    'golden hour sunlight', 'moonlit reflections', 'dramatic thunderclouds',
    'soft overcast lighting', 'crisp desert air', 'after-rain shimmer',
    'warm tungsten glow', 'cool cyan shadows', 'amber rim light',
    'dappled canopy light', 'high contrast lighting', 'diffused cinematic haze',
    'subsurface underwater rays', 'volumetric god rays', 'silhouette backlighting',
    'low key lighting', 'aurora sky ribbons', 'starlit twilight gradient',
    'bright midday clarity', 'sunset magenta horizon', 'pre-dawn blue tones',
    'mist and rain droplets', 'dry heat shimmer', 'fresh snowfall powder',
    'stormy ocean spray', 'tranquil lake mirror', 'cloud sea backdrop',
    'firelight flicker', 'candlelit warmth', 'lantern glow', 'neon reflections',
    'bioluminescent glow', 'shaft of light through clouds', 'rainbow prism light',
    'eclipse shadow', 'polar twilight', 'tropical noon glare',
    'autumn leaf-filtered light', 'cherry blossom haze', 'campfire embers',
  ],

  mood: [
    'uplifting adventurous mood', 'cozy nostalgic mood', 'mysterious tense mood',
    'playful whimsical mood', 'serene meditative mood', 'heroic epic mood',
    'dreamlike surreal mood', 'hopeful optimistic mood', 'moody noir tone',
    'bright celebratory tone', 'awe-inspiring grandeur', 'intimate and quiet',
    'wild and untamed', 'romantic and warm', 'solemn and reverent',
    'joyful and energetic', 'contemplative and still', 'dramatic and powerful',
  ],

  style: [
    'stylized illustration', 'high detail concept art', 'matte painting finish',
    'storybook painting style', 'watercolor wash texture', 'heavy linework accents',
    'gouache brush strokes', 'oil paint texture', 'clean vector style',
    'isometric scene design', 'futuristic retro fusion', 'ancient technology motif',
    'solar-punk infrastructure', 'fantasy realism blend', 'art deco geometry',
    'brutalist forms', 'organic curved structures', 'geometric layered abstract style',
    'maximalist color explosion', 'photorealistic rendering', 'soft focus impressionism',
    'ukiyo-e woodblock style', 'art nouveau curves', 'pointillist texture',
    'palette knife impasto', 'charcoal sketch finish', 'ink wash painting',
    'fresco texture', 'mosaic tile style', 'stained glass rendering',
    'linocut print style', 'copper engraving style', 'digital collage',
    'hand-tinted photograph style', 'vintage travel poster style',
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
    'burnt sienna and slate blue as dominant tones with natural colour variation throughout',
    'ochre and forest green as dominant tones with natural colour variation throughout',
    'lavender and honey gold as dominant tones with natural colour variation throughout',
    'terracotta and turquoise as dominant tones with natural colour variation throughout',
    'peach and navy as dominant tones with natural colour variation throughout',
    'crimson and ivory as dominant tones with natural colour variation throughout',
    'olive and burgundy as dominant tones with natural colour variation throughout',
    'dusty pink and deep teal as dominant tones with natural colour variation throughout',
    'warm grey and saffron as dominant tones with natural colour variation throughout',
    'plum and bronze as dominant tones with natural colour variation throughout',
  ],

  camera: [
    'wide-angle establishing shot', 'low-angle hero perspective',
    "overhead bird's-eye view", 'close-up macro shot',
    'medium shot with foreground framing', "worm's-eye upward angle",
    'Dutch tilt dynamic angle', 'symmetrical frontal framing',
    'over-the-shoulder depth shot', 'panoramic wide shot',
    'intimate eye-level shot', 'dramatic low horizon shot',
    'telephoto compression shot', 'fish-eye distortion',
    'through-the-archway framing', 'reflection framing',
    'layered depth with bokeh foreground', 'silhouette framing against sky',
  ],
}

// ---------------------------------------------------------------------------
// Diamond descriptor pool — curated for low colour count, wide flat regions.
// Paint-by-numbers needs bold, simple subjects with strong colour separation.
// ---------------------------------------------------------------------------

const DIAMOND_DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  concept: [
    'lighthouse', 'sailboat', 'hot air balloon', 'sunflower field', 'cottage',
    'windmill', 'barn', 'bridge', 'castle', 'pagoda', 'mosque', 'church',
    'tulip garden', 'cherry blossom tree', 'palm tree', 'cactus garden',
    'flamingo', 'parrot', 'butterfly', 'koi pond', 'peacock', 'owl',
    'cat portrait', 'dog portrait', 'horse', 'deer', 'fox',
    'mountain lake', 'sunset beach', 'rolling hills', 'autumn tree',
    'fruit bowl', 'vase of flowers', 'teapot', 'lantern',
    'stained glass window', 'mosaic mural', 'quilt pattern', 'tile design',
    'tropical fish', 'sea turtle', 'whale', 'jellyfish',
    'hot spring', 'waterfall', 'volcano', 'glacier',
    'carnival tent', 'ferris wheel', 'carousel', 'vintage car',
  ],

  location: [
    'garden', 'meadow', 'hillside', 'lakeside', 'seaside', 'riverside',
    'village', 'rooftop', 'balcony', 'courtyard', 'field', 'orchard',
    'desert', 'tropical island', 'snowy peak', 'forest clearing',
    'harbour', 'pier', 'market square', 'cobblestone street',
  ],

  state: [
    'bold', 'vivid', 'vibrant', 'bright', 'saturated', 'flat-shaded',
    'poster-like', 'graphic', 'simplified', 'blocky', 'clean-edged',
    'high-contrast', 'colour-blocked', 'cel-shaded', 'posterised',
  ],

  lighting: [
    'bright even lighting', 'warm golden light', 'clear daylight',
    'soft diffused light', 'bold sunset glow', 'flat studio lighting',
    'overhead noon light', 'warm afternoon light',
  ],

  mood: [
    'cheerful and bright', 'calm and peaceful', 'warm and inviting',
    'playful and colourful', 'bold and graphic', 'nostalgic and cozy',
  ],

  style: [
    'poster art style', 'stained glass rendering', 'mosaic tile style',
    'gouache flat colour', 'screen print style', 'paper cut-out style',
    'folk art illustration', 'retro travel poster', 'simplified illustration',
    'bold graphic style', 'decorative art style', 'naive art style',
    'woodblock print style',
  ],

  palette: [
    '8–12 distinct flat colours with no gradients',
    'bold primary colours with strong contrast between regions',
    'warm earth tones in large flat areas',
    'cool ocean tones with clear colour boundaries',
    'autumn colours with distinct red, orange, gold, and green zones',
    'tropical palette with flat turquoise, coral, green, and sand regions',
    'pastel palette with clearly separated soft colour blocks',
    'jewel tones with rich saturated flat fills',
    'sunset palette with flat bands of orange, pink, purple, and blue',
    'forest palette with distinct green, brown, gold, and sky blue areas',
  ],

  camera: [
    'straight-on frontal view', 'slightly elevated angle',
    'centered symmetrical framing', 'simple medium shot',
    'wide view with clear subject', 'close-up with bold shapes',
  ],
}

// ---------------------------------------------------------------------------
// Minimum pool size validation — checked per role at startup.
// ---------------------------------------------------------------------------

const MIN_ROLE_POOL_SIZE: Record<DescriptorRole, number> = {
  concept: 40,
  location: 40,
  state: 30,
  lighting: 20,
  mood: 10,
  style: 15,
  palette: 10,
  camera: 10,
}

// ---------------------------------------------------------------------------
// Prompt template constants
// ---------------------------------------------------------------------------

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
      'Depict a breathtaking, visually stunning scene worthy of a framed print or wallpaper — dramatic scale, striking depth, and arresting beauty. Favour sweeping vistas, monumental architecture, epic natural wonders, or powerful wildlife portraits. The image should feel like a cinematic hero shot that demands attention.',
    qualityTarget:
      'Every region must be packed with rich texture, fine surface detail, and tonal depth. Ensure many distinct recognisable sub-regions with clear visual separation. Maintain natural colour variety — secondary and environmental colours should remain visible beneath the dominant palette. The overall impression should be of a premium, gallery-quality image.',
  },
  slider: {
    title: 'Slider',
    composition:
      'Depict a visually striking, high-impact scene with bold composition and dramatic presence — the kind of image that stops you scrolling. Favour powerful landscapes, grand architecture, vivid wildlife encounters, or dramatic atmospheric moments. Prioritise depth, scale, and visual punch.',
    qualityTarget:
      'Every region must contain rich texture, fine detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation between them. Maintain natural colour variety throughout — secondary and environmental colours should remain visible beneath the dominant palette.',
  },
  swap: {
    title: 'Swap',
    composition:
      'Depict a visually gorgeous, immersive scene with strong colour impact and beautiful composition — something that would look stunning as a large print. Favour lush environments, dramatic skies, vibrant cityscapes, majestic wildlife, or awe-inspiring natural formations. The image should feel rich, expansive, and deeply satisfying to look at.',
    qualityTarget:
      'Every region must be filled with rich texture, fine surface detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation. Maintain natural colour variety — secondary and environmental colours should remain visible beneath the dominant palette.',
  },
  polygram: {
    title: 'Polygram',
    composition:
      'Depict a single continuous scene with strong visual variety throughout — any subject direction is welcome: landscape, wildlife, architecture, objects, daily life, or abstract.',
    qualityTarget:
      'Every region of the image should be filled with rich texture, fine surface detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation between them. Maintain natural colour variety throughout — secondary and environmental colours should remain visible beneath the dominant palette.',
  },
  diamond: {
    title: 'Diamond Painting',
    composition:
      'Depict a scene with bold, clearly defined colour regions and strong contrast between areas. Favour subjects with distinct colour blocks: landscapes with sky/water/land separation, bold florals, stained glass, mosaics, or graphic illustrations. Avoid subtle gradients and monochromatic areas.',
    qualityTarget:
      'Prioritise large uniform colour regions with clean edges between them. Each region should be a distinct, nameable colour. Maintain at least 8–12 clearly different colour zones. Avoid fine noise, speckle, or photographic grain. The image should quantize well to a limited palette while remaining recognisable.',
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
  'Output: one landscape 4:3 image , fully edge-to-edge composition with no borders, frames, or vignettes. Do not include any text, titles, labels, watermarks, signatures, or lettering of any kind anywhere in the image.',
  'Deliver a single landscape 4:3 image . The composition must fill the full frame with no decorative borders or edges. The image must contain absolutely no text, titles, captions, watermarks, signatures, or any form of writing.',
  'Single 4:3 landscape image  only. Extend the scene to every edge — the composition should contain no frames, borders, or vignetting. Exclude all text, titles, labels, watermarks, signatures, and lettering from the image entirely.',
] as const

// Polygram output templates reinforce orientation rather than edge-to-edge fill.
// "Edge-to-edge" is correct for scene puzzles but actively harmful for polygram
// because it encourages the model to crop the subject — removing the very
// perspective lines and vertical extent that anchor piece orientation.
const PROMPT_OUTPUT_TEMPLATES_DIAMOND = [
  'Output: one landscape 4:3 image with bold, flat colour areas and minimal gradients. Use a poster-like or stained-glass aesthetic with clearly separated colour zones. No borders or frames. Do not include any text, titles, labels, watermarks, signatures, or lettering of any kind anywhere in the image.',
  'Deliver a single landscape 4:3 image . Use broad, flat colour fills with strong edges between regions — think mosaic or poster art. Avoid smooth gradients and fine noise. No borders or frames. The image must contain absolutely no text, titles, captions, watermarks, signatures, or any form of writing.',
  'Single 4:3 landscape image  only. Emphasise large, distinct colour blocks with crisp boundaries — minimal blending between regions. The scene should be recognisable even when reduced to 16 colours. No borders or frames. Exclude all text, titles, labels, watermarks, signatures, and lettering from the image entirely.',
] as const

const PROMPT_OUTPUT_TEMPLATES_POLYGRAM = [
  'Output: one landscape 4:3 image . The directional lines, shadows, and tonal gradient must be clearly readable across the whole image. No borders or frames. Use heavy line work, ink work, or a stained glass style to define shapes. Do not include any text, titles, labels, watermarks, signatures, or lettering of any kind anywhere in the image.',
  'Deliver a single landscape 4:3 image . Ensure perspective lines, cast shadows, and top-to-bottom tonal variation are strong and unambiguous throughout the full frame. No borders or frames. Use heavy line work, ink work, or a stained glass style to define shapes. The image must contain absolutely no text, titles, captions, watermarks, signatures, or any form of writing.',
  'Single 4:3 landscape image  only. The orientation cues — converging lines, directional shadows, vertical gradient — must be vivid and consistent across the entire composition. No borders or frames. Use heavy line work, ink work, or a stained glass style to define shapes. Exclude all text, titles, labels, watermarks, signatures, and lettering from the image entirely.',
] as const

// ---------------------------------------------------------------------------
// A selected descriptor set — one value per role.
// ---------------------------------------------------------------------------

type DescriptorSet = Record<DescriptorRole, string>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generatePromptPacks(db: D1Database, count: number): Promise<PromptPack[]> {
  validatePoolSizes()
  await ensurePuzzleTables(db)
  const history = await getPromptHistoryD1(db)
  const packs: PromptPack[] = []

  const startLen = history.length
  for (let index = 0; index < count; index += 1) {
    const pack = buildPromptPack(history)
    packs.push(pack)
  }

  // Persist all new history items appended by buildPromptPack
  for (let i = startLen; i < history.length; i++) {
    await appendPromptHistory(db, history[i])
  }
  return packs
}

export async function generateSingleCategoryPrompt(
  db: D1Database,
  category: PuzzleCategory,
): Promise<{ prompt: string; theme: string; keywords: string[] }> {
  validatePoolSizes()
  await ensurePuzzleTables(db)
  const history = await getPromptHistoryD1(db)

  const set = pickDescriptorSet(history, new Set(), category)
  const details = buildCategoryPromptDetails(category, set)

  const item: PromptHistoryItem = {
    descriptors: [...new Set(Object.values(set))],
    createdAt: new Date().toISOString(),
  }
  await appendPromptHistory(db, item)

  return details
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
      diamond:  buildCategoryPromptDetails('diamond',  descriptorSetsByCategory.diamond),
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
    : category === 'diamond'
    ? pickRandom(PROMPT_OUTPUT_TEMPLATES_DIAMOND)
    : pickRandom(PROMPT_OUTPUT_TEMPLATES)

  return [contextLine, subjectLine, descriptorLine, qualityLine, outputLine].join(' ')
}

// ---------------------------------------------------------------------------
// Role-slot descriptor picker
// ---------------------------------------------------------------------------

// Descriptors that produce flat/graphic imagery — these are great for
// polygram and diamond but should appear less often for jigsaw, slider, swap.
const GRAPHIC_STYLE_DESCRIPTORS = new Set([
  'mosaic', 'stained glass', 'mandala', 'origami', 'abstract ink', 'fluid marbling',
  'kinetic sculpture', 'light installation',
  'mosaic tile style', 'stained glass rendering', 'clean vector style',
  'isometric scene design', 'geometric layered abstract style', 'linocut print style',
  'copper engraving style',
])

const PHOTOGRAPHIC_CATEGORIES: ReadonlySet<PuzzleCategory> = new Set(['jigsaw', 'slider', 'swap'])

// Pick one descriptor per role, preferring least-recently-used entries and
// avoiding anything already used elsewhere in this pack.
function pickDescriptorSet(
  recent: PromptHistoryItem[],
  excluded: Set<string>,
  category: PuzzleCategory,
): DescriptorSet {
  const counts = buildUsageCounts(recent)
  const pool = category === 'diamond' ? DIAMOND_DESCRIPTOR_POOL : DESCRIPTOR_POOL
  const set = {} as DescriptorSet

  // For photographic categories, penalise graphic/flat-art descriptors so
  // they appear less often (but aren't completely excluded).
  const penalised = PHOTOGRAPHIC_CATEGORIES.has(category) ? GRAPHIC_STYLE_DESCRIPTORS : null

  let working = new Set(excluded)
  for (const role of ROLES) {
    set[role] = pickOneDescriptor(pool[role], counts, working, penalised)
    working = new Set([...working, set[role]])
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
  penalised?: Set<string> | null,
): string {
  // Filter out anything already used in this pack. If that empties the pool,
  // fall back to the full pool so we never hard-fail.
  const available = pool.filter((d) => !excluded.has(d))
  const workingPool = available.length > 0 ? available : [...pool]

  // Score by usage frequency, shuffle within ties via a random tiebreaker.
  // Penalised descriptors get an extra usage count so they sort lower.
  const penaltyWeight = 3
  const scored = workingPool
    .map((descriptor) => ({
      descriptor,
      seen: (counts.get(descriptor) ?? 0) + (penalised?.has(descriptor) ? penaltyWeight : 0),
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

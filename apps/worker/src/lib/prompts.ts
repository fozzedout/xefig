import { CATEGORIES, type PromptHistoryItem, type PromptPack, type PuzzleCategory } from '../types'
import { ensurePuzzleTables, getPromptHistoryD1, appendPromptHistory } from './puzzle-db'

const PROMPT_HISTORY_LIMIT = 260

const ROLES = ['concept', 'location', 'state', 'lighting', 'mood', 'palette', 'camera'] as const
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
    // big cats and savanna mammals
    'lion', 'cheetah', 'leopard', 'giraffe', 'zebra', 'rhinoceros',
    'hippopotamus', 'meerkat',
    // primates and rainforest mammals
    'gorilla', 'orangutan', 'sloth',
    'moose', 'otter',
    // marsupials
    'kangaroo', 'koala',
    // marine life
    'shark', 'walrus', 'seal', 'pufferfish', 'crab',
    // birds
    'swan', 'pelican', 'puffin', 'penguin', 'toucan', 'macaw', 'raven',
    // reptiles and amphibians
    'crocodile', 'tortoise', 'tree frog',
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
    'nebula', 'cavern', 'meadow', 'swamp', 'delta',
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
    'melancholic and wistful', 'eerie and unsettling', 'triumphant and victorious',
    'peaceful and pastoral', 'fierce and primal', 'curious and exploratory',
    'lonely and isolated', 'magical and enchanted', 'gritty and raw',
    'elegant and refined', 'chaotic and lively', 'sacred and transcendent',
    'brooding and atmospheric', 'festive and exuberant',
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
    'steel blue and tangerine as dominant tones with natural colour variation throughout',
    'charcoal and electric blue as dominant tones with natural colour variation throughout',
    'moss green and dusty rose as dominant tones with natural colour variation throughout',
    'midnight blue and copper as dominant tones with natural colour variation throughout',
    'clay and sage as dominant tones with natural colour variation throughout',
    'vermilion and slate as dominant tones with natural colour variation throughout',
    'apricot and deep purple as dominant tones with natural colour variation throughout',
    'seafoam and coral pink as dominant tones with natural colour variation throughout',
    'walnut and cream as dominant tones with natural colour variation throughout',
    'sapphire and gold leaf as dominant tones with natural colour variation throughout',
    'mauve and olive as dominant tones with natural colour variation throughout',
    'graphite and sunflower as dominant tones with natural colour variation throughout',
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
    'three-quarter angle portrait view', 'split-level above-and-below shot',
    'diagonal leading-line composition', 'centered vanishing-point corridor',
    'top-down flat lay arrangement', 'shallow depth isolating subject',
    'rule-of-thirds off-centre placement', 'tilt-shift miniature effect',
    'long exposure motion blur', 'golden spiral composition',
    'environmental portrait with context', 'receding planes depth shot',
  ],
}

// ---------------------------------------------------------------------------
// Diamond descriptor pool — curated for low colour count, wide flat regions.
// Paint-by-numbers needs bold, simple subjects with strong colour separation.
// ---------------------------------------------------------------------------

const DIAMOND_DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  // Concepts that have natural medium-scale shapes (~20-60 paintable
  // regions), not microscopic texture. Avoid subjects that imply
  // "hundreds of tiny things" — those collapse to noise at 16 colours
  // and are miserable to paint.
  concept: [
    // hero subjects in styled settings
    'lighthouse on a cliff', 'sailboat on calm water', 'hot air balloon over hills',
    'windmill in a field', 'cottage with garden path',
    'stone bridge over a river', 'chapel on a hill',
    'pagoda in a quiet garden', 'palm tree on a beach',
    'cherry blossom tree by a river', 'autumn tree on a lawn',
    'mountain reflected in a still lake', 'barn under a starry sky',
    // iconic animals in richer environments
    'fox in a snowy forest', 'owl on a branch among autumn leaves',
    'stag in a coastal meadow with boats in the bay',
    'hummingbirds among tropical flowers', 'cat on a windowsill overlooking rooftops',
    'parrots in a jungle canopy', 'peacock with tail fan in a walled garden',
    'deer at a forest edge with wildflowers', 'whale breaching near fishing boats',
    'koi pond with lotus flowers and stepping stones',
    'flamingos wading in a tropical lagoon', 'polar bear on ice with an aurora sky',
    'lion pride at rest under acacia trees on the savanna',
    'giraffes browsing under acacias at golden hour',
    'zebras at a watering hole with reflected clouds',
    'gorilla in a misty jungle clearing with ferns',
    'orangutan among rainforest canopy vines and orchids',
    'sea otters floating in a kelp forest at sunset',
    'penguins on an icy shore with snowy mountains behind',
    'puffin colony on a windswept sea cliff above the surf',
    'tortoise in a desert garden with prickly pears and wildflowers',
    'tree frog on a glossy leaf among tropical orchids',
    // still-life and decorative scenes
    'vase of sunflowers on a tiled table by a window',
    'bowl of fruit on a patterned cloth', 'teapot and cups on a folk-art runner',
    'lantern on a porch with climbing roses',
    'bicycle against a wall with flowers in the basket and market stalls behind',
    'rocking chair on a wooden porch overlooking a garden',
    // landscapes with layered elements
    'rolling hills at sunset with a village nestled below',
    'lavender field at dawn with a farmhouse',
    'tulip field in rows with a windmill behind',
    'sunflower field with a red barn under a blue sky',
    'vineyard terrace at dusk with a chateau', 'harbour with fishing boats and dockside buildings',
    'beach scene with umbrellas, towels and swimmers',
    'snowy pine forest with a cabin and aurora',
    // busier scenes — lots of small flat-colour elements
    'village market square with stalls, awnings and shoppers',
    'circus tent in a town square with crowds and bunting',
    'harvest festival with stalls, bunting and families',
    'canal town with layered rooftops and boats',
    'alpine village with chalets, skiers and pine trees',
    'seaside promenade with beach huts, strollers and gulls',
    'old town plaza with cafes, trees and passers-by',
    'carnival parade through a decorated street',
    'rooftop view across a tiled city',
    'botanical scene with layered plants, butterflies and birds',
    'forest clearing with animals gathered around a stream',
    'tea plantation with workers, baskets and mountains behind',
    // folk-art / decorative patterns
    'stained glass flower panel', 'mandala with 8-fold symmetry',
    'folk-art tree of life with birds and fruit',
    'talavera plate pattern with central motif',
    'paper-cut bird and flower motif', 'quilted heart block',
    // architectural
    'red barn in snow with pine trees', 'windmill at sunset over tulip fields',
    'lighthouse at night with moon and sailboats',
    'church steeple against sky with cottages below',
  ],

  location: [
    'garden', 'meadow', 'hillside', 'lakeside', 'seaside', 'riverside',
    'rooftop', 'balcony', 'courtyard', 'field', 'orchard',
    'tropical island', 'snowy peak', 'forest clearing',
    'harbour', 'pier', 'village square', 'mountain pass',
    'riverbank', 'desert vista', 'market street', 'parkland',
    'clifftop', 'terrace', 'canal side', 'woodland path',
  ],

  state: [
    'bold', 'vivid', 'vibrant', 'saturated', 'flat-shaded',
    'poster-like', 'graphic', 'high-contrast', 'colour-blocked', 'cel-shaded',
    'posterised', 'stylised', 'decorative', 'detailed but flat',
    'intricate in silhouette', 'densely composed but clean-edged',
    'layered flat shapes', 'richly patterned', 'hand-crafted',
    'retro-styled', 'folk-inspired', 'whimsical', 'ornamental',
    'jewel-toned',
  ],

  lighting: [
    'bright even lighting', 'warm golden light', 'clear daylight',
    'soft diffused light', 'bold sunset glow', 'flat studio lighting',
    'overhead noon light', 'warm afternoon light',
    'cool morning light', 'rosy dawn light', 'late afternoon amber',
    'overcast silvery light', 'pastel twilight glow', 'strong midday sun',
    'gentle backlit haze', 'crisp autumn light',
  ],

  mood: [
    'cheerful and bright', 'calm and peaceful', 'warm and inviting',
    'playful and colourful', 'bold and graphic', 'nostalgic and cozy',
    'dreamy and soft', 'festive and lively', 'mysterious and dusky',
    'serene and spacious', 'tender and intimate', 'vibrant and energetic',
    'stately and elegant', 'whimsical and charming',
  ],

  palette: [
    'jewel tones laid down in large flat panels with clean boundaries',
    'stained-glass palette: a dozen saturated flat panels separated by bold dark leading',
    'folk-art palette: primaries, earth tones and one accent in simple, bold shapes',
    'mid-century poster palette: a limited set of flat colours in strong silhouettes',
    'tropical flat palette: turquoise, coral, green, sand, magenta — each as broad zones',
    'autumn flat palette: red, orange, gold, ochre, brown — each as substantial shapes',
    'botanical flat palette: a few greens plus one or two petal colours as solid fills',
    'muted Scandinavian palette: pale sky, warm wood, soft red, cream — flat and spacious',
    'seaside palette: navy, white, sky blue, sand, coral — clean and fresh',
    'sunset palette: peach, magenta, gold, violet, deep blue — warm and vivid',
    'earth and spice palette: terracotta, turmeric, olive, cream, charcoal — rich and grounded',
    'winter palette: ice blue, slate, white, berry red, pine green — crisp and cool',
    'Mediterranean palette: cobalt, white, terracotta, lemon, olive — sun-drenched',
    'candy palette: pink, mint, lavender, lemon, peach — sweet and bright',
    'woodland palette: moss, bark brown, fern, amber, mushroom grey — natural and warm',
    'fiesta palette: vermilion, cobalt, sunflower, emerald, hot pink — bold and festive',
  ],

  camera: [
    'straight-on frontal view with the subject clearly centred',
    'slightly elevated angle with a calm foreground',
    'centered symmetrical framing with generous negative space',
    'medium shot with one hero subject and a simple backdrop',
    'wide landscape framing with a clear horizon line',
    'gentle three-quarter angle with the subject off-centre',
    'low angle looking up at the subject against the sky',
    'overhead view looking down on the scene',
    'panoramic wide shot with layered horizontal bands',
    'intimate close framing filling most of the canvas',
    'diagonal composition with the subject on a leading line',
    'eye-level view with foreground and background layers',
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
      'Craft a detailed, dynamic scene that tells a story using these elements:',
    qualityTarget:
      'Every region must be packed with rich texture, fine surface detail, and tonal depth. Ensure many distinct recognisable sub-regions with clear visual separation. Maintain natural colour variety — secondary and environmental colours should remain visible beneath the dominant palette. The overall impression should be of a premium, gallery-quality image.',
  },
  slider: {
    title: 'Slider',
    composition:
      'Craft a detailed, dynamic scene that tells a story using these elements:',
    qualityTarget:
      'Every region must contain rich texture, fine detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation between them. Maintain natural colour variety throughout — secondary and environmental colours should remain visible beneath the dominant palette.',
  },
  swap: {
    title: 'Swap',
    composition:
      'Craft a detailed, dynamic scene that tells a story using these elements:',
    qualityTarget:
      'Every region must be filled with rich texture, fine surface detail, and tonal variation. Ensure many distinct recognisable sub-regions with clear visual separation. Maintain natural colour variety — secondary and environmental colours should remain visible beneath the dominant palette.',
  },
  polygram: {
    title: 'Polygram',
    composition:
      'Craft a layered scene with strong perspective and depth — populate the foreground, middle ground, and background each with their own detail — using these elements:',
    // Technical tail: polygram is a rotation puzzle, so EVERY fragment
    // — including nominally-uniform regions like skies, walls, water —
    // needs visible directional cues so the player can tell which way
    // up a piece goes. Earlier wording focused on shape boundaries
    // between forms ("every form bounded by a confident edge"), which
    // the model satisfied by drawing strong outlines on objects but
    // leaving the sky as a soft painterly gradient. Now naming the
    // trouble regions explicitly and requiring line work inside them.
    qualityTarget:
      'Heavy line work and visible directional cues throughout the ENTIRE image, with no exception for nominally-uniform regions: skies must be broken into visible cloud panels with clear edges or stained-glass-style leading; walls must show mortar lines, cracks, or vines; water must show ripple lines or reflective panels; foliage must show leaf and stem lines. Every fragment of the image must carry rotational orientation cues, since this is a rotation puzzle. Strong shape boundaries between forms, and every region filled with rich texture, fine surface detail, and tonal variation. Maintain natural colour variety throughout — secondary and environmental colours should remain visible beneath the dominant palette.',
  },
  diamond: {
    title: 'Diamond Painting',
    composition:
      'Craft a richly detailed scene packed with small named subjects throughout the frame, using these elements:',
    // Technical tail appended verbatim after the LLM rewrite — kept
    // deliberately terse after iterative testing. "Very low colour"
    // is a hint to the image model that the medium has a tiny palette
    // (16 colours), which biases generation toward medium-scale panels
    // that quantize cleanly. "Distinct subject" carries the figure-
    // ground contrast rule from earlier iterations.
    qualityTarget:
      'style: complex and busy, distinct subject. very low colour, every shape should be defined by colour rather than outlines',
  },
}

// The descriptive half of the prompt is a labelled keyword block, not a
// narrative template — the LLM rewriter (gemma-rewriter) is told to compose
// a creative paragraph from these elements, and the labels (Subject /
// Setting / Lighting / etc.) carry role information that a flat keyword
// list can't. Style / medium / aesthetic constraints are NOT in the
// descriptors at all — they live in the per-category technical tail
// (qualityTarget + outputTemplate) and reach the image model verbatim.

const PROMPT_OUTPUT_TEMPLATES = [
  'Output: one landscape 4:3 image that fills the full frame edge to edge. The image is free of text, titles, labels, watermarks, signatures, or lettering of any kind.',
  'Deliver a single landscape 4:3 image with the composition extending to every edge of the frame. The image contains no text, titles, captions, watermarks, signatures, or writing of any kind.',
  'Single 4:3 landscape image, the scene extending to every edge so it fills the full frame. The image is entirely free of text, titles, labels, watermarks, signatures, and lettering.',
] as const

// Polygram output templates reinforce orientation rather than edge-to-edge fill.
// "Edge-to-edge" is correct for scene puzzles but actively harmful for polygram
// because it encourages the model to crop the subject — removing the very
// perspective lines and vertical extent that anchor piece orientation.
const PROMPT_OUTPUT_TEMPLATES_DIAMOND = [
  'Output: one landscape 4:3 image that fills the full frame edge to edge. The image is free of text, titles, labels, watermarks, signatures, or lettering of any kind.',
  'Deliver a single landscape 4:3 image with the composition extending to every edge of the frame. The image contains no text, titles, captions, watermarks, signatures, or writing of any kind.',
  'Single 4:3 landscape image, the scene extending to every edge so it fills the full frame. The image is entirely free of text, titles, labels, watermarks, signatures, and lettering.',
] as const

const PROMPT_OUTPUT_TEMPLATES_POLYGRAM = [
  'Output: one landscape 4:3 illustration (not a photograph) with directional lines, shadows, and tonal gradient reading clearly across the whole composition. The scene fills the full frame edge to edge. The image is free of text, titles, labels, watermarks, signatures, or lettering of any kind.',
  'Deliver a single landscape 4:3 stylised illustration — not photographic — with strong, unambiguous perspective lines, cast shadows, and top-to-bottom tonal variation throughout the full frame. The scene fills the frame edge to edge. The image contains no text, titles, captions, watermarks, signatures, or writing of any kind.',
  'Single 4:3 landscape illustration (rendered in the style above, not as a photograph) with orientation cues — converging lines, directional shadows, vertical gradient — vivid and consistent across the entire composition. The composition extends to every edge. The image is entirely free of text, titles, labels, watermarks, signatures, and lettering.',
] as const

// ---------------------------------------------------------------------------
// A selected descriptor set — one value per role.
// ---------------------------------------------------------------------------

type DescriptorSet = Record<DescriptorRole, string>

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Optional async callback that expands the descriptive half of a prompt
// into richer prose. When provided, the pack/single-prompt generators
// call it per category and re-attach the technical half verbatim.
export type PromptRewriter = (
  descriptive: string,
  context: { category: PuzzleCategory; theme: string; keywords: string[] },
) => Promise<string>

export async function generatePromptPacks(
  db: D1Database,
  count: number,
  rewriter?: PromptRewriter,
): Promise<PromptPack[]> {
  validatePoolSizes()
  await ensurePuzzleTables(db)
  const history = await getPromptHistoryD1(db)
  const packs: PromptPack[] = []

  const startLen = history.length
  for (let index = 0; index < count; index += 1) {
    const pack = buildPromptPack(history)
    packs.push(pack)
  }

  if (rewriter) {
    for (const pack of packs) {
      await applyRewriterToPack(pack, rewriter)
    }
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
  rewriter?: PromptRewriter,
): Promise<{ prompt: string; theme: string; keywords: string[] }> {
  validatePoolSizes()
  await ensurePuzzleTables(db)
  const history = await getPromptHistoryD1(db)

  const set = pickDescriptorSet(history, new Set(), category)
  const details = buildCategoryPromptDetails(category, set)

  let prompt = details.prompt
  if (rewriter) {
    const rewritten = await rewriter(details.descriptive, {
      category,
      theme: details.theme,
      keywords: details.keywords,
    })
    const expanded = (rewritten || '').trim()
    if (expanded) {
      prompt = `${expanded}\n\n${details.technical}`
    }
  }

  const item: PromptHistoryItem = {
    descriptors: [...new Set(Object.values(set))],
    createdAt: new Date().toISOString(),
  }
  await appendPromptHistory(db, item)

  return {
    prompt,
    theme: details.theme,
    keywords: details.keywords,
  }
}

async function applyRewriterToPack(pack: PromptPack, rewriter: PromptRewriter): Promise<void> {
  await Promise.all(
    CATEGORIES.map(async (category) => {
      const entry = pack.categories[category]
      // Safe lookup: buildCategoryPromptDetails writes `descriptive` and
      // `technical` alongside `prompt`, but if we're ever handed a pack
      // shaped only as {prompt, theme, keywords} (e.g. from an admin
      // client) just leave the prompt as-is.
      const extra = entry as unknown as { descriptive?: string; technical?: string }
      if (!extra.descriptive || !extra.technical) return

      try {
        const rewritten = await rewriter(extra.descriptive, {
          category,
          theme: entry.theme,
          keywords: entry.keywords,
        })
        const expanded = (rewritten || '').trim()
        if (expanded) {
          entry.prompt = `${expanded}\n\n${extra.technical}`
        }
      } catch (err) {
        console.warn(
          `[prompts] rewriter threw for ${category}; keeping raw prompt`,
          err instanceof Error ? err.message : err,
        )
      }
    }),
  )
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
      jigsaw: buildCategoryPromptDetails('jigsaw', descriptorSetsByCategory.jigsaw),
      slider: buildCategoryPromptDetails('slider', descriptorSetsByCategory.slider),
      swap: buildCategoryPromptDetails('swap', descriptorSetsByCategory.swap),
      polygram: buildCategoryPromptDetails('polygram', descriptorSetsByCategory.polygram),
      diamond: buildCategoryPromptDetails('diamond', descriptorSetsByCategory.diamond),
    },
  }

  history.push({
    descriptors: [...usedInPack],
    createdAt: new Date().toISOString(),
  })

  return pack
}

function buildCategoryPromptDetails(category: PuzzleCategory, set: DescriptorSet) {
  const parts = buildImagePromptParts(category, set)
  return {
    prompt: `${parts.descriptive}\n\n${parts.technical}`,
    descriptive: parts.descriptive,
    technical: parts.technical,
    theme: `${capitalizeWords(set.state)} ${capitalizeWords(set.concept)} ${capitalizeWords(set.location)} — ${capitalizeWords(set.mood)}`,
    keywords: [...new Set(Object.values(set))].map(v => v.trim()).filter(Boolean).slice(0, 12),
  }
}

// ---------------------------------------------------------------------------
// Prompt builder — assembles one narrative prompt from a DescriptorSet.
// Structured as: composition + camera → descriptor narrative → quality
// target → output format. No meta-scaffolding ("First,", "Finally,") — the
// model doesn't need a procedure, it needs a scene description.
// ---------------------------------------------------------------------------

// Split into a "descriptive" half (scene / mood / style — the half a scene
// rewriter can expand) and a "technical" half (quality target + 4:3 output
// + no-border / no-text rules) that must survive verbatim. Callers that
// rewrite prompts through an LLM only send the descriptive half and
// re-attach technical as-is.
export function buildImagePromptParts(
  category: PuzzleCategory,
  set: DescriptorSet,
): { descriptive: string; technical: string } {
  const intent = CATEGORY_PROMPT_INTENTS[category]

  // Diamond concepts ("stag in a coastal meadow with boats in the bay",
  // "lighthouse on a cliff") already embed their setting, so omitting a
  // separate Setting line avoids redundant phrasing in the rewriter's
  // output.
  const includeSetting = category !== 'diamond'

  const keywordLines = [
    `Subject: ${set.state} ${set.concept}`,
    includeSetting ? `Setting: ${set.location}` : null,
    `Lighting: ${set.lighting}`,
    `Mood: ${stripMoodSuffix(set.mood)}`,
    `Palette: ${set.palette}`,
    `Camera: ${set.camera}`,
  ].filter((line): line is string => line !== null)

  // Composition prose tells the LLM HOW to compose; keyword block tells
  // it WHAT to compose with. The rewriter (gemma-rewriter.ts) is told
  // to "transform the descriptive elements into a single, cohesive,
  // imaginative paragraph" — labelled keywords let it pick up role
  // information the flat keywords list it also receives can't convey.
  const descriptive = `${intent.composition}\n\n${keywordLines.join('\n')}`

  const qualityLine = intent.qualityTarget

  const outputLine = category === 'polygram'
    ? pickRandom(PROMPT_OUTPUT_TEMPLATES_POLYGRAM)
    : category === 'diamond'
      ? pickRandom(PROMPT_OUTPUT_TEMPLATES_DIAMOND)
      : pickRandom(PROMPT_OUTPUT_TEMPLATES)

  return {
    descriptive,
    technical: [qualityLine, outputLine].join(' '),
  }
}

function stripMoodSuffix(mood: string): string {
  return mood.replace(/\s+(mood|tone|feel)$/i, '')
}

// ---------------------------------------------------------------------------
// Role-slot descriptor picker
// ---------------------------------------------------------------------------

// Pick one descriptor per role, preferring least-recently-used entries and
// avoiding anything already used elsewhere in this pack. Style / medium /
// aesthetic constraints are NOT a descriptor role — they live in each
// category's qualityTarget + outputTemplate (the verbatim technical tail),
// so this function just rotates scene fodder across the pool.
function pickDescriptorSet(
  recent: PromptHistoryItem[],
  excluded: Set<string>,
  category: PuzzleCategory,
): DescriptorSet {
  const counts = buildUsageCounts(recent)
  const pool = category === 'diamond' ? DIAMOND_DESCRIPTOR_POOL : DESCRIPTOR_POOL
  const set = {} as DescriptorSet

  let working = new Set(excluded)
  for (const role of ROLES) {
    set[role] = pickOneDescriptor(pool[role], counts, working)
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

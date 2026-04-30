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
    'cross-hatched pen and ink', 'cyanotype print style', 'crayon and pastel blend',
    'encaustic wax painting', 'risograph two-tone print', 'sgraffito scratch texture',
    'batik wax-resist pattern', 'Byzantine icon style',
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

  // Styles that produce clean, paintable regions — no "intricate /
  // dense / filigree / many tesserae" anywhere.
  style: [
    'poster art style with bold flat regions',
    'stained glass rendering with clear leaded panels',
    'folk art illustration with clean shapes',
    'gouache flat colour with confident brush strokes',
    'screen print style with limited layers',
    'paper cut-out style with bold silhouettes',
    'woodblock print style with a few colour blocks',
    'naive art style with simple forms',
    'storybook illustration with clean outlines',
    'mid-century modern illustration with flat shapes',
    'travel poster style with strong silhouettes',
    'cel-shaded animation style',
    'textile pattern style with embroidered shapes',
    'tile mosaic style with tessellated panels',
    'batik wax-print style with layered colour',
    'collage style with overlapping cut shapes',
    'mural painting style with broad confident strokes',
    'painted sign style with hand-lettered charm',
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
      'A vivid scene rendered as flat, unmixed colour panels with crisp hard edges between every region — the visual language of a mid-century travel poster, a screen-printed folk-art illustration, or a bold cel-shaded storybook painting. The scene may be a single hero subject against a supporting backdrop, or a busy composition packed with characters, buildings, plants, and objects. Small details — riggings, leaves, windows, flags, figures, petals, patterned roofs — are welcome, each rendered as a confident flat shape in its own solid colour.',
    qualityTarget:
      'The final image will be quantized to 16 colours and painted cell-by-cell, so every shape — large or small — should enshrine the shapes by colour and not outlines.',
  },
}

// Narrative templates weave the descriptor slots into prose rather than a
// labelled keyword list. Google's Nano Banana guide is explicit that narrative
// description outperforms "concept: X; location: Y" style lists.
const PROMPT_NARRATIVE_TEMPLATES = [
  'The scene features {stateArticle} {state} {concept} set in {locationPhrase}, bathed in {lighting}. The overall atmosphere feels {mood}. Render it in {style}, using {palette}.',
  'Depict {stateArticle} {state} {concept} in {locationPhrase}, under {lighting} and with {mood} energy throughout. Paint it in {style}, anchored by {palette}.',
  'Show {stateArticle} {state} {concept} in {locationPhrase}. Light it with {lighting} and give the image {mood} atmosphere throughout. Render in {style}, using {palette}.',
] as const

// Diamond concepts ("stag in a coastal meadow with boats in the bay",
// "lighthouse on a cliff") already embed their setting, so the diamond
// narrative omits the {location} slot to avoid redundant or contradictory
// phrasing like "…in a coastal meadow set in a hillside".
const PROMPT_NARRATIVE_TEMPLATES_DIAMOND = [
  'Depict {stateArticle} {state} {concept}, lit by {lighting} and carrying {mood} energy throughout. Render it in {style}, using {palette}.',
  'Show {stateArticle} {state} {concept} under {lighting}, with {mood} atmosphere overall. Paint it in {style}, anchored by {palette}.',
  'The scene features {stateArticle} {state} {concept}, bathed in {lighting}. The overall atmosphere feels {mood}. Render in {style}, using {palette}.',
] as const

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
  'Output: one landscape 4:3 image with directional lines, shadows, and tonal gradient reading clearly across the whole composition. Use heavy line work, ink work, or a stained glass style to define shapes. The scene fills the full frame edge to edge. The image is free of text, titles, labels, watermarks, signatures, or lettering of any kind.',
  'Deliver a single landscape 4:3 image with strong, unambiguous perspective lines, cast shadows, and top-to-bottom tonal variation throughout the full frame. Use heavy line work, ink work, or a stained glass style to define shapes. The scene fills the frame edge to edge. The image contains no text, titles, captions, watermarks, signatures, or writing of any kind.',
  'Single 4:3 landscape image with orientation cues — converging lines, directional shadows, vertical gradient — vivid and consistent across the entire composition. Use heavy line work, ink work, or a stained glass style to define shapes. The composition extends to every edge. The image is entirely free of text, titles, labels, watermarks, signatures, and lettering.',
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
      prompt = `${expanded} ${details.technical}`
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
          entry.prompt = `${expanded} ${extra.technical}`
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
    prompt: `${parts.descriptive} ${parts.technical}`,
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

  const subjectLine = `${intent.composition} Use ${vowelArticle(set.camera)} ${set.camera}.`

  const narrativeTemplate = category === 'diamond'
    ? pickRandom(PROMPT_NARRATIVE_TEMPLATES_DIAMOND)
    : pickRandom(PROMPT_NARRATIVE_TEMPLATES)

  const narrativeLine = narrativeTemplate
    .replace('{stateArticle}', vowelArticle(set.state))
    .replace('{state}', set.state)
    .replace('{concept}', set.concept)
    .replace('{locationPhrase}', locationPhrase(set.location))
    .replace('{lighting}', set.lighting)
    .replace('{mood}', stripMoodSuffix(set.mood))
    .replace('{style}', set.style)
    .replace('{palette}', set.palette)

  const qualityLine = intent.qualityTarget

  const outputLine = category === 'polygram'
    ? pickRandom(PROMPT_OUTPUT_TEMPLATES_POLYGRAM)
    : category === 'diamond'
      ? pickRandom(PROMPT_OUTPUT_TEMPLATES_DIAMOND)
      : pickRandom(PROMPT_OUTPUT_TEMPLATES)

  return {
    descriptive: [subjectLine, narrativeLine].join(' '),
    technical: [qualityLine, outputLine].join(' '),
  }
}

function vowelArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

function stripMoodSuffix(mood: string): string {
  return mood.replace(/\s+(mood|tone|feel)$/i, '')
}

// Plurals like "cliffs" or "rooftops" take "the", not "a/an". "sky" reads
// more naturally with "the" as well.
function locationPhrase(location: string): string {
  if (location === 'sky') return 'the sky'
  if (/s$/.test(location) && !/ss$/.test(location)) return `the ${location}`
  return `${vowelArticle(location)} ${location}`
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

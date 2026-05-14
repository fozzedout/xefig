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
    'hammam', 'conservatory', 'greenhouse', 'gazebo', 'pergola', 'stupa',
    'riad', 'caravanserai', 'granary', 'dovecote', 'gristmill', 'beach hut',
    'cloister', 'belvedere', 'rotunda', 'tile kiln', 'salt works', 'paper mill',
    // nature & geography
    'waterfall', 'canyon', 'glacier', 'reef', 'oasis', 'hot spring',
    'geyser', 'cenote', 'sinkhole', 'tide pool', 'kelp forest', 'mangrove',
    'bamboo grove', 'cherry blossom grove', 'lavender field', 'sunflower field',
    'rice terrace', 'vineyard', 'tea plantation', 'wildflower meadow',
    'aurora', 'thunderhead', 'supercell', 'rainbow', 'ice cave', 'sea arch',
    'sea stack', 'coral atoll', 'volcanic caldera', 'lava flow', 'basalt columns',
    'slot canyon', 'hoodoo formations', 'sand dunes', 'salt flat', 'petrified forest',
    'salt marsh', 'river delta', 'oxbow lake', 'mineral pool', 'redwood grove',
    'baobab tree', 'banyan tree', 'mangrove channel', 'savanna fire',
    'monsoon clouds', 'dust devil', 'sirocco wind', 'braided river',
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
    'jungle', 'tundra', 'village', 'city', 'rooftops', 'sky',
    'nebula', 'cavern', 'meadow', 'swamp', 'delta',
    'fjord', 'plateau', 'mesa', 'volcano', 'outpost', 'stronghold',
    'archipelago', 'lagoon', 'estuary', 'wetlands', 'steppe', 'taiga',
    'rainforest canopy', 'cloud forest', 'alpine lake', 'mountain pass',
    'river bend', 'waterfront', 'harbor town', 'hilltop village',
    'cliff dwelling', 'floating village', 'terraced hillside',
    'coastal path', 'sea cave', 'rocky shoreline', 'sandbar', 'tidal flat',
    'bamboo forest', 'birch grove', 'autumn woodland', 'misty highlands',
    'rolling hills', 'chalk cliffs', 'volcanic island', 'crater lake',
    'frozen lake', 'mountain ridge', 'ravine', 'grotto',
    'abandoned quarry', 'overgrown railway', 'sunken garden', 'walled garden',
    'courtyard garden', 'rooftop terrace', 'balcony overlook', 'bell tower view',
    'marketplace square', 'cobblestone street',
    'canal district', 'old town', 'fishing village', 'mountain monastery',
    'desert oasis', 'palm grove', 'coral shallows',
    'salt pan', 'scrubland', 'atoll', 'lagoon shore', 'river headwaters',
    'olive grove', 'citrus grove', 'fig orchard', 'rose garden',
    'herb garden', 'kitchen garden', 'monastery garden', 'souk alley',
    'casbah rooftop', 'thatched village', 'plantation veranda',
    'palm-lined avenue', 'dune sea', 'redwood forest', 'savanna plain',
    'terraced rice paddies', 'volcanic black-sand beach', 'fjord wall',
    'hill station',
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
    'sunbaked', 'sun-warmed', 'dust-coated', 'salt-sprayed', 'fog-shrouded',
    'sun-drenched', 'candlelit', 'paper-thin', 'glass-walled',
    'bronze-cast', 'lacquered', 'embroidered', 'vine-draped', 'leaf-strewn',
    'sand-strewn', 'flame-touched', 'incense-scented', 'rope-bound',
    'tide-washed',
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
    'harvest moon glow', 'paper lanterns at dusk', 'distant fireworks burst',
    'monsoon downpour shimmer', 'equatorial midday glare', 'dust storm haze',
    'marigold dawn glow', 'jasmine dusk haze', 'river mist morning',
    'shoji paper diffusion', 'harvest gold afternoon', 'brass-warm interior',
    'terracotta-hour glow', 'blossom-pink dawn',
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
    'spirited and breezy', 'hushed and reverent', 'sun-soaked and lazy',
    'sultry and slow', 'jubilant and folkloric', 'tender and homely',
    'languid and tropical', 'rapturous and exuberant', 'wistful and golden',
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
    'amber and sea-glass green as dominant tones with natural colour variation throughout',
    'pomegranate and pearl as dominant tones with natural colour variation throughout',
    'tobacco and saffron as dominant tones with natural colour variation throughout',
    'terracotta and lime as dominant tones with natural colour variation throughout',
    'jasmine cream and persimmon as dominant tones with natural colour variation throughout',
    'lapis and pearl as dominant tones with natural colour variation throughout',
    'copper and aquamarine as dominant tones with natural colour variation throughout',
    'ochre and ruby as dominant tones with natural colour variation throughout',
    'celadon and persimmon as dominant tones with natural colour variation throughout',
    'mahogany and ivory as dominant tones with natural colour variation throughout',
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
    'aerial drone perspective', 'through-the-foliage framing',
    'pavilion-archway framing', 'hilltop sweeping vantage',
    'balcony perspective looking outward', 'curtain-edge peek angle',
  ],
}

// ---------------------------------------------------------------------------
// Diamond descriptor pool — curated for low colour count, wide flat regions.
// Paint-by-numbers needs bold, simple subjects with strong colour separation.
// ---------------------------------------------------------------------------

const DIAMOND_DESCRIPTOR_POOL: Record<DescriptorRole, readonly string[]> = {
  // Concepts have natural medium-scale shapes (~20-60 paintable regions),
  // not microscopic texture. Avoid subjects that imply "hundreds of tiny
  // things" — those collapse to noise at 24 colours and are miserable to
  // paint. Single-subject entries pair with the Setting line below to form
  // varied combinations; compound entries (still-lifes, busy scenes,
  // decorative patterns) carry their own internal composition and are
  // treated as one atomic subject.
  concept: [
    // single hero subjects — animals
    'fox', 'owl', 'stag', 'cat', 'flamingo flock',
    'peacock with tail fan', 'hummingbird among tropical flowers',
    'parrot pair', 'lion pride at rest', 'giraffe family browsing',
    'zebras at a watering hole', 'gorilla in a misty clearing',
    'orangutan in the canopy', 'sea otters floating in kelp',
    'penguin colony', 'puffin colony', 'tortoise',
    'tree frog on a glossy leaf', 'crane in shallow water',
    'whale breaching near fishing boats', 'pelican on a piling',
    'capybara at a river edge', 'tapir in a clearing',
    'lemur troop in a baobab', 'hornbill on a fig branch',
    'macaws in a jungle canopy', 'jaguar resting on a tree branch',
    'elephant beside a river crossing', 'swan pair on a lily pond',
    'meerkats on a kopje', 'fennec fox among dunes',
    'hare among meadow flowers', 'fawn in a clearing',
    'koi pond with lotus flowers and stepping stones',
    'butterfly swarm above wildflowers',
    // single hero subjects — architectural / object
    'lighthouse', 'sailboat on calm water', 'hot air balloon',
    'windmill in a field', 'cottage with garden path',
    'stone bridge over a river', 'chapel on a hill',
    'pagoda in a quiet garden', 'palm tree on a beach',
    'cherry blossom tree by a river', 'autumn tree on a lawn',
    'mountain reflected in a still lake', 'barn under a starry sky',
    'gazebo wrapped in climbing roses', 'wooden footbridge with reeds',
    'stone well in a courtyard', 'beach huts along the shore',
    'fishing boat at anchor', 'olive tree on a hillside',
    'whitewashed bell tower', 'tiled-roof cottage',
    // still-life focal subjects (the arrangement context comes from accents)
    'vase of sunflowers', 'bowl of fruit', 'bowl of lemons',
    'teapot and cups', 'flower cart', 'lantern on a porch',
    'bicycle with flowers in the basket', 'rocking chair on a porch',
    'pomegranates and figs on a copper tray',
    // landscape focal subjects (companion features come from accents)
    'rolling hills at sunset', 'lavender field at dawn',
    'tulip field in rows', 'sunflower field', 'vineyard terrace at dusk',
    'harbour with fishing boats', 'beach scene with umbrellas',
    'terraced rice paddies', 'olive grove', 'citrus grove',
    'desert oasis',
    // busy-scene focal subjects — accents fill in stalls, crowds, props
    'village market square', 'circus tent in a town square',
    'harvest festival', 'canal town', 'seaside promenade',
    'old town plaza', 'carnival parade', 'tea plantation',
    'souk lane', 'harbour fish market', 'monsoon street scene',
    'rooftop view across a tiled city',
    'botanical scene with layered plants',
    'forest clearing with animals around a stream',
    // folk-art / decorative patterns (each is one composition, no accents)
    'stained glass flower panel', 'mandala with 8-fold symmetry',
    'folk-art tree of life with birds and fruit',
    'talavera plate pattern with central motif',
    'paper-cut bird and flower motif', 'quilted heart block',
    'pysanka egg pattern', 'suzani embroidery panel',
    // architectural focal subjects
    'windmill at sunset', 'lighthouse at night',
    'church steeple with cottages', 'Mediterranean harbour at midday',
    'whitewashed village on a hill',
  ],

  location: [
    'garden', 'meadow', 'hillside', 'lakeside', 'seaside', 'riverside',
    'rooftop', 'balcony', 'courtyard', 'field', 'orchard',
    'tropical island', 'snowy peak', 'forest clearing',
    'harbour', 'pier', 'village square', 'mountain pass',
    'riverbank', 'desert vista', 'market street', 'parkland',
    'clifftop', 'terrace', 'canal side', 'woodland path',
    'olive grove', 'citrus grove', 'vineyard ridge', 'herb garden',
    'palm avenue', 'lagoon island', 'rose garden', 'tropical balcony',
    'monastery garden', 'thatched-village edge',
    'desert oasis', 'reed-edged pond', 'cherry blossom park',
    'savanna kopje', 'jungle clearing', 'wisteria walk',
    'tiled rooftop view', 'cobbled lane', 'cypress avenue',
    'baobab plain', 'rice-paddy terrace', 'forest stream',
    'whitewashed alley', 'sunlit veranda',
  ],

  state: [
    'bold', 'vivid', 'vibrant', 'saturated', 'flat-shaded',
    'poster-like', 'graphic', 'high-contrast', 'colour-blocked', 'cel-shaded',
    'posterised', 'stylised', 'decorative', 'detailed but flat',
    'intricate in silhouette', 'densely composed but clean-edged',
    'layered flat shapes', 'richly patterned', 'hand-crafted',
    'retro-styled', 'folk-inspired', 'whimsical', 'ornamental',
    'jewel-toned',
    'paint-thick', 'silkscreen-flat', 'mosaic-clean', 'tile-bordered',
    'lacquer-bright', 'enamel-rich', 'broad-stroked', 'block-printed',
    'banner-bold', 'tapestry-like',
  ],

  lighting: [
    'bright even lighting', 'warm golden light', 'clear daylight',
    'soft diffused light', 'bold sunset glow', 'flat studio lighting',
    'overhead noon light', 'warm afternoon light',
    'cool morning light', 'rosy dawn light', 'late afternoon amber',
    'overcast silvery light', 'pastel twilight glow', 'strong midday sun',
    'gentle backlit haze', 'crisp autumn light',
    'golden afternoon glow', 'paper-lantern dusk', 'amber lamp light',
    'jasmine-dawn pink', 'orange-sky sunset', 'marigold morning light',
    'noon shadow-flat light',
  ],

  mood: [
    'cheerful and bright', 'calm and peaceful', 'warm and inviting',
    'playful and colourful', 'bold and graphic', 'nostalgic and cozy',
    'dreamy and soft', 'festive and lively', 'mysterious and dusky',
    'serene and spacious', 'tender and intimate', 'vibrant and energetic',
    'stately and elegant', 'whimsical and charming',
    'balmy and breezy', 'sun-soaked and joyful', 'sleepy and warm',
    'hushed and contemplative', 'lively and bustling', 'languid and golden',
  ],

  palette: [
    'jewel tones laid down in large flat panels with clean boundaries',
    'stained-glass palette: a dozen saturated flat panels separated by bold dark leading',
    'folk-art palette: primaries, earth tones and one accent in simple, bold shapes',
    'mid-century poster palette: a set of bold flat colours in strong silhouettes',
    'tropical flat palette: turquoise, coral, green, sand, magenta — each as broad zones',
    'autumn flat palette: red, orange, gold, ochre, brown — each as substantial shapes',
    'botanical flat palette: a few greens plus various petal colours as distinct fills',
    'muted Scandinavian palette: pale sky, warm wood, soft red, cream — flat and spacious',
    'seaside palette: navy, white, sky blue, sand, coral — clean and fresh',
    'sunset palette: peach, magenta, gold, violet, deep blue — warm and vivid',
    'earth and spice palette: terracotta, turmeric, olive, cream, charcoal — rich and grounded',
    'winter palette: ice blue, slate, white, berry red, pine green — crisp and cool',
    'Mediterranean palette: cobalt, white, terracotta, lemon, olive — sun-drenched',
    'candy palette: pink, mint, lavender, lemon, peach — sweet and bright',
    'woodland palette: moss, bark brown, fern, amber, mushroom grey — natural and warm',
    'fiesta palette: vermilion, cobalt, sunflower, emerald, hot pink — bold and festive',
    'desert oasis palette: terracotta, palm green, lapis, gold, white — warm and grounded',
    'monsoon palette: deep teal, marigold, ivory, copper, mahogany — moody and rich',
    'citrus-grove palette: lemon, leaf green, ivory, terracotta, sage — bright and cheerful',
    'pomegranate palette: ruby, gold, leaf green, cream, plum — jewel-rich',
    'lagoon palette: turquoise, coral, white, lemon, deep teal — bright tropical',
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
    'gentle aerial overhead with the subject centred',
    'through-archway framing with the scene beyond',
    'balcony perspective looking out across the scene',
    'pavilion-arch framing of the subject',
  ],
}

// ---------------------------------------------------------------------------
// Diamond accent pool — atomic scene details that the rewriter weaves in
// around the chosen Subject + Setting. Each diamond prompt pulls a small
// bag of accents (DIAMOND_ACCENT_COUNT) at build time, and the rewriter is
// instructed to drop any accent that doesn't fit the Subject. The point is
// recombination: the same "village market square" can come with crowds and
// bunting one day, baskets and cypress trees another day.
// ---------------------------------------------------------------------------

const DIAMOND_ACCENT_POOL: readonly string[] = [
  // architecture & town
  'tiled rooftops', 'whitewashed walls', 'shuttered windows',
  'wrought-iron balconies', 'arched doorways', 'painted doors',
  'mosaic floors', 'flagstone paths', 'cobblestone street',
  'awnings', 'striped awnings', 'window boxes',
  'climbing roses', 'climbing vines', 'bougainvillea',
  'bell tower in the distance', 'chimneys', 'painted shutters',
  // market & festival props
  'market stalls', 'stall canopies', 'fruit piles', 'spice mounds',
  'flower bouquets', 'baskets', 'crates', 'cafe tables',
  'striped parasols', 'paper lanterns', 'fairy lights',
  'bunting', 'flag-lined streets', 'garlands', 'banners',
  // people
  'shoppers', 'strollers', 'children playing', 'crowds',
  'families gathered', 'food vendors', 'musicians', 'dancers',
  'workers in the field', 'fishermen', 'a baker at a window',
  // vegetation
  'sunflowers', 'lavender rows', 'tulip rows', 'wildflowers',
  'cypress trees', 'olive trees', 'palm trees', 'citrus trees',
  'cherry blossoms', 'pine trees', 'ferns', 'reeds',
  'fallen leaves', 'ivy on the wall', 'lilies', 'bamboo',
  // food / still-life
  'lemons', 'pomegranates', 'figs', 'painted plates',
  'a teapot', 'cups', 'copper tray', 'bread loaves', 'a jug of oil',
  // maritime
  'fishing boats', 'sailboats', 'rowboats', 'nets drying',
  'crab pots', 'buoys', 'gulls overhead', 'a distant lighthouse',
  'painted boat hulls',
  // landscape features
  'rolling hills', 'distant hills', 'stone walls',
  'terraced fields', 'winding paths', 'haystacks',
  'a quiet stream', 'a lily pond', 'a footbridge',
  // animals as accents
  'a cat lounging', 'pigeons gathered', 'goats grazing',
  'sheep grazing', 'a donkey cart', 'butterflies', 'dragonflies',
  'doves', 'swallows', 'rabbits in the grass',
  // atmosphere & sky
  'puffy clouds', 'crescent moon', 'a rainbow arc',
  'wisps of smoke', 'hot air balloons in the sky', 'kites in the sky',
  'distant fireworks',
]

const DIAMOND_ACCENT_COUNT = 4

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
    qualityTarget:
      'style: distinct subject. wide variety of colours, every shape should be defined by colour rather than outlines',
  },
  diamond: {
    title: 'Diamond Painting',
    composition:
      'Craft a busy scene populated with multiple distinct subjects rendered in vivid focal colours, set against a softly muted, atmospheric background that retains gentle colour but recedes so the focus stays firmly on the subjects, using these elements:',
    qualityTarget:
      'style: busy composition with distinct subjects in vivid colour against a softly muted, atmospheric background that retains gentle colour. Wide variety of colours, every shape should be defined by colour rather than outlines',
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

const PROMPT_OUTPUT_TEMPLATES_DIAMOND = [
  'Output: one landscape 4:3 image that fills the full frame edge to edge. The image is free of text, titles, labels, watermarks, signatures, or lettering of any kind.',
  'Deliver a single landscape 4:3 image with the composition extending to every edge of the frame. The image contains no text, titles, captions, watermarks, signatures, or writing of any kind.',
  'Single 4:3 landscape image, the scene extending to every edge so it fills the full frame. The image is entirely free of text, titles, labels, watermarks, signatures, and lettering.',
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
  const accents = pickAccents(history, new Set(Object.values(set)), category)
  const details = buildCategoryPromptDetails(category, set, accents)

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
    descriptors: [...new Set([...Object.values(set), ...accents])],
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
  const accentsByCategory = {} as Record<PuzzleCategory, readonly string[]>
  const usedInPack = new Set<string>()

  for (const category of CATEGORIES) {
    const set = pickDescriptorSet(recent, usedInPack, category)
    descriptorSetsByCategory[category] = set
    for (const value of Object.values(set)) {
      usedInPack.add(value)
    }

    const accents = pickAccents(recent, usedInPack, category)
    accentsByCategory[category] = accents
    for (const accent of accents) {
      usedInPack.add(accent)
    }
  }

  const pack: PromptPack = {
    // Per-category details
    categories: {
      jigsaw: buildCategoryPromptDetails('jigsaw', descriptorSetsByCategory.jigsaw, accentsByCategory.jigsaw),
      slider: buildCategoryPromptDetails('slider', descriptorSetsByCategory.slider, accentsByCategory.slider),
      swap: buildCategoryPromptDetails('swap', descriptorSetsByCategory.swap, accentsByCategory.swap),
      polygram: buildCategoryPromptDetails('polygram', descriptorSetsByCategory.polygram, accentsByCategory.polygram),
      diamond: buildCategoryPromptDetails('diamond', descriptorSetsByCategory.diamond, accentsByCategory.diamond),
    },
  }

  history.push({
    descriptors: [...usedInPack],
    createdAt: new Date().toISOString(),
  })

  return pack
}

function buildCategoryPromptDetails(
  category: PuzzleCategory,
  set: DescriptorSet,
  accents: readonly string[] = [],
) {
  const parts = buildImagePromptParts(category, set, accents)
  return {
    prompt: `${parts.descriptive}\n\n${parts.technical}`,
    descriptive: parts.descriptive,
    technical: parts.technical,
    theme: `${capitalizeWords(set.state)} ${capitalizeWords(set.concept)} ${capitalizeWords(set.location)} — ${capitalizeWords(set.mood)}`,
    keywords: [...new Set([...Object.values(set), ...accents])].map(v => v.trim()).filter(Boolean).slice(0, 12),
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
  accents: readonly string[] = [],
): { descriptive: string; technical: string } {
  const intent = CATEGORY_PROMPT_INTENTS[category]

  const keywordLines = [
    `Subject: ${set.state} ${set.concept}`,
    `Setting: ${set.location}`,
    `Lighting: ${set.lighting}`,
    `Mood: ${stripMoodSuffix(set.mood)}`,
    `Palette: ${set.palette}`,
    `Camera: ${set.camera}`,
    accents.length > 0 ? `Details: ${accents.join(', ')}` : null,
  ].filter((line): line is string => line !== null)

  // Composition prose tells the LLM HOW to compose; keyword block tells
  // it WHAT to compose with. The rewriter (gemma-rewriter.ts) is told
  // to "transform the descriptive elements into a single, cohesive,
  // imaginative paragraph" — labelled keywords let it pick up role
  // information the flat keywords list it also receives can't convey.
  const descriptive = `${intent.composition}\n\n${keywordLines.join('\n')}`

  const qualityLine = intent.qualityTarget

  const outputLine = category === 'diamond'
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

// Pick a small bag of accent atoms for a category. Currently diamond-only;
// other categories return an empty array (handled as "no Details line").
// Accents share the LRU history so frequently-used atoms get cooled down.
function pickAccents(
  recent: PromptHistoryItem[],
  excluded: Set<string>,
  category: PuzzleCategory,
): readonly string[] {
  if (category !== 'diamond') return []
  const counts = buildUsageCounts(recent)
  const picks: string[] = []
  let working = new Set(excluded)
  for (let i = 0; i < DIAMOND_ACCENT_COUNT; i++) {
    const pick = pickOneDescriptor(DIAMOND_ACCENT_POOL, counts, working)
    picks.push(pick)
    working = new Set([...working, pick])
  }
  return picks
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

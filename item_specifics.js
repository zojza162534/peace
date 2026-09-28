/**
 * item_specifics.js — Philo Universal Item Specifics Engine
 *
 * Maps UNSPSC codes and product keywords → required eBay item specifics
 * Knows exactly where to find each value on Amazon product pages
 *
 * Flow:
 *   Amazon capture → detectProductCategory() → scrape category-specific fields
 *   eBay listing   → fillItemSpecifics()      → fill all required dropdowns
 */

// ── UNSPSC → Category mapping ─────────────────────────────────────────────────
// Key: UNSPSC prefix (first 4–8 digits) or keyword pattern
// Value: category config with Amazon scrapers + eBay attribute names

export const CATEGORY_MAP = [

  // ── EYEWEAR (42142900) ─────────────────────────────────────────────────────
  {
    id:       'eyewear',
    unspsc:   ['42142900'],
    keywords: [/\b(sunglasses|eyeglasses|reading glasses|blue light glasses|safety glasses)\b/i],
    amazonFields: {
      frameColor: {
        // "Style Number" voyager table row → "Black + Transparent" → Multicolor if 2+ words
        rows:   [{ table: 'voyager', header: /style number/i }],
        transform: val => {
          const parts = val.split(/[\s+,\/&]+/).filter(w => w.length > 1);
          return parts.length > 1 ? 'Multicolor' : val;
        },
      },
    },
    ebayAttributes: [
      {
        name:     'Frame Color',
        source:   'frameColor',
        default:  'Black',
        required: true,
      },
      {
        name:     'Department',
        source:   null,          // static default
        default:  'Unisex Adults',
        required: true,
      },
    ],
  },

  // ── MICROPHONES (52161520) ─────────────────────────────────────────────────
  {
    id:       'microphone',
    unspsc:   ['52161520'],
    keywords: [/\b(microphone|mic\b|condenser mic|dynamic mic|vocal mic)\b/i],
    amazonFields: {
      formFactor: {
        rows: [{ table: 'prodDet', header: /microphone form factor|form factor/i }],
      },
      connectivity: {
        rows: [{ table: 'prodDet', header: /connectivity technology|wireless|wired/i }],
      },
      polarPattern: {
        rows: [{ table: 'prodDet', header: /polar pattern|pickup pattern/i }],
      },
    },
    ebayAttributes: [
      {
        name:    'Form Factor',
        source:  'formFactor',
        default: 'Handheld/Stand-Held',
        map: {
          'handheld':   'Handheld/Stand-Held',
          'desktop':    'Desktop Microphone',
          'headset':    'Headset',
          'lavalier':   'Lavalier/Lapel',
          'lapel':      'Lavalier/Lapel',
          'shotgun':    'Shotgun Microphone',
          'condenser':  'Condenser Microphone',
          'dynamic':    'Dynamic Microphone',
          'ribbon':     'Ribbon Microphone',
          'gooseneck':  'Gooseneck',
          'earset':     'Earset Microphone',
          'hanging':    'Hanging Microphone',
          'lectern':    'Lectern Microphone',
        },
        required: true,
      },
      {
        name:    'Connectivity',
        source:  'connectivity',
        default: 'Wired',
        map: {
          'wireless': 'Wireless',
          'wired':    'Wired',
          'usb':      'USB',
          'bluetooth':'Bluetooth',
          'xlr':      'XLR',
        },
        required: false,
      },
    ],
  },

  // ── HEADPHONES / EARBUDS (52161515) ───────────────────────────────────────
  {
    id:       'headphones',
    unspsc:   ['52161515', '52161516'],
    keywords: [/\b(headphones|earbuds|earphones|over.ear|in.ear|on.ear|noise cancelling)\b/i],
    amazonFields: {
      formFactor: {
        rows: [{ table: 'prodDet', header: /form factor|headphone type|style/i }],
      },
      connectivity: {
        rows: [{ table: 'prodDet', header: /connectivity|wireless|wired|bluetooth/i }],
      },
      color: {
        rows: [{ table: 'prodDet', header: /^color$/i }],
        fallback: 'bylineColor',
      },
    },
    ebayAttributes: [
      {
        name:    'Type',
        source:  'formFactor',
        default: 'Headphones',
        map: {
          'over-ear':  'Headphones',
          'over ear':  'Headphones',
          'on-ear':    'Headphones',
          'in-ear':    'In-Ear',
          'earbud':    'Earbuds',
          'earbuds':   'Earbuds',
          'neckband':  'Neckband',
        },
        required: true,
      },
      {
        name:    'Connectivity',
        source:  'connectivity',
        default: 'Wireless',
        map: {
          'wireless':  'Wireless',
          'wired':     'Wired',
          'bluetooth': 'Wireless',
          'usb':       'Wired',
        },
        required: false,
      },
    ],
  },

  // ── CABLES & ADAPTERS (26121600) ──────────────────────────────────────────
  {
    id:       'cables',
    unspsc:   ['26121600', '26121601', '26121602', '26121700'],
    keywords: [/\b(cable|adapter|connector|splitter|converter|hdmi|usb cable|ethernet)\b/i],
    amazonFields: {
      type: {
        rows: [{ table: 'prodDet', header: /^type$|cable type|connector type/i }],
      },
      length: {
        rows: [{ table: 'prodDet', header: /cable length|length|size/i }],
      },
      color: {
        rows: [{ table: 'prodDet', header: /^color$/i }],
      },
    },
    ebayAttributes: [
      {
        name:     'Type',
        source:   'type',
        default:  'Cable',
        required: true,
      },
      {
        name:     'Length',
        source:   'length',
        default:  null,
        required: false,
      },
    ],
  },

  // ── LAPTOPS / COMPUTERS (43211500) ────────────────────────────────────────
  {
    id:       'laptop',
    unspsc:   ['43211500', '43211501', '43211502', '43211503'],
    keywords: [/\b(laptop|notebook|chromebook|macbook|ultrabook)\b/i],
    amazonFields: {
      processor:  { rows: [{ table: 'prodDet', header: /processor|cpu|chip/i }] },
      ram:        { rows: [{ table: 'prodDet', header: /^ram$|memory|installed ram/i }] },
      storage:    { rows: [{ table: 'prodDet', header: /hard drive|storage|ssd|flash/i }] },
      screenSize: { rows: [{ table: 'prodDet', header: /screen size|display size|diagonal/i }] },
      os:         { rows: [{ table: 'prodDet', header: /operating system|os/i }] },
    },
    ebayAttributes: [
      { name: 'Processor',    source: 'processor',  default: null, required: true  },
      { name: 'RAM',          source: 'ram',         default: null, required: true  },
      { name: 'Storage',      source: 'storage',     default: null, required: true  },
      { name: 'Screen Size',  source: 'screenSize',  default: null, required: false },
      { name: 'Operating System', source: 'os',      default: null, required: false },
    ],
  },

  // ── PHONES / SMARTPHONES (43191501) ──────────────────────────────────────
  {
    id:       'smartphone',
    unspsc:   ['43191501', '43191500'],
    keywords: [/\b(smartphone|iphone|galaxy|pixel phone|android phone|cell phone)\b/i],
    amazonFields: {
      storage:     { rows: [{ table: 'prodDet', header: /storage|capacity/i }] },
      color:       { rows: [{ table: 'prodDet', header: /^color$/i }] },
      network:     { rows: [{ table: 'prodDet', header: /network|carrier|compatible/i }] },
      screenSize:  { rows: [{ table: 'prodDet', header: /screen size|display/i }] },
    },
    ebayAttributes: [
      { name: 'Storage Capacity', source: 'storage', default: null, required: true  },
      { name: 'Color',            source: 'color',   default: null, required: true  },
      { name: 'Network',          source: 'network', default: 'Unlocked', required: false },
    ],
  },

  // ── CLOTHING (53100000) ───────────────────────────────────────────────────
  {
    id:       'clothing',
    unspsc:   ['53100000', '53101500', '53101600', '53101700', '53102000'],
    keywords: [/\b(shirt|pants|jeans|dress|jacket|hoodie|sweater|shorts|skirt|coat)\b/i],
    amazonFields: {
      size:       { rows: [{ table: 'prodDet', header: /^size$|clothing size/i }] },
      color:      { rows: [{ table: 'prodDet', header: /^color$|colour/i }] },
      material:   { rows: [{ table: 'prodDet', header: /material|fabric|composition/i }] },
      gender:     { rows: [{ table: 'prodDet', header: /gender|department/i }] },
    },
    ebayAttributes: [
      { name: 'Size',       source: 'size',     default: null,   required: true  },
      { name: 'Color',      source: 'color',    default: null,   required: true  },
      { name: 'Material',   source: 'material', default: null,   required: false },
      { name: 'Department', source: 'gender',   default: 'Unisex Adults', required: false },
    ],
  },

  // ── SHOES / FOOTWEAR (53111500) ───────────────────────────────────────────
  {
    id:       'bags',
    unspsc:   [],
    keywords: [/\b(tote bag|tote|handbag|purse|shoulder bag|crossbody|satchel|hobo bag|bag)\b/i],
    amazonFields: {
      color:    { rows: [{ table: 'prodDet', header: /^color$|colour|pattern name|style name/i }] },
      material: { rows: [{ table: 'prodDet', header: /material|fabric|composition/i }] },
    },
    ebayAttributes: [
      { name: 'Color',    source: 'color',    default: null, required: true  },
      { name: 'Material', source: 'material', default: null, required: false },
    ],
  },

  {
    id:       'shoes',
    unspsc:   ['53111500', '53111501', '53111600'],
    keywords: [/\b(shoes|sneakers|boots|sandals|loafers|heels|flats|running shoes)\b/i],
    amazonFields: {
      size:    { rows: [{ table: 'prodDet', header: /shoe size|size|us size/i }] },
      color:   { rows: [{ table: 'prodDet', header: /^color$/i }] },
      width:   { rows: [{ table: 'prodDet', header: /width|shoe width/i }] },
      gender:  { rows: [{ table: 'prodDet', header: /gender|department/i }] },
    },
    ebayAttributes: [
      { name: 'US Shoe Size',  source: 'size',   default: null, required: true  },
      { name: 'Color',         source: 'color',  default: null, required: true  },
      { name: 'Width',         source: 'width',  default: null, required: false },
      { name: 'Department',    source: 'gender', default: 'Unisex Adults', required: false },
    ],
  },

  // ── CLEANING / DISINFECTANTS (47131500) ───────────────────────────────────
  {
    id:       'cleaning',
    unspsc:   ['47131500', '47131501', '47131502', '47131600'],
    keywords: [/\b(bleach|disinfect|sanitiz|cleaner|wipes|cleaning|germicidal|antibacterial)\b/i],
    amazonFields: {
      scent:    { rows: [{ table: 'prodDet', header: /scent|fragrance/i }] },
      size:     { rows: [{ table: 'prodDet', header: /size|count|volume|fluid ounce/i }] },
      form:     { rows: [{ table: 'prodDet', header: /^form$|item form|product form/i }] },
    },
    ebayAttributes: [
      { name: 'Scent',  source: 'scent', default: 'Unscented', required: false },
      { name: 'Size',   source: 'size',  default: null,         required: false },
    ],
  },

  // ── TOOLS / POWER TOOLS (27111500) ───────────────────────────────────────
  {
    id:       'tools',
    unspsc:   ['27111500', '27111600', '27111700', '27112000'],
    keywords: [/\b(drill|saw|wrench|screwdriver|hammer|pliers|grinder|sander|power tool)\b/i],
    amazonFields: {
      powerSource: { rows: [{ table: 'prodDet', header: /power source|battery|corded/i }] },
      voltage:     { rows: [{ table: 'prodDet', header: /voltage|volt/i }] },
      color:       { rows: [{ table: 'prodDet', header: /^color$/i }] },
    },
    ebayAttributes: [
      { name: 'Power Source', source: 'powerSource', default: null, required: false },
      { name: 'Voltage',      source: 'voltage',     default: null, required: false },
    ],
  },

  // ── KITCHEN APPLIANCES (52141500) ─────────────────────────────────────────
  {
    id:       'kitchen_appliance',
    unspsc:   ['52141500', '52141501', '52141502', '52141600'],
    keywords: [/\b(blender|toaster|coffee maker|air fryer|instant pot|microwave|mixer|juicer)\b/i],
    amazonFields: {
      capacity: { rows: [{ table: 'prodDet', header: /capacity|volume|size/i }] },
      wattage:  { rows: [{ table: 'prodDet', header: /wattage|watts|power/i }] },
      color:    { rows: [{ table: 'prodDet', header: /^color$/i }] },
    },
    ebayAttributes: [
      { name: 'Capacity',     source: 'capacity', default: null, required: false },
      { name: 'Power (Watts)',source: 'wattage',  default: null, required: false },
      { name: 'Color',        source: 'color',    default: null, required: false },
    ],
  },

  // ── VITAMINS / SUPPLEMENTS (51182300) ────────────────────────────────────
  {
    id:       'supplements',
    unspsc:   ['51182300', '51182301', '51182302'],
    keywords: [/\b(vitamin|supplement|protein powder|probiotic|fish oil|collagen|creatine)\b/i],
    amazonFields: {
      flavor:  { rows: [{ table: 'prodDet', header: /flavor|flavour/i }] },
      count:   { rows: [{ table: 'prodDet', header: /item count|count|quantity|servings/i }] },
      form:    { rows: [{ table: 'prodDet', header: /item form|form|type/i }] },
    },
    ebayAttributes: [
      { name: 'Flavor',    source: 'flavor', default: null,     required: false },
      { name: 'Unit Count',source: 'count',  default: null,     required: false },
      { name: 'Form',      source: 'form',   default: null,     required: false },
    ],
  },

  // ── TOYS / GAMES (60141100) ───────────────────────────────────────────────
  {
    id:       'toys',
    unspsc:   ['60141100', '60141101', '60141200', '60141300'],
    keywords: [/\b(toy|lego|action figure|board game|puzzle|doll|rc car|remote control)\b/i],
    amazonFields: {
      ageRange:  { rows: [{ table: 'prodDet', header: /age range|recommended age|age/i }] },
      material:  { rows: [{ table: 'prodDet', header: /material|made of/i }] },
    },
    ebayAttributes: [
      { name: 'Age Range',  source: 'ageRange', default: null, required: false },
      { name: 'Material',   source: 'material', default: null, required: false },
    ],
  },

  // ── PRINTERS (43212100) ───────────────────────────────────────────────────
  {
    id:       'printer',
    unspsc:   ['43212100', '43212101'],
    keywords: [/\b(printer|inkjet|laser printer|all.in.one printer)\b/i],
    amazonFields: {
      connectivity: { rows: [{ table: 'prodDet', header: /connectivity|wireless|wired/i }] },
      printTech:    { rows: [{ table: 'prodDet', header: /print technology|printer type/i }] },
      color:        { rows: [{ table: 'prodDet', header: /^color$/i }] },
    },
    ebayAttributes: [
      { name: 'Connectivity',         source: 'connectivity', default: 'USB', required: false },
      { name: 'Print Technology',     source: 'printTech',    default: null,   required: false },
    ],
  },

  // ── CAMERAS (45121500) ────────────────────────────────────────────────────
  {
    id:       'camera',
    unspsc:   ['45121500', '45121501', '45121502', '45121503'],
    keywords: [/\b(camera|dslr|mirrorless|action camera|webcam|security camera)\b/i],
    amazonFields: {
      megapixels:  { rows: [{ table: 'prodDet', header: /megapixel|resolution|effective pixels/i }] },
      optical:     { rows: [{ table: 'prodDet', header: /optical zoom/i }] },
      connectivity:{ rows: [{ table: 'prodDet', header: /connectivity|wireless/i }] },
    },
    ebayAttributes: [
      { name: 'Megapixels',  source: 'megapixels',  default: null, required: false },
      { name: 'Optical Zoom',source: 'optical',      default: null, required: false },
    ],
  },

  // ── FURNITURE (56101500) ──────────────────────────────────────────────────
  {
    id:       'furniture',
    unspsc:   ['56101500', '56101501', '56101600', '56111500'],
    keywords: [/\b(desk|chair|sofa|couch|table|bookshelf|dresser|bed frame|ottoman)\b/i],
    amazonFields: {
      material: { rows: [{ table: 'prodDet', header: /material|made of|frame material/i }] },
      color:    { rows: [{ table: 'prodDet', header: /^color$|finish/i }] },
      style:    { rows: [{ table: 'prodDet', header: /^style$|design style/i }] },
    },
    ebayAttributes: [
      { name: 'Material', source: 'material', default: null, required: false },
      { name: 'Color',    source: 'color',    default: null, required: false },
      { name: 'Style',    source: 'style',    default: null, required: false },
    ],
  },

  // ── FITNESS EQUIPMENT (49201500) ─────────────────────────────────────────
  {
    id:       'fitness',
    unspsc:   ['49201500', '49201501', '49201600'],
    keywords: [/\b(dumbbell|kettlebell|resistance band|yoga mat|treadmill|exercise bike|weight)\b/i],
    amazonFields: {
      weight:   { rows: [{ table: 'prodDet', header: /item weight|weight|lbs|kg/i }] },
      material: { rows: [{ table: 'prodDet', header: /material/i }] },
      color:    { rows: [{ table: 'prodDet', header: /^color$/i }] },
    },
    ebayAttributes: [
      { name: 'Weight',   source: 'weight',   default: null, required: false },
      { name: 'Material', source: 'material', default: null, required: false },
      { name: 'Color',    source: 'color',    default: null, required: false },
    ],
  },
];

// ── Amazon scraping helpers ───────────────────────────────────────────────────

/**
 * Scrape a value from Amazon's product details tables.
 * Supports 'prodDet' (main product details) and 'voyager' (B2B table).
 */
export function scrapeAmazonField(fieldConfig, document = window.document) {
  for (const { table, header } of (fieldConfig.rows || [])) {
    const rows = table === 'voyager'
      ? document.querySelectorAll('tr')
      : document.querySelectorAll(
          '#productDetails_techSpec_section_1 tr, ' +
          '#productDetails_techSpec_section_2 tr, ' +
          '#productDetails_db_sections tr, ' +
          '.prodDetTable tr, ' +
          '#detailBulletsWrapper_feature_div li'
        );

    for (const row of rows) {
      const th = table === 'voyager'
        ? row.querySelector('th.voyager-ns-desktop-table-label')
        : row.querySelector('th.a-color-secondary, th.prodDetSectionEntry, td:first-child, span.a-text-bold');
      const td = table === 'voyager'
        ? row.querySelector('td.voyager-ns-desktop-table-value')
        : row.querySelector('td.a-size-base.prodDetAttrValue, td:last-child, span:not(.a-text-bold)');

      if (th && td && header.test(th.textContent)) {
        const raw = td.textContent.trim();
        return fieldConfig.transform ? fieldConfig.transform(raw) : raw;
      }
    }
  }
  return null;
}

/**
 * Detect which category config applies to this product.
 * Checks UNSPSC code in page, then title keywords.
 */
export function detectCategory(unspscCode, title = '') {
  for (const cat of CATEGORY_MAP) {
    if (unspscCode && cat.unspsc.some(u => unspscCode.startsWith(u))) return cat;
    if (cat.keywords?.some(k => k.test(title))) return cat;
  }
  return null;
}

/**
 * Run on Amazon page: detect category + scrape all required fields.
 * Returns categoryData object to store on the product.
 */
export function scrapeAllCategoryFields(unspscCode, title) {
  const cat = detectCategory(unspscCode, title);
  if (!cat) return null;

  const scraped = {};
  for (const [fieldKey, fieldConfig] of Object.entries(cat.amazonFields || {})) {
    const val = scrapeAmazonField(fieldConfig);
    if (val) scraped[fieldKey] = val;
  }

  return { categoryId: cat.id, scraped };
}

/**
 * Map a raw Amazon value to an eBay menu label using the attribute's map.
 */
export function mapToEbayValue(attrConfig, rawValue) {
  if (!rawValue) return attrConfig.default;
  if (!attrConfig.map) return rawValue; // no mapping needed, use as-is

  const lower = rawValue.toLowerCase().trim();
  // Exact match
  if (attrConfig.map[lower]) return attrConfig.map[lower];
  // Partial match
  for (const [k, v] of Object.entries(attrConfig.map)) {
    if (lower.includes(k)) return v;
  }
  return attrConfig.default || rawValue;
}

/**
 * Get the list of eBay attributes to fill for a given category.
 * Returns [{ name, value, required }] ready for fillAttributeDropdown().
 */
export function getEbayAttributesToFill(categoryData) {
  if (!categoryData) return [];
  const cat = CATEGORY_MAP.find(c => c.id === categoryData.categoryId);
  if (!cat) return [];

  return cat.ebayAttributes.map(attr => ({
    name:     attr.name,
    value:    mapToEbayValue(attr, categoryData.scraped?.[attr.source]),
    required: attr.required,
  })).filter(a => a.value); // skip if no value and no default
}

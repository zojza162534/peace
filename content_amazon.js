(function () {

  // Enrich mode: background sets window.__philoEnrich before injecting this file
  // to scrape a bulk item's full product page. In that mode we return data via
  // message and never save to the queue or show alerts.
  const ENRICH_MODE = (typeof window !== 'undefined' && window.__philoEnrich === true);

  // ── Item Specifics Engine (inlined from item_specifics.js) ──
/**
 * item_specifics.js — PhiloShip Universal Item Specifics Engine
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

const CATEGORY_MAP = [

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
function scrapeAmazonField(fieldConfig, document = window.document) {
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
function detectCategory(unspscCode, title = '') {
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
function scrapeAllCategoryFields(unspscCode, title) {
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
function mapToEbayValue(attrConfig, rawValue) {
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


  function buildPreferredAmazonUrl() {
    try {
      const current = new URL(window.location.href);
      const asinFromPage = document.querySelector("#ASIN")?.value || "";
      const isProductPath = /\/(?:dp|gp\/product|gp\/aw\/d)\//i.test(current.pathname);

      if (!isProductPath || !asinFromPage) {
        return current.href;
      }

      const preferred = new URL(`https://www.amazon.com/dp/${asinFromPage}`);
      const th = current.searchParams.get("th");
      const psc = current.searchParams.get("psc");
      if (th) preferred.searchParams.set("th", th);
      if (psc) preferred.searchParams.set("psc", psc);
      return preferred.toString();
    } catch {
      return window.location.href;
    }
  }
  // ── TITLE ──────────────────────────────────────────────────────────────────
  const title = document.getElementById("productTitle")?.textContent.trim();

  // ── PRICE — target the core offer price, not any price on the page ──────────
  // Priority: corePriceDisplay → apex_offerDisplay → corePrice_feature_div → fallback
  // Parse a currency amount from text. Prefers a proper 2-decimal amount
  // ($1,234.56) so we never mistake a stray number for the price.
  function parsePriceText(text) {
    const s = String(text || "").replace(/,/g, "");
    let m = s.match(/(\d+\.\d{2})(?!\d)/);      // proper price with 2 decimals
    if (m) return parseFloat(m[1]);
    m = s.match(/\$\s*(\d+(?:\.\d+)?)/);          // "$" followed by a number
    if (m) return parseFloat(m[1]);
    m = s.match(/(\d+(?:\.\d+)?)/);               // last resort: any number
    return m ? parseFloat(m[1]) : NaN;
  }

  // Amazon shows a per-unit price ("$5.21 / Count", "($5.21/Fl Oz)") next to the
  // real price ("$52.10"). Scraping that per-unit price is what caused listings
  // like 5.21 instead of 52.10. Detect and skip per-unit contexts.
  function isPerUnitPriceEl(el) {
    if (!el) return false;
    // Amazon marks per-unit prices as the "mini" size price.
    const priceBlock = el.closest ? el.closest(".a-price") : null;
    if (priceBlock && priceBlock.getAttribute("data-a-size") === "mini") return true;
    let node = el;
    for (let i = 0; i < 3 && node; i++) {
      const t = (node.textContent || "").toLowerCase();
      if (/\/\s*(count|ct|ounce|oz|fl\s*oz|fl\.?\s*oz|sheet|load|each|item|gram|kg|ml|l|pack|foot|ft|sq\s*ft)\b/.test(t)) return true;
      if (/\bper\s+(count|ounce|oz|item|sheet|load|unit)\b/.test(t)) return true;
      if (/\(\s*\$\s*[\d.,]+\s*\//.test(t)) return true; // "($5.21 / ...)"
      node = node.parentElement;
    }
    return false;
  }

  function scrapePrice() {
    // Selectors in priority order — most reliable first
    const selectors = [
      '#corePrice_feature_div .a-price[data-a-size="xl"] .a-offscreen',
      '#corePrice_feature_div .a-price:not([data-a-size="mini"]) .a-offscreen',
      '#apex_offerDisplay_desktop .a-price:not([data-a-size="mini"]) .a-offscreen',
      '#corePrice_desktop .a-price:not([data-a-size="mini"]) .a-offscreen',
      '#price_inside_buybox',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.priceToPay .a-offscreen',
      '.apexPriceToPay .a-offscreen',
    ];
    for (const sel of selectors) {
      // Check every match for this selector, skipping per-unit prices, and take
      // the first real one.
      for (const el of document.querySelectorAll(sel)) {
        if (isPerUnitPriceEl(el)) continue;
        const val = parsePriceText(el.textContent);
        if (!isNaN(val) && val > 0) return val;
      }
    }
    // Last resort: .a-price-whole + .a-price-fraction inside the buy box (skip per-unit)
    const buybox = document.querySelector('#buybox, #rightCol, #apex_desktop');
    const pickWholeFraction = (scope) => {
      if (!scope) return NaN;
      const wholeEl = Array.from(scope.querySelectorAll('.a-price-whole')).find(w => !isPerUnitPriceEl(w));
      if (!wholeEl) return NaN;
      const whole = (wholeEl.textContent || "").replace(/[^\d]/g, "");
      if (!whole) return NaN;
      const fracEl = wholeEl.closest('.a-price')?.querySelector('.a-price-fraction');
      const fraction = ((fracEl?.textContent || "00").replace(/[^\d]/g, "") + "00").slice(0, 2);
      return parseFloat(`${whole}.${fraction}`);
    };
    let val = pickWholeFraction(buybox);
    if (!isNaN(val) && val > 0) return val;
    val = pickWholeFraction(document);
    return isNaN(val) ? NaN : val;
  }

  const price = scrapePrice();

  // ── REBATE / COUPON DETECTION ──────────────────────────────────────────────
  // Flag products that carry an Amazon coupon / promo / rebate so they can be
  // prioritized in the queue (typically higher margin after the discount).
  function scrapeRebate() {
    const selectors = [
      '#couponText_feature_div',
      '.couponLabelText',
      '#promoPriceBlockMessage_feature_div',
      '#promoPriceBlockMessage',
      '.newCouponBadge',
      '.couponBadge',
      '#applicablePromotionList',
      '#dealBadge_feature_div',
      '[data-csa-c-coupon]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && /coupon|save|% ?off|off coupon|promotion|rebate|clip/i.test(text)) {
        return { eligible: true, text: text.slice(0, 120) };
      }
    }
    // "Apply $X coupon" / "Save X% with coupon" checkbox row
    const couponRow = document.querySelector('label[id*="coupon" i], [id*="couponText" i], [class*="coupon" i]');
    if (couponRow) {
      const t = (couponRow.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && /coupon|save|% ?off/i.test(t)) return { eligible: true, text: t.slice(0, 120) };
    }
    return { eligible: false, text: '' };
  }

  const rebate = scrapeRebate();
  if (rebate.eligible) console.log('PhiloShip: rebate/coupon detected —', rebate.text);

  if (!title || isNaN(price)) {
    if (ENRICH_MODE) {
      try { chrome.runtime.sendMessage({ type: 'philo_enriched_product', product: null, failed: true }); } catch (e) {}
    } else {
      alert("❌ Error: Could not parse product data. Make sure you are on an Amazon product page.");
    }
    return;
  }

  // ── VARIATIONS & RATING ────────────────────────────────────────────────────
  const hasVariations = !!document.getElementById("twister");
  const rating = document.querySelector(".a-icon-alt")?.textContent.split(" ")[0] || "";

  // ── IMAGES — use high-res URLs (EcomSniper: data-old-hires from .imgTagWrapper) ──
  let images = [];
  try {
    const seen = new Set();
    function addImg(url) {
      if (url && url.startsWith('http') && !seen.has(url)) { seen.add(url); images.push(url); }
    }

    // Method 1: .imgTagWrapper img[data-old-hires]
    document.querySelectorAll('.imgTagWrapper img').forEach(img => {
      addImg(img.getAttribute('data-old-hires') || img.getAttribute('data-a-hires'));
    });

    // Method 2: ImageBlockATF script hiRes URLs
    document.querySelectorAll('script').forEach(s => {
      if (s.innerText.includes('ImageBlockATF') || s.innerText.includes('colorImages')) {
        const m = s.innerText.match(/'hiRes'\s*:\s*'(https[^']+)'/g) ||
                  s.innerText.match(/"hiRes"\s*:\s*"(https[^"]+)"/g);
        if (m) m.forEach(match => addImg(match.match(/https[^'"]+/)?.[0]));
      }
    });

    // Method 3: data-a-dynamic-image (sorted by resolution)
    if (images.length < 3) {
      const imgData = document.querySelector('#landingImage')?.getAttribute('data-a-dynamic-image');
      if (imgData) {
        Object.entries(JSON.parse(imgData))
          .sort((a, b) => (b[1][0]*b[1][1]) - (a[1][0]*a[1][1]))
          .forEach(([url]) => addImg(url));
      }
    }

    // Method 4: #altImages thumbnails — upsized to full resolution
    if (images.length < 3) {
      Array.from(document.querySelectorAll('#altImages img'))
        .map(i => (i.getAttribute('src') || i.src || '').replace(/\._[A-Z0-9_,]+_\./, '.'))
        .forEach(url => addImg(url));
    }

    // Method 5: all product images on the page as last resort
    if (images.length < 3) {
      Array.from(document.querySelectorAll('img[src*="media-amazon.com/images/I/"]'))
        .map(i => i.src.replace(/\._[A-Z0-9_,]+_\./, '.'))
        .filter(u => u.includes('media-amazon.com'))
        .forEach(url => addImg(url));
    }

    if (images.length < 3) console.warn(`PhiloShip: only ${images.length} image(s) found`);
    else console.log(`PhiloShip: ${images.length} images scraped`);
  } catch (e) {
    console.warn('PhiloShip: image scrape error', e.message);
  }

  // ── DESCRIPTION ────────────────────────────────────────────────────────────
  let description = "";
  const bulletItems = document.querySelectorAll("#feature-bullets ul li span.a-list-item");
  if (bulletItems.length > 0) {
    description = Array.from(bulletItems)
      .map(el => el.textContent.trim())
      .filter(t => t.length > 0)
      .join(" | ");
  }

  if (!description) {
    const descBlock = document.querySelector("#productDescription p, #aplus .aplus-v2");
    if (descBlock) {
      description = descBlock.textContent.trim().replace(/\s\s+/g, " ");
    }
  }

  // Sanitise: strip Amazon branding AND eBay-banned words at capture time
  const EBAY_BANNED = /\b(amazon|amazon\.com|amazons|prime|prime eligible|fulfilled by amazon|fba|amzn|walmart|target|alibaba|aliexpress|wish\.com|free shipping|free returns|warranty|guaranteed|money back guarantee|best seller|bestseller|exclusive|limited time|act now|order now|click here|buy now|add to cart|sponsored|advertisement|authentic guaranteed)\b/gi;

  description = description
    .replace(/Visit the .* store/gi, "")
    .replace(/Amazon\.com/gi, "")
    .replace(EBAY_BANNED, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Also sanitize the title
  const cleanTitle = title
    .replace(EBAY_BANNED, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // ── BUILD PRODUCT OBJECT ───────────────────────────────────────────────────
  // ASIN extraction — exact port of EcomSniper's _0x39b1d2
  // Method 1: hidden input #ASIN
  let asin = document.getElementById('ASIN')?.value || '';
  // Method 2: <meta name="ASIN"> tag
  if (!asin) {
    const metas = document.getElementsByTagName('meta');
    for (const meta of metas) {
      if (meta.getAttribute('name') === 'ASIN') {
        asin = meta.getAttribute('content') || '';
        break;
      }
    }
  }
  // Method 3: regex from URL /dp/XXXXXXXXXX
  if (!asin) {
    const urlMatch = location.href.match(/\/dp\/([A-Z0-9]{10})/);
    asin = urlMatch?.[1] || '';
  }
  if (!asin) asin = String(Date.now()); // last resort
  const canonicalUrl = buildPreferredAmazonUrl();

  // Brand AND Type from Amazon product details table
  // Exact selector: th.prodDetSectionEntry + td.a-size-base.prodDetAttrValue
  let brand = '';
  let productType = '';

  const allDetailRows = document.querySelectorAll(
    '#productDetails_techSpec_section_1 tr, ' +
    '#productDetails_db_sections tr, ' +
    '#productDetails_techSpec_section_2 tr, ' +
    '.prodDetTable tr, ' +
    '#detailBulletsWrapper_feature_div li'
  );

  for (const row of allDetailRows) {
    const header = row.querySelector('th.a-color-secondary, th.prodDetSectionEntry, td:first-child, span.a-text-bold');
    const valCell = row.querySelector('td.a-size-base.prodDetAttrValue, td:last-child, span:not(.a-text-bold)');
    if (!header || !valCell) continue;
    const headerText = header.textContent.trim().toLowerCase();
    const value = valCell.textContent.trim();

    if (!brand && /\bbrand\b/.test(headerText))        brand = value;
    if (!productType && /\bitem type\b|\btype\b|\bform factor\b|\bstyle\b|\bproduct type\b/.test(headerText)) productType = value;
    if (!productType && /\bmanufacturer\b/.test(headerText)) productType = value; // use Manufacturer as Type fallback
  }

  // Fallback brand sources
  if (!brand) {
    brand = document.querySelector('.po-brand .po-break-word')?.textContent.trim() ||
            document.querySelector('#bylineInfo')?.textContent.replace(/Visit the|Store/gi, '').trim() ||
            '';
  }
  // Fallback type: use first 3 meaningful title words after brand
  if (!productType && title) {
    const words = title.split(' ').filter(w => w.toLowerCase() !== brand.toLowerCase() && w.length > 2);
    productType = words.slice(0, 3).join(' ');
  }

  // ── UNIVERSAL CATEGORY DETECTION ─────────────────────────────────────────
  // Extract UNSPSC code from page if present
  let unspscCode = '';
  const unspscEl = Array.from(document.querySelectorAll('.a-list-item, li, span'))
    .find(el => el.textContent.includes('UNSPSC Code'));
  if (unspscEl) {
    const m = unspscEl.textContent.match(/UNSPSC Code[^0-9]*([0-9]{6,10})/);
    if (m) unspscCode = m[1];
  }

  // Scrape all category-specific fields using the item_specifics engine
  const categoryData = scrapeAllCategoryFields(unspscCode, title);
  if (categoryData) console.log('PhiloShip: detected category:', categoryData.categoryId, categoryData.scraped);

  // Scrape "Range" from product details table → used for Device Charging Range on eBay
  let chargingRangeMax = '';
  for (const row of document.querySelectorAll('tr')) {
    const th = row.querySelector('th.a-color-secondary, th.prodDetSectionEntry');
    const td = row.querySelector('td.prodDetAttrValue, td.a-size-base');
    if (th && td && /^\s*range\s*$/i.test(th.textContent)) {
      chargingRangeMax = td.textContent.trim();
      console.log('PhiloShip Amazon scrape: chargingRangeMax =', chargingRangeMax);
      break;
    }
  }

  function cleanShadeValue(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/^(?:shade|color|colour|style|pattern)\s*[:\-]\s*/i, '')
      .replace(/\b(?:currently selected|selected)\b/ig, '')
      .trim()
      .slice(0, 65);
  }

  function looksUsableShade(value) {
    const text = cleanShadeValue(value);
    return !!text &&
      text.length <= 65 &&
      !/^(select|choose|see options|not applicable|n\/a)$/i.test(text) &&
      !/^\$/.test(text);
  }

  function scrapeAmazonShadeFromTitle(titleText) {
    const shadeWords = [
      'dark brown', 'medium brown', 'light brown', 'soft brown', 'ash brown',
      'chocolate brown', 'black brown', 'espresso', 'taupe', 'auburn',
      'blonde', 'black', 'brown', 'gray', 'grey', 'clear', 'transparent',
      'ivory', 'beige', 'nude', 'pink', 'rose', 'red', 'coral', 'berry',
      'caramel', 'honey', 'fair', 'light', 'medium', 'dark', 'deep'
    ];
    const normalizedTitle = String(titleText || '').toLowerCase();
    return shadeWords.find(word => new RegExp(`\\b${word.replace(/\s+/g, '\\s+')}\\b`, 'i').test(normalizedTitle)) || '';
  }

  function scrapeAmazonShade(titleText) {
    const directSelectors = [
      '#variation_color_name .selection',
      '#variation_style_name .selection',
      '#variation_pattern_name .selection',
      '[id*="inline-twister-expanded-dimension-text"]',
      '[class*="po-shade"] .po-break-word',
      '[class*="po-color"] .po-break-word'
    ];

    for (const selector of directSelectors) {
      const value = cleanShadeValue(document.querySelector(selector)?.textContent);
      if (looksUsableShade(value)) return value;
    }

    for (const row of document.querySelectorAll('tr, #detailBulletsWrapper_feature_div li')) {
      const header = row.querySelector('th.a-color-secondary, th.prodDetSectionEntry, td:first-child, span.a-text-bold');
      const valCell = row.querySelector('td.a-size-base.prodDetAttrValue, td:last-child, span:not(.a-text-bold)');
      if (!header || !valCell) continue;
      if (!/\b(shade|color|colour|color name|style name)\b/i.test(header.textContent)) continue;
      const value = cleanShadeValue(valCell.textContent);
      if (looksUsableShade(value)) return value;
    }

    return scrapeAmazonShadeFromTitle(titleText);
  }

  const shade = scrapeAmazonShade(title);
  if (shade) console.log('PhiloShip Amazon scrape: shade =', shade);

  // Legacy individual fields derived from categoryData
  const microphoneData = categoryData?.categoryId === 'microphone'
    ? { isMicrophone: true, formFactor: categoryData.scraped?.formFactor || '' }
    : null;
  if (microphoneData) {
    console.log('PhiloShip Amazon scrape: formFactor =', microphoneData.formFactor || '(empty — not found in product details table)');
  }

  let eyewearData = null;
  if (categoryData?.categoryId === 'eyewear') {
    eyewearData = {
      isEyewear:  true,
      frameColor: categoryData.scraped?.frameColor || '',
      department: 'Unisex Adults',
    };
  } else if (unspscCode === '42142900') {
    // Fallback: direct scrape for eyewear
    let styleNumber = '';
    for (const row of document.querySelectorAll('tr')) {
      const th = row.querySelector('th.voyager-ns-desktop-table-label, th');
      const td = row.querySelector('td.voyager-ns-desktop-table-value, td');
      if (th && td && /style number/i.test(th.textContent)) { styleNumber = td.textContent.trim(); break; }
    }
    const colorWords = styleNumber.split(/[\s+,\/&]+/).filter(w => w.length > 1);
    eyewearData = {
      isEyewear:  true,
      frameColor: colorWords.length > 1 ? 'Multicolor' : styleNumber,
      department: 'Unisex Adults',
    };
  }

  const product = {
    id: asin || String(Date.now()),
    asin,
    brand,
    productType,
    eyewearData,
    microphoneData,
    categoryData,
    color: categoryData?.scraped?.color || '',
    chargingRangeMax,
    shade,
    title: cleanTitle,
    custom_title: cleanTitle,
    price,
    custom_price: price,
    rebateEligible: rebate.eligible,
    rebateText: rebate.text,
    description,
    descriptionHTML: description,
    images: images.slice(0, 12),
    main_hd_images: images.slice(0, 12),
    main_sd_images: [],
    selected_image: images[0] || '',
    url: canonicalUrl,
    rating,
    hasVariations,
    status: "active",
    lastSync: Date.now()
  };

  // ── ENRICH MODE vs NORMAL SNIPE ────────────────────────────────────────────
  // Background sets window.__philoEnrich = true before injecting this file when
  // it's enriching a bulk-sniped item. In that mode we send the full scraped
  // product back to the background (which merges it into the queue) and do NOT
  // save or alert. In normal mode (popup "Snipe" button) we save + alert.
  if (ENRICH_MODE) {
    try {
      chrome.runtime.sendMessage({ type: 'philo_enriched_product', product });
    } catch (e) { /* background may be busy; enrichment will time out and keep thin data */ }
    return;
  }

  // ── SAVE TO QUEUE (normal snipe) ────────────────────────────────────────────
  chrome.storage.local.get({ queue: [] }, data => {
    const filtered = data.queue.filter(p => p.id !== product.id);
    chrome.storage.local.set({ queue: [product, ...filtered] }, () => {
      alert(`✅ Sniped: "${cleanTitle.slice(0, 50)}..."\n💰 Price: $${price}\n📝 Description: ${description ? "Captured" : "Not found"}`);
    });
  });
})();

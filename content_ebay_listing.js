/**
 * content_ebay_listing.js — PhiloShip eBay Listing Engine
 * Exact port of EcomSniper bundle 9, 11, 12 logic.
 *
 * Pages handled:
 *   sl/prelist/suggest  — type title, submit
 *   sl/prelist/identify — click category card, condition, continue
 *   lstng?*             — fill all fields via direct .value + change event
 */
(function () {

  // Version stamp — if you don't see this exact line in the eBay tab's console,
  // the browser is running an OLD copy of the extension and none of the recent
  // fixes are active. Reload the extension at chrome://extensions.
  console.log('PhiloShip: content_ebay_listing loaded — build 2026-09-25-k');
  // Reliable DOM marker (readable from the page) to confirm which build is live.
  try { document.documentElement.setAttribute('data-philoship-build', '2026-09-25-k'); } catch (e) {}

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
function getEbayAttributesToFill(categoryData) {
  if (!categoryData) return [];
  const cat = CATEGORY_MAP.find(c => c.id === categoryData.categoryId);
  if (!cat) return [];

  return cat.ebayAttributes.map(attr => ({
    name:     attr.name,
    value:    mapToEbayValue(attr, categoryData.scraped?.[attr.source]),
    required: attr.required,
  })).filter(a => a.value); // skip if no value and no default
}


  if (window.__clawdListenerAttached) return;
  window.__clawdListenerAttached = true;

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ── Shared helpers ─────────────────────────────────────────────────────────

  // EcomSniper's _0x16b47f — scroll element into view before interacting
  function scrollIntoView(el) {
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }

  // EcomSniper's _0x9aeab9 — simple sleep
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function getErrorMessage(error) {
    return String(error?.message || error || 'Unknown error');
  }

  function isExtensionContextInvalidatedError(error) {
    return /Extension context invalidated/i.test(getErrorMessage(error));
  }

  function createExtensionReloadError() {
    return new Error('Extension was reloaded while this eBay tab was open. Refresh the tab and retry the listing.');
  }

  function sendRuntimeMessage(message, { ignoreInvalidation = false } = {}) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome?.runtime?.id) {
          throw createExtensionReloadError();
        }
        chrome.runtime.sendMessage(message, response => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            if (isExtensionContextInvalidatedError(runtimeError)) {
              const reloadError = createExtensionReloadError();
              if (ignoreInvalidation) {
                console.warn('PhiloShip: runtime message skipped because the extension context was invalidated');
                resolve(null);
                return;
              }
              reject(reloadError);
              return;
            }
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (isExtensionContextInvalidatedError(error) || /was reloaded while this eBay tab was open/i.test(getErrorMessage(error))) {
          const reloadError = createExtensionReloadError();
          if (ignoreInvalidation) {
            console.warn('PhiloShip: runtime message skipped because the extension context was invalidated');
            resolve(null);
            return;
          }
          reject(reloadError);
          return;
        }
        reject(error instanceof Error ? error : new Error(getErrorMessage(error)));
      }
    });
  }

  // Fire a change event (EcomSniper does this after every .value set)
  function fireChange(el) {
    const ev = document.createEvent('HTMLEvents');
    ev.initEvent('change', true, true);
    el.dispatchEvent(ev);
  }

  function simulateClick(el) {
    if (!el) return;
    el.click();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE: sl/prelist/suggest — bundle 11
  // ══════════════════════════════════════════════════════════════════════════
  async function handlePrelistPage(productData) {
    console.log('PhiloShip: prelist/suggest page');
    // Wait for the search input
    let input = null;
    for (let i = 0; i < 20 && !input; i++) {
      input = document.querySelector('input[name="query"]') ||
              document.querySelector('input[type="search"]') ||
              document.querySelector('input[aria-label*="sell" i]') ||
              document.querySelector('input[placeholder*="sell" i]');
      if (!input) await sleep(500);
    }
    if (!input) return console.error('PhiloShip: no search input on prelist page');

    // Set value + fire change (EcomSniper pattern)
    const hint = productData.title.split(' ').slice(0, 5).join(' ');
    input.value = hint;
    fireChange(input);
    await sleep(300);

    // Press Enter
    ['keydown','keypress','keyup'].forEach(t =>
      input.dispatchEvent(new KeyboardEvent(t, { key:'Enter', keyCode:13, bubbles:true }))
    );

    // Also click submit button if present
    const btn = document.querySelector('button[type="submit"]') ||
                Array.from(document.querySelectorAll('button'))
                  .find(b => /continue|search|start/i.test(b.textContent));
    if (btn) btn.click();

    console.log('PhiloShip: title submitted on prelist page');
    return { ok: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE: sl/prelist/identify — bundle 12 (exact port)
  // Three parallel loops, mirrors _0x1095e9 exactly
  // ══════════════════════════════════════════════════════════════════════════
  async function handleIdentifyPage() {
    console.log('PhiloShip: identify page — running parallel loops');

    let categoryDone  = false;
    let conditionDone = false;

    function getNewConditionRadio() {
      return document.querySelector('input[name="condition"][value="1000"], input[type="radio"][value="1000"][id*="condition-1000"]');
    }

    function clickConditionRadio(input) {
      if (!input) return false;
      let label = null;
      if (input.id) {
        try { label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch (_) {}
      }
      const clickable = label || input.closest('label') || input.closest('.radio, .field, [role="radio"], .condition-dialog-radix__condition') || input;
      scrollIntoView(clickable);
      if (!input.checked) {
        clickable.click?.();
        if (!input.checked) input.click?.();
      }
      if (!input.checked) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        setter ? setter.call(input, true) : (input.checked = true);
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return !!input.checked;
    }

    function findPreferredConditionButton(condition = 'New') {
      const wanted = String(condition || 'New').toLowerCase().trim();
      const isNew = wanted === 'new';

      // Covers both the legacy condition buttons and eBay's newer
      // "condition-grading" flow (prelist-radix__condition-grading) where each
      // condition is a clickable card/option rather than a radio.
      const candidates = Array.from(document.querySelectorAll(
        'button.condition-button, ' +
        '.prelist-radix__condition-grading button, ' +
        '.prelist-radix__condition-grading [role="radio"], ' +
        '.prelist-radix__condition-grading [role="button"], ' +
        '[class*="condition-grading"] button, ' +
        '[class*="condition-grading"] [role="radio"], ' +
        '[class*="condition-grading"] [class*="option"], ' +
        '[class*="condition-grading"] [class*="card"], ' +
        '[class*="condition-grading"] [class*="pill"], ' +
        '.condition-recommendation button, ' +
        '[class*="condition"] button, [role="radio"]'
      ));
      // Score on the option's TITLE only. eBay's condition buttons render the
      // title in a bold span with the long subtext beside it, so using the whole
      // textContent (title + subtext) breaks exact matching.
      const titleOf = el => {
        const titleEl = el.querySelector('span.bold-text, .condition-button__title, [class*="__title"]');
        const raw = (titleEl ? titleEl.textContent : el.textContent) || '';
        return raw.replace(/\s+/g, ' ').trim().toLowerCase();
      };
      const scoreOf = el => {
        const t = titleOf(el);
        if (!t || t.length > 40) return -1;
        if (/^continue$/.test(t)) return -1; // never the CTA
        if (isNew) {
          if (t === 'new with tags') return 6;
          if (t === 'new with box') return 5;
          if (t === 'new without tags' || t === 'new without box') return 4;
          if (t === 'brand new' || t === 'new') return 3;
          if (t.startsWith('new ') && !t.includes('imperfection')) return 2; // avoid "New with imperfections"
          return -1;
        }
        return t === wanted ? 4 : (t.includes(wanted) ? 2 : -1);
      };
      let best = null, bestScore = 0;
      for (const el of candidates) {
        const s = scoreOf(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      return best;
    }

    // The Continue/next CTA for both the old and new (condition-grading) layouts.
    function findIdentifyContinue() {
      return document.querySelector('.prelist-radix__condition-grading-cta') ||
        document.querySelector('.prelist-radix__next-action') ||
        document.querySelector('[class*="radix__continue-btn"]') ||
        document.querySelector('.condition-dialog-radix__continue-btn') ||
        Array.from(document.querySelectorAll('button, [role="button"]'))
          .find(b => /^(continue|next|confirm)$/i.test((b.textContent || '').replace(/\s+/g, ' ').trim())) ||
        null;
    }

    function isEnabled(el) {
      return !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    }

    const onIdentify = () => location.href.includes('/prelist/identify');
    // DOM breadcrumb so progress is observable from the page (console logs from
    // content scripts aren't reliably captured by devtools readers).
    const mark = v => { try { document.documentElement.setAttribute('data-philo-identify', v); } catch (e) {} };

    // Single robust loop: click the category card if the legacy picker shows,
    // select the "New" condition until it's actually pressed, then click the
    // Continue CTA once it enables — repeating until we leave the identify step.
    mark('start');
    let conditionSelected = false;
    const deadline = Date.now() + 60000;
    while (onIdentify() && Date.now() < deadline) {
      // Legacy lightbox category card (new flow carries category in the URL).
      const card = document.querySelector('.lightbox-dialog__main .se-field-card__container');
      if (card) { card.click(); }

      // Select the condition.
      if (!conditionSelected) {
        const radio = getNewConditionRadio();
        if (radio && (radio.checked || clickConditionRadio(radio))) {
          conditionSelected = true;
          mark('condition-radio-selected');
        } else {
          const el = findPreferredConditionButton('New');
          if (el) {
            const pressed = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
            if (pressed) { conditionSelected = true; mark('condition-pressed'); }
            else {
              scrollIntoView(el);
              el.click();
              mark('clicked:' + ((el.querySelector('span.bold-text')?.textContent || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20)));
            }
          } else {
            mark('waiting-for-condition-options');
          }
        }
      }

      // Click Continue/Next once it's enabled.
      const cont = findIdentifyContinue();
      if (isEnabled(cont)) { scrollIntoView(cont); cont.click(); mark('continue-clicked'); }

      await sleep(700);
    }
    mark(onIdentify() ? 'timeout-still-on-identify' : 'advanced-to-draft');
    console.log('PhiloShip: left identify page →', location.href.slice(0, 80));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PAGE: lstng?* — bundle 9 (exact port of _0x5ed176)
  // ══════════════════════════════════════════════════════════════════════════

  // Request headers captured via background webRequest listener
  let _0x567807 = []; // EcomSniper's variable name kept for clarity
  let _0x1bcef4 = 0;  // network response counter

  // _0x6e39f5 — get SKU input
  function getSkuInput() {
    return document.querySelector('.smry.summary__title input[name="customLabel"]');
  }

  // _0x28a61e — check if SKU input exists
  function skuInputExists() {
    return !!document.querySelector('.smry.summary__title input[name="customLabel"]');
  }

  // _0x29b24c — paste title (max 80 chars, exact EcomSniper logic)
  function pasteTitle(title) {
    return new Promise(resolve => {
      let t = title;
      if (t.length > 0x50) t = t.substring(0, 0x4d) + '...';
      const el = document.querySelector('.smry.summary__title input[name="title"]');
      if (!el) { resolve(); return; }
      el.value = t;
      scrollIntoView(el);
      fireChange(el);
      el.style.border = '3px solid #DFFF00';
      resolve();
    });
  }

  // _0x5a6ba0 — set price
  function parseMoneyValue(value) {
    const number = parseFloat(String(value || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeListingPrice(value) {
    const number = parseMoneyValue(value);
    return number > 0 ? number.toFixed(2) : '0.00';
  }

  async function setPrice(price) {
    const wantedPrice = normalizeListingPrice(price);
    // Multiple selectors — EcomSniper primary first
    const el = document.querySelector('.smry.summary__price input[name="price"]') ||
               document.querySelector('input[name="price"]') ||
               document.querySelector('[data-vv-name="listingPrice"] input') ||
               document.querySelector('[aria-label*="price" i]');
    if (!el) { console.warn('PhiloShip: price input not found'); return; }
    scrollIntoView(el);
    el.focus();
    el.select && el.select();
    // Clear and set using native setter to bypass React
    const proto = window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    setter ? setter.call(el, wantedPrice) : (el.value = wantedPrice);
    fireChange(el);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    await sleep(200);
    console.log('PhiloShip: price set to', el.value, '(wanted:', wantedPrice, ')');
    return parseMoneyValue(el.value) >= parseMoneyValue(wantedPrice);
  }

  async function enforceListingPrice(price) {
    const wantedPrice = normalizeListingPrice(price);
    let accepted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      accepted = await setPrice(wantedPrice);
      await putDraftField('startPrice', { '@currencyId': 'USD', '#text': wantedPrice });
      await waitForNetworkResponse();
      await sleep(300);
      const el = document.querySelector('.smry.summary__price input[name="price"]') ||
                 document.querySelector('input[name="price"]') ||
                 document.querySelector('[data-vv-name="listingPrice"] input') ||
                 document.querySelector('[aria-label*="price" i]');
      if (!el || parseMoneyValue(el.value) >= parseMoneyValue(wantedPrice)) {
        accepted = true;
        break;
      }
      console.warn('PhiloShip: price was below target after save, retrying', el.value, wantedPrice);
    }
    return accepted;
  }

  function normalizeQuantity(...values) {
    for (const value of values) {
      const quantity = parseInt(value, 10);
      if (Number.isFinite(quantity) && quantity > 0) return quantity;
    }
    return 1;
  }

  async function setQuantity(quantity) {
    const value = String(normalizeQuantity(quantity, 1));
    const selectors = [
      '.smry.summary__quantity input[name="quantity"]',
      'input[name="quantity"]',
      'input[name="availableQuantity"]',
      'input[id*="quantity" i]',
      'input[aria-label*="quantity" i]',
      '[data-testid*="quantity" i] input'
    ];
    const el = selectors.map(selector => document.querySelector(selector)).find(Boolean);
    if (el) {
      scrollIntoView(el);
      el.focus();
      el.select && el.select();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(el, value) : (el.value = value);
      fireChange(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      await sleep(200);
      console.log('PhiloShip: quantity set to', value);
    } else {
      console.warn('PhiloShip: quantity input not found; setting draft quantity only');
    }
    await putDraftField('quantity', value);
    await putDraftField('availableQuantity', value);
    await putDraftField('quantityInfo', { quantity: value, availableQuantity: value });
  }

  // _0x3c0715 — set condition (clicks first button in .condition-recommendation)
  async function setCondition(condition = 'New') {
    const wanted = String(condition || 'New').toLowerCase().trim();

    const radio1000 = document.querySelector('input[name="condition"][value="1000"], input[type="radio"][value="1000"][id*="condition-1000"]');
    if (radio1000) {
      let label = null;
      if (radio1000.id) {
        try { label = document.querySelector(`label[for="${CSS.escape(radio1000.id)}"]`); } catch (_) {}
      }
      const clickable = label || radio1000.closest('label') || radio1000.closest('.radio, .field, [role="radio"], .condition-dialog-radix__condition') || radio1000;
      scrollIntoView(clickable);
      if (!radio1000.checked) {
        clickable.click?.();
        if (!radio1000.checked) radio1000.click?.();
      }
      if (!radio1000.checked) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        setter ? setter.call(radio1000, true) : (radio1000.checked = true);
      }
      radio1000.dispatchEvent(new Event('input', { bubbles: true }));
      radio1000.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('PhiloShip: condition radio value 1000 selected');
      return;
    }

    const exactButtons = Array.from(document.querySelectorAll('button.condition-button'));
    let target = exactButtons.find(btn => {
      const titleText = (btn.querySelector('span.bold-text.medium-text')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const subText = (btn.querySelector('.condition-button__subtext')?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (wanted === 'new') {
        return titleText === 'new with tags' || (titleText === 'new' && subText.includes('tags attached'));
      }
      return titleText === wanted || titleText.includes(wanted);
    });

    if (!target) {
      const buttons = Array.from(document.querySelectorAll('button.condition-button, .condition-recommendation button, button'));
      const getText = btn => (btn.innerText || btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (wanted === 'new') {
        target = buttons.find(btn => getText(btn).includes('new with tags')) ||
          buttons.find(btn => getText(btn) === 'new') ||
          buttons.find(btn => getText(btn).startsWith('new '));
      } else {
        target = buttons.find(btn => getText(btn).includes(wanted)) || null;
      }
    }

    if (target) {
      if (target.getAttribute('aria-pressed') !== 'true') {
        target.click();
      }
      console.log('PhiloShip: condition set to', (target.innerText || target.textContent || '').trim());
    } else {
      console.error('PhiloShip: preferred condition button not found for', condition);
    }
  }

  // _0x9f156e — enable SKU field (clicks [name="customLabelPref"] toggle)
  async function enableSku() {
    const toggle = document.querySelector('[name="customLabelPref"]');
    if (toggle) {
      toggle.click();
      toggle.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      toggle.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
      await sleep(2000); // 0x7d0 = 2000ms
    }
  }

  // _0x3d4336 — paste SKU (base64 encoded, EcomSniper uses btoa)
  function pasteSku(sku) {
    return new Promise(resolve => {
      const el = getSkuInput();
      if (!el) { resolve(); return; }
      scrollIntoView(el);
      el.value = sku;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.style.border = '3px solid #DFFF00';
      resolve();
    });
  }

  // Locate the description rich-text editor. eBay renders it either inside an
  // iframe (#se-rte-frame__summary) or directly in the page as a contenteditable
  // .se-rte-editor__rich (role="textbox", aria-label="Description"). Handle both.
  function getDescriptionEditor() {
    const frame = document.getElementById('se-rte-frame__summary');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const inFrame = doc && doc.body && doc.body.querySelector('.se-rte-editor__rich');
    if (inFrame) return inFrame;
    return document.querySelector(
      '.se-rte-editor__rich[contenteditable="true"], [contenteditable="true"][aria-label="Description" i], [role="textbox"][aria-label="Description" i]'
    );
  }

  // Write the description into the RTE and fire the events eBay listens for so
  // the value is committed and the "A description is required" error clears.
  function setDescription(html) {
    return new Promise(async resolve => {
      let editable = getDescriptionEditor();
      for (let i = 0; i < 20 && !editable; i++) { await sleep(300); editable = getDescriptionEditor(); }
      if (!editable) { console.warn('PhiloShip: description editor not found'); resolve(false); return; }

      scrollIntoView(editable);
      // Clear the empty-state placeholder so eBay doesn't treat it as blank.
      editable.classList.remove('placeholder');
      editable.removeAttribute('data-placeholder');
      editable.focus();
      editable.innerHTML = html;

      // Commit: input/change for the editor, keyup for React handlers, blur to
      // flush the value into the draft model.
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.dispatchEvent(new Event('change', { bubbles: true }));
      editable.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      await sleep(400);
      editable.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(400);
      resolve(!isDescriptionEmpty());
    });
  }

  // Returns true if the description RTE editor currently has no meaningful text.
  function isDescriptionEmpty() {
    const editable = getDescriptionEditor();
    const text = (editable?.textContent || '').replace(/\s+/g, '').trim();
    return text.length < 5;
  }

  // _0x467527 — click "Show more" button (expands additional fields)
  async function clickShowMore() {
    const btns = document.querySelectorAll('button');
    let showMore = null;
    for (const b of btns) {
      if (b.textContent.trim() === 'Show more') { showMore = b; break; }
    }
    if (!showMore) showMore = document.querySelector('button[_track*="ShowMore"]');
    if (showMore) {
      showMore.click();
      await sleep(1000);
    }
  }

  // _0x596a29 — wait for network response count to increase
  function waitForNetworkResponse() {
    const before = _0x1bcef4;
    return new Promise(resolve => {
      let attempts = 0;
      async function check() {
        if (_0x1bcef4 > before) { await sleep(100); resolve(); return; }
        attempts++;
        if (attempts > 30) { _0x1bcef4 = before + 1; resolve(); return; } // timeout after ~3s
        setTimeout(check, 100);
      }
      check();
    });
  }

  // _0x3d2131 — wait for request headers to be captured
  function waitForRequestHeaders(timeoutMs = 8000) {
    if (_0x567807.length > 0) return Promise.resolve();
    return new Promise(resolve => {
      const iv = setInterval(() => {
        if (_0x567807.length > 0) { clearInterval(iv); resolve(); }
      }, 500);
      // Always resolve after timeout so the flow never blocks
      setTimeout(() => { clearInterval(iv); resolve(); }, timeoutMs);
    });
  }

  // _0x573513 — PUT a field to the draft API using captured headers
  async function putDraftField(fieldName, fieldValue) {
    if (_0x567807.length === 0) return;
    const headers = new Headers();
    for (const h of _0x567807) {
      if (!['host','content-length','origin'].includes(h.name.toLowerCase())) {
        try { headers.append(h.name, h.value); } catch(_) {}
      }
    }
    headers.set('Content-Type', 'application/json');
    const draftId = new URLSearchParams(location.search).get('draftId');
    const url = `${location.origin}/lstng/api/listing_draft/${draftId}?mode=AddItem&forceValidation=true`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ [fieldName]: fieldValue }),
        signal: ctrl.signal,
      });
      console.log(`PhiloShip: PUT ${fieldName} → ${res.status}`);
    } catch(e) {
      console.error(`PhiloShip: PUT ${fieldName} failed`, e.name === 'AbortError' ? 'timed out' : e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // _0xa1cb97 — get the List button
  function getListButton() {
    const cta = document.querySelector('.smry.summary__cta') ||
                document.querySelector('.summary__cta');
    if (cta) {
      scrollIntoView(cta);
      return cta.querySelector('button[aria-label*="List"]') ||
             cta.querySelector('button[_track*="listItCallToAction"]') ||
             cta.querySelector('.btn--primary');
    }
    return document.querySelector('button[aria-label="List it"]') ||
           document.querySelector('button[_track*="listItCallToAction"]') ||
           Array.from(document.querySelectorAll('button'))
             .find(btn => /\blist it\b/i.test(btn.textContent || btn.getAttribute('aria-label') || '')) ||
           null;
  }

  // Detect a successful publish across eBay's success-page variants. The old
  // check only looked for `.success__header` / `/sl/success`; if eBay tweaks
  // the confirmation page, that misses and the flow burns the full timeout.
  function listingHasSucceeded() {
    // 1. URL signals
    if (/\/itm\/\d+/.test(location.href)) return true;
    if (/\/(sl\/)?success|listingcomplete|listedsuccess/i.test(location.href)) return true;
    // 2. Success container / header (class-name variants)
    if (document.querySelector('.success__header, [class*="success__header"], [class*="listing-success"], [class*="lst-success"]')) return true;
    // 3. Confirmation copy anywhere on the page
    const bodyText = (document.body && document.body.innerText) || '';
    if (/\b(your (item|listing) is (now )?(live|listed)|listing is (now )?live|successfully listed|congratulations[,!]? your (item|listing))\b/i.test(bodyText)) return true;
    // 4. Post-list CTAs that only appear on the success screen
    if (Array.from(document.querySelectorAll('a, button')).some(el =>
      /view your listing|sell (another|similar)|list another/i.test(el.textContent || ''))) return true;
    return false;
  }

  // Read eBay's own validation errors so we can fail fast with a useful reason
  // instead of clicking List and waiting 5 minutes for a confirmation that
  // will never come. Returns a short human-readable string, or '' if none.
  function getListingBlockingError() {
    // 1. Page-level error banner / notice summary
    const bannerSelectors = [
      '.page-notice--attention',
      '.inline-notice--attention',
      '.inline-notice__message',
      '.summary__errors',
      '[role="alert"]',
      '.notice-content__main',
    ];
    for (const sel of bannerSelectors) {
      const el = document.querySelector(sel);
      const txt = (el?.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt && /required|missing|add |must |error|invalid|complete/i.test(txt)) {
        return txt.slice(0, 200);
      }
    }
    // 2. Field-level errors — collect the labels of invalid required fields
    const invalidLabels = [];
    const invalidEls = document.querySelectorAll(
      '[aria-invalid="true"], .field__errors:not(.clipped)'
    );
    for (const el of invalidEls) {
      const field = el.closest('fieldset, .summary__attributes--fields, .field, .se-field') || el;
      const label =
        field.querySelector('[id*="item-specific-dropdown-label"], legend, label')?.textContent?.trim() ||
        el.getAttribute?.('aria-label') || '';
      const clean = label.replace(/\s+/g, ' ').trim();
      if (clean && !invalidLabels.includes(clean)) invalidLabels.push(clean);
    }
    if (invalidLabels.length) {
      return 'Required fields still incomplete: ' + invalidLabels.slice(0, 6).join(', ');
    }
    return '';
  }

  // After clicking List, eBay usually publishes in the background WITHOUT
  // navigating away from the draft, so there's often no success page to detect.
  // Strategy: watch a short window for either an explicit success signal or a
  // validation/duplicate error. If an error appears, report it. If neither
  // appears within the window, treat it as published (items reliably do) so the
  // run keeps moving smoothly instead of stalling for minutes and halting bulk.
  async function waitForSuccess(timeoutMs = 40 * 1000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(1000);
      if (listingHasSucceeded()) {
        console.log('PhiloShip: Item was successfully posted!');
        return { ok: true };
      }
      // Fail fast on a real validation/duplicate error.
      if (Date.now() - started > 3000) {
        const blockingError = getListingBlockingError();
        if (blockingError) {
          console.warn('PhiloShip: listing blocked by validation:', blockingError);
          return { ok: false, error: blockingError };
        }
      }
    }
    // No success page, no error → eBay published silently. Assume success.
    console.log('PhiloShip: no confirmation page and no error — treating as published.');
    return { ok: true, unconfirmed: true };
  }

  // _0x43cc3d — get item URL from .success__body-link a
  function getItemUrl() {
    return document.querySelector('.success__body-link a')?.href?.toString() || location.href;
  }

  // ── Set shipping using exact eBay lstng HTML ─────────────────────────────
  let _shippingDone = false;
  async function setShipping() {
    if (_shippingDone) return;
    _shippingDone = true;
    await sleep(500);
    try {
      // 1. Disable "Allow offers"
      const bestOffer = document.querySelector('input[name="bestOfferEnabled"]');
      if (bestOffer && bestOffer.checked) { bestOffer.click(); await sleep(300); }

      // Helper: find Flat Rate Freight button anywhere on the page
      function findFlatRateBtn(scope) {
        for (const btn of (scope || document).querySelectorAll('.toggle-button')) {
          if (/flat rate freight/i.test(btn.querySelector('.toggle-button__title')?.textContent || '')) {
            return btn;
          }
        }
        // Fallback: last toggle button (Flat Rate Freight is always last in both lists)
        const all = (scope || document).querySelectorAll('ul li .toggle-button');
        return all.length ? all[all.length - 1] : null;
      }

      function legacyFindSellerPaysControl(scope = document) {
        const root = scope || document;
        const selectors = [
          'button.segmented-buttons__button[value="SP"]',
          'button.segmented-buttons__button[aria-label*="Seller pays" i]',
          'button[value="SP"]',
          'button[aria-label*="Seller pays" i]',
          'input[value="SP"]',
          'input[value="SELLER"]',
          'input[name*="shippingCostPaidBy"][value*="SELLER" i]',
          'input[name*="payer"][value*="SELLER" i]'
        ];
        for (const selector of selectors) {
          const control = root.querySelector(selector);
          if (control) return control;
        }
        return Array.from(root.querySelectorAll('button, [role="radio"], label, input[type="radio"], .segmented-buttons__button, .segmented-buttons label, .segmented-buttons span, .segmented-buttons div'))
          .find(el => {
            const text = [
              el.textContent,
              el.getAttribute?.('aria-label'),
              el.getAttribute?.('title'),
              el.getAttribute?.('value'),
              el.getAttribute?.('name'),
              el.getAttribute?.('id'),
              el.closest?.('label')?.textContent
            ].filter(Boolean).join(' ');
            if (/offer free shipping/i.test(text)) return false;
            if (/\bseller pays\b/i.test(text)) return true;
            if (/\bi will pay\b/i.test(text)) return true;
            if (/\bi\b.*\bpay\b/i.test(text)) return true;
            return /\b(seller pays|i(?:'|’)?ll pay|i will pay|you pay|free shipping)\b/i.test(text);
          }) || null;
      }

      function legacyIsSellerPaysSelected(control) {
        if (!control) return false;
        if (control.tagName === 'INPUT') return !!control.checked;
        if (control.getAttribute?.('aria-pressed') === 'true') return true;
        if (control.getAttribute?.('aria-checked') === 'true') return true;
        if (control.getAttribute?.('aria-selected') === 'true') return true;
        if (control.getAttribute?.('data-selected') === 'true') return true;
        const className = typeof control.className === 'string' ? control.className : '';
        if (/selected|checked|active|--pressed|is-selected/.test(className)) return true;
        const nestedInput = control.querySelector?.('input[type="radio"], input[type="checkbox"]');
        if (nestedInput?.checked) return true;
        return false;
      }

      async function legacyClickSellerPays() {
        for (let i = 0; i < 25; i++) {
          const sellerPays = findSellerPaysControl(document);
          if (sellerPays) {
            const clickable = sellerPays.tagName === 'INPUT'
              ? sellerPays.closest('label') || sellerPays
              : sellerPays;
            scrollIntoView(clickable);
            if (isSellerPaysSelected(sellerPays)) {
              console.log('PhiloShip: Seller pays already selected');
              return true;
            }
            clickable.click();
            sellerPays.dispatchEvent?.(new Event('change', { bubbles: true }));
            await sleep(500);
            const updatedControl = findSellerPaysControl(document);
            if (isSellerPaysSelected(updatedControl || sellerPays)) {
              console.log('PhiloShip: Seller pays selected');
              await waitForNetworkResponse();
              return true;
            }
          }
          await sleep(300);
        }
        console.warn('PhiloShip: Seller pays not found');
        return false;
      }

      function findSellerPaysControl(scope = document) {
        const root = scope || document;
        const selectors = [
          'button.segmented-buttons__button[value="SP"]',
          'button.segmented-buttons__button[aria-label*="Seller pays" i]',
          'button[value="SP"]',
          'button[aria-label*="Seller pays" i]',
          'button[data-testid*="SELLER" i]',
          'button[data-testid*="seller-pays" i]',
          '[role="radio"][value="SP"]',
          '[role="radio"][aria-label*="Seller pays" i]',
          'input[value="SP"]',
          'input[value="SELLER"]',
          'input[name*="shippingCostPaidBy"][value*="SP" i]',
          'input[name*="shippingCostPaidBy"][value*="SELLER" i]',
          'input[name*="payer"][value*="SELLER" i]',
          'label[for*="shippingCostPaidBy" i][for*="SELLER" i]'
        ];
        for (const selector of selectors) {
          const control = root.querySelector(selector);
          if (control) return control;
        }
        return Array.from(root.querySelectorAll(
          'button, [role="radio"], label, input[type="radio"], .segmented-buttons__button, .segmented-buttons label, .segmented-buttons span, .segmented-buttons div'
        )).find(el => {
          const text = [
            el.textContent,
            el.getAttribute?.('aria-label'),
            el.getAttribute?.('title'),
            el.getAttribute?.('value'),
            el.getAttribute?.('name'),
            el.getAttribute?.('id'),
            el.closest?.('label')?.textContent
          ].filter(Boolean).join(' ');
          if (/offer free shipping/i.test(text)) return false;
          if (/\bseller pays\b/i.test(text)) return true;
          if (/\bi will pay\b/i.test(text)) return true;
          if (/\bi\b.*\bpay\b/i.test(text)) return true;
          return /\b(seller pays|seller|you pay)\b/i.test(text);
        }) || null;
      }

      function findSellerPaysHiddenField(scope = document) {
        const root = scope || document;
        return root.querySelector(
          'input[type="hidden"][name*="shippingCostPaidBy" i], input[type="hidden"][name*="payer" i], input[type="hidden"][id*="shippingCostPaidBy" i], input[type="hidden"][id*="payer" i]'
        );
      }

      function getSellerPaysClickable(control) {
        if (!control) return null;
        if (control.tagName === 'INPUT') {
          if (control.type === 'hidden') return control;
          return control.closest('label') || control;
        }
        return control.closest?.('button, label, [role="radio"]') || control;
      }

      function setSellerPaysHiddenFieldValue(input) {
        if (!input) return;
        const current = String(input.value || '').trim();
        const nextValue = /^[A-Z]{2}$/i.test(current) || /\b(BP|SP)\b/i.test(current) ? 'SP' : 'SELLER';
        setInputValue(input, nextValue);
      }

      function isSellerPaysSelected(control) {
        if (!control) return false;
        if (control.tagName === 'INPUT') {
          if (control.type === 'hidden') {
            const value = String(control.value || '').toLowerCase().trim();
            return value === 'sp' || value === 'seller' || value.includes('seller');
          }
          return !!control.checked;
        }
        if (control.getAttribute?.('aria-pressed') === 'true') return true;
        if (control.getAttribute?.('aria-checked') === 'true') return true;
        if (control.getAttribute?.('aria-selected') === 'true') return true;
        if (control.getAttribute?.('data-selected') === 'true') return true;
        const className = typeof control.className === 'string' ? control.className : '';
        if (/selected|checked|active|--pressed|is-selected/.test(className)) return true;
        const nestedInput = control.querySelector?.('input[type="radio"], input[type="checkbox"]');
        const nestedHidden = control.querySelector?.('input[type="hidden"]');
        if (nestedInput?.checked) return true;
        if (nestedHidden && isSellerPaysSelected(nestedHidden)) return true;
        return false;
      }

      async function clickSellerPays() {
        for (let i = 0; i < 25; i++) {
          const sellerPays = findSellerPaysControl(document) || findSellerPaysHiddenField(document);
          if (sellerPays) {
            if (isSellerPaysSelected(sellerPays)) {
              console.log('PhiloShip: Seller pays already selected');
              return true;
            }
            const clickable = getSellerPaysClickable(sellerPays);
            scrollIntoView(clickable || sellerPays);
            if (sellerPays.tagName === 'INPUT' && sellerPays.type === 'hidden') {
              setSellerPaysHiddenFieldValue(sellerPays);
            } else {
              clickable?.click?.();
              sellerPays.dispatchEvent?.(new Event('change', { bubbles: true }));
            }
            await sleep(500);
            const updatedControl = findSellerPaysControl(document) || findSellerPaysHiddenField(document);
            if (isSellerPaysSelected(updatedControl || sellerPays)) {
              console.log('PhiloShip: Seller pays selected');
              await waitForNetworkResponse();
              return true;
            }
          }
          await sleep(300);
        }
        const freeShippingState = getFreeShippingElements(document);
        if (isFreeShippingEnabled(freeShippingState)) {
          console.log('PhiloShip: Seller pays control was not exposed separately; free shipping is already enabled');
          return true;
        }
        console.warn('PhiloShip: Seller pays not found');
        return false;
      }

      function getFreeShippingElements(scope = document) {
        const root = scope || document;
        const hiddenInput = root.querySelector(
          'input[name="freeShipping-hidden"][data-testid="hidden-input"], input[name="freeShipping-hidden"], input[type="hidden"][name*="freeShipping" i]'
        );
        const checkbox = root.querySelector(
          'input[id*="freeShipping" i][type="checkbox"], input[name="freeShipping" i][type="checkbox"], .shipping-card__free-shipping input[type="checkbox"]'
        );
        const label = Array.from(root.querySelectorAll('label, span.se-checkbox__label, .field__label'))
          .find(el => /offer free shipping/i.test(el.textContent || '')) || null;
        const card = checkbox?.closest?.('.shipping-card__free-shipping, .shipping-card, .se-checkbox, .field') ||
          hiddenInput?.closest?.('.shipping-card__free-shipping, .shipping-card, .se-checkbox, .field') ||
          label?.closest?.('.shipping-card__free-shipping, .shipping-card, .se-checkbox, .field') ||
          null;
        return { hiddenInput, checkbox, label, card };
      }

      function setInputValue(input, value) {
        if (!input) return;
        const proto = input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function setCheckboxChecked(input, checked) {
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        if (setter) setter.call(input, checked);
        else input.checked = checked;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function getFreeShippingLabel(state) {
        if (!state) return null;
        if (state.checkbox?.labels?.length) return state.checkbox.labels[0];
        if (state.checkbox?.id) {
          try {
            const explicit = document.querySelector(`label[for="${CSS.escape(state.checkbox.id)}"]`);
            if (explicit) return explicit;
          } catch (_) {}
        }
        return state.label?.closest?.('label') || state.label || null;
      }

      function isFreeShippingEnabled(state) {
        if (!state) return false;
        // The visible checkbox is the source of truth. On calculated-shipping /
        // SellLikeItem drafts eBay leaves the freeShipping-hidden input empty ('')
        // even while the checkbox is checked, so trusting the hidden input alone
        // wrongly reported "free shipping off" and sent the flow into the
        // shipping-service fallback. Honor a checked checkbox first.
        if (state.checkbox) return !!state.checkbox.checked;
        const hiddenValue = String(state.hiddenInput?.value || '').toLowerCase();
        if (state.hiddenInput) return hiddenValue === 'true';
        return false;
      }

      async function enableFreeShipping() {
        for (let i = 0; i < 30; i++) {
          const state = getFreeShippingElements(document);
          const labelEl = getFreeShippingLabel(state);
          const clickable = labelEl || state.card || state.checkbox || state.hiddenInput;

          if (isFreeShippingEnabled(state) && (!state.checkbox || state.checkbox.checked)) {
            console.log('PhiloShip: Free shipping already enabled');
            return true;
          }

          if (clickable && state.checkbox && !state.checkbox.checked) {
            scrollIntoView(clickable);
            clickable.click?.();
            await sleep(300);
          }

          if (state.checkbox && !state.checkbox.checked) {
            scrollIntoView(state.checkbox);
            state.checkbox.click();
            await sleep(300);
          }

          if (state.checkbox && !state.checkbox.checked) {
            setCheckboxChecked(state.checkbox, true);
            await sleep(200);
          }

          if (state.hiddenInput && String(state.hiddenInput.value || '').toLowerCase() !== 'true') {
            setInputValue(state.hiddenInput, 'true');
          }

          await sleep(500);
          await waitForNetworkResponse();

          const updatedState = getFreeShippingElements(document);
          if (isFreeShippingEnabled(updatedState) && (!updatedState.checkbox || updatedState.checkbox.checked)) {
            console.log('PhiloShip: Free shipping enabled');
            return true;
          }

          await sleep(300);
        }
        console.warn('PhiloShip: Free shipping checkbox/hidden input could not be confirmed');
        return false;
      }

      function shippingControlsPresent() {
        return Boolean(findSellerPaysControl(document) || getFreeShippingElements(document).checkbox || getFreeShippingElements(document).hiddenInput);
      }

      // 2. Try short list first (gallery layout — no lightbox needed)
      function getShippingRoot() {
        return document.querySelector('.smry.summary__shipping, .summary__shipping, [id*="@SHIPPING"], [data-testid*="shipping" i], section[aria-label*="shipping" i]') ||
          Array.from(document.querySelectorAll('section, fieldset, .se-panel-section, .summary__section, div'))
            .find(el => /\bshipping\b/i.test((el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160))) ||
          document;
      }

      function getControlText(el) {
        return [
          el?.innerText,
          el?.textContent,
          el?.getAttribute?.('aria-label'),
          el?.getAttribute?.('title'),
          el?.getAttribute?.('name'),
          el?.getAttribute?.('value')
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      }

      function findClickableByText(patterns, scope = document) {
        return Array.from((scope || document).querySelectorAll('button, [role="button"], a, label, .fake-link, .toggle-button, .menu__item, [role="option"]'))
          .find(el => {
            if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return false;
            const text = getControlText(el);
            return text && patterns.some(pattern => pattern.test(text));
          }) || null;
      }

      function findShippingServiceControl(scope = document) {
        const bad = /local pickup|international|freight|add|change|view all|see shipping|select|video|front|back|sides|bottom|interior|pockets|corners|straps|hardware|accessories/i;
        const preferred = [/usps ground advantage/i, /ground advantage/i, /ups ground/i, /fedex ground/i, /standard shipping/i, /economy shipping/i, /standard delivery/i, /ground shipping/i, /flat rate/i];
        return Array.from((scope || document).querySelectorAll('.toggle-button, button, [role="option"], .menu__item, label'))
          .find(el => {
            if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return false;
            const text = getControlText(el);
            return text && !bad.test(text) && preferred.some(pattern => pattern.test(text));
          }) || null;
      }

      function setNativeSelect(select, patterns) {
        if (!select) return false;
        const option = Array.from(select.options || []).find(opt => {
          const text = [opt.textContent, opt.value].filter(Boolean).join(' ');
          return opt.value && !/select|choose/i.test(text) && patterns.some(pattern => pattern.test(text));
        }) || Array.from(select.options || []).find(opt => opt.value && !/select|choose/i.test(opt.textContent || ''));
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      async function selectShippingPolicyOrService() {
        const selectPatterns = [/usps ground/i, /ground advantage/i, /ups ground/i, /fedex ground/i, /standard/i, /economy/i, /flat rate/i, /free/i, /shipping/i];
        const shippingSelect = Array.from(document.querySelectorAll('select')).find(select => {
          const text = [select.name, select.id, select.getAttribute('aria-label'), select.closest?.('label')?.textContent, select.parentElement?.textContent]
            .filter(Boolean).join(' ');
          return /shipping|service|policy|delivery/i.test(text);
        });
        if (setNativeSelect(shippingSelect, selectPatterns)) {
          console.log('PhiloShip: shipping select option chosen');
          await waitForNetworkResponse();
          await sleep(500);
          return true;
        }

        let serviceControl = findShippingServiceControl(document);
        if (serviceControl) {
          scrollIntoView(serviceControl);
          serviceControl.click?.();
          console.log('PhiloShip: shipping service selected:', getControlText(serviceControl).slice(0, 80));
          await waitForNetworkResponse();
          await sleep(800);
          const done = findClickableByText([/^done$/i, /^save$/i, /^apply$/i], document);
          if (done) {
            done.click?.();
            await sleep(500);
          }
          return true;
        }

        const opener = findClickableByText([
          /add primary service/i,
          /add .*shipping service/i,
          /change shipping service/i,
          /view all shipping services?/i,
          /see shipping options/i,
          /select shipping service/i,
          /shipping service/i,
          /^edit$/i
        ], getShippingRoot()) || findClickableByText([
          /add primary service/i,
          /add .*shipping service/i,
          /change shipping service/i,
          /view all shipping services?/i,
          /see shipping options/i,
          /select shipping service/i
        ], document);

        if (!opener) {
          console.warn('PhiloShip: no shipping service opener found; continuing with visible controls');
          return false;
        }

        scrollIntoView(opener);
        opener.click?.();
        console.log('PhiloShip: shipping service opener clicked:', getControlText(opener).slice(0, 80));
        await sleep(1000);

        const chooser = document.querySelector('.lightbox-dialog__main, [role="dialog"], .menu, [role="listbox"]') || document;
        serviceControl = findShippingServiceControl(chooser) || findShippingServiceControl(document);
        if (serviceControl && serviceControl !== opener) {
          scrollIntoView(serviceControl);
          serviceControl.click?.();
          console.log('PhiloShip: shipping service selected:', getControlText(serviceControl).slice(0, 80));
          await waitForNetworkResponse();
          await sleep(800);
          const done = findClickableByText([/^done$/i, /^save$/i, /^apply$/i], document);
          if (done) {
            done.click?.();
            await sleep(500);
          }
          return true;
        }

        const done = findClickableByText([/^done$/i, /^save$/i, /^apply$/i, /^continue$/i], document);
        if (done) {
          done.click?.();
          await sleep(500);
        }
        return false;
      }

      let flatRateBtn = findFlatRateBtn(
        document.querySelector('.se-shipping__shipping-service__short-list')
      );

      if (flatRateBtn) {
        flatRateBtn.click();
        console.log('PhiloShip: Flat Rate Freight clicked (short list)');
        await sleep(800);
      } else {
        // 3. Open lightbox via "View all shipping services" fake-link button
        const viewAllBtn = Array.from(document.querySelectorAll('button.fake-link'))
          .find(b => /view all shipping service/i.test(b.textContent));
        if (viewAllBtn) {
          viewAllBtn.click();

          // Wait for lightbox
          let lightbox = null;
          for (let i = 0; i < 20; i++) {
            await sleep(200);
            lightbox = document.querySelector('.lightbox-dialog__main');
            if (lightbox) break;
          }
          if (lightbox) {
            await sleep(400);

            flatRateBtn = findFlatRateBtn(lightbox);
            if (flatRateBtn) {
              // Scroll lightbox to button (it's the last item)
              const lbRect  = lightbox.getBoundingClientRect();
              const btnRect = flatRateBtn.getBoundingClientRect();
              lightbox.scrollTop = btnRect.top - lbRect.top + lightbox.scrollTop - 60;
              await sleep(600);

              flatRateBtn.click();
              console.log('PhiloShip: Flat Rate Freight clicked (lightbox)');
              await sleep(800);
            } else {
              console.warn('PhiloShip: Flat Rate Freight not found in lightbox; trying primary service fallback');
              await selectShippingPolicyOrService();
            }
          } else {
            console.warn('PhiloShip: lightbox did not open; trying primary service fallback');
            await selectShippingPolicyOrService();
          }
        } else if (
          isFreeShippingEnabled(getFreeShippingElements(document)) ||
          isSellerPaysSelected(findSellerPaysControl(document))
        ) {
          // "Sell one like this" (mode=SellLikeItem) and other cloned drafts
          // arrive with shipping already configured from the source listing, so
          // eBay shows no "add shipping service" button. That's not an error —
          // skip service selection; free shipping + seller pays are enforced
          // below just to be sure.
          console.log('PhiloShip: shipping already configured (cloned/SellLikeItem draft); skipping service selection');
        } else {
          console.warn('PhiloShip: no shipping button; trying primary service fallback');
          await selectShippingPolicyOrService();
        }
      }

      // 4. Enable free shipping FIRST — on eBay's flow this is what makes the
      // SELLER the payer. Once free shipping is on, the buyer-pays/seller-pays
      // segmented control is either preset to "Seller pays" or removed entirely.
      const freeShippingEnabled = await enableFreeShipping();
      if (!freeShippingEnabled) {
        console.warn('PhiloShip: Free shipping could not be enabled');
      }
      // 5. Confirm/select "Seller pays" (button[value="SP"]) if the control is
      // still exposed (e.g. flat-rate/calculated layouts where it persists).
      const sellerPaysSelected = await clickSellerPays();
      if (!sellerPaysSelected) {
        console.warn('PhiloShip: Seller pays could not be confirmed');
      }

    } catch(e) {
      console.warn('PhiloShip: shipping failed (non-fatal):', e.message);
    }
  }


  // ── eBay policy warning check ─────────────────────────────────────────────
  // Returns array of warning strings for risky product categories.
  function checkEbayPolicies(title, description) {
    const text = (title + ' ' + description).toLowerCase();
    const warnings = [];

    const checks = [
      // Recalled / safety items
      { pattern: /\b(recalled|recall notice|cpsc recall)\b/, msg: 'Product may be subject to a CPSC recall — verify before listing' },

      // Hazmat / regulated chemicals
      { pattern: /\b(bleach|peroxide|acid|flammable|combustible|aerosol|compressed gas|lithium battery|lipo)\b/, msg: 'May contain hazardous materials — check eBay Hazmat policy' },

      // Medical / health claims
      { pattern: /\b(fda approved|treats|cures|heals|medical grade|prescription|drug|pharmaceutical|supplement)\b/, msg: 'Health/medical claims may violate eBay Drugs & Medical policy' },

      // Weapons / restricted
      { pattern: /\b(knife|blade|sword|machete|taser|stun gun|pepper spray|firearm|gun|ammo|silencer)\b/, msg: 'Potential restricted weapon — verify eBay Weapons policy' },

      // Counterfeit signals
      { pattern: /\b(replica|knockoff|inspired by|like [a-z]+ brand|not affiliated|not endorsed)\b/, msg: 'Possible counterfeit signal — verify brand authenticity' },

      // Adult / restricted
      { pattern: /\b(adult only|explicit|18\+|xxx|erotic)\b/, msg: 'Adult content — requires eBay adult category approval' },

      // Tobacco / alcohol
      { pattern: /\b(tobacco|cigarette|cigar|vape|e-cigarette|alcohol|liquor|wine|beer)\b/, msg: 'Tobacco/alcohol — verify eBay Tobacco & Alcohol policy' },

      // Currency / gift cards
      { pattern: /\b(gift card|prepaid card|currency|bitcoin|crypto|money order)\b/, msg: 'Currency/gift cards are heavily restricted on eBay' },

      // Animals / wildlife
      { pattern: /\b(live animal|live plant|seeds|ivory|fur|feathers|coral|tortoise)\b/, msg: 'Possible wildlife or prohibited animal product — check eBay policy' },

      // High-value brand signals (counterfeits)
      { pattern: /\b(rolex|gucci|louis vuitton|hermes|chanel|prada|supreme|yeezy|jordan)\b/, msg: 'Luxury brand — eBay requires proof of authenticity' },
    ];

    for (const { pattern, msg } of checks) {
      if (pattern.test(text)) warnings.push(msg);
    }

    return warnings;
  }

  // ── Main listing function — exact port of _0x5ed176 ───────────────────────
  async function postEbayData(productData) {
    console.log('PhiloShip: postEbayData begins');

    // Detect eBay error banner immediately — "something is missing or invalid"
    // If already showing, report failure right away so next item can start
    const errorBanner = document.querySelector('.page-notice--attention, .global-message');
    if (errorBanner) {
      const msg = errorBanner.textContent.trim().slice(0, 120);
      console.warn('PhiloShip: eBay error banner detected at start:', msg);
      return { success: false, error: `eBay error: ${msg}` };
    }

    // ── Price: use productData.price which is already markup-calculated ─────
    // productData.custom_price = raw Amazon price (do NOT use this)
    // productData.price        = ebayPrice after markup (set by ebay_api.js)
    const title    = productData.custom_title || productData.title || '';
    const price    = normalizeListingPrice(productData.price);
    if (parseMoneyValue(price) <= 0) {
      return { success: false, error: 'Missing calculated eBay price; refusing to list at raw Amazon price.' };
    }
    const quantity = normalizeQuantity(productData.quantity, 1);
    const sku      = productData.sku || productData.asin || '';
    const desc     = productData.descriptionHTML || productData.description || title;
    const hdImages = productData.main_hd_images || productData.images || [];
    const sdImages = productData.main_sd_images || [];
    const images   = (hdImages.length < 2 && sdImages.length > 2) ? sdImages : hdImages;

    // Step 1: click "Show more" to expand all fields
    await clickShowMore();

    // Step 2: set condition
    await setCondition(productData.condition || 'New');

    // Step 3: paste title → triggers eBay auto-save → we capture headers
    await pasteTitle(title);
    console.log('PhiloShip: title pasted, waiting for network response...');
    await waitForNetworkResponse();
    console.log('PhiloShip: network response received, waiting for headers...');
    await waitForRequestHeaders();
    console.log('PhiloShip: headers captured');

    // Step 4: click "Show more" again (sometimes needed after title)
    await clickShowMore();

    // Step 5: Fill item specifics — Brand, Type, and all required fields
    // Extract brand from product data or title
    const brand = productData.brand ||
                  (title.split(' ')[0]) || 'Unbranded';

    // Derive product type from title — first meaningful noun phrase after brand
    const typeWords  = productData.productType || title.split(' ').filter(w => w.toLowerCase() !== brand.toLowerCase() && w.length > 2).slice(0, 3).join(' ');

    // ── COMPLETE EcomSniper item specifics port ─────────────────────────────
    // _0x420fc4: collect field containers from .summary__attributes--section-container
    function getAllItemSpecificFields() {
      let sections = Array.from(document.querySelectorAll('.summary__attributes--section-container'));
      if (!sections.length) {
        const grid = document.querySelector('.smry.summary__attributes .summary__attributes-gridview');
        if (grid) sections = Array.from(grid.children).filter(c => c.classList.contains('se-panel-section'));
      }
      if (!sections.length) return [];
      const fields = [];
      for (const child of sections[0].children) {
        if (child.tagName === 'FIELDSET' || child.classList.contains('summary__attributes--fields'))
          fields.push(child);
      }
      return fields;
    }

    // _0x125fd5: get label text
    function getFieldLabel(field) {
      const el = field.querySelector('[id*="item-specific-dropdown-label"]');
      if (el) return el.textContent.trim();
      try { return field.querySelector('legend').textContent.trim(); } catch(_) {}
      return field.querySelector('label')?.textContent?.trim() || '';
    }

    // _0x18ef2f: find field by label name
    function normalizeFieldLabel(label) {
      return String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function getFieldLabelCandidates(labelName) {
      const normalized = normalizeFieldLabel(labelName);
      const aliasMap = {
        'color': ['color', 'exterior color'],
        'exterior color': ['exterior color', 'color'],
        'material': ['material', 'exterior material'],
        'exterior material': ['exterior material', 'material'],
      };
      return Array.from(new Set(aliasMap[normalized] || [normalized]));
    }

    function getFieldByLabel(labelName) {
      const wanted = getFieldLabelCandidates(labelName);
      for (const f of getAllItemSpecificFields()) {
        if (wanted.includes(normalizeFieldLabel(getFieldLabel(f)))) return f;
      }
      return null;
    }

    // _0x173751: detect field type (exact EcomSniper logic)
    function getFieldType(field) {
      // Check for search input with 'Search' aria-label (singleSelect/multiSelect)
      if (field.querySelectorAll('[class*="filter-menu"] input[aria-label="Search"]').length > 0 ||
          field.querySelectorAll('[class*="filter-menu"] input[aria-label="Suche"]').length > 0) {
        return field.querySelectorAll('[class*="checkbox"]').length > 0 ? 'multiSelectWithNoSearch' : 'singleSelectWithNoSearch';
      }
      // inputRequired: se-textbox--input input
      if (field.querySelectorAll('.se-textbox--input input').length > 0) return 'inputRequired';
      // singleSelectWithLimitedOptions: .btn--tertiary buttons
      if (field.querySelectorAll('.btn--tertiary').length > 0) return 'singleSelectWithLimitedOptions';
      // singleSelect/multiSelect: filter-menu input with search-box-input-textbox id
      if (field.querySelectorAll('[class*="filter-menu"] input[id*="search-box-input-textbox"]').length > 0) {
        return field.querySelectorAll('[class*="checkbox"]').length > 0 ? 'multiSelect' : 'singleSelect';
      }
      return undefined;
    }

    // _0x25d392: fire change events on input
    function fireAttributeChange(input) {
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // _0x4b9740: check if a field already has a value
    function checkIfFieldFilled(field) {
      // Check se-expand-button__button-text (shows selected value in collapsed state)
      const btnText = field.querySelector('.summary__attributes--value .se-expand-button__button-text');
      if (btnText && btnText.textContent.trim()) return true;
      const fakeMenuText = field.querySelector('.summary__attributes--value button[name^="attributes."] .btn__text');
      if (fakeMenuText && fakeMenuText.textContent.trim()) return true;
      // Limited-options pills store their selection as aria-pressed="true"
      // (no button-text / input), so detect a selected pill as "filled".
      if (field.querySelector('.btn--tertiary[aria-pressed="true"], .summary__attributes--pill[aria-pressed="true"]')) return true;
      // Check input value
      const input = field.querySelector('.summary__attributes--value input') || field.querySelector('input');
      return !!(input && input.value);
    }

    // _0x54bf33: check if a specific value was accepted
    function checkIfValueAdded(labelName, value) {
      const field = getFieldByLabel(labelName);
      if (!field) return false;
      const btnText = field.querySelector('.summary__attributes--value .se-expand-button__button-text');
      if (btnText && btnText.textContent.trim().toLowerCase() === value.toLowerCase()) return true;
      const fakeMenuText = field.querySelector('.summary__attributes--value button[name^="attributes."] .btn__text');
      if (fakeMenuText && fakeMenuText.textContent.trim().toLowerCase() === value.toLowerCase()) return true;
      const input = field.querySelector('.summary__attributes--value input');
      return !!(input && input.value.toLowerCase().trim() === value.toLowerCase().trim());
    }

    // _0x541d4a: get text from an option button (strips .textual-display.clipped)
    function getOptionText(btn) {
      let text = btn.textContent;
      const clipped = btn.querySelector('.textual-display.clipped');
      if (clipped) text = text.replace(clipped.textContent, '');
      return text.trim();
    }

    // _0x573513: PUT to eBay draft API using captured request headers
    async function putAttributeToAPI(labelName, value) {
      if (!_0x567807.length) { console.warn('PhiloShip: no captured headers for API PUT'); return; }
      const headers = new Headers();
      for (const h of _0x567807) headers.append(h.name, h.value);
      const draftId = new URLSearchParams(location.search).get('draftId');
      const url = `${location.origin}/lstng/api/listing_draft/${draftId}?mode=AddItem&forceValidation=true`;
      const body = new TextEncoder().encode(JSON.stringify({ attributes: { [labelName]: [value] } }));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch(url, { method: 'PUT', headers, body, signal: ctrl.signal });
        console.log(`PhiloShip: API PUT "${labelName}" = "${value}" → ${res.status}`);
      } catch(e) { console.error('PhiloShip: API PUT error:', e.name === 'AbortError' ? 'timed out' : e.message); }
      finally { clearTimeout(timer); }
    }

    // _0x1826a7: fill singleSelectWithLimitedOptions (clicks .btn--tertiary)
    // fallbackToFirst: when the requested value isn't among the options, pick the
    // first valid option so a REQUIRED limited-options field is never left blank.
    async function fillLimitedOptions(labelName, value, fallbackToFirst = false) {
      const field = getFieldByLabel(labelName);
      if (!field) return;
      scrollIntoView(field);
      await sleep(100);
      const options = Array.from(field.querySelectorAll('.btn--tertiary'));
      const target = String(value || '').toLowerCase().trim();
      let found =
        options.find(btn => getOptionText(btn).toLowerCase() === target) ||
        options.find(btn => {
          const t = getOptionText(btn).toLowerCase();
          return t && target && (t.includes(target) || target.includes(t));
        });
      if (!found && fallbackToFirst) {
        found = options.find(btn => getOptionText(btn) && !/select|choose/i.test(getOptionText(btn)));
      }
      if (found) {
        found.click();
        await waitForNetworkResponse();
        await sleep(100);
      }
    }

    // _0x3ae02/_0x51a803: fill singleSelect or inputRequired
    // 1) set input.value + fire events → wait → check
    // 2) if not accepted → _0x498213 path: PUT to API
    async function fillSingleOrInput(labelName, value) {
      const field = getFieldByLabel(labelName);
      if (!field) return false;
      scrollIntoView(field);
      await sleep(100);
      if (checkIfValueAdded(labelName, value)) return true;

      const input = field.querySelector('input');
      if (input) {
        input.focus();
        input.value = value;
        fireAttributeChange(input);
        await waitForNetworkResponse();
        await sleep(300);
      }

      if (checkIfValueAdded(labelName, value)) { console.log(`PhiloShip: "${labelName}" ✓ via input`); return true; }

      // _0x498213: create custom item specific via API PUT
      console.log(`PhiloShip: "${labelName}" not accepted via input — trying API PUT`);
      await putAttributeToAPI(labelName, value);
      await waitForNetworkResponse();
      await sleep(300);
      return true;
    }

    // _0x38ad66: fill multiSelect via API PUT
    async function fillMultiSelect(labelName, values) {
      const arr = Array.isArray(values) ? values : [values];
      const filtered = arr.filter(v => v.length <= 30).slice(0, 25);
      if (!filtered.length) return;
      await putAttributeToAPI(labelName, filtered[0]); // simplified - full impl would loop
      await waitForNetworkResponse();
    }

    // _0x357e6d: route to correct filler based on field type
    async function fillAttributeDropdown(labelName, value) {
      console.log(`PhiloShip: filling "${labelName}" → "${value}"`);
      const field = getFieldByLabel(labelName);
      if (!field) {
        console.warn(`PhiloShip: "${labelName}" field not found — skipping`);
        return false;
      }
      const type = getFieldType(field);
      console.log(`PhiloShip: "${labelName}" type = ${type}`);

      if (type === 'multiSelect' || type === 'multiSelectWithNoSearch') {
        await fillMultiSelect(labelName, value);
      } else if (type === 'singleSelectWithLimitedOptions') {
        await fillLimitedOptions(labelName, value);
      } else {
        // singleSelect, singleSelectWithNoSearch, inputRequired, or undefined
        await fillSingleOrInput(labelName, value);
      }
      await sleep(300);
      return true;
    }

    async function fillItemSpecific(fieldName, value) {
      return fillAttributeDropdown(fieldName, value);
    }

    function cleanShadeValue(value) {
      return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/^(?:shade|color|colour|style|pattern)\s*[:\-]\s*/i, '')
        .replace(/\b(?:currently selected|selected)\b/ig, '')
        .trim()
        .slice(0, 65);
    }

    function deriveShadeFromTitle(titleText) {
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

    function getBestShadeValue() {
      return cleanShadeValue(
        productData.shade ||
        productData.categoryData?.scraped?.shade ||
        productData.categoryData?.scraped?.color ||
        productData.color ||
        deriveShadeFromTitle(title)
      );
    }

    function getBestColorValue() {
      return cleanShadeValue(
        productData.categoryData?.scraped?.color ||
        productData.color ||
        productData.shade ||
        deriveShadeFromTitle(title)
      );
    }

    function getBestMaterialValue() {
      const raw =
        productData.categoryData?.scraped?.material ||
        productData.material ||
        '';
      return String(raw || '').trim();
    }

    function findAttributeButton(labelName) {
      const wanted = getFieldLabelCandidates(labelName);
      return document.querySelector(`button[name="attributes.${labelName}"]`) ||
        Array.from(document.querySelectorAll('button[aria-label], button[name^="attributes."]'))
          .find(button => {
            const aria = normalizeFieldLabel(button.getAttribute('aria-label') || '');
            const name = normalizeFieldLabel((button.getAttribute('name') || '').replace(/^attributes\./, '').trim());
            return wanted.includes(aria) || wanted.includes(name);
          });
    }

    async function fillButtonMenuAttribute(labelName, value) {
      const cleaned = cleanShadeValue(value);
      if (!cleaned) return false;
      if (checkIfValueAdded(labelName, cleaned)) return true;

      const btn = findAttributeButton(labelName);
      if (!btn) return false;
      const actualLabel = (btn.getAttribute('name') || '').replace(/^attributes\./, '').trim() ||
        (btn.getAttribute('aria-label') || '').trim() ||
        labelName;
      const compactName = actualLabel.replace(/\s+/g, '');
      scrollIntoView(btn);
      btn.click();
      await sleep(700);

      const input = document.querySelector(`input[name="search-box-attributes${compactName}"]`) ||
        document.querySelector('.filter-menu input[aria-label="Search"], .filter-menu input[aria-label="Suche"], input[id*="search-box-input-textbox"]');
      if (input) {
        input.focus();
        input.value = cleaned;
        fireAttributeChange(input);
        await sleep(500);
      }

      const menuItems = Array.from(document.querySelectorAll(
        `span[name="options-attributes${compactName}"] .menu__item, .menu__item, [role="option"]`
      )).filter(item => item.offsetParent !== null);

      const target = cleaned.toLowerCase();
      const exact = menuItems.find(item => getOptionText(item).toLowerCase() === target);
      const partial = menuItems.find(item => {
        const text = getOptionText(item).toLowerCase();
        return text && (text.includes(target) || target.includes(text));
      });
      const pick = exact || partial;

      if (pick) {
        pick.click();
        await waitForNetworkResponse();
        await sleep(400);
      } else if (input) {
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(400);
      }

      const field = getFieldByLabel(labelName);
      if ((field && checkIfFieldFilled(field)) || checkIfValueAdded(labelName, cleaned)) return true;
      await putAttributeToAPI(labelName, cleaned);
      await waitForNetworkResponse();
      await sleep(300);
      return true;
    }

    async function fillShadeSpecific() {
      const shadeValue = getBestShadeValue();
      if (!shadeValue || !getFieldByLabel('Shade')) return false;
      console.log(`PhiloShip: Shade -> "${shadeValue}"`);
      return fillButtonMenuAttribute('Shade', shadeValue);
    }

    async function fillColorSpecific() {
      const hasExteriorButton = Boolean(
        document.querySelector('button[name="attributes.Exterior Color"], button[aria-label="Exterior Color"]')
      );
      const targetLabel = hasExteriorButton || getFieldByLabel('Exterior Color')
        ? 'Exterior Color'
        : (getFieldByLabel('Color') || findAttributeButton('Color') ? 'Color' : '');
      if (!targetLabel) return false;
      const colorValue = getBestColorValue() || 'Multicolor';
      console.log(`PhiloShip: ${targetLabel} -> "${colorValue}"`);
      return fillButtonMenuAttribute(targetLabel, colorValue);
    }

    async function fillMaterialSpecific() {
      // eBay's Handbags/Purses category requires a field literally named
      // "Exterior Material" (plain "Material" in some other categories).
      // Prefer the Amazon-scraped material; fall back to "Does Not Apply"
      // so a required field is never left blank (which blocks the listing).
      const hasExteriorButton = Boolean(
        document.querySelector('button[name="attributes.Exterior Material"], button[aria-label="Exterior Material"]')
      );
      const targetLabel = hasExteriorButton || getFieldByLabel('Exterior Material')
        ? 'Exterior Material'
        : (getFieldByLabel('Material') || findAttributeButton('Material') ? 'Material' : '');
      if (!targetLabel) return false;

      const field = getFieldByLabel(targetLabel);
      if (field && checkIfFieldFilled(field)) return true;

      const materialValue = getBestMaterialValue() || 'Does Not Apply';
      console.log(`PhiloShip: ${targetLabel} -> "${materialValue}"`);
      // Button-menu fields (search dropdown) vs. plain input/select — route
      // through fillAttributeDropdown, which detects the field type. Fall back
      // to the button-menu filler if the dropdown filler doesn't find it.
      const filled = await fillAttributeDropdown(targetLabel, materialValue);
      if (filled && field && checkIfFieldFilled(field)) return true;
      return fillButtonMenuAttribute(targetLabel, materialValue);
    }

    // eBay's Handbags category requires a "Style" item specific chosen from a
    // fixed list (Tote, Crossbody, Shoulder Bag, …). The extension never filled
    // it, so purses were rejected with "The item specific Style is missing".
    // Derive it from the product title; default to the most common (Shoulder Bag).
    function deriveBagStyle() {
      const t = (title || '').toLowerCase();
      const map = [
        [/\btote\b/, 'Tote'],
        [/cross\s?body/, 'Crossbody'],
        [/satchel/, 'Satchel/Top Handle Bag'],
        [/\bhobo\b/, 'Hobo Bag'],
        [/clutch/, 'Clutch'],
        [/back\s?pack/, 'Backpack'],
        [/sling/, 'Sling Bag'],
        [/messenger/, 'Messenger Bag'],
        [/duffle|duffel/, 'Duffle'],
        [/bucket/, 'Bucket Drawstring Bag'],
        [/belt bag|fanny\s?pack|waist bag/, 'Belt Bag Fanny Pack'],
        [/laptop/, 'Laptop Bag'],
        [/gym bag/, 'Gym Bag'],
        [/saddle/, 'Saddle Bag'],
        [/top handle/, 'Top Handle Bag'],
        [/shoulder/, 'Shoulder Bag'],
      ];
      for (const [re, v] of map) if (re.test(t)) return v;
      return 'Shoulder Bag';
    }

    async function fillStyleSpecific() {
      if (!getFieldByLabel('Style') && !findAttributeButton('Style')) return false;
      const field = getFieldByLabel('Style');
      if (field && checkIfFieldFilled(field)) return true;
      const styleValue = deriveBagStyle();
      console.log(`PhiloShip: Style -> "${styleValue}"`);
      const filled = await fillAttributeDropdown('Style', styleValue);
      if (filled && field && checkIfFieldFilled(field)) return true;
      return fillButtonMenuAttribute('Style', styleValue);
    }

    function deriveDepartment() {
      const t = (title || '').toLowerCase();
      if (/\bunisex\b/.test(t)) return 'Unisex Adults';
      if (/\b(girl'?s?|toddler girl)\b/.test(t)) return 'Girls';
      if (/\b(boy'?s?|toddler boy)\b/.test(t)) return 'Boys';
      if (/\b(men'?s?|male|for men)\b/.test(t) && !/women/.test(t)) return 'Men';
      // Purses/handbags default to Women (most common); Unisex Adults is the
      // safe secondary option most bag categories also offer.
      return 'Women';
    }

    // Best-effort value for a required item specific we don't explicitly script.
    // Keeps listings from being blocked by category-specific required fields.
    function bestValueForRequiredSpecific(label) {
      const l = String(label || '').toLowerCase().trim();
      if (l === 'brand') return brand || 'Unbranded';
      if (l === 'type') return typeWords || 'Does Not Apply';
      if (l === 'style') return deriveBagStyle();
      if (l === 'department') return deriveDepartment();
      if (l === 'color' || l === 'exterior color') return getBestColorValue() || 'Multicolor';
      if (/material/.test(l)) return getBestMaterialValue() || 'Does Not Apply';
      if (l === 'size' || l === 'size type') return 'Does Not Apply';
      return 'Does Not Apply';
    }

    // GENERAL SAFETY PASS — fill every REQUIRED item specific that is still empty.
    // eBay flags required specifics with a `.required-field` element inside the
    // field container. This replaces field-by-field hardcoding: whatever the
    // category requires (Style, Department, Occasion, …), we fill it with a
    // derived value or a safe "Does Not Apply" so the listing can publish.
    async function fillAllRequiredSpecifics() {
      const fields = Array.from(document.querySelectorAll(
        '.summary__attributes--fields, .summary__attributes--section-container fieldset'
      ));
      let filledCount = 0;
      for (const field of fields) {
        const label = getFieldLabel(field).trim();
        if (!label) continue;
        const isRequired = /required-field/i.test(field.className) ||
          !!field.querySelector('[class*="required-field" i]');
        if (!isRequired) continue;
        if (checkIfFieldFilled(field)) continue;

        const value = bestValueForRequiredSpecific(label);
        const ftype = getFieldType(field);
        console.log(`PhiloShip: required specific "${label}" is empty → filling "${value}" (type ${ftype})`);
        if (ftype === 'singleSelectWithLimitedOptions') {
          await fillLimitedOptions(label, value, true); // fall back to first option
        } else {
          await fillAttributeDropdown(label, value);
        }
        await sleep(400);
        if (checkIfFieldFilled(field)) filledCount++;
        else console.warn(`PhiloShip: required specific "${label}" still empty after fill attempt`);
      }
      return filledCount;
    }




    // ── Item Specifics — using EcomSniper _0x51a803 via fillAttributeDropdown ──
    // Order: Brand first, then category-specific fields, then Type, then any remaining

    // Dedicated Form Factor filler — clicks the first available option in the menu
    async function fillFormFactor(value) {
      const map = {
        'handheld': 'Handheld/Stand-Held', 'stand-held': 'Handheld/Stand-Held',
        'desktop':  'Desktop Microphone',  'headset':    'Headset',
        'lavalier': 'Lavalier/Lapel',      'lapel':      'Lavalier/Lapel',
        'shotgun':  'Shotgun Microphone',  'condenser':  'Condenser Microphone',
        'dynamic':  'Dynamic Microphone',  'ribbon':     'Ribbon Microphone',
        'gooseneck':'Gooseneck',           'earset':     'Earset Microphone',
        'hanging':  'Hanging Microphone',  'lectern':    'Lectern Microphone',
      };
      const lower  = (value || '').toLowerCase().trim();
      const target = map[lower] || Object.entries(map).find(([k]) => lower.includes(k))?.[1] || 'Handheld/Stand-Held';
      console.log(`PhiloShip: fillFormFactor "${value}" → "${target}"`);

      // Step 1: click button[name="attributes.Form Factor"] to open dropdown
      const btn = document.querySelector('button[name="attributes.Form Factor"]');
      if (!btn) { console.warn('PhiloShip: Form Factor button not found'); return; }
      scrollIntoView(btn);
      btn.click();
      console.log('PhiloShip: Form Factor button clicked');
      await sleep(800);

      // Step 2: type into input[name="search-box-attributesFormFactor"]
      let input = document.querySelector('input[name="search-box-attributesFormFactor"]');
      if (!input) {
        for (let i = 0; i < 20; i++) {
          await sleep(150);
          input = document.querySelector('input[name="search-box-attributesFormFactor"]');
          if (input) break;
        }
      }
      if (input) {
        input.focus();
        input.value = target;
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(`PhiloShip: typed "${target}" into Form Factor search`);
        await sleep(500);
      }

      // Step 3: find matching item in span[name="options-attributesFormFactor"] .menu__item
      // Strip .textual-display.clipped spans when reading text
      function getCleanLabel(item) {
        const span = item.querySelector('span');
        if (!span) return item.textContent.trim();
        const clone = span.cloneNode(true);
        clone.querySelectorAll('.textual-display,.clipped').forEach(el => el.remove());
        return clone.textContent.trim();
      }

      const menuItems = [...document.querySelectorAll('span[name="options-attributesFormFactor"] .menu__item')];
      let clicked = false;

      // Try exact match first, then partial
      for (const pass of ['exact', 'partial']) {
        for (const item of menuItems) {
          const lbl = getCleanLabel(item).toLowerCase();
          const match = pass === 'exact'
            ? lbl === target.toLowerCase()
            : lbl.includes(lower) || lower.includes(lbl.split('/')[0].trim());
          if (match) {
            item.click();
            console.log(`PhiloShip: Form Factor → "${getCleanLabel(item)}" (${pass})`);
            clicked = true;
            await sleep(400);
            break;
          }
        }
        if (clicked) break;
      }

      // Fallback: find Handheld/Stand-Held specifically, or first item
      if (!clicked && menuItems.length > 0) {
        const handheld = menuItems.find(i => /handheld/i.test(getCleanLabel(i)));
        const pick = handheld || menuItems[0];
        pick.click();
        console.log(`PhiloShip: Form Factor → fallback "${getCleanLabel(pick)}"`);
        await sleep(400);
      }

      // Close by clicking title field
      document.querySelector('.smry.summary__title input[name="title"]')?.click();
      await sleep(300);
    }

    // 1. Brand
    await fillAttributeDropdown('Brand', brand);
    await sleep(500);

    // 2. Form Factor — use the same EcomSniper engine that handles Brand
    // The engine can find it (it shows in Available fields), so route through it
    const formFactorBtnOnPage = document.querySelector('button[name="attributes.Form Factor"]');
    if (formFactorBtnOnPage) {
      const amazonFF = productData.microphoneData?.formFactor || '';
      const ffMap = {
        'handheld': 'Handheld/Stand-Held', 'stand-held': 'Handheld/Stand-Held',
        'desktop':  'Desktop Microphone',  'headset':    'Headset',
        'lavalier': 'Lavalier/Lapel',      'lapel':      'Lavalier/Lapel',
        'shotgun':  'Shotgun Microphone',  'condenser':  'Condenser Microphone',
        'dynamic':  'Dynamic Microphone',  'ribbon':     'Ribbon Microphone',
        'gooseneck':'Gooseneck',           'earset':     'Earset Microphone',
        'hanging':  'Hanging Microphone',  'lectern':    'Lectern Microphone',
      };
      const lower   = amazonFF.toLowerCase().trim();
      const ffValue = ffMap[lower] ||
                      Object.entries(ffMap).find(([k]) => lower.includes(k))?.[1] ||
                      'Handheld/Stand-Held';
      console.log(`PhiloShip: Form Factor → "${ffValue}" (Amazon: "${amazonFF}")`);
      await fillAttributeDropdown('Form Factor', ffValue);
      await sleep(500);
    }

    // 3. Other category-specific fields (Frame Color etc.) via EcomSniper engine
    if (productData.categoryData) {
      const attrsToFill = getEbayAttributesToFill(productData.categoryData);
      for (const attr of attrsToFill) {
        if (!attr.value || attr.name === 'Form Factor') continue; // Form Factor handled above
        if (attr.name === 'Shade') continue; // Shade has a button-menu fallback below
        await fillAttributeDropdown(attr.name, attr.value);
        await sleep(400);
      }
    }

    // 4. Type — only if the field exists on this eBay category page
    const colorFilled = await fillColorSpecific();
    if (colorFilled) await sleep(400);

    const materialFilled = await fillMaterialSpecific();
    if (materialFilled) await sleep(400);

    // Style is a required specific for Handbags — fill it for bag categories.
    if (productData.categoryData?.categoryId === 'bags') {
      await fillStyleSpecific();
      await sleep(400);
    }

    // GENERAL PASS: fill any remaining REQUIRED specific (Department, Occasion,
    // etc.) that's still empty, for ANY category — so a required field we didn't
    // hardcode can't silently block the listing.
    await fillAllRequiredSpecifics();
    await sleep(300);

    const shadeFilled = await fillShadeSpecific();
    if (shadeFilled) await sleep(400);

    if (getFieldByLabel('Type')) {
      await fillAttributeDropdown('Type', typeWords);
      await sleep(500);
    }

    // 5. Device Charging Range — fill min=1, max=scraped Amazon "Range" value
    // Uses two inputs both named "attributes.Device Charging Range"
    const chargingInputs = document.querySelectorAll('input[name="attributes.Device Charging Range"]');
    if (chargingInputs.length >= 2 && productData.chargingRangeMax) {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      // Min input (first)
      nativeSetter.call(chargingInputs[0], '1');
      chargingInputs[0].dispatchEvent(new Event('input',  { bubbles: true }));
      chargingInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      // Max input (second) — use the scraped Amazon Range value
      nativeSetter.call(chargingInputs[1], String(productData.chargingRangeMax).trim());
      chargingInputs[1].dispatchEvent(new Event('input',  { bubbles: true }));
      chargingInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      console.log(`PhiloShip: Device Charging Range set to 1 – ${productData.chargingRangeMax}`);
      await waitForNetworkResponse();
    }

    // 5. Any remaining required invalid fields
    const filledLabels = new Set([
      'brand', 'type', 'form factor',
      ...(colorFilled ? ['color', 'exterior color'] : []),
      ...(materialFilled ? ['material', 'exterior material'] : []),
      ...(shadeFilled ? ['shade'] : []),
      ...(productData.categoryData
        ? getEbayAttributesToFill(productData.categoryData).map(a => a.name.toLowerCase())
        : [])
    ]);
    for (const field of getAllItemSpecificFields()) {
      const lbl = getFieldLabel(field).trim();
      if (!lbl || filledLabels.has(lbl.toLowerCase())) continue;
      if (checkIfFieldFilled(field)) continue;
      const input = field.querySelector('input');
      if (!input) continue;
      const isInvalid = field.querySelector('[aria-invalid="true"], .field__errors:not(.clipped)');
      if (!isInvalid) continue;
      await fillAttributeDropdown(lbl, sku || 'Does Not Apply');
      await sleep(400);
    }


    // Step 6: set price — productData.price is the markup-calculated eBay price
    console.log('PhiloShip: price check — productData.price:', productData.price,
                'productData.custom_price:', productData.custom_price,
                'using:', price);
    // Step 6: set price
    console.log('PhiloShip: setting price', price);
    await enforceListingPrice(price);
    await setQuantity(quantity);
    await sleep(500);

    // Step 7: enable + paste SKU
    if (!skuInputExists()) await enableSku();
    if (sku) await pasteSku(btoa(sku));
    await sleep(300);

    // Step 7a: eBay policy warning check — scan title + description for risky keywords
    const policyWarnings = checkEbayPolicies(title, desc);
    if (policyWarnings.length > 0) {
      console.warn('PhiloShip: eBay policy warnings:', policyWarnings);
      // Send warning back to popup via background — non-blocking
      sendRuntimeMessage({
        action: 'policy_warning',
        warnings: policyWarnings,
        product: title.slice(0, 60),
      }, { ignoreInvalidation: true }).catch(() => {});
    }

    // Step 7b: set shipping — Flat Rate Freight at $0.05
    await setShipping();

    // Step 8: upload images — up to 12 via url-to-b64 → DataTransfer → #fehelix-uploader
    // 1. send url-to-b64 to background → get base64
    // 2. base64 → File object (_0x27f840)
    // 3. DataTransfer → set on #fehelix-uploader → fire change (_0x3466bd)
    // 4. poll countImages() until count increases
    const imagesExpected = !!(images && images.length > 0);
    let imagesUploadedOk = !imagesExpected; // if no images expected, treat as satisfied
    if (imagesExpected) {
      console.log('PhiloShip: uploading', images.length, 'images');

      // _0x27f840: convert base64 string to File object
      function stripFileExtension(filename) {
        return String(filename || 'image').replace(/\.[^.]+$/, '') || 'image';
      }

      function mimeToExtension(mime) {
        const lower = String(mime || '').toLowerCase();
        if (lower.includes('png')) return 'png';
        if (lower.includes('gif')) return 'gif';
        if (lower.includes('webp')) return 'webp';
        if (lower.includes('avif')) return 'avif';
        return 'jpg';
      }

      function parseImageData(imageData) {
        const raw = String(imageData || '').trim();
        const match = raw.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/i);
        if (!match) {
          return {
            mime: 'image/jpeg',
            dataUrl: `data:image/jpeg;base64,${raw}`,
            base64: raw.replace(/\s+/g, '')
          };
        }
        return {
          mime: (match[1] || 'image/jpeg').toLowerCase(),
          dataUrl: raw,
          base64: (match[2] || '').replace(/\s+/g, '')
        };
      }

      function base64ToBytes(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function convertImageDataToJpegFile(dataUrl, filename) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          // Guarantee this never hangs: some data URLs (e.g. malformed webp)
          // fire neither onload nor onerror. Reject after 15s so the upload
          // loop moves on instead of freezing the whole listing.
          let done = false;
          const finish = fn => (...a) => { if (done) return; done = true; clearTimeout(timer); fn(...a); };
          const timer = setTimeout(() => { if (done) return; done = true; reject(new Error('Image decode timed out')); }, 15000);
          img.onload = finish(() => {
            const width = img.naturalWidth || img.width;
            const height = img.naturalHeight || img.height;
            if (!width || !height) {
              reject(new Error('Image data did not decode to a usable size'));
              return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('Canvas 2D context was unavailable'));
              return;
            }

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob(blob => {
              if (!blob || !blob.size) {
                reject(new Error('Canvas conversion returned an empty JPEG blob'));
                return;
              }
              resolve(new File([blob], `${stripFileExtension(filename)}.jpg`, {
                lastModified: Date.now(),
                type: 'image/jpeg'
              }));
            }, 'image/jpeg', 0.92);
          });
          img.onerror = finish(() => reject(new Error('Image data could not be decoded for upload')));
          img.src = dataUrl;
        });
      }

      async function b64ToFile(b64, filename) {
        const parsed = parseImageData(b64);
        if (!parsed.base64) {
          throw new Error('Image payload was empty');
        }

        if (!/^image\/(jpeg|jpg|png|gif)$/i.test(parsed.mime)) {
          return convertImageDataToJpegFile(parsed.dataUrl, filename);
        }

        const blob = new Blob([base64ToBytes(parsed.base64)], { type: parsed.mime });
        return new File([blob], `${stripFileExtension(filename)}.${mimeToExtension(parsed.mime)}`, {
          lastModified: Date.now(),
          type: parsed.mime
        });
      }

      function getUploaderInput() {
        const selectors = [
          '#fehelix-uploader',
          'input[type="file"][accept*="image" i]',
          'input[type="file"][name*="image" i]',
          'input[type="file"][id*="upload" i]',
          'input[type="file"]'
        ];
        for (const selector of selectors) {
          const input = document.querySelector(selector);
          if (input) return input;
        }
        return null;
      }

      function getUploaderRoot(inputEl = getUploaderInput()) {
        const visibleUploader = document.querySelector(
          '.uploader-thumbnails-ux, .uploader-ui-ux__options, .uploader, .uploader-thumbnails, [class*="uploader"], [data-testid*="upload" i]'
        );
        if (!inputEl) return visibleUploader || document.body;
        return inputEl.closest(
          '.uploader, .uploader-thumbnails, .uploader-thumbnails-ux, [class*="uploader"], [data-testid*="upload" i]'
        ) || visibleUploader || inputEl.parentElement || document.body;
      }

      function isGuidanceThumbnail(thumbnail) {
        if (!thumbnail) return true;
        const text = [
          thumbnail.textContent,
          thumbnail.querySelector?.('button')?.getAttribute('aria-label'),
          thumbnail.getAttribute?.('aria-label'),
          thumbnail.className
        ].filter(Boolean).join(' ');
        if (/empty slot|image guidance|upload photo|photo nan|video|front|back|sides|bottom|interior|pockets|corners|straps|hardware|accessories/i.test(text)) {
          return true;
        }
        if (thumbnail.querySelector?.('.uploader-thumbnails-ux-image-guidance')) return true;
        const img = thumbnail.querySelector?.('img');
        const src = img?.getAttribute('src') || '';
        return /ir\.ebaystatic\.com\/cr\/v\/c01\//i.test(src);
      }

      function getRealUploaderThumbnails(root = getUploaderRoot()) {
        const scope = root || document;
        const selectors = [
          '.uploader-thumbnails-ux__thumbnail',
          '.uploader-thumbnails__thumbnail',
          '[data-testid*="thumbnail" i]',
          '[class*="thumbnail" i]'
        ];
        const seen = new Set();
        const thumbnails = [];
        for (const selector of selectors) {
          for (const node of scope.querySelectorAll(selector)) {
            if (seen.has(node)) continue;
            seen.add(node);
            if (!isGuidanceThumbnail(node)) thumbnails.push(node);
          }
        }
        return thumbnails;
      }

      function getRealUploaderImages(root = getUploaderRoot()) {
        const seen = new Set();
        const images = [];
        for (const thumbnail of getRealUploaderThumbnails(root)) {
          for (const img of thumbnail.querySelectorAll('img')) {
            const src = img.getAttribute('src') || '';
            if (!src || /ir\.ebaystatic\.com\/cr\/v\/c01\//i.test(src) || seen.has(img)) continue;
            seen.add(img);
            images.push(img);
          }
        }
        return images;
      }

      // _0x3466bd: set file on input via DataTransfer + fire change
      function setFileOnInput(file, inputEl) {
        const dt = new DataTransfer();
        dt.items.add(file);
        inputEl.files = dt.files;
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      function dispatchFileDrop(file, root = getUploaderRoot()) {
        const dt = new DataTransfer();
        dt.items.add(file);
        const targets = [
          root.querySelector?.('.uploader-ui-ux__options'),
          root.querySelector?.('.uploader-thumbnails-ux__grid'),
          root.querySelector?.('button[aria-label*="Upload Photo" i]'),
          root,
          document.querySelector('.uploader-thumbnails-ux'),
          document.querySelector('.uploader-ui-ux__options')
        ].filter(Boolean);

        const seen = new Set();
        for (const target of targets) {
          if (seen.has(target)) continue;
          seen.add(target);
          scrollIntoView(target);
          for (const type of ['dragenter', 'dragover', 'drop']) {
            const event = new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt
            });
            target.dispatchEvent(event);
          }
        }
      }

      // _0x56854e: count uploaded images
      function countUploadedImages() {
        // Most reliable signal across every uploader layout (including the
        // SellLikeItem/calculated-shipping grid): eBay renders an
        // "Edit or view photo N" + "Delete photo N" action button for each real
        // photo on the draft. The thumbnail grid, by contrast, contains empty
        // placeholder slots and filled slots that don't expose a plain <img src>,
        // so the old selectors under-counted (often to 0) and broke both the
        // upload-progress wait and the imageless-listing guard.
        const photoIndices = new Set();
        for (const btn of document.querySelectorAll('button[aria-label]')) {
          const m = (btn.getAttribute('aria-label') || '')
            .match(/(?:edit or view|delete)\s+photo\s+(\d+)/i);
          if (m) photoIndices.add(parseInt(m[1], 10));
        }
        if (photoIndices.size) return photoIndices.size;

        const realCount = getRealUploaderThumbnails(document).length || getRealUploaderImages(document).length;
        if (document.querySelector('.uploader-thumbnails-ux')) return realCount;

        const el = document.querySelector('.uploader-thumbnails__photo-count') ||
                   document.querySelector('.uploader-ui-img-g__header') ||
                   document.querySelector('.uploader-thumbnails-ux__header__photo-count');
        if (el) {
          const m = el.innerText.match(/(\d+)/);
          if (m) return parseInt(m[1], 10);
        }

        return realCount;
      }

      function getLoadedUploaderPreviewCount(root = getUploaderRoot()) {
        let count = 0;
        for (const img of getRealUploaderImages(root)) {
          if (img.complete && img.naturalWidth > 0) count++;
        }
        return count;
      }

      function getUploaderProgressState(root = getUploaderRoot()) {
        const scope = root || document;
        const realThumbnails = getRealUploaderThumbnails(scope);
        return {
          loadedPreviewCount: getLoadedUploaderPreviewCount(scope),
          imageCount: countUploadedImages(),
          thumbnailCount: realThumbnails.length,
          removeButtonCount: scope.querySelectorAll(
            'button[aria-label*="remove" i], button[title*="remove" i], [class*="remove" i]'
          ).length,
          busyCount: scope.querySelectorAll(
            '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="progress" i], [class*="uploading" i]'
          ).length,
        };
      }

      function uploaderStateAdvanced(currentState, baselineState) {
        if (!currentState || !baselineState) return false;
        if (currentState.loadedPreviewCount > baselineState.loadedPreviewCount) return true;
        const idleNow = currentState.busyCount === 0;
        if (idleNow && currentState.imageCount > baselineState.imageCount) return true;
        if (idleNow && currentState.thumbnailCount > baselineState.thumbnailCount) return true;
        if (idleNow && currentState.removeButtonCount > baselineState.removeButtonCount) return true;
        return false;
      }

      function waitForUploaderPreviewIncrease(root = getUploaderRoot(), baselineState = getUploaderProgressState(root), timeoutMs = 60000) {
        return new Promise(resolve => {
          let settled = false;
          const finish = value => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            clearTimeout(timer);
            resolve(value);
          };

          const check = () => {
            if (uploaderStateAdvanced(getUploaderProgressState(root), baselineState)) {
              finish(true);
            }
          };

          const observer = new MutationObserver(() => check());
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'srcset', 'class', 'style', 'aria-busy']
          });

          const timer = setTimeout(() => finish(false), timeoutMs);
          check();
          const poll = setInterval(() => {
            if (settled) {
              clearInterval(poll);
              return;
            }
            check();
          }, 500);
        });
      }

      async function waitForUploaderIdle(root = getUploaderRoot(), timeoutMs = 30000) {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const busy = root.querySelector(
            '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="progress" i], [class*="uploading" i]'
          );
          if (!busy) return true;
          await sleep(300);
        }
        return false;
      }

      // _0x3fb5f6: ask background to fetch image as base64 (bypasses Amazon CORS)
      function fetchImageAsBase64(url) {
        return new Promise((resolve, reject) => {
          if (!url) {
            reject(new Error('Missing image URL'));
            return;
          }
          // Safety net: even if the background service worker never replies
          // (e.g. it was suspended mid-fetch), never let the await hang the
          // whole listing. Reject after 25s so the upload loop can move on.
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('Image download timed out (no response from background)'));
          }, 25000);
          sendRuntimeMessage({ type: 'url-to-b64', url })
            .then(res => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (res?.error) reject(new Error(res.error));
              else if (!res?.b64Image) reject(new Error('Image download returned empty data'));
              else resolve(res.b64Image);
            })
            .catch(error => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(error);
            });
        });
      }

      // _0x508bdd: upload one image and wait for count to increase
      async function uploadOneImage(imageData, filename, currentCount) {
        const fileInput = document.querySelector('#fehelix-uploader') || getUploaderInput();
        if (!fileInput) { console.warn('PhiloShip: #fehelix-uploader not found'); return false; }
        scrollIntoView(fileInput);
        const file = await b64ToFile(imageData, filename);
        setFileOnInput(file, fileInput);

        return new Promise(resolve => {
          const iv = setInterval(() => {
            if (countUploadedImages() > currentCount) { clearInterval(iv); resolve(true); }
          }, 1000);
          setTimeout(() => { clearInterval(iv); resolve(false); }, 15000);
        });
      }

      // Upload selected_image first, then the rest
      const titleSlug = (title || 'image').substring(0, 100);
      // The uploader may not be mounted the instant we reach this step (esp. on
      // SellLikeItem / freshly navigated drafts). Poll for it before giving up.
      let fileInput = document.querySelector('#fehelix-uploader') || getUploaderInput();
      for (let i = 0; i < 30 && !fileInput; i++) {
        await sleep(1000);
        fileInput = document.querySelector('#fehelix-uploader') || getUploaderInput();
      }

      if (fileInput) {
        // Upload the primary image first, then the rest. Each image is wrapped
        // in its own try/catch so one bad/slow URL can't skip the others or
        // stall the whole flow.
        const orderedUrls = [productData.selected_image || images[0]];
        for (let i = 1; i < Math.min(images.length, 12); i++) orderedUrls.push(images[i]);

        for (let i = 0; i < orderedUrls.length; i++) {
          try {
            const count = countUploadedImages();
            const b64 = await fetchImageAsBase64(orderedUrls[i]);
            await uploadOneImage(b64, `${titleSlug}-${i + 1}.jpg`, count);
            await waitForNetworkResponse();
            await sleep(500);
          } catch(e) {
            console.warn('PhiloShip: image', i + 1, 'failed:', e.message);
          }
        }
        // Wait for eBay to finish PROCESSING the uploads before moving on.
        // Without this the flow can race to "List it" while photos are still
        // uploading — the description step used to add an incidental delay that
        // masked this; now we wait explicitly.
        const expectedImages = Math.min(orderedUrls.length, 12);
        const settleStart = Date.now();
        // Wait until all expected photos are on the draft, but don't let one
        // slow/failed image stall the run — cap at 25s and proceed with whatever
        // uploaded (the photo guard below still blocks a truly empty listing).
        while (Date.now() - settleStart < 25000) {
          await waitForUploaderIdle();
          if (countUploadedImages() >= expectedImages) break;
          await sleep(1000);
        }
        await waitForUploaderIdle();
        console.log('PhiloShip: images settled, total on draft:', countUploadedImages(), 'of', expectedImages);
      } else {
        console.warn('PhiloShip: image uploader not found after waiting');
      }
    }

    // eBay requires at least one photo. Verify the draft actually HAS photos
    // before listing — unconditionally, even if the images array was empty or
    // an upload silently failed. Never submit a photoless listing.
    imagesUploadedOk = countUploadedImages() > 0;
    if (!imagesUploadedOk) {
      console.error('PhiloShip: no photos on the draft — will not submit an imageless listing');
    }
    // Description — always insert our own polished description (eBay's "Use AI
    // description" needs a manual accept and often left the field empty). Write
    // it straight into the RTE; PUT via the draft API only as a last resort.
    console.log('PhiloShip: inserting generated description');
    await setDescription(desc);
    await sleep(500);
    if (isDescriptionEmpty()) {
      console.log('PhiloShip: RTE insert did not stick — PUTting description via draft API');
      await putDraftField('description', desc);
      await waitForNetworkResponse();
      await sleep(500);
      await setDescription(desc);
      await sleep(400);
    }

    // Step 9: click the List button — but never submit an imageless listing
    if (!imagesUploadedOk) {
      return {
        success: false,
        error: 'Images did not upload — listing was not submitted. The eBay draft has been left open so you can add photos and list manually.',
      };
    }
    // Parse eBay's validation errors and fix whatever it names, so a blocked
    // publish can be remediated and retried automatically.
    async function remediateListingErrors(errorText) {
      const text = String(errorText || '') + ' ' + collectAllErrorText();
      // "The item specific <Name> is missing." (and similar phrasings)
      const missing = new Set();
      const re = /item specific\s+(.+?)\s+is (?:missing|required|invalid)/gi;
      let m;
      while ((m = re.exec(text)) !== null) missing.add(m[1].trim());
      for (const name of missing) {
        const value = bestValueForRequiredSpecific(name);
        console.log(`PhiloShip: remediating missing specific "${name}" → "${value}"`);
        const field = getFieldByLabel(name);
        if (field && getFieldType(field) === 'singleSelectWithLimitedOptions') {
          await fillLimitedOptions(name, value, true);
        } else {
          await fillAttributeDropdown(name, value);
        }
        await sleep(300);
      }
      // Re-run the general required pass to catch anything else.
      await fillAllRequiredSpecifics();
      // Description problems.
      if (/description/i.test(text) && isDescriptionEmpty()) {
        await setDescription(desc);
        await sleep(400);
        if (isDescriptionEmpty()) { await putDraftField('description', desc); await waitForNetworkResponse(); }
      }
      await sleep(600);
    }

    function collectAllErrorText() {
      return Array.from(document.querySelectorAll(
        '.page-notice--attention, .inline-notice--attention, .inline-notice__message, .field__errors:not(.clipped), [role="alert"], [aria-invalid="true"]'
      )).map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 600);
    }

    // Step 9 & 10: submit, and if eBay blocks it with validation errors,
    // auto-remediate the named fields and retry once.
    const clickListAndWait = async () => {
      const listBtn = getListButton();
      if (!listBtn) {
        console.error('PhiloShip: List button not found');
        return { ok: false, fatal: true, error: 'Could not find the List button in .smry.summary__cta' };
      }
      listBtn.click();
      console.log('PhiloShip: List button clicked');
      return waitForSuccess();
    };

    const listedSuccessfully = () => {
      if (location.href.includes('/sl/success') || location.href.match(/\/itm\/\d+/)) {
        const m = location.href.match(/(\d{10,})/);
        return { success: true, itemId: m?.[1] || '', ebayUrl: location.href };
      }
      return null;
    };

    // Detect eBay's "duplicate listing" block. This means the item is ALREADY
    // listed, so it's effectively done — retrying only wastes time and re-hits
    // the same wall. Treat it as a non-fatal skip so bulk keeps going.
    const isDuplicateListingError = (errText) => {
      const text = (String(errText || '') + ' ' + collectAllErrorText()).toLowerCase();
      return /duplicate listing|more than one fixed price listing of the same item|already have (an active )?listing/.test(text);
    };

    let outcome = await clickListAndWait();
    if (!outcome.ok && !outcome.fatal) {
      const early = listedSuccessfully();
      if (early) return early;
      if (isDuplicateListingError(outcome.error)) {
        console.warn('PhiloShip: eBay reports this item is already listed (duplicate) — skipping.');
        return {
          success: false,
          duplicate: true,
          alreadyListed: true,
          error: 'Item is already listed on eBay (duplicate) — skipped, not an error.',
        };
      }
      console.warn('PhiloShip: List blocked — auto-remediating and retrying once:', outcome.error);
      await remediateListingErrors(outcome.error);
      outcome = await clickListAndWait();
      // Re-check for duplicate after the retry as well.
      if (!outcome.ok && isDuplicateListingError(outcome.error)) {
        console.warn('PhiloShip: duplicate listing after retry — skipping.');
        return {
          success: false,
          duplicate: true,
          alreadyListed: true,
          error: 'Item is already listed on eBay (duplicate) — skipped, not an error.',
        };
      }
    }

    if (outcome.ok) {
      const itemUrl = getItemUrl();
      const m       = itemUrl.match(/\/itm\/(\d+)/);
      return { success: true, itemId: m?.[1] || '', ebayUrl: itemUrl };
    }
    const late = listedSuccessfully();
    if (late) return late;

    return {
      success: false,
      error: outcome.error
        ? `eBay would not publish the listing: ${outcome.error}`
        : 'Listing did not confirm success within 2 minutes (it may still have published — check Active listings)',
    };
  }

  // ── Router ────────────────────────────────────────────────────────────────

  const isPrelist  = location.href.includes('/sl/prelist/suggest');
  const isIdentify = location.href.includes('/sl/prelist/identify');
  const isLstng    = location.href.includes('/lstng');

  // Identify page handling — SPA-aware.
  // eBay's prelist routes suggest → identify WITHOUT a full page reload, so the
  // content script (injected on suggest) is never re-run on the identify view
  // and the one-shot check below would never fire. Watch for the URL entering
  // the identify step and run the handler then, once per identify session.
  function maybeHandleIdentify() {
    if (!location.href.includes('/sl/prelist/identify')) return;
    // Shared guard so the manifest-injected and background-injected instances
    // don't both drive the page at once.
    if (window.__philoIdentifyActive) return;
    const key = (location.href.match(/radixTrackingId=([^&]+)/) || [])[1] || location.href.split('?')[0];
    if (window.__philoIdentifyHandledFor === key) return;
    window.__philoIdentifyHandledFor = key;
    window.__philoIdentifyActive = true;
    console.log('PhiloShip: identify step detected — handling condition/continue');
    handleIdentifyPage()
      .catch(e => console.error('PhiloShip identify error:', e))
      .finally(() => { window.__philoIdentifyActive = false; });
  }
  maybeHandleIdentify();            // handle if we loaded directly on identify
  setInterval(maybeHandleIdentify, 1000); // catch SPA route changes from suggest → identify

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Receive captured headers from background webRequest
    if (msg.type === 'requestVariables') {
      _0x567807 = msg.requestHeaders || [];
      console.log('PhiloShip: received', _0x567807.length, 'request headers');
      return false;
    }

    // Network response counter increment
    if (msg.type === 'networkResponse') {
      _0x1bcef4++;
      console.log('PhiloShip: network response #', _0x1bcef4);
      return false;
    }

    if (msg.type !== 'insert_draft_details' && msg.type !== 'insert_ebay_data') return false;

    if (isPrelist) {
      handlePrelistPage(msg.productData)
        .then(r => sendResponse(r || { ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    if (isLstng) {
      postEbayData(msg.productData)
        .then(r => {
          console.log('PhiloShip: listing result:', r);
          // EcomSniper pattern: send itemListed/itemFailed via runtime.sendMessage
          // Background listens for these to know when to proceed to next item
          if (r?.success) {
            sendRuntimeMessage({
              type: 'itemListed', itemId: r.itemId, ebayUrl: r.ebayUrl
            }, { ignoreInvalidation: true }).catch(() => {});
          } else {
            sendRuntimeMessage({
              type: 'itemFailed', error: r?.error || 'Unknown error'
            }, { ignoreInvalidation: true }).catch(() => {});
          }
          sendResponse(r);
        })
        .catch(e => {
          console.error('PhiloShip error:', e);
          sendRuntimeMessage({ type: 'itemFailed', error: getErrorMessage(e) }, { ignoreInvalidation: true }).catch(() => {});
          sendResponse({ success: false, error: getErrorMessage(e) });
        });
      return true;
    }

    return false;
  });

  console.log('PhiloShip: listing script ready on', location.href.slice(0, 70));
})();

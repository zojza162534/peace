/**
 * ebay_api.js
 * ============
 * The listing engine. Handles:
 *  - OAuth token refresh (automatic)
 *  - Proxying Amazon images through the Worker so eBay can host them
 *  - Building and firing AddFixedPriceItem Trading API calls
 *  - Parsing the XML response and returning the live eBay ItemID
 *  - Category-aware item specifics to avoid error 21919303
 *
 * All network calls go through the Cloudflare Worker (no CORS issues).
 * Import this module from popup.js.
 */

// ── Hardcoded eBay category fallback ─────────────────────────────────────────
const DEFAULT_CATEGORY_ID = "11700";  // Health & Beauty > Health Care (reliable leaf fallback)

// ── Category lookup ──────────────────────────────────────────────────────────
// All IDs are verified eBay LEAF categories. Non-leaf IDs have been replaced.
const CATEGORY_RULES = [
  // Kitchen & Home
  { words: ["air fryer liner","parchment","baking sheet","wax paper"],        id: "20740"  },
  { words: ["cutting board","charcuterie","cheese board"],                    id: "13804"  },
  { words: ["knife","knives","cutlery","cleaver","sharpener"],                id: "33037"  },
  { words: ["colander","strainer","sifter"],                                  id: "20613"  },
  { words: ["mixing bowl","salad bowl","serving bowl"],                        id: "20622"  },
  { words: ["measuring cup","measuring spoon","scale"],                        id: "20625"  },
  { words: ["grater","zester","mandoline","slicer","peeler","onion holder"],   id: "20626"  },
  { words: ["spatula","tong","ladle","whisk","spoon","turner","utensil",
            "cooking tool","gadget","kitchen tool"],                           id: "20649"  },
  { words: ["oil dispenser","oil sprayer","vinegar","bottle","condiment"],     id: "20637"  },
  { words: ["can opener","bottle opener","corkscrew","wine opener"],           id: "20617"  },
  { words: ["garlic press","garlic"],                                          id: "20618"  },
  { words: ["thermometer","meat thermometer","candy thermometer"],             id: "36447"  },
  { words: ["food storage","container","tupperware","lunch box","bento"],      id: "11798"  },
  { words: ["coffee","espresso","french press","coffee maker","pour over"],    id: "4106"   },
  { words: ["blender","mixer","food processor","juicer"],                      id: "116023" },
  { words: ["instant pot","pressure cooker","slow cooker","crock pot"],        id: "116023" },
  { words: ["pan","pot","skillet","wok","cookware","cast iron","nonstick"],    id: "20621"  },
  // Home & Garden
  { words: ["candle","wax","wick","diffuser","essential oil","aroma"],         id: "11717"  },
  { words: ["plant","pot","planter","garden","seed","soil","fertilizer"],      id: "18928"  },
  { words: ["organizer","storage","shelf","rack","hook","hanger","drawer"],    id: "20580"  },
  { words: ["pillow","cushion","throw","blanket","duvet","bedding"],           id: "175758" },
  { words: ["towel","bath","shower","soap","bathroom"],                        id: "26677"  },
  { words: ["picture frame","mirror","wall art","canvas","print","poster"],    id: "26685"  },
  { words: ["lamp","light","led","bulb","lighting","lantern"],                 id: "20697"  },
  { words: ["rug","mat","carpet","doormat"],                                   id: "20574"  },
  // Electronics
  { words: ["phone case","iphone","samsung","screen protector","charger",
            "cable","adapter","usb","lightning"],                              id: "9355"   },
  { words: ["headphone","earphone","earbud","airpod","speaker","bluetooth"],   id: "112529" },
  { words: ["laptop","computer","keyboard","mouse","monitor","webcam"],        id: "177"    },
  { words: ["tablet","ipad","kindle","e-reader"],                              id: "171485" },
  { words: ["camera","lens","tripod","gimbal","gopro"],                        id: "625"    },
  { words: ["smart watch","fitness tracker","fitbit","apple watch"],           id: "178893" },
  // Clothing & Accessories
  { words: ["shirt","tshirt","hoodie","sweatshirt","jacket","coat","vest"],    id: "185100" },
  { words: ["dress","skirt","blouse","women","ladies","leggings","yoga"],      id: "15724"  },
  { words: ["shoe","sneaker","boot","sandal","slipper","loafer"],              id: "63889"  },
  { words: ["hat","cap","beanie","glove","scarf","belt","wallet","bag",
            "backpack","purse","handbag"],                                     id: "169291" },
  { words: ["jewelry","necklace","bracelet","ring","earring","pendant"],       id: "10968"  },
  // Health & Beauty
  { words: ["vitamin","supplement","protein","probiotic","collagen","omega"],  id: "180959" },
  { words: ["skincare","moisturizer","serum","face wash","toner","sunscreen"], id: "11863"  },
  { words: ["hair","shampoo","conditioner","brush","comb","curler","dryer"],   id: "11854"  },
  { words: ["makeup","lipstick","foundation","mascara","eyeshadow","blush"],   id: "31786"  },
  // Sports & Outdoors
  { words: ["yoga","mat","resistance band","dumbbell","weight","gym","workout"], id: "15273" },
  { words: ["hiking","camping","tent","sleeping bag","backpacking","outdoor"], id: "16034"  },
  { words: ["fishing","rod","reel","lure","tackle","bait"],                    id: "1492"   },
  { words: ["bike","bicycle","cycling","helmet","pump","chain"],               id: "7294"   },
  // Toys & Baby
  { words: ["toy","lego","puzzle","board game","card game","doll","action figure"], id: "220" },
  { words: ["baby","infant","toddler","diaper","stroller","car seat"],         id: "2984"   },
  { words: ["book","novel","textbook","children's book","fiction"],            id: "267"    },

  // Cleaning & Disinfecting
  { words: ["bleach","disinfect","germicidal","sanitiz","clorox","lysol","cleaner",
            "wipe","spray","deodor","antibacterial","antimicrobial","biocide",
            "healthcare clean","hospital clean","janitorial","cleaning supply",
            "floor cleaner","bathroom cleaner","kitchen cleaner","all purpose"],  id: "37990"  },
  { words: ["laundry detergent","laundry","fabric softener","dryer sheet","stain",
            "washing powder","tide","downy","gain"],                               id: "20714"  },
  { words: ["trash bag","garbage bag","bin liner","waste bag","disposable glove",
            "nitrile glove","latex glove","paper towel","tissue","napkin"],        id: "37990"  },

  // ═══ Networking & Tools — FIXED leaf category IDs ═══════════════════════════
  // 44995 was non-leaf. Use 179393 = Network Testers (leaf under Test Equipment)
  // 122963 was non-leaf. Use 58279 = Crimpers (leaf under Electrical & Test Equipment > Connectors)
  // For general networking tools/kits use 175698 = Networking Tools (leaf)
  { words: ["network tester","cable tester","lan tester","tone generator",
            "linkiq","vdv501","vdv526"],                                        id: "179393" },
  { words: ["rj45","ethernet crimp","crimp tool","crimper","crimping",
            "keystone","punch down","punchdown","110 punch",
            "pass through","pass thru","modular plug"],                         id: "58279"  },
  { words: ["network tool kit","network kit","networking kit",
            "ethernet kit","cable kit","lan kit"],                              id: "175698" },
  { words: ["cat5e","cat6a","cat6","cat7","network cable","ethernet cable",
            "patch cable","lan cable"],                                          id: "175675" },
  { words: ["wire stripper","cable stripper","wire strip","cable strip",
            "wire cutter"],                                                     id: "46458"  },
  { words: ["untwist tool","cable management","cable comb","wire comb",
            "cable organizer"],                                                 id: "175698" },
  { words: ["drill","screwdriver","wrench","hammer","plier","socket",
            "multimeter","soldering","heat gun","impact driver"],               id: "3244"   },
  { words: ["extension cord","power strip","surge protector"],                  id: "183378" },

  // Pet — only clearly pet phrases
  { words: ["dog food","dog treat","dog collar","dog leash","dog toy","dog bed",
            "cat food","cat litter","cat toy","cat bed","pet carrier","pet crate",
            "aquarium","fish tank","bird cage","hamster"],                        id: "1281"  },
  // Office
  { words: ["pen","pencil","notebook","planner","office","desk","stationery"], id: "16486"  },
  // Auto
  { words: ["car","truck","auto","vehicle","motor","tire","brake","engine"],   id: "6001"   },
];

/**
 * Picks the best eBay leaf category ID for a product title using keyword matching.
 */
export async function getSuggestedCategoryId(title, _token, _workerUrl) {
  const lower = title.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.words.some(word => lower.includes(word))) {
      console.log("PhiloShip: matched category", rule.id, "for:", title.slice(0, 50));
      return rule.id;
    }
  }
  console.log("PhiloShip: no keyword match, using default category", DEFAULT_CATEGORY_ID);
  return DEFAULT_CATEGORY_ID;
}

// ── Token management ─────────────────────────────────────────────────────────

export async function getValidToken() {
  const data = await chrome.storage.local.get([
    "ebay_access_token",
    "ebay_token_expires_at",
    "ebay_refresh_token",
    "ebay_client_id",
    "ebay_client_secret",
    "clawdbot_worker_url",
  ]);

  if (!data.ebay_refresh_token) {
    throw new Error("NOT_CONNECTED: No eBay refresh token. Connect your account in Settings.");
  }

  const now = Date.now();
  const expiresAt = data.ebay_token_expires_at || 0;

  if (data.ebay_access_token && now < expiresAt - 300_000) {
    return data.ebay_access_token;
  }

  const resp = await fetch(`${data.clawdbot_worker_url}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     data.ebay_client_id,
      client_secret: data.ebay_client_secret,
      refresh_token: data.ebay_refresh_token,
      use_env_creds: true,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Token refresh failed: ${resp.status} ${await resp.text()}`);
  }

  const token = await resp.json();
  if (!token.access_token) {
    throw new Error("Token refresh returned no access_token: " + JSON.stringify(token));
  }

  await chrome.storage.local.set({
    ebay_access_token:    token.access_token,
    ebay_token_expires_at: Date.now() + (token.expires_in || 7200) * 1000,
    ...(token.refresh_token ? { ebay_refresh_token: token.refresh_token } : {}),
  });

  return token.access_token;
}

// ── Image proxying ────────────────────────────────────────────────────────────

export async function proxyImages(imageUrls, workerUrl) {
  const proxied = [];
  for (const url of (imageUrls || []).slice(0, 12)) {
    if (!url) continue;
    let clean = String(url).split("?")[0];
    clean = clean.replace(/\._[A-Z0-9_,]+_(?=\.(jpg|jpeg|png|gif|webp))/i, "");
    clean = clean.replace(/^http:\/\//i, "https://");
    if (!clean) continue;
    proxied.push(workerUrl ? `${workerUrl}/img?u=${encodeURIComponent(clean)}` : clean);
  }
  return Array.from(new Set(proxied));
}

// ── XML builder ──────────────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractBrand(title) {
  if (!title) return "Unbranded";
  const stopWords = new Set([
    "the","a","an","for","with","and","or","in","of","to","by","from",
    "professional","heavy","duty","all","new","pack","set","kit","tool",
    "portable","digital","electric","wireless","magnetic","automatic",
    "premium","quality","high","best","ultra","super","pro","max","mini",
  ]);
  const words = title.split(/[\s,\/]+/).map(w => w.replace(/^-+|-+$/g, ''));
  const brandWords = [];
  for (const w of words) {
    if (/^\d/.test(w) || /^\(/.test(w)) break;
    if (stopWords.has(w.toLowerCase())) break;
    if (/^[A-Z]/.test(w)) {
      brandWords.push(w);
      if (brandWords.length >= 3) break;
    } else {
      break;
    }
  }
  const candidate = brandWords.length > 0 ? brandWords.join(" ") : "Unbranded";
  // If the brand is in the VeRO list, return "Unbranded" to avoid policy violations
  if (VERO_BRANDS.some(b => candidate.toLowerCase().includes(b.toLowerCase()))) {
    return "Unbranded";
  }
  return candidate;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY-AWARE ITEM SPECIFICS — fixes error 21919303
// ═══════════════════════════════════════════════════════════════════════════════
// eBay requires different mandatory specifics per category.  Rather than guess
// which specifics each category wants, we supply a broad set of "Does Not Apply"
// / generic values so eBay accepts the listing.  The seller can refine later in
// Seller Hub.  The key insight is that providing an extra specific eBay doesn't
// need is harmless, but MISSING one it requires causes a hard rejection.

/**
 * Returns an array of {name, value} item specifics for the given category.
 */
function getCategorySpecifics(categoryId, title) {
  const brand = extractBrand(title);

  // Base specifics every category needs
  const base = [
    { name: "Brand",  value: brand },
    { name: "MPN",    value: "Does Not Apply" },
    { name: "Type",   value: "See Description" },
    { name: "Model",  value: "See Description" },
    { name: "Color",  value: "Multicolor" },
  ];

  // Specifics commonly required by electronics / networking / test equipment categories
  const electronicsSpecifics = [
    { name: "Storage Capacity",   value: "Does Not Apply" },
    { name: "Connectivity",       value: "Wired" },
    { name: "Features",           value: "See Description" },
    { name: "Compatible Brand",   value: "Universal" },
    { name: "Unit Type",          value: "Unit" },
    { name: "Unit Quantity",      value: "1" },
  ];

  // Dimension specifics (required by some tool/equipment categories)
  const dimensionSpecifics = [
    { name: "Item Length",    value: "Does Not Apply" },
    { name: "Item Width",    value: "Does Not Apply" },
    { name: "Item Height",   value: "Does Not Apply" },
    { name: "Item Weight",   value: "Does Not Apply" },
  ];

  // Material / style specifics (required by some categories like bags, cases)
  const materialSpecifics = [
    { name: "Exterior Material", value: "See Description" },
    { name: "Style",             value: "See Description" },
    { name: "Department",        value: "Unisex" },
    { name: "Pattern",           value: "Solid" },
  ];

  // Categories that need electronics specifics (Storage Capacity, etc.)
  const electronicsCategories = new Set([
    "179393", // Network Testers
    "58279",  // Crimpers
    "175698", // Networking Tools
    "175675", // Ethernet Cables
    "46458",  // Wire Strippers
    "9355",   // Phone Accessories
    "112529", // Headphones
    "177",    // Computer Accessories
    "171485", // Tablets
    "625",    // Cameras
    "178893", // Smart Watches
    "183378", // Power Strips
    "3244",   // Hand Tools
    "11700",  // Home & Garden (default fallback)
  ]);

  // Categories that need dimension specifics
  const dimensionCategories = new Set([
    "175698", // Networking Tools / Kits
    "58279",  // Crimpers
    "46458",  // Wire Strippers
    "3244",   // Hand Tools
    "20580",  // Home Storage
    "11700",  // Home & Garden
  ]);

  // Categories that need material/style specifics
  const materialCategories = new Set([
    "169291", // Accessories (bags, etc.)
    "63889",  // Shoes
    "185100", // Men's Clothing
    "15724",  // Women's Clothing
  ]);

  let specifics = [...base];

  if (electronicsCategories.has(categoryId)) {
    specifics = specifics.concat(electronicsSpecifics);
  }

  if (dimensionCategories.has(categoryId)) {
    specifics = specifics.concat(dimensionSpecifics);
  }

  if (materialCategories.has(categoryId)) {
    specifics = specifics.concat(materialSpecifics);
  }

  // Safety net: if the category is unknown, add ALL specifics.
  // Better to send too many "Does Not Apply" than to miss a required one.
  if (!electronicsCategories.has(categoryId) &&
      !dimensionCategories.has(categoryId) &&
      !materialCategories.has(categoryId)) {
    specifics = specifics.concat(electronicsSpecifics, dimensionSpecifics, materialSpecifics);
  }

  return specifics;
}

/**
 * Builds the <ItemSpecifics> XML block with category-aware specifics.
 */
function buildItemSpecifics(title, categoryId) {
  const specifics = getCategorySpecifics(categoryId, title);

  // Deduplicate by name (first wins)
  const seen = new Set();
  const unique = specifics.filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });

  const xml = unique
    .map(s => `    <NameValueList><Name>${xmlEscape(s.name)}</Name><Value>${xmlEscape(s.value)}</Value></NameValueList>`)
    .join("\n");
  return `  <ItemSpecifics>\n${xml}\n  </ItemSpecifics>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TITLE & DESCRIPTION SANITIZATION — fixes error 240
// ═══════════════════════════════════════════════════════════════════════════════
// eBay error 240 means the title or description contains words that violate
// eBay policy.  Common triggers: "Amazon", brand store references, competitor
// marketplace names, warranty claims, "free shipping" (when not applicable),
// and certain promotional language.

// ── Known VeRO / trademarked brands eBay flags for unauthorized sellers ──────
const VERO_BRANDS = [
  "Klein Tools", "Cable Matters", "Fluke Networks", "Fluke", "Jonard Tools",
  "Jonard", "ZOERAX", "iMBAPrice", "VCELINK", "DOWELL", "AMPCOM",
  "InstallerParts", "Hi-Spec", "NECABLES", "LEATBUY", "Solsop",
  "trophable", "VANICE",
  // Add more brands here as you discover them
];

// Build a single regex that matches any brand (case-insensitive, word-boundary)
const BRAND_STRIP_RE = new RegExp(
  VERO_BRANDS.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi"
);

const BANNED_WORDS_REGEX = /\b(amazon|amazon\.com|amazons?|prime|prime eligible|fulfilled by amazon|fba|amzn|a]sin|visit the .* store|visit the store|walmart|walmart\.com|target\.com|alibaba|aliexpress|ali express|wish\.com|shopify|etsy|free shipping|free returns?|free return|warranty|warranted|guaranteed|money.?back.?guarantee|best seller|bestseller|#1 best|exclusive|limited time|act now|order now|click here|buy now|add to cart|sponsored|advertisement|authentic guaranteed|100% satisfaction|as seen on|top rated|number one|award.winning)\b/gi;

// Matches Amazon ASIN patterns
const ASIN_RE = /\b[A-Z0-9]{10}\b/g;

// Matches Amazon URLs
const AMAZON_URL_RE = /https?:\/\/(www\.)?amazon\.[a-z.]+\/[^\s<"]*/gi;

/**
 * Aggressively sanitizes text to prevent eBay error 240.
 * Strips: brand names, marketplace refs, promotional language,
 *         Amazon URLs/ASINs, HTML tags, and special characters.
 */
function sanitizeForEbay(text) {
  if (!text) return "";
  let s = text;
  // Strip all HTML tags
  s = s.replace(/<[^>]*>/g, " ");
  // Strip Amazon URLs
  s = s.replace(AMAZON_URL_RE, "");
  // Strip brand names that trigger VeRO
  s = s.replace(BRAND_STRIP_RE, "");
  // Strip banned marketplace/promotional words
  s = s.replace(BANNED_WORDS_REGEX, "");
  // Strip "Visit the XYZ Store" patterns
  s = s.replace(/Visit the .* Store/gi, "");
  // Strip potential ASINs (10-char alphanumeric codes common in Amazon data)
  s = s.replace(/\bB0[A-Z0-9]{8}\b/g, "");
  // Strip trademark/copyright symbols
  s = s.replace(/[™®©]/g, "");
  // Collapse whitespace
  s = s.replace(/\s{2,}/g, " ").trim();
  // Remove leading dashes/hyphens/commas from cleaned title
  s = s.replace(/^[\s,\-–—]+/, "").trim();
  return s;
}

/**
 * Builds the AddFixedPriceItem XML payload.
 */
function buildListingXML({ title, price, description, images, categoryId, quantity, condition, location, postalCode, sku }) {
  const pictureURLs = images
    .slice(0, 12)
    .map(url => `<PictureURL>${xmlEscape(url)}</PictureURL>`)
    .join("\n      ");

  const conditionId = condition === "Used" ? "3000" : "1000";
  const postalCodeXml = postalCode ? `<PostalCode>${xmlEscape(postalCode)}</PostalCode>` : "";
  const pictureDetailsXml = pictureURLs
    ? `<PictureDetails>\n      ${pictureURLs}\n    </PictureDetails>`
    : "";

  // Sanitize title and description to prevent error 240
  const cleanTitle = sanitizeForEbay(title).slice(0, 80);
  const cleanDesc  = sanitizeForEbay(description || title);

  return `<?xml version="1.0" encoding="utf-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <Title>${xmlEscape(cleanTitle)}</Title>
    <Description><![CDATA[${cleanDesc}]]></Description>
    ${sku ? `<SKU>${xmlEscape(sku)}</SKU>` : ""}
    <PrimaryCategory>
      <CategoryID>${xmlEscape(categoryId || DEFAULT_CATEGORY_ID)}</CategoryID>
    </PrimaryCategory>
    ${buildItemSpecifics(cleanTitle, categoryId || DEFAULT_CATEGORY_ID)}
    <StartPrice currencyID="USD">${parseFloat(price).toFixed(2)}</StartPrice>
    <ConditionID>${conditionId}</ConditionID>
    <Country>US</Country>
    <Currency>USD</Currency>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <Quantity>${quantity || 1}</Quantity>
    <Location>${xmlEscape(location || "United States")}</Location>
    ${postalCodeXml}
    <ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>USPSFirstClass</ShippingService>
        <ShippingServiceCost currencyID="USD">0.00</ShippingServiceCost>
      </ShippingServiceOptions>
    </ShippingDetails>
    <DispatchTimeMax>3</DispatchTimeMax>
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption>
      <RefundOption>MoneyBack</RefundOption>
      <ReturnsWithinOption>Days_30</ReturnsWithinOption>
      <ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption>
    </ReturnPolicy>
    ${pictureDetailsXml}
  </Item>
</AddFixedPriceItemRequest>`;
}

// ── Parse Trading API XML response ───────────────────────────────────────────

function parseXML(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, "text/xml");

  const ack    = doc.querySelector("Ack")?.textContent;
  const itemId = doc.querySelector("ItemID")?.textContent;
  const errors = Array.from(doc.querySelectorAll("Errors")).map(e => ({
    code:     e.querySelector("ErrorCode")?.textContent,
    message:  e.querySelector("LongMessage")?.textContent
              || e.querySelector("ShortMessage")?.textContent
              || "Unknown error",
    severity: e.querySelector("SeverityCode")?.textContent,
  }));

  return { ack, itemId, errors };
}

// ── Main: list one product via eBay's own listing UI ─────────────────────────
// Delegates to background.js which owns the tab lifecycle.
// background.js listens for the tab navigating to lstng and injects at the right moment.

function normalizeQuantity(...values) {
  for (const value of values) {
    const quantity = parseInt(value, 10);
    if (Number.isFinite(quantity) && quantity > 0) return quantity;
  }
  return 1;
}

export async function listProductOnEbay(product, settings) {
  const amazonPrice = parseFloat(product.price || 0);
  const markupVal   = settings.markup !== "" && settings.markup !== undefined
    ? parseFloat(settings.markup) : 30;
  const markup      = isNaN(markupVal) ? 30 : markupVal;
  const totalMarkup = markup + 15;
  const ebayPrice   = (amazonPrice * (1 + totalMarkup / 100)).toFixed(2);

  console.log(`PhiloShip: $${amazonPrice} x (${markup}% + 15% fees) = $${ebayPrice}`);

  const proxiedImages = await proxyImages([
    product.selected_image,
    ...(product.images || [])
  ], workerUrl);

  const productData = {
    ...product,
    price:       ebayPrice,
    quantity:    normalizeQuantity(product.quantity, settings?.quantity, settings?.defaultQuantity, 1),
    images:      proxiedImages,
    main_hd_images: proxiedImages,
    main_sd_images: proxiedImages,
    selected_image: proxiedImages[0] || "",
    description: buildDescription(product),
    title:       sanitizeForEbay(product.title).slice(0, 80),
  };

  const jobId = `listing_${product.id || Date.now()}`;
  await chrome.storage.local.remove(jobId);

  chrome.runtime.sendMessage({ action: "start_ebay_listing", productData, settings, jobId });

  return new Promise((resolve) => {
    const started = Date.now();
    const maxWait = 5 * 60 * 1000;

    const poll = setInterval(async () => {
      try {
        const data = await chrome.storage.local.get(jobId);
        const result = data[jobId];

        if (result !== undefined) {
          clearInterval(poll);
          await chrome.storage.local.remove(jobId);
          console.log(`PhiloShip: job ${jobId} result:`, result);
          if (result.success) {
            resolve({
              success:    true,
              itemId:     result.itemId,
              ebayUrl:    result.ebayUrl || `https://www.ebay.com/itm/${result.itemId}`,
              withImages: proxiedImages.length > 0,
              warnings:   [],
            });
          } else {
            resolve({ success: false, error: result.error || 'Listing failed' });
          }
        } else if (Date.now() - started > maxWait) {
          clearInterval(poll);
          console.warn(`PhiloShip: job ${jobId} timed out`);
          resolve({ success: false, error: 'Listing timed out' });
        }
      } catch (e) {
        clearInterval(poll);
        resolve({ success: false, error: e.message });
      }
    }, 1500);
  });
}

// Bulk: list entire queue ───────────────────────────────────────────────────

export async function listAllProducts(settings, onProgress) {
  const data = await chrome.storage.local.get({ queue: [] });
  const toList = data.queue.filter(p =>
    p.status !== "listed" && p.status !== "listing_failed"
  );

  const results = [];
  let listed = 0, failed = 0;

  for (let i = 0; i < toList.length; i++) {
    const product = toList[i];
    let result;

    try {
      result = await listProductOnEbay(product, settings);
      await updateQueueItem(product.id, {
        status:    "listed",
        ebayItemId: result.itemId,
        ebayUrl:   result.ebayUrl,
        listedAt:  Date.now(),
      });
      listed++;
    } catch (err) {
      result = { success: false, error: err.message };
      await updateQueueItem(product.id, {
        status:       "listing_failed",
        listingError: err.message,
      });
      failed++;
    }

    results.push({ product, ...result });
    if (onProgress) onProgress(i + 1, toList.length, product, result);

    if (i < toList.length - 1) await sleep(1200);
  }

  return { listed, failed, total: toList.length, results };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDescription(product) {
  // Strip ALL HTML first, then sanitize words
  let rawDesc = product.description || "";
  // Remove all HTML
  rawDesc = rawDesc.replace(/<[^>]*>/g, " ");
  // Convert pipes to line breaks
  rawDesc = rawDesc.replace(/\|/g, ". ");
  // Sanitize
  rawDesc = sanitizeForEbay(rawDesc);
  // Truncate to avoid overly long descriptions
  if (rawDesc.length > 800) rawDesc = rawDesc.slice(0, 800) + "...";

  const cleanTitle = sanitizeForEbay(product.title);

  // Minimal, clean description — no Amazon traces
  return `
<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
  <h2 style="color: #333;">${cleanTitle}</h2>
  ${rawDesc ? `<p>${rawDesc}</p>` : ""}
  <hr>
  <p style="color:#666; font-size:12px;">
    Ships within 3 business days from the US. 30-day returns accepted.
  </p>
</div>`.trim();
}

async function updateQueueItem(productId, updates) {
  const data = await chrome.storage.local.get({ queue: [] });
  const queue = data.queue.map(p =>
    p.id === productId ? { ...p, ...updates } : p
  );
  await chrome.storage.local.set({ queue });
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ── OAuth connect flow ────────────────────────────────────────────────────────

export function buildConsentUrl({ clientId, ruName, scopes }) {
  const scopeList = scopes || [
    "https://api.ebay.com/oauth/api_scope",
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  ];

  const scopeString = scopeList.join(" ");
  const encodedScope = encodeURIComponent(scopeString);

  return (
    `https://auth.ebay.com/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(ruName)}` +
    `&response_type=code` +
    `&scope=${encodedScope}` +
    `&prompt=login`
  );
}

export async function exchangeCodeForToken({ code, clientId, clientSecret, ruName, workerUrl }) {
  const resp = await fetch(`${workerUrl}/oauth/token`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  ruName,
    }),
  });

  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  const token = await resp.json();
  if (!token.access_token) throw new Error("No access_token in response: " + JSON.stringify(token));

  await chrome.storage.local.set({
    ebay_access_token:     token.access_token,
    ebay_refresh_token:    token.refresh_token,
    ebay_token_expires_at: Date.now() + (token.expires_in || 7200) * 1000,
  });

  return token;
}


/**
 * title_generator.js — Philo eBay Title Generator
 *
 * Pure rule-based, zero API calls. Generates eBay-optimized titles
 * by cleaning, restructuring, and keyword-prioritizing Amazon titles.
 *
 * eBay title rules:
 *  - 80 character hard limit
 *  - Front-load highest-value search keywords
 *  - Remove filler words and banned terms
 *  - Include: Brand · Product Type · Key Specs · Model · Variant
 */

// ── Words to strip entirely ───────────────────────────────────────────────────
const STRIP_WORDS = new Set([
  // Amazon/retail jargon
  'amazon','prime','exclusive','sponsored','advertisement','bestseller',
  'best seller','fulfilled by','fba','limited time','act now','order now',
  'click here','buy now','add to cart','free shipping','free returns',
  // Fluff and filler
  'amazing','incredible','awesome','fantastic','wonderful','excellent',
  'perfect','ultimate','premium','deluxe','luxury','superior','advanced',
  'professional','commercial','industrial grade','heavy duty','heavy-duty',
  'brand new','brand-new','genuine','authentic','original','real',
  'high quality','high-quality','top quality','top-quality','best quality',
  'great','good','nice','beautiful','stylish','elegant','modern',
  'multipurpose','multi-purpose','multifunctional','multi-functional',
  // Legal/warranty
  'warranty','guaranteed','money back','satisfaction guaranteed',
  'certified','fda approved','eco-friendly','bpa free','bpa-free',
  // Count/pack descriptors that are already captured elsewhere
  'each','unit','item','product','pcs','pc','piece','pieces',
  // Common filler
  'for','and','with','the','a','an','in','of','on','to','by','from',
  'our','your','their','its','this','that','these','those',
  'also','just','only','very','most','more','less','new','used',
]);

// ── Words that signal high eBay search value — keep and front-load ────────────
const HIGH_VALUE_PATTERNS = [
  // Measurements and specs (keep these — critical for search)
  /\d+\s*(?:oz|lb|lbs|g|kg|ml|l|fl oz|ounce|pound|gram|liter|litre)/i,
  /\d+\s*(?:inch|in|"|ft|feet|cm|mm|meter|metre)/i,
  /\d+\s*(?:pack|count|ct|piece|pk|set|lot|bundle)/i,
  /\d+\s*(?:watt|w|volt|v|amp|a|mah|watts)/i,
  /\d+\s*(?:gallon|gal|quart|qt|cup|pint)/i,
  // Size descriptors
  /\b(?:small|medium|large|xl|xxl|xs|s|m|l)\b/i,
  // Colors (important for apparel/home)
  /\b(?:black|white|red|blue|green|gray|grey|brown|beige|navy|silver|gold)\b/i,
];

// ── Extract brand from title ──────────────────────────────────────────────────
function extractBrand(title) {
  // Amazon titles often start with brand: "Brand Product Name ..."
  const words = title.trim().split(/\s+/);
  const first = words[0];
  // If first word is all caps or title case and not a number/common word
  if (first && first.length >= 2 && first.length <= 25 &&
      !STRIP_WORDS.has(first.toLowerCase()) &&
      !/^\d/.test(first) &&
      !/^(the|a|an|for|with|in|of|pack|set|lot)$/i.test(first)) {
    return first;
  }
  return '';
}

// ── Clean a single word/token ─────────────────────────────────────────────────
function shouldKeep(word) {
  const lower = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lower.length === 0) return false;
  if (STRIP_WORDS.has(lower)) return false;
  if (lower.length === 1 && !/\d/.test(lower)) return false;
  return true;
}

// ── Truncate to target length, breaking at word boundary ─────────────────────
function truncateSmart(str, maxLen) {
  if (str.length <= maxLen) return str;
  const cut = str.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > maxLen - 15 ? cut.slice(0, lastSpace) : cut;
}

// ── Main title generator ──────────────────────────────────────────────────────
export function generateEbayTitle(product) {
  const raw   = product.title || product.custom_title || '';
  const brand = product.brand || extractBrand(raw);

  if (!raw) return '';

  // Step 1: Split into tokens, preserving hyphenated compounds and numbers
  let tokens = raw
    .replace(/[|–—]/g, ' ')         // replace pipe/dash separators
    .replace(/\(([^)]+)\)/g, ' $1 ') // expand parentheses
    .replace(/,/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Step 2: Remove strip words but keep spec tokens (numbers + units)
  const cleaned = tokens.filter(token => {
    const lower = token.toLowerCase();
    // Always keep tokens that match high-value patterns (specs, measurements)
    if (HIGH_VALUE_PATTERNS.some(p => p.test(token))) return true;
    // Always keep numbers
    if (/^\d+$/.test(token)) return true;
    // Always keep the brand
    if (brand && lower === brand.toLowerCase()) return true;
    return shouldKeep(token);
  });

  // Step 3: Deduplicate (case-insensitive), preserving order
  const seen = new Set();
  const deduped = cleaned.filter(token => {
    const key = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Step 4: Reorder — brand first, then product type words, then specs
  // Identify spec tokens (contain numbers + units)
  const specTokens    = deduped.filter(t => HIGH_VALUE_PATTERNS.some(p => p.test(t)));
  const nonSpecTokens = deduped.filter(t => !HIGH_VALUE_PATTERNS.some(p => p.test(t)));

  // Brand goes first if not already first
  let ordered = [...nonSpecTokens];
  if (brand && ordered[0]?.toLowerCase() !== brand.toLowerCase()) {
    const brandIdx = ordered.findIndex(t => t.toLowerCase() === brand.toLowerCase());
    if (brandIdx > 0) {
      ordered.splice(brandIdx, 1);
      ordered.unshift(brand);
    }
  }

  // Append spec tokens at the end (size, weight, count, etc.)
  ordered = [...ordered, ...specTokens.filter(s => !ordered.includes(s))];

  // Step 5: Join and truncate to 80 chars
  let title = ordered.join(' ').trim();

  // If still too long, truncate smartly
  if (title.length > 80) {
    title = truncateSmart(title, 80);
  }

  // Step 6: Title-case normalization
  // Preserve existing casing for all-caps brand names and acronyms
  title = title.split(' ').map(word => {
    if (word.toUpperCase() === word && word.length > 1) return word; // keep ALL-CAPS
    if (/[A-Z]/.test(word[1])) return word; // keep camelCase/PascalCase
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');

  return title;
}

// ── Batch-generate titles for queue ──────────────────────────────────────────
export function generateTitlesForQueue(queue) {
  return queue.map(product => ({
    ...product,
    custom_title: generateEbayTitle(product),
  }));
}

// ── Policy pre-check (popup-side, lightweight) ────────────────────────────────
// Mirror of the full check in content_ebay_listing.js — catches issues before listing
export function checkEbayPoliciesPopup(title) {
  const text = (title || '').toLowerCase();
  const flags = [];
  if (/\b(bleach|peroxide|acid|flammable|aerosol|lithium battery)\b/.test(text))
    flags.push('⚠️ Hazmat — check eBay Hazmat policy');
  if (/\b(fda approved|treats|cures|prescription|pharmaceutical)\b/.test(text))
    flags.push('⚠️ Medical claim — may violate eBay policy');
  if (/\b(knife|blade|taser|stun gun|firearm|ammo)\b/.test(text))
    flags.push('⚠️ Possible restricted weapon');
  if (/\b(replica|knockoff|inspired by|not affiliated)\b/.test(text))
    flags.push('⚠️ Possible counterfeit signal');
  if (/\b(recalled|recall notice)\b/.test(text))
    flags.push('🚫 Possible recalled product — do not list');
  return flags;
}

/**
 * content_ebay_orders.js — Scrapes buyer shipping info from eBay Order Details page
 * 
 * Runs on: https://www.ebay.com/mesh/ord/details*
 *          https://www.ebay.com/sh/ord/details*
 * 
 * Adds a "🚀 Fulfill on Amazon" button to the page and parses:
 *   - Customer name, phone, street address, unit/apt, city, state, zip
 *   - Order ID, item title, eBay item ID
 */

(function () {
  "use strict";

  // Prevent double-injection
  if (document.getElementById("clawdbot-fulfill-btn")) return;

  // ── SHIPPING ADDRESS PARSER ──────────────────────────────────────────────

  const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|VI|GU|AS|MP";
  const STATE_ZIP_REGEX = new RegExp(`\\b(${US_STATES})\\s+(\\d{5}(?:-\\d{4})?)\\b`);
  const CITY_STATE_ZIP_LINE_REGEX = new RegExp(`^(.+?),?\\s+(${US_STATES})\\s+(\\d{5}(?:-\\d{4})?)$`);
  const CITY_STATE_ZIP_INLINE_REGEX = new RegExp(`\\b([A-Za-z .'-]+?),\\s*(${US_STATES})\\s+(\\d{5}(?:-\\d{4})?)\\b`, "g");
  const STREET_SUFFIXES = "aly|allee|ave|avenue|blvd|boulevard|cir|circle|ct|court|cv|cove|dr|drive|hwy|highway|ln|lane|loop|pkwy|parkway|pl|place|plz|plaza|rd|road|sq|square|st|street|ter|terrace|trl|trail|way";
  const STREET_HINT_REGEX = new RegExp(`\\b(?:${STREET_SUFFIXES})\\b`, "i");
  const ZIP_STATE_PREFIXES = [
    { re: /^00[679]/, state: "PR" },
    { re: /^008/, state: "VI" },
    { re: /^009/, state: "PR" },
    { re: /^96799/, state: "AS" },
    { re: /^9691[012]/, state: "GU" },
    { re: /^9695[012]/, state: "MP" },
  ];
  const TERRITORY_CITY_LABELS = new Set([
    "puerto rico", "virgin islands", "u s virgin islands", "us virgin islands",
    "guam", "american samoa", "northern mariana islands"
  ]);

  function createEmptyShippingInfo() {
    return {
      name: "", phone: "", urbanization: "", address: "", address2: "",
      city: "", state: "", zip: "", country: "US",
    };
  }

  function scoreShippingInfo(info) {
    let score = 0;
    if (info.name) score += 2;
    if (info.urbanization) score += 1;
    if (info.address) score += 3;
    if (info.address2) score += 1;
    if (info.city) score += 2;
    if (info.state) score += 2;
    if (info.zip) score += 2;
    if (info.phone) score += 1;
    return score;
  }

  function inferStateFromZip(zip) {
    const normalized = String(zip || "").trim();
    const match = ZIP_STATE_PREFIXES.find(entry => entry.re.test(normalized));
    return match ? match.state : "";
  }

  function isUrbanizationLine(value) {
    return /^\s*(?:urb\.?|urbanizaci[oó]n)\b/i.test(String(value || "").trim());
  }

  function isPuertoRicoShippingInfo(info) {
    return String(info?.state || "").trim().toUpperCase() === "PR" ||
      inferStateFromZip(info?.zip) === "PR";
  }

  function isKnownStateCode(value) {
    return new RegExp(`^(?:${US_STATES})$`, "i").test(String(value || "").trim().replace(/^,\s*/, ""));
  }

  function normalizeStateCodeLine(value) {
    const text = String(value || "").trim().replace(/^,\s*/, "").toUpperCase();
    return isKnownStateCode(text) ? text : "";
  }

  function isAddressUiNoiseLine(value) {
    return /^(?:copy|copy\s+state\/province|copy\s+country\/region|copy\s+city|copy\s+zip|copy\s+postal\s+code)$/i
      .test(String(value || "").trim());
  }

  function isTerritoryName(value) {
    const normalized = normalizeText(value);
    return TERRITORY_CITY_LABELS.has(normalized);
  }

  function combineUniqueAddressParts(...values) {
    const parts = [];
    const seen = new Set();
    for (const value of values) {
      const text = String(value || "").trim().replace(/,\s*$/, "");
      if (!text) continue;
      for (const part of text.split(",").map(item => item.trim()).filter(Boolean)) {
        const key = part.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(part);
      }
    }
    return parts.join(", ");
  }

  function looksLikeAddressBlock(text) {
    if (!text) return false;
    return STATE_ZIP_REGEX.test(text) ||
           /\bShip to\b/i.test(text) ||
           /\bShipping address\b/i.test(text);
  }

  function extractAddressCandidateFromText(text) {
    if (!text) return "";

    const blockMatch = text.match(
      /(Ship to|Shipping address|Delivery address)\s*([\s\S]{0,400}?)(?:\n\s*(?:Phone|Contact buyer|Buyer selected|Tracking|Order total|Payment|Return address|Leave feedback|Send message)\b|$)/i
    );

    return blockMatch ? `${blockMatch[1]}\n${blockMatch[2]}`.trim() : "";
  }

  function normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function looksLikeAsin(value) {
    return /^B0[A-Z0-9]{8}$/i.test(String(value || "").trim());
  }

  function isLikelyAsinToken(value) {
    const token = String(value || "").trim().toUpperCase();
    if (!looksLikeAsin(token)) return false;
    if (/^B0[A-Z0-9]{8}$/.test(token)) return true;
    if (!/\d/.test(token)) return false;
    if (/^[A-Z]+$/.test(token)) return false;
    return true;
  }

  function looksLikeBase64(value) {
    const text = String(value || "").trim();
    return text.length >= 8 &&
      !/\s/.test(text) &&
      /^[A-Za-z0-9+/=_-]+$/.test(text);
  }

  function safeDecodeBase64(value) {
    const original = String(value || "").trim();
    if (!looksLikeBase64(original)) return "";

    const normalized = original
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

    try {
      const decoded = atob(padded).trim();
      if (!decoded || /[\x00-\x08\x0E-\x1F]/.test(decoded)) return "";
      return decoded;
    } catch {
      return "";
    }
  }

  function isLikelySkuValue(value) {
    const text = String(value || "").trim();
    if (!text || text.length < 4) return false;
    if (/^\(?\s*(?:sku|custom label|custom sku)\s*\)?\s*:?\s*$/i.test(text)) return false;
    if (!/[A-Z0-9]/i.test(text)) return false;
    return true;
  }

  function chooseBestSku(candidates) {
    const values = Array.from(new Set((candidates || [])
      .map(value => String(value || "").trim())
      .filter(isLikelySkuValue)));

    for (const value of values) {
      const decoded = safeDecodeBase64(value);
      if (extractAmazonUrl(decoded) || extractAsin(decoded)) {
        return value;
      }
    }

    for (const value of values) {
      if (looksLikeAsin(value)) return value.toUpperCase();
    }

    for (const value of values) {
      if (looksLikeBase64(value)) return value;
    }

    return values[0] || "";
  }

  function isUsefulSearchTerm(value) {
    const text = String(value || "").trim();
    if (!text || text.length < 3) return false;
    if (/^\(?\s*(?:sku|custom label|custom sku)\s*\)?\s*:?\s*$/i.test(text)) return false;
    return /[A-Z0-9]/i.test(text);
  }

  function extractAmazonUrl(text) {
    const match = String(text || "").match(/https?:\/\/(?:www\.)?amazon\.com\/[^\s"'<>]+/i);
    return match ? match[0] : "";
  }

  function extractAsin(text) {
    const source = String(text || "");
    const urlMatch = source.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (urlMatch && isLikelyAsinToken(urlMatch[1])) {
      return urlMatch[1].toUpperCase();
    }

    const matches = source.match(/\b[A-Z0-9]{10}\b/gi) || [];
    const candidate = matches.find(isLikelyAsinToken);
    return candidate ? candidate.toUpperCase() : "";
  }

  function extractSkuCandidates(text) {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const matches = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const inline = line.match(/^\(?\s*(?:sku|custom label|custom sku)\s*\)?\s*[:#-]?\s*(.+)$/i);
      if (inline && inline[1]) {
        matches.push(inline[1].trim());
        continue;
      }

      if (/^\(?\s*(?:sku|custom label|custom sku)\s*\)?\s*:?\s*$/i.test(line) && lines[i + 1]) {
        matches.push(lines[i + 1].trim());
      }
    }

    const inlineTokens = String(text || "").match(/\b[A-Za-z0-9+/=_-]{8,}\b/g) || [];
    inlineTokens.forEach(token => {
      const decoded = safeDecodeBase64(token);
      if (extractAmazonUrl(decoded) || extractAsin(decoded)) {
        matches.push(token.trim());
      }
    });

    return matches
      .map(value => value.replace(/^[#:\s-]+/, "").trim())
      .filter(value => isLikelySkuValue(value) && !/^(?:ship to|phone|united states)$/i.test(value));
  }

  function extractSkuOrAsin() {
    const result = { sku: "", decodedSku: "", asin: "", amazonUrl: "" };
    const candidates = [];
    const seen = new Set();

    function pushCandidate(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      candidates.push(trimmed);
    }

    [
      '.lineItemCardInfo__sku .sh-secondary',
      '.lineItemCardInfo__sku',
      '[data-test-id*="sku"] .sh-secondary',
      '[data-testid*="sku"] .sh-secondary',
      '[data-test-id*="sku"]',
      '[data-testid*="sku"]',
      '[class*="lineItemCardInfo__sku"]',
      '[class*="custom-label"]',
      '[class*="CustomLabel"]'
    ].forEach(selector => {
      document.querySelectorAll(selector).forEach(el => {
        pushCandidate(el.innerText || el.textContent || "");
      });
    });

    document.querySelectorAll(
      '.lineItemCardInfo__sku, [data-test-id*="sku"], [data-testid*="sku"], [class*="sku"], [class*="SKU"]'
    ).forEach(el => {
      pushCandidate(el.innerText || el.textContent || "");
    });

    document.querySelectorAll("span, div, label, dt, dd, p, strong").forEach(el => {
      const label = (el.textContent || "").trim();
      if (!/^(?:sku|custom label|custom sku)$/i.test(label)) return;

      pushCandidate(label);
      pushCandidate(el.nextElementSibling?.innerText || el.nextElementSibling?.textContent || "");
      pushCandidate(el.parentElement?.innerText || el.parentElement?.textContent || "");
    });

    pushCandidate(document.body.innerText);

    for (const text of candidates) {
      const asin = extractAsin(text);
      if (asin && !result.asin) {
        result.asin = asin;
      }

      const skuMatches = extractSkuCandidates(text);
      if (!result.sku && skuMatches.length) {
        result.sku = chooseBestSku(skuMatches);
      }

      if (!result.amazonUrl) {
        const amazonUrl = extractAmazonUrl(text);
        if (amazonUrl) result.amazonUrl = amazonUrl;
      }

      if (result.asin && result.sku && result.amazonUrl) break;
    }

    if (!result.decodedSku && result.sku) {
      result.decodedSku = safeDecodeBase64(result.sku);
    }

    if (result.decodedSku) {
      const decodedAsin = extractAsin(result.decodedSku);
      if (!result.asin && decodedAsin) {
        result.asin = decodedAsin;
      }

      if (!result.amazonUrl) {
        const decodedAmazonUrl = extractAmazonUrl(result.decodedSku);
        if (decodedAmazonUrl) {
          result.amazonUrl = decodedAmazonUrl;
        }
      }
    }

    if (!result.asin && looksLikeAsin(result.sku)) {
      result.asin = result.sku.toUpperCase();
    }

    if (!result.sku && result.asin) {
      result.sku = result.asin;
    }

    return result;
  }

  function findQueueMatch(queue, orderMeta) {
    if (!Array.isArray(queue) || !queue.length) return null;

    if (orderMeta.itemId) {
      const byItemId = queue.find(p => p.ebayItemId === orderMeta.itemId);
      if (byItemId) return byItemId;
    }

    const candidateIds = [orderMeta.sku, orderMeta.decodedSku, orderMeta.asin]
      .map(v => String(v || "").trim())
      .filter(Boolean);

    for (const candidate of candidateIds) {
      const normalized = candidate.toUpperCase();
      const byIdentity = queue.find(p =>
        String(p.asin || "").toUpperCase() === normalized ||
        String(p.id || "").toUpperCase() === normalized
      );
      if (byIdentity) return byIdentity;
    }

    const candidateUrl = String(orderMeta.amazonUrl || "").trim();
    const candidateUrlAsin = extractAsin(candidateUrl);
    if (candidateUrl || candidateUrlAsin) {
      const byUrl = queue.find(p => {
        const queueUrl = String(p.url || "").trim();
        const queueAsin = String(p.asin || p.id || "").trim().toUpperCase();
        return (candidateUrl && queueUrl === candidateUrl) ||
          (candidateUrlAsin && queueAsin === candidateUrlAsin);
      });
      if (byUrl) return byUrl;
    }

    if (orderMeta.itemTitle) {
      const titleLower = normalizeText(orderMeta.itemTitle);
      const byTitle = queue.find(p => {
        const queueTitle = normalizeText(p.title);
        return queueTitle && (titleLower.includes(queueTitle.slice(0, 24)) || queueTitle.includes(titleLower.slice(0, 24)));
      });
      if (byTitle) return byTitle;
    }

    return null;
  }

  function parseShippingInfo() {
    const info = createEmptyShippingInfo();

    // eBay Order Details pages have several possible layouts.
    // We try multiple selector strategies.

    const allText = document.body.innerText;
    const candidates = [];
    const selectedText = document.getSelection?.().toString().trim();

    if (looksLikeAddressBlock(selectedText)) {
      candidates.push(selectedText);
    }

    // Try to find the "Ship to" or "Shipping address" section
    const shipSections = document.querySelectorAll(
      '[data-test-id="shipping-address"], .shipping-address, ' +
      '.order-details-card, .fulfillment-card, ' +
      '[class*="shippingAddress"], [class*="ship-to"], ' +
      '.address-container, [data-testid*="address"]'
    );

    for (const section of shipSections) {
      const text = section.innerText.trim();
      if (looksLikeAddressBlock(text) || text.length > 25) {
        candidates.push(text);
      }
    }

    const allElements = document.querySelectorAll("h3, h4, span, div, label, p");
    for (const el of allElements) {
      const t = el.textContent.trim().toLowerCase();
      if (t === "ship to" || t === "shipping address" || t === "delivery address") {
        const container = el.closest("div, section, article");
        if (container) {
          candidates.push(container.innerText.replace(el.textContent, "").trim());
        }
      }
    }

    const nameEl = document.querySelector('[data-test-id="buyer-name"], [class*="buyerName"]');
    if (nameEl) {
      info.name = nameEl.textContent.trim();
      const parent = nameEl.closest("div");
      if (parent) candidates.push(parent.innerText);
    }

    const textFallback = extractAddressCandidateFromText(allText);
    if (textFallback) {
      candidates.push(textFallback);
    }

    const popupStyleParsed = parsePopupStyleShippingBlock();
    if (popupStyleParsed) {
      candidates.push([
        popupStyleParsed.name,
        popupStyleParsed.address,
        popupStyleParsed.city ? `${popupStyleParsed.city}, ${popupStyleParsed.state} ${popupStyleParsed.zip}` : "",
        popupStyleParsed.phone
      ].filter(Boolean).join("\n"));
    }

    let best = { ...info };
    let bestScore = scoreShippingInfo(best);

    for (const candidate of candidates) {
      const parsed = createEmptyShippingInfo();
      parseAddressBlock(candidate, parsed);

      if (!parsed.name && info.name) {
        parsed.name = info.name;
      }

      const score = scoreShippingInfo(parsed);
      if (score > bestScore) {
        best = parsed;
        bestScore = score;
      }

      if (parsed.name && parsed.address && parsed.city && parsed.state && parsed.zip) {
        best = parsed;
        break;
      }
    }

    Object.assign(info, best);

    if (popupStyleParsed) {
      const popupScore = scoreShippingInfo(popupStyleParsed);
      if (popupScore > scoreShippingInfo(info)) {
        Object.assign(info, popupStyleParsed);
      }
    }

    // Try to get the phone number separately — eBay sometimes shows it elsewhere
    if (!info.phone) {
      const phoneMatch = allText.match(/(?:Phone|Tel|Contact)[:\s]*([+\d][\d\s().-]{7,})/i);
      if (phoneMatch) info.phone = phoneMatch[1].trim();
    }

    if (!info.city) {
      const cityButton = Array.from(document.querySelectorAll('button.tooltip__host, button[aria-describedby], button[aria-controls]'))
        .find(button => {
          const text = (button.innerText || button.textContent || "").trim();
          return text &&
            !isTerritoryName(text) &&
            !isUrbanizationLine(text) &&
            !STREET_HINT_REGEX.test(text) &&
            !/\d/.test(text) &&
            info.address &&
            normalizeText(info.address).includes(normalizeText(text));
        });
      if (cityButton) {
        info.city = (cityButton.innerText || cityButton.textContent || "").trim();
      }
    }

    normalizeShippingFields(info);

    return info;
  }

  function parsePopupStyleShippingBlock() {
    const label = Array.from(document.querySelectorAll("div, span, td, h2"))
      .find(el => {
        const text = (el.innerText || el.textContent || "").trim();
        return text === "Ship to" || text === "Shipping address";
      });

    let container = label ? label.parentElement : null;
    if (!container) {
      const zipEl = Array.from(document.querySelectorAll("*")).find(el =>
        el.children.length === 0 && /\b\d{5}(?:-\d{4})?\b/.test(el.innerText || "")
      );
      container = zipEl ? zipEl.parentElement : null;
    }

    if (!container) return null;

    const rawText = container.innerText || "";
    const lines = rawText
      .split(/[\n,]+/)
      .map(l => l.trim())
      .filter(l => l &&
        !/ship to|shipping address|united states|phone|buyer selected|tracking/i.test(l) &&
        !isAddressUiNoiseLine(l));

    const zipMatch = rawText.match(/\b\d{5}(?:-\d{4})?\b/);
    const stateMatch = rawText.match(new RegExp(`\\b(${US_STATES})\\b`));
    const broaderText = container.parentElement ? container.parentElement.innerText : rawText;
    const phoneMatch = broaderText.match(/(?:\+?\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}/);

    const zip = zipMatch ? zipMatch[0] : "";
    const inferredState = inferStateFromZip(zip);
    let state = inferredState || (stateMatch ? stateMatch[1] : "");
    const phone = phoneMatch ? phoneMatch[0] : "";
    const name = lines[0] || "";
    let zipIdx = lines.findIndex(l => zip && l.includes(zip));
    if (zipIdx === -1) {
      zipIdx = lines.findIndex(l => state && l.includes(state));
    }

    let address = "";
    let city = "";
    if (zipIdx !== -1) {
      const zipLine = lines[zipIdx] || "";
      const cityZipMatch = zipLine.match(/^(.+?),?\s+(\d{5}(?:-\d{4})?)$/);
      if (cityZipMatch && !isKnownStateCode(cityZipMatch[1])) {
        city = cityZipMatch[1].trim();
        if (isTerritoryName(city)) {
          city = lines[zipIdx - 1] || "";
          address = lines.slice(1, Math.max(1, zipIdx - 1)).join(", ");
        } else {
          address = lines.slice(1, zipIdx).join(", ");
        }
      } else {
        const beforeZip = lines.slice(1, zipIdx);
        let stateIdx = -1;
        for (let i = beforeZip.length - 1; i >= 0; i--) {
          if (normalizeStateCodeLine(beforeZip[i])) {
            stateIdx = i;
            break;
          }
        }
        if (stateIdx !== -1) {
          state = state || normalizeStateCodeLine(beforeZip[stateIdx]);
          const beforeState = beforeZip.slice(0, stateIdx);
          let cityIdx = -1;
          for (let i = beforeState.length - 1; i >= 0; i--) {
            const line = beforeState[i];
            if (line &&
                !isKnownStateCode(line) &&
                !isTerritoryName(line) &&
                !isUrbanizationLine(line) &&
                !STREET_HINT_REGEX.test(line) &&
                !/\d/.test(line)) {
              cityIdx = i;
              break;
            }
          }

          if (cityIdx !== -1) {
            city = beforeState[cityIdx];
            address = beforeState.slice(0, cityIdx).join(", ");
          } else {
            address = beforeState.join(", ");
          }
        } else {
          city = beforeZip[beforeZip.length - 1] || "";
          address = beforeZip.slice(0, -1).join(", ");
        }
      }
    } else {
      address = lines[1] || "";
      city = lines[2] || "";
    }

    if (isTerritoryName(city)) {
      city = "";
    }

    if (city && address.includes(city)) {
      address = address.split(city)[0].replace(/[, ]+$/, "");
    }

    const parsed = { name, urbanization: "", address, city, state, zip, phone, country: "US", address2: "" };
    normalizeShippingFields(parsed);
    return parsed;
  }

  function normalizeShippingFields(info) {
    if (!info) return info;

    info.name = String(info.name || "").trim();
    info.urbanization = String(info.urbanization || "").trim().replace(/,\s*$/, "");
    info.address = String(info.address || "").trim().replace(/,\s*$/, "");
    info.address2 = String(info.address2 || "").trim().replace(/,\s*$/, "");
    info.city = String(info.city || "").trim().replace(/,\s*$/, "");
    info.state = String(info.state || "").trim().toUpperCase();
    info.zip = String(info.zip || "").trim();

    if (info.city && info.name && normalizeText(info.city) === normalizeText(info.name)) {
      info.city = "";
    }
    if (isTerritoryName(info.city)) {
      info.city = "";
    }

    if (isKnownStateCode(info.city)) {
      if (!info.state) info.state = normalizeStateCodeLine(info.city);
      info.city = "";
    }

    if (info.address && info.address.includes(",")) {
      const parts = info.address.split(",").map(part => part.trim()).filter(Boolean);
      const keptParts = [];
      for (const part of parts) {
        const stateCode = normalizeStateCodeLine(part);
        if (stateCode) {
          if (!info.state) info.state = stateCode;
          continue;
        }
        keptParts.push(part);
      }

      if (!info.city && keptParts.length > 1) {
        const trailingCity = keptParts[keptParts.length - 1];
        if (trailingCity &&
            !isTerritoryName(trailingCity) &&
            !isUrbanizationLine(trailingCity) &&
            !STREET_HINT_REGEX.test(trailingCity) &&
            !/\d/.test(trailingCity)) {
          info.city = trailingCity;
          keptParts.pop();
        }
      }

      info.address = keptParts.join(", ");
    }

    if (info.city && info.address) {
      const cityPattern = new RegExp(`(?:[,\\s]+${info.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*$`, "i");
      info.address = info.address.replace(cityPattern, "").replace(/[, ]+$/, "").trim();
    }

    const splitAddressAndCity = (value) => {
      const text = String(value || "").trim().replace(/,\s*$/, "");
      if (!text || !STREET_HINT_REGEX.test(text)) return null;
      const match = text.match(new RegExp(
        `^(.*?\\b(?:${STREET_SUFFIXES})\\b(?:\\s+(?:n|s|e|w|ne|nw|se|sw|apt|apartment|unit|ste|suite|#)\\b[\\w.-]*)*)\\s+([A-Za-z .'-]+)$`,
        "i"
      ));
      if (!match) return null;
      return { address: match[1].trim(), city: match[2].trim() };
    };

    if (/^\d+[A-Za-z-]*$/.test(info.address) && info.city) {
      const repaired = splitAddressAndCity(info.city);
      if (repaired) {
        info.address = `${info.address} ${repaired.address}`.trim();
        info.city = repaired.city;
      }
    }

    if (!info.address && info.city) {
      const repaired = splitAddressAndCity(info.city);
      if (repaired) {
        info.address = repaired.address;
        info.city = repaired.city;
      }
    }

    if (info.address && !info.city) {
      const repaired = splitAddressAndCity(info.address);
      if (repaired) {
        info.address = repaired.address;
        info.city = repaired.city;
      }
    }

    if (info.address2 && !info.address && /^\d+[A-Za-z-]*$/.test(info.address2)) {
      info.address = info.address2;
      info.address2 = "";
    }

    if (info.zip) {
      const inferredState = inferStateFromZip(info.zip);
      if (inferredState && (!info.state || !isKnownStateCode(info.state) || inferredState === "PR")) {
        info.state = inferredState;
      }
    }

    if (isPuertoRicoShippingInfo(info)) {
      if (info.city && info.address.includes(",")) {
        const parts = info.address.split(",").map(part => part.trim()).filter(Boolean);
        if (parts.length > 1 && normalizeText(parts[parts.length - 1]) === normalizeText(info.city)) {
          info.address = parts.slice(0, -1).join(", ");
        }
      }

      if (!info.city && info.address.includes(",")) {
        const parts = info.address.split(",").map(part => part.trim()).filter(Boolean);
        const trailingCity = parts[parts.length - 1] || "";
        if (parts.length > 1 &&
            trailingCity &&
            !isTerritoryName(trailingCity) &&
            !isUrbanizationLine(trailingCity) &&
            !STREET_HINT_REGEX.test(trailingCity) &&
            !/\d/.test(trailingCity)) {
          info.city = trailingCity;
          info.address = parts.slice(0, -1).join(", ");
        }
      }

      const hasUrbanizationLine =
        info.urbanization ||
        isUrbanizationLine(info.address) ||
        isUrbanizationLine(info.address2);

      if (hasUrbanizationLine) {
        info.urbanization = combineUniqueAddressParts(
          info.urbanization,
          isUrbanizationLine(info.address) || info.urbanization ? info.address : "",
          info.address2
        );
      }
    }

    return info;
  }

  /**
   * Parse a raw address text block into structured fields.
   * Handles formats like:
   *   "John Doe\n123 Main St\nApt 4B\nAustin, TX 78701\nUnited States"
   *   "John Doe, 123 Main St, Austin, TX 78701"
   */
  function parseAddressBlock(raw, info) {
    if (!raw) return;

    const phoneMatch = raw.match(/(?:Phone|Tel|Contact)[:\s]*([+\d][\d\s().-]{7,})/i);
    if (phoneMatch && !info.phone) {
      info.phone = phoneMatch[1].trim();
    }

    let text = raw
      .replace(/\r/g, "\n")
      .replace(/\t+/g, "\n")
      .replace(/(?:Ship to|Shipping address|Delivery address)\s*:?/ig, "\n")
      .replace(/Phone\s*:?/ig, "\nPhone\n")
      .replace(/United States(?: of America)?/ig, "\nUnited States\n")
      .trim();

    // Split into lines, filtering empties
    let lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Remove common eBay UI noise
    lines = lines.filter(l => {
      const lower = l.toLowerCase();
      return !lower.startsWith("view order") &&
             !lower.startsWith("print") &&
             !lower.startsWith("tracking") &&
             !lower.startsWith("mark as") &&
             !lower.startsWith("estimated") &&
             !lower.startsWith("deliver by") &&
             !lower.startsWith("order number") &&
             !lower.startsWith("order total") &&
             !lower.startsWith("item #") &&
             !lower.startsWith("quantity") &&
             !lower.startsWith("sold for") &&
             lower !== "phone" &&
             !lower.includes("feedback") &&
             !lower.includes("contact buyer") &&
             !lower.includes("add tracking") &&
             l !== "Copy" &&
             !isAddressUiNoiseLine(l);
    });

    if (lines.length === 0) return;

    function splitTrailingCityFromStreet(value) {
      const text = String(value || "").trim().replace(/,\s*$/, "");
      if (!text || !STREET_HINT_REGEX.test(text)) return null;

      const match = text.match(new RegExp(
        `^(.*?\\b(?:${STREET_SUFFIXES})\\b(?:\\s+(?:n|s|e|w|ne|nw|se|sw|apt|apartment|unit|ste|suite|#)\\b[\\w.-]*)*)\\s+([A-Za-z .'-]+)$`,
        "i"
      ));
      if (!match) return null;

      const street = match[1].trim().replace(/,\s*$/, "");
      const city = match[2].trim().replace(/^,\s*/, "");
      if (!street || !city) return null;
      return { street, city };
    }

    function previousLikelyCityLine(index) {
      for (let j = index - 1; j >= 1; j--) {
        const line = String(lines[j] || "").trim().replace(/,\s*$/, "");
        if (!line ||
            isTerritoryName(line) ||
            isUrbanizationLine(line) ||
            STREET_HINT_REGEX.test(line) ||
            /\b\d{5}(?:-\d{4})?\b/.test(line) ||
            /^[+\d][\d\s().-]{7,}$/.test(line) ||
            /^(united states|us|usa)$/i.test(line)) {
          continue;
        }
        return line;
      }
      return "";
    }

    // Find the city/state/zip line first — it anchors everything
    let cityLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(CITY_STATE_ZIP_LINE_REGEX);
      if (match) {
        info.city = match[1].replace(/,\s*$/, "").trim();
        info.state = match[2];
        info.zip = match[3];
        if (isTerritoryName(info.city)) {
          info.city = previousLikelyCityLine(i);
        }
        cityLineIdx = i;
        break;
      }
    }

    // Fallback: look for state + zip pattern anywhere in a line
    if (cityLineIdx === -1) {
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(STATE_ZIP_REGEX);
        if (match) {
          info.state = match[1];
          info.zip = match[2];
          // Everything before the state is the city
          const before = lines[i].substring(0, lines[i].indexOf(match[0])).replace(/,\s*$/, "").trim();
          const repaired = splitTrailingCityFromStreet(before);
          if (repaired) {
            info.city = repaired.city;
            if (!info.address) info.address = repaired.street;
          } else if (before) {
            info.city = before;
          }
          if (isTerritoryName(info.city)) {
            info.city = previousLikelyCityLine(i);
          }
          cityLineIdx = i;
          break;
        }
      }
    }

    // Territory fallback: eBay sometimes displays Puerto Rico/territory
    // addresses as "City ZIP" with no explicit state code.
    if (cityLineIdx === -1) {
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(.+?),?\s+(\d{5}(?:-\d{4})?)$/);
        if (!match) continue;

        const inferredState = inferStateFromZip(match[2]);
        if (!inferredState) continue;

        const before = match[1].replace(/,\s*$/, "").trim();
        const repaired = splitTrailingCityFromStreet(before);
        info.state = inferredState;
        info.zip = match[2];
        if (repaired) {
          info.city = repaired.city;
          if (!info.address) info.address = repaired.street;
        } else if (isTerritoryName(before)) {
          info.city = previousLikelyCityLine(i);
        } else {
          info.city = before;
        }
        cityLineIdx = i;
        break;
      }
    }

    if (cityLineIdx === -1) {
      const compact = lines.join(" ")
        .replace(/\s+/g, " ")
        .replace(/\bUnited States\b/ig, "")
        .replace(/\bPhone\b/ig, "")
        .trim();

      let inlineMatch = null;
      for (const match of compact.matchAll(CITY_STATE_ZIP_INLINE_REGEX)) {
        inlineMatch = match;
      }

      if (inlineMatch) {
        info.city = inlineMatch[1].trim();
        info.state = inlineMatch[2];
        info.zip = inlineMatch[3];

        const before = compact.slice(0, inlineMatch.index).trim();
        const addressStart = before.search(/\b(?:\d+[A-Za-z-]*|P\.?\s*O\.?\s*Box)\b/i);

        if (addressStart > 0) {
          info.name = before.slice(0, addressStart).trim();
          info.address = before.slice(addressStart).trim();
        } else if (!info.name && before) {
          info.name = before;
        }
      }
    }

    // If we found the city/state/zip line, work backwards
    if (cityLineIdx >= 0) {
      // Line 0 = name (usually)
      if (cityLineIdx >= 1) {
        info.name = lines[0];
      }

      const addressLines = lines.slice(1, cityLineIdx)
        .filter(line => !/^(united states|us|usa)$/i.test(line))
        .filter(line => !/^[+\d][\d\s().-]{7,}$/.test(line))
        .filter(line => normalizeText(line) !== normalizeText(info.city));

      if (addressLines.length >= 1) {
        info.address = addressLines[0];
      }
      if (addressLines.length >= 2) {
        info.address2 = addressLines.slice(1).join(" ");
      }

      const repairedCityLine = splitTrailingCityFromStreet(info.city);
      if (repairedCityLine) {
        info.city = repairedCityLine.city;

        const mergedAddressLines = addressLines.slice();
        if (mergedAddressLines.length === 0) {
          mergedAddressLines.push(repairedCityLine.street);
        } else if (/^\d+[A-Za-z-]*$/.test(mergedAddressLines[mergedAddressLines.length - 1])) {
          mergedAddressLines[mergedAddressLines.length - 1] =
            `${mergedAddressLines[mergedAddressLines.length - 1]} ${repairedCityLine.street}`.trim();
        } else if (!mergedAddressLines.includes(repairedCityLine.street)) {
          mergedAddressLines.push(repairedCityLine.street);
        }

        info.address = mergedAddressLines[0] || info.address;
        info.address2 = mergedAddressLines.slice(1).join(" ");
      }

      // Line after city/state/zip = country (skip it, we default US)
      const countryLine = lines[cityLineIdx + 1];
      if (countryLine) {
        const cl = countryLine.toLowerCase();
        if (cl.includes("united states") || cl === "us" || cl === "usa") {
          info.country = "US";
        }
      }
    } else {
      // Couldn't find city/state/zip — just grab what we can
      if (lines.length >= 1 && !info.name) info.name = lines[0];
      if (lines.length >= 2 && !info.address) info.address = lines[1];
    }

    // Clean up the name — remove any phone that got mixed in
    const phoneInName = info.name.match(/([+\d][\d\s().-]{7,})/);
    if (phoneInName) {
      info.phone = phoneInName[1].trim();
      info.name = info.name.replace(phoneInName[0], "").trim();
    }
  }

  // ── GET EBAY ORDER ID & ITEM INFO ────────────────────────────────────────

  function getOrderMeta() {
    const meta = { orderId: "", itemId: "", itemTitle: "", sku: "", asin: "", orderUrl: window.location.href, quantity: 1 };

    // Order ID from URL
    const urlMatch = window.location.href.match(/details[/]?[?&]?.*?orderId[=/](\d+-\d+)/i) ||
                     window.location.href.match(/\/(\d{2}-\d{5}-\d{5})/);
    if (urlMatch) meta.orderId = urlMatch[1];

    // Also try page content
    if (!meta.orderId) {
      const allText = document.body.innerText;
      const orderMatch = allText.match(/Order (?:number|#|ID)[:\s]*(\d{2}-\d{5}-\d{5})/i);
      if (orderMatch) meta.orderId = orderMatch[1];
    }

    const pageText = document.body.innerText || "";
    const quantityMatch =
      pageText.match(/\bQty(?:\.|uantity)?\s*[:x]?\s*(\d{1,3})\b/i) ||
      pageText.match(/\b(\d{1,3})\s+items?\b/i);
    if (quantityMatch) {
      const parsedQuantity = parseInt(quantityMatch[1], 10);
      if (Number.isFinite(parsedQuantity) && parsedQuantity > 0) {
        meta.quantity = parsedQuantity;
      }
    }

    // Item ID — the ORDERED item's eBay link. The page also contains /itm/ links
    // in recommendation / "items you're watching" / sponsored / notification
    // sections; grabbing the first one page-wide would look up the wrong item.
    // So: prefer links inside the order's line-item container, and skip any link
    // that sits within an excluded (watch/recommend/etc.) section.
    const EXCLUDE_SECTION = /recommend|watch|similar|sponsored|merch|notification|related|you-?might|also-?viewed|rtm|banner|promo|feed/i;
    const isInExcludedSection = (node) => {
      for (let el = node; el && el !== document.body; el = el.parentElement) {
        const cid = ((el.className && el.className.toString ? el.className.toString() : "") + " " + (el.id || "") + " " + (el.getAttribute?.("data-test-id") || "")).toLowerCase();
        if (EXCLUDE_SECTION.test(cid)) return true;
      }
      return false;
    };
    const pickItemLink = (root) => {
      for (const link of root.querySelectorAll('a[href*="/itm/"]')) {
        const m = link.href.match(/\/itm\/(\d+)/);
        if (!m) continue;
        if (isInExcludedSection(link)) continue;
        return { itemId: m[1], title: (link.textContent || "").trim() };
      }
      return null;
    };
    const orderScopes = document.querySelectorAll(
      '[class*="lineItem" i], [class*="line-item" i], [class*="order-item" i], ' +
      '[class*="orderDetails" i], [class*="order-details" i], [class*="fulfillment" i], ' +
      '[data-test-id*="lineItem" i], [data-test-id*="order-item" i]'
    );
    let picked = null;
    for (const scope of orderScopes) { picked = pickItemLink(scope); if (picked) break; }
    if (!picked) picked = pickItemLink(document); // fallback: page-wide, still excluding rec/watch areas
    if (picked) {
      meta.itemId = picked.itemId;
      meta.itemTitle = picked.title;
    }

    const skuMeta = extractSkuOrAsin();
    meta.sku = skuMeta.sku;
    meta.decodedSku = skuMeta.decodedSku;
    meta.asin = skuMeta.asin;
    meta.amazonUrl = skuMeta.amazonUrl;

    return meta;
  }

  // ── INJECT UI ────────────────────────────────────────────────────────────

  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  async function waitForElement(selectors, timeoutMs = 12000) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (isVisible(el)) return el;
      }
      await wait(250);
    }
    return null;
  }

  function findClickableByText(texts) {
    const wanted = texts.map(t => t.toLowerCase());
    const nodes = document.querySelectorAll("button, a, [role='button'], span, div");
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || "").trim().toLowerCase();
      if (!text) continue;
      if (wanted.some(t => text === t || text.includes(t))) return node;
    }
    return null;
  }

  async function sendBuyerMessage(messageText) {
    // ── Step 1: Find and click "Message buyer" ────────────────────────────
    // eBay pre-renders the textarea in the DOM even before the composer is
    // opened, so we cannot rely on visibility checks — we just need the
    // panel to animate open before we interact with it.
    let messageBuyerBtn = Array.from(
      document.querySelectorAll('button[data-ebayui]')
    ).find(btn => /message\s+buyer/i.test(btn.textContent));

    if (!messageBuyerBtn) {
      messageBuyerBtn = Array.from(document.querySelectorAll("button, a"))
        .find(el => /message\s+buyer/i.test(el.textContent));
    }

    if (!messageBuyerBtn) {
      return { success: false, reason: "Could not find the 'Message buyer' button on the eBay order page." };
    }

    messageBuyerBtn.click();

    // Wait for the composer panel to open/animate
    await wait(1500);

    // ── Step 2: Locate the textarea by its known ID ───────────────────────
    // Do NOT use isVisible() — eBay keeps this textarea in the DOM at all
    // times; it only becomes interactable after the panel opens.
    let textarea = document.querySelector("#imageupload__sendmessage--textbox") ||
                   document.querySelector('textarea[data-testid="message-input-textarea"]') ||
                   document.querySelector('textarea[aria-label="Send message"]');

    // Retry a few times if the panel is still animating
    for (let i = 0; i < 10 && !textarea; i++) {
      await wait(400);
      textarea = document.querySelector("#imageupload__sendmessage--textbox") ||
                 document.querySelector('textarea[data-testid="message-input-textarea"]') ||
                 document.querySelector('textarea[aria-label="Send message"]');
    }

    if (!textarea) {
      return { success: false, reason: "Message composer textarea was not found in the DOM." };
    }

    // ── Step 3: Fill the message ──────────────────────────────────────────
    // Focus first, then set value through the native prototype setter so
    // eBay's own input listeners pick up the change (same as a real keystroke).
    textarea.focus();
    textarea.click();
    await wait(200);

    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(textarea, messageText);
    } else {
      textarea.value = messageText;
    }

    // Fire all the events eBay's component library listens for
    textarea.dispatchEvent(new Event("focus",  { bubbles: true }));
    textarea.dispatchEvent(new Event("input",  { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));

    // ── Step 4: Wait for the send button to become enabled ────────────────
    // The send button starts with disabled="" and eBay removes that attribute
    // once it detects content in the textarea.
    let sendBtn = null;
    const enabledStart = Date.now();
    while (Date.now() - enabledStart < 6000) {
      sendBtn = document.querySelector("#imageupload__send--button") ||
                document.querySelector('button[data-testid="message-send-button"]');
      if (sendBtn && !sendBtn.disabled) break;
      await wait(300);
    }

    if (!sendBtn) {
      return { success: false, reason: "Send button was not found after filling the message." };
    }

    // If still disabled, force-remove the attribute as a last resort
    // (the message is in the box; eBay's listener sometimes just misses the event)
    if (sendBtn.disabled) {
      sendBtn.removeAttribute("disabled");
      await wait(200);
    }

    sendBtn.click();
    await wait(2000);
    const closeBtn =
      document.querySelector("button.icon-btn.panel-dialog__close") ||
      document.querySelector("button.panel-dialog__close") ||
      document.querySelector(".panel-dialog__close") ||
      document.querySelector('button[aria-label*="Close"]') ||
      document.querySelector('button[title*="Close"]');
    if (closeBtn) {
      closeBtn.click();
      await wait(800);
    }
    return { success: true };
  }

  // ── MARK AS SHIPPED via eBay UI ────────────────────────────────────────────

  async function markOrderAsShipped() {
    // ── Step 1: Find and click "More actions" ─────────────────────────────
    // The button has aria-haspopup="true" and text "More actions".
    let moreActionsBtn = Array.from(
      document.querySelectorAll('button[aria-haspopup="true"]')
    ).find(btn => /more\s+actions/i.test(btn.textContent));

    if (!moreActionsBtn) {
      moreActionsBtn = Array.from(document.querySelectorAll("button"))
        .find(btn => /more\s+actions/i.test(btn.textContent));
    }

    if (!moreActionsBtn) {
      return { success: false, reason: "Could not find the 'More actions' button on the eBay order page." };
    }

    moreActionsBtn.click();

    // Wait for the dropdown to render — eBay toggles a hidden menu into view,
    // it doesn't inject new DOM nodes, so we just need a fixed delay.
    await wait(800);

    // ── Step 2: Find "Mark as shipped" anywhere in the DOM ────────────────
    // Search the entire document — don't restrict to the menu element whose
    // visibility check can incorrectly fail.
    let markShippedItem = null;
    const searchStart = Date.now();
    while (!markShippedItem && Date.now() - searchStart < 5000) {
      markShippedItem = Array.from(
        document.querySelectorAll("button, a, [role='menuitem'], li span, li a, li button")
      ).find(el => {
        const text = el.textContent.trim();
        return /mark\s+as\s+shipped/i.test(text) && text.length < 40;
      });
      if (!markShippedItem) await wait(300);
    }

    if (!markShippedItem) {
      return { success: false, reason: "Opened 'More actions' but could not find 'Mark as shipped'." };
    }

    markShippedItem.click();
    await wait(1500);

    // ── Step 3: Dismiss any confirmation dialog ───────────────────────────
    const confirmBtn = Array.from(
      document.querySelectorAll("button, [role='button']")
    ).find(el => {
      const text = el.textContent.trim();
      return /^(confirm|yes|ok|done|mark\s+as\s+shipped)$/i.test(text) && !el.disabled;
    });

    if (confirmBtn) {
      confirmBtn.click();
      await wait(1000);
    }

    return { success: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "send_buyer_message") {
      sendBuyerMessage(message.messageText || "")
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, reason: error.message }));
      return true;
    }

    if (message.action === "mark_as_shipped") {
      markOrderAsShipped()
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, reason: error.message }));
      return true;
    }
  });

  function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  }

  function storageGetLocal(defaults) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(defaults, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });
  }

  function storageSetLocal(values) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function injectFulfillButton() {
    const btn = document.createElement("button");
    btn.id = "clawdbot-fulfill-btn";
    btn.textContent = "🚀 ClawdBot: Auto-Fulfill on Amazon";
    btn.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 99999;
      padding: 12px 20px; font-size: 14px; font-weight: bold;
      background: linear-gradient(135deg, #ff6b00, #ff8c33);
      color: white; border: none; border-radius: 8px;
      cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    `;

    const statusDiv = document.createElement("div");
    statusDiv.id = "clawdbot-fulfill-status";
    statusDiv.style.cssText = `
      position: fixed; top: 55px; right: 10px; z-index: 99999;
      padding: 8px 16px; font-size: 12px; background: #222; color: #0f0;
      border-radius: 6px; display: none; max-width: 350px;
      font-family: monospace; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;

    document.body.appendChild(btn);
    document.body.appendChild(statusDiv);

    btn.addEventListener("click", async () => {
      const status = statusDiv;
      status.style.display = "block";
      status.textContent = "⏳ Parsing shipping info from this page...";

      try {
      const shipping = parseShippingInfo();
      const orderMeta = getOrderMeta();

      // Validate we have minimum required fields
      const missing = [];
      if (!shipping.name)    missing.push("Name");
      if (!shipping.address && !(isPuertoRicoShippingInfo(shipping) && shipping.urbanization)) missing.push("Street Address");
      if (!shipping.city)    missing.push("City");
      if (!shipping.state)   missing.push("State");
      if (!shipping.zip)     missing.push("ZIP Code");

      if (missing.length > 0) {
        status.style.color = "#ff4444";
        status.innerHTML = `❌ Could not parse: ${missing.join(", ")}<br><br>` +
          `<small>Parsed so far:<br>` +
          `Name: "${shipping.name}"<br>` +
          `Address: "${shipping.address}"<br>` +
          `City: "${shipping.city}" State: "${shipping.state}" ZIP: "${shipping.zip}"<br><br>` +
          `Try selecting the address text on the page, then click this button again.</small>`;
        return;
      }

      status.style.color = "#0f0";
      status.innerHTML =
        `✅ Parsed shipping info:<br>` +
        `👤 ${shipping.name}<br>` +
        `${shipping.urbanization ? `🏘️ ${shipping.urbanization}<br>` : ""}` +
        `📍 ${shipping.address}${shipping.address2 ? ", " + shipping.address2 : ""}<br>` +
        `📍 ${shipping.city}, ${shipping.state} ${shipping.zip}<br>` +
        `📞 ${shipping.phone || "N/A"}<br>` +
        `🔢 Quantity: ${orderMeta.quantity || 1}<br>` +
        `📦 Order: ${orderMeta.orderId || "N/A"}<br><br>` +
        `⏳ Looking up Amazon product URL...`;

      // Find the matching product in our queue by eBay item ID
      const data = await withTimeout(storageGetLocal({ queue: [] }), 8000, "Queue lookup");
      const queue = Array.isArray(data.queue) ? data.queue : [];
      status.innerHTML += `<br><small>Queue items loaded: ${queue.length}</small>`;
      const matchedProduct = findQueueMatch(queue, orderMeta);
      const directSkuAsin =
        (looksLikeAsin(orderMeta.decodedSku) ? orderMeta.decodedSku.toUpperCase() : "") ||
        (looksLikeAsin(orderMeta.sku) ? orderMeta.sku.toUpperCase() : "");
      let amazonUrl = orderMeta.amazonUrl || matchedProduct?.url || "";

      const fallbackAsin =
        orderMeta.asin ||
        directSkuAsin ||
        matchedProduct?.asin ||
        matchedProduct?.id ||
        "";
      const fallbackSearchTerm =
        orderMeta.asin ||
        directSkuAsin ||
        orderMeta.decodedSku ||
        orderMeta.sku ||
        matchedProduct?.asin ||
        matchedProduct?.title ||
        orderMeta.itemTitle ||
        "";
      const safeFallbackSearchTerm = isUsefulSearchTerm(fallbackSearchTerm) ? fallbackSearchTerm : "";

      if (!matchedProduct) {
        status.style.color = "#ffaa00";
        status.innerHTML += `<br><br><small>No direct queue match was found. Falling back to Amazon ASIN/SKU/title lookup.</small>`;
      }

      // Fallback: try to match by title similarity
      if (!amazonUrl && orderMeta.itemTitle) {
        const titleLower = orderMeta.itemTitle.toLowerCase();
        const match = queue.find(p =>
          p.title && titleLower.includes(p.title.toLowerCase().slice(0, 20))
        );
        if (match) amazonUrl = match.url;
      }

      if (!amazonUrl && !safeFallbackSearchTerm) {
        status.style.color = "#ffaa00";
        status.innerHTML += `<br><br>⚠️ No matching Amazon product found in queue.<br>` +
          `<small>Make sure the product is in your ClawdBot queue with an Amazon URL.</small>`;
        return;
      }

      // Store fulfillment data for the automated checkout flow
      const fulfillmentJob = {
        buyer: shipping,
        ebayOrderId: orderMeta.orderId,
        ebayItemId: orderMeta.itemId,
        ebayOrderUrl: orderMeta.orderUrl,
        ebaySku: orderMeta.sku,
        decodedEbaySku: orderMeta.decodedSku,
        amazonUrl: amazonUrl,
        amazonAsin: fallbackAsin,
        amazonSearchTerm: safeFallbackSearchTerm,
        itemTitle: matchedProduct?.title || orderMeta.itemTitle || "",
        quantity: orderMeta.quantity || 1,
        step: "add_to_cart",   // State machine starts here
        startedAt: Date.now(),
        attempts: 0,
      };

      status.innerHTML += `<br><br>⏳ Sending fulfillment job to background queue...`;

      // Tell background to start the automated checkout
      const launchResult = await withTimeout(runtimeSendMessage({
        action: "start_auto_fulfill",
        fulfillment: fulfillmentJob,
      }), 8000, "Background launch");

      if (launchResult?.queued) {
        const active = launchResult.active || {};
        const activeLabel = active.ebayOrderId ? ` eBay order ${active.ebayOrderId}` : " the active Amazon order";
        const activeStep = active.step ? ` Current step: ${active.step}.` : "";
        status.innerHTML += `<br><br>📋 Fulfillment queued behind${activeLabel}.<br>` +
          `<small>Queue length: ${launchResult.queueLength}.${activeStep} It will start automatically when the current order finishes.</small>`;
      } else if (launchResult?.alreadyActive) {
        status.innerHTML += `<br><br>ℹ️ This fulfillment is already active in Amazon.`;
      } else {
        status.innerHTML += `<br><br>🛒 Opening Amazon product page...<br>` +
          `<small>Review Amazon normally. PhiloShip will pause and notify you before Place Order.</small>`;
      }
      } catch (error) {
        console.error("ClawdBot: Auto-fulfill button failed:", error);
        status.style.color = "#ff4444";
        status.innerHTML += `<br><br>âŒ ${error.message || String(error)}<br>` +
          `<small>The queue lookup or launch step failed before Amazon opened.</small>`;
      }
    });
  }

  // Wait for page to fully load, then inject
  if (document.readyState === "complete") {
    injectFulfillButton();
  } else {
    window.addEventListener("load", injectFulfillButton);
  }
})();

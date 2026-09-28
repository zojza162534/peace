/**
 * content_amazon_bulk.js
 *
 * Bulk-snipe every organic product visible on an Amazon search results page
 * or category page into the queue — replicating EcomSniper's "Grab All" feature.
 *
 * Works on:
 *   https://www.amazon.com/s?k=...          (keyword search)
 *   https://www.amazon.com/b?node=...        (category browse)
 *   https://www.amazon.com/s?i=...&rh=...    (filtered search)
 *
 * Skips: sponsored/ad results, items with no parseable price.
 */
(function () {
  function buildPreferredProductUrl(rawUrl, asin) {
    try {
      if (!rawUrl) {
        return asin ? `https://www.amazon.com/dp/${asin}` : "";
      }

      const current = new URL(rawUrl);
      const isProductPath = /\/(?:dp|gp\/product|gp\/aw\/d)\//i.test(current.pathname);
      if (!isProductPath || !asin) {
        return current.toString();
      }

      const preferred = new URL(`https://www.amazon.com/dp/${asin}`);
      const th = current.searchParams.get("th");
      const psc = current.searchParams.get("psc");
      if (th) preferred.searchParams.set("th", th);
      if (psc) preferred.searchParams.set("psc", psc);
      return preferred.toString();
    } catch {
      return rawUrl || (asin ? `https://www.amazon.com/dp/${asin}` : "");
    }
  }

  // ── 1. Validate we're on a listing page ─────────────────────────────────────
  const url = window.location.href;
  const isListingPage =
    url.includes("/s?") ||
    url.includes("/s/") ||
    url.includes("/b?node") ||
    url.includes("/b/ref");

  if (!isListingPage) {
    alert("❌ Bulk Snipe only works on Amazon search or category pages.\n\nNavigate to a search results or category listing first.");
    return;
  }

  // ── 2. Grab all search result cards ─────────────────────────────────────────
  // Amazon uses data-component-type="s-search-result" on every card (organic + sponsored)
  const allCards = Array.from(
    document.querySelectorAll('[data-component-type="s-search-result"]')
  );

  if (!allCards.length) {
    alert("❌ No product cards found on this page. Make sure the page has fully loaded.");
    return;
  }

  // ── 3. Parse each card ───────────────────────────────────────────────────────
  const scraped = [];
  const skipped = { sponsored: 0, noPrice: 0, noTitle: 0 };

  allCards.forEach(card => {
    // Skip sponsored / ad results
    const isSponsored =
      !!card.querySelector(".puis-sponsored-label-text") ||
      card.innerText.includes("Sponsored");
    if (isSponsored) { skipped.sponsored++; return; }

    // ── Title ──────────────────────────────────────────────────────────────────
    const titleEl =
      card.querySelector('[data-cy="title-recipe"] h2 span') ||
      card.querySelector("h2 span.a-text-normal") ||
      card.querySelector("h2 span");
    const title = titleEl?.textContent.trim();
    if (!title) { skipped.noTitle++; return; }

    // ── ASIN ───────────────────────────────────────────────────────────────────
    // Amazon puts the ASIN in data-asin on the card root element
    const asin = card.getAttribute("data-asin") || String(Date.now() + Math.random());

    // ── Price ──────────────────────────────────────────────────────────────────
    // The main price sits in a .a-price .a-offscreen. Amazon also shows a per-unit
    // price (e.g. "$5.21/Count") as a data-a-size="mini" .a-price — skip those, or
    // we list the per-unit price by mistake (5.21 instead of 52.10).
    const parseAmt = (text) => {
      const s = String(text || "").replace(/,/g, "");
      let m = s.match(/(\d+\.\d{2})(?!\d)/); if (m) return parseFloat(m[1]);
      m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : NaN;
    };
    let price = NaN;
    const priceEls = card.querySelectorAll('.a-price:not([data-a-size="mini"]) .a-offscreen');
    for (const el of priceEls) {
      const v = parseAmt(el.textContent);
      if (!isNaN(v) && v > 0) { price = v; break; }
    }
    // Fallback: whole + fraction from a non-per-unit price
    if (isNaN(price)) {
      const priceBlock = card.querySelector('.a-price:not([data-a-size="mini"])') || card;
      const whole    = priceBlock.querySelector(".a-price-whole")?.textContent.replace(/[^\d]/g, "");
      const fraction = ((priceBlock.querySelector(".a-price-fraction")?.textContent || "00").replace(/[^\d]/g, "") + "00").slice(0, 2);
      if (whole) price = parseFloat(`${whole}.${fraction}`);
    }
    if (isNaN(price) || price <= 0) { skipped.noPrice++; return; }

    // ── Rating ─────────────────────────────────────────────────────────────────
    const ratingEl = card.querySelector(".a-icon-alt");
    const rating   = ratingEl?.textContent.split(" ")[0] || "";

    // ── Review count ───────────────────────────────────────────────────────────
    const reviewEl = card.querySelector('[aria-label*="stars"] + span, .a-size-base.s-underline-text');
    const reviews  = reviewEl?.textContent.trim() || "";

    // ── Thumbnail image ────────────────────────────────────────────────────────
    // Cards only carry one image; full image gallery requires visiting the PDP
    const imgEl  = card.querySelector("img.s-image");
    const images = imgEl ? [imgEl.src] : [];

    // ── Product URL ────────────────────────────────────────────────────────────
    const linkEl = card.querySelector('[data-cy="title-recipe"] a.a-link-normal, h2 a.a-link-normal');
    const relUrl = linkEl?.getAttribute("href") || "";
    const productUrl = relUrl
      ? (relUrl.startsWith("http") ? relUrl : `https://www.amazon.com${relUrl}`)
      : "";

    // ── Prime badge ────────────────────────────────────────────────────────────
    const isPrime = !!card.querySelector(".a-icon-prime");

    // ── Sales volume badge (e.g. "2K+ bought in past month") ──────────────────
    const salesEl    = card.querySelector('[aria-label*="bought"], .a-row .a-size-base.a-color-secondary');
    const salesVolume = salesEl?.textContent.trim() || "";

    // ── Assemble product object (mirrors content_amazon.js shape) ─────────────
    scraped.push({
      id:           asin,
      asin,
      title,
      price,
      description:  "",        // Not available on listing cards; requires PDP visit
      images,
      url:          buildPreferredProductUrl(productUrl, asin),
      rating,
      reviews,
      salesVolume,
      isPrime,
      hasVariations: false,    // Can't detect from card alone
      status:       "active",
      lastSync:     Date.now(),
      source:       "bulk"     // Flag so the popup can show a "bulk" badge
    });
  });

  if (!scraped.length) {
    alert(
      `⚠️ No products could be scraped.\n\n` +
      `Skipped: ${skipped.sponsored} sponsored, ${skipped.noPrice} no-price, ${skipped.noTitle} no-title.\n\n` +
      `Try scrolling to fully load the page, then try again.`
    );
    return;
  }

  // ── 4. Hand off to background for enrichment + save ─────────────────────────
  // Search cards are thin (no description/specifics, thumbnail only). Send the
  // captured items to the background worker, which visits each product page,
  // scrapes the full data, and saves the enriched items to the queue.
  chrome.storage.local.get({ queue: [] }, data => {
    const existingIds = new Set(data.queue.map(p => p.id));
    const newItems    = scraped.filter(p => !existingIds.has(p.id));

    if (!newItems.length) {
      alert(`✅ Bulk Snipe: all ${scraped.length} products are already in your queue.`);
      return;
    }

    // Save the thin items first so nothing is lost if enrichment is interrupted,
    // then trigger background enrichment which will overwrite them with full data.
    chrome.storage.local.set({ queue: [...newItems, ...data.queue] }, () => {
      chrome.runtime.sendMessage({ action: "bulk_enrich_and_save", items: newItems }, () => {});
      alert(
        `✅ Bulk Snipe captured ${newItems.length} new products.\n\n` +
        `Now loading full product details (description, images, specifics) in the ` +
        `background — the queue will fill in as each finishes.\n\n` +
        `Skipped: ${skipped.sponsored} sponsored | ${skipped.noPrice} no-price | ${skipped.noTitle} no-title`
      );
    });
  });
})();

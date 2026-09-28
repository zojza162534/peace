/**
 * background.js — PhiloShip Service Worker v3.0
 *
 * Handles:
 *  1. 60-min inventory sync alarm
 *  2. 15-min eBay order polling alarm
 *  3. CSV download messages
 *  4. OAuth redirect intercept
 *  5. Automated fulfillment orchestration (multi-step)
 *  6. eBay CompleteSale (mark as shipped) after Amazon order placed
 */


// ── SaaS config — all eBay calls go through the Worker with the user's JWT ───
// ── url-to-b64: fetch Amazon image and convert to base64 ─────────────────────
// EcomSniper's pattern — service worker fetches cross-origin, content scripts can't.
async function fetchURLtoBase64(url) {
  if (!url) throw new Error("Missing image URL");
  // Hard timeout: without this, a stalled image URL leaves the fetch pending
  // forever, sendResponse is never called, and the content script's await
  // hangs the entire listing flow (appears "stuck" right after shipping).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.amazon.com/',
      },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(
      e?.name === 'AbortError'
        ? 'Image download timed out after 20s'
        : `Image download failed: ${e?.message || e}`
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const blob   = await res.blob();
  if (!blob.size) throw new Error("Image download returned an empty file");
  const buffer = await blob.arrayBuffer();
  const bytes  = new Uint8Array(buffer);
  let binary   = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  const b64    = btoa(binary);
  const mime   = blob.type || 'image/jpeg';
  return `data:${mime};base64,${b64}`;
}

const WORKER_URL = "https://super-cake-aaff.ecreese.workers.dev"; // matches auth.js
const fulfillmentInjectionState = new Map();

// Keep legacy storage key in sync so v3.9 background checks don't warn
chrome.storage.local.set({ clawdbot_worker_url: WORKER_URL });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ clawdbot_worker_url: WORKER_URL });
});

// ── eBay listing: webRequest intercept ───────────────────────────────────────
// Mirrors EcomSniper exactly: intercept /lstng/api/listing_draft/ requests,
// capture session headers, and forward networkResponse to the lstng tab.

const LSTNG_DRAFT_PATTERN = /^https:\/\/www\.ebay\.[^/]+\/lstng\/api\/listing_draft\/\d+/;

// Capture request headers and forward to the lstng content script
chrome.webRequest.onBeforeSendHeaders.addListener(
  details => {
    if (!LSTNG_DRAFT_PATTERN.test(details.url)) return;
    chrome.tabs.sendMessage(details.tabId, {
      type:           "requestVariables",
      requestHeaders: details.requestHeaders,
    }).catch(() => {});
  },
  { urls: ["https://www.ebay.com/lstng/api/*", "https://www.ebay.co.uk/lstng/api/*",
            "https://www.ebay.ca/lstng/api/*", "https://www.ebay.com.au/lstng/api/*"] },
  ["requestHeaders", "extraHeaders"]
);

// Notify content script when eBay's draft API responds (signals auto-save complete)
chrome.webRequest.onCompleted.addListener(
  details => {
    if (!LSTNG_DRAFT_PATTERN.test(details.url)) return;
    if (details.statusCode >= 200 && details.statusCode < 300) {
      chrome.tabs.sendMessage(details.tabId, {
        type:    "networkResponse",
        details: { url: details.url, statusCode: details.statusCode },
      }).catch(() => {});
    }
  },
  { urls: ["https://www.ebay.com/lstng/api/*", "https://www.ebay.co.uk/lstng/api/*",
            "https://www.ebay.ca/lstng/api/*", "https://www.ebay.com.au/lstng/api/*"] }
);
// Lives in the background worker (survives popup closing) and captures the
// Google/eBay OAuth redirect, extracts tokens from the URL fragment, saves
// them to storage, then notifies the popup to transition to the main app.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const url = changeInfo.url || "";
  if (!url.includes(`${WORKER_URL}/auth/success`)) return;

  try {
    const fragment = url.includes("#") ? url.split("#")[1] : "";
    const params   = new URLSearchParams(fragment);
    const accessToken  = params.get("accessToken");
    const refreshToken = params.get("refreshToken");
    const userId       = params.get("userId");

    if (!accessToken) return;

    // Save tokens — popup's storage.onChanged listener will pick this up
    chrome.storage.local.set({ accessToken, refreshToken, userId }, () => {
      console.log("PhiloShip: Google OAuth tokens saved for user", userId);
      // Close the success tab after a short delay
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
    });
  } catch (e) {
    console.error("PhiloShip: OAuth redirect parse failed", e);
  }
});

async function getAccessToken() {
  const { accessToken, refreshToken } = await chrome.storage.local.get(["accessToken", "refreshToken"]);
  if (!accessToken && !refreshToken) return null;

  // Try a lightweight /auth/me to see if the token is still valid
  // If 401, attempt refresh
  try {
    const res = await fetch(`${WORKER_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) return accessToken;

    if (refreshToken) {
      const rRes  = await fetch(`${WORKER_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (rRes.ok) {
        const { accessToken: newToken } = await rRes.json();
        await chrome.storage.local.set({ accessToken: newToken });
        return newToken;
      }
    }
  } catch (_) {}
  return null;
}

async function workerFetch(path, options = {}) {
  const token = await getAccessToken();
  return fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

// ── 1. Alarm setup ────────────────────────────────────────────────────────────
function ensurePhiloAlarms() {
  chrome.alarms.create("inventorySync",   { periodInMinutes: 60 });
  chrome.alarms.create("orderPoll",       { periodInMinutes: 15 });
  // Keep the eBay session alive: refresh the access token well before its ~2h
  // expiry. This runs as long as a refresh token is saved (i.e. signed in), so
  // the connection persists until the user manually signs out.
  chrome.alarms.create("ebayTokenRefresh", { periodInMinutes: 90, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => {
  ensurePhiloAlarms();
  proactiveEbayTokenRefresh("installed");
  console.log("PhiloShip v3.0: Alarms created.");
});
// Alarms persist across restarts, but re-ensure on startup for existing installs
// (which won't re-fire onInstalled) and kick a refresh so the token is fresh.
chrome.runtime.onStartup.addListener(() => {
  ensurePhiloAlarms();
  proactiveEbayTokenRefresh("startup");
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "inventorySync")    await runInventorySync();
  if (alarm.name === "orderPoll")        await runOrderPoll();
  if (alarm.name === "ebayTokenRefresh") await proactiveEbayTokenRefresh("alarm");
});

// Refresh the eBay access token in the background while signed in. Unlike the
// on-demand path, this NEVER clears the session on failure: a transient error
// (worker down, offline) just retries on the next alarm, and eBay refresh tokens
// last ~18 months, so the user stays connected until they manually sign out.
async function proactiveEbayTokenRefresh(reason = "alarm") {
  try {
    const s = await chrome.storage.local.get({
      clawdbot_worker_url: "",
      ebay_access_token: "",
      ebay_token_expires_at: 0,
      ebay_refresh_token: "",
      ebay_client_id: "",
      ebay_client_secret: "",
    });
    // Not signed in → nothing to keep alive.
    if (!s.ebay_refresh_token || !s.clawdbot_worker_url) return;
    // Refresh if the token is missing or within 20 min of expiry.
    const fresh = s.ebay_access_token && Date.now() < (s.ebay_token_expires_at || 0) - 20 * 60_000;
    if (fresh) return;

    const resp = await fetch(`${s.clawdbot_worker_url}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: s.ebay_client_id,
        client_secret: s.ebay_client_secret,
        refresh_token: s.ebay_refresh_token,
        use_env_creds: true,
      }),
    });
    const result = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));

    if (resp.ok && result.access_token) {
      await chrome.storage.local.set({
        ebay_access_token: result.access_token,
        ebay_token_expires_at: Date.now() + (result.expires_in || 7200) * 1000,
        ebay_reconnect_needed: false,
        ...(result.refresh_token ? { ebay_refresh_token: result.refresh_token } : {}),
      });
      console.log(`PhiloShip: eBay token refreshed (${reason}).`);
      return;
    }

    // Only a definitive invalid/expired refresh token means the user must
    // reconnect. Flag it for the UI but do NOT wipe tokens automatically —
    // sign-out is the user's action, not ours.
    const body = JSON.stringify(result).toLowerCase();
    if (/invalid_grant|token_expired|invalid_scope|revoked/.test(body)) {
      await chrome.storage.local.set({ ebay_reconnect_needed: true });
      console.warn("PhiloShip: eBay refresh token no longer valid — reconnect needed.");
    } else {
      console.warn(`PhiloShip: eBay token refresh transient failure (${reason}); will retry.`, result);
    }
  } catch (e) {
    // Transient (offline, worker unreachable) — keep the session, retry next alarm.
    console.warn("PhiloShip: eBay token refresh error (transient, will retry):", e.message);
  }
}

// ── 2. Message handler ────────────────────────────────────────────────────────
// ── Keep service worker alive via offscreen document ─────────────────────────
// Chrome MV3 service workers die after ~30s idle. An offscreen document
// sends a keepAlive ping every 20s to reset the timer.
async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS'],
      justification: 'Keep service worker alive for bulk listing'
    });
  } catch(e) { /* ignore if already exists */ }
}
chrome.runtime.onInstalled.addListener(ensureOffscreen);
chrome.runtime.onStartup.addListener(ensureOffscreen);
ensureOffscreen();

// Also call a trivial API every 20s as a second keep-alive mechanism
// (same technique used by Tab Reloader and other persistent extensions)
setInterval(() => {
  chrome.runtime.getPlatformInfo(() => {});
}, 20000);

let bulkListingActive = false;
let bulkListingStopRequested = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeQuantity(...values) {
  for (const value of values) {
    const quantity = parseInt(value, 10);
    if (Number.isFinite(quantity) && quantity > 0) return quantity;
  }
  return 1;
}

function sanitizeForEbay(text) {
  if (!text) return "";
  return String(text)
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/(www\.)?amazon\.[a-z.]+\/[^\s<"]*/gi, "")
    .replace(/\b(amazon|amazon\.com|amazons?|prime|fulfilled by amazon|fba|amzn|walmart|target|alibaba|aliexpress|wish\.com|etsy|free shipping|free returns?|warranty|guaranteed|best seller|bestseller|sponsored|advertisement)\b/gi, "")
    .replace(/\bB0[A-Z0-9]{8}\b/g, "")
    .replace(/[™®©]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,\-–—]+/, "")
    .trim();
}

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Build a clean, professional eBay description from the scraped product data.
// Pulls the Amazon feature bullets into a proper list and surfaces the key
// item specifics, then adds condition + shipping/returns. All values are
// sanitized (brand/marketplace words stripped) and HTML-escaped.
function buildListingDescription(product) {
  const cleanTitle = sanitizeForEbay(product.custom_title || product.title || "") || "Quality Item";

  // Feature bullets — scraped as "a | b | c". Split, clean, dedupe, cap length.
  const seen = new Set();
  const features = String(product.description || "")
    .split(/\s*\|\s*|\s*•\s*|\n+/)
    .map(s => sanitizeForEbay(s))
    .map(s => s.replace(/^[\s,\-–—•]+/, "").trim())
    .filter(s => s.length >= 12 && s.length <= 220)
    .filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 8);

  // Item specifics from the category scrape (color/material/size/etc.).
  const scraped = (product.categoryData && product.categoryData.scraped) || {};
  const specPairs = [
    ["Brand", sanitizeForEbay(product.brand)],
    ["Type", sanitizeForEbay(product.productType)],
    ["Color", sanitizeForEbay(product.color || scraped.color)],
    ["Material", sanitizeForEbay(scraped.material)],
    ["Style", sanitizeForEbay(scraped.style)],
    ["Size", sanitizeForEbay(scraped.size)],
    ["Department", sanitizeForEbay(scraped.gender || scraped.department)],
  ].filter(([, v]) => v && v.trim());

  const featureList = features.length
    ? `<h3 style="color:#333;font-size:17px;margin:18px 0 8px;">Key Features</h3>
  <ul style="margin:0;padding-left:20px;">
    ${features.map(f => `<li style="margin:4px 0;">${escapeHtml(f)}</li>`).join("\n    ")}
  </ul>`
    : "";

  const specsTable = specPairs.length
    ? `<h3 style="color:#333;font-size:17px;margin:18px 0 8px;">Product Details</h3>
  <table style="border-collapse:collapse;width:100%;max-width:420px;">
    ${specPairs.map(([k, v]) => `<tr>
      <td style="padding:6px 10px;border:1px solid #e5e5e5;background:#f7f7f7;font-weight:bold;width:38%;">${escapeHtml(k)}</td>
      <td style="padding:6px 10px;border:1px solid #e5e5e5;">${escapeHtml(v)}</td>
    </tr>`).join("\n    ")}
  </table>`
    : "";

  const intro = specPairs.find(([k]) => k === "Brand")
    ? `Discover the ${escapeHtml(cleanTitle)} — quality you can count on.`
    : `${escapeHtml(cleanTitle)} — quality you can count on.`;

  return `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 800px; margin: 0 auto; color:#333; line-height:1.6; font-size:15px;">
  <h2 style="color:#111;font-size:22px;margin:0 0 10px;">${escapeHtml(cleanTitle)}</h2>
  <p style="margin:0 0 8px;">${intro}</p>
  ${featureList}
  ${specsTable}
  <h3 style="color:#333;font-size:17px;margin:18px 0 8px;">Condition</h3>
  <p style="margin:0 0 8px;">Brand new and unused, exactly as described.</p>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:18px 0;">
  <p style="color:#555;font-size:13px;margin:0;">
    <strong>Shipping:</strong> Ships from the US within 3 business days.<br>
    <strong>Returns:</strong> 30-day hassle-free returns.<br>
    <strong>Questions?</strong> Message us anytime — we're happy to help.
  </p>
</div>`.trim();
}

function normalizeListingImageUrls(imageUrls = []) {
  return Array.from(new Set(
    imageUrls
      .map(url => {
        let clean = String(url || "").split("?")[0].replace(/^http:\/\//i, "https://").trim();
        if (!clean) return "";
        // Amazon media images carry a size/quality transform after the image ID
        // (e.g. ._AC_UL320_.jpg, or the A/B-test ._AC_AIweblab...,T3_SF480.0,480.0_PQ65_.jpg).
        // The old regex couldn't strip the newer commas/periods/lowercase variants,
        // leaving a tiny/broken URL that uploaded as a blank photo. Instead, pull
        // the image ID and rebuild a clean, full-size (1500px) URL.
        const m = clean.match(/(\/images\/I\/)([^./]+)\./);
        if (m && /media-amazon\.com|ssl-images-amazon\.com|images-amazon\.com/i.test(clean)) {
          const origin = clean.slice(0, clean.indexOf('/images/I/'));
          return `${origin}/images/I/${m[2]}._AC_SL1500_.jpg`;
        }
        // Non-Amazon (or already clean): just strip any ._xxx_ transform before the extension.
        return clean.replace(/\._[^/]*_(?=\.(jpg|jpeg|png|gif|webp)$)/i, "");
      })
      .filter(Boolean)
  )).slice(0, 12);
}

async function prepareListingProductData(product, settings = {}) {
  const amazonPrice = parseFloat(product.price || 0);
  const markupVal = settings.markup !== "" && settings.markup !== undefined
    ? parseFloat(settings.markup)
    : 30;
  const markup = isNaN(markupVal) ? 30 : markupVal;
  const ebayPrice = (amazonPrice * (1 + (markup + 15) / 100)).toFixed(2);
  const workerUrl = settings.clawdbot_worker_url || WORKER_URL;
  const normalizedImages = normalizeListingImageUrls([
    product.selected_image,
    ...(product.images || [])
  ]);
  const proxiedImages = workerUrl
    ? normalizedImages.map(url => `${workerUrl}/img?u=${encodeURIComponent(url)}`)
    : normalizedImages;

  return {
    ...product,
    price: ebayPrice,
    quantity: normalizeQuantity(product.quantity, settings.quantity, settings.defaultQuantity, 1),
    images: proxiedImages,
    main_hd_images: proxiedImages,
    main_sd_images: proxiedImages,
    selected_image: proxiedImages[0] || "",
    description: buildListingDescription(product),
    title: sanitizeForEbay(product.custom_title || product.title || "").slice(0, 80),
    condition: product.condition || settings.condition || "New",
  };
}

async function updateQueueItem(productId, updates) {
  const data = await chrome.storage.local.get({ queue: [] });
  const queue = data.queue.map(item =>
    item.id === productId || item.asin === productId ? { ...item, ...updates } : item
  );
  await chrome.storage.local.set({ queue });
}

async function updateBulkListingJob(updates) {
  const data = await chrome.storage.local.get({ bulkListingJob: null });
  await chrome.storage.local.set({
    bulkListingJob: {
      ...(data.bulkListingJob || {}),
      ...updates,
      updatedAt: Date.now(),
    },
  });
}

function isListingFlowFailure(error = "") {
  return /listing did not confirm|listing timed out|list button|could not find the list|shipping|free shipping/i.test(String(error || ""));
}

function runEbayListingFlow(productData, settings = {}, options = {}) {
  return new Promise(resolve => {
    chrome.tabs.create(
      { url: "https://www.ebay.com/sl/prelist/suggest", active: true },
      tab => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
          return;
        }

        const tabId = tab.id;

        function waitForTabComplete(id, timeoutMs = 20000) {
          return new Promise((done, reject) => {
            const timer = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              reject(new Error("Tab load timeout"));
            }, timeoutMs);

            function listener(tid, changeInfo) {
              if (tid !== id || changeInfo.status !== "complete") return;
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              done();
            }
            chrome.tabs.onUpdated.addListener(listener);
          });
        }

        async function injectAndSend(tid, msgType, data, maxRetries = 3) {
          for (let i = 0; i < maxRetries; i++) {
            await sleep(1500);
            await chrome.scripting.executeScript({
              target: { tabId: tid },
              files: ["content_ebay_listing.js"]
            }).catch(() => {});
            await sleep(500);

            const response = await new Promise(done => {
              chrome.tabs.sendMessage(tid, { type: msgType, productData: data, settings }, r => {
                if (chrome.runtime.lastError) done(null);
                else done(r);
              });
            });
            if (response !== null) return response;
          }
          return null;
        }

        (async () => {
          let finalResult = null;
          try {
            await waitForTabComplete(tabId);
            const prelistResp = await injectAndSend(tabId, "insert_draft_details", productData);
            console.log("PhiloShip: prelist response:", prelistResp);

            // Drive prelist → identify → lstng by POLLING the tab URL (more
            // reliable than a single onUpdated event). While on the identify
            // step, re-inject the content script repeatedly so the condition/
            // continue handler is guaranteed to run even if the page is slow or
            // the manifest auto-inject doesn't fire. Resolve when the draft loads.
            const lstngUrl = await new Promise((resolve, reject) => {
              let injects = 0;
              const started = Date.now();
              const iv = setInterval(async () => {
                let url = "";
                try { const t = await chrome.tabs.get(tabId); url = t.url || ""; } catch (e) {}

                if (url.includes("/lstng") && url.includes("draftId")) {
                  clearInterval(iv);
                  resolve(url);
                  return;
                }
                if (url.includes("/prelist/identify") && injects < 8) {
                  injects++;
                  chrome.scripting.executeScript(
                    { target: { tabId }, files: ["content_ebay_listing.js"] }
                  ).catch(() => {});
                }
                if (Date.now() - started > 90000) {
                  clearInterval(iv);
                  reject(new Error("eBay did not reach the listing form within 90s"));
                }
              }, 1500);
            });

            console.log("PhiloShip: lstng page detected:", lstngUrl);

            await waitForTabComplete(tabId, 15000).catch(() => {});
            await sleep(2000);

            await chrome.scripting.executeScript({
              target: { tabId }, files: ["content_ebay_listing.js"]
            }).catch(() => {});
            await sleep(1000);

            const finalResultPromise = new Promise(done => {
              const timeout = setTimeout(() => {
                chrome.runtime.onMessage.removeListener(resultListener);
                done({ success: false, error: "Listing timed out after 10 minutes" });
              }, 10 * 60 * 1000);

              function resultListener(msg, msgSender) {
                if (msgSender.tab?.id !== tabId) return;
                if (msg.type === "itemListed") {
                  clearTimeout(timeout);
                  chrome.runtime.onMessage.removeListener(resultListener);
                  done({ success: true, itemId: msg.itemId, ebayUrl: msg.ebayUrl });
                } else if (msg.type === "itemFailed") {
                  clearTimeout(timeout);
                  chrome.runtime.onMessage.removeListener(resultListener);
                  done({ success: false, error: msg.error || "Listing failed" });
                }
              }
              chrome.runtime.onMessage.addListener(resultListener);
            });

            chrome.tabs.sendMessage(tabId, {
              type: "insert_draft_details", productData, settings
            }, () => { if (chrome.runtime.lastError) {} });

            finalResult = await finalResultPromise;

            if (finalResult?.success) {
              const pos = await chrome.storage.local.get({ bulkPosition: 0 });
              chrome.storage.local.set({ bulkPosition: pos.bulkPosition + 1 });
            }
          } catch (e) {
            console.error("PhiloShip: listing flow error:", e);
            finalResult = { success: false, error: e.message };
          } finally {
            chrome.storage.local.remove("_clawdPendingListing");
            if (finalResult?.success || options.closeOnFailure) {
              setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), finalResult?.success ? 2500 : 15000);
            }
          }

          resolve(finalResult || { success: false, error: "No response from lstng page" });
        })();
      }
    );
  });
}

// ── Bulk enrichment ─────────────────────────────────────────────────────────
// Bulk snipe only captures thin search-card data (title, price, one thumbnail,
// no description/specifics). This visits each product page in one reused
// background tab and runs the full content_amazon.js scraper to fill in the
// real description, full images, brand, and item specifics before listing.
let bulkEnrichActive = false;

async function updateEnrichProgress(current, total, title) {
  await chrome.storage.local.set({
    bulkEnrichJob: { current, total, title: title || "", active: current < total, updatedAt: Date.now() },
  });
}

function enrichBulkItem(item, tabId) {
  return new Promise(async (resolve) => {
    if (!item || !item.url) { resolve(item); return; }
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(val);
    };
    // On any failure/timeout keep the thin item rather than losing it.
    const timer = setTimeout(() => finish(item), 35000);
    const listener = (msg, sender) => {
      if (sender.tab?.id !== tabId || msg?.type !== "philo_enriched_product") return;
      if (msg.failed || !msg.product) { finish(item); return; }
      const merged = { ...item, ...msg.product };
      merged.id = item.id || msg.product.id;
      if (!merged.price && item.price) merged.price = item.price;
      merged.source = "bulk";
      merged.enriched = true;
      finish(merged);
    };
    chrome.runtime.onMessage.addListener(listener);
    try {
      await chrome.tabs.update(tabId, { url: item.url, active: false });
      await waitForTabComplete(tabId, 25000).catch(() => {});
      await sleep(1500); // let the product page settle (title/price/bullets/specifics)
      await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__philoEnrich = true; } });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content_amazon.js"] });
    } catch (e) {
      finish(item);
    }
  });
}

async function runBulkEnrichment(items) {
  if (bulkEnrichActive) return 0;
  bulkEnrichActive = true;
  let tab = null;
  const enriched = [];
  try {
    tab = await chrome.tabs.create({ url: "about:blank", active: false });
    for (let i = 0; i < items.length; i++) {
      await updateEnrichProgress(i, items.length, items[i].title);
      enriched.push(await enrichBulkItem(items[i], tab.id));
    }
  } catch (e) {
    console.error("PhiloShip: bulk enrichment error", e);
  } finally {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    bulkEnrichActive = false;
  }
  // Merge into the queue, deduped by id (enriched entries win).
  const data = await chrome.storage.local.get({ queue: [] });
  const byId = new Map(data.queue.map((p) => [p.id, p]));
  for (const p of enriched) byId.set(p.id, p);
  await chrome.storage.local.set({ queue: Array.from(byId.values()) });
  await updateEnrichProgress(items.length, items.length, "done");
  return enriched.length;
}

async function runBulkListing(snapshot, settings) {
  if (bulkListingActive) {
    return { success: false, error: "Bulk listing is already running" };
  }

  bulkListingActive = true;
  bulkListingStopRequested = false;
  const startedAt = Date.now();
  let listed = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  try {
    await ensureOffscreen();
    await updateBulkListingJob({
      status: "running",
      current: 0,
      total: snapshot.length,
      listed,
      failed,
      startedAt,
      results,
      error: "",
    });

    for (let i = 0; i < snapshot.length; i++) {
      const stopState = await chrome.storage.local.get({ bulkListingStopRequested: false });
      if (bulkListingStopRequested || stopState.bulkListingStopRequested) {
        await updateBulkListingJob({
          status: "stopped",
          current: i,
          total: snapshot.length,
          listed,
          failed,
          stoppedAt: Date.now(),
          currentProduct: "",
        });
        return { success: true, stopped: true, listed, failed, total: snapshot.length };
      }

      const product = snapshot[i];
      const productId = product.id || product.asin || product.url || String(i);

      await updateQueueItem(productId, { status: "listing", listingError: "" });
      await updateBulkListingJob({
        status: "running",
        current: i + 1,
        total: snapshot.length,
        currentProduct: product.title || productId,
      });

      let result;
      try {
        const productData = await prepareListingProductData(product, settings);
        result = await runEbayListingFlow(productData, settings, { closeOnFailure: false });
      } catch (e) {
        result = { success: false, error: e.message };
      }

      if (result?.success) {
        listed++;
        await updateQueueItem(productId, {
          status: "listed",
          ebayItemId: result.itemId,
          ebayUrl: result.ebayUrl,
          listedAt: Date.now(),
          listingError: "",
        });
      } else if (result?.duplicate || result?.alreadyListed) {
        // Item is already listed on eBay — not a failure. Mark it and move on
        // so a duplicate never stops the bulk run.
        skipped++;
        await updateQueueItem(productId, {
          status: "already_listed",
          listingError: "",
        });
      } else {
        failed++;
        await updateQueueItem(productId, {
          status: "listing_failed",
          listingError: result?.error || "Listing failed",
        });
      }

      results.unshift({
        productId,
        title: product.title || "",
        success: !!result?.success,
        itemId: result?.itemId || "",
        ebayUrl: result?.ebayUrl || "",
        error: result?.error || "",
        at: Date.now(),
      });

      await updateBulkListingJob({
        status: "running",
        current: i + 1,
        total: snapshot.length,
        listed,
        failed,
        skipped,
        results: results.slice(0, 50),
      });

      if (!result?.success && !result?.duplicate && !result?.alreadyListed &&
          isListingFlowFailure(result?.error)) {
        await updateBulkListingJob({
          status: "failed",
          current: i + 1,
          total: snapshot.length,
          listed,
          failed,
          currentProduct: product.title || productId,
          error: `${result?.error || "Listing failed"}; leaving the eBay tab open for inspection and stopping bulk listing.`,
          results: results.slice(0, 50),
        });
        return {
          success: false,
          error: result?.error || "Listing failed",
          listed,
          failed,
          total: snapshot.length,
        };
      }

      const afterItemStopState = await chrome.storage.local.get({ bulkListingStopRequested: false });
      if (bulkListingStopRequested || afterItemStopState.bulkListingStopRequested) {
        await updateBulkListingJob({
          status: "stopped",
          current: i + 1,
          total: snapshot.length,
          listed,
          failed,
          stoppedAt: Date.now(),
          currentProduct: "",
          results: results.slice(0, 50),
        });
        return { success: true, stopped: true, listed, failed, total: snapshot.length };
      }

      if (i < snapshot.length - 1) await sleep(2000);
    }

    await updateBulkListingJob({
      status: "complete",
      current: snapshot.length,
      total: snapshot.length,
      listed,
      failed,
      completedAt: Date.now(),
      currentProduct: "",
    });

    return { success: true, listed, failed, total: snapshot.length };
  } catch (e) {
    await updateBulkListingJob({ status: "failed", error: e.message, listed, failed });
    return { success: false, error: e.message, listed, failed, total: snapshot.length };
  } finally {
    bulkListingActive = false;
    bulkListingStopRequested = false;
    chrome.storage.local.remove(["bulkSnapshot", "bulkSettings", "bulkListingStopRequested"]);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // eBay connect — fetch the Worker's /ebay/connect as JSON to get the OAuth URL,
  // then open that URL in a tab. Worker stores the state→userId mapping.
  if (message.action === "open_ebay_connect") {
    (async () => {
      try {
        const res = await fetch(`${WORKER_URL}/ebay/connect`, {
          headers: {
            "Authorization": `Bearer ${message.accessToken}`,
            "Accept": "application/json",
          },
        });
        const data = await res.json();
        if (data.url) {
          chrome.tabs.create({ url: data.url });
        } else {
          console.error("PhiloShip: eBay connect error:", data.error);
        }
      } catch(e) {
        console.error("PhiloShip: eBay connect failed", e);
      }
    })();
    return false;
  }

  // ── Bulk enrichment — fill thin bulk items with full product-page data ────
  if (message.action === "bulk_enrich_and_save") {
    (async () => {
      const count = await runBulkEnrichment(message.items || []);
      sendResponse({ success: true, count });
    })();
    return true; // keep sendResponse open
  }

  // ── eBay UI listing — background owns the full tab lifecycle ──────────────
  if (message.action === "start_ebay_listing") {
    const { productData, settings, jobId } = message;

    (async () => {
      const result = await runEbayListingFlow(productData, settings, { closeOnFailure: false });
      if (jobId) await chrome.storage.local.set({ [jobId]: result });
      sendResponse(result);
    })();

    return true; // keep sendResponse open
  }

  if (message.action === "start_bulk_ebay_listing") {
    if (bulkListingActive) {
      sendResponse({ success: false, error: "Bulk listing is already running" });
      return false;
    }
    runBulkListing(message.snapshot || [], message.settings || {})
      .catch(e => updateBulkListingJob({ status: "failed", error: e.message }));
    sendResponse({ success: true, started: true });
    return false;
  }

  if (message.action === "stop_bulk_ebay_listing") {
    bulkListingStopRequested = true;
    (async () => {
      await chrome.storage.local.set({ bulkListingStopRequested: true });
      await updateBulkListingJob({ status: "stopping", error: "" });
      const tabs = await chrome.tabs.query({
        url: [
          "https://www.ebay.com/sl/prelist/*",
          "https://www.ebay.com/lstng*",
          "https://www.ebay.com/sell/*"
        ]
      }).catch(() => []);
      for (const tab of tabs) {
        chrome.tabs.remove(tab.id).catch(() => {});
      }
      if (!bulkListingActive) {
        await updateBulkListingJob({ status: "stopped", stoppedAt: Date.now(), currentProduct: "" });
        await chrome.storage.local.remove(["bulkSnapshot", "bulkSettings", "bulkListingStopRequested"]);
      }
    })().then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // Policy warnings from content script — forward to popup
  if (message.action === 'policy_warning') {
    chrome.notifications.create({
      type:     'basic',
      iconUrl:  'icon48.png',
      title:    '⚠️ Peace Policy Warning',
      message:  `"${message.product}": ${message.warnings[0]}` +
                (message.warnings.length > 1 ? ` (+${message.warnings.length - 1} more)` : ''),
      priority: 2,
    });
    return false;
  }

  // url-to-b64: fetch Amazon image as base64 (EcomSniper's _0x3fb5f6 pattern)
  // keepAlive ping from offscreen document — just needs to be received to reset timer
  if (message.type === 'keepAlive') return;

  if (message.type === "url-to-b64" || message.action === "url-to-b64") {
    fetchURLtoBase64(message.url)
      .then(b64 => sendResponse({ b64Image: b64 }))
      .catch(e  => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === "download_csv") {
    chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: true });
  }

  if (message.action === "trigger_sync") {
    runInventorySync().then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action === "trigger_order_poll") {
    runOrderPoll().then(result => sendResponse(result)).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (message.action === "fulfill_order") {
    handleFulfillOrder(message.orderId).then(r => sendResponse(r)).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  // ── NEW: Auto-fulfillment orchestration messages ────────────────────────

  if (message.action === "start_auto_fulfill") {
    startAutoFulfill(message.fulfillment, sender.tab)
      .then(result => sendResponse({ success: true, ...(result || {}) }))
      .catch(e => {
        console.error("PhiloShip: start_auto_fulfill error:", e);
        sendResponse({ success: false, error: e.message });
      });
    return true;
  }

  if (message.action === "fulfill_retry") {
    const job = message.job;
    scheduleFulfillmentInjection(job?.amazonTabId, "retry", 2000);
  }

  if (message.action === "fulfill_manual_intervention") {
    console.warn("PhiloShip: Fulfillment paused for manual intervention:", message.reason);
    showNotification("Fulfillment Paused", message.reason || "Manual action is needed in the Amazon tab.");
  }

  if (message.action === "fulfill_complete") {
    handleFulfillComplete(message).catch(e =>
      console.error("PhiloShip: fulfill_complete error:", e)
    );
  }

  if (message.action === "fulfill_failed") {
    console.error("PhiloShip: Fulfillment FAILED:", message.reason);
    showNotification("❌ Fulfillment Failed", `${message.reason}\nOrder: ${message.job?.ebayOrderId || "?"}`);
    chrome.storage.local.remove(["pendingFulfillment", "pendingBuyer"]).then(() =>
      startNextQueuedFulfillment().catch(e =>
        console.error("PhiloShip: Could not start next queued fulfillment:", e)
      )
    );
  }
});

// ── 3. OAuth redirect intercept ───────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Use changeInfo.url (populated during navigation) with tab.url as fallback
  const url = changeInfo.url || tab.url || "";
  if (!url) return;

  // Google OAuth success — capture tokens from URL fragment
  if (url.includes(`${WORKER_URL}/auth/success`)) {
    try {
      const fragment     = url.includes("#") ? url.split("#")[1] : "";
      const params       = new URLSearchParams(fragment);
      const accessToken  = params.get("accessToken");
      const refreshToken = params.get("refreshToken");
      const userId       = params.get("userId");
      if (accessToken) {
        await chrome.storage.local.set({ accessToken, refreshToken, userId });
        console.log("PhiloShip: Google OAuth tokens saved for user", userId);
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
      }
    } catch(e) { console.error("PhiloShip: Google OAuth parse error:", e); }
    return;
  }

  // eBay OAuth success page — intercept the code and save via Worker
  if (url.includes("ThirdPartyAuthSucessFailure") &&
      url.includes("isAuthSuccessful=true") &&
      url.includes("code=")) {
    try {
      const urlObj = new URL(url);
      const code   = urlObj.searchParams.get("code");
      if (!code) return;

      console.log("PhiloShip: eBay auth code captured, exchanging via Worker...");

      const { accessToken } = await chrome.storage.local.get("accessToken");

      const res = await fetch(`${WORKER_URL}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { "Authorization": `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ code, use_env_creds: true }),
      });

      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (data.access_token) {
        await chrome.storage.local.set({
          ebay_access_token:     data.access_token,
          ebay_refresh_token:    data.refresh_token,
          ebay_token_expires_at: Date.now() + (data.expires_in || 7200) * 1000,
        });
        console.log("PhiloShip: eBay tokens saved successfully");
        showNotification("Peace: eBay Connected! 🎉", "Your eBay account is now linked.");
        setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 2000);
      } else {
        console.error("PhiloShip: eBay token exchange failed — full response:", JSON.stringify(data));
        showNotification("Peace: eBay Connect Failed", data.detail || data.error || "Token exchange failed");
      }
    } catch(e) {
      console.error("PhiloShip: eBay OAuth intercept error:", e);
    }
    return;
  }

  // Auto-fulfill: re-inject script on Amazon page navigation
  if (!url.startsWith("https://www.amazon.com/")) return;

  const data = await chrome.storage.local.get("pendingFulfillment");
  if (!data.pendingFulfillment) return;

  if (changeInfo.status !== "complete") return;

  const job = data.pendingFulfillment;
  if (job.amazonTabId && job.amazonTabId !== tabId) return;

  // If user landed on thankyou page (placed order manually), advance to confirm step
  const lowerAmazonUrl = url.toLowerCase();
  const isAmazonCompletionUrl =
    lowerAmazonUrl.includes('gp/buy/thankyou') ||
    lowerAmazonUrl.includes('/thankyou') ||
    lowerAmazonUrl.includes('/confirmation') ||
    lowerAmazonUrl.includes('/order-confirmation') ||
    lowerAmazonUrl.includes('order-history') ||
    lowerAmazonUrl.includes('order-details');
  if (isAmazonCompletionUrl) {
    if (job.step === "confirm_order" || job.step === "place_order") {
      job.step = "confirm";
      job.retries = 0;
      delete job.manualPlaceOrderRequired;
      delete job.manualPlaceOrderUrl;
      delete job.pausedForManualIntervention;
      delete job.pauseReason;
      delete job.lastManualNoticeAt;
      await chrome.storage.local.set({ pendingFulfillment: job });
      scheduleFulfillmentInjection(tabId, "manual-order-confirmed", 1500);
      return;
    }
  }

  // If on a search/non-product page and we have an ASIN, navigate to product page
  if (job.step === "add_to_cart" && job.amazonAsin &&
      (url.includes('/s?') || url.includes('/s/') || !url.includes('/dp/'))) {
    if (!url.includes('/dp/') && !url.includes('/gp/buy') && !url.includes('/cart') && !url.includes('/checkout')) {
      setTimeout(async () => {
        try { await chrome.tabs.update(tabId, { url: `https://www.amazon.com/dp/${job.amazonAsin}?th=1&psc=1` }); } catch(e) {}
      }, 500);
      return;
    }
  }

  // Otherwise re-inject on any Amazon page with a pending job
  scheduleFulfillmentInjection(tabId, "navigation", 2500);
});

// ── 4. Auto-Fulfillment Orchestration ─────────────────────────────────────────

function getBuyerFirstName(job) {
  const fullName = String(job?.buyer?.name || job?.buyerName || "").trim();
  return fullName.split(/\s+/)[0] || "";
}

function buildBuyerMessage(job, deliveryEstimate) {
  const eta = String(deliveryEstimate || "").trim();
  const firstName = getBuyerFirstName(job);
  const greeting = firstName ? `Hello ${firstName}! ` : "";
  if (eta) {
    return `${greeting}Thank you so much for your order. Your Amazon fulfillment is underway, and the current estimated delivery is ${eta}. I'll keep an eye on it and upload tracking as soon as it becomes available.`;
  }
  return `${greeting}Thank you so much for your order. Your Amazon fulfillment is underway now, and I'll upload tracking as soon as it becomes available.`;
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (existing?.status === "complete") return existing;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab to finish loading."));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectFulfillmentScript(tabId, reason = "navigation") {
  if (!tabId) return;

  const storage = await chrome.storage.local.get("pendingFulfillment");
  const job = storage.pendingFulfillment;
  if (!job) return;
  if (job.amazonTabId && job.amazonTabId !== tabId) return;

  const tab = await waitForTabComplete(tabId, 20000).catch(() => chrome.tabs.get(tabId).catch(() => null));
  const url = tab?.url || "";
  if (!url.startsWith("https://www.amazon.com/")) return;

  const key = String(tabId);
  const state = fulfillmentInjectionState.get(key) || {};
  if (Date.now() - (state.lastInjectedAt || 0) < 1500) return;
  fulfillmentInjectionState.set(key, { ...state, lastInjectedAt: Date.now(), timer: null });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["fulfill_amazon.js"],
    });
    console.log(`PhiloShip: Fulfillment script injected (${reason})`);
  } catch (e) {
    console.warn("PhiloShip: Fulfillment injection skipped:", e.message);
  }
}

function scheduleFulfillmentInjection(tabId, reason = "navigation", delayMs = 1500) {
  if (!tabId) return;

  const key = String(tabId);
  const state = fulfillmentInjectionState.get(key) || {};
  if (state.timer) clearTimeout(state.timer);

  const timer = setTimeout(() => {
    const latest = fulfillmentInjectionState.get(key) || {};
    fulfillmentInjectionState.set(key, { ...latest, timer: null });
    injectFulfillmentScript(tabId, reason);
  }, delayMs);

  fulfillmentInjectionState.set(key, { ...state, timer });
}

async function openEbayOrderPage(job) {
  if (!job.ebayOrderUrl) {
    throw new Error("Missing eBay order URL for post-order follow-up.");
  }

  let tab = null;
  if (job.sourceEbayTabId) {
    const sourceTab = await chrome.tabs.get(job.sourceEbayTabId).catch(() => null);
    if (sourceTab) {
      tab = await chrome.tabs.update(sourceTab.id, { url: job.ebayOrderUrl, active: true });
    }
  }

  if (!tab) {
    const existingTabs = await chrome.tabs.query({ url: "https://www.ebay.com/*" });
    const exact = existingTabs.find(t => t.url === job.ebayOrderUrl);
    tab = exact
      ? await chrome.tabs.update(exact.id, { active: true })
      : await chrome.tabs.create({ url: job.ebayOrderUrl, active: true });
  }

  await waitForTabComplete(tab.id);
  return tab;
}

// Opens the eBay order page ONCE and runs message + mark-as-shipped together.
async function performEbayPostFulfillment(job, deliveryEstimate) {
  const tab = await openEbayOrderPage(job);
  await new Promise(resolve => setTimeout(resolve, 3000));
  const messageText = buildBuyerMessage(job, deliveryEstimate);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (msgText) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));

      function simulateClick(el) {
        ["mousedown", "mouseup", "click"].forEach(type =>
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
        );
      }

      async function closeMessagePanel() {
        const selectors = [
          "button.icon-btn.panel-dialog__close",
          "button.panel-dialog__close",
          ".panel-dialog__close",
          'button[aria-label*="Close"]',
          'button[title*="Close"]'
        ];

        for (let attempt = 0; attempt < 10; attempt++) {
          const closeBtn = selectors
            .map(selector => document.querySelector(selector))
            .find(Boolean);
          if (closeBtn) {
            simulateClick(closeBtn);
            await wait(800);
            return true;
          }
          await wait(300);
        }
        return false;
      }

      // ── STEP 1: Mark as shipped via direct fetch ─────────────────────────
      // Mirrors the EcomSniper approach: find the MARK_SHIPPED href and fetch it.
      async function markShipped() {
        const link = document.querySelector('[data-action-id="MARK_SHIPPED"] a') ||
                     document.querySelector('a[href*="MarkItemShipped"]') ||
                     document.querySelector('a[href*="mark_shipped"]');
        if (!link) return { ok: false, reason: "Mark shipped link not found on page" };
        try {
          const resp = await fetch(link.href, { method: "GET", credentials: "include" });
          const text = await resp.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* not JSON */ }
          const success = (parsed?.ack === "SUCCESS") ||
                          text.includes("Update Shipment operation success") ||
                          resp.ok;
          return { ok: success, reason: success ? null : "Fetch did not confirm success" };
        } catch (e) {
          return { ok: false, reason: e.message };
        }
      }

      // ── STEP 2: Send buyer message via eBay iframe panel ─────────────────
      // eBay opens an iframe (.ordui-m2m-panel__iframe) when the message button is clicked.
      async function sendMessage() {
        // Button is inside .order-info .actions (EcomSniper confirmed)
        let msgBtn = document.querySelector(".order-info .actions .btn--secondary");
        if (!msgBtn) {
          msgBtn = Array.from(document.querySelectorAll("button"))
            .find(b => /message\s+buyer/i.test(b.textContent));
        }
        if (!msgBtn) return { ok: false, reason: "Message buyer button not found" };

        simulateClick(msgBtn);
        await wait(2500);

        // Wait for the iframe panel to appear
        let iframe = null;
        const iframeStart = Date.now();
        while (!iframe && Date.now() - iframeStart < 10000) {
          iframe = document.querySelector(".ordui-m2m-panel__iframe") ||
                   document.querySelector('iframe[src*="cnt/ViewMessage"]') ||
                   document.querySelector('iframe[src*="message"]');
          if (!iframe) await wait(400);
        }

        if (iframe) {
          // Wait for iframe to fully load
          if (iframe.contentDocument?.readyState !== "complete") {
            await new Promise(res => {
              iframe.addEventListener("load", res, { once: true });
              setTimeout(res, 8000);
            });
          }
          await wait(600);

          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iDoc) return { ok: false, reason: "Could not access iframe document" };

          const ta = iDoc.querySelector("#imageupload__sendmessage--textbox") ||
                     iDoc.querySelector('textarea[aria-label="Send message"]') ||
                     iDoc.querySelector("textarea");
          if (!ta) return { ok: false, reason: "Textarea not found inside iframe" };

          ta.focus(); ta.select(); await wait(150);
          const inserted = iDoc.execCommand("insertText", false, msgText);
          if (!inserted || ta.value !== msgText) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            setter ? setter.call(ta, msgText) : (ta.value = msgText);
            ta.dispatchEvent(new Event("input",  { bubbles: true }));
            ta.dispatchEvent(new Event("change", { bubbles: true }));
            ta.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "End" }));
          }
          await wait(800);

          let sendBtn = null;
          const sendStart = Date.now();
          while (Date.now() - sendStart < 6000) {
            sendBtn = iDoc.querySelector("#imageupload__send--button") ||
                      iDoc.querySelector('button[data-testid="message-send-button"]') ||
                      Array.from(iDoc.querySelectorAll("button"))
                        .find(b => /send\s+message/i.test(b.textContent) && !b.disabled);
            if (sendBtn && !sendBtn.disabled) break;
            await wait(300);
          }
          if (!sendBtn) return { ok: false, reason: "Send button not found in iframe" };
          if (sendBtn.disabled) sendBtn.removeAttribute("disabled");
          simulateClick(sendBtn);
          await wait(2000);
          await closeMessagePanel();
          return { ok: true };
        }

        // Fallback: older eBay layout with textarea directly on page
        const ta = document.querySelector("#imageupload__sendmessage--textbox") ||
                   document.querySelector('textarea[aria-label="Send message"]');
        if (!ta) return { ok: false, reason: "No iframe and no direct textarea found" };
        ta.focus(); ta.select(); await wait(100);
        document.execCommand("insertText", false, msgText);
        ta.dispatchEvent(new Event("input",  { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        await wait(800);
        let sendBtn = null;
        const t = Date.now();
        while (Date.now() - t < 5000) {
          sendBtn = document.querySelector("#imageupload__send--button") ||
                    document.querySelector('button[data-testid="message-send-button"]');
          if (sendBtn && !sendBtn.disabled) break;
          await wait(300);
        }
        if (!sendBtn) return { ok: false, reason: "Fallback send button not found" };
        if (sendBtn.disabled) sendBtn.removeAttribute("disabled");
        simulateClick(sendBtn);
        await wait(2000);
        await closeMessagePanel();
        return { ok: true };
      }

      const msgResult     = await sendMessage();
      const shippedResult = await markShipped();
      return { msgResult, shippedResult };
    },
    args: [messageText],
  });

  const result = results?.[0]?.result;
  if (!result?.msgResult?.ok) {
    console.warn("PhiloShip: Buyer message issue:", result?.msgResult?.reason);
  }
  if (!result?.shippedResult?.ok) {
    console.warn("PhiloShip: Mark-as-shipped issue:", result?.shippedResult?.reason);
    throw new Error(result?.shippedResult?.reason || "Mark as shipped failed");
  }
  return result;
}
// Keep legacy wrappers so the rest of the code that calls them still works
async function sendBuyerMessageOnEbay(job, deliveryEstimate) {
  return performEbayPostFulfillment(job, deliveryEstimate);
}

async function markAsShippedOnEbay(job) {
  return performEbayPostFulfillment(job, "");
}

function looksLikeAmazonAsin(value) {
  return /^B0[A-Z0-9]{8}$/i.test(String(value || "").trim());
}

function extractAmazonAsinFromUrl(url) {
  const text = String(url || "");
  const match = text.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return match ? match[1].toUpperCase() : "";
}

function buildAmazonProductUrl(rawUrl, asin) {
  const rawText = String(rawUrl || "").trim();
  if (rawText) {
    try {
      const parsed = new URL(rawText);
      if (/amazon\.com$/i.test(parsed.hostname) || /\.amazon\.com$/i.test(parsed.hostname)) {
        const urlAsin = extractAmazonAsinFromUrl(parsed.toString());
        if (urlAsin) {
          const preferred = new URL(`https://www.amazon.com/dp/${urlAsin}`);
          const th = parsed.searchParams.get("th");
          const psc = parsed.searchParams.get("psc");
          if (th) preferred.searchParams.set("th", th);
          if (psc) preferred.searchParams.set("psc", psc);
          return preferred.toString();
        }
        return parsed.toString();
      }
    } catch {
      // fall through to ASIN-only fallback
    }
  }

  const normalizedAsin = looksLikeAmazonAsin(asin) ? String(asin).toUpperCase() : "";
  return normalizedAsin ? `https://www.amazon.com/dp/${normalizedAsin}?th=1&psc=1` : "";
}

function deriveAmazonLaunchTarget(fulfillment) {
  const identityCandidates = [
    fulfillment.amazonUrl,
    fulfillment.amazonAsin,
    fulfillment.decodedEbaySku,
    fulfillment.ebaySku,
  ].map(value => String(value || "").trim()).filter(Boolean);

  for (const candidate of identityCandidates) {
    const directUrl = buildAmazonProductUrl(candidate, candidate);
    const directAsin =
      extractAmazonAsinFromUrl(directUrl || candidate) ||
      (looksLikeAmazonAsin(candidate) ? candidate.toUpperCase() : "");

    if (directUrl || directAsin) {
      return {
        amazonUrl: directUrl || `https://www.amazon.com/dp/${directAsin}?th=1&psc=1`,
        amazonAsin: directAsin,
      };
    }
  }

  return { amazonUrl: "", amazonAsin: "" };
}

async function placeTabNextToSource(tabId, sourceTab) {
  if (!tabId || !sourceTab?.id) return await chrome.tabs.get(tabId).catch(() => null);

  const latestSource = await chrome.tabs.get(sourceTab.id).catch(() => sourceTab);
  if (!latestSource) return await chrome.tabs.get(tabId).catch(() => null);

  const targetIndex = latestSource.index + 1;
  try {
    return await chrome.tabs.move(tabId, {
      windowId: latestSource.windowId,
      index: targetIndex,
    });
  } catch (error) {
    console.warn("PhiloShip: Could not move Amazon tab beside eBay tab:", error);
    return await chrome.tabs.get(tabId).catch(() => null);
  }
}

async function openOrReuseAmazonTab(startUrl, sourceTab) {
  const amazonTabs = await chrome.tabs.query({ url: "https://www.amazon.com/*" });
  const preferredTab = sourceTab?.windowId != null
    ? amazonTabs.find(tab => tab.windowId === sourceTab.windowId)
    : null;
  const reusableTab = preferredTab || amazonTabs[0] || null;

  if (reusableTab) {
    await placeTabNextToSource(reusableTab.id, sourceTab);
    return await chrome.tabs.update(reusableTab.id, { url: startUrl, active: true });
  }

  const createProperties = { url: startUrl, active: true };
  if (sourceTab?.windowId != null) {
    createProperties.windowId = sourceTab.windowId;
  }
  if (typeof sourceTab?.index === "number") {
    createProperties.index = sourceTab.index + 1;
  }

  return await chrome.tabs.create(createProperties);
}

function getFulfillmentKey(fulfillment) {
  return [
    fulfillment?.ebayOrderId || "",
    fulfillment?.ebayItemId || "",
    fulfillment?.amazonAsin || fulfillment?.amazonUrl || fulfillment?.amazonSearchTerm || "",
  ].join("::");
}

async function enqueueFulfillment(fulfillment) {
  const data = await chrome.storage.local.get({ fulfillmentQueue: [] });
  const queue = Array.isArray(data.fulfillmentQueue) ? data.fulfillmentQueue : [];
  const key = getFulfillmentKey(fulfillment);
  const exists = queue.some(item => getFulfillmentKey(item) === key);

  if (!exists) {
    queue.push({
      ...fulfillment,
      queuedAt: Date.now(),
    });
    await chrome.storage.local.set({ fulfillmentQueue: queue });
  }

  return {
    queued: true,
    queueLength: queue.length,
    duplicate: exists,
  };
}

async function getActiveFulfillmentStatus(job) {
  if (!job) return { active: false, reason: "none" };

  if (!job.amazonTabId) {
    return { active: false, reason: "missing_amazon_tab" };
  }

  const tab = await chrome.tabs.get(job.amazonTabId).catch(() => null);
  if (!tab) {
    return { active: false, reason: "amazon_tab_closed" };
  }

  const url = tab.url || "";
  if (!url.startsWith("https://www.amazon.com/")) {
    return { active: false, reason: "amazon_tab_not_on_amazon", tabUrl: url };
  }

  return {
    active: true,
    reason: "active",
    tabId: tab.id,
    tabUrl: url,
    ebayOrderId: job.ebayOrderId || "",
    step: job.step || "",
    manualPlaceOrderRequired: !!job.manualPlaceOrderRequired,
    pausedForManualIntervention: !!job.pausedForManualIntervention,
  };
}

async function clearStalePendingFulfillment(reason) {
  console.warn("PhiloShip: Clearing stale pending fulfillment:", reason);
  await chrome.storage.local.remove(["pendingFulfillment", "pendingBuyer"]);
}

async function startNextQueuedFulfillment() {
  const data = await chrome.storage.local.get({ fulfillmentQueue: [], pendingFulfillment: null });
  if (data.pendingFulfillment) return null;

  const queue = Array.isArray(data.fulfillmentQueue) ? data.fulfillmentQueue : [];
  const next = queue.shift();
  await chrome.storage.local.set({ fulfillmentQueue: queue });

  if (!next) return null;
  console.log("PhiloShip: Starting next queued fulfillment", next.ebayOrderId);
  return startAutoFulfill(next, null, { fromQueue: true });
}

async function startAutoFulfill(fulfillment, sourceTab, options = {}) {
  console.log("PhiloShip: Starting auto-fulfillment for order", fulfillment.ebayOrderId);

  if (!options.fromQueue) {
    const existing = await chrome.storage.local.get("pendingFulfillment");
    if (existing.pendingFulfillment) {
      const activeStatus = await getActiveFulfillmentStatus(existing.pendingFulfillment);
      if (!activeStatus.active) {
        await clearStalePendingFulfillment(activeStatus.reason);
      } else {
      const activeKey = getFulfillmentKey(existing.pendingFulfillment);
      const incomingKey = getFulfillmentKey(fulfillment);
      if (activeKey !== incomingKey) {
        const queuedResult = await enqueueFulfillment(fulfillment);
        return { ...queuedResult, active: activeStatus };
      }
      return { alreadyActive: true, queued: false, queueLength: 0, active: activeStatus };
      }
    }
  }

  const derivedTarget = deriveAmazonLaunchTarget(fulfillment);
  const asinFromUrl = extractAmazonAsinFromUrl(fulfillment.amazonUrl);
  const validAsin =
    derivedTarget.amazonAsin ||
    (looksLikeAmazonAsin(fulfillment.amazonAsin)
      ? String(fulfillment.amazonAsin).toUpperCase()
      : (asinFromUrl || ""));
  const directAmazonUrl = derivedTarget.amazonUrl || buildAmazonProductUrl(fulfillment.amazonUrl, validAsin) || null;

  const startUrl = directAmazonUrl ||
    (validAsin ? `https://www.amazon.com/dp/${validAsin}?th=1&psc=1` : null) ||
    (fulfillment.amazonSearchTerm ? `https://www.amazon.com/s?k=${encodeURIComponent(fulfillment.amazonSearchTerm)}` : null);

  if (!startUrl) {
    throw new Error("No Amazon URL or search term available for this fulfillment.");
  }

  const job = {
    ...fulfillment,
    step: fulfillment.step || "add_to_cart",
    attempts: 0,
    amazonAsin: validAsin,
    amazonUrl: directAmazonUrl || fulfillment.amazonUrl || "",
    sourceEbayTabId: sourceTab?.id || fulfillment.sourceEbayTabId || null,
    sourceEbayWindowId: sourceTab?.windowId ?? fulfillment.sourceEbayWindowId ?? null,
    sourceEbayTabIndex: sourceTab?.index ?? fulfillment.sourceEbayTabIndex ?? null,
  };

  await chrome.storage.local.set({
    pendingFulfillment: job,
    pendingBuyer: job.buyer,
  });

  const tab = await openOrReuseAmazonTab(startUrl, sourceTab);
  job.amazonTabId = tab.id;
  await chrome.storage.local.set({ pendingFulfillment: job });
  scheduleFulfillmentInjection(tab.id, "start", 2000);
  console.log(`PhiloShip: Opened Amazon tab ${tab.id} for fulfillment`);
  return { started: true, queued: false, amazonTabId: tab.id };
}

// ── 5. Handle Fulfillment Complete → Mark eBay as Shipped ─────────────────────

async function handleFulfillComplete(message) {
  const { ebayOrderId, ebayItemId, amazonOrderId, deliveryEstimate } = message;
  const storage = await chrome.storage.local.get("pendingFulfillment");
  const pendingJob = storage.pendingFulfillment || {};
  const amazonTabIdToClose = pendingJob.amazonTabId || null;

  console.log(`PhiloShip: ✅ Amazon order placed! Amazon #${amazonOrderId}, eBay #${ebayOrderId}`);
  showNotification("✅ Order Fulfilled!",
    `Amazon order ${amazonOrderId || "placed"} for eBay order ${ebayOrderId}`);

  // Open eBay order page ONCE and run message + mark-as-shipped together.
  // Falls back to CompleteSale API if UI automation fails.
  try {
    const result = await performEbayPostFulfillment(
      { ...pendingJob, ebayOrderId, ebayItemId },
      deliveryEstimate
    );
    if (result?.msgResult?.ok) {
      showNotification("\u2709\ufe0f Buyer Updated", `Buyer message sent for eBay order ${ebayOrderId}`);
    } else {
      console.warn("PhiloShip: Buyer message issue:", result?.msgResult?.reason);
    }
    showNotification("\ud83d\udce6 eBay Updated", `Order ${ebayOrderId} marked as shipped on eBay`);
  } catch (uiErr) {
    console.warn("PhiloShip: UI post-fulfillment failed, trying CompleteSale API:", uiErr);
    // Only call CompleteSale if we have a real order ID — the API rejects empty/invalid IDs
    const orderIdForApi = ebayOrderId || pendingJob.ebayOrderId || "";
    if (!orderIdForApi) {
      console.error("PhiloShip: No valid eBay order ID available for CompleteSale — skipping.");
      showNotification("⚠️ eBay Update Skipped", "No order ID found; could not mark as shipped.");
    } else {
      try {
        await markEbayOrderShipped(orderIdForApi, ebayItemId || pendingJob.ebayItemId || "");
        showNotification("📦 eBay Updated", `Order ${orderIdForApi} marked as shipped on eBay`);
      } catch (e) {
        console.error("PhiloShip: CompleteSale failed:", e);
        showNotification("⚠️ eBay Update Failed",
          `Order fulfilled but couldn't mark as shipped: ${e.message}`);
      }
    }
  }

  // Update local order records
  const ordersData = await chrome.storage.local.get({ ebay_orders: [] });
  const updatedOrders = (ordersData.ebay_orders || []).map(o =>
    o.orderId === ebayOrderId
      ? { ...o, fulfilled: true, fulfilledAt: Date.now(), amazonOrderId, deliveryEstimate }
      : o
  );
  await chrome.storage.local.set({ ebay_orders: updatedOrders });
  await chrome.storage.local.remove(["pendingFulfillment", "pendingBuyer"]);
  if (amazonTabIdToClose) {
    await chrome.tabs.remove(amazonTabIdToClose).catch(() => {});
  }
  await startNextQueuedFulfillment();
}

async function getValidEbayTradingToken(data = null) {
  const storage = data || await chrome.storage.local.get({
    clawdbot_worker_url: "",
    ebay_access_token: "",
    ebay_token_expires_at: 0,
    ebay_refresh_token: "",
    ebay_client_id: "",
    ebay_client_secret: "",
  });

  if (!storage.clawdbot_worker_url) throw new Error("Worker URL not configured");
  if (!storage.ebay_refresh_token && !storage.ebay_access_token) {
    throw new Error("eBay is not connected. Connect your eBay account in Settings.");
  }

  let token = storage.ebay_access_token;
  if (!token || Date.now() >= (storage.ebay_token_expires_at || 0) - 300_000) {
    if (!storage.ebay_refresh_token) {
      throw new Error("eBay access token expired and no refresh token is saved. Reconnect eBay in Settings.");
    }
    const resp = await fetch(`${storage.clawdbot_worker_url}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: storage.ebay_client_id,
        client_secret: storage.ebay_client_secret,
        refresh_token: storage.ebay_refresh_token,
        use_env_creds: true,
      }),
    });
    const tokenResult = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    if (!resp.ok || !tokenResult.access_token) {
      throw new Error(`Token refresh failed: ${resp.status} ${JSON.stringify(tokenResult)}`);
    }
    token = tokenResult.access_token;
    await chrome.storage.local.set({
      ebay_access_token: token,
      ebay_token_expires_at: Date.now() + (tokenResult.expires_in || 7200) * 1000,
      ...(tokenResult.refresh_token ? { ebay_refresh_token: tokenResult.refresh_token } : {}),
    });
  }

  return token;
}

function decodeXmlEntities(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function getXmlText(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXmlEntities(match[1].trim()) : "";
}

function getXmlBlocks(xml, tagName) {
  const blocks = [];
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  let match;
  while ((match = re.exec(String(xml || ""))) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

async function markEbayOrderShipped(ebayOrderId, ebayItemId) {
  const data = await chrome.storage.local.get({
    clawdbot_worker_url: "",
    ebay_access_token: "",
    ebay_token_expires_at: 0,
    ebay_refresh_token: "",
    ebay_client_id: "",
    ebay_client_secret: "",
  });

  if (!data.clawdbot_worker_url) throw new Error("Worker URL not configured");
  const token = await getValidEbayTradingToken(data);

  // Build CompleteSale XML
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <OrderID>${ebayOrderId}</OrderID>
  <Shipped>true</Shipped>
</CompleteSaleRequest>`;

  const resp = await fetch(`${data.clawdbot_worker_url}/trading`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call_name: "CompleteSale", xml, token }),
  });

  if (!resp.ok) throw new Error(`CompleteSale HTTP ${resp.status}`);

  const respXml = await resp.text();
  if (respXml.includes("<Ack>Failure</Ack>")) {
    const errMatch = respXml.match(/<LongMessage>(.*?)<\/LongMessage>/);
    throw new Error(errMatch ? errMatch[1] : "CompleteSale failed");
  }

  console.log("PhiloShip: eBay CompleteSale success for order", ebayOrderId);
}

// ── 6. Inventory sync ─────────────────────────────────────────────────────────
async function runInventorySync() {
  console.log("PhiloShip: Starting background sync...");
  const data = await chrome.storage.local.get({
    queue: [], markup: 30, globalMinProfit: 2.00
  });

  const updatedQueue = [...data.queue];

  for (const item of updatedQueue) {
    if (item.status === "listed") continue;
    try {
      const response = await fetch(item.url);
      const html = await response.text();

      const isOutOfStock = html.includes("Currently unavailable") || html.includes("Out of Stock");
      const priceMatch = html.match(/"priceAmount":(\d+\.\d+)/);

      if (isOutOfStock && item.status !== "out_of_stock") {
        item.status = "out_of_stock";
        showNotification("⚠ Out of Stock", `${item.title.slice(0, 28)}... is gone on Amazon.`);
      } else if (priceMatch) {
        const newPrice = parseFloat(priceMatch[1]);
        if (newPrice !== item.price) {
          const ebayPrice = item.lastListedEbayPrice || (item.price * (1 + data.markup / 100));
          const fees = (ebayPrice * 0.1325) + 0.30;
          const netProfit = ebayPrice - newPrice - fees;
          item.price = newPrice;
          item.currentProfit = netProfit;
          if (netProfit < data.globalMinProfit) {
            item.status = "CRITICAL_LOW_PROFIT";
            showNotification("💸 Margin Danger!", `Profit: $${netProfit.toFixed(2)} for ${item.title.slice(0, 20)}`);
          } else {
            item.status = "price_changed";
          }
        } else {
          if (item.status !== "out_of_stock" && item.status !== "listed") item.status = "active";
        }
      }
    } catch (err) {
      console.error("PhiloShip: Sync failed for", item.url, err);
    }
  }

  await chrome.storage.local.set({ queue: updatedQueue });
  console.log("PhiloShip: Background sync complete.");
}

// ── 7. Order polling ──────────────────────────────────────────────────────────
async function runOrderPoll() {
  console.log("PhiloShip Orders: Polling...");

  const data = await chrome.storage.local.get({
    clawdbot_worker_url: "",
    ebay_access_token: "",
    ebay_token_expires_at: 0,
    ebay_refresh_token: "",
    ebay_client_id: "",
    ebay_client_secret: "",
    ebay_orders: [],
    auto_fulfill: false,
  });

  // Check the user is logged in via the SaaS Worker
  const sessionToken = await getAccessToken();
  if (!sessionToken) {
    console.log("PhiloShip Orders: Not logged in, skipping.");
    return { newOrders: 0 };
  }

  try {
    const token = await getValidEbayTradingToken(data);

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <CreateTimeFrom>${fmt(twoDaysAgo)}</CreateTimeFrom>
  <CreateTimeTo>${fmt(now)}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <Pagination><EntriesPerPage>50</EntriesPerPage><PageNumber>1</PageNumber></Pagination>
</GetOrdersRequest>`;

    const resp = await fetch(`${data.clawdbot_worker_url}/trading`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_name: "GetOrders", xml, token }),
    });

    if (!resp.ok) throw new Error(`GetOrders HTTP ${resp.status}`);

    const rawXml = await resp.text();
    const ack = getXmlText(rawXml, "Ack");
    if (ack === "Failure") {
      throw new Error(getXmlText(rawXml, "LongMessage") || "GetOrders failed");
    }

    const orderNodes = getXmlBlocks(getXmlText(rawXml, "OrderArray") || rawXml, "Order");
    const orders = [];

    orderNodes.forEach(orderNode => {
      const orderId = getXmlText(orderNode, "OrderID");
      const shipping = getXmlText(orderNode, "ShippingAddress");
      const lineItems = [];

      getXmlBlocks(getXmlText(orderNode, "TransactionArray") || orderNode, "Transaction").forEach(txn => {
        const item = getXmlText(txn, "Item");
        lineItems.push({
          itemId: getXmlText(item, "ItemID"),
          title: getXmlText(item, "Title"),
          quantity: parseInt(getXmlText(txn, "QuantityPurchased") || "1"),
        });
      });

      orders.push({
        orderId,
        orderStatus: getXmlText(orderNode, "OrderStatus"),
        total: parseFloat(getXmlText(orderNode, "Total") || "0"),
        createdTime: getXmlText(orderNode, "CreatedTime"),
        lineItems,
        buyer: {
          name: getXmlText(shipping, "Name"),
          address: getXmlText(shipping, "Street1"),
          address2: getXmlText(shipping, "Street2"),
          city: getXmlText(shipping, "CityName"),
          state: getXmlText(shipping, "StateOrProvince"),
          zip: getXmlText(shipping, "PostalCode"),
          country: getXmlText(shipping, "Country") || "US",
          phone: getXmlText(shipping, "Phone"),
        },
        buyerUserId: getXmlText(orderNode, "BuyerUserID"),
        fulfilled: false,
      });
    });

    const existingIds = new Set(data.ebay_orders.map(o => o.orderId));
    const newOrders = orders.filter(o => !existingIds.has(o.orderId));

    if (newOrders.length > 0) {
      await chrome.storage.local.set({ ebay_orders: [...newOrders, ...data.ebay_orders] });
      showNotification("🛒 New eBay Sales!", `${newOrders.length} new order(s) received.`);
    }

    return { newOrders: newOrders.length, total: orders.length };
  } catch (e) {
    console.error("PhiloShip Orders:", e);
    return { error: e.message };
  }
}

// ── Handle manual fulfill from popup ──────────────────────────────────────────
async function handleFulfillOrder(orderId) {
  const data = await chrome.storage.local.get({ ebay_orders: [], queue: [] });
  const order = data.ebay_orders.find(o => o.orderId === orderId);
  if (!order) throw new Error("Order not found: " + orderId);

  for (const lineItem of order.lineItems) {
    const queueItem = data.queue.find(p => p.ebayItemId === lineItem.itemId);
    if (!queueItem?.url) {
      throw new Error(`No Amazon URL for eBay item ${lineItem.itemId}`);
    }

    const fulfillment = {
      buyer: order.buyer,
      ebayOrderId: order.orderId,
      ebayItemId: lineItem.itemId,
      amazonUrl: queueItem.url,
      // Buy the SAME quantity the buyer ordered on eBay (was defaulting to 1).
      quantity: Math.max(1, parseInt(lineItem.quantity, 10) || 1),
      step: "add_to_cart",
      startedAt: Date.now(),
      attempts: 0,
    };

    await startAutoFulfill(fulfillment);
    return { success: true, orderId };
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function showNotification(title, body) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9IiNmZjZiMDAiLz48L3N2Zz4=",
      title,
      message: body,
    });
  } catch (e) {
    console.log(`[Notification] ${title}: ${body}`);
  }
}

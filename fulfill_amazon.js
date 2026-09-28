/**
 * fulfill_amazon.js — Multi-step Amazon Checkout Automation
 * 
 * Injected by background.js into Amazon tabs. Reads the current step
 * from chrome.storage "pendingFulfillment" and advances through:
 *   1. add_to_cart    — Click "Add to Cart" on product page
 *   2. go_to_cart     — Navigate to cart
 *   3. checkout       — Click "Proceed to checkout"
 *   4. fill_address   — Fill buyer's shipping address
 *   5. continue_ship  — Select shipping & continue
 *   6. mark_gift      — Mark as gift (hides invoice)
 *   7. place_order    — Click "Place your order"
 *   8. confirm        — Verify order placed, notify background
 * 
 * Each step handles one page state, then the background listener
 * re-injects this script after navigation.
 */

(async function () {
  "use strict";

  // Build stamp — confirm which version of the fulfillment script is live.
  console.log("ClawdBot Fulfill: build 2026-09-25-k loaded on", location.href.slice(0, 80));
  try { document.documentElement.setAttribute("data-philoship-fulfill", "2026-09-25-k"); } catch (e) {}

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // Prevent duplicate content-script passes from double-clicking during navigations.
  const RUN_GUARD_MS = 1500;
  const now = Date.now();
  if (window.__philoshipFulfillRunningAt && now - window.__philoshipFulfillRunningAt < RUN_GUARD_MS) {
    console.log("ClawdBot Fulfill: A recent fulfillment pass is still settling; skipping duplicate injection.");
    return;
  }
  window.__philoshipFulfillRunningAt = now;

  // Conservative automation timing: click once, wait for Amazon to settle,
  // and let the background worker re-inject after navigation.
  const CLICK_WAIT   = 1000;  // ms after every click
  const CHANGE_WAIT  = 2000;  // ms after input/change events
  const POLL_INTERVAL = 50;   // ms between existence checks
  const ELEM_TIMEOUT = 10000; // ms to wait for an element to appear

  async function waitForPageStable(quietMs = 900, timeoutMs = 12000) {
    if (document.readyState !== "complete") {
      await new Promise(resolve => {
        window.addEventListener("load", resolve, { once: true });
        setTimeout(resolve, timeoutMs);
      });
    }

    if (!document.body || !window.MutationObserver) {
      await wait(quietMs);
      return;
    }

    await new Promise(resolve => {
      let done = false;
      let quietTimer = null;
      let observer = null;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(quietTimer);
        observer?.disconnect();
        resolve();
      };

      const restartQuietTimer = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      observer = new MutationObserver(restartQuietTimer);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      restartQuietTimer();
      setTimeout(finish, timeoutMs);
    });
  }

  // Wait for a selector to appear in the checkout doc (iframe-aware)
  async function waitForEl(selector, timeoutMs = ELEM_TIMEOUT) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const el = qs(selector);
      if (el) return el;
      await wait(POLL_INTERVAL);
    }
    return null;
  }

  function isBuyNowLikeControl(el) {
    if (!el) return false;
    const bits = [
      el.id || "",
      typeof el.getAttribute === "function" ? el.getAttribute("name") || "" : "",
      typeof el.getAttribute === "function" ? el.getAttribute("aria-label") || "" : "",
      typeof el.getAttribute === "function" ? el.getAttribute("aria-labelledby") || "" : "",
      typeof el.getAttribute === "function" ? el.getAttribute("value") || "" : "",
      getControlText(el) || "",
    ].join(" ");
    return /buy\s*now/i.test(bits);
  }

  function isUsableBuyNowButton(el) {
    if (!el) return false;
    if (!isBuyNowLikeControl(el) && !el.matches('input#buy-now-button[name="submit.buy-now"], input[name="submit.buy-now"], #buyNow input[type="submit"]')) {
      return false;
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    // Amazon's a-button-input is often a 0x0 transparent overlay; the visible,
    // clickable element is the wrapping .a-button span. Accept the input if
    // either the input itself OR its button wrapper has a real size.
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    const wrapper = el.closest(".a-button, #buy-now-button, span.a-button-stack > span") ||
                    el.parentElement;
    if (wrapper) {
      const wrect = wrapper.getBoundingClientRect();
      if (wrect.width > 0 && wrect.height > 0) return true;
    }
    // Last resort: if it's the canonical buy-now input by id, treat as usable
    return el.id === "buy-now-button";
  }

  async function waitForExactBuyNowButton(timeoutMs = ELEM_TIMEOUT) {
    const selectors = [
      'input#buy-now-button[name="submit.buy-now"][type="submit"]',
      'input#buy-now-button[name="submit.buy-now"]',
      '#buyNow input[name="submit.buy-now"]',
      'input[name="submit.buy-now"]',
      'input[aria-labelledby*="buy-now"]',
      'input[value*="Buy Now"]',
      'button[aria-label*="Buy Now"]',
      'button[name*="buy-now"]'
    ];
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const el = queryAny(selectors);
      if (isUsableBuyNowButton(el)) return el;
      await wait(POLL_INTERVAL);
    }
    return null;
  }

  async function waitForCheckoutTransition(startHref, timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (location.href !== startHref || isCheckoutContext()) return true;
      await wait(100);
    }
    return false;
  }

  function describeElementForDebug(el) {
    if (!el) return "none";
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(el) : null;
    const centerX = rect ? Math.round(rect.left + rect.width / 2) : 0;
    const centerY = rect ? Math.round(rect.top + rect.height / 2) : 0;
    const topEl = rect ? document.elementFromPoint(centerX, centerY) : null;
    const form = el.form || (typeof el.closest === "function" ? el.closest("form") : null);
    const tagName = el.tagName ? el.tagName.toLowerCase() : "node";
    const topTagName = topEl && topEl.tagName ? topEl.tagName.toLowerCase() : "node";
    const formTagName = form && form.tagName ? form.tagName.toLowerCase() : "form";
    const rectText = rect
      ? Math.round(rect.width) + "x" + Math.round(rect.height) + "@" + Math.round(rect.left) + "," + Math.round(rect.top)
      : "none";
    const topText = topEl
      ? topTagName + "#" + (topEl.id || "") + "." + String(topEl.className || "").slice(0, 60)
      : "none";
    const formText = form ? formTagName + "#" + (form.id || "") : "none";
    return [
      tagName + "#" + (el.id || ""),
      "name=" + (typeof el.getAttribute === "function" ? el.getAttribute("name") || "" : ""),
      "type=" + (typeof el.getAttribute === "function" ? el.getAttribute("type") || "" : ""),
      "disabled=" + !!el.disabled,
      "ariaDisabled=" + (typeof el.getAttribute === "function" ? el.getAttribute("aria-disabled") || "" : ""),
      "rect=" + rectText,
      "display=" + (style ? style.display || "" : ""),
      "visibility=" + (style ? style.visibility || "" : ""),
      "pointer=" + (style ? style.pointerEvents || "" : ""),
      "topAtCenter=" + topText,
      "form=" + formText,
      "formAction=" + (el.formAction || (form ? form.action || "" : ""))
    ].join(" | ");
  }

  function getBuyNowDiagnostics() {
    const selectors = [
      'input#buy-now-button[name="submit.buy-now"][type="submit"]',
      'input#buy-now-button[name="submit.buy-now"]',
      '#buyNow input[name="submit.buy-now"]',
      'input[name="submit.buy-now"]',
      'input[aria-labelledby*="buy-now"]',
      'input[value*="Buy Now"]',
      'button[aria-label*="Buy Now"]',
      'button[name*="buy-now"]',
      '#add-to-cart-button',
      'input[name="submit.add-to-cart"]',
      '#buybox-see-all-buying-choices',
      '#availability'
    ];
    const counts = selectors.map(selector => `${selector}=${document.querySelectorAll(selector).length}`).join("; ");
    const candidate = queryAny([
      'input#buy-now-button[name="submit.buy-now"][type="submit"]',
      'input#buy-now-button[name="submit.buy-now"]',
      '#buyNow input[name="submit.buy-now"]',
      'input[name="submit.buy-now"]',
      'input[aria-labelledby*="buy-now"]',
      'input[value*="Buy Now"]',
      'button[aria-label*="Buy Now"]',
      'button[name*="buy-now"]'
    ]);
    const pageText = String((document.body && document.body.innerText) || "").toLowerCase();
    const signals = [
      "select a size", "select size", "select color", "select style",
      "currently unavailable", "see all buying options", "cannot be shipped",
      "enter the characters", "captcha", "dogs of amazon", "sign in"
    ].filter(signal => pageText.includes(signal));
    const diagnostics = [
      "url=" + location.href,
      "ready=" + document.readyState,
      "checkout=" + isCheckoutContext(),
      "counts=[" + counts + "]",
      "candidate=[" + describeElementForDebug(candidate) + "]",
      "signals=" + (signals.length ? signals.join(", ") : "none")
    ].join("\n");
    console.warn("ClawdBot Fulfill: Buy Now diagnostics\n" + diagnostics);
    return diagnostics;
  }

  async function clickExactBuyNowButton(el) {
    if (!isUsableBuyNowButton(el)) return false;
    const startHref = location.href;

    // Bounded, exception-safe humanization. This used to run unguarded before the
    // click — if any of these hung (or threw), the click never fired and the whole
    // fulfillment silently stalled on the product page. Cap the whole preamble at
    // 3s and never let it abort the click.
    try {
      await Promise.race([
        (async () => {
          await naturalScroll(window.scrollY + 100, 250);
          await humanPause(300, 700);
          await moveMouseTo(el);
          await humanPause(200, 400);
        })(),
        wait(3000),
      ]);
    } catch (_) { /* humanization is best-effort; proceed to the click regardless */ }

    // Amazon's a-button-input is a 0x0 overlay — the real clickable element is the
    // wrapping .a-button span. Click both: the wrapper (what a user clicks) and the
    // input (which carries the formaction).
    const wrapper = el.closest(".a-button") || el.parentElement;
    console.log("🔵 DIAG: clicking Buy Now now (wrapper+input)");
    try { el.focus?.(); } catch (_) {}
    if (wrapper && wrapper !== el) { try { wrapper.click(); } catch(_) {} }
    try { el.click(); } catch (_) {}
    if (await waitForCheckoutTransition(startHref, 6000)) return true;

    // Fallback: submit the form honoring the input's formaction (/checkout/entry/buynow)
    const form = el.form || el.closest?.("form");
    if (form) {
      try {
        if (form.requestSubmit) {
          form.requestSubmit(el);            // respects el.formAction
        } else {
          if (el.formAction) form.action = el.formAction;
          form.submit();
        }
      } catch (_) {
        // Last resort: navigate straight to the buynow entry point
        if (el.formAction) { location.href = el.formAction; }
      }
    } else if (el.formAction) {
      location.href = el.formAction;
    } else {
      el.click();
    }

    return waitForCheckoutTransition(startHref, 5000);
  }

  async function clickBuyNowButton(el) {
    if (!el) return false;
    if (isUsableBuyNowButton(el)) {
      return clickExactBuyNowButton(el);
    }

    const startHref = location.href;
    await naturalScroll(window.scrollY + 100, 250);
    await humanPause(300, 700);
    await moveMouseTo(el);
    await humanPause(200, 400);

    const form = el.form || el.closest?.("form");
    el.focus?.();
    try { el.click(); } catch (_) {}
    if (await waitForCheckoutTransition(startHref, 3500)) return true;

    if (form) {
      try {
        if (form.requestSubmit) {
          form.requestSubmit(el);
        } else {
          form.submit();
        }
      } catch (_) {}
      if (await waitForCheckoutTransition(startHref, 5000)) return true;
    }

    return false;
  }

  // Click once, then let the page respond before the next step.
  async function click(el) {
    if (!el) return;
    el.click();
    await wait(CLICK_WAIT);
  }

  // ── Human-like interaction helpers ──────────────────────────────────────────
  // (The sophisticated simulateHumanClick is defined later and overrides any
  // earlier alias; these movement/timing helpers back it. Previously these were
  // stubs — no mouse movement, no scroll, and a fixed 1000ms pause everywhere —
  // which is a classic automation fingerprint. Now implemented for real.)

  // Virtual cursor position, kept continuous across actions so movement paths
  // start from where the "cursor" last was.
  let _mouseX = Math.round(window.innerWidth * (0.3 + Math.random() * 0.4));
  let _mouseY = Math.round(window.innerHeight * (0.3 + Math.random() * 0.4));

  // Randomized pause in [min,max] ms (humans don't act on a fixed cadence).
  async function humanPause(min = 200, max = 600) {
    const lo = Math.max(0, Number(min) || 0);
    const hi = Math.max(lo + 1, Number(max) || lo + 1);
    await wait(lo + Math.random() * (hi - lo));
  }

  // Move the virtual cursor to an element along a curved path, dispatching
  // pointermove/mousemove events. Many bot detectors flag clicks that have no
  // preceding pointer movement.
  async function moveMouseTo(el) {
    try {
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const tx = r.left + r.width * (0.35 + Math.random() * 0.3);
      const ty = r.top + r.height * (0.35 + Math.random() * 0.3);
      const sx = _mouseX, sy = _mouseY;
      const steps = 12 + Math.floor(Math.random() * 12);
      // Quadratic-bezier control point for a natural curve.
      const cx = sx + (tx - sx) * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 90;
      const cy = sy + (ty - sy) * (0.3 + Math.random() * 0.4) + (Math.random() - 0.5) * 90;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, mt = 1 - t;
        const x = mt * mt * sx + 2 * mt * t * cx + t * t * tx;
        const y = mt * mt * sy + 2 * mt * t * cy + t * t * ty;
        const cxl = Math.max(0, Math.min(window.innerWidth - 1, x));
        const cyl = Math.max(0, Math.min(window.innerHeight - 1, y));
        const target = document.elementFromPoint(cxl, cyl) || document.body;
        const opts = {
          bubbles: true, cancelable: true, view: window,
          clientX: x, clientY: y, screenX: x + window.screenX, screenY: y + window.screenY,
          movementX: x - _mouseX, movementY: y - _mouseY,
        };
        try {
          target.dispatchEvent(new PointerEvent("pointermove", { ...opts, pointerId: 1, pointerType: "mouse" }));
          target.dispatchEvent(new MouseEvent("mousemove", opts));
        } catch (_) {}
        _mouseX = x; _mouseY = y;
        await wait(6 + Math.random() * 14);
      }
    } catch (_) {}
  }

  // Smoothly scroll to targetY with easing (instead of an instant jump).
  async function naturalScroll(targetY, duration = 350) {
    try {
      const startY = window.scrollY;
      const dist = (Number(targetY) || 0) - startY;
      if (Math.abs(dist) < 4) return;
      const steps = Math.max(6, Math.round((Number(duration) || 350) / 16));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
        window.scrollTo(0, Math.round(startY + dist * eased));
        await wait((Number(duration) || 350) / steps);
      }
    } catch (_) {}
  }
  const STATE_NAMES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
    HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
    KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
    MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
    MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
    NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
    OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
    DC: "District of Columbia", PR: "Puerto Rico"
  };

  const data = await chrome.storage.local.get(["pendingFulfillment", "pendingBuyer"]);
  const job = data.pendingFulfillment;
  const buyer = data.pendingBuyer;

  if (!job) {
    console.log("ClawdBot Fulfill: No pending fulfillment job.");
    return;
  }

  await waitForPageStable();

  const step = job.step;
  console.log(`ClawdBot Fulfill: Step = "${step}", URL = ${location.href}`);

  function isUrbanizationLine(value) {
    return /^\s*(?:urb\.?|urbanizaci[oó]n)\b/i.test(String(value || "").trim());
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

  function normalizeAddressPieceText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function looksLikePuertoRicoCityPart(value) {
    const text = String(value || "").trim();
    return !!text &&
      !isUrbanizationLine(text) &&
      !/\d/.test(text) &&
      !/\b(?:box|bo\.?|barrio|urb\.?|urbanizaci[oó]n|calle|ave|avenida|road|rd|street|st|drive|dr|lane|ln)\b/i.test(text);
  }

  function getBuyerForAmazonAddress(rawBuyer) {
    const normalized = { ...(rawBuyer || {}) };
    normalized.urbanization = String(normalized.urbanization || "").trim();
    normalized.address = String(normalized.address || "").trim();
    normalized.address2 = String(normalized.address2 || "").trim();
    const state = String(normalized.state || "").trim().toUpperCase();
    const zip = String(normalized.zip || "").trim();
    const isPuertoRico = state === "PR" || /^00[679]|^009/.test(zip);

    if (isPuertoRico) {
      if (normalized.address.includes(",")) {
        const addressParts = normalized.address.split(",").map(part => part.trim()).filter(Boolean);
        const lastPart = addressParts[addressParts.length - 1] || "";
        if (normalized.city && normalizeAddressPieceText(lastPart) === normalizeAddressPieceText(normalized.city)) {
          normalized.address = addressParts.slice(0, -1).join(", ");
        } else if (!normalized.city && addressParts.length > 1 && looksLikePuertoRicoCityPart(lastPart)) {
          normalized.city = lastPart;
          normalized.address = addressParts.slice(0, -1).join(", ");
        }
      }

      normalized.urbanization = combineUniqueAddressParts(
        normalized.urbanization,
        normalized.address,
        normalized.address2
      );
      normalized.address = "";
      normalized.address2 = "";
    }

    return normalized;
  }

  async function typeHuman(el, text) {
    if (!el) return false;
    // Focus the field like a human would
    await simulateHumanClick(el);
    await wait(40 + Math.random() * 80);

    // Clear existing value
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(20 + Math.random() * 40);

    // Type character by character with variable speed
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const keyOpts = { bubbles: true, cancelable: true, key: char, code: "Key" + char.toUpperCase(), charCode: char.charCodeAt(0) };
      el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
      await wait(5 + Math.random() * 15);
      el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));

      // Use the native input setter so page frameworks receive normal input events.
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text.substring(0, i + 1));
      else el.value = text.substring(0, i + 1);

      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
      await wait(5 + Math.random() * 15);
      el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));

      // Variable typing speed: occasional pauses
      if (Math.random() < 0.1) await wait(40 + Math.random() * 80);
      else await wait(10 + Math.random() * 30);
    }

    await wait(20 + Math.random() * 40);
    return true;
  }

  function setField(el, value) {
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    )?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function selectByText(sel, text) {
    if (!sel || !text) return false;
    const raw = text.trim();
    const upper = raw.toUpperCase();
    const expanded = (STATE_NAMES[upper] || raw).toUpperCase();
    const opt = Array.from(sel.options).find(o =>
      o.value.toUpperCase() === upper ||
      o.value.toUpperCase() === expanded ||
      o.text.toUpperCase() === upper ||
      o.text.toUpperCase() === expanded ||
      o.text.toUpperCase().includes(upper) ||
      o.text.toUpperCase().includes(expanded) ||
      upper.includes(o.value.toUpperCase()) ||
      expanded.includes(o.value.toUpperCase())
    );
    if (opt) {
      sel.focus?.();
      sel.value = opt.value;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }
    return false;
  }

  function getSelectedText(sel) {
    if (!sel || !sel.options) return "";
    const option = sel.options[sel.selectedIndex];
    return String(option?.textContent || option?.value || "").trim();
  }

  function findStateSelect(root = document) {
    const exactPopoverMatch = document.querySelector('.a-popover select[name="address-ui-widgets-enterAddressStateOrRegion"]');
    if (exactPopoverMatch) return exactPopoverMatch;
    return queryAny([
      'select[name="address-ui-widgets-enterAddressStateOrRegion"]',
      '.a-popover select[id*="address-ui-widgets-enterAddressStateOrRegion"]',
      'select[id*="address-ui-widgets-enterAddressStateOrRegion"]',
      '.a-popover select[aria-label*="State"]',
      '.a-popover select[aria-label*="Province"]',
      'select[aria-label*="State"]',
      'select[aria-label*="Province"]'
    ], root);
  }

  async function waitForStateSelect(timeoutMs = 6000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const select = findStateSelect(document);
      if (select && select.tagName === "SELECT" && !select.disabled && select.options.length > 1) {
        return select;
      }
      await wait(300);
    }
    return findStateSelect(document);
  }

  async function setStateFromReferenceLogic(state) {
    const select = await waitForStateSelect();
    if (!select || select.tagName !== "SELECT") return false;

    const stateCode = String(state || "").trim().toUpperCase();
    const stateName = STATE_NAMES[stateCode] || String(state || "").trim();
    const options = Array.from(select.options || []);
    const option = options.find(opt => {
      const value = String(opt.value || "").trim().toUpperCase();
      const text = String(opt.textContent || "").trim().toUpperCase();
      return value === stateCode ||
        value === stateName.toUpperCase() ||
        text === stateCode ||
        text === stateName.toUpperCase() ||
        text.includes(stateName.toUpperCase());
    });

    if (!option) return false;

    select.focus?.();
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("blur", { bubbles: true }));
    await wait(800);

    const selectedValue = String(select.value || "").trim().toUpperCase();
    const selectedText = getSelectedText(select).toUpperCase();
    return selectedValue === String(option.value || "").trim().toUpperCase() ||
      selectedText === String(option.textContent || "").trim().toUpperCase() ||
      selectedText.includes(stateName.toUpperCase());
  }

  async function simulateHumanClick(el) {
    if (!el) return;

    // Scroll the element into the viewport naturally before approaching it
    const rect0 = el.getBoundingClientRect();
    const offscreen = rect0.top < 0 || rect0.bottom > window.innerHeight;
    if (offscreen) {
      const scrollTarget = window.scrollY + rect0.top - window.innerHeight * 0.4;
      await naturalScroll(Math.max(0, scrollTarget), 350 + Math.random() * 200);
      await humanPause(150, 350);
    }

    // Move mouse along a natural curve toward the element
    await moveMouseTo(el);
    await humanPause(80, 200);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width  * (0.3 + Math.random() * 0.4);
    const y = rect.top  + rect.height * (0.3 + Math.random() * 0.4);
    const commonOpts = {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, screenX: x + window.screenX,
      screenY: y + window.screenY, button: 0,
    };

    el.dispatchEvent(new PointerEvent("pointerover",  { ...commonOpts, pointerId: 1, pointerType: "mouse" }));
    await wait(10 + Math.random() * 20);
    el.dispatchEvent(new PointerEvent("pointerenter", { ...commonOpts, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseover",  commonOpts));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...commonOpts, bubbles: false }));
    await wait(40 + Math.random() * 80);  // human hover dwell time

    el.dispatchEvent(new PointerEvent("pointerdown", { ...commonOpts, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", commonOpts));
    if (el.focus) el.focus();
    await wait(30 + Math.random() * 60);  // hold duration before release

    el.dispatchEvent(new PointerEvent("pointerup", { ...commonOpts, pointerId: 1, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup",    commonOpts));
    await wait(8 + Math.random() * 20);
    el.dispatchEvent(new MouseEvent("click",      commonOpts));
  }

  async function selectStateFromPopup(state) {
    const raw = String(state || "").trim();
    if (!raw) return false;
    const upper = raw.toUpperCase();
    const expanded = (STATE_NAMES[upper] || raw).trim();

    // Build list of acceptable state name matches
    const wanted = [...new Set([raw, upper, expanded, expanded.toUpperCase()]
      .map(v => String(v || "").trim().toUpperCase())
      .filter(Boolean))];

    console.log("ClawdBot Fulfill: Selecting state via popup. Input:", raw, "Expanded:", expanded, "Wanted:", wanted);

    // Step 1: Find and click the dropdown opener (Amazon uses a custom span/div dropdown, not a native select)
    const openerSelectors = [
      '#address-ui-widgets-enterAddressStateOrRegion .a-button-input',
      '#address-ui-widgets-enterAddressStateOrRegion .a-button-text',
      '#address-ui-widgets-enterAddressStateOrRegion .a-dropdown-prompt',
      '#address-ui-widgets-enterAddressStateOrRegion',
      '#address-ui-widgets-enterAddressStateOrRegion-dropdown-nativeId',
      'span[id*="enterAddressStateOrRegion"] .a-button-input',
      'span[id*="enterAddressStateOrRegion"] .a-button-text',
      'span[id*="enterAddressStateOrRegion"] .a-dropdown-prompt',
      'span[id*="enterAddressStateOrRegion"]',
      '[data-a-class*="stateOrRegion"]',
      '.a-popover-wrapper [aria-label*="State"] .a-button-input',
      '.a-popover-wrapper [aria-label*="State"]',
      '[aria-labelledby*="StateOrRegion"]',
      '[aria-labelledby*="stateOrRegion"]',
      '[aria-label*="State"]',
      'button[name*="stateOrRegion"]',
      '[data-testid*="stateOrRegion"]',
      '[data-testid*="StateOrRegion"]'
    ];

    let opener = null;
    for (const sel of openerSelectors) {
      opener = document.querySelector(sel);
      if (opener && opener.tagName !== "SELECT") break;
      opener = null;
    }

    if (!opener) {
      console.log("ClawdBot Fulfill: No state dropdown opener found");
      return false;
    }

    console.log("ClawdBot Fulfill: Found state dropdown opener:", opener.tagName, opener.id || opener.className);

    // Click the opener to open the popover dropdown
    await simulateHumanClick(opener);
    await wait(600 + Math.random() * 400);

    // Step 2: Wait for popover to appear
    let popover = null;
    for (let i = 0; i < 10; i++) {
      popover = document.querySelector('.a-popover:not([aria-hidden="true"])') ||
                document.querySelector('.a-popover-visible') ||
                document.querySelector('.a-popover[style*="visibility: visible"]');
      if (popover) break;
      // Try clicking again if popover didn't open
      if (i === 3) await simulateHumanClick(opener);
      await wait(400);
    }

    if (!popover) {
      console.log("ClawdBot Fulfill: State popover did not open, trying direct click on opener");
      opener.click();
      await wait(1500);
      popover = document.querySelector('.a-popover:not([aria-hidden="true"])');
    }

    // Step 3: Find and click the matching state option in the popover
    const optionSelectors = [
      '.a-popover:not([aria-hidden="true"]) a',
      '.a-popover:not([aria-hidden="true"]) li a',
      '.a-popover:not([aria-hidden="true"]) li',
      '.a-popover:not([aria-hidden="true"]) [role="option"]',
      '.a-popover:not([aria-hidden="true"]) button',
      '.a-popover-wrapper a[id*="enterAddressStateOrRegion"]',
      'a[id*="address-ui-widgets-enterAddressStateOrRegion"]',
      '[role="listbox"] [role="option"]',
      'ul[role="listbox"] li a',
      'ul[role="listbox"] li',
      'li[aria-selected] a',
      'li[aria-selected]'
    ];

    const allOptions = Array.from(document.querySelectorAll(optionSelectors.join(", ")));
    console.log("ClawdBot Fulfill: Found", allOptions.length, "state options in popover");

    let matchedOption = null;

    // Priority 1: Match by data-value attribute (2-letter state code) — most reliable
    for (const node of allOptions) {
      const dv = node.getAttribute("data-value") || "";
      try {
        const parsed = JSON.parse(dv);
        if (parsed && parsed.stringVal && parsed.stringVal.toUpperCase() === upper) {
          matchedOption = node;
          break;
        }
      } catch(e) {
        if (dv.toUpperCase() === upper) { matchedOption = node; break; }
      }
    }

    // Priority 2: Match by link inside li with data-value
    if (!matchedOption) {
      const dvLinks = document.querySelectorAll('a.a-dropdown-link[data-value]');
      for (const link of dvLinks) {
        try {
          const parsed = JSON.parse(link.getAttribute("data-value") || "");
          if (parsed && parsed.stringVal && parsed.stringVal.toUpperCase() === upper) {
            matchedOption = link;
            break;
          }
        } catch(e) {}
      }
    }

    // Priority 3: Exact text match
    if (!matchedOption) {
      for (const node of allOptions) {
        const text = (node.innerText || node.textContent || "").trim().toUpperCase();
        if (!text) continue;
        if (wanted.includes(text)) { matchedOption = node; break; }
      }
    }

    // Priority 4: Partial text match
    if (!matchedOption) {
      for (const node of allOptions) {
        const text = (node.innerText || node.textContent || "").trim().toUpperCase();
        if (!text) continue;
        if (wanted.some(w => text.includes(w) || w.includes(text))) { matchedOption = node; break; }
      }
    }

    if (matchedOption) {
      console.log("ClawdBot Fulfill: Found state option:", matchedOption.innerText || matchedOption.textContent);
      // Scroll the option into view before clicking (handles long scrollable lists)
      matchedOption.scrollIntoView({ behavior: "instant", block: "center" });
      await wait(200);
      // Ensure the parent li is also visible
      const parentLi = matchedOption.closest("li");
      if (parentLi) parentLi.scrollIntoView({ behavior: "instant", block: "center" });
      await wait(150);
      console.log("ClawdBot Fulfill: Clicking state option after scroll");
      await simulateHumanClick(matchedOption);
      await wait(1000);
      return true;
    }

    console.log("ClawdBot Fulfill: No matching state option found for:", wanted);
    return false;
  }

  function click(selector) {
    const el = typeof selector === "string"
      ? document.querySelector(selector)
      : selector;
    if (el) { el.click(); return true; }
    return false;
  }

  function queryAny(selectors, root = document) {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function normalizeFillLockText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function getAddressFillLockKey(amazonBuyer) {
    return [
      job.ebayOrderId || "",
      job.ebayItemId || "",
      job.amazonAsin || "",
      normalizeFillLockText(amazonBuyer?.name),
      normalizeFillLockText(amazonBuyer?.address),
      normalizeFillLockText(amazonBuyer?.city),
      normalizeFillLockText(amazonBuyer?.zip)
    ].join("|");
  }

  function addressFormAlreadyHasBuyerData(amazonBuyer) {
    const nameInput = queryAny([
      '#address-ui-widgets-enterAddressFullName',
      '[name="address-ui-widgets-enterAddressFullName"]',
      'input[name*="fullName"]'
    ]);
    const addressInput = queryAny([
      '#address-ui-widgets-enterAddressLine1',
      'input[name*="addressLine1"]'
    ]);
    const zipInput = queryAny([
      '#address-ui-widgets-enterAddressPostalCode',
      'input[name*="postalCode"]'
    ]);

    const expectedName = normalizeFillLockText(amazonBuyer?.name);
    const expectedAddress = normalizeFillLockText(amazonBuyer?.address || amazonBuyer?.urbanization);
    const expectedZip = normalizeFillLockText(amazonBuyer?.zip);

    const currentName = normalizeFillLockText(nameInput?.value);
    const currentAddress = normalizeFillLockText(addressInput?.value);
    const currentZip = normalizeFillLockText(zipInput?.value);

    return !!(
      (expectedName && currentName === expectedName) ||
      (expectedAddress && currentAddress === expectedAddress) ||
      (expectedZip && currentZip === expectedZip)
    );
  }

  function claimAddressFormFill(amazonBuyer) {
    const key = getAddressFillLockKey(amazonBuyer);
    const now = Date.now();
    const lockKey = document.documentElement.getAttribute("data-philoship-address-fill-key") || "";
    const lockAt = parseInt(document.documentElement.getAttribute("data-philoship-address-fill-at") || "0", 10);
    if (lockKey === key && now - lockAt < 15000 && addressFormAlreadyHasBuyerData(amazonBuyer)) {
      console.log("ClawdBot Fulfill: Address form already has buyer data; skipping duplicate fill.");
      return false;
    }
    document.documentElement.setAttribute("data-philoship-address-fill-key", key);
    document.documentElement.setAttribute("data-philoship-address-fill-at", String(now));
    return true;
  }

  function looksLikeAsin(value) {
    return /^B0[A-Z0-9]{8}$/i.test(String(value || "").trim());
  }

  function normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function isUsefulSearchTerm(value) {
    const text = String(value || "").trim();
    if (!text || text.length < 3) return false;
    if (/^\(?\s*(?:sku|custom label|custom sku)\s*\)?\s*:?\s*$/i.test(text)) return false;
    return /[A-Z0-9]/i.test(text);
  }

  function getCurrentPageAsin() {
    // IMPORTANT: do NOT use a bare [data-asin] selector — product pages have many
    // elements with data-asin (sponsored/related products), and querySelector
    // returns the FIRST in DOM order, which is usually NOT the main product.
    // Prefer the hidden ASIN inputs and the URL, which always reflect the main item.

    // 1. Hidden form inputs (most reliable on a product page)
    const inputCandidates = [
      document.querySelector("#ASIN")?.value,
      document.querySelector('input[name="ASIN"]')?.value,
      document.querySelector('input[name="ASIN.0"]')?.value,
      document.querySelector('#addToCart input[name="ASIN.0"]')?.value,
      document.querySelector('#buybox input[name="ASIN.0"]')?.value,
    ];
    for (const candidate of inputCandidates) {
      const value = String(candidate || "").trim().toUpperCase();
      if (looksLikeAsin(value)) return value;
    }

    // 2. From the URL itself (/dp/ASIN or /gp/product/ASIN)
    const urlMatch = location.href.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    if (urlMatch && looksLikeAsin(urlMatch[1].toUpperCase())) return urlMatch[1].toUpperCase();

    // 3. Main product container's data-asin (scoped to known product wrappers)
    const scopedAsin =
      document.querySelector('#dp[data-asin]')?.getAttribute("data-asin") ||
      document.querySelector('#dp-container [data-asin]')?.getAttribute("data-asin") ||
      document.querySelector('#ppd [data-asin]')?.getAttribute("data-asin") ||
      document.querySelector('#centerCol [data-asin]')?.getAttribute("data-asin");
    const scopedValue = String(scopedAsin || "").trim().toUpperCase();
    if (looksLikeAsin(scopedValue)) return scopedValue;

    return "";
  }

  function isCheckoutContext() {
    const text = document.body.innerText || "";
    return location.href.includes("/buy/") ||
      location.href.includes("/checkout/") ||
      !!document.querySelector('#address-ui-widgets-enterAddressFullName, input[name*="fullName"]') ||
      !!document.querySelector('#paymentMethod, #submitOrderButtonId, #bottomSubmitOrderButtonId') ||
      text.includes("Shipping address") ||
      text.includes("Payment method") ||
      text.includes("Place your order");
  }

  function inferCheckoutStepFromPage() {
    const text = (getCheckoutDoc().body || document.body).innerText || "";
    if (qs('#placeOrder') ||
        qs('#submitOrderButtonId input') ||
        qs('input[name="placeYourOrder1"]') ||
        text.includes("Place your order")) {
      return "place_order";
    }
    if (qs('#paymentMethod') || text.includes("Payment method")) {
      return "mark_gift";
    }
    if (qs('#address-ui-widgets-enterAddressFullName') ||
        qs('input[name*="fullName"]') ||
        text.includes("Add a new address") ||
        text.includes("Shipping address")) {
      return "fill_address";
    }
    if (qs('#checkout-primary-continue-button-id') ||
        location.href.includes("/buy/") ||
        location.href.includes("/checkout/")) {
      return "continue_ship";
    }
    return "";
  }

  function clickByTextMatch(matchers, scope = document) {
    const wanted = matchers.map(value => String(value || "").toLowerCase());
    const nodes = scope.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]');
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || node.value || node.getAttribute("aria-label") || "").trim().toLowerCase();
      if (!text) continue;
      if (isLanguageChoiceControl(node)) continue;
      if (wanted.some(matcher => text === matcher || text.includes(matcher))) {
        node.click();
        return true;
      }
    }
    return false;
  }

  function getControlText(node) {
    return (node?.innerText || node?.textContent || node?.value || node?.getAttribute?.("aria-label") || "").trim();
  }

  function isLanguageChoiceControl(node) {
    const text = getControlText(node).toLowerCase();
    if (!text) return false;
    if (/continue\s+in\s+(english|español|spanish)/i.test(text)) return true;
    if (/\b(english|español|spanish|language|idioma)\b/i.test(text) &&
        !/\b(checkout|order|shipping|address|payment|gift)\b/i.test(text)) return true;
    return false;
  }

  async function waitForSafeContinueButton(timeoutMs = 3000, scope = getCheckoutDoc()) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const button = Array.from(scope.querySelectorAll('input[type="submit"], input[type="button"], button[type="submit"], button'))
        .find(el => /continue/i.test(getControlText(el)) && !isLanguageChoiceControl(el));
      if (button) return button;
      await wait(250);
    }
    return null;
  }

  // ── TURBO CHECKOUT IFRAME SUPPORT ─────────────────────────────────────────
  // Amazon's modern checkout renders inside #turbo-checkout-frame (an iframe).
  // All querySelector calls for checkout steps use getCheckoutDoc() so they
  // search the iframe document when present, falling back to the main page.
  function getCheckoutDoc() {
    const frame = document.getElementById("turbo-checkout-frame") ||
                  document.querySelector("iframe[name='turbo-checkout-frame']");
    if (frame) {
      try {
        const fd = frame.contentDocument || frame.contentWindow?.document;
        if (fd && fd.readyState !== "loading") return fd;
      } catch (_) { /* cross-origin guard */ }
    }
    return document;
  }

  function qs(selector)    { return getCheckoutDoc().querySelector(selector);    }
  function qsAll(selector) { return getCheckoutDoc().querySelectorAll(selector); }

  // Wait for turbo-checkout-frame to finish loading (if present)
  async function waitForCheckoutReady(timeoutMs = 10000) {
    const frame = document.getElementById("turbo-checkout-frame");
    if (!frame) return;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const fd = frame.contentDocument || frame.contentWindow?.document;
        if (fd && fd.readyState === "complete") return;
      } catch (_) {}
      await wait(200);
    }
  }

  function handleCommonInterstitials() {
    // ── "Review order" grayed-out offers page ─────────────────────────────
    // When Amazon shows a grayed-out "next step" / offers interstitial, it
    // renders a "Review order" link with data-args="redirectReason=spcChangeClicked".
    // Clicking it goes to the SPC review page where we can proceed to checkout.
    const reviewOrderLink =
      document.querySelector('a[data-args="redirectReason=spcChangeClicked"]') ||
      document.querySelector('a[data-topage="spc"].expand-panel-button') ||
      document.querySelector('a[href*="spc?"][href*="spcChangeClicked"]') ||
      Array.from(document.querySelectorAll("a")).find(a =>
        /review\s+order/i.test(a.textContent) && a.href?.includes("spc")
      );
    if (reviewOrderLink) {
      console.log("ClawdBot Fulfill: Grayed-out page — clicking 'Review order'");
      reviewOrderLink.click();
      return true;
    }

    const clickSelectors = [
      'input[name="proceedToRetailCheckout"]',
      '#hlb-ptc-btn-native',
      '#sc-buy-box-ptc-button input',
      'a[href*="/buy/checkout"]'
    ];

    for (const selector of clickSelectors) {
      const element = document.querySelector(selector) || qs(selector);
      if (element) {
        element.click();
        return true;
      }
    }

    return clickByTextMatch([
      "continue to checkout",
      "proceed to checkout"
    ]);
  }

  function findMatchingSearchResult() {
    const targetAsin = String(job.amazonAsin || "").trim().toUpperCase();
    const targetTitle = normalizeText(job.itemTitle || job.amazonSearchTerm || "");
    const results = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));

    for (const result of results) {
      if (result.innerText.includes("Sponsored") || result.querySelector(".puis-sponsored-label-text")) {
        continue;
      }

      const asin = String(result.getAttribute("data-asin") || "").trim().toUpperCase();
      const link = result.querySelector('[data-cy="title-recipe"] a.a-link-normal, h2 a.a-link-normal');
      const title = normalizeText(link?.textContent || result.querySelector("h2")?.textContent || "");

      if (targetAsin && asin === targetAsin && link) return link;
      if (targetTitle && title && (title.includes(targetTitle.slice(0, 24)) || targetTitle.includes(title.slice(0, 24))) && link) {
        return link;
      }
    }

    return null;
  }

  function extractDeliveryEstimate() {
    // Normalize page text — collapse whitespace but keep on one line
    const text = document.body.innerText.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");

    const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
    const DAYS   = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun";

    // A date token: optional "DayName, " prefix + MonthName + day number + optional year
    // e.g. "Monday, May 6"  |  "May 6"  |  "May 6, 2025"
    const DATE_TOKEN = `(?:(?:${DAYS}),\\s+)?(${MONTHS})\\s+(\\d{1,2})(?:,\\s+(\\d{4}))?`;

    // Trigger phrases that precede the date on Amazon confirmation/order pages
    const TRIGGERS = [
      "arriving(?:\\s+by|\\s+on)?",
      "get\\s+it\\s+by",
      "estimated\\s+delivery(?:\\s+date)?[:\\s]",
      "delivery(?:\\s+date)?[:\\s]",
      "your\\s+order\\s+will\\s+arrive(?:\\s+by)?",
      "expected\\s+delivery[:\\s]",
    ].join("|");

    const scanRe = new RegExp(
      `(?:${TRIGGERS})\\s*${DATE_TOKEN}`,
      "gi"
    );

    const candidates = [];
    let m;
    while ((m = scanRe.exec(text)) !== null) {
      const monthStr = m[1];  // capture group 1 = month name
      const dayNum   = parseInt(m[2], 10);
      const yearNum  = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
      const monthIdx = new Date(`${monthStr} 1 2000`).getMonth(); // reliable parse
      if (isNaN(monthIdx) || isNaN(dayNum)) continue;

      const date = new Date(yearNum, monthIdx, dayNum);
      // Sanity-check: must be within 90 days from today
      const now = Date.now();
      if (date.getTime() < now - 86400000 || date.getTime() > now + 90 * 86400000) continue;

      const label = m[3]
        ? `${monthStr} ${dayNum}, ${yearNum}`
        : `${monthStr} ${dayNum}`;
      candidates.push({ date, label });
    }

    if (candidates.length === 0) return "";

    // Amazon sometimes shows a range ("May 6 – May 8") — always report the EARLIEST date
    candidates.sort((a, b) => a.date - b.date);
    return candidates[0].label;
  }

  function getAmazonOrderConfirmation() {
    const pageText = (document.body.innerText || "").toLowerCase();
    const html = document.body.innerHTML || "";
    const url = location.href.toLowerCase();
    const amazonOrderId =
      (pageText.match(/order\s*#?\s*(\d{3}-\d{7}-\d{7})/i) ||
       html.match(/(\d{3}-\d{7}-\d{7})/) ||
       [])[1] || "";
    const confirmedByUrl =
      url.includes("/thankyou") ||
      url.includes("/confirmation") ||
      url.includes("/order-confirmation") ||
      url.includes("/gp/buy/thankyou");
    const confirmedByText =
      pageText.includes("order placed") ||
      pageText.includes("order has been placed") ||
      pageText.includes("thank you for your order") ||
      pageText.includes("your order is confirmed") ||
      pageText.includes("order confirmation");

    return {
      confirmed: confirmedByUrl || confirmedByText,
      amazonOrderId,
    };
  }

  async function notifyFulfillmentCompleteFromConfirmation(reason = "confirmation-detected") {
    if (window.__philoshipFulfillmentCompleteSent || job.fulfillmentCompleteNotified) return true;
    if (!["place_order", "confirm", "confirm_order"].includes(job.step) && !job.manualPlaceOrderRequired) {
      return false;
    }

    const confirmation = getAmazonOrderConfirmation();
    if (!confirmation.confirmed) return false;

    window.__philoshipFulfillmentCompleteSent = true;
    job.fulfillmentCompleteNotified = true;
    await chrome.storage.local.set({ pendingFulfillment: job });
    console.log("ClawdBot Fulfill: ✅ ORDER CONFIRMED!", reason);
    chrome.runtime.sendMessage({
      action: "fulfill_complete",
      ebayOrderId: job.ebayOrderId,
      ebayItemId: job.ebayItemId,
      amazonOrderId: confirmation.amazonOrderId,
      deliveryEstimate: extractDeliveryEstimate(),
    });
    return true;
  }

  function findPlaceOrderButton() {
    return qs('#placeOrder') ||
      qs('#submitOrderButtonId input') ||
      qs('#bottomSubmitOrderButtonId input') ||
      qs('input[name="placeYourOrder1"]') ||
      qs('[name="submit.place-your-order"]') ||
      qs('#placeYourOrder input') ||
      qs('.place-your-order-button input') ||
      Array.from(qsAll('input[type="submit"], button'))
        .find(el => /place.*order|submit.*order/i.test(getControlText(el)));
  }

  function getFulfillmentQuantity() {
    const quantity = parseInt(job.quantity || job.orderQuantity || job.ebayQuantity || 1, 10);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  }

  async function setAmazonQuantity(quantity) {
    const value = String(getFulfillmentQuantity());
    if (value === "1") return true;

    const selectors = [
      '#quantity',
      'select[name="quantity"]',
      'input[name="quantity"]',
      '#quantityDropdown',
      '[name="quantityBox"]'
    ];
    const control = selectors.map(selector => document.querySelector(selector)).find(Boolean);
    if (!control) {
      console.warn("ClawdBot Fulfill: Amazon quantity control not found; wanted", value);
      return false;
    }

    scrollIntoView(control);
    if (control.tagName === "SELECT") {
      const option = Array.from(control.options || []).find(opt => opt.value === value || opt.textContent.trim() === value);
      if (option) {
        control.value = option.value;
        control.dispatchEvent(new Event("change", { bubbles: true }));
        await wait(1000);
        console.log("ClawdBot Fulfill: Amazon quantity set to", value);
        return true;
      }
    } else {
      control.focus?.();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter ? setter.call(control, value) : (control.value = value);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "End" }));
      await wait(1000);
      console.log("ClawdBot Fulfill: Amazon quantity set to", value);
      return true;
    }

    console.warn("ClawdBot Fulfill: Requested quantity option unavailable:", value);
    return false;
  }

  function isAmazonRobotCheckPage() {
    const text = document.body.innerText.toLowerCase();
    return text.includes("enter the characters you see below") ||
      text.includes("type the characters you see in this image") ||
      text.includes("sorry, we just need to make sure you're not a robot") ||
      text.includes("to discuss automated access to amazon data please contact") ||
      text.includes("robot check") ||
      location.href.toLowerCase().includes("/errors/validatecaptcha");
  }

  if (isAmazonRobotCheckPage()) {
    console.warn("ClawdBot Fulfill: Amazon robot check detected. Pausing automation.");
    const shouldNotify = !job.pausedForManualIntervention ||
      job.pauseReason !== "robot_check" ||
      Date.now() - (job.lastManualNoticeAt || 0) > 60000;
    job.pausedForManualIntervention = true;
    job.pauseReason = "robot_check";
    job.lastManualNoticeAt = Date.now();
    await chrome.storage.local.set({ pendingFulfillment: job });
    if (shouldNotify) {
      chrome.runtime.sendMessage({
        action: "fulfill_manual_intervention",
        reason: "Amazon presented a robot check or temporary block page. Solve it manually in the Amazon tab; PhiloShip will continue after the page changes.",
        job,
      });
    }
    return;
  }

  if (job.pausedForManualIntervention && job.pauseReason === "robot_check") {
    delete job.pausedForManualIntervention;
    delete job.pauseReason;
    delete job.lastManualNoticeAt;
    await chrome.storage.local.set({ pendingFulfillment: job });
  }

  if (await notifyFulfillmentCompleteFromConfirmation("early-page-guard")) {
    return;
  }

  async function notifyManualIntervention(reason, pauseReason = "place_order") {
    const shouldNotify = !job.pausedForManualIntervention ||
      job.pauseReason !== pauseReason ||
      Date.now() - (job.lastManualNoticeAt || 0) > 60000;
    job.pausedForManualIntervention = true;
    job.pauseReason = pauseReason;
    job.lastManualNoticeAt = Date.now();
    await chrome.storage.local.set({ pendingFulfillment: job });
    if (shouldNotify) {
      chrome.runtime.sendMessage({
        action: "fulfill_manual_intervention",
        reason,
        job,
      });
    }
  }

  function isAmazonDogOrBlockedPage(pageText = document.body.innerText.toLowerCase()) {
    return pageText.includes("dogs of amazon") ||
      pageText.includes("we couldn't find that page") ||
      pageText.includes("sorry we couldn't find that page") ||
      location.href.toLowerCase().includes("/errors/404");
  }

  async function advanceTo(nextStep) {
    job.step = nextStep;
    job.attempts = 0;
    if (nextStep !== "place_order") {
      delete job.manualPlaceOrderRequired;
      delete job.manualPlaceOrderUrl;
      delete job.pausedForManualIntervention;
      delete job.pauseReason;
      delete job.lastManualNoticeAt;
    }
    await chrome.storage.local.set({ pendingFulfillment: job });
    console.log(`ClawdBot Fulfill: → Advanced to "${nextStep}"`);
  }

  async function retryOrFail(msg) {
    job.attempts = (job.attempts || 0) + 1;
    if (job.attempts > 5) {
      console.error(`ClawdBot Fulfill: FAILED after 5 attempts at step "${step}": ${msg}`);
      chrome.runtime.sendMessage({ action: "fulfill_failed", reason: msg, job });
      await chrome.storage.local.remove("pendingFulfillment");
      return;
    }
    await chrome.storage.local.set({ pendingFulfillment: job });
    console.warn(`ClawdBot Fulfill: Retry ${job.attempts}/5 at "${step}": ${msg}`);
    // Background will re-inject after a delay
    chrome.runtime.sendMessage({ action: "fulfill_retry", job });
  }

  function showManualPlaceOrderBanner(placeBtn) {
    document.getElementById("philoship-manual-place-order")?.remove();

    const banner = document.createElement("div");
    banner.id = "philoship-manual-place-order";
    banner.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "left:16px",
      "right:16px",
      "top:16px",
      "max-width:860px",
      "margin:0 auto",
      "padding:16px 18px",
      "background:#7f1d1d",
      "color:#fff",
      "font:15px/1.45 Arial,sans-serif",
      "border:3px solid #fbbf24",
      "border-radius:10px",
      "box-shadow:0 14px 40px rgba(0,0,0,.45)",
      "text-align:left",
      "cursor:default"
    ].join(";");
    banner.innerHTML = `
      <strong style="display:block;margin-bottom:6px;font-size:17px;">Action needed: click Place your order manually</strong>
      <span>PhiloShip is paused on purpose. Review the Amazon order, then click Amazon's <b>Place your order</b> button yourself. After the confirmation page loads, PhiloShip will resume and update the eBay order.</span>
      <button id="philoship-scroll-place-order" style="display:block;margin-top:10px;padding:8px 12px;border:0;border-radius:6px;background:#fbbf24;color:#111827;font-weight:700;cursor:pointer;">Show me the Place Order button</button>
    `;
    document.body.appendChild(banner);
    document.getElementById("philoship-scroll-place-order")?.addEventListener("click", () => {
      placeBtn?.scrollIntoView({ behavior: "smooth", block: "center" });
      placeBtn?.focus?.();
    });

    if (placeBtn?.style) {
      placeBtn.style.outline = "3px solid #2563eb";
      placeBtn.style.outlineOffset = "3px";
      placeBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ── STEP: ADD TO CART ──────────────────────────────────────────────────
  const pausedPlaceOrderBtn = findPlaceOrderButton();
  if ((job.manualPlaceOrderRequired || job.pauseReason === "place_order") && pausedPlaceOrderBtn) {
    showManualPlaceOrderBanner(pausedPlaceOrderBtn);
    console.log("ClawdBot Fulfill: Manual Place Order banner restored.");
    return;
  }

  if (step === "add_to_cart") {
    console.log("🔵 PhiloShip DIAG: add_to_cart START | url=", location.href);
    await wait(2000);

    if (isCheckoutContext()) {
      console.log("🔵 DIAG: isCheckoutContext=true");
      // Always advance into the checkout flow when we're on a checkout page —
      // default to fill_address if the exact sub-step can't be inferred (e.g.
      // Amazon's newer "Chewbacca" pipeline). Never fall back to hunting for a
      // Buy Now / Add to Cart button that doesn't exist on checkout pages.
      const inferredStep = inferCheckoutStepFromPage() || "fill_address";
      console.log("🔵 DIAG: inferred checkout step:", inferredStep, "→ advancing");
      await advanceTo(inferredStep);
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: inferredStep } });
      return;
    }
    console.log("🔵 DIAG: not in checkout context, continuing");

    const pageText = document.body.innerText.toLowerCase();
    if (isAmazonDogOrBlockedPage(pageText)) {
      console.warn("🔴 DIAG: BLOCKED — Amazon dog/blocked page detected. Pausing.");
      await notifyManualIntervention(
        "Amazon opened a dog/error page. PhiloShip paused instead of retrying. Open the Amazon product manually or wait, then resume fulfillment after the page is normal.",
        "amazon_blocked_page"
      );
      return;
    }
    console.log("🔵 DIAG: not a dog/blocked page");

    const isNotFoundPage =
      pageText.includes("we couldn't find that page") ||
      pageText.includes("sorry we couldn't find that page") ||
      pageText.includes("dogs of amazon") ||
      location.href.includes("/errors/404");

    if (isNotFoundPage) {
      console.warn("🔴 DIAG: 404/not-found page");
      if (isUsefulSearchTerm(job.amazonSearchTerm)) {
        console.log("ClawdBot Fulfill: Amazon URL failed, retrying with search");
        location.href = `https://www.amazon.com/s?k=${encodeURIComponent(job.amazonSearchTerm)}`;
        return;
      }
      if (looksLikeAsin(job.amazonAsin)) {
        location.href = `https://www.amazon.com/s?k=${encodeURIComponent(job.amazonAsin)}`;
        return;
      }
    }

    if (location.href.includes("/s?") || location.href.includes("/s/")) {
      console.log("🔵 DIAG: on search page, finding matching result");
      const resultLink = findMatchingSearchResult();
      if (resultLink) {
        console.log("ClawdBot Fulfill: Opening matched Amazon search result");
        resultLink.click();
        return;
      }
    }

    if (!location.href.includes("/dp/") && !location.href.includes("/gp/product/")) {
      console.log("🔵 DIAG: not on a /dp/ product page");
      if (looksLikeAsin(job.amazonAsin)) {
        location.href = `https://www.amazon.com/dp/${job.amazonAsin}`;
        return;
      }
      if (isUsefulSearchTerm(job.amazonSearchTerm)) {
        const desiredSearchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(job.amazonSearchTerm)}`;
        if (location.href !== desiredSearchUrl) {
          location.href = desiredSearchUrl;
          return;
        }
      } else if (location.href.includes("/s?") || location.href.includes("/s/")) {
        await retryOrFail("Amazon search term was invalid, so the search page could not be matched.");
        return;
      }
    }
    console.log("🔵 DIAG: on product page, checking availability");

    // ── UNAVAILABILITY HARD STOP ──────────────────────────────────────────
    // If Amazon shows the item as unavailable, abort completely so the user
    // can search for other items without the automation interfering.
    const unavailableSignals = [
      "currently unavailable",
      "this item cannot be shipped",
      "this item is not available",
      "item not available",
      "temporarily out of stock",
      "we don't know when or if this item will be back in stock",
    ];
    const bodyLower = document.body.innerText.toLowerCase();
    const matchedUnavailableSignal = unavailableSignals.find(s => bodyLower.includes(s));
    const isUnavailable =
      !!matchedUnavailableSignal &&
      !document.getElementById("add-to-cart-button") &&
      !document.querySelector('[name="submit.add-to-cart"]') &&
      !document.querySelector('[name="submit.buy-now"]') &&
      !document.getElementById("buy-now-button");

    if (isUnavailable) {
      console.warn("🔴 DIAG: UNAVAILABLE — signal:", matchedUnavailableSignal, "and no buy buttons found");
      await chrome.storage.local.remove(["pendingFulfillment", "pendingBuyer"]);
      chrome.runtime.sendMessage({
        action: "fulfill_failed",
        reason: "Item is currently unavailable on Amazon. Fulfillment stopped.",
        job,
      });
      return;
    }
    if (matchedUnavailableSignal) {
      console.log("🔵 DIAG: unavailable text present (", matchedUnavailableSignal, ") but buy buttons exist — continuing");
    }

    const targetAsin = String(job.amazonAsin || "").trim().toUpperCase();
    const currentAsin = getCurrentPageAsin();
    console.log("🔵 DIAG: ASIN check | target=", targetAsin, "current=", currentAsin);
    if (looksLikeAsin(targetAsin) && currentAsin && currentAsin !== targetAsin) {
      console.warn("🔴 DIAG: ASIN MISMATCH");
      if (!job.identityRecoveryAttempted) {
        console.warn(`ClawdBot Fulfill: Amazon ASIN mismatch. Expected ${targetAsin}, found ${currentAsin}. Retrying direct DP URL.`);
        job.identityRecoveryAttempted = true;
        await chrome.storage.local.set({ pendingFulfillment: job });
        location.href = `https://www.amazon.com/dp/${targetAsin}?th=1&psc=1`;
        return;
      }

      if (isUsefulSearchTerm(job.amazonSearchTerm)) {
        console.warn(`ClawdBot Fulfill: ASIN mismatch persisted. Falling back to Amazon search for ${job.amazonSearchTerm}.`);
        location.href = `https://www.amazon.com/s?k=${encodeURIComponent(job.amazonSearchTerm)}`;
        return;
      }

      await retryOrFail(`Amazon product mismatch. Expected ${targetAsin}, found ${currentAsin}.`);
      return;
    }

    if (handleCommonInterstitials()) {
      console.log("🔵 DIAG: handled an interstitial");
      await wait(1500);
      if (isCheckoutContext()) {
        const inferredStep = inferCheckoutStepFromPage() || "fill_address";
        await advanceTo(inferredStep);
        chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: inferredStep } });
        return;
      }
    }

    // ── Buy Now detection diagnostics ──────────────────────────────────────
    const rawBuyNow = document.getElementById("buy-now-button");
    console.log("🔵 DIAG: #buy-now-button exists:", !!rawBuyNow,
      "| isUsable:", rawBuyNow ? isUsableBuyNowButton(rawBuyNow) : "n/a");
    if (rawBuyNow) {
      const r = rawBuyNow.getBoundingClientRect();
      console.log("🔵 DIAG: buy-now rect:", Math.round(r.width) + "x" + Math.round(r.height),
        "| disabled:", rawBuyNow.disabled, "| name:", rawBuyNow.getAttribute("name"));
    }

    // Prefer Buy Now (skips cart entirely), but fall through to Add to Cart if
    // the exact Buy Now button is unavailable.
    const buyNowPreferred = await waitForExactBuyNowButton(10000);
    console.log("🔵 DIAG: waitForExactBuyNowButton returned:", !!buyNowPreferred);
    if (buyNowPreferred) {
      // Set quantity only when it's actually >1, and never let it block the click
      // (cap at 2.5s). Most orders are qty 1, where this is a no-op.
      if (getFulfillmentQuantity() > 1) {
        try { await Promise.race([setAmazonQuantity(getFulfillmentQuantity()), wait(2500)]); } catch (_) {}
      }
      // Persist the next step BEFORE clicking (the click navigates and tears down
      // this script). Fire-and-forget so a storage hiccup / invalidated context
      // can't stop us from clicking.
      job.step = "fill_address";
      try { chrome.storage.local.set({ pendingFulfillment: job }); } catch (e) {}
      console.log("🔵 DIAG: about to call clickBuyNowButton");
      if (await clickBuyNowButton(buyNowPreferred)) {
        console.log("✅ DIAG: Buy Now opened checkout — resuming at fill_address");
        return;
      }
      // Click didn't navigate — we're still on the product page. Revert and try cart.
      job.step = "add_to_cart";
      await chrome.storage.local.set({ pendingFulfillment: job });
      console.warn("ClawdBot Fulfill: Buy Now did not open checkout — falling back to Add to Cart");
    } else {
      console.log("ClawdBot Fulfill: No Buy Now button — using Add to Cart\n" + getBuyNowDiagnostics());
    }

    if (!buyNowPreferred) {
      const legacyBuyNow = queryAny([
        '#buy-now-button',
        '[name="submit.buy-now"]',
        '#buyNow input[type="submit"]',
        'input[aria-labelledby*="buy-now"]',
        'input[value*="Buy Now"]',
        'button[aria-label*="Buy Now"]',
        'button[name*="buy-now"]'
      ]);
      if (legacyBuyNow) {
        console.log("ClawdBot Fulfill: Falling back to broader Buy Now selectors.");
        await setAmazonQuantity(getFulfillmentQuantity());
        job.step = "fill_address";
        await chrome.storage.local.set({ pendingFulfillment: job });
        if (await clickBuyNowButton(legacyBuyNow)) {
          console.log("ClawdBot Fulfill: Fallback Buy Now click succeeded.");
          return;
        }
        job.step = "add_to_cart";
        await chrome.storage.local.set({ pendingFulfillment: job });
      }
    }

    // Check if we're on the product page
    const addBtn = document.getElementById("add-to-cart-button") ||
                   document.querySelector('[name="submit.add-to-cart"]') ||
                   document.querySelector("#addToCart input[type='submit']");
    console.log("🔵 DIAG: Add to Cart button found:", !!addBtn);

    if (addBtn) {
      console.log("🔵 DIAG: clicking Add to Cart");
      await setAmazonQuantity(getFulfillmentQuantity());
      // Scroll the product page slightly first (simulates browsing)
      await naturalScroll(Math.min(window.scrollY + 150, 400), 300);
      await humanPause(400, 900);
      await moveMouseTo(addBtn);
      await humanPause(200, 500);
      await simulateHumanClick(addBtn);
      console.log("ClawdBot Fulfill: Clicked Add to Cart");
      await wait(2000);

      if (handleCommonInterstitials()) {
        console.log("ClawdBot Fulfill: Cleared post-add-to-cart interstitial");
        await wait(1500);
      }

      if (isCheckoutContext()) {
        await advanceTo(inferCheckoutStepFromPage() || "fill_address");
        return;
      }

      // Check for the "Added to Cart" confirmation or side panel
      const cartConfirm = document.querySelector("#attachDisplayAddBase498702, #huc-v2-order-row-confirm-text, [data-feature-id='addToCart']");
      if (cartConfirm || document.body.innerText.includes("Added to Cart") || document.body.innerText.includes("added to your")) {
        const directCheckoutBtn = queryAny([
          '#attach-sidesheet-checkout-button',
          '[data-csa-c-slot-id="attach-sidesheet-checkout-button"]',
          'input[name="proceedToRetailCheckout"]',
          '#hlb-ptc-btn-native',
          'a[href*="/buy/checkout"]'
        ]);
        if (directCheckoutBtn) {
          directCheckoutBtn.click();
          await advanceTo("fill_address");
          return;
        }

        await advanceTo("go_to_cart");
        location.href = "https://www.amazon.com/gp/cart/view.html";
        return;
      }

      // If "Added to Cart" popup didn't appear, still try going to cart
      await advanceTo("go_to_cart");
      location.href = "https://www.amazon.com/gp/cart/view.html";
      return;
    }

    console.warn("🔴 DIAG: No Buy Now AND no Add to Cart button found — failing");
    await retryOrFail("Could not find Add to Cart button");
    return;
  }

  // ── STEP: GO TO CART ───────────────────────────────────────────────────
  if (step === "go_to_cart") {
    await wait(2000);

    if (handleCommonInterstitials()) {
      await wait(1500);
    }

    if (isCheckoutContext()) {
      const inferredStep = inferCheckoutStepFromPage() || "fill_address";
      await advanceTo(inferredStep);
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: inferredStep } });
      return;
    }

    // We should be on the cart page
    if (location.href.includes("/cart") || location.href.includes("/gp/cart")) {
      await setAmazonQuantity(getFulfillmentQuantity());

      // Click "Proceed to checkout"
      const checkoutBtn =
        document.querySelector('input[name="proceedToRetailCheckout"]') ||
        document.querySelector('[data-feature-id="proceed-to-checkout-action"]') ||
        document.querySelector('#sc-buy-box-ptc-button input') ||
        document.querySelector('input[value*="Proceed to checkout"]') ||
        document.querySelector('a[href*="buy/checkout"]');

      if (checkoutBtn) {
        checkoutBtn.click();
        console.log("ClawdBot Fulfill: Clicked Proceed to Checkout");
        await advanceTo("fill_address");
        return;
      }

      await retryOrFail("Could not find checkout button on cart page");
      return;
    }

    // Not on cart yet — navigate there
    location.href = "https://www.amazon.com/gp/cart/view.html";
    return;
  }

  // ── STEP: FILL ADDRESS ─────────────────────────────────────────────────
  if (step === "fill_address") {
    await wait(3000);

    if (handleCommonInterstitials()) {
      await wait(1500);
    }

    if (!buyer) {
      await retryOrFail("No buyer data available");
      return;
    }
    const amazonBuyer = getBuyerForAmazonAddress(buyer);

    // ── ADDRESS REUSE: try to select an existing saved address ─────────────
    // Adding a new address on every order is Amazon's #1 fraud trigger.
    // If a saved address already matches the buyer's zip/name, select it instead.
    async function trySelectExistingAddress() {
      const buyerZip  = String(amazonBuyer.zip  || "").trim();
      const buyerName = String(amazonBuyer.name || "").trim().toLowerCase();
      const buyerAddr = String(amazonBuyer.address || "").trim().toLowerCase();

      // Amazon shows saved addresses as radio buttons in a list
      const addressTiles = document.querySelectorAll(
        ".address-tile, [data-testid*='Address_addressTile'], " +
        ".ship-to-this-address, [class*='address-book-entry'], " +
        ".a-box.address-book-entry, [data-csa-c-slot-id*='address']"
      );

      for (const tile of addressTiles) {
        const tileText = tile.innerText || tile.textContent || "";
        const tileZip  = (tileText.match(/\b(\d{5}(?:-\d{4})?)\b/) || [])[1] || "";
        const tileLow  = tileText.toLowerCase();

        // Match on ZIP (most reliable) and optionally name/street
        const zipMatch  = buyerZip  && tileZip === buyerZip;
        const nameMatch = buyerName && tileLow.includes(buyerName.split(" ")[0]);
        const addrMatch = buyerAddr && tileLow.includes(buyerAddr.split(" ")[0]);

        if (zipMatch && (nameMatch || addrMatch)) {
          // Find the radio or "deliver to this address" button within this tile
          const selectBtn = tile.querySelector(
            'input[type="radio"], .ship-to-this-address a, ' +
            '[data-testid*="selectAddress"], [data-csa-c-slot-id*="selectAddress"], ' +
            'input[value*="Use this address"], input[value*="Ship to"]'
          ) || tile.closest('[data-testid*="AddressSelection"]')?.querySelector('input[type="radio"]');

          if (selectBtn) {
            console.log("ClawdBot Fulfill: ✅ Reusing existing saved address (zip match):", tileZip);
            await moveMouseTo(selectBtn);
            await humanPause(200, 500);
            await simulateHumanClick(selectBtn);
            await humanPause(400, 800);

            // Click "Use this address" / "Deliver here" button if it appears after selection
            await wait(600);
            const useBtn = queryAny([
              'input[value*="Use this address"]',
              'input[value*="Ship to this address"]',
              '[data-testid*="Address_selectShipToThisAddress"]',
              '.ship-to-this-address a',
            ]);
            if (useBtn) {
              await moveMouseTo(useBtn);
              await humanPause(150, 300);
              await simulateHumanClick(useBtn);
            }
            return true;
          }
        }
      }
      return false; // no match found — will fall through to add new address
    }

    // Only attempt address reuse if the page has address tiles visible
    const hasSavedAddresses = document.querySelector(
      ".address-tile, [data-testid*='Address_addressTile'], .ship-to-this-address"
    );
    if (hasSavedAddresses) {
      const reused = await trySelectExistingAddress();
      if (reused) {
        await wait(2000);
        await advanceTo("continue_ship");
        return;
      }
    }

    // Natural reading pause before interacting with the page
    await humanPause(500, 1200);
    await naturalScroll(Math.min(window.scrollY + 200, document.body.scrollHeight - window.innerHeight), 300);

    const addNewAddressBtn = queryAny([
      '#add-new-address-popover-link',
      '#add-new-address-desktop-sasp-tango-link',
      'a[id*="add-new-address"]',
      'a[href*="AddAddress"]',
      'a[href*="add-new-address"]',
      'button[aria-label*="Add a new address"]',
      '[data-testid*="Address_showAddressForm"]'
    ]);

    const changeAddressBtn = queryAny([
      'a[aria-label*="Change delivery address"]',
      'a[href*="address-change"]',
      'a[href*="change-address"]',
      '[data-testid*="Address_change"]'
    ]);

    if (!document.querySelector('#address-ui-widgets-enterAddressFullName, input[name*="fullName"]')) {
      if (changeAddressBtn) {
        changeAddressBtn.click();
        console.log("ClawdBot Fulfill: Clicked change-address");
        // Wait up to 8s for the address form to actually appear
        let formAppeared = false;
        for (let i = 0; i < 32; i++) {
          await wait(250);
          if (document.querySelector('#address-ui-widgets-enterAddressFullName, input[name*="fullName"], #add-new-address-popover-link, #add-new-address-desktop-sasp-tango-link')) {
            formAppeared = true;
            break;
          }
        }
        if (!formAppeared) {
          await retryOrFail("change-address dialog did not show address form");
          return;
        }
        // If an "Add new address" button appeared inside the dialog, click it
        const addNewInDialog = queryAny([
          '#add-new-address-popover-link',
          '#add-new-address-desktop-sasp-tango-link',
          'a[id*="add-new-address"]',
          'a[href*="AddAddress"]',
        ]);
        if (addNewInDialog && !document.querySelector('#address-ui-widgets-enterAddressFullName, input[name*="fullName"]')) {
          addNewInDialog.click();
          console.log("ClawdBot Fulfill: Clicked add-new-address inside dialog");
          for (let i = 0; i < 32; i++) {
            await wait(250);
            if (document.querySelector('#address-ui-widgets-enterAddressFullName, input[name*="fullName"]')) break;
          }
        }
        // Fall through to form-filling below
      } else if (addNewAddressBtn) {
        addNewAddressBtn.click();
        console.log("ClawdBot Fulfill: Clicked add-new-address");
        // Wait up to 8s for the form fields
        for (let i = 0; i < 32; i++) {
          await wait(250);
          if (document.querySelector('#address-ui-widgets-enterAddressFullName, input[name*="fullName"]')) break;
        }
        // Fall through to form-filling below
      }
    }

    const addressRoot = queryAny([
      ".a-popover-wrapper",
      "#address-ui-widgets-enterAddressFormContainer",
      "form[name*='address']",
      "body"
    ]);

    const nameInput = queryAny([
      '#address-ui-widgets-enterAddressFullName',
      '[name="address-ui-widgets-enterAddressFullName"]',
      'input[name*="fullName"]'
    ], addressRoot);

    if (nameInput) {
      if (!claimAddressFormFill(amazonBuyer)) return;
      console.log("ClawdBot Fulfill: Filling address form...");

      // Name
      await typeHuman(nameInput, amazonBuyer.name);

      // Phone
      const phoneInput = queryAny([
        '#address-ui-widgets-enterAddressPhoneNumber',
        'input[name*="phoneNumber"]'
      ], addressRoot);
      if (phoneInput && amazonBuyer.phone) { await wait(80 + Math.random() * 150); await typeHuman(phoneInput, amazonBuyer.phone); }

      // Puerto Rico Urbanization
      if (amazonBuyer.urbanization) {
        const urbanizationInput = queryAny([
          '#address-ui-widgets-urbanization',
          '[name="address-ui-widgets-urbanization"]',
          'input[name*="urbanization"]',
          'input[id*="urbanization"]'
        ], addressRoot);
        if (urbanizationInput) {
          await wait(80 + Math.random() * 150);
          await typeHuman(urbanizationInput, amazonBuyer.urbanization);
        }
      }

      // Address Line 1
      const addr1 = queryAny([
        '#address-ui-widgets-enterAddressLine1',
        'input[name*="addressLine1"]'
      ], addressRoot);
      if (addr1) { await wait(80 + Math.random() * 150); await typeHuman(addr1, amazonBuyer.address); }

      // Address Line 2 (apt/unit)
      if (amazonBuyer.address2) {
        const addr2 = queryAny([
          '#address-ui-widgets-enterAddressLine2',
          'input[name*="addressLine2"]'
        ], addressRoot);
        if (addr2) { await wait(80 + Math.random() * 150); await typeHuman(addr2, amazonBuyer.address2); }
      }

      // City
      const cityInput = queryAny([
        '#address-ui-widgets-enterAddressCity',
        'input[name*="city"]'
      ], addressRoot);
      if (cityInput) { await wait(80 + Math.random() * 150); await typeHuman(cityInput, amazonBuyer.city); }

      // State — simulate human clicks on the dropdown
      await wait(300 + Math.random() * 200);
      console.log("ClawdBot Fulfill: Setting state for:", amazonBuyer.state);

      // Primary approach: simulate human click on Amazon's custom dropdown popup
      let stateSet = await selectStateFromPopup(amazonBuyer.state);

      if (!stateSet) {
        // Fallback 1: try the native <select> approach
        console.log("ClawdBot Fulfill: Popup approach failed, trying native select...");
        stateSet = await setStateFromReferenceLogic(amazonBuyer.state);
      }

      if (!stateSet) {
        // Fallback 2: try selectByText on the native select
        const stateSelect = findStateSelect(addressRoot);
        if (stateSelect && stateSelect.tagName === "SELECT") {
          selectByText(stateSelect, amazonBuyer.state);
          await wait(600);
          const selectedText = getSelectedText(stateSelect).toUpperCase();
          const wantedState = (STATE_NAMES[String(amazonBuyer.state || "").trim().toUpperCase()] || amazonBuyer.state || "").toUpperCase();
          if (selectedText && selectedText !== "SELECT" && selectedText.includes(wantedState)) {
            stateSet = true;
          }
        }
      }

      if (!stateSet) {
        // Fallback 3: text input
        console.log("ClawdBot Fulfill: All dropdown approaches failed, trying text input...");
        const stateText = queryAny(['input[name*="stateOrRegion"]'], addressRoot);
        if (stateText) setField(stateText, STATE_NAMES[String(amazonBuyer.state || "").trim().toUpperCase()] || amazonBuyer.state);
      }

      // ZIP
      const zipInput = queryAny([
        '#address-ui-widgets-enterAddressPostalCode',
        'input[name*="postalCode"]'
      ], addressRoot);
      if (zipInput) { await wait(80 + Math.random() * 150); await typeHuman(zipInput, amazonBuyer.zip); }

      await humanPause(700, 1500);

      // Click the address form's submit/continue button
      const submitBtn = queryAny([
        '.a-popover-wrapper #address-ui-widgets-form-submit-button input',
        '.a-popover-wrapper #address-ui-widgets-form-submit-button button',
        '#address-ui-widgets-form-submit-button input',
        '#address-ui-widgets-form-submit-button button',
        '[data-testid="bottom-continue-button"]',
        '[data-csa-c-slot-id="address-ui-widgets-continue-edit-address-btn-bottom"]',
        '[data-csa-c-slot-id="address-ui-widgets-continue-address-btn-bottom"]',
        'input[value*="Use this address"]',
        'input[value*="Ship to this address"]',
        '.ship-to-this-address a'
      ], addressRoot);

      if (submitBtn) {
        // Pause as if reviewing what was typed, then move mouse to submit naturally
        await humanPause(600, 1400);
        await moveMouseTo(submitBtn);
        await humanPause(200, 500);
        await simulateHumanClick(submitBtn);
        console.log("ClawdBot Fulfill: Address submitted");
        await advanceTo("continue_ship");
        return;
      }

      await retryOrFail("Address filled but couldn't find submit button");
      return;
    }

    // Maybe there's an existing address selected — check if we can just continue
    const useThisAddr = queryAny([
      'input[value*="Use this address"]',
      '[data-testid="Address_selectShipToThisAddress"]',
      '.ship-to-this-address a'
    ]);
    if (useThisAddr) {
      // Check if there's an "Add a new address" link we should click first
      const addNew = addNewAddressBtn;
      if (addNew) {
        addNew.click();
        console.log("ClawdBot Fulfill: Clicked 'Add new address'");
        await wait(2000);
        await retryOrFail("Opened new address form, retrying fill");
        return;
      }
    }

    // Check if we're on a different checkout step already (address might be pre-filled)
    const continueBtn = queryAny([
      'input[name="shipToThisAddress"]',
      '[data-testid="Address_selectShipToThisAddress"]'
    ]);
    if (continueBtn) {
      // Address is already there — but we need OUR address, so add new
      const addNew = addNewAddressBtn;
      if (addNew) {
        addNew.click();
        await wait(2000);
        await retryOrFail("Need to enter new address");
        return;
      }
      continueBtn.click();
      await advanceTo("continue_ship");
      return;
    }

    await retryOrFail("Not on address page yet");
    return;
  }

  // ── STEP: CONTINUE / SHIPPING OPTIONS ──────────────────────────────────
  if (step === "continue_ship") {
    await wait(1000);
    await waitForCheckoutReady(ELEM_TIMEOUT);

    if (findPlaceOrderButton()) {
      await advanceTo("place_order");
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: "place_order" } });
      return;
    }

    // ── "Review order" grayed-out interstitial recovery ───────────────────
    // Amazon sometimes shows an "offers" interstitial with a grayed-out UI.
    // The escape is the "Review order" link → SPC page → proceed to checkout.
    const reviewOrderLink =
      document.querySelector('a[data-args="redirectReason=spcChangeClicked"]') ||
      document.querySelector('a[data-topage="spc"].expand-panel-button') ||
      Array.from(document.querySelectorAll("a")).find(a =>
        /review\s+order/i.test(a.textContent) && a.href?.includes("spc")
      );
    if (reviewOrderLink) {
      console.log("ClawdBot Fulfill: Grayed-out page detected — navigating via 'Review order'");
      reviewOrderLink.click();
      await wait(CHANGE_WAIT);
      // After landing on SPC, look for "Proceed to checkout" or the place-order button
      const proceedBtn =
        await waitForEl('input[name="proceedToRetailCheckout"]', 8000) ||
        await waitForEl('#checkout-primary-continue-button-id input', 3000) ||
        await waitForEl('#placeOrder', 3000);
      if (proceedBtn) {
        proceedBtn.click();
        await wait(CLICK_WAIT);
      }
      // Infer where we landed and advance to the right step
      const inferred = inferCheckoutStepFromPage() || "mark_gift";
      await advanceTo(inferred);
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: inferred } });
      return;
    }

    if (handleCommonInterstitials()) {
      await wait(CLICK_WAIT);
    }

    // Select first shipping option if visible
    const shippingOptions = qsAll('input[name*="shipping"], input[name*="order_"][type="radio"]');
    if (shippingOptions.length > 0) {
      shippingOptions[0].click();
      await wait(CLICK_WAIT);
    }

    // EcomSniper-confirmed continue button, with fallbacks
    const continueBtn =
      qs('#checkout-primary-continue-button-id input') ||
      qs('#pagelet-layout-section #checkout-primary-continue-button-id') ||
      qs('[data-csa-c-slot-id="checkout-primary-continue-giftselect"]') ||
      await waitForSafeContinueButton(3000) ||
      qs('button[data-csa-c-slot-id*="continue"]') ||
      Array.from(qsAll('input[type="submit"], button[type="submit"]'))
        .find(el => /continue/i.test(getControlText(el)) && !isLanguageChoiceControl(el));

    if (continueBtn) {
      continueBtn.click();
      await wait(CLICK_WAIT);
      console.log("ClawdBot Fulfill: Shipping continue clicked");
      await advanceTo("mark_gift");
      return;
    }

    // Already past shipping?
    const pageText = getCheckoutDoc().body?.innerText || document.body.innerText;
    if (qs('#placeOrder') || pageText.includes("Place your order")) {
      await advanceTo("place_order");
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: "place_order" } });
      return;
    }
    if (qs('#paymentMethod') || pageText.includes("Payment method")) {
      await advanceTo("mark_gift");
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: "mark_gift" } });
      return;
    }

    await retryOrFail("Could not find shipping continue button");
    return;
  }

  if (step === "mark_gift") {
    await wait(1000);
    await waitForCheckoutReady(ELEM_TIMEOUT);

    if (findPlaceOrderButton()) {
      await advanceTo("place_order");
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: "place_order" } });
      return;
    }

    if (handleCommonInterstitials()) { await wait(CLICK_WAIT); }

    const giftLauncher =
      qs('[data-pipeline-link-args="redirectReason=ChooseGiftOptions"]') ||
      qs('[data-a-modal*="changeGiftOptionsPopover"]') ||
      qs('a[href*="gift"]');
    if (giftLauncher) { giftLauncher.click(); await wait(CLICK_WAIT); }

    const giftCheck =
      qs('input[name="isGift"]') ||
      qs('input[data-testid*="gift"]') ||
      qs('#gift-checkbox') ||
      qs('input[type="checkbox"][name*="gift"]');
    if (giftCheck && !giftCheck.checked) {
      giftCheck.click();
      console.log("ClawdBot Fulfill: Marked as gift");
      await wait(CLICK_WAIT);
    }

    const senderInput = qs('#gift-message-sender-input-0');
    if (senderInput && !senderInput.value) {
      senderInput.focus();
      document.execCommand("insertText", false, job.buyerName || "Your Seller");
      senderInput.dispatchEvent(new Event("input",  { bubbles: true }));
      senderInput.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(CHANGE_WAIT);
    }

    const giftSave =
      qs('[data-testid="GiftOptions_saveButton-0"]') ||
      qs('[data-csa-c-slot-id="checkout-primary-continue-giftselect"]') ||
      await waitForSafeContinueButton(1000);
    if (giftSave) { giftSave.click(); await wait(CLICK_WAIT); }

    await advanceTo("place_order");
    chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: "place_order" } });
    return;
  }

  if (step === "place_order") {
    await wait(1000);
    await waitForCheckoutReady(ELEM_TIMEOUT);

    if (await notifyFulfillmentCompleteFromConfirmation("place-order-step")) {
      return;
    }

    const inferredStep = inferCheckoutStepFromPage();
    if (inferredStep && inferredStep !== "place_order") {
      console.log(`ClawdBot Fulfill: place_order step landed on ${inferredStep}; routing back.`);
      await advanceTo(inferredStep);
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: inferredStep } });
      return;
    }

    const placeBtn = findPlaceOrderButton();

    if (placeBtn) {
      delete job.manualPlaceOrderRequired;
      delete job.manualPlaceOrderUrl;
      delete job.pausedForManualIntervention;
      delete job.pauseReason;
      delete job.lastManualNoticeAt;
      job.step = "place_order";
      job.attempts = 0;
      await chrome.storage.local.set({ pendingFulfillment: job });

      // Pause-before-placing (default): everything is filled in, but we do NOT
      // auto-submit the paid order. Surface it for the user to review and click
      // "Place your order". Set autoPlaceOrder=true in storage to fully automate.
      const placeCfg = await chrome.storage.local.get({ autoPlaceOrder: false });
      if (!placeCfg.autoPlaceOrder) {
        job.manualPlaceOrderRequired = true;
        job.manualPlaceOrderUrl = location.href;
        await chrome.storage.local.set({ pendingFulfillment: job });
        showManualPlaceOrderBanner(placeBtn);
        await notifyManualIntervention(
          "Order is ready — shipping and details are filled in. Review it and click “Place your order” to complete the purchase.",
          "place_order_manual"
        );
        console.log("ClawdBot Fulfill: Paused before placing order (awaiting manual confirmation).");
        return;
      }

      const verificationKeywords = [
        "verify", "verification", "card security code", "cvv",
        "authentication", "confirm your payment", "additional verification",
        "one-time password", "otp", "sms code",
      ];

      const startHref = location.href;
      await humanPause(800, 2000);
      await moveMouseTo(placeBtn);
      await humanPause(300, 700);
      console.log("ClawdBot Fulfill: Attempting automatic Place Order click.");
      await simulateHumanClick(placeBtn);

      let waited = 0;
      while (waited < 90000) {
        await wait(1500);
        waited += 1500;

        if (await notifyFulfillmentCompleteFromConfirmation("post-place-order-wait")) {
          return;
        }

        const pageText = document.body.innerText.toLowerCase();
        if (verificationKeywords.some(keyword => pageText.includes(keyword))) {
          job.manualPlaceOrderRequired = true;
          job.manualPlaceOrderUrl = location.href;
          await chrome.storage.local.set({ pendingFulfillment: job });
          showManualPlaceOrderBanner(findPlaceOrderButton() || placeBtn);
          await notifyManualIntervention(
            "Amazon needs payment verification after the Place Order click. Complete the verification or review step, then finish the order manually if Amazon requires it.",
            "payment_verification"
          );
          return;
        }

        const inferredAfterClick = inferCheckoutStepFromPage();
        if (inferredAfterClick && inferredAfterClick !== "place_order") {
          await advanceTo(inferredAfterClick);
          chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: inferredAfterClick } });
          return;
        }

        if (waited >= 10000 && location.href === startHref && findPlaceOrderButton()) {
          job.manualPlaceOrderRequired = true;
          job.manualPlaceOrderUrl = location.href;
          await chrome.storage.local.set({ pendingFulfillment: job });
          showManualPlaceOrderBanner(findPlaceOrderButton() || placeBtn);
          await notifyManualIntervention(
            "Amazon left the Place Order button on screen after the automatic click. Review the page and click Place your order manually if needed.",
            "place_order"
          );
          return;
        }
      }

      await advanceTo("confirm");
      chrome.runtime.sendMessage({ action: "fulfill_retry", job: { ...job, step: "confirm" } });
      return;
    }

    // If we see "Review your order" but no place button yet, look for continue
    const reviewContinue = await waitForSafeContinueButton(1000, document);
    if (reviewContinue) {
      if (isLanguageChoiceControl(reviewContinue)) {
        await retryOrFail("Amazon is showing a language selection prompt. Please choose the language manually, then retry.");
        return;
      }
      reviewContinue.click();
      await retryOrFail("Clicked continue on review page, retrying...");
      return;
    }

    await retryOrFail("Could not find Place Order button");
    return;
  }

  // ── STEP: CONFIRM ORDER PLACED ─────────────────────────────────────────
  if (step === "confirm") {
    await wait(3000);

    if (await notifyFulfillmentCompleteFromConfirmation("confirm-step")) {
      return;
    }

    await retryOrFail("Order confirmation page not detected");
    return;
  }
})();

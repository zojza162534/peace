/**
 * popup.js — Philo
 * 4-tab UI: Queue | List on eBay | Monitor | Settings
 */
import { optimizeTitle, calculatePrice, productToCSV, getNetProfit } from "./utils.js";
import { listProductOnEbay, listAllProducts, buildConsentUrl, exchangeCodeForToken, getValidToken } from "./ebay_api.js";
import { generateEbayTitle } from "./title_generator.js";
import { checkEbayPoliciesPopup } from "./title_generator.js";
import { login, register, logout, loginWithGoogle, getMe, isLoggedIn, apiFetch, WORKER_URL } from "./auth.js";

// ── Build version ───────────────────────────────────────────────────────────
// Bump this on every change. After reloading the extension, open the popup and
// confirm this exact string shows at the bottom — that's how we KNOW the new
// code is live (no more guessing whether a reload took effect).
export const PHILOSHIP_BUILD = "2026-09-25-k";
try {
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("buildVersion");
    if (el) el.textContent = "Peace build " + PHILOSHIP_BUILD;
  });
} catch (e) {}

// ── Module-level state ────────────────────────────────────────────────────────
let selectedQueueIndex   = null;
let selectedListingIndex = null;
let currentQueue         = [];

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD QUEUE — module scope so every listener can call it
// ═══════════════════════════════════════════════════════════════════════════════
function loadQueue() {
  chrome.storage.local.get({ queue: [], markup: 30 }, data => {
    currentQueue = data.queue;
    const markup = data.markup;

    // Sync slider
    const inp = document.getElementById("markupInput");
    if (inp && markup !== undefined && markup !== null && markup !== "") {
      inp.value = markup;
    }

    document.getElementById("queueCount").textContent = "Queue: " + data.queue.length;

    renderQueueTab(data.queue, markup);
    renderListingTab(data.queue, markup);
    renderMonitorTab(data.queue);
  });
}

// ── Render: Queue tab ─────────────────────────────────────────────────────────
function renderQueueTab(queue, markup) {
  const queueList = document.getElementById("queueList");
  if (!queue.length) {
    queueList.innerHTML = '<em class="empty">No products captured yet</em>';
    selectedQueueIndex = null;
    return;
  }

  queueList.innerHTML = "";
  queue.forEach((p, i) => {
    const ebayPrice = calculatePrice(p.price, markup);
    const { profit, margin } = getNetProfit(p.price, parseFloat(ebayPrice));
    const policyFlags = checkEbayPoliciesPopup(p.title);
    const policyBadge = policyFlags.length > 0
      ? `<div title="${policyFlags.join('\n')}" style="font-size:10px;color:#ff7043;cursor:help;">⚠️ ${policyFlags.length} policy flag${policyFlags.length > 1 ? 's' : ''}</div>`
      : '';
    const s = statusBadge(p.status);
    const rebateBadge = p.rebateEligible
      ? `<div title="${String(p.rebateText || 'Amazon coupon/rebate available').replace(/"/g, '&quot;')}" style="font-size:10px;color:#2e7d32;font-weight:bold;cursor:help;">💰 Rebate eligible${p.rebateText ? ' — ' + p.rebateText.slice(0, 40) : ''}</div>`
      : '';
    const profitColor = parseFloat(profit) >= 0 ? "#2e7d32" : "#c62828";
    const descHtml = p.description
      ? `<div style="font-size:10px;color:#666;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.description.slice(0, 80)}…</div>`
      : "";
    const ebayLink = p.ebayItemId
      ? `<a href="${p.ebayUrl}" target="_blank" style="font-size:10px;color:#1565c0;">View on eBay ↗</a>`
      : "";

    const div = document.createElement("div");
    div.className = "queue-item" + (i === selectedQueueIndex ? " selected" : "");
    div.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:flex-start;">` +
        `<strong style="flex:1;font-size:11px;line-height:1.3;">${optimizeTitle(p.title)}</strong>` +
        `<span class="status-badge ${s.cls}">${s.label}</span>` +
      `</div>` +
      descHtml +
      `<div style="display:flex;gap:8px;margin-top:3px;font-size:11px;">` +
        `<span>🛒 $${p.price}</span><span>→</span>` +
        `<span>📦 <strong>$${ebayPrice}</strong></span>` +
        `<span style="color:${profitColor};">Net: $${profit} (${margin}%)</span>` +
      `</div>` +
      (p.hasVariations ? `<div style="font-size:10px;color:#e65100;">⚡ Has Variations</div>` : "") +
      rebateBadge +
      policyBadge +
      (ebayLink ? `<div style="margin-top:2px;">${ebayLink}</div>` : "");

    div.addEventListener("click", () => {
      selectedQueueIndex = i;
      document.querySelectorAll("#queueList .queue-item").forEach(el => el.classList.remove("selected"));
      div.classList.add("selected");
    });
    queueList.appendChild(div);
  });
}

// ── Render: Listing tab queue ─────────────────────────────────────────────────
function renderListingTab(queue, markup) {
  const listingQueue = document.getElementById("listingQueue");
  if (!listingQueue) return;

  if (!queue.length) {
    listingQueue.innerHTML = '<em class="empty">No products in queue</em>';
    selectedListingIndex = null;
    return;
  }

  listingQueue.innerHTML = "";
  queue.forEach((p, i) => {
    const ebayPrice = calculatePrice(p.price, markup);
    const s = statusBadge(p.status);
    const div = document.createElement("div");
    div.className = "queue-item" + (i === selectedListingIndex ? " selected" : "");
    div.innerHTML =
      `<div style="display:flex;justify-content:space-between;">` +
        `<span style="font-size:11px;flex:1;">${optimizeTitle(p.title).slice(0, 45)}…</span>` +
        `<span class="status-badge ${s.cls}">${s.label}</span>` +
      `</div>` +
      `<div style="font-size:11px;color:#555;">$${p.price} → $${ebayPrice} | ${p.images?.length || 0} imgs</div>`;

    div.addEventListener("click", () => {
      selectedListingIndex = i;
      document.querySelectorAll("#listingQueue .queue-item").forEach(el => el.classList.remove("selected"));
      div.classList.add("selected");
    });
    listingQueue.appendChild(div);
  });
}

// ── Render: Monitor tab ───────────────────────────────────────────────────────
function renderMonitorTab(queue) {
  const monitoringList = document.getElementById("monitoringList");
  const alerts = queue.filter(p =>
    p.status === "price_changed" || p.status === "out_of_stock" || p.status === "CRITICAL_LOW_PROFIT"
  );
  const listed = queue.filter(p => p.status === "listed");

  document.getElementById("trackedCount").textContent = queue.length;
  document.getElementById("alertCount").textContent   = alerts.length;
  document.getElementById("listedCount").textContent  = listed.length;

  if (alerts.length) {
    monitoringList.innerHTML = "";
    alerts.forEach(item => {
      const div = document.createElement("div");
      div.style.cssText = "padding:4px 0;border-bottom:1px solid #f0f0f0;font-size:11px;";
      const lbl = { out_of_stock:"OOS", price_changed:"PRICE Δ", CRITICAL_LOW_PROFIT:"⚠ LOW $" };
      div.innerHTML = `<span style="font-weight:bold;color:#d32f2f;">[${lbl[item.status] || item.status}]</span> ${item.title.slice(0, 38)}...`;
      monitoringList.appendChild(div);
    });
  } else {
    monitoringList.innerHTML = '<em class="empty">No active alerts. Monitoring runs every 60m.</em>';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusBadge(status) {
  return {
    active:              { cls: "status-ok",     label: "Synced" },
    price_changed:       { cls: "status-price",  label: "Price Δ" },
    out_of_stock:        { cls: "status-oos",    label: "OOS" },
    CRITICAL_LOW_PROFIT: { cls: "status-oos",    label: "⚠ Low $" },
    listed:              { cls: "status-listed", label: "Listed ✓" },
    listing:             { cls: "status-price",  label: "Listing" },
    listing_failed:      { cls: "status-failed", label: "Failed" },
  }[status] || { cls: "status-ok", label: status || "active" };
}

function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

async function getSettings() {
  const settings = await chrome.storage.local.get({
    markup: 30,
    clawdbot_worker_url: "",
    ebay_client_id: "",
    ebay_client_secret: "",
    ebay_ru_name: "",
    categoryId:  "",
    defaultQuantity: 1,
    quantity:    1,
    condition:   "New",
    location:    "United States",
    postalCode:  "",
  });
  settings.quantity = parseInt(settings.quantity || settings.defaultQuantity, 10) || 1;
  settings.defaultQuantity = settings.quantity;
  return settings;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTING ENGINE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function checkConnection() {
  // Check storage directly first — banner element may be null if the List tab
  // hasn't been switched to yet (it starts as display:none on load).
  const data = await chrome.storage.local.get({
    ebay_refresh_token:    "",
    ebay_access_token:     "",
    ebay_token_expires_at: 0,
    clawdbot_worker_url:   "",
  });

  const banner = document.getElementById("listingConnStatus");

  const setBanner = (text, cls) => {
    if (banner) { banner.textContent = text; banner.className = "conn-banner " + cls; }
  };

  if (!data.ebay_refresh_token) {
    setBanner("❌ Not connected — go to Settings → Connect eBay Account", "conn-error");
    return false;
  }

  if (!data.clawdbot_worker_url) {
    setBanner("⚠️ Refresh token found but Worker URL missing — check Settings", "conn-unknown");
    return false;
  }

  try {
    const token = await getValidToken();
    if (token) {
      setBanner("✅ Connected to eBay", "conn-ok");
      return true;
    }
  } catch (e) {
    // Show the real eBay error, not a generic message
    const msg = (e.message || String(e)).replace("NOT_CONNECTED: ", "");
    setBanner("❌ " + msg, "conn-error");
    console.error("PhiloShip checkConnection:", e.message);
    return false;
  }

  return false;
}

function setProgress(current, total) {
  const wrap  = document.getElementById("listingProgressWrap");
  const bar   = document.getElementById("listingProgressBar");
  const label = document.getElementById("listingProgressLabel");
  if (!wrap) return;
  wrap.style.display = total > 0 ? "block" : "none";
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  bar.style.width = pct + "%";
  label.textContent = `Listing ${current} / ${total}…`;
}

function addListingResult(product, result) {
  const el = document.getElementById("listingResults");
  if (!el) return;
  const div = document.createElement("div");
  div.style.cssText = "padding:3px 0; border-bottom:1px solid #f0f0f0;";
  if (result.success) {
    div.innerHTML = `✅ <a href="${result.ebayUrl}" target="_blank" style="color:#1565c0;">${product.title.slice(0,40)}…</a> → #${result.itemId}`;
  } else {
    div.innerHTML = `❌ <span style="color:#c62828;">${product.title.slice(0,35)}…</span><br><small>${result.error}</small>`;
  }
  el.prepend(div);
}

function renderBulkListingJob(job) {
  if (!job?.status) return;

  const running = job.status === "running" || job.status === "starting";
  const listSelected = document.getElementById("listSelected");
  const listAll = document.getElementById("listAll");
  const stopBulkListing = document.getElementById("stopBulkListing");
  if (listSelected) listSelected.disabled = running;
  if (listAll) listAll.disabled = running;
  if (stopBulkListing) {
    stopBulkListing.style.display = running || job.status === "stopping" ? "" : "none";
    stopBulkListing.disabled = job.status === "stopping";
    stopBulkListing.textContent = job.status === "stopping" ? "Stopping..." : "Stop Bulk";
  }

  if (running) {
    setProgress(job.current || 0, job.total || 0);
    const title = job.currentProduct ? `: ${String(job.currentProduct).slice(0, 32)}...` : "";
    setStatus(`Listing ${job.current || 0}/${job.total || 0}${title} Listed: ${job.listed || 0} | Failed: ${job.failed || 0}`);
  } else {
    if (job.status === "stopping") {
      setProgress(job.current || 0, job.total || 0);
      setStatus("Stopping bulk listing safely after the current item...");
    } else {
      setProgress(0, 0);
    }
    if (job.status === "complete") {
      setStatus(`Done! Listed: ${job.listed || 0} | Failed: ${job.failed || 0}`);
    } else if (job.status === "failed") {
      setStatus("Bulk listing failed: " + (job.error || "Unknown error"));
    } else if (job.status === "stopped") {
      setStatus(`Bulk listing stopped. Listed: ${job.listed || 0} | Failed: ${job.failed || 0}`);
    }
  }

  const resultsEl = document.getElementById("listingResults");
  if (!resultsEl || !Array.isArray(job.results)) return;
  resultsEl.innerHTML = "";
  job.results.forEach(result => {
    const div = document.createElement("div");
    div.style.cssText = "padding:3px 0; border-bottom:1px solid #f0f0f0;";
    if (result.success) {
      div.innerHTML = `OK <a href="${result.ebayUrl}" target="_blank" style="color:#1565c0;">${String(result.title).slice(0,40)}...</a> -> #${result.itemId}`;
    } else {
      div.innerHTML = `FAILED <span style="color:#c62828;">${String(result.title).slice(0,35)}...</span><br><small>${result.error || "Listing failed"}</small>`;
    }
    resultsEl.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOMContentLoaded — wire everything up
// ═══════════════════════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {

  // Always keep clawdbot_worker_url in sync so v3.9 background checks pass
  chrome.storage.local.set({ clawdbot_worker_url: WORKER_URL });

  // ── AUTH SCREEN ─────────────────────────────────────────────────────────────
  const authScreen   = document.getElementById("authScreen");
  const pricingModal = document.getElementById("pricingModal");
  const tabBar       = document.getElementById("tabBar");
  let   selectedPlan = "free";

  function hideAll() {
    authScreen.style.display   = "none";
    pricingModal.style.display = "none";
    tabBar.style.display       = "none";
    document.querySelectorAll(".tab-content").forEach(el => el.style.display = "none");
  }

  async function showAuthScreen() {
    hideAll();
    authScreen.style.display = "block";
  }

  async function showPricingModal() {
    hideAll();
    pricingModal.style.display = "block";
  }

  async function refreshAccountPanel() {
    try {
      const me = await getMe();
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      set("userName",  me.name  || me.email);
      set("userEmail", me.email);
      if (me.avatarUrl) { const a = document.getElementById("userAvatar"); if (a) a.src = me.avatarUrl; }

      const subBadge  = document.getElementById("subBadge");
      const ebayBadge = document.getElementById("ebayBadge");
      if (subBadge) {
        const active = me.subscription?.status === "active";
        const label  = { pro: "⭐ Pro", business: "🚀 Business", free: "Free" }[me.subscription?.plan] || "Free";
        subBadge.textContent      = label;
        subBadge.style.background = active ? "#1565c0" : "#2a2a2a";
        subBadge.style.color      = active ? "#fff"    : "#aaa";
      }
      if (ebayBadge) {
        ebayBadge.textContent      = me.ebayConnected ? `✅ eBay: ${me.ebayUserId || "Connected"}` : "eBay: Not Connected";
        ebayBadge.style.background = me.ebayConnected ? "#1b5e20" : "#2a2a2a";
        ebayBadge.style.color      = me.ebayConnected ? "#a5d6a7" : "#aaa";
      }
    } catch (e) {
      if (e.message === "SESSION_EXPIRED") await showAuthScreen();
    }
  }

  async function showMainApp() {
    // Don't block if already showing — just refresh the panel
    if (tabBar.style.display !== "") {
      hideAll();
      tabBar.style.display = "";
      document.querySelector('[data-tab="queue"]')?.click();
    }
    await refreshAccountPanel();
  }

  // Show auth or app on open — always refresh panel so eBay/sub status is current
  if (await isLoggedIn()) { await showMainApp(); } else { await showAuthScreen(); }

  // ── Auth view switching ───────────────────────────────────────────────────
  function showView(view) {
    ["viewLogin","viewSignup","viewForgot"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    });
    const target = document.getElementById("view" + view);
    if (target) target.style.display = "block";
    document.getElementById("authError").textContent = "";
  }

  document.getElementById("tabLogin")?.addEventListener("click", () => {
    document.getElementById("tabLogin").style.background  = "#2a2a2a";
    document.getElementById("tabLogin").style.color       = "#fff";
    document.getElementById("tabSignup").style.background = "transparent";
    document.getElementById("tabSignup").style.color      = "#666";
    showView("Login");
  });

  document.getElementById("tabSignup")?.addEventListener("click", () => {
    document.getElementById("tabSignup").style.background = "#2a2a2a";
    document.getElementById("tabSignup").style.color      = "#fff";
    document.getElementById("tabLogin").style.background  = "transparent";
    document.getElementById("tabLogin").style.color       = "#666";
    showView("Signup");
  });

  // Password show/hide toggles
  document.getElementById("toggleLoginPass")?.addEventListener("click", () => {
    const f = document.getElementById("loginPass");
    f.type = f.type === "password" ? "text" : "password";
  });
  document.getElementById("toggleSignupPass")?.addEventListener("click", () => {
    const f = document.getElementById("signupPass");
    f.type = f.type === "password" ? "text" : "password";
  });

  // ── Password strength meter ───────────────────────────────────────────────
  // HIPAA-aligned: 8+ chars, uppercase, number, special character
  function checkStrength(pw) {
    const rules = [
      pw.length >= 8,
      /[A-Z]/.test(pw),
      /[0-9]/.test(pw),
      /[^A-Za-z0-9]/.test(pw),
    ];
    return rules.filter(Boolean).length;
  }

  function validatePassword(pw) {
    if (pw.length < 8)              return "Password must be at least 8 characters";
    if (!/[A-Z]/.test(pw))          return "Must include at least one uppercase letter";
    if (!/[0-9]/.test(pw))          return "Must include at least one number";
    if (!/[^A-Za-z0-9]/.test(pw))  return "Must include at least one special character (!@#$%^&* etc.)";
    return null;
  }

  const barColors = ["#e53935","#ff7043","#fdd835","#43a047"];
  const barLabels = ["Weak","Fair","Good","Strong"];

  document.getElementById("signupPass")?.addEventListener("input", e => {
    const score = checkStrength(e.target.value);
    const bars  = document.querySelectorAll(".str-bar");
    bars.forEach((b, i) => { b.style.background = i < score ? barColors[score-1] : "#222"; });
    const lbl = document.getElementById("strLabel");
    if (lbl) lbl.textContent = e.target.value
      ? (score === 4 ? "✓ Strong password" : barLabels[score-1] + " — add " +
          (!(/[A-Z]/.test(e.target.value)) ? "uppercase, " : "") +
          (!(/[0-9]/.test(e.target.value)) ? "number, " : "") +
          (!(/[^A-Za-z0-9]/.test(e.target.value)) ? "special char " : "").trim().replace(/,\s*$/, ""))
      : "Password must be 8+ chars with uppercase, number & special character";
  });

  // ── Sign In submit ────────────────────────────────────────────────────────
  document.getElementById("loginSubmit")?.addEventListener("click", async () => {
    const email = document.getElementById("loginEmail")?.value.trim();
    const pass  = document.getElementById("loginPass")?.value;
    const errEl = document.getElementById("authError");
    const btn   = document.getElementById("loginSubmit");
    if (!email || !pass) { errEl.textContent = "Please enter your email and password."; return; }
    errEl.textContent = ""; btn.disabled = true; btn.textContent = "Signing in...";
    try {
      await login(email, pass);
      await showMainApp();
    } catch (e) {
      errEl.textContent = e.message === "Invalid credentials"
        ? "Incorrect email or password. Please try again."
        : e.message;
    }
    finally { btn.disabled = false; btn.textContent = "Sign In"; }
  });

  // ── Sign Up submit ────────────────────────────────────────────────────────
  document.getElementById("signupSubmit")?.addEventListener("click", async () => {
    const name    = document.getElementById("signupName")?.value.trim();
    const email   = document.getElementById("signupEmail")?.value.trim();
    const pass    = document.getElementById("signupPass")?.value;
    const confirm = document.getElementById("signupConfirm")?.value;
    const errEl   = document.getElementById("authError");
    const btn     = document.getElementById("signupSubmit");

    errEl.textContent = "";
    if (!name)               { errEl.textContent = "Please enter your full name."; return; }
    if (!email)              { errEl.textContent = "Please enter your email address."; return; }
    const pwErr = validatePassword(pass || "");
    if (pwErr)               { errEl.textContent = pwErr; return; }
    if (pass !== confirm)    { errEl.textContent = "Passwords do not match."; return; }

    btn.disabled = true; btn.textContent = "Creating account...";
    try {
      await register(email, pass, name);
      await showPricingModal();
    } catch (e) {
      errEl.textContent = e.message.includes("already registered")
        ? "An account with that email already exists. Try signing in instead."
        : e.message;
    }
    finally { btn.disabled = false; btn.textContent = "Create Account"; }
  });

  // ── Forgot password ───────────────────────────────────────────────────────
  document.getElementById("forgotLink")?.addEventListener("click", e => {
    e.preventDefault();
    showView("Forgot");
    const loginEmail = document.getElementById("loginEmail")?.value;
    if (loginEmail) { const fe = document.getElementById("forgotEmail"); if (fe) fe.value = loginEmail; }
  });

  document.getElementById("backToLogin")?.addEventListener("click", e => {
    e.preventDefault();
    showView("Login");
  });

  document.getElementById("forgotSubmit")?.addEventListener("click", async () => {
    const email = document.getElementById("forgotEmail")?.value.trim();
    const errEl = document.getElementById("authError");
    const btn   = document.getElementById("forgotSubmit");
    if (!email) { errEl.textContent = "Please enter your email address."; return; }
    btn.disabled = true; btn.textContent = "Sending...";
    try {
      await fetch(WORKER_URL + "/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // Always show success to prevent email enumeration
      errEl.style.color = "#43a047";
      errEl.textContent = "✓ If that email is registered, a reset link has been sent.";
      btn.textContent = "Sent";
    } catch(e) {
      errEl.style.color = "#e53935";
      errEl.textContent = "Could not send reset email. Try again later.";
      btn.disabled = false; btn.textContent = "Send Reset Link";
    }
  });

  // ── Pricing modal ─────────────────────────────────────────────────────────
  document.querySelectorAll(".plan-card").forEach(card => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".plan-card").forEach(c => c.style.outline = "none");
      card.style.outline = "2px solid #fff";
      selectedPlan = card.dataset.plan;
    });
  });

  document.getElementById("pricingContinue")?.addEventListener("click", async () => {
    const btn  = document.getElementById("pricingContinue");
    const note = document.getElementById("pricingNote");
    btn.disabled = true; btn.textContent = "...";

    if (selectedPlan === "free") {
      await showMainApp();
      return;
    }

    try {
      const res  = await apiFetch("/billing/checkout", { method: "POST", body: { plan: selectedPlan } });
      const data = await res.json().catch(() => ({}));

      if (data.url) {
        chrome.tabs.create({ url: data.url });
        note.style.color = "#43a047";
        note.textContent = "✓ Stripe checkout opened in a new tab. Return here after payment.";
        btn.textContent = "I've paid — Continue →";
        btn.disabled = false;
        btn.onclick = () => showMainApp();
      } else {
        // Stripe not set up yet — show clear instructions and let them continue free
        note.style.color = "#ffb74d";
        note.textContent = data.error || "Stripe not configured. See setup instructions below.";
        btn.textContent = "Continue on Free Plan →";
        btn.disabled = false;
        btn.onclick = () => showMainApp();
      }
    } catch(e) {
      note.style.color = "#ffb74d";
      note.textContent = "Stripe not configured yet. Continue on free plan and upgrade later.";
      btn.textContent = "Continue on Free Plan →";
      btn.disabled = false;
      btn.onclick = () => showMainApp();
    }
  });

  // ── Google sign-in ────────────────────────────────────────────────────────
  document.getElementById("googleSignIn").addEventListener("click", async () => {
    const errEl = document.getElementById("authError");
    const btn   = document.getElementById("googleSignIn");
    errEl.textContent = "";
    btn.textContent = "Opening Google..."; btn.disabled = true;
    try {
      await loginWithGoogle();
      btn.textContent = "Waiting for sign-in...";
    } catch (e) {
      errEl.textContent = e.message;
      btn.textContent = "Continue with Google"; btn.disabled = false;
    }
  });

  // Watch for tokens arriving from background worker (Google OAuth)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.accessToken?.newValue) {
      showMainApp().catch(console.error);
    }
  });

  // ── Sign out ──────────────────────────────────────────────────────────────
  document.getElementById("signOut")?.addEventListener("click", async () => {
    await logout(); await showAuthScreen();
  });

  // ── Connect eBay ─────────────────────────────────────────────────────────
  // Uses YOUR eBay developer credentials stored in the Worker as secrets.
  // Users just click and sign into their eBay seller account — no dev portal needed.
  document.getElementById("connectEbay")?.addEventListener("click", async () => {
    const { accessToken } = await chrome.storage.local.get("accessToken");
    if (!accessToken) { setStatus("⚠️ Sign in first."); return; }
    chrome.runtime.sendMessage({ action: "open_ebay_connect", accessToken });
  });

  // ── Upgrade plan ──────────────────────────────────────────────────────────
  document.getElementById("upgradePlan")?.addEventListener("click", async () => {
    // Show the pricing modal again so user can pick a plan
    selectedPlan = "pro";
    await showPricingModal();
  });

  // ── Manage billing ────────────────────────────────────────────────────────
  document.getElementById("manageAccount")?.addEventListener("click", async () => {
    try {
      const res  = await apiFetch("/billing/portal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.url) {
        chrome.tabs.create({ url: data.url });
      } else {
        // Not configured or no subscription yet — show Stripe dashboard link
        const msg = data.error || "";
        if (msg.includes("not configured") || msg.includes("STRIPE")) {
          setStatus("⚠️ Stripe not set up yet. Run: wrangler secret put STRIPE_SECRET_KEY");
        } else if (msg.includes("No billing") || msg.includes("Purchase")) {
          setStatus("⚠️ No active subscription found. Click Upgrade to subscribe.");
        } else {
          setStatus("⚠️ " + (msg || "Billing portal unavailable."));
        }
      }
    } catch(e) {
      setStatus("⚠️ Could not open billing portal: " + e.message);
    }
  });




  // ── Title character counter ───────────────────────────────────────────────
  document.getElementById("ebayTitleInput")?.addEventListener("input", e => {
    const len = e.target.value.length;
    const counter = document.getElementById("titleCharCount");
    if (counter) {
      counter.textContent = `${len}/80`;
      counter.style.color = len > 70 ? "#ff7043" : len > 60 ? "#ffb74d" : "#666";
    }
  });

  // ── Title Generator (built-in, no API) ──────────────────────────────────────
  document.getElementById("generateTitle")?.addEventListener("click", async () => {
    const btn        = document.getElementById("generateTitle");
    const titleInput = document.getElementById("ebayTitleInput");
    if (!titleInput) return;

    // Get selected product
    const selectedItem = document.querySelector("#listingQueue .queue-item.selected") ||
                         document.querySelector("#listingQueue .queue-item");
    if (!selectedItem) { setStatus("⚠️ Select a product in the List tab first"); return; }

    const { queue } = await chrome.storage.local.get({ queue: [] });
    const idx = parseInt(selectedItem.dataset.index ?? "0", 10);
    const product = queue[idx];
    if (!product) { setStatus("⚠️ Could not find product data"); return; }

    btn.textContent = "⏳..."; btn.disabled = true;

    try {
      const generated = generateEbayTitle(product);
      titleInput.value = generated;
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));

      // Save back to queue so the listing uses it
      queue[idx].custom_title = generated;
      await chrome.storage.local.set({ queue });
      setStatus(`✅ Title generated (${generated.length}/80 chars)`);
    } catch(e) {
      setStatus("⚠️ Title generation failed: " + e.message);
    
      btn.textContent = "✨ Generate Title"; btn.disabled = false;
    }
  });

  // When a product is selected in the listing queue, populate the title field
  // so users can see and edit it before listing
  function populateTitleFromSelected(product) {
    const titleInput = document.getElementById("ebayTitleInput");
    const counter    = document.getElementById("titleCharCount");
    if (!titleInput) return;
    const t = product?.custom_title || product?.title || "";
    titleInput.value = t.slice(0, 80);
    if (counter) counter.textContent = `${titleInput.value.length}/80`;
  }

  // ── Tab switching ────────────────────────────────────────────────────────────
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(t => t.style.display = "none");
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).style.display = "block";

      if (btn.dataset.tab === "listing")  checkConnection();
      if (btn.dataset.tab === "settings") loadSettingsForm();
    });
  });

  // ── Markup input ────────────────────────────────────────────────────────────
  document.getElementById("markupInput")?.addEventListener("input", e => {
    const raw = e.target.value;
    // Allow empty field while typing — only save/clamp on valid number
    if (raw === "" || raw === "-") return;
    const val = Math.min(9999, Math.max(0, parseInt(raw, 10)));
    if (!isNaN(val)) {
      chrome.storage.local.set({ markup: val });
      loadQueue();
    }
  });
  document.getElementById("markupInput")?.addEventListener("blur", e => {
    const val = parseInt(e.target.value, 10);
    if (isNaN(val) || e.target.value === "") {
      e.target.value = ""; // leave empty if user cleared it
    } else {
      const clamped = Math.min(9999, Math.max(0, val));
      e.target.value = clamped;
      chrome.storage.local.set({ markup: clamped });
    }
  });

  // ── Capture Amazon product ──────────────────────────────────────────────────
  document.getElementById("captureAmazon").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("amazon.com")) { setStatus("❌ Not on Amazon"); return; }
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content_amazon.js"] });
    setTimeout(loadQueue, 900);
    setStatus("⏳ Capturing...");
  });

  // ── Bulk snipe ──────────────────────────────────────────────────────────────
  document.getElementById("bulkSnipe").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("amazon.com")) { setStatus("❌ Not on Amazon"); return; }
    const ok = tab.url.includes("/s?") || tab.url.includes("/s/") || tab.url.includes("/b?");
    if (!ok) { setStatus("❌ Go to an Amazon search or category page"); return; }
    setStatus("⚡ Bulk sniping page...");
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content_amazon_bulk.js"] });
    // Poll enrichment progress and refresh the queue as items are filled in.
    const enrichPoll = setInterval(async () => {
      const { bulkEnrichJob } = await chrome.storage.local.get({ bulkEnrichJob: null });
      loadQueue();
      if (bulkEnrichJob && bulkEnrichJob.active) {
        setStatus(`⚙️ Loading product details ${bulkEnrichJob.current}/${bulkEnrichJob.total}...`);
      } else if (bulkEnrichJob && !bulkEnrichJob.active) {
        setStatus(`✅ Bulk snipe done — ${bulkEnrichJob.total} products loaded.`);
        clearInterval(enrichPoll);
      }
    }, 1500);
    // Safety stop after 10 minutes.
    setTimeout(() => clearInterval(enrichPoll), 10 * 60 * 1000);
  });

  // ── Recalc / Export / Clear ─────────────────────────────────────────────────
  document.getElementById("recalcPrices").addEventListener("click", loadQueue);

  document.getElementById("exportCSV").addEventListener("click", () => {
    chrome.storage.local.get({ queue: [], markup: 30 }, data => {
      if (!data.queue.length) { setStatus("Queue is empty"); return; }
      const blob   = new Blob(["\ufeff", productToCSV(data.queue, data.markup)], { type: "text/csv;charset=utf-8;" });
      const reader = new FileReader();
      reader.onloadend = () => chrome.runtime.sendMessage({
        action: "download_csv", url: reader.result,
        filename: "ebay_bulk_" + new Date().toISOString().slice(0,10) + ".csv"
      });
      reader.readAsDataURL(blob);
      setStatus("📥 Downloading CSV...");
    });
  });

  document.getElementById("clearQueue").addEventListener("click", () => {
    if (confirm("Clear the entire queue? This cannot be undone.")) {
      chrome.storage.local.set({ queue: [] }, () => {
        selectedQueueIndex = null; selectedListingIndex = null;
        loadQueue(); setStatus("Queue cleared.");
      });
    }
  });

  // ── LIST SELECTED ───────────────────────────────────────────────────────────
  document.getElementById("listSelected").addEventListener("click", async () => {
    if (selectedListingIndex === null) { setStatus("Select a product first"); return; }
    const product = currentQueue[selectedListingIndex];
    if (!product) {
      setStatus("Selected product is no longer in the queue");
      return;
    }

    const ok = await checkConnection();
    if (!ok) {
      setStatus("Connect eBay account in Settings first");
      return;
    }

    setStatus("Opening eBay listing form. Keep the eBay tab open...");
    document.getElementById("listSelected").disabled = true;
    document.getElementById("listAll").disabled = true;

    try {
      const settings = await getSettings();
      const result   = await listProductOnEbay(product, settings);
      addListingResult(product, result);
      setStatus(`✅ Listed! Item #${result.itemId}`);
      loadQueue();
    
    } catch (err) {
      addListingResult(product, { success: false, error: err.message });
      setStatus("❌ " + err.message);
    } finally {
      document.getElementById("listSelected").disabled = false;
      document.getElementById("listAll").disabled = false;
      setProgress(0, 0);
    }
  });

  // ── LIST ALL ────────────────────────────────────────────────────────────────
  document.getElementById("listAll").addEventListener("click", async () => {
    const ok = await checkConnection();
    if (!ok) { setStatus("❌ Connect eBay account in Settings first"); return; }

    const existing = await chrome.storage.local.get({ bulkListingJob: null });
    if (existing.bulkListingJob?.status === "running" || existing.bulkListingJob?.status === "starting") {
      renderBulkListingJob(existing.bulkListingJob);
      return;
    }

    const unlisted = currentQueue.filter(p => p.status !== "listed" && p.status !== "listing_failed");
    if (!unlisted.length) { setStatus("No unlisted products in queue"); return; }

    if (!confirm(`List all ${unlisted.length} items?\n\nThe extension will gather all product info then list them one by one. You can close this popup - it will keep running.`)) return;

    document.getElementById("listSelected").disabled = true;
    document.getElementById("listAll").disabled = true;
    document.getElementById("listingResults").innerHTML = "";

    const settings = await getSettings();
    setStatus(`Snapshotting ${unlisted.length} products...`);
    const snapshot = unlisted.map(p => ({ ...p }));
    const bulkListingJob = {
      status: "starting",
      current: 0,
      total: snapshot.length,
      listed: 0,
      failed: 0,
      startedAt: Date.now(),
      results: [],
    };

    await chrome.storage.local.set({ bulkSnapshot: snapshot, bulkSettings: settings, bulkListingJob });
    setProgress(0, snapshot.length);
    setStatus(`Snapshot ready - starting ${snapshot.length} listings in the background...`);

    chrome.runtime.sendMessage({ action: "start_bulk_ebay_listing", snapshot, settings }, response => {
      if (chrome.runtime.lastError) {
        setStatus("Bulk listing could not start: " + chrome.runtime.lastError.message);
        document.getElementById("listSelected").disabled = false;
        document.getElementById("listAll").disabled = false;
        return;
      }
      if (!response?.success) {
        setStatus("Bulk listing could not start: " + (response?.error || "Unknown error"));
        document.getElementById("listSelected").disabled = false;
        document.getElementById("listAll").disabled = false;
        return;
      }
      setStatus("Bulk listing is running in the background. You can close this popup.");
    });

    return;
  });

  // FILL EBAY FORM (manual fallback) ───────────────────────────────────────
  document.getElementById("fillEbay").addEventListener("click", async () => {
    if (selectedListingIndex === null) { setStatus("Select a product first"); return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.storage.local.set({ lastProduct: currentQueue[selectedListingIndex] }, () => {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content_ebay.js"] });
      setStatus("📤 Filling eBay form...");
    });
  });

  // ── FULFILL ORDER (eBay → Amazon) ──────────────────────────────────────────
  document.getElementById("fulfillAmazon")?.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab.url.includes("ebay.com")) {
      setStatus("⏳ Scraping buyer address...");
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const specificLink = document.querySelector('a.fake-link[href="#itemInfo"]');
          const ebayTitle = specificLink ? specificLink.innerText.trim() : "";
          const label = Array.from(document.querySelectorAll("div,span,td,h2"))
            .find(el => el.innerText?.trim() === "Ship to" || el.innerText?.trim() === "Shipping address");
          let container = label ? label.parentElement : null;
          if (!container) {
            const zipEl = Array.from(document.querySelectorAll("*")).find(el =>
              el.children.length === 0 && /\b\d{5}(?:-\d{4})?\b/.test(el.innerText));
            container = zipEl ? zipEl.parentElement : null;
          }
          if (!container) return null;
          const rawText = container.innerText;
          const lines   = rawText.split(/[\n,]+/).map(l => l.trim())
            .filter(l => l && !/ship to|shipping address|united states|phone|buyer selected|tracking/i.test(l));
          const zipMatch   = rawText.match(/\b\d{5}(?:-\d{4})?\b/);
          const stateMatch = rawText.match(/\b([A-Z]{2})\b/);
          const broaderText = container.parentElement ? container.parentElement.innerText : rawText;
          const phoneMatch  = broaderText.match(/(?:\+?\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}/);
          const zip   = zipMatch   ? zipMatch[0]   : "";
          const state = stateMatch ? stateMatch[1] : "";
          const phone = phoneMatch ? phoneMatch[0] : "";
          const name  = lines[0] || "";
          const zipIdx = lines.findIndex(l => l.includes(zip) || (state && l.includes(state)));
          let address = "", city = "";
          if (zipIdx !== -1) { city = lines[zipIdx - 1] || ""; address = lines.slice(1, zipIdx - 1).join(", "); }
          else { address = lines[1] || ""; city = lines[2] || ""; }
          if (city && address.includes(city)) address = address.split(city)[0].replace(/[, ]+$/, "");
          return { name, address, city, state, zip, phone, ebayTitle };
        }
      });
      const buyer = results[0]?.result;
      if (!buyer || !buyer.name) { setStatus("❌ Address scrape failed"); return; }
      chrome.storage.local.set({ pendingBuyer: buyer }, () => {
        setStatus("✅ Saved: " + buyer.name + (buyer.ebayTitle ? " + Title" : ""));
      });

    } else if (tab.url.includes("amazon.com")) {
      chrome.storage.local.get(["pendingBuyer"], data => {
        if (!data.pendingBuyer) { setStatus("❌ Scrape from eBay order page first!"); return; }
        const buyer = data.pendingBuyer;
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (buyer) => {
            const primeDecline = document.getElementById("prime-decline-button");
            if (primeDecline) { primeDecline.click(); return "decline"; }
            const displayAddress = document.querySelector(".displayAddressFullName");
            const currentName    = displayAddress ? displayAddress.innerText.trim().toLowerCase() : "";
            const targetName     = buyer.name.trim().toLowerCase();
            const changeBtn      = document.querySelector('a[aria-label="Change delivery address"]');
            if (changeBtn && currentName !== targetName) { changeBtn.click(); return "changing"; }
            const nameInput = document.getElementById("address-ui-widgets-enterAddressFullName");
            if (nameInput) {
              if (nameInput.value.trim().toLowerCase() === targetName) {
                document.querySelector("#address-ui-widgets-form-submit-button input")?.click();
                return "saving";
              }
              return "injecting";
            }
            document.getElementById("add-new-address-desktop-sasp-tango-link")?.click();
            if (document.getElementById("add-new-address-desktop-sasp-tango-link")) return "adding";
            if (window.location.href.includes("/s?k=")) {
              const results = Array.from(document.querySelectorAll('[data-component-type="s-search-result"]'));
              const organic = results.find(el => !el.innerText.includes("Sponsored") && !el.querySelector(".puis-sponsored-label-text"));
              if (organic) { (organic.querySelector('[data-cy="title-recipe"] a.a-link-normal') || organic.querySelector("h2 a.a-link-normal"))?.click(); return "picked"; }
            }
            if (document.getElementById("buy-now-button") && window.location.href.includes("/dp/")) { document.getElementById("buy-now-button").click(); return "buynow"; }
            document.querySelector('input[data-testid="bottom-continue-button"]')?.click();
            const placeOrder = document.querySelector('input[data-testid="SPC_selectPlaceOrder"]') || document.querySelector('input[name="placeYourOrder1"]') || document.getElementById("placeOrder");
            if (placeOrder && currentName === targetName) { placeOrder.scrollIntoView({behavior:"smooth",block:"center"}); setTimeout(()=>placeOrder.click(),150); return "placed"; }
            return "none";
          },
          args: [buyer]
        }, results => {
          const action = results[0]?.result;
          const isCheckout = tab.url.includes("address-ui") || tab.url.includes("checkout");
          if (isCheckout || action === "injecting" || action === "adding") {
            setStatus("🚀 Injecting address...");
            chrome.scripting.executeScript({ target:{tabId:tab.id}, func:(d)=>{window.currentBuyer=d;}, args:[buyer] }, () => {
              chrome.scripting.executeScript({ target:{tabId:tab.id}, files:["fulfill_amazon.js"] });
            });
          } else if (action === "none" && buyer.ebayTitle && !tab.url.includes("/dp/")) {
            setStatus("🔍 Searching Amazon...");
            chrome.tabs.update(tab.id, { url: "https://www.amazon.com/s?k=" + encodeURIComponent(buyer.ebayTitle.trim()) });
          } else { setStatus("↩ " + action); }
        });
      });
    } else {
      setStatus("❌ Go to eBay (scrape) or Amazon (fulfill)");
    }
  });

  // ── Manual sync ─────────────────────────────────────────────────────────────
  document.getElementById("manualSync").addEventListener("click", () => {
    setStatus("🔄 Syncing prices...");
    chrome.runtime.sendMessage({ action: "trigger_sync" }, () => {
      setTimeout(() => { loadQueue(); setStatus("✅ Sync complete!"); }, 2000);
    });
  });

  document.getElementById("stopBulkListing")?.addEventListener("click", () => {
    setStatus("Stopping bulk listing safely...");
    chrome.runtime.sendMessage({ action: "stop_bulk_ebay_listing" }, response => {
      if (!response?.success) {
        setStatus("Could not stop bulk listing: " + (response?.error || "Unknown error"));
      }
    });
  });

  // ── SETTINGS: load form ─────────────────────────────────────────────────────
  function loadSettingsForm() {
    chrome.storage.local.get({
      categoryId: "", quantity: 1, defaultQuantity: 1, condition: "New",
      location: "United States", postalCode: "",
    }, data => {
      const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      set("defaultCategory",  data.categoryId);
      set("defaultQuantity",  parseInt(data.quantity || data.defaultQuantity, 10) || 1);
      set("defaultCondition", data.condition);
      set("defaultLocation",  data.location);
      set("defaultPostalCode",data.postalCode);
    });
  }

  // saveCredentials removed — credentials now managed server-side via SaaS auth

  // ── SETTINGS: save listing defaults ────────────────────────────────────────
  document.getElementById("saveDefaults").addEventListener("click", () => {
    const quantity = parseInt(document.getElementById("defaultQuantity").value) || 1;
    chrome.storage.local.set({
      categoryId:  document.getElementById("defaultCategory").value.trim(),
      quantity,
      defaultQuantity: quantity,
      condition:   document.getElementById("defaultCondition").value,
      location:    document.getElementById("defaultLocation").value.trim(),
      postalCode:  document.getElementById("defaultPostalCode").value.trim(),
    }, () => setStatus("✅ Listing defaults saved"));
  });

  // ── SETTINGS: Connect eBay — handled by account panel in auth init above ────

  // ── Live storage updates ────────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    loadQueue();
    if (changes.bulkListingJob?.newValue) {
      renderBulkListingJob(changes.bulkListingJob.newValue);
    }
  });

  // ── Initial load ────────────────────────────────────────────────────────────
  loadQueue();
  checkConnection();
  chrome.storage.local.get({ bulkListingJob: null }, data => renderBulkListingJob(data.bulkListingJob));
});


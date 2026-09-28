/**
 * ebay_orders.js — eBay Order Polling & Auto-Fulfillment Engine
 * ==============================================================
 * Polls eBay's GetOrders Trading API for new sales, then queues
 * them for automatic Amazon purchase (fulfillment).
 *
 * Flow:
 *  1. Poll eBay GetOrders every 15 minutes (via background alarm)
 *  2. For each new order, match it to a queue item by eBay ItemID
 *  3. Store the buyer's shipping address
 *  4. Open the Amazon product page and inject fulfill_amazon.js
 *     to auto-fill the buyer's address and place the order
 *
 * Import from background.js or popup.js.
 */

import { getValidToken } from "./ebay_api.js";

// ── Build GetOrders XML ──────────────────────────────────────────────────────

function buildGetOrdersXML(daysBack = 1) {
  const now  = new Date();
  const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const fmt = d => d.toISOString().replace(/\.\d{3}Z$/, ".000Z");

  return `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <CreateTimeFrom>${fmt(from)}</CreateTimeFrom>
  <CreateTimeTo>${fmt(now)}</CreateTimeTo>
  <OrderRole>Seller</OrderRole>
  <OrderStatus>Completed</OrderStatus>
  <Pagination>
    <EntriesPerPage>50</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
</GetOrdersRequest>`;
}

// ── Parse GetOrders response ─────────────────────────────────────────────────

function parseOrders(xmlText) {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(xmlText, "text/xml");

  const ack = doc.querySelector("Ack")?.textContent;
  if (ack === "Failure") {
    const errMsg = doc.querySelector("Errors LongMessage")?.textContent || "Unknown error";
    throw new Error(`GetOrders failed: ${errMsg}`);
  }

  const orderNodes = doc.querySelectorAll("OrderArray > Order");
  const orders = [];

  orderNodes.forEach(orderNode => {
    const orderId     = orderNode.querySelector("OrderID")?.textContent;
    const orderStatus = orderNode.querySelector("OrderStatus")?.textContent;
    const totalStr    = orderNode.querySelector("Total")?.textContent;
    const createdTime = orderNode.querySelector("CreatedTime")?.textContent;

    // Get the line items (what was purchased)
    const lineItems = [];
    orderNode.querySelectorAll("TransactionArray > Transaction").forEach(txn => {
      const itemId   = txn.querySelector("Item > ItemID")?.textContent;
      const title    = txn.querySelector("Item > Title")?.textContent;
      const qty      = txn.querySelector("QuantityPurchased")?.textContent;
      const price    = txn.querySelector("TransactionPrice")?.textContent;
      // SKU carries the Amazon ASIN (stored as base64 at listing time). It lives
      // on the Variation for multi-variation listings, otherwise on the Item.
      const sku      = (txn.querySelector("Variation > SKU")?.textContent
                        || txn.querySelector("Item > SKU")?.textContent
                        || txn.querySelector("SKU")?.textContent || "").trim();
      lineItems.push({ itemId, title, sku, quantity: parseInt(qty || "1"), price: parseFloat(price || "0") });
    });

    // Get buyer shipping address
    const shipping = orderNode.querySelector("ShippingAddress");
    const buyer = {
      name:    shipping?.querySelector("Name")?.textContent || "",
      address: shipping?.querySelector("Street1")?.textContent || "",
      address2: shipping?.querySelector("Street2")?.textContent || "",
      city:    shipping?.querySelector("CityName")?.textContent || "",
      state:   shipping?.querySelector("StateOrProvince")?.textContent || "",
      zip:     shipping?.querySelector("PostalCode")?.textContent || "",
      country: shipping?.querySelector("Country")?.textContent || "US",
      phone:   shipping?.querySelector("Phone")?.textContent || "",
    };

    // Get buyer eBay username
    const buyerUserId = orderNode.querySelector("BuyerUserID")?.textContent || "";

    orders.push({
      orderId,
      orderStatus,
      total: parseFloat(totalStr || "0"),
      createdTime,
      lineItems,
      buyer,
      buyerUserId,
      fulfilled: false,
    });
  });

  return orders;
}

// ── Poll for new orders ──────────────────────────────────────────────────────

/**
 * Fetches recent eBay orders and returns any that haven't been fulfilled yet.
 * Stores them in chrome.storage under "ebay_orders".
 */
export async function pollEbayOrders() {
  const data = await chrome.storage.local.get({
    clawdbot_worker_url: "",
    ebay_orders:         [],
  });

  if (!data.clawdbot_worker_url) {
    console.warn("ClawdBot Orders: No worker URL configured.");
    return [];
  }

  const token = await getValidToken();

  const xml = buildGetOrdersXML(2); // Check last 2 days

  const resp = await fetch(`${data.clawdbot_worker_url}/trading`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ call_name: "GetOrders", xml, token }),
  });

  if (!resp.ok) {
    throw new Error(`GetOrders failed: ${resp.status} ${await resp.text()}`);
  }

  const rawXml = await resp.text();
  console.log("ClawdBot Orders: Raw GetOrders response received");

  const orders = parseOrders(rawXml);

  // Merge with existing orders (don't duplicate)
  const existingIds = new Set(data.ebay_orders.map(o => o.orderId));
  const newOrders   = orders.filter(o => !existingIds.has(o.orderId));

  if (newOrders.length > 0) {
    const allOrders = [...newOrders, ...data.ebay_orders];
    await chrome.storage.local.set({ ebay_orders: allOrders });
    console.log(`ClawdBot Orders: ${newOrders.length} new orders found.`);
  }

  return newOrders;
}

// ── Match order to queue item and start fulfillment ──────────────────────────

/**
 * For each unfulfilled order, finds the matching Amazon product URL
 * from the queue and opens it in a tab with the buyer's address
 * ready for auto-fill.
 */
// The listing SKU is the Amazon ASIN encoded as base64 (see pasteSku in
// content_ebay_listing.js). Recover the ASIN from whatever form the SKU is in.
function decodeSkuToAsin(sku) {
  const raw = String(sku || "").trim();
  if (!raw) return "";
  const isAsin = v => /^[A-Z0-9]{10}$/i.test(v || "");
  // Preferred: base64(ASIN).
  try {
    const decoded = atob(raw);
    if (isAsin(decoded)) return decoded.toUpperCase();
  } catch (_) { /* not valid base64 */ }
  // Or the SKU is already the raw ASIN.
  if (isAsin(raw)) return raw.toUpperCase();
  // Or an ASIN embedded in a prefixed SKU.
  const m = raw.match(/B0[A-Z0-9]{8}/i);
  return m ? m[0].toUpperCase() : "";
}

export async function fulfillOrder(order) {
  const data = await chrome.storage.local.get({ queue: [] });

  for (const lineItem of order.lineItems) {
    // Resolve the Amazon target for this line item. The SKU (base64 ASIN) is the
    // most reliable key — it works even when the eBay ItemID wasn't saved on the
    // queue item and even when the item is no longer in the queue.
    const asin = decodeSkuToAsin(lineItem.sku);

    const queueItem =
      (lineItem.itemId && data.queue.find(p => p.ebayItemId === lineItem.itemId)) ||
      (asin && data.queue.find(p => String(p.asin || "").toUpperCase() === asin)) ||
      (lineItem.sku && data.queue.find(p => p.sku === lineItem.sku || p.ebaySku === lineItem.sku)) ||
      null;

    // Amazon URL: the queue item's saved URL, otherwise build it from the ASIN.
    const amazonUrl = queueItem?.url || (asin ? `https://www.amazon.com/dp/${asin}` : "");

    if (!amazonUrl) {
      console.warn(`ClawdBot Fulfill: Could not resolve Amazon item for order ${order.orderId} — itemId=${lineItem.itemId || "?"}, sku=${lineItem.sku || "none"}`);
      continue;
    }
    console.log(`ClawdBot Fulfill: order ${order.orderId} → ${asin ? "ASIN " + asin : amazonUrl} (${queueItem ? "queue match" : "resolved from SKU"})`);

    // Store the buyer info so fulfill_amazon.js can read it
    await chrome.storage.local.set({
      pendingBuyer: order.buyer,
      pendingOrderId: order.orderId,
      pendingAmazonUrl: amazonUrl,
    });

    // Open the Amazon product page
    const tab = await chrome.tabs.create({ url: amazonUrl, active: true });

    console.log(`ClawdBot Fulfill: Opened Amazon page for order ${order.orderId}, tab ${tab.id}`);

    // Wait for the page to load, then inject the auto-fill script
    return new Promise((resolve) => {
      const listener = async (tabId, changeInfo) => {
        if (tabId !== tab.id || changeInfo.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(listener);

        // Small delay for Amazon's SPA to finish rendering
        setTimeout(async () => {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files:  ["fulfill_amazon.js"],
            });
            console.log(`ClawdBot Fulfill: Injected fulfill script for order ${order.orderId}`);
          } catch (e) {
            console.error("ClawdBot Fulfill: Script injection failed:", e);
          }
          resolve();
        }, 3000);
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
}

/**
 * Mark an order as fulfilled in storage.
 */
export async function markOrderFulfilled(orderId) {
  const data = await chrome.storage.local.get({ ebay_orders: [] });
  const orders = data.ebay_orders.map(o =>
    o.orderId === orderId ? { ...o, fulfilled: true, fulfilledAt: Date.now() } : o
  );
  await chrome.storage.local.set({ ebay_orders: orders });
}

/**
 * Get all unfulfilled orders.
 */
export async function getUnfulfilledOrders() {
  const data = await chrome.storage.local.get({ ebay_orders: [] });
  return data.ebay_orders.filter(o => !o.fulfilled);
}

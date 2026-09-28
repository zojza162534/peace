# PhiloShip — Amazon→eBay Listing Process (End-to-End Scope)

A complete map of how a product travels from an Amazon page to a live eBay
listing, the files/functions at each step, and where things can still fail.

---

## The pipeline at a glance

```
Amazon page ──snipe──> Queue (storage) ──list──> eBay prelist ──> identify ──> draft (lstng) ──> fill ──> List it ──> live
   content_amazon        popup.js            background.js: runEbayListingFlow / runBulkListing
                                             content_ebay_listing.js: postEbayData
```

Two independent phases: **Capture (Snipe)** pulls product data off Amazon into a
local queue; **List** drives eBay's Sell flow to publish each queued item.
Everything runs from a single shared listing engine, so single-item and bulk
behave identically — bulk just loops the same function per item.

---

## Phase 1 — Capture (Snipe)

**Single** — popup "Snipe" button injects `content_amazon.js` into the open
Amazon product tab (`popup.js:747`). It scrapes:
- Title (`#productTitle`), price (core buy-box price), up to 12 images
- Brand, product type, category + required item specifics (color/material/size…)
- Description (Amazon feature bullets, sanitized of brand/marketplace words)
- **Rebate/coupon flag** (new) — detects "Save X% / coupon / promo" on the page
- Result is saved to the queue in `chrome.storage.local`.

**Bulk** — popup "Bulk Snipe" injects `content_amazon_bulk.js` into a search/
category page and captures many products at once into the same queue.

## Phase 2 — Queue (popup.js)

The queue tab renders each item with: Amazon price → calculated eBay price
(markup), net profit/margin, policy-flag warnings, a variations flag, and the
new **"💰 Rebate eligible"** badge. Titles can be optimized via
`title_generator.js`.

## Phase 3 — List orchestration (background.js)

Triggered by popup "List Selected" / "List All" → `start_bulk_ebay_listing` →
`runBulkListing()` loops the snapshot and calls `runEbayListingFlow()` per item.
(A single item can also go through `start_ebay_listing` → `runEbayListingFlow`.)

`runEbayListingFlow()` owns the whole eBay tab lifecycle:
1. Opens `ebay.com/sl/prelist/suggest`.
2. Injects `content_ebay_listing.js`, sends `insert_draft_details`.
3. **Prelist page** — types the title and submits → eBay routes to `/prelist/identify`.
4. **Identify page** — the content script auto-runs `handleIdentifyPage()`: clicks
   the category card, selects condition, and clicks Continue until eBay navigates
   to the real listing form `/lstng?draftId=…`.
5. **Draft (lstng) page** — re-injects the script and sends `insert_ebay_data`,
   which runs `postEbayData()` (the fill engine).

## Phase 4 — Fill engine (`postEbayData` in content_ebay_listing.js)

In order:
1. **Title** (`pasteTitle`)
2. **Brand** and **Form Factor**
3. **Category attributes** from `getEbayAttributesToFill` (color, material, etc.)
4. **Targeted fillers**: `fillColorSpecific`, `fillMaterialSpecific`,
   `fillStyleSpecific` (bags)
5. **General required pass** (`fillAllRequiredSpecifics`) — fills EVERY field eBay
   marks `.required-field` that's still empty (Style, Department, Occasion, …)
   with a derived value or a safe "Does Not Apply"
6. **Type**, then **Price** + **Quantity**, then **SKU**
7. **Shipping** (`setShipping`) — enables free shipping (seller pays) and
   recognizes drafts where shipping is already configured
8. **Images** — fetch each via the background worker (`url-to-b64`), convert to
   JPEG, upload to `#fehelix-uploader`, then **wait for the uploads to settle**
9. **Description** — insert our generated HTML directly into the RTE
   (`setDescription`), with a draft-API PUT fallback
10. **Photo guard** — refuse to submit if the draft has zero photos
11. **List it** → `waitForSuccess` → on validation errors, `remediateListingErrors`
    fills what eBay names and retries once; **duplicate listings are skipped**, not
    failed

## Phase 5 — Confirm & report

`waitForSuccess` watches for a success signal (success URL / `.success__header`
/ confirmation text / post-list CTA), bailing early on a validation error.
The result flows back to `background.js` → updates the item's queue status and
the bulk-job progress (listed / failed / skipped).

---

## Fix status

**Resolved this engagement**
- Purse item specifics: Exterior Material, Exterior Color, Style, Department —
  plus a general pass that fills any required field for any category
- Free-shipping detection (was misreading a checked checkbox as off)
- Image counter (was reading 0 despite photos → false "imageless" blocks)
- Infinite-hang bugs: unbounded image fetch, image decode, and draft-API PUTs
  now all time out
- Description: a proper generated description (features + specifics + shipping)
  reliably inserted into the RTE; removed the flaky "Use AI description" path
- Duplicate listings: detected and skipped instead of stopping the bulk run
- Image timing: explicit wait for photos to finish before "List it"; guard
  refuses photoless submits
- Rebate-eligible items flagged in the queue

**Remaining**
1. **Success detection (active blocker).** Items publish, but eBay does it in the
   background *without navigating away from the draft* — the "List it" button
   stays on screen. `waitForSuccess` looks for a page/URL change, so it never
   fires → 2-minute wait → bulk stops even though the item went live. Fix needs
   the exact on-page success signal (a toast? button state? a listed marker),
   which requires observing the stuck draft at the moment of success.
2. **Brand-only title.** Titles sometimes come through as just the brand
   ("LOVEVOOK", "KKXIU"). The eBay side sets the title correctly from
   `productData.title`; the brand-only value originates upstream in the Amazon
   scrape or eBay's catalog match. Not a publish blocker, but a quality issue.

---

## Where it can still go wrong (failure-point map)

| Stage | Risk | Current safeguard |
|---|---|---|
| Amazon scrape | Title comes back as brand only | Open item (title fix pending) |
| Prelist/identify | Category card never appears | Loops with waits (bounded pending) |
| Item specifics | New category needs a field we don't script | General `.required-field` pass + post-List remediation |
| Images | Slow/blocked URL, or race to List | Per-image timeout + settle-wait + photo guard |
| Description | Field left empty | Direct RTE insert + API-PUT fallback |
| Publish | Duplicate item | Detected → skipped, bulk continues |
| Confirm | Success not detected | **Open — the current blocker** |

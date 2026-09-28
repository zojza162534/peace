# Peace — Amazon → eBay Sniper

**Peace** is a Chrome extension (Manifest V3) that streamlines Amazon → eBay reselling: capture products from Amazon, list them on eBay with clean titles, descriptions, images and pricing, and assist with order fulfillment when an item sells.

It runs entirely in your own browser and talks to eBay through **your own** eBay Developer account and a small Cloudflare Worker that **you** deploy. There is no central server, and no data leaves your machine except the calls you make to eBay and Amazon yourself.

> ⚠️ **Please read the [Disclaimer](#disclaimer) before using.** Automated listing and fulfillment can conflict with Amazon's and eBay's Terms of Service. You are responsible for how you use this tool.

---

## Features

- **Capture** a single Amazon product into a queue with title, price, description and images.
- **Bulk Snipe** every organic (non-sponsored) result on an Amazon search or category page in one click.
- **Background enrichment** — bulk-captured items are automatically visited to pull full descriptions, images and item specifics.
- **One-click eBay listing** with clean 80-char titles, a structured HTML description, your markup, up to 12 images, free shipping and returns.
- **Required item-specifics filling** (e.g. handbag Exterior Material / Color / Style / Department) so listings actually go through.
- **Rebate/coupon flagging** — items with Amazon coupons or rebates are flagged in the queue.
- **Order fulfillment assist** — scrapes the eBay buyer's address and drives the Amazon checkout up to the final step, then **pauses and asks you to place the order** (it never spends money on its own).
- **Correct quantity** — the Amazon order quantity matches what the buyer bought on eBay.
- **Automatic eBay token refresh** while you're signed in, so you don't have to reconnect constantly.
- **Price monitoring** — periodic checks for Amazon price changes / out-of-stock, with desktop notifications.

---

## How it works

```
Amazon product page / search results
        │  (Capture or Bulk Snipe)
        ▼
   Queue (price, description, images, specifics)
        │  (List Queue)
        ▼
   Cloudflare Worker  ◄──►  eBay Trading API
        │
        ▼
   Live eBay listing (title, description, price, images)

   ...when it sells...

   eBay order page  ──►  scrape buyer address
        │
        ▼
   Amazon checkout (auto-filled)  ──►  PAUSE → you place the order
```

---

## Requirements

- Google Chrome (or a Chromium browser that supports MV3 extensions).
- A free **Cloudflare** account (to host the Worker proxy).
- A free **eBay Developer** account tied to your eBay **seller** account.
- An Amazon account for purchasing/fulfillment.

---

## Installation

1. **Download this repository** — click the green **Code** button → **Download ZIP**, then unzip it. (Or `git clone https://github.com/zojza162534/peace`.)
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the unzipped project folder.
5. The **Peace** icon appears in your toolbar. Pin it for easy access.

---

## One-time setup (~15 minutes)

### Step 1 — Deploy the Cloudflare Worker (free)

The Worker is a lightweight proxy that handles CORS and exchanges your eBay OAuth tokens. **Deploy your own** — don't rely on someone else's.

1. Go to <https://dash.cloudflare.com> and sign up (free) if needed.
2. **Workers & Pages** → **Create** → **Create Worker**.
3. Click **Edit Code**, delete the default code, and paste the entire contents of [`worker.js`](worker.js) from this repo.
4. Click **Save & Deploy**.
5. Copy your Worker URL — it looks like `https://peace.yourname.workers.dev`.

> **Optional security:** In the Worker → **Settings** → **Variables**, add `CLAWDBOT_SECRET` = any random string. If you set it, enter the same value in the extension settings.

### Step 2 — Create a free eBay Developer account

1. Go to <https://developer.ebay.com> and sign in with your **seller** eBay account.
2. **My Account** → **Application Keys** → **Create App Keys** (choose **Production**).
3. Note your **App ID (Client ID)** and **Cert ID (Client Secret)**.
4. Click **User Tokens** next to your App ID and create an **RuName** (redirect URL name). Note the RuName — it looks like `YourApp-abc12-PRD-xxxxxxx`.

### Step 3 — Configure the extension

1. Click the **Peace** icon → **Settings**.
2. Enter:
   - **Worker URL** (from Step 1)
   - **App ID** (eBay Client ID)
   - **Cert ID** (eBay Client Secret)
   - **RuName** (from Step 2)
   - **Worker secret** (only if you set `CLAWDBOT_SECRET`)
3. Click **Save**.
4. Click **Connect eBay Account** — an eBay login page opens. Sign in with your **seller** account and click **Agree**. The tab closes and a notification confirms the connection.

Your credentials are stored **locally** in the browser (`chrome.storage.local`) and are never committed to this repo or sent anywhere except eBay.

### Step 4 — Listing defaults (optional)

In **Settings → Listing Defaults**, set your default category, condition, markup %, and location/postal code.

---

## Daily workflow

**Snipe products**
- On an Amazon **product page**, click **Capture Product**.
- On an Amazon **search or category page**, click **Bulk Snipe Page** to grab every organic result at once. Full details fill in over the next minute as items are enriched in the background.

**List on eBay**
- Open the **List** tab and click **List Queue**. Each unlisted item goes live with a clean title, structured description, your marked-up price, up to 12 images, free shipping and 30-day returns.

**Fulfill an order**
1. Open the eBay order page and click **Fulfill Order** — Peace scrapes the buyer's name and address.
2. It opens/reuses an Amazon tab, finds the product, sets the correct quantity, and drives checkout up to the final confirmation.
3. **Peace pauses at "Place your order" and asks you to confirm.** Review the address, quantity and total, then place the order yourself.

**Monitor prices**
- The **Monitor** tab shows items whose Amazon price changed or went out of stock. Checks run automatically about every 60 minutes.

---

## Pricing math

```
eBay price = Amazon price × (1 + markup%)
Net profit = eBay price − Amazon price − eBay fees (~13.25% + $0.30)
```

The **Net** figure on each queue card is your estimated take-home after fees.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `NOT_CONNECTED` when listing | Settings → **Connect eBay Account**. |
| `Worker error 401` | Make sure `CLAWDBOT_SECRET` matches between the Worker and the extension (or clear it in both). |
| `eBay rejected listing` | Usually a category/required-specific issue — set a valid Category ID and re-list. |
| Listing didn't confirm | Reload the extension, make sure the build badge in the popup matches the latest, and retry. |
| Images missing on a listing | Some Amazon CDN URLs block eBay's crawler; the listing still goes live. |
| Rate-limit error (`21919144`) | eBay throttles rapid calls. Peace waits between listings — if hit, pause for an hour. |

---

## Project structure

| File | Purpose |
|---|---|
| `worker.js` | **Deploy to Cloudflare.** CORS proxy + eBay token exchange + image proxy. |
| `manifest.json` | MV3 extension manifest. |
| `background.js` | Service worker: orchestration, price sync, token refresh, fulfillment. |
| `popup.html` / `popup.js` / `popup.css` | The extension UI. |
| `content_amazon.js` | Scrapes a single Amazon product page. |
| `content_amazon_bulk.js` | Scrapes all organic results on an Amazon search/category page. |
| `content_ebay_listing.js` | Drives eBay's Sell flow (prelist → identify → draft → publish). |
| `content_ebay_orders.js` / `ebay_orders.js` | Reads eBay orders and matches them back to the Amazon source. |
| `fulfill_amazon.js` | Auto-fills the Amazon checkout and pauses before placing the order. |
| `ebay_api.js` | eBay OAuth + Trading API helpers. |
| `title_generator.js` / `item_specifics.js` / `utils.js` | Title cleanup, specifics mapping, shared helpers. |

---

## Contributing

Peace is built and maintained by **one person, working alone, in their spare time.** Bug reports and pull requests are welcome, but please be patient with response times. If you found this useful, the best way to support continued development is to [donate](#support-this-project) or share it.

---

## Support this project

I work on Peace **solo** — every feature, fix and support reply is just me. If it saves you time or makes you money, a donation genuinely helps me keep building and maintaining it.

- ❤️ **GitHub Sponsors:** <https://github.com/sponsors/zojza162534>
- 💸 **PayPal:** <https://paypal.me/ecreesebh>

Even a small one-off tip is appreciated. Thank you.

---

## Disclaimer

Peace is provided **as-is, for educational and personal use**, with no warranty of any kind.

- **Terms of Service:** Automated sourcing, listing, and fulfillment may violate the Terms of Service of Amazon, eBay, or both, and dropshipping from a retail marketplace (like Amazon) into eBay is restricted under eBay's dropshipping policy. Using this tool could put your accounts at risk of suspension. **You are solely responsible** for ensuring your use complies with all applicable platform policies and laws.
- **No affiliation:** This project is not affiliated with, endorsed by, or sponsored by Amazon, eBay, or Cloudflare. All trademarks belong to their respective owners.
- **Your credentials, your responsibility:** You supply your own eBay developer keys and deploy your own Worker. Keep them private.
- **No financial guarantees:** Nothing here is financial or business advice, and no profit is guaranteed.

By using Peace you accept these terms and assume all associated risk.

---

## License

Released under the [MIT License](LICENSE). © 2026 Zeke.

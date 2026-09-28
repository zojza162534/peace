/**
 * content_ebay.js
 * Injects captured Amazon product data into eBay's listing form.
 */
chrome.storage.local.get(["lastProduct", "markup"], data => {
  if (!data.lastProduct) {
    alert("ClawdBot: No product selected in the queue.");
    return;
  }

  const p = data.lastProduct;
  const markup = data.markup || 30;

  // Re-calculate the price based on current markup settings
  const amazonPrice = parseFloat(p.price);
  const ebayPrice = (amazonPrice + (amazonPrice * (markup / 100))).toFixed(2);

  // eBay listing field selectors (handling multiple possible versions of eBay's UI)
  const titleInput = document.querySelector('input[name="title"], #editpane_title, [aria-label="Title"]');
  const priceInput = document.querySelector('input[name="price"], #editpane_price, [aria-label="Price"]');

  if (!titleInput && !priceInput) {
    alert("ClawdBot: Could not find listing fields. Make sure you are on the eBay 'Create Listing' page.");
    return;
  }

  if (titleInput) {
    titleInput.value = p.title.substring(0, 80); // eBay limit is 80 chars
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  if (priceInput) {
    priceInput.value = ebayPrice;
    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  console.log("ClawdBot: Data injected into eBay listing.");
});
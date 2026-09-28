// utils.js - Pro Optimization Functions

/**
 * Words/phrases that trigger eBay error 240 (policy violation).
 * Must be stripped from titles AND descriptions before listing.
 */
const EBAY_BANNED = /\b(amazon|amazon\.com|amazons|prime|prime eligible|fulfilled by amazon|fba|amzn|walmart|target|alibaba|aliexpress|wish\.com|shopify|etsy|free shipping|free returns|free return|warranty|guaranteed|money back guarantee|best seller|bestseller|#1 best|exclusive|limited time|act now|order now|click here|buy now|add to cart|sponsored|advertisement|authentic guaranteed)\b/gi;

export function optimizeTitle(title) {
  if (!title) return "";
  return title
    .replace(EBAY_BANNED, "")                 // Remove eBay-banned words
    .replace(/Visit the .* Store/gi, "")      // Remove store references
    .replace(/\s\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 .,()\-\/&+#]/g, "") // Keep common safe chars
    .trim()
    .slice(0, 80); // eBay Max Length
}

export function calculatePrice(amazonPrice, markupPercent = 30) {
  const price = parseFloat(amazonPrice);
  const totalMarkup = markupPercent + 15; 
  return (price * (1 + totalMarkup / 100)).toFixed(2);
}

export function cleanDescription(desc) {
  if (!desc) return "";
  return desc
    .replace(EBAY_BANNED, "")
    .replace(/Visit the .* store/gi, "")
    .replace(/Amazon\.com/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getNetProfit(amazonCost, ebayPrice) {
  const ebayFeeRate = 0.1325;
  const fixedFee = 0.30;
  const totalFees = (ebayPrice * ebayFeeRate) + fixedFee;
  const netProfit = ebayPrice - amazonCost - totalFees;
  return {
    profit: netProfit.toFixed(2),
    margin: ((netProfit / ebayPrice) * 100).toFixed(1)
  };
}

export function productToCSV(queue, markup = 30) {
  const headers = [
    "Title", "ASIN", "Amazon Price", "eBay Price", "Net Profit",
    "Margin %", "Rating", "Has Variations", "Status", "Description", "Images", "URL"
  ];

  const rows = queue.map(p => {
    const ebayPrice = parseFloat(calculatePrice(p.price, markup));
    const { profit, margin } = getNetProfit(p.price, ebayPrice);
    const desc = cleanDescription(p.description || "");
    return [
      `"${(p.title || "").replace(/"/g, '""').slice(0, 80)}"`,
      p.id || "",
      p.price || "",
      ebayPrice,
      profit,
      margin,
      p.rating || "",
      p.hasVariations ? "Yes" : "No",
      p.status || "active",
      `"${desc.replace(/"/g, '""')}"`,
      `"${(p.images || []).join("|")}"`,
      `"${p.url || ""}"`
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

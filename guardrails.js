export function isValidAmazonProductPage() {
  const url = window.location.href;

  // Must be a product page
  const validPatterns = ["/dp/", "/gp/product/"];
  return validPatterns.some(p => url.includes(p));
}

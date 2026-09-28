/**
 * ClawdBot — Cloudflare Worker Proxy
 * ====================================
 * Routes:
 *  POST /oauth/token      — exchanges auth code or refresh token for eBay access token
 *  POST /trading          — proxies any eBay Trading API XML call
 *  GET  /img?u=<url>      — proxies Amazon images for eBay listings
 *  POST /image/proxy      — legacy image proxy (backwards compat)
 *  GET  /debug            — health check
 *
 * Security: X-ClawdBot-Secret header (optional, set CLAWDBOT_SECRET env var)
 */

const EBAY_TOKEN_URL  = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_TRADING_URL = "https://api.ebay.com/ws/api.dll";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-ClawdBot-Secret",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const secret = env.CLAWDBOT_SECRET;
    if (secret && request.headers.get("X-ClawdBot-Secret") !== secret) {
      return json({ error: "Unauthorized" }, 401);
    }

    const url = new URL(request.url);

    // ── GET /debug ────────────────────────────────────────────────────────────
    if (url.pathname === "/debug") {
      return json({
        status:  "ClawdBot Worker is running ✅",
        secret:  secret ? "set" : "not set (open access)",
        time:    new Date().toISOString(),
      });
    }

    // ── POST /oauth/token ─────────────────────────────────────────────────────
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const body = await request.json();
      const { client_id, client_secret, code, refresh_token, redirect_uri } = body;

      if (!client_id || !client_secret) {
        return json({ error: "Missing client_id or client_secret" }, 400);
      }

      const b64 = btoa(unescape(encodeURIComponent(`${client_id}:${client_secret}`)));

      let formParts;
      if (code) {
        if (!redirect_uri) return json({ error: "Missing redirect_uri for authorization_code grant" }, 400);
        formParts = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirect_uri)}`;
      } else if (refresh_token) {
        formParts = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh_token)}`;
      } else {
        return json({ error: "Provide code or refresh_token" }, 400);
      }

      const resp = await fetch(EBAY_TOKEN_URL, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          "Authorization": `Basic ${b64}`,
        },
        body: formParts,
      });

      const data = await resp.json().catch(() => ({ error: "non-JSON response from eBay" }));
      return json(data, resp.status);
    }

    // ── POST /trading ─────────────────────────────────────────────────────────
    if (url.pathname === "/trading" && request.method === "POST") {
      const body = await request.json();
      const { call_name, xml, token } = body;

      if (!call_name || !xml || !token) {
        return json({ error: "Missing call_name, xml, or token" }, 400);
      }

      const resp = await fetch(EBAY_TRADING_URL, {
        method:  "POST",
        headers: {
          "Content-Type":             "text/xml",
          "X-EBAY-API-CALL-NAME":     call_name,
          "X-EBAY-API-SITEID":        "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1155",
          "X-EBAY-API-IAF-TOKEN":     token,
        },
        body: xml,
      });

      const text = await resp.text();
      return new Response(text, {
        status:  resp.status,
        headers: { ...CORS_HEADERS, "Content-Type": "text/xml" },
      });
    }

    // ── GET /img?u=<encoded-amazon-url> ───────────────────────────────────────
    if (url.pathname === "/img" && request.method === "GET") {
      const imageUrl = url.searchParams.get("u");
      if (!imageUrl) return json({ error: "Missing ?u= parameter" }, 400);

      let parsedImg;
      try { parsedImg = new URL(imageUrl); } catch (_) {
        return json({ error: "Invalid image URL" }, 400);
      }
      const allowed = ["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-eu.ssl-images-amazon.com"];
      if (!allowed.some(d => parsedImg.hostname.endsWith(d))) {
        return json({ error: "Domain not allowed" }, 403);
      }

      const imgResp = await fetch(imageUrl, {
        headers: {
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept":          "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer":         "https://www.amazon.com/",
        },
        cf: { cacheEverything: true, cacheTtl: 86400 },
      });

      if (!imgResp.ok) {
        return json({ error: `Amazon returned ${imgResp.status}` }, 502);
      }

      const contentType = imgResp.headers.get("Content-Type") || "image/jpeg";
      const bytes = await imgResp.arrayBuffer();

      return new Response(bytes, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type":  contentType,
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // ── POST /image/proxy (legacy) ────────────────────────────────────────────
    if (url.pathname === "/image/proxy" && request.method === "POST") {
      const { image_url } = await request.json().catch(() => ({}));
      if (!image_url) return json({ error: "Missing image_url" }, 400);
      const proxyUrl = new URL(request.url);
      proxyUrl.pathname = "/img";
      proxyUrl.searchParams.set("u", image_url);
      return fetch(new Request(proxyUrl.toString(), { method: "GET", headers: request.headers }));
    }

    return json({ error: "Not found", routes: ["/oauth/token", "/trading", "/image/proxy", "/img", "/debug"] }, 404);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

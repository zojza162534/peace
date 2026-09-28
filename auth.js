/**
 * auth.js — PhiloShip SaaS auth layer
 * Handles login/signup, Google OAuth, token storage, and refresh.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — only this one constant needs to change per deployment
// ─────────────────────────────────────────────────────────────────────────────
export const WORKER_URL = "https://super-cake-aaff.ecreese.workers.dev"; // ← your Worker URL

// ─────────────────────────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────────────────────────
async function getAuth() {
  const data = await chrome.storage.local.get(["accessToken", "refreshToken", "userId"]);
  return data;
}

async function saveAuth({ accessToken, refreshToken, userId }) {
  await chrome.storage.local.set({ accessToken, refreshToken, userId });
}

export async function clearAuth() {
  await chrome.storage.local.remove(["accessToken", "refreshToken", "userId"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// API call wrapper — auto-refreshes expired JWT
// ─────────────────────────────────────────────────────────────────────────────
export async function apiFetch(path, options = {}) {
  const { accessToken, refreshToken } = await getAuth();

  const doFetch = (token) =>
    fetch(`${WORKER_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  let res = await doFetch(accessToken);

  // If 401 and we have a refresh token, try once to get a new access token
  if (res.status === 401 && refreshToken) {
    const refreshRes = await fetch(`${WORKER_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (refreshRes.ok) {
      const { accessToken: newToken } = await refreshRes.json();
      await chrome.storage.local.set({ accessToken: newToken });
      res = await doFetch(newToken);
    } else {
      // Refresh token itself is expired — force logout
      await clearAuth();
      throw new Error("SESSION_EXPIRED");
    }
  }

  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth actions
// ─────────────────────────────────────────────────────────────────────────────
export async function login(email, password) {
  const res  = await fetch(`${WORKER_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Login failed");
  await saveAuth(data);
  return data;
}

export async function register(email, password, name) {
  const res  = await fetch(`${WORKER_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Registration failed");
  await saveAuth(data);
  return data;
}

export async function logout() {
  const { refreshToken } = await getAuth();
  await fetch(`${WORKER_URL}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  }).catch(() => {});
  await clearAuth();
}

export async function loginWithGoogle() {
  // Just open the tab — background.js has a persistent tabs.onUpdated listener
  // that captures the /auth/success redirect and saves tokens to storage.
  // The popup's storage.onChanged listener then transitions to the main app.
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: `${WORKER_URL}/auth/google`, active: true }, () => {
      // Resolve immediately — the actual token arrival is signaled via
      // storage.onChanged in popup.js (set up in the auth init block).
      resolve();
    });
  });
}

export async function connectEbay() {
  const { accessToken } = await getAuth();
  if (!accessToken) throw new Error("Not logged in");
  // Pass JWT as a query param so the Worker knows which user is connecting
  await chrome.tabs.create({
    url: `${WORKER_URL}/ebay/connect?_token=${encodeURIComponent(accessToken)}`,
    active: true,
  });
}

export async function getMe() {
  const res  = await apiFetch("/auth/me");
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

export async function isLoggedIn() {
  const { accessToken, refreshToken } = await getAuth();
  return !!(accessToken || refreshToken);
}

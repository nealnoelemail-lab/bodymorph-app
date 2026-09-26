// ── AI call router ────────────────────────────────────────────────────────────
// PROXY-ONLY. Every Claude / Grok call goes through our server proxy, which holds the
// vendor keys server-side and gates on a signed-in Supabase user. There is NO direct-
// to-vendor path and NO vendor key in the browser bundle — so a scraped bundle can't
// be used to spend money. Requires VITE_API_BASE (the deployed proxy URL); without it
// the AI helpers throw rather than fall back to a bundled key.
// (History: a bundled Anthropic key WAS scraped from the web bundle and abused — hence
// proxy-only. Never reintroduce a direct-vendor branch here.)
import { supabase } from "./supabase.js";

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
export const USE_PROXY = !!API_BASE;

const NO_PROXY = "AI proxy not configured (VITE_API_BASE unset). Refusing to call the vendor directly — set the proxy URL.";

// ── The proxy's auth gate: a LIVE Supabase access token ─────────────────────────
// Access tokens last about an hour. Supabase refreshes them on a background timer,
// but iOS suspends timers while an app is backgrounded — so an app left open
// overnight wakes up holding a dead token, the proxy answers 401, and the feature
// looks broken until you force-quit (which mints a fresh one on launch). That's the
// "I had to close the app and reopen it" report.
//
// So: refresh BEFORE the call if the token is expired or nearly so, rather than
// trusting a timer that may not have fired.
const REFRESH_MARGIN_S = 120;   // treat "expires in under 2 min" as already expired

async function freshToken(force = false) {
  try {
    const { data } = await supabase.auth.getSession();
    const session = data?.session;
    if (!session) return null;
    const expiresAt = session.expires_at || 0;          // seconds since epoch
    const stale = force || !expiresAt || expiresAt - Date.now() / 1000 < REFRESH_MARGIN_S;
    if (!stale) return session.access_token;
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    if (error) return session.access_token;             // offline: try the old one anyway
    return refreshed?.session?.access_token || session.access_token;
  } catch { return null; }
}

async function authHeader(force = false) {
  const t = await freshToken(force);
  return t ? { authorization: `Bearer ${t}` } : {};
}

// Re-arm Supabase's own refresh timer when the app comes back to the foreground.
// Without this the timer stays stopped after a long background and every token the
// app holds drifts out of date. Native/Capacitor only concern, harmless on web.
export function startAuthKeepAlive() {
  if (!supabase?.auth?.startAutoRefresh) return;
  const sync = () => {
    if (document.visibilityState === "visible") supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  };
  document.addEventListener("visibilitychange", sync);
  sync();
}

// Anthropic Messages. Pass the request body object (not stringified). Returns the raw
// fetch Response so callers can `.json()` it OR stream it (body.getReader()) unchanged.
export async function anthropicFetch(body, opts = {}) {
  if (!USE_PROXY) throw new Error(NO_PROXY);
  const send = async (force) => fetch(`${API_BASE}/api/anthropic`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader(force)) },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const res = await send(false);
  // A 401 means the token we just sent was dead anyway. Force a new one and try once
  // more, so a stale session costs a second rather than a failed photo.
  if (res.status === 401) return send(true);
  return res;
}

// Grok speech-to-text. Pass a FormData (the audio clip). Returns the Response.
export async function grokSttFetch(formData, opts = {}) {
  if (!USE_PROXY) throw new Error(NO_PROXY);
  return fetch(`${API_BASE}/api/grok-stt`, {
    method: "POST",
    headers: { ...(await authHeader()) }, // let the browser set the multipart boundary
    body: formData,
    signal: opts.signal,
  });
}

// Grok batch text-to-speech. Pass the request body object. Returns the Response (audio).
export async function grokTtsFetch(body, opts = {}) {
  if (!USE_PROXY) throw new Error(NO_PROXY);
  return fetch(`${API_BASE}/api/grok-tts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

// Barcode -> food facts (Open Food Facts, via our proxy). Returns the normalized
// object the endpoint builds: { found:false } or { found:true, name, nova, per100g, … }.
// `nova` is null when the product has no processing classification — callers must show
// no badge in that case rather than guessing.
export async function lookupBarcode(barcode, opts = {}) {
  if (!USE_PROXY) throw new Error(NO_PROXY);
  const res = await fetch(`${API_BASE}/api/openfoodfacts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ barcode }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let msg = `Lookup failed (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

// A short-lived OpenAI Realtime client secret for the speech-to-speech coach. The
// persona and tools are sent up here so the session is stamped with them at creation;
// the real OPENAI_KEY stays on the server. Returns { value, expires_at, session }.
export async function openaiRealtimeToken({ instructions, tools, voice, model } = {}) {
  if (!USE_PROXY) throw new Error(NO_PROXY);
  const res = await fetch(`${API_BASE}/api/openai-token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ instructions, tools, voice, model }),
  });
  if (!res.ok) {
    let msg = `Realtime token failed (${res.status})`;
    try { const j = await res.json(); if (j?.error) msg = typeof j.error === "string" ? j.error : (j.error.message || msg); } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

export const PROXY_BASE = API_BASE;

// Keep the proxy's serverless functions warm during a voice session so a turn never
// pays a cold-start penalty. OPTIONS is a CORS preflight the functions answer instantly
// (before any auth/work), so it spins the Node instance up cheaply. Each function is a
// SEPARATE serverless function, so we ping all three the voice pipeline uses.
// Fire-and-forget; errors are irrelevant (the point is just to wake the instance).
export function warmProxy() {
  if (!USE_PROXY) return;
  for (const path of ["/api/anthropic", "/api/grok-stt", "/api/grok-token"]) {
    fetch(`${API_BASE}${path}`, { method: "OPTIONS" }).catch(() => {});
  }
}

// The user's Supabase access token — the native STT proxy uses it to authenticate.
export async function supabaseAccessToken() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch { return null; }
}

// A CACHED short-lived xAI ephemeral token for the native streaming-TTS WebSocket.
// The token expires in ~10 min, so we cache it and re-mint ~1 min before expiry —
// JS hands the current one to native on every speak(). Returns null in direct mode.
let _grokTok = null, _grokTokExp = 0;
// forceRefresh=true bypasses the cache and mints a brand-new token — used to RECOVER
// from a failed TTS socket (a stale/expired token re-mints cleanly). On a forced
// mint failure we return null (NOT the stale token) so the caller can fall through.
export async function grokEphemeralToken(forceRefresh = false) {
  if (!USE_PROXY) return null;
  const now = Date.now();
  if (!forceRefresh && _grokTok && now < _grokTokExp - 60000) return _grokTok; // reuse while it has >1 min left
  try {
    const res = await fetch(`${API_BASE}/api/grok-token`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
    });
    if (!res.ok) return forceRefresh ? null : _grokTok;
    const data = await res.json();
    const tok = data?.value || data?.client_secret?.value || data?.token || null;
    if (tok) { _grokTok = tok; _grokTokExp = data?.expires_at ? data.expires_at * 1000 : now + 540000; }
    return _grokTok;
  } catch { return forceRefresh ? null : _grokTok; }
}

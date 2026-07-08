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

// The user's Supabase access token — the proxy's auth gate.
async function authHeader() {
  try {
    const { data } = await supabase.auth.getSession();
    const t = data?.session?.access_token;
    return t ? { authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

// Anthropic Messages. Pass the request body object (not stringified). Returns the raw
// fetch Response so callers can `.json()` it OR stream it (body.getReader()) unchanged.
export async function anthropicFetch(body, opts = {}) {
  if (!USE_PROXY) throw new Error(NO_PROXY);
  return fetch(`${API_BASE}/api/anthropic`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
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

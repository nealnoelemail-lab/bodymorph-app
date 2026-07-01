// ── AI call router ────────────────────────────────────────────────────────────
// Sends Claude / Grok calls through our server proxy (keys held server-side) when
// VITE_API_BASE is set. Until then, falls back to calling the vendor DIRECTLY with
// the bundled VITE key — so the app keeps working unchanged during the migration.
// Flip the switch by setting VITE_API_BASE to the deployed Vercel URL.
import { supabase } from "./supabase.js";

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, "");
export const USE_PROXY = !!API_BASE;

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
  if (USE_PROXY) {
    return fetch(`${API_BASE}/api/anthropic`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  }
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

// Grok speech-to-text. Pass a FormData (the audio clip). Returns the Response.
export async function grokSttFetch(formData, opts = {}) {
  if (USE_PROXY) {
    return fetch(`${API_BASE}/api/grok-stt`, {
      method: "POST",
      headers: { ...(await authHeader()) }, // let the browser set the multipart boundary
      body: formData,
      signal: opts.signal,
    });
  }
  return fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { authorization: `Bearer ${import.meta.env.VITE_XAI_KEY}` },
    body: formData,
    signal: opts.signal,
  });
}

// Grok batch text-to-speech. Pass the request body object. Returns the Response (audio).
export async function grokTtsFetch(body, opts = {}) {
  if (USE_PROXY) {
    return fetch(`${API_BASE}/api/grok-tts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  }
  return fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${import.meta.env.VITE_XAI_KEY}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

export const PROXY_BASE = API_BASE;

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
export async function grokEphemeralToken() {
  if (!USE_PROXY) return null;
  const now = Date.now();
  if (_grokTok && now < _grokTokExp - 60000) return _grokTok; // reuse while it has >1 min left
  try {
    const res = await fetch(`${API_BASE}/api/grok-token`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeader()) },
    });
    if (!res.ok) return _grokTok;
    const data = await res.json();
    const tok = data?.value || data?.client_secret?.value || data?.token || null;
    if (tok) { _grokTok = tok; _grokTokExp = data?.expires_at ? data.expires_at * 1000 : now + 540000; }
    return _grokTok;
  } catch { return _grokTok; }
}

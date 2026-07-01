// Self-contained helpers for the AI-proxy endpoints. Kept SEPARATE from server.js
// (which holds Stripe + the Supabase SERVICE-ROLE client) on purpose: the AI proxy
// only needs to VERIFY that the caller is a signed-in user — something the PUBLIC anon
// key can do — so it doesn't need the service-role key at all. Clients are created
// LAZILY so a missing env var returns a clean 401/500 instead of crashing the function
// on import (which is what made every endpoint 500 on the preview).
import { createClient } from "@supabase/supabase-js";

// Accept the non-prefixed server vars OR the VITE_-prefixed ones already in the project
// (the prefix only matters for the client BUILD; the server can read either).
const SUPA_URL = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPA_ANON = () => process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = SUPA_URL(), anon = SUPA_ANON();
  if (!url || !anon) return null;
  _sb = createClient(url, anon, { auth: { persistSession: false } });
  return _sb;
}

// True if the Supabase env needed to verify tokens is present.
export const authConfigured = () => !!(SUPA_URL() && SUPA_ANON());

// ── Local JWT verification (fast path) ──────────────────────────────────────
// Supabase signs access tokens with ES256; the matching PUBLIC keys live at the
// project's JWKS endpoint. Verifying the signature locally (JWKS cached in memory)
// avoids a network round-trip to Supabase's auth server on EVERY proxy call — which
// was both a per-call delay and rate-limited (the intermittent voice lag). jose is
// imported dynamically inside try/catch: if it can't load or the token doesn't
// verify, we fall back to getUser() below, so auth is never WORSE than before.
let _jwks = null;
async function verifyLocally(token) {
  try {
    const url = SUPA_URL();
    if (!url) return null;
    const { jwtVerify, createRemoteJWKSet } = await import("jose");
    if (!_jwks) _jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, _jwks);   // checks signature + expiry
    if (!payload?.sub) return null;
    return { id: payload.sub, email: payload.email || null, role: payload.role || null };
  } catch { return null; }
}

// Verify the caller's Supabase access token (Authorization: Bearer …). Returns the
// user object, or null if the token is missing/invalid (or Supabase isn't configured).
export async function authUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const local = await verifyLocally(token);   // fast: local signature check, no round-trip
  if (local) return local;
  const client = sb();                         // fallback: ask Supabase (legacy path)
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch { return null; }
}

// Permissive CORS for the proxy (native + web call it cross-origin; the Bearer token is
// the real security gate, not the origin). Returns true on an OPTIONS preflight.
export function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

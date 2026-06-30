// Self-contained helpers for the AI-proxy endpoints. Kept SEPARATE from server.js
// (which holds Stripe + the Supabase SERVICE-ROLE client) on purpose: the AI proxy
// only needs to VERIFY that the caller is a signed-in user — something the PUBLIC anon
// key can do — so it doesn't need the service-role key at all. Clients are created
// LAZILY so a missing env var returns a clean 401/500 instead of crashing the function
// on import (which is what made every endpoint 500 on the preview).
import { createClient } from "@supabase/supabase-js";

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  _sb = createClient(url, anon, { auth: { persistSession: false } });
  return _sb;
}

// True if the Supabase env needed to verify tokens is present.
export const authConfigured = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);

// Verify the caller's Supabase access token (Authorization: Bearer …). Returns the
// user object, or null if the token is missing/invalid (or Supabase isn't configured).
export async function authUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const client = sb();
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

// Shared server-side helpers for the Vercel /api functions (Stripe billing).
// These run on the server only — they hold the Stripe secret + Supabase
// service-role key and must NEVER be imported into client (src/) code.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

// Service-role Supabase client — bypasses RLS so the webhook can write
// entitlement that the browser is not allowed to forge.
export const admin = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false } }
);

// Verify the caller's Supabase access token (sent as `Authorization: Bearer …`)
// and return the user, or null if missing/invalid.
export async function getUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) return null;
  return data?.user || null;
}

// Collect the raw request body (needed for Stripe webhook signature checks).
export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

// The app's base URL for Stripe redirect/return URLs.
export const appUrl = (req) => process.env.APP_URL || `https://${req.headers.host}`;

// Permissive CORS for the AI-proxy endpoints. The native app (origin
// capacitor://localhost) and the web app both call these cross-origin. Safe to allow
// any origin because EVERY proxy endpoint requires a valid Supabase Bearer token —
// the token is the real security gate, not the origin. Returns true if the request was
// an OPTIONS preflight (caller should end the response).
export function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return true; }
  return false;
}

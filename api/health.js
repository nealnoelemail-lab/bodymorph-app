// Public, no-auth health check for the AI proxy. Confirms this deployment actually
// has the new functions AND reports whether each required env var is present — as
// BOOLEANS only (never the secret values). Temporary diagnostic; safe to delete once
// the proxy is verified.
import { authConfigured } from "./_lib/proxy.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    ok: true,
    deploy: "launch-prep proxy v3",
    env: {
      // Supabase: client + server both use the VITE_ ones (safe-to-be-public).
      supabase: !!((process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) && (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY)),
      // Secrets: server-only, NO prefix.
      anthropicKey: !!process.env.ANTHROPIC_KEY,
      xaiKey: !!process.env.XAI_KEY,
    },
    authReady: authConfigured(),
    // Relevant var NAMES present on this deployment (names only, never values).
    seen: Object.keys(process.env).filter(k => /SUPA|ANTHROP|XAI/i.test(k)).sort(),
    time: new Date().toISOString(),
  });
}

// Public, no-auth health check for the AI proxy. Confirms this deployment actually
// has the new functions AND reports whether each required env var is present — as
// BOOLEANS only (never the secret values). Temporary diagnostic; safe to delete once
// the proxy is verified.
import { authConfigured } from "./_lib/proxy.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    ok: true,
    deploy: "launch-prep proxy v2",
    env: {
      supabaseUrl: !!process.env.SUPABASE_URL,
      supabaseAnonKey: !!process.env.SUPABASE_ANON_KEY,
      anthropicKey: !!process.env.ANTHROPIC_KEY,
      xaiKey: !!process.env.XAI_KEY,
    },
    authReady: authConfigured(),
    time: new Date().toISOString(),
  });
}

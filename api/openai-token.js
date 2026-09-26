// Mints a SHORT-LIVED OpenAI Realtime client secret for the speech-to-speech coach.
// Same pattern as grok-token.js: the real OPENAI_KEY never leaves the server, the app
// receives only a throwaway secret and connects DIRECTLY to OpenAI with it, so there's
// no relay hop in the audio path. Auth-gated to signed-in BodyMorph users.
//
// PROXY-ONLY RULE: there is no VITE_OPENAI_KEY and there must never be one. A bundled
// vendor key was scraped from this app's web bundle once and ran up a large bill; every
// paid vendor since talks to us server-side or through a short-lived token like this.
import { authUser, applyCors, authConfigured } from "./_lib/proxy.js";

// Overridable per request so we can A/B models and voices without a redeploy.
const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || "verse";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!authConfigured()) return res.status(500).json({ error: "Server missing SUPABASE_URL / SUPABASE_ANON_KEY" });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const key = process.env.OPENAI_KEY;
  if (!key) return res.status(500).json({ error: "Server missing OPENAI_KEY" });

  const body = req.body || {};
  // The caller supplies the coach's instructions and tools; this endpoint only holds
  // the key and stamps the session, so the persona stays in one place in the app.
  const session = {
    type: "realtime",
    model: body.model || DEFAULT_MODEL,
    ...(body.instructions ? { instructions: body.instructions } : {}),
    ...(body.tools ? { tools: body.tools } : {}),
    audio: {
      output: { voice: body.voice || DEFAULT_VOICE },
      ...(body.audio || {}),
    },
  };

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ session }),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", "application/json");
    return res.send(text);
  } catch (e) {
    console.error("openai-token proxy:", e);
    return res.status(502).json({ error: e.message });
  }
}

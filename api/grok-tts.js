// Server-side proxy for xAI Grok batch text-to-speech (the non-streaming fallback
// path used on web / when native streaming isn't available). Holds XAI_KEY; returns
// the audio bytes. Auth-gated.
import { authUser, applyCors, authConfigured } from "./_lib/proxy.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!authConfigured()) return res.status(500).json({ error: "Server missing SUPABASE_URL / SUPABASE_ANON_KEY" });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const key = process.env.XAI_KEY;
  if (!key) return res.status(500).json({ error: "Server missing XAI_KEY" });

  try {
    const upstream = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).json({ error: errText });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(200);
    res.setHeader("content-type", upstream.headers.get("content-type") || "audio/mpeg");
    return res.send(buf);
  } catch (e) {
    console.error("grok-tts proxy:", e);
    return res.status(502).json({ error: e.message });
  }
}

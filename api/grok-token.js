// Mints a SHORT-LIVED xAI ephemeral token for the native streaming-TTS WebSocket.
// The real XAI_KEY stays on the server; the app receives only a throwaway token and
// connects DIRECTLY to xAI with it (no relay hop → streaming latency preserved).
// xAI's recommended pattern for mobile apps. Auth-gated to signed-in users.
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
    const upstream = await fetch("https://api.x.ai/v1/realtime/client_secrets", {
      method: "POST",
      headers: { "authorization": `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ expires_after: { seconds: 600 } }),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", "application/json");
    return res.send(text);
  } catch (e) {
    console.error("grok-token proxy:", e);
    return res.status(502).json({ error: e.message });
  }
}

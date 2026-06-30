// Server-side proxy for the Anthropic Messages API. Holds ANTHROPIC_KEY so the app
// never ships it. Auth-gated to signed-in BodyMorph users (Supabase Bearer token).
// Forwards the client's request body verbatim and supports BOTH a single JSON
// response AND streaming (SSE) — the voice coach streams (stream:true).
import { getUser, applyCors } from "./_lib/server.js";

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const key = process.env.ANTHROPIC_KEY;
  if (!key) return res.status(500).json({ error: "Server missing ANTHROPIC_KEY" });

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body || {}),
    });

    // Streaming (SSE) passthrough for the live voice coach.
    if (req.body && req.body.stream) {
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") || "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
      });
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    }

    // Single response: forward status + body unchanged.
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", "application/json");
    return res.send(text);
  } catch (e) {
    console.error("anthropic proxy:", e);
    return res.status(502).json({ error: e.message });
  }
}

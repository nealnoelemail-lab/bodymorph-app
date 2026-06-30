// Server-side proxy for xAI Grok speech-to-text. Holds XAI_KEY so the app never
// ships it. Auth-gated. The client sends a multipart/form-data body (the audio clip);
// we forward the raw bytes untouched with the same content-type.
import { getUser, applyCors } from "./_lib/server.js";

// Don't let the platform parse the multipart body — we forward it raw.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const key = process.env.XAI_KEY;
  if (!key) return res.status(500).json({ error: "Server missing XAI_KEY" });

  try {
    const chunks = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    const body = Buffer.concat(chunks);

    const upstream = await fetch("https://api.x.ai/v1/stt", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${key}`,
        "content-type": req.headers["content-type"] || "multipart/form-data",
      },
      body,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    console.error("grok-stt proxy:", e);
    return res.status(502).json({ error: e.message });
  }
}

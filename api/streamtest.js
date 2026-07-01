// TEMPORARY diagnostic — verifies whether Vercel streams a Node function's res.write()
// chunks incrementally (needed for native voice streaming) or buffers them to the end.
// DELETE after use. No auth on purpose (it returns nothing sensitive).
export default async function handler(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  });
  for (let i = 1; i <= 5; i++) {
    res.write(`data: chunk ${i} sent at +${i * 500}ms\n\n`);
    await new Promise((r) => setTimeout(r, 500));
  }
  res.end();
}

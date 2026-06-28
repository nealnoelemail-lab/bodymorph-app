import { supabase } from "./supabase";

// ── PROGRESS-PHOTO STORAGE ──────────────────────────────────────────────────────
// Private "progress-photos" bucket. Body entries store the path "{uid}/{date}/{angle}.jpg";
// bytes live in Storage and render via short-lived signed URLs. No backend / failure ->
// callers fall back to keeping the inline base64 dataURL (offline-safe, unchanged UX).

const BUCKET = "progress-photos";

// A value is a Storage path (vs a legacy/inline base64 image) when it's not a data: URL.
export const isStoragePath = (v) => typeof v === "string" && v.length > 0 && !v.startsWith("data:");

// Upload a compressed dataURL to Storage; returns the path, or null on failure.
export async function uploadPhoto(userId, date, angle, dataURL) {
  if (!supabase || !userId || !dataURL) return null;
  try {
    const blob = await (await fetch(dataURL)).blob();
    const path = `${userId}/${date}/${angle}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: true });
    if (error) { console.warn("uploadPhoto:", error.message); return null; }
    return path;
  } catch (e) { console.warn("uploadPhoto:", e.message); return null; }
}

// Resolve a signed URL for a Storage path (cached for the URL's lifetime).
const _cache = new Map(); // path -> { url, exp }
export async function signedPhotoUrl(path) {
  if (!supabase || !isStoragePath(path)) return null;
  const hit = _cache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) { console.warn("signedPhotoUrl:", error.message); return null; }
  _cache.set(path, { url: data.signedUrl, exp: Date.now() + 55 * 60 * 1000 });
  return data.signedUrl;
}

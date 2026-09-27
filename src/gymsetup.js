// ── GYM ORIENTATION: capture, identify, store ───────────────────────────────────
// The client walks their gym photographing each machine — front, then side — and the
// app builds their equipment profile. Every exercise in their program afterwards
// shows the actual machine THEY walk up to, rather than a name like "pec deck" that
// means nothing to someone who has never been shown one.
//
// Two angles on purpose: a front shot alone is often ambiguous (a seated row and a
// chest-supported row look near identical head-on), and the side view is what
// separates them.
//
// Narration is OPTIONAL. Everything here works silently; a caller that has a voice
// coach running passes a `say` function and the same flow is spoken aloud. Nothing
// in this file knows or cares which voice engine is active.
import { supabase } from "./supabase";
import { anthropicFetch } from "./aiproxy";
import { EQUIPMENT, baseId, classifyCapture, captureLine, isAccessory } from "./equipment";

const BUCKET = "gym-equipment";

const VOCAB = Object.keys(EQUIPMENT).join(", ");

const prompt = (twoPhotos) => `${twoPhotos
  ? "These are two photos of ONE piece of gym equipment — a front view and a side view."
  : "This is one photo of a single piece of gym equipment. It may be a machine, or it may be loose kit — a kettlebell, a medicine ball, a band, a rope, or a bar or handle that clips onto a cable."}

Identify it. Reply ONLY with JSON, no markdown:
{"id":"...","label":"...","detail":"","usedFor":"...","confidence":"high|medium|low","variant":false}

- "id" MUST be one of exactly these: ${VOCAB}
  Use "other" if it is genuinely none of them (a machine the list doesn't cover, or not gym equipment at all).
- "label": what a trainer would call it, 1-4 words.
- "detail": for loose kit and cable attachments only, the size or grip printed or plainly visible — "10 lb", "25 kg", "wide grip", "heavy". Leave it "" if nothing is legible. Do NOT guess a weight from apparent size; an unlabelled ball is "".
- "usedFor": the muscle or movement it trains, under 8 words ("chest flyes", "hamstring curls"). This gets read aloud to someone who may not know.
- "confidence": how sure you are of the identification. Say "low" freely — a wrong guess here silently corrupts their whole program.
- "variant": true ONLY if this is a genuinely different KIND of machine rather than a different brand or model — a curved sprint treadmill versus a motorised one, a 45-degree leg press versus a horizontal one. Different manufacturer, colour or age is NOT a variant.

If ${twoPhotos ? "the two photos show different machines, or either is" : "the photo is"} too blurry or too far away to identify, set confidence "low" and say so in "label".`;

// Identify one piece of equipment. The side photo is OPTIONAL: a machine needs two
// angles to tell a seated row from a chest-supported one, but a resistance band has no
// meaningful side view, and asking for one is a pointless second photo.
export async function identifyEquipment(frontDataUrl, sideDataUrl) {
  const img = (dataUrl) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: dataUrl.split(",")[1] },
  });
  const photos = sideDataUrl ? [img(frontDataUrl), img(sideDataUrl)] : [img(frontDataUrl)];
  const body = {
    model: "claude-opus-4-8",
    max_tokens: 400,
    messages: [{ role: "user", content: [...photos, { type: "text", text: prompt(!!sideDataUrl) }] }],
  };
  const res = await anthropicFetch(body);
  if (!res.ok) {
    if (res.status === 401) throw new Error("Your session expired. Close BodyMorph fully and reopen it.");
    throw new Error(`Couldn't read that one (${res.status}).`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Vision error");
  const text = (data.content && data.content[0] && data.content[0].text) || "";
  const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  return {
    id: String(parsed.id || "other"),
    label: String(parsed.label || "Unknown").trim(),
    detail: String(parsed.detail || "").trim(),
    usedFor: String(parsed.usedFor || "").trim(),
    confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
    variant: parsed.variant === true,
  };
}

// The client's saved gym. Shaped for equipment.js (an `items` array of {id}).
export async function loadGym(userId, gymName = null) {
  if (!supabase || !userId) return { items: [] };
  let q = supabase.from("gym_equipment").select("*").eq("user_id", userId);
  if (gymName) q = q.eq("gym_name", gymName);
  const { data, error } = await q;
  if (error) { console.warn("loadGym:", error.message); return { items: [] }; }
  return { items: (data || []).map((r) => ({ ...r, id: r.equip_id })) };
}

async function upload(userId, equipId, angle, dataUrl) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${userId}/${equipId.replace(/\//g, "_")}/${angle}.jpg`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg", upsert: true });
    if (error) { console.warn("gym upload:", error.message); return null; }
    return path;
  } catch (e) { console.warn("gym upload:", e.message); return null; }
}

// Signed URLs for showing a machine's photo on an exercise tile.
const _urlCache = new Map();
export async function gymPhotoUrl(path) {
  if (!supabase || !path) return null;
  const hit = _urlCache.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) return null;
  _urlCache.set(path, { url: data.signedUrl, exp: Date.now() + 55 * 60 * 1000 });
  return data.signedUrl;
}

// ── One machine, end to end ─────────────────────────────────────────────────────
// Identify -> decide (new / duplicate / variant) -> store if it's worth storing.
// Returns { action, line, item } where `line` is what to say or show.
//
// A duplicate never uploads. That's the whole point of the dedup: a gym with thirty
// treadmills should cost one photo pair and one API call, not thirty.
export async function captureMachine({ userId, gym, frontDataUrl, sideDataUrl, gymName = null, say }) {
  const speak = (t) => { try { say && say(t); } catch { /* narration is optional */ } };

  const ident = await identifyEquipment(frontDataUrl, sideDataUrl);

  if (ident.id === "other" || ident.confidence === "low") {
    const line = ident.confidence === "low"
      ? "I can't make that one out clearly — try again from a step or two back."
      : `That's not one I recognise. Skip it for now and carry on.`;
    speak(line);
    return { action: "unclear", line, ident };
  }

  const decision = classifyCapture(gym, ident);
  // Loose kit carries its size or grip in the label, because that's the part that tells
  // one from another on the shelf — "Medicine ball" alone doesn't help you pick.
  const base = ident.label || (EQUIPMENT[baseId(ident.id)] || {}).label || ident.id;
  const label = ident.detail && isAccessory(ident.id) && !base.toLowerCase().includes(ident.detail.toLowerCase())
    ? `${base} ${ident.detail}`
    : base;

  if (decision.action === "skip") {
    // No upload, no row, no cost. Just move them on.
    const line = captureLine(decision, label);
    speak(line);
    return { action: "skip", line, ident };
  }

  const equipId = decision.action === "variant" ? `${baseId(ident.id)}/${slug(label)}` : ident.id;
  const [front, side] = await Promise.all([
    upload(userId, equipId, "front", frontDataUrl),
    sideDataUrl ? upload(userId, equipId, "side", sideDataUrl) : Promise.resolve(null),
  ]);

  const row = {
    user_id: userId,
    base_id: baseId(ident.id),
    equip_id: equipId,
    label,
    photo_front: front,
    photo_side: side,
    confidence: ident.confidence,
    confirmed: false,
    gym_name: gymName,
  };
  const { data, error } = await supabase.from("gym_equipment").upsert(row, { onConflict: "user_id,equip_id,gym_name" }).select().single();
  if (error) {
    const line = "Couldn't save that one — check your signal and try again.";
    speak(line);
    return { action: "error", line, error: error.message };
  }

  // Say what it is AND what it's for. Someone who doesn't recognise a pec deck also
  // doesn't know what it's for, and that's the half that makes the program usable.
  const line = ident.usedFor
    ? `${label} — that's for ${ident.usedFor}. Got it.`
    : `${label} — got it.`;
  speak(line);
  return { action: decision.action, line, item: { ...data, id: data.equip_id }, ident };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "variant";

// Remove one machine (a misidentification the client corrects).
export async function forgetMachine(userId, equipId, gymName = null) {
  if (!supabase || !userId) return false;
  let q = supabase.from("gym_equipment").delete().eq("user_id", userId).eq("equip_id", equipId);
  q = gymName ? q.eq("gym_name", gymName) : q.is("gym_name", null);
  const { error } = await q;
  if (error) { console.warn("forgetMachine:", error.message); return false; }
  return true;
}

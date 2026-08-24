// Barcode decoding — JS/WASM (ZXing via `barcode-detector`), NOT a native plugin.
//
// WHY NOT THE NATIVE PLUGIN: @capacitor-mlkit/barcode-scanning ships CocoaPods only
// (no Package.swift). This project builds iOS through Swift Package Manager, so
// `cap sync` silently SKIPPED it — the native class never linked and every call threw
// "not implemented on iOS". Forcing it in would also drag Google's MLKit binary
// framework into SPM and would break again on any npm reinstall.
//
// This approach instead reuses the pattern Macro AI already proves works in this app:
// the OS camera via <input type="file" capture>, then decode the still image in JS.
// Works identically on native and web, survives npm installs, nothing to link.
// Trade-off: one deliberate snapshot rather than continuous live scanning.

// Decoder is loaded lazily (it pulls a WASM blob) so it never slows app startup.
let _detector = null;
async function detector() {
  if (_detector) return _detector;
  const { BarcodeDetector } = await import("barcode-detector/pure");
  _detector = new BarcodeDetector({
    // Product barcodes only — keeps it from locking onto a QR code on the same box.
    formats: ["ean_13", "ean_8", "upc_a", "upc_e"],
  });
  return _detector;
}

// Always available now — decoding is pure JS, no native dependency.
export const barcodeSupported = () => true;

// Decode a barcode from an image File/Blob (what the camera input hands us).
// Returns the digits, or null when no barcode is found in the photo.
export async function decodeBarcodeFromFile(file) {
  const det = await detector();
  const results = await det.detect(file);
  if (!results || !results.length) return null;
  const raw = results[0].rawValue || "";
  const digits = String(raw).replace(/\D/g, "");
  return digits || null;
}

// ── NOVA processing scale (client-facing wording) ───────────────────────────
// 1 whole / 2 basic ingredient / 3 processed / 4 ultra-processed.
// Never surface the bare number to a client — it means nothing to them.
export const NOVA_LABEL = {
  1: { label: "Whole food",       color: "#3ddc84" },
  2: { label: "Basic ingredient", color: "#3ddc84" },
  3: { label: "Processed",        color: "#ff9d5c" },
  4: { label: "Ultra-processed",  color: "#ff7070" },
};

export const novaInfo = (nova) => NOVA_LABEL[nova] || null;

// ── "Should I eat this?" ─────────────────────────────────────────────────────
// NOVA alone is a bad shopping guide: most barcoded food is NOVA 4, so it flags
// nearly everything and tells you nothing. NOVA answers "how was it made"; it does
// NOT answer "is this a good pick." So we combine two signals that cover each
// other's blind spots — this pairing is the accepted approach, not our invention:
//
//   • Nutri-Score (A–E)  — nutritional quality. Good at ranking similar products,
//     but ignores processing and is easy on diet soda / harsh on nuts and olive oil.
//   • NOVA (1–4)         — degree of processing. Catches what Nutri-Score misses.
//
// Neither is gospel, so the verdict is deliberately about FREQUENCY ("everyday" vs
// "occasional"), never a moral judgement of the food or the person eating it.
const GRADE_RANK = { a: 0, b: 1, c: 2, d: 3, e: 4 };

export function foodVerdict({ nutriscore, nova, per100g } = {}) {
  const g = GRADE_RANK[String(nutriscore || "").toLowerCase()];
  const hasGrade = g !== undefined;
  const n = parseInt(nova, 10);
  const hasNova = n >= 1 && n <= 4;
  if (!hasGrade && !hasNova) return null;              // no data -> say nothing

  // Protein density: the number that actually matters for a fat-loss or
  // muscle client, and something neither public score captures.
  const cal = per100g?.cal, prot = per100g?.protein;
  const proteinPer100Cal = cal > 0 && prot != null ? Math.round((prot / cal) * 100 * 10) / 10 : null;

  let tier, label, color, why;
  if (hasGrade && g <= 1 && (!hasNova || n <= 3)) {
    tier = "everyday"; label = "Everyday food"; color = "#3ddc84";
    why = "Good nutritional quality.";
  } else if (hasGrade && g <= 2) {
    tier = "sometimes"; label = "Fine regularly"; color = "#3ddc84";
    why = "Middling quality — fine as part of a balanced day.";
  } else if (hasGrade && g === 3) {
    tier = "sometimes"; label = "Keep it occasional"; color = "#ff9d5c";
    why = "Below-average nutritional quality.";
  } else if (hasGrade) {
    tier = "treat"; label = "Treat food"; color = "#ff7070";
    why = "Poor nutritional quality — worth keeping small and infrequent.";
  } else {
    // No Nutri-Score: fall back to processing alone, and say so.
    tier = n <= 2 ? "everyday" : n === 3 ? "sometimes" : "treat";
    label = n <= 2 ? "Everyday food" : n === 3 ? "Keep it occasional" : "Treat food";
    color = n <= 2 ? "#3ddc84" : n === 3 ? "#ff9d5c" : "#ff7070";
    why = "Based on processing level only — no nutrition grade for this product.";
  }

  // Protein density can upgrade the read for a training client: a NOVA-4 protein
  // powder is not the same decision as a NOVA-4 candy bar.
  let proteinNote = null;
  if (proteinPer100Cal != null) {
    if (proteinPer100Cal >= 10) proteinNote = `High protein — ${proteinPer100Cal}g per 100 cal.`;
    else if (proteinPer100Cal >= 5) proteinNote = `Decent protein — ${proteinPer100Cal}g per 100 cal.`;
    else proteinNote = `Low protein — ${proteinPer100Cal}g per 100 cal.`;
  }

  return { tier, label, color, why, proteinNote, proteinPer100Cal, nutriscore: hasGrade ? String(nutriscore).toUpperCase() : null };
}

// Calorie-weighted share of ultra-processed (NOVA 4) food across logged items.
// Items WITHOUT a nova score are excluded from both sides of the fraction — and
// `scoredCal` / `totalCal` are returned so the UI can state its own coverage
// instead of implying it scored the whole day.
export function processedBreakdown(items) {
  let scoredCal = 0, ultraCal = 0, wholeCal = 0, totalCal = 0;
  (items || []).forEach((it) => {
    const cal = parseFloat(it?.cal) || 0;
    if (cal <= 0) return;
    totalCal += cal;
    const nova = parseInt(it?.nova, 10);
    if (!(nova >= 1 && nova <= 4)) return;                   // unscored — skip
    scoredCal += cal;
    if (nova === 4) ultraCal += cal;
    if (nova <= 2) wholeCal += cal;
  });
  if (!scoredCal) return null;                               // nothing scored -> show nothing
  return {
    ultraPct: Math.round((ultraCal / scoredCal) * 100),
    wholePct: Math.round((wholeCal / scoredCal) * 100),
    scoredCal: Math.round(scoredCal),
    totalCal: Math.round(totalCal),
    // True when a meaningful chunk of the day has no score — UI should caveat harder.
    partial: scoredCal < totalCal * 0.9,
  };
}

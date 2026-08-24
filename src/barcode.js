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

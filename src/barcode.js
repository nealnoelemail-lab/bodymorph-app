// Barcode scanning via ML Kit (on-device — no image ever leaves the phone).
// Native iOS/Android only; on the web the caller falls back to typing the number,
// so this module never throws just because it's running in a browser.
import { Capacitor } from "@capacitor/core";

const IS_NATIVE = (() => { try { return Capacitor.isNativePlatform(); } catch { return false; } })();

// Loaded lazily so the web bundle never pulls the native plugin in at startup.
async function plugin() {
  const m = await import("@capacitor-mlkit/barcode-scanning");
  return m.BarcodeScanner;
}

export const barcodeSupported = () => IS_NATIVE;

// Scan one barcode. Resolves to the digits, or null if the user cancelled.
// Throws with a plain-language message on permission denial / real failures.
export async function scanBarcode() {
  if (!IS_NATIVE) throw new Error("Barcode scanning needs the phone app.");
  const BarcodeScanner = await plugin();

  // Permission: only ask when we don't already have it, so repeat scans are instant.
  try {
    const { camera } = await BarcodeScanner.checkPermissions();
    if (camera !== "granted") {
      const req = await BarcodeScanner.requestPermissions();
      if (req.camera !== "granted") {
        throw new Error("Camera access is off. Settings → BodyMorph → Camera → On.");
      }
    }
  } catch (e) {
    if (/Camera access is off/.test(e.message)) throw e;
    // checkPermissions can throw on some OS versions — fall through and let the
    // scan itself surface the real problem rather than blocking on a probe.
  }

  // Product barcodes only (EAN/UPC) — keeps the scanner from locking onto QR codes
  // on the same package.
  const { barcodes } = await BarcodeScanner.scan({
    formats: ["Ean13", "Ean8", "UpcA", "UpcE"],
  });

  if (!barcodes || !barcodes.length) return null;            // user backed out
  const raw = barcodes[0].rawValue || barcodes[0].displayValue || "";
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

// Apple Health (HealthKit) bridge. Reads STEPS + SLEEP that Apple Health aggregates
// from the iPhone's motion chip, an Apple Watch, and any app that writes to Health —
// so "connect Apple Health" covers the whole Apple ecosystem in one shot. Read-only.
// The native side is HealthKitPlugin (in VoiceCapture.swift). Non-iOS / web → safe no-ops.
import { Capacitor, registerPlugin } from "@capacitor/core";

const HealthKit = registerPlugin("HealthKit");
const IS_NATIVE = (() => { try { return Capacitor.isNativePlatform(); } catch { return false; } })();
const IS_IOS = (() => { try { return Capacitor.getPlatform() === "ios"; } catch { return false; } })();

// Is Apple Health usable on this device? (iOS only, and not on iPad without Health.)
export async function healthAvailable() {
  if (!IS_NATIVE || !IS_IOS) return false;
  try { const r = await HealthKit.isAvailable(); return !!r?.available; } catch { return false; }
}

// Show the Health permission sheet (iOS shows it only once; later calls return instantly).
export async function requestHealthAuth() {
  if (!IS_NATIVE || !IS_IOS) return false;
  try { const r = await HealthKit.requestAuthorization(); return !!r?.granted; } catch { return false; }
}

// One-shot pull of what the coach cares about: today's steps + last night's sleep hours.
// Requests authorization first (idempotent). Returns { steps, hours } or null if unavailable.
export async function syncHealth() {
  if (!IS_NATIVE || !IS_IOS) return null;
  try {
    if (!(await HealthKit.isAvailable())?.available) return null;
    await HealthKit.requestAuthorization();
    const [st, sl] = await Promise.all([
      HealthKit.getTodaySteps().catch(() => ({ steps: 0 })),
      HealthKit.getLastNightSleep().catch(() => ({ hours: 0 })),
    ]);
    return { steps: Math.max(0, parseInt(st?.steps) || 0), hours: Math.max(0, parseFloat(sl?.hours) || 0) };
  } catch { return null; }
}

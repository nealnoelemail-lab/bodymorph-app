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

// ── Weekly watch insights (BACKGROUND ONLY — no new app screens) ─────────────────
// Pulls 14 days of daily metrics + workouts, computes this-week vs last-week, and
// returns a compact summary. Surfaces ONLY in: the client's progress report section,
// the coach's client-detail weekly view, and the coach's compiled weekly briefing.
// All values null when there's no watch/data — callers render nothing.
export async function healthInsights() {
  if (!IS_NATIVE || !IS_IOS) return null;
  try {
    if (!(await HealthKit.isAvailable())?.available) return null;
    await HealthKit.requestAuthorization();
    const [dm, wk] = await Promise.all([
      HealthKit.getDailyMetrics({ days: 14 }).catch(() => ({ days: [] })),
      HealthKit.getWorkouts({ days: 14 }).catch(() => ({ workouts: [] })),
    ]);
    const days = dm?.days || [];
    const workouts = wk?.workouts || [];
    if (!days.length && !workouts.length) return null;

    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const thisWeek = (arr) => arr.filter(d => d.day >= cutoff);
    const lastWeek = (arr) => arr.filter(d => d.day < cutoff);
    const avg = (arr, key) => {
      const vals = arr.map(d => d[key]).filter(v => v != null && v > 0);
      return vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
    };
    const sum = (arr, key) => {
      const vals = arr.map(d => d[key]).filter(v => v != null && v > 0);
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0)) : null;
    };
    const tw = thisWeek(days), lw = lastWeek(days);
    const twWk = thisWeek(workouts), lwWk = lastWeek(workouts);
    return {
      weekStart: cutoff,
      restingHR: avg(tw, "restingHR"),        restingHRPrev: avg(lw, "restingHR"),
      hrvMs: avg(tw, "hrvMs"),                hrvMsPrev: avg(lw, "hrvMs"),
      activeMin: sum(tw, "exerciseMin"),      activeMinPrev: sum(lw, "exerciseMin"),
      activeKcal: sum(tw, "activeKcal"),      activeKcalPrev: sum(lw, "activeKcal"),
      distanceKm: sum(tw, "distanceKm"),      distanceKmPrev: sum(lw, "distanceKm"),
      workoutsCount: twWk.length,             workoutsCountPrev: lwWk.length,
      workoutMin: twWk.reduce((s, w) => s + (w.minutes || 0), 0),
      workoutTypes: [...new Set(twWk.map(w => w.type))].slice(0, 4),
    };
  } catch { return null; }
}

// Raw daily history for the Progress Report TREND charts (resting HR, HRV, VO2 max,
// sleep hours, active minutes/calories over 1wk–1yr). Apple stores the history, so we
// just query it on demand. Returns { metrics:[{day,restingHR,hrvMs,vo2Max,exerciseMin,
// activeKcal,distanceKm}], sleep:[{day,hours}] } or null if unavailable.
export async function healthDaily(days = 365) {
  if (!IS_NATIVE || !IS_IOS) return null;
  try {
    if (!(await HealthKit.isAvailable())?.available) return null;
    await HealthKit.requestAuthorization();
    const [dm, sl] = await Promise.all([
      HealthKit.getDailyMetrics({ days }).catch(() => ({ days: [] })),
      HealthKit.getDailySleep({ days }).catch(() => ({ days: [] })),
    ]);
    const metrics = dm?.days || [], sleep = sl?.days || [];
    if (!metrics.length && !sleep.length) return null;
    return { metrics, sleep };
  } catch { return null; }
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

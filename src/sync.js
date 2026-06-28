import { supabase } from "./supabase";

// ── CLOUD SYNC ENGINE ─────────────────────────────────────────────────────────
// Offline-first: localStorage stays the instant on-device copy; this layer pushes
// changes up (debounced) and pulls + smart-merges on login. See memory:
// bodymorph-sync-strategy. No backend / not signed in -> every call is a safe no-op.
//
// MERGE MODEL (v1, timestamp-free):
//   • Dated / collection data -> union by natural key; on a same-key conflict the
//     winner is the ACTIVE device (local), unless this is a FRESH device (no local
//     profile) in which case cloud wins so a new phone pulls everything.
//   • Singletons -> on a fresh device take cloud; otherwise keep local if it's set
//     (defaults count as "set" via per-domain logic), else take cloud.
// `preferCloud` (passed from hydrate when there's no local profile) drives the
// fresh-device behavior. Per-record updated_at LWW is a later refinement.

const isEmpty = (v) =>
  v == null ||
  (typeof v === "string" && v === "") ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

// ── Merge helpers ──────────────────────────────────────────────────────────────
// Union an array by a key function. Insertion order decides the winner (last wins),
// so we insert the loser first.
function unionByKey(local, cloud, keyFn, preferCloud) {
  const m = new Map();
  const first = preferCloud ? local : cloud;
  const last  = preferCloud ? cloud : local;
  (first || []).forEach(r => { const k = keyFn(r); if (k != null) m.set(k, r); });
  (last  || []).forEach(r => { const k = keyFn(r); if (k != null) m.set(k, r); });
  return [...m.values()];
}
const byDate = (local, cloud, preferCloud) =>
  unionByKey(local, cloud, e => e.date, preferCloud).sort((a, b) => (a.date < b.date ? 1 : -1));

// Shallow-merge two objects keyed by id/date; loser spread first.
const objByKey = (local, cloud, preferCloud) =>
  preferCloud ? { ...(local || {}), ...(cloud || {}) } : { ...(cloud || {}), ...(local || {}) };

// Singleton: fresh device -> cloud; else keep a non-empty local, otherwise cloud.
const singleton = (local, cloud, preferCloud) =>
  preferCloud ? (cloud ?? local) : (isEmpty(local) ? (cloud ?? local) : local);

const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
const strOrEmpty = (v) => (v == null ? "" : String(v));

// ── Domain registry ─────────────────────────────────────────────────────────────
// Each domain maps an app state value <-> its table.
const DOMAINS = {
  // ── Dated arrays (PK user_id,day) ──
  steps: {
    table: "step_entries", onConflict: "user_id,day",
    toRows: (v, uid) => (v || []).filter(e => e && e.date)
      .map(e => ({ user_id: uid, day: e.date, steps: parseInt(e.steps) || 0 })),
    fromRows: (rows) => (rows || []).map(r => ({ date: r.day, steps: r.steps })),
    merge: byDate,
  },
  sleep: {
    table: "sleep_entries", onConflict: "user_id,day",
    toRows: (v, uid) => (v || []).filter(e => e && e.date)
      .map(e => ({ user_id: uid, day: e.date, hours: numOrNull(e.hours) })),
    fromRows: (rows) => (rows || []).map(r => ({ date: r.day, hours: r.hours })),
    merge: byDate,
  },
  // Body: weight/bodyFat/notes + photo PATHS sync. Inline base64 photos (legacy /
  // offline fallback) are filtered out so they never bloat the row — they stay
  // local-only; uploaded photos sync as tiny Storage paths.
  body: {
    table: "body_entries", onConflict: "user_id,day",
    toRows: (v, uid) => (v || []).filter(e => e && e.date).map(e => ({
      user_id: uid, day: e.date, weight: numOrNull(e.weight), body_fat: numOrNull(e.bodyFat), notes: e.notes || null,
      photos: Object.fromEntries(Object.entries(e.photos || {}).filter(([, p]) => p && !String(p).startsWith("data:"))),
    })),
    fromRows: (rows) => (rows || []).map(r => ({ date: r.day, weight: strOrEmpty(r.weight), bodyFat: strOrEmpty(r.body_fat), ...(r.notes ? { notes: r.notes } : {}), ...(r.photos && Object.keys(r.photos).length ? { photos: r.photos } : {}) })),
    merge: byDate,
  },

  // ── Dated object (keyed by date) ──
  foodLog: {
    table: "food_log_days", onConflict: "user_id,day",
    toRows: (v, uid) => Object.entries(v || {}).map(([day, slots]) => {
      let cal = 0, protein = 0, carbs = 0, fats = 0;
      ["breakfast", "lunch", "dinner", "snacks"].forEach(slot => {
        const e = slots[slot]; if (!e) return;
        (Array.isArray(e) ? e : [e]).forEach(it => { if (it && it.logged) {
          cal += parseFloat(it.cal) || 0; protein += parseFloat(it.protein) || 0;
          carbs += parseFloat(it.carbs) || 0; fats += parseFloat(it.fats) || 0;
        }});
      });
      return { user_id: uid, day,
        breakfast: slots.breakfast ?? null, lunch: slots.lunch ?? null,
        dinner: slots.dinner ?? null, snacks: slots.snacks ?? null,
        cal: Math.round(cal), protein: Math.round(protein), carbs: Math.round(carbs), fats: Math.round(fats) };
    }),
    fromRows: (rows) => Object.fromEntries((rows || []).map(r => [r.day, {
      ...(r.breakfast != null ? { breakfast: r.breakfast } : {}),
      ...(r.lunch != null ? { lunch: r.lunch } : {}),
      ...(r.dinner != null ? { dinner: r.dinner } : {}),
      ...(r.snacks != null ? { snacks: r.snacks } : {}),
    }])),
    merge: objByKey,
  },

  // ── Hydration (single today-object <-> per-day table) ──
  hydration: {
    table: "hydration_days", onConflict: "user_id,day",
    toRows: (v, uid) => (v && v.date) ? [{ user_id: uid, day: v.date, cups: v.cups || 0, goal: v.goal || 8 }] : [],
    fromRows: (rows) => (rows || []).map(r => ({ date: r.day, cups: r.cups, goal: r.goal })),
    // Keep today's local record but adopt the higher cup count if another device logged more.
    merge: (local, cloudArr, preferCloud) => {
      if (!local || !local.date) return local;
      const c = (cloudArr || []).find(r => r.date === local.date);
      if (!c) return local;
      if (preferCloud) return { date: local.date, cups: c.cups, goal: c.goal || local.goal };
      return (c.cups || 0) > (local.cups || 0) ? { ...local, cups: c.cups } : local;
    },
  },

  // ── Collection arrays ──
  cardio: {
    table: "cardio_sessions", onConflict: "user_id,client_key",
    key: (e) => `${e.date}|${e.type || ""}|${e.minutes || 0}|${e.calories || 0}`,
    toRows: (v, uid) => (v || []).filter(e => e && e.date).map(e => ({
      user_id: uid, client_key: DOMAINS.cardio.key(e), day: e.date, type: e.type || null,
      activity: e.activity || null, minutes: e.minutes != null ? parseInt(e.minutes) : null,
      calories: e.calories != null ? parseInt(e.calories) : null, from_workout: !!e.fromWorkout })),
    fromRows: (rows) => (rows || []).map(r => ({ date: r.day, type: r.type, activity: r.activity, minutes: r.minutes, calories: r.calories, fromWorkout: r.from_workout })),
    merge: (l, c, p) => unionByKey(l, c, DOMAINS.cardio.key, p),
  },
  supplements: {
    table: "supplements", onConflict: "user_id,client_key",
    toRows: (v, uid) => (v || []).filter(e => e && e.id).map(e => ({
      user_id: uid, client_key: String(e.id), name: e.name || null, timing: e.timing || null,
      days: e.days || null, dose: e.dose || null, notes: e.notes || null })),
    fromRows: (rows) => (rows || []).map(r => ({ id: r.client_key, name: r.name, timing: r.timing, days: r.days, dose: r.dose, notes: r.notes })),
    merge: (l, c, p) => unionByKey(l, c, e => String(e.id), p),
  },
  peptides: {
    table: "peptides", onConflict: "user_id,client_key",
    toRows: (v, uid) => (v || []).filter(e => e && e.id).map(e => ({
      user_id: uid, client_key: String(e.id), name: e.name || null, timing: e.timing || null,
      days: e.days || null, dose: e.dose || null, notes: e.notes || null })),
    fromRows: (rows) => (rows || []).map(r => ({ id: r.client_key, name: r.name, timing: r.timing, days: r.days, dose: r.dose, notes: r.notes })),
    merge: (l, c, p) => unionByKey(l, c, e => String(e.id), p),
  },

  // ── Collection objects ──
  // Workout logs: app shape is { exercise: [entry,...] }. Flatten to rows with a
  // CONTENT client_key (stable across re-syncs; identical same-day sets collapse).
  logs: {
    table: "workout_logs", onConflict: "user_id,client_key",
    keyOf: (ex, e) => `${ex}|${e.date}|${e.weight ?? ""}|${e.reps ?? ""}`,
    toRows: (v, uid) => {
      const rows = [];
      Object.entries(v || {}).forEach(([ex, arr]) => (arr || []).forEach(e => {
        if (!e || !e.date) return;
        rows.push({ user_id: uid, client_key: DOMAINS.logs.keyOf(ex, e), day: e.date, exercise: ex,
          sets: e.sets || null, top_weight: numOrNull(e.weight), top_reps: e.reps === "" || e.reps == null ? null : parseInt(e.reps), pr: !!e.pr });
      }));
      return rows;
    },
    fromRows: (rows) => {
      const obj = {};
      (rows || []).forEach(r => { (obj[r.exercise] ||= []).push({ date: r.day, ...(r.sets ? { sets: r.sets } : {}), weight: strOrEmpty(r.top_weight), reps: strOrEmpty(r.top_reps), pr: r.pr }); });
      return obj;
    },
    merge: (local, cloud, preferCloud) => {
      const m = new Map();
      const add = (o) => Object.entries(o || {}).forEach(([ex, arr]) => (arr || []).forEach(e => { if (e && e.date) m.set(DOMAINS.logs.keyOf(ex, e), { ex, e }); }));
      add(preferCloud ? local : cloud); add(preferCloud ? cloud : local);
      const out = {};
      for (const { ex, e } of m.values()) (out[ex] ||= []).push(e);
      Object.values(out).forEach(a => a.sort((x, y) => (x.date < y.date ? -1 : 1)));
      return out;
    },
  },
  meals: {
    table: "meals_catalog", onConflict: "user_id,client_key",
    toRows: (v, uid) => Object.entries(v || {}).map(([k, m]) => ({
      user_id: uid, client_key: k, description: m.description || null,
      cal: m.cal != null ? parseInt(m.cal) : null, protein: m.protein != null ? parseInt(m.protein) : null,
      carbs: m.carbs != null ? parseInt(m.carbs) : null, fats: m.fats != null ? parseInt(m.fats) : null,
      brand: m.brand || null, per100: m.per100 || null, verified: m.verified ?? null, usda_desc: m.usdaDesc || null })),
    fromRows: (rows) => Object.fromEntries((rows || []).map(r => [r.client_key, {
      description: r.description, cal: r.cal, protein: r.protein, carbs: r.carbs, fats: r.fats,
      ...(r.brand ? { brand: r.brand } : {}), ...(r.per100 ? { per100: r.per100 } : {}),
      ...(r.verified != null ? { verified: r.verified } : {}), ...(r.usda_desc ? { usdaDesc: r.usda_desc } : {}) }])),
    merge: objByKey,
  },

  // ── Singletons (one row per user) ──
  rewards: {
    table: "rewards", onConflict: "user_id",
    toRows: (v, uid) => v ? [{ user_id: uid, coins: v.coins || 0, earned_ids: v.earnedIds || [], medals: v.medals || [], stats: v.stats || {} }] : [],
    fromRows: (rows) => rows && rows[0] ? { coins: rows[0].coins, earnedIds: rows[0].earned_ids, medals: rows[0].medals, stats: rows[0].stats } : null,
    // Rewards always has a non-empty default, so pick whichever shows more progress.
    merge: (local, cloud, preferCloud) => {
      if (!cloud) return local; if (!local) return cloud;
      const score = (r) => (r.coins || 0) + (r.earnedIds?.length || 0) + (r.medals?.length || 0) + (r.stats?.totalLogs || 0);
      if (preferCloud) return score(cloud) >= score(local) ? cloud : local;
      return score(local) >= score(cloud) ? local : cloud;
    },
  },
  mealPlan: {
    table: "meal_plans", onConflict: "user_id",
    toRows: (v, uid) => v ? [{ user_id: uid, plan: v }] : [],
    fromRows: (rows) => rows && rows[0] ? rows[0].plan : null,
    merge: singleton,
  },
  nutritionGoals: {
    table: "nutrition_goals", onConflict: "user_id",
    toRows: (v, uid) => v ? [{ user_id: uid, goal_weight: v.goalWeight || null, weekly_pace: v.weeklyPace || null, allergies: v.allergies || null, allergens: v.allergens || null, preferred_brands: v.preferredBrands || null }] : [],
    fromRows: (rows) => rows && rows[0] ? { goalWeight: rows[0].goal_weight || "", weeklyPace: rows[0].weekly_pace || "1",
      ...(rows[0].allergies ? { allergies: rows[0].allergies } : {}), ...(rows[0].allergens ? { allergens: rows[0].allergens } : {}), ...(rows[0].preferred_brands ? { preferredBrands: rows[0].preferred_brands } : {}) } : null,
    // Non-empty default ({goalWeight:"",weeklyPace:"1"}); prefer the more-filled one.
    merge: (local, cloud, preferCloud) => {
      if (!cloud) return local; if (!local) return cloud;
      const filled = (g) => Object.values(g).filter(x => !isEmpty(x) && x !== "1").length;
      if (preferCloud) return filled(cloud) >= filled(local) ? cloud : local;
      return filled(local) >= filled(cloud) ? local : cloud;
    },
  },

  // ── user_settings: one table, one column per app value ──
  dietPref:        settingsField("diet_pref"),
  cardioPlan:      settingsField("cardio_plan"),
  stretchPlan:     settingsField("stretch_plan"),
  stretchRoutines: settingsField("stretch_routines"),
  videoOverrides:  settingsField("video_overrides"),
  todoChecked:     settingsField("todo_checked"),
  coachVoice:      settingsField("coach_voice"),
};

// Build a domain that reads/writes a single column of the shared user_settings row.
function settingsField(col) {
  return {
    table: "user_settings", onConflict: "user_id", column: col,
    toRows: (v, uid) => (v == null ? [] : [{ user_id: uid, [col]: v }]),
    fromRows: (rows) => (rows && rows[0] ? rows[0][col] : null),
    merge: singleton,
  };
}

// ── Engine ───────────────────────────────────────────────────────────────────────
export async function pushDomain(name, userId, value) {
  if (!supabase || !userId) return { error: null };
  const d = DOMAINS[name];
  if (!d) { console.warn(`sync: unknown domain "${name}"`); return { error: "unknown domain" }; }
  const rows = d.toRows(value, userId);
  if (!rows.length) return { error: null };
  const { error } = await supabase.from(d.table).upsert(rows, { onConflict: d.onConflict });
  if (error) console.warn(`sync push ${name}:`, error.message);
  return { error: error?.message || null };
}

// Pull a domain from the cloud and merge with the local value. Returns the merged
// value (or `local` unchanged if no backend / not signed in / on error).
export async function pullMergeDomain(name, userId, local, preferCloud = false) {
  if (!supabase || !userId) return local;
  const d = DOMAINS[name];
  if (!d) { console.warn(`sync: unknown domain "${name}"`); return local; }
  const { data, error } = await supabase.from(d.table).select("*").eq("user_id", userId);
  if (error) { console.warn(`sync pull ${name}:`, error.message); return local; }
  return d.merge(local, d.fromRows(data), preferCloud);
}

// Debounced push — coalesces rapid changes into one network write per domain.
const _timers = {};
export function pushDomainDebounced(name, userId, value, ms = 800) {
  if (!supabase || !userId) return;
  clearTimeout(_timers[name]);
  _timers[name] = setTimeout(() => { pushDomain(name, userId, value); }, ms);
}

// ── Profile (special: the `profiles` table from 0001, PK = id = auth uid) ────────
// The full app profile is the source of truth, stashed in `extra`; a few columns
// are promoted for the Coach Dashboard to query. The signup trigger pre-creates a
// row with extra '{}', so empty extra is treated as "no profile yet" (-> wizard).
export async function pushProfile(userId, profile) {
  if (!supabase || !userId || !profile) return { error: null };
  const row = {
    id: userId,
    first_name: profile.name || null,
    gender: profile.gender || null,
    goal: profile.goal || null,
    focus: profile.focus || null,
    body_fat: profile.bodyFat == null || profile.bodyFat === "" ? null : Number(profile.bodyFat),
    weight: profile.weight == null || profile.weight === "" ? null : Number(profile.weight),
    age: profile.age == null || profile.age === "" ? null : parseInt(profile.age),
    training_days: Array.isArray(profile.trainingDays) ? profile.trainingDays : null,
    session_time: profile.sessionTime == null || profile.sessionTime === "" ? null : parseInt(profile.sessionTime),
    extra: profile,
  };
  const { error } = await supabase.from("profiles").upsert(row, { onConflict: "id" });
  if (error) console.warn("sync push profile:", error.message);
  return { error: error?.message || null };
}

export function pushProfileDebounced(userId, profile, ms = 800) {
  if (!supabase || !userId) return;
  clearTimeout(_timers.__profile);
  _timers.__profile = setTimeout(() => { pushProfile(userId, profile); }, ms);
}

// Returns the cloud profile object (from `extra`) or null. Prefers a non-empty
// local profile (active device); a fresh device with no local profile gets cloud.
export async function pullMergeProfile(userId, localProfile) {
  if (!supabase || !userId) return localProfile;
  if (localProfile && Object.keys(localProfile).length) return localProfile;
  const { data, error } = await supabase.from("profiles").select("extra").eq("id", userId).maybeSingle();
  if (error) { console.warn("sync pull profile:", error.message); return localProfile; }
  const ex = data?.extra;
  return (ex && Object.keys(ex).length) ? ex : localProfile;
}

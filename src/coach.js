import { supabase } from "./supabase";

// ── COACH (client data layer) ───────────────────────────────────────────────────
// Role lookup, coach-access / invite-code redemption (Postgres RPCs), and the
// coach-side reads of client data (allowed by the is_coach_of() RLS policies).
// No backend / not signed in -> safe no-ops.

const nameOf = (p) => (p?.extra?.name) || p?.first_name || "Client";
const maxDay = (...days) => days.filter(Boolean).sort().slice(-1)[0] || null;

// The signed-in user's role ('client' | 'coach' | ...). Read straight from the
// profiles row — pullMergeProfile short-circuits on a local profile and omits role.
export async function fetchRole(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  if (error) { console.warn("coach fetchRole:", error.message); return null; }
  return data?.role || null;
}

// RPC wrappers — each returns { ok, error }.
async function rpc(fn, args) {
  if (!supabase) return { ok: false, error: "No backend." };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: error.message };
  if (data && typeof data === "object") return { ok: !!data.ok, error: data.error || null };
  return { ok: true, value: data };           // generate_coach_invite returns a string
}

export const redeemCoachAccess = (code) => rpc("redeem_coach_access", { p_code: (code || "").trim() });
export const redeemCoachInvite = (code) => rpc("redeem_coach_invite", { p_code: (code || "").trim() });
export async function generateInvite() {
  const r = await rpc("generate_coach_invite", {});
  return r.value || null;                       // the invite code string
}
export async function fetchMyInvite(coachId) {
  if (!supabase || !coachId) return null;
  const { data } = await supabase.from("coach_invites").select("code").eq("coach_id", coachId).maybeSingle();
  return data?.code || null;
}

// Roster: the coach's active clients with a few summary stats for the list view.
export async function fetchRoster(coachId) {
  if (!supabase || !coachId) return [];
  const { data: rels, error } = await supabase
    .from("relationships").select("client_id").eq("coach_id", coachId).eq("status", "active");
  if (error) { console.warn("coach fetchRoster:", error.message); return []; }
  const ids = (rels || []).map(r => r.client_id);
  if (!ids.length) return [];

  const [profiles, body, steps] = await Promise.all([
    supabase.from("profiles").select("id, first_name, extra").in("id", ids),
    supabase.from("body_entries").select("user_id, day, weight").in("user_id", ids),
    supabase.from("step_entries").select("user_id, day").in("user_id", ids),
  ]);
  const byClient = (rows, uid) => (rows?.data || []).filter(r => r.user_id === uid);

  return ids.map(id => {
    const p = (profiles.data || []).find(x => x.id === id);
    const bw = byClient(body, id).filter(r => r.weight != null).sort((a, b) => (a.day < b.day ? -1 : 1));
    const lastActive = maxDay(bw.slice(-1)[0]?.day, byClient(steps, id).map(s => s.day).sort().slice(-1)[0]);
    return {
      id,
      name: nameOf(p),
      weight: bw.length ? bw[bw.length - 1].weight : null,
      weightTrend: bw.length >= 2 ? +(bw[bw.length - 1].weight - bw[0].weight).toFixed(1) : null,
      lastActive,
    };
  });
}

// Full per-client read for the detail view. Returns app-shaped data so the
// existing chart transforms apply directly.
export async function fetchClientDetail(clientId) {
  if (!supabase || !clientId) return null;
  const [profile, body, steps, logs, food, rewards] = await Promise.all([
    supabase.from("profiles").select("first_name, extra").eq("id", clientId).maybeSingle(),
    supabase.from("body_entries").select("*").eq("user_id", clientId),
    supabase.from("step_entries").select("*").eq("user_id", clientId),
    supabase.from("workout_logs").select("*").eq("user_id", clientId),
    supabase.from("food_log_days").select("*").eq("user_id", clientId),
    supabase.from("rewards").select("*").eq("user_id", clientId).maybeSingle(),
  ]);
  const bodyEntries = (body.data || [])
    .map(r => ({ date: r.day, weight: r.weight, bodyFat: r.body_fat }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const stepEntries = (steps.data || []).map(r => ({ date: r.day, steps: r.steps }));
  return {
    name: nameOf(profile.data),
    bodyEntries,
    stepEntries,
    workoutCount: (logs.data || []).length,
    foodDays: (food.data || []).length,
    rewards: rewards.data ? { coins: rewards.data.coins, stats: rewards.data.stats || {} } : null,
    lastActive: maxDay(bodyEntries.slice(-1)[0]?.date, [...stepEntries].map(s => s.date).sort().slice(-1)[0]),
  };
}

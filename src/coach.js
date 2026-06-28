import { supabase } from "./supabase";

const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY;

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

// Full per-client read for the detail view + weekly summary. Returns app-shaped
// data so the existing chart transforms apply directly.
export async function fetchClientDetail(clientId) {
  if (!supabase || !clientId) return null;
  const [profile, body, steps, sleep, logs, food, rewards] = await Promise.all([
    supabase.from("profiles").select("first_name, extra").eq("id", clientId).maybeSingle(),
    supabase.from("body_entries").select("*").eq("user_id", clientId),
    supabase.from("step_entries").select("*").eq("user_id", clientId),
    supabase.from("sleep_entries").select("*").eq("user_id", clientId),
    supabase.from("workout_logs").select("day").eq("user_id", clientId),
    supabase.from("food_log_days").select("day, cal, protein, carbs, fats").eq("user_id", clientId),
    supabase.from("rewards").select("*").eq("user_id", clientId).maybeSingle(),
  ]);
  const bodyEntries = (body.data || [])
    .map(r => ({ date: r.day, weight: r.weight, bodyFat: r.body_fat }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const stepEntries = (steps.data || []).map(r => ({ date: r.day, steps: r.steps }));
  const sleepEntries = (sleep.data || []).map(r => ({ date: r.day, hours: r.hours }));
  const workoutDays = [...new Set((logs.data || []).map(r => r.day))].sort();
  const foodDays = (food.data || []).map(r => ({ date: r.day, cal: r.cal, protein: r.protein, carbs: r.carbs, fats: r.fats }));
  return {
    name: nameOf(profile.data),
    bodyEntries, stepEntries, sleepEntries, workoutDays, foodDays,
    rewards: rewards.data ? { coins: rewards.data.coins, stats: rewards.data.stats || {} } : null,
    lastActive: maxDay(bodyEntries.slice(-1)[0]?.date, [...stepEntries].map(s => s.date).sort().slice(-1)[0], workoutDays.slice(-1)[0]),
  };
}

// ── AI weekly briefing ───────────────────────────────────────────────────────────
// Distill the client's last 7 days into compact metrics for the prompt.
function summarizeWeek(d) {
  const cut = new Date(); cut.setDate(cut.getDate() - 6);
  const cutStr = cut.toISOString().slice(0, 10);
  const wk = (arr, key = "date") => (arr || []).filter(x => x[key] >= cutStr);
  const body = d.bodyEntries || [], body7 = wk(body), steps7 = wk(d.stepEntries), sleep7 = wk(d.sleepEntries), food7 = wk(d.foodDays);
  const avg = (a, f) => a.length ? Math.round(a.reduce((s, x) => s + (+f(x) || 0), 0) / a.length) : null;
  return {
    weightLatest: body.length ? body[body.length - 1].weight : null,
    weightChange7d: body7.length >= 2 ? +(body7[body7.length - 1].weight - body7[0].weight).toFixed(1) : null,
    weightChangeAllTime: body.length >= 2 ? +(body[body.length - 1].weight - body[0].weight).toFixed(1) : null,
    avgSteps7d: avg(steps7, x => x.steps),
    daysStepsLogged7d: steps7.length,
    avgSleepHours7d: sleep7.length ? +(sleep7.reduce((s, x) => s + (+x.hours || 0), 0) / sleep7.length).toFixed(1) : null,
    workouts7d: (d.workoutDays || []).filter(x => x >= cutStr).length,
    daysFoodLogged7d: food7.length,
    currentStreak: d.rewards?.stats?.currentStreak || 0,
  };
}

// Generate a short coach-facing briefing with Claude (Haiku — cheap, plenty here).
export async function generateClientSummary(detail) {
  if (!ANTHROPIC_KEY) return { error: "No AI key configured." };
  const w = summarizeWeek(detail);
  const prompt =
    "You are an assistant to a fitness coach. Write a SHORT briefing (2-3 sentences, plain prose — no greeting, no preamble, no bullet points) about this client's past 7 days, so the coach can skim it before a check-in. Use the actual numbers, note what's going well, and flag the one thing to address.\n\n" +
    `Client: ${detail.name}\nMetrics: ${JSON.stringify(w)}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 220, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return { error: `AI error (${res.status})` };
    const data = await res.json();
    const text = (data.content?.[0]?.text || "").trim();
    return text ? { text } : { error: "Empty response" };
  } catch (e) { return { error: e.message }; }
}

// Read / write the cached briefing (no-op without the table / backend).
export async function fetchClientSummary(coachId, clientId) {
  if (!supabase || !coachId || !clientId) return null;
  const { data } = await supabase.from("client_summaries")
    .select("summary, generated_at").eq("coach_id", coachId).eq("client_id", clientId).maybeSingle();
  return data || null;
}
export async function saveClientSummary(coachId, clientId, summary) {
  if (!supabase || !coachId || !clientId) return;
  await supabase.from("client_summaries").upsert(
    { coach_id: coachId, client_id: clientId, summary, generated_at: new Date().toISOString() },
    { onConflict: "coach_id,client_id" });
}

import { supabase } from "./supabase";
import { anthropicFetch, USE_PROXY } from "./aiproxy";

const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY;

// ── COACH (client data layer) ───────────────────────────────────────────────────
// Role lookup, coach-access / invite-code redemption (Postgres RPCs), and the
// coach-side reads of client data (allowed by the is_coach_of() RLS policies).
// No backend / not signed in -> safe no-ops.

const nameOf = (p) => {
  const first = p?.first_name || p?.extra?.firstName || "";
  const last  = p?.last_name  || p?.extra?.lastName  || "";
  return `${first} ${last}`.trim() || p?.extra?.name || "Client";
};
const maxDay = (...days) => days.filter(Boolean).sort().slice(-1)[0] || null;
// LOCAL calendar date as YYYY-MM-DD (UTC toISOString rolls over to tomorrow in the
// evening for western timezones — keep day boundaries on the user's local clock).
const ymdLocal = (d = new Date()) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

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

// Access gate: has this client already redeemed a trainer's code (active link)?
// Used to require a code from every user before they can use the app.
export async function clientHasCoach(userId) {
  if (!supabase || !userId) return false;
  const { data } = await supabase.from("relationships")
    .select("coach_id").eq("client_id", userId).eq("status", "active").limit(1);
  return Array.isArray(data) && data.length > 0;
}
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
    .from("relationships").select("client_id, consulting_fee, client_type, risk_resolved_at").eq("coach_id", coachId).eq("status", "active");
  if (error) { console.warn("coach fetchRoster:", error.message); return []; }
  const ids = (rels || []).map(r => r.client_id);
  if (!ids.length) return [];
  const relOf = (id) => rels.find(r => r.client_id === id) || {};

  const [profiles, body, steps] = await Promise.all([
    supabase.from("profiles").select("id, first_name, last_name, email, phone, extra").in("id", ids),
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
      email: p?.email || p?.extra?.email || null,
      phone: p?.phone || p?.extra?.phone || null,
      weight: bw.length ? bw[bw.length - 1].weight : null,
      weightTrend: bw.length >= 2 ? +(bw[bw.length - 1].weight - bw[0].weight).toFixed(1) : null,
      lastActive,
      consultingFee: relOf(id).consulting_fee,        // per-client override (null = use coach base fee)
      clientType: relOf(id).client_type || "consulting", // 'consulting' | 'app_only'
      riskResolvedAt: relOf(id).risk_resolved_at,     // suppresses the at-risk flag for 14 days
    };
  });
}

// Resolve an at-risk client from the Overview queue. Outcomes:
//   'back_on_track' — contacted, they're fine; note saved for the record.
//   'app_only'      — downgrade: they keep the app but drop consulting (fee → 0).
//   'lost'          — gone for good: relationship ended, off the roster.
export async function resolveAtRisk(coachId, clientId, outcome, note) {
  if (!supabase || !coachId || !clientId) return false;
  const patch = { risk_resolved_at: new Date().toISOString(), risk_outcome: outcome, risk_note: note || null };
  if (outcome === "app_only") { patch.client_type = "app_only"; patch.consulting_fee = 0; }
  if (outcome === "lost") patch.status = "ended";
  const { error } = await supabase.from("relationships").update(patch)
    .eq("coach_id", coachId).eq("client_id", clientId);
  if (error) { console.warn("resolveAtRisk:", error.message); return false; }
  return true;
}

// Full per-client read for the detail view + weekly summary. Returns app-shaped
// data so the existing chart transforms apply directly.
export async function fetchClientDetail(clientId) {
  if (!supabase || !clientId) return null;
  const [profile, body, steps, sleep, logs, food, rewards, rel, watch] = await Promise.all([
    supabase.from("profiles").select("first_name, last_name, email, phone, extra").eq("id", clientId).maybeSingle(),
    supabase.from("body_entries").select("*").eq("user_id", clientId),
    supabase.from("step_entries").select("*").eq("user_id", clientId),
    supabase.from("sleep_entries").select("*").eq("user_id", clientId),
    supabase.from("workout_logs").select("day").eq("user_id", clientId),
    supabase.from("food_log_days").select("day, cal, protein, carbs, fats").eq("user_id", clientId),
    supabase.from("rewards").select("*").eq("user_id", clientId).maybeSingle(),
    supabase.from("relationships").select("share_photos").eq("client_id", clientId).maybeSingle(), // RLS scopes to this coach's row
    supabase.from("health_summaries").select("data").eq("user_id", clientId).order("week_start", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const bodyEntries = (body.data || [])
    .map(r => ({ date: r.day, weight: r.weight, bodyFat: r.body_fat, photos: r.photos || {} }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const stepEntries = (steps.data || []).map(r => ({ date: r.day, steps: r.steps }));
  const sleepEntries = (sleep.data || []).map(r => ({ date: r.day, hours: r.hours }));
  const workoutDays = [...new Set((logs.data || []).map(r => r.day))].sort();
  const foodDays = (food.data || []).map(r => ({ date: r.day, cal: r.cal, protein: r.protein, carbs: r.carbs, fats: r.fats }));
  return {
    name: nameOf(profile.data),
    email: profile.data?.email || profile.data?.extra?.email || null,
    phone: profile.data?.phone || profile.data?.extra?.phone || null,
    profile: (profile.data && profile.data.extra) || {},  // full signup profile: goal, targets, pace, program, timeline
    bodyEntries, stepEntries, sleepEntries, workoutDays, foodDays,
    rewards: rewards.data ? { coins: rewards.data.coins, stats: rewards.data.stats || {} } : null,
    lastActive: maxDay(bodyEntries.slice(-1)[0]?.date, [...stepEntries].map(s => s.date).sort().slice(-1)[0], workoutDays.slice(-1)[0]),
    sharePhotos: !!rel.data?.share_photos,  // client consent — photos render only when true
    watch: watch.data?.data || null,        // latest weekly watch summary (null = no watch)
  };
}

// ── Progress-photo sharing consent (client side) ─────────────────────────────────
// Whether this client has allowed their coach to view progress photos.
// Returns null when the client has no coach relationship (toggle hidden).
export async function getPhotoSharing(clientId) {
  if (!supabase || !clientId) return null;
  const { data, error } = await supabase.from("relationships")
    .select("share_photos").eq("client_id", clientId).eq("status", "active").maybeSingle();
  if (error) { console.warn("getPhotoSharing:", error.message); return null; }
  return data ? !!data.share_photos : null;
}

// Flip the consent flag. Goes through the set_photo_sharing RPC because table RLS
// (correctly) doesn't let clients update relationship rows directly.
export async function setPhotoSharing(share) {
  if (!supabase) return false;
  const { error } = await supabase.rpc("set_photo_sharing", { p_share: !!share });
  if (error) { console.warn("setPhotoSharing:", error.message); return false; }
  return true;
}

// ── AI weekly briefing ───────────────────────────────────────────────────────────
// Distill the client's last 7 days into compact metrics for the prompt.
export function summarizeWeek(d) {
  const cut = new Date(); cut.setDate(cut.getDate() - 6);
  const cutStr = ymdLocal(cut);
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
    // Watch data (when the client has one) — objective cardio/recovery for the briefing.
    ...(d.watch ? {
      watchRestingHR: d.watch.restingHR, watchRestingHRPrev: d.watch.restingHRPrev,
      watchActiveMin: d.watch.activeMin, watchActiveMinPrev: d.watch.activeMinPrev,
      watchWorkouts: d.watch.workoutsCount, watchWorkoutTypes: d.watch.workoutTypes,
      watchActiveKcal: d.watch.activeKcal, watchDistanceKm: d.watch.distanceKm,
    } : {}),
  };
}

// ── Weekly watch summaries (health_summaries table) ─────────────────────────────
// Client side: push this week's computed summary (background, silent).
export async function pushHealthSummary(userId, insights) {
  if (!supabase || !userId || !insights) return;
  await supabase.from("health_summaries").upsert(
    { user_id: userId, week_start: insights.weekStart, data: insights, updated_at: new Date().toISOString() },
    { onConflict: "user_id,week_start" }
  );
}

// Either side: the latest weekly watch summary for a user (null if none/no watch).
export async function fetchHealthSummary(userId) {
  if (!supabase || !userId) return null;
  const { data } = await supabase.from("health_summaries")
    .select("data, week_start, updated_at")
    .eq("user_id", userId).order("week_start", { ascending: false }).limit(1).maybeSingle();
  return data?.data || null;
}

// Generate a short coach-facing briefing with Claude (Haiku — cheap, plenty here).
export async function generateClientSummary(detail) {
  if (!USE_PROXY && !ANTHROPIC_KEY) return { error: "No AI key configured." };
  const w = summarizeWeek(detail);
  const prompt =
    "You are an assistant to a fitness coach. Write a SHORT briefing (2-3 sentences, plain prose — no greeting, no preamble, no bullet points) about this client's past 7 days, so the coach can skim it before a check-in. Use the actual numbers, note what's going well, and flag the one thing to address.\n\n" +
    `Client: ${detail.name}\nMetrics: ${JSON.stringify(w)}`;
  try {
    const res = await anthropicFetch({ model: "claude-haiku-4-5-20251001", max_tokens: 220, messages: [{ role: "user", content: prompt }] });
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

// ── PROSPECTS (CRM-lite) ─────────────────────────────────────────────────────────
export const PROSPECT_STAGES = ["lead", "contacted", "trial", "invited", "won", "lost"];

export async function listProspects(coachId) {
  if (!supabase || !coachId) return [];
  const { data, error } = await supabase.from("prospects").select("*").eq("coach_id", coachId).order("created_at", { ascending: false });
  if (error) { console.warn("listProspects:", error.message); return []; }
  return data || [];
}
// Insert or update a prospect (RLS scopes to the coach). Returns the row or null.
export async function upsertProspect(coachId, p) {
  if (!supabase || !coachId) return null;
  const row = { coach_id: coachId, name: p.name || null, email: p.email || null, phone: p.phone || null,
    stage: p.stage || "lead", source: p.source || null, notes: p.notes || null, updated_at: new Date().toISOString() };
  if (p.id) row.id = p.id;
  const { data, error } = await supabase.from("prospects").upsert(row).select().maybeSingle();
  if (error) { console.warn("upsertProspect:", error.message); return null; }
  return data;
}
export async function deleteProspect(id) {
  if (!supabase || !id) return;
  await supabase.from("prospects").delete().eq("id", id);
}
export async function setProspectStage(id, stage) {
  if (!supabase || !id) return;
  await supabase.from("prospects").update({ stage, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── CLIENT INVITES (onboarding) ──────────────────────────────────────────────────
function newCode() {
  try { return crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(); }
  catch { return Math.random().toString(36).slice(2, 10).toUpperCase(); }
}
// ALWAYS the public site — never window.location.origin: inside the native app the
// origin is capacitor://localhost, which made texted invite links dead on arrival.
export const inviteLink = (code) => "https://www.bodymorph.info/?invite=" + code;

// Create a per-client invite; returns { code, link } or { error }.
export async function createClientInvite(coachId, { name, phone, email, intake } = {}) {
  if (!supabase || !coachId) return { error: "No backend." };
  const code = newCode();
  const { error } = await supabase.from("client_invites").insert({
    code, coach_id: coachId, name: name || null, phone: phone || null, email: email || null,
    intake: intake || {},
  });
  if (error) { console.warn("createClientInvite:", error.message); return { error: error.message }; }
  return { code, link: inviteLink(code) };
}
export async function listClientInvites(coachId) {
  if (!supabase || !coachId) return [];
  const { data, error } = await supabase.from("client_invites").select("*").eq("coach_id", coachId).order("created_at", { ascending: false });
  if (error) { console.warn("listClientInvites:", error.message); return []; }
  return data || [];
}
// Client side: redeem a per-client invite -> { ok, intake } | { ok:false, error }.
export async function redeemClientInvite(code) {
  if (!supabase) return { ok: false, error: "No backend." };
  const { data, error } = await supabase.rpc("redeem_client_invite", { p_code: (code || "").trim() });
  if (error) return { ok: false, error: error.message };
  return data || { ok: false, error: "Unknown error" };
}

// ── FINANCIALS (derived; live revenue arrives with Stripe Connect) ───────────────
export function computeFinancials(roster, monthlyPrice = 105) {  // coach net per consulting client (light); see revised economics
  const active = (roster || []).length;
  const month = ymdLocal().slice(0, 7);
  const newThisMonth = (roster || []).filter(c => (c.lastActive || "").startsWith(month)).length;
  return {
    activeClients: active,
    mrrEstimate: active * monthlyPrice,
    monthlyPrice,
    newThisMonth,
  };
}

// ── COACH SETTINGS / SESSIONS / PER-CLIENT FEES ──────────────────────────────────
const DEFAULT_SETTINGS = { inperson_rate: 75, consulting_fee: 105, monthly_goal: 0, voice_id: null };

export async function fetchSettings(coachId) {
  if (!supabase || !coachId) return { ...DEFAULT_SETTINGS };
  const { data } = await supabase.from("coach_settings").select("inperson_rate, consulting_fee, monthly_goal, voice_id").eq("coach_id", coachId).maybeSingle();
  return { ...DEFAULT_SETTINGS, ...(data || {}) };
}

// The coach's own identity, read from + written to their profiles row (existing owner RLS).
export async function fetchCoachProfile(coachId) {
  if (!supabase || !coachId) return null;
  const { data } = await supabase.from("profiles").select("first_name, last_name, phone, email").eq("id", coachId).maybeSingle();
  return data || null;
}
export async function updateCoachProfile(coachId, { firstName, lastName, phone }) {
  if (!supabase || !coachId) return { error: "No backend configured." };
  const patch = {};
  if (firstName !== undefined) patch.first_name = firstName;
  if (lastName  !== undefined) patch.last_name  = lastName;
  if (phone     !== undefined) patch.phone      = phone;
  const { error } = await supabase.from("profiles").update(patch).eq("id", coachId);
  return { error: error?.message || null };
}
export async function saveSettings(coachId, patch) {
  if (!supabase || !coachId) return;
  await supabase.from("coach_settings").upsert(
    { coach_id: coachId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "coach_id" });
}

// Log an in-person training session.
export async function logSession(coachId, { client_id, day, amount, note } = {}) {
  if (!supabase || !coachId) return { error: "No backend." };
  const { error } = await supabase.from("coach_sessions").insert(
    { coach_id: coachId, client_id: client_id || null, day, amount: Number(amount) || 0, note: note || null });
  return { error: error?.message || null };
}
// Sessions logged in the current calendar month (for "actual" in-person revenue).
export async function listSessionsThisMonth(coachId) {
  if (!supabase || !coachId) return [];
  const monthStart = new Date(); monthStart.setDate(1);
  const from = ymdLocal(monthStart);
  const { data, error } = await supabase.from("coach_sessions")
    .select("id, client_id, day, amount, note").eq("coach_id", coachId).gte("day", from).order("day", { ascending: false });
  if (error) { console.warn("listSessionsThisMonth:", error.message); return []; }
  return data || [];
}

// Set a per-client consulting fee override (null clears it -> uses base fee).
export async function setClientFee(coachId, clientId, fee) {
  if (!supabase || !coachId || !clientId) return;
  await supabase.from("relationships")
    .update({ consulting_fee: (fee === "" || fee == null) ? null : Number(fee) })
    .eq("coach_id", coachId).eq("client_id", clientId);
}

// ── COACH CALENDAR ───────────────────────────────────────────────────────────────
export async function listEvents(coachId, fromISO, toISO) {
  if (!supabase || !coachId) return [];
  const { data, error } = await supabase.from("coach_events")
    .select("*").eq("coach_id", coachId).gte("starts_at", fromISO).lt("starts_at", toISO).order("starts_at");
  if (error) { console.warn("listEvents:", error.message); return []; }
  return data || [];
}
export async function addEvent(coachId, { client_id, starts_at, title, type, note } = {}) {
  if (!supabase || !coachId) return { error: "No backend." };
  const { error } = await supabase.from("coach_events").insert(
    { coach_id: coachId, client_id: client_id || null, starts_at, title: title || null, type: type || "appointment", note: note || null });
  return { error: error?.message || null };
}
export async function deleteEvent(id) {
  if (!supabase || !id) return;
  await supabase.from("coach_events").delete().eq("id", id);
}

// ── AUTOMATED FOLLOW-UPS (trigger detection) ─────────────────────────────────────
// Evaluates each active client's last 7 days and emits follow-up triggers. This is
// the in-house "brain"; the same output later drives GoHighLevel auto-send. Each
// item carries a ready-to-send drafted message (template now; GHL/AI personalizes later).
export async function detectFollowups(coachId) {
  if (!supabase || !coachId) return [];
  const { data: rels } = await supabase.from("relationships").select("client_id").eq("coach_id", coachId).eq("status", "active");
  const ids = (rels || []).map(r => r.client_id);
  if (!ids.length) return [];
  const cut = new Date(); cut.setDate(cut.getDate() - 6);
  const from = ymdLocal(cut);
  const [profiles, workouts, foods, rewards] = await Promise.all([
    supabase.from("profiles").select("id, first_name, extra").in("id", ids),
    supabase.from("workout_logs").select("user_id, day").in("user_id", ids).gte("day", from),
    supabase.from("food_log_days").select("user_id, day").in("user_id", ids).gte("day", from),
    supabase.from("rewards").select("user_id, stats").in("user_id", ids),
  ]);
  const distinctDays = (rows, id) => new Set((rows || []).filter(r => r.user_id === id).map(r => r.day)).size;

  const items = [];
  for (const id of ids) {
    const p = (profiles.data || []).find(x => x.id === id);
    const name = (p?.extra?.name) || p?.first_name || "there";
    const first = name.split(" ")[0];
    const w = distinctDays(workouts.data, id);
    const m = distinctDays(foods.data, id);
    const streak = ((rewards.data || []).find(r => r.user_id === id)?.stats || {}).currentStreak || 0;

    // Workout consistency
    if (w >= 4 || streak >= 7) {
      items.push({ clientId:id, name, key:"weekComplete", severity:"good", label:"Consistent week",
        message:`Great week, ${first}! You crushed ${w} workout${w===1?"":"s"}. That consistency is exactly how results happen — keep the momentum going 💪` });
    } else if (w === 0) {
      items.push({ clientId:id, name, key:"workoutGap", severity:"alert", label:"No workouts this week",
        message:`Hey ${first}, I haven't seen a workout logged this week. Everything okay? Let's get one in today — even a short session counts. I'm in your corner.` });
    } else {
      items.push({ clientId:id, name, key:"weekMissed", severity:"warn", label:`Only ${w}/4 workouts`,
        message:`Hey ${first}, you got ${w} workout${w===1?"":"s"} in this week — let's finish strong. What's getting in the way? Tell me and we'll adjust.` });
    }
    // Nutrition logging
    if (m < 5) {
      items.push({ clientId:id, name, key:"mealGaps", severity:"warn", label:`Meals logged ${m}/7`,
        message:`${first}, you logged meals ${m} of 7 days this week. Tracking is half the battle — let's tighten it up. Try logging today's meals as you eat them!` });
    }
  }
  const rank = { alert:0, warn:1, good:2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ── AI INTAKE EVALUATION (coach decision-support) ────────────────────────────────
export async function fetchEvaluation(coachId, clientId) {
  if (!supabase || !coachId || !clientId) return null;
  const { data } = await supabase.from("client_evaluations")
    .select("intake, evaluation, updated_at").eq("coach_id", coachId).eq("client_id", clientId).maybeSingle();
  return data || null;
}
export async function saveEvaluation(coachId, clientId, intake, evaluation) {
  if (!supabase || !coachId || !clientId) return;
  await supabase.from("client_evaluations").upsert(
    { coach_id: coachId, client_id: clientId, intake, evaluation, updated_at: new Date().toISOString() },
    { onConflict: "coach_id,client_id" });
}

// Generate a structured fitness evaluation + recommendation from intake. Claude
// Sonnet for the reasoning. Returns { evaluation } or { error }.
// Guardrail: fitness-coaching scope only; respects allergies + injuries; flags
// medical red flags for physician clearance; it's a coach-reviewed DRAFT.
export async function generateEvaluation(intake) {
  if (!USE_PROXY && !ANTHROPIC_KEY) return { error: "No AI key configured." };
  const prompt =
    "You are an experienced fitness coach's assistant producing a DRAFT evaluation for the COACH to review (not shown to the client, not medical advice). " +
    "Stay strictly within fitness-coaching scope. Respect the client's food allergies and dietary preferences in any diet guidance. Accommodate past/current injuries in the exercise plan. " +
    "If anything is a medical red flag (e.g. chest pain, uncontrolled conditions, recent surgery, pregnancy concerns), do NOT advise on it — instead flag it and recommend the client get physician clearance.\n\n" +
    "Reply with ONLY a JSON object (no markdown) in exactly this shape:\n" +
    "{\"assessment\":\"2-3 sentence read on where the client is + any flags\",\"diet\":\"concise diet recommendation respecting allergies/preferences\",\"exercise\":\"concise exercise routine accommodating injuries\",\"timeline\":{\"recommended\":\"e.g. 3 months\",\"realistic\":true,\"desiredVerdict\":\"is the client's desired timeframe realistic? brief why\",\"milestones\":[{\"at\":\"6 weeks\",\"expect\":\"...\"},{\"at\":\"3 months\",\"expect\":\"...\"}]}}\n\n" +
    "Client intake:\n" + JSON.stringify(intake);
  try {
    const res = await anthropicFetch({ model: "claude-sonnet-4-6", max_tokens: 1100, messages: [{ role: "user", content: prompt }] });
    if (!res.ok) return { error: `AI error (${res.status})` };
    const data = await res.json();
    let text = (data.content?.[0]?.text || "").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");   // strip code fences if any
    const evaluation = JSON.parse(text);
    return { evaluation };
  } catch (e) { return { error: "Couldn't parse evaluation: " + e.message }; }
}

// ── COACH-AUTHORED FORM CUES ────────────────────────────────────────────────────
// The coach writes/edits the exact teaching points the client's VOICE COACH speaks
// for a given exercise. On the client's device these BEAT the cues auto-extracted
// from a pinned video's description — the coach is the authority on their teaching.

// Coach side: all cues this coach has written for one client.
export async function listCoachCues(coachId, clientId) {
  if (!supabase || !coachId || !clientId) return [];
  const { data, error } = await supabase.from("coach_cues")
    .select("exercise, cues, updated_at")
    .eq("coach_id", coachId).eq("client_id", clientId)
    .order("exercise");
  if (error) { console.warn("coach listCoachCues:", error.message); return []; }
  return data || [];
}

export async function saveCoachCue(coachId, clientId, exercise, cues) {
  if (!supabase) return { error: "No backend configured." };
  const { error } = await supabase.from("coach_cues").upsert({
    coach_id: coachId, client_id: clientId,
    exercise: String(exercise || "").trim(),
    cues: String(cues || "").trim(),
    updated_at: new Date().toISOString(),
  });
  return { error: error?.message || null };
}

export async function deleteCoachCue(coachId, clientId, exercise) {
  if (!supabase) return { error: "No backend configured." };
  const { error } = await supabase.from("coach_cues").delete()
    .eq("coach_id", coachId).eq("client_id", clientId).eq("exercise", exercise);
  return { error: error?.message || null };
}

// Client side: my coach's cues for me, keyed by lowercased exercise name for the
// voice coach's case-insensitive lookup. RLS only returns rows addressed to me.
export async function fetchMyCoachCues(clientId) {
  if (!supabase || !clientId) return {};
  const { data, error } = await supabase.from("coach_cues").select("exercise, cues").eq("client_id", clientId);
  if (error) { console.warn("coach fetchMyCoachCues:", error.message); return {}; }
  const map = {};
  for (const r of (data || [])) if (r.cues) map[String(r.exercise).trim().toLowerCase()] = r.cues;
  return map;
}

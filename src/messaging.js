// In-app coach↔client messaging. One thread per (coach, client) pair, stored in
// the `messages` table (migration 0017). Chat stays INSIDE BodyMorph — no SMS,
// no Twilio — and the recent thread feeds the AI voice coach's context so the
// human coach and the AI coach never contradict each other.
// Live delivery via Supabase realtime, with polling as the fallback.
// No backend / not signed in → safe no-ops.
import { supabase } from "./supabase";

// The client's active coach (needed to address the thread). Null = no coach.
export async function myCoachId(clientId) {
  if (!supabase || !clientId) return null;
  const { data } = await supabase.from("relationships")
    .select("coach_id").eq("client_id", clientId).eq("status", "active").maybeSingle();
  return data?.coach_id || null;
}

// Oldest-first thread (render top to bottom, newest at the bottom).
export async function fetchThread(coachId, clientId, limit = 200) {
  if (!supabase || !coachId || !clientId) return [];
  const { data, error } = await supabase.from("messages")
    .select("id, sender, body, created_at, read_at")
    .eq("coach_id", coachId).eq("client_id", clientId)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) { console.warn("fetchThread:", error.message); return []; }
  return (data || []).reverse();
}

// Send as yourself. Returns the inserted row (for optimistic UI) or null.
export async function sendMessage(coachId, clientId, sender, body) {
  const text = (body || "").trim();
  if (!supabase || !coachId || !clientId || !text) return null;
  const { data, error } = await supabase.from("messages")
    .insert({ coach_id: coachId, client_id: clientId, sender, body: text.slice(0, 4000) })
    .select("id, sender, body, created_at, read_at").maybeSingle();
  if (error) { console.warn("sendMessage:", error.message); return null; }
  return data;
}

// Mark everything the OTHER party sent as read. meRole: 'coach' | 'client'.
export async function markThreadRead(coachId, clientId, meRole) {
  if (!supabase || !coachId || !clientId) return;
  await supabase.from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("coach_id", coachId).eq("client_id", clientId)
    .eq("sender", meRole === "coach" ? "client" : "coach")
    .is("read_at", null);
}

// Coach side: unread counts across the whole roster → { clientId: n }.
export async function unreadByClient(coachId) {
  if (!supabase || !coachId) return {};
  const { data, error } = await supabase.from("messages")
    .select("client_id")
    .eq("coach_id", coachId).eq("sender", "client").is("read_at", null);
  if (error) return {};
  const out = {};
  (data || []).forEach(r => { out[r.client_id] = (out[r.client_id] || 0) + 1; });
  return out;
}

// Client side: how many coach messages are waiting.
export async function unreadForClient(clientId) {
  if (!supabase || !clientId) return 0;
  const { count, error } = await supabase.from("messages")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId).eq("sender", "coach").is("read_at", null);
  return error ? 0 : (count || 0);
}

// Live thread updates. cb(row) fires for every new message in the pair's thread.
// Returns an unsubscribe fn. Callers should ALSO poll (10-15s) — realtime needs
// the table in the supabase_realtime publication, and networks drop.
export function subscribeThread(coachId, clientId, cb) {
  if (!supabase || !coachId || !clientId) return () => {};
  const ch = supabase.channel(`msg-${coachId}-${clientId}`)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `client_id=eq.${clientId}` },
      (payload) => { if (payload.new?.coach_id === coachId) cb(payload.new); })
    .subscribe();
  return () => { try { supabase.removeChannel(ch); } catch { /* already gone */ } };
}

// Compact recent-thread summary for the AI voice coach's prompt: the human
// coach leads; the AI must know what was said. Last `days` days, max `max` msgs.
export function threadForPrompt(msgs, { days = 7, max = 10 } = {}) {
  if (!msgs || !msgs.length) return "";
  const cut = Date.now() - days * 86400000;
  return msgs
    .filter(m => new Date(m.created_at).getTime() >= cut)
    .slice(-max)
    .map(m => `${m.sender === "coach" ? "Coach" : "Client"}: ${m.body}`)
    .join("\n");
}

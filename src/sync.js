import { supabase } from "./supabase";

// ── CLOUD SYNC ENGINE ─────────────────────────────────────────────────────────
// Offline-first: localStorage stays the instant on-device copy; this layer pushes
// changes up (debounced) and pulls + smart-merges on login. See memory:
// bodymorph-sync-strategy. No backend / not signed in -> every call is a safe no-op.

// ── Merge helpers ──────────────────────────────────────────────────────────────
// Dated arrays [{date, ...}]: union by date. LOCAL wins on a same-date conflict —
// the device you're actively using shouldn't lose the edit you just made; cloud-only
// dates (from another device) are added in. (Per-record updated_at LWW is a later
// refinement; this is correct for the common single-device / offline-then-sync cases.)
function mergeByDate(local, cloud) {
  const byDate = new Map();
  (cloud || []).forEach(r => { if (r && r.date != null) byDate.set(r.date, r); });
  (local || []).forEach(r => { if (r && r.date != null) byDate.set(r.date, r); });
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ── Domain registry ─────────────────────────────────────────────────────────────
// Each domain maps an app state value <-> its table. Add new domains here as we
// roll sync out table by table.
const DOMAINS = {
  steps: {
    table: "step_entries",
    onConflict: "user_id,day",
    toRows: (val, userId) => (val || [])
      .filter(e => e && e.date)
      .map(e => ({ user_id: userId, day: e.date, steps: parseInt(e.steps) || 0 })),
    fromRows: (rows) => (rows || []).map(r => ({ date: r.day, steps: r.steps })),
    merge: mergeByDate,
  },
};

// ── Engine ───────────────────────────────────────────────────────────────────────
// Push a domain's full value to the cloud (idempotent upsert).
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

// Pull a domain from the cloud and merge it with the local value. Returns the
// merged value (or `local` unchanged if no backend / not signed in / on error —
// sync must never lose or block the user's local data).
export async function pullMergeDomain(name, userId, local) {
  if (!supabase || !userId) return local;
  const d = DOMAINS[name];
  if (!d) { console.warn(`sync: unknown domain "${name}"`); return local; }
  const { data, error } = await supabase.from(d.table).select("*").eq("user_id", userId);
  if (error) { console.warn(`sync pull ${name}:`, error.message); return local; }
  return d.merge(local || [], d.fromRows(data));
}

// Debounced push — coalesces rapid state changes into one network write per domain.
const _timers = {};
export function pushDomainDebounced(name, userId, value, ms = 800) {
  if (!supabase || !userId) return;
  clearTimeout(_timers[name]);
  _timers[name] = setTimeout(() => { pushDomain(name, userId, value); }, ms);
}

import { supabase } from "./supabase";

// ── BILLING (client) ───────────────────────────────────────────────────────────
// Talks to the Vercel /api Stripe functions and reads the synced subscription
// status. Like `hasBackend`, billing degrades gracefully: with no publishable key
// configured, `billingEnabled` is false and the app does no gating at all.

export const billingEnabled = !!import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

// A subscription counts as entitling access while active or in trial.
export const isActive = (sub) => !!sub && (sub.status === "active" || sub.status === "trialing");

// Read-only: the current user's subscription row (written server-side by the
// Stripe webhook). Returns null if none / no backend / on error.
export async function fetchSubscription(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("subscriptions").select("*").eq("user_id", userId).maybeSingle();
  if (error) { console.warn("billing fetchSubscription:", error.message); return null; }
  return data || null;
}

// POST to an /api endpoint with the user's Supabase access token, then redirect
// the browser to the returned Stripe URL (hosted Checkout / Billing Portal).
async function redirectTo(path) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("Not signed in.");
  const res = await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.url) throw new Error(body.error || `Request failed (${res.status})`);
  window.location.href = body.url;
}

export const startCheckout = () => redirectTo("/api/create-checkout-session");
export const openPortal   = () => redirectTo("/api/create-portal-session");

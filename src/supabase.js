import { createClient } from "@supabase/supabase-js";

// Supabase client — backend foundation (auth + synced data).
// URL + publishable (anon) key are safe to ship in the browser; all real access
// control is enforced server-side by Row-Level Security.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && anonKey) ? createClient(url, anonKey) : null;
export const hasBackend = !!supabase;

// Dev-only handle so we can poke the connection from the preview console.
if (import.meta.env.DEV && typeof window !== "undefined") window.__sb = supabase;

// ── AUTH HELPERS ─────────────────────────────────────────────────────────────
// Thin wrappers over supabase.auth so the app never touches the SDK directly.
// Each returns { data?, error } with a friendly error string (never throws).

const friendly = (error) => (error ? (error.message || String(error)) : null);

// Create an account. Supabase emails a confirmation link by default, so a
// session may NOT come back immediately — caller checks `needsConfirm`.
export async function signUpEmail(email, password) {
  if (!supabase) return { error: "No backend configured." };
  const { data, error } = await supabase.auth.signUp({ email, password });
  // No session + a returned user = waiting on the email confirmation link.
  const needsConfirm = !error && !data?.session && !!data?.user;
  return { data, needsConfirm, error: friendly(error) };
}

export async function signInEmail(email, password) {
  if (!supabase) return { error: "No backend configured." };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return { data, error: friendly(error) };
}

export async function signOut() {
  if (!supabase) return { error: null };
  const { error } = await supabase.auth.signOut();
  return { error: friendly(error) };
}

// Email a password-reset link back to the app.
export async function sendPasswordReset(email) {
  if (!supabase) return { error: "No backend configured." };
  const redirectTo = (typeof window !== "undefined") ? window.location.origin : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  return { error: friendly(error) };
}

// Current session's user (or null), read once at boot.
export async function getUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.user || null;
}

// Subscribe to login/logout. Returns an unsubscribe function.
export function onAuth(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session?.user || null);
  });
  return () => data?.subscription?.unsubscribe?.();
}

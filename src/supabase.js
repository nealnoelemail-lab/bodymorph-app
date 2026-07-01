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

// ── PHONE VERIFICATION (one-time at signup) + PHONE-BASED PASSWORD RECOVERY ────
// Normalize to E.164 (Supabase/Twilio require it): strip spaces/dashes/parens; a bare
// 10-digit US number gets a +1. Anything already starting with + is left as-is.
export function normalizePhone(raw, defaultCountry = "1") {
  let s = String(raw || "").trim().replace(/[()\-\s.]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+${defaultCountry}${digits}`;   // US 10-digit
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// Attach a phone to the SIGNED-IN user and text them a one-time code (Supabase → Twilio).
export async function startPhoneVerify(phone) {
  if (!supabase) return { error: "No backend configured." };
  const { error } = await supabase.auth.updateUser({ phone: normalizePhone(phone) });
  return { error: friendly(error) };
}
// Confirm that code → the phone is now verified + attached to the account.
export async function confirmPhoneVerify(phone, token) {
  if (!supabase) return { error: "No backend configured." };
  const { data, error } = await supabase.auth.verifyOtp({ phone: normalizePhone(phone), token: String(token).trim(), type: "phone_change" });
  return { data, error: friendly(error) };
}

// Password recovery via the verified phone: text a sign-in code…
export async function sendPhoneCode(phone) {
  if (!supabase) return { error: "No backend configured." };
  const { error } = await supabase.auth.signInWithOtp({ phone: normalizePhone(phone) });
  return { error: friendly(error) };
}
// …verify it (this signs them in), then they can set a new password.
export async function verifyPhoneCode(phone, token) {
  if (!supabase) return { error: "No backend configured." };
  const { data, error } = await supabase.auth.verifyOtp({ phone: normalizePhone(phone), token: String(token).trim(), type: "sms" });
  return { data, error: friendly(error) };
}
// Set a new password for the currently signed-in user.
export async function updatePassword(password) {
  if (!supabase) return { error: "No backend configured." };
  const { error } = await supabase.auth.updateUser({ password });
  return { error: friendly(error) };
}

// Has the signed-in user verified a phone yet? (the one-time gate)
export async function isPhoneVerified() {
  const u = await getUser();
  return !!(u && u.phone && u.phone_confirmed_at);
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

// ── What the speech-to-speech coach actually costs ──────────────────────────────
// Neal is trialling OpenAI Realtime and needs to know the real per-client running
// cost before it goes anywhere near paying clients at $29/month.
//
// This meters from the API's OWN usage report on every turn (response.done carries
// exact token counts), not from wall-clock estimates. Each turn is stored with its
// RAW token counts alongside the computed cost and the rate card used — so if a rate
// changes, or I've got one wrong, the history can be recomputed without re-running a
// month of conversations.
import { supabase } from "./supabase.js";

// Per 1M tokens. Source: developers.openai.com/api/docs/pricing, read 2026-09-26.
// Versioned: rows record which card priced them, so a rate change doesn't silently
// rewrite history.
export const RATE_CARD = {
  id: "gpt-realtime@2026-09-26",
  model: "gpt-realtime",
  textIn: 4.00, textCachedIn: 0.40, textOut: 16.00,
  audioIn: 32.00, audioCachedIn: 0.40, audioOut: 64.00,
};

const per = (tokens, rate) => (Number(tokens) || 0) * rate / 1_000_000;

// Turn OpenAI's usage object into money. Cached tokens are billed at the cheap rate,
// so they're subtracted from the full-price counts rather than double-charged.
export function priceTurn(usage, card = RATE_CARD) {
  if (!usage) return null;
  const inDet = usage.input_token_details || {};
  const outDet = usage.output_token_details || {};
  const cachedDet = inDet.cached_tokens_details || {};

  const cachedText = Number(cachedDet.text_tokens) || 0;
  const cachedAudio = Number(cachedDet.audio_tokens) || 0;
  const textIn = Math.max(0, (Number(inDet.text_tokens) || 0) - cachedText);
  const audioIn = Math.max(0, (Number(inDet.audio_tokens) || 0) - cachedAudio);
  const textOut = Number(outDet.text_tokens) || 0;
  const audioOut = Number(outDet.audio_tokens) || 0;

  const cost =
    per(textIn, card.textIn) + per(cachedText, card.textCachedIn) + per(textOut, card.textOut) +
    per(audioIn, card.audioIn) + per(cachedAudio, card.audioCachedIn) + per(audioOut, card.audioOut);

  return {
    cost,
    tokens: { textIn, audioIn, textOut, audioOut, cachedText, cachedAudio },
    // Audio output dominates — worth seeing the split, because it's the lever.
    breakdown: {
      audioOut: per(audioOut, card.audioOut),
      audioIn: per(audioIn, card.audioIn),
      text: per(textIn, card.textIn) + per(textOut, card.textOut),
      cached: per(cachedText, card.textCachedIn) + per(cachedAudio, card.audioCachedIn),
    },
  };
}

// Buffer turns and flush in batches: a chatty session is many small turns, and one
// insert per turn would put a network write in the middle of a live conversation.
let pending = [];
let flushTimer = null;

export async function recordTurn({ usage, sessionId, userId }) {
  const priced = priceTurn(usage);
  if (!priced) return null;
  pending.push({
    user_id: userId || null,
    session_id: sessionId || null,
    engine: "openai-realtime",
    model: RATE_CARD.model,
    rate_card: RATE_CARD.id,
    text_in: priced.tokens.textIn,
    audio_in: priced.tokens.audioIn,
    text_out: priced.tokens.textOut,
    audio_out: priced.tokens.audioOut,
    cached_text_in: priced.tokens.cachedText,
    cached_audio_in: priced.tokens.cachedAudio,
    cost_usd: Math.round(priced.cost * 1e6) / 1e6,   // sub-cent turns matter in aggregate
  });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 4000);
  return priced;
}

export async function flush() {
  if (!supabase || !pending.length) return;
  const rows = pending;
  pending = [];
  try {
    const { error } = await supabase.from("voice_usage").insert(rows);
    // Put them back on failure — a dropped row understates the bill, which is the one
    // direction that matters when the whole point is to trust the number.
    if (error) { pending = rows.concat(pending); console.log(`[COST] flush failed: ${error.message}`); }
  } catch (e) {
    pending = rows.concat(pending);
    console.log(`[COST] flush threw: ${e.message}`);
  }
}

// Running totals for the trial. Days defaults to the 30-day window Neal asked for.
export async function costSummary(userId, days = 30) {
  if (!supabase) return null;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = supabase.from("voice_usage").select("cost_usd, audio_out, audio_in, created_at").gte("created_at", since);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error || !data) return null;

  const total = data.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  // Audio tokens are a fixed rate per second of speech, so they convert straight back
  // into minutes talked — the unit Neal can actually reason about.
  const coachMin = data.reduce((s, r) => s + (Number(r.audio_out) || 0), 0) / 1200;
  const clientMin = data.reduce((s, r) => s + (Number(r.audio_in) || 0), 0) / 600;
  const activeDays = new Set(data.map(r => String(r.created_at).slice(0, 10))).size || 1;

  return {
    turns: data.length,
    total,
    perDay: total / activeDays,
    projected30: (total / activeDays) * 30,
    coachMinutes: coachMin,
    clientMinutes: clientMin,
    activeDays,
  };
}

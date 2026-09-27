// ── OpenAI Realtime coach (speech-to-speech) ────────────────────────────────────
// EXPERIMENTAL, parked behind VITE_VOICE_PROVIDER=openai. The shipped coach is
// native mic → Grok STT → Claude → Grok TTS; this is one model that hears audio and
// answers in audio. Nothing here touches the old path — flip the env var back and
// the Grok stack returns untouched.
//
// Swift owns the socket and both directions of audio (see RealtimeVoicePlugin): the
// WebView can't set the auth header this socket needs, and on a real device the
// WebView mic is dead. This module owns the SESSION — persona, tools, and turning
// the model's tool calls into the app's existing actions.
import { registerPlugin, Capacitor } from "@capacitor/core";
import { openaiRealtimeToken } from "./aiproxy";
import { recordTurn, flush as flushCost } from "./voicecost";

const RealtimeVoice = registerPlugin("RealtimeVoice");
const IS_NATIVE = (() => { try { return Capacitor.isNativePlatform(); } catch { return false; } })();

// The shipped coach performs actions by emitting |||FOOD:{…}||| tags inside its reply,
// which a regex pulls out before the text is spoken. That can't work here: this model
// generates AUDIO directly, so a tag in its answer gets READ ALOUD. Same actions,
// expressed as real function calls instead.
export const REALTIME_TOOLS = [
  {
    type: "function", name: "log_food",
    description: "Log a food the client says they ate. Use their own words for the name.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", enum: ["breakfast", "lunch", "dinner", "snacks"] },
        name: { type: "string" },
        cal: { type: "number" }, protein: { type: "number" },
        carbs: { type: "number" }, fats: { type: "number" },
      },
      required: ["slot", "name", "cal", "protein", "carbs", "fats"],
    },
  },
  {
    type: "function", name: "remove_food",
    description: "Undo the last food logged for a meal when the client says they misspoke.",
    parameters: { type: "object", properties: { slot: { type: "string", enum: ["breakfast","lunch","dinner","snacks"] } }, required: ["slot"] },
  },
  {
    type: "function", name: "add_water",
    description: "Add cups of water. Negative to correct an over-count.",
    parameters: { type: "object", properties: { cups: { type: "number" } }, required: ["cups"] },
  },
  {
    type: "function", name: "set_water",
    description: "Set today's total cups of water to an exact number.",
    parameters: { type: "object", properties: { cups: { type: "number" } }, required: ["cups"] },
  },
  {
    type: "function", name: "log_steps",
    description: "Set today's step count to an exact number.",
    parameters: { type: "object", properties: { steps: { type: "number" } }, required: ["steps"] },
  },
  {
    type: "function", name: "log_sleep",
    description: "Log hours slept last night.",
    parameters: { type: "object", properties: { hours: { type: "number" } }, required: ["hours"] },
  },
  {
    type: "function", name: "log_set",
    description: "Log a completed weight-training set during a workout.",
    parameters: {
      type: "object",
      properties: { ex: { type: "number", description: "0-based exercise index" }, weight: { type: "number" }, reps: { type: "number" } },
      required: ["ex", "weight", "reps"],
    },
  },
  {
    type: "function", name: "remove_set",
    description: "Remove the last logged set for an exercise when the client says it was wrong.",
    parameters: { type: "object", properties: { ex: { type: "number" } }, required: ["ex"] },
  },
  {
    type: "function", name: "check_todo",
    description: "Tick an item off today's checklist.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
];

// The shipped prompt teaches the ||| tag format. Override that here rather than
// maintaining a second persona — the whole point of the trial is that only the ENGINE
// differs, so the coach has to be the same coach.
const TOOL_OVERRIDE = `

IMPORTANT — HOW YOU TAKE ACTIONS IN THIS MODE:
Ignore every instruction above about ||| tags. You are speaking out loud, so a tag would be heard by the client. Instead, call the matching function: log_food, remove_food, add_water, set_water, log_steps, log_sleep, log_set, remove_set, check_todo. Never say the words "function", "tool" or "log tag" out loud — just do it and confirm naturally in your own voice, the way you always would.

NEVER INVENT A NUMBER. This is the hardest rule you have.
Only log a value the client ACTUALLY SAID. "Pretty good", "decent", "not bad" and "alright" are not numbers — they are feelings. If you need a figure and don't have one, ASK for it and wait ("Nice — how many hours you get?"). Do not estimate, do not split the difference, do not infer a number from their tone, their usual pattern, or their goal.

SAY IT BACK BEFORE YOU LOG IT. Every single time, without exception: repeat the number out loud and log it in the SAME breath ("Eight hours — got it"). Never log silently, and never log a number that hasn't just come out of your own mouth in the client's hearing. That way a mistake is caught in the two seconds before it matters instead of sitting in their record for a week.

LOG WHAT HAPPENED, NOT WHAT'S PLANNED. "I'm probably going to have four eggs" is a plan, not a meal. Wait until they've actually eaten it — "go enjoy it, tell me when it's down" — then log. The same goes for water they're about to drink and sets they're about to do. A log full of intentions is worse than an empty one, because it reads as fact later.

A RANGE IS NOT A NUMBER EITHER. "Three or four slices" means you ask which — never quietly pick one and log it.

IF YOU DIDN'T HEAR IT CLEARLY, SAY SO. Audio drops words. If you're piecing a number together from a fragment, or you only half-caught it, ask again — "say that again for me?" is always better than a confident guess. A number you made up goes into their permanent record and into their coach's report, and it corrupts everything built on it.

And if you do get something wrong, say so plainly and fix it. Never explain away a mistake with a story about how you knew — that is worse than the mistake.`;

// OpenAI ships a fixed set of voices and does NOT clone. The app stores the coach's
// voice as a GROK voice id ("hvff5tluuao4" = Neal's cloned "Coach Neal"), and passing
// that through is a 400 that kills the whole session before it starts — which is
// precisely how this first presented: connect, silence, nothing in the log.
// So: only ever send a voice OpenAI actually has.
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];
const DEFAULT_VOICE = "cedar";   // the closest natural male coach voice OpenAI offers
export const openaiVoice = (v) => (OPENAI_VOICES.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : DEFAULT_VOICE);

export const realtimeSupported = () => IS_NATIVE;

let listeners = [];
const clearListeners = async () => {
  for (const l of listeners) { try { (await l).remove(); } catch { /* already gone */ } }
  listeners = [];
};

// Map a tool call onto the app's existing action handlers — the SAME ones the Grok
// coach drives through its text tags, so both engines change the app identically.
function runTool(name, args, h) {
  switch (name) {
    case "log_food":    h.onLogFood && h.onLogFood(args); return `Logged ${args.name || "food"}`;
    case "remove_food": h.onRemoveFood && h.onRemoveFood(args); return "Removed";
    case "add_water":   h.onAddWater && h.onAddWater(args.cups); return "Water logged";
    case "set_water":   h.onSetWater && h.onSetWater(args.cups); return "Water set";
    case "log_steps":   h.onLogSteps && h.onLogSteps({ set: args.steps }); return "Steps updated";
    case "log_sleep":   h.onLogSleep && h.onLogSleep(args.hours); return "Sleep logged";
    case "log_set":     h.onLogSet && h.onLogSet(args); return `Logged ${args.weight}x${args.reps}`;
    case "remove_set":  h.onRemoveSet && h.onRemoveSet({ ...args, remove: true }); return "Set removed";
    case "check_todo":  h.onCheckTodo && h.onCheckTodo(args.key); return "Checked off";
    default: return "Unknown action";
  }
}

// Open a speech-to-speech session. `instructions` is the app's own system prompt so
// the persona is identical to the shipped coach. Returns {ok} or throws.
const rtLog = (m) => { try { console.log(`[RT] ${m}`); } catch { /* no console */ } };

export async function startRealtimeCoach({ instructions, voice, model, userId, handlers = {}, onEvent } = {}) {
  const sessionId = `rt_${Date.now().toString(36)}`;
  rtLog(`start: native=${IS_NATIVE} promptChars=${(instructions || "").length} voice=${openaiVoice(voice)} (asked for ${voice || "none"})`);
  if (!IS_NATIVE) throw new Error("The speech-to-speech coach runs on the phone app only.");

  const session = {
    type: "realtime",
    instructions: (instructions || "") + TOOL_OVERRIDE,
    tools: REALTIME_TOOLS,
    tool_choice: "auto",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        // Let OpenAI decide when a turn ends — it hears the audio, so its own
        // endpointing beats the energy-threshold gate the old pipeline needs.
        // server_vad, NOT semantic_vad. Semantic detection is eager — it fires on
        // anything that sounds like a finished thought, including the coach's own
        // voice bleeding into the mic and whatever the transcriber invents from
        // silence ("Thank you.", "God bless." are Whisper's classic hallucinations
        // on a quiet track, and each one cost a phantom turn). Energy-gated
        // detection with an explicit threshold doesn't bite on near-silence.
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,             // above room noise and residual echo
          prefix_padding_ms: 300,
          silence_duration_ms: 700,   // let a person pause mid-sentence without being cut off
        },
        transcription: { model: "whisper-1" },
      },
      output: { format: { type: "audio/pcm", rate: 24000 }, voice: openaiVoice(voice) },
    },
  };

  let minted;
  try {
    rtLog("requesting token...");
    minted = await openaiRealtimeToken({ instructions: session.instructions, tools: REALTIME_TOOLS, voice: openaiVoice(voice), model });
  } catch (e) {
    rtLog(`TOKEN FAILED: ${e.message}`);
    throw e;
  }
  const token = minted?.value;
  rtLog(`token ${token ? "ok" : "MISSING"} model=${minted?.session?.model || "?"}`);
  if (!token) throw new Error("No realtime token returned.");

  await clearListeners();
  listeners.push(RealtimeVoice.addListener("rtToolCall", async (e) => {
    let args = {};
    try { args = JSON.parse(e.arguments || "{}"); } catch { /* malformed — run with nothing */ }
    const result = runTool(e.name, args, handlers);
    onEvent && onEvent({ type: "action", name: e.name, args, result });
    try { await RealtimeVoice.sendToolResult({ callId: e.callId, output: JSON.stringify({ ok: true, detail: result }) }); }
    catch { /* socket already closed */ }
  }));
  listeners.push(RealtimeVoice.addListener("rtCoachSaid", (e) => { rtLog(`coach: ${e.text}`); onEvent && onEvent({ type: "coach", text: e.text }); }));
  listeners.push(RealtimeVoice.addListener("rtUserSaid", (e) => { rtLog(`you: ${e.text}`); onEvent && onEvent({ type: "user", text: e.text }); }));
  listeners.push(RealtimeVoice.addListener("rtUserSpeaking", () => onEvent && onEvent({ type: "listening" })));
  listeners.push(RealtimeVoice.addListener("rtTurnDone", async (e) => {
    // Meter every turn from the API's own numbers.
    try {
      const usage = e.usage ? JSON.parse(e.usage) : null;
      if (usage) {
        const priced = await recordTurn({ usage, sessionId, userId });
        if (priced) rtLog(`turn cost $${priced.cost.toFixed(4)} (audio out $${priced.breakdown.audioOut.toFixed(4)})`);
      }
    } catch (err) { rtLog(`cost meter: ${err.message}`); }
    onEvent && onEvent({ type: "idle" });
  }));
  listeners.push(RealtimeVoice.addListener("rtError", (e) => onEvent && onEvent({ type: "error", error: e.error })));
  listeners.push(RealtimeVoice.addListener("rtOpen", () => onEvent && onEvent({ type: "open" })));
  listeners.push(RealtimeVoice.addListener("rtAudio", (e) => onEvent && onEvent({ type: "audio", text: `mic ${e.micHz}Hz` })));
  // Proof the silence gate is earning its keep: what share of mic audio we paid to send.
  // peak = how loud this client is when they genuinely speak; gate = the line anything
  // must clear to be sent. If background chatter is getting through, those two numbers
  // are what say whether the window is too wide or the reference never formed.
  listeners.push(RealtimeVoice.addListener("rtGate", (e) => rtLog(
    `gate: sending ${e.sentPct}% of mic audio (floor ${e.floorDb}dB, your voice ${e.peakDb > -100 ? e.peakDb + "dB" : "not heard yet"}, cutoff ${e.gateDb}dB)`)));

  rtLog("opening socket...");
  await RealtimeVoice.start({
    token,
    model: model || minted?.session?.model || "gpt-realtime",
    session: JSON.stringify(session),
  });
  rtLog("socket open");
  return { ok: true };
}

export async function stopRealtimeCoach() {
  await flushCost();          // don't lose the last turns of a session
  await clearListeners();
  try { await RealtimeVoice.stop(); } catch { /* not running */ }
}

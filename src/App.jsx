import { useState, useEffect } from "react";

const C = {
  bg: "#0a0a0f", surface: "#12121a", card: "#1a1a26", border: "#2a2a3d",
  accent: "#e8ff00", red: "#ff3d3d", blue: "#3d8eff", purple: "#9b5de5",
  green: "#3ddc84", text: "#f0f0f8", muted: "#7070a0",
};

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600;700&family=Oswald:wght@500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #f0f0f8; font-family: 'DM Sans', sans-serif; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #12121a; }
  ::-webkit-scrollbar-thumb { background: #2a2a3d; border-radius: 2px; }
  @keyframes fadeIn { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:translateY(0); } }
  @keyframes spin { to { transform:rotate(360deg); } }
  .fade-in { animation: fadeIn 0.35s ease both; }
`;

// ── PERSISTENT STORAGE ──────────────────────────────────────────────────────────
// Uses the browser's localStorage so data survives refreshes and revisits.
// Falls back to in-memory if localStorage is unavailable (e.g. private mode quota).
const _mem = {};
const Store = {
  async get(key) {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const v = window.localStorage.getItem(key);
        return v != null ? JSON.parse(v) : (key in _mem ? _mem[key] : null);
      }
    } catch (e) {}
    return key in _mem ? _mem[key] : null;
  },
  async set(key, value) {
    _mem[key] = value;
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    } catch (e) { /* quota exceeded or unavailable: in-memory still holds it for this session */ }
  },
};
const PROFILE_KEY = "bodymorph_profile_v2";
const LOG_KEY     = "bodymorph_logs_v2";
const MEDAL_KEY   = "bodymorph_medals_v2";
const BODY_KEY    = "bodymorph_body_v2";

const MEDAL_DEFS = [
  { id:"first_log",    label:"First Rep",        emoji:"\uD83C\uDF31", coins:10,  test:(s)=> s.totalLogs >= 1 },
  { id:"logs_10",      label:"Consistent",       emoji:"\uD83D\uDCAA", coins:25,  test:(s)=> s.totalLogs >= 10 },
  { id:"logs_25",      label:"Dedicated",        emoji:"\uD83D\uDD25", coins:50,  test:(s)=> s.totalLogs >= 25 },
  { id:"logs_50",      label:"Iron Habit",       emoji:"\u2699\uFE0F", coins:100, test:(s)=> s.totalLogs >= 50 },
  { id:"first_pr",     label:"First PR",         emoji:"\uD83D\uDCC8", coins:20,  test:(s)=> s.totalPRs >= 1 },
  { id:"pr_10",        label:"Record Breaker",   emoji:"\uD83C\uDFC5", coins:60,  test:(s)=> s.totalPRs >= 10 },
  { id:"pr_25",        label:"Unstoppable",      emoji:"\uD83D\uDC51", coins:120, test:(s)=> s.totalPRs >= 25 },
  { id:"workout_1",    label:"Day One",          emoji:"\u2705", coins:15,  test:(s)=> s.workoutsCompleted >= 1 },
  { id:"workout_5",    label:"Five Strong",      emoji:"\u26A1", coins:40,  test:(s)=> s.workoutsCompleted >= 5 },
  { id:"workout_12",   label:"Block Crusher",    emoji:"\uD83D\uDCAF", coins:90,  test:(s)=> s.workoutsCompleted >= 12 },
  { id:"streak_3",     label:"On a Roll",        emoji:"\uD83C\uDF1F", coins:30,  test:(s)=> s.bestStreak >= 3 },
  { id:"streak_7",     label:"Week Warrior",     emoji:"\uD83D\uDE80", coins:75,  test:(s)=> s.bestStreak >= 7 },
];

function emptyMedalState() {
  return { coins:0, medals:[], earnedIds:[],
    stats:{ totalLogs:0, totalPRs:0, workoutsCompleted:0, bestStreak:0, lastWorkoutDate:null, currentStreak:0 } };
}

// Given updated stats, award any newly-qualified medals. Returns {state, newlyEarned}.
function evaluateMedals(state) {
  const newlyEarned = [];
  MEDAL_DEFS.forEach(def => {
    if (!state.earnedIds.includes(def.id) && def.test(state.stats)) {
      state.earnedIds.push(def.id);
      const medal = { id:def.id, label:def.label, emoji:def.emoji, coins:def.coins, date:new Date().toISOString() };
      state.medals.push(medal);
      state.coins += def.coins;
      newlyEarned.push(medal);
    }
  });
  return { state, newlyEarned };
}

const EX = {
  chest: [
    { exercise:"Incline Dumbbell Press", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Set bench to 30 degrees, pause 1 second at the bottom, and feel the stretch across your upper chest." },
    { exercise:"Hammer Strength Decline Press", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Lift hips off the pad and sit at the seat edge for full range and lower-chest tension." },
    { exercise:"Flat Dumbbell Press", sets:"3", reps:"10-12", rest:"75s", tempo:"3-1-2", coachCue:"Lower until you feel a deep stretch, then press up without locking out to keep tension on the chest." },
    { exercise:"Pec Deck Fly", sets:"3", reps:"12-15", rest:"60s", tempo:"3-1-2", coachCue:"Place a block behind your back to increase the stretch, then squeeze hard at the inner chest." },
    { exercise:"Cable Crossover", sets:"3", reps:"15", rest:"60s", tempo:"2-1-2", coachCue:"Cross your hands slightly past center and hold the squeeze 1 second to hit the inner pec." },
    { exercise:"Push-Up (feet elevated)", sets:"3", reps:"to failure", rest:"60s", tempo:"3-1-2", coachCue:"Elevate the feet to bias the upper chest and lower slowly with control." },
  ],
  back: [
    { exercise:"Incline Bench Lat Pulldown", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Lie chest-down on a 45 degree incline facing the cable, pull to the upper chest, and squeeze the lats." },
    { exercise:"Chest-Supported Dumbbell Row", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Drive elbows back and pinch shoulder blades together; feel it deep in the mid-back, not the arms." },
    { exercise:"Wide-Grip Lat Pulldown", sets:"3", reps:"10-12", rest:"75s", tempo:"3-1-2", coachCue:"Pull the bar to the upper chest leading with the elbows to widen the lats." },
    { exercise:"Seated Cable Row", sets:"3", reps:"12", rest:"75s", tempo:"3-1-2", coachCue:"Do not push with your legs; keep the torso still and let the back do all the pulling." },
    { exercise:"Single-Arm Dumbbell Row", sets:"3", reps:"12 each", rest:"60s", tempo:"3-1-2", coachCue:"Pull the dumbbell to your hip and squeeze the lat at the top before lowering slowly." },
    { exercise:"Straight-Arm Pulldown", sets:"3", reps:"15", rest:"60s", tempo:"2-1-2", coachCue:"Keep your arms locked straight and pull from the lats only; feel the stretch at the top." },
  ],
  shoulders: [
    { exercise:"Dumbbell Lateral Raise", sets:"4", reps:"12-15", rest:"60s", tempo:"2-1-2", coachCue:"Lean slightly forward and lead with your elbows, not your hands, to isolate the side delts." },
    { exercise:"Seated Dumbbell Press", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Keep elbows slightly forward and stop just short of lockout to keep tension on the delts." },
    { exercise:"Wide-Grip Upright Row", sets:"3", reps:"12", rest:"75s", tempo:"3-1-2", coachCue:"Use a wider-than-shoulder grip and raise elbows to shoulder height to bias the medial delts." },
    { exercise:"Cable Lateral Raise", sets:"3", reps:"15", rest:"60s", tempo:"2-1-2", coachCue:"Stand side-on to the cable for constant tension; raise to shoulder height and control the return." },
    { exercise:"Reverse Pec Deck", sets:"3", reps:"15", rest:"60s", tempo:"2-1-2", coachCue:"Lead with the elbows and squeeze the rear delts; keep your chest pinned to the pad." },
    { exercise:"Front Plate Raise", sets:"3", reps:"12", rest:"60s", tempo:"2-1-2", coachCue:"Raise to eye level with a slight bend in the elbows to hit the front delt without swinging." },
  ],
  arms: [
    { exercise:"Incline Dumbbell Curl", sets:"4", reps:"10-12", rest:"60s", tempo:"3-1-2", coachCue:"Lie back on a 45 degree incline to stretch the biceps fully before each curl." },
    { exercise:"Rope Pushdown", sets:"4", reps:"12-15", rest:"60s", tempo:"3-1-2", coachCue:"Spread the rope apart at the bottom and squeeze the triceps for a full 1 second." },
    { exercise:"Hammer Curl", sets:"3", reps:"12", rest:"60s", tempo:"3-1-2", coachCue:"Keep elbows pinned to your sides to load the brachialis and build arm thickness." },
    { exercise:"Overhead Cable Extension", sets:"3", reps:"12-15", rest:"60s", tempo:"3-1-2", coachCue:"Keep elbows high and still; feel the stretch in the long head of the triceps." },
    { exercise:"Preacher Curl", sets:"3", reps:"10-12", rest:"60s", tempo:"3-1-2", coachCue:"Keep the back of the arm flat on the pad and stop short of lockout to keep tension." },
    { exercise:"Close-Grip Bench Press", sets:"3", reps:"10", rest:"75s", tempo:"3-1-2", coachCue:"Tuck the elbows close and press through the triceps, not the chest." },
  ],
  glutes: [
    { exercise:"Barbell Hip Thrust", sets:"4", reps:"10-12", rest:"90s", tempo:"3-2-1", coachCue:"Drive through your heels and squeeze the glutes hard for 2 full seconds at the top." },
    { exercise:"Cable Glute Kickback", sets:"4", reps:"12-15", rest:"60s", tempo:"2-1-2", coachCue:"Lock the hip in place, move only the leg, and hold the squeeze 1 second at full extension." },
    { exercise:"Sumo Squat", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Take a wide stance with toes out, sit straight down, and feel the inner thighs and glutes." },
    { exercise:"Romanian Deadlift", sets:"4", reps:"10-12", rest:"90s", tempo:"3-1-2", coachCue:"Hinge at the hips and let the bar drag down your legs; feel the deep hamstring stretch." },
    { exercise:"Glute Bridge March", sets:"3", reps:"12 each", rest:"60s", tempo:"2-1-2", coachCue:"Hold a high bridge and lift one knee at a time without letting the hips drop." },
    { exercise:"Bulgarian Split Squat", sets:"3", reps:"10-12 each", rest:"75s", tempo:"3-1-2", coachCue:"Lean the torso slightly forward over the front leg to bias the glute over the quad." },
  ],
  legs: [
    { exercise:"Leg Press (feet high and wide)", sets:"4", reps:"12-15", rest:"90s", tempo:"3-1-2", coachCue:"Place feet high and wide to shift the load to the glutes and hamstrings instead of quads." },
    { exercise:"Seated Leg Curl", sets:"4", reps:"12-15", rest:"75s", tempo:"3-1-2", coachCue:"Keep your chest off the pad and arms extended to isolate the hamstrings and kill momentum." },
    { exercise:"Walking Lunge", sets:"3", reps:"12 each", rest:"75s", tempo:"2-1-2", coachCue:"Take a long stride and push through the front heel to load the glutes over the quads." },
    { exercise:"Leg Extension", sets:"3", reps:"15", rest:"60s", tempo:"3-1-2", coachCue:"Pause and squeeze at the top for 1 second; point toes slightly to bias different quad heads." },
    { exercise:"Goblet Squat", sets:"3", reps:"12", rest:"75s", tempo:"3-1-2", coachCue:"Hold the weight at the chest, sit down between the heels, and keep the torso tall." },
    { exercise:"Lying Leg Curl", sets:"3", reps:"12-15", rest:"60s", tempo:"3-1-2", coachCue:"Curl fully and lower slowly; keep the hips pressed into the pad the whole time." },
  ],
  calves: [
    { exercise:"Standing Calf Raise", sets:"4", reps:"15-20", rest:"45s", tempo:"3-1-3", coachCue:"Get a full stretch at the bottom and a hard squeeze at the top through the full range." },
    { exercise:"Seated Calf Raise", sets:"3", reps:"15-20", rest:"45s", tempo:"3-1-3", coachCue:"Pause at the bottom stretch for 2 seconds to target the deeper soleus muscle." },
    { exercise:"Leg Press Calf Press", sets:"3", reps:"15-20", rest:"45s", tempo:"3-1-3", coachCue:"Push through the balls of your feet and hold the top contraction before lowering slowly." },
  ],
  core: [
    { exercise:"Kneeling Rope Crunch", sets:"4", reps:"15", rest:"45s", tempo:"3-1-2", coachCue:"Kneel and crunch with the abs, not the arms; round your spine and squeeze hard." },
    { exercise:"Hanging Leg Raise", sets:"3", reps:"12-15", rest:"60s", tempo:"3-1-2", coachCue:"Curl the pelvis up rather than just lifting the legs to fully engage the lower abs." },
    { exercise:"Cable Woodchopper", sets:"3", reps:"12 each", rest:"45s", tempo:"2-1-2", coachCue:"Rotate from the obliques with stiff arms and control the return slowly." },
    { exercise:"Plank", sets:"3", reps:"45s hold", rest:"45s", tempo:"hold", coachCue:"Squeeze glutes and brace the core hard; keep a straight line from head to heels." },
    { exercise:"Bicycle Crunch", sets:"3", reps:"20 each", rest:"45s", tempo:"2-1-2", coachCue:"Rotate elbow to opposite knee slowly and fully extend the other leg for the obliques." },
    { exercise:"Dead Bug", sets:"3", reps:"12 each", rest:"45s", tempo:"3-1-2", coachCue:"Press the lower back flat into the floor and move opposite arm and leg slowly." },
  ],
};

const STRETCHES = {
  upper: [
    { name:"Doorway Chest Stretch", duration:"45s each side", timing:"Post-workout", benefit:"Opens tight pecs and improves pressing posture", coachCue:"Place forearm on the frame and rotate your torso away until you feel the pec lengthen." },
    { name:"Cross-Body Shoulder Stretch", duration:"30s each side", timing:"Post-workout", benefit:"Releases the rear delt and shoulder capsule", coachCue:"Pull the arm across with the opposite hand and keep the shoulder down, not shrugged." },
    { name:"Lat Hang Stretch", duration:"30s", timing:"Post-workout", benefit:"Decompresses the spine and lengthens the lats", coachCue:"Hang from a bar fully relaxed and let your bodyweight open up the lats." },
    { name:"Overhead Triceps Stretch", duration:"30s each side", timing:"Post-workout", benefit:"Lengthens the triceps long head", coachCue:"Reach down your spine and gently press the elbow back with the other hand." },
    { name:"Child's Pose", duration:"60s", timing:"Post-workout", benefit:"Relaxes the back and shoulders", coachCue:"Sit hips back to heels and walk the hands forward to stretch the full back." },
  ],
  lower: [
    { name:"Hip Flexor Lunge Stretch", duration:"45s each side", timing:"Post-workout", benefit:"Releases hip flexors that limit glute activation", coachCue:"Tuck your tailbone under first, then push hips forward; most people skip the tilt." },
    { name:"Seated Hamstring Stretch", duration:"45s each side", timing:"Post-workout", benefit:"Lengthens hamstrings and protects the lower back", coachCue:"Hinge from the hips with a flat back and reach the chest toward the toes." },
    { name:"Figure-4 Glute Stretch", duration:"45s each side", timing:"Post-workout", benefit:"Opens the glutes and hips", coachCue:"Cross ankle over knee and pull the thigh in until you feel the deep glute open." },
    { name:"Standing Calf Stretch", duration:"30s each side", timing:"Post-workout", benefit:"Lengthens the calves and Achilles", coachCue:"Press the back heel into the floor with a straight leg, then bend slightly for the soleus." },
    { name:"Frog Stretch", duration:"60s", timing:"Post-workout", benefit:"Opens the inner thighs and hips", coachCue:"Widen the knees gently and rock back slowly; never force the range." },
  ],
};

function macrosFor(profile) {
  const w = parseFloat(profile.weight) || 170;
  const goal = profile.goal;
  let calPerLb, protPerLb;
  if (goal.includes("Bulk"))       { calPerLb = 17; protPerLb = 1.0; }
  else if (goal.includes("Cut"))   { calPerLb = 11; protPerLb = 1.2; }
  else if (goal.includes("Recomp")){ calPerLb = 13; protPerLb = 1.1; }
  else                              { calPerLb = 15; protPerLb = 1.0; } // performance
  const cals = Math.round(w * calPerLb / 10) * 10;
  const protein = Math.round(w * protPerLb);
  const fats = Math.round(w * 0.4);
  const carbs = Math.round((cals - protein*4 - fats*9) / 4);
  return {
    dailyCalories: String(cals),
    protein: protein + "g",
    carbs: Math.max(carbs,0) + "g",
    fats: fats + "g",
    mealPlan: [
      { meal:"Breakfast", time:"7:00 AM", foods:"4-5 whole eggs, oats with berries, black coffee", calories: String(Math.round(cals*0.25)) },
      { meal:"Lunch", time:"12:30 PM", foods:"Lean beef or chicken, rice, mixed vegetables", calories: String(Math.round(cals*0.30)) },
      { meal:"Pre/Post Workout", time:"4:00 PM", foods:"Whey protein shake, banana, handful of almonds", calories: String(Math.round(cals*0.15)) },
      { meal:"Dinner", time:"7:30 PM", foods:"Salmon or steak, sweet potato, green salad with olive oil", calories: String(Math.round(cals*0.30)) },
    ],
    tips: [
      "Eat protein within 30-45 minutes after training to support muscle repair.",
      "Lean red meat is a top muscle-building protein source.",
      "Hydrate well and prioritize 7-9 hours of sleep for recovery.",
    ],
  };
}

function pickFocusGroups(profile) {
  const f = profile.focus;
  if (f.includes("Upper")) return { groups:["chest","back","shoulders","arms"], stretch:"upper" };
  if (f.includes("Lower")) return { groups:["glutes","legs","calves"], stretch:"lower" };
  if (f.includes("Core"))  return { groups:["core","glutes","shoulders"], stretch:"lower" };
  return { groups:["chest","back","legs","glutes","shoulders","arms"], stretch:"upper" }; // full body
}

function dayPlan(label, type, focusText, primaryGroups, accessoryGroups) {
  // Build 5-6 exercises: load primary groups heavily, top up from accessories.
  const seen = new Set();
  const workout = [];
  const TARGET = 6;

  function addFrom(group, max) {
    if (!EX[group]) return;
    for (const ex of EX[group]) {
      if (workout.length >= TARGET) break;
      if (max <= 0) break;
      if (seen.has(ex.exercise)) continue;
      seen.add(ex.exercise);
      workout.push(ex);
      max--;
    }
  }

  // Spread evenly across the primary groups first
  const primaries = primaryGroups || [];
  const perPrimary = primaries.length ? Math.max(2, Math.ceil(TARGET / primaries.length)) : 0;
  primaries.forEach(g => addFrom(g, perPrimary));

  // Top up with accessory groups until we hit the target
  (accessoryGroups || []).forEach(g => addFrom(g, TARGET));

  // If still short, pull more from the first primary group
  if (workout.length < 5 && primaries[0]) addFrom(primaries[0], TARGET);

  return { day:label, type, focus:focusText, workout: workout.slice(0, TARGET) };
}

// Build a 7-day week tailored to the focus.
function buildWeek(profile) {
  const f = profile.focus;

  // 5-day split: Monday through Friday. Weekends off.
  if (f.includes("Lower")) {
    return [
      dayPlan("Monday","Glutes & Hamstrings","Glutes, Hamstrings",["glutes"],["legs"]),
      dayPlan("Tuesday","Quads & Calves","Quads, Calves",["legs"],["calves","glutes"]),
      dayPlan("Wednesday","Glutes & Shape","Glutes, Hips",["glutes"],["calves"]),
      dayPlan("Thursday","Hamstrings & Calves","Hamstrings, Calves",["legs"],["calves","glutes"]),
      dayPlan("Friday","Lower Burnout & Core","Glutes, Core",["glutes"],["core"]),
    ];
  }
  if (f.includes("Upper")) {
    return [
      dayPlan("Monday","Chest & Triceps","Chest, Triceps",["chest"],["arms"]),
      dayPlan("Tuesday","Back & Biceps","Back, Biceps",["back"],["arms"]),
      dayPlan("Wednesday","Shoulders & Arms","Delts, Arms",["shoulders"],["arms"]),
      dayPlan("Thursday","Chest & Back","Upper Body Pump",["chest","back"],[]),
      dayPlan("Friday","Arms & Core","Arms, Core",["arms"],["core"]),
    ];
  }
  if (f.includes("Core")) {
    return [
      dayPlan("Monday","Core & Glutes","Abs, Glutes",["core"],["glutes"]),
      dayPlan("Tuesday","Shoulders & Core","Delts, Obliques",["shoulders"],["core"]),
      dayPlan("Wednesday","Core & Lower","Abs, Glutes",["core"],["glutes"]),
      dayPlan("Thursday","Full Core","Complete Midsection",["core"],["glutes"]),
      dayPlan("Friday","Glutes & Calves","Lower Accessory",["glutes"],["calves","core"]),
    ];
  }
  // Full body
  return [
    dayPlan("Monday","Full Body A","Push Emphasis",["chest","shoulders"],["legs"]),
    dayPlan("Tuesday","Full Body B","Pull Emphasis",["back","arms"],["glutes"]),
    dayPlan("Wednesday","Full Body C","Legs & Core",["legs","glutes"],["core"]),
    dayPlan("Thursday","Full Body D","Upper Pump",["chest","back"],["shoulders"]),
    dayPlan("Friday","Full Body E","Total Body Finisher",["shoulders","arms"],["core","calves"]),
  ];
}

function buildProgram(profile) {
  const { stretch } = pickFocusGroups(profile);
  const goalWord = profile.goal.split("(")[0].trim();
  const focusWord = profile.focus.split("(")[0].trim();

  return {
    overview: "A 4-week precision starter block built for your " + goalWord.toLowerCase() +
      " goal with a " + focusWord.toLowerCase() + " emphasis. Every movement uses precise angles, controlled tempo, and a strong mind-muscle squeeze over heavy momentum.",
    weeklySchedule: buildWeek(profile),
    stretching: STRETCHES[stretch],
    nutrition: macrosFor(profile),
    progressMilestones: [
      { week:1, goal:"Master form and angle setup on every exercise. Keep weight moderate and own the 3-1-2 tempo." },
      { week:2, goal:"Add a small amount of weight while holding strict tempo. Dial in your mind-muscle connection." },
      { week:3, goal:"Push the final set of each exercise close to failure. Add a drop set on one movement per session." },
      { week:4, goal:"Peak intensity week. Beat week 1 numbers with the same clean form, then reassess and rebuild." },
    ],
  };
}


// ── SHARED UI ────────────────────────────────────────────────────────────────
const WATERMARK_SRC = "data:image/png;base64,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";

// Faint full-screen background watermark, sits behind all content.
const Watermark = () => (
  <>
    {/* Solid dark base so the page is never white, even if body bg is overridden */}
    <div aria-hidden="true" style={{ position:"fixed", inset:0, zIndex:-2, background:"#0a0a0f", pointerEvents:"none" }} />
    {/* Faint silhouette over the dark base, behind all content */}
    <div aria-hidden="true" style={{
      position:"fixed", inset:0, zIndex:-1, pointerEvents:"none",
      backgroundImage:"url(" + WATERMARK_SRC + ")",
      backgroundRepeat:"no-repeat", backgroundPosition:"center 42%",
      backgroundSize:"auto 78%", opacity:0.07,
    }} />
  </>
);

const Logo = ({ small }) => (
  <div style={{ lineHeight:1, textAlign:"center" }}>
    <div style={{ fontFamily:"'DM Sans', sans-serif", fontWeight:600, fontSize: small?14:18, letterSpacing: small?3:4, color:"#7070a0", marginBottom: small?6:16, textTransform:"none" }}>
      NTF
    </div>
    <div style={{ fontFamily:"'Bebas Neue'", fontSize: small?28:42, letterSpacing: small?4:6, lineHeight:1 }}>
      BODY<span style={{ color:"#e8ff00" }}>MORPH</span>
    </div>
  </div>
);

const CoachCue = ({ text }) => (
  <div style={{ marginTop:8, fontSize:13.5, lineHeight:1.7, color:"#d2d2ec", background:"rgba(232,255,0,0.05)", borderLeft:"3px solid #e8ff00", borderRadius:"0 6px 6px 0", padding:"8px 10px" }}>
    <span style={{ display:"inline-block", background:"#e8ff00", color:"#000", fontSize:9, fontWeight:700, letterSpacing:1, padding:"2px 5px", borderRadius:3, marginRight:6, verticalAlign:"middle" }}>COACH CUE</span>
    {text}
  </div>
);

const YTButton = ({ query }) => {
  const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(query + " form tutorial");
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ display:"inline-flex", alignItems:"center", gap:5, marginTop:8, color:"#ff5555", fontSize:12, fontWeight:600, textDecoration:"none", background:"rgba(255,68,68,0.1)", border:"1px solid rgba(255,68,68,0.25)", borderRadius:6, padding:"4px 10px" }}>
      &#9654; Watch Demo
    </a>
  );
};

// ── WIZARD ────────────────────────────────────────────────────────────────────
const STEPS = ["name","gender","goal","focus","stats"];

function Wizard({ onComplete }) {
  const [step, setStep] = useState(0);
  const [p, setP] = useState({ name:"", gender:"", goal:"", focus:"", age:"", weight:"", height:"", fitnessLevel:"" });
  const set = (k, v) => setP(prev => ({ ...prev, [k]:v }));

  const canNext = [
    () => p.name.trim().length > 0,
    () => !!p.gender,
    () => !!p.goal,
    () => !!p.focus,
    () => p.age && p.weight && p.height && p.fitnessLevel,
  ];

  const maleFocuses   = ["Upper Body (Chest, Back, Arms, Shoulders)","Lower Body (Legs, Glutes, Calves)","Full Body","Core & Abs"];
  const femaleFocuses = ["Lower Body (Hips, Glutes, Legs, Calves)","Upper Body (Arms, Back, Shoulders)","Full Body","Core & Abs"];
  const focuses = p.gender === "Female" ? femaleFocuses : maleFocuses;

  const Pill = ({ label, active, onClick }) => (
    <button onClick={onClick} style={{ background: active ? "#e8ff00" : "#1a1a26", border:"1px solid " + (active ? "#e8ff00" : "#2a2a3d"), color: active ? "#000" : "#f0f0f8", fontWeight: active ? 600 : 400, borderRadius:10, padding:"13px 18px", cursor:"pointer", fontSize:14, fontFamily:"'DM Sans'", textAlign:"left", transition:"all 0.18s", width:"100%" }}>{label}</button>
  );

  const steps = [
    <div key="name" style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, width:"100%" }}>
      <div style={S.stepLabel}>WHAT'S YOUR NAME?</div>
      <input autoFocus style={{ ...S.input, maxWidth:320, textAlign:"center", fontSize:18 }} placeholder="Enter your name" value={p.name} onChange={e=>set("name",e.target.value)} onKeyDown={e=>{ if(e.key==="Enter" && p.name.trim()) setStep(1); }} />
      <div style={{ color:"#7070a0", fontSize:12, textAlign:"center", maxWidth:300 }}>The app will remember you, so anyone can use their own profile.</div>
    </div>,

    <div key="g" style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, width:"100%" }}>
      <div style={S.stepLabel}>WHO ARE WE TRAINING?</div>
      <div style={{ display:"flex", gap:16 }}>
        {["Male","Female"].map(g => (
          <button key={g} onClick={() => set("gender",g)} style={{ background: p.gender===g ? "#e8ff00" : "#1a1a26", border:"1px solid " + (p.gender===g ? "#e8ff00" : "#2a2a3d"), color: p.gender===g ? "#000" : "#f0f0f8", fontWeight: p.gender===g ? 600 : 400, borderRadius:12, padding:"20px 28px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:8, fontSize:15, fontFamily:"'DM Sans'", transition:"all 0.18s", minWidth:120 }}>
            <span style={{ fontSize:36 }}>{g==="Male" ? "\u2642" : "\u2640"}</span>
            <span>{g}</span>
          </button>
        ))}
      </div>
    </div>,

    <div key="goal" style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, width:"100%" }}>
      <div style={S.stepLabel}>YOUR PRIMARY GOAL</div>
      <div style={{ display:"flex", flexDirection:"column", gap:10, width:"100%", maxWidth:380 }}>
        {["Bulk (Build Muscle Mass)","Cut (Lose Fat, Preserve Muscle)","Recomp (Build Muscle & Lose Fat)","Athletic Performance"].map(g => (
          <Pill key={g} label={g} active={p.goal===g} onClick={() => set("goal",g)} />
        ))}
      </div>
    </div>,

    <div key="focus" style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, width:"100%" }}>
      <div style={S.stepLabel}>TRAINING FOCUS</div>
      <div style={{ display:"flex", flexDirection:"column", gap:10, width:"100%", maxWidth:380 }}>
        {focuses.map(fo => (<Pill key={fo} label={fo} active={p.focus===fo} onClick={() => set("focus",fo)} />))}
      </div>
    </div>,

    <div key="stats" style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16, width:"100%" }}>
      <div style={S.stepLabel}>YOUR STATS</div>
      <div style={{ display:"flex", flexDirection:"column", gap:14, width:"100%", maxWidth:340 }}>
        {[["age","Age","e.g. 28"],["weight","Weight (lbs)","e.g. 175"],["height","Height (inches)","e.g. 70"]].map(([k,label,ph]) => (
          <div key={k}>
            <div style={S.inputLabel}>{label}</div>
            <input style={S.input} placeholder={ph} value={p[k]} onChange={e => set(k,e.target.value)} type="number" />
          </div>
        ))}
        <div>
          <div style={S.inputLabel}>Fitness Level</div>
          <div style={{ display:"flex", gap:8 }}>
            {["Beginner","Intermediate","Advanced"].map(l => (
              <button key={l} onClick={() => set("fitnessLevel",l)} style={{ flex:1, background: p.fitnessLevel===l ? "#e8ff00" : "#1a1a26", border:"1px solid " + (p.fitnessLevel===l ? "#e8ff00" : "#2a2a3d"), color: p.fitnessLevel===l ? "#000" : "#f0f0f8", fontWeight: p.fitnessLevel===l ? 600 : 400, borderRadius:8, padding:"9px 8px", cursor:"pointer", fontSize:12, fontFamily:"'DM Sans'", transition:"all 0.18s" }}>{l}</button>
            ))}
          </div>
        </div>
      </div>
    </div>,
  ];

  const ok = canNext[step] && canNext[step]();

  return (
    <div style={S.center}>
      <style>{GLOBAL_CSS}</style>
      <Watermark />
      <Logo />
      <div style={{ color:"#7070a0", fontSize:13, letterSpacing:3, textTransform:"uppercase" }}>Reshape Your Body</div>
      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
        {STEPS.map((_,i) => (<div key={i} style={{ height:8, borderRadius:4, transition:"all 0.3s", width: i===step ? 24 : 8, background: i<=step ? "#e8ff00" : "#2a2a3d" }} />))}
      </div>
      <div className="fade-in" key={step} style={{ width:"100%", maxWidth:480, display:"flex", justifyContent:"center" }}>{steps[step]}</div>
      <div style={{ display:"flex", gap:12 }}>
        {step > 0 && (<button onClick={() => setStep(s=>s-1)} style={S.btnSec}>Back</button>)}
        {step < STEPS.length-1 ? (
          <button onClick={() => ok && setStep(s=>s+1)} disabled={!ok} style={{ ...S.btnPri, opacity:ok?1:0.4, cursor:ok?"pointer":"not-allowed" }}>Continue</button>
        ) : (
          <button onClick={() => ok && onComplete(p)} disabled={!ok} style={{ ...S.btnPri, opacity:ok?1:0.4, cursor:ok?"pointer":"not-allowed", background:"#e8ff00", color:"#000" }}>BUILD MY PROGRAM</button>
        )}
      </div>
    </div>
  );
}

// ── LOADING ───────────────────────────────────────────────────────────────────
function Loading({ name }) {
  const msgs = ["Analyzing your profile...","Selecting your best exercises...","Setting your training angles...","Building your nutrition plan...","Finalizing your program..."];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI(x => (x+1) % msgs.length), 1700); return () => clearInterval(t); }, []);
  return (
    <div style={S.center}>
      <style>{GLOBAL_CSS}</style>
      <Watermark />
      <Logo />
      <div style={{ width:60, height:60, border:"3px solid #2a2a3d", borderTop:"3px solid #e8ff00", borderRadius:"50%", animation:"spin 1s linear infinite" }} />
      <div style={{ color:"#e8ff00", fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:2 }}>{msgs[i]}</div>
      <div style={{ color:"#7070a0", fontSize:13 }}>{name ? name + ", building your 5-day plan" : "Building your 5-day plan"}</div>
    </div>
  );
}

// ── HOME ──────────────────────────────────────────────────────────────────────
// Clean landing: greeting, program summary, then the Mon-Fri week to pick from.
function Home({ profile, program, rewards, onPickDay, onProgress, onNutrition, onReset }) {
  const goalColor = profile.goal.includes("Bulk") ? C.blue : profile.goal.includes("Cut") ? C.red : C.purple;
  const sched = program.weeklySchedule || [];
  const todayIdx = (() => { const d = new Date().getDay(); return (d>=1 && d<=5) ? d-1 : 0; })(); // Mon=0..Fri=4

  return (
    <div style={{ minHeight:"100vh", background:"transparent", paddingBottom:40, position:"relative" }}>
      <style>{GLOBAL_CSS}</style>
      <Watermark />

      {/* Top bar */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px 18px 10px" }}>
        <Logo small />
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, background:"#12121a", border:"1px solid #2a2a3d", borderRadius:20, padding:"5px 12px" }}>
            <span style={{ fontSize:14 }}>&#129689;</span>
            <span style={{ color:"#e8ff00", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:14 }}>{rewards.coins}</span>
          </div>
          <button onClick={onReset} style={{ background:"transparent", border:"1px solid #2a2a3d", borderRadius:8, color:"#7070a0", padding:"6px 11px", cursor:"pointer", fontSize:11, fontFamily:"'DM Sans'" }}>Switch User</button>
        </div>
      </div>

      {/* Greeting */}
      <div style={{ padding:"6px 18px 0" }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, letterSpacing:1 }}>Welcome back, <span style={{ color:"#e8ff00" }}>{profile.name}</span></div>
      </div>

      {/* Program summary */}
      <div style={{ margin:"14px 16px", background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:16, padding:18 }}>
        <div style={{ color:"#e8ff00", fontSize:10, letterSpacing:2, fontWeight:600, marginBottom:8 }}>YOUR PROGRAM</div>
        <div style={{ fontSize:14, lineHeight:1.7, marginBottom:14 }}>{program.overview}</div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          {[
            ["FOCUS", profile.focus.split("(")[0].trim()],
            ["GOAL", profile.goal.split("(")[0].trim()],
            ["SPLIT", "5 Days / Week"],
            ["LEVEL", profile.fitnessLevel],
          ].map(([k,v]) => (
            <div key={k} style={{ flex:1, minWidth:72, background:"#12121a", borderRadius:10, padding:"9px 8px", textAlign:"center" }}>
              <div style={{ color:"#7070a0", fontSize:9, letterSpacing:1 }}>{k}</div>
              <div style={{ color: k==="GOAL" ? goalColor : "#e8ff00", fontFamily:"'Oswald', sans-serif", fontWeight:600, fontSize:13, marginTop:3 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick actions */}
      <div style={{ display:"flex", gap:10, padding:"0 16px 4px" }}>
        <button onClick={onProgress} style={{ flex:1, background:"#12121a", border:"1px solid #2a2a3d", borderRadius:12, padding:"12px", color:"#f0f0f8", cursor:"pointer", fontFamily:"'Bebas Neue'", letterSpacing:1, fontSize:15 }}>&#128202; PROGRESS</button>
        <button onClick={onNutrition} style={{ flex:1, background:"#12121a", border:"1px solid #2a2a3d", borderRadius:12, padding:"12px", color:"#f0f0f8", cursor:"pointer", fontFamily:"'Bebas Neue'", letterSpacing:1, fontSize:15 }}>&#127869; NUTRITION</button>
      </div>

      {/* Week picker */}
      <div style={{ padding:"16px 16px 6px" }}>
        <div style={S.sectionTitle}>THIS WEEK &middot; MON&ndash;FRI</div>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:10, padding:"0 16px" }}>
        {sched.map((d,i) => {
          const isToday = i === todayIdx;
          const count = d.workout ? d.workout.length : 0;
          return (
            <button key={i} onClick={() => onPickDay(i)} style={{ textAlign:"left", background:"#1a1a26", border:"1px solid " + (isToday ? "#e8ff00" : "#2a2a3d"), borderRadius:14, padding:16, cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"center", gap:12 }}>
              <div style={{ minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:1 }}>{d.day}</span>
                  {isToday && <span style={{ background:"#e8ff00", color:"#000", fontSize:9, fontWeight:700, letterSpacing:1, padding:"2px 6px", borderRadius:4 }}>TODAY</span>}
                </div>
                <div style={{ color:"#e8ff00", fontSize:13, marginTop:3 }}>{d.type}</div>
                <div style={{ color:"#7070a0", fontSize:12, marginTop:2 }}>{count} exercises &middot; {d.focus}</div>
              </div>
              <span style={{ color:"#e8ff00", fontSize:22, flexShrink:0 }}>&#8250;</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── SESSION ───────────────────────────────────────────────────────────────────
// Shows the day's exercise summary + a date picker + START button.
// After START, reveals set-by-set logging for each exercise.
function Session({ profile, day, logs, onLogExercise, onCompleteWorkout, onBack }) {
  const [started, setStarted] = useState(false);
  const [dateStr, setDateStr] = useState(new Date().toISOString().slice(0,10));
  const workout = day.workout || [];

  if (!started) {
    // Pre-session summary
    return (
      <div style={{ minHeight:"100vh", background:"transparent", paddingBottom:40, position:"relative" }}>
        <style>{GLOBAL_CSS}</style>
      <Watermark />
        <div style={{ display:"flex", alignItems:"center", gap:12, padding:"16px 16px 8px" }}>
          <button onClick={onBack} style={{ background:"transparent", border:"1px solid #2a2a3d", borderRadius:8, color:"#7070a0", padding:"7px 12px", cursor:"pointer", fontSize:13 }}>&#8249; Back</button>
          <Logo small />
        </div>

        <div style={{ padding:"10px 18px 0" }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:30, letterSpacing:1 }}>{day.day}</div>
          <div style={{ color:"#e8ff00", fontSize:15, marginTop:2 }}>{day.type}</div>
          <div style={{ color:"#7070a0", fontSize:13, marginTop:2 }}>{day.focus}</div>
        </div>

        {/* Date picker */}
        <div style={{ padding:"16px 16px 6px" }}>
          <div style={S.inputLabel}>Workout Date</div>
          <input type="date" value={dateStr} onChange={e=>setDateStr(e.target.value)} style={{ ...S.input, fontFamily:"'Oswald', sans-serif", fontWeight:600 }} />
        </div>

        {/* Exercise summary list */}
        <div style={{ padding:"10px 16px 6px" }}>
          <div style={S.sectionTitle}>TODAY'S EXERCISES</div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:10, padding:"0 16px 18px" }}>
          {workout.map((ex,i) => (
            <div key={i} style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:"13px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:15 }}>{i+1}. {ex.exercise}</div>
                <div style={{ color:"#9090c0", fontSize:12, marginTop:2, fontFamily:"'Oswald', sans-serif" }}>Target {ex.sets} sets &times; {ex.reps} reps</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding:"0 16px" }}>
          <button onClick={() => setStarted(true)} style={{ width:"100%", background:"#e8ff00", color:"#000", border:"none", borderRadius:14, padding:"18px", cursor:"pointer", fontFamily:"'Bebas Neue'", letterSpacing:3, fontSize:26 }}>
            &#9654; START WORKOUT
          </button>
        </div>
      </div>
    );
  }

  // Active session: set-by-set logging
  return (
    <div style={{ minHeight:"100vh", background:"transparent", paddingBottom:40, position:"relative" }}>
      <style>{GLOBAL_CSS}</style>
      <Watermark />
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 16px 8px", borderBottom:"1px solid #2a2a3d", position:"sticky", top:0, background:"#0a0a0f", zIndex:10 }}>
        <div>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:22, letterSpacing:1 }}>{day.day}</div>
          <div style={{ color:"#e8ff00", fontSize:12 }}>{day.type}</div>
        </div>
        <button onClick={onBack} style={{ background:"transparent", border:"1px solid #2a2a3d", borderRadius:8, color:"#7070a0", padding:"7px 12px", cursor:"pointer", fontSize:12 }}>Exit</button>
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:14, padding:"16px" }}>
        {workout.map((ex,i) => (
          <ExerciseLogger key={i} index={i} ex={ex} history={logs[ex.exercise] || []} dateStr={dateStr} onSave={onLogExercise} />
        ))}

        <button onClick={() => { onCompleteWorkout(); onBack(); }} style={{ marginTop:4, background:"#3ddc84", color:"#000", border:"none", borderRadius:14, padding:"16px", cursor:"pointer", fontFamily:"'Bebas Neue'", letterSpacing:2, fontSize:22 }}>
          &#10003; FINISH &amp; SAVE WORKOUT
        </button>
      </div>
    </div>
  );
}

// One exercise with N set rows. Auto-fills from last session; user adjusts.
function ExerciseLogger({ index, ex, history, dateStr, onSave }) {
  const numSets = Math.max(1, parseInt(ex.sets) || 3);
  const last = history.length ? history[history.length-1] : null;
  const lastSets = last && last.sets ? last.sets : null;

  // initialize set rows: auto-fill from last session if present
  const init = Array.from({ length:numSets }, (_, i) => {
    if (lastSets && lastSets[i]) return { weight:String(lastSets[i].weight||""), reps:String(lastSets[i].reps||"") };
    if (last && last.weight) return { weight:String(last.weight), reps:String(last.reps||"") };
    return { weight:"", reps:"" };
  });

  const [rows, setRows] = useState(init);
  const [saved, setSaved] = useState(false);
  const pr = history.reduce((mx,h) => {
    const w = h.sets ? Math.max(...h.sets.map(s=>parseFloat(s.weight)||0)) : (parseFloat(h.weight)||0);
    return Math.max(mx, w);
  }, 0);

  const setRow = (i, field, val) => setRows(prev => prev.map((r,idx)=> idx===i ? { ...r, [field]:val } : r));

  const save = () => {
    const filled = rows.filter(r => r.weight || r.reps);
    if (!filled.length) return;
    const topWeight = Math.max(...filled.map(r=>parseFloat(r.weight)||0));
    onSave(ex.exercise, { date: dateStr, sets: rows.map(r=>({ weight:r.weight, reps:r.reps })), weight:String(topWeight), reps: rows[0].reps, prevBest: pr });
    setSaved(true);
    setTimeout(()=>setSaved(false), 1600);
  };

  const inputStyle = { width:"100%", background:"#0e0e16", border:"1px solid #2a2a3d", borderRadius:8, color:"#f0f0f8", padding:"10px 6px", fontSize:16, fontFamily:"'Oswald', sans-serif", fontWeight:600, textAlign:"center", outline:"none" };

  return (
    <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:14, padding:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10 }}>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:16 }}>{index+1}. {ex.exercise}</div>
          <div style={{ color:"#9090c0", fontSize:12, marginTop:2, fontFamily:"'Oswald', sans-serif" }}>Target {ex.sets} &times; {ex.reps} &middot; Tempo {ex.tempo} &middot; Rest {ex.rest}</div>
        </div>
        {pr > 0 && <div style={{ color:"#e8ff00", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:14, flexShrink:0 }}>PR {pr}</div>}
      </div>

      {ex.coachCue && <CoachCue text={ex.coachCue} />}
      <YTButton query={ex.exercise} />

      {/* Set rows */}
      <div style={{ marginTop:12 }}>
        <div style={{ display:"flex", gap:8, marginBottom:6, padding:"0 2px" }}>
          <div style={{ width:42, color:"#7070a0", fontSize:11, letterSpacing:1 }}>SET</div>
          <div style={{ flex:1, color:"#7070a0", fontSize:11, letterSpacing:1, textAlign:"center" }}>WEIGHT (LB)</div>
          <div style={{ flex:1, color:"#7070a0", fontSize:11, letterSpacing:1, textAlign:"center" }}>REPS</div>
        </div>
        {rows.map((r,i) => (
          <div key={i} style={{ display:"flex", gap:8, alignItems:"center", marginBottom:8 }}>
            <div style={{ width:42, textAlign:"center", fontFamily:"'Bebas Neue'", fontSize:20, color:"#e8ff00" }}>{i+1}</div>
            <input style={inputStyle} type="number" inputMode="decimal" placeholder="0" value={r.weight} onChange={e=>setRow(i,"weight",e.target.value)} />
            <input style={inputStyle} type="number" inputMode="numeric" placeholder={String(ex.reps).split("-")[0]} value={r.reps} onChange={e=>setRow(i,"reps",e.target.value)} />
          </div>
        ))}
      </div>

      <button onClick={save} style={{ width:"100%", marginTop:4, background: saved ? "#3ddc84" : "#2a2a3d", color: saved ? "#000" : "#e8ff00", border:"none", borderRadius:8, padding:"10px", cursor:"pointer", fontFamily:"'Bebas Neue'", letterSpacing:2, fontSize:16, transition:"all 0.18s" }}>
        {saved ? "SAVED \u2713" : "SAVE THIS EXERCISE"}
      </button>
    </div>
  );
}

// ── PROGRESS ──────────────────────────────────────────────────────────────────
function Progress({ logs, rewards, bodyEntries, onAddBody, onDeleteBody, onBack }) {
  const [view, setView] = useState("chart");          // chart | log | report | body
  const exNames = Object.keys(logs);
  const [selectedEx, setSelectedEx] = useState(exNames[0] || null);

  const wOf = (h) => h.sets ? Math.max(...h.sets.map(s=>parseFloat(s.weight)||0)) : (parseFloat(h.weight)||0);
  const repsOf = (h) => h.sets && h.sets[0] ? h.sets[0].reps : h.reps;
  const dateOf = (h) => (h.date ? h.date : (h.dateISO ? h.dateISO.slice(0,10) : ""));

  const hasData = exNames.length > 0;

  // Build a flat, date-sorted list of all sessions across all exercises (for the LOG view)
  const allSessions = [];
  exNames.forEach(name => (logs[name]||[]).forEach(h => allSessions.push({ name, ...h, _w: wOf(h), _d: dateOf(h) })));
  allSessions.sort((a,b) => (a._d < b._d ? 1 : -1)); // newest first

  // Group sessions by date for the dated log
  const byDate = {};
  allSessions.forEach(s => { (byDate[s._d] = byDate[s._d] || []).push(s); });
  const dateKeys = Object.keys(byDate).sort((a,b)=> a < b ? 1 : -1);

  // ── Chart helpers ──
  function chartFor(name) {
    const arr = (logs[name]||[]).slice();
    arr.sort((a,b)=> dateOf(a) < dateOf(b) ? -1 : 1); // oldest first for the line
    return arr.map((h,i) => ({ x:i+1, w: wOf(h), date: dateOf(h), reps: repsOf(h) }));
  }

  // ── Report helpers ──
  function reportFor(name) {
    const arr = (logs[name]||[]).slice().sort((a,b)=> dateOf(a) < dateOf(b) ? -1 : 1);
    if (!arr.length) return null;
    const first = wOf(arr[0]), last = wOf(arr[arr.length-1]);
    const pr = arr.reduce((m,h)=>Math.max(m,wOf(h)),0);
    const gain = last - first;
    const pct = first > 0 ? Math.round((gain/first)*100) : 0;
    const sessions = arr.length;
    let trend = "holding steady";
    if (gain > 0) trend = "trending up";
    else if (gain < 0) trend = "down from your start";
    return { name, first, last, pr, gain, pct, sessions, trend, firstDate:dateOf(arr[0]), lastDate:dateOf(arr[arr.length-1]) };
  }

  const fmtDate = (d) => {
    if (!d) return "";
    const dt = new Date(d + "T00:00:00");
    return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { month:"short", day:"numeric" });
  };

  return (
    <div style={{ minHeight:"100vh", background:"transparent", paddingBottom:40, position:"relative" }}>
      <style>{GLOBAL_CSS}</style>
      <Watermark />
      <div style={{ display:"flex", alignItems:"center", gap:12, padding:"16px 16px 8px" }}>
        <button onClick={onBack} style={{ background:"transparent", border:"1px solid #2a2a3d", borderRadius:8, color:"#7070a0", padding:"7px 12px", cursor:"pointer", fontSize:13 }}>&#8249; Home</button>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:22, letterSpacing:1 }}>PROGRESS</div>
      </div>

      <div style={{ padding:"8px 16px 24px" }}>
        {/* Rewards summary */}
        <div style={{ display:"flex", gap:10, marginBottom:18 }}>
          {[["COINS", rewards.coins, "\uD83E\uDE99"],["MEDALS", rewards.medals.length, "\uD83C\uDFC5"],["STREAK", (rewards.stats.currentStreak||0)+"d", "\uD83D\uDD25"]].map(([k,v,e]) => (
            <div key={k} style={{ flex:1, background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:"14px 8px", textAlign:"center" }}>
              <div style={{ fontSize:22 }}>{e}</div>
              <div style={{ color:"#e8ff00", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:22, marginTop:2 }}>{v}</div>
              <div style={{ color:"#7070a0", fontSize:10, letterSpacing:1, marginTop:2 }}>{k}</div>
            </div>
          ))}
        </div>

        {/* View switcher (always shown) */}
        <div style={{ display:"flex", gap:6, marginBottom:16, background:"#12121a", border:"1px solid #2a2a3d", borderRadius:10, padding:4, flexWrap:"wrap" }}>
          {[["chart","CHART"],["log","LOG"],["report","REPORT"],["body","BODY"]].map(([id,label]) => (
            <button key={id} onClick={()=>setView(id)} style={{
              flex:1, minWidth:60, background: view===id ? "#e8ff00" : "transparent", color: view===id ? "#000" : "#9090c0",
              border:"none", borderRadius:7, padding:"9px 6px", cursor:"pointer",
              fontFamily:"'Bebas Neue'", letterSpacing:1.5, fontSize:14, transition:"all 0.18s",
            }}>{label}</button>
          ))}
        </div>

        {/* BODY view is always available */}
        {view === "body" && (
          <BodyProgress entries={bodyEntries} onAdd={onAddBody} onDelete={onDeleteBody} />
        )}

        {view !== "body" && !hasData ? (
          <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:28, textAlign:"center", color:"#7070a0", fontSize:13 }}>
            No lifts logged yet. Pick a day, tap Start Workout, and log your sets. Your progress over the 4-week block will show up here.
          </div>
        ) : view !== "body" ? (
          <>

            {/* CHART VIEW */}
            {view === "chart" && (
              <div>
                {/* Exercise selector */}
                <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:8, marginBottom:12 }}>
                  {exNames.map(name => (
                    <button key={name} onClick={()=>setSelectedEx(name)} style={{
                      flexShrink:0, background: selectedEx===name ? "#e8ff00" : "#1a1a26",
                      border:"1px solid " + (selectedEx===name ? "#e8ff00" : "#2a2a3d"),
                      color: selectedEx===name ? "#000" : "#f0f0f8", borderRadius:20,
                      padding:"7px 14px", cursor:"pointer", fontSize:12, fontWeight:600, whiteSpace:"nowrap",
                    }}>{name}</button>
                  ))}
                </div>
                {selectedEx && <MiniChart data={chartFor(selectedEx)} fmtDate={fmtDate} />}
              </div>
            )}

            {/* SESSION LOG VIEW */}
            {view === "log" && (
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                {dateKeys.map(d => (
                  <div key={d}>
                    <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color:"#e8ff00", marginBottom:6 }}>
                      {fmtDate(d)}
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                      {byDate[d].map((s,i) => (
                        <div key={i} style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:10, padding:"12px 14px" }}>
                          <div style={{ fontWeight:700, fontSize:14, marginBottom:6 }}>{s.name}</div>
                          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                            {(s.sets || [{ weight:s.weight, reps:s.reps }]).map((set,si) => (
                              <span key={si} style={{ background:"#0e0e16", border:"1px solid #2a2a3d", borderRadius:6, padding:"4px 9px", fontFamily:"'Oswald', sans-serif", fontWeight:600, fontSize:13, color:"#f0f0f8" }}>
                                <span style={{ color:"#7070a0", marginRight:4 }}>{si+1}.</span>{set.weight||0}&times;{set.reps||0}
                              </span>
                            ))}
                            {s.pr && <span style={{ background:"rgba(232,255,0,0.15)", border:"1px solid #e8ff00", borderRadius:6, padding:"4px 9px", fontSize:12, color:"#e8ff00", fontWeight:600 }}>PR!</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* REPORT VIEW */}
            {view === "report" && (
              <div>
                <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:16, marginBottom:14 }}>
                  <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:1, color:"#e8ff00", marginBottom:8 }}>4-WEEK PROGRESS REPORT</div>
                  <div style={{ fontSize:13.5, lineHeight:1.7, color:"#d2d2ec" }}>
                    You've logged <b style={{ color:"#fff" }}>{allSessions.length}</b> total set entries across <b style={{ color:"#fff" }}>{exNames.length}</b> exercises on <b style={{ color:"#fff" }}>{dateKeys.length}</b> training days. Below is how each lift has moved over your block.
                  </div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                  {exNames.map(name => {
                    const r = reportFor(name);
                    if (!r) return null;
                    const up = r.gain > 0, flat = r.gain === 0;
                    const color = up ? "#3ddc84" : flat ? "#9090c0" : "#ff7070";
                    return (
                      <div key={name} style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:14 }}>
                        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                          <div style={{ fontWeight:700, fontSize:15 }}>{name}</div>
                          <div style={{ color, fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:15 }}>
                            {up?"\u2191":flat?"\u2192":"\u2193"} {r.gain>0?"+":""}{r.gain} lb {r.pct!==0 ? "("+(r.pct>0?"+":"")+r.pct+"%)" : ""}
                          </div>
                        </div>
                        <div style={{ fontSize:13, color:"#d2d2ec", lineHeight:1.6 }}>
                          Started at <b style={{ color:"#fff" }}>{r.first} lb</b>, now at <b style={{ color:"#fff" }}>{r.last} lb</b> &mdash; <span style={{ color }}>{r.trend}</span> over {r.sessions} session{r.sessions>1?"s":""}. Best lift: <b style={{ color:"#e8ff00" }}>{r.pr} lb</b>.
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : null}

        {/* Medals always available below */}
        <div style={{ ...S.sectionTitle, marginTop:24 }}>MEDAL COLLECTION</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:10 }}>
          {MEDAL_DEFS.map(def => {
            const earned = rewards.earnedIds.includes(def.id);
            return (
              <div key={def.id} style={{ background:"#1a1a26", border:"1px solid " + (earned ? "#e8ff00" : "#2a2a3d"), borderRadius:12, padding:"12px 6px", textAlign:"center", opacity: earned ? 1 : 0.4 }}>
                <div style={{ fontSize:26, filter: earned ? "none" : "grayscale(1)" }}>{def.emoji}</div>
                <div style={{ fontSize:11, fontWeight:600, marginTop:5, lineHeight:1.3 }}>{def.label}</div>
                <div style={{ color: earned ? "#e8ff00" : "#7070a0", fontSize:10, marginTop:3, fontFamily:"'Oswald', sans-serif" }}>+{def.coins}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


// ── BODY PROGRESS (photos + weight + body fat) ──────────────────────────────────
const ANGLES = [
  { id:"front", label:"Front" },
  { id:"back",  label:"Back" },
  { id:"left",  label:"Left" },
  { id:"right", label:"Right" },
];

// Compress an uploaded image file to a small base64 JPEG for storage.
function compressImage(file, maxDim = 700, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function BodyProgress({ entries, onAdd, onDelete }) {
  const [photos, setPhotos]   = useState({});      // { front: dataURL, ... }
  const [weight, setWeight]   = useState("");
  const [bodyFat, setBodyFat] = useState("");
  const [dateStr, setDateStr] = useState(new Date().toISOString().slice(0,10));
  const [busy, setBusy]       = useState(false);
  const [viewer, setViewer]   = useState(null);    // { src } for fullscreen view

  const handlePhoto = async (angleId, file) => {
    if (!file) return;
    try {
      const dataURL = await compressImage(file);
      setPhotos(prev => ({ ...prev, [angleId]: dataURL }));
    } catch (e) { /* ignore */ }
  };

  const canSave = weight || bodyFat || Object.keys(photos).length > 0;

  const save = () => {
    if (!canSave) return;
    setBusy(true);
    onAdd({ date: dateStr, weight: String(weight), bodyFat: String(bodyFat), photos: { ...photos } });
    setPhotos({}); setWeight(""); setBodyFat("");
    setTimeout(()=>setBusy(false), 600);
  };

  // Trend helpers across saved entries (entries are newest-first)
  const chrono = [...entries].slice().reverse();
  const wSeries = chrono.filter(e=>e.weight).map(e=>({ date:e.date, v:parseFloat(e.weight) }));
  const bfSeries = chrono.filter(e=>e.bodyFat).map(e=>({ date:e.date, v:parseFloat(e.bodyFat) }));
  const firstW = wSeries[0]?.v, lastW = wSeries[wSeries.length-1]?.v;
  const firstBF = bfSeries[0]?.v, lastBF = bfSeries[bfSeries.length-1]?.v;

  const fmtDate = (d) => { const dt = new Date(d + "T00:00:00"); return isNaN(dt) ? d : dt.toLocaleDateString(undefined,{ month:"short", day:"numeric", year:"numeric" }); };

  const input = { width:"100%", background:"#0e0e16", border:"1px solid #2a2a3d", borderRadius:8, color:"#f0f0f8", padding:"11px 12px", fontSize:16, fontFamily:"'Oswald', sans-serif", fontWeight:600, outline:"none" };

  return (
    <div>
      {/* Fullscreen photo viewer */}
      {viewer && (
        <div onClick={()=>setViewer(null)} style={{ position:"fixed", inset:0, zIndex:300, background:"rgba(0,0,0,0.92)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <img src={viewer.src} alt="progress" style={{ maxWidth:"100%", maxHeight:"100%", borderRadius:10 }} />
        </div>
      )}

      {/* New entry card */}
      <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:14, padding:16, marginBottom:18 }}>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:1, color:"#e8ff00", marginBottom:12 }}>LOG TODAY</div>

        {/* Date */}
        <div style={{ marginBottom:12 }}>
          <div style={S.inputLabel}>Date</div>
          <input type="date" value={dateStr} onChange={e=>setDateStr(e.target.value)} style={input} />
        </div>

        {/* Weight + Body fat */}
        <div style={{ display:"flex", gap:10, marginBottom:14 }}>
          <div style={{ flex:1 }}>
            <div style={S.inputLabel}>Weight (lb)</div>
            <input type="number" inputMode="decimal" placeholder="e.g. 175" value={weight} onChange={e=>setWeight(e.target.value)} style={input} />
          </div>
          <div style={{ flex:1 }}>
            <div style={S.inputLabel}>Body Fat (%)</div>
            <input type="number" inputMode="decimal" placeholder="e.g. 18" value={bodyFat} onChange={e=>setBodyFat(e.target.value)} style={input} />
          </div>
        </div>

        {/* Photo angles */}
        <div style={S.inputLabel}>Progress Photos</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:8, marginTop:6 }}>
          {ANGLES.map(a => (
            <label key={a.id} style={{ position:"relative", aspectRatio:"3/4", background:"#0e0e16", border:"1px dashed #3a3a52", borderRadius:10, overflow:"hidden", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
              {photos[a.id] ? (
                <img src={photos[a.id]} alt={a.label} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
              ) : (
                <>
                  <span style={{ fontSize:20, opacity:0.6 }}>&#128247;</span>
                  <span style={{ fontSize:10, color:"#7070a0", marginTop:4 }}>{a.label}</span>
                </>
              )}
              <input type="file" accept="image/*" capture="environment" onChange={e=>handlePhoto(a.id, e.target.files[0])} style={{ position:"absolute", inset:0, opacity:0, cursor:"pointer" }} />
              {photos[a.id] && (
                <span style={{ position:"absolute", bottom:0, left:0, right:0, background:"rgba(0,0,0,0.6)", color:"#e8ff00", fontSize:9, textAlign:"center", padding:"2px 0", letterSpacing:1 }}>{a.label.toUpperCase()}</span>
              )}
            </label>
          ))}
        </div>
        <div style={{ color:"#7070a0", fontSize:11, marginTop:6 }}>Tap a box to take or choose a photo for that angle.</div>

        <button onClick={save} disabled={!canSave || busy} style={{ width:"100%", marginTop:14, background: canSave ? "#e8ff00" : "#2a2a3d", color: canSave ? "#000" : "#7070a0", border:"none", borderRadius:10, padding:"14px", cursor: canSave ? "pointer" : "not-allowed", fontFamily:"'Bebas Neue'", letterSpacing:2, fontSize:18 }}>
          {busy ? "SAVED \u2713" : "SAVE ENTRY"}
        </button>
      </div>

      {/* Trend summary */}
      {(wSeries.length >= 2 || bfSeries.length >= 2) && (
        <div style={{ display:"flex", gap:10, marginBottom:16 }}>
          {wSeries.length >= 2 && (
            <div style={{ flex:1, background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:14, textAlign:"center" }}>
              <div style={{ color:"#7070a0", fontSize:10, letterSpacing:1 }}>WEIGHT CHANGE</div>
              <div style={{ color: (lastW-firstW)<=0 ? "#3ddc84" : "#3d8eff", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:22, marginTop:3 }}>
                {(lastW-firstW)>0?"+":""}{(lastW-firstW).toFixed(1)} lb
              </div>
              <div style={{ color:"#9090c0", fontSize:11, marginTop:2 }}>{firstW} &rarr; {lastW} lb</div>
            </div>
          )}
          {bfSeries.length >= 2 && (
            <div style={{ flex:1, background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:14, textAlign:"center" }}>
              <div style={{ color:"#7070a0", fontSize:10, letterSpacing:1 }}>BODY FAT CHANGE</div>
              <div style={{ color: (lastBF-firstBF)<=0 ? "#3ddc84" : "#ff7070", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:22, marginTop:3 }}>
                {(lastBF-firstBF)>0?"+":""}{(lastBF-firstBF).toFixed(1)}%
              </div>
              <div style={{ color:"#9090c0", fontSize:11, marginTop:2 }}>{firstBF} &rarr; {lastBF}%</div>
            </div>
          )}
        </div>
      )}

      {/* History timeline */}
      <div style={S.sectionTitle}>PROGRESS HISTORY</div>
      {entries.length === 0 ? (
        <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:24, textAlign:"center", color:"#7070a0", fontSize:13 }}>
          No entries yet. Snap your photos and log your weight above to start your visual transformation record.
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {entries.map((e, idx) => (
            <div key={idx} style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, letterSpacing:1, color:"#e8ff00" }}>{fmtDate(e.date)}</div>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  {e.weight && <span style={{ fontFamily:"'Oswald', sans-serif", fontWeight:600, fontSize:14 }}>{e.weight} lb</span>}
                  {e.bodyFat && <span style={{ fontFamily:"'Oswald', sans-serif", fontWeight:600, fontSize:14, color:"#9b5de5" }}>{e.bodyFat}% BF</span>}
                  <button onClick={()=>onDelete(idx)} style={{ background:"transparent", border:"none", color:"#7070a0", cursor:"pointer", fontSize:16 }}>&times;</button>
                </div>
              </div>
              {e.photos && Object.keys(e.photos).length > 0 && (
                <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:6 }}>
                  {ANGLES.map(a => e.photos[a.id] ? (
                    <div key={a.id} onClick={()=>setViewer({ src:e.photos[a.id] })} style={{ position:"relative", aspectRatio:"3/4", borderRadius:8, overflow:"hidden", cursor:"pointer" }}>
                      <img src={e.photos[a.id]} alt={a.label} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                      <span style={{ position:"absolute", bottom:0, left:0, right:0, background:"rgba(0,0,0,0.6)", color:"#fff", fontSize:8, textAlign:"center", padding:"2px 0", letterSpacing:1 }}>{a.label.toUpperCase()}</span>
                    </div>
                  ) : (
                    <div key={a.id} style={{ aspectRatio:"3/4", borderRadius:8, background:"#0e0e16", border:"1px solid #2a2a3d", display:"flex", alignItems:"center", justifyContent:"center", color:"#3a3a52", fontSize:10 }}>{a.label}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Lightweight SVG line chart (no external libs).
function MiniChart({ data, fmtDate }) {
  if (!data || data.length === 0) return null;
  if (data.length === 1) {
    const d = data[0];
    return (
      <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:20, textAlign:"center" }}>
        <div style={{ color:"#7070a0", fontSize:13, marginBottom:8 }}>One session logged so far &mdash; log again to see your trend line.</div>
        <div style={{ color:"#e8ff00", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:28 }}>{d.w} lb</div>
        <div style={{ color:"#9090c0", fontSize:12 }}>{fmtDate(d.date)} &middot; {d.reps} reps</div>
      </div>
    );
  }

  const W = 320, H = 180, padL = 36, padR = 14, padT = 16, padB = 28;
  const ws = data.map(d=>d.w);
  const minW = Math.min(...ws), maxW = Math.max(...ws);
  const range = maxW - minW || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xFor = (i) => padL + (data.length===1?0:(i/(data.length-1))*plotW);
  const yFor = (w) => padT + plotH - ((w - minW)/range)*plotH;

  const pts = data.map((d,i)=> xFor(i)+","+yFor(d.w)).join(" ");
  const last = data[data.length-1], first = data[0];
  const gain = last.w - first.w;

  return (
    <div style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:12, padding:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
        <div style={{ color:"#9090c0", fontSize:12, fontFamily:"'Oswald', sans-serif" }}>Weight over time (lb)</div>
        <div style={{ color: gain>=0 ? "#3ddc84" : "#ff7070", fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:14 }}>
          {gain>=0?"\u2191 +":"\u2193 "}{Math.abs(gain)} lb
        </div>
      </div>
      <svg viewBox={"0 0 "+W+" "+H} style={{ width:"100%", height:"auto", display:"block" }}>
        {/* gridlines */}
        {[0,0.5,1].map((t,i)=>{
          const y = padT + plotH - t*plotH;
          const val = Math.round(minW + t*range);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W-padR} y2={y} stroke="#2a2a3d" strokeWidth="1" />
              <text x={padL-6} y={y+4} textAnchor="end" fontSize="10" fill="#7070a0" fontFamily="Oswald">{val}</text>
            </g>
          );
        })}
        {/* area + line */}
        <polyline points={pts} fill="none" stroke="#e8ff00" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d,i)=>(
          <g key={i}>
            <circle cx={xFor(i)} cy={yFor(d.w)} r="4" fill="#e8ff00" />
            <text x={xFor(i)} y={H-10} textAnchor="middle" fontSize="9" fill="#7070a0" fontFamily="Oswald">{fmtDate(d.date)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ── NUTRITION ─────────────────────────────────────────────────────────────────
function Nutrition({ program, onBack }) {
  const n = program.nutrition || {};
  return (
    <div style={{ minHeight:"100vh", background:"transparent", paddingBottom:40, position:"relative" }}>
      <style>{GLOBAL_CSS}</style>
      <Watermark />
      <div style={{ display:"flex", alignItems:"center", gap:12, padding:"16px 16px 8px" }}>
        <button onClick={onBack} style={{ background:"transparent", border:"1px solid #2a2a3d", borderRadius:8, color:"#7070a0", padding:"7px 12px", cursor:"pointer", fontSize:13 }}>&#8249; Home</button>
        <div style={{ fontFamily:"'Bebas Neue'", fontSize:22, letterSpacing:1 }}>NUTRITION</div>
      </div>

      <div style={{ padding:"8px 16px 24px" }}>
        <div style={S.sectionTitle}>DAILY MACROS</div>
        <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
          {[["CALORIES",n.dailyCalories,"#e8ff00"],["PROTEIN",n.protein,"#3d8eff"],["CARBS",n.carbs,"#9b5de5"],["FATS",n.fats,"#ff3d3d"]].map(([k,v,color]) => (
            <div key={k} style={{ flex:1, minWidth:70, background:"#1a1a26", border:"1px solid " + color, borderRadius:10, padding:"12px 10px", textAlign:"center" }}>
              <div style={{ color, fontFamily:"'Oswald', sans-serif", fontWeight:700, fontSize:24, letterSpacing:0.5 }}>{v}</div>
              <div style={{ color:"#7070a0", fontSize:10, letterSpacing:1 }}>{k}</div>
            </div>
          ))}
        </div>

        <div style={S.sectionTitle}>MEAL PLAN</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
          {(n.mealPlan||[]).map((m,i) => (
            <div key={i} style={{ background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:10, padding:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                <div style={{ fontFamily:"'Bebas Neue'", fontSize:16, color:"#e8ff00", letterSpacing:1 }}>{m.meal}</div>
                <div style={{ color:"#7070a0", fontSize:12 }}>{m.time} &middot; {m.calories} kcal</div>
              </div>
              <div style={{ fontSize:13 }}>{m.foods}</div>
            </div>
          ))}
        </div>

        {n.tips && n.tips.length>0 && (
          <div>
            <div style={S.sectionTitle}>PRO TIPS</div>
            {n.tips.map((tip,i) => (
              <div key={i} style={{ display:"flex", alignItems:"flex-start", padding:"9px 0", borderBottom:"1px solid #2a2a3d" }}>
                <span style={{ color:"#e8ff00", marginRight:10, flexShrink:0 }}>&#9658;</span>
                <span style={{ fontSize:13 }}>{tip}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
export default function BodyMorph() {
  const [phase, setPhase]     = useState("init");   // init | wizard | loading | home | session | progress | nutrition
  const [profile, setProfile] = useState(null);
  const [program, setProgram] = useState(null);
  const [dayIdx, setDayIdx]   = useState(0);
  const [logs, setLogs]       = useState({});
  const [rewards, setRewards] = useState(emptyMedalState());
  const [bodyEntries, setBodyEntries] = useState([]);
  const [toast, setToast]     = useState(null);
  const [loaded, setLoaded]   = useState(false);

  // Load saved profile + logs + medals on first mount
  useEffect(() => {
    (async () => {
      const sp = await Store.get(PROFILE_KEY);
      const sl = await Store.get(LOG_KEY);
      const sm = await Store.get(MEDAL_KEY);
      const sb = await Store.get(BODY_KEY);
      if (sl) setLogs(sl);
      if (sm) setRewards(sm);
      if (sb) setBodyEntries(sb);
      if (sp) { setProfile(sp); setProgram(buildProgram(sp)); setPhase("home"); }
      else { setPhase("wizard"); }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (loaded) Store.set(LOG_KEY, logs); }, [logs, loaded]);
  useEffect(() => { if (loaded) Store.set(MEDAL_KEY, rewards); }, [rewards, loaded]);
  useEffect(() => { if (loaded) Store.set(BODY_KEY, bodyEntries); }, [bodyEntries, loaded]);

  const showToast = (medal) => { setToast(medal); setTimeout(()=>setToast(null), 3500); };

  const handleWizardDone = async (prof) => {
    setProfile(prof);
    setPhase("loading");
    await Store.set(PROFILE_KEY, prof);
    await new Promise(r => setTimeout(r, 1400));
    setProgram(buildProgram(prof));
    setPhase("home");
  };

  const switchUser = async () => {
    await Store.set(PROFILE_KEY, null);
    setProfile(null); setProgram(null);
    setPhase("wizard");
  };

  const addBodyEntry = (entry) => {
    setBodyEntries(prev => [{ ...entry, date: entry.date || new Date().toISOString().slice(0,10) }, ...prev]);
  };
  const deleteBodyEntry = (idx) => {
    setBodyEntries(prev => prev.filter((_, i) => i !== idx));
  };

  function bestWeight(exName) {
    const arr = logs[exName] || [];
    return arr.reduce((mx,h) => {
      const w = h.sets ? Math.max(...h.sets.map(s=>parseFloat(s.weight)||0)) : (parseFloat(h.weight)||0);
      return Math.max(mx, w);
    }, 0);
  }

  // Save one exercise's sets from the session
  const logExercise = (exName, entry) => {
    const today = entry.date || new Date().toISOString().slice(0,10);
    const prevBest = bestWeight(exName);
    const newTop = parseFloat(entry.weight) || 0;
    const isPR = prevBest > 0 && newTop > prevBest;

    setLogs(prev => ({ ...prev, [exName]: [ ...(prev[exName]||[]), { ...entry, pr:isPR } ] }));

    setRewards(prev => {
      const st = JSON.parse(JSON.stringify(prev));
      st.stats.totalLogs += 1;
      if (isPR) st.stats.totalPRs += 1;
      if (st.stats.lastWorkoutDate !== today) {
        const last = st.stats.lastWorkoutDate ? new Date(st.stats.lastWorkoutDate) : null;
        if (last && (new Date(today) - last) <= 86400000*3) st.stats.currentStreak = (st.stats.currentStreak||0)+1;
        else st.stats.currentStreak = 1;
        st.stats.lastWorkoutDate = today;
        st.stats.bestStreak = Math.max(st.stats.bestStreak||0, st.stats.currentStreak);
      }
      const { state, newlyEarned } = evaluateMedals(st);
      if (newlyEarned.length) showToast(newlyEarned[0]);
      return state;
    });
  };

  const completeWorkout = () => {
    setRewards(prev => {
      const st = JSON.parse(JSON.stringify(prev));
      st.stats.workoutsCompleted += 1;
      const { state, newlyEarned } = evaluateMedals(st);
      if (newlyEarned.length) showToast(newlyEarned[0]);
      return state;
    });
  };

  // Medal toast (rendered above everything)
  const Toast = () => toast ? (
    <div style={{ position:"fixed", top:16, left:"50%", transform:"translateX(-50%)", zIndex:200, background:"#1a1a26", border:"1px solid #e8ff00", borderRadius:12, padding:"12px 18px", display:"flex", alignItems:"center", gap:12, boxShadow:"0 8px 30px rgba(0,0,0,0.6)", animation:"fadeIn 0.3s ease" }}>
      <span style={{ fontSize:30 }}>{toast.emoji}</span>
      <div>
        <div style={{ color:"#e8ff00", fontFamily:"'Bebas Neue'", fontSize:18, letterSpacing:1 }}>MEDAL UNLOCKED</div>
        <div style={{ fontSize:13, fontWeight:600 }}>{toast.label} &middot; +{toast.coins} coins</div>
      </div>
    </div>
  ) : null;

  if (phase === "init")    return <div style={S.center}><style>{GLOBAL_CSS}</style><Watermark /><Logo /></div>;
  if (phase === "wizard")  return <><Toast /><Wizard onComplete={handleWizardDone} /></>;
  if (phase === "loading") return <Loading name={profile && profile.name} />;

  if (phase === "home") return (
    <><Toast />
      <Home profile={profile} program={program} rewards={rewards}
        onPickDay={(i)=>{ setDayIdx(i); setPhase("session"); }}
        onProgress={()=>setPhase("progress")} onNutrition={()=>setPhase("nutrition")}
        onReset={switchUser} />
    </>
  );

  if (phase === "session") return (
    <><Toast />
      <Session profile={profile} day={(program.weeklySchedule||[])[dayIdx]||{}} logs={logs}
        onLogExercise={logExercise} onCompleteWorkout={completeWorkout}
        onBack={()=>setPhase("home")} />
    </>
  );

  if (phase === "progress")  return (<><Toast /><Progress logs={logs} rewards={rewards} bodyEntries={bodyEntries} onAddBody={addBodyEntry} onDeleteBody={deleteBodyEntry} onBack={()=>setPhase("home")} /></>);
  if (phase === "nutrition") return (<><Toast /><Nutrition program={program} onBack={()=>setPhase("home")} /></>);

  return <div style={S.center}><style>{GLOBAL_CSS}</style><Watermark /><Logo /></div>;
}

// ── STYLES ────────────────────────────────────────────────────────────────────
const S = {
  center: { minHeight:"100vh", background:"transparent", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"32px 20px", gap:22, position:"relative" },
  stepLabel: { fontFamily:"'Bebas Neue'", fontSize:20, letterSpacing:3, color:"#7070a0", textAlign:"center" },
  inputLabel: { color:"#7070a0", fontSize:11, letterSpacing:1, marginBottom:6, textTransform:"uppercase" },
  input: { width:"100%", background:"#1a1a26", border:"1px solid #2a2a3d", borderRadius:8, color:"#f0f0f8", padding:"11px 14px", fontSize:15, fontFamily:"'DM Sans'", outline:"none" },
  btnPri: { background:"#12121a", border:"1px solid #2a2a3d", borderRadius:10, color:"#f0f0f8", padding:"12px 28px", cursor:"pointer", fontSize:15, fontFamily:"'DM Sans'", fontWeight:600 },
  btnSec: { background:"transparent", border:"1px solid #2a2a3d", borderRadius:10, color:"#7070a0", padding:"12px 20px", cursor:"pointer", fontSize:14, fontFamily:"'DM Sans'" },
  sectionTitle: { fontFamily:"'Bebas Neue'", fontSize:17, letterSpacing:3, color:"#7070a0", marginBottom:12, paddingTop:4 },
};

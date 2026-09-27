// ── GYM EQUIPMENT: vocabulary, per-exercise needs, and substitutions ────────────
// Neal's gym-orientation feature. A client photographs each machine in their gym
// (front and side, voice coach narrating), and from then on every exercise in their
// program shows the actual machine THEY will walk up to.
//
// This file is the layer underneath that: what each exercise needs, expressed in a
// fixed vocabulary, plus what to do when their gym hasn't got it. Nothing here touches
// photos — it's the matching table the photos get compared against.
//
// The vocabulary is deliberately small and coarse. Vision can reliably tell a leg
// press from a hack squat; it cannot reliably tell a 2019 Hammer Strength incline
// press from a 2014 one, and nothing in the program depends on that difference.

export const EQUIPMENT = {
  // Benches and racks
  "flat-bench":          { label: "Flat bench",            area: "free weights" },
  "incline-bench":       { label: "Incline bench",         area: "free weights" },
  "decline-bench":       { label: "Decline bench",         area: "free weights" },
  "adjustable-bench":    { label: "Adjustable bench",      area: "free weights" },
  "preacher-bench":      { label: "Preacher curl bench",   area: "free weights" },
  "hyperextension-bench":{ label: "Back extension bench",  area: "core" },
  "squat-rack":          { label: "Squat rack",            area: "free weights" },
  "power-rack":          { label: "Power rack",            area: "free weights" },

  // Loose weights
  "barbell":             { label: "Barbell",               area: "free weights" },
  "ez-bar":              { label: "EZ curl bar",           area: "free weights" },
  "dumbbells":           { label: "Dumbbells",             area: "free weights" },
  "weight-plate":        { label: "Weight plate",          area: "free weights" },

  // Cables
  "cable-station":       { label: "Cable machine",         area: "cables" },
  "cable-crossover":     { label: "Cable crossover",       area: "cables" },

  // Chest / back / shoulder machines
  "chest-press-machine": { label: "Chest press machine",   area: "upper body" },
  "pec-deck":            { label: "Pec deck",              area: "upper body" },
  "shoulder-press-machine": { label: "Shoulder press machine", area: "upper body" },
  "lat-pulldown":        { label: "Lat pulldown",          area: "upper body" },
  "seated-cable-row":    { label: "Seated cable row",      area: "upper body" },
  "chest-supported-row": { label: "Chest-supported row",   area: "upper body" },
  "t-bar-row":           { label: "T-bar row",             area: "upper body" },

  // Legs
  "leg-press":           { label: "Leg press",             area: "lower body" },
  "hack-squat":          { label: "Hack squat",            area: "lower body" },
  "leg-extension":       { label: "Leg extension",         area: "lower body" },
  "lying-leg-curl":      { label: "Lying leg curl",        area: "lower body" },
  "seated-leg-curl":     { label: "Seated leg curl",       area: "lower body" },
  "standing-calf-raise": { label: "Standing calf raise",   area: "lower body" },
  "seated-calf-raise":   { label: "Seated calf raise",     area: "lower body" },

  // Bodyweight
  "pull-up-bar":         { label: "Pull-up bar",           area: "bodyweight" },
  "dip-station":         { label: "Dip station",           area: "bodyweight" },
  "bodyweight":          { label: "No equipment",          area: "bodyweight" },
};

// What each exercise needs. The FIRST entry is the one whose photo gets shown on the
// tile — the thing you walk up to. A bench listed second is context, not the tile.
export const EXERCISE_EQUIPMENT = {
  // Chest
  "Flat Barbell Bench Press":      ["flat-bench", "barbell"],
  "Incline Barbell Bench Press":   ["incline-bench", "barbell"],
  "Incline Dumbbell Press":        ["incline-bench", "dumbbells"],
  "Flat Dumbbell Press":           ["flat-bench", "dumbbells"],
  "Decline Barbell Press":         ["decline-bench", "barbell"],
  "Machine Chest Press":           ["chest-press-machine"],
  "Machine Flat Press":            ["chest-press-machine"],
  "Pec-Deck Machine":              ["pec-deck"],
  "Cable Flyes":                   ["cable-crossover"],
  "Low-to-High Cable Fly":         ["cable-crossover"],
  "Cable Crossover (high)":        ["cable-crossover"],
  "Cable Crossover (low)":         ["cable-crossover"],
  "Dips (chest-lean)":             ["dip-station"],
  "Push-Ups":                      ["bodyweight"],

  // Back
  "Lat Pulldown":                  ["lat-pulldown"],
  "Wide-Grip Lat Pulldown":        ["lat-pulldown"],
  "Neutral-Grip Pulldown":         ["lat-pulldown"],
  "Seated Cable Row":              ["seated-cable-row"],
  "Seated Wide-Grip Row":          ["seated-cable-row"],
  "Bent-Over Barbell Row":         ["barbell"],
  "Single-Arm Dumbbell Row":       ["dumbbells", "flat-bench"],
  "Straight-Arm Pulldown":         ["cable-station"],
  "Straight-Arm Cable Pullover":   ["cable-station"],
  "Cable Pullover":                ["cable-station"],
  "Single-Arm Cable Row":          ["cable-station"],
  "Wide-Grip Pull-Ups":            ["pull-up-bar"],
  "T-Bar Row":                     ["t-bar-row"],
  "Chest-Supported Machine Row":   ["chest-supported-row"],
  "Rack Pull (moderate)":          ["power-rack", "barbell"],

  // Legs
  "Leg Press":                     ["leg-press"],
  "Leg Press (feet high)":         ["leg-press"],
  "Hack Squat":                    ["hack-squat"],
  "Front Squat":                   ["squat-rack", "barbell"],
  "Leg Extension":                 ["leg-extension"],
  "Lying Leg Curl":                ["lying-leg-curl"],
  "Seated Leg Curl":               ["seated-leg-curl"],
  "Romanian Deadlift":             ["barbell"],
  "Bulgarian Split Squat":         ["dumbbells", "flat-bench"],
  "Walking Lunges":                ["bodyweight"],
  "Walking Dumbbell Lunges":       ["dumbbells"],
  "Standing Calf Raise":           ["standing-calf-raise"],
  "Seated Calf Raise":             ["seated-calf-raise"],
  "Donkey / Standing Calf Raise":  ["standing-calf-raise"],

  // Shoulders
  "Seated Dumbbell Shoulder Press":["adjustable-bench", "dumbbells"],
  "Seated Dumbbell Press":         ["adjustable-bench", "dumbbells"],
  "Standing Barbell Overhead Press":["barbell"],
  "Machine Shoulder Press":        ["shoulder-press-machine"],
  "Arnold Press":                  ["adjustable-bench", "dumbbells"],
  "Dumbbell Lateral Raise":        ["dumbbells"],
  "Cable Lateral Raise":           ["cable-station"],
  "Leaning Cable Lateral Raise":   ["cable-station"],
  "Rear-Delt Cable Fly":           ["cable-crossover"],
  "Rear-Delt Dumbbell Fly":        ["dumbbells"],
  "Reverse Pec-Deck":              ["pec-deck"],
  "Front Raise":                   ["dumbbells"],
  "Plate Front Raise":             ["weight-plate"],
  "Upright Row":                   ["barbell"],
  "Cable Upright Row":             ["cable-station"],

  // Arms
  "Barbell Curl":                  ["barbell"],
  "EZ-Bar Curl":                   ["ez-bar"],
  "Preacher Curl":                 ["preacher-bench", "ez-bar"],
  "Incline Dumbbell Curl":         ["incline-bench", "dumbbells"],
  "Hammer Curl":                   ["dumbbells"],
  "Cable Curl":                    ["cable-station"],
  "Rope Triceps Pushdown":         ["cable-station"],
  "Overhead Dumbbell Triceps Extension": ["dumbbells"],
  "Overhead Cable Triceps Extension":    ["cable-station"],
  "Skull Crushers":                ["ez-bar", "flat-bench"],
  "Close-Grip Bench Press":        ["flat-bench", "barbell"],
  "Dip Machine / Weighted Dips":   ["dip-station"],
  "Cable Curl superset with Triceps Dips":        ["cable-station", "dip-station"],
  "Concentration Curl superset with Rope Pushdown": ["dumbbells", "cable-station"],
  "Spider Curl superset with Kickbacks":          ["incline-bench", "dumbbells"],

  // Core finisher
  "Hanging Leg Raises":            ["pull-up-bar"],
  "Cable Crunches":                ["cable-station"],
  "Back Extensions":               ["hyperextension-bench"],
  "Light Woodchoppers / Rotational Plank": ["cable-station"],
};

// When the gym hasn't got it. Each entry is an ordered fallback: the first option
// whose equipment they DO have wins. Swaps stay within the same muscle and the same
// movement pattern — a missing pec deck becomes another chest fly, never a press.
export const SUBSTITUTIONS = {
  "Pec-Deck Machine":            ["Cable Flyes", "Flat Dumbbell Press"],
  "Reverse Pec-Deck":            ["Rear-Delt Cable Fly", "Rear-Delt Dumbbell Fly"],
  "Machine Chest Press":         ["Flat Dumbbell Press", "Push-Ups"],
  "Machine Flat Press":          ["Flat Dumbbell Press", "Push-Ups"],
  "Hack Squat":                  ["Leg Press", "Bulgarian Split Squat"],
  "Leg Press":                   ["Hack Squat", "Walking Dumbbell Lunges"],
  "Leg Press (feet high)":       ["Hack Squat", "Bulgarian Split Squat"],
  "Seated Leg Curl":             ["Lying Leg Curl", "Romanian Deadlift"],
  "Lying Leg Curl":              ["Seated Leg Curl", "Romanian Deadlift"],
  "Seated Calf Raise":           ["Standing Calf Raise"],
  "Standing Calf Raise":         ["Seated Calf Raise"],
  "Donkey / Standing Calf Raise":["Standing Calf Raise", "Seated Calf Raise"],
  "T-Bar Row":                   ["Bent-Over Barbell Row", "Chest-Supported Machine Row"],
  "Chest-Supported Machine Row": ["Seated Cable Row", "Single-Arm Dumbbell Row"],
  "Machine Shoulder Press":      ["Seated Dumbbell Shoulder Press"],
  "Wide-Grip Pull-Ups":          ["Wide-Grip Lat Pulldown"],
  "Hanging Leg Raises":          ["Cable Crunches"],
  "Dips (chest-lean)":           ["Push-Ups", "Flat Dumbbell Press"],
  "Dip Machine / Weighted Dips": ["Close-Grip Bench Press", "Rope Triceps Pushdown"],
  "Back Extensions":             ["Romanian Deadlift"],
  "Cable Crunches":              ["Hanging Leg Raises"],
  "Preacher Curl":               ["EZ-Bar Curl", "Barbell Curl"],
  "Front Squat":                 ["Hack Squat", "Leg Press"],
  "Rack Pull (moderate)":        ["Romanian Deadlift", "Bent-Over Barbell Row"],
};


// Some equipment covers other equipment. A crossover is a cable station with two
// towers, so anything doable on a single cable is doable on it; a straight barbell
// does an EZ-bar's job; an adjustable bench is a flat and an incline bench. Without
// this, a gym with a cable crossover gets told it can't do cable flyes.
const IMPLIES = {
  "cable-crossover":  ["cable-station"],
  "barbell":          ["ez-bar"],
  "ez-bar":           ["barbell"],
  "adjustable-bench": ["flat-bench", "incline-bench", "decline-bench"],
  "power-rack":       ["squat-rack"],
  "squat-rack":       ["power-rack"],
};

// Expand a set of owned ids to everything they cover.
function expand(owned) {
  const out = new Set(owned);
  for (const id of owned) for (const also of IMPLIES[id] || []) out.add(also);
  return out;
}

export const equipmentFor = (exercise) => EXERCISE_EQUIPMENT[exercise] || [];

// Does the client's gym cover this exercise? `owned` is the set of equipment ids from
// their photographed profile. Bodyweight always passes.
export function canDo(exercise, owned) {
  const need = equipmentFor(exercise);
  if (!need.length) return true;                 // untagged — don't block on our gaps
  const have = expand(owned);
  return need.every((id) => id === "bodyweight" || have.has(id));
}

// Resolve one exercise against a gym. Returns what to actually show:
//   { exercise, substituted, original, missing }
// `substituted` is deliberately surfaced rather than swapped silently — a client who
// discovers later that their program quietly differed from the chart stops trusting it.
export function resolveExercise(exercise, owned) {
  if (canDo(exercise, owned)) return { exercise, substituted: false };
  const have = expand(owned);
  const missing = equipmentFor(exercise).filter((id) => id !== "bodyweight" && !have.has(id));
  for (const alt of SUBSTITUTIONS[exercise] || []) {
    if (canDo(alt, owned)) return { exercise: alt, substituted: true, original: exercise, missing };
  }
  // Nothing fits. Keep the original and say so — better than dropping it silently and
  // leaving a hole in the day nobody can explain.
  return { exercise, substituted: false, unavailable: true, missing };
}

// The tile: which single piece of equipment the client walks up to for this exercise.
export const tileEquipment = (exercise) => equipmentFor(exercise)[0] || null;

// ── Don't photograph the same thing twice ───────────────────────────────────────
// Neal: "if the gym has three hundred treadmills, a picture of one treadmill is good
// enough... it only stores unique equipment."
//
// Dedup is by TYPE, not by physical machine. Walk past a second leg press and the
// coach says it already has that one and moves you on. The exception is a genuinely
// different machine that happens to sit in the same family — a curved sprint
// treadmill next to a motorised one — which gets its own entry because it IS a
// different piece of equipment, not another copy.
//
// The program only ever matches on the BASE id, so variants never fragment the
// matching: having "treadmill" and "treadmill/curved" still means you have a
// treadmill. Variants exist so the photo library shows what's actually on the floor.

export const baseId = (id) => String(id || "").split("/")[0];

// Equipment ids the gym covers, base ids only — this is what canDo/resolveExercise want.
export function ownedSet(profile) {
  const items = (profile && profile.items) || [];
  return new Set(items.map((it) => baseId(it.id)));
}

// Decide what to do with a freshly identified machine.
//   { action: "add" }                            — new, store it
//   { action: "skip", have }                     — already have this type
//   { action: "variant", base }                  — same family, genuinely different machine
export function classifyCapture(profile, identified) {
  const items = (profile && profile.items) || [];
  const id = String(identified.id || "");
  const base = baseId(id);
  const existing = items.filter((it) => baseId(it.id) === base);

  if (!existing.length) return { action: "add" };

  // The vision pass marks a machine as a distinct variant when it differs in kind
  // rather than in make — that's the only thing that earns a second entry.
  if (identified.variant) {
    const already = existing.some((it) => it.id === id);
    return already ? { action: "skip", have: existing[0] } : { action: "variant", base };
  }
  return { action: "skip", have: existing[0] };
}

// What the coach says out loud. Short, because it's spoken mid-walk around a gym.
export function captureLine(result, label) {
  if (result.action === "add")     return `${label} — got it.`;
  if (result.action === "variant") return `Different kind of ${label.toLowerCase()} — worth having. Got it.`;
  return `Already got a ${label.toLowerCase()}. Skip to the next one.`;
}

// Which equipment the client's PROGRAM actually needs — so setup can be prioritised,
// and so "you're ready to train" means something specific rather than "keep going
// until the whole gym is photographed."
export function neededFor(exercises) {
  const need = new Set();
  for (const ex of exercises) for (const id of equipmentFor(ex)) if (id !== "bodyweight") need.add(id);
  return need;
}

// How far through setup they are, measured against their own program rather than
// against the building. 30 machines photographed is meaningless; "everything your
// program needs" is the number that matters.
export function setupProgress(profile, exercises) {
  const need = neededFor(exercises);
  const have = ownedSet(profile);
  const reach = expand(have);
  const covered = [...need].filter((id) => reach.has(id));
  const missing = [...need].filter((id) => !reach.has(id));
  return { need: need.size, covered: covered.length, missing, ready: missing.length === 0 };
}

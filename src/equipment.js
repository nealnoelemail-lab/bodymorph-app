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

  "hip-abduction-machine":{ label: "Hip abduction machine", area: "lower body" },
  "hip-adductor-machine": { label: "Adductor machine",      area: "lower body" },
  "lateral-raise-machine":{ label: "Lateral raise machine", area: "upper body" },
  "smith-machine":       { label: "Smith machine",          area: "free weights" },
  "glute-ham-bench":     { label: "Glute-ham / Nordic bench", area: "lower body" },
  "step-box":            { label: "Step or plyo box",       area: "accessories", kind: "accessory" },
  "resistance-band":     { label: "Resistance band",        area: "accessories", kind: "accessory" },
  "chair":               { label: "Chair or box",           area: "accessories", kind: "accessory" },
  "treadmill":           { label: "Treadmill",              area: "cardio" },
  "stationary-bike":     { label: "Stationary bike",        area: "cardio" },
  "elliptical":          { label: "Elliptical",             area: "cardio" },
  "rower":               { label: "Rowing machine",         area: "cardio" },
  "stair-climber":       { label: "Stair climber",          area: "cardio" },


  // ── Loose kit ─────────────────────────────────────────────────────────────
  // Sizes matter here in a way they don't for machines: a 10 lb medicine ball and a
  // 25 lb one are different tools, so these dedupe by label, not by type.
  "kettlebell":          { label: "Kettlebell",             area: "accessories", kind: "accessory" },
  "medicine-ball":       { label: "Medicine ball",          area: "accessories", kind: "accessory" },
  "slam-ball":           { label: "Slam ball",              area: "accessories", kind: "accessory" },
  "stability-ball":      { label: "Stability ball",         area: "accessories", kind: "accessory" },
  "loop-band":           { label: "Loop / mini band",       area: "accessories", kind: "accessory" },
  "climbing-rope":       { label: "Climbing rope",          area: "accessories", kind: "accessory" },
  "battle-rope":         { label: "Battle ropes",           area: "accessories", kind: "accessory" },
  "suspension-trainer":  { label: "Suspension trainer",     area: "accessories", kind: "accessory" },
  "ab-wheel":            { label: "Ab wheel",               area: "accessories", kind: "accessory" },
  "foam-roller":         { label: "Foam roller",            area: "accessories", kind: "accessory" },
  "jump-rope":           { label: "Jump rope",              area: "accessories", kind: "accessory" },
  "weight-vest":         { label: "Weight vest",            area: "accessories", kind: "accessory" },
  "dip-belt":            { label: "Dip / pull-up belt",     area: "accessories", kind: "accessory" },
  "ankle-weights":       { label: "Ankle weights",          area: "accessories", kind: "accessory" },
  "trap-bar":            { label: "Trap / hex bar",         area: "free weights", kind: "accessory" },
  "landmine":            { label: "Landmine",               area: "free weights" },
  "sled":                { label: "Push / pull sled",       area: "free weights" },
  "dumbbell-rack":       { label: "Dumbbell rack",          area: "free weights" },

  // ── Cardio ────────────────────────────────────────────────────────────────
  "spin-bike":           { label: "Spin bike",              area: "cardio" },
  "air-bike":            { label: "Air / fan bike",         area: "cardio" },
  "ski-erg":             { label: "Ski erg",                area: "cardio" },

  // ── Cable and pulldown attachments ────────────────────────────────────────
  // These are ADVISORY, never required — see EXERCISE_ATTACHMENT below. They exist so
  // the tile can say "use the wide bar", which is the difference between a client
  // doing the prescribed exercise and doing something adjacent to it.
  "wide-lat-bar":        { label: "Wide-grip lat bar",      area: "attachments", kind: "attachment" },
  "narrow-lat-bar":      { label: "Narrow-grip bar",        area: "attachments", kind: "attachment" },
  "v-handle":            { label: "V-handle / neutral grip", area: "attachments", kind: "attachment" },
  "straight-cable-bar":  { label: "Straight cable bar",     area: "attachments", kind: "attachment" },
  "ez-cable-bar":        { label: "EZ cable bar",           area: "attachments", kind: "attachment" },
  "rope-attachment":     { label: "Rope attachment",        area: "attachments", kind: "attachment" },
  "single-handle":       { label: "Single D-handle",        area: "attachments", kind: "attachment" },
  "ankle-strap":         { label: "Ankle strap",            area: "attachments", kind: "attachment" },

  // Bodyweight
  "pull-up-bar":         { label: "Pull-up bar",           area: "bodyweight" },
  "dip-station":         { label: "Dip station",           area: "bodyweight" },
  "bodyweight":          { label: "No equipment needed",    area: "bodyweight", kind: "none" },
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
  // A cable and something solid to dip on. A dedicated dip station is nice, not required.
  "Cable Curl superset with Triceps Dips":        ["cable-station", "chair"],
  "Concentration Curl superset with Rope Pushdown": ["dumbbells", "cable-station"],
  "Spider Curl superset with Kickbacks":          ["incline-bench", "dumbbells"],


  // ── The rest of the app's programs ────────────────────────────────────────
  // Basic splits, HFT, Glute & Lower Body, Calisthenics and Active Aging. Tagged so
  // the machine tile works everywhere, not only in Black Panther.

  // Barbell / dumbbell compounds
  "Barbell Back Squat":            ["squat-rack", "barbell"],
  "Barbell Bicep Curl":            ["barbell"],
  "Barbell Hip Thrust":            ["flat-bench", "barbell"],
  "Barbell RDL":                   ["barbell"],
  "Barbell Romanian Deadlift":     ["barbell"],
  "Conventional Deadlift":         ["barbell"],
  "Dumbbell Bench Press":          ["flat-bench", "dumbbells"],
  "Dumbbell Shoulder Press":       ["adjustable-bench", "dumbbells"],
  "Incline Barbell Press":         ["incline-bench", "barbell"],
  "Standing Overhead Press":       ["barbell"],
  "Goblet Squat":                  ["dumbbells"],
  "Sumo Squat":                    ["bodyweight"],
  "Sumo Squat (Dumbbell)":         ["dumbbells"],
  "EZ-Bar Reverse Curl":           ["ez-bar"],
  "Skull Crusher":                 ["ez-bar", "flat-bench"],
  "Light Bicep Curl":              ["dumbbells"],
  "Front Plate Raise":             ["weight-plate"],
  "Wide-Grip Upright Row":         ["barbell"],
  "Hammer Strength Decline Press": ["chest-press-machine"],
  "Incline Dumbbell Row":          ["incline-bench", "dumbbells"],
  "Chest-Supported Dumbbell Row":  ["incline-bench", "dumbbells"],

  // Machines
  "Adductor Machine":              ["hip-adductor-machine"],
  "Hip Abduction":                 ["hip-abduction-machine"],
  "Hip Abduction (Machine/Band)":  ["hip-abduction-machine"],
  "Lateral Raise Machine":         ["lateral-raise-machine"],
  "Leg Press (Feet High & Wide)":  ["leg-press"],
  "Leg Press (High & Wide)":       ["leg-press"],
  "Leg Press (feet high and wide)":["leg-press"],
  "Leg Press Calf Press":          ["leg-press"],
  "Pec Deck Fly":                  ["pec-deck"],
  "Reverse Pec Deck":              ["pec-deck"],
  "Seated Knee Extension":         ["leg-extension"],
  "Nordic / Lying Leg Curl":       ["lying-leg-curl"],
  "Nordic Hamstring Curl":         ["glute-ham-bench"],
  "Incline Bench Lat Pulldown":    ["lat-pulldown"],

  // Cables
  "Cable Abduction":               ["cable-station"],
  "Cable Crossover":               ["cable-crossover"],
  "Cable Fly":                     ["cable-crossover"],
  "Cable Glute Kickback":          ["cable-station"],
  "Cable Hip Abduction":           ["cable-station"],
  "Cable Kickback":                ["cable-station"],
  "Cable Overhead Extension":      ["cable-station"],
  "Overhead Cable Extension":      ["cable-station"],
  "Cable Tricep Pushdown":         ["cable-station"],
  "Rope Pushdown":                 ["cable-station"],
  "Cable Woodchop":                ["cable-station"],
  "Cable Woodchopper":             ["cable-station"],
  "Kneeling Rope Crunch":          ["cable-station"],
  "Face Pull":                     ["cable-station"],
  "Rear Delt Fly":                 ["dumbbells"],

  // Loaded bodyweight / bars
  "Pull-Up / Chin-Up":             ["pull-up-bar"],
  "Weighted Pull-Up":              ["pull-up-bar"],
  "Hanging Knee Raise":            ["pull-up-bar"],
  "Hanging Leg Raise":             ["pull-up-bar"],
  "Chest Dip":                     ["dip-station"],
  "Weighted Dip":                  ["dip-station"],
  "Inverted Row":                  ["barbell"],

  // Loaded variants of bodyweight moves
  "Bulgarian Split Squat (Loaded)":["dumbbells", "flat-bench"],
  "Curtsy Lunge (Dumbbell)":       ["dumbbells"],
  "Curtsy Lunge (Loaded)":         ["dumbbells"],
  "Glute Bridge (Barbell)":        ["barbell"],
  "Glute Bridge (Feet Elevated)":  ["flat-bench"],
  "Hip Thrust":                    ["flat-bench"],
  "Romanian Deadlift (Light DB)":  ["dumbbells"],
  "Single-Leg RDL (Loaded)":       ["dumbbells"],
  "Step-Up (Loaded)":              ["step-box", "dumbbells"],
  "Step-Up (Bodyweight)":          ["step-box"],
  "Walking Lunge (Loaded)":        ["dumbbells"],
  "Dead Bug (Weighted)":           ["dumbbells"],
  "Weighted Dead Bug":             ["dumbbells"],
  "Banded Lateral Walk":           ["resistance-band"],

  // No equipment — Active Aging, Calisthenics, core and mobility work.
  // Tagged explicitly rather than left blank: an untagged exercise means "we don't
  // know", and that reads the same as "needs nothing" if you don't say which.
  "Ankle Circles":                 ["bodyweight"],
  "Bicycle Crunch":                ["bodyweight"],
  "Bird Dog":                      ["bodyweight"],
  "Bodyweight Squat":              ["bodyweight"],
  "Chest Opener":                  ["bodyweight"],
  "Curtsy Lunge":                  ["bodyweight"],
  "Daily Walk":                    ["bodyweight"],
  "Dead Bug":                      ["bodyweight"],
  "Diamond Push-Up":               ["bodyweight"],
  "Gentle Side Bend":              ["bodyweight"],
  "Glute Bridge":                  ["bodyweight"],
  "Glute Bridge (Bodyweight)":     ["bodyweight"],
  "Glute Bridge Burnout":          ["bodyweight"],
  "Glute Bridge March":            ["bodyweight"],
  "Heel-to-Toe Walk":              ["bodyweight"],
  "Hip Thrust (Bodyweight/Light)": ["bodyweight"],
  "Hollow Hold":                   ["bodyweight"],
  "Lying Leg Raise":               ["bodyweight"],
  "Mountain Climbers":             ["bodyweight"],
  "Neck & Shoulder Rolls":         ["bodyweight"],
  "Pike Push-Up":                  ["bodyweight"],
  "Plank":                         ["bodyweight"],
  "Plank Circuit":                 ["bodyweight"],
  "Plank with Shoulder Tap":       ["bodyweight"],
  "Push-Up":                       ["bodyweight"],
  "Push-Up (feet elevated)":       ["bodyweight"],
  "Reverse Lunge":                 ["bodyweight"],
  "Seated Cat-Cow":                ["bodyweight"],
  "Seated Hamstring Stretch":      ["bodyweight"],
  "Side Plank":                    ["bodyweight"],
  "Side-Lying Hip Abduction":      ["bodyweight"],
  "Single-Leg Hip Thrust":         ["bodyweight"],
  "Single-Leg RDL":                ["bodyweight"],
  "Single-Leg Stand":              ["bodyweight"],
  "Standing March":                ["bodyweight"],
  "Standing Side Leg Raise":       ["bodyweight"],
  "Stomach Vacuum":                ["bodyweight"],
  "Stomach Vacuum + Side Plank":   ["bodyweight"],
  "Superman Hold":                 ["bodyweight"],
  "Toe & Heel Raises":             ["bodyweight"],
  "Walking Lunge":                 ["bodyweight"],
  "Wall Push-Up":                  ["bodyweight"],
  "Calf Raise":                    ["bodyweight"],
  "Frog Pump":                     ["bodyweight"],

  // Improvised — the no-gym programs deliberately use what's in a room.
  "Chair / Bench Dip":             ["chair"],
  "Sit-to-Stand (Chair Squat)":    ["chair"],
  "Towel Door Row":                ["bodyweight"],
  "Adductor Squeeze / Inner-Thigh":["bodyweight"],

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

  // ── The rest of the app's programs ────────────────────────────────────────
  "Pec Deck Fly":                  ["Cable Fly", "Dumbbell Bench Press"],
  "Reverse Pec Deck":              ["Rear Delt Fly", "Face Pull"],
  "Nordic Hamstring Curl":         ["Nordic / Lying Leg Curl", "Barbell Romanian Deadlift"],
  "Nordic / Lying Leg Curl":       ["Seated Leg Curl", "Barbell Romanian Deadlift"],
  "Hip Abduction":                 ["Cable Hip Abduction", "Banded Lateral Walk", "Side-Lying Hip Abduction"],
  "Hip Abduction (Machine/Band)":  ["Cable Hip Abduction", "Banded Lateral Walk", "Side-Lying Hip Abduction"],
  "Adductor Machine":              ["Sumo Squat (Dumbbell)", "Adductor Squeeze / Inner-Thigh"],
  "Lateral Raise Machine":         ["Dumbbell Lateral Raise", "Cable Lateral Raise"],
  "Seated Knee Extension":         ["Leg Extension", "Bodyweight Squat"],
  "Leg Extension":                 ["Seated Knee Extension", "Bodyweight Squat"],
  "Leg Press Calf Press":          ["Standing Calf Raise", "Calf Raise"],
  "Hammer Strength Decline Press": ["Dumbbell Bench Press", "Push-Up"],
  "Incline Bench Lat Pulldown":    ["Lat Pulldown", "Pull-Up / Chin-Up"],
  "Lat Pulldown":                  ["Pull-Up / Chin-Up", "Inverted Row"],
  "Pull-Up / Chin-Up":             ["Lat Pulldown", "Inverted Row"],
  "Weighted Pull-Up":              ["Pull-Up / Chin-Up", "Lat Pulldown"],
  "Weighted Dip":                  ["Chest Dip", "Chair / Bench Dip"],
  "Chest Dip":                     ["Chair / Bench Dip", "Diamond Push-Up"],
  "Inverted Row":                  ["Seated Cable Row", "Towel Door Row"],
  "Goblet Squat":                  ["Bodyweight Squat"],
  "Step-Up (Loaded)":              ["Walking Lunge (Loaded)", "Reverse Lunge"],
  "Step-Up (Bodyweight)":          ["Reverse Lunge", "Walking Lunge"],
  "Barbell Hip Thrust":            ["Hip Thrust", "Glute Bridge"],
  "Hip Thrust":                    ["Glute Bridge"],
  "Barbell Back Squat":            ["Goblet Squat", "Leg Press"],
  "Conventional Deadlift":         ["Barbell Romanian Deadlift", "Single-Leg RDL"],
  "Hanging Knee Raise":            ["Lying Leg Raise", "Dead Bug"],
  "Hanging Leg Raise":             ["Lying Leg Raise", "Dead Bug"],
  "Kneeling Rope Crunch":          ["Bicycle Crunch", "Dead Bug"],
  "Face Pull":                     ["Rear Delt Fly"],
  "Seated Cable Row":              ["Single-Arm Cable Row", "Bent-Over Barbell Row", "Inverted Row"],
  "Seated Wide-Grip Row":          ["Seated Cable Row", "Lat Pulldown", "Bent-Over Barbell Row"],
  "Standing Calf Raise":           ["Leg Press Calf Press", "Calf Raise"],
  "Seated Calf Raise":             ["Standing Calf Raise", "Leg Press Calf Press", "Calf Raise"],
  "Donkey / Standing Calf Raise":  ["Leg Press Calf Press", "Calf Raise"],
  "Banded Lateral Walk":           ["Cable Hip Abduction", "Side-Lying Hip Abduction"],
  "Dips (chest-lean)":             ["Chest Dip", "Chair / Bench Dip"],
  "Dip Machine / Weighted Dips":   ["Chest Dip", "Chair / Bench Dip"],
  "T-Bar Row":                     ["Bent-Over Barbell Row", "Single-Arm Dumbbell Row"],
  "Chest-Supported Machine Row":   ["Chest-Supported Dumbbell Row", "Seated Cable Row"],
};


// Some equipment covers other equipment. A crossover is a cable station with two
// towers, so anything doable on a single cable is doable on it; a straight barbell
// does an EZ-bar's job; an adjustable bench is a flat and an incline bench. Without
// this, a gym with a cable crossover gets told it can't do cable flyes.
const IMPLIES = {
  "cable-crossover":  ["cable-station"],
  "barbell":          ["ez-bar", "weight-plate"],
  "ez-bar":           ["barbell"],
  "adjustable-bench": ["flat-bench", "incline-bench", "decline-bench"],
  "power-rack":       ["squat-rack"],
  "squat-rack":       ["power-rack"],
  "flat-bench":       ["chair", "step-box"],
  "step-box":         ["chair"],
};

// Expand a set of owned ids to everything they cover.
function expand(owned) {
  const out = new Set(owned);
  for (const id of owned) for (const also of IMPLIES[id] || []) out.add(also);
  return out;
}

// Programs label the same movement by how hard it is that week — "Barbell Hip Thrust
// (Heavy)", "(Peak)", "(Drop Set)". Intensity doesn't change what you stand on, so
// those resolve to the base movement rather than needing their own entry, and any
// future intensity label works without a code change.
//
// Equipment qualifiers are NOT stripped: "Glute Bridge (Barbell)" and "(Bodyweight)"
// are different answers to this question, and collapsing them would be wrong.
const INTENSITY_LABEL = /\s*\((?:heavy|peak|volume|drop set|burnout|advanced|constant tension|light, high rep|high rep)\)/ig;
export const normalizeExercise = (name) => String(name || "").replace(INTENSITY_LABEL, "").replace(/\s+/g, " ").trim();

export const equipmentFor = (exercise) =>
  EXERCISE_EQUIPMENT[exercise] || EXERCISE_EQUIPMENT[normalizeExercise(exercise)] || [];

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
  const subs = SUBSTITUTIONS[exercise] || SUBSTITUTIONS[normalizeExercise(exercise)] || [];
  for (const alt of subs) {
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

  // Loose kit dedupes by DESCRIPTION, not by type. One leg press is enough, but a 10 lb
  // medicine ball and a 25 lb one are two different tools, and a wide lat bar is not a
  // spare copy of the narrow one — so anything the vision pass describes differently
  // earns its own entry. Matching still runs on the base id, so the extras can only ever
  // add detail to a tile; they can never split the gym's capability.
  if (isAccessory(base)) {
    const seen = (it) => descKey(it.label);
    const key = descKey(identified.detail ? `${identified.label} ${identified.detail}` : identified.label);
    return existing.some((it) => seen(it) === key)
      ? { action: "skip", have: existing[0] }
      : { action: "variant", base };
  }

  // The vision pass marks a machine as a distinct variant when it differs in kind
  // rather than in make — that's the only thing that earns a second entry.
  if (identified.variant) {
    const already = existing.some((it) => it.id === id);
    return already ? { action: "skip", have: existing[0] } : { action: "variant", base };
  }
  return { action: "skip", have: existing[0] };
}

// "10 lb Medicine Ball" and "medicine ball, 10lb" are the same thing photographed twice.
const descKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// What the coach says out loud. Short, because it's spoken mid-walk around a gym.
export function captureLine(result, label) {
  if (result.action === "add")     return `${label} — got it.`;
  if (result.action === "variant") return `${label} — that's a different one. Got it.`;
  return `Already got that one. Skip to the next.`;
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
  // `ready` needs something to have been required in the first place. A program whose
  // exercises carry no equipment tags produces an empty need set, and "0 of 0 missing"
  // would announce the gym was fully covered before a single photo was taken.
  return { need: need.size, covered: covered.length, missing, ready: need.size > 0 && missing.length === 0, untagged: need.size === 0 };
}

// ── Which handle to clip on ─────────────────────────────────────────────────────
// Neal: "you have a narrow grip pull down bar, wide grip pull down bar... so it becomes
// pretty specific as to what you're doing with that particular exercise."
//
// ADVISORY ON PURPOSE. These are deliberately NOT part of EXERCISE_EQUIPMENT, because a
// requirement is a gate: a client who photographed the pulldown tower but never thought
// to photograph the bar hanging on it would get an UNAVAILABLE row for an exercise they
// can plainly do. So an attachment shows on the tile and shapes the cue, and nothing
// here can ever make an exercise disappear.
//
// The first entry is what we suggest; the rest are fine too, and matter for the client
// who walks over and finds the wide bar already taken.
export const EXERCISE_ATTACHMENT = {
  "Lat Pulldown":                   ["wide-lat-bar", "narrow-lat-bar"],
  "Wide-Grip Lat Pulldown":         ["wide-lat-bar"],
  "Neutral-Grip Pulldown":          ["v-handle", "narrow-lat-bar"],
  "Incline Bench Lat Pulldown":     ["wide-lat-bar"],
  "Straight-Arm Pulldown":          ["straight-cable-bar", "rope-attachment"],
  "Straight-Arm Cable Pullover":    ["straight-cable-bar", "rope-attachment"],
  "Cable Pullover":                 ["rope-attachment", "straight-cable-bar"],
  "Seated Cable Row":               ["v-handle", "straight-cable-bar"],
  "Seated Wide-Grip Row":           ["wide-lat-bar", "straight-cable-bar"],
  "Single-Arm Cable Row":           ["single-handle"],
  "Cable Upright Row":              ["straight-cable-bar", "ez-cable-bar"],

  "Cable Flyes":                    ["single-handle"],
  "Cable Fly":                      ["single-handle"],
  "Low-to-High Cable Fly":          ["single-handle"],
  "Cable Crossover":                ["single-handle"],
  "Cable Crossover (high)":         ["single-handle"],
  "Cable Crossover (low)":          ["single-handle"],
  "Rear-Delt Cable Fly":            ["single-handle"],
  "Cable Lateral Raise":            ["single-handle"],
  "Leaning Cable Lateral Raise":    ["single-handle"],
  "Face Pull":                      ["rope-attachment"],

  "Cable Curl":                     ["ez-cable-bar", "straight-cable-bar"],
  "Cable Curl superset with Triceps Dips": ["ez-cable-bar"],
  "Rope Triceps Pushdown":          ["rope-attachment"],
  "Rope Pushdown":                  ["rope-attachment"],
  "Cable Tricep Pushdown":          ["straight-cable-bar", "rope-attachment"],
  "Overhead Cable Triceps Extension": ["rope-attachment"],
  "Overhead Cable Extension":       ["rope-attachment"],
  "Cable Overhead Extension":       ["rope-attachment"],
  "Concentration Curl superset with Rope Pushdown": ["rope-attachment"],
  "Spider Curl superset with Kickbacks": ["rope-attachment"],

  "Cable Abduction":                ["ankle-strap"],
  "Cable Hip Abduction":            ["ankle-strap"],
  "Cable Glute Kickback":           ["ankle-strap"],
  "Cable Kickback":                 ["ankle-strap"],

  "Kneeling Rope Crunch":           ["rope-attachment"],
  "Cable Crunches":                 ["rope-attachment"],
  "Cable Woodchop":                 ["rope-attachment", "single-handle"],
  "Cable Woodchopper":              ["rope-attachment", "single-handle"],
};

export const attachmentFor = (exercise) =>
  EXERCISE_ATTACHMENT[exercise] || EXERCISE_ATTACHMENT[normalizeExercise(exercise)] || [];

// What kind of thing an id is. Machines get the two-angle treatment; accessories are
// one photo, because a resistance band has no meaningful side view.
export const kindOf = (id) => (EQUIPMENT[baseId(id)] || {}).kind || "machine";
export const isAccessory = (id) => kindOf(id) !== "machine";

// Push-ups are push-ups. An exercise that needs nothing says so, rather than showing a
// blank tile that reads as a missing photo.
export const needsNoEquipment = (exercise) => {
  const need = equipmentFor(exercise);
  return need.length === 1 && need[0] === "bodyweight";
};

// What the tile shows for one exercise, against one gym.
//   { none: true }                     — no equipment required, say so
//   { equip, item, attachment, note }  — the thing to walk up to, their photo of it if
//                                        they have one, and the handle to clip on
export function tileFor(exercise, profile) {
  if (needsNoEquipment(exercise)) return { none: true, label: "No equipment needed" };
  const id = tileEquipment(exercise);
  if (!id) return { none: false, unknown: true };
  const items = (profile && profile.items) || [];
  const item = items.find((it) => baseId(it.id) === id) || null;
  const att = attachmentFor(exercise);
  const attItem = att.length ? items.find((it) => att.includes(baseId(it.id))) || null : null;
  return {
    none: false,
    equip: id,
    label: (EQUIPMENT[id] || {}).label || id,
    item,                                        // their own photo, if they took one
    attachment: att[0] || null,
    attachmentLabel: att.length ? (EQUIPMENT[att[0]] || {}).label || att[0] : null,
    attachmentItem: attItem,
  };
}

// ── What's still worth photographing ────────────────────────────────────────────
// Readiness is measured against their program, but Neal wants the sweep wider than
// that: "as much of the equipment they can take pictures of." This is the nudge list —
// common gym kit they haven't captured yet, program or no program. Ordered so the
// things that change a prescription come before the things that are merely nice.
const SWEEP = [
  "dumbbell-rack", "barbell", "adjustable-bench", "squat-rack", "cable-crossover",
  "lat-pulldown", "leg-press", "smith-machine",
  "wide-lat-bar", "narrow-lat-bar", "v-handle", "rope-attachment", "single-handle", "ankle-strap",
  "kettlebell", "medicine-ball", "resistance-band", "loop-band", "step-box",
  "suspension-trainer", "battle-rope", "climbing-rope", "ab-wheel", "trap-bar", "sled",
  "treadmill", "spin-bike", "air-bike", "rower", "elliptical", "stair-climber", "ski-erg",
];

export function sweepSuggestions(profile, limit = 6) {
  const have = ownedSet(profile);
  return SWEEP.filter((id) => !have.has(id)).slice(0, limit)
    .map((id) => ({ id, label: (EQUIPMENT[id] || {}).label || id, kind: kindOf(id) }));
}

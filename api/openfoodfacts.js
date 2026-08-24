// Barcode -> food facts. Proxies Open Food Facts (free, no API key) so we keep the
// same rule as every other outbound call: the app talks to US, we talk to vendors.
// Also lets us send the descriptive User-Agent their policy requires, and gives us
// one place to add caching later.
//
// Returns a NORMALIZED shape so the client never parses vendor JSON:
//   { ok:true, found:true, name, brand, barcode, nova, per100g:{...}, servingG, image }
//   { ok:true, found:false }                       <- valid barcode, not in the DB
// nova is null when the product has no NOVA classification — the client MUST render
// no processing badge in that case rather than guessing (see the spec's honesty rules).
import { authUser, applyCors, authConfigured } from "./_lib/proxy.js";

const OFF_UA = "BodyMorph/1.0 (https://www.bodymorph.info)";

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// "12 g" / "30g (1 bar)" -> 12 / 30. Null when it isn't parseable (e.g. "1 cup").
function servingGrams(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)\s*g/i);
  return m ? num(m[1]) : null;
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!authConfigured()) return res.status(500).json({ error: "Server missing SUPABASE_URL / SUPABASE_ANON_KEY" });
  const user = await authUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const raw = (req.body && req.body.barcode) || "";
  const barcode = String(raw).replace(/\D/g, "");           // digits only
  if (barcode.length < 6 || barcode.length > 14) return res.status(400).json({ error: "Bad barcode" });

  const fields = [
    "product_name", "brands", "nova_group", "nutriscore_grade", "ingredients_text",
    "nutriments", "serving_size", "image_front_small_url",
    // Diet flags: labels_tags carries certifications (gluten-free, non-GMO, organic);
    // allergens_tags/traces_tags carry declared allergens.
    "labels_tags", "allergens_tags", "traces_tags",
  ].join(",");

  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=${fields}`,
      { headers: { "User-Agent": OFF_UA, accept: "application/json" } }
    );
    if (!r.ok) return res.status(502).json({ error: `Food database error (${r.status})` });

    const data = await r.json();
    if (data.status !== 1 || !data.product) return res.status(200).json({ ok: true, found: false });

    const p = data.product;
    const n = p.nutriments || {};

    // NOVA only when it's a real 1-4 classification; anything else -> null (no badge).
    const novaRaw = parseInt(p.nova_group, 10);
    const nova = novaRaw >= 1 && novaRaw <= 4 ? novaRaw : null;

    // ── Diet flags + allergens ────────────────────────────────────────────────
    // SAFETY: only report "free of" when the product CARRIES that certification.
    // Empty allergen data means "not declared", NOT "free of" — a celiac or a peanut
    // allergy reading a wrong "free" claim is a real harm, so silence is the only
    // safe default, and the UI always tells people to check the package.
    const labels = (p.labels_tags || []).map((t) => String(t).toLowerCase());
    const rawContains = (p.allergens_tags || []).map((t) => String(t).toLowerCase());
    const rawTraces = (p.traces_tags || []).map((t) => String(t).toLowerCase());
    const has = (list, ...needles) => needles.some((n) => list.some((t) => t.includes(n)));

    // OFF tag -> plain English. Covers the FDA "Big 9" plus the EU additions.
    const ALLERGEN_NAMES = [
      ["peanut", "peanuts"], ["nuts", "tree nuts"], ["milk", "milk"], ["egg", "eggs"],
      ["gluten", "wheat/gluten"], ["soybean", "soy"], ["soy", "soy"], ["fish", "fish"],
      ["crustacean", "shellfish"], ["mollusc", "shellfish"], ["sesame", "sesame"],
      ["sulphite", "sulphites"], ["sulfite", "sulphites"], ["celery", "celery"],
      ["mustard", "mustard"], ["lupin", "lupin"],
    ];
    const toNames = (tags) => {
      const out = [];
      tags.forEach((t) => {
        const hit = ALLERGEN_NAMES.find(([k]) => t.includes(k));
        // Unknown tag: strip the "en:" prefix rather than dropping it silently —
        // an unrecognized allergen must still reach the user.
        const name = hit ? hit[1] : t.replace(/^[a-z]{2}:/, "").replace(/-/g, " ");
        if (name && !out.includes(name)) out.push(name);
      });
      return out;
    };

    const contains = toNames(rawContains);
    const mayContain = toNames(rawTraces).filter((n) => !contains.includes(n));

    const diet = {
      // "free" / "contains" / null(unknown) — the client renders nothing for null.
      gluten: has(labels, "gluten-free", "no-gluten") ? "free"
            : has(rawContains, "gluten") ? "contains" : null,
      gmo: has(labels, "non-gmo", "no-gmo", "sans-ogm") ? "free"
         : has(labels, "contains-gmo") ? "contains" : null,
      organic: has(labels, "organic", "bio") ? true : null,
      vegan: has(labels, "vegan") ? true : null,
      contains,          // declared ingredients
      mayContain,        // cross-contamination ("may contain") warnings
    };

    return res.status(200).json({
      ok: true,
      found: true,
      barcode,
      diet,
      name: (p.product_name || "").trim() || null,
      brand: (p.brands || "").split(",")[0].trim() || null,
      nova,
      nutriscore: p.nutriscore_grade || null,
      ingredients: (p.ingredients_text || "").trim() || null,
      servingG: servingGrams(p.serving_size),
      servingLabel: (p.serving_size || "").trim() || null,
      image: p.image_front_small_url || null,
      per100g: {
        cal: num(n["energy-kcal_100g"]),
        protein: num(n.proteins_100g),
        carbs: num(n.carbohydrates_100g),
        fats: num(n.fat_100g),
        sugars: num(n.sugars_100g),
        fiber: num(n.fiber_100g),
        sodium: num(n.sodium_100g),
      },
    });
  } catch (e) {
    console.error("openfoodfacts proxy:", e);
    return res.status(502).json({ error: e.message });
  }
}

# Barcode Scanner + Processed-Food Score — Build Spec

**Status:** spec only, nothing built yet.
**Origin:** Neal, 2026-08-24 — "scan the barcode and tell you how much processed food is in it… percentage of processed vs whole foods."

---

## The idea in one line

Point the phone at a barcode → BodyMorph fills in the food and its macros automatically → and tells the client **how processed that food is**, rolling up into a daily "**X% of today's calories came from ultra-processed food**" number that the client, the coach's weekly report, and the AI voice coach can all act on.

---

## Why this is worth building

1. **It's the fastest way to log packaged food.** Today the client types a search or photographs a plate. A barcode is one tap and it's exact — no estimating.
2. **Nobody else frames it this way.** Calorie apps count calories. "What percent of your diet is ultra-processed" is a *coaching* metric — it's the thing coaches actually nag clients about, and no mainstream tracker surfaces it.
3. **It costs nothing to run.** Open Food Facts is free, no API key, no per-scan charge (unlike the Claude photo scanner at roughly a cent a scan).
4. **It's not our opinion.** The processing score comes from the **NOVA classification** — an established food-science standard used in published nutrition research — computed from the product's real ingredient list. We're reporting a recognized measure, not inventing a "health score."

---

## How the processing score works

**NOVA** puts every food in one of four groups:

| Group | Meaning | Examples |
|---|---|---|
| **1** | Unprocessed / minimally processed | Fresh chicken, eggs, plain oats, fruit |
| **2** | Processed culinary ingredients | Olive oil, butter, sugar, salt |
| **3** | Processed foods | Canned beans, cheese, fresh bread |
| **4** | **Ultra-processed** | Soda, chips, packaged cookies, most cereal |

**Verified against the live API during this spec** (real results, US barcodes):

| Product | NOVA | kcal/100g |
|---|---|---|
| Coca-Cola | 4 | 42 |
| Honey Nut Cheerios | 4 | 393 |
| Oreo cookies | 4 | 471 |
| Tortilla chips | 3 | 536 |

**Client-facing wording:** never show a bare "NOVA 4" — that means nothing to a client. Show plain language:

- NOVA 1 → **Whole food** (green)
- NOVA 2 → **Basic ingredient** (green)
- NOVA 3 → **Processed** (amber)
- NOVA 4 → **Ultra-processed** (red)

**The daily number** is calorie-weighted, not item-counted — one soda shouldn't score the same as a whole dinner:

```
ultraProcessedPct = (calories from NOVA-4 items) / (calories from all items with a known NOVA) × 100
```

Items with no NOVA data are excluded from *both* sides of that fraction, and the UI says how much of the day is actually scored (see "Honesty rules").

---

## Data sources

| Source | Used for | Cost | Notes |
|---|---|---|---|
| **Open Food Facts** | Barcode → product, macros, NOVA group, ingredients | Free, no key | ~3M+ products, strong US coverage; crowd-sourced |
| **USDA FoodData Central** | Existing text search (unchanged) | Free (key) | No NOVA data — stays as-is |
| **Claude vision** | Existing meal-photo scanner (unchanged) | ~1¢/scan | No ingredient list, so no reliable NOVA — see below |

**Endpoint:**
```
GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json
    ?fields=product_name,brands,nova_group,nutriscore_grade,ingredients_text,nutriments,serving_size,image_front_small_url
```
Requires a descriptive `User-Agent` header (their policy): `BodyMorph/1.0 (bodymorph.info)`.

**Route it through our proxy** (`/api/openfoodfacts`), not direct from the app — consistent with the proxy-only rule established after the key-scraping incident, keeps the User-Agent correct, and lets us add caching later. No key to protect here, but consistency matters more than convenience.

---

## Honesty rules (non-negotiable)

These exist because a wrong number here damages trust in the whole app:

1. **Never invent a NOVA score.** If Open Food Facts has no `nova_group` for that barcode, the item logs normally with **no processing badge**. Silence beats a guess.
2. **The daily percentage states its own coverage.** "62% ultra-processed *(based on 1,450 of 2,100 logged calories)*." A percentage computed from a third of the day, presented as if it covered the day, is a lie.
3. **The photo scanner does not get a NOVA score.** A photo of a plate has no ingredient list. Attaching a processing score to an AI guess about a home-cooked meal would be fabricated precision. (Optional future: if the photo is clearly of a *package*, offer "scan its barcode instead for exact data.")
4. **The client can correct it.** Crowd-sourced product names are often messy (a real lookup returned "Gmills hny nut cheerios sweetene"). The name field stays editable before saving — always.
5. **No moralizing.** The app reports the number and its trend. It does not say "bad," scold, or assign a grade to the person. NOVA 4 is a fact about a food, not a verdict on a client.

---

## Build phases

### Phase 1 — Scan and log (the core)

**Plugin:** `@capacitor-mlkit/barcode-scanning` v8.1.0 — verified compatible with the project's Capacitor 8. On-device scanning (Google ML Kit), no image leaves the phone.

- New **"Scan barcode"** button in `FoodLogger`, alongside the existing camera and search buttons.
- Native camera scanner opens → detects EAN-13 / UPC-A / EAN-8 → returns the number.
- Lookup through the proxy → fill the item: name, macros scaled to serving size, and `nova`.
- **Serving-size handling matters:** Open Food Facts gives nutrients per 100g. Use the product's `serving_size` when present, and always show an editable quantity — clients eat portions, not 100g units.
- Item saves into the existing `foodLog` shape with one added field:
  ```js
  { food, cal, protein, carbs, fats, logged, nova, brand, barcode }
  ```
  Because items are already flat objects, this rides through the existing sync, coach reads, and totals untouched — **no migration needed**.
- **Not found?** ~Some barcodes won't be in the database. Fall back gracefully: "Not in the food database — search by name instead?" and drop them into the existing USDA search with the field focused.
- **Offline / no signal:** scanning is on-device but lookup needs network. Fail with a clear message, never a spinner that hangs.

**iOS requirement:** `NSCameraUsageDescription` already exists in Info.plist (verified) — no new permission prompt to add.

### Phase 2 — Show the score

- **Per item:** a small colored badge in the food list — "Ultra-processed" / "Processed" / "Whole food."
- **Daily, in Nutrition:** one line under the macro totals — "**32% of today's calories were ultra-processed** (based on 1,450 of 2,100 logged cal)."
- **Progress Report:** a weekly trend line, using the existing `TrendLineChart` (`lowerBetter` — down is good, same as resting heart rate).

### Phase 3 — Coach + AI integration

- **Coach's Weekly Report:** include the week's average in `buildReportData`, so the Sonnet-generated briefing can act on it ("her ultra-processed share dropped from 58% to 34% — that's the story of her month").
- **Voice coach context:** add today's percentage to `companionData` so the coach can reference it naturally when the client asks what to eat.
- **Coach dashboard client detail:** a tile alongside the existing watch metrics.

---

## What could go wrong (and the honest answer)

| Risk | Reality | Mitigation |
|---|---|---|
| Product missing from database | Real, especially store brands and regional items | Graceful fallback to USDA search; the app never dead-ends |
| Messy crowd-sourced names | Confirmed in live testing | Name field editable before saving |
| NOVA missing on a found product | Happens | Log the food normally, just no badge |
| Client games the number | Possible | It's a coaching signal, not a score to win; no rewards attached to it |
| Restaurant / home-cooked meals | Barcodes only cover packaged food | Be explicit that the percentage covers *packaged* food logged; never imply whole-diet coverage |

---

## Effort estimate

| Phase | Scope | Rough effort |
|---|---|---|
| 1 | Plugin install, proxy endpoint, scan → log flow, fallbacks | Half a session |
| 2 | Badges, daily line, trend chart | Half a session |
| 3 | Coach report + voice coach context | Short session |

Phase 1 alone is shippable and useful on its own — faster packaged-food logging, with the processing data quietly accumulating in the background for phases 2 and 3 to surface later.

---

## Open questions for Neal

1. **Ship Phase 1 alone first** (scanning = faster logging), or hold until the percentage display in Phase 2 is ready too?
2. **Where should the daily number live** — Nutrition screen only, or also on the Home dashboard next to the macros?
3. **Is this a coach-visible metric from day one**, or client-only until you've watched it on your own food for a week?

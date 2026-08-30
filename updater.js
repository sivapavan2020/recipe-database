/* ============================================================
   recipe-database / updater.js
   ------------------------------------------------------------
   Builds mealsDB.json for the health app. Every candidate recipe is
   passed through the CLINICAL VALIDATION GATE (verifyMacros.js) BEFORE
   it is written — so harmful recipes never reach the published file.

   Sources, in order:
     1) sources/meals.seed.json — the app's 58 clinically-audited meals (always).
     2) Edamam Recipe Search API — OPTIONAL, only if EDAMAM_APP_ID + EDAMAM_APP_KEY
        env vars are set (store them as GitHub Secrets). Pulled recipes are normalized
        to our schema, then MUST pass the same gate. This honors the STRICT SOURCING
        RULE: commercial-aggregator data is never trusted raw — it is intercepted and
        validated against WHO/EFSA/NHS/USDA/AHA limits before it can be saved.

   Run:  node updater.js
   (In CI, your GitHub Action runs this and commits the new mealsDB.json.)
   ============================================================ */
const fs = require('node:fs');
const { verifyClinicalMacros } = require('./verifyMacros.js');   // the gate (same file the app uses)

// Profile: 'global' = WHO/EFSA/NHS/USDA baseline (sat-fat ≤10%E → 7.33 g/main meal,
// sodium 667 mg, sugar 8.33 g). 'cardio' = strict AHA Heart-Check / NIH-DASH (4.33 g, 500 mg).
const PROFILE = process.env.VALIDATION_PROFILE === 'cardio' ? 'cardio' : 'global';

// Cuisines to pull from Edamam (diverse world coverage). Edamam's own cuisine taxonomy.
const EDAMAM_CUISINES = ['indian','asian','mediterranean','american','mexican','middle eastern','japanese','chinese','french','italian'];
const EDAMAM_PER_CUISINE = 20;   // recipes requested per cuisine per run

// ------------------------------------------------------------
// 1) SEED SOURCE — always included.
// ------------------------------------------------------------
const seed = JSON.parse(fs.readFileSync('./sources/meals.seed.json', 'utf8'));

// ------------------------------------------------------------
// 2) EDAMAM SOURCE — optional; only runs if credentials are present.
//    Normalizes each hit to our schema so the gate + app can read it identically.
// ------------------------------------------------------------
const EDAMAM_ID = (process.env.EDAMAM_APP_ID || '').trim();
const EDAMAM_KEY = (process.env.EDAMAM_APP_KEY || '').trim();

// Map an Edamam total-nutrient recipe → a PER-SERVING meal in our schema.
// Edamam gives whole-recipe totals + `yield` (servings); we divide to one serving.
function normalizeEdamamRecipe(rec, cuisineLabel){
  const r = rec && rec.recipe; if(!r) return null;
  const servings = (r.yield && r.yield > 0) ? r.yield : 1;
  const N = r.totalNutrients || {};
  const per = key => (N[key] && typeof N[key].quantity === 'number') ? N[key].quantity / servings : null;
  const kcal = (typeof r.calories === 'number') ? r.calories / servings : per('ENERC_KCAL');
  if(kcal == null) return null;                                  // no calories → can't scale, skip
  const cuisine = (r.cuisineType && r.cuisineType.length ? r.cuisineType : [cuisineLabel])
    .map(c => String(c).replace(/\b\w/g, ch => ch.toUpperCase()));
  const mealType = (r.mealType && r.mealType[0]) || '';
  const slot = /break/i.test(mealType) ? 'breakfast'
             : /lunch/i.test(mealType) ? 'lunch'
             : /snack|teatime/i.test(mealType) ? 'snack' : 'dinner';
  const health = (r.healthLabels || []);
  const dietType = health.includes('Vegan') ? ['Vegan','Vegetarian']
                 : health.includes('Vegetarian') ? ['Vegetarian'] : ['Non-Veg'];
  return {
    name: r.label,
    source: 'Edamam',
    cuisine,
    slot,
    dietType,
    proteinCategory: '',                                          // unknown from Edamam; meat scan still runs on name/ingredients
    healthFocus: ['Weight Loss'],
    baseMacros: {
      calories: Math.round(kcal),
      protein: Math.round(per('PROCNT') || 0),
      carbs: Math.round(per('CHOCDF') || 0),
      fat: Math.round(per('FAT') || 0),
    },
    // the exact keys the gate reads (per serving), so validation is real, not guessed
    saturatedFat: round1(per('FASAT')),
    addedSugar: round1(per('SUGAR.added')),
    sodium: per('NA') != null ? Math.round(per('NA')) : null,     // mg
    transFat: round1(per('FATRN')),
    ingredients: (r.ingredients || []).map(i => ({ item: i.food || i.text, grams: i.weight ? Math.round(i.weight / servings) : null })),
  };
}
const round1 = v => (v == null ? null : Math.round(v * 10) / 10);

async function fetchFromEdamam(){
  if(!EDAMAM_ID || !EDAMAM_KEY){
    console.log('ℹ️  Edamam credentials not set (EDAMAM_APP_ID / EDAMAM_APP_KEY) — skipping API pull, seed only.');
    return [];
  }
  const out = [];
  for(const cuisine of EDAMAM_CUISINES){
    const url = `https://api.edamam.com/api/recipes/v2?type=public`
      + `&app_id=${encodeURIComponent(EDAMAM_ID)}&app_key=${encodeURIComponent(EDAMAM_KEY)}`
      + `&cuisineType=${encodeURIComponent(cuisine)}&health=alcohol-free`
      + `&random=true`;
    try{
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if(!res.ok){ console.warn(`  Edamam ${cuisine}: HTTP ${res.status} — skipped`); continue; }
      const data = await res.json();
      const hits = (data.hits || []).slice(0, EDAMAM_PER_CUISINE);
      hits.forEach(h => { const m = normalizeEdamamRecipe(h, cuisine); if(m) out.push(m); });
      console.log(`  Edamam ${cuisine}: normalized ${hits.length} recipes`);
    }catch(e){ console.warn(`  Edamam ${cuisine}: ${e.message} — skipped`); }
  }
  return out;
}

// ------------------------------------------------------------
// MAIN — assemble sources, gate every meal, reshape, write.
// ------------------------------------------------------------
async function main(){
  const apiMeals = await fetchFromEdamam();
  const RAW_MEALS = seed.meals.concat(apiMeals);
  console.log(`Sources: ${seed.meals.length} seed + ${apiMeals.length} Edamam = ${RAW_MEALS.length} candidates.`);

  // VALIDATION GATE — reject restricted meat or any macro over the per-meal cap.
  const accepted = [], rejected = [];
  for(const meal of RAW_MEALS){
    const verdict = verifyClinicalMacros(meal, { profile: PROFILE, mealsPerDay: 3 });
    if(verdict.pass) accepted.push(meal);
    else { rejected.push({ name: meal.name, reasons: verdict.violations.map(v => v.code) });
      console.warn(`✗ REJECTED "${meal.name}": ${verdict.violations.map(v => v.message).join(' | ')}`); }
  }

  // RESHAPE — normalize to the published shape (tolerate seed's baseMacros OR raw macros).
  const meals = accepted.map(m => {
    const bm = m.baseMacros || m.macros || {};
    return {
      name: m.name,
      source: m.source || 'seed',
      cuisine: m.cuisine,
      proteinCategory: m.proteinCategory || null,
      slot: m.slot || null,
      dietType: m.dietType || null,
      healthFocus: m.healthFocus || [],
      baseMacros: {
        calories: bm.calories != null ? bm.calories : (bm.baseCalories != null ? bm.baseCalories : null),
        protein: bm.protein != null ? bm.protein : null,
        carbs: bm.carbs != null ? bm.carbs : null,
        fat: bm.fat != null ? bm.fat : null,
      },
      saturatedFat: m.saturatedFat ?? null,
      addedSugar: m.addedSugar ?? null,
      sodium: m.sodium ?? null,
      transFat: m.transFat ?? null,
      ingredients: m.ingredients || [],
    };
  });

  // Dedup by name (seed wins over API on a clash) so repeated runs don't bloat the file.
  const seen = new Set(); const deduped = [];
  meals.forEach(m => { const k = String(m.name || '').trim().toLowerCase(); if(k && !seen.has(k)){ seen.add(k); deduped.push(m); } });

  const output = { generatedAt: new Date().toISOString(), count: deduped.length, meals: deduped };
  fs.writeFileSync('mealsDB.json', JSON.stringify(output, null, 2));

  console.log(`✓ Wrote mealsDB.json — ${deduped.length} meals passed the clinical gate (${PROFILE} profile), ${rejected.length} rejected.`);
  if(rejected.length) console.log('  Rejected:', rejected.slice(0, 20).map(r => `${r.name} (${r.reasons.join(',')})`).join('; ') + (rejected.length > 20 ? ' …' : ''));
}

main().catch(e => { console.error('updater failed:', e); process.exit(1); });

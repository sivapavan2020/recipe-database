/* ============================================================
   CLINICAL MACRO VALIDATION — the curation gate for mealsDB.
   ------------------------------------------------------------
   PURPOSE: never trust raw meals from user-submitted / commercial
   aggregators (Edamam, Nutritionix, community APIs). Every candidate
   recipe MUST pass verifyClinicalMacros() before it can be written to
   the offline database. Thresholds are derived STRICTLY from global,
   evidence-based public-health consensus — no vibes, no vendor numbers:
       • WHO      — sugars, sodium, trans fat, saturated fat (≤10%E)
       • EFSA     — EU dietary reference values
       • NHS (UK) & Health Canada — national guidance
       • USDA MyPlate / NIH / AHA — US guidance (AHA = stricter cardiac profile)

   DESIGN:
   - Daily ceilings are the source of truth; per-meal caps are the daily
     ceiling × the meal's share of the day (standard 3 main meals + snack).
   - Two profiles: 'global' (WHO/EFSA/NHS/USDA ≤10%E sat-fat, the default)
     and 'cardio' (AHA 5–6%E — for high-LDL users). Everything else is identical.
   - HARD exclusion of beef / pork / ribs (and their derivatives) by both
     proteinCategory and an ingredient-name scan — non-negotiable, profile-independent.
   - "Cannot verify" ≠ "violation": a missing nutrient is a WARNING; in
     strict mode it also fails (a clinical pipeline shouldn't save unaudited data).

   Node (curation build):   const { verifyClinicalMacros, ingestRecipes } = require('./verifyMacros.js')
   Browser (runtime gate):  window.MacroVerifier.verifyClinicalMacros(recipe)
   ============================================================ */
(function(root, factory){
  const api = factory();
  if(typeof module==='object' && module.exports) module.exports = api;   // Node curation pipeline
  if(root) root.MacroVerifier = api;                                     // browser runtime
})(typeof window!=='undefined'?window:null, function(){

  // ---- DAILY reference ceilings (global consensus, at a 2,000 kcal reference day) ----
  //  Each carries the authority and the arithmetic so the number is auditable.
  const DAILY = {
    // Saturated fat — WHO/EFSA/NHS/USDA-DGA: ≤10% of energy. 10% of 2,000 kcal = 200 kcal ÷ 9 = ~22 g.
    saturatedFat_g: { global: 22, cardio: 13, note: 'WHO/EFSA/NHS/USDA ≤10%E (=22 g @2000 kcal); AHA cardiac 5–6%E ≈13 g' },
    // Added / free sugars — WHO conditional guideline <5% of energy. 5% of 2,000 = 100 kcal ÷ 4 = 25 g.
    addedSugar_g:   { global: 25, cardio: 25, note: 'WHO free sugars <5%E (=25 g); AHA men ≤36 g / women ≤25 g' },
    // Sodium — WHO & EFSA: <2,000 mg/day (=5 g salt). NHS 2,400 mg; AHA ideal 1,500 mg.
    sodium_mg:      { global: 2000, cardio: 1500, note: 'WHO/EFSA <2,000 mg (NHS 2,400; AHA ideal 1,500)' },
    // Trans fat — WHO REPLACE: <1% of energy (~2 g), true target 0 g.
    transFat_g:     { global: 2, cardio: 2, note: 'WHO <1%E (~2 g); target 0 g' },
  };

  // ---- Each meal's share of the daily budget (standard 3 main meals + a smaller snack) ----
  //  main meals = 1/3 of the day each; a snack gets half a main-meal share.
  const MEAL_SHARE = { breakfast: 1/3, lunch: 1/3, dinner: 1/3, snack: 1/6, default: 1/3 };

  // ---- HARD exclusions: restricted red meats + common derivatives (profile-independent) ----
  const BLOCKED_CATEGORIES = ['beef','pork','ribs','veal'];
  const BLOCKED_INGREDIENT_TERMS = ['beef','pork','ribs','bacon','ham','prosciutto','pancetta',
    'salami','pepperoni','chorizo','lardon','lard','veal','spare rib','pulled pork','gammon'];

  // ---- flexible nutrient readers — tolerate Edamam / Nutritionix / our own key names ----
  const num = v => (v==null||v==='' || isNaN(+v)) ? null : +v;
  function pick(recipe, keys){ for(const k of keys){ const v=num(recipe && recipe[k]); if(v!=null) return v; }
    // also look inside a nested nutrients / macros object
    const nest = (recipe && (recipe.nutrients||recipe.macros)) || null;
    if(nest){ for(const k of keys){ const v=num(nest[k]); if(v!=null) return v; } }
    return null; }
  const getSatFat   = r => pick(r, ['saturatedFat','satFat','satf','FASAT','nf_saturated_fat','saturated_fat_g']);
  const getAddSugar = r => pick(r, ['addedSugar','asug','addedSugars','SUGAR.added','nf_added_sugars','added_sugar_g']);
  const getSodium   = r => pick(r, ['sodium','sod','NA','nf_sodium','sodium_mg']);           // mg
  const getTransFat = r => pick(r, ['transFat','tfat','FATRN','nf_trans_fatty_acid','trans_fat_g']);

  function mealShare(recipe, mealsPerDay){
    if(recipe && MEAL_SHARE[recipe.slot]!=null) return MEAL_SHARE[recipe.slot];
    return 1/(mealsPerDay||3);
  }
  // Escape + match blocked terms on WORD BOUNDARIES only, so "collard" doesn't match "lard",
  // "graham" doesn't match "ham", etc. Multi-word terms ("spare rib") match as phrases.
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const TERM_RE = new RegExp('\\b(?:'+BLOCKED_INGREDIENT_TERMS.map(esc).join('|')+')\\b','i');
  function collectMeatFlags(recipe){
    const hits=[];
    const cat=(recipe && recipe.proteinCategory||'').toString().toLowerCase().trim();
    if(BLOCKED_CATEGORIES.includes(cat)) hits.push('proteinCategory="'+recipe.proteinCategory+'"');
    // ingredients may be missing, a string, or malformed from an API — coerce to a safe array first
    const ingList = Array.isArray(recipe && recipe.ingredients) ? recipe.ingredients
      : (recipe && typeof recipe.ingredients === 'string' ? [recipe.ingredients] : []);
    const parts = [
      (recipe && recipe.name)||'',
      ...ingList.map(i=> typeof i==='string'?i:(i&&i.item)||''),
    ];
    parts.forEach(p=>{ const m=String(p).match(TERM_RE); if(m) hits.push('"'+p+'" contains restricted term "'+m[0].toLowerCase()+'"'); });
    return Array.from(new Set(hits));
  }

  // ============================================================
  //  verifyClinicalMacros(recipe, opts)
  //   opts: { profile:'global'|'cardio' (default 'global'),
  //           mealsPerDay:3, strict:false }  // strict → missing nutrient data also fails
  //   returns { pass, violations:[{code,message,value,limit}], warnings:[], thresholds, share }
  // ============================================================
  function verifyClinicalMacros(recipe, opts){
    const o = opts||{}; const profile = o.profile==='cardio'?'cardio':'global';
    const strict = !!o.strict; const mealsPerDay = o.mealsPerDay||3;
    const share = mealShare(recipe, mealsPerDay);
    // per-meal caps = daily ceiling × this meal's share of the day
    const cap = key => +(DAILY[key][profile] * share).toFixed(key==='sodium_mg'?0:2);
    const thresholds = {
      saturatedFat_g: cap('saturatedFat_g'), addedSugar_g: cap('addedSugar_g'),
      sodium_mg: cap('sodium_mg'), transFat_g: cap('transFat_g'), profile, share:+share.toFixed(3),
    };
    const violations=[], warnings=[];

    // 1) HARD exclusion — restricted meats (independent of profile / data completeness)
    const meat = collectMeatFlags(recipe);
    if(meat.length) violations.push({ code:'RESTRICTED_MEAT',
      message:'Contains restricted meat (beef/pork/ribs): '+meat.join('; '), value:meat, limit:'not allowed' });

    // 2) numeric ceilings — each fails only when the value is present AND over the cap
    const checks=[
      ['SATURATED_FAT', getSatFat(recipe),   thresholds.saturatedFat_g, 'g', 'Saturated fat'],
      ['ADDED_SUGAR',   getAddSugar(recipe), thresholds.addedSugar_g,   'g', 'Added sugar'],
      ['SODIUM',        getSodium(recipe),   thresholds.sodium_mg,      'mg','Sodium'],
      ['TRANS_FAT',     getTransFat(recipe), thresholds.transFat_g,     'g', 'Trans fat'],
    ];
    for(const [code,val,limit,unit,label] of checks){
      if(val==null){ warnings.push({ code:code+'_MISSING', message:label+' not provided — cannot verify.' });
        if(strict) violations.push({ code:code+'_MISSING', message:label+' missing (strict mode rejects unaudited data).', value:null, limit });
        continue; }
      if(val > limit + 1e-9) violations.push({ code, message:`${label} ${val} ${unit} exceeds the per-meal cap of ${limit} ${unit}.`, value:val, limit });
    }

    return { pass: violations.length===0, violations, warnings, thresholds, share:thresholds.share, profile };
  }

  // ============================================================
  //  ingestRecipes(list, opts) — the pipeline entry point. Runs the gate over a
  //  batch (e.g., a page of Edamam results) and returns what may be saved vs rejected.
  // ============================================================
  function ingestRecipes(list, opts){
    const accepted=[], rejected=[];
    (list||[]).forEach(r=>{ const v=verifyClinicalMacros(r, opts);
      if(v.pass) accepted.push({ recipe:r, audit:v }); else rejected.push({ recipe:r, audit:v }); });
    return { accepted, rejected, total:(list||[]).length,
      summary:`${accepted.length}/${(list||[]).length} passed clinical validation` };
  }

  return { verifyClinicalMacros, ingestRecipes, DAILY, MEAL_SHARE,
    BLOCKED_CATEGORIES, BLOCKED_INGREDIENT_TERMS };
});

# recipe-database — clinically-validated meals for the health app

`mealsDB.json` is **generated**, never hand-edited. Every recipe passes a clinical
validation gate before it is published, so the app only ever downloads meals that
meet global, evidence-based standards.

## How it works
```
sources/meals.seed.json → verifyClinicalMacros() → mealsDB.json → app downloads on "Sync"
   (58 seed recipes)          (the gate)            (only PASSES)
```

- **`sources/meals.seed.json`** — the SOURCE of truth: 58 clinically-audited recipes
  exported from the app, spanning 21 world cuisines. Add more here (or plug an API into
  `updater.js`) to grow the database.
- **`verifyMacros.js`** — the validation engine. Same file the app bundles, so the
  phone re-checks on sync as a second line of defence.
- **`updater.js`** — reads the seed source, runs each recipe through the gate, and writes
  only the ones that pass to `mealsDB.json`. Rejections are logged. (Current seed: 58/58 pass.)

## The gate — `verifyClinicalMacros(recipe, opts)`
Rejects any recipe that violates institutional per-meal limits or contains restricted meat.

**Thresholds** = daily ceiling ÷ standard 3-meal day (main meal = 1/3, snack = 1/6):

| Metric | Daily ceiling | Per main meal | Authority |
|---|---|---|---|
| Saturated fat (`cardio`) | 13 g (5–6 %E) | **4.33 g** | AHA Heart-Check |
| Saturated fat (`global`) | 22 g (≤10 %E) | 7.33 g | WHO / EFSA / NHS / USDA |
| Added sugar | 25 g (<5 %E) | **8.33 g** | WHO |
| Sodium (`cardio`) | 1,500 mg | **500 mg** | AHA ideal / NIH-DASH |
| Sodium (`global`) | 2,000 mg | 667 mg | WHO / EFSA |
| Trans fat | 2 g (<1 %E) | 0.67 g | WHO REPLACE |
| **Restricted meat** | — | **reject** | beef / pork / ribs + hidden (bacon, ham, lard…) |

`opts`: `{ profile:'cardio'|'global' (default cardio in updater), mealsPerDay:3, strict:false }`.
Returns `{ pass, violations[], warnings[], thresholds }`. Missing macros → warning
(and a hard fail in `strict` mode, so unaudited data is never saved).

## Optional: auto-pull diverse cuisines from Edamam
`updater.js` will additionally pull recipes from the Edamam Recipe Search API **only if**
credentials are present — otherwise it publishes the seed alone. Pulled recipes are
normalized to our schema and MUST pass the same clinical gate before saving.

1. Get free keys at https://developer.edamam.com (Recipe Search API).
2. Repo → **Settings ▸ Secrets and variables ▸ Actions ▸ New repository secret**:
   - `EDAMAM_APP_ID`
   - `EDAMAM_APP_KEY`
3. The GitHub Action (`.github/workflows/update-db.yml`) runs weekly + on demand and
   commits the rebuilt `mealsDB.json`. Set `VALIDATION_PROFILE=cardio` for strict caps.

Locally: `EDAMAM_APP_ID=… EDAMAM_APP_KEY=… node updater.js`

## Sourcing rule
Do **not** trust raw commercial-aggregator data (Edamam/Nutritionix/community APIs).
Whatever the source, it MUST pass `verifyClinicalMacros()` before being written — that
is the only path into `mealsDB.json`.

## Run locally
```bash
node updater.js        # regenerates mealsDB.json, logs any rejections
```

## GitHub Action
The workflow runs `node updater.js` and commits the regenerated `mealsDB.json`.
The app's **More → Recipe database → Sync now** downloads the published file (HTTPS,
cache-busted) and appends new meals to what's already on the device — sync only adds,
never removes, and re-runs the same gate so nothing harmful is stored.

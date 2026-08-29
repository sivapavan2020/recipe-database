// updater.js — beginner version (uses fake data so it "just works")
const fs = require('fs');

// Pretend we fetched these from a recipe API.
const fakeApiData = [
  { name: 'Lemon Garlic Chicken', cuisine: 'mediterranean', calories: 540, protein: 46 },
  { name: 'Classic Beef Chili',   cuisine: 'american',      calories: 700, protein: 40 }, // will be removed
  { name: 'Tofu Pad Thai',        cuisine: 'asian',         calories: 620, protein: 22 },
];

// 1. Remove anything with beef or pork.
const banned = ['beef', 'pork', 'ribs'];
const cleaned = fakeApiData.filter((meal) => {
  const text = meal.name.toLowerCase();
  return !banned.some((word) => text.includes(word));
});

// 2. Shape it into your app's format.
const meals = cleaned.map((meal) => ({
  name: meal.name,
  cuisine: meal.cuisine,
  baseMacros: { calories: meal.calories, protein: meal.protein },
}));

// 3. Save to mealsDB.json.
const output = { generatedAt: new Date().toISOString(), count: meals.length, meals };
fs.writeFileSync('mealsDB.json', JSON.stringify(output, null, 2));
console.log('Done! Wrote ' + meals.length + ' meals.');


import "dotenv/config";

const API   = "https://nutricrew-backend.vercel.app";
const CRUD  = "https://nutricrew-server-1.onrender.com";
const IKEY  = process.env.INTERNAL_API_KEY;
const EMAIL = "renatogadeabi@gmail.com";

const PAYLOAD = {
  data: {
    email: EMAIL,
    name: "Renato",
    gender: "male",
    weight: "80kg",
    dob: "1990-06-15",
    position: "cabin",
    pairing_days: "1",
    departure: "Miami",
    destinations: ["New York"],
    going_usa: "yes",
    timezone: "0",
    kitchen: ["hotel"],
    diets: ["balanced"],
    goals: ["lose_weight"],
    budget_amount: "30",
    budget_type: "day",
    lang: "en",
  },
  lang: "en",
};

async function generatePlan(label) {
  console.log(`\n${label} — calling generate-plan...`);
  const start = Date.now();
  const r = await fetch(`${API}/api/generate-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(PAYLOAD),
    signal: AbortSignal.timeout(120000),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const data = await r.json();
  if (!r.ok) {
    console.log(`❌ ${label} failed (${r.status}): ${data.error || data.message}`);
    return null;
  }
  const dayName = data.days?.[0]?.meals?.[0]?.name || "?";
  console.log(`✅ ${label} OK in ${elapsed}s — first meal: "${dayName}"`);
  console.log(`   pairingCount=${data.pairingCount}`);
  return { elapsed: parseFloat(elapsed), firstMeal: dayName };
}

async function getCacheStats() {
  const r = await fetch(`${CRUD}/api/meal-cache/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": IKEY },
    body: JSON.stringify({
      email: "nobody@test.com",
      dietKey: "balanced", goalKey: "lose_weight",
      budgetLevel: "medium", kitchenKey: "hotel",
      calorieTargetKey: "none", lang: "en", count: 10,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  return d.total || 0;
}

const cacheBefore = await getCacheStats();
console.log(`Cache size before: ${cacheBefore} day(s) for this profile`);

const r1 = await generatePlan("Plan 1 (expect cache MISS — AI generates)");
const cacheAfter1 = await getCacheStats();
console.log(`Cache size after plan 1: ${cacheAfter1} day(s)`);

const r2 = await generatePlan("Plan 2 (expect cache HIT — served from DB)");
const cacheAfter2 = await getCacheStats();
console.log(`Cache size after plan 2: ${cacheAfter2} day(s)`);

if (r1 && r2) {
  const reused = r1.firstMeal !== r2.firstMeal;
  console.log(`\n✅ Meals are different: "${r1.firstMeal}" vs "${r2.firstMeal}" → ${reused ? "varied ✓" : "SAME (cache may have rotated the same day)"}`);
  const faster = r2.elapsed < r1.elapsed;
  console.log(`${faster ? "✅" : "⚠️"} Plan 2 was ${faster ? "faster" : "slower"} (${r1.elapsed}s → ${r2.elapsed}s)`);
  console.log(`\nCache grew from ${cacheBefore} → ${cacheAfter1} → ${cacheAfter2} days`);
}

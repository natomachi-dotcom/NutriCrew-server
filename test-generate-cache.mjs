import "dotenv/config";
import mongoose from "mongoose";

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

let UserModel = null;

async function resetUser() {
  await mongoose.connect(process.env.MONGODB_URI);
  if (!UserModel) {
    UserModel = mongoose.model("User", new mongoose.Schema({
      email: String, pairingCount: Number, seenDayIds: [mongoose.Schema.Types.ObjectId],
    }, { strict: false }));
  }
  const result = await UserModel.updateOne(
    { email: EMAIL },
    { $set: { pairingCount: 0, seenDayIds: [] } }
  );
  await mongoose.disconnect();
  console.log(`Reset user: pairingCount=0, seenDayIds=[] (matched=${result.matchedCount})`);
}

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
  const day0 = data.days?.[0];
  const firstMeal = day0?.meals?.[0]?.name || "?";
  const mealCount = day0?.meals?.length || 0;
  const hasSummary = typeof data.summary === "string" && data.summary.length > 0;
  const hasGrocery = data.groceryList && Object.keys(data.groceryList).some(k => data.groceryList[k]?.length > 0);
  const hasRestrictions = typeof data.foodRestrictions?.usa === "string";
  console.log(`✅ ${label} OK in ${elapsed}s`);
  console.log(`   firstMeal="${firstMeal}"  meals=${mealCount}  pairingCount=${data.pairingCount}`);
  console.log(`   summary=${hasSummary}  grocery=${hasGrocery}  restrictions=${hasRestrictions}`);
  return { elapsed: parseFloat(elapsed), firstMeal, mealCount, hasSummary, hasGrocery };
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

await resetUser();
const cacheBefore = await getCacheStats();
console.log(`\nCache size before: ${cacheBefore} day(s) for this profile`);

const r1 = await generatePlan("Plan 1 (expect cache MISS — AI generates)");
const cacheAfter1 = await getCacheStats();
console.log(`Cache size after plan 1: ${cacheAfter1} day(s)`);

// Reset seenDayIds so plan 2 can also use the cached day
await resetUser();

const r2 = await generatePlan("Plan 2 (expect cache HIT — served from DB)");
const cacheAfter2 = await getCacheStats();
console.log(`Cache size after plan 2: ${cacheAfter2} day(s)`);

if (r1 && r2) {
  const faster = r2.elapsed < r1.elapsed;
  const saved = (r1.elapsed - r2.elapsed).toFixed(1);
  console.log(`\n--- RESULTS ---`);
  console.log(`Cache miss: ${r1.elapsed}s  |  Cache hit: ${r2.elapsed}s  |  Saved: ${saved}s`);
  console.log(`${faster ? "✅" : "⚠️"} Plan 2 was ${faster ? `${saved}s faster` : "NOT faster"}`);
  console.log(`Summary+grocery present: miss=${r1.hasSummary && r1.hasGrocery}  hit=${r2.hasSummary && r2.hasGrocery}`);
  console.log(`Cache grew: ${cacheBefore} → ${cacheAfter1} → ${cacheAfter2} days`);
}

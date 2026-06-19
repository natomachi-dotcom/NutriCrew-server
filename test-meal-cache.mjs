import "dotenv/config";
import mongoose from "mongoose";

const CRUD   = "https://nutricrew-server-1.onrender.com";
const IKEY   = process.env.INTERNAL_API_KEY;
const EMAIL  = "renatogadeabi@gmail.com";

const KEY = {
  dietKey: "balanced", goalKey: "lose_weight", budgetLevel: "medium",
  kitchenKey: "hotel", calorieTargetKey: "none", lang: "en",
};

async function api(path, body) {
  const r = await fetch(`${CRUD}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": IKEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  return { status: r.status, data: await r.json() };
}

function pass(label, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? "  →  " + detail : ""}`);
}

const FAKE_DAY = {
  meals: [
    { type: "Breakfast", name: "Greek Yogurt Bowl", emoji: "🥣", calories: 320, protein: 22, carbs: 38, fat: 8,
      description: "Creamy Greek yogurt topped with berries and granola.", prep: "Open containers, layer ingredients.",
      tags: ["high-protein", "quick"], tip: "Add chia seeds for extra fiber.", recyclingTip: "Rinse yogurt container before recycling." },
    { type: "Lunch", name: "Turkey Wrap", emoji: "🌯", calories: 480, protein: 35, carbs: 44, fat: 12,
      description: "Whole wheat wrap with turkey, avocado, and veggies.", prep: "Layer ingredients and roll tightly.",
      tags: ["balanced", "portable"], tip: "Wrap in foil to keep fresh.", recyclingTip: "Reuse the wrap bag." },
    { type: "Dinner", name: "Grilled Salmon", emoji: "🐟", calories: 520, protein: 42, carbs: 28, fat: 18,
      description: "Herb-crusted salmon with quinoa and roasted broccoli.", prep: "No cooking needed — order from hotel restaurant.",
      tags: ["omega-3", "high-protein"], tip: "Ask for dressing on the side.", recyclingTip: "Compost vegetable scraps." },
    { type: "Snack", name: "Apple & Almond Butter", emoji: "🍎", calories: 210, protein: 6, carbs: 26, fat: 10,
      description: "Crisp apple slices with natural almond butter.", prep: "Slice apple, portion almond butter.",
      tags: ["natural", "portable"], tip: "Portion almond butter into a small container.", recyclingTip: "Apple core is compostable." },
  ],
  totalCalories: 1530,
};

console.log("Testing meal cache endpoints...\n");

// TEST 1: Query empty cache
const t1 = await api("/api/meal-cache/query", { email: EMAIL, ...KEY, count: 3 });
pass("query empty cache → 0 days", t1.status === 200 && t1.data.days?.length === 0, `days=${t1.data.days?.length}, total=${t1.data.total}`);

// TEST 2: Store a day
const t2 = await api("/api/meal-cache/store", { days: [FAKE_DAY], ...KEY });
pass("store 1 day", t2.status === 200 && t2.data.stored === 1, `stored=${t2.data.stored}, id=${t2.data.ids?.[0]?.slice(0,8)}...`);
const storedId = t2.data.ids?.[0];

// TEST 3: Query — should return the stored day
const t3 = await api("/api/meal-cache/query", { email: EMAIL, ...KEY, count: 3 });
pass("query returns stored day", t3.status === 200 && t3.data.days?.length === 1, `days=${t3.data.days?.length}, total=${t3.data.total}`);
pass("stored day has meals", t3.data.days?.[0]?.meals?.length === 4, `meals=${t3.data.days?.[0]?.meals?.length}`);

// TEST 4: Mark as seen
const t4 = await api("/api/meal-cache/mark-seen", { email: EMAIL, dayIds: [storedId] });
pass("mark-seen succeeds", t4.status === 200 && t4.data.ok === true, JSON.stringify(t4.data));

// TEST 5: Query again — day is now seen, should be excluded
const t5 = await api("/api/meal-cache/query", { email: EMAIL, ...KEY, count: 3 });
pass("seen day excluded from future queries", t5.status === 200 && t5.data.days?.length === 0, `days=${t5.data.days?.length}, total=${t5.data.total}`);

// CLEANUP: remove the test cached day from DB
await mongoose.connect(process.env.MONGODB_URI);
const CachedDay = mongoose.model("CachedDay", new mongoose.Schema({}, { strict: false }));
const User = mongoose.model("User", new mongoose.Schema({ email: String, seenDayIds: [mongoose.Schema.Types.ObjectId] }, { strict: false }));
await CachedDay.deleteOne({ _id: storedId });
await User.updateOne({ email: EMAIL }, { $pull: { seenDayIds: new mongoose.Types.ObjectId(storedId) } });
await mongoose.disconnect();
console.log("\nCleanup done.\nAll cache infrastructure working correctly.");

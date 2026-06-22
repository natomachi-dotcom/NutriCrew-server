import "dotenv/config";

const AI   = "https://nutricrew-backend.vercel.app";
const EMAIL = "renatogadeabi@gmail.com";

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(10, 0, 0, 0);
const returnDate = new Date(tomorrow);
returnDate.setDate(returnDate.getDate() + 3);

const pairings = [
  {
    pairingDate: tomorrow.toISOString(),
    returnDate: returnDate.toISOString(),
    pairingDays: 3,
    departure: "Miami",
    destinations: ["New York", "Boston"],
    goingUsa: "yes",
    timezone: 0,
  },
];

const profile = {
  name: "Renato", gender: "male", weight: "80kg", dob: "1990-06-15",
  position: "cabin", diets: ["balanced"], goals: ["lose_weight"],
  budgetAmount: "30", budgetType: "day", lang: "en",
};

console.log("\n══════════════════════════════════════════");
console.log("  GYM PLAN FLOW TEST");
console.log("══════════════════════════════════════════\n");

// STEP 1 — Generate gym plan
console.log("STEP 1 — Generate gym plan (1 Haiku call)");
const t0 = Date.now();
const r = await fetch(`${AI}/api/gym-plan/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, pairings, profile }),
  signal: AbortSignal.timeout(60000),
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const data = await r.json();

if (!r.ok) { console.log(`❌ Generate failed (${r.status}):`, data); process.exit(1); }
console.log(`✅ Generated in ${elapsed}s`);

const plan = data.plan;
const weeks = plan?.weeks || [];
let totalDays = 0, workoutDays = 0, restDays = 0, totalExercises = 0;
let missingVid = [], missingMuscle = [];

for (const week of weeks) {
  for (const day of week.days || []) {
    totalDays++;
    if (!day.workout) { restDays++; continue; }
    workoutDays++;
    for (const ex of day.workout.exercises || []) {
      totalExercises++;
      if (!ex.vid) missingVid.push(ex.name);
      if (!ex.muscle) missingMuscle.push(ex.name);
    }
  }
}

console.log(`   Weeks: ${weeks.length}  |  Days: ${totalDays}  |  Workout: ${workoutDays}  |  Rest: ${restDays}`);
console.log(`   Total exercises across plan: ${totalExercises}`);
console.log(`   Missing videoId: ${missingVid.length === 0 ? "none ✅" : missingVid.join(", ")}`);
console.log(`   Missing muscle: ${missingMuscle.length === 0 ? "none ✅" : missingMuscle.join(", ")}`);

// Print sample day
const sampleWeek = weeks[0];
const sampleDay = sampleWeek?.days?.find(d => d.workout);
if (sampleDay) {
  console.log(`\n   Sample day (${sampleDay.date}) — type: ${sampleDay.type}`);
  console.log(`   Workout: "${sampleDay.workout.title}" (${sampleDay.workout.duration})`);
  for (const ex of sampleDay.workout.exercises || []) {
    console.log(`     • ${ex.name.padEnd(25)} ${String(ex.sets).padStart(1)}×${ex.reps.padEnd(5)}  💪 ${ex.muscle}  🎬 ${ex.vid || "NO VID"}`);
  }
}

// STEP 2 — Fetch back from CRUD
console.log("\nSTEP 2 — Fetch stored plan back via /api/gym-plan/get");
await new Promise(r => setTimeout(r, 2000)); // give store a moment
const month = tomorrow.toISOString().slice(0, 7);
const r2 = await fetch(`${AI}/api/gym-plan/get?email=${encodeURIComponent(EMAIL)}&month=${month}`, {
  signal: AbortSignal.timeout(15000),
});
const d2 = await r2.json();
if (r2.ok && d2.found && d2.plan?.weeks?.length > 0) {
  console.log(`✅ Plan retrieved from DB  (weeks=${d2.plan.weeks.length})`);
} else {
  console.log(`❌ Fetch failed:`, d2);
}

// STEP 3 — Type distribution
console.log("\nSTEP 3 — Day type breakdown");
const typeCounts = {};
for (const week of weeks) {
  for (const day of week.days || []) {
    typeCounts[day.type] = (typeCounts[day.type] || 0) + 1;
  }
}
for (const [type, count] of Object.entries(typeCounts)) {
  const emoji = { off: "🏋️", layover: "🏨", pairing: "✈️", rest: "😴" }[type] || "❓";
  console.log(`   ${emoji} ${type.padEnd(10)} ${count} day(s)`);
}

console.log("\n══════════════════════════════════════════");
console.log("  DONE — gym plan flow works end-to-end");
console.log("══════════════════════════════════════════\n");

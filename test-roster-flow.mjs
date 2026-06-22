import "dotenv/config";
import mongoose from "mongoose";

const CRUD  = "https://nutricrew-server-1.onrender.com";
const AI    = "https://nutricrew-backend.vercel.app";
const IKEY  = process.env.INTERNAL_API_KEY;
const EMAIL = "renatogadeabi@gmail.com";
const MONGO = process.env.MONGODB_URI;

// ── helpers ────────────────────────────────────────────────────────
function ok(label, val) { console.log(`✅ ${label}`, val !== undefined ? `→ ${JSON.stringify(val)}` : ""); }
function fail(label, val) { console.log(`❌ ${label}`, val !== undefined ? `→ ${JSON.stringify(val)}` : ""); }
function info(label) { console.log(`   ${label}`); }

// ── tomorrow's date ────────────────────────────────────────────────
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(10, 0, 0, 0);
const returnDate = new Date(tomorrow);
returnDate.setDate(returnDate.getDate() + 2);

// ── test profile ───────────────────────────────────────────────────
const profile = {
  name: "Renato", gender: "male", weight: "80kg", dob: "1990-06-15",
  position: "cabin", diets: ["balanced"], goals: ["lose_weight"],
  budgetAmount: "30", budgetType: "day", lang: "en", lunchBag: null,
};

const testPairing = {
  pairingDate: tomorrow.toISOString(),
  returnDate:  returnDate.toISOString(),
  pairingDays: 2,
  departure:   "Miami",
  destinations: ["New York"],
  goingUsa:    "yes",
  timezone:    0,
};

console.log("\n══════════════════════════════════════════");
console.log("  NUTRICREW ROSTER FLOW — FULL TEST");
console.log("══════════════════════════════════════════");
console.log(`  Email:        ${EMAIL}`);
console.log(`  Pairing date: ${tomorrow.toDateString()}`);
console.log(`  Route:        Miami → New York`);
console.log("══════════════════════════════════════════\n");

// ── STEP 1: Store pairing via AI backend relay ─────────────────────
console.log("STEP 1 — Store test pairing via AI backend");
let storeOk = false;
try {
  const r = await fetch(`${AI}/api/roster/store-pairings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, pairings: [testPairing], profile }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (r.ok && d.ok) { ok("Pairing stored", `stored=${d.stored}`); storeOk = true; }
  else fail("Store failed", d);
} catch (e) { fail("Store error", e.message); }

if (!storeOk) { console.log("\n⛔ Cannot continue without stored pairing."); process.exit(1); }

// ── STEP 2: Read token from MongoDB ───────────────────────────────
console.log("\nSTEP 2 — Read confirmToken from MongoDB");
let confirmToken = null;
try {
  await mongoose.connect(MONGO);
  const col = mongoose.connection.collection("scheduledpairings");
  const doc = await col.findOne(
    { email: EMAIL },
    { sort: { createdAt: -1 }, projection: { confirmToken: 1, pairingDate: 1, reminderSentAt: 1 } }
  );
  await mongoose.disconnect();
  if (doc?.confirmToken) {
    confirmToken = doc.confirmToken;
    ok("Got confirmToken", confirmToken.slice(0, 12) + "…");
    info(`reminderSentAt already: ${doc.reminderSentAt || "null (good)"}`);
  } else {
    fail("No confirmToken found", doc);
  }
} catch (e) { fail("MongoDB error", e.message); }

if (!confirmToken) { console.log("\n⛔ Cannot continue without confirmToken."); process.exit(1); }

// ── STEP 3: Kitchen-select page ───────────────────────────────────
console.log("\nSTEP 3 — Kitchen-select page (what user sees when they tap push notification)");
try {
  const r = await fetch(`${CRUD}/api/roster/kitchen-select?token=${confirmToken}`, {
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  const hasButtons = html.includes("Hotel / No Kitchen") && html.includes("Crew Meals on Board");
  const hasRoute   = html.includes("New York");
  if (r.ok && hasButtons && hasRoute) {
    ok("Kitchen-select page renders", `status=${r.status}, has 4 buttons, shows route`);
  } else {
    fail("Kitchen-select page issue", { status: r.status, hasButtons, hasRoute });
    info(html.slice(0, 200));
  }
} catch (e) { fail("Kitchen-select error", e.message); }

// ── STEP 4: Trigger send-reminders cron ──────────────────────────
console.log("\nSTEP 4 — Trigger send-reminders cron (sends email + push)");
info("This sends the reminder email to " + EMAIL + " and a push notification if subscribed");
try {
  const r = await fetch(`${CRUD}/api/roster/send-reminders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-key": IKEY },
    signal: AbortSignal.timeout(30000),
  });
  const d = await r.json();
  if (r.ok) {
    if (d.sent > 0) ok(`Reminder sent (email + push)`, `sent=${d.sent}/${d.total}`);
    else {
      // Already sent (reminderSentAt was set) — reset and retry
      info(`sent=0 — reminderSentAt was already set, resetting and retrying…`);
      await mongoose.connect(MONGO);
      const col = mongoose.connection.collection("scheduledpairings");
      await col.updateOne({ confirmToken }, { $set: { reminderSentAt: null } });
      await mongoose.disconnect();

      const r2 = await fetch(`${CRUD}/api/roster/send-reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-key": IKEY },
        signal: AbortSignal.timeout(30000),
      });
      const d2 = await r2.json();
      if (d2.sent > 0) ok(`Reminder sent after reset`, `sent=${d2.sent}/${d2.total}`);
      else fail("Still 0 sent after reset", d2);
    }
  } else fail("send-reminders failed", d);
} catch (e) { fail("send-reminders error", e.message); }

// ── STEP 5: Confirm kitchen ───────────────────────────────────────
console.log("\nSTEP 5 — Confirm kitchen (🏨 Hotel) — triggers plan generation");
info("This fires generate-plan in background and returns the confirmation page");
try {
  const r = await fetch(`${CRUD}/api/roster/confirm-kitchen?token=${confirmToken}&kitchen=hotel`, {
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  const confirmed = html.includes("Kitchen Confirmed") || html.includes("meal plan");
  const hasLink   = html.includes("nutricrew-frontend.vercel.app");
  if (r.ok && confirmed) {
    ok("Kitchen confirmed, plan generating", `has_app_link=${hasLink}`);
    info("Plan email will arrive at " + EMAIL + " in ~30 seconds");
  } else {
    fail("Confirm-kitchen issue", { status: r.status, confirmed });
    info(html.slice(0, 300));
  }
} catch (e) { fail("confirm-kitchen error", e.message); }

// ── STEP 6: Verify planEmailSentAt set in DB ──────────────────────
console.log("\nSTEP 6 — Wait 40s then verify planEmailSentAt was set in MongoDB");
info("Waiting 40 seconds for plan generation to complete…");
await new Promise(r => setTimeout(r, 40000));

try {
  await mongoose.connect(MONGO);
  const col = mongoose.connection.collection("scheduledpairings");
  const doc = await col.findOne({ confirmToken }, { projection: { planEmailSentAt: 1, kitchenConfirmed: 1, kitchen: 1 } });
  await mongoose.disconnect();
  if (doc?.planEmailSentAt) {
    ok("Plan email sent", `planEmailSentAt=${doc.planEmailSentAt}, kitchen=${doc.kitchen}`);
  } else {
    fail("planEmailSentAt not set yet", doc);
    info("Plan may still be generating — check " + EMAIL + " inbox");
  }
} catch (e) { fail("MongoDB verify error", e.message); }

console.log("\n══════════════════════════════════════════");
console.log("  TEST COMPLETE — check renatogadeabi@gmail.com");
console.log("  for the reminder email AND the meal plan email");
console.log("══════════════════════════════════════════\n");

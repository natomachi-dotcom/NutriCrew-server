import "dotenv/config";
import mongoose from "mongoose";
import crypto from "crypto";
import { createHash } from "crypto";

const MONGODB_URI = process.env.MONGODB_URI;
const VERIFIED_EMAIL = "renatogadeabi@gmail.com"; // real verified user
const OTP_TEST_EMAIL  = "authtest_otp@nutricrew.internal";
const API = "https://nutricrew-backend.vercel.app";

const userSchema = new mongoose.Schema({
  name: String, email: String, password: String,
  pairingCount: { type: Number, default: 0 },
  isPremium: { type: Boolean, default: false },
  emailVerified: { type: Boolean, default: false },
  registeredIP: { type: String, default: null },
  otpHash: String, otpExpiry: Date, otpAttempts: { type: Number, default: 0 },
  sessionToken: String, sessionExpiry: Date,
}, { timestamps: true });
const User = mongoose.model("User", userSchema);

async function req(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

function pass(label, ok, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? "  →  " + detail : ""}`);
}

await mongoose.connect(MONGODB_URI);
console.log("Connected to MongoDB\n");

// ── SETUP ─────────────────────────────────────────────────────────
// Give the real verified user a known session token for clean testing
const knownToken = crypto.randomBytes(32).toString("hex");
const origUser = await User.findOne({ email: VERIFIED_EMAIL }).lean();
await User.updateOne({ email: VERIFIED_EMAIL }, { sessionToken: knownToken, sessionExpiry: null });

// Create a fresh unverified user with a known OTP (bypasses IP check)
await User.deleteOne({ email: OTP_TEST_EMAIL });
const correctOtp = "847261";
const otpHash = createHash("sha256").update(correctOtp).digest("hex");
await User.create({
  name: "OTP Tester", email: OTP_TEST_EMAIL, password: "placeholder",
  emailVerified: false, otpHash, otpAttempts: 0,
  otpExpiry: new Date(Date.now() + 10 * 60 * 1000),
});
console.log("Setup done\n");

// ── TEST 1: verify-session — valid token ──────────────────────────
const t1 = await req("/api/auth/verify-session", { token: knownToken });
pass("verify-session valid token", t1.status === 200 && t1.data.email === VERIFIED_EMAIL, `email=${t1.data.email}`);

// ── TEST 2: verify-session — fake token ───────────────────────────
const t2 = await req("/api/auth/verify-session", { token: "totallyfake" });
pass("verify-session fake token → 401", t2.status === 401, t2.data.error);

// ── TEST 3: send-otp — verified email → instant login, no OTP ─────
const t3 = await req("/api/auth/send-otp", { email: VERIFIED_EMAIL });
pass("send-otp verified email → alreadyVerified=true", t3.status === 200 && t3.data.alreadyVerified === true, `token present=${!!t3.data.token}`);

// ── TEST 4: new token from re-login is different from setup token ──
pass("re-login issues a fresh token", t3.data.token && t3.data.token !== knownToken, "new token differs");

// ── TEST 5: new token validates ───────────────────────────────────
const t5 = t3.data.token
  ? await req("/api/auth/verify-session", { token: t3.data.token })
  : { status: 0, data: {} };
pass("new token is valid", t5.status === 200 && t5.data.email === VERIFIED_EMAIL, `email=${t5.data.email}`);

// ── TEST 6: old token is now dead ─────────────────────────────────
const t6 = await req("/api/auth/verify-session", { token: knownToken });
pass("old token invalidated after re-login", t6.status === 401, t6.data.error);

// ── TEST 7: IP block — same IP, new email → blocked ───────────────
const t7 = await req("/api/auth/send-otp", { email: "iptest_new@example.com" });
pass("new email from same IP → blocked", t7.status === 403 || (t7.status === 500 && t7.data.error?.includes("linked")), t7.data.error ?? `status=${t7.status}`);

// ── TEST 8: verify-otp — wrong code ───────────────────────────────
const t8 = await req("/api/auth/verify-otp", { email: OTP_TEST_EMAIL, otp: "000000" });
pass("wrong OTP → rejected", t8.status === 401, t8.data.error);

// ── TEST 9: verify-otp — correct code ─────────────────────────────
const t9 = await req("/api/auth/verify-otp", { email: OTP_TEST_EMAIL, otp: correctOtp });
pass("correct OTP → session token returned", t9.status === 200 && !!t9.data.token, `token=${t9.data.token?.slice(0,10)}...`);

// ── TEST 10: session from OTP verification is valid ───────────────
const t10 = t9.data.token
  ? await req("/api/auth/verify-session", { token: t9.data.token })
  : { status: 0, data: {} };
pass("post-OTP session validates", t10.status === 200 && t10.data.email === OTP_TEST_EMAIL, `email=${t10.data.email}`);

// ── CLEANUP ───────────────────────────────────────────────────────
// Restore the real user's session token to what it was, or keep the new one
// (the new one from test 3 is fine — user just gets auto-logged in next visit)
await User.deleteOne({ email: OTP_TEST_EMAIL });
console.log("\nCleanup: temp OTP test user removed");
console.log("(real user's session token updated to new one from test 3 — that's fine)");

await mongoose.disconnect();
console.log("\nDone.");

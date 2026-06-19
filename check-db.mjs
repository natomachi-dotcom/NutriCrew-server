import "dotenv/config";
import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

const userSchema = new mongoose.Schema({
  name: String, email: String,
  pairingCount: Number, isPremium: Boolean,
  emailVerified: Boolean, registeredIP: String,
  sessionToken: String, sessionExpiry: Date,
}, { strict: false, timestamps: true });
const User = mongoose.model("User", userSchema);

await mongoose.connect(MONGODB_URI);

const users = await User.find({}).select("email emailVerified registeredIP pairingCount isPremium createdAt -_id").lean();
console.log("\n=== All users in DB ===\n");
users.forEach(u => {
  console.log(`${u.email}`);
  console.log(`  verified=${u.emailVerified ?? "not set"}  IP=${u.registeredIP ?? "none"}  pairings=${u.pairingCount}  premium=${u.isPremium}`);
});
console.log(`\nTotal: ${users.length} users`);

await mongoose.disconnect();

import "dotenv/config";

const { CRUD_SELF_URL, ADMIN_API_KEY } = process.env;
const email = process.argv[2];
if (!email) {
  console.error("Usage: node admin-check-user.mjs <email>");
  process.exit(1);
}

const res = await fetch(`${CRUD_SELF_URL}/api/users`, {
  headers: { "x-admin-key": ADMIN_API_KEY },
});
if (!res.ok) {
  console.error(`Request failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const users = await res.json();
const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
if (!user) {
  console.log(`No user found with email ${email}`);
  process.exit(0);
}
console.log({
  name: user.name,
  email: user.email,
  isPremium: user.isPremium,
  pairingCount: user.pairingCount,
  bonusPairings: user.bonusPairings || 0,
  stripeCustomerId: user.stripeCustomerId,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

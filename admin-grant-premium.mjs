import "dotenv/config";

const { CRUD_SELF_URL, ADMIN_API_KEY } = process.env;
const email = process.argv[2];
if (!email) {
  console.error("Usage: node admin-grant-premium.mjs <email>");
  process.exit(1);
}

const listRes = await fetch(`${CRUD_SELF_URL}/api/users`, {
  headers: { "x-admin-key": ADMIN_API_KEY },
});
if (!listRes.ok) {
  console.error(`Lookup failed: ${listRes.status} ${await listRes.text()}`);
  process.exit(1);
}
const users = await listRes.json();
const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`No user found with email ${email}. They need to have entered their email in the app at least once first.`);
  process.exit(1);
}

console.log(`Found ${user.name} <${user.email}>  isPremium=${user.isPremium} (currently)`);

const putRes = await fetch(`${CRUD_SELF_URL}/api/users/${user._id}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_API_KEY },
  body: JSON.stringify({ isPremium: true }),
});
const result = await putRes.json();
if (!putRes.ok) {
  console.error(`Grant failed: ${putRes.status}`, result);
  process.exit(1);
}
console.log(`Granted — isPremium is now ${result.isPremium}. No Stripe charge involved; this is a manual comp.`);

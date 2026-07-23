import "dotenv/config";

const { CRUD_SELF_URL, ADMIN_API_KEY } = process.env;

const res = await fetch(`${CRUD_SELF_URL}/api/users`, {
  headers: { "x-admin-key": ADMIN_API_KEY },
});
if (!res.ok) {
  console.error(`Request failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const users = await res.json();

console.log(`\n=== ${users.length} user(s) ===\n`);
for (const u of users) {
  const stuck = !u.isPremium && u.pairingCount >= 1;
  console.log(
    `${stuck ? "⚠ STUCK  " : "         "}${u.name || "(no name)"} <${u.email}>  ` +
    `pairingCount=${u.pairingCount} bonusPairings=${u.bonusPairings || 0} isPremium=${u.isPremium}  ` +
    `id=${u._id}  created=${u.createdAt}`
  );
}
console.log(`\nLook for "⚠ STUCK" — non-premium with pairingCount >= 1 but who never got a plan.`);
console.log(`Then run: node admin-reset-pairing.mjs <her-email>`);

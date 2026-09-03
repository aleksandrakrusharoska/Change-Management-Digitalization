/**
 * Quick balance check for Vercel AI Gateway.
 * Run:  node --env-file=.env check-balance.mjs
 */
const key = process.env.AI_GATEWAY_API_KEY;

if (!key) {
  console.error("Missing AI_GATEWAY_API_KEY in .env");
  process.exit(1);
}

const res = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
  headers: { Authorization: `Bearer ${key}` },
});

if (!res.ok) {
  console.error(`Request failed: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const data = await res.json();
console.log("AI Gateway credits:");
console.log(JSON.stringify(data, null, 2));

// Typical fields: balance (remaining), total_used (lifetime spend)
if (data.balance !== undefined) {
  console.log(`\n💰 Remaining balance: $${data.balance}`);
}
if (data.total_used !== undefined) {
  console.log(`📊 Lifetime spend:   $${data.total_used}`);
}

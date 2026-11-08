// End-to-end smoke against a deployed Worker: test-card hold → 7 check-ins (one skipped) → settle.
// Also checks the PayPal Checkout path returns an approve link. Usage: node scripts/smoke-pledge.mjs <base-url>
const base = process.argv[2] ?? "http://127.0.0.1:8799";
const days = Array.from({ length: 7 }, (_, i) => ({
  day: i + 1,
  title: ["Coraline", "The Hobbit", "Radiolab", "Spirited Away", "The Little Prince", "Planet Earth", "Holes"][i],
  format: ["read", "read", "listen", "watch", "read", "watch", "read"][i],
  activity: "Read or watch the first 20 minutes and note three new words.",
  minutes: 20,
}));
async function call(path, body) {
  const t = Date.now();
  const r = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`);
  console.log(`${path} ${r.status} ${Date.now() - t}ms`);
  return j;
}
const viaPaypal = await call("/api/pledges", { level: "B1", perDayUsd: 1, funding: "paypal", days });
console.log("checkout path:", viaPaypal.status, viaPaypal.approveUrl?.slice(0, 60));

let p = await call("/api/pledges", { level: "B1", perDayUsd: 1, funding: "test-card", days });
console.log("hold:", p.status, p.authorizationId);
for (const d of days) {
  if (d.day === 3) {
    p = await call(`/api/pledges/${p.id}/days/3/skip`, {});
    continue;
  }
  p = await call(`/api/pledges/${p.id}/days/${d.day}/quiz`, {});
  const day = p.days[d.day - 1];
  console.log(`  Q (${day.quizSource}):`, day.quiz.map((q) => q.q).join(" | "));
  const answers = [
    `In the first part of ${d.title}, the main character arrives in a new place and meets a strange person who gives a warning about the house.`,
    `I liked the moment when the hero decided to go through the door alone, because it was brave and a little scary.`,
    `"Curious": I was curious about the hidden door, so I kept reading to find out what was behind it.`,
  ];
  p = await call(`/api/pledges/${p.id}/days/${d.day}/answers`, { answers });
  let g = p.days[d.day - 1];
  if (g.status === "open") {
    p = await call(`/api/pledges/${p.id}/days/${d.day}/answers`, { answers: answers.map((a) => a + " I wrote this myself after finishing today's session.") });
    g = p.days[d.day - 1];
  }
  console.log(`  day ${d.day}: ${g.status} ${g.grade?.score} (${g.grade?.source}) ${g.grade?.feedback?.slice(0, 90)}`);
}
p = await call(`/api/pledges/${p.id}/settle`, {});
console.log("settlement:", JSON.stringify(p.settlement, null, 1));
for (const e of p.ledger) console.log(` [${e.actor}] ${e.text}${e.calls ? " :: " + e.calls.map((c) => `${c.method} ${c.path} ${c.status}`).join(", ") : ""}`);
console.log("pledge page:", `${base}/?pledge=${p.id}`);

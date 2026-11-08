// Records the demo video headless with Playwright: plan → PayPal hold → daily AI check-ins → settlement.
// Usage: node scripts/record-demo.mjs <base-url> <out-dir>
// Writes <out-dir>/raw.webm and <out-dir>/marks.json (time spans to speed up when editing).
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:8799";
const out = process.argv[3] ?? "demo-out";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: out, size: { width: 1280, height: 720 } },
  colorScheme: "light",
});
const page = await context.newPage();
const t0 = Date.now();
const marks = [];
const now = () => (Date.now() - t0) / 1000;
async function fast(fn, speed = 8) {
  const start = now();
  await fn();
  marks.push({ start, end: now(), speed });
}
const pause = (ms) => page.waitForTimeout(ms);

async function caption(text) {
  await page.evaluate((t) => {
    let c = document.getElementById("demo-caption");
    if (!c) {
      c = document.createElement("div");
      c.id = "demo-caption";
      c.style.cssText =
        "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);max-width:1100px;background:rgba(15,23,42,.92);color:#fff;font:600 22px/1.35 Inter,system-ui,sans-serif;padding:12px 20px;border-radius:12px;z-index:99999;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.3)";
      document.body.appendChild(c);
    }
    c.textContent = t;
  }, text);
}
async function scrollTo(selector) {
  await page.locator(selector).first().evaluate((n) => n.scrollIntoView({ behavior: "smooth", block: "start" }));
  await pause(900);
}

await page.goto(base);
await caption("Taste-to-English Pledge: finish your English week — or your missed days go to charity.");
await pause(3500);
await caption("Tell it 3 things you love. An AI agent plans 7 days of English books, podcasts and shows at your level.");
await page.click("#example-btn");
await pause(1500);
await page.click("#submit-btn");
await fast(() => page.waitForSelector("#results:not([hidden])", { timeout: 240_000 }), 10);
await pause(800);
await scrollTo("#plan-block");
await caption("The 7-day plan. Now back it with a pledge: $1 per day, held by PayPal — not charged.");
await pause(3500);
await scrollTo("#pledge-offer");
await pause(2500);
await caption("Orders v2 with intent=AUTHORIZE places a $7 hold (sandbox). Here: the judges' test-card shortcut.");
await pause(2000);
await page.click("#pledge-card");
await fast(() => page.waitForURL(/\?pledge=/, { timeout: 60_000 }), 4);
await page.waitForSelector("#pledge-days li");
await pause(1000);
await caption("Hold placed: $7 authorized, no money moved. Every PayPal call is logged with its debug id.");
await scrollTo("#pledge-ledger");
await pause(3500);
await scrollTo("#pledge-view");

function answersFor(title, qs) {
  return qs.map((q) => {
    if (/word|phrase/i.test(q))
      return `"Turning point": the turning point of today's part of ${title} came when the main character finally made a hard choice.`;
    if (/like|feel|favorite|favourite|opinion|why/i.test(q))
      return `I liked the scene near the end of today's part of ${title}, because the main character was scared but still kept going, and I felt the same about studying English.`;
    return `In today's part of ${title}, the main character arrives somewhere new and meets people who change the plan. There is a conflict, a surprising choice, and at the end a hint about what happens next.`;
  });
}

async function doDay(n, opts = {}) {
  const card = page.locator("#pledge-checkin");
  await card.waitFor();
  if (opts.skip) {
    await caption(`Day ${n}: life happens. Skipping costs $1, which will go to charity.`);
    await pause(1500);
    await card.getByRole("button", { name: /Skip today/ }).click();
    await page.waitForSelector(`#pledge-days li:nth-child(${n}).pday-missed`);
    await pause(1200);
    return;
  }
  await card.getByRole("button", { name: /check me/ }).click();
  await fast(() => card.locator("textarea").first().waitFor({ timeout: 90_000 }), 6);
  if (opts.show) {
    await caption("The AI tutor (Workers AI, Llama 3.3) writes questions only someone who did today's session can answer.");
    await scrollTo("#pledge-checkin");
    await pause(4000);
  }
  const title = (await card.locator("h3").first().textContent()).replace(/^Day \d+:\s*/, "");
  const qs = await card.locator(".quiz-q").allTextContents();
  const answers = answersFor(title, qs);
  const areas = card.locator("textarea");
  for (let i = 0; i < answers.length; i++) {
    if (opts.show) await areas.nth(i).pressSequentially(answers[i], { delay: 4 });
    else await areas.nth(i).fill(answers[i]);
  }
  await card.getByRole("button", { name: "Submit answers" }).click();
  await fast(() => page.waitForFunction((k) => !document.querySelector(`#pledge-days li:nth-child(${k})`).classList.contains("pday-open") || document.querySelector(".grade-no"), n, { timeout: 90_000 }), 6);
  // A day that did not pass gets one retry with fuller answers.
  if (await page.locator(`#pledge-days li:nth-child(${n}).pday-open`).count()) {
    await caption("Not convincing enough — the tutor asks for a retry. One retry, then the day counts as missed.");
    await pause(2500);
    const again = page.locator("#pledge-checkin textarea");
    for (let i = 0; i < answers.length; i++) await again.nth(i).fill(`${answers[i]} I wrote this in my own words after the session.`);
    await page.locator("#pledge-checkin").getByRole("button", { name: "Submit answers" }).click();
    await fast(() => page.waitForFunction((k) => !document.querySelector(`#pledge-days li:nth-child(${k})`).classList.contains("pday-open"), n, { timeout: 90_000 }), 6);
  }
  if (opts.show) {
    await caption("Graded 0–100 with feedback and corrections. Pass → that day's $1 is safe.");
    await scrollTo("#pledge-checkin");
    await pause(4500);
  }
}

await doDay(1, { show: true });
await caption("Days 2–7 (sped up). Days unlock immediately in this hackathon build.");
await fast(async () => {
  await doDay(2);
  await doDay(3, { skip: true });
  await doDay(4);
  await doDay(5);
  await doDay(6);
  await doDay(7);
}, 12);
await scrollTo("#pledge-view");
await caption("Week over: 6 days kept, 1 skipped.");
await pause(3000);
await scrollTo("#pledge-settle");
await caption("The settlement agent proposes a PayPal action; a guardrail checks it against the ledger before any money moves.");
await pause(3000);
await page.click("#pledge-settle-btn");
await fast(() => page.waitForSelector("#pledge-result:not([hidden])", { timeout: 120_000 }), 4);
await scrollTo("#pledge-result");
await caption("Partial capture: $1 captured for charity with final_capture=true; the other $6 is released.");
await pause(5000);
await scrollTo("#pledge-ledger");
await caption("Full audit trail: learner, AI tutor, settlement agent, guardrail and every PayPal REST call.");
await pause(3000);
await page.mouse.wheel(0, 900);
await pause(4000);
await caption("Finish every day and the agent voids the hold — nothing is charged. Built on PayPal + Workers AI.");
await pause(4000);

const pledgeUrl = page.url();
await context.close();
await browser.close();
const vid = readdirSync(out).find((f) => f.endsWith(".webm") && f !== "raw.webm");
if (vid) renameSync(join(out, vid), join(out, "raw.webm"));
writeFileSync(join(out, "marks.json"), JSON.stringify({ marks, total: now(), pledgeUrl }, null, 2));
console.log("recorded", now().toFixed(1), "s", pledgeUrl);

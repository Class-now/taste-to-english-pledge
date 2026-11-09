# Taste-to-English Pledge

**Finish your English week — or your money goes to charity.** An AI agent builds a 7-day English reading/listening plan from things you already love, then you back it with a **PayPal authorization hold**. Every day an AI tutor quizzes you on what you actually read or heard. At the end of the week a settlement agent decides what happens to the hold: **void it** (you kept every promise — nothing is charged) or **capture only the missed days' share** for a cause and release the rest.

- Live demo: https://taste-to-english-pledge.shotaro-takakura.workers.dev
- Demo video: https://www.youtube.com/watch?v=eyI7xb_2qMs
- Devpost: https://devpost.com/software/taste-to-english-pledge
- Built for the PayPal AI Hackathon (Devpost, Oct–Nov 2026). PayPal **sandbox** only — no real money moves.

## The problem

Language learners in Japan buy apps and books and quit within a week. Streaks and badges are free to ignore. Commitment contracts with real stakes work, but nobody wants to *pay* to study — and existing "pay if you fail" apps charge first and refund later. A PayPal **authorization** is the right primitive: the money is held, not taken, and released automatically when you succeed.

## How it works

1. **Plan** – type 3 things you love (anime, games, novels…). The planning agent maps them to English books, podcasts and shows at your CEFR level and writes a 7-day plan (pipeline from the original Taste-to-English project, see below).
2. **Pledge** – choose $1 or $2 per day. The Worker creates a PayPal order with `intent: AUTHORIZE` and sends you to PayPal to approve the hold. On return it calls `POST /v2/checkout/orders/{id}/authorize`. Now $7 (or $14) is on hold.
3. **Daily check-in** – the AI tutor (Workers AI, Llama 3.3 70B) writes three questions about *today's* session: a summary only someone who did it can answer, a personal reaction, and one new word used in your own sentence. A second AI call grades your answers 0–100 (pass ≥ 60), gives feedback and corrects your English. One retry; after that the day counts as missed. You can also skip a day honestly.
4. **Settlement agent** – after day 7 the agent reads the whole record and proposes exactly one PayPal action: `void`, `partial_capture` or `full_capture`, with an amount and its reasoning.
5. **Guardrail** – before any money moves, a deterministic policy checks the proposal against the ledger (missed days × daily amount). If the agent asks for anything else — e.g. a prompt-injected "refund me" or a greedy full capture — the ledger wins and the override is logged.
6. **PayPal** – the Worker calls `POST /v2/payments/authorizations/{id}/void`, or `.../capture` with the missed amount and `final_capture: true`, which releases the rest of the hold.
7. **Ledger** – every learner action, AI decision, guardrail check and PayPal REST call (method, path, HTTP status, `PayPal-Debug-Id`, latency) is shown on the pledge page.

## PayPal integration

| Step | API |
|---|---|
| OAuth 2.0 client credentials | `POST /v1/oauth2/token` (token cached per isolate) |
| Create the hold | `POST /v2/checkout/orders` — `intent: AUTHORIZE`, `payment_source.paypal.experience_context` (return/cancel URLs, `NO_SHIPPING`, `CONTINUE`), `custom_id` = pledge id |
| Place the hold after approval | `POST /v2/checkout/orders/{id}/authorize` |
| All days kept | `POST /v2/payments/authorizations/{id}/void` |
| Some days missed | `POST /v2/payments/authorizations/{id}/capture` — partial `amount`, `final_capture: true`, `note_to_payer` written by the agent |

Every mutating call sends a `PayPal-Request-Id` derived from the pledge id, so retries are idempotent and a pledge can never be captured twice. Client secret lives only in a Wrangler secret.

## AI usage

- **Workers AI – Llama 3.3 70B** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) with JSON-schema constrained output for: quiz writing, answer grading with corrections, and the settlement decision. Every prompt treats learner input as data (prompt-injection rule), and every AI step has a deterministic rule-based twin that takes over if the model fails, so a check-in or a settlement never gets stuck. The UI labels which one answered.
- The agent never decides money on its own: it proposes, the guardrail verifies, then PayPal is called.
- Claude Code (Anthropic) was used as the coding assistant to build this project.

## What changed during the hackathon

Taste-to-English was started on 2026-10-21 for the Qloo hackathon (planning pipeline). For this hackathon it was substantially extended: PayPal Orders/Payments client (`src/paypal.ts`), the pledge state machine and guardrail (`src/pledge.ts`), the AI tutor and settlement agent (`src/pledge-ai.ts`), Workers KV storage, the pledge UI (`public/pledge.js`) and tests (`test/pledge.test.ts`). The taste data now uses the built-in sample catalog only (no third-party API key needed to run it).

## Try it (judges)

1. Open the demo, click **Try an example** → **Build my plan**.
2. Under the plan, choose $1/day → **Hold $7 with PayPal**, and approve with a PayPal **sandbox personal account** (create one in your own PayPal developer dashboard → Sandbox accounts) — or click **Judges' shortcut: hold with the sandbox test card**, which places a real sandbox authorization without a buyer login.
3. Back on the pledge page: **I did today's session — check me**, answer in English, submit. Skip a day or two to see a partial capture.
4. After day 7: **Settle my pledge** and read the ledger.

Days unlock as soon as the previous one is done in this build so the whole week can be tested in minutes (a production build would unlock one per calendar day).

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox)
npx wrangler dev --port 8799
npx vitest run
```

Without PayPal credentials the app uses a clearly labelled *simulated* PayPal client. Deploy: `npx wrangler kv namespace create PLEDGES`, put the id in `wrangler.jsonc`, `npx wrangler secret put PAYPAL_CLIENT_ID`, `npx wrangler secret put PAYPAL_CLIENT_SECRET`, `npx wrangler deploy`.

## Stack

Cloudflare Workers (TypeScript, no runtime dependencies), Workers AI, Workers KV, vanilla JS frontend, Vitest.

## License

MIT — see [LICENSE](LICENSE).

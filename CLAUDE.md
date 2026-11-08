# taste-to-english-pledge

PayPal AI Hackathon entry (deadline 2026-11-13 05:00 JST). Fork of `qloo-reading-planner` (Taste-to-English) with a PayPal-backed study pledge. Contest status lives in `C:\For Claude\contest-pm\contests\1113-paypal-ai\status.md`.

## Where things are
- Planner pipeline (unchanged from the Qloo build, runs on the sample catalog only — no Qloo key): `src/agent.ts`, `src/mock-*.ts`.
- PayPal REST client (Orders v2 AUTHORIZE, authorize, void, partial capture, sandbox test-card shortcut): `src/paypal.ts`.
- Pledge state machine, KV store, guardrail, settlement: `src/pledge.ts`. Routes: `/api/pledges*` in `src/index.ts`.
- AI prompts (quiz, grade, settle) and their rule-based twins: `src/pledge-ai.ts`.
- UI: `public/pledge.js` (+ sections in `public/index.html`, styles at the end of `public/styles.css`).
- Tests: `test/pledge.test.ts`.

## Commands
- `npx tsc --noEmit` / `npx vitest run`
- Local: `npx wrangler dev --port 8799` (sandbox creds in `.dev.vars`, gitignored).
- Deploy: `npx wrangler deploy` (Claude deploys and reports). Secrets: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` via `wrangler secret put`.

## Conventions
- Money moves only after `guardDecision` agrees with the ledger. Mutating PayPal calls carry a `PayPal-Request-Id` derived from the pledge id.
- Frontend: vanilla ES module, no build step, never `innerHTML` with server data.
- No runtime dependencies.

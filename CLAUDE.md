# qloo-reading-planner (Taste-to-English)

Cloudflare Worker (TypeScript) + static frontend in `public/`. Product and pipeline design: `docs/design.md`. Qloo API facts: `docs/qloo-api-notes.md`.

## Commands
- `npx tsc --noEmit`
- `npx vitest run`
- `npx wrangler deploy --dry-run --outdir /tmp/ttE-dry`
- Local dev: `npx wrangler dev --port 8799` (8787 is taken by another local service). Workers AI needs a Cloudflare login even in mock mode.

## Conventions
- Mock vs live: `createQlooClient` / `qlooMode` (`src/qloo.ts`) pick live mode only when `QLOO_API_KEY` is set. `src/mock-data.ts` is hand-written; never commit real Qloo response data or a key.
- Pipeline: `runPlan` in `src/agent.ts`. Step ids, labels and user-facing failure messages live in `STEP_LABELS` / `FAILURE_MESSAGES`. Only a `StepFailure` message reaches the user; other errors go to `console.error` and the client gets the fixed message.
- The LLM never proposes titles. `because` lines come from Qloo data only (`src/explain.ts`).
- Prompts and their JSON schemas are in `src/prompts.ts`. Each system prompt starts with a `[kind:<name>]` tag that `test/fake-llm.ts` uses to pick a canned answer. Workers AI may return short arrays, so schemas pin `minItems`/`maxItems` and the agent re-checks counts.
- Cache namespace is `v1-<mode>` (`src/index.ts`). Bump `v1` when the parsed `QlooEntity` shape changes.
- Frontend: vanilla ES module, no build step, no external scripts (Google Fonts only), never `innerHTML` with server data.
- No new runtime dependencies. Don't change `wrangler.jsonc` bindings.

## Test helpers
- `test/fake-llm.ts`: deterministic LLM with per-kind overrides.
- `test/memory-cache.ts`: in-memory Cache API; `installMemoryCaches()` puts it on `globalThis.caches`.
- `HttpQlooClient` takes an injected fetch and `{ retryDelayMs }` for tests.

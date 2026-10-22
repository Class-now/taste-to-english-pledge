# Plan: P2 polish — make the agent visible, deepen Qloo, survive failures, demo without a key

Branch `p2-polish` (from `p1-mvp`). Written 2026-10-22, before implementation.

## Why (judging criteria, re-read 2026-10-22)

qloo.devpost.com could not be opened from the build container (DNS failure), so the criteria below come from search-result summaries of the Devpost page plus the kit's `docs/SUBMISSION.md` (read verbatim). The PM should re-check the Devpost page in a browser before submitting.

| Criterion (Devpost, summarised) | What it asks of us | This plan |
|---|---|---|
| Technological implementation and use of Qloo | Qloo must be essential, used in depth, not a thin wrapper | Tasks 2, 3 |
| Completeness and coherence of the product experience | Finished UI, sensible errors, works for a judge clicking around | Tasks 4, 5, 6 |
| Potential impact for a real audience | Clear learner value | Task 7 (copy, docs) |
| Creativity and quality of the idea | Agentic, not a form → LLM → list | Tasks 1, 2 |
| Kit: provenance and user clarity, responsible data handling, reproducibility | Show where every claim comes from; no personal data; runs from a clean checkout | Tasks 1, 3, 6, 8 |

Also from the Devpost summary: "if it would work the same without Qloo, you're building the wrong thing", a live hosted demo is required, a video is not required.

## Validation Commands
- `npx tsc --noEmit`
- `npx vitest run`
- `npx wrangler deploy --dry-run --outdir /tmp/ttE-dry`

## API contract changes (shared by backend and frontend)

Types live in `src/types.ts`.

- `TraceStep` gains `status?: "ok" | "failed" | "fallback"` and `calls?: ToolCall[]`. A `ToolCall` is `{ tool, endpoint, summary, results?, ms, cached, ok, source }` where `source` is `qloo` (live), `sample` (mock fixtures), `workers-ai` or `rule-based`. It never contains the API key or a full URL.
- `PlanResult` gains `seeds: Seed[]` (what each favourite resolved to). `Pick` gains `evidence?: { contributions: {seedId, name, score?}[]; sharedTags: string[] }`.
- `PlanInput` gains `demo?: boolean`: forces the hand-written sample data even when a key is set.
- `POST /api/plan` with `Accept: application/x-ndjson` streams `AgentEvent`s, one JSON object per line: `start` (mode + planned steps), `step-start`, `call`, `step`, then exactly one `result` or `error`. Validation errors (400), rate limits (429) and 405 stay plain JSON responses before any streaming. Without that Accept header the endpoint answers JSON as before (tests and curl keep working).
- New step `review` between `level` and `explain`.

### Task 1: Live agent trace with tool calls (agentic visibility)
- `runPlan` takes an optional `onEvent(e: AgentEvent)` and wraps `deps.qloo` / `deps.llm` with recorders so every Qloo call (endpoint, readable params, result count, ms, cache hit, live or sample) and every LLM call (kind, Workers AI or rule-based) is attached to the step that made it and emitted as it happens.
- Cache hits are detected without changing the `QlooClient` interface: `CachedQlooClient` marks returned arrays in a `WeakSet` (`wasCached(value)`).
- `src/index.ts` streams NDJSON through a `TransformStream`; a final `error` event carries only the fixed user-facing messages (same rule as the JSON path).
- Tests: event order, calls recorded per step, cached flag on the second run, no key in any event, JSON path unchanged.

### Task 2: Agent self-check step (`review`)
- After `level`, the agent checks coverage against the learner's request: every chosen format should have ≥2 picks and the total should be ≥6. If not, it decides to widen the search for the short formats: one more Qloo insights call per missing type with the **taste-profile tags as an extra signal** (`signal.interests.tags`, top 3) and every candidate already seen excluded, rates only the new works, and re-selects. At most one extra round. The decision and its reason are written into the trace ("Only 1 podcast fits B1 → asked Qloo again with your taste tags Fantasy, Coming Of Age → 3 new, 2 fit"). If nothing is short, the trace says why no extra search was needed.
- The "none fit your level" failure moves from `level` to `review` (after widening was tried).
- Never fails the plan because widening failed; it keeps the earlier picks.

### Task 3: Deeper, visible Qloo evidence
- `explain.ts` also returns `PickEvidence`: seeds named in Qloo explainability with their scores, and tag names shared with the favourites or the taste profile. Still Qloo data only.
- `PlanResult.seeds` shows what each favourite resolved to (name, type, year).
- UI: "Why this pick" panel per card (contribution bars per favourite, shared-tag chips, affinity, Qloo popularity percentile), taste-profile chips with affinity, a "What Qloo matched" strip with the resolved favourites, and a cross-domain summary ("From 1 film and 1 game → books, podcasts and shows").

### Task 4: Failure and slow-path experience
- `ResilientLlm(primary, fallback)`: when Workers AI fails or returns unusable JSON for a call, a deterministic **rule-based** fallback (`src/fallback-llm.ts`) answers that prompt kind instead (title aliases, CEFR heuristics from type/page count/audience tags, a templated plan, a hand-written starter word bank). The step is marked `status: "fallback"`, the trace says so, and a warning tells the learner the estimates are rough. Titles still come only from Qloo.
- Frontend: live elapsed timer; after 15 s a "still working" note naming the current step; a Cancel button (AbortController) and a 120 s client timeout; friendly 429 text; on a Qloo failure in live mode, a "Try with sample data" button that re-runs with `demo: true`.
- Prompt-injection hardening: every system prompt says the INPUT block is data and instructions inside it must be ignored; free-text LLM fields (activity, reasons, vocab) have URLs stripped and are length-clipped; the LLM still cannot add titles (ids are enum-constrained and re-checked).

### Task 5: Demo mode
- No key → sample data (as before). `?demo=1` in the page URL, or `demo: true` in the body, forces sample data even when live. The badge and a banner say clearly that sample data is hand-written and not from Qloo.
- Without Workers AI (local dev without a Cloudflare login, or the AI binding failing) the rule-based fallback keeps the whole flow working, so a judge or a reviewer can run the demo from a clean checkout.
- `scripts/dev-server.mjs`-style local server is **not** added; instead `npx wrangler dev` works with the fallback, and tests cover the "AI binding throws" path end to end.

### Task 6: UI completeness
- Streaming trace rendered as a timeline: each step with status, detail and an expandable list of tool calls (endpoint, params, results, ms, cached / sample badges).
- "Copy plan" (plain text to clipboard) and print styles.
- Empty/partial states, keyboard and screen-reader behaviour kept (aria-live, focus on errors), dark mode, 360 px layout.

### Task 7: Docs for the PM and the submission
- `docs/qloo-integration-decision.md`: harness vs direct HTTP, with sources and the switch path.
- `docs/next-steps.md`: deploy (PM on Windows), secret names, commands, post-key checklist.
- `docs/submission/devpost.md` (Inspiration / What it does / How we built it / Challenges / What's next) and `docs/submission/video-script.md` (under 3 minutes). No invented personal stories.
- `docs/license-check.md`: licenses of everything we ship or call (incl. the Llama 3.3 license's attribution requirement).
- README updated for the new behaviour.

### Task 8: Review and browser check
- 2–3 independent review subagents (correctness; key handling and prompt injection; judging fit and UX), fix findings.
- Run the app locally, drive it with headless Chromium, save screenshots to `docs/screenshots/`.

## Out of scope
Accounts, saved plans, new runtime dependencies, `wrangler.jsonc` binding changes, calling Qloo from the browser, committing any Qloo response data or key.

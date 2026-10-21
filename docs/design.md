# Taste-to-English — design (hackathon MVP)

Working name: **Taste-to-English** (repo `qloo-reading-planner`). Built for the Qloo Agentic Hackathon (Devpost). Deadline 2026-10-30 23:45 EDT.

## 1. Problem and user

Japanese learners of English are told to do "extensive reading / listening" (多読・多聴), but graded readers and textbook podcasts rarely match what they actually enjoy, so they quit. Learners already know what they love — in Japanese: anime, J-novels, games, films. The gap is getting from "I love *Spirited Away*, *Persona 5* and Haruki Murakami" to "these 3 English books, 2 podcasts and 1 TV series, at my level, in this order this week".

An LLM alone guesses popular English titles and drifts toward generic bestsellers. **Qloo's cross-domain taste graph** is what connects a Japanese game to an English podcast. If Qloo is removed, the recommendations become generic — this is the core of the project.

## 2. User flow (single page)

1. Enter 1–5 favourite works (any language, any domain: book / movie / TV / anime / game / podcast / artist). Optional type hint.
2. Pick English level (CEFR: A2, B1, B2, C1), minutes per day (10/20/30/45), and which formats they want (read / listen / watch).
3. Press **Build my plan**. The agent runs and shows a live **agent trace** (steps below) so the user sees why.
4. Result:
   - **Your taste profile**: the taste tags Qloo associates with the favourites (top 8 chips).
   - **Picks**: 6–9 English works (books, podcasts, TV shows/films with English audio) each with: type, title, year, Qloo affinity score, estimated CEFR difficulty + one-line reason, "because you like X" (which favourite / which tag), and an "easier" or "stretch" badge relative to the learner level.
   - **7-day plan**: per day one activity (read N pages / listen to one episode / watch one episode with English subtitles) sized to minutes per day, alternating formats, easiest first.
   - **Starter vocabulary**: 12 words/phrases likely to appear in the day-1 item, with Japanese gloss and a short English example sentence. Marked "AI-generated, check in a dictionary".
5. **Refine** box: free-text like "less fantasy, more mystery" or "shorter books". The agent maps it to Qloo tag signals / filters and re-runs.
6. Footer: data sources and limits (Qloo results are aggregate taste patterns, difficulty is an LLM estimate, no personal data stored).

## 3. Architecture

- One Cloudflare Worker (TypeScript), static assets in `public/` (plain HTML/CSS/vanilla JS, no build step) served by Workers Assets; `/api/*` handled by the Worker (`run_worker_first`).
- LLM: Cloudflare **Workers AI** binding `AI`, model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, JSON output via `response_format: { type: "json_schema", json_schema }`. Wrapped in `src/llm.ts` behind an interface so tests use a fake.
- Qloo: `src/qloo.ts` exports `interface QlooClient` with two implementations: `HttpQlooClient` (base URL `env.QLOO_BASE_URL` = `https://hackathon.api.qloo.com`, header `X-Api-Key: env.QLOO_API_KEY`) and `MockQlooClient` (fixtures in `src/mock-data.ts`, hand-written by us, not Qloo data). `createQlooClient(env)` returns the HTTP one iff `env.QLOO_API_KEY` is set. The API key is a Wrangler secret, never in the repo or the browser. Exact endpoint/param names: see `docs/qloo-api-notes.md`.
- Caching: Qloo GET responses cached server-side with the Workers Cache API (`caches.default`, key = request URL without the key header, TTL 24h). Nothing from Qloo is committed to the repo.
- Abuse/cost guard: per-IP limit of 20 plan requests / hour using an in-memory Map per isolate plus Cache API counter (best effort); input lengths capped (titles ≤ 80 chars, ≤ 5 favourites, refine text ≤ 200 chars).
- No database, no accounts, no personal data. Inputs are titles of public cultural works only. Nothing is sent to Qloo except entity names/ids and tags.

## 4. Agent pipeline (`src/agent.ts`)

`runPlan(input, deps) -> PlanResult` where deps = { qloo, llm, now }. Each step appends a `TraceStep { id, label, detail, ms }`.

1. **normalize** (LLM): for each favourite, return `{ query: English/official title for search, typeGuess: one of book|movie|tv_show|podcast|video_game|artist }`. E.g. 「千と千尋の神隠し」→ "Spirited Away", movie.
2. **resolve** (Qloo search): search each query with the type filter; take the best match (fallback: search without type). Unresolved favourites are reported in the trace and skipped; if none resolve → error message to user.
3. **taste profile** (Qloo): tags for the resolved entities (insights with `filter.type=urn:tag` and the entities as signal, or the tags endpoint — see notes). Keep top 8 by affinity/weight.
4. **recommend** (Qloo insights): for each selected output type (read → `urn:entity:book`; listen → `urn:entity:podcast`; watch → `urn:entity:tv_show` and `urn:entity:movie`), call insights with `signal.interests.entities` = resolved ids (+ refine tags if any), `take=15`. Exclude the favourites themselves.
5. **level fit** (LLM, one call for all candidates): given title, type, year, description and the learner CEFR level, estimate CEFR of the English (A2–C2) and a one-line reason; return JSON array. Keep candidates whose level is within [learner-1, learner+1]; prefer exact and +1 ("stretch"). Pick 6–9 total, at least 2 per selected format when available, ordered easiest first, tie-break by Qloo affinity.
6. **explain**: for each pick, compute "because you like X" deterministically from Qloo (which favourite's tags overlap the pick's tags, else the highest-affinity favourite). No LLM invention for this field.
7. **plan + vocab** (LLM, one call): 7-day schedule using picks and minutes/day; 12 starter vocab items for day-1 item with Japanese gloss and example.
8. **refine** (LLM): map refine text to `{ addTags: [...free text], removeTags: [...], filters: { maxYear?, minYear? } }`; resolve addTags via Qloo tag search; rerun steps 4–7 with the extra signals.

Failures: any Qloo/LLM step failure yields a user-facing error with which step failed; the trace is still returned.

## 5. API

- `POST /api/plan` body `{ favorites: {title: string, type?: string}[], level: "A2"|"B1"|"B2"|"C1", minutesPerDay: 10|20|30|45, formats: ("read"|"listen"|"watch")[], refine?: string }` → `200 { mode: "live"|"mock", profile: Tag[], picks: Pick[], plan: Day[], vocab: Vocab[], trace: TraceStep[], warnings: string[] }`; `400` for invalid input with `{ error }`; `429` when rate limited; `502` with `{ error, trace }` when a step fails.
- `GET /api/health` → `{ ok: true, mode: "live"|"mock" }`.

## 6. Validation

- `npx tsc --noEmit`
- `npx vitest run` (unit tests for input validation, Qloo client URL building, mock client, agent pipeline with fake LLM + mock Qloo, explain logic, level filter)
- `npx wrangler deploy --dry-run`

## 7. Out of scope (MVP)

Accounts, saving plans, progress tracking, audio playback, scraping book text, Japanese UI toggle (UI is English with Japanese glosses where useful), any personal data.

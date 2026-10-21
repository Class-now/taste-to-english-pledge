# Plan: P1 MVP — Taste-to-English (Qloo Agentic Hackathon)

Context for every task: this repo is a Cloudflare Worker (TypeScript, `src/index.ts`) with static assets in `public/` (Workers Assets, binding `ASSETS`, `run_worker_first: ["/api/*"]`), a Workers AI binding `AI`, and a var `QLOO_BASE_URL=https://hackathon.api.qloo.com`. `QLOO_API_KEY` is an optional secret: when absent the app runs in **mock mode**. Product and pipeline design: `docs/design.md` (read it first). Qloo API facts: `docs/qloo-api-notes.md` (read sections 0–3 before touching the Qloo client). Config already exists: `package.json` (scripts `test`, `type-check`, `dev`, `deploy`), `tsconfig.json` (strict), `wrangler.jsonc`, `LICENSE` (MIT). Do not change `wrangler.jsonc` bindings or the license. No new runtime dependencies (devDependencies only if essential). Never write a real API key anywhere; never commit Qloo response data (mock fixtures are hand-written by us and labelled as such).

## Validation Commands
- `npx tsc --noEmit`
- `npx vitest run`
- `npx wrangler deploy --dry-run --outdir /tmp/ttE-dry`

### Task 1: Types, input validation, Qloo client (HTTP + mock)
**Purpose**: a typed, testable Qloo layer that works without a key.

**Design Context**:
- `src/types.ts`: `EntityType = "book"|"movie"|"tv_show"|"podcast"|"videogame"|"artist"`; `Cefr = "A2"|"B1"|"B2"|"C1"|"C2"`; `Format = "read"|"listen"|"watch"`; `PlanInput { favorites: {title: string; type?: EntityType}[]; level: "A2"|"B1"|"B2"|"C1"; minutesPerDay: 10|20|30|45; formats: Format[]; refine?: string }`; `QlooEntity { id; name; type: EntityType; year?: number; description?: string; imageUrl?: string; popularity?: number; affinity?: number; tags: QlooTag[]; disambiguation?: string; language?: string; pageCount?: number; explainability?: Record<string, unknown> }`; `QlooTag { id; name; subtype?: string; affinity?: number }`; plus `TraceStep { id; label; detail; ms }`, `Pick`, `Day`, `Vocab`, `PlanResult` exactly as described in `docs/design.md` §2/§5 (Pick has entity fields + `cefr`, `levelReason`, `fit: "match"|"easier"|"stretch"`, `because: string`, `format: Format`).
- `src/validate.ts`: `parsePlanInput(body: unknown): {ok:true, value: PlanInput} | {ok:false, error: string}`. Rules: 1–5 favorites, title trimmed 1–80 chars, optional type must be an EntityType, level in A2..C1, minutesPerDay in {10,20,30,45}, formats non-empty subset, refine ≤ 200 chars. Reject anything else with a clear message.
- `src/qloo.ts`: `interface QlooClient { search(query: string, types?: EntityType[], take?: number): Promise<QlooEntity[]>; insights(p: { type: EntityType; entityIds: string[]; tagIds?: string[]; excludeIds?: string[]; take?: number; minYear?: number; maxYear?: number; explain?: boolean }): Promise<QlooEntity[]>; entityTags(entityIds: string[], take?: number): Promise<QlooTag[]>; searchTags(query: string, take?: number): Promise<QlooTag[]> }`.
  - `HttpQlooClient(baseUrl, apiKey, fetchFn = fetch)`: GET only, header `X-Api-Key`, arrays comma-joined. Type → URN map: book `urn:entity:book`, movie `urn:entity:movie`, tv_show `urn:entity:tv_show`, podcast `urn:entity:podcast`, artist `urn:entity:artist`, videogame `urn:entity:videogame` (on HTTP 403 for videogame retry once with `urn:entity:video_game`). `search` → `GET /search?query&types&take` (response `results` is a flat array). `insights` → `GET /v2/insights?filter.type&signal.interests.entities&signal.interests.tags&filter.exclude.entities&take&feature.explainability=true`; year filters: book uses `filter.publication_year.min/max`, movie/tv_show use `filter.release_year.min/max`, others filter client-side on year. Response `results.entities[]`; affinity = `entity.affinity ?? entity.query?.affinity`; explainability = `entity.query?.explainability`; tags from `entity.tags[]` (`id`, `name`, `type`). `entityTags` → `GET /v2/insights?filter.type=urn:tag&signal.interests.entities=...&take` → `results.tags[]` (`tag_id` or `id`, `name`, `subtype`, `query.affinity`). `searchTags` → `GET /v2/tags?filter.query&feature.semantic_search=true&take` → `results.tags[]`. Parse properties defensively (`release_year`, `publication_year`, `release_date` → year; `description`/`short_description`; `image.url`; `language`; `page_count`). Errors: non-2xx → throw `QlooError(status, message)`; parse both `{error:{message}}` and flat `{message}` bodies. Retry once on 429/5xx after 500 ms.
  - `MockQlooClient` in `src/mock-qloo.ts` with hand-written fixtures in `src/mock-data.ts` (header comment: "Hand-written demo data, not from Qloo"). At least 30 entities across book, podcast, tv_show, movie, videogame (well-known public works: e.g. Spirited Away, Your Name, Persona 5, The Legend of Zelda: Breath of the Wild, Harry Potter and the Philosopher's Stone, Norwegian Wood, Kafka on the Shore, Wonder, Holes, The Little Prince, Studio Ghibli-adjacent books, podcasts like "Hardcore History", "Radiolab", "Stuff You Should Know", "The Moth", "Animated Discussions"-style anime podcasts; TV like "Avatar: The Last Airbender", "Arcane"), each with 3–6 plausible tags from a shared tag set (e.g. coming_of_age, fantasy, magic_school, mystery, japan, slice_of_life, adventure, friendship, history, science, storytelling, dystopia), year, short description, pageCount for books. `search` matches case-insensitively on name and a small alias list (include Japanese aliases such as 千と千尋の神隠し, 君の名は, ノルウェイの森, ペルソナ5, ゼルダの伝説). Unknown queries return []. `insights` ranks entities of the requested type (excluding excluded ids) by tag overlap with the seed entities (+ requested tagIds), affinity = normalized overlap in (0,1], deterministic. `entityTags` aggregates seed tags with affinity by frequency. `searchTags` substring match over the tag set.
  - `createQlooClient(env)` returns `HttpQlooClient` iff `env.QLOO_API_KEY` is a non-empty string, else `MockQlooClient`; also export `qlooMode(env): "live"|"mock"`.
- Tests in `test/`: validation cases; HTTP client builds correct URLs/headers (inject fake fetch, assert URL and `X-Api-Key`), parses search/insights/tags sample payloads (inline JSON in the test matching the shapes in `docs/qloo-api-notes.md`), error parsing, videogame 403 fallback; mock client returns deterministic ranked results and resolves Japanese aliases.

- [x] `src/types.ts`, `src/validate.ts`, `src/qloo.ts`, `src/mock-qloo.ts`, `src/mock-data.ts` exist with the interfaces above
- [x] HttpQlooClient unit tests pass using a fake fetch (URL params, header, parsing, error, 403 fallback)
- [x] MockQlooClient unit tests pass (alias resolution, ranking excludes seeds, deterministic)
- [x] `npx tsc --noEmit` passes

Do NOT implement: the agent pipeline, LLM calls, HTTP routes, frontend.

### Task 2: LLM wrapper and agent pipeline
**Purpose**: the agent that turns favourites into a leveled English plan, with a visible trace.

**Design Context**:
- `src/llm.ts`: `interface Llm { json<T>(opts: { system: string; user: string; schema: object; maxTokens?: number }): Promise<T> }`. `WorkersAiLlm(ai: Ai, model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast")` calls `ai.run(model, { messages: [{role:"system",...},{role:"user",...}], response_format: { type: "json_schema", json_schema: schema }, max_tokens })`; the result's `response` may be an object or a JSON string — handle both; on parse failure retry once, then throw `LlmError`. Keep prompts in `src/prompts.ts`.
- `src/agent.ts`: `runPlan(input: PlanInput, deps: { qloo: QlooClient; llm: Llm; mode: "live"|"mock" }): Promise<PlanResult>`; on failure throws `AgentError { step, message, trace }`. Steps (each pushes a TraceStep with a human-readable `label` and `detail`, and timing):
  1. `normalize` (LLM): for each favourite → `{ query, typeGuess }` (English/official title; typeGuess one of the EntityTypes; respect a user-given type). Schema-constrained JSON array, same order as input.
  2. `resolve` (Qloo search): search `query` with `[type]` take 5; choose exact normalized-name match else first result; if none, retry without types. Unresolved → `warnings` entry ("Couldn't find X") and skip. Zero resolved → AgentError("resolve", "We couldn't find any of these titles…").
  3. `profile` (Qloo entityTags, take 20): keep top 8 by affinity → `profile`.
  4. `recommend` (Qloo insights): formats map read→[book], listen→[podcast], watch→[tv_show, movie]; for each type call insights with entityIds = resolved ids, tagIds = refine tags, excludeIds = resolved ids, take 15, explain true. Drop results whose `language` is set and is not English (`en`/`eng`/`English`).
  5. `level` (LLM, one call): candidates (max 40: id, title, type, year, description truncated to 200 chars, pageCount) + learner level → per id `{ id, cefr: "A2".."C2", reason: string ≤ 120 chars }`. Then select with pure function `selectPicks(candidates, levels, learnerLevel, formats)` in `src/select.ts`: keep cefr within learner−1..learner+1; fit = match/easier/stretch; prefer match then stretch then easier; 6–9 total, ≥2 per selected format when available (round-robin across formats), order easiest first then affinity desc.
  6. `explain` (pure, `src/explain.ts`): `because` = if the entity's `explainability` names a contributing seed id, use that seed's name ("Because you like {name}"); else the seed whose tags overlap most with the pick's tags, mentioning up to 2 shared tag names ("Shares fantasy and coming of age with {name}"); else the highest-affinity statement ("Strong taste match ({affinity%})"). Never invented by the LLM.
  7. `plan` (LLM, one call): 7 days, each `{ day: 1..7, pickId, activity, minutes }` using minutesPerDay, alternating formats, starting with the easiest pick; plus `vocab`: 12 items `{ term, ja, example }` for the day-1 pick. Validate pickIds belong to picks; drop invalid days.
  8. `refine` (only when `input.refine`): before step 4, LLM maps the text to `{ addTags: string[] (≤3 short English phrases), avoidTags: string[] (≤3), minYear?: number, maxYear?: number }`; resolve addTags via `qloo.searchTags(q, 3)` (first hit each) and pass as tagIds; apply avoidTags by dropping candidates whose tag names contain them (case-insensitive) and years via insights filters. Record the mapping in the trace.
- Prompts must say: output English except `ja` gloss (Japanese); be honest that CEFR is an estimate; never claim facts about a title beyond the given description.
- Tests: `test/agent.test.ts` runs the full pipeline with `MockQlooClient` and a `FakeLlm` (returns canned JSON per prompt kind by inspecting a `kind` tag you include in the system prompt); asserts trace step ids in order, 6–9 picks, `because` populated, 7 days, 12 vocab, refine adds tagIds, zero-resolved raises AgentError("resolve"). Unit tests for `selectPicks` and `explain`.

- [x] `src/llm.ts`, `src/prompts.ts`, `src/agent.ts`, `src/select.ts`, `src/explain.ts` implemented as above
- [x] Agent pipeline test with MockQlooClient + FakeLlm passes (trace order, pick count, because, plan, vocab)
- [x] Refine path and zero-resolved error path covered by passing tests
- [x] `selectPicks` and `explain` unit tests pass
- [x] `npx tsc --noEmit` passes

Do NOT implement: HTTP routes, frontend, caching, rate limiting.

### Task 3: Worker routes, caching, rate limit, errors
**Purpose**: a deployable API around the agent.

**Design Context**:
- `src/index.ts` default export `{ fetch(request, env, ctx) }` with `Env { AI: Ai; ASSETS: Fetcher; QLOO_BASE_URL: string; QLOO_API_KEY?: string }`.
- `GET /api/health` → `{ ok: true, mode }`.
- `POST /api/plan` → parse JSON (invalid JSON → 400), `parsePlanInput` (400 `{error}`), rate limit (20 requests/hour per `CF-Connecting-IP`, implemented in `src/ratelimit.ts` with the Cache API as a best-effort counter keyed `https://ratelimit.local/<ip>/<hour>`; on exceed → 429 `{error:"Too many plans this hour, try again later."}`), then `runPlan` with `createQlooClient(env)` wrapped by `CachedQlooClient` (`src/cache.ts`: caches successful GET JSON bodies in `caches.default` for 24h keyed by the request URL — the key header is never part of the cache key or stored data). Success → 200 PlanResult (with `mode`). `AgentError` → 502 `{ error, step, trace }`. Unexpected → 500 `{ error: "Something went wrong" }` and `console.error` the detail (never echo secrets).
- Any other `/api/*` → 404 JSON. Non-API paths fall through to `env.ASSETS.fetch(request)`.
- Responses: `content-type: application/json; charset=utf-8`, `cache-control: no-store`.
- Tests (`test/routes.test.ts`): call the default export's `fetch` with a fake env (fake AI returning canned JSON through `WorkersAiLlm`, no `QLOO_API_KEY` → mock mode, `caches` stubbed with an in-memory implementation on `globalThis`): health returns mock; valid plan returns 200 with picks; invalid body 400; 21st request in the hour 429; unknown api path 404.

- [x] `src/index.ts`, `src/cache.ts`, `src/ratelimit.ts` implemented as above
- [x] Route tests pass (health, 200 plan, 400, 429, 404)
- [x] `npx wrangler deploy --dry-run --outdir /tmp/ttE-dry` succeeds
- [x] `npx tsc --noEmit` passes

Do NOT implement: frontend files, deployment, README.

### Task 4: Frontend (public/)
**Purpose**: a finished, coherent product experience (judged on Design).

**Design Context**:
- Files: `public/index.html`, `public/styles.css`, `public/app.js` (vanilla ES module, no build, no external JS; one Google Font allowed via `<link>`, e.g. "Inter" or system stack). Title "Taste-to-English — learn English through what you already love". Favicon as inline SVG data URI.
- Layout (mobile-first, works at 360px, max content width ~880px): header with product name + one-line pitch ("Tell us 3 things you love. We'll find English books, podcasts and shows that match your taste — at your level."); a mode badge from `/api/health` ("Live Qloo data" or "Demo mode: sample data" in amber).
- Form: up to 5 favourite rows (text input + optional type select: Auto, Book, Movie, TV show, Podcast, Video game, Artist; add/remove row buttons; prefilled placeholders like "Spirited Away", "Persona 5", "Norwegian Wood"); level segmented control A2/B1/B2/C1 with short Japanese hints (英検準2級 ≈ A2, 2級 ≈ B1, 準1級 ≈ B2, 1級 ≈ C1); minutes per day (10/20/30/45); formats checkboxes Read / Listen / Watch (all on by default); a "Try an example" link that fills Spirited Away, Persona 5, Norwegian Wood. Submit button "Build my plan".
- While running: show an "Agent at work" panel with the expected steps (Understanding your favourites → Finding them in Qloo → Reading your taste profile → Searching English works with Qloo → Estimating English level → Writing your 7-day plan) animating as a progress list; when the response arrives, replace with the real `trace` (label + detail + ms), collapsible.
- Results: (1) "Your taste profile" tag chips; (2) "Your English picks" cards grid: type icon (inline SVG), title, year, image if `imageUrl` (lazy, alt text), CEFR badge + fit badge (match / stretch / easier), affinity bar ("Taste match 87%"), `because` line, level reason in muted text; (3) "Your 7-day plan" as a timeline list (Day N, activity, minutes, linked pick title); (4) "Starter vocabulary" table (term / 日本語 / example) with the note "AI-generated — double-check in a dictionary"; (5) Refine box ("e.g. less fantasy, more mystery") that re-submits the same input with `refine`; (6) warnings shown as a dismissible notice.
- Errors: show `error` and failed `step` in a friendly alert with a retry button; 429 message as given.
- Footer: "How it works" (3 bullets: Qloo taste graph finds cross-domain matches; an AI agent estimates English difficulty and writes the plan; nothing personal is stored or sent to Qloo — only titles of public works), "Limits" (Qloo results are aggregate taste patterns, not about you; CEFR levels are estimates), links to GitHub repo (`https://github.com/Class-now/qloo-reading-planner`) and MIT license.
- Accessibility: labels for every input, focus styles, `aria-live="polite"` for the agent panel and results, colour contrast AA, respects `prefers-color-scheme` (light/dark tokens via CSS variables) and `prefers-reduced-motion`.
- Visual style: calm, bookish — warm off-white background, deep ink text, one accent colour (e.g. teal #0f766e), rounded 12px cards, generous spacing. No emoji as icons.
- Escape all server strings before inserting into the DOM (use `textContent`, never `innerHTML` with data).

- [x] `public/index.html`, `public/styles.css`, `public/app.js` implement the flow above against `POST /api/plan` and `GET /api/health`
- [x] No `innerHTML` assignment with server data (grep check) and no external scripts
- [x] `npx wrangler dev` smoke (run on port 8799 because 8787 is used by another local service): `curl -s localhost:8787/` returns the page and `curl -s localhost:8787/api/health` returns `{"ok":true,"mode":"mock"}` (start `npx wrangler dev --port 8787` in the background, check, then stop it)
- [x] All validation commands pass

Do NOT implement: new API fields, accounts, persistence, analytics, service worker.

### Task 5: README for judges and reproducibility
**Purpose**: the repo must explain the project to judges and let anyone run it.

**Design Context**: `README.md` in English with sections: title + one-line pitch + live demo URL placeholder `https://taste-to-english.<subdomain>.workers.dev` (leave a clear TODO marker `DEMO_URL`); The problem (extensive reading/listening for Japanese learners, motivation gap); What it does (user flow); Why Qloo is essential (cross-domain taste graph: a Japanese game → an English podcast; remove Qloo and picks become generic); How Qloo is used (table: endpoint → purpose → params, for `/search`, `/v2/insights` with `filter.type=urn:tag`, `/v2/insights` per media type with `signal.interests.entities` and `feature.explainability`, `/v2/tags` for refine); Example request → result walkthrough with the API key redacted (`X-Api-Key: ***`) using mock-mode output shape, explaining how entities and tags were chosen; Architecture (Worker + Workers AI + Cache API, mermaid diagram); Responsible data handling (only public titles sent to Qloo, no accounts, no storage, server-side key, Qloo results are aggregate patterns, CEFR is an estimate, no Qloo data in the repo); Run it yourself (Node 22+, `npm install`, `npx wrangler dev` runs in mock mode without any key, `npx wrangler secret put QLOO_API_KEY` for live mode, `npm test`); Limits; License (MIT, see LICENSE). Also add `.dev.vars.example` with `QLOO_API_KEY=` (empty).

- [x] `README.md` covers all sections above
- [x] `.dev.vars.example` exists and contains no real value
- [x] All validation commands pass

Do NOT implement: code changes beyond fixing doc-related typos.

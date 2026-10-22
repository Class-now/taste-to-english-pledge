# Devpost submission text (draft, English)

Paste each section into the matching Devpost field. Replace `<DEMO_URL>` and the repo URL if it changes. Everything below is factual about the app; nothing describes a personal story. If you want to add one to Inspiration, write it yourself and only if it is true (a marked slot is left for it).

**Project name:** Taste-to-English

**Tagline (≤ 200 chars):** Turn the anime, games and novels you love into an English reading, listening and watching plan at your level — an agent built on Qloo's cross-domain taste graph.

**Links:** Demo `<DEMO_URL>` (add `?demo=1` for the sample-data demo) · Code https://github.com/Class-now/qloo-reading-planner (MIT)

**Built with:** qloo-api, cloudflare-workers, workers-ai, llama, typescript, javascript, html, css

---

## Inspiration

Japanese learners of English are told to do *extensive reading and listening* (多読・多聴): lots of easy, enjoyable English input. The advice works only if the material is enjoyable, and that is where it breaks down. Graded readers and textbook podcasts rarely match what learners actually love, so motivation fades.

Learners already know their taste, in Japanese: *Spirited Away*, *Persona 5*, Haruki Murakami. What they lack is the bridge from that taste to English material at their level. A general chatbot answers "read Harry Potter" — popular, generic, and not about them. The bridge is cross-domain (a Japanese game → an English podcast; a Ghibli film → an English novel), and that is exactly what Qloo's taste graph models.

<!-- Optional: one or two sentences of your own experience, only if true. -->

## What it does

1. You enter 1–5 favourite works in any language and any medium (films, anime, novels, games, podcasts, artists), your English level (CEFR A2–C1, with Eiken equivalents), minutes per day, and whether you want to read, listen or watch.
2. An agent plans and runs a multi-step pipeline, and you watch it work: every step and every tool call (Qloo endpoint, parameters, result count, time, cache hit) streams into a live trace.
3. You get:
   - **What Qloo matched**: how each favourite resolved in Qloo (e.g. 千と千尋の神隠し → *Spirited Away*, 2001), and the cross-domain jump ("From 1 film, 1 game and 1 book → 4 books, 2 podcasts and 3 shows").
   - **Your taste profile**: the taste tags Qloo associates with your favourites, with affinity.
   - **6–9 English picks** (books, podcasts, TV, films), each with an estimated CEFR level and a "your level / stretch / easier" badge, a *because you like X* line, and a **Why this pick** panel showing Qloo's evidence: which of your favourites drove it (explainability), the taste tags it shares, affinity and popularity.
   - **A 7-day plan** sized to your minutes, easiest first, alternating formats, plus **12 starter words** for day 1 with Japanese glosses.
4. **Refine** in plain words ("less fantasy, more mystery", "only things after 2010"): the agent turns them into Qloo tag signals and year filters and runs again.

## How we built it

- **Backend:** one Cloudflare Worker (TypeScript). The browser never talks to Qloo; the event-issued key is a server-side secret.
- **Qloo Hackathon API** (direct HTTPS with `X-Api-Key`):
  - `GET /search` resolves each favourite to a Qloo entity (typed first, then untyped, preferring exact matches).
  - `GET /v2/insights?filter.type=urn:tag` builds the taste profile from the resolved entities.
  - `GET /v2/insights` per target type (`urn:entity:book`, `podcast`, `tv_show`, `movie`) with `signal.interests.entities`, `filter.exclude.entities` and `feature.explainability=true` produces the candidates and the reasons.
  - `GET /v2/tags` (semantic search) maps refine wishes to real Qloo tag IDs, sent back as `signal.interests.tags`.
  - Results are cached server-side for 24 h, retries are bounded, as the kit's API guide asks.
- **The agent** (`src/agent.ts`) runs: normalize titles (LLM) → resolve (Qloo) → taste profile (Qloo) → optional refine (LLM + Qloo tags) → recommend (Qloo) → estimate English level (LLM) → **self-check** → explain (Qloo data only) → plan + vocabulary (LLM). In the self-check step the agent compares its picks with what you asked for; if a format came up short at your level (say, only one podcast at A2), it decides to query Qloo again for that format, this time adding your taste-profile tags as an extra signal and excluding everything already seen, rates only the new works, and re-selects. The trace shows the reasoning ("Noticed only 1 podcast for A2 → asked Qloo again with your taste tags … → 3 new works, 1 added").
- **LLM:** Meta Llama 3.3 70B on Workers AI, always with JSON-schema output. The LLM **never proposes titles**: candidate IDs are enum-constrained and re-checked, and every "because" line is computed from Qloo data (explainability, then shared tags, then affinity).
- **Frontend:** plain HTML/CSS/JavaScript, no build step. The trace is streamed from the Worker as NDJSON and rendered step by step; nothing from the server is ever inserted as HTML.
- **Reliability:** if Workers AI fails, a deterministic rule-based fallback answers that step (title aliases, CEFR heuristics, a templated plan, a hand-written starter word list); the step is marked "rule-based fallback" and the learner is told the estimates are rough. A **demo mode** (`?demo=1`, or automatically when no key is configured) uses a small hand-written sample set that is labelled as such everywhere.
- **Tests:** 100+ offline unit and route tests (Vitest): Qloo client URL building and parsing, the agent with a fake LLM and the sample client, the streaming endpoint, fallbacks, prompt-injection hardening.

## Challenges we ran into

- **Getting the agent to reveal its work without exposing secrets.** We wrap the Qloo client and the LLM so every call is recorded with the step that made it, then stream those events to the page. The recorded summary is built from the call's arguments, never from the request URL, so the key cannot leak into the trace.
- **Building before the API key arrived.** We developed against the published docs, wrote a hand-made sample dataset with the same shapes, and kept the parser defensive about every field the docs leave unconfirmed (where affinity lives, the explainability format, the videogame type URN). A small smoke-test script checks those points against the live API and prints only field names.
- **Model output you can't fully trust.** Workers AI sometimes returns fewer items than asked, or invalid JSON. Schemas pin array lengths, the agent re-asks for skipped items, falls back to rules when the model is down, strips links from model-written text, and tells the model that user input is data, not instructions.
- **Keeping Qloo central.** It is tempting to let the LLM "just recommend". We kept a hard rule that every title and every reason comes from Qloo, so the result is about the learner's taste, not about what a model thinks is popular.

## Accomplishments that we're proud of

- A visible, honest agent: you see each Qloo call, why the agent made it, and when it decided to search again.
- Cross-domain picks that start from Japanese titles and land on English material, with the evidence one click away.
- It degrades gracefully: no key → labelled sample data; no AI → labelled rule-based estimates; Qloo error → a clear message and a one-click sample-data run.

## What we learned

- Qloo's explainability and taste tags are what make a recommendation explainable to a learner; showing them builds trust more than any generated sentence.
- Clear provenance labels (Qloo data / AI estimate / sample data) matter as much as the features themselves.

## What's next

- Measure difficulty from real text (sample chapters, transcripts) instead of estimating it, where licensing allows.
- Track what the learner finished and liked, and feed that back as Qloo signals for the next week's plan.
- Japanese UI, and more output types (graded readers, YouTube channels) where Qloo has coverage.

## Limitations (what the result does not establish)

- Qloo affinities are aggregate taste patterns, not a statement about the individual learner.
- CEFR levels are estimates (LLM or rule-based), not measured readability. Vocabulary is AI-generated and marked "check in a dictionary".
- Coverage varies: niche Japanese titles may not resolve; the trace says which were skipped.
- The demo mode's sample set is small and hand-written; it shows the flow, not Qloo's real recommendations.

# Decision: call the Qloo Hackathon API directly from the Worker (harness stays an option)

Status: decided 2026-10-22 for the submission. Owner: PM (Shotaro Takakura). Revisit only if an organiser says otherwise.

## Question

The starter kit (`qloo/qloo-hackathon-kit`) presents the `@qloo/qloo-harness` CLI (`qloo explore`, `exec`, `api`, `mcp`) as the way in. Devpost's rules require that the project "integrates the Qloo API". Our backend is a Cloudflare Worker that calls `https://hackathon.api.qloo.com` over HTTPS with the `X-Api-Key` header. Is that acceptable, and should we route through the harness instead?

## What the public sources say (re-read 2026-10-22)

| Source | What it says | How we read it |
|---|---|---|
| Kit `docs/API_ACCESS.md` (read verbatim) | "For the event, the supported surfaces are `qloo explore`, `qloo exec`, `qloo api`, and `qloo mcp`". "All of them use the same credential and count against the same quota." "Each participant must use an event-issued, individually attributable Qloo credential or an organizer-approved authenticated gateway." "Cache only what your project needs, respect the event quota, and make retry behavior bounded." | "Supported" defines what the organisers will help debug. The binding rule is about the **credential**: ours is the event-issued, individual key. Nothing forbids plain HTTPS. |
| Kit `docs/SUBMISSION.md` (verbatim) | Asks for the problem statement, "the Qloo workflow or MCP tools used and why", a redacted request-to-result walkthrough, screenshots without credentials, clean-environment setup, limitations | No transport requirement. The README already has the walkthrough; `docs/submission/devpost.md` covers the rest. |
| Kit `docs/SAFE_USE.md` (summary) | No personal data to Qloo; cite source and limits; affinity is not a claim about a person; treat model output as untrusted; only the read-only `explore` agent mode is supported | We comply: only public titles, IDs and tags go to Qloo; the UI labels Qloo data, AI estimates and sample data separately. |
| Kit MCP starter (P1 research, `docs/qloo-api-notes.md` §6) | "Your web or mobile front end calls your backend; it never calls Qloo directly." "Serverless functions are not a supported route." | We do exactly the first part: the browser never sees the key or Qloo. "Not a supported route" = no organiser support for serverless, not a ban. |
| Qloo developer guide on docs.qloo.com (P1 research) | Shows direct `curl` / Python `requests` calls to `hackathon.api.qloo.com` with `X-Api-Key`; "Your key is valid only against the hackathon base URL" | Direct HTTP is the documented API. |
| Devpost overview / rules | Could not be opened from the build container (DNS failure on every devpost.com host). Search-result summaries say the project must "integrate the Qloo API" and "function as an agentic tool, be built using an agent framework, or wire Qloo into an agent you already have"; no mention of the harness being mandatory | **To re-check in a browser before submitting** (see "Open items"). |

## Decision

1. **Ship the direct server-side integration.** `HttpQlooClient` (`src/qloo.ts`) calls `GET /search`, `GET /v2/insights` (entity and `urn:tag`), and `GET /v2/tags` on `https://hackathon.api.qloo.com` with the event-issued key stored as a Wrangler secret. It already follows the kit's rules: one individual credential, server-side only, cached (24 h), bounded retries (one retry on 429/5xx, 10 s timeout), no bulk scraping.
2. **Keep the harness one step away, not in the hot path.** The harness is a Node CLI, which a Cloudflare Worker cannot run. Two ways to switch, neither needing changes to the agent:
   - **Gateway switch (no code change):** `QLOO_BASE_URL` is a Worker var. If organisers require an "organizer-approved authenticated gateway", point `QLOO_BASE_URL` at it; `HttpQlooClient` sends the same GET requests there.
   - **Harness-backed client (small code change):** everything goes through the `QlooClient` interface (`search`, `insights`, `entityTags`, `searchTags`). A `HarnessQlooClient` running in a small Node backend could implement it by calling `qloo api` (same endpoints, same credential), with the Worker forwarding to it. We have not built it because nothing requires it and it would add a second server to host during judging.
3. **Use the harness for verification.** After the key arrives, the PM can cross-check our calls with the official CLI (`qloo api …` against the same endpoints) in addition to `scripts/qloo-smoke.mjs`. If both agree, the write-up can say the integration was verified with the official tooling. Remember the harness 0.1.26 defaults to `api.qloo.com`; set `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` to `https://hackathon.api.qloo.com` first (see `docs/qloo-api-notes.md` §6).

## Why not the harness by default

- It cannot run inside Workers, so it would mean a second always-on Node server during judging (cost, a second failure point, a second place the key lives).
- It adds a runtime dependency the project rules avoid.
- It brings no data we don't get: the harness's `api` surface calls the same HTTP endpoints with the same key and quota.

## What the submission should say

"Taste-to-English calls the Qloo Hackathon API (`/search`, `/v2/insights` for entities and taste tags, `/v2/tags`) from its Cloudflare Worker with an individual event-issued key kept as a server-side secret. The browser never talks to Qloo. Results are cached server-side and retries are bounded, as the kit's API_ACCESS guide asks."

## Open items (PM, in a browser)

1. Read qloo.devpost.com Rules, FAQ and Resources. Confirm: no rule requires the harness or MCP; judging criteria and any weights; rules on pre-existing projects and third-party code/models.
2. If any rule does require a harness surface or a gateway, use the gateway switch above, or ask on the official channel (draft below). Do not change the code before an organiser answer.

### Draft question to organisers (do not send without the PM's decision)

> Hi! Our project's backend (a Cloudflare Worker) calls https://hackathon.api.qloo.com directly over HTTPS with our individual event-issued key (X-Api-Key header, server-side secret, never in the browser), with caching and bounded retries as API_ACCESS.md describes. We're not using the qloo-harness CLI in production because it can't run on Workers. Is that acceptable for the Agentic Hackathon, or should hosted projects go through one of the harness surfaces or an approved gateway? Thanks!

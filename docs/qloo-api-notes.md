# Qloo Hackathon API notes (for a TypeScript client)

Researched 2026-10-21. Sources read:
- Kit repo `qloo/qloo-hackathon-kit` @ main (README, docs/*, starter/*, manifest.json, discussions #1–#4)
- npm `@qloo/qloo-harness@0.1.26` tarball (dist source read, not executed)
- docs.qloo.com: hackathon developer guide, get-search, get-entities, insights-api-deep-dive (OpenAPI), parameters, available-parameters-by-entity-type, taste-analysis, analysis-compare, get-trending, demographics-use-case, heatmaps-use-case, basic-insights-use-case
- docs MCP server `https://docs.qloo.com/mcp` (`list-endpoints`, `get-endpoint`, `search`, `fetch`; `execute-request` NOT used): /v2/tags, /v2/tags/types, recipes, schema-taxonomy
- Devpost qloo.devpost.com (overview, rules, dates)
- One unauthenticated probe of `https://hackathon.api.qloo.com` (401, see §5)

Anything marked **UNCONFIRMED** was not verified against a live response or an explicit doc statement.

---

## 0. Transport basics

| Item | Value | Source |
|---|---|---|
| Base URL | `https://hackathon.api.qloo.com` | Dev guide. Hackathon keys get a 401 on `api.qloo.com` and `staging.api.qloo.com` |
| Auth | Header `X-Api-Key: <key>`. A query param or `Authorization: Bearer` does not work | Dev guide, OpenAPI `securitySchemes` |
| Method | **GET only**, with params in the query string. A POST with a JSON body to `/v2/insights` fails | Dev guide ("Wrong HTTP Method") |
| Array params | One comma-joined value, e.g. `signal.interests.entities=ID1,ID2` (OpenAPI `style: form, explode: false`). The harness does `arr.join(",")` | OpenAPI + harness `appendQuery` |
| Unknown or invalid params | **Silently ignored**, which can give a 200 with an empty `entities` list. They do not raise an error | Dev guide |
| Field selection | Not supported. You always get the full response, including verbose `akas` | Dev guide FAQ |
| Caching | Private server-side caching is fine, with no time limit. Never put response data in a public repo | Dev guide FAQ |
| Legacy endpoints | `/recommendations` and `/recs` are **not supported** | Dev guide |
| Also not valid | `/v2/insights/search` (do not combine paths) | Dev guide |

Endpoints that exist (docs MCP `list-endpoints` plus the harness client): `GET /`, `/search`, `/entities`, `/v2/insights`, `/v2/tags`, `/v2/tags/types`, `/v2/analysis/compare`, `/v2/trending`. The harness also wraps `/v2/audiences` and `/v2/audiences/types`, but the docs MCP endpoint list does not include them and their reference pages (`get-audiences-1`) currently return 404, so they are **UNCONFIRMED**.

> Note: the task brief mentioned `/analysis` and `/v2/insights/compare`. The documented compare path is **`/v2/analysis/compare`**. No `/v2/insights/compare` or bare `/analysis` was found.

### Entity type URNs

| Our label | URN to send | Notes |
|---|---|---|
| book | `urn:entity:book` | |
| movie | `urn:entity:movie` | |
| tv_show | `urn:entity:tv_show` | |
| podcast | `urn:entity:podcast` | |
| artist | `urn:entity:artist` | Music. `urn:entity:music` returns 403 |
| video game | **`urn:entity:videogame`** | The OpenAPI enums (insights, search, compare, trending), the harness, and schema-taxonomy (`subtype: "urn:entity:videogame"`) all use `videogame`. The hackathon dev guide's list says `urn:entity:video_game`. Which one the hackathon env accepts is **UNCONFIRMED**: use `videogame`, and if you get a 403, retry with `video_game` |

Other insights types: `brand, person, place, locality (partial), destination (listed in the dev guide only), urn:heatmap, urn:tag, urn:demographics, urn:entity:audience (deprecated)`. Search-only legacy types: `urn:entity:actor, album, author, director, locality`. An unsupported type returns **403** "You do not have permission to access urn:entity:...".

---

## 1. Entity search: free text to entity id

`GET /search`

| Param | Type | Notes |
|---|---|---|
| `query` | string | Text to search |
| `types` | comma list of URNs | e.g. `urn:entity:book` or `urn:entity:movie,urn:entity:tv_show` |
| `take` | int | Exclusive max 200 (no documented default; the harness CLI sends 10, its resolver sends 5) |
| `page` | int | 1–100, default 1 |
| `offset` | int | Sent by the harness CLI. Not in the /search OpenAPI (**UNCONFIRMED**) |
| `sort_by` | `match` \| `distance` \| `popularity` | Default `match` |
| `filter.popularity` | number 0–1 | Minimum popularity (a single value here, not `.min`) |
| `filter.tags` + `operator.filter.tags` | comma list; `union`\|`intersection` | |
| `filter.exists` | e.g. `external.resy` | Pattern `^external\.\w+$` |
| `filter.location`, `filter.radius` (miles, default 10, max 100), `filter.rating`, `filter.address` | | Places only |

**Response**: `results` is a **flat array**, not `results.entities` (this is stated in the docs recipe and matches the harness, which reads `response.results` as an array).

```json
{
  "success": true,
  "duration": 0.1,
  "results": [
    {
      "name": "Spirited Away",
      "entity_id": "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX",
      "types": ["urn:entity:movie"],
      "popularity": 0.99,
      "properties": { "release_year": 2001, "description": "...", "image": { "url": "https://images.qloo.com/i/..." } }
    }
  ]
}
```
Values are illustrative. The recipe confirms the fields `name`, `entity_id`, `types` (array), `popularity`, and `properties`. Within `properties`, `release_year`, `release_date`, `description`/`short_description`, and `image.url` are what the harness parses. `type`/`subtype`, `disambiguation`, `tags`, and `external` also appear on insights entities (see §2), but whether `/search` includes them is **UNCONFIRMED**. Parse defensively: the harness takes `subtype ?? type ?? types.find(t => t.startsWith("urn:entity:"))`.

Resolution strategy used by the harness, worth copying:
1. Call `/search?query=<title>&types=<urn>&take=5`.
2. If exactly one candidate's normalized `name` equals the input, it is the match. Otherwise the result is ambiguous, so show the candidates (name, `release_year`/`disambiguation`) to the user.
3. If the input is already a UUID, call `GET /entities?entity_ids=<uuid>` instead.

### Lookup by id or external id: `GET /entities`
- `entity_ids` (comma list of UUIDs), or `external.<source>.ids`, where source is one of `goodreads`, `goodreads_author`, `isbn10`, `isbn13`, `imdb`, `igdb`, `spotify`, `wikidata`, `library_of_congress`, `metacritic`, `rottentomatoes`, `musicbrainz`, `lastfm`, `itunes`, `twitch`, `twitter`, `instagram`, `facebook`, `soundcloud`, `michelin`, `resy`, `tablet`.
  - Useful for books: `external.isbn13.ids=9780...`, `external.goodreads.ids=...`.
- Response: the OpenAPI says `results` is an array. The harness accepts both `results.entities` and `results`, so the exact shape is **UNCONFIRMED** and should be handled both ways.

---

## 2. `GET /v2/insights` (recommendations)

### Core params
| Param | Notes |
|---|---|
| `filter.type` | **Required.** One URN |
| `signal.interests.entities` | Comma list of entity UUIDs (the taste seed) |
| `signal.interests.entities.weight` | Weight of the entity signals. The CLI flag says 0–1, the OpenAPI says `oneOf` number or weight string (**UNCONFIRMED** format) |
| `signal.interests.tags` | Comma list of tag URNs (GET). Weighted `[{tag, weight}]` objects are POST-only, so do not use them |
| `operator.signal.interests.tags` | `union` (any; the highest-affinity tag scores) \| `intersection` |
| `signal.interests.tags.weight` | Influence of the tags |
| `filter.tags` / `operator.filter.tags` | Restrict results to the tags; `union` (default) \| `intersection` |
| `filter.exclude.tags` / `operator.filter.exclude.tags` | Exclude by tag. The entity-type guide spells it `operator.exclude.tags`, while the OpenAPI and harness use `operator.filter.exclude.tags`, so use the latter |
| `filter.exclude.entities` | Comma UUIDs to drop, e.g. the seeds themselves |
| `filter.results.entities` | Score only these UUIDs (rank a shortlist). The harness `rank` uses this with `take = n` |
| `filter.popularity.min` / `.max` | 0–1 percentile. Supported for book, movie, tv_show, podcast, videogame, and artist |
| `filter.parents.types` | Supported for all media types. The OpenAPI enum lists `urn:audience:*` values, while taste-analysis uses it with `urn:entity:*` values (see §3) |
| `filter.external.exists` / `operator.filter.external.exists` | |
| `signal.demographics.age` | `24_and_younger,25_to_29,30_to_34,35_to_44,45_to_54,55_and_older` (also `35_and_younger,36_to_55`) |
| `signal.demographics.gender` | `male` \| `female` |
| `signal.demographics.audiences` (+ `.weight`) | Audience IDs (from `/v2/audiences`, **UNCONFIRMED**) |
| `bias.trends` | `off,very_low,low,mid,medium,high,very_high` (default `medium`) |
| `bias.content_based` | 0–1, default 0.5 |
| `backfill.cross_domain.take` (≤20), `backfill.content_based.take` (≤10) | Backfill when primary results are thin |
| `feature.explainability` | `true` adds the "why" data (see below) |
| `take` | 1–50, default 20 |
| `page` | 1–100, default 1 (recommended pagination) |
| `offset` | Skip N (alternative to `page`) |

### Year, language and country filters, by type (entity-type guide)
- **book**: `filter.publication_year.min/max`. `filter.release_year.*` is NOT listed for book, so it would be silently ignored.
- **movie**: `filter.release_year.min/max`, `filter.release_country` (+ `operator.filter.release_country`), `filter.content_rating`, `filter.rating.min/max`.
- **tv_show**: as movie, plus `filter.finale_year.min/max` and `filter.latest_known_year.min/max`.
- **podcast, videogame, artist**: no year filter is listed. Filter on `properties.release_year`/`release_date` client-side (discussion #4 reports doing exactly this).
- **Language**: no `filter.language` parameter exists. A book's `language` is a property (§2 response), so filter client-side.
- **Country**: `filter.geocode.country_code` (and `filter.geocode.name/admin1_region/admin2_region`, `filter.location.metro`) applies to place-like entities with `properties.geocode`, not to media. For media, use `filter.release_country` (movie/tv) or a location **signal**: `signal.location.query=<locality name>` (fuzzy) or `signal.location=<WKT POINT/POLYGON | locality UUID>`, plus `signal.location.weight`. The harness requires `signal.location` whenever demographics are sent, and that is the documented pattern.

### Example request
```
GET /v2/insights?filter.type=urn:entity:book
  &signal.interests.entities=<HP_ID>,<SPIRITED_AWAY_ID>
  &filter.publication_year.min=1990
  &filter.popularity.max=0.95
  &filter.exclude.entities=<HP_ID>
  &feature.explainability=true
  &take=10&page=1
```

### Response shape (wire format)
The basic-insights example and harness parsing show this structure (values illustrative):
```json
{
  "success": true,
  "results": {
    "entities": [
      {
        "name": "...",
        "entity_id": "UUID",
        "type": "urn:entity",
        "subtype": "urn:entity:book",
        "popularity": 0.998,
        "properties": {
          "description": "...", "short_description": "...",
          "image": { "url": "https://images.qloo.com/i/<UUID>-420x-....jpg" },
          "akas": [{ "value": "...", "languages": ["hu"] }],
          "short_descriptions": [{ "value": "...", "languages": ["cs"] }]
        },
        "tags": [{ "id": "urn:tag:genre:media:fantasy", "name": "Fantasy", "type": "urn:tag:genre:media" }],
        "query": {
          "affinity": 0.93,
          "measurements": { "audience_growth": -0.04 },
          "explainability": { }
        },
        "disambiguation": "2022, Daniel Scheinert, Daniel Kwan",
        "external": {
          "imdb": [{ "id": "tt...", "user_rating": 7.8, "user_rating_count": 549113 }],
          "wikidata": [{ "id": "q..." }]
        }
      }
    ]
  },
  "query": { "explainability": { } },
  "duration": 34
}
```
- **Affinity location**: the harness reads `entity.affinity ?? entity.query.affinity`, and the docs' schema-taxonomy shows a top-level `affinity`. Read both. Affinity is 0–1, and scores from separate calls are not comparable.
- **Explainability**: docs (deep-dive and parameters) describe it as follows. Each result carries `query.explainability`, listing which input entities from `signal.interests.entities` contributed, with normalized 0–1 scores. Contributors ≥0.1 are always included; smaller ones may be omitted. The top-level `query.explainability` holds each input's average influence across top-N subsets (top 3, 5, 10, all). On failure there is a `query.explainability.warning` and results still return. **The exact inner JSON keys are UNCONFIRMED**, so type it as `Record<string, unknown>` until a live response is seen.
- `duration` sits at the top level in the example but under `results.duration` in the OpenAPI, so treat it as optional in both places.

### Per-type `properties` (docs schema-taxonomy page, shown flattened there; on the wire they sit under `properties`, as in the basic-insights example)
- **book**: `description`, `short_description`, `format`, `language`, `page_count` (int), `publication_date` (ISO), `publication_year` (int), `publisher`, `isbn10`, `isbn13`, `series_name`, image URL, `disambiguation` ("YYYY, Author Name"; there is no separate `author` field, the author is embedded here). `title` mirrors `name`. Genre tags are `urn:tag:genre:media:*` (e.g. `fantasy`, `young_adult`, `classics`, `mystery`).
- **movie**: `release_year`, `release_date`, `duration` (min), `content_rating`, `filming_location`, `production_companies[]`, `release_country[]` on the wire (`country_of_origin` in taxonomy, **UNCONFIRMED** which), `websites[]`/`external_links`, `akas`.
- **tv_show**: as movie, plus `finale_year`. `disambiguation` = "premiere, finale".
- **podcast**: `channel`, `rating` (float), `episode_count` (**string**), `release_date` (latest episode), `content_rating` ("clean"/"explicit"), `akas`.
- **videogame**: `developer`, `publisher`, `platforms` (**a string that looks like a JSON array**, e.g. "[PC, Xbox One]"), `release_date`, `release_year`, `content_rating` (ESRB), `franchise_series[]`, `slug`, `akas`.
- **artist**: `short_description`, `date_of_birth`, `year_of_death`, `place_of_birth`, `akas`.
- The image field is `properties.image.url` on the wire (basic-insights example and discussion #4). The taxonomy page shows it as `url`.
- Whether every key above is present in the hackathon dataset is **UNCONFIRMED**. All of them are nullable.

---

## 3. Tags

### 3a. Search the tag ontology: `GET /v2/tags`
| Param | Notes |
|---|---|
| `filter.query` | Partial string match on the tag name |
| `feature.semantic_search` | `true` = semantic match (beta). The harness always sends `true` |
| `feature.typo_tolerance` | Default false |
| `filter.tag.types` | Comma list, exact, e.g. `urn:tag:genre:media`, `urn:tag:keyword:media` |
| `filter.parents.types` | Restrict to tags of an entity category (see note below) |
| `filter.results.tags`, `filter.popularity.min/max` | |
| `take` (1–50, def 20), `page` (1–100) | |

Response: `{ success, duration, results: { tags: [...] } }`. The per-tag fields are not specified in the OpenAPI. The harness tolerates `id` or `tag_id`, `name`, `type` or `subtype`, `popularity`, and `parents[].type`, and filters candidates by `parents[].type === targetEntityUrn`. The exact field set is **UNCONFIRMED**.

`GET /v2/tags/types` lists the tag types per entity type (`filter.parents.types`, `take`, `page`). Its response shape is **UNCONFIRMED**.

### 3b. Taste tags *of an entity* ("taste analysis"): `GET /v2/insights?filter.type=urn:tag`
- Required: `filter.type=urn:tag` plus at least one of `signal.interests.entities`, `signal.interests.tags`, `signal.demographics.audiences`, `signal.location(.query)`, `filter.tag.types`, `filter.parents.types`.
- Useful extras: `filter.tag.types=urn:tag:keyword:media` (themes) or `urn:tag:genre:media`; `filter.parents.types=urn:entity:book` (the taste-analysis doc uses entity URNs here, although the OpenAPI enum lists only `urn:audience:*`; **UNCONFIRMED** which applies); `diversify.by=subtype` + `diversify.take=N` (cap per tag subtype); `take`, `offset`.
- This is exactly the harness `entity_tags` workflow: `filter.type=urn:tag&signal.interests.entities=<ids>&take=N`.
- Response (taste-analysis doc + recipe):
```json
{
  "success": true,
  "results": {
    "tags": [
      {
        "tag_id": "urn:tag:keyword:media:coming_of_age",
        "name": "Coming Of Age",
        "types": ["urn:entity:tv_show", "urn:entity:movie"],
        "subtype": "urn:tag:keyword:media",
        "tag_value": "urn:tag:keyword:media:coming_of_age",
        "query": { "affinity": 0.99 }
      }
    ]
  },
  "duration": 25
}
```
`query` can be `{}` when there is no signal (the doc example). Read `query.affinity` when present.

### 3c. Tags embedded on entities
Insights entities carry `tags: [{ id, name, type }]` (genre, keyword, streaming_service, and so on). Each request is free, with no extra call, but is less ranked than 3b.

---

## 4. Shared taste between entities: `GET /v2/analysis/compare`
| Param | Notes |
|---|---|
| `a.signal.interests.entities` | **Required.** Comma UUIDs, group A |
| `b.signal.interests.entities` | **Required.** Group B |
| `filter.type` | Optional (array of URNs in the OpenAPI) |
| `filter.subtype` | `urn:tag:occupation` \| `urn:tag:genre` |
| `model` | `descriptive` \| `predictive` |
| `take` (1–50, def 20), `page`, `offset` | |
| `filter.location.query`, `filter.entities.query`, … | Also accepted |

The recipe "Compare two brands' audiences" says each side accepts the full insights param set with an `a.`/`b.` prefix, and that the endpoint **always returns tags**. Its documented response:
```json
{
  "duration": 0.42,
  "results": {
    "tags": [
      { "tag_id": "urn:tag:style:qloo:athletic", "name": "Athletic", "type": "urn:tag",
        "subtype": "urn:tag:style:qloo", "popularity": 0.91, "query": { "score": 0.729 } }
    ]
  }
}
```
- There is **no `success` key** in this response (per the recipe). The score is `query.score`, not `affinity`.
- Conflicts: the OpenAPI 200 schema shows `results` as an entity array, and the harness formatter reads both `results.tags` and `results.entities`. Treat the shape as `results.tags[]` with optional `results.entities[]`, **UNCONFIRMED** live.
- Whether `query.score` means "shared" or "differentiating" is not cleanly documented. The harness labels it "Differentiating Tags", while the recipe says "shared tag space". **UNCONFIRMED.** For "why these two books go together", a cheaper and better-documented path is 3b: run a taste-analysis per entity and intersect the `tag_id`s, or run one `urn:tag` call with both IDs as `signal.interests.entities`.

### Trends (optional): `GET /v2/trending`
Required: `filter.type`, `signal.interests.entities` (1 id), `filter.start_date`, `filter.end_date` (YYYY-MM-DD). Also `take`, `page`, `offset`.
Response: `results.trending[]` = `{ date, population_percentile, population_rank, population_rank_velocity, velocity_fold_change, population_percent_delta }`, weekly, newest first.

### Demographics (optional): `filter.type=urn:demographics`
With `signal.interests.entities` and/or `signal.interests.tags`, the response is `results.demographics[] = { entity_id, query: { age: {<bucket>: -1..1}, gender: { male, female } } }`.

---

## 5. Errors, rate limits, pagination, restrictions

**Error bodies**
- Unauthenticated probe (2026-10-21, `hackathon.api.qloo.com`, all four paths tried) returned HTTP **401** with `content-type: text/plain` (not JSON!) and the body:
  `{"error":{"reason":"No API key found in request","message":"Unauthorized","code":401}}`
  Headers included `www-authenticate: apikey realm="key"`, `x-qloo-request-id: <uuid>`, and permissive CORS (`access-control-allow-origin: *`).
- The OpenAPI documents 404 and 429 bodies as a flat `{ code, reason, message }`. Parse both: `body.error?.message ?? body.message ?? body.reason`. Parse the text with `JSON.parse` whatever the content-type says.
- Known statuses (dev guide): 401 wrong base URL or missing header; 403 unsupported `filter.type` ("You do not have permission to access urn:entity:..."); 404 or "No path matching request parameters" for a wrong method or path; a 400-ish "at least one valid signal or filter is required" for freeform strings in `filter.tags`/`signal.interests.tags`; 200 with empty `entities` for params invalid for the type or missing data.
- The request id header is `x-qloo-request-id`. Log it, never the key.

**Rate limits / quota**
- No numbers are published. The dev guide says only that rate and monthly quota limits are "high enough" for typical projects, that they can be raised per user via Discord #api-help, and that keys stay active through judging and are deactivated after the hackathon. Kit discussions #1 and #2 asking for numbers are unanswered. **Exact limits UNCONFIRMED.**
- A 429 is documented. Harness client behavior worth mirroring: timeout 20 s, max 3 attempts, retry on `429, 500, 502, 503, 504` and network errors, honor `Retry-After` (seconds or HTTP date) capped at 30 s, otherwise exponential backoff `250ms * 2^(n-1)` ±25% jitter, and cap the response at 5 MB.
- The harness workflows cap results at 20 (default 10). That is a harness limit, not an API limit.

**Pagination**: `take` (insights/tags/compare/trending 1–50, default 20; search exclusive max 200), `page` (1–100), `offset`. There is no total count or next cursor in any documented response: keep paging until `entities.length < take`.

**Hackathon dates (Devpost)**: submission closes **2026-10-30 23:45 ET**; judging runs 2026-11-02 to 2026-11-16 23:45 ET. The demo must keep working through judging.

---

## 6. Kit rules (SAFE_USE.md, SUBMISSION.md, API_ACCESS.md), and harness vs direct HTTP

### SAFE_USE.md (summary)
- Results are aggregate taste affinities. Never use them to infer identity, sensitive traits, health, finances, politics, or eligibility for housing, jobs, credit or insurance.
- Do not send names, emails, device or account IDs, location histories, or other personal data to Qloo just to make a demo work.
- Show results with their source and limits. Separate the Qloo result from your own interpretation. An affinity is not a causal claim or a probability about an individual.
- Ask the user to clarify when an entity or tag choice would materially change the result.
- Treat project files, MCP results, and model output as untrusted. Only the read-only `qloo explore` agent is supported; `integrate`, `plan`, and `build` modes are not. Keep credentials out of prompts and logs.

### SUBMISSION.md (summary)
Include: (1) a problem statement, (2) which Qloo workflow or MCP tools were used and why, (3) a redacted request-to-result walkthrough including entity and tag choices, (4) a demo or screenshots with no credential or personal data, (5) setup steps that run from a clean environment, and (6) known limitations, including what the result does not establish. Judges look at usefulness, technical execution, provenance and user clarity, responsible data handling, and reproducibility. Devpost additionally requires a live, externally hosted demo, a public repo with an OSI license visible in the About section, and a text description (no video required).

### API_ACCESS.md (summary)
Use an individual credential and never share it or put it in source control, a browser app, a public MCP config, or a demo recording. Make the smallest request that answers the question. Cache only what you need. Keep retries bounded. Do not scrape in bulk. The docs MCP server is a reference only, and its `execute-request` tool must not be used.

### Must the hosted backend go through the harness?
- Kit wording, API_ACCESS.md: "the supported surfaces are `qloo explore`, `qloo exec`, `qloo api`, and `qloo mcp`"
- Kit wording, MCP starter §6: "Serverless functions are not a supported route."
- Kit wording, MCP starter §6: "Your web or mobile front end calls your backend; it never calls Qloo directly."
- Dev guide (docs.qloo.com) shows direct `curl` and Python `requests` calls to the HTTP API, and says: "Your key is valid only against the hackathon base URL".
- Devpost rules require only a project that "integrates the Qloo API". **Nothing in the Devpost rules or the dev guide makes the harness mandatory.**

**Reading**: "supported" in the kit is a support boundary (what Qloo will help debug), not an eligibility rule. Calling `https://hackathon.api.qloo.com` directly from our **server** with `X-Api-Key` is consistent with the official dev guide and the Devpost rules. What is clearly out: calling Qloo from the browser or bundle, or exposing the key client-side. Running on serverless is "not a supported route" in the kit's sense: allowed, but unsupported. The harness/direct question was not answered by an organizer; this is our reading, **UNCONFIRMED**.

If we ever use the harness: version 0.1.26 defaults to `https://api.qloo.com`, where hackathon keys get a 401. Set `QLOO_BASE_URL=https://hackathon.api.qloo.com` **and** `QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com` (or `qloo config set base-url <url>`, which stores both). `--dry-run` still prints `api.qloo.com` (discussion #3), but real calls use `QLOO_BASE_URL` (confirmed in the `createClient` source).

---

## 7. Minimal TS client sketch (direct HTTP)

```ts
const BASE = "https://hackathon.api.qloo.com";
type Q = Record<string, string | number | boolean | string[] | undefined>;

async function qloo<T>(path: string, q: Q, key = process.env.QLOO_API_KEY!): Promise<T> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const res = await fetch(url, { headers: { "X-Api-Key": key, Accept: "application/json" } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = body?.error?.reason ?? body?.message ?? body?.reason ?? res.statusText;
    throw Object.assign(new Error(`Qloo ${res.status}: ${msg}`), {
      status: res.status, requestId: res.headers.get("x-qloo-request-id"),
      retryable: [429, 500, 502, 503, 504].includes(res.status),
      retryAfter: res.headers.get("retry-after"),
    });
  }
  return body as T;
}

// search: results is a flat array
qloo<{ results: QlooEntity[] }>("/search", { query: "Spirited Away", types: "urn:entity:movie", take: 5 });
// recommendations
qloo<{ results: { entities: QlooEntity[] }; query?: { explainability?: unknown } }>("/v2/insights", {
  "filter.type": "urn:entity:book", "signal.interests.entities": [id1, id2],
  "filter.publication_year.min": 1990, "feature.explainability": true, take: 10,
});
// taste tags of an entity
qloo<{ results: { tags: QlooTag[] } }>("/v2/insights", {
  "filter.type": "urn:tag", "signal.interests.entities": [id1], "filter.tag.types": "urn:tag:keyword:media", take: 15,
});

interface QlooEntity {
  entity_id: string; name: string;
  type?: string; subtype?: string; types?: string[];
  popularity?: number; affinity?: number;
  properties?: Record<string, unknown> & { image?: { url?: string }; release_year?: number; publication_year?: number; description?: string; short_description?: string };
  tags?: { id: string; name: string; type: string }[];
  query?: { affinity?: number; explainability?: unknown; measurements?: Record<string, number> };
  disambiguation?: string;
  external?: Record<string, Array<Record<string, unknown> & { id: string }>>;
}
interface QlooTag { tag_id?: string; id?: string; name: string; subtype?: string; type?: string; types?: string[]; popularity?: number; query?: { affinity?: number; score?: number } }
```

## UNCONFIRMED checklist (verify with the first live key)
1. `urn:entity:videogame` vs `urn:entity:video_game` on the hackathon env.
2. The exact JSON keys inside `query.explainability`, per result and top-level.
3. Whether `affinity` is top-level or under `query.affinity` on media insights results.
4. The `/search` per-result fields beyond name, entity_id, types, popularity, properties.
5. The `/entities` response shape (`results[]` vs `results.entities[]`).
6. The `/v2/tags` per-tag fields (`id` vs `tag_id`, `parents`).
7. `/v2/analysis/compare`: the real shape and whether `query.score` means shared or differentiating.
8. `filter.parents.types` accepting `urn:entity:*` on `/v2/tags` and `urn:tag` insights.
9. Rate-limit and quota numbers; `/v2/audiences` availability.
10. Book `properties` key coverage (author is only inside `disambiguation`?) in the hackathon dataset.

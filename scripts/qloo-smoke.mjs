#!/usr/bin/env node
// Live smoke test for the Qloo hackathon API, run once the key has arrived.
// Makes the same kinds of GET calls the Worker makes and prints only status codes, counts and
// field *names*, never response values, so the output is safe to paste into an issue or chat.
//
//   QLOO_API_KEY=... node scripts/qloo-smoke.mjs          (or put the key in .dev.vars)
//
// No dependencies; Node 22+.
import { readFileSync } from "node:fs";

const BASE = process.env.QLOO_BASE_URL || "https://hackathon.api.qloo.com";
let key = process.env.QLOO_API_KEY;
if (!key) {
  try {
    key = /^QLOO_API_KEY\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(".dev.vars", "utf8"))?.[1];
  } catch {
    // no .dev.vars
  }
}
if (!key || !key.trim()) {
  console.error("Set QLOO_API_KEY (environment or .dev.vars) first.");
  process.exit(2);
}

async function get(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  const started = Date.now();
  const res = await fetch(url, { headers: { "X-Api-Key": key.trim(), Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const shown = `${path}?${[...url.searchParams.keys()].join("&")}`;
  console.log(`${res.status} ${Date.now() - started}ms ${shown} request-id=${res.headers.get("x-qloo-request-id") ?? "-"}`);
  return { status: res.status, body };
}

const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort().join(",") : String(o));
let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

// 1. search (flat results array)
const s = await get("/search", { query: "Spirited Away", types: "urn:entity:movie", take: 5 });
const results = Array.isArray(s.body?.results) ? s.body.results : [];
check(s.status === 200 && results.length > 0, `search returned ${results.length} results; first result fields: ${keysOf(results[0])}`);
const seed = results[0]?.entity_id;

// 2. videogame URN (UNCONFIRMED: videogame vs video_game)
for (const urn of ["urn:entity:videogame", "urn:entity:video_game"]) {
  const g = await get("/search", { query: "Persona 5", types: urn, take: 3 });
  console.log(`  INFO ${urn}: HTTP ${g.status}, ${Array.isArray(g.body?.results) ? g.body.results.length : 0} results`);
}

if (seed) {
  // 3. taste tags of an entity
  const t = await get("/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": seed, "filter.tag.types": "urn:tag:genre:media,urn:tag:keyword:media", take: 10 });
  const tags = t.body?.results?.tags ?? [];
  check(t.status === 200 && tags.length > 0, `urn:tag insights returned ${tags.length} tags; tag fields: ${keysOf(tags[0])}; query fields: ${keysOf(tags[0]?.query)}`);

  // 4. recommendations with explainability, per type the app uses
  for (const type of ["urn:entity:book", "urn:entity:podcast", "urn:entity:tv_show", "urn:entity:movie"]) {
    const r = await get("/v2/insights", { "filter.type": type, "signal.interests.entities": seed, "filter.exclude.entities": seed, "feature.explainability": true, take: 5 });
    const ents = r.body?.results?.entities ?? [];
    const e = ents[0];
    check(r.status === 200 && ents.length > 0, `${type}: ${ents.length} entities; affinity at ${e?.affinity !== undefined ? "top level" : e?.query?.affinity !== undefined ? "query.affinity" : "missing"}; explainability fields: ${keysOf(e?.query?.explainability)}; properties: ${keysOf(e?.properties)}`);
  }

  // 5. tag search used by refine
  const ts = await get("/v2/tags", { "filter.query": "mystery", "feature.semantic_search": true, "filter.tag.types": "urn:tag:genre:media,urn:tag:keyword:media", take: 3 });
  const found = ts.body?.results?.tags ?? [];
  check(ts.status === 200 && found.length > 0, `tag search returned ${found.length} tags; fields: ${keysOf(found[0])}`);
}

console.log(failures ? `\n${failures} check(s) failed. Paste this output (it contains no key or response values) into the issue.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);

# License check (2026-10-22)

Summary: the repo is MIT and everything we ship or call is compatible. One obligation applies to the deployed app: **Meta Llama 3.3 requires "Built with Llama" attribution**, which the footer shows.

## Our code

| Item | License | Notes |
|---|---|---|
| This repository | MIT (`LICENSE`, © 2026 Shotaro Takakura) | OSI-approved. Devpost asks for an open-source license visible on the repo's About section: check it shows there. |
| `src/mock-data.ts` | MIT (ours) | Hand-written approximations of well-known public works. Titles are facts; descriptions are our own words; tags and popularity numbers are invented for the demo. No Qloo response data is in the repo. |

## What the deployed app runs or loads

| Item | License / terms | What it means for us |
|---|---|---|
| Meta Llama 3.3 70B (via Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) | Llama 3.3 Community License + Acceptable Use Policy | Allowed for this use. The license asks products built with it to "prominently display 'Built with Llama'" on a related website/UI or documentation: the footer and README do. The 700M monthly-user clause doesn't apply. We don't ship weights. |
| Cloudflare Workers, Workers AI, Workers Assets, Cache API | Cloudflare terms of service | Hosting, no license obligation for our code. |
| Qloo Hackathon API | Qloo hackathon terms, kit `API_ACCESS.md` / `SAFE_USE.md` | Key server-side only; responses cached privately, never committed; no personal data sent; results labelled as aggregate patterns. Cover image URLs from Qloo (`images.qloo.com`) are shown as links-in-place (hotlinked with `referrerpolicy=no-referrer`), not stored. |
| Inter font (Google Fonts, loaded by URL) | SIL Open Font License 1.1 | Use on web pages is allowed; we don't redistribute the files. |

## Development-only dependencies (not deployed)

`package.json` has no runtime `dependencies`. The Worker bundle contains only our code.

| Package | License |
|---|---|
| wrangler 4.x | MIT OR Apache-2.0 |
| @cloudflare/workers-types | MIT OR Apache-2.0 |
| typescript 5.9 | Apache-2.0 |
| vitest 3.2 | MIT |

Transitive devDependencies in `node_modules` (counted 2026-10-22): MIT 68, Apache-2.0 7, MIT OR Apache-2.0 4, ISC 3, BSD-3-Clause 1, 0BSD 1, CC0-1.0 1, and `@img/sharp-libvips-*` under LGPL-3.0-or-later (a prebuilt image library pulled in by wrangler/miniflare). LGPL is fine here: it is only installed for local tooling, is not modified, and is not part of what we distribute or deploy.

Tools used only in the build container for screenshots (Playwright, Chromium) are not dependencies of the repo.

## To do before submitting

- [ ] GitHub repo About shows "MIT license".
- [ ] Footer "Built with Llama" link is present on the deployed page.

# Next steps for the PM: deploy, add the Qloo key, verify, submit

Written 2026-10-22. Deadline: Devpost submission closes **2026-10-30 23:45 EDT = 2026-10-31 12:45 JST**. Internal targets: demo public by **10/29**, description final on **10/30**. Judging runs 11/02–11/16 (ET); the demo must stay up through then.

Commands are for **Windows PowerShell** in the repo folder. Nothing here needs the Qloo key until step 3.

## 1. One-time setup

```powershell
node --version            # needs 22 or newer
git checkout main         # after the p2-polish PR is merged (or p2-polish to test it first)
npm ci
npx wrangler login        # opens the browser; use the Cloudflare account that will host the demo
npx tsc --noEmit
npx vitest run            # all tests are offline; no key, no network
```

## 2. Deploy the demo now, in sample-data mode

The app runs without a Qloo key: it uses the hand-written sample set and says so in the UI.

```powershell
npx wrangler deploy
```

On a Cloudflare account that has never used Workers, wrangler first asks you to pick a `*.workers.dev` subdomain (once per account). Wrangler prints the URL, e.g. `https://taste-to-english.<your-subdomain>.workers.dev`. Then:

```powershell
curl.exe -s https://taste-to-english.<your-subdomain>.workers.dev/api/health
# {"ok":true,"mode":"mock"}
```

Open the URL, click **Try an example**, **Build my plan**. You should see the live agent trace, picks, the 7-day plan and starter words. In the deployed app Workers AI answers the AI steps; if it fails, the steps are marked "rule-based fallback" and the plan still completes.

Then:
- Replace the `DEMO_URL` placeholder at the top of `README.md` with the real URL (commit on a branch and open a PR).
- On GitHub, repo **About** → set the website to the demo URL and check that the MIT license shows. Devpost requires a public repo with a visible open-source license.

## 3. When the Qloo key arrives

Secret name: **`QLOO_API_KEY`** (the only secret). The var `QLOO_BASE_URL` stays `https://hackathon.api.qloo.com`.

Never paste the key into a chat, an issue, a commit, a screenshot or a video.

### 3a. Check the key locally first

```powershell
Copy-Item .dev.vars.example .dev.vars
notepad .dev.vars          # QLOO_API_KEY=<your key>   (.dev.vars is gitignored)
node scripts/qloo-smoke.mjs
```

`qloo-smoke.mjs` calls the same endpoints as the app and prints only status codes, counts and field names (no key, no response values), so its output is safe to share with the dev side. It checks the open questions from `docs/qloo-api-notes.md`:

| Line in the output | What to look for |
|---|---|
| `search returned N results` | N > 0 |
| `INFO urn:entity:videogame / video_game` | Which one returns 200. The client already retries `video_game` after a 403 |
| `urn:tag insights returned N tags` | N > 0; the taste profile comes from this |
| `urn:entity:book / podcast / tv_show / movie` | N > 0 each; note where `affinity` is and the `explainability fields` |
| `tag search returned N tags` | N > 0; refine uses this |

If any line says FAIL, or the explainability fields list is empty, send the whole output to the dev side. Do not change code yourself.

Optional cross-check with the official harness (only for verification, see `docs/qloo-integration-decision.md`): install `@qloo/qloo-harness`, run `qloo setup --qloo`, set the base URL to `https://hackathon.api.qloo.com` (`qloo config set base-url https://hackathon.api.qloo.com`), and call the same endpoints with `qloo api` (check `qloo api --help` for the exact syntax).

### 3b. Try the full app locally in live mode

```powershell
npx wrangler dev --port 8799     # 8787 is taken on your machine; uses .dev.vars, so live mode
```

Open http://localhost:8799 → the badge says **Live Qloo data**. Run the example and two or three of your own favourites (e.g. Japanese titles). In the agent trace, tool calls should carry the **live Qloo** badge. Each pick's **Why this pick** panel should list your favourites with percentages (this comes from Qloo explainability). If the panels show only shared tags and never favourites, tell the dev side (the explainability format differs from the docs).

### 3c. Put the key on the deployed Worker

```powershell
npx wrangler secret put QLOO_API_KEY      # paste the key when asked; it is not echoed
curl.exe -s https://taste-to-english.<your-subdomain>.workers.dev/api/health
# {"ok":true,"mode":"live"}
```

`secret put` deploys a new version with the secret straight away; no separate `wrangler deploy` is needed. Run the example on the deployed URL once more.

### 3d. Post-key checklist

- [ ] `/api/health` says `live` on the deployed URL
- [ ] Example run completes; trace shows live Qloo calls; second run shows `cached` badges
- [ ] **Try with sample data** button (shown after an error in live mode) and `?demo=1` both still work
- [ ] Rate limit: the 31st plan in an hour from one IP gets the "Too many plans" message. On `*.workers.dev` the Cache API may not persist, so this can fail; if it does, it's a known limit (README → Limits), or move the Worker to a custom domain
- [ ] Workers AI usage in the Cloudflare dashboard (AI → Workers AI) looks sane. The free allocation is per day; if it runs out, the app keeps working with rule-based estimates and says so
- [ ] Take final screenshots with live data (the ones in `docs/screenshots/` use the sample set and the offline AI fallback)

## 4. Submit on Devpost (by 10/31 12:45 JST)

- **Make the repo public first** (it is private now, so the footer's "Source on GitHub" link and Devpost's open-source check fail until then): `gh repo edit Class-now/qloo-reading-planner --visibility public --accept-visibility-change-consequences`. History was scanned with gitleaks on 2026-10-22 (no leaks); re-run `gitleaks git .` if commits were added since.
- Text: `docs/submission/devpost.md` (paste section by section; fill in the demo URL).
- Video (optional on Devpost, recommended): script in `docs/submission/video-script.md`, under 3 minutes. Record with live data if the key works, otherwise with `?demo=1` and say it is sample data.
- Screenshots: `docs/screenshots/` (sample data; retake with live data if possible).
- Re-read the Devpost Rules/FAQ in a browser first (the build container could not open devpost.com): see "Open items" in `docs/qloo-integration-decision.md`.

## 5. If something breaks during judging

```powershell
npx wrangler deployments list
npx wrangler rollback            # back to the previous version
npx wrangler tail                # live logs; upstream errors are logged without the key
```

If Qloo is down or the key is revoked, the app shows a clear error and a **Try with sample data** button; `?demo=1` always works without Qloo.

## Reference

| Name | Kind | Where | Notes |
|---|---|---|---|
| `QLOO_API_KEY` | secret | `npx wrangler secret put` / `.dev.vars` locally | Its presence switches to live mode |
| `QLOO_BASE_URL` | var | `wrangler.jsonc` | `https://hackathon.api.qloo.com`; point at an approved gateway only if organisers require one |
| `AI` | Workers AI binding | `wrangler.jsonc` | Needs a Cloudflare login even for local dev |
| `wrangler.offline.jsonc` | config | repo root | Local demo with no AI binding and no login: `npm run dev:offline` |

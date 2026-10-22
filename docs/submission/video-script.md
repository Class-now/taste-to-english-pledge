# Demo video script (target 2:40, hard limit 3:00)

Record the deployed app with live Qloo data if the key works; otherwise use `?demo=1` and say so on screen. Screen only, English narration (or English subtitles over Japanese narration). No real names, no key, no browser bookmarks/tabs with personal info. Zoom the browser to 110–125 %.

| Time | Screen | Narration (draft) |
|---|---|---|
| 0:00–0:15 | Title card: "Taste-to-English", subtitle "built on Qloo's taste graph" | "Japanese learners of English are told to read and listen to lots of English they enjoy. But what do you read, if what you love is Spirited Away, Persona 5 and Murakami?" |
| 0:15–0:30 | The empty form, then **Try an example**; change one title to 千と千尋の神隠し | "Taste-to-English starts from what you already love, in any language. I'll type Japanese titles, pick level B1, twenty minutes a day, and all three formats." |
| 0:30–1:05 | Click **Build my plan**; the trace streams in. Expand "Finding them in Qloo" and "Searching English works with Qloo" to show tool calls | "An agent takes over, and you can watch every step. It turns my titles into search queries, finds them in Qloo with the search endpoint, reads my taste profile from Qloo's taste tags, then asks Qloo Insights for English books, podcasts and shows, with explainability turned on. Every call is listed: endpoint, parameters, how many results, and whether it came from cache." |
| 1:05–1:25 | Scroll to the "Checking the plan and filling gaps" step (if it widened, show that text; otherwise run A2 + Listen beforehand and cut to it) | "Then it checks its own work. Here, only one podcast fit my level, so it decided to ask Qloo again, this time adding my taste tags as a signal, and filled the gap." |
| 1:25–1:55 | "What Qloo matched" strip, taste profile chips, then one pick card → open **Why this pick** | "The result: from one film, one game and one novel to English books, podcasts and shows. Each pick has an estimated CEFR level and whether it's a stretch. And 'Why this pick' shows Qloo's evidence: which of my favourites drove it, and the taste tags they share. The AI never invents titles or reasons — those come from Qloo." |
| 1:55–2:15 | 7-day plan and starter vocabulary; click **Copy plan** | "Then a seven-day plan sized to my time, easiest first, and twelve starter words for day one with Japanese glosses — marked as AI-generated." |
| 2:15–2:35 | Type "less fantasy, more mystery" → **Refine**; show the refine step in the trace | "I can steer it in plain words. The agent maps 'more mystery' to a real Qloo tag and runs again." |
| 2:35–2:50 | Footer / "Limits"; optionally a quick flash of the demo-mode badge | "It sends Qloo only public titles, keeps the key on the server, and labels what is Qloo data, what is an AI estimate, and what is sample data." |
| 2:50–3:00 | Title card with demo URL and GitHub URL | "Taste-to-English: learn English through what you already love." |

Checklist before recording:
- [ ] Run the example once beforehand so Qloo results are cached (faster, smoother video).
- [ ] Decide which run shows the self-check widening (A2 + Listen with the example titles triggers it in demo mode; with live data, try a few combinations first).
- [ ] No `.dev.vars`, terminal or Cloudflare dashboard visible.
- [ ] Say "sample data" if recording in demo mode.

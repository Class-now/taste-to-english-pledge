// Taste-to-English frontend. Vanilla ES module, no build step.
// All server-provided strings go into the DOM via textContent / attributes only.

const MAX_FAVORITES = 5;
const PLACEHOLDERS = ["Spirited Away", "Persona 5", "Norwegian Wood", "Arcane", "Radiolab"];
const EXAMPLE = [
  { title: "Spirited Away", type: "movie" },
  { title: "Persona 5", type: "videogame" },
  { title: "Norwegian Wood", type: "book" },
];
const TYPE_OPTIONS = [
  ["", "Auto"],
  ["book", "Book"],
  ["movie", "Movie"],
  ["tv_show", "TV show"],
  ["podcast", "Podcast"],
  ["videogame", "Video game"],
  ["artist", "Artist"],
];
const TYPE_LABELS = Object.fromEntries(TYPE_OPTIONS.filter(([v]) => v));
const EXPECTED_STEPS = [
  "Understanding your favourites",
  "Finding them in Qloo",
  "Reading your taste profile",
  "Searching English works with Qloo",
  "Estimating English level",
  "Writing your 7-day plan",
];
const FIT_LABELS = { match: "Your level", stretch: "Stretch", easier: "Easier" };

// Inline SVG paths (24x24 stroke icons) per entity type.
const ICONS = {
  book: ["M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z", "M4 19V5", "M8 7h6"],
  podcast: ["M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  tv_show: ["M3 6h18v12H3z", "M8 21h8", "M8 2l4 4 4-4"],
  movie: ["M3 5h18v14H3z", "M7 5v14", "M17 5v14", "M3 9h4", "M3 15h4", "M17 9h4", "M17 15h4"],
  videogame: ["M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z", "M7 11v3", "M5.5 12.5h3", "M16 12h.01", "M18 13.5h.01"],
  artist: ["M9 18V5l11-2v13", "M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z", "M20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"],
  check: ["M5 12.5l4.5 4.5L19 7"],
};

const $ = (id) => document.getElementById(id);
const els = {
  form: $("plan-form"),
  favorites: $("favorites"),
  addFav: $("add-fav"),
  example: $("example-btn"),
  submit: $("submit-btn"),
  formError: $("form-error"),
  modeBadge: $("mode-badge"),
  agentPanel: $("agent-panel"),
  agentTitle: $("agent-title"),
  agentSteps: $("agent-steps"),
  traceToggle: $("trace-toggle"),
  errorBox: $("error-box"),
  errorMsg: $("error-msg"),
  errorStep: $("error-step"),
  retry: $("retry-btn"),
  results: $("results"),
  warnings: $("warnings"),
  warningsList: $("warnings-list"),
  dismissWarnings: $("dismiss-warnings"),
  profile: $("profile"),
  picks: $("picks"),
  plan: $("plan"),
  vocab: $("vocab"),
  refineForm: $("refine-form"),
  refineInput: $("refine-input"),
  vocabNote: $("vocab-note"),
  planBlock: $("plan-block"),
  vocabBlock: $("vocab-block"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let lastRequest = null;
let busy = false;
let progressTimer = null;
let rowSeq = 0;

// ---------- DOM helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else if (k in node && typeof v !== "string") node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name] || ICONS.book) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

function clear(node) {
  node.replaceChildren();
}

function scrollIntoViewIfNeeded(node) {
  const rect = node.getBoundingClientRect();
  if (rect.top < 0 || rect.top > window.innerHeight * 0.6) {
    node.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }
}

// ---------- Mode badge ----------

async function loadMode() {
  try {
    const res = await fetch("/api/health", { headers: { accept: "application/json" } });
    const data = await res.json();
    setMode(data && data.mode);
  } catch {
    // Badge is informational; leave it hidden if health is unreachable.
  }
}

function setMode(mode) {
  if (mode !== "live" && mode !== "mock") return;
  els.modeBadge.textContent = mode === "live" ? "Live Qloo data" : "Demo mode: sample data";
  els.modeBadge.className = `mode-badge ${mode}`;
  els.modeBadge.title = mode === "live"
    ? "Recommendations come from the Qloo Taste AI API."
    : "No Qloo API key configured: results use a small hand-written sample set.";
  els.modeBadge.hidden = false;
}

// ---------- Favourite rows ----------

function addFavoriteRow(value = { title: "", type: "" }) {
  const n = els.favorites.children.length;
  if (n >= MAX_FAVORITES) return null;
  const id = ++rowSeq;
  const titleId = `fav-title-${id}`;
  const typeId = `fav-type-${id}`;

  const title = el("input", {
    id: titleId, type: "text", name: "title", maxlength: "80", autocomplete: "off",
    placeholder: PLACEHOLDERS[n] || "Another favourite",
  });
  title.value = value.title || "";

  const type = el("select", { id: typeId, name: "type" });
  for (const [v, label] of TYPE_OPTIONS) type.append(el("option", { value: v, text: label }));
  type.value = value.type || "";

  const remove = el("button", { type: "button", class: "icon-btn", "aria-label": "Remove this favourite" });
  remove.append(svgClose());
  remove.addEventListener("click", () => {
    li.remove();
    syncRows();
    const first = els.favorites.querySelector("input");
    if (first) first.focus();
  });

  const li = el("li", { class: "fav-row" },
    el("div", { class: "fav-fields" },
      el("div", {},
        el("label", { for: titleId, class: "sr-only", text: "Favourite title" }),
        title),
      el("div", {},
        el("label", { for: typeId, class: "sr-only", text: "Type" }),
        type)),
    remove);
  els.favorites.append(li);
  syncRows();
  return title;
}

function svgClose() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", "M6 6l12 12M18 6L6 18");
  svg.append(p);
  return svg;
}

function syncRows() {
  const rows = [...els.favorites.children];
  rows.forEach((row, i) => {
    const input = row.querySelector("input");
    const label = row.querySelector("label");
    label.textContent = `Favourite ${i + 1} title`;
    input.placeholder = PLACEHOLDERS[i] || "Another favourite";
    row.querySelector("select").previousElementSibling.textContent = `Favourite ${i + 1} type`;
    row.querySelector(".icon-btn").disabled = rows.length <= 1;
  });
  els.addFav.disabled = rows.length >= MAX_FAVORITES;
}

function fillExample() {
  clear(els.favorites);
  for (const f of EXAMPLE) addFavoriteRow(f);
  hideFormError();
}

// ---------- Input ----------

function readInput() {
  const favorites = [];
  for (const row of els.favorites.children) {
    const title = row.querySelector("input").value.trim();
    const type = row.querySelector("select").value;
    if (!title) continue;
    favorites.push(type ? { title, type } : { title });
  }
  const level = els.form.querySelector('input[name="level"]:checked')?.value || "B1";
  const minutesPerDay = Number(els.form.querySelector('input[name="minutes"]:checked')?.value || 20);
  const formats = [...els.form.querySelectorAll('input[name="formats"]:checked')].map((i) => i.value);

  if (favorites.length === 0) return { error: "Add at least one thing you love — or try the example." };
  if (formats.length === 0) return { error: "Choose at least one format: Read, Listen or Watch." };
  return { value: { favorites, level, minutesPerDay, formats } };
}

function showFormError(msg) {
  els.formError.textContent = msg;
  els.formError.hidden = false;
}

function hideFormError() {
  els.formError.hidden = true;
}

// ---------- Agent panel ----------

function startProgress() {
  stopProgress();
  els.agentTitle.textContent = "Agent at work";
  els.traceToggle.hidden = true;
  els.agentSteps.hidden = false;
  clear(els.agentSteps);
  const items = EXPECTED_STEPS.map((label) => {
    const li = el("li", { class: "agent-step pending" },
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { class: "label", text: label }),
      el("span", { class: "ms" }));
    els.agentSteps.append(li);
    return li;
  });
  let i = 0;
  const advance = () => {
    items.forEach((li, j) => {
      li.className = `agent-step ${j < i ? "done" : j === i ? "active" : "pending"}`;
      const dot = li.querySelector(".dot");
      if (j < i && !dot.firstChild) dot.append(icon("check"));
    });
    if (i < items.length - 1) i += 1;
  };
  advance();
  progressTimer = setInterval(advance, 1800);
  els.agentPanel.hidden = false;
  els.agentPanel.setAttribute("aria-busy", "true");
}

function stopProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
  els.agentPanel.removeAttribute("aria-busy");
}

function renderTrace(trace, failedStep) {
  stopProgress();
  clear(els.agentSteps);
  if (!Array.isArray(trace) || trace.length === 0) {
    els.agentPanel.hidden = true;
    return;
  }
  els.agentTitle.textContent = failedStep ? "What the agent tried" : "What the agent did";
  for (const step of trace) {
    const dot = el("span", { class: "dot", "aria-hidden": "true" });
    dot.append(icon("check"));
    els.agentSteps.append(el("li", { class: "agent-step done" },
      dot,
      el("span", {},
        el("span", { class: "label", text: step.label || step.id || "Step" }),
        step.detail ? el("span", { class: "detail", text: step.detail }) : null),
      el("span", { class: "ms", text: Number.isFinite(step.ms) ? `${Math.round(step.ms)} ms` : "" })));
  }
  els.traceToggle.hidden = false;
  setTraceExpanded(true);
}

function setTraceExpanded(expanded) {
  els.agentSteps.hidden = !expanded;
  els.traceToggle.setAttribute("aria-expanded", String(expanded));
  els.traceToggle.textContent = expanded ? "Hide steps" : "Show steps";
}

// ---------- Results ----------

function renderResults(data) {
  if (data.mode) setMode(data.mode);

  // Warnings
  clear(els.warningsList);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  for (const w of warnings) els.warningsList.append(el("li", { text: w }));
  els.warnings.hidden = warnings.length === 0;

  // Profile
  clear(els.profile);
  for (const tag of data.profile || []) els.profile.append(el("li", { class: "chip", text: tag.name }));
  if (!els.profile.firstChild) els.profile.append(el("li", { class: "muted", text: "No taste tags came back for these titles." }));

  // Picks
  clear(els.picks);
  const picks = Array.isArray(data.picks) ? data.picks : [];
  const pickIndex = new Map();
  picks.forEach((p, i) => {
    pickIndex.set(p.id, i);
    els.picks.append(renderPick(p, i));
  });

  // Plan
  clear(els.plan);
  for (const d of data.plan || []) {
    const idx = pickIndex.get(d.pickId);
    const pick = idx === undefined ? null : picks[idx];
    const meta = el("div", { class: "day-meta" },
      el("span", { text: `${d.minutes} min` }));
    if (pick) {
      meta.append(el("a", { class: "pick-link", href: `#pick-${idx}`, text: pick.name }));
    }
    els.plan.append(el("li", { class: "day" },
      el("div", { class: "day-num", "aria-hidden": "true" }, el("small", { text: "Day" }), String(d.day)),
      el("div", { class: "day-body" },
        el("h3", { class: "sr-only", text: `Day ${d.day}` }),
        meta,
        el("p", { class: "day-activity", text: d.activity }))));
  }

  els.planBlock.hidden = !els.plan.firstChild;

  // Vocab
  clear(els.vocab);
  for (const v of data.vocab || []) {
    els.vocab.append(el("tr", {},
      el("td", { lang: "en", text: v.term }),
      el("td", { lang: "ja", text: v.ja }),
      el("td", { lang: "en", text: v.example })));
  }
  const firstPick = picks[pickIndex.get(data.plan?.[0]?.pickId) ?? -1];
  els.vocabNote.textContent = firstPick
    ? `Words you may meet in “${firstPick.name}” on day 1. AI-generated — double-check in a dictionary.`
    : "AI-generated — double-check in a dictionary.";
  els.vocabBlock.hidden = !els.vocab.firstChild;

  els.results.hidden = false;
}

function renderPick(p, i) {
  const body = el("div", { class: "pick-body" });

  body.append(el("div", { class: "pick-type" }, icon(p.type), TYPE_LABELS[p.type] || "Work"));

  const title = el("h3", { class: "pick-title", text: p.name });
  if (p.year) title.append(" ", el("span", { class: "pick-year", text: `(${p.year})` }));
  body.append(title);

  const badges = el("div", { class: "badges" });
  if (p.cefr) badges.append(el("span", { class: "badge cefr", title: "Estimated CEFR level of the English", text: `CEFR ${p.cefr}` }));
  if (p.fit) badges.append(el("span", { class: `badge fit-${p.fit}`, text: FIT_LABELS[p.fit] || p.fit }));
  body.append(badges);

  if (typeof p.affinity === "number" && Number.isFinite(p.affinity)) {
    const pct = Math.max(0, Math.min(100, Math.round(p.affinity * 100)));
    const bar = el("div", { class: "affinity-bar", role: "presentation" }, el("span"));
    bar.firstChild.style.width = `${pct}%`;
    body.append(el("div", { class: "affinity" }, `Taste match ${pct}%`, bar));
  }

  if (p.because) body.append(el("p", { class: "because", text: p.because }));
  if (p.levelReason) body.append(el("p", { class: "level-reason", text: p.levelReason }));

  const card = el("li", { class: "pick", id: `pick-${i}`, tabindex: "-1" });
  if (typeof p.imageUrl === "string" && /^https:\/\//i.test(p.imageUrl)) {
    const img = el("img", { class: "pick-img", src: p.imageUrl, alt: `Cover image for ${p.name}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    card.append(img);
  }
  card.append(body);
  return card;
}

// ---------- Errors ----------

const STEP_NAMES = {
  normalize: "understanding your favourites",
  resolve: "finding your favourites in Qloo",
  profile: "reading your taste profile",
  refine: "applying your refinement",
  recommend: "searching English works with Qloo",
  level: "estimating English level",
  explain: "explaining the picks",
  plan: "writing your 7-day plan",
};

function showError(message, step) {
  els.errorMsg.textContent = message || "Something went wrong.";
  els.errorStep.textContent = step ? `The agent stopped while ${STEP_NAMES[step] || step}.` : "";
  els.errorStep.hidden = !step;
  els.errorBox.hidden = false;
}

// ---------- Run ----------

async function run(input) {
  if (busy) return;
  busy = true;
  lastRequest = input;
  hideFormError();
  els.errorBox.hidden = true;
  els.results.hidden = true;
  els.submit.disabled = true;
  els.submit.textContent = "Building…";
  startProgress();
  scrollIntoViewIfNeeded(els.agentPanel);

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(input),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (res.ok && data && Array.isArray(data.picks)) {
      renderTrace(data.trace);
      renderResults(data);
      scrollIntoViewIfNeeded(els.agentPanel.hidden ? els.results : els.agentPanel);
    } else {
      renderTrace(data && data.trace, data && data.step);
      const msg = res.status === 429
        ? (data && data.error) || "Too many plans this hour, try again later."
        : (data && data.error) || `The server answered with an error (${res.status}).`;
      showError(msg, data && data.step);
      scrollIntoViewIfNeeded(els.errorBox);
    }
  } catch {
    renderTrace(null);
    showError("Couldn't reach the server. Check your connection and try again.");
  } finally {
    stopProgress();
    busy = false;
    els.submit.disabled = false;
    els.submit.textContent = "Build my plan";
  }
}

// ---------- Wire up ----------

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const r = readInput();
  if (r.error) {
    showFormError(r.error);
    return;
  }
  els.refineInput.value = "";
  run(r.value);
});

els.refineForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.refineInput.value.trim();
  if (!lastRequest || !text) {
    els.refineInput.focus();
    return;
  }
  const { refine: _ignored, ...base } = lastRequest;
  run({ ...base, refine: text.slice(0, 200) });
});

els.addFav.addEventListener("click", () => {
  const input = addFavoriteRow();
  if (input) input.focus();
});
els.example.addEventListener("click", fillExample);
els.retry.addEventListener("click", () => lastRequest && run(lastRequest));
els.dismissWarnings.addEventListener("click", () => { els.warnings.hidden = true; });
els.traceToggle.addEventListener("click", () => {
  setTraceExpanded(els.traceToggle.getAttribute("aria-expanded") !== "true");
});

for (let i = 0; i < 3; i++) addFavoriteRow();
loadMode();

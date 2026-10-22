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
// Nouns for the cross-domain summary ("From 1 film and 1 game → 3 books").
const TYPE_NOUNS = {
  book: ["book", "books"],
  movie: ["film", "films"],
  tv_show: ["show", "shows"],
  podcast: ["podcast", "podcasts"],
  videogame: ["game", "games"],
  artist: ["artist", "artists"],
};
// Canonical step order, used to place steps the server adds on the fly (e.g. "refine", "review").
const STEP_ORDER = ["normalize", "resolve", "profile", "refine", "recommend", "level", "review", "explain", "plan"];
const FIT_LABELS = { match: "Your level", stretch: "Stretch", easier: "Easier" };
const SOURCE_BADGES = {
  qloo: ["live Qloo", "src-qloo"],
  sample: ["sample data", "src-sample"],
  "workers-ai": ["Workers AI", "src-ai"],
  "rule-based": ["rule-based", "src-rule"],
};
const SLOW_AFTER_MS = 15_000;
const CLIENT_TIMEOUT_MS = 120_000;
const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

// Inline SVG paths (24x24 stroke icons) per entity type.
const ICONS = {
  book: ["M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z", "M4 19V5", "M8 7h6"],
  podcast: ["M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  tv_show: ["M3 6h18v12H3z", "M8 21h8", "M8 2l4 4 4-4"],
  movie: ["M3 5h18v14H3z", "M7 5v14", "M17 5v14", "M3 9h4", "M3 15h4", "M17 9h4", "M17 15h4"],
  videogame: ["M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z", "M7 11v3", "M5.5 12.5h3", "M16 12h.01", "M18 13.5h.01"],
  artist: ["M9 18V5l11-2v13", "M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z", "M20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  close: ["M6 6l12 12M18 6L6 18"],
  alert: ["M12 8v5", "M12 16.5h.01"],
};

const $ = (id) => document.getElementById(id);
const els = {
  refineSubmit: $("refine-submit"),
  refineNote: $("refine-note"),
  resultsStatus: $("results-status"),
  form: $("plan-form"),
  favorites: $("favorites"),
  addFav: $("add-fav"),
  example: $("example-btn"),
  submit: $("submit-btn"),
  formError: $("form-error"),
  modeBadge: $("mode-badge"),
  demoBanner: $("demo-banner"),
  agentPanel: $("agent-panel"),
  agentTitle: $("agent-title"),
  agentSummary: $("agent-summary"),
  agentElapsed: $("agent-elapsed"),
  agentStatus: $("agent-status"),
  agentSteps: $("agent-steps"),
  cancel: $("cancel-btn"),
  traceToggle: $("trace-toggle"),
  errorBox: $("error-box"),
  errorTitle: $("error-title"),
  errorMsg: $("error-msg"),
  errorStep: $("error-step"),
  retry: $("retry-btn"),
  demoRetry: $("demo-retry-btn"),
  results: $("results"),
  warnings: $("warnings"),
  warningsList: $("warnings-list"),
  dismissWarnings: $("dismiss-warnings"),
  seedsBlock: $("seeds-block"),
  seeds: $("seeds"),
  crossDomain: $("cross-domain"),
  profile: $("profile"),
  picks: $("picks"),
  plan: $("plan"),
  copyPlan: $("copy-plan"),
  copyStatus: $("copy-status"),
  vocab: $("vocab"),
  refineForm: $("refine-form"),
  refineInput: $("refine-input"),
  vocabNote: $("vocab-note"),
  planBlock: $("plan-block"),
  vocabBlock: $("vocab-block"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const DEMO = new URLSearchParams(window.location.search).get("demo") === "1";

let lastRequest = null;
let lastResult = null;
let busy = false;
let rowSeq = 0;
let healthMode = null; // from /api/health
let runMode = null; // from the stream's start event or the result
let lastResultMode = null;
let retryEdits = false;

// Trace state for the current run.
const trace = { steps: new Map(), order: [], startedAt: 0, endedAt: 0 };
let tickTimer = null;
let controller = null;
let abortReason = null;

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

/** 0–1 (or 0–100) → integer percent, or null. */
function toPct(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const p = v <= 1 ? v * 100 : v;
  return Math.max(0, Math.min(100, Math.round(p)));
}

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "with"]);

/** "Coming Of Age" → "Coming of Age" (Qloo tag names are title-cased word by word). */
function tidyTag(name) {
  return String(name).split(" ").map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(" ");
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function plural(n, [one, many]) {
  return `${n} ${n === 1 ? one : many}`;
}

function joinAnd(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function bar(pct) {
  const b = el("span", { class: "meter", "aria-hidden": "true" }, el("span"));
  b.firstChild.style.width = `${pct}%`;
  return b;
}

// ---------- Mode badge and demo banner ----------

async function loadMode() {
  try {
    const res = await fetch("/api/health", { headers: { accept: "application/json" } });
    const data = await res.json();
    if (data && (data.mode === "live" || data.mode === "mock")) healthMode = data.mode;
  } catch {
    // Badge is informational; leave it hidden if health is unreachable.
  }
  updateModeUi();
}

function updateModeUi() {
  // While a run is going, its own mode (from the start event) wins; afterwards, the last result's.
  const shownRun = busy ? runMode : lastResultMode || runMode;
  const sampleRun = shownRun === "mock" && healthMode === "live";
  const effective = DEMO || sampleRun ? "mock" : shownRun || healthMode;

  if (effective === "live" || effective === "mock") {
    els.modeBadge.textContent = effective === "live" ? "Live Qloo data" : "Demo mode: sample data";
    els.modeBadge.className = `mode-badge ${effective}`;
    els.modeBadge.title = effective === "live"
      ? "Recommendations come from the Qloo Taste AI API."
      : sampleRun || DEMO
        ? "This run used the small hand-written sample set instead of live Qloo data."
        : "No Qloo API key configured: results use a small hand-written sample set.";
    els.modeBadge.hidden = false;
  }

  let banner = "";
  if (sampleRun && !DEMO) banner = "Sample-data run — these results use a small hand-written sample set, not live Qloo data.";
  else if (effective === "mock") banner = "Demo mode — results use a small hand-written sample set, not live Qloo data.";
  els.demoBanner.textContent = banner;
  els.demoBanner.hidden = !banner;
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
  remove.append(icon("close"));
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
  const value = { favorites, level, minutesPerDay, formats };
  if (DEMO) value.demo = true;
  return { value };
}

function showFormError(msg) {
  els.formError.textContent = msg;
  els.formError.hidden = false;
}

function hideFormError() {
  els.formError.hidden = true;
}

// ---------- Agent trace ----------

function resetTrace() {
  trace.steps.clear();
  trace.order = [];
  trace.startedAt = performance.now();
  trace.endedAt = 0;
  clear(els.agentSteps);
}

function orderIndex(id) {
  const i = STEP_ORDER.indexOf(id);
  return i === -1 ? STEP_ORDER.length : i;
}

/** Get or create the state for a step, inserting its row in canonical order. */
function ensureStep(id, label, append = false) {
  let s = trace.steps.get(id);
  if (s) {
    if (label) s.label = label;
    return s;
  }
  s = { id, label: label || id, status: "pending", detail: "", ms: NaN, calls: [], node: null };
  trace.steps.set(id, s);
  // Insert before the first known step that comes later in the canonical order.
  const mine = orderIndex(id);
  let at = trace.order.length;
  if (!append && mine < STEP_ORDER.length) {
    at = trace.order.findIndex((other) => orderIndex(other) > mine);
    if (at === -1) at = trace.order.length;
  }
  trace.order.splice(at, 0, id);
  s.node = buildStepNode(s);
  const before = trace.order[at + 1] ? trace.steps.get(trace.order[at + 1]).node : null;
  els.agentSteps.insertBefore(s.node, before);
  return s;
}

function buildStepNode(s) {
  const li = el("li", { class: "agent-step pending" });
  li.append(
    el("span", { class: "dot", "aria-hidden": "true" }),
    el("div", { class: "step-main" },
      el("div", { class: "step-line" },
        el("span", { class: "label" }),
        el("span", { class: "step-tag", hidden: true })),
      el("span", { class: "detail", hidden: true }),
      el("details", { class: "calls", hidden: true },
        el("summary", {}),
        el("ul", { class: "call-list" }))),
    el("span", { class: "ms" }));
  s.node = li;
  updateStepNode(s);
  return li;
}

const STATUS_TEXT = {
  pending: "waiting",
  active: "in progress",
  done: "done",
  fallback: "rule-based fallback",
  failed: "failed",
};

function updateStepNode(s) {
  const li = s.node;
  li.className = `agent-step ${s.status}`;
  const dot = li.querySelector(".dot");
  clear(dot);
  if (s.status === "done") dot.append(icon("check"));
  else if (s.status === "failed") dot.append(icon("close"));
  else if (s.status === "fallback") dot.append(icon("alert"));

  const label = li.querySelector(".label");
  label.textContent = s.label;
  label.append(el("span", { class: "sr-only", text: ` (${STATUS_TEXT[s.status] || s.status})` }));

  const tag = li.querySelector(".step-tag");
  tag.hidden = !(s.status === "fallback" || s.status === "failed");
  tag.textContent = s.status === "fallback" ? "rule-based fallback" : s.status === "failed" ? "failed" : "";
  tag.className = `step-tag ${s.status}`;

  const detail = li.querySelector(".detail");
  detail.textContent = s.detail || "";
  detail.hidden = !s.detail;

  li.querySelector(".ms").textContent = fmtMs(s.ms);

  const details = li.querySelector("details.calls");
  const list = details.querySelector(".call-list");
  clear(list);
  for (const c of s.calls) list.append(renderCall(c));
  const n = s.calls.length;
  const failed = s.calls.filter((c) => c && c.ok === false).length;
  details.querySelector("summary").textContent =
    `${plural(n, ["tool call", "tool calls"])}${failed ? ` · ${failed} failed` : ""}`;
  details.hidden = n === 0;
}

function renderCall(c) {
  const badges = el("span", { class: "call-badges" });
  if (c.ok === false) badges.append(el("span", { class: "tag tag-failed", text: "failed" }));
  if (c.cached) badges.append(el("span", { class: "tag tag-cached", text: "cached" }));
  const src = SOURCE_BADGES[c.source];
  if (src) badges.append(el("span", { class: `tag ${src[1]}`, text: src[0] }));

  const meta = [];
  if (Number.isFinite(c.results)) meta.push(plural(c.results, ["result", "results"]));
  if (Number.isFinite(c.ms)) meta.push(fmtMs(c.ms));

  return el("li", { class: `call${c.ok === false ? " failed" : ""}` },
    el("div", { class: "call-head" },
      el("code", { class: "endpoint", text: c.endpoint || c.tool || "call" }),
      badges),
    c.summary ? el("div", { class: "call-summary", text: c.summary }) : null,
    meta.length ? el("div", { class: "call-meta", text: meta.join(" · ") }) : null);
}

function stepStatusFrom(step, failedId) {
  if (step.status === "fallback") return "fallback";
  if (step.status === "failed" || (failedId && step.id === failedId)) return "failed";
  return "done";
}

/** Replace the trace with the server's final trace (authoritative). */
function loadTrace(steps, failedId) {
  const keepOpen = new Set([...trace.steps.values()].filter((s) => s.node?.querySelector("details.calls")?.open).map((s) => s.id));
  trace.steps.clear();
  trace.order = [];
  clear(els.agentSteps);
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== "object") continue;
    const id = String(step.id || step.label || `step-${trace.order.length}`);
    const s = ensureStep(id, step.label || id, true);
    applyStep(s, step, failedId);
    if (keepOpen.has(id)) s.node.querySelector("details.calls").open = true;
  }
}

function applyStep(s, step, failedId) {
  s.status = stepStatusFrom(step, failedId);
  s.detail = typeof step.detail === "string" ? step.detail : "";
  s.ms = Number(step.ms);
  if (Array.isArray(step.calls)) s.calls = step.calls.filter((c) => c && typeof c === "object");
  updateStepNode(s);
}

function activeStep() {
  for (let i = trace.order.length - 1; i >= 0; i--) {
    const s = trace.steps.get(trace.order[i]);
    if (s.status === "active") return s;
  }
  return null;
}

function updateSummary() {
  let qloo = 0, ai = 0, rule = 0, cached = 0;
  for (const s of trace.steps.values()) {
    for (const c of s.calls) {
      if (typeof c.tool === "string" && c.tool.startsWith("qloo")) qloo += 1;
      else if (c.source === "rule-based") rule += 1;
      else if (c.tool === "llm") ai += 1;
      if (c.cached) cached += 1;
    }
  }
  const parts = [];
  if (qloo) parts.push(plural(qloo, ["Qloo call", "Qloo calls"]));
  if (ai) parts.push(plural(ai, ["AI call", "AI calls"]));
  if (rule) parts.push(plural(rule, ["rule-based answer", "rule-based answers"]));
  if (cached) parts.push(`${cached} from cache`);
  const end = trace.endedAt || performance.now();
  if (trace.startedAt) parts.push(fmtMs(Math.max(0, end - trace.startedAt)));
  els.agentSummary.textContent = parts.join(" · ");
  els.agentSummary.hidden = parts.length === 0;
}

function updateStatusLine() {
  if (!busy) return;
  const elapsed = performance.now() - trace.startedAt;
  const current = activeStep();
  const name = current ? current.label : "starting the agent";
  const text = elapsed >= SLOW_AFTER_MS
    ? `Still working on: ${name} — the AI step can take up to a minute.`
    : current ? `Working on: ${current.label}` : "Starting the agent…";
  // Only touch the live region when its text changes, so screen readers don't repeat it every second.
  if (els.agentStatus.textContent !== text) els.agentStatus.textContent = text;
}

function tick() {
  const secs = Math.floor((performance.now() - trace.startedAt) / 1000);
  els.agentElapsed.textContent = `${secs} s`;
  updateStatusLine();
}

function startProgress() {
  resetTrace();
  els.agentTitle.textContent = "Agent at work";
  setTraceExpanded(true);
  els.traceToggle.hidden = true;
  els.cancel.hidden = false;
  els.cancel.disabled = false;
  els.agentElapsed.hidden = false;
  els.agentElapsed.textContent = "0 s";
  els.agentSummary.hidden = true;
  els.agentPanel.hidden = false;
  els.agentPanel.setAttribute("aria-busy", "true");
  updateStatusLine();
  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    tick();
    updateSummary();
  }, 1000);
}

function stopProgress(outcome) {
  clearInterval(tickTimer);
  tickTimer = null;
  trace.endedAt = performance.now();
  els.agentPanel.removeAttribute("aria-busy");
  els.cancel.hidden = true;
  els.agentElapsed.hidden = true;
  // Steps still marked active never finished.
  for (const s of trace.steps.values()) {
    if (s.status === "active") {
      s.status = "pending";
      updateStepNode(s);
    }
  }
  const total = fmtMs(trace.endedAt - trace.startedAt);
  const titles = {
    done: ["What the agent did", `Done in ${total}.`],
    error: ["What the agent tried", `Stopped after ${total}.`],
    cancelled: ["What the agent did before you cancelled", "Cancelled."],
    timeout: ["What the agent tried", "Stopped waiting after 2 minutes."],
  };
  const [title, status] = titles[outcome] || titles.error;
  els.agentTitle.textContent = title;
  els.agentStatus.textContent = status;
  updateSummary();
  if (trace.order.length === 0) {
    // Nothing ran (e.g. rate limited before the agent started): the error box says enough.
    els.agentPanel.hidden = true;
  } else {
    els.traceToggle.hidden = false;
    // On a phone the full trace pushes the picks far down; the summary line still shows the agent's work.
    setTraceExpanded(!(outcome === "done" && window.innerWidth < 640));
  }
}

function setTraceExpanded(expanded) {
  els.agentSteps.hidden = !expanded;
  els.traceToggle.setAttribute("aria-expanded", String(expanded));
  els.traceToggle.textContent = expanded ? "Hide steps" : "Show steps";
}

// ---------- Stream events ----------

/** Handle one AgentEvent. Returns "result" / "error" for terminal events. */
function handleEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  switch (ev.type) {
    case "start": {
      if (ev.mode === "live" || ev.mode === "mock") {
        runMode = ev.mode;
        updateModeUi();
      }
      for (const st of Array.isArray(ev.steps) ? ev.steps : []) {
        if (st && st.id) ensureStep(String(st.id), st.label);
      }
      els.traceToggle.hidden = trace.order.length === 0;
      break;
    }
    case "step-start": {
      if (!ev.id) break;
      const s = ensureStep(String(ev.id), ev.label);
      s.status = "active";
      s.calls = [];
      updateStepNode(s);
      els.traceToggle.hidden = false;
      updateStatusLine();
      break;
    }
    case "call": {
      if (!ev.step || !ev.call || typeof ev.call !== "object") break;
      const s = ensureStep(String(ev.step));
      s.calls.push(ev.call);
      updateStepNode(s);
      updateSummary();
      break;
    }
    case "step": {
      const step = ev.step;
      if (!step || !step.id) break;
      const s = ensureStep(String(step.id), step.label);
      applyStep(s, step);
      updateSummary();
      updateStatusLine();
      break;
    }
    case "result":
      return "result";
    case "error":
      return "error";
    default:
      break;
  }
  return null;
}

async function consumeStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let terminal = null;

  const handleLine = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    const kind = handleEvent(ev);
    if (kind && !terminal) terminal = { kind, ev };
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleLine(line);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) handleLine(buf.trim());
  return terminal;
}

// ---------- Results ----------

function renderResults(data) {
  lastResult = data;
  if (data.mode === "live" || data.mode === "mock") {
    lastResultMode = data.mode;
    updateModeUi();
  }
  const steps = Array.isArray(data.trace) ? data.trace : [];

  // Warnings
  clear(els.warningsList);
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  for (const w of warnings) els.warningsList.append(el("li", { text: w }));
  els.warnings.hidden = warnings.length === 0;

  const picks = Array.isArray(data.picks) ? data.picks : [];

  // What Qloo matched
  renderSeeds(Array.isArray(data.seeds) ? data.seeds : [], picks);

  // Profile
  clear(els.profile);
  for (const tag of data.profile || []) {
    if (!tag || !tag.name) continue;
    const chip = el("li", { class: "chip" }, el("span", { text: tidyTag(tag.name) }));
    const pct = toPct(tag.affinity);
    if (pct !== null) {
      chip.classList.add("has-affinity");
      chip.title = `Qloo affinity ${pct}%`;
      chip.append(el("small", { class: "chip-pct", text: `${pct}%` }));
    }
    els.profile.append(chip);
  }
  if (!els.profile.firstChild) els.profile.append(el("li", { class: "muted", text: "No taste tags came back for these titles." }));

  // Picks
  clear(els.picks);
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
  els.copyStatus.textContent = "";

  // Vocab
  clear(els.vocab);
  for (const v of data.vocab || []) {
    els.vocab.append(el("tr", {},
      el("td", { lang: "en", text: v.term }),
      el("td", { lang: "ja", text: v.ja }),
      el("td", { lang: "en", text: v.example })));
  }
  const planStep = steps.find((s) => s && s.id === "plan");
  const firstPick = picks[pickIndex.get(data.plan?.[0]?.pickId) ?? -1];
  if (planStep && planStep.status === "fallback") {
    els.vocabNote.textContent = "Sample words (AI was unavailable) — double-check in a dictionary.";
  } else {
    els.vocabNote.textContent = firstPick
      ? `Words you may meet in “${firstPick.name}” on day 1. AI-generated — double-check in a dictionary.`
      : "AI-generated — double-check in a dictionary.";
  }
  els.vocabBlock.hidden = !els.vocab.firstChild;

  // Say plainly when these picks are a refined run, and what the agent made of the wording.
  const refineStep = steps.find((st) => st && st.id === "refine" && st.status !== "failed");
  const refineText = lastRequest && lastRequest.refine;
  els.refineNote.textContent = refineText
    ? `Refined: “${refineText}”${refineStep && refineStep.detail ? ` → ${refineStep.detail}` : ""}`
    : "";
  els.refineNote.hidden = !refineText;

  els.results.hidden = false;
  els.resultsStatus.textContent = `Plan ready: ${picks.length} picks and a 7-day plan.`;
}

function renderSeeds(seeds, picks) {
  clear(els.seeds);
  for (const s of seeds) {
    if (!s || !s.name) continue;
    const meta = [TYPE_LABELS[s.type] || "Work"];
    if (s.year) meta.push(String(s.year));
    const li = el("li", { class: "seed" },
      el("span", { class: "seed-icon" }, icon(s.type)),
      el("span", { class: "seed-text" },
        el("span", { class: "seed-name", text: s.name }),
        el("span", { class: "seed-meta", text: meta.join(" · ") })));
    const typed = typeof s.input === "string" ? s.input.trim() : "";
    if (typed && typed.toLowerCase() !== String(s.name).trim().toLowerCase()) {
      li.querySelector(".seed-text").append(el("span", { class: "seed-input", text: `you typed “${typed}”` }));
    }
    els.seeds.append(li);
  }
  els.seedsBlock.hidden = !els.seeds.firstChild;

  // Cross-domain summary: "From 1 film and 1 game → 3 books, 2 podcasts and 3 shows".
  const count = (list) => {
    const m = new Map();
    for (const x of list) if (x && TYPE_NOUNS[x.type]) m.set(x.type, (m.get(x.type) || 0) + 1);
    return [...m].map(([t, n]) => plural(n, TYPE_NOUNS[t]));
  };
  const from = count(seeds);
  const to = count(picks);
  els.crossDomain.textContent = from.length && to.length ? `From ${joinAnd(from)} → ${joinAnd(to)}` : "";
  els.crossDomain.hidden = !(from.length && to.length);
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

  const affinity = toPct(p.affinity);
  if (affinity !== null) {
    const b = el("div", { class: "affinity-bar", role: "presentation" }, el("span"));
    b.firstChild.style.width = `${affinity}%`;
    body.append(el("div", { class: "affinity", title: "Qloo affinity: how closely this work fits the taste of people who like your favourites" }, `Taste match ${affinity}%`, b));
  }

  if (p.because) body.append(el("p", { class: "because", text: p.because }));
  if (p.levelReason) body.append(el("p", { class: "level-reason", text: p.levelReason }));

  const why = renderWhy(p, affinity);
  if (why) body.append(why);

  const card = el("li", { class: "pick", id: `pick-${i}`, tabindex: "-1" });
  if (typeof p.imageUrl === "string" && /^https:\/\//i.test(p.imageUrl)) {
    const img = el("img", { class: "pick-img", src: p.imageUrl, alt: `Cover image for ${p.name}`, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.remove());
    card.append(img);
  }
  card.append(body);
  return card;
}

function renderWhy(p, affinity) {
  const ev = p.evidence && typeof p.evidence === "object" ? p.evidence : {};
  const contributions = Array.isArray(ev.contributions) ? ev.contributions.filter((c) => c && c.name) : [];
  const tags = Array.isArray(ev.sharedTags) ? ev.sharedTags.filter((t) => typeof t === "string" && t) : [];
  const popularity = toPct(p.popularity);
  if (!contributions.length && !tags.length && popularity === null) return null;

  const panel = el("div", { class: "why-body" }, el("p", { class: "why-source", text: "From Qloo data" }));

  if (contributions.length) {
    const list = el("ul", { class: "contrib" });
    for (const c of contributions) {
      const pct = toPct(c.score);
      const row = el("li", {}, el("span", { class: "contrib-name", text: c.name }));
      if (pct !== null) row.append(bar(pct), el("span", { class: "contrib-pct", text: `${pct}%` }));
      else row.classList.add("no-score");
      list.append(row);
    }
    panel.append(el("p", { class: "why-label", text: "How strongly each favourite led Qloo here" }), list);
  }

  if (tags.length) {
    const chips = el("ul", { class: "chips small" });
    for (const t of tags) chips.append(el("li", { class: "chip", text: tidyTag(t) }));
    panel.append(el("p", { class: "why-label", text: "Shared taste tags" }), chips);
  }

  const facts = el("ul", { class: "why-facts" });
  if (popularity !== null) facts.append(el("li", { text: `Qloo popularity percentile ${popularity}%` }));
  if (facts.firstChild) panel.append(facts);

  return el("details", { class: "why" }, el("summary", { text: "Why this pick" }), panel);
}

// ---------- Copy plan ----------

function planText(data) {
  const picks = new Map((data.picks || []).map((p) => [p.id, p]));
  const lines = ["Taste-to-English — my 7-day English plan", ""];
  for (const d of data.plan || []) {
    const pick = picks.get(d.pickId);
    lines.push(`Day ${d.day} — ${pick ? pick.name : "Free choice"} — ${d.activity} — ${d.minutes} min`);
  }
  const vocab = data.vocab || [];
  if (vocab.length) {
    lines.push("", "Starter vocabulary");
    for (const v of vocab) lines.push(`- ${v.term} — ${v.ja} — ${v.example}`);
  }
  return lines.join("\n");
}

function showCopyFallback(text) {
  els.copyStatus.textContent = "Copying isn't available here. Select the text below and copy it.";
  let area = els.planBlock.querySelector("textarea.copy-fallback");
  if (!area) {
    area = el("textarea", { class: "copy-fallback", readonly: true, rows: "10", "aria-label": "Plan as plain text" });
    els.copyStatus.after(area);
  }
  area.value = text;
  area.focus();
  area.select();
}

async function copyPlan() {
  if (!lastResult) return;
  const text = planText(lastResult);
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    els.copyStatus.textContent = "Copied";
    els.planBlock.querySelector("textarea.copy-fallback")?.remove();
  } catch {
    showCopyFallback(text);
  }
}

// ---------- Errors ----------

const STEP_NAMES = {
  normalize: "understanding your favourites",
  resolve: "finding your favourites in Qloo",
  profile: "reading your taste profile",
  refine: "applying your refinement",
  recommend: "searching English works with Qloo",
  level: "estimating English level",
  review: "checking its own picks",
  explain: "explaining the picks",
  plan: "writing your 7-day plan",
};

function showError(message, step, opts = {}) {
  els.errorTitle.textContent = opts.title || "We couldn't build your plan";
  const sampleRun = runMode === "mock" || (!runMode && healthMode === "mock") || (lastRequest && lastRequest.demo);
  const titlesMissing = step === "resolve";
  els.errorMsg.textContent = (message || "Something went wrong.") +
    (titlesMissing && sampleRun ? " Demo mode only knows a few dozen sample titles, such as 千と千尋の神隠し, ペルソナ5, ノルウェイの森, Arcane or Radiolab." : "");
  // Re-sending titles that weren't found would fail the same way, so offer to edit them instead.
  retryEdits = titlesMissing;
  els.retry.textContent = titlesMissing ? "Edit titles" : "Try again";
  els.errorStep.textContent = step ? `The agent stopped while ${STEP_NAMES[step] || step}.` : "";
  els.errorStep.hidden = !step;
  const mode = runMode || healthMode;
  els.demoRetry.hidden = !(opts.offerDemo && mode === "live" && lastRequest && !lastRequest.demo);
  els.errorBox.hidden = false;
  scrollIntoViewIfNeeded(els.errorBox);
  els.errorBox.focus({ preventScroll: true });
}

// ---------- Run ----------

async function run(input) {
  if (busy) return;
  busy = true;
  lastRequest = input;
  runMode = null;
  lastResultMode = null;
  els.refineSubmit.disabled = true;
  abortReason = null;
  hideFormError();
  els.errorBox.hidden = true;
  // A refine run keeps the current plan (and the refine box) on screen in case it fails.
  if (!input.refine) els.results.hidden = true;
  els.submit.disabled = true;
  els.submit.textContent = "Building…";
  startProgress();
  scrollIntoViewIfNeeded(els.agentPanel);

  controller = new AbortController();
  const timeout = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, CLIENT_TIMEOUT_MS);
  let outcome = "error";

  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const type = res.headers.get("content-type") || "";

    if (res.ok && type.includes("ndjson") && res.body) {
      const terminal = await consumeStream(res);
      if (terminal && terminal.kind === "result" && terminal.ev.result && Array.isArray(terminal.ev.result.picks)) {
        const result = terminal.ev.result;
        if (Array.isArray(result.trace) && result.trace.length) loadTrace(result.trace);
        outcome = "done";
        stopProgress(outcome);
        renderResults(result);
        scrollIntoViewIfNeeded(els.results);
      } else if (terminal && terminal.kind === "error") {
        const ev = terminal.ev;
        if (Array.isArray(ev.trace) && ev.trace.length) loadTrace(ev.trace, ev.step);
        else if (ev.step) markFailed(String(ev.step));
        stopProgress(outcome);
        showError(ev.error || "Something went wrong.", ev.step, { offerDemo: true });
      } else {
        stopProgress(outcome);
        showError("The connection closed before the plan was ready. Please try again.", null, { offerDemo: true });
      }
      return;
    }

    // Plain JSON: validation (400), rate limit (429), 405, or a server without streaming.
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      if (abortReason) throw err;
      data = null;
    }
    if (res.ok && data && Array.isArray(data.picks)) {
      loadTrace(data.trace);
      outcome = "done";
      stopProgress(outcome);
      renderResults(data);
      scrollIntoViewIfNeeded(els.agentPanel.hidden ? els.results : els.agentPanel);
    } else {
      loadTrace(data && data.trace, data && data.step);
      stopProgress(outcome);
      let msg = (data && data.error) || `The server answered with an error (${res.status}).`;
      if (res.status === 429 && !(data && data.error)) msg = "Too many requests right now. Please wait a minute and try again.";
      showError(msg, data && data.step, { offerDemo: res.status >= 500 || (res.ok && !!data) });
    }
  } catch {
    if (abortReason === "cancel") {
      outcome = "cancelled";
      stopProgress(outcome);
      showError("You cancelled the run. Your favourites are still in the form — press Try again whenever you're ready.", null, { title: "Run cancelled" });
    } else if (abortReason === "timeout") {
      outcome = "timeout";
      stopProgress(outcome);
      showError("The agent took longer than 2 minutes, so we stopped waiting. The AI step is sometimes slow — please try again.", null, { title: "This is taking too long", offerDemo: true });
    } else {
      stopProgress(outcome);
      showError(NETWORK_ERROR);
    }
  } finally {
    clearTimeout(timeout);
    if (tickTimer) stopProgress(outcome);
    controller = null;
    busy = false;
    els.refineSubmit.disabled = false;
    updateModeUi();
    els.submit.disabled = false;
    els.submit.textContent = "Build my plan";
  }
}

function markFailed(id) {
  const s = ensureStep(id);
  s.status = "failed";
  updateStepNode(s);
}

// ---------- Wire up ----------

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const r = readInput();
  if (r.error) {
    showFormError(r.error);
    return;
  }
  if (busy) return;
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
els.retry.addEventListener("click", () => {
  if (retryEdits) {
    els.errorBox.hidden = true;
    const first = els.favorites.querySelector("input");
    first?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    first?.focus({ preventScroll: true });
    return;
  }
  if (lastRequest) run(lastRequest);
});
els.demoRetry.addEventListener("click", () => lastRequest && run({ ...lastRequest, demo: true }));
els.cancel.addEventListener("click", () => {
  if (!controller) return;
  abortReason = "cancel";
  els.cancel.disabled = true;
  controller.abort();
});
els.copyPlan.addEventListener("click", copyPlan);
els.dismissWarnings.addEventListener("click", () => { els.warnings.hidden = true; });
els.traceToggle.addEventListener("click", () => {
  setTraceExpanded(els.traceToggle.getAttribute("aria-expanded") !== "true");
});

if (DEMO) fillExample();
else for (let i = 0; i < 3; i++) addFavoriteRow();
updateModeUi();
loadMode();

// Study pledge UI: offer a PayPal hold under a finished plan, and the pledge page (?pledge=<id>)
// with daily AI check-ins, settlement and the agent/PayPal ledger. Server strings go in via textContent only.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(window.location.search);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok && !(res.status === 502 && data && data.id)) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- offer (under a finished plan) ----------

let latestPlan = null;
const offer = {
  start: $("pledge-start"),
  error: $("pledge-offer-error"),
};

function perDay() {
  const checked = document.querySelector('input[name="per-day"]:checked');
  return checked ? Number(checked.value) : 1;
}
function syncOfferLabel() {
  if (offer.start) offer.start.textContent = `Hold ${money(perDay() * 7)} with PayPal`;
}
document.querySelectorAll('input[name="per-day"]').forEach((r) => r.addEventListener("change", syncOfferLabel));

window.addEventListener("plan:ready", (e) => {
  latestPlan = e.detail;
  offer.error.hidden = true;
});

function pledgeDaysFrom(detail) {
  const picks = new Map((detail.result.picks || []).map((p) => [p.id, p]));
  return (detail.result.plan || []).map((d) => {
    const p = picks.get(d.pickId) || {};
    return {
      day: d.day,
      title: p.name || "Today's pick",
      format: p.format || "read",
      activity: d.activity,
      minutes: d.minutes,
      description: (p.description || "").slice(0, 480),
    };
  });
}

async function startPledge(funding) {
  if (!latestPlan) return;
  const card = $("pledge-card");
  offer.start.disabled = true;
  if (card) card.disabled = true;
  offer.start.textContent = "Creating the PayPal order…";
  offer.error.hidden = true;
  try {
    const p = await api("/api/pledges", { level: latestPlan.level, perDayUsd: perDay(), funding, days: pledgeDaysFrom(latestPlan) });
    if (p.status === "error") throw new Error("PayPal could not place the hold. Please try again.");
    if (funding === "test-card") window.location.assign(`/?pledge=${encodeURIComponent(p.id)}`);
    else if (p.approveUrl) window.location.assign(p.approveUrl);
    else throw new Error("PayPal could not create the order. Please try again.");
  } catch (err) {
    offer.error.textContent = err.message;
    offer.error.hidden = false;
    offer.start.disabled = false;
    if (card) card.disabled = false;
    syncOfferLabel();
  }
}
offer.start?.addEventListener("click", () => startPledge("paypal"));
$("pledge-card")?.addEventListener("click", () => startPledge("test-card"));

// ---------- pledge page ----------

const v = {
  root: $("pledge-view"),
  status: $("pledge-status"),
  held: $("pledge-held"),
  safe: $("pledge-safe"),
  owed: $("pledge-owed"),
  error: $("pledge-error"),
  approve: $("pledge-approve"),
  approveLink: $("pledge-approve-link"),
  days: $("pledge-days"),
  checkin: $("pledge-checkin"),
  settle: $("pledge-settle"),
  settleBtn: $("pledge-settle-btn"),
  result: $("pledge-result"),
  ledger: $("pledge-ledger"),
};
const pledgeId = params.get("pledge");
let pledge = null;
let busy = false;

const STATUS_TEXT = {
  awaiting_approval: "Waiting for you to approve the hold in PayPal.",
  active: "Hold placed — no money has moved. Finish today's check-in to keep your share.",
  settled: "Settled.",
  cancelled: "Cancelled before approval. Nothing was held.",
  error: "PayPal could not create the order.",
};
const DAY_BADGE = { locked: "Locked", open: "Today", passed: "Passed", failed: "Failed", missed: "Skipped" };
const ACTOR = { learner: "You", tutor: "AI tutor", agent: "Settlement agent", guardrail: "Guardrail", paypal: "PayPal" };
const SOURCE = { "workers-ai": "Workers AI · Llama 3.3", "rule-based": "rule-based fallback" };

function showError(msg) {
  v.error.textContent = msg;
  v.error.hidden = !msg;
}

async function act(fn) {
  if (busy) return;
  busy = true;
  showError("");
  document.body.classList.add("pledge-busy");
  try {
    pledge = await fn();
    render();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
    document.body.classList.remove("pledge-busy");
  }
}

function render() {
  const p = pledge;
  const passed = p.days.filter((d) => d.status === "passed").length;
  const lost = p.days.filter((d) => d.status === "failed" || d.status === "missed").length;
  v.status.textContent = `${STATUS_TEXT[p.status] || p.status} PayPal ${p.paypalMode === "sandbox" ? "sandbox" : "simulated (no credentials configured)"}.`;
  v.held.textContent = p.status === "active" ? money(p.pledgeUsd) : p.status === "settled" ? money(0) : "—";
  v.safe.textContent = money(passed * p.perDayUsd);
  v.owed.textContent = money(lost * p.perDayUsd);

  v.approve.hidden = !(p.status === "awaiting_approval" && p.approveUrl);
  if (p.approveUrl) v.approveLink.setAttribute("href", p.approveUrl);

  v.days.replaceChildren(
    ...p.days.map((d) =>
      el(
        "li",
        { class: `pday pday-${d.status}` },
        el("span", { class: "pday-num", text: `Day ${d.day}` }),
        el("span", { class: "pday-title", text: d.title }),
        el("span", { class: "pday-badge", text: d.grade && d.status !== "open" ? `${DAY_BADGE[d.status]} · ${d.grade.score}` : DAY_BADGE[d.status] }),
      ),
    ),
  );

  renderCheckin(p);
  const allDone = p.days.every((d) => !["open", "locked"].includes(d.status));
  v.settle.hidden = !(p.status === "active" && allDone);
  renderResult(p);
  renderLedger(p);
}

function renderCheckin(p) {
  const d = p.days.find((x) => x.status === "open");
  if (p.status !== "active" || !d) {
    v.checkin.hidden = true;
    return;
  }
  v.checkin.hidden = false;
  const head = el(
    "div",
    { class: "checkin-head" },
    el("h3", { text: `Day ${d.day}: ${d.title}` }),
    el("p", { class: "muted", text: `${d.minutes} min · ${d.activity}` }),
  );
  const nodes = [head];
  if (d.grade && !d.grade.passed) {
    nodes.push(gradeBox(d.grade, `Not passed yet (${d.grade.score}/100). One more try.`));
  }
  if (!d.quiz) {
    const start = el("button", { type: "button", class: "primary-btn", text: "I did today's session — check me" });
    start.addEventListener("click", () => act(() => api(`/api/pledges/${p.id}/days/${d.day}/quiz`, {})));
    const skip = el("button", { type: "button", class: "ghost-btn", text: `Skip today (${money(p.perDayUsd)} to charity)` });
    skip.addEventListener("click", () => act(() => api(`/api/pledges/${p.id}/days/${d.day}/skip`, {})));
    nodes.push(el("div", { class: "checkin-actions" }, start, skip));
  } else {
    const form = el("form", { class: "quiz" });
    d.quiz.forEach((q, i) => {
      const id = `ans-${d.day}-${i}`;
      form.append(
        el("label", { for: id, class: "quiz-q", text: `${i + 1}. ${q.q}` }),
        el("textarea", { id, name: `a${i}`, rows: "3", maxlength: "800", lang: "en", required: true }),
      );
    });
    if (d.answers) d.answers.forEach((a, i) => (form.elements[`a${i}`].value = a));
    form.append(
      el("p", { class: "hint", text: `Questions by ${SOURCE[d.quizSource] || "AI tutor"}. Answer in English, in your own words.` }),
      el("button", { type: "submit", class: "primary-btn", text: "Submit answers" }),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const answers = d.quiz.map((_, i) => form.elements[`a${i}`].value);
      act(() => api(`/api/pledges/${p.id}/days/${d.day}/answers`, { answers }));
    });
    nodes.push(form);
  }
  // Show the last passed day's feedback above today's card.
  const lastGraded = [...p.days].reverse().find((x) => x.grade && x.status !== "open");
  if (lastGraded) nodes.unshift(gradeBox(lastGraded.grade, `Day ${lastGraded.day}: ${lastGraded.grade.passed ? "passed" : "not passed"} — ${lastGraded.grade.score}/100`));
  v.checkin.replaceChildren(...nodes);
}

function gradeBox(g, title) {
  const box = el("div", { class: `grade ${g.passed ? "grade-ok" : "grade-no"}` }, el("strong", { text: title }), el("p", { text: g.feedback }));
  if (g.corrections && g.corrections.length) {
    const ul = el("ul", { class: "corrections" });
    for (const c of g.corrections) ul.append(el("li", {}, el("s", { text: c.original }), " → ", el("span", { text: c.better })));
    box.append(ul);
  }
  box.append(el("small", { class: "muted", text: `Graded by ${SOURCE[g.source] || "AI tutor"}` }));
  return box;
}

function renderResult(p) {
  const st = p.settlement;
  if (!st) {
    v.result.hidden = true;
    return;
  }
  v.result.hidden = false;
  const verb = st.decision.action === "void" ? "Hold voided — nothing charged" : `${money(st.capturedUsd)} captured for ${p.cause}`;
  v.result.replaceChildren(
    el("h3", { text: verb }),
    el("p", { text: st.decision.message }),
    el("p", { class: "muted", text: `Agent reasoning (${SOURCE[st.source] || st.source}): ${st.decision.reasoning}` }),
    el("p", { class: "muted", text: `Released ${money(st.releasedUsd)} · PayPal status ${st.paypalStatus}${st.captureId ? ` · capture ${st.captureId}` : ""}${st.overridden ? " · guardrail corrected the agent" : ""}` }),
  );
}

function renderLedger(p) {
  v.ledger.replaceChildren(
    ...p.ledger.map((e) => {
      const li = el(
        "li",
        { class: `entry actor-${e.actor}` },
        el("span", { class: "entry-actor", text: ACTOR[e.actor] || e.actor }),
        el("time", { datetime: e.at, text: new Date(e.at).toLocaleTimeString() }),
        el("p", { text: e.text }),
      );
      if (e.calls && e.calls.length) {
        const ul = el("ul", { class: "calls" });
        for (const c of e.calls) {
          ul.append(el("li", {}, el("code", { text: `${c.method} ${c.path}` }), ` → ${c.status}${c.debugId ? ` · debug ${c.debugId}` : ""} · ${c.ms} ms`));
        }
        li.append(ul);
      }
      return li;
    }),
  );
}

v.settleBtn?.addEventListener("click", () => act(() => api(`/api/pledges/${pledge.id}/settle`, {})));

async function openPledge(id) {
  document.body.classList.add("pledge-mode");
  v.root.hidden = false;
  for (const sel of ["plan-form", "results", "agent-panel"]) {
    const n = $(sel);
    if (n) n.hidden = true;
  }
  if (params.get("error") === "approve") showError("PayPal could not place the hold. Please try again.");
  await act(() => api(`/api/pledges/${encodeURIComponent(id)}`));
}

if (pledgeId) openPledge(pledgeId);
syncOfferLabel();

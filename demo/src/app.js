// User interface of the live demo (docs/index.html).
import { PorkDemo, ACTOR_LABELS, LOTS } from "./scenario.js";
import reference from "../reference.json";

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString("en-US");
const chainDate = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ");
const day = (t) => new Date(Number(t) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
};

const STEPS = [
  {
    key: "setup",
    title: "Consortium set-up",
    period: "1 Oct 2026",
    lede: "Deploy the contract; register seven organisations with their roles, three IoT gateways bound to a chiller, a reefer truck and a restaurant fridge, and the minimum cooking temperature.",
    run: (d) => d.setup(),
  },
  {
    key: "slaughter",
    title: "Slaughter and inspection",
    period: "5 Oct 2026",
    lede: "The slaughterhouse registers five carcasses. The official veterinarian releases four and rejects one with a positive Trichinella test. The chiller gateway reports the night's temperatures.",
    run: (d) => d.slaughter(),
  },
  {
    key: "processing",
    title: "Cutting and processing",
    period: "6–7 Oct 2026",
    lede: "Four carcasses travel to the cutting plant and become shoulder, neck and leg cuts. The processor turns them into two gyros cones and two batches of skewers. Origin and mass balance are checked at every step.",
    run: (d) => d.processing(),
  },
  {
    key: "service",
    title: "Delivery and service",
    period: "8–9 Oct 2026",
    lede: "A cone and a batch of skewers reach the restaurant in the reefer truck. The restaurant opens a lunch lot and a dinner lot, records the cooking temperatures and the portions sold.",
    run: (d) => d.service(),
  },
  {
    key: "recall",
    title: "Recall",
    period: "9 Oct 2026, evening",
    lede: "The competent authority recalls Carcass 0502. One flag is written; every product made from that carcass reads as recalled, and the dinner lot, made from other pigs, does not.",
    run: (d) => d.recall(),
  },
];
const TAG = { deploy: "deploy", setup: "set-up", slaughter: "slaughter", processing: "processing", service: "service", recall: "recall", try: "attempt" };

const RULES = {
  uninspected: "A carcass starts in PENDING_INSPECTION and can be shipped or cut only after a veterinarian records a passed inspection and a negative Trichinella test.",
  selfInspection: "The veterinarian who releases a carcass must be a different account from the slaughterhouse that created it, so no carcass enters the chain on the operator's word alone.",
  outsider: "Every write checks the caller's on-chain role, and roles are granted only to organisations the consortium administrator has registered.",
  mass: "The meat in the outputs of a transformation can never exceed the meat taken from its inputs.",
  transition: "Each role may perform only its own product transition: carcass to cut, cut to cone or skewer, cone or skewer to serving lot.",
  warm: "A delivery whose temperature at receipt exceeds the limit for the product cannot be accepted.",
  breach: "A sensor summary above the limit moves the batch to QUARANTINED. Custody can still pass, but the batch cannot be used until the authority releases it.",
  oversell: "Portions sold from a serving lot can never exceed the portions produced, which closes the mass balance from carcass to plate.",
  expired: "A batch past its use-by date cannot be transformed, shipped or sold.",
  recalled: "A recall flags one batch; isRecalled walks the ancestry, so every product made from it is blocked at once.",
};

const STATUS_PILL = {
  Active: ["valid", "Verified"],
  Consumed: ["valid", "Verified · sold out"],
  Recalled: ["bad", "Recalled · do not consume"],
  Quarantined: ["warn", "Quarantined"],
};
const COUNTRY = { GR: "Greece", XX: "several countries" };
const countryName = (c) => COUNTRY[c] ?? c;

let demo;
let next = 0;
let running = false;
let feedCount = 0;
let selectedLot = LOTS[0].id;

function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = "status " + kind;
}

function updateButtons() {
  const done = next >= STEPS.length;
  $("#run-next").disabled = running || done || !demo;
  $("#run-all").disabled = running || done || !demo;
  $("#restart").disabled = running || !demo || next === 0;
  $("#run-next").textContent = done ? "Replay complete" : `Run: ${STEPS[next].title}`;
  for (const btn of document.querySelectorAll(".attack button")) {
    const needs = Number(btn.dataset.needs);
    const ready = !!demo && next >= needs;
    btn.disabled = running || !ready;
    btn.title = ready ? "" : `Available after: ${STEPS[needs - 1].title}`;
    btn.closest(".attack").classList.toggle("locked", !ready);
  }
}

function renderSteps() {
  $("#steps").replaceChildren(
    ...STEPS.map((s, i) =>
      el(
        "li",
        { class: "step", id: `step-${s.key}`, "data-state": i < next ? "done" : "pending" },
        el("div", { class: "step-head" }, el("span", { class: "step-dot", "aria-hidden": "true" }), el("h3", { text: s.title }), el("span", { class: "step-period", text: s.period })),
        el("p", { class: "step-lede", text: s.lede }),
        el("p", { class: "step-meta", id: `meta-${s.key}` })
      )
    )
  );
}

function addFeedRow(entry) {
  feedCount += 1;
  const rejected = entry.accepted === false;
  const tr = el(
    "tr",
    { class: rejected ? "rejected" : entry.note ? "note" : "" },
    el("td", { class: "num", text: String(feedCount) }),
    el("td", { class: "mono date", text: chainDate(entry.timestamp) }),
    el("td", {}, el("span", { class: `tag ${entry.step}`, text: TAG[entry.step] ?? entry.step })),
    el("td", { text: ACTOR_LABELS[entry.actor] ?? entry.actor ?? "" }),
    el("td", {}, el("span", { class: rejected || entry.note ? "fn plain" : "fn", text: entry.fn }), entry.note ? el("span", { class: "contract", text: "view call" }) : null),
    el("td", { class: "detail", text: entry.detail ?? "" }),
    el("td", { class: "num mono" }, rejected ? el("span", { class: "err", text: `✗ ${entry.name}` }) : entry.note ? "–" : fmt(entry.gasUsed))
  );
  $("#feed tbody").prepend(tr);
  $("#feed-count").textContent = `${feedCount} entries`;
}

// ---------------------------------------------------------------- verification page

function renderLotTabs() {
  $("#lot-tabs").replaceChildren(
    ...LOTS.map((l) =>
      el("button", { type: "button", class: "lot-tab", role: "tab", "aria-selected": String(l.id === selectedLot), "data-lot": l.id }, l.title, el("small", { text: l.sub }))
    )
  );
}

function clearLot(note) {
  $("#lot-status").className = "pill none";
  $("#lot-status").textContent = "Not served yet";
  $("#lot-portions").textContent = "–";
  $("#lot-origin").textContent = "–";
  $("#lot-note").textContent = note;
  $("#lot-checks").replaceChildren();
  for (const k of ["sh", "slaughter", "served", "id"]) $(`#lot-${k}`).textContent = "–";
  $("#lot-chain").replaceChildren();
}

async function renderLot() {
  renderLotTabs();
  if (!demo || !demo.c) return clearLot("The page fills in once the restaurant opens the lot.");
  const v = await demo.lotView(selectedLot);
  if (!v) return clearLot("The page fills in once the restaurant opens the lot.");
  const [cls, label] = STATUS_PILL[v.status] ?? ["none", v.status];
  $("#lot-status").className = `pill ${cls}`;
  $("#lot-status").textContent = label;
  $("#lot-portions").textContent = `${v.sold} / ${v.portions} sold`;
  const [birth, rearing, slaughter] = v.origin;
  $("#lot-origin").textContent =
    birth === rearing && rearing === slaughter && birth !== "XX"
      ? `Origin: ${countryName(birth)}`
      : `Born in ${countryName(birth)} · reared in ${countryName(rearing)} · slaughtered in ${countryName(slaughter)}`;
  const r = v.recalled[0];
  $("#lot-note").textContent = r
    ? `${r.label} was recalled on ${day(r.at)} (reason code ${r.reason}). This lot was made from it.`
    : "Derived by the contract from the records of every carcass in the lot's ancestry.";
  $("#lot-checks").replaceChildren(
    el("li", { class: v.inspected === v.carcasses ? "ok" : "bad" }, `Veterinary inspection passed for ${v.inspected === v.carcasses ? "all" : v.inspected + " of"} ${v.carcasses} carcasses, Trichinella negative`),
    el("li", { class: v.coldChainOk ? "ok" : "bad" }, v.coldChainOk ? "Cold chain within limits at every stage" : "Temperature breach recorded upstream"),
    v.cooking
      ? el("li", { class: v.cooking.ok ? "ok" : "bad" }, `Cooked to ${v.cooking.temp.toFixed(1)} °C core temperature (minimum ${(Number(demo.minCookingTemp ?? 750) / 10).toFixed(1)} °C)`)
      : el("li", {}, "Cooking temperature not yet recorded"),
    el("li", { class: "ok" }, `${v.daysSinceSlaughter} days from slaughter to service`),
    el("li", { class: r ? "bad" : "ok" }, r ? el("b", { text: "Recalled through its ancestry" }) : "No recall in its ancestry")
  );
  $("#lot-sh").textContent = v.slaughterhouses.join(", ");
  $("#lot-slaughter").textContent = day(v.slaughterTime);
  $("#lot-served").textContent = `${chainDate(v.createdAt)} UTC`;
  $("#lot-id").textContent = `${selectedLot.slice(0, 14)}…`;
  $("#lot-id").title = selectedLot;
  $("#lot-chain").replaceChildren(...v.chain.map((c) => el("li", { text: c })));
}

function renderTotals() {
  const t = demo.totals();
  const parts = [];
  if (t.transactions) parts.push(`${fmt(t.transactions)} transactions, ${fmt(t.gasUsed)} gas`);
  if (t.deploymentGas) parts.push(`deployment ${fmt(t.deploymentGas)} gas`);
  $("#totals").textContent = parts.join(" · ");
  if (next >= STEPS.length && reference.transactions) {
    const same = t.transactions === reference.transactions && t.gasUsed === reference.gasUsed && t.deploymentGas === reference.deploymentGas;
    const box = $("#check");
    box.hidden = false;
    box.className = `check ${same ? "ok" : "warn"}`;
    box.replaceChildren(
      el("strong", { text: same ? "Replay verified against the reference. " : "Replay differs from the reference. " }),
      `Your browser executed ${fmt(t.transactions)} transactions with ${fmt(t.gasUsed)} gas and deployed the contract with ${fmt(t.deploymentGas)} gas; the Node replay of the same scenario recorded ${fmt(reference.transactions)} transactions, ${fmt(reference.gasUsed)} gas and ${fmt(reference.deploymentGas)} gas.`
    );
  }
}

async function runStep() {
  const step = STEPS[next];
  running = true;
  updateButtons();
  const li = $(`#step-${step.key}`);
  li.dataset.state = "running";
  setStatus(`Running ${step.title}…`, "busy");
  const before = demo.entries.length;
  const t0 = performance.now();
  try {
    await step.run(demo);
    const entries = demo.entries.slice(before);
    const deploy = step.key === "setup" ? demo.totals().deploymentGas : 0;
    const gas = entries.reduce((s, e) => s + e.gasUsed, 0) + deploy;
    const n = entries.length + (deploy ? 1 : 0);
    $(`#meta-${step.key}`).textContent = `${n} transaction${n === 1 ? "" : "s"} · ${fmt(gas)} gas · ${((performance.now() - t0) / 1000).toFixed(1)} s in your browser`;
    li.dataset.state = "done";
    next += 1;
    if (step.key === "setup") demo.minCookingTemp = await demo.c.minCookingTemp();
    await renderLot();
    renderTotals();
    setStatus(next >= STEPS.length ? "Replay complete. Switch between the two lots, then try to break the rules below." : `Done. Next: ${STEPS[next].title}.`, "ok");
  } catch (err) {
    li.dataset.state = "error";
    setStatus(`Error: ${err.shortMessage ?? err.message}`, "bad");
    console.error(err);
  } finally {
    running = false;
    updateButtons();
  }
}

async function runAll() {
  while (next < STEPS.length && !running) {
    await runStep();
    if ($(`#step-${STEPS[next - 1].key}`).dataset.state === "error") break;
  }
}

function renderAttacks() {
  $("#attacks").replaceChildren(
    ...demo.attacks().map((a) =>
      el(
        "article",
        { class: "attack locked", id: `attack-${a.key}` },
        el("div", { class: "attack-head" }, el("span", { class: "req", text: a.tag }), el("h3", { text: a.title })),
        el("p", { class: "story", text: a.story }),
        el("button", { type: "button", class: "btn small", "data-key": a.key, "data-needs": String(a.needs), text: "Try it" }),
        el("div", { class: "outcome", "aria-live": "polite" })
      )
    )
  );
}

function onAttackClick() {
  $("#attacks").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-key]");
    if (!btn || btn.disabled) return;
    const attack = demo.attacks().find((a) => a.key === btn.dataset.key);
    const out = btn.parentElement.querySelector(".outcome");
    running = true;
    updateButtons();
    out.replaceChildren(el("p", { class: "muted", text: "Sending to the contract…" }));
    try {
      const res = await attack.run();
      const details = demo.describeArgs(res.name, res.args ?? []);
      if (res.accepted) {
        out.replaceChildren(el("p", { class: "verdict warn", text: "Accepted (unexpected)" }));
      } else {
        out.replaceChildren(
          ...[
            el("p", { class: "verdict ok" }, "Rejected: ", el("code", { text: res.name })),
            res.note ? el("p", { class: "muted small", text: res.note }) : null,
            details.length ? el("ul", { class: "args" }, ...details.map((d) => el("li", { text: d }))) : null,
            el("p", { class: "rule", text: RULES[attack.key] }),
          ].filter(Boolean)
        );
      }
      addFeedRow({ fn: attack.title, step: "try", actor: "", timestamp: demo.latest(), accepted: res.accepted, name: res.name, detail: "tried on a snapshot and rolled back" });
    } catch (err) {
      out.replaceChildren(el("p", { class: "verdict bad", text: `Error: ${err.shortMessage ?? err.message}` }));
      console.error(err);
    } finally {
      running = false;
      updateButtons();
    }
  });
}

async function start() {
  demo = null;
  updateButtons();
  feedCount = 0;
  $("#feed tbody").replaceChildren();
  $("#feed-count").textContent = "0 entries";
  $("#check").hidden = true;
  $("#totals").textContent = "";
  next = 0;
  renderSteps();
  await renderLot();
  setStatus("Preparing the in-browser chain…", "busy");
  demo = await new PorkDemo({
    onTx: (e) => {
      addFeedRow(e);
      if (window.__pace) return new Promise((r) => setTimeout(r, window.__pace));
    },
    onLots: () => renderLot(),
  }).init();
  renderAttacks();
  setStatus("Ready. Run the five steps one by one, or all at once.", "ok");
  updateButtons();
}

window.addEventListener("DOMContentLoaded", () => {
  $("#run-next").addEventListener("click", () => runStep());
  $("#run-all").addEventListener("click", () => runAll());
  $("#restart").addEventListener("click", () => start().catch((e) => setStatus(`Error: ${e.message}`, "bad")));
  $("#lot-tabs").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-lot]");
    if (!b) return;
    selectedLot = b.dataset.lot;
    renderLot().catch((e) => console.error(e));
  });
  onAttackClick();
  const pace = $("#pace");
  const applyPace = () => (window.__pace = pace.checked ? 140 : 0);
  pace.addEventListener("change", applyPace);
  applyPace();
  start().catch((e) => {
    setStatus(`This browser could not start the demo: ${e.message}`, "bad");
    console.error(e);
  });
});

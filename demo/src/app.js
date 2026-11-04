// User interface of the live demo (docs/index.html).
import { PorkTraceDemo, ACTOR_LABELS, LOTS, REASON } from "./scenario.js";
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
    title: "Set-up",
    period: "1 Oct 2026",
    lede: "The owner deploys the contract with the limits of the HACCP plan (4 °C chilled, −18 °C frozen, 75 °C cooking, 15 minutes of tolerance), adds a staff account and binds a sensor account to the fridge and to the freezer.",
    run: (d) => d.setup(),
  },
  {
    key: "deliveries",
    title: "Deliveries",
    period: "8 Oct 2026",
    lede: "The staff scan four cases and record what the labels say: two Greek products, a gyros cone from pigs born and reared in Denmark, and frozen skewers from the Netherlands. The contract checks use-by dates and receipt temperatures.",
    run: (d) => d.deliveries(),
  },
  {
    key: "storage",
    title: "Storage",
    period: "8–9 Oct 2026",
    lede: "The fridge and freezer sensors report the overnight window: minimum, maximum and mean temperature, minutes above the limit, and the hash of the full series kept off-chain.",
    run: (d) => d.storage(),
  },
  {
    key: "service",
    title: "Service",
    period: "9 Oct 2026",
    lede: "The staff open a lunch lot from the Greek cone and a dinner lot from the Greek skewers and the Danish-born cone. The contract computes the portions and the origin of each lot; cooking temperatures and POS sales follow.",
    run: (d) => d.service(),
  },
  {
    key: "withdrawal",
    title: "Supplier recall",
    period: "9 Oct 2026, evening",
    lede: "Meat processor B recalls cone GC-2610-K7 and the owner withdraws it. The dinner lot, made partly from it, shows a warning at once; the lunch lot does not.",
    run: (d) => d.withdrawal(),
  },
];
const TAG = { deploy: "deploy", setup: "set-up", deliveries: "delivery", storage: "storage", service: "service", withdrawal: "recall", try: "attempt" };

const RULES = {
  outsider: "Only OWNER, STAFF and SENSOR accounts can write; every read is public and needs no account.",
  handTyped: "Storage temperatures come from the sensor account bound to that fridge or freezer, so they are measured, not typed in.",
  expired: "A delivery whose use-by date has passed cannot be registered.",
  warm: "A delivery received above the limit for its storage type cannot be registered.",
  door: "A storage report whose minutes above the limit exceed the tolerance withdraws every batch in stock in that unit, and every lot made from them shows a warning.",
  grams: "The grams taken from a batch never exceed the grams received.",
  oversell: "The contract computes the portions produced, and the portions sold can never exceed them.",
  recook: "No function deletes or overwrites a stored record; the cooking temperature of a lot is recorded once.",
  withdrawn: "A batch that is withdrawn, depleted or past its use-by date cannot be used in a serving lot.",
};

const COUNTRY = { GR: "Greece", DK: "Denmark", NL: "the Netherlands", XX: "several countries" };
const countryName = (c) => COUNTRY[c] ?? c;
const originText = ([b, r, s]) => (b === r && r === s ? `Origin: ${countryName(b)}` : `Born in ${countryName(b)} · reared in ${countryName(r)} · slaughtered in ${countryName(s)}`);

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
    el("td", {}, el("span", { class: rejected || entry.note ? "fn plain" : "fn", text: entry.fn }), entry.note && entry.step !== "try" ? el("span", { class: "contract", text: "view call" }) : null),
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
  $("#lot-origin-detail").hidden = true;
  $("#lot-note").textContent = note;
  $("#lot-checks").replaceChildren();
  for (const k of ["supplier", "sh", "slaughter", "served"]) $(`#lot-${k}`).textContent = "–";
  $("#lot-chain").replaceChildren();
}

async function renderLot() {
  renderLotTabs();
  if (!demo || !demo.c) return clearLot("The page fills in once the restaurant opens the lot.");
  const v = await demo.lotView(selectedLot);
  if (!v) return clearLot("The page fills in once the restaurant opens the lot.");
  $("#lot-status").className = `pill ${v.withdrawn ? "bad" : "valid"}`;
  $("#lot-status").textContent = v.withdrawn ? "Withdrawn batch · warning" : v.closed ? "Verified · lot closed" : "Verified";
  $("#lot-portions").textContent = `${v.sold} / ${v.portions} sold`;
  $("#lot-origin").textContent = v.singleCountry ? `Origin: ${countryName(v.singleCountry)}` : v.origin.every((c, i) => c === v.origin[0]) ? originText(v.origin) : "Mixed origin";
  const list = (i) => [...new Set(v.batches.map((b) => countryName(b.origin[i])))].join(" and ");
  $("#lot-origin-detail").hidden = !!v.singleCountry;
  $("#lot-origin-detail").textContent = `Born in ${list(0)} · reared in ${list(1)} · slaughtered in ${list(2)}`;
  const w = v.batches.find((b) => b.withdrawal);
  $("#lot-note").textContent = w
    ? `${w.code} was withdrawn on ${day(Number(w.withdrawal.withdrawnAt))} (${REASON[Number(w.withdrawal.reasonCode)]}). This lot was made partly from it.`
    : v.singleCountry
      ? "Every batch in the lot was born, reared and slaughtered in this country, so the contract allows the single-country claim."
      : "The batches disagree on a country, so the contract records it as mixed; the origin of each batch is listed below.";
  $("#lot-checks").replaceChildren(
    el("li", { class: v.storageOk ? "ok" : "bad" }, v.storageOk ? "Storage stayed within the limit for every batch" : "Storage went above the limit for a batch"),
    v.cooking
      ? el("li", { class: v.cooking.ok ? "ok" : "bad" }, `Cooked to ${v.cooking.temp.toFixed(1)} °C core temperature (minimum 75.0 °C)`)
      : el("li", {}, "Cooking temperature not yet recorded"),
    el("li", { class: "ok" }, `${v.daysSinceSlaughter} days from the oldest slaughter date to the lot`),
    el("li", { class: "ok" }, `${v.portions} portions of ${v.gramsPerPortion} g computed from the meat used`),
    el("li", { class: v.withdrawn ? "bad" : "ok" }, v.withdrawn ? el("b", { text: "A batch of this lot has been withdrawn" }) : "No batch of this lot has been withdrawn")
  );
  $("#lot-supplier").textContent = [...new Set(v.batches.map((b) => b.supplier))].join(", ");
  $("#lot-sh").textContent = [...new Set(v.batches.map((b) => b.sh))].join(", ");
  $("#lot-slaughter").textContent = day(v.oldestSlaughter);
  $("#lot-served").textContent = `${chainDate(v.openedAt)} UTC`;
  $("#lot-chain").replaceChildren(
    ...v.batches.map((b) =>
      el("li", { text: `${b.product} ${b.code} · ${(b.grams / 1000).toFixed(1)} kg · born ${b.origin[0]}, reared ${b.origin[1]}, slaughtered ${b.origin[2]}${b.withdrawal ? " · withdrawn" : ""}` })
    )
  );
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
      if (res.auto) {
        out.replaceChildren(
          el("p", { class: "verdict ok" }, "Withdrawn automatically: ", el("code", { text: res.name })),
          el("ul", { class: "args" }, ...res.withdrawn.map((d) => el("li", { text: d }))),
          el("p", { class: "rule", text: RULES[attack.key] })
        );
      } else if (res.accepted) {
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
      addFeedRow(res.auto
        ? { fn: attack.title, step: "try", actor: "", timestamp: demo.latest(), note: true, detail: `tried on a snapshot and rolled back · ${res.withdrawn.length} batches withdrawn automatically` }
        : { fn: attack.title, step: "try", actor: "", timestamp: demo.latest(), accepted: res.accepted, name: res.name, detail: "tried on a snapshot and rolled back" });
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
  demo = await new PorkTraceDemo({
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

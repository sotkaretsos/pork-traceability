// Replay of one day at a souvlaki restaurant through the compiled PorkTrace contract (simplified
// model) on the in-browser chain: set-up, deliveries, storage reports, two serving lots, and a
// supplier recall. Rule-breaking attempts run on a snapshot of the chain and are rolled back.
// The same module runs in Node for demo/test/run-replay.mjs.

import { ethers } from "ethers";
import ARTIFACTS from "../build/contracts.json";
import { LocalChain } from "./local-chain.js";

export const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
export const GENESIS = "2026-10-01T06:00:00Z";

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
const id = (label) => ethers.id(label);
const cc = (code) => ethers.hexlify(ethers.toUtf8Bytes(code));
const country = (hex) => ethers.toUtf8String(hex);
const doc = (label) => ethers.sha256(ethers.toUtf8Bytes(`demo document: ${label}`));
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export const PRODUCT = ["Gyros cone", "Skewers"];
export const STORAGE = ["chilled", "frozen"];
export const BATCH_STATUS = ["In stock", "Depleted", "Withdrawn"];
export const REASON = ["supplier recall", "temperature", "quality", "other"];
const FRIDGE = 1;
const FREEZER = 2;
export const UNITS = { [FRIDGE]: "Fridge 1", [FREEZER]: "Freezer 2" };

const ACTORS = [
  { key: "owner", index: 0, label: "Restaurant owner" },
  { key: "staff", index: 1, label: "Restaurant staff" },
  { key: "fridge", index: 2, label: "Fridge 1 sensor" },
  { key: "freezer", index: 3, label: "Freezer 2 sensor" },
  { key: "outsider", index: 4, label: "Customer (no role)" },
];
export const ACTOR_LABELS = Object.fromEntries(ACTORS.map((a) => [a.key, a.label]));

/** Deliveries recorded by the staff (label data of each case). */
const DELIVERIES = {
  CONE_GR: { label: "Gyros cone GC-2610-A1", productType: 0, storageType: 0, supplier: "Meat processor A", code: "GC-2610-A1", origin: ["GR", "GR", "GR"], sh: "EL-DEMO-SH-01", slaughter: "2026-10-05T06:10:00Z", useBy: "2026-10-11T23:00:00Z", grams: 40_000, receiptTemp: 29, unit: FRIDGE },
  SKEWERS_GR: { label: "Skewers SK-2610-B1", productType: 1, storageType: 0, supplier: "Meat processor A", code: "SK-2610-B1", origin: ["GR", "GR", "GR"], sh: "EL-DEMO-SH-01", slaughter: "2026-10-05T06:19:00Z", useBy: "2026-10-11T23:00:00Z", grams: 20_000, receiptTemp: 31, unit: FRIDGE },
  CONE_DK: { label: "Gyros cone GC-2610-K7", productType: 0, storageType: 0, supplier: "Meat processor B", code: "GC-2610-K7", origin: ["DK", "DK", "GR"], sh: "EL-DEMO-SH-02", slaughter: "2026-10-04T07:40:00Z", useBy: "2026-10-11T23:00:00Z", grams: 40_000, receiptTemp: 33, unit: FRIDGE },
  SKEWERS_NL: { label: "Frozen skewers FZ-2609-N2", productType: 1, storageType: 1, supplier: "Meat processor C", code: "FZ-2609-N2", origin: ["NL", "NL", "NL"], sh: "NL-DEMO-SH-09", slaughter: "2026-09-18T05:30:00Z", useBy: "2027-01-18T23:00:00Z", grams: 25_000, receiptTemp: -195, unit: FREEZER },
};
const B = Object.fromEntries(Object.entries(DELIVERIES).map(([k, d]) => [k, id(`GS1 ${d.code} received 2026-10-08`)]));
const L = { LUNCH: id("LOT 2026-10-09 lunch"), DINNER: id("LOT 2026-10-09 dinner") };
export const LOTS = [
  { key: "LUNCH", id: L.LUNCH, title: "Lunch lot", sub: "Gyros · 9 Oct 2026" },
  { key: "DINNER", id: L.DINNER, title: "Dinner lot", sub: "Gyros and skewers · 9 Oct 2026" },
];

export class PorkTraceDemo {
  /** @param {object} hooks  UI callbacks: onTx(entry), onLots() */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.state = { step: 0 };
    this.entries = [];
    this.deployments = [];
    this.labelById = new Map(Object.entries(B).map(([k, v]) => [v, DELIVERIES[k].label]));
    this.labelById.set(L.LUNCH, "Lunch lot, 9 Oct");
    this.labelById.set(L.DINNER, "Dinner lot, 9 Oct");
    this.labelById.set(id("old skewers"), "Skewers, expired case");
  }

  emit(name, payload) {
    return this.hooks[name] ? this.hooks[name](payload) : undefined;
  }

  async init() {
    const root = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, "", "m/44'/60'/0'/0");
    const keys = Array.from({ length: ACTORS.length }, (_, i) => ethers.getBytes(root.deriveChild(i).privateKey));
    this.chain = await new LocalChain({ privateKeys: keys, chainId: 31337, genesisTime: ts(GENESIS) }).init();
    this.provider = new ethers.BrowserProvider(this.chain, { chainId: 31337, name: "pork-demo" }, { staticNetwork: true, cacheTimeout: -1 });
    this.signers = {};
    this.actorByAddress = new Map();
    for (const a of ACTORS) {
      this.signers[a.key] = await this.provider.getSigner(this.chain.accounts[a.index]);
      this.actorByAddress.set(this.chain.accounts[a.index].toLowerCase(), a.key);
    }
    return this;
  }

  latest() {
    return this.chain.latestTimestamp();
  }

  at(iso) {
    const t = ts(iso);
    if (t > this.latest()) this.chain.increaseTo(t);
  }

  as(actor) {
    return this.c.connect(this.signers[actor]);
  }

  async send(step, fn, detail, txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const block = await this.provider.getBlock(receipt.blockNumber);
    const entry = { step, fn, detail, actor: this.actorByAddress.get(receipt.from.toLowerCase()) ?? "", gasUsed: Number(receipt.gasUsed), timestamp: block.timestamp, hash: receipt.hash };
    this.entries.push(entry);
    await this.emit("onTx", entry);
    await yieldToUi();
    return receipt;
  }

  batchInput(k, overrides = {}) {
    const d = { ...DELIVERIES[k], ...overrides };
    return {
      batchId: overrides.batchId ?? B[k],
      productType: d.productType,
      storageType: d.storageType,
      supplierName: d.supplier,
      supplierBatchCode: d.code,
      origin: { countryOfBirth: cc(d.origin[0]), countryOfRearing: cc(d.origin[1]), countryOfSlaughter: cc(d.origin[2]) },
      slaughterhouseApproval: d.sh,
      slaughterDate: ts(d.slaughter),
      useByDate: ts(d.useBy),
      grams: d.grams,
      receiptTemp: d.receiptTemp,
      storageUnit: d.unit,
      docHash: doc(`delivery note and label photo ${d.code}`),
    };
  }

  // ------------------------------------------------------------------ step 1: set-up

  async setup() {
    this.at("2026-10-01T08:00:00Z");
    const owner = this.signers.owner;
    const art = ARTIFACTS.PorkTrace;
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, owner);
    const contract = await factory.deploy(owner.address, 40, -180, 750, 15);
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    const code = await this.provider.getCode(await contract.getAddress());
    this.c = contract;
    this.deployments.push({ name: "PorkTrace", gasUsed: Number(receipt.gasUsed), runtimeBytes: (code.length - 2) / 2 });
    await this.emit("onTx", {
      step: "deploy",
      fn: "deploy PorkTrace",
      detail: `${((code.length - 2) / 2).toLocaleString("en-US")} bytes · limits 4.0 °C chilled, −18.0 °C frozen · cooking ≥ 75.0 °C · tolerance 15 min`,
      actor: "owner",
      gasUsed: Number(receipt.gasUsed),
      timestamp: this.latest(),
    });
    await this.send("setup", "addStaff", "Staff account for the back office and the POS", this.as("owner").addStaff(this.signers.staff.address));
    await this.send("setup", "addSensor", "Fridge 1 sensor bound to storage unit 1", this.as("owner").addSensor(this.signers.fridge.address, FRIDGE));
    await this.send("setup", "addSensor", "Freezer 2 sensor bound to storage unit 2", this.as("owner").addSensor(this.signers.freezer.address, FREEZER));
    this.state.step = 1;
  }

  // ------------------------------------------------------------------ step 2: deliveries

  async deliveries() {
    this.at("2026-10-08T06:00:00Z");
    for (const k of Object.keys(DELIVERIES)) {
      const d = DELIVERIES[k];
      await this.send("deliveries", "registerBatch",
        `${d.label} · ${d.supplier} · born ${d.origin[0]}, reared ${d.origin[1]}, slaughtered ${d.origin[2]} · ${(d.grams / 1000).toFixed(1)} kg at ${(d.receiptTemp / 10).toFixed(1)} °C → ${UNITS[d.unit]}`,
        this.as("staff").registerBatch(this.batchInput(k)));
    }
    this.state.step = 2;
  }

  // ------------------------------------------------------------------ step 3: storage

  async storage() {
    this.at("2026-10-09T06:05:00Z");
    await this.send("storage", "reportStorage", "Fridge 1 · 8 Oct 06:00 – 9 Oct 06:00 · min 1.6 · max 3.7 · mean 2.5 °C · 0 min above",
      this.as("fridge").reportStorage(FRIDGE, ts("2026-10-08T06:00:00Z"), ts("2026-10-09T06:00:00Z"), 16, 37, 25, 0, doc("fridge series 8–9 Oct")));
    await this.send("storage", "reportStorage", "Freezer 2 · 8 Oct 06:00 – 9 Oct 06:00 · min −21.0 · max −18.8 · mean −19.9 °C · 0 min above",
      this.as("freezer").reportStorage(FREEZER, ts("2026-10-08T06:00:00Z"), ts("2026-10-09T06:00:00Z"), -210, -188, -199, 0, doc("freezer series 8–9 Oct")));
    this.state.step = 3;
  }

  // ------------------------------------------------------------------ step 4: service

  async service() {
    this.at("2026-10-09T09:00:00Z");
    await this.send("service", "openLot", "Lunch lot · 15.0 kg of GC-2610-A1 at 150 g per portion → 100 portions, origin computed",
      this.as("staff").openLot(L.LUNCH, [B.CONE_GR], [15_000], 150));
    await this.send("service", "recordCooking", "Lunch lot · core temperature 78.5 °C", this.as("staff").recordCooking(L.LUNCH, 785, doc("cooking log lunch")));
    this.at("2026-10-09T13:00:00Z");
    await this.send("service", "recordSales", "Lunch lot · 92 portions (POS aggregate)", this.as("staff").recordSales(L.LUNCH, 92));
    await this.send("service", "closeLot", "Lunch lot closed at the end of the shift", this.as("staff").closeLot(L.LUNCH));
    this.at("2026-10-09T15:00:00Z");
    await this.send("service", "openLot", "Dinner lot · 12.0 kg of SK-2610-B1 + 6.0 kg of GC-2610-K7 at 120 g → 150 portions",
      this.as("staff").openLot(L.DINNER, [B.SKEWERS_GR, B.CONE_DK], [12_000, 6_000], 120));
    await this.send("service", "recordCooking", "Dinner lot · core temperature 81.0 °C", this.as("staff").recordCooking(L.DINNER, 810, doc("cooking log dinner")));
    this.at("2026-10-09T19:30:00Z");
    await this.send("service", "recordSales", "Dinner lot · 140 portions so far (POS aggregate)", this.as("staff").recordSales(L.DINNER, 140));
    this.state.step = 4;
    await this.emit("onLots");
  }

  // ------------------------------------------------------------------ step 5: withdrawal

  async withdrawal() {
    this.at("2026-10-09T20:30:00Z");
    await this.send("withdrawal", "withdrawBatch", "GC-2610-K7 · supplier recall notified by Meat processor B",
      this.as("owner").withdrawBatch(B.CONE_DK, 0, doc("supplier recall notice GC-2610-K7")));
    this.state.step = 5;
    await this.emit("onLots");
  }

  // ------------------------------------------------------------------ read model for the verification page

  async lotView(lotId) {
    let s;
    try {
      s = await this.c.getLotSummary(lotId);
    } catch (_) {
      return null;
    }
    const lot = await this.c.getLot(lotId);
    const batches = [];
    for (const [i, bid] of [...s.batchIds].entries()) {
      const b = await this.c.getBatch(bid);
      const o = b.origin;
      batches.push({
        label: this.labelById.get(bid) ?? bid.slice(0, 10),
        product: PRODUCT[Number(b.productType)],
        storage: STORAGE[Number(b.storageType)],
        supplier: b.supplierName,
        code: b.supplierBatchCode,
        sh: b.slaughterhouseApproval,
        origin: [country(o.countryOfBirth), country(o.countryOfRearing), country(o.countryOfSlaughter)],
        grams: Number(lot.gramsUsed[i]),
        status: BATCH_STATUS[Number(b.status)],
        withdrawal: Number(b.status) === 2 ? await this.c.getWithdrawal(bid) : null,
      });
    }
    const o = s.origin;
    return {
      origin: [country(o.countryOfBirth), country(o.countryOfRearing), country(o.countryOfSlaughter)],
      singleCountry: s.singleCountry === "0x0000" ? null : country(s.singleCountry),
      openedAt: Number(s.openedAt),
      oldestSlaughter: Number(s.oldestSlaughterDate),
      daysSinceSlaughter: Number(s.daysSinceSlaughter),
      storageOk: s.storageWithinLimit,
      cooking: s.cookingRecorded ? { temp: Number(s.coreTemp) / 10, ok: s.cookingMeetsMinimum } : null,
      withdrawn: s.anyWithdrawn,
      portions: Number(s.portionsProduced),
      sold: Number(s.portionsSold),
      closed: s.closed,
      gramsPerPortion: Number(lot.gramsPerPortion),
      batches,
    };
  }

  totals() {
    return { transactions: this.entries.length, gasUsed: this.entries.reduce((s, e) => s + e.gasUsed, 0), deploymentGas: this.deployments.reduce((s, d) => s + d.gasUsed, 0) };
  }

  // ------------------------------------------------------------------ rejected transactions

  decodeError(err) {
    if (err && err.revert && err.revert.name) return { name: err.revert.name, args: [...err.revert.args] };
    const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try {
        const parsed = this.c.interface.parseError(data);
        if (parsed) return { name: parsed.name, args: [...parsed.args] };
      } catch (_) {
        /* fall through */
      }
      return { name: "Reverted", args: [data.slice(0, 10)] };
    }
    return { name: "Error", args: [String(err?.shortMessage ?? err?.message ?? err)] };
  }

  async attempt(fn) {
    try {
      await fn();
      return { accepted: true };
    } catch (err) {
      return { accepted: false, ...this.decodeError(err) };
    }
  }

  async sandbox(fn) {
    const snap = await this.provider.send("evm_snapshot", []);
    const hooks = this.hooks;
    this.hooks = {};
    const entries = this.entries.length;
    try {
      return await fn();
    } finally {
      this.hooks = hooks;
      this.entries.length = entries;
      await this.provider.send("evm_revert", [snap]);
    }
  }

  /** Rule-breaking attempts of the "Try to break the rules" panel. `needs` = steps that must be done. */
  attacks() {
    const q = (signer, call) => call(this.c.connect(this.signers[signer]));
    return [
      {
        key: "outsider",
        tag: "Roles",
        title: "Record a delivery without an account",
        story: "A customer's account, which holds no role, tries to register a gyros cone of Greek origin.",
        expect: "AccessControlUnauthorizedAccount",
        needs: 1,
        run: () => this.sandbox(() => this.attempt(() => q("outsider", (c) => c.registerBatch.staticCall(this.batchInput("CONE_GR", { batchId: id("fake") }))))),
      },
      {
        key: "handTyped",
        tag: "Roles",
        title: "Type a fridge temperature by hand",
        story: "A staff member enters a reassuring storage report for Fridge 1 instead of the sensor.",
        expect: "AccessControlUnauthorizedAccount",
        needs: 1,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.reportStorage.staticCall(FRIDGE, ts("2026-10-09T06:00:00Z"), ts("2026-10-09T06:30:00Z"), 20, 30, 25, 0, doc("x"))))),
      },
      {
        key: "expired",
        tag: "Use-by date",
        title: "Register an expired delivery",
        story: "A case of skewers whose use-by date passed yesterday is scanned at receipt.",
        expect: "UseByPassed",
        needs: 2,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.registerBatch.staticCall(this.batchInput("SKEWERS_GR", { batchId: id("old skewers"), useBy: new Date((this.latest() - 86400) * 1000).toISOString() }))))),
      },
      {
        key: "warm",
        tag: "Temperature",
        title: "Accept a warm delivery",
        story: "A chilled gyros cone arrives at 6.2 °C, above the 4 °C limit, and the staff try to register it.",
        expect: "ReceiptTemperatureAboveLimit",
        needs: 2,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.registerBatch.staticCall(this.batchInput("CONE_GR", { batchId: id("warm cone"), receiptTemp: 62 }))))),
      },
      {
        key: "door",
        tag: "Temperature",
        title: "Leave the fridge door open",
        story: "Fridge 1 spends 40 minutes above 4 °C in one window, more than the 15-minute tolerance. Nobody has to act: the sensor's report is enough.",
        expect: "auto",
        needs: 3,
        run: () => this.sandbox(async () => {
          const from = Math.max(Number(await this.c.lastWindowEnd(FRIDGE)), this.latest() - 7200);
          if (from + 3600 >= this.latest()) this.chain.increaseTo(from + 3660);
          const tx = await q("fridge", (c) => c.reportStorage(FRIDGE, from, from + 3600, 30, 92, 51, 40, doc("door open")));
          const rc = await tx.wait();
          const withdrawn = rc.logs.map((l) => { try { return this.c.interface.parseLog(l); } catch (_) { return null; } }).filter((e) => e && e.name === "BatchWithdrawn").map((e) => this.labelById.get(e.args[0]) ?? e.args[0]);
          return { accepted: true, auto: true, name: "BatchWithdrawn", withdrawn };
        }),
      },
      {
        key: "grams",
        tag: "Mass balance",
        title: "Take more meat than the cone holds",
        story: "25.0 kg of cone GC-2610-A1 remain after lunch. A new lot claims 30.0 kg from it.",
        expect: "InsufficientGrams",
        needs: 4,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.openLot.staticCall(id("LOT extra"), [B.CONE_GR], [30_000], 150)))),
      },
      {
        key: "oversell",
        tag: "Mass balance",
        title: "Sell more portions than produced",
        story: "The dinner lot produced 150 portions and 140 are already sold. The POS reports 11 more.",
        expect: "PortionsExceeded",
        needs: 4,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.recordSales.staticCall(L.DINNER, 11)))),
      },
      {
        key: "recook",
        tag: "No overwriting",
        title: "Rewrite the cooking temperature",
        story: "The dinner lot's cooking record says 81.0 °C. Someone tries to record a second, different value.",
        expect: "CookingAlreadyRecorded",
        needs: 4,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.recordCooking.staticCall(L.DINNER, 900, doc("x"))))),
      },
      {
        key: "withdrawn",
        tag: "Withdrawal",
        title: "Cook a withdrawn batch",
        story: "After the supplier's recall, the staff open a late lot with what is left of cone GC-2610-K7.",
        expect: "BatchNotInStock",
        needs: 5,
        run: () => this.sandbox(() => this.attempt(() => q("staff", (c) => c.openLot.staticCall(id("LOT late"), [B.CONE_DK], [5_000], 150)))),
      },
    ];
  }

  describeArgs(name, args) {
    const label = (h) => this.labelById.get(h) ?? (typeof h === "string" && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : String(h));
    const who = (a) => ACTOR_LABELS[this.actorByAddress.get(String(a).toLowerCase())] ?? `${String(a).slice(0, 8)}…`;
    const role = (r) => (r === ethers.id("SENSOR") ? "SENSOR" : r === ethers.id("STAFF") ? "STAFF" : r === ethers.ZeroHash ? "OWNER" : String(r).slice(0, 10));
    switch (name) {
      case "AccessControlUnauthorizedAccount":
        return [`account: ${who(args[0])}`, `required role: ${role(args[1])}`];
      case "UseByPassed":
      case "CookingAlreadyRecorded":
        return [`record: ${label(args[0])}`];
      case "ReceiptTemperatureAboveLimit":
        return [`measured: ${(Number(args[0]) / 10).toFixed(1)} °C`, `limit: ${(Number(args[1]) / 10).toFixed(1)} °C`];
      case "InsufficientGrams":
        return [`batch: ${label(args[0])}`, `remaining: ${(Number(args[1]) / 1000).toFixed(1)} kg`, `requested: ${(Number(args[2]) / 1000).toFixed(1)} kg`];
      case "PortionsExceeded":
        return [`produced: ${args[0]}`, `sold after this report: ${args[1]}`];
      case "BatchNotInStock":
        return [`batch: ${label(args[0])}`, `status: ${BATCH_STATUS[Number(args[1])]}`];
      default:
        return (args ?? []).map((a) => String(a));
    }
  }
}

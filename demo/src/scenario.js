// Replay of a pork supply chain through the compiled PorkTraceability contract on the in-browser
// chain: consortium set-up, slaughter and inspection, cutting and processing, delivery and service
// at a souvlaki restaurant, and a recall. A set of rule-breaking attempts is executed on a snapshot
// of the chain and rolled back. The same module runs in Node for demo/test/run-replay.mjs.

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
const DAY = 86400;

export const P = { CARCASS: 0, PRIMAL_CUT: 1, GYROS_CONE: 2, SKEWER: 3, SERVING_LOT: 4 };
export const S = { CHILLED: 0, FROZEN: 1 };
export const STATUS = ["Pending inspection", "Active", "In transit", "Quarantined", "Rejected", "Consumed", "Recalled"];
export const PRODUCT = ["Carcass", "Primal cut", "Gyros cone", "Skewers", "Serving lot"];

/** Account index of each actor in the Hardhat test mnemonic. */
const ACTORS = [
  { key: "admin", index: 0, label: "Consortium administrator" },
  { key: "slaughterhouse", index: 1, label: "Slaughterhouse", approvalNo: "EL-DEMO-SH-01", roles: ["SLAUGHTERHOUSE"] },
  { key: "veterinarian", index: 2, label: "Official veterinarian", approvalNo: "EL-DEMO-VET-01", roles: ["VETERINARIAN"] },
  { key: "cuttingPlant", index: 3, label: "Cutting plant", approvalNo: "EL-DEMO-CP-01", roles: ["CUTTING_PLANT"] },
  { key: "processor", index: 4, label: "Meat processor", approvalNo: "EL-DEMO-MP-01", roles: ["PROCESSOR"] },
  { key: "carrier", index: 5, label: "Refrigerated carrier", approvalNo: "EL-DEMO-LOG-01", roles: ["CARRIER"] },
  { key: "restaurant", index: 6, label: "Souvlaki restaurant", approvalNo: "EL-DEMO-RST-01", roles: ["RETAILER"] },
  { key: "authority", index: 7, label: "Competent authority", approvalNo: "EL-DEMO-CA-01", roles: ["AUTHORITY"] },
  { key: "chiller", index: 8, label: "Chiller gateway", device: { org: "slaughterhouse", location: "SLAUGHTERHOUSE/CHILLER-1" } },
  { key: "truck", index: 9, label: "Vehicle gateway", device: { org: "carrier", location: "VEHICLE/REEFER-07" } },
  { key: "fridge", index: 10, label: "Refrigerator gateway", device: { org: "restaurant", location: "RESTAURANT/FRIDGE-1" } },
  { key: "outsider", index: 11, label: "Outsider (not registered)" },
];
export const ACTOR_LABELS = Object.fromEntries(ACTORS.map((a) => [a.key, a.label]));

/** Batches of the scenario: label shown on the page → GS1-style identifier hashed into the batch ID. */
export const BATCHES = {
  C1: "Carcass 0501",
  C2: "Carcass 0502",
  C3: "Carcass 0503",
  C4: "Carcass 0504",
  C5: "Carcass 0505",
  SHOULDER_A: "Shoulder A",
  NECK_A: "Neck A",
  SHOULDER_B: "Shoulder B",
  LEG_B: "Leg B",
  CONE_A1: "Gyros cone A1",
  CONE_A2: "Gyros cone A2",
  SKEWERS_B1: "Skewers B1",
  SKEWERS_B2: "Skewers B2",
  LOT_LUNCH: "Lunch lot, 9 Oct",
  LOT_DINNER: "Dinner lot, 9 Oct",
};
const B = Object.fromEntries(Object.entries(BATCHES).map(([k, label]) => [k, id(`GS1 LOT ${label}`)]));
export const LOTS = [
  { key: "LOT_LUNCH", id: B.LOT_LUNCH, title: "Lunch lot", sub: "Gyros · 9 Oct 2026" },
  { key: "LOT_DINNER", id: B.LOT_DINNER, title: "Dinner lot", sub: "Skewers · 9 Oct 2026" },
];

export class PorkDemo {
  /** @param {object} hooks  UI callbacks: onTx(entry), onLots() */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.state = { step: 0 };
    this.entries = [];
    this.deployments = [];
    this.labelById = new Map(Object.entries(B).map(([k, v]) => [v, BATCHES[k]]));
    for (const extra of ["Carcass 0598", "Carcass 0599"]) this.labelById.set(id(`GS1 LOT ${extra}`), extra);
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

  /** Sends a transaction and reports it to the ledger feed. */
  async send(step, fn, detail, txPromise) {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const block = await this.provider.getBlock(receipt.blockNumber);
    const entry = {
      step,
      fn,
      detail,
      actor: this.actorByAddress.get(receipt.from.toLowerCase()) ?? "",
      gasUsed: Number(receipt.gasUsed),
      timestamp: block.timestamp,
      hash: receipt.hash,
    };
    this.entries.push(entry);
    await this.emit("onTx", entry);
    await yieldToUi();
    return receipt;
  }

  // ------------------------------------------------------------------ step 1: set-up

  async setup() {
    this.at("2026-10-01T08:00:00Z");
    const admin = this.signers.admin;
    const art = ARTIFACTS.PorkTraceability;
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, admin);
    const contract = await factory.deploy(admin.address);
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    const code = await this.provider.getCode(await contract.getAddress());
    this.c = contract;
    this.deployments.push({ name: "PorkTraceability", gasUsed: Number(receipt.gasUsed), runtimeBytes: (code.length - 2) / 2 });
    await this.emit("onTx", {
      step: "deploy",
      fn: "deploy PorkTraceability",
      detail: `${((code.length - 2) / 2).toLocaleString("en-US")} bytes of runtime code; default temperature limits set`,
      actor: "admin",
      gasUsed: Number(receipt.gasUsed),
      timestamp: this.latest(),
    });
    this.roles = {};
    for (const r of ["SLAUGHTERHOUSE", "VETERINARIAN", "CUTTING_PLANT", "PROCESSOR", "CARRIER", "RETAILER", "AUTHORITY", "SENSOR"]) {
      this.roles[r] = await this.c[`${r}_ROLE`]();
    }
    for (const a of ACTORS.filter((x) => x.roles)) {
      await this.send("setup", "registerOrganisation", `${a.label} · ${a.approvalNo} · GR · ${a.roles.join(", ")}`,
        this.as("admin").registerOrganisation(this.signers[a.key].address, a.approvalNo, cc("GR"), a.roles.map((r) => this.roles[r])));
    }
    for (const a of ACTORS.filter((x) => x.device)) {
      await this.send("setup", "registerDevice", `${a.label} → ${ACTOR_LABELS[a.device.org]} · ${a.device.location}`,
        this.as("admin").registerDevice(this.signers[a.key].address, this.signers[a.device.org].address, id(a.device.location)));
    }
    await this.send("setup", "setCookingMinimum", "Minimum cooking core temperature 75.0 °C",
      this.as("authority").setCookingMinimum(750));
    this.state.step = 1;
  }

  // ------------------------------------------------------------------ step 2: slaughter and inspection

  async slaughter() {
    this.at("2026-10-05T08:30:00Z");
    const carcasses = [
      ["C1", 91_400, "06:10"], ["C2", 89_800, "06:14"], ["C3", 92_600, "06:19"], ["C4", 90_200, "06:23"], ["C5", 88_900, "06:28"],
    ];
    for (const [k, grams, time] of carcasses) {
      await this.send("slaughter", "createCarcassBatch", `${BATCHES[k]} · born GR, reared GR · ${(grams / 1000).toFixed(1)} kg · slaughtered ${time}`,
        this.as("slaughterhouse").createCarcassBatch(B[k], cc("GR"), cc("GR"), grams, ts(`2026-10-05T${time}:00Z`), doc(`movement document ${k}`)));
    }
    this.at("2026-10-05T11:00:00Z");
    for (const [k] of carcasses) {
      const trichinellaNegative = k !== "C5";
      await this.send("slaughter", "recordInspection",
        `${BATCHES[k]} · ante- and post-mortem passed · Trichinella ${trichinellaNegative ? "negative" : "POSITIVE → rejected"}`,
        this.as("veterinarian").recordInspection(B[k], true, trichinellaNegative, doc(`inspection report ${k}`)));
    }
    this.at("2026-10-05T23:00:00Z");
    await this.send("slaughter", "reportTemperature", "Chiller 1 · 4 carcasses · min 0.8 · max 5.6 · mean 2.1 °C · 0 min out",
      this.as("chiller").reportTemperature([B.C1, B.C2, B.C3, B.C4], 8, 56, 21, 0, doc("chiller series 5 Oct")));
    this.state.step = 2;
  }

  // ------------------------------------------------------------------ step 3: cutting and processing

  async processing() {
    this.at("2026-10-06T05:00:00Z");
    for (const k of ["C1", "C2", "C3", "C4"]) {
      await this.send("processing", "ship", `${BATCHES[k]} → cutting plant`,
        this.as("slaughterhouse").ship(B[k], this.signers.cuttingPlant.address, this.signers.carrier.address, doc(`delivery note ${k}`)));
    }
    await this.send("processing", "reportTemperature", "Reefer 07 · 4 carcasses in transit · max 3.4 °C",
      this.as("truck").reportTemperature([B.C1, B.C2, B.C3, B.C4], 12, 34, 22, 0, doc("reefer series 6 Oct a")));
    this.at("2026-10-06T07:30:00Z");
    for (const [k, grams] of [["C1", 91_400], ["C2", 89_800], ["C3", 92_600], ["C4", 90_200]]) {
      await this.send("processing", "receiveBatch", `${BATCHES[k]} accepted · ${(grams / 1000).toFixed(1)} kg at 3.1 °C`,
        this.as("cuttingPlant").receiveBatch(B[k], grams, 31, true));
    }
    this.at("2026-10-06T09:00:00Z");
    const useByCuts = ts("2026-10-12T00:00:00Z");
    await this.send("processing", "transform", "Carcasses 0501 + 0502 (181.2 kg) → Shoulder A 64.0 kg, Neck A 30.0 kg",
      this.as("cuttingPlant").transform([B.C1, B.C2], [91_400, 89_800], [B.SHOULDER_A, B.NECK_A], [64_000, 30_000], P.PRIMAL_CUT, [0, 0], S.CHILLED, useByCuts, doc("cutting record A")));
    await this.send("processing", "transform", "Carcasses 0503 + 0504 (182.8 kg) → Shoulder B 58.0 kg, Leg B 72.0 kg",
      this.as("cuttingPlant").transform([B.C3, B.C4], [92_600, 90_200], [B.SHOULDER_B, B.LEG_B], [58_000, 72_000], P.PRIMAL_CUT, [0, 0], S.CHILLED, useByCuts, doc("cutting record B")));
    this.at("2026-10-06T13:00:00Z");
    for (const k of ["SHOULDER_A", "NECK_A", "SHOULDER_B"]) {
      await this.send("processing", "ship", `${BATCHES[k]} → meat processor`,
        this.as("cuttingPlant").ship(B[k], this.signers.processor.address, this.signers.carrier.address, doc(`delivery note ${k}`)));
    }
    await this.send("processing", "reportTemperature", "Reefer 07 · 3 cut batches in transit · max 3.0 °C",
      this.as("truck").reportTemperature([B.SHOULDER_A, B.NECK_A, B.SHOULDER_B], 10, 30, 19, 0, doc("reefer series 6 Oct b")));
    this.at("2026-10-06T14:30:00Z");
    for (const [k, grams] of [["SHOULDER_A", 64_000], ["NECK_A", 30_000], ["SHOULDER_B", 58_000]]) {
      await this.send("processing", "receiveBatch", `${BATCHES[k]} accepted · ${(grams / 1000).toFixed(1)} kg at 2.8 °C`,
        this.as("processor").receiveBatch(B[k], grams, 28, true));
    }
    this.at("2026-10-07T07:00:00Z");
    const useByProducts = ts("2026-10-11T23:00:00Z");
    await this.send("processing", "transform", "Shoulder A + Neck A (94.0 kg) → two gyros cones of 40.0 kg",
      this.as("processor").transform([B.SHOULDER_A, B.NECK_A], [64_000, 30_000], [B.CONE_A1, B.CONE_A2], [40_000, 40_000], P.GYROS_CONE, [1, 1], S.CHILLED, useByProducts, doc("product specification gyros")));
    await this.send("processing", "transform", "Shoulder B, 50.0 of 58.0 kg → two skewer batches of 20.0 kg, 250 skewers each",
      this.as("processor").transform([B.SHOULDER_B], [50_000], [B.SKEWERS_B1, B.SKEWERS_B2], [20_000, 20_000], P.SKEWER, [250, 250], S.CHILLED, useByProducts, doc("product specification skewers")));
    this.state.step = 3;
  }

  // ------------------------------------------------------------------ step 4: delivery and service

  async service() {
    this.at("2026-10-08T05:00:00Z");
    for (const k of ["CONE_A1", "SKEWERS_B1"]) {
      await this.send("service", "ship", `${BATCHES[k]} → souvlaki restaurant`,
        this.as("processor").ship(B[k], this.signers.restaurant.address, this.signers.carrier.address, doc(`delivery note ${k}`)));
    }
    await this.send("service", "reportTemperature", "Reefer 07 · cone and skewers in transit · max 3.2 °C",
      this.as("truck").reportTemperature([B.CONE_A1, B.SKEWERS_B1], 14, 32, 23, 0, doc("reefer series 8 Oct")));
    this.at("2026-10-08T06:10:00Z");
    await this.send("service", "receiveBatch", "Gyros cone A1 accepted · 40.0 kg at 2.9 °C",
      this.as("restaurant").receiveBatch(B.CONE_A1, 40_000, 29, true));
    await this.send("service", "receiveBatch", "Skewers B1 accepted · 20.0 kg at 3.1 °C",
      this.as("restaurant").receiveBatch(B.SKEWERS_B1, 20_000, 31, true));
    this.at("2026-10-09T06:00:00Z");
    await this.send("service", "reportTemperature", "Fridge 1 · overnight · min 1.6 · max 3.7 · mean 2.5 °C",
      this.as("fridge").reportTemperature([B.CONE_A1, B.SKEWERS_B1], 16, 37, 25, 0, doc("fridge series 8–9 Oct")));
    this.at("2026-10-09T11:00:00Z");
    const useByLot = ts("2026-10-09T23:59:00Z");
    await this.send("service", "transform", "Lunch lot · 15.0 kg of Gyros cone A1 → 100 portions",
      this.as("restaurant").transform([B.CONE_A1], [15_000], [B.LOT_LUNCH], [15_000], P.SERVING_LOT, [100], S.CHILLED, useByLot, doc("HACCP lunch")));
    await this.send("service", "recordCooking", "Lunch lot · core temperature 78.5 °C",
      this.as("restaurant").recordCooking(B.LOT_LUNCH, 785, doc("cooking log lunch")));
    this.at("2026-10-09T15:00:00Z");
    await this.send("service", "transform", "Dinner lot · 12.0 kg of Skewers B1 → 150 portions",
      this.as("restaurant").transform([B.SKEWERS_B1], [12_000], [B.LOT_DINNER], [12_000], P.SERVING_LOT, [150], S.CHILLED, useByLot, doc("HACCP dinner")));
    await this.send("service", "recordCooking", "Dinner lot · core temperature 81.0 °C",
      this.as("restaurant").recordCooking(B.LOT_DINNER, 810, doc("cooking log dinner")));
    this.at("2026-10-09T19:30:00Z");
    await this.send("service", "recordSales", "Lunch lot · 92 portions sold (POS aggregate)",
      this.as("restaurant").recordSales(B.LOT_LUNCH, 92));
    await this.send("service", "recordSales", "Dinner lot · 140 portions sold (POS aggregate)",
      this.as("restaurant").recordSales(B.LOT_DINNER, 140));
    this.state.step = 4;
    await this.emit("onLots");
  }

  // ------------------------------------------------------------------ step 5: recall

  async recall() {
    this.at("2026-10-09T20:30:00Z");
    await this.send("recall", "issueRecall", "Carcass 0502 · reason code 2 (residue finding in the official sample)",
      this.as("authority").issueRecall(B.C2, 2, doc("recall notice 0502")));
    const affected = [];
    for (const [k, v] of Object.entries(B)) if (await this.c.isRecalled(v)) affected.push(BATCHES[k]);
    await this.emit("onTx", {
      step: "recall",
      fn: "isRecalled",
      note: true,
      detail: `Read-only walk of the ancestry, no transaction: ${affected.join(", ")}`,
      actor: "",
      timestamp: this.latest(),
    });
    this.state.step = 5;
    await this.emit("onLots");
  }

  // ------------------------------------------------------------------ read model for the verification page

  async lotView(lotId) {
    const c = this.c;
    let lot;
    try {
      lot = await c.getBatch(lotId);
    } catch (_) {
      return null;
    }
    const prov = [...(await c.getProvenance(lotId))];
    const ancestors = [];
    for (const a of prov) ancestors.push({ id: a, label: this.labelById.get(a) ?? a.slice(0, 10), b: await c.getBatch(a) });
    const carcasses = ancestors.filter((x) => Number(x.b.productType) === P.CARCASS);
    const slaughterhouses = new Set();
    let inspected = 0;
    for (const x of carcasses) {
      const org = await c.getOrganisation(x.b.creator);
      slaughterhouses.add(org.approvalNo);
      const ins = await c.getInspection(x.id);
      if (ins.passed && ins.trichinellaNegative) inspected += 1;
    }
    const recalledAt = [];
    for (const x of [{ id: lotId, label: this.labelById.get(lotId), b: lot }, ...ancestors]) {
      if (x.b.recalled) {
        const r = await c.getRecall(x.id);
        recalledAt.push({ label: x.label, at: Number(r.issuedAt), reason: Number(r.reasonCode) });
      }
    }
    const cooking = await c.getCooking(lotId);
    const o = lot.origin;
    return {
      status: STATUS[Number(await c.effectiveStatus(lotId))],
      origin: [country(o.countryOfBirth), country(o.countryOfRearing), country(o.countryOfSlaughter)],
      slaughterhouses: [...slaughterhouses],
      slaughterTime: Number(lot.slaughterTime),
      createdAt: Number(lot.createdAt),
      daysSinceSlaughter: Math.floor((Number(lot.createdAt) - Number(lot.slaughterTime)) / DAY),
      carcasses: carcasses.length,
      inspected,
      coldChainOk: !(await c.hasBreachInAncestry(lotId)),
      cooking: cooking.recorded ? { temp: Number(cooking.coreTemp) / 10, ok: cooking.meetsMinimum } : null,
      portions: Number(lot.units),
      sold: Number(await c.portionsSold(lotId)),
      recalled: recalledAt,
      chain: ancestors.map((x) => `${x.label} (${PRODUCT[Number(x.b.productType)]})`),
    };
  }

  totals() {
    const gas = this.entries.reduce((s, e) => s + e.gasUsed, 0);
    return { transactions: this.entries.length, gasUsed: gas, deploymentGas: this.deployments.reduce((s, d) => s + d.gasUsed, 0) };
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

  /** Runs `fn` on a snapshot of the chain and rolls the chain back afterwards. */
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
    const quiet = (signer, call) => call(this.c.connect(this.signers[signer]));
    return [
      {
        key: "uninspected",
        tag: "Veterinary inspection",
        title: "Ship a carcass before inspection",
        story: "The slaughterhouse registers a new carcass and ships it to the cutting plant before the official veterinarian has examined it.",
        expect: "InvalidStatus",
        needs: 1,
        run: () => this.sandbox(async () => {
          const x = id("GS1 LOT Carcass 0599");
          await quiet("slaughterhouse", (c) => c.createCarcassBatch(x, cc("GR"), cc("GR"), 90_000, this.latest() - 600, doc("x")));
          return this.attempt(() => quiet("slaughterhouse", (c) => c.ship.staticCall(x, this.signers.cuttingPlant.address, this.signers.carrier.address, doc("x"))));
        }),
      },
      {
        key: "selfInspection",
        tag: "Veterinary inspection",
        title: "Certify your own carcass",
        story: "The slaughterhouse is also granted the veterinarian role and tries to release a carcass it created itself.",
        expect: "SelfInspectionNotAllowed",
        needs: 1,
        run: () => this.sandbox(async () => {
          await quiet("admin", (c) => c.grantRole(this.roles.VETERINARIAN, this.signers.slaughterhouse.address));
          const x = id("GS1 LOT Carcass 0598");
          await quiet("slaughterhouse", (c) => c.createCarcassBatch(x, cc("GR"), cc("GR"), 90_000, this.latest() - 600, doc("x")));
          return this.attempt(() => quiet("slaughterhouse", (c) => c.recordInspection.staticCall(x, true, true, doc("x"))));
        }),
      },
      {
        key: "outsider",
        tag: "Access control",
        title: "Register a carcass without a role",
        story: "An account that the consortium never registered tries to add a carcass of Greek origin to the ledger.",
        expect: "AccessControlUnauthorizedAccount",
        needs: 1,
        run: () => this.sandbox(() =>
          this.attempt(() => quiet("outsider", (c) => c.createCarcassBatch.staticCall(id("GS1 LOT fake"), cc("GR"), cc("GR"), 90_000, this.latest() - 600, doc("x"))))),
      },
      {
        key: "mass",
        tag: "Mass balance",
        title: "Make more meat than you received",
        story: "The processor turns the last 8.0 kg of Shoulder B into skewers declared as 9.5 kg of meat.",
        expect: "MassBalanceViolated",
        needs: 3,
        run: () => this.sandbox(() =>
          this.attempt(() => quiet("processor", (c) => c.transform.staticCall([B.SHOULDER_B], [8_000], [id("GS1 LOT Skewers B3")], [9_500], P.SKEWER, [120], S.CHILLED, ts("2026-10-11T23:00:00Z"), doc("x"))))),
      },
      {
        key: "transition",
        tag: "Roles",
        title: "Skip the processor",
        story: "The cutting plant tries to turn its Leg B cuts straight into a serving lot, a step that only a restaurant may take.",
        expect: "TransitionNotAllowed",
        needs: 3,
        run: () => this.sandbox(() =>
          this.attempt(() => quiet("cuttingPlant", (c) => c.transform.staticCall([B.LEG_B], [1_000], [id("GS1 LOT bogus lot")], [1_000], P.SERVING_LOT, [6], S.CHILLED, ts("2026-10-11T23:00:00Z"), doc("x"))))),
      },
      {
        key: "warm",
        tag: "Cold chain",
        title: "Accept a warm delivery",
        story: "Skewers B2 arrive at the restaurant at 7.5 °C, above the 4 °C limit for meat preparations, and the staff try to accept them anyway.",
        expect: "ReceiptTemperatureAboveLimit",
        needs: 3,
        run: () => this.sandbox(async () => {
          await quiet("processor", (c) => c.ship(B.SKEWERS_B2, this.signers.restaurant.address, this.signers.carrier.address, doc("x")));
          return this.attempt(() => quiet("restaurant", (c) => c.receiveBatch.staticCall(B.SKEWERS_B2, 20_000, 75, true)));
        }),
      },
      {
        key: "breach",
        tag: "Cold chain",
        title: "Use a batch after a breach in transit",
        story: "The reefer gateway reports 9.0 °C while Skewers B2 are on the road. The restaurant receives them at 3.5 °C and tries to cook them.",
        expect: "InvalidStatus",
        needs: 3,
        run: () => this.sandbox(async () => {
          await quiet("processor", (c) => c.ship(B.SKEWERS_B2, this.signers.restaurant.address, this.signers.carrier.address, doc("x")));
          await quiet("truck", (c) => c.reportTemperature([B.SKEWERS_B2], 30, 90, 62, 45, doc("x")));
          await quiet("restaurant", (c) => c.receiveBatch(B.SKEWERS_B2, 20_000, 35, true));
          const res = await this.attempt(() => quiet("restaurant", (c) => c.transform.staticCall([B.SKEWERS_B2], [5_000], [id("GS1 LOT extra")], [5_000], P.SERVING_LOT, [60], S.CHILLED, ts("2026-10-11T23:00:00Z"), doc("x"))));
          return { ...res, note: "Quarantined automatically by the vehicle gateway's report" };
        }),
      },
      {
        key: "oversell",
        tag: "Mass balance",
        title: "Sell more portions than produced",
        story: "The dinner lot produced 150 portions and 140 are already sold. The POS reports 11 more.",
        expect: "PortionsExceeded",
        needs: 4,
        run: () => this.sandbox(() => this.attempt(() => quiet("restaurant", (c) => c.recordSales.staticCall(B.LOT_DINNER, 11)))),
      },
      {
        key: "expired",
        tag: "Use-by date",
        title: "Ship skewers after their use-by date",
        story: "On 13 October, after the use-by date of 11 October, the processor tries to ship Skewers B2 to the restaurant.",
        expect: "BatchExpired",
        needs: 3,
        run: () => this.sandbox(async () => {
          this.chain.increaseTo(Math.max(ts("2026-10-13T08:00:00Z"), this.latest() + 1));
          return this.attempt(() => quiet("processor", (c) => c.ship.staticCall(B.SKEWERS_B2, this.signers.restaurant.address, this.signers.carrier.address, doc("x"))));
        }),
      },
      {
        key: "recalled",
        tag: "Recall",
        title: "Keep selling a recalled lot",
        story: "After the recall of Carcass 0502, the POS reports one more portion from the lunch lot, which was made from it two steps further down.",
        expect: "BatchIsRecalled",
        needs: 5,
        run: () => this.sandbox(() => this.attempt(() => quiet("restaurant", (c) => c.recordSales.staticCall(B.LOT_LUNCH, 1)))),
      },
    ];
  }

  /** Decodes error arguments for display. */
  describeArgs(name, args) {
    const label = (h) => this.labelById.get(h) ?? (typeof h === "string" && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : String(h));
    const who = (a) => ACTOR_LABELS[this.actorByAddress.get(String(a).toLowerCase())] ?? `${String(a).slice(0, 8)}…`;
    const kg = (g) => `${(Number(g) / 1000).toFixed(1)} kg`;
    switch (name) {
      case "InvalidStatus":
        return [`batch: ${label(args[0])}`, `status: ${STATUS[Number(args[1])]}`];
      case "SelfInspectionNotAllowed":
      case "BatchIsRecalled":
      case "BatchExpired":
        return [`batch: ${label(args[0])}`];
      case "AccessControlUnauthorizedAccount":
        return [`account: ${who(args[0])}`, "required role: SLAUGHTERHOUSE"];
      case "MassBalanceViolated":
        return [`meat in: ${kg(args[0])}`, `meat out: ${kg(args[1])}`];
      case "TransitionNotAllowed":
        return [`from: ${PRODUCT[Number(args[0])]}`, `to: ${PRODUCT[Number(args[1])]}`];
      case "ReceiptTemperatureAboveLimit":
        return [`measured: ${(Number(args[0]) / 10).toFixed(1)} °C`, `limit: ${(Number(args[1]) / 10).toFixed(1)} °C`];
      case "PortionsExceeded":
        return [`produced: ${args[0]}`, `sold after this report: ${args[1]}`];
      default:
        return (args ?? []).map((a) => String(a));
    }
  }
}

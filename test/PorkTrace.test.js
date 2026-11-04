const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const P = { GYROS_CONE: 0, SKEWER: 1 };
const S = { CHILLED: 0, FROZEN: 1 };
const B = { IN_STOCK: 0, DEPLETED: 1, WITHDRAWN: 2 };
const RC = { SUPPLIER_RECALL: 0, TEMPERATURE: 1, QUALITY: 2, OTHER: 3 };
const id = (s) => ethers.id(s);
const cc = (s) => ethers.hexlify(ethers.toUtf8Bytes(s));
const doc = (s) => ethers.sha256(ethers.toUtf8Bytes(s));
const DAY = 24 * 3600;
const FRIDGE = 1, FREEZER = 2;

describe("PorkTrace (simplified model)", function () {
  async function deployFixture() {
    const [owner, staff, fridgeSensor, freezerSensor, customer] = await ethers.getSigners();
    // 4 °C chilled, −18 °C frozen, 75 °C cooking, 15 minutes tolerance
    const c = await (await ethers.getContractFactory("PorkTrace")).deploy(owner.address, 40, -180, 750, 15);
    await c.addStaff(staff.address);
    await c.addSensor(fridgeSensor.address, FRIDGE);
    await c.addSensor(freezerSensor.address, FREEZER);
    return { c, owner, staff, fridgeSensor, freezerSensor, customer };
  }

  async function batchInput(name, o = {}) {
    const now = await time.latest();
    return {
      batchId: id(name),
      productType: P.GYROS_CONE,
      storageType: S.CHILLED,
      supplierName: "Meat Processor S.A.",
      supplierBatchCode: name,
      origin: { countryOfBirth: cc("GR"), countryOfRearing: cc("GR"), countryOfSlaughter: cc("GR") },
      slaughterhouseApproval: "EL 10 SH-01",
      slaughterDate: now - 3 * DAY,
      useByDate: now + 4 * DAY,
      grams: 10_000,
      receiptTemp: 30,
      storageUnit: FRIDGE,
      docHash: doc(name),
      ...o,
    };
  }

  async function stockedFixture() {
    const f = await loadFixture(deployFixture);
    await f.c.connect(f.staff).registerBatch(await batchInput("CONE-GR-1"));
    await f.c.connect(f.staff).registerBatch(await batchInput("CONE-GR-2", { slaughterDate: (await time.latest()) - 5 * DAY }));
    await f.c.connect(f.staff).registerBatch(await batchInput("CONE-DK", {
      origin: { countryOfBirth: cc("DK"), countryOfRearing: cc("DK"), countryOfSlaughter: cc("GR") },
    }));
    return f;
  }

  describe("Roles", function () {
    it("only OWNER, STAFF and SENSOR accounts can write", async function () {
      const f = await loadFixture(deployFixture);
      await expect(f.c.connect(f.customer).registerBatch(await batchInput("X")))
        .to.be.revertedWithCustomError(f.c, "AccessControlUnauthorizedAccount");
      await expect(f.c.connect(f.staff).addStaff(f.customer.address))
        .to.be.revertedWithCustomError(f.c, "AccessControlUnauthorizedAccount");
      await expect(f.c.connect(f.staff).withdrawBatch(id("X"), RC.OTHER, doc("x")))
        .to.be.revertedWithCustomError(f.c, "AccessControlUnauthorizedAccount");
    });

    it("exposes the deployment parameters", async function () {
      const { c } = await loadFixture(deployFixture);
      expect(await c.chilledLimit()).to.equal(40);
      expect(await c.frozenLimit()).to.equal(-180);
      expect(await c.minCookingTemp()).to.equal(750);
      expect(await c.toleranceMinutes()).to.equal(15);
    });
  });

  describe("Delivery batches", function () {
    it("registers a batch and keeps it immutable", async function () {
      const f = await loadFixture(stockedFixture);
      const b = await f.c.getBatch(id("CONE-GR-1"));
      expect(b.supplierName).to.equal("Meat Processor S.A.");
      expect(b.status).to.equal(B.IN_STOCK);
      expect(b.gramsRemaining).to.equal(10_000);
      await expect(f.c.connect(f.staff).registerBatch(await batchInput("CONE-GR-1")))
        .to.be.revertedWithCustomError(f.c, "AlreadyExists");
      expect(await f.c.stockOf(FRIDGE)).to.have.length(3);
    });

    it("rejects an expired batch, a future slaughter date or a receipt temperature above the limit", async function () {
      const f = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(f.c.connect(f.staff).registerBatch(await batchInput("A", { useByDate: now })))
        .to.be.revertedWithCustomError(f.c, "UseByPassed");
      await expect(f.c.connect(f.staff).registerBatch(await batchInput("B", { slaughterDate: now + DAY })))
        .to.be.revertedWithCustomError(f.c, "SlaughterDateInFuture");
      await expect(f.c.connect(f.staff).registerBatch(await batchInput("C", { receiptTemp: 41 })))
        .to.be.revertedWithCustomError(f.c, "ReceiptTemperatureAboveLimit").withArgs(41, 40);
      await expect(f.c.connect(f.staff).registerBatch(await batchInput("D", { storageType: S.FROZEN, receiptTemp: -150, storageUnit: FREEZER })))
        .to.be.revertedWithCustomError(f.c, "ReceiptTemperatureAboveLimit").withArgs(-150, -180);
    });
  });

  describe("Serving lots", function () {
    it("computes portions and derives a single-country origin", async function () {
      const f = await loadFixture(stockedFixture);
      await expect(f.c.connect(f.staff).openLot(id("LOT-1"), [id("CONE-GR-1"), id("CONE-GR-2")], [6_000, 4_000], 150))
        .to.emit(f.c, "LotOpened");
      const lot = await f.c.getLot(id("LOT-1"));
      expect(lot.portionsProduced).to.equal(66); // 10 000 g / 150 g
      const s = await f.c.getLotSummary(id("LOT-1"));
      expect(s.singleCountry).to.equal(cc("GR"));
      expect(s.daysSinceSlaughter).to.equal(5);
      expect(s.storageWithinLimit).to.be.true;
      expect(s.anyWithdrawn).to.be.false;
      expect((await f.c.getBatch(id("CONE-GR-1"))).gramsRemaining).to.equal(4_000);
    });

    it("mixed batches give XX and no single-country claim", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.connect(f.staff).openLot(id("LOT-1"), [id("CONE-GR-1"), id("CONE-DK")], [5_000, 5_000], 150);
      const s = await f.c.getLotSummary(id("LOT-1"));
      expect(s.origin.countryOfBirth).to.equal(cc("XX"));
      expect(s.origin.countryOfSlaughter).to.equal(cc("GR"));
      expect(s.singleCountry).to.equal("0x0000");
    });

    it("grams taken never exceed grams received; depleted batches leave stock", async function () {
      const f = await loadFixture(stockedFixture);
      await expect(f.c.connect(f.staff).openLot(id("L"), [id("CONE-GR-1")], [10_001], 150))
        .to.be.revertedWithCustomError(f.c, "InsufficientGrams");
      await expect(f.c.connect(f.staff).openLot(id("L"), [id("CONE-GR-1")], [10_000], 150))
        .to.emit(f.c, "BatchDepleted").withArgs(id("CONE-GR-1"));
      expect((await f.c.getBatch(id("CONE-GR-1"))).status).to.equal(B.DEPLETED);
      expect(await f.c.stockOf(FRIDGE)).to.not.include(id("CONE-GR-1"));
      await expect(f.c.connect(f.staff).openLot(id("L2"), [id("CONE-GR-1")], [1], 150))
        .to.be.revertedWithCustomError(f.c, "BatchNotInStock");
    });

    it("a withdrawn or expired batch cannot be used", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.withdrawBatch(id("CONE-DK"), RC.QUALITY, doc("q"));
      await expect(f.c.connect(f.staff).openLot(id("L"), [id("CONE-DK")], [1_000], 150))
        .to.be.revertedWithCustomError(f.c, "BatchNotInStock");
      await time.increase(5 * DAY);
      await expect(f.c.connect(f.staff).openLot(id("L"), [id("CONE-GR-1")], [1_000], 150))
        .to.be.revertedWithCustomError(f.c, "UseByPassed");
    });

    it("rejects duplicate batches and lots with no portions", async function () {
      const f = await loadFixture(stockedFixture);
      await expect(f.c.connect(f.staff).openLot(id("L"), [id("CONE-GR-1"), id("CONE-GR-1")], [1, 1], 150))
        .to.be.revertedWithCustomError(f.c, "DuplicateBatch");
      await expect(f.c.connect(f.staff).openLot(id("L"), [id("CONE-GR-1")], [100], 150))
        .to.be.revertedWithCustomError(f.c, "NoPortions");
    });
  });

  describe("Cooking, sales and closing", function () {
    it("portions sold never exceed portions produced", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.connect(f.staff).openLot(id("LOT"), [id("CONE-GR-1")], [3_000], 150); // 20 portions
      await f.c.connect(f.staff).recordSales(id("LOT"), 15);
      await expect(f.c.connect(f.staff).recordSales(id("LOT"), 6))
        .to.be.revertedWithCustomError(f.c, "PortionsExceeded").withArgs(20, 21);
      await f.c.connect(f.staff).recordSales(id("LOT"), 5);
      await expect(f.c.connect(f.staff).closeLot(id("LOT"))).to.emit(f.c, "LotClosed").withArgs(id("LOT"), 20);
      await expect(f.c.connect(f.staff).recordSales(id("LOT"), 1)).to.be.revertedWithCustomError(f.c, "LotNotOpen");
    });

    it("records cooking once and checks it against the minimum", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.connect(f.staff).openLot(id("LOT"), [id("CONE-GR-1")], [3_000], 150);
      await expect(f.c.connect(f.staff).recordCooking(id("LOT"), 780, doc("haccp")))
        .to.emit(f.c, "CookingRecorded").withArgs(id("LOT"), 780, true, doc("haccp"));
      await expect(f.c.connect(f.staff).recordCooking(id("LOT"), 800, doc("haccp")))
        .to.be.revertedWithCustomError(f.c, "CookingAlreadyRecorded");
      let s = await f.c.getLotSummary(id("LOT"));
      expect(s.cookingMeetsMinimum).to.be.true;

      await f.c.connect(f.staff).openLot(id("LOT2"), [id("CONE-GR-2")], [3_000], 150);
      await f.c.connect(f.staff).recordCooking(id("LOT2"), 700, doc("haccp"));
      s = await f.c.getLotSummary(id("LOT2"));
      expect(s.cookingMeetsMinimum).to.be.false;
    });
  });

  describe("Storage reports", function () {
    it("only the sensor of a unit reports on it, with consecutive windows", async function () {
      const f = await loadFixture(stockedFixture);
      const now = await time.latest();
      await expect(f.c.connect(f.freezerSensor).reportStorage(FRIDGE, now - 3600, now, 20, 30, 25, 0, doc("s")))
        .to.be.revertedWithCustomError(f.c, "WrongStorageUnit");
      await f.c.connect(f.fridgeSensor).reportStorage(FRIDGE, now - 3600, now, 20, 30, 25, 0, doc("s"));
      await expect(f.c.connect(f.fridgeSensor).reportStorage(FRIDGE, now - 1800, now, 20, 30, 25, 0, doc("s")))
        .to.be.revertedWithCustomError(f.c, "InvalidWindow");
      expect(await f.c.getStorageReports(FRIDGE)).to.have.length(1);
    });

    it("a short excursion within tolerance raises maxStorageTemp but withdraws nothing", async function () {
      const f = await loadFixture(stockedFixture);
      const now = await time.latest();
      await f.c.connect(f.fridgeSensor).reportStorage(FRIDGE, now - 3600, now, 20, 45, 30, 10, doc("s"));
      const b = await f.c.getBatch(id("CONE-GR-1"));
      expect(b.maxStorageTemp).to.equal(45);
      expect(b.status).to.equal(B.IN_STOCK);
      await f.c.connect(f.staff).openLot(id("LOT"), [id("CONE-GR-1")], [3_000], 150);
      expect((await f.c.getLotSummary(id("LOT"))).storageWithinLimit).to.be.false;
    });

    it("a breach beyond tolerance withdraws every batch in stock in that unit", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.connect(f.staff).registerBatch(await batchInput("FROZEN-SKEWERS", {
        productType: P.SKEWER, storageType: S.FROZEN, receiptTemp: -200, storageUnit: FREEZER,
      }));
      const now = await time.latest();
      const tx = f.c.connect(f.fridgeSensor).reportStorage(FRIDGE, now - 3600, now, 30, 70, 55, 40, doc("series"));
      await expect(tx).to.emit(f.c, "BatchWithdrawn").withArgs(id("CONE-GR-1"), RC.TEMPERATURE, doc("series"), f.fridgeSensor.address);
      for (const n of ["CONE-GR-1", "CONE-GR-2", "CONE-DK"]) {
        expect((await f.c.getBatch(id(n))).status).to.equal(B.WITHDRAWN);
      }
      expect(await f.c.stockOf(FRIDGE)).to.have.length(0);
      expect((await f.c.getBatch(id("FROZEN-SKEWERS"))).status).to.equal(B.IN_STOCK);
    });
  });

  describe("Withdrawal", function () {
    it("a lot shows a warning as soon as any of its batches is withdrawn", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.connect(f.staff).openLot(id("LOT"), [id("CONE-GR-1"), id("CONE-GR-2")], [10_000, 2_000], 150);
      expect((await f.c.getLotSummary(id("LOT"))).anyWithdrawn).to.be.false;
      // CONE-GR-1 is already depleted; a supplier recall still reaches the lot
      await f.c.withdrawBatch(id("CONE-GR-1"), RC.SUPPLIER_RECALL, doc("recall-notice"));
      expect((await f.c.getLotSummary(id("LOT"))).anyWithdrawn).to.be.true;
      const w = await f.c.getWithdrawal(id("CONE-GR-1"));
      expect(w.reasonCode).to.equal(RC.SUPPLIER_RECALL);
      await expect(f.c.withdrawBatch(id("CONE-GR-1"), RC.OTHER, doc("x")))
        .to.be.revertedWithCustomError(f.c, "AlreadyWithdrawn");
    });

    it("the customer reads the summary without an account", async function () {
      const f = await loadFixture(stockedFixture);
      await f.c.connect(f.staff).openLot(id("LOT"), [id("CONE-GR-1")], [3_000], 150);
      const s = await f.c.connect(f.customer).getLotSummary(id("LOT"));
      expect(s.portionsProduced).to.equal(20);
      await expect(f.c.getLotSummary(id("NOPE"))).to.be.revertedWithCustomError(f.c, "LotNotFound");
    });
  });
});

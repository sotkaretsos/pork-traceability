const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Enum values as in PorkTypes.sol
const P = { CARCASS: 0, PRIMAL_CUT: 1, GYROS_CONE: 2, SKEWER: 3, SERVING_LOT: 4 };
const S = { CHILLED: 0, FROZEN: 1 };
const ST = { PENDING_INSPECTION: 0, ACTIVE: 1, IN_TRANSIT: 2, QUARANTINED: 3, REJECTED: 4, CONSUMED: 5, RECALLED: 6 };

const id = (s) => ethers.id(s); // bytes32 batch id = hash of the GS1 lot identifier
const cc = (s) => ethers.hexlify(ethers.toUtf8Bytes(s)); // ISO 3166-1 alpha-2 → bytes2
const doc = (s) => ethers.sha256(ethers.toUtf8Bytes(s));
const DAY = 24 * 3600;

describe("PorkTraceability", function () {
  async function deployFixture() {
    const [admin, slaughterhouse, vet, cutter, processor, carrier, retailer, authority, outsider, slaughterhouse2,
      chillerSensor, truckSensor, fridgeSensor] = await ethers.getSigners();

    const c = await (await ethers.getContractFactory("PorkTraceability")).deploy(admin.address);
    const R = {
      SLAUGHTERHOUSE: await c.SLAUGHTERHOUSE_ROLE(),
      VETERINARIAN: await c.VETERINARIAN_ROLE(),
      CUTTING_PLANT: await c.CUTTING_PLANT_ROLE(),
      PROCESSOR: await c.PROCESSOR_ROLE(),
      CARRIER: await c.CARRIER_ROLE(),
      RETAILER: await c.RETAILER_ROLE(),
      AUTHORITY: await c.AUTHORITY_ROLE(),
      SENSOR: await c.SENSOR_ROLE(),
    };

    await c.registerOrganisation(slaughterhouse.address, "EL 10 SH-01", cc("GR"), [R.SLAUGHTERHOUSE]);
    await c.registerOrganisation(slaughterhouse2.address, "NL 220 EG", cc("NL"), [R.SLAUGHTERHOUSE]);
    await c.registerOrganisation(vet.address, "VET-THESS-07", cc("GR"), [R.VETERINARIAN]);
    await c.registerOrganisation(cutter.address, "EL 20 CP-02", cc("GR"), [R.CUTTING_PLANT]);
    await c.registerOrganisation(processor.address, "EL 30 MP-03", cc("GR"), [R.PROCESSOR]);
    await c.registerOrganisation(carrier.address, "LOG-01", cc("GR"), [R.CARRIER]);
    await c.registerOrganisation(retailer.address, "SOUVLAKI-01", cc("GR"), [R.RETAILER]);
    await c.registerOrganisation(authority.address, "EFET", cc("GR"), [R.AUTHORITY]);

    await c.registerDevice(chillerSensor.address, slaughterhouse.address, id("chiller-1"));
    await c.registerDevice(truckSensor.address, carrier.address, id("truck-ABC-1234"));
    await c.registerDevice(fridgeSensor.address, retailer.address, id("fridge-1"));

    return { c, R, admin, slaughterhouse, slaughterhouse2, vet, cutter, processor, carrier, retailer, authority,
      outsider, chillerSensor, truckSensor, fridgeSensor };
  }

  // helpers ---------------------------------------------------------------
  async function carcass(f, name, birth = "GR", rearing = "GR", grams = 90_000, sh = f.slaughterhouse) {
    const t = (await time.latest()) - 3600;
    await f.c.connect(sh).createCarcassBatch(id(name), cc(birth), cc(rearing), grams, t, doc(name + "-movement-doc"));
    return id(name);
  }

  async function deliver(f, batchId, from, to, grams, temp = 30) {
    await f.c.connect(from).ship(batchId, to.address, f.carrier.address, doc("delivery-note"));
    await f.c.connect(to).receiveBatch(batchId, grams, temp, true);
  }

  async function xform(f, signer, inputs, used, outputs, grams, type, units, days = 5, storage = S.CHILLED) {
    const useBy = (await time.latest()) + days * DAY;
    return f.c.connect(signer).transform(inputs, used, outputs, grams, type, units, storage, useBy, doc("record"));
  }

  /// Full chain up to a serving lot of 100 portions held by the restaurant.
  async function chainFixture() {
    const f = await loadFixture(deployFixture);
    const C1 = await carcass(f, "CARCASS-1");
    const C2 = await carcass(f, "CARCASS-2");
    for (const b of [C1, C2]) {
      await f.c.connect(f.vet).recordInspection(b, true, true, doc("inspection"));
      await f.c.connect(f.chillerSensor).reportTemperature([b], 10, 60, 30, 0, doc("series"));
      await deliver(f, b, f.slaughterhouse, f.cutter, 90_000);
    }
    const CUT = id("SHOULDER-1");
    await xform(f, f.cutter, [C1, C2], [90_000, 90_000], [CUT], [120_000], P.PRIMAL_CUT, [0], 7);
    await deliver(f, CUT, f.cutter, f.processor, 120_000);
    const CONE1 = id("CONE-1"), CONE2 = id("CONE-2");
    await xform(f, f.processor, [CUT], [100_000], [CONE1, CONE2], [45_000, 45_000], P.GYROS_CONE, [1, 1], 5);
    await f.c.connect(f.processor).ship(CONE1, f.retailer.address, f.carrier.address, doc("dn"));
    await f.c.connect(f.truckSensor).reportTemperature([CONE1], 10, 35, 20, 0, doc("truck-series"));
    await f.c.connect(f.retailer).receiveBatch(CONE1, 45_000, 30, true);
    const LOT = id("LOT-2026-11-04-EVENING");
    await xform(f, f.retailer, [CONE1], [15_000], [LOT], [15_000], P.SERVING_LOT, [100], 1);
    return { ...f, C1, C2, CUT, CONE1, CONE2, LOT };
  }

  // ----------------------------------------------------------------------
  describe("Onboarding and access control", function () {
    it("registers organisations with approval number, country and roles", async function () {
      const { c, R, slaughterhouse } = await loadFixture(deployFixture);
      const o = await c.getOrganisation(slaughterhouse.address);
      expect(o.approvalNo).to.equal("EL 10 SH-01");
      expect(o.country).to.equal(cc("GR"));
      expect(await c.hasRole(R.SLAUGHTERHOUSE, slaughterhouse.address)).to.be.true;
    });

    it("only ADMIN onboards; SENSOR cannot be given to an organisation; roles need a registered org", async function () {
      const { c, R, outsider, admin } = await loadFixture(deployFixture);
      await expect(c.connect(outsider).registerOrganisation(outsider.address, "X", cc("GR"), []))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
      await expect(c.registerOrganisation(outsider.address, "X", cc("GR"), [R.SENSOR]))
        .to.be.revertedWithCustomError(c, "UnknownRole");
      await expect(c.connect(admin).grantRole(R.RETAILER, outsider.address))
        .to.be.revertedWithCustomError(c, "OrganisationNotRegistered");
    });

    it("binds devices to an organisation and can deactivate them", async function () {
      const { c, R, truckSensor, carrier } = await loadFixture(deployFixture);
      expect((await c.getDevice(truckSensor.address)).org).to.equal(carrier.address);
      await expect(c.deactivateDevice(truckSensor.address)).to.emit(c, "DeviceDeactivated");
      expect(await c.hasRole(R.SENSOR, truckSensor.address)).to.be.false;
    });

    it("sets the default temperature limits of Table 7", async function () {
      const { c } = await loadFixture(deployFixture);
      expect((await c.temperatureLimit(P.CARCASS, S.CHILLED)).maxTemp).to.equal(70);
      expect((await c.temperatureLimit(P.GYROS_CONE, S.CHILLED)).maxTemp).to.equal(40);
      expect((await c.temperatureLimit(P.SKEWER, S.FROZEN)).maxTemp).to.equal(-180);
      expect(await c.minCookingTemp()).to.equal(750);
    });
  });

  describe("Slaughter and inspection", function () {
    it("takes the country of slaughter from the slaughterhouse registration", async function () {
      const f = await loadFixture(deployFixture);
      const b = await carcass(f, "NL-CARCASS", "DE", "NL", 80_000, f.slaughterhouse2);
      const o = await f.c.originOf(b);
      expect([o.countryOfBirth, o.countryOfRearing, o.countryOfSlaughter]).to.deep.equal([cc("DE"), cc("NL"), cc("NL")]);
      expect((await f.c.getBatch(b)).status).to.equal(ST.PENDING_INSPECTION);
    });

    it("INVARIANT: a carcass cannot leave PENDING_INSPECTION without a veterinarian's record", async function () {
      const f = await loadFixture(deployFixture);
      const b = await carcass(f, "C");
      await expect(f.c.connect(f.slaughterhouse).ship(b, f.cutter.address, f.carrier.address, doc("x")))
        .to.be.revertedWithCustomError(f.c, "InvalidStatus");
      await expect(f.c.connect(f.slaughterhouse).recordInspection(b, true, true, doc("x")))
        .to.be.revertedWithCustomError(f.c, "AccessControlUnauthorizedAccount");
      await expect(f.c.connect(f.vet).recordInspection(b, true, true, doc("report")))
        .to.emit(f.c, "BatchStatusChanged").withArgs(b, ST.PENDING_INSPECTION, ST.ACTIVE);
    });

    it("rejects a carcass on a failed inspection or a positive Trichinella test", async function () {
      const f = await loadFixture(deployFixture);
      const b = await carcass(f, "C");
      await f.c.connect(f.vet).recordInspection(b, true, false, doc("report"));
      expect((await f.c.getBatch(b)).status).to.equal(ST.REJECTED);
      await expect(f.c.connect(f.vet).recordInspection(b, true, true, doc("report")))
        .to.be.revertedWithCustomError(f.c, "InvalidStatus");
    });

    it("a slaughterhouse that also holds VETERINARIAN cannot inspect its own carcasses", async function () {
      const f = await loadFixture(deployFixture);
      await f.c.grantRole(f.R.VETERINARIAN, f.slaughterhouse.address);
      const b = await carcass(f, "C");
      await expect(f.c.connect(f.slaughterhouse).recordInspection(b, true, true, doc("x")))
        .to.be.revertedWithCustomError(f.c, "SelfInspectionNotAllowed");
    });

    it("rejects duplicate batch IDs and future slaughter times", async function () {
      const f = await loadFixture(deployFixture);
      await carcass(f, "C");
      await expect(carcass(f, "C")).to.be.revertedWithCustomError(f.c, "BatchAlreadyExists");
      const future = (await time.latest()) + 3600;
      await expect(f.c.connect(f.slaughterhouse).createCarcassBatch(id("D"), cc("GR"), cc("GR"), 1, future, doc("x")))
        .to.be.revertedWithCustomError(f.c, "InvalidTime");
    });
  });

  describe("Full chain: carcass → cut → cone → serving lot", function () {
    it("derives origin and provenance for the serving lot", async function () {
      const f = await loadFixture(chainFixture);
      const o = await f.c.originOf(f.LOT);
      expect([o.countryOfBirth, o.countryOfRearing, o.countryOfSlaughter]).to.deep.equal([cc("GR"), cc("GR"), cc("GR")]);
      const prov = [...(await f.c.getProvenance(f.LOT))];
      expect(prov).to.have.members([f.CONE1, f.CUT, f.C1, f.C2]);
      expect(prov.length).to.equal(4);
      const lot = await f.c.getBatch(f.LOT);
      expect(lot.units).to.equal(100);
      expect(lot.custodian).to.equal(f.retailer.address);
      expect(lot.slaughterTime).to.equal((await f.c.getBatch(f.C1)).slaughterTime);
      expect(await f.c.hasBreachInAncestry(f.LOT)).to.be.false;
    });

    it("marks inputs CONSUMED when fully used and keeps partial remainders", async function () {
      const f = await loadFixture(chainFixture);
      expect((await f.c.getBatch(f.C1)).status).to.equal(ST.CONSUMED);
      const cut = await f.c.getBatch(f.CUT);
      expect(cut.remaining).to.equal(20_000);
      expect(cut.status).to.equal(ST.ACTIVE);
    });

    it("INVARIANT: origin is derived — mixed inputs give XX", async function () {
      const f = await loadFixture(deployFixture);
      const a = await carcass(f, "A", "GR", "GR");
      const b = await carcass(f, "B", "DK", "GR");
      for (const x of [a, b]) {
        await f.c.connect(f.vet).recordInspection(x, true, true, doc("r"));
        await deliver(f, x, f.slaughterhouse, f.cutter, 90_000);
      }
      await xform(f, f.cutter, [a, b], [90_000, 90_000], [id("LEG")], [150_000], P.PRIMAL_CUT, [0]);
      const o = await f.c.originOf(id("LEG"));
      expect([o.countryOfBirth, o.countryOfRearing, o.countryOfSlaughter]).to.deep.equal([cc("XX"), cc("GR"), cc("GR")]);
    });

    it("INVARIANT: output meat never exceeds input meat", async function () {
      const f = await loadFixture(chainFixture);
      await expect(xform(f, f.processor, [f.CUT], [10_000], [id("S1")], [10_001], P.SKEWER, [50]))
        .to.be.revertedWithCustomError(f.c, "MassBalanceViolated");
      await expect(xform(f, f.processor, [f.CUT], [20_001], [id("S1")], [10_000], P.SKEWER, [50]))
        .to.be.revertedWithCustomError(f.c, "InvalidQuantity");
    });

    it("INVARIANT: only the current custodian can transform or ship", async function () {
      const f = await loadFixture(chainFixture);
      // CONE2 is still held by the processor
      await expect(xform(f, f.retailer, [f.CONE2], [1000], [id("L2")], [1000], P.SERVING_LOT, [5]))
        .to.be.revertedWithCustomError(f.c, "NotCustodian");
      await expect(f.c.connect(f.retailer).ship(f.CONE2, f.processor.address, f.carrier.address, doc("x")))
        .to.be.revertedWithCustomError(f.c, "NotCustodian");
    });

    it("each role may perform only its own product transition", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.grantRole(f.R.CUTTING_PLANT, f.processor.address);
      // processor holds a PRIMAL_CUT and may not turn it into a serving lot
      await expect(xform(f, f.processor, [f.CUT], [1000], [id("L")], [1000], P.SERVING_LOT, [5]))
        .to.be.revertedWithCustomError(f.c, "TransitionNotAllowed");
      // the retailer may not make skewers out of cones
      await expect(xform(f, f.retailer, [f.CONE1], [1000], [id("S")], [1000], P.SKEWER, [5]))
        .to.be.revertedWithCustomError(f.c, "TransitionNotAllowed");
    });

    it("output use-by cannot exceed the inputs' use-by", async function () {
      const f = await loadFixture(chainFixture);
      await expect(xform(f, f.retailer, [f.CONE1], [1000], [id("L2")], [1000], P.SERVING_LOT, [5], 30))
        .to.be.revertedWithCustomError(f.c, "InvalidTime");
    });

    it("an expired batch cannot be used", async function () {
      const f = await loadFixture(chainFixture);
      await time.increase(6 * DAY);
      await expect(f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("x")))
        .to.be.revertedWithCustomError(f.c, "BatchExpired");
    });
  });

  describe("Shipment and receipt", function () {
    it("transfers custody in two steps", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("dn")))
        .to.emit(f.c, "BatchShipped");
      const b = await f.c.getBatch(f.CONE2);
      expect(b.status).to.equal(ST.IN_TRANSIT);
      expect(b.custodian).to.equal(f.processor.address);
      await expect(f.c.connect(f.outsider).receiveBatch(f.CONE2, 45_000, 30, true))
        .to.be.revertedWithCustomError(f.c, "NotRecipient");
      await f.c.connect(f.retailer).receiveBatch(f.CONE2, 44_000, 30, true);
      const r = await f.c.getBatch(f.CONE2);
      expect(r.custodian).to.equal(f.retailer.address);
      expect(r.remaining).to.equal(44_000);
      expect(r.status).to.equal(ST.ACTIVE);
    });

    it("a rejected delivery returns to the sender", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("dn"));
      await f.c.connect(f.retailer).receiveBatch(f.CONE2, 0, 30, false);
      const b = await f.c.getBatch(f.CONE2);
      expect(b.custodian).to.equal(f.processor.address);
      expect(b.status).to.equal(ST.ACTIVE);
    });

    it("cannot accept a delivery above the temperature limit", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("dn"));
      await expect(f.c.connect(f.retailer).receiveBatch(f.CONE2, 45_000, 55, true))
        .to.be.revertedWithCustomError(f.c, "ReceiptTemperatureAboveLimit");
    });

    it("ships only to registered organisations with a registered carrier", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.processor).ship(f.CONE2, f.outsider.address, f.carrier.address, doc("x")))
        .to.be.revertedWithCustomError(f.c, "InvalidRecipient");
      await expect(f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.outsider.address, doc("x")))
        .to.be.revertedWithCustomError(f.c, "InvalidCarrier");
    });
  });

  describe("Cold chain", function () {
    it("quarantines a batch on a breach in transit; it is received but stays quarantined until released", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("dn"));
      await expect(f.c.connect(f.truckSensor).reportTemperature([f.CONE2], 30, 52, 41, 25, doc("series")))
        .to.emit(f.c, "BatchQuarantined").withArgs(f.CONE2, 52, 40);
      expect((await f.c.getBatch(f.CONE2)).status).to.equal(ST.QUARANTINED);

      await f.c.connect(f.retailer).receiveBatch(f.CONE2, 45_000, 38, true);
      const b = await f.c.getBatch(f.CONE2);
      expect(b.custodian).to.equal(f.retailer.address);
      expect(b.status).to.equal(ST.QUARANTINED);

      // INVARIANT: a quarantined batch cannot be transformed
      await expect(xform(f, f.retailer, [f.CONE2], [1000], [id("L2")], [1000], P.SERVING_LOT, [5], 1))
        .to.be.revertedWithCustomError(f.c, "InvalidStatus");

      await expect(f.c.connect(f.retailer).releaseQuarantine(f.CONE2, doc("x")))
        .to.be.revertedWithCustomError(f.c, "AccessControlUnauthorizedAccount");
      await f.c.connect(f.authority).releaseQuarantine(f.CONE2, doc("lab-result"));
      expect((await f.c.getBatch(f.CONE2)).status).to.equal(ST.ACTIVE);
      expect(await f.c.hasBreachInAncestry(f.CONE2)).to.be.true;
    });

    it("a release before receipt puts the batch back IN_TRANSIT", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("dn"));
      await f.c.connect(f.truckSensor).reportTemperature([f.CONE2], 30, 52, 41, 25, doc("series"));
      await f.c.connect(f.authority).releaseQuarantine(f.CONE2, doc("ok"));
      expect((await f.c.getBatch(f.CONE2)).status).to.equal(ST.IN_TRANSIT);
    });

    it("a device may report only on batches held or carried by its organisation", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.fridgeSensor).reportTemperature([f.CONE2], 10, 20, 15, 0, doc("s")))
        .to.be.revertedWithCustomError(f.c, "NotHeldByDeviceOrganisation");
      await expect(f.c.connect(f.truckSensor).reportTemperature([f.CONE2], 10, 20, 15, 0, doc("s")))
        .to.be.revertedWithCustomError(f.c, "NotHeldByDeviceOrganisation");
      await expect(f.c.connect(f.fridgeSensor).reportTemperature([f.CONE1], 30, 20, 15, 0, doc("s")))
        .to.be.revertedWithCustomError(f.c, "InvalidTemperatureSummary");
      await expect(f.c.connect(f.retailer).reportTemperature([f.CONE1], 10, 20, 15, 0, doc("s")))
        .to.be.revertedWithCustomError(f.c, "AccessControlUnauthorizedAccount");
    });

    it("storage reports update the cold-chain summary; a frozen limit is checked as such", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.fridgeSensor).reportTemperature([f.CONE1], 10, 38, 25, 0, doc("s"));
      const s = await f.c.getColdChain(f.CONE1);
      expect(s.reports).to.equal(2);
      expect(s.maxTemp).to.equal(38);
      expect(s.breaches).to.equal(0);
      await f.c.connect(f.authority).setTemperatureLimit(P.GYROS_CONE, S.CHILLED, 30);
      await f.c.connect(f.fridgeSensor).reportTemperature([f.CONE1], 10, 38, 25, 10, doc("s2"));
      expect((await f.c.getBatch(f.CONE1)).status).to.equal(ST.QUARANTINED);
    });
  });

  describe("Cooking and sales", function () {
    it("records cooking once and flags a core temperature below the minimum", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.retailer).recordCooking(f.LOT, 720, doc("haccp")))
        .to.emit(f.c, "CookingRecorded").withArgs(f.LOT, 720, false, doc("haccp"));
      await expect(f.c.connect(f.retailer).recordCooking(f.LOT, 800, doc("haccp")))
        .to.be.revertedWithCustomError(f.c, "CookingAlreadyRecorded");
    });

    it("INVARIANT: portions sold never exceed portions produced", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.retailer).recordSales(f.LOT, 60);
      await expect(f.c.connect(f.retailer).recordSales(f.LOT, 41))
        .to.be.revertedWithCustomError(f.c, "PortionsExceeded").withArgs(100, 101);
      await expect(f.c.connect(f.retailer).recordSales(f.LOT, 40))
        .to.emit(f.c, "BatchStatusChanged").withArgs(f.LOT, ST.ACTIVE, ST.CONSUMED);
      expect(await f.c.portionsSold(f.LOT)).to.equal(100);
    });

    it("sales are recorded only on serving lots", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.retailer).recordSales(f.CONE1, 1)).to.be.revertedWithCustomError(f.c, "NotServingLot");
    });
  });

  describe("Recall", function () {
    it("INVARIANT: recalling a carcass recalls every derived batch; they cannot be sold, transformed or shipped", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.authority).issueRecall(f.C1, 3, doc("notice")))
        .to.emit(f.c, "RecallIssued").withArgs(f.C1, f.authority.address, 3, doc("notice"));

      for (const b of [f.C1, f.CUT, f.CONE1, f.CONE2, f.LOT]) {
        expect(await f.c.isRecalled(b)).to.be.true;
        expect(await f.c.effectiveStatus(b)).to.equal(ST.RECALLED);
      }
      expect(await f.c.isRecalled(f.C2)).to.be.false;

      await expect(f.c.connect(f.retailer).recordSales(f.LOT, 1)).to.be.revertedWithCustomError(f.c, "BatchIsRecalled");
      await expect(xform(f, f.retailer, [f.CONE1], [1000], [id("L2")], [1000], P.SERVING_LOT, [5], 1))
        .to.be.revertedWithCustomError(f.c, "BatchIsRecalled");
      await expect(f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("x")))
        .to.be.revertedWithCustomError(f.c, "BatchIsRecalled");
    });

    it("the creator of a batch may recall it; others may not; no double recall", async function () {
      const f = await loadFixture(chainFixture);
      await expect(f.c.connect(f.retailer).issueRecall(f.CONE2, 1, doc("x")))
        .to.be.revertedWithCustomError(f.c, "NotAuthorisedToRecall");
      await f.c.connect(f.processor).issueRecall(f.CONE2, 1, doc("x"));
      expect((await f.c.getBatch(f.CONE2)).status).to.equal(ST.RECALLED);
      expect(await f.c.isRecalled(f.CONE1)).to.be.false;
      await expect(f.c.connect(f.authority).issueRecall(f.CONE2, 1, doc("x")))
        .to.be.revertedWithCustomError(f.c, "AlreadyRecalled");
    });

    it("a batch recalled in transit can still be received and stays recalled", async function () {
      const f = await loadFixture(chainFixture);
      await f.c.connect(f.processor).ship(f.CONE2, f.retailer.address, f.carrier.address, doc("dn"));
      await f.c.connect(f.authority).issueRecall(f.CONE2, 2, doc("x"));
      await f.c.connect(f.retailer).receiveBatch(f.CONE2, 45_000, 30, true);
      const b = await f.c.getBatch(f.CONE2);
      expect(b.custodian).to.equal(f.retailer.address);
      expect(b.status).to.equal(ST.RECALLED);
    });
  });
});

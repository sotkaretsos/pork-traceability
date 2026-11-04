// Replays the simplified-model demo in Node, checks every rule-breaking attempt and the
// verification page, and writes demo/reference.json.
import { writeFileSync } from "node:fs";
import { PorkTraceDemo, LOTS } from "../src/scenario.js";

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
};
const demo = await new PorkTraceDemo().init();
const steps = [["setup", () => demo.setup()], ["deliveries", () => demo.deliveries()], ["storage", () => demo.storage()], ["service", () => demo.service()], ["withdrawal", () => demo.withdrawal()]];
for (const [i, [name, run]] of steps.entries()) {
  await run();
  for (const a of demo.attacks().filter((x) => x.needs === i + 1 || (name === "withdrawal" && x.needs <= 5))) {
    const r = await a.run();
    const ok = a.expect === "auto" ? r.auto && r.withdrawn.length > 0 : !r.accepted && r.name === a.expect;
    console.log(`${ok ? "ok  " : "FAIL"} after ${name.padEnd(11)} ${a.key.padEnd(10)} → ${r.auto ? `withdrawn: ${r.withdrawn.join(", ")}` : r.accepted ? "accepted" : r.name} ${demo.describeArgs(r.name, r.args ?? []).join("; ")}`);
    if (!ok) fail(`${a.key} expected ${a.expect}`);
  }
  if (name === "service" || name === "withdrawal") {
    for (const lot of LOTS) {
      const v = await demo.lotView(lot.id);
      console.log(`     ${lot.title}: origin ${v.origin.join("/")} single=${v.singleCountry}, ${v.daysSinceSlaughter} days, storage ok ${v.storageOk}, cooking ${v.cooking.temp} °C ok ${v.cooking.ok}, ${v.sold}/${v.portions}, closed ${v.closed}, withdrawn ${v.withdrawn}`);
    }
  }
}
const lunch = await demo.lotView(LOTS[0].id);
const dinner = await demo.lotView(LOTS[1].id);
if (lunch.withdrawn || !dinner.withdrawn) fail("withdrawal should reach the dinner lot only");
if (lunch.singleCountry !== "GR" || dinner.singleCountry) fail("origin derivation");
const t = demo.totals();
console.log(`transactions ${t.transactions}, gas ${t.gasUsed}, deployment gas ${t.deploymentGas}`);
writeFileSync(new URL("../reference.json", import.meta.url), JSON.stringify(t, null, 2) + "\n");

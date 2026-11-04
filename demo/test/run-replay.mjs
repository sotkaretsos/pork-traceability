// Replays the demo scenario in Node, checks that every rule-breaking attempt is rejected with the
// expected error and that the verification page reads as expected, and writes demo/reference.json.
import { writeFileSync } from "node:fs";
import { PorkDemo, LOTS } from "../src/scenario.js";

const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  process.exitCode = 1;
};
const demo = await new PorkDemo().init();
const steps = [["setup", () => demo.setup()], ["slaughter", () => demo.slaughter()], ["processing", () => demo.processing()], ["service", () => demo.service()], ["recall", () => demo.recall()]];
const results = {};
for (const [i, [name, run]] of steps.entries()) {
  await run();
  for (const a of demo.attacks().filter((x) => x.needs === i + 1 || (name === "recall" && x.needs <= 5))) {
    const r = await a.run();
    const ok = !r.accepted && r.name === a.expect;
    results[`${a.key}@${name}`] = r.name ?? "accepted";
    console.log(`${ok ? "ok  " : "FAIL"} after ${name.padEnd(10)} ${a.key.padEnd(15)} → ${r.accepted ? "accepted" : r.name} ${demo.describeArgs(r.name, r.args ?? []).join("; ")}`);
    if (!ok) fail(`${a.key} expected ${a.expect}`);
  }
  if (name === "service" || name === "recall") {
    for (const lot of LOTS) {
      const v = await demo.lotView(lot.id);
      console.log(`     ${lot.title}: ${v.status}, origin ${v.origin.join("/")}, ${v.daysSinceSlaughter} days, cooking ${v.cooking.temp} °C, ${v.sold}/${v.portions}, recalled via ${v.recalled.map((x) => x.label).join(", ") || "–"}`);
    }
  }
}
const lunch = await demo.lotView(LOTS[0].id);
const dinner = await demo.lotView(LOTS[1].id);
if (lunch.status !== "Recalled") fail("lunch lot should be recalled");
if (dinner.status === "Recalled") fail("dinner lot should not be recalled");
const t = demo.totals();
console.log(`transactions ${t.transactions}, gas ${t.gasUsed}, deployment gas ${t.deploymentGas}`);
writeFileSync(new URL("../reference.json", import.meta.url), JSON.stringify({ transactions: t.transactions, gasUsed: t.gasUsed, deploymentGas: t.deploymentGas }, null, 2) + "\n");

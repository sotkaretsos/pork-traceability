// Writes ../docs/THIRD_PARTY_NOTICES.txt for the packages that contribute code to docs/assets/demo.js.
// Run after "npm run build" (it reads build/meta.json written by the build).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const meta = JSON.parse(readFileSync(join(here, "build", "meta.json"), "utf8"));
const out = Object.values(meta.outputs)[0];
const pkgs = new Map();
for (const [file, info] of Object.entries(out.inputs)) {
  if (!info.bytesInOutput) continue;
  const m = file.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (!m) continue;
  const dir = join(here, m[1]);
  if (pkgs.has(dir)) continue;
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licFile = readdirSync(dir).find((f) => /^(license|licence|copying)(\.|$)/i.test(f));
  pkgs.set(dir, { name: p.name, version: p.version, license: typeof p.license === "string" ? p.license : JSON.stringify(p.license), text: licFile ? readFileSync(join(dir, licFile), "utf8").trim() : null });
}
const list = [...pkgs.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const sha = createHash("sha256").update(readFileSync(join(root, "docs", "assets", "demo.js"))).digest("hex");
const tarball = (p) => `https://registry.npmjs.org/${p.name}/-/${p.name.split("/").pop()}-${p.version}.tgz`;
const lines = [
  "THIRD-PARTY SOFTWARE LICENSES AND NOTICES",
  "Pork Traceability simplified-model live demo, release 1.0.0",
  "",
  `This notice accompanies docs/assets/demo.js (SHA-256 ${sha}).`,
  "The package list is derived from the esbuild metafile: every package that contributes bytes to the bundle is listed.",
  "The compiled PorkTrace bytecode embedded in the bundle includes OpenZeppelin Contracts (MIT).",
  "demo/src/local-chain.js and docs/assets/style.css are adapted from evoo-carbon-ledger (https://github.com/sotkaretsos/evoo-carbon-ledger), MIT License, Copyright (c) 2026 Sotirios Karetsos, Konstantinos Demestichas, Constantina Costopoulou.",
  "",
  "MPL-2.0 SOURCE CODE AVAILABILITY",
  "Portions of EthereumJS are distributed here in bundled, minified form under the Mozilla Public License 2.0. Their Source Code Form is available, unmodified, in the official npm distributions listed below (demo/package-lock.json records the exact versions and integrity digests). The upstream libraries have not been edited; the project-specific sources of the demo are in demo/src/.",
  "",
  "PACKAGE INDEX",
  "",
  ...list.map((p) => `${p.name}@${p.version} | ${p.license} | ${tarball(p)}`),
  "@openzeppelin/contracts | MIT | compiled into the contract bytecode",
  "",
  "LICENSE TEXTS",
  "",
];
const seen = new Map();
for (const p of list) {
  if (!p.text) {
    const same = list.find((q) => q.text && q.license === p.license);
    lines.push(`----- ${p.name}@${p.version} (${p.license}): the package ships no license file; the ${p.license} text is the one given for ${same ? `${same.name}@${same.version}` : "this license"}`, "");
    continue;
  }
  const key = p.text;
  if (seen.has(key)) {
    lines.push(`----- ${p.name}@${p.version} (${p.license}): same text as ${seen.get(key)}`, "");
    continue;
  }
  seen.set(key, `${p.name}@${p.version}`);
  lines.push(`----- ${p.name}@${p.version} (${p.license})`, "", p.text, "");
}
writeFileSync(join(root, "docs", "THIRD_PARTY_NOTICES.txt"), lines.join("\n") + "\n");
console.log(`notices: ${list.length} packages`);

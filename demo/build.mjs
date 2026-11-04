// Builds the live demo into ../docs/assets (GitHub Pages) from the compiled contract.
// Usage (from the repository root):  npx hardhat compile && cd demo && npm ci && npm run build
//        Node replay and reference:   cd demo && npm run test:node
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const artifact = join(root, "artifacts", "contracts", "PorkTraceability.sol", "PorkTraceability.json");
if (!existsSync(artifact)) throw new Error(`${artifact} not found: run "npx hardhat compile" in the repository root first`);
const a = JSON.parse(readFileSync(artifact, "utf8"));
mkdirSync(join(here, "build"), { recursive: true });
writeFileSync(join(here, "build", "contracts.json"), JSON.stringify({ PorkTraceability: { abi: a.abi, bytecode: a.bytecode } }));
if (!existsSync(join(here, "reference.json"))) writeFileSync(join(here, "reference.json"), "{}\n");

const common = { bundle: true, absWorkingDir: here, loader: { ".json": "json" }, logLevel: "warning", legalComments: "none" };
const target = process.argv[2] ?? "browser";
if (target === "node") {
  await build({ ...common, entryPoints: [join(here, "test", "run-replay.mjs")], platform: "node", format: "esm", outfile: join(here, "build", "run-replay.bundle.mjs"), banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
} else {
  const result = await build({ ...common, entryPoints: [join(here, "src", "app.js")], platform: "browser", format: "iife", target: ["es2020"], minify: true, sourcemap: false, metafile: true, outfile: join(root, "docs", "assets", "demo.js") });
  writeFileSync(join(here, "build", "meta.json"), JSON.stringify(result.metafile));
}
console.log(`built (${target})`);

// Build step: copy bundled agent .md files into dist/agents/ so the published
// package can resolve them at runtime (tsc does not copy non-TS assets).

import { existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "agents");
const dest = join(root, "dist", "agents");

if (!existsSync(src)) {
  console.error("no src/agents to copy");
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (f.endsWith(".md")) {
    copyFileSync(join(src, f), join(dest, f));
    n++;
  }
}
console.log(`copied ${n} agent file(s) to dist/agents`);

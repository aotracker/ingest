#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ingestRoot = resolve(here, "..");
const clientRoot = resolve(ingestRoot, "..", "client");

const PAIRS = [
  "src/lib/db/schema.ts",
  "src/lib/albion/classify.ts",
  "src/lib/albion/kills.ts",
  "src/lib/db/battle-cache.ts",
  "src/lib/db/sync.ts",
  "src/lib/db/queries-ingest.ts",
];

if (!existsSync(join(clientRoot, "package.json"))) {
  console.log("[drift] Skipping — sibling client/ not present.");
  process.exit(0);
}

let drifted = false;
for (const rel of PAIRS) {
  const a = join(clientRoot, rel);
  const b = join(ingestRoot, rel);
  if (!existsSync(a) || !existsSync(b)) {
    console.error(`[drift] Missing file: ${rel}`);
    drifted = true;
    continue;
  }
  if (readFileSync(a, "utf8") !== readFileSync(b, "utf8")) {
    console.error(`[drift] ${rel} differs between client/ and ingest/`);
    drifted = true;
  } else {
    console.log(`[drift] ok ${rel}`);
  }
}

if (drifted) process.exit(1);
console.log("[drift] All watched lib copies match.");

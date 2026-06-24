// One-shot seed: records evals/golden/electronics-headphones.json into store/example/
// with a FIXED timestamp so the committed example is deterministic.
// Run: node tools/seed-example.mjs
import { recordRun } from "./store.mjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rec = JSON.parse(readFileSync(join(root, "evals/golden/electronics-headphones.json"), "utf8"));
const { id } = recordRun(rec, { storeDir: join(root, "store/example"), now: "2026-06-23T10:00:00.000Z" });
console.log("seeded example store:", id);

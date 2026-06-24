// Discern schema + fixture validator (Phase 1 test harness).
// Runs via `npm test`. Exits non-zero on any violation so CI / the stack gate fails loudly.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { categoryGateViolations, anchorResolves } from "./category-gate.mjs";
import { coverageViolations } from "./coverage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const recSchema = JSON.parse(readFileSync(join(root, "schemas/recommendation-object.schema.json"), "utf8"));
const profileSchema = JSON.parse(readFileSync(join(root, "schemas/profile.schema.json"), "utf8"));
const validateRec = ajv.compile(recSchema);
const validateProfile = ajv.compile(profileSchema);

const failures = [];
let checks = 0;

const fail = (where, msg) => failures.push(`${where}: ${msg}`);
const errs = (v) => (v.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");

function listFiles(dir, ext) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(ext))
    .map((d) => join(dir, d.name));
}

// Required directories must exist — a missing one would silently drop coverage.
for (const d of ["schemas", "profiles", "evals/golden", "evals/expected", "evals/invalid"]) {
  checks++;
  if (!existsSync(join(root, d))) fail("setup", `required directory missing: ${d}`);
}

function jsonFromMarkdown(file) {
  const text = readFileSync(join(root, file), "utf8");
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error("no ```json block found");
  return JSON.parse(m[1]);
}

// --- Profiles: every *.example.md must contain a valid profile -------------------------------------
const profileFiles = [...listFiles("profiles", ".example.md"), ...listFiles("profiles/recipients", ".md")]
  .filter((f) => f.endsWith("example.md"));
for (const f of profileFiles) {
  checks++;
  try {
    const obj = jsonFromMarkdown(f);
    if (!validateProfile(obj)) fail(f, `profile schema: ${errs(validateProfile)}`);
  } catch (e) {
    fail(f, e.message);
  }
}

// --- Golden fixtures: must VALIDATE + match their expected-outcome manifest entry -------------------
const expected = JSON.parse(readFileSync(join(root, "evals/expected/manifest.json"), "utf8"));
const goldenFiles = listFiles("evals/golden", ".json");
const goldenOutcomes = {}; // basename -> observed {outcome, reason_code, pick} for the category-widening gate
const goldenRecs = {};     // basename -> full Recommendation Object (for the gate's exhibition + fingerprint)
for (const f of goldenFiles) {
  checks++;
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(root, f), "utf8"));
  } catch (e) {
    fail(f, `parse: ${e.message}`);
    continue;
  }
  if (!validateRec(obj)) fail(f, `recommendation schema: ${errs(validateRec)}`);

  // Coverage gate: every golden must pass multi-angle coverage enforcement.
  for (const gv of coverageViolations(obj)) fail("coverage-gate", gv);

  // Every golden MUST have an explicit expected-outcome assertion in the manifest.
  const name = basename(f);
  goldenOutcomes[name] = { outcome: obj.outcome, reason_code: obj.reason_code, pick: obj.pick?.product };
  goldenRecs[name] = obj;
  const exp = expected[name];
  if (!exp) { fail(f, `no expected-outcome entry in evals/expected/manifest.json`); continue; }
  if (obj.outcome !== exp.outcome) fail(f, `outcome ${obj.outcome} != expected ${exp.outcome}`);
  if (exp.reason_code !== undefined && obj.reason_code !== exp.reason_code)
    fail(f, `reason_code ${obj.reason_code} != expected ${exp.reason_code}`);
  if (exp.pick !== undefined && obj.pick?.product !== exp.pick)
    fail(f, `pick ${obj.pick?.product} != expected ${exp.pick}`);
  if (exp.beneficiary_type !== undefined && obj.beneficiary?.type !== exp.beneficiary_type)
    fail(f, `beneficiary.type ${obj.beneficiary?.type} != expected ${exp.beneficiary_type}`);
}
// Every manifest entry must correspond to a real golden fixture (no orphan expectations).
for (const name of Object.keys(expected)) {
  checks++;
  if (!goldenFiles.some((f) => basename(f) === name))
    fail("evals/expected/manifest.json", `entry '${name}' has no matching golden fixture`);
}

// --- Invalid fixtures: must be parseable JSON that the SCHEMA rejects (proves the gate bites) -------
const invalidFiles = listFiles("evals/invalid", ".json");
for (const f of invalidFiles) {
  checks++;
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(root, f), "utf8"));
  } catch (e) {
    fail(f, `invalid fixtures must be parseable JSON the schema rejects (not malformed JSON); parse error: ${e.message}`);
    continue;
  }
  if (validateRec(obj)) fail(f, `expected schema VIOLATION but it validated clean`);
}

// --- Coverage floor: fail loudly if a fixture set shrank (no silent coverage drop) ------------------
checks++;
if (profileFiles.length < 2) fail("coverage", `expected >=2 profile examples, found ${profileFiles.length}`);
checks++;
if (goldenFiles.length < 4) fail("coverage", `expected >=4 golden fixtures, found ${goldenFiles.length}`);
checks++;
if (invalidFiles.length < 1) fail("coverage", `expected >=1 invalid fixture, found ${invalidFiles.length}`);

// --- Category-widening gate: enforce the registry/baseline against the REAL fixtures ----------------
// `npm test` fails if a golden fixture (category) lacks a generalized-rule note, cites a rule outside the
// catalog, or if a seed category regresses from its recorded baseline. (PREMORTEM Story 3, VISION §3.3.)
// The bite is proven on synthetic cases in test-logic.mjs; here it runs against the live data.
{
  checks++;
  const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  // A missing/unparseable gate data file is a clean, observable failure — not a stack trace.
  let catalog, registry, baseline, loadError = null;
  try {
    catalog = readJson("evals/rule-catalog.json");
    registry = readJson("evals/category-registry.json");
    baseline = readJson("evals/baseline-picks.json");
  } catch (e) {
    loadError = e.message;
  }
  if (loadError) {
    fail("category-widening-gate", `cannot load gate data (rule-catalog/category-registry/baseline-picks): ${loadError}`);
  } else {
    // Structural anchor resolution; a read error falls to "unresolved" (the safe direction → gate fires).
    const fileContains = (file, token) => {
      let text;
      try { text = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : null; }
      catch { return false; }
      return text === null ? false : anchorResolves(text, token, file.endsWith(".mjs"));
    };
    const goldenNames = goldenFiles.map((f) => basename(f));
    try {
      const gateViolations = categoryGateViolations({
        goldenNames, registry, catalog, baseline, goldenOutcomes, goldenRecs, fileContains,
      });
      for (const gv of gateViolations) fail("category-widening-gate", gv);
    } catch (e) {
      fail("category-widening-gate", `gate evaluation crashed (treat as fail): ${e.message}`);
    }
  }
}

// --- Example store: validate runs/*.json against rec schema and index.json against index schema ----
{
  const indexSchema = JSON.parse(readFileSync(join(root, "schemas/store-index.schema.json"), "utf8"));
  const validateIndex = ajv.compile(indexSchema);

  const exampleDir = join(root, "store/example");
  const exampleRuns = join(exampleDir, "runs");
  const exampleIndexPath = join(exampleDir, "index.json");

  if (!existsSync(exampleDir)) {
    fail("store/example", "example store directory missing — run node tools/seed-example.mjs");
  } else {
    // Validate each run json against the rec schema
    const runFiles = existsSync(exampleRuns)
      ? readdirSync(exampleRuns, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith(".json"))
          .map((d) => join("store/example/runs", d.name))
      : [];
    checks++;
    if (runFiles.length === 0) fail("store/example/runs", "no run json files found");
    for (const f of runFiles) {
      checks++;
      let obj;
      try {
        obj = JSON.parse(readFileSync(join(root, f), "utf8"));
      } catch (e) {
        fail(f, `parse: ${e.message}`);
        continue;
      }
      if (!validateRec(obj)) fail(f, `rec schema: ${errs(validateRec)}`);
    }

    // Validate index.json against the store-index schema
    checks++;
    if (!existsSync(exampleIndexPath)) {
      fail("store/example/index.json", "missing — run node tools/seed-example.mjs");
    } else {
      let idx;
      try {
        idx = JSON.parse(readFileSync(exampleIndexPath, "utf8"));
      } catch (e) {
        fail("store/example/index.json", `parse: ${e.message}`);
        idx = null;
      }
      if (idx !== null && !validateIndex(idx))
        fail("store/example/index.json", `store-index schema: ${errs(validateIndex)}`);
    }
  }
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} checks passed (profiles + golden + invalid fixtures + category-widening gate + example store).`);

// Discern schema + fixture validator (Phase 1 test harness).
// Runs via `npm test`. Exits non-zero on any violation so CI / the stack gate fails loudly.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

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

// --- Golden fixtures: must VALIDATE against the recommendation schema -------------------------------
for (const f of listFiles("evals/golden", ".json")) {
  checks++;
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(root, f), "utf8"));
  } catch (e) {
    fail(f, `parse: ${e.message}`);
    continue;
  }
  if (!validateRec(obj)) fail(f, `recommendation schema: ${errs(validateRec)}`);

  // Semantic assertions keyed off the fixture's intent (encoded in its filename).
  const name = basename(f);
  if (name.includes("safety")) {
    if (obj.outcome !== "INSUFFICIENT_EVIDENCE")
      fail(f, `safety case must be INSUFFICIENT_EVIDENCE, got ${obj.outcome}`);
    if (obj.reason_code !== "UNSAFE_BRAND_PROXY")
      fail(f, `safety case must have reason_code UNSAFE_BRAND_PROXY, got ${obj.reason_code}`);
  }
  if (name.includes("gift")) {
    if (obj.beneficiary?.type !== "recipient")
      fail(f, `gift case must have beneficiary.type=recipient`);
  }
}

// --- Invalid fixtures: must FAIL the schema (proves the gate bites) ---------------------------------
for (const f of listFiles("evals/invalid", ".json")) {
  checks++;
  let obj;
  try {
    obj = JSON.parse(readFileSync(join(root, f), "utf8"));
  } catch {
    continue; // a fixture that won't even parse is "invalid" as intended
  }
  if (validateRec(obj)) fail(f, `expected schema VIOLATION but it validated clean`);
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} checks passed (profiles + golden + invalid fixtures).`);

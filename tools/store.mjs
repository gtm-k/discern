// Durable run store writer (Discern v2 — spec: prd/discern/specs/2026-06-23-durable-store-and-tui-viewer-design.md).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { renderReport } from "./render.mjs";
import { buildComparison } from "./compare.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
const validateRec = ajv.compile(JSON.parse(readFileSync(join(root,"schemas/recommendation-object.schema.json"),"utf8")));
const validateIndex = ajv.compile(JSON.parse(readFileSync(join(root,"schemas/store-index.schema.json"),"utf8")));
const validateCompare = ajv.compile(JSON.parse(readFileSync(join(root,"schemas/store-compare.schema.json"),"utf8")));

const slug = (s) => String(s ?? "run").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40) || "run";
export function makeId(rec, nowIso) {
  const ts = nowIso.replace(/[-:]/g,"").replace(/\.\d+Z$/,"Z");
  const base = rec?.framed_requirements?.need || rec?.candidates?.[0]?.category_taxonomy || "run";
  return `${ts}-${slug(base)}`;
}
// timestamp: prefer the real ISO `nowIso` (recordRun); else reconstruct ISO from the id (rebuildIndex).
const isoFromId = (id) => { const m = String(id).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : String(id).slice(0,16); };
const entryOf = (rec, id, nowIso) => ({
  id, timestamp: nowIso ?? isoFromId(id),
  need: rec?.framed_requirements?.need ?? "(no need)",
  category_taxonomy: rec?.candidates?.[0]?.category_taxonomy,
  beneficiary_type: rec?.beneficiary?.type === "recipient" ? "recipient" : "self",
  outcome: rec?.outcome, reason_code: rec?.reason_code,
  pick: rec?.pick?.product ?? null, confidence_overall: typeof rec?.confidence_overall==="number"?rec.confidence_overall:null,
  json: `runs/${id}.json`, md: `runs/${id}.md`, compare: `runs/${id}.compare.json`,
});

// `makeComparison` is injectable purely so the fail-closed guard below is testable — production
// always uses the real buildComparison (compare.mjs, the single home of comparison logic).
export function recordRun(rec, { storeDir = "store", now, makeComparison = buildComparison } = {}) {
  if (!validateRec(rec)) throw new Error(`store: refusing to record an invalid Recommendation Object: ${(validateRec.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
  const nowIso = now ?? new Date().toISOString();
  const runs = join(storeDir,"runs");
  // Resolve a collision-free id WITHOUT writing anything: an id is occupied if
  // EITHER artifact (json or md) already exists.
  let id = makeId(rec, nowIso), n = 1;
  while (existsSync(join(runs,id+".json")) || existsSync(join(runs,id+".md"))) id = `${makeId(rec,nowIso)}-${++n}`;
  // Build the candidate index and validate it BEFORE any filesystem mutation, so
  // a validation failure cannot leave orphaned run artifacts behind.
  const idxPath = join(storeDir,"index.json");
  const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath,"utf8")) : [];
  idx.push(entryOf(rec, id, nowIso));
  if (!validateIndex(idx)) throw new Error(`store: index would be invalid: ${(validateIndex.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
  // Derive the comparison sidecar and validate it too, fail-closed (design §6b) — a malformed
  // comparison throws BEFORE any write, exactly like the Object/index, so no partial store results.
  const comparison = makeComparison(rec); comparison.id = id;
  if (!validateCompare(comparison)) throw new Error(`store: refusing to record an invalid comparison: ${(validateCompare.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
  // All validation passed — now write artifacts + sidecar + index.
  mkdirSync(runs,{recursive:true});
  writeFileSync(join(runs,id+".json"), JSON.stringify(rec,null,2)+"\n");
  writeFileSync(join(runs,id+".md"), renderReport(rec)+"\n");
  writeFileSync(join(runs,id+".compare.json"), JSON.stringify(comparison,null,2)+"\n");
  writeFileSync(idxPath, JSON.stringify(idx,null,2)+"\n");
  return { id };
}

export function rebuildIndex({ storeDir = "store", makeComparison = buildComparison } = {}) {
  const runs = join(storeDir,"runs");
  const files = existsSync(runs) ? readdirSync(runs).filter(f=>f.endsWith(".json")&&!f.endsWith(".compare.json")).sort() : []; // id-prefix sorts chronologically; skip sidecars
  // Collect the sidecar writes but DON'T flush them until every run + comparison + the whole index
  // validates — the same validate-all-before-mutate discipline recordRun uses (no partial back-fill).
  const sidecars = [];
  const idx = files.map(f => {
    // A syntactically broken run (truncated/corrupt) throws a bare parse error
    // WITHOUT the filename — wrap it so the operator can find the offending file.
    let rec;
    try { rec = JSON.parse(readFileSync(join(runs,f),"utf8")); }
    catch (e) { throw new Error(`store: refusing to index invalid run ${f}: invalid JSON: ${e.message}`); }
    // Fail-closed (consistent with recordRun): never index a malformed run with
    // default fields — throw, naming the offending file.
    if (!validateRec(rec)) throw new Error(`store: refusing to index invalid run ${f}: ${(validateRec.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
    const id = basename(f,".json");
    // Back-fill the comparison sidecar for this run, fail-closed (design §6b/§8) — an invalid
    // comparison throws (naming the file) before any write.
    const comparison = makeComparison(rec); comparison.id = id;
    if (!validateCompare(comparison)) throw new Error(`store: refusing to index run ${f}: invalid comparison: ${(validateCompare.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
    sidecars.push([join(runs, id+".compare.json"), JSON.stringify(comparison,null,2)+"\n"]);
    return entryOf(rec, id);
  });
  if (!validateIndex(idx)) throw new Error("store: rebuilt index invalid");
  mkdirSync(storeDir,{recursive:true}); // ensure a missing/custom store dir yields a valid empty index, not ENOENT
  for (const [p,c] of sidecars) writeFileSync(p, c);
  writeFileSync(join(storeDir,"index.json"), JSON.stringify(idx,null,2)+"\n");
  return { count: idx.length };
}

// CLI — resolve the store against repo root so the CLI is location-independent
// (consistent with how schemas are resolved above).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, arg] = process.argv.slice(2);
  const storeDir = join(root, "store");
  try {
    if (cmd === "record") {
      if (!arg) { console.error("usage: node tools/store.mjs record <rec.json>"); process.exit(2); }
      const { id } = recordRun(JSON.parse(readFileSync(arg,"utf8")), { storeDir }); console.log("recorded", id);
    }
    else if (cmd === "reindex") { console.log("reindexed", rebuildIndex({ storeDir }).count); }
    else { console.error("usage: node tools/store.mjs record <rec.json> | reindex"); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}

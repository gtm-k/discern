// Durable run store writer (Discern v2 — spec: prd/discern/specs/2026-06-23-durable-store-and-tui-viewer-design.md).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { renderReport } from "./render.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
const validateRec = ajv.compile(JSON.parse(readFileSync(join(root,"schemas/recommendation-object.schema.json"),"utf8")));
const validateIndex = ajv.compile(JSON.parse(readFileSync(join(root,"schemas/store-index.schema.json"),"utf8")));

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
  json: `runs/${id}.json`, md: `runs/${id}.md`,
});

export function recordRun(rec, { storeDir = "store", now } = {}) {
  if (!validateRec(rec)) throw new Error(`store: refusing to record an invalid Recommendation Object: ${(validateRec.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
  const nowIso = now ?? new Date().toISOString();
  let id = makeId(rec, nowIso), n = 1;
  const runs = join(storeDir,"runs"); mkdirSync(runs,{recursive:true});
  while (existsSync(join(runs,id+".json"))) id = `${makeId(rec,nowIso)}-${++n}`;
  writeFileSync(join(runs,id+".json"), JSON.stringify(rec,null,2));
  writeFileSync(join(runs,id+".md"), renderReport(rec)+"\n");
  const idxPath = join(storeDir,"index.json");
  const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath,"utf8")) : [];
  idx.push(entryOf(rec, id, nowIso));
  if (!validateIndex(idx)) throw new Error(`store: index would be invalid: ${(validateIndex.errors||[]).map(e=>e.instancePath+" "+e.message).join("; ")}`);
  writeFileSync(idxPath, JSON.stringify(idx,null,2));
  return { id };
}

export function rebuildIndex({ storeDir = "store" } = {}) {
  const runs = join(storeDir,"runs");
  const files = existsSync(runs) ? readdirSync(runs).filter(f=>f.endsWith(".json")).sort() : []; // id-prefix sorts chronologically
  const idx = files.map(f => entryOf(JSON.parse(readFileSync(join(runs,f),"utf8")), basename(f,".json")));
  if (!validateIndex(idx)) throw new Error("store: rebuilt index invalid");
  writeFileSync(join(storeDir,"index.json"), JSON.stringify(idx,null,2));
  return { count: idx.length };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "record") { const { id } = recordRun(JSON.parse(readFileSync(arg,"utf8"))); console.log("recorded", id); }
    else if (cmd === "reindex") { console.log("reindexed", rebuildIndex({}).count); }
    else { console.error("usage: node tools/store.mjs record <rec.json> | reindex"); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}

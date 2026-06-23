// Live-smoke checker (Discern Phase 6 — upstream contract: mock != real).
//
// The offline evals run against fixtures; the web is the UNSTABLE upstream (VISION §3.4). The live-smoke
// protocol (docs/live-smoke.md) runs Discern against ONE named category with REAL search+fetch. This
// function turns the produced Recommendation Object into an observable PASS/FAIL so a run that quietly
// returns nothing cannot be mistaken for success. Empty return = PASS.
//
// PASS criteria (docs/live-smoke.md): queries_run > 0 AND fetches_used > 0 AND
//   ( >=1 credible (independent, non-affiliate) evidence item  OR  a correct INSUFFICIENT_EVIDENCE ),
// and an INSUFFICIENT_ACCESS outcome must record WHY (a failed/blocked source or a budget hit) — never an
// unexplained empty.

const isCredible = (e) => e?.independence_flag === true && e?.affiliate_or_sponsored_flag !== true;

export function liveSmokeViolations(rec) {
  const v = [];
  const su = rec?.search_universe ?? {};

  // A non-empty, non-blank query string proves the universe was actually exercised — an array of empty
  // strings is a plausible malformed agent output and must NOT satisfy the check.
  const queries = Array.isArray(su.queries_run)
    ? su.queries_run.filter((q) => typeof q === "string" && q.trim().length > 0).length : 0;
  if (queries <= 0) v.push("live-smoke: queries_run is 0 — the search universe was never exercised");

  const fetches = typeof su.fetches_used === "number" ? su.fetches_used : 0;
  if (fetches <= 0) v.push("live-smoke: fetches_used is 0 — no page was actually fetched");

  // Guard array shapes — a malformed (non-array) candidates/evidence must fail cleanly, not throw.
  const credible = (Array.isArray(rec?.candidates) ? rec.candidates : []).reduce(
    (n, c) => n + (Array.isArray(c?.evidence) ? c.evidence : []).filter(isCredible).length, 0);
  const insufficient = rec?.outcome === "INSUFFICIENT_EVIDENCE";

  // The honesty rule: an empty result is only acceptable when it is declared INSUFFICIENT_EVIDENCE.
  if (credible === 0 && !insufficient)
    v.push("live-smoke: silent-empty — produced no credible (independent, non-affiliate) evidence yet did not return INSUFFICIENT_EVIDENCE");

  // An access failure must say so: record a blocked source or a budget hit, not a bare empty.
  if (rec?.reason_code === "INSUFFICIENT_ACCESS") {
    const recorded = (su.sources_failed_or_blocked?.length ?? 0) + (su.budgets_hit?.length ?? 0);
    if (recorded === 0)
      v.push("live-smoke: INSUFFICIENT_ACCESS but no sources_failed_or_blocked / budgets_hit recorded — unexplained access gap");
  }

  return v;
}

// CLI: `node tools/live-smoke-check.mjs <path-to-recommendation-object.json>`
// Thin glue around liveSmokeViolations (logic covered in test-logic.mjs). Exits non-zero on FAIL.
// Guard: only run as a CLI when THIS file is the entry script (resolved-path compare, not a basename match).
const { fileURLToPath } = await import("node:url");
const { resolve } = await import("node:path");
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node tools/live-smoke-check.mjs <path-to-recommendation-object.json>");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  let rec;
  try {
    rec = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`live-smoke: cannot read/parse ${path}: ${e.message}`);
    process.exit(2);
  }
  let violations;
  try {
    violations = liveSmokeViolations(rec);
  } catch (e) {
    console.error(`live-smoke FAIL — malformed Recommendation Object: ${e.message}`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(`live-smoke FAIL — ${violations.length} problem(s):`);
    for (const x of violations) console.error("  - " + x);
    process.exit(1);
  }
  console.log("live-smoke PASS — queries+fetches exercised and result is non-empty/honest.");
}

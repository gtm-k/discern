// Discern Phase 2 logic tests: independence clustering, R1 grid ranking, affiliate down-weighting.
// Runs via `npm test` (after schema validation). Exits non-zero on any failure.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterSources, distinctClusters, recurrenceByProduct, sourceWeight } from "./cluster.mjs";
import { gridWinner } from "./grid.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const failures = [];
let checks = 0;
const expect = (name, cond, detail) => { checks++; if (!cond) failures.push(`${name}: ${detail}`); };

// --- Independence clustering: syndicated listicles collapse to one signal ---------------------------
{
  const fx = load("evals/independence-cluster.json");
  const clustered = clusterSources(fx.sources);
  const clusters = distinctClusters(clustered);
  const rec = recurrenceByProduct(clustered);
  expect("independence-cluster: distinct_clusters", clusters === fx.expected.distinct_clusters,
    `expected ${fx.expected.distinct_clusters}, got ${clusters}`);
  expect("independence-cluster: recurrence_WidgetA", rec.WidgetA === fx.expected.recurrence_WidgetA,
    `expected ${fx.expected.recurrence_WidgetA}, got ${rec.WidgetA}`);
  // exactly one representative across the single cluster
  const reps = clustered.filter((s) => s.independence_flag).length;
  expect("independence-cluster: one representative", reps === clusters,
    `expected ${clusters} representative(s), got ${reps}`);
}

// --- R1 ranking: fundamentals outrank raw frequency ------------------------------------------------
{
  const fx = load("evals/ranking-invariant.json");
  const winner = gridWinner(fx.candidates);
  expect("ranking-invariant R1: winner", winner.product === fx.expected.winner,
    `expected ${fx.expected.winner}, got ${winner.product}`);
}

// --- Affiliate down-weighting (not zeroed) ---------------------------------------------------------
{
  const fx = load("evals/affiliate-downweight.json");
  const indep = fx.sources.find((s) => !s.affiliate_or_sponsored_flag);
  const aff = fx.sources.find((s) => s.affiliate_or_sponsored_flag);
  const wi = sourceWeight(indep), wa = sourceWeight(aff);
  expect("affiliate-downweight: independent > affiliate",
    (wi > wa) === fx.expected.independent_weight_gt_affiliate,
    `independent ${wi} vs affiliate ${wa}; expected independent_weight_gt_affiliate=${fx.expected.independent_weight_gt_affiliate}`);
  expect("affiliate-downweight: affiliate > 0",
    (wa > 0) === fx.expected.affiliate_weight_gt_zero,
    `affiliate weight ${wa}; expected affiliate_weight_gt_zero=${fx.expected.affiliate_weight_gt_zero}`);
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nLOGIC FAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} logic checks passed (clustering + R1 ranking + affiliate weighting).`);

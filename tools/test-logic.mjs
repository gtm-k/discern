// Discern Phase 2 logic tests: independence clustering, R1 grid ranking, affiliate down-weighting.
// Runs via `npm test` (after schema validation). Exits non-zero on any failure.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clusterSources, distinctClusters, recurrenceByProduct, sourceWeight } from "./cluster.mjs";
import { gridWinner } from "./grid.mjs";
import {
  choosePick,
  decideOutcome,
  confidenceViolations,
  claimConfidenceViolation,
  runBeneficiaryDecision,
} from "./decision.mjs";

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

// --- Phase 3: decision engine — R1 pick reproduces each golden's stated pick ------------------------
{
  const cases = [
    ["evals/golden/electronics-headphones.json", "Sony WH-1000XM5"],
    ["evals/golden/clothing-natural-materials.json", "Organic Cotton Oxford"],
    ["evals/golden/gift-recipient.json", "Handmade Ceramic Pour-over Set"],
  ];
  for (const [file, want] of cases) {
    const { pick } = choosePick(load(file));
    expect(`choosePick: ${file}`, pick && pick.product === want, `expected ${want}, got ${pick && pick.product}`);
  }
}

// --- Phase 3: outcome family is consistent with each golden's stated outcome ------------------------
{
  const familyOf = (o) => (o === "INSUFFICIENT_EVIDENCE" ? "INSUFFICIENT_EVIDENCE" : "RECOMMEND");
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient", "safety-supplement"]) {
    const rec = load(`evals/golden/${name}.json`);
    const d = decideOutcome(rec);
    expect(`decideOutcome family: ${name}`, d.family === familyOf(rec.outcome),
      `engine ${d.family} vs stated ${rec.outcome}`);
  }
  // Safety-relevant brand-proxy-only support must derive UNSAFE_BRAND_PROXY, never a guess.
  const safety = decideOutcome(load("evals/golden/safety-supplement.json"));
  expect("decideOutcome: safety -> UNSAFE_BRAND_PROXY", safety.reason_code === "UNSAFE_BRAND_PROXY",
    `got reason_code ${safety.reason_code}`);
}

// --- Phase 3: per-claim confidence calibration -----------------------------------------------------
{
  // Real golden fixtures must carry calibrated confidence on every claim (no violations).
  for (const name of ["electronics-headphones", "clothing-natural-materials", "gift-recipient", "safety-supplement"]) {
    const v = confidenceViolations(load(`evals/golden/${name}.json`));
    expect(`confidence calibrated: ${name}`, v.length === 0, `violations: ${v.join("; ")}`);
  }
  // The calibration check REJECTS miscalibrated / missing-value claims and ACCEPTS calibrated ones.
  const fx = load("evals/confidence-calibration.json");
  for (const c of fx.cases) {
    const v = claimConfidenceViolation(c.claim, { unresolved: c.unresolved });
    expect(`calibration: ${c.name}`, (v !== null) === c.expect_violation,
      `expected violation=${c.expect_violation}, got ${v === null ? "none" : v}`);
  }
}

// --- Phase 3: self-vs-gift switch (observable differences per definitions.md §5) --------------------
{
  const fx = load("evals/gift-vs-self.json");
  const profiles = { selfProfile: fx.self_profile, recipientProfile: fx.recipient_profile };
  const self = runBeneficiaryDecision(fx.candidates, profiles, "self");
  const recip = runBeneficiaryDecision(fx.candidates, profiles, "recipient");

  expect("gift-vs-self: self winner", self.winner === fx.expected.self.winner,
    `expected ${fx.expected.self.winner}, got ${self.winner}`);
  expect("gift-vs-self: recipient winner", recip.winner === fx.expected.recipient.winner,
    `expected ${fx.expected.recipient.winner}, got ${recip.winner}`);
  expect("gift-vs-self: self applies its own hard filter",
    self.disqualified.includes(fx.expected.self.disqualified[0]),
    `self disqualified=${JSON.stringify(self.disqualified)}`);
  expect("gift-vs-self: recipient applies its own hard filter",
    recip.disqualified.includes(fx.expected.recipient.disqualified[0]),
    `recipient disqualified=${JSON.stringify(recip.disqualified)}`);
  // The self-only hard filter (applies_to_gifts=false) must NOT transfer to the gift branch.
  expect("gift-vs-self: self-only filter does not transfer",
    !recip.disqualified.includes(fx.expected.self_only_filter_not_transferred),
    `recipient wrongly disqualified ${fx.expected.self_only_filter_not_transferred}`);
  // Returnability is weighted UP only in the gift branch (and here it flips the winner).
  expect("gift-vs-self: returnability weighted for recipient", recip.returnabilityApplied === true,
    `recipient returnabilityApplied=${recip.returnabilityApplied}`);
  expect("gift-vs-self: returnability NOT weighted for self", self.returnabilityApplied === false,
    `self returnabilityApplied=${self.returnabilityApplied}`);
}

// --- Phase 3: ties surface a judgment call; recalls demote the pick --------------------------------
{
  const fx = load("evals/decision-outcomes.json");
  for (const c of fx.cases) {
    const d = decideOutcome(c.rec);
    const p = choosePick(c.rec);
    if (c.expect.family !== undefined)
      expect(`decision ${c.name}: family`, d.family === c.expect.family, `expected ${c.expect.family}, got ${d.family}`);
    if (c.expect.tie !== undefined)
      expect(`decision ${c.name}: tie surfaced`, p.tie === c.expect.tie && d.tie === c.expect.tie,
        `expected tie=${c.expect.tie}, got pick.tie=${p.tie}, outcome.tie=${d.tie}`);
    if (c.expect.pick !== undefined)
      expect(`decision ${c.name}: pick`, p.pick && p.pick.product === c.expect.pick,
        `expected ${c.expect.pick}, got ${p.pick && p.pick.product}`);
    if (c.expect.pick_not !== undefined)
      expect(`decision ${c.name}: recall demotes pick`, !p.pick || p.pick.product !== c.expect.pick_not,
        `pick must not be ${c.expect.pick_not}, got ${p.pick && p.pick.product}`);
  }
}

// --- Report ----------------------------------------------------------------------------------------
if (failures.length) {
  console.error(`\nLOGIC FAIL — ${failures.length} problem(s) across ${checks} checks:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`OK — ${checks} logic checks passed (clustering + R1 ranking + affiliate weighting + decision engine + confidence calibration + gift switch).`);
